import assert from "node:assert/strict";
import test from "node:test";
import { decodeHead, decodeItem, decodeItemTextView, decodeItemView, decodeRunItemsPageView, decodeSessionListView, decodeSessionStreamFrameV14, decodeSessionViewV14, decodeTurnPageView, decodeWireRun, WireError } from "../../web/src/lib/protocol/wire.js";

// What the page reads of a conversation kept as rows (web/src/lib/protocol/wire.ts): the shapes of the routes and of the stream, read field by field; an item it does not know is kept as a
// line saying so; a Turn it cannot read is kept as a Run with the reason; and no bound of the Gateway's is repeated here — a list, a text or a number is as long as the Gateway sent it.

const selection = { harnessId: "alpha", controlId: "alpha-acp" };
const header = (n: number, over: Record<string, unknown> = {}) => ({ version: "hh/1", runId: "run-" + n, n, status: "completed", stopReason: "end_turn", executor: { harnessId: "alpha", harness: "alpha" }, usage: { completeness: "unavailable" }, ...over });
const run = (ordinal: number, over: Record<string, unknown> = {}) => ({ id: "run-" + ordinal, commandId: "command-" + ordinal, userMessageId: "message-user-" + ordinal, assistantMessageId: "message-reply-" + ordinal, selection, epoch: 1, status: "completed",
  cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: { status: "completed", reason: "end_turn" }, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, ordinal, userSeq: 2 + ordinal, turn: header(ordinal + 1), ...over });
const head = (over: Record<string, unknown> = {}) => ({ id: "session-x", version: 3, lastSeq: 9, epoch: 1, status: "open", workspace: "/work", selection, activeRunId: null, pendingSwitchId: null, title: "hello", runCount: 1, ...over });
const user = { id: "user", seq: 1, status: "completed", type: "user_message", messageId: "message-user-0", text: "你好" };
const view = (turns: unknown[], older: string | null = null, over: Record<string, unknown> = {}) => ({ head: head(over), window: { turns, older } });

test("a conversation read as its head and a window of Turns is read whole: the head's fields, the Run's facts with its Turn's header, the items with their words", () => {
  const read = decodeSessionViewV14(view([{ run: run(0), items: [user, { id: "text:1", seq: 2, status: "completed", type: "assistant_message", messageId: "message-reply-0", phase: "final", text: "hi" }] }], "abc",
    { origin: { kind: "import", harnessId: "alpha", title: null, omitted: 2, complete: false, historyRead: true, history: [{ role: "user", text: "q", status: "completed" }] },
      nativeStates: [{ harnessId: "alpha", controlId: "alpha-acp", status: "ready", observed: { model: "m", options: { a: "b" } }, carried: { model: "n" } }], queue: { kind: "slot", runId: "run-9", running: 1, limit: 1, since: 4 },
      retention: { enabled: true, process: null, outside: { count: 2, at: 5 } }, permissions: [{ id: "p", runId: "run-0", title: "t", decided: false, requestedAt: 1, options: [{ id: "y", name: "Yes" }] }],
      pendingSwitch: { id: "switch-1", commandId: "command-s", requested: { harnessId: "bravo", nativeModel: "x" }, requestedSeq: 4, target: null, status: "requested", throughSeq: 0, sourceRunIds: ["run-0"], error: null } }));
  assert.equal(read.head.title, "hello"); assert.equal(read.head.nativeStates![0]!.carried!.model, "n"); assert.equal(read.head.origin!.kind, "import"); assert.equal(read.head.pendingSwitch!.requested.harnessId, "bravo");
  assert.equal(read.window.older, "abc");
  const turn = read.window.turns[0]!;
  assert.equal(turn.run.ordinal, 0); assert.equal(turn.run.turn!.n, 1); assert.equal(turn.run.protocolProblem, undefined);
  assert.deepEqual(turn.items.map(item => [item.type, item.seq, (item as { text?: string }).text]), [["user_message", 1, "你好"], ["assistant_message", 2, "hi"]]);
});

test("a Gateway that says more than this page knows is read: a field it does not know is left, an item of a type it does not know is kept as a line saying so, never dropped and never a failure", () => {
  const strange = { id: "future:1", seq: 3, status: "completed", type: "hologram", parentId: "tool:a", nativeName: "holo", payload: { big: true } };
  const broken = { id: "tool:b", seq: 4, status: "completed", type: "command" };       // a command with no command
  const stateless = { id: "tool:c", seq: 5, status: "teleporting", type: "tool", name: "x" };   // a state the page has no word for
  const nothing = "not even an object";
  const read = decodeSessionViewV14(view([{ run: run(0, { futureField: 1 }), items: [user, strange, broken, stateless, nothing] }], null, { newField: [1, 2] }));
  const items = read.window.turns[0]!.items;
  assert.deepEqual(items.map(item => item.type), ["user_message", "unrecognized", "unrecognized", "unrecognized", "unrecognized"]);
  assert.deepEqual(items[1], { id: "future:1", seq: 3, status: "completed", type: "unrecognized", nativeType: "hologram", parentId: "tool:a", nativeName: "holo" });
  assert.deepEqual([items[2]!.id, items[2]!.seq, items[2]!.status, (items[2] as { nativeType?: string }).nativeType], ["tool:b", 4, "completed", "command"]);
  assert.equal(items[3]!.status, "unknown", "a state this page does not know is never completed");
  assert.deepEqual([items[4]!.id, items[4]!.seq, items[4]!.status, (items[4] as { nativeType?: string }).nativeType], ["item-4", 4, "unknown", ""]);
});

