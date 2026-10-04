// SPDX-License-Identifier: MIT
/**
 * JSON Schemas of the `/api/v1` model-plane routes: request validation (Ajv)
 * and response serialization and OpenAPI both use them. Field rules follow
 * `@harnesshub/core/model-plane`; the record validators of
 * `@harnesshub/core/model-plane-records` remain the authority before a write.
 */
import { metadataFields } from "@harnesshub/core/model-metadata";
import {
  droppableFields,
  providerPatches,
  wireProtocols,
} from "@harnesshub/core/model-plane";
import {
  copilotAuthModes,
  subscriptionBackends,
} from "@harnesshub/core/subscriptions";

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const slug = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
} as const;
const timestamp = { type: "string", format: "date-time" } as const;
const count = { type: "integer", minimum: 0 } as const;
const positive = { type: "integer", minimum: 1 } as const;
const amount = { type: "number", minimum: 0 } as const;
const protocol = { enum: [...wireProtocols] } as const;
const strings = (maxLength: number, maxItems = 1000) =>
  ({ type: "array", maxItems, items: text(maxLength) }) as const;
const modelRefText = {
  type: "string",
  minLength: 3,
  maxLength: 512,
  pattern: "^[a-z0-9][a-z0-9-]{0,62}/\\S+$",
} as const;
const allowEntry = { ...modelRefText, maxLength: 600 } as const;
/** A stored allow or deny entry: also `*`, which agent keys use for every model. */
const storedAllowEntry = {
  anyOf: [allowEntry, { const: "*" }],
} as const;

/** Problem details (RFC 9457) of every `/api/v1` error response. */
export const problemSchema = {
  type: "object",
  required: ["type", "title", "status", "code", "requestId"],
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    requestId: { type: "string" },
    errors: {
      type: "array",
      items: {
        type: "object",
        required: ["detail"],
        properties: {
          pointer: { type: "string" },
          parameter: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    references: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "id"],
        properties: { type: { type: "string" }, id: { type: "string" } },
      },
    },
  },
} as const;

/** Success response plus the problem object for every error status. */
export function responses(schema: object, code = 200) {
  return { [code]: schema, default: problemSchema };
}
export const noContent = {
  204: { type: "null", description: "No content" },
  default: problemSchema,
} as const;

export const idParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: text(100) },
} as const;
export const credentialParams = {
  type: "object",
  additionalProperties: false,
  required: ["id", "credentialId"],
  properties: { id: text(100), credentialId: text(200) },
} as const;

const secretReference = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "value"],
  properties: {
    kind: { enum: ["env", "file", "keychain", "store"] },
    value: text(8192),
  },
} as const;
const endpointUrl = text(2048);
const endpoints = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(
    wireProtocols.map((name) => [name, endpointUrl]),
  ),
} as const;
const apiKeyHeader = {
  type: "string",
  pattern:
    "^(authorization-bearer|x-api-key|api-key|x-goog-api-key|query-key|custom:[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128})$",
} as const;
const headers = {
  type: "object",
  maxProperties: 64,
  additionalProperties: { type: "string", maxLength: 8192 },
} as const;
const price = {
  type: "object",
  additionalProperties: false,
  properties: {
    input: amount,
    output: amount,
    cacheRead: amount,
    cacheWrite: amount,
  },
} as const;
const providerModel = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: text(512),
    wire: text(512),
    contextWindow: positive,
    maxOutputTokens: positive,
    reasoning: { type: "boolean" },
    inputModalities: {
      type: "array",
      items: { enum: ["text", "image", "pdf", "audio", "video"] },
    },
    price,
  },
} as const;
const providerModels = {
  type: "object",
  additionalProperties: false,
  required: ["source", "list", "expose"],
  properties: {
    source: { enum: ["live", "catalog", "static", "manual"] },
    list: { type: "array", maxItems: 10_000, items: providerModel },
    expose: {
      anyOf: [{ type: "string", enum: ["all"] }, strings(512, 10_000)],
    },
    refreshedAt: timestamp,
    stale: { type: "boolean" },
    listPath: { type: "string", pattern: "^/\\S{0,511}$" },
  },
} as const;
const patchSet = {
  type: "object",
  additionalProperties: false,
  required: ["patches"],
  properties: {
    patches: { type: "array", items: { enum: [...providerPatches] } },
    dropFields: { type: "array", items: { enum: [...droppableFields] } },
    anthropicBetaAllow: strings(200, 100),
  },
} as const;
const patches = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(wireProtocols.map((name) => [name, patchSet])),
} as const;
const capabilities = {
  type: "object",
  additionalProperties: false,
  properties: { requiresReasoningReplay: { type: "boolean" } },
} as const;
const wire = {
  type: "object",
  maxProperties: 10_000,
  additionalProperties: text(512),
} as const;

