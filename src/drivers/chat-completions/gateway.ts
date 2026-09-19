import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { ModelCompatibility } from "../../domain/engine-configuration.js";
import {
  anthropicCountTokens,
  anthropicErrorResponse,
  anthropicToChat,
  AnthropicSink,
} from "./anthropic.js";
import { chatToChat, ChatSink, openAiErrorResponse } from "./chat.js";
import { googleErrorResponse, googleToChat, GoogleSink } from "./google.js";
import {
  ClientClosed,
  HttpWriter,
  type Failure,
  type OutputSink,
  type SinkContext,
} from "./output.js";
import {
  GatewayError,
  estimateTokens,
  type ChatTranslation,
  type ReasoningField,
} from "./protocol.js";
import {
  ReasoningCache,
  restoreReasoning,
  resultKeys,
  stripReasoning,
} from "./reasoning.js";
import { responsesToChat, ResponsesSink } from "./responses.js";
import {
  chatCompletionsUrl,
  isContextOverflow,
  normalizeRequest,
  readCompletion,
  sanitize,
  upstreamError,
  type UpstreamSettings,
} from "./upstream.js";

/** Engine-facing wire protocol of one model call. */
export type InboundProtocol =
  "openai-completions" | "openai-responses" | "anthropic" | "google";

/** Resolved configuration of one Session's gateway. Secrets are values, never references. */
export interface ModelGatewayOptions {
  upstream: {
    protocol: "openai-completions";
    /** Company base URL including an optional `/v1` or path prefix; the gateway appends `/chat/completions`. */
    baseUrl: string;
    /** Resolved secret; sent as `Authorization: Bearer`, never logged or returned. */
    apiKey?: string;
    /** Resolved request headers, possibly secret; applied after the API key. */
    headers?: Record<string, string>;
  };
  /** The only upstream model; requested model names are recorded but ignored. */
  model: string;
  /** Model id shown to engines by `/v1/models` and in responses without a requested model. */
  alias: string;
  contextWindow?: number;
  /** Larger engine output limits are clamped to this value; absent limits stay absent. */
  maxOutputTokens?: number;
  compatibility?: ModelCompatibility;
  /** Called once per model call, after the engine response ended. Exceptions are ignored. */
  onCall?: (call: ModelCallRecord) => void;
}

/**
 * One engine model call. Contains no prompt, completion text or secret.
 * `status` is the HTTP status returned to the engine, or for a failure after
 * streaming began, the status that failure would have had; 499 marks a call
 * cancelled by the engine disconnecting or by the Run ending.
 */
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
  /** Sanitized, at most 500 characters. */
  error?: { code: string; message: string };
}

/**
 * A Session-owned, authenticated loopback model gateway. Model calls are only
 * forwarded while a Run is active; `/v1/models` and token counting need none.
 */
export interface ModelGateway {
  /** `http://127.0.0.1:<port>`, without `/v1`. */
  readonly baseUrl: string;
  /** Random local token accepted as Bearer, `x-api-key`, `x-goog-api-key` or `?key=`. */
  readonly token: string;
  /**
   * Start the only active Run scope and clear `runErrors()`. Aborting `signal`
   * aborts its upstream requests. Throws when a Run is active or the gateway closed.
   */
  beginRun(signal: AbortSignal): void;
  /** Abort the Run's outstanding calls and resolve after all of them ended. Idempotent. */
  endRun(): Promise<void>;
  /**
   * Failed calls of the current Run in completion order (copies). Cleared by
   * `beginRun`; still readable after `endRun`. Cancelled calls are excluded.
   */
  runErrors(): ModelCallRecord[];
  /** Stop listening, end the Run and close connections. Idempotent and awaitable. */
  close(): Promise<void>;
}

/** Resource limits of one gateway. */
export interface GatewayLimits {
  /** Inbound request body bytes. */
  maxRequestBytes: number;
  /** Upstream response body bytes. */
  maxResponseBytes: number;
  /** Longest wait for upstream response headers or between body chunks. */
  idleTimeoutMs: number;
  /** Concurrent upstream requests per Session; further calls wait in order. */
  maxConcurrent: number;
  /** Calls allowed to wait for a slot before new ones get 429. */
  maxQueued: number;
  reasoningEntries: number;
  reasoningBytes: number;
}
export const DEFAULT_GATEWAY_LIMITS: Readonly<GatewayLimits> = {
  maxRequestBytes: 8 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  idleTimeoutMs: 300_000,
  maxConcurrent: 4,
  maxQueued: 32,
  reasoningEntries: 256,
  reasoningBytes: 4 * 1024 * 1024,
};

