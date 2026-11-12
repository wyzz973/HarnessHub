import type { DatabaseSync } from "node:sqlite";
import { SessionError, sessionId, type SessionId } from "../../contracts/session.js";
import { migrationEvents, readLegacySession } from "./legacy/ladder.js";
import { migrateSession } from "./legacy/migrate.js";
import { RELAY_INDEX_BYTES } from "./legacy/relay-contract.js";
import { parseSession, utf8Bytes } from "./legacy/state.js";
import { all } from "./statements.js";

/*
 * What can be known of an upgrade before it changes anything, kept apart from the frozen folder (legacy/ is not edited; this wraps it).
 *
 *   `trialLadder`    what the old ladder (legacy/ladder.ts `climbToV13`) does to ONE conversation, done in memory with the same frozen functions and written nowhere: the
 *                    reads and parses of every step from the database's version to 12, then the v12 to v13 inference and the parse of its result. It throws what the ladder
 *                    would throw for that conversation.
 *   `ladderFaults`   every conversation of a database of version 1 to 12 for which `trialLadder` throws, with the reason. The first transaction of the upgrade calls it only
 *                    when the ladder has failed (and been rolled back), to say which conversations it was: the success path pays nothing for it. The read-only check of
 *                    `sessions check-upgrade` calls it on a database it only reads.
 *
 * A reason is the program's own words for a rule (a field, a rule: "unknown Run status", "persistent event sequence is inconsistent") and never a value out of a
 * conversation: nothing of what a conversation says reaches an error, a log or a report.
 */

/** One conversation an upgrade cannot take, and why. */
export interface UpgradeFault { readonly sessionId: string; readonly reason: string }

const REASON_BYTES = 200;
/**
 * The category of a failure: a SessionError's message (the frozen parse and the checks say a field or a rule there, never a value), else the kind of the error and nothing it says
 * (an engine's message may quote the text it choked on).
 */
export function reasonOf(error: unknown): string {
  if (error instanceof SessionError) return error.message.length <= REASON_BYTES ? error.message : error.message.slice(0, REASON_BYTES) + "...";
  // SQLite's own words name a table, a column or a rule and never a value.
  if (error instanceof Error && (error as { code?: unknown }).code === "ERR_SQLITE_ERROR") return "database: " + error.message.slice(0, REASON_BYTES);
  return "unexpected " + (error instanceof Error ? error.name : "failure");
}

/** The ladder's work on one conversation of a database at `from` (1 to 12), in memory. */
export function trialLadder(db: DatabaseSync, id: SessionId, from: number): void {
  if (!Number.isSafeInteger(from) || from < 1 || from > 12) throw new SessionError("INVALID_INPUT", "only a database of version 1 to 12 climbs the old ladder");
  let state = readLegacySession(db, id, from);
  // Each step of the ladder writes the conversation as the next version and reads it back at that version.
  for (let version = from; version < 12; version++) {
    state = parseSession(JSON.parse(JSON.stringify(parseSession({ ...state, schemaVersion: version + 1 }))) as unknown);
    if (state.schemaVersion !== version + 1) throw new SessionError("INVALID_DATA", "Session schema and business database version disagree");
  }
  // The step to 13: the inference from the events, the parse of the conversation with its bindings' relay states, and the index rows' byte budget.
  const migrated = migrateSession(state, migrationEvents(db, state));
  parseSession({ ...state, schemaVersion: 13, ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings.map((binding, index) => ({ ...binding, relay: migrated.bindings[index]! })) }) });
  for (const run of migrated.runs) if (utf8Bytes(JSON.stringify(run)) > RELAY_INDEX_BYTES) throw new SessionError("INVALID_DATA", "a migrated index exceeds its byte budget");
}

/** Every conversation of a database at `from` that the old ladder would not take, in the order of the rows; none for a database that is v13 already (it climbs nothing). */
export function ladderFaults(db: DatabaseSync, from: number): readonly UpgradeFault[] {
  if (from >= 13) return [];
  const faults: UpgradeFault[] = [];
  for (const row of all(db, "SELECT id FROM sessions ORDER BY rowid")) {
    const id = String(row.id);
    try { trialLadder(db, sessionId(id), from); } catch (error) { faults.push({ sessionId: id, reason: reasonOf(error) }); }
  }
  return faults;
}

/** The error of an upgrade that did not begin because the old ladder cannot take some conversations: it says which, why, that nothing was changed, and where the copy is. */
export function refusal(from: number, faults: readonly UpgradeFault[]): SessionError {
  const shown = faults.slice(0, 5).map(fault => fault.sessionId + " (" + fault.reason + ")").join("; ");
  return new SessionError("MIGRATION_REFUSED", "the upgrade of the database from version " + from + " did not begin: " + faults.length + " conversation" + (faults.length === 1 ? "" : "s")
    + " cannot be taken by the upgrade: " + shown + (faults.length > 5 ? "; and " + (faults.length - 5) + " more" : "") + ". Nothing was changed: the database is still version " + from
    + " and the build that made it still opens it; the copy taken before this try is backups/gateway-v" + from + "-before-v14.sqlite. `sessions check-upgrade --data-dir <the data directory>` lists every such conversation and changes nothing");
}

/**
 * The conversations that hold a Run id another conversation holds too. The old store kept a Run in its conversation's snapshot and asked its id to be unique in that conversation
 * only; the tables of v14 keep a Run id once in the whole store (`runs.run_id`). The Runtime makes every id from a random number, so none are expected; if there are, the upgrade
 * refuses them before it changes anything, as it does the other limits of the tables that two conversations can break between them. `column` is `snapshot` before the first transaction
 * and `head` in it (the conversations already converted are read from their rows).
 */
export function repeatedRunIds(db: DatabaseSync, column: "snapshot" | "head"): readonly UpgradeFault[] {
  const unconverted = column === "head" ? "s.format<14" : "1=1", unconverted2 = column === "head" ? "s2.format<14" : "1=1";
  const converted = column === "head" ? " UNION ALL SELECT session_id, run_id FROM runs" : "";
  const rows = all(db, "SELECT DISTINCT s.id AS session_id FROM sessions s, json_each(s." + column + ",'$.runs') r WHERE " + unconverted + " AND json_extract(r.value,'$.id') IN ("
    + "SELECT run_id FROM (SELECT s2.id AS owner, json_extract(r2.value,'$.id') AS run_id FROM sessions s2, json_each(s2." + column + ",'$.runs') r2 WHERE " + unconverted2 + converted
    + ") GROUP BY run_id HAVING COUNT(DISTINCT owner) > 1) ORDER BY s.rowid");
  return rows.map(row => ({ sessionId: String(row.session_id), reason: "a Run id it holds is held by another conversation too (the tables keep a Run id once)" }));
}
