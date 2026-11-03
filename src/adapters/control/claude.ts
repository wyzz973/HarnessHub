import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONTENT_BYTES, type ContentKind, type ControlAttachment } from "../../contracts/content.js";
import type { BackendResult, CommandClass, ContextEffect, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeCommand, NativeConversationId, NativeModelCatalog } from "../../contracts/control.js";
import { ControlError } from "../../infrastructure/control/json-rpc-process.js";
import { AcpControl } from "./acp.js";

const EXPORT = { name: "export", description: "导出原生会话记录（Claude Code 转录 JSONL）", contextEffect: "none" } as const;
/** A command name as Claude Code reads one after a leading slash (its CLI strings); a path such as `/Users/…` names none. */
const COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/u;
/**
 * Commands Claude Code runs although claude-agent-acp does not list them (ADR-055 R0d): `/clear` and its aliases start a
 * new native conversation, and the adapter's `/remote-control`, which this driver refuses, changes nothing.
 */
const HIDDEN: readonly NativeCommand[] = [
  ...["clear", "reset", "new"].map(name => ({ name, description: "清空 Claude Code 的会话上下文", contextEffect: "clear" as const })),
  { name: "remote-control", description: "Claude Code 的 Remote Control（HarnessHub 不发送）", contextEffect: "none" },
];
/** Listed commands that are no prompt: compaction, and the CLI's local reports, which leave the context as it is; any other listed command (a skill, a custom command) enters it like a message. */
const LISTED_EFFECTS: Readonly<Record<string, ContextEffect>> = { compact: "compact", model: "none", status: "none", usage: "none", context: "none", mcp: "none", cost: "none", export: "none" };
/** Project directories searched for a transcript, as claude-agent-acp itself searches them. */
const MAX_PROJECT_DIRECTORIES = 4096;
/** claude-agent-acp's connection-level report of the sign-in it uses (auth-status.js, the same report in 0.89.1 and 0.94.0). */
const AUTH_STATUS = "_auth/status_update";
/**
 * The report kinds that name an identity the agent uses: a claude.ai subscription, an API key, an external cloud backend
 * or a model gateway.
 */
const SIGNED_IN: ReadonlySet<string> = new Set(["account", "api_key", "external", "gateway"]);
/** claude-agent-acp's per-session options in `_meta.claudeCode.options` (0.92.0 and later): prompt suggestions off. */
const SESSION_META: Readonly<Record<string, unknown>> = { claudeCode: { options: { promptSuggestions: false } } };
/** The adapter's own `/remote-control` (0.93.0 and later), which the Hub neither lists nor sends. */
const REMOTE_CONTROL = "remote-control";
const REMOTE_CONTROL_REFUSED: BackendResult = { status: "failed", reason: "command_unavailable", error: { code: "NATIVE_COMMAND_UNAVAILABLE",
  message: "/remote-control 没有发给 Claude：HarnessHub 默认在每个回合结束时关闭 Claude 的适配器进程，Remote Control 会随之断开；保持原生进程时，从 claude.ai 发来的回合也不属于这段对话。" }, input: "not_recorded" };
/** Stop reasons claude-agent-acp gives only once Claude Code wrote the prompt to its transcript, which it does before calling the model. */
const RECORDED_STOPS: ReadonlySet<string> = new Set(["end_turn", "max_tokens", "max_turn_requests"]);
/**
 * claude-agent-acp's `errorKind` for a turn whose model call failed (0.99.1 `errorKindData(lastAssistantError)`, the Agent
 * SDK's SDKAssistantMessageError): the prompt was in the transcript before that call. authentication_failed and
 * oauth_org_not_allowed never arrive so: the adapter fails those turns, and the CLI's "run /login" replies, with a bare
 * auth_required (-32000, no data), which it also sends before a turn starts (its `--hide-claude-auth` guard), so that one
 * stays unknown. The adapter's own kinds (transport_lost, worker_shutdown, no_result, incomplete_tool_call) can come before
 * the model call, and are not among them either.
 */
