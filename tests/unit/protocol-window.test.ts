import assert from "node:assert/strict";
import test from "node:test";
import type { ReadItem } from "../../src/contracts/protocol-read.js";
import { assemble } from "../../web/src/lib/protocol/assemble.js";
import { withReply } from "../../web/src/lib/protocol/work.js";
import {
  applyCommit, fillDeferred, fillItem, fillText, incomplete, openWindow, prependOlder, replaceWithSnapshot, utf8Length, viewOf, type Applied, type WindowState,
} from "../../web/src/lib/protocol/window.js";
import { decodeSessionViewV14, type ClientCommitFrame, type ClientRun, type ClientSessionView, type ClientTurn } from "../../web/src/lib/protocol/wire.js";

// The part of a conversation the page holds (web/src/lib/protocol/window.ts): frames applied in their order and never guessed at, pages that join the Turns held without a repeat or a gap,
// a text however long followed by its bytes, a reconnection that does not take the reader back to the bottom, and a state that is the size of the window and not of the conversation.
// The frames and pages here are written by hand in the shapes of src/contracts/web.ts; tests/integration/commit-stream.test.ts feeds the page the frames the Gateway makes.

const SESSION = "session-x", selection = { harnessId: "alpha", controlId: "alpha-acp" };
const header = (n: number, status = "completed") => ({ version: "hh/1" as const, runId: "run-" + (n - 1), n, status, executor: { harnessId: "alpha", harness: "alpha" }, usage: { completeness: "unavailable" as const } });
function run(ordinal: number, status = "completed", over: Record<string, unknown> = {}): ClientRun {
  return { id: "run-" + ordinal, commandId: "command-" + ordinal, userMessageId: "message-user-" + ordinal, assistantMessageId: "message-reply-" + ordinal, selection, epoch: 1, status, cancelRequested: false, contextThroughSeq: 0,
    sourceRunIds: [], backend: status === "completed" ? { status: "completed", reason: "end_turn" } : null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, ordinal, userSeq: 2 + ordinal,
    turn: header(ordinal + 1, status), ...over } as unknown as ClientRun;
}
const user = (ordinal: number, text?: string): ReadItem => ({ id: "user", seq: 1, status: "completed", type: "user_message", messageId: "message-user-" + ordinal, ...(text === undefined ? {} : { text }) } as ReadItem);
const reply = (ordinal: number, seq = 2, text?: string, status = "completed", n = 1): ReadItem => ({ id: "text:" + n, seq, status, type: "assistant_message", messageId: "message-reply-" + ordinal, phase: "commentary", ...(text === undefined ? {} : { text }) } as ReadItem);
const command = (seq: number, status: string, exitCode?: number): ReadItem => ({ id: "tool:t" + seq, seq, status, type: "command", command: "echo " + seq, ...(exitCode === undefined ? {} : { exitCode }) } as ReadItem);
const simple = (ordinal: number): ClientTurn => ({ run: run(ordinal), items: [user(ordinal, "question " + ordinal), reply(ordinal, 2, "answer " + ordinal)] });
const head = (version: number, lastSeq: number, runCount: number) => ({ id: SESSION, version, lastSeq, epoch: 1, status: "open" as const, workspace: "/work", selection, activeRunId: null, pendingSwitchId: null, title: "t", runCount,
  facts: { unknown: { count: 0, unclosed: false }, settled: true, branchable: null, ran: [] as { harnessId: string; controlId: string; turns: number }[], changes: 0 } });
const view = (turns: readonly ClientTurn[], older: string | null = null, version = 5, lastSeq = 20, runCount = turns.length): ClientSessionView => ({ head: head(version, lastSeq, runCount), window: { turns, older } });
function commit(version: number, lastSeq: number, over: Partial<ClientCommitFrame> = {}): ClientCommitFrame {
  return { type: "commit", sessionId: SESSION, version, lastSeq, head: head(version, lastSeq, 0), ...over };
}
function applied(result: Applied): WindowState { assert.equal(result.kind, "applied", result.kind === "resync" ? result.reason : ""); return (result as { state: WindowState }).state; }
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const texts = (state: WindowState, ordinal: number): (string | undefined)[] => state.turns.find(turn => turn.run.ordinal === ordinal)!.items.map(entry => (entry.item as { text?: string }).text);

