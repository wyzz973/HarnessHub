import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionError, sessionId, type SessionId, type WorkspaceLease, type WorkspaceLeaseProvider } from "../../contracts/session.js";

interface FileIdentity { readonly dev: string; readonly ino: string }
interface State { readonly held: boolean; readonly token: string | null; readonly session: string | null }
// SQLite's POSIX locks are process-scoped: opening/closing another FD to the
// same file could release existing locks. Refuse same-process contenders before
// touching the file. Other processes contend on SQLite's OS lock.
// The conversations of one provider (one Gateway) are not contenders: they share the lease it holds
// (see `SharedWorkspaceLease`); only another provider in this process, or another process, is refused.
const active = new Set<string>();

function absolute(path: string, label: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) {
    throw new SessionError("INVALID_INPUT", `${label} must be a bounded absolute path`);
  }
}
function identity(path: string, directory: boolean): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1n)) {
    throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace lease path is not the original regular file or directory");
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function matches(path: string, expected: FileIdentity, directory: boolean): void {
  const actual = identity(path, directory);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace lease path identity changed");
}
/** Creates/pins a regular file without following links; closes before SQLite opens it. */
function createFile(path: string): FileIdentity {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { return identity(path, false); } finally { closeSync(fd); }
}
function busy(error: unknown): boolean {
  return error instanceof Error && (error.message.includes("database is locked") || error.message.includes("database is busy"));
}
function failure(error: unknown): SessionError {
  if (error instanceof SessionError) return error;
  return new SessionError(busy(error) ? "WORKSPACE_BUSY" : "WORKSPACE_STORAGE", busy(error) ? "another owner holds the workspace lease" : "workspace lease storage failed");
}
function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}
function readState(db: DatabaseSync, workspace: string): State {
  const info = db.prepare("SELECT version, workspace FROM workspace_info WHERE id = 1").get();
  if (info?.version !== 1 || info.workspace !== workspace) throw new SessionError("WORKSPACE_STORAGE", "unsupported workspace lease state");
  const row = db.prepare("SELECT held, token, session, run FROM workspace_state WHERE id = 1").get();
  if (!row || (row.held !== 0 && row.held !== 1)) throw new SessionError("WORKSPACE_STORAGE", "invalid workspace lease state");
  if (row.held === 0) {
    if (row.token !== null || row.session !== null || row.run !== null) throw new SessionError("WORKSPACE_STORAGE", "invalid idle workspace lease state");
    return { held: false, token: null, session: null };
  }
  if (typeof row.token !== "string" || row.token.length === 0 || typeof row.session !== "string" || typeof row.run !== "string" || row.run.length === 0) {
    throw new SessionError("WORKSPACE_STORAGE", "invalid held workspace lease state");
  }
  sessionId(row.session);
  return { held: true, token: row.token, session: row.session };
}
function configure(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL;");
  const mode = db.prepare("PRAGMA journal_mode = DELETE").get();
  if (mode?.journal_mode !== "delete") throw new SessionError("WORKSPACE_STORAGE", "workspace lease requires rollback journal mode");
}
function closeDatabase(db: DatabaseSync | undefined): void {
  if (!db) return;
  if (db.isTransaction) db.exec("ROLLBACK");
  db.close();
}

/**
 * A host-local workspace writer lease, independent of the public Session data
 * root. All gateway instances must use the same application-owned lockRoot.
 * A durable held record survives owner death and prevents automatic takeover.
 */
export class SqliteWorkspaceLeaseProvider implements WorkspaceLeaseProvider {
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  /** The leases this provider holds, by workspace: a second conversation of the same Gateway in a workspace joins the one lease. */
  private readonly shared = new Map<string, SharedWorkspaceLease>();
  constructor(lockRoot: string) {
    absolute(lockRoot, "workspace lock root");
    try {
      mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
      identity(lockRoot, true);
      this.root = realpathSync(lockRoot);
      this.rootIdentity = identity(this.root, true);
    } catch (error) { throw failure(error); }
  }
  /** The lock root, spelled without links: the providers given it exclude each other. */
  get namespace(): string { return this.root; }

