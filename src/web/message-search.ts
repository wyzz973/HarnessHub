import type { FoundMessage, HeadRow } from "../contracts/conversation.js";
import { SessionError, type SessionId } from "../contracts/session.js";
import type { SearchHitView, SearchView, SessionSearchHitView, SessionSearchView } from "../contracts/web.js";

/*
 * The page's search (2026-11-14): ⌘K across the conversations, ⌘F in one. What is searched is what the conversations keep as their messages — the user's words and the
 * Harnesses' replies, finished — and, across conversations, their titles; never a tool's output. There is no index: the store's scan (the one `hub_search` reads the words
 * of a conversation with) reads the files, which keeps nothing else to keep right, and a page stops reading once it has its hits.
 *
 *   GET /api/v1/search?q=&cursor=&limit=                every conversation not deleted, the latest activity first; in one, the title, then its messages newest first
 *   GET /api/v1/sessions/:id/search?q=&cursor=&limit=   one conversation, every place, from its first Turn to its newest
 *
 * The words are matched as they are given, ignoring case (Unicode case folding), as a substring: Chinese needs no word breaks. A cursor is the place of the last hit given;
 * a page reads on after it, and what is written meanwhile moves no page. Plain functions over a reader of the store; consumed whole within one request, without waiting.
 */

/** Hits of a page when a read names no size; a size and not a bound. */
export const SEARCH_PAGE = 50;
/** UTF-16 units of the text before and after a place that its snippet shows. */
const BEFORE = 32, AFTER = 80;

/** What the search reads of the store (FileConversationStore). */
export interface MessageSearchSource {
  head(id: SessionId): HeadRow;
  searchRows(): readonly { readonly id: SessionId; readonly title: string; readonly updatedAt: number }[];
  newestMessages(id: SessionId, holds: (text: string) => boolean, before?: number): Iterable<FoundMessage & { readonly place: number }>;
  messagesInOrder(id: SessionId, from?: { readonly ordinal: number; readonly seq: number }): Iterable<FoundMessage>;
}

function refuse(message: string): never { throw new SessionError("INVALID_INPUT", message); }
/** The words as a pattern that ignores case: every character stands for itself. */
function finder(query: string): { readonly holds: (text: string) => boolean; readonly places: (text: string) => IterableIterator<RegExpMatchArray> } {
  if (typeof query !== "string" || query.trim() === "") refuse("q must be the words to search for");
  let one: RegExp, every: RegExp;
  try { const source = query.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&"); one = new RegExp(source, "iu"); every = new RegExp(source, "giu"); }
  catch { return refuse("q cannot be searched for"); }
  return { holds: text => one.test(text), places: text => text.matchAll(every) };
}
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
/** The text around `[start, end)`, cut between characters, with "…" where it was cut and its line breaks made spaces; `match` is the place in it. */
export function snippetOf(text: string, start: number, end: number): { readonly snippet: string; readonly match: readonly [number, number] } {
  let from = Math.max(0, start - BEFORE), to = Math.min(text.length, end + AFTER);
  if (from > 0 && isLow(text.charCodeAt(from))) from--;
  if (to < text.length && isLow(text.charCodeAt(to))) to++;
  const lead = from > 0 ? "…" : "", body = text.slice(from, to).replace(/[\r\n\t\u2028\u2029]/gu, " ");
  return { snippet: lead + body + (to < text.length ? "…" : ""), match: [lead.length + start - from, lead.length + end - from] };
}
function encode(value: Readonly<Record<string, unknown>>): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode(cursor: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* told below */ }
  return refuse("the cursor is not one this search gave");
}
const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A conversation that is not there any more, or whose file cannot be read, is passed over by a search across conversations (as `hub_search` passes it); the store's owner lost is not. */
const passedOver = (error: unknown): boolean => error instanceof SessionError && (error.code === "SESSION_NOT_FOUND" || error.code === "INVALID_DATA" || error.code === "STORAGE_UNAVAILABLE");
const roleOf = (type: FoundMessage["type"]): "user" | "assistant" => type === "user_message" ? "user" : "assistant";

