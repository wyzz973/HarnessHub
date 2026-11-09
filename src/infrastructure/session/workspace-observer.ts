import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstat as lstatCallback } from "node:fs";
import { lstat, open, opendir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { MAX_PARALLEL_CONVERSATIONS, SessionError } from "../../contracts/session.js";
import { namesCredentialFile } from "../../contexts/session/domain/relay/redaction.js";
import { exitedGroupSnapshotIsQuiescent } from "../control/process-group.js";

// ---- Types (ADR-055 终稿 §4) ----------------------------------------------------------------------------------------
// 与终稿 §4 一致；合并 G066 后改为从 src/contracts/relay.ts 导入（主负责人做）。字段按 §4 的约定一律 readonly（§4 正文
// 为篇幅省略了）。唯一的调整：unavailable 的原因码 `data_root_inside` 改为 `data_root_in_workspace`，与受理时的
// `409 RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`、INV-36、安全契约与用例 G071-S01 同名，且同样涵盖两个方向的
// 包含（数据根在工作区里、工作区在数据根里）；理由见 docs/verification/relay-g071-2026-11-09.md。

declare const printBrand: unique symbol;
/** sha256 十六进制（64）；凡是可能对应秘密的值一律不用它，改用 HMAC（INV-29，第 10.2 节）。 */
export type Fingerprint = string & { readonly [printBrand]: true };

/** 工作区观测：记录下来的事实，随交接单落库，重建时作输入。只存有界摘要：改动优先、≤1,000 项，另存计数与全量指纹（RT3 P04）。 */
export type WorkspaceObservation =
  | { readonly kind: "git"; readonly status: "complete" | "partial"; readonly branch: string | null; readonly head: string | null; readonly fingerprint: Fingerprint; readonly durationMs: number;
      readonly files: readonly { readonly path: string; readonly change: "modified" | "added" | "deleted" | "renamed" | "untracked"; readonly added: number | null; readonly removed: number | null; readonly credentialPath: boolean; readonly lfs: boolean }[];
      readonly counted: { readonly total: number; readonly listed: number }; readonly neutralized: readonly string[]; readonly attributesIncluded: boolean }
  | { readonly kind: "tree"; readonly status: "complete" | "partial"; readonly fingerprint: Fingerprint; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly size: number; readonly mtimeMs: number }[]; readonly scanned: number; readonly counted: number }
  | { readonly kind: "unavailable"; readonly reason: "timeout" | "error" | "no_workspace" | "lease_not_held" | "gitdir_outside" | "root_is_home" | "root_is_fs" | "data_root_in_workspace" };

type GitFile = Extract<WorkspaceObservation, { kind: "git" }>["files"][number];
type TreeFile = Extract<WorkspaceObservation, { kind: "tree" }>["files"][number];
type Unavailable = Extract<WorkspaceObservation, { kind: "unavailable" }>["reason"];

// ---- Bounds (ADR-055 §10.6, §11.1) ------------------------------------------------------------------------------------

/** The hard cap on one observation, from the call to its result, queueing included (§10.6); the observer's default. */
export const OBSERVE_TIMEOUT_MS = 250;
/** The most a cap given to an observer may be (see WorkspaceObserverOptions.timeoutMs). */
export const MAX_OBSERVE_TIMEOUT_MS = 60_000;
/** At most this many observations run at once in one observer; the others wait for a slot within their own cap. */
export const MAX_PARALLEL_OBSERVATIONS = MAX_PARALLEL_CONVERSATIONS;
/** Files an observation keeps; the count and the fingerprint still cover every file it saw. */
export const MAX_LISTED_FILES = 1000;
/** Directory entries a tree observation reads at most. */
export const MAX_TREE_ENTRIES = 20_000;
/** `git config --list -z --show-origin` output read at most; more falls back to a tree observation. */
export const MAX_CONFIG_LIST_BYTES = 64 * 1024;
/** A git observation is reused while HEAD and the index's mtime are as they were, for this long after it was made. */
export const REUSE_WINDOW_MS = 60_000;
/** Filter drivers neutralized at most (four config entries each); more falls back to a tree observation. */
export const MAX_FILTER_DRIVERS = 256;
/** What `git status` or `git diff` may print before the observation gives up as unavailable{error}. */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
/** The name a filter driver must have to be neutralized by name (§10.6); dots are allowed. */
const DRIVER_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
/** The empty tree, given to `--attr-source` so the worktree's .gitattributes are not read by status and diff. */
const EMPTY_TREE = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" } as const;
/** Every data directory holds this ownership marker (sqlite-store.ts); a directory holding it is never listed. */
const DATA_MARKER = ".harness-gateway.json";
/** macOS names the data volume's firmlinked directories also under this prefix (`/System/Volumes/Data/Users/…`). */
const FIRMLINK_ROOT = "/System/Volumes/Data";
/** After SIGKILL, how long a process group is waited for before it counts as unconfirmed. */
const RELEASE_WAIT_MS = 3000;
/** Entries kept per cache (reuse, driver names, git per workspace); the least recently used go first. */
const CACHE_ENTRIES = 64;
/** Config entries every git command gets, before the per-driver neutralization (§10.6; `diff.autoRefreshIndex` because
 * `git diff` rewrites `.git/index` for stat-dirty files even with GIT_OPTIONAL_LOCKS=0, measured on git 2.54.0). */