export const credentialSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "ref", "enabled"],
  properties: {
    id: text(200),
    name: text(200),
    ref: secretReference,
    protocols: { type: "array", items: protocol },
    enabled: { type: "boolean" },
    account: {
      type: "object",
      additionalProperties: false,
      // ChatGPT accounts carry `clientId`; Copilot accounts `auth` and `host`.
      required: ["backend", "subject", "consent"],
      properties: {
        backend: { type: "string", enum: [...subscriptionBackends] },
        subject: text(512),
        email: text(320),
        clientId: text(512),
        auth: { type: "string", enum: [...copilotAuthModes] },
        host: text(512),
        consent: {
          type: "object",
          additionalProperties: false,
          required: ["notice", "acceptedAt"],
          properties: { notice: text(200), acceptedAt: timestamp },
        },
        signedOutAt: timestamp,
      },
    },
  },
} as const;

export const providerSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "name",
    "kind",
    "endpoints",
    "auth",
    "credentials",
    "models",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    id: slug,
    name: text(200),
    kind: { enum: ["vendor", "relay", "local", "custom"] },
    preset: text(200),
    region: slug,
    plan: slug,
    catalog: slug,
    // A Copilot provider has none: the user's installed client answers.
    endpoints: { ...endpoints, minProperties: 0 },
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["apiKeyHeader"],
      properties: { apiKeyHeader },
    },
    headers,
    credentials: { type: "array", items: credentialSchema },
    models: providerModels,
    wire,
    patches,
    capabilities,
    translateOnly: { type: "boolean" },
    imageEndpoint: text(2048),
    subscription: {
      type: "object",
      additionalProperties: false,
      required: ["backend"],
      properties: {
        backend: { type: "string", enum: [...subscriptionBackends] },
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

/**
 * `POST /providers`: either `preset` (with its `region` and `plan`; fields
 * given with it override the preset) or `id` and `endpoints`; `credential`
 * adds the first credential.
 */
export const providerCreateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    preset: slug,
    region: slug,
    plan: slug,
    catalog: slug,
    credential: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
        name: text(200),
        value: { type: "string", minLength: 1, maxLength: 8192 },
        ref: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "value"],
          properties: { kind: { enum: ["env", "file"] }, value: text(8192) },
        },
        protocols: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: protocol,
        },
        enabled: { type: "boolean" },
      },
    },
    id: slug,
    name: text(200),
    kind: providerSchema.properties.kind,
    endpoints,
    auth: providerSchema.properties.auth,
    headers,
    models: providerModels,
    wire,
    patches,
    capabilities,
    translateOnly: { type: "boolean" },
    imageEndpoint: text(2048),
  },
} as const;

const presetModelSource = {
  type: "string",
  enum: ["live", "static", "catalog"],
} as const;

