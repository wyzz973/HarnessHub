import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CapabilityError, MAX_BACKUPS_PER_FILE, type CapabilityChangeView } from "../../contracts/capabilities.js";

const MARKER = '{"application":"harness-capabilities","version":1}';
const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

/** A setting HarnessHub wrote: where, the hash of the value it wrote, and what was there before (JSON, null when nothing was). */
export interface LedgerEntry { readonly harnessId: string; readonly file: string; readonly key: string; readonly valueHash: string; readonly previous: string | null; readonly changeId: string; readonly at: string }
/**
 * A skill HarnessHub put in the shared directory from a repository: its folder, where it came from (repository URL, the
 * ref asked for or null for the default branch, its folder inside the repository, the commit), the folder's tree id in
 * the repository (everything included) and the tree id of the copy as written.
 */
export interface SkillSource { readonly name: string; readonly folder: string; readonly repository: string; readonly ref: string | null; readonly path: string; readonly commit: string;
  readonly upstreamTree: string; readonly localTree: string; readonly installedAt: string; readonly updatedAt: string; readonly changeId: string }
/** One backup: the file's bytes before a change, and the hash of the bytes that change then wrote (null until it wrote). */
export interface StoredBackup { readonly id: string; readonly file: string; readonly createdAt: string; readonly bytes: number; readonly sha256: string; readonly changeId: string; readonly subject: string; readonly writtenSha256: string | null }

function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function identity(path: string, directory: boolean): string {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1n) || (info.mode & 0o077n) !== 0n)
    throw new CapabilityError("INVALID_STORAGE", "capability storage must be private and owned without links");
  return info.dev.toString() + ":" + info.ino.toString();
}
function readPrivate(path: string, maximum: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maximum) throw new CapabilityError("INVALID_STORAGE", "capability file exceeded its byte budget");
    const buffer = Buffer.alloc(info.size); let length = 0;
    while (length < buffer.length) { const received = readSync(descriptor, buffer, length, buffer.length - length, length); if (received === 0) break; length += received; }
    return buffer.subarray(0, length);
  } finally { closeSync(descriptor); }
}
function writePrivate(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { let written = 0; while (written < bytes.length) written += writeSync(descriptor, bytes, written, bytes.length - written); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
const SCHEMA: Readonly<Record<string, readonly string[]>> = { capability_owner: ["singleton", "generation"], capability_changes: ["id", "command_id", "payload_hash", "at", "view_json"],
  capability_backups: ["id", "file", "created_at", "bytes", "sha256", "change_id", "subject", "written_sha256"], capability_ledger: ["harness_id", "file", "key", "value_hash", "previous", "change_id", "at"],
  skill_sources: ["name", "folder", "repository", "ref", "path", "commit_sha", "upstream_tree", "local_tree", "installed_at", "updated_at", "change_id"], skill_undo: ["change_id", "data_json"],
  mcp_servers: ["name", "definition_json", "created_at", "updated_at"] };
/** Tables of another shape than this build's are refused rather than read or altered. */
function checkSchema(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(SCHEMA)) {
    const found = db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row => row.name);
    if (found.length !== columns.length || found.some((name, index) => name !== columns[index])) throw new CapabilityError("INVALID_STORAGE", "capability storage table " + table + " has an unknown shape");
  }
}
function text(value: unknown): string { if (typeof value !== "string") throw new CapabilityError("INVALID_STORAGE", "capability storage row is invalid"); return value; }

/**
 * HarnessHub's own record of capability changes (ADR-045 §10): `capabilities/capabilities.sqlite` (schema v3) under the
 * data root, with the backups and skill snapshots beside it. v2 adds the skills HarnessHub installed and v3 its MCP list,
 * each rejected by the reader before; `tools/capabilities-v3-to-v2.sql` and `-v2-to-v1.sql` go back. A newer owner
 * generation fences this one off:
 * every write first checks the directory, marker and database are the ones opened and the generation is still ours.
 */
export class CapabilityStore {
  private constructor(private readonly directory: string, private readonly db: DatabaseSync, private readonly check: () => void) {}

