import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { builtinHarnessName } from "../../src/cli/session-application.js";
import { carriedNativeConfiguration } from "../../src/contexts/session/domain/state.js";
import type { ContentRef } from "../../src/contracts/content.js";
import { PAGE, type Conversation, type ConversationCommit, type ConversationRun, type HeldItem } from "../../src/contracts/conversation.js";
import { SessionError, sessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { conversationTitle, type SessionViewV14, type WireItem } from "../../src/contracts/web.js";
import { ConversationFacts } from "../../src/infrastructure/session/facts.js";
import { ConversationTables, decodeTurnCursor } from "../../src/infrastructure/session/read.js";
import { ConversationRoutes, type ConversationRoutesOptions } from "../../src/web/conversation-routes.js";
import { commandId } from "../../src/contracts/session.js";
import { SESSION, bytes, commit, conversation, event, item, openDatabase, reduce, replyItem, run, seedConverted, sendCommand, toolItem, userItem, type Env } from "../fixtures/conversation-builder.js";
import { migrated } from "../fixtures/migrated.js";
import { Scenario, created as storeCreated, newConversation, openStore, rawDatabase } from "../fixtures/store-helpers.js";
import { V13_FIXTURES } from "../fixtures/storage/v13/database.js";
import { syntheticFixture } from "../fixtures/synthetic-v13.js";

// The reads of a conversation kept as rows, as the web API answers them (src/web/conversation-routes.ts), on real databases: one migrated from the frozen v13 form, and ones made by
// the writes of the store. Bounded by the window and not by the conversation; every Turn reached by cursor; a text however long read back by byte range, to the byte.

const harnessName = builtinHarnessName();
const routesOf = (db: DatabaseSync, over: Partial<ConversationRoutesOptions> = {}): ConversationRoutes =>
  new ConversationRoutes({ reader: new ConversationTables(db), facts: new ConversationFacts(db), relay: () => () => ({}), env: { harnessName }, ...over });
const size = (value: unknown): number => bytes(JSON.stringify(value));
const completed = { backend: { status: "completed" as const, reason: "end_turn" }, cleanup: { closed: true as const, exitCode: 0, signal: null, protocolFailure: null } };
const finished = (ordinal: number, items: readonly HeldItem[], extra: Partial<ConversationRun> = {}): ConversationRun => run(ordinal, "completed", items, { endedSeq: 100 + ordinal, ...completed, ...extra });
const simple = (ordinal: number): ConversationRun => finished(ordinal, [userItem("run-" + ordinal, "question " + ordinal), item("run-" + ordinal, 2, "text:1", "assistant_message", "completed", { messageId: "message-reply-run-" + ordinal }, ["answer ", String(ordinal)])]);
const ordinals = (view: { readonly turns: readonly { readonly run: { readonly ordinal: number } }[] }): number[] => view.turns.map(turn => turn.run.ordinal);
const invalid = (error: unknown): boolean => error instanceof SessionError && error.code === "INVALID_INPUT";
const code = (expected: string) => (error: unknown): boolean => error instanceof SessionError && error.code === expected;
const textOf = (entry: WireItem): string | undefined => (entry as { text?: string }).text;

test("a conversation of 2,000 Turns opens as its head and a window of the newest ten, the size of which does not follow the conversation, and is walked back to the first Turn once each", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  const seeded = seedConverted(env, conversation(Array.from({ length: 2000 }, (_, ordinal) => simple(ordinal)), { version: 1, lastSeq: 5 }));
  const opened = routes.session(SESSION);
  assert.deepEqual(ordinals(opened.window), [1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999]);
  assert.deepEqual([opened.head.id, opened.head.runCount, opened.head.lastSeq, opened.head.version, opened.head.title], [SESSION, 2000, 5, seeded.version, "old question"]);
  assert.ok(opened.window.older !== null);
  // The bytes follow the window: the same conversation of 20 Turns opens in as many bytes.
  const small = openDatabase(t);
  seedConverted(small, conversation(Array.from({ length: 20 }, (_, ordinal) => simple(ordinal)), { version: 1, lastSeq: 5 }));
  assert.ok(size(opened) < 32 * 1024, "the view of 2,000 Turns is " + size(opened) + " bytes");
  assert.ok(Math.abs(size(opened) - size(routesOf(small.db).session(SESSION))) < 512, "and does not follow the history (" + size(opened) + " against " + size(routesOf(small.db).session(SESSION)) + ")");
  // A Turn as the page draws it: the user's words and the reply's, in its items.
  const last = opened.window.turns[9]!;
  assert.deepEqual(last.items.map(entry => [entry.type, entry.seq, textOf(entry)]), [["user_message", 1, "question 1999"], ["assistant_message", 2, "answer 1999"]]);
  assert.equal(last.items[1]!.type === "assistant_message" ? last.items[1].phase : null, "final");
  assert.equal(last.run.turn.n, 2000);
  // Back through the conversation by the cursor each page gives: every Turn once, in order, whatever the size of a page.
  for (const limit of [undefined, 1, 7, 20, 333, 5000]) {
    const seen: number[] = [...ordinals(opened.window)];
    let cursor: string | null = opened.window.older, pages = 0;
    while (cursor !== null) {
      const page = routes.turns(SESSION, { before: cursor, ...(limit === undefined ? {} : { limit }) });
      assert.ok(page.turns.length > 0 && page.turns.length <= (limit ?? PAGE.olderTurns));
      seen.unshift(...ordinals(page)); cursor = page.older; pages++;
      assert.ok(pages <= 2000, "the walk ends");
    }
    assert.deepEqual(seen, Array.from({ length: 2000 }, (_, ordinal) => ordinal), "limit " + limit);
    // A page size above what is left is not a ceiling on the walk; what one page carries at most is its byte budget, so the walk is a few pages, not a thousand.
    if (limit === 5000) assert.ok(pages <= 3, "a page of 5000 Turns reached the first Turn in " + pages + " pages");
    if (limit === undefined) assert.equal(pages, 100);
  }
  // The same limit as a string of a URL.
  assert.equal(routes.turns(SESSION, { before: opened.window.older!, limit: "3" }).turns.length, 3);
});