  /**
   * Resolves workspace aliases before deriving the stable key. Never waits for
   * another owner, uses PID/TTL takeover, or clears a previous held record.
   * Every conversation of one Gateway may work in a workspace at once (2026-11-12: the Hub does not queue them, it tells the later
   * Turn who else is there): its second and later holders join the lease the first took, which is released with the last of them.
   * Only another Gateway, in this process or another, is a contender and is refused.
   */
  acquire(workspace: string, session: SessionId, run: string): WorkspaceLease {
    absolute(workspace, "workspace");
    sessionId(session);
    if (typeof run !== "string" || run.length === 0 || run.length > 128 || run.includes("\0")) throw new SessionError("INVALID_INPUT", "invalid workspace lease run identity");
    let canonical: string;
    let workspaceIdentity: FileIdentity;
    try {
      canonical = realpathSync(workspace);
      workspaceIdentity = identity(canonical, true);
      matches(this.root, this.rootIdentity, true);
    } catch (error) {
      if (error instanceof SessionError && error.code === "WORKSPACE_OWNERSHIP_LOST") throw error;
      throw new SessionError("INVALID_INPUT", "workspace must name an existing directory");
    }
    const key = createHash("sha256").update(canonical).digest("hex");
    const lockPath = join(this.root, `${key}.lock.sqlite`);
    const statePath = join(this.root, `${key}.state.sqlite`);
    const joined = this.shared.get(lockPath);
    if (joined !== undefined) return joined.join();
    if (active.has(lockPath)) throw new SessionError("WORKSPACE_BUSY", "another owner holds the workspace lease");
    let lockDb: DatabaseSync | undefined;
    let stateDb: DatabaseSync | undefined;
    let lockIdentity: FileIdentity;
    let stateIdentity: FileIdentity;
    try {
      lockIdentity = createFile(lockPath);
      lockDb = new DatabaseSync(lockPath, { timeout: 0 });
      configure(lockDb);
      lockDb.exec("BEGIN EXCLUSIVE");
      matches(lockPath, lockIdentity, false);
      if (!tableExists(lockDb, "workspace_lock")) {
        if (lockDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) throw new SessionError("WORKSPACE_STORAGE", "unrecognized workspace lease database");
        stateIdentity = createFile(statePath);
        stateDb = new DatabaseSync(statePath, { timeout: 0 });
        configure(stateDb);
        if (!tableExists(stateDb, "workspace_info")) {
          if (stateDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) throw new SessionError("WORKSPACE_STORAGE", "unrecognized workspace state database");
          stateDb.exec("BEGIN IMMEDIATE; CREATE TABLE workspace_info (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, workspace TEXT NOT NULL); CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), held INTEGER NOT NULL CHECK(held IN (0,1)), token TEXT, session TEXT, run TEXT);");
          stateDb.prepare("INSERT INTO workspace_info VALUES (1, 1, ?)").run(canonical);
          stateDb.exec("INSERT INTO workspace_state VALUES (1, 0, NULL, NULL, NULL); COMMIT;");
        }
        readState(stateDb, canonical);
        lockDb.exec("CREATE TABLE workspace_lock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, workspace TEXT NOT NULL, state_dev TEXT NOT NULL, state_ino TEXT NOT NULL)");
        lockDb.prepare("INSERT INTO workspace_lock VALUES (1, 1, ?, ?, ?)").run(canonical, stateIdentity.dev, stateIdentity.ino);
        // Persist immutable identity before establishing the lasting lease. A
        // contender may win this gap; then this acquire fails without dispatch.
        lockDb.exec("COMMIT; BEGIN EXCLUSIVE;");
      } else {
        const marker = lockDb.prepare("SELECT version, workspace, state_dev, state_ino FROM workspace_lock WHERE id = 1").get();
        if (marker?.version !== 1 || marker.workspace !== canonical || typeof marker.state_dev !== "string" || typeof marker.state_ino !== "string") throw new SessionError("WORKSPACE_STORAGE", "unsupported workspace lease database");
        stateIdentity = { dev: marker.state_dev, ino: marker.state_ino };
        matches(statePath, stateIdentity, false);
        stateDb = new DatabaseSync(statePath, { timeout: 0 });
        configure(stateDb);
      }
      matches(this.root, this.rootIdentity, true);
      matches(canonical, workspaceIdentity, true);
      matches(lockPath, lockIdentity, false);
      matches(statePath, stateIdentity, false);
      if (readState(stateDb, canonical).held) throw new SessionError("WORKSPACE_QUARANTINED", "workspace has an unresolved previous writer");
      const token = randomUUID();
      stateDb.exec("BEGIN IMMEDIATE");
      stateDb.prepare("UPDATE workspace_state SET held = 1, token = ?, session = ?, run = ? WHERE id = 1 AND held = 0").run(token, session, run);
      stateDb.exec("COMMIT");
      active.add(lockPath);
      const shared = new SharedWorkspaceLease(new SqliteWorkspaceLease(lockDb, stateDb, token, canonical, workspaceIdentity, this.root, this.rootIdentity, lockPath, lockIdentity, statePath, stateIdentity), () => { this.shared.delete(lockPath); });
      this.shared.set(lockPath, shared);
      return shared.join();
    } catch (error) {
      let cleanupError: unknown;
      try { closeDatabase(stateDb); } catch (closeError) { cleanupError = closeError; }
      try { closeDatabase(lockDb); } catch (closeError) { cleanupError ??= closeError; }
      if (cleanupError) throw new SessionError("WORKSPACE_STORAGE", "workspace acquire failed and storage cleanup failed");
      throw failure(error);
    }
  }

