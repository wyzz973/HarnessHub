import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HubError } from "../domain/errors.js";
import type { Store } from "../domain/ports.js";
import { isTerminal } from "../domain/types.js";
import type {
  AgentEvent,
  ArtifactId,
  ArtifactRecord,
  EngineProfile,
  EventDraft,
  FinishInput,
  JsonObject,
  PermissionId,
  PermissionRecord,
  RunId,
  RunInput,
  RunRecord,
  RunStatus,
  SessionId,
  SessionRecord,
  TerminalStatus,
  Workspace,
} from "../domain/types.js";
import {
  artifactRecord,
  decodeRecord,
  eventRecord,
  permissionRecord,
  runRecord,
  sessionRecord,
} from "./records.js";

const terminalEvents = {
  completed: "RUN_COMPLETED",
  failed: "RUN_FAILED",
  cancelled: "RUN_CANCELLED",
  timed_out: "RUN_TIMED_OUT",
  interrupted: "RUN_INTERRUPTED",
} satisfies Record<TerminalStatus, string>;
const reservedEvents = new Set([
  ...Object.values(terminalEvents),
  "RUN_QUEUED",
  "RUN_STATUS",
  "PERMISSION_REQUESTED",
  "PERMISSION_DECIDED",
  "PERMISSION_APPLIED",
  "PERMISSION_EXPIRED",
  "ARTIFACT_CREATED",
]);

function inputHash(input: RunInput): string {
  // Known ordered fields normalize property order and absent optional controls.
  return createHash("sha256")
    .update(
      JSON.stringify({
        text: input.text,
        timeoutMs: input.timeoutMs,
        ...(input.outputs
          ? {
              outputs: input.outputs.map((o) => ({
                path: o.path,
                name: o.name,
                ...(o.mediaType ? { mediaType: o.mediaType } : {}),
              })),
            }
          : {}),
        ...(input.fixture
          ? {
              fixture: {
                scenario: input.fixture.scenario,
                delayMs: input.fixture.delayMs,
                chunks: input.fixture.chunks,
              },
            }
          : {}),
      }),
    )
    .digest("hex");
}

interface RuntimeOwner {
  pid: number;
  token: string;
  startedAt: number;
}

function runtimeOwner(value: unknown): value is RuntimeOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  return (
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    "startedAt" in value &&
    typeof value.startedAt === "number" &&
    Number.isSafeInteger(value.startedAt) &&
    value.startedAt >= 0
  );
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
    }
    throw error;
  }
}

function readSession(value: unknown): SessionRecord {
  const session = decodeRecord(value, sessionRecord);
  return {
    ...session,
    configSnapshot: session.configSnapshot ?? { status: "unknown" },
  };
}

function readRun(value: unknown): RunRecord {
  const run = decodeRecord(value, runRecord);
  return {
    ...run,
    configSnapshot: run.configSnapshot ?? { status: "unknown" },
  };
}

function configSnapshot(engine: EngineProfile): JsonObject {
  return {
    engineId: engine.id,
    driver: engine.driver,
    profileRevision: engine.revision,
    ...(engine.model !== undefined ? { model: engine.model } : {}),
    credentialEnv: [...(engine.credentialEnv ?? [])],
    maxConcurrency: engine.maxConcurrency,
    ...(engine.cli ? { cli: { ...engine.cli } } : {}),
    ...(engine.acp ? { acp: { ...engine.acp } } : {}),
    capabilities: { ...engine.capabilities },
    commandHash:
      engine.command === undefined
        ? null
        : createHash("sha256")
            .update(JSON.stringify(engine.command))
            .digest("hex"),
  };
}

