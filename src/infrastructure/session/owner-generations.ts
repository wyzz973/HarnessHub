import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionError } from "../../contracts/session.js";
import { reasonOf } from "./upgrade-check.js";

/*
 * The owner generations a data directory remembers. Three of its libraries record the generation of the owner that opened them last, and refuse to be opened by an owner whose
 * generation is below it (`previous > generation`: "owner generation is stale"): the conversation library (`owner_metadata`, which the owner raises by one at every start), the
 * management library (`management_owner`) and the capability store (`capability_owner`), the last two set to the conversation library's generation at every start. The provider
 * library and the content store record none.
 *
 * That is why a library put back from a backup cannot be opened by the build that made it unless its generation is brought up to the largest of these: the backup was taken before
 * the upgrade, so it remembers a generation from before every start since, and the other two libraries remember the last one.
 */

export interface OwnerGenerations {
  /** The conversation library's own; null when it has no owner row (no library, or an empty one). */
  readonly library: number | null;
  readonly management: number | null;
  readonly capabilities: number | null;
  /** The largest of those there are; 0 when there is none. */
  readonly largest: number;
}

/** Where the other two libraries are, under the data directory, and the table and column their generation is in. */
const SIDES = [
  { store: "management", file: ["management", "management.sqlite"], table: "management_owner", column: "generation", label: "management library" },
  { store: "capabilities", file: ["capabilities", "capabilities.sqlite"], table: "capability_owner", column: "generation", label: "capability store" },
] as const;

/**
 * The generation a small library keeps in its owner table: null when the library is not there, was never opened by an owner (no table, no row); an error when it is there and
 * cannot be read, because a generation that cannot be read cannot be left out of the largest. Read through a read-only connection (these libraries keep no log, so it makes no file).
 */
function generationIn(root: string, side: typeof SIDES[number]): number | null {
  const file = join(root, ...side.file);
  if (!existsSync(file)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 1000, allowExtension: false });
    if (db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(side.table) === undefined) return null;
    const row = db.prepare("SELECT " + side.column + " AS generation FROM " + side.table + " WHERE singleton=1").get();
    if (row === undefined) return null;
    if (typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new SessionError("INVALID_DATA", "its owner generation is not a number");
    return row.generation;
  } catch (error) {
    throw new SessionError("INVALID_STORAGE", "the owner generation of the " + side.label + " could not be read (" + reasonOf(error) + ")");
  } finally { try { db?.close(); } catch { /* closed */ } }
}

/** The generations of the management library and the capability store (null for one that is not there or was never opened). */
export function sideGenerations(root: string): { readonly management: number | null; readonly capabilities: number | null } {
  return { management: generationIn(root, SIDES[0]), capabilities: generationIn(root, SIDES[1]) };
}

/** All the generations of a data directory, given the conversation library's own (from its owner row). */
export function ownerGenerations(root: string, library: number | null): OwnerGenerations {
  const { management, capabilities } = sideGenerations(root);
  return { library, management, capabilities, largest: Math.max(0, ...[library, management, capabilities].filter((value): value is number => value !== null)) };
}
