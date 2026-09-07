import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  BridgeProtocolError,
  object,
  array,
  string,
  responsesToChat,
  responseOutput,
  googleToChat,
  googleOutput,
  type ChatResult,
  type ChatTranslation,
} from "./protocol.js";

const MAX_BYTES = 8 * 1024 * 1024;
interface RunScope {
  signal: AbortSignal;
  abort: AbortController;
  cancel: () => void;
  tasks: Set<Promise<void>>;
}
/** A Session owns this authenticated loopback listener; each Run owns its upstream requests. */
export interface ModelBridge {
  readonly baseUrl: string;
  readonly token: string;
  /** Start exactly one Run scope. An inactive or aborted scope never sends model requests. */
  beginRun(signal: AbortSignal): void;
  /** Abort outstanding requests and await their completion before reusing the Session. */
  endRun(): Promise<void>;
  /** Idempotently stop accepting requests, abort work and await listener shutdown. */
  close(): Promise<void>;
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    if (!Buffer.isBuffer(value))
      throw new BridgeProtocolError("Invalid request body");
    bytes += value.length;
    if (bytes > MAX_BYTES)
      throw new BridgeProtocolError("Model request exceeds 8 MiB", 413);
    chunks.push(value);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
async function write(response: ServerResponse, value: string): Promise<void> {
  if (response.destroyed) throw new Error("Bridge client disconnected");
  await new Promise<void>((resolve, reject) =>
    response.write(value, (error) => (error ? reject(error) : resolve())),
  );
}
function usage(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = object(raw);
  const input = value.prompt_tokens,
    output = value.completion_tokens,
    total = value.total_tokens;
  if (
    ![input, output, total].every(
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw new BridgeProtocolError("Invalid upstream usage", 502);
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}
async function consumeChat(
  upstream: Response,
  onText: (text: string) => Promise<void>,
): Promise<ChatResult> {
  const result: ChatResult = { text: "", calls: [], finish: "" };
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let bytes = 0;
  const consume = async (raw: unknown, stream: boolean) => {
    const chunk = object(raw);
    if (chunk.error)
      throw new BridgeProtocolError(
        "Company gateway returned a model error",
        502,
      );
    if (chunk.usage) result.usage = usage(chunk.usage)!;
    const choices = array(chunk.choices);
    if (choices.length === 0) return;
    if (choices.length !== 1)
      throw new BridgeProtocolError(
        "Chat bridge requires one completion choice",
        502,
      );
    const choice = object(choices[0]);
    if (choice.index !== 0)
      throw new BridgeProtocolError("Unexpected completion index", 502);
    const delta = object(stream ? choice.delta : choice.message);
    if (delta.refusal)
      throw new BridgeProtocolError("Upstream refused the request", 502);
    if (delta.content !== undefined && delta.content !== null) {
      const text = string(delta.content);
      result.text += text;
      await onText(text);
    }
    if (delta.tool_calls !== undefined)
      for (const [at, rawCall] of array(delta.tool_calls).entries()) {
        const call = object(rawCall),
          index = stream ? call.index : at;
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index > 127
        )
          throw new BridgeProtocolError("Invalid upstream tool index", 502);
        let target = calls.get(index);
        if (!target) {
          target = { id: "", name: "", arguments: "" };
          calls.set(index, target);
        }
        if (call.id !== undefined) target.id += string(call.id);
        if (call.function !== undefined) {
          const fn = object(call.function);
          if (fn.name !== undefined) target.name += string(fn.name);
          if (fn.arguments !== undefined)
            target.arguments += string(fn.arguments);
        }
        if (call.type !== undefined && call.type !== "function")
          throw new BridgeProtocolError("Unsupported upstream tool type", 502);
      }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (result.finish)
        throw new BridgeProtocolError("Duplicate completion finish", 502);
      result.finish = string(choice.finish_reason);
    }
  };
  if (!upstream.body) throw new BridgeProtocolError("Empty upstream body", 502);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    done = false;
  const isJson = upstream.headers
    .get("content-type")
    ?.includes("application/json");
  for await (const chunk of upstream.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES)
      throw new BridgeProtocolError("Model response exceeds 8 MiB", 502);
    pending += decoder.decode(chunk, { stream: true });
    if (isJson) continue;
    pending = pending.replace(/\r\n/g, "\n");
    let split: number;
    while ((split = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, split);
      pending = pending.slice(split + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      if (done)
        throw new BridgeProtocolError(
          "Upstream sent data after completion",
          502,
        );
      if (data === "[DONE]") {
        done = true;
        continue;
      }
      await consume(JSON.parse(data), true);
    }
  }
  pending += decoder.decode();
  if (isJson) await consume(JSON.parse(pending), false);
  else if (pending.trim())
    throw new BridgeProtocolError("Upstream SSE ended in a partial event", 502);
  if (!["stop", "tool_calls"].includes(result.finish))
    throw new BridgeProtocolError(
      result.finish === "length"
        ? "Upstream completion exceeded its token limit"
        : "Upstream did not finish the completion",
      502,
    );
  result.calls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
  if ((result.finish === "tool_calls") !== result.calls.length > 0)
    throw new BridgeProtocolError(
      "Completion finish and tool calls disagree",
      502,
    );
  const ids = new Set<string>();
  for (const call of result.calls) {
    if (!call.id || !call.name || ids.has(call.id))
      throw new BridgeProtocolError("Invalid upstream tool identity", 502);
    ids.add(call.id);
    object(JSON.parse(call.arguments));
  }
  return result;
}
async function respond(
  response: ServerResponse,
  translation: ChatTranslation,
  upstream: Response,
  model: string,
): Promise<void> {
  if (translation.wire === "google") {
    if (translation.stream)
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
    const result = await consumeChat(upstream, async (text) => {
      if (translation.stream && text)
        await write(
          response,
          `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] } }] })}\n\n`,
        );
    });
    const final = googleOutput(
      { ...result, text: translation.stream ? "" : result.text },
      translation.tools,
    );
    if (translation.stream) {
      await write(response, `data: ${JSON.stringify(final)}\n\n`);
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(final));
    }
    return;
  }
  const id = randomUUID().replaceAll("-", "");
  let sequence = 0;
  const event = async (type: string, fields: Record<string, unknown>) =>
    write(
      response,
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
    );
  const base = {
    id: `resp_${id}`,
    object: "response",
    model,
    created_at: Math.floor(Date.now() / 1000),
  };
  if (translation.stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    await event("response.created", {
      response: { ...base, status: "in_progress", output: [] },
    });
  }
  let textStarted = false;
  const result = await consumeChat(upstream, async (text) => {
    if (!translation.stream || !text) return;
    if (!textStarted) {
      textStarted = true;
      await event("response.output_item.added", {
        output_index: 0,
        item: {
          id: `msg_${id}`,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      await event("response.content_part.added", {
        item_id: `msg_${id}`,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    await event("response.output_text.delta", {
      item_id: `msg_${id}`,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
  });
  const output = responseOutput(result, translation.tools, id);
  const body = {
    ...base,
    status: "completed",
    output,
    ...(result.usage ? { usage: result.usage } : {}),
  };
  if (translation.stream) {
    for (const [index, item] of output.entries()) {
      if (item.type === "message")
        await event("response.output_text.done", {
          item_id: item.id,
          output_index: index,
          content_index: 0,
          text: result.text,
        });
      else
        await event("response.output_item.added", {
          output_index: index,
          item: { ...item, status: "in_progress" },
        });
      await event("response.output_item.done", { output_index: index, item });
    }
    await event("response.completed", { response: body });
    response.end();
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }
}

/** Start an authenticated, text/tool-only Responses adapter for a configured Chat Completions base URL. No upstream request occurs before beginRun. */
export async function startModelBridge(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  wire?: "responses" | "google";
}): Promise<ModelBridge> {
  const target = new URL(
    options.baseUrl.replace(/\/$/, "") + "/chat/completions",
  );
  const token = randomBytes(32).toString("hex");
  let scope: RunScope | undefined, closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const owned = scope;
    const reject = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { type: "invalid_request_error", message } }),
      );
    };
    const authenticated =
      options.wire === "google"
        ? request.headers["x-goog-api-key"] === token ||
          request.headers.authorization === `Bearer ${token}`
        : request.headers.authorization === `Bearer ${token}`;
    if (!authenticated || request.headers.origin) {
      reject(401, "Bridge authentication required");
      return;
    }
    let googleRoute: RegExpMatchArray | null = null,
      routeMatches = false;
    try {
      const route = new URL(request.url ?? "/", "http://127.0.0.1");
      googleRoute = route.pathname.match(
        /^\/v1(?:beta)?\/models\/(.+):(streamGenerateContent|generateContent)$/,
      );
      routeMatches =
        options.wire === "google"
          ? Boolean(
              googleRoute &&
              decodeURIComponent(googleRoute[1]!) === options.model,
            )
          : request.url === "/v1/responses";
    } catch {
      reject(400, "Malformed model bridge route");
      return;
    }
    if (request.method !== "POST" || !routeMatches) {
      reject(404, "Unsupported model bridge route");
      return;
    }
    if (!owned || owned.abort.signal.aborted || closing) {
      reject(409, "No active Run owns this request");
      return;
    }
    if (owned.tasks.size >= 2) {
      reject(429, "Session model request concurrency exceeded");
      return;
    }
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      request.destroy();
      response.destroy();
    };
    owned.abort.signal.addEventListener("abort", cancel, { once: true });
    const disconnected = () => abort.abort();
    response.once("close", disconnected);
    const task = (async () => {
      try {
        const raw = await readJson(request);
        const translated =
          options.wire === "google"
            ? googleToChat(
                raw,
                options.model,
                googleRoute?.[2] === "streamGenerateContent",
              )
            : responsesToChat(raw, options.model);
        abort.signal.throwIfAborted();
        const upstream = await fetch(target, {
          method: "POST",
          redirect: "error",
          signal: abort.signal,
          headers: {
            "content-type": "application/json",
            ...(options.apiKey
              ? { authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify(translated.body),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          throw new BridgeProtocolError(
            `Company gateway returned HTTP ${upstream.status}`,
            upstream.status === 401 || upstream.status === 403
              ? upstream.status
              : 502,
          );
        }
        await respond(response, translated, upstream, options.model);
      } catch (error) {
        if (abort.signal.aborted) return;
        const failure =
          error instanceof BridgeProtocolError
            ? error
            : new BridgeProtocolError(
                "Model bridge could not complete the request",
                502,
              );
        if (response.headersSent) {
          await write(
            response,
            options.wire === "google"
              ? `data: ${JSON.stringify({ error: { code: failure.status, message: failure.message, status: "INVALID_ARGUMENT" } })}\n\n`
              : `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "invalid_prompt", message: failure.message } } })}\n\n`,
          ).catch(() => undefined);
          response.end();
        } else reject(failure.status, failure.message);
      } finally {
        abort.abort();
        owned.abort.signal.removeEventListener("abort", cancel);
        response.removeListener("close", disconnected);
      }
    })();
    owned.tasks.add(task);
    void task
      .finally(() => owned.tasks.delete(task))
      .catch(() => response.destroy());
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Bridge listener did not bind TCP");
  const endRun = async () => {
    const owned = scope;
    if (!owned) return;
    scope = undefined;
    owned.abort.abort();
    owned.signal.removeEventListener("abort", owned.cancel);
    await Promise.all([...owned.tasks]);
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}${options.wire === "google" ? "" : "/v1"}`,
    token,
    beginRun(signal) {
      if (scope || closing) throw new Error("Bridge is active or closed");
      const abort = new AbortController();
      const cancel = () => abort.abort();
      scope = { signal, abort, cancel, tasks: new Set() };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) abort.abort();
    },
    endRun,
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
