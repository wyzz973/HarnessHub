import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE, type Conversation, type ConversationRun, type HeldItem, type Mutation, type RunRow } from "../../src/contracts/conversation.js";
import { SessionError } from "../../src/contracts/session.js";
import type { SessionHeadView, WireRun } from "../../src/contracts/web.js";
import { conversationRunOf } from "../../src/infrastructure/session/rows.js";
import { commitFrame, wireItem, wireItemOf, type FrameViews } from "../../src/web/commit-frame.js";
import { NOW, bytes, commit, conversation, event, item, openDatabase, reduce, replaceRun, replyItem, run, sendCommand, toolItem, userItem, type Env } from "../fixtures/conversation-builder.js";

// The frame of a commit (ADR-057 3.4, T6): one frame for everything a commit changed, made from the commit as it was written. The commits here are real
// (diff, write to a database, the Mutation as written); the Turn header of a Run is the display layer's, so a plain one stands in for it.

const views: FrameViews = {
  run: (row: RunRow): WireRun => {
    const { items: _items, ...rest } = conversationRunOf(row);
    return { ...rest, turn: { version: "hh/1", runId: row.runId, n: row.ordinal + 1, status: "running", executor: { harnessId: row.harnessId, harness: row.harnessId }, usage: { completeness: "unavailable" } } } as unknown as WireRun;
  },
};
const headView = (state: Conversation): SessionHeadView => ({ id: state.id, version: state.version, lastSeq: state.lastSeq, epoch: state.epoch, status: state.status, workspace: state.configuration.workspace, selection: state.selection,
  activeRunId: state.activeRunId, pendingSwitchId: state.pendingSwitchId, title: "t", runCount: state.runs.length });
const started = { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 };
/** A conversation whose first Turn is running, and the commits made on it. */
function running(env: Env): Conversation {
  const created = commit(env, null, conversation(), [event("session.created")]).conversation;
  const queued = commit(env, created, reduce(created, current => ({ runs: [run(0, "queued", [userItem("run-0", "hi")])], commands: [...current.commands, sendCommand(0)] })), [event("message.accepted", { runId: "run-0" })]).conversation;
  return commit(env, queued, reduce(queued, current => ({ activeRunId: queued.runs[0]!.id, runs: replaceRun(current, 0, entry => ({ ...entry, status: "running", timing: started })) })), [event("run.started")]).conversation;
}
const withItems = (state: Conversation, change: (items: readonly HeldItem[]) => readonly HeldItem[]): Conversation => reduce(state, current => ({ runs: replaceRun(current, 0, (entry: ConversationRun) => ({ ...entry, items: change(entry.items!) })) }));
const frameOf = (committed: { readonly conversation: Conversation; readonly applied: { readonly changes: Mutation } }) => commitFrame(committed.applied.changes, headView(committed.conversation), views);
const size = (value: unknown): number => bytes(JSON.stringify(value));

