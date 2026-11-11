import type { DatabaseSync } from "node:sqlite";
import { RELAY_PREF_KEYS, parseHandoffRecord, parseRelayPref, type HandoffRecord, type RelayPrefKey } from "../../contracts/relay.js";
import { SessionError } from "../../contracts/session.js";

/**
 * The installation's handoff log and preference (slim.md) in the business database. The log is append-only and has one row per
 * Harness: the first time a conversation hands its history to a Harness, the row is written before the packet leaves (the packet's
 * delivery names it), and the interface shows its one-time explanation for a Harness that has a row and none before it. The
 * preference table holds the one setting. Called only by SqliteSessionStore, inside its transactions.
 */

function recordOf(row: Readonly<Record<string, unknown>>): HandoffRecord {
  return parseHandoffRecord({ logSeq: row.seq, harnessId: row.harness_id, firstAt: row.first_at });
}
/**
 * The log row of the first handoff to `harnessId`: written when there is none (`created`), else the first one unchanged. A
 * Harness's row is never rewritten.
 */
export function logHandoff(database: DatabaseSync, harnessId: string, now: number): { readonly record: HandoffRecord; readonly created: boolean } {
  const checked = parseHandoffRecord({ logSeq: 1, harnessId, firstAt: now });
  const prior = database.prepare("SELECT * FROM relay_log WHERE harness_id=?").get(checked.harnessId);
  if (prior !== undefined) return { record: recordOf(prior), created: false };
  const inserted = database.prepare("INSERT INTO relay_log(harness_id,first_at) VALUES(?,?)").run(checked.harnessId, checked.firstAt);
  return { record: { logSeq: Number(inserted.lastInsertRowid), harnessId: checked.harnessId, firstAt: checked.firstAt }, created: true };
}
/** The handoff log, oldest first. */
export function handoffRows(database: DatabaseSync): readonly HandoffRecord[] {
  return database.prepare("SELECT * FROM relay_log ORDER BY seq").all().map(recordOf);
}
/** Whether any delivery row names the log row `logSeq` as the handoff it rests on. */
export function handoffNamed(database: DatabaseSync, logSeq: number): boolean {
  return database.prepare("SELECT 1 AS found FROM relay_deliveries WHERE handoff_log_seq=? LIMIT 1").get(logSeq) !== undefined;
}
/** Sets one installation preference (the last writer wins); its key and value are checked first (RELAY_PREF_VALUES). */
export function writePref(database: DatabaseSync, key: RelayPrefKey, value: string, now: number): void {
  const pref = parseRelayPref(key, value);
  try { database.prepare("INSERT INTO relay_prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(pref.key, pref.value, now); }
  catch (error) {
    // A constraint of the table that does not admit a preference the contract does (a database made with another list, which opening
    // repairs) is a refusal of this write; it is not a failure of the storage, and does not stop the Store.
    if (error !== null && typeof error === "object" && "errcode" in error && (error.errcode === 19 || (typeof error.errcode === "number" && (error.errcode & 0xff) === 19)))
      throw new SessionError("INVALID_INPUT", "this installation's database does not accept the preference " + pref.key);
    throw error;
  }
}
export function readPrefs(database: DatabaseSync): Readonly<Partial<Record<RelayPrefKey, string>>> {
  const prefs: Partial<Record<RelayPrefKey, string>> = {};
  for (const row of database.prepare("SELECT key,value FROM relay_prefs ORDER BY key").all()) {
    // A stored key the contract no longer lists (a database made before the preferences were cut down) is not read.
    if (!(RELAY_PREF_KEYS as readonly unknown[]).includes(row.key)) continue;
    const pref = parseRelayPref(row.key, row.value);
    prefs[pref.key] = pref.value;
  }
  return prefs;
}
