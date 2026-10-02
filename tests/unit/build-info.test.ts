// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseBuildInfo } from "../../src/domain/build-info.js";
import { loadBuildInfo } from "../../src/main.js";
import { temporaryDirectory } from "../support/temporary.js";

const valid = {
  version: "0.1.0",
  channel: "dev",
  commit: "761348e24778e5c4a009b3ed800231fbf83db92e",
  commitDate: "2026-10-02T12:20:37+08:00",
  ref: "refs/heads/main",
  dirty: false,
  builtAt: "2026-10-02T04:26:43.711Z",
  workflowRun: null,
  os: "linux",
  arch: "x64",
  nodeVersion: "v24.20.0",
  installMethod: "source",
};

void test("build identity accepts the written shape, including unknown values", () => {
  assert.deepEqual(parseBuildInfo(valid), valid);
  const unknown = { ...valid, commit: "unknown", dirty: "unknown" };
  assert.deepEqual(parseBuildInfo(unknown), unknown);
});

void test("build identity rejects missing, mistyped and unknown fields", () => {
  const { commit: _commit, ...missing } = valid;
  for (const raw of [
    null,
    [],
    missing,
    { ...valid, commit: "" },
    { ...valid, dirty: "yes" },
    { ...valid, workflowRun: 1 },
    { ...valid, signature: "x" },
  ])
    assert.throws(() => parseBuildInfo(raw), { code: "BUILD_INFO_INVALID" });
});

void test("a missing or malformed build-info.json stops startup with a named error", async (t) => {
  const { directory } = await temporaryDirectory(t, "hh-build-info-");
  const file = path.join(directory, "build-info.json");
  await assert.rejects(loadBuildInfo(pathToFileURL(file)), {
    code: "BUILD_INFO_UNAVAILABLE",
  });
  await writeFile(file, "{");
  await assert.rejects(loadBuildInfo(pathToFileURL(file)), {
    code: "BUILD_INFO_INVALID",
  });
  await writeFile(file, JSON.stringify(valid));
  assert.deepEqual(await loadBuildInfo(pathToFileURL(file)), valid);
});
