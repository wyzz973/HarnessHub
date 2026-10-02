import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type {
  ExecutionHandle,
  ExecutionSpec,
  WorkerHost,
  WorkerMessage,
} from "../../src/domain/ports.js";
import type {
  CleanupStatus,
  DriverResult,
  RunId,
  SessionId,
} from "../../src/domain/types.js";
import { Runtime } from "../../src/runtime/runtime.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { loadConfig } from "../../src/engine/registry.js";

/** A handshake barrier for actor unit tests; real IPC is covered by Worker integration tests. */
class ControlledHost implements WorkerHost {
  entered = Promise.withResolvers<void>();
  handshake = Promise.withResolvers<ExecutionHandle>();
  result = Promise.withResolvers<DriverResult>();
  sink?: (message: WorkerMessage) => Promise<void>;
  identity?: ExecutionSpec;
  ready = false;
  async start(
    spec: ExecutionSpec,
    sink: (message: WorkerMessage) => Promise<void>,
  ) {
    this.identity = spec;
    this.sink = sink;
    this.entered.resolve();
    return this.handshake.promise;
  }
  async begin() {
    this.ready = true;
    this.handshake.resolve({
      result: this.result.promise,
      cancel: async () => {
        this.result.resolve({ status: "cancelled" });
      },
      respondPermission: async () => {},
    });
    assert.ok(this.identity);
    await this.sink?.({
      ...this.identity,
      version: 1,
      seq: 1,
      type: "started",
    });
  }
  async closeSession(_id: SessionId): Promise<CleanupStatus> {
    if (!this.ready)
      this.handshake.reject(new Error("Worker closed during handshake"));
    this.result.resolve({ status: "cancelled" });
    return "confirmed";
  }
  async close() {
    if (this.identity) await this.closeSession(this.identity.sessionId);
  }
}
async function settled(store: SqliteStore, id: RunId) {
  const until = Date.now() + 3000;
  for (;;) {
    const run = store.getRun(id);
    if (run.finishedAt !== undefined) return run;
    assert.ok(Date.now() < until, "run must settle");
    await delay(1);
  }
}
void test("cancelling during a blocked handshake settles once and rejects late completion", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "harnesshub-handshake-"),
  );
  const store = new SqliteStore(path.join(directory, "store.db"));
  const host = new ControlledHost();
  const runtime = new Runtime(store, host, {
    ...(await loadConfig({ cwd: directory, demo: true })),
    stateDir: directory,
    publishArtifact: async () => {
      throw new Error("not used");
    },
  });
  t.after(async () => {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = runtime.createSession({});
  const { run } = runtime.submit(session.id, { text: "hold" });
  await host.entered.promise;
  assert.equal(store.getRun(run.id).status, "starting");
  await runtime.cancel(run.id);
  assert.equal((await settled(store, run.id)).status, "cancelled");
  assert.ok(host.identity);
  await host.sink?.({
    ...host.identity,
    version: 1,
    seq: 99,
    type: "result",
    result: { status: "completed", output: "late" },
  });
  assert.equal(store.getRun(run.id).status, "cancelled");
  assert.equal(
    store.events(run.id).filter((event) => event.type === "RUN_CANCELLED")
      .length,
    1,
  );
});
void test("cancellation wins a same-turn backend-completion race without duplicate terminal events", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "harnesshub-result-race-"),
  );
  const store = new SqliteStore(path.join(directory, "store.db"));
  const host = new ControlledHost();
  const runtime = new Runtime(store, host, {
    ...(await loadConfig({ cwd: directory, demo: true })),
    stateDir: directory,
    publishArtifact: async () => {
      throw new Error("not used");
    },
  });
  t.after(async () => {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = runtime.createSession({});
  const { run } = runtime.submit(session.id, { text: "race" });
  await host.entered.promise;
  await host.begin();
  const cancelled = runtime.cancel(run.id);
  host.result.resolve({ status: "completed", output: "too late" });
  await cancelled;
  assert.equal((await settled(store, run.id)).status, "cancelled");
  assert.equal(
    store
      .events(run.id)
      .filter((event) => /RUN_(COMPLETED|CANCELLED)$/.test(event.type)).length,
    1,
  );
});