/** A shipped provider preset (`GET /presets`). */
export const presetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "name",
    "kind",
    "verified",
    "auth",
    "endpoints",
    "models",
  ],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    id: slug,
    name: text(200),
    kind: providerSchema.properties.kind,
    icon: { type: "string", description: "lobehub icon slug" },
    website: { type: "string" },
    keysUrl: { type: "string" },
    catalog: { type: "string" },
    verified: {
      type: "string",
      description: "YYYY-MM-DD the endpoints were checked, or unverified",
    },
    source: {
      type: "string",
      description:
        "Where the data came from when not from the vendor, <project>@<commit>",
    },
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["methods", "apiKeyHeader"],
      properties: {
        methods: {
          type: "array",
          items: { type: "string", enum: ["api-key", "none"] },
        },
        apiKeyHeader,
      },
    },
    endpoints,
    userEndpoint: { type: "boolean", enum: [true] },
    regions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "endpoints"],
        properties: {
          id: slug,
          name: { type: "string" },
          endpoints,
          keysUrl: { type: "string" },
          catalog: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
    plans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: slug,
          name: { type: "string" },
          endpoints,
          models: { type: "array", items: { type: "string" } },
          modelSource: presetModelSource,
          keysUrl: { type: "string" },
          catalog: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
    headerHints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "required"],
        properties: {
          name: { type: "string" },
          required: { type: "boolean" },
          notes: { type: "string" },
        },
      },
    },
    models: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: presetModelSource,
        listPath: { type: "string" },
        list: { type: "array", items: providerModel },
      },
    },
    fallbackModels: { type: "array", items: { type: "string" } },
    magpie: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: slug, region: slug, plan: slug },
      },
    },
    capabilities,
    patches,
    notes: { type: "string" },
  },
} as const;

/** `PATCH /providers/{id}`: JSON Merge Patch (RFC 7396); `null` removes an optional member. */
export const providerPatchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: text(200),
    kind: providerSchema.properties.kind,
    /** Only null: detaches the provider from its preset, region and plan. */
    preset: { type: "null" },
    catalog: { type: ["string", "null"], pattern: slug.pattern },
    endpoints: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        wireProtocols.map((name) => [
          name,
          { type: ["string", "null"], minLength: 1, maxLength: 2048 },
        ]),
      ),
    },
    auth: providerSchema.properties.auth,
    headers: {
      type: ["object", "null"],
      additionalProperties: { type: ["string", "null"], maxLength: 8192 },
    },
    models: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...providerModels.properties,
        refreshedAt: { type: ["string", "null"], format: "date-time" },
        stale: { type: ["boolean", "null"] },
        listPath: { type: ["string", "null"], pattern: "^/\\S{0,511}$" },
      },
    },
    wire: {
      type: ["object", "null"],
      additionalProperties: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: 512,
      },
    },
    patches: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: Object.fromEntries(
        wireProtocols.map((name) => [
          name,
          { ...patchSet, type: ["object", "null"] },
        ]),
      ),
    },
    capabilities: { ...capabilities, type: ["object", "null"] },
    translateOnly: { type: ["boolean", "null"] },
    imageEndpoint: { type: ["string", "null"], minLength: 1, maxLength: 2048 },
  },
} as const;

export const credentialCreateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    name: text(200),
    value: { type: "string", minLength: 1, maxLength: 8192 },
    ref: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value"],
      properties: { kind: { enum: ["env", "file"] }, value: text(8192) },
    },
    protocols: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: protocol,
    },
    enabled: { type: "boolean" },
  },
} as const;
export const credentialSecretSchema = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "string", minLength: 1, maxLength: 8192 } },
} as const;

const retry = {
  type: "object",
  additionalProperties: false,
  properties: {
    perCandidate: count,
    totalAttempts: count,
    baseBackoffMs: count,
    maxBackoffMs: count,
    retryAfterWaitCapMs: count,
  },
} as const;
const strategy = {
  enum: ["order", "rotate", "least-used", "latency", "smart", "pace"],
} as const;
const stickiness = { enum: ["auto", "session", "turn", "off"] } as const;
const members = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
  items: modelRefText,
} as const;

export const routeGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "strategy",
    "stickiness",
    "members",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: slug,
    strategy,
    stickiness,
    members,
    retry,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;
export const routeGroupCreateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "members"],
  properties: { id: slug, strategy, stickiness, members, retry },
} as const;
export const routeGroupPatchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    strategy,
    stickiness,
    members,
    retry: { ...retry, type: ["object", "null"] },
  },
} as const;

