import type { DatabaseSync } from "node:sqlite";
import { SessionError, sessionId, type EventDraft, type SessionEvent, type SessionId } from "../../contracts/session.js";
import { all, one } from "./statements.js";
import { integer, object, text } from "./store-root.js";

/*
 * The event log of a conversation: what a commit may write into it and how a page of it is read. Events are kept whole and for good (ADR-057 3.5), and
 * nothing here limits how many a conversation has or how big one is: an event is checked for what it IS (a name, a plain acyclic JSON object) and never for how
 * much of it there is. What is bounded is one transfer: a page is `PAGE_EVENTS` events at most and about `PAGE_BYTES` (it always carries the first event
 * it finds, however big, so that no event is unreadable).
 */

/** The most events one page carries, and the number it carries when the caller does not say. */
export const PAGE_EVENTS = 1000;
export const DEFAULT_PAGE_EVENTS = 100;
/** The size at which a page stops taking more events (the event that crosses it is in). */
export const PAGE_BYTES = 8 * 1024 * 1024;
/** How deep an event's JSON may nest: a guard for the stack of the recursion that checks and copies it, not a limit on what an event may say. */
const NESTING = 64;
const EVENT_TYPE = /^[a-z][a-z0-9._:-]{0,127}$/u;

function jsonData(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > NESTING) throw new SessionError("INVALID_DATA", "event JSON nests deeper than " + NESTING + " levels");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new SessionError("INVALID_DATA", "event must contain only acyclic JSON values");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new SessionError("INVALID_DATA", "event objects must be plain JSON objects");
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) jsonData(item, ancestors, depth + 1);
  ancestors.delete(value);
}

/** The events of a commit as the store keeps them: at least one, each a name and a plain JSON object, copied so that nothing the caller holds can change them later. */
export function drafts(value: readonly EventDraft[]): readonly EventDraft[] {
  if (!Array.isArray(value) || value.length === 0) throw new SessionError("INVALID_DATA", "event write batch must be nonempty");
  return value.map(item => {
    const row = object(item, "event draft");
    if (Object.keys(row).some(key => key !== "type" && key !== "data") || typeof row.type !== "string" || !EVENT_TYPE.test(row.type)) throw new SessionError("INVALID_DATA", "invalid event draft type or fields");
    const data = object(row.data, "event data");
    jsonData(data, new Set(), 0);
    const copy = object(JSON.parse(JSON.stringify({ type: row.type, data })), "copied event");
    return { type: text(copy.type, "event type"), data: object(copy.data, "event data") };
  });
}

function parseStoredEvent(value: unknown, expectedSession: SessionId): SessionEvent {
  const row = object(value, "persisted event");
  if (Object.keys(row).some(key => !["sessionId", "seq", "ownerGeneration", "timestamp", "type", "data"].includes(key))) throw new SessionError("INVALID_DATA", "unknown persisted event fields");
  const type = text(row.type, "event type");
  if (!EVENT_TYPE.test(type)) throw new SessionError("INVALID_DATA", "invalid persisted event type");
  const id = sessionId(row.sessionId), timestamp = text(row.timestamp, "event timestamp");
  if (id !== expectedSession || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new SessionError("INVALID_DATA", "event identity or timestamp is inconsistent");
  return { type, data: object(row.data, "event data"), sessionId: id, seq: integer(row.seq, "event seq", 1), ownerGeneration: integer(row.ownerGeneration, "event owner generation", 1), timestamp };
}

/** The page size a caller asked for, or the default: from 1 to `PAGE_EVENTS`. */
export function pageLimit(limit: number | undefined): number {
  const chosen = limit ?? DEFAULT_PAGE_EVENTS;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > PAGE_EVENTS) throw new SessionError("INVALID_INPUT", "read limit must be between 1 and " + PAGE_EVENTS);
  return chosen;
}

/**
 * One page of the events of a conversation after `afterSeq`: the events in order from the next seq on, `limit` at most, and up to `PAGE_BYTES` (the first is
 * always in). Each event is held to the log it belongs to: contiguous seqs, the owner generation the row says, nothing past the conversation's cursor.
 */
export function readEvents(db: DatabaseSync, id: SessionId, afterSeq: number, limit: number): readonly SessionEvent[] {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
  const head = one(db, "SELECT last_seq FROM sessions WHERE id=?", id);
  if (head === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  const lastSeq = integer(head.last_seq, "Session event cursor");
  if (afterSeq > lastSeq) throw new SessionError("INVALID_CURSOR", "event cursor is ahead of persistent history");
  if (afterSeq === lastSeq) return [];
  // The sizes first, so that a page is cut by its weight before any event text is read.
  const sizes = all(db, "SELECT seq, octet_length(event_json) AS bytes FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?", id, afterSeq, limit);
  if (sizes.length === 0) throw new SessionError("INVALID_DATA", "persistent event history has a missing cursor");
  let taken = 0, bytes = 0;
  for (const size of sizes) {
    if (taken > 0 && bytes + integer(size.bytes, "event JSON bytes") > PAGE_BYTES) break;
    bytes += integer(size.bytes, "event JSON bytes"); taken++;
  }
  const first = integer(sizes[0]!.seq, "event row seq", 1), last = integer(sizes[taken - 1]!.seq, "event row seq", 1);
  const result: SessionEvent[] = [];
  for (const row of all(db, "SELECT seq, owner_generation, event_json FROM events WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq", id, first, last)) {
    let value: unknown;
    try { value = JSON.parse(text(row.event_json, "event JSON")); } catch { throw new SessionError("INVALID_DATA", "persisted event is not valid JSON"); }
    const event = parseStoredEvent(value, id);
    if (event.seq !== row.seq || event.ownerGeneration !== row.owner_generation || event.seq !== afterSeq + result.length + 1 || event.seq > lastSeq) throw new SessionError("INVALID_DATA", "persistent event sequence is inconsistent");
    result.push(event);
  }
  return result;
}
