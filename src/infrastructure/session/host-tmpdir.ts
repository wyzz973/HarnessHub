import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, type Dirent, type Stats } from "node:fs";
import { access, link, lstat, mkdir, open, opendir, readdir, rename, rm, rmdir, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { HOST_BUDGET_BOUNDS } from "../../contracts/native-host.js";
import { SessionError } from "../../contracts/session.js";

/**
 * What a host class's TMPDIR is keyed by (ADR-056 §4.12): the canonical text of its launch class (the Harness, its entry
 * and everything it is started with but its installation, the workspace among them, so workspaces never share) and of its
 * installation (the entry's program files). Both can hold credentials: they stay in memory, and nothing on disk or in a log
 * carries them but as HMACs under the namespace's own key. An upgrade changes only `installation`: the directory stays,
 * emptied.
 */
export interface HostTmpdirIdentity { readonly launch: string; readonly installation: string }
/** One host's hold on its class's TMPDIR. */
export interface HostTmpdir {
  readonly path: string;
  /**
   * Hands the directory back once the host's process group is confirmed ended; idempotent. When no other host of the class
   * holds it, a directory over its limits is moved aside at once and removed in the background. Never rejects: what cannot
   * be removed is reported, never thrown.
   */
  release(): Promise<void>;
}
export interface HostTmpdirOptions {
  /** A class directory whose files take more on disk is emptied once its class has no live host (hostTmpdirMaxBytes). */
  readonly maxBytes: number;
  /** Likewise one holding more entries, which also bounds the walk on a Turn's close (hostTmpdirMaxEntries). */
  readonly maxEntries: number;
  /** A class directory unused this long is deleted by sweep() (hostTmpdirUnusedMs). */
  readonly unusedMs: number;
  /** How long close() waits for the background removal (hostTmpdirCloseWaitMs); the resolver's default when absent. */
  readonly closeWaitMs?: number;
  /** The data directory, which the namespace may neither contain nor lie in; absent where there is none to keep apart. */
  readonly dataRoot?: string;
  /** Receives what could not be removed or recorded: a class directory's name (an HMAC prefix) and the system's error code, never a path. */
  readonly report: (problem: string) => void;
}
/** The canonical texts are bounded like a process environment. */
const IDENTITY_BYTES = 1024 * 1024;
const MAC = /^[0-9a-f]{64}$/u, CLASS_DIRECTORY = /^[0-9a-f]{16}$/u, RECORD = /^([0-9a-f]{16})\.json$/u;
/** A record or key written aside before it is moved in, and a class directory moved aside to be removed. */
const PENDING = /^\.([0-9a-f]{16}|key)\.[0-9a-f-]{36}\.tmp$/u, TOMBSTONE = /^\.([0-9a-f]{16})\.[0-9a-f-]{36}\.trash$/u;
const KEY = ".key", KEY_BYTES = 32, LOCK = ".lock.sqlite";
/** A record is a few hundred bytes; anything larger is not one. */
const RECORD_BYTES = 1024;
/**
 * How long a host's start waits for a sweep that holds the namespace, looking again every LOCK_RETRY_MS without holding up
 * anything else: a sweep only renames and removes, at most SWEEP_LIMIT entries.
 */
const LOCK_WAIT_MS = 2_000, LOCK_RETRY_MS = 20;
/** A sweep changes at most this many entries (a class directory moved aside with its record counts once); the rest waits for the next start. */
const SWEEP_LIMIT = 256;
/** How often a held directory's record is written again, so a host that lives for days keeps its directory in use. */
const REFRESH_MS = 60 * 60_000;
/** Directories listed at once while counting a class directory. */
const WALK_CHUNK = 64;
/** Entries of one directory removed at once; the system's thread pool bounds what actually runs, and no descriptor is held. */
const REMOVE_CONCURRENCY = 16;
/**
 * Live hosts per class directory in this process, whatever instance handed the directory out (two compositions may use one
 * namespace), and the turn each directory's preparation and release take one after another.
 */
const holders = new Map<string, number>();
const turns = new Map<string, Promise<void>>();
/**
 * The namespace lock this process holds shared while it has any live host there: a sweep needs it exclusively, so it never
 * runs while a host of any Gateway sharing the namespace is live. One connection per namespace, taken once for every host
 * that waits for it; SQLite keeps the locks of its connections in one process apart.
 */
const shared = new Map<string, { ready: Promise<void>; database: DatabaseSync | null; count: number }>();
function exclusive<T>(path: string, task: () => Promise<T>): Promise<T> {
  const next = (turns.get(path) ?? Promise.resolve()).then(task);
  const tail = next.then(() => {}, () => {});
  turns.set(path, tail);
  void tail.then(() => { if (turns.get(path) === tail) turns.delete(path); });
  return next;
}
function code(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message.slice(0, 120) : "unknown failure";
}
function busy(error: unknown): boolean { return error instanceof Error && /database is (?:locked|busy)/u.test(error.message); }
/** A missing entry is no failure while removing: another Gateway may be removing the same directory. */
function missing(error: unknown): void { if (code(error) !== "ENOENT") throw error; }
/** A directory that still holds something (POSIX allows either code). */
function notEmpty(error: unknown): boolean { return code(error) === "ENOTEMPTY" || code(error) === "EEXIST"; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
const FAILED = "宿主的私有临时目录不可用：它是符号链接、权限被放宽、不可写，或与数据目录互相包含。这个 Harness 的回合没有发出；HarnessHub 不会跟随链接或改动这个目录，删除它后会重新建立（服务日志写明了目录名）。";
const BUSY = "宿主的私有临时目录正被另一个 HarnessHub 服务启动时的清扫占用，2 秒内没有等到它结束。这个 Harness 的回合没有发出，目录没有改动，稍后重试即可。";
/** Owned by the current user, a real directory, and closed to everyone else. */
function isPrivate(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}
/** The space a file takes on disk: its allocated blocks where the system reports them, its length otherwise. */
function allocated(info: Stats): number { return typeof info.blocks === "number" && info.blocks >= 0 ? info.blocks * 512 : info.size; }
/**
 * The namespace's lock database, created 0600 when missing; refused when it is a link, not a file, someone else's or open to
 * others. It is created with O_EXCL, which opens nothing when it exists: a descriptor of this process opened and closed
 * beside SQLite's would drop the locks the process holds on it. It never waits for a lock: who waits retries.
 */
function lockDatabase(root: string): DatabaseSync {
  const path = join(root, LOCK);
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); } catch (error) { if (code(error) !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new SessionError("HOST_TMPDIR_FAILED", "the namespace's lock is not a private file");
  return new DatabaseSync(path, { timeout: 0 });
}
/**
 * A connection holding the namespace lock shared: a read transaction keeps it until it ends. While a sweep holds the lock
 * exclusively, the read is refused at once and tried again every LOCK_RETRY_MS, so the event loop goes on meanwhile; after
 * LOCK_WAIT_MS it rejects with HOST_TMPDIR_BUSY.
 */
async function lockShared(root: string): Promise<DatabaseSync> {
  const database = lockDatabase(root);
  try {
    for (const end = performance.now() + LOCK_WAIT_MS; ;) {
      database.exec("BEGIN");
      try { database.prepare("SELECT count(*) FROM sqlite_master").get(); return database; }
      catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        if (!busy(error)) throw error;
      }
      if (performance.now() >= end) throw new SessionError("HOST_TMPDIR_BUSY", "a sweep held the namespace lock for over " + LOCK_WAIT_MS + " ms");
      await delay(LOCK_RETRY_MS);
    }
  } catch (error) { try { database.close(); } catch { /* the failure stands */ } throw error; }
}
/** Holds the namespace lock shared for one more live host of this process; rejects as lockShared() does, holding nothing then. */
async function holdShared(root: string): Promise<void> {
  let held = shared.get(root);
  if (held === undefined) {
    const entry: { ready: Promise<void>; database: DatabaseSync | null; count: number } = { ready: Promise.resolve(), database: null, count: 0 };
    // A failure leaves the map at once, so the next host tries again instead of meeting it.
    entry.ready = lockShared(root).then(database => { entry.database = database; }, (error: unknown) => { if (shared.get(root) === entry) shared.delete(root); throw error; });
    shared.set(root, entry);
    held = entry;
  }
  held.count++;
  try { await held.ready; } catch (error) { held.count--; throw error; }
}
function dropShared(root: string): void {
  const held = shared.get(root);
  if (held === undefined || --held.count > 0) return;
  shared.delete(root);
  if (held.database === null) return;
  try { held.database.exec("COMMIT"); } finally { held.database.close(); }
}
/**
 * Removes `path` and everything under it without following links (a link is removed, never what it names), stopping at its
 * next step once `stopped()` says so; resolves with whether all of it went. What can be removed is removed; then it rejects
 * with the first failure other than a missing entry (another Gateway may be removing the same directory). Each directory is
 * listed in one call and its entries removed REMOVE_CONCURRENCY at a time; no descriptor stays open between calls.
 */
async function removeTree(path: string, stopped: () => boolean): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (stopped()) return false;
    // readdir follows a link, so `path` is checked first: one that became a link since it was listed is removed as a link.
    const self = await lstat(path).catch((error: unknown) => { if (code(error) === "ENOENT") return null; throw error; });
    if (self === null) return true;
    if (!self.isDirectory()) { await unlink(path).catch(missing); return true; }
    let entries: readonly Dirent[];
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (code(error) === "ENOENT") return true; throw error; }
    let failure: unknown = null;
    for (let start = 0; start < entries.length; start += REMOVE_CONCURRENCY) {
      if (stopped()) return false;
      const done = await Promise.all(entries.slice(start, start + REMOVE_CONCURRENCY).map(async entry => {
        const child = join(path, entry.name);
        try {
          if (!entry.isDirectory()) { await unlink(child).catch(missing); return true; }
          // An empty directory goes in one step; one holding something is emptied first.
          try { await rmdir(child); return true; } catch (error) { if (code(error) === "ENOENT") return true; if (!notEmpty(error)) throw error; }
          return await removeTree(child, stopped);
        } catch (error) { failure ??= error; return true; }
      }));
      if (done.includes(false)) return false;
    }
    if (failure !== null) throw failure;
    // What a program still running wrote meanwhile is listed again, twice at most.
    try { await rmdir(path); return true; }
    catch (error) { if (code(error) === "ENOENT") return true; if (!notEmpty(error) || attempt >= 2) throw error; }
  }
}
/**
 * What a class directory holds, counted until either limit is passed: its entries (files, directories and links together;
 * links are counted, never followed) and the disk space its files take. The listings run a few dozen at once and share one
 * count, so the walk stops at the first entry past `maxEntries` and never counts more than `maxEntries + 1`; `over` says
 * whether a limit was passed. A directory that cannot be listed counts as empty, and `failed` receives the error when it
 * is `path` itself. Never rejects.
 */
