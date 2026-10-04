// SPDX-License-Identifier: MIT
/**
 * Provider presets (03-model-plane section 4): data files
 * `packages/gateway/presets/<id>.json` that describe a vendor, relay or local
 * server well enough to create a provider from it. The gateway package loads
 * them; the API lists them and expands one, with a region and a plan, into a
 * `ProviderConfig`.
 */
import { Ajv } from "ajv";
import {
  droppableFields,
  maxTokensFields,
  providerPatches,
  wireProtocols,
  type ApiKeyHeader,
  type ProviderConfig,
  type ProviderId,
  type ProviderKind,
  type ProviderModel,
  type WireProtocol,
} from "./model-plane.js";

type Endpoints = Partial<Record<WireProtocol, string>>;
type ModelSource = "live" | "static" | "catalog";

/**
 * One place a vendor serves the same API from (a country site, a cloud
 * region). Its endpoints are the complete set there: a protocol it leaves
 * out is not served in that region.
 */
export interface PresetRegion {
  id: string;
  name: string;
  endpoints: Endpoints;
  /** Replaces the preset's key page: the region's accounts are made elsewhere. */
  keysUrl?: string;
  /** Replaces the preset's models.dev ID. */
  catalog?: string;
  notes?: string;
}

/**
 * One product of the vendor sold on its own key (a coding plan, an
 * enterprise tier, pay as you go). `endpoints`, when given, replace the
 * region's as a whole; `models` are the IDs the plan serves.
 */
export interface PresetPlan {
  id: string;
  name: string;
  endpoints?: Endpoints;
  /** Replaces the preset's `fallbackModels`. */
  models?: string[];
  /** Replaces `models.source`, e.g. `static` for a plan without a list endpoint. */
  modelSource?: ModelSource;
  keysUrl?: string;
  catalog?: string;
  notes?: string;
}

/** A request header the vendor documents, whose value the user supplies. */
export interface PresetHeaderHint {
  name: string;
  /** Creating a provider without it fails. */
  required: boolean;
  notes?: string;
}

/**
 * How Magpie's import links (`magpie://import?preset=…&region=…`) name this
 * preset: one Magpie preset ID, with the region or plan it implies here.
 */
export interface PresetMagpieId {
  id: string;
  region?: string;
  plan?: string;
}

export interface ProviderPreset {
  schemaVersion: 1;
  /** Also the file name and the default provider ID. */
  id: string;
  name: string;
  kind: ProviderKind;
  /** A lobehub icon slug (`@lobehub/icons`), e.g. `deepseek-color`. */
  icon?: string;
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
  /** Where the data came from when not from the vendor, as `<project>@<commit>`. */
  source?: string;
  /** `api-key`: needs a credential; `none`: local servers that accept any key or none. */
  auth: { methods: Array<"api-key" | "none">; apiKeyHeader: ApiKeyHeader };
  /**
   * Base URLs by the convention of `endpointProblem`. With regions or plans,
   * they are those of the first region and the first plan.
   */
  endpoints: Endpoints;
  /**
   * The user supplies the base URL (an Azure resource, another machine):
   * `endpoints` only show the shape, and a provider needs its own.
   */
  userEndpoint?: true;
  /** At least two; the first is the default. */
  regions?: PresetRegion[];
  /** At least two; the first is the default. */
  plans?: PresetPlan[];
  /** Headers the user may (or, when required, must) add to the provider. */
  headerHints?: PresetHeaderHint[];
  models: {
    source: ModelSource;
    /** Appended to the chat (or responses) base for a live list; default `/models`. */
    listPath?: string;
    /** A small, stable list; `live` presets usually leave it out. */
    list?: ProviderModel[];
  };
  /**
   * Model IDs a new provider starts with when `models.list` is absent: for
   * vendors without a list endpoint, or whose list leaves a plan's models
   * out. A refresh that fails keeps them.
   */
  fallbackModels?: string[];
  /** Absent: Magpie names this preset by its own ID. */
  magpie?: PresetMagpieId[];
  capabilities?: { requiresReasoningReplay?: boolean };
  patches?: ProviderConfig["patches"];
  /** Short remark shown with the preset, e.g. that the base must be edited. */
  notes?: string;
}

