// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import type {
  ProcessLauncher,
  ProcessRun,
} from "@harnesshub/core/process-launcher";
import {
  platformLauncher,
  usePlatformLauncher,
} from "../src/platform/process-launcher.js";
import { ensurePrivateDirectory } from "../src/platform/windows-acl.js";

const windows = process.platform === "win32";
const CANARY = "HH-CANARY-acl-helper-output-41d2";

const requests: ProcessRun[] = [];
/** An ACL helper that fails and prints the canary on both streams. */
const failing: ProcessLauncher = {
  launch: () => {
    throw new Error("The ACL session is not used here");
  },
  run: (spec) => {
    requests.push(spec);
    return Promise.resolve({
      code: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: Buffer.from(CANARY),
      stderr: Buffer.from(`${CANARY} in stderr`),
    });
  },
};

// The tests share this process's single platform launcher, so they run in order.
void test("the Windows filesystem primitives need the launcher set once per process", async () => {
  assert.throws(() => platformLauncher(), {
    code: "PROCESS_LAUNCHER_NOT_INJECTED",
    statusCode: 500,
  });
  if (windows)
    await assert.rejects(ensurePrivateDirectory(os.tmpdir()), {
      code: "PROCESS_LAUNCHER_NOT_INJECTED",
    });
  usePlatformLauncher(failing);
  assert.equal(platformLauncher(), failing);
  usePlatformLauncher(failing);
  assert.throws(() => usePlatformLauncher({ ...failing }), /already set/);
  assert.equal(platformLauncher(), failing);
});

void test(
  "an ACL helper failure keeps the helper's output out of the error",
  { skip: windows ? false : "the ACL helper runs on Windows only" },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hh-acl-stub-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let error: unknown;
    await ensurePrivateDirectory(directory).catch((caught: unknown) => {
      error = caught;
    });
    assert.equal((error as { code?: string }).code, "INVALID_PRIVATE_PATH");
    assert.equal(
      `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })}`.includes(
        CANARY,
      ),
      false,
    );
    assert.deepEqual(requests.at(-1)?.args, []);
    assert.match(String(requests.at(-1)?.input), /"protect":true/);
  },
);
