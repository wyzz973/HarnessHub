import type { FastifyInstance } from "fastify";
import type { WorkflowService } from "../application/workflows.js";
import { errorResponseSchema } from "../domain/schemas.js";
import {
  workflowRequestSchema,
  workflowResponseSchema,
  type WorkflowId,
} from "../domain/workflows.js";

const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
};
const response = (code = 200) => ({
  [code]: workflowResponseSchema,
  default: errorResponseSchema,
});
/** Register before the application's preClose hook so workflow owners stop before Runtime shutdown. */
export function registerWorkflowRoutes(
  server: FastifyInstance,
  workflows: WorkflowService,
): void {
  server.get(
    "/v1/workflows",
    {
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["workflows"],
            properties: {
              workflows: { type: "array", items: workflowResponseSchema },
            },
          },
          default: errorResponseSchema,
        },
      },
    },
    async () => ({ workflows: workflows.list() }),
  );
  server.post<{ Body: unknown }>(
    "/v1/workflows",
    {
      schema: {
        body: workflowRequestSchema,
        headers: {
          type: "object",
          properties: {
            "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: response(202),
      },
    },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      return reply
        .code(202)
        .send(
          workflows.create(
            request.body,
            typeof key === "string" ? key : undefined,
          ),
        );
    },
  );
  server.get<{ Params: { id: string } }>(
    "/v1/workflows/:id",
    { schema: { params, response: response() } },
    async (request) => workflows.get(request.params.id as WorkflowId),
  );
  server.post<{ Params: { id: string } }>(
    "/v1/workflows/:id/approve",
    { schema: { params, response: response(202) } },
    async (request, reply) =>
      reply.code(202).send(workflows.approve(request.params.id as WorkflowId)),
  );
  server.post<{ Params: { id: string } }>(
    "/v1/workflows/:id/cancel",
    { schema: { params, response: response() } },
    async (request) => workflows.cancel(request.params.id as WorkflowId),
  );
}
