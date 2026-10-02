// SPDX-License-Identifier: MIT
/**
 * One routed model call of the shared gateway: candidate attempts with
 * retries, failover and breakers (03 section 5), native passthrough or
 * translation to a Chat upstream (section 3), output held before the first
 * content event while alternatives remain, and the `model.call` entry
 * committed before the terminal event or body is written (section 8).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type { LogSink } from "@harnesshub/core/logging";
import type {
  CallAttempt,
  GatewayKeyRecord,
  ModelCallEntry,
  ModelPlaneStore,
  RouteGroup,
  WireProtocol,
} from "@harnesshub/core/model-plane";
import {
  anthropicErrorResponse,
  anthropicToChat,
  AnthropicSink,
} from "./anthropic.js";
import {
  chatToChat,
  ChatSink,
  openAiError,
  openAiErrorResponse,
} from "./chat.js";
import { googleErrorResponse, googleToChat, GoogleSink } from "./google.js";
import {
  failure,
  networkFailure,
  readLimited,
  type MemoryBudget,
  type Slots,
} from "./http.js";
import { createDecoder, type UpstreamDecoder } from "./decode.js";
import { encodeRequest } from "./encode.js";
import { Keepalive } from "./keepalive.js";
import type { Quotas } from "./quota.js";
import type { Conversation, StickyRoutes } from "./sticky.js";
import { callCost, callUsage, usageParts, type UsageParts } from "./ledger.js";
import type { HandlerLimits } from "./limits.js";
import type { HttpWriter } from "./output.js";
import { ClientClosed, sse, type Failure, type OutputSink } from "./output.js";
import {
  ArraySegmenter,
  observeEvent,
  observeJson,
  passthroughBody,
  SseSegmenter,
  unsupportedPatches,
  upstreamHeaders,
  upstreamUrl,
  type GeminiTarget,
  type Observation,
  type Segment,
} from "./passthrough.js";
import {
  GatewayError,
  estimateTokens,
  type ChatResult,
  type ChatTranslation,
  type ReasoningField,
  type TranslateOptions,
} from "./protocol.js";
import { ReasoningCache, restoreReasoning, resultKeys } from "./reasoning.js";
import { responsesToChat, ResponsesSink, streamCode } from "./responses.js";
import {
  backoff,
  classify,
  RETRY_BUDGET_MS,
  retryAfter,
  retryPolicy,
  type AttemptError,
  type Breakers,
  type Candidate,
  type Router,
} from "./routing.js";
import {
  chatCompletionsUrl,
  isContextOverflow,
  normalizeChatRequest,
  readCompletion,
  sanitize,
  upstreamError,
  type CompletionHandlers,
  type UpstreamSettings,
} from "./upstream.js";

/** Status and body of an error in the inbound protocol's format. */
export function errorResponse(
  protocol: WireProtocol,
  value: Failure,
  retryAfterMs?: number,
): { status: number; body: unknown } {
  switch (protocol) {
    case "chat":
    case "responses":
      return openAiErrorResponse(value);
    case "anthropic":
      return anthropicErrorResponse(value);
    case "gemini": {
      const response = googleErrorResponse(value);
      if (retryAfterMs === undefined) return response;
      const body = response.body as { error: Record<string, unknown> };
      return {
        status: response.status,
        body: {
          error: {
            ...body.error,
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: `${Math.ceil(retryAfterMs / 1000)}s`,
              },
            ],
          },
        },
      };
    }
  }
}