test("a Turn that begins, speaks, works and ends comes frame by frame, and after each frame the page holds what a reading of the conversation would give", () => {
  let state = openWindow(view([simple(0)], null, 5, 20, 1));
  // The input is accepted: the Run, your words (an item without them, and then the chunk that carries them).
  state = applied(applyCommit(state, commit(6, 21, { runs: [run(1, "queued")], items: [{ runId: "run-1", item: user(1) }], texts: [{ runId: "run-1", itemSeq: 1, from: 0, text: "你好" }] })));
  assert.deepEqual(plain(viewOf(state).window.turns[1]), { run: run(1, "queued"), items: [user(1, "你好")] });
  // The reply begins and goes on; the offsets are bytes (你好 is six, "Looking " eight).
  state = applied(applyCommit(state, commit(7, 22, { runs: [run(1, "running")], items: [{ runId: "run-1", item: reply(1, 2, undefined, "running") }], texts: [{ runId: "run-1", itemSeq: 2, from: 0, text: "Looking " }] })));
  state = applied(applyCommit(state, commit(8, 23, { texts: [{ runId: "run-1", itemSeq: 2, from: 8, text: "at 文件 😀" }] })));
  assert.deepEqual(texts(state, 1), ["你好", "Looking at 文件 😀"]);
  // A call begins and ends.
  state = applied(applyCommit(state, commit(9, 24, { items: [{ runId: "run-1", item: command(3, "running") }] })));
  state = applied(applyCommit(state, commit(10, 25, { items: [{ runId: "run-1", item: command(3, "completed", 0) }] })));
  // The reply goes on after the call, and the Turn ends: the Run, the reply closed, the answer marked.
  state = applied(applyCommit(state, commit(11, 26, { runs: [run(1, "completed")], items: [{ runId: "run-1", item: reply(1, 2, undefined, "completed") }, { runId: "run-1", item: { ...reply(1, 2, undefined, "completed"), phase: "final" } as ReadItem }] })));
  const expected = [user(1, "你好"), { ...reply(1, 2, "Looking at 文件 😀"), phase: "final" }, command(3, "completed", 0)];
  assert.deepEqual(plain(viewOf(state).window.turns[1]!.items), plain(expected));
  assert.deepEqual([state.head.version, state.head.lastSeq, viewOf(state).window.turns.map(turn => turn.run.ordinal), viewOf(state).window.turns[1]!.run.status], [11, 26, [0, 1], "completed"]);
  // The text of a reasoning segment and of a notice start as "" and grow the same way.
  const think = { id: "think:1", seq: 4, status: "running", type: "reasoning", text: "" } as ReadItem;
  state = applied(applyCommit(state, commit(12, 27, { items: [{ runId: "run-1", item: think }], texts: [{ runId: "run-1", itemSeq: 4, from: 0, text: "hm" }] })));
  state = applied(applyCommit(state, commit(13, 28, { texts: [{ runId: "run-1", itemSeq: 4, from: 2, text: "m" }] })));
  assert.equal((state.turns[1]!.items[3]!.item as { text: string }).text, "hmm");
});

test("a frame the page already has is ignored; one that is not the next is not followed (a commit is missing, or they arrived out of order) and nothing is changed", () => {
  const first = openWindow(view([simple(0)], null, 5, 20, 1)), a = commit(6, 21, { runs: [run(1, "queued")], items: [{ runId: "run-1", item: user(1) }] }), b = commit(7, 22, { texts: [{ runId: "run-1", itemSeq: 1, from: 0, text: "x" }] });
  const before = JSON.stringify(first);
  const ab = applied(applyCommit(applied(applyCommit(first, a)), b));
  // Again, and again: nothing happens.
  for (const again of [a, b, commit(5, 20), commit(3, 4)]) { const result = applyCommit(ab, again); assert.equal(result.kind, "ignored"); assert.equal((result as { state: WindowState }).state, ab); }
  // Out of order: b before a is not followed, whatever then comes.
  const early = applyCommit(first, b);
  assert.equal(early.kind, "resync"); assert.match((early as { reason: string }).reason, /missing/u);
  // A gap: a commit that skipped one.
  assert.equal(applyCommit(first, commit(8, 40)).kind, "resync"); assert.equal(applyCommit(first, commit(6, 21, { sessionId: "session-other" })).kind, "resync");
  // The state it was given is whole after all of it.
  assert.equal(JSON.stringify(first), before);
  // The page then reads the conversation again, and takes the frames after that one.
  const again = replaceWithSnapshot(first, view([simple(0), { run: run(1, "queued"), items: [user(1, "x")] }], null, 7, 22, 2));
  assert.equal(applyCommit(again, a).kind, "ignored"); assert.equal(applyCommit(again, b).kind, "ignored"); assert.equal(applyCommit(again, commit(8, 23)).kind, "applied");
});

