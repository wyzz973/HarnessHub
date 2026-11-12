import assert from "node:assert/strict";
import test from "node:test";
import { commandId, sessionId, SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import type { Conversation, ConversationRun, HeldItem, ItemFields } from "../../src/contracts/conversation.js";
import { assertConversationTransition, heldItems, recoverConversation } from "../../src/contexts/session/domain/conversation-state.js";
import { originToRows } from "../../src/contexts/session/domain/store-conversion.js";
import { carriedNativeConfiguration, replayCommand } from "../../src/contexts/session/domain/state.js";
import { parseSession } from "../../src/infrastructure/session/legacy/state.js";

// The rules about a conversation's state. What the frozen whole-snapshot parser (infrastructure/session/legacy/state.ts, the only one since the cut) accepts and refuses
// is its contract with the old data and is held here as it was; the replay of a command, the native values a session changed itself, the recovery of a conversation and the
// rules of who may change what (conversation-state.ts) are the live ones, read over the Runtime's shape of a conversation. What the tables' own keys and triggers refuse
// (history taken away, a terminal Run or a committed command rewritten, a Run's accepted input) is tests/integration/schema-v14.test.ts's.

/** A snapshot as the Runtime holds it: the head and a light row for each Run (what the rules read). */
function conv(snapshot: SessionSnapshot): Conversation {
  const { schemaVersion: _version, runs, messages, origin, ...head } = snapshot;
  return { ...head, format: 14, ...(origin === undefined ? {} : { origin: originToRows(snapshot.id, origin, 0).stored }),
    runs: runs.map(({ input: _input, thinking: _thinking, tools: _tools, plan: _plan, notices: _notices, activities: _activities, outputs: _outputs, protocol: _protocol, protocolProblem: _problem, ...light }, ordinal): ConversationRun =>
      ({ ...light, ordinal, userSeq: messages.find(message => message.id === light.userMessageId)?.seq ?? 0, isCommand: false })) };
}
const transition = (before: SessionSnapshot, after: SessionSnapshot, events: readonly { type: string; data: Record<string, unknown> }[] = []): void => assertConversationTransition(conv(before), conv(after), events);

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
test("Run timing is bounded, ordered and exists only from Session v10", () => {
  const state = seed(), run = state.runs[0]!;
  const timed = (timing: unknown, schemaVersion = 10) => ({ ...state, schemaVersion, runs: [{ ...run, timing }, ...state.runs.slice(1)] });
  assert.deepEqual(parseSession(timed({ acceptedAt: 10, preparingAt: 12, dispatchedAt: 15, endedAt: 15 })).runs[0]?.timing, { acceptedAt: 10, preparingAt: 12, dispatchedAt: 15, endedAt: 15 });
  for (const value of [{ acceptedAt: 10, readyAt: 9 }, { acceptedAt: 10, preparingAt: 20, readyAt: 15 }, { acceptedAt: 10, private: 11 }, { preparingAt: 10 }, { acceptedAt: -1 }, { acceptedAt: 1.5 }, { acceptedAt: 9e15 }])
    assert.throws(() => parseSession(timed(value)), SessionError);
  assert.throws(() => parseSession(timed({ acceptedAt: 10 }, 9)), /requires Session v10/u);
});
test("unknown schemas, properties and inconsistent public ownership are rejected", () => {
  const state = seed();
  assert.equal(parseSession({ ...state, schemaVersion: 3 }).schemaVersion, 3);
  for (const value of [null, {}, { ...state, schemaVersion: 14 }, { ...state, secret: "not-a-field" },
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
  const recovery = recoverConversation(conv(queued)); assert.ok(recovery); assert.equal(recovery.next.runs[0]?.status, "completed");
  assert.equal(recovery.next.runs[1]?.status, "cancelled"); assert.equal(recovery.events[0]?.data.replayed, false);
});

test("configuration references and actual selection cannot change through an unrelated transaction", () => {
  const before = parseSession(seed());
  assert.throws(() => transition(before, parseSession({ ...seed(), configuration: { ...seed().configuration, workspace: "/another" } })), /configuration reference/);
  assert.throws(() => transition(before, parseSession({ ...seed(), selection: { harnessId: "bravo", controlId: "bravo-acp" } })), /effective switch epoch/);
});
test("blocking is valid but implicit reopening is not a recovery procedure", () => {
  const open = parseSession(seed()), blocked = parseSession({ ...seed(), status: "blocked" });
  transition(open, blocked);
  assert.throws(() => transition(blocked, open), /cannot reopen/);
});

test("Provider target is a v2 public reference with immutable dispatched selection", () => {
  const state = seed(), target = { providerId: "provider-11111111-1111-4111-8111-111111111111", revision: 1, model: "model-a" };
  const current = parseSession({ ...state, selection: { ...selection, provider: target } });
  assert.deepEqual(current.selection.provider, target);
  assert.throws(() => parseSession({ ...state, schemaVersion: 1, selection: { ...selection, provider: target } }), /legacy/);
  assert.throws(() => parseSession({ ...state, selection: { ...selection, provider: { ...target, apiKey: "not-public" } } }), /unknown Provider/);
  assert.throws(() => transition(current, { ...current, selection }), /selection can change/);
});

test("v7 attachments are bounded, unique, canonical references", () => {
  const ref = (id: string, bytes = 10) => ({ id, name: id + ".png", mediaType: "image/png", kind: "image", bytes, sha256: "b".repeat(64) });
  const base = seed(), state = { ...base, schemaVersion: 7, runs: [{ ...base.runs[0]!, attachments: [ref("content-a"), ref("content-b")] }, base.runs[1]!] };
  assert.deepEqual(parseSession(state).runs[0]?.attachments?.map(item => item.id), ["content-a", "content-b"]);
  const variant = (attachments: unknown, schemaVersion = 7) => ({ ...state, schemaVersion, runs: [{ ...state.runs[0]!, attachments }, state.runs[1]!] });
  for (const value of [variant([]), variant([ref("content-a"), ref("content-a")]), variant(Array.from({ length: 9 }, (_, index) => ref("content-" + index))),
    variant([ref("content-a", 20 * 1024 * 1024), ref("content-b", 20 * 1024 * 1024)]), variant([{ ...ref("content-a"), path: "/private" }]), variant([ref("content-a")], 6)])
    assert.throws(() => parseSession(value), SessionError);
});
test("v8 branch origins are bounded quoted history and native fork references advance only along the fork path", () => {
  const base = seed(), origin = { kind: "fork", sessionId: "session-source", throughRunId: "run-source", history: [{ role: "user", text: "earlier", status: "completed" }, { role: "assistant", text: "reply", status: "completed", harnessId: "alpha" }] };
  const binding = (status: string, checkpoint = "native-source") => ({ harnessId: "alpha", controlId: "alpha-acp", checkpoint, throughRunId: null, status });
  const state = { ...base, schemaVersion: 8, origin, nativeBindings: [binding("fork-pending")] };
  assert.deepEqual(parseSession(state).origin, origin);
  for (const value of [{ ...state, schemaVersion: 7 }, { ...state, origin: undefined }, { ...state, origin: { ...origin, kind: "copy" } }, { ...state, origin: { ...origin, sessionId: state.id } },
    { ...state, origin: { ...origin, history: [{ role: "assistant", text: "x", status: "completed", attachments: [] }] } }, { ...state, nativeBindings: [{ ...binding("forking"), throughRunId: "run-one" }] }])
    assert.throws(() => parseSession(value), SessionError);
  const step = (from: string, to: string, checkpoint?: string) => () => transition(parseSession({ ...state, nativeBindings: [binding(from)] }), parseSession({ ...state, version: state.version + 1, nativeBindings: [binding(to, checkpoint)] }));
  step("fork-pending", "forking")(); step("forking", "ready", "native-copy")(); step("fork-pending", "archived")(); step("forking", "archived")();
  for (const invalid of [step("fork-pending", "ready", "native-copy"), step("fork-pending", "forking", "native-other"), step("forking", "archived", "native-copy"), step("ready", "forking")])
    assert.throws(invalid, (error: unknown) => error instanceof SessionError && error.code === "INVALID_TRANSITION");
  assert.throws(() => transition(parseSession(state), parseSession({ ...state, version: state.version + 1, origin: { ...origin, throughRunId: "run-other" } })), /branch origin is immutable/u);
});
test("v9 bindings keep what the native session reported, and only a same-epoch change of a requested value is carried", () => {
  const base = seed(), chosen = { ...selection, nativeModel: "model-a", nativeOptions: { effort: "low" } };
  const ready = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-one", throughRunId: "run-two", status: "ready", observed: { model: "model-b", options: { effort: "high", mode: "plan" } } };
  const state = { ...base, schemaVersion: 9, selection: chosen, runs: base.runs.map(row => ({ ...row, selection: chosen })), nativeBindings: [ready] };
  const parsed = parseSession(state); assert.deepEqual(parsed.nativeBindings?.[0]?.observed, ready.observed);
  const observed = (value: unknown) => ({ ...state, nativeBindings: [{ ...ready, observed: value }] });
  for (const value of [{ ...state, schemaVersion: 8 }, observed({ model: "x\n", options: {} }), observed({ model: "", options: {} }), observed({ model: null, options: { "bad key": "x" } }),
    observed({ model: null }), observed({ model: null, options: {}, extra: 1 }), observed({ model: null, options: { effort: "" } }), observed(null)])
    assert.throws(() => parseSession(value), SessionError);
  // A requested value the native session changed is carried as it is now; a value the selection does not request is left to the Harness.
  assert.deepEqual(carriedNativeConfiguration(parsed, parsed.selection, 1), { model: "model-b", options: { effort: "high" } });
  // An effective switch (a later epoch), a managed Provider, an unreported model, an unchanged value or a binding without a finished Turn carry nothing.
  assert.equal(carriedNativeConfiguration(parsed, parsed.selection, 2), null);
  assert.equal(carriedNativeConfiguration(parsed, { harnessId: "alpha", controlId: "alpha-acp", provider: { providerId: "provider-fixture", revision: 1, model: "m" } } as typeof parsed.selection, 1), null);
  const unchanged = parseSession(observed({ model: null, options: { effort: "low", mode: "plan" } }));
  assert.equal(carriedNativeConfiguration(unchanged, unchanged.selection, 1), null);
  const elsewhere = { harnessId: "beta", controlId: "beta-acp" };
  const fresh = parseSession({ ...state, runs: state.runs.map(row => ({ ...row, selection: elsewhere })), nativeBindings: [{ ...ready, throughRunId: null }] });
  assert.equal(carriedNativeConfiguration(fresh, fresh.selection, 1), null);
  // The last Turn is the last one dispatched to the binding's Harness, not the binding's native position: a command Turn that
  // owed facts leaves the position behind, and what it changed is still carried (ADR-055 §7.6).
  const behind = parseSession({ ...state, nativeBindings: [{ ...ready, throughRunId: "run-one" }] });
  assert.deepEqual(carriedNativeConfiguration(behind, behind.selection, 1), { model: "model-b", options: { effort: "high" } });
  const later = parseSession({ ...state, runs: state.runs.map(row => row.id === "run-two" ? { ...row, epoch: 2 } : row), epoch: 2,
    switches: [{ id: "switch-one", commandId: "switch-one", requested: { harnessId: "alpha" }, requestedSeq: 3, target: chosen, status: "effective", throughSeq: 3, sourceRunIds: ["run-one"], error: null }],
    commands: [...state.commands, { id: "switch-one", kind: "switch", fingerprint, resultId: "switch-one" }], nativeBindings: [{ ...ready, throughRunId: "run-one" }] });
  assert.deepEqual(carriedNativeConfiguration(later, later.selection, 2), { model: "model-b", options: { effort: "high" } });
  assert.equal(carriedNativeConfiguration(later, later.selection, 1), null);
  // Only the Run that owns the native session may record what it reported.
  assert.throws(() => transition(parsed, parseSession({ ...state, version: state.version + 1, nativeBindings: [{ ...ready, observed: { model: null, options: {} } }] })),
    (error: unknown) => error instanceof SessionError && error.code === "INVALID_TRANSITION");
});
test("v9 continued native sessions quote bounded history and keep the reference they were imported with", () => {
  const base = seed();
  const imported = { kind: "import", harnessId: "alpha", title: "Earlier work", omitted: 3, complete: false, historyRead: true,
    history: [{ role: "user", text: "q", status: "completed" }, { role: "assistant", text: "a", status: "completed", harnessId: "alpha" }] };
  const binding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-a", throughRunId: null, status: "ready" };
  const state = { ...base, schemaVersion: 9, origin: imported, nativeBindings: [binding] };
  assert.deepEqual(parseSession(state).origin, imported);
  for (const value of [{ ...state, schemaVersion: 8 }, { ...state, nativeBindings: undefined }, { ...state, nativeBindings: [{ ...binding, harnessId: "bravo", controlId: "bravo-acp" }] },
    { ...state, origin: { ...imported, harnessId: "Bad" } }, { ...state, origin: { ...imported, title: "a\nb" } }, { ...state, origin: { ...imported, historyRead: false } },
    { ...state, origin: { ...imported, history: [], historyRead: false, complete: true } }, { ...state, origin: { ...imported, omitted: -1 } }, { ...state, origin: { ...imported, extra: 1 } },
    { ...state, origin: { ...imported, sessionId: "session-x" } }, { ...state, nativeBindings: [{ ...binding, status: "fork-pending" }] }])
    assert.throws(() => parseSession(value), SessionError);
  // An unread history quotes nothing and is never complete; the origin stays immutable.
  assert.equal(parseSession({ ...state, origin: { ...imported, history: [], historyRead: false, complete: false } }).origin?.kind, "import");
  assert.throws(() => transition(parseSession(state), parseSession({ ...state, version: state.version + 1, origin: { ...imported, title: "renamed" } })), /origin is immutable/u);
});

test("a conversation keeps its native process only from Session v11, through the completed Run that handed it over", () => {
  const state = seed(), [one, two] = state.runs as ReturnType<typeof run>[];
  const handed = { ...two!, cleanup: null, retained: true };
  const kept = (extra: Record<string, unknown>, schemaVersion = 11) => ({ ...state, schemaVersion, runs: [one, handed], retainNative: true,
    retained: { harnessId: selection.harnessId, controlId: selection.controlId, runId: handed.id, since: 5 }, ...extra });
  const valid = parseSession(kept({}));
  assert.equal(valid.retainNative, true); assert.equal(valid.runs[1]?.retained, true); assert.equal(valid.retained?.runId, handed.id);
  // The native session is ready through that Run even though the Run did not close the process itself.
  const ready = { harnessId: selection.harnessId, controlId: selection.controlId, checkpoint: "native-1", throughRunId: handed.id, status: "ready" };
  assert.equal(parseSession(kept({ nativeBindings: [ready] })).nativeBindings?.[0]?.status, "ready");
  assert.throws(() => parseSession({ ...state, schemaVersion: 11, nativeBindings: [{ ...ready, throughRunId: two!.id }], runs: [one, { ...two!, cleanup: null }] }), /cleanup evidence/u);
  for (const invalid of [kept({}, 10), { ...state, schemaVersion: 10, retainNative: true }, kept({ retainNative: false }),
    kept({ runs: [one, { ...handed, status: "failed" }] }), kept({ runs: [one, { ...handed, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null } }] }),
    kept({ runs: [one, { ...handed, retained: false }] }), kept({ retained: { harnessId: selection.harnessId, controlId: selection.controlId, runId: one!.id, since: 5 } }),
    kept({ retained: { harnessId: "other", controlId: selection.controlId, runId: handed.id, since: 5 } }), kept({ retained: { harnessId: selection.harnessId, controlId: selection.controlId, runId: handed.id, since: 0 } }),
    kept({ commands: [...state.commands, { id: "retention-1", kind: "retention", fingerprint, resultId: "session-unit" }] }, 10)])
    assert.throws(() => parseSession(invalid), SessionError);
  // Recovery leaves a previous owner's kept process recorded: the new owner's runtime recognizes and ends it (ADR-030).
  assert.equal(recoverConversation(conv(valid)), null);
  // From v12 the record also says how to recognize the process group once its owner ended.
  const identified = { harnessId: selection.harnessId, controlId: selection.controlId, runId: handed.id, since: 5, process: { group: 4242, startedAt: "1791741701" } };
  assert.equal(parseSession(kept({ retained: identified }, 12)).retained?.process?.group, 4242);
  assert.throws(() => parseSession(kept({ retained: identified })), /requires Session v12/u);
  for (const process of [{ group: 1, startedAt: "1" }, { group: 4242 }, { group: 4242, startedAt: "" }, { group: 4242, startedAt: "x", pid: 1 }])
    assert.throws(() => parseSession(kept({ retained: { ...identified, process } }, 12)), SessionError);
});

test("the items a commit gives a Run keep what the store wrote into the ones it replaces: an unchanged item is the very object, a changed one keeps the event that made it", () => {
  const item = (seq: number, patch: Partial<HeldItem> = {}): HeldItem => ({ runId: "run-held" as HeldItem["runId"], seq, itemId: "tool:" + seq, type: "tool", status: "completed", startedAt: 1, endedAt: 2, parentId: null, createdSeq: null,
    textBytes: 0, textChunks: 0, fields: { type: "tool", native: { title: "t" + seq } } as unknown as ItemFields, text: [], ...patch });
  const held = [item(1, { createdSeq: 5 }), item(2, { createdSeq: 6, status: "running", endedAt: null })];
  // The Turn's version of them, which knows nothing of the events: the first as it was, the second finished, and a third that is new.
  const turn = [{ ...held[0]!, createdSeq: null }, { ...held[1]!, status: "completed" as const, endedAt: 9, createdSeq: null }, item(3)];
  const merged = heldItems(held, turn);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], held[0], "nothing changed: the object the conversation holds, so that the next comparison passes it by identity");
  assert.deepEqual(merged[1], { ...turn[1], createdSeq: 6 }, "a change is the Turn's, with the event that made the item");
  assert.equal(merged[2], turn[2], "a new item is the Turn's");
  assert.equal(heldItems(undefined, turn), turn, "a Run that held none takes the Turn's");
  assert.equal(heldItems([], turn), turn);
  // Text that grew is a change too (the chunks are the Turn's), and the item keeps its event.
  const grown = [{ ...held[0]!, createdSeq: null, textBytes: 3, textChunks: 1, text: ["abc"] }];
  assert.deepEqual(heldItems(held.slice(0, 1), grown), [{ ...grown[0]!, createdSeq: 5 }]);
});
