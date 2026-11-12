import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ContentRef } from "../../src/contracts/content.js";
import type { OriginHistoryRow } from "../../src/contracts/conversation.js";
import { SessionError, commandId, runId, sessionId, type NativeSessionBinding, type SessionId } from "../../src/contracts/session.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/delivery.js";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { snapshotFromRows } from "../../src/infrastructure/session/snapshot-adapter.js";
import { loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { NOW, event, toolItem } from "../fixtures/conversation-builder.js";
import { Scenario, code, count, created, newConversation, openStore, rawDatabase, recoverUnfinished, temporary } from "../fixtures/store-helpers.js";

// What the store answers by column and index and by page, the old shape it gives the readers that have not moved to items, and what deleting a conversation leaves: all through
// the real store on real databases, a Harness and a model made up. A number given here is measured on this machine with other work running.

const sound = (store: SqliteConversationStore, id: SessionId): void => assert.deepEqual(verify(store.get(id), store), []);

test("the list is a page of columns, newest first, with a cursor and no ceiling on how many conversations it reaches", t => {
  let tick = 0;
  const { root, store } = openStore(t, { now: () => new Date(Date.UTC(2026, 10, 12) + (tick++) * 1000) });
  const ids = Array.from({ length: 250 }, (_, index) => created(store, newConversation(root, "n" + String(index).padStart(3, "0"))).conversation.id);
  const everything = store.list({ limit: 1000 });
  assert.equal(everything.rows.length, 250); assert.equal(everything.next, null);
  assert.deepEqual(everything.rows.map(row => row.id), [...ids].reverse(), "the newest first");
  const seen: string[] = [];
  let page = store.list();
  assert.equal(page.rows.length, 100);
  for (;;) { seen.push(...page.rows.map(row => row.id)); if (page.next === null) break; page = store.list({ after: page.next, limit: 100 }); }
  assert.deepEqual(seen, everything.rows.map(row => row.id), "pages of 100 give the same list, each conversation once");
  assert.deepEqual(everything.rows[0], { id: ids[249], title: "新对话", status: "open", workspace: root, selection: { harnessId: "alpha", controlId: "alpha-acp" }, updatedSeq: 1, updatedAt: everything.rows[0]!.updatedAt, activeRunId: null, runCount: 0 });
  // A commit moves a conversation to the top, and the title comes with the first input.
  new Scenario(store, ids[0]!, "run-n000").accept("moved to the top");
  assert.deepEqual([store.list({ limit: 2 }).rows.map(row => row.id), store.list({ limit: 1 }).rows[0]?.title], [[ids[0], ids[249]], "moved to the top"]);
  assert.equal(store.list({ limit: 1 }).rows[0]?.runCount, 1);
  assert.throws(() => store.list({ after: "nonsense" as never }), code("INVALID_CURSOR"));
  // A count that is not a whole number is a bad request, never a failure of SQLite that would take the store with it.
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => store.list({ limit: bad }), code("INVALID_INPUT"), "list " + bad);
    assert.throws(() => store.search("needle", { limit: bad }), code("INVALID_INPUT"), "search " + bad);
    assert.throws(() => store.startupSamples(bad), code("INVALID_INPUT"), "startupSamples " + bad);
    assert.throws(() => store.window(ids[0]!, { turns: bad }), code("INVALID_INPUT"), "window " + bad);
    assert.throws(() => store.items(runId("run-n000-0"), 0, bad), code("INVALID_INPUT"), "items " + bad);
  }
  store.assertOwner();
});

