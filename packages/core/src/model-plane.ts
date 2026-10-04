// SPDX-License-Identifier: MIT
/**
 * Contracts of the model plane: providers and their credentials, Model Refs,
 * route groups, Gateway Keys and the `model.call` ledger (03-model-plane,
 * 02-architecture section 4). The store persists these records, the shared
 * gateway reads them through the ports below, the daemon exposes them under
 * `/api/v1`, and global wiring issues `agent:` keys. Secrets never appear in
 * these records: credentials carry references, keys carry only a hash.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretReference } from "./engine-configuration.js";
import type { Brand, RunId, SessionId } from "./types.js";

export type ProviderId = Brand<string, "ProviderId">;
export type CredentialId = Brand<string, "CredentialId">;
export type RouteGroupId = Brand<string, "RouteGroupId">;
export type GatewayKeyId = Brand<string, "GatewayKeyId">;
export type ModelCallId = Brand<string, "ModelCallId">;
/** `provider/model`, the canonical model name for routing, allowlists, ledger and prices. */
export type ModelRef = Brand<string, "ModelRef">;

/** Wire protocols a provider endpoint or a gateway inbound route speaks. */
export const wireProtocols = [
  "chat",
  "responses",
  "anthropic",
  "gemini",
] as const;
export type WireProtocol = (typeof wireProtocols)[number];

export type ProviderKind = "vendor" | "relay" | "local" | "custom";

/** How the upstream API key is sent. `custom:<name>` sends it in that header. */
export type ApiKeyHeader =
  | "authorization-bearer"
  | "x-api-key"
  | "api-key"
  | "x-goog-api-key"
  | "query-key"
  | `custom:${string}`;

/**
 * Request patches a provider may opt into, by name. The set is closed: a new
 * kind needs core code, corpus and docs (03 section 3).
 */
export const providerPatches = [
  "developer-to-system",
  "max-tokens-field",
  "drop-fields",
  "include-usage",
  "json-schema-to-json-object",
  "anthropic-beta-allow",
  "thinking-off-unless-asked",
  "lift-additional-tools",
] as const;
export type ProviderPatch = (typeof providerPatches)[number];

/** Optional request fields that the `drop-fields` patch may remove (03 section 5). */
export const droppableFields = [
  "store",
  "metadata",
  "service_tier",
  "user",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
  "parallel_tool_calls",
  "verbosity",
] as const;
export type DroppableField = (typeof droppableFields)[number];

export interface ProviderPatchSet {
  patches: ProviderPatch[];
  /** Fields removed by `drop-fields`; ignored without that patch. */
  dropFields?: DroppableField[];
  /** `anthropic-beta` values forwarded by `anthropic-beta-allow`. */
  anthropicBetaAllow?: string[];
}

/** One upstream credential: an independent routing candidate and breaker unit. */
export interface ProviderCredential {
  id: CredentialId;
  name: string;
  /** Where the secret lives; the value is resolved only when a request is sent. */
  ref: SecretReference;
  /** Endpoints this credential is valid for; absent means all of the provider's. */
  protocols?: WireProtocol[];
  enabled: boolean;
}

/** Metadata of one model as the provider exposes it; unknown values stay absent. */
export interface ProviderModel {
  /** Name within the provider; the Model Ref is `<provider>/<id>`. */
  id: string;
  /** Name sent upstream when it differs from `id`. */
  wire?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  inputModalities?: Array<"text" | "image" | "pdf" | "audio" | "video">;
  /** USD per million tokens. */
  price?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ProviderModels {
  source: "live" | "catalog" | "static" | "manual";
  list: ProviderModel[];
  /** Which models appear in `/v1/models` and agent pickers. */
  expose: "all" | string[];
  /** Last successful live refresh (ISO 8601); a failed refresh keeps the list and sets `stale`. */
  refreshedAt?: string;
  stale?: boolean;
  /** Path appended to the chat or anthropic base URL for a live list; default `/models`. */
  listPath?: string;
}

export interface ProviderConfig {
  schemaVersion: 1;
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  /** Preset this provider was created from, if any. */
  preset?: string;
  /** The preset's region chosen at creation (`regions[].id`); only with `preset`. */
  region?: string;
  /** The preset's plan chosen at creation (`plans[].id`); only with `preset`. */
  plan?: string;
  /**
   * models.dev provider ID for model metadata, replacing the one the preset
   * (with its region and plan) names; set for providers imported without one.
   */
  catalog?: string;
  /** Base URL per native endpoint, without the operation path (`/chat/completions`, `/messages`, ...). */
  endpoints: Partial<Record<WireProtocol, string>>;
  auth: { apiKeyHeader: ApiKeyHeader };
  /** Non-secret headers sent with every upstream request. */
  headers?: Record<string, string>;
  credentials: ProviderCredential[];
  models: ProviderModels;
  /** Upstream name per model or `*` pattern (`*` is replaced by the model id). */
  wire?: Record<string, string>;
  patches?: Partial<Record<WireProtocol, ProviderPatchSet>>;
  capabilities?: { requiresReasoningReplay?: boolean };
  /** Never pass requests through byte for byte, even on a matching endpoint. */
  translateOnly?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RouteStrategy = "order" | "rotate" | "least-used" | "latency";
export type Stickiness = "auto" | "session" | "turn" | "off";

export interface RetryPolicy {
  perCandidate: number;
  totalAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  retryAfterWaitCapMs: number;
}

/** Defaults of 03 section 5; resolved in one place. */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  perCandidate: 2,
  totalAttempts: 4,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  retryAfterWaitCapMs: 8_000,
});

