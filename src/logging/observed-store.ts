import { excerpt } from "../domain/logging.js";
import type { LogFields, LogSink } from "../domain/logging.js";
import type { Store } from "../domain/ports.js";
import type {
  AgentEvent,
  JsonObject,
  JsonValue,
  PermissionRecord,
  RunRecord,
  SessionRecord,
} from "../domain/types.js";

export interface StoreLogOptions {
  /** Path of a Session's engine log, written into its `session.create` record. */
  engineLog: (sessionId: string) => string;
}

type Observer = (result: unknown, args: readonly unknown[]) => void;

const iso = (time: number | undefined) =>
  time === undefined ? null : new Date(time).toISOString();
const field = (data: JsonObject, key: string): JsonValue | undefined =>
  data[key];

/** Gateway log fields for a committed event; `undefined` means not logged. */
function eventRecord(event: AgentEvent): [string, LogFields] | undefined {
  const data = event.data;
  switch (event.type) {
    case "model.call":
      return [
        "model.call",
        {
          runId: event.runId,
          sessionId: event.sessionId,
          ok: field(data, "ok"),
          status: field(data, "status"),
          ms: field(data, "durationMs"),
          inbound: field(data, "inbound"),
          finishReason: field(data, "finishReason"),
          toolCalls: field(data, "toolCalls"),
          usage: field(data, "usage"),
          error: field(data, "error"),
        },
      ];
    case "engine.error":
    case "engine.session":
    case "engine.installation":
    case "runtime.cleanup":
    case "permission.unsupported":
    case "diagnostics.log_failed":
      return [
        event.type,
        {
          runId: event.runId,
          sessionId: event.sessionId,
          data: excerpt(JSON.stringify(data), 1000),
        },
      ];
    default:
      return undefined;
  }
}

/**
 * Wrap `store` so every successfully committed lifecycle change is written to
 * `log` after the delegate returned: Sessions (create with the engine log path,
 * status, backend binding), Runs (accept, status, finish with durations and the
 * public error), permissions (request, decision, application) and selected events
 * (every `model.call` summary, engine errors, installation, cleanup). Reads and
 * throwing writes are not logged; a failing log call never changes the result.
 * Every other member is delegated unchanged, bound to `store`.
 */
export function observeStore<T extends Store>(
  store: T,
  log: LogSink,
  options: StoreLogOptions,
): T {
  const observers: { [K in keyof Store]?: Observer } = {
    createSession: (result) => {
      const session = result as SessionRecord;
      log.info("session.create", {
        sessionId: session.id,
        engine: session.engineId,
        revision: session.profileRevision,
        cwd: session.cwd,
        engineLog: options.engineLog(session.id),
      });
    },
    setSessionStatus: (result) => {
      const session = result as SessionRecord;
      log.info("session.status", {
        sessionId: session.id,
        status: session.status,
      });
    },
    bindBackendSession: (_result, args) => {
      log.info("session.backend", {
        runId: String(args[0]),
        backendSessionId: String(args[1]),
      });
    },
    acceptRun: (result) => {
      const { run, created } = result as { run: RunRecord; created: boolean };
      log.info(created ? "run.accept" : "run.replay", {
        runId: run.id,
        sessionId: run.sessionId,
        generation: run.generation,
        timeoutMs: run.input.timeoutMs,
        deadlineAt: iso(run.deadlineAt),
        inputChars: run.input.text.length,
      });
    },
    setRunStatus: (result) => {
      const run = result as RunRecord;
      log.info("run.status", {
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
      });
    },
    finishRun: (result) => {
      const run = result as RunRecord;
      const finished = run.finishedAt ?? Date.now();
      log.info("run.finish", {
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        stopReason: run.stopReason ?? null,
        cleanup: run.cleanupStatus,
        error: run.error ? { ...run.error } : null,
        ms: finished - (run.startedAt ?? run.createdAt),
        queuedMs:
          run.startedAt === undefined ? null : run.startedAt - run.createdAt,
        outputChars: run.output?.length ?? 0,
      });
    },
    appendEvent: (result) => {
      const record = result ? eventRecord(result as AgentEvent) : undefined;
      if (record) log.info(...record);
    },
    createPermission: (result) => {
      const permission = result as PermissionRecord;
      log.info("permission.request", {
        permissionId: permission.id,
        runId: permission.runId,
        sessionId: permission.sessionId,
        toolCallId: permission.toolCallId,
        prompt: excerpt(permission.prompt, 300),
        options: permission.options.map((option) => option.kind),
        expiresAt: iso(permission.expiresAt),
      });
    },
    decidePermission: (result) => {
      const permission = result as PermissionRecord;
      log.info("permission.decide", {
        permissionId: permission.id,
        runId: permission.runId,
        decision: permission.decision ?? null,
        kind:
          permission.options.find((option) => option.id === permission.decision)
            ?.kind ?? null,
      });
    },
    markPermissionApplied: (result) => {
      const permission = result as PermissionRecord;
      log.info("permission.applied", {
        permissionId: permission.id,
        runId: permission.runId,
      });
    },
  };
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      const observe =
        typeof property === "string"
          ? observers[property as keyof Store]
          : undefined;
      if (!observe) return method.bind(target);
      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        try {
          observe(result, args);
        } catch {
          // The commit already succeeded; a diagnostic failure must not undo its report.
        }
        return result;
      };
    },
  });
}