export async function measureTree(path: string, limits: { readonly maxBytes: number; readonly maxEntries: number }, failed: (error: unknown) => void = () => {}): Promise<{ readonly entries: number; readonly bytes: number; readonly over: boolean }> {
  let bytes = 0, entries = 0;
  const list = async (directory: string): Promise<readonly { readonly path: string; readonly directory: boolean; readonly file: boolean }[]> => {
    const found: { path: string; directory: boolean; file: boolean }[] = [];
    try {
      for await (const entry of await opendir(directory)) {
        if (entries > limits.maxEntries) break;
        entries++;
        found.push({ path: join(directory, entry.name), directory: entry.isDirectory(), file: entry.isFile() });
      }
    } catch (error) { if (directory === path) failed(error); }
    return found;
  };
  for (let level = [path]; level.length;) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += WALK_CHUNK) {
      const files: string[] = [];
      for (const listing of await Promise.all(level.slice(start, start + WALK_CHUNK).map(list)))
        for (const entry of listing) { if (entry.directory) next.push(entry.path); else if (entry.file) files.push(entry.path); }
      if (entries > limits.maxEntries) return { entries, bytes, over: true };
      for (const info of await Promise.all(files.map(file => lstat(file).catch(() => null)))) {
        if (info === null) continue;
        bytes += allocated(info);
        if (bytes > limits.maxBytes) return { entries, bytes, over: true };
      }
    }
    level = next;
  }
  return { entries, bytes, over: false };
}
/** The default namespace: `harnesshub-hosts-<uid>` in the system's temporary directory. */
export function defaultHostTmpdirRoot(): string {
  if (process.getuid === undefined) throw new SessionError("UNSUPPORTED_PLATFORM", "host temporary directories require the current POSIX owner host");
  return join(tmpdir(), "harnesshub-hosts-" + process.getuid());
}
/**
 * Every host class's private TMPDIR under one namespace (ADR-056 §4.12): `<root>/<16 hex digits of an HMAC of its launch>/`,
 * 0700, beside a record of its installation and its last use. Directories are created, emptied and deleted here only;
 * links are never followed, and a directory that is a link, someone else's or open to others is refused, never repaired.
 * Emptying moves a directory aside under a tombstone name (one rename); one background worker of this instance removes what
 * was moved aside, one directory after another, until close().
 *
 * Who may empty what: a Turn prepares and hands back its class's directory under its workspace lease, so in the Gateways
 * sharing that lease namespace no other host of the class is live then; and every live host keeps the namespace lock
 * shared, which sweep() needs exclusively, so a sweep never meets a live host or a host being prepared. Nothing is read or
 * created before first use: a namespace that cannot be reached fails the Turns that need it, not the Hub's start.
 */