/** Gateway-owned synchronous SQLite store. Each call completes a bounded transaction
 * before returning; event reads cap at 1,000 rows and there is no in-memory write queue.
 * The caller owns close(). A future schema version fails without modifying its tables.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private closed = false;
  private ownerToken: string | undefined;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:")
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      const version = this.db
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (version !== 0 && version !== 1)
        throw new HubError(
          "STORAGE_VERSION_UNSUPPORTED",
          "Database schema version is not supported by this build",
          500,
        );
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      if (version === 0)
        this.transaction(() =>
          this.db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)));
        CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL, idempotency_key TEXT, input_hash TEXT NOT NULL, created_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(session_id, idempotency_key), UNIQUE(session_id, generation));
        CREATE TABLE events (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL CHECK(seq > 0), event_id TEXT NOT NULL UNIQUE, source_seq INTEGER, type TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)), record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(run_id, seq), UNIQUE(run_id, source_seq));
        CREATE UNIQUE INDEX events_one_terminal ON events(run_id) WHERE terminal = 1;
        CREATE INDEX runs_session ON runs(session_id, generation);
        CREATE TABLE permissions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL CHECK(json_valid(record)));
        CREATE INDEX permissions_run ON permissions(run_id);
        CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL CHECK(json_valid(record)));
        CREATE INDEX artifacts_run ON artifacts(run_id);
        PRAGMA user_version = 1;
      `),
        );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "SQLite operation and rollback failed",
        );
      }
      throw error;
    }
  }

  /** Composition roots acquire the local Gateway ownership before recovery or accepting
   * work. Ordinary read/test connections do not acquire it. A live owner (including
   * another instance in this PID) produces 409; dead owners are replaced atomically.
   * Returned release callbacks are idempotent and can only remove their original token.
   */
  acquireOwner(): () => void {
    const token = this.transaction(() => {
      // Operational ownership metadata is separate from the versioned public records.
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)))",
      );
      const previous = this.db
        .prepare("SELECT value FROM runtime_metadata WHERE key = 'owner'")
        .get();
      if (previous) {
        const owner = decodeRecord(previous.value, runtimeOwner);
        if (owner.token === this.ownerToken && owner.pid === process.pid)
          return owner.token;
        if (pidIsAlive(owner.pid))
          throw new HubError(
            "RUNTIME_ALREADY_RUNNING",
            "Another live Gateway owns this database",
            409,
          );
      }
      const owner: RuntimeOwner = {
        pid: process.pid,
        token: randomUUID(),
        startedAt: Date.now(),
      };
      this.db
        .prepare(
          "INSERT INTO runtime_metadata (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(JSON.stringify(owner));
      return owner.token;
    });
    this.ownerToken = token;
    return () => this.releaseOwner(token);
  }

  private releaseOwner(token: string): void {
    if (this.closed) return;
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM runtime_metadata WHERE key = 'owner' AND json_extract(value, '$.token') = ?",
        )
        .run(token);
    });
    if (this.ownerToken === token) this.ownerToken = undefined;
  }

  /** Versioned operational catalog; the owner must acquire this database first. */
  readEngineCatalog(): unknown {
    if (!this.ownerToken)
      throw new Error("Engine catalog requires Gateway ownership");
    const row = this.db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'engine_catalog'",
      )
      .get();
    return row ? (JSON.parse(String(row.value)) as unknown) : undefined;
  }

  /** Commit a complete catalog revision before making it visible to new sessions. */
  writeEngineCatalog(value: unknown): void {
    if (!this.ownerToken)
      throw new Error("Engine catalog requires Gateway ownership");
    this.db
      .prepare(
        "INSERT INTO runtime_metadata (key, value) VALUES ('engine_catalog', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(value));
  }

  createSession(
    engine: EngineProfile,
    workspace: Workspace,
    routing?: JsonObject,
  ): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID() as SessionId,
      engineId: engine.id,
      profileRevision: engine.revision,
      workspaceId: workspace.id,
      cwd: workspace.path,
      status: "open",
      createdAt: now,
      updatedAt: now,
      configSnapshot: {
        ...configSnapshot(engine),
        ...(routing ? { routing } : {}),
      },
    };
    this.db
      .prepare("INSERT INTO sessions (id, created_at, record) VALUES (?, ?, ?)")
      .run(session.id, now, JSON.stringify(session));
    return session;
  }

  getSession(id: SessionId): SessionRecord {
    const row = this.db
      .prepare("SELECT record FROM sessions WHERE id = ?")
      .get(id);
    if (!row)
      throw new HubError("SESSION_NOT_FOUND", "Session does not exist", 404);
    return readSession(row.record);
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare("SELECT record FROM sessions ORDER BY created_at, rowid")
      .all()
      .map((row) => readSession(row.record));
  }

  setSessionStatus(
    id: SessionId,
    status: SessionRecord["status"],
  ): SessionRecord {
    return this.transaction(() => {
      const session = this.getSession(id);
      if (session.status === status) return session;
      if (
        session.status === "closed" ||
        (session.status === "closing" && status === "open")
      )
        throw new HubError(
          "SESSION_STATE_CONFLICT",
          "A closing or closed session cannot be reopened",
          409,
        );
      const updated = { ...session, status, updatedAt: Date.now() };
      this.db
        .prepare("UPDATE sessions SET record = ? WHERE id = ?")
        .run(JSON.stringify(updated), id);
      return updated;
    });
  }

  bindBackendSession(
    runId: RunId,
    backendSessionId: string,
    event: EventDraft,
  ): AgentEvent | undefined {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (isTerminal(run.status)) return undefined;
      if (
        event.type !== "engine.session" ||
        event.data.backendSessionId !== backendSessionId ||
        !backendSessionId
      )
        throw new HubError(
          "BACKEND_SESSION_INVALID",
          "Backend identity event is invalid",
          409,
        );
      const session = this.getSession(run.sessionId);
      if (
        session.backendSessionId !== undefined &&
        session.backendSessionId !== backendSessionId
      )
        throw new HubError(
          "BACKEND_SESSION_CHANGED",
          "An existing backend session cannot be replaced",
          409,
        );
      if (
        event.sourceSeq !== undefined &&
        this.db
          .prepare("SELECT 1 FROM events WHERE run_id = ? AND source_seq = ?")
          .get(runId, event.sourceSeq)
      )
        return undefined;
      this.db.prepare("UPDATE sessions SET record = ? WHERE id = ?").run(
        JSON.stringify({
          ...session,
          backendSessionId,
          updatedAt: Date.now(),
        }),
        session.id,
      );
      return this.insertEvent(run, event);
    });
  }

  acceptRun(
    sessionId: SessionId,
    input: RunInput,
    idempotencyKey?: string,
  ): { run: RunRecord; created: boolean } {
    const hash = inputHash(input);
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      if (idempotencyKey !== undefined) {
        if (idempotencyKey.length < 1 || idempotencyKey.length > 200)
          throw new HubError(
            "INVALID_IDEMPOTENCY_KEY",
            "Idempotency key must contain 1 to 200 characters",
          );
        const previous = this.db
          .prepare(
            "SELECT record, input_hash FROM runs WHERE session_id = ? AND idempotency_key = ?",
          )
          .get(sessionId, idempotencyKey);
        if (previous) {
          if (previous.input_hash !== hash)
            throw new HubError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was already used with different input",
              409,
            );
          return {
            run: readRun(previous.record),
            created: false,
          };
        }
      }
      if (session.status !== "open")
        throw new HubError(
          "SESSION_CLOSED",
          "Session is no longer accepting runs",
          409,
        );
      const generation = this.db
        .prepare(
          "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM runs WHERE session_id = ?",
        )
        .get(sessionId)?.generation;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation))
        throw new HubError(
          "STORAGE_CORRUPT",
          "Cannot allocate execution generation",
          500,
        );
      const now = Date.now();
      const run: RunRecord = {
        id: randomUUID() as RunId,
        sessionId,
        generation,
        status: "queued",
        input,
        createdAt: now,
        deadlineAt: now + input.timeoutMs,
        cleanupStatus: "unconfirmed",
        lastSeq: 0,
        configSnapshot: {
          ...session.configSnapshot,
          timeoutMs: input.timeoutMs,
        },
      };
      this.db
        .prepare(
          "INSERT INTO runs (id, session_id, generation, idempotency_key, input_hash, created_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          run.id,
          sessionId,
          generation,
          idempotencyKey ?? null,
          hash,
          now,
          JSON.stringify(run),
        );
      this.insertEvent(run, {
        type: "RUN_QUEUED",
        data: {
          status: "queued",
          generation,
          deadlineAt: run.deadlineAt,
          configSnapshotRef: run.id,
        },
      });
      return { run: this.getRun(run.id), created: true };
    });
  }

  findRunByKey(
    sessionId: SessionId,
    idempotencyKey: string,
  ): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT record FROM runs WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, idempotencyKey);
    return row ? readRun(row.record) : undefined;
  }

  getRun(id: RunId): RunRecord {
    const row = this.db.prepare("SELECT record FROM runs WHERE id = ?").get(id);
    if (!row) throw new HubError("RUN_NOT_FOUND", "Run does not exist", 404);
    return readRun(row.record);
  }

  listRuns(sessionId?: SessionId): RunRecord[] {
    if (sessionId !== undefined) {
      this.getSession(sessionId);
      return this.db
        .prepare(
          "SELECT record FROM runs WHERE session_id = ? ORDER BY generation",
        )
        .all(sessionId)
        .map((row) => readRun(row.record));
    }
    return this.db
      .prepare("SELECT record FROM runs ORDER BY created_at, rowid")
      .all()
      .map((row) => readRun(row.record));
  }

  private saveRun(run: RunRecord): void {
    this.db
      .prepare("UPDATE runs SET record = ? WHERE id = ?")
      .run(JSON.stringify(run), run.id);
  }

  setRunStatus(id: RunId, status: RunStatus): RunRecord {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (isTerminal(run.status) || run.status === status) return run;
      if (isTerminal(status))
        throw new HubError(
          "RUN_STATE_CONFLICT",
          "Terminal outcomes must be committed through finishRun",
          409,
        );
      const updated: RunRecord = {
        ...run,
        status,
        ...(status === "starting" && run.startedAt === undefined
          ? { startedAt: Date.now() }
          : {}),
      };
      this.saveRun(updated);
      this.insertEvent(updated, {
        type: "RUN_STATUS",
        data: { status, previousStatus: run.status },
      });
      return this.getRun(id);
    });
  }

  private insertEvent(
    run: RunRecord,
    draft: EventDraft,
    terminal = false,
  ): AgentEvent {
    const now = Date.now();
    const event: AgentEvent = {
      schemaVersion: 1,
      eventId: `${run.id}:${run.lastSeq + 1}`,
      sessionId: run.sessionId,
      runId: run.id,
      seq: run.lastSeq + 1,
      occurredAt: draft.occurredAt ?? now,
      observedAt: now,
      type: draft.type,
      data: draft.data,
    };
    this.db
      .prepare(
        "INSERT INTO events (run_id, seq, event_id, source_seq, type, terminal, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        event.seq,
        event.eventId,
        draft.sourceSeq ?? null,
        event.type,
        terminal ? 1 : 0,
        JSON.stringify(event),
      );
    this.saveRun({ ...run, lastSeq: event.seq });
    return event;
  }

  appendEvent(id: RunId, draft: EventDraft): AgentEvent | undefined {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (isTerminal(run.status)) return undefined;
      if (reservedEvents.has(draft.type))
        throw new HubError(
          "RESERVED_EVENT_TYPE",
          "Lifecycle events are owned by the Store",
          409,
        );
      if (draft.sourceSeq !== undefined) {
        if (!Number.isSafeInteger(draft.sourceSeq) || draft.sourceSeq < 0)
          throw new HubError(
            "INVALID_SOURCE_SEQUENCE",
            "Source sequence must be a non-negative integer",
          );
        if (
          this.db
            .prepare("SELECT 1 FROM events WHERE run_id = ? AND source_seq = ?")
            .get(id, draft.sourceSeq)
        )
          return undefined;
      }
      return this.insertEvent(run, draft);
    });
  }

  finishRun(id: RunId, input: FinishInput): RunRecord {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (isTerminal(run.status)) return run;
      for (const permission of this.listPermissions(id)) {
        if (permission.status === "pending" || permission.status === "decided")
          this.expirePermission(permission);
      }
      const finished: RunRecord = {
        ...this.getRun(id),
        ...input,
        finishedAt: Date.now(),
      };
      this.saveRun(finished);
      this.insertEvent(
        finished,
        {
          type: terminalEvents[input.status],
          data: {
            status: input.status,
            stopReason: input.stopReason,
            cleanupStatus: input.cleanupStatus,
            ...(input.output !== undefined ? { output: input.output } : {}),
            ...(input.error
              ? {
                  error: {
                    code: input.error.code,
                    message: input.error.message,
                  },
                }
              : {}),
          },
        },
        true,
      );
      return this.getRun(id);
    });
  }

  events(id: RunId, afterSeq = 0, limit = 1000): AgentEvent[] {
    this.getRun(id);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new HubError(
        "INVALID_EVENT_CURSOR",
        "Event cursor must be a non-negative integer",
      );
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new HubError(
        "INVALID_EVENT_LIMIT",
        "Event query limit must be a positive integer",
      );
    return this.db
      .prepare(
        "SELECT record FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(id, afterSeq, Math.min(limit, 1000))
      .map((row) => decodeRecord(row.record, eventRecord));
  }

  createPermission(permission: PermissionRecord): PermissionRecord {
    return this.transaction(() => {
      const run = this.getRun(permission.runId);
      if (
        run.sessionId !== permission.sessionId ||
        run.generation !== permission.generation ||
        isTerminal(run.status) ||
        run.status === "cancelling" ||
        run.status === "finalizing"
      )
        throw new HubError(
          "PERMISSION_OWNERSHIP_CONFLICT",
          "Permission does not belong to an active execution",
          409,
        );
      if (
        permission.status !== "pending" ||
        permission.decision !== undefined ||
        permission.options.length === 0 ||
        new Set(permission.options.map((option) => option.id)).size !==
          permission.options.length
      )
        throw new HubError(
          "INVALID_PERMISSION",
          "New permission must be pending with distinct options",
        );
      if (
        permission.expiresAt <= Date.now() ||
        permission.expiresAt > run.deadlineAt
      )
        throw new HubError(
          "PERMISSION_EXPIRED",
          "Permission validity must fall within the run deadline",
          409,
        );
      if (
        this.db
          .prepare("SELECT 1 FROM permissions WHERE id = ?")
          .get(permission.id)
      )
        throw new HubError(
          "PERMISSION_CONFLICT",
          "Permission ID already exists",
          409,
        );
      this.db
        .prepare(
          "INSERT INTO permissions (id, run_id, record) VALUES (?, ?, ?)",
        )
        .run(permission.id, permission.runId, JSON.stringify(permission));
      this.insertEvent(run, {
        type: "PERMISSION_REQUESTED",
        data: {
          permissionId: permission.id,
          toolCallId: permission.toolCallId,
          prompt: permission.prompt,
          options: permission.options.map((option) => ({ ...option })),
          expiresAt: permission.expiresAt,
          generation: permission.generation,
        },
      });
      return permission;
    });
  }

  getPermission(id: PermissionId): PermissionRecord {
    const row = this.db
      .prepare("SELECT record FROM permissions WHERE id = ?")
      .get(id);
    if (!row)
      throw new HubError(
        "PERMISSION_NOT_FOUND",
        "Permission does not exist",
        404,
      );
    return decodeRecord(row.record, permissionRecord);
  }

  private savePermission(permission: PermissionRecord): void {
    this.db
      .prepare("UPDATE permissions SET record = ? WHERE id = ?")
      .run(JSON.stringify(permission), permission.id);
  }

  private expirePermission(permission: PermissionRecord): PermissionRecord {
    const expired: PermissionRecord = { ...permission, status: "expired" };
    this.savePermission(expired);
    const run = this.getRun(permission.runId);
    if (!isTerminal(run.status))
      this.insertEvent(run, {
        type: "PERMISSION_EXPIRED",
        data: {
          permissionId: permission.id,
          toolCallId: permission.toolCallId,
        },
      });
    return expired;
  }

  decidePermission(id: PermissionId, optionId: string): PermissionRecord {
    const result = this.transaction(() => {
      const permission = this.getPermission(id);
      const run = this.getRun(permission.runId);
      if (
        permission.status === "expired" ||
        permission.expiresAt <= Date.now() ||
        isTerminal(run.status) ||
        run.status === "cancelling" ||
        run.status === "finalizing"
      ) {
        if (permission.status === "pending" || permission.status === "decided")
          this.expirePermission(permission);
        return new HubError(
          "PERMISSION_EXPIRED",
          "Permission no longer accepts decisions",
          409,
        );
      }
      if (!permission.options.some((option) => option.id === optionId))
        throw new HubError(
          "INVALID_PERMISSION_OPTION",
          "Option does not belong to this permission",
        );
      if (permission.status === "decided" || permission.status === "applied") {
        if (permission.decision !== optionId)
          throw new HubError(
            "PERMISSION_DECISION_CONFLICT",
            "Permission already has a different decision",
            409,
          );
        return permission;
      }
      const decided: PermissionRecord = {
        ...permission,
        status: "decided",
        decision: optionId,
      };
      this.savePermission(decided);
      this.insertEvent(run, {
        type: "PERMISSION_DECIDED",
        data: { permissionId: id, toolCallId: permission.toolCallId, optionId },
      });
      return decided;
    });
    if (result instanceof HubError) throw result;
    return result;
  }

  markPermissionApplied(id: PermissionId): PermissionRecord {
    return this.transaction(() => {
      const permission = this.getPermission(id);
      if (permission.status === "applied") return permission;
      const run = this.getRun(permission.runId);
      if (
        permission.status !== "decided" ||
        isTerminal(run.status) ||
        permission.expiresAt <= Date.now()
      )
        throw new HubError(
          "PERMISSION_STATE_CONFLICT",
          "Only a current persisted decision may be acknowledged",
          409,
        );
      if (permission.decision === undefined)
        throw new HubError(
          "STORAGE_CORRUPT",
          "Persisted permission decision is missing",
          500,
        );
      const applied: PermissionRecord = { ...permission, status: "applied" };
      this.savePermission(applied);
      this.insertEvent(run, {
        type: "PERMISSION_APPLIED",
        data: {
          permissionId: id,
          toolCallId: permission.toolCallId,
          optionId: permission.decision,
          acknowledgement: "worker",
        },
      });
      return applied;
    });
  }

  listPermissions(runId: RunId): PermissionRecord[] {
    this.getRun(runId);
    return this.db
      .prepare("SELECT record FROM permissions WHERE run_id = ? ORDER BY rowid")
      .all(runId)
      .map((row) => decodeRecord(row.record, permissionRecord));
  }

  registerArtifact(artifact: ArtifactRecord): ArtifactRecord {
    return this.transaction(() => {
      const run = this.getRun(artifact.runId);
      if (isTerminal(run.status))
        throw new HubError(
          "RUN_STATE_CONFLICT",
          "Cannot register artifacts after execution has ended",
          409,
        );
      if (
        this.db.prepare("SELECT 1 FROM artifacts WHERE id = ?").get(artifact.id)
      )
        throw new HubError(
          "ARTIFACT_CONFLICT",
          "Artifact ID already exists",
          409,
        );
      this.db
        .prepare("INSERT INTO artifacts (id, run_id, record) VALUES (?, ?, ?)")
        .run(artifact.id, artifact.runId, JSON.stringify(artifact));
      this.insertEvent(run, {
        type: "ARTIFACT_CREATED",
        data: {
          artifactId: artifact.id,
          name: artifact.name,
          mediaType: artifact.mediaType,
          size: artifact.size,
          sha256: artifact.sha256,
        },
      });
      return artifact;
    });
  }

  getArtifact(id: ArtifactId): ArtifactRecord {
    const row = this.db
      .prepare("SELECT record FROM artifacts WHERE id = ?")
      .get(id);
    if (!row)
      throw new HubError("ARTIFACT_NOT_FOUND", "Artifact does not exist", 404);
    return decodeRecord(row.record, artifactRecord);
  }

  listArtifacts(runId: RunId): ArtifactRecord[] {
    this.getRun(runId);
    return this.db
      .prepare("SELECT record FROM artifacts WHERE run_id = ? ORDER BY rowid")
      .all(runId)
      .map((row) => decodeRecord(row.record, artifactRecord));
  }

  close(): void {
    if (this.closed) return;
    if (this.ownerToken !== undefined) this.releaseOwner(this.ownerToken);
    this.db.close();
    this.closed = true;
  }
}
