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
 * `derived` says whether each index is complete. `ready` is a promise the writers keep: a segment that finishes while an index is `ready` or
 * `building` is indexed in the commit that finishes it (apply.ts). Nothing below limits what is indexed by size: indexing costs about 50 ms per
 * MiB of text (measured on a 20 MiB segment: 0.45 s trigram, 0.2 s per-character), paid by the commit that finishes the segment.
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
function setState(db: DatabaseSync, name: SearchIndexName, state: SearchIndexState, now: number): void {
  prepared(db, "INSERT INTO derived(name,state,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at").run(name, state, now);
}

/** The whole text of an item, its chunks joined. */
function wholeText(db: DatabaseSync, runId: string, seq: number): string {
  return all(db, "SELECT text FROM item_text WHERE run_id=? AND item_seq=? ORDER BY chunk", runId, seq).map(row => String(row.text)).join("");
}
/** Puts one finished item into the indexes named (what is there under its id goes first, so a second call changes nothing). */
function put(db: DatabaseSync, id: number, text: string, names: readonly SearchIndexName[]): void {
  for (const name of names) {
    prepared(db, "DELETE FROM " + name + " WHERE rowid=?").run(id);
    if (text === "") continue;
    prepared(db, "INSERT INTO " + name + "(rowid,text) VALUES(?,?)").run(id, name === "search_fts" ? text : spread(text));
  }
}

/**
 * Called by a commit with the items it finished: each is indexed in every index that is `ready` or `building` (an index that is `empty`
 * is being waited for by a rebuild, which will see the item). Items of other types, and items not finished, are left out.
 */
export function maintainSearch(db: DatabaseSync, items: readonly { readonly runId: string; readonly seq: number }[]): void {
  if (items.length === 0) return;
  const states = indexStates(db), names = SEARCH_INDEXES.filter(name => states[name] !== "empty");
  if (names.length === 0) return;
  for (const item of items) {
    const row = one(db, "SELECT id, type, status FROM items WHERE run_id=? AND seq=?", item.runId, item.seq);
    if (row === undefined || !(SEARCHED_TYPES as readonly string[]).includes(String(row.type)) || ["pending", "running", "waiting"].includes(String(row.status))) continue;
    put(db, Number(row.id), wholeText(db, item.runId, item.seq), names);
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
    for (const name of SEARCH_INDEXES) setState(db, name, "ready", now);
    db.exec("RELEASE rebuild_search");
    return count;
  } catch (error) {
    if (db.isTransaction) { try { db.exec("ROLLBACK TO rebuild_search"); db.exec("RELEASE rebuild_search"); } catch { /* the transaction is already gone */ } }
    throw error;
  }
}
