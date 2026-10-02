import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import type {
  Brand,
  JsonObject,
  JsonValue,
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
export interface JsonEvaluator {
  id: "json-equal";
  version: "1";
  expected: JsonValue;
  artifactName?: string;
}
export interface FileHashEvaluator {
  id: "file-sha256";
  version: "1";
  expected: string;
  artifactName: string;
}
export type BenchmarkEvaluator =
  TextEvaluator | JsonEvaluator | FileHashEvaluator;
/** UTF-8 fixture contents are versioned in the dataset, never copied from arbitrary host paths. */
export interface BenchmarkFixtureFile {
  path: string;
  text: string;
}
export interface BenchmarkTask {
  id: string;
  version: string;
  input: RunInput;
  evaluator: BenchmarkEvaluator;
  fixtureFiles?: BenchmarkFixtureFile[];
}
export type BenchmarkPermissionPolicy = "deny" | "allow-once";
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
  initialFiles?: { path: string; size: number; sha256: string }[];
  permissionPolicy?: BenchmarkPermissionPolicy;
  observations?: {
    model: string | null;
    usage: JsonObject | null;
    usageScope?: string | null;
    installation?: JsonObject | null;
    permissions?: { id: string; decision: string | null; status: string }[];
    sourceEventSeqs: number[];
  };
}
/** A bounded copy of selected output, bound to both attempt and Run for offline regrading. */
export interface BenchmarkEvidence {
  attemptId: AttemptId;
  runId: RunId;
  source: "output" | "artifact";
  artifactId?: string;
  text?: string;
  /** Only binary evaluator evidence uses base64; its raw byte hash is verified on every regrade. */
  bytesBase64?: string;
  /** Optional for historical v1 text records; new captures always include raw byte size. */
  size?: number;
  requiredArtifacts?: {
    id: string;
    name: string;
    size: number;
    sha256: string;
  }[];
  sha256: string;
}
export interface BenchmarkEvaluation {
  id: EvaluationId;
  attemptId: AttemptId;
  runId?: RunId;
  evaluator: BenchmarkEvaluator;
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
const evaluator = {
  oneOf: [
    object(
      {
        id: { const: "text-exact" },
        version: { const: "1" },
        expected: { type: "string", maxLength: 1_048_576 },
        artifactName: string,
      },
      ["id", "version", "expected"],
    ),
    object(
      {
        id: { const: "json-equal" },
        version: { const: "1" },
        expected: { $ref: "benchmark-json-value" },
        artifactName: string,
      },
      ["id", "version", "expected"],
    ),
    object({
      id: { const: "file-sha256" },
      version: { const: "1" },
      expected: hash,
      artifactName: string,
    }),
  ],
};
const task = object(
  {
    id: string,
    version: string,
    input: { ...runInputSchema, required: ["text", "timeoutMs"] },
    evaluator,
    fixtureFiles: {
      type: "array",
      maxItems: 32,
      items: object({
        path: { type: "string", minLength: 1, maxLength: 500 },
        text: { type: "string", maxLength: 1_048_576 },
      }),
    },
  },
  ["id", "version", "input", "evaluator"],
);
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema({
  $id: "benchmark-json-value",
  anyOf: [
    { type: "null" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array", items: { $ref: "benchmark-json-value" } },
    { type: "object", additionalProperties: { $ref: "benchmark-json-value" } },
  ],
});
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
      initialFiles: {
        type: "array",
        maxItems: 32,
        items: object({ path: string, size: timestamp, sha256: hash }),
      },
      permissionPolicy: { enum: ["deny", "allow-once"] },
      observations: object(
        {
          model: { anyOf: [string, { type: "null" }] },
          usage: { anyOf: [{ type: "object" }, { type: "null" }] },
          usageScope: { anyOf: [string, { type: "null" }] },
          installation: { anyOf: [{ type: "object" }, { type: "null" }] },
          permissions: {
            type: "array",
            items: object({
              id: string,
              decision: { anyOf: [string, { type: "null" }] },
              status: string,
            }),
          },
          sourceEventSeqs: {
            type: "array",
            items: { type: "integer", minimum: 1 },
          },
        },
        ["model", "usage", "sourceEventSeqs"],
      ),
      evidence: object(
        {
          attemptId: string,
          runId: string,
          source: { enum: ["output", "artifact"] },
          artifactId: string,
          text: { type: "string", maxLength: 8_388_608 },
          bytesBase64: {
            type: "string",
            maxLength: 11_184_812,
            pattern:
              "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          },
          size: { type: "integer", minimum: 0, maximum: 8_388_608 },
          requiredArtifacts: {
            type: "array",
            maxItems: 32,
            items: object({
              id: string,
              name: string,
              size: timestamp,
              sha256: hash,
            }),
          },
          sha256: hash,
        },
        ["attemptId", "runId", "source", "sha256"],
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
export function benchmarkHash(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