/** `group/<id>`: an ordered set of Model Refs routed by one strategy. */
export interface RouteGroup {
  id: RouteGroupId;
  strategy: RouteStrategy;
  stickiness: Stickiness;
  members: ModelRef[];
  retry?: Partial<RetryPolicy>;
  createdAt: string;
  updatedAt: string;
}

/** Who holds a Gateway Key; the scope letter is part of the key text. */
export type GatewayKeyScope =
  | { kind: "agent"; adapterId: string }
  | { kind: "session"; sessionId: SessionId }
  | { kind: "client"; name: string };

const scopeLetters = { agent: "a", session: "s", client: "c" } as const;

export interface GatewayKeyQuota {
  requestsPerMinute?: number;
  tokensPerDay?: number;
  costPerMonthUsd?: number;
}

/** A stored Gateway Key. `secretHash` never leaves the store and the gateway. */
export interface GatewayKeyRecord {
  keyId: GatewayKeyId;
  name: string;
  scope: GatewayKeyScope;
  /** Model Refs, `provider/*`, `group/<id>` and `*` (every model, including ones added later); empty allows nothing. */
  modelAllow: string[];
  /**
   * Entries of the same forms that `modelAllow` would admit but the key may
   * not use: the models hidden from a wired agent (04 section 4). Absent or
   * empty hides nothing.
   */
  modelDeny?: string[];
  quota?: GatewayKeyQuota;
  /**
   * The key may be presented on the LAN listener of gateway sharing
   * (03 section 2, 07 section 5.4). Only `client` keys carry it; every other
   * key works from loopback connections only.
   */
  allowLan?: boolean;
  /** Lowercase hex SHA-256 of the secret part. */
  secretHash: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** The view of a key that the API and UI may show. */
export type GatewayKeyView = Omit<GatewayKeyRecord, "secretHash">;

const KEY_ID = /^[a-z2-7]{12}$/;
const KEY_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * Issues a new key: `hhk_<scope letter>_<keyId>_<secret>`. The text is
 * returned exactly once; callers store only `secretHash`.
 */
export function issueGatewayKey(scope: GatewayKeyScope): {
  text: string;
  keyId: GatewayKeyId;
  secretHash: string;
} {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const keyId = [...randomBytes(12)]
    .map((byte) => alphabet[byte % 32])
    .join("") as GatewayKeyId;
  const secret = randomBytes(32).toString("base64url");
  return {
    text: `hhk_${scopeLetters[scope.kind]}_${keyId}_${secret}`,
    keyId,
    secretHash: hashGatewayKeySecret(secret),
  };
}

/** Splits a presented key; anything not in the issued format is `undefined`. */
export function parseGatewayKey(
  text: string,
):
  | { scope: GatewayKeyScope["kind"]; keyId: GatewayKeyId; secret: string }
  | undefined {
  const match = /^hhk_([asc])_([a-z2-7]{12})_(.+)$/.exec(text);
  if (!match || !KEY_SECRET.test(match[3]!)) return undefined;
  const scope = (Object.entries(scopeLetters).find(
    ([, letter]) => letter === match[1],
  )?.[0] ?? "client") as GatewayKeyScope["kind"];
  return { scope, keyId: match[2] as GatewayKeyId, secret: match[3]! };
}

export function hashGatewayKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function gatewayKeyMatches(
  record: GatewayKeyRecord,
  secret: string,
): boolean {
  const presented = Buffer.from(hashGatewayKeySecret(secret), "hex");
  const stored = Buffer.from(record.secretHash, "hex");
  return (
    presented.length === stored.length && timingSafeEqual(presented, stored)
  );
}

export function isGatewayKeyId(value: string): value is GatewayKeyId {
  return KEY_ID.test(value);
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_ID.test(value) && value !== "group";
}

/**
 * Parses `provider/model` or `group/<id>`. The model part is everything after
 * the first `/`, so `openrouter/deepseek/deepseek-chat` names model
 * `deepseek/deepseek-chat` of provider `openrouter`.
 */
export function parseModelRef(
  text: string,
):
  | { kind: "model"; ref: ModelRef; provider: ProviderId; model: string }
  | { kind: "group"; group: RouteGroupId }
  | undefined {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  const head = text.slice(0, slash);
  const rest = text.slice(slash + 1);
  if (head === "group")
    return PROVIDER_ID.test(rest)
      ? { kind: "group", group: rest as RouteGroupId }
      : undefined;
  if (!isProviderId(head) || /\s/.test(rest)) return undefined;
  return { kind: "model", ref: text as ModelRef, provider: head, model: rest };
}

/**
 * Whether a key may use a Model Ref or a group: some entry of `modelAllow`
 * admits it (exact, `provider/*`, `group/<id>` or `*`) and no entry of
 * `modelDeny` does.
 */
export function modelAllowed(
  modelAllow: readonly string[],
  target: string,
  modelDeny: readonly string[] = [],
): boolean {
  const parsed = parseModelRef(target);
  if (!parsed) return false;
  const admits = (entry: string) =>
    entry === "*" ||
    entry === target ||
    (parsed.kind === "model" && entry === `${parsed.provider}/*`);
  return modelAllow.some(admits) && !modelDeny.some(admits);
}

/** Whether `entry` is an allow or deny entry: a Model Ref, `provider/*`, `group/<id>` or `*`. */
export function isModelPattern(entry: string): boolean {
  return entry === "*" || parseModelRef(entry) !== undefined;
}

export type UsageSource = "reported" | "estimated" | "missing";

/** Normalized usage: `input` excludes cached tokens, so the five never double count. */
export interface CallUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  source: UsageSource;
}

