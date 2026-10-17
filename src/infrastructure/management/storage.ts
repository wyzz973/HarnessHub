import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagementError } from "../../contracts/management.js";

export interface ManagementFileIdentity { readonly dev: string; readonly ino: string }
export function managementIdentity(path: string, directory = false): ManagementFileIdentity {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1n) || (info.mode & 0o077n) !== 0n)
    throw new ManagementError("INVALID_STORAGE", "management storage must be private and owned without links");
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}
export function sameManagementIdentity(left: ManagementFileIdentity, right: ManagementFileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
export function boundedManagementFile(path: string, maximum: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maximum) throw new ManagementError("INVALID_DATA", "management file exceeded its byte budget");
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) { const received = readSync(descriptor, buffer, length, buffer.length - length, length); if (received === 0) break; length += received; }
    if (length > maximum) throw new ManagementError("INVALID_DATA", "management file grew beyond its byte budget");
    return buffer.subarray(0, length);
  } finally { closeSync(descriptor); }
}
export function managementStorage(root: string, generation: number): { root: string; db: DatabaseSync; assertIdentity: () => void } {
  if (!isAbsolute(root) || /[\0\r\n]/u.test(root) || root.length > 4096 || !Number.isSafeInteger(generation) || generation < 1)
    throw new ManagementError("INVALID_INPUT", "invalid management root or owner generation");
  const directory = join(realpathSync(root), "management"); mkdirSync(directory, { mode: 0o700, recursive: true });
  const identity = managementIdentity(directory, true), marker = join(directory, ".harness-management.json");
  if (!existsSync(marker) && readdirSync(directory).length !== 0) throw new ManagementError("INVALID_STORAGE", "nonempty management root has no ownership marker");
  let descriptor: number;
  try { descriptor = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; descriptor = -1; }
  if (descriptor >= 0) { try { writeFileSync(descriptor, '{"application":"harness-management","version":1}\n'); fsyncSync(descriptor); } finally { closeSync(descriptor); } }
  const markerIdentity = managementIdentity(marker);
  if (boundedManagementFile(marker, 4096).toString("utf8").trim() !== '{"application":"harness-management","version":1}') throw new ManagementError("INVALID_STORAGE", "unknown management ownership marker");
  const path = join(directory, "management.sqlite");
  descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(descriptor);
  const databaseIdentity = managementIdentity(path); const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;PRAGMA foreign_keys=ON");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new ManagementError("INVALID_STORAGE", "unknown management storage schema");
    db.exec("CREATE TABLE IF NOT EXISTS management_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL) STRICT;CREATE TABLE IF NOT EXISTS management_jobs (id TEXT PRIMARY KEY,harness_id TEXT NOT NULL,status TEXT NOT NULL,command_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,expected_revision INTEGER NOT NULL,view_json TEXT NOT NULL) STRICT;CREATE TABLE IF NOT EXISTS management_commands (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL) STRICT;CREATE TABLE IF NOT EXISTS management_logs (job_id TEXT NOT NULL,seq INTEGER NOT NULL,entry_json TEXT NOT NULL,PRIMARY KEY(job_id,seq)) STRICT;CREATE TABLE IF NOT EXISTS management_installations (id TEXT PRIMARY KEY,harness_id TEXT NOT NULL,control_id TEXT NOT NULL,record_json TEXT NOT NULL) STRICT;CREATE TABLE IF NOT EXISTS management_defaults (harness_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,revision INTEGER NOT NULL) STRICT;CREATE TABLE IF NOT EXISTS management_updates (harness_id TEXT PRIMARY KEY,view_json TEXT NOT NULL) STRICT;");
    // Additive v1→v2 migration preserves private history and introduces frozen native plans. v3 only marks that job facts
    // may carry an upgrade's restart consent and results (ADR-043), which a v2 reader would reject; its rows are unchanged.
    // v4 adds uninstall jobs and the frozen installation each removes (ADR-044), which a v3 reader would reject. v5 adds
    // official install jobs and the install each one froze, which a v4 reader would reject.
    if (version !== 5) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE IF NOT EXISTS management_native_plans(job_id TEXT PRIMARY KEY REFERENCES management_jobs(id),plan_json TEXT NOT NULL CHECK(json_valid(plan_json))) STRICT");
        db.exec("CREATE TABLE IF NOT EXISTS management_installation_targets(job_id TEXT PRIMARY KEY REFERENCES management_jobs(id),target_json TEXT NOT NULL CHECK(json_valid(target_json))) STRICT");
        db.exec("CREATE TABLE IF NOT EXISTS management_install_requests(job_id TEXT PRIMARY KEY REFERENCES management_jobs(id),request_json TEXT NOT NULL CHECK(json_valid(request_json))) STRICT");
        nativePlanSchema(db); targetSchema(db); requestSchema(db); db.exec("PRAGMA user_version=5; COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    nativePlanSchema(db); targetSchema(db); requestSchema(db);
    const previous = db.prepare("SELECT generation FROM management_owner WHERE singleton=1").get()?.generation;
    if (typeof previous === "number" && previous > generation) throw new ManagementError("OWNERSHIP_LOST", "management owner generation is stale");
    db.prepare("INSERT INTO management_owner(singleton,generation) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation").run(generation);
    mkdirSync(join(directory, "slots"), { mode: 0o700, recursive: true }); managementIdentity(join(directory, "slots"), true);
    return { root: directory, db, assertIdentity: () => {
      if (!sameManagementIdentity(identity, managementIdentity(directory, true)) || !sameManagementIdentity(markerIdentity, managementIdentity(marker)) ||
          !sameManagementIdentity(databaseIdentity, managementIdentity(path)) || db.prepare("SELECT generation FROM management_owner WHERE singleton=1").get()?.generation !== generation)
        throw new ManagementError("OWNERSHIP_LOST", "management storage ownership changed");
    } };
  } catch (error) { db.close(); throw error; }
}
function nativePlanSchema(db: DatabaseSync): void {
  const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='management_native_plans'").get();
  const columns = db.prepare("PRAGMA table_info(management_native_plans)").all();
  if (table?.type !== "table" || columns.length !== 2 || columns[0]?.name !== "job_id" || columns[0]?.type !== "TEXT" || columns[0]?.pk !== 1 || columns[1]?.name !== "plan_json" || columns[1]?.type !== "TEXT" || columns[1]?.notnull !== 1)
    throw new ManagementError("INVALID_STORAGE", "native management plan schema is invalid");
}
function targetSchema(db: DatabaseSync): void {
  const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='management_installation_targets'").get();
  const columns = db.prepare("PRAGMA table_info(management_installation_targets)").all();
  if (table?.type !== "table" || columns.length !== 2 || columns[0]?.name !== "job_id" || columns[0]?.type !== "TEXT" || columns[0]?.pk !== 1 || columns[1]?.name !== "target_json" || columns[1]?.type !== "TEXT" || columns[1]?.notnull !== 1)
    throw new ManagementError("INVALID_STORAGE", "installation target schema is invalid");
}
function requestSchema(db: DatabaseSync): void {
  const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='management_install_requests'").get();
  const columns = db.prepare("PRAGMA table_info(management_install_requests)").all();
  if (table?.type !== "table" || columns.length !== 2 || columns[0]?.name !== "job_id" || columns[0]?.type !== "TEXT" || columns[0]?.pk !== 1 || columns[1]?.name !== "request_json" || columns[1]?.type !== "TEXT" || columns[1]?.notnull !== 1)
    throw new ManagementError("INVALID_STORAGE", "official install request schema is invalid");
}
