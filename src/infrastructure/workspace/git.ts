import { spawn } from "node:child_process";
import { posix } from "node:path";
import { SessionError } from "../../contracts/session.js";
import type { GitCommitView, GitFileView, GitPushView, GitView } from "../../contracts/web.js";
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
    if (numstat.code === 0) {
      const parts = numstat.stdout.toString("utf8").split("\0");
      for (let index = 0; index < parts.length; index++) {
        const found = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(parts[index]!);
        if (found === null) continue;
        // A rename's line is followed by the path it came from and the path it went to.
        let path = found[3]!;
        if (path === "") { index += 2; path = parts[index] ?? ""; }
        if (found[1] !== "-" && found[2] !== "-") lines.set(fromWorkspace(prefix, path), { added: Number(found[1]), removed: Number(found[2]) });
      }
    }
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
