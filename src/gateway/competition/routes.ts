import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { HubApplication } from "../../application/service.js";
import { HubError } from "../../domain/errors.js";
import { isTerminal } from "../../domain/types.js";
import type {
  AgentEvent,
  JsonObject,
  PermissionId,
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "../../domain/types.js";

type CompetitionErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "BAD_GATEWAY"
  | "SERVICE_UNAVAILABLE";

interface PromptBody {
  parts: { type: "text"; text: string }[];
  model: { providerID: string; modelID: string };
  agent?: string;
}

function errorCode(error: unknown): {
  status: number;
  code: CompetitionErrorCode;
  message: string;
} {
  if (error instanceof HubError) {
    if (error.statusCode === 404)
      return { status: 404, code: "NOT_FOUND", message: error.message };
    if (error.statusCode >= 500)
      return {
        status: error.statusCode === 503 ? 503 : 502,
        code: error.statusCode === 503 ? "SERVICE_UNAVAILABLE" : "BAD_GATEWAY",
        message: error.message,
      };
    return { status: 400, code: "VALIDATION_ERROR", message: error.message };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Request failed",
  };
}

function sendError(reply: FastifyReply, error: unknown) {
  const mapped = errorCode(error);
  return reply.code(mapped.status).send({
    code: mapped.code,
    message: mapped.message,
  });
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HubError(
      "INVALID_REQUEST",
      "Request body must be an object",
      400,
    );
  return value as Record<string, unknown>;
}

function stringField(
  value: unknown,
  name: string,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new HubError(
      "INVALID_REQUEST",
      `${name} must be a non-empty string`,
      400,
    );
  return value;
}

function sessionBusy(app: HubApplication, id: SessionId): boolean {
  return app.runs(id).some((run) => !isTerminal(run.status));
}

function titleOf(session: SessionRecord): string {
  const routing = session.configSnapshot?.routing;
  if (routing && typeof routing === "object" && !Array.isArray(routing)) {
    const competition = (routing as JsonObject).competition;
    if (
      competition &&
      typeof competition === "object" &&
      !Array.isArray(competition) &&
      typeof (competition as JsonObject).title === "string"
    )
      return (competition as JsonObject).title as string;
  }
  return `Session ${String(session.id).slice(0, 8)}`;
}

function sessionResponse(app: HubApplication, session: SessionRecord) {
  return {
    id: session.id,
    title: titleOf(session),
    created_at: new Date(session.createdAt).toISOString(),
    status: sessionBusy(app, session.id) ? "busy" : "idle",
  };
}

function textFromPrompt(body: unknown): PromptBody {
  const input = requireObject(body);
  if (!Array.isArray(input.parts) || input.parts.length === 0)
    throw new HubError(
      "INVALID_REQUEST",
      "parts must be a non-empty array",
      400,
    );
  const parts = input.parts.map((raw, index) => {
    const part = requireObject(raw);
    if (part.type !== "text")
      throw new HubError(
        "INVALID_REQUEST",
        `parts[${index}].type must be text`,
        400,
      );
    return {
      type: "text" as const,
      text: stringField(part.text, `parts[${index}].text`)!,
    };
  });
  const modelInput = requireObject(input.model);
  const model = {
    providerID: stringField(modelInput.providerID, "model.providerID")!,
    modelID: stringField(modelInput.modelID, "model.modelID")!,
  };
  const agent = stringField(input.agent, "agent", false);
  return { parts, model, ...(agent ? { agent } : {}) };
}

function toolParts(events: AgentEvent[]) {
  return events
    .filter((event) => event.type === "tool.update")
    .map((event) => {
      const details = event.data.details;
      const detailObject =
        details && typeof details === "object" && !Array.isArray(details)
          ? (details as JsonObject)
          : undefined;
      const tool =
        (typeof detailObject?.toolName === "string" && detailObject.toolName) ||
        (typeof detailObject?.title === "string" && detailObject.title) ||
        "tool";
      return {
        type: "tool",
        tool,
        state: {
          status: "completed",
          title:
            typeof event.data.text === "string"
              ? event.data.text
              : `${tool} completed`,
        },
      };
    });
}

function messagesForRun(app: HubApplication, run: RunRecord) {
  const events = app.events(run.id, 0, 1000);
  const assistantParts: unknown[] = [];
  if (run.output) assistantParts.push({ type: "text", content: run.output });
  assistantParts.push(...toolParts(events));
  if (isTerminal(run.status)) assistantParts.push({ type: "step-finish" });
  const finish =
    run.status === "completed"
      ? "stop"
      : isTerminal(run.status)
        ? "stop"
        : "tool-calls";
  return [
    {
      id: `${run.id}:user`,
      role: "user",
      content: run.input.text,
      created_at: new Date(run.createdAt).toISOString(),
    },
    {
      id: `${run.id}:assistant`,
      role: "assistant",
      content: run.output ?? "",
      created_at: new Date(run.finishedAt ?? run.createdAt).toISOString(),
      info: { role: "assistant", finish },
      parts: assistantParts,
    },
  ];
}

async function approvePendingPermissions(app: HubApplication, runId: RunId) {
  const run = app.getRun(runId);
  for (const permission of run.permissions) {
    if (permission.status !== "pending") continue;
    const allow = permission.options.find(
      (option) => option.kind === "allow_once",
    );
    if (allow) await app.decide(permission.id, allow.id);
  }
}

async function writeSse(reply: FastifyReply, payload: unknown) {
  const writable = reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (!writable) await once(reply.raw, "drain");
}

function competitionEvent(
  event: AgentEvent,
  text: Map<string, string>,
): unknown | undefined {
  if (event.type === "message.delta") {
    if (event.data.stream === "thought") return undefined;
    const messageId =
      typeof event.data.messageId === "string"
        ? event.data.messageId
        : `${event.runId}:assistant`;
    const delta = typeof event.data.text === "string" ? event.data.text : "";
    const content = `${text.get(messageId) ?? ""}${delta}`;
    text.set(messageId, content);
    return {
      type: "message.part.updated",
      properties: {
        sessionID: event.sessionId,
        messageID: messageId,
        part: { type: "text", content },
      },
    };
  }
  if (event.type === "tool.update") {
    const details = event.data.details;
    const detailObject =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as JsonObject)
        : undefined;
    const tool =
      (typeof detailObject?.toolName === "string" && detailObject.toolName) ||
      (typeof detailObject?.title === "string" && detailObject.title) ||
      "tool";
    return {
      type: "message.part.updated",
      properties: {
        sessionID: event.sessionId,
        messageID: `${event.runId}:assistant`,
        part: {
          type: "tool",
          tool,
          state: {
            status: "running",
            title:
              typeof event.data.text === "string"
                ? event.data.text
                : `${tool} running`,
          },
        },
      },
    };
  }
  if (event.type === "engine.error")
    return {
      type: "session.error",
      properties: {
        sessionID: event.sessionId,
        error: {
          message:
            typeof event.data.message === "string"
              ? event.data.message
              : "Agent engine error",
          data: event.data,
        },
      },
    };
  return undefined;
}

