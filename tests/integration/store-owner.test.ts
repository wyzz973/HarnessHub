import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { HubError } from "../../src/domain/errors.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

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

void test("owner close only deletes its token even when operational metadata was replaced", (t) => {
  const { open, path } = fixture(t);
  const first = open();
  first.acquireOwner();
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE runtime_metadata SET value = ? WHERE key = 'owner'").run(
      JSON.stringify({
        pid: process.pid,
        token: "replacement-owner",
        startedAt: Date.now(),
      }),
    );
    first.close();
    assert.throws(() => open().acquireOwner(), /Another live Gateway/);
    assert.equal(
      db
        .prepare(
          "SELECT json_extract(value, '$.token') AS token FROM runtime_metadata WHERE key = 'owner'",
        )
        .get()?.token,
      "replacement-owner",
    );
  } finally {
    db.close();
  }
});

void test(
  "dead owner recovery serializes competing startups in the same SQLite transaction",
  { timeout: 10_000 },
  async (t) => {
    const { open, path } = fixture(t);
    open();
    const moduleUrl = new URL(
      "../../src/storage/sqlite-store.js",
      import.meta.url,
    ).href;
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
