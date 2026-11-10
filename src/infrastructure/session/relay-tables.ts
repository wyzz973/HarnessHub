import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DELIVERY_TRANSITIONS, RELAY_BODY_BYTES, RELAY_DIGEST_BYTES, RELAY_INDEX_BYTES, RELAY_PINS, RELAY_PINS_BYTES, RELAY_SESSION_BODY_BYTES, RELAY_WINDOW_RETENTION_MS, RELAY_WORKSPACE_BYTES,
  RelayError, packetsOf, parseDeliveryOutcome, parseDeliveryRecord, parseRelayExclusion, parseRelayPacket, parseRelayPin, parseRelayWindow, parseWorkspaceObservation, policyVersion,
  redactionTag, type DeliveryOutcome, type DeliveryRecord, type DeliveryStatus, type RelayBehindIndex, type RelayCommitResult, type RelayDerivedRows, type RelayDigestWrite,
  type RelayExclusion, type RelayIndexRow, type RelayPacket, type RelayPin, type RelayRows, type RelayWindow, type RelayWorkspaceWrite, type RelayWriteRows, type RunRelay,
} from "../../contracts/relay.js";
import { SessionError, runId, type PublicRun, type RunId, type SessionId, type SessionSnapshot } from "../../contracts/session.js";

/**
 * The v13 relay tables (ADR-055 §14.1) in the business database: their DDL, and the checks and statements that write
 * them. Every bound is checked on serialized bytes and every transition in TypeScript before any statement runs, so that
 * an expected relay failure is a RelayError for one Run and SQLite constraints only ever assert (INV-35). Called only by
 * SqliteSessionStore, inside its transactions.
 */

/**
 * The 11 tables and 4 triggers of relay-architecture §14.1, verbatim with their comments; its closing
 * `PRAGMA user_version=13` is the migration's, which sets it once every Session is converted.
 */
