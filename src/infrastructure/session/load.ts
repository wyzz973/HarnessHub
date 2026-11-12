import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Conversation, HeadJson, HeldItem, ItemFields } from "../../contracts/conversation.js";
import type { ItemType } from "../../contracts/protocol.js";
import { SessionError, type MessageId, type NativeSessionBinding, type SessionId } from "../../contracts/session.js";
import {
  ITEM_COLUMNS, bindingRowFrom, commandRowFrom, conversationRunOf, headRowFrom, itemFieldsFrom, itemRowFrom, runRowFrom, switchRowFrom,
} from "./rows.js";
import { all, one } from "./statements.js";

/*
 * Reads a conversation back from its rows as the Runtime holds it (`Conversation`, ADR-057 3.3): the head, every Run as its light row, and the
 * items and text of the Runs that are not finished. This is the whole of "the first stage's memory": a small row per Turn, not what the Turns held.
 * Reads of pages (read.ts) and of single Turns use `loadItems`, which is also how the Turn in progress is read.
 */

/** A number no body is longer than: `loadItems` with it leaves nothing out. */
export const WHOLE = Number.MAX_SAFE_INTEGER;

const EMPTY_FIELDS: Readonly<Record<ItemType, ItemFields>> = {
  user_message: { type: "user_message", messageId: "" as MessageId },
  assistant_message: { type: "assistant_message", messageId: "" as MessageId },
  reasoning: { type: "reasoning" },
  command: { type: "command", command: "" },
  file_read: { type: "file_read", path: null },
  file_change: { type: "file_change", changes: [] },
  search: { type: "search", scope: "unknown", query: null },
  web: { type: "web", action: "fetch" },
  mcp_tool: { type: "mcp_tool", server: "", tool: "" },
  tool: { type: "tool", name: "" },
  subagent: { type: "subagent", title: "" },
  plan: { type: "plan", steps: [] },
  plan_proposal: { type: "plan_proposal", markdown: "" },
  recap: { type: "recap", summary: "" },
  approval: { type: "approval", subject: "other", title: "", options: [] },
  question: { type: "question", title: "" },
  notice: { type: "notice", severity: "info" },
  error: { type: "error", class: "unknown", message: "" },
  context_event: { type: "context_event", kind: "compaction" },
  switch: { type: "switch", from: { harnessId: "", harness: "" }, to: { harnessId: "", harness: "" }, context: "unknown", session: "unknown" },
  interrupt: { type: "interrupt", by: "hub" },
  delegation: { type: "delegation", to: { harnessId: "", harness: "" }, task: "" },
  artifact: { type: "artifact", kind: "file", name: "" },
};
/** The fields of an item whose JSON was left out: its type and the type's required fields empty, which a reader takes as "not here" because the item is marked `bodyOmitted`. */
export function emptyFields(type: ItemType): ItemFields {
  const fields = EMPTY_FIELDS[type] as ItemFields | undefined;
  return fields ?? { type: "tool", name: "" };
}

export interface ItemFilter {
  /** Only the items after this seq. */
  readonly after?: number;
  /** At most this many. */
  readonly limit?: number;
  /** Not the items from `from` to `to`: the stretch a window defers. */
  readonly skip?: { readonly from: number; readonly to: number };
}

/** What a page of items weighs on the wire: its JSON and its text where they are carried, and a nominal row each. */
const ROW_BYTES = 64;
export interface ItemsRead { readonly items: HeldItem[]; readonly bytes: number }

/**
 * The items of a Run in place order, with their text. A text longer than `inlineBytes` is not read (`textOmitted`, its size is `textBytes`), and
 * neither is an item's JSON that long (`bodyOmitted`, `fields` empty): reading a page never loads a body the page does not carry. `bytes` is what the
 * items carry.
 */