/** Reasoning replay caches per Gateway Key and the reasoning field each provider uses. */
export class ReasoningCaches {
  #caches = new Map<string, ReasoningCache>();
  #fields = new Map<string, ReasoningField>();
  constructor(private readonly limits: Readonly<HandlerLimits>) {}
  /** The key's cache, most recently used; the oldest caches go once the total budget is reached. */
  cache(keyId: string): ReasoningCache {
    let cache = this.#caches.get(keyId);
    if (cache) this.#caches.delete(keyId);
    else
      cache = new ReasoningCache(
        this.limits.reasoningEntries,
        this.limits.reasoningBytes,
      );
    this.#caches.set(keyId, cache);
    const most = Math.max(
      1,
      Math.floor(
        this.limits.reasoningTotalBytes /
          Math.max(1, this.limits.reasoningBytes),
      ),
    );
    for (const oldest of this.#caches.keys()) {
      if (this.#caches.size <= most) break;
      this.#caches.delete(oldest);
    }
    return cache;
  }
  field(provider: string): ReasoningField {
    return this.#fields.get(provider) ?? "reasoning_content";
  }
  setField(provider: string, field: ReasoningField): void {
    this.#fields.set(provider, field);
  }

  /** Gateway Key → signature key → issuing provider and signature; both levels LRU. */
  #signatures = new Map<
    string,
    Map<string, { provider: string; signature: string }>
  >();
  #signatureKey(kind: "thinking" | "call", key: string): string {
    return kind === "thinking"
      ? `t:${createHash("sha256").update(key).digest("hex")}`
      : `c:${key}`;
  }
  /**
   * A signature the provider issued for a thinking text or a tool call id in
   * this key's earlier answers. Signatures are only valid for their issuer,
   * so another provider's signature is never returned.
   */
  signature(
    keyId: string,
    provider: string,
    kind: "thinking" | "call",
    key: string,
  ): string | undefined {
    const entry = this.#signatures
      .get(keyId)
      ?.get(this.#signatureKey(kind, key));
    return entry?.provider === provider ? entry.signature : undefined;
  }
  rememberSignature(
    keyId: string,
    provider: string,
    kind: "thinking" | "call",
    key: string,
    signature: string,
  ): void {
    let entries = this.#signatures.get(keyId);
    if (entries) this.#signatures.delete(keyId);
    else entries = new Map();
    this.#signatures.set(keyId, entries);
    const name = this.#signatureKey(kind, key);
    entries.delete(name);
    entries.set(name, { provider, signature });
    for (const oldest of entries.keys()) {
      if (entries.size <= SIGNATURES_PER_KEY) break;
      entries.delete(oldest);
    }
    for (const oldest of this.#signatures.keys()) {
      if (this.#signatures.size <= SIGNATURE_KEYS) break;
      this.#signatures.delete(oldest);
    }
  }
}
/** Signatures kept per Gateway Key, and Gateway Keys with signatures. */
const SIGNATURES_PER_KEY = 512;
const SIGNATURE_KEYS = 1024;

/** Handler-owned services one call uses. */
export interface CallServices {
  store: ModelPlaneStore;
  resolveSecret(ref: SecretReference): Promise<string>;
  clock: () => number;
  limits: Readonly<HandlerLimits>;
  log: LogSink;
  breakers: Breakers;
  router: Router;
  memory: MemoryBudget;
  slots(candidate: Candidate): Slots;
  reasoning: ReasoningCaches;
  sticky: StickyRoutes;
  quotas: Quotas;
  makeId(): string;
  /** Append to the ledger; false when the store rejected it (the failure is logged). */
  commit(entry: ModelCallEntry): Promise<boolean>;
}

/** Route parts of a model call. */
export interface CallRoute {
  protocol: WireProtocol;
  /** Gemini only: the model from the path and the parts the upstream URL repeats. */
  gemini?: GeminiTarget & { model: string };
}

/** What routing resolved for the requested model. */
export interface CallPlan {
  candidates: Candidate[];
  group?: RouteGroup;
  /** Candidates that cannot serve this inbound protocol, with reasons. */
  skipped: string[];
}

/** One model call; created after the body was read and the model allowed. */
export interface Call {
  services: CallServices;
  request: IncomingMessage;
  response: ServerResponse;
  route: CallRoute;
  key: GatewayKeyRecord;
  entry: ModelCallEntry;
  /** `performance.now()` at the start of the request. */
  started: number;
  /** Aborted by a client disconnect or the handler closing. */
  signal: AbortSignal;
  /** Resolves when the response closed (ended or the connection went away). */
  closed: Promise<void>;
  disconnected(): boolean;
  writer: HttpWriter;
  bytes: Buffer;
  raw: Record<string, unknown>;
  requested: string;
  stream: boolean;
  /** The conversation for stickiness; absent before the request was read. */
  conversation?: Conversation;
  /** Routing decisions recorded before any attempt (`sticky:…`). */
  routePatches: string[];
}

type Prepared =
  | { kind: "passthrough"; body: Buffer; patches: string[] }
  | {
      kind: "translated";
      translation: ChatTranslation;
      /** The normalized Chat request (the pivot). */
      chat: Record<string, unknown>;
      /** The upstream request body: the Chat request, or its encoding for another protocol. */
      body: string;
      patches: string[];
      unmapped: string[];
      replay: boolean;
    }
  | { kind: "skip"; error: AttemptError };

type AttemptResult =
  | { kind: "failed"; error: AttemptError }
  | {
      kind: "published";
      /** Set when the failure happened after the first byte. */
      error?: AttemptError;
      tokens: number;
    };

function localError(
  status: number,
  errorClass: string,
  message: string,
): AttemptError {
  return {
    failure: failure(status, errorClass, message),
    errorClass,
    source: "gateway",
    phase: "local",
  };
}

function httpErrorClass(status: number, message: string, overflow: boolean) {
  if (overflow) return "context_length_exceeded";
  if (status === 429)
    return /quota|billing|balance|credit/i.test(message)
      ? "quota_exhausted"
      : "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "insufficient_balance";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "upstream_timeout";
  if (status >= 500) return "upstream_unavailable";
  return "upstream_rejected";
}

function upstreamFailure(
  error: GatewayError,
  secrets: readonly string[],
): AttemptError {
  const overflow = error.contextOverflow && error.status !== 429;
  const message = sanitize(error.message, secrets);
  const errorClass =
    error.code === "upstream_invalid_response" ||
    error.code === "upstream_protocol_error" ||
    error.code === "response_too_large"
      ? error.code
      : httpErrorClass(error.status, message, overflow);
  return {
    failure: {
      status: error.status,
      code: errorClass,
      message,
      contextOverflow: overflow,
    },
    errorClass,
    source: "upstream",
    phase: "response",
    status: error.status,
  };
}

function cancelled(call: Call): AttemptError {
  const errorClass = call.disconnected()
    ? "engine_disconnected"
    : "client_cancelled";
  return {
    failure: failure(499, "cancelled", "Model call was cancelled"),
    errorClass,
    source: "gateway",
    phase: "cancelled",
  };
}

function translate(call: Call, options: TranslateOptions): ChatTranslation {
  switch (call.route.protocol) {
    case "chat":
      return chatToChat(call.raw);
    case "responses":
      return responsesToChat(call.raw, options);
    case "anthropic":
      return anthropicToChat(call.raw, options);
    case "gemini":
      return googleToChat(call.raw, call.requested, call.stream, options);
  }
}

function createSink(
  call: Call,
  translation: ChatTranslation,
  body: Record<string, unknown>,
): OutputSink {
  const context = {
    model: call.requested,
    reasoning: true,
    promptEstimate:
      call.route.protocol === "anthropic"
        ? estimateTokens({ messages: body.messages, tools: body.tools })
        : 0,
    id: call.entry.callId.replace(/^mc_/, ""),
    created: Math.floor(call.services.clock() / 1000),
  };
  switch (call.route.protocol) {
    case "chat":
      return new ChatSink(call.writer, translation, context);
    case "responses":
      return new ResponsesSink(call.writer, translation, context);
    case "anthropic":
      return new AnthropicSink(call.writer, translation, context);
    case "gemini":
      return new GoogleSink(
        call.writer,
        translation,
        context,
        call.route.gemini?.sse === true,
      );
  }
}

/** A minimal translation for writing a failure in the inbound protocol's format. */
function failureSink(call: Call): OutputSink {
  return createSink(
    call,
    { body: { messages: [] }, tools: new Map(), stream: call.stream },
    {},
  );
}

function tokens(usage: ModelCallEntry["usage"]): number {
  return usage
    ? usage.input +
        usage.cacheRead +
        usage.cacheWrite +
        usage.output +
        usage.reasoning
    : 0;
}

/**
 * Translated-path handlers that hold the sink's `start` (and so the response
 * headers) until the first content event, or until {@link release}.
 */
class SinkHold implements CompletionHandlers {
  #holding: boolean;
  #started = false;
  #released: Promise<void> | undefined;
  constructor(
    private readonly sink: OutputSink,
    holding: boolean,
    private readonly content: () => void,
  ) {
    this.#holding = holding;
  }
  release(): Promise<void> {
    if (!this.#holding) return this.#released ?? Promise.resolve();
    this.#holding = false;
    this.#released = this.#started ? this.sink.start() : Promise.resolve();
    return this.#released;
  }
  start(): Promise<void> {
    this.#started = true;
    return this.#holding ? Promise.resolve() : this.sink.start();
  }
  async reasoning(text: string, field: ReasoningField): Promise<void> {
    this.content();
    await this.release();
    await this.sink.reasoning(text, field);
  }
  async text(text: string): Promise<void> {
    this.content();
    await this.release();
    await this.sink.text(text);
  }
  async toolStart(call: {
    index: number;
    id: string;
    name: string;
  }): Promise<void> {
    this.content();
    await this.release();
    await this.sink.toolStart(call);
  }
  toolArgs(index: number, text: string): Promise<void> {
    return this.sink.toolArgs(index, text);
  }
}

/**
 * Passthrough forwarding of complete segments. Before the first content event
 * segments are held when alternatives remain, and before the first data
 * event in any case; from the terminal event on,
 * everything is withheld until {@link finish}, which runs after the ledger
 * commit. An error segment is never forwarded: it ends forwarding and is
 * reported by the caller in the gateway's own words.
 */
class Forwarder {
  #holding: boolean;
  #awaitingData = true;
  #released = false;
  #held: Buffer[] = [];
  #heldBytes = 0;
  #withheld: Buffer[] = [];
  #terminal = false;
  #chain: Promise<void> = Promise.resolve();
  /** Any non-closing segment was sent to the client (Gemini arrays: the opening bracket). */
  opened = false;
  valid = 0;
  usage: UsageParts = {};
  model: string | undefined;
  finishReason: string | undefined;
  sequence: number | undefined;
  error: GatewayError | undefined;
  constructor(
    private readonly protocol: WireProtocol,
    holding: boolean,
    private readonly holdBytes: number,
    private readonly emit: (bytes: Buffer) => Promise<void>,
    private readonly content: () => void,
  ) {
    this.#holding = holding;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
  segment(segment: Segment): Observation {
    // Gemini array elements start with `{`; an SSE event never does.
    const observation: Observation = segment.closing
      ? { valid: false, content: false, terminal: true }
      : segment.text.startsWith("{")
        ? this.#json(segment.text)
        : observeEvent(this.protocol, segment.text);
    if (observation.valid) this.valid++;
    Object.assign(this.usage, observation.usage);
    if (observation.model) this.model ??= observation.model;
    if (observation.finish) this.finishReason = observation.finish;
    if (observation.sequence !== undefined)
      this.sequence = observation.sequence;
    if (this.error) return observation;
    if (observation.error) {
      this.error = observation.error;
      return observation;
    }
    if (observation.content) this.content();
    if (observation.terminal || this.#terminal) {
      this.#terminal = true;
      this.#withheld.push(segment.bytes);
      return observation;
    }
    if (observation.valid) this.#awaitingData = false;
    if (this.#holding || this.#buffering) {
      this.#held.push(segment.bytes);
      this.#heldBytes += segment.bytes.length;
      if (
        observation.content ||
        this.#heldBytes >= this.holdBytes ||
        (!this.#holding && !this.#awaitingData)
      )
        this.release();
      return observation;
    }
    this.#write([segment.bytes]);
    return observation;
  }
  /**
   * Comments and blank events before the first data event are buffered too,
   * as the Session gateway commits headers only on data: a timeout before any
   * data still gets its real status.
   */
  get #buffering(): boolean {
    return this.#awaitingData && !this.#released;
  }
  #json(text: string): Observation {
    try {
      return observeJson(this.protocol, JSON.parse(text));
    } catch {
      return { valid: false, content: false, terminal: false };
    }
  }
  /** Stop holding: the held segments go out now. Idempotent. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#holding = false;
    this.#write(this.#held);
    this.#held = [];
  }
  #write(parts: Buffer[]): void {
    if (!parts.length) return;
    this.opened = true;
    const bytes = Buffer.concat(parts);
    this.#chain = this.#chain.then(() => this.emit(bytes));
  }
  /** Wait for queued writes; rejects with the first write failure. */
  drain(): Promise<void> {
    return this.#chain;
  }
  /** Release held and withheld segments and wait for them. */
  async finish(): Promise<void> {
    this.release();
    this.#write(this.#withheld);
    this.#withheld = [];
    await this.#chain;
  }
}

/** The in-stream failure of a passthrough response in the inbound protocol's format. */
function passthroughFailure(
  call: Call,
  forwarder: Forwarder | undefined,
  value: Failure,
): string {
  switch (call.route.protocol) {
    case "chat":
      return sse({ error: openAiError(value) });
    case "responses": {
      const sequence = (forwarder?.sequence ?? -1) + 1;
      return sse(
        {
          type: "response.failed",
          sequence_number: sequence,
          response: {
            object: "response",
            status: "failed",
            output: [],
            error: { code: streamCode(value), message: value.message },
            incomplete_details: null,
          },
        },
        "response.failed",
      );
    }
    case "anthropic":
      return sse(
        {
          type: "error",
          error: (anthropicErrorResponse(value).body as { error: unknown })
            .error,
        },
        "error",
      );
    case "gemini": {
      const error = JSON.stringify(googleErrorResponse(value).body);
      if (!call.stream) return error;
      if (call.route.gemini?.sse) return `data: ${error}\n\n`;
      return `${forwarder?.opened ? ",\r\n" : "["}${error}]`;
    }
  }
}

/** Clears all timers and the keepalive of one attempt. */
class AttemptTimers {
  #timers = new Set<NodeJS.Timeout>();
  keepalive: Keepalive | undefined;
  set(callback: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        callback();
      },
      Math.max(0, ms),
    );
    this.#timers.add(timer);
    return timer;
  }
  clear(timer: NodeJS.Timeout | undefined): void {
    if (!timer) return;
    clearTimeout(timer);
    this.#timers.delete(timer);
  }
  /**
   * Stop every timer and the keepalive, then wait until a keepalive write in
   * progress settled or the response closed. Idempotent.
   */
  async stop(closed: Promise<void>): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    const keepalive = this.keepalive;
    if (!keepalive) return;
    keepalive.stop();
    await Promise.race([keepalive.settled().catch(() => undefined), closed]);
  }
}

