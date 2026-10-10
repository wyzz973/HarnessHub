import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagementError } from "../../contracts/management.js";
import { managementSlug } from "../../contexts/management/domain/input.js";
import { boundedManagementFile, managementIdentity, sameManagementIdentity } from "./storage.js";

export interface NativeUsageLease { assertOwned(): void; release(quiescent?: boolean): void }
export interface NativeMutationLease { assertOwned(): void; release(verified: boolean): void }
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function busy(error: unknown): boolean { return error !== null && typeof error === "object" && "errcode" in error && (error.errcode === 5 || error.errcode === 6); }
/** Shared POSIX host locks cover CLI/Web controls as well as maintenance. Unknown mutations retain a durable marker. */
export class NativeInstallationLocks {
  constructor(private readonly root = join("/tmp", "harnesshub-native-" + (process.getuid?.() ?? "unsupported"))) {}
  private paths(harness: string) {
    managementSlug(harness);
    if (process.getuid === undefined) throw new ManagementError("UNSUPPORTED_PLATFORM", "native installation locks require the current POSIX host");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).uid !== process.getuid()) throw new ManagementError("INVALID_STORAGE", "native lock directory belongs to another user");
    managementIdentity(this.root, true);
    const root = realpathSync(this.root), directory = join(root, harness); mkdirSync(directory, { mode: 0o700, recursive: true });
    const identity = managementIdentity(directory, true), file = join(directory, "access.sqlite"), pending = join(directory, "pending.json");
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    const fileIdentity = managementIdentity(file), db = new DatabaseSync(file, { timeout: 0 });
    const owned = () => { if (!db.isOpen || !sameManagementIdentity(identity, managementIdentity(directory, true)) || !sameManagementIdentity(fileIdentity, managementIdentity(file))) throw new ManagementError("OWNERSHIP_LOST", "native installation lock identity changed"); };
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().length) throw new ManagementError("INVALID_STORAGE", "unknown native lock format");
        db.exec("BEGIN EXCLUSIVE; CREATE TABLE lock_marker(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT; INSERT INTO lock_marker VALUES(1,0); PRAGMA user_version=1; COMMIT");
      } else if (version !== 1) throw new ManagementError("INVALID_STORAGE", "unknown native lock version");
    }
    catch (error) { db.close(); if (error instanceof ManagementError) throw error; throw new ManagementError(busy(error) ? "HARNESS_UPDATING" : "INVALID_STORAGE", busy(error) ? "native installation is currently in use or being updated" : "native lock database could not be verified"); }
    return { db, pending, owned, directory };
  }
  read(harness: string): NativeUsageLease {
    const resource = this.paths(harness); let closed = false;
    const markerPath = join(resource.directory, "reader-" + randomUUID() + ".json"), marker = JSON.stringify({ harness, pid: process.pid, token: randomUUID() });
    try {
      resource.db.exec("BEGIN"); resource.db.prepare("SELECT revision FROM lock_marker WHERE id=1").get(); resource.owned();
      if (existsSync(resource.pending)) throw new ManagementError("NATIVE_INSTALLATION_UNKNOWN", "native installation has a pending maintenance result; inspect it before running");
      const fd = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { writeFileSync(fd, marker); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(resource.directory);
    } catch (error) { resource.db.close(); throw error instanceof ManagementError ? error : new ManagementError("HARNESS_UPDATING", "native installation is being updated"); }
    const owned = () => { if (closed) throw new ManagementError("OWNERSHIP_LOST", "native usage lease is closed"); resource.owned(); managementIdentity(markerPath); if (boundedManagementFile(markerPath, 4096).toString("utf8") !== marker) throw new ManagementError("OWNERSHIP_LOST", "native usage marker changed"); };
    return { assertOwned: owned, release: (quiescent = true) => {
      if (closed) return;
      try { owned(); if (quiescent) { unlinkSync(markerPath); syncDirectory(resource.directory); } }
      finally { try { if (resource.db.isOpen) resource.db.exec("ROLLBACK"); } finally { resource.db.close(); closed = true; } }
    } };
  }
  write(harness: string, jobId: string, inspect = false): NativeMutationLease {
    const resource = this.paths(harness), token = randomUUID(); let closed = false;
    let marker = JSON.stringify({ version: 1, harness, jobId, token });
    try {
      if (readdirSync(resource.directory).some(name => name.startsWith("reader-"))) throw new ManagementError("HARNESS_BUSY", "native program has active or unconfirmed users");
      resource.db.exec("BEGIN EXCLUSIVE"); resource.owned();
      if (inspect) {
        managementIdentity(resource.pending);
        const serialized = boundedManagementFile(resource.pending, 4096).toString("utf8"), existing: unknown = JSON.parse(serialized);
        if (existing === null || typeof existing !== "object" || !("harness" in existing) || !("jobId" in existing) || existing.harness !== harness || existing.jobId !== jobId) throw new ManagementError("OWNERSHIP_LOST", "pending native action belongs to another task");
        marker = serialized;
      }
      if (!inspect) { const fd = openSync(resource.pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, marker); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(resource.directory); }
    } catch (error) {
      resource.db.close(); if (error instanceof ManagementError) throw error;
      if (busy(error)) throw new ManagementError("HARNESS_BUSY", "native installation has active users");
      if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST" && existsSync(resource.pending)) throw new ManagementError("NATIVE_INSTALLATION_UNKNOWN", "native installation has an unresolved update");
      throw new ManagementError("INVALID_STORAGE", "native maintenance marker could not be verified");
    }
    const owned = () => { resource.owned(); managementIdentity(resource.pending); if (boundedManagementFile(resource.pending, 4096).toString("utf8") !== marker) throw new ManagementError("OWNERSHIP_LOST", "native update marker changed"); };
    return { assertOwned: owned, release: verified => {
      if (closed) return;
      try { owned(); if (verified) { unlinkSync(resource.pending); syncDirectory(resource.directory); } }
      finally { try { if (resource.db.isOpen) resource.db.exec("ROLLBACK"); } finally { resource.db.close(); closed = true; } }
    } };
  }
}
