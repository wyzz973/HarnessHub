import { StringDecoder } from "node:string_decoder";
import { excerpt } from "../../domain/logging.js";
import type { LogFields, LogSink } from "../../domain/logging.js";
import type { JsonValue } from "../../domain/types.js";

/** Engine stderr text logged per agent process before further lines are only counted. */
const STDERR_BUDGET = 256 * 1024;
/** Longest single stderr line written. */
const STDERR_LINE = 2048;
/** Requests awaiting a response; older entries are forgotten first. */
const PENDING_LIMIT = 1024;

/** acpx `onAgentProcess` observation (see patches/acpx@0.13.2.patch). */
export type AgentProcessEvent =
  | {
      type: "spawn";
      pid?: number;
      command: string;
      args: string[];
      cwd: string;
    }
  | { type: "stderr"; pid?: number; data: Buffer | string }
  | {
      type: "exit";
      pid?: number;
      reason: string;
      code: number | null;
      signal: string | null;
    };

type Fields = { [key: string]: unknown };
const record = (value: unknown): Fields | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const text = (value: unknown, limit = 200): string | undefined =>
  typeof value === "string" ? excerpt(value, limit) : undefined;
const json = (value: unknown): string => {
  try {
    return excerpt(JSON.stringify(value) ?? "undefined");
  } catch {
    return "[unserializable]";
  }
};
const id = (value: unknown): JsonValue | undefined =>
  typeof value === "string" || typeof value === "number" ? value : undefined;

interface Pending {
  method: string;
  started: number;
}
interface Turn {
  requestId: JsonValue;
  updates: { [kind: string]: number };
  textBytes: number;
  thoughtBytes: number;
}
interface Stderr {
  decoder: StringDecoder;
  partial: string;
  logged: number;
  dropped: number;
}

/**
 * Turns the ACP traffic between the Worker and one engine into engine log
 * records: every JSON-RPC request, response (with duration and error) and
 * notification method; `session/update` notifications summarized per prompt turn
 * (chunk counts and text bytes) plus one line per tool-call status change; agent
 * process spawn, exit and stderr lines (256 KiB per process, then counted).
 * `debug` adds 2 KiB payload excerpts. Callbacks run on acpx's stream and never
 * throw; the sink redacts.
 */
export class AcpTrafficLog {
  private readonly pending = new Map<string, Pending>();
  private readonly toolStatus = new Map<string, string>();
  private readonly stderr = new Map<number | undefined, Stderr>();
  private turn: Turn | undefined;

