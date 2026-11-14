import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { SessionError, type ConversationWorktree } from "../../contracts/session.js";
import { gitSaid, runGit, type GitRan } from "./git.js";
import { missing } from "./place.js";

/*
 * A conversation's own Git worktree (2026-11-14, like T3 Code's "New worktree"): several Harnesses can change one repository at once, each in a checkout of its own.
 * Made from the repository a folder is in, on a new branch `hh/<8 hex>` from that checkout's HEAD, at `<root>/<repository folder>/hh-<8 hex>` (the 8 hex are the first of
 * sha256 of the request that made it, so a repeat finds the same one); the branch is renamed once after the conversation's title; the worktree is removed only when the
 * user erases the conversation and asks for it. Every Git runs as git.ts runs it: no shell, no terminal, nothing on stdin (GIT_TERMINAL_PROMPT=0, so neither Git nor ssh
 * asks for a password), the reads without Git's optional locks, within a time; what Git says when it refuses is what the user is told.
 */

const READ = { read: true, timeoutMs: 15_000 } as const;
/** A checkout of a large repository and its post-checkout hook, a removal of a large worktree: given minutes. */
const WRITE = { read: false, timeoutMs: 10 * 60_000 } as const;
/** Submodules may be fetched over the network. */
const SUBMODULES = { read: false, timeoutMs: 30 * 60_000 } as const;
/** Counting what is not committed in a large worktree. */
const STATUS = { read: true, timeoutMs: 60_000 } as const;

/** The 8 hex digits of the request that made a worktree: its folder `hh-<key>` and its temporary branch `hh/<key>`. */
export function worktreeKey(commandId: string): string { return createHash("sha256").update(commandId, "utf8").digest("hex").slice(0, 8); }
/** The temporary branch of a worktree made here, by its folder (`hh-<8 hex>` → `hh/<8 hex>`); null for a folder not so named. */
export function temporaryBranchOf(worktree: Pick<ConversationWorktree, "path">): string | null {
  const found = /^hh-([0-9a-f]{8})$/u.exec(basename(worktree.path));
  return found === null ? null : "hh/" + found[1]!;
}
/**
 * The part of a title a branch is named by (`hh/<slug>`): letters, marks and digits of any script kept (Chinese stays Chinese), every other run made one `-`, no `-` at
 * either end, ASCII letters lowercased, at most 48 UTF-16 units (never half a character). Empty when the title has no letter or digit.
 */
export function branchSlug(title: string): string {
  const dashed = title.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/[A-Z]/gu, letter => letter.toLowerCase());
  let cut = dashed.slice(0, 48);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.replace(/-+$/u, "");
}

const output = (ran: GitRan): string => ran.stdout.toString("utf8");
const failed = (what: string, ran: GitRan): SessionError =>
  new SessionError("GIT_WORKTREE_FAILED", ran.timedOut ? what + " 没有在时限内完成，已停下" : what + " 没有成功：" + (gitSaid(ran) || "退出码 " + String(ran.code)));
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function real(path: string): Promise<string | null> {
  try { return await realpath(path); } catch (error) { if (missing(error)) return null; throw error; }
}

/** One entry of `git worktree list --porcelain -z`: the main checkout first (or the bare repository), then every linked worktree. */
interface Listed { readonly path: string; readonly head: string | null; readonly branch: string | null; readonly bare: boolean }
async function listed(cwd: string): Promise<Listed[]> {
  const ran = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"], READ);
  if (ran.code !== 0) throw failed("git worktree list", ran);
  const entries: Listed[] = [];
  let path: string | null = null, head: string | null = null, branch: string | null = null, bare = false;
  // Each field ends in a NUL, and an entry in one more.
  for (const field of [...output(ran).split("\0"), ""]) {
    if (field === "") { if (path !== null) entries.push({ path, head, branch, bare }); path = null; head = null; branch = null; bare = false; continue; }
    if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
    else if (field.startsWith("HEAD ")) head = field.slice("HEAD ".length);
    else if (field.startsWith("branch ")) branch = field.slice("branch ".length);
    else if (field === "bare") bare = true;
  }
  return entries;
}

