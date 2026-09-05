import type { EngineCatalog } from "../domain/engines.js";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import type {
  ExecutionHandle,
  Store,
  WorkerHost,
  WorkerMessage,
} from "../domain/ports.js";
import { isTerminal } from "../domain/types.js";
import type {
  ArtifactRecord,
  CleanupStatus,
  EngineProfile,
  PermissionId,
  RunId,
  RunInput,
  RunRecord,
  SessionId,
  SessionRecord,
  TerminalStatus,
  Workspace,
  JsonObject,
} from "../domain/types.js";

interface RuntimeOptions {
  catalog?: EngineCatalog;
  engines: EngineProfile[];
  workspaces: Workspace[];
  defaultEngine: string;
  defaultWorkspace: string;
  maxConcurrency: number;
  maxQueuedRuns: number;
  defaultTimeoutMs: number;
  cancelGraceMs: number;
  stateDir: string;
  recoveredWorkers?: Map<SessionId, CleanupStatus>;
  publishArtifact: (
    runId: RunId,
    artifact: { name: string; mediaType: string; text: string },
  ) => Promise<ArtifactRecord>;
}
interface ActiveRun {
  run: RunRecord;
  profile: EngineProfile;
  handle?: ExecutionHandle;
  stop?: "cancelled" | "timed_out";
  stopping?: Promise<CleanupStatus>;
  settlement?: Promise<void>;
}
/** Owns public execution outcomes. All asynchronous backend work remains tied to a run generation. */
export class Runtime {
  private readonly active = new Map<SessionId, ActiveRun>();
  private readonly queue: RunId[] = [];
  private readonly deadlines = new Map<RunId, NodeJS.Timeout>();
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;
  private failure: Error | undefined;
  private readonly observedEngines = new Map<string, JsonObject>();