  /**
   * Clears the held record an ended owner left for `session`, after the caller confirmed that the processes it guarded are
   * gone (ADR-030: a kept process group the restarted owner ended). It takes the OS lock like acquire, so a live holder
   * makes it return false, as does a record naming another Session or no held record. It never infers the end itself;
   * every other held record stays a quarantine.
   */
  releaseAbandoned(workspace: string, session: SessionId): boolean {
    absolute(workspace, "workspace"); sessionId(session);
    let canonical: string;
    try { canonical = realpathSync(workspace); identity(canonical, true); matches(this.root, this.rootIdentity, true); }
    catch (error) { if (error instanceof SessionError && error.code === "WORKSPACE_OWNERSHIP_LOST") throw error; return false; }
    const key = createHash("sha256").update(canonical).digest("hex");
    const lockPath = join(this.root, `${key}.lock.sqlite`), statePath = join(this.root, `${key}.state.sqlite`);
    if (active.has(lockPath)) return false;
    let lockDb: DatabaseSync | undefined, stateDb: DatabaseSync | undefined;
    try {
      let lockIdentity: FileIdentity;
      try { lockIdentity = identity(lockPath, false); } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
      lockDb = new DatabaseSync(lockPath, { timeout: 0 }); configure(lockDb);
      try { lockDb.exec("BEGIN EXCLUSIVE"); } catch (error) { if (busy(error)) return false; throw error; }
      matches(lockPath, lockIdentity, false);
      if (!tableExists(lockDb, "workspace_lock")) return false;
      const marker = lockDb.prepare("SELECT version, workspace, state_dev, state_ino FROM workspace_lock WHERE id = 1").get();
      if (marker?.version !== 1 || marker.workspace !== canonical || typeof marker.state_dev !== "string" || typeof marker.state_ino !== "string") throw new SessionError("WORKSPACE_STORAGE", "unsupported workspace lease database");
      matches(statePath, { dev: marker.state_dev, ino: marker.state_ino }, false);
      stateDb = new DatabaseSync(statePath, { timeout: 0 }); configure(stateDb);
      const state = readState(stateDb, canonical);
      if (!state.held || state.session !== session) return false;
      stateDb.exec("BEGIN IMMEDIATE");
      const result = stateDb.prepare("UPDATE workspace_state SET held = 0, token = NULL, session = NULL, run = NULL WHERE id = 1 AND held = 1 AND session = ?").run(session);
      stateDb.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { if (busy(error)) return false; throw failure(error); }
    finally {
      let cleanupError: unknown;
      try { closeDatabase(stateDb); } catch (closeError) { cleanupError = closeError; }
      try { closeDatabase(lockDb); } catch (closeError) { cleanupError ??= closeError; }
      if (cleanupError) throw new SessionError("WORKSPACE_STORAGE", "abandoned lease release could not close its storage");
    }
  }
}

/**
 * One workspace lease held for several conversations of one Gateway. `join()` hands each holder its own handle; the lease is
 * released when the last handle is, and quiescent only if every handle was released with its program confirmed ended (one that was
 * not keeps the workspace quarantined, as it would have alone). Ownership is the lease's: a handle is owned while the lease is.
 */
class SharedWorkspaceLease {
  private holders = 0;
  private quiescent = true;
  private released = false;
  constructor(private readonly lease: SqliteWorkspaceLease, private readonly done: () => void) {}
  join(): WorkspaceLease {
    this.lease.assertOwned();
    this.holders += 1;
    return new LeaseHandle(this);
  }
  assertOwned(): void { this.lease.assertOwned(); }
  /** One holder lets go; the last releases the lease itself, quiescent only if every holder was. */
  let(quiescent: boolean): void {
    this.holders -= 1; this.quiescent &&= quiescent;
    if (this.holders > 0 || this.released) return;
    this.released = true; this.done();
    this.lease.release(this.quiescent);
  }
}
/** One conversation's hold on a shared lease. */
class LeaseHandle implements WorkspaceLease {
  private open = true;
  constructor(private readonly shared: SharedWorkspaceLease) {}
  assertOwned(): void {
    if (!this.open) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace lease is closed");
    this.shared.assertOwned();
  }
  release(quiescent: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.shared.let(quiescent);
  }
}

class SqliteWorkspaceLease implements WorkspaceLease {
  private closed = false;
  constructor(
    private readonly lockDb: DatabaseSync,
    private readonly stateDb: DatabaseSync,
    private readonly token: string,
    private readonly workspace: string,
    private readonly workspaceIdentity: FileIdentity,
    private readonly root: string,
    private readonly rootIdentity: FileIdentity,
    private readonly lockPath: string,
    private readonly lockIdentity: FileIdentity,
    private readonly statePath: string,
    private readonly stateIdentity: FileIdentity,
  ) {}