test("a conversation is read by Turn from the store as it is read from the tables: a window, older pages, a Turn's items, a text by byte range, and search by three kinds of word", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "reads")), id = made.conversation.id, scenario = new Scenario(store, id, "run-reads");
  for (let turn = 0; turn < 25; turn++) scenario.turn("question " + turn + (turn === 7 ? " the needle in the haystack" : "") + (turn === 9 ? " 接力 迁移" : ""), "answer " + turn + (turn === 12 ? " 回复里有文件" : ""));
  const window = store.window(id);
  assert.deepEqual(window.turns.map(turn => turn.run.ordinal), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  const older = store.older(id, window.older!);
  assert.equal(older.turns.length, 15); assert.equal(older.older, null);
  assert.deepEqual(store.turnAt(id, 3)!.items.map(item => item.text.join("")), ["question 3", "answer 3"]);
  assert.equal(store.turnAt(id, 99), null);
  const reply = store.turnAt(id, 12)!.items[1]!;
  assert.deepEqual(store.items(reply.runId, 0, 10).items.map(item => item.seq), [1, 2]);
  assert.equal(store.items(reply.runId, 0, 1).next, 1);
  assert.equal(store.text(reply.runId, reply.seq, { from: 0, to: 6 }).text, "answer");
  assert.equal(store.text(reply.runId, reply.seq).text, "answer 12 回复里有文件");
  assert.equal(store.head(id).runCount, 25);
  // A segment that finished is searchable at once on a new database (both indexes are ready): three characters or more by trigram, one or two Chinese characters per character.
  assert.deepEqual(store.search("needle", { limit: 5 }).map(hit => [hit.ordinal, hit.via]), [[7, "trigram"]]);
  assert.deepEqual(store.search("接力", { limit: 5 }).map(hit => [hit.ordinal, hit.via]), [[9, "chars"]]);
  assert.deepEqual(store.search("文件", { limit: 5, sessionId: id }).map(hit => [hit.ordinal, hit.via]), [[12, "chars"]]);
  assert.deepEqual(store.search("answer 1", { limit: 100 }).map(hit => hit.ordinal), [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 1], "newest first, and a page continues from the last hit");
  const firstPage = store.search("answer 1", { limit: 4 });
  assert.deepEqual(store.search("answer 1", { limit: 4, after: firstPage.at(-1)!.id }).map(hit => hit.ordinal), [15, 14, 13, 12]);
  assert.deepEqual(store.search("q", { limit: 3 }).map(hit => hit.via), ["scan", "scan", "scan"], "one Latin letter scans the segments");
  assert.deepEqual(store.search("nothing of the kind", { limit: 3 }), []);
  sound(store, id);
});

test("on an upgraded root search scans until the indexes are made, and finds the same words after", t => {
  const root = temporary(t), data = join(root, "data");
  writeV13Root(data, [loadV13Fixture("switches")]);
  const store = new SqliteConversationStore(data);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  const word = store.snapshot(store.list().rows[0]!.id as SessionId).messages.find(message => message.role === "user")!.text.split(" ")[0]!;
  const before = store.search(word, { limit: 5 });
  assert.ok(before.length > 0 && before.every(hit => hit.via === "scan"), JSON.stringify(before));
  const indexed = store.rebuildSearchIndex();
  assert.ok(indexed > 0);
  const after = store.search(word, { limit: 5 });
  assert.deepEqual(after.map(hit => hit.id), before.map(hit => hit.id)); assert.ok(after.every(hit => hit.via === (word.length >= 3 ? "trigram" : "scan")), JSON.stringify(after));
  // The first start after the upgrade only reports what the collector would collect; once it has reported, the collector is free.
  assert.deepEqual([store.collectionGate().allowed, store.collectionGate().reportOnly], [false, true]);
  store.acknowledgeFirstStart();
  assert.deepEqual(store.collectionGate(), { allowed: true, reportOnly: false, reason: null });
});

