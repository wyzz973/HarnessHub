// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import type {
  LaunchedProcess,
  ProcessExit,
} from "@harnesshub/core/process-launcher";
import { usePlatformLauncher } from "../src/platform/process-launcher.js";
import { WindowsFileSession } from "../src/platform/windows-file-session.js";

// The session runs on Windows only; this checks its handling of the helper's
// pipes with a fake helper, which needs no Windows.
void test("an ACL session whose helper output fails ends, failing its request", async () => {
  const stdout = new PassThrough();
  const exit = Promise.withResolvers<ProcessExit>();
  let kills = 0;
  const helper: LaunchedProcess = {
    pid: 4242,
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    exit: exit.promise,
    closed: exit.promise,
    kill: () => {
      kills++;
      exit.resolve({
        code: null,
        signal: "SIGTERM",
        timedOut: false,
        aborted: false,
      });
    },
  };
  usePlatformLauncher({
    launch: () => helper,
    run: () => Promise.reject(new Error("The ACL session does not run")),
  });
  stdout.write("ready\n");
  const session = await WindowsFileSession.create(new AbortController().signal);
  const request = session.ensurePrivateDirectories([tmpdir()]);
  stdout.destroy(
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  );
  await assert.rejects(request, { code: "INVALID_PRIVATE_PATH" });
  assert.equal(kills, 1);
  await session.close();
});
