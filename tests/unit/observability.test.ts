import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acpUsageObservation,
  captureNativeUsage,
  nativeUsageObservation,
} from "../../src/drivers/acp/observations.js";
import {
  percentile,
  projectRunObservations,
} from "../../src/application/observability.js";
import type {
  AgentEvent,
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "../../src/domain/types.js";
import type { ExecutionSpec } from "../../src/domain/ports.js";
const identity = {
  backendSessionId: "backend-123",
  requestId: "run-123:1",
  freshSession: false,
};

void test("ACP cumulative labels alone never prove per-run token attribution", () => {
  const observed = acpUsageObservation(
    { cumulative: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    { cumulative: { inputTokens: 350, outputTokens: 50, totalTokens: 400 } },
    identity,
  );
  assert.equal(observed.scope, "session");
  assert.equal(observed.tokens.input, 350);
  assert.equal(
    observed.missingReason,
    "acp-session-usage-not-attributable-to-run",
  );
  assert.equal(observed.cost.kind, "unknown");
});

void test("perRequest usage uses exact request or newly recorded IDs and preserves zero versus unknown", () => {
  const usage = acpUsageObservation(
    { perRequest: { old: { inputTokens: 100 } } },
    {
      perRequest: {
        old: { inputTokens: 100 },
        "run-123:1": { inputTokens: 5, outputTokens: 0 },
      },
    },
    identity,
  );
  assert.equal(usage.tokens.input, 5);
  assert.equal(usage.tokens.output, 0);
  assert.equal(usage.tokens.total, null);
});

void test("Pi session identity and immutable message IDs give run usage; native prices remain estimates", async (t) => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hub-observe-pi-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, "backend"),
    home = path.join(stateDir, "home"),
    sessionFile = path.join(home, ".pi/agent/session.jsonl");
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await mkdir(path.join(home, ".pi/pi-acp"), { recursive: true });
  await writeFile(
    path.join(home, ".pi/pi-acp/session-map.json"),
    JSON.stringify({
      version: 1,
      sessions: {
        [identity.backendSessionId]: {
          sessionId: identity.backendSessionId,
          cwd: directory,
          sessionFile,
        },
      },
    }),
  );
  const header = {
    type: "session",
    id: identity.backendSessionId,
    cwd: directory,
  };
  const message = (id: string, input: number) => ({
    type: "message",
    id,
    message: {
      role: "assistant",
      provider: "provider",
      model: "model",
      usage: {
        input,
        output: 5,
        cacheRead: 20,
        cacheWrite: 0,
        reasoning: 2,
        totalTokens: input + 25,
        cost: { total: 0.03 },
      },
    },
  });
  await writeFile(
    sessionFile,
    [header, message("old", 10)].map((row) => JSON.stringify(row)).join("\n"),
  );
  const spec: ExecutionSpec = {
    sessionId: randomUUID() as SessionId,
    runId: randomUUID() as RunId,
    generation: 1,
    profile: {
      id: "pi",
      driver: "acp",
      command: ["node", "/adapter/pi-acp/index.js"],
      revision: "r",
      enabled: true,
      maxConcurrency: 1,
      capabilities: { resume: false, permissions: true, images: false },
    },
    cwd: directory,
    input: { text: "private", timeoutMs: 1000 },
    stateDir,
  };
  const before = await captureNativeUsage(spec, identity.backendSessionId);
  await writeFile(
    sessionFile,
    [header, message("old", 10), message("new", 50)]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const after = await captureNativeUsage(spec, identity.backendSessionId);
  const run = nativeUsageObservation(before, after, identity);
  assert.equal(run.tokens.input, 70);
  assert.equal(run.tokens.total, 75);
  assert.equal(run.tokens.reasoning, 2);
  assert.equal(run.model, "provider/model");
  assert.equal(run.cost.kind, "estimated");
  assert.equal(run.cost.amount, 0.03);
  assert.equal(
    nativeUsageObservation(before, after, { ...identity, freshSession: false })
      .scope,
    "run",
  );
  const sessionOnly = nativeUsageObservation(
    { ...before, items: [], missingReason: "missing" },
    after,
    identity,
  );
  assert.equal(sessionOnly.scope, "session");
  assert.equal(sessionOnly.missingReason, "native-run-baseline-unavailable");
  await writeFile(sessionFile, JSON.stringify({ ...header, id: "different" }));
  assert.equal(
    (await captureNativeUsage(spec, identity.backendSessionId)).missingReason,
    "native-session-identity-mismatch",
  );
  await rm(sessionFile);
  const outside = path.join(directory, "outside.jsonl");
  await writeFile(outside, JSON.stringify(header));
  await symlink(outside, sessionFile);
  assert.equal(
    (await captureNativeUsage(spec, identity.backendSessionId)).missingReason,
    "native-evidence-symlink-rejected",
  );
});

function fixture() {
  const session: SessionRecord = {
    id: "session" as SessionId,
    engineId: "engine",
    profileRevision: "revision-original",
    workspaceId: "workspace",
    cwd: "/workspace",
    status: "open",
    backendSessionId: identity.backendSessionId,
    createdAt: 100,
    updatedAt: 100,
  };
  const run: RunRecord = {
    id: "run-123" as RunId,
    sessionId: session.id,
    generation: 1,
    status: "completed",
    input: { text: "input", timeoutMs: 1000 },
    configSnapshot: { driver: "acp", model: "configured-alias" },
    createdAt: 100,
    startedAt: 150,
    finishedAt: 400,
    deadlineAt: 1100,
    cleanupStatus: "confirmed",
    lastSeq: 0,
  };
  const events: AgentEvent[] = [];
  const event = (
    type: string,
    data: AgentEvent["data"],
    observedAt: number,
  ) => {
    events.push({
      schemaVersion: 1,
      eventId: `${events.length}`,
      sessionId: session.id,
      runId: run.id,
      seq: events.length + 1,
      occurredAt: observedAt,
      observedAt,
      type,
      data,
    });
    run.lastSeq = events.length;
  };
  return { session, run, events, event };
}
void test("run projection counts tool identity once, separates reasoning, keeps original profile and truthful timing gaps", () => {
  const { session, run, events, event } = fixture();
  event("RUN_STATUS", { status: "running" }, 180);
  event("message.delta", { text: "思考", stream: "thought" }, 200);
  event("message.delta", { text: "答😀", stream: "output" }, 220);
  event("tool.update", { toolCallId: "tool-1" }, 250);
  event("tool.update", { toolCallId: "tool-1" }, 260);
  event(
    "engine.usage",
    {
      models: { currentModelId: "actual-model" },
      usage: { cumulative: { inputTokens: 1000, outputTokens: 100 } },
    },
    300,
  );
  const result = projectRunObservations(run, session, events, {
    permissions: 1,
    artifacts: 2,
    artifactBytes: 25,
  });
  assert.equal(result.timings.queueMs, 50);
  assert.equal(result.timings.startupMs, 30);
  assert.equal(result.timings.timeToFirstOutputMs, 120);
  assert.equal(result.timings.cleanupMs, null);
  assert.equal(result.counts.outputCharacters, 2);
  assert.equal(result.counts.reasoningCharacters, 2);
  assert.equal(result.counts.toolCalls, 1);
  assert.equal(result.versions.profileRevision, "revision-original");
  assert.equal(result.model.actual, "actual-model");
  assert.equal(result.tokens.input, null);
  assert.equal(result.sessionUsage?.tokens.input, 1000);
  assert.equal(result.coverage.usage, false);
  assert.equal(result.cost.kind, "unknown");
  event(
    "runtime.cleanup",
    { performed: false, durationMs: 0, status: "confirmed" },
    390,
  );
  assert.equal(
    projectRunObservations(run, session, events, {
      permissions: 1,
      artifacts: 2,
      artifactBytes: 25,
    }).timings.cleanupMs,
    0,
  );
  assert.equal(
    projectRunObservations(run, session, events.slice(1), {
      permissions: 1,
      artifacts: 2,
      artifactBytes: 25,
    }).coverage.eventsComplete,
    false,
  );
});
void test("percentiles use a documented finite sample", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([40, 10, 20, 30], 0.5), 20);
  assert.equal(percentile([40, 10, 20, 30], 0.95), 40);
});
