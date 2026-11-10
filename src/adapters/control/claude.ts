import { open, readdir, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONTENT_BYTES, type ContentKind, type ControlAttachment } from "../../contracts/content.js";
import type { BackendResult, CommandClass, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeModelCatalog, VerifyRequest } from "../../contracts/control.js";
import { RELAY_POSITION_BYTES, type DeliveryPosition, type MarkerResult, type RelayCapabilities, type VerifyResult } from "../../contracts/relay.js";
import { ControlError } from "../../infrastructure/control/json-rpc-process.js";
import { AcpControl, refusedRun } from "./acp.js";
import { CLAUDE_EXPORT as EXPORT, CLAUDE_HIDDEN as HIDDEN, claudeClassify, claudeListedEffect, claudeCommand as commandOf, claudeNativeClassify, claudeReadsSlash as readsSlash, relayDeclaration, relayEntries } from "./relay-classify.js";
import { claudeVendor, slashModelKey } from "./relay-vendor.js";
import { type TurnText } from "../../contracts/control.js";
import { authKind, entryCarries, packetEntry, strip, VERIFY_BUDGET_MS, verifyResult, type UserText } from "./relay-turn.js";

/**
 * Claude Code's relay declaration (ADR-055 §8.1, Claude Code row): two text blocks; no live evidence, a check after the
 * turn, and a prompt that ended or failed after insertion proves it recorded; commands as Claude Code reads them, with
 * `/clear`, `/reset`, `/new` and `/remote-control` run although unlisted; compaction events; one process per connection;
 * the vendor by the endpoint its settings resolve; the window from its usage reports. Not probed (P2, P3, P6, P11 have not
 * run on the latest release).
 *
 * No native title (G069 phase two, differs from §8.1's "set"): claude-agent-acp 0.99.1 routes `_session/rename` only for a
 * client that declares JetBrains AIR's session index (`clientCapabilities._meta.jetbrains.air` with `sessionIndex`,
 * session-index/connection.js:39-51) and answers any other client with method-not-found; the Hub does not pose as AIR.
 */
export const claudeRelayCapabilities: RelayCapabilities = relayDeclaration({
  probed: false,
  delivery: { live: "none", verify: "after_turn", successProvesRecorded: true, lateDelivery: false },
  execution: "process",
  commands: { unlistedSlash: "executed", hidden: relayEntries(HIDDEN), classify: claudeClassify },
  // Attachments go as ACP blocks after the two text blocks (G069 phase two, approval B8; to be probed).
  placement: { parts: "multiple", maxInput: null, pointersAfterUser: true },
  window: "session_report",
  fixedPrefix: null,
  cacheTtl: "auth_dependent",
  compactionEvidence: "event",
  resolveVendor: claudeVendor,
  normalizeModel: slashModelKey,
  title: "none",
  hostPathRead: "none",
  sessionTools: null,
});
/** Project directories searched for a transcript, as claude-agent-acp itself searches them. */
const MAX_PROJECT_DIRECTORIES = 4096;
/** A session identity that names a transcript file (`<id>.jsonl`). */
const SESSION_FILE = /^[A-Za-z0-9-]{1,128}$/u;
/**
 * A project directory's name as Claude Code writes one (claude-agent-acp session-index/project-dirs.js encodeProjectPath: every
 * character but ASCII letters and digits as `-`, a long name cut and followed by `-` and a base-36 hash): never `.` or `..`.
 */
const PROJECT_DIRECTORY = /^[A-Za-z0-9-]{1,255}$/u;
/** How much of a transcript after a delivery position a check reads; the entry it looks for is written first. */
const TRANSCRIPT_READ_BYTES = 16 * 1024 * 1024;
/** The CLI flushes its transcript queue every 100 ms (FLUSH_INTERVAL_MS); a check that finds no entry reads once more after this. */
const TRANSCRIPT_FLUSH_MS = 300;
/** The commands Claude Code runs to start a new conversation (its `clear`, aliases reset and new). */
const CLEARS: ReadonlySet<string> = new Set(HIDDEN.filter(command => command.contextEffect === "clear").map(command => command.name));
/**
 * Claude Code's project directory name for a workspace (claude-agent-acp 0.99.1 session-index/project-dirs.js:29-46, the
 * CLI's own rule): the realpath, NFC, every UTF-16 unit but ASCII letters and digits as `-` (its `sanitize` has no `u` flag,
 * so a character outside the BMP is two). A longer name than 200 units ends in a hash the CLI and the SDK compute
 * differently, so it is not computed here (null) and the directories are searched instead.
 */