type Route =
  | { kind: "models"; id?: string }
  | { kind: "count" }
  | {
      kind: "call";
      protocol: InboundProtocol;
      model?: string;
      stream?: boolean;
      sse?: boolean;
    };
type CallRoute = Extract<Route, { kind: "call" }>;

interface RunScope {
  signal: AbortSignal;
  abort: AbortController;
  onAbort: () => void;
  tasks: Set<Promise<void>>;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new GatewayError("Malformed model gateway route");
  }
}
function matchRoute(method: string | undefined, url: URL): Route | undefined {
  const path = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  const google =
    /^\/v1(?:beta|alpha)?\/models\/(.+):(generateContent|streamGenerateContent)$/.exec(
      path,
    );
  if (google)
    return method === "POST"
      ? {
          kind: "call",
          protocol: "google",
          model: decode(google[1]!),
          stream: google[2] === "streamGenerateContent",
          sse: url.searchParams.get("alt") === "sse",
        }
      : undefined;
  const openai = path.replace(/^\/v1(?=\/)/, "");
  if (method === "GET") {
    if (openai === "/models") return { kind: "models" };
    const model = /^\/models\/([^/]+)$/.exec(openai);
    return model ? { kind: "models", id: decode(model[1]!) } : undefined;
  }
  if (method !== "POST") return undefined;
  switch (openai) {
    case "/chat/completions":
      return { kind: "call", protocol: "openai-completions" };
    case "/responses":
      return { kind: "call", protocol: "openai-responses" };
    case "/messages":
      return { kind: "call", protocol: "anthropic" };
    case "/messages/count_tokens":
      return { kind: "count" };
    default:
      return undefined;
  }
}
function guessProtocol(path: string): InboundProtocol {
  if (/\/messages(?:\/|$)/.test(path)) return "anthropic";
  if (/^\/+v1(?:beta|alpha)?\/models\/.+:/.test(path)) return "google";
  if (/\/responses\/?$/.test(path)) return "openai-responses";
  return "openai-completions";
}
function errorResponse(
  protocol: InboundProtocol,
  failure: Failure,
): { status: number; body: unknown } {
  switch (protocol) {
    case "openai-completions":
    case "openai-responses":
      return openAiErrorResponse(failure);
    case "anthropic":
      return anthropicErrorResponse(failure);
    case "google":
      return googleErrorResponse(failure);
  }
}
function failure(status: number, code: string, message: string): Failure {
  return { status, code, message, contextOverflow: false };
}
function reply(
  response: ServerResponse,
  protocol: InboundProtocol,
  value: Failure,
): void {
  const { status, body } = errorResponse(protocol, value);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const encoding = request.headers["content-encoding"];
  if (encoding && encoding !== "identity")
    throw new GatewayError(
      "Compressed model requests are unsupported",
      415,
      "unsupported_encoding",
    );
  const tooLarge = () =>
    new GatewayError(
      "Model request exceeds the gateway size limit",
      413,
      "request_too_large",
    );
  if (Number(request.headers["content-length"]) > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    bytes += chunk.length;
    if (bytes > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new GatewayError("Model request is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError("Model request is not valid JSON");
  }
}
async function readLimited(response: Response, maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body)
    for await (const chunk of response.body) {
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes >= maxBytes) break;
    }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** FIFO admission of upstream requests; a waiting call leaves the queue when aborted. */
class Slots {
  #active = 0;
  #waiting: (() => void)[] = [];
  constructor(
    private readonly limit: number,
    private readonly queue: number,
  ) {}
  acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#active < this.limit) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.queue)
      return Promise.reject(
        new GatewayError(
          "Too many concurrent model requests in this Session",
          429,
          "busy",
        ),
      );
    return new Promise<void>((resolve, reject) => {
      const admit = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.#waiting = this.#waiting.filter((waiter) => waiter !== admit);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiting.push(admit);
    });
  }
  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active--;
  }
}

function networkFailure(error: unknown): Failure | undefined {
  if (!(error instanceof TypeError) || error.cause === undefined)
    return undefined;
  const cause = error.cause as { code?: unknown; message?: unknown };
  const code =
    typeof cause.code === "string"
      ? cause.code
      : typeof cause.message === "string" && /redirect/i.test(cause.message)
        ? "redirect refused"
        : "network error";
  return failure(
    502,
    "upstream_unreachable",
    error.message === "terminated"
      ? `Upstream connection closed before the response completed (${code})`
      : `Upstream model request failed (${code})`,
  );
}