const HARDENING: readonly (readonly [string, string])[] = [["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"], ["core.attributesFile", "/dev/null"], ["diff.autoRefreshIndex", "false"]];

// ---- Public surface -----------------------------------------------------------------------------------------------------

export interface WorkspaceObserverOptions {
  /** The Hub's PATH. git is looked up in it once, when the observer is made; relative entries are never used. */
  readonly path: string;
  /** A Hub-private, empty directory that git gets as HOME. It must exist and stay outside every observed workspace. */
  readonly home: string;
  /** The user's home directory: a workspace that is it, or one of its parents, is never scanned (root_is_home). */
  readonly userHome: string;
  /** The Hub's data directory as configured, in any spelling; it must exist when the observer is made. */
  readonly dataRoot: string;
  /** Monotonic milliseconds for the reuse window only; performance.now unless a test steps its own clock. */
  readonly now?: () => number;
  /**
   * The hard cap on one observation, 1 to MAX_OBSERVE_TIMEOUT_MS ms: OBSERVE_TIMEOUT_MS (250 ms, §10.6) unless given.
   * The Hub never gives it. A test that checks what an observation finds, not when, gives more, so that a busy machine
   * cannot turn its case into a timeout; the cap itself is tested at its default.
   */
  readonly timeoutMs?: number;
}

/** What one observe() call gives back. */
export interface ObservationOutcome {
  readonly observation: WorkspaceObservation;
  /** The previous observation of the same workspace, given back as it was (same object, same durationMs). */
  readonly reused: boolean;
  /**
   * Settles once every process this observation started is gone, never rejects: "released" when each one's process group
   * was seen empty, "unconfirmed" when one was still there 3 s after SIGKILL (counted in stats().unconfirmed). Already
   * settled when the observation finished in time; after a timeout it settles shortly after the result. Await it in the
   * finally of whatever waited for the observation.
   */
  readonly released: Promise<"released" | "unconfirmed">;
}

export interface WorkspaceObserverStats {
  /** Observations holding a slot: their processes are not all gone yet. */
  readonly active: number;
  readonly queued: number;
  /** The most observations that ever held a slot at once; never above MAX_PARALLEL_OBSERVATIONS. */
  readonly peakActive: number;
  /** Observations whose processes were not confirmed gone 3 s after SIGKILL. */
  readonly unconfirmed: number;
}

export interface WorkspaceObserver {
  /**
   * Observes a workspace once (ADR-055 §10.6) and never fails for what it finds there: every failure is an unavailable
   * observation. A workspace that is not a git repository is listed as a tree; a git one is read with `git status` and
   * `git diff` in an environment that is exactly the §10.6 whitelist, with every filter driver neutralized, so no
   * filter, hook, fsmonitor or program from the workspace runs and `.git/index` is never written. The result comes
   * within the cap of the call (250 ms unless the observer was made with another): at the cap every process group the
   * observation started is sent SIGKILL and the result is unavailable{timeout}; `released` settles once those groups are
   * gone. At most four observations run at once.
   * Rejects only for a workspace that is not a bounded absolute path (INVALID_INPUT) and after close()
   * (OBSERVER_CLOSED).
   */
  observe(workspace: string): Promise<ObservationOutcome>;
  stats(): WorkspaceObserverStats;
  /**
   * Stops every observation in flight (SIGKILL to its process groups, result unavailable{error}), drops the queued ones
   * the same way, and settles once every process any observation started is gone or unconfirmed. Idempotent.
   */
  close(): Promise<void>;
}

/**
 * The canonical spelling of an existing directory: its realpath (case as stored, links resolved) and, for a path that
 * macOS also names under `/System/Volumes/Data`, the firmlinked spelling when both name the same directory. Every
 * spelling of one workspace (case, links, firmlink) gives the same string. Rejects when the path does not resolve.
 */
export async function canonicalDirectory(path: string): Promise<string> {
  const real = await realpath(path);
  if (!real.startsWith(FIRMLINK_ROOT + "/")) return real;
  const short = real.slice(FIRMLINK_ROOT.length);
  try {
    const [long, firm] = await Promise.all([stat(real, { bigint: true }), stat(short, { bigint: true })]);
    if (long.dev === firm.dev && long.ino === firm.ino) return await realpath(short);
  } catch { /* No firmlinked spelling: the long one is the only one. */ }
  return real;
}

/**
 * Makes an observer. git is resolved here, once: each absolute PATH entry and the `git` in it are resolved to their
 * realpaths and recorded; an observation uses the first recorded git whose entry and file both lie outside its workspace,
 * so no executable from a workspace ever runs. No git at all is not an error here: observations are then
 * unavailable{error}. Rejects with INVALID_INPUT for a home that is not an existing, empty, real directory, or for paths
 * that are not bounded and absolute.
 */
