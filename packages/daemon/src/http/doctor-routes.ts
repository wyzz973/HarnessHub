// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyReply } from "fastify";
import { doctorChecks } from "@harnesshub/core/provider-doctor";
import { wireProtocols } from "@harnesshub/core/model-plane";
import type { DoctorOptions, ProviderDoctor } from "../provider-doctor.js";
import { idParams, responses } from "./api-v1-schemas.js";

/** The doctor as the API needs it (`ProviderDoctor` of ../provider-doctor.ts). */
export type DoctorService = Pick<ProviderDoctor, "plan" | "run" | "test">;

const protocol = { enum: [...wireProtocols] } as const;
const model = { type: "string", pattern: "^\\S{1,512}$" } as const;

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "model",
    "wireModel",
    "protocol",
    "deep",
    "modelCalls",
    "maxModelCalls",
    "listRequests",
    "estimatedTokens",
    "estimatedCostUsd",
    "checks",
  ],
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    wireModel: { type: "string" },
    protocol,
    deep: { type: "boolean" },
    modelCalls: { type: "integer" },
    maxModelCalls: { type: "integer" },
    listRequests: { type: "integer" },
    estimatedTokens: {
      type: "object",
      additionalProperties: false,
      required: ["input", "output"],
      properties: {
        input: { type: "integer" },
        output: { type: "integer" },
      },
    },
    estimatedCostUsd: { type: ["number", "null"] },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "modelCalls"],
        properties: {
          check: { enum: [...doctorChecks] },
          modelCalls: { type: "integer" },
        },
      },
    },
  },
} as const;

const itemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["check", "status", "summary", "details", "suggestions"],
  properties: {
    check: { enum: [...doctorChecks] },
    status: { enum: ["pass", "warn", "fail", "skip"] },
    summary: { type: "string" },
    details: { type: "array", items: { type: "string" } },
    excerpt: { type: "string" },
    httpStatus: { type: "integer" },
    url: { type: "string" },
    suggestions: { type: "array", items: { type: "string" } },
    patch: { type: "object", additionalProperties: true },
    values: {
      type: "object",
      additionalProperties: { type: "number" },
    },
  },
} as const;

/** `dryRun` returns the plan alone; otherwise the full report. */
const doctorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: {
    plan: planSchema,
    startedAt: { type: "string", format: "date-time" },
    durationMs: { type: "integer" },
    modelCalls: { type: "integer" },
    costUsd: { type: "number" },
    unpricedCalls: { type: "integer" },
    items: { type: "array", items: itemSchema },
    patch: { type: "object", additionalProperties: true },
  },
} as const;

const doctorBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    model,
    deep: { type: "boolean" },
    slowMs: { type: "integer", minimum: 1, maximum: 600_000 },
    dryRun: { type: "boolean" },
  },
} as const;

const testBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { model },
} as const;

const testResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "model",
    "wireModel",
    "endpoints",
    "modelCalls",
    "costUsd",
    "unpricedCalls",
  ],
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    wireModel: { type: "string" },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "url", "ok", "status", "durationMs"],
        properties: {
          protocol,
          url: { type: "string" },
          ok: { type: "boolean" },
          status: { type: "integer" },
          durationMs: { type: "integer" },
          firstByteMs: { type: "integer" },
          servedModel: { type: "string" },
          error: { type: "string" },
        },
      },
    },
    modelCalls: { type: "integer" },
    costUsd: { type: "number" },
    unpricedCalls: { type: "integer" },
  },
} as const;

/** Aborted when the client goes away before the answer was sent. */
function clientGone(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished)
      abort.abort(new Error("The client disconnected"));
  });
  return abort.signal;
}

/**
 * `POST /api/v1/providers/{id}/test` and `/doctor` (03 section 9). Both send
 * real requests to the provider's upstream, each recorded in the ledger
 * under `client:doctor`; `dryRun` returns only the plan. Registered inside
 * the `/api/v1` plugin, so the admin token and loopback rules apply.
 */
export function registerDoctorRoutes(
  api: FastifyInstance,
  doctor: DoctorService,
): void {
  api.post<{ Params: { id: string }; Body: { model?: string } }>(
    "/providers/:id/test",
    {
      schema: {
        params: idParams,
        body: testBodySchema,
        response: responses(testResponseSchema),
      },
    },
    async (request, reply) =>
      doctor.test(
        request.params.id,
        request.body.model !== undefined ? { model: request.body.model } : {},
        clientGone(reply),
      ),
  );
  api.post<{
    Params: { id: string };
    Body: DoctorOptions & { dryRun?: boolean };
  }>(
    "/providers/:id/doctor",
    {
      schema: {
        params: idParams,
        body: doctorBodySchema,
        response: responses(doctorResponseSchema),
      },
    },
    async (request, reply) => {
      const { dryRun, ...options } = request.body;
      return dryRun
        ? { plan: await doctor.plan(request.params.id, options) }
        : doctor.run(request.params.id, options, clientGone(reply));
    },
  );
}
