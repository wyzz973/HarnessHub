#!/usr/bin/env node
/**
 * Streaming-only strict proxy that makes a real OpenAI-compatible upstream (for example
 * DeepSeek) behave like the company model gateway (ADR 0013). Requests that the company
 * gateway would refuse (non-streaming, `stream_options`, `store`, `metadata`,
 * `max_completion_tokens`, `developer` role, misplaced system messages, a model other
 * than `--expect-model`, ...) get HTTP 400 locally and are never forwarded; accepted
 * requests are forwarded unchanged to `<upstream>/chat/completions` and the response
 * bytes are streamed back with the upstream status.
 *
 * Credentials: the proxy never reads, stores or logs keys. It forwards the caller's
 * `Authorization` header unchanged; point HARNESSHUB_MODEL_BASE_URL at the printed URL and
 * keep HARNESSHUB_MODEL_API_KEY set to the upstream key in the Gateway environment.
 * Logs contain paths, models, statuses, violations and durations only.
 *
 * Usage: node scripts/strict-chat-proxy.mjs --upstream https://api.deepseek.com/v1
 *   [--host 127.0.0.1] [--port 0] [--expect-model ID] [--log FILE]
 */
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  chatError,
  isObject,
  readBody,
  sendJson,
  strictChatViolations,
} from "./lib/strict-chat.mjs";

/**
 * Start the proxy.
 *
 * @param {{upstream: string, host?: string, port?: number, expectModel?: string,
 *   logFile?: string, fetchImpl?: typeof fetch}} options `upstream` is the SDK base URL
 *   (normally ending in /v1), not the full /chat/completions route.
 * @returns {Promise<{url: string, port: number, records: () => object[], close: () => Promise<void>}>}
 *   `close` stops listening and aborts in-flight upstream requests.
 */
export async function startStrictChatProxy(options) {
  const base = new URL(options.upstream);
  if (!/^https?:$/.test(base.protocol))
    throw new Error("--upstream must be an http(s) URL");
  const upstreamBase = base.href.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const records = [];
  const inFlight = new Set();
  const sockets = new Set();
  let sequence = 0;
  let logQueue = Promise.resolve();

  function record(entry) {
    const value = { seq: ++sequence, at: new Date().toISOString(), ...entry };
    records.push(value);
    if (records.length > 10_000) records.shift();
    const line = `${JSON.stringify(value)}\n`;
    if (options.logFile) {
      logQueue = logQueue.then(() => appendFile(options.logFile, line));
      logQueue.catch(() => undefined);
    } else process.stdout.write(line);
  }

  async function forward(request, response, entry, target, body) {
    const controller = new AbortController();
    inFlight.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const headers = { accept: "text/event-stream, application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (typeof request.headers.authorization === "string")
        headers.authorization = request.headers.authorization;
      const upstream = await fetchImpl(target, {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      entry.upstreamStatus = upstream.status;
      entry.status = upstream.status;
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      let bytes = 0;
      if (upstream.body)
        for await (const chunk of upstream.body) {
          if (response.destroyed) break;
          bytes += chunk.length;
          if (!response.write(chunk)) await once(response, "drain");
        }
      entry.bytes = bytes;
      if (!response.destroyed) response.end();
    } catch (error) {
      if (controller.signal.aborted) entry.aborted = true;
      else {
        entry.status = 502;
        entry.error =
          error instanceof Error
            ? error.message.slice(0, 300)
            : "upstream failure";
      }
      if (!response.headersSent)
        sendJson(
          response,
          502,
          chatError("Upstream request failed", "upstream_error"),
        );
      else response.destroy();
    } finally {
      inFlight.delete(controller);
    }
  }

  const server = createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const entry = { method: request.method, path: url.pathname, status: 0 };
    response.once("close", () => {
      entry.durationMs = Date.now() - started;
      record(entry);
    });
    if (url.pathname === "/v1/models" && request.method === "GET") {
      void forward(request, response, entry, `${upstreamBase}/models`);
      return;
    }
    if (url.pathname !== "/v1/chat/completions") {
      entry.status = 404;
      sendJson(
        response,
        404,
        chatError(`Unknown path ${url.pathname}`, "not_found_error"),
      );
      return;
    }
    if (request.method !== "POST") {
      entry.status = 405;
      sendJson(response, 405, chatError("Method not allowed"));
      return;
    }
    readBody(request)
      .then((raw) => {
        let body;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          entry.status = 400;
          entry.violations = ["request body is not valid JSON"];
          sendJson(response, 400, chatError("Request body is not valid JSON"));
          return;
        }
        entry.model =
          isObject(body) && typeof body.model === "string" ? body.model : null;
        const violations = strictChatViolations(
          body,
          options.expectModel !== undefined
            ? { expectModel: options.expectModel }
            : {},
        );
        if (violations.length) {
          entry.status = 400;
          entry.violations = violations;
          sendJson(
            response,
            400,
            chatError(
              `Rejected by strict company gateway emulation: ${violations.join("; ")}`,
            ),
          );
          return;
        }
        return forward(
          request,
          response,
          entry,
          `${upstreamBase}/chat/completions`,
          raw,
        );
      })
      .catch((error) => {
        entry.status = error.statusCode ?? 400;
        sendJson(response, entry.status, chatError(error.message));
      });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  await once(server, "listening");
  const host = options.host ?? "127.0.0.1";
  const port = server.address().port;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/v1`,
    port,
    records: () => records.slice(),
    async close() {
      for (const controller of inFlight) controller.abort();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      await logQueue.catch(() => undefined);
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        upstream: { type: "string" },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "0" },
        "expect-model": { type: "string" },
        log: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (values.help || !values.upstream) {
      console.log(
        "node scripts/strict-chat-proxy.mjs --upstream https://api.deepseek.com/v1 [--host 127.0.0.1] [--port 0] [--expect-model ID] [--log FILE]",
      );
      if (!values.help) process.exitCode = 2;
    } else {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("--port must be 0-65535");
      const proxy = await startStrictChatProxy({
        upstream: values.upstream,
        host: values.host,
        port,
        ...(values["expect-model"]
          ? { expectModel: values["expect-model"] }
          : {}),
        ...(values.log ? { logFile: path.resolve(values.log) } : {}),
      });
      console.log(
        JSON.stringify({
          event: "strict-chat-proxy.ready",
          url: proxy.url,
          upstream: new URL(values.upstream).origin,
        }),
      );
      const stop = () => {
        proxy.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
