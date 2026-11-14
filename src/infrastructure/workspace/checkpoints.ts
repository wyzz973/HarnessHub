import { copyFile, mkdtemp, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SessionError } from "../../contracts/session.js";
import type { CheckpointRestoreView, CheckpointView } from "../../contracts/web.js";
import type { WorkspaceCheckpoints } from "../../contracts/workspace.js";
import type { TurnRange } from "./git.js";
import { runGit, said, type Ran } from "./program.js";

/*
 * A Turn's checkpoints (2026-11-14, after T3 Code): before a Turn starts and after it ends, the working tree of the repository its workspace is in is kept as a commit,
 * whole (what is not committed, staged or not, and what is untracked; not what .gitignore leaves out), named by the Hub's own refs only:
 *
 *   refs/harnesshub/checkpoints/<sessionId>/<ordinal>/before|after      a Turn's, by its ordinal (from 0)
 *   refs/harnesshub/checkpoints/<sessionId>/restore-<epoch ms>          the files as they were just before the user put them back
 *
 * Nothing the user has is touched: the working tree is staged into an index of its own (GIT_INDEX_FILE, a copy of the repository's index so that what Git already knows
 * of each file is not read again, or HEAD's tree when there is no index), written as a tree, committed with HEAD as its parent (none before the first commit) by
 * "HarnessHub <hub@localhost>", never signed, and only then named. HEAD, the branches and the user's index stay as they were. A Turn branched from an earlier place takes
 * that place's ordinal, so its `before` replaces the one there and the `after` of the Turn it replaces goes with it.
 */

const PREFIX = "refs/harnesshub/checkpoints/";
/** How long a Turn's capture may take: one not done by then is given up for that Turn. */
const CAPTURE_MS = 5000;
/** How long a read may take, and what the reads and the restore stage of the working tree (a capture the user waits for). */
const READ_MS = 15_000, STAGE_MS = 60_000, WRITE_MS = 2 * 60_000;
const IDENTITY = { GIT_AUTHOR_NAME: "HarnessHub", GIT_AUTHOR_EMAIL: "hub@localhost", GIT_COMMITTER_NAME: "HarnessHub", GIT_COMMITTER_EMAIL: "hub@localhost" } as const;
const MESSAGE = "HarnessHub checkpoint";

export const checkpointRef = (sessionId: string, ordinal: number, side: "before" | "after"): string => PREFIX + sessionId + "/" + ordinal + "/" + side;
const left = (until: number): number => until - Date.now();

/** A Git that refused or ran out of time, in its own words: a conflict with where the repository stands (409). */
function need(ran: Ran, what: string): Ran {
  if (ran.code === 0 && !ran.timedOut) return ran;
  throw new SessionError("GIT_FAILED", ran.timedOut ? what + " 没有在时限内完成，已停下" : what + " 没有成功：" + (said(ran) || "退出码 " + String(ran.code)));
}
/** A Git that is not there, or a folder that is not, as a failure of its own. */
async function git(cwd: string, args: readonly string[], options: Parameters<typeof runGit>[2]): Promise<Ran> {
  try { return await runGit(cwd, args, options); }
  catch (error) {
    if ((error as { readonly code?: unknown } | null)?.code === "ENOENT") throw new SessionError("GIT_UNAVAILABLE", "这台 Mac 上找不到 git，或者工作区已经不在了");
    throw error;
  }
}

