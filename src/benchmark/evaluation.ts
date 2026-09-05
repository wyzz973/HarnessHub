import { isDeepStrictEqual } from "node:util";
import {
  benchmarkHash,
  type BenchmarkAttempt,
  type BenchmarkEvaluation,
} from "../domain/benchmark.js";

/** Grades committed captured bytes; malformed task output is a failed answer, corrupted evidence is a grading error. */
export function gradeEvidence(
  attempt: BenchmarkAttempt,
): Pick<BenchmarkEvaluation, "status" | "score" | "reason" | "evidenceSha256"> {
  const evidence = attempt.evidence;
  if (!evidence)
    return { status: "failed", score: 0, reason: "required_output_missing" };
  const evaluator = attempt.task.evaluator;
  const isBinary = evaluator.id === "file-sha256";
  const bytes =
    isBinary && evidence.bytesBase64 !== undefined
      ? Buffer.from(evidence.bytesBase64, "base64")
      : !isBinary && evidence.text !== undefined
        ? Buffer.from(evidence.text)
        : undefined;
  if (
    !bytes ||
    evidence.attemptId !== attempt.id ||
    evidence.runId !== attempt.runId ||
    benchmarkHash(bytes) !== evidence.sha256 ||
    (evidence.size !== undefined && evidence.size !== bytes.length) ||
    evidence.source !==
      (evaluator.artifactName === undefined ? "output" : "artifact") ||
    (evidence.source === "artifact" && evidence.artifactId === undefined) ||
    (isBinary && bytes.toString("base64") !== evidence.bytesBase64)
  )
    return {
      status: "evaluator_error",
      score: null,
      reason: "BENCHMARK_EVIDENCE_INTEGRITY",
    };
  if (
    (attempt.task.input.outputs ?? []).some(
      (output) =>
        evidence.requiredArtifacts?.filter(
          (artifact) => artifact.name === output.name,
        ).length !== 1,
    )
  )
    return { status: "failed", score: 0, reason: "required_output_missing" };
  let passed: boolean;
  let reason: string;
  switch (evaluator.id) {
    case "text-exact":
      passed = evidence.text === evaluator.expected;
      reason = passed ? "exact_match" : "text_mismatch";
      break;
    case "json-equal": {
      let actual: unknown;
      try {
        actual = JSON.parse(evidence.text!);
      } catch {
        return {
          status: "failed",
          score: 0,
          reason: "invalid_json",
          evidenceSha256: evidence.sha256,
        };
      }
      passed = isDeepStrictEqual(actual, evaluator.expected);
      reason = passed ? "json_match" : "json_mismatch";
      break;
    }
    case "file-sha256":
      passed = evidence.sha256 === evaluator.expected;
      reason = passed ? "file_hash_match" : "file_hash_mismatch";
      break;
  }
  return {
    status: passed ? "passed" : "failed",
    score: passed ? 1 : 0,
    reason,
    evidenceSha256: evidence.sha256,
  };
}
