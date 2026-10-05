// SPDX-License-Identifier: MIT
/**
 * The shared multi-provider gateway (03-model-plane): one handler that the
 * daemon mounts on its own listener for `/v1/*`, `/v1beta/*`, `/v1alpha/*`
 * and the prefix-less OpenAI and Anthropic paths. It authenticates Gateway
 * Keys, resolves Model Refs and route groups from the {@link ModelPlaneStore},
 * routes each call over provider credentials and commits one `model.call`
 * entry per call, rejected or not, before the answer's terminal event.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import type { OutboundFetch } from "@harnesshub/core/outbound";
import {
  gatewayKeyMatches,
  claudeModelAlias,
  modelAllowed,
  parseGatewayKey,
  parseModelRef,
  type AllowanceReading,
  type CallPurpose,
  type GatewayKeyId,
  type GatewayKeyRecord,
  type KeyLimitStatus,
  type ModelCallEntry,
  type ModelCallId,
  type ModelPlaneStore,
  type ModelRef,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderModel,
  type ReasoningEffort,
  type RouteGroup,
  type RouteDecisionPage,
  type RouteDecisionQuery,
  type RouteGroupId,
  type Stickiness,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import {
  AUTO_GROUP_PREFIX,
  autoGroups,
  autoRouteGroup,
} from "@harnesshub/core/auto-groups";
import { groupModels, modelEfforts } from "@harnesshub/core/route-groups";
import { ruledCapabilities } from "@harnesshub/core/route-rules";
import { HARNESS_MODEL_ALIAS } from "@harnesshub/core/harness-model";
import type { RunId, SessionId } from "@harnesshub/core/types";
import { agentOf } from "./agents.js";
import { anthropicCountTokens } from "./anthropic.js";
import {
  errorResponse,
  publishFailure,
  ReasoningCaches,
  routeCall,
  type Call,
  type CallPlan,
  type CallRoute,
  type CallServices,
} from "./call.js";
import {
  failure,
  MemoryBudget,
  parseJsonBody,
  readBody,
  Slots,
} from "./http.js";
import { RejectionThrottle } from "./ledger.js";
import { Quotas, type Admission, type QuotaRefusal } from "./quota.js";
import {
  CODEX_BACKEND,
  CODEX_PATH,
  codexModels,
  codexPassthrough,
  codexRoute,
  isCodexPath,
  type CodexListedModel,
  type CodexListing,
} from "./codex.js";
import { COMPACT_UNSUPPORTED } from "./compacting.js";
import { keyPathRoute } from "./key-path.js";
import { MUSE_MODELS_PATH, museModelList } from "./muse.js";
import { Classifier } from "./classify.js";
import { applyRules, GroupRules } from "./rules.js";
import { DecisionTrace } from "./trace.js";
import { conversationOf, StickyRoutes } from "./sticky.js";
import { canonicalHost, LOOPBACK_ONLY, type GatewayAccess } from "./sharing.js";
import { forwardCountTokens } from "./count.js";
import type { HandlerLimits } from "./limits.js";
import { HttpWriter, type Failure } from "./output.js";
import { GatewayError, estimateTokens, object, record } from "./protocol.js";
import {
  Breakers,
  modelCandidates,
  planGroup,
  Router,
  type AttemptError,
  type Candidate,
  type StoredReading,
} from "./routing.js";
import type { SubscriptionTokens } from "./siwc.js";
import { CopilotBridge, type CopilotRuntime } from "./copilot.js";
import {
  DEFAULT_GATEWAY_FEATURES,
  type GatewayFeatures,
} from "@harnesshub/core/gateway-features";
import { Redactor } from "./redaction.js";
import { VisionDescriber } from "./vision.js";
import type { InternalAnswer, InternalCalls } from "./internal.js";
import { imagesCall } from "./images.js";
import { resolveBareName } from "./bare-names.js";

/** The Run a `session:` key's calls belong to, and the model target it selected. */
export interface ActiveSessionRun {
  runId: RunId;
  generation: number;
  /** Model Ref or `group/<id>` that the alias, and names that are no Model Ref, resolve to. */
  target: string;
}

/** The Session and Run lifecycle the gateway needs for `session:` keys (05 section 4). */
export interface GatewaySessions {
  /**
   * The Session's active Run, or undefined between Runs: a `session:` key's
   * calls are then refused with 409 `no_active_run`. Called once per request.
   */
  activeRun(sessionId: SessionId): ActiveSessionRun | undefined;
  /**
   * A `session:` key's ledger entry was committed. Called synchronously
   * after the commit, before the client sees the terminal event; exceptions
   * are logged and ignored.
   */
  committed?(entry: ModelCallEntry): void;
}

/** What the shared gateway needs from its composition root. */
export interface GatewayHandlerDeps {
  /** Providers, route groups, Gateway Keys and the ledger. */
  store: ModelPlaneStore;
  /**
   * Resolve a credential reference to the secret value. Called once per
   * upstream attempt, never cached by the gateway; a rejection makes that
   * credential fail over as `credential_unavailable`. The value is never
   * logged or returned to clients.
   */
  resolveSecret(ref: SecretReference): Promise<string>;
  /** Wall-clock milliseconds since the epoch: ledger times, key expiry, breakers and Retry-After. */
  clock: () => number;
  /**
   * The IANA time zone of Gateway Key budget windows (a day from midnight,
   * a week from Monday, a month from the 1st); this process's when absent.
   */
  timeZone?: string;
  /** From {@link resolveHandlerLimits}. */
  limits: Readonly<HandlerLimits>;
  /** Diagnostics: ledger and touch failures, breaker changes, internal errors. */
  log?: LogSink;
  /** Session Runs for `session:` keys; without it every `session:` key call gets 409. */
  sessions?: GatewaySessions;
  /**
   * The Host and LAN rules of gateway sharing, read once per
   * request (`sharingAccess` of ./sharing.js). Absent: {@link LOOPBACK_ONLY}.
   */
  access?: () => GatewayAccess;
  /**
   * Access tokens of subscription accounts (`ProviderConfig.subscription`,
   * ./siwc.js). Without it their calls fail as `credential_unavailable`.
   */
  subscriptions?: SubscriptionTokens;
  /**
   * The Copilot client of each Copilot account (./copilot.js); the handler's
   * bridge owns the sessions and closes them in `close()`. Without it those
   * calls fail as `subscription_unavailable`.
   */
  copilot?: CopilotRuntime;
  /**
   * The user's gateway features (redaction, vision, web search), read for
   * each request; without it the defaults apply: redaction on without user
   * rules, no vision model, no search.
   */
  features?: () => GatewayFeatures;
  /**
   * Values this handler never resolves itself but must never send upstream
   * (the daemon's admin token); redaction replaces them like credentials.
   */
  secrets?: readonly string[];
  /**
   * Where the last allowance readings persist between runs (`smart` and
   * `pace`): loaded once at start, saved within a minute of a change and on
   * `close()`. Failures are logged. Without it readings live in memory only.
   */
  allowances?: {
    load(): Promise<StoredReading[]>;
    save(readings: StoredReading[]): Promise<void>;
  };
  /**
   * Where the Codex passthrough forwards `/backend-api/codex/*`. For tests
   * only, which point it at a loopback fake; the daemon leaves it unset and
   * requests go to ChatGPT's Codex backend.
   */
  codexBackend?: string;
  /**
   * Codex's model-list entries for the gateway's models, in order, with
   * priorities from `first` (the agents package's catalog, which global
   * wiring writes for Codex too). ChatGPT-mode Codex lists them after
   * ChatGPT's own; without it its list is ChatGPT's alone.
   */
  codexCatalog?(models: CodexListedModel[], first: number): unknown[];
  /**
   * Every request the gateway sends out (providers, search backends,
   * ChatGPT's Codex backend), through the daemon's proxy policy; global
   * `fetch` without it. The gateway's calls to itself stay on loopback.
   */
  fetch?: OutboundFetch;
}

/**
 * A raw Node request handler without a listener. Requests that
 * {@link isGatewayPath} does not accept are answered 404. The owner of the
 * listener applies `limits.requestHeadersTimeoutMs` as `server.headersTimeout`
 * and must await {@link GatewayHandler.close} before closing the store.
 */
