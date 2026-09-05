import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildBenchmarkReport } from "../../src/benchmark/report.js";
import {
  benchmarkHash,
  type AttemptId,
  type BenchmarkAttempt,
  type BenchmarkEvaluation,
  type EvaluationId,
} from "../../src/domain/benchmark.js";
import type { RunId, SessionId } from "../../src/domain/types.js";
import { startHub } from "../../src/main.js";
import { SqliteBenchmarkStore } from "../../src/storage/benchmark-store.js";

function attempt(
  id: string,
  taskId: string,
  engineId: string,
  changes: Partial<BenchmarkAttempt> = {},
): BenchmarkAttempt {
  return {
    id: id as AttemptId,
    batchId: "batch-a",
    dataset: {
      id: "dataset",
      version: "1",
      sha256: benchmarkHash("dataset-v1"),
    },
    task: {
      id: taskId,
      version: "1",
      input: { text: "input", timeoutMs: 1000 },
      evaluator: { id: "text-exact", version: "1", expected: "expected" },
    },
    engineId,
    repetition: 1,
    workspace: { id: `${id}-workspace`, path: "/tmp/unused-report-unit" },
    environment: {
      node: "v24.20.0",
      platform: "darwin",
      arch: "arm64",
      hubVersion: "0.1.0",
    },
    createdAt: 1,
    finishedAt: 2,
    status: "finished",
    runStatus: "completed",
    runId: `${id}-run` as RunId,
    sessionId: `${id}-session` as SessionId,
    profileRevision: "profile-v1",
    ...changes,
  };
}
function evaluation(
  id: string,
  owner: BenchmarkAttempt,
  status: BenchmarkEvaluation["status"],
  createdAt = 2,
): BenchmarkEvaluation {
  return {
    id: id as EvaluationId,
    attemptId: owner.id,
    ...(owner.runId ? { runId: owner.runId } : {}),
    evaluator: owner.task.evaluator,
    status,
    score: status === "passed" ? 1 : status === "failed" ? 0 : null,
    reason: status === "passed" ? "exact_match" : "recorded_failure",
    createdAt,
  };
}

void test("report groups exact dataset/batch identity, counts latest grades once and leaves model/usage unknown", () => {
  const a = attempt("a", "task-one", "engine-a", {
    configSnapshot: { model: "configured-a" },
  });
  const b = attempt("b", "task-one", "engine-b");
  const c = attempt("c", "task-two", "engine-a", { runStatus: "interrupted" });
  const d = attempt("d", "task-one", "engine-b", { repetition: 2 });
  const pending = attempt("pending", "task-not-submitted", "engine-c");
  delete pending.runId;
  delete pending.sessionId;
  delete pending.runStatus;
  delete pending.finishedAt;
  pending.status = "prepared";
  const otherBatch = attempt("other-batch", "task-one", "engine-a", {
    batchId: "batch-b",
  });
  const otherHash = attempt("other-hash", "task-one", "engine-a", {
    dataset: { ...a.dataset, sha256: benchmarkHash("changed-dataset") },
  });
  const otherVersion = attempt("other-version", "task-one", "engine-a", {
    dataset: { ...a.dataset, version: "2" },
  });
  const attempts = [a, b, c, d, pending, otherBatch, otherHash, otherVersion];
  const grades = new Map<AttemptId, BenchmarkEvaluation[]>([
    [
      a.id,
      [
        evaluation("a-first", a, "passed", 100),
        evaluation("a-regrade", a, "failed", 10),
      ],
    ],
    [b.id, [evaluation("b-pass", b, "passed")]],
    [c.id, [evaluation("c-interrupted", c, "interrupted")]],
    [d.id, [evaluation("d-pass", d, "passed")]],
  ]);
  const source = {
    list: () => attempts,
    evaluations: (id: AttemptId) => grades.get(id) ?? [],
  };
  const report = buildBenchmarkReport(source);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.groups.length, 4);
  const first = report.groups[0]!;
  assert.equal(first.matrix.length, 5);
  assert.equal(first.matrix[0]?.configuredModel, "configured-a");
  assert.equal(first.matrix[0]?.observedModel, null);
  assert.equal(
    first.matrix[0]?.latestEvaluationId,
    "a-regrade",
    "latest committed wins even if wall clock moved backwards",
  );
  assert.equal(first.matrix[0]?.regradeCount, 1);
  assert.equal(first.matrix[0]?.evaluationStatus, "failed");
  assert.equal(first.matrix[1]?.configuredModel, null);
  assert.equal(first.matrix[4]?.executionStatus, null);
  assert.equal(first.matrix[4]?.evaluationStatus, null);
  assert.equal(first.matrix[4]?.score, null);
  assert.equal(first.matrix[4]?.failureReason, null);
  assert.equal(
    first.engines.find((engine) => engine.engineId === "engine-a")
      ?.passedAttempts,
    0,
  );
  assert.equal(
    first.engines.find((engine) => engine.engineId === "engine-b")
      ?.passedAttempts,
    2,
  );
  assert.equal(
    first.engines.find((engine) => engine.engineId === "engine-c")
      ?.submittedAttempts,
    0,
  );
  assert.equal(
    first.engines.find((engine) => engine.engineId === "engine-c")?.ungraded,
    1,
  );
  assert.deepEqual(first.offlineCoverage, {
    interpretation: "post_hoc_best_of_engines",
    denominator: "distinct_submitted_tasks_in_this_group",
    submittedTasks: 2,
    passedTasks: 1,
    fraction: 0.5,
    completeDatasetCoverage: null,
  });
  assert.equal(first.usage, null);
  assert.equal(first.cost, null);
  assert.ok(
    first.matrix.every((row) => row.usage === null && row.cost === null),
  );
  assert.equal(buildBenchmarkReport(source, "batch-b").groups.length, 1);
  assert.equal(buildBenchmarkReport(source, "not-present").groups.length, 0);
  assert.throws(() => buildBenchmarkReport(source, " "), /non-empty/);
  assert.throws(
    () =>
      buildBenchmarkReport({
        list: () => [b],
        evaluations: () => [evaluation("foreign", a, "passed")],
      }),
    /does not belong/,
  );
});

