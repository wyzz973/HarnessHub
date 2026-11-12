import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PAGE, type Conversation, type ConversationRun, type HeadRow, type HeldItem, type Mutation } from "../../src/contracts/conversation.js";
import { SessionError, sessionId, switchId, type NativeSessionBinding } from "../../src/contracts/session.js";
import { applyMutation } from "../../src/infrastructure/session/apply.js";
import { ConversationTables, decodeTurnCursor, encodeTurnCursor } from "../../src/infrastructure/session/read.js";
import { rebuildSearchIndex } from "../../src/infrastructure/session/search-index.js";
import {
  NOW, SESSION, STAMP, bytes, commit, conversation, event, item, openDatabase, reduce, replaceRun, replyItem, run, seedConverted, sendCommand, toolItem, userItem, type Env,
} from "../fixtures/conversation-builder.js";

// The reads of ADR-057 3.4 (T6) on real databases made by the writes of T2: a window of the newest Turns, older pages by cursor, a Turn's items by page, a
// long text by byte range, the folded middle of a long stretch of work, search, the list and the store's columns-and-indexes reads. Where a number is given
// it is measured here, on this machine, with other work running.

const completed = { backend: { status: "completed" as const, reason: "done" }, cleanup: { closed: true as const, exitCode: 0, signal: null, protocolFailure: null } };
const finishedRun = (ordinal: number, items: readonly HeldItem[], prefix = "run", extra: Partial<ConversationRun> = {}): ConversationRun => run(ordinal, "completed", items, { endedSeq: 100 + ordinal, ...completed, ...extra }, prefix);
const simpleTurn = (ordinal: number, prefix = "run"): ConversationRun => finishedRun(ordinal, [userItem(prefix + "-" + ordinal, "question " + ordinal), replyItem(prefix + "-" + ordinal, 2, 1, "completed", ["answer ", String(ordinal)])], prefix);
const elapsed = <T>(work: () => T): [T, number] => { const started = performance.now(); const result = work(); return [result, performance.now() - started]; };
const fixed = (value: number): string => value.toFixed(value < 10 ? 2 : 0);
const tablesOf = (env: Env): ConversationTables => new ConversationTables(env.db);
const bytesOf = (value: string): Buffer => Buffer.from(value, "utf8");
const sha = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const ordinals = (turns: readonly { readonly run: { readonly ordinal: number } }[]): number[] => turns.map(turn => turn.run.ordinal);

test("a conversation of 2,000 Turns opens as a window of the newest ten and is walked back page by page: every Turn once, in order, however the Turns come", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  seedConverted(env, conversation(Array.from({ length: 2000 }, (_, ordinal) => simpleTurn(ordinal)), { version: 1, lastSeq: 5 }));
  const [window, openMs] = elapsed(() => tables.window(SESSION));
  assert.deepEqual(ordinals(window.turns), [1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999]);
  assert.ok(window.bytes > 0 && window.bytes < PAGE.windowBytes, "a window of ten small Turns is small (" + window.bytes + " bytes)");
  assert.equal(window.lastSeq, 5);
  assert.deepEqual(window.turns[9]!.items.map(it => [it.seq, it.itemId, it.text.join("")]), [[1, "user", "question 1999"], [2, "text:1", "answer 1999"]]);
  assert.ok(window.turns.every(turn => turn.deferred === undefined && turn.items.every(it => it.textOmitted === undefined && it.bodyOmitted === undefined)));
  // Back through the conversation, twenty Turns a page.
  const seen: number[] = [...ordinals(window.turns)];
  let cursor = window.older, pages = 0;
  const [, walkMs] = elapsed(() => { while (cursor !== null) { const page = tables.older(SESSION, cursor); assert.ok(page.turns.length <= PAGE.olderTurns && page.turns.length > 0); seen.unshift(...ordinals(page.turns)); cursor = page.older; pages++; } });
  assert.equal(pages, 100); assert.equal(seen.length, 2000);
  assert.deepEqual(seen, Array.from({ length: 2000 }, (_, ordinal) => ordinal));
  console.log("window of 10 Turns of a conversation of 2,000: " + fixed(openMs) + " ms; walked back in " + pages + " pages of 20: " + fixed(walkMs) + " ms in all (" + fixed(walkMs / pages) + " ms a page)");
  // A cursor is opaque but not magic: one that is not a cursor is refused, and so is one of a Turn the conversation does not have.
  assert.throws(() => tables.older(SESSION, "not a cursor" as never), (error: unknown) => error instanceof SessionError && error.code === "INVALID_CURSOR");
  assert.throws(() => tables.older(SESSION, encodeTurnCursor({ ordinal: 2001, lastSeq: 5 })), (error: unknown) => error instanceof SessionError && error.code === "INVALID_CURSOR");
  assert.equal(tables.older(SESSION, encodeTurnCursor({ ordinal: 0, lastSeq: 5 })).turns.length, 0);
  assert.deepEqual(decodeTurnCursor(window.older!), { ordinal: 1990, lastSeq: 5 });
  assert.throws(() => tables.head(sessionId("session-nowhere")), (error: unknown) => error instanceof SessionError && error.code === "SESSION_NOT_FOUND");
});