/**
 * A page of `GET /api/v1/search`. The cursor is the conversation of the last hit (its time and id, the list's order) and, in it, the place of that hit's line (null: its
 * title). A conversation that moved on after the page before is read where it is now; one deleted meanwhile is passed over.
 */
export function searchAll(source: MessageSearchSource, query: string, options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {}): SearchView {
  const find = finder(query), limit = options.limit ?? SEARCH_PAGE, hits: SearchHitView[] = [];
  let at: { readonly u: number; readonly s: string; readonly p: number | null } | null = null;
  if (options.cursor !== undefined) {
    const value = decode(options.cursor);
    if (!wholeNumber(value.u) || typeof value.s !== "string" || !(value.p === null || wholeNumber(value.p))) refuse("the cursor is not one this search gave");
    at = { u: value.u, s: value.s, p: value.p as number | null };
  }
  const rows = source.searchRows();
  let index = 0;
  if (at !== null) { const cut = at; index = rows.findIndex(row => row.updatedAt < cut.u || (row.updatedAt === cut.u && row.id >= cut.s)); if (index < 0) index = rows.length; }
  for (; index < rows.length; index++) {
    const row = rows[index]!, resume = at !== null && row.id === at.s && row.updatedAt === at.u ? at : null;
    if (resume === null) {
      const found = find.places(row.title).next();
      if (found.done !== true) {
        const start = found.value.index ?? 0, place = snippetOf(row.title, start, start + found.value[0].length);
        hits.push({ sessionId: row.id, title: row.title, runId: null, ordinal: null, messageId: null, role: "title", snippet: place.snippet, match: place.match });
        if (hits.length >= limit) return { hits, next: encode({ u: row.updatedAt, s: row.id, p: null }) };
      }
    }
    try {
      for (const message of source.newestMessages(row.id, find.holds, resume?.p ?? undefined)) {
        const found = find.places(message.text).next();
        if (found.done === true) continue;
        const start = found.value.index ?? 0, place = snippetOf(message.text, start, start + found.value[0].length);
        hits.push({ sessionId: row.id, title: row.title, runId: message.runId, ordinal: message.ordinal, messageId: message.itemId, role: roleOf(message.type), snippet: place.snippet, match: place.match });
        if (hits.length >= limit) return { hits, next: encode({ u: row.updatedAt, s: row.id, p: message.place }) };
      }
    } catch (error) { if (!passedOver(error)) throw error; }
  }
  return { hits, next: null };
}

/**
 * A page of `GET /api/v1/sessions/:id/search`: every place in the conversation's messages, in the conversation's order. The cursor is the last hit's Turn, item and offset.
 * A conversation not there, or deleted, is not found.
 */
export function searchConversation(source: MessageSearchSource, id: SessionId, query: string, options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {}): SessionSearchView {
  const find = finder(query), limit = options.limit ?? SEARCH_PAGE, hits: SessionSearchHitView[] = [];
  let at: { readonly o: number; readonly q: number; readonly x: number } | null = null;
  if (options.cursor !== undefined) {
    const value = decode(options.cursor);
    if (!wholeNumber(value.o) || !wholeNumber(value.q) || !wholeNumber(value.x)) refuse("the cursor is not one this search gave");
    at = { o: value.o, q: value.q, x: value.x };
  }
  const head = source.head(id);
  if (head.deletedAt !== null) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  for (const message of source.messagesInOrder(id, at === null ? undefined : { ordinal: at.o, seq: at.q })) {
    const after = at !== null && message.ordinal === at.o && message.seq === at.q ? at.x : -1;
    for (const found of find.places(message.text)) {
      const start = found.index ?? 0;
      if (start <= after) continue;
      const place = snippetOf(message.text, start, start + found[0].length);
      hits.push({ sessionId: id, title: head.title, runId: message.runId, ordinal: message.ordinal, messageId: message.itemId, role: roleOf(message.type), snippet: place.snippet, match: place.match,
        itemSeq: message.seq, offset: start });
      if (hits.length >= limit) return { hits, next: encode({ o: message.ordinal, q: message.seq, x: start }) };
    }
  }
  return { hits, next: null };
}
