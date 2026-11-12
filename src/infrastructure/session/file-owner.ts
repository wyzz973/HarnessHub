import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionError } from "../../contracts/session.js";

/*
 * What a data root's owner keeps besides the conversations: its generation (`owner.json`, the number every start takes one past, which the management, provider and
 * capability libraries fence themselves by), and the installation's relay handoff log and preference (`relay-log.json`, `relay-prefs.json`). Small files, each written
 * whole by a rename. The OS lock that makes one process the owner is the store's (an exclusive SQLite transaction on `owner.sqlite`, held until close).
 */

export interface OwnerFile { readonly generation: number; readonly pid: number; readonly token: string; readonly active: boolean }

/** Writes a small file whole: a temporary beside it, synced, renamed over it. */
export function writeWhole(path: string, text: string): void {
  const temporary = path + ".tmp", fd = openSync(temporary, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new SessionError("INVALID_DATA", "a file of the data root is not JSON (" + path.split("/").at(-1) + ")"); }
}
export function readOwner(root: string): OwnerFile | null {
  const value = readJson(join(root, "owner.json"));
  if (value === undefined) return null;
  const row = value as Partial<OwnerFile>;
  if (typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0 || typeof row.pid !== "number" || typeof row.token !== "string" || typeof row.active !== "boolean")
    throw new SessionError("INVALID_DATA", "owner.json is not an owner record");
  return { generation: row.generation, pid: row.pid, token: row.token, active: row.active };
}
export function writeOwner(root: string, owner: OwnerFile): void { writeWhole(join(root, "owner.json"), JSON.stringify(owner) + "\n"); }

/**
 * The generation a root that never had an `owner.json` starts after: the highest one the libraries beside the conversations recorded (they refuse an owner older than the
 * one they last saw), read without writing. 0 when there are none.
 */
export function seedGeneration(root: string): number {
  let highest = 0;
  for (const [path, table] of [[join(root, "management", "management.sqlite"), "management_owner"], [join(root, "capabilities", "capabilities.sqlite"), "capability_owner"]] as const) {
    if (!existsSync(path)) continue;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
      const row = db.prepare("SELECT generation FROM " + table + " WHERE singleton=1").get();
      if (typeof row?.generation === "number" && row.generation > highest) highest = row.generation;
    } catch { /* a library without the table has seen no owner */ } finally { db?.close(); }
  }
  return highest;
}
