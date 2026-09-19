// TEMPORARY STUB — drop on merge.
// This file only exists so the engine wiring and Worker semantics can compile and
// be tested before the real ADR 0013 model gateway lands. It matches the agreed
// signature exactly but implements OpenAI Chat pass-through only: Responses,
// Anthropic and Google inbound routes answer 501. The integration owner replaces
// this whole file with the formal implementation; nothing else may depend on
// behavior that is specific to this stub.
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { ModelCompatibility } from "../../domain/engine-configuration.js";

export type InboundProtocol =
  "openai-completions" | "openai-responses" | "anthropic" | "google";
export interface ModelGatewayOptions {
  upstream: {
    protocol: "openai-completions";
    /** Company address including an optional /v1 or path prefix; the gateway appends /chat/completions. */
    baseUrl: string;
    /** Resolved secret; never logged. */
    apiKey?: string;
    /** Resolved request headers; values may be secret. */
    headers?: Record<string, string>;
  };
  /** The only upstream model. */
  model: string;
  /** Model id shown to engines. */
  alias: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  compatibility?: ModelCompatibility;
  onCall?: (call: ModelCallRecord) => void;
}
export interface ModelCallRecord {
  id: string;
  inbound: InboundProtocol;
  stream: boolean;
  requestedModel?: string;
  upstreamModel: string;
  status: number;
  ok: boolean;
  durationMs: number;
  finishReason?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    reasoning?: number;
  };
  toolCalls: number;
  /** Redacted, at most 500 characters. */
  error?: { code: string; message: string };
}
export interface ModelGateway {
  /** http://127.0.0.1:<port>, without /v1. */
  readonly baseUrl: string;
  readonly token: string;
  beginRun(signal: AbortSignal): void;
  endRun(): Promise<void>;
  /** Failed upstream calls of the current Run, oldest first. */
  runErrors(): ModelCallRecord[];
  close(): Promise<void>;
}

