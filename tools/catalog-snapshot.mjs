#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Regenerate the bundled model catalog snapshot from models.dev (03-model-plane
 * section 7). This is the only command that contacts the network for the
 * catalog; the daemon and the tests read the snapshot offline.
 *
 * Usage: node tools/catalog-snapshot.mjs [--input api.json] [--commit SHA]
 *
 * Without --input it downloads https://models.dev/api.json (60 s timeout) and
 * the upstream LICENSE; with --input it reads a saved copy and keeps the
 * LICENSE already in the catalog directory. --commit records the models.dev
 * repository commit seen at retrieval (the API is deployed from it and may lag).
 * Writes packages/gateway/catalog/models-dev.json: the retrieval metadata
 * (URL, time, ETag, SHA-256 and size of the full document) and, for every
 * provider and model, only context and output limits, reasoning, input
 * modalities, tool calling and USD prices per million tokens, one model per
 * line so updates diff by model. Exits 1 on any failure without writing.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const API = "https://models.dev/api.json";
const LICENSE =
  "https://raw.githubusercontent.com/anomalyco/models.dev/HEAD/LICENSE";
const OUT = fileURLToPath(
  new URL("../packages/gateway/catalog/", import.meta.url),
);

const object = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value) => typeof value === "number" && Number.isFinite(value);
const modalities = new Set(["text", "image", "pdf", "audio", "video"]);

/**
 * The fields HarnessHub uses from one models.dev model; absent values stay absent.
 *
 * @param {unknown} model
 */
export function trimModel(model) {
  if (!object(model)) return {};
  const entry = {};
  const limit = object(model.limit) ? model.limit : {};
  if (Number.isSafeInteger(limit.context) && limit.context > 0)
    entry.context = limit.context;
  if (Number.isSafeInteger(limit.output) && limit.output > 0)
    entry.output = limit.output;
  if (typeof model.reasoning === "boolean") entry.reasoning = model.reasoning;
  const input = object(model.modalities) ? model.modalities.input : undefined;
  if (Array.isArray(input)) {
    const known = input.filter((item) => modalities.has(item));
    if (known.length) entry.input = known;
  }
  if (typeof model.tool_call === "boolean") entry.toolCall = model.tool_call;
  if (object(model.cost)) {
    const price = {};
    for (const [from, to] of [
      ["input", "input"],
      ["output", "output"],
      ["cache_read", "cacheRead"],
      ["cache_write", "cacheWrite"],
    ])
      if (number(model.cost[from]) && model.cost[from] >= 0)
        price[to] = model.cost[from];
    if (Object.keys(price).length) entry.price = price;
  }
  return entry;
}

/**
 * The snapshot document as text: metadata, then one provider per block and
 * one model per line.
 *
 * @param {Buffer} bytes The full api.json.
 * @param {{retrievedAt: string, etag: string | null, commit: string | null}} meta
 */
export function snapshotText(bytes, meta) {
  const api = JSON.parse(bytes.toString("utf8"));
  if (!object(api)) throw new Error("models.dev api.json is not an object");
  const providers = Object.entries(api)
    .filter(([, provider]) => object(provider) && object(provider.models))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let models = 0;
  const blocks = providers.map(([id, provider]) => {
    const lines = Object.entries(provider.models)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([model, value]) => {
        models += 1;
        return `${JSON.stringify(model)}:${JSON.stringify(trimModel(value))}`;
      });
    return `${JSON.stringify(id)}:{"name":${JSON.stringify(typeof provider.name === "string" ? provider.name : id)},"models":{\n${lines.join(",\n")}\n}}`;
  });
  const header = {
    schemaVersion: 1,
    source: API,
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

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    etag: response.headers.get("etag"),
  };
}

async function main() {
  const { values } = parseArgs({
    options: { input: { type: "string" }, commit: { type: "string" } },
  });
  let bytes;
  let etag = null;
  let license;
  if (values.input) bytes = await readFile(values.input);
  else {
    ({ bytes, etag } = await download(API));
    license = (await download(LICENSE)).bytes;
    if (!license.toString("utf8").startsWith("MIT License"))
      throw new Error("The models.dev LICENSE is no longer the MIT License");
  }
  const text = snapshotText(bytes, {
    retrievedAt: new Date().toISOString(),
    etag,
    commit: values.commit ?? null,
  });
  JSON.parse(text);
  await writeFile(`${OUT}models-dev.json`, text);
  if (license) await writeFile(`${OUT}models-dev.LICENSE`, license);
  const meta = JSON.parse(text).meta;
  console.log(
    `models.dev snapshot: ${meta.providers} providers, ${meta.models} models, ${Buffer.byteLength(text)} bytes (from ${meta.bytes}); sha256 ${meta.sha256}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