test("a text that does not begin where the held text ends is not guessed at; an item or a Turn the page should hold and does not is the same", () => {
  const base = openWindow(view([{ run: run(0, "running"), items: [user(0, "你好"), reply(0, 2, "abc", "running")] }], null, 5, 20, 1)), at = (from: number, text = "d") => commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 2, from, text }] });
  assert.equal(applyCommit(base, at(3)).kind, "applied");
  // The offsets are bytes: the user's six, not their two characters.
  assert.equal(applyCommit(base, commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 1, from: 6, text: "!" }] })).kind, "applied");
  for (const wrong of [0, 2, 4, 99]) assert.equal(applyCommit(base, at(wrong)).kind, "resync", "from " + wrong);
  assert.equal(applyCommit(base, commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 1, from: 2, text: "!" }] })).kind, "resync", "characters are not bytes");
  assert.equal(applyCommit(base, commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 9, from: 0, text: "x" }] })).kind, "resync", "a text for an item the page does not hold");
  assert.equal(applyCommit(base, commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 3, from: 0, text: "x" }] })).kind, "resync");
  // A Run the page does not hold and cannot place: one beyond the next, or one at a place held by another.
  assert.equal(applyCommit(base, commit(6, 21, { runs: [run(2, "queued")] })).kind, "resync"); assert.equal(applyCommit(base, commit(6, 21, { runs: [run(0, "running", { id: "run-elsewhere" })] })).kind, "resync");
  // What is older than the window or not held in it is not the page's concern.
  assert.equal(applyCommit(openWindow(view([simple(5), simple(6)], "c", 5, 20, 7)), commit(6, 21, { runs: [run(2, "completed")], items: [{ runId: "run-2", item: command(9, "completed") }], texts: [{ runId: "run-2", itemSeq: 1, from: 0, text: "x" }] })).kind, "applied");
  // An item sent again keeps the words the page holds (the words come in the texts).
  const again = applied(applyCommit(base, commit(6, 21, { items: [{ runId: "run-0", item: reply(0, 2, undefined, "completed") }] })));
  assert.deepEqual(texts(again, 0), ["你好", "abc"]); assert.equal(again.turns[0]!.items[1]!.item.status, "completed");
  // The same frame to the page is the same state however often it is asked for: the page's value is never changed.
  const json = JSON.stringify(base); applyCommit(base, at(3)); applyCommit(base, at(99)); assert.equal(JSON.stringify(base), json);
  assert.equal(utf8Length("你好"), 6); assert.equal(utf8Length("😀"), 4); assert.equal(utf8Length("é"), 2); assert.equal(utf8Length("\ud83d"), 3);
});