test("events are read in pages: the page size and the cursor are checked, a page stops at its weight but always takes the first event, and a log with a hole is told", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "events")), id = made.conversation.id;
  for (const bad of [0, -1, 1001, 1.5, Number.POSITIVE_INFINITY]) assert.throws(() => store.events(id, 0, bad), code("INVALID_INPUT"), String(bad));
  assert.throws(() => store.events(id, -1), code("INVALID_INPUT"));
  assert.throws(() => store.events(id, 2), code("INVALID_CURSOR"));
  assert.throws(() => store.events(sessionId("session-nowhere"), 0), code("SESSION_NOT_FOUND"));
  const text = "y".repeat(5 * 1024 * 1024);
  for (let index = 0; index < 3; index++) store.transact(id, store.get(id).version, current => ({ next: current, events: [event("fixture.big", { index, text })] }));
  assert.deepEqual(store.events(id, 1, 100).map(entry => entry.data.index), [0]);
  assert.deepEqual(store.events(id, 2, 100).map(entry => entry.data.index), [1]);
  assert.deepEqual(store.events(id, 0, 1000).map(entry => entry.seq), [1, 2], "a page stops before the event that would pass its weight (8 MiB)");
  const many = Array.from({ length: 1500 }, (_, index) => event("fixture.noted", { index }));
  store.transact(id, store.get(id).version, current => ({ next: current, events: many }));
  const last = store.get(id).lastSeq;
  assert.equal(store.events(id, last - 1500, 1000).length, 1000); assert.equal(store.events(id, last - 1500).length, 100);
  const tail = store.events(id, last - 1500 + 1000, 1000); assert.equal(tail.length, 500); assert.equal(tail.at(-1)?.seq, last);
  // A log with a hole: the cursor of the conversation says there are events the table does not have.
  const outsider = rawDatabase(data); outsider.exec("DELETE FROM events WHERE seq=3"); outsider.close();
  assert.throws(() => store.events(id, 2, 5), code("INVALID_DATA"));
  assert.equal(store.get(id).id, id, "the conversation itself is still there; the log is what is told to be wrong");
});