test("a page of older Turns is the same page when new Turns arrive after the cursor was given", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  let state: Conversation = seedConverted(env, conversation(Array.from({ length: 60 }, (_, ordinal) => simple(ordinal)), { version: 1, lastSeq: 5 }));
  const before = routes.session(SESSION), page = routes.turns(SESSION, { before: before.window.older! });
  assert.deepEqual(ordinals(page), Array.from({ length: 20 }, (_, index) => 30 + index));
  for (let ordinal = 60; ordinal < 64; ordinal++) {
    state = commit(env, state, reduce(state, current => ({ runs: [...current.runs, run(ordinal, "queued", [userItem("run-" + ordinal, "late " + ordinal)])], commands: [...current.commands, sendCommand(ordinal)] })), [event("message.accepted", { runId: "run-" + ordinal })]).conversation;
  }
  const again = routes.turns(SESSION, { before: before.window.older! });
  assert.deepEqual(JSON.parse(JSON.stringify(again.turns)), JSON.parse(JSON.stringify(page.turns)), "the page the old cursor names is the page it named");
  assert.equal(decodeTurnCursor(again.older!).ordinal, decodeTurnCursor(page.older!).ordinal, "and the cursor to the page before it names the same Turn");
  const now = routes.session(SESSION);
  assert.deepEqual(ordinals(now.window), [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);
  assert.equal(now.head.runCount, 64);
  assert.equal(now.window.turns[9]!.run.turn.status, "queued");
});

// ---------------------------------------------------------------------------------------------------------------------
// A conversation migrated from the form v13 kept
// ---------------------------------------------------------------------------------------------------------------------