test("a text left out for its size is followed by its bytes: marked, grown, and read by range until it is whole; a prefix the page holds is kept", () => {
  const long = { ...reply(0, 2, undefined, "running"), bodyOmitted: true, textBytes: 70_000 } as ReadItem;
  let state = openWindow(view([{ run: run(0, "running"), items: [user(0, "q"), long] }], null, 5, 20, 1));
  assert.deepEqual(incomplete(state), [{ kind: "text", runId: "run-0", ordinal: 0, seq: 2, from: 0, total: 70_000 }]);
  // The text goes on: a chunk that begins at the end of what the page knows of it makes the total larger and is not held.
  state = applied(applyCommit(state, commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 2, from: 70_000, text: "tail" }] })));
  assert.equal(state.turns[0]!.items[1]!.item.textBytes, 70_004); assert.equal((state.turns[0]!.items[1]!.item as { text?: string }).text, undefined);
  state = applied(applyCommit(state, commit(7, 22, { texts: [{ runId: "run-0", itemSeq: 2, from: 70_004, text: "", omittedBytes: 500 }] })));
  assert.equal(state.turns[0]!.items[1]!.item.textBytes, 70_504);
  assert.equal(applyCommit(state, commit(8, 23, { texts: [{ runId: "run-0", itemSeq: 2, from: 70_000, text: "x" }] })).kind, "resync", "the text the page knows of ends at 70504");
  // The page reads it by range from the start: a range that does not go on from what is held changes nothing.
  const piece = "é".repeat(35_252);   // 70,504 bytes in all
  assert.equal(utf8Length(piece), 70_504);
  const at = { runId: "run-0", seq: 2 };
  assert.equal(fillText(state, at, { text: "x", from: 5, to: 6, total: 70_504 }), state);
  state = fillText(state, at, { text: piece.slice(0, 20_000), from: 0, to: 40_000, total: 70_504 });
  assert.deepEqual(incomplete(state), [{ kind: "text", runId: "run-0", ordinal: 0, seq: 2, from: 40_000, total: 70_504 }]);
  assert.equal(fillText(state, at, { text: "y", from: 0, to: 1, total: 70_504 }), state, "asked twice: the second answer is stale");
  state = fillText(state, at, { text: piece.slice(20_000), from: 40_000, to: 70_504, total: 70_504 });
  assert.deepEqual(incomplete(state), []);
  assert.deepEqual(plain(state.turns[0]!.items[1]!.item), plain(reply(0, 2, piece, "running")), "whole: no mark is left");
  // A prefix the page holds is kept when the next chunk is too long to send: the item says it has more than it holds.
  const held = openWindow(view([{ run: run(0, "running"), items: [user(0, "q"), reply(0, 2, "short", "running")] }], null, 5, 20, 1));
  const grown = applied(applyCommit(held, commit(6, 21, { texts: [{ runId: "run-0", itemSeq: 2, from: 5, text: "", omittedBytes: 900_000 }] })));
  assert.deepEqual([(grown.turns[0]!.items[1]!.item as { text?: string }).text, grown.turns[0]!.items[1]!.item.textBytes, grown.turns[0]!.items[1]!.item.bodyOmitted], ["short", 900_005, true]);
  assert.deepEqual(incomplete(grown), [{ kind: "text", runId: "run-0", ordinal: 0, seq: 2, from: 5, total: 900_005 }]);
  // An item marked in the frame and sent again with a status change stays marked; a frame that marks an item whose chunk before the long one is also sent follows both.
  const marked = applied(applyCommit(held, commit(6, 21, { items: [{ runId: "run-0", item: { ...reply(0, 2, undefined, "running"), bodyOmitted: true, textBytes: 1_000_009 } as ReadItem }], texts: [{ runId: "run-0", itemSeq: 2, from: 5, text: "tiny" }] })));
  assert.deepEqual([(marked.turns[0]!.items[1]!.item as { text?: string }).text, marked.turns[0]!.items[1]!.item.textBytes, marked.turns[0]!.items[1]!.held], ["shorttiny", 1_000_009, 9]);
  const later = applied(applyCommit(grown, commit(7, 22, { items: [{ runId: "run-0", item: reply(0, 2, undefined, "completed") }] })));
  assert.deepEqual([later.turns[0]!.items[1]!.item.status, later.turns[0]!.items[1]!.item.bodyOmitted, later.turns[0]!.items[1]!.item.textBytes], ["completed", true, 900_005]);
  // An item whose fields were left out for their size is fetched whole.
  const stub = openWindow(view([{ run: run(0), items: [user(0, "q"), { id: "tool:e", seq: 2, status: "completed", type: "file_change", changes: [], bodyOmitted: true } as ReadItem] }], null, 5, 20, 1));
  assert.deepEqual(incomplete(stub), [{ kind: "item", runId: "run-0", ordinal: 0, seq: 2 }]);
  const whole = fillItem(stub, "run-0", { id: "tool:e", seq: 2, status: "completed", type: "file_change", changes: [{ path: "/a", op: "modify" }] } as ReadItem);
  assert.deepEqual(incomplete(whole), []); assert.equal((whole.turns[0]!.items[1]!.item as unknown as { changes: unknown[] }).changes.length, 1);
  assert.equal(fillItem(stub, "run-9", { id: "x", seq: 2, status: "completed", type: "tool", name: "x" }), stub); assert.equal(fillItem(stub, "run-0", { id: "x", seq: 7, status: "completed", type: "tool", name: "x" }), stub);
});

