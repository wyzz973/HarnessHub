import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DELIVERY_TRANSITIONS, RELAY_PREF_KEYS, RELAY_BODY_BYTES, RELAY_INDEX_BYTES, RELAY_SESSION_BODY_BYTES,
  RelayError, packetsOf, parseDeliveryOutcome, parseDeliveryRecord, parseRelayPacket,
  type DeliveryOutcome, type DeliveryRecord, type DeliveryStatus, type RelayBehindIndex, type RelayIndexRow, type RelayPacket, type RelayRows, type RunRelay,
} from "../../contracts/relay.js";
import { SessionError, runId, type PublicRun, type RunId, type SessionId, type SessionSnapshot } from "../../contracts/session.js";

/**
 * The v13 relay tables (ADR-055 §14.1) in the business database: their DDL, and the checks and statements that write
 * them. Every bound is checked on serialized bytes and every transition in TypeScript before any statement runs, so that
 * an expected relay failure is a RelayError for one Run and SQLite constraints only ever assert (INV-35). Called only by
 * SqliteSessionStore, inside its transactions.
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
  kind TEXT NOT NULL CHECK(kind IN('packet','delta','anchor','resend')), tier TEXT NOT NULL CHECK(tier IN('goal','brief','standard','fidelity','full')),
  complete INTEGER NOT NULL CHECK(complete IN(0,1)),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), base_packet_id TEXT, supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')), facts_fingerprint TEXT NOT NULL,
  body_sha256 TEXT NOT NULL, est_tokens INTEGER NOT NULL, untrusted_tokens INTEGER NOT NULL, user_tokens INTEGER NOT NULL, estimator TEXT NOT NULL,
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
/** The relay tables, the order deleteSession empties a Session's (references before what they reference). */
export const RELAY_TABLES = ["relay_deliveries", "relay_packets", "relay_bodies", "relay_index", "relay_log", "relay_prefs"] as const;
const SESSION_TABLES = RELAY_TABLES.slice(0, 4);

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function utf8(text: string): number { return Buffer.byteLength(text, "utf8"); }
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SessionError("INVALID_DATA", label + " is not an integer");
  return value;
}
function prepareFailed(reason: "render" | "render_mismatch" | "storage" | "storage_quota", message: string): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason }, message);
}
/** A failure a relay check reports as an expected relay failure: it fails one Run, never the transaction's owner. */
function asRender<T>(check: () => T, message: string): T {
  try { return check(); }
  catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") throw prepareFailed("render", message + ": " + error.message); throw error; }
}
function userSeq(state: SessionSnapshot, run: PublicRun): number {
  const message = state.messages.find(row => row.id === run.userMessageId);
  if (message === undefined) throw new SessionError("INVALID_DATA", "a Run lacks its user message");
  return message.seq;
}
function runOf(state: SessionSnapshot, id: RunId, label: string): PublicRun {
  const run = state.runs.find(row => row.id === id);
  if (run === undefined) throw new SessionError("INVALID_DATA", label + " names a Run of another Session");
  return run;
}
const TERMINAL = new Set<PublicRun["status"]>(["completed", "cancelled", "failed", "unknown"]);

/**
 * The fold check that replaces K7's check of `sourceRunIds` (ADR-055 §14.1, RT1-M1, F12): every Run a packet's fold
 * quotes (a unit, a range, an exclusion) has finished and its user message came before the current input's.
 */
