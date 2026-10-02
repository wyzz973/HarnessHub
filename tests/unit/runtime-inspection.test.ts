import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { WorkerHost } from "../../src/domain/ports.js";
import { isTerminal } from "../../src/domain/types.js";
import type {
  EngineProfile,
  JsonObject,
  RunId,
} from "../../src/domain/types.js";
import { Runtime } from "../../src/runtime/runtime.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

async function settled(store: SqliteStore, id: RunId) {
  const until = Date.now() + 1500;
  for (;;) {
    const run = store.getRun(id);
    if (isTerminal(run.status)) return run;
    assert.ok(
      Date.now() < until,
      "installation must not prevent a terminal outcome",
    );
    await delay(1);
  }
}

async function boundedClose(runtime: Runtime) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runtime.close(),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("shutdown waited for a hung installation scan")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const action of ["deadline", "cancel", "close"] as const) {
  void test(
    `a hung installation scan cannot block ${action} or publish after termination`,
    { timeout: 5000 },
    async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "hh-inspection-"));
      const store = new SqliteStore(path.join(directory, "store.sqlite"));
      const entered = Promise.withResolvers<AbortSignal>();
      const inspection = Promise.withResolvers<JsonObject>();
      let launches = 0;
      const host: WorkerHost = {
        async start() {
          launches++;
          throw new Error("a stopped run cannot start its Worker");
        },
        async closeSession() {
          return "confirmed";
        },
        async close() {},
      };
      const engine: EngineProfile = {
        id: "inspection-peer",
        driver: "cli",
        command: ["/unused/engine"],
        revision: "inspection-v1",
        enabled: true,
        maxConcurrency: 1,
        cli: { inputMode: "stdin", maxOutputBytes: 1024 },
        capabilities: { resume: false, images: false, permissions: false },
      };
      const runtime = new Runtime(store, host, {
        engines: [engine],
        workspaces: [{ id: "w", path: directory }],
        defaultEngine: engine.id,
        defaultWorkspace: "w",
        maxConcurrency: 1,
        maxQueuedRuns: 10,
        defaultTimeoutMs: 5000,
        cancelGraceMs: 5,
        stateDir: directory,
        publishArtifact: async () => {
          throw new Error("unused");
        },
        inspectInstallation: (_profile, signal) => {
          entered.resolve(signal);
          // Simulates one filesystem read that does not promptly respond to abort.
          return inspection.promise;
        },
      });
      t.after(async () => {
        inspection.resolve({ source: "teardown" });
        await runtime.close();
        store.close();
        await rm(directory, { recursive: true });
      });
      const session = runtime.createSession({});
      const { run } = runtime.submit(session.id, {
        text: "must not reach an engine",
        timeoutMs: action === "deadline" ? 40 : 5000,
      });
      const signal = await entered.promise;
      assert.equal(signal.aborted, false);
      if (action === "cancel") await runtime.cancel(run.id);
      if (action === "close") await boundedClose(runtime);
      const terminal = await settled(store, run.id);
      assert.equal(
        terminal.status,
        action === "deadline" ? "timed_out" : "cancelled",
      );
      assert.equal(terminal.cleanupStatus, "confirmed");
      assert.equal(signal.aborted, true);
      assert.equal(launches, 0);
      const before = store.events(run.id);
      inspection.resolve({ source: "late-installation" });
      await setImmediate();
      assert.equal(launches, 0);
      assert.deepEqual(store.events(run.id), before);
      assert.equal(
        before.some((event) => event.type === "engine.installation"),
        false,
      );
      assert.equal(
        before.filter((event) =>
          /^RUN_(CANCELLED|TIMED_OUT|FAILED|COMPLETED)$/.test(event.type),
        ).length,
        1,
      );
    },
  );
}
