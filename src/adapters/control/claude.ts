import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONTENT_BYTES, type ContentKind, type ControlAttachment } from "../../contracts/content.js";
import type { BackendResult, CommandClass, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeModelCatalog, NativeOptions } from "../../contracts/control.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { ControlError } from "../../infrastructure/control/json-rpc-process.js";
import { AcpControl, refusedRun } from "./acp.js";
import { CLAUDE_EXPORT as EXPORT, claudeClassify, claudeListedEffect, claudeCommand as commandOf, claudeNativeClassify, claudeReadsSlash as readsSlash, relayDeclaration, relayEntries } from "./relay-classify.js";
import { type TurnText } from "../../contracts/control.js";
import { measureBy } from "./relay-turn.js";

/**
 * Claude Code's relay declaration (ADR-055 §8.1, Claude Code row): two text blocks; no live evidence, and a prompt that ended
 * or failed after insertion proves it recorded; commands as Claude Code reads them: a slash as the first character and a name
 * its catalog lists, while any other slash word is text (which differs from §8.1's `executed`: the probe
 * of 2026-11-10, F3, sent an unlisted word to the model) except `/clear`, `/reset`, `/new` and `/remote-control`, which the CLI
 * runs although the adapter lists none, the first three being the Hub's clear (the Hub runs it, the CLI never sees it);
 * compaction events; one process per connection; the window from its usage reports.
 *
 * No native title (G069 phase two, differs from §8.1's "set"): claude-agent-acp 0.99.1 routes `_session/rename` only for a
 * client that declares JetBrains AIR's session index (`clientCapabilities._meta.jetbrains.air` with `sessionIndex`,
 * session-index/connection.js:39-51) and answers any other client with method-not-found; the Hub does not pose as AIR.
 */
export const claudeRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "none", successProvesRecorded: true },
  execution: "process",
  // A slash word outside the catalog is text: "/zzprobe-unlisted hello" called the model and the transcript holds the text
  // (relay-conformance.md F3); only the hidden four run without being listed, and claudeReading reads it the same way (content).
  commands: { classify: claudeClassify },
  // Attachments go as ACP blocks after the two text blocks (G069 phase two, approval B8; to be probed).
  placement: { parts: "multiple", maxInput: null, measure: measureBy("multiple", "chars", ["file"]) },
  title: "none",
});
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
 * Inputs are read as Claude Code reads them (ADR-055 R0d): a slash as the first character and a command name the catalog lists
 * is a command, and so are `/clear`, `/reset`, `/new` and `/remote-control`, which Claude Code runs although its adapter does
 * not list them (the first three are the Hub's clear, which the Hub runs: the CLI's own clear starts a conversation that
 * claude-agent-acp does not adopt, so nothing is sent, the session is given up, and the next Turn opens a new one; its
 * transcript stays on disk and Claude Code can still resume it); any other slash word is words for the model (probe record
 * 2026-11-10, F3: an unlisted word called the model); whitespace or anything else before the slash makes the input words, since
 * the CLI strips nothing (F1: `" /context"` called the model); a slash path is content; with an image or a file attached every
 * input is content, since the CLI looks for a command only in the last block, which is then the attachment's (ADR-055, review
 * I6), while audio, which the adapter drops, leaves the input as it reads without attachments. The Hub's own `/export` is that
 * command alone. A content prompt that ended with end_turn, max_tokens or max_turn_requests, or failed with a model failure's
 * errorKind, was written to the transcript; a prompt refused because the session's stream had ended or the session is unknown
 * (R8 C4), and what this driver refuses or exports itself, never reached Claude (not recorded).
 */
