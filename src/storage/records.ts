import { isRelativeFilePath } from "../domain/files.js";
import { HubError } from "../domain/errors.js";
import type {
  AgentEvent,
  ArtifactRecord,
  JsonObject,
  JsonValue,
  PermissionRecord,
  RunInput,
  RunRecord,
  SessionRecord,
} from "../domain/types.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const string = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string =>
  string(value) && value.length > 0;
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  number(value) && Number.isSafeInteger(value) && value >= 0;
const optional = (
  value: unknown,
  check: (value: unknown) => boolean,
): boolean => value === undefined || check(value);
const member = (value: unknown, values: readonly string[]): boolean =>
  string(value) && values.includes(value);
const statuses = [
  "queued",
  "starting",
  "running",
  "waiting_permission",
  "cancelling",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
];

function json(value: unknown): value is JsonValue {
  return (
    value === null ||
    string(value) ||
    number(value) ||
    typeof value === "boolean" ||
    (Array.isArray(value)
      ? value.every(json)
      : object(value) && Object.values(value).every(json))
  );
}
function jsonObject(value: unknown): value is JsonObject {
  return object(value) && Object.values(value).every(json);
}
function runInput(value: unknown): value is RunInput {
  if (
    !object(value) ||
    !string(value.text) ||
    !integer(value.timeoutMs) ||
    value.timeoutMs < 1
  )
    return false;
  if (
    !optional(
      value.outputs,
      (outputs) =>
        Array.isArray(outputs) &&
        outputs.length > 0 &&
        outputs.length <= 32 &&
        outputs.every(
          (o) =>
            object(o) &&
            string(o.path) &&
            isRelativeFilePath(o.path) &&
            id(o.name) &&
            optional(o.mediaType, id),
        ),
    )
  )
    return false;
  const fixture = value.fixture;
  return (
    fixture === undefined ||
    (object(fixture) &&
      member(fixture.scenario, [
        "echo",
        "wait",
        "permission",
        "fail",
        "crash",
        "artifact",
      ]) &&
      optional(fixture.delayMs, integer) &&
      optional(fixture.chunks, integer))
  );
}
export function sessionRecord(value: unknown): value is SessionRecord {
  return (
    object(value) &&
    id(value.id) &&
    id(value.engineId) &&
    id(value.profileRevision) &&
    id(value.workspaceId) &&
    id(value.cwd) &&
    member(value.status, ["open", "closing", "closed"]) &&
    integer(value.createdAt) &&
    integer(value.updatedAt) &&
    optional(value.backendSessionId, id) &&
    optional(value.configSnapshot, jsonObject)
  );
}
export function runRecord(value: unknown): value is RunRecord {
  return (
    object(value) &&
    id(value.id) &&
    id(value.sessionId) &&
    integer(value.generation) &&
    value.generation > 0 &&
    member(value.status, statuses) &&
    runInput(value.input) &&
    integer(value.createdAt) &&
    integer(value.deadlineAt) &&
    integer(value.lastSeq) &&
    member(value.cleanupStatus, ["confirmed", "unconfirmed", "failed"]) &&
    optional(value.startedAt, integer) &&
    optional(value.finishedAt, integer) &&
    optional(value.stopReason, string) &&
    optional(value.output, string) &&
    optional(value.configSnapshot, jsonObject) &&
    optional(
      value.error,
      (error) => object(error) && string(error.code) && string(error.message),
    )
  );
}
export function eventRecord(value: unknown): value is AgentEvent {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    id(value.eventId) &&
    id(value.sessionId) &&
    id(value.runId) &&
    integer(value.seq) &&
    value.seq > 0 &&
    integer(value.occurredAt) &&
    integer(value.observedAt) &&
    id(value.type) &&
    jsonObject(value.data)
  );
}
export function permissionRecord(value: unknown): value is PermissionRecord {
  return (
    object(value) &&
    id(value.id) &&
    id(value.sessionId) &&
    id(value.runId) &&
    integer(value.generation) &&
    value.generation > 0 &&
    id(value.toolCallId) &&
    string(value.prompt) &&
    Array.isArray(value.options) &&
    value.options.length > 0 &&
    value.options.every(
      (option: unknown) =>
        object(option) &&
        id(option.id) &&
        string(option.label) &&
        member(option.kind, ["allow_once", "reject_once"]),
    ) &&
    member(value.status, ["pending", "decided", "applied", "expired"]) &&
    optional(value.decision, string) &&
    integer(value.createdAt) &&
    integer(value.expiresAt)
  );
}
export function artifactRecord(value: unknown): value is ArtifactRecord {
  return (
    object(value) &&
    id(value.id) &&
    id(value.runId) &&
    id(value.name) &&
    id(value.mediaType) &&
    integer(value.size) &&
    string(value.sha256) &&
    /^[a-f0-9]{64}$/i.test(value.sha256) &&
    id(value.path) &&
    integer(value.createdAt)
  );
}

/** The SQLite JSON boundary rejects malformed or incompatible persisted records. */
export function decodeRecord<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
): T {
  if (!string(value))
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted record is not JSON text",
      500,
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted record contains invalid JSON",
      500,
    );
  }
  if (!validate(decoded))
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted record does not match schema version 1",
      500,
    );
  return decoded;
}
