import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationCommit, ConversationStore, SessionListCursor, SessionListRow } from "../contracts/conversation.js";
import { SessionError, sessionId, type ConversationWorktree, type SessionId } from "../contracts/session.js";
import type { WorktreeView } from "../contracts/web.js";
import { inside } from "../infrastructure/workspace/place.js";
import { createWorktree, discardWorktree, nameWorktreeBranch, removeWorktree, temporaryBranchOf, worktreeState } from "../infrastructure/workspace/worktree.js";

/*
 * Conversations that work in a Git worktree of their own (2026-11-14), mounted by the server:
 *
 *   POST /api/v1/sessions {workspace, worktree: true, selection, commandId}   `start`: the worktree is made (or found again), then the conversation in it
 *   GET  /api/v1/sessions/:id/worktree                                           where the worktree stands (WorktreeView); a deleted conversation is answered too
 *   POST /api/v1/sessions/:id/purge {removeWorktree: true}                       `held` before the erasure, `removeUnused` after (src/web/recall-routes.ts)
 *
 * and, from every published commit (`observe`), the branch is renamed once after the conversation's title. The Git work is src/infrastructure/workspace/worktree.ts.
 */

export interface WorktreeRoutesOptions {
  /** Where worktrees are made: `<root>/<repository folder>/hh-<8 hex>` (a real path). */
  readonly root: string;
  readonly store: Pick<ConversationStore, "head" | "list" | "listDeleted">;
  /** Records the branch the conversation's worktree is on now (`SessionRuntime.recordWorktreeBranch`). */
  readonly record: (id: SessionId, from: string, to: string) => void;
  readonly http: { json(response: ServerResponse, status: number, value: unknown): void; queries(url: URL, allowed: readonly string[]): void };
  /** A line for the service's log: what was kept as it was, and why. */
  readonly report: (line: string) => void;
}
/** A conversation's worktree read before the conversation is erased. */
export interface HeldWorktree { readonly id: SessionId; readonly worktree: ConversationWorktree }
/** What `removeUnused` did with the worktrees of the conversations erased: removed, left because another conversation works in it, or left because Git refused. */
export interface WorktreeRemoval { readonly removed: readonly string[]; readonly shared: readonly string[]; readonly failed: readonly { readonly path: string; readonly message: string }[] }