test("a page of older Turns stays the same page when new Turns arrive: the cursor holds a Turn's ordinal, which never moves", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  let state = seedConverted(env, conversation(Array.from({ length: 60 }, (_, ordinal) => simpleTurn(ordinal)), { version: 1, lastSeq: 5 }));
  const before = tables.window(SESSION), page = tables.older(SESSION, before.older!);
  assert.deepEqual(ordinals(page.turns), Array.from({ length: 20 }, (_, index) => 30 + index));
  // Three inputs arrive.
  for (let ordinal = 60; ordinal < 63; ordinal++) {
    state = commit(env, state, reduce(state, current => ({ runs: [...current.runs, run(ordinal, "queued", [userItem("run-" + ordinal, "late " + ordinal)])], commands: [...current.commands, sendCommand(ordinal)] })), [event("message.accepted", { runId: "run-" + ordinal })]).conversation;
  }
  const again = tables.older(SESSION, before.older!);
  assert.deepEqual(ordinals(again.turns), ordinals(page.turns));
  assert.deepEqual(again.turns.map(turn => turn.items.map(it => it.text.join(""))), page.turns.map(turn => turn.items.map(it => it.text.join(""))));
  const now = tables.window(SESSION);
  assert.deepEqual(ordinals(now.turns), [53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
  assert.equal(now.lastSeq, state.lastSeq);
  assert.equal(tables.head(SESSION).runCount, 63);
});

test("a window stops at its size, counting the Turn that crosses it, and holds at least one Turn however large", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const sixty = "x".repeat(60 * 1024);
  const big = (ordinal: number, parts: number) => finishedRun(ordinal, [userItem("run-" + ordinal, "q"), ...Array.from({ length: parts }, (_, part) => replyItem("run-" + ordinal, part + 2, part + 1, "completed", [sixty]))]);
  // Ten Turns of 300 KiB: the budget of a window is 1 MiB, and the fourth Turn crosses it.
  seedConverted(env, conversation(Array.from({ length: 10 }, (_, ordinal) => big(ordinal, 5)), { version: 1, lastSeq: 5 }));
  const window = tables.window(SESSION);
  assert.deepEqual(ordinals(window.turns), [6, 7, 8, 9]);
  assert.ok(window.bytes >= PAGE.windowBytes && window.bytes < PAGE.windowBytes + 400 * 1024, "the window holds " + window.bytes + " bytes");
  assert.equal(window.turns[0]!.items.length, 6);
  assert.ok(window.older !== null);
  // Smaller limits are honoured, and one Turn is the least.
  assert.deepEqual(ordinals(tables.window(SESSION, { turns: 2 }).turns), [8, 9]);
  assert.deepEqual(ordinals(tables.window(SESSION, { bytes: 1 }).turns), [9]);
  assert.throws(() => tables.window(SESSION, { turns: 0 }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  // One Turn of two megabytes (thirty-four texts that a page carries, each just under what it leaves out): it is the whole window, and the older Turns are one cursor away.
  const env2 = openDatabase(t), tables2 = tablesOf(env2);
  seedConverted(env2, conversation([big(0, 3), big(1, 34)], { version: 1, lastSeq: 5 }));
  const heavy = tables2.window(SESSION);
  assert.deepEqual(ordinals(heavy.turns), [1]); assert.ok(heavy.bytes > PAGE.windowBytes); assert.deepEqual(decodeTurnCursor(heavy.older!).ordinal, 1);
  assert.deepEqual(ordinals(tables2.older(SESSION, heavy.older!).turns), [0]);
});

/** A text of whole code points of every width, in chunks of about 16 KiB (the windows the Runtime commits), `chunks` of them. */
function longText(chunks: number): string[] {
  const pieces = ["The quick brown fox jumps over the lazy dog. ", "迁移保真校验与接力水位，", "😀🚀 ", "naïve café ", "日本語のテキスト。", "𝒳𝒴𝒵 ", "\n"];
  let at = 0;
  return Array.from({ length: chunks }, () => { let chunk = ""; while (bytes(chunk) < 16 * 1024) chunk += pieces[at++ % pieces.length]!; return chunk; });
}

test("a reply of 20 MiB is left out of the window and read back whole by byte ranges that end where a character ends", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const chunks = longText(1280), whole = chunks.join(""), expected = bytesOf(whole);
  assert.ok(expected.length > 20 * 1024 * 1024 - 100 * 1024, "the reply has " + expected.length + " bytes");
  const reply = item("run-0", 2, "text:1", "assistant_message", "completed", { messageId: "message-reply-run-0", phase: "final" }, chunks);
  const [, writeMs] = elapsed(() => seedConverted(env, conversation([finishedRun(0, [userItem("run-0", "write a lot"), reply])], { version: 1, lastSeq: 5 })));
  const [window, windowMs] = elapsed(() => tables.window(SESSION));
  const held = window.turns[0]!.items[1]!;
  assert.equal(held.textOmitted, true); assert.deepEqual(held.text, []); assert.equal(held.textBytes, expected.length); assert.equal(held.textChunks, 1280);
  assert.ok(window.bytes < 4096, "the window of the reply holds " + window.bytes + " bytes");
  assert.equal(window.turns[0]!.items[0]!.text.join(""), "write a lot");
  // Ranges by plain arithmetic, 1,000,003 bytes at a time (not a multiple of any character's width): joined, they are the reply, byte for byte.
  const step = 1_000_003, parts: Buffer[] = [];
  let previousTo = 0;
  const [, readMs] = elapsed(() => {
    for (let from = 0; from < expected.length; from += step) {
      const range = tables.text(held.runId, 2, { from, to: from + step });
      assert.equal(range.total, expected.length);
      assert.ok(range.from >= from && range.from < from + 4, "a range starts at the next character: " + from + " -> " + range.from);
      assert.equal(range.from, previousTo, "ranges that follow one another leave no gap and no repeat");
      assert.equal(range.text, bytesOf(range.text).toString("utf8")); assert.ok(!range.text.includes("�"));
      assert.equal(bytesOf(range.text).length, range.to - range.from);
      previousTo = range.to; parts.push(bytesOf(range.text));
    }
  });
  assert.equal(previousTo, expected.length);
  assert.equal(Buffer.concat(parts).length, expected.length); assert.equal(sha(Buffer.concat(parts)), sha(expected));
  // The same by the answer's own `to`, with ranges of an odd size, and the whole at once.
  let cursor = 0, joined = "";
  while (cursor < expected.length) { const range = tables.text(held.runId, 2, { from: cursor, to: cursor + 777_777 }); joined += range.text; assert.ok(range.to > cursor); cursor = range.to; }
  assert.equal(joined, whole);
  const [all, allMs] = elapsed(() => tables.text(held.runId, 2));
  assert.equal(all.text, whole); assert.deepEqual([all.from, all.to, all.total], [0, expected.length, expected.length]);
  // The item whole through the item read, when asked for it; the Turn's other read leaves it out as the window does.
  const [full, fullMs] = elapsed(() => tables.items(held.runId, 1, 1, { inlineBytes: Infinity }));
  assert.equal(full.items[0]!.text.join(""), whole); assert.equal(full.items[0]!.textOmitted, undefined);
  assert.equal(tables.turnAt(SESSION, 0)!.items[1]!.textOmitted, true);
  assert.equal(tables.turnAt(SESSION, 0, { inlineBytes: Infinity })!.items[1]!.text.join(""), whole);
  console.log("20 MiB reply (" + expected.length + " bytes, 1,280 chunks): written in " + fixed(writeMs) + " ms; the window that omits it " + fixed(windowMs) + " ms; read back in " + Math.ceil(expected.length / step) + " ranges in "
    + fixed(readMs) + " ms (" + fixed(readMs / Math.ceil(expected.length / step)) + " ms a range); at once " + fixed(allMs) + " ms; as an item " + fixed(fullMs) + " ms");
  // Small ranges and the edges: inside one character, past the end, empty, backwards.
  const env2 = openDatabase(t), tables2 = tablesOf(env2);
  const word = "ab你c😀d";
  seedConverted(env2, conversation([finishedRun(0, [userItem("run-0", word)])], { version: 1, lastSeq: 5 }));
  const read = (from: number, to?: number) => { const range = tables2.text("run-0" as never, 1, to === undefined ? { from } : { from, to }); return [range.text, range.from, range.to]; };
  assert.deepEqual(read(0), [word, 0, 11]);
  assert.deepEqual(read(2, 6), ["你c", 2, 6], "the characters that start in bytes 2 to 5");
  assert.deepEqual(read(3, 4), ["", 5, 5], "inside 你, which started at 2: it belongs to the range that holds byte 2");
  assert.deepEqual(read(0, 3), ["ab你", 0, 5], "a range ending inside a character takes the character");
  assert.deepEqual(read(6, 8), ["😀", 6, 10], "bytes 6-8 start 😀");
  assert.deepEqual(read(40), ["", 11, 11]); assert.deepEqual(read(11), ["", 11, 11]);
  assert.deepEqual(read(4, 4), ["", 5, 5]);
  assert.throws(() => read(5, 4), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  assert.throws(() => tables2.text("run-0" as never, 9), (error: unknown) => error instanceof SessionError && error.code === "ITEM_NOT_FOUND");
});

test("the middle of a long stretch of finished work is deferred, and read by page; nothing else is", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const command = (id: string, seq: number, status: "completed" | "running" | "failed" = "completed") => toolItem(id, seq, "t" + seq, status);
  const think = (id: string, seq: number) => item(id, seq, "think:" + seq, "reasoning", "completed", {}, ["hmm"]);
  const turns: ConversationRun[] = [];
  // 0: 150 actions in a row: not more than the threshold, so nothing is deferred.
  turns.push(finishedRun(0, [userItem("run-0", "q"), ...Array.from({ length: 150 }, (_, index) => command("run-0", index + 2))]));
  // 1: 151 actions in a row: the first 25 and the last 25 of the stretch stay, 101 in between are deferred (seq 27 to 127).
  turns.push(finishedRun(1, [userItem("run-1", "q"), ...Array.from({ length: 151 }, (_, index) => command("run-1", index + 2))]));
  // 2: 200 actions with a completed reasoning segment after each: one stretch of 400 (the reasoning between actions does not end it).
  turns.push(finishedRun(2, [userItem("run-2", "q"), ...Array.from({ length: 200 }, (_, index) => [command("run-2", 2 + index * 2), think("run-2", 3 + index * 2)]).flat()]));
  // 3: 100 actions, one still going, 100 more; and a reply in the middle of another 160: nothing reaches 150 in a stretch.
  turns.push(finishedRun(3, [userItem("run-3", "q"), ...Array.from({ length: 100 }, (_, index) => command("run-3", index + 2)), command("run-3", 102, "running"), ...Array.from({ length: 100 }, (_, index) => command("run-3", index + 103))]));
  turns.push(finishedRun(4, [userItem("run-4", "q"), ...Array.from({ length: 80 }, (_, index) => command("run-4", index + 2)), replyItem("run-4", 82, 1, "completed", ["in the middle"]), ...Array.from({ length: 80 }, (_, index) => command("run-4", index + 83))]));
  // 5: two long stretches, 200 and 160, with a failed action in between: the longer one is deferred.
  turns.push(finishedRun(5, [userItem("run-5", "q"), ...Array.from({ length: 160 }, (_, index) => command("run-5", index + 2)), command("run-5", 162, "failed"), ...Array.from({ length: 200 }, (_, index) => command("run-5", index + 163))]));
  seedConverted(env, conversation(turns, { version: 1, lastSeq: 5 }));
  const all = tables.older(SESSION, encodeTurnCursor({ ordinal: 6, lastSeq: 5 }), { turns: 6, bytes: Infinity }).turns;
  assert.deepEqual(all.map(turn => turn.deferred), [undefined, { fromSeq: 27, toSeq: 127, count: 101 }, { fromSeq: 2 + 25, toSeq: 2 + 400 - 1 - 25, count: 400 - 50 }, undefined, undefined, { fromSeq: 163 + 25, toSeq: 362 - 25, count: 150 }]);
  assert.deepEqual(all.map(turn => turn.items.length), [151, 152 - 101, 401 - 350, 202, 162, 362 - 150]);
  assert.ok(all[1]!.items.every(it => it.seq < 27 || it.seq > 127));
  // The deferred stretch is read through the items page: from just before it, as many as it holds and the next page's first.
  const [turn1] = [all[1]!];
  const stretch = tables.items(turn1.run.runId, turn1.deferred!.fromSeq - 1, turn1.deferred!.count);
  assert.deepEqual(stretch.items.map(it => it.seq), Array.from({ length: 101 }, (_, index) => 27 + index));
  assert.equal(stretch.next, 127);
  assert.equal(tables.items(turn1.run.runId, 127, 50).next, null);
  // A Turn read by ordinal is never folded.
  assert.equal(tables.turnAt(SESSION, 1)!.items.length, 152); assert.equal(tables.turnAt(SESSION, 1)!.deferred, undefined);
});

test("a Turn's items come in pages by place, once each, and a page says where the next starts", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  seedConverted(env, conversation([finishedRun(0, [userItem("run-0", "q"), ...Array.from({ length: 999 }, (_, index) => toolItem("run-0", index + 2, "t" + index, "completed"))])], { version: 1, lastSeq: 5 }));
  const seen: number[] = [];
  let after = 0, pages = 0;
  for (;;) { const page = tables.items("run-0" as never, after, 128); seen.push(...page.items.map(it => it.seq)); pages++; if (page.next === null) break; assert.equal(page.next, page.items[page.items.length - 1]!.seq); after = page.next; }
  assert.equal(pages, 8); assert.deepEqual(seen, Array.from({ length: 1000 }, (_, index) => index + 1));
  assert.equal(tables.items("run-0" as never, 872, 128).next, null, "a page that ends where the Turn ends has no next");
  assert.equal(tables.items("run-0" as never, 871, 128).next, 999);
  assert.deepEqual(tables.items("run-0" as never, 5000, 10), { items: [], next: null });
  assert.deepEqual(tables.items("run-nowhere" as never, 0, 10), { items: [], next: null });
  assert.equal(tables.turnAt(SESSION, 7), null);
});