test("a page of older Turns joins the Turns held without a repeat, a gap or a change of order; one that is not the page before is not used", () => {
  const state = openWindow(view([simple(50), simple(51), simple(52)], "c50", 5, 20, 53));
  const page = (from: number, to: number, older: string | null) => ({ turns: Array.from({ length: to - from + 1 }, (_, index) => simple(from + index)), older });
  const one = prependOlder(state, page(45, 49, "c45"));
  assert.deepEqual([one.turns.map(turn => turn.run.ordinal), one.older], [[45, 46, 47, 48, 49, 50, 51, 52], "c45"]);
  // The same page again, a page that overlaps what is held, one that stops short, one that is further back, one that is out of order: not the page before.
  assert.equal(prependOlder(one, page(45, 49, "c45")), one);
  assert.deepEqual(prependOlder(state, page(47, 52, "c47")).turns.map(turn => turn.run.ordinal), [47, 48, 49, 50, 51, 52], "the Turns of it that are held are left out");
  assert.equal(prependOlder(state, page(40, 44, "c40")), state); assert.equal(prependOlder(state, page(30, 40, "c30")), state);
  assert.equal(prependOlder(state, { turns: [simple(49), simple(47)], older: "c" }), state); assert.equal(prependOlder(state, { turns: [], older: null }), state);
  // The first Turn: nothing is older.
  const to0 = prependOlder(openWindow(view([simple(2), simple(3)], "c2", 5, 20, 4)), page(0, 1, null));
  assert.deepEqual([to0.turns.map(turn => turn.run.ordinal), to0.older], [[0, 1, 2, 3], null]);
  // A page that comes while a Turn streams: the state is the same whichever comes first.
  const running = openWindow(view([{ run: run(52, "running"), items: [user(52, "q"), reply(52, 2, "ab", "running")] }], "c52", 5, 20, 53));
  const stream = commit(6, 21, { texts: [{ runId: "run-52", itemSeq: 2, from: 2, text: "cd" }] }), older = page(47, 51, "c47");
  const a = prependOlder(applied(applyCommit(running, stream)), older), b = applied(applyCommit(prependOlder(running, older), stream));
  assert.deepEqual(plain(viewOf(a)), plain(viewOf(b))); assert.equal(texts(a, 52)[1], "abcd"); assert.deepEqual(a.turns.map(turn => turn.run.ordinal), [47, 48, 49, 50, 51, 52]);
  // And a page of older Turns that holds a Turn that had a text left out says so.
  const withLong = prependOlder(running, { turns: [{ run: run(51), items: [user(51, "q"), { ...reply(51), bodyOmitted: true, textBytes: 80_000 } as ReadItem] }], older: "c51" });
  assert.deepEqual(incomplete(withLong), [{ kind: "text", runId: "run-51", ordinal: 51, seq: 2, from: 0, total: 80_000 }]);
});

