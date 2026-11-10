import { constants, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SessionError, commandId, sessionId,
  type CommandId, type EventDraft, type SessionCommit, type SessionEvent, type SessionId,
  type SessionMutation, type SessionSnapshot, type SessionStore,
} from "../../contracts/session.js";
import type { ConsentAppend, ConsentRecord, DeliveryRecord, RecoverRelay, RelayCommitResult, RelayIndexRow, RelayLogPort, RelayPacket, RelayPrefKey, RelayStorePort, RelayWindow, RelayWriteResult, RelayWriteRows } from "../../contracts/relay.js";
import { MAX_EVENT_BYTES, MAX_EVENT_LOG_BYTES, MAX_READ_BYTES, MAX_READ_ITEMS, MAX_SESSION_BYTES, MAX_SESSION_EVENTS, assertSessionTransition, parseSession, recoverSession, utf8Bytes } from "../../contexts/session/domain/state.js";
import { migrateSession, type MigrationEvent } from "../../contexts/session/domain/relay/migrate.js";
import { MAX_SNAPSHOT_CACHE_BYTES, SnapshotCache, type SnapshotCacheStats } from "./snapshot-cache.js";
import { RELAY_DDL, checkPacketReferences, checkRelayRows, checkRelayWrite, deleteRelayRows, diagnosticOf, pruneRelayWindows, readDeliveries, readIndexRows, readPackets, relayRowCounts, upsertRelayWindow, writeBehindIndexes, writeDerivedRows, writeRelayRows, writeRelayWrite } from "./relay-tables.js";
import { appendConsent, currentConsents, readPrefs, writePref } from "./relay-log.js";

const activeRoots = new Set<string>();
/** The business database version this build owns (Session v13, ADR-055 §14.4); 1–12 are migrated to it. */
const CURRENT_VERSION = 13;
/** The relay part of recovery until G068 provides it: nothing to recover (no Turn writes relay rows before G068). */
const NO_RELAY_RECOVERY: RecoverRelay = () => null;
/** How many relayWrite failures the Store keeps for diagnostics. */
const RELAY_DIAGNOSTICS = 32;
interface FileIdentity { readonly dev: string; readonly ino: string }
interface OwnerRow { readonly generation: number; readonly pid: number; readonly token: string; readonly active: boolean }
function sameFile(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function pathIdentity(path: string, directory = false): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new SessionError("INVALID_STORAGE", "storage path is not a regular owned " + (directory ? "directory" : "file"));
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function initializeFile(path: string): FileIdentity {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new SessionError("INVALID_STORAGE", "database must be a regular file without additional hard links");
    return { dev: stat.dev.toString(), ino: stat.ino.toString() };
  } finally { closeSync(descriptor); }
}
function initializeRoot(root: string): { readonly root: string; readonly markerPath: string; readonly markerIdentity: FileIdentity } {
  mkdirSync(root, { recursive: true, mode: 0o700 }); pathIdentity(root, true);
  const canonical = realpathSync(root), markerPath = join(canonical, ".harness-gateway.json");
  const names = readdirSync(canonical);
  if (!existsSync(markerPath)) {
    if (names.length !== 0) throw new SessionError("INVALID_STORAGE", "nonempty data root has no HarnessGateway ownership marker");
    const descriptor = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }) + "\n"); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  }
  return inspectRoot(canonical);
}
function inspectRoot(root: string): { readonly root: string; readonly markerPath: string; readonly markerIdentity: FileIdentity } {
  if (!isAbsolute(root) || root.includes("\0") || utf8Bytes(root) > 4096) throw new SessionError("INVALID_INPUT", "data root must be a bounded absolute path");
  pathIdentity(root, true);
  const canonical = realpathSync(root), markerPath = join(canonical, ".harness-gateway.json");
  const markerIdentity = pathIdentity(markerPath), markerStat = lstatSync(markerPath);
  if (markerStat.size > 4096 || markerStat.nlink !== 1) throw new SessionError("INVALID_STORAGE", "invalid HarnessGateway ownership marker");
  let value: unknown;
  try { value = JSON.parse(readFileSync(markerPath, "utf8")); } catch { throw new SessionError("INVALID_STORAGE", "invalid HarnessGateway ownership marker JSON"); }
  const marker = object(value, "data root marker");
  if (Object.keys(marker).length !== 2 || marker.application !== "harness-gateway" || marker.schemaVersion !== 1) throw new SessionError("INVALID_STORAGE", "unrecognized HarnessGateway ownership marker");
  return { root: canonical, markerPath, markerIdentity };
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_DATA", label + " must be an object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new SessionError("INVALID_DATA", label + " must be a safe integer");
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SessionError("INVALID_DATA", label + " must be text"); return value;
}
function ownerRow(value: unknown): OwnerRow {
  const row = object(value, "owner metadata");
  if (row.owner_active !== 0 && row.owner_active !== 1) throw new SessionError("INVALID_DATA", "invalid owner activity marker");
  return { generation: integer(row.owner_generation, "owner generation"), pid: integer(row.owner_pid, "owner PID"),
    token: string(row.owner_token, "owner token"), active: row.owner_active === 1 };
}
function processMayBeAlive(pid: number): boolean {
  if (pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error === null || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; }
}
function jsonData(value: unknown, ancestors: Set<object>, depth: number, budget: { count: number }): void {
  if (++budget.count > 100000 || depth > 32) throw new SessionError("INVALID_DATA", "event JSON exceeds structural budget");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new SessionError("INVALID_DATA", "event must contain only acyclic JSON values");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new SessionError("INVALID_DATA", "event objects must be plain JSON objects");
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) jsonData(item, ancestors, depth + 1, budget);
  ancestors.delete(value);
}
function drafts(value: readonly EventDraft[]): readonly EventDraft[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SESSION_EVENTS) throw new SessionError("INVALID_DATA", "event write batch must be nonempty and bounded");
  return value.map(item => {
    const row = object(item, "event draft");
    if (Object.keys(row).some(key => key !== "type" && key !== "data") || typeof row.type !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/u.test(row.type)) throw new SessionError("INVALID_DATA", "invalid event draft type or fields");
    const data = object(row.data, "event data"); jsonData(data, new Set(), 0, { count: 0 });
    const serialized = JSON.stringify({ type: row.type, data });
    if (utf8Bytes(serialized) > MAX_EVENT_BYTES) throw new SessionError("EVENT_LIMIT", "event JSON byte limit reached");
    const copied: unknown = JSON.parse(serialized);
    const copy = object(copied, "copied event");
    return { type: string(copy.type, "event type"), data: object(copy.data, "event data") };
  });
}
function parseStoredEvent(value: unknown, expectedSession: SessionId): SessionEvent {
  const row = object(value, "persisted event");
  if (Object.keys(row).some(key => !["sessionId", "seq", "ownerGeneration", "timestamp", "type", "data"].includes(key))) throw new SessionError("INVALID_DATA", "unknown persisted event fields");
  const draft = drafts([{ type: string(row.type, "event type"), data: object(row.data, "event data") }])[0];
  if (!draft) throw new SessionError("INVALID_DATA", "missing persisted event");
  const id = sessionId(row.sessionId), timestamp = string(row.timestamp, "event timestamp");
  if (id !== expectedSession || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new SessionError("INVALID_DATA", "event identity or timestamp is inconsistent");
  return { ...draft, sessionId: id, seq: integer(row.seq, "event seq", 1), ownerGeneration: integer(row.ownerGeneration, "event owner generation", 1), timestamp };
}
function limitValue(value: number | undefined): number {
  const limit = value ?? MAX_READ_ITEMS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_ITEMS) throw new SessionError("INVALID_INPUT", "read limit must be between 1 and " + MAX_READ_ITEMS);
  return limit;
}
function sqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const row = object(error, "SQLite error"); return row.code === "ERR_SQLITE_ERROR" || typeof row.errcode === "number";
}
function storageFailure(error: unknown): SessionError {
  const failure = new SessionError("STORAGE_UNAVAILABLE", "SQLite operation failed; new dispatch is disabled"); failure.cause = error; return failure;
}
/** Migration backups in `<root>/backups` (ADR-049); only regular files named by these two patterns are HarnessHub's to remove. */
const BACKUPS_KEPT = 2;
const BACKUP_NAME = /^gateway-v\d+-(\d{8}T\d{6}Z)-[0-9a-f]{8}\.sqlite$/u;
const PARTIAL_BACKUP_NAME = /^gateway-v\d+-\d{8}T\d{6}Z-[0-9a-f]{8}\.sqlite\.partial$/u;
function errorCode(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? error.code : undefined; }
/** A failure's reason without paths: this file's own message, SQLite's generic error text or the system error code. */
function reason(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  if (!(error instanceof Error)) return "unknown failure";
  const row = object(error, "backup failure");
  return typeof row.errstr === "string" ? row.errstr : typeof row.code === "string" ? row.code : error.name;
}
function newestFirst(left: string, right: string): number { return left < right ? 1 : left > right ? -1 : 0; }
function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
/** Row counts a backup is read back against: sessions and events, and from v13 on the relay tables too (ADR-049). */
function rowCounts(database: DatabaseSync, version: number): Readonly<Record<string, number>> {
  const row = object(database.prepare("SELECT (SELECT count(*) FROM sessions) AS sessions,(SELECT count(*) FROM events) AS events").get(), "business row counts");
  return { sessions: integer(row.sessions, "Session row count"), events: integer(row.events, "event row count"), ...(version >= 13 ? relayRowCounts(database) : {}) };
}
/** The event types the v13 migration reads (ADR-055 §14.4); the others (outputs, tools, permissions) are skipped in SQLite. */
const MIGRATION_EVENTS = ["session.created", "session.recovered", "message.accepted", "run.context_prepared", "run.native_command", "run.ended", "native.binding_prepared", "native.branch_requested", "native.fork_failed"] as const;
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freeze(item); Object.freeze(value);
}
/**
 * Reads and validates one stored Session with its persisted UTF-8 byte size. `octet_length` gives the same count as
 * `length(CAST(snapshot AS BLOB))` for this UTF-8 database's TEXT column, without reading the value (SQLite 3.43+).
 */
