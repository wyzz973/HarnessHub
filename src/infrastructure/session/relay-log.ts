import type { DatabaseSync } from "node:sqlite";
import {
  RELAY_LOG_ARCHIVE_ROWS, RELAY_LOG_ROWS, RELAY_PREF_KEYS, RelayError, parseConsentRecord, parseRelayPref, type ConsentAppend, type ConsentRecord, type RelayPrefKey,
} from "../../contracts/relay.js";
import { SessionError } from "../../contracts/session.js";

/**
 * The installation's relay consent log and preferences (ADR-055 §10.4, §14.1, F07, F21) in the business database. The log
 * is append-only: each consent or revocation is one row with its own seq and a unique command id; at RELAY_LOG_ROWS rows it
 * is rotated in the appending transaction, keeping the latest row of each vendor, scope and Session and moving the rest to
 * relay_log_archive, which only grows (consent records are audit records) up to RELAY_LOG_ARCHIVE_ROWS. Called only by
 * SqliteSessionStore, inside its transactions.
 */

function count(database: DatabaseSync, table: "relay_log" | "relay_log_archive"): number {
  const value = database.prepare("SELECT count(*) AS count FROM " + table).get()?.count;
  if (typeof value !== "number") throw new SessionError("INVALID_DATA", table + " count is unreadable");
  return value;
}
function full(message: string): RelayError { return new RelayError({ code: "RELAY_UNAVAILABLE", reason: "consent_log_full" }, message); }
function recordOf(row: Readonly<Record<string, unknown>>): ConsentRecord {
  let categories: unknown;
  try { categories = JSON.parse(String(row.categories_json)); } catch { throw new SessionError("INVALID_DATA", "a consent record's categories are unreadable"); }
  return parseConsentRecord({ logSeq: row.seq, commandId: row.command_id, vendor: row.vendor, scope: row.scope === "session" ? { kind: "session", sessionId: row.session_id } : { kind: "global" },
    decision: row.decision, categories, policyVersion: row.policy_version, authKind: row.auth_kind, decidedAt: row.decided_at });
}
function same(left: ConsentRecord, right: ConsentAppend): boolean {
  const { logSeq: _seq, ...rest } = left;
  return JSON.stringify(rest) === JSON.stringify({ commandId: right.commandId, vendor: right.vendor, scope: right.scope, decision: right.decision, categories: right.categories,
    policyVersion: right.policyVersion, authKind: right.authKind, decidedAt: right.decidedAt });
}
/**
 * Moves every row but the latest of each vendor, scope and Session to the archive, stamped `archivedAt`. RelayError
 * RELAY_UNAVAILABLE (consent_log_full) before moving anything when the archive would pass its bound.
 */
function rotate(database: DatabaseSync, archivedAt: number): void {
  const kept = "SELECT MAX(seq) FROM relay_log GROUP BY vendor, scope, session_id";
  const moving = database.prepare("SELECT count(*) AS count FROM relay_log WHERE seq NOT IN (" + kept + ")").get()?.count;
  if (typeof moving !== "number") throw new SessionError("INVALID_DATA", "relay log rotation count is unreadable");
  if (count(database, "relay_log_archive") + moving > RELAY_LOG_ARCHIVE_ROWS) throw full("the relay consent archive is full");
  database.prepare("INSERT INTO relay_log_archive(seq,command_id,kind,vendor,scope,session_id,decision,categories_json,policy_version,auth_kind,decided_at,archived_at) " +
    "SELECT seq,command_id,kind,vendor,scope,session_id,decision,categories_json,policy_version,auth_kind,decided_at,? FROM relay_log WHERE seq NOT IN (" + kept + ")").run(archivedAt);
  database.prepare("DELETE FROM relay_log WHERE seq NOT IN (" + kept + ")").run();
}
/**
 * Appends one consent decision and returns it with its seq. The same command again returns the record it made (from the
 * log or its archive); another decision under the same command id is IDEMPOTENCY_CONFLICT. A full log is rotated first;
 * when rotation leaves it full, or would pass the archive's bound, RelayError RELAY_UNAVAILABLE (consent_log_full) and
 * nothing is written.
 */
export function appendConsent(database: DatabaseSync, record: ConsentAppend, now: number): ConsentRecord {
  const checked = parseConsentRecord({ ...record, logSeq: 1 });
  const { logSeq: _seq, ...append } = checked;
  for (const table of ["relay_log", "relay_log_archive"] as const) {
    const prior = database.prepare("SELECT * FROM " + table + " WHERE command_id=?").get(append.commandId);
    if (prior === undefined) continue;
    const existing = recordOf(prior);
    if (!same(existing, append)) throw new SessionError("IDEMPOTENCY_CONFLICT", "this consent command already recorded another decision");
    return existing;
  }
  if (count(database, "relay_log") >= RELAY_LOG_ROWS) {
    rotate(database, now);
    if (count(database, "relay_log") >= RELAY_LOG_ROWS) throw full("the relay consent log holds a latest decision for as many vendors and conversations as it can keep");
  }
  const scope = append.scope.kind, sessionId = append.scope.kind === "session" ? append.scope.sessionId : "";
  const inserted = database.prepare("INSERT INTO relay_log(command_id,kind,vendor,scope,session_id,decision,categories_json,policy_version,auth_kind,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(append.commandId, append.decision === "revoked" ? "revoke" : "consent", append.vendor, scope, sessionId, append.decision, JSON.stringify(append.categories), append.policyVersion, append.authKind, append.decidedAt);
  return { ...append, logSeq: Number(inserted.lastInsertRowid) };
}
/** Whether any delivery row names the log row `logSeq` as the consent it rests on (a default allowance is "used" once a handoff rested on it). */
export function consentNamed(database: DatabaseSync, logSeq: number): boolean {
  return database.prepare("SELECT 1 AS found FROM relay_deliveries WHERE consent_log_seq=? LIMIT 1").get(logSeq) !== undefined;
}
/** The current consent view: the latest record of each vendor, scope and Session, oldest first. */
export function currentConsents(database: DatabaseSync): readonly ConsentRecord[] {
  return database.prepare("SELECT * FROM relay_log WHERE seq IN (SELECT MAX(seq) FROM relay_log GROUP BY vendor, scope, session_id) ORDER BY seq").all().map(recordOf);
}
/** Sets one installation preference (the last writer wins); its key and value are checked first (RELAY_PREF_VALUES). */
export function writePref(database: DatabaseSync, key: RelayPrefKey, value: string, now: number): void {
  const pref = parseRelayPref(key, value);
  try { database.prepare("INSERT INTO relay_prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(pref.key, pref.value, now); }
  catch (error) {
    // A constraint of the table that does not admit a preference the contract does (a database made with fewer keys, which opening repairs) is a
    // refusal of this write; it is not a failure of the storage, and does not stop the Store (G072 review m4).
    if (error !== null && typeof error === "object" && "errcode" in error && (error.errcode === 19 || (typeof error.errcode === "number" && (error.errcode & 0xff) === 19)))
      throw new SessionError("INVALID_INPUT", "this installation's database does not accept the preference " + pref.key);
    throw error;
  }
}
export function readPrefs(database: DatabaseSync): Readonly<Partial<Record<RelayPrefKey, string>>> {
  const prefs: Partial<Record<RelayPrefKey, string>> = {};
  for (const row of database.prepare("SELECT key,value FROM relay_prefs ORDER BY key").all()) {
    const pref = parseRelayPref(row.key, row.value);
    if ((RELAY_PREF_KEYS as readonly string[]).includes(pref.key)) prefs[pref.key] = pref.value;
  }
  return prefs;
}