/** Fill the entry's failure fields. */
function recordFailure(entry: ModelCallEntry, error: AttemptError): void {
  entry.status = error.failure.contextOverflow ? 400 : error.failure.status;
  entry.errorClass = error.errorClass;
  if (error.phase !== "cancelled") entry.errorSource = error.source;
  entry.error = error.failure.message;
}

/** Commit results per entry: a call appends its entry at most once. */
const committed = new WeakMap<ModelCallEntry, Promise<boolean>>();

/** Finish the entry's timing and append it once; later calls return the first result. */
function commit(call: Call): Promise<boolean> {
  const { entry } = call;
  const previous = committed.get(entry);
  if (previous) return previous;
  entry.timing.durationMs = Math.round(performance.now() - call.started);
  const first = call.writer.firstWrite;
  if (first !== undefined)
    entry.timing.firstByteMs = Math.round(first - call.started);
  const result = call.services.commit(entry);
  committed.set(entry, result);
  return result;
}

/**
 * Commit the entry of a failure that wrote nothing yet, then answer with the
 * inbound protocol's error. A cancelled call only closes the connection.
 */
export async function publishFailure(
  call: Call,
  error: AttemptError,
): Promise<void> {
  recordFailure(call.entry, error);
  await commit(call);
  const { response, writer } = call;
  if (error.phase === "cancelled") {
    if (!response.writableEnded) response.destroy();
    return;
  }
  try {
    if (writer.sent) {
      await failureSink(call).fail(error.failure);
      return;
    }
    response.setHeader("x-hh-error-source", error.source);
    const wait = error.retryAfterMs;
    if (error.failure.status === 429 && wait !== undefined)
      response.setHeader(
        "retry-after",
        String(Math.max(1, Math.ceil(Math.min(wait, 60_000) / 1000))),
      );
    if (
      call.route.protocol === "responses" &&
      error.failure.contextOverflow &&
      call.stream
    ) {
      // Codex 0.153 recognizes context overflow only as a streamed response.failed.
      await failureSink(call).fail(error.failure);
      return;
    }
    const { status, body } = errorResponse(
      call.route.protocol,
      error.failure,
      error.failure.status === 429 ? wait : undefined,
    );
    await writer.json(status, body);
  } catch {
    response.destroy();
  }
}