function readStoredSession(database: DatabaseSync, id: SessionId): { readonly state: SessionSnapshot; readonly bytes: number } {
  const row = database.prepare("SELECT version,last_seq,octet_length(snapshot) AS bytes FROM sessions WHERE id=?").get(id);
  if (!row) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  const bytes = integer(row.bytes, "Session snapshot bytes");
  if (bytes > MAX_SESSION_BYTES) throw new SessionError("INVALID_DATA", "persisted Session byte budget exceeded");
  const payload = database.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id);
  const serialized = string(payload?.snapshot, "Session snapshot");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new SessionError("INVALID_DATA", "persisted Session is not valid JSON"); }
  const state = parseSession(value);
  const format = database.prepare("PRAGMA user_version").get();
  if (state.schemaVersion !== format?.user_version) throw new SessionError("INVALID_DATA", "Session schema and business database version disagree");
  if (state.id !== id || state.version !== row.version || state.lastSeq !== row.last_seq) throw new SessionError("INVALID_DATA", "persisted Session row and snapshot disagree");
  const log = database.prepare("SELECT COUNT(*) AS count,MIN(seq) AS first,MAX(seq) AS last FROM events WHERE session_id=?").get(id);
  if (log?.count !== state.lastSeq || (state.lastSeq > 0 && (log.first !== 1 || log.last !== state.lastSeq))) throw new SessionError("INVALID_DATA", "persisted Session and event cursor disagree");
  return { state, bytes };
}
function readSessionFrom(database: DatabaseSync, id: SessionId): SessionSnapshot { return readStoredSession(database, id).state; }
function readListFrom(database: DatabaseSync, maximum: number, read: (id: SessionId) => SessionSnapshot): readonly SessionSnapshot[] {
  const result: SessionSnapshot[] = []; let bytes = 0;
  for (const row of database.prepare("SELECT id,octet_length(snapshot) AS bytes FROM sessions ORDER BY rowid DESC LIMIT ?").iterate(maximum)) {
    const size = integer(row.bytes, "Session snapshot bytes");
    if (size > MAX_SESSION_BYTES) throw new SessionError("INVALID_DATA", "persisted Session byte budget exceeded");
    if (bytes + size > MAX_READ_BYTES) throw new SessionError("READ_LIMIT", "Session list exceeds its byte budget; request a smaller explicit limit");
    const state = read(sessionId(row.id));
    bytes += size; result.push(state);
  }
  return result;
}
/** One page of the events of the Session `state` read in the same operation. */
function readEventsFrom(database: DatabaseSync, state: SessionSnapshot, afterSeq: number, maximum: number): readonly SessionEvent[] {
  const id = state.id;
  if (afterSeq > state.lastSeq) throw new SessionError("INVALID_CURSOR", "event cursor is ahead of persistent history");
  const result: SessionEvent[] = []; let bytes = 0;
  for (const row of database.prepare("SELECT seq,owner_generation,length(CAST(event_json AS BLOB)) AS bytes FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?").iterate(id, afterSeq, maximum)) {
    const size = integer(row.bytes, "event JSON bytes");
    if (size > MAX_EVENT_BYTES) throw new SessionError("INVALID_DATA", "persisted event byte budget exceeded");
    if (bytes + size > MAX_READ_BYTES) throw new SessionError("READ_LIMIT", "event page exceeds its byte budget; request a smaller explicit limit");
    const payload = database.prepare("SELECT event_json FROM events WHERE session_id=? AND seq=?").get(id, integer(row.seq, "event row seq", 1));
    const serialized = string(payload?.event_json, "event JSON");
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { throw new SessionError("INVALID_DATA", "persisted event is not valid JSON"); }
    const event = parseStoredEvent(value, id);
    if (event.seq !== row.seq || event.ownerGeneration !== row.owner_generation || event.seq !== afterSeq + result.length + 1 || event.seq > state.lastSeq) throw new SessionError("INVALID_DATA", "persistent event sequence is inconsistent");
    bytes += size; result.push(event);
  }
  if (afterSeq < state.lastSeq && result.length === 0) throw new SessionError("INVALID_DATA", "persistent event history has a missing cursor");
  return result;
}

/**
 * Owns the data-root OS lock and synchronous aggregate transactions until close(). The snapshots it returns, read or
 * committed, are validated and deeply frozen: the readers of one version share one object from its cache (ADR-055 §11.2).
 */
