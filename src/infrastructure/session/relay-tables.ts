import type { DatabaseSync } from "node:sqlite";
import { RELAY_PREF_KEYS, RELAY_INDEX_BYTES, parseRelayPacket, type RelayBehindIndex, type RelayIndexRow, type RelayPacket } from "../../contracts/relay.js";
import { SessionError, runId, type SessionId } from "../../contracts/session.js";

/**
 * The v13 relay tables (ADR-055 §14.1) in the business database: their DDL (the old store's, which the migration climbs from), and the reads of a conversation's packets
 * and index rows. What a commit writes for the relay, and the checks that come first, are relay-rows-v14.ts (over the rows of a conversation kept as tables).
 */

/**
 * The installation's preferences table: its key list is RELAY_PREF_KEYS, so a key added to the contract is in the DDL a new database
 * is made with, and repairRelayPrefs brings a database made with a shorter list up to it.
 */
export const RELAY_PREFS_DDL = "CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN(" + RELAY_PREF_KEYS.map(key => "'" + key + "'").join(",") + ")),\n"
  + "  value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT;";
/**
 * The relay tables and triggers of relay-architecture §14.1 as slim.md left them; its closing
 * `PRAGMA user_version=13` is the migration's, which sets it once every Session is converted.
 */
export const RELAY_DDL = `
CREATE TABLE relay_bodies(session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), body TEXT NOT NULL,
  PRIMARY KEY(session_id, sha256)) STRICT;                                             -- 按会话计量与回收（RT3 P14、RT1-m2）
CREATE TABLE relay_packets(session_id TEXT NOT NULL REFERENCES sessions(id), packet_id TEXT NOT NULL CHECK(packet_id GLOB 'relay-*'),
  kind TEXT NOT NULL CHECK(kind IN('packet','delta')), tier TEXT NOT NULL CHECK(tier IN('full','brief')),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')),
  body_sha256 TEXT NOT NULL, est_tokens INTEGER NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=65536),      -- 只含由正文决定的字段；逐 Run 的（含脱敏上下文）在 relay_deliveries（F08）
  PRIMARY KEY(session_id, packet_id), FOREIGN KEY(session_id, body_sha256) REFERENCES relay_bodies(session_id, sha256)) STRICT;
CREATE TABLE relay_deliveries(session_id TEXT NOT NULL, run_id TEXT NOT NULL, packet_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('text_block','single_text')),
  handoff_log_seq INTEGER, input_hmac TEXT NOT NULL, auto_resend INTEGER NOT NULL CHECK(auto_resend IN(0,1)),         -- 第一次向该 Harness 交接时写的 relay_log 行；是否为自动补发的那一次
  redaction_rules_version TEXT NOT NULL, redaction_key_id TEXT NOT NULL, redaction_set_hmac TEXT NOT NULL,            -- 本次渲染的脱敏上下文：逐 Run，不进按正文去重的清单
  outcome TEXT NOT NULL CHECK(outcome IN('in_flight','recorded','not_recorded','unknown')),
  evidence TEXT CHECK(evidence IN('E1','E3')), reason TEXT, decided_seq INTEGER, decided_at INTEGER,
  PRIMARY KEY(session_id, run_id), FOREIGN KEY(session_id, packet_id) REFERENCES relay_packets(session_id, packet_id),
  CHECK((outcome='in_flight') = (evidence IS NULL AND reason IS NULL AND decided_seq IS NULL)),
  CHECK(outcome<>'recorded' OR evidence IS NOT NULL), CHECK(outcome NOT IN('not_recorded','unknown') OR reason IS NOT NULL)) STRICT;
CREATE TABLE relay_index(session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, run_index INTEGER NOT NULL,          -- 迁移自 v12 的 Run 在哪个原生会话跑的（没有 run.relay 的旧 Run 才读它）
  index_json TEXT NOT NULL CHECK(json_valid(index_json) AND length(CAST(index_json AS BLOB))<=2048), PRIMARY KEY(session_id, run_id)) STRICT;
CREATE TABLE relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, harness_id TEXT NOT NULL UNIQUE, first_at INTEGER NOT NULL) STRICT;       -- 第一次向某个 Harness 交接：安装级、只追加、每个 Harness 一行
${RELAY_PREFS_DDL}                                                          -- 安装级偏好（F07）
CREATE TRIGGER relay_bodies_immutable BEFORE UPDATE ON relay_bodies BEGIN SELECT RAISE(ABORT,'relay body is immutable'); END;
CREATE TRIGGER relay_packets_immutable BEFORE UPDATE ON relay_packets BEGIN SELECT RAISE(ABORT,'relay packet is immutable'); END;
CREATE TRIGGER relay_log_immutable BEFORE UPDATE ON relay_log BEGIN SELECT RAISE(ABORT,'relay log is append-only'); END;
CREATE TRIGGER relay_deliveries_transition BEFORE UPDATE OF outcome ON relay_deliveries
  WHEN NOT ((OLD.outcome='in_flight') OR (OLD.outcome=NEW.outcome))
  BEGIN SELECT RAISE(ABORT,'illegal delivery transition'); END;                                                                               -- 同值写放行：reason 细化
`;
/**
 * Brings the preferences table of a database made when the contract listed other keys (its CHECK lists the keys of its time) up
 * to the contract's: the table is rebuilt with the rows whose key the contract still lists (renamed, recreated, copied, dropped),
 * inside the caller's transaction. A database whose table lists exactly the contract's keys is left alone; one without the table
 * is not a v13 one. Returns whether it rebuilt it.
 */
