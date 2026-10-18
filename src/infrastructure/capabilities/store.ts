import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CapabilityError, MAX_BACKUPS_PER_FILE, type CapabilityChangeView } from "../../contracts/capabilities.js";

const MARKER = '{"application":"harness-capabilities","version":1}';
const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

/** A setting HarnessHub wrote: where, the hash of the value it wrote, and what was there before (JSON, null when nothing was). */
export interface LedgerEntry { readonly harnessId: string; readonly file: string; readonly key: string; readonly valueHash: string; readonly previous: string | null; readonly changeId: string; readonly at: string }
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
  capability_backups: ["id", "file", "created_at", "bytes", "sha256", "change_id", "subject", "written_sha256"], capability_ledger: ["harness_id", "file", "key", "value_hash", "previous", "change_id", "at"] };
/** Tables of another shape than this build's are refused rather than read or altered. */
function checkSchema(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(SCHEMA)) {
    const found = db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map(row => row.name);
    if (found.length !== columns.length || found.some((name, index) => name !== columns[index])) throw new CapabilityError("INVALID_STORAGE", "capability storage table " + table + " has an unknown shape");
  }
}
function text(value: unknown): string { if (typeof value !== "string") throw new CapabilityError("INVALID_STORAGE", "capability storage row is invalid"); return value; }

/**
 * HarnessHub's own record of capability changes (ADR-045 §10): `capabilities/capabilities.sqlite` (schema v1) under the
 * data root, with the backups beside it. Older builds do not read it. A newer owner generation fences this one off:
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
      if (version !== 0 && version !== 1) throw new CapabilityError("INVALID_STORAGE", "unknown capability storage schema");
      db.exec("CREATE TABLE IF NOT EXISTS capability_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL) STRICT;"
        + "CREATE TABLE IF NOT EXISTS capability_changes(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,at TEXT NOT NULL,view_json TEXT NOT NULL CHECK(json_valid(view_json))) STRICT;"
        + "CREATE TABLE IF NOT EXISTS capability_backups(id TEXT PRIMARY KEY,file TEXT NOT NULL,created_at TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,change_id TEXT NOT NULL,subject TEXT NOT NULL,written_sha256 TEXT) STRICT;"
        + "CREATE TABLE IF NOT EXISTS capability_ledger(harness_id TEXT NOT NULL,file TEXT NOT NULL,key TEXT NOT NULL,value_hash TEXT NOT NULL,previous TEXT,change_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(harness_id,file,key)) STRICT;"
        + "PRAGMA user_version=1");
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
  setLedger(entry: LedgerEntry): void {
    this.check();
    this.db.prepare("INSERT INTO capability_ledger(harness_id,file,key,value_hash,previous,change_id,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(harness_id,file,key) DO UPDATE SET value_hash=excluded.value_hash,change_id=excluded.change_id,at=excluded.at")
      .run(entry.harnessId, entry.file, entry.key, entry.valueHash, entry.previous, entry.changeId, entry.at);
  }
  dropLedger(harnessId: string, file: string, key: string): void { this.check(); this.db.prepare("DELETE FROM capability_ledger WHERE harness_id=? AND file=? AND key=?").run(harnessId, file, key); }
  dropLedgerForFile(file: string): void { this.check(); this.db.prepare("DELETE FROM capability_ledger WHERE file=?").run(file); }
  close(): void { this.db.close(); }
}
export { sha256 };
