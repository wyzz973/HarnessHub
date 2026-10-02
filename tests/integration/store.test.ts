import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { HubError } from "../../src/domain/errors.js";
import type {
  ArtifactId,
  EngineProfile,
  PermissionId,
  PermissionRecord,
  RunId,
  RunRecord,
  SessionId,
} from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const engine: EngineProfile = {
  id: "fake",
  driver: "fake",
  revision: "test-v1",
  enabled: true,
  maxConcurrency: 1,
  capabilities: { resume: false, permissions: true, images: false },
};

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-store-"));
  const path = join(dir, "state.sqlite");
  const owned: Array<{ close(): void }> = [];
  t.after(() => {
    for (const resource of owned.reverse()) resource.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new SqliteStore(path);
  owned.push(store);
  const session = store.createSession(engine, { id: "workspace", path: dir });
  return { store, session, path, dir, owned };
}

function permission(run: RunRecord): PermissionRecord {
  return {
    id: randomUUID() as PermissionId,
    sessionId: run.sessionId,
    runId: run.id,
    generation: run.generation,
    toolCallId: "tool-1",
    prompt: "Write a test file?",
    options: [
      { id: "allow", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Reject once", kind: "reject_once" },
    ],
    status: "pending",
    createdAt: Date.now(),
    expiresAt: run.deadlineAt,
  };
}

void test("idempotent reception normalizes input and isolates session keys; events survive reopen", (t) => {
  const { store, session, path, dir, owned } = fixture(t);
  const first = store.acceptRun(
    session.id,
    {
      text: "你好",
      timeoutMs: 60_000,
      fixture: { scenario: "echo", chunks: 2, delayMs: 1 },
    },
    "key",
  );
  const duplicate = store.acceptRun(
    session.id,
    {
      fixture: { delayMs: 1, chunks: 2, scenario: "echo" },
      timeoutMs: 60_000,
      text: "你好",
    },
    "key",
  );
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.run, first.run);
  assert.throws(
    () =>
      store.acceptRun(
        session.id,
        { text: "different", timeoutMs: 60_000 },
        "key",
      ),
    (error: unknown) => error instanceof HubError && error.statusCode === 409,
  );
  const other = store.createSession(engine, { id: "workspace", path: dir });
  assert.notEqual(
    store.acceptRun(other.id, first.run.input, "key").run.id,
    first.run.id,
  );
  store.setRunStatus(first.run.id, "starting");
  const startedAt = store.getRun(first.run.id).startedAt;
  store.setRunStatus(first.run.id, "starting");
  assert.equal(store.getRun(first.run.id).startedAt, startedAt);
  store.appendEvent(first.run.id, {
    type: "TEXT_DELTA",
    data: { text: "hello" },
    sourceSeq: 12,
  });
  assert.equal(
    store.appendEvent(first.run.id, {
      type: "TEXT_DELTA",
      data: { text: "duplicate" },
      sourceSeq: 12,
    }),
    undefined,
  );
  store.finishRun(first.run.id, {
    status: "completed",
    stopReason: "end_turn",
    cleanupStatus: "confirmed",
    output: "hello",
  });
  const events = store.events(first.run.id);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4],
  );
  const saved = store.getRun(first.run.id);
  store.close();
  const reopened = new SqliteStore(path);
  owned.push(reopened);
  assert.deepEqual(reopened.getRun(first.run.id), saved);
  assert.deepEqual(reopened.events(first.run.id), events);
  assert.equal(reopened.listSessions().length, 2);
  assert.equal(reopened.listRuns(session.id).length, 1);
});

void test("event insertion failure rolls back acceptance and terminal outcome including permission expiry", (t) => {
  const { store, session, path, owned } = fixture(t);
  const inspector = new DatabaseSync(path);
  owned.push(inspector);
  inspector.exec(
    "CREATE TRIGGER fail_queue BEFORE INSERT ON events WHEN NEW.type = 'RUN_QUEUED' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
  );
  assert.throws(
    () =>
      store.acceptRun(
        session.id,
        { text: "rollback", timeoutMs: 60_000 },
        "retryable",
      ),
    /injected write failure/,
  );
  assert.equal(store.listRuns().length, 0);
  inspector.exec("DROP TRIGGER fail_queue");
  const run = store.acceptRun(
    session.id,
    { text: "rollback", timeoutMs: 60_000 },
    "retryable",
  ).run;
  assert.equal(run.generation, 1);
  store.createPermission(permission(run));
  const previousRun = store.getRun(run.id);
  const previousEvents = store.events(run.id);
  inspector.exec(
    "CREATE TRIGGER fail_terminal BEFORE INSERT ON events WHEN NEW.type = 'RUN_COMPLETED' BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;",
  );
  assert.throws(
    () =>
      store.finishRun(run.id, {
        status: "completed",
        stopReason: "end_turn",
        cleanupStatus: "confirmed",
      }),
    /injected terminal failure/,
  );
  assert.deepEqual(store.getRun(run.id), previousRun);
  assert.deepEqual(store.events(run.id), previousEvents);
  assert.equal(store.listPermissions(run.id)[0]?.status, "pending");
  inspector.exec("DROP TRIGGER fail_terminal");
  store.finishRun(run.id, {
    status: "cancelled",
    stopReason: "user_cancelled",
    cleanupStatus: "confirmed",
  });
  assert.equal(store.listPermissions(run.id)[0]?.status, "expired");
  assert.deepEqual(
    store
      .events(run.id)
      .slice(-2)
      .map((event) => event.type),
    ["PERMISSION_EXPIRED", "RUN_CANCELLED"],
  );
});

