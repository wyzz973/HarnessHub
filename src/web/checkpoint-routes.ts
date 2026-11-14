import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationReader } from "../contracts/conversation.js";
import { SessionError, sessionId, type SessionId } from "../contracts/session.js";
import type { CheckpointListView, CheckpointRestoreView, GitChangesView, GitPullRequestCreatedView, GitPullRequestStatusView } from "../contracts/web.js";
import type { WorkspaceOwnership } from "../contracts/workspace.js";
import { checkpointList, restoreCheckpoint, turnRange } from "../infrastructure/workspace/checkpoints.js";
import { gitChanges, gitFileDiff, type TurnRange } from "../infrastructure/workspace/git.js";
import { createPullRequest, pullRequestStatus } from "../infrastructure/workspace/pull-request.js";
import { sendStream } from "./download.js";

/*
 * A Turn's checkpoints, putting files back, and a pull request (2026-11-14), mounted by the server before its routes of one conversation:
 *
 *   GET  /api/v1/sessions/:id/checkpoints?before=&limit=                the Turns with a checkpoint, the latest first (CheckpointListView)
 *   GET  /api/v1/sessions/:id/git/changes?scope=turn&ordinal=[&whitespace=ignore]      what the Turn changed (GitChangesView); 404 CHECKPOINT_MISSING without a `before`
 *   GET  /api/v1/sessions/:id/git/diff?scope=turn&ordinal=&path=[&whitespace=ignore]   one file of it (GitFileDiffView), streamed as Git writes it
 *   POST /api/v1/sessions/:id/checkpoints/:ordinal/restore   {}          the files back as they were before the Turn (CheckpointRestoreView)
 *   GET  /api/v1/sessions/:id/git/pr                                     what a pull request of the branch would take (GitPullRequestStatusView)
 *   POST /api/v1/sessions/:id/git/pr   { title, body, base? }            the pull request, made with the user's gh (GitPullRequestCreatedView)
 *
 * The other scopes of git/changes and git/diff are the server's. A conversation the user deleted is not found by any of these. Every write has passed the server's
 * Origin and CSRF checks, as every other; a pull request and a restore are made only when the page asks, never by the Gateway itself.
 */

export interface CheckpointHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  headers(response: ServerResponse): void;
  queries(url: URL, allowed: readonly string[]): void;
  body(request: IncomingMessage): Promise<unknown>;
  /** An answer of the server's own: a status and a code it gives as they are. */
  refuse(status: number, code: string, message: string): never;
}
export interface CheckpointRoutesOptions {
  readonly store: Pick<ConversationReader, "head" | "runOrdinal">;
  /** Whether a conversation works in a worktree of its own (contracts/workspace.ts): files are put back only there. */
  readonly ownership: WorkspaceOwnership;
  /** Folders gh is looked for in besides the Gateway's PATH (the login shell's). */
  readonly ghDirs: () => readonly string[];
  readonly now: () => number;
  readonly http: CheckpointHttp;
}
/**
 * Until a conversation can work in a worktree of its own (`SessionSummary.worktree`, made by `POST /sessions` with `worktree: true`), none does: files are put back
 * nowhere. The server takes another WorkspaceOwnership in its options.
 */
export const NO_OWN_WORKTREES: WorkspaceOwnership = { ownWorktree: () => Promise.resolve(false) };

function refuse(message: string): never { throw new SessionError("INVALID_INPUT", message); }
/** A Turn's ordinal as a URL spells it: a whole number from 0, in digits. */
function ordinalOf(value: string | null | undefined, what: string): number {
  if (value === null || value === undefined || !/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) refuse(what + " is a Turn's ordinal, a whole number from 0");
  return Number(value);
}
function ignoreWhitespace(url: URL): boolean {
  const value = url.searchParams.get("whitespace");
  if (value !== null && value !== "ignore") refuse("whitespace is ignore or absent");
  return value === "ignore";
}
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) refuse("Expected a JSON object with " + (allowed.length === 0 ? "nothing in it" : allowed.join(", ")));
  return value as Record<string, unknown>;
}

export class CheckpointRoutes {
  constructor(private readonly options: CheckpointRoutesOptions) {}

