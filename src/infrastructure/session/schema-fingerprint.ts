import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SessionError } from "../../contracts/session.js";
import { schemaV14Definition } from "./schema-v14.js";
import { all, one } from "./statements.js";

/*
 * The fingerprint of the table structure of a v14 database (schema-v14.ts). The structure a build writes is a fact of its code, and a database written by a build whose code said another
 * thing is not one this build can use: the tests that found out about `derived` gaining a column (a database written before it had none, and the start of a service on it failed with a
 * SQLite message deep in a backfill) are the reason. So the digest of the statements that define the structure is written into the database when it is made or upgraded to v14 (`stampSchema`),
 * and compared at every start (`judgeStructure`): a database that carries another build's digest is refused at once, with a code that says what is wrong (SCHEMA_MISMATCH) and before
 * anything is written to it. A v14 database made before the stamp existed has none: its structure is compared with this build's once, and stamped when it is equal — never repaired by
 * guessing, never changed when it is not. The stamp says what code wrote the structure, not what is there now; a table dropped under a running build is derived-data trouble or storage trouble
 * and is told as those.
 */

/** The table the stamp is kept in; made in the transaction that makes or upgrades the database, or by the first start that finds a v14 database without one whose structure is whole. */
// No time is kept in it: the upgrade that writes it is held to leave the very rows an uninterrupted one leaves, whenever it was stopped and went on.
const STAMP_DDL = "CREATE TABLE schema_stamp(singleton INTEGER PRIMARY KEY CHECK(singleton=1), fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64)) STRICT";

/** A statement without the layout it was written in: whitespace runs are one space. What it says is all that is kept. */
export function normalized(sql: string): string { return sql.replace(/\s+/gu, " ").trim(); }
/** The digest of a structure: its normalized statements, in order. */
export function fingerprintOf(statements: readonly string[]): string {
  const hash = createHash("sha256");
  for (const statement of statements) hash.update(normalized(statement)).update("\n");
  return hash.digest("hex");
}
/** The fingerprint of the table structure this build writes. */
export const SCHEMA_V14_FINGERPRINT: string = fingerprintOf(schemaV14Definition());

const hasStamp = (db: DatabaseSync): boolean => one(db, "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='schema_stamp'") !== undefined;
/** The fingerprint a database carries; null when it carries none. */
export function readStamp(db: DatabaseSync): string | null {
  if (!hasStamp(db)) return null;
  const row = one(db, "SELECT fingerprint FROM schema_stamp WHERE singleton=1");
  return row === undefined ? null : String(row.fingerprint);
}
/** Writes this build's fingerprint, in the caller's transaction. */
export function stampSchema(db: DatabaseSync): void {
  if (!hasStamp(db)) db.exec(STAMP_DDL);
  db.prepare("INSERT INTO schema_stamp(singleton,fingerprint) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET fingerprint=excluded.fingerprint").run(SCHEMA_V14_FINGERPRINT);
}

/** The objects (tables, indexes, triggers) the definition makes, as a database made from it holds them: the reference an unstamped database is compared with. */
function reference(): ReadonlyMap<string, { readonly type: string; readonly sql: string; readonly columns: readonly string[] }> {
  const scratch = new DatabaseSync(":memory:");
  try {
    for (const statement of schemaV14Definition()) scratch.exec(statement);
    const made = new Map<string, { type: string; sql: string; columns: readonly string[] }>();
    for (const row of all(scratch, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")) {
      const name = String(row.name), type = String(row.type);
      made.set(type + " " + name, { type, sql: normalized(String(row.sql)), columns: type === "table" ? all(scratch, "PRAGMA table_xinfo(" + JSON.stringify(name) + ")").map(column => String(column.name)) : [] });
    }
    return made;
  } finally { scratch.close(); }
}
/**
 * How a database differs from the structure this build writes, by the names of the objects: missing, or made by other words. `sessions` is held to its columns alone (a database upgraded from v13
 * has them by `ALTER`, in the same order, with the words of v13 around them). Extra objects are no difference (the relay's tables, the events, the full-text tables, the upgrade's bookkeeping).
 */
export function structureDifferences(db: DatabaseSync): readonly string[] {
  const found: string[] = [];
  for (const [key, expected] of reference()) {
    const name = key.slice(key.indexOf(" ") + 1);
    const row = one(db, "SELECT sql FROM sqlite_master WHERE type=? AND name=?", expected.type, name);
    if (row === undefined) { found.push(expected.type + " " + name + " is missing"); continue; }
    if (expected.type === "table" && name === "sessions") {
      const have = new Set(all(db, "PRAGMA table_xinfo(\"sessions\")").map(column => String(column.name)));
      const lacking = expected.columns.filter(column => !have.has(column));
      if (lacking.length > 0) found.push("table sessions lacks " + lacking.join(", "));
    } else if (normalized(String(row.sql)) !== expected.sql) found.push(expected.type + " " + name + " is not as this build writes it");
  }
  return found;
}

export type StructureVerdict =
  /** The database carries this build's fingerprint. */
  | { readonly kind: "stamped" }
  /** It carries none (it was made before the stamp), and its structure is this build's: it can be stamped. */
  | { readonly kind: "unstamped-whole" }
  /** It carries another build's fingerprint, or none and a structure that differs. `detail` names no conversation: fingerprints, or objects of the structure. */
  | { readonly kind: "mismatch"; readonly detail: string };
/** Whether a v14 database is the structure of this build, read-only. */
export function judgeStructure(db: DatabaseSync): StructureVerdict {
  const stamp = readStamp(db);
  if (stamp === SCHEMA_V14_FINGERPRINT) return { kind: "stamped" };
  if (stamp !== null) return { kind: "mismatch", detail: "it was written by a build whose table structure has the fingerprint " + stamp.slice(0, 12) + ", this build's is " + SCHEMA_V14_FINGERPRINT.slice(0, 12) };
  const differences = structureDifferences(db);
  if (differences.length === 0) return { kind: "unstamped-whole" };
  return { kind: "mismatch", detail: "it carries no fingerprint and " + differences.slice(0, 5).join("; ") + (differences.length > 5 ? "; and " + (differences.length - 5) + " more" : "") };
}
/** The refusal a mismatch is told as: a code of its own, and words that name no conversation. */
export function structureMismatch(detail: string): SessionError {
  return new SessionError("SCHEMA_MISMATCH", "this database's table structure is inconsistent with this build (" + detail + "); it was not changed. Use the build that wrote it, or restore a copy of the data from before that build.");
}
