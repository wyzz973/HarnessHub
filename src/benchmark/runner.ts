import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HubApplication } from "../application/service.js";
import { HubError } from "../domain/errors.js";
import {
  isTerminal,
  type JsonObject,
  type SessionRecord,
  type RunId,
  type PermissionId,
} from "../domain/types.js";
import {
  checkWorkspace,
  initializeFixtures,
  validateFixtures,
} from "./workspace.js";
import { gradeEvidence } from "./evaluation.js";
import {
  benchmarkHash,
  isBenchmarkDataset,
  type AttemptId,
  type BenchmarkAttempt,
  type BenchmarkDataset,
  type BenchmarkEvaluation,
  type BenchmarkEvidence,
  type BenchmarkStore,
  type EvaluationId,
  type BenchmarkPermissionPolicy,
} from "../domain/benchmark.js";

/** Rejects malformed/ambiguous tasks before any model execution. */
export function parseDataset(value: unknown): BenchmarkDataset {
  if (
    !isBenchmarkDataset(value) ||
    new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length
  )
    throw new HubError(
      "INVALID_BENCHMARK_DATASET",
      "Dataset must contain distinct versioned tasks and supported evaluators",
    );
  for (const task of value.tasks) validateFixtures(task);
  return structuredClone(value);
}

/** Prepares exclusive workspaces with versioned fixtures. Caller registers these with startHub before running. */
export async function prepareAttempts(options: {
  dataDir: string;
  dataset: BenchmarkDataset;
  engines: string[];
  repeat: number;
  hubVersion: string;
  permissionPolicy?: BenchmarkPermissionPolicy;
}): Promise<BenchmarkAttempt[]> {
  const dataset = parseDataset(options.dataset);
  if (
    !options.engines.length ||
    new Set(options.engines).size !== options.engines.length ||
    options.engines.some((engine) => !engine.trim()) ||
    !Number.isSafeInteger(options.repeat) ||
    options.repeat < 1 ||
    dataset.tasks.length * options.engines.length * options.repeat > 1000
  )
    throw new HubError(
      "INVALID_BENCHMARK_PLAN",
      "Plan must contain distinct engines and 1 to 1000 total attempts",
    );
  const root = path.resolve(options.dataDir, "benchmark-workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const batchDirectory = await mkdtemp(path.join(root, "batch-"));
  const batchId = path.basename(batchDirectory);
  const attempts: BenchmarkAttempt[] = [];
  for (const task of dataset.tasks)
    for (const engineId of options.engines)
      for (let repetition = 1; repetition <= options.repeat; repetition++) {
        const id = randomUUID() as AttemptId;
        const directory = path.join(batchDirectory, id);
        await mkdir(directory, { mode: 0o700 });
        attempts.push({
          id,
          batchId,
          dataset: {
            id: dataset.id,
            version: dataset.version,
            sha256: benchmarkHash(JSON.stringify(dataset)),
          },
          task,
          engineId,
          repetition,
          workspace: { id: `attempt-${id}`, path: await realpath(directory) },
          environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            hubVersion: options.hubVersion,
          },
          createdAt: Date.now(),
          status: "prepared",
          initialFiles: await initializeFixtures(directory, task),
          permissionPolicy: options.permissionPolicy ?? "deny",
        });
      }
  return attempts;
}

function errorCode(error: unknown): string {
  return error instanceof HubError ? error.code : "BENCHMARK_OPERATION_FAILED";
}

/** Reuses Application Service for all execution and control. Owns no engine process or deadline. */
export class BenchmarkRunner {
  constructor(
    private readonly app: HubApplication,
    private readonly store: BenchmarkStore,
  ) {}