test("reading the conversation again replaces what the page holds, unless it is older, and keeps the Turns the reader had gone back to when they are over", () => {
  const read = (from: number, to: number, version: number, lastSeq: number) => view(Array.from({ length: to - from + 1 }, (_, index) => simple(from + index)), "c" + from, version, lastSeq, to + 1);
  const gone = prependOlder(openWindow(read(60, 69, 5, 20)), { turns: Array.from({ length: 20 }, (_, index) => simple(40 + index)), older: "c40" });
  assert.equal(gone.turns.length, 30);
  // Newer: the window of the new reading, and before it the Turns that were loaded.
  const newer = replaceWithSnapshot(gone, read(62, 71, 9, 30));
  assert.deepEqual([newer.turns[0]!.run.ordinal, newer.turns.at(-1)!.run.ordinal, newer.turns.length, newer.older, newer.head.lastSeq], [40, 71, 32, "c40", 30]);
  assert.deepEqual(newer.turns.map(turn => turn.run.ordinal), Array.from({ length: 32 }, (_, index) => 40 + index));
  // Without keeping them, it is the reading alone.
  assert.equal(replaceWithSnapshot(gone, read(62, 71, 9, 30), { keepOlder: false }).turns.length, 10);
  // Older than what is held (a slow answer): not used.
  assert.equal(replaceWithSnapshot(gone, read(60, 69, 4, 19)), gone);
  // The same commit (the page lost its connection and found nothing changed): the Turns the page holds, all of them, and the head as the service says it now.
  const same = replaceWithSnapshot(gone, { ...read(60, 69, 5, 20), head: { ...head(5, 20, 70), title: "retitled", queue: { kind: "slot", runId: "run-9", running: 1, limit: 1, since: 3 } } });
  assert.equal(same.turns, gone.turns); assert.deepEqual([same.head.title, same.head.queue?.runId, same.older], ["retitled", "run-9", "c40"]);
  assert.equal(replaceWithSnapshot(gone, read(60, 69, 5, 20), { keepOlder: false }).turns.length, 10);
  // A gap between what was loaded and the new window, a loaded Turn that was not over, another conversation: the reading alone.
  assert.equal(replaceWithSnapshot(gone, read(100, 109, 9, 30)).turns.length, 10);
  const open = prependOlder(openWindow(read(60, 69, 5, 20)), { turns: [{ run: run(59, "running"), items: [] }], older: "c59" });
  assert.equal(replaceWithSnapshot(open, read(62, 71, 9, 30)).turns.length, 10);
  assert.equal(replaceWithSnapshot(gone, { ...read(60, 69, 9, 30), head: { ...head(9, 30, 70), id: "session-other" } }).head.id, "session-other");
  assert.equal(replaceWithSnapshot(null, read(60, 69, 5, 20)).turns.length, 10);
  // A Turn that was running and is read as over is the reading's.
  const running = openWindow(view([{ run: run(0, "running"), items: [user(0, "q"), reply(0, 2, "a", "running")] }], null, 5, 20, 1));
  const done = replaceWithSnapshot(running, view([{ run: run(0), items: [user(0, "q"), reply(0, 2, "ab")] }], null, 6, 22, 1));
  assert.deepEqual([done.turns[0]!.run.status, texts(done, 0)[1]], ["completed", "ab"]);
});

test("what the page holds follows the window and not the conversation: ten Turns of two thousand are what ten Turns of twenty are, and going back adds the pages that were read", () => {
  const window = (total: number) => view(Array.from({ length: 10 }, (_, index) => simple(total - 10 + index)), "c" + (total - 10), 5, 20, total);
  const small = openWindow(window(20)), large = openWindow(window(2000));
  const huge = openWindow(window(2_000_000));
  // What differs is the digits of the ordinals and the count: a few bytes a Turn, whatever the history.
  assert.ok(Math.abs(JSON.stringify(large).length - JSON.stringify(small).length) < 512 && Math.abs(JSON.stringify(huge).length - JSON.stringify(large).length) < 512, JSON.stringify(large).length + " against " + JSON.stringify(small).length + " and " + JSON.stringify(huge).length);
  assert.equal(large.turns.length, 10);
  let state = large;
  const sizes: number[] = [JSON.stringify(state).length];
  for (let page = 0; page < 5; page++) { const first = state.turns[0]!.run.ordinal; state = prependOlder(state, { turns: Array.from({ length: 20 }, (_, index) => simple(first - 20 + index)), older: "c" + (first - 20) }); sizes.push(JSON.stringify(state).length); }
  assert.equal(state.turns.length, 110); assert.ok(sizes[5]! > sizes[0]! * 5, "five pages of twenty were read and are held");
  // A frame costs what it carries: a thousand frames of text into one reply do not copy the other Turns' words.
  let streaming = applied(applyCommit(openWindow(view([{ run: run(0, "running"), items: [user(0, "q"), reply(0, 2, "", "running")] }], null, 5, 20, 1)), commit(6, 21)));
  let from = 0;
  for (let index = 0; index < 1000; index++) { const chunk = "word" + index + " "; streaming = applied(applyCommit(streaming, commit(7 + index, 22 + index, { texts: [{ runId: "run-0", itemSeq: 2, from, text: chunk }] }))); from += utf8Length(chunk); }
  assert.equal(streaming.turns[0]!.items[1]!.held, from); assert.ok(texts(streaming, 0)[1]!.startsWith("word0 word1 ") && texts(streaming, 0)[1]!.endsWith("word999 "));
});

