import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setImmediate as yielded } from "node:timers/promises";
import type { SearchHit } from "../../src/contracts/conversation.js";
import { sessionId } from "../../src/contracts/session.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { maintainSearch } from "../../src/infrastructure/session/search-index.js";
import { appStore } from "../fixtures/runtime-store.js";
import { loadV13Fixture, renamed, writeV13Root } from "../fixtures/storage/v13/database.js";
import { Scenario, created, newConversation, rawDatabase, temporary } from "../fixtures/store-helpers.js";

// The full-text indexes are derived data: a migration writes none, so a root that was upgraded searches by scan until the store has filled them. It fills them after it has
// started, in small steps of their own (a few milliseconds of work, the event loop given back between steps), records how far it got in the database and goes on from there
// after a restart; until the indexes are complete a search scans and says so, and when they are, it uses them and finds the same. Only the clock of the work is made small
// (a step of a few dozen bytes) so that a fixture takes many steps; everything else is the real store on a real root in a temporary directory.

const TINY = { maxBytes: 64, maxMillis: 1000, window: 64 };
/** The v13 fixtures with text of every kind, made one database: the conversations of each under names of their own. */
function upgradedRoot(t: Parameters<typeof temporary>[0]): string {
  const data = join(temporary(t), "data");
  writeV13Root(data, (["switches", "commands", "branch", "import", "tools", "text-extremes"] as const).map((name, index) => renamed(loadV13Fixture(name), "s" + index)));
  return data;
}
/** Words the conversations hold, of the three kinds of query (three characters or more; one or two Chinese characters; one or two Latin characters), taken from the rows. */
function queriesOf(db: DatabaseSync): readonly string[] {
  const texts = db.prepare("SELECT group_concat(t.text, '') AS text FROM item_text t JOIN items i ON i.run_id=t.run_id AND i.seq=t.item_seq WHERE i.type IN ('user_message','assistant_message') GROUP BY i.id ORDER BY i.id LIMIT 600").all().map(row => String(row.text));
  const words = new Set<string>(), han = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9]{3,10}/gu)) { if (words.size < 24) words.add(match[0]!); }
    for (const match of text.matchAll(/\p{Script=Han}{2}/gu)) { if (han.size < 6) { han.add(match[0]!); han.add(match[0]![0]!); } }
  }
  return [...words, ...han, "co", "a", "no-such-word-anywhere-xyz"];
}
const shape = (hits: readonly SearchHit[]): readonly string[] => hits.map(hit => [hit.id, hit.sessionId, hit.runId, hit.ordinal, hit.itemSeq, hit.type].join("/"));
function everything(store: SqliteConversationStore, queries: readonly string[]): ReadonlyMap<string, readonly SearchHit[]> {
  return new Map(queries.map(query => [query, store.search(query, { limit: 100_000 })]));
}
const finishedMessages = (db: DatabaseSync): number => Number(db.prepare("SELECT COUNT(*) AS n FROM items WHERE type IN ('user_message','assistant_message') AND status IN ('completed','failed','declined','cancelled','unknown') AND text_bytes>0").get()!.n);

