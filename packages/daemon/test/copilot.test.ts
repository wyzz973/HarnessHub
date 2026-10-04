// SPDX-License-Identifier: MIT
/** Copilot accounts on the daemon side: the CLI lookup, quota readings, the stored secret and a host that goes away. */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { NO_LOG } from "@harnesshub/core/logging";
import type {
  LaunchedProcess,
  ProcessExit,
  ProcessLauncher,
} from "@harnesshub/core/process-launcher";
import { CopilotError } from "@harnesshub/gateway/copilot";
import {
  copilotReadings,
  CopilotHosts,
  decodeCopilotSecret,
  encodeCopilotSecret,
  findCopilotCli,
  isFineGrainedToken,
} from "../src/copilot.js";
import type { ManagedSecrets } from "../src/http/api-v1.js";

void test("the Copilot CLI is the first executable copilot on PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-copilot-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plain = path.join(root, "plain");
  const runnable = path.join(root, "runnable");
  const directory = path.join(root, "directory");
  await mkdir(plain);
  await mkdir(runnable);
  await mkdir(path.join(directory, "copilot"), { recursive: true });
  await writeFile(path.join(plain, "copilot"), "");
  await writeFile(path.join(runnable, "copilot"), "#!/bin/sh\n");
  await chmod(path.join(runnable, "copilot"), 0o755);
  const PATH = ["relative", directory, plain, runnable].join(":");
  assert.equal(
    await findCopilotCli({ PATH }, "linux"),
    path.join(runnable, "copilot"),
  );
  assert.equal(await findCopilotCli({ PATH: plain }, "linux"), undefined);
  assert.equal(await findCopilotCli({}, "linux"), undefined);
  // Windows: PATHEXT names, any case of Path, no executable bit.
  await writeFile(path.join(plain, "copilot.cmd"), "");
  assert.equal(
    await findCopilotCli({ Path: plain, PATHEXT: ".EXE;.CMD" }, "win32"),
    path.join(plain, "copilot.cmd"),
  );
});

void test("quota snapshots become readings; unlimited windows are none", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  assert.deepEqual(
    copilotReadings(
      [
        {
          name: "premium_interactions",
          unlimited: false,
          remainingPercentage: 62.5,
          resetDate: "2026-11-01T00:00:00Z",
        },
        { name: "chat", unlimited: true, remainingPercentage: 100 },
        { name: "over", unlimited: false, remainingPercentage: -5 },
      ],
      now,
    ),
    [
      {
        window: "premium_interactions",
        usedPercent: 37.5,
        resetsAt: "2026-11-01T00:00:00.000Z",
        // October: the month before the renewal.
        spanSeconds: 31 * 86_400,
        observedAt: "2026-10-04T12:00:00.000Z",
      },
      {
        window: "over",
        usedPercent: 100,
        observedAt: "2026-10-04T12:00:00.000Z",
      },
    ],
  );
});

void test("the stored secret holds a token account's token, and nothing else reads as one", () => {
  const token = `github_pat_${"a".repeat(40)}`;
  assert.equal(
    encodeCopilotSecret({ v: 1, token }),
    `{"v":1,"token":"${token}"}`,
  );
  assert.deepEqual(decodeCopilotSecret(encodeCopilotSecret({ v: 1, token })), {
    v: 1,
    token,
  });
  assert.deepEqual(decodeCopilotSecret('{"v":1}'), { v: 1 });
  assert.deepEqual(decodeCopilotSecret("not json"), { v: 1 });
  assert.deepEqual(decodeCopilotSecret('{"v":2,"token":"x"}'), { v: 1 });
  assert.ok(isFineGrainedToken(token));
  assert.ok(!isFineGrainedToken(`ghp_${"a".repeat(36)}`));
  assert.ok(!isFineGrainedToken("github_pat_short"));
  assert.ok(!isFineGrainedToken(`github_pat_${"a".repeat(40)} trailing`));
});

/**
 * A Copilot host process as the injected launcher hands it out: `stdin`
 * and `stdout` given by the test, an exit that comes only once it is
 * killed (as an exit event not yet processed).
 */
function fakeHost(stdin: Writable, stdout = new PassThrough()) {
  const exit = Promise.withResolvers<ProcessExit>();
  let killed = 0;
  const child: LaunchedProcess = {
    pid: 4242,
    stdin,
    stdout,
    stderr: new PassThrough(),
    exit: exit.promise,
    closed: exit.promise,
    kill: (signal = "SIGTERM") => {
      killed++;
      exit.resolve({ code: null, signal, timedOut: false, aborted: false });
    },
  };
  return { child, killed: () => killed };
}

async function hosts(t: test.TestContext, child: LaunchedProcess) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-copilot-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launcher: ProcessLauncher = {
    launch: () => child,
    run: () => Promise.reject(new Error("not used")),
  };
  const copilot = new CopilotHosts({
    launcher,
    secrets: {} as ManagedSecrets,
    environment: {},
    paths: {
      addon: path.join(directory, "addon"),
      directory,
      cli: path.join(directory, "copilot"),
    },
    clock: () => Date.parse("2026-10-05T12:00:00.000Z"),
    log: NO_LOG,
  });
  t.after(() => copilot.close());
  return copilot;
}

void test("a host whose stdin closed before its exit is seen is gone: its requests fail, the daemon goes on", async (t) => {
  // The host exited and closed its end of the pipe: the next write is EPIPE.
  const { child, killed } = fakeHost(
    new Writable({
      write: (_chunk, _encoding, callback) =>
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    }),
  );
  const copilot = await hosts(t, child);
  await assert.rejects(
    copilot.identify("login", undefined),
    (error: unknown) =>
      error instanceof CopilotError &&
      error.code === "unavailable" &&
      /stopped taking requests \(EPIPE\)/.test(error.message),
  );
  assert.ok(killed() >= 1, "the host was stopped");
});

void test("a host whose output fails is gone too, and its stderr's failure is ignored", async (t) => {
  const stdout = new PassThrough();
  const stdin = new Writable({
    write: (_chunk, _encoding, callback) => {
      callback();
      // The request was written; the host's output fails before it answers.
      setImmediate(() => {
        child.stderr?.destroy(new Error("read ECONNRESET"));
        stdout.destroy(new Error("read ECONNRESET"));
      });
    },
  });
  const { child, killed } = fakeHost(stdin, stdout);
  const copilot = await hosts(t, child);
  await assert.rejects(
    copilot.identify("login", undefined),
    (error: unknown) =>
      error instanceof CopilotError &&
      error.code === "unavailable" &&
      /output failed/.test(error.message),
  );
  assert.ok(killed() >= 1);
});
