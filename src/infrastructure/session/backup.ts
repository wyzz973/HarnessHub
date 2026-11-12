import { constants, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, statfsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionError } from "../../contracts/session.js";

/*
 * The backup taken before a database is brought to store v14 (ADR-049's way, ADR-057 3.6): the business database copied with VACUUM INTO to a file under
 * `<root>/backups`, read back, synced, and only then given its name. It is taken for a database of version 1 to 13 and before anything of it is changed; a backup
 * that fails ends the upgrade with the database as it was.
 *
 * It is NOT one of the backups the store of v13 rotated (the newest two of the migrations before; the store of tables makes none of those and rotates none): the
 * name `gateway-v<from>-before-v14.sqlite` is outside the pattern that rotation recognized, so nothing removes it but its owner. The reason is the one thing a backup cannot cover (ADR-057 M2): the content store is
 * not in it, and a content collector that deleted what a faulty conversion left unreferenced could not be undone from it; this copy stays for the owner to delete
 * when the upgrade has proven itself. There is one per source version: a second attempt (the first did not get through its first transaction, so the database
 * is as it was) replaces it.
 *
 * Space: the copy is as large as the database, and the conversion writes the rows of every conversation before the snapshots they replace are given back, so
 * the upgrade needs about twice the database free; with less it is refused before anything is written, and says so.
 */

/** The names of the backups made here (the rotation of the store of v13 recognized only its own pattern, and this is not it). */
export const BACKUP_BEFORE_V14 = /^gateway-v(\d+)-before-v14\.sqlite$/u;
const PARTIAL = /^gateway-v\d+-before-v14\.sqlite\.partial$/u;
/** The relay tables of Session v13, whose rows a backup of a v13 database is read back against. */
const RELAY_TABLES_V13 = ["relay_deliveries", "relay_packets", "relay_bodies", "relay_index", "relay_log", "relay_prefs"] as const;

export interface BackupOptions {
  /** The data root: `gateway.sqlite` is in it, and the backups under `backups/`. */
  readonly root: string;
  /** The free bytes of the volume the root is on; the system's answer when absent (tests give their own). */
  readonly freeBytes?: () => number;
}
export function databaseBytes(root: string): number {
  let bytes = 0;
  for (const name of ["gateway.sqlite", "gateway.sqlite-wal"]) { const path = join(root, name); if (existsSync(path)) bytes += lstatSync(path).size; }
  return bytes;
}
function freeBytesOf(root: string): number { const found = statfsSync(root); return Number(found.bavail) * Number(found.bsize); }
function errorCode(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? error.code : undefined; }
/** A failure's reason without paths: this file's own message, SQLite's generic error text or the system error code. */
function reason(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  if (!(error instanceof Error)) return "unknown failure";
  const row = error as unknown as Record<string, unknown>;
  return typeof row.errstr === "string" ? row.errstr : typeof row.code === "string" ? row.code : error.name;
}
function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
/** Row counts a backup is read back against: sessions and events, and from v13 on the relay tables too. */
function rowCounts(database: DatabaseSync, version: number): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  const count = (table: string): void => { counts[table] = Number(database.prepare("SELECT count(*) AS count FROM " + table).get()?.count); };
  count("sessions"); count("events");
  if (version >= 13) for (const table of RELAY_TABLES_V13) count(table);
  return counts;
}

/**
 * Copies the database `db` (of store version `from`, 1 to 13, with no transaction open) to `<root>/backups/gateway-v<from>-before-v14.sqlite` and returns
 * the path. Throws INSUFFICIENT_SPACE when the volume cannot hold the upgrade (nothing is written), STORAGE_BACKUP_FAILED when the copy cannot be made or read
 * back (the files this attempt wrote are removed, and the database was not touched). The backups of older attempts at other versions are left alone.
 */
export function backupBeforeV14(db: DatabaseSync, from: number, options: BackupOptions): string {
  if (!Number.isSafeInteger(from) || from < 1 || from > 13) throw new SessionError("INVALID_INPUT", "only a database of version 1 to 13 is backed up before v14");
  const size = databaseBytes(options.root), free = options.freeBytes === undefined ? freeBytesOf(options.root) : options.freeBytes();
  if (!Number.isFinite(free) || free < 2 * size)
    throw new SessionError("INSUFFICIENT_SPACE", "the upgrade needs about twice the size of the database free (" + 2 * size + " bytes) and the disk has " + (Number.isFinite(free) ? Math.max(0, Math.floor(free)) : 0) + "; nothing was changed");
  const folder = join(options.root, "backups"), name = "gateway-v" + from + "-before-v14.sqlite", path = join(folder, name + ".partial"), target = join(folder, name);
  let step = "prepare the backups directory", created = false, written = false;
  try {
    try { mkdirSync(folder, { mode: 0o700 }); created = true; } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    const directory = lstatSync(folder);
    if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o077) !== 0 || (process.getuid !== undefined && directory.uid !== process.getuid()))
      throw new SessionError("INVALID_STORAGE", "the backups directory must be a private directory owned by this user");
    step = "remove an unfinished backup";
    for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isFile() && PARTIAL.test(entry.name)) unlinkSync(join(folder, entry.name));
    step = "write the backup";
    // Written under a name never taken for a backup; it takes its name only once it has been read back and synced.
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    written = true;
    try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
    db.prepare("VACUUM INTO ?").run(path);
    step = "verify the backup";
    const copy = new DatabaseSync(path, { readOnly: true, timeout: 0, allowExtension: false });
    try {
      const source = rowCounts(db, from), counts = rowCounts(copy, from), check = copy.prepare("PRAGMA quick_check").all(), info = lstatSync(path);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || copy.prepare("PRAGMA user_version").get()?.user_version !== from || JSON.stringify(counts) !== JSON.stringify(source) || check.length !== 1 || check[0]?.quick_check !== "ok")
        throw new SessionError("INVALID_DATA", "the backup does not read back as the business database it copies");
    } finally { copy.close(); }
    step = "publish the backup";
    syncPath(path);
    renameSync(path, target); written = false;
    syncPath(folder); if (created) syncPath(options.root);
    return target;
  } catch (error) {
    // Only what this attempt wrote is removed.
    let remains = false;
    if (written) { try { unlinkSync(path); } catch (cleanup) { if (errorCode(cleanup) !== "ENOENT") remains = true; } }
    const failure = new SessionError("STORAGE_BACKUP_FAILED", "could not " + step + " before migrating the business database from v" + from + " (" + reason(error) + "); nothing was migrated" +
      (remains ? ", and an unfinished backup file remains in the backups directory" : ""));
    failure.cause = error; throw failure;
  }
}