function prepare(call: Call, candidate: Candidate): Prepared {
  const { limits } = call.services;
  const tooLarge = (bytes: number): Prepared | undefined =>
    bytes > limits.maxUpstreamRequestBytes
      ? {
          kind: "skip",
          error: localError(
            413,
            "upstream_request_too_large",
            `The upstream request for ${candidate.ref} exceeds the gateway limit of ${limits.maxUpstreamRequestBytes} bytes`,
          ),
        }
      : undefined;
  const set = candidate.provider.patches?.[candidate.upstream];
  const unsupported = unsupportedPatches(candidate.upstream, set);
  if (unsupported.length)
    return {
      kind: "skip",
      error: localError(
        500,
        "patch_unsupported",
        `Provider ${candidate.provider.id} declares ${unsupported.join(", ")} for ${candidate.upstream}, which this gateway does not implement`,
      ),
    };
  if (candidate.mode === "passthrough") {
    const { body, patches } = passthroughBody(
      candidate.upstream,
      call.bytes,
      call.raw,
      candidate.wireModel,
      set,
    );
    return tooLarge(body.length) ?? { kind: "passthrough", body, patches };
  }
  const images = candidate.model?.inputModalities?.includes("image") === true;
  let translation: ChatTranslation;
  try {
    translation = translate(call, { images });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    return {
      kind: "skip",
      error: {
        failure: {
          status: error.status,
          code: "unsupported_feature",
          message: error.message,
          contextOverflow: false,
        },
        errorClass: "unsupported_feature",
        source: "gateway",
        phase: "local",
      },
    };
  }
  const patches = new Set(set?.patches ?? []);
  const chatUpstream = candidate.upstream === "chat";
  // Anthropic takes history thinking only with its signature, which is
  // looked up by the reasoning text the cache restores.
  const replay =
    candidate.provider.capabilities?.requiresReasoningReplay === true ||
    candidate.upstream === "anthropic";
  if (replay)
    restoreReasoning(
      translation.body.messages,
      call.services.reasoning.cache(call.key.keyId),
      call.services.reasoning.field(candidate.provider.id),
    );
  const drops = patches.has("drop-fields") ? (set?.dropFields ?? []) : [];
  const settings: UpstreamSettings = {
    model: candidate.wireModel,
    ...(candidate.model?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: candidate.model.maxOutputTokens }),
    includeUsage: true,
    maxTokensField: patches.has("max-tokens-field")
      ? "max_completion_tokens"
      : "max_tokens",
    // Other protocols drop their fields from the encoded body below.
    dropParameters: chatUpstream ? drops : [],
    images: images ? "passthrough" : "placeholder",
  };
  const applied: string[] = [];
  if (chatUpstream)
    for (const field of drops)
      if (field in translation.body) applied.push(`drop-fields:${field}`);
  if (
    patches.has("json-schema-to-json-object") &&
    (translation.body.response_format as { type?: unknown } | undefined)
      ?.type === "json_schema"
  )
    applied.push("json-schema-to-json-object");
  let body: Record<string, unknown>;
  try {
    body = normalizeChatRequest(translation.body, settings, {
      dropDefaults: false,
      jsonSchema: patches.has("json-schema-to-json-object")
        ? "json-object"
        : "keep",
    });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    return {
      kind: "skip",
      error: {
        failure: failure(error.status, error.code, error.message),
        errorClass: "invalid_request",
        source: "gateway",
        phase: "local",
      },
    };
  }
  if (patches.has("max-tokens-field") && "max_completion_tokens" in body)
    applied.push("max-tokens-field");
  let upstream = body;
  let unmapped: string[] = [];
  if (candidate.upstream !== "chat") {
    const { reasoning } = call.services;
    const encoded = encodeRequest(candidate.upstream, body, {
      translation,
      model: candidate.model,
      signature: (kind, key) =>
        reasoning.signature(call.key.keyId, candidate.provider.id, kind, key),
    });
    upstream = encoded.body;
    for (const field of drops)
      if (field in upstream) {
        delete upstream[field];
        applied.push(`drop-fields:${field}`);
      }
    applied.push(...encoded.patches);
    unmapped = encoded.unmapped;
  }
  const text = JSON.stringify(upstream);
  return (
    tooLarge(Buffer.byteLength(text)) ?? {
      kind: "translated",
      translation,
      chat: body,
      body: text,
      patches: applied,
      unmapped,
      replay,
    }
  );
}