export interface GatewayHandler {
  /** A request of the loopback listener: loopback peers with loopback (or public) Hosts. */
  (request: IncomingMessage, response: ServerResponse): void;
  /**
   * A request of the LAN listener of gateway sharing. Whatever the peer's
   * address, only `client:` keys with `allowLan` are accepted (403
   * `source_not_allowed` otherwise, and for every request while the access
   * rules say sharing is off), and the Host must be a declared LAN name or
   * the public host. The owner of that listener applies the same
   * `headersTimeout` and closes it after {@link GatewayHandler.close}.
   */
  lan(request: IncomingMessage, response: ServerResponse): void;
  /**
   * Stop accepting calls (new requests get 503 `gateway_closing`), abort
   * in-flight upstream requests, wait until every request ended and its
   * ledger entry was attempted, then flush throttled rejection counts.
   * Idempotent; every call returns the same promise.
   */
  close(): Promise<void>;
  /**
   * Resolves once no model call of the Session is in flight and every
   * finished call's entry was committed (or its commit failed). With
   * `abort`, in-flight calls are cancelled first (ledger 499
   * `client_cancelled`); calls that start meanwhile are waited for too.
   */
  awaitSessionIdle(
    sessionId: SessionId,
    options?: { abort?: boolean },
  ): Promise<void>;
  /**
   * Each credential's routing state as this handler holds it in memory:
   * breaker state, rest, last failure (class, status and time, never its
   * message) and allowance readings. Credentials with none are absent
   * (closed, nothing known). Read-only and cheap.
   */
  routingState(): CredentialRoutingState[];
  /**
   * A key's limits and what it used of its budgets now, from the ledger,
   * with the requests in flight that this handler holds reservations for;
   * undefined when the key does not exist. Rejects when the ledger cannot be
   * read.
   */
  keyLimit(keyId: GatewayKeyId): Promise<KeyLimitStatus | undefined>;
  /**
   * The latest routing decisions (`trace.ts`): each request to a route
   * group as a turn began, or that a rule moved within one, published
   * before the vendor is asked and again when its call ends. With
   * `query.wait`, waits up to 60 seconds for one after `query.after`, until
   * `signal` aborts or the handler closes. In memory only.
   */
  routeDecisions(
    query: RouteDecisionQuery,
    signal: AbortSignal,
  ): Promise<RouteDecisionPage>;
}

/** One credential's routing state (`GatewayHandler.routingState`). */
export interface CredentialRoutingState {
  provider: string;
  credential: string;
  state: "closed" | "open" | "half-open";
  /** ISO time an open breaker admits a probe again. */
  restingUntil?: string;
  /** The last counted failure: its class (`rate_limited`, `quota_exhausted`, …), HTTP status and time. */
  lastFailure?: { kind: string; status: number; at: string };
  /** The latest reading of each allowance window. */
  readings: AllowanceReading[];
}

function normalize(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}

/**
 * Whether the daemon should hand a path to the gateway: `/v1/*`, `/v1beta/*`,
 * `/v1alpha/*`, the OpenAI and Anthropic paths without `/v1`, and the Codex
 * passthrough `/backend-api/codex/*`.
 */
export function isGatewayPath(pathname: string): boolean {
  const path = normalize(pathname);
  return (
    isCodexPath(path) ||
    /^\/v1(?:beta|alpha)?(?:\/|$)/.test(path) ||
    /^\/(?:chat\/completions|responses(?:\/compact)?|messages(?:\/count_tokens)?|models(?:\/.*)?)$/.test(
      path,
    )
  );
}

type Route =
  | { kind: "models"; format: "openai" | "gemini"; id?: string }
  | { kind: "count"; protocol: "anthropic" | "gemini" }
  | { kind: "call"; call: CallRoute }
  | { kind: "images"; edit: boolean }
  | { kind: "compact" }
  | { kind: "limit" };

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new GatewayError(
      "Malformed model gateway route",
      400,
      "route_invalid",
    );
  }
}

function matchRoute(method: string | undefined, url: URL): Route | undefined {
  const path = normalize(url.pathname);
  const gemini =
    /^\/(v1beta|v1|v1alpha)\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(
      path,
    );
  if (gemini) {
    if (method !== "POST") return undefined;
    if (gemini[3] === "countTokens")
      return { kind: "count", protocol: "gemini" };
    const model = decode(gemini[2]!);
    return {
      kind: "call",
      call: {
        protocol: "gemini",
        gemini: {
          model,
          version: gemini[1]!,
          method: gemini[3] as "generateContent" | "streamGenerateContent",
          sse: url.searchParams.get("alt") === "sse",
        },
      },
    };
  }
  const listing = /^\/(?:v1beta|v1alpha)\/models(?:\/(.+))?$/.exec(path);
  if (listing)
    return method === "GET"
      ? {
          kind: "models",
          format: "gemini",
          ...(listing[1] ? { id: decode(listing[1]) } : {}),
        }
      : undefined;
  const openai = path.replace(/^\/v1(?=\/)/, "");
  if (method === "GET") {
    if (path === "/v1/harnesshub/limit") return { kind: "limit" };
    if (openai === "/models") return { kind: "models", format: "openai" };
    const one = /^\/models\/(.+)$/.exec(openai);
    return one
      ? { kind: "models", format: "openai", id: decode(one[1]!) }
      : undefined;
  }
  if (method !== "POST") return undefined;
  switch (openai) {
    case "/images/generations":
    case "/images/edits":
      return path.startsWith("/v1/")
        ? { kind: "images", edit: openai === "/images/edits" }
        : undefined;
    case "/chat/completions":
      return { kind: "call", call: { protocol: "chat" } };
    case "/responses":
      return { kind: "call", call: { protocol: "responses" } };
    case "/responses/compact":
      return { kind: "compact" };
    case "/messages":
      return { kind: "call", call: { protocol: "anthropic" } };
    case "/messages/count_tokens":
      return { kind: "count", protocol: "anthropic" };
    default:
      return undefined;
  }
}

function guessProtocol(pathname: string): WireProtocol {
  if (/\/messages(?:\/|$)/.test(pathname)) return "anthropic";
  if (/^\/+v1(?:beta|alpha)?\/models\/.+:/.test(pathname)) return "gemini";
  if (/^\/+v1(?:beta|alpha)\//.test(pathname)) return "gemini";
  if (/\/responses(?:\/compact)?\/?$/.test(pathname)) return "responses";
  return "chat";
}

function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  return plain === "::1" || (isIP(plain) === 4 && plain.startsWith("127."));
}
function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.replace(/:\d+$/, "");
  const lower = name.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    loopbackAddress(lower)
  );
}

type Authentication =
  | { ok: true; key: GatewayKeyRecord }
  | {
      ok: false;
      reason: "invalid_key" | "key_revoked" | "key_expired";
      message: string;
      key?: GatewayKeyRecord;
    };

interface ListedModel {
  id: string;
  /** Shown instead of the id, which is then an alias. */
  displayName?: string;
  owner: string;
  created: number;
  model?: ProviderModel;
  /** The reasoning levels offered, lowest first. */
  efforts?: readonly ReasoningEffort[];
  nativeEndpoints?: WireProtocol[];
}

function modelObject(entry: ListedModel): Record<string, unknown> {
  const model = entry.model;
  return {
    id: entry.id,
    object: "model",
    type: "model",
    created: entry.created,
    created_at: new Date(entry.created * 1000).toISOString(),
    owned_by: entry.owner,
    display_name: entry.displayName ?? entry.id,
    // The names OpenAI-compatible clients read a window from.
    ...(model?.contextWindow === undefined
      ? {}
      : {
          context_window: model.contextWindow,
          context_length: model.contextWindow,
          max_model_len: model.contextWindow,
        }),
    ...(model?.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: model.maxOutputTokens }),
    ...(model?.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(entry.efforts?.length
      ? { supported_reasoning_levels: entry.efforts }
      : {}),
    ...(model?.inputModalities === undefined
      ? {}
      : { input_modalities: model.inputModalities }),
    ...(entry.nativeEndpoints
      ? { native_endpoints: entry.nativeEndpoints }
      : {}),
  };
}
function geminiModel(entry: ListedModel): Record<string, unknown> {
  const model = entry.model;
  return {
    name: `models/${entry.id}`,
    displayName: entry.displayName ?? entry.id,
    ...(model?.contextWindow === undefined
      ? {}
      : { inputTokenLimit: model.contextWindow }),
    ...(model?.maxOutputTokens === undefined
      ? {}
      : { outputTokenLimit: model.maxOutputTokens }),
    ...(model?.reasoning === undefined ? {} : { thinking: model.reasoning }),
    supportedGenerationMethods: [
      "generateContent",
      "streamGenerateContent",
      "countTokens",
    ],
  };
}

/**
 * Headers of a quota refusal: a budget's reset time, and that SDKs should
 * not retry (they retry a 429 by themselves otherwise); `Retry-After` is set
 * with the error.
 */
export function refusalHeaders(refusal: QuotaRefusal): Record<string, string> {
  return {
    "x-should-retry": "false",
    ...(refusal.resetsAt ? { "x-hh-limit-reset": refusal.resetsAt } : {}),
  };
}

/**
 * Stickiness of a call: the group's setting, `auto` for a single Model Ref;
 * `session:` keys keep their whole Session on one credential where the
 * setting is `auto`.
 */
function stickiness(
  group: RouteGroup | undefined,
  key: GatewayKeyRecord,
): Stickiness {
  const mode = group?.stickiness ?? "auto";
  return key.scope.kind === "session" && mode === "auto" ? "session" : mode;
}

/**
 * Create the shared gateway handler. Upstream requests happen only for
 * authenticated, allowed model calls; listing and token counting never
 * contact an upstream. See docs/model-gateway.md for the full behaviour.
 */