  /** A fresh attempt creates one Session and one Run. Abort requests Runtime cancellation, then awaits its terminal record. */
  async execute(
    prepared: BenchmarkAttempt,
    signal?: AbortSignal,
  ): Promise<BenchmarkEvaluation> {
    let attempt = structuredClone(prepared);
    this.store.create(attempt);
    try {
      signal?.throwIfAborted();
      await checkWorkspace(attempt, true);
    } catch (error) {
      return this.setupFailed(attempt, error);
    }
    let session: SessionRecord;
    try {
      session = this.app.createSession({
        engineId: attempt.engineId,
        workspaceId: attempt.workspace.id,
      });
    } catch (error) {
      if (!(error instanceof HubError) || error.statusCode >= 500) throw error;
      return this.setupFailed(attempt, error);
    }
    try {
      attempt = {
        ...attempt,
        sessionId: session.id,
        profileRevision: session.profileRevision,
        ...(session.configSnapshot
          ? { configSnapshot: session.configSnapshot }
          : {}),
      };
      this.store.update(attempt);
      let submission: ReturnType<HubApplication["submit"]>;
      try {
        submission = this.app.submit(
          session.id,
          attempt.task.input,
          attempt.id,
        );
      } catch (error) {
        if (!(error instanceof HubError) || error.statusCode >= 500)
          throw error;
        return this.setupFailed(attempt, error);
      }
      const { run } = submission;
      attempt = { ...attempt, status: "running", runId: run.id };
      this.store.update(attempt);
      const runId = run.id;
      let cancelRequested = false;
      const decisions = new Set<PermissionId>();
      for (;;) {
        const run = this.app.getRun(runId);
        if (isTerminal(run.status)) {
          attempt = {
            ...attempt,
            status: "finished",
            runStatus: run.status,
            finishedAt: Date.now(),
            observations: this.observe(runId),
            ...(run.configSnapshot
              ? { configSnapshot: run.configSnapshot }
              : {}),
          };
          if (run.status === "completed") {
            try {
              await checkWorkspace(attempt, false);
              const evidence = await this.capture(attempt);
              if (evidence) attempt = { ...attempt, evidence };
            } catch (error) {
              attempt = { ...attempt, errorCode: errorCode(error) };
            }
          }
          this.store.update(attempt);
          return this.regrade(attempt.id);
        }
        if (signal?.aborted && !cancelRequested) {
          cancelRequested = true;
          await this.app.cancel(runId);
        }
        if (!cancelRequested) {
          for (const permission of run.permissions) {
            if (permission.status !== "pending" || decisions.has(permission.id))
              continue;
            const kind =
              attempt.permissionPolicy === "allow-once"
                ? "allow_once"
                : "reject_once";
            const options = permission.options.filter(
              (option) => option.kind === kind,
            );
            decisions.add(permission.id);
            if (options.length !== 1) {
              cancelRequested = true;
              await this.app.cancel(runId);
              break;
            }
            try {
              await this.app.decide(permission.id, options[0]!.id);
            } catch (error) {
              // Deadline/terminal can win while the permission decision awaits its Worker response.
              if (
                !(error instanceof HubError) ||
                error.code !== "PERMISSION_EXPIRED" ||
                !isTerminal(this.app.getRun(runId).status)
              )
                throw error;
            }
          }
        }
        if (!this.app.isReady())
          throw new HubError(
            "BENCHMARK_RUNTIME_UNAVAILABLE",
            "Runtime stopped before a terminal record was available",
            503,
          );
        await delay(20);
      }
    } finally {
      await this.app.closeSession(session.id);
    }
  }

  private setupFailed(
    attempt: BenchmarkAttempt,
    error: unknown,
  ): BenchmarkEvaluation {
    this.store.update({
      ...attempt,
      status: "setup_failed",
      errorCode: errorCode(error),
      finishedAt: Date.now(),
    });
    return this.regrade(attempt.id);
  }