/** The parts every attempt shares: slot, credential, request and response headers. */
async function send(
  call: Call,
  candidate: Candidate,
  attempt: CallAttempt,
  abort: AbortController,
  timers: AttemptTimers,
  request: (secret: string) => {
    url: URL;
    headers: Headers;
    body: string | Buffer;
  },
): Promise<
  | { ok: true; response: Response; secrets: string[]; release: () => void }
  | { ok: false; error: AttemptError; release: () => void }
> {
  const { services } = call;
  const slots = services.slots(candidate);
  try {
    await slots.acquire(call.signal);
  } catch (error) {
    if (call.signal.aborted)
      return { ok: false, error: cancelled(call), release: () => undefined };
    const message =
      error instanceof GatewayError ? error.message : "Credential is busy";
    return {
      ok: false,
      error: localError(429, "busy", message),
      release: () => undefined,
    };
  }
  const release = () => slots.release();
  let secret: string;
  try {
    secret = await services.resolveSecret(candidate.credential.ref);
  } catch {
    services.log.info("gateway.credential.unresolved", {
      provider: candidate.provider.id,
      credential: candidate.credential.id,
    });
    return {
      ok: false,
      error: localError(
        502,
        "credential_unavailable",
        `Credential ${candidate.credential.id} of provider ${candidate.provider.id} could not be resolved`,
      ),
      release,
    };
  }
  const secrets = [secret, ...Object.values(candidate.provider.headers ?? {})];
  const { url, headers, body } = request(secret);
  let headerTimeout = false;
  const timer = timers.set(() => {
    headerTimeout = true;
    abort.abort();
  }, services.limits.upstreamHeaderTimeoutMs);
  const attemptStarted = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([call.signal, abort.signal]),
      headers,
      body,
    });
    if (response.ok) {
      timers.clear(timer);
      return { ok: true, response, secrets, release };
    }
    attempt.status = response.status;
    const wait = retryAfter(response.headers, services.clock());
    if (wait !== undefined) attempt.retryAfterMs = wait;
    // The header deadline also bounds reading the error body.
    const text = await readLimited(response, 64 * 1024);
    timers.clear(timer);
    const reported = upstreamError(text, response.status);
    attempt.firstByteMs = Math.round(performance.now() - attemptStarted);
    const error = upstreamFailure(
      new GatewayError(
        reported.message,
        response.status,
        "upstream_http_error",
        isContextOverflow(reported.code, reported.message),
      ),
      secrets,
    );
    if (wait !== undefined) error.retryAfterMs = wait;
    return { ok: false, error, release };
  } catch (error) {
    timers.clear(timer);
    if (call.signal.aborted)
      return { ok: false, error: cancelled(call), release };
    if (headerTimeout)
      return {
        ok: false,
        error: {
          failure: failure(
            504,
            "upstream_timeout",
            `Upstream model sent no response headers for ${Math.round(services.limits.upstreamHeaderTimeoutMs / 1000)} seconds`,
          ),
          errorClass: "upstream_timeout",
          source: "upstream",
          phase: "headers",
          status: 504,
        },
        release,
      };
    const network = networkFailure(error);
    if (network)
      return {
        ok: false,
        error: {
          failure: { ...network, message: sanitize(network.message, secrets) },
          errorClass: "upstream_unreachable",
          source: "upstream",
          phase: "connect",
        },
        release,
      };
    if (error instanceof GatewayError)
      return { ok: false, error: upstreamFailure(error, secrets), release };
    release();
    throw error;
  }
}

/** Classify an error thrown while the upstream body was read. */
function readError(
  call: Call,
  error: unknown,
  idle: boolean,
  secrets: readonly string[],
): AttemptError {
  if (call.signal.aborted || error instanceof ClientClosed)
    return cancelled(call);
  if (idle)
    return {
      failure: failure(
        504,
        "upstream_timeout",
        `Upstream model sent no data for ${Math.round(call.services.limits.idleTimeoutMs / 1000)} seconds`,
      ),
      errorClass: "upstream_timeout",
      source: "upstream",
      phase: "response",
      status: 504,
    };
  if (error instanceof GatewayError) return upstreamFailure(error, secrets);
  const network = networkFailure(error);
  if (network)
    return {
      failure: { ...network, message: sanitize(network.message, secrets) },
      errorClass: "upstream_unreachable",
      source: "upstream",
      phase: "response",
      status: 502,
    };
  throw error;
}

/** Record success fields shared by both modes. */
function recordSuccess(
  call: Call,
  candidate: Candidate,
  attempt: CallAttempt,
  parts: UsageParts,
  served: string | undefined,
  finish: string | undefined,
  terminated: boolean,
): void {
  const { entry } = call;
  entry.status = 200;
  attempt.decision = "success";
  attempt.status = 200;
  const usage = callUsage(parts);
  entry.usage = usage;
  entry.cost = callCost(usage, candidate.model);
  if (served) entry.servedModel = served.slice(0, 256);
  if (finish) entry.finishReason = finish.slice(0, 64);
  entry.completion = terminated ? "explicit" : "inferred";
}

/**
 * Keep the signatures of a successful answer for this key's next request to
 * the same provider: a single thinking block's signature by its text, and
 * Gemini function-call signatures by the call id the client will send back.
 */
function rememberSignatures(
  call: Call,
  candidate: Candidate,
  decoder: UpstreamDecoder,
  result: ChatResult,
): void {
  const { reasoning } = call.services;
  const remember = (kind: "thinking" | "call", key: string, value: string) =>
    reasoning.rememberSignature(
      call.key.keyId,
      candidate.provider.id,
      kind,
      key,
      value,
    );
  const [thinking, ...more] = decoder.thinking;
  if (thinking?.signature && !more.length && thinking.text === result.reasoning)
    remember("thinking", thinking.text, thinking.signature);
  for (const [index, signature] of decoder.callSignatures) {
    const id = result.calls[index]?.id;
    if (id) remember("call", id, signature);
  }
}

