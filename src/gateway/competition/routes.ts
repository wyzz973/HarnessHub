import { mkdir } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type { HubApplication } from "../../application/service.js";
import { HubError } from "../../domain/errors.js";
import { isTerminal } from "../../domain/types.js";
import type {
  JsonObject,
  PermissionId,
  PermissionRecord,
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
  TerminalStatus,
} from "../../domain/types.js";
import { CompetitionRunFeed, streamCompetitionEvents } from "./events.js";
import { RunTranscript, failureOf } from "./transcript.js";
import type { CompetitionMessage } from "./transcript.js";

/** Error codes of Competition specification v1.1 section 7, with their HTTP status. */
const errorStatus = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;
type CompetitionErrorCode = keyof typeof errorStatus;

const PROMPT_POLL_MS = 25;
const PROMPT_TEXT_LIMIT = 1_048_576;
/**
 * Deadline of every `prompt_async` Run. The specification has no Run limit and
 * `prompt_async` blocks until the round ends, so the ordinary 60-second Gateway default
 * would end real tasks early. One hour matches the client timeout INSTRUCTION.md asks
 * the evaluator to use; the Run then ends with `RUN_TIMED_OUT` (502).
 */
export const COMPETITION_RUN_TIMEOUT_MS = 3_600_000;
const EVENT_PAGE = 1_000;
const FLUSH_GRACE_MS = 1_000;

/** A failure whose code and message are returned verbatim as `{ code, message }`. */
class CompetitionError extends Error {
  constructor(
    readonly code: CompetitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompetitionError";
  }
}

function invalid(message: string): CompetitionError {
  return new CompetitionError("VALIDATION_ERROR", message);
}

function codeForStatus(status: number): CompetitionErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 429 || status === 503) return "SERVICE_UNAVAILABLE";
  if (status === 502 || status === 504) return "BAD_GATEWAY";
  if (status >= 500) return "INTERNAL_ERROR";
  return "VALIDATION_ERROR";
}

const fastifyMessages: Readonly<Record<string, string>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: "Request body is not valid JSON",
  FST_ERR_CTP_EMPTY_JSON_BODY: "Request body is empty",
  FST_ERR_CTP_BODY_TOO_LARGE: "Request body is too large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE:
    "Unsupported Content-Type; send application/json",
  FST_ERR_CTP_INVALID_CONTENT_LENGTH:
    "Content-Length does not match the request body",
};

/**
 * Maps any failure to the specification error body. HubError messages are public by
 * contract; Fastify request errors get fixed messages; anything else is an internal
 * error without detail.
 */
