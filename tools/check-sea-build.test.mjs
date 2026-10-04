// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogAssets,
  checkCommands,
  checkRoles,
  consoleAssets,
  nativeAssets,
  presetAssets,
  scriptAssets,
  SCRIPT_ASSETS,
} from "./sea/build.mjs";

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

test("every script of the asset directories is a role, an extracted file or bundled", async (t) => {
  const listed = Object.keys(SCRIPT_ASSETS);
  const root = await tree(t, listed);
  assert.deepEqual(
    scriptAssets(root).map((asset) => asset.path),
    [
      "packages/agents/assets/native-mcp/pi-extension.mjs",
      "packages/daemon/assets/copilot-host.mjs",
    ],
  );
  // A new launcher nobody classified would be neither dispatched nor extracted.
  const added = await tree(t, [...listed, "packages/agents/assets/launch-new-acp.mjs"]);
  assert.throws(
    () => scriptAssets(added),
    /scripts SCRIPT_ASSETS does not classify: packages\/agents\/assets\/launch-new-acp\.mjs\./,
  );
  const removed = await tree(t, listed.filter((relative) => !relative.endsWith("copilot-host.mjs")));
  assert.throws(() => scriptAssets(removed), /do not exist: packages\/daemon\/assets\/copilot-host\.mjs/);
});

test("the build fails when entry.mjs and the extracted roles disagree", () => {
  const entry = `const ROLES = new Map([
  ["packages/daemon/dist/src/main.js", () => import("../../packages/daemon/dist/src/main.js")],
  ["packages/agents/assets/launch-engine.mjs", () => import("../../packages/agents/assets/launch-engine.mjs")],
]);`;
  checkRoles(entry, ["packages/agents/assets/launch-engine.mjs", "packages/daemon/dist/src/main.js"]);
  assert.throws(
    () =>
      checkRoles(entry, [
        "packages/daemon/dist/src/main.js",
        "packages/agents/assets/launch-engine.mjs",
        "packages/agents/assets/launch-pi-acp.mjs",
      ]),
    /dispatches \[.*launch-engine\.mjs\] but the build extracts \[.*launch-pi-acp\.mjs\]/,
  );
});

test("the build fails when the executable does not run an hh command", () => {
  const outcomes = {
    serve: { status: 0, stderr: "" },
    agents: { status: 0, stderr: "" },
    tui: { status: 2, stderr: "Unknown command: tui\nUsage: hh <command>" },
    rollout: { status: 1, stderr: "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: ./impl/format\n    at" },
  };
  const run = (name) => ({ ...outcomes[name], ms: 50 });
  assert.deepEqual(checkCommands(["serve", "agents"], run), { serve: 50, agents: 50 });
  assert.throws(
    () => checkCommands(Object.keys(outcomes), run),
    /does not run these hh commands: tui \(exit 2: Unknown command: tui\); rollout \(exit 1: Error \[ERR_UNKNOWN_BUILTIN_MODULE\]: No such built-in module: \.\/impl\/format\)$/,
  );
  assert.throws(() => checkCommands([], run), /lists no commands/);
});
