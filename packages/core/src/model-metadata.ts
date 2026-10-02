// SPDX-License-Identifier: MIT
/**
 * Model metadata resolution (03-model-plane section 7). Each field of a model
 * (context window, maximum output, reasoning, input modalities, tool calling,
 * prices) comes from the first source that knows it:
 *
 * 1. a user override of the exact Model Ref;
 * 2. a user override of `provider/*`;
 * 3. a value set by hand on the provider's model entry;
 * 4. the provider's live model list;
 * 5. the provider's preset;
 * 6. the bundled models.dev catalog, by the preset's `catalog` id and then by
 *    the model's author (`author/model` IDs);
 * 7. unknown: no default is assumed, never a large window.
 *
 * Values the daemon derived are written into the provider's `ProviderModel`
 * entries, where the gateway reads them (for example prices for costs), and
 * their origin is kept as provenance, so a later hand edit is recognised as
 * such and never overwritten by derived data.
 */
import {
  parseModelRef,
  type ProviderConfig,
  type ProviderModel,
} from "./model-plane.js";
import type { ProviderPreset } from "./provider-presets.js";

/** The fields resolved per model; `price.*` are USD per million tokens. */
export const metadataFields = [
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
  "inputModalities",
  "toolCall",
  "price.input",
  "price.output",
  "price.cacheRead",
  "price.cacheWrite",
] as const;
export type MetadataField = (typeof metadataFields)[number];
/** Fields stored on `ProviderModel` (tool calling has no field there). */
export const storedFields = metadataFields.filter(
  (field) => field !== "toolCall",
);

export type Modality = "text" | "image" | "pdf" | "audio" | "video";
export type FieldValue = number | boolean | Modality[];

/** Where a value came from; `provider` is a value set by hand on the provider's model. */
export type MetadataSource =
  "override" | "override-provider" | "provider" | "live" | "preset" | "catalog";
/** Sources of derived values, recorded as provenance. */
export type DerivedSource = Exclude<MetadataSource, "provider">;

export interface ResolvedField {
  value: FieldValue;
  source: MetadataSource;
  /** When the source produced it (ISO 8601), when known. */
  at?: string;
}

export interface ModelMetadata {
  ref: string;
  fields: Partial<Record<MetadataField, ResolvedField>>;
  /** Fields no source knows. */
  unknown: MetadataField[];
}