function competitionError(error: unknown): {
  status: number;
  body: { code: CompetitionErrorCode; message: string };
} {
  let code: CompetitionErrorCode = "INTERNAL_ERROR";
  let message = "Request failed";
  if (error instanceof CompetitionError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof HubError) {
    code = codeForStatus(error.statusCode);
    message = error.message;
  } else if (isRecord(error)) {
    const status = error.statusCode;
    const fastifyCode = typeof error.code === "string" ? error.code : "";
    if (error.validation !== undefined && typeof error.message === "string") {
      code = "VALIDATION_ERROR";
      message = error.message;
    } else if (Object.hasOwn(fastifyMessages, fastifyCode)) {
      code = "VALIDATION_ERROR";
      message = fastifyMessages[fastifyCode] ?? message;
    } else if (typeof status === "number" && status >= 400 && status < 600) {
      code = codeForStatus(status);
      if (status < 500) message = "Request could not be accepted";
    }
  }
  return { status: errorStatus[code], body: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid("Request body must be a JSON object");
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw invalid(`${name} is required and must be a non-empty string`);
  return value;
}

function requireSession(app: HubApplication, id: string): SessionRecord {
  try {
    return app.getSession(id as SessionId);
  } catch (error) {
    if (error instanceof HubError && error.statusCode === 404)
      throw new CompetitionError("NOT_FOUND", "Session not found");
    throw error;
  }
}

function titleOf(session: SessionRecord): string {
  const routing = session.configSnapshot?.routing;
  const competition =
    isRecord(routing) && isRecord(routing.competition)
      ? routing.competition
      : undefined;
  return typeof competition?.title === "string"
    ? competition.title
    : `Session ${String(session.id).slice(0, 8)}`;
}

function sessionView(session: SessionRecord, busy: boolean) {
  return {
    id: session.id,
    title: titleOf(session),
    created_at: new Date(session.createdAt).toISOString(),
    status: busy ? "busy" : "idle",
    directory: session.cwd,
  };
}

function hasUnfinished(runs: RunRecord[]): boolean {
  return runs.some((run) => !isTerminal(run.status));
}

/** Messages of all Runs; each Run record is read before its events. */
function sessionMessages(
  app: HubApplication,
  runs: RunRecord[],
): CompetitionMessage[] {
  const messages: CompetitionMessage[] = [];
  for (const run of [...runs].sort((a, b) => a.generation - b.generation)) {
    const transcript = new RunTranscript(run.id);
    let cursor = 0;
    for (;;) {
      const page = app.events(run.id, cursor, EVENT_PAGE);
      for (const event of page) {
        transcript.apply(event);
        cursor = event.seq;
      }
      if (page.length < EVENT_PAGE) break;
    }
    messages.push(...transcript.messages(run));
  }
  return messages;
}

function promptInput(body: unknown): { text: string } {
  const input = bodyObject(body);
  if (!Array.isArray(input.parts) || input.parts.length === 0)
    throw invalid("parts is required and must be a non-empty array");
  const texts = input.parts.map((raw: unknown, index) => {
    if (!isRecord(raw) || raw.type !== "text")
      throw invalid(`parts[${index}].type must be text`);
    if (typeof raw.text !== "string")
      throw invalid(`parts[${index}].text must be a string`);
    return raw.text;
  });
  const text = texts.join("\n");
  if (!text.trim()) throw invalid("parts must contain non-empty text");
  if (text.length > PROMPT_TEXT_LIMIT)
    throw invalid(`prompt text exceeds ${PROMPT_TEXT_LIMIT} characters`);
  if (
    !isRecord(input.model) ||
    typeof input.model.providerID !== "string" ||
    typeof input.model.modelID !== "string"
  )
    throw invalid(
      "model is required with string providerID and modelID fields",
    );
  if (input.agent !== undefined && typeof input.agent !== "string")
    throw invalid("agent must be a string");
  // model/agent are validated only: Runs use the HarnessHub unified model (ADR 0013).
  return { text };
}

function describeFsError(error: unknown): string {
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : "";
  const reasons: Record<string, string> = {
    EACCES: "permission denied",
    EPERM: "operation not permitted",
    EEXIST: "a file with that name already exists",
    ENOTDIR: "a parent path is not a directory",
    ENOENT: "the drive or a parent path does not exist",
    ENAMETOOLONG: "the path is too long",
    EROFS: "the file system is read-only",
    ENOSPC: "no space left on the device",
    EINVAL: "the path is invalid",
    ERR_INVALID_ARG_VALUE: "the path contains invalid characters",
  };
  const reason = reasons[code] ?? "the file system rejected the path";
  return code ? `${reason} (${code})` : reason;
}

/** Approves pending permissions of one Run with its allow-once option. */
async function approvePending(
  app: HubApplication,
  permissions: PermissionRecord[],
): Promise<void> {
  for (const permission of permissions) {
    if (permission.status !== "pending") continue;
    const allow = permission.options.find(
      (option) => option.kind === "allow_once",
    );
    if (!allow) continue;
    try {
      await app.decide(permission.id, allow.id);
    } catch (error) {
      // A permission can expire or be decided elsewhere between read and decision;
      // the Run outcome, polled next, remains the result of this request.
      if (
        !(error instanceof HubError) ||
        !["PERMISSION_EXPIRED", "PERMISSION_CONFLICT"].includes(error.code)
      )
        throw error;
    }
  }
}

/** Polls one Run to a terminal record, approving permissions on the way. */
async function settle(
  app: HubApplication,
  id: RunId,
): Promise<RunRecord & { status: TerminalStatus }> {
  for (;;) {
    const run = app.getRun(id);
    const status = run.status;
    if (isTerminal(status)) return { ...run, status };
    await approvePending(app, run.permissions);
    await delay(PROMPT_POLL_MS);
  }
}

/**
 * Ends a hijacked stream response and waits until it is flushed, so a closing server
 * finds the keep-alive connection idle; a client that does not drain within
 * `FLUSH_GRACE_MS` has its connection destroyed.
 */
async function finishResponse(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableFinished) return;
  const settled = new Promise<void>((resolve) => {
    const done = () => {
      response.off("finish", done);
      response.off("close", done);
      resolve();
    };
    response.on("finish", done);
    response.on("close", done);
  });
  if (!response.writableEnded) response.end();
  const timer = setTimeout(() => response.destroy(), FLUSH_GRACE_MS);
  try {
    await settled;
  } finally {
    clearTimeout(timer);
  }
}