const scope = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["agent", "session", "client"] },
    adapterId: text(200),
    sessionId: text(200),
    name: text(200),
  },
} as const;
const quota = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestsPerMinute: positive,
    tokensPerDay: positive,
    costPerMonthUsd: amount,
  },
} as const;
export const gatewayKeySchema = {
  type: "object",
  additionalProperties: false,
  required: ["keyId", "name", "scope", "modelAllow", "createdAt"],
  properties: {
    keyId: { type: "string", pattern: "^[a-z2-7]{12}$" },
    name: text(200),
    scope,
    modelAllow: { type: "array", items: storedAllowEntry },
    modelDeny: {
      type: "array",
      items: storedAllowEntry,
      description:
        "Entries the key may not use although modelAllow admits them: the models hidden from a wired agent",
    },
    modelIdStyle: {
      enum: ["claude-alias"],
      description:
        "The key lists and takes models by Claude-style aliases (claude-hh-<digits>), for a client that keeps only Anthropic-looking ids",
    },
    quota,
    allowLan: { type: "boolean" },
    createdAt: timestamp,
    expiresAt: timestamp,
    revokedAt: timestamp,
    lastUsedAt: timestamp,
  },
} as const;
export const gatewayKeyCreateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "modelAllow"],
  properties: {
    name: text(200),
    modelAllow: {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: allowEntry,
    },
    quota,
    /** Usable on the LAN listener of gateway sharing; such a key must expire. */
    allowLan: { type: "boolean" },
    /** Absent: 90 days from now (03 section 2); null: never expires. */
    expiresAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;
export const gatewayKeyCreatedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "gatewayKey"],
  properties: {
    key: { type: "string", description: "The key text; shown only once." },
    gatewayKey: gatewayKeySchema,
  },
} as const;
export const emptyBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const money = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "currency"],
  properties: {
    amount: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
    currency: { type: "string", enum: ["USD"] },
  },
} as const;
const tokens = {
  type: "object",
  additionalProperties: false,
  required: ["input", "cacheRead", "cacheWrite", "output", "reasoning"],
  properties: {
    input: count,
    cacheRead: count,
    cacheWrite: count,
    output: count,
    reasoning: count,
  },
} as const;
const callFilter = {
  from: timestamp,
  to: timestamp,
  keyId: { type: "string", pattern: "^[a-z2-7]{12}$" },
  provider: slug,
  model: modelRefText,
  sessionId: text(200),
  /** `agent.id` of the call, established or inferred. */
  agent: text(200),
} as const;
export const modelCallsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    cursor: text(200),
    ...callFilter,
  },
} as const;
export const usageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    groupBy: {
      enum: ["day", "provider", "model", "key", "adapter", "credential"],
      default: "model",
    },
    ...callFilter,
  },
} as const;

/** A ledger conversation: lowercase hex SHA-256, scoped to its Gateway Key. */
const conversationKey = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