test("the middle of a long stretch of work joins its Turn as it is read, and what is still missing of it is told", () => {
  const calls = (from: number, to: number): ReadItem[] => Array.from({ length: to - from + 1 }, (_, index) => command(from + index, "completed", 0));
  const turn: ClientTurn = { run: run(0), items: [user(0, "q"), ...calls(2, 26), ...calls(127, 151)], deferred: { fromSeq: 27, toSeq: 126, count: 100 } };
  let state = openWindow(view([turn], null, 5, 20, 1));
  assert.equal(state.turns[0]!.items.length, 51);
  state = fillDeferred(state, 0, { items: calls(27, 76), next: 76 });
  assert.deepEqual(state.turns[0]!.deferred, { fromSeq: 77, toSeq: 126, count: 50 });
  assert.equal(fillDeferred(state, 0, { items: calls(27, 76), next: 76 }), state, "a page held already adds nothing");
  state = fillDeferred(state, 0, { items: [...calls(77, 126), command(300, "completed")], next: null });
  assert.equal(state.turns[0]!.deferred, undefined);
  assert.deepEqual(state.turns[0]!.items.map(entry => entry.item.seq), Array.from({ length: 151 }, (_, index) => index + 1));
  assert.equal(fillDeferred(state, 0, { items: calls(27, 30), next: null }), state); assert.equal(fillDeferred(state, 7, { items: [], next: null }), state);
});

test("the Turns as the renderer draws them: your words as the Run's input, the Turn with its items, the words of each message by the id an item names, and the few rules that need the whole Turn", () => {
  const items: ReadItem[] = [
    user(0, "你好"), { id: "think:1", seq: 2, status: "completed", type: "reasoning", text: "hm" }, { id: "think:2", seq: 3, status: "completed", type: "reasoning", text: "" },
    reply(0, 4, "I will look.", "completed", 1), command(5, "completed", 0), reply(0, 6, "Done.", "completed", 2),
    { id: "tool:agent:thread", seq: 7, status: "completed", type: "subagent", title: "Dewey" } as ReadItem, { id: "activity:thread", seq: 8, status: "completed", type: "subagent", title: "Dewey" } as ReadItem,
    { id: "notice:1", seq: 9, status: "failed", type: "error", class: "unknown", message: "Quota" } as ReadItem, { id: "notice:2", seq: 10, status: "completed", type: "notice", severity: "info", text: "fell back" } as ReadItem,
    { id: "hh:error", seq: Number.MAX_SAFE_INTEGER - 1, status: "failed", type: "error", class: "quota", message: "Quota" } as ReadItem,
  ];
  const state = openWindow(view([{ run: run(0, "completed", { error: { code: "NATIVE_QUOTA_EXCEEDED", message: "Quota" } }), items }], null, 5, 20, 1));
  const drawn = assemble(state), first = drawn.runs[0]!;
  assert.equal(first.input, "你好"); assert.equal(first.ordinal, 0);
  assert.equal("turn" in first, false);
  const types = first.protocol!.items.map(item => item.id);
  // The thought with no words and the sub-agent told twice are not lines; the error notice stands behind the Run's error; the rest stand in their places.
  assert.deepEqual(types, ["user", "think:1", "text:1", "tool:t5", "text:2", "tool:agent:thread", "notice:2", "hh:error"]);
  // The reply segments have an id of their own, the first the Run's reply message; the renderer finds the words by the id an item names.
  const replies = first.protocol!.items.filter(item => item.type === "assistant_message") as { messageId: string; phase: string }[];
  assert.deepEqual(replies.map(item => item.messageId), ["message-reply-0", "message-reply-0~6"]);
  assert.deepEqual(replies.map(item => drawn.message(item.messageId)?.text), ["I will look.", "Done."]);
  assert.equal(drawn.message("message-user-0")?.text, "你好"); assert.equal(drawn.message("message-nowhere"), undefined);
  assert.deepEqual(drawn.messages.map(message => [message.role, message.id]), [["user", "message-user-0"], ["assistant", "message-reply-0"], ["assistant", "message-reply-0~6"]]);
  assert.equal(withReply(first.protocol!, drawn.message(first.assistantMessageId)), first.protocol, "the renderer finds the reply among the items and adds none");
  // This Turn failed, so no segment is its answer; one that completed has its last reply segment, found past the notices.
  assert.deepEqual(replies.map(item => item.phase), ["commentary", "commentary"]);
  const done = assemble(openWindow(view([{ run: run(1), items: [user(1, "q"), reply(1, 2, "one", "completed", 1), reply(1, 3, "two", "completed", 2), { id: "notice:1", seq: 4, status: "completed", type: "notice", severity: "info", text: "n" } as ReadItem] }], null, 5, 20, 2)));
  assert.deepEqual((done.runs[0]!.protocol!.items.filter(item => item.type === "assistant_message") as { phase: string }[]).map(item => item.phase), ["commentary", "final"]);
});

