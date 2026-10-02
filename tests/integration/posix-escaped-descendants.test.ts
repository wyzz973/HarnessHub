// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { startHub } from "../../src/main.js";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import type { ExecutionSpec, WorkerMessage } from "../../src/domain/ports.js";
import type {
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "../../src/domain/types.js";
import { temporaryDirectory } from "../support/temporary.js";

// Descendants that start their own session (setsid) leave the Worker's process
// group. These tests run the compiled Worker with the CLI fixture engine and
// check the processes themselves, not only the reported cleanup status.

const peer = fileURLToPath(new URL("../fixtures/cli-peer.js", import.meta.url));
/** Spelled out: the documented variable name is part of the tested contract. */
const WORKER_TREE_ENVIRONMENT = "HARNESSHUB_WORKER_TREE";
const posix = {
  skip:
    process.platform === "win32"
      ? "POSIX process groups and sessions; Windows Workers run in a kill-on-close Job Object"
      : false,
  timeout: 30_000,
};

interface Report {
  parent: number;
  orphan: number;
  cleared?: number;
  marker: string | null;
}

function parseReport(text: string): Report {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("parent" in value && typeof value.parent === "number");
  assert.ok("orphan" in value && typeof value.orphan === "number");
  assert.ok(
    "marker" in value &&
      (value.marker === null || typeof value.marker === "string"),
  );
  const cleared =
    "cleared" in value && typeof value.cleared === "number"
      ? value.cleared
      : undefined;
  return {
    parent: value.parent,
    orphan: value.orphan,
    marker: value.marker,
    ...(cleared === undefined ? {} : { cleared }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

/** Teardown for processes a failing assertion would otherwise leave running. */
function reap(t: TestContext, pids: () => number[]): void {
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already gone: the expected outcome. */
      }
    }
  });
}

function cliSpec(
  directory: string,
  sessionId: string,
  command: string[],
): ExecutionSpec {
  return {
    sessionId: sessionId as SessionId,
    runId: `run-${sessionId}` as RunId,
    generation: 1,
    cwd: directory,
    stateDir: join(directory, sessionId),
    input: { text: "escape", timeoutMs: 20_000 },
    profile: {
      id: sessionId,
      revision: "1",
      enabled: true,
      driver: "cli",
      command,
      cli: { inputMode: "stdin", maxOutputBytes: 64 * 1024 },
      capabilities: { permissions: false, resume: false, images: false },
      maxConcurrency: 1,
    },
  };
}

/** Start a CLI Run and wait for the fixture's process report line. */
async function startReported(
  host: ProcessWorkerHost,
  input: ExecutionSpec,
): Promise<{ report: Report; result: Promise<unknown> }> {
  const reported = Promise.withResolvers<string>();
  let text = "";
  const handle = await host.start(input, async (message: WorkerMessage) => {
    if (
      message.type === "event" &&
      message.event.type === "message.delta" &&
      typeof message.event.data.text === "string"
    )
      text += message.event.data.text;
    if (text.includes("\n")) reported.resolve(text);
  });
  void handle.result.catch(() => undefined);
  const report = parseReport(
    await Promise.race([
      reported.promise,
      handle.result.then(() => {
        throw new Error("CLI fixture ended before its process report");
      }),
    ]),
  );
  return { report, result: handle.result };
}

async function ownerToken(leaseDir: string): Promise<string> {
  const files = await readdir(leaseDir);
  assert.equal(files.length, 1);
  const lease: unknown = JSON.parse(
    await readFile(join(leaseDir, files[0]!), "utf8"),
  );
  assert.ok(
    typeof lease === "object" &&
      lease !== null &&
      "ownerToken" in lease &&
      typeof lease.ownerToken === "string",
  );
  return lease.ownerToken;
}

void test(
  "Session close reclaims setsid descendants found by parent chain and by tree marker, sparing a look-alike",
  posix,
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-escape-");
    const leaseDir = join(directory, "leases");
    const host = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 400 });
    t.after(() => host.close());
    let pids: number[] = [];
    reap(t, () => pids);
    // A launch recipe naming the marker must not detach the engine's tree.
    const input = cliSpec(directory, "escape-both", [
      "/usr/bin/env",
      `${WORKER_TREE_ENVIRONMENT}=forged-by-configuration`,
      process.execPath,
      peer,
      "escape-both",
    ]);
    const { report } = await startReported(host, input);
    assert.ok(report.cleared !== undefined);
    pids = [report.parent, report.orphan, report.cleared];
    for (const pid of pids) assert.ok(alive(pid), `${pid} must be running`);

    // An unrelated look-alike: the same script in its own session, reparented
    // like the escaped orphan (so it is not below this test process either),
    // with this Worker's marker text in its arguments and another tree's
    // marker in its environment. Its default SIGTERM handling ends it on any
    // signal.
    const starter = spawn(
      process.execPath,
      [
        peer,
        "orphan-sentinel",
        randomUUID(),
        `${WORKER_TREE_ENVIRONMENT}=${report.marker}`,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    const started = once(starter, "close");
    let starterOutput = "";
    starter.stdout.setEncoding("utf8");
    for await (const chunk of starter.stdout) starterOutput += String(chunk);
    await started;
    const lookAlike = Number(starterOutput.trim());
    assert.ok(Number.isSafeInteger(lookAlike) && lookAlike > 0);
    pids.push(lookAlike);
    assert.ok(alive(lookAlike));

    const token = await ownerToken(leaseDir);
    assert.equal(await host.closeSession(input.sessionId), "confirmed");
    assert.equal(alive(report.orphan), false, "marked orphan must be gone");
    assert.equal(alive(report.cleared), false, "cleared child must be gone");
    assert.equal(alive(report.parent), false);
    assert.deepEqual(await readdir(leaseDir), []);
    assert.equal(
      report.marker,
      token,
      "The engine inherits the Worker's owner token as its tree marker",
    );
    // Its parent reaps it promptly if it was signalled.
    await delay(200);
    assert.ok(
      alive(lookAlike),
      "An unattributed look-alike must never be signalled",
    );
  },
);

