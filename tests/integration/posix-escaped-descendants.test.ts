// SPDX-License-Identifier: MIT
import { WORKER_ENTRY } from "../support/entries.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { ProcessWorkerHost } from "@harnesshub/runtime/process/worker-host";
import { readProcessTable } from "@harnesshub/runtime/process/process-table";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import type { ExecutionSpec, WorkerMessage } from "@harnesshub/core/ports";
import type {
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "@harnesshub/core/types";
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

/**
 * Fixture processes by PID and start time. `running` is false once a process
 * has exited, is a zombie or its PID names another process. Teardown kills
 * only processes that are still the recorded ones, so a passing test signals
 * nothing and a reused PID is never hit.
 */
async function processes(t: TestContext) {
  const recorded = new Map<number, string>();
  t.after(async () => {
    const { table } = await readProcessTable();
    for (const [pid, started] of recorded) {
      const row = table.get(pid);
      if (!row || row.zombie || row.started !== started) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Exited after the snapshot. */
      }
    }
  });
  return {
    async track(...pids: number[]) {
      const { table } = await readProcessTable();
      for (const pid of pids) {
        const row = table.get(pid);
        assert.ok(row && !row.zombie, `${pid} must be running`);
        recorded.set(pid, row.started);
      }
    },
    async running(pid: number) {
      const row = (await readProcessTable()).table.get(pid);
      return (
        row !== undefined && !row.zombie && row.started === recorded.get(pid)
      );
    },
  };
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

async function lease(
  leaseDir: string,
): Promise<{ pid: number; ownerToken: string }> {
  const files = await readdir(leaseDir);
  assert.equal(files.length, 1);
  const value: unknown = JSON.parse(
    await readFile(join(leaseDir, files[0]!), "utf8"),
  );
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "ownerToken" in value &&
      typeof value.ownerToken === "string" &&
      "pid" in value &&
      typeof value.pid === "number",
  );
  return { pid: value.pid, ownerToken: value.ownerToken };
}

/** Collect a child's stdout until it closes. */
async function output(child: ReturnType<typeof spawn>): Promise<string> {
  const closed = once(child, "close");
  let text = "";
  child.stdout!.setEncoding("utf8");
  for await (const chunk of child.stdout!) text += String(chunk);
  await closed;
  return text;
}