  /** Answers one of these routes; false for any other request. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname, http: CheckpointHttp = this.options.http;
    const list = /^\/api\/v1\/sessions\/([^/]+)\/checkpoints$/u.exec(path), restore = /^\/api\/v1\/sessions\/([^/]+)\/checkpoints\/([^/]+)\/restore$/u.exec(path);
    const scoped = /^\/api\/v1\/sessions\/([^/]+)\/git\/(changes|diff)$/u.exec(path), pr = /^\/api\/v1\/sessions\/([^/]+)\/git\/pr$/u.exec(path);
    if (list && method === "GET") {
      http.queries(url, ["before", "limit"]);
      const id = sessionId(list[1]!), workspace = this.workspace(id), before = url.searchParams.get("before"), limit = url.searchParams.get("limit");
      if (limit !== null && (!/^[1-9][0-9]*$/u.test(limit) || !Number.isSafeInteger(Number(limit)))) refuse("limit must be a whole number from 1");
      const page = await checkpointList(workspace, id, { ...(before === null ? {} : { before: ordinalOf(before, "before") }), limit: limit === null ? 50 : Number(limit) });
      const restorable = page !== null && await this.options.ownership.ownWorktree(id);
      http.json(response, 200, { checkpoints: page?.checkpoints ?? [], next: page?.next ?? null, restorable } satisfies CheckpointListView); return true;
    }
    if (scoped && method === "GET" && url.searchParams.get("scope") === "turn") {
      const diff = scoped[2] === "diff";
      http.queries(url, diff ? ["scope", "ordinal", "path", "whitespace"] : ["scope", "ordinal", "whitespace"]);
      const id = sessionId(scoped[1]!), workspace = this.workspace(id), ordinal = ordinalOf(url.searchParams.get("ordinal"), "ordinal"), whitespace = ignoreWhitespace(url);
      const named = url.searchParams.get("path");
      if (diff && (named === null || named === "" || named.includes("\0"))) refuse("Expected the file's path");
      const turn = await this.range(id, workspace, ordinal), scope = { kind: "turn" as const, ordinal };
      if (!diff) { http.json(response, 200, await gitChanges(workspace, scope, { ignoreWhitespace: whitespace, turn }) satisfies GitChangesView); return true; }
      const file = await gitFileDiff(workspace, scope, named!, { ignoreWhitespace: whitespace, turn });
      // As the server writes the other scopes' diffs: into the JSON as Git writes it, never held whole; a Git that fails once it is sent ends the connection.
      response.once("close", file.close);
      async function* pieces(): AsyncGenerator<string, void> {
        yield "{\"path\":" + JSON.stringify(file.path) + ",\"diff\":\"";
        for await (const piece of file.text) yield JSON.stringify(piece).slice(1, -1);
        yield "\"" + (file.binary() ? ",\"binary\":true" : "") + "}";
      }
      if (response.destroyed || response.writableEnded) { file.close(); return true; }
      await sendStream(response, pieces(), () => { http.headers(response); response.statusCode = 200; response.setHeader("Content-Type", "application/json; charset=utf-8"); });
      return true;
    }
    if (restore && method === "POST") {
      http.queries(url, []); const id = sessionId(restore[1]!), ordinal = ordinalOf(restore[2], "the Turn"); fields(await http.body(request), []);
      const workspace = this.workspace(id);
      if (!await this.options.ownership.ownWorktree(id)) http.refuse(409, "WORKTREE_REQUIRED", "只有在这段对话自己的工作树里才能还原文件");
      const head = this.options.store.head(id);
      if (head.activeRunId !== null || head.pendingSwitchId !== null) http.refuse(409, "SESSION_ACTIVE", "这段对话有一轮还没结束：等它结束再还原文件");
      const done = await restoreCheckpoint(workspace, id, ordinal, this.options.now());
      if (done === null) http.refuse(404, "CHECKPOINT_MISSING", "这一轮开始前没有留下检查点，没法还原到那里");
      http.json(response, 200, done satisfies CheckpointRestoreView); return true;
    }
    if (pr && method === "GET") {
      http.queries(url, []); const id = sessionId(pr[1]!);
      http.json(response, 200, await pullRequestStatus(this.workspace(id), this.options.ghDirs()) satisfies GitPullRequestStatusView); return true;
    }
    if (pr && method === "POST") {
      http.queries(url, []); const id = sessionId(pr[1]!), input = fields(await http.body(request), ["title", "body", "base"]), workspace = this.workspace(id);
      if (typeof input.title !== "string" || input.title.trim() === "") refuse("A pull request needs a title");
      if (typeof input.body !== "string") refuse("body is the pull request's description, a string (it may be empty)");
      if (input.base !== undefined && typeof input.base !== "string") refuse("base is the branch to merge into");
      http.json(response, 200, await createPullRequest(workspace, this.options.ghDirs(), { title: input.title, body: input.body, ...(input.base === undefined ? {} : { base: input.base as string }) }) satisfies GitPullRequestCreatedView);
      return true;
    }
    return false;
  }

  /** The conversation's workspace; a conversation the user deleted is not found, as one that is not there. */
  private workspace(id: SessionId): string {
    const head = this.options.store.head(id);
    if (head.deletedAt !== null) this.options.http.refuse(404, "SESSION_NOT_FOUND", "public Session was not found");
    return head.head.configuration.workspace;
  }
  /** What the Turn `ordinal` compares: against the working tree as it is now while it runs. 404 CHECKPOINT_MISSING when it has no checkpoint from before it. */
  private async range(id: SessionId, workspace: string, ordinal: number): Promise<TurnRange> {
    const head = this.options.store.head(id), running = head.activeRunId === null ? null : this.options.store.runOrdinal?.(id, head.activeRunId) ?? null;
    const range = await turnRange(workspace, id, ordinal, running === ordinal);
    if (range === null) this.options.http.refuse(404, "CHECKPOINT_MISSING", "这一轮开始前没有留下检查点");
    return range;
  }
}