const MAX_BYTES = 8 * 1024 * 1024;
const DROPPED = [
  "store",
  "metadata",
  "service_tier",
  "prediction",
  "modalities",
  "audio",
  "web_search_options",
  "user",
];
interface Scope {
  abort: AbortController;
  release: () => void;
  tasks: Set<Promise<void>>;
  errors: ModelCallRecord[];
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid request body");
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error("Model request exceeds 8 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Start the temporary Chat pass-through stub. See the file header. */
export async function startModelGateway(
  options: ModelGatewayOptions,
): Promise<ModelGateway> {
  const token = randomBytes(32).toString("hex");
  const target = `${options.upstream.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const secrets = [
    token,
    ...(options.upstream.apiKey ? [options.upstream.apiKey] : []),
    ...Object.values(options.upstream.headers ?? {}),
  ].filter((value) => value.length >= 4);
  const redact = (text: string) => {
    let output = text;
    for (const secret of secrets)
      output = output.split(secret).join("[REDACTED]");
    return Array.from(
      output.replace(/Bearer\s+[^\s"',]+/gi, "Bearer [REDACTED]"),
    )
      .slice(0, 500)
      .join("");
  };
  let scope: Scope | undefined;
  let closing: Promise<void> | undefined;
  const notify = (record: ModelCallRecord) => {
    try {
      options.onCall?.(record);
    } catch {
      // Observer failures are isolated from the model request (stub only).
    }
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const authenticated =
      request.headers.authorization === `Bearer ${token}` ||
      request.headers["x-api-key"] === token ||
      request.headers["x-goog-api-key"] === token ||
      url.searchParams.get("key") === token;
    if (!authenticated || request.headers.origin) {
      reply(response, 401, {
        error: { message: "Gateway authentication required" },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      reply(response, 200, {
        object: "list",
        data: [{ id: options.alias, object: "model", owned_by: "harnesshub" }],
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v1/models/${encodeURIComponent(options.alias)}`
    ) {
      reply(response, 200, {
        id: options.alias,
        object: "model",
        owned_by: "harnesshub",
      });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      reply(response, 501, {
        error: {
          message: "The temporary model gateway stub supports Chat only",
        },
      });
      return;
    }
    const owned = scope;
    if (!owned || owned.abort.signal.aborted || closing) {
      reply(response, 409, { error: { message: "No active Run" } });
      return;
    }
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      response.destroy();
    };
    owned.abort.signal.addEventListener("abort", cancel, { once: true });
    response.once("close", () => abort.abort());
    const started = Date.now();
    const task = (async () => {
      const record: ModelCallRecord = {
        id: randomUUID(),
        inbound: "openai-completions",
        stream: false,
        upstreamModel: options.model,
        status: 0,
        ok: false,
        durationMs: 0,
        toolCalls: 0,
      };
      try {
        const raw = await readBody(request);
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Chat request must be a JSON object");
        const body = { ...(raw as Record<string, unknown>) };
        record.stream = body.stream === true;
        if (typeof body.model === "string") record.requestedModel = body.model;
        body.model = options.model;
        for (const name of [
          ...DROPPED,
          ...(options.compatibility?.dropParameters ?? []),
        ])
          delete body[name];
        const upstream = await fetch(target, {
          method: "POST",
          redirect: "error",
          signal: abort.signal,
          headers: {
            "content-type": "application/json",
            ...(options.upstream.apiKey
              ? { authorization: `Bearer ${options.upstream.apiKey}` }
              : {}),
            ...options.upstream.headers,
          },
          body: JSON.stringify(body),
        });
        record.status = upstream.status;
        if (!upstream.ok) {
          const text = (await upstream.text()).slice(0, 65536);
          let message = text;
          try {
            const parsed = JSON.parse(text) as {
              error?: { message?: unknown } | string;
              message?: unknown;
            };
            const candidate =
              typeof parsed.error === "string"
                ? parsed.error
                : typeof parsed.error?.message === "string"
                  ? parsed.error.message
                  : typeof parsed.message === "string"
                    ? parsed.message
                    : undefined;
            if (candidate) message = candidate;
          } catch {
            // A non-JSON upstream error body is reported as redacted text.
          }
          record.error = {
            code: `upstream_http_${upstream.status}`,
            message: redact(message || `HTTP ${upstream.status}`),
          };
          reply(response, upstream.status, {
            error: {
              message: record.error.message,
              type: "upstream_error",
              code: upstream.status,
            },
          });
          return;
        }
        response.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        let text = "";
        if (upstream.body)
          for await (const chunk of upstream.body) {
            const buffer = Buffer.from(chunk);
            if (text.length < MAX_BYTES) text += buffer.toString("utf8");
            await new Promise<void>((resolve, reject) =>
              response.write(buffer, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          }
        response.end();
        record.ok = true;
        const calls = new Set<string>();
        const inspect = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          const chunk = value as {
            choices?: {
              finish_reason?: unknown;
              delta?: { tool_calls?: { index?: unknown; id?: unknown }[] };
              message?: { tool_calls?: unknown[] };
            }[];
          };
          for (const choice of chunk.choices ?? []) {
            if (typeof choice.finish_reason === "string")
              record.finishReason = choice.finish_reason;
            for (const call of choice.delta?.tool_calls ?? [])
              calls.add(String(call.index ?? call.id));
            for (const [index] of (choice.message?.tool_calls ?? []).entries())
              calls.add(String(index));
          }
        };
        for (const line of text.split(/\r?\n/)) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            inspect(JSON.parse(data));
          } catch {
            // Incomplete or non-JSON fragments are ignored by this stub.
          }
        }
        if (!record.stream)
          try {
            inspect(JSON.parse(text));
          } catch {
            // Non-JSON bodies carry no finish reason for this stub.
          }
        record.toolCalls = calls.size;
      } catch (error) {
        if (abort.signal.aborted) {
          record.error = { code: "aborted", message: "Request was aborted" };
          return;
        }
        record.status ||= 502;
        record.error ??= {
          code: "upstream_unreachable",
          message: redact(
            error instanceof Error ? error.message : "Upstream request failed",
          ),
        };
        reply(response, record.status, {
          error: { message: record.error.message },
        });
      } finally {
        record.durationMs = Date.now() - started;
        owned.abort.signal.removeEventListener("abort", cancel);
        if (!record.ok && record.error?.code !== "aborted")
          owned.errors.push(record);
        notify(record);
      }
    })();
    owned.tasks.add(task);
    void task.finally(() => owned.tasks.delete(task));
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Gateway listener did not bind TCP");
  const endRun = async () => {
    const owned = scope;
    if (!owned) return;
    scope = undefined;
    owned.release();
    owned.abort.abort();
    await Promise.allSettled([...owned.tasks]);
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    beginRun(signal) {
      if (scope || closing) throw new Error("Gateway Run is active or closed");
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) abort.abort();
      scope = {
        abort,
        release: () => signal.removeEventListener("abort", onAbort),
        tasks: new Set(),
        errors: [],
      };
    },
    endRun,
    runErrors: () => [...(scope?.errors ?? [])],
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await endRun();
        server.closeAllConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
