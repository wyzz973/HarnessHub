import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startHub } from "../../src/main.js";
import {
  BenchmarkRunner,
  parseDataset,
  prepareAttempts,
} from "../../src/benchmark/runner.js";
import { SqliteBenchmarkStore } from "../../src/storage/benchmark-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { BenchmarkTask } from "../../src/domain/benchmark.js";

const task = (
  id: string,
  expected: string,
  extra: Partial<BenchmarkTask["input"]> = {},
): BenchmarkTask => ({
  id,
  version: "1",
  input: { text: "actual 中文 ✓", timeoutMs: 5000, ...extra },
  evaluator: { id: "text-exact", version: "1", expected },
});

void test(
  "Benchmark uses real Gateway/Worker; answers, failure, artifacts, isolation and regrade remain distinct",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-benchmark-"),
    );
    let closeHub: () => Promise<void> = async () => {};
    t.after(async () => {
      await closeHub();
      await rm(directory, { recursive: true, force: true });
    });
    const artifact = task("artifact", "actual 中文 ✓", {
      fixture: { scenario: "artifact" },
    });
    artifact.evaluator.artifactName = "result.txt";
    const dataset = parseDataset({
      schemaVersion: 1,
      id: "test",
      version: "1",
      tasks: [
        task("correct", "actual 中文 ✓"),
        task("wrong", "different"),
        artifact,
        task("failed-engine", "actual 中文 ✓", {
          fixture: { scenario: "fail" },
        }),
        task("timed-out", "actual 中文 ✓", {
          fixture: { scenario: "wait" },
          timeoutMs: 100,
        }),
        task("polluted", "actual 中文 ✓"),
      ],
    });
    const attempts = await prepareAttempts({
      dataDir: directory,
      dataset,
      engines: ["fake"],
      repeat: 1,
      hubVersion: "0.1.0",
    });
    assert.equal(
      new Set(attempts.map((attempt) => attempt.workspace.path)).size,
      6,
    );
    let hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
      workspaces: attempts.map((attempt) => attempt.workspace),
    });
    let store = new SqliteBenchmarkStore(
      path.join(directory, "harnesshub.sqlite"),
    );
    closeHub = async () => {
      store.close();
      await hub.server.close();
    };
    let runner = new BenchmarkRunner(hub.app, store);
    const results = [];
    for (const attempt of attempts) {
      if (attempt.task.id === "polluted")
        await writeFile(
          path.join(attempt.workspace.path, "unexpected.txt"),
          "foreign attempt output",
        );
      results.push(await runner.execute(attempt));
    }
    assert.deepEqual(
      results.map((result) => result.status),
      [
        "passed",
        "failed",
        "passed",
        "execution_failed",
        "execution_failed",
        "execution_failed",
      ],
    );
    assert.equal(results[5]?.reason, "BENCHMARK_WORKSPACE_POLLUTED");
    assert.equal(store.get(attempts[1]!.id).runStatus, "completed");
    assert.equal(store.get(attempts[3]!.id).runStatus, "failed");
    assert.equal(store.get(attempts[4]!.id).runStatus, "timed_out");
    const captured = store.get(attempts[2]!.id);
    assert.equal(captured.evidence?.source, "artifact");
    assert.equal(captured.evidence?.runId, captured.runId);
    assert.ok(captured.profileRevision);
    assert.equal(
      (await fetch(`${hub.url}/v1/runs/${captured.runId}`)).status,
      200,
    );
    const artifactMetadata = hub.app.getRun(captured.runId!).artifacts[0]!;
    const artifactResponse = await hub.app.artifact(artifactMetadata.id);
    await rm(artifactResponse.record.path);
    assert.equal(
      runner.regrade(captured.id).status,
      "passed",
      "regrade must use captured evidence, independent of live artifact file",
    );

    store.close();
    await hub.server.close();
    hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    store = new SqliteBenchmarkStore(path.join(directory, "harnesshub.sqlite"));
    runner = new BenchmarkRunner(hub.app, store);
    assert.equal(runner.regrade(captured.id).status, "passed");
    assert.equal(store.evaluations(captured.id).length, 3);
    const database = new DatabaseSync(
      path.join(directory, "harnesshub.sqlite"),
    );
    try {
      const tampered = store.get(captured.id);
      tampered.evidence = store.get(attempts[0]!.id).evidence!;
      database
        .prepare("UPDATE benchmark_attempts SET record = ? WHERE id = ?")
        .run(JSON.stringify(tampered), tampered.id);
      assert.equal(
        runner.regrade(captured.id).status,
        "evaluator_error",
        "different attempt evidence must never be scored",
      );
      assert.equal(
        store.evaluations(captured.id).at(-1)?.reason,
        "BENCHMARK_EVIDENCE_INTEGRITY",
      );
      // Checkpoint at process loss after evidence commit but before Evaluation insert.
      database
        .prepare("DELETE FROM evaluations WHERE attempt_id = ?")
        .run(attempts[0]!.id);
      await runner.reconcile();
      assert.equal(store.evaluations(attempts[0]!.id).length, 1);
      assert.equal(store.evaluations(attempts[0]!.id)[0]?.status, "passed");
    } finally {
      database.close();
    }
  },
);

