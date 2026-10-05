// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionId } from "@harnesshub/core/types";
import { recoverWorkerLease } from "../src/process/leases.js";
import { probeConfiguration } from "../src/process/probe.js";
import { ProcessTableError, runBounded } from "../src/process/process-table.js";
import { superviseWindowsWorker } from "../src/process/windows-job.js";
import { failPipes } from "./pipe-failure.js";

// The children that runtime's process/ starts itself, outside the launcher:
// a failed pipe of theirs never ends this process and never passes for a
// complete answer.
const windows = process.platform === "win32";
const forever = "setInterval(() => {}, 1000);";

void test(
  "a configuration probe whose peer's output fails settles at once as unreadable",
  { skip: windows && "the Windows probe runs through the Job helper" },
  async (t) => {
    const marker = randomUUID();
    const failed = failPipes(t, marker, ["stdout"]);
    const started = Date.now();
    const result = await probeConfiguration(
      {
        command: [process.execPath, "-e", `${forever} // ${marker}`],
        env: {},
        instructionPrefix: "",
        mcpServers: [],
      },
      "acp",
      tmpdir(),
      new AbortController().signal,
      30_000,
    );
    await failed;
    assert.deepEqual(result, {
      name: "protocol",
      status: "failed",
      message: "The ACP initialize reply could not be read",
    });
    assert.ok(Date.now() - started < 15_000, "not left to its timeout");
  },
);

void test(
  "a Windows Job supervisor whose pipes fail is not ready, and the failure ends nothing else",
  {
    skip:
      windows &&
      "on Windows the real helper starts; here the listeners are checked on a supervisor that cannot start",
  },
  async (t) => {
    const token = randomUUID();
    const failed = failPipes(t, token, ["stdout", "stderr"]);
    // Only the Worker's PID is read before the helper is known to be missing.
    const job = superviseWindowsWorker(
      { pid: 2_147_483_646 } as ChildProcess,
      token,
    );
    await failed;
    await assert.rejects(job.ready, { code: "ECONNRESET" });
    assert.equal(await job.exited, false);
  },
);

void test("a bounded snapshot whose output fails is rejected, not taken as complete", async (t) => {
  const marker = randomUUID();
  const failed = failPipes(t, marker, ["stdout", "stderr"]);
  await assert.rejects(
    runBounded("test", process.execPath, ["-e", `// ${marker}`], {
      timeoutMs: 30_000,
      maxBuffer: 1024,
      env: {},
    }),
    (error: unknown) =>
      error instanceof ProcessTableError &&
      error.message === "test output could not be read",
  );
  await failed;
});

void test(
  "a Worker lease whose identity could not be read from ps is left alone",
  { skip: windows && "POSIX lease recovery reads ps" },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "hh-lease-pipe-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const workerPath = path.join(directory, "worker.mjs");
    await writeFile(workerPath, `${forever}\n`);
    const ownerToken = randomUUID();
    // In a group of its own, as a leased Worker is: recovery would reclaim it.
    const worker = spawn(
      process.execPath,
      [workerPath, `--harnesshub-owner=${ownerToken}`],
      { detached: true, stdio: "ignore" },
    );
    const closed = once(worker, "close");
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
      await closed;
    });
    assert.ok(worker.pid !== undefined);
    // The identity check's ps; the process table snapshot asks other columns.
    const failed = failPipes(t, "pid=,pgid=,command=", ["stdout", "stderr"]);
    const cleanup = await recoverWorkerLease(
      {
        version: 2,
        id: randomUUID(),
        sessionId: "lease-pipe-session" as SessionId,
        pid: worker.pid,
        ownerToken,
        workerPath,
        executable: process.execPath,
        startedAt: Date.now(),
        platform: process.platform,
      },
      200,
    );
    await failed;
    assert.equal(cleanup, "unconfirmed");
    assert.equal(worker.exitCode, null);
    assert.equal(worker.signalCode, null);
  },
);
