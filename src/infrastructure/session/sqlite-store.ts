import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SessionError, commandId, sessionId,
  type CommandId, type EventDraft, type SessionCommit, type SessionEvent, type SessionId,
  type SessionMutation, type SessionSnapshot, type SessionStore,
} from "../../contracts/session.js";
import { MAX_EVENT_BYTES, MAX_EVENT_LOG_BYTES, MAX_READ_BYTES, MAX_READ_ITEMS, MAX_SESSION_BYTES, MAX_SESSION_EVENTS, assertSessionTransition, parseSession, recoverSession, utf8Bytes } from "../../contexts/session/domain/state.js";

const activeRoots = new Set<string>();
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
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freeze(item); Object.freeze(value);
}
function readSessionFrom(database: DatabaseSync, id: SessionId): SessionSnapshot {
  const row = database.prepare("SELECT version,last_seq,length(CAST(snapshot AS BLOB)) AS bytes FROM sessions WHERE id=?").get(id);
  if (!row) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  if (integer(row.bytes, "Session snapshot bytes") > MAX_SESSION_BYTES) throw new SessionError("INVALID_DATA", "persisted Session byte budget exceeded");
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
  return state;
}
function readListFrom(database: DatabaseSync, maximum: number): readonly SessionSnapshot[] {
  const result: SessionSnapshot[] = []; let bytes = 0;
  for (const row of database.prepare("SELECT id,length(CAST(snapshot AS BLOB)) AS bytes FROM sessions ORDER BY rowid DESC LIMIT ?").iterate(maximum)) {
    const size = integer(row.bytes, "Session snapshot bytes");
    if (size > MAX_SESSION_BYTES) throw new SessionError("INVALID_DATA", "persisted Session byte budget exceeded");
    if (bytes + size > MAX_READ_BYTES) throw new SessionError("READ_LIMIT", "Session list exceeds its byte budget; request a smaller explicit limit");
    const state = readSessionFrom(database, sessionId(row.id));
    bytes += size; result.push(state);
  }
  return result;
}
function readEventsFrom(database: DatabaseSync, id: SessionId, afterSeq: number, maximum: number): readonly SessionEvent[] {
  const state = readSessionFrom(database, id);
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

/** Owns the data-root OS lock and synchronous aggregate transactions until close(). */
export class SqliteSessionStore implements SessionStore {
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
  private closed = false;
  private failed: SessionError | null = null;

  constructor(root: string, options: { readonly now?: () => Date } = {}) {
    if (!isAbsolute(root) || root.includes("\0") || utf8Bytes(root) > 4096) throw new SessionError("INVALID_INPUT", "data root must be a bounded absolute path");
    this.now = options.now ?? (() => new Date());
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
      if (!version || version.user_version !== 2) throw new SessionError("OWNER_LOST", "business database schema no longer matches this owner");
      const metadata = this.readOwner();
      if (!metadata.active || metadata.generation !== this.ownerGeneration || metadata.token !== this.token || metadata.pid !== process.pid) throw new SessionError("OWNER_LOST", "persistent owner generation no longer belongs to this process");
    } catch (error) {
      this.failed = error instanceof SessionError && error.code === "OWNER_LOST" ? error : new SessionError("OWNER_LOST", "owner lock, path identity or generation could not be confirmed");
      if (this.failed !== error) this.failed.cause = error; throw this.failed;
    }
  }

  create(snapshot: SessionSnapshot, events: readonly EventDraft[]): SessionCommit {
    this.assertOwner();
    if (snapshot.schemaVersion !== 2 || snapshot.version !== 0 || snapshot.lastSeq !== 0) throw new SessionError("INVALID_INPUT", "new Session must start at version and cursor zero");
    const entries = drafts(events), next = parseSession({ ...snapshot, version: 1, lastSeq: entries.length });
    const create = next.commands.find(entry => entry.kind === "create");
    if (!create) throw new SessionError("INVALID_DATA", "Session create command is missing");
    return this.transaction(() => {
      const prior = this.database.prepare("SELECT session_id, fingerprint FROM create_keys WHERE command_id=?").get(create.id);
      if (prior) {
        if (prior.fingerprint !== create.fingerprint) throw new SessionError("IDEMPOTENCY_CONFLICT", "create key already names another request");
        return { session: this.readSession(sessionId(prior.session_id)), events: [] };
      }
      if (this.database.prepare("SELECT id FROM sessions WHERE id=?").get(next.id)) throw new SessionError("SESSION_EXISTS", "Session identity already exists");
      const committed = this.commitEvents(next.id, 0, entries, this.ownerGeneration);
      this.database.prepare("INSERT INTO sessions(id,version,last_seq,snapshot) VALUES(?,?,?,?)").run(next.id, next.version, next.lastSeq, JSON.stringify(next));
      this.database.prepare("INSERT INTO create_keys(command_id,session_id,fingerprint) VALUES(?,?,?)").run(create.id, next.id, create.fingerprint);
      this.insertEvents(committed);
      return { session: next, events: committed };
    });
  }

  get(id: SessionId): SessionSnapshot { this.assertOwner(); return this.read(() => this.readSession(sessionId(id))); }
  findByCreateKey(key: CommandId): SessionSnapshot | null {
    this.assertOwner(); commandId(key);
    return this.read(() => {
      const row = this.database.prepare("SELECT session_id FROM create_keys WHERE command_id=?").get(key);
      return row ? this.readSession(sessionId(row.session_id)) : null;
    });
  }
  list(limit?: number): readonly SessionSnapshot[] {
    this.assertOwner(); const maximum = limitValue(limit);
    return this.read(() => readListFrom(this.database, maximum));
  }
  transact(id: SessionId, expectedVersion: number, mutate: (current: SessionSnapshot) => SessionMutation): SessionCommit {
    this.assertOwner(); sessionId(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof mutate !== "function") throw new SessionError("INVALID_INPUT", "transaction requires a positive expected version and synchronous mutation");
    return this.transaction(() => {
      const current = this.readSession(id);
      if (current.version !== expectedVersion) throw new SessionError("VERSION_CONFLICT", "Session version changed before the mutation");
      freeze(current);
      const mutation = mutate(current);
      if (mutation === null || typeof mutation !== "object" || "then" in mutation) throw new SessionError("INVALID_DATA", "Session mutation must be synchronous");
      const entries = drafts(mutation.events);
      const next = parseSession({ ...mutation.next, version: current.version + 1, lastSeq: current.lastSeq + entries.length });
      if (next.id !== current.id) throw new SessionError("INVALID_DATA", "transaction cannot replace Session identity");
      const previousCreate = current.commands.find(entry => entry.kind === "create"), nextCreate = next.commands.find(entry => entry.kind === "create");
      if (!previousCreate || !nextCreate || JSON.stringify(previousCreate) !== JSON.stringify(nextCreate)) throw new SessionError("INVALID_DATA", "transaction cannot replace Session create identity");
      assertSessionTransition(current, next);
      const committed = this.commitEvents(id, current.lastSeq, entries, this.ownerGeneration);
      const updated = this.database.prepare("UPDATE sessions SET version=?,last_seq=?,snapshot=? WHERE id=? AND version=?").run(next.version, next.lastSeq, JSON.stringify(next), id, expectedVersion);
      if (updated.changes !== 1) throw new SessionError("VERSION_CONFLICT", "Session compare-and-swap failed");
      this.insertEvents(committed);
      return { session: next, events: committed };
    });
  }
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    this.assertOwner(); sessionId(id); const maximum = limitValue(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    return this.read(() => readEventsFrom(this.database, id, afterSeq, maximum));
  }

  close(): void {
    if (this.closed) return;
    let failure: unknown = null;
    try {
      this.assertOwner();
      this.transaction(() => { this.database.prepare("UPDATE owner_metadata SET owner_active=0 WHERE singleton=1 AND owner_generation=? AND owner_token=?").run(this.ownerGeneration, this.token); });
    } catch (error) { failure = error; }
    this.closed = true;
    try { if (this.database.isOpen) this.database.close(); } catch (error) { failure ??= error; }
    try { if (this.owner.isOpen) this.owner.close(); } catch (error) { failure ??= error; }
    if (!this.owner.isOpen) activeRoots.delete(this.root);
    if (failure !== null) throw failure;
  }

  private assertPaths(): void {
    if (!this.owner.isOpen || !this.owner.isTransaction || !this.database.isOpen || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath)) || !sameFile(this.ownerIdentity, pathIdentity(this.ownerPath)) || !sameFile(this.databaseIdentity, pathIdentity(this.databasePath))) throw new SessionError("OWNER_LOST", "owner lock transaction or storage path identity was lost");
  }
  private readOwner(): OwnerRow { return ownerRow(this.database.prepare("SELECT owner_generation,owner_pid,owner_token,owner_active FROM owner_metadata WHERE singleton=1").get()); }
  private claimAndRecover(): number {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const versionRow = object(db.prepare("PRAGMA user_version").get(), "database schema version");
      const version = integer(versionRow.user_version, "database schema version");
      if (version !== 0 && version !== 1 && version !== 2) throw new SessionError("INVALID_DATA", "unknown business database schema version");
      if (version === 0) {
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length !== 0) throw new SessionError("INVALID_DATA", "unversioned business database already contains data");
        db.exec(`
          CREATE TABLE owner_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=0),owner_pid INTEGER NOT NULL,owner_token TEXT NOT NULL,owner_active INTEGER NOT NULL CHECK(owner_active IN(0,1))) STRICT;
          INSERT INTO owner_metadata VALUES(1,0,0,'',0);
          CREATE TABLE sessions(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=1),last_seq INTEGER NOT NULL CHECK(last_seq>=0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT;
          CREATE TABLE create_keys(command_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),fingerprint TEXT NOT NULL) STRICT;
          CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT;
          PRAGMA user_version=2;
        `);
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
      const generation = prior.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new SessionError("INVALID_DATA", "owner generation exhausted");
      db.prepare("UPDATE owner_metadata SET owner_generation=?,owner_pid=?,owner_token=?,owner_active=1 WHERE singleton=1").run(generation, process.pid, this.token);
      for (const row of db.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
        const state = this.readSession(sessionId(row.id)), recovered = recoverSession(state);
        const budget = db.prepare("SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS bytes,COALESCE(MAX(length(CAST(event_json AS BLOB))),0) AS maximum,COALESCE(MAX(owner_generation),0) AS generation FROM events WHERE session_id=?").get(state.id);
        if (integer(budget?.bytes, "persisted log bytes") > MAX_EVENT_LOG_BYTES || integer(budget?.maximum, "persisted event bytes") > MAX_EVENT_BYTES || integer(budget?.generation, "persisted event generation") > prior.generation) throw new SessionError("INVALID_DATA", "persisted event log exceeds its budget or owner generation");
        if (!recovered) continue;
        const entries = drafts(recovered.events), next = parseSession({ ...recovered.next, version: state.version + 1, lastSeq: state.lastSeq + entries.length });
        assertSessionTransition(state, next);
        db.prepare("UPDATE sessions SET version=?,last_seq=?,snapshot=? WHERE id=?").run(next.version, next.lastSeq, JSON.stringify(next), next.id);
        this.insertEvents(this.commitEvents(next.id, state.lastSeq, entries, generation));
      }
      this.assertPaths(); db.exec("COMMIT"); return generation;
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  private readSession(id: SessionId): SessionSnapshot {
    return readSessionFrom(this.database, id);
  }
  private commitEvents(id: SessionId, previousSeq: number, entries: readonly EventDraft[], generation: number): readonly SessionEvent[] {
    let timestamp: string;
    try { timestamp = this.now().toISOString(); } catch { throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date"); }
    return entries.map((event, index) => ({ ...event, sessionId: id, seq: previousSeq + index + 1, ownerGeneration: generation, timestamp }));
  }
  private insertEvents(events: readonly SessionEvent[]): void {
    const insert = this.database.prepare("INSERT INTO events(session_id,seq,owner_generation,event_json) VALUES(?,?,?,?)");
    const additions = new Map<SessionId, number>();
    const serialized = events.map(event => {
      const payload = JSON.stringify(event), size = utf8Bytes(payload);
      if (size > MAX_EVENT_BYTES) throw new SessionError("EVENT_LIMIT", "persistent event byte limit reached");
      additions.set(event.sessionId, (additions.get(event.sessionId) ?? 0) + size); return { event, payload };
    });
    for (const [id, bytes] of additions) {
      const row = this.database.prepare("SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS bytes FROM events WHERE session_id=?").get(id);
      if (integer(row?.bytes, "Session event log bytes") + bytes > MAX_EVENT_LOG_BYTES) throw new SessionError("EVENT_LIMIT", "Session event log byte limit reached");
    }
    for (const { event, payload } of serialized) insert.run(event.sessionId, event.seq, event.ownerGeneration, payload);
  }
  private transaction<T>(mutate: () => T): T {
    this.assertOwner();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = mutate();
      // Path/lock validation after the callback closes ownership windows without awaiting external work.
      this.assertPaths();
      const metadata = this.readOwner();
      if (metadata.generation !== this.ownerGeneration || metadata.token !== this.token) throw new SessionError("OWNER_LOST", "owner generation changed inside transaction");
      this.database.exec("COMMIT"); return result;
    } catch (error) {
      try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); }
      catch (rollbackError) { this.failed = storageFailure(rollbackError); }
      if (sqliteError(error)) this.failed = storageFailure(error);
      if (error instanceof SessionError && error.code === "OWNER_LOST") this.failed = error;
      throw this.failed ?? error;
    }
  }
  private read<T>(read: () => T): T {
    try { return read(); } catch (error) { if (sqliteError(error)) { this.failed = storageFailure(error); throw this.failed; } throw error; }
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
      if (!version || (version.user_version !== 1 && version.user_version !== 2)) throw new SessionError("INVALID_DATA", "unknown business database schema version");
      this.assertReadable();
    } catch (error) { this.database.close(); throw error instanceof SessionError ? error : storageFailure(error); }
  }
  get(id: SessionId): SessionSnapshot { sessionId(id); return this.read(() => readSessionFrom(this.database, id)); }
  list(limit?: number): readonly SessionSnapshot[] { const maximum = limitValue(limit); return this.read(() => readListFrom(this.database, maximum)); }
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    sessionId(id); const maximum = limitValue(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    return this.read(() => readEventsFrom(this.database, id, afterSeq, maximum));
  }
  close(): void { if (this.closed) return; this.closed = true; this.database.close(); }
  private assertReadable(): void {
    if (this.closed) throw new SessionError("STORE_CLOSED", "Session reader is closed");
    if (this.failed) throw this.failed;
    try {
      if (!this.database.isOpen || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath)) || !sameFile(this.databaseIdentity, pathIdentity(this.databasePath))) throw new SessionError("STORAGE_CHANGED", "read-only storage path identity changed");
      const version = this.database.prepare("PRAGMA user_version").get();
      if (!version || (version.user_version !== 1 && version.user_version !== 2)) throw new SessionError("INVALID_DATA", "unknown business database schema version");
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