/** The repository a folder is in: the folder's real path, its checkout's top level and the folder's place there (`sub/dir/`, "" at the top), and the main checkout. */
interface Source { readonly folder: string; readonly top: string; readonly prefix: string; readonly root: string }
async function sourceOf(workspace: string): Promise<Source> {
  const folder = await real(workspace);
  if (folder === null) throw new SessionError("INVALID_INPUT", "这个文件夹不在了");
  const ran = await runGit(folder, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix"], READ);
  const [inside = "", top = "", prefix = ""] = output(ran).split("\n");
  if (ran.code !== 0 || inside !== "true" || top === "") throw new SessionError("INVALID_INPUT", "这个文件夹不在 Git 仓库里，不能给对话开新的工作树");
  const main = (await listed(folder))[0];
  return { folder, top: await real(top) ?? top, prefix, root: main === undefined ? await real(top) ?? top : await real(main.path) ?? main.path };
}

/** A worktree made (or found again) for a conversation: its record, the conversation's workspace in it, and whether it was made by this call. */
export interface MadeWorktree { readonly worktree: ConversationWorktree; readonly workspace: string; readonly created: boolean }

/**
 * The worktree of the request `commandId` for a conversation in `workspace`, under `under`: `git worktree add -b hh/<key> <under>/<repository folder>/hh-<key> <HEAD>`
 * from the checkout `workspace` is in (`git submodule update --init --recursive` in it when it has `.gitmodules`; a failure of that is only reported). A worktree of this
 * repository already at that place on that branch is taken as it is (a repeat of the request); a branch `hh/<key>` left by an earlier one is checked out again. The
 * conversation's workspace is `workspace`'s place in the worktree (made when the checkout has no such folder). INVALID_INPUT when `workspace` is in no repository;
 * GIT_NO_COMMITS before its first commit; GIT_WORKTREE_PATH_TAKEN when something else is at the place; GIT_WORKTREE_FAILED with Git's words when Git refuses.
 */
export async function createWorktree(workspace: string, under: string, commandId: string, report: (line: string) => void = () => undefined): Promise<MadeWorktree> {
  const source = await sourceOf(workspace), key = worktreeKey(commandId), branch = "hh/" + key;
  // The folder is made only once Git is about to add the worktree: a request refused before leaves nothing behind.
  const parent = join(under, basename(source.root).replace(/\.git$/u, "") || "repository"), path = join(await real(parent) ?? parent, "hh-" + key);
  for (const entry of await listed(source.folder)) {
    if (await real(entry.path) !== path) continue;
    if (entry.branch !== "refs/heads/" + branch || entry.head === null) throw new SessionError("GIT_WORKTREE_PATH_TAKEN", "要开工作树的位置已经是这个仓库另一个分支的工作树：" + path);
    return finish(source, { root: source.root, path, branch, baseSha: entry.head }, false, report);
  }
  if (await exists(path)) throw new SessionError("GIT_WORKTREE_PATH_TAKEN", "要开工作树的位置已经有别的东西：" + path);
  const head = await runGit(source.top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], READ), sha = output(head).trim();
  if (head.code !== 0 || sha === "") throw new SessionError("GIT_NO_COMMITS", "这个仓库还没有提交，没法从它开新的工作树");
  const left = await runGit(source.top, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch + "^{commit}"], READ), tip = output(left).trim();
  await mkdir(parent, { recursive: true });
  const target = join(await realpath(parent), "hh-" + key);
  const added = await runGit(source.top, left.code === 0 && tip !== "" ? ["worktree", "add", target, branch] : ["worktree", "add", "-b", branch, target, sha], WRITE);
  if (added.code !== 0) throw failed("git worktree add", added);
  return finish(source, { root: source.root, path: await realpath(target), branch, baseSha: left.code === 0 && tip !== "" ? tip : sha }, true, report);
}
async function finish(source: Source, worktree: ConversationWorktree, created: boolean, report: (line: string) => void): Promise<MadeWorktree> {
  if (await exists(join(worktree.path, ".gitmodules"))) {
    // Git's words may name a remote with what it was given to reach it: only how it ended is reported.
    const ran = await runGit(worktree.path, ["submodule", "update", "--init", "--recursive"], SUBMODULES);
    if (ran.code !== 0) report("git submodule update --init --recursive in a new worktree " + (ran.timedOut ? "ran out of time" : "ended with " + String(ran.code)) + "; the worktree is used without them");
  }
  const folder = source.prefix === "" ? worktree.path : join(worktree.path, source.prefix);
  await mkdir(folder, { recursive: true });
  return { worktree, workspace: await realpath(folder), created };
}

/**
 * Takes back a worktree `createWorktree` just made for a conversation that then was not made: removed, and its branch deleted while it is still at the commit it started
 * from (nothing was committed on it). Best effort: what Git refuses is left as it is.
 */
export async function discardWorktree(worktree: ConversationWorktree): Promise<void> {
  const removed = await runGit(worktree.root, ["worktree", "remove", "--force", worktree.path], WRITE);
  if (removed.code !== 0) return;
  const tip = await runGit(worktree.root, ["rev-parse", "--verify", "--quiet", "refs/heads/" + worktree.branch], READ);
  if (tip.code === 0 && output(tip).trim() === worktree.baseSha) await runGit(worktree.root, ["branch", "-D", worktree.branch], WRITE);
}

