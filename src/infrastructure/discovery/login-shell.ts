import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";
import { SessionError } from "../../contracts/session.js";

/** Bounds of one read of the login shell's PATH (G(ii)): its deadline, its output and how many directories are kept. */
const LOGIN_SHELL_MS = 3000, LOGIN_SHELL_BYTES = 64 * 1024, MAX_DIRECTORIES = 64;
const BEGIN = "__HARNESSHUB_PATH_BEGIN__", END = "__HARNESSHUB_PATH_END__";
/** The shell prints PATH between two markers; anything its profile prints before or after is ignored. */
const SCRIPT = `printf '%s\\n' ${BEGIN}; printf '%s\\n' "$PATH"; printf '%s\\n' ${END}`;

/**
 * The PATH directories of the user's login shell, read once on the user's request: `$SHELL -l -c` runs the shell's login
 * configuration non-interactively and prints PATH between markers. The shell must be an absolute path to a file that the
 * system's shell list names. Only existing absolute directories are kept, at most 64. It fails with LOGIN_SHELL_UNAVAILABLE
 * for a shell that may not be run and LOGIN_SHELL_FAILED when the shell exceeds 3 seconds or 64 KiB, exits with an error, or
 * prints no PATH; its whole process group has ended before it returns, either way.
 */
export async function readLoginShellPath(shell: string, options: { readonly shells: string; readonly env: Readonly<Record<string, string>> }): Promise<readonly string[]> {
  if (!isAbsolute(shell) || normalize(shell) !== shell) throw new SessionError("LOGIN_SHELL_UNAVAILABLE", "the login shell is no absolute path");
  const listed = readFileSync(options.shells, "utf8").split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!listed.includes(shell) || !(await stat(shell).then(info => info.isFile(), () => false))) throw new SessionError("LOGIN_SHELL_UNAVAILABLE", "the login shell is not a listed shell");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, ["-l", "-c", SCRIPT], { env: { ...options.env, SHELL: shell, TERM: "dumb" }, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let bytes = 0, failure: SessionError | null = null;
    const end = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already ended */ } };
    const timer = setTimeout(() => { failure ??= new SessionError("LOGIN_SHELL_FAILED", "the login shell took longer than 3 seconds"); end(); }, LOGIN_SHELL_MS);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > LOGIN_SHELL_BYTES) { failure ??= new SessionError("LOGIN_SHELL_FAILED", "the login shell printed more than 64 KiB"); end(); } else chunks.push(chunk); });
    child.once("error", () => { failure ??= new SessionError("LOGIN_SHELL_FAILED", "the login shell could not start"); });
    const closed = new Promise<void>(done => child.once("close", () => done()));
    // The shell's exit is the end: whatever its login configuration started in its group (and may hold its output open) ends
    // with it, then the output is drained.
    child.once("exit", code => { void (async () => {
      clearTimeout(timer); end();
      for (const deadline = Date.now() + 2000; child.pid && groupAlive(child.pid) && Date.now() < deadline;) await new Promise(done => setTimeout(done, 25));
      if (child.pid && groupAlive(child.pid)) throw new SessionError("LOGIN_SHELL_FAILED", "the login shell's processes did not end");
      await Promise.race([closed, new Promise(done => setTimeout(done, 1000))]); child.stdout.destroy();
      if (failure) throw failure;
      if (code !== 0) throw new SessionError("LOGIN_SHELL_FAILED", "the login shell exited with an error");
      return Buffer.concat(chunks).toString("utf8");
    })().then(resolve, reject); });
  });
  const lines = output.split(/\r?\n/u), from = lines.indexOf(BEGIN), to = lines.indexOf(END, from + 1);
  if (from < 0 || to !== from + 2) throw new SessionError("LOGIN_SHELL_FAILED", "the login shell printed no PATH");
  const directories: string[] = [];
  for (const entry of lines[from + 1]!.split(":")) {
    if (!isAbsolute(entry) || directories.includes(normalize(entry)) || directories.length >= MAX_DIRECTORIES) continue;
    if (await stat(entry).then(info => info.isDirectory(), () => false)) directories.push(normalize(entry));
  }
  return directories;
}
function groupAlive(group: number): boolean {
  try { process.kill(-group, 0); return true; } catch (error) { return !(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

const FILE = "login-shell-path.json", VERSION = 1;
/** What the last read found, as the user kept it: shown and used for discovery until the user removes it. */
export interface LoginShellDirectories { readonly shell: string; readonly readAt: number; readonly dirs: readonly string[] }
/**
 * The login shell's directories in the data root, written only on the user's request and read at start; never re-read
 * automatically. A file that this version cannot read is left alone and treated as none.
 */
export class LoginShellStore {
  private readonly path: string;
  constructor(root: string) { this.path = join(root, FILE); }
  async load(): Promise<LoginShellDirectories | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.path, "utf8")); } catch { return null; }
    if (value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.version !== VERSION || typeof record.shell !== "string" || typeof record.readAt !== "number" || !Array.isArray(record.dirs)
      || record.dirs.length > MAX_DIRECTORIES || record.dirs.some(dir => typeof dir !== "string" || !isAbsolute(dir))) return null;
    return { shell: record.shell, readAt: record.readAt, dirs: record.dirs as string[] };
  }
  async save(value: LoginShellDirectories): Promise<void> {
    const temporary = this.path + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp";
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ version: VERSION, shell: basename(value.shell), readAt: value.readAt, dirs: value.dirs }) + "\n"); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, this.path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
