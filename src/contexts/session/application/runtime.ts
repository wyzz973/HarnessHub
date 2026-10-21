import { parseProviderTarget } from "../../../contracts/provider.js";
import { TOOL_DIFF_BYTES, TOOL_INPUT_BYTES, TOOL_OUTPUT_BYTES, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlRun, type NativeConversationId, type NativeToolDetail, type NativeUsage } from "../../../contracts/control.js";
import { MAX_RUN_ATTACHMENTS, MAX_RUN_OUTPUTS, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId, DEFAULT_EXECUTION_BUDGET_MS, DEFAULT_WAIT_BUDGET_MS, MAX_PARALLEL_CONVERSATIONS, STOP_GRACE_MS, STREAM_WINDOW_BYTES, STREAM_WINDOW_MS,
  type AttentionItem, type ForkedMessage, type HarnessSelection, type KeptProcessIdentity, type OutsideEvidence, type OutsideProcess, type NativeConfiguration, type NativeSessionBinding, type PermissionRequest, type CancelReceipt, type CommandId, type EventDraft, type PreparedSessionBinding, type PublicNotice, type PublicRun, type RunTiming,
  type SelectionRequest, type SendReceipt, type SessionBindingFactory, type SessionCommit, type SessionConfiguration,
  type SessionId, type SessionEvent, type SessionMutation, type SessionRuntimeOptions, type SessionSnapshot, type SessionStore, type SwitchReceipt,
} from "../../../contracts/session.js";
import { buildPublicContext } from "../domain/context.js";
import { MAX_COMMANDS, MAX_OUTPUT_BYTES, MAX_PLAN_ENTRIES, MAX_QUEUE, MAX_RUNS, MAX_RUN_ACTIVITIES, MAX_RUN_NOTICES, MAX_RUN_TOOLS, assertInput, carriedNativeConfiguration, parseConfiguration, parseNativeConfiguration, replayCommand, terminal, utf8Bytes } from "../domain/state.js";

interface ActiveExecution {
  readonly sessionId: SessionId;
  readonly runId: string;
  binding: PreparedSessionBinding | null;
  run: ControlRun | null;
  dispatched: boolean;
  backendSettled: boolean;
  stop: Promise<void> | null;
  earlyClose: Promise<CleanupEvidence> | null;
  /** Latest bounded native tool details, kept in memory until stored as content. */
  readonly details: Map<string, NativeToolDetail>;
  readonly dirty: Set<string>;
  /** Sequential content writes owned by this Turn; drained before its binding closes. */
  writes: Promise<void>;
  writeFailure: unknown;
  /** Where this Turn's stderr begins in its program's stderr, for its diagnostics; null before a program serves it. */
  diagnosticMark: number | null;
  /**
   * The Turn's budgets (ADR-036): what is left of each, whether it waits for the user now, since when (monotonic), and the
   * timer of the one that runs.
   */
  readonly budget: { executionLeftMs: number; waitLeftMs: number; waiting: boolean; since: number; timer: ReturnType<typeof setTimeout> | null };
  /** Why the Runtime stopped this Turn on its own, when it did. */
  stopReason: "RUN_TIMEOUT" | "WAIT_EXPIRED" | null;
  /** Ends the program when it has not settled once the stop grace has passed. */
  grace: ReturnType<typeof setTimeout> | null;
  /**
   * What the program streamed and this Turn has not committed yet (ADR-047): one window of reply text or thinking, the UTF-8
   * bytes of that kind as they stand once the window is committed (`committedBytes` of them were committed before it; `last`
   * is the final UTF-16 code unit, so a pair split between chunks is counted once), and the window's timer, owned by the Turn.
   */
  readonly stream: { kind: "text" | "thinking" | null; text: string; committedBytes: number; bytes: number; last: string; cancel: (() => void) | null };
  /** A window refused outside a driver callback (by its timer, a stop or a close); reported as the Turn's failure. */
  streamFailure: unknown;
}
/** A conversation's kept native process (ADR-030): the binding of its last Run, idle between Turns and owned by the runtime. */
interface KeptProcess {
  readonly binding: PreparedSessionBinding;
  readonly selection: HarnessSelection;
  readonly conversation: NativeConversationId;
  readonly runId: PublicRun["id"];
  readonly since: number;
  /** Updates the process had sent outside its Turns when it was handed over; later ones are its background activity. */
  readonly baseline: number;
  readonly lastUsed: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** The recorded identity of its process group, read once when it was first kept; absent when it could not be read. */
  readonly identity?: KeptProcessIdentity;
}
/** Why a kept process was closed; each close is recorded for its conversation. */
type KeptRelease = "idle" | "disabled" | "ended_by_user" | "selection_changed" | "conversation_closed" | "native_reset" | "branched" | "exited" | "gateway_shutdown" | "harness_upgrade";
/** At most this many processes are kept at once (ADR-030). */
const KEPT_LIMIT = 4;
/** A kept process without a Turn for this long is closed (ADR-030). */
export const KEPT_IDLE_MS = 30 * 60 * 1000;
function sameSelection(left: HarnessSelection, right: HarnessSelection): boolean {
  return left.harnessId === right.harnessId && left.controlId === right.controlId && JSON.stringify(left.provider ?? null) === JSON.stringify(right.provider ?? null)
    && (left.nativeModel ?? null) === (right.nativeModel ?? null) && JSON.stringify(Object.entries(left.nativeOptions ?? {}).sort()) === JSON.stringify(Object.entries(right.nativeOptions ?? {}).sort());
}
const TERMINAL_TOOL = new Set(["completed", "failed", "declined", "cancelled", "interrupted", "error"]);
/** Run statuses of a Turn not yet settled: it is queued, waits for a slot or workspace, or runs. */
const OPEN_RUN = new Set<PublicRun["status"]>(["queued", "preparing", "running", "settling"]);
/** Byte-bounded UTF-8 text; the tail is kept for streams whose end carries the result. */
function bounded(value: string, maximum: number, tail = false): { readonly text: string; readonly cut: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return { text: value, cut: false };
  const slice = tail ? bytes.subarray(bytes.length - maximum) : bytes.subarray(0, maximum);
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/^\uFFFD|\uFFFD$/gu, ""), cut: true };
}
function mergeDetail(prior: NativeToolDetail | undefined, next: NativeToolDetail): NativeToolDetail {
  let cut = prior?.truncated === true || next.truncated === true;
  const field = (value: string | undefined, fallback: string | undefined, maximum: number, tail = false): string | undefined => {
    if (value === undefined) return fallback; const result = bounded(value, maximum, tail); cut ||= result.cut; return result.text;
  };
  const input = field(next.input, prior?.input, TOOL_INPUT_BYTES), output = field(next.output, prior?.output, TOOL_OUTPUT_BYTES, true), diff = field(next.diff, prior?.diff, TOOL_DIFF_BYTES);
  const locations = (next.locations ?? prior?.locations)?.slice(0, 16).map(path => bounded(path, 1024).text);
  const kind = next.kind ?? prior?.kind, name = next.name ?? prior?.name, parentId = next.parentId ?? prior?.parentId, exitCode = next.exitCode ?? prior?.exitCode;
  return { ...(kind === undefined ? {} : { kind: kind.slice(0, 64) }), ...(name === undefined ? {} : { name: name.slice(0, 256) }), ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
    ...(diff === undefined ? {} : { diff }), ...(locations === undefined ? {} : { locations }), ...(exitCode === undefined ? {} : { exitCode }), ...(parentId === undefined ? {} : { parentId: parentId.slice(0, 512) }), ...(cut ? { truncated: true } : {}) };
}
/** Event-log form of a native event: summaries only, never stored bytes or large previews. */
function logged(value: ControlEvent): ControlEvent | Readonly<Record<string, unknown>> {
  if (value.type === "tool") { const { detail, ...summary } = value; return detail === undefined ? summary : { ...summary, ...(detail.kind === undefined ? {} : { kind: detail.kind }), ...(detail.name === undefined ? {} : { name: detail.name }), ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(detail.parentId === undefined ? {} : { parentId: detail.parentId }) }; }
  if (value.type === "output" && value.output.kind === "content") { const summary: Readonly<Record<string, unknown>> = { type: "output", output: { kind: "content", name: value.output.name, mediaType: value.output.mediaType, bytes: value.output.data.byteLength } }; return summary; }
  return value;
}
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 96) || "tool"; }
/**
 * UTF-8 bytes of `prior + next` from `priorBytes`, re-encoding only the last code unit of `prior`: a surrogate pair split
 * between two chunks is three bytes on each side alone and four together, so a window's count stays exact (ADR-047).
 */
function joinedBytes(priorBytes: number, priorLast: string, next: string): number {
  return priorBytes - utf8Bytes(priorLast) + utf8Bytes(priorLast + next);
}
const MAX_PENDING_CREATES = 16;
function requested(value: SelectionRequest): SelectionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "harnessId" && key !== "controlId" && key !== "provider" && key !== "nativeModel" && key !== "nativeOptions") ||
    typeof value.harnessId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value.harnessId) ||
    (value.controlId !== undefined && (typeof value.controlId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value.controlId))))
    throw new SessionError("INVALID_INPUT", "selection must name bounded catalog identities");
  if (value.nativeModel !== undefined && (typeof value.nativeModel !== "string" || !value.nativeModel.trim() || value.nativeModel.length > 1024 || /[\0\r\n]/u.test(value.nativeModel)))
    throw new SessionError("INVALID_INPUT", "invalid native model identity");
  if ((value.nativeModel !== undefined || value.nativeOptions !== undefined) && value.provider != null) throw new SessionError("INVALID_INPUT", "native model and managed Provider are mutually exclusive");
  return { harnessId: value.harnessId, ...(value.controlId === undefined ? {} : { controlId: value.controlId }),
    ...(value.provider === undefined ? {} : { provider: value.provider === null ? null : parseProviderTarget(value.provider) }),
    ...(value.nativeModel === undefined ? {} : { nativeModel: value.nativeModel }), ...(value.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(value.nativeOptions) }) };
}
/** Quoted native history of a continued session: well inside the 1 MiB public context, so its branches still fit. */
const MAX_IMPORTED_MESSAGES = 200, MAX_IMPORTED_BYTES = 512 * 1024;
function fault(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SessionError) return { code: error.code.slice(0, 128), message: error.message.slice(0, 512) };
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 128) : "CONTROL_FAILED";
  return { code, message: "Harness operation failed; inspect private control diagnostics" };
}
/** How much of a Turn's stderr is kept for its diagnostics, and for how many Turns. */
const RUN_DIAGNOSTIC_BYTES = 4096, MAX_RUN_DIAGNOSTICS = 64;
/** Longest wait a driver may announce for one request (a day); anything else is ignored rather than shown. */
const MAX_PERMISSION_WAIT_MS = 24 * 60 * 60 * 1000;
/** A duration in the user's words: seconds below a minute, whole minutes otherwise. */
function duration(ms: number): string { return ms < 1000 ? ms + " 毫秒" : ms < 60_000 ? Math.round(ms / 1000) + " 秒" : Math.round(ms / 60_000) + " 分钟"; }
/** What the conversation says when the Runtime stopped a Turn on its own (ADR-036). */
function budgetNotice(kind: "execution" | "wait", budgetMs: number): PublicNotice {
  return kind === "wait" ? { severity: "warning", title: "等待期限已到", detail: `等待你的决定超过 ${duration(budgetMs)}，本回合已取消；原程序没有收到决定。` }
    : { severity: "warning", title: "执行期限已到", detail: `本回合的执行时间（不含等待你的时间）超过 ${duration(budgetMs)}，HarnessHub 已停止它。` };
}
/** Adds a notice of the Hub itself to a Run, within the Run's notice budget. */
function withNotice(state: SessionSnapshot, id: string, notice: PublicNotice): SessionSnapshot {
  const run = state.runs.find(item => item.id === id);
  if (run === undefined || (run.notices ?? []).length >= MAX_RUN_NOTICES) return state;
  return updatedRun(state, id, { notices: [...(run.notices ?? []), notice] });
}
function updatedRun(state: SessionSnapshot, id: string, patch: Partial<PublicRun>): SessionSnapshot {
  const prior = state.runs.find(run => run.id === id);
  if (!prior) throw new SessionError("IDENTITY_MISMATCH", "Run is not owned by this Session");
  const next = { ...prior, ...patch };
  return { ...state, runs: state.runs.map(run => run.id === id ? next : run),
    messages: state.messages.map(message => message.runId === id ? { ...message, status: next.status } : message) };
}
function event(type: string, data: Readonly<Record<string, unknown>>): EventDraft { return { type, data }; }
/** Native events that the user sees in the conversation; the first of them marks the Run's first output. */
const VISIBLE_OUTPUT = new Set<ControlEvent["type"]>(["text", "thinking", "tool", "plan", "permission_requested", "output", "activity"]);
/**
 * The Run patch that records one more phase at `now`, never before a phase already recorded (a clock that steps back keeps
 * the order). A Run without timing (accepted before Session v10) and a phase already recorded stay as they are.
 */
function phase(state: SessionSnapshot, id: PublicRun["id"], name: Exclude<keyof RunTiming, "acceptedAt">, now: number): Partial<PublicRun> {
  const timing = state.runs.find(run => run.id === id)?.timing;
  if (timing === undefined || timing[name] !== undefined) return {};
  return { timing: { ...timing, [name]: Math.max(now, ...Object.values(timing).filter((value): value is number => typeof value === "number")) } };
}

/**
 * One worker per conversation (several conversations in parallel, ADR-036), durable admission, and a new explicitly
 * rehydrated native connection per Turn, unless the conversation
 * keeps its native process between Turns (ADR-030): then the next Turn with the same selection reuses it, and every close
 * of a kept process (idle, switch, close, reset, branch, shutdown, or the user) is recorded for its conversation.
 */
