/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T4): the migration ladder of sqlite-store.ts `claimAndRecover` from Session v1 to v13, with the pieces it
 * stands on (the v13 relay tables, the events the v12 to v13 inference reads, the index rows it writes, the read of a stored Session), as they were at the
 * end of store v13 (commit 1a5f020) and WITHOUT their limits lifted. The first transaction of the v14 migration climbs an old database to v13 with exactly
 * this code before it converts to the tables, so that what an old database means does not change with the live code. Do not edit it and do not import a
 * live parser into it; tests/integration/legacy-parse.test.ts holds the folder to its imports.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RelayBehindIndex } from "../../../contracts/relay.js";
import { SessionError, sessionId, type SessionId, type SessionSnapshot } from "../../../contracts/session.js";
import { migrateSession, type MigrationEvent } from "./migrate.js";
import { RELAY_INDEX_BYTES } from "./relay-contract.js";
import { MAX_SESSION_BYTES, parseSession, utf8Bytes } from "./state.js";

/** The relay tables and triggers of Session v13 (relay-tables.ts RELAY_DDL at the end of v13); its closing `PRAGMA user_version=13` is the ladder's. */
export const RELAY_DDL_V13 = `
CREATE TABLE relay_bodies(session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), body TEXT NOT NULL,
  PRIMARY KEY(session_id, sha256)) STRICT;
CREATE TABLE relay_packets(session_id TEXT NOT NULL REFERENCES sessions(id), packet_id TEXT NOT NULL CHECK(packet_id GLOB 'relay-*'),
  kind TEXT NOT NULL CHECK(kind IN('packet','delta')), tier TEXT NOT NULL CHECK(tier IN('full','brief')),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')),
  body_sha256 TEXT NOT NULL, est_tokens INTEGER NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=65536),
  PRIMARY KEY(session_id, packet_id), FOREIGN KEY(session_id, body_sha256) REFERENCES relay_bodies(session_id, sha256)) STRICT;
CREATE TABLE relay_deliveries(session_id TEXT NOT NULL, run_id TEXT NOT NULL, packet_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('text_block','single_text')),
  handoff_log_seq INTEGER, input_hmac TEXT NOT NULL, auto_resend INTEGER NOT NULL CHECK(auto_resend IN(0,1)),
  redaction_rules_version TEXT NOT NULL, redaction_key_id TEXT NOT NULL, redaction_set_hmac TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN('in_flight','recorded','not_recorded','unknown')),
  evidence TEXT CHECK(evidence IN('E1','E3')), reason TEXT, decided_seq INTEGER, decided_at INTEGER,
  PRIMARY KEY(session_id, run_id), FOREIGN KEY(session_id, packet_id) REFERENCES relay_packets(session_id, packet_id),
  CHECK((outcome='in_flight') = (evidence IS NULL AND reason IS NULL AND decided_seq IS NULL)),
  CHECK(outcome<>'recorded' OR evidence IS NOT NULL), CHECK(outcome NOT IN('not_recorded','unknown') OR reason IS NOT NULL)) STRICT;
CREATE TABLE relay_index(session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, run_index INTEGER NOT NULL,
  index_json TEXT NOT NULL CHECK(json_valid(index_json) AND length(CAST(index_json AS BLOB))<=2048), PRIMARY KEY(session_id, run_id)) STRICT;
CREATE TABLE relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, harness_id TEXT NOT NULL UNIQUE, first_at INTEGER NOT NULL) STRICT;
CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN('relay.attach')),
  value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER relay_bodies_immutable BEFORE UPDATE ON relay_bodies BEGIN SELECT RAISE(ABORT,'relay body is immutable'); END;
CREATE TRIGGER relay_packets_immutable BEFORE UPDATE ON relay_packets BEGIN SELECT RAISE(ABORT,'relay packet is immutable'); END;
CREATE TRIGGER relay_log_immutable BEFORE UPDATE ON relay_log BEGIN SELECT RAISE(ABORT,'relay log is append-only'); END;
CREATE TRIGGER relay_deliveries_transition BEFORE UPDATE OF outcome ON relay_deliveries
  WHEN NOT ((OLD.outcome='in_flight') OR (OLD.outcome=NEW.outcome))
  BEGIN SELECT RAISE(ABORT,'illegal delivery transition'); END;
`;
/** The event types the v13 inference reads; the others (outputs, tools, permissions) are skipped in SQLite. */
export const MIGRATION_EVENTS = ["session.created", "session.recovered", "message.accepted", "run.context_prepared", "run.native_command", "run.ended", "native.binding_prepared", "native.branch_requested", "native.fork_failed"] as const;

