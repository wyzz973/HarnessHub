import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { SessionError } from "../../contracts/session.js";
import type { GhState, GitPullRequestCreatedView, GitPullRequestStatusView, GitPullRequestView } from "../../contracts/web.js";
import { gitPush } from "./git.js";
import { runGit, runProgram, said, type Ran } from "./program.js";

/*
 * A pull request of the conversation's branch, made with the user's own GitHub CLI when the user presses the page's button (2026-11-14); the Gateway never makes one by
 * itself. gh is the one on the Gateway's PATH or in a folder it was given (the login shell's). It runs without a terminal and without prompts (GH_PROMPT_DISABLED=1,
 * GIT_TERMINAL_PROMPT=0), within a time, and what it says when it refuses is what the user is told.
 */

const READ_MS = 15_000, GH_READ_MS = 20_000, CREATE_MS = 75_000;
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" } as const;

async function git(cwd: string, args: readonly string[]): Promise<Ran> {
  try { return await runGit(cwd, args, { timeoutMs: READ_MS, env: { GIT_OPTIONAL_LOCKS: "0" } }); }
  catch (error) {
    if ((error as { readonly code?: unknown } | null)?.code === "ENOENT") throw new SessionError("GIT_UNAVAILABLE", "这台 Mac 上找不到 git");
    throw error;
  }
}
const line = (ran: Ran): string | null => ran.code === 0 && ran.stdout.trim() !== "" ? ran.stdout.trim() : null;
const count = (ran: Ran): number => { const value = Number(ran.stdout.trim()); return ran.code === 0 && Number.isSafeInteger(value) ? value : 0; };

/** The folders gh is looked for in: the Gateway's PATH, then the ones it was given; the PATH gh itself runs with is all of them. */
function folders(extra: readonly string[]): string[] { return [...new Set([...(process.env.PATH ?? "").split(delimiter), ...extra].filter(dir => dir !== ""))]; }
async function ghIn(dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    const path = join(dir, "gh");
    if (await stat(path).then(info => info.isFile(), () => false) && await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  return null;
}
async function gh(program: string, dirs: readonly string[], cwd: string, args: readonly string[], timeoutMs: number): Promise<Ran> {
  try { return await runProgram(program, cwd, args, { timeoutMs, env: { ...GH_ENV, PATH: dirs.join(delimiter) } }); }
  catch { throw new SessionError("GH_UNAVAILABLE", "gh（GitHub CLI）启动不了"); }
}

/** A remote's URL as it may be shown: without a user or password in it (an https URL may carry a token). */
function shownUrl(url: string): string { return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, (whole, scheme: string) => /^(https?|ftps?):/iu.test(scheme) ? scheme : whole); }
function hostOf(url: string): string {
  const parsed = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)/iu.exec(url) ?? /^(?:[^@/]+@)?([^:/]+):/u.exec(url);
  return (parsed?.[1] ?? "").toLowerCase();
}
const isGithub = (host: string): boolean => host === "github.com" || host === "ssh.github.com" || host.endsWith(".ghe.com");

/** Where the branch stands, as both the status and the creation read it; `gh` is the program found, or null. */
interface Standing {
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly remote?: { readonly name: string; readonly url: string; readonly github: boolean };
  readonly upstream?: string;
  readonly ahead: number;
  readonly unpushed: number;
  readonly gh: string | null;
  readonly dirs: readonly string[];
  readonly cwd: string;
}
async function standing(workspace: string, given: readonly string[]): Promise<Standing> {
  const cwd = await realpath(workspace).catch(() => workspace);
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new SessionError("NOT_A_REPOSITORY", "这个对话的工作区不在 Git 仓库里");
  const dirs = folders(given);
  const [head, branched, upstreamRan, remotesRan, program] = await Promise.all([git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]), git(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), git(cwd, ["remote"]), ghIn(dirs)]);
  const branch = line(branched), upstream = line(upstreamRan) ?? undefined, remotes = (line(remotesRan) ?? "").split("\n").map(name => name.trim()).filter(name => name !== "");
  // The remote a push goes to (git.ts gitPush): the branch's upstream's, else origin.
  const tracked = branch === null ? null : line(await git(cwd, ["config", "--get", "branch." + branch + ".remote"]));
  const name = tracked !== null && tracked !== "." && remotes.includes(tracked) ? tracked : remotes.includes("origin") ? "origin" : null;
  const url = name === null ? null : line(await git(cwd, ["remote", "get-url", name]));
  const remote = name === null || url === null ? undefined : { name, url: shownUrl(url), github: isGithub(hostOf(url)) };
  // The default branch: the one the remote's HEAD names, else main, else master, as the remote has it or as this repository does.
  let defaultBranch: string | null = null, defaultRef: string | null = null;
  const named = name === null ? null : line(await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/" + name + "/HEAD"]));
  if (named !== null && named.startsWith("refs/remotes/" + name + "/")) { defaultBranch = named.slice(("refs/remotes/" + name + "/").length); defaultRef = named; }
  else candidates: for (const candidate of ["main", "master"]) {
    for (const ref of [...(name === null ? [] : ["refs/remotes/" + name + "/" + candidate]), "refs/heads/" + candidate]) {
      if ((await git(cwd, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"])).code === 0) { defaultBranch = candidate; defaultRef = ref; break candidates; }
    }
  }
  const hasHead = head.code === 0;
  const [ahead, unpushed] = await Promise.all([
    hasHead && defaultRef !== null ? git(cwd, ["rev-list", "--count", defaultRef + "..HEAD"]).then(count) : Promise.resolve(0),
    !hasHead ? Promise.resolve(0) : upstream !== undefined ? git(cwd, ["rev-list", "--count", "@{u}..HEAD"]).then(count) : git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).then(count)]);
  return { branch, defaultBranch, ...(remote === undefined ? {} : { remote }), ...(upstream === undefined ? {} : { upstream }), ahead, unpushed, gh: program, dirs, cwd };
}
async function signedIn(at: Standing): Promise<boolean> {
  const host = at.remote?.github === true ? hostOf(at.remote.url) : null;
  const ran = await gh(at.gh!, at.dirs, at.cwd, ["auth", "status", ...(host === null || host === "ssh.github.com" ? [] : ["--hostname", host])], GH_READ_MS).catch(() => null);
  return ran !== null && ran.code === 0 && !ran.timedOut;
}
function pullRequestOf(text: string): GitPullRequestView | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return typeof value.url === "string" && typeof value.number === "number" && Number.isSafeInteger(value.number) && typeof value.title === "string" && typeof value.state === "string"
      ? { url: value.url, number: value.number, title: value.title, state: value.state } : null;
  } catch { return null; }
}

