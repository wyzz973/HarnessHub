// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeAssets } from "./sea/build.mjs";

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
    "dist/native/harnesshub-job.exe",
    "packages/store/dist/native/harnesshub-acl.exe",
    "packages/secrets/dist/native/harnesshub-keychain",
    "packages/core/dist/src/types.js",
  ]);
  assert.deepEqual(
    nativeAssets(root).map((helper) => helper.path),
    [
      "dist/native/harnesshub-job.exe",
      "packages/secrets/dist/native/harnesshub-keychain",
      "packages/store/dist/native/harnesshub-acl.exe",
    ],
  );
  assert.deepEqual(nativeAssets(await tree(t, [])), []);
});

test("a stale or unknown file in a native helper directory fails the build", async (t) => {
  // The keychain helper lived in dist/native before it moved to the secrets package.
  const stale = await tree(t, [
    "dist/native/harnesshub-job.exe",
    "dist/native/harnesshub-keychain",
  ]);
  assert.throws(
    () => nativeAssets(stale),
    /files NATIVE_HELPERS does not list: dist\/native\/harnesshub-keychain\./,
  );
  const unlisted = await tree(t, ["packages/agents/dist/native/launcher.exe"]);
  assert.throws(
    () => nativeAssets(unlisted),
    /packages\/agents\/dist\/native\/launcher\.exe/,
  );
});