export async function createWorkspaceObserver(options: WorkspaceObserverOptions): Promise<WorkspaceObserver> {
  const home = boundedAbsolute(options.home, "observer home"), userHome = boundedAbsolute(options.userHome, "user home"), dataRoot = boundedAbsolute(options.dataRoot, "data directory");
  if (typeof options.path !== "string" || options.path.length > 64 * 1024 || /[\0\r\n]/u.test(options.path)) throw new SessionError("INVALID_INPUT", "PATH must be a bounded string");
  const timeoutMs = options.timeoutMs ?? OBSERVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OBSERVE_TIMEOUT_MS) throw new SessionError("INVALID_INPUT", "the observation cap must be a whole number of milliseconds from 1 to " + MAX_OBSERVE_TIMEOUT_MS);
  let privateHome: string;
  try {
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a directory");
    privateHome = await canonicalDirectory(home);
    if ((await readdir(privateHome)).length) throw new Error("not empty");
  } catch { throw new SessionError("INVALID_INPUT", "observer home must be an existing, empty directory"); }
  const candidates: GitCandidate[] = [];
  for (const entry of options.path.split(":")) {
    if (!entry || !isAbsolute(entry) || candidates.length >= 64) continue;
    try {
      const directory = await canonicalDirectory(entry), git = await canonicalFile(join(directory, "git"));
      const info = await stat(git);
      if (info.isFile() && (info.mode & 0o111) !== 0 && !candidates.some(item => item.git === git && item.entry === directory)) candidates.push({ entry: directory, git });
    } catch { /* An entry without a usable git is skipped. */ }
  }
  const homeLine = await identityLine(userHome, null), dataLine = await identityLine(dataRoot, resolve(dataRoot));
  let dataIdentity: string | null = null;
  try { dataIdentity = await identity(await canonicalDirectory(dataRoot)); } catch { /* Checked lexically below. */ }
  return new Observer({ privateHome, candidates, homeLine, dataLine, dataIdentity, dataSpelled: resolve(dataRoot), now: options.now ?? (() => performance.now()), timeoutMs });
}

// ---- Implementation ------------------------------------------------------------------------------------------------------

interface GitCandidate { readonly entry: string; readonly git: string }
interface Setup {
  readonly privateHome: string;
  readonly candidates: readonly GitCandidate[];
  /** `dev:ino` of the user's home and each of its parents. */
  readonly homeLine: ReadonlySet<string>;
  /** `dev:ino` of the data directory and each of its parents, as it resolves and as it is spelled. */
  readonly dataLine: ReadonlySet<string>;
  readonly dataIdentity: string | null;
  readonly dataSpelled: string;
  readonly now: () => number;
  readonly timeoutMs: number;
}
interface GitRun { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string; readonly overflow: boolean; readonly failed: boolean }
interface DriverCache { readonly key: string; readonly drivers: readonly string[] | null }
interface ReuseEntry { readonly key: string; readonly at: number; readonly observation: WorkspaceObservation }
type Result = { readonly observation: WorkspaceObservation; readonly reused: boolean };

function boundedAbsolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\0\r\n]/u.test(value)) throw new SessionError("INVALID_INPUT", label + " must be a bounded absolute path");
  return resolve(value);
}
function within(path: string, root: string): boolean { return path === root || path.startsWith(root === "/" ? "/" : root + "/"); }
function unavailable(reason: Unavailable): Result { return { observation: { kind: "unavailable", reason }, reused: false }; }
function errorCode(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? error.code : undefined; }
async function canonicalFile(path: string): Promise<string> { const real = await realpath(path); return join(await canonicalDirectory(dirname(real)), basename(real)); }
async function identity(path: string): Promise<string> { const info = await stat(path, { bigint: true }); return info.dev + ":" + info.ino; }
/** The identities of `path` and each parent, as it resolves and (when given) as it is spelled; what cannot be read is left out. */
async function identityLine(path: string, spelled: string | null): Promise<ReadonlySet<string>> {
  const line = new Set<string>(), walk = async (start: string) => {
    for (let current = start; ; current = dirname(current)) {
      try { line.add(await identity(current)); } catch { /* A missing part proves nothing. */ }
      if (dirname(current) === current) return;
    }
  };
  try { await walk(await canonicalDirectory(path)); } catch { await walk(resolve(path)); }
  if (spelled !== null) await walk(spelled);
  return line;
}
function fingerprint(value: unknown): Fingerprint { return createHash("sha256").update(JSON.stringify(value)).digest("hex") as Fingerprint; }
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void { cache.delete(key); cache.set(key, value); while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as K); }
const execFileAsync = promisify(execFile);
/** Whether no process is left in `group`; on Darwin a group of zombies answers EPERM, so the table decides then. */
async function groupGone(group: number): Promise<boolean> {
  try { process.kill(-group, 0); return false; }
  catch (error) {
    if (errorCode(error) === "ESRCH") return true;
    if (errorCode(error) !== "EPERM" || process.platform !== "darwin") return false;
    try { return exitedGroupSnapshotIsQuiescent(group, (await execFileAsync("/bin/ps", ["-axo", "pgid=,stat="], { timeout: 1500, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: "C" } })).stdout); }
    catch { return false; }
  }
}
function delay(ms: number): Promise<void> { return new Promise(done => setTimeout(done, ms)); }

/** The slots of one observer: first come, first served, and a waiter whose cap passes leaves the queue. */
class Slots {
  active = 0;
  peak = 0;
  private readonly waiting: { readonly job: Job; readonly grant: (granted: boolean) => void }[] = [];
  get queued(): number { return this.waiting.length; }
  acquire(job: Job): Promise<boolean> {
    if (job.stopped) return Promise.resolve(false);
    if (this.active < MAX_PARALLEL_OBSERVATIONS) { this.take(); return Promise.resolve(true); }
    return new Promise(grant => {
      const waiter = { job, grant };
      this.waiting.push(waiter);
      job.onStop(() => { const at = this.waiting.indexOf(waiter); if (at >= 0) { this.waiting.splice(at, 1); grant(false); } });
    });
  }
  release(): void {
    this.active -= 1;
    while (this.active < MAX_PARALLEL_OBSERVATIONS && this.waiting.length) {
      const next = this.waiting.shift()!;
      if (next.job.stopped) { next.grant(false); continue; }
      this.take(); next.grant(true);
    }
  }
  private take(): void { this.active += 1; this.peak = Math.max(this.peak, this.active); }
}

