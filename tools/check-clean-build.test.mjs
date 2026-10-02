// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanBuild } from "./clean-build.mjs";

test("removes every project's outputs together with its .tsbuildinfo and keeps other build products", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-clean-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    removed: [
      "dist/src/main.js",
      "dist/tests/unit/a.test.js",
      "dist/.tsbuildinfo",
      "packages/core/dist/src/types.js",
      "packages/core/dist/test/types.test.js",
      "packages/core/dist/.tsbuildinfo",
      "apps/hh/dist/src/main.js",
      "apps/hh/dist/.tsbuildinfo",
    ],
    kept: [
      "dist/native/harnesshub-keychain",
      "dist/sea/build.json",
      "dist/build-info.json",
      "packages/store/dist/native/harnesshub-acl.exe",
      "packages/core/src/types.ts",
      "packages/core/package.json",
    ],
  };
  for (const relative of [...files.removed, ...files.kept]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "x");
  }
  const reported = await cleanBuild(root);
  for (const relative of files.removed) assert.equal(existsSync(path.join(root, relative)), false, relative);
  for (const relative of files.kept) assert.equal(existsSync(path.join(root, relative)), true, relative);
  assert.ok(reported.includes("dist/.tsbuildinfo"));
  assert.ok(reported.includes("packages/core/dist/.tsbuildinfo"));
  assert.ok(reported.includes("packages/store/dist/.tsbuildinfo"));
  // A second run, and a repository without workspace directories, succeed.
  await cleanBuild(root);
  const bare = await mkdtemp(path.join(os.tmpdir(), "hh-clean-build-bare-"));
  t.after(() => rm(bare, { recursive: true, force: true }));
  assert.deepEqual(await cleanBuild(bare), ["dist/src", "dist/tests", "dist/.tsbuildinfo"]);
});