/** The index rows the v13 migration writes for a Session's finished dispatched Runs. */
export function writeBehindIndexes(database: DatabaseSync, id: SessionId, runs: readonly RelayBehindIndex[]): void {
  const insert = database.prepare("INSERT INTO relay_index(session_id,run_id,run_index,index_json) VALUES(?,?,?,?)");
  for (const run of runs) {
    const index = JSON.stringify(run);
    if (utf8Bytes(index) > RELAY_INDEX_BYTES) throw new SessionError("INVALID_DATA", "a migrated index exceeds its byte budget");
    insert.run(id, run.runId, run.index, index);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_DATA", label + " must be an object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new SessionError("INVALID_DATA", label + " must be a safe integer");
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SessionError("INVALID_DATA", label + " must be text");
  return value;
}

/**
 * Reads and validates one stored Session of a database at `version`, with the checks the v13 store made: its size, that it is JSON, that the legacy
 * parse accepts it at that version, that its row and snapshot agree, that its event log is whole. (The checks of size are the old runtime's own bounds: a
 * snapshot over them was never one this runtime could write.)
 */
export function readLegacySession(database: DatabaseSync, id: SessionId, version: number): SessionSnapshot {
  const row = database.prepare("SELECT version,last_seq,octet_length(snapshot) AS bytes FROM sessions WHERE id=?").get(id);
  if (!row) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  if (integer(row.bytes, "Session snapshot bytes") > MAX_SESSION_BYTES) throw new SessionError("INVALID_DATA", "persisted Session byte budget exceeded");
  const serialized = text(database.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)?.snapshot, "Session snapshot");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new SessionError("INVALID_DATA", "persisted Session is not valid JSON"); }
  const state = parseSession(value);
  if (state.schemaVersion !== version) throw new SessionError("INVALID_DATA", "Session schema and business database version disagree");
  if (state.id !== id || state.version !== row.version || state.lastSeq !== row.last_seq) throw new SessionError("INVALID_DATA", "persisted Session row and snapshot disagree");
  const log = database.prepare("SELECT COUNT(*) AS count,MIN(seq) AS first,MAX(seq) AS last FROM events WHERE session_id=?").get(id);
  if (log?.count !== state.lastSeq || (state.lastSeq > 0 && (log.first !== 1 || log.last !== state.lastSeq))) throw new SessionError("INVALID_DATA", "persisted Session and event cursor disagree");
  return state;
}
/** The events the v13 inference reads (MIGRATION_EVENTS), in seq order, each checked as a stored event of its Session. */
export function migrationEvents(database: DatabaseSync, state: SessionSnapshot): readonly MigrationEvent[] {
  const types = MIGRATION_EVENTS.map(() => "?").join(",");
  return database.prepare("SELECT seq,event_json FROM events WHERE session_id=? AND json_extract(event_json,'$.type') IN (" + types + ") ORDER BY seq").all(state.id, ...MIGRATION_EVENTS).map(row => {
    let value: unknown;
    try { value = JSON.parse(text(row.event_json, "event JSON")); } catch { throw new SessionError("INVALID_DATA", "persisted event is not valid JSON"); }
    const event = object(value, "persisted event");
    if (sessionId(event.sessionId) !== state.id || integer(event.seq, "event seq", 1) !== row.seq || (event.seq as number) > state.lastSeq || typeof event.type !== "string") throw new SessionError("INVALID_DATA", "persistent event sequence is inconsistent");
    return { seq: event.seq as number, type: event.type, data: object(event.data, "event data") };
  });
}

/**
 * Brings a database of version `from` (1 to 12) to version 13 in the transaction the caller has open: every Session is parsed at its version and written
 * as the next, and the step to 13 makes the relay tables, gives every native binding the relay state its Session's events prove and writes the index rows.
 * Each step is checked against the schema version of the Session it reads, so a database that holds a Session of another version stops here.
 */
export function climbToV13(database: DatabaseSync, from: number): void {
  if (!Number.isSafeInteger(from) || from < 1 || from > 13) throw new SessionError("INVALID_DATA", "unknown business database schema version");
  for (let version = from; version < 12; version++) {
    for (const row of database.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
      const state = readLegacySession(database, sessionId(row.id), version);
      if (state.schemaVersion !== version) throw new SessionError("INVALID_DATA", "database v" + version + " contains a Session of another version");
      database.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(parseSession({ ...state, schemaVersion: version + 1 })), state.id);
    }
    database.exec("PRAGMA user_version=" + (version + 1));
  }
  if (from <= 12) {
    database.exec(RELAY_DDL_V13);
    for (const row of database.prepare("SELECT id FROM sessions ORDER BY rowid").all()) {
      const state = readLegacySession(database, sessionId(row.id), 12);
      const migrated = migrateSession(state, migrationEvents(database, state));
      const next = parseSession({ ...state, schemaVersion: 13, ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings.map((binding, index) => ({ ...binding, relay: migrated.bindings[index]! })) }) });
      database.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(next), state.id);
      writeBehindIndexes(database, state.id, migrated.runs);
    }
    database.exec("PRAGMA user_version=13");
  }
}