  static open(root: string, generation: number): CapabilityStore {
    if (!isAbsolute(root) || /[\0\r\n]/u.test(root) || !Number.isSafeInteger(generation) || generation < 1) throw new CapabilityError("INVALID_INPUT", "invalid capability root or owner generation");
    const directory = join(realpathSync(root), "capabilities"); mkdirSync(directory, { mode: 0o700, recursive: true });
    const directoryId = identity(directory, true), marker = join(directory, ".harness-capabilities.json");
    if (!existsSync(marker) && readdirSync(directory).length !== 0) throw new CapabilityError("INVALID_STORAGE", "nonempty capability root has no ownership marker");
    if (!existsSync(marker)) writePrivate(marker, Buffer.from(MARKER + "\n"));
    const markerId = identity(marker, false);
    if (readPrivate(marker, 4096).toString("utf8").trim() !== MARKER) throw new CapabilityError("INVALID_STORAGE", "unknown capability ownership marker");
    mkdirSync(join(directory, "backups"), { mode: 0o700, recursive: true }); identity(join(directory, "backups"), true);
    const path = join(directory, "capabilities.sqlite"); closeSync(openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
    const databaseId = identity(path, false), db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new CapabilityError("INVALID_STORAGE", "unknown capability storage schema");
      db.exec("CREATE TABLE IF NOT EXISTS capability_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL) STRICT;"
        + "CREATE TABLE IF NOT EXISTS capability_changes(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,at TEXT NOT NULL,view_json TEXT NOT NULL CHECK(json_valid(view_json))) STRICT;"
        + "CREATE TABLE IF NOT EXISTS capability_backups(id TEXT PRIMARY KEY,file TEXT NOT NULL,created_at TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,change_id TEXT NOT NULL,subject TEXT NOT NULL,written_sha256 TEXT) STRICT;"
        + "CREATE TABLE IF NOT EXISTS capability_ledger(harness_id TEXT NOT NULL,file TEXT NOT NULL,key TEXT NOT NULL,value_hash TEXT NOT NULL,previous TEXT,change_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(harness_id,file,key)) STRICT;"
        // v2 (additive): the skills HarnessHub installed from a repository.
        + "CREATE TABLE IF NOT EXISTS skill_sources(name TEXT PRIMARY KEY,folder TEXT NOT NULL,repository TEXT NOT NULL,ref TEXT,path TEXT NOT NULL,commit_sha TEXT NOT NULL,upstream_tree TEXT NOT NULL,"
        + "local_tree TEXT NOT NULL,installed_at TEXT NOT NULL,updated_at TEXT NOT NULL,change_id TEXT NOT NULL) STRICT;"
        + "CREATE TABLE IF NOT EXISTS skill_undo(change_id TEXT PRIMARY KEY,data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;"
        // v3 (additive): HarnessHub's MCP list.
        + "CREATE TABLE IF NOT EXISTS mcp_servers(name TEXT PRIMARY KEY,definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;"
        + "PRAGMA user_version=3");
      checkSchema(db);
      const previous = db.prepare("SELECT generation FROM capability_owner WHERE singleton=1").get()?.generation;
      if (typeof previous === "number" && previous > generation) throw new CapabilityError("OWNERSHIP_LOST", "capability owner generation is stale");
      db.prepare("INSERT INTO capability_owner(singleton,generation) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation").run(generation);
      return new CapabilityStore(directory, db, () => {
        if (identity(directory, true) !== directoryId || identity(marker, false) !== markerId || identity(path, false) !== databaseId
          || db.prepare("SELECT generation FROM capability_owner WHERE singleton=1").get()?.generation !== generation) throw new CapabilityError("OWNERSHIP_LOST", "capability storage ownership changed");
      });
    } catch (error) { db.close(); throw error; }
  }
  /** Throws `OWNERSHIP_LOST` when the storage is no longer the one this owner opened. */
  assertIdentity(): void { this.check(); }

  /** The change a command already made, with the hash of what it asked, so a replay returns it instead of changing again. */
  change(commandId: string): { readonly payloadHash: string; readonly view: CapabilityChangeView } | null {
    const row = this.db.prepare("SELECT payload_hash,view_json FROM capability_changes WHERE command_id=?").get(commandId);
    return row === undefined ? null : { payloadHash: text(row.payload_hash), view: JSON.parse(text(row.view_json)) as CapabilityChangeView };
  }
  saveChange(commandId: string, payloadHash: string, view: CapabilityChangeView): void {
    this.check();
    this.db.prepare("INSERT INTO capability_changes(id,command_id,payload_hash,at,view_json) VALUES(?,?,?,?,?)").run(view.id, commandId, payloadHash, view.at, JSON.stringify(view));
  }
  changeById(id: string): CapabilityChangeView | null {
    const row = this.db.prepare("SELECT view_json FROM capability_changes WHERE id=?").get(id);
    return row === undefined ? null : JSON.parse(text(row.view_json)) as CapabilityChangeView;
  }
  changes(limit: number): readonly CapabilityChangeView[] {
    return this.db.prepare("SELECT view_json FROM capability_changes ORDER BY at DESC, rowid DESC LIMIT ?").all(limit).map(row => JSON.parse(text(row.view_json)) as CapabilityChangeView);
  }