test("the indexes of an upgraded root are empty and a search scans; the backfill fills them in steps, and a search then uses them and finds what the scan found", async t => {
  const data = upgradedRoot(t), store = appStore(data);
  try {
    // A conversation of the new kind with Chinese and Latin words beside the fixtures' own.
    const live = new Scenario(store, created(store, newConversation(join(data, ".."), "live")).conversation.id, "run-live", false);
    live.turn("你好，请搜索这个词汇 zebra-crossing", "回答完成 alpha-bravo-charlie 以及 中文词汇");
    const db = rawDatabase(data, true);
    let queries: readonly string[];
    try { queries = queriesOf(db); } finally { db.close(); }
    assert.ok(queries.length >= 20, "queries of every kind: " + queries.length);
    assert.deepEqual(store.searchIndex().states, { search_fts: "empty", search_chars: "empty" });
    assert.deepEqual(store.searchIndex().progress, { search_fts: 0, search_chars: 0 });
    const scanned = everything(store, queries);
    for (const [query, hits] of scanned) assert.ok(hits.every(hit => hit.via === "scan"), "'" + query + "' is answered by the scan while the indexes are empty");
    assert.ok([...scanned.values()].filter(hits => hits.length > 0).length >= 16, "most queries find something");

    let steps = 0, indexed = 0, previous = 0, last = 0;
    await store.startSearchBackfill({ pauseMs: 0, budget: TINY, onStep: step => {
      steps++; indexed += step.indexed; assert.ok(step.progress >= previous, "the progress only moves forward"); previous = step.progress; last = step.progress;
      if (!step.done) assert.deepEqual(store.searchIndex().states, { search_fts: "building", search_chars: "building" }, "while it works the indexes are building");
      if (steps === 3) for (const hits of everything(store, queries).values()) assert.ok(hits.every(hit => hit.via === "scan"), "a search that comes while they build still scans");
    } });
    assert.ok(steps >= 20, "the work was cut into many short steps: " + steps);
    assert.deepEqual(store.searchIndex().states, { search_fts: "ready", search_chars: "ready" });
    const counted = rawDatabase(data, true);
    try {
      assert.equal(indexed, finishedMessages(counted), "every finished message was indexed once");
      assert.equal(store.searchIndex().progress.search_fts, Number(counted.prepare("SELECT MAX(id) AS top FROM items").get()!.top));
    } finally { counted.close(); }
    assert.ok(last > 0);

    const indexedHits = everything(store, queries);
    let viaIndex = 0;
    for (const query of queries) {
      assert.deepEqual(shape(indexedHits.get(query)!), shape(scanned.get(query)!), "'" + query + "': the index finds what the scan found, newest first");
      const length = [...query].length, han = /\p{Script=Han}/u.test(query);
      for (const hit of indexedHits.get(query)!) {
        const expected = length >= 3 ? "trigram" : han ? "chars" : "scan";
        assert.equal(hit.via, expected, "'" + query + "' is answered by " + expected);
        if (hit.via !== "scan") viaIndex++;
      }
    }
    assert.ok(viaIndex > 20, "the indexes answered: " + viaIndex);
  } finally { store.close(); }
});

test("a restart goes on from the progress the database records, and does not do again what was done", async t => {
  const data = upgradedRoot(t);
  let queries: readonly string[] = [], total = 0, reference: ReadonlyMap<string, readonly SearchHit[]>;
  // The result of the scan, from a store that is not backfilled at all.
  const plain = appStore(data);
  try {
    const db = rawDatabase(data, true);
    try { queries = queriesOf(db); total = finishedMessages(db); } finally { db.close(); }
    reference = everything(plain, queries);
  } finally { plain.close(); }
  // The first run is stopped (the store is closed) after a few steps.
  const first = appStore(data);
  let steps = 0, doneBefore = 0;
  try {
    await first.startSearchBackfill({ pauseMs: 0, budget: TINY, onStep: step => { steps++; doneBefore += step.indexed; if (steps === 5) first.close(); } });
  } finally { try { first.close(); } catch { /* closed by the step */ } }
  assert.equal(steps, 5, "it stopped when the store closed");
  const probe = rawDatabase(data, true);
  try {
    const rows = probe.prepare("SELECT name, state, progress FROM derived ORDER BY name").all().map(row => ({ ...row }));
    assert.deepEqual(rows.map(row => [row.name, row.state]), [["search_chars", "building"], ["search_fts", "building"]]);
    assert.ok(Number(rows[0]!.progress) > 0 && rows[0]!.progress === rows[1]!.progress, "the database records how far it got: " + JSON.stringify(rows));
  } finally { probe.close(); }
  assert.ok(doneBefore > 0 && doneBefore < total);
  // The next owner goes on.
  const second = appStore(data);
  try {
    assert.deepEqual(second.searchIndex().states, { search_fts: "building", search_chars: "building" });
    for (const hits of everything(second, queries).values()) assert.ok(hits.every(hit => hit.via === "scan"), "until they are complete a search scans");
    let again = 0;
    await second.startSearchBackfill({ pauseMs: 0, budget: TINY, onStep: step => { again += step.indexed; } });
    assert.equal(doneBefore + again, total, "what the first run did is not done again, and nothing is left out: " + doneBefore + " + " + again + " of " + total);
    assert.deepEqual(second.searchIndex().states, { search_fts: "ready", search_chars: "ready" });
    for (const query of queries) assert.deepEqual(shape(second.search(query, { limit: 100_000 })), shape(reference.get(query)!), "'" + query + "'");
  } finally { second.close(); }
  // And once it is done, a start does nothing to the database.
  const third = appStore(data), watcher = rawDatabase(data), before = Number(watcher.prepare("PRAGMA data_version").get()!.data_version);
  try {
    await third.startSearchBackfill({ pauseMs: 0 });
    assert.equal(Number(watcher.prepare("PRAGMA data_version").get()!.data_version), before, "a root whose indexes are complete is not written");
  } finally { watcher.close(); third.close(); }
});

