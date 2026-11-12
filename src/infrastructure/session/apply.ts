import type { DatabaseSync } from "node:sqlite";
import type { BindingWrite, ItemWrite, Mutation, RunWrite, SwitchWrite, TextAppend } from "../../contracts/conversation.js";
import type { RelayRows } from "../../contracts/relay.js";
import { SessionError, type EventDraft, type SessionEvent } from "../../contracts/session.js";
import { IndexHealth, SEARCHED_TYPES, maintainSearch } from "./search-index.js";
import {
  RUN_IDENTITY, bindingColumns, commandColumns, contentRefColumns, endsInHighSurrogate, headColumns, itemColumns, originHistoryColumns, runColumns, switchColumns, textColumns, utf8Length, wellFormed,
} from "./rows.js";
import { changedColumns, identityChanged, insertInto, one, refused, updateRow } from "./statements.js";

/*
 * Writes a Mutation (src/contracts/conversation.ts): the rows one commit changed, and its events, in one transaction, in the order the
 * Mutation's comment gives. Nothing here decides what a commit should be: it writes what it is given, fills in the numbers only the store can
 * know (the seq an event gets, the offset a chunk of text starts at, what an item has counted), and lets the keys and triggers of
 * schema-v14.ts refuse what breaks a rule of the conversation.
 *
 *  - ATOMIC. It works inside a SAVEPOINT, so it is all or nothing and nests in the store's own BEGIN IMMEDIATE; used alone it is its own transaction.
 *  - A REFUSAL IS A REQUEST'S. What a key, a check or a trigger refuses comes back as a SessionError (INVALID_TRANSITION for a trigger, INVALID_DATA
 *    for the rest), with the SQLite error as its cause; a lost write race is VERSION_CONFLICT. None of them says the store cannot be trusted: that is
 *    what an error of SQLite that is not a constraint says (a full disk, a broken file), and it is passed on as it is.
 *  - THE HEAD IS COMPARED, NOT TRUSTED. `head.row.version` is the version the commit was made from and is compared with the stored one; `lastSeq` is the
 *    cursor after the commit, `lastSeq - events.length` the one before. A new conversation (no row yet) starts at version 0 and its head is written first, because
 *    everything below it refers to it; every other commit writes the head last.
 *  - UPDATES WRITE WHAT CHANGED. A Run, an item, a binding or a switch is read, compared with the row given and updated in the columns that differ, so a
 *    terminal Run whose only change is its acknowledgement touches that column alone (the trigger that fixes a terminal Run is on the others).
 *  - TEXT IS WHOLE CODE POINTS. A chunk with half of a surrogate pair at either end is refused: SQLite would keep the half as U+FFFD, and text that
 *    reads back unlike what was written is a loss. The writer holds the first half for the next chunk (the Runtime's window does).
 */

export interface ApplyOptions {
  /** The generation of the owner that writes; the events carry it. */
  readonly ownerGeneration: number;
  /** The time of the commit, as an ISO string; the events carry it. */
  readonly timestamp: string;
  /** Writes the relay's rows (relay-tables.ts), called after the events and before the head; required when the Mutation has relay rows. */
  readonly writeRelay?: (rows: RelayRows) => void;
  /** What the process knows of its full-text indexes; an index that fails the commit's maintenance is made unusable there and the commit goes on. Absent: this commit knows nothing before it. */
  readonly indexes?: IndexHealth;
}
export interface Applied {
  /** The events as committed: their seq, the owner generation, the time. */
  readonly events: readonly SessionEvent[];
  /**
   * The Mutation as written: the seqs taken from events are in the rows (`userSeq`, `endedSeq`, `createdSeq`), every chunk of text has its `byteOffset`,
   * the items hold what the table counted (`textBytes`, `textChunks`), and the head is the row as stored (`version` the new one). A stream's frame is made from it.
   */
  readonly changes: Mutation;
}

const EVENT_TYPE = /^[a-z][a-z0-9._:-]{0,127}$/u;
const key = (runId: string, seq: number): string => runId + "\u0000" + seq;

