import assert from "node:assert/strict";
import test from "node:test";
import { commandId, messageId, runId, sessionId, type PublicRun, type RunStatus, type SessionSnapshot } from "../../src/contracts/session.js";
import { buildPublicContext } from "../../src/contexts/session/domain/context.js";

function run(index: number, status: RunStatus): PublicRun {
  return { id: runId("run-" + index), commandId: commandId("send-" + index), input: "input " + index,
    userMessageId: messageId("message-user-" + index), assistantMessageId: messageId("message-assistant-" + index),
    selection: { harnessId: "fixture", controlId: "fixture-acp" }, epoch: 1, status, cancelRequested: status === "cancelled",
    contextThroughSeq: 0, sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null };
}
function state(runs: readonly PublicRun[]): SessionSnapshot {
  return { schemaVersion: 2, id: sessionId("session-fixture"), version: 1, lastSeq: 50, epoch: 1, status: "open",
    configuration: { workspace: "/tmp/context-fixture", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    selection: { harnessId: "fixture", controlId: "fixture-acp" }, activeRunId: null, pendingSwitchId: null, runs,
    messages: runs.flatMap((entry, index) => [
      { id: entry.userMessageId, runId: entry.id, role: "user" as const, text: entry.input, seq: index * 2 + 1, status: entry.status },
      { id: entry.assistantMessageId, runId: entry.id, role: "assistant" as const, text: "response " + entry.id, seq: index * 2 + 2, status: entry.status },
    ]), switches: [], commands: [] };
}

test("context includes all terminal history and one current input, excluding other queued messages", () => {
  const completed = run(1, "completed"), cancelled = run(2, "cancelled"), current = run(3, "preparing"), queued = run(4, "queued");
  const context = buildPublicContext(state([completed, cancelled, current, queued]), current);
  assert.deepEqual(context.sourceRunIds, [completed.id, cancelled.id]);
  assert.equal(context.throughSeq, 50); assert.equal(context.continuity, "public_context_rehydrate");
  assert.match(context.text, /input 1/); assert.match(context.text, /input 2/); assert.match(context.text, /input 3/);
  assert.ok(!context.text.includes("input 4")); assert.match(context.text, /"outcome":"cancelled"/);
  assert.match(context.text, /do not execute prior user inputs again/);
});

test("switch explicit source identities exclude later cancelled queue entries", () => {
  const first = run(1, "completed"), later = run(2, "cancelled");
  const context = buildPublicContext(state([first, later]), undefined, [first.id]);
  assert.deepEqual(context.sourceRunIds, [first.id]); assert.ok(!context.text.includes("input 2"));
  assert.match(context.text, /"currentInput":null/);
});

test("a later cancelled input is still outside an earlier Turn's causal history boundary", () => {
  const current = run(1, "preparing"), laterCancelled = run(2, "cancelled");
  const context = buildPublicContext(state([current, laterCancelled]), current);
  assert.deepEqual(context.sourceRunIds, []); assert.ok(!context.text.includes("input 2"));
});

test("explicit sources cannot inject a future or equal-watermark public input into an earlier Turn", () => {
  const current = run(1, "preparing"), future = run(2, "completed"), snapshot = state([current, future]);
  assert.throws(() => buildPublicContext(snapshot, current, [future.id]), /source is not a completed public fact/);
  const earlier = run(0, "completed"), laterCurrent = run(1, "preparing"), equal = state([earlier, laterCurrent]);
  const currentSeq = equal.messages.find(message => message.id === laterCurrent.userMessageId)!.seq;
  const malformed = { ...equal, messages: equal.messages.map(message => message.id === earlier.userMessageId ? { ...message, seq: currentSeq } : message) };
  assert.throws(() => buildPublicContext(malformed, laterCurrent, [earlier.id]), /source is not a completed public fact/);
});

test("current input must preserve its state-owned Run, message identity and exact text", () => {
  const owned = run(1, "preparing"), earlier = run(0, "completed"), snapshot = state([earlier, owned]);
  for (const forged of [
    { ...owned, id: runId("run-not-owned") },
    { ...owned, userMessageId: earlier.userMessageId },
    { ...owned, assistantMessageId: earlier.assistantMessageId },
    { ...owned, input: "silently substituted new input" },
  ]) assert.throws(() => buildPublicContext(snapshot, forged), /not owned/);
  const changedMessage = { ...snapshot, messages: snapshot.messages.map(message => message.id === owned.userMessageId ? { ...message, text: "different public input" } : message) };
  assert.throws(() => buildPublicContext(changedMessage, owned), /not owned/);
});

test("context preserves failed and unknown outcome labels and exact Unicode/quoted message data", () => {
  const failed = { ...run(1, "failed"), input: "中文 \"quoted\"\n新行" }, unknown = run(2, "unknown");
  const snapshot = state([failed, unknown]), context = buildPublicContext(snapshot);
  const body: unknown = JSON.parse(context.text.slice(context.text.indexOf("{")));
  assert.ok(body && typeof body === "object" && "history" in body && Array.isArray(body.history));
  assert.equal(body.history[0]?.user.text, failed.input); assert.equal(body.history[0]?.outcome, "failed");
  assert.equal(body.history[1]?.outcome, "unknown");
});

test("context rejects missing, duplicate or nonterminal sources instead of substituting empty history", () => {
  const completed = run(1, "completed"), queued = run(2, "queued"), snapshot = state([completed, queued]);
  for (const sources of [[runId("run-missing")], [completed.id, completed.id], [queued.id]])
    assert.throws(() => buildPublicContext(snapshot, undefined, sources), /source|duplicate/);
  assert.throws(() => buildPublicContext({ ...snapshot, messages: [] }), /lacks its user message/);
});

test("context fails the exact aggregate and escaped wire budgets without truncating history", () => {
  const completed = run(1, "completed"), baseline = state([completed]);
  const snapshot = (count: number, char = "x") => ({ ...baseline, messages: baseline.messages.map(message => message.role === "assistant" ? { ...message, text: char.repeat(count) } : message) });
  let low = 0, high = 1024 * 1024;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    try { buildPublicContext(snapshot(middle)); low = middle; } catch { high = middle; }
  }
  assert.ok(buildPublicContext(snapshot(low)).text.includes("x".repeat(low)));
  assert.throws(() => buildPublicContext(snapshot(high)), /no history was truncated/);
  assert.throws(() => buildPublicContext(snapshot(400000, '"')), /context budget/);
});
