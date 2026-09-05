import { engineConfigurationSchema } from "./engine-configuration.js";
import { Ajv } from "ajv";
import type {
  ExecutionIdentity,
  ExecutionSpec,
  WorkerMessage,
} from "./ports.js";
import type { PermissionId } from "./types.js";
import { runInputSchema } from "./schemas.js";

/** IPC has one acknowledged Worker message in flight; oversized messages fail explicitly. */
export const IPC_MAX_BYTES = 8 * 1024 * 1024;
export type WorkerPayload = WorkerMessage extends infer Message
  ? Message extends WorkerMessage
    ? Omit<Message, keyof ExecutionIdentity | "version" | "seq">
    : never
  : never;
export type HostCommand =
  | { version: 1; type: "run"; spec: ExecutionSpec }
  | ({ version: 1; type: "cancel" } & ExecutionIdentity)
  | ({
      version: 1;
      type: "permission";
      permissionId: PermissionId;
      optionId: string;
    } & ExecutionIdentity)
  | ({ version: 1; type: "ack"; seq: number } & ExecutionIdentity)
  | { version: 1; type: "shutdown" };
export interface ReadyMessage {
  version: 1;
  type: "ready";
  pid: number;
}

const string = { type: "string", minLength: 1 };
const identity = {
  sessionId: string,
  runId: string,
  generation: { type: "integer", minimum: 1 },
};
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const option = object({
  id: string,
  label: string,
  kind: { enum: ["allow_once", "reject_once"] },
});
const error = object({ code: string, message: { type: "string" } });
const result = object(
  {
    status: { enum: ["completed", "cancelled", "failed"] },
    stopReason: string,
    output: { type: "string" },
    error,
  },
  ["status"],
);
const profile = object(
  {
    id: string,
    driver: { enum: ["fake", "acp", "cli"] },
    revision: string,
    enabled: { type: "boolean" },
    command: { type: "array", items: string, minItems: 1 },
    model: string,
    configuration: engineConfigurationSchema,
    cli: object({
      inputMode: { enum: ["stdin", "argv"] },
      maxOutputBytes: { type: "integer", minimum: 1, maximum: 4 * 1024 * 1024 },
    }),
    acp: object({ sessionMode: { const: "resume" } }),
    credentialEnv: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
    },
    maxConcurrency: { type: "integer", minimum: 1 },
    capabilities: object({
      resume: { type: "boolean" },
      permissions: { type: "boolean" },
      images: { type: "boolean" },
    }),
  },
  ["id", "driver", "revision", "enabled", "maxConcurrency", "capabilities"],
);
const spec = object(
  {
    ...identity,
    profile,
    cwd: string,
    stateDir: string,
    backendSessionId: string,
    input: { ...runInputSchema, required: ["text", "timeoutMs"] },
  },
  ["sessionId", "runId", "generation", "profile", "cwd", "stateDir", "input"],
);
const command = (
  type: string,
  properties: Record<string, unknown> = {},
  withIdentity = true,
) =>
  object({
    version: { const: 1 },
    type: { const: type },
    ...(withIdentity ? identity : {}),
    ...properties,
  });
const ajv = new Ajv({ strict: true });
const validateCommand = ajv.compile<HostCommand>({
  oneOf: [
    command("run", { spec }, false),
    command("cancel"),
    command("permission", { permissionId: string, optionId: string }),
    command("ack", { seq: { type: "integer", minimum: 1 } }),
    command("shutdown", {}, false),
  ],
});
const common = {
  version: { const: 1 },
  ...identity,
  seq: { type: "integer", minimum: 1 },
};
const message = (type: string, properties: Record<string, unknown> = {}) =>
  object({ ...common, type: { const: type }, ...properties });
const validateWorker = ajv.compile<WorkerMessage | ReadyMessage>({
  oneOf: [
    object({
      version: { const: 1 },
      type: { const: "ready" },
      pid: { type: "integer", minimum: 1 },
    }),
    message("started"),
    message("event", {
      event: object(
        {
          type: string,
          data: { type: "object" },
          occurredAt: { type: "number" },
          sourceSeq: { type: "integer", minimum: 1 },
        },
        ["type", "data"],
      ),
    }),
    message("permission", {
      permission: object({
        id: string,
        toolCallId: string,
        prompt: string,
        options: { type: "array", minItems: 1, items: option },
      }),
    }),
    message("permission_applied", { permissionId: string }),
    message("artifact", {
      artifact: object({
        name: string,
        mediaType: string,
        text: { type: "string" },
      }),
    }),
    message("result", { result }),
  ],
});

/** Validate raw IPC before asserting typed ownership. Unknown versions or fields are rejected. */
export function parseHostCommand(value: unknown): HostCommand {
  assertMessageSize(value);
  if (!validateCommand(value)) throw new Error("Invalid Host IPC message");
  return value;
}
export function parseWorkerMessage(
  value: unknown,
): WorkerMessage | ReadyMessage {
  assertMessageSize(value);
  if (!validateWorker(value)) throw new Error("Invalid Worker IPC message");
  return value;
}
export function assertMessageSize(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, "utf8") > IPC_MAX_BYTES
  )
    throw new Error("IPC message exceeds size limit");
}
export function matchesIdentity(
  left: ExecutionIdentity,
  right: ExecutionIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.generation === right.generation
  );
}
