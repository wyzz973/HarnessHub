import { parseProviderTarget } from "../../../contracts/provider.js";
import { TOOL_DIFF_BYTES, TOOL_INPUT_BYTES, TOOL_OUTPUT_BYTES, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlRun, type NativeToolDetail, type NativeUsage } from "../../../contracts/control.js";
import { MAX_RUN_ATTACHMENTS, MAX_RUN_OUTPUTS, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId,
  type ForkedMessage, type NativeSessionBinding, type PermissionRequest, type CancelReceipt, type CommandId, type EventDraft, type PreparedSessionBinding, type PublicRun,
  type SelectionRequest, type SendReceipt, type SessionBindingFactory, type SessionCommit, type SessionConfiguration,
  type SessionId, type SessionEvent, type SessionMutation, type SessionRuntimeOptions, type SessionSnapshot, type SessionStore, type SwitchReceipt,
} from "../../../contracts/session.js";
import { buildPublicContext } from "../domain/context.js";
import { MAX_COMMANDS, MAX_OUTPUT_BYTES, MAX_PLAN_ENTRIES, MAX_QUEUE, MAX_RUNS, MAX_RUN_ACTIVITIES, MAX_RUN_NOTICES, MAX_RUN_TOOLS, assertInput, parseConfiguration, replayCommand, terminal, utf8Bytes } from "../domain/state.js";

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
function fault(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SessionError) return { code: error.code.slice(0, 128), message: error.message.slice(0, 512) };
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 128) : "CONTROL_FAILED";
  return { code, message: "Harness operation failed; inspect private control diagnostics" };
}
function updatedRun(state: SessionSnapshot, id: string, patch: Partial<PublicRun>): SessionSnapshot {
  const prior = state.runs.find(run => run.id === id);
  if (!prior) throw new SessionError("IDENTITY_MISMATCH", "Run is not owned by this Session");
  const next = { ...prior, ...patch };
  return { ...state, runs: state.runs.map(run => run.id === id ? next : run),
    messages: state.messages.map(message => message.runId === id ? { ...message, status: next.status } : message) };
}
function event(type: string, data: Readonly<Record<string, unknown>>): EventDraft { return { type, data }; }