/** One upstream attempt of a routed call (03 section 5). */
export interface CallAttempt {
  provider: ProviderId;
  credentialId: CredentialId;
  modelRef: ModelRef;
  wireModel: string;
  upstreamProtocol: WireProtocol;
  startedAt: string;
  firstByteMs?: number;
  status?: number;
  errorClass?: string;
  retryAfterMs?: number;
  decision: "success" | "retry" | "failover" | "stop";
  backoffMs?: number;
}

/**
 * One call that entered the gateway, rejected or not. The ledger is the only
 * source of usage and cost; a streamed answer's terminal event is written
 * only after this record is committed (03 section 8).
 */
export interface ModelCallEntry {
  callId: ModelCallId;
  occurredAt: string;
  keyId?: GatewayKeyId;
  scope?: GatewayKeyScope;
  sessionId?: SessionId;
  runId?: RunId;
  /** Generation of the Run (`session:` keys), as in the Worker execution identity. */
  generation?: number;
  inbound: { protocol: WireProtocol; path: string; stream: boolean };
  requestedModel?: string;
  modelRef?: ModelRef;
  group?: RouteGroupId;
  provider?: ProviderId;
  credentialId?: CredentialId;
  wireModel?: string;
  upstreamProtocol?: WireProtocol;
  mode?: "passthrough" | "translated";
  servedModel?: string;
  patches: string[];
  unmapped: string[];
  /** HTTP status returned to the client (or that a mid-stream failure maps to). */
  status: number;
  errorClass?: string;
  errorSource?: "gateway" | "upstream";
  /** Redacted, at most 500 characters. */
  error?: string;
  finishReason?: string;
  usage?: CallUsage;
  timing: { firstByteMs?: number; firstContentMs?: number; durationMs: number };
  attempts: CallAttempt[];
  /** null when the price is unknown; 0 only for an explicit zero price. */
  cost: { amountUsd: number; priceSource: string } | null;
  completion?: "explicit" | "inferred";
  rejected?: boolean;
  rejectReason?: string;
}

export interface UsageFilter {
  from?: string;
  to?: string;
  keyId?: GatewayKeyId;
  provider?: ProviderId;
  modelRef?: ModelRef;
  sessionId?: SessionId;
}

export type UsageGroupBy = "day" | "provider" | "model" | "key" | "adapter";

