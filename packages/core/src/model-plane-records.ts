// SPDX-License-Identifier: MIT
/**
 * Validators of the model-plane records (`./model-plane.ts`), shared by the
 * store (before writing and when reading back, where records are `unknown`
 * until checked) and the `/api/v1` routes. They check shape, closed sets and
 * identifier formats, not cross-record references.
 */
import {
  budgetPeriods,
  callPurposes,
  droppableFields,
  isGatewayKeyId,
  isModelPattern,
  isProviderId,
  parseModelRef,
  maxTokensFields,
  providerPatches,
  reasoningEfforts,
  wireProtocols,
  wiringTiers,
  type GatewayKeyQuota,
  type GatewayKeyRecord,
  type ModelCallEntry,
  type ProviderConfig,
  type RouteGroup,
  type WireProtocol,
  type WiringProfile,
  type WiringRecord,
} from "./model-plane.js";
import { proxyChoiceProblem } from "./outbound.js";
import { parseGroupMember } from "./route-groups.js";
import { cleanGroupRules } from "./route-rules.js";
import { copilotAuthModes, subscriptionBackends } from "./subscriptions.js";

type Check = (value: unknown) => boolean;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text =
  (max = 8192): Check =>
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= max;
const anyText =
  (max: number): Check =>
  (value) =>
    typeof value === "string" && value.length <= max;
const bool: Check = (value) => typeof value === "boolean";
const count: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive: Check = (value) => count(value) && value !== 0;
const amount: Check = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const optional = (value: unknown, check: Check): boolean =>
  value === undefined || check(value);
const member =
  (values: readonly string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
const list =
  (check: Check, max = 10_000): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(check);
const sha256: Check = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const protocol = (value: unknown): value is WireProtocol =>
  member(wireProtocols)(value);

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 date-time with seconds and an explicit offset, e.g. `Date#toISOString()`. */
export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

const modelRef: Check = (value) =>
  typeof value === "string" && parseModelRef(value)?.kind === "model";
const groupId: Check = (value) =>
  typeof value === "string" &&
  parseModelRef(`group/${value}`)?.kind === "group";
const providerId: Check = (value) =>
  typeof value === "string" && isProviderId(value);
const keyId: Check = (value) =>
  typeof value === "string" && isGatewayKeyId(value);
const slug: Check = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);

const secretReference: Check = (value) =>
  object(value) &&
  member(["env", "file", "keychain", "store"])(value.kind) &&
  text()(value.value);

const apiKeyHeader: Check = (value) =>
  member([
    "authorization-bearer",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "query-key",
  ])(value) ||
  (typeof value === "string" &&
    /^custom:[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value));

/** Loopback names and addresses, and RFC 1918 private IPv4 addresses. */
function localHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]"
  )
    return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!octets) return false;
  const first = Number(octets[1]);
  const second = Number(octets[2]);
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

const operationPaths = [
  "/chat/completions",
  "/responses",
  "/messages",
  ":generateContent",
  ":streamGenerateContent",
];

/** Version segments the gateway appends itself, so a base must not end with them. */
const appendedVersions: Partial<Record<WireProtocol, RegExp>> = {
  anthropic: /\/v1$/,
  gemini: /\/v1(?:beta|alpha)?$/,
};

/**
 * Why `url` cannot be the base URL of a `protocol` endpoint, or `undefined`
 * when it can (03-model-plane section 4). A base is what the vendor's official
 * SDK uses: chat and responses bases include the version (`.../v1`), the
 * gateway appends `/chat/completions` or `/responses`; anthropic bases exclude
 * it (the gateway appends `/v1/messages`); gemini bases exclude it (the
 * gateway appends `/{v1beta|v1|v1alpha}/models/...`). A base uses HTTPS (plain
 * HTTP only for loopback and RFC 1918 hosts) and has no credentials, query,
 * fragment or operation path.
 */