export const RELAY_DDL = `
CREATE TABLE relay_bodies(session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), body TEXT NOT NULL,
  PRIMARY KEY(session_id, sha256)) STRICT;                                             -- 按会话计量与回收（RT3 P14、RT1-m2）
CREATE TABLE relay_packets(session_id TEXT NOT NULL REFERENCES sessions(id), packet_id TEXT NOT NULL CHECK(packet_id GLOB 'relay-*'),
  kind TEXT NOT NULL CHECK(kind IN('packet','delta','anchor','resend')), tier TEXT NOT NULL CHECK(tier IN('goal','brief','standard','fidelity','full')),
  complete INTEGER NOT NULL CHECK(complete IN(0,1)), reanchor INTEGER NOT NULL CHECK(reanchor IN(0,1)),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, target_vendor TEXT NOT NULL, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), base_packet_id TEXT, supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')), facts_fingerprint TEXT NOT NULL, observation_seq INTEGER,
  body_sha256 TEXT NOT NULL, est_tokens INTEGER NOT NULL, untrusted_tokens INTEGER NOT NULL, user_tokens INTEGER NOT NULL, estimator TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=65536),      -- 只含由正文决定的字段；逐 Run 的（含脱敏上下文）在 relay_deliveries（F08）
  PRIMARY KEY(session_id, packet_id), FOREIGN KEY(session_id, body_sha256) REFERENCES relay_bodies(session_id, sha256)) STRICT;
CREATE TABLE relay_deliveries(session_id TEXT NOT NULL, run_id TEXT NOT NULL, packet_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('text_block','single_text')), position_json TEXT NOT NULL CHECK(json_valid(position_json) AND length(CAST(position_json AS BLOB))<=4096),
  consent_log_seq INTEGER, input_hmac TEXT NOT NULL, attach_override INTEGER NOT NULL CHECK(attach_override IN(0,1)), resend_of TEXT,
  redaction_rules_version TEXT NOT NULL, redaction_key_id TEXT NOT NULL, redaction_set_hmac TEXT NOT NULL,            -- 本次渲染的脱敏上下文：逐 Run，不进按正文去重的清单
  compaction_count INTEGER, compaction_digest TEXT,                                                                     -- 送达时的压缩游标（VF1-08）
  outcome TEXT NOT NULL CHECK(outcome IN('in_flight','recorded','not_recorded','unknown')),
  evidence TEXT CHECK(evidence IN('E1','E2','E3','legacy','origin','native')), reason TEXT, decided_seq INTEGER, decided_at INTEGER, verify_ms INTEGER, verified_in_run TEXT,
  realized_requests INTEGER, realized_cache_hits INTEGER, realized_closed_by TEXT CHECK(realized_closed_by IN('compaction','clear','epoch','idle')),
  PRIMARY KEY(session_id, run_id), FOREIGN KEY(session_id, packet_id) REFERENCES relay_packets(session_id, packet_id),
  CHECK((outcome='in_flight') = (evidence IS NULL AND reason IS NULL AND decided_seq IS NULL)),
  CHECK(outcome<>'recorded' OR evidence IS NOT NULL), CHECK(outcome NOT IN('not_recorded','unknown') OR reason IS NOT NULL)) STRICT;
CREATE TABLE relay_digests(session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, run_index INTEGER NOT NULL, policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('current','behind')), secret_set_hmac TEXT NOT NULL,                            -- 失败只标 behind（6.4），没有 failed 状态
  index_json TEXT NOT NULL CHECK(json_valid(index_json) AND length(CAST(index_json AS BLOB))<=2048),      -- 窄列在前：定档只读它（RT3 P05）
  digest_json TEXT NOT NULL CHECK(json_valid(digest_json) AND length(CAST(digest_json AS BLOB))<=65536), sha256 TEXT NOT NULL,
  PRIMARY KEY(session_id, run_id, policy_version), UNIQUE(session_id, run_index, policy_version)) STRICT;   -- 升 relay/2 不覆盖旧摘要（RT1-m5）
CREATE TABLE relay_workspace(session_id TEXT NOT NULL REFERENCES sessions(id), observed_seq INTEGER NOT NULL, run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('git','tree','unavailable')), status TEXT NOT NULL, branch TEXT, head TEXT, fingerprint TEXT, duration_ms INTEGER NOT NULL,
  counted_total INTEGER NOT NULL, counted_listed INTEGER NOT NULL,
  files_json TEXT NOT NULL CHECK(json_valid(files_json) AND length(CAST(files_json AS BLOB))<=131072), PRIMARY KEY(session_id, observed_seq)) STRICT;   -- ≤1,000 项（RT3 P04）
CREATE TABLE relay_pins(session_id TEXT NOT NULL REFERENCES sessions(id), pin_id TEXT NOT NULL, message_id TEXT NOT NULL, author TEXT NOT NULL CHECK(author IN('user','assistant')),
  start_offset INTEGER NOT NULL CHECK(start_offset>=0), length INTEGER NOT NULL CHECK(length BETWEEN 1 AND 2048), quote_hmac TEXT NOT NULL,   -- 按位置存，不存原文（F09）；渲染时取原消息子串
  pinned_seq INTEGER NOT NULL, withdrawn_seq INTEGER, PRIMARY KEY(session_id, pin_id)) STRICT;                                                -- 界面写“≤680 字”（RT1-B6）
CREATE TABLE relay_exclusions(session_id TEXT NOT NULL REFERENCES sessions(id), exclusion_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('run','section')), ref TEXT NOT NULL,
  added_seq INTEGER NOT NULL, withdrawn_seq INTEGER, PRIMARY KEY(session_id, exclusion_id)) STRICT;                                           -- RT4 M12
CREATE TABLE relay_windows(harness_id TEXT NOT NULL, control_id TEXT NOT NULL, model_key TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL CHECK(size>0),
  first_turn_used INTEGER, observed_at INTEGER NOT NULL, PRIMARY KEY(harness_id, control_id, model_key)) STRICT;                                 -- model_key 经 normalizeModel；'' 为模型未知（VF2-04）
CREATE TABLE relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN('consent','revoke')),
  vendor TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN('global','session')), session_id TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL CHECK(decision IN('acknowledged','goal_only','revoked')), categories_json TEXT NOT NULL CHECK(json_valid(categories_json)),
  policy_version TEXT NOT NULL, auth_kind TEXT, decided_at INTEGER NOT NULL) STRICT;                                                          -- 安装级、只追加（RT1-M9）
CREATE TABLE relay_log_archive(seq INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, vendor TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT NOT NULL,
  decision TEXT NOT NULL, categories_json TEXT NOT NULL, policy_version TEXT NOT NULL, auth_kind TEXT, decided_at INTEGER NOT NULL, archived_at INTEGER NOT NULL) STRICT;   -- 触顶轮转（F21）
CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN('relay.crossVendor','relay.returnPreference','relay.allowUnprobed','relay.localModelsOffline')),
  value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT;                                                          -- 安装级偏好（F07）
CREATE TRIGGER relay_bodies_immutable BEFORE UPDATE ON relay_bodies BEGIN SELECT RAISE(ABORT,'relay body is immutable'); END;
CREATE TRIGGER relay_packets_immutable BEFORE UPDATE ON relay_packets BEGIN SELECT RAISE(ABORT,'relay packet is immutable'); END;
CREATE TRIGGER relay_log_immutable BEFORE UPDATE ON relay_log BEGIN SELECT RAISE(ABORT,'relay log is append-only'); END;
CREATE TRIGGER relay_deliveries_transition BEFORE UPDATE OF outcome ON relay_deliveries
  WHEN NOT ((OLD.outcome='in_flight') OR (OLD.outcome='unknown' AND NEW.outcome IN('unknown','recorded','not_recorded'))
            OR (OLD.outcome='not_recorded' AND NEW.outcome='recorded') OR (OLD.outcome='recorded' AND NEW.outcome='recorded'))
  BEGIN SELECT RAISE(ABORT,'illegal delivery transition'); END;                                                                               -- 同值写放行：reason 细化与 realized 结算（VF1-12）
`;
/** The relay tables, the order deleteSession empties a Session's (references before what they reference). */
export const RELAY_TABLES = ["relay_deliveries", "relay_packets", "relay_bodies", "relay_digests", "relay_workspace", "relay_pins", "relay_exclusions", "relay_windows", "relay_log", "relay_log_archive", "relay_prefs"] as const;
const SESSION_TABLES = RELAY_TABLES.slice(0, 7);
/** The policy version of the index rows a v13 migration writes: no relay policy rendered them (§14.4). */
export const MIGRATED_POLICY = "relay/0";

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
/** Plain JSON object text within `maximum` bytes; anything else is not a row this module writes. */
function jsonObject(value: unknown, maximum: number, label: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new SessionError("INVALID_DATA", label + " must be a plain JSON object");
  const text = JSON.stringify(value);
  if (utf8(text) > maximum) throw new SessionError("INVALID_DATA", label + " exceeds its byte budget");
  return text;
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
interface CheckedOutcome { readonly kind: "outcome"; readonly runId: RunId; readonly from: DeliveryStatus; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }>; readonly verifyMs: number | undefined }
/** Authoritative rows checked against the snapshot they are written with; only statements that cannot fail remain. */
export interface CheckedRelayRows {
  readonly packets: readonly CheckedPacket[];
  readonly deliveries: readonly (CheckedDelivery | CheckedOutcome)[];
  readonly pins: readonly ({ readonly kind: "add"; readonly pin: RelayPin } | { readonly kind: "withdraw"; readonly pinId: string; readonly withdrawnSeq: number })[];
  readonly exclusions: readonly ({ readonly kind: "add"; readonly exclusion: RelayExclusion } | { readonly kind: "withdraw"; readonly exclusionId: string; readonly withdrawnSeq: number })[];
}
const NONE: CheckedRelayRows = { packets: [], deliveries: [], pins: [], exclusions: [] };