async function translatedAttempt(
  call: Call,
  candidate: Candidate,
  prepared: Extract<Prepared, { kind: "translated" }>,
  attempt: CallAttempt,
  alternatives: boolean,
): Promise<AttemptResult> {
  const { services, writer, response } = call;
  const { limits } = services;
  const abort = new AbortController();
  const timers = new AttemptTimers();
  const sink = createSink(call, prepared.translation, prepared.chat);
  const decoder =
    candidate.upstream === "chat"
      ? undefined
      : createDecoder(candidate.upstream);
  const hold = new SinkHold(
    sink,
    alternatives && prepared.translation.stream,
    () => {
      call.entry.timing.firstContentMs ??= Math.round(
        performance.now() - call.started,
      );
    },
  );
  const sent = await send(call, candidate, attempt, abort, timers, (secret) => {
    const url =
      candidate.upstream === "chat"
        ? chatCompletionsUrl(candidate.endpoint)
        : upstreamUrl(
            candidate.upstream,
            candidate.endpoint,
            candidate.wireModel,
            {
              version: call.route.gemini?.version ?? "v1beta",
              method: "streamGenerateContent",
              sse: true,
            },
          );
    const { headers } = upstreamHeaders(
      candidate.upstream,
      undefined,
      candidate.provider,
      secret,
      url,
      undefined,
    );
    return { url, headers, body: prepared.body };
  });
  let secrets: string[] = [];
  let idle = false;
  let data = 0;
  try {
    if (!sent.ok) return { kind: "failed", error: sent.error };
    secrets = sent.secrets;
    const upstream = sent.response;
    const attemptStarted = performance.now();
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      timers.clear(idleTimer);
      idleTimer = timers.set(() => {
        idle = true;
        abort.abort();
      }, limits.idleTimeoutMs);
    };
    touch();
    const keepalive = new Keepalive(
      writer,
      { gapMs: limits.keepaliveGapMs, maxNoDataMs: limits.maxNoDataMs },
      () => sink.keepalive(),
    );
    timers.keepalive = keepalive;
    keepalive.answered();
    if (alternatives && prepared.translation.stream)
      timers.set(
        () => void hold.release().catch(() => undefined),
        limits.holdMs,
      );
    const commitHeaders = sink.commit?.bind(sink);
    if (commitHeaders)
      timers.set(
        () => {
          if (!writer.sent && !writer.closed) commitHeaders();
        },
        call.started + limits.headerCommitMs - performance.now(),
      );
    let held = 0;
    const counted = upstream.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          attempt.firstByteMs ??= Math.round(
            performance.now() - attemptStarted,
          );
          held += chunk.byteLength;
          if (held >= limits.holdBytes)
            void hold.release().catch(() => undefined);
          controller.enqueue(chunk);
        },
      }),
    );
    const result = await readCompletion(
      new Response(counted ?? null, { headers: upstream.headers }),
      hold,
      services.makeId,
      {
        maxBytes: limits.maxResponseBytes,
        activity: () => keepalive.activity(),
        data: () => {
          data++;
          touch();
          keepalive.data();
        },
      },
      decoder,
    );
    await timers.stop(call.closed);
    if (data === 0)
      throw new GatewayError(
        "Upstream answered 2xx without any data",
        502,
        "upstream_invalid_response",
      );
    if (
      result.calls.some((value) => !value.input) &&
      (call.route.protocol === "gemini" ||
        (call.route.protocol === "anthropic" && !prepared.translation.stream))
    )
      throw new GatewayError(
        "Upstream returned malformed tool arguments",
        502,
        "upstream_protocol_error",
      );
    recordSuccess(
      call,
      candidate,
      attempt,
      result.rawUsage ? usageParts("chat", result.rawUsage) : {},
      result.model,
      result.finish,
      result.terminated === true,
    );
    if (decoder?.unmapped.size)
      call.entry.unmapped = [
        ...new Set([...call.entry.unmapped, ...decoder.unmapped]),
      ];
    const recorded = await commit(call);
    try {
      if (recorded) {
        await hold.release();
        await sink.finish(result);
      } else await evidenceUnavailable(call, sink);
    } catch (error) {
      if (!(error instanceof ClientClosed)) throw error;
    }
    if (recorded && prepared.replay && result.reasoning) {
      if (result.reasoningField)
        services.reasoning.setField(
          candidate.provider.id,
          result.reasoningField,
        );
      services.reasoning
        .cache(call.key.keyId)
        .remember(result.reasoning, resultKeys(result));
    }
    if (recorded && decoder)
      rememberSignatures(call, candidate, decoder, result);
    return { kind: "published", tokens: tokens(call.entry.usage) };
  } catch (error) {
    await timers.stop(call.closed);
    const reported = readError(call, error, idle, secrets);
    if (reported.phase === "cancelled" || !writer.sent)
      return { kind: "failed", error: reported };
    attempt.decision = "stop";
    if (reported.status !== undefined) attempt.status = reported.status;
    attempt.errorClass = reported.errorClass;
    recordFailure(call.entry, reported);
    await commit(call);
    try {
      await sink.fail(reported.failure);
    } catch {
      response.destroy();
    }
    return { kind: "published", error: reported, tokens: 0 };
  } finally {
    await timers.stop(call.closed);
    sent.release();
    abort.abort();
  }
}

/** The ledger could not be written: report 503 `evidence_unavailable` instead of the answer. */
async function evidenceUnavailable(
  call: Call,
  sink: OutputSink | undefined,
  forwarder?: Forwarder,
): Promise<void> {
  const value = failure(
    503,
    "evidence_unavailable",
    "The model call could not be recorded; the answer is withheld",
  );
  const { writer, response } = call;
  if (!writer.sent) {
    response.setHeader("x-hh-error-source", "gateway");
    const { status, body } = errorResponse(call.route.protocol, value);
    await writer.json(status, body);
    return;
  }
  if (sink) {
    await sink.fail(value);
    return;
  }
  await writer.end(passthroughFailure(call, forwarder, value));
}

