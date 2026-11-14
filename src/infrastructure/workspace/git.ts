import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionError } from "../../contracts/session.js";
import type { GitBranchesView, GitChangedFileView, GitChangeStatus, GitChangesView, GitCommitEntryView, GitCommitView, GitFileView, GitLogView, GitPushView, GitScope, GitView } from "../../contracts/web.js";
import { workspacePath, workspaceRoot } from "./place.js";

/*
 * Git in a conversation's workspace, for the page's details panel (2026-11-14): what is changed (a file at a time, with its lines), and the commit and the push the user
 * asks for with a button. The Gateway never commits or pushes by itself. Every Git runs without a shell (argument lists), without a terminal (its own session, so neither
 * Git nor ssh can ask for a password: GIT_TERMINAL_PROMPT=0 and no controlling terminal), with nothing on its stdin, and within a time; the reads without Git's optional
 * locks (GIT_OPTIONAL_LOCKS=0, so a read never takes the index lock a Harness's own Git may want). What Git says when it refuses is what the user is told.
 */

interface Ran { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string; readonly timedOut: boolean }
/** How long a read is given, and a commit (its hooks may lint or test) and a push. */
const READ_MS = 15_000, COMMIT_MS = 5 * 60_000, PUSH_MS = 60_000;

/** Runs `git <args>` in `cwd`: its output whole, its exit code, whether it ran out of time (its whole process group is then killed, ssh included). */
function git(cwd: string, args: readonly string[], options: { readonly read: boolean; readonly timeoutMs: number }): Promise<Ran> {
  return new Promise((done, fail) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(options.read ? { GIT_OPTIONAL_LOCKS: "0" } : {}) };
    let child: ReturnType<typeof spawn>;
    try { child = spawn("git", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (error) { fail(error); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let timedOut = false, finished = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, options.timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", error => { if (finished) return; finished = true; clearTimeout(timer); fail(error); });
    child.on("close", code => { if (finished) return; finished = true; clearTimeout(timer); done({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), timedOut }); });
  });
}
/** What Git said, both streams, cut in the middle when long so that its first words and its last (where a hook or a remote says why) both stay. */
function said(ran: Ran): string {
  const text = [ran.stderr.trim(), ran.stdout.toString("utf8").trim()].filter(part => part !== "").join("\n");
  return text.length <= 480 ? text : text.slice(0, 180) + " … " + text.slice(-290);
}
/** A Git that is not there at all is told so, not as a failure of the workspace. */
function gitMissing(error: unknown): never {
  if ((error as { readonly code?: unknown } | null)?.code === "ENOENT") throw new SessionError("GIT_UNAVAILABLE", "这台 Mac 上找不到 git");
  throw error;
}
async function run(cwd: string, args: readonly string[], options: { readonly read: boolean; readonly timeoutMs: number }): Promise<Ran> {
  try { return await git(cwd, args, options); } catch (error) { return gitMissing(error); }
}
/**
 * The workspace's real path, and where it is in its repository (`prefix`: "" at the repository's top, else its folder there with a slash at the end); refused as
 * NOT_A_REPOSITORY when it is in no Git repository. A workspace below the top sees and commits only what is in it (the pathspec `.`), and names its files from itself.
 */
async function repository(workspace: string): Promise<{ readonly root: string; readonly prefix: string }> {
  const root = await workspaceRoot(workspace), ran = await run(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], { read: true, timeoutMs: READ_MS });
  const [inside = "", prefix = ""] = ran.stdout.toString("utf8").split("\n");
  if (ran.code !== 0 || inside.trim() !== "true") throw new SessionError("NOT_A_REPOSITORY", "这个对话的工作区不在 Git 仓库里");
  return { root, prefix: prefix.trim() };
}
/** A path Git gives from the repository's top, named from the workspace instead (a path outside a workspace below the top starts with `../`). */
const fromWorkspace = (prefix: string, path: string): string => prefix === "" ? path : posix.relative(prefix.replace(/\/$/u, ""), path);
/** The lines of each file of `git diff --numstat -z`, by the path it has now; null for a binary file (`-` and `-`). */
function numstatOf(output: Buffer): Map<string, { readonly added: number; readonly removed: number } | null> {
  const lines = new Map<string, { readonly added: number; readonly removed: number } | null>(), parts = output.toString("utf8").split("\0");
  for (let index = 0; index < parts.length; index++) {
    const found = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(parts[index]!);
    if (found === null) continue;
    // A rename's line is followed by the path it came from and the path it went to.
    let path = found[3]!;
    if (path === "") { index += 2; path = parts[index] ?? ""; }
    lines.set(path, found[1] === "-" || found[2] === "-" ? null : { added: Number(found[1]), removed: Number(found[2]) });
  }
  return lines;
}

