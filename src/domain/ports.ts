import type {
  AgentEvent,
  ArtifactId,
  ArtifactRecord,
  CleanupStatus,
  DriverResult,
  EngineProfile,
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
  createSession(engine: EngineProfile, workspace: Workspace): SessionRecord;
  getSession(id: SessionId): SessionRecord;
  listSessions(): SessionRecord[];
  setSessionStatus(
    id: SessionId,
    status: SessionRecord["status"],
  ): SessionRecord;
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
export interface ExecutionSpec extends ExecutionIdentity {
  profile: EngineProfile;
  cwd: string;
  input: RunInput;
  stateDir: string;
}
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