export function createGatewayHandler(deps: GatewayHandlerDeps): GatewayHandler {
  const { store, clock, limits } = deps;
  const log = deps.log ?? NO_LOG;
  const shutdown = new AbortController();
  const tasks = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const throttle = new RejectionThrottle(clock);
  const redactor = new Redactor();
  for (const secret of deps.secrets ?? [])
    redactor.remember(secret, "ADMIN_TOKEN");
  /** In-flight model calls of `session:` keys, per Session. */
  const sessionCalls = new Map<
    SessionId,
    Map<Promise<void>, AbortController>
  >();
  const touched = new Map<GatewayKeyId, number>();
  const credentialSlots = new Map<string, Slots>();
  const nonce = randomBytes(4).toString("hex");
  let generated = 0;
  const services: CallServices = {
    store,
    resolveSecret: deps.resolveSecret,
    clock,
    limits,
    log,
    breakers: new Breakers(clock, (change) =>
      log.info("gateway.breaker", { ...change }),
    ),
    router: new Router(clock),
    memory: new MemoryBudget(limits.maxInflightRequestBytes),
    slots(candidate: Candidate): Slots {
      const name = `${candidate.provider.id}\u0000${candidate.credential.id}`;
      // The provider's own limits (Magpie's maxConcurrency), else the gateway's.
      const own = candidate.provider.limits;
      const limit =
        own?.concurrentPerCredential ?? limits.maxConcurrentPerCredential;
      const queue = own?.queuePerCredential ?? limits.maxQueuedPerCredential;
      let slots = credentialSlots.get(name);
      if (!slots) {
        slots = new Slots(
          limit,
          queue,
          `Too many concurrent requests on credential ${candidate.credential.id} of ${candidate.provider.id}`,
        );
        credentialSlots.set(name, slots);
      } else slots.configure(limit, queue);
      return slots;
    },
    reasoning: new ReasoningCaches(limits),
    sticky: new StickyRoutes(clock),
    quotas: new Quotas(store, clock, deps.timeZone),
    ...(deps.subscriptions ? { subscriptions: deps.subscriptions } : {}),
    ...(deps.copilot
      ? { copilot: new CopilotBridge(deps.copilot, clock) }
      : {}),
    redactor,
    features: deps.features ?? (() => DEFAULT_GATEWAY_FEATURES),
    vision: new VisionDescriber(),
    makeId: () => `call_${nonce}${(generated++).toString(36)}`,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    resolveModel: (model, key) => resolveModel(model, key),
    async commit(entry: ModelCallEntry): Promise<boolean> {
      try {
        await store.appendModelCall(entry);
        services.quotas.record(entry);
        if (entry.scope?.kind === "session" && deps.sessions?.committed)
          try {
            deps.sessions.committed(entry);
          } catch (error) {
            log.info("gateway.session.observer_failed", {
              callId: entry.callId,
              error:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : "unknown",
            });
          }
        return true;
      } catch (error) {
        log.info("gateway.ledger.failed", {
          callId: entry.callId,
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
        // The upstream may have answered (and billed): the key's budgets count it anyway.
        services.quotas.unrecorded(entry);
        return false;
      }
    },
  };

  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };
  // The latest routing decisions, for the console to show why a turn went where it did.
  const trace = new DecisionTrace(clock);
  // Route group rules and their classifier, which asks through this gateway.
  const groupRules = new GroupRules(clock, new Classifier(clock));
  // `least-used` starts from the ledger's recent calls (bounded).
  track(services.router.seed(store, log));
  const allowances = deps.allowances;
  const failed = (event: string) => (error: unknown) =>
    log.info(event, {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  const saveReadings = () =>
    allowances && services.router.takeChanges()
      ? allowances
          .save(services.router.snapshot())
          .catch(failed("gateway.allowances.save_failed"))
      : Promise.resolve();
  let saver: NodeJS.Timeout | undefined;
  if (allowances) {
    track(
      allowances
        .load()
        .then((stored) => services.router.restore(stored))
        .catch(failed("gateway.allowances.load_failed")),
    );
    saver = setInterval(() => track(saveReadings()), 60_000);
    saver.unref();
  }

  const baseEntry = (
    protocol: WireProtocol,
    path: string,
    occurredAt: number,
    key: GatewayKeyRecord | undefined,
    userAgent: string | undefined,
  ): ModelCallEntry => {
    const agent = agentOf(key?.scope, userAgent);
    return {
      callId: `mc_${randomUUID().replaceAll("-", "")}` as ModelCallId,
      occurredAt: new Date(occurredAt).toISOString(),
      ...(key
        ? {
            keyId: key.keyId,
            scope: key.scope,
            ...(key.scope.kind === "session"
              ? { sessionId: key.scope.sessionId }
              : {}),
          }
        : {}),
      ...(agent ? { agent } : {}),
      inbound: { protocol, path: path.slice(0, 200), stream: false },
      patches: [],
      unmapped: [],
      status: 0,
      timing: { durationMs: 0 },
      attempts: [],
      cost: null,
    };
  };

  const reply = async (
    response: ServerResponse,
    protocol: WireProtocol,
    value: Failure,
    retryAfterMs?: number,
    headers: Record<string, string> = {},
  ) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.setHeader("x-hh-error-source", "gateway");
    for (const [name, header] of Object.entries(headers))
      response.setHeader(name, header);
    if (retryAfterMs !== undefined)
      response.setHeader(
        "retry-after",
        String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      );
    const { status, body } = errorResponse(protocol, value, retryAfterMs);
    await new HttpWriter(response).json(status, body).catch(() => {
      response.destroy();
    });
  };

  const reject = async (
    response: ServerResponse,
    entry: ModelCallEntry,
    reason: string,
    value: Failure,
    started: number,
    retryAfterMs?: number,
    headers?: Record<string, string>,
  ) => {
    entry.status = value.status;
    entry.errorClass = reason;
    entry.errorSource = "gateway";
    entry.error = value.message;
    entry.rejected = true;
    entry.rejectReason = reason;
    entry.timing.durationMs = Math.round(performance.now() - started);
    for (const record of throttle.admit(entry.keyId, reason, entry))
      await services.commit(record);
    await reply(response, entry.inbound.protocol, value, retryAfterMs, headers);
  };

  /** USD per million input tokens of a Model Ref asked for; undefined for a group or an unpriced model. */
  const inputPrice = async (requested: string) => {
    const parsed = parseModelRef(requested);
    if (parsed?.kind !== "model") return undefined;
    const provider = await store.getProvider(parsed.provider);
    return provider?.models.list.find((model) => model.id === parsed.model)
      ?.price?.input;
  };

  /**
   * The Gateway Key a request presents: in its headers, Gemini's `?key=`,
   * or `keyed`, the key segment of a path under `/k/` (ADR 0033), which
   * must have a key's form.
   */
  const authenticate = async (
    request: IncomingMessage,
    url: URL,
    gemini: boolean,
    keyed?: { key?: string },
  ): Promise<Authentication> => {
    const presented: string[] = [];
    if (keyed) {
      if (keyed.key === undefined)
        return {
          ok: false,
          reason: "invalid_key",
          message: "The path does not hold a HarnessHub Gateway Key",
        };
      presented.push(keyed.key);
    }
    const authorization = request.headers.authorization;
    if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization))
      presented.push(authorization.replace(/^Bearer\s+/i, "").trim());
    for (const name of ["x-api-key", "x-goog-api-key"]) {
      const value = request.headers[name];
      if (typeof value === "string") presented.push(value.trim());
    }
    if (gemini) presented.push(...url.searchParams.getAll("key"));
    if (!presented.length)
      return {
        ok: false,
        reason: "invalid_key",
        message: "A HarnessHub Gateway Key is required",
      };
    if (new Set(presented).size > 1)
      return {
        ok: false,
        reason: "invalid_key",
        message: "The request carries different credentials",
      };
    return verifyKey(presented[0]!);
  };

  /** The Gateway Key `text` names, when it is valid, active and unexpired. */
  const verifyKey = async (text: string): Promise<Authentication> => {
    const parsed = parseGatewayKey(text);
    if (!parsed)
      return {
        ok: false,
        reason: "invalid_key",
        message: "The credential is not a HarnessHub Gateway Key",
      };
    const key = await store.getGatewayKey(parsed.keyId);
    if (
      !key ||
      key.scope.kind !== parsed.scope ||
      !gatewayKeyMatches(key, parsed.secret)
    )
      return {
        ok: false,
        reason: "invalid_key",
        message: "Unknown HarnessHub Gateway Key",
      };
    if (key.revokedAt !== undefined)
      return {
        ok: false,
        reason: "key_revoked",
        message: "This Gateway Key was revoked",
        key,
      };
    if (key.expiresAt !== undefined && Date.parse(key.expiresAt) <= clock())
      return {
        ok: false,
        reason: "key_expired",
        message: "This Gateway Key has expired",
        key,
      };
    return { ok: true, key };
  };

  /** Touch at most once a minute per key; failures are only logged. */
  const touch = (key: GatewayKeyRecord) => {
    const now = clock();
    if (now - (touched.get(key.keyId) ?? -Infinity) < 60_000) return;
    touched.set(key.keyId, now);
    if (touched.size > 10_000) touched.clear();
    track(
      store
        .touchGatewayKey(key.keyId, new Date(now).toISOString())
        .catch((error: unknown) =>
          log.info("gateway.key.touch_failed", {
            keyId: key.keyId,
            error:
              error instanceof Error ? error.message.slice(0, 200) : "unknown",
          }),
        ),
    );
  };

  const visibleModels = async (
    key: GatewayKeyRecord,
    session?: ActiveSessionRun,
  ): Promise<ListedModel[]> => {
    const [providers, userGroups, hidden] = await Promise.all([
      store.listProviders(),
      store.listRouteGroups(),
      store.listHiddenAutoGroups(),
    ]);
    // Automatic groups after the user's, which take their IDs first.
    const groups = [
      ...userGroups,
      ...autoGroups(providers, {
        hidden,
        taken: userGroups.map((group) => group.id),
      })
        .filter((group) => !group.hidden)
        .map(autoRouteGroup),
    ];
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const metadata = (ref: ModelRef) => {
      const parsed = parseModelRef(ref);
      if (parsed?.kind !== "model") return undefined;
      return byId
        .get(parsed.provider)
        ?.models.list.find((model) => model.id === parsed.model);
    };
    const byGroup = new Map(groups.map((group) => [group.id, group]));
    /** A group as one model: what its models share, and what its rules make reachable (core `ruledCapabilities`). */
    const describeGroup = (
      group: RouteGroup | undefined,
    ): Pick<ListedModel, "model" | "efforts"> => {
      const capabilities = ruledCapabilities(
        group ?? { members: [] },
        group
          ? groupModels(
              group,
              (id) => byGroup.get(id),
              (provider, model) =>
                byId
                  .get(provider)
                  ?.models.list.some((entry) => entry.id === model) ?? false,
            )
          : [],
        metadata,
      );
      const { efforts, ...model } = capabilities;
      return { model: { id: "", ...model }, efforts };
    };
    const listed: ListedModel[] = [];
    if (session) {
      // The alias a Session's engine was configured with, described as its Run's target.
      const target = parseModelRef(session.target);
      const group =
        target?.kind === "group"
          ? groups.find((entry) => entry.id === target.group)
          : undefined;
      const model = metadata(session.target as ModelRef);
      listed.push({
        id: HARNESS_MODEL_ALIAS,
        owner: "harnesshub",
        created: 0,
        ...(target?.kind === "group"
          ? describeGroup(group)
          : {
              model: model ?? { id: HARNESS_MODEL_ALIAS },
              efforts: modelEfforts(model),
            }),
      });
    }
    for (const provider of providers) {
      // Subscription accounts serve agents on this computer only.
      if (provider.subscription && key.allowLan === true) continue;
      const exposed =
        provider.models.expose === "all"
          ? provider.models.list
          : provider.models.list.filter((model) =>
              (provider.models.expose as string[]).includes(model.id),
            );
      for (const model of exposed) {
        const id = `${provider.id}/${model.id}`;
        if (
          !modelAllowed(key.modelAllow, id, key.modelDeny) &&
          id !== session?.target
        )
          continue;
        listed.push({
          id,
          owner: provider.id,
          created: Math.floor(Date.parse(provider.createdAt) / 1000) || 0,
          model,
          efforts: modelEfforts(model),
          nativeEndpoints: provider.translateOnly
            ? []
            : (Object.keys(provider.endpoints) as WireProtocol[]),
        });
      }
    }
    for (const group of groups) {
      const id = `group/${group.id}`;
      if (
        !modelAllowed(key.modelAllow, id, key.modelDeny) &&
        id !== session?.target
      )
        continue;
      listed.push({
        id,
        owner: "harnesshub",
        created: Math.floor(Date.parse(group.createdAt) / 1000) || 0,
        ...describeGroup(group),
      });
    }
    return listed;
  };

  /**
   * A key with `modelIdStyle: claude-alias` (a client that keeps only
   * Anthropic-looking ids) sees each model by its alias and names it so;
   * the Model Ref is its display name.
   */
  const shownAs = (
    key: GatewayKeyRecord,
    listed: ListedModel[],
  ): ListedModel[] =>
    key.modelIdStyle === "claude-alias"
      ? listed.map((entry) => ({
          ...entry,
          id: claudeModelAlias(entry.id),
          displayName: entry.id,
        }))
      : listed;

  /** The Model Ref an alias of a `claude-alias` key stands for; any other name as it is. */
  const unaliased = async (
    key: GatewayKeyRecord,
    named: unknown,
  ): Promise<unknown> => {
    if (
      key.modelIdStyle !== "claude-alias" ||
      typeof named !== "string" ||
      parseModelRef(named)
    )
      return named;
    const alias = named.replace(/\[1m\]$/, "");
    return (
      (await visibleModels(key)).find(
        (entry) => claudeModelAlias(entry.id) === alias,
      )?.id ?? named
    );
  };

  const listModels = async (
    response: ServerResponse,
    key: GatewayKeyRecord,
    route: Extract<Route, { kind: "models" }>,
  ) => {
    const listed = shownAs(
      key,
      await visibleModels(
        key,
        key.scope.kind === "session"
          ? deps.sessions?.activeRun(key.scope.sessionId)
          : undefined,
      ),
    );
    const writer = new HttpWriter(response);
    if (route.id !== undefined) {
      const found = listed.find((entry) => entry.id === route.id);
      if (!found) {
        await reply(
          response,
          route.format === "gemini" ? "gemini" : "chat",
          failure(404, "model_not_found", "Unknown or not allowed model"),
        );
        return;
      }
      await writer.json(
        200,
        route.format === "gemini" ? geminiModel(found) : modelObject(found),
      );
      return;
    }
    await writer.json(
      200,
      route.format === "gemini"
        ? { models: listed.map(geminiModel) }
        : {
            object: "list",
            data: listed.map(modelObject),
            has_more: false,
            first_id: listed[0]?.id ?? null,
            last_id: listed.at(-1)?.id ?? null,
          },
    );
  };

  /**
   * Muse Code's model list (./muse.js). Muse asks for it on its endpoint's
   * host, without the endpoint's path and so without the key in it, and
   * sends no credential: it lists the models of the newest active
   * `agent:muse` key, to loopback connections only. Calls still need the
   * key (ADR 0033).
   */
  const museModels = async (
    request: IncomingMessage,
    response: ServerResponse,
    listener: "loopback" | "lan",
  ) => {
    request.resume();
    const refuse = (status: number, reason: string, message: string) =>
      reply(response, "chat", failure(status, reason, message));
    if (listener === "lan" || !loopbackAddress(request.socket.remoteAddress))
      return refuse(
        403,
        "source_not_allowed",
        "Muse Code's model list is served to loopback connections only",
      );
    if (
      request.headers.origin !== undefined ||
      request.headers["sec-fetch-site"] === "cross-site" ||
      !loopbackHost(request.headers.host)
    )
      return refuse(
        403,
        "origin_forbidden",
        "Browser requests are not accepted",
      );
    if (request.method !== "GET")
      return refuse(404, "route_not_found", "Unsupported model gateway route");
    const now = clock();
    const key = (await store.listGatewayKeys())
      .filter(
        (candidate) =>
          candidate.scope.kind === "agent" &&
          candidate.scope.adapterId === "muse" &&
          candidate.revokedAt === undefined &&
          (candidate.expiresAt === undefined ||
            Date.parse(candidate.expiresAt) > now),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!key)
      return refuse(
        404,
        "route_not_found",
        "Muse Code is not wired to this gateway",
      );
    await new HttpWriter(response).json(
      200,
      museModelList(shownAs(key, await visibleModels(key))),
    );
  };

  /**
   * The native Anthropic candidate that may count an Anthropic request: the
   * model resolved as for a call (a Session's alias to its Run's target),
   * allowed for the key, and the first member, in configured order, whose
   * provider passes Anthropic through and whose breaker is not open.
   */
  const countCandidate = async (
    key: GatewayKeyRecord,
    raw: Record<string, unknown>,
  ): Promise<Candidate | undefined> => {
    const session =
      key.scope.kind === "session"
        ? deps.sessions?.activeRun(key.scope.sessionId)
        : undefined;
    if (key.scope.kind === "session" && !session) return undefined;
    const named = await unaliased(key, raw.model);
    const requested =
      session &&
      (typeof named !== "string" ||
        named === HARNESS_MODEL_ALIAS ||
        !parseModelRef(named))
        ? session.target
        : named;
    if (typeof requested !== "string" || !requested) return undefined;
    let target: string;
    try {
      target = await resolveModel(requested, key);
    } catch (error) {
      if (error instanceof GatewayError) return undefined;
      throw error;
    }
    if (
      !modelAllowed(key.modelAllow, target, key.modelDeny) &&
      target !== session?.target
    )
      return undefined;
    let resolved: CallPlan;
    try {
      // Configured order: counting must not advance a group's rotation.
      resolved = await plan(target, "anthropic", (group) => group.members);
    } catch (error) {
      if (error instanceof GatewayError) return undefined;
      throw error;
    }
    return resolved.candidates.find(
      (candidate) =>
        candidate.mode === "passthrough" &&
        candidate.upstream === "anthropic" &&
        !services.breakers.blocked(candidate),
    );
  };

  const countTokens = async (
    request: IncomingMessage,
    response: ServerResponse,
    protocol: "anthropic" | "gemini",
    key: GatewayKeyRecord,
  ) => {
    const bytes = await readBody(request, {
      maxBytes: limits.maxRequestBytes,
      timeoutMs: limits.requestBodyTimeoutMs,
      signal: shutdown.signal,
      memory: services.memory,
    });
    const abort = new AbortController();
    const onClose = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.once("close", onClose);
    try {
      const raw = parseJsonBody(bytes);
      if (protocol === "anthropic") {
        const candidate = await countCandidate(key, object(raw));
        const forwarded =
          candidate &&
          (await forwardCountTokens({
            candidate,
            bytes,
            raw: object(raw),
            headers: request.headers,
            services,
            signal: AbortSignal.any([shutdown.signal, abort.signal]),
          }));
        if (forwarded) {
          response.setHeader(
            "x-hh-token-count",
            forwarded.estimated ? "estimated" : "upstream",
          );
          await new HttpWriter(response).json(200, forwarded.body);
          return;
        }
      }
      const counted =
        protocol === "anthropic"
          ? anthropicCountTokens(raw)
          : { totalTokens: estimateTokens(object(raw)) };
      response.setHeader("x-hh-token-count", "estimated");
      await new HttpWriter(response).json(200, counted);
    } finally {
      response.removeListener("close", onClose);
      services.memory.give(bytes.length);
    }
  };

  /** Resolve the requested Model Ref or group to candidates; 404 when it names nothing. */
  const plan = async (
    requested: string,
    protocol: WireProtocol,
    order: (group: RouteGroup) => readonly string[] = (group) =>
      services.router.order(group),
  ): Promise<CallPlan & { group?: RouteGroup }> => {
    const parsed = parseModelRef(requested);
    if (!parsed)
      throw new GatewayError(
        "The model must be a Model Ref (provider/model) or group/<id>",
        400,
        "model_invalid",
      );
    const notFound = () =>
      new GatewayError(
        `Unknown model ${requested.slice(0, 200)}`,
        404,
        "model_not_found",
      );
    if (parsed.kind === "model") {
      const provider = await store.getProvider(parsed.provider);
      if (!provider) throw notFound();
      return modelCandidates(provider, parsed.model, protocol);
    }
    const find = async (id: RouteGroupId) =>
      (await store.getRouteGroup(id)) ??
      (id.startsWith(AUTO_GROUP_PREFIX) ? await autoGroup(id) : undefined);
    const group = await find(parsed.group);
    if (!group) throw notFound();
    const { candidates, skipped, groups } = await planGroup(group, protocol, {
      provider: (id) => store.getProvider(id),
      group: find,
      order,
      weigh: async (weighed, list) => {
        if (weighed.strategy === "least-used")
          await services.router.seed(store, log);
        return services.router.weigh(weighed, list);
      },
      blocked: (candidate) => services.breakers.blocked(candidate),
    });
    return { candidates, group, groups, skipped };
  };

  /**
   * The Model Ref or `group/<id>` a request's model names: itself, or what
   * a bare name resolves to (./bare-names.ts), before the key's allowlist
   * is applied to it.
   *
   * @throws GatewayError 400 `model_ambiguous` when several providers'
   *   models have the name (the message names those the key may use), 404
   *   `model_not_found` when nothing has it.
   */
  const resolveModel = async (
    model: string,
    key: GatewayKeyRecord,
  ): Promise<string> => {
    if (parseModelRef(model)) return model;
    const shown = model.slice(0, 200);
    const found = await resolveBareName(model, store);
    if (found.kind === "resolved") return found.ref;
    if (found.kind === "none")
      throw new GatewayError(
        `No route group or model is named ${shown}; name one as provider/model or group/<id>`,
        404,
        "model_not_found",
      );
    const usable = found.refs.filter((ref) =>
      modelAllowed(key.modelAllow, ref, key.modelDeny),
    );
    const others = found.refs.length - usable.length;
    throw new GatewayError(
      `${shown} names more than one model${usable.length ? `: ${usable.join(", ")}` : ""}${others ? `${usable.length ? ", and" : ","} ${others} this Gateway Key may not use` : ""}; name one as provider/model`,
      400,
      "model_ambiguous",
    );
  };

  /** The automatic group of this ID, unless it is hidden; user groups were looked up first. */
  const autoGroup = async (
    id: RouteGroupId,
  ): Promise<RouteGroup | undefined> => {
    const [providers, groups, hidden] = await Promise.all([
      store.listProviders(),
      store.listRouteGroups(),
      store.listHiddenAutoGroups(),
    ]);
    const found = autoGroups(providers, {
      hidden,
      taken: groups.map((group) => group.id),
    }).find((group) => group.id === id && !group.hidden);
    return found && autoRouteGroup(found);
  };

  /**
   * Keep the candidates of the credential an `X-HH-Credential` header names
   * (Magpie `X-Magpie-Account`): by ID, or by name without regard to case,
   * across every member of a group. Nothing else is tried in its place: 429
   * `credential_resting` while every match rests, 400 `credential_unserved`
   * when the credential exists (enabled) but serves no candidate of this
   * model, its provider not listing the model included, and 404
   * `credential_not_found` when no enabled credential matches.
   */
  const pinCredential = async (
    pin: string,
    requested: string,
    candidates: Candidate[],
  ): Promise<{ candidates: Candidate[] } | { error: AttemptError }> => {
    const matches = (credential: ProviderCredential) =>
      credential.id === pin ||
      credential.name.toLowerCase() === pin.toLowerCase();
    const label = JSON.stringify(pin.slice(0, 100));
    const local = (status: number, code: string, message: string) => ({
      error: {
        failure: failure(status, code, `X-HH-Credential: ${message}`),
        errorClass: code,
        source: "gateway" as const,
        phase: "local" as const,
      },
    });
    const matched = candidates.filter((candidate) =>
      matches(candidate.credential),
    );
    const serving = matched.filter(
      (candidate) =>
        candidate.model !== undefined ||
        candidate.provider.models.list.length === 0,
    );
    if (serving.length) {
      const rests = serving.map((candidate) =>
        services.breakers.restOf(candidate),
      );
      if (!rests.every((rest) => rest !== undefined))
        return { candidates: serving };
      const next = rests.reduce((soonest, rest) =>
        rest.until < soonest.until ? rest : soonest,
      );
      const resting = local(
        429,
        "credential_resting",
        `credential ${label} rests until ${new Date(next.until).toISOString()} (${next.reason}); no other credential is tried in its place`,
      );
      return {
        error: {
          ...resting.error,
          retryAfterMs: Math.max(0, next.until - clock()),
        },
      };
    }
    const exists =
      matched.length > 0 ||
      (await store.listProviders()).some((provider) =>
        provider.credentials.some(
          (credential) => credential.enabled && matches(credential),
        ),
      );
    if (exists)
      return local(
        400,
        "credential_unserved",
        `credential ${label} does not serve ${requested.slice(0, 200)}`,
      );
    const names = [
      ...new Set(
        candidates.map(
          (candidate) =>
            `${candidate.provider.id}/${candidate.credential.name}`,
        ),
      ),
    ].slice(0, 20);
    return local(
      404,
      "credential_not_found",
      `no enabled credential ${label}; ${requested.slice(0, 200)} is served by ${names.length ? names.join(", ") : "no credential"}`,
    );
  };

  const modelCall = async (
    request: IncomingMessage,
    response: ServerResponse,
    route: CallRoute,
    key: GatewayKeyRecord,
    entry: ModelCallEntry,
    started: number,
    abort: AbortController,
    session: ActiveSessionRun | undefined,
    internal?: CallPurpose,
    preread?: Buffer,
  ) => {
    let disconnected = false;
    const closed = new Promise<void>((resolve) =>
      response.once("close", () => resolve()),
    );
    const onClose = () => {
      if (response.writableFinished) return;
      disconnected = true;
      abort.abort();
    };
    response.once("close", onClose);
    const onShutdown = () => abort.abort();
    shutdown.signal.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.signal.aborted) abort.abort();
    const writer = new HttpWriter(response);
    let reserved = 0;
    let release = () => {};
    let call: Call | undefined;
    const answer = async (error: unknown) => {
      const stub: Call = call ?? {
        services,
        request,
        response,
        route,
        key,
        entry,
        started,
        signal: abort.signal,
        closed,
        disconnected: () => disconnected,
        writer,
        bytes: Buffer.alloc(0),
        raw: {},
        requested: entry.requestedModel ?? "",
        stream: entry.inbound.stream,
        routePatches: [],
      };
      if (abort.signal.aborted) {
        await publishFailure(stub, {
          failure: failure(499, "cancelled", "Model call was cancelled"),
          errorClass: disconnected ? "engine_disconnected" : "client_cancelled",
          source: "gateway",
          phase: "cancelled",
        });
        return;
      }
      if (!(error instanceof GatewayError))
        log.info("gateway.call.internal_error", {
          callId: entry.callId,
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      const value =
        error instanceof GatewayError
          ? failure(error.status, error.code, error.message)
          : failure(500, "gateway_error", "Model gateway internal error");
      await publishFailure(stub, {
        failure: value,
        errorClass: value.code,
        source: "gateway",
        phase: "local",
      });
    };
    // A body read already comes with its memory reserved.
    reserved = preread?.length ?? 0;
    try {
      const bytes =
        preread ??
        (await readBody(request, {
          maxBytes: limits.maxRequestBytes,
          timeoutMs: limits.requestBodyTimeoutMs,
          signal: abort.signal,
          memory: services.memory,
        }));
      reserved = bytes.length;
      const raw = object(parseJsonBody(bytes));
      const asked = route.gemini?.model ?? raw.model;
      const stream =
        route.gemini !== undefined
          ? route.gemini.method === "streamGenerateContent"
          : raw.stream === true;
      entry.inbound.stream = stream;
      if (typeof asked === "string" && asked)
        entry.requestedModel = asked.slice(0, 256);
      const named = await unaliased(key, asked);
      // A Session's engine names the alias, or any model name of its own;
      // both mean the target the Run selected.
      const given =
        session &&
        (typeof named !== "string" ||
          named === HARNESS_MODEL_ALIAS ||
          !parseModelRef(named))
          ? session.target
          : named;
      if (typeof given !== "string" || !given)
        throw new GatewayError("The request requires a model");
      // A bare name is what it resolves to from here on; the ledger keeps
      // the name as requested and records the group or model.
      const requested = await resolveModel(given, key);
      if (requested !== given) {
        const target = parseModelRef(requested);
        if (target?.kind === "group") entry.group = target.group;
        else if (target) entry.modelRef = target.ref;
      }
      if (
        route.protocol === "chat" &&
        raw.n !== undefined &&
        raw.n !== null &&
        raw.n !== 1
      )
        throw new GatewayError(
          "Only one completion choice (n = 1) is supported",
        );
      if (
        !modelAllowed(key.modelAllow, requested, key.modelDeny) &&
        requested !== session?.target
      ) {
        await reject(
          response,
          entry,
          "model_not_allowed",
          failure(
            403,
            "model_not_allowed",
            `This Gateway Key may not use ${requested.slice(0, 200)}${requested !== given ? ` (what ${given.slice(0, 100)} names here)` : ""}`,
          ),
          started,
        );
        return;
      }
      let admission: Admission;
      try {
        admission = await services.quotas.admit(key, {
          bytes: bytes.length,
          inputPrice: () => inputPrice(requested),
        });
      } catch (error) {
        log.info("gateway.store.unavailable", {
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
        throw new GatewayError(
          "Gateway Key usage cannot be read",
          503,
          "store_unavailable",
        );
      }
      if (!admission.ok) {
        await reject(
          response,
          entry,
          "quota_exceeded",
          failure(429, "quota_exceeded", admission.refusal.message),
          started,
          admission.refusal.retryAfterMs,
          refusalHeaders(admission.refusal),
        );
        return;
      }
      release = admission.release;
      const resolved = await plan(requested, route.protocol);
      if (key.allowLan === true) {
        // Subscription accounts serve agents on this computer only (ADR-P09).
        const local = resolved.candidates.filter(
          (candidate) => !candidate.provider.subscription,
        );
        if (local.length < resolved.candidates.length)
          resolved.skipped.push(
            "subscription accounts serve agents on this computer only, not keys usable from the local network",
          );
        resolved.candidates = local;
      }
      const parsed = parseModelRef(requested);
      if (parsed?.kind === "group") entry.group = parsed.group;
      const conversation = conversationOf(
        route.protocol,
        raw,
        request.headers,
        key.keyId,
      );
      entry.conversationKey = conversation.key;
      const routePatches: string[] = [];
      // A call the gateway makes for itself makes none in turn.
      const internals = internal ? undefined : internalCalls(key, entry);
      call = {
        services,
        request,
        response,
        route,
        key,
        entry,
        started,
        signal: abort.signal,
        closed,
        disconnected: () => disconnected,
        writer,
        bytes,
        raw,
        requested,
        shownModel: typeof named === "string" && named ? named : requested,
        stream,
        conversation,
        routePatches,
        ...(internal ? { internal } : {}),
        ...(internals ? { internals } : {}),
      };
      // The pin header is read here only; no header of the client but a
      // fixed few is ever sent upstream (upstreamHeaders).
      const pin = request.headers["x-hh-credential"];
      if (typeof pin === "string" && pin.trim()) {
        const pinned = await pinCredential(
          pin.trim(),
          requested,
          resolved.candidates,
        );
        if ("error" in pinned) {
          await publishFailure(call, pinned.error);
          return;
        }
        resolved.candidates = pinned.candidates;
        routePatches.push("credential:pinned");
      }
      const sticky = services.sticky.apply(
        conversation,
        requested,
        stickiness(resolved.group, key),
        resolved.candidates,
        (candidate) => services.breakers.blocked(candidate),
      );
      resolved.candidates = sticky.candidates;
      const ruled = resolved.group
        ? await applyRules({
            rules: groupRules,
            group: resolved.group,
            groups: resolved.groups ?? new Map(),
            candidates: resolved.candidates,
            protocol: route.protocol,
            raw,
            conversation: conversation.key,
            ...(entry.agent ? { agent: entry.agent.id } : {}),
            timeZone: services.quotas.timeZone,
            ...(internals ? { internal: internals } : {}),
            signal: abort.signal,
            stuck: sticky.patch === "sticky:hit",
            blocked: (candidate) => services.breakers.blocked(candidate),
          })
        : undefined;
      const stuck = ruled?.brokeSticky ? "sticky:broken:rule" : sticky.patch;
      if (stuck) routePatches.push(stuck);
      if (ruled) {
        resolved.candidates = ruled.candidates;
        routePatches.push(...ruled.patches);
        call.rules = { compact: ruled.compact, answered: ruled.answered };
      }
      // A group's decision as a turn begins, or as a rule moves it.
      const first = ruled?.decisions[0]?.kind;
      const decision =
        resolved.group && !internal
          ? (
              first
                ? first !== "held" && first !== "waits"
                : !conversation.withinTurn
            )
            ? trace.publish({
                callId: entry.callId,
                ...(entry.keyId ? { keyId: entry.keyId } : {}),
                ...(entry.agent ? { agent: entry.agent.id } : {}),
                conversation: conversation.key,
                ...(key.scope.kind === "session"
                  ? { sessionId: key.scope.sessionId }
                  : {}),
                requested,
                ...(ruled ? { turn: ruled.turn, tokens: ruled.tokens } : {}),
                rules: ruled?.decisions ?? [],
                ...(ruled?.pick ? { effort: ruled.pick } : {}),
                ...(stuck ? { sticky: stuck.slice("sticky:".length) } : {}),
                candidates: resolved.candidates,
              })
            : undefined
          : undefined;
      try {
        await routeCall(call, resolved);
        if (decision)
          trace.finish(
            decision,
            entry.status,
            (entry.status ?? 500) < 400
              ? resolved.candidates.find(
                  (candidate) =>
                    candidate.provider.id === entry.provider &&
                    candidate.credential.id === entry.credentialId &&
                    candidate.ref === entry.modelRef,
                )
              : undefined,
          );
      } catch (error) {
        if (decision) trace.finish(decision, entry.status, undefined);
        if (writer.sent) {
          log.info("gateway.call.internal_error", {
            callId: entry.callId,
            error:
              error instanceof Error ? error.message.slice(0, 200) : "unknown",
          });
          response.destroy();
          return;
        }
        throw error;
      }
    } catch (error) {
      await answer(error);
    } finally {
      // The entry was committed (or its commit failed) before this point.
      release();
      services.memory.give(reserved);
      response.removeListener("close", onClose);
      shutdown.signal.removeEventListener("abort", onShutdown);
      abort.abort();
    }
  };

  /**
   * The Codex passthrough (./codex.js). No Gateway Key is involved, so only
   * the loopback listener serves it, to loopback peers that name a loopback
   * Host and send no Origin; anything else is refused with 403 and a
   * rejection record, as for keyed routes.
   */
  /**
   * A model call with an authenticated key: a `session:` key's only while
   * its Session has an active Run (409 `no_active_run` otherwise), and then
   * cancelled with that Run. `preread` is the body, already read with its
   * memory reserved.
   */
  const callRoute = async (
    request: IncomingMessage,
    response: ServerResponse,
    route: CallRoute,
    key: GatewayKeyRecord,
    entry: ModelCallEntry,
    started: number,
    preread?: Buffer,
  ) => {
    entry.inbound.protocol = route.protocol;
    let session: ActiveSessionRun | undefined;
    if (key.scope.kind === "session") {
      session = deps.sessions?.activeRun(key.scope.sessionId);
      if (!session) {
        if (preread) services.memory.give(preread.length);
        await reject(
          response,
          entry,
          "no_active_run",
          failure(
            409,
            "no_active_run",
            "No active Run owns this Session's model request",
          ),
          started,
        );
        return;
      }
      entry.runId = session.runId;
      entry.generation = session.generation;
    }
    const abort = new AbortController();
    const task = modelCall(
      request,
      response,
      route,
      key,
      entry,
      started,
      abort,
      session,
      undefined,
      preread,
    );
    if (key.scope.kind === "session") {
      const id = key.scope.sessionId;
      const calls = sessionCalls.get(id) ?? new Map();
      sessionCalls.set(id, calls);
      calls.set(task, abort);
      void task.finally(() => {
        calls.delete(task);
        if (!calls.size) sessionCalls.delete(id);
      });
    }
    await task;
  };

  /**
   * What a ChatGPT-mode Codex with this key lists besides ChatGPT's models:
   * the models the key may use, as `/v1/models` lists them.
   */
  const codexListing = async (
    key: GatewayKeyRecord,
  ): Promise<CodexListing | undefined> => {
    const catalog = deps.codexCatalog;
    if (!catalog) return undefined;
    const models: CodexListedModel[] = shownAs(
      key,
      await visibleModels(key),
    ).map((entry) => ({
      slug: entry.id,
      ...(entry.model?.contextWindow === undefined
        ? {}
        : { contextWindow: entry.model.contextWindow }),
      efforts: entry.efforts ?? [],
      images: entry.model?.inputModalities?.includes("image") === true,
    }));
    return {
      entries: (first) => catalog(models, first),
      tag: createHash("sha256")
        .update(JSON.stringify(models))
        .digest("hex")
        .slice(0, 12),
    };
  };

  const codex = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    target: string,
    listener: "loopback" | "lan",
    occurredAt: number,
    started: number,
  ) => {
    // ChatGPT-mode wiring's Gateway Key is no part of the path from here on.
    const { path, key: keyText } = codexRoute(target);
    const refuse = (reason: string, message: string) =>
      reject(
        response,
        baseEntry(
          "responses",
          path,
          occurredAt,
          undefined,
          request.headers["user-agent"],
        ),
        reason,
        failure(403, reason, message),
        started,
      );
    if (listener === "lan" || !loopbackAddress(request.socket.remoteAddress))
      return refuse(
        "source_not_allowed",
        "The Codex passthrough accepts loopback connections only",
      );
    if (
      request.headers.origin !== undefined ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return refuse("origin_forbidden", "Browser requests are not accepted");
    if (!loopbackHost(request.headers.host))
      return refuse(
        "origin_forbidden",
        "The Host header must name a loopback address",
      );
    const relay = (extra: { body?: Buffer; modelsTag?: string } = {}) => ({
      request,
      response,
      path,
      search: url.search,
      backend: deps.codexBackend ?? CODEX_BACKEND,
      services,
      shutdown: shutdown.signal,
      entry: (stream: boolean) => {
        const entry = baseEntry(
          "responses",
          path,
          occurredAt,
          undefined,
          undefined,
        );
        entry.inbound.stream = stream;
        return entry;
      },
      ...extra,
    });
    let auth: Authentication | undefined;
    let listing: CodexListing | undefined;
    let bytes: Buffer | undefined;
    let local:
      | { key: GatewayKeyRecord; entry: ModelCallEntry; body: Buffer }
      | undefined;
    /** 401 here: no Gateway Key, or not a valid one; the path is not repeated. */
    const unauthorized = async (
      entry: ModelCallEntry,
      why?: Authentication,
    ) => {
      const reason = why?.ok === false ? why.reason : "invalid_key";
      await reject(
        response,
        entry,
        reason,
        failure(
          401,
          reason,
          `${why?.ok === false ? `${why.message}. ` : ""}HarnessHub models need the Gateway Key that wiring Codex in ChatGPT mode puts in openai_base_url; wire Codex again`,
        ),
        started,
      );
    };
    try {
      auth = keyText === undefined ? undefined : await verifyKey(keyText);
      // A key in the path must be valid, whatever the request is for.
      if (auth && !auth.ok) {
        await unauthorized(
          baseEntry(
            "responses",
            path,
            occurredAt,
            auth.key,
            request.headers["user-agent"],
          ),
          auth,
        );
        return;
      }
      const key = auth?.ok ? auth.key : undefined;
      listing = key ? await codexListing(key) : undefined;
      const method = request.method ?? "GET";
      if (method === "GET" && path === `${CODEX_PATH}/models` && listing) {
        touch(key!);
        await codexModels(relay(), listing);
        return;
      }
      if (method === "POST" && path === `${CODEX_PATH}/responses`) {
        bytes = await readBody(request, {
          maxBytes: limits.maxRequestBytes,
          timeoutMs: limits.requestBodyTimeoutMs,
          signal: shutdown.signal,
          memory: services.memory,
        });
        let model: unknown;
        try {
          model = record(JSON.parse(bytes.toString("utf8")))?.model;
        } catch {
          model = undefined;
        }
        // HarnessHub's models are served here and never go to ChatGPT, nor
        // does the client's ChatGPT sign-in go anywhere with them (Magpie:
        // the namespace owns the route).
        if (typeof model === "string" && model.includes("/")) {
          const entry = baseEntry(
            "responses",
            path,
            occurredAt,
            auth?.key,
            request.headers["user-agent"],
          );
          if (!key) {
            services.memory.give(bytes.length);
            bytes = undefined;
            await unauthorized(entry);
            return;
          }
          local = { key, entry, body: bytes };
          bytes = undefined;
        }
      }
    } catch (error) {
      if (bytes) services.memory.give(bytes.length);
      if (!(error instanceof GatewayError))
        log.info("gateway.store.unavailable", {
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      await reply(
        response,
        "responses",
        error instanceof GatewayError
          ? failure(error.status, error.code, error.message)
          : failure(503, "store_unavailable", "Gateway Keys cannot be read"),
      );
      return;
    }
    if (local) {
      delete request.headers.authorization;
      delete request.headers["chatgpt-account-id"];
      touch(local.key);
      await callRoute(
        request,
        response,
        { protocol: "responses" },
        local.key,
        local.entry,
        started,
        local.body,
      );
      return;
    }
    const body = bytes;
    bytes = undefined;
    await codexPassthrough(
      relay({
        ...(body ? { body } : {}),
        ...(listing ? { modelsTag: listing.tag } : {}),
      }),
    );
  };

  const serve = async (
    request: IncomingMessage,
    response: ServerResponse,
    listener: "loopback" | "lan",
  ) => {
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    const started = performance.now();
    const occurredAt = clock();
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      await reply(
        response,
        "chat",
        failure(400, "route_invalid", "Malformed model gateway route"),
      );
      return;
    }
    let path = normalize(url.pathname);
    // A Gateway Key in the path (ADR 0033) is taken out before anything else
    // sees the path: no ledger entry, log line or export holds it.
    const keyed = keyPathRoute(path);
    if (keyed) {
      path = keyed.path;
      url = new URL(`${path}${url.search}`, url);
    }
    const protocol = guessProtocol(path);
    if (closing) {
      await reply(
        response,
        protocol,
        failure(503, "gateway_closing", "The model gateway is shutting down"),
      );
      return;
    }
    if (path === MUSE_MODELS_PATH && !keyed) {
      await museModels(request, response, listener);
      return;
    }
    if (!isGatewayPath(path) || (keyed && isCodexPath(path))) {
      await reply(
        response,
        protocol,
        failure(404, "route_not_found", "Not a model gateway route"),
      );
      return;
    }
    if (isCodexPath(path)) {
      await codex(request, response, url, path, listener, occurredAt, started);
      return;
    }
    const access = deps.access?.() ?? LOOPBACK_ONLY;
    const viaLan = listener === "lan";
    // A key in the path is taken from loopback connections only.
    if (
      keyed
        ? viaLan || !loopbackAddress(request.socket.remoteAddress)
        : viaLan
          ? !access.lan
          : !loopbackAddress(request.socket.remoteAddress)
    ) {
      await reject(
        response,
        baseEntry(
          protocol,
          path,
          occurredAt,
          undefined,
          request.headers["user-agent"],
        ),
        "source_not_allowed",
        failure(
          403,
          "source_not_allowed",
          keyed
            ? "A Gateway Key in the path is taken on loopback connections only"
            : viaLan
              ? "Gateway sharing on the local network is off"
              : "The model gateway accepts loopback connections only",
        ),
        started,
      );
      return;
    }
    let auth: Authentication;
    try {
      auth = await authenticate(request, url, protocol === "gemini", keyed);
    } catch (error) {
      log.info("gateway.store.unavailable", {
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      await reply(
        response,
        protocol,
        failure(503, "store_unavailable", "Gateway Keys cannot be read"),
      );
      return;
    }
    const entry = baseEntry(
      protocol,
      path,
      occurredAt,
      auth.ok ? auth.key : auth.key,
      request.headers["user-agent"],
    );
    if (!auth.ok) {
      await reject(
        response,
        entry,
        auth.reason,
        failure(401, auth.reason, auth.message),
        started,
      );
      return;
    }
    const key = auth.key;
    if (keyed && key.scope.kind !== "agent") {
      await reject(
        response,
        entry,
        "invalid_key",
        failure(401, "invalid_key", "Only an agent key may go in the path"),
        started,
      );
      return;
    }
    if (viaLan && !(key.scope.kind === "client" && key.allowLan === true)) {
      await reject(
        response,
        entry,
        "source_not_allowed",
        failure(
          403,
          "source_not_allowed",
          "This Gateway Key may not be used from the local network",
        ),
        started,
      );
      return;
    }
    // No client the gateway serves is a browser: every Origin is refused,
    // on both listeners, and so are cross-site fetches without one.
    if (
      request.headers.origin !== undefined ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      await reject(
        response,
        entry,
        "origin_forbidden",
        failure(403, "origin_forbidden", "Browser requests are not accepted"),
        started,
      );
      return;
    }
    const host = canonicalHost(request.headers.host);
    if (
      host === undefined ||
      !(
        access.publicHosts.has(host) ||
        (viaLan ? access.lanHosts.has(host) : loopbackHost(host))
      )
    ) {
      await reject(
        response,
        entry,
        "origin_forbidden",
        failure(
          403,
          "origin_forbidden",
          viaLan
            ? "The Host header must name a declared LAN address"
            : "The Host header must name a loopback address",
        ),
        started,
      );
      return;
    }
    touch(key);
    let route: Route | undefined;
    try {
      route = matchRoute(request.method, url);
    } catch (error) {
      await reject(
        response,
        entry,
        "route_invalid",
        failure(
          400,
          "route_invalid",
          error instanceof GatewayError ? error.message : "Malformed route",
        ),
        started,
      );
      return;
    }
    if (!route) {
      await reject(
        response,
        entry,
        "route_not_found",
        failure(404, "route_not_found", "Unsupported model gateway route"),
        started,
      );
      return;
    }
    try {
      switch (route.kind) {
        case "models":
          await listModels(response, key, route);
          return;
        case "limit": {
          // The calling key's own limits and use (Magpie /v1/magpie/limit).
          let status: KeyLimitStatus;
          try {
            status = await services.quotas.status(key);
          } catch {
            throw new GatewayError(
              "Gateway Key usage cannot be read",
              503,
              "store_unavailable",
            );
          }
          await new HttpWriter(response).json(200, {
            object: "gateway_key.limit",
            limited:
              status.requestsPerMinute !== undefined ||
              status.budgets.length > 0,
            ...status,
          });
          return;
        }
        case "count":
          await countTokens(request, response, route.protocol, key);
          return;
        case "compact":
          // Every model here is HarnessHub's (./compacting.js).
          entry.inbound.protocol = "responses";
          await reject(
            response,
            entry,
            "compact_unsupported",
            failure(400, "compact_unsupported", COMPACT_UNSUPPORTED),
            started,
          );
          return;
        case "images": {
          const abort = new AbortController();
          const onClose = () => {
            if (!response.writableFinished) abort.abort();
          };
          response.once("close", onClose);
          const onShutdown = () => abort.abort();
          shutdown.signal.addEventListener("abort", onShutdown, { once: true });
          try {
            await imagesCall({
              services,
              request,
              response,
              key,
              entry,
              started,
              signal: abort.signal,
              edit: route.edit,
            });
          } finally {
            response.removeListener("close", onClose);
            shutdown.signal.removeEventListener("abort", onShutdown);
          }
          return;
        }
        case "call":
          await callRoute(request, response, route.call, key, entry, started);
          return;
      }
    } catch (error) {
      if (!(error instanceof GatewayError))
        log.info("gateway.request.failed", {
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      await reply(
        response,
        protocol,
        error instanceof GatewayError
          ? failure(error.status, error.code, error.message)
          : failure(500, "gateway_error", "Model gateway internal error"),
      );
    }
  };

  /**
   * Calls the gateway makes for itself on behalf of a client's request
   * (image descriptions, classifier questions; ./internal.js): Chat
   * requests on a private listener on 127.0.0.1, started on first use, that
   * answers only requests carrying this handler's random token and the id
   * of a call in `pending`. They take the normal path (routing, failover,
   * ledger) as the request's own Gateway Key: its allowlist, budgets,
   * requests per minute and local-network rules hold, and each is a ledger
   * entry of that key with the agent `harnesshub-<purpose>` and its
   * `purpose`.
   */
  const internalToken = randomBytes(32).toString("base64url");
  const pending = new Map<
    string,
    { purpose: CallPurpose; key: GatewayKeyRecord; entry: ModelCallEntry }
  >();
  let internalServer: Promise<{ server: Server; url: string }> | undefined;
  const internalServe = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const presented = request.headers["x-hh-internal"];
    const id = request.headers["x-hh-internal-call"];
    const valid =
      typeof presented === "string" &&
      presented.length === internalToken.length &&
      timingSafeEqual(Buffer.from(presented), Buffer.from(internalToken)) &&
      request.method === "POST" &&
      request.url === "/v1/chat/completions";
    const trigger =
      valid && typeof id === "string" ? pending.get(id) : undefined;
    if (!trigger) {
      response.writeHead(404).end();
      return;
    }
    const { purpose, key } = trigger;
    const entry = baseEntry(
      "chat",
      "/v1/chat/completions",
      clock(),
      key,
      undefined,
    );
    entry.agent = { id: `harnesshub-${purpose}`, source: "route" };
    entry.purpose = purpose;
    if (trigger.entry.runId !== undefined) entry.runId = trigger.entry.runId;
    if (trigger.entry.generation !== undefined)
      entry.generation = trigger.entry.generation;
    response.setHeader("x-hh-call-id", entry.callId);
    await modelCall(
      request,
      response,
      { protocol: "chat" },
      key,
      entry,
      performance.now(),
      new AbortController(),
      undefined,
      purpose,
    );
  };
  const internalCall = async (
    purpose: CallPurpose,
    trigger: { key: GatewayKeyRecord; entry: ModelCallEntry },
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<InternalAnswer> => {
    if (closing) throw new GatewayError("The gateway is stopping", 503);
    internalServer ??= (async () => {
      const server = createServer((request, response) => {
        track(
          internalServe(request, response).catch(() => void response.destroy()),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new GatewayError("The internal listener has no address", 500);
      return { server, url: `http://127.0.0.1:${address.port}` };
    })();
    const { url } = await internalServer;
    const id = randomBytes(16).toString("base64url");
    pending.set(id, { purpose, ...trigger });
    try {
      const answer = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-hh-internal": internalToken,
          "x-hh-internal-call": id,
        },
        body: JSON.stringify(body),
      });
      const text = await answer.text();
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      const callId = answer.headers.get("x-hh-call-id");
      return {
        status: answer.status,
        body: value,
        ...(callId ? { callId } : {}),
      };
    } finally {
      pending.delete(id);
    }
  };
  /** The internal calls of one request of `key`, at most `limits.maxInternalCalls`. */
  const internalCalls = (
    key: GatewayKeyRecord,
    entry: ModelCallEntry,
  ): InternalCalls => {
    let made = 0;
    return {
      allows: (model) => modelAllowed(key.modelAllow, model, key.modelDeny),
      call: async (purpose, body, signal) => {
        if (made >= limits.maxInternalCalls) return undefined;
        made++;
        // A group's classifier comes with the group, as its members do: a
        // key that may use the group may ask it, unless it denies that model.
        const as =
          purpose === "classify" && typeof body.model === "string"
            ? { ...key, modelAllow: [...key.modelAllow, body.model] }
            : key;
        return internalCall(purpose, { key: as, entry }, body, signal);
      },
    };
  };

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    track(
      serve(request, response, "loopback").catch(() => void response.destroy()),
    );
  };
  return Object.assign(handler, {
    lan(request: IncomingMessage, response: ServerResponse): void {
      track(
        serve(request, response, "lan").catch(() => void response.destroy()),
      );
    },
    routingState(): CredentialRoutingState[] {
      const states = new Map<string, CredentialRoutingState>();
      const of = (provider: string, credential: string) => {
        const key = `${provider}\u0000${credential}`;
        let state = states.get(key);
        if (!state) {
          state = { provider, credential, state: "closed", readings: [] };
          states.set(key, state);
        }
        return state;
      };
      for (const breaker of services.breakers.snapshot()) {
        const state = of(breaker.provider, breaker.credential);
        state.state = breaker.state;
        if (breaker.until !== undefined)
          state.restingUntil = new Date(breaker.until).toISOString();
        if (breaker.last)
          state.lastFailure = {
            kind: breaker.last.errorClass,
            status: breaker.last.status,
            at: new Date(breaker.last.at).toISOString(),
          };
      }
      for (const stored of services.router.snapshot())
        of(stored.provider, stored.credential).readings.push(stored.reading);
      return [...states.values()];
    },
    async keyLimit(keyId: GatewayKeyId) {
      const key = await store.getGatewayKey(keyId);
      return key ? services.quotas.status(key) : undefined;
    },
    routeDecisions(query: RouteDecisionQuery, signal: AbortSignal) {
      return trace.read(query, signal);
    },
    async awaitSessionIdle(
      sessionId: SessionId,
      options: { abort?: boolean } = {},
    ): Promise<void> {
      for (;;) {
        const calls = sessionCalls.get(sessionId);
        if (!calls?.size) return;
        if (options.abort) for (const abort of calls.values()) abort.abort();
        await Promise.allSettled([...calls.keys()]);
      }
    },
    close(): Promise<void> {
      closing ??= (async () => {
        shutdown.abort();
        trace.close();
        clearInterval(saver);
        while (tasks.size) await Promise.allSettled([...tasks]);
        const internal = await internalServer?.catch(() => undefined);
        if (internal) {
          internal.server.closeAllConnections();
          await new Promise<void>((resolve) =>
            internal.server.close(() => resolve()),
          );
        }
        await services.copilot?.close();
        for (const record of throttle.drain()) await services.commit(record);
        await saveReadings();
      })();
      return closing;
    },
  });
}
