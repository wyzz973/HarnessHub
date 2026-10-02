// SPDX-License-Identifier: MIT
/**
 * The shared multi-provider gateway (03-model-plane): one handler that the
 * daemon mounts on its own listener for `/v1/*`, `/v1beta/*`, `/v1alpha/*`
 * and the prefix-less OpenAI and Anthropic paths. It authenticates Gateway
 * Keys, resolves Model Refs and route groups from the {@link ModelPlaneStore},
 * routes each call over provider credentials and commits one `model.call`
 * entry per call, rejected or not, before the answer's terminal event.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import {
  gatewayKeyMatches,
  modelAllowed,
  parseGatewayKey,
  parseModelRef,
  type GatewayKeyId,
  type GatewayKeyRecord,
  type ModelCallEntry,
  type ModelCallId,
  type ModelPlaneStore,
  type ModelRef,
  type ProviderConfig,
  type ProviderModel,
  type RouteGroup,
  type Stickiness,
  type WireProtocol,
} from "@harnesshub/core/model-plane";
import { HARNESS_MODEL_ALIAS } from "@harnesshub/core/harness-model";
import type { RunId, SessionId } from "@harnesshub/core/types";
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
import { Quotas, type QuotaRefusal } from "./quota.js";
import { conversationOf, StickyRoutes } from "./sticky.js";
import { canonicalHost, LOOPBACK_ONLY, type GatewayAccess } from "./sharing.js";
import { forwardCountTokens } from "./count.js";
import type { HandlerLimits } from "./limits.js";
import { HttpWriter, type Failure } from "./output.js";
import { GatewayError, estimateTokens, object } from "./protocol.js";
import {
  Breakers,
  modelCandidates,
  Router,
  type Candidate,
} from "./routing.js";

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
}

function normalize(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}

/**
 * Whether the daemon should hand a path to the gateway: `/v1/*`, `/v1beta/*`,
 * `/v1alpha/*`, and the OpenAI and Anthropic paths without `/v1`.
 */
export function isGatewayPath(pathname: string): boolean {
  const path = normalize(pathname);
  return (
    /^\/v1(?:beta|alpha)?(?:\/|$)/.test(path) ||
    /^\/(?:chat\/completions|responses|messages(?:\/count_tokens)?|models(?:\/.*)?)$/.test(
      path,
    )
  );
}

