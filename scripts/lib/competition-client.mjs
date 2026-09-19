/**
 * Minimal HTTP/SSE client for the local competition Gateway, shared by
 * competition-acceptance.mjs, competition-selftest.mjs and competition-matrix.mjs.
 *
 * Uses node:http directly: `prompt_async` blocks until a turn completes, and fetch's
 * default 300 s header timeout would turn a long but healthy turn into a client error.
 * Only plain http is supported because the Gateway accepts loopback hosts only.
 */
import http from "node:http";

const maxResponseBytes = 16 * 1024 * 1024;

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Send one request and buffer the response.
 *
 * @param {string} url Absolute http:// URL.
 * @param {{method?: string, body?: unknown, headers?: Record<string, string>,
 *   timeoutMs?: number, signal?: AbortSignal}} [options] `body` is JSON-encoded unless a string.
 * @returns {Promise<{status: number, headers: import("node:http").IncomingHttpHeaders,
 *   text: string, json: unknown}>} `json` is undefined when the body is not JSON.
 *   Rejects on connection errors, timeout (`code: "TIMEOUT"`) and abort (`code: "ABORTED"`).
 */
export function httpRequest(url, options = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:")
    return Promise.reject(
      failure("Only http:// Gateway URLs are supported", "UNSUPPORTED"),
    );
  const method = options.method ?? "GET";
  const payload =
    options.body === undefined
      ? undefined
      : Buffer.from(
          typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body),
        );
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(target, {
      method,
      agent: false,
      headers: {
        accept: "application/json",
        ...(payload
          ? {
              "content-type": "application/json",
              "content-length": String(payload.length),
            }
          : {}),
        ...options.headers,
      },
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      request.destroy(
        failure(
          `${method} ${target.pathname} timed out after ${timeoutMs} ms`,
          "TIMEOUT",
        ),
      );
    }, timeoutMs);
    const onAbort = () =>
      request.destroy(
        failure(`${method} ${target.pathname} aborted`, "ABORTED"),
      );
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => finish(error));
    request.once("response", (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= maxResponseBytes) chunks.push(chunk);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        finish(undefined, {
          status: response.statusCode ?? 0,
          headers: response.headers,
          text,
          json,
        });
      });
    });
    request.end(payload);
  });
}

/**
 * Subscribe to a server-sent event stream whose frames carry JSON `data:` payloads.
 *
 * @param {string} url Absolute http:// URL.
 * @param {(event: unknown, receivedAt: number) => void} onEvent Called once per JSON frame.
 * @returns {{ready: Promise<number>, closed: Promise<void>, close: () => void}} `ready`
 *   resolves with the HTTP status once headers arrive (rejects for non-200 or a non-SSE
 *   content type); `closed` resolves when the stream ends for any reason.
 */
export function subscribeEvents(url, onEvent, options = {}) {
  const target = new URL(url);
  let request;
  const closed = Promise.withResolvers();
  const ready = new Promise((resolve, reject) => {
    request = http.request(target, {
      agent: false,
      headers: { accept: "text/event-stream" },
    });
    const timer = setTimeout(
      () =>
        request.destroy(
          failure("Event stream did not open in time", "TIMEOUT"),
        ),
      options.timeoutMs ?? 15_000,
    );
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
      closed.resolve();
    });
    request.once("response", (response) => {
      clearTimeout(timer);
      const type = String(response.headers["content-type"] ?? "");
      if (response.statusCode !== 200 || !type.includes("text/event-stream")) {
        reject(
          failure(
            `Event stream returned ${response.statusCode} ${type}`,
            "BAD_STREAM",
          ),
        );
        response.resume();
        request.destroy();
        closed.resolve();
        return;
      }
      resolve(response.statusCode);
      response.setEncoding("utf8");
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (!separator) break;
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          let value;
          try {
            value = JSON.parse(data);
          } catch {
            continue;
          }
          onEvent(value, Date.now());
        }
      });
      response.once("close", () => closed.resolve());
      response.once("error", () => closed.resolve());
    });
    request.end();
  });
  ready.catch(() => undefined);
  return {
    ready,
    closed: closed.promise,
    close: () => request.destroy(),
  };
}

/**
 * Race `promise` against a timer that is always cleared, so an abandoned timeout never
 * keeps the process alive. Resolves `{timedOut: false, value}` or `{timedOut: true}`.
 */
export function raceTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/** Poll `probe` until it returns a truthy value or the deadline passes. */
export async function waitUntil(
  probe,
  { timeoutMs, intervalMs = 250, signal } = {},
) {
  const deadline = Date.now() + (timeoutMs ?? 30_000);
  for (;;) {
    signal?.throwIfAborted();
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Short printable summary of an HTTP response body for diagnostics. */
export function summarizeBody(response) {
  if (response.json !== undefined) {
    const text = JSON.stringify(response.json);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  return response.text.length > 400
    ? `${response.text.slice(0, 400)}…`
    : response.text;
}
