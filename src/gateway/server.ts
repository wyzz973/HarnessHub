import { once } from "node:events";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import Fastify, { type FastifyError } from "fastify";
import swagger from "@fastify/swagger";
import type { HubApplication } from "../application/service.js";
import { HubError } from "../domain/errors.js";
import {
  createSessionSchema,
  decisionSchema,
  runInputSchema,
  sessionResponseSchema,
  runResponseSchema,
  permissionResponseSchema,
  errorResponseSchema,
  enginesResponseSchema,
} from "../domain/schemas.js";
import { isTerminal } from "../domain/types.js";
import type {
  ArtifactId,
  PermissionId,
  RunId,
  RunInput,
  SessionId,
} from "../domain/types.js";

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
} as const;
const responses = (schema: object, code = 200) => ({
  [code]: schema,
  default: errorResponseSchema,
});
/** Creates routes from the same schemas used by request validation and OpenAPI generation. */
export async function createGateway(app: HubApplication) {
  const server = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await server.register(swagger, {
    openapi: { info: { title: "HarnessHub", version: "0.1.0" } },
  });
  server.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof HubError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error.validation)
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request does not match the API schema",
          details: error.validation,
        },
      });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: "Request could not be accepted" },
      });
    server.log.error(error);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "Request failed" } });
  });
  server.get(
    "/health/live",
    {
      schema: {
        response: responses({
          type: "object",
          required: ["status"],
          properties: { status: { const: "ok" } },
        }),
      },
    },
    async () => ({ status: "ok" }),
  );
  const readiness = {
    type: "object",
    required: ["ready"],
    properties: { ready: { type: "boolean" } },
  };
  server.get(
    "/health/ready",
    { schema: { response: { 200: readiness, 503: readiness } } },
    async (_req, reply) =>
      reply.code(app.isReady() ? 200 : 503).send({ ready: app.isReady() }),
  );
  server.get(
    "/v1/engines",
    { schema: { response: responses(enginesResponseSchema) } },
    async () => ({ engines: app.engines() }),
  );
  server.post<{ Body: { engineId?: string; workspaceId?: string } }>(
    "/v1/sessions",
    {
      schema: {
        body: createSessionSchema,
        response: responses(sessionResponseSchema, 201),
      },
    },
    async (request, reply) =>
      reply.code(201).send(app.createSession(request.body)),
  );
  server.get<{ Params: { id: string } }>(
    "/v1/sessions/:id",
    {
      schema: { params: idParams, response: responses(sessionResponseSchema) },
    },
    async (request) => app.getSession(request.params.id as SessionId),
  );
  server.post<{ Params: { id: string } }>(
    "/v1/sessions/:id/close",
    {
      schema: { params: idParams, response: responses(sessionResponseSchema) },
    },
    async (request) => app.closeSession(request.params.id as SessionId),
  );
  server.post<{
    Params: { id: string };
    Body: Omit<RunInput, "timeoutMs"> & { timeoutMs?: number };
  }>(
    "/v1/sessions/:id/runs",
    {
      schema: {
        params: idParams,
        body: runInputSchema,
        response: responses(runResponseSchema, 202),
        headers: {
          type: "object",
          properties: {
            "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      const result = app.submit(
        request.params.id as SessionId,
        request.body,
        typeof key === "string" ? key : undefined,
      );
      return reply
        .code(202)
        .header("Location", `/v1/runs/${result.run.id}`)
        .send({ ...result.run, replayed: !result.created });
    },
  );
  server.get<{ Params: { id: string } }>(
    "/v1/runs/:id",
    { schema: { params: idParams, response: responses(runResponseSchema) } },
    async (request) => app.getRun(request.params.id as RunId),
  );
  server.post<{ Params: { id: string } }>(
    "/v1/runs/:id/cancel",
    {
      schema: { params: idParams, response: responses(runResponseSchema, 202) },
    },
    async (request, reply) =>
      reply.code(202).send(await app.cancel(request.params.id as RunId)),
  );
  server.post<{ Params: { id: string }; Body: { optionId: string } }>(
    "/v1/permissions/:id/decision",
    {
      schema: {
        params: idParams,
        body: decisionSchema,
        response: responses(permissionResponseSchema),
      },
    },
    async (request) =>
      app.decide(request.params.id as PermissionId, request.body.optionId),
  );
  server.get<{ Params: { id: string }; Querystring: { afterSeq?: number } }>(
    "/v1/runs/:id/events",
    {
      schema: {
        params: idParams,
        response: responses({
          type: "string",
          description:
            "Ordered SSE frames with id, event and data fields; media type text/event-stream",
        }),
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { afterSeq: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id as RunId;
      const run = app.getRun(id);
      let cursor =
        request.query.afterSeq ?? Number(request.headers["last-event-id"] ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > run.lastSeq)
        throw new HubError(
          "INVALID_CURSOR",
          "Cursor is outside the committed event range",
        );
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const abort = new AbortController();
      const close = () => abort.abort();
      reply.raw.on("close", close);
      try {
        while (!abort.signal.aborted) {
          const batch = app.events(id, cursor, 100);
          for (const event of batch) {
            if (abort.signal.aborted) return;
            const writable = reply.raw.write(
              `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            cursor = event.seq;
            if (!writable)
              await once(reply.raw, "drain", { signal: abort.signal });
          }
          const current = app.getRun(id);
          if (isTerminal(current.status) && cursor >= current.lastSeq) {
            reply.raw.end();
            return;
          }
          if (!batch.length)
            await delay(25, undefined, { signal: abort.signal });
        }
      } catch (error) {
        if (!abort.signal.aborted)
          reply.raw.destroy(
            error instanceof Error ? error : new Error("Event stream failed"),
          );
      } finally {
        reply.raw.off("close", close);
      }
    },
  );
  server.get<{ Params: { id: string } }>(
    "/v1/runs/:id/rollout",
    {
      schema: {
        params: idParams,
        response: responses({
          type: "string",
          description:
            "Newline-delimited committed AgentEvent objects; application/x-ndjson",
        }),
      },
    },
    async (request, reply) => {
      const id = request.params.id as RunId;
      app.getRun(id);
      return reply
        .type("application/x-ndjson")
        .send(Readable.from(app.rollout(id)));
    },
  );
  server.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id",
    {
      schema: {
        params: idParams,
        response: responses({ type: "string", format: "binary" }),
      },
    },
    async (request, reply) => {
      const { record, bytes } = await app.artifact(
        request.params.id as ArtifactId,
      );
      return reply
        .type(record.mediaType)
        .header("X-Content-SHA256", record.sha256)
        .send(bytes);
    },
  );
  server.get("/openapi.json", async () => server.swagger());
  server.addHook("preClose", async () => app.close());
  return server;
}