test("a conversation the v13 runtime wrote at its limits (256 Turns of long replies, thinking and calls), migrated, is opened by its window and read back whole by cursor and by range", t => {
  const m = migrated(t, syntheticFixture(1, { runs: 256, replyBytes: 24_000, thinkingBytes: 2_000, tools: 6 })), routes = routesOf(m.db);
  const id = m.fixture.sessions[0]!.id, original = m.fixture.sessions[0]!.snapshot as unknown as SessionSnapshot;
  const opened = routes.session(id);
  assert.deepEqual(ordinals(opened.window), original.runs.slice(-10).map((_, index) => 246 + index));
  assert.ok(size(opened) < PAGE.windowBytes + 64 * 1024, "the window is " + size(opened) + " bytes, and the conversation " + Buffer.byteLength(JSON.stringify(original)) + " in all");
  assert.equal(opened.head.runCount, 256); assert.equal(opened.head.title, conversationTitle(original));
  // Every Turn once, in order, by the cursors; every reply whole (24 KB is under what a page carries).
  const seen: SessionViewV14["window"]["turns"][number][] = [...opened.window.turns];
  for (let cursor = opened.window.older; cursor !== null;) { const page = routes.turns(id, { before: cursor, limit: 40 }); seen.unshift(...page.turns); cursor = page.older; }
  assert.deepEqual(seen.map(turn => turn.run.ordinal), Array.from({ length: 256 }, (_, ordinal) => ordinal));
  seen.forEach((turn, ordinal) => {
    const wanted = original.messages.filter(message => message.runId === original.runs[ordinal]!.id);
    assert.equal(turn.run.turn.legacyOrder, true);
    assert.deepEqual(turn.items.map(entry => entry.type), ["user_message", "reasoning", "command", "command", "command", "command", "command", "command", "assistant_message"].slice(0, 9));
    assert.equal(textOf(turn.items[0]!), wanted[0]!.text); assert.equal(textOf(turn.items[8]!), wanted[1]!.text);
    assert.equal(textOf(turn.items[1]!), original.runs[ordinal]!.thinking);
  });
  // The items of a Turn by place: from just before the third on, two at a time, the second page from where the first said.
  const first = routes.runItems(id, 7, { after: "2", limit: "2" });
  assert.deepEqual(first.items.map(entry => entry.seq), [3, 4]); assert.equal(first.next, 4);
  assert.deepEqual(routes.runItems(id, 7, { after: String(first.next), limit: 2 }).items.map(entry => entry.seq), [5, 6]);
  assert.equal(routes.runItems(id, 7, { after: "8" }).next, null); assert.deepEqual(routes.runItems(id, 7, { after: "9" }), { items: [], next: null });
  // One item whole, and a range of its text.
  const reply = routes.item(id, 7, 9).item as WireItem & { text: string };
  assert.equal(reply.type, "assistant_message"); assert.equal(reply.text, original.messages.filter(message => message.runId === original.runs[7]!.id)[1]!.text);
  assert.deepEqual(routes.itemText(id, 7, 9, { from: "0", to: "10" }), { text: reply.text.slice(0, 10), from: 0, to: 10, total: bytes(reply.text) });
  assert.equal(routes.itemText(id, 7, 9, {}).text, reply.text);
});

// ---------------------------------------------------------------------------------------------------------------------
// A reply of 20 MiB, and a stretch of work of hundreds of calls
// ---------------------------------------------------------------------------------------------------------------------

function longText(chunks: number): string[] {
  const pieces = ["The quick brown fox jumps over the lazy dog. ", "迁移保真校验与接力水位，", "😀🚀 ", "naïve café ", "日本語のテキスト。", "𝒳𝒴𝒵 ", "\n"];
  let at = 0;
  return Array.from({ length: chunks }, () => { let chunk = ""; while (bytes(chunk) < 16 * 1024) chunk += pieces[at++ % pieces.length]!; return chunk; });
}