export interface UsageBucket {
  key: string;
  calls: number;
  failedCalls: number;
  usage: Omit<CallUsage, "source">;
  /** Sum of known costs; `unpricedCalls` counts calls whose cost is null. */
  costUsd: number;
  unpricedCalls: number;
}

/** Claude Code's model tiers and its subagents' model, which wiring can set apart from the main model. */
export const wiringTiers = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "subagent",
] as const;
export type WiringTier = (typeof wiringTiers)[number];

/** Reasoning levels an agent can start with, lowest first. */
export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

/**
 * The model choices of one wired agent: what a profile keeps and applies.
 * `model` is absent when the agent keeps choosing its own models (Codex
 * signed in with ChatGPT); a tier that is absent follows `model`; `options`
 * are adapter settings such as `codexAuth`, with the adapter's defaults
 * filled in.
 */
export interface WiringChoice {
  model?: string;
  tiers?: Partial<Record<WiringTier, string>>;
  effort?: ReasoningEffort;
  options?: Record<string, string>;
}

/** A global wiring of one agent on this machine (04 section 4). */
export interface WiringRecord extends WiringChoice {
  adapterId: string;
  /**
   * The `agent:` key written into the agent's files. Absent when the agent
   * authenticates by itself (Codex with a ChatGPT login): no key was issued.
   */
  keyId?: GatewayKeyId;
  files: Array<{
    path: string;
    /** SHA-256 of the file before wiring; absent when wiring created it. */
    beforeHash?: string;
    afterHash: string;
    backupId?: string;
  }>;
  wiredAt: string;
}

/** Named snapshot of the model choices of every wired agent, applied in one move. */
export interface WiringProfile {
  /** 1 to 64 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. */
  name: string;
  /** By adapter id. */
  agents: Record<string, WiringChoice>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persistence that global wiring needs beyond `ModelPlaneStore`: replacing a
 * key's model lists in place (an agent's hidden models change without a new
 * key) and wiring profiles. Writes are committed when the promise resolves.
 */
export interface AgentWiringStore {
  /** Replaces `modelAllow` and `modelDeny` (empty removes it); false when the key does not exist. */
  setGatewayKeyModels(
    keyId: GatewayKeyId,
    modelAllow: string[],
    modelDeny: string[],
  ): Promise<boolean>;
  /** By name. */
  listWiringProfiles(): Promise<WiringProfile[]>;
  getWiringProfile(name: string): Promise<WiringProfile | undefined>;
  /** Inserts or replaces by name. */
  putWiringProfile(profile: WiringProfile): Promise<void>;
  deleteWiringProfile(name: string): Promise<boolean>;
}

/** Persistence of providers, groups, keys, ledger and wirings. Writes are committed when the promise resolves. */
export interface ModelPlaneStore {
  listProviders(): Promise<ProviderConfig[]>;
  getProvider(id: ProviderId): Promise<ProviderConfig | undefined>;
  /** Inserts or replaces by id. */
  putProvider(provider: ProviderConfig): Promise<void>;
  deleteProvider(id: ProviderId): Promise<boolean>;

  listRouteGroups(): Promise<RouteGroup[]>;
  getRouteGroup(id: RouteGroupId): Promise<RouteGroup | undefined>;
  putRouteGroup(group: RouteGroup): Promise<void>;
  deleteRouteGroup(id: RouteGroupId): Promise<boolean>;

  createGatewayKey(record: GatewayKeyRecord): Promise<void>;
  getGatewayKey(keyId: GatewayKeyId): Promise<GatewayKeyRecord | undefined>;
  listGatewayKeys(): Promise<GatewayKeyRecord[]>;
  revokeGatewayKey(keyId: GatewayKeyId, at: string): Promise<boolean>;
  touchGatewayKey(keyId: GatewayKeyId, at: string): Promise<void>;

  /** Commits one ledger entry; rejects when the store cannot write (the gateway then answers 503). */
  appendModelCall(entry: ModelCallEntry): Promise<void>;
  listModelCalls(
    filter: UsageFilter,
    page: { limit: number; cursor?: string },
  ): Promise<{ items: ModelCallEntry[]; nextCursor?: string }>;
  aggregateUsage(
    filter: UsageFilter,
    groupBy: UsageGroupBy,
  ): Promise<UsageBucket[]>;

  listWirings(): Promise<WiringRecord[]>;
  putWiring(record: WiringRecord): Promise<void>;
  deleteWiring(adapterId: string): Promise<boolean>;
}
