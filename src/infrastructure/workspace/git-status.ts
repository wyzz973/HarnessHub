import { spawn } from "node:child_process";

/*
 * Where a conversation's workspace stands in Git, for the page's header (2026-11-14): the current branch and how many entries `git status --porcelain` lists. Read-only and
 * best effort: one `git status --porcelain=v2 --branch` in the workspace, without the optional locks (GIT_OPTIONAL_LOCKS=0, so it never takes the index lock a Harness's own
 * Git may want), given a few seconds. A workspace that is not a repository, a Git that is missing, fails or is slow: no answer, never an error.
 */

export interface WorkspaceGit { readonly branch: string | null; readonly dirty: number }

/** How long `git status` is given before the answer is "no Git". */
const STATUS_MS = 3000;

/**
 * The branch (null on a detached head) and the number of changed, staged and untracked entries of the repository `workspace` is in; null when it is in none or Git
 * did not answer in time. The output is read as it comes, a line at a time: a repository with any number of changes is counted without holding its list.
 */
export function workspaceGit(workspace: string, timeoutMs = STATUS_MS): Promise<WorkspaceGit | null> {
  return new Promise(done => {
    let branch: string | null = null, dirty = 0, carry = "", finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: WorkspaceGit | null): void => { if (!finished) { finished = true; if (timer !== undefined) clearTimeout(timer); done(value); } };
    const line = (text: string): void => {
      if (text === "") return;
      if (!text.startsWith("# ")) { dirty++; return; }
      if (text.startsWith("# branch.head ")) { const name = text.slice("# branch.head ".length); branch = name === "(detached)" ? null : name; }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["status", "--porcelain=v2", "--branch"], { cwd: workspace, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "ignore"] });
    } catch { finish(null); return; }
    timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    timer.unref();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      const parts = (carry + chunk).split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) line(part);
    });
    child.on("error", () => finish(null));
    child.on("close", code => { line(carry); carry = ""; finish(code === 0 ? { branch, dirty } : null); });
  });
}
