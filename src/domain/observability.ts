import type {
  CleanupStatus,
  JsonObject,
  RunId,
  RunStatus,
  SessionId,
} from "./types.js";

/** Prompt input includes cache read/write; reasoning is a subset of output, never added twice. */
export interface ObservedTokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
}
/** Reported means the backend reported an amount, not a reconciled provider invoice. */
export interface ObservedCost {
  amount: number | null;
  currency: string | null;
  kind: "reported" | "estimated" | "unknown";
  source: string | null;
  missingReason: string | null;
}
/** Versioned, run-correlated Driver evidence. Null values mean unknown, including cost. */
export interface UsageObservation {
  schemaVersion: 1;
  scope: "run" | "session";
  source: string;
  backendSessionId: string;
  requestId: string;
  tokens: ObservedTokens;
  cost: ObservedCost;
  model: string | null;
  missingReason: string | null;
}
export interface RunObservations {
  schemaVersion: 1;
  runId: RunId;
  sessionId: SessionId;
  engineId: string;
  status: RunStatus;
  cleanupStatus: CleanupStatus;
  prompt: string;
  model: {
    configured: string | null;
    actual: string | null;
    source: string | null;
    missingReason: string | null;
  };
  timings: {
    acceptedAt: number;
    startedAt: number | null;
    firstOutputAt: number | null;
    finishedAt: number | null;
    queueMs: number | null;
    startupMs: number | null;
    timeToFirstOutputMs: number | null;
    durationMs: number | null;
    executionMs: number | null;
    cleanupMs: number | null;
  };
  tokens: ObservedTokens;
  cost: ObservedCost;
  usage: {
    scope: "run" | "session" | "unknown";
    source: string | null;
    missingReason: string | null;
  };
  sessionUsage: UsageObservation | null;
  counts: {
    outputCharacters: number;
    reasoningCharacters: number;
    toolCalls: number;
    permissions: number;
    artifacts: number;
    artifactBytes: number;
  };
  versions: {
    driver: string | null;
    profileRevision: string;
    installation: JsonObject | null;
  };
  coverage: {
    eventsComplete: boolean;
    usage: boolean;
    model: boolean;
    installation: boolean;
    missingReasons: string[];
  };
}
export interface ObservabilityOverview {
  schemaVersion: 1;
  generatedAt: number;
  scope: { limit: number; totalRuns: number; sampledRuns: number };
  summary: {
    totalRuns: number;
    activeRuns: number;
    completedRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    timedOutRuns: number;
    interruptedRuns: number;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
    knownInputTokens: number | null;
    knownOutputTokens: number | null;
    knownTotalTokens: number | null;
    usageObservedRuns: number;
    usageCoverage: number | null;
  };
  engines: {
    id: string;
    enabled: boolean;
    maxConcurrency: number;
    activeRuns: number;
    queuedRuns: number;
    completedRuns: number;
    failedRuns: number;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
  }[];
  recentRuns: RunObservations[];
}
export function unknownTokens(): ObservedTokens {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    total: null,
  };
}
export function unknownCost(
  reason = "backend-cost-not-reported",
): ObservedCost {
  return {
    amount: null,
    currency: null,
    kind: "unknown",
    source: null,
    missingReason: reason,
  };
}
