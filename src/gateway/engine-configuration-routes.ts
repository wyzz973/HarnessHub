// SPDX-License-Identifier: MIT
import {
  configurationAdapters,
  secretReferenceSchema,
} from "@harnesshub/core/engine-configuration";
import type { FastifyInstance } from "fastify";
import type { ConfigurationManagement } from "@harnesshub/core/engine-configuration";
import {
  engineRegistrationSchema,
  engineResponseSchema,
  discoveryResponseSchema,
  errorResponseSchema,
} from "@harnesshub/core/schemas";
const adaptersResponse = {
  type: "object",
  required: ["adapters"],
  properties: {
    adapters: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "providerProtocols", "description"],
        properties: {
          id: { enum: configurationAdapters },
          providerProtocols: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
      },
    },
  },
};
const testResponse = {
  type: "object",
  required: ["engineId", "revision", "checkedAt", "modelCalled", "checks"],
  properties: {
    engineId: { type: "string" },
    revision: { type: "string" },
    checkedAt: { type: "integer" },
    modelCalled: { const: false },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "status", "message"],
        properties: {
          name: { type: "string" },
          status: { enum: ["passed", "failed"] },
          message: { type: "string" },
        },
      },
    },
  },
};
const responses = (schema: object) => ({
  200: schema,
  default: errorResponseSchema,
});
/** Local-only configuration routes inherit Gateway host/origin checks. Secret values are write-only. */
export function registerEngineConfigurationRoutes(
  server: FastifyInstance,
  configuration: ConfigurationManagement,
): void {
  server.get(
    "/v1/engine-configuration/templates",
    { schema: { response: responses(discoveryResponseSchema) } },
    async () => ({ candidates: await configuration.templates() }),
  );
  server.get(
    "/v1/engine-configuration/adapters",
    { schema: { response: responses(adaptersResponse) } },
    async () => ({ adapters: configuration.adapters() }),
  );
  server.post<{ Body: unknown }>(
    "/v1/engine-configuration/inspect",
    {
      schema: {
        body: engineRegistrationSchema,
        response: responses(engineResponseSchema),
      },
    },
    async (request) => configuration.inspect(request.body),
  );
  server.post<{ Params: { id: string } }>(
    "/v1/engines/:id/test",
    { schema: { response: responses(testResponse) } },
    async (request) => configuration.test(request.params.id),
  );
  server.post<{ Body: { value: string } }>(
    "/v1/secrets",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: {
            value: { type: "string", minLength: 1, maxLength: 8192 },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["reference"],
            properties: { reference: secretReferenceSchema },
          },
          default: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send({
        reference: await configuration.createSecret(request.body.value),
      }),
  );
}