const attempt = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "credentialId",
    "modelRef",
    "wireModel",
    "upstreamProtocol",
    "startedAt",
    "decision",
  ],
  properties: {
    provider: slug,
    credentialId: { type: "string" },
    modelRef: { type: "string" },
    wireModel: { type: "string" },
    upstreamProtocol: protocol,
    startedAt: timestamp,
    firstByteMs: amount,
    status: { type: "integer" },
    errorClass: { type: "string" },
    retryAfterMs: amount,
    decision: { enum: ["success", "retry", "failover", "stop"] },
    backoffMs: amount,
  },
} as const;
export const modelCallSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "callId",
    "occurredAt",
    "inbound",
    "patches",
    "unmapped",
    "status",
    "timing",
    "attempts",
    "cost",
  ],
  properties: {
    callId: { type: "string" },
    occurredAt: timestamp,
    keyId: { type: "string" },
    scope,
    sessionId: { type: "string" },
    runId: { type: "string" },
    conversationKey: conversationKey,
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["id", "source"],
      properties: {
        id: { type: "string" },
        source: { enum: ["key", "user-agent", "route"] },
      },
    },
    inbound: {
      type: "object",
      additionalProperties: false,
      required: ["protocol", "path", "stream"],
      properties: {
        protocol,
        path: { type: "string" },
        stream: { type: "boolean" },
      },
    },
    requestedModel: { type: "string" },
    modelRef: { type: "string" },
    group: { type: "string" },
    provider: { type: "string" },
    credentialId: { type: "string" },
    wireModel: { type: "string" },
    upstreamProtocol: protocol,
    mode: { enum: ["passthrough", "translated"] },
    servedModel: { type: "string" },
    patches: { type: "array", items: { type: "string" } },
    unmapped: { type: "array", items: { type: "string" } },
    status: { type: "integer" },
    errorClass: { type: "string" },
    errorSource: { enum: ["gateway", "upstream"] },
    error: { type: "string" },
    finishReason: { type: "string" },
    usage: {
      ...tokens,
      required: [...tokens.required, "source"],
      properties: {
        ...tokens.properties,
        source: { enum: ["reported", "estimated", "missing"] },
      },
    },
    timing: {
      type: "object",
      additionalProperties: false,
      required: ["durationMs"],
      properties: {
        firstByteMs: amount,
        firstContentMs: amount,
        durationMs: amount,
      },
    },
    attempts: { type: "array", items: attempt },
    cost: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["amount", "currency", "priceSource"],
      properties: {
        ...money.properties,
        priceSource: { type: "string" },
      },
    },
    completion: { enum: ["explicit", "inferred"] },
    rejected: { type: "boolean" },
    rejectReason: { type: "string" },
  },
} as const;
export const modelCallPageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: modelCallSchema },
    nextCursor: { type: ["string", "null"] },
  },
} as const;
export const usageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groupBy", "items"],
  properties: {
    groupBy: usageQuerySchema.properties.groupBy,
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "calls",
          "failedCalls",
          "usage",
          "cost",
          "unpricedCalls",
        ],
        properties: {
          key: {
            type: "string",
            description: "Empty for calls without the grouped attribute.",
          },
          calls: count,
          failedCalls: count,
          usage: tokens,
          cost: money,
          unpricedCalls: count,
        },
      },
    },
  },
} as const;

export const conversationsQuerySchema = modelCallsQuerySchema;
export const conversationParams = {
  type: "object",
  additionalProperties: false,
  required: ["key"],
  properties: { key: conversationKey },
} as const;
export const conversationCallsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: modelCallsQuerySchema.properties.limit,
    cursor: modelCallsQuerySchema.properties.cursor,
  },
} as const;
const conversationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "key",
    "calls",
    "failedCalls",
    "usage",
    "cost",
    "unpricedCalls",
    "firstAt",
    "lastAt",
    "models",
    "credentials",
    "agents",
  ],
  properties: {
    key: conversationKey,
    calls: count,
    failedCalls: count,
    usage: tokens,
    cost: money,
    unpricedCalls: count,
    firstAt: timestamp,
    lastAt: timestamp,
    models: { type: "array", items: { type: "string" } },
    credentials: {
      type: "array",
      description: "`<provider>/<credentialId>` of each credential used.",
      items: { type: "string" },
    },
    agents: { type: "array", items: { type: "string" } },
  },
} as const;
export const conversationPageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: conversationSchema },
    nextCursor: { type: ["string", "null"] },
  },
} as const;

export const autoGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "model", "members", "hidden", "createdAt"],
  properties: {
    id: slug,
    model: {
      type: "string",
      description: "The model name the members share.",
    },
    members,
    hidden: { type: "boolean" },
    createdAt: timestamp,
  },
} as const;

const modality = { enum: ["text", "image", "pdf", "audio", "video"] } as const;

/** `provider/model`, or `provider/*` for an override of all the provider's models. */
export const modelRefParams = {
  type: "object",
  additionalProperties: false,
  required: ["ref"],
  properties: { ref: { ...modelRefText, maxLength: 600 } },
} as const;

