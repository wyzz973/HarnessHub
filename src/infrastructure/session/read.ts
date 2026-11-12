import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  PAGE,
  type ConversationReader, type CursorPayload, type DeferredWork, type HeadRow, type ItemPage, type ReadOptions, type SearchHit, type SessionListCursor, type SessionListPage, type SessionListQuery,
  type SessionListRow, type StartupSample, type TextRange, type TurnCursor, type TurnItems, type TurnWindow,
} from "../../contracts/conversation.js";
import { WORK_TYPES } from "../../contracts/protocol.js";
import { SessionError, type HarnessSelection, type RunId, type SessionId } from "../../contracts/session.js";
import { readItems } from "./load.js";
import { headRowFrom, runRowFrom, utf8Length, type Rec } from "./rows.js";
import { hasWords, indexStates, spread, type SearchIndexName } from "./search-index.js";
import { all, one, prepared } from "./statements.js";

/*
 * Every read the wire, the readers and the tools make of a conversation kept as rows (ADR-057 3.4), by index and by page. None of it reads a
 * conversation whole: a window is the newest Turns up to a size, a page of older Turns is found by an opaque cursor that holds a Run's ordinal (which
 * never changes, so a Turn arriving does not move a page), the items of a Turn come in pages by place, a long text comes by byte range, and a search or
 * a list continues from the last hit or row it gave. The sizes (PAGE) are what ONE transfer carries; nothing here limits what a conversation holds.
 *
 * What a read leaves out it says: an item whose text or JSON is longer than a page carries is `textOmitted` / `bodyOmitted` (load.ts), and the middle of a
 * long stretch of finished work is a `DeferredWork` that `items` reads. A byte range never cuts a character: a code point is in the range its first byte
 * is in.
 */

const SEARCHED = "('user_message','assistant_message')";
const FINISHED_ITEM = "('completed','failed','declined','cancelled','unknown')";
const WORK = new Set<string>(WORK_TYPES);
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

function invalid(code: string, message: string): never { throw new SessionError(code, message); }
function positive(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== "number" || Number.isNaN(chosen) || chosen < 1) invalid("INVALID_INPUT", label + " must be at least 1");
  return chosen;
}
/** A count a statement is bound to (a LIMIT): a whole number from 1. (A fraction, or Infinity, bound to LIMIT is an error of SQLite, which would pass for a failure of the storage.) */
function counted(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== "number" || !Number.isSafeInteger(chosen) || chosen < 1) invalid("INVALID_INPUT", label + " must be a whole number from 1");
  return chosen;
}
function wholeNumber(value: unknown, label: string, code = "INVALID_INPUT"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(code, label + " must be a whole number from 0");
  return value;
}

/** A cursor over Turns: opaque, and the same for the same Turn whatever arrives after it. */
export function encodeTurnCursor(payload: CursorPayload): TurnCursor { return Buffer.from(JSON.stringify({ ordinal: payload.ordinal, lastSeq: payload.lastSeq }), "utf8").toString("base64url") as TurnCursor; }
export function decodeTurnCursor(cursor: string): CursorPayload {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return invalid("INVALID_CURSOR", "the cursor is not one this conversation gave"); }
  if (value === null || typeof value !== "object") return invalid("INVALID_CURSOR", "the cursor is not one this conversation gave");
  const row = value as Record<string, unknown>;
  return { ordinal: wholeNumber(row.ordinal, "the cursor's Turn", "INVALID_CURSOR"), lastSeq: wholeNumber(row.lastSeq, "the cursor's cursor", "INVALID_CURSOR") };
}
function encodeListCursor(updatedAt: number, id: string): SessionListCursor { return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url") as SessionListCursor; }
function decodeListCursor(cursor: string): { readonly updatedAt: number; readonly id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt) && typeof value.id === "string") return { updatedAt: value.updatedAt, id: value.id };
  } catch { /* told below */ }
  return invalid("INVALID_CURSOR", "the cursor is not one this list gave");
}

/** The first byte index at or after `index` in `buffer` where a code point starts (the end of the buffer is one). */
function boundary(buffer: Buffer, index: number): number {
  let at = Math.max(0, index);
  while (at < buffer.length && (buffer[at]! & 0xc0) === 0x80) at++;
  return at;
}

export class ConversationTables implements ConversationReader {
  constructor(private readonly db: DatabaseSync) {}