/**
 * Where the workspace stands in Git: the branch (null on a detached head), its upstream with how far ahead and behind, whether the repository has any remote, and every
 * changed, staged or untracked file (untracked ones one by one), each with its index and worktree state as `git status --porcelain=v2` gives them ("." unchanged, "?"
 * untracked) and its lines added and removed against HEAD (`git diff --numstat HEAD`; none for an untracked or a binary file). NOT_A_REPOSITORY when it is in none.
 */
export async function gitDetail(workspace: string): Promise<GitView> {
  const { root, prefix } = await repository(workspace), read = { read: true, timeoutMs: READ_MS }, here = prefix === "" ? [] : ["--", "."];
  const [status, remotes] = await Promise.all([run(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z", ...here], read), run(root, ["remote"], read)]);
  if (status.code !== 0) throw new SessionError("GIT_FAILED", "git status 没有答出来：" + said(status));
  let branch: string | null = null, initial = false, upstream: string | null = null, ahead = 0, behind = 0;
  const files: GitFileView[] = [], fields = status.stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index]!;
    if (line === "") continue;
    if (line.startsWith("# ")) {
      const [key, ...value] = line.slice(2).split(" "), rest = value.join(" ");
      if (key === "branch.head") branch = rest === "(detached)" ? null : rest;
      else if (key === "branch.oid") initial = rest === "(initial)";
      else if (key === "branch.upstream") upstream = rest;
      else if (key === "branch.ab") { const found = /^\+(\d+) -(\d+)$/u.exec(rest); if (found !== null) { ahead = Number(found[1]); behind = Number(found[2]); } }
      continue;
    }
    const kind = line[0];
    if (kind === "?") { files.push({ path: fromWorkspace(prefix, line.slice(2)), index: "?", worktree: "?" }); continue; }
    if (kind === "!") continue;
    // `1 XY sub mH mI mW hH hI path`, `2 XY sub mH mI mW hH hI Xscore path` and then the path it came from, `u XY sub m1 m2 m3 mW h1 h2 h3 path`.
    const parts = line.split(" "), xy = parts[1] ?? "..", skip = kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : -1;
    if (skip < 0) continue;
    const path = parts.slice(skip).join(" ");
    const from = kind === "2" ? fields[++index] : undefined;
    files.push({ path: fromWorkspace(prefix, path), ...(from === undefined || from === "" ? {} : { from: fromWorkspace(prefix, from) }), index: xy[0] ?? ".", worktree: xy[1] ?? "." });
  }
  // The lines of each tracked change against HEAD (against the empty tree before the first commit).
  const base = initial ? (await run(root, ["hash-object", "-t", "tree", "/dev/null"], read)).stdout.toString("utf8").trim() : "HEAD";
  const lines = new Map<string, { readonly added: number; readonly removed: number }>();
  if (base !== "" && files.some(file => file.index !== "?")) {
    const numstat = await run(root, ["diff", "--numstat", "-z", base, "--", ...(prefix === "" ? [] : ["."])], read);
    if (numstat.code === 0) for (const [path, counted] of numstatOf(numstat.stdout)) if (counted !== null) lines.set(fromWorkspace(prefix, path), counted);
  }
  const names = remotes.code === 0 ? remotes.stdout.toString("utf8").split("\n").map(name => name.trim()).filter(name => name !== "") : [];
  return { branch, ...(upstream === null ? {} : { upstream: { name: upstream, ahead, behind } }), remote: names.length > 0,
    files: files.map(file => { const counted = lines.get(file.path); return counted === undefined ? file : { ...file, ...counted }; }) };
}

/**
 * Commits in the workspace with the user's `message`: given `paths` (relative to the workspace or absolute, each in it; a file deleted in the working tree may be named),
 * those are staged and only those committed (`git add` and `git commit -- <paths>`, whatever else was staged stays staged); without, everything (`git add -A`). Returns
 * the new commit's short hash and subject. Nothing to commit, a hook that refused, no identity and every other refusal of Git: GIT_NOTHING_TO_COMMIT or
 * GIT_COMMIT_FAILED with what Git said. An empty message is refused before Git is asked.
 */
export async function gitCommit(workspace: string, message: string, paths?: readonly string[]): Promise<GitCommitView> {
  if (typeof message !== "string" || message.trim() === "") throw new SessionError("INVALID_INPUT", "提交说明不能为空");
  if (paths !== undefined && (!Array.isArray(paths) || paths.length === 0 || paths.some(path => typeof path !== "string" || path === "" || path.includes("\0"))))
    throw new SessionError("INVALID_INPUT", "paths 是工作区里的一个或几个文件；要提交全部改动就不给 paths");
  const { root, prefix } = await repository(workspace);
  // Everything is everything in the workspace: below the repository's top, its own folder (`.`, from the workspace, as Git takes a pathspec).
  const named = paths === undefined ? (prefix === "" ? null : ["."]) : [...new Set(await Promise.all(paths.map(path => workspacePath(root, workspace, path, "只能提交这个对话工作区里的文件"))))];
  const write = { read: false, timeoutMs: COMMIT_MS };
  // Literal pathspecs: a file named `*.ts` is that file, not a pattern.
  const staged = await run(root, named === null ? ["add", "-A"] : ["--literal-pathspecs", "add", "-A", "--", ...named], write);
  if (staged.code !== 0) throw new SessionError("GIT_COMMIT_FAILED", staged.timedOut ? "git add 没有在时限内完成" : "git add 没有成功：" + said(staged));
  const committed = await run(root, named === null ? ["commit", "-m", message] : ["--literal-pathspecs", "commit", "-m", message, "--", ...named], write);
  if (committed.code !== 0) {
    if (committed.timedOut) throw new SessionError("GIT_COMMIT_FAILED", "git commit 五分钟没有完成（可能是提交钩子），已停下：" + said(committed));
    // Whether anything was staged for it says what the refusal was, whatever language Git speaks.
    const empty = await run(root, named === null ? ["diff", "--cached", "--quiet"] : ["--literal-pathspecs", "diff", "--cached", "--quiet", "--", ...named], { read: true, timeoutMs: READ_MS });
    throw new SessionError(empty.code === 0 ? "GIT_NOTHING_TO_COMMIT" : "GIT_COMMIT_FAILED", said(committed) || "git commit 没有成功");
  }
  const made = await run(root, ["log", "-1", "--format=%h%x00%s", "HEAD"], { read: true, timeoutMs: READ_MS });
  const [commit = "", subject = ""] = made.stdout.toString("utf8").trim().split("\0");
  return { commit, subject };
}

/**
 * Pushes the current branch: to its upstream when it has one (`git push`), else to the remote named origin, setting it as the upstream (`git push -u origin <branch>`).
 * Within a minute, and never asking for a password (one that is needed fails it). Refused on a detached head (GIT_DETACHED_HEAD) and without an upstream or an origin
 * (GIT_NO_REMOTE); a push Git refuses or that runs out of time is GIT_PUSH_FAILED with what Git said.
 */
export async function gitPush(workspace: string): Promise<GitPushView> {
  const { root } = await repository(workspace), read = { read: true, timeoutMs: READ_MS };
  const head = await run(root, ["symbolic-ref", "--short", "-q", "HEAD"], read), branch = head.stdout.toString("utf8").trim();
  if (head.code !== 0 || branch === "") throw new SessionError("GIT_DETACHED_HEAD", "现在不在任何分支上（分离头指针），先切到一个分支再推送");
  const [tracked, remotes] = await Promise.all([run(root, ["config", "--get", "branch." + branch + ".remote"], read), run(root, ["remote"], read)]);
  const remote = tracked.code === 0 ? tracked.stdout.toString("utf8").trim() : "", names = remotes.stdout.toString("utf8").split("\n").map(name => name.trim());
  const upstream = remote !== "" && (await run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], read)).code === 0;
  let args: readonly string[], to: string;
  if (upstream) { args = ["push"]; to = remote; }
  else if (names.includes("origin")) { args = ["push", "-u", "origin", branch]; to = "origin"; }
  else throw new SessionError("GIT_NO_REMOTE", "这个分支没有上游，仓库里也没有叫 origin 的远端，不知道推到哪里");
  const pushed = await run(root, args, { read: false, timeoutMs: PUSH_MS });
  if (pushed.code !== 0) throw new SessionError("GIT_PUSH_FAILED", pushed.timedOut ? "git push 一分钟没有完成，已停下：" + said(pushed) : said(pushed) || "git push 没有成功");
  return { remote: to, branch };
}

