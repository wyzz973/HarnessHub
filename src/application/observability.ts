import type { Store } from "../domain/ports.js";
import type {
  AgentEvent,
  EngineProfile,
  JsonObject,
  JsonValue,
  RunId,
  RunRecord,
  SessionRecord,
} from "../domain/types.js";
import { isTerminal } from "../domain/types.js";
import type {
  ObservabilityOverview,
  ObservedCost,
  ObservedTokens,
  RunObservations,
  UsageObservation,
} from "../domain/observability.js";
import { unknownCost, unknownTokens } from "../domain/observability.js";
import { HubError } from "../domain/errors.js";

const MAX_EVENTS = 10_000;
const MAX_RECENT_RUNS = 200;
const fields = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
] as const;
function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function number(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function integer(value: JsonValue | undefined): number | null {
  const n = number(value);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}
function elapsed(end: number | null, start: number | null): number | null {
  return end !== null && start !== null && end >= start ? end - start : null;
}
function cost(value: JsonValue | undefined): ObservedCost {
  const input = object(value),
    amount = number(input?.amount),
    currency = text(input?.currency),
    kind = input?.kind;
  if (
    amount === null ||
    !currency ||
    (kind !== "reported" && kind !== "estimated")
  )
    return unknownCost(text(input?.missingReason) ?? undefined);
  return {
    amount,
    currency,
    kind,
    source: text(input?.source),
    missingReason: null,
  };
}
function observation(
  value: JsonValue | undefined,
  run: RunRecord,
  backend: string | undefined,
): UsageObservation | null {
  const input = object(value),
    source = text(input?.source),
    requestId = text(input?.requestId),
    backendSessionId = text(input?.backendSessionId);
  if (
    input?.schemaVersion !== 1 ||
    (input.scope !== "run" && input.scope !== "session") ||
    !source ||
    !requestId ||
    !backendSessionId ||
    requestId !== `${run.id}:${run.generation}` ||
    (backend && backend !== backendSessionId)
  )
    return null;
  const tokens = unknownTokens(),
    raw = object(input.tokens);
  for (const key of fields) tokens[key] = integer(raw?.[key]);
  return {
    schemaVersion: 1,
    scope: input.scope,
    source,
    requestId,
    backendSessionId,
    tokens,
    cost: cost(input.cost),
    model: text(input.model),
    missingReason: text(input.missingReason),
  };
}
/** Percentiles are nearest-rank values over measured terminal durations; an empty sample stays null. */
export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(quantile * ordered.length) - 1)] ?? null;
}

