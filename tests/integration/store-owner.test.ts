// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { HubError } from "@harnesshub/core/errors";
import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-owner-"));
  const path = join(dir, "state.sqlite");
  const connections: SqliteStore[] = [];
  const open = () => {
    const store = new SqliteStore(path);
    connections.push(store);
    return store;
  };
  t.after(() => {
    for (const store of connections) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { open, path };
}

void test("owner lease rejects live instances and stale releases cannot remove a newer owner", (t) => {
  const { open } = fixture(t);
  const first = open();
  const second = open();
  const releaseFirst = first.acquireOwner();
  first.acquireOwner();
  assert.throws(
    () => second.acquireOwner(),
    (error: unknown) =>
      error instanceof HubError &&
      error.code === "RUNTIME_ALREADY_RUNNING" &&
      error.statusCode === 409,
  );
  releaseFirst();
  releaseFirst();
  const releaseSecond = second.acquireOwner();
  releaseFirst();
  first.close();
  const third = open();
  assert.throws(() => third.acquireOwner(), /Another live Gateway/);
  second.close();
  releaseSecond();
  third.acquireOwner();
  third.close();
  open().acquireOwner();
});

void test("owner close only deletes its own token; a record without a lock holder is stale", (t) => {
  const { open, path } = fixture(t);
  const first = open();
  first.acquireOwner();
  const db = new DatabaseSync(path);
  const ownerToken = () =>
    db
      .prepare(
        "SELECT json_extract(value, '$.token') AS token FROM runtime_metadata WHERE key = 'owner'",
      )
      .get()?.token;
  try {
    db.prepare("UPDATE runtime_metadata SET value = ? WHERE key = 'owner'").run(
      JSON.stringify({
        pid: process.pid,
        token: "replacement-owner",
        startedAt: Date.now(),
      }),
    );
    first.close();
    assert.equal(ownerToken(), "replacement-owner");
    // Nobody holds the lock any more, so the remaining record is stale.
    open().acquireOwner();
    assert.notEqual(ownerToken(), "replacement-owner");
  } finally {
    db.close();
  }
});

void test(
  "a stale owner record naming a live, unrelated PID cannot block startup",
  { timeout: 10_000 },
  async (t) => {
    const { open, path } = fixture(t);
    open().close();
    // Stands in for an unrelated process that reused the dead Gateway's PID.
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    t.after(() => unrelated.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      unrelated.once("spawn", resolve);
      unrelated.once("error", reject);
    });
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)))",
      );
      db.prepare(
        "INSERT INTO runtime_metadata (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(
        JSON.stringify({
          pid: unrelated.pid,
          token: "dead-gateway",
          startedAt: 1,
        }),
      );
    } finally {
      db.close();
    }
    const release = open().acquireOwner();
    release();
  },
);

void test(
  "dead owner recovery serializes competing startups in the same SQLite transaction",
  { timeout: 10_000 },
  async (t) => {
    const { open, path } = fixture(t);
    open();
    const moduleUrl = import.meta
      .resolve("@harnesshub/store/storage/sqlite-store");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { SqliteStore } from ${JSON.stringify(moduleUrl)}; const store = new SqliteStore(process.argv[1]); store.acquireOwner(); process.stdout.write(String(process.pid));`,
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pidText = "";
    let stderr = "";
    child.stdout.on("data", (value: Buffer) => {
      pidText += value.toString();
    });
    child.stderr.on("data", (value: Buffer) => {
      stderr += value.toString();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
    });
    assert.ok(Number(pidText) > 0);
    assert.throws(
      () => process.kill(Number(pidText), 0),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH",
    );
    const gate = new SharedArrayBuffer(4);
    const signal = new Int32Array(gate);
    const workers: Worker[] = [];
    t.after(async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
    });
    const contenders = [1, 2].map(() => {
      const worker = new Worker(
        `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { SqliteStore } = await import(workerData.moduleUrl);
        const store = new SqliteStore(workerData.path);
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        try { store.acquireOwner(); parentPort.postMessage('acquired'); }
        catch (error) { parentPort.postMessage(error.code); }
        // Keep the winning PID alive until both decisions have been observed.
        parentPort.once('message', () => { store.close(); });
      })().catch(error => { throw error; });
    `,
        { eval: true, workerData: { moduleUrl, path, gate } },
      );
      workers.push(worker);
      const ready = Promise.withResolvers<void>();
      const result = Promise.withResolvers<unknown>();
      worker.on("message", (value: unknown) => {
        if (value === "ready") ready.resolve();
        else result.resolve(value);
      });
      worker.on("error", (error) => {
        ready.reject(error);
        result.reject(error);
      });
      return { ready: ready.promise, result: result.promise };
    });
    await Promise.all(contenders.map((contender) => contender.ready));
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    const results = await Promise.all(
      contenders.map((contender) => contender.result),
    );
    assert.deepEqual(
      results.sort(),
      ["RUNTIME_ALREADY_RUNNING", "acquired"].sort(),
    );
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once("exit", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`Worker exited ${code}`)),
            );
            worker.postMessage("close");
          }),
      ),
    );
    open().acquireOwner();
  },
);