  assertOwned(): void {
    if (this.closed) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace lease is closed");
    try {
      matches(this.root, this.rootIdentity, true);
      matches(this.workspace, this.workspaceIdentity, true);
      matches(this.lockPath, this.lockIdentity, false);
      matches(this.statePath, this.stateIdentity, false);
      if (!this.lockDb.isTransaction) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace SQLite lock transaction was lost");
      const marker = this.lockDb.prepare("SELECT version, workspace, state_dev, state_ino FROM workspace_lock WHERE id = 1").get();
      if (marker?.version !== 1 || marker.workspace !== this.workspace || marker.state_dev !== this.stateIdentity.dev || marker.state_ino !== this.stateIdentity.ino) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace lock identity changed");
      const state = readState(this.stateDb, this.workspace);
      if (!state.held || state.token !== this.token) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace owner token changed");
    } catch (error) {
      if (error instanceof SessionError && error.code === "WORKSPACE_OWNERSHIP_LOST") throw error;
      throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace lease ownership cannot be confirmed");
    }
  }

  /**
   * quiescent=true is the caller's confirmed shutdown evidence. Clear durable
   * state before releasing the OS lock; false keeps it quarantined. A lost lease
   * always closes its own handles and never clears potentially foreign state.
   */
  release(quiescent: boolean): void {
    if (this.closed) return;
    let error: unknown;
    try {
      this.assertOwned();
      if (quiescent) {
        this.stateDb.exec("BEGIN IMMEDIATE");
        const result = this.stateDb.prepare("UPDATE workspace_state SET held = 0, token = NULL, session = NULL, run = NULL WHERE id = 1 AND held = 1 AND token = ?").run(this.token);
        if (result.changes !== 1) throw new SessionError("WORKSPACE_OWNERSHIP_LOST", "workspace owner token changed");
        this.stateDb.exec("COMMIT");
      }
    } catch (releaseError) { error = releaseError; }
    try { closeDatabase(this.stateDb); } catch (closeError) { error ??= closeError; }
    try { closeDatabase(this.lockDb); } catch (closeError) { error ??= closeError; }
    this.closed = true;
    active.delete(this.lockPath);
    if (error) throw failure(error);
  }
}
