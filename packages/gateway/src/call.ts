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
import { SUBSCRIPTION_NOTICES } from "@harnesshub/core/subscriptions";
import type { LogSink } from "@harnesshub/core/logging";
import {
  providerProxy,
  proxyFailure,
  type OutboundFetch,
} from "@harnesshub/core/outbound";
import type {
  CallAttempt,
  CallPurpose,
  GatewayKeyRecord,
  ModelCallEntry,
  ModelPlaneStore,
  RouteGroup,
  RouteGroupId,
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
  settleFinish,
  SseSegmenter,
  unsupportedPatches,
  upstreamHeaders,
  upstreamUrl,
  type GeminiTarget,
  type Observation,
  type Segment,
} from "./passthrough.js";
import {
  memberFast,
  memberNeedsTranslation,
  memberPassthrough,
  memberTranslation,
  withFastBeta,
} from "./members.js";
import {
  GatewayError,
  estimateTokens,
  type ChatResult,
  type ChatTranslation,
  type ReasoningField,
  type TranslateOptions,
} from "./protocol.js";
import {
  ReasoningCache,
  reasoningItemKeys,
  restoreReasoning,
  resultKeys,
} from "./reasoning.js";
import { responsesToChat, ResponsesSink, streamCode } from "./responses.js";
import { SiwcError, type SubscriptionTokens } from "./siwc.js";
import {
  CopilotError,
  copilotUnmapped,
  type CopilotBridge,
} from "./copilot.js";
import type { GatewayFeatures } from "@harnesshub/core/gateway-features";
import { maskBody, type Redactor } from "./redaction.js";
import { ToolArgumentRestorer } from "./restore.js";
import {
  codexInput,
  COMPACTION_EMPTY,
  CompactionReply,
  refusesSeal,
  SummaryReader,
  unsealed,
  withoutOwnReasoning,
} from "./compacting.js";
import { searchAsFunction, SearchCallRestorer } from "./toolsearch.js";
import {
  SEARCH_MARKERS,
  SEARCH_ROUNDS,
  SearchRelay,
  searchesNatively,
  searchOffered,
  searchTool,
  webSearch,
} from "./search.js";
import {
  describeImages,
  imagesOf,
  type VisionDescriber,
  type VisionResult,
} from "./vision.js";
import type { InternalCalls } from "./internal.js";
import {
  backoff,
  classify,
  failureClass,
  failureKind,
  RETRY_BUDGET_MS,
  resetIn,
  retryAfter,
  retryPolicy,
  matesFirst,
  tokenFloor,
  withTokenFloor,
  type AttemptError,
  type Breakers,
  type Candidate,
  type FailureKind,
  type Router,
  KEYLESS_CREDENTIAL,
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
  /** Access tokens of subscription accounts; without it their candidates fail as unavailable. */
  subscriptions?: SubscriptionTokens;
  /** Answers Copilot accounts' calls; without it their candidates fail as unavailable. */
  copilot?: CopilotBridge;
  /** Outbound secret redaction: the known secrets and placeholders of this handler. */
  redactor: Redactor;
  /** The user's gateway features, read when needed. */
  features(): GatewayFeatures;
  /** Describes images for models without image input; absent where the gateway cannot call itself. */
  vision?: VisionDescriber;
  /** Every request to a provider, a search backend or ChatGPT: the daemon's proxy policy. */
  fetch: OutboundFetch;
  /**
   * The Model Ref or `group/<id>` a requested model names: itself, what a
   * bare name resolves to, or, for a name nothing here serves, the model
   * the key's wired agent stands in (`standIn`). Throws GatewayError
   * `model_ambiguous` (400) or `model_not_found` (404).
   */
  resolveModel(
    model: string,
    key: GatewayKeyRecord,
  ): Promise<{ ref: string; standIn?: true }>;
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
  /** The groups inside `group` that were planned, by ID. */
  groups?: Map<RouteGroupId, RouteGroup>;
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
  /** The Model Ref or group the call routes to. */
  requested: string;
  /** The model name shown back to the client: what it asked for (a Session's alias), else `requested`. */
  shownModel?: string;
  stream: boolean;
  /** The conversation for stickiness; absent before the request was read. */
  conversation?: Conversation;
  /**
   * Patches of the whole call, kept in every attempt's entry: routing
   * decisions (`sticky:…`) and rewrites of the client's request
   * (`compaction:…`, `sealed:…`).
   */
  routePatches: string[];
  /** Set on a call the gateway makes for itself; such a call gets no vision fallback or search. */
  internal?: CallPurpose;
  /** The calls the gateway may make for this one, as its key; absent on an internal call. */
  internals?: InternalCalls;
  /**
   * What a route group's rules decided (./rules.js): a compaction they
   * routed leaves the conversation's stickiness record alone, and an
   * answer tells them how long the conversation is.
   */
  rules?: { compact: boolean; answered(input: number): void };
  /** The images of this call described for models without image input, once per call. */
  vision?: VisionResult;
  /** The current attempt answers the client's web search itself (./search.js). */
  searching?: boolean;
  /** The web searches of this call, over all its attempts: run, and not run for a limit. */
  searched?: { ran: number; refused: number };
  /** The least reply length a vendor said it takes: every request of this call asks for at least this many tokens. */
  tokenFloor?: number;
  /** The gateway serves Codex's compaction: an answer without a summary fails (./compacting.js). */
  compaction?: boolean;
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
      /** The search tool's name, when the gateway answers web search itself (./search.js). */
      search?: string;
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

/**
 * A subscription's used-up plan, worded as its vendor asks: where the user
 * reviews the plan's or this app's limit (SIWC UI/UX guidelines).
 */
function usageHint(candidate: Candidate, error: AttemptError): AttemptError {
  const backend = candidate.provider.subscription?.backend;
  if (!backend || error.kind !== "quota") return error;
  const notice = SUBSCRIPTION_NOTICES[backend];
  const where =
    backend === "siwc"
      ? "Review your plan or this app's limit in ChatGPT settings"
      : "Review your Copilot plan and premium request budget in GitHub billing settings";
  error.failure = {
    ...error.failure,
    message:
      `Usage limit reached. ${where}: ${notice.manageUsageUrl} (${error.failure.message})`.slice(
        0,
        500,
      ),
  };
  return error;
}

/** A Copilot account that cannot serve: sign in again, or its client is unavailable. */
function copilotFailure(
  candidate: Candidate,
  error: CopilotError,
): AttemptError {
  const account = candidate.credential.account;
  return error.terminal
    ? localError(
        401,
        "subscription_sign_in_needed",
        `The Copilot account ${account?.subject ?? candidate.credential.name} of provider ${candidate.provider.id} must sign in again (hh subscription login copilot --provider ${candidate.provider.id}): ${error.message}`.slice(
          0,
          500,
        ),
      )
    : localError(
        503,
        "subscription_unavailable",
        `The Copilot client of provider ${candidate.provider.id} is not available: ${error.message}`.slice(
          0,
          500,
        ),
      );
}

/**
 * An upstream refusal or an in-stream error as an attempt error. Its kind
 * comes from the status and `body`, the whole error body when there is one
 * (read for routing only, never stored), else the message.
 */
function upstreamFailure(
  error: GatewayError,
  secrets: readonly string[],
  body?: string,
): AttemptError {
  const overflow = error.contextOverflow && error.status !== 429;
  const message = sanitize(error.message, secrets);
  const text = body ?? error.detail ?? `${error.code} ${error.message}`;
  const kind: FailureKind = overflow
    ? "request"
    : failureKind(error.status, text);
  const errorClass =
    error.code === "upstream_invalid_response" ||
    error.code === "upstream_protocol_error" ||
    error.code === "response_too_large"
      ? error.code
      : failureClass(kind, error.status, overflow);
  const floor = error.status === 400 ? tokenFloor(text) : 0;
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
    kind,
    ...(floor ? { floor } : {}),
  };
}