export class ClaudeControl extends AcpControl {
  override readonly relayCapabilities: RelayCapabilities = claudeRelayCapabilities;
  private hubExport = false;
  protected override get product(): string { return "Claude Code"; }
  constructor(private readonly claudeLaunch: ControlLaunch, private readonly claudeOptions: ControlOptions) { super(claudeLaunch, claudeOptions); }
  /**
   * A session claude-agent-acp does not have, refused when the open resumes or loads it (0.99.1 `sessionNotFound`, ACP's
   * resource-not-found -32002, acp-agent.js:2491-2499; a session never prompted cannot be resumed by another process), is
   * NATIVE_SESSION_NOT_FOUND: the Runtime's fallback for an empty native session (ADR-055 C5, holdsNothing) reads exactly that
   * code (G072). Only that refusal of an open with a checkpoint is mapped, never a timeout, a failed connection or another
   * refusal; the refused open has failed the connection as every refused open does, so the Runtime opens anew on a new one.
   */
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    try { return await super.open(cwd, model, options, checkpoint); }
    catch (error) {
      if (checkpoint !== undefined && error instanceof ControlError && error.code === "REMOTE_ERROR" && error.remoteCode === SESSION_NOT_FOUND)
        throw new ControlError("NATIVE_SESSION_NOT_FOUND", "Claude Code has no session with this identity");
      throw error;
    }
  }
  /**
   * The commands a relay Turn's words are read against (relayParts): the agent's, and the Hub's own `/export` once models()
   * offered it (hubExport), which startText runs itself. A word outside the catalog is words for Claude Code (G074-F3), so
   * without the Hub's export here a relay Turn of `/export` would read as words and be run as the export, its packet dropped.
   */
  protected override get announced(): ReturnType<typeof relayEntries> | null {
    const agent = super.announced;
    return agent === null || !this.hubExport ? agent : [...agent, ...relayEntries([EXPORT])];
  }
  /**
   * Whether the agent's answer can prove this prompt recorded: it reads as content. Before the agent has announced any command
   * a slash word may be one it lists, and a command's answer proves nothing: as in the relay's reading (possible_command), it
   * is not taken for content until the catalog is known (G074-F3; a word outside a known catalog is words for Claude Code).
   */
  protected override readsAsContent(prompt: string, attachments: readonly ContentKind[]): boolean {
    if (this.announced === null && readsSlash(attachments) && commandOf(prompt) !== null) return false;
    return super.readsAsContent(prompt, attachments);
  }
  protected override promptRecorded(reason: string): boolean { return RECORDED_STOPS.has(reason); }
  protected override refusedPrompt(error: ControlError): "recorded" | "not_recorded" | null {
    if (error.remoteCode === SESSION_NOT_FOUND || error.remoteCode === -32603 && error.remoteMessage === SESSION_ENDED && error.remoteFields === undefined) return "not_recorded";
    return error.remoteCode === -32603 && MODEL_FAILURES.has(error.remoteFields?.errorKind ?? "") ? "recorded" : null;
  }
  // With an image or a file every input is content (startText sends it to Claude Code as it is), whatever the catalog lists.
  override classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return claudeNativeClassify(text, catalog, attachments); }
  protected override get sessionMeta(): Readonly<Record<string, unknown>> { return SESSION_META; }
  protected override extensionNotification(method: string, params: Readonly<Record<string, unknown>>): boolean {
    if (method !== AUTH_STATUS) return false;
    const status = params.authStatus, kind = typeof status === "object" && status !== null && "kind" in status ? status.kind : undefined;
    // Only the kind is read: the label, detail and account name the user and are never kept.
    this.setAuthentication(typeof kind === "string" && SIGNED_IN.has(kind) ? "ready" : "unknown");
    return true;
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models(), commands = (catalog.commands ?? []).filter(command => command.name !== REMOTE_CONTROL);
    this.hubExport = !commands.some(command => command.name === EXPORT.name);
    return { ...catalog, commands: (this.hubExport ? [...commands, EXPORT] : commands).map(command => ({ ...command, contextEffect: command.contextEffect ?? claudeListedEffect(command.name) ?? "keep" })) };
  }
  override async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // A relay Turn whose words read as a command is refused before anything below runs (the clear and the export included).
    const refusal = this.relayRefused(turn, attachments.map(file => file.kind));
    if (refusal !== null) return refusal;
    // The same reading as classify() (claudeCommand, the one parse): the command name and arguments of the user's words when the
    // slash is their first character, and none with an image or a file: the input is then sent as it is, since the CLI looks for
    // a command only in the last block (CLI 2.1.312 `Aj`), an attachment's. Audio alone is dropped by the adapter, so `/clear`
    // with it is the clear (readsSlash).
    const named = readsSlash(attachments.map(file => file.kind)) ? commandOf(typeof turn === "string" ? turn : turn.user) : null;
    if (named?.name === REMOTE_CONTROL) return refusedRun(REMOTE_CONTROL_REFUSED);
    if (this.hubExport && named?.name === EXPORT.name && named.args === "") {
      return { result: this.exportTranscript(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    // `/clear`, `/reset` and `/new` are the Hub's clear: the base driver gives the session up and sends nothing (clearRun).
    return super.startText(id, turn, onEvent, attachments);
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
      if (info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "the Claude Code transcript is empty or exceeds 1 GiB");
      onEvent({ type: "output", output: { kind: "content", name: "claude-" + id + ".jsonl", mediaType: "application/x-ndjson", data: await readFile(found) } });
      // The export reads Claude Code's record; nothing reaches Claude.
      return { status: "completed", reason: "exported", input: "not_recorded" };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "NATIVE_EXPORT_UNAVAILABLE";
      return { status: "failed", reason: "export_failed", error: { code, message: error instanceof ControlError ? error.message : "the Claude Code transcript could not be read" }, input: "not_recorded" };
    }
  }
}