const MODEL_FAILURES: ReadonlySet<string> = new Set(["account_on_hold", "verification_required", "billing_error", "rate_limit", "overloaded", "invalid_request",
  "model_not_found", "server_error", "unknown", "max_output_tokens", "cloud_credential_error"]);
/**
 * claude-agent-acp 0.99.1 refuses a prompt with this before enqueueing it, when the session's query stream has ended (and
 * fails each queued prompt the stream never started with it): `RequestError.internalError(undefined, SESSION_ENDED_MESSAGE)`.
 */
const SESSION_ENDED = "Internal error: The Claude Agent session has ended. Please start a new session.";
/** ACP's resource-not-found code, with which claude-agent-acp refuses a prompt for a session it does not have (`sessionNotFound`). */
const SESSION_NOT_FOUND = -32002;
/** The command an input names as Claude Code reads one: after leading whitespace, a slash and a command name; null for content. */
function commandOf(text: string): { readonly name: string; readonly args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).split(/\s/u)[0]!;
  return COMMAND_NAME.test(name) ? { name, args: trimmed.slice(1 + name.length).trim() } : null;
}

/**
 * Claude Code over claude-agent-acp, with the latest adapter (0.94.0, with CLI 2.1.307) as the baseline; 0.89.1 (with CLI
 * 2.1.302–2.1.306) is where the sign-in mapping below was first read.
 *
 * Claude Code keeps each session's transcript in its configuration directory (`projects/<project>/<session>.jsonl`), where
 * claude-agent-acp itself looks it up; ACP has no export method. When the agent lists no `export` command of its own, the
 * Hub offers `/export`, which copies that transcript read-only as an output of the Run. Nothing is sent to the model.
 *
 * claude-agent-acp also pushes its sign-in on `_auth/status_update` ({authStatus: {kind, label, …}}). The client never
 * requests it. The agent pushes it after initialize, at each session creation and when each prompt starts, but only when it
 * has changed. The report becomes the catalog's readiness (ADR-033): a kind that names an identity is "ready", and any other
 * kind is "unknown". Only the kind is read: the label, detail and account name the user and are never kept, logged or shown.
 * "none" is unknown and not "missing", so no session is refused because of it. In 0.94.0, as in 0.89.1, `fromCliStatus` maps
 * `claude auth status --json` through `mapAuthFields`, with the same kinds. That output, whose structure CLI 2.1.307 keeps,
 * has `loggedIn: true` for a token login (ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN), but `apiKeySource` is set only for a
 * key and `subscriptionType` only for a claude.ai login. With neither field present, the mapping falls through to "none" for
 * a CLI that works. A CLI that is really signed out still fails its first prompt: claude-agent-acp turns the "Please run
 * /login" reply into ACP auth_required, which is reported as NATIVE_AUTH_REQUIRED.
 *
 * Every session request turns the adapter's prompt suggestions off (`_meta.claudeCode.options.promptSuggestions`): from
 * 0.92.0 the adapter asks the model for a predicted next prompt after each turn and shows it only to JetBrains AIR, so each
 * Hub turn would cost one more model request. The user's own promptSuggestionEnabled setting is untouched (ADR-053).
 *
 * The adapter's `/remote-control` is neither listed nor sent, and a prompt that runs it fails with NATIVE_COMMAND_UNAVAILABLE:
 * the Hub closes the adapter process when a Turn ends, which disconnects Remote Control, and turns sent from claude.ai while
 * a process is kept belong to no Run here (ADR-053).
 *
 * Inputs are read as Claude Code reads them (ADR-055 R0d): after leading whitespace, a slash and a command name is a
 * command, listed or not, since Claude Code runs commands its adapter does not list (`/clear`, `/reset` and `/new` clear the
 * native conversation); a slash path is content. The Hub's own `/export` is that command alone, without attachments. A
 * content prompt that ended with end_turn, max_tokens or max_turn_requests, or failed with a model failure's errorKind, was
 * written to the transcript; a prompt refused because the session's stream had ended or the session is unknown (R8 C4),
 * and what this driver refuses or exports itself, never reached Claude (not recorded).
 */