const text = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength }) as const;
const slug = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } as const;
const httpsUrl = {
  type: "string",
  pattern: "^https://\\S+$",
  maxLength: 500,
} as const;
const amount = { type: "number", minimum: 0 } as const;
const endpointsSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(
    wireProtocols.map((protocol) => [protocol, text(500)]),
  ),
} as const;
const modelSource = { enum: ["live", "static", "catalog"] } as const;
const modelIds = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  uniqueItems: true,
  items: { type: "string", pattern: "^\\S{1,200}$" },
} as const;
/** Header names that carry the API key; `auth.apiKeyHeader` owns them. */
const keyHeaders =
  "^([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]|[Aa][Pp][Ii]-[Kk][Ee][Yy]|[Xx]-[Gg][Oo][Oo][Gg]-[Aa][Pp][Ii]-[Kk][Ee][Yy])$";

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
    id: slug,
    name: text(200),
    kind: { enum: ["vendor", "relay", "local", "custom"] },
    icon: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{0,63}$" },
    website: httpsUrl,
    keysUrl: httpsUrl,
    catalog: slug,
    verified: {
      type: "string",
      pattern: "^(\\d{4}-\\d{2}-\\d{2}|unverified)$",
    },
    source: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9.-]{0,62}@[0-9a-f]{7,40}$",
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
    endpoints: endpointsSchema,
    userEndpoint: { const: true },
    regions: {
      type: "array",
      minItems: 2,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "endpoints"],
        properties: {
          id: slug,
          name: text(100),
          endpoints: endpointsSchema,
          keysUrl: httpsUrl,
          catalog: slug,
          notes: text(500),
        },
      },
    },
    plans: {
      type: "array",
      minItems: 2,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: slug,
          name: text(100),
          endpoints: endpointsSchema,
          models: modelIds,
          modelSource,
          keysUrl: httpsUrl,
          catalog: slug,
          notes: text(500),
        },
      },
    },
    headerHints: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "required"],
        properties: {
          // A header token (RFC 9110), not one that carries the API key.
          name: {
            type: "string",
            pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$",
            not: { type: "string", pattern: keyHeaders },
          },
          required: { type: "boolean" },
          notes: text(300),
        },
      },
    },
    models: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: modelSource,
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
    fallbackModels: modelIds,
    magpie: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: slug, region: slug, plan: slug },
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
              maxTokensField: { enum: [...maxTokensFields] },
            },
          },
        ]),
      ),
    },
    notes: text(500),
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
/**
 * Shape check of a preset file; endpoint conventions, unique IDs and the
 * defaults of regions and plans are checked by the loader (`checkPreset`).
 */
export const isProviderPreset =
  ajv.compile<ProviderPreset>(providerPresetSchema);

/** Why a preset cannot be expanded as asked; `pointer` names the request member. */
export class PresetChoiceError extends Error {
  constructor(
    readonly code:
      | "PRESET_REGION_NOT_FOUND"
      | "PRESET_PLAN_NOT_FOUND"
      | "ENDPOINT_REQUIRED"
      | "HEADER_REQUIRED",
    readonly pointer: string,
    message: string,
  ) {
    super(message);
    this.name = "PresetChoiceError";
  }
}

/** A preset with one region and one plan chosen. */
export interface PresetChoice {
  /**
   * The preset as that choice sees it: `endpoints`, `keysUrl`, `catalog`,
   * `models` (source and initial list) and `fallbackModels` are the
   * region's and plan's; every other member is the preset's.
   */
  preset: ProviderPreset;
  region?: PresetRegion;
  plan?: PresetPlan;
}

/**
 * Resolve a region and a plan of `preset`; an absent one is the first
 * listed. Precedence: endpoints from the plan, then the region, then the
 * preset; `keysUrl` and `catalog` the same way; the initial model list from
 * the plan's `models`, then `models.list`, then `fallbackModels`. Pure.
 *
 * @throws PresetChoiceError when the preset has no such region or plan (or
 *   none at all and one was named).
 */