test("an item whose JSON is longer than a page carries is left out and read whole on request; its type and place stay", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const changes = Array.from({ length: 5000 }, (_, index) => ({ path: "/work/space/src/module-" + index + ".ts", op: "modify", added: index, removed: 1 }));
  seedConverted(env, conversation([finishedRun(0, [userItem("run-0", "q"), item("run-0", 2, "tool:edit", "file_change", "completed", { changes }), toolItem("run-0", 3, "small", "completed")])], { version: 1, lastSeq: 5 }));
  const read = tables.window(SESSION), window = read.turns[0]!;
  const [user, edit, small] = window.items;
  assert.deepEqual([edit!.type, edit!.seq, edit!.status, edit!.bodyOmitted], ["file_change", 2, "completed", true]);
  assert.deepEqual(edit!.fields, { type: "file_change", changes: [] });
  assert.equal(small!.bodyOmitted, undefined); assert.equal((small!.fields as { command?: string }).command, "echo small"); assert.equal(user!.text.join(""), "q");
  assert.ok(read.bytes < 2048, "the Turn weighs " + read.bytes + " bytes");
  const whole = tables.items("run-0" as never, 1, 1, { inlineBytes: Infinity }).items[0]!;
  assert.equal(whole.bodyOmitted, undefined); assert.deepEqual((whole.fields as unknown as { changes: unknown[] }).changes, changes);
});