void test(
  "Gateway reaps a setsid descendant orphaned before cleanup through its tree marker before publishing confirmed cleanup",
  posix,
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "harnesshub-escape-run-",
    );
    const config = join(directory, "engines.json");
    const dataDir = join(directory, "data");
    await writeFile(
      config,
      JSON.stringify({
        engines: [
          {
            id: "escape-orphan",
            driver: "cli",
            command: [process.execPath, peer, "escape-orphan"],
          },
        ],
        cancelGraceMs: 400,
      }),
    );
    const hub = await startHub({
      configFile: config,
      dataDir,
      cwd: directory,
      demo: false,
      port: 0,
    });
    defer(() => hub.server.close());
    let pids: number[] = [];
    reap(t, () => pids);
    const created = await hub.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { engineId: "escape-orphan" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json<SessionRecord>();
    const accepted = await hub.server.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/runs`,
      payload: { text: "escape", timeoutMs: 20_000 },
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    let run = accepted.json<RunRecord>();
    const until = Date.now() + 15_000;
    while (!run.finishedAt) {
      assert.ok(
        Date.now() < until,
        `Run did not settle: ${JSON.stringify(run)}`,
      );
      await delay(20);
      run = (
        await hub.server.inject({ method: "GET", url: `/v1/runs/${run.id}` })
      ).json<RunRecord>();
    }
    const report = parseReport(
      hub.app
        .events(run.id)
        .filter((event) => event.type === "message.delta")
        .map((event) => event.data.text)
        .join(""),
    );
    pids = [report.parent, report.orphan];
    assert.equal(run.status, "completed");
    assert.equal(run.cleanupStatus, "confirmed");
    assert.equal(alive(report.orphan), false, "marked orphan must be gone");
    assert.equal(alive(report.parent), false);
    assert.deepEqual(await readdir(join(dataDir, "workers")), []);
    assert.match(report.marker ?? "", /^[a-f0-9-]{36}$/);
  },
);

void test(
  "Escaped descendants that cannot be signalled keep cleanup unconfirmed; recovery reclaims them by marker after the root is gone",
  posix,
  async (t) => {
    const { directory } = await temporaryDirectory(
      t,
      "harnesshub-escape-eperm-",
    );
    const leaseDir = join(directory, "leases");
    const host = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 200 });
    const recovery = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 400 });
    let quarantined = false;
    t.after(async () => {
      if (quarantined)
        await assert.rejects(host.close(), { code: "WORKER_CLEANUP_FAILED" });
      else await host.close();
      await recovery.close();
    });
    let pids: number[] = [];
    reap(t, () => pids);
    const input = cliSpec(directory, "escape-denied", [
      process.execPath,
      peer,
      "escape-orphan",
      "wait",
    ]);
    const { report } = await startReported(host, input);
    pids = [report.parent, report.orphan];
    const leaseFiles = await readdir(leaseDir);
    const realKill = process.kill;
    const denied = new Set<number | NodeJS.Signals | undefined>();
    // Only termination signals to the escaped process are denied.
    const denial = t.mock.method(
      process,
      "kill",
      (pid: number, signal?: number | NodeJS.Signals) => {
        if (
          Math.abs(pid) === report.orphan &&
          signal !== 0 &&
          signal !== undefined
        ) {
          denied.add(signal);
          throw Object.assign(new Error("Fixture permission denied"), {
            code: "EPERM",
          });
        }
        return realKill(pid, signal);
      },
    );
    try {
      const cleanup = await host.closeSession(input.sessionId);
      quarantined = cleanup !== "confirmed";
      assert.equal(cleanup, "unconfirmed");
      assert.ok(denied.has("SIGTERM") && denied.has("SIGKILL"));
      assert.ok(alive(report.orphan));
      assert.equal(alive(report.parent), false);
      assert.deepEqual(await readdir(leaseDir), leaseFiles);
    } finally {
      denial.mock.restore();
    }
    // The prior Worker is gone; only the lease's token attributes the orphan.
    assert.equal((await recovery.recover()).get(input.sessionId), "confirmed");
    assert.equal(alive(report.orphan), false, "recovery must reclaim it");
    assert.deepEqual(await readdir(leaseDir), []);
  },
);

void test(
  "Gateway restart recovery reclaims a live prior Worker's escaped descendants by parent chain and marker",
  posix,
  async (t) => {
    const { directory } = await temporaryDirectory(
      t,
      "harnesshub-escape-recovery-",
    );
    const leaseDir = join(directory, "leases");
    const oldHost = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 400 });
    const nextHost = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 400 });
    t.after(async () => {
      await oldHost.close();
      await nextHost.close();
    });
    let pids: number[] = [];
    reap(t, () => pids);
    const input = cliSpec(directory, "escape-recovery", [
      process.execPath,
      peer,
      "escape-both",
    ]);
    const { report, result } = await startReported(oldHost, input);
    assert.ok(report.cleared !== undefined);
    pids = [report.parent, report.orphan, report.cleared];
    assert.equal((await nextHost.recover()).get(input.sessionId), "confirmed");
    await assert.rejects(result, /Worker/);
    assert.equal(alive(report.orphan), false, "marked orphan must be gone");
    assert.equal(alive(report.cleared), false, "cleared child must be gone");
    assert.equal(alive(report.parent), false);
    assert.deepEqual(await readdir(leaseDir), []);
  },
);