void test(
  "compiled --report reads a saved unsubmitted attempt without grading or launching a Worker",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-report-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    const databasePath = path.join(directory, "harnesshub.sqlite");
    const store = new SqliteBenchmarkStore(databasePath);
    const pending = attempt("pending", "not-run", "fake");
    delete pending.runId;
    delete pending.sessionId;
    delete pending.runStatus;
    delete pending.finishedAt;
    pending.status = "prepared";
    try {
      store.create(pending);
    } finally {
      store.close();
      await hub.server.close();
    }
    const child = spawn(
      process.execPath,
      [
        "dist/src/benchmark-main.js",
        "--report",
        "--demo",
        "--batch",
        "batch-a",
        "--data-dir",
        directory,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, stderr);
    const output: unknown = JSON.parse(stdout);
    assert.deepEqual(
      output,
      buildBenchmarkReport(
        { list: () => [pending], evaluations: () => [] },
        "batch-a",
      ),
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n,
        0,
      );
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM evaluations").get()?.n,
        0,
      );
      assert.equal(
        database
          .prepare(
            "SELECT json_extract(record, '$.status') AS status FROM benchmark_attempts WHERE id = 'pending'",
          )
          .get()?.status,
        "prepared",
      );
    } finally {
      database.close();
    }
  },
);

void test("report presents event-backed model, usage scope, cost and once-permission evidence without manufacturing totals", () => {
  const observed = attempt("observed", "task", "engine", {
    configSnapshot: { model: "configured" },
    permissionPolicy: "allow-once",
    observations: {
      model: "actual-model",
      usage: {
        cumulative: { inputTokens: 12, outputTokens: 5 },
        cost: { amount: 0.05, currency: "USD" },
      },
      usageScope: "acp-session-checkpoint",
      installation: null,
      permissions: [
        {
          id: "permission-1",
          decision: "backend-actual-option",
          status: "applied",
        },
      ],
      sourceEventSeqs: [3, 8],
    },
  });
  const group = buildBenchmarkReport({
    list: () => [observed],
    evaluations: () => [],
  }).groups[0]!;
  const row = group.matrix[0]!;
  assert.equal(row.configuredModel, "configured");
  assert.equal(row.observedModel, "actual-model");
  assert.deepEqual(row.usage, observed.observations!.usage);
  assert.equal(row.usageScope, "acp-session-checkpoint");
  assert.deepEqual(row.cost, { amount: 0.05, currency: "USD" });
  assert.deepEqual(row.observationEventSeqs, [3, 8]);
  assert.equal(row.permissions?.[0]?.decision, "backend-actual-option");
  assert.equal(row.installation, null);
  assert.equal(group.usage, null);
  assert.equal(group.cost, null);
});
