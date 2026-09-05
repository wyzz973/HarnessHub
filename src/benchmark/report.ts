import type {
  BenchmarkAttempt,
  BenchmarkEvaluation,
  BenchmarkStore,
} from "../domain/benchmark.js";
import { HubError } from "../domain/errors.js";

/** One persisted attempt and its latest committed Evaluation; missing observations remain null. */
export interface BenchmarkReportRow {
  taskId: string;
  taskVersion: string;
  engineId: string;
  configuredModel: string | null;
  observedModel: null;
  profileRevision: string | null;
  attemptId: string;
  repetition: number;
  runId: string | null;
  attemptStatus: BenchmarkAttempt["status"];
  executionStatus: NonNullable<BenchmarkAttempt["runStatus"]> | null;
  evaluationStatus: BenchmarkEvaluation["status"] | null;
  score: 0 | 1 | null;
  failureReason: string | null;
  latestEvaluationId: string | null;
  evaluationCount: number;
  regradeCount: number;
  evidenceSha256: string | null;
  timeoutMs: number;
  usage: null;
  cost: null;
}
interface EngineSummary {
  engineId: string;
  recordedAttempts: number;
  submittedAttempts: number;
  passedAttempts: number;
  answerFailures: number;
  executionFailures: number;
  interruptions: number;
  evaluatorErrors: number;
  notSubmitted: number;
  ungraded: number;
  usage: null;
  cost: null;
}
export interface BenchmarkReportGroup {
  batchId: string;
  dataset: BenchmarkAttempt["dataset"];
  matrix: BenchmarkReportRow[];
  engines: EngineSummary[];
  offlineCoverage: {
    interpretation: "post_hoc_best_of_engines";
    denominator: "distinct_submitted_tasks_in_this_group";
    submittedTasks: number;
    passedTasks: number;
    fraction: number | null;
    completeDatasetCoverage: null;
  };
  usage: null;
  cost: null;
}
/** Rebuildable JSON report, separated by batch and exact dataset identity without a new score table. */
export interface BenchmarkReport {
  schemaVersion: 1;
  selection: { batchId: string | null };
  groups: BenchmarkReportGroup[];
}

/** Reads committed records only. Store evaluation order defines the latest grade; no execution, reconciliation or writes occur. */
export function buildBenchmarkReport(
  source: Pick<BenchmarkStore, "list" | "evaluations">,
  batchId?: string,
): BenchmarkReport {
  if (batchId !== undefined && !batchId.trim())
    throw new HubError(
      "INVALID_BENCHMARK_BATCH",
      "Batch filter must be non-empty",
    );
  const groups = new Map<string, BenchmarkReportGroup>();
  for (const attempt of source.list()) {
    if (batchId !== undefined && attempt.batchId !== batchId) continue;
    const key = JSON.stringify([
      attempt.batchId,
      attempt.dataset.id,
      attempt.dataset.version,
      attempt.dataset.sha256,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        batchId: attempt.batchId,
        dataset: { ...attempt.dataset },
        matrix: [],
        engines: [],
        offlineCoverage: {
          interpretation: "post_hoc_best_of_engines",
          denominator: "distinct_submitted_tasks_in_this_group",
          submittedTasks: 0,
          passedTasks: 0,
          fraction: null,
          completeDatasetCoverage: null,
        },
        usage: null,
        cost: null,
      };
      groups.set(key, group);
    }
    const evaluations = source.evaluations(attempt.id);
    if (
      evaluations.some(
        (evaluation) =>
          evaluation.attemptId !== attempt.id ||
          evaluation.runId !== attempt.runId,
      )
    )
      throw new HubError(
        "BENCHMARK_REPORT_OWNERSHIP_CONFLICT",
        "Stored Evaluation does not belong to its attempt Run",
        409,
      );
    const latest = evaluations.at(-1);
    group.matrix.push({
      taskId: attempt.task.id,
      taskVersion: attempt.task.version,
      engineId: attempt.engineId,
      configuredModel:
        typeof attempt.configSnapshot?.model === "string"
          ? attempt.configSnapshot.model
          : null,
      observedModel: null,
      profileRevision: attempt.profileRevision ?? null,
      attemptId: attempt.id,
      repetition: attempt.repetition,
      runId: attempt.runId ?? null,
      attemptStatus: attempt.status,
      executionStatus: attempt.runStatus ?? null,
      evaluationStatus: latest?.status ?? null,
      score: latest?.score ?? null,
      failureReason:
        latest?.status === "passed"
          ? null
          : (latest?.reason ??
            attempt.errorCode ??
            (attempt.runStatus !== undefined &&
            attempt.runStatus !== "completed"
              ? attempt.runStatus
              : null)),
      latestEvaluationId: latest?.id ?? null,
      evaluationCount: evaluations.length,
      regradeCount: Math.max(0, evaluations.length - 1),
      evidenceSha256: latest?.evidenceSha256 ?? null,
      timeoutMs: attempt.task.input.timeoutMs,
      usage: null,
      cost: null,
    });
  }
  for (const group of groups.values()) {
    const engines = new Map<string, EngineSummary>();
    const submittedTasks = new Set<string>();
    const passedTasks = new Set<string>();
    for (const row of group.matrix) {
      let summary = engines.get(row.engineId);
      if (!summary) {
        summary = {
          engineId: row.engineId,
          recordedAttempts: 0,
          submittedAttempts: 0,
          passedAttempts: 0,
          answerFailures: 0,
          executionFailures: 0,
          interruptions: 0,
          evaluatorErrors: 0,
          notSubmitted: 0,
          ungraded: 0,
          usage: null,
          cost: null,
        };
        engines.set(row.engineId, summary);
      }
      summary.recordedAttempts++;
      if (row.runId === null) summary.notSubmitted++;
      else {
        summary.submittedAttempts++;
        const taskKey = JSON.stringify([row.taskId, row.taskVersion]);
        submittedTasks.add(taskKey);
        if (row.evaluationStatus === "passed") passedTasks.add(taskKey);
      }
      switch (row.evaluationStatus) {
        case "passed":
          summary.passedAttempts++;
          break;
        case "failed":
          summary.answerFailures++;
          break;
        case "execution_failed":
          summary.executionFailures++;
          break;
        case "interrupted":
          summary.interruptions++;
          break;
        case "evaluator_error":
          summary.evaluatorErrors++;
          break;
        case null:
          summary.ungraded++;
          break;
      }
    }
    group.engines = [...engines.values()];
    group.offlineCoverage.submittedTasks = submittedTasks.size;
    group.offlineCoverage.passedTasks = passedTasks.size;
    group.offlineCoverage.fraction = submittedTasks.size
      ? passedTasks.size / submittedTasks.size
      : null;
  }
  return {
    schemaVersion: 1,
    selection: { batchId: batchId ?? null },
    groups: [...groups.values()],
  };
}