void test(
  "Session close reclaims setsid descendants found by parent chain and by tree marker, and never signals a look-alike",
  posix,
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-escape-");
    const leaseDir = join(directory, "leases");
    const host = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir,
      shutdownGraceMs: 400,
    });
    t.after(() => host.close());
    const fixtures = await processes(t);
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
    await fixtures.track(report.parent, report.orphan, report.cleared);

    // An unrelated look-alike: the same script in its own session, reparented
    // like the escaped orphan (so it is not below this test process either),
    // with this Worker's marker text in its arguments and another tree's
    // marker in its environment. It records any catchable signal in a file.
    const signalFile = join(directory, "look-alike-signal");
    const lookAlike = Number(
      (
        await output(
          spawn(
            process.execPath,
            [
              peer,
              "orphan-sentinel",
              randomUUID(),
              signalFile,
              `${WORKER_TREE_ENVIRONMENT}=${report.marker}`,
            ],
            {
              stdio: ["ignore", "pipe", "ignore"],
              env: { PATH: process.env.PATH ?? "" },
            },
          ),
        )
      ).trim(),
    );
    assert.ok(Number.isSafeInteger(lookAlike) && lookAlike > 1);
    await fixtures.track(lookAlike);

    const token = (await lease(leaseDir)).ownerToken;
    assert.equal(await host.closeSession(input.sessionId), "confirmed");
    assert.equal(
      await fixtures.running(report.orphan),
      false,
      "marked orphan must be gone",
    );
    assert.equal(
      await fixtures.running(report.cleared),
      false,
      "cleared child must be gone",
    );
    assert.equal(await fixtures.running(report.parent), false);
    assert.deepEqual(await readdir(leaseDir), []);
    assert.equal(
      report.marker,
      token,
      "The engine inherits the Worker's owner token as its tree marker",
    );
    assert.equal(
      existsSync(signalFile),
      false,
      "An unattributed look-alike must never be signalled",
    );
    assert.equal(await fixtures.running(lookAlike), true);
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
    assert.equal(run.status, "completed");
    assert.equal(run.cleanupStatus, "confirmed");
    // The orphan was started before the Run settled. If it still runs, the
    // cleanup above was wrong; it is killed here so the failure leaks nothing.
    const orphan = (await readProcessTable()).table.get(report.orphan);
    if (orphan && !orphan.zombie) process.kill(report.orphan, "SIGKILL");
    assert.ok(!orphan || orphan.zombie, "marked orphan must be gone");
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
    const records: { event: string; fields: LogFields | undefined }[] = [];
    const log: LogSink = {
      level: "info",
      info: (event, fields) => void records.push({ event, fields }),
      debug: () => undefined,
    };
    const host = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir,
      shutdownGraceMs: 200,
      log,
    });
    const recovery = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir,
      shutdownGraceMs: 400,
    });
    let quarantined = false;
    t.after(async () => {
      if (quarantined)
        await assert.rejects(host.close(), { code: "WORKER_CLEANUP_FAILED" });
      else await host.close();
      await recovery.close();
    });
    const fixtures = await processes(t);
    const input = cliSpec(directory, "escape-denied", [
      process.execPath,
      peer,
      "escape-orphan",
      "wait",
    ]);
    const { report } = await startReported(host, input);
    await fixtures.track(report.parent, report.orphan);
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
      // The reason is in the Gateway log, so a quarantine can be diagnosed.
      assert.deepEqual(
        records
          .filter((record) => record.event === "worker.tree_unconfirmed")
          .map((record) => [
            record.fields?.reason,
            record.fields?.survivors,
            record.fields?.status,
          ]),
        [["survivors", 1, "unconfirmed"]],
      );
      assert.equal(await fixtures.running(report.orphan), true);
      assert.equal(await fixtures.running(report.parent), false);
      assert.deepEqual(await readdir(leaseDir), leaseFiles);
    } finally {
      denial.mock.restore();
    }
    // The prior Worker is gone; only the lease's token attributes the orphan.
    assert.equal((await recovery.recover()).get(input.sessionId), "confirmed");
    assert.equal(
      await fixtures.running(report.orphan),
      false,
      "recovery must reclaim it",
    );
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
    const oldHost = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir,
      shutdownGraceMs: 400,
    });
    const nextHost = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir,
      shutdownGraceMs: 400,
    });
    t.after(async () => {
      await oldHost.close();
      await nextHost.close();
    });
    const fixtures = await processes(t);
    const input = cliSpec(directory, "escape-recovery", [
      process.execPath,
      peer,
      "escape-both",
    ]);
    const { report, result } = await startReported(oldHost, input);
    assert.ok(report.cleared !== undefined);
    await fixtures.track(report.parent, report.orphan, report.cleared);
    assert.equal((await nextHost.recover()).get(input.sessionId), "confirmed");
    await assert.rejects(result, /Worker/);
    assert.equal(
      await fixtures.running(report.orphan),
      false,
      "marked orphan must be gone",
    );
    assert.equal(
      await fixtures.running(report.cleared),
      false,
      "cleared child must be gone",
    );
    assert.equal(await fixtures.running(report.parent), false);
    assert.deepEqual(await readdir(leaseDir), []);
  },
);

/** States of this process's direct children, read without running the event loop. */
function childStates(): Map<number, string> {
  const listing = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,stat="], {
    encoding: "utf8",
  });
  assert.equal(listing.status, 0);
  const states = new Map<number, string>();
  for (const line of listing.stdout.split("\n")) {
    const [pid, ppid, stat] = line.trim().split(/\s+/);
    if (Number(ppid) === process.pid && stat) states.set(Number(pid), stat);
  }
  return states;
}

/** Wait without yielding to the event loop, so Node reaps no child meanwhile. */
function blockUntil(
  condition: () => boolean,
  message: string,
  limitMs = 10_000,
): boolean {
  const until = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() >= until) {
      assert.ok(limitMs < 10_000, message);
      return false;
    }
    const pause = Date.now() + 10;
    while (Date.now() < pause);
  }
  return true;
}