// ---------------------------------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------------------------------

test("search: three characters or more by the trigram index, one or two Chinese characters by the per-character index, shorter Latin words by a scan that says so", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  // Each reply is written in two chunks, so that some words stand across the cut.
  const texts = [
    ["Please migrate the relay mark", "迁移保真校验与接力水位 and the Relay Mark are kept"],
    ["Where is the packet", "The packet is in the 交接单 and the ledger"],
    ["no Chinese here", "just the word re-mark and go"],
  ];
  const state = seedConverted(env, conversation(texts.map(([user, reply], ordinal) => finishedRun(ordinal, [userItem("run-" + ordinal, user!), replyItem("run-" + ordinal, 2, 1, "completed", [reply!.slice(0, 7), reply!.slice(7)])])), { version: 1, lastSeq: 5 }));
  assert.equal(state.runs.length, 3);
  const hits = (query: string, scope: Partial<Parameters<ConversationTables["search"]>[1]> = {}) => tables.search(query, { limit: 50, ...scope }).map(hit => [hit.ordinal, hit.itemSeq, hit.via].join(":"));
  // The indexes are not made yet (a converted database starts without them): every query scans, and says so.
  assert.deepEqual(hits("relay mark"), ["0:2:scan", "0:1:scan"]);
  assert.deepEqual(hits("接力"), ["0:2:scan"]);
  assert.equal(rebuildSearchIndex(env.db, NOW), 6);
  assert.deepEqual(hits("relay mark"), ["0:2:trigram", "0:1:trigram"], "newest first, a phrase, case folded");
  assert.deepEqual(hits("RELAY"), ["0:2:trigram", "0:1:trigram"]);
  assert.deepEqual(hits("packet"), ["1:2:trigram", "1:1:trigram"], "a word across two chunks is found");
  assert.deepEqual(hits("交接单"), ["1:2:trigram"], "three Chinese characters are a trigram");
  assert.deepEqual(hits("接力"), ["0:2:chars"], "two Chinese characters");
  assert.deepEqual(hits("交接"), ["1:2:chars"]);
  assert.deepEqual(hits("接"), ["1:2:chars", "0:2:chars"], "one Chinese character");
  assert.deepEqual(hits("力接"), [], "the characters in order");
  assert.deepEqual(hits("re"), ["2:2:scan", "2:1:scan", "1:1:scan", "0:2:scan", "0:1:scan"], "two Latin characters: a scan");
  assert.deepEqual(hits("ck"), ["1:2:scan", "1:1:scan"], "a scan reads the joined text: the two characters stand either side of a cut between chunks in one of them");
  assert.deepEqual(hits("go"), ["2:2:scan"]);
  assert.deepEqual(hits("zz"), []);
  assert.deepEqual(hits("   "), []);
  assert.deepEqual(hits('say "hello" now'), [], "a quote is a character");
  // A phrase is a phrase: the words in this order, next to one another.
  assert.deepEqual(hits("mark relay"), []);
  assert.deepEqual(hits("packet ledger"), []);
  // Scope: one conversation, and a conversation that was deleted is not searched.
  assert.deepEqual(hits("packet", { sessionId: sessionId("session-other") }), []);
  assert.deepEqual(hits("packet", { sessionId: SESSION }), ["1:2:trigram", "1:1:trigram"]);
  env.db.prepare("UPDATE sessions SET deleted_at=? WHERE id=?").run(NOW, SESSION);
  assert.deepEqual(hits("packet"), []);
});

