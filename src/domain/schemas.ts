/** Schemas for untrusted HTTP inputs. Defaults are resolved by application configuration. */
export const createSessionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    engineId: { type: "string", minLength: 1, maxLength: 100 },
    workspaceId: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;
export const runInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 1_048_576 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
    fixture: {
      type: "object",
      additionalProperties: false,
      required: ["scenario"],
      properties: {
        scenario: {
          enum: ["echo", "wait", "permission", "fail", "crash", "artifact"],
        },
        delayMs: { type: "integer", minimum: 0, maximum: 60_000 },
        chunks: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
  },
} as const;
export const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["optionId"],
  properties: { optionId: { type: "string", minLength: 1, maxLength: 500 } },
} as const;

const text = { type: "string" } as const;
const timestamp = { type: "integer", minimum: 0 } as const;
const jsonObject = { type: "object", additionalProperties: true } as const;
const publicError = {
  type: "object",
  required: ["code", "message"],
  properties: { code: text, message: text },
  additionalProperties: false,
} as const;
export const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      ...publicError,
      properties: {
        ...publicError.properties,
        details: { type: "array", items: jsonObject },
      },
    },
  },
} as const;
export const sessionResponseSchema = {
  type: "object",
  required: [
    "id",
    "engineId",
    "profileRevision",
    "workspaceId",
    "cwd",
    "status",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
  properties: {
    id: text,
    engineId: text,
    profileRevision: text,
    workspaceId: text,
    cwd: text,
    status: { enum: ["open", "closing", "closed"] },
    createdAt: timestamp,
    updatedAt: timestamp,
    configSnapshot: jsonObject,
  },
} as const;
export const permissionResponseSchema = {
  type: "object",
  required: [
    "id",
    "sessionId",
    "runId",
    "generation",
    "toolCallId",
    "prompt",
    "options",
    "status",
    "createdAt",
    "expiresAt",
  ],
  additionalProperties: false,
  properties: {
    id: text,
    sessionId: text,
    runId: text,
    generation: timestamp,
    toolCallId: text,
    prompt: text,
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label", "kind"],
        properties: {
          id: text,
          label: text,
          kind: { enum: ["allow_once", "reject_once"] },
        },
      },
    },
    status: { enum: ["pending", "decided", "applied", "expired"] },
    decision: text,
    createdAt: timestamp,
    expiresAt: timestamp,
  },
} as const;
export const artifactResponseSchema = {
  type: "object",
  required: ["id", "runId", "name", "mediaType", "size", "sha256", "createdAt"],
  additionalProperties: false,
  properties: {
    id: text,
    runId: text,
    name: text,
    mediaType: text,
    size: timestamp,
    sha256: text,
    createdAt: timestamp,
  },
} as const;
export const runResponseSchema = {
  type: "object",
  required: [
    "id",
    "sessionId",
    "generation",
    "status",
    "input",
    "createdAt",
    "deadlineAt",
    "cleanupStatus",
    "lastSeq",
  ],
  additionalProperties: false,
  properties: {
    id: text,
    sessionId: text,
    generation: timestamp,
    status: {
      enum: [
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
      ],
    },
    input: { ...runInputSchema, required: ["text", "timeoutMs"] },
    configSnapshot: jsonObject,
    createdAt: timestamp,
    deadlineAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    stopReason: text,
    cleanupStatus: { enum: ["confirmed", "unconfirmed", "failed"] },
    output: text,
    error: publicError,
    lastSeq: timestamp,
    replayed: { type: "boolean" },
    permissions: { type: "array", items: permissionResponseSchema },
    artifacts: { type: "array", items: artifactResponseSchema },
  },
} as const;
export const enginesResponseSchema = {
  type: "object",
  required: ["engines"],
  properties: {
    engines: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "driver", "revision", "enabled", "capabilities"],
        properties: {
          id: text,
          driver: { enum: ["fake", "acp"] },
          revision: text,
          enabled: { type: "boolean" },
          command: { type: "array", items: text },
          model: text,
          credentialEnv: { type: "array", items: text },
          maxConcurrency: timestamp,
          capabilities: jsonObject,
        },
        additionalProperties: false,
      },
    },
  },
} as const;
