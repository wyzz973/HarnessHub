import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCallRecord } from "../../src/drivers/chat-completions/gateway.js";
import type { DriverResult } from "../../src/domain/types.js";
import {
  appendDiagnostic,
  createRedactor,
  describeError,
  publicErrorMessage,
  truncatePublic,
} from "../../src/worker/diagnostics.js";
import {
  modelCallEventData,
  RunObservation,
  settleGatewayResult,
} from "../../src/worker/outcome.js";

const secret = "synthetic-upstream-secret-value";
const redact = createRedactor(new Set([secret]));
function call(overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    id: "call-1",
    inbound: "openai-completions",
    stream: true,
    requestedModel: "harnesshub-model",
    upstreamModel: "company-model",
    status: 200,
    ok: true,
    durationMs: 12,
    toolCalls: 0,
    ...overrides,
  };
}
const rejected = call({
  id: "call-2",
  status: 400,
  ok: false,
  error: {
    code: "upstream_http_400",
    message: `Unsupported parameter: stream_options (${secret})`,
  },
});
function text(observation: RunObservation, value: string, stream = "output") {
  observation.observe({
    type: "event",
    event: {
      type: "message.delta",
      data: { text: value, messageId: "m", stream },
    },
  });
}
const completed: DriverResult = {
  status: "completed",
  stopReason: "end_turn",
  output: "",
};

void test("upstream failures without engine output become MODEL_UPSTREAM_ERROR with the redacted cause", () => {
  const observation = new RunObservation();
  observation.recordCall(rejected);
  text(observation, "private reasoning", "thought");
  const settled = settleGatewayResult(completed, {
    observation,
    upstreamErrors: [rejected],
    cancelled: false,
    redact,
  });
  assert.equal(settled.status, "failed");
  assert.equal(settled.stopReason, "model_upstream_error");
  assert.equal(settled.error?.code, "MODEL_UPSTREAM_ERROR");
  assert.match(settled.error?.message ?? "", /HTTP 400/);
  assert.match(
    settled.error?.message ?? "",
    /Unsupported parameter: stream_options/,
  );
  assert.equal(settled.error?.message.includes(secret), false);
  // A failed backend result with the same evidence gets the specific cause.
  const failed = settleGatewayResult(
    {
      status: "failed",
      error: { code: "ACP_TURN_FAILED", message: "generic" },
    },
    { observation, upstreamErrors: [rejected], cancelled: false, redact },
  );
  assert.equal(failed.error?.code, "MODEL_UPSTREAM_ERROR");
});

void test("error text printed by the engine without any successful model call is not an answer", () => {
  const observation = new RunObservation();
  observation.recordCall(rejected);
  text(observation, "unexpected status 400 Bad Request");
  assert.equal(
    settleGatewayResult(completed, {
      observation,
      upstreamErrors: [rejected],
      cancelled: false,
      redact,
    }).error?.code,
    "MODEL_UPSTREAM_ERROR",
  );
  // After a successful retry the visible answer stands.
  observation.recordCall(call({ id: "call-3" }));
  assert.deepEqual(
    settleGatewayResult(completed, {
      observation,
      upstreamErrors: [rejected],
      cancelled: false,
      redact,
    }),
    completed,
  );
});

void test("tool activity and permission requests count as output; cancellations are never rewritten", () => {
  for (const payload of [
    {
      type: "event" as const,
      event: { type: "tool.update", data: { toolCallId: "t", text: "run" } },
    },
    {
      type: "permission" as const,
      permission: {
        id: "p" as never,
        toolCallId: "t",
        prompt: "Allow?",
        options: [{ id: "allow", label: "Allow", kind: "allow_once" as const }],
      },
    },
  ]) {
    const observation = new RunObservation();
    observation.recordCall(call());
    observation.recordCall(rejected);
    observation.observe(payload);
    assert.equal(observation.producedOutput, true);
    assert.deepEqual(
      settleGatewayResult(completed, {
        observation,
        upstreamErrors: [rejected],
        cancelled: false,
        redact,
      }),
      completed,
    );
  }
  const cancelled: DriverResult = { status: "cancelled", stopReason: "x" };
  for (const [result, flag] of [
    [cancelled, false],
    [completed, true],
  ] as const)
    assert.deepEqual(
      settleGatewayResult(result, {
        observation: new RunObservation(),
        upstreamErrors: [rejected],
        cancelled: flag,
        redact,
      }),
      result,
    );
});