void test("concurrent database connections commit one immutable terminal outcome and event", async (t) => {
  const { store, session, path } = fixture(t);
  const run = store.acceptRun(session.id, {
    text: "race",
    timeoutMs: 60_000,
  }).run;
  const gate = new SharedArrayBuffer(4);
  const signal = new Int32Array(gate);
  const workers: Worker[] = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  const contenders = ["completed", "timed_out"].map((status) => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { SqliteStore } = await import(workerData.module);
        const store = new SqliteStore(workerData.path);
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        const run = store.finishRun(workerData.id, { status: workerData.status, stopReason: workerData.status, cleanupStatus: 'confirmed', output: workerData.status });
        store.close();
        parentPort.postMessage(run);
      })().catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: {
          module: new URL("../../src/storage/sqlite-store.js", import.meta.url)
            .href,
          path,
          id: run.id,
          gate,
          status,
        },
      },
    );
    workers.push(worker);
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const result = new Promise<unknown>((resolve, reject) => {
      worker.on("message", (value: unknown) => {
        if (value === "ready") markReady?.();
        else resolve(value);
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Worker exited with ${code}`));
      });
    });
    return { ready, result };
  });
  await Promise.all(contenders.map((contender) => contender.ready));
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
  const results = await Promise.all(
    contenders.map((contender) => contender.result),
  );
  assert.deepEqual(results[0], results[1]);
  const settled = store.getRun(run.id);
  assert.equal(settled.output, settled.status);
  assert.equal(settled.stopReason, settled.status);
  assert.equal(
    store
      .events(run.id)
      .filter((event) =>
        ["RUN_COMPLETED", "RUN_TIMED_OUT"].includes(event.type),
      ).length,
    1,
  );
  assert.equal(
    store.appendEvent(run.id, { type: "TEXT_DELTA", data: { text: "late" } }),
    undefined,
  );
  assert.deepEqual(store.setRunStatus(run.id, "running"), settled);
  assert.deepEqual(
    store.finishRun(run.id, {
      status: "failed",
      stopReason: "late_failure",
      cleanupStatus: "failed",
    }),
    settled,
  );
});

void test("permissions validate ownership, options, expiry and persist decision separately from application", (t) => {
  const { store, session, path, owned } = fixture(t);
  const run = store.acceptRun(session.id, {
    text: "permission",
    timeoutMs: 60_000,
  }).run;
  const request = permission(run);
  assert.throws(
    () =>
      store.createPermission({ ...request, generation: run.generation + 1 }),
    /active execution/,
  );
  store.createPermission(request);
  assert.throws(
    () => store.decidePermission(request.id, "not-an-option"),
    /Option does not belong/,
  );
  assert.equal(store.getPermission(request.id).status, "pending");
  assert.throws(
    () => store.markPermissionApplied(request.id),
    /persisted decision/,
  );
  const decided = store.decidePermission(request.id, "allow");
  assert.equal(decided.status, "decided");
  const seq = store.getRun(run.id).lastSeq;
  assert.deepEqual(store.decidePermission(request.id, "allow"), decided);
  assert.equal(store.getRun(run.id).lastSeq, seq);
  assert.throws(
    () => store.decidePermission(request.id, "deny"),
    /different decision/,
  );
  assert.equal(store.markPermissionApplied(request.id).status, "applied");
  store.markPermissionApplied(request.id);
  const second = permission(run);
  store.createPermission(second);
  const inspector = new DatabaseSync(path);
  owned.push(inspector);
  inspector
    .prepare("UPDATE permissions SET record = ? WHERE id = ?")
    .run(JSON.stringify({ ...second, expiresAt: Date.now() - 1 }), second.id);
  assert.throws(
    () => store.decidePermission(second.id, "allow"),
    /no longer accepts/,
  );
  assert.equal(store.getPermission(second.id).status, "expired");
  assert.equal(store.events(run.id).at(-1)?.type, "PERMISSION_EXPIRED");
  const third = permission(run);
  store.createPermission(third);
  store.decidePermission(third.id, "allow");
  store.finishRun(run.id, {
    status: "interrupted",
    stopReason: "worker_lost",
    cleanupStatus: "unconfirmed",
  });
  assert.equal(store.getPermission(third.id).status, "expired");
  assert.equal(store.getPermission(request.id).status, "applied");
  assert.throws(
    () => store.markPermissionApplied(third.id),
    /persisted decision/,
  );
});

void test("artifact metadata is event-backed and lookup failures are explicit", (t) => {
  const { store, session, dir } = fixture(t);
  const run = store.acceptRun(session.id, {
    text: "artifact",
    timeoutMs: 60_000,
  }).run;
  const artifact = {
    id: randomUUID() as ArtifactId,
    runId: run.id,
    name: "result.txt",
    mediaType: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
    path: join(dir, "result.txt"),
    createdAt: Date.now(),
  };
  store.registerArtifact(artifact);
  assert.deepEqual(store.getArtifact(artifact.id), artifact);
  assert.deepEqual(store.listArtifacts(run.id), [artifact]);
  assert.equal(store.events(run.id).at(-1)?.type, "ARTIFACT_CREATED");
  assert.equal(store.events(run.id).at(-1)?.data.path, undefined);
  assert.throws(
    () => store.appendEvent(run.id, { type: "RUN_COMPLETED", data: {} }),
    /owned by the Store/,
  );
  assert.throws(
    () => store.getRun("missing" as RunId),
    (error: unknown) => error instanceof HubError && error.statusCode === 404,
  );
  assert.throws(
    () => store.getSession("missing" as SessionId),
    (error: unknown) => error instanceof HubError && error.statusCode === 404,
  );
  store.setSessionStatus(session.id, "closing");
  assert.throws(
    () => store.acceptRun(session.id, run.input),
    /no longer accepting/,
  );
  store.setSessionStatus(session.id, "closed");
  assert.throws(
    () => store.setSessionStatus(session.id, "open"),
    /cannot be reopened/,
  );
});

void test("schema initialization preserves records and rejects future versions or corrupt JSON shapes", (t) => {
  const { store, session, path, owned } = fixture(t);
  const inspector = new DatabaseSync(path);
  owned.push(inspector);
  assert.equal(inspector.prepare("PRAGMA user_version").get()?.user_version, 1);
  assert.equal(
    inspector.prepare("PRAGMA journal_mode").get()?.journal_mode,
    "wal",
  );
  inspector
    .prepare("UPDATE sessions SET record = ? WHERE id = ?")
    .run("{}", session.id);
  assert.throws(
    () => store.getSession(session.id),
    (error: unknown) =>
      error instanceof HubError && error.code === "STORAGE_CORRUPT",
  );
  inspector.exec("PRAGMA user_version = 2");
  assert.throws(
    () => new SqliteStore(path),
    (error: unknown) =>
      error instanceof HubError && error.code === "STORAGE_VERSION_UNSUPPORTED",
  );
  assert.equal(inspector.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.equal(
    inspector.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count,
    1,
  );
});

void test("event pagination is bounded and synchronous write cost is measured once", (t) => {
  const { store, session } = fixture(t);
  const run = store.acceptRun(session.id, {
    text: "load",
    timeoutMs: 60_000,
  }).run;
  const begin = performance.now();
  let slowest = 0;
  for (let sourceSeq = 1; sourceSeq <= 1001; sourceSeq++) {
    const started = performance.now();
    store.appendEvent(run.id, {
      type: "TEXT_DELTA",
      data: { text: "测".repeat(100) },
      sourceSeq,
    });
    slowest = Math.max(slowest, performance.now() - started);
  }
  t.diagnostic(
    `1,001 synchronous WAL/FULL event transactions: ${(performance.now() - begin).toFixed(1)} ms total; longest call ${slowest.toFixed(1)} ms; each call retains zero queued writes.`,
  );
  const firstPage = store.events(run.id, 0, 10_000);
  const secondPage = store.events(run.id, firstPage.at(-1)?.seq);
  assert.equal(firstPage.length, 1000);
  assert.deepEqual(
    secondPage.map((event) => event.seq),
    [1001, 1002],
  );
  assert.throws(() => store.events(run.id, -1), /cursor/);
  assert.throws(() => store.events(run.id, 0, 0), /limit/);
});
