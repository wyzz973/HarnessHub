// SPDX-License-Identifier: MIT
import type { ConfigurationAdapter } from "./engine-configuration.js";
import type {
  AgentEvent,
  ArtifactId,
  ArtifactRecord,
  CleanupStatus,
  DriverResult,
  EngineProfile,
  JsonObject,
  FileOutput,
  EventDraft,
  FinishInput,
  PermissionId,
  PermissionRecord,
  RunId,
  RunInput,
  RunRecord,
  RunStatus,
  SessionId,
  SessionRecord,
  Workspace,
} from "./types.js";

/** Synchronous bounded transactions; implementation must never expose uncommitted events. */
export interface Store {
  createSession(
    engine: EngineProfile,
    workspace: Workspace,
    routing?: JsonObject,
  ): SessionRecord;
  getSession(id: SessionId): SessionRecord;
  listSessions(): SessionRecord[];
  setSessionStatus(
    id: SessionId,
    status: SessionRecord["status"],
  ): SessionRecord;
  /** Bind the immutable backend identity and commit its source event in one transaction. */
  bindBackendSession(
    runId: RunId,
    backendSessionId: string,
    event: EventDraft,
  ): AgentEvent | undefined;
  acceptRun(
    sessionId: SessionId,
    input: RunInput,
    idempotencyKey?: string,
  ): { run: RunRecord; created: boolean };
  findRunByKey(
    sessionId: SessionId,
    idempotencyKey: string,
  ): RunRecord | undefined;
  getRun(id: RunId): RunRecord;
  listRuns(sessionId?: SessionId): RunRecord[];
  setRunStatus(id: RunId, status: RunStatus): RunRecord;
  appendEvent(id: RunId, draft: EventDraft): AgentEvent | undefined;
  finishRun(id: RunId, input: FinishInput): RunRecord;
  events(id: RunId, afterSeq?: number, limit?: number): AgentEvent[];
  createPermission(permission: PermissionRecord): PermissionRecord;
  getPermission(id: PermissionId): PermissionRecord;
  decidePermission(id: PermissionId, optionId: string): PermissionRecord;
  markPermissionApplied(id: PermissionId): PermissionRecord;
  listPermissions(runId: RunId): PermissionRecord[];
  registerArtifact(artifact: ArtifactRecord): ArtifactRecord;
  getArtifact(id: ArtifactId): ArtifactRecord;
  listArtifacts(runId: RunId): ArtifactRecord[];
  close(): void;
}

/** Full execution identity is repeated on every Worker message to reject stale controls. */
export interface ExecutionIdentity {
  sessionId: SessionId;
  runId: RunId;
  generation: number;
}
/**
 * The daemon's shared model gateway as one Session's engine reaches it
 * (03 section 10). `key` is a `session:` Gateway Key: a secret that only
 * the Worker and its engine see; never log, store or publish it.
 */
export interface SessionModelGateway {
  /** Origin of the daemon port, without `/v1`. */
  baseUrl: string;
  key: string;
  /** The engine's adapter, declared or inferred from its built-in recipe. */
  adapter: ConfigurationAdapter;
  /** Window and output limit written into engine configurations, when the target declares them. */
  contextWindow?: number;
  maxOutputTokens?: number;
}
export interface ExecutionSpec extends ExecutionIdentity {
  profile: EngineProfile;
  cwd: string;
  input: RunInput;
  stateDir: string;
  backendSessionId?: string;
  /** Present when the Session's engine talks to the daemon's shared model gateway. */
  modelGateway?: SessionModelGateway;
}
/** The committed model calls of one Run through the shared gateway, after all of them ended. */
export interface ModelCallSummary {
  calls: number;
  successfulCalls: number;
  /** Public message of the last failed call; cancelled calls do not count. */
  lastError?: string;
}
/**
 * The shared model gateway's side of Session Runs (03 section 10),
 * implemented by the composition root. `begin` and `end` bracket every Run
 * that `begin` returned a gateway for; `close` follows the Session's close.
 */
export interface RunModelPort {
  /**
   * Called before the Run's Worker starts. Returns the Worker's gateway
   * configuration when the Session's engine uses the shared gateway, and
   * makes the Run the Session's active Run. Rejects with a HubError when the
   * Run's model selection cannot be served; the Run then fails with it.
   */
  begin(
    session: SessionRecord,
    run: RunRecord,
    profile: EngineProfile,
  ): Promise<SessionModelGateway | undefined>;
  /**
   * Called once the Run's backend result is known, or it stopped. Ends the
   * active Run (later calls get 409), cancels its calls in flight, waits
   * until all of them are committed and returns their summary.
   */
  end(session: SessionRecord, run: RunRecord): Promise<ModelCallSummary>;
  /** Called after the Session closed: revokes its key once its calls ended. Idempotent. */
  close(sessionId: SessionId): Promise<void>;
}
/** Gateway collects complete immutable copies before registering their metadata. */
export type FileArtifactCollector = (
  runId: RunId,
  cwd: string,
  outputs: FileOutput[],
  signal: AbortSignal,
) => Promise<{ artifacts: ArtifactRecord[]; missing: string[] }>;
export type WorkerMessage = ExecutionIdentity & { version: 1; seq: number } & (
    | { type: "started" }
    | { type: "event"; event: EventDraft }
    | {
        type: "permission";
        permission: {
          id: PermissionId;
          toolCallId: string;
          prompt: string;
          options: PermissionRecord["options"];
        };
      }
    | { type: "permission_applied"; permissionId: PermissionId }
    | {
        type: "artifact";
        artifact: { name: string; mediaType: string; text: string };
      }
    | { type: "result"; result: DriverResult }
  );
/** Handle for one run; cancel acknowledges a request, result reports backend settlement. */
export interface ExecutionHandle {
  result: Promise<DriverResult>;
  cancel(): Promise<void>;
  respondPermission(id: PermissionId, optionId: string): Promise<void>;
}
/** Owns session Worker processes. closeSession must await process exit or report unconfirmed. */
export interface WorkerHost {
  start(
    spec: ExecutionSpec,
    sink: (message: WorkerMessage) => Promise<void>,
  ): Promise<ExecutionHandle>;
  closeSession(id: SessionId): Promise<CleanupStatus>;
  close(): Promise<void>;
}