  head(id: SessionId): HeadRow {
    const row = one(this.db, "SELECT * FROM sessions WHERE id=?", id);
    if (row === undefined) return invalid("SESSION_NOT_FOUND", "public Session was not found");
    return headRowFrom(row);
  }

  /** The newest Turns up to `turns` and `bytes` (a Turn that crosses the budget is in; at least one Turn, whatever its size). */
  window(id: SessionId, options: { readonly turns?: number; readonly bytes?: number } = {}): TurnWindow {
    const head = this.head(id);
    return this.collect(head, head.runCount, counted(options.turns, PAGE.windowTurns, "turns"), positive(options.bytes, PAGE.windowBytes, "bytes"));
  }

  /** The page of Turns before `before`. */
  older(id: SessionId, before: TurnCursor, options: { readonly turns?: number; readonly bytes?: number } = {}): TurnWindow {
    const head = this.head(id), cursor = decodeTurnCursor(before);
    if (cursor.ordinal > head.runCount) return invalid("INVALID_CURSOR", "the cursor names a Turn this conversation does not have");
    return this.collect(head, cursor.ordinal, counted(options.turns, PAGE.olderTurns, "turns"), positive(options.bytes, PAGE.windowBytes, "bytes"));
  }

  private collect(head: HeadRow, below: number, turns: number, budget: number): TurnWindow {
    const found: TurnItems[] = [];
    let bytes = 0, cursor = below, full = false;
    while (!full && found.length < turns && cursor > 0) {
      const batch = all(this.db, "SELECT * FROM runs WHERE session_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?", head.id, cursor, Math.min(8, turns - found.length));
      if (batch.length === 0) break;
      for (const row of batch) {
        const turn = this.turn(row, PAGE.itemInlineBytes, true);
        found.push(turn.turn); bytes += turn.bytes; cursor = turn.turn.run.ordinal;
        if (bytes >= budget) { full = true; break; }
      }
    }
    found.reverse();
    const oldest = found[0]?.run.ordinal ?? below;
    return { turns: found, older: oldest > 0 ? encodeTurnCursor({ ordinal: oldest, lastSeq: head.lastSeq }) : null, bytes, lastSeq: head.lastSeq };
  }

  /** One Turn: its row, its items and their text, bodies longer than `inline` left out; the middle of a long stretch of finished work deferred when `fold`. */
  private turn(row: Rec, inline: number, fold: boolean): { readonly turn: TurnItems; readonly bytes: number } {
    const run = runRowFrom(row), deferred = fold ? this.deferred(run.runId) : undefined;
    const read = readItems(this.db, run.runId, inline, deferred === undefined ? {} : { skip: { from: deferred.fromSeq, to: deferred.toSeq } });
    return { turn: { run, items: read.items, ...(deferred === undefined ? {} : { deferred }) }, bytes: utf8Length(String(row.run_json)) + read.bytes };
  }

  /**
   * The stretch of a Turn a window leaves out: in the longest run of consecutive finished work (a completed action, or a completed reasoning segment
   * between them) with more than `PAGE.deferredAfter` completed actions, everything but its first and last `PAGE.deferredKeep` items. Anything else in
   * between (a reply, an approval, a notice, an action still going or failed) ends a stretch, and nothing that is not finished work is ever deferred.
   */
  private deferred(runId: string): DeferredWork | undefined {
    if (Number(one(this.db, "SELECT COUNT(*) AS n FROM items WHERE run_id=?", runId)!.n) <= PAGE.deferredAfter) return undefined;
    const light = all(this.db, "SELECT seq, type, status FROM items WHERE run_id=? ORDER BY seq", runId);
    let best: { start: number; end: number; work: number } | undefined, start = -1, work = 0;
    const close = (end: number): void => { if (start >= 0 && work > PAGE.deferredAfter && (best === undefined || work > best.work)) best = { start, end, work }; start = -1; work = 0; };
    light.forEach((row, index) => {
      const type = String(row.type), action = WORK.has(type), finished = row.status === "completed" && (action || type === "reasoning");
      if (!finished) { close(index - 1); return; }
      if (start < 0) start = index;
      if (action) work++;
    });
    close(light.length - 1);
    if (best === undefined) return undefined;
    const from = best.start + PAGE.deferredKeep, to = best.end - PAGE.deferredKeep;
    return to < from ? undefined : { fromSeq: Number(light[from]!.seq), toSeq: Number(light[to]!.seq), count: to - from + 1 };
  }