/** One global writer, durable admission, and a new explicitly rehydrated native connection per Turn. */
export class SessionRuntime {
  private accepting = true;
  private readonly closingSessions = new Set<SessionId>();
  private readonly managedSessions = new Set<SessionId>();
  private readonly creating = new Set<Promise<SessionSnapshot>>();
  private readonly work = new Set<SessionId>();
  private runner: Promise<void> | null = null;
  private active: ActiveExecution | null = null;
  private readonly permissions = new Map<string, { request: PermissionRequest; nativeId: string; execution: ActiveExecution; option: string | null; command: string | null }>();
  permissionRequests(id: SessionId): readonly PermissionRequest[] { this.load(id); return [...this.permissions.values()].filter(value => value.execution.sessionId === id).map(value => value.request); }
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
    const state: SessionSnapshot = { schemaVersion: 8, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
      configuration: config, selection: validated, activeRunId: null, pendingSwitchId: null,
      runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "public_context_rehydrate" })]);
      this.managedSessions.add(committed.session.id);
      return this.publish(committed).session;
    }
    catch (error) { this.fail(error, id); throw error; }
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
      sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: state.pendingSwitchId, ...(attachments.length ? { attachments } : {}) };
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
    return this.commit(id, current => ({ next: { ...current,
      nativeBindings: current.nativeBindings?.map(binding => binding.harnessId === current.selection.harnessId && binding.controlId === current.selection.controlId && binding.status !== "archived" ? { ...binding, status: "archived" as const } : binding) ?? [],
      commands: [...current.commands, { id: command, kind: "native-reset", fingerprint, resultId: id }],
    }, events: [event("native.branch_requested", { harnessId: current.selection.harnessId, controlId: current.selection.controlId, historyPreserved: true, previousBindingPreserved: true })] })).session;
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
    const state: SessionSnapshot = { schemaVersion: 8, id, version: 0, lastSeq: 0, epoch: 1, status: "open", configuration: source.configuration, selection: source.selection,
      activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      origin: { kind: "fork", sessionId: sourceId, throughRunId: through.id, history },
      ...(nativeFork ? { nativeBindings: [{ harnessId: native.harnessId, controlId: native.controlId, checkpoint: native.checkpoint, throughRunId: null, status: "fork-pending" as const }] } : {}) };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: state.selection, continuity: nativeFork ? "native_fork" : "public_context_rehydrate", origin: { sessionId: sourceId, throughRunId: through.id, messages: history.length, nativeFork } })]);
      this.managedSessions.add(id); this.publish(committed);
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
    const creating = await Promise.allSettled([...this.creating]);
    for (const result of creating) if (result.status === "rejected" && !(result.reason instanceof SessionError && result.reason.code === "RUNTIME_CLOSED")) {
      problem ??= result.reason; this.fail(result.reason);
    }
    this.work.clear();
    if (problem) throw problem;
    if (this.fatal) throw this.fatal;
  }

  private cancelPending(state: SessionSnapshot): SessionSnapshot {
    const runs = state.runs.map(run => run.status === "queued" ? { ...run, status: "cancelled" as const, cancelRequested: true }
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
      if (run && !terminal(run.status)) next = updatedRun(current, run.id, { cancelRequested: true, ...(run.status === "queued" ? { status: "cancelled" as const } : {}) });
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
    while (this.work.size) {
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
    if (value.type === "permission_requested") {
      if (this.permissions.size >= 32) throw new SessionError("PERMISSION_LIMIT", "too many pending native permissions");
      const id = "permission-" + this.options.id(), request: PermissionRequest = { id, runId: run.id, title: value.title, options: value.options, ...(value.detail===undefined?{}:{detail:value.detail}),...(value.input===undefined?{}:{input:value.input}), decided: false };
      this.permissions.set(id, { request, nativeId: value.id, execution, option: null, command: null });
      try { this.commit(state.id, current => ({ next: current, events: [event("permission.requested", { permissionId: id, runId: run.id, title: value.title, options: value.options })] })); } catch (error) { this.permissions.delete(id); throw error; } return;
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
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE", message: "requested Harness switch failed; this input was not dispatched" } }),
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
    try {
      this.commit(id, current => ({ next: { ...updatedRun(current, target, { status: "preparing", selection: pinned, epoch: waitedSwitch ? current.epoch : queued.epoch }), activeRunId: target },
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
      execution.binding = await this.factory.prepare(run.selection, current.configuration, id, target);
      this.continue(execution);
      if (execution.binding.installation !== undefined) {
        const installation = execution.binding.installation;
        this.commit(id, current => ({ next: current, events: [event("run.installation_resolved", { runId: target, installation })] }));
      }
      const observation = await execution.binding.control.initialize(); this.continue(execution);
      this.commit(id, current => ({ next: current, events: [event("run.protocol", { runId: target, observation })] }));
      const native = await execution.binding.control.open(execution.binding.workspace, run.selection.nativeModel, run.selection.nativeOptions, previousNative?.checkpoint); this.continue(execution);
      if (run.selection.provider === undefined && execution.binding.control.checkpoint) {
        checkpoint = await execution.binding.control.checkpoint(); this.continue(execution);
        if (checkpoint !== null && (typeof checkpoint !== "string" || !checkpoint || Buffer.byteLength(checkpoint) > 8192 || /[\0\r\n]/u.test(checkpoint))) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "invalid original Harness recovery reference");
        if (previousNative !== undefined && checkpoint === null) throw new SessionError("NATIVE_RESUME_UNAVAILABLE", "original Harness cannot confirm its recovered state; no replacement session was dispatched");
        if (checkpoint !== null) {
          const reference: NativeSessionBinding = { harnessId: run.selection.harnessId, controlId: run.selection.controlId, checkpoint, throughRunId: previousNative?.throughRunId ?? null, status: "unconfirmed" };
          this.commit(id, current => ({ next: { ...current, nativeBindings: previousNative === undefined ? [...(current.nativeBindings ?? []), reference] : current.nativeBindings?.map(binding => binding.harnessId === reference.harnessId && binding.controlId === reference.controlId && binding.status !== "archived" ? reference : binding) ?? [reference] },
            events: [event("native.binding_prepared", { runId: target, harnessId: reference.harnessId, controlId: reference.controlId, resumed: previousNative !== undefined })] }));
          checkpointStored = true;
        }
      }
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "running" }), events: [event("run.authorized", { runId: target, epoch: run.epoch })] }));
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
      }
    } catch (error) { problem = fault(error); }
    finally {
      const abandoned = [...this.permissions.entries()].filter(([, permission]) => permission.execution === execution);
      for (const [permissionId] of abandoned) this.permissions.delete(permissionId);
      if (abandoned.length) this.commit(id, current => ({ next: current, events: abandoned.map(([permissionId]) => event("permission.closed", { permissionId, runId: target })) }));
      if (execution.stop) {
        try { await execution.stop; } catch (error) { problem ??= fault(error); }
      }
      if (execution.binding && execution.earlyClose === null) {
        try { await this.flushNative(execution); } catch (error) { problem ??= fault(error); }
      }
      if (execution.binding) {
        try { execution.earlyClose ??= execution.binding.close(); cleanup = await execution.earlyClose; }
        catch (error) { problem = fault(error); }
      }
      try {
        this.store.assertOwner();
        const current = this.load(id), run = current.runs.find(run => run.id === target)!;
        const unsafe = (execution.dispatched && backend === null) || (execution.binding !== null && cleanup === null) || this.fatal !== null || this.unknownOwnership(problem);
        const failure = problem ?? cleanup?.protocolFailure ?? backend?.error ?? null;
        const status = unsafe ? "unknown" : run.cancelRequested || problem?.code === "CANCELLED" ? "cancelled" : failure ? "failed" : backend?.status ?? "failed";
        this.commit(id, current => {
          let next: SessionSnapshot = { ...updatedRun(current, target, { status, backend, cleanup,
            error: failure }), activeRunId: null, status: unsafe ? "blocked" : current.status };
          if (checkpointStored && checkpoint !== null && cleanup?.closed === true && cleanup.protocolFailure === null && (!execution.dispatched || nativeConfirmed && backend !== null)) {
            next = { ...next, nativeBindings: next.nativeBindings?.map(binding => binding.harnessId === pinned.harnessId && binding.controlId === pinned.controlId && binding.status !== "archived" ? { ...binding, checkpoint: checkpoint!, status: "ready" as const, throughRunId: execution.dispatched ? run.id : binding.throughRunId } : binding) ?? [] };
          }
          const cancelSwitch = (!this.accepting || this.closingSessions.has(id)) && next.pendingSwitchId !== null;
          if (cancelSwitch) next = this.cancelPending(next);
          return { next, events: [event("run.ended", { runId: target, status, backend, cleanup, error: failure }),
            ...(cancelSwitch ? [event("switch.failed", { switchId: current.pendingSwitchId, reason: "cancelled by close" })] : []),
            ...(unsafe ? [event("session.blocked", { runId: target, reason: "execution or cleanup could not be safely confirmed" })] : [])] };
        });
      } catch (error) { this.fail(error); }
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