export class SessionRuntime {
  /** Native processes that conversations keep between Turns, owned here until closed. */
  private readonly kept = new Map<SessionId, KeptProcess>();
  /** Kept processes being closed; every Turn or switch waits for them first, so none meets a lease about to be released. */
  private readonly releasing = new Map<SessionId, Promise<void>>();
  /** Background processes that left a closed or taken-over program's group and still ran; said once in their conversations. */
  private readonly outside = new Map<SessionId, { readonly count: number; readonly at: number }>();
  /** Processes a previous owner kept and this owner found at start, with what became of them; shown in their conversations. */
  private readonly lost = new Map<SessionId, { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number }>();
  /** Conversations whose kept process an upgrade of its Harness closed (ADR-043), until their next Turn. */
  private readonly upgraded = new Map<SessionId, { readonly harnessId: string; readonly at: number }>();
  /** The latest Turns' stderr tails, oldest first; private until redacted for the user's diagnostics. */
  private readonly diagnostics = new Map<string, { readonly sessionId: SessionId; readonly stderr: string; readonly truncated: boolean }>();
  private accepting = true;
  private readonly closingSessions = new Set<SessionId>();
  private readonly managedSessions = new Set<SessionId>();
  private readonly creating = new Set<Promise<SessionSnapshot>>();
  /** Conversations with work their worker has not taken yet (ADR-036). */
  private readonly work = new Set<SessionId>();
  /** Callers of `wait` whose conversation's work is not taken yet; woken after every scheduling pass. */
  private readonly wakers = new Set<() => void>();
  /** The worker serving each conversation that has one: it runs that conversation's work in order; at most `maxParallel` run at once. */
  private readonly workers = new Map<SessionId, Promise<void>>();
  /** The Turn each conversation is executing, at most one per conversation. */
  private readonly actives = new Map<SessionId, ActiveExecution>();
  /** The workspace each worker holds while it serves its conversation; another conversation's work there waits (ADR-036). */
  private readonly holders = new Map<string, SessionId>();
  /** Conversations whose next Turn waits for a workspace another conversation's work holds, with since when. */
  private readonly waitingForWorkspace = new Map<SessionId, { readonly runId: string; readonly holder: SessionId; readonly since: number; readonly sinceMono: number; readonly timer: ReturnType<typeof setTimeout> }>();
  /** Conversations whose next Turn waits for a slot while every slot is taken, with since when (ADR-036); no budget runs. */
  private readonly waitingForSlot = new Map<SessionId, { readonly runId: string; readonly since: number }>();
  /** How much of each Turn's wait budget its waits for a workspace used before it started (ADR-036). */
  private readonly waitUsed = new Map<string, number>();
  /** The conversation that held the workspace of each Turn this owner ended with WORKSPACE_BUSY, latest first out. */
  private readonly busyHolders = new Map<string, SessionId>();
  private readonly permissions = new Map<string, { request: PermissionRequest; nativeId: string; execution: ActiveExecution; option: string | null; command: string | null; readonly harnessId: string }>();
  permissionRequests(id: SessionId): readonly PermissionRequest[] { this.load(id); return [...this.permissions.values()].filter(value => value.execution.sessionId === id).map(value => value.request); }
  /**
   * Every approval or question still waiting for the user, across conversations, oldest first (ADR-035). Requests live only
   * in this owner's memory, so a restarted owner lists none; decided requests are no longer waiting.
   */
  attention(): readonly AttentionItem[] {
    return [...this.permissions.entries()].filter(([, value]) => !value.request.decided).map(([permissionId, value]) => ({ sessionId: value.execution.sessionId, permissionId,
      runId: value.execution.runId, harnessId: value.harnessId, kind: value.request.kind ?? "approval" as const, requestedAt: value.request.requestedAt,
      ...(value.request.expiresAt === undefined ? {} : { expiresAt: value.request.expiresAt, expiresBy: value.request.expiresBy ?? "turn" }) }))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }
  async decidePermission(id: SessionId, permission: string, option: string, key: string, input?: string): Promise<{ readonly replayed: boolean }> {
    const command=commandId(key);
    if (!/^permission-[A-Za-z0-9-]{1,96}$/u.test(permission) || typeof option!=="string" || !option || option.length>1024 || /[\0\r\n]/u.test(option)) throw new SessionError("INVALID_INPUT","invalid native permission decision");
    if (input !== undefined && (typeof input !== "string" || Buffer.byteLength(input) > 65536 || input.includes("\0"))) throw new SessionError("INVALID_INPUT", "invalid native input response");
    const state = this.load(id), fingerprint=this.fingerprint({kind:"permission",permission,option,...(input===undefined?{}:{input})}), prior=replayCommand(state,command,"permission",fingerprint);
    if (prior) return {replayed:true};
    this.commandBudget(state);
    const pending = this.permissions.get(permission);
    if (!pending || pending.execution.sessionId !== id || !pending.request.options.some(value => value.id === option)) throw new SessionError("PERMISSION_UNAVAILABLE", "native permission or option is no longer pending");
    if(input!==undefined&&(!pending.request.input||Buffer.byteLength(input)>65536||input.includes("\0")))throw new SessionError("INVALID_INPUT","invalid native input response");
    if (pending.option !== null) { if (pending.option === option && pending.command === key) return { replayed: true }; throw new SessionError("PERMISSION_CONFLICT", "native permission has already been decided"); }
    this.continue(pending.execution);
    const control = pending.execution.binding?.control;
    if (!control?.decidePermission) throw new SessionError("UNSUPPORTED_PERMISSION", "native approval is unavailable");
    pending.option = option; pending.command = key; pending.request = { ...pending.request, decided: true };
    try { this.commit(id, current => ({ next: { ...current, commands:[...current.commands,{id:command,kind:"permission",fingerprint,resultId:pending.execution.runId}] }, events: [event("permission.decided", { permissionId: permission, runId: pending.execution.runId, optionId: option, commandId: key })] })); }
    catch(error) { pending.option=null;pending.command=null;pending.request={...pending.request,decided:false};throw error; }
    this.leaveWait(pending.execution);
    await control.decidePermission(pending.nativeId, option, input); this.owned(pending.execution);
    this.permissions.delete(permission);
    this.commit(id, current => ({ next: current, events: [event("permission.submitted", { permissionId: permission, runId: pending.execution.runId, optionId: option, backendAcknowledged: false })] }));
    return { replayed: false };
  }
  /** The switch target each conversation is validating, at most one per conversation. */
  private readonly switchBindings = new Map<SessionId, { readonly binding: PreparedSessionBinding; close: Promise<CleanupEvidence> | null }>();
  private fatal: SessionError | null = null;
  private publicationFailed = false;
  private recordingBlock = false;
  private shutdown: Promise<void> | null = null;

  constructor(private readonly store: SessionStore, private readonly factory: SessionBindingFactory, private readonly options: SessionRuntimeOptions) {}

