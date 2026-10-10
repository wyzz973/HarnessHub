import { parseProviderTarget } from "../../../contracts/provider.js";
import type { BackendResult, CleanupEvidence, ControlEvent, ControlRun } from "../../../contracts/control.js";
import {
  SessionError, commandId, messageId, runId, sessionId, switchId,
  type CancelReceipt, type CommandId, type EventDraft, type PreparedSessionBinding, type PublicRun,
  type SelectionRequest, type SendReceipt, type SessionBindingFactory, type SessionCommit, type SessionConfiguration,
  type SessionId, type SessionEvent, type SessionMutation, type SessionRuntimeOptions, type SessionSnapshot, type SessionStore, type SwitchReceipt,
} from "../../../contracts/session.js";
import { buildPublicContext } from "../domain/context.js";
import { MAX_COMMANDS, MAX_OUTPUT_BYTES, MAX_QUEUE, MAX_RUNS, assertInput, parseConfiguration, replayCommand, terminal, utf8Bytes } from "../domain/state.js";

interface ActiveExecution {
  readonly sessionId: SessionId;
  readonly runId: string;
  binding: PreparedSessionBinding | null;
  run: ControlRun | null;
  dispatched: boolean;
  backendSettled: boolean;
  stop: Promise<void> | null;
  earlyClose: Promise<CleanupEvidence> | null;
}
const MAX_PENDING_CREATES = 16;
function requested(value: SelectionRequest): SelectionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "harnessId" && key !== "controlId" && key !== "provider" && key !== "nativeModel") ||
    typeof value.harnessId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value.harnessId) ||
    (value.controlId !== undefined && (typeof value.controlId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value.controlId))))
    throw new SessionError("INVALID_INPUT", "selection must name bounded catalog identities");
  if (value.nativeModel !== undefined && (typeof value.nativeModel !== "string" || !value.nativeModel.trim() || value.nativeModel.length > 1024 || /[\0\r\n]/u.test(value.nativeModel)))
    throw new SessionError("INVALID_INPUT", "invalid native model identity");
  if (value.nativeModel !== undefined && value.provider != null) throw new SessionError("INVALID_INPUT", "native model and managed Provider are mutually exclusive");
  return { harnessId: value.harnessId, ...(value.controlId === undefined ? {} : { controlId: value.controlId }),
    ...(value.provider === undefined ? {} : { provider: value.provider === null ? null : parseProviderTarget(value.provider) }),
    ...(value.nativeModel === undefined ? {} : { nativeModel: value.nativeModel }) };
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
    const state: SessionSnapshot = { schemaVersion: 4, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
      configuration: config, selection: validated, activeRunId: null, pendingSwitchId: null,
      runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "public_context_rehydrate" })]);
      this.managedSessions.add(committed.session.id);
      return this.publish(committed).session;
    }
    catch (error) { this.fail(error, id); throw error; }
  }

  send(id: SessionId, text: string, key: string): SendReceipt {
    this.admit(); assertInput(text);
    const command = commandId(key), fingerprint = this.fingerprint({ kind: "send", text }), state = this.load(id);
    const prior = replayCommand(state, command, "send", fingerprint);
    if (prior) return { sessionId: id, runId: runId(prior.resultId), replayed: true };
    this.open(state); this.commandBudget(state);
    if (state.runs.length >= MAX_RUNS) throw new SessionError("RUN_LIMIT", "Session Run budget exhausted");
    if (state.runs.filter(run => run.status === "queued").length >= MAX_QUEUE) throw new SessionError("QUEUE_FULL", "Session queued input limit reached");
    const nextId = runId("run-" + this.options.id()), userId = messageId("message-" + this.options.id()), assistantId = messageId("message-" + this.options.id());
    const run: PublicRun = { id: nextId, commandId: command, input: text, userMessageId: userId, assistantMessageId: assistantId,
      selection: state.selection, epoch: state.epoch, status: "queued", cancelRequested: false, contextThroughSeq: 0,
      sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: state.pendingSwitchId };
    this.commit(id, current => ({ next: { ...current, runs: [...current.runs, run],
      messages: [...current.messages, { id: userId, runId: nextId, role: "user", text, seq: current.lastSeq + 1, status: "queued" }],
      commands: [...current.commands, { id: command, kind: "send", fingerprint, resultId: nextId }] },
      events: [event("message.accepted", { runId: nextId, messageId: userId, role: "user", text })] }));
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
      const state = this.load(id);
      if ((state.status !== "open" && !(state.status === "blocked" && this.recoverySwitch(state))) || this.closingSessions.has(id) || !this.accepting) continue;
      try {
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
    this.commit(state.id, current => {
      let next = current;
      if (value.type === "text") {
        const message = current.messages.find(message => message.id === run.assistantMessageId);
        const text = (message?.text ?? "") + value.text;
        if (utf8Bytes(text) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "Run public output byte budget exhausted");
        next = { ...current, messages: message ? current.messages.map(item => item.id === message.id ? { ...item, text } : item)
          : [...current.messages, { id: run.assistantMessageId, runId: run.id, role: "assistant", text, seq: current.lastSeq + 1, status: run.status }] };
      }
      return { next, events: [event("run.output", { runId: run.id, event: value })] };
    });
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
      backendSettled: false, stop: null, earlyClose: null };
    if (this.active) throw new SessionError("OWNERSHIP_LOST", "another global writer is active");
    this.active = execution;
    let backend: BackendResult | null = null, cleanup: CleanupEvidence | null = null, problem: ReturnType<typeof fault> | null = null;
    try {
      this.commit(id, current => ({ next: { ...updatedRun(current, target, { status: "preparing", selection: pinned, epoch: waitedSwitch ? current.epoch : queued.epoch }), activeRunId: target },
        events: [event("run.preparing", { runId: target, selection: state.selection, epoch: state.epoch })] }));
      let current = this.owned(execution), run = this.continue(execution), context = buildPublicContext(current, run);
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
      const native = await execution.binding.control.open(execution.binding.workspace, run.selection.nativeModel); this.continue(execution);
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "running" }), events: [event("run.authorized", { runId: target, epoch: run.epoch })] }));
      this.continue(execution);
      execution.dispatched = true;
      execution.run = await execution.binding.control.startText(native, context.text, value => this.output(execution, value));
      this.owned(execution);
      void execution.run.result.then(() => { execution.backendSettled = true; }, () => { execution.backendSettled = true; });
      if (this.load(id).runs.find(run => run.id === target)!.cancelRequested || !this.accepting || this.fatal || this.closingSessions.has(id)) this.stop(execution);
      backend = await execution.run.result; execution.backendSettled = true;
      this.owned(execution);
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "settling", backend }), events: [event("run.backend_settled", { runId: target, backend })] }));
    } catch (error) { problem = fault(error); }
    finally {
      if (execution.stop) {
        try { await execution.stop; } catch (error) { problem ??= fault(error); }
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
      binding = await this.factory.prepare(target, initial.configuration, id, targetId);
      this.switchBinding = { sessionId: id, binding, close: null };
      this.store.assertOwner(); binding.assertOwned();
      current = this.load(id);
      if (current.pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting || this.fatal) throw new SessionError("CANCELLED", "switch cancelled before target initialization");
      await binding.control.initialize(); this.store.assertOwner(); binding.assertOwned();
      if (this.load(id).pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting || this.fatal) throw new SessionError("CANCELLED", "switch cancelled before target conversation");
      await binding.control.open(binding.workspace, target.nativeModel); this.store.assertOwner(); binding.assertOwned();
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
