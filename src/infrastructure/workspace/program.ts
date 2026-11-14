import { spawn } from "node:child_process";

/*
 * A program the Gateway runs for a conversation's checkpoints and pull requests (2026-11-14): without a shell (an argument list), without a terminal (its own session,
 * so neither Git, ssh nor gh can ask for anything), with nothing on its stdin unless it is given input, and within a time. One that runs out of time is ended with its
 * whole process group, gently first (Git then takes away its lock and temporary files), and for good a second later.
 */

export interface Ran { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export interface RunOptions {
  readonly timeoutMs: number;
  /** Added to the Gateway's environment, after GIT_TERMINAL_PROMPT=0. */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

/** Runs `program` in `cwd`; rejects only when it could not be started (ENOENT for a program or a folder that is not there). A time already up is a run that timed out. */
export function runProgram(program: string, cwd: string, args: readonly string[], options: RunOptions): Promise<Ran> {
  return new Promise((done, fail) => {
    if (options.timeoutMs <= 0) { done({ code: null, stdout: "", stderr: "", timedOut: true }); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env }, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
    } catch (error) { fail(error); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let timedOut = false, finished = false, hard: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals): void => { try { process.kill(-child.pid!, name); } catch { try { child.kill(name); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; signal("SIGTERM"); hard = setTimeout(() => signal("SIGKILL"), 1000); }, options.timeoutMs);
    const end = (): void => { finished = true; clearTimeout(timer); if (hard !== undefined) clearTimeout(hard); };
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", error => { if (finished) return; end(); fail(error); });
    child.on("close", code => { if (finished) return; end(); done({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut }); });
    if (options.input !== undefined) { child.stdin!.on("error", () => { /* it did not read what it was given; its exit says the rest */ }); child.stdin!.end(options.input); }
  });
}
export const runGit = (cwd: string, args: readonly string[], options: RunOptions): Promise<Ran> => runProgram("git", cwd, args, options);

/** What a program said, both streams, cut in the middle when long so that its first words and its last (where Git or gh says why) both stay. */
export function said(ran: Ran): string {
  const text = [ran.stderr.trim(), ran.stdout.trim()].filter(part => part !== "").join("\n");
  return text.length <= 480 ? text : text.slice(0, 180) + " … " + text.slice(-290);
}
