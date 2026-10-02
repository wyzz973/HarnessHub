// SPDX-License-Identifier: MIT
/**
 * The bundled models.dev catalog snapshot (03-model-plane section 7):
 * `catalog/models-dev.json` in this package, written by
 * tools/catalog-snapshot.mjs and shipped with the models.dev license in
 * `catalog/models-dev.LICENSE`. It is data read from disk next to the compiled
 * module, like the presets; the single-executable build extracts it under its
 * root at the same relative path (tools/sea/build.mjs). Nothing here contacts
 * the network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  CatalogMeta,
  CatalogModel,
  ModelCatalog,
} from "@harnesshub/core/model-metadata";

/** Computed on use: a relocated single-executable module resolves its own root. */
function catalogFile(): string {
  return fileURLToPath(
    new URL("../../catalog/models-dev.json", import.meta.url),
  );
}

type Json = Record<string, unknown>;

function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const modalities = new Set(["text", "image", "pdf", "audio", "video"]);

function catalogModel(value: unknown): value is CatalogModel {
  if (!object(value)) return false;
  const checks: Record<string, (item: unknown) => boolean> = {
    context: positive,
    output: positive,
    reasoning: (item) => typeof item === "boolean",
    input: (item) =>
      Array.isArray(item) &&
      item.length > 0 &&
      item.every((entry) => modalities.has(entry as string)),
    toolCall: (item) => typeof item === "boolean",
    price: (item) =>
      object(item) &&
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

function catalogMeta(value: unknown): value is CatalogMeta & {
  schemaVersion: 1;
} {
  return (
    object(value) &&
    value.schemaVersion === 1 &&
    typeof value.source === "string" &&
    typeof value.repository === "string" &&
    typeof value.license === "string" &&
    typeof value.retrievedAt === "string" &&
    Number.isFinite(Date.parse(value.retrievedAt)) &&
    (value.etag === null || typeof value.etag === "string") &&
    (value.commit === null ||
      (typeof value.commit === "string" &&
        /^[0-9a-f]{40}$/.test(value.commit))) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    positive(value.bytes) &&
    positive(value.providers) &&
    positive(value.models)
  );
}

/**
 * Parse and validate a snapshot document.
 *
 * @throws Error naming the first problem; the snapshot is a packaging
 *   artifact, so an invalid one is a defect, not user input.
 */
export function parseCatalog(content: string): ModelCatalog {
  const fail = (reason: string): never => {
    throw new Error(`The model catalog snapshot is invalid: ${reason}`);
  };
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    return fail("not JSON");
  }
  if (!object(document) || !catalogMeta(document.meta))
    return fail("its meta is missing or malformed");
  if (!object(document.providers)) return fail("it has no providers");
  const providers = new Map<string, Map<string, CatalogModel>>();
  let count = 0;
  for (const [id, provider] of Object.entries(document.providers)) {
    if (!object(provider) || !object(provider.models))
      return fail(`provider ${id} has no models`);
    const models = new Map<string, CatalogModel>();
    for (const [model, entry] of Object.entries(provider.models)) {
      if (!catalogModel(entry)) return fail(`model ${id}/${model} is invalid`);
      models.set(model, entry);
      count += 1;
    }
    providers.set(id, models);
  }
  const { schemaVersion: _version, ...meta } = document.meta;
  if (providers.size !== meta.providers || count !== meta.models)
    fail("its counts disagree with its meta");
  return {
    meta,
    lookup(catalogId, modelId) {
      const direct =
        catalogId === undefined
          ? undefined
          : providers.get(catalogId)?.get(modelId);
      if (direct) return direct;
      // `author/model`, as relays and some local servers name models.
      const slash = modelId.indexOf("/");
      return slash > 0
        ? providers.get(modelId.slice(0, slash))?.get(modelId.slice(slash + 1))
        : undefined;
    },
  };
}

let cache: ModelCatalog | undefined;

/**
 * The bundled snapshot, read and validated on first use and kept for the
 * process (about 1.4 MB of JSON).
 *
 * @throws Error when the snapshot file is missing or invalid (a packaging
 *   defect).
 */
export function modelCatalog(): ModelCatalog {
  cache ??= parseCatalog(readFileSync(catalogFile(), "utf8"));
  return cache;
}