export function repairRelayPrefs(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='relay_prefs'").get();
  if (row === undefined) return false;
  const definition = String(row.sql), listed = [...definition.matchAll(/'(relay\.[A-Za-z]+)'/gu)].map(match => match[1]!);
  if (listed.length === RELAY_PREF_KEYS.length && RELAY_PREF_KEYS.every(key => listed.includes(key))) return false;
  database.exec("ALTER TABLE relay_prefs RENAME TO relay_prefs_old");
  database.exec(RELAY_PREFS_DDL);
  database.exec("INSERT INTO relay_prefs(key,value,updated_at) SELECT key,value,updated_at FROM relay_prefs_old WHERE key IN(" + RELAY_PREF_KEYS.map(key => "'" + key + "'").join(",") + ")");
  database.exec("DROP TABLE relay_prefs_old");
  return true;
}
/** The relay tables, the order a purge empties a Session's (references before what they reference). */
export const RELAY_TABLES = ["relay_deliveries", "relay_packets", "relay_bodies", "relay_index", "relay_log", "relay_prefs"] as const;

function utf8(text: string): number { return Buffer.byteLength(text, "utf8"); }

/** The manifests of the packets a Session keeps, in the order they were first written (G068 phase two). */
export function readPackets(database: DatabaseSync, id: SessionId): readonly RelayPacket[] {
  return database.prepare("SELECT manifest_json FROM relay_packets WHERE session_id=? ORDER BY rowid").all(id).map(row => parseRelayPacket(JSON.parse(String(row.manifest_json))));
}
/** One packet's manifest by its identity in the Session; null when the Session keeps none (a packet of another Session is none). */
export function readPacket(database: DatabaseSync, id: SessionId, packetId: string): RelayPacket | null {
  const row = database.prepare("SELECT manifest_json FROM relay_packets WHERE session_id=? AND packet_id=?").get(id, packetId);
  return row === undefined ? null : parseRelayPacket(JSON.parse(String(row.manifest_json)));
}
/** The text kept for a digest in the Session, byte for byte as it was stored; null when none is kept (the HTTP API serves it, G073). */
export function readPacketBody(database: DatabaseSync, id: SessionId, sha256: string): string | null {
  const row = database.prepare("SELECT body FROM relay_bodies WHERE session_id=? AND sha256=?").get(id, sha256);
  if (row === undefined) return null;
  if (typeof row.body !== "string") throw new SessionError("INVALID_DATA", "a stored handoff text is not text");
  return row.body;
}
/** A Session's index rows, in Run order: where each Run of a migrated v12 Session ran (the Runs the migration indexed, which carry no `relay` of their own). */
export function readIndexRows(database: DatabaseSync, id: SessionId): readonly RelayIndexRow[] {
  return database.prepare("SELECT run_id,index_json FROM relay_index WHERE session_id=? ORDER BY run_index").all(id).map(row => {
    const index: unknown = JSON.parse(String(row.index_json));
    if (index === null || typeof index !== "object" || Array.isArray(index)) throw new SessionError("INVALID_DATA", "a relay index is not an object");
    return { runId: runId(row.run_id), index: index as Readonly<Record<string, unknown>> };
  });
}
/** The index rows a v13 migration writes for a Session's finished dispatched Runs (§14.4). */
export function writeBehindIndexes(database: DatabaseSync, id: SessionId, runs: readonly RelayBehindIndex[]): void {
  const insert = database.prepare("INSERT INTO relay_index(session_id,run_id,run_index,index_json) VALUES(?,?,?,?)");
  for (const run of runs) {
    const index = JSON.stringify(run);
    if (utf8(index) > RELAY_INDEX_BYTES) throw new SessionError("INVALID_DATA", "a migrated index exceeds its byte budget");
    insert.run(id, run.runId, run.index, index);
  }
}
