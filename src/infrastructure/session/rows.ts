import type { SQLInputValue } from "node:sqlite";
import type { ContextEffect } from "../../contracts/control.js";
import {
  CONVERSATION_FORMAT,
  type BindingRow, type CommandRow, type ContentRefRow, type ConversationRun, type HeadJson, type HeadRow, type HeldItem, type ItemFields, type ItemRow,
  type OriginHistoryRow, type RunFacts, type RunRow, type SwitchRow, type TextAppend,
} from "../../contracts/conversation.js";
import type { ItemStatus, ItemType } from "../../contracts/protocol.js";
import type { ExecutedOn } from "../../contracts/relay.js";
import {
  SessionError,
  type CommandId, type CommandRecord, type ForkedMessage, type NativeSessionBinding, type PublicRun, type PublicSwitch, type RunId, type RunStatus, type SessionId, type SwitchId,
} from "../../contracts/session.js";

/*
 * Objects <-> rows (ADR-057 3.1, store v14): the one place that knows which column holds what. A `*Columns` function gives the columns of a
 * table as `{ column: value }` for an INSERT or an UPDATE (apply.ts builds its SQL from the names, so the SQL cannot disagree with the
 * columns); a `*RowFrom` function reads a row back as the contract's object (read.ts, load.ts). Nothing here opens a database.
 *
 * Two rules. A row that was written by this code reads back as the object it was made from: `RunRow`, `ItemRow` and the others are plain
 * data, and a column that copies a field of the JSON (a Run's `harness_id`, a binding's `relay_epoch`) is written from the object's own
 * field, so that the two cannot be told apart by a reader. And reading never refuses by size or content: what a row can fail on is its
 * structure (a column of the wrong type, a JSON that does not parse), and that is INVALID_DATA for the conversation it belongs to.
 */

export type Columns = Record<string, SQLInputValue>;
/** A row as node:sqlite gives it. */
export type Rec = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * JSON with the keys of every object in order. A trigger that says "this part of the JSON never changes" compares the text SQLite's
 * `json_extract` gives for it; two equal objects spelled in another key order would differ there, so every JSON a trigger looks into
 * (`run_json`, the head's `head`) is written in this one spelling, whoever built the object.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const source = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, source[key]]));
  });
}
export function utf8Length(text: string): number { return Buffer.byteLength(text, "utf8"); }
const bit = (value: boolean): 0 | 1 => value ? 1 : 0;
/** Whether a text holds no lone surrogate: what SQLite would keep as it is. (A lone one is stored as U+FFFD, so a text with one would not read back as it was written.) */
export function wellFormed(text: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text); }
/** Whether a text ends in the first half of a surrogate pair: a chunk that does goes with the next one (ADR-057 3.2). */
export function endsInHighSurrogate(text: string): boolean { const last = text.charCodeAt(text.length - 1); return last >= 0xd800 && last <= 0xdbff; }