/**
 * A reply that is the vendor's safety filter refusing with nothing said
 * (Magpie `refusedReply`), while nothing went to the client: thrown as the
 * 400 it stands for, a `policy` failure that the next candidate may answer.
 * With nobody left the client gets that 400, not an empty reply it would
 * send again (Magpie #248); a stream already flowing to the client (held
 * back for no retry or other candidate) reaches it as it came.
 */
function refusedWithNothingSaid(): GatewayError {
  return new GatewayError(
    "The upstream's safety filter refused the request with nothing said",
    400,
    "content_filter",
  );
}

/** `prepared` asking for at least `floor` tokens of reply where it asked for fewer ({@link withTokenFloor}). */
function floored(prepared: Prepared, floor: number): boolean {
  if (prepared.kind === "passthrough") {
    const text = withTokenFloor(prepared.body.toString("utf8"), floor);
    if (text !== undefined) prepared.body = Buffer.from(text);
    return text !== undefined;
  }
  if (prepared.kind === "translated") {
    const text = withTokenFloor(prepared.body, floor);
    if (text !== undefined) prepared.body = text;
    return text !== undefined;
  }
  return false;
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

/**
 * The gateway answers the client's web search for this candidate: search
 * backends are set, the request offers its model a server-side web search
 * (or has the gateway's searches in its history), and the candidate's
 * upstream does not run that search itself.
 */
function searchNeeded(call: Call, candidate: Candidate): boolean {
  const { services } = call;
  if (call.internal || !services.features().search?.backends.length)
    return false;
  if (!searchOffered(call.route.protocol, call.raw)) return false;
  const text = JSON.stringify(call.raw);
  const ours =
    text.includes(SEARCH_MARKERS[0]) || text.includes(SEARCH_MARKERS[1]);
  return ours || !searchesNatively(candidate, call.route.protocol);
}

/** The usage of several upstream answers of one call, as one. */
function sumUsage(parts: readonly UsageParts[]): UsageParts {
  if (parts.length === 1) return parts[0]!;
  const sum: UsageParts = {};
  for (const part of parts)
    for (const key of [
      "input",
      "cacheRead",
      "cacheWrite",
      "output",
      "reasoning",
    ] as const)
      if (part[key] !== undefined) sum[key] = (sum[key] ?? 0) + part[key];
  return sum;
}

/** The candidate's model takes image input, by its metadata. */
function takesImages(candidate: Candidate): boolean {
  return candidate.model?.inputModalities?.includes("image") === true;
}

/**
 * The translated request goes to a model without image input while a
 * vision model is set, and the request has images.
 */
function visionNeeded(call: Call, candidate: Candidate): boolean {
  // Translated requests lose images without metadata saying otherwise;
  // passed-through ones only when the metadata says the model takes none.
  const inputs = candidate.model?.inputModalities;
  if (
    candidate.mode === "translated"
      ? takesImages(candidate)
      : !inputs || inputs.includes("image")
  )
    return false;
  if (call.vision) return true;
  const { services, internals } = call;
  const vision = services.features().vision;
  if (!internals || !services.vision || !vision) return false;
  let images: boolean;
  try {
    images =
      imagesOf(translate(call, { images: true, search: true }).body.messages)
        .length > 0;
  } catch {
    return false;
  }
  // The key's allowlist holds for the descriptions too: its images stay placeholders.
  if (images && !internals.allows(vision.model)) {
    if (!call.routePatches.includes("vision:not-allowed"))
      call.routePatches.push("vision:not-allowed");
    return false;
  }
  return images;
}

/** Describe the call's images with the vision model (cached by image), as the call's key. */
async function describeCall(call: Call): Promise<VisionResult> {
  const { services } = call;
  const model = services.features().vision!.model;
  const images = imagesOf(
    translate(call, { images: true, search: true }).body.messages,
  );
  return services.vision!.describe(
    model,
    images,
    call.internals!,
    services.limits.maxDescribedImages,
    call.signal,
  );
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
      return googleToChat(
        call.raw,
        call.shownModel ?? call.requested,
        call.stream,
        options,
      );
  }
}