type Route =
  | { kind: "models"; format: "openai" | "gemini"; id?: string }
  | { kind: "count"; protocol: "anthropic" | "gemini" }
  | { kind: "call"; call: CallRoute };

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
    if (openai === "/models") return { kind: "models", format: "openai" };
    const one = /^\/models\/(.+)$/.exec(openai);
    return one
      ? { kind: "models", format: "openai", id: decode(one[1]!) }
      : undefined;
  }
  if (method !== "POST") return undefined;
  switch (openai) {
    case "/chat/completions":
      return { kind: "call", call: { protocol: "chat" } };
    case "/responses":
      return { kind: "call", call: { protocol: "responses" } };
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
  if (/\/responses\/?$/.test(pathname)) return "responses";
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
  owner: string;
  created: number;
  model?: ProviderModel;
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
    display_name: entry.id,
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
    displayName: entry.id,
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

/** Smallest known value, or undefined when any member's value is unknown. */
function least(values: (number | undefined)[]): number | undefined {
  return values.length && values.every((value) => value !== undefined)
    ? Math.min(...(values as number[]))
    : undefined;
}

/** Group metadata: the smallest window and output, reasoning and modalities every member has. */
function groupModel(members: (ProviderModel | undefined)[]): ProviderModel {
  const known = members.filter(
    (model): model is ProviderModel => model !== undefined,
  );
  const complete = known.length === members.length && members.length > 0;
  const contextWindow = least(members.map((model) => model?.contextWindow));
  const maxOutputTokens = least(members.map((model) => model?.maxOutputTokens));
  const modalities = complete
    ? known
        .map((model) => model.inputModalities)
        .reduce<ProviderModel["inputModalities"]>(
          (all, list) =>
            all === undefined || list === undefined
              ? undefined
              : all.filter((value) => list.includes(value)),
          known[0]?.inputModalities,
        )
    : undefined;
  return {
    id: "",
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(complete && known.every((model) => model.reasoning !== undefined)
      ? { reasoning: known.every((model) => model.reasoning === true) }
      : {}),
    ...(modalities === undefined ? {} : { inputModalities: modalities }),
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
      let slots = credentialSlots.get(name);
      if (!slots) {
        slots = new Slots(
          limits.maxConcurrentPerCredential,
          limits.maxQueuedPerCredential,
          `Too many concurrent requests on credential ${candidate.credential.id} of ${candidate.provider.id}`,
        );
        credentialSlots.set(name, slots);
      }
      return slots;
    },
    reasoning: new ReasoningCaches(limits),
    sticky: new StickyRoutes(clock),
    quotas: new Quotas(store, clock),
    makeId: () => `call_${nonce}${(generated++).toString(36)}`,
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
        return false;
      }
    },
  };

  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  const baseEntry = (
    protocol: WireProtocol,
    path: string,
    occurredAt: number,
    key: GatewayKeyRecord | undefined,
  ): ModelCallEntry => ({
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
    inbound: { protocol, path: path.slice(0, 200), stream: false },
    patches: [],
    unmapped: [],
    status: 0,
    timing: { durationMs: 0 },
    attempts: [],
    cost: null,
  });

  const reply = async (
    response: ServerResponse,
    protocol: WireProtocol,
    value: Failure,
    retryAfterMs?: number,
  ) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.setHeader("x-hh-error-source", "gateway");
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
    await reply(response, entry.inbound.protocol, value, retryAfterMs);
  };

  const authenticate = async (
    request: IncomingMessage,
    url: URL,
    gemini: boolean,
  ): Promise<Authentication> => {
    const presented: string[] = [];
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
    const parsed = parseGatewayKey(presented[0]!);
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
    const [providers, groups] = await Promise.all([
      store.listProviders(),
      store.listRouteGroups(),
    ]);
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const metadata = (ref: ModelRef) => {
      const parsed = parseModelRef(ref);
      if (parsed?.kind !== "model") return undefined;
      return byId
        .get(parsed.provider)
        ?.models.list.find((model) => model.id === parsed.model);
    };
    const listed: ListedModel[] = [];
    if (session) {
      // The alias a Session's engine was configured with, described as its Run's target.
      const target = parseModelRef(session.target);
      const group =
        target?.kind === "group"
          ? groups.find((entry) => entry.id === target.group)
          : undefined;
      listed.push({
        id: HARNESS_MODEL_ALIAS,
        owner: "harnesshub",
        created: 0,
        model:
          target?.kind === "group"
            ? groupModel(group?.members.map(metadata) ?? [])
            : (metadata(session.target as ModelRef) ?? {
                id: HARNESS_MODEL_ALIAS,
              }),
      });
    }
    for (const provider of providers) {
      const exposed =
        provider.models.expose === "all"
          ? provider.models.list
          : provider.models.list.filter((model) =>
              (provider.models.expose as string[]).includes(model.id),
            );
      for (const model of exposed) {
        const id = `${provider.id}/${model.id}`;
        if (!modelAllowed(key.modelAllow, id) && id !== session?.target)
          continue;
        listed.push({
          id,
          owner: provider.id,
          created: Math.floor(Date.parse(provider.createdAt) / 1000) || 0,
          model,
          nativeEndpoints: provider.translateOnly
            ? []
            : (Object.keys(provider.endpoints) as WireProtocol[]),
        });
      }
    }
    for (const group of groups) {
      const id = `group/${group.id}`;
      if (!modelAllowed(key.modelAllow, id) && id !== session?.target) continue;
      listed.push({
        id,
        owner: "harnesshub",
        created: Math.floor(Date.parse(group.createdAt) / 1000) || 0,
        model: groupModel(group.members.map(metadata)),
      });
    }
    return listed;
  };

  const listModels = async (
    response: ServerResponse,
    key: GatewayKeyRecord,
    route: Extract<Route, { kind: "models" }>,
  ) => {
    const listed = await visibleModels(
      key,
      key.scope.kind === "session"
        ? deps.sessions?.activeRun(key.scope.sessionId)
        : undefined,
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
    const named = raw.model;
    const requested =
      session &&
      (typeof named !== "string" ||
        named === HARNESS_MODEL_ALIAS ||
        !parseModelRef(named))
        ? session.target
        : named;
    if (typeof requested !== "string" || !parseModelRef(requested))
      return undefined;
    if (
      !modelAllowed(key.modelAllow, requested) &&
      requested !== session?.target
    )
      return undefined;
    let resolved: CallPlan;
    try {
      // Configured order: counting must not advance a group's rotation.
      resolved = await plan(requested, "anthropic", (group) => group.members);
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
    order: (group: RouteGroup) => readonly ModelRef[] = (group) =>
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
    const group = await store.getRouteGroup(parsed.group);
    if (!group) throw notFound();
    const providers = new Map<string, ProviderConfig | undefined>();
    const result: CallPlan = { candidates: [], group, skipped: [] };
    for (const member of order(group)) {
      const ref = parseModelRef(member);
      if (ref?.kind !== "model") {
        result.skipped.push(`${member}: not a Model Ref`);
        continue;
      }
      if (!providers.has(ref.provider))
        providers.set(ref.provider, await store.getProvider(ref.provider));
      const provider = providers.get(ref.provider);
      if (!provider) {
        result.skipped.push(`${member}: unknown provider`);
        continue;
      }
      const { candidates, skipped } = modelCandidates(
        provider,
        ref.model,
        protocol,
      );
      result.candidates.push(...candidates);
      result.skipped.push(...skipped);
    }
    return result;
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
    try {
      const bytes = await readBody(request, {
        maxBytes: limits.maxRequestBytes,
        timeoutMs: limits.requestBodyTimeoutMs,
        signal: abort.signal,
        memory: services.memory,
      });
      reserved = bytes.length;
      const raw = object(parseJsonBody(bytes));
      const named = route.gemini?.model ?? raw.model;
      const stream =
        route.gemini !== undefined
          ? route.gemini.method === "streamGenerateContent"
          : raw.stream === true;
      entry.inbound.stream = stream;
      if (typeof named === "string" && named)
        entry.requestedModel = named.slice(0, 256);
      // A Session's engine names the alias, or any model name of its own;
      // both mean the target the Run selected.
      const requested =
        session &&
        (typeof named !== "string" ||
          named === HARNESS_MODEL_ALIAS ||
          !parseModelRef(named))
          ? session.target
          : named;
      if (typeof requested !== "string" || !requested)
        throw new GatewayError("The request requires a model");
      if (
        route.protocol === "chat" &&
        raw.n !== undefined &&
        raw.n !== null &&
        raw.n !== 1
      )
        throw new GatewayError(
          "Only one completion choice (n = 1) is supported",
        );
      if (!parseModelRef(requested))
        throw new GatewayError(
          "The model must be a Model Ref (provider/model) or group/<id>",
          400,
          "model_invalid",
        );
      if (
        !modelAllowed(key.modelAllow, requested) &&
        requested !== session?.target
      ) {
        await reject(
          response,
          entry,
          "model_not_allowed",
          failure(
            403,
            "model_not_allowed",
            `This Gateway Key may not use ${requested.slice(0, 200)}`,
          ),
          started,
        );
        return;
      }
      let refusal: QuotaRefusal | undefined;
      try {
        refusal = await services.quotas.admit(key);
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
      if (refusal) {
        await reject(
          response,
          entry,
          "quota_exceeded",
          failure(429, "quota_exceeded", refusal.message),
          started,
          refusal.retryAfterMs,
        );
        return;
      }
      const resolved = await plan(requested, route.protocol);
      const parsed = parseModelRef(requested);
      if (parsed?.kind === "group") entry.group = parsed.group;
      const conversation = conversationOf(
        route.protocol,
        raw,
        request.headers,
        key.keyId,
      );
      const sticky = services.sticky.apply(
        conversation,
        requested,
        stickiness(resolved.group, key),
        resolved.candidates,
        (candidate) => services.breakers.blocked(candidate),
      );
      resolved.candidates = sticky.candidates;
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
        routePatches: sticky.patch ? [sticky.patch] : [],
      };
      try {
        await routeCall(call, resolved);
      } catch (error) {
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
      services.memory.give(reserved);
      response.removeListener("close", onClose);
      shutdown.signal.removeEventListener("abort", onShutdown);
      abort.abort();
    }
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
    const path = normalize(url.pathname);
    const protocol = guessProtocol(path);
    if (closing) {
      await reply(
        response,
        protocol,
        failure(503, "gateway_closing", "The model gateway is shutting down"),
      );
      return;
    }
    if (!isGatewayPath(path)) {
      await reply(
        response,
        protocol,
        failure(404, "route_not_found", "Not a model gateway route"),
      );
      return;
    }
    const access = deps.access?.() ?? LOOPBACK_ONLY;
    const viaLan = listener === "lan";
    if (viaLan ? !access.lan : !loopbackAddress(request.socket.remoteAddress)) {
      await reject(
        response,
        baseEntry(protocol, path, occurredAt, undefined),
        "source_not_allowed",
        failure(
          403,
          "source_not_allowed",
          viaLan
            ? "Gateway sharing on the local network is off"
            : "The model gateway accepts loopback connections only",
        ),
        started,
      );
      return;
    }
    let auth: Authentication;
    try {
      auth = await authenticate(request, url, protocol === "gemini");
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
        case "count":
          await countTokens(request, response, route.protocol, key);
          return;
        case "call": {
          entry.inbound.protocol = route.call.protocol;
          let session: ActiveSessionRun | undefined;
          if (key.scope.kind === "session") {
            session = deps.sessions?.activeRun(key.scope.sessionId);
            if (!session) {
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
            route.call,
            key,
            entry,
            started,
            abort,
            session,
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
          return;
        }
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
        while (tasks.size) await Promise.allSettled([...tasks]);
        for (const record of throttle.drain()) await services.commit(record);
      })();
      return closing;
    },
  });
}