test("search pages continue from the last hit they gave, whatever is written meanwhile, and a segment that finishes after the index was made is in it", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const turns = Array.from({ length: 25 }, (_, ordinal) => finishedRun(ordinal, [userItem("run-" + ordinal, "a needle in haystack " + ordinal), replyItem("run-" + ordinal, 2, 1, "completed", ["no hit here"])]));
  let state = seedConverted(env, conversation(turns, { version: 1, lastSeq: 5 }));
  rebuildSearchIndex(env.db, NOW);
  const first = tables.search("needle", { limit: 10 });
  assert.equal(first.length, 10); assert.ok(first.every(hit => hit.via === "trigram" && hit.itemSeq === 1));
  assert.ok(first.every((hit, index) => index === 0 || hit.id < first[index - 1]!.id), "newest first");
  // A new Turn finishes with a match while the reader is on its first page: it is found by a new search, and the next page is the same page as it was.
  const active = run(25, "running", [userItem("run-25", "the newest needle"), replyItem("run-25", 2, 1, "running", ["still writing a needle"])], { timing: { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 } });
  state = commit(env, state, reduce(state, current => ({ activeRunId: active.id, runs: [...current.runs, active], commands: [...current.commands, sendCommand(25)] })), [event("message.accepted", { runId: "run-25" }), event("run.started")]).conversation;
  assert.deepEqual(tables.search("needle", { limit: 100 }).map(hit => hit.ordinal).slice(0, 2), [25, 24], "the user message is a finished message; the segment still being written is not");
  state = commit(env, state, reduce(state, current => ({ activeRunId: null, runs: replaceRun(current, 25, entry => ({ ...entry, status: "completed", ...completed, items: entry.items!.map(it => ({ ...it, status: "completed" as const })) })) })), [event("run.ended", { runId: "run-25" })]).conversation;
  const everything = tables.search("needle", { limit: 100 });
  assert.deepEqual(everything.slice(0, 3).map(hit => [hit.ordinal, hit.itemSeq]), [[25, 2], [25, 1], [24, 1]]);
  assert.equal(everything.length, 27);
  const later: number[] = [];
  for (let after = first[9]!.id; ;) { const page = tables.search("needle", { limit: 10, after }); later.push(...page.map(hit => hit.id)); if (page.length < 10) break; after = page[9]!.id; }
  assert.deepEqual([...first.map(hit => hit.id), ...later], everything.filter(hit => hit.ordinal < 25).map(hit => hit.id), "the pages that follow are the pages there were: nothing repeated, nothing missed");
  assert.equal(later.length, 15);
  assert.deepEqual(state.runs[25]!.items, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// What the store answers from columns and indexes
// ---------------------------------------------------------------------------------------------------------------------

function insertHead(env: Env, id: string, values: Partial<HeadRow> & { readonly workspace?: string } = {}): void {
  const { workspace = "/work/" + id, ...row } = values;
  const mutation: Mutation = { head: { row: { id: sessionId(id), version: 0, lastSeq: 0, format: 14, status: "open", epoch: 1, activeRunId: null, pendingSwitchId: null, kept: false, title: "title of " + id, runCount: 0, updatedAt: NOW, deletedAt: null, lastError: null,
    head: { configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: false }, selection: { harnessId: "alpha", controlId: "alpha-acp" } }, ...row } }, events: [] };
  applyMutation(env.db, mutation, { ownerGeneration: 1, timestamp: STAMP });
}

test("the conversation list is a page of columns, newest first, found by a cursor that holds a place and not a count: every conversation once, a deleted or unconverted one never", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  env.db.exec("BEGIN");
  for (let index = 0; index < 5000; index++) insertHead(env, "session-" + String(index).padStart(4, "0"), { updatedAt: NOW + (index % 1000), title: "conversation " + index, runCount: index % 7 });
  env.db.exec("COMMIT");
  env.db.prepare("UPDATE sessions SET deleted_at=1 WHERE id=?").run("session-0001");
  env.db.prepare("INSERT INTO sessions(id,version,last_seq,head,format) VALUES('session-old',1,1,'{}',13)").run();
  const [first, firstMs] = elapsed(() => tables.list());
  assert.equal(first.rows.length, PAGE.sessions); assert.ok(first.next !== null);
  assert.deepEqual(first.rows[0], { id: "session-0999", title: "conversation 999", status: "open", workspace: "/work/session-0999", selection: { harnessId: "alpha", controlId: "alpha-acp" }, updatedSeq: 0, updatedAt: NOW + 999, activeRunId: null, runCount: 999 % 7 });
  const seen: string[] = [];
  let page = first, pages = 1;
  const [, walkMs] = elapsed(() => { for (;;) { seen.push(...page.rows.map(row => row.id)); if (page.next === null) break; page = tables.list({ after: page.next, limit: PAGE.sessions }); pages++; } });
  assert.equal(pages, 50); assert.equal(seen.length, 4999); assert.equal(new Set(seen).size, 4999);
  assert.ok(!seen.includes("session-0001") && !seen.includes("session-old"));
  // Newest first, ties by id.
  const all = tables.list({ limit: 6000 }).rows;
  assert.ok(all.every((row, index) => index === 0 || row.updatedAt < all[index - 1]!.updatedAt || (row.updatedAt === all[index - 1]!.updatedAt && row.id > all[index - 1]!.id)));
  assert.deepEqual(all.map(row => row.id), seen);
  assert.equal(tables.list({ limit: 3 }).rows.length, 3);
  assert.throws(() => tables.list({ after: "garbage" as never }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_CURSOR");
  const listPlan = env.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE deleted_at IS NULL AND format=14 AND updated_at<=? AND (updated_at<? OR id>?) ORDER BY updated_at DESC, id LIMIT ?").all(1, 1, "x", 1).map(row => String(row.detail)).join(" | ");
  assert.match(listPlan, /SEARCH sessions USING INDEX sessions_listing \(updated_at<\?\)/u, "a page is found by entering the index at the cursor: " + listPlan);
  console.log("list of 5,000 conversations: first page of 100 in " + fixed(firstMs) + " ms; all 50 pages in " + fixed(walkMs) + " ms (" + fixed(walkMs / 50) + " ms a page)");
});

test("recovery asks for the conversations with work not finished and the ones that keep a native process, by the partial indexes", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const started = { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 };
  const create = (id: string): Conversation => commit(env, null, conversation([], { id: sessionId(id) }), [event("session.created")], { title: id }).conversation;
  const queue = (state: Conversation, prefix: string): Conversation => commit(env, state, reduce(state, current => ({ runs: [run(0, "queued", [userItem(prefix + "-0", "waiting")], {}, prefix)], commands: [...current.commands, sendCommand(0, prefix)] })), [event("message.accepted", { runId: prefix + "-0" })], { title: state.id }).conversation;
  const go = (state: Conversation): Conversation => commit(env, state, reduce(state, current => ({ activeRunId: current.runs[0]!.id, runs: replaceRun(current, 0, entry => ({ ...entry, status: "running", timing: started })) })), [event("run.started")], { title: state.id }).conversation;
  const end = (state: Conversation): Conversation => commit(env, state, reduce(state, current => ({ activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status: "completed", ...completed })) })), [event("run.ended")], { title: state.id }).conversation;
  // a: a Turn finished. b: a Turn queued. c: a switch pending. d: nothing. e: a Turn running. f: not converted yet.
  end(go(queue(create("session-a"), "run-a")));
  queue(create("session-b"), "run-b");
  const c = create("session-c");
  commit(env, c, reduce(c, current => ({ pendingSwitchId: switchId("switch-c"), commands: [...current.commands, { id: "command-switch-c" as never, kind: "switch", fingerprint: "s".repeat(64), resultId: "switch-c" }],
    switches: [{ id: switchId("switch-c"), commandId: "command-switch-c" as never, requested: { harnessId: "beta" }, requestedSeq: 2, target: null, status: "requested", throughSeq: 0, sourceRunIds: [], error: null }] })), [event("switch.requested")], { title: "c" });
  create("session-d");
  go(queue(create("session-e"), "run-e"));
  env.db.prepare("INSERT INTO sessions(id,version,last_seq,head,format) VALUES('session-f',1,1,'{}',13)").run();
  assert.deepEqual(tables.unfinished(), ["session-b", "session-c", "session-e"]);
  assert.deepEqual(tables.listKept(), []);
  env.db.prepare("UPDATE sessions SET kept=1 WHERE id='session-a'").run();
  assert.deepEqual(tables.listKept(), ["session-a"]);
  const plan = (sql: string) => env.db.prepare("EXPLAIN QUERY PLAN " + sql).all().map(row => String(row.detail)).join(" | ");
  assert.match(plan("SELECT r.session_id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.status IN ('queued','preparing','running','settling') AND s.format=14"), /runs_open/u);
  assert.match(plan("SELECT id FROM sessions WHERE kept=1 AND format=14"), /sessions_kept/u);
  assert.match(plan("SELECT id FROM sessions WHERE pending_switch_id IS NOT NULL AND format=14"), /sessions_pending_switch/u);
});