  turnAt(id: SessionId, ordinal: number, options: ReadOptions = {}): TurnItems | null {
    const row = one(this.db, "SELECT * FROM runs WHERE session_id=? AND ordinal=?", id, wholeNumber(ordinal, "the Turn's ordinal"));
    return row === undefined ? null : this.turn(row, options.inlineBytes ?? PAGE.itemInlineBytes, false).turn;
  }

  items(runId: RunId, afterSeq: number, limit: number, options: ReadOptions = {}): ItemPage {
    const count = counted(limit, 1, "limit");
    if (!Number.isSafeInteger(count)) invalid("INVALID_INPUT", "limit must be a whole number");
    const read = readItems(this.db, runId, options.inlineBytes ?? PAGE.itemInlineBytes, { after: wholeNumber(afterSeq, "the place after which items are read"), limit: count + 1 });
    const page = read.items.slice(0, count);
    return { items: page, next: read.items.length > count ? page[page.length - 1]!.seq : null };
  }

  /** A byte range of an item's text: a code point belongs to the range its first byte is in, so a range never cuts a character and ranges that follow one another leave no gap and no repeat. */
  text(runId: RunId, itemSeq: number, range: { readonly from: number; readonly to?: number } = { from: 0 }): TextRange {
    const item = one(this.db, "SELECT text_bytes, text_chunks FROM items WHERE run_id=? AND seq=?", runId, wholeNumber(itemSeq, "the item's place"));
    if (item === undefined) return invalid("ITEM_NOT_FOUND", "the item was not found");
    const total = Number(item.text_bytes), chunks = Number(item.text_chunks);
    const wantFrom = Math.min(wholeNumber(range.from, "the range's start"), total), wantTo = Math.min(range.to === undefined ? total : wholeNumber(range.to, "the range's end"), total);
    if (wantTo < wantFrom) return invalid("INVALID_INPUT", "the range ends before it starts");
    if (total === 0 || wantFrom >= total) return { text: "", from: total, to: total, total };
    const chunkOf = (number: number): { offset: number; bytes: number } => {
      const row = one(this.db, "SELECT byte_offset, bytes FROM item_text WHERE run_id=? AND item_seq=? AND chunk=?", runId, itemSeq, number);
      if (row === undefined) return invalid("INVALID_DATA", "chunk " + number + " of the item is missing");
      return { offset: Number(row.byte_offset), bytes: Number(row.bytes) };
    };
    // The chunk that holds a byte: the last one that starts at or before it (the chunks start at 0 and follow one another).
    const holding = (byte: number): number => {
      let low = 0, high = chunks - 1;
      while (low < high) { const middle = (low + high + 1) >> 1; if (chunkOf(middle).offset <= byte) low = middle; else high = middle - 1; }
      return low;
    };
    const first = holding(wantFrom), last = wantTo > wantFrom ? holding(wantTo - 1) : first;
    const rows = all(this.db, "SELECT byte_offset, text FROM item_text WHERE run_id=? AND item_seq=? AND chunk BETWEEN ? AND ? ORDER BY chunk", runId, itemSeq, first, last);
    const base = Number(rows[0]!.byte_offset), buffer = Buffer.from(rows.map(row => String(row.text)).join(""), "utf8");
    const start = boundary(buffer, wantFrom - base), end = Math.max(start, boundary(buffer, wantTo - base));
    return { text: buffer.subarray(start, end).toString("utf8"), from: base + start, to: base + end, total };
  }

