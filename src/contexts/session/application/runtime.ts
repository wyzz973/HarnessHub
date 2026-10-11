import { parseProviderTarget } from "../../../contracts/provider.js";
import { TOOL_DIFF_BYTES, TOOL_INPUT_BYTES, TOOL_OUTPUT_BYTES, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlRun, type NativeConversationId, type NativeToolDetail, type NativeUsage } from "../../../contracts/control.js";
import { MAX_RUN_ATTACHMENTS, MAX_RUN_OUTPUTS, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId,
  type AttentionItem, type ForkedMessage, type HarnessSelection, type KeptProcessIdentity, type NativeConfiguration, type NativeSessionBinding, type PermissionRequest, type CancelReceipt, type CommandId, type EventDraft, type PreparedSessionBinding, type PublicNotice, type PublicRun, type RunTiming,
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
type KeptRelease = "idle" | "disabled" | "ended_by_user" | "selection_changed" | "conversation_closed" | "native_reset" | "branched" | "exited" | "gateway_shutdown";
/** At most this many processes are kept at once (ADR-030). */
const KEPT_LIMIT = 4;
/** A kept process without a Turn for this long is closed (ADR-030). */
export const KEPT_IDLE_MS = 30 * 60 * 1000;
function sameSelection(left: HarnessSelection, right: HarnessSelection): boolean {
  return left.harnessId === right.harnessId && left.controlId === right.controlId && JSON.stringify(left.provider ?? null) === JSON.stringify(right.provider ?? null)
    && (left.nativeModel ?? null) === (right.nativeModel ?? null) && JSON.stringify(Object.entries(left.nativeOptions ?? {}).sort()) === JSON.stringify(Object.entries(right.nativeOptions ?? {}).sort());
}
const TERMINAL_TOOL = new Set(["completed", "failed", "declined", "cancelled", "interrupted", "error"]);
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
/** Longest wait a driver may announce for one request (a day); anything else is ignored rather than shown. */
const MAX_PERMISSION_WAIT_MS = 24 * 60 * 60 * 1000;
const TURN_DEADLINE_NOTICE: PublicNotice = { severity: "warning", title: "回合期限已到", detail: "HarnessHub 的回合期限已到，本回合超时结束；原程序没有收到你的决定。" };
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
 * One global writer, durable admission, and a new explicitly rehydrated native connection per Turn, unless the conversation
 * keeps its native process between Turns (ADR-030): then the next Turn with the same selection reuses it, and every close
 * of a kept process (idle, switch, close, reset, branch, shutdown, or the user) is recorded for its conversation.
 */
export class SessionRuntime {
  /** Native processes that conversations keep between Turns, owned here until closed. */
  private readonly kept = new Map<SessionId, KeptProcess>();
  /** Kept processes to close; the single writer closes them before its next Turn or switch. */
  private readonly releases = new Map<SessionId, { readonly reason: KeptRelease; readonly done: Promise<void>; readonly resolve: () => void }>();
  /** Processes a previous owner kept and this owner found at start, with what became of them; shown in their conversations. */
  private readonly lost = new Map<SessionId, { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number }>();
  private accepting = true;
  private readonly closingSessions = new Set<SessionId>();
  private readonly managedSessions = new Set<SessionId>();
  private readonly creating = new Set<Promise<SessionSnapshot>>();
  private readonly work = new Set<SessionId>();
  private runner: Promise<void> | null = null;
  private active: ActiveExecution | null = null;
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
    await control.decidePermission(pending.nativeId, option, input); this.owned(pending.execution);
    this.permissions.delete(permission);
    this.commit(id, current => ({ next: current, events: [event("permission.submitted", { permissionId: permission, runId: pending.execution.runId, optionId: option, backendAcknowledged: false })] }));
    return { replayed: false };
  }
  private switchBinding: { readonly sessionId: SessionId; readonly binding: PreparedSessionBinding; close: Promise<CleanupEvidence> | null } | null = null;
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
    this.lost.delete(id);
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
      const running = this.runner;
      if (running) await running;
      if (this.runner !== null || this.work.has(id) || this.active?.sessionId === id) continue;
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
    if (this.kept.has(id) || this.releases.has(id)) await this.requestRelease(id, "ended_by_user");
    return this.load(id);
  }
  /** This conversation's kept process as the chat shows it; null when it keeps none. */
  keptProcess(id: SessionId): { readonly harnessId: string; readonly controlId: string; readonly since: number; readonly lastUsedAt: number; readonly idleEndsAt: number; readonly backgroundUpdates: number } | null {
    const kept = this.kept.get(id);
    return kept === undefined ? null : { harnessId: kept.selection.harnessId, controlId: kept.selection.controlId, since: kept.since, lastUsedAt: kept.lastUsed,
      idleEndsAt: kept.lastUsed + (this.options.keptIdleMs ?? KEPT_IDLE_MS), backgroundUpdates: this.background(kept) };
  }
  /** Every kept process with the workspace it holds, for telling a conversation which one occupies its workspace. */
  keptProcesses(): readonly { readonly sessionId: SessionId; readonly workspace: string; readonly harnessId: string }[] {
    return [...this.kept].map(([sessionId, kept]) => ({ sessionId, workspace: kept.binding.workspace, harnessId: kept.selection.harnessId }));
  }
  /** What became of the process this conversation kept under the previous owner, when this owner found one at start. */
  keptLoss(id: SessionId): { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number } | null { return this.lost.get(id) ?? null; }
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
      if (retained.process !== undefined && this.options.processes !== undefined) {
        try { outcome = await this.options.processes.end(retained.process); } catch { outcome = "unconfirmed"; }
      }
      let leaseReleased = false;
      if (outcome !== "unconfirmed") { try { leaseReleased = this.factory.releaseAbandonedLease?.(state.configuration, state.id) ?? false; } catch { leaseReleased = false; } }
      const at = this.options.now().getTime();
      this.commit(state.id, current => {
        const { retained: _held, ...rest } = current;
        return { next: rest, events: [event("native.process_lost", { runId: retained.runId, harnessId: retained.harnessId, controlId: retained.controlId, reason: "owner_ended", outcome, leaseReleased })] };
      });
      this.lost.set(state.id, { outcome, leaseReleased, at });
      outcomes.push({ sessionId: state.id, outcome, leaseReleased });
    }
    return outcomes;
  }
  private background(kept: KeptProcess): number { return Math.max(0, (kept.binding.control.unattributedUpdates ?? kept.baseline) - kept.baseline); }
  /** Asks the single writer to close a kept process before its next Turn or switch; resolves once the close is recorded. */
  private requestRelease(id: SessionId, reason: KeptRelease): Promise<void> {
    const pending = this.releases.get(id);
    if (pending) return pending.done;
    let resolve!: () => void; const done = new Promise<void>(next => { resolve = next; });
    this.releases.set(id, { reason, done, resolve });
    this.schedule(id); return done;
  }
  private async drainReleases(): Promise<void> {
    for (const [id, request] of [...this.releases]) {
      this.releases.delete(id);
      try { await this.release(id, request.reason); } catch (error) { this.fail(error, id); } finally { request.resolve(); }
    }
  }
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
    try { cleanup = await kept.binding.close(); } catch (error) { problem = fault(error); }
    this.commit(id, current => {
      const { retained, ...rest } = current;
      return { next: rest, events: [event("native.process_closed", { runId: kept.runId, reason, backgroundUpdates, cleanup, ...(problem === null ? {} : { error: problem }) })] };
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
        || execution.stop !== null || execution.earlyClose !== null || !this.accepting || this.fatal !== null || this.closingSessions.has(id) || this.releases.has(id)
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
      this.commit(id, current => {
        const next = this.cancelPending(current);
        return { next: { ...next, commands: [...next.commands, { id: command, kind: "close", fingerprint, resultId: id }] },
          events: [event("session.close_requested", { cancelledRunIds: current.runs.filter(run => run.status === "queued").map(run => run.id) })] };
      });
      if (this.active?.sessionId === id) this.stop(this.active);
      if (this.switchBinding?.sessionId === id) this.stopSwitch();
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
        if (state.runs.some(run => !terminal(run.status)) || state.pendingSwitchId !== null)
          this.commit(state.id, current => ({ next: this.cancelPending(current), events: [event("runtime.stopping", {})] }));
      }
    } catch (error) { problem = error; this.fail(error); }
    if (this.active) this.stop(this.active);
    this.stopSwitch();
    if (this.runner) await this.runner;
    // Kept processes end with their owner; each close is recorded for its conversation (ADR-030).
    try { await this.drainReleases(); for (const id of [...this.kept.keys()]) await this.release(id, "gateway_shutdown"); }
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
    this.commit(id, current => {
      let next = current;
      if (run && !terminal(run.status)) next = updatedRun(current, run.id, { cancelRequested: true, ...(run.status === "queued" ? { status: "cancelled" as const, ...phase(current, run.id, "endedAt", this.options.now().getTime()) } : {}) });
      return { next: { ...next, commands: [...next.commands, { id: command, kind: "cancel", fingerprint, resultId: selected ?? "none" }] },
        events: [event("run.cancel_requested", { runId: selected, beforeStart: run?.status === "queued", alreadyTerminal: run === undefined || terminal(run.status) })] };
    });
    if (this.active?.sessionId === id && this.active.runId === selected) this.stop(this.active);
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
    if (this.active) this.stop(this.active);
    this.stopSwitch();
    const affected = id ?? this.active?.sessionId ?? this.switchBinding?.sessionId;
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
  private stopSwitch(): void {
    if (!this.switchBinding) return;
    this.switchBinding.close ??= this.switchBinding.binding.close();
    void this.switchBinding.close.catch(() => {});
  }
  private schedule(id: SessionId): void {
    this.managedSessions.add(id);
    this.work.add(id);
    if (this.runner !== null) return;
    const running = Promise.resolve().then(() => this.pump());
    this.runner = running;
    void running.then(() => { if (this.runner === running) this.runner = null; if (this.work.size && !this.fatal && this.accepting) this.schedule(this.work.values().next().value!); },
      error => { this.fail(error); if (this.runner === running) this.runner = null; this.work.clear(); });
  }
  private async pump(): Promise<void> {
    while (this.work.size || this.releases.size) {
      // Kept processes to close go first, so a Turn or switch never meets a lease that is about to be released.
      await this.drainReleases();
      if (!this.work.size) continue;
      const id = this.work.values().next().value!; this.work.delete(id);
      if (this.fatal) { this.work.clear(); return; }
      let state = this.load(id);
      if ((state.status !== "open" && !(state.status === "blocked" && this.recoverySwitch(state))) || this.closingSessions.has(id) || !this.accepting) continue;
      try {
        // A branch's native fork runs before any of its inputs, in the same single-writer order as Turns.
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
      } catch (error) { this.fail(error); }
      const after = this.load(id);
      if (after.status === "open" && (after.pendingSwitchId !== null || after.runs.some(run => run.status === "queued")) && !this.closingSessions.has(id) && this.accepting && !this.fatal) this.work.add(id);
    }
  }

  private owned(execution: ActiveExecution): SessionSnapshot {
    this.store.assertOwner(); execution.binding?.assertOwned();
    const state = this.load(execution.sessionId);
    if (this.active !== execution || state.activeRunId !== execution.runId) throw new SessionError("OWNERSHIP_LOST", "active Run ownership changed");
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

  private output(execution: ActiveExecution, value: ControlEvent): void {
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    if (VISIBLE_OUTPUT.has(value.type) && run.timing !== undefined && run.timing.firstOutputAt === undefined)
      this.commit(state.id, current => ({ next: updatedRun(current, run.id, phase(current, run.id, "firstOutputAt", this.options.now().getTime())), events: [event("run.first_output", { runId: run.id })] }));
    if (value.type === "permission_requested") {
      if (this.permissions.size >= 32) throw new SessionError("PERMISSION_LIMIT", "too many pending native permissions");
      // The driver says how long the request can wait from now; the Runtime turns it into a time on its own clock (ADR-035).
      const requestedAt = this.options.now().getTime(), wait = value.expiresInMs;
      const expires = wait !== undefined && Number.isSafeInteger(wait) && wait >= 0 && wait <= MAX_PERMISSION_WAIT_MS && (value.expiresBy === "native" || value.expiresBy === "turn")
        ? { expiresAt: requestedAt + wait, expiresBy: value.expiresBy } : {};
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
      if (value.type === "thinking") {
        const thinking = (run.thinking ?? "") + value.text; if (utf8Bytes(thinking) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "native thinking exceeded its budget"); next = updatedRun(current, run.id, { thinking });
      }
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
      if (value.type === "text") {
        const message = current.messages.find(message => message.id === run.assistantMessageId);
        const text = (message?.text ?? "") + value.text;
        if (utf8Bytes(text) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "Run public output byte budget exhausted");
        next = { ...current, messages: message ? current.messages.map(item => item.id === message.id ? { ...item, text } : item)
          : [...current.messages, { id: run.assistantMessageId, runId: run.id, role: "assistant", text, seq: current.lastSeq + 1, status: run.status }] };
      }
      return { next, events: [event("run.output", { runId: run.id, event: logged(value) })] };
    });
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
      backendSettled: false, stop: null, earlyClose: null, details: new Map(), dirty: new Set(), writes: Promise.resolve(), writeFailure: null };
    if (this.active) throw new SessionError("OWNERSHIP_LOST", "another global writer is active");
    this.active = execution;
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
        execution.binding = kept.binding; native = kept.conversation;
        this.commit(id, current => {
          const { retained, ...rest } = current;
          return { next: updatedRun(rest, target, { reused: true }), events: [event("native.process_reused", { runId: target, previousRunId: kept.runId, idleMs: Math.max(0, now - kept.lastUsed), backgroundUpdates: this.background(kept) })] };
        });
        this.continue(execution);
      } else {
        try { execution.binding = await this.factory.prepare(run.selection, current.configuration, id, target); }
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
      const abandoned = [...this.permissions.entries()].filter(([, permission]) => permission.execution === execution);
      for (const [permissionId] of abandoned) this.permissions.delete(permissionId);
      // A request still waiting when the Turn reached its own deadline expired: the program never received a decision (ADR-035).
      const expired = problem?.code === "RUN_TIMEOUT" ? abandoned.filter(([, permission]) => permission.option === null).map(([permissionId]) => permissionId) : [];
      if (abandoned.length) this.commit(id, current => ({ next: expired.length ? withNotice(current, target, TURN_DEADLINE_NOTICE) : current,
        events: abandoned.map(([permissionId]) => event("permission.closed", { permissionId, runId: target, ...(expired.includes(permissionId) ? { reason: "expired" } : {}) })) }));
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
        const failure = problem ?? cleanup?.protocolFailure ?? backend?.error ?? null;
        const status = unsafe ? "unknown" : run.cancelRequested || problem?.code === "CANCELLED" ? "cancelled" : failure ? "failed" : backend?.status ?? "failed";
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
      this.active = null;
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
      this.switchBinding = { sessionId: id, binding, close: null };
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
        try { cleanup = await (this.switchBinding?.close ?? binding.close()); } catch (error) { problem = fault(error); }
      }
      this.switchBinding = null;
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