export class SqliteSessionStore implements SessionStore, RelayStorePort, RelayLogPort {
  readonly ownerGeneration: number;
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly markerPath: string;
  private readonly markerIdentity: FileIdentity;
  private readonly ownerPath: string;
  private readonly ownerIdentity: FileIdentity;
  private readonly databasePath: string;
  private readonly databaseIdentity: FileIdentity;
  private readonly owner: DatabaseSync;
  private readonly database: DatabaseSync;
  private readonly token = randomUUID();
  private readonly now: () => Date;
  /** Validated snapshots by version and event log sizes (ADR-055 §11.2); owned here and closed by close(). */
  private readonly cache: SnapshotCache;
  /** PRAGMA data_version when the cache was last known to match the database; null before the first read. */
  private dataVersion: number | null = null;
  private closed = false;
  private failed: SessionError | null = null;
  /** The relay part of recovery, called per Session inside claimAndRecover's transaction (ADR-055 §9 S15). */
  private readonly recoverRelay: RecoverRelay;
  /** The latest relayWrite failures, newest last (ADR-055 §6.4: a derived row that cannot be written waits for next time). */
  private readonly relayFailures: string[] = [];

  /**
   * Opens `root` as its single owner: takes the OS lock (`owner.sqlite`), then in one transaction migrates a v1–v12 business
   * database to v13, advances the owner generation and recovers unfinished executions. A new database is made as v13. The
   * v12 → v13 step makes the relay tables, gives every native binding its relay state as its Session's events show it
   * (migrateSession, ADR-055 §14.4) and writes a behind digest index row for every finished dispatched Run; any failure rolls
   * the whole transaction back and leaves the database at its version, with the backup kept.
   *
   * Before such a migration, with the lock already held and before that transaction begins, the business database is copied
   * with VACUUM INTO to `backups/gateway-v<from>-<UTC yyyymmddThhmmssZ>-<8 hex>.sqlite` under the root (directory 0700, file
   * 0600, time from `now`). The copy is written as `<name>.partial`, read back (same user_version, as many sessions and events
   * rows and, from a v13 source on, as many rows in each relay table; quick_check ok) and synced before it takes its name.
   * Just before writing, every backup but the newest by the time in its name is removed, so two remain. A new (v0) or current
   * (v13) database is not copied, nor is one opened by SqliteSessionReader.
   *
   * Throws STORAGE_BACKUP_FAILED, with the cause kept, when any of that fails: nothing was migrated or claimed, the business
   * database's rows and version are as they were, the files this attempt wrote are removed and the lock is released.
   *
   * The backups belong to the user: HarnessHub never reads or restores them, removes only regular files named by its own two
   * patterns (older backups, and `.partial` files a crashed backup left) and leaves everything else in `backups` alone.
   *
   * `snapshotCacheBytes` is the byte budget of the snapshot cache this store owns (0 to MAX_SNAPSHOT_CACHE_BYTES, the
   * default); any other value throws INVALID_INPUT before the root is touched.
   *
   * `recoverRelay` is the relay part of recovery (G068's domain function; none by default): claimAndRecover calls it for
   * each Session recoverSession changes, inside a SAVEPOINT of that Session's own, and writes its delivery outcomes. When it
   * or those writes fail, only that Session's relay rows roll back: its recovery is committed without them, with
   * `relayRecoveryFailed` set to its `session.recovered` seq and `relay: { failed: true }` in that event.
   */
  constructor(root: string, options: { readonly now?: () => Date; readonly snapshotCacheBytes?: number; readonly recoverRelay?: RecoverRelay } = {}) {
    if (!isAbsolute(root) || root.includes("\0") || utf8Bytes(root) > 4096) throw new SessionError("INVALID_INPUT", "data root must be a bounded absolute path");
    this.now = options.now ?? (() => new Date());
    this.recoverRelay = options.recoverRelay ?? NO_RELAY_RECOVERY;
    this.cache = new SnapshotCache(options.snapshotCacheBytes ?? MAX_SNAPSHOT_CACHE_BYTES);
    const initialized = initializeRoot(root);
    this.root = initialized.root; this.rootIdentity = pathIdentity(this.root, true);
    this.markerPath = initialized.markerPath; this.markerIdentity = initialized.markerIdentity;
    this.ownerPath = join(this.root, "owner.sqlite");
    this.databasePath = join(this.root, "gateway.sqlite");
    if (activeRoots.has(this.root)) throw new SessionError("OWNER_BUSY", "this process already owns this data root");
    activeRoots.add(this.root);
    try {
      this.ownerIdentity = initializeFile(this.ownerPath);
      this.owner = new DatabaseSync(this.ownerPath, { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
    } catch (error) { activeRoots.delete(this.root); throw error instanceof SessionError ? error : storageFailure(error); }
    let database: DatabaseSync | null = null;
    try {
      this.owner.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE");
      if (!sameFile(this.ownerIdentity, pathIdentity(this.ownerPath))) throw new SessionError("OWNER_LOST", "owner lock path changed during acquisition");
      this.databaseIdentity = initializeFile(this.databasePath);
      database = new DatabaseSync(this.databasePath, { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
      this.database = database;
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      this.backupBeforeMigration();
      this.ownerGeneration = this.claimAndRecover();
    } catch (error) {
      if (database?.isOpen) database.close();
      if (this.owner.isOpen) this.owner.close();
      activeRoots.delete(this.root);
      if (sqliteError(error) && object(error, "SQLite error").errcode === 5) throw new SessionError("OWNER_BUSY", "another owner holds this data root");
      throw error instanceof SessionError ? error : storageFailure(error);
    }
  }

  assertOwner(): void {
    if (this.closed) throw new SessionError("STORE_CLOSED", "Session store is closed");
    if (this.failed) throw this.failed;
    try {
      this.assertPaths();
      const version = this.database.prepare("PRAGMA user_version").get();
      if (!version || version.user_version !== CURRENT_VERSION) throw new SessionError("OWNER_LOST", "business database schema no longer matches this owner");
      const metadata = this.readOwner();
      if (!metadata.active || metadata.generation !== this.ownerGeneration || metadata.token !== this.token || metadata.pid !== process.pid) throw new SessionError("OWNER_LOST", "persistent owner generation no longer belongs to this process");
    } catch (error) {
      // A lost owner keeps no snapshots: nothing reads them again, and their memory goes now rather than at close.
      this.cache.clear();
      this.failed = error instanceof SessionError && error.code === "OWNER_LOST" ? error : new SessionError("OWNER_LOST", "owner lock, path identity or generation could not be confirmed");
      if (this.failed !== error) this.failed.cause = error; throw this.failed;
    }
  }

  create(snapshot: SessionSnapshot, events: readonly EventDraft[]): SessionCommit {
    this.assertOwner();
    if (snapshot.schemaVersion !== CURRENT_VERSION || snapshot.version !== 0 || snapshot.lastSeq !== 0) throw new SessionError("INVALID_INPUT", "new Session must use schema v13 and start at version and cursor zero");
    const entries = drafts(events), next = parseSession({ ...snapshot, version: 1, lastSeq: entries.length });
    const create = next.commands.find(entry => entry.kind === "create");
    if (!create) throw new SessionError("INVALID_DATA", "Session create command is missing");
    let cached: { readonly bytes: number; readonly logBytes: number } | null = null;
    return this.transaction(() => {
      const prior = this.database.prepare("SELECT session_id, fingerprint FROM create_keys WHERE command_id=?").get(create.id);
      if (prior) {
        if (prior.fingerprint !== create.fingerprint) throw new SessionError("IDEMPOTENCY_CONFLICT", "create key already names another request");
        return { session: this.session(sessionId(prior.session_id)), events: [] };
      }
      if (this.database.prepare("SELECT id FROM sessions WHERE id=?").get(next.id)) throw new SessionError("SESSION_EXISTS", "Session identity already exists");
      const committed = this.commitEvents(next.id, 0, entries, this.ownerGeneration), serialized = JSON.stringify(next);
      this.database.prepare("INSERT INTO sessions(id,version,last_seq,snapshot) VALUES(?,?,?,?)").run(next.id, next.version, next.lastSeq, serialized);
      this.database.prepare("INSERT INTO create_keys(command_id,session_id,fingerprint) VALUES(?,?,?)").run(create.id, next.id, create.fingerprint);
      const logBytes = this.insertEvents(next.id, 0, committed);
      freeze(next); cached = { bytes: Buffer.byteLength(serialized, "utf8"), logBytes };
      return { session: next, events: committed };
    }, () => { if (cached !== null) this.cache.put(next, cached.bytes, cached.logBytes); });
  }

  get(id: SessionId): SessionSnapshot { this.assertOwner(); return this.read(() => this.session(sessionId(id))); }
  findByCreateKey(key: CommandId): SessionSnapshot | null {
    this.assertOwner(); commandId(key);
    return this.read(() => {
      const row = this.database.prepare("SELECT session_id FROM create_keys WHERE command_id=?").get(key);
      return row ? this.session(sessionId(row.session_id)) : null;
    });
  }
  /** Lists use cached snapshots but do not cache what they read, so a long list never pushes out the conversations in use. */
  list(limit?: number): readonly SessionSnapshot[] {
    this.assertOwner(); const maximum = limitValue(limit);
    return this.read(() => readListFrom(this.database, maximum, id => this.session(id, false)));
  }
  listKept(): readonly SessionSnapshot[] {
    this.assertOwner();
    return this.read(() => this.database.prepare("SELECT id FROM sessions WHERE json_extract(snapshot,'$.retained') IS NOT NULL ORDER BY rowid").all().map(row => this.session(sessionId(String(row.id)), false)));
  }
  /** A pending branch only refers to its source's native session; ready and unconfirmed references hold one. */
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId> {
    this.assertOwner();
    return this.read(() => {
      const owners = new Map<string, SessionId>();
      for (const row of this.database.prepare("SELECT s.id AS id, json_extract(b.value,'$.checkpoint') AS checkpoint FROM sessions s, json_each(s.snapshot,'$.nativeBindings') b " +
          "WHERE json_extract(b.value,'$.harnessId')=? AND json_extract(b.value,'$.controlId')=? AND json_extract(b.value,'$.status') IN ('ready','unconfirmed') ORDER BY s.rowid").iterate(harnessId, controlId)) {
        if (typeof row.checkpoint !== "string") throw new SessionError("INVALID_DATA", "persisted native reference is invalid");
        if (owners.has(row.checkpoint)) throw new SessionError("INVALID_DATA", "one native session is held by two Sessions");
        owners.set(row.checkpoint, sessionId(row.id));
      }
      return owners;
    });
  }
  /** Every content identity any Session references; the content collector must keep all of them. */
  contentReferences(): ReadonlySet<string> {
    this.assertOwner();
    return this.read(() => {
      const referenced = new Set<string>();
      for (const row of this.database.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
        const state = this.session(sessionId(row.id), false);
        for (const run of state.runs) {
          for (const tool of run.tools ?? []) if (tool.detail !== undefined) referenced.add(tool.detail.id);
          for (const output of run.outputs ?? []) if (output.kind === "content") referenced.add(output.content.id);
          for (const attachment of run.attachments ?? []) referenced.add(attachment.id);
        }
        // A branch quotes the attachments of the history it started from; they stay while the branch exists.
        for (const message of state.origin?.history ?? []) for (const attachment of message.attachments ?? []) referenced.add(attachment.id);
      }
      return referenced;
    });
  }
  /**
   * One aggregate transaction. With `relay` rows (v13) the same transaction writes them: authoritative rows are checked in
   * full before anything is written, so an expected relay failure throws a RelayError (RELAY_PREPARE_FAILED) and writes
   * nothing, never disabling the Store (INV-35); derived rows go into a SAVEPOINT and only report `behind` when they fail.
   * Every packet the next relay state names must be kept for the Session (INVALID_DATA otherwise).
   */
  transact(id: SessionId, expectedVersion: number, mutate: (current: SessionSnapshot) => SessionMutation): SessionCommit {
    this.assertOwner(); sessionId(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof mutate !== "function") throw new SessionError("INVALID_INPUT", "transaction requires a positive expected version and synchronous mutation");
    let cached: { readonly next: SessionSnapshot; readonly bytes: number; readonly logBytes: number } | null = null;
    return this.transaction(() => {
      // Deeply frozen: every reader of this version shares it, and the mutation cannot change it.
      const current = this.session(id);
      if (current.version !== expectedVersion) throw new SessionError("VERSION_CONFLICT", "Session version changed before the mutation");
      const mutation = mutate(current);
      if (mutation === null || typeof mutation !== "object" || "then" in mutation) throw new SessionError("INVALID_DATA", "Session mutation must be synchronous");
      if (mutation.relay !== undefined && (mutation.relay === null || typeof mutation.relay !== "object" || Array.isArray(mutation.relay))) throw new SessionError("INVALID_DATA", "relay rows must be an object");
      const entries = drafts(mutation.events);
      // Finished Runs the mutation kept as they were are not validated again (ADR-055 §11.2); every relation still is.
      const next = parseSession({ ...mutation.next, version: current.version + 1, lastSeq: current.lastSeq + entries.length }, current);
      if (next.id !== current.id) throw new SessionError("INVALID_DATA", "transaction cannot replace Session identity");
      const previousCreate = current.commands.find(entry => entry.kind === "create"), nextCreate = next.commands.find(entry => entry.kind === "create");
      if (!previousCreate || !nextCreate || JSON.stringify(previousCreate) !== JSON.stringify(nextCreate)) throw new SessionError("INVALID_DATA", "transaction cannot replace Session create identity");
      assertSessionTransition(current, next, entries);
      // Every relay check runs before the first statement that writes (INV-35).
      const relay = checkRelayRows(this.database, id, next, mutation.relay);
      const committed = this.commitEvents(id, current.lastSeq, entries, this.ownerGeneration), serialized = JSON.stringify(next);
      writeRelayRows(this.database, id, relay);
      checkPacketReferences(this.database, id, current, next);
      const updated = this.database.prepare("UPDATE sessions SET version=?,last_seq=?,snapshot=? WHERE id=? AND version=?").run(next.version, next.lastSeq, serialized, id, expectedVersion);
      if (updated.changes !== 1) throw new SessionError("VERSION_CONFLICT", "Session compare-and-swap failed");
      const logBytes = this.insertEvents(id, current.lastSeq, committed);
      const derived: RelayCommitResult | undefined = mutation.relay === undefined ? undefined : writeDerivedRows(this.database, id, next, mutation.relay.derived);
      freeze(next); cached = { next, bytes: Buffer.byteLength(serialized, "utf8"), logBytes };
      return { session: next, events: committed, ...(derived === undefined ? {} : { relay: derived }) };
    }, () => { if (cached !== null) this.cache.put(cached.next, cached.bytes, cached.logBytes); });
  }
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    this.assertOwner(); sessionId(id); const maximum = limitValue(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    return this.read(() => readEventsFrom(this.database, this.session(id), afterSeq, maximum));
  }
  /** How the snapshot cache has been used (ADR-055 §11.2), for diagnostics and tests; reading it changes nothing. */
  cacheStats(): SnapshotCacheStats { return this.cache.stats(); }

  relayWrite(id: SessionId, rows: RelayWriteRows): RelayWriteResult {
    this.assertOwner(); sessionId(id);
    if (rows === null || typeof rows !== "object" || Array.isArray(rows)) throw new SessionError("INVALID_INPUT", "relay rows must be an object");
    let checked: ReturnType<typeof checkRelayWrite>;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.observeWriters();
      checked = checkRelayWrite(this.database, id, this.session(id), rows);
    } catch (error) { this.abandon(error); throw this.failed ?? error; }
    try { writeRelayWrite(this.database, id, checked); }
    catch (error) {
      if (!sqliteError(error)) { this.abandon(error); throw this.failed ?? error; }
      // A derived row that cannot be written now is left for the next time; the Store keeps serving (ADR-055 §6.4, F07).
      const diagnostic = diagnosticOf(error);
      this.abandon(null);
      if (this.failed) throw this.failed;
      this.relayFailures.push(diagnostic); if (this.relayFailures.length > RELAY_DIAGNOSTICS) this.relayFailures.shift();
      return { written: false, diagnostic };
    }
    try {
      this.assertPaths();
      const metadata = this.readOwner();
      if (metadata.generation !== this.ownerGeneration || metadata.token !== this.token) throw new SessionError("OWNER_LOST", "owner generation changed inside transaction");
      this.database.exec("COMMIT");
    } catch (error) { this.abandon(error); throw this.failed ?? error; }
    return { written: true };
  }
  /** The latest relayWrite failures this Store kept (at most RELAY_DIAGNOSTICS), oldest first; reading them changes nothing. */
  relayDiagnostics(): readonly string[] { return [...this.relayFailures]; }
  deleteSession(id: SessionId): void {
    this.assertOwner(); sessionId(id);
    this.transaction(() => {
      const state = this.session(id, false);
      if (state.status !== "closed" || state.retained !== undefined) throw new SessionError("SESSION_BUSY", "only a closed conversation that keeps no native process is deleted");
      deleteRelayRows(this.database, id);
      this.database.prepare("DELETE FROM events WHERE session_id=?").run(id);
      this.database.prepare("DELETE FROM create_keys WHERE session_id=?").run(id);
      this.database.prepare("DELETE FROM sessions WHERE id=?").run(id);
    }, () => { this.cache.clear(); });
  }
  relayDeliveries(id: SessionId): readonly DeliveryRecord[] {
    this.assertOwner(); sessionId(id);
    return this.read(() => readDeliveries(this.database, id, this.session(id)));
  }
  relayPackets(id: SessionId): readonly RelayPacket[] {
    this.assertOwner(); sessionId(id);
    return this.read(() => readPackets(this.database, id));
  }
  relayIndex(id: SessionId): readonly RelayIndexRow[] {
    this.assertOwner(); sessionId(id);
    return this.read(() => readIndexRows(this.database, id));
  }
  appendRelayLog(record: ConsentAppend): ConsentRecord {
    this.assertOwner();
    return this.transaction(() => appendConsent(this.database, record, this.time()));
  }
  upsertWindow(window: RelayWindow): void {
    this.assertOwner();
    this.transaction(() => { upsertRelayWindow(this.database, window); });
  }
  setPref(key: RelayPrefKey, value: string): void {
    this.assertOwner();
    this.transaction(() => { writePref(this.database, key, value, this.time()); });
  }
  relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>> { this.assertOwner(); return this.read(() => readPrefs(this.database)); }
  relayConsents(): readonly ConsentRecord[] { this.assertOwner(); return this.read(() => currentConsents(this.database)); }

  close(): void {
    if (this.closed) return;
    let failure: unknown = null;
    try {
      this.assertOwner();
      this.transaction(() => { this.database.prepare("UPDATE owner_metadata SET owner_active=0 WHERE singleton=1 AND owner_generation=? AND owner_token=?").run(this.ownerGeneration, this.token); });
    } catch (error) { failure = error; }
    this.closed = true;
    this.cache.close();
    try { if (this.database.isOpen) this.database.close(); } catch (error) { failure ??= error; }
    try { if (this.owner.isOpen) this.owner.close(); } catch (error) { failure ??= error; }
    if (!this.owner.isOpen) activeRoots.delete(this.root);
    if (failure !== null) throw failure;
  }

  /** Rolls back a write of relayWrite: a SQLite `cause` or a failed rollback disables the Store, ownership loss as always. */
  private abandon(cause: unknown): void {
    try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); }
    catch (rollbackError) { this.failed = storageFailure(rollbackError); }
    if (cause !== null && sqliteError(cause)) this.failed = storageFailure(cause);
    if (cause instanceof SessionError && cause.code === "OWNER_LOST") this.failed = cause;
    if (this.failed) this.cache.clear();
  }
  private time(): number {
    try { return this.now().getTime(); } catch { throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date"); }
  }
  private assertPaths(): void {
    if (!this.owner.isOpen || !this.owner.isTransaction || !this.database.isOpen || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath)) || !sameFile(this.ownerIdentity, pathIdentity(this.ownerPath)) || !sameFile(this.databaseIdentity, pathIdentity(this.databasePath))) throw new SessionError("OWNER_LOST", "owner lock transaction or storage path identity was lost");
  }
  private readOwner(): OwnerRow { return ownerRow(this.database.prepare("SELECT owner_generation,owner_pid,owner_token,owner_active FROM owner_metadata WHERE singleton=1").get()); }
  /**
   * Copies a v1–v12 business database to `<root>/backups` before claimAndRecover migrates it (ADR-049). It runs with the owner
   * lock held and outside any transaction, as VACUUM INTO requires, and only reads the business database.
   */
  private backupBeforeMigration(): void {
    const from = integer(object(this.database.prepare("PRAGMA user_version").get(), "database schema version").user_version, "database schema version");
    // v0 is created directly as v13 and v13 is current; claimAndRecover refuses any other version without migrating.
    if (from < 1 || from >= CURRENT_VERSION) return;
    const folder = join(this.root, "backups");
    let step = "prepare the backups directory", created = false, partial: string | null = null, published: string | null = null;
    try {
      try { mkdirSync(folder, { mode: 0o700 }); created = true; } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      const directory = lstatSync(folder);
      if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o077) !== 0 || (process.getuid !== undefined && directory.uid !== process.getuid()))
        throw new SessionError("INVALID_STORAGE", "the backups directory must be a private directory owned by this user");
      step = "remove older backups";
      const files = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
      // A partial file is only left by a backup that crashed: the owner lock rules out one being written now.
      for (const name of files) if (PARTIAL_BACKUP_NAME.test(name)) unlinkSync(join(folder, name));
      // The oldest go before the copy is written, so the disk never holds more than the kept backups and the new copy.
      const backups = files.flatMap(name => { const time = BACKUP_NAME.exec(name)?.[1]; return time === undefined ? [] : [{ name, time }]; });
      backups.sort((left, right) => newestFirst(left.time, right.time) || newestFirst(left.name, right.name));
      for (const old of backups.slice(BACKUPS_KEPT - 1)) unlinkSync(join(folder, old.name));
      step = "write the backup";
      let time: string;
      try { time = this.now().toISOString(); } catch { throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date"); }
      const name = "gateway-v" + from + "-" + time.slice(0, 19).replace(/[-:]/gu, "") + "Z-" + randomBytes(4).toString("hex") + ".sqlite";
      if (!BACKUP_NAME.test(name)) throw new SessionError("INVALID_INPUT", "clock time cannot name a backup");
      // Written under a name never taken for a backup; it takes its name only once it has been read back and synced.
      const path = join(folder, name + ".partial"), descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      partial = path;
      // SQLite writes into this empty file rather than creating one with its default 0644; the mode is set explicitly so no
      // umask can narrow it below what VACUUM INTO needs.
      try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
      this.database.prepare("VACUUM INTO ?").run(path);
      step = "verify the backup";
      // A source before v13 has no relay tables; from v13 on they are counted too (ADR-049, ADR-055 §14.1).
      const written = lstatSync(path), source = rowCounts(this.database, from), copy = new DatabaseSync(path, { readOnly: true, timeout: 0, allowExtension: false });
      try {
        const counts = rowCounts(copy, from), check = copy.prepare("PRAGMA quick_check").all();
        if (!written.isFile() || written.nlink !== 1 || (written.mode & 0o777) !== 0o600 || copy.prepare("PRAGMA user_version").get()?.user_version !== from ||
            JSON.stringify(counts) !== JSON.stringify(source) || check.length !== 1 || check[0]?.quick_check !== "ok")
          throw new SessionError("INVALID_DATA", "the backup does not read back as the business database it copies");
      } finally { copy.close(); }
      step = "publish the backup";
      syncPath(path);
      const target = join(folder, name);
      linkSync(path, target); published = target;
      unlinkSync(path); partial = null;
      syncPath(folder); if (created) syncPath(this.root);
    } catch (error) {
      // Only what this attempt wrote is removed; older backups removed above stay removed.
      let remains = false;
      for (const path of [partial, published]) {
        if (path === null) continue;
        try { unlinkSync(path); } catch (cleanup) { if (errorCode(cleanup) !== "ENOENT") remains = true; }
      }
      const failure = new SessionError("STORAGE_BACKUP_FAILED", "could not " + step + " before migrating the business database from v" + from + " (" + reason(error) + "); nothing was migrated" +
        (remains ? ", and an unfinished backup file remains in the backups directory" : ""));
      failure.cause = error; throw failure;
    }
  }
  private claimAndRecover(): number {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const versionRow = object(db.prepare("PRAGMA user_version").get(), "database schema version");
      const version = integer(versionRow.user_version, "database schema version");
      if (!Number.isSafeInteger(version) || version < 0 || version > CURRENT_VERSION) throw new SessionError("INVALID_DATA", "unknown business database schema version");
      if (version === 0) {
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length !== 0) throw new SessionError("INVALID_DATA", "unversioned business database already contains data");
        db.exec(`
          CREATE TABLE owner_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=0),owner_pid INTEGER NOT NULL,owner_token TEXT NOT NULL,owner_active INTEGER NOT NULL CHECK(owner_active IN(0,1))) STRICT;
          INSERT INTO owner_metadata VALUES(1,0,0,'',0);
          CREATE TABLE sessions(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=1),last_seq INTEGER NOT NULL CHECK(last_seq>=0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT;
          CREATE TABLE create_keys(command_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),fingerprint TEXT NOT NULL) STRICT;
          CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT;
        `);
        // A new database is made at the current version, with the relay tables (ADR-055 §14.1).
        db.exec(RELAY_DDL); db.exec("PRAGMA user_version=" + CURRENT_VERSION);
      }
      const prior = this.readOwner();
      if (prior.active && processMayBeAlive(prior.pid)) throw new SessionError("OWNER_UNCONFIRMED", "previous owner may still be alive; automatic takeover is refused");
      // Format-only migration: validate all legacy state before changing any public schema.
      // The same transaction covers every row and the user_version, so corruption rolls it all back.
      if (version === 1) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 1) throw new SessionError("INVALID_DATA", "database v1 contains a non-legacy Session");
          const next = parseSession({ ...state, schemaVersion: 2 });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
        }
        db.exec("PRAGMA user_version=2");
      }
      // v3 permits explicit quiescent recovery while preserving unknown terminal facts.
      // Old readers reject v3 instead of misinterpreting an open Session with unknown history.
      if (version === 1 || version === 2) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 2) throw new SessionError("INVALID_DATA", "database v2 contains a non-v2 Session");
          const next = parseSession({ ...state, schemaVersion: 3 });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
        }
        db.exec("PRAGMA user_version=3");
      }
      if (version === 1 || version === 2 || version === 3) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 3) throw new SessionError("INVALID_DATA", "database v3 contains a non-v3 Session");
          const next = parseSession({ ...state, schemaVersion: 4 });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
        }
        db.exec("PRAGMA user_version=4");
      }
      if (version >= 1 && version <= 4) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 4) throw new SessionError("INVALID_DATA", "database v4 contains a non-v4 Session");
          const next = parseSession({ ...state, schemaVersion: 5 });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
        }
        db.exec("PRAGMA user_version=5");
      }
      if (version >= 1 && version <= 5) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 5) throw new SessionError("INVALID_DATA", "database v5 contains a non-v5 Session");
          const next = parseSession({ ...state, schemaVersion: 6 });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
        }
        db.exec("PRAGMA user_version=6");
      }
      // v7 adds bounded native activity facts (tool detail references, plan, usage, notices, outputs); history is unchanged.
      if (version >= 1 && version <= 6) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 6) throw new SessionError("INVALID_DATA", "database v6 contains a non-v6 Session");
          const next = parseSession({ ...state, schemaVersion: 7 });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
        }
        db.exec("PRAGMA user_version=7");
      }
      // v8 adds branch origins and native fork references; existing Sessions are unchanged apart from their version.
      if (version >= 1 && version <= 7) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 7) throw new SessionError("INVALID_DATA", "database v7 contains a non-v7 Session");
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(parseSession({ ...state, schemaVersion: 8 })), state.id);
        }
        db.exec("PRAGMA user_version=8");
      }
      // v9 adds the applied and observed native configuration of each binding; existing Sessions only change version.
      if (version >= 1 && version <= 8) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 8) throw new SessionError("INVALID_DATA", "database v8 contains a non-v8 Session");
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(parseSession({ ...state, schemaVersion: 9 })), state.id);
        }
        db.exec("PRAGMA user_version=9");
      }
      // v10 records when each Run reached its phases; existing Sessions only change version.
      if (version >= 1 && version <= 9) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 9) throw new SessionError("INVALID_DATA", "database v9 contains a non-v9 Session");
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(parseSession({ ...state, schemaVersion: 10 })), state.id);
        }
        db.exec("PRAGMA user_version=10");
      }
      // v11 lets a conversation keep its native process between Turns (ADR-030); existing Sessions only change version.
      if (version >= 1 && version <= 10) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 10) throw new SessionError("INVALID_DATA", "database v10 contains a non-v10 Session");
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(parseSession({ ...state, schemaVersion: 11 })), state.id);
        }
        db.exec("PRAGMA user_version=11");
      }
      // v12 records how to recognize a kept process group after its owner ends (ADR-030); existing Sessions only change version.
      if (version >= 1 && version <= 11) {
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 11) throw new SessionError("INVALID_DATA", "database v11 contains a non-v11 Session");
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(parseSession({ ...state, schemaVersion: 12 })), state.id);
        }
        db.exec("PRAGMA user_version=12");
      }
      // v13 adds the relay tables and each native binding's relay state, inferred from its Session's events (ADR-055 §14.4).
      if (version >= 1 && version <= 12) {
        db.exec(RELAY_DDL);
        for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
          const state = this.readSession(sessionId(row.id));
          if (state.schemaVersion !== 12) throw new SessionError("INVALID_DATA", "database v12 contains a non-v12 Session");
          const migrated = migrateSession(state, this.migrationEvents(state));
          const next = parseSession({ ...state, schemaVersion: 13, ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings.map((binding, index) => ({ ...binding, relay: migrated.bindings[index]! })) }) });
          db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
          writeBehindIndexes(db, state.id, migrated.runs);
        }
        db.exec("PRAGMA user_version=13");
      }
      const generation = prior.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new SessionError("INVALID_DATA", "owner generation exhausted");
      db.prepare("UPDATE owner_metadata SET owner_generation=?,owner_pid=?,owner_token=?,owner_active=1 WHERE singleton=1").run(generation, process.pid, this.token);
      // Windows nobody observed for 30 days are not read any more (ADR-055 §14.1).
      pruneRelayWindows(db, this.time());
      for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
        const state = this.readSession(sessionId(row.id)), recovered = recoverSession(state);
        const budget = db.prepare("SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS bytes,COALESCE(MAX(length(CAST(event_json AS BLOB))),0) AS maximum,COALESCE(MAX(owner_generation),0) AS generation FROM events WHERE session_id=?").get(state.id);
        if (integer(budget?.bytes, "persisted log bytes") > MAX_EVENT_LOG_BYTES || integer(budget?.maximum, "persisted event bytes") > MAX_EVENT_BYTES || integer(budget?.generation, "persisted event generation") > prior.generation) throw new SessionError("INVALID_DATA", "persisted event log exceeds its budget or owner generation");
        if (!recovered) continue;
        const next = this.recoverWithRelay(state, recovered);
        db.prepare("UPDATE sessions SET version=?,last_seq=?,snapshot=? WHERE id=?").run(next.next.version, next.next.lastSeq, JSON.stringify(next.next), next.next.id);
        this.insertEvents(next.next.id, state.lastSeq, this.commitEvents(next.next.id, state.lastSeq, next.entries, generation));
      }
      this.assertPaths(); db.exec("COMMIT"); return generation;
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  /**
   * Recovery of one Session with its relay part (ADR-055 §9 S15): the relay recovery's Session and delivery outcomes are
   * checked and written inside a SAVEPOINT of the Session's own; when anything of it fails, that SAVEPOINT is rolled back and
   * the Session is recovered without it, marked `relayRecoveryFailed` with `relay: { failed: true }` in its
   * `session.recovered`. A failure that ended the whole transaction is not contained.
   */
  private recoverWithRelay(state: SessionSnapshot, recovered: SessionMutation): { readonly next: SessionSnapshot; readonly entries: readonly EventDraft[] } {
    const db = this.database, at = (next: SessionSnapshot, events: readonly EventDraft[]) => {
      const entries = drafts(events), parsed = parseSession({ ...next, version: state.version + 1, lastSeq: state.lastSeq + entries.length });
      assertSessionTransition(state, parsed, entries);
      return { next: parsed, entries };
    };
    const withRelay = (relay: Readonly<Record<string, unknown>>) => recovered.events.map(event => event.type === "session.recovered" ? { type: event.type, data: { ...event.data, relay } } : event);
    db.exec("SAVEPOINT relay_recovery");
    try {
      const relay = this.recoverRelay(recovered.next, readDeliveries(db, state.id, state));
      if (relay === null) { db.exec("RELEASE relay_recovery"); return at(recovered.next, recovered.events); }
      const result = at(relay.next, withRelay({ failed: false, deliveries: relay.deliveries.map(row => ({ runId: row.runId, outcome: row.outcome.kind })),
        bindings: (relay.next.nativeBindings ?? []).flatMap(binding => binding.relay === undefined ? [] : [{ harnessId: binding.harnessId, controlId: binding.controlId, sync: binding.relay.sync.kind }]) }));
      writeRelayRows(db, state.id, checkRelayRows(db, state.id, result.next, { deliveries: relay.deliveries.map(row => ({ kind: "outcome" as const, runId: row.runId, outcome: row.outcome })) }));
      checkPacketReferences(db, state.id, state, result.next);
      db.exec("RELEASE relay_recovery");
      return result;
    } catch (error) {
      if (!db.isTransaction) throw error;
      db.exec("ROLLBACK TO relay_recovery"); db.exec("RELEASE relay_recovery");
      return at({ ...recovered.next, relayRecoveryFailed: state.lastSeq + 1 }, withRelay({ failed: true }));
    }
  }
  /**
   * The events the v13 migration reads (MIGRATION_EVENTS), in seq order, scanned from the events table directly rather than
   * page by page with the snapshot read again for each page (ADR-055 §14.4, RT1-m7); each is validated as a stored event.
   */
  private migrationEvents(state: SessionSnapshot): readonly MigrationEvent[] {
    const types = MIGRATION_EVENTS.map(() => "?").join(",");
    return this.database.prepare("SELECT seq,event_json FROM events WHERE session_id=? AND json_extract(event_json,'$.type') IN (" + types + ") ORDER BY seq").all(state.id, ...MIGRATION_EVENTS).map(row => {
      let value: unknown;
      try { value = JSON.parse(string(row.event_json, "event JSON")); } catch { throw new SessionError("INVALID_DATA", "persisted event is not valid JSON"); }
      const event = parseStoredEvent(value, state.id);
      if (event.seq !== row.seq || event.seq > state.lastSeq) throw new SessionError("INVALID_DATA", "persistent event sequence is inconsistent");
      return { seq: event.seq, type: event.type, data: event.data };
    });
  }
  /** A stored Session read and validated again, bypassing the cache: migration and recovery read what they have just written. */
  private readSession(id: SessionId): SessionSnapshot {
    return readSessionFrom(this.database, id);
  }
  /**
   * The committed snapshot of `id`, deeply frozen: the cached one while it is the stored version and event cursor and no
   * other connection has committed since (ADR-055 §11.2); otherwise read and validated again, and cached when `keep`.
   * Inside a write transaction it is called only before that transaction writes the Session, so it caches committed state.
   */
  private session(id: SessionId, keep = true): SessionSnapshot {
    this.observeWriters();
    const row = this.database.prepare("SELECT version,last_seq FROM sessions WHERE id=?").get(id);
    if (!row) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    const cached = this.cache.get(id, integer(row.version, "Session version", 1), integer(row.last_seq, "Session event cursor"));
    if (cached !== undefined) return cached;
    const { state, bytes } = readStoredSession(this.database, id);
    freeze(state);
    if (keep) this.cache.put(state, bytes);
    return state;
  }
  /**
   * Drops the cache once another connection committed to the business database since this one last looked; commits of this
   * connection leave PRAGMA data_version as it is. Only a broken ownership lets another writer in; tests do it on purpose.
   */
  private observeWriters(): void {
    const version = integer(object(this.database.prepare("PRAGMA data_version").get(), "database data version").data_version, "database data version");
    if (this.dataVersion !== null && this.dataVersion !== version) this.cache.clear();
    this.dataVersion = version;
  }
  private commitEvents(id: SessionId, previousSeq: number, entries: readonly EventDraft[], generation: number): readonly SessionEvent[] {
    let timestamp: string;
    try { timestamp = this.now().toISOString(); } catch { throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date"); }
    return entries.map((event, index) => ({ ...event, sessionId: id, seq: previousSeq + index + 1, ownerGeneration: generation, timestamp }));
  }
  /**
   * Appends the events of `id` that follow `previousSeq`, its committed cursor, and returns the byte size of its event log
   * with them. That size is counted along with each commit (ADR-055 §11.2: the counter column is v13's, G066): the cache
   * keeps it with the snapshot at that cursor and this store adds what it appends, which is exact because events are only
   * ever appended, all through here, and every commit of another connection clears the cache. Without a known size the
   * log is summed once in SQLite.
   */
  private insertEvents(id: SessionId, previousSeq: number, events: readonly SessionEvent[]): number {
    const insert = this.database.prepare("INSERT INTO events(session_id,seq,owner_generation,event_json) VALUES(?,?,?,?)");
    let added = 0;
    const serialized = events.map(event => {
      if (event.sessionId !== id) throw new SessionError("INVALID_DATA", "one event batch belongs to one Session");
      const payload = JSON.stringify(event), size = utf8Bytes(payload);
      if (size > MAX_EVENT_BYTES) throw new SessionError("EVENT_LIMIT", "persistent event byte limit reached");
      added += size; return { event, payload };
    });
    const logged = this.cache.logBytes(id, previousSeq)
      ?? integer(this.database.prepare("SELECT COALESCE(SUM(octet_length(event_json)),0) AS bytes FROM events WHERE session_id=?").get(id)?.bytes, "Session event log bytes");
    if (logged + added > MAX_EVENT_LOG_BYTES) throw new SessionError("EVENT_LIMIT", "Session event log byte limit reached");
    for (const { event, payload } of serialized) insert.run(event.sessionId, event.seq, event.ownerGeneration, payload);
    return logged + added;
  }
  /**
   * Runs `mutate` in one IMMEDIATE transaction. `committed` runs only once COMMIT succeeded, so the cache never takes what a
   * rolled-back transaction wrote; a storage failure clears the cache along with disabling the store.
   */
  private transaction<T>(mutate: () => T, committed?: () => void): T {
    this.assertOwner();
    let result: T;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      // No other connection commits while this one holds the write lock, so this sees all they committed before.
      this.observeWriters();
      result = mutate();
      // Path/lock validation after the callback closes ownership windows without awaiting external work.
      this.assertPaths();
      const metadata = this.readOwner();
      if (metadata.generation !== this.ownerGeneration || metadata.token !== this.token) throw new SessionError("OWNER_LOST", "owner generation changed inside transaction");
      this.database.exec("COMMIT");
    } catch (error) {
      try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); }
      catch (rollbackError) { this.failed = storageFailure(rollbackError); }
      if (sqliteError(error)) this.failed = storageFailure(error);
      if (error instanceof SessionError && error.code === "OWNER_LOST") this.failed = error;
      if (this.failed) this.cache.clear();
      throw this.failed ?? error;
    }
    committed?.();
    return result;
  }
  private read<T>(read: () => T): T {
    try { return read(); } catch (error) { if (sqliteError(error)) { this.failed = storageFailure(error); this.cache.clear(); throw this.failed; } throw error; }
  }
}

