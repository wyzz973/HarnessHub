import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { SessionError } from "../../contracts/session.js";
import type { Columns, Rec } from "./rows.js";

/*
 * Prepared statements, kept per connection by their text: preparing is the largest part of a small statement's cost, and a commit or a
 * page read runs a handful of fixed statements. The cache lives as long as the connection (a WeakMap keyed by it); SQLite prepares
 * a statement again by itself when the schema changed under it.
 */

const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
export function prepared(db: DatabaseSync, sql: string): StatementSync {
  let statements = cache.get(db);
  if (statements === undefined) { statements = new Map(); cache.set(db, statements); }
  let statement = statements.get(sql);
  if (statement === undefined) {
    // The texts are a few dozen fixed ones and the UPDATEs of a few sets of columns; a cache that grows past a thousand has met something it should not keep.
    if (statements.size >= 1024) statements.clear();
    statement = db.prepare(sql); statements.set(sql, statement);
  }
  return statement;
}
export function one(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): Rec | undefined { return prepared(db, sql).get(...args); }
export function all(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): Rec[] { return prepared(db, sql).all(...args); }

const names = (columns: Columns): string[] => Object.keys(columns);
const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");
/** `INSERT INTO table(columns) VALUES(…)`; `conflict` is what follows (`ON CONFLICT DO NOTHING`), if anything. */
export function insertInto(db: DatabaseSync, table: string, columns: Columns, conflict = ""): void {
  const keys = names(columns);
  prepared(db, "INSERT INTO " + table + "(" + keys.join(",") + ") VALUES(" + placeholders(keys.length) + ")" + (conflict === "" ? "" : " " + conflict)).run(...keys.map(key => columns[key]!));
}
/** `UPDATE table SET … WHERE key = …` over the columns given; the number of rows it changed. */
export function updateRow(db: DatabaseSync, table: string, set: Columns, where: Columns): number {
  const setKeys = names(set), whereKeys = names(where);
  if (setKeys.length === 0) return 0;
  const result = prepared(db, "UPDATE " + table + " SET " + setKeys.map(key => key + "=?").join(",") + " WHERE " + whereKeys.map(key => key + "=?").join(" AND "))
    .run(...setKeys.map(key => set[key]!), ...whereKeys.map(key => where[key]!));
  return Number(result.changes);
}
/** The columns of `next` that differ from the stored row `current`, leaving out `except`. */
export function changedColumns(current: Rec, next: Columns, except: readonly string[]): Columns {
  const changed: Columns = {};
  for (const key of names(next)) if (!except.includes(key) && current[key] !== next[key]) changed[key] = next[key]!;
  return changed;
}
/** The names of the identity columns of `next` that differ from the stored row: a row never becomes another. */
export function identityChanged(current: Rec, next: Columns, identity: readonly string[]): string[] { return identity.filter(key => current[key] !== next[key]); }

/**
 * What SQLite reports for a write that breaks a rule of ours (a key, a check, a trigger of schema-v14.ts) is a failure of that one write:
 * the writer broke an invariant, and it ends the one Turn or the one request it belonged to. It is told as a SessionError of the
 * conversation, and never as a failure of the store: a store that cannot be trusted is a full disk, a broken file, a lost owner.
 */
export function refused(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code !== "number" || (code & 0xff) !== 19) return error;
  const failure = new SessionError(code === 1811 ? "INVALID_TRANSITION" : "INVALID_DATA", error.message);
  failure.cause = error;
  return failure;
}
