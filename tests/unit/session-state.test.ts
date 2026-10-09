import assert from "node:assert/strict";
import test from "node:test";
import { commandId, sessionId, SessionError } from "../../src/contracts/session.js";
import { assertSessionTransition, parseSession, recoverSession, replayCommand } from "../../src/contexts/session/domain/state.js";

const fingerprint = "a".repeat(64);
const selection = { harnessId: "alpha", controlId: "alpha-acp" };
function run(suffix: string, sources: string[] = [], through = 0) {
  return { id: "run-" + suffix, commandId: "send-" + suffix, input: "input " + suffix,
    userMessageId: "message-user-" + suffix, assistantMessageId: "message-assistant-" + suffix,
    selection, epoch: 1, status: "completed", cancelRequested: false, contextThroughSeq: through, sourceRunIds: sources,
    backend: { status: "completed", reason: "fixture" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null },
    error: null, stopRequested: false, awaitingSwitchId: null };
}
function seed() {
  const one = run("one"), two = run("two", [one.id], 2);
  return { schemaVersion: 2, id: "session-unit", version: 4, lastSeq: 4, epoch: 1, status: "open",
    configuration: { workspace: "/workspace", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    selection, activeRunId: null, pendingSwitchId: null, runs: [one, two],
    messages: [
      { id: one.userMessageId, runId: one.id, role: "user", text: one.input, seq: 1, status: "completed" },
      { id: one.assistantMessageId, runId: one.id, role: "assistant", text: "answer one", seq: 2, status: "completed" },
      { id: two.userMessageId, runId: two.id, role: "user", text: two.input, seq: 3, status: "completed" },
      { id: two.assistantMessageId, runId: two.id, role: "assistant", text: "answer two", seq: 4, status: "completed" },
    ], switches: [] as { id: string; commandId: string; requested: { harnessId: string }; requestedSeq: number; target: typeof selection | null; status: string; throughSeq: number; sourceRunIds: string[]; error: null }[],
    commands: [{ id: "create", kind: "create", fingerprint, resultId: "session-unit" },
      { id: one.commandId, kind: "send", fingerprint, resultId: one.id }, { id: two.commandId, kind: "send", fingerprint, resultId: two.id }] };
}
test("valid public snapshot keeps independent public identities and exact causal context references", () => {
  const state = parseSession(seed()); assert.equal(state.id, sessionId("session-unit"));
  assert.deepEqual(state.runs[1]?.sourceRunIds, [state.runs[0]?.id]); assert.equal(state.messages[2]?.text, state.runs[1]?.input);
});
test("unknown schemas, properties and inconsistent public ownership are rejected", () => {
  const state = seed();
  for (const value of [null, {}, { ...state, schemaVersion: 3 }, { ...state, secret: "not-a-field" },
    { ...state, activeRunId: "run-one" }, { ...state, lastSeq: 3 }, { ...state, status: "unknown" },
    { ...state, configuration: { ...state.configuration, workspace: "relative" } }]) assert.throws(() => parseSession(value), SessionError);
});
test("two Runs cannot share or swap reserved message identities", () => {
  const state = seed();
  for (const patch of [{ userMessageId: state.runs[0]!.userMessageId }, { assistantMessageId: state.runs[0]!.assistantMessageId },
    { userMessageId: state.runs[0]!.assistantMessageId }, { assistantMessageId: state.runs[1]!.userMessageId }]) {
    const value = { ...state, runs: [state.runs[0], { ...state.runs[1], ...patch }] };
    assert.throws(() => parseSession(value), /message identity/);
  }
});
test("public user text must be the input of its own Run", () => {
  const state = seed(); state.messages[0]!.text = "another input";
  assert.throws(() => parseSession(state), /Run\/user relation/);
});
test("a Run cannot lose or cross-link its send command", () => {
  const state = seed();
  assert.throws(() => parseSession({ ...state, commands: state.commands.slice(0, 1) }), /Run\/send command/);
  const swapped = state.commands.map((command, index) => index === 1 ? { ...command, resultId: state.runs[1]!.id } : index === 2 ? { ...command, resultId: state.runs[0]!.id } : command);
  assert.throws(() => parseSession({ ...state, commands: swapped }), /Run\/send command/);
});
test("message creation sequence cannot repeat or move backward", () => {
  const state = seed(); state.messages[2]!.seq = 1;
  assert.throws(() => parseSession(state), /strictly increasing/);
});
test("queued data cannot already contain external execution evidence", () => {
  const state = seed();
  const base = { ...state, runs: [{ ...state.runs[0], status: "queued", backend: null, cleanup: null, sourceRunIds: [], contextThroughSeq: 0 }],
    messages: [{ ...state.messages[0], status: "queued" }], commands: state.commands.slice(0, 2) };
  for (const evidence of [{ backend: state.runs[0]!.backend }, { cleanup: state.runs[0]!.cleanup }, { stopRequested: true }, { contextThroughSeq: 1 }])
    assert.throws(() => parseSession({ ...base, runs: [{ ...base.runs[0], ...evidence }] }), /queued Run contains/);
});
test("context sources cannot include a future user's cancelled input", () => {
  const state = seed(); state.runs[0]!.sourceRunIds = [state.runs[1]!.id]; state.runs[0]!.contextThroughSeq = 4;
  assert.throws(() => parseSession(state), /future input/);
});
test("source public messages must not exceed the stored context watermark", () => {
  const state = seed(); state.runs[1]!.contextThroughSeq = 1;
  assert.throws(() => parseSession(state), /watermark/);
});
test("settling and completed states require distinct backend and cleanup evidence", () => {
  const state = seed();
  assert.throws(() => parseSession({ ...state, runs: [{ ...state.runs[0], cleanup: null }, state.runs[1]] }), /completed Run lacks/);
  assert.throws(() => parseSession({ ...state, activeRunId: state.runs[0]!.id,
    runs: [{ ...state.runs[0], status: "settling", backend: null }, state.runs[1]], messages: state.messages.map(message => message.runId === state.runs[0]!.id ? { ...message, status: "settling" } : message) }), /settling Run lacks/);
});
test("switch evidence links its command, target, source cutoff and epoch", () => {
  const state = seed(); const sw = { id: "switch-one", commandId: "switch-command", requested: { harnessId: "bravo" }, requestedSeq: 5,
    target: { harnessId: "bravo", controlId: "bravo-codex" }, status: "effective", throughSeq: 6, sourceRunIds: state.runs.map(run => run.id), error: null };
  const valid = { ...state, lastSeq: 7, epoch: 2, selection: sw.target, switches: [sw], commands: [...state.commands, { id: sw.commandId, kind: "switch", fingerprint, resultId: sw.id }] };
  parseSession(valid);
  assert.throws(() => parseSession({ ...valid, commands: state.commands }), /switch\/command/);
  assert.throws(() => parseSession({ ...valid, epoch: 1 }), /epoch does not match/);
  assert.throws(() => parseSession({ ...valid, selection }), /last effective/);
  assert.throws(() => parseSession({ ...valid, switches: [{ ...sw, requestedSeq: 3 }] }), /after its request/);
});
test("command retries preserve original result and conflicting payloads reject", () => {
  const state = parseSession(seed());
  assert.equal(replayCommand(state, commandId("send-one"), "send", fingerprint)?.resultId, "run-one");
  assert.throws(() => replayCommand(state, commandId("send-one"), "send", "b".repeat(64)), /another request/);
});
test("owner recovery preserves completed facts and cancels only undispatched input without replay", () => {
  const state = seed(); const run = { ...state.runs[1], status: "queued", sourceRunIds: [], contextThroughSeq: 0, backend: null, cleanup: null };
  const queued = parseSession({ ...state, runs: [state.runs[0], run], messages: state.messages.filter(message => message.role === "user" || message.runId === state.runs[0]!.id).map(message => message.runId === run.id ? { ...message, status: "queued" } : message) });
  const recovery = recoverSession(queued); assert.ok(recovery); assert.equal(recovery.next.runs[0]?.status, "completed");
  assert.equal(recovery.next.runs[1]?.status, "cancelled"); assert.equal(recovery.events[0]?.data.replayed, false);
});

test("a shape-valid mutation cannot silently erase accepted public history", () => {
  const before = parseSession(seed());
  const erased = parseSession({ ...seed(), runs: [], messages: [], commands: seed().commands.slice(0, 1) });
  assert.throws(() => assertSessionTransition(before, erased), /history cannot be removed/);
});
test("terminal output and committed command fingerprints cannot be rewritten", () => {
  const before = parseSession(seed()), output = seed(); output.messages[1]!.text += " appended after terminal";
  assert.throws(() => assertSessionTransition(before, parseSession(output)), /terminal public output/);
  const commands = seed(); commands.commands[1]!.fingerprint = "b".repeat(64);
  assert.throws(() => assertSessionTransition(before, parseSession(commands)), /committed command/);
});
test("configuration references and actual selection cannot change through an unrelated transaction", () => {
  const before = parseSession(seed());
  assert.throws(() => assertSessionTransition(before, parseSession({ ...seed(), configuration: { ...seed().configuration, workspace: "/another" } })), /configuration reference/);
  assert.throws(() => assertSessionTransition(before, parseSession({ ...seed(), selection: { harnessId: "bravo", controlId: "bravo-acp" } })), /effective switch epoch/);
});
test("blocking is valid but implicit reopening is not a recovery procedure", () => {
  const open = parseSession(seed()), blocked = parseSession({ ...seed(), status: "blocked" });
  assertSessionTransition(open, blocked);
  assert.throws(() => assertSessionTransition(blocked, open), /cannot reopen/);
});

test("Provider target is a v2 public reference with immutable dispatched selection", () => {
  const state = seed(), target = { providerId: "provider-11111111-1111-4111-8111-111111111111", revision: 1, model: "model-a" };
  const current = parseSession({ ...state, selection: { ...selection, provider: target } });
  assert.deepEqual(current.selection.provider, target);
  assert.throws(() => parseSession({ ...state, schemaVersion: 1, selection: { ...selection, provider: target } }), /legacy/);
  assert.throws(() => parseSession({ ...state, selection: { ...selection, provider: { ...target, apiKey: "not-public" } } }), /unknown Provider/);
  assert.throws(() => assertSessionTransition(current, { ...current, selection }), /selection can change/);
  assert.throws(() => assertSessionTransition(current, { ...current, runs: [{ ...current.runs[0]!, selection: { ...selection, provider: target } }, current.runs[1]!] }), /terminal Run/);
});