void test(
  "A crashed Worker that is an unreaped zombie during the snapshot keeps its group's escaped children attributable",
  posix,
  async (t) => {
    const { directory } = await temporaryDirectory(
      t,
      "harnesshub-escape-crash-",
    );
    const leaseDir = join(directory, "leases");
    const host = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir,
      shutdownGraceMs: 400,
    });
    t.after(() => host.close());
    const fixtures = await processes(t);
    const input = cliSpec(directory, "escape-crash", [
      process.execPath,
      peer,
      "escape-both",
    ]);
    const { report, result } = await startReported(host, input);
    assert.ok(report.cleared !== undefined);
    await fixtures.track(report.parent, report.orphan, report.cleared);
    const worker = (await lease(leaseDir)).pid;
    // The event loop does not run until the snapshot child has read the
    // process table, so the killed Worker is an unreaped zombie in that
    // snapshot, and Node reaps it before the snapshot settles. The child may
    // block writing its output to the unread pipe, so it gets a bounded time
    // to read the table instead of being awaited to exit.
    const before = new Set(childStates().keys());
    process.kill(worker, "SIGKILL");
    blockUntil(
      () => childStates().get(worker)?.startsWith("Z") === true,
      "the killed Worker must become a zombie",
    );
    const closing = host.closeSession(input.sessionId);
    const snapshot = () =>
      [...childStates()].find(([pid]) => !before.has(pid) && pid !== worker);
    blockUntil(() => snapshot() !== undefined, "the snapshot child must start");
    blockUntil(
      () => snapshot()?.[1].startsWith("Z") !== false,
      "the snapshot child may still be writing",
      1_500,
    );
    assert.equal(await closing, "confirmed");
    await assert.rejects(result, /Worker/);
    assert.equal(
      await fixtures.running(report.cleared),
      false,
      "cleared child of a group member must be gone",
    );
    assert.equal(
      await fixtures.running(report.orphan),
      false,
      "marked orphan must be gone",
    );
    assert.equal(await fixtures.running(report.parent), false);
  },
);

void test(
  "Recovery never signals a leased group that contains the recovering Gateway",
  posix,
  async (t) => {
    const { directory } = await temporaryDirectory(
      t,
      "harnesshub-escape-shield-",
    );
    const leaseDir = join(directory, "leases");
    const signalFile = join(directory, "fake-worker-signal");
    const fixtures = await processes(t);
    // A process with a leased Worker's exact command line, leading its own
    // group. The recovering Gateway runs as its child, inside that group.
    const ownerToken = randomUUID();
    const fake = spawn(
      process.execPath,
      [peer, `--harnesshub-owner=${ownerToken}`],
      {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "",
          FIXTURE_LEASE_DIR: leaseDir,
          FIXTURE_SIGNAL_FILE: signalFile,
        },
      },
    );
    assert.ok(fake.pid !== undefined);
    let text = "";
    fake.stdout!.setEncoding("utf8");
    fake.stdout!.on("data", (chunk: string) => {
      text += chunk;
    });
    await mkdir(leaseDir, { mode: 0o700 });
    await writeFile(
      join(leaseDir, "shielded.json"),
      JSON.stringify({
        version: 1,
        id: randomUUID(),
        sessionId: "shielded",
        pid: fake.pid,
        ownerToken,
        workerPath: peer,
        executable: process.execPath,
        startedAt: Date.now(),
        platform: process.platform,
      }),
    );
    await fixtures.track(fake.pid);
    fake.stdin!.end("recover\n");
    const until = Date.now() + 15_000;
    while (!text.includes('"recovery"') && fake.exitCode === null) {
      assert.ok(Date.now() < until, `No recovery report: ${text}`);
      await delay(20);
    }
    const lines = text.trim().split("\n");
    assert.equal(
      existsSync(signalFile),
      false,
      "the leased group must not be signalled",
    );
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as unknown),
      [
        { statuses: { shielded: "unconfirmed" } },
        { recovery: { code: 0, signal: null } },
      ],
    );
    assert.equal(await fixtures.running(fake.pid), true);
  },
);
