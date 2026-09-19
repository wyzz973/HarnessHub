import assert from "node:assert/strict";
import test from "node:test";
import {
  RunTranscript,
  failureOf,
  truncateText,
} from "../../src/gateway/competition/transcript.js";
import type {
  AgentEvent,
  JsonObject,
  RunId,
  RunRecord,
  RunStatus,
  SessionId,
} from "../../src/domain/types.js";

const runId = "run-1" as RunId;
const sessionId = "session-1" as SessionId;

function events(...drafts: [string, JsonObject][]): AgentEvent[] {
  return drafts.map(([type, data], index) => ({
    schemaVersion: 1,
    eventId: `${runId}:${index + 1}`,
    sessionId,
    runId,
    seq: index + 1,
    occurredAt: 1_000 + index,
    observedAt: 1_000 + index,
    type,
    data,
  }));
}

function run(status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: runId,
    sessionId,
    generation: 1,
    status,
    input: { text: "task", timeoutMs: 60_000 },
    createdAt: 500,
    deadlineAt: 60_500,
    cleanupStatus: "confirmed",
    lastSeq: 0,
    ...extra,
  };
}

const text = (value: string, messageId = "m", stream = "output") =>
  ["message.delta", { text: value, messageId, stream }] as [string, JsonObject];
const tool = (id: string, details: JsonObject) =>
  ["tool.update", { toolCallId: id, details }] as [string, JsonObject];

void test("truncation keeps whole code points and reports the omitted count", () => {
  assert.equal(truncateText("abc", 3), "abc");
  assert.equal(truncateText("😀😀😀", 3), "😀😀😀");
  assert.equal(truncateText("😀😀😀", 4), "😀😀😀");
  assert.equal(
    truncateText("😀😀😀😀😀", 3),
    "😀😀😀\n…[truncated 2 characters]",
  );
  assert.equal(truncateText("", 0), "");
});

void test("tool updates merge partial ACP payloads by tool call id", () => {
  const transcript = new RunTranscript(runId);
  const updates = events(
    text("Reading"),
    tool("t1", {
      status: "pending",
      title: "tool call",
      kind: "read",
      rawInput: "a.ts",
    }),
    tool("t1", { title: "tool call", rawOutput: { lines: 3 } }),
    tool("t1", {
      status: "completed",
      content: [{ type: "diff", path: "a.ts" }],
    }),
  ).flatMap((event) => transcript.apply(event));
  assert.deepEqual(
    updates
      .filter((update) => update.part.type === "tool")
      .map((update) => update.part.type === "tool" && update.part.state),
    [
      { status: "running", title: "read" },
      { status: "running", title: "read" },
      { status: "completed", title: "read" },
    ],
  );
  const listed = transcript.messages(run("running"));
  assert.deepEqual(
    listed.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  const [, assistant, result] = listed;
  assert.ok(assistant?.role === "assistant");
  assert.deepEqual(assistant.tool_calls, [
    { id: "t1", name: "read", arguments: { input: "a.ts" } },
  ]);
  assert.equal(assistant.info.finish, "tool-calls");
  assert.ok(!assistant.parts.some((part) => part.type === "step-finish"));
  assert.ok(result?.role === "tool");
  assert.equal(result.content, "diff a.ts");
});

void test("steps split on output after tools and text parts split by message", () => {
  const transcript = new RunTranscript(runId);
  for (const event of events(
    text("first", "a"),
    text("second", "b"),
    tool("t1", {
      status: "in_progress",
      title: "bash",
      rawInput: { command: "ls" },
    }),
    text("thinking", "a", "thought"),
    tool("t2", { status: "pending", title: "grep" }),
    text("answer", "c"),
  ))
    transcript.apply(event);
  const running = transcript.messages(run("running"));
  assert.deepEqual(
    running.map((message) =>
      message.role === "assistant"
        ? [message.content, message.info.finish, message.tool_calls.length]
        : message.role,
    ),
    [
      "user",
      ["first\n\nsecond", "tool-calls", 1],
      ["", "tool-calls", 1],
      ["answer", "running", 0],
    ],
  );
  const final = running.at(-1);
  assert.ok(final?.role === "assistant");
  assert.ok(!final.parts.some((part) => part.type === "step-finish"));
  assert.ok(running.every((message) => !message.content.includes("thinking")));
});

void test("an ended Run without streamed text shows its output once", () => {
  const transcript = new RunTranscript(runId);
  const [completed] = events([
    "RUN_COMPLETED",
    { status: "completed", stopReason: "end_turn", output: "final text" },
  ]);
  assert.ok(completed);
  const updates = transcript.apply(completed);
  const listed = transcript.messages(
    run("completed", { output: "final text", finishedAt: 2_000 }),
  );
  assert.deepEqual(
    listed.map((message) => [message.role, message.content]),
    [
      ["user", "task"],
      ["assistant", "final text"],
    ],
  );
  const assistant = listed[1];
  assert.ok(assistant?.role === "assistant");
  assert.equal(assistant.info.finish, "stop");
  assert.deepEqual(
    updates.map((update) => [update.messageID, update.part.id]),
    assistant.parts.map((part) => [assistant.id, part.id]),
  );
});

void test("interrupted and timed-out Runs report status-specific errors", () => {
  assert.deepEqual(failureOf("interrupted", undefined, "gateway_restarted"), {
    code: "RUN_INTERRUPTED",
    message: "Run was interrupted before completion (gateway_restarted)",
  });
  assert.deepEqual(failureOf("timed_out", undefined, "timed_out"), {
    code: "RUN_TIMED_OUT",
    message: "Run exceeded its deadline",
  });
  assert.equal(failureOf("cancelled"), undefined);
  const listed = new RunTranscript(runId).messages(
    run("interrupted", { stopReason: "gateway_restarted", finishedAt: 900 }),
  );
  const last = listed.at(-1);
  assert.ok(last?.role === "assistant");
  assert.deepEqual(last.info, {
    role: "assistant",
    finish: "error",
    error: {
      code: "RUN_INTERRUPTED",
      message: "Run was interrupted before completion (gateway_restarted)",
    },
  });
  assert.deepEqual(
    last.parts.map((part) => part.type),
    ["step-finish"],
  );
});