/** Pure committed-record projection. Historical cumulative usage is shown as a session snapshot, never as run charges. */
export function projectRunObservations(
  run: RunRecord,
  session: SessionRecord,
  events: AgentEvent[],
  counts: { permissions: number; artifacts: number; artifactBytes: number },
): RunObservations {
  const complete =
    events.length === run.lastSeq &&
    events.every((event, index) => event.seq === index + 1);
  let firstOutputAt: number | null = null,
    runningAt: number | null = null,
    cleanupMs: number | null = null;
  let actualModel: string | null = null,
    modelSource: string | null = null,
    installation: JsonObject | null = null;
  let outputCharacters = 0,
    reasoningCharacters = 0;
  let usage: UsageObservation | null = null,
    sessionUsage: UsageObservation | null = null;
  const tools = new Set<string>();
  for (const event of events) {
    if (event.type === "message.delta") {
      const value = typeof event.data.text === "string" ? event.data.text : "";
      if (event.data.stream === "thought")
        reasoningCharacters += [...value].length;
      else {
        outputCharacters += [...value].length;
        if (value && firstOutputAt === null) firstOutputAt = event.observedAt;
      }
    }
    if (event.type === "tool.update") {
      const id = text(event.data.toolCallId);
      if (id) tools.add(id);
    }
    if (
      event.type === "RUN_STATUS" &&
      event.data.status === "running" &&
      runningAt === null
    )
      runningAt = event.observedAt;
    if (event.type === "runtime.cleanup")
      cleanupMs = number(event.data.durationMs);
    if (event.type === "engine.installation")
      installation = object(event.data.installation) ?? null;
    if (event.type === "engine.capabilities" || event.type === "engine.usage") {
      const observedModel = text(object(event.data.models)?.currentModelId);
      if (observedModel) {
        actualModel = observedModel;
        modelSource = "acp-session-model";
      }
    }
    if (event.type !== "engine.usage") continue;
    const current = observation(
      event.data.observation,
      run,
      session.backendSessionId,
    );
    if (current?.scope === "run") usage = current;
    else if (current) sessionUsage = current;
    const cumulative = observation(
      event.data.sessionObservation,
      run,
      session.backendSessionId,
    );
    if (cumulative?.scope === "session") sessionUsage = cumulative;
    if (current?.model) {
      actualModel = current.model;
      modelSource = current.source;
    }
    // Preserve the meaning of old ACP snapshots without attributing cumulative tokens to every Run.
    const old = object(object(event.data.usage)?.cumulative);
    if (!current && old) {
      sessionUsage = {
        schemaVersion: 1,
        scope: "session",
        source: text(event.data.source) ?? "acp-session-checkpoint",
        backendSessionId: session.backendSessionId ?? "unknown",
        requestId: `${run.id}:${run.generation}`,
        tokens: {
          input: integer(old.inputTokens),
          output: integer(old.outputTokens),
          cacheRead: integer(old.cachedReadTokens),
          cacheWrite: integer(old.cachedWriteTokens),
          reasoning: integer(old.thoughtTokens),
          total: integer(old.totalTokens),
        },
        cost: unknownCost("historical-session-cost-not-attributable-to-run"),
        model: actualModel,
        missingReason: "historical-session-usage-not-attributable-to-run",
      };
    }
  }
  const tokens = usage?.tokens ?? unknownTokens();
  const hasUsage = tokens.input !== null && tokens.output !== null;
  const missingReasons: string[] = [];
  if (!complete) missingReasons.push("event-projection-limit-or-sequence-gap");
  if (!hasUsage)
    missingReasons.push(usage?.missingReason ?? "run-token-usage-not-reported");
  if (!actualModel) missingReasons.push("actual-model-not-reported");
  if (!installation) missingReasons.push("installation-snapshot-not-recorded");
  if (cleanupMs === null) missingReasons.push("cleanup-duration-not-recorded");
  if (usage?.cost.amount == null) missingReasons.push("run-cost-not-reported");
  const configured = text(run.configSnapshot?.model);
  return {
    schemaVersion: 1,
    runId: run.id,
    sessionId: session.id,
    engineId: session.engineId,
    status: run.status,
    cleanupStatus: run.cleanupStatus,
    prompt:
      run.input.text.length > 240
        ? `${run.input.text.slice(0, 237)}...`
        : run.input.text,
    model: {
      configured,
      actual: actualModel,
      source: modelSource,
      missingReason: actualModel ? null : "actual-model-not-reported",
    },
    timings: {
      acceptedAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      firstOutputAt,
      finishedAt: run.finishedAt ?? null,
      queueMs: elapsed(run.startedAt ?? null, run.createdAt),
      startupMs: elapsed(runningAt, run.startedAt ?? null),
      timeToFirstOutputMs: elapsed(firstOutputAt, run.createdAt),
      durationMs: elapsed(run.finishedAt ?? null, run.createdAt),
      executionMs: elapsed(run.finishedAt ?? null, runningAt),
      cleanupMs,
    },
    tokens,
    cost: usage?.cost ?? unknownCost(),
    usage: {
      scope: usage ? "run" : sessionUsage ? "session" : "unknown",
      source: usage?.source ?? sessionUsage?.source ?? null,
      missingReason:
        usage?.missingReason ??
        (hasUsage ? null : "run-token-usage-not-reported"),
    },
    sessionUsage,
    counts: {
      outputCharacters,
      reasoningCharacters,
      toolCalls: tools.size,
      ...counts,
    },
    versions: {
      driver: text(run.configSnapshot?.driver),
      profileRevision: session.profileRevision,
      installation,
    },
    coverage: {
      eventsComplete: complete,
      usage: hasUsage,
      model: actualModel !== null,
      installation: installation !== null,
      missingReasons,
    },
  };
}