  create(configuration: SessionConfiguration, selection: SelectionRequest, key: string): Promise<SessionSnapshot> {
    try {
      this.admit();
      if (this.creating.size >= MAX_PENDING_CREATES) throw new SessionError("CREATE_LIMIT", "at most " + MAX_PENDING_CREATES + " Session creations may be awaiting validation");
    } catch (error) { return Promise.reject(error); }
    const pending = this.createOwned(configuration, selection, key);
    this.creating.add(pending);
    void pending.then(() => { this.creating.delete(pending); }, () => { this.creating.delete(pending); });
    return pending;
  }
  private async createOwned(configuration: SessionConfiguration, selection: SelectionRequest, key: string): Promise<SessionSnapshot> {
    this.admit();
    const config = parseConfiguration(configuration), request = requested(selection), command = commandId(key);
    const fingerprint = this.fingerprint({ kind: "create", configuration: config, selection: request });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return prior; }
    const validated = await this.factory.validate(request, config);
    this.admit();
    // Validation has an await boundary; another create may have committed the same command in the meantime.
    const concurrent = this.store.findByCreateKey(command);
    if (concurrent) { replayCommand(concurrent, command, "create", fingerprint); return concurrent; }
    const id = sessionId("session-" + this.options.id());
    const state: SessionSnapshot = { schemaVersion: 12, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
      configuration: config, selection: validated, activeRunId: null, pendingSwitchId: null,
      runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "public_context_rehydrate" })]);
      this.managedSessions.add(committed.session.id);
      return this.publish(committed).session;
    }
    catch (error) { this.fail(error, id); throw error; }
  }

  /**
   * Continues a native session of the installed Harness as a new conversation. The session must belong to this workspace
   * and no other conversation may hold it; its recent messages are quoted (never re-executed) and its reference becomes
   * this conversation's native session, so the next input goes to it directly. Nothing is sent to a model.
   */
  importNative(configuration: SessionConfiguration, selection: SelectionRequest, nativeId: string, key: string): Promise<SessionSnapshot> {
    try {
      this.admit();
      if (this.creating.size >= MAX_PENDING_CREATES) throw new SessionError("CREATE_LIMIT", "at most " + MAX_PENDING_CREATES + " Session creations may be awaiting validation");
    } catch (error) { return Promise.reject(error); }
    const pending = this.importOwned(configuration, selection, nativeId, key);
    this.creating.add(pending);
    void pending.then(() => { this.creating.delete(pending); }, () => { this.creating.delete(pending); });
    return pending;
  }
  private async importOwned(configuration: SessionConfiguration, selection: SelectionRequest, nativeId: string, key: string): Promise<SessionSnapshot> {
    this.admit();
    if (typeof nativeId !== "string" || !nativeId.trim() || Buffer.byteLength(nativeId) > 1024 || /[\0-\x1f\x7f]/u.test(nativeId)) throw new SessionError("INVALID_INPUT", "invalid native session identity");
    const config = parseConfiguration(configuration), request = requested(selection), command = commandId(key);
    if (request.provider != null) throw new SessionError("INVALID_INPUT", "a native session continues with its own Harness, not a managed Provider");
    const fingerprint = this.fingerprint({ kind: "import", configuration: config, selection: request, nativeId });
    const replay = () => { const prior = this.store.findByCreateKey(command); if (prior) replayCommand(prior, command, "create", fingerprint); return prior; };
    const prior = replay(); if (prior) return prior;
    const validated = await this.factory.validate(request, config);
    this.admit();
    if (validated.provider !== undefined) throw new SessionError("INVALID_INPUT", "a native session continues with its own Harness, not a managed Provider");
    if (!this.factory.readNativeSession) throw new SessionError("NATIVE_SESSION_LIST_UNAVAILABLE", "this Gateway cannot read native sessions");
    const held = (checkpoint: string) => {
      const owner = this.store.nativeOwners(validated.harnessId, validated.controlId).get(checkpoint);
      if (owner !== undefined) throw new SessionError("NATIVE_SESSION_CONFLICT", "这个本机会话已经在另一个对话中继续：" + owner);
    };
    held(nativeId);
    const read = await this.factory.readNativeSession(validated, config, nativeId);
    this.admit();
    const concurrent = replay(); if (concurrent) return concurrent;
    const checkpoint = read.checkpoint;
    if (typeof checkpoint !== "string" || !checkpoint || Buffer.byteLength(checkpoint) > 8192 || /[\0\r\n]/u.test(checkpoint)) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "invalid original Harness recovery reference");
    held(checkpoint);
    // The newest messages are quoted within a budget that leaves room for this conversation's own branches.
    const quoted: ForkedMessage[] = []; let bytes = 2, omitted = Number.isSafeInteger(read.omitted) && read.omitted > 0 ? read.omitted : 0;
    const history = read.historyRead ? read.history : [];
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index]!, message: ForkedMessage = { role: entry.role, text: entry.text, status: "completed", ...(entry.role === "assistant" ? { harnessId: validated.harnessId } : {}) };
      const size = utf8Bytes(JSON.stringify(message)) + 1;
      if (quoted.length >= MAX_IMPORTED_MESSAGES || bytes + size > MAX_IMPORTED_BYTES) { omitted += index + 1; break; }
      quoted.unshift(message); bytes += size;
    }
    const title = typeof read.title === "string" && read.title.trim() ? read.title.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, 200) : null;
    const id = sessionId("session-" + this.options.id());
    const state: SessionSnapshot = { schemaVersion: 12, id, version: 0, lastSeq: 0, epoch: 1, status: "open", configuration: config, selection: validated,
      activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      origin: { kind: "import", harnessId: validated.harnessId, title, omitted, complete: read.historyRead === true && read.complete === true, historyRead: read.historyRead === true, history: quoted },
      nativeBindings: [{ harnessId: validated.harnessId, controlId: validated.controlId, checkpoint, throughRunId: null, status: "ready" }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "native_import",
        origin: { harnessId: validated.harnessId, messages: quoted.length, omitted, historyRead: read.historyRead === true } })]);
      this.managedSessions.add(id);
      return this.publish(committed).session;
    } catch (error) { this.fail(error, id); throw error; }
  }

  send(id: SessionId, text: string, key: string, attachmentIds: readonly string[] = []): SendReceipt {
    this.admit(); assertInput(text);
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_RUN_ATTACHMENTS || attachmentIds.some(value => typeof value !== "string")) throw new SessionError("INVALID_INPUT", "attachments must be at most 8 content identities");
    // Without attachments the fingerprint keeps its earlier shape, so replayed commands from before attachments still match.
    const command = commandId(key), fingerprint = this.fingerprint(attachmentIds.length ? { kind: "send", text, attachments: attachmentIds } : { kind: "send", text }), state = this.load(id);
    const prior = replayCommand(state, command, "send", fingerprint);
    if (prior) return { sessionId: id, runId: runId(prior.resultId), replayed: true };
    this.open(state); this.commandBudget(state);
    let attachments: readonly ContentRef[] = [];
    if (attachmentIds.length) {
      if (this.options.content === undefined) throw new SessionError("ATTACHMENT_UNAVAILABLE", "this Gateway has no content storage for attachments");
      attachments = this.options.content.resolve(attachmentIds, state.configuration.workspace);
    }
    if (state.runs.length >= MAX_RUNS) throw new SessionError("RUN_LIMIT", "Session Run budget exhausted");
    if (state.runs.filter(run => run.status === "queued").length >= MAX_QUEUE) throw new SessionError("QUEUE_FULL", "Session queued input limit reached");
    const nextId = runId("run-" + this.options.id()), userId = messageId("message-" + this.options.id()), assistantId = messageId("message-" + this.options.id());
    const run: PublicRun = { id: nextId, commandId: command, input: text, userMessageId: userId, assistantMessageId: assistantId,
      selection: state.selection, epoch: state.epoch, status: "queued", cancelRequested: false, contextThroughSeq: 0,
      sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: state.pendingSwitchId, ...(attachments.length ? { attachments } : {}),
      timing: { acceptedAt: this.options.now().getTime() } };
    // What this owner found of a process kept under the previous one is shown until the conversation's next Turn.
    this.lost.delete(id); this.outside.delete(id); this.upgraded.delete(id);
    this.commit(id, current => ({ next: { ...current, runs: [...current.runs, run],
      messages: [...current.messages, { id: userId, runId: nextId, role: "user", text, seq: current.lastSeq + 1, status: "queued" }],
      commands: [...current.commands, { id: command, kind: "send", fingerprint, resultId: nextId }] },
      events: [event("message.accepted", { runId: nextId, messageId: userId, role: "user", text, ...(attachments.length ? { attachments } : {}) })] }));
    this.schedule(id); return { sessionId: id, runId: nextId, replayed: false };
  }

  switch(id: SessionId, selection: SelectionRequest, key: string): SwitchReceipt {
    return this.requestSwitch(id, selection, key, false, false);
  }
  /** Explicit recovery checks durable closure, then validates a fresh target without replaying any Run. */
  resume(id: SessionId, selection: SelectionRequest, key: string, acknowledgeUnknown = false): SwitchReceipt {
    return this.requestSwitch(id, selection, key, true, acknowledgeUnknown);
  }
  private requestSwitch(id: SessionId, selection: SelectionRequest, key: string, recovery: boolean, acknowledgeUnknown: boolean): SwitchReceipt {
    this.admit(); const request = requested(selection), command = commandId(key), fingerprint = this.fingerprint({ kind: "switch", selection: request,
      ...(recovery ? { recovery: true, acknowledgeUnknown } : {}) });
    const state = this.load(id), prior = replayCommand(state, command, "switch", fingerprint);
    if (prior) return { sessionId: id, switchId: switchId(prior.resultId), replayed: true };
    if (recovery) this.recoverable(state, acknowledgeUnknown); else this.open(state);
    this.commandBudget(state);
    if (state.pendingSwitchId !== null) throw new SessionError("SWITCH_PENDING", "one switch request is already pending");
    const nextId = switchId("switch-" + this.options.id());
    this.commit(id, current => ({ next: { ...(recovery ? this.cancelPending(current) : current), pendingSwitchId: nextId,
      switches: [...current.switches, { id: nextId, commandId: command, requested: request, requestedSeq: current.lastSeq + 1, target: null,
        status: "requested", throughSeq: 0, sourceRunIds: current.runs.filter(run => terminal(run.status) || run.id === current.activeRunId).map(run => run.id), error: null }],
      commands: [...current.commands, { id: command, kind: "switch", fingerprint, resultId: nextId }] },
      events: [event("switch.requested", { switchId: nextId, requested: request, mode: "wait_current", ...(recovery ? { recovery: true, acknowledgeUnknown,
        cancelledRunIds: current.runs.filter(run => run.status === "queued").map(run => run.id) } : {}) })] }));
    this.schedule(id); return { sessionId: id, switchId: nextId, replayed: false };
  }

  cancel(id: SessionId, key: string, target?: string): CancelReceipt {
    this.admit(); return this.cancelInternal(id, commandId(key), target === undefined ? undefined : runId(target));
  }
  read(id: SessionId): SessionSnapshot { return this.load(id); }
  resetNative(id: SessionId, key: string, epoch: number): SessionSnapshot {
    this.admit(); const state = this.load(id), command = commandId(key);
    const fingerprint = this.fingerprint({ kind: "native-reset", epoch });
    if (replayCommand(state, command, "native-reset", fingerprint)) return state;
    this.commandBudget(state);
    if (state.status === "closed" || state.activeRunId !== null || state.pendingSwitchId !== null || state.runs.some(run => !terminal(run.status))) throw new SessionError("NATIVE_SESSION_BUSY", "native state can be branched only while idle");
    if (epoch !== state.epoch || state.selection.provider !== undefined) throw new SessionError("NATIVE_SELECTION_CONFLICT", "the selected native Harness changed");
    if (state.runs.some(run => run.status === "unknown" && run.cleanup?.closed !== true)) throw new SessionError("RECOVERY_CLEANUP_REQUIRED", "native resources must be confirmed before branching");
    const committed = this.commit(id, current => ({ next: { ...current,
      nativeBindings: current.nativeBindings?.map(binding => binding.harnessId === current.selection.harnessId && binding.controlId === current.selection.controlId && binding.status !== "archived" ? { ...binding, status: "archived" as const } : binding) ?? [],
      commands: [...current.commands, { id: command, kind: "native-reset", fingerprint, resultId: id }],
    }, events: [event("native.branch_requested", { harnessId: current.selection.harnessId, controlId: current.selection.controlId, historyPreserved: true, previousBindingPreserved: true })] }));
    // The kept process runs the archived native session; it is closed before the next Turn opens a new one (ADR-030).
    if (this.kept.has(id)) void this.requestRelease(id, "native_reset");
    return committed.session;
  }
  /**
   * Branches a Session after a finished Run. The branch quotes the public history through that Run and starts with the
   * same selection. When the source's native session is exactly at that Run, the branch gets a native fork of it (made
   * before the branch's first input); otherwise the branch continues from public history. Nothing is sent to a model.
   */
  fork(sourceId: SessionId, key: string, throughRunId?: string): SessionSnapshot {
    this.admit();
    const source = this.load(sourceId), command = commandId(key);
    if (throughRunId !== undefined && (typeof throughRunId !== "string" || !/^run-[A-Za-z0-9-]{1,128}$/u.test(throughRunId))) throw new SessionError("INVALID_INPUT", "invalid branch point");
    const through = throughRunId === undefined ? [...source.runs].reverse().find(run => terminal(run.status)) : source.runs.find(run => run.id === throughRunId);
    const fingerprint = this.fingerprint({ kind: "fork", source: sourceId, through: through?.id ?? null });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return prior; }
    if (!through || !terminal(through.status)) throw new SessionError("FORK_UNAVAILABLE", "a branch starts after a finished reply");
    if (source.activeRunId !== null || source.pendingSwitchId !== null) throw new SessionError("NATIVE_SESSION_BUSY", "wait for the current reply or switch to finish before branching");
    const last = source.runs.findIndex(run => run.id === through.id), included = new Set(source.runs.slice(0, last + 1).filter(run => terminal(run.status)).map(run => run.id));
    const history: ForkedMessage[] = [...(source.origin?.history ?? []), ...[...source.messages].filter(message => included.has(message.runId)).sort((a, b) => a.seq - b.seq).map(message => {
      const run = source.runs.find(row => row.id === message.runId)!;
      return { role: message.role, text: message.text, status: run.status, ...(message.role === "assistant" ? { harnessId: run.selection.harnessId } : {}), ...(message.role === "user" && run.attachments?.length ? { attachments: run.attachments } : {}) };
    })];
    const native = source.selection.provider === undefined ? source.nativeBindings?.find(binding => binding.harnessId === source.selection.harnessId && binding.controlId === source.selection.controlId && binding.status === "ready") : undefined;
    const nativeFork = native !== undefined && native.throughRunId === through.id;
    const id = sessionId("session-" + this.options.id());
    const state: SessionSnapshot = { schemaVersion: 12, id, version: 0, lastSeq: 0, epoch: 1, status: "open", configuration: source.configuration, selection: source.selection,
      activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      origin: { kind: "fork", sessionId: sourceId, throughRunId: through.id, history },
      ...(nativeFork ? { nativeBindings: [{ harnessId: native.harnessId, controlId: native.controlId, checkpoint: native.checkpoint, throughRunId: null, status: "fork-pending" as const }] } : {}) };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: state.selection, continuity: nativeFork ? "native_fork" : "public_context_rehydrate", origin: { sessionId: sourceId, throughRunId: through.id, messages: history.length, nativeFork } })]);
      this.managedSessions.add(id); this.publish(committed);
      // The source's kept process holds the native session the branch forks; it is closed first (ADR-030).
      if (this.kept.has(sourceId)) void this.requestRelease(sourceId, "branched");
      if (nativeFork) this.schedule(id);
      return committed.session;
    } catch (error) { this.fail(error, id); throw error; }
  }
  async wait(id: SessionId): Promise<void> {
    this.load(id);
    for (;;) {
      const worker = this.workers.get(id), release = this.releasing.get(id);
      if (worker) { await worker.catch(() => {}); continue; }
      if (release) { await release; continue; }
      // Work not yet taken waits for a free worker slot or its workspace; every scheduling change wakes it to look again.
      if (this.work.has(id) && !this.fatal) { await new Promise<void>(resolve => { this.wakers.add(resolve); }); continue; }
      if (this.fatal) throw this.fatal;
      if (this.load(id).status === "blocked" && !this.closingSessions.has(id)) throw new SessionError("SESSION_BLOCKED", "this Session needs recovery; new dispatch is disabled for this Session");
      return;
    }
  }

  /**
   * Opts this conversation in or out of keeping its native process between Turns (ADR-030). Off by default; turning it off
   * closes a kept process before the next Turn. Idempotent by command key.
   */
  setRetention(id: SessionId, enabled: boolean, key: string): SessionSnapshot {
    this.admit(); const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "retention", enabled });
    if (replayCommand(state, command, "retention", fingerprint)) return state;
    this.commandBudget(state);
    if (state.status === "closed") throw new SessionError("SESSION_CLOSED", "a closed Session keeps no native process");
    const committed = this.commit(id, current => {
      const { retainNative, ...rest } = current;
      return { next: { ...rest, ...(enabled ? { retainNative: true as const } : {}), commands: [...current.commands, { id: command, kind: "retention", fingerprint, resultId: id }] },
        events: [event("session.retention_changed", { enabled })] };
    }).session;
    if (!enabled && this.kept.has(id)) void this.requestRelease(id, "disabled");
    return committed;
  }
  /** Closes this conversation's kept process at the user's request, with the normal stop chain; resolves once it is recorded. */
  async endKept(id: SessionId, key: string): Promise<SessionSnapshot> {
    this.admit(); const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "native-close" });
    if (!replayCommand(state, command, "native-close", fingerprint)) {
      this.commandBudget(state);
      this.commit(id, current => ({ next: { ...current, commands: [...current.commands, { id: command, kind: "native-close", fingerprint, resultId: id }] }, events: [event("native.process_close_requested", {})] }));
    }
    if (this.kept.has(id) || this.releasing.has(id)) await this.requestRelease(id, "ended_by_user");
    return this.load(id);
  }
  /** This conversation's kept process as the chat shows it; null when it keeps none. */
  keptProcess(id: SessionId): { readonly harnessId: string; readonly controlId: string; readonly since: number; readonly lastUsedAt: number; readonly idleEndsAt: number; readonly backgroundUpdates: number } | null {
    const kept = this.kept.get(id);
    return kept === undefined ? null : { harnessId: kept.selection.harnessId, controlId: kept.selection.controlId, since: kept.since, lastUsedAt: kept.lastUsed,
      idleEndsAt: kept.lastUsed + (this.options.keptIdleMs ?? KEPT_IDLE_MS), backgroundUpdates: this.background(kept) };
  }
  /**
   * HarnessHub's own conversations using a Harness, for its upgrade (ADR-043): busy while a Turn with it is queued, waits
   * or runs; idle while the conversation only keeps its process.
   */
  programUsers(harnessId: string): readonly { readonly sessionId: SessionId; readonly busy: boolean }[] {
    const users = new Map<SessionId, boolean>();
    for (const id of new Set([...this.actives.keys(), ...this.work, ...this.workers.keys()])) {
      let state: SessionSnapshot;
      try { state = this.load(id); } catch { continue; }
      if (state.runs.some(run => OPEN_RUN.has(run.status) && run.selection.harnessId === harnessId)) users.set(id, true);
    }
    for (const [id, kept] of this.kept) if (kept.selection.harnessId === harnessId && !users.has(id)) users.set(id, false);
    return [...users].map(([sessionId, busy]) => ({ sessionId, busy }));
  }
  /**
   * Closes every idle kept process of a Harness before it is upgraded (ADR-043), with the normal stop chain, and resolves
   * with how many once each close is recorded. Each conversation says so until its next Turn, which starts the new version.
   */
  async releaseForUpgrade(harnessId: string): Promise<number> {
    const ids = [...this.kept].filter(([, kept]) => kept.selection.harnessId === harnessId).map(([id]) => id), at = this.options.now().getTime();
    // Recorded first, so the view published with each close already says why.
    for (const id of ids) this.upgraded.set(id, { harnessId, at });
    await Promise.all(ids.map(id => this.requestRelease(id, "harness_upgrade")));
    return ids.length;
  }
  /** The upgrade that closed this conversation's kept process, until its next Turn; null when none did. */
  keptUpgrade(id: SessionId): { readonly harnessId: string; readonly at: number } | null { return this.upgraded.get(id) ?? null; }
  /** Every kept process with the workspace it holds, for telling a conversation which one occupies its workspace. */
  keptProcesses(): readonly { readonly sessionId: SessionId; readonly workspace: string; readonly harnessId: string }[] {
    return [...this.kept].map(([sessionId, kept]) => ({ sessionId, workspace: kept.binding.workspace, harnessId: kept.selection.harnessId }));
  }
  /**
   * The last stderr this Turn's program logged while serving it, as the program wrote it (private: it is redacted before it
   * leaves the Gateway). Kept in memory for the latest Turns of this owner only; null when unknown.
   */
  runDiagnostics(id: SessionId, run: string): { readonly stderr: string; readonly truncated: boolean } | null {
    const kept = this.diagnostics.get(run);
    return kept === undefined || kept.sessionId !== id ? null : { stderr: kept.stderr, truncated: kept.truncated };
  }
  private keepDiagnostics(id: SessionId, run: string, stderr: string): void {
    const truncated = Buffer.byteLength(stderr) > RUN_DIAGNOSTIC_BYTES, tail = truncated ? Buffer.from(stderr).subarray(-RUN_DIAGNOSTIC_BYTES).toString("utf8").replace(/^\uFFFD+/u, "") : stderr;
    this.diagnostics.delete(run); this.diagnostics.set(run, { sessionId: id, stderr: tail, truncated });
    while (this.diagnostics.size > MAX_RUN_DIAGNOSTICS) this.diagnostics.delete(this.diagnostics.keys().next().value!);
  }
  /** What became of the process this conversation kept under the previous owner, when this owner found one at start. */
  keptLoss(id: SessionId): { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number } | null { return this.lost.get(id) ?? null; }
  /** How many background processes of this conversation's closed program may still run, until its next Turn. */
  keptOutside(id: SessionId): { readonly count: number; readonly at: number } | null { return this.outside.get(id) ?? null; }
  /**
   * Before a kept program's group is ended: the processes that left it, read once and never signalled. After: which still
   * run. The evidence keeps 0 found apart from not knowing, and a conversation hears of those still running once.
   */
  private async outsideBefore(identity: KeptProcessIdentity | undefined): Promise<readonly OutsideProcess[] | null> {
    if (identity === undefined || this.options.processes?.outsiders === undefined) return null;
    try { return await this.options.processes.outsiders(identity); } catch { return null; }
  }
  private async outsideAfter(id: SessionId, found: readonly OutsideProcess[] | null): Promise<OutsideEvidence> {
    if (found === null) return { state: "unknown" };
    let remaining: readonly OutsideProcess[] | null = [];
    if (found.length) { try { remaining = this.options.processes?.running === undefined ? null : await this.options.processes.running(found); } catch { remaining = null; } }
    const still = remaining === null ? found.length : remaining.length;
    if (still > 0) this.outside.set(id, { count: still, at: this.options.now().getTime() });
    return { state: "enumerated", found: found.length, remaining: remaining === null ? null : remaining.length, commands: [...new Set(found.map(item => item.command))].slice(0, 16) };
  }
  /**
   * Ends the native process groups that conversations kept under an owner that ended without closing them (ADR-030), and
   * releases each one's workspace lease once the end is confirmed. A group that cannot be recognized (no recorded identity,
   * or members that outlive SIGKILL) leaves its workspace quarantined. Each outcome is recorded for its conversation. The
   * owner runs it once at start, before admitting work; groups are handled one at a time, each within about 6 seconds.
   * Resolves with every outcome, in the order handled.
   */
  async reapKept(): Promise<readonly { readonly sessionId: SessionId; readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean }[]> {
    const outcomes: { readonly sessionId: SessionId; readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean }[] = [];
    for (const state of this.store.listKept()) {
      const retained = state.retained;
      if (retained === undefined || this.kept.has(state.id)) continue;
      let outcome: "terminated" | "gone" | "unconfirmed" = "unconfirmed";
      const found = await this.outsideBefore(retained.process);
      if (retained.process !== undefined && this.options.processes !== undefined) {
        try { outcome = await this.options.processes.end(retained.process); } catch { outcome = "unconfirmed"; }
      }
      const outside = await this.outsideAfter(state.id, found);
      let leaseReleased = false;
      if (outcome !== "unconfirmed") { try { leaseReleased = this.factory.releaseAbandonedLease?.(state.configuration, state.id) ?? false; } catch { leaseReleased = false; } }
      const at = this.options.now().getTime();
      this.commit(state.id, current => {
        const { retained: _held, ...rest } = current;
        return { next: rest, events: [event("native.process_lost", { runId: retained.runId, harnessId: retained.harnessId, controlId: retained.controlId, reason: "owner_ended", outcome, leaseReleased, outside })] };
      });
      this.lost.set(state.id, { outcome, leaseReleased, at });
      outcomes.push({ sessionId: state.id, outcome, leaseReleased });
    }
    return outcomes;
  }
  private background(kept: KeptProcess): number { return Math.max(0, (kept.binding.control.unattributedUpdates ?? kept.baseline) - kept.baseline); }
  /** Asks the single writer to close a kept process before its next Turn or switch; resolves once the close is recorded. */
  private requestRelease(id: SessionId, reason: KeptRelease): Promise<void> {
    const pending = this.releasing.get(id);
    if (pending) return pending;
    if (!this.kept.has(id)) return Promise.resolve();
    // A kept process is idle, so its close never meets its own conversation's Turn; Turns and switches wait for it (settleReleases).
    const done: Promise<void> = this.release(id, reason).catch(error => { this.fail(error, id); })
      .finally(() => { if (this.releasing.get(id) === done) this.releasing.delete(id); this.drive(); });
    this.releasing.set(id, done);
    return done;
  }
  /** Resolves once no kept process is being closed; work never starts while a lease may be about to be released. */
  private async settleReleases(): Promise<void> { while (this.releasing.size) await Promise.allSettled([...this.releasing.values()]); }
  /**
   * Closes a kept process with the normal stop chain (request stop, wait, SIGTERM/SIGKILL) and records the close and its
   * evidence for the conversation. A close that cannot be confirmed leaves the workspace lease quarantined.
   */
  private async release(id: SessionId, reason: KeptRelease): Promise<void> {
    const kept = this.kept.get(id);
    if (kept === undefined) return;
    this.kept.delete(id); clearTimeout(kept.timer);
    const backgroundUpdates = this.background(kept);
    let cleanup: CleanupEvidence | null = null, problem: ReturnType<typeof fault> | null = null;
    const found = await this.outsideBefore(kept.identity);
    try { cleanup = await kept.binding.close(); } catch (error) { problem = fault(error); }
    const outside = await this.outsideAfter(id, found);
    this.commit(id, current => {
      const { retained, ...rest } = current;
      return { next: rest, events: [event("native.process_closed", { runId: kept.runId, reason, backgroundUpdates, cleanup, outside, ...(problem === null ? {} : { error: problem }) })] };
    });
  }
  /** The process this conversation kept, when it can take a Turn with `selection`; a kept process that cannot is closed first. */
  private async takeKept(id: SessionId, selection: HarnessSelection): Promise<KeptProcess | null> {
    const kept = this.kept.get(id);
    if (kept === undefined) return null;
    if (!sameSelection(kept.selection, selection)) { await this.release(id, "selection_changed"); return null; }
    if (kept.binding.control.healthy?.() !== true) { await this.release(id, "exited"); return null; }
    this.kept.delete(id); clearTimeout(kept.timer); return kept;
  }
  /** Whether a finished Turn hands its process to the conversation: opted in, completed cleanly, confirmed, and under the limit. */
  private keepable(id: SessionId, execution: ActiveExecution, backend: BackendResult | null, problem: unknown, confirmed: boolean): { readonly keep: boolean; readonly skipped?: "limit" } {
    try {
      const state = this.load(id), run = state.runs.find(row => row.id === execution.runId);
      if (state.retainNative !== true || run === undefined || run.cancelRequested || run.selection.provider !== undefined || !confirmed || problem !== null || backend?.status !== "completed"
        || execution.stop !== null || execution.earlyClose !== null || !this.accepting || this.fatal !== null || this.closingSessions.has(id) || this.releasing.has(id)
        || execution.binding?.control.healthy?.() !== true) return { keep: false };
      return this.kept.size >= KEPT_LIMIT ? { keep: false, skipped: "limit" } : { keep: true };
    } catch { return { keep: false }; }
  }

  async closeSession(id: SessionId, key: string): Promise<SessionSnapshot> {
    this.admit(); const command = commandId(key), fingerprint = this.fingerprint({ kind: "close" });
    const state = this.load(id), prior = replayCommand(state, command, "close", fingerprint);
    if (prior) { await this.wait(id); return this.load(id); }
    this.commandBudget(state); this.closingSessions.add(id);
    try {
      // Text the active Turn streamed before the close is committed first, so the close never precedes it in the log (ADR-047).
      const active = this.actives.get(id); if (active) this.flushStreamQuietly(active);
      this.commit(id, current => {
        const next = this.cancelPending(current);
        return { next: { ...next, commands: [...next.commands, { id: command, kind: "close", fingerprint, resultId: id }] },
          events: [event("session.close_requested", { cancelledRunIds: current.runs.filter(run => run.status === "queued").map(run => run.id) })] };
      });
      if (active) this.stop(active);
      this.stopSwitch(id); this.drive();
      if (this.kept.has(id)) void this.requestRelease(id, "conversation_closed");
      await this.wait(id);
      return this.commit(id, current => ({ next: { ...current, status: "closed" }, events: [event("session.closed", {})] })).session;
    } finally { this.closingSessions.delete(id); }
  }

  /** Stops owned work and admission. Public Sessions and Store remain available to the next owner. */
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.accepting = false;
    // Install ownership before synchronous committed-event callbacks can reenter close().
    this.shutdown = Promise.resolve().then(() => this.closeOwned());
    void this.shutdown.catch(() => {});
    return this.shutdown;
  }
  private async closeOwned(): Promise<void> {
    let problem: unknown;
    try {
      for (const id of this.managedSessions) {
        const state = this.load(id);
        if (state.runs.some(run => !terminal(run.status)) || state.pendingSwitchId !== null) {
          // Text the active Turn streamed before the stop is committed first, so the stop never precedes it in the log (ADR-047).
          const active = this.actives.get(id); if (active) this.flushStreamQuietly(active);
          this.commit(state.id, current => ({ next: this.cancelPending(current), events: [event("runtime.stopping", {})] }));
        }
      }
    } catch (error) { problem = error; this.fail(error); }
    for (const execution of [...this.actives.values()]) this.stop(execution);
    this.stopSwitch();
    while (this.workers.size) await Promise.allSettled([...this.workers.values()]);
    // Kept processes end with their owner; each close is recorded for its conversation (ADR-030).
    try { await this.settleReleases(); for (const id of [...this.kept.keys()]) await this.release(id, "gateway_shutdown"); }
    catch (error) { problem ??= error; this.fail(error); }
    const creating = await Promise.allSettled([...this.creating]);
    for (const result of creating) if (result.status === "rejected" && !(result.reason instanceof SessionError && result.reason.code === "RUNTIME_CLOSED")) {
      problem ??= result.reason; this.fail(result.reason);
    }
    this.work.clear();
    if (problem) throw problem;
    if (this.fatal) throw this.fatal;
  }

  private cancelPending(state: SessionSnapshot): SessionSnapshot {
    const closedAt = this.options.now().getTime();
    const runs = state.runs.map(run => run.status === "queued" ? { ...run, status: "cancelled" as const, cancelRequested: true, ...phase(state, run.id, "endedAt", closedAt) }
      : terminal(run.status) ? run : { ...run, cancelRequested: true });
    const sourceStillActive = state.activeRunId !== null && state.switches.some(sw => sw.id === state.pendingSwitchId && sw.sourceRunIds.includes(state.activeRunId!));
    return { ...state, runs, messages: state.messages.map(message => ({ ...message, status: runs.find(run => run.id === message.runId)!.status })),
      pendingSwitchId: sourceStillActive ? state.pendingSwitchId : null, switches: state.switches.map(sw => sw.id === state.pendingSwitchId
        ? { ...sw, ...(sourceStillActive ? {} : { status: "failed" as const }), error: { code: "CANCELLED", message: "switch cancelled by close" } } : sw) };
  }
  private cancelInternal(id: SessionId, command: CommandId, target?: PublicRun["id"]): CancelReceipt {
    const state = this.load(id), fingerprint = this.fingerprint({ kind: "cancel", target: target ?? null });
    const prior = replayCommand(state, command, "cancel", fingerprint);
    if (prior) return { sessionId: id, target: prior.resultId === "none" ? null : runId(prior.resultId), replayed: true };
    this.open(state); this.commandBudget(state);
    const selected = target === undefined ? state.activeRunId : target;
    const run = selected === null ? undefined : state.runs.find(run => run.id === selected);
    if (selected !== null && !run) throw new SessionError("NOT_FOUND", "Run does not belong to this Session");
    // Text the Turn streamed before the user's stop is committed first, so the stop never precedes it in the log (ADR-047).
    const active = this.actives.get(id), stopping = active !== undefined && active.runId === selected ? active : null;
    if (stopping) this.flushStreamQuietly(stopping);
    this.commit(id, current => {
      let next = current;
      if (run && !terminal(run.status)) next = updatedRun(current, run.id, { cancelRequested: true, ...(run.status === "queued" ? { status: "cancelled" as const, ...phase(current, run.id, "endedAt", this.options.now().getTime()) } : {}) });
      return { next: { ...next, commands: [...next.commands, { id: command, kind: "cancel", fingerprint, resultId: selected ?? "none" }] },
        events: [event("run.cancel_requested", { runId: selected, beforeStart: run?.status === "queued", alreadyTerminal: run === undefined || terminal(run.status) })] };
    });
    if (stopping) this.stop(stopping);
    this.schedule(id); return { sessionId: id, target: selected, replayed: false };
  }

  private admit(): void {
    try { this.store.assertOwner(); } catch (error) { this.fail(error); throw error; }
    if (!this.accepting) throw new SessionError("RUNTIME_CLOSED", "runtime is not accepting commands");
    if (this.fatal) throw this.fatal;
  }
  private open(state: SessionSnapshot): void {
    if (state.status !== "open" || this.closingSessions.has(state.id)) throw new SessionError("SESSION_UNAVAILABLE", "Session is closed or blocked; new dispatch is disabled for this Session");
  }
  private recoverySwitch(state: SessionSnapshot): boolean {
    const pending = state.switches.find(sw => sw.id === state.pendingSwitchId);
    if (!pending) return false;
    const request = this.store.events(state.id, pending.requestedSeq - 1, 1)[0];
    return request?.type === "switch.requested" && request.data.switchId === pending.id && request.data.recovery === true;
  }
  private recoverable(state: SessionSnapshot, acknowledgeUnknown: boolean): void {
    if (state.status !== "blocked" || state.activeRunId !== null || state.pendingSwitchId !== null || this.closingSessions.has(state.id))
      throw new SessionError("RECOVERY_UNAVAILABLE", "当前对话无法执行恢复检查，请等待当前操作结束。");
    const unknown = state.runs.filter(run => run.status === "unknown");
    if (unknown.some(run => run.cleanup?.closed !== true || this.unknownOwnership(run.error)))
      throw new SessionError("RECOVERY_UNSAFE", "上次执行的资源还未确认停止，请先核实工作区中的进程。历史和草稿仍可查看与编辑。");
    if (unknown.length && !acknowledgeUnknown)
      throw new SessionError("RECOVERY_ACK_REQUIRED", "上次执行结果未知。确认保留该结果并只开始新的任务后，才能继续。");
    let after = 0;
    let block: SessionEvent | undefined;
    const failedSwitches = new Map<string, SessionEvent>();
    while (after < state.lastSeq) {
      const page = this.store.events(state.id, after, 100);
      if (!page.length) throw new SessionError("INVALID_DATA", "recovery facts have a missing event page");
      for (const item of page) {
        if (item.type === "switch.failed" && typeof item.data.switchId === "string") failedSwitches.set(item.data.switchId, item);
        if (item.type === "session.blocked") block = item;
      }
      after = page.at(-1)!.seq;
    }
    if (block === undefined || block.data.error !== undefined ||
        (typeof block.data.runId !== "string" && typeof block.data.switchId !== "string"))
      throw new SessionError("RECOVERY_UNSAFE", "对话因所有权或存储故障暂停，无法直接恢复执行。请先恢复本机服务；历史和草稿已保留。");
    if (typeof block.data.runId === "string") {
      const run = state.runs.find(run => run.id === block.data.runId);
      if (run?.cleanup?.closed !== true || this.unknownOwnership(run.error))
        throw new SessionError("RECOVERY_UNSAFE", "上次执行的资源还未确认停止，无法恢复同一工作区的执行。");
    } else {
      const failedSwitch = typeof block.data.switchId === "string" ? failedSwitches.get(block.data.switchId) : undefined;
      const cleanup = failedSwitch?.data.cleanup;
      if (failedSwitch?.data.switchId !== block.data.switchId || cleanup === null || typeof cleanup !== "object" || !("closed" in cleanup) || cleanup.closed !== true)
        throw new SessionError("RECOVERY_UNSAFE", "失败切换缺少资源关闭证据，无法恢复同一工作区的执行。");
    }
  }
  private commandBudget(state: SessionSnapshot): void {
    if (state.commands.length >= MAX_COMMANDS) throw new SessionError("COMMAND_LIMIT", "Session command budget exhausted");
  }
  private fingerprint(value: unknown): string { return this.options.fingerprint(JSON.stringify(value)); }
  private load(id: SessionId): SessionSnapshot {
    try { return this.store.get(id); }
    catch (error) {
      if (!(error instanceof SessionError) || error.code !== "SESSION_NOT_FOUND") this.fail(error, id);
      throw error;
    }
  }
  private commit(id: SessionId, mutate: (state: SessionSnapshot) => SessionMutation): SessionCommit {
    try {
      this.store.assertOwner(); const state = this.load(id);
      return this.publish(this.store.transact(id, state.version, mutate));
    }
    catch (error) { if (!(error instanceof SessionError && ["CONTEXT_TOO_LARGE", "OUTPUT_LIMIT", "QUEUE_FULL", "COMMAND_LIMIT", "RUN_LIMIT", "SESSION_LIMIT", "EVENT_LIMIT"].includes(error.code))) this.fail(error, id); throw error; }
  }
  private publish(commit: SessionCommit): SessionCommit {
    if (this.publicationFailed) return commit;
    try { for (const value of commit.events) this.options.publish(value); }
    catch { this.publicationFailed = true; const error = new SessionError("PUBLICATION_FAILED", "committed event publication failed; execution stopped"); this.fail(error, commit.session.id); throw error; }
    return commit;
  }
  private fail(error: unknown, id?: SessionId): void {
    this.fatal ??= new SessionError(fault(error).code, fault(error).message);
    const affected = id ?? [...this.actives.keys()][0] ?? [...this.switchBindings.keys()][0];
    for (const execution of [...this.actives.values()]) this.stop(execution);
    this.stopSwitch();
    if (affected !== undefined && !this.recordingBlock) {
      this.recordingBlock = true;
      try {
        this.store.assertOwner(); const state = this.store.get(affected);
        if (state.status === "open") {
          const committed = this.store.transact(affected, state.version, current => ({ next: { ...current, status: "blocked" },
            events: [event("session.blocked", { error: fault(error), reason: "runtime stopped after a failure" })] }));
          this.publish(committed);
        }
      } catch (recordingError) {
        // Preserve the independent failure: a missing durable blocked record is never reported as committed.
        this.fatal.cause ??= recordingError;
      } finally { this.recordingBlock = false; }
    }
  }
  /** Closes the switch target being validated for `id`, or for every conversation. */
  private stopSwitch(id?: SessionId): void {
    for (const [owner, pending] of this.switchBindings) {
      if (id !== undefined && owner !== id) continue;
      pending.close ??= pending.binding.close();
      void pending.close.catch(() => {});
    }
  }
  private schedule(id: SessionId): void {
    this.managedSessions.add(id);
    this.work.add(id);
    this.drive();
  }
  /**
   * Starts a worker for each conversation with waiting work and none of its own, oldest accepted work first, up to the
   * parallel limit (ADR-036). Work in a workspace another conversation's worker holds waits, visibly, until it is free.
   */
  private drive(): void {
    try { this.take(); }
    finally { const wakers = [...this.wakers]; this.wakers.clear(); for (const wake of wakers) wake(); }
  }
  private take(): void {
    if (this.fatal) { this.work.clear(); return; }
    const ordered = [...this.work].sort((a, b) => this.headAccepted(a) - this.headAccepted(b));
    for (const id of ordered) {
      if (this.workers.has(id)) continue;
      if (!this.runnable(id)) { this.work.delete(id); this.leaveQueue(id); this.leaveSlot(id); continue; }
      const workspace = this.load(id).configuration.workspace, holder = this.holders.get(workspace);
      if (holder !== undefined && holder !== id) { this.leaveSlot(id); this.joinQueue(id, holder); continue; }
      // With every slot taken, later work is still looked at, so work behind a held workspace shows that it waits.
      if (this.workers.size >= (this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS)) { this.joinSlot(id); continue; }
      this.work.delete(id); this.holders.set(workspace, id); this.leaveQueue(id); this.leaveSlot(id);
      const worker: Promise<void> = Promise.resolve().then(() => this.serve(id));
      this.workers.set(id, worker);
      void worker.then(() => {}, error => { this.fail(error, id); }).finally(() => {
        if (this.workers.get(id) === worker) this.workers.delete(id);
        if (this.holders.get(workspace) === id) this.holders.delete(workspace);
        this.drive();
      });
    }
  }
  /** Whether a conversation has work its worker would do now: a native fork, a switch or a queued Turn while it is open. */
  private runnable(id: SessionId): boolean {
    try {
      const state = this.load(id);
      if ((state.status !== "open" && !(state.status === "blocked" && this.recoverySwitch(state))) || this.closingSessions.has(id) || !this.accepting) return false;
      return state.pendingSwitchId !== null || state.runs.some(run => run.status === "queued") || (state.nativeBindings?.some(binding => binding.status === "fork-pending") ?? false);
    } catch { return true; }
  }
  /** When a conversation's oldest queued Turn was accepted; other work counts as last. */
  private headAccepted(id: SessionId): number {
    try { return this.load(id).runs.find(run => run.status === "queued")?.timing?.acceptedAt ?? Number.MAX_SAFE_INTEGER; } catch { return Number.MAX_SAFE_INTEGER; }
  }
  /**
   * Records once that a conversation's next Turn waits for `holder` to free their shared workspace. When that Turn is no
   * longer the next one (it was cancelled), its wait ends and the next Turn's wait begins.
   */
  private joinQueue(id: SessionId, holder: SessionId): void {
    const state = this.load(id), run = state.runs.find(item => item.status === "queued");
    if (this.waitingForWorkspace.get(id)?.runId !== run?.id) this.leaveQueue(id);
    if (run === undefined) return;
    const prior = this.waitingForWorkspace.get(id);
    if (prior !== undefined && prior.holder === holder) return;
    // Waiting for a workspace uses the Turn's wait budget; at its end the Turn fails with WORKSPACE_BUSY (ADR-036).
    const left = (this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS) - (this.waitUsed.get(run.id) ?? 0) - (prior === undefined ? 0 : performance.now() - prior.sinceMono);
    if (prior !== undefined) clearTimeout(prior.timer);
    const timer = setTimeout(() => this.queueExpired(id, run.id), Math.max(0, left)); timer.unref?.();
    this.waitingForWorkspace.set(id, { runId: run.id, holder, since: prior?.since ?? this.options.now().getTime(), sinceMono: prior?.sinceMono ?? performance.now(), timer });
    this.commit(id, current => ({ next: current, events: [event("run.waiting", { runId: run.id, kind: "workspace", holderSessionId: holder })] }));
  }
  /** A Turn waited for its workspace for its whole wait budget: it fails with WORKSPACE_BUSY, naming the holder, and is not retried. */
  private queueExpired(id: SessionId, run: string): void {
    const waiting = this.waitingForWorkspace.get(id);
    if (waiting === undefined || waiting.runId !== run) return;
    this.leaveQueue(id);
    // Known before the commit publishes, so the view that announces the failure already names the holder.
    this.busyHolders.set(run, waiting.holder);
    while (this.busyHolders.size > 256) this.busyHolders.delete(this.busyHolders.keys().next().value!);
    try {
      this.commit(id, current => ({ next: updatedRun(current, run, { status: "failed", error: { code: "WORKSPACE_BUSY", message: "another conversation's Turn held this workspace for the whole wait budget; this input was not dispatched" },
        ...phase(current, runId(run), "endedAt", this.options.now().getTime()) }), events: [event("run.ended", { runId: run, status: "failed", error: { code: "WORKSPACE_BUSY" }, neverDispatched: true, holderSessionId: waiting.holder })] }));
      this.waitUsed.delete(run);
    } catch (error) { this.busyHolders.delete(run); this.fail(error, id); }
    this.schedule(id);
  }
  /** Ends a conversation's wait for a workspace, recording how long it waited. */
  private leaveQueue(id: SessionId): void {
    const waiting = this.waitingForWorkspace.get(id);
    if (waiting === undefined) return;
    this.waitingForWorkspace.delete(id); clearTimeout(waiting.timer);
    this.waitUsed.set(waiting.runId, (this.waitUsed.get(waiting.runId) ?? 0) + (performance.now() - waiting.sinceMono));
    const waitedMs = Math.max(0, this.options.now().getTime() - waiting.since);
    try { this.commit(id, current => ({ next: current, events: [event("run.waiting_ended", { runId: waiting.runId, kind: "workspace", waitedMs })] })); } catch (error) { this.fail(error, id); }
  }
  /**
   * Records once that a conversation's next Turn waits for a slot because every slot is taken (ADR-036). It waits without a
   * budget of its own: each running Turn is bounded by its budgets, and slots go to work in the order it was accepted.
   */
  private joinSlot(id: SessionId): void {
    const run = this.load(id).runs.find(item => item.status === "queued");
    if (this.waitingForSlot.get(id)?.runId !== run?.id) this.leaveSlot(id);
    if (run === undefined || this.waitingForSlot.has(id)) return;
    this.waitingForSlot.set(id, { runId: run.id, since: this.options.now().getTime() });
    this.commit(id, current => ({ next: current, events: [event("run.waiting", { runId: run.id, kind: "slot", running: this.workers.size })] }));
  }
  /** Ends a conversation's wait for a slot, recording how long it waited. */
  private leaveSlot(id: SessionId): void {
    const waiting = this.waitingForSlot.get(id);
    if (waiting === undefined) return;
    this.waitingForSlot.delete(id);
    const waitedMs = Math.max(0, this.options.now().getTime() - waiting.since);
    try { this.commit(id, current => ({ next: current, events: [event("run.waiting_ended", { runId: waiting.runId, kind: "slot", waitedMs })] })); } catch (error) { this.fail(error, id); }
  }
  /**
   * Whether another conversation should go before this worker's next work, by acceptance (FIFO, ADR-036): one waiting for
   * this workspace, or one waiting for a slot while every slot is taken.
   */
  private earlierWaiter(id: SessionId): boolean {
    const workspace = this.load(id).configuration.workspace, mine = this.headAccepted(id), full = this.workers.size >= (this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS);
    return [...this.work].some(other => other !== id && !this.workers.has(other) && this.headAccepted(other) < mine
      && (this.waitingForWorkspace.has(other) ? this.load(other).configuration.workspace === workspace : full));
  }
  /**
   * What a conversation's next Turn waits for, when it waits for another conversation's work in their shared workspace:
   * which conversation holds it and whether that one waits for the user (ADR-036).
   */
  queueState(id: SessionId): { readonly runId: string; readonly holderSessionId: SessionId; readonly holderWaitsForUser: boolean; readonly since: number; readonly endsAt: number } | null {
    const waiting = this.waitingForWorkspace.get(id);
    if (waiting === undefined) return null;
    const holderWaits = [...this.permissions.values()].some(value => value.execution.sessionId === waiting.holder && !value.request.decided);
    const left = (this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS) - (this.waitUsed.get(waiting.runId) ?? 0);
    return { runId: waiting.runId, holderSessionId: waiting.holder, holderWaitsForUser: holderWaits, since: waiting.since, endsAt: waiting.since + Math.max(0, left) };
  }
  /** What a conversation's next Turn waits for, when every slot is taken: how many conversations run and the limit (ADR-036). */
  slotWait(id: SessionId): { readonly runId: string; readonly running: number; readonly limit: number; readonly since: number } | null {
    const waiting = this.waitingForSlot.get(id);
    return waiting === undefined ? null : { runId: waiting.runId, running: this.workers.size, limit: this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS, since: waiting.since };
  }
  /** The conversation that held the workspace of each of this conversation's Turns this owner ended with WORKSPACE_BUSY. */
  busyHolderOf(run: string): SessionId | null { return this.busyHolders.get(run) ?? null; }
  /** One conversation's work in order: its native fork, then a switch or its next Turn, until none is left (ADR-036). */
  private async serve(id: SessionId): Promise<void> {
    for (;;) {
      this.work.delete(id);
      // Kept processes being closed go first, so a Turn or switch never meets a lease that is about to be released.
      await this.settleReleases();
      if (this.fatal) { this.work.clear(); return; }
      let state = this.load(id);
      if ((state.status !== "open" && !(state.status === "blocked" && this.recoverySwitch(state))) || this.closingSessions.has(id) || !this.accepting) return;
      try {
        // A branch's native fork runs before any of its inputs, in the same order as its Turns.
        if (state.nativeBindings?.some(binding => binding.status === "fork-pending")) { await this.forkNative(id); state = this.load(id); }
        if (state.pendingSwitchId !== null) {
          const pending = state.switches.find(sw => sw.id === state.pendingSwitchId)!;
          const beforeSwitch = state.runs.find(run => run.status === "queued" && state.messages.some(message => message.id === run.userMessageId && message.seq < pending.requestedSeq));
          if (beforeSwitch) await this.execute(id, beforeSwitch.id);
          else await this.applySwitch(id, state.pendingSwitchId);
        }
        else {
          const queued = state.runs.find(run => run.status === "queued");
          if (queued) await this.execute(id, queued.id);
        }
      } catch (error) { this.fail(error, id); }
      const after = this.load(id);
      const more = after.status === "open" && (after.pendingSwitchId !== null || after.runs.some(run => run.status === "queued")) && !this.closingSessions.has(id) && this.accepting && !this.fatal;
      if (!more && !this.work.has(id)) return;
      // Another conversation that waited for this workspace, or for a slot, with earlier work goes first (FIFO by acceptance).
      if (this.earlierWaiter(id)) { this.work.add(id); return; }
    }
  }

  private owned(execution: ActiveExecution): SessionSnapshot {
    this.store.assertOwner(); execution.binding?.assertOwned();
    const state = this.load(execution.sessionId);
    if (this.actives.get(execution.sessionId) !== execution || state.activeRunId !== execution.runId) throw new SessionError("OWNERSHIP_LOST", "active Run ownership changed");
    const run = state.runs.find(run => run.id === execution.runId);
    if (!run || run.epoch !== state.epoch || JSON.stringify(run.selection) !== JSON.stringify(state.selection))
      throw new SessionError("OWNERSHIP_LOST", "active Run epoch or selection no longer belongs to its Session");
    return state;
  }
  private continue(execution: ActiveExecution): PublicRun {
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
    if (this.fatal) throw this.fatal;
    if (run.cancelRequested || !this.accepting || this.closingSessions.has(state.id)) throw new SessionError("CANCELLED", "Run cancelled before dispatch");
    if (run.epoch !== state.epoch || JSON.stringify(run.selection) !== JSON.stringify(state.selection))
      throw new SessionError("OWNERSHIP_LOST", "Run selection changed after authorization");
    return run;
  }
  private stop(execution: ActiveExecution): void {
    // What the program streamed before the stop is committed first, so the stop request never precedes it in the log (ADR-047).
    this.flushStreamQuietly(execution);
    // A program that has not settled once the stop grace has passed is ended; its Turn is then unknown (ADR-036).
    if (execution.grace === null && !execution.backendSettled) {
      execution.grace = setTimeout(() => {
        if (execution.backendSettled || execution.binding === null) return;
        execution.earlyClose ??= execution.binding.close(); void execution.earlyClose.catch(() => {});
      }, this.options.stopGraceMs ?? STOP_GRACE_MS);
      execution.grace.unref?.();
    }
    if (execution.stop !== null) return;
    if (execution.backendSettled) {
      if (execution.binding) {
        execution.earlyClose ??= execution.binding.close();
        void execution.earlyClose.catch(() => {});
      }
      return;
    }
    if (execution.run) {
      execution.stop = (async () => {
        try {
          await execution.run!.requestStop();
          this.owned(execution);
          this.commit(execution.sessionId, state => ({ next: updatedRun(state, execution.runId, { stopRequested: true }),
            events: [event("run.stop_requested", { runId: execution.runId, backendSettled: execution.backendSettled })] }));
        } catch (error) {
          if (!execution.backendSettled) {
            execution.earlyClose ??= execution.binding?.close() ?? null;
            if (execution.earlyClose) await execution.earlyClose;
          }
          // The backend may settle before requestStop acquires its native identity. Settlement remains authoritative.
          if (!execution.backendSettled) throw error;
        }
      })();
      void execution.stop.catch(() => {});
    } else if (execution.binding) {
      execution.earlyClose ??= execution.binding.close();
      void execution.earlyClose.catch(() => {});
    }
  }

  /** Runs the Turn's current budget: the execution budget while it works, the wait budget while it waits for the user (ADR-036). */
  private armBudget(execution: ActiveExecution): void {
    const budget = execution.budget;
    if (budget.timer !== null) clearTimeout(budget.timer);
    const waiting = budget.waiting;
    budget.timer = setTimeout(() => this.expire(execution, waiting ? "wait" : "execution"), Math.max(0, waiting ? budget.waitLeftMs : budget.executionLeftMs));
    budget.timer.unref?.();
  }
  /** The Turn waits for the user from now (if it did not already); returns how long it may still wait. */
  private enterWait(execution: ActiveExecution, run: string): number {
    const budget = execution.budget, now = performance.now();
    if (budget.waiting) return Math.max(0, budget.waitLeftMs - (now - budget.since));
    budget.executionLeftMs -= now - budget.since; budget.waiting = true; budget.since = now;
    if (execution.stopReason === null) this.armBudget(execution);
    this.commit(execution.sessionId, current => ({ next: current, events: [event("run.waiting", { runId: run, kind: "user" })] }));
    return Math.max(0, budget.waitLeftMs);
  }
  /** Back to work once no request of this Turn waits for the user any longer. */
  private leaveWait(execution: ActiveExecution): void {
    const budget = execution.budget;
    if (!budget.waiting || [...this.permissions.values()].some(value => value.execution === execution && !value.request.decided)) return;
    const now = performance.now(), waitedMs = now - budget.since;
    budget.waitLeftMs -= waitedMs; budget.waiting = false; budget.since = now;
    if (execution.stopReason === null && !execution.backendSettled) this.armBudget(execution);
    try { this.commit(execution.sessionId, current => ({ next: current, events: [event("run.waiting_ended", { runId: execution.runId, kind: "user", waitedMs: Math.round(waitedMs) })] })); }
    catch (error) { this.fail(error, execution.sessionId); }
  }
  /**
   * A budget ran out (ADR-036): requests still waiting expire first (the program gets the stop's cancellation, never an
   * approval), the conversation says why, and the Turn is stopped with the normal stop chain.
   */
  private expire(execution: ActiveExecution, kind: "execution" | "wait"): void {
    if (execution.stopReason !== null || execution.backendSettled || this.actives.get(execution.sessionId) !== execution) return;
    execution.stopReason = kind === "wait" ? "WAIT_EXPIRED" : "RUN_TIMEOUT";
    // Text streamed before the budget ran out is committed first, so the expiry never precedes it in the log (ADR-047).
    this.flushStreamQuietly(execution);
    try {
      const waiting = [...this.permissions.entries()].filter(([, value]) => value.execution === execution && value.option === null).map(([permissionId]) => permissionId);
      for (const permissionId of waiting) this.permissions.delete(permissionId);
      const budgetMs = kind === "wait" ? this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS : this.options.executionBudgetMs ?? DEFAULT_EXECUTION_BUDGET_MS;
      this.commit(execution.sessionId, current => ({ next: withNotice(current, execution.runId, budgetNotice(kind, budgetMs)),
        events: [...waiting.map(permissionId => event("permission.closed", { permissionId, runId: execution.runId, reason: "expired" })), event("run.budget_expired", { runId: execution.runId, kind, budgetMs })] }));
      // The wait ends with its requests, so it is recorded like any other end of a wait.
      this.leaveWait(execution);
    } catch (error) { this.fail(error, execution.sessionId); }
    this.stop(execution);
  }

  /**
   * One native event of the Turn. Reply text and thinking are committed per window (ADR-047); everything else is committed
   * on arrival, after the window open before it, so the log keeps the order in which the program sent its events. A refused
   * commit is thrown to the driver, which ends the Turn with it.
   */
  private output(execution: ActiveExecution, value: ControlEvent): void {
    if (value.type === "text" || value.type === "thinking") { this.streamChunk(execution, value); return; }
    this.flushStream(execution);
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    if (VISIBLE_OUTPUT.has(value.type)) this.firstOutput(state, run);
    if (value.type === "permission_requested") {
      if (this.permissions.size >= 32) throw new SessionError("PERMISSION_LIMIT", "too many pending native permissions");
      // The Turn now waits for the user: its execution budget pauses and its wait budget runs (ADR-036). The request expires at
      // the earlier of the program's own deadline, as its driver says, and the end of the wait budget, on this clock (ADR-035).
      const requestedAt = this.options.now().getTime(), hubLeft = Math.round(this.enterWait(execution, run.id)), wait = value.expiresInMs;
      const native = value.expiresBy === "native" && wait !== undefined && Number.isSafeInteger(wait) && wait >= 0 && wait <= MAX_PERMISSION_WAIT_MS ? wait : null;
      const expires = native !== null && native <= hubLeft ? { expiresAt: requestedAt + native, expiresBy: "native" as const } : { expiresAt: requestedAt + hubLeft, expiresBy: "turn" as const };
      const id = "permission-" + this.options.id(), request: PermissionRequest = { id, runId: run.id, title: value.title, options: value.options, ...(value.detail===undefined?{}:{detail:value.detail}),...(value.input===undefined?{}:{input:value.input}), decided: false, requestedAt, ...expires, ...(value.kind === "question" ? { kind: "question" as const } : {}) };
      this.permissions.set(id, { request, nativeId: value.id, execution, option: null, command: null, harnessId: run.selection.harnessId });
      try { this.commit(state.id, current => ({ next: current, events: [event("permission.requested", { permissionId: id, runId: run.id, title: value.title, options: value.options, ...expires })] })); } catch (error) { this.permissions.delete(id); throw error; } return;
    }
    if (value.type === "permission") {
      // The Harness withdrew a question it had asked (for example its own dialog deadline): the public request closes too.
      const pending = [...this.permissions.entries()].find(([, item]) => item.execution === execution && item.nativeId === value.id && item.option === null);
      if (pending) {
        this.permissions.delete(pending[0]);
        this.commit(state.id, current => ({ next: current, events: [event("permission.closed", { permissionId: pending[0], runId: run.id, reason: value.decision })] }));
        this.leaveWait(execution);
        return;
      }
    }
    if (value.type === "output") { this.nativeOutput(execution, state, run, value.output); return; }
    if (value.type === "tool") {
      // The public summary keeps a bounded set of tools; a long native turn must not fail or block the Runtime because of it.
      const tools = [...(run.tools ?? [])], index = tools.findIndex(tool => tool.id === value.id);
      if (index < 0 && tools.length >= MAX_RUN_TOOLS) return;
      const detail = value.detail === undefined ? execution.details.get(value.id) : mergeDetail(execution.details.get(value.id), value.detail);
      if (value.detail !== undefined && detail !== undefined) { execution.details.set(value.id, detail); execution.dirty.add(value.id); }
      const prior = index < 0 ? undefined : tools[index];
      const tool = { id: value.id, title: value.title, status: value.status, ...(detail?.kind === undefined ? {} : { kind: detail.kind }), ...(detail?.name === undefined ? {} : { name: detail.name }),
        ...(detail?.parentId === undefined ? {} : { parentId: detail.parentId }), ...(detail?.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(prior?.detail === undefined ? {} : { detail: prior.detail }) };
      // Refinements that only change the private detail create no public fact until the detail is stored.
      if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(tool)) {
        if (index >= 0) tools[index] = tool; else tools.push(tool);
        this.commit(state.id, current => ({ next: updatedRun(current, run.id, { tools }), events: [event("run.output", { runId: run.id, event: logged(value) })] }));
      }
      if (TERMINAL_TOOL.has(value.status) && execution.dirty.has(value.id)) this.storeDetail(execution, value.id);
      return;
    }
    if (value.type === "notice" && (run.notices ?? []).length >= MAX_RUN_NOTICES) return;
    if (value.type === "activity" && !(run.activities ?? []).some(item => item.id === value.id) && (run.activities ?? []).length >= MAX_RUN_ACTIVITIES) return;
    this.commit(state.id, current => {
      let next = current;
      if (value.type === "plan") next = updatedRun(current, run.id, { plan: { entries: value.entries.slice(0, MAX_PLAN_ENTRIES).map(entry => ({ ...entry, content: bounded(entry.content, 4096).text || "…" })), ...(value.explanation ? { explanation: bounded(value.explanation, 4096).text } : {}) } });
      if (value.type === "usage") next = updatedRun(current, run.id, { usage: { ...run.usage, ...(value.usage.turn === undefined ? {} : { turn: { ...run.usage?.turn, ...value.usage.turn } }), ...(value.usage.context === undefined ? {} : { context: value.usage.context }), ...(value.usage.cost === undefined ? {} : { cost: value.usage.cost }) } satisfies NativeUsage });
      if (value.type === "notice") {
        // Harnesses restarted per Turn repeat their startup warnings; a notice already shown in this conversation stays in the log only.
        const notice = { severity: value.severity, title: bounded(value.title, 1024).text || "提示", ...(value.detail ? { detail: bounded(value.detail, 4096).text } : {}) }, same = JSON.stringify(notice);
        if (!current.runs.some(item => item.notices?.some(prior => JSON.stringify(prior) === same))) next = updatedRun(current, run.id, { notices: [...(run.notices ?? []), notice] });
      }
      if (value.type === "activity") {
        const activities = [...(run.activities ?? [])], index = activities.findIndex(item => item.id === value.id);
        const activity = { id: bounded(value.id, 512).text, kind: value.kind, title: bounded(value.title, 1024).text || value.kind, status: value.status, ...(value.detail ? { detail: bounded(value.detail, 4096).text } : {}) };
        if (index >= 0) activities[index] = activity; else activities.push(activity);
        next = updatedRun(current, run.id, { activities });
      }
      return { next, events: [event("run.output", { runId: run.id, event: logged(value) })] };
    });
  }
  /** Records the Run's first visible output at the clock's reading now, once, as its own committed fact (never held in a window). */
  private firstOutput(state: SessionSnapshot, run: PublicRun): void {
    if (run.timing === undefined || run.timing.firstOutputAt !== undefined) return;
    this.commit(state.id, current => ({ next: updatedRun(current, run.id, phase(current, run.id, "firstOutputAt", this.options.now().getTime())), events: [event("run.first_output", { runId: run.id })] }));
  }
  /**
   * A chunk of reply text or thinking joins the window open for its kind, or opens one (ADR-047); a window of the other
   * kind is committed first, so the log keeps their order. A window is committed when its timer runs out, when it holds
   * STREAM_WINDOW_BYTES, and before anything else of the Turn is committed. Ownership, the Run's status and its first output
   * are checked when a window opens, so at least once per window. The output budget is counted exactly per chunk: the chunk
   * that would exceed it commits the window before it and is refused, as it was refused on its own commit before.
   */
  private streamChunk(execution: ActiveExecution, value: Extract<ControlEvent, { type: "text" | "thinking" }>): void {
    const stream = execution.stream;
    if (stream.kind !== null && stream.kind !== value.type) this.flushStream(execution);
    let { committedBytes, bytes, last } = stream;
    if (stream.kind === null) {
      // A window opens on the Run's facts as committed: ownership, status, first output, and the bytes of its kind so far.
      const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
      if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
      this.firstOutput(state, run);
      const committed = value.type === "text" ? state.messages.find(message => message.id === run.assistantMessageId)?.text ?? "" : run.thinking ?? "";
      committedBytes = bytes = utf8Bytes(committed); last = committed.slice(-1);
    }
    const joined = joinedBytes(bytes, last, value.text);
    if (joined > MAX_OUTPUT_BYTES) {
      // A refused chunk opens no window (nothing empty is committed); what was open before it is committed first.
      this.flushStream(execution);
      throw new SessionError("OUTPUT_LIMIT", value.type === "text" ? "Run public output byte budget exhausted" : "native thinking exceeded its budget");
    }
    if (stream.kind === null) { stream.kind = value.type; stream.text = ""; stream.committedBytes = committedBytes; }
    stream.text += value.text; stream.bytes = joined; stream.last = value.text ? value.text.slice(-1) : last;
    if (stream.bytes - stream.committedBytes >= STREAM_WINDOW_BYTES) { this.flushStream(execution); return; }
    stream.cancel ??= this.timer(() => this.windowExpired(execution), STREAM_WINDOW_MS);
  }
  /**
   * Commits the open window as one run.output event of its kind, with the window's text (ADR-047); no open window is nothing
   * to do. The window is taken before the commit, so a refused commit loses that window only and never commits it twice;
   * ownership and the Run's running status are checked as for any output.
   */
  private flushStream(execution: ActiveExecution): void {
    const stream = execution.stream;
    if (stream.kind === null) return;
    const kind = stream.kind, text = stream.text;
    this.discardStream(execution);
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    this.commit(state.id, current => {
      let next: SessionSnapshot;
      if (kind === "thinking") {
        const thinking = (current.runs.find(item => item.id === run.id)?.thinking ?? "") + text;
        if (utf8Bytes(thinking) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "native thinking exceeded its budget");
        next = updatedRun(current, run.id, { thinking });
      } else {
        const message = current.messages.find(message => message.id === run.assistantMessageId), merged = (message?.text ?? "") + text;
        if (utf8Bytes(merged) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "Run public output byte budget exhausted");
        next = { ...current, messages: message ? current.messages.map(item => item.id === message.id ? { ...item, text: merged } : item)
          : [...current.messages, { id: run.assistantMessageId, runId: run.id, role: "assistant", text: merged, seq: current.lastSeq + 1, status: run.status }] };
      }
      return { next, events: [event("run.output", { runId: run.id, event: { type: kind, text } })] };
    });
  }
  /**
   * Commits the open window from outside a driver callback (its timer, a stop, a close): a refused commit is kept as the
   * Turn's failure instead of being thrown where nothing reports it. Whether the window was committed, or there was none.
   */
  private flushStreamQuietly(execution: ActiveExecution): boolean {
    try { this.flushStream(execution); return true; }
    catch (error) { execution.streamFailure ??= error; return false; }
  }
  /** Drops the open window and its timer; what it held is the caller's to commit or to lose with the Turn. */
  private discardStream(execution: ActiveExecution): void {
    const stream = execution.stream;
    stream.cancel?.(); stream.cancel = null; stream.kind = null; stream.text = "";
  }
  /** The window's timer ran out: a Turn that has ended holds nothing; a window refused here stops the Turn with its failure. */
  private windowExpired(execution: ActiveExecution): void {
    execution.stream.cancel = null;
    if (this.actives.get(execution.sessionId) !== execution) return;
    if (!this.flushStreamQuietly(execution)) this.stop(execution);
  }
  /** Runs `fn` once after `ms` through the injected scheduler, or a setTimeout kept from holding the process open; returns its cancel. */
  private timer(fn: () => void, ms: number): () => void {
    if (this.options.schedule !== undefined) return this.options.schedule(fn, ms);
    const handle = setTimeout(fn, ms); handle.unref?.();
    return () => clearTimeout(handle);
  }
  /** Stores one tool's latest bounded detail and publishes its reference. Storage trouble is reported, not hidden. */
  private storeDetail(execution: ActiveExecution, toolId: string): void {
    const content = this.options.content; if (content === undefined) return;
    this.enqueue(execution, async () => {
      const detail = execution.details.get(toolId); if (detail === undefined || !execution.dirty.delete(toolId)) return;
      const state = this.owned(execution);
      let ref;
      try { ref = await content.storeOutput({ workspace: state.configuration.workspace, name: "tool-" + safeName(toolId) + ".json", mediaType: "application/json", data: new TextEncoder().encode(JSON.stringify({ toolId, ...detail })) }); }
      catch (error) { this.commit(state.id, current => ({ next: current, events: [event("run.output", { runId: execution.runId, event: { type: "diagnostic", message: "tool detail was not stored (" + fault(error).code + ")" } })] })); return; }
      const after = this.owned(execution), run = after.runs.find(row => row.id === execution.runId)!;
      if (!run.tools?.some(tool => tool.id === toolId)) return;
      this.commit(after.id, current => ({ next: updatedRun(current, run.id, { tools: run.tools!.map(tool => tool.id === toolId ? { ...tool, detail: ref } : tool) }), events: [event("run.tool_detail", { runId: run.id, toolId, content: ref })] }));
    });
  }
  /** Non-text native output: links are recorded as given; bytes go to the content owner first. */
  private nativeOutput(execution: ActiveExecution, state: SessionSnapshot, run: PublicRun, output: Extract<ControlEvent, { type: "output" }>["output"]): void {
    if ((run.outputs ?? []).length >= MAX_RUN_OUTPUTS) return;
    if (output.kind === "link") {
      this.commit(state.id, current => ({ next: updatedRun(current, run.id, { outputs: [...(run.outputs ?? []), { kind: "link", uri: bounded(output.uri, 4096).text, name: bounded(output.name, 1024).text || "链接", ...(output.title ? { title: bounded(output.title, 1024).text } : {}), ...(output.mediaType ? { mediaType: output.mediaType.slice(0, 255) } : {}) }] }),
        events: [event("run.output", { runId: run.id, event: logged({ type: "output", output }) })] }));
      return;
    }
    const content = this.options.content;
    if (content === undefined) { this.commit(state.id, current => ({ next: current, events: [event("run.output", { runId: run.id, event: { type: "diagnostic", message: "native " + output.mediaType + " output was not kept (no content storage)" } })] })); return; }
    this.enqueue(execution, async () => {
      let ref;
      try { ref = await content.storeOutput({ workspace: state.configuration.workspace, name: output.name, mediaType: output.mediaType, data: output.data }); }
      catch (error) { const owned = this.owned(execution); this.commit(owned.id, current => ({ next: current, events: [event("run.output", { runId: run.id, event: { type: "diagnostic", message: "native output was not stored (" + fault(error).code + ")" } })] })); return; }
      const after = this.owned(execution), current = after.runs.find(row => row.id === execution.runId)!;
      if ((current.outputs ?? []).length >= MAX_RUN_OUTPUTS) return;
      this.commit(after.id, snapshot => ({ next: updatedRun(snapshot, current.id, { outputs: [...(current.outputs ?? []), { kind: "content", content: ref }] }), events: [event("run.output", { runId: current.id, event: logged({ type: "output", output }) })] }));
    });
  }
  /** Keeps the write chain alive; an ownership or Store failure is retained for the Turn owner to report. */
  private enqueue(execution: ActiveExecution, job: () => Promise<void>): void {
    execution.writes = execution.writes.then(job).catch((error: unknown) => { execution.writeFailure ??= error; });
  }
  /** Drains this Turn's content writes while its binding is still owned; called before cleanup. */
  private async flushNative(execution: ActiveExecution): Promise<void> {
    for (const toolId of [...execution.dirty]) this.storeDetail(execution, toolId);
    await execution.writes;
    if (execution.writeFailure !== null) throw execution.writeFailure;
  }

  private async execute(id: SessionId, target: PublicRun["id"]): Promise<void> {
    const state = this.load(id), queued = state.runs.find(run => run.id === target);
    if (!queued || queued.status !== "queued") return;
    const waitedSwitch = queued.awaitingSwitchId === null ? null : state.switches.find(sw => sw.id === queued.awaitingSwitchId);
    if (queued.awaitingSwitchId !== null && !waitedSwitch) throw new SessionError("INVALID_DATA", "queued Run refers to an unknown switch");
    if (waitedSwitch?.status === "failed") {
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE", message: "requested Harness switch failed; this input was not dispatched" }, ...phase(current, target, "endedAt", this.options.now().getTime()) }),
        events: [event("run.ended", { runId: target, status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE" }, neverDispatched: true })] }));
      return;
    }
    if (waitedSwitch && waitedSwitch.status !== "effective") return;
    const pinned = waitedSwitch?.target ?? queued.selection;
    const execution: ActiveExecution = { sessionId: id, runId: target, binding: null, run: null, dispatched: false,
      backendSettled: false, stop: null, earlyClose: null, details: new Map(), dirty: new Set(), writes: Promise.resolve(), writeFailure: null, diagnosticMark: null,
      budget: { executionLeftMs: this.options.executionBudgetMs ?? DEFAULT_EXECUTION_BUDGET_MS, waitLeftMs: (this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS) - (this.waitUsed.get(target) ?? 0),
        waiting: false, since: performance.now(), timer: null }, stopReason: null, grace: null,
      stream: { kind: null, text: "", committedBytes: 0, bytes: 0, last: "", cancel: null }, streamFailure: null };
    if (this.actives.has(id)) throw new SessionError("OWNERSHIP_LOST", "another Turn of this conversation is active");
    this.actives.set(id, execution); this.waitUsed.delete(target);
    // The execution budget runs from here: starting the program, its model, tools and result (ADR-036).
    this.armBudget(execution);
    let backend: BackendResult | null = null, cleanup: CleanupEvidence | null = null, problem: ReturnType<typeof fault> | null = null;
    let checkpoint: string | null = null, checkpointStored = false, nativeConfirmed = false;
    let previousNative: NativeSessionBinding | undefined;
    // What the native session reported after this Turn; `reported` means the binding's earlier report is replaced (ADR-028).
    let observed: NativeConfiguration | undefined, reported = false;
    // The process the conversation kept and this Turn reuses (ADR-030); null when the Turn starts the program itself.
    let reusing: KeptProcess | null = null, opened: NativeConversationId | null = null;
    try {
      this.commit(id, current => ({ next: { ...updatedRun(current, target, { status: "preparing", selection: pinned, epoch: waitedSwitch ? current.epoch : queued.epoch, ...phase(current, target, "preparingAt", this.options.now().getTime()) }), activeRunId: target },
        events: [event("run.preparing", { runId: target, selection: state.selection, epoch: state.epoch })] }));
      let current = this.owned(execution), run = this.continue(execution), context = buildPublicContext(current, run);
      previousNative = run.selection.provider === undefined ? current.nativeBindings?.find(binding => binding.harnessId === run.selection.harnessId && binding.controlId === run.selection.controlId && binding.status !== "archived") : undefined;
      if (previousNative !== undefined && previousNative.status !== "ready") throw new SessionError("NATIVE_STATE_UNCONFIRMED", "原生会话状态尚未确认；可以切换其他 Harness，或明确建立新的原生分支。公共历史会保留。");
      if (previousNative !== undefined) {
        const through = previousNative.throughRunId === null ? -1 : current.runs.findIndex(run => run.id === previousNative!.throughRunId);
        context = buildPublicContext(current, run, context.sourceRunIds.filter(id => current.runs.findIndex(run => run.id === id) > through));
      }
      this.commit(id, current => ({ next: updatedRun(current, target, { contextThroughSeq: context.throughSeq, sourceRunIds: context.sourceRunIds }),
        events: [event("run.context_prepared", { runId: target, throughSeq: context.throughSeq, sourceRunIds: context.sourceRunIds, continuity: context.continuity })] }));
      // A process the conversation kept takes the Turn when it still runs this selection; any other kept process is closed
      // first and the Turn starts the program as usual (ADR-030).
      reusing = run.selection.provider === undefined ? await this.takeKept(id, run.selection) : null;
      let native: NativeConversationId;
      if (reusing !== null) {
        const kept = reusing, now = this.options.now().getTime();
        execution.binding = kept.binding; native = kept.conversation; execution.diagnosticMark = kept.binding.control.diagnosticMark?.() ?? null;
        this.commit(id, current => {
          const { retained, ...rest } = current;
          return { next: updatedRun(rest, target, { reused: true }), events: [event("native.process_reused", { runId: target, previousRunId: kept.runId, idleMs: Math.max(0, now - kept.lastUsed), backgroundUpdates: this.background(kept) })] };
        });
        this.continue(execution);
      } else {
        try { execution.binding = await this.factory.prepare(run.selection, current.configuration, id, target); execution.diagnosticMark = execution.binding.control.diagnosticMark?.() ?? null; }
        catch (error) {
          // Another conversation's kept process holds the workspace: the user decides whether to end it (ADR-030, option C).
          if (error instanceof SessionError && error.code === "WORKSPACE_BUSY" && [...this.kept].some(([holder, kept]) => holder !== id && kept.binding.workspace === current.configuration.workspace))
            throw new SessionError("WORKSPACE_KEPT", "another conversation keeps a native process in this workspace");
          throw error;
        }
        this.continue(execution);
        if (execution.binding.installation !== undefined) {
          const installation = execution.binding.installation;
          this.commit(id, current => ({ next: current, events: [event("run.installation_resolved", { runId: target, installation })] }));
        }
        const observation = await execution.binding.control.initialize(); this.continue(execution);
        this.commit(id, current => ({ next: current, events: [event("run.protocol", { runId: target, observation })] }));
        // A requested value the native session changed itself is applied as it is now instead of being reverted (ADR-028).
        const carried = carriedNativeConfiguration(current, run.selection, run.epoch);
        if (carried !== null) this.commit(id, current => ({ next: current, events: [event("native.config_carried", { runId: target, ...carried })] }));
        const nativeOptions = carried?.options === undefined ? run.selection.nativeOptions : { ...run.selection.nativeOptions, ...carried.options };
        native = await execution.binding.control.open(execution.binding.workspace, carried?.model ?? run.selection.nativeModel, nativeOptions, previousNative?.checkpoint); this.continue(execution);
      }
      opened = native;
      if (run.selection.provider === undefined && execution.binding.control.checkpoint) {
        checkpoint = await execution.binding.control.checkpoint(); this.continue(execution);
        if (checkpoint !== null && (typeof checkpoint !== "string" || !checkpoint || Buffer.byteLength(checkpoint) > 8192 || /[\0\r\n]/u.test(checkpoint))) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "invalid original Harness recovery reference");
        if (previousNative !== undefined && checkpoint === null) throw new SessionError("NATIVE_RESUME_UNAVAILABLE", "original Harness cannot confirm its recovered state; no replacement session was dispatched");
        if (checkpoint !== null) {
          const reference: NativeSessionBinding = { harnessId: run.selection.harnessId, controlId: run.selection.controlId, checkpoint, throughRunId: previousNative?.throughRunId ?? null, status: "unconfirmed",
            ...(previousNative?.observed === undefined ? {} : { observed: previousNative.observed }) };
          this.commit(id, current => ({ next: { ...current, nativeBindings: previousNative === undefined ? [...(current.nativeBindings ?? []), reference] : current.nativeBindings?.map(binding => binding.harnessId === reference.harnessId && binding.controlId === reference.controlId && binding.status !== "archived" ? reference : binding) ?? [reference] },
            events: [event("native.binding_prepared", { runId: target, harnessId: reference.harnessId, controlId: reference.controlId, resumed: previousNative !== undefined })] }));
          checkpointStored = true;
        }
      }
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "running", ...phase(current, target, "readyAt", this.options.now().getTime()) }), events: [event("run.authorized", { runId: target, epoch: run.epoch })] }));
      this.continue(execution);
      execution.binding.control.enablePermissions?.();
      let input = previousNative !== undefined && context.sourceRunIds.length === 0 ? run.input : context.text;
      if (run.input.startsWith("/") && execution.binding.control.models) {
        const catalog = await execution.binding.control.models(); const name = run.input.slice(1).split(/\s/u)[0];
        this.continue(execution);
        if (catalog.commands?.some(command => command.name === name)) { input = run.input; this.commit(id, current => ({ next: current, events: [event("run.native_command", { runId: target, name, publicContextInjected: false })] })); }
      }
      this.continue(execution);
      // Attachments are checked against the opened agent/model and copied before dispatch, so a refusal fails this input cleanly.
      let files: readonly ControlAttachment[] = [];
      if (run.attachments?.length) {
        const control = execution.binding.control, content = this.options.content;
        if (!control.checkAttachments) throw new SessionError("ATTACHMENT_UNSUPPORTED", "this Harness interface does not accept attachments");
        if (content === undefined) throw new SessionError("ATTACHMENT_UNAVAILABLE", "this Gateway has no content storage for attachments");
        try { await control.checkAttachments(run.attachments); }
        catch (error) {
          // These two refusals are written by the Driver itself (no native text) and name only the attachment.
          const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
          if ((code === "ATTACHMENT_UNSUPPORTED" || code === "ATTACHMENT_LIMIT") && error instanceof Error) throw new SessionError(code, error.message.slice(0, 512));
          throw error;
        }
        this.continue(execution);
        files = await content.materialize(run.attachments); this.continue(execution);
      }
      this.commit(id, current => ({ next: updatedRun(current, target, phase(current, target, "dispatchedAt", this.options.now().getTime())), events: [event("run.dispatched", { runId: target })] }));
      execution.dispatched = true;
      execution.run = await execution.binding.control.startText(native, input, value => this.output(execution, value), ...(files.length ? [files] : []));
      this.owned(execution);
      void execution.run.result.then(() => { execution.backendSettled = true; }, () => { execution.backendSettled = true; });
      if (this.load(id).runs.find(run => run.id === target)!.cancelRequested || !this.accepting || this.fatal || this.closingSessions.has(id)) this.stop(execution);
      backend = await execution.run.result; execution.backendSettled = true;
      this.owned(execution);
      // Text still in its window is committed before the settlement, so the reply precedes run.backend_settled (ADR-047).
      this.flushStream(execution);
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "settling", backend }), events: [event("run.backend_settled", { runId: target, backend })] }));
      if (checkpointStored) {
        const after = await execution.binding.control.checkpoint!(); this.owned(execution);
        if (after === null || typeof after !== "string" || !after || Buffer.byteLength(after) > 8192 || /[\0\r\n]/u.test(after)) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "original Harness lost its owned session reference");
        checkpoint = after; nativeConfirmed = true;
        reported = true;
        if (execution.binding.control.nativeConfig) {
          // Unreadable or invalid reports leave the configuration unknown; the next Turn then applies the selection as requested.
          // A Turn that told nothing about the native values leaves the earlier report standing.
          try { const report = await execution.binding.control.nativeConfig(); if (report === null) reported = false; else observed = parseNativeConfiguration(report); }
          catch (error) { observed = undefined; const code = fault(error).code; this.commit(id, current => ({ next: current, events: [event("native.config_unreadable", { runId: target, code })] })); }
          this.owned(execution);
        }
      }
    } catch (error) { problem = fault(error); }
    finally {
      // A window still open is committed before the Turn's end (ADR-047). Once the program was ended early its lease is gone,
      // so the window goes with the Turn, which is unknown then; a window refused outside a driver callback is the Turn's failure.
      if (execution.earlyClose === null) { try { this.flushStream(execution); } catch (error) { problem ??= fault(error); } }
      else this.discardStream(execution);
      if (execution.streamFailure !== null) problem ??= fault(execution.streamFailure);
      const abandoned = [...this.permissions.entries()].filter(([, permission]) => permission.execution === execution);
      for (const [permissionId] of abandoned) this.permissions.delete(permissionId);
      if (abandoned.length) this.commit(id, current => ({ next: current, events: abandoned.map(([permissionId]) => event("permission.closed", { permissionId, runId: target })) }));
      if (execution.stop) {
        try { await execution.stop; } catch (error) { problem ??= fault(error); }
      }
      if (execution.binding && execution.earlyClose === null) {
        try { await this.flushNative(execution); } catch (error) { problem ??= fault(error); }
      }
      // A finished Turn of a conversation that keeps its process hands the process over instead of closing it (ADR-030).
      const keep = execution.binding === null || opened === null ? { keep: false } : this.keepable(id, execution, backend, problem, checkpointStored && nativeConfirmed);
      if (execution.binding && !keep.keep) {
        try { execution.earlyClose ??= execution.binding.close(); cleanup = await execution.earlyClose; }
        catch (error) { problem = fault(error); }
      }
      // What the program logged during this Turn, kept privately in memory for the user's diagnostics (redacted on the way out).
      if (execution.binding && execution.diagnosticMark !== null) this.keepDiagnostics(id, target, execution.binding.control.diagnosticsSince?.(execution.diagnosticMark) ?? "");
      let handed = false;
      const endedAt = this.options.now().getTime(), idleMs = this.options.keptIdleMs ?? KEPT_IDLE_MS;
      // The group's identity lets a later owner recognize and end it if this owner ends without closing it.
      let identity = reusing?.identity;
      if (keep.keep && identity === undefined && execution.binding !== null && this.options.processes !== undefined) {
        const group = execution.binding.control.processGroup?.() ?? null;
        const startedAt = group === null ? null : await this.options.processes.identify(group).catch(() => null);
        if (group !== null && startedAt !== null) identity = { group, startedAt };
      }
      // Registered before the hand-over is committed, so the view published with that commit already shows the kept process.
      if (keep.keep && execution.binding !== null && opened !== null) {
        const binding = execution.binding, timer = setTimeout(() => { void this.requestRelease(id, "idle"); }, idleMs); timer.unref?.();
        this.kept.set(id, { binding, selection: pinned, conversation: opened, runId: target, since: reusing?.since ?? endedAt, baseline: binding.control.unattributedUpdates ?? 0, lastUsed: endedAt, timer,
          ...(identity === undefined ? {} : { identity }) });
      }
      try {
        this.store.assertOwner();
        const current = this.load(id), run = current.runs.find(run => run.id === target)!;
        const unsafe = (execution.dispatched && backend === null) || (execution.binding !== null && cleanup === null && !keep.keep) || this.fatal !== null || this.unknownOwnership(problem);
        // A Turn the Runtime stopped on its own (a budget ran out before it settled) is cancelled when it then settled, whatever
        // it reported, and unknown when it had to be ended.
        const stopped = execution.stopReason !== null;
        const failure = stopped ? { code: execution.stopReason!, message: execution.stopReason === "WAIT_EXPIRED" ? "the wait for the user's decision ran out" : "the Turn's execution budget ran out" }
          : problem ?? cleanup?.protocolFailure ?? backend?.error ?? null;
        const status = unsafe ? "unknown" : run.cancelRequested || problem?.code === "CANCELLED" || stopped ? "cancelled" : failure ? "failed" : backend?.status ?? "failed";
        this.commit(id, current => {
          let next: SessionSnapshot = { ...updatedRun(current, target, { status, backend, cleanup,
            error: failure, ...phase(current, target, "endedAt", endedAt), ...(keep.keep ? { retained: true as const } : {}) }), activeRunId: null, status: unsafe ? "blocked" : current.status,
            ...(keep.keep ? { retained: { harnessId: pinned.harnessId, controlId: pinned.controlId, runId: target, since: reusing?.since ?? endedAt, ...(identity === undefined ? {} : { process: identity }) } } : {}) };
          if (checkpointStored && checkpoint !== null && (keep.keep || cleanup?.closed === true && cleanup.protocolFailure === null) && (!execution.dispatched || nativeConfirmed && backend !== null)) {
            next = { ...next, nativeBindings: next.nativeBindings?.map(binding => {
              if (binding.harnessId !== pinned.harnessId || binding.controlId !== pinned.controlId || binding.status === "archived") return binding;
              const { observed: earlier, ...rest } = binding, latest = reported ? observed : earlier;
              return { ...rest, checkpoint: checkpoint!, status: "ready" as const, throughRunId: execution.dispatched ? run.id : binding.throughRunId, ...(latest === undefined ? {} : { observed: latest }) };
            }) ?? [] };
          }
          const cancelSwitch = (!this.accepting || this.closingSessions.has(id)) && next.pendingSwitchId !== null;
          if (cancelSwitch) next = this.cancelPending(next);
          return { next, events: [event("run.ended", { runId: target, status, backend, cleanup, error: failure }),
            ...(keep.keep ? [event("native.process_retained", { runId: target, idleEndsAt: endedAt + idleMs })] : keep.skipped ? [event("native.retention_skipped", { runId: target, reason: keep.skipped })] : []),
            ...(cancelSwitch ? [event("switch.failed", { switchId: current.pendingSwitchId, reason: "cancelled by close" })] : []),
            ...(unsafe ? [event("session.blocked", { runId: target, reason: "execution or cleanup could not be safely confirmed" })] : [])] };
        });
        handed = keep.keep;
      } catch (error) { this.fail(error); }
      if (keep.keep && !handed) {
        // The hand-over was not recorded, so the process is not kept: it is closed like any other Turn's.
        const unrecorded = this.kept.get(id);
        if (unrecorded !== undefined) { this.kept.delete(id); clearTimeout(unrecorded.timer); }
        if (execution.binding !== null) try { await execution.binding.close(); } catch (error) { this.fail(error, id); }
      }
      if (this.actives.get(id) === execution) this.actives.delete(id);
      if (execution.budget.timer !== null) clearTimeout(execution.budget.timer);
      if (execution.grace !== null) clearTimeout(execution.grace);
      this.discardStream(execution);
    }
  }

  /**
   * Performs a branch's pending native fork with its own connection. The binding is marked `forking` before the request;
   * a clean refusal archives it (the branch continues from public history), a result that cannot be confirmed leaves it
   * `forking`, which blocks native use until the user explicitly rebuilds the native session.
   */
  private async forkNative(id: SessionId): Promise<void> {
    const state = this.load(id), pending = state.nativeBindings?.find(binding => binding.status === "fork-pending");
    if (!pending) return;
    const owns = (binding: NativeSessionBinding) => binding.harnessId === pending.harnessId && binding.controlId === pending.controlId && binding.status !== "archived";
    let binding: PreparedSessionBinding | null = null, problem: ReturnType<typeof fault> | null = null, forked: string | null = null, dispatched = false, cleanup: CleanupEvidence | null = null;
    try {
      binding = await this.factory.prepare(state.selection, state.configuration, id, "fork-" + this.options.id());
      await binding.control.initialize();
      if (!binding.control.fork) throw new SessionError("NATIVE_FORK_UNAVAILABLE", "this Harness interface cannot branch its native session");
      this.commit(id, current => ({ next: { ...current, nativeBindings: current.nativeBindings!.map(item => owns(item) ? { ...item, status: "forking" as const } : item) },
        events: [event("native.fork_dispatched", { harnessId: pending.harnessId, controlId: pending.controlId })] }));
      dispatched = true;
      const reference = await binding.control.fork(pending.checkpoint, binding.workspace);
      if (typeof reference !== "string" || !reference || Buffer.byteLength(reference) > 8192 || /[\0\r\n]/u.test(reference) || reference === pending.checkpoint) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "the Harness returned an invalid branch reference");
      forked = reference;
    } catch (error) { problem = fault(error); }
    finally { if (binding) { try { cleanup = await binding.close(); } catch (error) { problem ??= fault(error); } } }
    const refused = problem !== null && ["NATIVE_FORK_UNAVAILABLE", "UNSUPPORTED_CONTROL", "HARNESS_UNAVAILABLE", "CONTROL_UNAVAILABLE", "NATIVE_AUTH_REQUIRED"].includes(problem.code);
    const confirmed = forked !== null && cleanup?.closed === true && cleanup.protocolFailure === null;
    this.commit(id, current => {
      if (confirmed) return { next: { ...current, nativeBindings: current.nativeBindings!.map(item => owns(item) ? { ...item, checkpoint: forked!, status: "ready" as const } : item) },
        events: [event("native.forked", { harnessId: pending.harnessId, controlId: pending.controlId, cleanup })] };
      if (!dispatched || refused) return { next: { ...current, nativeBindings: current.nativeBindings!.map(item => owns(item) ? { ...item, status: "archived" as const } : item) },
        events: [event("native.fork_failed", { harnessId: pending.harnessId, controlId: pending.controlId, error: problem, continuity: "public_context_rehydrate" })] };
      return { next: current, events: [event("native.fork_unknown", { harnessId: pending.harnessId, controlId: pending.controlId, error: problem, cleanup })] };
    });
  }

  private async applySwitch(id: SessionId, targetId: string): Promise<void> {
    let binding: PreparedSessionBinding | null = null, cleanup: CleanupEvidence | null = null;
    let problem: ReturnType<typeof fault> | null = null;
    const initial = this.load(id), pending = initial.switches.find(sw => sw.id === targetId);
    const recovery = this.recoverySwitch(initial);
    if (!pending || initial.pendingSwitchId !== targetId || initial.activeRunId !== null) return;
    try {
      const request = pending.requested.provider === undefined && initial.selection.provider !== undefined
        ? { ...pending.requested, provider: initial.selection.provider } : pending.requested;
      const target = await this.factory.validate(request, initial.configuration);
      // A kept process runs the previous selection; it is closed before the switch takes effect (ADR-030).
      const kept = this.kept.get(id);
      if (kept !== undefined && !sameSelection(kept.selection, target)) await this.release(id, "selection_changed");
      this.store.assertOwner(); let current = this.load(id);
      if (current.pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting) return;
      const sources = current.runs.filter(run => terminal(run.status) && current.messages.some(message => message.id === run.userMessageId && message.seq < pending.requestedSeq)).map(run => run.id);
      const context = buildPublicContext(current, undefined, sources);
      this.commit(id, current => ({ next: { ...current, switches: current.switches.map(sw => sw.id === targetId
        ? { ...sw, target, status: "validated", throughSeq: context.throughSeq, sourceRunIds: context.sourceRunIds } : sw) },
        events: [event("switch.validated", { switchId: targetId, target, throughSeq: context.throughSeq, sourceRunIds: context.sourceRunIds, continuity: context.continuity })] }));
      if (recovery) {
      binding = await this.factory.prepare(target, initial.configuration, id, targetId);
      this.switchBindings.set(id, { binding, close: null });
      this.store.assertOwner(); binding.assertOwned();
      current = this.load(id);
      if (current.pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting || this.fatal) throw new SessionError("CANCELLED", "switch cancelled before target initialization");
      await binding.control.initialize(); this.store.assertOwner(); binding.assertOwned();
      if (this.load(id).pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting || this.fatal) throw new SessionError("CANCELLED", "switch cancelled before target conversation");
      await binding.control.open(binding.workspace, target.nativeModel, target.nativeOptions); this.store.assertOwner(); binding.assertOwned();
      }
    } catch (error) { problem = fault(error); }
    finally {
      if (binding) {
        try { cleanup = await (this.switchBindings.get(id)?.close ?? binding.close()); } catch (error) { problem = fault(error); }
      }
      this.switchBindings.delete(id);
    }
    const current = this.load(id);
    if (current.pendingSwitchId !== targetId) return;
    const unsafe = (binding !== null && cleanup === null) || this.fatal !== null || this.unknownOwnership(problem);
    if (problem || cleanup?.protocolFailure || unsafe || this.closingSessions.has(id) || !this.accepting) {
      const error = problem ?? cleanup?.protocolFailure ?? { code: "CANCELLED", message: "switch cancelled before activation" };
      this.commit(id, state => ({ next: { ...state, pendingSwitchId: null, status: unsafe ? "blocked" : state.status,
        switches: state.switches.map(sw => sw.id === targetId ? { ...sw, status: "failed", error } : sw) },
        events: [event("switch.failed", { switchId: targetId, error, cleanup }), ...(unsafe ? [event("session.blocked", { switchId: targetId })] : [])] }));
      return;
    }
    const target = current.switches.find(sw => sw.id === targetId)!.target;
    if (target === null) throw new SessionError("INVALID_DATA", "validated switch has no target");
    this.commit(id, state => ({ next: { ...state, pendingSwitchId: null, selection: target, epoch: state.epoch + 1, ...(recovery ? { status: "open" as const } : {}),
      switches: state.switches.map(sw => sw.id === targetId ? { ...sw, status: "effective", throughSeq: state.lastSeq } : sw) },
      events: [event("switch.effective", { switchId: targetId, target, epoch: state.epoch + 1, throughSeq: state.lastSeq,
        sourceRunIds: state.switches.find(sw => sw.id === targetId)!.sourceRunIds, cleanup, continuity: "public_context_rehydrate", ...(recovery ? { recovered: true } : {}) })] }));
  }
  private unknownOwnership(problem: ReturnType<typeof fault> | null): boolean {
    return problem !== null && ["OWNER_LOST", "OWNERSHIP_LOST", "WORKSPACE_OWNERSHIP_LOST", "BINDING_CLEANUP_FAILED", "CLEANUP_FAILED", "WORKSPACE_QUARANTINED"].includes(problem.code);
  }
}