test("a reply of 20 MiB is left out of the window by its size and read back by byte ranges that join to the reply, byte for byte", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  const chunks = longText(1280), whole = Buffer.from(chunks.join(""), "utf8"), sha = createHash("sha256").update(whole).digest("hex");
  assert.ok(whole.length > 20 * 1024 * 1024 - 100 * 1024, "the reply has " + whole.length + " bytes");
  seedConverted(env, conversation([finished(0, [userItem("run-0", "write a lot"), item("run-0", 2, "text:1", "assistant_message", "completed", { messageId: "message-reply-run-0" }, chunks)])], { version: 1, lastSeq: 5 }));
  const opened = routes.session(SESSION), reply = opened.window.turns[0]!.items[1]!;
  assert.deepEqual([reply.type, reply.bodyOmitted, reply.textBytes, "text" in reply], ["assistant_message", true, whole.length, false]);
  assert.ok(size(opened) < 8 * 1024, "the view of a conversation with a 20 MiB reply is " + size(opened) + " bytes");
  assert.equal(textOf(opened.window.turns[0]!.items[0]!), "write a lot");
  // From the start, a range after another, each from where the last ended: the pieces are the reply.
  const parts: Buffer[] = [];
  let from = 0;
  while (from < whole.length) {
    const range = routes.itemText(SESSION, 0, 2, { from: String(from), to: String(from + 1_000_003) });
    assert.equal(range.total, whole.length); assert.ok(range.from >= from && range.from - from < 4, "a range starts at the next character"); assert.equal(range.from, from === 0 ? 0 : range.from);
    assert.ok(range.to > from, "a range goes on");
    parts.push(Buffer.from(range.text, "utf8")); from = range.to;
    assert.equal(Buffer.concat(parts).length, range.to, "no gap and no repeat");
  }
  assert.equal(createHash("sha256").update(Buffer.concat(parts)).digest("hex"), sha);
  // The item whole is the reply whole.
  const full = routes.item(SESSION, 0, 2).item as WireItem & { text: string };
  assert.equal(full.bodyOmitted, undefined); assert.equal(createHash("sha256").update(Buffer.from(full.text, "utf8")).digest("hex"), sha);
});

test("the middle of a long stretch of finished work is left out of the window and read by place, so that the window and the stretch are the Turn", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  const calls = Array.from({ length: 400 }, (_, index) => toolItem("run-0", index + 2, "t" + index, "completed"));
  seedConverted(env, conversation([finished(0, [userItem("run-0", "do a lot"), ...calls, item("run-0", 402, "text:1", "assistant_message", "completed", { messageId: "message-reply-run-0" }, ["done"])])], { version: 1, lastSeq: 5 }));
  const turn = routes.session(SESSION).window.turns[0]!;
  assert.deepEqual(turn.deferred, { fromSeq: 2 + PAGE.deferredKeep, toSeq: 401 - PAGE.deferredKeep, count: 400 - 2 * PAGE.deferredKeep });
  assert.equal(turn.items.length, 2 + 2 * PAGE.deferredKeep);
  // The stretch is read from just before it on, as many as it holds; the last page says it is the last.
  const stretch = [];
  for (let after = turn.deferred!.fromSeq - 1; ;) {
    const page = routes.runItems(SESSION, 0, { after: String(after), limit: "64" });
    stretch.push(...page.items.filter(entry => entry.seq <= turn.deferred!.toSeq));
    if (page.next === null || page.items.at(-1)!.seq >= turn.deferred!.toSeq) break;
    after = page.next;
  }
  assert.equal(stretch.length, turn.deferred!.count);
  const joined = [...turn.items.filter(entry => entry.seq < turn.deferred!.fromSeq), ...stretch, ...turn.items.filter(entry => entry.seq > turn.deferred!.toSeq)];
  assert.deepEqual(joined.map(entry => entry.seq), Array.from({ length: 402 }, (_, index) => index + 1));
});

// ---------------------------------------------------------------------------------------------------------------------
// The shape of a request, and what is not there
// ---------------------------------------------------------------------------------------------------------------------

