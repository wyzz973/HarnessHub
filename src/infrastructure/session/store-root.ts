import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SessionError } from "../../contracts/session.js";
import { utf8Length } from "./rows.js";

/*
 * What a store of conversations stands on besides its tables: the data root and its ownership marker, the identity of the files the OS lock and the database live
 * in, and the owner row. A copy of what the first store (sqlite-store.ts) did, with the same checks, so that the store that replaces it opens a root the same way
 * and refuses the same things. Nothing here reads a conversation.
 */

export interface FileIdentity { readonly dev: string; readonly ino: string }
export interface RootIdentity { readonly root: string; readonly markerPath: string; readonly markerIdentity: FileIdentity }
export interface OwnerRow { readonly generation: number; readonly pid: number; readonly token: string; readonly active: boolean }

export function sameFile(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
export function pathIdentity(path: string, directory = false): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new SessionError("INVALID_STORAGE", "storage path is not a regular owned " + (directory ? "directory" : "file"));
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
export function initializeFile(path: string): FileIdentity {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new SessionError("INVALID_STORAGE", "database must be a regular file without additional hard links");
    return { dev: stat.dev.toString(), ino: stat.ino.toString() };
  } finally { closeSync(descriptor); }
}
/** The data root, made when it is new (and empty) with its ownership marker; a directory that holds anything else and no marker is somebody's, and is left alone. */
export function initializeRoot(root: string): RootIdentity {
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
export function inspectRoot(root: string): RootIdentity {
  if (!isAbsolute(root) || root.includes("\0") || utf8Length(root) > 4096) throw new SessionError("INVALID_INPUT", "data root must be a bounded absolute path");
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

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_DATA", label + " must be an object");
  return value as Record<string, unknown>;
}
export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new SessionError("INVALID_DATA", label + " must be a safe integer");
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SessionError("INVALID_DATA", label + " must be text");
  return value;
}
export function ownerRow(value: unknown): OwnerRow {
  const row = object(value, "owner metadata");
  if (row.owner_active !== 0 && row.owner_active !== 1) throw new SessionError("INVALID_DATA", "invalid owner activity marker");
  return { generation: integer(row.owner_generation, "owner generation"), pid: integer(row.owner_pid, "owner PID"), token: text(row.owner_token, "owner token"), active: row.owner_active === 1 };
}
/** Whether the process that was the owner may still be running (ESRCH is the one answer that says it is not). */
export function processMayBeAlive(pid: number): boolean {
  if (pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error === null || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; }
}
/** Whether an error is SQLite's (a full disk, a broken file, a lost lock): what says the store cannot be trusted, as opposed to a rule of ours that refused one write. */
export function sqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const row = object(error, "SQLite error");
  return row.code === "ERR_SQLITE_ERROR" || typeof row.errcode === "number";
}
export function storageFailure(error: unknown): SessionError {
  const failure = new SessionError("STORAGE_UNAVAILABLE", "SQLite operation failed; new dispatch is disabled");
  failure.cause = error;
  return failure;
}