void test("a completed Run without model calls or output becomes ENGINE_NO_OUTPUT", () => {
  const silent = settleGatewayResult(completed, {
    observation: new RunObservation(),
    upstreamErrors: [],
    cancelled: false,
    redact,
  });
  assert.equal(silent.status, "failed");
  assert.equal(silent.error?.code, "ENGINE_NO_OUTPUT");
  assert.equal(silent.error?.message, "引擎未调用模型也未产生输出");
  const answered = new RunObservation();
  text(answered, "ok");
  assert.deepEqual(
    settleGatewayResult(completed, {
      observation: answered,
      upstreamErrors: [],
      cancelled: false,
      redact,
    }),
    completed,
  );
  const empty = new RunObservation();
  empty.recordCall(call());
  // The model was called successfully; an empty answer is reported as is.
  assert.deepEqual(
    settleGatewayResult(completed, {
      observation: empty,
      upstreamErrors: [],
      cancelled: false,
      redact,
    }),
    completed,
  );
  // Only completed results are rewritten for missing output.
  const failed: DriverResult = {
    status: "failed",
    error: { code: "X", message: "y" },
  };
  assert.deepEqual(
    settleGatewayResult(failed, {
      observation: new RunObservation(),
      upstreamErrors: [],
      cancelled: false,
      redact,
    }),
    failed,
  );
});

void test("model.call event data copies the ADR record and redacts its error", () => {
  const data = modelCallEventData(
    { ...rejected, usage: { input: 3, output: 5 }, finishReason: "stop" },
    redact,
  );
  assert.deepEqual(data, {
    id: "call-2",
    inbound: "openai-completions",
    stream: true,
    requestedModel: "harnesshub-model",
    upstreamModel: "company-model",
    status: 400,
    ok: false,
    durationMs: 12,
    finishReason: "stop",
    usage: { input: 3, output: 5 },
    toolCalls: 0,
    error: {
      code: "upstream_http_400",
      message: "Unsupported parameter: stream_options ([REDACTED])",
    },
  });
  assert.equal("error" in modelCallEventData(call(), redact), false);
});

void test("unexpected errors describe ACP RequestError data and cause chains, redacted and bounded", () => {
  const acp = Object.assign(new Error("Authentication required"), {
    name: "RequestError",
    code: -32000,
    data: { message: "login needed for ACP", details: "use gateway" },
  });
  assert.equal(
    describeError(acp),
    "RequestError: Authentication required: login needed for ACP: use gateway",
  );
  const wrapped = new Error("Failed to create session", { cause: acp });
  assert.equal(
    describeError(wrapped),
    "Failed to create session: Authentication required: login needed for ACP: use gateway",
  );
  const leaking = new Error(
    `bad key ${secret}; Authorization: Bearer abc.def-123 api_key=xyz987 sk-abcdefghijk token="tok123456"`,
  );
  const message = publicErrorMessage(leaking, redact);
  for (const value of [
    secret,
    "abc.def-123",
    "xyz987",
    "abcdefghijk",
    "tok123456",
  ])
    assert.equal(message.includes(value), false, message);
  assert.match(message, /\[REDACTED\]/);
  assert.equal(describeError("plain text failure"), "plain text failure");
  assert.equal(describeError(undefined), "Unknown engine error");
  const long = truncatePublic("中".repeat(600));
  assert.equal(Array.from(long).length, 500);
  assert.equal(long.endsWith("…"), true);
  assert.equal(truncatePublic("中".repeat(500)), "中".repeat(500));
  const cyclic: { message: string; cause?: unknown } = { message: "loop" };
  cyclic.cause = cyclic;
  assert.equal(describeError(cyclic), "loop");
});

void test("diagnostic log appends redacted stacks to a private Session file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-worker-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const error = new Error(`first failure ${secret}`, {
    cause: Object.assign(new Error("inner"), { data: { reason: "x" } }),
  });
  const file = await appendDiagnostic(
    root,
    { runId: "run-1", generation: 1, error },
    redact,
  );
  await appendDiagnostic(
    root,
    { runId: "run-2", generation: 2, error: "second" },
    redact,
  );
  assert.equal(file, join(root, "diagnostics", "worker-errors.log"));
  const text = await readFile(file, "utf8");
  assert.match(text, /run=run-1 generation=1/);
  assert.match(text, /run=run-2 generation=2/);
  assert.match(text, /\n\s+at /);
  assert.match(text, /caused by: Error: inner/);
  assert.match(text, /data: \{"reason":"x"\}/);
  assert.equal(text.includes(secret), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "diagnostics"))).mode & 0o777, 0o700);
  }
});