/** Read-only, restart-stable projection. Expensive event traversal is bounded to recent runs and 10,000 events per run. */
export class ObservationService {
  constructor(
    private readonly options: { store: Store; engines: () => EngineProfile[] },
  ) {}
  run(id: RunId): RunObservations {
    const { store } = this.options,
      run = store.getRun(id),
      events: AgentEvent[] = [];
    let cursor = 0;
    while (events.length < MAX_EVENTS) {
      const batch = store.events(
        id,
        cursor,
        Math.min(1_000, MAX_EVENTS - events.length),
      );
      if (!batch.length) break;
      events.push(...batch);
      cursor = batch.at(-1)!.seq;
    }
    const artifacts = store.listArtifacts(id);
    return projectRunObservations(
      run,
      store.getSession(run.sessionId),
      events,
      {
        permissions: store.listPermissions(id).length,
        artifacts: artifacts.length,
        artifactBytes: artifacts.reduce((total, item) => total + item.size, 0),
      },
    );
  }
  overview(input: { limit?: number } = {}): ObservabilityOverview {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT_RUNS)
      throw new HubError(
        "INVALID_OBSERVATION_LIMIT",
        "Observation limit must be between 1 and 200",
        400,
      );
    const runs = this.options.store
      .listRuns()
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const recentRuns = runs.slice(0, limit).map((run) => this.run(run.id));
    const durations = recentRuns.flatMap((run) =>
      run.timings.durationMs === null ? [] : [run.timings.durationMs],
    );
    const count = (status: RunRecord["status"]) =>
      runs.filter((run) => run.status === status).length;
    const knownTotal = (field: keyof ObservedTokens) => {
      const values = recentRuns.flatMap((run) =>
        run.tokens[field] === null ? [] : [run.tokens[field]!],
      );
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    const sessions = new Map(
      this.options.store
        .listSessions()
        .map((session) => [session.id, session.engineId]),
    );
    const profiles = this.options.engines();
    const ids = [
      ...new Set([
        ...profiles.map((profile) => profile.id),
        ...sessions.values(),
      ]),
    ];
    const engines = ids.map((id) => {
      const profile = profiles.find((engine) => engine.id === id),
        related = runs.filter((run) => sessions.get(run.sessionId) === id);
      const times = recentRuns
        .filter((run) => run.engineId === id)
        .flatMap((run) =>
          run.timings.durationMs === null ? [] : [run.timings.durationMs],
        );
      return {
        id,
        enabled: profile?.enabled ?? false,
        maxConcurrency: profile?.maxConcurrency ?? 0,
        activeRuns: related.filter(
          (run) => !isTerminal(run.status) && run.status !== "queued",
        ).length,
        queuedRuns: related.filter((run) => run.status === "queued").length,
        completedRuns: related.filter((run) => run.status === "completed")
          .length,
        failedRuns: related.filter(
          (run) =>
            run.status === "failed" ||
            run.status === "timed_out" ||
            run.status === "interrupted",
        ).length,
        p50DurationMs: percentile(times, 0.5),
        p95DurationMs: percentile(times, 0.95),
      };
    });
    const usageObservedRuns = recentRuns.filter(
      (run) => run.coverage.usage,
    ).length;
    return {
      schemaVersion: 1,
      generatedAt: Date.now(),
      scope: { limit, totalRuns: runs.length, sampledRuns: recentRuns.length },
      summary: {
        totalRuns: runs.length,
        activeRuns: runs.filter((run) => !isTerminal(run.status)).length,
        completedRuns: count("completed"),
        failedRuns: count("failed"),
        cancelledRuns: count("cancelled"),
        timedOutRuns: count("timed_out"),
        interruptedRuns: count("interrupted"),
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        knownInputTokens: knownTotal("input"),
        knownOutputTokens: knownTotal("output"),
        knownTotalTokens: knownTotal("total"),
        usageObservedRuns,
        usageCoverage: recentRuns.length
          ? usageObservedRuns / recentRuns.length
          : null,
      },
      engines,
      recentRuns,
    };
  }
}