/**
 * Checks a transaction's authoritative relay rows against `next`, the snapshot they are committed with, reading what the
 * session already holds: packet manifests, fold, text digests and the 64 MiB text quota (RELAY_PREPARE_FAILED render,
 * render_mismatch, storage_quota); one delivery per Run, a packet each names, and outcome changes along
 * DELIVERY_TRANSITIONS (INVALID_TRANSITION otherwise); pins within their count and bytes on a message of the Session
 * (RELAY_PIN_LIMIT); exclusions of the Session's own Runs and sections. Runs no statement that writes.
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
    if (write.verifyMs !== undefined && (!Number.isSafeInteger(write.verifyMs) || write.verifyMs < 0)) throw new SessionError("INVALID_DATA", "verify time is invalid");
    touched.set(write.runId, outcome.kind); deliveries.push({ kind: "outcome", runId: write.runId, from, outcome, verifyMs: write.verifyMs });
  }
  const pins: CheckedRelayRows["pins"][number][] = [];
  const active = database.prepare("SELECT pin_id,length FROM relay_pins WHERE session_id=? AND withdrawn_seq IS NULL").all(id).map(row => ({ pinId: String(row.pin_id), length: integer(row.length, "pin length") }));
  for (const write of rows.pins ?? []) {
    if (write.kind === "add") {
      const pin = parseRelayPin(write.pin), message = next.messages.find(row => row.id === pin.messageId);
      if (message === undefined || message.role !== pin.author || pin.offset + pin.length > utf8(message.text) || pin.pinnedSeq > next.lastSeq) throw new SessionError("INVALID_INPUT", "a pin names no part of a message of this conversation");
      if (database.prepare("SELECT 1 AS found FROM relay_pins WHERE session_id=? AND pin_id=?").get(id, pin.pinId) !== undefined || pins.some(row => row.kind === "add" && row.pin.pinId === pin.pinId)) throw new SessionError("INVALID_INPUT", "a pin with this identity exists");
      active.push({ pinId: pin.pinId, length: pin.length });
      if (active.length > RELAY_PINS || active.reduce((total, row) => total + row.length, 0) > RELAY_PINS_BYTES) throw new SessionError("RELAY_PIN_LIMIT", "a conversation keeps at most " + RELAY_PINS + " pins of " + RELAY_PINS_BYTES + " bytes in all");
      pins.push({ kind: "add", pin });
    } else {
      const index = active.findIndex(row => row.pinId === write.pinId);
      if (index < 0 || !Number.isSafeInteger(write.withdrawnSeq) || write.withdrawnSeq < 1 || write.withdrawnSeq > next.lastSeq) throw new SessionError("INVALID_INPUT", "no such pin to withdraw");
      active.splice(index, 1); pins.push({ kind: "withdraw", pinId: write.pinId, withdrawnSeq: write.withdrawnSeq });
    }
  }
  const exclusions: CheckedRelayRows["exclusions"][number][] = [];
  for (const write of rows.exclusions ?? []) {
    if (write.kind === "add") {
      const exclusion = parseRelayExclusion(write.exclusion);
      if (exclusion.kind === "run" && !next.runs.some(run => run.id === exclusion.ref) || exclusion.addedSeq > next.lastSeq) throw new SessionError("INVALID_INPUT", "an exclusion names no Turn of this conversation");
      if (database.prepare("SELECT 1 AS found FROM relay_exclusions WHERE session_id=? AND exclusion_id=?").get(id, exclusion.exclusionId) !== undefined) throw new SessionError("INVALID_INPUT", "an exclusion with this identity exists");
      exclusions.push({ kind: "add", exclusion });
    } else {
      const row = database.prepare("SELECT withdrawn_seq FROM relay_exclusions WHERE session_id=? AND exclusion_id=?").get(id, write.exclusionId);
      if (row === undefined || row.withdrawn_seq !== null || !Number.isSafeInteger(write.withdrawnSeq) || write.withdrawnSeq < 1 || write.withdrawnSeq > next.lastSeq) throw new SessionError("INVALID_INPUT", "no such exclusion to withdraw");
      exclusions.push({ kind: "withdraw", exclusionId: write.exclusionId, withdrawnSeq: write.withdrawnSeq });
    }
  }
  return { packets, deliveries, pins, exclusions };
}
/**
 * Every packet a relay state of `next` names that `before` did not (its bindings' sync states, its Runs' packets) is kept
 * for the Session (relay-architecture §14.3: references across the snapshot and the relay rows are checked on write).
 * Called after a transaction wrote its packets; INVALID_DATA names a reference that was not written.
 */