export function endpointProblem(
  protocol: WireProtocol,
  url: string,
): string | undefined {
  if (!URL.canParse(url)) return "is not a URL";
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    if (!localHost(parsed.hostname))
      return "must use HTTPS unless the host is loopback or a private address";
  } else if (parsed.protocol !== "https:") return "must use HTTPS";
  if (parsed.username || parsed.password) return "must not contain credentials";
  if (url.includes("?") || url.includes("#"))
    return "must not contain a query or fragment";
  const path = parsed.pathname.replace(/\/+$/, "");
  const operation = operationPaths.find((suffix) => path.endsWith(suffix));
  if (operation)
    return `must be the base URL, without the operation path ${operation}`;
  if (appendedVersions[protocol]?.test(path))
    return `must not end with the API version, which the gateway appends for ${protocol}`;
  return undefined;
}

const endpoints: Check = (value) =>
  object(value) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(
    ([name, url]) =>
      protocol(name) &&
      typeof url === "string" &&
      url.length <= 2048 &&
      endpointProblem(name, url) === undefined,
  );

const subscriptionAccount: Check = (value) =>
  object(value) &&
  member(subscriptionBackends)(value.backend) &&
  text(512)(value.subject) &&
  optional(value.email, text(320)) &&
  (value.backend === "siwc"
    ? text(512)(value.clientId)
    : member(copilotAuthModes)(value.auth) && text(512)(value.host)) &&
  object(value.consent) &&
  text(200)(value.consent.notice) &&
  isTimestamp(value.consent.acceptedAt) &&
  optional(value.signedOutAt, isTimestamp);

const credential: Check = (value) =>
  object(value) &&
  text(200)(value.id) &&
  text(200)(value.name) &&
  secretReference(value.ref) &&
  optional(value.protocols, list(protocol)) &&
  bool(value.enabled) &&
  optional(value.account, subscriptionAccount);

const credentials: Check = (value) =>
  list(credential, 100)(value) &&
  Array.isArray(value) &&
  new Set(value.map((item: { id: unknown }) => item.id)).size === value.length;

const price: Check = (value) =>
  object(value) &&
  optional(value.input, amount) &&
  optional(value.output, amount) &&
  optional(value.cacheRead, amount) &&
  optional(value.cacheWrite, amount);

const providerModel: Check = (value) =>
  object(value) &&
  text(512)(value.id) &&
  optional(value.wire, text(512)) &&
  optional(value.contextWindow, positive) &&
  optional(value.maxOutputTokens, positive) &&
  optional(value.reasoning, bool) &&
  optional(
    value.inputModalities,
    list(member(["text", "image", "pdf", "audio", "video"])),
  ) &&
  optional(value.price, price);

const providerModels: Check = (value) =>
  object(value) &&
  member(["live", "catalog", "static", "manual"])(value.source) &&
  list(providerModel)(value.list) &&
  (value.expose === "all" || list(text(512))(value.expose)) &&
  optional(value.refreshedAt, isTimestamp) &&
  optional(value.stale, bool) &&
  optional(
    value.listPath,
    (path) => typeof path === "string" && /^\/\S{0,511}$/.test(path),
  );

const patchSet: Check = (value) =>
  object(value) &&
  list(member(providerPatches))(value.patches) &&
  optional(value.dropFields, list(member(droppableFields))) &&
  optional(value.anthropicBetaAllow, list(text(200))) &&
  optional(value.maxTokensField, member(maxTokensFields));

const record =
  (check: Check, keys: Check = text(512)): Check =>
  (value) =>
    object(value) &&
    Object.entries(value).every(([key, item]) => keys(key) && check(item));