/*
 * What changed in a scope, a file at a time, for the page's changes panel as T3 Code has it (2026-11-14): what is not committed (the working tree against HEAD), one
 * commit (against its first parent), or the branch (the working tree against where it left a base branch: the merge base). Every one of these only reads: no index is
 * refreshed (GIT_OPTIONAL_LOCKS=0), no object written. A workspace below the repository's top sees only what is in it, named from itself (`--relative`; Git runs in the
 * workspace). The user's configuration of Git applies except where it would change what the page reads: no colour, no external diff, no text conversion, the sides of a
 * patch named a/ and b/, paths as they are.
 */

/** How long a listing of changes and a page of the log are given (finding renames over a long branch takes a while), and a diff while it is streamed. */
const LIST_MS = 60_000, DIFF_MS = 5 * 60_000;
const READ = { read: true, timeoutMs: READ_MS }, LIST = { read: true, timeoutMs: LIST_MS };
/** What every listing and diff of a scope is given: nothing the user's configuration would add to the output, renames found, paths from the workspace and only in it. */
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--relative", "-M"] as const;
/** A patch's sides are a/ and b/ whatever `diff.noprefix` or `diff.mnemonicPrefix` say; its paths are not quoted in octal. */
const PATCH = ["--src-prefix=a/", "--dst-prefix=b/"] as const, VERBATIM = ["-c", "core.quotePath=false"] as const;