const overrideValues = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    contextWindow: positive,
    maxOutputTokens: positive,
    reasoning: { type: "boolean" },
    inputModalities: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: modality,
    },
    toolCall: { type: "boolean" },
    price: {
      ...price,
      minProperties: 1,
      description: "USD per million tokens",
    },
  },
} as const;
export const modelOverrideBodySchema = overrideValues;
export const modelOverrideSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "values", "updatedAt"],
  properties: {
    ref: { type: "string" },
    values: overrideValues,
    updatedAt: timestamp,
  },
} as const;

const resolvedField = {
  type: "object",
  additionalProperties: false,
  required: ["value", "source"],
  properties: {
    value: {
      anyOf: [
        { type: "number" },
        { type: "boolean" },
        { type: "array", items: modality },
      ],
    },
    source: {
      enum: [
        "override",
        "override-provider",
        "provider",
        "live",
        "preset",
        "catalog",
      ],
      description:
        "override: the model's override; override-provider: the provider/* override; provider: set on the provider's model entry; live: the provider's model list; preset: the provider preset; catalog: the bundled models.dev snapshot",
    },
    at: {
      type: "string",
      description:
        "When the source produced the value: an ISO 8601 date-time, or the date a preset was verified",
    },
  },
} as const;

/** One model's metadata, field by field, with source and time (03 section 7). */
export const modelMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "listed", "fields", "unknown", "overrides"],
  properties: {
    ref: { type: "string" },
    listed: {
      type: "boolean",
      description: "Whether the provider's model list has this model",
    },
    fields: {
      type: "object",
      additionalProperties: false,
      description:
        "Known fields; price.* are USD per million tokens. Unknown fields are absent, never defaulted.",
      properties: Object.fromEntries(
        metadataFields.map((field) => [field, resolvedField]),
      ),
    },
    unknown: { type: "array", items: { enum: [...metadataFields] } },
    overrides: {
      type: "array",
      items: modelOverrideSchema,
      description: "The stored provider/* override and this model's, if any",
    },
  },
} as const;

/** `GET /api/v1/catalog` and `POST /api/v1/catalog/refresh`. */
export const catalogStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "source",
    "snapshot",
    "url",
    "autoRefresh",
    "lastRefresh",
    "nextRefreshAt",
  ],
  properties: {
    source: {
      enum: ["bundled", "refreshed"],
      description:
        "The catalog in use: the snapshot bundled with this build, or the copy of the last successful refresh",
    },
    snapshot: {
      type: "object",
      additionalProperties: false,
      required: [
        "source",
        "repository",
        "license",
        "retrievedAt",
        "etag",
        "commit",
        "sha256",
        "bytes",
        "providers",
        "models",
      ],
      properties: {
        source: { type: "string" },
        repository: { type: "string" },
        license: { type: "string" },
        retrievedAt: timestamp,
        etag: { type: ["string", "null"] },
        commit: {
          type: ["string", "null"],
          description:
            "models.dev repository commit seen at retrieval; null for a refreshed copy",
        },
        sha256: {
          type: "string",
          description: "SHA-256 of the full upstream api.json",
        },
        bytes: { ...count, description: "Size of the full upstream api.json" },
        providers: count,
        models: count,
      },
    },
    url: { type: "string", description: "Where refreshes are fetched from" },
    autoRefresh: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        disabledBy: {
          enum: ["setting", "offline"],
          description: "catalog.autoRefresh: false, or HH_OFFLINE=1",
        },
      },
    },
    lastRefresh: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["at", "outcome"],
      properties: {
        at: timestamp,
        outcome: { enum: ["updated", "unchanged", "failed"] },
        error: { type: "string" },
      },
    },
    nextRefreshAt: {
      type: ["string", "null"],
      description:
        "When the next background refresh is due; null while it is off",
    },
  },
} as const;

/** `{items, nextCursor: null}`: configuration lists are returned whole. */
export function listOf(item: object) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "nextCursor"],
    properties: {
      items: { type: "array", items: item },
      nextCursor: { type: ["string", "null"] },
    },
  } as const;
}