function createSink(
  call: Call,
  translation: ChatTranslation,
  body: Record<string, unknown>,
): OutputSink {
  const context = {
    model: call.shownModel ?? call.requested,
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
 * headers) until the first content event, or until {@link release}. The
 * sink starts once, whichever of `start`, `release` and {@link open} gets
 * there first.
 */
class SinkHold implements CompletionHandlers {
  #holding: boolean;
  #started = false;
  #released: Promise<void> | undefined;
  #sinkStarted: Promise<void> | undefined;
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
    this.#released = this.#started ? this.#startSink() : Promise.resolve();
    return this.#released;
  }
  start(): Promise<void> {
    this.#started = true;
    return this.#holding ? Promise.resolve() : this.#startSink();
  }
  /**
   * Start the sink before any upstream data, so that a keepalive can follow:
   * resolves false, starting nothing, while output is held.
   */
  async open(): Promise<boolean> {
    if (this.#holding) return false;
    await this.#startSink();
    return true;
  }
  #startSink(): Promise<void> {
    return (this.#sinkStarted ??= this.sink.start());
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
  /** A web search the gateway ran, as the client's protocol shows one. */
  async search(query: string, hits: { title: string; url: string }[]) {
    this.content();
    await this.release();
    await this.sink.search?.(query, hits);
  }
}

/** Whether an SSE event block has comment lines only. */
function commentOnly(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => line.startsWith(":"));
}

/**
 * Passthrough forwarding of complete segments. Before the first content event
 * segments are held when alternatives remain, and before the first data
 * event in any case; from the terminal event on,
 * everything is withheld until {@link finish}, which runs after the ledger
 * commit. An error segment is never forwarded: it ends forwarding and is
 * reported by the caller in the gateway's own words. Comment-only segments
 * are dropped for Gemini clients.
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
  /** An event held a tool call: a `stop` finish is then `tool_calls`. */
  toolCall = false;
  /** An event said something: text, reasoning or a call. */
  said = false;
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
  /** True while segments are held for a possible failover (not merely awaiting data). */
  get holding(): boolean {
    return this.#holding;
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
    if (observation.toolCall) this.toolCall = true;
    if (observation.sequence !== undefined)
      this.sequence = observation.sequence;
    if (this.error) return observation;
    if (observation.error) {
      this.error = observation.error;
      return observation;
    }
    // Gemini clients never get SSE comments; their keepalive is an empty
    // candidate (03 section 6).
    if (this.protocol === "gemini" && commentOnly(segment.text))
      return observation;
    if (observation.content) {
      this.said = true;
      this.content();
    }
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

/**
 * One keepalive of a passthrough response in the inbound protocol's own form
 * (03 section 6), never an SSE comment: an empty Chat delta, a Responses
 * `response.in_progress` (after a `response.created` while neither the
 * upstream nor an earlier keepalive sent one, as SDK stream helpers need it
 * first), an Anthropic `ping`, and for Gemini an empty candidate, or
 * whitespace in a JSON body.
 */
function passthroughKeepalive(
  call: Call,
  forwarder: Forwarder | undefined,
  announced: boolean,
): string {
  const id = call.entry.callId.replace(/^mc_/, "");
  const created = Math.floor(call.services.clock() / 1000);
  const model = forwarder?.model ?? call.shownModel ?? call.requested;
  switch (call.route.protocol) {
    case "chat":
      return sse({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      });
    case "responses": {
      const response = {
        id: `resp_${id}`,
        object: "response",
        created_at: created,
        status: "in_progress",
        model,
        output: [],
      };
      const sequence = (forwarder?.sequence ?? -1) + 1;
      const progress = (at: number) =>
        sse(
          { type: "response.in_progress", sequence_number: at, response },
          "response.in_progress",
        );
      return forwarder?.opened || announced
        ? progress(sequence)
        : sse(
            { type: "response.created", sequence_number: 0, response },
            "response.created",
          ) + progress(1);
    }
    case "anthropic":
      return sse({ type: "ping" }, "ping");
    case "gemini":
      return call.stream && call.route.gemini?.sse
        ? `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, index: 0 }] })}\n\n`
        : "\n";
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
      // A bare JSON object, as GoogleSink ends a failed stream.
      if (call.route.gemini?.sse) return `${error}\n`;
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
    // A group member's fixed effort and fast mode, in the request's own terms.
    const member = memberPassthrough(candidate.upstream, call.raw, candidate);
    const built = passthroughBody(
      candidate.upstream,
      member ? Buffer.from(JSON.stringify(member.raw)) : call.bytes,
      member?.raw ?? call.raw,
      candidate.wireModel,
      set,
    );
    const masked = redact(call, built.body, [
      ...built.patches,
      ...(member?.patches ?? []),
    ]);
    const { body, patches } =
      candidate.upstream === "responses"
        ? relayResponses(call, masked.body, masked.patches)
        : masked;
    return tooLarge(body.length) ?? { kind: "passthrough", body, patches };
  }
  const images = takesImages(candidate);
  let translation: ChatTranslation;
  try {
    // Described images are kept until they are replaced by their text.
    translation = translate(call, {
      images: images || !!call.vision,
      search: call.searching === true,
    });
    if (!images && call.vision)
      describeImages(translation.body.messages, call.vision.descriptions);
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
  const visionPatches = !images && call.vision ? [...call.vision.patches] : [];
  visionPatches.push(...memberTranslation(translation, candidate));
  // The client's server-side web search becomes the gateway's own tool.
  let search: string | undefined;
  if (translation.search) {
    const offered = searchTool(translation.body.tools);
    search = offered.name;
    translation.body.tools = [
      ...(Array.isArray(translation.body.tools) ? translation.body.tools : []),
      offered.tool,
    ];
    visionPatches.push("search:emulated");
  }
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
      ? (set?.maxTokensField ?? "max_completion_tokens")
      : "max_tokens",
    // Other protocols drop their fields from the encoded body below.
    dropParameters: chatUpstream ? drops : [],
    images: images ? "passthrough" : "placeholder",
  };
  const applied: string[] = [...visionPatches];
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
  if (patches.has("max-tokens-field") && settings.maxTokensField in body)
    applied.push("max-tokens-field");
  // Normalization puts every system and developer message into the first.
  if (
    patches.has("merge-system-messages") &&
    translation.body.messages.filter(
      (message) => message.role === "system" || message.role === "developer",
    ).length > 1
  )
    applied.push("merge-system-messages");
  const { upstream, unmapped } = encodeUpstream(
    call,
    candidate,
    translation,
    body,
    drops,
    applied,
  );
  applied.push(...memberFast(upstream, candidate));
  const masked = redact(call, upstream, applied);
  const text = JSON.stringify(masked.body);
  return (
    tooLarge(Buffer.byteLength(text)) ?? {
      kind: "translated",
      translation,
      chat: body,
      body: text,
      patches: masked.patches,
      unmapped,
      replay,
      ...(search ? { search } : {}),
    }
  );
}

/**
 * The upstream body of a normalized Chat request: the Chat request itself,
 * or its encoding for the candidate's protocol, with the provider's dropped
 * fields removed. Patches are added to `applied`.
 */
function encodeUpstream(
  call: Call,
  candidate: Candidate,
  translation: ChatTranslation,
  body: Record<string, unknown>,
  drops: readonly string[],
  applied: string[],
): { upstream: Record<string, unknown>; unmapped: string[] } {
  // A Copilot session takes the messages, tools and reasoning effort only.
  if (candidate.upstream === "chat")
    return {
      upstream: body,
      unmapped:
        candidate.provider.subscription?.backend === "copilot"
          ? copilotUnmapped(body)
          : [],
    };
  const { reasoning } = call.services;
  const encoded = encodeRequest(candidate.upstream, body, {
    translation,
    model: candidate.model,
    ...(candidate.provider.subscription?.backend === "siwc"
      ? { profile: "siwc" as const }
      : {}),
    signature: (kind, key) =>
      reasoning.signature(call.key.keyId, candidate.provider.id, kind, key),
  });
  const upstream = encoded.body;
  for (const field of drops)
    if (field in upstream) {
      delete upstream[field];
      applied.push(`drop-fields:${field}`);
    }
  applied.push(...encoded.patches);
  return { upstream, unmapped: encoded.unmapped };
}

/**
 * The upstream body with known secrets replaced by placeholders, and the
 * patch `redact:<count>`; when anything was replaced, the client's response
 * gets the values back in tool-call arguments (./restore.js).
 */
function redact<T extends Buffer | Record<string, unknown>>(
  call: Call,
  body: T,
  patches: string[],
): { body: T; patches: string[] } {
  const settings = call.services.features().redaction;
  if (!settings.enabled) return { body, patches };
  let count: number;
  let masked: T;
  if (Buffer.isBuffer(body)) {
    const result = maskBody(call.services.redactor, settings, body);
    count = result.count;
    masked = result.body as T;
  } else {
    const result = call.services.redactor.maskJson(body, settings.rules);
    count = result.count;
    masked = result.value as T;
  }
  if (!count) return { body, patches };
  if (!call.writer.transformedBy(ToolArgumentRestorer))
    call.writer.addTransform(
      new ToolArgumentRestorer(
        call.services.redactor,
        call.route.protocol,
        !call.stream
          ? "json"
          : call.route.protocol === "gemini" && !call.route.gemini?.sse
            ? "array"
            : "sse",
      ),
    );
  return { body: masked, patches: [...patches, `redact:${count}`] };
}

/**
 * A Responses body passed through, as an upstream other than ChatGPT's Codex
 * backend (subscriptions are translated) can take it: without the reasoning
 * the gateway encoded itself (./compacting.js), and with Codex's tool search
 * as a function, whose calls the client then gets back as `tool_search_call`
 * items (./toolsearch.js).
 */
function relayResponses(
  call: Call,
  body: Buffer,
  patches: string[],
): { body: Buffer; patches: string[] } {
  const applied = [...patches];
  const own = withoutOwnReasoning(body);
  if (own) {
    body = own.body;
    applied.push(`reasoning:dropped:${own.dropped}`);
  }
  const searched = searchAsFunction(body);
  if (searched) {
    body = searched;
    applied.push("tool-search:function");
    if (!call.writer.transformedBy(SearchCallRestorer))
      call.writer.addTransform(
        new SearchCallRestorer(call.stream ? "sse" : "json"),
      );
  }
  return { body, patches: applied };
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
  const copilot =
    candidate.provider.subscription?.backend === "copilot"
      ? (services.copilot ??
        new CopilotError(
          "Copilot is not available in this gateway",
          "unavailable",
        ))
      : undefined;
  let secret = "";
  try {
    if (copilot instanceof CopilotError) throw copilot;
    if (copilot) {
      // The bridge's runtime holds the account's sign-in.
    } else if (candidate.provider.subscription) {
      if (!services.subscriptions)
        throw new SiwcError("No subscription tokens", "unavailable", false);
      secret = await services.subscriptions.accessToken(
        candidate.provider,
        candidate.credential,
        call.signal,
      );
    } else if (candidate.credential !== KEYLESS_CREDENTIAL)
      secret = await services.resolveSecret(candidate.credential.ref);
    // From now on this credential is never sent in a prompt.
    if (secret) services.redactor.remember(secret, "PROVIDER_KEY");
  } catch (error) {
    if (call.signal.aborted)
      return { ok: false, error: cancelled(call), release };
    services.log.info("gateway.credential.unresolved", {
      provider: candidate.provider.id,
      credential: candidate.credential.id,
      ...(error instanceof SiwcError ? { code: error.code } : {}),
    });
    if (error instanceof CopilotError)
      return { ok: false, error: copilotFailure(candidate, error), release };
    const account = candidate.credential.account;
    return {
      ok: false,
      error:
        error instanceof SiwcError && error.terminal
          ? localError(
              401,
              "subscription_sign_in_needed",
              `The ChatGPT account ${account?.email ?? candidate.credential.name} of provider ${candidate.provider.id} must sign in again (hh subscription login chatgpt --provider ${candidate.provider.id})`,
            )
          : localError(
              502,
              "credential_unavailable",
              `Credential ${candidate.credential.id} of provider ${candidate.provider.id} could not be resolved`,
            ),
      release,
    };
  }
  const secrets = [
    ...(secret ? [secret] : []),
    ...Object.values(candidate.provider.headers ?? {}),
  ];
  const { url, headers, body } = request(secret);
  let headerTimeout = false;
  const timer = timers.set(() => {
    headerTimeout = true;
    abort.abort();
  }, services.limits.upstreamHeaderTimeoutMs);
  const attemptStarted = performance.now();
  try {
    const signal = AbortSignal.any([call.signal, abort.signal]);
    const response = copilot
      ? await copilot.complete({
          provider: candidate.provider,
          credential: candidate.credential,
          body: String(body),
          signal,
          report: (readings) => services.router.report(candidate, readings),
          patch: (name) => {
            if (!call.entry.patches.includes(name))
              call.entry.patches.push(name);
          },
        })
      : await services.fetch(
          url,
          { method: "POST", redirect: "error", signal, headers, body },
          providerProxy(candidate.provider),
        );
    services.router.observe(candidate, response.headers);
    if (response.ok) {
      timers.clear(timer);
      return { ok: true, response, secrets, release };
    }
    attempt.status = response.status;
    const now = services.clock();
    const wait = retryAfter(response.headers, now);
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
      text,
    );
    if (wait !== undefined) error.retryAfterMs = wait;
    const reset = resetIn(text, now);
    if (reset !== undefined) error.resetMs = reset;
    return { ok: false, error: usageHint(candidate, error), release };
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
    if (error instanceof CopilotError)
      return { ok: false, error: copilotFailure(candidate, error), release };
    // The proxy, not the upstream, failed: no rest for the credential.
    const proxied = proxyFailure(error);
    if (proxied)
      return {
        ok: false,
        error: {
          failure: failure(502, "proxy_failed", proxied.message),
          errorClass: "proxy_failed",
          source: "gateway",
          phase: "connect",
          kind: "proxy",
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
 * the same provider: a single thinking block's signature by its text, Gemini
 * function-call signatures by the call id the client will send back, and the
 * Responses reasoning item each tool call followed by that call's keys.
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
  for (const [index, item] of decoder.callReasoning) {
    const called = result.calls[index];
    if (called)
      for (const key of reasoningItemKeys(called))
        remember("call", key, JSON.stringify(item));
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
  // The gateway's own web search: its tool calls stay here (./search.js).
  const relay = prepared.search
    ? new SearchRelay(hold, prepared.search)
    : undefined;
  const request = (body: string) => (secret: string) => {
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
    withFastBeta(headers, candidate);
    return { url, headers, body };
  };
  const sent = await send(
    call,
    candidate,
    attempt,
    abort,
    timers,
    request(prepared.body),
  );
  let release = sent.release;
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
      () => hold.open(),
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
    const unmapped = new Set<string>();
    /** One upstream answer, read into the client's sink. */
    const read = async (answer: Response): Promise<ChatResult> => {
      const counted = answer.body?.pipeThrough(
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
      const decoding =
        candidate.upstream === "chat"
          ? undefined
          : ((answer === upstream ? decoder : undefined) ??
            createDecoder(candidate.upstream));
      const read = await readCompletion(
        new Response(counted ?? null, { headers: answer.headers }),
        relay ?? hold,
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
        decoding,
      );
      for (const field of decoding?.unmapped ?? []) unmapped.add(field);
      if (decoding && decoding !== decoder)
        rememberSignatures(call, candidate, decoding, read);
      return read;
    };
    let result = await read(upstream);
    const parts: UsageParts[] = [];
    const usageOf = (value: ChatResult) =>
      parts.push(value.rawUsage ? usageParts("chat", value.rawUsage) : {});
    usageOf(result);
    if (relay) {
      // Search, then ask again with what was found, until the model answers.
      const messages = [
        ...(prepared.chat.messages as Record<string, unknown>[]),
      ];
      const backends = services.features().search?.backends ?? [];
      const perRound = limits.maxSearchesPerRound;
      const perRequest = limits.maxSearchesPerRequest;
      let rounds = 0;
      // Each search run takes a request of the key's per-minute bucket; the
      // counts hold over the call's attempts.
      const searched = (call.searched ??= { ran: 0, refused: 0 });
      const notRun = (why: string) => {
        searched.refused++;
        return { error: why };
      };
      for (;;) {
        const searches = relay.round(result);
        if (!searches.length || rounds > SEARCH_ROUNDS) {
          result = relay.result(result);
          break;
        }
        rounds++;
        const found = await Promise.all(
          searches.map((search, index) => {
            if (rounds > SEARCH_ROUNDS)
              return { error: "No more searches: answer with what was found." };
            if (!search.query) return { error: "The query is empty." };
            if (index >= perRound)
              return notRun(
                `Not run: at most ${perRound} searches at once; search again for what is still missing.`,
              );
            if (searched.ran >= perRequest)
              return notRun("No more searches: answer with what was found.");
            const limited = services.quotas.take(call.key);
            if (limited) return notRun(`Not run: ${limited.message}.`);
            searched.ran++;
            return webSearch(
              services.redactor.mask(
                search.query,
                services.features().redaction.enabled
                  ? services.features().redaction.rules
                  : [],
              ).text,
              backends,
              services.resolveSecret,
              call.signal,
              services.fetch,
            );
          }),
        );
        for (const [index, outcome] of found.entries())
          if ("hits" in outcome)
            await hold.search(searches[index]!.query, outcome.hits);
        messages.push(
          {
            role: "assistant",
            content: result.text || null,
            tool_calls: searches.map((search) => ({
              id: search.id,
              type: "function",
              function: {
                name: prepared.search,
                arguments: JSON.stringify({ query: search.query }),
              },
            })),
          },
          ...searches.map((search, index) => {
            const outcome = found[index]!;
            return {
              role: "tool",
              tool_call_id: search.id,
              content:
                "text" in outcome
                  ? outcome.text
                  : `The search failed: ${outcome.error}`,
            };
          }),
        );
        const applied: string[] = [];
        const encoded = encodeUpstream(
          call,
          candidate,
          prepared.translation,
          { ...prepared.chat, messages },
          [],
          applied,
        );
        const masked = redact(call, encoded.upstream, applied);
        release();
        const again = await send(
          call,
          candidate,
          attempt,
          abort,
          timers,
          request(JSON.stringify(masked.body)),
        );
        release = again.release;
        if (!again.ok)
          throw new GatewayError(
            again.error.failure.message,
            again.error.failure.status,
            again.error.failure.code,
          );
        result = await read(again.response);
        usageOf(result);
      }
      call.entry.patches.push(
        `search:rounds:${rounds}`,
        `search:queries:${searched.ran}`,
        ...(searched.refused ? [`search:refused:${searched.refused}`] : []),
      );
    }
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
    if (
      !writer.sent &&
      result.finish === "content_filter" &&
      !result.text &&
      !result.reasoning &&
      !result.calls.length
    )
      throw refusedWithNothingSaid();
    recordSuccess(
      call,
      candidate,
      attempt,
      sumUsage(parts),
      result.model,
      result.finish,
      result.terminated === true,
    );
    if (unmapped.size)
      call.entry.unmapped = [...new Set([...call.entry.unmapped, ...unmapped])];
    const empty = emptyCompaction(call, result.text);
    const recorded = await commit(call);
    try {
      if (!recorded) await evidenceUnavailable(call, sink);
      else if (empty) await failAnswer(call, empty, sink);
      else {
        await hold.release();
        await sink.finish(result);
      }
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
    const reported = usageHint(
      candidate,
      readError(call, error, idle, secrets),
    );
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
    release();
    abort.abort();
  }
}

/**
 * A compaction the gateway serves whose model wrote no summary
 * (./compacting.js) fails with 502 `compaction_empty`. Recorded over the
 * success fields, so the upstream's usage stays counted; the client gets
 * this failure instead of the answer ({@link failAnswer}).
 */
function emptyCompaction(
  call: Call,
  summary: string | undefined,
): Failure | undefined {
  if (!call.compaction || summary?.trim()) return undefined;
  const error = localError(502, "compaction_empty", COMPACTION_EMPTY);
  recordFailure(call.entry, error);
  return error.failure;
}

/** The ledger could not be written: report 503 `evidence_unavailable` instead of the answer. */
async function evidenceUnavailable(
  call: Call,
  sink: OutputSink | undefined,
  forwarder?: Forwarder,
): Promise<void> {
  await failAnswer(
    call,
    failure(
      503,
      "evidence_unavailable",
      "The model call could not be recorded; the answer is withheld",
    ),
    sink,
    forwarder,
  );
}

/**
 * Report `value` instead of an answer that is withheld: as the inbound
 * protocol's error response while nothing was sent, else in the stream.
 */
async function failAnswer(
  call: Call,
  value: Failure,
  sink: OutputSink | undefined,
  forwarder?: Forwarder,
): Promise<void> {
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
    withFastBeta(headers, candidate);
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
    const streamed =
      call.stream &&
      (/event-stream/i.test(contentType) || (gemini && !route.gemini?.sse));
    // Streams get the inbound protocol's keepalives, which may commit the
    // response before the first data unless output is held; Gemini clients
    // also give up after 60 s without headers (03 section 6).
    let keepalive: Keepalive | undefined;
    if (gemini || streamed) {
      let announced = false;
      keepalive = new Keepalive(
        writer,
        { gapMs: limits.keepaliveGapMs, maxNoDataMs: limits.maxNoDataMs },
        () => {
          const frame = passthroughKeepalive(call, forwarder, announced);
          announced = true;
          return writer.write(frame);
        },
        streamed
          ? () => {
              if (forwarder?.holding) return Promise.resolve(false);
              begin();
              return Promise.resolve(true);
            }
          : undefined,
      );
      timers.keepalive = keepalive;
      keepalive.answered();
    }
    if (gemini)
      timers.set(
        () => {
          if (writer.sent || writer.closed) return;
          forwarder?.release();
          begin();
        },
        call.started + limits.headerCommitMs - performance.now(),
      );
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
    const summary = call.compaction ? new SummaryReader() : undefined;
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
          summary?.read(segment.text);
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
      for (const segment of segmenter.end()) {
        forwarder.segment(segment);
        summary?.read(segment.text);
      }
    await timers.stop(call.closed);
    let parts: UsageParts;
    let served: string | undefined;
    let finish: string | undefined;
    let terminated: boolean;
    let said: boolean;
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
      finish = settleFinish(forwarder.finishReason, forwarder.toolCall);
      terminated = forwarder.terminal;
      said = forwarder.said;
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
      said = observation.content;
      parts = observation.usage ?? {};
      served = observation.model;
      finish = settleFinish(observation.finish, observation.toolCall === true);
      terminated = true;
      summary?.read(body.toString("utf8"));
    }
    if (!writer.sent && finish === "content_filter" && !said)
      throw refusedWithNothingSaid();
    recordSuccess(call, candidate, attempt, parts, served, finish, terminated);
    const empty = emptyCompaction(call, summary?.text);
    const recorded = await commit(call);
    try {
      if (!recorded) await evidenceUnavailable(call, undefined, forwarder);
      else if (empty) await failAnswer(call, empty, undefined, forwarder);
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
    const reported = usageHint(
      candidate,
      readError(call, error, idle, secrets),
    );
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
 * first byte, or the last failure in the inbound protocol's format. A failure
 * that may fail over moves on at once while another candidate can still be
 * tried (its breaker not open); only the last one left is retried, after
 * `baseBackoffMs × 2^n` or the vendor's wait, and not when that wait passes
 * its cap (Magpie `passing`).
 */
export async function routeCall(call: Call, plan: CallPlan): Promise<void> {
  const { services, entry } = call;
  // Codex's compaction served here, and the summaries of earlier ones.
  if (call.route.protocol === "responses") {
    const codex = codexInput(call.raw, true);
    if (codex) {
      call.raw = codex.raw;
      call.bytes = Buffer.from(JSON.stringify(codex.raw));
      if (codex.restored)
        call.routePatches.push(`compaction:restored:${codex.restored}`);
      if (codex.summary) {
        call.compaction = true;
        call.routePatches.push("compaction:summary");
        call.writer.addTransform(
          new CompactionReply(call.stream ? "sse" : "json"),
        );
      }
    }
  }
  /** How far sealed items were taken out of the request (`unsealed`). */
  let unsealStep = 0;
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
  const queue = [...plan.candidates];
  /** Upstream APIs (provider and protocol) that could not read this request's shape. */
  const unreadable = new Set<string>();
  const api = (candidate: Candidate) =>
    `${candidate.provider.id}\u0000${candidate.upstream}`;
  for (let index = 0; index < queue.length; index++) {
    let candidate = queue[index]!;
    // An API that could not read the request's shape will not read it now.
    if (unreadable.has(api(candidate))) continue;
    /** Another candidate after this one can still be tried. */
    const others = () =>
      queue
        .slice(index + 1)
        .some(
          (next) =>
            !services.breakers.blocked(next) && !unreadable.has(api(next)),
        );
    let retries = 0;
    let headerRetries = 0;
    for (;;) {
      if (call.signal.aborted) return publishFailure(call, cancelled(call));
      if (entry.attempts.length >= policy.totalAttempts)
        return publishFailure(
          call,
          last ?? localError(503, "attempts_exhausted", "No attempt left"),
        );
      // A retry of this call was decided with its wait and the breaker as
      // it was then; only the first try asks the breaker here.
      if (retries === 0) {
        const admitted = services.breakers.admit(candidate);
        if (!admitted.ok) {
          if (!blocked || (admitted.last?.at ?? 0) > (blocked.last?.at ?? 0))
            blocked = admitted;
          break;
        }
      }
      // A member's fixed effort is set in Chat or Responses terms.
      if (memberNeedsTranslation(candidate, call.route.protocol))
        candidate = { ...candidate, mode: "translated" };
      call.searching = searchNeeded(call, candidate);
      // The searches are the gateway's, so the request is translated.
      if (call.searching && candidate.mode === "passthrough")
        candidate = { ...candidate, mode: "translated" };
      if (visionNeeded(call, candidate)) {
        // Images are replaced by text, so the request is translated.
        if (candidate.mode === "passthrough")
          candidate = { ...candidate, mode: "translated" };
        call.vision ??= await describeCall(call);
        if (call.vision.currentFailed) {
          services.breakers.release(candidate);
          skip ??= call.vision.refused
            ? localError(
                429,
                "quota_exceeded",
                `The image of this turn could not be described by ${services.features().vision?.model ?? "the vision model"}: this Gateway Key reached a limit`,
              )
            : localError(
                502,
                "vision_failed",
                `The image of this turn could not be described by ${services.features().vision?.model ?? "the vision model"} for ${candidate.ref}, which takes no image input`,
              );
          break;
        }
      }
      const prepared = prepare(call, candidate);
      if (call.tokenFloor !== undefined) floored(prepared, call.tokenFloor);
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
        (others() || retries < policy.perCandidate);
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
          const effect = classify(result.error).breaker;
          services.breakers.failure(
            candidate,
            effect,
            result.error.failure,
            result.error.errorClass,
          );
        } else {
          services.breakers.success(candidate);
          services.router.record(
            candidate,
            result.tokens,
            entry.timing.firstContentMs,
          );
          if (call.conversation && !call.rules?.compact)
            services.sticky.remember(
              call.conversation,
              call.requested,
              candidate,
              entry.usage?.cacheRead ?? 0,
            );
          call.rules?.answered(
            (entry.usage?.input ?? 0) +
              (entry.usage?.cacheRead ?? 0) +
              (entry.usage?.cacheWrite ?? 0),
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
      // The conversation brought reasoning or a compaction that another
      // account or vendor sealed, which this one refused: the same
      // candidate is asked again without it (Magpie's `resealed`).
      const resealed =
        call.route.protocol === "responses" &&
        error.source === "upstream" &&
        refusesSeal(error.failure.message)
          ? unsealed(call.raw, unsealStep)
          : undefined;
      if (resealed && entry.attempts.length < policy.totalAttempts) {
        unsealStep = resealed.step;
        call.raw = resealed.raw;
        call.bytes = Buffer.from(JSON.stringify(resealed.raw));
        call.routePatches.push(`sealed:${resealed.kind}`);
        services.breakers.release(candidate);
        attempt.decision = "retry";
        retries = 0;
        continue;
      }
      // A vendor that takes no reply this short is asked again, once, for
      // the least it takes (Magpie `withTokenFloor`).
      if (
        error.floor !== undefined &&
        call.tokenFloor === undefined &&
        entry.attempts.length < policy.totalAttempts &&
        floored(prepared, error.floor)
      ) {
        call.tokenFloor = error.floor;
        call.routePatches.push(`max-tokens:floor:${error.floor}`);
        services.breakers.release(candidate);
        attempt.decision = "retry";
        retries = 0;
        continue;
      }
      const verdict = classify(error);
      services.breakers.failure(
        candidate,
        verdict.breaker,
        error.failure,
        error.errorClass,
      );
      last = error;
      // Another API may read a shape this one could not; this one won't.
      if (error.kind === "shape") unreadable.add(api(candidate));
      // What one account's safety filter refused, another account of the
      // same model may answer: they go first (Magpie `matesFirst`).
      if (error.kind === "policy") matesFirst(queue, index, services.breakers);
      const left = entry.attempts.length < policy.totalAttempts;
      let wait = 0;
      let decision: CallAttempt["decision"] = "stop";
      if (left && verdict.failover && others()) decision = "failover";
      else if (
        left &&
        retries < policy.perCandidate &&
        (verdict.retry === "yes" ||
          (verdict.retry === "once" && headerRetries < 1))
      ) {
        const said = error.retryAfterMs;
        wait = said ?? backoff(policy, retries);
        // Not past its cap or the call's budget, and not onto a breaker this
        // failure opened, unless that is a rate limit's rest the wait honours.
        if (
          wait <=
            (said === undefined
              ? policy.maxBackoffMs
              : policy.retryAfterWaitCapMs) &&
          performance.now() - began + wait <= RETRY_BUDGET_MS &&
          (error.kind === "rate" || !services.breakers.blocked(candidate))
        )
          decision = "retry";
      }
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