  constructor(
    private readonly log: LogSink,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** acpx `onAcpMessage`: `inbound` messages come from the engine. */
  message(direction: "inbound" | "outbound", raw: unknown): void {
    try {
      this.observe(direction === "inbound" ? "from-engine" : "to-engine", raw);
    } catch {
      // An unexpected message shape must not interrupt the ACP stream.
    }
  }

  /** acpx `onAgentProcess`. */
  process(event: AgentProcessEvent): void {
    try {
      switch (event.type) {
        case "spawn":
          this.log.info("engine.spawn", {
            pid: event.pid ?? null,
            command: event.command,
            args: event.args,
            cwd: event.cwd,
          });
          return;
        case "stderr":
          this.stderrChunk(event.pid, event.data);
          return;
        case "exit":
          this.flushStderr(event.pid);
          this.pending.clear();
          this.log.info("engine.exit", {
            pid: event.pid ?? null,
            reason: event.reason,
            code: event.code,
            signal: event.signal,
          });
          return;
      }
    } catch {
      // Process observation is diagnostic only.
    }
  }

  private observe(dir: "from-engine" | "to-engine", raw: unknown): void {
    const message = record(raw);
    if (!message) return;
    const method =
      typeof message.method === "string" ? message.method : undefined;
    const requestId = id(message.id);
    if (method !== undefined && requestId !== undefined) {
      this.request(dir, method, requestId, message.params);
      return;
    }
    if (method !== undefined) {
      this.notification(dir, method, message.params);
      return;
    }
    if (requestId !== undefined) this.response(dir, requestId, message);
  }

  private request(
    dir: "from-engine" | "to-engine",
    method: string,
    requestId: JsonValue,
    params: unknown,
  ): void {
    const key = `${dir}:${JSON.stringify(requestId)}`;
    if (this.pending.size >= PENDING_LIMIT) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(key, { method, started: this.now() });
    if (method === "session/prompt")
      this.turn = {
        requestId,
        updates: {},
        textBytes: 0,
        thoughtBytes: 0,
      };
    const fields: LogFields = { dir, id: requestId, method };
    if (method === "session/request_permission") {
      const call = record(record(params)?.toolCall);
      fields.toolCallId = text(call?.toolCallId);
      fields.title = text(call?.title);
    }
    this.log.info("acp.request", fields);
    this.log.debug("acp.request.params", {
      dir,
      id: requestId,
      method,
      params: json(params),
    });
  }

  private response(
    dir: "from-engine" | "to-engine",
    requestId: JsonValue,
    message: Fields,
  ): void {
    const requester = dir === "from-engine" ? "to-engine" : "from-engine";
    const key = `${requester}:${JSON.stringify(requestId)}`;
    const pending = this.pending.get(key);
    this.pending.delete(key);
    const method = pending?.method ?? null;
    const error = record(message.error);
    const result = record(message.result);
    const fields: LogFields = {
      dir,
      id: requestId,
      method,
      ms: pending ? Math.round(this.now() - pending.started) : null,
      ok: error === undefined,
    };
    if (error)
      fields.error = {
        code: typeof error.code === "number" ? error.code : null,
        message: text(error.message, 500) ?? "",
        ...(error.data !== undefined ? { data: json(error.data) } : {}),
      };
    if (method === "initialize" && result) {
      const agent = record(result.agentInfo);
      fields.protocolVersion =
        typeof result.protocolVersion === "number"
          ? result.protocolVersion
          : null;
      fields.agent = agent
        ? `${text(agent.name, 80) ?? "?"} ${text(agent.version, 40) ?? ""}`.trim()
        : null;
      fields.capabilities = Object.keys(record(result.agentCapabilities) ?? {});
      fields.authMethods = Array.isArray(result.authMethods)
        ? result.authMethods.length
        : 0;
    }
    if ((method === "session/new" || method === "session/load") && result) {
      fields.sessionId = text(result.sessionId) ?? null;
      fields.currentModel = text(record(result.models)?.currentModelId) ?? null;
      fields.currentMode = text(record(result.modes)?.currentModeId) ?? null;
    }
    if (method === "session/prompt" && result)
      fields.stopReason = text(result.stopReason) ?? null;
    this.log.info("acp.response", fields);
    if (message.result !== undefined)
      this.log.debug("acp.response.result", {
        dir,
        id: requestId,
        method,
        result: json(message.result),
      });
    if (method === "session/prompt") this.endTurn(fields);
  }

  private notification(
    dir: "from-engine" | "to-engine",
    method: string,
    params: unknown,
  ): void {
    if (method !== "session/update") {
      this.log.info("acp.notification", { dir, method });
      this.log.debug("acp.notification.params", {
        dir,
        method,
        params: json(params),
      });
      return;
    }
    const update = record(record(params)?.update);
    const kind =
      typeof update?.sessionUpdate === "string"
        ? update.sessionUpdate
        : "unknown";
    const turn = this.turn;
    if (turn) turn.updates[kind] = (turn.updates[kind] ?? 0) + 1;
    const content = record(update?.content);
    const bytes =
      typeof content?.text === "string" ? Buffer.byteLength(content.text) : 0;
    if (turn && kind === "agent_message_chunk") turn.textBytes += bytes;
    if (turn && kind === "agent_thought_chunk") turn.thoughtBytes += bytes;
    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = text(update?.toolCallId) ?? "?";
      const status =
        text(update?.status) ?? (kind === "tool_call" ? "pending" : undefined);
      if (status !== undefined && this.toolStatus.get(toolCallId) !== status) {
        this.toolStatus.set(toolCallId, status);
        this.log.info("acp.tool", {
          toolCallId,
          status,
          title: text(update?.title),
          kind: text(update?.kind),
        });
      }
      if (this.toolStatus.size > PENDING_LIMIT) this.toolStatus.clear();
    }
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk")
      this.log.debug("acp.update", { kind, update: json(update) });
  }

  private endTurn(response: LogFields): void {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn) return;
    this.log.info("acp.turn", {
      id: turn.requestId,
      ms: response.ms,
      stopReason: response.stopReason ?? null,
      ok: response.ok,
      updates: turn.updates,
      textBytes: turn.textBytes,
      thoughtBytes: turn.thoughtBytes,
    });
  }

  private stderrChunk(pid: number | undefined, data: Buffer | string): void {
    let state = this.stderr.get(pid);
    if (!state) {
      state = {
        decoder: new StringDecoder("utf8"),
        partial: "",
        logged: 0,
        dropped: 0,
      };
      this.stderr.set(pid, state);
    }
    const chunk =
      typeof data === "string" ? data : state.decoder.write(Buffer.from(data));
    const lines = (state.partial + chunk).split(/\r?\n/);
    state.partial = lines.pop() ?? "";
    if (state.partial.length > STDERR_LINE) {
      lines.push(state.partial);
      state.partial = "";
    }
    for (const line of lines) this.stderrLine(pid, state, line);
  }

  private stderrLine(
    pid: number | undefined,
    state: Stderr,
    line: string,
  ): void {
    if (!line.trim()) return;
    const bytes = Buffer.byteLength(line);
    if (state.logged + bytes > STDERR_BUDGET) {
      state.dropped += bytes;
      return;
    }
    state.logged += bytes;
    this.log.info("engine.stderr", {
      pid: pid ?? null,
      line: excerpt(line, STDERR_LINE),
    });
  }

  private flushStderr(pid: number | undefined): void {
    const state = this.stderr.get(pid);
    if (!state) return;
    this.stderr.delete(pid);
    const rest = state.partial + state.decoder.end();
    if (rest) this.stderrLine(pid, state, rest);
    if (state.dropped > 0)
      this.log.info("engine.stderr.dropped", {
        pid: pid ?? null,
        bytes: state.dropped,
      });
  }
}