  /**
   * Finished messages and segments that hold the words, newest first, `limit` at most, continuing from the item numbered `after`. Three characters or
   * more go to the trigram index; one or two CJK characters to the per-character index; anything shorter (and any query while the index it needs is not
   * complete) is a scan of the joined text of every finished segment, told in each hit's `via`.
   */
  search(query: string, scope: { readonly sessionId?: SessionId; readonly after?: number; readonly limit: number }): readonly SearchHit[] {
    const limit = counted(scope.limit, 1, "limit");
    const words = String(query).trim();
    if (words === "") return [];
    const states = indexStates(this.db), length = [...words].length;
    let via: SearchHit["via"], index: SearchIndexName | undefined;
    if (length >= 3) { via = states.search_fts === "ready" ? "trigram" : "scan"; index = "search_fts"; }
    else if (CJK.test(words) && hasWords(spread(words))) { via = states.search_chars === "ready" ? "chars" : "scan"; index = "search_chars"; }
    else via = "scan";
    const where = ["s.deleted_at IS NULL", "s.format=14"], args: SQLInputValue[] = [];
    if (scope.sessionId !== undefined) { where.push("r.session_id=?"); args.push(scope.sessionId); }
    const phrase = (text: string) => '"' + text.replaceAll('"', '""') + '"';
    let sql: string;
    if (via === "scan") {
      sql = "SELECT i.id AS id, i.run_id AS run_id, i.seq AS seq, i.type AS type, r.session_id AS session_id, r.ordinal AS ordinal FROM items i JOIN runs r ON r.run_id=i.run_id JOIN sessions s ON s.id=r.session_id WHERE "
        + [...where, "i.type IN " + SEARCHED, "i.status IN " + FINISHED_ITEM, "i.text_bytes>0", ...(scope.after === undefined ? [] : ["i.id<?"]),
          "instr(lower((SELECT group_concat(t.text,'' ORDER BY t.chunk) FROM item_text t WHERE t.run_id=i.run_id AND t.item_seq=i.seq)), lower(?))>0"].join(" AND ") + " ORDER BY i.id DESC LIMIT ?";
      if (scope.after !== undefined) args.push(wholeNumber(scope.after, "the search's cursor"));
      args.push(words, limit);
    } else {
      const table = index!;
      sql = "SELECT i.id AS id, i.run_id AS run_id, i.seq AS seq, i.type AS type, r.session_id AS session_id, r.ordinal AS ordinal FROM " + table + " JOIN items i ON i.id=" + table + ".rowid JOIN runs r ON r.run_id=i.run_id JOIN sessions s ON s.id=r.session_id WHERE "
        + [table + " MATCH ?", ...where, ...(scope.after === undefined ? [] : [table + ".rowid<?"])].join(" AND ") + " ORDER BY " + table + ".rowid DESC LIMIT ?";
      args.unshift(table === "search_fts" ? phrase(words) : phrase(spread(words)));
      if (scope.after !== undefined) args.push(wholeNumber(scope.after, "the search's cursor"));
      args.push(limit);
    }
    return prepared(this.db, sql).all(...args).map((row): SearchHit => ({ id: Number(row.id), sessionId: String(row.session_id) as SessionId, runId: String(row.run_id) as RunId, ordinal: Number(row.ordinal), itemSeq: Number(row.seq),
      type: String(row.type) as SearchHit["type"], via }));
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // What the store answers from columns and indexes
  // ---------------------------------------------------------------------------------------------------------------------

  /** The conversations newest first, a page at a time: the columns of `sessions`, never a Turn. A deleted conversation, and one not converted yet, are not listed. */
  list(query: SessionListQuery = {}): SessionListPage {
    const limit = counted(query.limit, PAGE.sessions, "limit");
    const after = query.after === undefined ? undefined : decodeListCursor(query.after);
    const rows = all(this.db, "SELECT id, title, status, last_seq, updated_at, active_run_id, run_count, json_extract(head,'$.configuration.workspace') AS workspace, json_extract(head,'$.selection') AS selection FROM sessions "
      // The bound on `updated_at` alone is what lets the index be entered at the cursor instead of read from its start; the tie on it is the rest.
      + "WHERE deleted_at IS NULL AND format=14" + (after === undefined ? "" : " AND updated_at<=? AND (updated_at<? OR id>?)") + " ORDER BY updated_at DESC, id LIMIT ?",
      ...(after === undefined ? [] : [after.updatedAt, after.updatedAt, after.id]), limit + 1);
    const page = rows.slice(0, limit).map((row): SessionListRow => ({ id: String(row.id) as SessionId, title: String(row.title), status: String(row.status) as SessionListRow["status"], workspace: String(row.workspace),
      selection: JSON.parse(String(row.selection)) as HarnessSelection, updatedSeq: Number(row.last_seq), updatedAt: Number(row.updated_at), activeRunId: row.active_run_id === null ? null : String(row.active_run_id) as RunId, runCount: Number(row.run_count) }));
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > limit && last !== undefined ? encodeListCursor(last.updatedAt, last.id) : null };
  }

  /** The conversations whose head records a kept native process, whatever their age. */
  listKept(): readonly SessionId[] { return all(this.db, "SELECT id FROM sessions WHERE kept=1 AND format=14 ORDER BY rowid").map(row => String(row.id) as SessionId); }