/** Where a workspace is in Git: the top of its working tree and the index it uses; null when it is in no repository (or not there). */
async function located(workspace: string, until: number): Promise<{ readonly top: string; readonly index: string } | null> {
  const real = await realpath(workspace).catch(() => null);
  if (real === null) return null;
  const ran = await git(real, ["rev-parse", "--show-toplevel", "--git-path", "index"], { timeoutMs: left(until) });
  if (ran.timedOut) throw new SessionError("GIT_FAILED", "git rev-parse 没有在时限内完成");
  if (ran.code !== 0) return null;
  const [top = "", index = ""] = ran.stdout.split("\n");
  return top === "" || index === "" ? null : { top, index: isAbsolute(index) ? index : resolve(real, index) };
}
/** The commit a ref names; null when there is none. */
async function commitAt(top: string, ref: string): Promise<string | null> {
  const ran = await git(top, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], { timeoutMs: READ_MS });
  const sha = ran.stdout.trim();
  return ran.code === 0 && /^[0-9a-f]{40,64}$/u.test(sha) ? sha : null;
}
/** The working tree as a tree of its own, with HEAD as it is (null before the first commit); the user's index is only copied. */
async function treeOf(where: { readonly top: string; readonly index: string }, until: number): Promise<{ readonly tree: string; readonly head: string | null }> {
  const head = await commitAt(where.top, "HEAD"), dir = await mkdtemp(join(tmpdir(), "harnesshub-checkpoint-")), index = join(dir, "index"), env = { GIT_INDEX_FILE: index };
  try {
    const kept = await stat(where.index).catch(() => null);
    // The copy keeps the index's time, so that Git still checks again a file changed in the same moment the index was written.
    if (kept?.isFile() === true) { await copyFile(where.index, index); await utimes(index, kept.atime, kept.mtime); }
    else if (head !== null) need(await git(where.top, ["read-tree", head], { env, timeoutMs: left(until) }), "git read-tree");
    need(await git(where.top, ["-c", "core.splitIndex=false", "add", "-A", "--", "."], { env, timeoutMs: left(until) }), "git add");
    const tree = need(await git(where.top, ["write-tree"], { env, timeoutMs: left(until) }), "git write-tree").stdout.trim();
    return { tree, head };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function commitTree(top: string, tree: string, head: string | null, until: number): Promise<string> {
  return need(await git(top, ["commit-tree", "--no-gpg-sign", tree, ...(head === null ? [] : ["-p", head]), "-m", MESSAGE], { env: IDENTITY, timeoutMs: left(until) }), "git commit-tree").stdout.trim();
}
/** Writes refs in one transaction (`git update-ref --stdin`): every line of it is done, or none. */
async function writeRefs(top: string, lines: readonly string[]): Promise<void> {
  need(await git(top, ["update-ref", "--stdin"], { input: lines.map(line => line + "\n").join(""), timeoutMs: READ_MS }), "git update-ref");
}
function report(problem: string): void { process.stderr.write("HarnessGateway: CHECKPOINT_NOT_KEPT (" + problem.replace(/\s+/gu, " ").slice(0, 300) + ")\n"); }
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The Runtime's WorkspaceCheckpoints (contracts/workspace.ts). */
export class GitCheckpoints implements WorkspaceCheckpoints {
  /** The ref writes of each Turn still going on, by session and ordinal: a later one of the same Turn waits for them. */
  private readonly writing = new Map<string, Promise<void>>();

  capture(workspace: string, sessionId: string, ordinal: number, side: "before" | "after"): Promise<void> {
    const until = Date.now() + CAPTURE_MS, key = sessionId + "/" + ordinal;
    const work = (async () => {
      const where = await located(workspace, until);
      if (where === null) return;
      const { tree, head } = await treeOf(where, until), commit = await commitTree(where.top, tree, head, until);
      // Taken in time: it is named even when the time is up meanwhile, after any write of this Turn's other side. A `before` takes away an `after` left by a Turn
      // that had this place before a branch.
      const earlier = this.writing.get(key) ?? Promise.resolve();
      const write = earlier.then(() => writeRefs(where.top, side === "before"
        ? ["update " + checkpointRef(sessionId, ordinal, "before") + " " + commit, "delete " + checkpointRef(sessionId, ordinal, "after")]
        : ["update " + checkpointRef(sessionId, ordinal, "after") + " " + commit]));
      const settled = write.catch(() => undefined);
      this.writing.set(key, settled);
      void settled.then(() => { if (this.writing.get(key) === settled) this.writing.delete(key); });
      await write;
    })().catch((error: unknown) => report(side + " of Turn " + (ordinal + 1) + ": " + reason(error)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>(done => { timer = setTimeout(done, CAPTURE_MS + 100); timer.unref?.(); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  async forget(workspace: string, sessionId: string): Promise<void> {
    try {
      const where = await located(workspace, Date.now() + READ_MS);
      if (where === null) return;
      const listed = need(await git(where.top, ["for-each-ref", "--format=%(refname)", PREFIX + sessionId], { timeoutMs: READ_MS }), "git for-each-ref");
      const names = listed.stdout.split("\n").filter(name => name.startsWith(PREFIX + sessionId + "/"));
      if (names.length > 0) await writeRefs(where.top, names.map(name => "delete " + name));
    } catch (error) { report("refs of " + sessionId + " not taken away: " + reason(error)); }
  }
}

/**
 * The Turns of a conversation with a checkpoint, the latest first, `limit` of them from below the ordinal `before`; `next` is the next page's `before`, null at the end.
 * Null when the workspace is in no repository.
 */
export async function checkpointList(workspace: string, sessionId: string, page: { readonly before?: number; readonly limit: number }): Promise<{ readonly checkpoints: readonly CheckpointView[]; readonly next: number | null } | null> {
  const where = await located(workspace, Date.now() + READ_MS);
  if (where === null) return null;
  const listed = need(await git(where.top, ["for-each-ref", "--format=%(refname)%00%(objectname)", PREFIX + sessionId], { timeoutMs: READ_MS }), "git for-each-ref");
  const found = new Map<number, { before?: string; after?: string }>();
  for (const line of listed.stdout.split("\n")) {
    const [name = "", sha = ""] = line.split("\0"), place = /^(0|[1-9][0-9]*)\/(before|after)$/u.exec(name.slice((PREFIX + sessionId + "/").length));
    if (!name.startsWith(PREFIX + sessionId + "/") || place === null || !Number.isSafeInteger(Number(place[1]))) continue;
    const ordinal = Number(place[1]), entry = found.get(ordinal) ?? {};
    entry[place[2] as "before" | "after"] = sha; found.set(ordinal, entry);
  }
  const ordinals = [...found.keys()].filter(ordinal => page.before === undefined || ordinal < page.before).sort((a, b) => b - a), shown = ordinals.slice(0, page.limit);
  return { checkpoints: shown.map(ordinal => ({ ordinal, ...found.get(ordinal)! })), next: ordinals.length > shown.length ? shown[shown.length - 1]! : null };
}

/**
 * What a Turn's scope compares (git.ts): its `before` against its `after`, or against a tree of the working tree as it is now when the Turn is running (`live`) or no
 * `after` was kept. Null when it has no `before`; NOT_A_REPOSITORY when the workspace is in no repository.
 */
export async function turnRange(workspace: string, sessionId: string, ordinal: number, live: boolean): Promise<TurnRange | null> {
  const where = await located(workspace, Date.now() + READ_MS);
  if (where === null) throw new SessionError("NOT_A_REPOSITORY", "这个对话的工作区不在 Git 仓库里");
  const before = await commitAt(where.top, checkpointRef(sessionId, ordinal, "before"));
  if (before === null) return null;
  const after = live ? null : await commitAt(where.top, checkpointRef(sessionId, ordinal, "after"));
  if (after !== null) return { before, after, live: false };
  return { before, after: (await treeOf(where, Date.now() + STAGE_MS)).tree, live: true };
}

/**
 * Puts the working tree of the workspace's repository back as it was before the Turn `ordinal`: the files as they are now are kept first, under
 * `refs/harnesshub/checkpoints/<sessionId>/restore-<now>` (nothing is put back when that fails), then `git restore --source=<before> --worktree --staged -- .` and
 * `git clean -fd -- .` at the repository's top (what .gitignore leaves out stays). Null when the Turn has no `before`; NOT_A_REPOSITORY, GIT_RESTORE_FAILED with Git's words.
 */
export async function restoreCheckpoint(workspace: string, sessionId: string, ordinal: number, now: number): Promise<CheckpointRestoreView | null> {
  const where = await located(workspace, Date.now() + READ_MS);
  if (where === null) throw new SessionError("NOT_A_REPOSITORY", "这个对话的工作区不在 Git 仓库里");
  const before = await commitAt(where.top, checkpointRef(sessionId, ordinal, "before"));
  if (before === null) return null;
  const savedAs = PREFIX + sessionId + "/restore-" + now;
  try {
    const until = Date.now() + STAGE_MS, { tree, head } = await treeOf(where, until);
    // A ref of that name that is already there is not overwritten (the empty old value).
    need(await git(where.top, ["update-ref", savedAs, await commitTree(where.top, tree, head, until), ""], { timeoutMs: READ_MS }), "git update-ref");
  } catch (error) { throw new SessionError("GIT_RESTORE_FAILED", "没能先把现在的文件存下来，所以没有还原：" + reason(error)); }
  const write = { timeoutMs: WRITE_MS };
  const restored = await git(where.top, ["restore", "--source=" + before, "--worktree", "--staged", "--", "."], write);
  if (restored.code !== 0 || restored.timedOut) throw new SessionError("GIT_RESTORE_FAILED", (restored.timedOut ? "git restore 没有在时限内完成" : "git restore 没有成功：" + said(restored)) + "（还原前的文件存在 " + savedAs + "）");
  const cleaned = await git(where.top, ["clean", "-fd", "--", "."], write);
  if (cleaned.code !== 0 || cleaned.timedOut) throw new SessionError("GIT_RESTORE_FAILED", (cleaned.timedOut ? "git clean 没有在时限内完成" : "git clean 没有成功：" + said(cleaned)) + "（还原前的文件存在 " + savedAs + "）");
  return { restoredTo: before, savedAs };
}
