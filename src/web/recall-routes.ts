import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionError, sessionId, type SessionId } from "../contracts/session.js";
import type { DeletedSessionListView, PurgedView, SearchView, SessionSearchView } from "../contracts/web.js";
import type { ConversationRoutes } from "./conversation-routes.js";
import { searchAll, searchConversation, type MessageSearchSource } from "./message-search.js";

/*
 * The recently deleted, their erasure, and the page's search (2026-11-14), mounted by the server before its routes of one conversation (a path of these is not a
 * conversation's id, and an erasure finds a deleted conversation, which the conversation's routes do not):
 *
 *   GET  /api/v1/sessions/deleted?before=&limit=     the conversations the user deleted, the latest deleted first (DeletedSessionListView)
 *   POST /api/v1/sessions/:id/purge                  {} → 204: erases one of them; 409 DELETION_REQUIRED for one not deleted, 404 for one not there
 *   POST /api/v1/sessions/purge-deleted              {} → { purged }: erases them all
 *   GET  /api/v1/search?q=&cursor=&limit=            the conversations' titles and messages (SearchView)
 *   GET  /api/v1/sessions/:id/search?q=&cursor=&limit=   one conversation's messages, in order (SessionSearchView); a deleted one is not found
 *
 * Every write here has passed the server's Origin and CSRF checks, as every other.
 */

export interface RecallHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  headers(response: ServerResponse): void;
  queries(url: URL, allowed: readonly string[]): void;
  body(request: IncomingMessage): Promise<unknown>;
}
export interface RecallRoutesOptions {
  readonly conversations: () => ConversationRoutes;
  readonly runtime: { purgeSession(id: SessionId): Promise<void>; purgeDeleted(): Promise<number> };
  readonly search: MessageSearchSource;
  readonly http: RecallHttp;
}

function refuse(message: string): never { throw new SessionError("INVALID_INPUT", message); }
/** A page size a URL spells in digits: a whole number from 1, no largest; undefined when not given. */
function size(url: URL): number | undefined {
  const value = url.searchParams.get("limit");
  if (value === null) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) refuse("limit must be a whole number from 1");
  return Number(value);
}

export class RecallRoutes {
  constructor(private readonly options: RecallRoutesOptions) {}

  /** Answers one of these routes; false for any other request. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const { http } = this.options, path = url.pathname;
    if (path === "/api/v1/sessions/deleted" && method === "GET") {
      http.queries(url, ["before", "limit"]);
      const limit = size(url), before = url.searchParams.get("before") ?? undefined;
      http.json(response, 200, this.options.conversations().deleted({ ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) }) satisfies DeletedSessionListView); return true;
    }
    if (path === "/api/v1/sessions/purge-deleted" && method === "POST") {
      http.queries(url, []); await this.empty(request);
      http.json(response, 200, { purged: await this.options.runtime.purgeDeleted() } satisfies PurgedView); return true;
    }
    const purge = /^\/api\/v1\/sessions\/([^/]+)\/purge$/u.exec(path);
    if (purge && method === "POST") {
      http.queries(url, []); const id = sessionId(purge[1]!); await this.empty(request);
      await this.options.runtime.purgeSession(id);
      if (!response.destroyed && !response.writableEnded) { http.headers(response); response.statusCode = 204; response.end(); }
      return true;
    }
    const inOne = /^\/api\/v1\/sessions\/([^/]+)\/search$/u.exec(path);
    if ((path === "/api/v1/search" || inOne) && method === "GET") {
      http.queries(url, ["q", "cursor", "limit"]);
      const words = url.searchParams.get("q"), cursor = url.searchParams.get("cursor") ?? undefined, limit = size(url);
      if (words === null || words.trim() === "") refuse("q must be the words to search for");
      const options = { ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
      if (inOne) http.json(response, 200, searchConversation(this.options.search, sessionId(inOne[1]!), words, options) satisfies SessionSearchView);
      else http.json(response, 200, searchAll(this.options.search, words, options) satisfies SearchView);
      return true;
    }
    return false;
  }
  /** A write here takes an empty JSON object. */
  private async empty(request: IncomingMessage): Promise<void> {
    const value = await this.options.http.body(request);
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0) refuse("Expected an empty JSON object");
  }
}