test("the columns and indexes the Runtime and the collector ask by: kept processes, native owners, content references, startup times, and the unfinished", t => {
  const { root, data, store } = openStore(t);
  // Native owners: each ready or unconfirmed reference of a control, never a pending branch or an archived one.
  const lineage: NativeSessionBinding[] = [];
  const binding = (checkpoint: string, status: NativeSessionBinding["status"], harnessId = "fixture", controlId = "fixture-acp", source: "new" | "import" | "fork" = "new"): NativeSessionBinding => {
    const made = { harnessId, controlId, checkpoint, throughRunId: null, status, relay: initialBindingRelay(lineage, harnessId, controlId, source) }; lineage.push(made); return made;
  };
  const imported = created(store, newConversation(root, "imported", { nativeBindings: [binding("native-1", "ready", "fixture", "fixture-acp", "import")] })).conversation.id;
  lineage.length = 0;
  const second = created(store, newConversation(root, "second", { nativeBindings: [binding("native-2", "archived"), binding("native-3", "unconfirmed"), binding("native-9", "ready", "other", "other-acp")] })).conversation.id;
  lineage.length = 0;
  created(store, newConversation(root, "branch", { nativeBindings: [binding("native-1", "fork-pending", "fixture", "fixture-acp", "fork")] }));
  assert.deepEqual([...store.nativeOwners("fixture", "fixture-acp")], [["native-1", imported], ["native-3", second]]);
  assert.deepEqual([...store.nativeOwners("other", "other-acp")], [["native-9", second]]);
  assert.deepEqual([...store.nativeOwners("nobody", "nothing")], []);
  // Content references: an input's attachments, a call's detail (and the one it replaced), an output, and the attachments of a quoted history.
  const ref = (id: string): ContentRef => ({ id: id as ContentRef["id"], name: id + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "a".repeat(64) });
  const history: OriginHistoryRow[] = [{ sessionId: sessionId("session-quoting"), idx: 0, kind: "fork", message: { role: "user", text: "quoted question", status: "completed", attachments: [ref("content-quoted")] } }];
  const quoting = created(store, newConversation(root, "quoting", { origin: { kind: "fork", sessionId: imported, throughRunId: runId("run-gone-0"), throughOrdinal: 0, quoted: true } }), [event("session.created")], history).conversation.id;
  assert.equal(store.head(quoting).title, "分支 · quoted question");
  const scenario = new Scenario(store, quoting, "run-quoting");
  scenario.accept("see attached", { attachments: [ref("content-attached")] }); scenario.start(0);
  const call = toolItem("run-quoting-0", 2, "t1", "running");
  store.transact(quoting, store.get(quoting).version, current => ({ next: { ...current, runs: current.runs.map(row => ({ ...row, items: [...row.items!, call] })) }, events: [event("run.output")] }));
  for (const detail of ["content-detail-1", "content-detail-2"])
    store.transact(quoting, store.get(quoting).version, current => ({ next: { ...current, runs: current.runs.map(row => ({ ...row, items: row.items!.map(it => it.seq === 2 ? { ...it, fields: { ...it.fields, detail: ref(detail) } as typeof it.fields } : it) })) }, events: [event("run.tool_detail")] }));
  assert.deepEqual([...store.contentReferences()].sort(), ["content-attached", "content-detail-1", "content-detail-2", "content-quoted"]);
  const db = rawDatabase(data, true);
  try { assert.equal(db.prepare("SELECT role FROM content_refs WHERE content_id='content-quoted'").get()?.role, "origin_attachment"); assert.equal(count(db, "origin_history", "session_id='session-quoting'"), 1); } finally { db.close(); }
  // The startup time of each Harness entry: the latest few Turns that started their program.
  scenario.finish(0);
  const turn = scenario.turn("another", "reply");
  assert.ok(turn.timing?.preparingAt !== undefined);
  assert.deepEqual(store.startupSamples(5), [{ harnessId: "alpha", controlId: "alpha-acp", preparingAt: NOW + 11, readyAt: NOW + 12 }, { harnessId: "alpha", controlId: "alpha-acp", preparingAt: NOW + 1, readyAt: NOW + 2 }], "the newest first");
  assert.equal(store.startupSamples(1).length, 1);
  // Unfinished: only the conversations with work in the partial indexes.
  const running = created(store, newConversation(root, "running")).conversation.id;
  new Scenario(store, running, "run-running").open("go", "going");
  assert.deepEqual(store.unfinished(), [running]);
  assert.deepEqual(store.listKept(), []);
  const plan = rawDatabase(data, true);
  try {
    const detail = plan.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT r.session_id AS id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.status IN ('queued','preparing','running','settling') AND s.format=14").all().map(row => String(row.detail)).join(" | ");
    assert.match(detail, /runs_open/u, "recovery asks the partial index, not the table");
  } finally { plan.close(); }
});