function projectName(path: string): string | null {
  // Deliberately without the `u` flag, as the adapter's own pattern (the second review's minor 3).
  const name = path.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= 200 ? name : null;
}
/** One transcript line as far as a check reads it. */
type Line = Readonly<Record<string, unknown>>;
function texts(content: unknown): readonly string[] {
  if (typeof content === "string") return [content];
  return Array.isArray(content) ? content.flatMap(part => part !== null && typeof part === "object" && (part as Line).type === "text" && typeof (part as Line).text === "string" ? [(part as Line).text as string] : []) : [];
}
/**
 * A user prompt the client sent, as the CLI writes it (CLI 2.1.312, `Ie({content,isMeta,…})` with the envelope fields):
 * `type: "user"`, neither meta, a compaction summary nor a sidechain's, and no tool result in it.
 */
function clientEntry(line: Line): boolean {
  if (line.type !== "user" || line.isMeta === true || line.isCompactSummary === true || line.isSidechain === true || line.toolUseResult !== undefined) return false;
  const message = line.message !== null && typeof line.message === "object" ? line.message as Line : {}, content = message.content;
  return !(Array.isArray(content) && content.some(part => part !== null && typeof part === "object" && (part as Line).type === "tool_result"));
}
/** A compaction in the transcript: the CLI's `compact_boundary` system line, or the summary entry it writes after one. */
function compactionLine(line: Line): boolean { return line.type === "system" && line.subtype === "compact_boundary" || line.type === "user" && line.isCompactSummary === true; }
/**
 * A transcript's lines after a delivery position, read only: null when the file cannot be read, is shorter than the position,
 * was rewritten so that the position is no line boundary (the CLI removes tombstoned lines by rewriting what follows them),
 * or holds a line of another session. `complete` is false when more follows than a check reads, or the last line is still
 * being written. Lines that are not JSON objects are skipped.
 */
async function readTranscript(path: string, offset: number, session: string): Promise<{ readonly lines: readonly Line[]; readonly complete: boolean } | null> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < offset) return null;
    if (offset > 0) { const before = Buffer.alloc(1); await handle.read(before, 0, 1, offset - 1); if (before[0] !== 0x0a) return null; }
    const length = Math.min(info.size - offset, TRANSCRIPT_READ_BYTES), buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) { const { bytesRead } = await handle.read(buffer, done, length - done, offset + done); if (bytesRead === 0) break; done += bytesRead; }
    const text = buffer.subarray(0, done).toString("utf8"), last = text.lastIndexOf("\n");
    const lines: Line[] = [];
    for (const raw of (last < 0 ? "" : text.slice(0, last)).split("\n")) {
      if (!raw.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { continue; }
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const line = value as Line;
      if (typeof line.sessionId === "string" && line.sessionId !== session) return null;
      lines.push(line);
    }
    return { lines, complete: info.size - offset <= TRANSCRIPT_READ_BYTES && text.slice(last + 1).trim() === "" };
  } catch { return null; } finally { await handle.close(); }
}
/** Tags Claude Code injects into a user's prompt row (claude-agent-acp acp-agent.js:748-761, 817-843). */
const INJECTED = /<(system-reminder|task-notification)>[\s\S]*?<\/\1>\n?/gu;
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
 * Inputs are read as Claude Code reads them (ADR-055 R0d): after leading whitespace, a slash and a command name is a
 * command, listed or not, since Claude Code runs commands its adapter does not list (`/clear`, `/reset` and `/new` clear the
 * native conversation); a slash path is content; with an image or a file attached every input is content, since the CLI
 * looks for a command only in the last block, which is then the attachment's (ADR-055, review I6), while audio, which the
 * adapter drops, leaves the input as it reads without attachments. The Hub's own `/export` is that command alone. A
 * content prompt that ended with end_turn, max_tokens or max_turn_requests, or failed with a model failure's errorKind, was
 * written to the transcript; a prompt refused because the session's stream had ended or the session is unknown (R8 C4),
 * and what this driver refuses or exports itself, never reached Claude (not recorded).
 */