/** One observation's processes and its stop: it owns every git it starts until each one's group is gone. */
class Job {
  stopped = false;
  holdsSlot = false;
  /** The git this job runs, chosen once the workspace is known; null until then (nothing runs). */
  git: string | null = null;
  private readonly children: ChildProcess[] = [];
  private readonly stops: (() => void)[] = [];
  onStop(listener: () => void): void { if (this.stopped) listener(); else this.stops.push(listener); }
  /**
   * Settles when `work` does or, once the job is stopped, RELEASE_WAIT_MS later at the latest: a stopped job starts no
   * further process, so a file system call that never returns (a hung network mount) cannot hold its release for good.
   */
  ended(work: Promise<unknown>): Promise<void> {
    return new Promise(done => {
      let finished = false, timer: NodeJS.Timeout | undefined;
      const finish = () => { if (!finished) { finished = true; clearTimeout(timer); done(); } };
      void work.then(finish, finish);
      this.onStop(() => { if (!finished) timer = setTimeout(finish, RELEASE_WAIT_MS); });
    });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const child of this.children) if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ } }
    for (const listener of this.stops.splice(0)) listener();
  }
  /** Runs git with exactly `env`; the result is complete only when it ran to its end before the job stopped. */
  run(args: readonly string[], env: Readonly<Record<string, string>>, cwd: string, maxBytes: number, input?: Buffer): Promise<GitRun> {
    return new Promise(done => {
      const stopped: GitRun = { code: null, stdout: Buffer.alloc(0), stderr: "", overflow: false, failed: true };
      if (this.stopped || this.git === null) { done(stopped); return; }
      let child: ChildProcess;
      try { child = spawn(this.git, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true }); }
      catch { done(stopped); return; }
      this.children.push(child);
      const chunks: Buffer[] = [];
      let bytes = 0, overflow = false, stderr = "", settled = false, failed = false;
      const settle = (run: GitRun) => { if (!settled) { settled = true; done(run); } };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > maxBytes) { overflow = true; if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ } } return; }
        chunks.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8", 0, Math.min(chunk.length, MAX_STDERR_BYTES)); });
      child.on("error", () => { failed = true; if (child.pid === undefined) settle(stopped); });
      child.on("close", code => settle({ code, stdout: Buffer.concat(chunks), stderr, overflow, failed: failed || this.stopped }));
      this.onStop(() => settle(stopped));
      if (input !== undefined) { child.stdin!.on("error", () => { /* git may close its input early; its exit decides. */ }); child.stdin!.end(input); }
    });
  }
  /** Waits until each started process exited and its group is empty, killing what is left, for at most 3 s each. */
  async drain(): Promise<"released" | "unconfirmed"> {
    let confirmed = true;
    for (const child of this.children) {
      const pid = child.pid;
      if (pid === undefined) continue;
      const deadline = performance.now() + RELEASE_WAIT_MS;
      if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(exited => child.once("exit", exited)), delay(RELEASE_WAIT_MS)]);
      let gone = await groupGone(pid);
      while (!gone && performance.now() < deadline) { try { process.kill(-pid, "SIGKILL"); } catch { /* Gone meanwhile. */ } await delay(10); gone = await groupGone(pid); }
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      if (!gone) confirmed = false;
    }
    return confirmed ? "released" : "unconfirmed";
  }
}

class Observer implements WorkspaceObserver {
  private closed = false;
  private closing: Promise<void> | null = null;
  private unconfirmed = 0;
  private readonly slots = new Slots();
  private readonly jobs = new Set<Job>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly gits = new Map<string, string | null>();
  private readonly drivers = new Map<string, DriverCache>();
  private readonly reuse = new Map<string, ReuseEntry>();
  constructor(private readonly setup: Setup) {}

  stats(): WorkspaceObserverStats { return { active: this.slots.active, queued: this.slots.queued, peakActive: this.slots.peak, unconfirmed: this.unconfirmed }; }

