import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionError, sessionId, type SessionId } from "../contracts/session.js";
import type { DeletedSessionListView, PurgedView, PurgeSessionView, SearchView, SessionSearchView } from "../contracts/web.js";
import type { ConversationRoutes } from "./conversation-routes.js";
import { searchAll, searchConversation, type MessageSearchSource } from "./message-search.js";
import type { HeldWorktree, WorktreeRemoval } from "./worktree-routes.js";

/*
 * The recently deleted, their erasure, and the page's search (2026-11-14), mounted by the server before its routes of one conversation (a path of these is not a
 * conversation's id, and an erasure finds a deleted conversation, which the conversation's routes do not):
 *
 *   GET  /api/v1/sessions/deleted?before=&limit=     the conversations the user deleted, the latest deleted first (DeletedSessionListView)
 *   POST /api/v1/sessions/:id/purge                  {} → 204: erases one of them; 409 DELETION_REQUIRED for one not deleted, 404 for one not there
 *                                                    {removeWorktree: true} → 200 PurgeSessionView: and then its worktree, when no conversation left works in it
 *   POST /api/v1/sessions/purge-deleted              {} → { purged }: erases them all; {removeWorktree: true} → and their worktrees no conversation left works in
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
  /** The conversations' own worktrees (2026-11-14, src/web/worktree-routes.ts): read before an erasure, removed after it when the request asks. */
  readonly worktrees?: { held(ids?: readonly SessionId[]): readonly HeldWorktree[]; removeUnused(held: readonly HeldWorktree[]): Promise<WorktreeRemoval> };
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
      http.queries(url, []); const worktrees = await this.removing(request);
      // The worktrees are read while their conversations are there, and removed once the erasure is done (a conversation it did not erase keeps its own).
      const held = worktrees?.held() ?? [], purged = await this.options.runtime.purgeDeleted();
      if (worktrees === null) { http.json(response, 200, { purged } satisfies PurgedView); return true; }
      const removal = await worktrees.removeUnused(held);
      http.json(response, 200, { purged, worktreesRemoved: removal.removed.length, ...(removal.failed.length === 0 ? {} : { worktreeFailures: removal.failed }) } satisfies PurgedView); return true;
    }
    const purge = /^\/api\/v1\/sessions\/([^/]+)\/purge$/u.exec(path);
    if (purge && method === "POST") {
      http.queries(url, []); const id = sessionId(purge[1]!), worktrees = await this.removing(request);
      const held = worktrees?.held([id]) ?? [];
      await this.options.runtime.purgeSession(id);
      if (worktrees !== null) {
        const removal = await worktrees.removeUnused(held), failure = removal.failed[0];
        const view: PurgeSessionView = removal.removed.length > 0 ? { worktreeRemoved: true } : removal.shared.length > 0 ? { worktreeKept: "shared" }
          : failure !== undefined ? { worktreeKept: "failed", worktreeError: failure.message } : {};
        http.json(response, 200, view); return true;
      }
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
  /**
   * An erasure takes a JSON object: empty, or `{ removeWorktree: true }` to remove the worktrees of the conversations it erases (2026-11-14). Answers the worktrees
   * to remove them with when that was asked, null when not (`removeWorktree` absent or false).
   */
  private async removing(request: IncomingMessage): Promise<NonNullable<RecallRoutesOptions["worktrees"]> | null> {
    const value = await this.options.http.body(request);
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "removeWorktree")) refuse("Expected an empty JSON object, or { removeWorktree: true }");
    const flag = (value as { readonly removeWorktree?: unknown }).removeWorktree;
    if (flag !== undefined && typeof flag !== "boolean") refuse("removeWorktree is true or false");
    return flag === true ? this.options.worktrees ?? null : null;
  }
}