  /** Keeps `bytes` as the file's state before `changeId`; only the newest ten backups of a file are kept. */
  saveBackup(backup: Omit<StoredBackup, "bytes" | "sha256" | "writtenSha256">, bytes: Buffer): void {
    this.check();
    if (!/^[a-f0-9-]{36}$/u.test(backup.id) || bytes.length > MAX_BACKUP_BYTES) throw new CapabilityError("INVALID_INPUT", "invalid capability backup");
    writePrivate(join(this.directory, "backups", backup.id), bytes);
    this.db.prepare("INSERT INTO capability_backups(id,file,created_at,bytes,sha256,change_id,subject,written_sha256) VALUES(?,?,?,?,?,?,?,NULL)")
      .run(backup.id, backup.file, backup.createdAt, bytes.length, sha256(bytes), backup.changeId, backup.subject);
    const old = this.db.prepare("SELECT id FROM capability_backups WHERE file=? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?").all(backup.file, MAX_BACKUPS_PER_FILE);
    for (const row of old) { const id = text(row.id); this.db.prepare("DELETE FROM capability_backups WHERE id=?").run(id); try { unlinkSync(join(this.directory, "backups", id)); } catch { /* already gone */ } }
  }
  /** Forgets a backup taken for a write that then did not happen. */
  dropBackup(id: string): void {
    this.check();
    if (!/^[a-f0-9-]{36}$/u.test(id)) return;
    this.db.prepare("DELETE FROM capability_backups WHERE id=?").run(id);
    try { unlinkSync(join(this.directory, "backups", id)); } catch { /* already gone */ }
  }
  setWritten(id: string, bytes: Buffer): void { this.check(); this.db.prepare("UPDATE capability_backups SET written_sha256=? WHERE id=?").run(sha256(bytes), id); }
  backup(id: string): StoredBackup | null {
    const row = this.db.prepare("SELECT id,file,created_at,bytes,sha256,change_id,subject,written_sha256 FROM capability_backups WHERE id=?").get(id);
    return row === undefined ? null : { id: text(row.id), file: text(row.file), createdAt: text(row.created_at), bytes: Number(row.bytes), sha256: text(row.sha256), changeId: text(row.change_id),
      subject: text(row.subject), writtenSha256: row.written_sha256 === null ? null : text(row.written_sha256) };
  }
  /** The backup's bytes, checked against the hash recorded when it was taken. */
  backupBytes(id: string): Buffer {
    const stored = this.backup(id);
    if (stored === null || !/^[a-f0-9-]{36}$/u.test(id)) throw new CapabilityError("CAPABILITY_NOT_FOUND", "no such capability backup");
    const bytes = readPrivate(join(this.directory, "backups", id), MAX_BACKUP_BYTES);
    if (sha256(bytes) !== stored.sha256) throw new CapabilityError("INVALID_STORAGE", "capability backup does not match its record");
    return bytes;
  }
  backups(): readonly StoredBackup[] {
    return this.db.prepare("SELECT id FROM capability_backups ORDER BY created_at DESC, rowid DESC").all().flatMap(row => { const backup = this.backup(text(row.id)); return backup ? [backup] : []; });
  }

  ledger(harnessId: string, file: string, key: string): LedgerEntry | null {
    const row = this.db.prepare("SELECT value_hash,previous,change_id,at FROM capability_ledger WHERE harness_id=? AND file=? AND key=?").get(harnessId, file, key);
    return row === undefined ? null : { harnessId, file, key, valueHash: text(row.value_hash), previous: row.previous === null ? null : text(row.previous), changeId: text(row.change_id), at: text(row.at) };
  }
  /**
   * Records a setting as HarnessHub's. `keepPrevious`: the value replaced is HarnessHub's own, so an entry already there
   * keeps the value from before HarnessHub's first write as the one to restore; otherwise the entry is stale (someone else
   * changed the setting since) and `entry.previous` replaces it.
   */
  setLedger(entry: LedgerEntry, keepPrevious: boolean): void {
    this.check();
    this.db.prepare("INSERT INTO capability_ledger(harness_id,file,key,value_hash,previous,change_id,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(harness_id,file,key) DO UPDATE SET value_hash=excluded.value_hash,"
      + "previous=CASE WHEN ? THEN capability_ledger.previous ELSE excluded.previous END,change_id=excluded.change_id,at=excluded.at")
      .run(entry.harnessId, entry.file, entry.key, entry.valueHash, entry.previous, entry.changeId, entry.at, keepPrevious ? 1 : 0);
  }
  /** Every ledger entry, oldest first. */
  ledgerEntries(): readonly LedgerEntry[] {
    return this.db.prepare("SELECT harness_id,file,key,value_hash,previous,change_id,at FROM capability_ledger ORDER BY at, rowid").all().map(row => ({ harnessId: text(row.harness_id), file: text(row.file),
      key: text(row.key), valueHash: text(row.value_hash), previous: row.previous === null ? null : text(row.previous), changeId: text(row.change_id), at: text(row.at) }));
  }
  dropLedger(harnessId: string, file: string, key: string): void { this.check(); this.db.prepare("DELETE FROM capability_ledger WHERE harness_id=? AND file=? AND key=?").run(harnessId, file, key); }
  /** The ledger's keys that start with `prefix`, of every Harness. */
  ledgerKeys(prefix: string): readonly string[] {
    return this.db.prepare("SELECT key FROM capability_ledger WHERE substr(key,1,?)=?").all(prefix.length, prefix).map(row => text(row.key));
  }
  dropLedgerForFile(file: string): void { this.check(); this.db.prepare("DELETE FROM capability_ledger WHERE file=?").run(file); }