export function checkPacketReferences(database: DatabaseSync, id: SessionId, before: SessionSnapshot | null, next: SessionSnapshot): void {
  const known = new Set<string>();
  const named = (sync: Parameters<typeof packetsOf>[0] | undefined) => sync === undefined ? [] : packetsOf(sync);
  for (const binding of before?.nativeBindings ?? []) for (const packetId of named(binding.relay?.sync)) known.add(packetId);
  for (const run of before?.runs ?? []) if (run.relay?.packetId != null) known.add(run.relay.packetId);
  const wanted = new Set<string>();
  for (const binding of next.nativeBindings ?? []) for (const packetId of named(binding.relay?.sync)) if (!known.has(packetId)) wanted.add(packetId);
  for (const run of next.runs) { const relay: RunRelay | undefined = run.relay; if (relay?.packetId != null && !known.has(relay.packetId)) wanted.add(relay.packetId); }
  for (const packetId of wanted) if (database.prepare("SELECT 1 AS found FROM relay_packets WHERE session_id=? AND packet_id=?").get(id, packetId) === undefined)
    throw new SessionError("INVALID_DATA", "a relay state names a packet this conversation does not keep");
}
/** Writes rows checkRelayRows checked, in the same transaction; packets and texts already kept are left as they are. */
export function writeRelayRows(database: DatabaseSync, id: SessionId, rows: CheckedRelayRows): void {
  const body = database.prepare("INSERT INTO relay_bodies(session_id,sha256,bytes,body) VALUES(?,?,?,?) ON CONFLICT(session_id, sha256) DO NOTHING");
  const packet = database.prepare("INSERT INTO relay_packets(session_id,packet_id,kind,tier,complete,reanchor,target_harness,target_control,target_model,target_vendor,native_epoch,from_seq,through_seq,base_packet_id,supersedes_packet_id,policy_version,language,facts_fingerprint,observation_seq,body_sha256,est_tokens,untrusted_tokens,user_tokens,estimator,manifest_json) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id, packet_id) DO NOTHING");
  for (const row of rows.packets) {
    const p = row.packet;
    if (row.freshBody) body.run(id, p.body.sha256, p.body.bytes, row.body);
    if (row.fresh) packet.run(id, p.id, p.kind, p.tier, p.complete ? 1 : 0, p.reanchor ? 1 : 0, p.target.harnessId, p.target.controlId, p.target.model, p.target.vendor, p.target.nativeEpoch,
      p.range.fromSeq, p.range.throughSeq, p.basePacketId, p.supersedes, p.policyVersion, p.language, p.factsFingerprint, p.workspaceObservationSeq, p.body.sha256, p.body.estTokens, p.body.untrustedTokens, p.body.userTokens, p.body.estimator, row.manifest);
  }
  for (const row of rows.deliveries) {
    if (row.kind === "insert") {
      const r = row.record;
      database.prepare("INSERT INTO relay_deliveries(session_id,run_id,packet_id,channel,position_json,consent_log_seq,input_hmac,attach_override,resend_of,redaction_rules_version,redaction_key_id,redaction_set_hmac,compaction_count,compaction_digest,outcome,verify_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'in_flight',?)")
        .run(id, r.runId, r.packetId, r.channel, JSON.stringify(r.position), r.consentLogSeq, r.inputHmac, r.attachOverride ? 1 : 0, r.resendOf, r.redaction.rulesVersion, r.redaction.keyId, r.redaction.setHmac,
          r.compactionAtDelivery?.count ?? null, r.compactionAtDelivery?.digest ?? null, r.verifyMs);
      continue;
    }
    const o = row.outcome, evidence = o.kind === "recorded" ? o.evidence : null, reason = o.kind === "recorded" ? null : o.reason, verified = o.kind === "recorded" ? o.verifiedInRun : null;
    // The outcome is set only when it changes, so the transition trigger never sees a same-value write (VF1-12).
    const outcome = row.from === o.kind ? "" : "outcome=?,";
    const values = [...(row.from === o.kind ? [] : [o.kind]), evidence, reason, o.decidedSeq, o.decidedAt, verified, ...(row.verifyMs === undefined ? [] : [row.verifyMs]), id, row.runId];
    database.prepare("UPDATE relay_deliveries SET " + outcome + "evidence=?,reason=?,decided_seq=?,decided_at=?,verified_in_run=?" + (row.verifyMs === undefined ? "" : ",verify_ms=?") + " WHERE session_id=? AND run_id=?").run(...values);
  }
  for (const row of rows.pins) {
    if (row.kind === "add") { const p = row.pin; database.prepare("INSERT INTO relay_pins(session_id,pin_id,message_id,author,start_offset,length,quote_hmac,pinned_seq) VALUES(?,?,?,?,?,?,?,?)").run(id, p.pinId, p.messageId, p.author, p.offset, p.length, p.quoteHmac, p.pinnedSeq); }
    else database.prepare("UPDATE relay_pins SET withdrawn_seq=? WHERE session_id=? AND pin_id=? AND withdrawn_seq IS NULL").run(row.withdrawnSeq, id, row.pinId);
  }
  for (const row of rows.exclusions) {
    if (row.kind === "add") { const e = row.exclusion; database.prepare("INSERT INTO relay_exclusions(session_id,exclusion_id,kind,ref,added_seq) VALUES(?,?,?,?,?)").run(id, e.exclusionId, e.kind, e.ref, e.addedSeq); }
    else database.prepare("UPDATE relay_exclusions SET withdrawn_seq=? WHERE session_id=? AND exclusion_id=? AND withdrawn_seq IS NULL").run(row.withdrawnSeq, id, row.exclusionId);
  }
}
interface CheckedDigest { readonly write: RelayDigestWrite; readonly index: string; readonly digest: string; readonly sha256: string }
function checkDigest(state: SessionSnapshot, write: RelayDigestWrite): CheckedDigest {
  const run = state.runs[write.runIndex];
  if (run === undefined || run.id !== write.runId || !TERMINAL.has(run.status)) throw new SessionError("INVALID_DATA", "a digest names no finished Turn at its index");
  policyVersion(write.policyVersion);
  if (write.status !== "current" && write.status !== "behind") throw new SessionError("INVALID_DATA", "unknown digest status");
  if (write.secretSetHmac !== "") redactionTag(write.secretSetHmac);
  const digest = jsonObject(write.digest, RELAY_DIGEST_BYTES, "a digest");
  return { write, index: jsonObject(write.index, RELAY_INDEX_BYTES, "a digest index"), digest, sha256: sha256(digest) };
}
/**
 * Writes a Run's digest row. A transaction's row replaces any row of its Run and policy; a background row (`keepCurrent`)
 * leaves a current row as it is. Either removes the Run's rows of other policies, in the same transaction (§14.1).
 */