function bad(table: string, column: string, wanted: string): never { throw new SessionError("INVALID_DATA", "stored " + table + "." + column + " is not " + wanted); }
function integer(table: string, row: Rec, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) bad(table, column, "an integer");
  return value;
}
function integerOrNull(table: string, row: Rec, column: string): number | null { return row[column] === null ? null : integer(table, row, column); }
function text(table: string, row: Rec, column: string): string {
  const value = row[column];
  if (typeof value !== "string") bad(table, column, "text");
  return value;
}
function textOrNull(table: string, row: Rec, column: string): string | null { return row[column] === null ? null : text(table, row, column); }
function flag(table: string, row: Rec, column: string): boolean {
  const value = row[column];
  if (value !== 0 && value !== 1) bad(table, column, "a flag");
  return value === 1;
}
function json(table: string, row: Rec, column: string): unknown {
  try { return JSON.parse(text(table, row, column)); } catch (error) { if (error instanceof SessionError) throw error; return bad(table, column, "JSON"); }
}
function jsonObject(table: string, row: Rec, column: string): Record<string, unknown> {
  const value = json(table, row, column);
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(table, column, "a JSON object");
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The head: sessions
// ---------------------------------------------------------------------------------------------------------------------

/** Every column of `sessions`, in the order of the table. */
export const SESSION_COLUMNS = ["id", "version", "last_seq", "head", "format", "status", "epoch", "active_run_id", "pending_switch_id", "kept", "title", "run_count", "updated_at", "deleted_at", "last_error"] as const;

export function headJson(head: HeadJson): string { return canonicalJson(head); }
export function headColumns(row: HeadRow): Columns {
  return { id: row.id, version: row.version, last_seq: row.lastSeq, head: headJson(row.head), format: row.format, status: row.status, epoch: row.epoch, active_run_id: row.activeRunId,
    pending_switch_id: row.pendingSwitchId, kept: bit(row.kept), title: row.title, run_count: row.runCount, updated_at: row.updatedAt, deleted_at: row.deletedAt, last_error: row.lastError };
}
/** The head of a conversation that was converted; the row of one that was not (`format` 13) holds its whole snapshot in `head` and is the legacy readers'. */
export function headRowFrom(row: Rec): HeadRow {
  const format = integer("sessions", row, "format");
  if (format !== CONVERSATION_FORMAT) throw new SessionError("INVALID_DATA", "the conversation is not converted to the tables yet");
  const status = text("sessions", row, "status");
  if (status !== "open" && status !== "closed" && status !== "blocked") bad("sessions", "status", "a conversation status");
  return { id: text("sessions", row, "id") as SessionId, version: integer("sessions", row, "version"), lastSeq: integer("sessions", row, "last_seq"), format: CONVERSATION_FORMAT, status,
    epoch: integer("sessions", row, "epoch"), activeRunId: textOrNull("sessions", row, "active_run_id") as RunId | null, pendingSwitchId: textOrNull("sessions", row, "pending_switch_id") as SwitchId | null,
    kept: flag("sessions", row, "kept"), title: text("sessions", row, "title"), runCount: integer("sessions", row, "run_count"), updatedAt: integer("sessions", row, "updated_at"),
    deletedAt: integerOrNull("sessions", row, "deleted_at"), lastError: textOrNull("sessions", row, "last_error"), head: jsonObject("sessions", row, "head") as unknown as HeadJson };
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------------

/** Every column of `runs`, in the order of the table. */
export const RUN_COLUMNS = ["session_id", "ordinal", "run_id", "command_id", "status", "epoch", "harness_id", "control_id", "managed", "accepted_at", "preparing_at", "ready_at", "reused", "user_seq",
  "ended_seq", "dispatched", "executed_harness_id", "executed_control_id", "executed_epoch", "is_command", "command_effect", "settled_effect", "acknowledged_by", "cancel_requested", "stop_requested",
  "legacy_order", "run_json"] as const;
/** The columns that name a Run and never change: an UPDATE leaves them out. */
export const RUN_IDENTITY = ["session_id", "ordinal", "run_id", "command_id", "user_seq"] as const;
export function runColumns(row: RunRow): Columns {
  const on = row.executedOn;
  return { session_id: row.sessionId, ordinal: row.ordinal, run_id: row.runId, command_id: row.commandId, status: row.status, epoch: row.epoch, harness_id: row.harnessId, control_id: row.controlId,
    managed: bit(row.managed), accepted_at: row.acceptedAt, preparing_at: row.preparingAt, ready_at: row.readyAt, reused: bit(row.reused), user_seq: row.userSeq, ended_seq: row.endedSeq,
    dispatched: bit(row.dispatched), executed_harness_id: on?.harnessId ?? null, executed_control_id: on?.controlId ?? null, executed_epoch: on?.nativeEpoch ?? null, is_command: bit(row.isCommand),
    command_effect: row.commandEffect, settled_effect: row.settledEffect, acknowledged_by: row.acknowledgedBy, cancel_requested: bit(row.cancelRequested), stop_requested: bit(row.stopRequested),
    legacy_order: bit(row.legacyOrder), run_json: canonicalJson(row.facts) };
}
export function runRowFrom(row: Rec): RunRow {
  const harness = textOrNull("runs", row, "executed_harness_id");
  const executedOn: ExecutedOn | null = harness === null ? null
    : { harnessId: harness, controlId: text("runs", row, "executed_control_id"), nativeEpoch: integer("runs", row, "executed_epoch") };
  return { sessionId: text("runs", row, "session_id") as SessionId, ordinal: integer("runs", row, "ordinal"), runId: text("runs", row, "run_id") as RunId, commandId: text("runs", row, "command_id") as CommandId,
    status: text("runs", row, "status") as RunStatus, epoch: integer("runs", row, "epoch"), harnessId: text("runs", row, "harness_id"), controlId: text("runs", row, "control_id"),
    managed: flag("runs", row, "managed"), acceptedAt: integerOrNull("runs", row, "accepted_at"), preparingAt: integerOrNull("runs", row, "preparing_at"), readyAt: integerOrNull("runs", row, "ready_at"),
    reused: flag("runs", row, "reused"), userSeq: integer("runs", row, "user_seq"), endedSeq: integerOrNull("runs", row, "ended_seq"), dispatched: flag("runs", row, "dispatched"), executedOn,
    isCommand: flag("runs", row, "is_command"), commandEffect: textOrNull("runs", row, "command_effect") as ContextEffect | null, settledEffect: textOrNull("runs", row, "settled_effect") as ContextEffect | null,
    acknowledgedBy: textOrNull("runs", row, "acknowledged_by") as SwitchId | null, cancelRequested: flag("runs", row, "cancel_requested"), stopRequested: flag("runs", row, "stop_requested"),
    legacyOrder: flag("runs", row, "legacy_order"), facts: jsonObject("runs", row, "run_json") as unknown as RunFacts };
}
// The Run as the Runtime holds it and as its row: the domain's pair (run-row.ts), re-exported here with the rest of the objects <-> rows.
export { RUN_FACT_KEYS, conversationRunOf, isDispatched, runRowOf } from "../../contexts/session/domain/run-row.js";

// ---------------------------------------------------------------------------------------------------------------------
// Items and their text
// ---------------------------------------------------------------------------------------------------------------------

/** The columns of `items` that are read as a row (all of them but `id`, the full-text indexes' key, which readers that need it ask for). */
export const ITEM_COLUMNS = "run_id, seq, item_id, type, status, started_at, ended_at, parent_id, created_seq, text_bytes, text_chunks";
/**
 * The columns a writer gives: not `text_bytes` and `text_chunks` (the insert trigger of `item_text` keeps them), and not `id`. The type
 * is a column and also the `type` of the JSON; a row whose two disagree was not made from one item.
 */
export function itemColumns(row: ItemRow): Columns {
  if (row.fields.type !== row.type) throw new SessionError("INVALID_DATA", "item " + row.itemId + " says " + row.type + " and its fields say " + row.fields.type);
  return { run_id: row.runId, seq: row.seq, item_id: row.itemId, type: row.type, status: row.status, started_at: row.startedAt, ended_at: row.endedAt, parent_id: row.parentId, created_seq: row.createdSeq,
    item_json: JSON.stringify(row.fields) };
}
/** The row of a held item: not its text (the chunks go as appends) and not the marks a page read puts on it. */
export function itemRowOf(item: HeldItem): ItemRow {
  const { text: _text, textOmitted: _textOmitted, bodyOmitted: _bodyOmitted, ...row } = item;
  return row;
}
/** An item row from its columns and its fields (the `item_json`, or what stands in for it when a page leaves a long one out: load.ts `emptyFields`). */
export function itemRowFrom(row: Rec, fields: ItemFields): ItemRow {
  return { runId: text("items", row, "run_id") as RunId, seq: integer("items", row, "seq"), itemId: text("items", row, "item_id"), type: text("items", row, "type") as ItemType,
    status: text("items", row, "status") as ItemStatus, startedAt: integerOrNull("items", row, "started_at"), endedAt: integerOrNull("items", row, "ended_at"), parentId: textOrNull("items", row, "parent_id"),
    createdSeq: integerOrNull("items", row, "created_seq"), textBytes: integer("items", row, "text_bytes"), textChunks: integer("items", row, "text_chunks"), fields };
}
export function itemFieldsFrom(row: Rec): ItemFields {
  const fields = jsonObject("items", row, "item_json");
  if (fields.type !== row.type) throw new SessionError("INVALID_DATA", "item " + String(row.item_id) + " says " + String(row.type) + " and its fields say " + String(fields.type));
  return fields as unknown as ItemFields;
}
/** One chunk of text as a row: the offset it starts at and its size are the writer's to know, and the table checks them. */
export function textColumns(append: TextAppend, byteOffset: number, bytes: number): Columns {
  return { run_id: append.runId, item_seq: append.itemSeq, chunk: append.chunk, byte_offset: byteOffset, text: append.text, bytes };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bindings, commands, switches, content references, origin history
// ---------------------------------------------------------------------------------------------------------------------

export function bindingRowOf(sessionId: SessionId, ordinal: number, binding: NativeSessionBinding): BindingRow {
  const relay = binding.relay;
  if (relay === undefined) throw new SessionError("INVALID_DATA", "a native binding of a converted conversation has its relay state");
  return { sessionId, ordinal, harnessId: binding.harnessId, controlId: binding.controlId, checkpoint: binding.checkpoint, status: binding.status, opensNew: binding.opensNew === true,
    throughRunId: binding.throughRunId, relayEpoch: relay.epoch, relayMark: relay.mark, relayFloor: relay.floor, binding };
}
export function bindingColumns(row: BindingRow): Columns {
  return { session_id: row.sessionId, ordinal: row.ordinal, harness_id: row.harnessId, control_id: row.controlId, checkpoint: row.checkpoint, status: row.status, opens_new: bit(row.opensNew),
    through_run_id: row.throughRunId, relay_epoch: row.relayEpoch, relay_mark: row.relayMark, relay_floor: row.relayFloor, binding_json: JSON.stringify(row.binding) };
}
export function bindingRowFrom(row: Rec): BindingRow {
  const binding = jsonObject("bindings", row, "binding_json") as unknown as NativeSessionBinding;
  return { sessionId: text("bindings", row, "session_id") as SessionId, ordinal: integer("bindings", row, "ordinal"), harnessId: text("bindings", row, "harness_id"), controlId: text("bindings", row, "control_id"),
    checkpoint: text("bindings", row, "checkpoint"), status: text("bindings", row, "status") as NativeSessionBinding["status"], opensNew: flag("bindings", row, "opens_new"),
    throughRunId: textOrNull("bindings", row, "through_run_id") as RunId | null, relayEpoch: integer("bindings", row, "relay_epoch"), relayMark: integer("bindings", row, "relay_mark"),
    relayFloor: integer("bindings", row, "relay_floor"), binding };
}

export function commandRowOf(sessionId: SessionId, ordinal: number, command: CommandRecord): CommandRow { return { sessionId, ordinal, command }; }
export function commandColumns(row: CommandRow): Columns {
  return { session_id: row.sessionId, ordinal: row.ordinal, command_id: row.command.id, kind: row.command.kind, fingerprint: row.command.fingerprint, result_id: row.command.resultId };
}
export function commandRowFrom(row: Rec): CommandRow {
  return { sessionId: text("commands", row, "session_id") as SessionId, ordinal: integer("commands", row, "ordinal"),
    command: { id: text("commands", row, "command_id") as CommandId, kind: text("commands", row, "kind") as CommandRecord["kind"], fingerprint: text("commands", row, "fingerprint"), resultId: text("commands", row, "result_id") } };
}

/**
 * What `SwitchRow.sourceThroughOrdinal` says: `n - 1` when the `n` sources of a switch are exactly the first `n` Runs in order (`runIdAt(i)` is the id of the
 * Run at ordinal `i`); null for any other set (a Run that queued while the switch was asked for is skipped), which stays in the switch itself.
 */
export function sourceThroughOrdinal(sources: readonly string[], runIdAt: (index: number) => string | undefined): number | null {
  if (sources.length === 0) return null;
  for (let index = 0; index < sources.length; index++) if (runIdAt(index) !== sources[index]) return null;
  return sources.length - 1;
}
export function switchRowOf(sessionId: SessionId, ordinal: number, change: PublicSwitch, sourceThroughOrdinal: number | null): SwitchRow { return { sessionId, ordinal, sourceThroughOrdinal, switch: change }; }
export function switchColumns(row: SwitchRow): Columns {
  const change = row.switch;
  return { session_id: row.sessionId, ordinal: row.ordinal, switch_id: change.id, command_id: change.commandId, status: change.status, requested_seq: change.requestedSeq, through_seq: change.throughSeq,
    source_through_ordinal: row.sourceThroughOrdinal, switch_json: JSON.stringify(change) };
}
export function switchRowFrom(row: Rec): SwitchRow {
  return { sessionId: text("switches", row, "session_id") as SessionId, ordinal: integer("switches", row, "ordinal"), sourceThroughOrdinal: integerOrNull("switches", row, "source_through_ordinal"),
    switch: jsonObject("switches", row, "switch_json") as unknown as PublicSwitch };
}

export function contentRefColumns(row: ContentRefRow): Columns {
  return { content_id: row.contentId, session_id: row.sessionId, run_id: row.runId, item_seq: row.itemSeq, role: row.role };
}
export function originHistoryColumns(row: OriginHistoryRow): Columns {
  return { session_id: row.sessionId, idx: row.idx, kind: row.kind, message_json: JSON.stringify(row.message) };
}
export function originHistoryRowFrom(row: Rec): OriginHistoryRow {
  const kind = text("origin_history", row, "kind");
  if (kind !== "fork" && kind !== "import") bad("origin_history", "kind", "fork or import");
  return { sessionId: text("origin_history", row, "session_id") as SessionId, idx: integer("origin_history", row, "idx"), kind, message: jsonObject("origin_history", row, "message_json") as unknown as ForkedMessage };
}