/** A Git that refused, as a conflict with where the repository stands, in its own words. */
const failed = (what: string, ran: Ran): SessionError => new SessionError("GIT_FAILED", ran.timedOut ? what + " 没有在时限内完成，已停下" : what + " 没有答出来：" + (said(ran) || "退出码 " + String(ran.code)));
/** A revision the page names (a commit's hash, a branch): refused before Git is asked when it could be taken for an option or holds a control character. */
function revisionText(value: string, what: string): string {
  if (value === ""|| value.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(value)) throw new SessionError("INVALID_INPUT", what);
  return value;
}
/** The full hash of the commit `revision` names in this repository; INVALID_INPUT when it names none. */
async function commitOf(root: string, revision: string, what: string): Promise<string> {
  const ran = await run(root, ["rev-parse", "--verify", "--quiet", revisionText(revision, what) + "^{commit}"], READ), sha = ran.stdout.toString("utf8").trim();
  if (ran.code !== 0 || !/^[0-9a-f]{40,64}$/u.test(sha)) throw new SessionError("INVALID_INPUT", what);
  return sha;
}
/** HEAD's commit; null before the first commit. */
async function headOf(root: string): Promise<string | null> {
  const ran = await run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], READ);
  return ran.code === 0 ? ran.stdout.toString("utf8").trim() : null;
}
/** The tree with nothing in it, by its hash in this repository's object format (`hash-object` without `-w` writes nothing). */
async function emptyTree(root: string): Promise<string> {
  const ran = await run(root, ["hash-object", "-t", "tree", "/dev/null"], READ);
  if (ran.code !== 0) throw failed("git hash-object", ran);
  return ran.stdout.toString("utf8").trim();
}
const isCommit = async (root: string, ref: string): Promise<boolean> => (await run(root, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], READ)).code === 0;
/** The branch a branch is taken to come from when none is named: the one origin/HEAD points to (as `origin/<name>`), else `main`, else `master`; null when none is there. */
async function defaultBranch(root: string): Promise<string | null> {
  const origin = await run(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], READ), target = origin.stdout.toString("utf8").trim();
  if (origin.code === 0 && target.startsWith("refs/remotes/") && await isCommit(root, target)) return target.slice("refs/remotes/".length);
  for (const name of ["main", "master"]) if (await isCommit(root, "refs/heads/" + name)) return name;
  return null;
}

