import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import { settleWorkerCleanup } from "../../src/process/cleanup-settlement.js";
import type { ExecutionSpec, WorkerMessage } from "../../src/domain/ports.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

function spec(directory: string): ExecutionSpec {
  return {
    sessionId: "worker-session" as SessionId,
    runId: "worker-run" as RunId,
    generation: 1,
    profile: {
      id: "fake",
      revision: "1",
      driver: "fake",
      enabled: true,
      maxConcurrency: 1,
      capabilities: { resume: false, permissions: true, images: false },
    },
    cwd: directory,
    stateDir: join(directory, "backend"),
    input: {
      text: "你好 worker",
      timeoutMs: 10_000,
      fixture: { scenario: "echo", chunks: 3 },
    },
  };
}

void test(
  "compiled Worker delivers ordered events, reuses session, and cancels permission waiting",
  { timeout: 15_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-worker-"));
    const host = new ProcessWorkerHost({ shutdownGraceMs: 300 });
    context.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    const input = spec(directory);
    const messages: WorkerMessage[] = [];
    const echo = await host.start(input, async (message) => {
      messages.push(message);
    });
    assert.equal((await echo.result).output, input.input.text);
    assert.deepEqual(
      messages.map((message) => message.seq),
      messages.map((_, index) => index + 1),
    );
    assert.equal(messages[0]?.type, "started");
    assert.equal(messages.at(-1)?.type, "result");
    const permission = Promise.withResolvers<void>();
    const waiting = await host.start(
      {
        ...input,
        runId: "permission-run" as RunId,
        generation: 2,
        input: { ...input.input, fixture: { scenario: "permission" } },
      },
      async (message) => {
        if (message.type === "permission") permission.resolve();
      },
    );
    await permission.promise;
    await waiting.cancel();
    assert.equal((await waiting.result).status, "cancelled");
    assert.equal(await host.closeSession(input.sessionId), "confirmed");
  },
);

void test(
  "Worker acknowledges explicit optionId and sink failure rejects execution with cleanup",
  { timeout: 15_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-worker-"));
    const host = new ProcessWorkerHost({ shutdownGraceMs: 100 });
    context.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    const input = spec(directory);
    const permissionReceived =
      Promise.withResolvers<Extract<WorkerMessage, { type: "permission" }>>();
    const messages: WorkerMessage[] = [];
    const handle = await host.start(
      {
        ...input,
        input: { ...input.input, fixture: { scenario: "permission" } },
      },
      async (message) => {
        messages.push(message);
        if (message.type === "permission") permissionReceived.resolve(message);
      },
    );
    const permission = await permissionReceived.promise;
    await handle.respondPermission(permission.permission.id, "fake-allow-once");
    assert.equal((await handle.result).status, "completed");
    assert.equal(
      messages.filter((message) => message.type === "permission_applied")
        .length,
      1,
    );
    const failed = await host.start(
      { ...input, runId: "sink-failure" as RunId, generation: 2 },
      async () => {
        throw new Error("SQLite fixture unavailable");
      },
    );
    await assert.rejects(failed.result, /SQLite fixture unavailable/);
    assert.equal(await host.closeSession(input.sessionId), "confirmed");
  },
);

void test(
  "compiled Worker exits on invalid incoming protocol",
  { timeout: 10_000 },
  async (context) => {
    const child = fork(
      new URL("../../src/worker/main.js", import.meta.url),
      [],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] },
    );
    context.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    await once(child, "message");
    const exit = once(child, "exit");
    child.send({ version: 99, type: "shutdown" });
    assert.equal((await exit)[0], 70);
  },
);

void test(
  "Worker recovery reclaims a verified prior lease and confirms the owned process exited",
  {
    timeout: 10_000,
    skip:
      process.platform === "win32"
        ? "Windows recovery remains unverified and unsupported"
        : false,
  },
  async (context) => {
    const directory = await mkdtemp(
      join(tmpdir(), "harnesshub-worker-recovery-"),
    );
    const leaseDir = join(directory, "leases");
    const oldHost = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 300 });
    const nextHost = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 300 });
    context.after(async () => {
      await oldHost.close();
      await nextHost.close();
      await rm(directory, { recursive: true });
    });
    const input = spec(directory);
    const waiting = Promise.withResolvers<void>();
    const handle = await oldHost.start(
      { ...input, input: { ...input.input, fixture: { scenario: "wait" } } },
      async (message) => {
        if (
          message.type === "event" &&
          message.event.type === "fixture.waiting"
        )
          waiting.resolve();
      },
    );
    await waiting.promise;
    const files = await readdir(leaseDir);
    assert.equal(files.length, 1);
    const record: unknown = JSON.parse(
      await readFile(join(leaseDir, files[0]!), "utf8"),
    );
    assert.ok(
      typeof record === "object" &&
        record !== null &&
        "pid" in record &&
        typeof record.pid === "number",
    );
    const pid = record.pid;
    const recovered = await nextHost.recover();
    assert.equal(recovered.get(input.sessionId), "confirmed");
    await assert.rejects(handle.result, /Worker/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(leaseDir), []);
  },
);