test("a request that is not the shape it must be is refused as such, and one for what is not there says so", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  seedConverted(env, conversation([simple(0), simple(1), simple(2)], { version: 1, lastSeq: 5 }));
  const cursor = routes.session(SESSION).window.older;
  assert.equal(cursor, null, "three Turns are the window");
  const some = routes.turns(SESSION, { before: Buffer.from(JSON.stringify({ ordinal: 2, lastSeq: 5 })).toString("base64url") });
  assert.deepEqual(ordinals(some), [0, 1]);
  for (const before of ["not a cursor", "", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ ordinal: -1, lastSeq: 5 })).toString("base64url"), Buffer.from(JSON.stringify({ ordinal: 99, lastSeq: 5 })).toString("base64url")]) {
    assert.throws(() => routes.turns(SESSION, { before }), invalid, "before=" + before);
  }
  assert.throws(() => routes.turns(SESSION, {}), invalid);
  const valid = Buffer.from(JSON.stringify({ ordinal: 2, lastSeq: 5 })).toString("base64url");
  for (const limit of ["0", "-1", "abc", "1.5", "01", " 3", "1e3", "", "9007199254740993", 0, -2, 1.5, Number.NaN]) assert.throws(() => routes.turns(SESSION, { before: valid, limit }), invalid, "limit=" + String(limit));
  assert.deepEqual(ordinals(routes.turns(SESSION, { before: valid, limit: "9007199254740991" })), [0, 1], "the largest whole number is a page size like any other");
  for (const after of ["x", "-1", "1.5"]) assert.throws(() => routes.runItems(SESSION, 0, { after }), invalid, "after=" + after);
  for (const ordinal of ["x", "-1", "1.5", ""]) assert.throws(() => routes.runItems(SESSION, ordinal, {}), invalid, "ordinal=" + ordinal);
  for (const place of ["x", "-1", ""]) assert.throws(() => routes.item(SESSION, 0, place), invalid, "seq=" + place);
  assert.throws(() => routes.itemText(SESSION, 0, 2, { from: "x" }), invalid); assert.throws(() => routes.itemText(SESSION, 0, 2, { to: "-1" }), invalid);
  assert.throws(() => routes.itemText(SESSION, 0, 2, { from: "5", to: "4" }), invalid);
  assert.throws(() => routes.sessions({ after: "garbage" }), invalid); assert.throws(() => routes.sessions({ limit: "0" }), invalid);
  assert.throws(() => routes.session("nonsense"), invalid, "an identity that is none");
  // Not there.
  assert.throws(() => routes.session("session-nowhere"), code("SESSION_NOT_FOUND"));
  assert.throws(() => routes.runItems(SESSION, 7, {}), code("RUN_NOT_FOUND")); assert.throws(() => routes.item(SESSION, 7, 1), code("RUN_NOT_FOUND"));
  assert.throws(() => routes.item(SESSION, 0, 9), code("ITEM_NOT_FOUND")); assert.throws(() => routes.item(SESSION, 0, 0), code("ITEM_NOT_FOUND"), "the place of the hand-over line is no stored item");
  assert.throws(() => routes.itemText(SESSION, 0, 9, {}), code("ITEM_NOT_FOUND"));
  // A range past the end is the end; a conversation that was deleted is not there.
  assert.deepEqual(routes.itemText(SESSION, 0, 1, { from: "1000" }), { text: "", from: "question 0".length, to: "question 0".length, total: "question 0".length });
  env.db.prepare("UPDATE sessions SET deleted_at=? WHERE id=?").run(1, SESSION);
  assert.throws(() => routes.session(SESSION), code("SESSION_NOT_FOUND")); assert.throws(() => routes.turns(SESSION, { before: valid }), code("SESSION_NOT_FOUND")); assert.throws(() => routes.item(SESSION, 0, 1), code("SESSION_NOT_FOUND"));
});

test("the conversations come newest first a page at a time, every one by the cursor, however large the page asked for", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  for (let index = 0; index < 250; index++) {
    const id = sessionId("session-list-" + String(index).padStart(3, "0"));
    commit(env, null, conversation([], { id }), [event("session.created")], { title: "conversation " + index, updatedAt: Date.UTC(2026, 10, 12) + index * 1000 });
  }
  const first = routes.sessions({});
  assert.equal(first.sessions.length, PAGE.sessions); assert.ok(first.next !== null);
  assert.deepEqual(first.sessions[0], { id: "session-list-249", title: "conversation 249", status: "open", workspace: "/work/space", selection: { harnessId: "alpha", controlId: "alpha-acp" }, updatedSeq: 1, activeRunId: null });
  const seen: string[] = [];
  for (let page = first; ;) { seen.push(...page.sessions.map(entry => entry.id)); if (page.next === null) break; page = routes.sessions({ after: page.next, limit: "37" }); }
  assert.equal(seen.length, 250); assert.equal(new Set(seen).size, 250);
  assert.deepEqual(seen, Array.from({ length: 250 }, (_, index) => "session-list-" + String(249 - index).padStart(3, "0")));
  assert.equal(routes.sessions({ limit: 1_000_000 }).sessions.length, 250); assert.equal(routes.sessions({ limit: 1_000_000 }).next, null);
});