/** What a scope compares: the revisions `git diff` is given (one: the working tree against it; two: a commit against its parent), and whether untracked files count. */
interface Compared {
  readonly range: readonly string[];
  readonly worktree: boolean;
  readonly base?: { readonly ref: string; readonly sha: string };
  readonly commit?: { readonly sha: string; readonly parent: string | null };
}
async function compared(root: string, scope: GitScope): Promise<Compared> {
  // Not committed: the working tree (staged and not alike) against HEAD, against the empty tree before the first commit.
  if (scope.kind === "uncommitted") return { range: [await headOf(root) ?? await emptyTree(root)], worktree: true };
  // One commit against its first parent; a root commit against the empty tree.
  if (scope.kind === "commit") {
    const sha = await commitOf(root, scope.sha, "sha 不是这个仓库里的提交"), parents = await run(root, ["rev-list", "--parents", "-n", "1", sha], READ);
    if (parents.code !== 0) throw failed("git rev-list", parents);
    const parent = parents.stdout.toString("utf8").trim().split(" ")[1] ?? null;
    return { range: [parent ?? await emptyTree(root), sha], worktree: false, commit: { sha, parent } };
  }
  // The branch: the working tree as it is (not committed and untracked included) against where HEAD's history left the base's, merge-base(base, HEAD).
  const ref = scope.base ?? await defaultBranch(root);
  if (ref === null) throw new SessionError("INVALID_INPUT", "找不到默认分支（origin/HEAD 指向的、main、master 都没有），请指明和哪个分支比");
  const tip = await commitOf(root, ref, "base 不是这个仓库里的分支或提交"), head = await headOf(root);
  if (head === null) throw new SessionError("GIT_NO_COMMITS", "当前分支还没有提交，没法和别的分支比");
  const merged = await run(root, ["merge-base", tip, head], READ), sha = merged.stdout.toString("utf8").trim();
  if (merged.code === 1 && sha === "") throw new SessionError("GIT_NO_MERGE_BASE", "当前分支和 " + ref + " 没有共同的祖先");
  if (merged.code !== 0 || sha === "") throw failed("git merge-base", merged);
  return { range: [sha], worktree: true, base: { ref, sha } };
}

/** How `git diff --raw` says a file changed. U (unmerged) and X are told as modified. */
const STATUS: Readonly<Record<string, GitChangeStatus>> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "modified", X: "modified" };
interface Changed { readonly path: string; readonly oldPath?: string; readonly status: GitChangeStatus }
/** The files of `git diff --raw -z`: `:<modes> <hashes> <status>` and the path, or for a rename or copy the path it came from and the one it went to. */
function rawOf(output: Buffer): Changed[] {
  const fields = output.toString("utf8").split("\0"), found = new Map<string, Changed>();
  for (let index = 0; index < fields.length; index++) {
    const meta = fields[index]!;
    if (!meta.startsWith(":")) continue;
    const letter = meta.split(" ")[4]?.[0] ?? "M", status = STATUS[letter] ?? "modified";
    const first = fields[++index] ?? "", second = letter === "R" || letter === "C" ? fields[++index] ?? "" : undefined;
    const change: Changed = second === undefined ? { path: first, status } : { path: second, oldPath: first, status };
    // An unmerged path comes twice, as unmerged and as it compares; the comparison is kept.
    if (!found.has(change.path) || letter !== "U") found.set(change.path, change);
  }
  return [...found.values()];
}
/** Untracked files under the workspace, from it, one by one (not ignored ones); a nested repository is one entry ending in `/`. */
async function untrackedOf(root: string, path?: string): Promise<string[]> {
  const ran = await run(root, path === undefined ? ["ls-files", "--others", "--exclude-standard", "-z"] : ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", path], LIST);
  if (ran.code !== 0) throw failed("git ls-files", ran);
  return ran.stdout.toString("utf8").split("\0").filter(entry => entry !== "");
}
/**
 * An untracked file's lines as Git counts a file against nothing: all added, its newlines and one more for a last line without one. Binary, as Git decides it, when a NUL
 * is in its first 8000 bytes. A link is its target (one line). Neither for a folder (a nested repository) or anything else that is not a file.
 */
async function newFileLines(path: string): Promise<{ readonly added: number; readonly removed: 0 } | { readonly binary: true } | null> {
  const info = await lstat(path).catch(() => null);
  if (info === null) return null;
  if (info.isSymbolicLink()) { const target = await readlink(path).catch(() => ""); return { added: target === "" ? 0 : 1, removed: 0 }; }
  if (!info.isFile()) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let newlines = 0, read = 0, last = -1;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (read < 8000 && chunk.subarray(0, 8000 - read).includes(0)) return { binary: true };
      for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, at + 1)) newlines++;
      read += bytesRead; last = chunk[bytesRead - 1]!;
    }
    return { added: newlines + (read > 0 && last !== 10 ? 1 : 0), removed: 0 };
  } finally { await handle.close(); }
}