async function passthroughAttempt(
  call: Call,
  candidate: Candidate,
  prepared: Extract<Prepared, { kind: "passthrough" }>,
  attempt: CallAttempt,
  alternatives: boolean,
): Promise<AttemptResult> {
  const { services, writer, response, route } = call;
  const { limits } = services;
  const abort = new AbortController();
  const timers = new AttemptTimers();
  const set = candidate.provider.patches?.[candidate.upstream];
  const sent = await send(call, candidate, attempt, abort, timers, (secret) => {
    const url = upstreamUrl(
      candidate.upstream,
      candidate.endpoint,
      candidate.wireModel,
      route.gemini,
    );
    const { headers, patches } = upstreamHeaders(
      candidate.upstream,
      call.request.headers,
      candidate.provider,
      secret,
      url,
      set,
    );
    call.entry.patches = [
      ...call.routePatches,
      ...prepared.patches,
      ...patches,
    ];
    return { url, headers, body: prepared.body };
  });
  let secrets: string[] = [];
  let idle = false;
  let forwarder: Forwarder | undefined;
  const gemini = route.protocol === "gemini";
  try {
    if (!sent.ok) return { kind: "failed", error: sent.error };
    secrets = sent.secrets;
    const upstream = sent.response;
    const attemptStarted = performance.now();
    const contentType =
      upstream.headers.get("content-type") ??
      (call.stream && !(gemini && !route.gemini?.sse)
        ? "text/event-stream"
        : "application/json");
    if (/text\/html/i.test(contentType))
      throw new GatewayError(
        "Upstream answered 2xx with an HTML page",
        502,
        "upstream_invalid_response",
      );
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      timers.clear(idleTimer);
      idleTimer = timers.set(() => {
        idle = true;
        abort.abort();
      }, limits.idleTimeoutMs);
    };
    touch();
    const firstContent = () => {
      call.entry.timing.firstContentMs ??= Math.round(
        performance.now() - call.started,
      );
    };
    const begin = () => {
      if (!writer.sent)
        writer.begin(
          200,
          gemini && !call.stream
            ? "application/json; charset=utf-8"
            : contentType,
        );
    };
    // Gemini clients give up after 60 s without headers (03 section 6).
    let keepalive: Keepalive | undefined;
    if (gemini) {
      keepalive = new Keepalive(
        writer,
        { gapMs: limits.keepaliveGapMs, maxNoDataMs: limits.maxNoDataMs },
        () =>
          writer.write(
            call.stream && route.gemini?.sse
              ? `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, index: 0 }] })}\n\n`
              : "\n",
          ),
      );
      timers.keepalive = keepalive;
      keepalive.answered();
      timers.set(
        () => {
          if (writer.sent || writer.closed) return;
          forwarder?.release();
          begin();
        },
        call.started + limits.headerCommitMs - performance.now(),
      );
    }
    const streamed =
      call.stream &&
      (/event-stream/i.test(contentType) || (gemini && !route.gemini?.sse));
    let bytes = 0;
    const chunks: Buffer[] = [];
    if (streamed) {
      forwarder = new Forwarder(
        route.protocol,
        alternatives,
        limits.holdBytes,
        async (value) => {
          begin();
          await writer.write(value);
        },
        firstContent,
      );
      if (alternatives) timers.set(() => forwarder?.release(), limits.holdMs);
    }
    const segmenter = !streamed
      ? undefined
      : gemini && !route.gemini?.sse
        ? new ArraySegmenter(limits.maxEventBytes)
        : new SseSegmenter(limits.maxEventBytes);
    if (upstream.body)
      for await (const chunk of upstream.body) {
        attempt.firstByteMs ??= Math.round(performance.now() - attemptStarted);
        bytes += chunk.byteLength;
        if (bytes > limits.maxResponseBytes)
          throw new GatewayError(
            "Upstream model response exceeds the gateway size limit",
            502,
            "response_too_large",
          );
        keepalive?.activity();
        if (!segmenter || !forwarder) {
          chunks.push(Buffer.from(chunk));
          if (/\S/.test(Buffer.from(chunk).toString("latin1"))) {
            touch();
            keepalive?.data();
          }
          continue;
        }
        for (const segment of segmenter.push(chunk)) {
          const observation = forwarder.segment(segment);
          if (observation.valid) {
            touch();
            keepalive?.data();
          }
          if (forwarder.error) break;
        }
        if (forwarder.error) break;
        await forwarder.drain();
      }
    if (segmenter && forwarder && !forwarder.error)
      for (const segment of segmenter.end()) forwarder.segment(segment);
    await timers.stop(call.closed);
    let parts: UsageParts;
    let served: string | undefined;
    let finish: string | undefined;
    let terminated: boolean;
    let body: Buffer | undefined;
    if (forwarder) {
      if (forwarder.error) throw forwarder.error;
      if (forwarder.valid === 0)
        throw new GatewayError(
          "Upstream answered 2xx without a valid event",
          502,
          "upstream_invalid_response",
        );
      parts = forwarder.usage;
      served = forwarder.model;
      finish = forwarder.finishReason;
      terminated = forwarder.terminal;
    } else {
      body = Buffer.concat(chunks);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch {
        throw new GatewayError(
          "Upstream answered 2xx with a body that is not JSON",
          502,
          "upstream_invalid_response",
        );
      }
      const observation = observeJson(route.protocol, value);
      if (observation.error) throw observation.error;
      if (call.stream)
        throw new GatewayError(
          "Upstream answered a streamed request without an event stream",
          502,
          "upstream_invalid_response",
        );
      if (!observation.valid)
        throw new GatewayError(
          "Upstream answered 2xx without a valid response",
          502,
          "upstream_invalid_response",
        );
      if (observation.content) firstContent();
      parts = observation.usage ?? {};
      served = observation.model;
      finish = observation.finish;
      terminated = true;
    }
    recordSuccess(call, candidate, attempt, parts, served, finish, terminated);
    const recorded = await commit(call);
    try {
      if (!recorded) await evidenceUnavailable(call, undefined, forwarder);
      else if (forwarder) {
        await forwarder.finish();
        begin();
        await writer.end();
      } else {
        begin();
        await writer.end(body ?? "");
      }
    } catch (error) {
      if (!(error instanceof ClientClosed)) throw error;
    }
    return { kind: "published", tokens: tokens(call.entry.usage) };
  } catch (error) {
    await timers.stop(call.closed);
    // A write failure surfaces from the queue; the client is gone.
    await forwarder?.drain().catch(() => undefined);
    const reported = readError(call, error, idle, secrets);
    if (reported.phase === "cancelled" || !writer.sent)
      return { kind: "failed", error: reported };
    attempt.decision = "stop";
    if (reported.status !== undefined) attempt.status = reported.status;
    attempt.errorClass = reported.errorClass;
    recordFailure(call.entry, reported);
    await commit(call);
    try {
      await writer.end(passthroughFailure(call, forwarder, reported.failure));
    } catch {
      response.destroy();
    }
    return { kind: "published", error: reported, tokens: 0 };
  } finally {
    await timers.stop(call.closed);
    sent.release();
    abort.abort();
  }
}

