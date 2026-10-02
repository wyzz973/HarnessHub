// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { assertExited } from "../support/process.js";

void test("a live process still running the marker fails the exit assertion", async (t) => {
  const marker = "hh-exit-marker-fixture";
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", marker],
    { stdio: "ignore" },
  );
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  await assert.rejects(assertExited(child.pid!, marker), /still runs/);
  // A live process with the PID that runs something else counts as exited (PID reuse).
  await assertExited(child.pid!, "some-other-fixture.js");
  child.kill("SIGKILL");
  await once(child, "exit");
  await assertExited(child.pid!, marker);
});