test("the fingerprints of the notices shown are kept with the commit that showed them, and asked for by conversation", t => {
  const { root, data, store } = openStore(t), one = created(store, newConversation(root, "one")).conversation.id, two = created(store, newConversation(root, "two")).conversation.id;
  assert.equal(store.noticeShown(one, "print-a"), false);
  store.transact(one, store.get(one).version, current => ({ next: current, events: [event("run.notice")], noticePrints: ["print-a", "print-b"] }));
  store.transact(one, store.get(one).version, current => ({ next: current, events: [event("run.notice")], noticePrints: ["print-b", "print-c"] }));
  assert.deepEqual(["print-a", "print-b", "print-c", "print-d"].map(print => store.noticeShown(one, print)), [true, true, true, false]);
  assert.equal(store.noticeShown(two, "print-a"), false, "it is the conversation's own");
  // A commit that is refused takes its fingerprints with it.
  assert.throws(() => store.transact(one, 1, current => ({ next: current, events: [event("run.notice")], noticePrints: ["print-e"] })), code("VERSION_CONFLICT"));
  assert.equal(store.noticeShown(one, "print-e"), false);
  const db = rawDatabase(data, true);
  try { assert.equal(count(db, "notice_prints"), 3); } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The old shape, for the readers that have not moved to items
// ---------------------------------------------------------------------------------------------------------------------------------
test("the old shape is what the adapter gives from the rows, a finished Turn once and the Turns in progress from memory, at every step of a conversation", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "old")), id = made.conversation.id, scenario = new Scenario(store, id, "run-old");
  const reader = rawDatabase(data, true);
  t.after(() => reader.close());
  const same = (label: string): void => assert.deepStrictEqual(store.snapshot(id), snapshotFromRows(reader, id), label);
  same("empty");
  scenario.turn("question 一", "answer 一"); same("one finished Turn");
  const open = scenario.accept("second 😀"); same("accepted");
  scenario.start(open.ordinal); same("started");
  const first = scenario.say(open.ordinal, "partial "); same("a segment begun");
  scenario.append(open.ordinal, first.seq, "more"); same("a segment grown");
  scenario.tool(open.ordinal, "call", "running"); same("a call running");
  // A queued input accepted while the Turn works comes in the messages in the order of the events, not of the Turns.
  scenario.accept("third waits");
  const snapshot = store.snapshot(id);
  assert.deepEqual(snapshot.messages.map(message => message.seq), [...snapshot.messages.map(message => message.seq)].sort((left, right) => left - right));
  same("a queued input");
  scenario.finish(open.ordinal); same("the Turn ended");
  assert.equal(snapshot.schemaVersion, 13); assert.equal(snapshot.runs.length, 3);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.runs) && Object.isFrozen(snapshot.messages) && Object.isFrozen(snapshot.runs[0]));
  assert.throws(() => (snapshot.runs as unknown[]).push({}), TypeError);
});

test("a finished Turn in the old shape is made once: asked again it is the same object, and the Turns in progress are made from memory each time", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "once")), id = made.conversation.id, scenario = new Scenario(store, id, "run-once");
  for (let turn = 0; turn < 5; turn++) scenario.turn("question " + turn, "answer " + turn);
  scenario.open("in progress", "half");
  const first = store.snapshot(id), before = store.cacheStats().oldTurns;
  assert.equal(before.turns, 5); assert.equal(before.misses, 5);
  const again = store.snapshot(id);
  for (let index = 0; index < 5; index++) assert.equal(again.runs[index], first.runs[index], "Turn " + index);
  assert.notEqual(again.runs[5], first.runs[5], "the Turn in progress is made again");
  assert.deepStrictEqual(again.runs[5], first.runs[5]);
  assert.equal(store.cacheStats().oldTurns.hits, before.hits + 5);
  const reader = rawDatabase(data, true);
  try { assert.deepStrictEqual(again, snapshotFromRows(reader, id)); } finally { reader.close(); }
});

test("the old-shape Turns are kept within a byte budget, least recently used first, and one that was let go is made again equal; a budget of nothing keeps nothing", t => {
  const { root, data, store } = openStore(t, { snapshotCacheBytes: 6000 }), made = created(store, newConversation(root, "budget")), id = made.conversation.id, scenario = new Scenario(store, id, "run-budget");
  for (let turn = 0; turn < 12; turn++) scenario.turn("question " + turn, "answer ".repeat(100) + turn);
  const reader = rawDatabase(data, true);
  t.after(() => reader.close());
  const first = store.snapshot(id), stats = store.cacheStats().oldTurns;
  assert.ok(stats.bytes <= 6000 && stats.evictions > 0 && stats.turns < 12, JSON.stringify(stats));
  assert.deepStrictEqual(first, snapshotFromRows(reader, id), "what was let go is made again, equal");
  assert.deepStrictEqual(store.snapshot(id), snapshotFromRows(reader, id));
  const none = openStore(t, { snapshotCacheBytes: 0 }), other = created(none.store, newConversation(none.root, "none"));
  new Scenario(none.store, other.conversation.id, "run-none").turn("q", "a");
  assert.equal(none.store.snapshot(other.conversation.id).runs.length, 1); assert.equal(none.store.cacheStats().oldTurns.turns, 0);
  assert.throws(() => new SqliteConversationStore(join(temporary(t), "data"), { snapshotCacheBytes: -1 }), code("INVALID_INPUT"));
});