  private async capture(
    attempt: BenchmarkAttempt,
  ): Promise<BenchmarkEvidence | undefined> {
    if (!attempt.runId) throw new Error("Attempt is not bound to a Run");
    const run = this.app.getRun(attempt.runId);
    if (run.sessionId !== attempt.sessionId)
      throw new HubError(
        "BENCHMARK_OWNERSHIP_CONFLICT",
        "Run belongs to another attempt session",
        409,
      );
    const requiredArtifacts: NonNullable<
      BenchmarkEvidence["requiredArtifacts"]
    > = [];
    for (const output of attempt.task.input.outputs ?? []) {
      const matches = run.artifacts.filter(
        (artifact) => artifact.name === output.name,
      );
      if (!matches.length) return undefined;
      if (matches.length !== 1)
        throw new HubError(
          "BENCHMARK_ARTIFACT_AMBIGUOUS",
          "Output name must identify exactly one artifact",
          409,
        );
      const { record, bytes } = await this.app.artifact(matches[0]!.id);
      if (
        record.runId !== attempt.runId ||
        bytes.length !== record.size ||
        benchmarkHash(bytes) !== record.sha256
      )
        throw new HubError(
          "BENCHMARK_EVIDENCE_INTEGRITY",
          "Output bytes must belong to the attempt and match committed metadata",
          409,
        );
      requiredArtifacts.push({
        id: record.id,
        name: record.name,
        size: record.size,
        sha256: record.sha256,
      });
    }
    let text = run.output;
    let content: Buffer | undefined;
    let artifactId: string | undefined;
    const name = attempt.task.evaluator.artifactName;
    if (name !== undefined) {
      const matches = run.artifacts.filter(
        (artifact) => artifact.name === name,
      );
      if (!matches.length) return undefined;
      if (matches.length !== 1)
        throw new HubError(
          "BENCHMARK_ARTIFACT_AMBIGUOUS",
          "Artifact name must identify exactly one artifact",
          409,
        );
      const matched = matches[0]!;
      const { record, bytes } = await this.app.artifact(matched.id);
      if (record.runId !== attempt.runId || record.id !== matched.id)
        throw new HubError(
          "BENCHMARK_OWNERSHIP_CONFLICT",
          "Artifact belongs to another attempt Run",
          409,
        );
      if (
        bytes.length !== record.size ||
        benchmarkHash(bytes) !== record.sha256
      )
        throw new HubError(
          "BENCHMARK_EVIDENCE_INTEGRITY",
          "Artifact bytes do not match committed metadata",
          409,
        );
      content = bytes;
      artifactId = record.id;
    }
    if (content === undefined && text === undefined) return undefined;
    const bytes = content ?? Buffer.from(text!);
    if (bytes.length > 8 * 1024 * 1024)
      throw new HubError(
        "BENCHMARK_EVIDENCE_TOO_LARGE",
        "Selected evidence exceeds 8 MiB",
      );
    const binary = attempt.task.evaluator.id === "file-sha256";
    if (!binary && content !== undefined)
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return {
      attemptId: attempt.id,
      runId: attempt.runId,
      source: name === undefined ? "output" : "artifact",
      ...(artifactId ? { artifactId } : {}),
      ...(binary ? { bytesBase64: bytes.toString("base64") } : { text: text! }),
      size: bytes.length,
      sha256: benchmarkHash(bytes),
      requiredArtifacts,
    };
  }

  /** Regrades only captured evidence; never reruns a model. Every call appends a distinct Evaluation. */
  regrade(id: AttemptId): BenchmarkEvaluation {
    const attempt = this.store.get(id);
    if (attempt.status === "running" || attempt.status === "prepared")
      throw new HubError(
        "BENCHMARK_ATTEMPT_UNFINISHED",
        "Reconcile the unfinished attempt before grading",
        409,
      );
    const base = {
      id: randomUUID() as EvaluationId,
      attemptId: id,
      ...(attempt.runId ? { runId: attempt.runId } : {}),
      evaluator: attempt.task.evaluator,
      createdAt: Date.now(),
    };
    let result: BenchmarkEvaluation;
    if (attempt.runStatus === "interrupted")
      result = {
        ...base,
        status: "interrupted",
        score: null,
        reason: "run_interrupted",
      };
    else if (attempt.runStatus !== "completed")
      result = {
        ...base,
        status: "execution_failed",
        score: null,
        reason: attempt.runStatus ?? attempt.errorCode ?? "setup_failed",
      };
    else if (attempt.errorCode)
      result = {
        ...base,
        status: "evaluator_error",
        score: null,
        reason: attempt.errorCode,
      };
    else result = { ...base, ...gradeEvidence(attempt) };
    this.store.saveEvaluation(result);
    return result;
  }