export class ClaudeControl extends AcpControl {
  private hubExport = false;
  constructor(private readonly claudeLaunch: ControlLaunch, options: ControlOptions) { super(claudeLaunch, options); }
  protected override promptRecorded(reason: string): boolean { return RECORDED_STOPS.has(reason); }
  protected override refusedPrompt(error: ControlError): "recorded" | "not_recorded" | null {
    if (error.remoteCode === SESSION_NOT_FOUND || error.remoteCode === -32603 && error.remoteMessage === SESSION_ENDED && error.remoteFields === undefined) return "not_recorded";
    return error.remoteCode === -32603 && MODEL_FAILURES.has(error.remoteFields?.errorKind ?? "") ? "recorded" : null;
  }
  override classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass {
    const named = commandOf(text);
    if (named === null) return { kind: "content" };
    const { name, args } = named, hidden = HIDDEN.find(command => command.name === name);
    if (hidden !== undefined) return { kind: "command", name, args, effect: hidden.contextEffect ?? "unknown" };
    if (catalog === null) return { kind: "possible_command", name };
    // With attachments `/export` is not the Hub's export (startText sends it to Claude Code), whatever the catalog lists.
    const listed = attachments.length && this.hubExport && name === EXPORT.name ? undefined : catalog.commands?.find(command => command.name === name);
    return { kind: "command", name, args, effect: listed === undefined ? "unknown" : listed.contextEffect ?? LISTED_EFFECTS[name] ?? "keep" };
  }
  protected override get sessionMeta(): Readonly<Record<string, unknown>> { return SESSION_META; }
  protected override extensionNotification(method: string, params: Readonly<Record<string, unknown>>): boolean {
    if (method !== AUTH_STATUS) return false;
    const status = params.authStatus, kind = typeof status === "object" && status !== null && "kind" in status ? status.kind : undefined;
    this.setAuthentication(typeof kind === "string" && SIGNED_IN.has(kind) ? "ready" : "unknown");
    return true;
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models(), commands = (catalog.commands ?? []).filter(command => command.name !== REMOTE_CONTROL);
    this.hubExport = !commands.some(command => command.name === EXPORT.name);
    return { ...catalog, commands: (this.hubExport ? [...commands, EXPORT] : commands).map(command => ({ ...command, contextEffect: command.contextEffect ?? LISTED_EFFECTS[command.name] ?? "keep" })), hiddenCommands: HIDDEN };
  }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // The same reading as classify(): the command name and arguments after leading whitespace.
    const named = commandOf(prompt);
    if (named?.name === REMOTE_CONTROL) return { result: Promise.resolve(REMOTE_CONTROL_REFUSED), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a refused command has no native turn to stop")) };
    if (this.hubExport && !attachments.length && named?.name === EXPORT.name && named.args === "") {
      return { result: this.exportTranscript(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    return super.startText(id, prompt, onEvent, attachments);
  }
  private async exportTranscript(id: NativeConversationId, onEvent: (event: ControlEvent) => void): Promise<BackendResult> {
    try {
      if (!/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "this Claude session has no transcript name");
      const env = this.claudeLaunch.env, projects = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "projects");
      let found: string | null = null;
      for (const entry of (await readdir(projects, { withFileTypes: true })).slice(0, MAX_PROJECT_DIRECTORIES)) {
        if (!entry.isDirectory()) continue;
        const candidate = join(projects, entry.name, id + ".jsonl");
        try { if ((await stat(candidate)).isFile()) { found = candidate; break; } }
        catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      }
      if (found === null) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "Claude Code has no transcript for this session");
      const info = await stat(found);
      if (info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "the Claude Code transcript is empty or exceeds 20 MiB");
      onEvent({ type: "output", output: { kind: "content", name: "claude-" + id + ".jsonl", mediaType: "application/x-ndjson", data: await readFile(found) } });
      // The export reads Claude Code's record; nothing reaches Claude.
      return { status: "completed", reason: "exported", input: "not_recorded" };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "NATIVE_EXPORT_UNAVAILABLE";
      return { status: "failed", reason: "export_failed", error: { code, message: error instanceof ControlError ? error.message : "the Claude Code transcript could not be read" }, input: "not_recorded" };
    }
  }
}