export function checkFold(state: SessionSnapshot, current: PublicRun, packet: RelayPacket): void {
  const before = userSeq(state, current);
  const quoted = (index: number): void => {
    const run = state.runs[index];
    if (run === undefined || run.id === current.id || !TERMINAL.has(run.status)) throw prepareFailed("render", "the relay packet quotes a Turn that has not finished");
    if (userSeq(state, run) >= before) throw prepareFailed("render", "the relay packet quotes a Turn accepted after the current input");
  };
  for (const unit of packet.fold) {
    if (unit.kind === "range") { for (let index = unit.fromRun; index <= unit.throughRun; index++) quoted(index); }
    else quoted(unit.runIndex);
  }
}
interface CheckedPacket { readonly packet: RelayPacket; readonly body: string; readonly manifest: string; readonly fresh: boolean; readonly freshBody: boolean }
interface CheckedDelivery { readonly kind: "insert"; readonly record: DeliveryRecord }
interface CheckedOutcome { readonly kind: "outcome"; readonly runId: RunId; readonly from: DeliveryStatus; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }> }
/** Authoritative rows checked against the snapshot they are written with; only statements that cannot fail remain. */
export interface CheckedRelayRows {
  readonly packets: readonly CheckedPacket[];
  readonly deliveries: readonly (CheckedDelivery | CheckedOutcome)[];
}
const NONE: CheckedRelayRows = { packets: [], deliveries: [] };

/**
 * Checks a transaction's authoritative relay rows against `next`, the snapshot they are committed with, reading what the
 * session already holds: packet manifests, fold, text digests and the 64 MiB text quota (RELAY_PREPARE_FAILED render,
 * render_mismatch, storage_quota); one delivery per Run, a packet each names, and outcome changes along
 * DELIVERY_TRANSITIONS (INVALID_TRANSITION otherwise). Runs no statement that writes.
 */