void test(
  "Worker recovery retains a mismatched lease without signalling the live process",
  {
    timeout: 10_000,
    skip:
      process.platform === "win32"
        ? "Windows recovery remains unverified and unsupported"
        : false,
  },
  async (context) => {
    const directory = await mkdtemp(
      join(tmpdir(), "harnesshub-worker-identity-"),
    );
    const leaseDir = join(directory, "leases");
    const oldHost = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 300 });
    const nextHost = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 300 });
    let original: string | undefined;
    let leasePath: string | undefined;
    context.after(async () => {
      if (original && leasePath) await writeFile(leasePath, original);
      await oldHost.close();
      await nextHost.close();
      await rm(directory, { recursive: true });
    });
    const input = spec(directory);
    const first = await oldHost.start(input, async () => {});
    assert.equal((await first.result).status, "completed");
    const filename = (await readdir(leaseDir))[0];
    assert.ok(filename);
    leasePath = join(leaseDir, filename);
    original = await readFile(leasePath, "utf8");
    const record: unknown = JSON.parse(original);
    assert.ok(typeof record === "object" && record !== null);
    const mismatch = JSON.stringify({ ...record, ownerToken: randomUUID() });
    await writeFile(leasePath, mismatch);
    assert.equal(
      (await nextHost.recover()).get(input.sessionId),
      "unconfirmed",
    );
    assert.equal(await readFile(leasePath, "utf8"), mismatch);
    const second = await oldHost.start(
      { ...input, generation: 2, runId: "still-alive" as RunId },
      async () => {},
    );
    assert.equal((await second.result).output, input.input.text);
  },
);

void test("Worker cleanup settlement rejects pending ready and result while retaining failed ownership", async () => {
  for (const scenario of [
    { cleanup: "unconfirmed", leaseFailure: false },
    { cleanup: "failed", leaseFailure: false },
    { cleanup: "confirmed", leaseFailure: true },
  ] as const) {
    const ready = Promise.withResolvers<void>();
    const result = Promise.withResolvers<void>();
    const lease = { id: "retained-lease" };
    const target = { failed: false, ready, active: { result }, lease };
    const rejections = [
      assert.rejects(ready.promise, { code: "WORKER_CLEANUP_UNCONFIRMED" }),
      assert.rejects(result.promise, { code: "WORKER_CLEANUP_UNCONFIRMED" }),
    ];
    let releaseCalls = 0;
    const outcome = settleWorkerCleanup(target, scenario.cleanup, () => {
      releaseCalls += 1;
      throw new Error("Lease removal failed before release");
    });
    await Promise.all(rejections);
    assert.equal(outcome, scenario.leaseFailure ? "failed" : scenario.cleanup);
    assert.equal(target.failed, true);
    assert.equal(target.lease, lease);
    assert.equal(releaseCalls, scenario.leaseFailure ? 1 : 0);
  }
});

void test(
  "Worker quarantine capacity includes unresolved leases after recovery",
  { timeout: 5_000 },
  async (context) => {
    const directory = await mkdtemp(
      join(tmpdir(), "harnesshub-worker-capacity-"),
    );
    const leaseDir = join(directory, "leases");
    const host = new ProcessWorkerHost({ leaseDir, maxWorkers: 1 });
    context.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    const previousId = "previous-session" as SessionId;
    const leasePath = join(leaseDir, `${previousId}.json`);
    const malformed = '{"unverifiable":"prior ownership"}';
    await writeFile(leasePath, malformed);
    assert.equal((await host.recover()).get(previousId), "unconfirmed");
    assert.equal(await host.closeSession(previousId), "unconfirmed");
    await assert.rejects(
      host.start(spec(directory), async () => {}),
      { code: "WORKER_CAPACITY" },
    );
    await assert.rejects(
      host.start({ ...spec(directory), sessionId: previousId }, async () => {}),
      { code: "WORKER_QUARANTINED" },
    );
    assert.equal(await readFile(leasePath, "utf8"), malformed);
  },
);