  /** The conversations with a Run not finished or a switch pending: what recovery visits (the partial indexes, which hold only those), never the whole history. */
  unfinished(): readonly SessionId[] {
    const found = new Set<string>();
    for (const row of all(this.db, "SELECT DISTINCT r.session_id AS id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.status IN ('queued','preparing','running','settling') AND s.format=14")) found.add(String(row.id));
    for (const row of all(this.db, "SELECT id FROM sessions WHERE pending_switch_id IS NOT NULL AND format=14")) found.add(String(row.id));
    return [...found].sort().map(id => id as SessionId);
  }

  /**
   * The conversation holding each ready or unconfirmed native reference of one Harness control (checkpoint to conversation); a binding that opens a new native
   * session holds none. A conversation not converted yet is read from its snapshot, so that the answer is whole at any moment of an upgrade.
   */
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId> {
    const owners = new Map<string, SessionId>();
    const add = (checkpoint: unknown, session: unknown): void => {
      if (typeof checkpoint !== "string") invalid("INVALID_DATA", "persisted native reference is invalid");
      if (owners.has(checkpoint)) invalid("INVALID_DATA", "one native session is held by two Sessions");
      owners.set(checkpoint, String(session) as SessionId);
    };
    for (const row of all(this.db, "SELECT b.checkpoint AS checkpoint, b.session_id AS session FROM bindings b JOIN sessions s ON s.id=b.session_id WHERE s.format=14 AND b.harness_id=? AND b.control_id=? "
      + "AND b.status IN ('ready','unconfirmed') AND b.opens_new=0 ORDER BY s.rowid, b.ordinal", harnessId, controlId)) add(row.checkpoint, row.session);
    for (const row of all(this.db, "SELECT s.id AS session, json_extract(b.value,'$.checkpoint') AS checkpoint FROM sessions s, json_each(s.head,'$.nativeBindings') b WHERE s.format<14 "
      + "AND json_extract(b.value,'$.harnessId')=? AND json_extract(b.value,'$.controlId')=? AND json_extract(b.value,'$.status') IN ('ready','unconfirmed') AND json_extract(b.value,'$.opensNew') IS NULL ORDER BY s.rowid", harnessId, controlId)) add(row.checkpoint, row.session);
    return owners;
  }

  /** Every content id any conversation references: the references of the converted ones, and those inside the snapshots of the ones not converted yet. */
  contentReferences(): ReadonlySet<string> {
    const referenced = new Set<string>();
    for (const row of all(this.db, "SELECT DISTINCT content_id FROM content_refs")) referenced.add(String(row.content_id));
    for (const row of all(this.db, `SELECT json_extract(t.value,'$.detail.id') AS id FROM sessions s, json_each(s.head,'$.runs') r, json_each(r.value,'$.tools') t WHERE s.format<14
        UNION SELECT json_extract(o.value,'$.content.id') FROM sessions s, json_each(s.head,'$.runs') r, json_each(r.value,'$.outputs') o WHERE s.format<14
        UNION SELECT json_extract(a.value,'$.id') FROM sessions s, json_each(s.head,'$.runs') r, json_each(r.value,'$.attachments') a WHERE s.format<14
        UNION SELECT json_extract(a.value,'$.id') FROM sessions s, json_each(s.head,'$.origin.history') h, json_each(h.value,'$.attachments') a WHERE s.format<14`)) if (typeof row.id === "string") referenced.add(row.id);
    return referenced;
  }

  /** The latest `perEntry` startups of every Harness entry (a Run that started its program and was not given a kept one): a seek per entry and a read of its newest few. */
  startupSamples(perEntry: number): readonly StartupSample[] {
    const count = counted(perEntry, 1, "perEntry");
    const samples: StartupSample[] = [];
    let harness = "", control = "";
    for (;;) {
      const next = one(this.db, "SELECT harness_id, control_id FROM runs WHERE (harness_id, control_id)>(?, ?) AND ready_at IS NOT NULL AND reused=0 AND preparing_at IS NOT NULL ORDER BY harness_id, control_id LIMIT 1", harness, control);
      if (next === undefined) break;
      harness = String(next.harness_id); control = String(next.control_id);
      for (const row of all(this.db, "SELECT preparing_at, ready_at FROM runs WHERE harness_id=? AND control_id=? AND ready_at IS NOT NULL AND reused=0 AND preparing_at IS NOT NULL ORDER BY preparing_at DESC LIMIT ?", harness, control, count))
        samples.push({ harnessId: harness, controlId: control, preparingAt: Number(row.preparing_at), readyAt: Number(row.ready_at) });
    }
    return samples;
  }
}

