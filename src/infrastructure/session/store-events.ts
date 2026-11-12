import { SessionError, type EventDraft } from "../../contracts/session.js";
import { object, text } from "./store-root.js";

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

/** The page size a caller asked for, or the default: from 1 to `PAGE_EVENTS`. */
export function pageLimit(limit: number | undefined): number {
  const chosen = limit ?? DEFAULT_PAGE_EVENTS;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > PAGE_EVENTS) throw new SessionError("INVALID_INPUT", "read limit must be between 1 and " + PAGE_EVENTS);
  return chosen;
}