test("a Turn whose header cannot be read stays as a Run with the reason; the conversation is not lost for it", () => {
  const read = decodeSessionViewV14(view([{ run: run(0, { turn: header(1, { version: "hh/9" }) }), items: [user] }, { run: run(1, { turn: undefined }), items: [] }, { run: run(2, { turn: header(3, { status: "dreaming" }) }), items: [] },
    { run: run(3, { turn: header(4, { usage: "gibberish", stopReason: "a-new-reason" }) }), items: [] }]));
  const [wrongVersion, none, wrongState, lenient] = read.window.turns;
  assert.match(wrongVersion!.run.protocolProblem!, /hh\/9/u); assert.equal(wrongVersion!.run.turn, undefined); assert.equal(wrongVersion!.items.length, 1);
  assert.ok(none!.run.protocolProblem!.length > 0); assert.ok(wrongState!.run.protocolProblem!.length > 0);
  // A usage it cannot read is "unavailable" and a stop reason it does not know is "unknown": the Turn is still a Turn.
  assert.deepEqual([lenient!.run.turn!.usage, lenient!.run.turn!.stopReason, lenient!.run.protocolProblem], [{ completeness: "unavailable" }, "unknown", undefined]);
});

test("nothing is bounded: a plan of thousands of steps, a change of thousands of files, a thought of megabytes, a Run that carries thousands of sources, a head with hundreds of requests and options", () => {
  const steps = Array.from({ length: 10_000 }, (_, index) => ({ text: "step " + index, status: "pending", priority: "high" }));
  const changes = Array.from({ length: 20_000 }, (_, index) => ({ path: "/w/f" + index + ".ts", op: "modify", added: index, removed: 1 }));
  const thought = "x".repeat(8 * 1024 * 1024), runs = Array.from({ length: 30_000 }, (_, index) => "run-" + index);
  const options = Object.fromEntries(Array.from({ length: 500 }, (_, index) => ["option" + index, "value ".repeat(400)]));
  const read = decodeSessionViewV14(view([{ run: run(0, { sourceRunIds: runs, attachments: Array.from({ length: 40 }, (_, index) => ({ id: "content-a" + index, name: "a" + index + ".txt", mediaType: "text/plain", kind: "file", bytes: 3, sha256: "0".repeat(64) })), selection: { ...selection, nativeOptions: options } }),
    items: [user, { id: "plan", seq: 2, status: "completed", type: "plan", steps }, { id: "tool:e", seq: 3, status: "completed", type: "file_change", changes }, { id: "think:1", seq: 4, status: "completed", type: "reasoning", text: thought }] }], null,
    { permissions: Array.from({ length: 300 }, (_, index) => ({ id: "p" + index, runId: "run-0", title: "t", decided: false, requestedAt: 1, options: Array.from({ length: 300 }, (_, at) => ({ id: "o" + at, name: "n" + at })) })),
      nativeStates: Array.from({ length: 500 }, (_, index) => ({ harnessId: "h" + index, controlId: "c", status: "ready" })), origin: { kind: "fork", sessionId: "session-src", throughRunId: "run-0", history: Array.from({ length: 5000 }, () => ({ role: "user", text: "q", status: "completed" })) } }));
  const turn = read.window.turns[0]!;
  assert.equal(turn.run.sourceRunIds.length, 30_000); assert.equal(turn.run.attachments!.length, 40); assert.equal(Object.keys(turn.run.selection.nativeOptions!).length, 500);
  assert.equal((turn.items[1] as unknown as { steps: unknown[] }).steps.length, 10_000); assert.equal((turn.items[2] as unknown as { changes: unknown[] }).changes.length, 20_000); assert.equal((turn.items[3] as unknown as { text: string }).text.length, 8 * 1024 * 1024);
  assert.equal(read.head.permissions!.length, 300); assert.equal(read.head.permissions![0]!.options.length, 300); assert.equal(read.head.nativeStates!.length, 500); assert.equal(read.head.origin!.history.length, 5000);
  // And a conversation with ten thousand Turns in a page, or a list of ten thousand conversations.
  assert.equal(decodeTurnPageView({ turns: Array.from({ length: 10_000 }, (_, index) => ({ run: run(index), items: [] })), older: null }).turns.length, 10_000);
  assert.equal(decodeSessionListView({ sessions: Array.from({ length: 10_000 }, (_, index) => ({ id: "session-" + index, title: "t", status: "open", workspace: "/w", selection, updatedSeq: 1, activeRunId: null })), next: null }).sessions.length, 10_000);
});

