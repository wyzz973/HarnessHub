import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { all, one, prepared } from "./statements.js";

/*
 * The full-text indexes of ADR-057 3.1: DERIVED data, made from the text chunks and made again from them at any time (nothing converts into
 * them, a backup need not hold them, a VACUUM does not move them: they are keyed by `items.id`). Two, because neither covers every query:
 *   - `search_fts`, trigram: three characters or more, any script, a substring match;
 *   - `search_chars`, `unicode61` over text whose Chinese, Japanese and Korean characters were put one to a word before it went in (and so
 *     is the query): one or two such characters, which no trigram holds. The per-character spreading is `spread`.
 * What is indexed is a finished user message or assistant segment, by the whole of its text. A reasoning segment is not (the context
 * table never gives reasoning out), and a segment still being written is not (its text is not whole).
 *
 * `derived` says whether each index is complete. `ready` is a promise the writers keep: a segment that finishes while an index is `ready` is indexed in
 * the commit that finishes it (apply.ts). Nothing below limits what is indexed by size: indexing costs about 50 ms per MiB of text (measured on a
 * 20 MiB segment: 0.45 s trigram, 0.2 s per-character), paid by the commit that finishes the segment.
 *
 * AFTER AN UPGRADE the indexes are `empty` (the migration writes none) and are filled by the BACKFILL (`backfillStep`, run in small steps by the store after it
 * has started): the first step makes both `building`, each step indexes the finished items above `progress` in a short transaction of its own and moves `progress`
 * in it, and the step that finds nothing above it makes both `ready`. While an index is `building` the writers index only the items the backfill has already passed
 * (an item number up to `progress`: it was not finished when the backfill went by); the items above it are the backfill's, which reaches them finished. So an item is
 * indexed once, by one of the two: indexing an item again would delete what is there first, and deleting a row of a contentless table with deletes writes a
 * tombstone that leaves the connection's last inserted row number beyond what a JavaScript number holds, which node:sqlite refuses to hand back from the next
 * statement that does not insert (hence `put` reads its deletes as bigints and always ends on an insert). A restart goes on from `progress`; until `ready`
 * a search scans, and says so.
 */

export const SEARCH_INDEXES = ["search_fts", "search_chars"] as const;
export type SearchIndexName = typeof SEARCH_INDEXES[number];
export type SearchIndexState = "empty" | "building" | "ready";
/** The item types the search finds. */
export const SEARCHED_TYPES = ["user_message", "assistant_message"] as const;
const FINISHED = "('completed','failed','declined','cancelled','unknown')";

/** A text with every CJK character on its own: `unicode61` then holds each as a word, and a phrase of them finds one, two or more in a row. */
export function spread(value: string): string {
  return value.replace(/(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})/gu, " $1 ").replace(/\s+/gu, " ").trim();
}
/** Whether `spread` leaves words for the per-character index to find (a query of punctuation alone has none). */
export function hasWords(value: string): boolean { return /[\p{L}\p{N}]/u.test(value); }

export function indexStates(db: DatabaseSync): Readonly<Record<SearchIndexName, SearchIndexState>> {
  const states: Record<SearchIndexName, SearchIndexState> = { search_fts: "empty", search_chars: "empty" };
  for (const row of all(db, "SELECT name, state FROM derived WHERE name IN ('search_fts','search_chars')")) states[row.name as SearchIndexName] = row.state as SearchIndexState;
  return states;
}
function setState(db: DatabaseSync, name: SearchIndexName, state: SearchIndexState, now: number, progress = 0): void {
  prepared(db, "INSERT INTO derived(name,state,updated_at,progress) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, progress=excluded.progress").run(name, state, now, progress);
}
/** How far the backfill of each index has got (`items.id`); 0 for an index that has not begun. */
export function indexProgress(db: DatabaseSync): Readonly<Record<SearchIndexName, number>> {
  const progress: Record<SearchIndexName, number> = { search_fts: 0, search_chars: 0 };
  for (const row of all(db, "SELECT name, progress FROM derived WHERE name IN ('search_fts','search_chars')")) progress[row.name as SearchIndexName] = Number(row.progress);
  return progress;
}

/** The whole text of an item, its chunks joined. */
function wholeText(db: DatabaseSync, runId: string, seq: number): string {
  return all(db, "SELECT text FROM item_text WHERE run_id=? AND item_seq=? ORDER BY chunk", runId, seq).map(row => String(row.text)).join("");
}
/**
 * Puts one finished item into the indexes named (what is there under its id goes first, so a second call changes nothing). The delete of a row that is in the index writes a
 * tombstone whose row number is far beyond a JavaScript number, and it becomes the connection's last inserted row number: its result is therefore read as a bigint here, and
 * the insert that follows sets that number back to the item's own (see the top of this file).
 */
function put(db: DatabaseSync, id: number, text: string, names: readonly SearchIndexName[]): void {
  for (const name of names) {
    const remove = prepared(db, "DELETE FROM " + name + " WHERE rowid=?");
    remove.setReadBigInts(true); remove.run(id);
    if (text === "") continue;
    prepared(db, "INSERT INTO " + name + "(rowid,text) VALUES(?,?)").run(id, name === "search_fts" ? text : spread(text));
  }
}

/**
 * Called by a commit with the items it finished: each is indexed in every index that is `ready`, and in one that is `building` when the backfill has already passed it
 * (an index that is `empty` is waited for by the backfill or a rebuild, which will see the item). Items of other types, and items not finished, are left out.
 */