export class HostTmpdirs {
  private readonly dataRoot: string | null;
  private readonly closeWaitMs: number;
  private resolved: string | null = null;
  private key: Buffer | null = null;
  /** What was moved aside and is still to be removed, oldest first; the worker removes the first. */
  private readonly queue: { readonly name: string; readonly path: string }[] = [];
  private worker: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly requested: string, private readonly options: HostTmpdirOptions) {
    if (typeof requested !== "string" || !isAbsolute(requested) || normalize(requested) !== requested || requested.length > 1024 || /[\0\r\n]/u.test(requested) || basename(requested) === "")
      throw new SessionError("INVALID_INPUT", "the host TMPDIR namespace must be a normalized absolute path");
    this.closeWaitMs = options.closeWaitMs ?? HOST_BUDGET_BOUNDS.hostTmpdirCloseWaitMs.fallback;
    for (const value of [options.maxBytes, options.maxEntries, options.unusedMs, this.closeWaitMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new SessionError("INVALID_INPUT", "host TMPDIR limits must be positive whole numbers");
    if (options.dataRoot !== undefined && !isAbsolute(options.dataRoot)) throw new SessionError("INVALID_INPUT", "the data directory must be absolute");
    this.dataRoot = options.dataRoot ?? null;
  }
  /** The namespace spelled without links (its parent's real path), the prefix every TMPDIR is given; read once. */
  private get root(): string { return this.resolved ??= join(realpathSync(dirname(this.requested)), basename(this.requested)); }
  /**
   * The Hub's start. Queues for removal what earlier emptying left aside. Then, holding the namespace lock exclusively (so
   * only while no host of any Gateway sharing the namespace is live; otherwise it sweeps nothing this time), moves aside
   * class directories unused for longer than `unusedMs`, with their records, and removes records left without a directory
   * and writes that never finished: at most SWEEP_LIMIT changes, the rest at the next start. Entries that are not this
   * user's class directories are left as they are. Synchronous apart from the background removal (settle() awaits it);
   * never throws, and reports what it could not remove. Returns how many class directories went.
   */
  sweep(): number {
    let root: string, info: Stats;
    try { root = this.root; info = lstatSync(root); } catch (error) { if (code(error) !== "ENOENT") this.options.report("namespace: " + code(error)); return 0; }
    if (!isPrivate(info)) { this.options.report("namespace: not a private directory, left as it is"); return 0; }
    let names: string[];
    try { names = readdirSync(root); } catch (error) { this.options.report("namespace: " + code(error)); return 0; }
    // What was moved aside belongs to no host any more.
    for (const name of names) { const tombstone = TOMBSTONE.exec(name); if (tombstone !== null) this.removeLater(tombstone[1]!, join(root, name)); }
    let lock: DatabaseSync | null;
    try {
      lock = lockDatabase(root);
      try { lock.exec("BEGIN EXCLUSIVE"); } catch (error) { lock.close(); lock = null; if (!busy(error)) throw error; }
    } catch (error) { this.options.report("namespace: " + code(error)); return 0; }
    if (lock === null) return 0;
    let removed = 0, changed = 0;
    try {
      const now = Date.now(), present = new Set(names);
      for (const name of names) {
        // The lock is held exclusively while this runs, and a host's start waits for it: a bounded sweep keeps that short.
        if (changed >= SWEEP_LIMIT) { this.options.report("namespace: the sweep stopped after " + SWEEP_LIMIT + " changes; the rest waits for the next start"); break; }
        const path = join(root, name), written = RECORD.exec(name) ?? PENDING.exec(name);
        try {
          if (CLASS_DIRECTORY.test(name)) {
            const directory = lstatSync(path);
            if (!isPrivate(directory) || holders.has(path)) continue;
            let used = directory.mtimeMs;
            try { const record = lstatSync(join(root, name + ".json")); if (record.isFile()) used = Math.max(used, record.mtimeMs); } catch { /* no record: the directory's own time */ }
            if (now - used <= this.options.unusedMs) continue;
            const tombstone = join(root, "." + name + "." + randomUUID() + ".trash");
            renameSync(path, tombstone); rmSync(join(root, name + ".json"), { force: true }); removed++; changed++;
            this.removeLater(name, tombstone);
          } else if (written !== null) {
            const file = lstatSync(path);
            if (file.isFile() && (RECORD.test(name) ? !present.has(written[1]!) : now - file.mtimeMs > this.options.unusedMs)) { rmSync(path, { force: true }); changed++; }
          }
        } catch (error) {
          // Gone meanwhile (a record that went with its directory above, or another Gateway's doing) is no problem.
          if (code(error) !== "ENOENT") this.options.report((written?.[1] ?? name.slice(0, 16)) + ": " + code(error));
        }
      }
    } finally { try { lock.exec("COMMIT"); } catch { /* closing ends it */ } lock.close(); }
    return removed;
  }
  /**
   * Resolves once everything this instance moved aside is removed or reported; after close(), once the removal has
   * stopped. Never rejects.
   */
  async settle(): Promise<void> { while (this.worker !== null) await this.worker; }
  /**
   * The end of this instance's background removal, for a service's shutdown: waits up to `closeWaitMs` for what was moved
   * aside to be removed, then stops the removal at its next step. What is left is reported once and stays for the next
   * start's sweep; what is moved aside afterwards stays too. Idempotent; never rejects. Directories handed out stay usable.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, this.closeWaitMs); });
      try { await Promise.race([this.settle(), expired]); } finally { clearTimeout(timer); }
      this.stopped = true;
      await this.settle();
      if (this.queue.length > 0) this.options.report("namespace: " + this.queue.length + " moved aside left for the next start's sweep");
    })();
    return this.closing;
  }
  /**
   * The class's directory for a host about to start, which its caller must hold the class's workspace lease for. Creates
   * the namespace and the directory 0700 when missing and keeps the namespace lock shared until release() (waiting up to
   * 2 s for a sweep that holds it, without holding up anything else). When no other host of the class holds it, a directory
   * whose record names another installation (or none) is replaced by an empty one before it is handed out. Rejects before
   * any program starts, with nothing followed, emptied or changed: with HOST_TMPDIR_BUSY when a sweep still holds the
   * namespace after 2 s, and with HOST_TMPDIR_FAILED when the namespace, its key or lock, or the directory is a link, not
   * what it should be, someone else's, open to others or not writable, or when the namespace and the data directory
   * contain one another.
   */
  async acquire(identity: HostTmpdirIdentity): Promise<HostTmpdir> {
    if (typeof identity.launch !== "string" || typeof identity.installation !== "string" || !identity.launch || !identity.installation
      || Buffer.byteLength(identity.launch) > IDENTITY_BYTES || Buffer.byteLength(identity.installation) > IDENTITY_BYTES) throw new SessionError("INVALID_INPUT", "invalid host TMPDIR identity");
    const refused = (label: string, error: unknown): never => {
      this.options.report(label + ": " + (error instanceof SessionError ? error.message : code(error)));
      // Waiting for another Gateway's sweep is no fault of the directory: it says so, in its own words.
      if (error instanceof SessionError && error.code === "HOST_TMPDIR_BUSY") throw new SessionError("HOST_TMPDIR_BUSY", BUSY);
      throw new SessionError("HOST_TMPDIR_FAILED", FAILED);
    };
    let root: string;
    try { root = this.root; this.separate(); await this.privateDirectory(root); await holdShared(root); } catch (error) { return refused("namespace", error); }
    let macs: { readonly launch: string; readonly installation: string }, name: string, path: string;
    try {
      const key = await this.keyed(root);
      macs = { launch: createHmac("sha256", key).update("launch\0").update(identity.launch).digest("hex"),
        installation: createHmac("sha256", key).update("installation\0").update(identity.installation).digest("hex") };
      name = macs.launch.slice(0, 16); path = join(root, name);
    } catch (error) { this.unhold(root); return refused("namespace", error); }
    try {
      await exclusive(path, async () => {
        let created: boolean;
        try { created = await this.privateDirectory(path); await access(path, constants.W_OK | constants.X_OK); } catch (error) { return refused(name, error); }
        const held = holders.get(path) ?? 0;
        if (held === 0 && !created) {
          const recorded = await this.recorded(root, name);
          // Another installation's (or an unknown) content: replaced by an empty directory, with the old one removed later.
          if ((recorded === null || recorded.launch !== macs.launch || recorded.installation !== macs.installation) && await this.discard(root, name, path))
            try { await this.privateDirectory(path); } catch (error) { return refused(name, error); }
        }
        holders.set(path, held + 1);
        await this.record(root, name, macs);
      });
    } catch (error) { this.unhold(root); throw error; }
    // A host that lives for days (a kept process) keeps its directory in use without a new start.
    const refresh = setInterval(() => { void this.record(root, name, macs); }, REFRESH_MS);
    refresh.unref();
    let released = false;
    return { path, release: async () => {
      if (released) return;
      released = true; clearInterval(refresh);
      try {
        await exclusive(path, async () => {
          const held = (holders.get(path) ?? 1) - 1;
          if (held > 0) holders.set(path, held); else holders.delete(path);
          await this.record(root, name, macs);
          if (held === 0 && await this.oversized(name, path)) await this.discard(root, name, path);
        });
      } catch (error) { this.options.report(name + ": " + code(error)); }
      finally { this.unhold(root); }
    } };
  }
  /** Lets the namespace lock go for one host; what cannot be ended is reported (closing the connection ends it anyway). */
  private unhold(root: string): void { try { dropShared(root); } catch (error) { this.options.report("namespace: " + code(error)); } }
  /** Creates `path` 0700 when missing; refuses a link, a non-directory, someone else's or one open to others. Resolves with whether it was created. */
  private async privateDirectory(path: string): Promise<boolean> {
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; } catch (error) { if (code(error) !== "EEXIST") throw error; }
    if (!isPrivate(await lstat(path))) throw new SessionError("HOST_TMPDIR_FAILED", "not a private directory");
    return created;
  }
  /**
   * Refuses a namespace inside the data directory, or one holding it, compared by device and inode along each one's parents
   * (never by spelling); before the namespace exists, by its parent.
   */
  private separate(): void {
    if (this.dataRoot === null) return;
    const identity = (path: string) => { const info = statSync(path, { bigint: true }); return info.dev + ":" + info.ino; };
    const within = (path: string, ancestor: string): boolean => {
      for (let current = path; ; current = dirname(current)) { if (identity(current) === ancestor) return true; if (dirname(current) === current) return false; }
    };
    const data = realpathSync(this.dataRoot);
    let root: string | null = null;
    try { root = identity(this.root); } catch (error) { if (code(error) !== "ENOENT") throw error; }
    if (within(root === null ? dirname(this.root) : this.root, identity(data)) || root !== null && within(data, root))
      throw new SessionError("HOST_TMPDIR_FAILED", "the namespace and the data directory contain one another");
  }
  /**
   * The namespace's HMAC key: 32 random bytes in `.key`, 0600, made once by whichever Gateway first needs it (written aside
   * and linked in, so nobody reads half of one); refused when it is a link, someone else's, open to others or not 32 bytes.
   */
  private async keyed(root: string): Promise<Buffer> {
    if (this.key !== null) return this.key;
    const path = join(root, KEY);
    for (let attempt = 0; ; attempt++) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat(), bytes = info.isFile() && info.size === KEY_BYTES ? await handle.readFile() : null;
        if (bytes === null || bytes.length !== KEY_BYTES || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new SessionError("HOST_TMPDIR_FAILED", "the namespace's key is not a private 32-byte file");
        return this.key = bytes;
      } catch (error) { if (code(error) !== "ENOENT" || attempt > 0) throw error; }
      finally { await handle?.close(); }
      const pending = join(root, ".key." + randomUUID() + ".tmp");
      await writeFile(pending, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
      try { await link(pending, path); } catch (error) { if (code(error) !== "EEXIST") throw error; } finally { await unlink(pending).catch(() => {}); }
    }
  }
  /** Moves the directory aside under a tombstone name and queues that for removal; resolves with whether it moved. */
  private async discard(root: string, name: string, path: string): Promise<boolean> {
    const tombstone = join(root, "." + name + "." + randomUUID() + ".trash");
    try { await rename(path, tombstone); } catch (error) { this.options.report(name + ": it could not be emptied (" + code(error) + ")"); return false; }
    this.removeLater(name, tombstone);
    return true;
  }
  /** Queues a tombstone for the background removal; another Gateway's sweep may be removing it too. */
  private removeLater(name: string, tombstone: string): void {
    this.queue.push({ name, path: tombstone });
    this.kick();
  }
  /** Starts the worker unless it runs, close() stopped it, or nothing is queued. */
  private kick(): void {
    if (this.worker !== null || this.stopped || this.queue.length === 0) return;
    this.worker = this.drain().finally(() => { this.worker = null; this.kick(); });
  }
  /** Removes the queued tombstones one after another until none is left or close() stops it; reports what cannot be removed. Never rejects. */
  private async drain(): Promise<void> {
    for (let item = this.queue[0]; item !== undefined && !this.stopped; item = this.queue[0]) {
      let done = true;
      try { done = await removeTree(item.path, () => this.stopped); }
      catch (error) { this.options.report(item.name + ": what it held could not all be removed (" + code(error) + ")"); }
      // Stopped half-way, it stays queued: close() counts it, and the next start's sweep finishes it.
      if (!done) return;
      this.queue.shift();
    }
  }
  /** Whether the directory's files take more than maxBytes on disk, or it holds more than maxEntries entries (measureTree). */
  private async oversized(name: string, path: string): Promise<boolean> {
    return (await measureTree(path, this.options, error => { this.options.report(name + ": " + code(error)); })).over;
  }
  /** The directory's record: the HMACs it was last handed out for, or null when there is none or it is not one. */
  private async recorded(root: string, name: string): Promise<{ readonly launch: string; readonly installation: string } | null> {
    let handle: FileHandle;
    try { handle = await open(join(root, name + ".json"), constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > RECORD_BYTES) return null;
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const row = value as Record<string, unknown>;
      return row.version === 1 && typeof row.launch === "string" && MAC.test(row.launch) && typeof row.installation === "string" && MAC.test(row.installation)
        ? { launch: row.launch, installation: row.installation } : null;
    } catch { return null; } finally { await handle.close(); }
  }
  /** Writes the record anew, so its time is the directory's last use; a failure is reported (the next start then empties the directory). */
  private async record(root: string, name: string, macs: { readonly launch: string; readonly installation: string }): Promise<void> {
    const pending = join(root, "." + name + "." + randomUUID() + ".tmp");
    try {
      await writeFile(pending, JSON.stringify({ version: 1, launch: macs.launch, installation: macs.installation }) + "\n", { flag: "wx", mode: 0o600 });
      await rename(pending, join(root, name + ".json"));
    } catch (error) {
      await rm(pending, { force: true }).catch(() => {});
      this.options.report(name + ": its record could not be written (" + code(error) + ")");
    }
  }
}
