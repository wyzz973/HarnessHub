import assert from "node:assert/strict";
import test from "node:test";
import { commandId, messageId, runId, sessionId, type PublicRun, type RunStatus, type SessionSnapshot } from "../../src/contracts/session.js";
import { buildPublicContext as buildOver, publicSources as sourcesOver } from "../../src/contexts/session/domain/context.js";
import { estimateTokens } from "../../src/contexts/session/domain/relay/budget.js";
import { snapshotHistory } from "../fixtures/old-shape.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";

/** The functions under test read a conversation as `RelayHistory` tells it; these tests make theirs by hand, in the old whole shape (tests/fixtures/old-shape.ts). */
const buildPublicContext = (given: SessionSnapshot, ...rest: Parameters<typeof buildOver> extends [unknown, ...infer Rest] ? Rest : never) => buildOver(snapshotHistory(given), ...rest);
const publicSources = (given: SessionSnapshot, current?: PublicRun) => sourcesOver(snapshotHistory(given), current);

/** A Run in `status`; a settled one was settled by its Harness (dispatched), as a source of public history must be (ADR-055 R0a). */
function run(index: number, status: RunStatus): PublicRun {
  const settled = status === "completed" || status === "cancelled" || status === "failed";
  return { id: runId("run-" + index), commandId: commandId("send-" + index), input: "input " + index,
    userMessageId: messageId("message-user-" + index), assistantMessageId: messageId("message-assistant-" + index),
    selection: { harnessId: "fixture", controlId: "fixture-acp" }, epoch: 1, status, cancelRequested: status === "cancelled",
    contextThroughSeq: 0, sourceRunIds: [], backend: settled ? { status, reason: "fixture" } : null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null };
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

// Before ADR-055's packet (G070 MVP) these asserted a JSON envelope; each now asserts the same fact in the packet, or a
// stricter one (the current input is exactly the text after the end line). The rendering itself is tests/unit/relay-packet.test.ts's.
test("context includes all terminal history and one current input, excluding other queued messages", () => {
  const completed = run(1, "completed"), cancelled = run(2, "cancelled"), current = run(3, "preparing"), queued = run(4, "queued");
  const context = buildPublicContext(state([completed, cancelled, current, queued]), current);
  assert.deepEqual(context.sourceRunIds, [completed.id, cancelled.id]);
  assert.equal(context.throughSeq, 50); assert.equal(context.continuity, "public_context_rehydrate");
  const packet = readRelayPrompt(context.text);
  assert.deepEqual(packet.history.map(row => row.user.text), ["input 1", "input 2"]);
  assert.equal(packet.currentInput.text, "input 3", "the current input follows the end line, exactly as typed");
  assert.ok(!context.text.includes("input 4"));
  assert.match(context.text, /^### Turn 2 · fixture · cancelled \(stopped by the user\)$/mu, "a cancelled Turn keeps its outcome");
  assert.match(context.text, /^Only the text after the last line \("The user's current instruction follows, verbatim\."\) is what the user is saying now;/mu);
  assert.equal(context.relay.kind, "packet"); assert.equal(context.relay.sources.runs, 2); assert.equal(context.relay.complete, true); assert.equal(context.relay.repeat, false);
});

test("a packet sent again says so: the option reaches the rendering and its record", () => {
  const completed = run(1, "completed"), current = run(2, "preparing"), snapshot = state([completed, current]);
  const once = buildPublicContext(snapshot, current), again = buildPublicContext(snapshot, current, undefined, { repeat: true });
  assert.ok(!once.text.includes("may be things you have already received")); assert.equal(once.relay.repeat, false);
  assert.ok(again.text.split("\n")[2]!.startsWith("Parts of this may be things you have already received;"), "the line after the title line"); assert.equal(again.relay.repeat, true);
  assert.equal(readRelayPrompt(again.text).currentInput.text, "input 2");
});

test("a finished input that never reached a Harness is no public fact: it is neither a source nor owed (ADR-055 R0a)", () => {
  const timed = (row: PublicRun, dispatchedAt?: number): PublicRun => ({ ...row, timing: { acceptedAt: 1, ...(dispatchedAt === undefined ? {} : { dispatchedAt }) } });
  const answered = timed(run(1, "completed"), 2), queuedThenCancelled = timed({ ...run(2, "cancelled"), backend: null }), failedBeforeDispatch = timed({ ...run(3, "failed"), backend: null });
  const unknown = run(4, "unknown"), legacyCancelled = { ...run(5, "cancelled"), backend: null }, current = run(6, "preparing");
  const snapshot = state([answered, queuedThenCancelled, failedBeforeDispatch, unknown, legacyCancelled, current]);
  // A Run with times is dispatched once `dispatchedAt` is recorded; one from before v10 once its Harness settled it or it ended unknown.
  assert.deepEqual(publicSources(snapshot, current), [answered.id, unknown.id]);
  assert.deepEqual(buildPublicContext(snapshot, current).sourceRunIds, [answered.id, unknown.id]);
  for (const absent of ["input 2", "input 3", "input 5"]) assert.ok(!buildPublicContext(snapshot, current).text.includes(absent), absent);
});

test("explicit source identities exclude later cancelled queue entries", () => {
  // The JSON envelope could be built without a current input (`currentInput: null`); a packet always belongs to the input it goes with.
  const first = run(1, "completed"), later = run(2, "cancelled"), current = run(3, "preparing");
  const context = buildPublicContext(state([first, later, current]), current, [first.id]);
  assert.deepEqual(context.sourceRunIds, [first.id]); assert.ok(!context.text.includes("input 2"));
  assert.equal(readRelayPrompt(context.text).currentInput.text, "input 3");
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
  const failed = { ...run(1, "failed"), input: "中文 \"quoted\"\n新行" }, unknown = run(2, "unknown"), current = run(3, "preparing");
  const context = buildPublicContext(state([failed, unknown, current]), current);
  assert.deepEqual(readRelayPrompt(context.text).history.map(row => row.user.text), [failed.input, "input 2"], "earlier words are quoted byte for byte");
  assert.match(context.text, /^### Turn 1 · fixture · failed$/mu); assert.match(context.text, /^### Turn 2 · fixture · result not verified$/mu);
  // The same facts, for an input in Chinese: the Chinese frame and labels.
  const chinese = { ...current, input: "继续" }, zh = buildPublicContext(state([failed, unknown, chinese]), chinese);
  assert.match(zh.text, /^### 第 1 轮 · fixture · 失败$/mu); assert.match(zh.text, /^### 第 2 轮 · fixture · 结果未核实$/mu);
  assert.match(zh.text, /^〔HarnessHub 交接单 relay-[0-9a-z]{20}〕$/mu); assert.equal(zh.relay.language, "zh");
});

test("context rejects missing, duplicate or nonterminal sources instead of substituting empty history", () => {
  const completed = run(1, "completed"), queued = run(2, "queued"), current = run(3, "preparing"), snapshot = state([completed, queued, current]);
  for (const sources of [[runId("run-missing")], [completed.id, completed.id], [queued.id]])
    assert.throws(() => buildPublicContext(snapshot, current, sources), /source|duplicate/);
  const orphan = { ...snapshot, messages: snapshot.messages.filter(message => message.id !== completed.userMessageId) };
  assert.throws(() => buildPublicContext(orphan, current, [completed.id]), /lacks its user message|not a completed public fact/);
});

test("a reply of any size is left out whole when it does not fit the budget, and nothing makes the rendering fail", () => {
  // Formerly: the history failed CONTEXT_TOO_LARGE past 1 MiB, and a current input beyond the channel did too. Now nothing makes
  // it fail (ADR-055 §0); the packet stays within T = min(8,000, 5% of 128k) tokens and says what it left out.
  const completed = run(1, "completed"), current = run(2, "preparing"), baseline = state([completed, current]);
  const snapshot = (count: number, char = "x") => ({ ...baseline, messages: baseline.messages.map(message => message.role === "assistant" ? { ...message, text: char.repeat(count) } : message) });
  for (const [count, char] of [[1024 * 1024, "x"], [400000, '"'], [600000, "\u0000"]] as const) {
    const context = buildPublicContext(snapshot(count, char), current);
    assert.ok(context.relay.tokens <= context.relay.budget.cap && estimateTokens(readRelayPrompt(context.text).body) === context.relay.tokens, "within the cap: " + count);
    assert.ok(!context.text.includes(char.repeat(16 * 1024)), "the reply is cut");
    assert.equal(readRelayPrompt(context.text).currentInput.text, "input 2");
  }
  const left = buildPublicContext(snapshot(1024 * 1024), current);
  assert.match(left.text, /Replies: 1 in all, 0 included, 1 left out \(turn 1\)/u); assert.equal(left.relay.tier, "brief"); assert.equal(left.relay.items.replies.omitted, 1);
  // A current input of a megabyte is beyond what the Runtime admits, but rendering it does not fail: the packet is the same and the words go last.
  const huge = { ...current, input: "y".repeat(1024 * 1024) }, owned = { ...baseline, runs: [completed, huge], messages: baseline.messages.map(message => message.runId === current.id && message.role === "user" ? { ...message, text: huge.input } : message) };
  const big = buildPublicContext(owned, huge);
  assert.ok(big.text.endsWith("\n" + huge.input)); assert.equal(big.relay.kind, "packet"); assert.ok(big.relay.tokens <= big.relay.budget.cap);
});
