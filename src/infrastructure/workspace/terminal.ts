import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { IPty } from "node-pty";
import { loginShellEnvironment } from "../discovery/login-shell.js";

/** How long a shell has to end after it is hung up on (told again every 200 ms), and how long it is waited for after it is killed. */
const HANGUP_GRACE_MS = 2000, HANGUP_REPEAT_MS = 200, KILL_WAIT_MS = 2000;
/** The shell of a user whose `$SHELL` is unset or no program: the default of macOS. */
const DEFAULT_SHELL = "/bin/zsh";
/** What login(1) starts a login shell with; the shell's login configuration builds the user's PATH from it (path_helper and the profiles). */
const LOGIN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface TerminalSize { readonly cols: number; readonly rows: number }

/** The shell a terminal runs: `shell` when it is an absolute path to a program, /bin/zsh otherwise. */
export async function terminalShell(shell: string | undefined): Promise<string> {
  if (shell === undefined || !isAbsolute(shell) || normalize(shell) !== shell || shell.includes("\0")) return DEFAULT_SHELL;
  const usable = await stat(shell).then(info => info.isFile(), () => false) && await access(shell, constants.X_OK).then(() => true, () => false);
  return usable ? shell : DEFAULT_SHELL;
}

/**
 * The environment of a terminal's login shell: what the Gateway hands every login shell it starts (loginShellEnvironment), the
 * shell itself, the terminal type and colours the page's terminal speaks, and the PATH a login starts from. The language is
 * UTF-8 when the Gateway was started with none, since the page's terminal reads and writes UTF-8. `extra` comes last (tests).
 */
export function terminalEnvironment(values: Readonly<Record<string, string | undefined>>, shell: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const base = loginShellEnvironment(values);
  return { PATH: LOGIN_PATH, ...base, ...(base.LANG === undefined && values.LC_ALL === undefined && values.LC_CTYPE === undefined ? { LANG: "en_US.UTF-8" } : {}),
    SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor", ...extra };
}

type NodePty = typeof import("node-pty");
let loaded: Promise<NodePty> | null = null;
/**
 * node-pty, loaded when the first terminal opens: its native part (a prebuilt N-API binary and its spawn helper, no compiling)
 * is loaded with it, so a computer where it cannot load loses the terminal and nothing else of the Gateway.
 */
function nodePty(): Promise<NodePty> {
  loaded ??= import("node-pty").catch((error: unknown) => { loaded = null; throw error; });
  return loaded;
}

export interface WorkspaceTerminalOptions {
  readonly shell: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly size: TerminalSize;
  /** The shell's output, decoded as a stream: a character cut between two reads is told whole with the second. */
  readonly output: (text: string) => void;
  /** Once, after the last output: the shell's exit status, null when a signal ended it. */
  readonly exit: (code: number | null) => void;
}

/**
 * The user's login shell (`<shell> -l`) on a pseudoterminal of its own in a workspace: interactive, with full-screen programs
 * and a size that follows the page. It lives until it exits or `end()` hangs up on it.
 */
export class WorkspaceTerminal {
  /** Ends with the shell's exit status (null when a signal ended it), after the last output has been told. */
  readonly exited: Promise<number | null>;
  private done = false;
  private ending: Promise<void> | null = null;
  private constructor(private readonly pty: IPty, options: WorkspaceTerminalOptions) {
    const decoder = new TextDecoder("utf-8");
    // The pseudoterminal is read as bytes (`encoding: null`): its chunks are decoded here as one stream.
    pty.onData(chunk => { const text = decoder.decode(chunk as unknown as Uint8Array, { stream: true }); if (text !== "") options.output(text); });
    this.exited = new Promise(done => pty.onExit(({ exitCode, signal }) => {
      this.done = true;
      const rest = decoder.decode();
      if (rest !== "") options.output(rest);
      const code = signal !== undefined && signal !== 0 ? null : exitCode;
      options.exit(code); done(code);
    }));
  }
  /** Starts the shell; fails when node-pty cannot load here or the shell cannot be started. */
  static async start(options: WorkspaceTerminalOptions): Promise<WorkspaceTerminal> {
    const pty = await nodePty();
    return new WorkspaceTerminal(pty.spawn(options.shell, ["-l"], { name: "xterm-256color", cols: options.size.cols, rows: options.size.rows, cwd: options.cwd, env: { ...options.env }, encoding: null }), options);
  }
  get pid(): number { return this.pty.pid; }
  write(data: string): void { if (!this.done) this.pty.write(data); }
  resize(size: TerminalSize): void { if (!this.done) this.pty.resize(size.cols, size.rows); }
  /** Stops reading the shell's output: its writes block once the pseudoterminal's buffer is full, and nothing is dropped. */
  pause(): void { if (!this.done) this.pty.pause(); }
  resume(): void { if (!this.done) this.pty.resume(); }
  /**
   * Hangs up, as a line that is cut does: the shell and every other process on its terminal (its jobs, a full-screen program)
   * get SIGHUP, which a program started with nohup ignores. The shell is told again until it exits (a shell can miss a hang-up
   * that comes as it finishes a command line); still there after two seconds, it and its process group are killed. Ends once the
   * shell has exited, or two seconds after the kill; `true` when it is known to have exited.
   */
  end(): Promise<boolean> {
    this.ending ??= (async () => {
      if (this.done) return;
      // Listed while the shell still holds its terminal: a terminal's name is given to another one once it is closed.
      const others = (await terminalProcesses(this.tty)).filter(pid => pid !== this.pty.pid);
      if (this.done) return;
      signal(this.pty.pid, "SIGHUP");
      for (const pid of others) signal(pid, "SIGHUP");
      for (const deadline = Date.now() + HANGUP_GRACE_MS; Date.now() < deadline; signal(this.pty.pid, "SIGHUP"))
        if (await within(this.exited, HANGUP_REPEAT_MS)) return;
      signal(-this.pty.pid, "SIGKILL"); signal(this.pty.pid, "SIGKILL");
      await within(this.exited, KILL_WAIT_MS);
    })();
    return this.ending.then(() => this.done);
  }
  /** The terminal's device (`/dev/ttys…`), as node-pty names it; undefined when it does not. */
  private get tty(): string | undefined {
    const name = (this.pty as unknown as { readonly ptsName?: unknown }).ptsName;
    return typeof name === "string" && /^\/dev\/ttys[0-9]{1,6}$/u.test(name) ? name : undefined;
  }
}
/** The processes whose terminal is `tty`, by `ps`; none when it cannot tell. */
function terminalProcesses(tty: string | undefined): Promise<readonly number[]> {
  if (tty === undefined) return Promise.resolve([]);
  return new Promise(done => execFile("/bin/ps", ["-t", tty, "-o", "pid="], { timeout: 2000, env: { PATH: "/usr/bin:/bin" } }, (error, stdout) => {
    done(error ? [] : String(stdout).split(/\s+/u).filter(Boolean).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1));
  }));
}
function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); } catch { /* already gone */ }
}
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), ms); })]); }
  finally { clearTimeout(timer); }
}
