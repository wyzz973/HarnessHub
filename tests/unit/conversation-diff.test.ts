import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, ConversationRun } from "../../src/contracts/conversation.js";
import { SessionError, switchId, type PublicSwitch } from "../../src/contracts/session.js";
import { diffConversation } from "../../src/infrastructure/session/diff.js";
import { NOW, SESSION, conversation, event, replyItem, run, sendCommand, switchCommand, toolItem, userItem, reduce, replaceRun } from "../fixtures/conversation-builder.js";

// diffConversation is pure: it compares two Conversations and makes the Mutation that writes the difference. These cases need no database.

const context = { title: "t", updatedAt: NOW };
const finished = (ordinal: number): ConversationRun => run(ordinal, "completed", undefined, { endedSeq: 10 + ordinal, backend: { status: "completed", reason: "done" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null } });
const transition = (message: RegExp) => (error: unknown): boolean => error instanceof SessionError && error.code === "INVALID_TRANSITION" && message.test(error.message);

test("a new conversation: the head first at version 0 with the cursor after its events, everything else inserted, the input and the end placed by their events", () => {
  const first = run(0, "queued", [userItem("run-0", "hi")]);
  const next = conversation([first]);
  const mutation = diffConversation(null, next, { ...context, events: [event("session.created"), event("message.accepted", { runId: "run-0" })] });
  assert.deepEqual(mutation.head!.row, { id: SESSION, version: 0, lastSeq: 2, format: 14, status: "open", epoch: 1, activeRunId: null, pendingSwitchId: null, kept: false, title: "t", runCount: 1, updatedAt: NOW, deletedAt: null, lastError: null,
    head: { configuration: next.configuration, selection: next.selection } });
  assert.deepEqual(mutation.commands!.map(row => [row.ordinal, row.command.kind]), [[0, "create"], [1, "send"]]);
  assert.deepEqual(mutation.runs!.map(write => [write.op, write.row.ordinal, write.userSeqByEvent, write.endedByEvent]), [["insert", 0, 1, undefined]]);
  assert.deepEqual(mutation.items!.map(write => [write.op, write.row.itemId, write.createdByEvent, write.row.textBytes]), [["insert", "user", 1, 0]]);
  assert.deepEqual(mutation.text, [{ runId: "run-0", itemSeq: 1, chunk: 0, text: "hi", byteOffset: 0 }]);
  assert.equal(mutation.events.length, 2);
});

test("a commit that changes nothing in the history writes the head and the events alone, whatever the history's length", () => {
  const history = Array.from({ length: 300 }, (_, ordinal) => finished(ordinal));
  const before = conversation(history, { version: 7, lastSeq: 40 });
  const mutation = diffConversation(before, { ...before, epoch: 1 }, { ...context, events: [event("noted")] });
  assert.deepEqual(Object.keys(mutation).sort(), ["events", "head"]);
  assert.equal(mutation.head!.row.version, 7); assert.equal(mutation.head!.row.lastSeq, 41);
});

test("a finished Run is not compared again: an equal copy writes nothing, and only its acknowledgement may change", () => {
  const unknown = run(0, "unknown", undefined, { endedSeq: 5, error: { code: "OWNER_ENDED", message: "ended" } });
  const before = conversation([unknown, finished(1)], { status: "blocked" });
  assert.equal(diffConversation(before, reduce(before, current => ({ runs: current.runs.map(entry => ({ ...entry })) })), { ...context, events: [event("noted")] }).runs, undefined);
  const acknowledged = diffConversation(before, reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, acknowledgedBy: switchId("switch-1") })) })), { ...context, events: [event("noted")] });
  assert.deepEqual(acknowledged.runs!.map(write => [write.op, write.row.acknowledgedBy]), [["update", "switch-1"]]);
  assert.throws(() => diffConversation(before, reduce(before, current => ({ runs: replaceRun(current, 1, entry => ({ ...entry, stopRequested: true })) })), { ...context, events: [event("x")] }), transition(/terminal Run evidence cannot be rewritten/u));
  assert.throws(() => diffConversation(before, reduce(before, current => ({ runs: replaceRun(current, 1, entry => ({ ...entry, status: "failed" as const })) })), { ...context, events: [event("x")] }), transition(/terminal Run evidence cannot be rewritten/u));
});

test("a Run that ends in a commit has its end placed by the event that ended it (run.ended, or the session.recovered that did)", () => {
  const working = run(0, "running", [userItem("run-0", "hi"), toolItem("run-0", 2, "t", "running")], { timing: { acceptedAt: NOW, dispatchedAt: NOW } });
  const before = conversation([working], { activeRunId: working.id });
  const ended = (status: "completed" | "unknown"): Conversation => reduce(before, current => ({ activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status, items: entry.items!.map(it => ({ ...it, status: it.status === "running" ? "unknown" as const : it.status })) })) }));
  const byEnded = diffConversation(before, ended("completed"), { ...context, events: [event("run.output"), event("run.ended", { runId: "run-0" })] });
  assert.deepEqual(byEnded.runs!.map(write => [write.op, write.endedByEvent]), [["update", 1]]);
  assert.deepEqual(byEnded.items!.map(write => [write.op, write.row.status]), [["update", "unknown"]]);
  const byRecovery = diffConversation(before, ended("unknown"), { ...context, events: [event("session.recovered", { unknownRunIds: ["run-0"], cancelledRunIds: [] })] });
  assert.equal(byRecovery.runs![0]!.endedByEvent, 0);
  const none = diffConversation(before, ended("completed"), { ...context, events: [event("something.else")] });
  assert.equal(none.runs![0]!.endedByEvent, undefined);
});