  /** The skills HarnessHub installed, by folder name. */
  skillSources(): readonly SkillSource[] {
    return this.db.prepare("SELECT name,folder,repository,ref,path,commit_sha,upstream_tree,local_tree,installed_at,updated_at,change_id FROM skill_sources ORDER BY name").all().map(row => ({
      name: text(row.name), folder: text(row.folder), repository: text(row.repository), ref: row.ref === null ? null : text(row.ref), path: text(row.path), commit: text(row.commit_sha),
      upstreamTree: text(row.upstream_tree), localTree: text(row.local_tree), installedAt: text(row.installed_at), updatedAt: text(row.updated_at), changeId: text(row.change_id) }));
  }
  skillSource(name: string): SkillSource | null { return this.skillSources().find(item => item.name === name) ?? null; }
  setSkillSource(source: SkillSource): void {
    this.check();
    this.db.prepare("INSERT INTO skill_sources(name,folder,repository,ref,path,commit_sha,upstream_tree,local_tree,installed_at,updated_at,change_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET "
      + "folder=excluded.folder,repository=excluded.repository,ref=excluded.ref,path=excluded.path,commit_sha=excluded.commit_sha,upstream_tree=excluded.upstream_tree,local_tree=excluded.local_tree,updated_at=excluded.updated_at,change_id=excluded.change_id")
      .run(source.name, source.folder, source.repository, source.ref, source.path, source.commit, source.upstreamTree, source.localTree, source.installedAt, source.updatedAt, source.changeId);
  }
  dropSkillSource(name: string): void { this.check(); this.db.prepare("DELETE FROM skill_sources WHERE name=?").run(name); }
  /** What undoing a change of skill folders needs that its view does not show (absolute paths, lock entries, the source record before). */
  setSkillUndo(changeId: string, data: unknown): void { this.check(); this.db.prepare("INSERT INTO skill_undo(change_id,data_json) VALUES(?,?)").run(changeId, JSON.stringify(data)); }
  skillUndo(changeId: string): unknown {
    const row = this.db.prepare("SELECT data_json FROM skill_undo WHERE change_id=?").get(changeId);
    return row === undefined ? null : JSON.parse(text(row.data_json)) as unknown;
  }
  /** HarnessHub's MCP list, by name: each definition as JSON (validated by its reader), with when it was made and last changed. */
  mcpServers(): readonly { readonly name: string; readonly definition: unknown; readonly createdAt: string; readonly updatedAt: string }[] {
    return this.db.prepare("SELECT name,definition_json,created_at,updated_at FROM mcp_servers ORDER BY name").all()
      .map(row => ({ name: text(row.name), definition: JSON.parse(text(row.definition_json)) as unknown, createdAt: text(row.created_at), updatedAt: text(row.updated_at) }));
  }
  setMcpServer(name: string, definition: unknown, at: string): void {
    this.check();
    this.db.prepare("INSERT INTO mcp_servers(name,definition_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET definition_json=excluded.definition_json,updated_at=excluded.updated_at")
      .run(name, JSON.stringify(definition), at, at);
  }
  dropMcpServer(name: string): void { this.check(); this.db.prepare("DELETE FROM mcp_servers WHERE name=?").run(name); }
  /** Keeps the undo records of these changes only. */
  pruneSkillUndo(keep: readonly string[]): void {
    this.check();
    for (const row of this.db.prepare("SELECT change_id FROM skill_undo").all()) { const id = text(row.change_id); if (!keep.includes(id)) this.db.prepare("DELETE FROM skill_undo WHERE change_id=?").run(id); }
  }
  close(): void { this.db.close(); }
}
export { sha256 };