test("the other answers: a page of items, one item, a range of text, a list of conversations", () => {
  assert.deepEqual(decodeRunItemsPageView({ items: [user], next: 4 }), { items: [user], next: 4 }); assert.equal(decodeRunItemsPageView({ items: [], next: null }).next, null);
  assert.deepEqual(decodeItemView({ item: user }), { item: user }); assert.equal(decodeItemView({ item: { type: "later" } }).item.type, "unrecognized");
  assert.deepEqual(decodeItemTextView({ text: "你好", from: 0, to: 6, total: 6 }), { text: "你好", from: 0, to: 6, total: 6 });
  assert.throws(() => decodeItemTextView({ text: "x", from: 5, to: 4, total: 9 }), WireError); assert.throws(() => decodeItemTextView({ text: "x", from: 0, to: 10, total: 9 }), WireError);
  const list = decodeSessionListView({ sessions: [{ id: "session-a", title: "A", status: "closed", workspace: "/w", selection, updatedSeq: 3, activeRunId: "run-1" }], next: "cursor" });
  assert.deepEqual([list.sessions[0]!.status, list.sessions[0]!.activeRunId, list.next], ["closed", "run-1", "cursor"]);
});

test("a frame of the stream: a snapshot, a commit with what it carries, a relay notice; what is not one of them is refused", () => {
  const snapshot = decodeSessionStreamFrameV14({ type: "snapshot", session: view([]) });
  assert.equal(snapshot.type, "snapshot");
  const commit = decodeSessionStreamFrameV14({ type: "commit", sessionId: "session-x", version: 4, lastSeq: 10, head: head({ version: 4, lastSeq: 10 }), runs: [run(1)], items: [{ runId: "run-1", item: { id: "future", seq: 1, status: "running", type: "later" } }],
    texts: [{ runId: "run-1", itemSeq: 2, from: 6, text: "", omittedBytes: 99 }, { runId: "run-1", itemSeq: 3, from: 0, text: "hi" }] });
  assert.equal(commit.type, "commit"); if (commit.type !== "commit") return;
  assert.equal(commit.items![0]!.item.type, "unrecognized"); assert.deepEqual(commit.texts, [{ runId: "run-1", itemSeq: 2, from: 6, text: "", omittedBytes: 99 }, { runId: "run-1", itemSeq: 3, from: 0, text: "hi" }]);
  const bare = decodeSessionStreamFrameV14({ type: "commit", sessionId: "session-x", version: 5, lastSeq: 11 });
  assert.deepEqual(bare, { type: "commit", sessionId: "session-x", version: 5, lastSeq: 11 });
  const notice = decodeSessionStreamFrameV14({ type: "relay", sessionId: "session-x", version: 5, lastSeq: 11, event: { type: "relay.input_recorded", sessionId: "session-x", at: 7 } });
  assert.equal(notice.type, "relay");
  for (const bad of [null, "x", [], {}, { type: "message" }, { type: "commit", sessionId: "session-x", version: -1, lastSeq: 3 }, { type: "commit", sessionId: "session-x", version: 1 }, { type: "commit", sessionId: "session-x", version: 1.5, lastSeq: 3 },
    { type: "commit", sessionId: "session-x", version: 1, lastSeq: 3, texts: [{ runId: "run-1", itemSeq: 2, from: -1, text: "" }] }, { type: "relay", sessionId: "session-x", version: 1, lastSeq: 3, event: null }, { type: "snapshot", session: { head: head(), window: null } }]) {
    assert.throws(() => decodeSessionStreamFrameV14(bad), WireError, JSON.stringify(bad));
  }
});

test("a head or a Run that lacks what the page cannot draw without is a failure of the wire, told as one, and never a partly read value", () => {
  assert.throws(() => decodeHead({ ...head(), id: undefined }), WireError); assert.throws(() => decodeHead({ ...head(), status: "dreaming" }), WireError); assert.throws(() => decodeHead({ ...head(), lastSeq: "9" }), WireError);
  assert.throws(() => decodeWireRun({ ...run(0), id: undefined }), WireError); assert.throws(() => decodeWireRun({ ...run(0), status: "dreaming" }), WireError); assert.throws(() => decodeWireRun({ ...run(0), sourceRunIds: "run-1" }), WireError);
  assert.throws(() => decodeSessionViewV14({ head: head() }), WireError);
  assert.equal(decodeItem({ id: "user", seq: 1, status: "completed", type: "user_message", messageId: "message-user-0" }).type, "user_message", "a message whose words are not carried (left out for its size) is a message");
  const left = decodeItem({ id: "text:1", seq: 2, status: "completed", type: "assistant_message", messageId: "message-reply-0", phase: "final", bodyOmitted: true, textBytes: 70000 });
  assert.deepEqual([left.type, left.bodyOmitted, left.textBytes], ["assistant_message", true, 70000]);
});