export function checkRelayRows(database: DatabaseSync, id: SessionId, next: SessionSnapshot, rows: RelayRows | undefined): CheckedRelayRows {
  if (rows === undefined) return NONE;
  const packets: CheckedPacket[] = [], bodies = new Set<string>();
  let addedBytes = 0;
  for (const write of rows.packets ?? []) {
    const packet = asRender(() => parseRelayPacket(write.packet), "the relay packet manifest is invalid");
    const current = runOf(next, write.runId, "a relay packet");
    if (typeof write.body !== "string" || write.body.includes("\0")) throw prepareFailed("render", "the relay packet text is invalid");
    const bytes = utf8(write.body), digest = sha256(write.body);
    if (bytes < 1 || bytes > RELAY_BODY_BYTES || bytes !== packet.body.bytes || digest !== packet.body.sha256) throw prepareFailed("render", "the relay packet text does not match its manifest");
    if (packet.target.harnessId !== current.selection.harnessId || packet.target.controlId !== current.selection.controlId) throw prepareFailed("render", "the relay packet is for another Harness than its Turn's");
    checkFold(next, current, packet);
    const existing = database.prepare("SELECT body_sha256 FROM relay_packets WHERE session_id=? AND packet_id=?").get(id, packet.id);
    if (existing !== undefined && existing.body_sha256 !== digest) throw prepareFailed("render_mismatch", "a relay packet with this identity holds another text");
    if (packets.some(row => row.packet.id === packet.id && row.packet.body.sha256 !== digest)) throw prepareFailed("render_mismatch", "two relay packets with one identity hold different texts");
    const known = database.prepare("SELECT 1 AS found FROM relay_bodies WHERE session_id=? AND sha256=?").get(id, digest) !== undefined;
    const freshBody = !known && !bodies.has(digest);
    if (freshBody) { bodies.add(digest); addedBytes += bytes; }
    packets.push({ packet, body: write.body, manifest: JSON.stringify(packet), fresh: existing === undefined, freshBody });
  }
  if (addedBytes > 0) {
    const stored = integer(database.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM relay_bodies WHERE session_id=?").get(id)?.bytes, "stored relay text bytes");
    if (stored + addedBytes > RELAY_SESSION_BODY_BYTES) throw prepareFailed("storage_quota", "this conversation's relay packets reached their storage budget");
  }
  const packetKnown = (packetId: string) => packets.some(row => row.packet.id === packetId) || database.prepare("SELECT 1 AS found FROM relay_packets WHERE session_id=? AND packet_id=?").get(id, packetId) !== undefined;
  const deliveries: (CheckedDelivery | CheckedOutcome)[] = [], touched = new Map<string, DeliveryStatus>();
  for (const write of rows.deliveries ?? []) {
    if (write.kind === "insert") {
      const record = asRender(() => parseDeliveryRecord(write.record), "the relay delivery is invalid");
      runOf(next, record.runId, "a relay delivery");
      if (record.outcome.kind !== "in_flight") throw prepareFailed("render", "a relay delivery starts in flight");
      if (touched.has(record.runId) || database.prepare("SELECT 1 AS found FROM relay_deliveries WHERE session_id=? AND run_id=?").get(id, record.runId) !== undefined)
        throw prepareFailed("storage", "this Turn already has a relay delivery");
      if (!packetKnown(record.packetId)) throw prepareFailed("render", "a relay delivery names a packet that is not kept");
      touched.set(record.runId, "in_flight"); deliveries.push({ kind: "insert", record });
      continue;
    }
    const outcome = parseDeliveryOutcome(write.outcome);
    if (outcome.kind === "in_flight") throw new SessionError("INVALID_TRANSITION", "a delivery never goes back in flight");
    runOf(next, write.runId, "a relay delivery outcome");
    const stored = database.prepare("SELECT outcome FROM relay_deliveries WHERE session_id=? AND run_id=?").get(id, write.runId);
    const from = touched.get(write.runId) ?? (stored === undefined ? undefined : stored.outcome as DeliveryStatus);
    if (from === undefined) throw new SessionError("INVALID_DATA", "a delivery outcome names a Turn without a delivery");
    if (!DELIVERY_TRANSITIONS[from].includes(outcome.kind)) throw new SessionError("INVALID_TRANSITION", "illegal delivery transition " + from + " → " + outcome.kind);
    touched.set(write.runId, outcome.kind); deliveries.push({ kind: "outcome", runId: write.runId, from, outcome });
  }
  return { packets, deliveries };
}
/**
 * Every packet a relay state of `next` names that `before` did not (its bindings' sync states, its Runs' packets) is kept
 * for the Session (relay-architecture §14.3: references across the snapshot and the relay rows are checked on write).
 * Called after a transaction wrote its packets; INVALID_DATA names a reference that was not written.
 */
export function checkPacketReferences(database: DatabaseSync, id: SessionId, before: SessionSnapshot | null, next: SessionSnapshot): void {
  const known = new Set<string>();
  const named = (relay: Parameters<typeof packetsOf>[0] | undefined) => relay === undefined ? [] : packetsOf(relay);
  for (const binding of before?.nativeBindings ?? []) for (const packetId of named(binding.relay)) known.add(packetId);
  for (const run of before?.runs ?? []) if (run.relay?.packetId != null) known.add(run.relay.packetId);
  const wanted = new Set<string>();
  for (const binding of next.nativeBindings ?? []) for (const packetId of named(binding.relay)) if (!known.has(packetId)) wanted.add(packetId);
  for (const run of next.runs) { const relay: RunRelay | undefined = run.relay; if (relay?.packetId != null && !known.has(relay.packetId)) wanted.add(relay.packetId); }
  for (const packetId of wanted) if (database.prepare("SELECT 1 AS found FROM relay_packets WHERE session_id=? AND packet_id=?").get(id, packetId) === undefined)
    throw new SessionError("INVALID_DATA", "a relay state names a packet this conversation does not keep");
}
/** Writes rows checkRelayRows checked, in the same transaction; packets and texts already kept are left as they are. */
export function writeRelayRows(database: DatabaseSync, id: SessionId, rows: CheckedRelayRows): void {
  const body = database.prepare("INSERT INTO relay_bodies(session_id,sha256,bytes,body) VALUES(?,?,?,?) ON CONFLICT(session_id, sha256) DO NOTHING");
  const packet = database.prepare("INSERT INTO relay_packets(session_id,packet_id,kind,tier,complete,target_harness,target_control,target_model,native_epoch,from_seq,through_seq,base_packet_id,supersedes_packet_id,policy_version,language,facts_fingerprint,body_sha256,est_tokens,untrusted_tokens,user_tokens,estimator,manifest_json) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id, packet_id) DO NOTHING");
  for (const row of rows.packets) {
    const p = row.packet;
    if (row.freshBody) body.run(id, p.body.sha256, p.body.bytes, row.body);
    if (row.fresh) packet.run(id, p.id, p.kind, p.tier, p.complete ? 1 : 0, p.target.harnessId, p.target.controlId, p.target.model, p.target.nativeEpoch,
      p.range.fromSeq, p.range.throughSeq, p.basePacketId, p.supersedes, p.policyVersion, p.language, p.factsFingerprint, p.body.sha256, p.body.estTokens, p.body.untrustedTokens, p.body.userTokens, p.body.estimator, row.manifest);
  }
  for (const row of rows.deliveries) {
    if (row.kind === "insert") {
      const r = row.record;
      database.prepare("INSERT INTO relay_deliveries(session_id,run_id,packet_id,channel,handoff_log_seq,input_hmac,auto_resend,redaction_rules_version,redaction_key_id,redaction_set_hmac,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,'in_flight')")
        .run(id, r.runId, r.packetId, r.channel, r.handoffLogSeq, r.inputHmac, r.autoResend ? 1 : 0, r.redaction.rulesVersion, r.redaction.keyId, r.redaction.setHmac);
      continue;
    }
    const o = row.outcome, evidence = o.kind === "recorded" ? o.evidence : null, reason = o.kind === "recorded" ? null : o.reason;
    // The outcome is set only when it changes, so the transition trigger never sees a same-value write.
    const outcome = row.from === o.kind ? "" : "outcome=?,";
    const values = [...(row.from === o.kind ? [] : [o.kind]), evidence, reason, o.decidedSeq, o.decidedAt, id, row.runId];
    database.prepare("UPDATE relay_deliveries SET " + outcome + "evidence=?,reason=?,decided_seq=?,decided_at=? WHERE session_id=? AND run_id=?").run(...values);
  }
}
/** The Session's delivery rows in Run order (by the snapshot's Run order). */
export function readDeliveries(database: DatabaseSync, id: SessionId, state: SessionSnapshot): readonly DeliveryRecord[] {
  const order = new Map(state.runs.map((run, index) => [run.id as string, index]));
  const rows = database.prepare("SELECT * FROM relay_deliveries WHERE session_id=?").all(id).map(row => parseDeliveryRecord({
    runId: row.run_id, packetId: row.packet_id, channel: row.channel, handoffLogSeq: row.handoff_log_seq, inputHmac: row.input_hmac, autoResend: row.auto_resend === 1,
    redaction: { rulesVersion: row.redaction_rules_version, keyId: row.redaction_key_id, setHmac: row.redaction_set_hmac },
    outcome: row.outcome === "in_flight" ? { kind: "in_flight" } : row.outcome === "recorded" ? { kind: "recorded", evidence: row.evidence, decidedSeq: row.decided_seq, decidedAt: row.decided_at }
      : { kind: row.outcome, reason: row.reason, decidedSeq: row.decided_seq, decidedAt: row.decided_at },
  }));
  return rows.sort((a, b) => (order.get(a.runId) ?? 0) - (order.get(b.runId) ?? 0));
}
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
/** Removes every relay row of one Session (deleteSession), in the order that keeps references valid. */
export function deleteRelayRows(database: DatabaseSync, id: SessionId): void {
  for (const table of SESSION_TABLES) database.prepare("DELETE FROM " + table + " WHERE session_id=?").run(id);
}
/** Row counts of the relay tables, for reading a backup back (ADR-049). */
export function relayRowCounts(database: DatabaseSync): Readonly<Record<string, number>> {
  return Object.fromEntries(RELAY_TABLES.map(table => [table, integer(database.prepare("SELECT count(*) AS count FROM " + table).get()?.count, table + " rows")]));
}