/** Read-only management access never claims an owner or recovers unfinished executions. */
export class SqliteSessionReader {
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly markerPath: string;
  private readonly markerIdentity: FileIdentity;
  private readonly databasePath: string;
  private readonly databaseIdentity: FileIdentity;
  private readonly database: DatabaseSync;
  private closed = false;
  private failed: SessionError | null = null;

  constructor(root: string) {
    const initialized = inspectRoot(root);
    this.root = initialized.root; this.rootIdentity = pathIdentity(this.root, true);
    this.markerPath = initialized.markerPath; this.markerIdentity = initialized.markerIdentity;
    this.databasePath = join(this.root, "gateway.sqlite"); this.databaseIdentity = pathIdentity(this.databasePath);
    this.database = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
    try {
      const version = this.database.prepare("PRAGMA user_version").get();
      if (!version || typeof version.user_version !== "number" || !Number.isSafeInteger(version.user_version) || version.user_version < 1 || version.user_version > CURRENT_VERSION) throw new SessionError("INVALID_DATA", "unknown business database schema version");
      this.assertReadable();
    } catch (error) { this.database.close(); throw error instanceof SessionError ? error : storageFailure(error); }
  }
  get(id: SessionId): SessionSnapshot { sessionId(id); return this.read(() => readSessionFrom(this.database, id)); }
  list(limit?: number): readonly SessionSnapshot[] { const maximum = limitValue(limit); return this.read(() => readListFrom(this.database, maximum, id => readSessionFrom(this.database, id))); }
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    sessionId(id); const maximum = limitValue(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    return this.read(() => readEventsFrom(this.database, readSessionFrom(this.database, id), afterSeq, maximum));
  }
  close(): void { if (this.closed) return; this.closed = true; this.database.close(); }
  private assertReadable(): void {
    if (this.closed) throw new SessionError("STORE_CLOSED", "Session reader is closed");
    if (this.failed) throw this.failed;
    try {
      if (!this.database.isOpen || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath)) || !sameFile(this.databaseIdentity, pathIdentity(this.databasePath))) throw new SessionError("STORAGE_CHANGED", "read-only storage path identity changed");
      const version = this.database.prepare("PRAGMA user_version").get();
      if (!version || typeof version.user_version !== "number" || !Number.isSafeInteger(version.user_version) || version.user_version < 1 || version.user_version > CURRENT_VERSION) throw new SessionError("INVALID_DATA", "unknown business database schema version");
    } catch (error) { this.failed = error instanceof SessionError ? error : storageFailure(error); throw this.failed; }
  }
  private read<T>(read: () => T): T {
    this.assertReadable();
    try {
      this.database.exec("BEGIN DEFERRED"); const result = read(); this.assertReadable(); this.database.exec("COMMIT"); return result;
    } catch (error) {
      try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); } catch (rollbackError) { this.failed = storageFailure(rollbackError); }
      if (sqliteError(error)) this.failed = storageFailure(error);
      throw this.failed ?? error;
    }
  }
}