  /** After Gateway recovery, reconcile persisted Runs without replaying any execution. */
  async reconcile(): Promise<void> {
    for (let attempt of this.store.list()) {
      if (attempt.status !== "prepared" && attempt.status !== "running") {
        if (this.store.evaluations(attempt.id).length === 0)
          this.regrade(attempt.id);
        continue;
      }
      if (!attempt.runId) {
        const submitted = this.store.submittedRun(attempt.id);
        if (submitted)
          attempt = { ...attempt, runId: submitted, status: "running" };
      }
      if (!attempt.runId) {
        attempt = {
          ...attempt,
          status: "setup_failed",
          errorCode: "BENCHMARK_SETUP_INTERRUPTED",
          finishedAt: Date.now(),
        };
      } else {
        const run = this.app.getRun(attempt.runId);
        if (!isTerminal(run.status)) continue;
        attempt = {
          ...attempt,
          status: "finished",
          runStatus: run.status,
          finishedAt: Date.now(),
          observations: this.observe(run.id),
          ...(run.configSnapshot ? { configSnapshot: run.configSnapshot } : {}),
        };
        if (run.status === "completed") {
          try {
            const evidence = await this.capture(attempt);
            if (evidence) attempt = { ...attempt, evidence };
          } catch (error) {
            attempt = { ...attempt, errorCode: errorCode(error) };
          }
        }
      }
      this.store.update(attempt);
      this.regrade(attempt.id);
    }
  }

  private observe(runId: RunId): NonNullable<BenchmarkAttempt["observations"]> {
    let model: string | null = null;
    let usage: JsonObject | null = null;
    let usageScope: string | null = null;
    let installation: JsonObject | null = null;
    const sourceEventSeqs: number[] = [];
    let cursor = 0;
    for (;;) {
      const events = this.app.events(runId, cursor, 100);
      if (!events.length) break;
      for (const event of events) {
        cursor = event.seq;
        const models = event.data.models;
        const installed = event.data.installation;
        if (
          (event.type === "engine.capabilities" ||
            event.type === "engine.installation") &&
          installed &&
          typeof installed === "object" &&
          !Array.isArray(installed)
        ) {
          installation = installed;
          sourceEventSeqs.push(event.seq);
        }
        if (
          (event.type === "engine.capabilities" ||
            event.type === "engine.usage") &&
          models &&
          typeof models === "object" &&
          !Array.isArray(models) &&
          typeof models.currentModelId === "string"
        ) {
          model = models.currentModelId;
          sourceEventSeqs.push(event.seq);
        } else if (
          event.type === "engine.model" &&
          typeof event.data.model === "string"
        ) {
          model = event.data.model;
          sourceEventSeqs.push(event.seq);
        }
        if (
          event.type === "engine.usage" &&
          event.data.usage &&
          typeof event.data.usage === "object" &&
          !Array.isArray(event.data.usage)
        ) {
          usage = event.data.usage;
          usageScope =
            typeof event.data.source === "string"
              ? event.data.source
              : "unspecified";
          sourceEventSeqs.push(event.seq);
        }
      }
    }
    return {
      model,
      usage,
      usageScope,
      installation,
      sourceEventSeqs: [...new Set(sourceEventSeqs)],
      permissions: this.app.getRun(runId).permissions.map((permission) => ({
        id: permission.id,
        decision: permission.decision ?? null,
        status: permission.status,
      })),
    };
  }
}