/**
 * The files changed in `scope`, without their text: each with how it changed, the path it was renamed or copied from, and its lines added and removed (none for a binary
 * file, which is marked so). Untracked files (not committed and branch) come one by one as `untracked`, every line of them added. `ignoreWhitespace` counts the lines as
 * `git diff -w` does (a file whose changes are all whitespace stays listed, with 0 and 0). The list is in the order of the paths. NOT_A_REPOSITORY when the workspace is in
 * no repository; INVALID_INPUT for a sha or base that is not a commit here, or no base and no default branch; GIT_* (409) when Git refuses.
 */
export async function gitChanges(workspace: string, scope: GitScope, options: { readonly ignoreWhitespace?: boolean } = {}): Promise<GitChangesView> {
  const { root } = await repository(workspace), against = await compared(root, scope);
  const [raw, numstat, untracked] = await Promise.all([
    run(root, ["diff", "--raw", "-z", ...DIFF, ...against.range, "--"], LIST),
    run(root, ["diff", "--numstat", "-z", ...DIFF, ...(options.ignoreWhitespace === true ? ["-w"] : []), ...against.range, "--"], LIST),
    against.worktree ? untrackedOf(root) : Promise.resolve([])]);
  if (raw.code !== 0) throw failed("git diff", raw);
  if (numstat.code !== 0) throw failed("git diff --numstat", numstat);
  const lines = numstatOf(numstat.stdout), files: GitChangedFileView[] = [];
  for (const change of rawOf(raw.stdout)) {
    const counted = lines.get(change.path);
    // `-w` leaves out a file whose changes are all whitespace: no line of it counts.
    files.push(counted === null ? { ...change, binary: true } : counted !== undefined ? { ...change, ...counted } : options.ignoreWhitespace === true ? { ...change, added: 0, removed: 0 } : change);
  }
  for (let at = 0; at < untracked.length; at += 16) {
    const batch = untracked.slice(at, at + 16), counted = await Promise.all(batch.map(path => newFileLines(join(root, path))));
    batch.forEach((path, index) => { const lines = counted[index]; files.push({ path, status: "untracked", ...(lines ?? {}) }); });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { scope: scope.kind, files, ...(against.base === undefined ? {} : { base: against.base }), ...(against.commit === undefined ? {} : { commit: against.commit }) };
}

/** A streamed Git: its output a chunk at a time as it is read (Git waits while it is not), how it ended, and a stop that kills it with its process group. */
interface Streamed { readonly chunks: AsyncIterator<Buffer>; readonly ended: Promise<{ readonly code: number | null; readonly stderr: string; readonly timedOut: boolean }>; stop(): void }
async function streamGit(cwd: string, args: readonly string[], options: { readonly read: boolean; readonly timeoutMs: number }): Promise<Streamed> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(options.read ? { GIT_OPTIONAL_LOCKS: "0" } : {}) };
  const child = spawn("git", [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let exited = false, timedOut = false;
  const stop = (): void => {
    if (!exited) { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    child.stdout!.destroy();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  const errors: Buffer[] = [];
  let errorBytes = 0;
  child.stderr!.on("data", (chunk: Buffer) => { if (errorBytes < 64 * 1024) { errors.push(chunk); errorBytes += chunk.length; } });
  child.on("exit", () => { exited = true; });
  const ended = new Promise<{ readonly code: number | null; readonly stderr: string; readonly timedOut: boolean }>((done, fail) => {
    child.on("error", error => { exited = true; clearTimeout(timer); fail(error); });
    child.on("close", code => { exited = true; clearTimeout(timer); done({ code, stderr: Buffer.concat(errors).toString("utf8"), timedOut }); });
  });
  ended.catch(() => undefined);
  // A Git that is not there fails here, before anything is read.
  try { await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); }); } catch (error) { clearTimeout(timer); return gitMissing(error); }
  return { chunks: child.stdout![Symbol.asyncIterator]() as AsyncIterator<Buffer>, ended, stop };
}