function writeDigest(database: DatabaseSync, id: SessionId, row: CheckedDigest, keepCurrent: boolean): boolean {
  const w = row.write;
  if (keepCurrent && database.prepare("SELECT status FROM relay_digests WHERE session_id=? AND run_id=? AND policy_version=?").get(id, w.runId, w.policyVersion)?.status === "current") return false;
  database.prepare("DELETE FROM relay_digests WHERE session_id=? AND run_id=? AND policy_version<>?").run(id, w.runId, w.policyVersion);
  database.prepare("INSERT INTO relay_digests(session_id,run_id,run_index,policy_version,status,secret_set_hmac,index_json,digest_json,sha256) VALUES(?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(session_id, run_id, policy_version) DO UPDATE SET run_index=excluded.run_index,status=excluded.status,secret_set_hmac=excluded.secret_set_hmac,index_json=excluded.index_json,digest_json=excluded.digest_json,sha256=excluded.sha256")
    .run(id, w.runId, w.runIndex, w.policyVersion, w.status, w.secretSetHmac, row.index, row.digest, row.sha256);
  return true;
}
function writeWorkspace(database: DatabaseSync, id: SessionId, state: SessionSnapshot, write: RelayWorkspaceWrite): void {
  runOf(state, write.runId, "a workspace observation");
  if (!Number.isSafeInteger(write.observedSeq) || write.observedSeq < 1 || write.observedSeq > state.lastSeq) throw new SessionError("INVALID_DATA", "a workspace observation is after the Session's events");
  const observation = parseWorkspaceObservation(write.observation), files = JSON.stringify(observation);
  if (utf8(files) > RELAY_WORKSPACE_BYTES) throw new SessionError("INVALID_DATA", "a workspace observation exceeds its byte budget");
  const columns = observation.kind === "git" ? [observation.status, observation.branch, observation.head, observation.fingerprint, observation.durationMs, observation.counted.total, observation.counted.listed]
    : observation.kind === "tree" ? [observation.status, null, null, observation.fingerprint, observation.durationMs, observation.counted, observation.files.length]
    : [observation.reason, null, null, null, 0, 0, 0];
  database.prepare("INSERT INTO relay_workspace(session_id,observed_seq,run_id,kind,status,branch,head,fingerprint,duration_ms,counted_total,counted_listed,files_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id, observed_seq) DO NOTHING")
    .run(id, write.observedSeq, write.runId, observation.kind, ...columns, files);
}
/** Why something failed, without values: a SessionError's message, SQLite's generic text, or the error's name. */
export function diagnosticOf(error: unknown): string {
  if (error instanceof SessionError) return error.code + ": " + error.message;
  if (error instanceof Error) { const errstr = (error as Error & { readonly errstr?: unknown }).errstr; return typeof errstr === "string" ? errstr : error.name; }
  return "unknown failure";
}
/**
 * Derived rows in a SAVEPOINT of their own (relay-architecture §6.4, §14.1): `derived` is called inside it, so its own
 * failures (a scanner error, a bound, a statement) roll back only these rows and leave the Run's digest behind. A failure
 * that ended the whole transaction is not contained.
 */
