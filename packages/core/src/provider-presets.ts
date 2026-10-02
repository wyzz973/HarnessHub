// SPDX-License-Identifier: MIT
/**
 * Provider presets (03-model-plane section 4): data files
 * `packages/gateway/presets/<id>.json` that describe a vendor, relay or local
 * server well enough to create a provider from it. The gateway package loads
 * them; the API lists them and expands one into a `ProviderConfig`.
 */
import { Ajv } from "ajv";
import {
  droppableFields,
  providerPatches,
  wireProtocols,
  type ApiKeyHeader,
  type ProviderConfig,
  type ProviderId,
  type ProviderKind,
  type ProviderModel,
  type WireProtocol,
} from "./model-plane.js";

export interface ProviderPreset {
  schemaVersion: 1;
  /** Also the file name and the default provider ID. */
  id: string;
  name: string;
  kind: ProviderKind;
  website?: string;
  /** Where users create API keys. */
  keysUrl?: string;
  /** models.dev provider ID, for metadata and prices. */
  catalog?: string;
  /**
   * The date (YYYY-MM-DD) the endpoints and auth were checked against the
   * vendor's documentation, or "unverified".
   */
  verified: string;
  /** `api-key`: needs a credential; `none`: local servers that accept any key or none. */
  auth: { methods: Array<"api-key" | "none">; apiKeyHeader: ApiKeyHeader };
  /** Base URLs by the convention of `endpointProblem`. */
  endpoints: Partial<Record<WireProtocol, string>>;
  models: {
    source: "live" | "static" | "catalog";
    /** Appended to the chat (or responses) base for a live list; default `/models`. */
    listPath?: string;
    /** A small, stable list; `live` presets usually leave it out. */
    list?: ProviderModel[];
  };
  capabilities?: { requiresReasoningReplay?: boolean };
  patches?: ProviderConfig["patches"];
  /** Short remark shown with the preset, e.g. that the base must be edited. */
  notes?: string;
}

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const httpsUrl = {
  type: "string",
  pattern: "^https://\\S+$",
  maxLength: 500,
} as const;
const amount = { type: "number", minimum: 0 } as const;

/** JSON Schema of a preset file; `isProviderPreset` validates with it. */
export const providerPresetSchema = {
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
    schemaVersion: { const: 1 },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    name: text(200),
    kind: { enum: ["vendor", "relay", "local", "custom"] },
    website: httpsUrl,
    keysUrl: httpsUrl,
    catalog: text(100),
    verified: {
      type: "string",
      pattern: "^(\\d{4}-\\d{2}-\\d{2}|unverified)$",
    },
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["methods", "apiKeyHeader"],
      properties: {
        methods: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { enum: ["api-key", "none"] },
        },
        apiKeyHeader: {
          type: "string",
          pattern:
            "^(authorization-bearer|x-api-key|api-key|x-goog-api-key|query-key|custom:[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128})$",
        },
      },
    },
    endpoints: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: Object.fromEntries(
        wireProtocols.map((protocol) => [protocol, text(500)]),
      ),
    },
    models: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { enum: ["live", "static", "catalog"] },
        listPath: { type: "string", pattern: "^/\\S{0,200}$" },
        list: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
              id: text(200),
              wire: text(200),
              contextWindow: { type: "integer", minimum: 1 },
              maxOutputTokens: { type: "integer", minimum: 1 },
              reasoning: { type: "boolean" },
              inputModalities: {
                type: "array",
                items: { enum: ["text", "image", "pdf", "audio", "video"] },
              },
              price: {
                type: "object",
                additionalProperties: false,
                properties: {
                  input: amount,
                  output: amount,
                  cacheRead: amount,
                  cacheWrite: amount,
                },
              },
            },
          },
        },
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: { requiresReasoningReplay: { type: "boolean" } },
    },
    patches: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        wireProtocols.map((protocol) => [
          protocol,
          {
            type: "object",
            additionalProperties: false,
            required: ["patches"],
            properties: {
              patches: {
                type: "array",
                items: { enum: [...providerPatches] },
              },
              dropFields: {
                type: "array",
                items: { enum: [...droppableFields] },
              },
              anthropicBetaAllow: {
                type: "array",
                items: text(200),
              },
            },
          },
        ]),
      ),
    },
    notes: text(500),
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
/** Shape check of a preset file; endpoint conventions are checked on expansion. */
export const isProviderPreset =
  ajv.compile<ProviderPreset>(providerPresetSchema);

/**
 * A new provider from a preset: no credentials, every model exposed.
 * `endpoints` replaces the preset's endpoints by protocol (for a local
 * server on another address). The caller validates the result with
 * `isProviderConfig` and `endpointProblem` before storing it.
 */
export function providerFromPreset(
  preset: ProviderPreset,
  options: {
    id?: string;
    name?: string;
    endpoints?: Partial<Record<WireProtocol, string>>;
    now: string;
  },
): ProviderConfig {
  return {
    schemaVersion: 1,
    id: (options.id ?? preset.id) as ProviderId,
    name: options.name ?? preset.name,
    kind: preset.kind,
    preset: preset.id,
    endpoints: { ...preset.endpoints, ...options.endpoints },
    auth: { apiKeyHeader: preset.auth.apiKeyHeader },
    credentials: [],
    models: {
      source: preset.models.source,
      list: preset.models.list ?? [],
      expose: "all",
      ...(preset.models.listPath ? { listPath: preset.models.listPath } : {}),
    },
    ...(preset.capabilities ? { capabilities: preset.capabilities } : {}),
    ...(preset.patches ? { patches: preset.patches } : {}),
    createdAt: options.now,
    updatedAt: options.now,
  };
}