/** Same as {@link startModelGateway} with explicit resource limits. */
export async function createModelGateway(
  options: ModelGatewayOptions,
  limits: Readonly<GatewayLimits>,
): Promise<ModelGateway> {
  if (options.upstream.protocol !== "openai-completions")
    throw new Error(
      "The model gateway supports Chat Completions upstreams only",
    );
  if (!options.model || !options.alias)
    throw new Error("The model gateway requires a model and an alias");
  for (const value of [options.maxOutputTokens, options.contextWindow])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error("Model token limits must be positive integers");
  const target = chatCompletionsUrl(options.upstream.baseUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:")
    throw new Error("The model gateway upstream must use HTTP or HTTPS");
  const compatibility = options.compatibility ?? {};
  const settings: UpstreamSettings = {
    model: options.model,
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
    includeUsage: compatibility.includeUsage === true,
    maxTokensField: compatibility.maxTokensField ?? "max_tokens",
    dropParameters: compatibility.dropParameters ?? [],
  };
  const passReasoning = compatibility.reasoning !== "strip";
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token);
  const secrets = [
    token,
    ...(options.upstream.apiKey ? [options.upstream.apiKey] : []),
    ...Object.values(options.upstream.headers ?? {}),
  ];
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
  });
  if (options.upstream.apiKey)
    headers.set("authorization", `Bearer ${options.upstream.apiKey}`);
  for (const [name, value] of Object.entries(options.upstream.headers ?? {}))
    headers.set(name, value);
  const nonce = randomBytes(4).toString("hex");
  let generated = 0;
  const makeId = () => `call_${nonce}${(generated++).toString(36)}`;
  const cache = new ReasoningCache(
    limits.reasoningEntries,
    limits.reasoningBytes,
  );
  let reasoningField: ReasoningField = "reasoning_content";
  const slots = new Slots(limits.maxConcurrent, limits.maxQueued);
  let scope: RunScope | undefined;
  let closing: Promise<void> | undefined;
  let errors: ModelCallRecord[] = [];
  const created = Math.floor(Date.now() / 1000);

  const authenticated = (request: IncomingMessage, url: URL): boolean => {
    const candidates: string[] = [];
    const authorization = request.headers.authorization;
    if (authorization && /^Bearer\s+/i.test(authorization))
      candidates.push(authorization.replace(/^Bearer\s+/i, "").trim());
    for (const name of ["x-api-key", "x-goog-api-key"]) {
      const value = request.headers[name];
      if (typeof value === "string") candidates.push(value.trim());
    }
    const key = url.searchParams.get("key");
    if (key) candidates.push(key);
    return candidates.some((candidate) => {
      const bytes = Buffer.from(candidate);
      return (
        bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes)
      );
    });
  };
  const modelObject = () => ({
    id: options.alias,
    object: "model",
    type: "model",
    created,
    created_at: new Date(created * 1000).toISOString(),
    owned_by: "harnesshub",
    display_name: options.alias,
    ...(options.contextWindow === undefined
      ? {}
      : {
          context_window: options.contextWindow,
          context_length: options.contextWindow,
          max_model_len: options.contextWindow,
        }),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: options.maxOutputTokens }),
  });
  const emit = (record: ModelCallRecord) => {
    try {
      options.onCall?.(record);
    } catch {
      // Observer failures must not change the engine response or the Run.
    }
  };
  const translate = (route: CallRoute, raw: unknown): ChatTranslation => {
    switch (route.protocol) {
      case "openai-completions":
        return chatToChat(raw);
      case "openai-responses":
        return responsesToChat(raw);
      case "anthropic":
        return anthropicToChat(raw);
      case "google":
        return googleToChat(
          raw,
          route.model ?? options.alias,
          route.stream === true,
        );
    }
  };
  const createSink = (
    route: CallRoute,
    writer: HttpWriter,
    translation: ChatTranslation,
    context: SinkContext,
  ): OutputSink => {
    switch (route.protocol) {
      case "openai-completions":
        return new ChatSink(writer, translation, context);
      case "openai-responses":
        return new ResponsesSink(writer, translation, context);
      case "anthropic":
        return new AnthropicSink(writer, translation, context);
      case "google":
        return new GoogleSink(writer, translation, context, route.sse === true);
    }
  };
  const classify = (
    error: unknown,
    cancelled: boolean,
    idle: boolean,
  ): Failure => {
    if (idle)
      return failure(
        504,
        "upstream_timeout",
        `Upstream model sent no data for ${Math.round(limits.idleTimeoutMs / 1000)} seconds`,
      );
    if (cancelled || error instanceof ClientClosed)
      return failure(499, "cancelled", "Model call was cancelled");
    if (error instanceof GatewayError)
      return {
        status: error.status,
        code: error.code,
        message: sanitize(error.message, secrets),
        contextOverflow: error.contextOverflow,
      };
    return (
      networkFailure(error) ??
      failure(500, "gateway_error", "Model gateway internal error")
    );
  };

  const modelCall = async (
    route: CallRoute,
    request: IncomingMessage,
    response: ServerResponse,
    owned: RunScope,
  ): Promise<void> => {
    const started = performance.now();
    const id = randomUUID().replaceAll("-", "");
    const record: ModelCallRecord = {
      id: `mc_${id}`,
      inbound: route.protocol,
      stream: route.stream === true,
      ...(route.model ? { requestedModel: route.model.slice(0, 256) } : {}),
      upstreamModel: options.model,
      status: 0,
      ok: false,
      durationMs: 0,
      toolCalls: 0,
    };
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      request.destroy();
      response.destroy();
    };
    owned.abort.signal.addEventListener("abort", cancel, { once: true });
    const closed = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.once("close", closed);
    if (owned.abort.signal.aborted) cancel();
    const writer = new HttpWriter(response);
    let sink: OutputSink | undefined;
    let translation: ChatTranslation | undefined;
    let admitted = false,
      idle = false;
    let timer: NodeJS.Timeout | undefined;
    const idleAbort = new AbortController();
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        idleAbort.abort();
      }, limits.idleTimeoutMs);
    };
    try {
      const raw = await readJson(request, limits.maxRequestBytes);
      translation = translate(route, raw);
      record.stream = translation.stream;
      if (translation.requestedModel)
        record.requestedModel = translation.requestedModel.slice(0, 256);
      const messages = translation.body.messages;
      if (passReasoning) restoreReasoning(messages, cache, reasoningField);
      else stripReasoning(messages);
      const body = normalizeRequest(translation.body, settings);
      sink = createSink(route, writer, translation, {
        model: translation.requestedModel || options.alias,
        reasoning: passReasoning,
        promptEstimate:
          route.protocol === "anthropic"
            ? estimateTokens({ messages: body.messages, tools: body.tools })
            : 0,
        id,
        created: Math.floor(Date.now() / 1000),
      });
      await slots.acquire(abort.signal);
      admitted = true;
      touch();
      const upstream = await fetch(target, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([abort.signal, idleAbort.signal]),
        headers,
        body: JSON.stringify(body),
      });
      touch();
      if (!upstream.ok) {
        const reported = upstreamError(
          await readLimited(upstream, 64 * 1024),
          upstream.status,
        );
        throw new GatewayError(
          reported.message,
          upstream.status,
          "upstream_http_error",
          isContextOverflow(reported.code, reported.message),
        );
      }
      const result = await readCompletion(upstream, sink, makeId, {
        maxBytes: limits.maxResponseBytes,
        activity: touch,
      });
      clearTimeout(timer);
      await sink.finish(result);
      if (passReasoning && result.reasoning) {
        if (result.reasoningField) reasoningField = result.reasoningField;
        cache.remember(result.reasoning, resultKeys(result));
      }
      record.status = 200;
      record.ok = true;
      record.finishReason = result.finish;
      record.toolCalls = result.calls.length;
      const usage = result.usage;
      if (
        usage &&
        [usage.input, usage.output, usage.total, usage.reasoning].some(
          (value) => value !== undefined,
        )
      )
        record.usage = {
          ...(usage.input === undefined ? {} : { input: usage.input }),
          ...(usage.output === undefined ? {} : { output: usage.output }),
          ...(usage.total === undefined ? {} : { total: usage.total }),
          ...(usage.reasoning === undefined
            ? {}
            : { reasoning: usage.reasoning }),
        };
    } catch (error) {
      // A reset engine connection can fail the body read before `close` runs.
      // (`request.destroyed` is also true after a complete body; not a signal.)
      const reported = classify(
        error,
        abort.signal.aborted || response.destroyed,
        idle,
      );
      record.status = reported.contextOverflow ? 400 : reported.status;
      record.error = {
        code: reported.contextOverflow
          ? "context_length_exceeded"
          : reported.code,
        message: reported.message,
      };
      if (reported.code === "cancelled") {
        if (!response.writableEnded) response.destroy();
      } else
        try {
          if (writer.sent) await sink?.fail(reported);
          else if (
            route.protocol === "openai-responses" &&
            reported.contextOverflow &&
            translation?.stream &&
            sink
          )
            // Codex 0.153 recognizes context overflow only as a streamed response.failed.
            await sink.fail(reported);
          else {
            const { status, body } = errorResponse(route.protocol, reported);
            await writer.json(status, body);
          }
        } catch {
          response.destroy();
        }
    } finally {
      clearTimeout(timer);
      if (admitted) slots.release();
      owned.abort.signal.removeEventListener("abort", cancel);
      response.removeListener("close", closed);
      abort.abort();
      record.durationMs = Math.round(performance.now() - started);
      if (!record.ok && record.error?.code !== "cancelled") errors.push(record);
      emit(record);
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      reply(
        response,
        "openai-completions",
        failure(400, "invalid_request", "Malformed model gateway route"),
      );
      return;
    }
    const protocol = guessProtocol(url.pathname);
    if (request.headers.origin !== undefined) {
      reply(
        response,
        protocol,
        failure(403, "forbidden", "Browser requests are not accepted"),
      );
      return;
    }
    if (!authenticated(request, url)) {
      reply(
        response,
        protocol,
        failure(401, "unauthorized", "Model gateway authentication required"),
      );
      return;
    }
    let route: Route | undefined;
    try {
      route = matchRoute(request.method, url);
    } catch (error) {
      reply(
        response,
        protocol,
        failure(
          400,
          "invalid_request",
          error instanceof GatewayError ? error.message : "Malformed route",
        ),
      );
      return;
    }
    if (!route) {
      reply(
        response,
        protocol,
        failure(404, "not_found", "Unsupported model gateway route"),
      );
      return;
    }
    if (route.kind === "models") {
      if (
        route.id !== undefined &&
        route.id !== options.alias &&
        route.id !== options.model
      ) {
        reply(response, protocol, failure(404, "not_found", "Unknown model"));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          route.id === undefined
            ? {
                object: "list",
                data: [modelObject()],
                has_more: false,
                first_id: options.alias,
                last_id: options.alias,
              }
            : modelObject(),
        ),
      );
      return;
    }
    if (route.kind === "count") {
      try {
        const counted = anthropicCountTokens(
          await readJson(request, limits.maxRequestBytes),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(counted));
      } catch (error) {
        reply(response, "anthropic", classify(error, false, false));
      }
      return;
    }
    const owned = scope;
    if (!owned || owned.abort.signal.aborted || closing) {
      reply(
        response,
        route.protocol,
        failure(409, "no_active_run", "No active Run owns this model request"),
      );
      return;
    }
    const task = modelCall(route, request, response, owned);
    owned.tasks.add(task);
    await task.finally(() => owned.tasks.delete(task));
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Model gateway listener did not bind TCP");
  }
  const endRun = async () => {
    const owned = scope;
    if (!owned) return;
    scope = undefined;
    owned.abort.abort();
    owned.signal.removeEventListener("abort", owned.onAbort);
    await Promise.allSettled([...owned.tasks]);
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    beginRun(signal) {
      if (closing) throw new Error("Model gateway is closed");
      if (scope) throw new Error("Model gateway already has an active Run");
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      scope = { signal, abort, onAbort, tasks: new Set() };
      errors = [];
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) abort.abort();
    },
    endRun,
    runErrors: () => errors.map((record) => ({ ...record })),
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

/**
 * Start a Session's model gateway on `127.0.0.1` with a random port and token.
 * It accepts Chat Completions, Responses, Anthropic Messages and Google
 * GenerateContent calls and forwards each as one streaming Chat Completions
 * request for `options.model` to `${upstream.baseUrl}/chat/completions`.
 * No upstream request happens outside `beginRun`/`endRun`. The caller owns
 * the returned gateway and must await `close()`, also after failed probes.
 */
export function startModelGateway(
  options: ModelGatewayOptions,
): Promise<ModelGateway> {
  return createModelGateway(options, DEFAULT_GATEWAY_LIMITS);
}