  constructor(
    readonly store: Store,
    private readonly host: WorkerHost,
    private readonly options: RuntimeOptions,
  ) {
    // Previous process work has an unknown outcome; never replay it automatically.
    for (const run of store.listRuns()) {
      if (!isTerminal(run.status)) {
        store.finishRun(run.id, {
          status: "interrupted",
          stopReason: "gateway_restarted",
          cleanupStatus:
            options.recoveredWorkers?.get(run.sessionId) ?? "unconfirmed",
        });
        store.setSessionStatus(run.sessionId, "closed");
      }
    }
    for (const session of store.listSessions()) {
      if (session.status !== "open") continue;
      let profile: EngineProfile;
      try {
        profile = this.profile(session.engineId, session.profileRevision);
      } catch (error) {
        if (!(error instanceof HubError) || error.code !== "ENGINE_UNAVAILABLE")
          throw error;
        store.setSessionStatus(session.id, "closed");
        continue;
      }
      if (profile.driver === "acp" && !profile.capabilities.resume)
        store.setSessionStatus(session.id, "closed");
    }
  }
  isReady(): boolean {
    return !this.closed && !this.failure;
  }
  listEngines(): EngineProfile[] {
    return (this.options.catalog?.list() ?? this.options.engines).map((e) =>
      structuredClone(e),
    );
  }
  /** Live protocol observations, not proof of real-task or platform support. */
  engineEvidence(id: string, revision: string): JsonObject | null {
    return this.observedEngines.get(`${id}:${revision}`) ?? null;
  }
  private profile(id: string, revision?: string): EngineProfile {
    if (this.options.catalog) return this.options.catalog.resolve(id, revision);
    const profile = this.options.engines.find(
      (e) => e.id === id && (revision ? e.revision === revision : e.enabled),
    );
    if (!profile)
      throw new HubError(
        "ENGINE_UNAVAILABLE",
        `Engine ${id} is not enabled`,
        404,
      );
    return profile;
  }
  createSession(input: {
    engineId?: string;
    workspaceId?: string;
  }): SessionRecord {
    this.assertReady();
    const profile = this.profile(
      input.engineId ??
        this.options.catalog?.defaultId() ??
        this.options.defaultEngine,
    );
    const workspace = this.options.workspaces.find(
      (w) => w.id === (input.workspaceId ?? this.options.defaultWorkspace),
    );
    if (!workspace)
      throw new HubError(
        "WORKSPACE_NOT_FOUND",
        "Workspace is not registered",
        404,
      );
    return this.store.createSession(profile, workspace);
  }
  submit(
    sessionId: SessionId,
    input: Omit<RunInput, "timeoutMs"> & { timeoutMs?: number },
    key?: string,
  ): { run: RunRecord; created: boolean } {
    this.assertReady();
    const session = this.store.getSession(sessionId);
    if (session.status !== "open")
      throw new HubError("SESSION_CLOSED", "Session is closed", 409);
    const profile = this.profile(session.engineId, session.profileRevision);
    if (input.fixture && profile.driver !== "fake")
      throw new HubError(
        "UNSUPPORTED_CAPABILITY",
        "Fixture controls are only available in demo sessions",
      );
    const normalized = {
      ...input,
      timeoutMs: input.timeoutMs ?? this.options.defaultTimeoutMs,
    };
    if (key && this.store.findRunByKey(sessionId, key))
      return this.store.acceptRun(sessionId, normalized, key);
    if (this.queue.length >= this.options.maxQueuedRuns)
      throw new HubError("QUEUE_FULL", "Run queue is full", 429);
    const result = this.store.acceptRun(sessionId, normalized, key);
    if (result.created) {
      this.queue.push(result.run.id);
      const timer = setTimeout(
        () => {
          this.background(this.stop(result.run.id, "timed_out"));
        },
        Math.max(1, result.run.deadlineAt - Date.now()),
      );
      timer.unref();
      this.deadlines.set(result.run.id, timer);
      queueMicrotask(() => this.pump());
    }
    return result;
  }
  private assertReady(): void {
    if (!this.isReady())
      throw new HubError(
        "UNAVAILABLE",
        "Runtime is stopping or storage is unavailable",
        503,
      );
  }
  private background(task: Promise<void>): void {
    this.tasks.add(task);
    void task
      .catch((error: unknown) => {
        this.failure =
          error instanceof Error
            ? error
            : new Error("Runtime operation failed");
        // Preserve the original error and stop external work if public state can no longer be committed.
        void this.host.close().catch(() => {
          /* Host failure is secondary to the recorded runtime failure. */
        });
      })
      .finally(() => this.tasks.delete(task));
  }
  private pump(): void {
    if (!this.isReady()) return;
    try {
      for (
        let i = 0;
        i < this.queue.length && this.active.size < this.options.maxConcurrency;
      ) {
        const id = this.queue[i];
        if (!id) break;
        const run = this.store.getRun(id);
        if (isTerminal(run.status)) {
          this.queue.splice(i, 1);
          continue;
        }
        const session = this.store.getSession(run.sessionId);
        if (session.status !== "open") {
          this.queue.splice(i, 1);
          this.finish(run.id, "cancelled", "session_closed", "confirmed");
          clearTimeout(this.deadlines.get(run.id));
          this.deadlines.delete(run.id);
          continue;
        }
        const profile = this.profile(session.engineId, session.profileRevision);
        const count = [...this.active.values()].filter(
          (v) => v.profile.id === profile.id,
        ).length;
        if (this.active.has(run.sessionId) || count >= profile.maxConcurrency) {
          i++;
          continue;
        }
        this.queue.splice(i, 1);
        const active: ActiveRun = { run, profile };
        this.active.set(run.sessionId, active);
        active.settlement = this.execute(active, session);
        this.background(active.settlement);
      }
    } catch (error) {
      this.background(Promise.reject(error));
    }
  }
  private async execute(
    active: ActiveRun,
    session: SessionRecord,
  ): Promise<void> {
    const run = active.run;
    let backendFailed = false;
    try {
      this.store.setRunStatus(run.id, "starting");
      active.handle = await this.host.start(
        {
          sessionId: session.id,
          runId: run.id,
          generation: run.generation,
          profile: active.profile,
          cwd: session.cwd,
          input: run.input,
          stateDir: path.join(this.options.stateDir, session.id),
        },
        async (message) => this.receive(active, message),
      );
      if (active.stop) await active.handle.cancel();
      const result = await active.handle.result;
      backendFailed = result.status === "failed";
      // CLI turns are stateless: reclaim the full worker group before another turn.
      // Any failed backend also loses reuse eligibility, even when it returns a result.
      let cleanup: CleanupStatus = "confirmed";
      if (!active.stop && (active.profile.driver === "cli" || backendFailed))
        cleanup = await this.host.closeSession(session.id);
      if (!active.stop && Date.now() >= run.deadlineAt)
        await this.stop(run.id, "timed_out");
      if (active.stop) {
        const cleanup = (await active.stopping) ?? "unconfirmed";
        this.finish(run.id, active.stop, active.stop, cleanup);
      } else {
        this.store.finishRun(run.id, {
          status: result.status,
          stopReason: result.stopReason ?? result.status,
          cleanupStatus: cleanup,
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.error ? { error: result.error } : {}),
        });
      }
    } catch (error) {
      backendFailed = true;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        typeof code === "string" &&
        (code.startsWith("ERR_SQLITE") || code.startsWith("STORAGE_"))
      ) {
        this.failure =
          error instanceof Error ? error : new Error("Storage unavailable");
        void this.host.close().catch(() => {
          /* The storage failure remains the primary fault. */
        });
      }
      const cleanup = await (
        active.stopping ?? this.host.closeSession(session.id)
      ).catch((): CleanupStatus => "failed");
      if (active.stop) this.finish(run.id, active.stop, active.stop, cleanup);
      else
        this.store.finishRun(run.id, {
          status: "failed",
          stopReason: "backend_error",
          cleanupStatus: cleanup,
          error: {
            code: error instanceof HubError ? error.code : "BACKEND_ERROR",
            message: "Engine execution failed; inspect the local engine setup",
          },
        });
    } finally {
      clearTimeout(this.deadlines.get(run.id));
      this.deadlines.delete(run.id);
      this.active.delete(session.id);
      if (active.profile.driver === "acp" && (active.stop || backendFailed))
        this.store.setSessionStatus(session.id, "closed");
      queueMicrotask(() => this.pump());
    }
  }
  private async receive(
    active: ActiveRun,
    message: WorkerMessage,
  ): Promise<void> {
    const run = this.store.getRun(active.run.id);
    if (
      message.runId !== run.id ||
      message.sessionId !== run.sessionId ||
      message.generation !== run.generation ||
      isTerminal(run.status) ||
      active.stop
    )
      return;
    switch (message.type) {
      case "started":
        this.store.setRunStatus(run.id, "running");
        break;
      case "event": {
        const committed = this.store.appendEvent(run.id, {
          ...message.event,
          sourceSeq: message.seq,
        });
        if (committed && message.event.type === "engine.capabilities")
          this.observedEngines.set(
            `${active.profile.id}:${active.profile.revision}`,
            {
              ...message.event.data,
              sourceRunId: run.id,
              profileRevision: active.profile.revision,
              observedAt: committed.observedAt,
            },
          );
        break;
      }
      case "permission":
        this.store.createPermission({
          ...message.permission,
          sessionId: run.sessionId,
          runId: run.id,
          generation: run.generation,
          status: "pending",
          createdAt: Date.now(),
          expiresAt: run.deadlineAt,
        });
        this.store.setRunStatus(run.id, "waiting_permission");
        break;
      case "permission_applied":
        this.store.markPermissionApplied(message.permissionId);
        this.store.setRunStatus(run.id, "running");
        break;
      case "artifact": {
        const artifact = await this.options.publishArtifact(
          run.id,
          message.artifact,
        );
        if (!isTerminal(this.store.getRun(run.id).status) && !active.stop)
          this.store.registerArtifact(artifact);
        break;
      }
      case "result":
        break; // WorkerHost resolves result only after preceding messages are acknowledged.
    }
  }
  private finish(
    id: RunId,
    status: TerminalStatus,
    reason: string,
    cleanup: CleanupStatus,
  ): void {
    this.store.finishRun(id, {
      status,
      stopReason: reason,
      cleanupStatus: cleanup,
    });
  }
  /** Requests exact-run cancellation; callers inspect Run status for actual settlement. */
  async cancel(id: RunId): Promise<RunRecord> {
    await this.stop(id, "cancelled");
    return this.store.getRun(id);
  }
  private async stop(
    id: RunId,
    reason: "cancelled" | "timed_out",
  ): Promise<void> {
    const run = this.store.getRun(id);
    if (isTerminal(run.status)) return;
    const active = this.active.get(run.sessionId);
    if (!active || active.run.id !== id) {
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      this.finish(id, reason, reason, "confirmed");
      clearTimeout(this.deadlines.get(id));
      this.deadlines.delete(id);
      return;
    }
    if (active.stop) return;
    active.stop = reason;
    this.store.setRunStatus(id, "cancelling");
    active.stopping = (async () => {
      const handle = active.handle;
      if (handle) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            handle
              .cancel()
              .then(async () => {
                await handle.result;
              })
              .catch(() => {
                /* Closing the worker below determines cleanup status. */
              }),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, this.options.cancelGraceMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      return this.host.closeSession(run.sessionId);
    })();
    // execute() consumes this promise; attach immediately to avoid a rejection gap.
    void active.stopping.catch(() => {
      /* execute records cleanup failure alongside the run outcome. */
    });
  }
  async decide(id: PermissionId, optionId: string) {
    const before = this.store.getPermission(id);
    if (before.decision !== undefined) {
      if (before.decision !== optionId)
        throw new HubError(
          "PERMISSION_CONFLICT",
          "A different decision was already recorded",
          409,
        );
      return before;
    }
    const active = this.active.get(before.sessionId);
    if (
      !active?.handle ||
      active.run.id !== before.runId ||
      active.run.generation !== before.generation ||
      active.stop
    )
      throw new HubError(
        "PERMISSION_EXPIRED",
        "Permission no longer belongs to an active run",
        409,
      );
    const permission = this.store.decidePermission(id, optionId);
    if (before.status === "pending")
      await active.handle.respondPermission(id, optionId);
    return permission;
  }
  async closeSession(id: SessionId): Promise<SessionRecord> {
    this.store.setSessionStatus(id, "closing");
    for (const run of this.store.listRuns(id))
      if (!isTerminal(run.status)) await this.stop(run.id, "cancelled");
    const active = this.active.get(id);
    if (active?.stopping) await active.stopping;
    await this.host.closeSession(id);
    // Wait for execute() to commit terminal status before publishing a closed session.
    await active?.settlement;
    return this.store.setSessionStatus(id, "closed");
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.store.listRuns())
      if (!isTerminal(run.status)) await this.stop(run.id, "cancelled");
    await this.host.close();
    await Promise.allSettled([...this.tasks]);
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
  }
}