test("the item an event made: the user item by the Run's message.accepted, a lone event by default, with several events by the caller's rule or by none", () => {
  const before = conversation([run(0, "running", [userItem("run-0", "hi")], { timing: { acceptedAt: NOW, dispatchedAt: NOW } })]);
  const grown = (items: ConversationRun["items"]) => reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, items: [...entry.items!, ...items!] })) }));
  const one = diffConversation(before, grown([replyItem("run-0", 2, 1, "running", ["x"])]), { ...context, events: [event("run.output")] });
  assert.deepEqual(one.items!.map(write => write.createdByEvent), [0]);
  const many = diffConversation(before, grown([replyItem("run-0", 2, 1, "running", ["x"])]), { ...context, events: [event("run.output"), event("run.output")] });
  assert.deepEqual(many.items!.map(write => write.createdByEvent), [undefined]);
  const chosen = diffConversation(before, grown([replyItem("run-0", 2, 1, "running", ["x"])]), { ...context, events: [event("a"), event("b")], createdBy: () => 1 });
  assert.deepEqual(chosen.items!.map(write => write.createdByEvent), [1]);
});

test("what no commit may do is refused before anything is written: taking away a Run, a command, an item, a binding or a switch; rewriting a command; items out of place", () => {
  const working = run(0, "running", [userItem("run-0", "hi"), toolItem("run-0", 2, "t", "running"), toolItem("run-0", 3, "u", "running")], { timing: { acceptedAt: NOW, dispatchedAt: NOW } });
  const before = conversation([working, finished(1)], { nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "n", throughRunId: null, status: "ready", relay: { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false } }],
    switches: [{ id: switchId("switch-1"), commandId: switchCommand(1).id, requested: { harnessId: "beta" }, requestedSeq: 3, target: null, status: "requested", throughSeq: 0, sourceRunIds: [], error: null }] });
  const diff = (after: Conversation) => diffConversation(before, after, { ...context, events: [event("x")] });
  assert.throws(() => diff({ ...before, runs: before.runs.slice(0, 1) }), transition(/history of a conversation is kept/u));
  assert.throws(() => diff({ ...before, commands: before.commands.slice(0, 1) }), transition(/command was taken away/u));
  assert.throws(() => diff({ ...before, commands: [before.commands[0]!, { ...before.commands[1]!, resultId: "run-9" }, ...before.commands.slice(2)] }), transition(/never rewritten/u));
  assert.throws(() => diff({ ...before, nativeBindings: [] }), transition(/silently erased/u));
  assert.throws(() => diff({ ...before, switches: [] }), transition(/switch was taken away/u));
  assert.throws(() => diff(reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, items: entry.items!.filter(it => it.seq !== 2) })) }))), transition(/item 2 of run-0 was taken away/u));
  assert.throws(() => diff(reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, items: entry.items!.slice(0, 2) })) }))), transition(/item 3 of run-0 was taken away/u));
  assert.throws(() => diff(reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, items: [entry.items![0]!, entry.items![2]!, entry.items![1]!] })) }))), (error: unknown) => error instanceof SessionError && /was taken away|place order/u.test(error.message));
  // New items out of order among themselves.
  assert.throws(() => diff(reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, items: [...entry.items!, toolItem("run-0", 5, "v", "running"), toolItem("run-0", 4, "w", "running")] })) }))), (error: unknown) => error instanceof SessionError && /place order/u.test(error.message));
  assert.throws(() => diff(reduce(before, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, items: [entry.items![0]!, { ...entry.items![1]!, itemId: "tool:other" }, entry.items![2]!] })) }))), transition(/place and id never change/u));
  assert.throws(() => diff(reduce(before, current => ({ runs: [{ ...current.runs[0]!, ordinal: 5 }, current.runs[1]!] }))), (error: unknown) => error instanceof SessionError && /ordinal is its place/u.test(error.message));
});

test("a switch says, for showing, which Runs its sources were when they are exactly the first ones", () => {
  const before = conversation([finished(0), finished(1), finished(2)]);
  const request = (sourceRunIds: PublicSwitch["sourceRunIds"]): PublicSwitch => ({ id: switchId("switch-1"), commandId: switchCommand(1).id, requested: { harnessId: "beta" }, requestedSeq: 40, target: null, status: "requested", throughSeq: 0, sourceRunIds, error: null });
  const through = (sources: PublicSwitch["sourceRunIds"]) => diffConversation(before, reduce(before, current => ({ switches: [request(sources)], pendingSwitchId: switchId("switch-1"), commands: [...current.commands, switchCommand(1)] })), { ...context, events: [event("switch.requested")] }).switches![0]!.row.sourceThroughOrdinal;
  assert.equal(through([before.runs[0]!.id, before.runs[1]!.id]), 1);
  assert.equal(through([before.runs[0]!.id, before.runs[1]!.id, before.runs[2]!.id]), 2);
  assert.equal(through([before.runs[1]!.id]), null, "not a prefix");
  assert.equal(through([before.runs[0]!.id, before.runs[2]!.id]), null, "a Run skipped");
  assert.equal(through([]), null);
});

test("the head carries what the conversation holds: a kept native process, the origin, a recovery failure", () => {
  const next = conversation([], { retained: { harnessId: "alpha", controlId: "alpha-acp", runId: "run-0" as never, since: NOW }, retainNative: true, relayRecoveryFailed: 3,
    origin: { kind: "import", harnessId: "alpha", title: null, omitted: 0, complete: true, historyRead: true } });
  const row = diffConversation(null, next, { ...context, events: [event("session.created")] }).head!.row;
  assert.equal(row.kept, true);
  assert.deepEqual(Object.keys(row.head).sort(), ["configuration", "origin", "relayRecoveryFailed", "retainNative", "retained", "selection"]);
});

void sendCommand;
