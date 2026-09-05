/** Public runtime records. These types carry no third-party SDK or storage implementation. */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type SessionId = Brand<string, "SessionId">;
export type RunId = Brand<string, "RunId">;
export type PermissionId = Brand<string, "PermissionId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_permission"
  | "cancelling"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";
export type TerminalStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled" | "timed_out" | "interrupted"
>;
export type CleanupStatus = "confirmed" | "unconfirmed" | "failed";

/** A locally registered engine. Credentials belong to process environment, never this record. */
export interface EngineProfile {
  id: string;
  driver: "fake" | "acp" | "cli";
  revision: string;
  enabled: boolean;
  command?: string[];
  model?: string;
  credentialEnv?: string[];
  cli?: { inputMode: "stdin" | "argv"; maxOutputBytes: number };
  maxConcurrency: number;
  capabilities: { resume: boolean; permissions: boolean; images: boolean };
}
export interface Workspace {
  id: string;
  path: string;
}
export interface SessionRecord {
  id: SessionId;
  engineId: string;
  profileRevision: string;
  workspaceId: string;
  cwd: string;
  status: "open" | "closing" | "closed";
  configSnapshot?: JsonObject;
  createdAt: number;
  updatedAt: number;
}
/** Test-only controls accepted exclusively by the explicitly enabled fake engine. */
export interface FakeOptions {
  scenario: "echo" | "wait" | "permission" | "fail" | "crash" | "artifact";
  delayMs?: number;
  chunks?: number;
}
export interface RunInput {
  text: string;
  timeoutMs: number;
  fixture?: FakeOptions;
}
export interface PublicError {
  code: string;
  message: string;
}
export interface RunRecord {
  id: RunId;
  sessionId: SessionId;
  generation: number;
  status: RunStatus;
  input: RunInput;
  configSnapshot?: JsonObject;
  createdAt: number;
  deadlineAt: number;
  startedAt?: number;
  finishedAt?: number;
  stopReason?: string;
  cleanupStatus: CleanupStatus;
  output?: string;
  error?: PublicError;
  lastSeq: number;
}
/** Committed event: sequence numbers and terminal events are allocated only by Store/Runtime. */
export interface AgentEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: SessionId;
  runId: RunId;
  seq: number;
  occurredAt: number;
  observedAt: number;
  type: string;
  data: JsonObject;
}
export interface EventDraft {
  type: string;
  data: JsonObject;
  occurredAt?: number;
  sourceSeq?: number;
}
export interface PermissionOption {
  id: string;
  label: string;
  kind: "allow_once" | "reject_once";
}
export interface PermissionRecord {
  id: PermissionId;
  sessionId: SessionId;
  runId: RunId;
  generation: number;
  toolCallId: string;
  prompt: string;
  options: PermissionOption[];
  status: "pending" | "decided" | "applied" | "expired";
  decision?: string;
  createdAt: number;
  expiresAt: number;
}
export interface ArtifactRecord {
  id: ArtifactId;
  runId: RunId;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  path: string;
  createdAt: number;
}
export interface DriverResult {
  status: "completed" | "cancelled" | "failed";
  stopReason?: string;
  output?: string;
  error?: PublicError;
}
export interface FinishInput {
  status: TerminalStatus;
  stopReason: string;
  cleanupStatus: CleanupStatus;
  output?: string;
  error?: PublicError;
}
/** True for immutable public execution outcomes; grading is a separate operation. */
export function isTerminal(status: RunStatus): status is TerminalStatus {
  return [
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ].includes(status);
}