const notFound = (error: unknown): boolean => error instanceof SessionError && error.code === "SESSION_NOT_FOUND";
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export class WorktreeRoutes {
  /** The requests making a conversation in a worktree, one at a time for each request (a repeat waits for the first, then finds what it made). */
  private readonly locks = new Map<string, Promise<void>>();
  /** The renames asked for (by conversation and temporary branch): each is tried once. */
  private readonly tried = new Set<string>();
  /** Renames run one after another, so two conversations never take one name. */
  private naming: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: WorktreeRoutesOptions) {}

  /**
   * A conversation in a worktree of its own, for the request `key` (src/web/server.ts's POST /api/v1/sessions): under one lock for the request, a conversation the
   * request made already is answered as it is (`prior`: its workspace and worktree; no Git runs); otherwise the worktree is made or found again from the repository
   * `workspace` is in, and the conversation is made in it (`create`). A worktree this call made for a conversation that then was not made is taken back.
   */
  start<T>(workspace: string, key: string, steps: { readonly prior: () => { readonly workspace: string; readonly worktree?: ConversationWorktree } | null; readonly create: (workspace: string, worktree: ConversationWorktree | undefined) => Promise<T> }): Promise<T> {
    return this.locked(key, async () => {
      const prior = steps.prior();
      if (prior !== null) return steps.create(prior.workspace, prior.worktree);
      const made = await createWorktree(workspace, this.options.root, key, this.options.report);
      try { return await steps.create(made.workspace, made.worktree); }
      catch (error) {
        if (made.created && steps.prior() === null) {
          try { await discardWorktree(made.worktree); } catch (failure) { this.options.report("a worktree made for a conversation that was not made is left at " + made.worktree.path + " (" + reason(failure) + ")"); }
        }
        throw error;
      }
    });
  }
  private locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const run = before.then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /** GET /api/v1/sessions/:id/worktree; false for any other request. */
  async handle(_request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const found = /^\/api\/v1\/sessions\/([^/]+)\/worktree$/u.exec(url.pathname);
    if (found === null || method !== "GET") return false;
    this.options.http.queries(url, []);
    // A deleted conversation is read too: the page asks about its worktree before erasing it.
    const id = sessionId(found[1]!), worktree = this.options.store.head(id).head.worktree;
    if (worktree === undefined) throw new SessionError("WORKTREE_NOT_FOUND", "这个对话没有自己的工作树");
    const state = await worktreeState(worktree);
    const view: WorktreeView = { path: worktree.path, branch: state.branch, dirty: state.dirty, shared: this.usedBy(worktree.path, new Set([id])).length > 0, ...(state.missing ? { missing: true as const } : {}) };
    this.options.http.json(response, 200, view);
    return true;
  }

  /** The conversations not erased (the deleted ones included), other than `except`, whose workspace is in the worktree at `path`. */
  usedBy(path: string, except: ReadonlySet<string>): SessionId[] {
    return this.rows().filter(row => !except.has(row.id) && inside(path, row.workspace)).map(row => row.id);
  }
  /** Every conversation not erased, the deleted ones included. */
  private rows(): SessionListRow[] {
    const { store } = this.options, rows: SessionListRow[] = [];
    for (let after: SessionListCursor | undefined; ;) {
      const page = store.list({ ...(after === undefined ? {} : { after }), limit: 10_000 });
      rows.push(...page.rows);
      if (page.next === null || page.rows.length === 0) break;
      after = page.next;
    }
    if (store.listDeleted !== undefined) for (let before: string | undefined; ;) {
      const page = store.listDeleted({ ...(before === undefined ? {} : { before }), limit: 10_000 });
      rows.push(...page.rows);
      if (page.next === null || page.rows.length === 0) break;
      before = page.next;
    }
    return rows;
  }

  /** The worktrees of conversations about to be erased, read while they are there: those of `ids`, or (no `ids`) those of every conversation the user deleted. */
  held(ids?: readonly SessionId[]): HeldWorktree[] {
    const { store } = this.options, held: HeldWorktree[] = [];
    if (ids !== undefined) {
      for (const id of ids) { try { const worktree = store.head(id).head.worktree; if (worktree !== undefined) held.push({ id, worktree }); } catch (error) { if (!notFound(error)) throw error; } }
      return held;
    }
    if (store.listDeleted !== undefined) for (let before: string | undefined; ;) {
      const page = store.listDeleted({ ...(before === undefined ? {} : { before }), limit: 10_000 });
      for (const row of page.rows) if (row.worktree !== undefined) held.push({ id: row.id, worktree: row.worktree });
      if (page.next === null || page.rows.length === 0) break;
      before = page.next;
    }
    return held;
  }
  /**
   * After an erasure: each worktree of `held` whose conversation is no longer there, and that no conversation left (the deleted ones included) works in, is removed
   * (`removeWorktree`: forced, then pruned; the branch stays). The others are left as they are. One worktree at a time.
   */
  async removeUnused(held: readonly HeldWorktree[]): Promise<WorktreeRemoval> {
    const gone = new Map<string, ConversationWorktree>();
    for (const entry of held) {
      let erased = false;
      try { this.options.store.head(entry.id); } catch (error) { if (!notFound(error)) throw error; erased = true; }
      if (erased && !gone.has(entry.worktree.path)) gone.set(entry.worktree.path, entry.worktree);
    }
    const removed: string[] = [], shared: string[] = [], failed: { path: string; message: string }[] = [];
    for (const [path, worktree] of gone) {
      if (this.usedBy(path, new Set()).length > 0) { shared.push(path); continue; }
      let result: Awaited<ReturnType<typeof removeWorktree>>;
      try { result = await removeWorktree(worktree); } catch (error) { result = { failed: reason(error) }; }
      if ("removed" in result) removed.push(path); else failed.push({ path, message: result.failed });
    }
    return { removed, shared, failed };
  }

  /**
   * Every published commit: a conversation with a worktree still on its temporary branch that now has a title (the user's, its Harness's, or its first message's) has the
   * branch renamed after it, once (`nameWorktreeBranch`), and the new name recorded. A rename that does not happen keeps the temporary name and is only logged.
   */
  observe(commit: ConversationCommit): void {
    if (this.closed) return;
    const conversation = commit.conversation, worktree = conversation.worktree, title = commit.changes.head?.row.title;
    // Only the conversation it was made for names it.
    if (worktree === undefined || worktree.inherited === true || title === undefined || conversation.deletedAt !== undefined) return;
    const temporary = temporaryBranchOf(worktree);
    if (temporary === null || worktree.branch !== temporary) return;
    // The name waits for the best title there will be: the user's or the one its Harness gives (a few words, in its first wrap-up); the first message's only once the
    // first Turn has ended without one (a long sentence makes a long branch name).
    const ended = conversation.runs.some(run => run.status === "completed" || run.status === "cancelled" || run.status === "failed" || run.status === "unknown");
    if (conversation.userTitle === undefined && conversation.harnessTitle === undefined && !ended) return;
    const key = conversation.id + "\0" + temporary;
    if (this.tried.has(key)) return;
    this.tried.add(key);
    const id = conversation.id, work = this.naming = this.naming.then(() => this.name(id, worktree, title));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
  private async name(id: SessionId, worktree: ConversationWorktree, title: string): Promise<void> {
    try {
      const named = await nameWorktreeBranch(worktree, title);
      if ("kept" in named) { this.options.report("a conversation's worktree keeps its branch " + worktree.branch + " (" + named.kept + ")"); return; }
      this.options.record(id, worktree.branch, named.branch);
      // The conversations sharing it (delegated, branched) carry the new name too.
      for (const row of this.rows()) {
        if (row.id === id || row.worktree?.path !== worktree.path) continue;
        try { this.options.record(row.id, worktree.branch, named.branch); } catch (error) { this.options.report("a conversation sharing a worktree keeps the branch name " + worktree.branch + " (" + reason(error) + ")"); }
      }
    } catch (error) { this.options.report("a conversation's worktree keeps its branch " + worktree.branch + " (" + reason(error) + ")"); }
  }

  /** Stops taking renames and waits for those under way. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