test("one commit is one frame: the head, the Run that changed with its header, the items that are new, the text that was appended, each chunk at the byte it starts at", t => {
  const env = openDatabase(t);
  const created = commit(env, null, conversation(), [event("session.created")]);
  const sent = commit(env, created.conversation, reduce(created.conversation, current => ({ runs: [run(0, "queued", [userItem("run-0", "你好 hi")])], commands: [...current.commands, sendCommand(0)] })), [event("message.accepted", { runId: "run-0" })]);
  const frame = frameOf(sent);
  assert.equal(frame.type, "commit"); assert.equal(frame.sessionId, sent.conversation.id); assert.equal(frame.version, sent.conversation.version); assert.equal(frame.lastSeq, sent.conversation.lastSeq);
  assert.deepEqual(frame.head, headView(sent.conversation));
  assert.deepEqual(frame.runs!.map(entry => [entry.id, entry.ordinal, entry.userSeq, entry.status, entry.turn.n]), [["run-0", 0, 2, "queued", 1]]);
  assert.deepEqual(frame.items, [{ runId: "run-0", item: { type: "user_message", messageId: "message-user-run-0", id: "user", seq: 1, status: "completed" } }]);
  assert.deepEqual(frame.texts, [{ runId: "run-0", itemSeq: 1, from: 0, text: "你好 hi" }]);
  // Streaming: a window of text is the head and a chunk, nothing else; the next chunk starts where the last ended, counted in bytes.
  const stream = openDatabase(t);
  let state = running(stream);
  state = commit(stream, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", ["Looking at "])]), [event("run.output")]).conversation;
  const first = commit(stream, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "the 文件 now. "] } : it)), [event("run.output")]);
  const second = commit(stream, first.conversation, withItems(first.conversation, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "😀 and more"] } : it)), [event("run.output")]);
  assert.deepEqual(Object.keys(frameOf(first)).sort(), ["head", "lastSeq", "sessionId", "texts", "type", "version"]);
  assert.deepEqual(frameOf(first).texts, [{ runId: "run-0", itemSeq: 2, from: bytes("Looking at "), text: "the 文件 now. " }]);
  assert.deepEqual(frameOf(second).texts, [{ runId: "run-0", itemSeq: 2, from: bytes("Looking at the 文件 now. "), text: "😀 and more" }]);
  assert.equal(frameOf(second).lastSeq, first.conversation.lastSeq + 1);
  // An item that changes without new text: its upsert, and no text.
  const tool = commit(stream, second.conversation, withItems(second.conversation, items => [...items, toolItem("run-0", 3, "t", "running")]), [event("run.output")]);
  const done = commit(stream, tool.conversation, withItems(tool.conversation, items => items.map(it => it.seq === 3 ? { ...it, status: "completed" as const, endedAt: NOW + 9, fields: { ...it.fields, exitCode: 0 } as typeof it.fields } : it)), [event("run.output")]);
  assert.deepEqual(frameOf(done).items, [{ runId: "run-0", item: { type: "command", command: "echo t", exitCode: 0, id: "tool:t", seq: 3, status: "completed", endedAt: NOW + 9 } }]);
  assert.equal(frameOf(done).texts, undefined); assert.equal(frameOf(done).runs, undefined);
});

test("the wire item: the Harness's own words stay home, an assistant segment has its phase, a reasoning segment and a notice have their text (empty: the text comes by chunk)", () => {
  const row = (type: string, fields: Record<string, unknown>, extra: Partial<HeldItem> = {}) => item("run-0", 4, "x:1", type as never, "running", fields, [], extra);
  assert.deepEqual(wireItem(row("command", { command: "ls", native: { title: "Run ls", kind: "execute", status: "in_progress" } })), { type: "command", command: "ls", id: "x:1", seq: 4, status: "running" });
  assert.equal((wireItem(row("assistant_message", { messageId: "m" })) as { phase?: string }).phase, "commentary");
  assert.equal((wireItem(row("assistant_message", { messageId: "m", phase: "final" })) as { phase?: string }).phase, "final");
  assert.equal((wireItem(row("reasoning", {})) as { text?: string }).text, ""); assert.equal((wireItem(row("notice", { severity: "info" })) as { text?: string }).text, "");
  assert.equal("text" in wireItem(row("user_message", { messageId: "m" })), false);
  const nested = wireItem(row("command", { command: "ls" }, { startedAt: 5, endedAt: 9, parentId: "tool:parent" }));
  assert.deepEqual([nested.startedAt, nested.endedAt, nested.parentId], [5, 9, "tool:parent"]);
  // An item of a page read: its text joined, or marked when the page left it out.
  assert.equal((wireItemOf(item("run-0", 2, "text:1", "assistant_message", "completed", { messageId: "m" }, ["a", "b"])) as { text?: string }).text, "ab");
  const leftOut = wireItemOf({ ...item("run-0", 2, "text:1", "assistant_message", "completed", { messageId: "m" }, [], { textBytes: 70_000 }), textOmitted: true });
  assert.deepEqual([leftOut.bodyOmitted, leftOut.textBytes, "text" in leftOut], [true, 70_000, false]);
  const stub = wireItemOf({ ...item("run-0", 3, "tool:edit", "file_change", "completed", { changes: [] }), bodyOmitted: true });
  assert.deepEqual([stub.bodyOmitted, (stub as { changes?: unknown[] }).changes], [true, []]);
});