test("commits go on while it works, a message that finishes meanwhile is found, and no step holds the process longer than a few tens of milliseconds", async t => {
  const data = upgradedRoot(t), store = appStore(data);
  try {
    // A good deal of text, so that the work takes many steps of its own size: a few thousand messages of ten KiB.
    const body = "lorem ipsum dolor sit amet ".repeat(400);
    const big = new Scenario(store, created(store, newConversation(join(data, ".."), "big")).conversation.id, "run-big", false);
    for (let n = 0; n < 40; n++) {
      const run = big.accept("question " + n);
      big.start(run.ordinal);
      for (let part = 0; part < 12; part++) big.say(run.ordinal, "answer " + n + "." + part + " " + body, "completed");
      big.finish(run.ordinal);
    }
    // A Turn that is open while the work begins and finishes in the middle of it.
    const live = new Scenario(store, created(store, newConversation(join(data, ".."), "live")).conversation.id, "run-live", false);
    const waiting = new Scenario(store, created(store, newConversation(join(data, ".."), "waiting")).conversation.id, "run-waiting", false);
    const open = waiting.open("a question asked before", "an answer that is not finished yet, marker-early");

    // How long the event loop was held between the probe's ticks. One pause of the machine (a collection, another process) is not the work's: the typical gap is held to a tight bound and the longest to
    // a looser one (alone it is under 40 ms; the first full run on a loaded machine saw 156 ms once; a backfill that took its work in one piece would hold the loop for a second or more).
    const gaps: number[] = [];
    let last = performance.now();
    const probe = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 2);
    const commits: number[] = [];
    let steps = 0;
    try {
      const filling = store.startSearchBackfill({ pauseMs: 1, onStep: () => { steps++; } });
      // Commits while it works: new Turns, and the end of the open one.
      for (let n = 0; n < 25; n++) {
        const began = performance.now();
        live.turn("question during " + n, "answer during " + n + " [marker-late:" + n + "]");
        commits.push(performance.now() - began);
        if (n === 7) waiting.finish(open.ordinal);
        await yielded();
      }
      await filling;
    } finally { clearInterval(probe); }
    assert.ok(steps >= 30, "the work took many steps: " + steps);
    assert.deepEqual(store.searchIndex().states, { search_fts: "ready", search_chars: "ready" });
    const ordered = [...gaps].sort((a, b) => a - b), worst = ordered.at(-1) ?? 0, median = ordered[Math.floor(ordered.length / 2)] ?? 0;
    assert.ok(gaps.length >= 10, "the loop kept ticking while the work went on: " + gaps.length);
    assert.ok(median < 40, "no step held the event loop (median gap " + median.toFixed(1) + " ms)");
    assert.ok(worst < 400, "and the longest hold was " + worst.toFixed(1) + " ms");
    t.diagnostic(`backfill: ${steps} steps; longest hold of the event loop ${worst.toFixed(1)} ms, median ${median.toFixed(1)} ms; the commits made meanwhile took ${Math.max(...commits).toFixed(1)} ms at most`);
    const hits = (query: string) => store.search(query, { limit: 100_000 });
    assert.equal(hits("marker-early").length, 1, "the message that finished while the indexes were building was indexed by its own commit");
    assert.equal(hits("marker-early")[0]!.via, "trigram");
    for (let n = 0; n < 25; n++) assert.equal(hits("[marker-late:" + n + "]").length, 1, "marker-late " + n);
    assert.equal(hits("lorem ipsum dolor").length, 40 * 12, "the messages that were there before");
  } finally { store.close(); }
});