export function writeDerivedRows(database: DatabaseSync, id: SessionId, state: SessionSnapshot, derived: (() => RelayDerivedRows) | undefined): RelayCommitResult {
  if (derived === undefined) return { derived: "none" };
  database.exec("SAVEPOINT relay_derived");
  try {
    const rows = derived();
    const digests = (rows.digests ?? []).map(write => checkDigest(state, write));
    for (const row of digests) writeDigest(database, id, row, false);
    for (const write of rows.workspace ?? []) writeWorkspace(database, id, state, write);
    database.exec("RELEASE relay_derived");
    return { derived: "written" };
  } catch (error) {
    if (!database.isTransaction) throw error;
    database.exec("ROLLBACK TO relay_derived"); database.exec("RELEASE relay_derived");
    return { derived: "behind", diagnostic: diagnosticOf(error) };
  }
}
/** Checks rows relayWrite writes outside snapshots (digests, realized counts); invalid rows throw before any statement. */
export function checkRelayWrite(database: DatabaseSync, id: SessionId, state: SessionSnapshot, rows: RelayWriteRows): { readonly digests: readonly CheckedDigest[]; readonly realized: readonly { readonly runId: RunId; readonly requests: number; readonly cacheHits: number; readonly closedBy: string }[] } {
  const digests = (rows.digests ?? []).map(write => checkDigest(state, write));
  const realized = (rows.realized ?? []).map(row => {
    runOf(state, row.runId, "realized counts");
    const value = row.realized;
    if (!Number.isSafeInteger(value.requests) || value.requests < 0 || !Number.isSafeInteger(value.cacheHits) || value.cacheHits < 0 || !["compaction", "clear", "epoch", "idle"].includes(value.closedBy)) throw new SessionError("INVALID_DATA", "realized counts are invalid");
    if (database.prepare("SELECT 1 AS found FROM relay_deliveries WHERE session_id=? AND run_id=?").get(id, row.runId) === undefined) throw new SessionError("INVALID_DATA", "realized counts name a Turn without a delivery");
    return { runId: row.runId, requests: value.requests, cacheHits: value.cacheHits, closedBy: value.closedBy };
  });
  return { digests, realized };
}
/** Writes checked relayWrite rows: a current digest stays, settled realized counts stay; the outcome is never written. */
export function writeRelayWrite(database: DatabaseSync, id: SessionId, rows: ReturnType<typeof checkRelayWrite>): void {
  for (const row of rows.digests) writeDigest(database, id, row, true);
  for (const row of rows.realized)
    database.prepare("UPDATE relay_deliveries SET realized_requests=?,realized_cache_hits=?,realized_closed_by=? WHERE session_id=? AND run_id=? AND realized_closed_by IS NULL").run(row.requests, row.cacheHits, row.closedBy, id, row.runId);
}
/** The Session's delivery rows in Run order (by the snapshot's Run order). */
export function readDeliveries(database: DatabaseSync, id: SessionId, state: SessionSnapshot): readonly DeliveryRecord[] {
  const order = new Map(state.runs.map((run, index) => [run.id as string, index]));
  const rows = database.prepare("SELECT * FROM relay_deliveries WHERE session_id=?").all(id).map(row => parseDeliveryRecord({
    runId: row.run_id, packetId: row.packet_id, channel: row.channel, position: JSON.parse(String(row.position_json)), consentLogSeq: row.consent_log_seq, inputHmac: row.input_hmac,
    redaction: { rulesVersion: row.redaction_rules_version, keyId: row.redaction_key_id, setHmac: row.redaction_set_hmac },
    compactionAtDelivery: row.compaction_count === null ? null : { count: row.compaction_count, digest: row.compaction_digest }, resendOf: row.resend_of, attachOverride: row.attach_override === 1,
    verifyMs: row.verify_ms, realized: row.realized_closed_by === null ? null : { requests: row.realized_requests, cacheHits: row.realized_cache_hits, closedBy: row.realized_closed_by },
    outcome: row.outcome === "in_flight" ? { kind: "in_flight" } : row.outcome === "recorded" ? { kind: "recorded", evidence: row.evidence, decidedSeq: row.decided_seq, decidedAt: row.decided_at, verifiedInRun: row.verified_in_run }
      : { kind: row.outcome, reason: row.reason, decidedSeq: row.decided_seq, decidedAt: row.decided_at },
  }));
  return rows.sort((a, b) => (order.get(a.runId) ?? 0) - (order.get(b.runId) ?? 0));
}
/** The manifests of the packets a Session keeps, in the order they were first written (G068 phase two). */
export function readPackets(database: DatabaseSync, id: SessionId): readonly RelayPacket[] {
  return database.prepare("SELECT manifest_json FROM relay_packets WHERE session_id=? ORDER BY rowid").all(id).map(row => parseRelayPacket(JSON.parse(String(row.manifest_json))));
}
/** A Session's digest index rows (every policy version) as plain objects, in Run order (G068 phase two reads the facts from them). */
export function readIndexRows(database: DatabaseSync, id: SessionId): readonly RelayIndexRow[] {
  return database.prepare("SELECT run_id,policy_version,status,index_json FROM relay_digests WHERE session_id=? ORDER BY run_index, policy_version").all(id).map(row => {
    const index: unknown = JSON.parse(String(row.index_json));
    if (index === null || typeof index !== "object" || Array.isArray(index)) throw new SessionError("INVALID_DATA", "a relay digest index is not an object");
    const status = String(row.status);
    if (status !== "current" && status !== "behind") throw new SessionError("INVALID_DATA", "a relay digest status is invalid");
    return { runId: runId(row.run_id), policyVersion: policyVersion(row.policy_version), status, index: index as Readonly<Record<string, unknown>> };
  });
}
/** The behind index rows a v13 migration writes for a Session's finished dispatched Runs (§14.4; the digest is "{}"). */
export function writeBehindIndexes(database: DatabaseSync, id: SessionId, runs: readonly RelayBehindIndex[]): void {
  const insert = database.prepare("INSERT INTO relay_digests(session_id,run_id,run_index,policy_version,status,secret_set_hmac,index_json,digest_json,sha256) VALUES(?,?,?,?,'behind','',?,'{}',?)");
  const empty = sha256("{}");
  for (const run of runs) {
    const index = JSON.stringify(run);
    if (utf8(index) > RELAY_INDEX_BYTES) throw new SessionError("INVALID_DATA", "a migrated digest index exceeds its byte budget");
    insert.run(id, run.runId, run.index, MIGRATED_POLICY, index, empty);
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
/** Keeps the latest observed window of a Harness control and model (installation level; the last writer wins). */
export function upsertRelayWindow(database: DatabaseSync, window: RelayWindow): void {
  const row = parseRelayWindow(window);
  database.prepare("INSERT INTO relay_windows(harness_id,control_id,model_key,size,first_turn_used,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(harness_id, control_id, model_key) DO UPDATE SET size=excluded.size,first_turn_used=excluded.first_turn_used,observed_at=excluded.observed_at")
    .run(row.harnessId, row.controlId, row.modelKey, row.size, row.firstTurnUsed, row.observedAt);
}
/** Removes windows observed more than RELAY_WINDOW_RETENTION_MS before `now` (at each start, §14.1); returns how many. */
export function pruneRelayWindows(database: DatabaseSync, now: number): number {
  return Number(database.prepare("DELETE FROM relay_windows WHERE observed_at<?").run(now - RELAY_WINDOW_RETENTION_MS).changes);
}