  async observe(workspace: string): Promise<ObservationOutcome> {
    const spelled = boundedAbsolute(workspace, "workspace");
    if (this.closed) throw new SessionError("OBSERVER_CLOSED", "the workspace observer is closed");
    const started = performance.now(), job = new Job();
    this.jobs.add(job);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; job.stop(); }, this.setup.timeoutMs);
    const expiry = new Promise<Result>(done => job.onStop(() => done(unavailable(timedOut ? "timeout" : "error"))));
    const work = this.run(job, spelled, started).catch((): Result => unavailable("error"));
    // Owned from the start, so close() waits for this job even while its result is still on the way. Never rejects.
    const released = job.ended(work).then(() => job.drain()).catch((): "unconfirmed" => "unconfirmed").then(outcome => {
      if (outcome === "unconfirmed") this.unconfirmed += 1;
      if (job.holdsSlot) this.slots.release();
      this.jobs.delete(job);
      return outcome;
    });
    this.pending.add(released);
    void released.finally(() => this.pending.delete(released));
    const result = await Promise.race([work, expiry]);
    clearTimeout(timer);
    return { observation: result.observation, reused: result.reused, released };
  }

  close(): Promise<void> {
    if (this.closing === null) {
      this.closed = true;
      for (const job of this.jobs) job.stop();
      this.closing = Promise.all([...this.pending]).then(() => { this.gits.clear(); this.drivers.clear(); this.reuse.clear(); });
    }
    return this.closing;
  }

  /** The observation itself, inside a slot; every early answer is given before any process starts. */
  private async run(job: Job, spelled: string, started: number): Promise<Result> {
    if (!await this.slots.acquire(job)) return unavailable("timeout");
    job.holdsSlot = true;
    let workspace: string, own: string;
    try {
      workspace = await canonicalDirectory(spelled);
      if (!(await lstat(workspace)).isDirectory()) return unavailable("no_workspace");
      own = await identity(workspace);
    } catch (error) { return unavailable(["ENOENT", "ENOTDIR"].includes(String(errorCode(error))) ? "no_workspace" : "error"); }
    if (workspace === "/") return unavailable("root_is_fs");
    if (this.setup.homeLine.has(own)) return unavailable("root_is_home");
    if (await this.holdsData(workspace, own)) return unavailable("data_root_in_workspace");
    if (within(this.setup.privateHome, workspace)) return unavailable("error");
    job.git = this.gitFor(workspace);
    if (job.git === null) return unavailable("error");
    return this.observeGit(job, workspace, started);
  }

  /** Whether the data directory and the workspace contain one another, by identity along their parents (§10.1). */
  private async holdsData(workspace: string, own: string): Promise<boolean> {
    if (this.setup.dataLine.has(own) || within(this.setup.dataSpelled, workspace)) return true;
    try { const marker = await lstat(join(workspace, DATA_MARKER)); if (marker.isFile()) return true; } catch { /* No marker. */ }
    if (this.setup.dataIdentity === null) return within(workspace, this.setup.dataSpelled);
    for (let current = workspace; ; current = dirname(current)) {
      try { if (await identity(current) === this.setup.dataIdentity) return true; } catch { /* Unreadable part. */ }
      if (dirname(current) === current) return false;
    }
  }

  /** The first git recorded at creation whose PATH entry and realpath both lie outside the workspace. */
  private gitFor(workspace: string): string | null {
    if (this.gits.has(workspace)) return this.gits.get(workspace)!;
    const git = this.setup.candidates.find(item => !within(item.entry, workspace) && !within(item.git, workspace))?.git ?? null;
    remember(this.gits, workspace, git);
    return git;
  }

  /** The exact whitelist of §10.6, plus the config entries; nothing of the Hub's own environment. */
  private environment(workspace: string, entries: readonly (readonly [string, string])[]): Record<string, string> {
    const env: Record<string, string> = {
      HOME: this.setup.privateHome, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: dirname(workspace), GIT_CONFIG_COUNT: String(entries.length),
    };
    entries.forEach(([key, value], index) => { env["GIT_CONFIG_KEY_" + index] = key; env["GIT_CONFIG_VALUE_" + index] = value; });
    return env;
  }

  private async observeGit(job: Job, workspace: string, started: number): Promise<Result> {
    const base = this.environment(workspace, HARDENING), standard = join(workspace, ".git");
    const configKey = await configSignature(standard), cached = configKey === null ? undefined : this.drivers.get(workspace);
    const fromCache = cached !== undefined && cached.key === configKey;
    const [revision, listed] = await Promise.all([
      job.run(["--no-pager", "-C", workspace, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-object-format", "--verify", "-q", "HEAD"], base, workspace, MAX_CONFIG_LIST_BYTES),
      fromCache ? Promise.resolve(null) : job.run(["--no-pager", "-C", workspace, "config", "--list", "-z", "--show-origin"], base, workspace, MAX_CONFIG_LIST_BYTES),
    ]);
    if (job.stopped || revision.failed) return unavailable(job.stopped ? "timeout" : "error");
    if (revision.code === 128 && /not a git repository/u.test(revision.stderr)) return this.observeTree(job, workspace, started, false);
    if (revision.code !== 0 && revision.code !== 1) return unavailable("error");
    const lines = revision.stdout.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const [toplevel, gitdirLine, commonLine, format, headLine] = lines;
    if (toplevel === undefined || gitdirLine === undefined || commonLine === undefined || format === undefined || lines.length !== (revision.code === 0 ? 5 : 4)) return unavailable("error");
    if (format !== "sha1" && format !== "sha256") return unavailable("error");
    const head = revision.code === 0 ? headLine ?? null : null;
    if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) return unavailable("error");
    const gitdir = resolve(workspace, gitdirLine), commondir = resolve(workspace, commonLine);
    if (toplevel !== workspace || !await insideWithoutLinks(workspace, gitdir) || !await insideWithoutLinks(workspace, commondir)) return unavailable("gitdir_outside");
    let read: readonly string[] | null;
    if (gitdir === standard && commondir === standard && fromCache) read = cached.drivers;
    else {
      const run = listed ?? await job.run(["--no-pager", "-C", workspace, "config", "--list", "-z", "--show-origin"], base, workspace, MAX_CONFIG_LIST_BYTES);
      if (job.stopped) return unavailable("timeout");
      read = driverNames(run, workspace, gitdir, commondir);
      // Cached only for the usual layout and only when the config did not change while it was read.
      if (gitdir === standard && commondir === standard && configKey !== null && await configSignature(standard) === configKey) remember(this.drivers, workspace, { key: configKey, drivers: read });
    }
    if (read === null) return this.observeTree(job, workspace, started, true);
    const drivers = read;
    const index = join(gitdir, "index"), indexBefore = await mtimeOf(index), headFile = await smallFile(join(gitdir, "HEAD"));
    const reuseKey = JSON.stringify([head, headFile, indexBefore, drivers]), prior = this.reuse.get(workspace);
    if (prior !== undefined && prior.key === reuseKey && this.setup.now() - prior.at <= REUSE_WINDOW_MS) return { observation: prior.observation, reused: true };
    if (job.stopped) return unavailable("timeout");
    const env = this.environment(workspace, [...HARDENING, ...drivers.flatMap(name => [[`filter.${name}.clean`, ""], [`filter.${name}.smudge`, ""], [`filter.${name}.process`, ""], [`filter.${name}.required`, "false"]] as const)]);
    const attrSource = "--attr-source=" + EMPTY_TREE[format];
    const [status, diff] = await Promise.all([
      job.run(["--no-pager", attrSource, "-C", workspace, "status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "--untracked-files=normal", "--ignore-submodules=all", "--", "."], env, workspace, MAX_GIT_OUTPUT_BYTES),
      job.run(["--no-pager", attrSource, "-C", workspace, "diff", "--numstat", "-z", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--", "."], env, workspace, MAX_GIT_OUTPUT_BYTES),
    ]);
    if (job.stopped) return unavailable("timeout");
    if (status.failed || diff.failed || status.overflow || diff.overflow || status.code !== 0 || diff.code !== 0) return unavailable("error");
    const parsed = parseStatus(status.stdout), counts = parseNumstat(diff.stdout);
    if (parsed === null || counts === null) return unavailable("error");
    let partial = parsed.dropped;
    const entries: { path: string; change: GitFile["change"]; from: string | null }[] = [];
    for (const entry of parsed.entries) {
      if (entry.path === ".tmp" || entry.path.startsWith(".tmp/")) continue;
      if (entry.change === "untracked" && entry.path.endsWith("/") && await holdsMarker(workspace, entry.path)) continue;
      entries.push(entry);
    }
    entries.sort((a, b) => (a.change === "untracked" ? 1 : 0) - (b.change === "untracked" ? 1 : 0) || compare(a.path, b.path));
    const listedEntries = entries.slice(0, MAX_LISTED_FILES), tracked = listedEntries.filter(entry => entry.change !== "untracked").map(entry => entry.path);
    let lfs = new Set<string>();
    if (tracked.length) {
      const attributes = await job.run(["--no-pager", "-C", workspace, "check-attr", "-z", "--stdin", "filter"], env, workspace, MAX_GIT_OUTPUT_BYTES, Buffer.from(tracked.join("\0") + "\0"));
      if (job.stopped) return unavailable("timeout");
      const found = attributes.code === 0 && !attributes.failed && !attributes.overflow ? lfsPaths(attributes.stdout) : null;
      if (found === null) partial = true; else lfs = found;
    }
    if (await mtimeOf(index) !== indexBefore) partial = true;
    const files: GitFile[] = listedEntries.map(entry => {
      const isLfs = lfs.has(entry.path), count = isLfs ? undefined : counts.get(entry.path);
      return { path: entry.path, change: entry.change, added: count?.added ?? null, removed: count?.removed ?? null,
        credentialPath: namesCredentialFile(entry.path) || (entry.from !== null && namesCredentialFile(entry.from)), lfs: isLfs };
    });
    if (entries.length > files.length) partial = true;
    const observation: WorkspaceObservation = {
      kind: "git", status: partial ? "partial" : "complete", branch: parsed.branch, head: parsed.head,
      fingerprint: fingerprint(["git/1", format, parsed.head, parsed.branch, entries.map(entry => [entry.path, entry.change, entry.from, counts.get(entry.path)?.added ?? null, counts.get(entry.path)?.removed ?? null])]),
      durationMs: elapsed(started), files, counted: { total: entries.length, listed: files.length }, neutralized: drivers,
      attributesIncluded: await nonEmptyFile(join(commondir, "info", "attributes")),
    };
    if (!job.stopped && (await mtimeOf(index)) === indexBefore) remember(this.reuse, workspace, { key: reuseKey, at: this.setup.now(), observation });
    return { observation, reused: false };
  }

  /**
   * A bounded listing of a workspace that git does not read: breadth first, each directory's entries in name order, never
   * following a link, so the first MAX_TREE_ENTRIES entries are the same ones every time. Directories are read a few ahead
   * and lstat runs a bounded number at a time, so the thread pool stays busy without crowding out the Hub's other I/O.
   */
  private async observeTree(job: Job, workspace: string, started: number, fallback: boolean): Promise<Result> {
    const found: TreeFile[] = [], queue: string[] = [""], ahead = new Map<string, Promise<DirectoryRead>>(), batches: Promise<void>[] = [];
    let scanned = 0, partial = fallback, capped = false, next = 0;
    // Callbacks rather than a promise per file: a promise per file costs more than the lstat itself.
    const statAll = (paths: readonly string[]): Promise<void> => new Promise(done => {
      let left = paths.length;
      for (const path of paths) lstatCallback(workspace + "/" + path, (error, info) => {
        if (error) partial = true; else found.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        if (--left === 0) done();
      });
    });
    try {
      while (next < queue.length && !capped) {
        if (job.stopped) return unavailable("timeout");
        for (let index = next; index < Math.min(queue.length, next + TREE_READ_AHEAD); index++) if (!ahead.has(queue[index]!)) ahead.set(queue[index]!, readDirectory(workspace, queue[index]!));
        const relative = queue[next++]!, read = await ahead.get(relative)!;
        ahead.delete(relative);
        if (!read.ok) { partial = true; continue; }
        let names = read.names;
        if (scanned + names.length > MAX_TREE_ENTRIES) { names = names.slice(0, MAX_TREE_ENTRIES - scanned); capped = true; partial = true; }
        scanned += names.length;
        if (read.marker) continue;
        const leaves: string[] = [];
        for (const { name, directory } of [...names].sort((a, b) => compare(a.name, b.name))) {
          if (name === ".git" || (!relative && name === ".tmp")) continue;
          const path = relative ? relative + "/" + name : name;
          if (directory) queue.push(path); else leaves.push(path);
        }
        for (let index = 0; index < leaves.length; index += TREE_STAT_BATCH) {
          batches.push(statAll(leaves.slice(index, index + TREE_STAT_BATCH)));
          while (batches.length > TREE_STAT_BATCHES) await batches.shift();
        }
      }
    } finally {
      // Reads and lstat calls already started finish before the listing is given back: the job owns them like processes.
      await Promise.all([...ahead.values(), ...batches]);
    }
    if (job.stopped) return unavailable("timeout");
    const byPath = [...found].sort((a, b) => compare(a.path, b.path));
    const files = [...found].sort((a, b) => b.mtimeMs - a.mtimeMs || compare(a.path, b.path)).slice(0, MAX_LISTED_FILES);
    if (found.length > files.length) partial = true;
    return { observation: { kind: "tree", status: partial ? "partial" : "complete", fingerprint: fingerprint(["tree/1", byPath.map(file => [file.path, file.size, file.mtimeMs])]),
      durationMs: elapsed(started), files, scanned, counted: found.length }, reused: false };
  }
}

interface DirectoryRead { readonly ok: boolean; readonly names: readonly { readonly name: string; readonly directory: boolean }[]; readonly marker: boolean }
/** Directories a tree observation reads ahead of the one it is listing; lstat calls go in batches, a few batches at a time. */
const TREE_READ_AHEAD = 8, TREE_STAT_BATCH = 256, TREE_STAT_BATCHES = 4, DIRECTORY_BUFFER = 1024;
/**
 * One directory's entries, at most MAX_TREE_ENTRIES, without following a link: it must be a directory before and after the
 * read, with the same identity, or what was read may lie outside the workspace and is not used. Never rejects.
 */
async function readDirectory(workspace: string, relative: string): Promise<DirectoryRead> {
  const at = relative ? join(workspace, relative) : workspace, names: { name: string; directory: boolean }[] = [];
  let marker = false;
  try {
    const before = await directoryIdentity(at), directory = await opendir(at, { bufferSize: DIRECTORY_BUFFER });
    try {
      // Each fill of DIRECTORY_BUFFER entries is read asynchronously; the rest of a fill comes from its buffer, which
      // readSync() hands out without a system call (only the end of a short last fill is confirmed synchronously).
      let fill = 0;
      for (let entry = await directory.read(); entry !== null && names.length < MAX_TREE_ENTRIES;) {
        if (entry.name === DATA_MARKER) marker = true;
        names.push({ name: entry.name, directory: entry.isDirectory() });
        entry = ++fill >= DIRECTORY_BUFFER ? (fill = 0, await directory.read()) : directory.readSync();
      }
    } finally { await directory.close(); }
    return await directoryIdentity(at) === before ? { ok: true, names, marker } : { ok: false, names: [], marker: false };
  } catch { return { ok: false, names: [], marker: false }; }
}

function elapsed(started: number): number { return Math.round((performance.now() - started) * 100) / 100; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
async function directoryIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error("not a directory");
  return info.dev + ":" + info.ino;
}
/** Whether `target` lies under `root` and no part of it below `root` is a link; `target` must be a directory. */
async function insideWithoutLinks(root: string, target: string): Promise<boolean> {
  if (!within(target, root) || target === root) return false;
  const parts = target.slice(root.length + 1).split("/");
  let current = root;
  try {
    for (const part of parts) {
      if (!part || part === "." || part === "..") return false;
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}
/** The identity of a usual `.git` directory's config files, or null when the layout is anything else. */
async function configSignature(gitdir: string): Promise<string | null> {
  try {
    const directory = await lstat(gitdir, { bigint: true });
    if (!directory.isDirectory()) return null;
    const config = await lstat(join(gitdir, "config"), { bigint: true });
    if (!config.isFile()) return null;
    let worktree = "absent";
    try {
      const info = await lstat(join(gitdir, "config.worktree"), { bigint: true });
      if (!info.isFile()) return null;
      worktree = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    } catch (error) { if (errorCode(error) !== "ENOENT") return null; }
    return [directory.dev, directory.ino, config.dev, config.ino, config.size, config.mtimeNs, config.ctimeNs, worktree].join(":");
  } catch { return null; }
}
async function mtimeOf(path: string): Promise<string> {
  try { const info = await lstat(path, { bigint: true }); return info.ino + ":" + info.mtimeNs; } catch { return "absent"; }
}
/** A small regular file read without following a link or blocking on a pipe; null when it is anything else. */
async function smallFile(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  } catch { return null; }
}
async function nonEmptyFile(path: string): Promise<boolean> { try { const info = await lstat(path); return info.isFile() && info.size > 0; } catch { return false; } }
async function holdsMarker(workspace: string, directory: string): Promise<boolean> { try { return (await lstat(join(workspace, directory, DATA_MARKER))).isFile(); } catch { return false; } }

/**
 * The filter driver names of `git config --list -z --show-origin`, or null when they cannot be neutralized by name: the
 * output was cut at 64 KiB or did not end cleanly, it includes another file (include.path, includeIf, or an origin other
 * than the repository's own config), a name does not match DRIVER_NAME, or there are more than MAX_FILTER_DRIVERS.
 */
function driverNames(run: GitRun, workspace: string, gitdir: string, commondir: string): readonly string[] | null {
  if (run.failed || run.overflow || run.code !== 0) return null;
  const tokens = run.stdout.toString("utf8").split("\0");
  if (tokens.pop() !== "" || tokens.length % 2) return null;
  const own = new Set([join(commondir, "config"), join(gitdir, "config.worktree")]), names = new Set<string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const origin = tokens[index]!, entry = tokens[index + 1]!, key = entry.split("\n", 1)[0]!;
    if (origin === "command line:") continue;
    if (!origin.startsWith("file:") || !own.has(resolve(workspace, origin.slice(5)))) return null;
    const lower = key.toLowerCase();
    if (lower === "include.path" || (lower.startsWith("includeif.") && lower.endsWith(".path"))) return null;
    if (!lower.startsWith("filter.")) continue;
    const rest = key.slice("filter.".length), last = rest.lastIndexOf(".");
    if (last < 0) continue;
    const name = rest.slice(0, last);
    if (!DRIVER_NAME.test(name)) return null;
    names.add(name);
  }
  return names.size > MAX_FILTER_DRIVERS ? null : [...names].sort(compare);
}

/** A path from git: relative, without empty, `.` or `..` parts (an untracked directory keeps its trailing slash). */
function safePath(path: string): boolean {
  if (!path || path.startsWith("/")) return false;
  const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  return parts.every(part => part !== "" && part !== "." && part !== "..");
}
function after(record: string, fields: number): string | null {
  let at = 0;
  for (let field = 0; field < fields; field++) { at = record.indexOf(" ", at); if (at < 0) return null; at += 1; }
  return record.slice(at);
}
function changeOf(xy: string): GitFile["change"] {
  if (xy[0] === "A") return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}
/** `status --porcelain=v2 -z --branch` records; null when one does not parse. Unsafe paths are dropped and noted. */
function parseStatus(output: Buffer): { readonly branch: string | null; readonly head: string | null; readonly entries: readonly { path: string; change: GitFile["change"]; from: string | null }[]; readonly dropped: boolean } | null {
  const records = output.toString("utf8").split("\0");
  if (records.pop() !== "") return null;
  let branch: string | null = null, head: string | null = null, dropped = false;
  const entries: { path: string; change: GitFile["change"]; from: string | null }[] = [];
  const add = (path: string | null, change: GitFile["change"], from: string | null) => {
    if (path === null) return false;
    if (safePath(path) && (from === null || safePath(from))) entries.push({ path, change, from }); else dropped = true;
    return true;
  };
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# branch.oid ")) { const value = record.slice(13); head = value === "(initial)" ? null : value; continue; }
    if (record.startsWith("# branch.head ")) { const value = record.slice(14); branch = value === "(detached)" ? null : value; continue; }
    if (record.startsWith("# ")) continue;
    const kind = record.slice(0, 2), xy = record.slice(2, 4);
    if (kind === "1 " && add(after(record, 8), changeOf(xy), null)) continue;
    if (kind === "2 ") {
      const from = records[++index];
      if (from !== undefined && add(after(record, 9), xy.includes("C") ? "added" : "renamed", from)) continue;
      return null;
    }
    if (kind === "u " && add(after(record, 10), "modified", null)) continue;
    if (kind === "? " && add(record.slice(2), "untracked", null)) continue;
    if (kind === "! ") continue;
    return null;
  }
  if (head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) return null;
  return { branch, head, entries, dropped };
}
/** `diff --numstat -z` by path (a rename by its new path); a binary file counts null. Null when a record does not parse. */
function parseNumstat(output: Buffer): Map<string, { readonly added: number | null; readonly removed: number | null }> | null {
  const records = output.toString("utf8").split("\0"), counts = new Map<string, { added: number | null; removed: number | null }>();
  if (records.pop() !== "") return null;
  for (let index = 0; index < records.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(records[index]!);
    if (match === null) return null;
    let path = match[3]!;
    if (path === "") { index += 2; path = records[index] ?? ""; if (!path) return null; }
    counts.set(path, { added: match[1] === "-" ? null : Number(match[1]), removed: match[2] === "-" ? null : Number(match[2]) });
  }
  return counts;
}
/** The paths `check-attr -z filter` names as LFS files; null when its output does not parse. */
function lfsPaths(output: Buffer): Set<string> | null {
  const tokens = output.toString("utf8").split("\0"), paths = new Set<string>();
  if (tokens.pop() !== "" || tokens.length % 3) return null;
  for (let index = 0; index < tokens.length; index += 3) if (tokens[index + 1] === "filter" && tokens[index + 2] === "lfs") paths.add(tokens[index]!);
  return paths;
}