test("a root that was never upgraded has complete indexes from the start, and there is nothing for the backfill to do", async t => {
  const data = join(temporary(t), "data"), store = appStore(data);
  try {
    assert.deepEqual(store.searchIndex().states, { search_fts: "ready", search_chars: "ready" });
    const watcher = rawDatabase(data), before = Number(watcher.prepare("PRAGMA data_version").get()!.data_version);
    try {
      await store.startSearchBackfill({ pauseMs: 0 });
      assert.equal(Number(watcher.prepare("PRAGMA data_version").get()!.data_version), before, "nothing was written");
    } finally { watcher.close(); }
    // The store that closes while the work waits for its first step stops it at once, and the work is a promise that resolves.
  } finally { store.close(); }
  const other = join(temporary(t), "data"), upgraded = (() => { writeV13Root(other, [loadV13Fixture("switches")]); return appStore(other); })();
  const promise = upgraded.startSearchBackfill({ pauseMs: 50 });
  upgraded.close();
  await promise;
  assert.equal(sessionId("session-sw-1").length > 0, true);
});

test("an item put into the indexes twice is not a statement that fails: the tombstone the second delete writes leaves no number the next statement cannot hand back", async t => {
  // Deleting a row that is in a contentless table with deletes writes a tombstone, and the number of that row (it is made of the segment's number) becomes the connection's last
  // inserted row number — far beyond what node:sqlite can return as a number, so that the statement that deletes would throw a RangeError, and so would the next one that does not
  // insert. An item is indexed once by design (the backfill and the writers share the work), but a mistake of the kind must not take the connection down with it.
  const data = upgradedRoot(t), store = appStore(data);
  try {
    await store.startSearchBackfill({ pauseMs: 0, budget: TINY });
    assert.deepEqual(store.searchIndex().states, { search_fts: "ready", search_chars: "ready" });
    const db = new DatabaseSync(join(data, "gateway.sqlite"));
    try {
      const items = db.prepare("SELECT run_id, seq FROM items WHERE type='assistant_message' AND text_bytes>0 ORDER BY id LIMIT 6").all().map(row => ({ runId: String(row.run_id), seq: Number(row.seq) }));
      assert.equal(items.length, 6);
      for (let round = 0; round < 3; round++) {
        db.exec("BEGIN IMMEDIATE");
        try { assert.doesNotThrow(() => maintainSearch(db, items), "round " + round); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
        assert.doesNotThrow(() => db.prepare("UPDATE derived SET updated_at=updated_at WHERE name='search_fts'").run(), "round " + round);
        assert.doesNotThrow(() => db.prepare("DELETE FROM derived WHERE name='none'").run(), "round " + round);
      }
    } finally { db.close(); }
    const hits = store.search("zzzzzz-no-such-word", { limit: 10 });
    assert.deepEqual(hits, []);
  } finally { store.close(); }
});
