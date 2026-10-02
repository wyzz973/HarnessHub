#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Regenerate the bundled model catalog snapshot from models.dev (03-model-plane
 * section 7). The daemon refreshes its own copy at run time; this updates the
 * snapshot that ships with a release and that tests read offline.
 *
 * Usage: node tools/catalog-snapshot.mjs [--input api.json] [--commit SHA]
 * (run `pnpm build` first: the snapshot format is the gateway's `snapshotText`).
 *
 * Without --input it downloads https://models.dev/api.json (60 s timeout) and
 * the upstream LICENSE; with --input it reads a saved copy and keeps the
 * LICENSE already in the catalog directory. --commit records the models.dev
 * repository commit seen at retrieval (the API is deployed from it and may lag).
 * Writes packages/gateway/catalog/models-dev.json and checks that it loads.
 * Exits 1 on any failure without writing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCatalog, snapshotText } from "../packages/gateway/dist/src/catalog.js";

const API = "https://models.dev/api.json";
const LICENSE = "https://raw.githubusercontent.com/anomalyco/models.dev/HEAD/LICENSE";
const OUT = fileURLToPath(new URL("../packages/gateway/catalog/", import.meta.url));

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
    source: API,
    retrievedAt: new Date().toISOString(),
    etag,
    commit: values.commit ?? null,
  });
  const { meta } = parseCatalog(text);
  await writeFile(`${OUT}models-dev.json`, text);
  if (license) await writeFile(`${OUT}models-dev.LICENSE`, license);
  console.log(
    `models.dev snapshot: ${meta.providers} providers, ${meta.models} models, ${Buffer.byteLength(text)} bytes (from ${meta.bytes}); sha256 ${meta.sha256}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