// ---------------------------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------------------------

test("the head of every conversation of every frozen fixture says what the old view said of it: the title, the Harnesses' states with what each carried, the switch that waits, where it came from", t => {
  let heads = 0, carried = 0, pending = 0, origins = 0;
  for (const name of V13_FIXTURES) {
    const m = migrated(t, name), routes = routesOf(m.db);
    for (const row of m.fixture.sessions) {
      const snapshot = row.snapshot as unknown as SessionSnapshot, head = routes.head(snapshot.id), stored = m.db.prepare("SELECT * FROM sessions WHERE id=?").get(snapshot.id)!;
      assert.deepEqual([head.id, head.epoch, head.status, head.workspace, head.activeRunId, head.pendingSwitchId, head.runCount, head.title], [snapshot.id, snapshot.epoch, snapshot.status, snapshot.configuration.workspace, snapshot.activeRunId, snapshot.pendingSwitchId, snapshot.runs.length, conversationTitle(snapshot)], name);
      assert.deepEqual([head.version, head.lastSeq], [Number(stored.version), snapshot.lastSeq], name);
      assert.deepEqual(head.selection, snapshot.selection);
      // `nativeStates` as server.ts `view()` made them from the snapshot (with `carriedNativeConfiguration` over the snapshot).
      const expected = (snapshot.nativeBindings ?? []).flatMap(binding => {
        if (binding.status === "archived") return [];
        const kept = binding.harnessId === snapshot.selection.harnessId && binding.controlId === snapshot.selection.controlId ? carriedNativeConfiguration(snapshot, snapshot.selection, snapshot.epoch) : null;
        return [{ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status === "fork-pending" || binding.status === "forking" ? "forking" : binding.status, ...(binding.observed === undefined ? {} : { observed: binding.observed }), ...(kept === null ? {} : { carried: kept }) }];
      });
      assert.deepEqual(JSON.parse(JSON.stringify(head.nativeStates)), JSON.parse(JSON.stringify(expected)), name + "/" + snapshot.id);
      if (expected.some(state => "carried" in state)) carried++;
      assert.deepEqual(head.lastSwitch, snapshot.switches.at(-1));
      if (snapshot.pendingSwitchId !== null) { pending++; assert.equal(head.lastSwitch?.id, snapshot.pendingSwitchId, "the switch that waits is the latest"); }
      assert.deepEqual(head.origin === undefined ? null : JSON.parse(JSON.stringify(head.origin)), snapshot.origin === undefined ? null : JSON.parse(JSON.stringify(snapshot.origin)), name + "/" + snapshot.id + ": the origin");
      if (head.origin !== undefined) origins++;
      assert.deepEqual(head.retention, { enabled: snapshot.retainNative === true, process: null });
      assert.deepEqual(head.permissions, []);
      heads++;
    }
  }
  assert.ok(heads > 30 && pending > 0 && origins > 0, "the fixtures hold " + heads + " conversations, " + carried + " that carry a configuration, " + pending + " with a switch that waits, " + origins + " with an origin");
  // What only the running service knows is brought in by it.
  const m = migrated(t, "kept-process"), live = routesOf(m.db, { live: () => ({ permissions: [], queue: { kind: "slot", runId: "run-x", running: 2, limit: 2, since: 5 }, retention: { process: { harnessId: "alpha", controlId: "alpha-acp", since: 1, lastUsedAt: 2, idleEndsAt: 3, backgroundUpdates: 0 } } }) });
  const head = live.head(m.fixture.sessions[0]!.id);
  assert.deepEqual(head.queue, { kind: "slot", runId: "run-x", running: 2, limit: 2, since: 5 }); assert.equal(head.retention?.process?.since, 1);
});