void test("Benchmark reconciles the durable submit/bind crash gap after Runtime marks the Run interrupted", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "harnesshub-benchmark-recover-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attempts = await prepareAttempts({
    dataDir: directory,
    dataset: parseDataset({
      schemaVersion: 1,
      id: "recovery",
      version: "1",
      tasks: [task("pending", "actual 中文 ✓")],
    }),
    engines: ["fake"],
    repeat: 1,
    hubVersion: "0.1.0",
  });
  const attempt = attempts[0]!;
  const databasePath = path.join(directory, "harnesshub.sqlite");
  const primary = new SqliteStore(databasePath);
  primary.acquireOwner();
  const benchmark = new SqliteBenchmarkStore(databasePath);
  const session = primary.createSession(
    {
      id: "fake",
      driver: "fake",
      revision: "fake-v1",
      enabled: true,
      maxConcurrency: 1,
      capabilities: { resume: false, permissions: true, images: false },
    },
    attempt.workspace,
  );
  benchmark.create(attempt);
  benchmark.update({
    ...attempt,
    sessionId: session.id,
    profileRevision: session.profileRevision,
  });
  const accepted = primary.acceptRun(
    session.id,
    attempt.task.input,
    attempt.id,
  ).run;
  // Persisted checkpoint at abrupt process loss: submit committed, attempt binding did not.
  benchmark.close();
  primary.close();
  const hub = await startHub({
    dataDir: directory,
    demo: true,
    cwd: directory,
    port: 0,
  });
  const restored = new SqliteBenchmarkStore(databasePath);
  try {
    const runner = new BenchmarkRunner(hub.app, restored);
    await runner.reconcile();
    assert.equal(restored.get(attempt.id).runId, accepted.id);
    assert.equal(restored.get(attempt.id).runStatus, "interrupted");
    assert.equal(restored.evaluations(attempt.id)[0]?.status, "interrupted");
    await runner.reconcile();
    assert.equal(restored.evaluations(attempt.id).length, 1);
    assert.equal(hub.app.getRun(accepted.id).generation, 1);
  } finally {
    restored.close();
    await hub.server.close();
  }
});

void test(
  "Benchmark rejects unknown evaluator/task aliases and runs the compiled CLI example",
  { timeout: 15_000 },
  async (t) => {
    const value = JSON.parse(
      await readFile("examples/benchmark-demo.json", "utf8"),
    ) as unknown;
    const valid = parseDataset(value);
    assert.throws(
      () => parseDataset({ ...valid, tasks: [...valid.tasks, valid.tasks[0]] }),
      /distinct/,
    );
    assert.throws(
      () =>
        parseDataset({
          ...valid,
          tasks: [
            {
              ...valid.tasks[0],
              evaluator: { id: "untrusted-script", version: "1", expected: "" },
            },
          ],
        }),
      /supported evaluators/,
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-benchmark-cli-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [
        "dist/src/benchmark-main.js",
        "--demo",
        "--dataset",
        "examples/benchmark-demo.json",
        "--engines",
        "fake",
        "--data-dir",
        directory,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, stderr);
    const last: unknown = JSON.parse(output.trim().split("\n").at(-1)!);
    assert.deepEqual(last, {
      summary: { planned: 2, executed: 2, passed: 2, interrupted: false },
      dataDir: directory,
    });
  },
);

void test("Benchmark preserves a storage failure instead of disguising a submitted Run as setup failure", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "harnesshub-benchmark-storage-"),
  );
  let cleanup: () => Promise<void> = async () => {};
  t.after(async () => {
    await cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  const attempts = await prepareAttempts({
    dataDir: directory,
    dataset: parseDataset({
      schemaVersion: 1,
      id: "storage-fault",
      version: "1",
      tasks: [task("echo", "actual 中文 ✓")],
    }),
    engines: ["fake"],
    repeat: 1,
    hubVersion: "0.1.0",
  });
  const hub = await startHub({
    dataDir: directory,
    demo: true,
    cwd: directory,
    port: 0,
    workspaces: attempts.map((attempt) => attempt.workspace),
  });
  const databasePath = path.join(directory, "harnesshub.sqlite");
  const store = new SqliteBenchmarkStore(databasePath);
  const database = new DatabaseSync(databasePath);
  cleanup = async () => {
    database.close();
    store.close();
    await hub.server.close();
  };
  database.exec(
    "CREATE TRIGGER reject_benchmark_binding BEFORE UPDATE ON benchmark_attempts WHEN json_extract(NEW.record, '$.status') = 'running' BEGIN SELECT RAISE(ABORT, 'injected benchmark storage failure'); END",
  );
  const runner = new BenchmarkRunner(hub.app, store);
  const attempt = attempts[0]!;
  await assert.rejects(
    runner.execute(attempt),
    /injected benchmark storage failure/,
  );
  assert.equal(store.get(attempt.id).status, "prepared");
  assert.equal(store.evaluations(attempt.id).length, 0);
  const runId = store.submittedRun(attempt.id);
  assert.ok(runId);
  assert.equal(hub.app.getRun(runId).status, "cancelled");
  database.exec("DROP TRIGGER reject_benchmark_binding");
  await runner.reconcile();
  assert.equal(store.get(attempt.id).runId, runId);
  assert.equal(store.evaluations(attempt.id)[0]?.status, "execution_failed");
});
