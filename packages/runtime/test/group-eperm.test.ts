// SPDX-License-Identifier: MIT
/**
 * EPERM from signalling a process group. macOS answers it, not ESRCH, while
 * a group's only members left are zombies not yet reaped (observed on macOS
 * arm64: kill(-pgid, 0) and SIGKILL give EPERM until the zombie is reaped,
 * then ESRCH). The probe's cleanup and a lease's release wait that out; a
 * group that keeps refusing, as one holding another user's process does,
 * still fails. `process.kill` answers EPERM here on cue, so these run the
 * same on every POSIX system.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionId } from "@harnesshub/core/types";
import { recoverWorkerLease } from "../src/process/leases.js";
import { probeConfiguration } from "../src/process/probe.js";

const posix = process.platform !== "win32";
const real = process.kill.bind(process);
const eperm = () =>
  Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });

/**
 * `process.kill`, with `answer` deciding a call on a group (a negative
 * pid): "deliver" passes it on, "refuse" throws EPERM without signalling.
 * Every group it saw is killed after the test, so that code that fails to
 * end one fails the test instead of leaving it running.
 */
function groupKill(
  t: TestContext,
  answer: (signal: string | number) => "deliver" | "refuse",
): void {
  const groups = new Set<number>();
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0) groups.add(-pid);
    if (pid < 0 && answer(signal ?? "SIGTERM") === "refuse") throw eperm();
    return real(pid, signal);
  });
  t.after(() => {
    for (const group of groups)
      try {
        real(-group, "SIGKILL");
      } catch {
        // Gone already, as it should be.
      }
  });
}

/** An ACP peer that answers initialize and stays, optionally deaf to SIGTERM. */
function peer(ignoreTerm: boolean): string[] {
  return [
    process.execPath,
    "-e",
    `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
process.stdin.on("data", () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }) + "\\n"));
setInterval(() => {}, 1000);`,
  ];
}

async function probe(command: string[]) {
  return probeConfiguration(
    { command, env: {}, instructionPrefix: "", mcpServers: [] },
    "acp",
    tmpdir(),
    new AbortController().signal,
    30_000,
  );
}

void test(
  "a probe whose group answers EPERM after its peer has gone waits for ESRCH and passes",
  { skip: !posix && "the Windows probe runs through the Job helper" },
  async (t) => {
    // The cleanup's checks (signal 0) are refused three times, as while
    // the last members are unreaped zombies.
    let refusals = 3;
    groupKill(t, (signal) =>
      signal === 0 && refusals-- > 0 ? "refuse" : "deliver",
    );
    const result = await probe(peer(false));
    assert.equal(result.status, "passed", result.message);
    assert.ok(refusals < 0, "the refusals were met");
  },
);

void test(
  "a probe whose SIGKILL escalation meets EPERM kills its peer itself instead of throwing in a timer",
  {
    skip: !posix && "the Windows probe runs through the Job helper",
    timeout: 20_000,
  },
  async (t) => {
    // The peer ignores SIGTERM, so the escalation after 1 s is needed; its
    // group SIGKILL is refused once.
    let refused = false;
    groupKill(t, (signal) => {
      if (signal !== "SIGKILL" || refused) return "deliver";
      refused = true;
      return "refuse";
    });
    const result = await probe(peer(true));
    assert.ok(refused, "the escalation ran");
    assert.equal(result.status, "passed", result.message);
  },
);

void test(
  "a probe whose group keeps refusing fails its cleanup, as it would with another user's process",
  { skip: !posix && "the Windows probe runs through the Job helper" },
  async (t) => {
    // Delivered to the peer, so it ends; every check after it is refused.
    groupKill(t, (signal) => (signal === 0 ? "refuse" : "deliver"));
    const result = await probe(peer(false));
    assert.deepEqual(result, {
      name: "cleanup",
      status: "failed",
      message: "Probe descendants could not be confirmed absent",
    });
  },
);

/** A leased Worker in a group of its own, as recovery finds one, and its lease. */
async function leased(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "hh-lease-eperm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerPath = path.join(directory, "worker.mjs");
  await writeFile(workerPath, "setInterval(() => {}, 1000);\n");
  const ownerToken = randomUUID();
  const worker = spawn(
    process.execPath,
    [workerPath, `--harnesshub-owner=${ownerToken}`],
    { detached: true, stdio: "ignore" },
  );
  const closed = once(worker, "close");
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null)
      real(worker.pid!, "SIGKILL");
    await closed;
  });
  assert.ok(worker.pid !== undefined);
  return {
    worker,
    lease: {
      version: 2 as const,
      id: randomUUID(),
      sessionId: "lease-eperm-session" as SessionId,
      pid: worker.pid,
      ownerToken,
      workerPath,
      executable: process.execPath,
      startedAt: Date.now(),
      platform: process.platform,
    },
  };
}

void test(
  "a lease whose group answers EPERM while its last member exits is released once the group is gone",
  { skip: !posix && "POSIX lease recovery reads ps" },
  async (t) => {
    const { worker, lease } = await leased(t);
    // The group's first SIGTERM finds the Worker exiting: it is killed and
    // the group answers EPERM until the zombie is reaped.
    let refused = false;
    groupKill(t, (signal) => {
      if (signal !== "SIGTERM" || refused) return "deliver";
      refused = true;
      real(lease.pid, "SIGKILL");
      return "refuse";
    });
    assert.equal(await recoverWorkerLease(lease, 2_000), "confirmed");
    assert.ok(refused);
    assert.equal(
      worker.signalCode ?? (await once(worker, "exit"))[1],
      "SIGKILL",
    );
  },
);

void test(
  "a lease whose group keeps refusing its signals is not released, and its Worker is left alone",
  { skip: !posix && "POSIX lease recovery reads ps" },
  async (t) => {
    const { worker, lease } = await leased(t);
    groupKill(t, (signal) => (signal === 0 ? "deliver" : "refuse"));
    assert.equal(await recoverWorkerLease(lease, 200), "failed");
    assert.equal(worker.exitCode, null);
    assert.equal(worker.signalCode, null);
  },
);
