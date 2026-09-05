import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import type {
  Brand,
  JsonObject,
  RunId,
  RunInput,
  SessionId,
  TerminalStatus,
} from "./types.js";
import { runInputSchema } from "./schemas.js";

export type AttemptId = Brand<string, "AttemptId">;
export type EvaluationId = Brand<string, "EvaluationId">;
/** Versioned deterministic text grading; artifact names refer only to the attempt's Run. */
export interface TextEvaluator {
  id: "text-exact";
  version: "1";
  expected: string;
  artifactName?: string;
}
export interface BenchmarkTask {
  id: string;
  version: string;
  input: RunInput;
  evaluator: TextEvaluator;
}
export interface BenchmarkDataset {
  schemaVersion: 1;
  id: string;
  version: string;
  tasks: BenchmarkTask[];
}
/** Durable attempt identity is allocated before execution and never reused. */
export interface BenchmarkAttempt {
  id: AttemptId;
  batchId: string;
  dataset: { id: string; version: string; sha256: string };
  task: BenchmarkTask;
  engineId: string;
  repetition: number;
  workspace: { id: string; path: string };
  environment: {
    node: string;
    platform: string;
    arch: string;
    hubVersion: string;
  };
  createdAt: number;
  status: "prepared" | "running" | "finished" | "setup_failed";
  sessionId?: SessionId;
  runId?: RunId;
  profileRevision?: string;
  configSnapshot?: JsonObject;
  runStatus?: TerminalStatus;
  finishedAt?: number;
  errorCode?: string;
  evidence?: BenchmarkEvidence;
}
/** A bounded copy of selected output, bound to both attempt and Run for offline regrading. */
export interface BenchmarkEvidence {
  attemptId: AttemptId;
  runId: RunId;
  source: "output" | "artifact";
  artifactId?: string;
  text: string;
  sha256: string;
}
export interface BenchmarkEvaluation {
  id: EvaluationId;
  attemptId: AttemptId;
  runId?: RunId;
  evaluator: TextEvaluator;
  status:
    | "passed"
    | "failed"
    | "execution_failed"
    | "interrupted"
    | "evaluator_error";
  score: 0 | 1 | null;
  reason: string;
  evidenceSha256?: string;
  createdAt: number;
}
/** Owned by the Gateway composition; writes are synchronous and persist before returning. */
export interface BenchmarkStore {
  create(attempt: BenchmarkAttempt): void;
  update(attempt: BenchmarkAttempt): void;
  get(id: AttemptId): BenchmarkAttempt;
  submittedRun(id: AttemptId): RunId | undefined;
  list(): BenchmarkAttempt[];
  saveEvaluation(evaluation: BenchmarkEvaluation): void;
  evaluations(id: AttemptId): BenchmarkEvaluation[];
  close(): void;
}

const string = { type: "string", minLength: 1 };
const timestamp = { type: "integer", minimum: 0 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const evaluator = object(
  {
    id: { const: "text-exact" },
    version: { const: "1" },
    expected: { type: "string", maxLength: 1_048_576 },
    artifactName: string,
  },
  ["id", "version", "expected"],
);
const task = object({
  id: string,
  version: string,
  input: { ...runInputSchema, required: ["text", "timeoutMs"] },
  evaluator,
});
const ajv = new Ajv({ allErrors: true, strict: true });
/** Validate untrusted datasets before creating directories or submitting Runs. */
export const isBenchmarkDataset = ajv.compile<BenchmarkDataset>(
  object({
    schemaVersion: { const: 1 },
    id: string,
    version: string,
    tasks: { type: "array", items: task, minItems: 1, maxItems: 1000 },
  }),
);
export const isBenchmarkAttempt = ajv.compile<BenchmarkAttempt>(
  object(
    {
      id: string,
      batchId: string,
      dataset: object({ id: string, version: string, sha256: hash }),
      task,
      engineId: string,
      repetition: { type: "integer", minimum: 1 },
      workspace: object({ id: string, path: string }),
      environment: object({
        node: string,
        platform: string,
        arch: string,
        hubVersion: string,
      }),
      createdAt: timestamp,
      status: { enum: ["prepared", "running", "finished", "setup_failed"] },
      sessionId: string,
      runId: string,
      profileRevision: string,
      configSnapshot: { type: "object" },
      runStatus: {
        enum: ["completed", "failed", "cancelled", "timed_out", "interrupted"],
      },
      finishedAt: timestamp,
      errorCode: string,
      evidence: object(
        {
          attemptId: string,
          runId: string,
          source: { enum: ["output", "artifact"] },
          artifactId: string,
          text: { type: "string", maxLength: 8_388_608 },
          sha256: hash,
        },
        ["attemptId", "runId", "source", "text", "sha256"],
      ),
    },
    [
      "id",
      "batchId",
      "dataset",
      "task",
      "engineId",
      "repetition",
      "workspace",
      "environment",
      "createdAt",
      "status",
    ],
  ),
);
export const isBenchmarkEvaluation = ajv.compile<BenchmarkEvaluation>(
  object(
    {
      id: string,
      attemptId: string,
      runId: string,
      evaluator,
      status: {
        enum: [
          "passed",
          "failed",
          "execution_failed",
          "interrupted",
          "evaluator_error",
        ],
      },
      score: { enum: [0, 1, null] },
      reason: string,
      evidenceSha256: hash,
      createdAt: timestamp,
    },
    ["id", "attemptId", "evaluator", "status", "score", "reason", "createdAt"],
  ),
);

/** Hashes UTF-8 bytes without whitespace normalization. */
export function benchmarkHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