/** Competition v1.1 compatibility API. It projects HarnessHub Session/Run/Event state
 * without changing the native /v1 contract or the engine Driver interfaces. */
export function registerCompetitionRoutes(
  server: FastifyInstance,
  app: HubApplication,
) {
  server.post("/session", async (request, reply) => {
    try {
      const body = requireObject(request.body);
      const title = stringField(body.title, "title", false);
      const directory = stringField(body.directory, "directory")!;
      const session = await app.createSessionAtDirectory({
        directory,
        routing: {
          competition: {
            title: title ?? `Session ${new Date().toISOString()}`,
          },
        },
      });
      return reply.code(200).send(sessionResponse(app, session));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.get("/session/status", async (_request, reply) => {
    try {
      const status: Record<string, { type: "idle" | "busy" }> = {};
      for (const session of app.sessions())
        if (session.status === "open")
          status[session.id] = {
            type: sessionBusy(app, session.id) ? "busy" : "idle",
          };
      return reply.send(status);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.get<{ Params: { id: string } }>(
    "/session/:id",
    async (request, reply) => {
      try {
        const session = app.getSession(request.params.id as SessionId);
        return reply.send({
          ...sessionResponse(app, session),
          message_count: app.runs(session.id).length * 2,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/session/:id",
    async (request, reply) => {
      try {
        await app.closeSession(request.params.id as SessionId);
        return reply.send({ ok: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.post<{ Params: { id: string } }>(
    "/session/:id/prompt_async",
    async (request, reply) => {
      try {
        const sessionId = request.params.id as SessionId;
        app.getSession(sessionId);
        const body = textFromPrompt(request.body);
        const text = body.parts.map((part) => part.text).join("\n");
        const { run } = app.submit(sessionId, { text });
        for (;;) {
          await approvePendingPermissions(app, run.id);
          const current = app.getRun(run.id);
          if (isTerminal(current.status)) {
            if (
              current.status === "completed" ||
              current.status === "cancelled"
            )
              return reply.code(204).send();
            const message =
              current.error?.message ??
              current.stopReason ??
              "Agent run failed";
            return reply.code(502).send({ code: "BAD_GATEWAY", message });
          }
          await delay(25);
        }
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    "/session/:id/message",
    async (request, reply) => {
      try {
        const sessionId = request.params.id as SessionId;
        app.getSession(sessionId);
        return reply.send(
          app
            .runs(sessionId)
            .sort((a, b) => a.generation - b.generation)
            .flatMap((run) => messagesForRun(app, run)),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  const abortHandler = async (
    request: { params: { id: string } },
    reply: FastifyReply,
  ) => {
    try {
      const sessionId = request.params.id as SessionId;
      app.getSession(sessionId);
      const active = app
        .runs(sessionId)
        .filter((run) => !isTerminal(run.status))
        .sort((a, b) => b.generation - a.generation)[0];
      if (active) await app.cancel(active.id);
      return reply.send({ ok: true });
    } catch (error) {
      return sendError(reply, error);
    }
  };
  server.post<{ Params: { id: string } }>("/session/:id/abort", abortHandler);
  server.post<{ Params: { id: string } }>("/session/:id/stop", abortHandler);

  server.get("/question", async () => []);
  server.post<{ Params: { id: string } }>(
    "/question/:id/reply",
    async (_request, reply) => reply.send({ ok: true }),
  );

  server.get("/permission", async () => {
    const pending = [];
    for (const run of app.runs()) {
      if (isTerminal(run.status)) continue;
      for (const permission of app.getRun(run.id).permissions) {
        if (permission.status !== "pending") continue;
        pending.push({
          id: permission.id,
          sessionID: permission.sessionId,
          permission: permission.prompt,
          patterns: [],
          created_at: new Date(permission.createdAt).toISOString(),
        });
      }
    }
    return pending;
  });

  server.post<{ Params: { id: string } }>(
    "/permission/:id/reply",
    async (request, reply) => {
      try {
        const body = requireObject(request.body);
        const requested = stringField(body.reply, "reply")!;
        if (!["once", "always", "reject"].includes(requested))
          throw new HubError(
            "INVALID_REQUEST",
            "reply must be once, always, or reject",
            400,
          );
        const permissionId = request.params.id as PermissionId;
        let found:
          | ReturnType<HubApplication["getRun"]>["permissions"][number]
          | undefined;
        for (const run of app.runs()) {
          found = app
            .getRun(run.id)
            .permissions.find((permission) => permission.id === permissionId);
          if (found) break;
        }
        if (!found)
          throw new HubError(
            "PERMISSION_NOT_FOUND",
            "Permission not found",
            404,
          );
        const kind = requested === "reject" ? "reject_once" : "allow_once";
        const option = found.options.find(
          (candidate) => candidate.kind === kind,
        );
        if (!option)
          throw new HubError(
            "PERMISSION_OPTION_UNAVAILABLE",
            "Requested permission decision is not available",
            400,
          );
        await app.decide(permissionId, option.id);
        return reply.send({ ok: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  server.get("/event", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const abort = new AbortController();
    const onClose = () => abort.abort();
    reply.raw.on("close", onClose);
    const cursors = new Map<string, number>();
    const states = new Map<string, "idle" | "busy">();
    const text = new Map<string, string>();
    let heartbeatAt = Date.now();
    try {
      await writeSse(reply, { type: "server.connected", properties: {} });
      for (const run of app.runs()) cursors.set(run.id, run.lastSeq);
      while (!abort.signal.aborted) {
        const sessions = app
          .sessions()
          .filter((session) => session.status === "open");
        for (const session of sessions) {
          const state = sessionBusy(app, session.id) ? "busy" : "idle";
          const previous = states.get(session.id);
          if (previous !== state) {
            states.set(session.id, state);
            await writeSse(reply, {
              type: "session.status",
              properties: { sessionID: session.id, status: { type: state } },
            });
            if (state === "idle" && previous === "busy") {
              await writeSse(reply, {
                type: "session.idle",
                properties: { sessionID: session.id },
              });
              const last = app
                .runs(session.id)
                .sort((a, b) => b.generation - a.generation)[0];
              if (last)
                await writeSse(reply, {
                  type: "message.part.updated",
                  properties: {
                    sessionID: session.id,
                    messageID: `${last.id}:assistant`,
                    part: { type: "step-finish" },
                  },
                });
            }
          }
        }
        for (const run of app.runs()) {
          const cursor = cursors.get(run.id) ?? 0;
          const events = app.events(run.id, cursor, 100);
          for (const event of events) {
            const projected = competitionEvent(event, text);
            if (projected) await writeSse(reply, projected);
            cursors.set(run.id, event.seq);
          }
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          heartbeatAt = Date.now();
          await writeSse(reply, { type: "server.heartbeat", properties: {} });
        }
        await delay(25, undefined, { signal: abort.signal });
      }
    } catch (error) {
      if (!abort.signal.aborted)
        reply.raw.destroy(
          error instanceof Error
            ? error
            : new Error("Competition event stream failed"),
        );
    } finally {
      reply.raw.off("close", onClose);
    }
  });
}