/** What `nameWorktreeBranch` did: the branch the worktree is on now (renamed, or found on another), or why it kept the temporary name. */
export type NamedBranch = { readonly branch: string } | { readonly kept: string };
/**
 * Renames the worktree's temporary branch after the conversation's title, once: `hh/<slug>` (`branchSlug`), `-2`, `-3`… when that is taken, with `git branch -m` in
 * the worktree; only while the branch still has its temporary name and no upstream, and only to a name `git check-ref-format --branch` takes. A worktree found on
 * another branch answers that branch (someone renamed or switched it). Anything else keeps the temporary name and says why.
 */
export async function nameWorktreeBranch(worktree: ConversationWorktree, title: string): Promise<NamedBranch> {
  const temporary = temporaryBranchOf(worktree);
  if (temporary === null || worktree.branch !== temporary) return { kept: "its branch is not the temporary one" };
  if (!await exists(worktree.path)) return { kept: "the worktree is not there" };
  const head = await runGit(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], READ), current = output(head).trim();
  if (head.code !== 0 || current === "") return { kept: "the worktree is on a detached head" };
  if (current !== temporary) return { branch: current };
  if ((await runGit(worktree.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], READ)).code === 0) return { kept: "its branch has an upstream" };
  const slug = branchSlug(title);
  if (slug === "") return { kept: "the title has no letter or digit" };
  for (let n = 1; ; n++) {
    const name = "hh/" + slug + (n === 1 ? "" : "-" + String(n));
    if ((await runGit(worktree.path, ["check-ref-format", "--branch", name], READ)).code !== 0) return { kept: "Git takes no branch named " + name };
    const taken = async () => (await runGit(worktree.path, ["rev-parse", "--verify", "--quiet", "refs/heads/" + name], READ)).code === 0;
    if (await taken()) continue;
    const moved = await runGit(worktree.path, ["branch", "-m", temporary, name], WRITE);
    if (moved.code === 0) return { branch: name };
    // Another Git took the name meanwhile: the next one.
    if (await taken()) continue;
    return { kept: "git branch -m did not succeed: " + (gitSaid(moved) || "exit " + String(moved.code)) };
  }
}

/** Where a worktree stands: the branch checked out there (null on a detached head), how many files are not committed (untracked ones one by one), and whether it is gone. */
export interface WorktreeState { readonly branch: string | null; readonly dirty: number; readonly missing: boolean }
/** Read-only (no optional locks). A worktree whose folder is gone is `missing`, with its recorded branch; GIT_FAILED with Git's words when Git does not answer. */
export async function worktreeState(worktree: ConversationWorktree): Promise<WorktreeState> {
  if (!await exists(worktree.path)) return { branch: worktree.branch, dirty: 0, missing: true };
  const ran = await runGit(worktree.path, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], STATUS);
  if (ran.code !== 0) throw new SessionError("GIT_FAILED", ran.timedOut ? "git status 没有在时限内完成，已停下" : "git status 没有答出来：" + (gitSaid(ran) || "退出码 " + String(ran.code)));
  let branch: string | null = null, dirty = 0;
  const fields = output(ran).split("\0");
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field === "") continue;
    if (field.startsWith("# ")) { if (field.startsWith("# branch.head ")) { const name = field.slice("# branch.head ".length); branch = name === "(detached)" ? null : name; } continue; }
    // `1` changed, `2` renamed or copied (the path it came from is the next field), `u` unmerged, `?` untracked; `!` ignored is not counted.
    if (field[0] === "2") index++;
    if (field[0] === "1" || field[0] === "2" || field[0] === "u" || field[0] === "?") dirty++;
  }
  return { branch, dirty, missing: false };
}

/** What `removeWorktree` did: the worktree is no longer there, or why it was left. */
export type RemovedWorktree = { readonly removed: true } | { readonly failed: string };
/**
 * Removes a conversation's worktree, uncommitted and untracked files with it (`git worktree remove --force <path>` from the main checkout), then `git worktree prune`.
 * The branch stays, so its commits stay reachable. Only a linked worktree of that repository is removed (never its main checkout or a folder Git does not list); one
 * whose folder is already gone is pruned. A worktree whose repository is gone, or that Git will not remove (a locked one), is left and Git's words said.
 */
export async function removeWorktree(worktree: ConversationWorktree): Promise<RemovedWorktree> {
  if (!await exists(worktree.root)) return { failed: "这个工作树所属的仓库已不在：" + worktree.root };
  if (await exists(worktree.path)) {
    const path = await real(worktree.path), entries = await listed(worktree.root);
    let linked = false;
    for (const entry of entries.slice(1)) if (await real(entry.path) === path) linked = true;
    if (!linked) return { failed: "这个文件夹不是这个仓库的工作树，没有删除：" + worktree.path };
    const removed = await runGit(worktree.root, ["worktree", "remove", "--force", worktree.path], WRITE);
    if (removed.code !== 0) return { failed: removed.timedOut ? "git worktree remove 没有在时限内完成，已停下" : gitSaid(removed) || "git worktree remove 没有成功" };
  }
  await runGit(worktree.root, ["worktree", "prune"], WRITE);
  return { removed: true };
}