/**
 * Route one call over its candidates and publish exactly one answer: the
 * upstream's (after the entry is committed), an in-stream failure after the
 * first byte, or the last failure in the inbound protocol's format.
 */
export async function routeCall(call: Call, plan: CallPlan): Promise<void> {
  const { services, entry } = call;
  const policy = retryPolicy(plan.group?.retry);
  const began = performance.now();
  let last: AttemptError | undefined;
  let skip: AttemptError | undefined;
  let blocked:
    | {
        reason: string;
        until: number;
        last?: { failure: Failure; errorClass: string; at: number };
      }
    | undefined;
  const queue = plan.candidates;
  for (let index = 0; index < queue.length; index++) {
    const candidate = queue[index]!;
    let retries = 0;
    let headerRetries = 0;
    for (;;) {
      if (call.signal.aborted) return publishFailure(call, cancelled(call));
      if (entry.attempts.length >= policy.totalAttempts)
        return publishFailure(
          call,
          last ?? localError(503, "attempts_exhausted", "No attempt left"),
        );
      // A retry of this call was decided with its wait, a Retry-After
      // cooldown included, and checked the breaker then; only the first try
      // asks the breaker here.
      if (retries === 0) {
        const admitted = services.breakers.admit(candidate);
        if (!admitted.ok) {
          if (!blocked || (admitted.last?.at ?? 0) > (blocked.last?.at ?? 0))
            blocked = admitted;
          break;
        }
      }
      const prepared = prepare(call, candidate);
      if (prepared.kind === "skip") {
        services.breakers.release(candidate);
        skip ??= prepared.error;
        break;
      }
      entry.provider = candidate.provider.id;
      entry.credentialId = candidate.credential.id;
      entry.modelRef = candidate.ref;
      entry.wireModel = candidate.wireModel;
      entry.upstreamProtocol = candidate.upstream;
      entry.mode = candidate.mode;
      entry.patches = [...call.routePatches, ...prepared.patches];
      entry.unmapped = prepared.kind === "translated" ? prepared.unmapped : [];
      const attempt: CallAttempt = {
        provider: candidate.provider.id,
        credentialId: candidate.credential.id,
        modelRef: candidate.ref,
        wireModel: candidate.wireModel,
        upstreamProtocol: candidate.upstream,
        startedAt: new Date(services.clock()).toISOString(),
        decision: "stop",
      };
      entry.attempts.push(attempt);
      const alternatives =
        entry.attempts.length < policy.totalAttempts &&
        (index < queue.length - 1 || retries < policy.perCandidate);
      const result =
        prepared.kind === "passthrough"
          ? await passthroughAttempt(
              call,
              candidate,
              prepared,
              attempt,
              alternatives,
            )
          : await translatedAttempt(
              call,
              candidate,
              prepared,
              attempt,
              alternatives,
            );
      if (result.kind === "published") {
        if (result.error) {
          const effect = classify(result.error, policy).breaker;
          services.breakers.failure(
            candidate,
            effect,
            result.error.failure,
            result.error.errorClass,
          );
        } else {
          services.breakers.success(candidate);
          services.router.record(
            candidate.ref,
            result.tokens,
            entry.timing.firstContentMs,
          );
          if (call.conversation)
            services.sticky.remember(
              call.conversation,
              call.requested,
              candidate,
              entry.usage?.cacheRead ?? 0,
            );
        }
        return;
      }
      const error = result.error;
      attempt.errorClass = error.errorClass;
      if (error.status !== undefined) attempt.status = error.status;
      if (error.phase === "cancelled") {
        services.breakers.release(candidate);
        return publishFailure(call, error);
      }
      const verdict = classify(error, policy);
      services.breakers.failure(
        candidate,
        verdict.breaker,
        error.failure,
        error.errorClass,
      );
      last = error;
      const more = index < queue.length - 1;
      const left = entry.attempts.length < policy.totalAttempts;
      let wait = 0;
      let decision: CallAttempt["decision"] = "stop";
      if (left && verdict.retry === "after") {
        if (more) decision = "failover";
        else if (retries < policy.perCandidate) {
          decision = "retry";
          wait = error.retryAfterMs ?? 0;
        }
      } else if (
        left &&
        retries < policy.perCandidate &&
        (verdict.retry === "yes" ||
          (verdict.retry === "once" && headerRetries < 1))
      ) {
        decision = "retry";
        wait = backoff(policy, retries);
      } else if (left && verdict.failover && more) decision = "failover";
      // A retry onto a breaker this failure just opened fails over instead;
      // only a Retry-After wait (its own cooldown) retries regardless.
      if (
        decision === "retry" &&
        (performance.now() - began + wait > RETRY_BUDGET_MS ||
          (verdict.retry !== "after" && services.breakers.blocked(candidate)))
      )
        decision = verdict.failover && more ? "failover" : "stop";
      attempt.decision = decision;
      if (decision === "stop") return publishFailure(call, error);
      if (decision === "failover") break;
      attempt.backoffMs = wait;
      retries++;
      if (error.phase === "headers") headerRetries++;
      try {
        await sleep(wait, undefined, { signal: call.signal });
      } catch {
        return publishFailure(call, cancelled(call));
      }
    }
  }
  if (last) return publishFailure(call, last);
  if (blocked) {
    const cause = blocked.last;
    const wait = Math.max(0, blocked.until - services.clock());
    return publishFailure(call, {
      failure: cause
        ? {
            ...cause.failure,
            message:
              `All candidates are cooling down; the last failure was: ${cause.failure.message}`.slice(
                0,
                500,
              ),
          }
        : failure(503, "all_candidates_open", blocked.reason),
      errorClass: cause?.errorClass ?? "all_candidates_open",
      source: "gateway",
      phase: "local",
      retryAfterMs: wait,
    });
  }
  if (skip) return publishFailure(call, skip);
  return publishFailure(
    call,
    localError(
      400,
      "unsupported_route",
      plan.skipped.length
        ? `No candidate can serve ${call.route.protocol} requests: ${plan.skipped.join("; ")}`.slice(
            0,
            500,
          )
        : `No enabled credential can serve ${call.requested}`,
    ),
  );
}
