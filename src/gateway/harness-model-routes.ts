import type { FastifyInstance } from "fastify";
import type {
  HarnessModelManagement,
  RuntimeInfo,
} from "../application/harness-model.js";
import { engineConfigurationSchema } from "../domain/engine-configuration.js";
import { errorResponseSchema } from "../domain/schemas.js";

const providerSchema = engineConfigurationSchema.properties.provider;
const aliasSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
} as const;
/**
 * Request shape of the unified model. The service additionally requires
 * `provider.protocol = openai-completions`, an HTTP(S) `baseUrl` without credentials,
 * query or fragment, secret references only, and no sensitive plain headers.
 */
export const harnessModelSchema = {
  type: "object",
  additionalProperties: false,
  required: ["model", "provider"],
  properties: {
    model: { type: "string", minLength: 1, maxLength: 256 },
    alias: aliasSchema,
    provider: {
      ...providerSchema,
      required: ["protocol", "baseUrl"],
    },
  },
} as const;
export const harnessModelViewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configured", "alias", "engines"],
  properties: {
    configured: { type: "boolean" },
    source: { enum: ["environment", "file", "settings"] },
    model: { type: "string" },
    alias: { type: "string" },
    provider: providerSchema,
    engines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["engineId", "status"],
        properties: {
          engineId: { type: "string" },
          status: { enum: ["applied", "unsupported", "disabled"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;
const testRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    engineId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$" },
  },
} as const;
const testResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "status", "durationMs", "runId"],
  properties: {
    ok: { type: "boolean" },
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
    durationMs: { type: "integer", minimum: 0 },
    runId: { type: "string" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
} as const;
const runtimeInfoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competition", "fullAccess"],
  properties: {
    competition: { type: "boolean" },
    competitionEngine: { type: "string" },
    fullAccess: { type: "boolean" },
    consoleUrl: { type: "string" },
  },
} as const;
const responses = (schema: object) => ({
  200: schema,
  default: errorResponseSchema,
});

/**
 * Unified model (ADR 0013) and runtime-mode routes. They inherit the Gateway
 * loopback/origin checks; responses carry secret references only. The test route calls
 * the configured model through a real engine Session.
 */
export function registerHarnessModelRoutes(
  server: FastifyInstance,
  management: HarnessModelManagement,
  runtimeInfo: () => RuntimeInfo,
): void {
  server.get(
    "/v1/harness/model",
    { schema: { response: responses(harnessModelViewSchema) } },
    async () => management.view(),
  );
  server.put(
    "/v1/harness/model",
    {
      schema: {
        body: harnessModelSchema,
        response: responses(harnessModelViewSchema),
      },
    },
    async (request) => management.set(request.body),
  );
  server.post(
    "/v1/harness/model/test",
    {
      schema: {
        body: testRequestSchema,
        response: responses(testResponseSchema),
      },
    },
    async (request) => management.test(request.body),
  );
  server.get(
    "/v1/runtime/info",
    { schema: { response: responses(runtimeInfoSchema) } },
    async () => runtimeInfo(),
  );
}