export function isProviderConfig(value: unknown): value is ProviderConfig {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    providerId(value.id) &&
    text(200)(value.name) &&
    member(["vendor", "relay", "local", "custom"])(value.kind) &&
    optional(value.preset, text(200)) &&
    optional(value.region, slug) &&
    optional(value.plan, slug) &&
    // A region or plan names a choice of the preset, so it needs one.
    (value.preset !== undefined ||
      (value.region === undefined && value.plan === undefined)) &&
    optional(value.catalog, slug) &&
    // Copilot answers through the user's installed client, not an endpoint.
    (object(value.subscription) && value.subscription.backend === "copilot"
      ? object(value.endpoints) && Object.keys(value.endpoints).length === 0
      : endpoints(value.endpoints)) &&
    object(value.auth) &&
    apiKeyHeader(value.auth.apiKeyHeader) &&
    optional(value.headers, record(anyText(8192))) &&
    credentials(value.credentials) &&
    providerModels(value.models) &&
    optional(value.wire, record(text(512))) &&
    optional(value.patches, record(patchSet, protocol)) &&
    optional(
      value.capabilities,
      (capabilities) =>
        object(capabilities) &&
        optional(capabilities.requiresReasoningReplay, bool),
    ) &&
    optional(value.translateOnly, bool) &&
    optional(
      value.imageEndpoint,
      (url) =>
        typeof url === "string" &&
        url.length <= 2048 &&
        /^https?:\/\/[^\s]+$/.test(url) &&
        !url.includes("/images/generations"),
    ) &&
    optional(
      value.subscription,
      (subscription) =>
        object(subscription) &&
        member(subscriptionBackends)(subscription.backend),
    ) &&
    optional(
      value.proxy,
      (proxy) =>
        proxyChoiceProblem(proxy) === undefined &&
        // The Copilot CLI makes a Copilot provider's requests itself.
        !(
          object(value.subscription) && value.subscription.backend === "copilot"
        ),
    ) &&
    // Accounts belong to subscription providers, and only of their backend.
    Array.isArray(value.credentials) &&
    value.credentials.every((item: unknown) => {
      const account = object(item) ? item.account : undefined;
      return object(value.subscription)
        ? object(account) && account.backend === value.subscription.backend
        : account === undefined;
    }) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

const retry: Check = (value) =>
  object(value) &&
  Object.entries(value).every(
    ([name, item]) =>
      member([
        "perCandidate",
        "totalAttempts",
        "baseBackoffMs",
        "maxBackoffMs",
        "retryAfterWaitCapMs",
      ])(name) && count(item),
  );

/** A rule's fields have their types; what they say is checked by `cleanGroupRules`. */
const groupRule: Check = (value) =>
  object(value) &&
  Object.keys(value).every((name) =>
    [
      "use",
      "tokens",
      "images",
      "effort",
      "agents",
      "intent",
      "compact",
      "time",
    ].includes(name),
  ) &&
  text(1000)(value.use) &&
  optional(value.tokens, positive) &&
  optional(value.images, bool) &&
  optional(value.effort, text(16)) &&
  optional(value.agents, list(text(64), 20)) &&
  optional(value.intent, text(1000)) &&
  optional(value.compact, bool) &&
  optional(
    value.time,
    (time) =>
      object(time) &&
      Object.keys(time).every((name) =>
        ["from", "to", "days"].includes(name),
      ) &&
      text(5)(time.from) &&
      text(5)(time.to) &&
      optional(time.days, list(text(3), 7)),
  );

/**
 * Whether `value` is a stored route group: its members, and its rules,
 * classifier and effort as `cleanGroupRules` accepts them and already in
 * the form it puts them in.
 */
export function isRouteGroup(value: unknown): value is RouteGroup {
  if (!(
    object(value) &&
    optional(value.rules, list(groupRule, 50)) &&
    optional(value.classifier, text(1000)) &&
    optional(value.effort, member(["auto"])) &&
    list(groupMember, 100)(value.members)
  ))
    return false;
  const checked = cleanGroupRules(value as unknown as RouteGroup);
  if (
    checked.problems.length ||
    JSON.stringify(checked.rules ?? []) !== JSON.stringify(value.rules ?? [])
  )
    return false;
  return (
    object(value) &&
    groupId(value.id) &&
    member(["order", "rotate", "least-used", "latency", "smart", "pace"])(
      value.strategy,
    ) &&
    member(["auto", "session", "turn", "off"])(value.stickiness) &&
    list(groupMember, 100)(value.members) &&
    Array.isArray(value.members) &&
    value.members.length > 0 &&
    new Set(value.members).size === value.members.length &&
    optional(value.retry, retry) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

const scope: Check = (value) => {
  if (!object(value)) return false;
  switch (value.kind) {
    case "agent":
      return text(200)(value.adapterId);
    case "session":
      return text(200)(value.sessionId);
    case "client":
      return text(200)(value.name);
    default:
      return false;
  }
};

/** A route group's member: a Model Ref with its suffixes, or `group/<id>`. */
const groupMember: Check = (value) =>
  typeof value === "string" && parseGroupMember(value) !== undefined;

/** A key budget: a period and at least one cap above zero. */
export function isGatewayKeyBudget(value: unknown): boolean {
  return (
    object(value) &&
    Object.keys(value).every((name) =>
      ["period", "tokens", "costUsd", "cacheReads"].includes(name),
    ) &&
    member(budgetPeriods)(value.period) &&
    optional(value.tokens, count) &&
    optional(value.costUsd, amount) &&
    optional(value.cacheReads, bool) &&
    (value.tokens !== undefined || value.costUsd !== undefined)
  );
}

/** Whether `value` is a key's `quota`: a per-minute rate and at most one budget per period. */
export function isGatewayKeyQuota(value: unknown): value is GatewayKeyQuota {
  return quota(value);
}

const quota: Check = (value) =>
  object(value) &&
  Object.keys(value).every((name) =>
    ["requestsPerMinute", "budgets"].includes(name),
  ) &&
  optional(value.requestsPerMinute, positive) &&
  optional(
    value.budgets,
    (budgets) =>
      list(isGatewayKeyBudget, budgetPeriods.length)(budgets) &&
      new Set((budgets as { period: string }[]).map((item) => item.period))
        .size === (budgets as unknown[]).length,
  );

const modelPattern: Check = (value) =>
  typeof value === "string" && isModelPattern(value);

/** Whether `value` is a key's `modelAllow` or `modelDeny`: at most 1000 Model Refs, `provider/*`, `group/<id>` or `*`. */
export function isModelPatternList(value: unknown): value is string[] {
  return list(modelPattern, 1000)(value);
}

export function isGatewayKeyRecord(value: unknown): value is GatewayKeyRecord {
  return (
    object(value) &&
    keyId(value.keyId) &&
    text(200)(value.name) &&
    scope(value.scope) &&
    list(modelPattern, 1000)(value.modelAllow) &&
    optional(value.modelDeny, list(modelPattern, 1000)) &&
    optional(value.modelIdStyle, member(["claude-alias"])) &&
    optional(value.quota, quota) &&
    optional(
      value.allowLan,
      (allow) =>
        typeof allow === "boolean" &&
        (!allow || (object(value.scope) && value.scope.kind === "client")),
    ) &&
    sha256(value.secretHash) &&
    isTimestamp(value.createdAt) &&
    optional(value.expiresAt, isTimestamp) &&
    optional(value.revokedAt, isTimestamp) &&
    optional(value.lastUsedAt, isTimestamp)
  );
}

const usage: Check = (value) =>
  object(value) &&
  count(value.input) &&
  count(value.cacheRead) &&
  count(value.cacheWrite) &&
  count(value.output) &&
  count(value.reasoning) &&
  member(["reported", "estimated", "missing"])(value.source);

const status: Check = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 100 &&
  value <= 599;

const attempt: Check = (value) =>
  object(value) &&
  providerId(value.provider) &&
  text(200)(value.credentialId) &&
  modelRef(value.modelRef) &&
  text(512)(value.wireModel) &&
  protocol(value.upstreamProtocol) &&
  isTimestamp(value.startedAt) &&
  optional(value.firstByteMs, amount) &&
  optional(value.status, status) &&
  optional(value.errorClass, text(200)) &&
  optional(value.retryAfterMs, amount) &&
  member(["success", "retry", "failover", "stop"])(value.decision) &&
  optional(value.backoffMs, amount);

const cost: Check = (value) =>
  value === null ||
  (object(value) && amount(value.amountUsd) && text(200)(value.priceSource));

const agent: Check = (value) =>
  object(value) &&
  text(200)(value.id) &&
  member(["key", "user-agent", "route"])(value.source);

export function isModelCallEntry(value: unknown): value is ModelCallEntry {
  return (
    object(value) &&
    text(200)(value.callId) &&
    isTimestamp(value.occurredAt) &&
    optional(value.keyId, keyId) &&
    optional(value.scope, scope) &&
    optional(value.sessionId, text(200)) &&
    optional(value.runId, text(200)) &&
    optional(value.generation, amount) &&
    optional(value.conversationKey, sha256) &&
    optional(value.agent, agent) &&
    optional(value.purpose, member(callPurposes)) &&
    object(value.inbound) &&
    protocol(value.inbound.protocol) &&
    text(2048)(value.inbound.path) &&
    bool(value.inbound.stream) &&
    optional(value.requestedModel, anyText(1024)) &&
    optional(value.modelRef, modelRef) &&
    optional(value.group, groupId) &&
    optional(value.provider, providerId) &&
    optional(value.credentialId, text(200)) &&
    optional(value.wireModel, text(512)) &&
    optional(value.upstreamProtocol, protocol) &&
    optional(value.mode, member(["passthrough", "translated"])) &&
    optional(value.servedModel, anyText(1024)) &&
    list(text(200), 100)(value.patches) &&
    list(text(512), 1000)(value.unmapped) &&
    status(value.status) &&
    optional(value.errorClass, text(200)) &&
    optional(value.errorSource, member(["gateway", "upstream"])) &&
    optional(value.error, anyText(500)) &&
    optional(value.finishReason, text(200)) &&
    optional(value.usage, usage) &&
    object(value.timing) &&
    optional(value.timing.firstByteMs, amount) &&
    optional(value.timing.firstContentMs, amount) &&
    amount(value.timing.durationMs) &&
    list(attempt, 100)(value.attempts) &&
    cost(value.cost) &&
    optional(value.completion, member(["explicit", "inferred"])) &&
    optional(value.rejected, bool) &&
    optional(value.rejectReason, text(200))
  );
}

const wiredFile: Check = (value) =>
  object(value) &&
  text(4096)(value.path) &&
  optional(value.beforeHash, sha256) &&
  sha256(value.afterHash) &&
  optional(value.backupId, text(200));

const wiringModel: Check = (value) =>
  typeof value === "string" &&
  value.length <= 1024 &&
  parseModelRef(value) !== undefined;

/** The fields of a `WiringChoice`, on a record or a profile entry. */
function wiringChoice(value: Record<string, unknown>): boolean {
  return (
    optional(value.model, wiringModel) &&
    optional(
      value.tiers,
      (tiers) =>
        object(tiers) &&
        Object.entries(tiers).every(
          ([tier, model]) => member(wiringTiers)(tier) && wiringModel(model),
        ),
    ) &&
    optional(value.effort, member(reasoningEfforts)) &&
    optional(
      value.options,
      (options) =>
        object(options) &&
        Object.keys(options).length <= 20 &&
        Object.entries(options).every(
          ([name, item]) => text(64)(name) && text(200)(item),
        ),
    )
  );
}

export function isWiringRecord(value: unknown): value is WiringRecord {
  return (
    object(value) &&
    text(200)(value.adapterId) &&
    optional(value.keyId, keyId) &&
    wiringChoice(value) &&
    list(wiredFile, 100)(value.files) &&
    isTimestamp(value.wiredAt)
  );
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether `name` can name a wiring profile. */
export function isWiringProfileName(name: unknown): name is string {
  return typeof name === "string" && PROFILE_NAME.test(name);
}

export function isWiringProfile(value: unknown): value is WiringProfile {
  return (
    object(value) &&
    isWiringProfileName(value.name) &&
    object(value.agents) &&
    Object.keys(value.agents).length <= 200 &&
    Object.entries(value.agents).every(
      ([adapterId, choice]) =>
        text(200)(adapterId) && object(choice) && wiringChoice(choice),
    ) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}