export function choosePreset(
  preset: ProviderPreset,
  choice: { region?: string | undefined; plan?: string | undefined } = {},
): PresetChoice {
  const pick = <T extends { id: string }>(
    options: T[] | undefined,
    id: string | undefined,
    kind: "region" | "plan",
  ): T | undefined => {
    if (id === undefined) return options?.[0];
    const found = options?.find((option) => option.id === id);
    if (!found)
      throw new PresetChoiceError(
        kind === "region" ? "PRESET_REGION_NOT_FOUND" : "PRESET_PLAN_NOT_FOUND",
        `/${kind}`,
        options
          ? `The preset ${preset.id} has no ${kind} ${JSON.stringify(id).slice(0, 80)}; it has ${options.map((option) => option.id).join(", ")}`
          : `The preset ${preset.id} has no ${kind}s`,
      );
    return found;
  };
  const region = pick(preset.regions, choice.region, "region");
  const plan = pick(preset.plans, choice.plan, "plan");
  const list =
    plan?.models?.map(
      (id) => preset.models.list?.find((model) => model.id === id) ?? { id },
    ) ??
    preset.models.list ??
    preset.fallbackModels?.map((id) => ({ id }));
  const keysUrl = plan?.keysUrl ?? region?.keysUrl ?? preset.keysUrl;
  const catalog = plan?.catalog ?? region?.catalog ?? preset.catalog;
  const fallbackModels = plan?.models ?? preset.fallbackModels;
  return {
    preset: {
      ...preset,
      endpoints: {
        ...(plan?.endpoints ?? region?.endpoints ?? preset.endpoints),
      },
      ...(keysUrl !== undefined ? { keysUrl } : {}),
      ...(catalog !== undefined ? { catalog } : {}),
      ...(fallbackModels !== undefined ? { fallbackModels } : {}),
      models: {
        ...preset.models,
        source: plan?.modelSource ?? preset.models.source,
        ...(list !== undefined ? { list } : {}),
      },
    },
    ...(region ? { region } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * A new provider from a preset: no credentials, every model exposed, the
 * chosen region and plan recorded. `endpoints` replaces the choice's
 * endpoints by protocol (for a local server on another address); a
 * `userEndpoint` preset requires them. The caller validates the result with
 * `isProviderConfig` and `endpointProblem` before storing it.
 *
 * @throws PresetChoiceError for an unknown region or plan, a missing
 *   endpoint of a `userEndpoint` preset or a missing required header.
 */
export function providerFromPreset(
  preset: ProviderPreset,
  options: {
    id?: string;
    name?: string;
    region?: string;
    plan?: string;
    endpoints?: Endpoints;
    headers?: Record<string, string>;
    now: string;
  },
): ProviderConfig {
  const choice = choosePreset(preset, options);
  const chosen = choice.preset;
  if (preset.userEndpoint && !Object.keys(options.endpoints ?? {}).length)
    throw new PresetChoiceError(
      "ENDPOINT_REQUIRED",
      "/endpoints",
      `The preset ${preset.id} needs the base URL of your own server or resource`,
    );
  const given = new Set(
    Object.keys(options.headers ?? {}).map((name) => name.toLowerCase()),
  );
  for (const hint of preset.headerHints ?? [])
    if (hint.required && !given.has(hint.name.toLowerCase()))
      throw new PresetChoiceError(
        "HEADER_REQUIRED",
        `/headers/${hint.name}`,
        `The preset ${preset.id} needs the header ${hint.name}${hint.notes ? `: ${hint.notes}` : ""}`,
      );
  return {
    schemaVersion: 1,
    id: (options.id ?? preset.id) as ProviderId,
    name: options.name ?? preset.name,
    kind: preset.kind,
    preset: preset.id,
    ...(choice.region ? { region: choice.region.id } : {}),
    ...(choice.plan ? { plan: choice.plan.id } : {}),
    endpoints: { ...chosen.endpoints, ...options.endpoints },
    auth: { apiKeyHeader: preset.auth.apiKeyHeader },
    ...(options.headers ? { headers: { ...options.headers } } : {}),
    credentials: [],
    models: {
      source: chosen.models.source,
      list: chosen.models.list ?? [],
      expose: "all",
      ...(chosen.models.listPath ? { listPath: chosen.models.listPath } : {}),
    },
    ...(preset.capabilities ? { capabilities: preset.capabilities } : {}),
    ...(preset.patches ? { patches: preset.patches } : {}),
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/**
 * The preset as a stored provider sees it (`choosePreset` with the
 * provider's recorded region and plan), for metadata and display. A region
 * or plan a newer preset no longer has reads as the default: stored
 * providers are never refused for it.
 */
export function presetForProvider(
  preset: ProviderPreset,
  provider: Pick<ProviderConfig, "region" | "plan">,
): ProviderPreset {
  const known = <T extends { id: string }>(
    options: T[] | undefined,
    id: string | undefined,
  ) =>
    id !== undefined && options?.some((option) => option.id === id)
      ? id
      : undefined;
  return choosePreset(preset, {
    region: known(preset.regions, provider.region),
    plan: known(preset.plans, provider.plan),
  }).preset;
}