test("the native sessions a conversation holds are found by control, the content any conversation refers to is the set the collector keeps, and the startups are the newest few of each entry", t => {
  const env = openDatabase(t), tables = tablesOf(env);
  const relay = { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false };
  const binding = (checkpoint: string, extra: Partial<NativeSessionBinding> = {}): NativeSessionBinding => ({ harnessId: "alpha", controlId: "alpha-acp", checkpoint, throughRunId: null, status: "ready", relay, ...extra });
  const withBindings = (id: string, bindings: readonly NativeSessionBinding[]) => commit(env, null, conversation([], { id: sessionId(id), nativeBindings: bindings }), [event("session.created")], { title: id }).conversation;
  // The epochs of one control go up along its bindings: the archived one first.
  withBindings("session-one", [binding("native-old", { status: "archived" }), binding("native-1", { relay: { ...relay, epoch: 2 } }), { ...binding("native-fresh", { controlId: "other-acp" }), opensNew: true }]);
  withBindings("session-two", [binding("native-2", { status: "unconfirmed" }), binding("native-3", { harnessId: "beta", controlId: "beta-acp" })]);
  // A conversation not converted yet is read from its snapshot.
  env.db.prepare("INSERT INTO sessions(id,version,last_seq,head,format) VALUES(?,?,?,?,13)").run("session-legacy", 1, 1, JSON.stringify({ nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-legacy", status: "ready", throughRunId: null },
    { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-legacy-new", status: "ready", opensNew: true, throughRunId: null }],
    runs: [{ tools: [{ id: "x", detail: { id: "content-legacy-detail" } }], outputs: [{ kind: "content", content: { id: "content-legacy-output" } }, { kind: "link", uri: "https://example.test", name: "n" }], attachments: [{ id: "content-legacy-attachment" }] }], origin: { history: [{ attachments: [{ id: "content-legacy-quoted" }] }, {}] } }));
  assert.deepEqual([...tables.nativeOwners("alpha", "alpha-acp")], [["native-1", "session-one"], ["native-2", "session-two"], ["native-legacy", "session-legacy"]]);
  assert.deepEqual([...tables.nativeOwners("beta", "beta-acp")], [["native-3", "session-two"]]);
  assert.deepEqual([...tables.nativeOwners("alpha", "nothing")], []);
  // Content.
  env.db.prepare("INSERT INTO content_refs(content_id,session_id,run_id,item_seq,role) VALUES('content-a','session-one',NULL,NULL,'origin_attachment'),('content-b','session-two','run-x',3,'tool_detail'),('content-a','session-two',NULL,NULL,'origin_attachment')").run();
  assert.deepEqual([...tables.contentReferences()].sort(), ["content-a", "content-b", "content-legacy-attachment", "content-legacy-detail", "content-legacy-output", "content-legacy-quoted"]);
  // Startups: the newest three of each entry, not those of a Run that kept its program (reused) or that never got ready.
  const sessionRuns = (id: string, harness: string, control: string, startups: readonly (readonly [number, number | null, boolean?])[]) => {
    const prefix = "run-" + id.slice("session-".length);
    const runs = startups.map(([prepared, ready, reused], ordinal) => finishedRun(ordinal, [userItem(prefix + "-" + ordinal, "q")], prefix, { selection: { harnessId: harness, controlId: control }, timing: { acceptedAt: prepared - 1, preparingAt: prepared, ...(ready === null ? {} : { readyAt: ready }), dispatchedAt: prepared + 5 }, ...(reused === true ? { reused: true as const } : {}) }));
    seedConverted(env, conversation(runs, { id: sessionId(id) }), 1, 5);
  };
  sessionRuns("session-s1", "alpha", "alpha-acp", [[1000, 1300], [2000, 2100], [3000, 3600], [4000, 4200], [5000, null], [6000, 6001, true]]);
  sessionRuns("session-s2", "alpha", "alpha-acp", [[2500, 2900]]);
  sessionRuns("session-s3", "beta", "beta-acp", [[10, 70]]);
  assert.deepEqual(tables.startupSamples(3), [
    { harnessId: "alpha", controlId: "alpha-acp", preparingAt: 4000, readyAt: 4200 }, { harnessId: "alpha", controlId: "alpha-acp", preparingAt: 3000, readyAt: 3600 }, { harnessId: "alpha", controlId: "alpha-acp", preparingAt: 2500, readyAt: 2900 },
    { harnessId: "beta", controlId: "beta-acp", preparingAt: 10, readyAt: 70 }]);
  assert.equal(tables.startupSamples(100).length, 6);
  assert.match(env.db.prepare("EXPLAIN QUERY PLAN SELECT preparing_at, ready_at FROM runs WHERE harness_id='a' AND control_id='b' AND ready_at IS NOT NULL AND reused=0 AND preparing_at IS NOT NULL ORDER BY preparing_at DESC LIMIT 3").all().map(row => String(row.detail)).join(" | "), /runs_startup/u);
});