export function readItems(db: DatabaseSync, runId: string, inlineBytes: number, filter: ItemFilter = {}): ItemsRead {
  const conditions = ["run_id=?"], args: SQLInputValue[] = [inlineBytes, runId];
  if (filter.after !== undefined) { conditions.push("seq>?"); args.push(filter.after); }
  if (filter.skip !== undefined) { conditions.push("NOT (seq BETWEEN ? AND ?)"); args.push(filter.skip.from, filter.skip.to); }
  if (filter.limit !== undefined) args.push(filter.limit);
  const rows = all(db, "SELECT " + ITEM_COLUMNS + ", octet_length(item_json) AS json_bytes, CASE WHEN octet_length(item_json)>? THEN NULL ELSE item_json END AS item_json FROM items WHERE " + conditions.join(" AND ")
    + " ORDER BY seq" + (filter.limit === undefined ? "" : " LIMIT ?"), ...args);
  if (rows.length === 0) return { items: [], bytes: 0 };
  // The text of the items whose text is carried, in one read: the items drive it (the table of chunks is probed by its key).
  const chunks = new Map<number, string[]>();
  const wanted = rows.some(row => Number(row.text_bytes) > 0 && Number(row.text_bytes) <= inlineBytes);
  if (wanted) {
    const low = Number(rows[0]!.seq), high = Number(rows[rows.length - 1]!.seq);
    const where = ["i.run_id=?", "i.seq BETWEEN ? AND ?", "i.text_bytes BETWEEN 1 AND ?"], values: SQLInputValue[] = [runId, low, high, inlineBytes];
    if (filter.skip !== undefined) { where.push("NOT (i.seq BETWEEN ? AND ?)"); values.push(filter.skip.from, filter.skip.to); }
    for (const row of all(db, "SELECT i.seq AS seq, t.text AS text FROM items i JOIN item_text t ON t.run_id=i.run_id AND t.item_seq=i.seq WHERE " + where.join(" AND ") + " ORDER BY i.seq, t.chunk", ...values)) {
      const seq = Number(row.seq);
      let list = chunks.get(seq);
      if (list === undefined) { list = []; chunks.set(seq, list); }
      list.push(String(row.text));
    }
  }
  let bytes = 0;
  const items = rows.map((row): HeldItem => {
    const bodyOmitted = row.item_json === null, textBytes = Number(row.text_bytes), textOmitted = textBytes > inlineBytes;
    const fields = bodyOmitted ? emptyFields(String(row.type) as ItemType) : itemFieldsFrom(row);
    const held = itemRowFrom(row, fields);
    bytes += ROW_BYTES + (bodyOmitted ? 0 : Number(row.json_bytes)) + (textOmitted ? 0 : textBytes);
    return { ...held, text: chunks.get(held.seq) ?? [], ...(textOmitted ? { textOmitted: true as const } : {}), ...(bodyOmitted ? { bodyOmitted: true as const } : {}) };
  });
  return { items, bytes };
}
export function loadItems(db: DatabaseSync, runId: string, inlineBytes: number, filter: ItemFilter = {}): HeldItem[] { return readItems(db, runId, inlineBytes, filter).items; }

/** The conversation as the Runtime reduces it, read whole: the head, every Run, and the items and text of the Runs not finished (their bodies in full: the Turn in progress is held as it is). */
export function loadConversation(db: DatabaseSync, id: SessionId): Conversation {
  const stored = one(db, "SELECT * FROM sessions WHERE id=?", id);
  if (stored === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  const head = headRowFrom(stored), json: HeadJson = head.head;
  const runs = all(db, "SELECT * FROM runs WHERE session_id=? ORDER BY ordinal", id).map(row => {
    const run = runRowFrom(row);
    return conversationRunOf(run, ["completed", "cancelled", "failed", "unknown"].includes(run.status) ? undefined : loadItems(db, run.runId, WHOLE));
  });
  const bindings = all(db, "SELECT * FROM bindings WHERE session_id=? ORDER BY ordinal", id).map(row => bindingRowFrom(row).binding as NativeSessionBinding);
  return { id: head.id, version: head.version, lastSeq: head.lastSeq, format: head.format, epoch: head.epoch, status: head.status, configuration: json.configuration, selection: json.selection,
    activeRunId: head.activeRunId, pendingSwitchId: head.pendingSwitchId, runs, switches: all(db, "SELECT * FROM switches WHERE session_id=? ORDER BY ordinal", id).map(row => switchRowFrom(row).switch),
    commands: all(db, "SELECT * FROM commands WHERE session_id=? ORDER BY ordinal", id).map(row => commandRowFrom(row).command),
    ...(bindings.length === 0 ? {} : { nativeBindings: bindings }), ...(json.origin === undefined ? {} : { origin: json.origin }), ...(json.retainNative === undefined ? {} : { retainNative: json.retainNative }),
    ...(json.retained === undefined ? {} : { retained: json.retained }), ...(json.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: json.relayRecoveryFailed }) };
}