function pendingPermissions(app: HubApplication): PermissionRecord[] {
  return app
    .runs()
    .filter((run) => !isTerminal(run.status))
    .flatMap((run) =>
      app
        .getRun(run.id)
        .permissions.filter((permission) => permission.status === "pending"),
    );
}

/**
 * Registers the Competition v1.1 API in its own Fastify context. It projects
 * HarnessHub Session/Run/Event state without changing the native `/v1` contract or
 * Driver interfaces: every error, including body parsing, is `{ code, message }`;
 * `/session` always uses `options.engineId` when given. Open `/event` streams are
 * ended and awaited by the server's `preClose` hook, after the root hook has
 * cancelled Runs so blocked `prompt_async` calls answer first.
 */
export function registerCompetitionRoutes(
  server: FastifyInstance,
  app: HubApplication,
  options: { engineId?: string } = {},
): void {
  const feed = new CompetitionRunFeed();
  const streams = new Map<AbortController, Promise<void>>();
  void server.register(async (instance) => {
    instance.setErrorHandler((error: unknown, _request, reply) => {
      const mapped = competitionError(error);
      return reply.code(mapped.status).send(mapped.body);
    });
    instance.addHook("preClose", async () => {
      for (const controller of streams.keys()) controller.abort();
      await Promise.allSettled([...streams.values()]);
    });

    instance.post("/session", async (request, reply) => {
      const body = bodyObject(request.body);
      if (
        body.title !== undefined &&
        body.title !== null &&
        typeof body.title !== "string"
      )
        throw invalid("title must be a string");
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title
          : `Session ${new Date().toISOString()}`;
      const directory = path.resolve(
        requiredString(body.directory, "directory"),
      );
      try {
        await mkdir(directory, { recursive: true });
      } catch (error) {
        throw invalid(
          `directory ${JSON.stringify(directory)} could not be created: ${describeFsError(error)}`,
        );
      }
      let session: SessionRecord;
      try {
        session = await app.createSessionAtDirectory({
          directory,
          ...(options.engineId ? { engineId: options.engineId } : {}),
          routing: { competition: { title } } satisfies JsonObject,
        });
      } catch (error) {
        if (error instanceof HubError && error.code === "ENGINE_UNAVAILABLE")
          throw new CompetitionError("SERVICE_UNAVAILABLE", error.message);
        throw error;
      }
      return reply.code(200).send(sessionView(session, false));
    });

    instance.get("/session/status", async () => {
      const unfinished = new Set(
        app
          .runs()
          .filter((run) => !isTerminal(run.status))
          .map((run) => run.sessionId),
      );
      const status: Record<string, { type: "idle" | "busy" }> = {};
      for (const session of app.sessions())
        status[session.id] = {
          type: unfinished.has(session.id) ? "busy" : "idle",
        };
      return status;
    });

    instance.get<{ Params: { id: string } }>(
      "/session/:id",
      async (request) => {
        const session = requireSession(app, request.params.id);
        const runs = app.runs(session.id);
        return {
          ...sessionView(session, hasUnfinished(runs)),
          message_count: sessionMessages(app, runs).length,
        };
      },
    );

    instance.delete<{ Params: { id: string } }>(
      "/session/:id",
      async (request) => {
        const session = requireSession(app, request.params.id);
        await app.closeSession(session.id);
        return { ok: true };
      },
    );

    instance.post<{ Params: { id: string } }>(
      "/session/:id/prompt_async",
      async (request, reply) => {
        const session = requireSession(app, request.params.id);
        const input = promptInput(request.body);
        if (session.status !== "open")
          throw invalid("Session is closed; create a new session");
        const { run } = app.submit(session.id, {
          ...input,
          timeoutMs: COMPETITION_RUN_TIMEOUT_MS,
        });
        feed.publish(run.id);
        // Blocks until the Run ends (specification 4.1); a client disconnect does
        // not cancel the Run and permissions keep being approved until it ends.
        const ended = await settle(app, run.id);
        const failure = failureOf(ended.status, ended.error, ended.stopReason);
        if (failure) throw new CompetitionError("BAD_GATEWAY", failure.message);
        return reply.code(204).send();
      },
    );

    instance.get<{ Params: { id: string } }>(
      "/session/:id/message",
      async (request) => {
        const session = requireSession(app, request.params.id);
        return sessionMessages(app, app.runs(session.id));
      },
    );

    const abort = async (request: { params: { id: string } }) => {
      const session = requireSession(app, request.params.id);
      for (const run of app.runs(session.id))
        if (!isTerminal(run.status)) await app.cancel(run.id);
      return { ok: true };
    };
    instance.post<{ Params: { id: string } }>("/session/:id/abort", abort);
    instance.post<{ Params: { id: string } }>("/session/:id/stop", abort);

    // Engines never ask questions through HarnessHub, so none can be pending.
    instance.get("/question", async () => []);
    instance.post<{ Params: { id: string } }>(
      "/question/:id/reply",
      async (request) => {
        const body = bodyObject(request.body);
        if (
          !Array.isArray(body.answers) ||
          !body.answers.every(
            (answer: unknown) =>
              Array.isArray(answer) &&
              answer.every((item: unknown) => typeof item === "string"),
          )
        )
          throw invalid("answers must be an array of string arrays");
        throw new CompetitionError("NOT_FOUND", "Question not found");
      },
    );

    instance.get("/permission", async () =>
      pendingPermissions(app).map((permission) => ({
        id: permission.id,
        sessionID: permission.sessionId,
        permission: permission.prompt,
        patterns: [],
        created_at: new Date(permission.createdAt).toISOString(),
      })),
    );

    instance.post<{ Params: { id: string } }>(
      "/permission/:id/reply",
      async (request) => {
        const body = bodyObject(request.body);
        const reply = body.reply;
        if (reply !== "once" && reply !== "always" && reply !== "reject")
          throw invalid("reply must be once, always, or reject");
        if (body.message !== undefined && typeof body.message !== "string")
          throw invalid("message must be a string");
        const permissionId = request.params.id as PermissionId;
        const permission = pendingPermissions(app).find(
          (candidate) => candidate.id === permissionId,
        );
        if (!permission)
          throw new CompetitionError("NOT_FOUND", "Permission not found");
        // HarnessHub decisions are single-use; "always" is applied as allow-once.
        const kind = reply === "reject" ? "reject_once" : "allow_once";
        const option = permission.options.find(
          (candidate) => candidate.kind === kind,
        );
        if (!option)
          throw invalid("Requested permission decision is not available");
        await app.decide(permission.id, option.id);
        return { ok: true };
      },
    );

    instance.get("/event", async (_request, reply) => {
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const controller = new AbortController();
      const close = () => controller.abort();
      response.on("close", close);
      const lifecycle = (async () => {
        try {
          await streamCompetitionEvents(app, feed, response, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted)
            response.destroy(
              error instanceof Error
                ? error
                : new Error("Competition event stream failed"),
            );
        } finally {
          response.off("close", close);
          await finishResponse(response);
        }
      })();
      streams.set(controller, lifecycle);
      try {
        await lifecycle;
      } finally {
        streams.delete(controller);
      }
    });
  });
}