export class ClaudeControl extends AcpControl {
  override readonly relayCapabilities: RelayCapabilities = claudeRelayCapabilities;
  private hubExport = false;
  /** The kind of the sign-in the agent last reported (`_auth/status_update`), only the kind. */
  private signedIn: string | null = null;
  /** The open conversation's transcript, once found or computed: the path, its project directory and the session it belongs to. */
  private transcript: { readonly id: NativeConversationId; readonly path: string; readonly project: string } | null = null;
  constructor(private readonly claudeLaunch: ControlLaunch, private readonly claudeOptions: ControlOptions) { super(claudeLaunch, claudeOptions); }
  protected override get vendorHarness(): "claude" { return "claude"; }
  protected override vendorAuthKind(): string | null { return this.signedIn; }
  /** Claude Code's configuration directory for this process: CLAUDE_CONFIG_DIR, else `~/.claude` (claude-agent-acp paths.js). */
  private get configDir(): string { const env = { ...this.claudeOptions.env, ...this.claudeLaunch.env }; return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"); }
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
    this.setAuthentication(typeof kind === "string" && SIGNED_IN.has(kind) ? "ready" : "unknown");
    // Only the kind is kept, for the vendor key (§8.1): the label, detail and account name the user and are never read.
    this.signedIn = authKind(kind);
    return true;
  }
  /**
   * The transcript of this session (§8.1: the position is its length before the prompt): the path found before, the one the
   * workspace's project directory names, else the first project directory that holds `<id>.jsonl`, as claude-agent-acp itself
   * looks it up (resumed-session.js findTranscript). A session the CLI has not written yet has its computed path and size 0;
   * null when no path can be told. `stored` is the path relative to the configuration directory's `projects/`, which a
   * position keeps (transcriptFile reads it back only there). Rejects on a file system error other than a missing file.
   */
  private async locateTranscript(id: NativeConversationId): Promise<{ readonly path: string; readonly stored: string; readonly size: number } | null> {
    if (!SESSION_FILE.test(id)) return null;
    const projects = join(this.configDir, "projects"), cwd = this.opened?.cwd, file = id + ".jsonl";
    const named = cwd === undefined ? null : projectName(await realpath(cwd).catch(() => cwd));
    const sized = async (path: string): Promise<number | null> => {
      try { const info = await stat(path); return info.isFile() ? info.size : null; }
      catch (error) { if (error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null; throw error; }
    };
    const found = (project: string, size: number) => { const path = join(projects, project, file); this.transcript = { id, path, project }; return { path, stored: project + "/" + file, size }; };
    for (const project of [this.transcript?.id === id ? this.transcript.project : null, named]) {
      if (project === null) continue;
      const size = await sized(join(projects, project, file));
      if (size !== null) return found(project, size);
    }
    let entries: readonly { readonly name: string; isDirectory(): boolean }[] = [];
    try { entries = (await readdir(projects, { withFileTypes: true })).slice(0, MAX_PROJECT_DIRECTORIES); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_DIRECTORY.test(entry.name)) continue;
      const size = await sized(join(projects, entry.name, file));
      if (size !== null) return found(entry.name, size);
    }
    return named === null ? null : { path: join(projects, named, file), stored: named + "/" + file, size: 0 };
  }
  /**
   * A position's transcript as a file under this configuration directory's `projects/`: the stored `<project>/<id>.jsonl` of
   * this session, one directory deep, nothing that leaves `projects/`; null for any other path (an absolute one included).
   */
  private transcriptFile(stored: string, id: NativeConversationId): string | null {
    const parts = stored.split("/");
    return parts.length === 2 && PROJECT_DIRECTORY.test(parts[0]!) && parts[1] === id + ".jsonl" ? join(this.configDir, "projects", parts[0]!, parts[1]) : null;
  }
  /**
   * Where this session's transcript stands before a Turn's input (ADR-055 §8.1, F20): its byte length, read without
   * changing it, and its path relative to the configuration directory's `projects/`; `none` when no transcript path can be
   * told (a workspace whose project directory name the CLI hashes, before the CLI wrote the session) or the file system
   * cannot tell its size.
   */
  async deliveryPosition(id: NativeConversationId): Promise<DeliveryPosition> {
    this.assertOwned(id);
    const found = await this.locateTranscript(id).catch(() => null);
    if (found === null) return { kind: "none" };
    const position = { kind: "file_offset", path: found.stored, bytes: found.size } as const;
    return Buffer.byteLength(JSON.stringify(position)) > RELAY_POSITION_BYTES ? { kind: "none" } : position;
  }
  /**
   * Looks for each packet in the user prompts the client sent after its position in this session's transcript (ADR-055 §7.1
   * E2, §8.1): the first of them with its title line, a later one only with its title and end lines (packetEntry); present
   * when one does, compacted when a compaction followed that entry, absent when the transcript after the position was read to
   * its end and none does. unavailable when no client prompt follows the position at all (the Turn was written elsewhere:
   * the adapter can replace its private session, a plan approved with a fresh context among them), when the transcript cannot
   * be read, is not this session's (`<id>.jsonl` under this configuration directory, the sessionId of its lines), was
   * rewritten before the position (shorter, or the position is no line boundary any more), is longer after it than a check
   * reads, or the check ran out of its time. An entry not found is looked for once more after the CLI's flush interval.
   * historyEmpty and the compaction cursor are not given: only the part after the positions is read, and Claude Code's
   * compactions are told by the Turn's events.
   */
  async verifyDelivered(id: NativeConversationId, request: VerifyRequest): Promise<VerifyResult> {
    const started = Date.now();
    this.assertOwned(id);
    let checked = await this.checkTranscript(id, request, started);
    if (checked.again && Date.now() - started + TRANSCRIPT_FLUSH_MS < VERIFY_BUDGET_MS) { await new Promise(resolve => setTimeout(resolve, TRANSCRIPT_FLUSH_MS)); checked = await this.checkTranscript(id, request, started); }
    return verifyResult(request, checked.results, started, { foreignAfterLast: checked.foreign });
  }
  /** One reading of the transcript for a check; `again` when an entry may still be in the CLI's write queue (absent, or no file yet). */
  private async checkTranscript(id: NativeConversationId, request: VerifyRequest, started: number): Promise<{ readonly results: readonly MarkerResult[]; readonly foreign: number | null; readonly again: boolean }> {
    const read = new Map<string, Awaited<ReturnType<typeof readTranscript>>>();
    const results: MarkerResult[] = [];
    let foreign: number | null = null, again = false;
    for (const [index, marker] of request.markers.entries()) {
      const position = marker.position;
      let path = position.kind === "file_offset" ? this.transcriptFile(position.path, id) : null;
      if (path === null || position.kind !== "file_offset" || Date.now() - started >= VERIFY_BUDGET_MS) { results.push("unavailable"); continue; }
      // A session the CLI had not written at delivery may have been written where the adapter, not the computation, found it.
      if (position.bytes === 0) { const found = await this.locateTranscript(id).catch(() => null); if (found !== null && found.size > 0) path = found.path; }
      const key = path + "\0" + position.bytes;
      if (!read.has(key)) read.set(key, await readTranscript(path, position.bytes, id));
      const tail = read.get(key)!;
      if (tail === null) { again ||= position.bytes === 0; results.push("unavailable"); continue; }
      const clients = tail.lines.flatMap((line, at) => clientEntry(line) ? [{ at, texts: texts((line.message as Line | undefined)?.content) }] : []);
      // Nothing the client wrote follows the position: this Turn's prompt is not in this file, which says nothing of the history.
      if (!clients.length) { again = true; results.push("unavailable"); continue; }
      const entry = packetEntry(clients, (client, whole) => client.texts.some(text => entryCarries(text, marker.packetId, whole)));
      if (entry < 0) { again = true; results.push(tail.complete ? "absent" : "unavailable"); continue; }
      results.push(tail.lines.slice(clients[entry]!.at + 1).some(compactionLine) ? "compacted" : "present");
      if (index === request.markers.length - 1 && tail.complete) foreign = clients.length - entry - 1;
    }
    return { results, foreign, again };
  }
  /** Tags Claude Code injects into a prompt row (system reminders, task notifications) are harness text, not the user's words. */
  protected override nativeWrapping(replayed: string): UserText {
    let stripped: UserText["stripped"] = [];
    const user = replayed.replace(INJECTED, tag => { stripped = strip(stripped, "harness_text", tag); return ""; });
    return { user, stripped };
  }
  /**
   * Claude Code's `/clear` (and `/reset`, `/new`) as §8.1 has the Driver do it: the CLI's own clear starts a new conversation
   * that claude-agent-acp does not adopt (the next Turn resumes the old one by its ACP identity, acp-agent.js:6224-6246), so
   * nothing is sent. The driver gives up this session instead (abandonConversation: closed when the adapter declares
   * session/close; its transcript stays on disk, and Claude Code can still resume it) and reports the history cleared with no
   * checkpoint: the next Turn opens a new native session. None is opened ahead, since a session never prompted cannot be
   * resumed by another process (claude-agent-acp 0.99.1 answers sessionNotFound, acp-agent.js:2491-2499, 8774-8779,
   * 9255-9262). The command never reached Claude (not recorded).
   */
  private async syntheticClear(onEvent: (event: ControlEvent) => void): Promise<BackendResult> {
    await this.abandonConversation();
    this.transcript = null;
    onEvent({ type: "diagnostic", message: "HarnessHub 代为执行了 /clear：这条命令没有发给 Claude Code，原来的会话已放下（仍可在 Claude Code 里用 --resume 打开），下一条消息会在新会话里开始。" });
    return { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true, replaced: { checkpoint: null } } };
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models(), commands = (catalog.commands ?? []).filter(command => command.name !== REMOTE_CONTROL);
    this.hubExport = !commands.some(command => command.name === EXPORT.name);
    return { ...catalog, commands: (this.hubExport ? [...commands, EXPORT] : commands).map(command => ({ ...command, contextEffect: command.contextEffect ?? claudeListedEffect(command.name) ?? "keep" })), hiddenCommands: HIDDEN };
  }
  override async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // A relay Turn whose words read as a command is refused before anything below runs (the clear and the export included).
    const refusal = this.relayRefused(turn, attachments.map(file => file.kind));
    if (refusal !== null) return refusal;
    // The same reading as classify(): the command name and arguments of the user's words after leading whitespace, and none
    // with an image or a file: the input is then sent as it is, since the CLI looks for a command only in the last block (CLI
    // 2.1.312 `Aj`), an attachment's. Audio alone is dropped by the adapter, so `/clear` with it is the clear (readsSlash).
    const named = readsSlash(attachments.map(file => file.kind)) ? commandOf(typeof turn === "string" ? turn : turn.user) : null;
    if (named?.name === REMOTE_CONTROL) return refusedRun(REMOTE_CONTROL_REFUSED);
    if (this.hubExport && named?.name === EXPORT.name && named.args === "") {
      return { result: this.exportTranscript(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    if (named !== null && CLEARS.has(named.name)) {
      this.assertOwned(id);
      if (this.promptActive) throw new ControlError("INVALID_STATE", "a prompt is already active");
      return { result: this.syntheticClear(onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a clear the driver runs itself has no native turn to stop")) };
    }
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