export function maintainSearch(db: DatabaseSync, items: readonly { readonly runId: string; readonly seq: number }[]): void {
  if (items.length === 0) return;
  const states = indexStates(db), live = SEARCH_INDEXES.filter(name => states[name] !== "empty");
  if (live.length === 0) return;
  const reached = live.some(name => states[name] === "building") ? indexProgress(db) : null;
  for (const item of items) {
    const row = one(db, "SELECT id, type, status FROM items WHERE run_id=? AND seq=?", item.runId, item.seq);
    if (row === undefined || !(SEARCHED_TYPES as readonly string[]).includes(String(row.type)) || ["pending", "running", "waiting"].includes(String(row.status))) continue;
    const id = Number(row.id), names = live.filter(name => states[name] === "ready" || id <= (reached?.[name] ?? 0));
    if (names.length === 0) continue;
    put(db, id, wholeText(db, item.runId, item.seq), names);
  }
}

/**
 * Makes both indexes from the chunks: empties them, indexes every finished user message and assistant segment of every converted
 * conversation, sets both `ready`. The maintenance command and the first start after the conversion call it; a conversation that is
 * written meanwhile by the same connection indexes what it finishes (maintainSearch), so the result is complete when it returns.
 * Returns how many items were indexed.
 */
export function rebuildSearchIndex(db: DatabaseSync, now: number): number {
  db.exec("SAVEPOINT rebuild_search");
  try {
    for (const name of SEARCH_INDEXES) { setState(db, name, "building", now); prepared(db, "INSERT INTO " + name + "(" + name + ") VALUES('delete-all')").run(); }
    let after = 0, count = 0;
    for (;;) {
      const page = all(db, `SELECT i.id, i.run_id, i.seq FROM items i JOIN runs r ON r.run_id=i.run_id JOIN sessions s ON s.id=r.session_id
        WHERE i.id>? AND s.format=14 AND i.type IN ('user_message','assistant_message') AND i.status IN ${FINISHED} AND i.text_bytes>0 ORDER BY i.id LIMIT 256`, after);
      if (page.length === 0) break;
      for (const row of page) { put(db, Number(row.id), wholeText(db, String(row.run_id), Number(row.seq)), SEARCH_INDEXES); count++; after = Number(row.id); }
    }
    const top = Number(one(db, "SELECT COALESCE(MAX(id),0) AS top FROM items")!.top);
    for (const name of SEARCH_INDEXES) setState(db, name, "ready", now, top);
    db.exec("RELEASE rebuild_search");
    return count;
  } catch (error) {
    if (db.isTransaction) { try { db.exec("ROLLBACK TO rebuild_search"); db.exec("RELEASE rebuild_search"); } catch { /* the transaction is already gone */ } }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The backfill after an upgrade
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * What one step of the backfill may spend. A step is a synchronous transaction, so every commit and request of the process waits for the step that is running: it stops after
 * `maxBytes` of text or `maxMillis` milliseconds, whichever comes first (at least one item is indexed in every step, whatever its size: an item cannot be indexed in parts,
 * so one longer than a few hundred KiB makes its own step longer, at about 50 ms per MiB), and looks at no more than `window` item numbers.
 */
export interface BackfillBudget { readonly maxBytes: number; readonly maxMillis: number; readonly window: number }
export const BACKFILL: BackfillBudget = { maxBytes: 128 * 1024, maxMillis: 8, window: 4096 };
export interface BackfillStep {
  /** Both indexes are `ready`. */
  readonly done: boolean;
  /** The items this step put into the indexes. */
  readonly indexed: number;
  /** The item number up to which every finished item is indexed. */
  readonly progress: number;
}
/**
 * One step of filling the indexes after an upgrade, in the caller's transaction. It begins the work when an index is `empty` (both become `building`, and the writers keep
 * them from then on), indexes the next finished user messages and assistant segments above `progress` within the budget, moves `progress`, and when nothing is left
 * above it sets both `ready`. Items that are not finished are left to the commit that finishes them (a writer indexes them). Calling it again after it is done changes nothing.
 */
export function backfillStep(db: DatabaseSync, now: number, budget: BackfillBudget = BACKFILL): BackfillStep {
  const states = indexStates(db), pending = SEARCH_INDEXES.filter(name => states[name] !== "ready");
  if (pending.length === 0) return { done: true, indexed: 0, progress: Math.max(...Object.values(indexProgress(db))) };
  const reached = indexProgress(db);
  const from = pending.some(name => states[name] === "empty") ? 0 : Math.min(...pending.map(name => reached[name]));
  const limit = from + budget.window;
  const rows = all(db, `SELECT i.id AS id, i.run_id AS run_id, i.seq AS seq, i.text_bytes AS bytes FROM items i JOIN runs r ON r.run_id=i.run_id JOIN sessions s ON s.id=r.session_id
    WHERE i.id>? AND i.id<=? AND s.format=14 AND i.type IN ('user_message','assistant_message') AND i.status IN ${FINISHED} AND i.text_bytes>0 ORDER BY i.id`, from, limit);
  const started = performance.now();
  let indexed = 0, bytes = 0, last = from, whole = true;
  for (const row of rows) {
    if (indexed > 0 && (bytes >= budget.maxBytes || performance.now() - started >= budget.maxMillis)) { whole = false; break; }
    put(db, Number(row.id), wholeText(db, String(row.run_id), Number(row.seq)), pending);
    indexed++; bytes += Number(row.bytes); last = Number(row.id);
  }
  const top = Number(one(db, "SELECT COALESCE(MAX(id),0) AS top FROM items")!.top);
  const progress = whole ? Math.min(limit, top) : last, done = whole && progress >= top;
  for (const name of pending) setState(db, name, done ? "ready" : "building", now, progress);
  return { done, indexed, progress };
}