/** What a pull request of the current branch would take (GitPullRequestStatusView); NOT_A_REPOSITORY when the workspace is in no repository. */
export async function pullRequestStatus(workspace: string, given: readonly string[]): Promise<GitPullRequestStatusView> {
  const at = await standing(workspace, given);
  let state: GhState = at.gh === null ? "missing" : "signed-out", existing: GitPullRequestView | null = null;
  if (at.gh !== null) {
    // Signed in, and the branch's pull request when there is one (`gh pr view` fails when there is none).
    const [ready, viewed] = await Promise.all([signedIn(at), at.branch === null ? Promise.resolve(null) : gh(at.gh, at.dirs, at.cwd, ["pr", "view", at.branch, "--json", "url,number,title,state"], GH_READ_MS).catch(() => null)]);
    if (ready) { state = "ready"; existing = viewed !== null && viewed.code === 0 && !viewed.timedOut ? pullRequestOf(viewed.stdout) : null; }
  }
  return { gh: state, branch: at.branch, defaultBranch: at.defaultBranch, ...(at.remote === undefined ? {} : { remote: at.remote }), ...(at.upstream === undefined ? {} : { upstream: at.upstream }),
    ahead: at.ahead, unpushed: at.unpushed, ...(existing === null ? {} : { existing }) };
}

/**
 * Makes the pull request of the current branch into `base` (by default the default branch): the branch is pushed first when it has no upstream or is ahead of it
 * (gitPush), then `gh pr create --title --body --base --head`. Refused on a detached head (GIT_DETACHED_HEAD), on the default branch or with the branch as its own base
 * (GIT_PR_ON_DEFAULT_BRANCH), without gh (GH_UNAVAILABLE) or signed out of it (GH_AUTH_REQUIRED); what gh refuses is GIT_PR_FAILED with its words.
 */
export async function createPullRequest(workspace: string, given: readonly string[], input: { readonly title: string; readonly body: string; readonly base?: string }): Promise<GitPullRequestCreatedView> {
  if (typeof input.title !== "string" || input.title.trim() === "") throw new SessionError("INVALID_INPUT", "拉取请求要有标题");
  if (typeof input.body !== "string") throw new SessionError("INVALID_INPUT", "body 是拉取请求的说明（可以为空）");
  if (input.base !== undefined && (typeof input.base !== "string" || input.base === "" || input.base.startsWith("-") || /[\u0000- \u007f~^:?*[\\]/u.test(input.base)))
    throw new SessionError("INVALID_INPUT", "base 是要合进去的分支名");
  const at = await standing(workspace, given);
  if (at.branch === null) throw new SessionError("GIT_DETACHED_HEAD", "现在不在任何分支上（分离头指针），先切到一个分支再建拉取请求");
  const base = input.base ?? at.defaultBranch;
  if (base === null) throw new SessionError("INVALID_INPUT", "找不到默认分支（远端的 HEAD、main、master 都没有），请指明要合进哪个分支");
  if (at.branch === at.defaultBranch) throw new SessionError("GIT_PR_ON_DEFAULT_BRANCH", "现在就在默认分支 " + at.branch + " 上：先换到别的分支，再建拉取请求");
  if (at.branch === base) throw new SessionError("GIT_PR_ON_DEFAULT_BRANCH", "要合进去的分支就是当前分支 " + at.branch + "，换一个 base");
  if (at.gh === null) throw new SessionError("GH_UNAVAILABLE", "这台 Mac 上找不到 gh（GitHub CLI）：先装上它（brew install gh）并登录");
  if (!await signedIn(at)) throw new SessionError("GH_AUTH_REQUIRED", "gh 还没有登录 GitHub：在终端里运行 gh auth login");
  if (at.upstream === undefined || at.unpushed > 0) await gitPush(workspace);
  const made = await gh(at.gh, at.dirs, at.cwd, ["pr", "create", "--title", input.title, "--body", input.body, "--base", base, "--head", at.branch], CREATE_MS);
  if (made.timedOut) throw new SessionError("GIT_PR_FAILED", "gh pr create 75 秒没有完成，已停下：" + said(made));
  if (made.code !== 0) throw new SessionError("GIT_PR_FAILED", said(made) || "gh pr create 没有成功");
  const urls = [...made.stdout.matchAll(/https?:\/\/\S+\/pull\/(\d+)/gu)], found = urls[urls.length - 1];
  if (found === undefined) throw new SessionError("GIT_PR_FAILED", "gh 没有给出拉取请求的地址：" + said(made));
  return { url: found[0], number: Number(found[1]) };
}
