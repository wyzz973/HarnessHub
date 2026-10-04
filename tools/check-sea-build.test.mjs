// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogAssets, consoleAssets, nativeAssets, presetAssets } from "./sea/build.mjs";

async function tree(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-sea-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "helper");
  }
  return root;
}

test("the single executable embeds only the listed native helpers", async (t) => {
  const root = await tree(t, [
    "packages/runtime/dist/native/harnesshub-job.exe",
    "packages/store/dist/native/harnesshub-acl.exe",
    "packages/secrets/dist/native/harnesshub-keychain",
    "packages/core/dist/src/types.js",
  ]);
  assert.deepEqual(
    nativeAssets(root).map((helper) => helper.path),
    [
      "packages/runtime/dist/native/harnesshub-job.exe",
      "packages/secrets/dist/native/harnesshub-keychain",
      "packages/store/dist/native/harnesshub-acl.exe",
    ],
  );
  assert.deepEqual(nativeAssets(await tree(t, [])), []);
});

test("a stale or unknown file in a native helper directory fails the build", async (t) => {
  // The job helper lived in dist/native before it moved to the runtime package.
  const stale = await tree(t, [
    "packages/runtime/dist/native/harnesshub-job.exe",
    "dist/native/harnesshub-job.exe",
  ]);
  assert.throws(
    () => nativeAssets(stale),
    /files NATIVE_HELPERS does not list: dist\/native\/harnesshub-job\.exe\./,
  );
  const unlisted = await tree(t, ["packages/agents/dist/native/launcher.exe"]);
  assert.throws(
    () => nativeAssets(unlisted),
    /packages\/agents\/dist\/native\/launcher\.exe/,
  );
});

test("the single executable carries every provider preset at its repository path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-sea-presets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(presetAssets(root), []);
  const directory = path.join(root, "packages", "gateway", "presets");
  await mkdir(directory, { recursive: true });
  for (const name of ["openai.json", "deepseek.json", "README.md", "magpie.LICENSE", "other.LICENSE"])
    await writeFile(path.join(directory, name), "{}");
  assert.deepEqual(
    presetAssets(root).map((asset) => asset.path),
    [
      "packages/gateway/presets/deepseek.json",
      "packages/gateway/presets/magpie.LICENSE",
      "packages/gateway/presets/openai.json",
    ],
  );
});

test("the single executable carries the model catalog snapshot and its license", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-sea-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(catalogAssets(root), []);
  const directory = path.join(root, "packages", "gateway", "catalog");
  await mkdir(directory, { recursive: true });
  for (const name of ["models-dev.json", "models-dev.LICENSE", "README.md", "scratch.json"])
    await writeFile(path.join(directory, name), "{}");
  assert.deepEqual(
    catalogAssets(root).map((asset) => asset.path),
    ["packages/gateway/catalog/models-dev.LICENSE", "packages/gateway/catalog/models-dev.json"],
  );
});

test("the single executable carries the built console and refuses to build without it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-sea-console-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => consoleAssets(root), /packages\/console\/dist\/index\.html is missing; run pnpm build:console/);
  const directory = path.join(root, "packages", "console", "dist");
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(path.join(directory, "assets", "index-1a2b.js"), "");
  assert.throws(() => consoleAssets(root), /index\.html is missing/);
  for (const name of ["index.html", "theme-boot.js"]) await writeFile(path.join(directory, name), "");
  assert.deepEqual(
    consoleAssets(root).map((asset) => asset.path),
    [
      "packages/console/dist/assets/index-1a2b.js",
      "packages/console/dist/index.html",
      "packages/console/dist/theme-boot.js",
    ],
  );
});