export const systemInfoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "apiVersion",
    "version",
    "commit",
    "pid",
    "startedAt",
    "dataDir",
    "secretBackend",
    "gateway",
  ],
  properties: {
    apiVersion: { type: "string", enum: ["v1"] },
    version: { type: "string" },
    commit: { type: "string" },
    pid: { type: "integer" },
    startedAt: timestamp,
    dataDir: { type: "string" },
    secretBackend: { enum: ["keychain", "dpapi", "file"] },
    gateway: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["openaiBaseUrl", "anthropicBaseUrl", "geminiBaseUrl"],
      description:
        "Model gateway base URLs for local clients: OpenAI SDK baseURL (with /v1), Anthropic and Gemini base (without a version)",
      properties: {
        openaiBaseUrl: { type: "string" },
        anthropicBaseUrl: { type: "string" },
        geminiBaseUrl: { type: "string" },
      },
    },
  },
} as const;

const lanSettings = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    host: {
      ...text(64),
      description:
        "IP address the LAN listener binds; 0.0.0.0 or :: for every address",
    },
    port: { type: "integer", minimum: 0, maximum: 65535 },
    names: { ...strings(253, 20), description: "Further Host names of peers" },
  },
} as const;

/** `PUT /api/v1/gateway/share`: the whole sharing settings document. */
export const gatewaySharePutSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lan"],
  properties: { lan: lanSettings, publicBaseUrl: text(500) },
} as const;

/** The sharing settings and the LAN listener's state. */
export const gatewayShareSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lan", "listening", "urls"],
  properties: {
    lan: { ...lanSettings, required: ["enabled", "names"] },
    publicBaseUrl: { type: "string" },
    listening: { type: "boolean" },
    boundPort: { type: "integer" },
    urls: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
} as const;

/** `POST /import/preview`: an import link, or an app whose configuration is read. */
export const importPreviewRequestSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    link: { type: "string", minLength: 1, maxLength: 16_384 },
    app: { enum: ["claude-code", "codex"] },
  },
} as const;

const importKey = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["none", "value", "env"] },
    last4: { type: "string" },
    variable: { type: "string" },
  },
} as const;

/** One provider of an import preview; a key is shown by its last four characters at most. */
const importItem = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "status", "hosts", "key"],
  properties: {
    ref: { type: "string" },
    status: { enum: ["new", "exists", "skipped"] },
    reason: { type: "string" },
    provider: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "kind",
        "endpoints",
        "apiKeyHeader",
        "models",
        "headers",
      ],
      properties: {
        id: slug,
        name: { type: "string" },
        kind: providerSchema.properties.kind,
        preset: { type: "string" },
        region: { type: "string" },
        plan: { type: "string" },
        catalog: { type: "string" },
        endpoints,
        apiKeyHeader: { type: "string" },
        models: { type: "array", items: { type: "string" } },
        headers: { type: "array", items: { type: "string" } },
      },
    },
    hosts: { type: "array", items: { type: "string" } },
    key: importKey,
    website: { type: "string" },
    keysUrl: { type: "string" },
  },
} as const;

export const importPreviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["previewId", "expiresAt", "source", "items", "warnings"],
  properties: {
    previewId: { type: "string" },
    expiresAt: timestamp,
    source: { enum: ["link", "claude-code", "codex"] },
    file: { type: "string" },
    items: { type: "array", items: importItem },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

/** `POST /import/apply`: a preview, and optionally which of its items. */
export const importApplySchema = {
  type: "object",
  additionalProperties: false,
  required: ["previewId"],
  properties: {
    previewId: { type: "string", pattern: "^[A-Za-z0-9_-]{22}$" },
    refs: strings(200, 100),
  },
} as const;

export const importAppliedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "status"],
        properties: {
          ref: { type: "string" },
          status: { enum: ["created", "skipped", "failed"] },
          reason: { type: "string" },
          code: { type: "string" },
          provider: providerSchema,
        },
      },
    },
  },
} as const;