/** Values a user overrides; all optional. */
export interface OverrideValues {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  inputModalities?: Modality[];
  toolCall?: boolean;
  price?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/** A durable user override of `provider/model` or `provider/*`. */
export interface ModelOverride {
  ref: string;
  values: OverrideValues;
  updatedAt: string;
}

/** The origin of the derived values stored on one provider model. */
export interface ModelProvenance {
  ref: string;
  fields: Partial<Record<MetadataField, DerivedValue>>;
}

export interface DerivedValue {
  source: DerivedSource;
  at?: string;
  /** The value as written; a different stored value was set by hand since. */
  value: FieldValue;
  /** The value set by hand that an override replaced; it returns with the override's removal. */
  replaced?: FieldValue;
}

/** One model of the catalog snapshot (models.dev, trimmed). */
export interface CatalogModel {
  context?: number;
  output?: number;
  reasoning?: boolean;
  input?: Modality[];
  toolCall?: boolean;
  price?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/** Where and when the snapshot was taken; `sha256` and `bytes` describe the full upstream document. */
export interface CatalogMeta {
  source: string;
  repository: string;
  license: string;
  retrievedAt: string;
  etag: string | null;
  commit: string | null;
  sha256: string;
  bytes: number;
  providers: number;
  models: number;
}

/** The bundled catalog. */
export interface ModelCatalog {
  readonly meta: CatalogMeta;
  /**
   * The model under the catalog provider `catalogId`, else under its author
   * (`author/model` model IDs); undefined when neither has it.
   */
  lookup(
    catalogId: string | undefined,
    modelId: string,
  ): CatalogModel | undefined;
}

/** Everything resolution reads besides the provider itself. */
export interface MetadataSources {
  /** Override of `provider/model`. */
  exact?: ModelOverride;
  /** Override of `provider/*`. */
  wildcard?: ModelOverride;
  /** Provenance of the values currently stored on the model. */
  provenance?: ModelProvenance;
  /**
   * The model as the provider's live list just returned it, with the time.
   * Without it, values recorded from an earlier list stay.
   */
  live?: { model: ProviderModel; at: string };
  preset?: ProviderPreset;
  catalog?: ModelCatalog;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A field's value on a `ProviderModel`, an override or a catalog model. */
function fromModel(model: ProviderModel | undefined, field: MetadataField) {
  if (!model) return undefined;
  switch (field) {
    case "contextWindow":
      return model.contextWindow;
    case "maxOutputTokens":
      return model.maxOutputTokens;
    case "reasoning":
      return model.reasoning;
    case "inputModalities":
      return model.inputModalities;
    case "toolCall":
      return undefined;
    case "price.input":
      return model.price?.input;
    case "price.output":
      return model.price?.output;
    case "price.cacheRead":
      return model.price?.cacheRead;
    case "price.cacheWrite":
      return model.price?.cacheWrite;
  }
}

function fromOverride(
  values: OverrideValues | undefined,
  field: MetadataField,
) {
  if (!values) return undefined;
  if (field === "toolCall") return values.toolCall;
  return fromModel(values as ProviderModel, field);
}

function fromCatalog(model: CatalogModel | undefined, field: MetadataField) {
  if (!model) return undefined;
  switch (field) {
    case "contextWindow":
      return model.context;
    case "maxOutputTokens":
      return model.output;
    case "reasoning":
      return model.reasoning;
    case "inputModalities":
      return model.input;
    case "toolCall":
      return model.toolCall;
    case "price.input":
      return model.price?.input;
    case "price.output":
      return model.price?.output;
    case "price.cacheRead":
      return model.price?.cacheRead;
    case "price.cacheWrite":
      return model.price?.cacheWrite;
  }
}

/**
 * Resolve every field of `modelId` on `provider`. The stored model entry is
 * read with its provenance: a stored value that still equals its recorded
 * derived value keeps that source; any other stored value was set by hand
 * (`provider`). Pure; `catalog.lookup` is the only callback.
 */
export function resolveModelMetadata(
  provider: ProviderConfig,
  modelId: string,
  sources: MetadataSources,
): ModelMetadata {
  return resolve(provider, modelId, sources).metadata;
}

/** The resolution and, per field, the value set by hand (which a winner may hide). */
function resolve(
  provider: ProviderConfig,
  modelId: string,
  sources: MetadataSources,
): {
  metadata: ModelMetadata;
  hand: Partial<Record<MetadataField, FieldValue>>;
} {
  const stored = provider.models.list.find((model) => model.id === modelId);
  const presetModel = sources.preset?.models.list?.find(
    (model) => model.id === modelId,
  );
  const catalogModel = sources.catalog?.lookup(
    sources.preset?.catalog,
    modelId,
  );
  const fields: ModelMetadata["fields"] = {};
  const unknown: MetadataField[] = [];
  const handSet: Partial<Record<MetadataField, FieldValue>> = {};
  for (const field of metadataFields) {
    const current = fromModel(stored, field);
    const recorded = sources.provenance?.fields[field];
    const derived = recorded !== undefined && equal(recorded.value, current);
    const hand = derived ? recorded.replaced : current;
    if (hand !== undefined) handSet[field] = hand;
    const candidates: Array<ResolvedField | undefined> = [
      at(
        fromOverride(sources.exact?.values, field),
        "override",
        sources.exact?.updatedAt,
      ),
      at(
        fromOverride(sources.wildcard?.values, field),
        "override-provider",
        sources.wildcard?.updatedAt,
      ),
      at(hand, "provider", provider.updatedAt),
      // A fresh list replaces the values of the previous one.
      sources.live
        ? at(fromModel(sources.live.model, field), "live", sources.live.at)
        : derived && recorded.source === "live"
          ? at(current, "live", recorded.at)
          : undefined,
      at(fromModel(presetModel, field), "preset", sources.preset?.verified),
      at(
        fromCatalog(catalogModel, field),
        "catalog",
        sources.catalog?.meta.retrievedAt,
      ),
    ];
    const winner = candidates.find((item) => item !== undefined);
    if (winner) fields[field] = winner;
    else unknown.push(field);
  }
  return {
    metadata: { ref: `${provider.id}/${modelId}`, fields, unknown },
    hand: handSet,
  };
}

function at(
  value: FieldValue | undefined,
  source: MetadataSource,
  time: string | undefined,
): ResolvedField | undefined {
  if (value === undefined) return undefined;
  return { value, source, ...(time !== undefined ? { at: time } : {}) };
}

/**
 * The model entry with the resolved values written into it and the
 * provenance of the derived ones. Values set by hand stay as they are unless
 * an override replaces them, and come back when it is removed; a derived
 * value that no source knows any more is removed.
 */
export function applyModelMetadata(
  provider: ProviderConfig,
  model: ProviderModel,
  sources: MetadataSources,
): { model: ProviderModel; provenance: ModelProvenance } {
  const { metadata, hand } = resolve(
    { ...provider, models: { ...provider.models, list: [model] } },
    model.id,
    sources,
  );
  const {
    contextWindow: _context,
    maxOutputTokens: _output,
    reasoning: _reasoning,
    inputModalities: _modalities,
    price: _price,
    ...rest
  } = model;
  const next: ProviderModel = { ...rest };
  const price: NonNullable<ProviderModel["price"]> = {};
  const provenance: ModelProvenance = { ref: metadata.ref, fields: {} };
  for (const field of storedFields) {
    const resolved = metadata.fields[field];
    if (!resolved) continue;
    const value = resolved.value;
    if (field === "contextWindow") next.contextWindow = value as number;
    else if (field === "maxOutputTokens")
      next.maxOutputTokens = value as number;
    else if (field === "reasoning") next.reasoning = value as boolean;
    else if (field === "inputModalities")
      next.inputModalities = value as Modality[];
    else
      price[field.slice("price.".length) as keyof typeof price] =
        value as number;
    const replaced = hand[field];
    if (resolved.source !== "provider")
      provenance.fields[field] = {
        source: resolved.source,
        ...(resolved.at !== undefined ? { at: resolved.at } : {}),
        value,
        ...(replaced !== undefined ? { replaced } : {}),
      };
  }
  if (Object.keys(price).length) next.price = price;
  return { model: next, provenance };
}

/** `provider/model` or `provider/*`: a Model Ref, whose model part has at most 512 characters. */
export function isOverrideRef(ref: string): boolean {
  const parsed = parseModelRef(ref);
  return parsed?.kind === "model" && parsed.model.length <= 512;
}

/** A change to one override, written together with its provider. */
export type OverrideChange = { put: ModelOverride } | { delete: string };

/**
 * Durable overrides and provenance, kept beside the providers by the SQLite
 * model-plane store. Both belong to a provider: deleting the provider deletes
 * them. An invalid record is refused with `MODEL_PLANE_RECORD_INVALID` (400)
 * and nothing changes.
 */
export interface ModelMetadataStore {
  getModelOverride(ref: string): Promise<ModelOverride | undefined>;
  /** The overrides of one provider (`provider/*` and `provider/<model>`), ordered by ref. */
  listModelOverrides(providerId: string): Promise<ModelOverride[]>;
  /** Provenance of the models of one provider, ordered by ref. */
  listModelProvenance(providerId: string): Promise<ModelProvenance[]>;
  /**
   * In one transaction: write the provider, replace the provenance of all
   * its models, and apply `override` when given (insert or replace, or
   * delete by ref), so stored values, their origin and the overrides they
   * reflect never disagree. Every ref must name this provider; refs must
   * be unique.
   */
  putProviderMetadata(
    provider: ProviderConfig,
    provenance: ModelProvenance[],
    override?: OverrideChange,
  ): Promise<void>;
}

type Check = (value: unknown) => boolean;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const positive: Check = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const amount: Check = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const modalityList: Check = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((item) =>
    ["text", "image", "pdf", "audio", "video"].includes(item as string),
  );
const timestamp: Check = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value));

/** Override values: only the known fields, each in its range; at least one. */
export function isOverrideValues(value: unknown): value is OverrideValues {
  if (!object(value) || Object.keys(value).length === 0) return false;
  const checks: Record<string, Check> = {
    contextWindow: positive,
    maxOutputTokens: positive,
    reasoning: (item) => typeof item === "boolean",
    inputModalities: modalityList,
    toolCall: (item) => typeof item === "boolean",
    price: (item) =>
      object(item) &&
      Object.keys(item).length > 0 &&
      Object.entries(item).every(
        ([key, price]) =>
          ["input", "output", "cacheRead", "cacheWrite"].includes(key) &&
          amount(price),
      ),
  };
  return Object.entries(value).every(
    ([key, item]) => Object.hasOwn(checks, key) && checks[key]!(item),
  );
}

export function isModelOverride(value: unknown): value is ModelOverride {
  return (
    object(value) &&
    typeof value.ref === "string" &&
    isOverrideRef(value.ref) &&
    isOverrideValues(value.values) &&
    timestamp(value.updatedAt)
  );
}

const fieldValue: Check = (value) =>
  amount(value) || typeof value === "boolean" || modalityList(value);

const derivedSources: readonly string[] = [
  "override",
  "override-provider",
  "live",
  "preset",
  "catalog",
];

export function isModelProvenance(value: unknown): value is ModelProvenance {
  return (
    object(value) &&
    typeof value.ref === "string" &&
    isOverrideRef(value.ref) &&
    object(value.fields) &&
    Object.entries(value.fields).every(
      ([field, entry]) =>
        (metadataFields as readonly string[]).includes(field) &&
        object(entry) &&
        derivedSources.includes(entry.source as string) &&
        (entry.at === undefined || timestamp(entry.at)) &&
        fieldValue(entry.value) &&
        (entry.replaced === undefined || fieldValue(entry.replaced)),
    )
  );
}