test("a conversation with a quoted history gives it back in the old origin, a branch that refers to its source gives none, and an import keeps what it says of itself", t => {
  const { root, store } = openStore(t);
  const rows = (session: string): OriginHistoryRow[] => [
    { sessionId: sessionId(session), idx: 0, kind: "fork", message: { role: "user", text: "quoted question", status: "completed" } },
    { sessionId: sessionId(session), idx: 1, kind: "fork", message: { role: "assistant", text: "quoted answer 回答", status: "completed", harnessId: "alpha" } }];
  const quoted = created(store, newConversation(root, "quoted", { origin: { kind: "fork", sessionId: sessionId("session-source"), throughRunId: runId("run-source-0"), throughOrdinal: 0, quoted: true } }), [event("session.created")], rows("session-quoted")).conversation.id;
  assert.deepEqual(store.snapshot(quoted).origin, { kind: "fork", sessionId: "session-source", throughRunId: "run-source-0", history: rows("session-quoted").map(row => row.message) });
  const reference = created(store, newConversation(root, "reference", { origin: { kind: "fork", sessionId: sessionId("session-source"), throughRunId: runId("run-source-0"), throughOrdinal: 0, quoted: false } })).conversation.id;
  assert.equal(store.snapshot(reference).origin, undefined); assert.equal(store.head(reference).title, "新对话");
  // The page is told where a branch that quotes nothing came from: the source and the point, with no words here (they are the source's Turns).
  assert.deepEqual(store.origin(reference), { kind: "fork", sessionId: "session-source", throughRunId: "run-source-0", history: [] });
  assert.deepEqual(store.origin(quoted)?.history.length, 2);
  const native: NativeSessionBinding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-imported", throughRunId: null, status: "ready", relay: initialBindingRelay([], "alpha", "alpha-acp", "import") };
  const imported = created(store, newConversation(root, "imported", { origin: { kind: "import", harnessId: "alpha", title: "Earlier work", omitted: 3, complete: false, historyRead: true }, nativeBindings: [native] }), [event("session.created")],
    [{ sessionId: sessionId("session-imported"), idx: 0, kind: "import", message: { role: "user", text: "an earlier question", status: "completed" } }]).conversation.id;
  assert.equal(store.head(imported).title, "接续 · Earlier work");
  assert.deepEqual(store.snapshot(imported).origin, { kind: "import", harnessId: "alpha", title: "Earlier work", omitted: 3, complete: false, historyRead: true, history: [{ role: "user", text: "an earlier question", status: "completed" }] });
  for (const id of [quoted, reference, imported]) sound(store, id);
  // The title a branch or an import was given stays through the commits that follow, until its first input names it (and an input of spaces does not).
  store.transact(quoted, store.get(quoted).version, current => ({ next: { ...current, status: "blocked" }, events: [event("session.blocked")] }));
  assert.equal(store.head(quoted).title, "分支 · quoted question"); assert.equal(store.head(imported).title, "接续 · Earlier work");
  new Scenario(store, imported, "run-imported").accept("   ");
  assert.equal(store.head(imported).title, "接续 · Earlier work", "an input of spaces names nothing");
  new Scenario(store, reference, "run-reference").accept("now it has a name");
  assert.equal(store.head(reference).title, "now it has a name");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------------------------------------------------------------
test("a deleted conversation is hidden and lets go of its native sessions; its rows stay to be quoted, and another conversation can take the native session at once", t => {
  const { root, data, store } = openStore(t);
  const binding = (checkpoint: string): NativeSessionBinding => ({ harnessId: "alpha", controlId: "alpha-acp", checkpoint, throughRunId: null, status: "ready", relay: initialBindingRelay([], "alpha", "alpha-acp", "new") });
  const gone = created(store, newConversation(root, "gone", { nativeBindings: [binding("native-held")] })).conversation.id, other = created(store, newConversation(root, "other")).conversation.id;
  const scenario = new Scenario(store, gone, "run-gone");
  scenario.turn("a question that will be quoted", "an answer");
  assert.throws(() => store.deleteSession(gone), code("SESSION_BUSY"), "an open conversation stays");
  assert.deepEqual([...store.nativeOwners("alpha", "alpha-acp")], [["native-held", gone]]);
  store.transact(gone, store.get(gone).version, current => ({ next: { ...current, status: "closed" }, events: [event("session.closed")] }));
  const version = store.get(gone).version, key = commandId("create-gone");
  assert.equal(store.findByCreateKey(key)?.id, gone);
  store.deleteSession(gone);
  assert.throws(() => store.get(gone), code("SESSION_NOT_FOUND")); assert.throws(() => store.snapshot(gone), code("SESSION_NOT_FOUND"));
  assert.throws(() => store.events(gone, 0), code("SESSION_NOT_FOUND")); assert.throws(() => store.transact(gone, version, current => ({ next: current, events: [event("x")] })), code("SESSION_NOT_FOUND"));
  assert.throws(() => store.deleteSession(gone), code("SESSION_NOT_FOUND"));
  assert.equal(store.findByCreateKey(key), null, "its create key is free");
  assert.deepEqual(store.list().rows.map(row => row.id), [other]);
  assert.deepEqual(store.search("quoted", { limit: 5 }), [], "and it is not searched");
  assert.deepEqual([...store.nativeOwners("alpha", "alpha-acp")], [], "the native session is let go");
  // What it said is kept, and says it is gone.
  assert.notEqual(store.head(gone).deletedAt, null); assert.equal(store.head(gone).version, version + 1);
  assert.equal(store.turnAt(gone, 0)?.items[0]?.text.join(""), "a question that will be quoted");
  const db = rawDatabase(data, true);
  try {
    assert.equal(count(db, "runs", "session_id='session-gone'"), 1); assert.equal(count(db, "events", "session_id='session-gone'") > 3, true); assert.equal(count(db, "create_keys", "session_id='session-gone'"), 0);
    const row = db.prepare("SELECT status, json_extract(binding_json,'$.status') AS json FROM bindings WHERE session_id='session-gone'").get();
    assert.deepEqual({ ...row }, { status: "archived", json: "archived" }, "archived in its column and in its JSON");
  } finally { db.close(); }
  // Another conversation takes the native session, and the key can be used again.
  const taker = created(store, newConversation(root, "taker", { nativeBindings: [binding("native-held")] })).conversation.id;
  assert.deepEqual([...store.nativeOwners("alpha", "alpha-acp")], [["native-held", taker]]);
  const again = created(store, newConversation(root, "again", { commands: [{ id: key, kind: "create", fingerprint: "c".repeat(64), resultId: sessionId("session-again") }] }));
  assert.equal(again.conversation.id, "session-again"); assert.equal(store.findByCreateKey(key)?.id, "session-again");
  store.close();
  const reopened = new SqliteConversationStore(data, { recover: recoverUnfinished });
  try { assert.throws(() => reopened.get(gone), code("SESSION_NOT_FOUND")); assert.deepEqual(reopened.list().rows.map(row => row.id).sort(), ["session-again", "session-other", "session-taker"]); } finally { reopened.close(); }
});

test("only a closed conversation that keeps no native process can be deleted, and a conversation that was never there is not found", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "busy")).conversation.id;
  assert.throws(() => store.deleteSession(made), error => error instanceof SessionError && error.code === "SESSION_BUSY");
  assert.throws(() => store.deleteSession(sessionId("session-never")), code("SESSION_NOT_FOUND"));
  assert.equal(store.get(made).status, "open");
});