/** One file's diff in a scope as it is streamed: its path from the workspace, its text a piece at a time, and (once the text is read) whether Git took it as binary. */
export interface GitDiffStream { readonly path: string; readonly text: AsyncGenerator<string, void>; binary(): boolean; close(): void }
/**
 * The unified diff of one file of the workspace in `scope` (`path` relative to the workspace or absolute, in it; a file deleted in the working tree may be named): a
 * renamed or copied file with the path it came from, an untracked one as a new file (`--- /dev/null`), one that did not change in the scope as no text. Its text is read
 * from Git as it is sent, without a length bound: a Git that fails before it has written anything throws here (409 with its words); one that fails or runs out of time
 * after makes the text throw. A binary file has Git's line that says so, and `binary()` true. `close` stops Git (the page went away).
 */
export async function gitFileDiff(workspace: string, scope: GitScope, path: string, options: { readonly ignoreWhitespace?: boolean } = {}): Promise<GitDiffStream> {
  if (typeof path !== "string" || path === "" || path.includes("\0")) throw new SessionError("INVALID_INPUT", "path 是工作区里的一个文件");
  const { root } = await repository(workspace), against = await compared(root, scope);
  const named = await workspacePath(root, workspace, path, "只能看这个对话工作区里的文件"), space = options.ignoreWhitespace === true ? ["-w"] : [];
  if (named === "") throw new SessionError("INVALID_INPUT", "path 是工作区里的一个文件，不是工作区本身");
  // The file as it changed in the scope; a file that is new or gone by itself may be one half of a rename, seen only with the whole scope.
  const own = await run(root, ["--literal-pathspecs", "diff", "--raw", "-z", ...DIFF, ...against.range, "--", named], LIST);
  if (own.code !== 0) throw failed("git diff", own);
  let change = rawOf(own.stdout).find(entry => entry.path === named);
  if (change !== undefined && (change.status === "added" || change.status === "deleted")) {
    const all = await run(root, ["diff", "--raw", "-z", ...DIFF, ...against.range, "--"], LIST);
    if (all.code !== 0) throw failed("git diff", all);
    change = rawOf(all.stdout).find(entry => entry.path === named || entry.oldPath === named) ?? change;
  }
  let args: readonly string[], fine: readonly number[] = [0];
  if (change !== undefined) args = [...VERBATIM, "--literal-pathspecs", "diff", ...DIFF, ...PATCH, ...space, ...against.range, "--", ...(change.oldPath === undefined ? [change.path] : [change.oldPath, change.path])];
  // An untracked file against nothing; `--no-index` answers 1 when the two differ.
  else if (against.worktree && (await untrackedOf(root, named)).includes(named)) { args = [...VERBATIM, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", ...PATCH, ...space, "--", "/dev/null", named]; fine = [0, 1]; }
  else return { path: named, text: (async function* () { /* nothing changed */ })(), binary: () => false, close: () => undefined };
  const git = await streamGit(root, args, { read: true, timeoutMs: DIFF_MS });
  // The first output, or the end: a Git that failed at once is answered as a failure, before anything is sent.
  let first: IteratorResult<Buffer>;
  try { first = await git.chunks.next(); } catch (error) { git.stop(); throw error; }
  if (first.done === true) {
    const end = await git.ended.catch(gitMissing);
    if (end.timedOut || !fine.includes(end.code ?? -1)) throw failed("git diff", { ...end, stdout: Buffer.alloc(0) });
  }
  let head = "";
  const decoder = new StringDecoder("utf8");
  async function* text(): AsyncGenerator<string, void> {
    try {
      for (let step = first; step.done !== true; step = await git.chunks.next()) {
        const piece = decoder.write(step.value);
        if (head.length < 64 * 1024) head += piece;
        if (piece !== "") yield piece;
      }
      const tail = decoder.end();
      if (tail !== "") { head += tail; yield tail; }
      const end = await git.ended;
      if (end.timedOut || !fine.includes(end.code ?? -1)) throw failed("git diff", { ...end, stdout: Buffer.alloc(0) });
    } finally { git.stop(); }
  }
  // Only a header line starts with these words (a line of a hunk starts with a space, + or -), and a header is at the start.
  return { path: named, text: text(), binary: () => /(?:^|\n)Binary files [^\n]* differ(?:\n|$)/u.test(head), close: () => git.stop() };
}

/**
 * A page of the current branch's commits, newest first as `git log` lists them (a workspace below the repository's top: those that touched it), of `limit` commits from
 * the one after `before` (the last of the previous page); `next` is what to give as `before` for the next page, null at the end. None before the first commit.
 * INVALID_INPUT for a `before` that is no commit here; GIT_HISTORY_CHANGED when it is no longer in the branch's history (the branch moved: read from the first page).
 */
export async function gitLog(workspace: string, options: { readonly before?: string; readonly limit: number }): Promise<GitLogView> {
  const { root, prefix } = await repository(workspace);
  const before = options.before === undefined ? undefined : await commitOf(root, options.before, "before 不是这个仓库里的提交");
  if (await headOf(root) === null) {
    if (before !== undefined) throw new SessionError("GIT_HISTORY_CHANGED", "这个提交不在当前分支的历史里了（分支可能变了），请从第一页重新读");
    return { commits: [], next: null };
  }
  const git = await streamGit(root, ["log", "-z", "--format=%H%x00%h%x00%s%x00%an%x00%ct", "HEAD", "--", ...(prefix === "" ? [] : ["."])], LIST);
  const commits: GitCommitEntryView[] = [];
  let skipping = before !== undefined, more = false, carry: Buffer = Buffer.alloc(0), fields: string[] = [];
  try {
    // Every field ends in a NUL (a commit's last one too, with -z): five to a commit.
    reading: for (;;) {
      const step = await git.chunks.next();
      if (step.done === true) break;
      let data: Buffer = carry.length === 0 ? step.value : Buffer.concat([carry, step.value]);
      for (let at = data.indexOf(0); at >= 0; at = data.indexOf(0)) {
        fields.push(data.subarray(0, at).toString("utf8")); data = data.subarray(at + 1);
        if (fields.length < 5) continue;
        const [sha = "", shortSha = "", subject = "", author = "", time = "0"] = fields;
        fields = [];
        if (skipping) { skipping = sha !== before; continue; }
        if (commits.length === options.limit) { more = true; break reading; }
        commits.push({ sha, shortSha, subject, author, committedAt: Number(time) * 1000 });
      }
      carry = data;
    }
    if (!more) {
      const end = await git.ended.catch(gitMissing);
      if (end.timedOut || end.code !== 0) throw failed("git log", { ...end, stdout: Buffer.alloc(0) });
    }
  } finally { git.stop(); }
  if (skipping) throw new SessionError("GIT_HISTORY_CHANGED", "这个提交不在当前分支的历史里了（分支可能变了），请从第一页重新读");
  return { commits, next: more ? commits[commits.length - 1]!.sha : null };
}

/**
 * The local branches and the remote-tracking ones (without the remotes' HEAD), each by its name (`main`, `origin/main`), the most recently committed first; the current
 * branch (null on a detached head; named before its first commit); and the default branch a branch is compared with when none is named (as `gitChanges` takes it).
 */
export async function gitBranches(workspace: string): Promise<GitBranchesView> {
  const { root } = await repository(workspace);
  const [refs, head, fallback] = await Promise.all([run(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"], READ),
    run(root, ["symbolic-ref", "--short", "--quiet", "HEAD"], READ), defaultBranch(root)]);
  if (refs.code !== 0) throw failed("git for-each-ref", refs);
  const local: string[] = [], remote: string[] = [];
  for (const line of refs.stdout.toString("utf8").split("\n")) {
    const [name = "", symref = ""] = line.split("\0");
    if (name === "" || symref !== "") continue;
    if (name.startsWith("refs/heads/")) local.push(name.slice("refs/heads/".length));
    else if (name.startsWith("refs/remotes/")) remote.push(name.slice("refs/remotes/".length));
  }
  const current = head.code === 0 ? head.stdout.toString("utf8").trim() : "";
  return { current: current === "" ? null : current, local, remote, defaultBranch: fallback };
}
