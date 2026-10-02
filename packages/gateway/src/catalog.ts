// SPDX-License-Identifier: MIT
/**
 * The models.dev catalog (03-model-plane section 7): the trimmed snapshot
 * format and the bundled snapshot. `catalog/models-dev.json` in this package
 * is written by tools/catalog-snapshot.mjs and shipped with the models.dev
 * license in `catalog/models-dev.LICENSE`. It is data read from disk next to
 * the compiled module, like the presets; the single-executable build extracts
 * it under its root at the same relative path (tools/sea/build.mjs). Refreshed
 * copies use the same format (catalog-refresh.ts). Nothing here contacts the
 * network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  CatalogMeta,
  CatalogModel,
  Modality,
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

/**
 * The fields HarnessHub uses from one models.dev model: positive context and
 * output limits, reasoning, known input modalities, tool calling and
 * non-negative USD prices per million tokens. Absent or invalid values stay
 * absent; nothing is defaulted.
 */
export function trimModel(model: unknown): CatalogModel {
  if (!object(model)) return {};
  const entry: CatalogModel = {};
  const limit = object(model.limit) ? model.limit : {};
  if (positive(limit.context)) entry.context = limit.context as number;
  if (positive(limit.output)) entry.output = limit.output as number;
  if (typeof model.reasoning === "boolean") entry.reasoning = model.reasoning;
  const input = object(model.modalities) ? model.modalities.input : undefined;
  if (Array.isArray(input)) {
    const known = input.filter((item): item is Modality =>
      modalities.has(item as string),
    );
    if (known.length) entry.input = [...new Set(known)];
  }
  if (typeof model.tool_call === "boolean") entry.toolCall = model.tool_call;
  if (object(model.cost)) {
    const price: NonNullable<CatalogModel["price"]> = {};
    for (const [from, to] of [
      ["input", "input"],
      ["output", "output"],
      ["cache_read", "cacheRead"],
      ["cache_write", "cacheWrite"],
    ] as const)
      if (amount(model.cost[from])) price[to] = model.cost[from] as number;
    if (Object.keys(price).length) entry.price = price;
  }
  return entry;
}

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * A models.dev `api.json` as a snapshot document: metadata (where and when it
 * was retrieved from, the SHA-256 and size of `bytes`), then every provider and
 * its trimmed models sorted by ID, one model per line so updates diff by
 * model.
 *
 * @throws Error when `bytes` is not a JSON object.
 */
export function snapshotText(
  bytes: Uint8Array,
  meta: {
    source: string;
    retrievedAt: string;
    etag: string | null;
    commit: string | null;
  },
): string {
  const api: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!object(api)) throw new Error("models.dev api.json is not an object");
  const providers = Object.entries(api)
    .filter(
      (entry): entry is [string, Json & { models: Json }] =>
        object(entry[1]) && object(entry[1].models),
    )
    .sort(byKey);
  let models = 0;
  const blocks = providers.map(([id, provider]) => {
    const lines = Object.entries(provider.models)
      .sort(byKey)
      .map(([model, value]) => {
        models += 1;
        return `${JSON.stringify(model)}:${JSON.stringify(trimModel(value))}`;
      });
    const name = typeof provider.name === "string" ? provider.name : id;
    return `${JSON.stringify(id)}:{"name":${JSON.stringify(name)},"models":{\n${lines.join(",\n")}\n}}`;
  });
  const header = {
    schemaVersion: 1,
    source: meta.source,
    repository: "https://github.com/anomalyco/models.dev",
    license: "MIT (models.dev.LICENSE)",
    retrievedAt: meta.retrievedAt,
    etag: meta.etag,
    commit: meta.commit,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    providers: providers.length,
    models,
  };
  return `{"meta":${JSON.stringify(header)},\n"providers":{\n${blocks.join(",\n")}\n}}\n`;
}

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
