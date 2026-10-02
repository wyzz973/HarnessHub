// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { acquireInstanceLock } from "../../src/storage/instance-lock.js";
import { temporaryDirectory } from "../support/temporary.js";

const contenderSource = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { acquireInstanceLock } = await import(workerData.moduleUrl);
  parentPort.postMessage("ready");
  Atomics.wait(new Int32Array(workerData.gate), 0, 0);
  let lock;
  try {
    lock = acquireInstanceLock(workerData.file);
    parentPort.postMessage("acquired");
  } catch (error) {
    parentPort.postMessage(error.code ?? String(error));
  }
  // Hold the lock until every contender has reported.
  parentPort.once("message", () => {
    lock?.release();
    parentPort.close();
  });
})();
`;

async function round(file: string, contenders: number): Promise<unknown[]> {
  const moduleUrl = new URL(
    "../../src/storage/instance-lock.js",
    import.meta.url,
  ).href;
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from(
    { length: contenders },
    () =>
      new Worker(contenderSource, {
        eval: true,
        workerData: { moduleUrl, file, gate },
      }),
  );
  try {
    const messages = workers.map((worker) => {
      const ready = Promise.withResolvers<void>();
      const result = Promise.withResolvers<unknown>();
      worker.on("message", (value: unknown) =>
        value === "ready" ? ready.resolve() : result.resolve(value),
      );
      worker.once("error", (error) => {
        ready.reject(error);
        result.reject(error);
      });
      return { ready: ready.promise, result: result.promise };
    });
    await Promise.all(messages.map((message) => message.ready));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    return await Promise.all(messages.map((message) => message.result));
  } finally {
    for (const worker of workers) worker.postMessage("done");
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

void test(
  "exactly one of several simultaneous contenders acquires the lock, every round",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "hh-instance-lock-");
    const file = path.join(directory, "harnesshub.sqlite.lock");
    for (let index = 0; index < 8; index += 1) {
      const results = await round(file, 4);
      assert.equal(
        results.filter((result) => result === "acquired").length,
        1,
        `round ${index}: ${JSON.stringify(results)}`,
      );
      assert.ok(
        results.every(
          (result) =>
            result === "acquired" || result === "RUNTIME_ALREADY_RUNNING",
        ),
        JSON.stringify(results),
      );
    }
    // Released at the end of every round: the lock is free again.
    acquireInstanceLock(file).release();
  },
);