test("a Turn the state did not change is drawn as it was, the very same Run, so that what the renderer keeps for it is kept; the one that changed is drawn again", () => {
  const state = openWindow(view([simple(0), simple(1), { run: run(2, "running"), items: [user(2, "q"), reply(2, 2, "ab", "running")] }], null, 5, 20, 3));
  const before = assemble(state), next = applied(applyCommit(state, commit(6, 21, { texts: [{ runId: "run-2", itemSeq: 2, from: 2, text: "cd" }] }))), after = assemble(next);
  assert.equal(after.runs[0], before.runs[0]); assert.equal(after.runs[1], before.runs[1]); assert.notEqual(after.runs[2], before.runs[2]);
  assert.equal(after.message("message-reply-2")!.text, "abcd"); assert.equal(before.message("message-reply-2")!.text, "ab");
  // The same state drawn twice is the same drawing.
  assert.equal(assemble(next).runs[2], after.runs[2]);
});

test("a Turn that goes on with an approval that waits is waiting, a Turn the page could not read is a Run with the reason and its words kept, and a Run with no words of its own has none", () => {
  const approval = { id: "permission:p", seq: 2, status: "waiting", type: "approval", subject: "command", title: "Run it", options: [] } as ReadItem;
  const running = assemble(openWindow(view([{ run: run(0, "running"), items: [user(0, "q"), approval] }], null, 5, 20, 1)));
  assert.equal(running.runs[0]!.protocol!.status, "waiting"); assert.equal(running.runs[0]!.status, "running");
  assert.equal(assemble(openWindow(view([{ run: run(0, "running"), items: [user(0, "q")] }], null, 5, 20, 1))).runs[0]!.protocol!.status, "running");
  assert.equal(assemble(openWindow(view([{ run: run(0, "cancelled"), items: [user(0, "q"), { ...approval, status: "cancelled" } as ReadItem] }], null, 5, 20, 1))).runs[0]!.protocol!.status, "cancelled", "its own header is what the Turn said");
  const unreadable = decodeSessionViewV14({ head: head(5, 20, 1), window: { turns: [{ run: { ...run(0), turn: { version: "hh/9" } }, items: [user(0, "q")] }], older: null } });
  const shown = assemble(openWindow(unreadable));
  assert.equal(shown.runs[0]!.protocol, undefined); assert.match(shown.runs[0]!.protocolProblem!, /hh\/9/u); assert.equal(shown.runs[0]!.input, "q", "the words are a message of the conversation, not part of the Turn that could not be read"); assert.equal(shown.message("message-user-0")?.text, "q");
  const empty = assemble(openWindow(view([{ run: run(0, "queued"), items: [] }], null, 5, 20, 1)));
  assert.equal(empty.runs[0]!.input, ""); assert.deepEqual(empty.messages, []);
});