test("a chunk longer than a frame carries is not sent: its item is marked, or a text entry says how many bytes went unsent; nothing after it in the frame is sent for that item", t => {
  const env = openDatabase(t);
  let state = running(env);
  const big = "B".repeat(PAGE.itemInlineBytes + 1000), justUnder = "u".repeat(PAGE.itemInlineBytes);
  // The item is new and its first chunk is long: the upsert says so, and the text is not in the frame.
  const opened = commit(env, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", [big, "after the long one"])]), [event("run.output")]);
  state = opened.conversation;
  const frame = frameOf(opened);
  assert.deepEqual(frame.items!.map(entry => [entry.item.seq, entry.item.bodyOmitted, entry.item.textBytes]), [[2, true, bytes(big) + bytes("after the long one")]]);
  assert.equal(frame.texts, undefined);
  assert.ok(size(frame) < 2048, "the frame is " + size(frame) + " bytes");
  // The item is old and a long chunk comes after a short one: the short one is sent, a text entry stands for what is not.
  const small = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "short"] } : it)), [event("run.output")]);
  const long = commit(env, small.conversation, withItems(small.conversation, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "tiny", big, "late", justUnder] } : it)), [event("run.output")]);
  const before = bytes(big) + bytes("after the long one") + bytes("short");
  assert.deepEqual(frameOf(small).texts, [{ runId: "run-0", itemSeq: 2, from: bytes(big) + bytes("after the long one"), text: "short" }]);
  assert.deepEqual(frameOf(long).texts, [{ runId: "run-0", itemSeq: 2, from: before, text: "tiny" },
    { runId: "run-0", itemSeq: 2, from: before + bytes("tiny"), text: "", omittedBytes: bytes(big) + bytes("late") + bytes(justUnder) }]);
  assert.equal(frameOf(long).items, undefined);
  assert.ok(size(frameOf(long)) < 2048);
  // A chunk just under what a frame carries is sent whole.
  const exact = commit(env, long.conversation, withItems(long.conversation, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, justUnder] } : it)), [event("run.output")]);
  assert.equal(frameOf(exact).texts![0]!.text.length, PAGE.itemInlineBytes);
});

test("an item whose JSON is longer than a frame carries goes as its type, empty, marked; a frame holds no more than a window's worth, whatever the commit wrote", t => {
  const env = openDatabase(t);
  const state = running(env);
  const changes = Array.from({ length: 5000 }, (_, index) => ({ path: "/work/space/src/module-" + index + ".ts", op: "modify", added: index, removed: 1 }));
  const edited = commit(env, state, withItems(state, items => [...items, item("run-0", 2, "tool:edit", "file_change", "completed", { changes })]), [event("run.output")]);
  const frame = frameOf(edited);
  assert.deepEqual(frame.items![0]!.item, { type: "file_change", changes: [], id: "tool:edit", seq: 2, status: "completed", bodyOmitted: true });
  assert.ok(size(frame) < 2048);
  // A commit that wrote a hundred segments of 60 KiB each (a bulk commit, as a conversion or a replay would make): the frame carries about a window and says what it left.
  const sixty = "s".repeat(60 * 1024), many = Array.from({ length: 100 }, (_, index) => replyItem("run-0", 3 + index, 2 + index, "running", [sixty]));
  const bulk = commit(env, edited.conversation, withItems(edited.conversation, items => [...items, ...many]), [event("run.output")]);
  const wide = frameOf(bulk);
  assert.equal(wide.items!.length, 100);
  const sent = wide.texts!.length, omittedItems = wide.items!.filter(entry => entry.item.bodyOmitted === true);
  assert.ok(sent >= 16 && sent <= 18, "about a window of 60 KiB chunks went whole (" + sent + ")");
  assert.equal(omittedItems.length, 100 - sent);
  assert.ok(omittedItems.every(entry => entry.item.textBytes === bytes(sixty)));
  assert.ok(size(wide) < PAGE.windowBytes + 200 * 1024, "the frame is " + size(wide) + " bytes");
});

test("a frame is made from the commit as it was written, for the head it wrote", t => {
  const env = openDatabase(t);
  const state = running(env);
  const wrote = commit(env, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", ["x"])]), [event("run.output")]);
  assert.throws(() => commitFrame(wrote.applied.changes, { ...headView(wrote.conversation), lastSeq: wrote.conversation.lastSeq + 1 }, views), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA");
  // A chunk with no offset (a hand-made Mutation) cannot be told to a page: it would have no place to be put.
  const unwritten: Mutation = { ...wrote.mutation, text: [{ runId: "run-0" as never, itemSeq: 2, chunk: 0, text: "x" }] };
  assert.throws(() => commitFrame(unwritten, headView(wrote.conversation), views), (error: unknown) => error instanceof SessionError && /offset/u.test(error.message));
  // A commit without a head change (a Mutation of rows alone) carries no head.
  const { head: _head, ...rowsOnly } = wrote.applied.changes;
  assert.equal(commitFrame(rowsOnly, headView(wrote.conversation), views).head, undefined);
});
