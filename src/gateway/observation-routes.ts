import type { FastifyInstance } from "fastify";
import type { ObservationService } from "../application/observability.js";
import type { RunId } from "../domain/types.js";
import { errorResponseSchema } from "../domain/schemas.js";

const nullableNumber = { type: ["number", "null"], minimum: 0 };
const nullableString = { type: ["string", "null"] };
const tokenSchema = {
  type: "object",
  required: [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "total",
  ],
  properties: {
    input: nullableNumber,
    output: nullableNumber,
    cacheRead: nullableNumber,
    cacheWrite: nullableNumber,
    reasoning: nullableNumber,
    total: nullableNumber,
  },
};
const costSchema = {
  type: "object",
  required: ["amount", "currency", "kind", "source", "missingReason"],
  properties: {
    amount: nullableNumber,
    currency: nullableString,
    kind: { enum: ["reported", "estimated", "unknown"] },
    source: nullableString,
    missingReason: nullableString,
  },
};
const usageSchema = {
  type: ["object", "null"],
  properties: {
    schemaVersion: { const: 1 },
    scope: { enum: ["run", "session"] },
    source: { type: "string" },
    backendSessionId: { type: "string" },
    requestId: { type: "string" },
    tokens: tokenSchema,
    cost: costSchema,
    model: nullableString,
    missingReason: nullableString,
  },
};
const numberProperties = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, nullableNumber]));
const countProperties = (names: string[]) =>
  Object.fromEntries(
    names.map((name) => [name, { type: "integer", minimum: 0 }]),
  );
export const runObservationSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "runId",
    "sessionId",
    "engineId",
    "status",
    "cleanupStatus",
    "prompt",
    "model",
    "timings",
    "tokens",
    "cost",
    "usage",
    "sessionUsage",
    "counts",
    "versions",
    "coverage",
  ],
  properties: {
    schemaVersion: { const: 1 },
    runId: { type: "string" },
    sessionId: { type: "string" },
    engineId: { type: "string" },
    status: { type: "string" },
    cleanupStatus: { enum: ["confirmed", "unconfirmed", "failed"] },
    prompt: { type: "string" },
    model: {
      type: "object",
      properties: {
        configured: nullableString,
        actual: nullableString,
        source: nullableString,
        missingReason: nullableString,
      },
    },
    timings: {
      type: "object",
      properties: numberProperties([
        "acceptedAt",
        "startedAt",
        "firstOutputAt",
        "finishedAt",
        "queueMs",
        "startupMs",
        "timeToFirstOutputMs",
        "durationMs",
        "executionMs",
        "cleanupMs",
      ]),
    },
    tokens: tokenSchema,
    cost: costSchema,
    usage: {
      type: "object",
      properties: {
        scope: { enum: ["run", "session", "unknown"] },
        source: nullableString,
        missingReason: nullableString,
      },
    },
    sessionUsage: usageSchema,
    counts: {
      type: "object",
      properties: countProperties([
        "outputCharacters",
        "reasoningCharacters",
        "toolCalls",
        "permissions",
        "artifacts",
        "artifactBytes",
      ]),
    },
    versions: {
      type: "object",
      properties: {
        driver: nullableString,
        profileRevision: { type: "string" },
        installation: { type: ["object", "null"], additionalProperties: true },
      },
    },
    coverage: {
      type: "object",
      properties: {
        eventsComplete: { type: "boolean" },
        usage: { type: "boolean" },
        model: { type: "boolean" },
        installation: { type: "boolean" },
        missingReasons: { type: "array", items: { type: "string" } },
      },
    },
  },
};
const overviewSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "generatedAt",
    "scope",
    "summary",
    "engines",
    "recentRuns",
  ],
  properties: {
    schemaVersion: { const: 1 },
    generatedAt: { type: "number" },
    scope: {
      type: "object",
      properties: countProperties(["limit", "totalRuns", "sampledRuns"]),
    },
    summary: {
      type: "object",
      properties: {
        ...countProperties([
          "totalRuns",
          "activeRuns",
          "completedRuns",
          "failedRuns",
          "cancelledRuns",
          "timedOutRuns",
          "interruptedRuns",
          "usageObservedRuns",
        ]),
        ...numberProperties([
          "p50DurationMs",
          "p95DurationMs",
          "knownInputTokens",
          "knownOutputTokens",
          "knownTotalTokens",
          "usageCoverage",
        ]),
      },
    },
    engines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          enabled: { type: "boolean" },
          ...countProperties([
            "maxConcurrency",
            "activeRuns",
            "queuedRuns",
            "completedRuns",
            "failedRuns",
          ]),
          ...numberProperties(["p50DurationMs", "p95DurationMs"]),
        },
      },
    },
    recentRuns: { type: "array", items: runObservationSchema },
  },
};
/** Register only committed read projections; request validation and OpenAPI share these schemas. */
export function registerObservationRoutes(
  server: FastifyInstance,
  service: ObservationService,
): void {
  server.get<{ Params: { id: string } }>(
    "/v1/runs/:id/observations",
    {
      schema: {
        tags: ["observability"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
        },
        response: { 200: runObservationSchema, default: errorResponseSchema },
      },
    },
    async (request) => service.run(request.params.id as RunId),
  );
  server.get<{ Querystring: { limit?: number } }>(
    "/v1/observability",
    {
      schema: {
        tags: ["observability"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
        },
        response: { 200: overviewSchema, default: errorResponseSchema },
      },
    },
    async (request) => service.overview(request.query),
  );
}