test("what the native session changed of its configuration since its last Turn is carried to the next, as the old view said it from the snapshot (the fixtures hold none that does)", t => {
  const env = openDatabase(t), routes = routesOf(env.db);
  const relay = { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false };
  const binding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-1", throughRunId: null, status: "ready" as const, observed: { model: "model-b", options: { effort: "high", mode: "plan" } }, relay };
  const selection = { harnessId: "alpha", controlId: "alpha-acp", nativeModel: "model-a", nativeOptions: { effort: "low", mode: "plan" } };
  const created = commit(env, null, conversation([], { selection, nativeBindings: [binding] }), [event("session.created")]).conversation;
  const queued = commit(env, created, reduce(created, current => ({ runs: [run(0, "queued", [userItem("run-0", "hi")], { selection })], commands: [...current.commands, sendCommand(0)] })), [event("message.accepted", { runId: "run-0" })]).conversation;
  const going = commit(env, queued, reduce(queued, current => ({ activeRunId: queued.runs[0]!.id, runs: current.runs.map(entry => ({ ...entry, status: "running" as const, timing: { acceptedAt: 1, preparingAt: 2, readyAt: 3, dispatchedAt: 4 } })) })), [event("run.started")]).conversation;
  commit(env, going, reduce(going, current => ({ activeRunId: null, runs: current.runs.map(entry => ({ ...entry, status: "completed" as const, ...completed })) })), [event("run.ended")]);
  const head = routes.head(SESSION);
  // The old reading, over the snapshot as it stood.
  const snapshot = { nativeBindings: [binding], runs: [{ selection, epoch: 1, timing: { dispatchedAt: 4 }, backend: null, status: "completed" }] } as unknown as SessionSnapshot;
  const expected = carriedNativeConfiguration(snapshot, selection, 1);
  assert.deepEqual(expected, { model: "model-b", options: { effort: "high" } });
  assert.deepEqual(head.nativeStates, [{ harnessId: "alpha", controlId: "alpha-acp", status: "ready", observed: binding.observed, carried: expected }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The changes of the whole conversation
// ---------------------------------------------------------------------------------------------------------------------

const detailRef = (id: string): ContentRef => ({ id: id as ContentRef["id"], name: id + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "a".repeat(64) });
const place = (entry: { readonly ordinal: number; readonly item: { readonly seq: number } }): string => entry.ordinal + ":" + entry.item.seq;

test("the changes of a whole conversation: the head counts the edits, the route gives them newest first a page at a time with the latest plan on the first, and the count the commits moved along is the count a scan finds", t => {
  const { root, data, store } = openStore(t), id = storeCreated(store, newConversation(root, "edits")).conversation.id, scenario = new Scenario(store, id, "run-edits", false);
  const db = rawDatabase(data, true); t.after(() => db.close());
  // The routes that follow the conversation are told each commit the store makes, as the Gateway's stream tells them; a scan is a new set of routes that were told nothing.
  const live = routesOf(db), scanned = (): number => routesOf(db).session(id).head.facts.changes;
  const told: ConversationCommit[] = [], transact = store.transact.bind(store);
  store.transact = ((...args: Parameters<typeof transact>) => { const done = transact(...args); told.push(done); return done; }) as typeof store.transact;
  const follow = (): void => { for (const commit of told.splice(0)) live.observe(commit); };
  const add = (ordinal: number, make: (seq: number) => HeldItem): void => {
    store.transact(id, store.get(id).version, current => ({ next: { ...current, runs: current.runs.map(entry => entry.ordinal === ordinal
      ? { ...entry, items: [...(entry.items ?? []), make(Math.max(0, ...(entry.items ?? []).map(held => held.seq)) + 1)] } : entry) }, events: [event("run.output", { runId: "run-edits-" + ordinal })] }));
    follow();
  };
  const expected: { ordinal: number; seq: number }[] = [];
  const edit = (ordinal: number, seq: number, withDetail: boolean): HeldItem => item("run-edits-" + ordinal, seq, "tool:edit-" + seq, "file_change", "completed",
    { changes: [{ path: "src/file-" + ordinal + "-" + seq + ".ts", op: "modify", added: 1, removed: 0 }], ...(withDetail ? { detail: detailRef("detail-" + ordinal + "-" + seq) } : {}) });
  const planned = (ordinal: number, seq: number, steps: number): HeldItem => item("run-edits-" + ordinal, seq, "plan", "plan", "completed", { steps: Array.from({ length: steps }, (_, step) => ({ text: "step " + step, status: step === 0 ? "completed" : "pending" })) });
  for (let n = 0; n < 60; n++) {
    scenario.accept("edit " + n); follow(); scenario.start(n); follow(); scenario.say(n, "working on " + n); follow();
    for (let k = 0; k < n % 4; k++) add(n, seq => { expected.push({ ordinal: n, seq }); return edit(n, seq, true); });
    // An edit the Harness reported without a stored detail is no change of the conversation to show.
    if (n % 5 === 0) add(n, seq => edit(n, seq, false));
    if (n === 10) add(n, seq => planned(n, seq, 2));
    if (n === 40) add(n, seq => planned(n, seq, 3));
    scenario.finish(n); follow();
    if (n % 7 === 0) assert.equal(live.session(id).head.facts.changes, scanned(), "the count moved along by the commits is the scan's, after Turn " + n);
  }
  assert.equal(expected.length, 90);
  assert.deepEqual([live.session(id).head.facts.changes, scanned()], [90, 90]);
  // The newest edits first, the plan the latest Turn that made one gave.
  const first = live.changes(id, {});
  assert.deepEqual(first.edits.map(place), expected.slice(-40).reverse().map(entry => entry.ordinal + ":" + entry.seq));
  assert.ok(first.next !== null);
  assert.deepEqual([first.plan?.ordinal, first.plan?.item.type, first.plan?.item.type === "plan" ? first.plan.item.steps.length : null], [40, "plan", 3]);
  assert.deepEqual(first.edits[0]!.item.type === "file_change" ? first.edits[0]!.item.changes.map(change => change.path) : null, ["src/file-" + expected.at(-1)!.ordinal + "-" + expected.at(-1)!.seq + ".ts"]);
  assert.equal(first.edits[0]!.harnessId, "alpha");
  // Back through them by the cursor each page gives: every edit once, newest first, whatever the size of a page; the plan is the first page's alone.
  for (const limit of [undefined, 1, 7, 90, 500]) {
    const seen: string[] = [];
    let page = live.changes(id, limit === undefined ? {} : { limit }), pages = 1;
    for (;;) {
      assert.ok(page.edits.length > 0 && page.edits.length <= (limit ?? 40));
      seen.push(...page.edits.map(place));
      if (page.next === null) break;
      page = live.changes(id, { before: page.next, ...(limit === undefined ? {} : { limit: String(limit) }) }); pages++;
      assert.equal("plan" in page, false, "the plan is the first page's alone");
    }
    assert.deepEqual(seen, expected.map(entry => entry.ordinal + ":" + entry.seq).reverse(), "limit " + limit);
    if (limit === 500) assert.equal(pages, 1);
    if (limit === 7) assert.equal(pages, Math.ceil(90 / 7));
  }
  // What is not a request for a page is refused as such, and a conversation that is not there is not found.
  for (const before of ["x", "", "1", "1:0", "-1:2", "1:2:3", "01:2", "1: 2"]) assert.throws(() => live.changes(id, { before }), invalid, "before=" + before);
  for (const limit of ["0", "-1", "x", "1.5", 0, Number.NaN]) assert.throws(() => live.changes(id, { limit }), invalid, "limit=" + String(limit));
  assert.throws(() => live.changes("session-nowhere", {}), code("SESSION_NOT_FOUND"));
  // A cursor that names a place with no edit in it is the place the edits before it end at; one before the first edit gives none.
  assert.deepEqual(live.changes(id, { before: "1:1" }), { edits: [], next: null });
  assert.deepEqual(live.changes(id, { before: expected[0]!.ordinal + ":" + expected[0]!.seq }), { edits: [], next: null });
  // A conversation that never edited has none, and no plan.
  const bare = storeCreated(store, newConversation(root, "bare")).conversation.id, quiet = new Scenario(store, bare, "run-bare", false);
  quiet.turn("nothing to change", "no change");
  assert.deepEqual([live.session(bare).head.facts.changes, routesOf(db).session(bare).head.facts.changes], [0, 0]);
  assert.deepEqual(live.changes(bare, {}), { edits: [], next: null, plan: null });
});

void commandId;