export function applyMutation(db: DatabaseSync, mutation: Mutation, options: ApplyOptions): Applied {
  if (mutation.head === undefined) throw new SessionError("INVALID_DATA", "a Mutation carries the head it moves");
  db.exec("SAVEPOINT apply_mutation");
  try {
    const applied = write(db, mutation, options);
    db.exec("RELEASE apply_mutation");
    return applied;
  } catch (error) {
    if (db.isTransaction) { try { db.exec("ROLLBACK TO apply_mutation"); db.exec("RELEASE apply_mutation"); } catch { /* the transaction is already gone */ } }
    throw refused(error);
  }
}

function write(db: DatabaseSync, mutation: Mutation, options: ApplyOptions): Applied {
  const head = mutation.head!.row, session = head.id, events = mutation.events;
  const first = head.lastSeq - events.length;
  if (first < 0) throw new SessionError("INVALID_DATA", "the head's cursor is before its own events");
  const seqOf = (index: number, what: string): number => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= events.length) throw new SessionError("INVALID_DATA", what + " names event " + index + " of a commit with " + events.length);
    return first + index + 1;
  };

  // The head: compared with what is stored; a new conversation's first.
  const stored = one(db, "SELECT version, last_seq FROM sessions WHERE id=?", session);
  if (stored === undefined) {
    if (head.version !== 0 || first !== 0) throw new SessionError("INVALID_DATA", "a new conversation starts at version 0, with its events from seq 1");
    insertInto(db, "sessions", headColumns({ ...head, version: 1 }));
  } else if (stored.version !== head.version || stored.last_seq !== first) {
    throw new SessionError("VERSION_CONFLICT", "the conversation moved before this commit (version " + String(stored.version) + ", cursor " + String(stored.last_seq) + ")");
  }
  const own = (id: string, what: string): void => { if (id !== session) throw new SessionError("INVALID_DATA", what + " belongs to another conversation"); };

  for (const row of mutation.commands ?? []) { own(row.sessionId, "a command"); insertInto(db, "commands", commandColumns(row)); }

  // Runs: inserts first (their items refer to them), updates after the items (a Run's terminal change comes after its last item).
  const runs = (mutation.runs ?? []).map((run): RunWrite => {
    own(run.row.sessionId, "a Run");
    const userSeq = run.userSeqByEvent === undefined ? run.row.userSeq : seqOf(run.userSeqByEvent, "a Run's input");
    const endedSeq = run.endedByEvent === undefined ? run.row.endedSeq : seqOf(run.endedByEvent, "a Run's end");
    return { op: run.op, row: { ...run.row, userSeq, endedSeq } };
  });
  for (const run of runs) if (run.op === "insert") insertInto(db, "runs", runColumns(run.row));

  // Items.
  const owners = new Map<string, boolean>();
  const ownsRun = (runId: string): boolean => {
    let found = owners.get(runId);
    if (found === undefined) { found = one(db, "SELECT session_id FROM runs WHERE run_id=?", runId)?.session_id === session; owners.set(runId, found); }
    return found;
  };
  const items = (mutation.items ?? []).map((item): ItemWrite => {
    if (!ownsRun(item.row.runId)) throw new SessionError("INVALID_DATA", "an item belongs to a Run that is not this conversation's");
    return { ...item, row: { ...item.row, createdSeq: item.createdByEvent === undefined ? item.row.createdSeq : seqOf(item.createdByEvent, "an item") } };
  });
  const counted = new Map<string, { bytes: number; chunks: number; createdSeq: number | null }>();
  for (const item of items) {
    const columns = itemColumns(item.row);
    if (item.op === "insert") { insertInto(db, "items", columns); counted.set(key(item.row.runId, item.row.seq), { bytes: 0, chunks: 0, createdSeq: item.row.createdSeq }); continue; }
    const current = one(db, "SELECT item_id, type, status, started_at, ended_at, parent_id, created_seq, text_bytes, text_chunks, item_json FROM items WHERE run_id=? AND seq=?", item.row.runId, item.row.seq);
    if (current === undefined) throw new SessionError("INVALID_DATA", "item " + item.row.seq + " of " + item.row.runId + " is updated and is not there");
    if (current.item_id !== item.row.itemId) throw new SessionError("INVALID_TRANSITION", "an item's place and id never change");
    updateRow(db, "items", changedColumns(current, columns, ["run_id", "seq", "item_id", "created_seq"]), { run_id: item.row.runId, seq: item.row.seq });
    counted.set(key(item.row.runId, item.row.seq), { bytes: Number(current.text_bytes), chunks: Number(current.text_chunks), createdSeq: current.created_seq === null ? null : Number(current.created_seq) });
  }

  // Text, appended chunk after chunk; each chunk starts where the one before ended.
  const text = (mutation.text ?? []).map((append): TextAppend => {
    if (!ownsRun(append.runId)) throw new SessionError("INVALID_DATA", "text belongs to a Run that is not this conversation's");
    const where = "chunk " + append.chunk + " of item " + append.itemSeq + " of " + append.runId;
    let total = counted.get(key(append.runId, append.itemSeq));
    if (total === undefined) {
      const row = one(db, "SELECT text_bytes, text_chunks FROM items WHERE run_id=? AND seq=?", append.runId, append.itemSeq);
      if (row === undefined) throw new SessionError("INVALID_DATA", where + " is text of an item that does not exist");
      total = { bytes: Number(row.text_bytes), chunks: Number(row.text_chunks), createdSeq: null };
      counted.set(key(append.runId, append.itemSeq), total);
    }
    if (append.chunk !== total.chunks) throw new SessionError("INVALID_TRANSITION", where + " does not follow chunk " + (total.chunks - 1) + ": text is only appended, one chunk after another");
    if (!wellFormed(append.text))
      throw new SessionError("INVALID_DATA", where + (endsInHighSurrogate(append.text) ? " ends in half of a surrogate pair: the writer holds it for the next chunk" : " holds half of a surrogate pair") + "; SQLite would store it as U+FFFD");
    if (append.byteOffset !== undefined && append.byteOffset !== total.bytes) throw new SessionError("INVALID_TRANSITION", where + " says it starts at byte " + append.byteOffset + " and the text so far ends at " + total.bytes);
    const bytes = utf8Length(append.text), byteOffset = total.bytes;
    insertInto(db, "item_text", textColumns(append, byteOffset, bytes));
    total.bytes += bytes; total.chunks += 1;
    return { ...append, byteOffset };
  });

  for (const run of runs) {
    if (run.op !== "update") continue;
    const columns = runColumns(run.row);
    const current = one(db, "SELECT * FROM runs WHERE session_id=? AND ordinal=?", session, run.row.ordinal);
    if (current === undefined) throw new SessionError("INVALID_DATA", "Run " + run.row.ordinal + " is updated and is not there");
    if (identityChanged(current, columns, RUN_IDENTITY).length > 0) throw new SessionError("INVALID_TRANSITION", "a Run's identity never changes");
    updateRow(db, "runs", changedColumns(current, columns, RUN_IDENTITY), { session_id: session, ordinal: run.row.ordinal });
  }

  // Bindings and switches: updates first (a binding is archived before the one that replaces it is inserted; a switch ends before the next is asked for).
  const bindings = [...(mutation.bindings ?? []).filter(item => item.op === "update"), ...(mutation.bindings ?? []).filter(item => item.op === "insert")] as readonly BindingWrite[];
  for (const binding of bindings) {
    own(binding.row.sessionId, "a native binding");
    const columns = bindingColumns(binding.row);
    if (binding.op === "insert") { insertInto(db, "bindings", columns); continue; }
    const current = one(db, "SELECT * FROM bindings WHERE session_id=? AND ordinal=?", session, binding.row.ordinal);
    if (current === undefined) throw new SessionError("INVALID_DATA", "native binding " + binding.row.ordinal + " is updated and is not there");
    if (identityChanged(current, columns, ["harness_id", "control_id"]).length > 0) throw new SessionError("INVALID_TRANSITION", "a native binding is never taken over");
    updateRow(db, "bindings", changedColumns(current, columns, ["session_id", "ordinal", "harness_id", "control_id"]), { session_id: session, ordinal: binding.row.ordinal });
  }
  const switches = [...(mutation.switches ?? []).filter(item => item.op === "update"), ...(mutation.switches ?? []).filter(item => item.op === "insert")] as readonly SwitchWrite[];
  for (const change of switches) {
    own(change.row.sessionId, "a switch");
    const columns = switchColumns(change.row);
    if (change.op === "insert") { insertInto(db, "switches", columns); continue; }
    const current = one(db, "SELECT * FROM switches WHERE session_id=? AND ordinal=?", session, change.row.ordinal);
    if (current === undefined) throw new SessionError("INVALID_DATA", "switch " + change.row.ordinal + " is updated and is not there");
    if (identityChanged(current, columns, ["switch_id", "command_id"]).length > 0) throw new SessionError("INVALID_TRANSITION", "a switch's request never changes");
    updateRow(db, "switches", changedColumns(current, columns, ["session_id", "ordinal", "switch_id", "command_id", "requested_seq"]), { session_id: session, ordinal: change.row.ordinal });
  }

  for (const ref of mutation.contentRefs ?? []) { own(ref.sessionId, "a content reference"); insertInto(db, "content_refs", contentRefColumns(ref), "ON CONFLICT DO NOTHING"); }
  for (const row of mutation.originHistory ?? []) { own(row.sessionId, "a quoted message"); insertInto(db, "origin_history", originHistoryColumns(row)); }
  for (const print of mutation.noticePrints ?? []) insertInto(db, "notice_prints", { session_id: session, print }, "ON CONFLICT DO NOTHING");

  // Events: the log of the conversation, with the seqs the backfill above counted from.
  const committed = events.map((event, index): SessionEvent => {
    const draft: EventDraft = event;
    if (typeof draft.type !== "string" || !EVENT_TYPE.test(draft.type) || draft.data === null || typeof draft.data !== "object" || Array.isArray(draft.data)) throw new SessionError("INVALID_DATA", "invalid event draft type or data");
    return { type: draft.type, data: draft.data, sessionId: session, seq: first + index + 1, ownerGeneration: options.ownerGeneration, timestamp: options.timestamp };
  });
  for (const event of committed) {
    let payload: string;
    try { payload = JSON.stringify(event); } catch (error) { throw Object.assign(new SessionError("INVALID_DATA", "event " + event.type + " holds a value that is not JSON"), { cause: error }); }
    insertInto(db, "events", { session_id: session, seq: event.seq, owner_generation: event.ownerGeneration, event_json: payload });
  }
  if (mutation.relay !== undefined) {
    if (options.writeRelay === undefined) throw new SessionError("INVALID_INPUT", "the Mutation has relay rows and no writer was given for them");
    options.writeRelay(mutation.relay);
  }

  // The full-text indexes follow the segments this commit finished. Derived data: if an index cannot be kept current the commit goes on without it (search-index.ts says how).
  maintainSearch(db, items.filter(item => (SEARCHED_TYPES as readonly string[]).includes(item.row.type) && !["pending", "running", "waiting"].includes(item.row.status)).map(item => ({ runId: item.row.runId, seq: item.row.seq })), options.indexes);

  // The head, last: its triggers see this commit's rows.
  let version = 1;
  if (stored !== undefined) {
    version = head.version + 1;
    const next = headColumns({ ...head, version });
    const current = one(db, "SELECT * FROM sessions WHERE id=? AND version=?", session, head.version);
    if (current === undefined) throw new SessionError("VERSION_CONFLICT", "the conversation moved before its head was written");
    if (updateRow(db, "sessions", changedColumns(current, next, ["id"]), { id: session, version: head.version }) !== 1) throw new SessionError("VERSION_CONFLICT", "the conversation's head compare-and-swap failed");
  }

  // The Mutation as written.
  const written = (rows: readonly ItemWrite[]): readonly ItemWrite[] => rows.map(item => {
    const total = counted.get(key(item.row.runId, item.row.seq));
    return total === undefined ? item : { ...item, row: { ...item.row, createdSeq: total.createdSeq, textBytes: total.bytes, textChunks: total.chunks } };
  });
  return {
    events: committed,
    changes: { ...mutation, head: { row: { ...head, version } }, ...(mutation.runs === undefined ? {} : { runs: runs }), ...(mutation.items === undefined ? {} : { items: written(items) }),
      ...(mutation.text === undefined ? {} : { text }), events: mutation.events },
  };
}
