import { engineConfigurationSchema } from "./engine-configuration.js";
/** Schemas for untrusted HTTP inputs. Defaults are resolved by application configuration. */
export const fileOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "name"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1024 },
    name: { type: "string", minLength: 1, maxLength: 255 },
    mediaType: { type: "string", minLength: 1, maxLength: 255 },
  },
} as const;
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
    outputs: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: fileOutputSchema,
    },
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
    backendSessionId: text,
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
          driver: { enum: ["fake", "acp", "cli"] },
          revision: text,
          enabled: { type: "boolean" },
          command: { type: "array", items: text },
          model: text,
          configuration: engineConfigurationSchema,
          credentialEnv: { type: "array", items: text },
          cli: jsonObject,
          acp: jsonObject,
          maxConcurrency: timestamp,
          capabilities: jsonObject,
        },
        additionalProperties: false,
      },
    },
  },
} as const;

/** Management commands accept registrations, never computed revision/capability claims. */
export const engineRegistrationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "driver", "command"],
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$" },
    driver: { enum: ["acp", "cli"] },
    command: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: { type: "string", minLength: 1, maxLength: 8192 },
    },
    enabled: { type: "boolean" },
    model: { type: "string", minLength: 1 },
    configuration: engineConfigurationSchema,
    credentialEnv: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$" },
    },
    maxConcurrency: { type: "integer", minimum: 1, maximum: 86400000 },
    acp: {
      type: "object",
      additionalProperties: false,
      required: ["sessionMode"],
      properties: { sessionMode: { const: "resume" } },
    },
    cli: {
      type: "object",
      additionalProperties: false,
      properties: {
        inputMode: { enum: ["stdin", "argv"] },
        maxOutputBytes: { type: "integer", minimum: 1, maximum: 4194304 },
      },
    },
  },
} as const;
export const engineResponseSchema =
  enginesResponseSchema.properties.engines.items;
export const discoveryResponseSchema = {
  type: "object",
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "executable", "source", "status", "notes"],
        properties: {
          id: text,
          name: text,
          executable: text,
          source: { enum: ["path", "known-location", "manifest"] },
          status: { enum: ["ready", "adapter-required"] },
          registration: engineRegistrationSchema,
          notes: { type: "array", items: text },
        },
      },
    },
  },
} as const;
export const registryStatusSchema = {
  type: "object",
  required: ["defaultEngine", "watching", "lastReloadAt", "lastError"],
  properties: {
    defaultEngine: text,
    watching: { type: "boolean" },
    lastReloadAt: { anyOf: [timestamp, { type: "null" }] },
    lastError: { anyOf: [text, { type: "null" }] },
  },
} as const;
