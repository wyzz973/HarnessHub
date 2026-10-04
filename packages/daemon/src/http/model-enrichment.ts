// SPDX-License-Identifier: MIT
import {
  applyModelMetadata,
  isOverrideRef,
  resolveModelMetadata,
  type MetadataSources,
  type ModelCatalog,
  type ModelMetadata,
  type ModelMetadataStore,
  type ModelOverride,
  type ModelProvenance,
} from "@harnesshub/core/model-metadata";
import type {
  ProviderConfig,
  ProviderModel,
} from "@harnesshub/core/model-plane";
import { presetForProvider } from "@harnesshub/core/provider-presets";
import type { PresetCatalog } from "./api-v1.js";

/** Values a live model list just returned, by model id, with the refresh time. */
export interface LiveModels {
  models: ReadonlyMap<string, ProviderModel>;
  at: string;
}

/**
 * Model metadata of stored providers (03-model-plane section 7): reads the
 * provider's overrides, provenance, preset and the bundled catalog, and either
 * resolves one model or applies the resolution to every listed model before a
 * write. Nothing here writes; the caller stores the result with
 * `putProviderMetadata`.
 */
export interface ModelEnrichment {
  /**
   * `config` with every listed model's metadata resolved into it, and the
   * provenance to store with it. `override`, when given, is resolved as if
   * stored (`null` as if deleted), so a write can change the override and the
   * values it implies at once. Models whose ID is not a valid Model Ref part
   * (whitespace) are left as they are.
   */
  enrich(
    config: ProviderConfig,
    options?: {
      live?: LiveModels;
      override?: { ref: string; record: ModelOverride | null };
    },
  ): Promise<{ provider: ProviderConfig; provenance: ModelProvenance[] }>;
  /** Each model's resolution, whether it is listed, and the overrides that apply to it. */
  resolve(
    config: ProviderConfig,
    modelIds: readonly string[],
  ): Promise<ResolvedModel[]>;
}

export type ResolvedModel = ModelMetadata & {
  listed: boolean;
  overrides: ModelOverride[];
};

export function createModelEnrichment(options: {
  store: ModelMetadataStore;
  presets: PresetCatalog;
  /** The catalog in use, read once per operation. */
  catalog: () => ModelCatalog;
}): ModelEnrichment {
  /** Per-model sources of one provider, read once per operation. */
  const sourcesOf = async (
    config: ProviderConfig,
    change?: { ref: string; record: ModelOverride | null },
  ) => {
    const overrides = new Map(
      (await options.store.listModelOverrides(config.id)).map((item) => [
        item.ref,
        item,
      ]),
    );
    if (change)
      if (change.record) overrides.set(change.ref, change.record);
      else overrides.delete(change.ref);
    const provenance = new Map(
      (await options.store.listModelProvenance(config.id)).map((item) => [
        item.ref,
        item,
      ]),
    );
    const stored =
      config.preset === undefined
        ? undefined
        : options.presets.get(config.preset);
    // The preset as the provider's region and plan see it (their catalog
    // and model list), with the provider's own catalog ID first.
    const chosen = stored ? presetForProvider(stored, config) : undefined;
    const preset =
      chosen && config.catalog !== undefined
        ? { ...chosen, catalog: config.catalog }
        : chosen;
    const inUse = options.catalog();
    const catalog: ModelCatalog =
      !chosen && config.catalog !== undefined
        ? {
            meta: inUse.meta,
            lookup: (catalogId, modelId) =>
              inUse.lookup(catalogId ?? config.catalog, modelId),
          }
        : inUse;
    const wildcard = overrides.get(`${config.id}/*`);
    return (modelId: string, live?: LiveModels): MetadataSources => {
      const ref = `${config.id}/${modelId}`;
      const exact = overrides.get(ref);
      const recorded = provenance.get(ref);
      const fetched = live?.models.get(modelId);
      return {
        ...(exact ? { exact } : {}),
        ...(wildcard ? { wildcard } : {}),
        ...(recorded ? { provenance: recorded } : {}),
        ...(fetched && live ? { live: { model: fetched, at: live.at } } : {}),
        ...(preset ? { preset } : {}),
        catalog,
      };
    };
  };

  return {
    async enrich(config, { live, override } = {}) {
      const sources = await sourcesOf(config, override);
      const provenance = new Map<string, ModelProvenance>();
      const list = config.models.list.map((model) => {
        if (!isOverrideRef(`${config.id}/${model.id}`)) return model;
        const applied = applyModelMetadata(
          config,
          model,
          sources(model.id, live),
        );
        // A list that names a model twice resolves it the same way twice.
        if (Object.keys(applied.provenance.fields).length)
          provenance.set(applied.provenance.ref, applied.provenance);
        return applied.model;
      });
      return {
        provider: { ...config, models: { ...config.models, list } },
        provenance: [...provenance.values()],
      };
    },
    async resolve(config, modelIds) {
      const sourcesFor = await sourcesOf(config);
      const listed = new Set(config.models.list.map((model) => model.id));
      return modelIds.map((modelId) => {
        const sources = sourcesFor(modelId);
        return {
          ...resolveModelMetadata(config, modelId, sources),
          listed: listed.has(modelId),
          overrides: [sources.wildcard, sources.exact].filter(
            (item): item is ModelOverride => item !== undefined,
          ),
        };
      });
    },
  };
}
