import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Conversation, Mutation } from "../../contracts/conversation.js";
import {
  DELIVERY_TRANSITIONS, RELAY_BODY_BYTES, RelayError, packetsOf, parseDeliveryOutcome, parseDeliveryRecord, parseRelayPacket, spanOf,
  type DeliveryOutcome, type DeliveryRecord, type DeliveryStatus, type RelayPacket, type RelayRows,
} from "../../contracts/relay.js";
import { SessionError, type RunId, type SessionId } from "../../contracts/session.js";
import { all, one } from "./statements.js";
import { integer } from "./store-root.js";

/*
 * The relay's rows beside a conversation kept as tables (ADR-057 3.7, ADR-055 §14): what a commit may write for the relay and the checks that come first, over the
 * rows of the database where the first store checked the whole snapshot. The same rules, the same errors (an expected failure is a RelayError that fails one
 * Run and nothing else, a transition that is not along DELIVERY_TRANSITIONS is INVALID_TRANSITION), with one change the no-limits decision made: a conversation's
 * packet texts are no longer refused at a quota. When the texts a conversation keeps would pass `quotaBytes`, the oldest ones that no delivery in flight rests on
 * are let go (the packet's row and its delivery evidence stay; `body_sha256` is null and the text is "not kept"), and a write is never refused for room.
 *
 * Called inside the commit's transaction, after the Runs it concerns are written (a packet is checked against the Run row, which is there by then) and before the head.
 * A throw rolls the whole commit back; none of it disables the store.
 */

const TERMINAL = "('completed','cancelled','failed','unknown')";

function prepareFailed(reason: "render" | "render_mismatch" | "storage" | "storage_quota", message: string): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason }, message);
}
/** A failure a relay check reports as an expected relay failure: it fails one Run, never the transaction's owner. */
function asRender<T>(check: () => T, message: string): T {
  try { return check(); }
  catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") throw prepareFailed("render", message + ": " + error.message); throw error; }
}
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

interface RunKnown { readonly ordinal: number; readonly harnessId: string; readonly controlId: string; readonly userSeq: number }
function runOf(db: DatabaseSync, id: SessionId, run: RunId, label: string): RunKnown {
  const row = one(db, "SELECT ordinal, harness_id, control_id, user_seq FROM runs WHERE run_id=? AND session_id=?", run, id);
  if (row === undefined) throw new SessionError("INVALID_DATA", label + " names a Run of another Session");
  return { ordinal: integer(row.ordinal, "Run ordinal"), harnessId: String(row.harness_id), controlId: String(row.control_id), userSeq: integer(row.user_seq, "Run input seq") };
}

/**
 * The check that replaces K7's check of `sourceRunIds` (ADR-055 §14.1, RT1-M1, F12): every Run a packet quotes has finished and was accepted before the current
 * input. A long list is stored as spans of consecutive ordinals (packRunIndexes); each span is asked of the table in one count, never walked.
 */
function checkQuoted(db: DatabaseSync, id: SessionId, current: RunKnown, currentId: RunId, packet: RelayPacket): void {
  for (const entry of packet.runs) {
    const [first, last] = spanOf(entry);
    const found = integer(one(db, "SELECT COUNT(*) AS n FROM runs WHERE session_id=? AND ordinal BETWEEN ? AND ? AND run_id<>? AND status IN " + TERMINAL + " AND user_seq<?", id, first, last, currentId, current.userSeq)?.n, "quoted Run count");
    if (found === last - first + 1) continue;
    // Something in the span is not a finished Run before the current input; say which kind, as the first store did.
    const finished = integer(one(db, "SELECT COUNT(*) AS n FROM runs WHERE session_id=? AND ordinal BETWEEN ? AND ? AND run_id<>? AND status IN " + TERMINAL, id, first, last, currentId)?.n, "finished Run count");
    throw prepareFailed("render", finished === last - first + 1 ? "the relay packet quotes a Turn accepted after the current input" : "the relay packet quotes a Turn that has not finished");
  }
}

interface CheckedPacket { readonly packet: RelayPacket; readonly body: string; readonly manifest: string; readonly fresh: boolean; readonly freshBody: boolean }
type CheckedDelivery =
  | { readonly kind: "insert"; readonly record: DeliveryRecord }
  | { readonly kind: "outcome"; readonly runId: RunId; readonly from: DeliveryStatus; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }> };
interface Checked { readonly packets: readonly CheckedPacket[]; readonly deliveries: readonly CheckedDelivery[] }

function check(db: DatabaseSync, id: SessionId, rows: RelayRows): Checked {
  const packets: CheckedPacket[] = [], bodies = new Set<string>();
  for (const write of rows.packets ?? []) {
    const packet = asRender(() => parseRelayPacket(write.packet), "the relay packet manifest is invalid");
    const current = runOf(db, id, write.runId, "a relay packet");
    if (typeof write.body !== "string" || write.body.includes("\0")) throw prepareFailed("render", "the relay packet text is invalid");
    const bytes = Buffer.byteLength(write.body, "utf8"), digest = sha256(write.body);
    if (bytes < 1 || bytes > RELAY_BODY_BYTES || bytes !== packet.body.bytes || digest !== packet.body.sha256) throw prepareFailed("render", "the relay packet text does not match its manifest");
    if (packet.target.harnessId !== current.harnessId || packet.target.controlId !== current.controlId) throw prepareFailed("render", "the relay packet is for another Harness than its Turn's");
    checkQuoted(db, id, current, write.runId, packet);
    // The text of the packet is its manifest's digest, whether or not the text is still kept (an evicted text leaves `body_sha256` null).
    const existing = one(db, "SELECT json_extract(manifest_json,'$.body.sha256') AS digest FROM relay_packets WHERE session_id=? AND packet_id=?", id, packet.id);
    if (existing !== undefined && existing.digest !== digest) throw prepareFailed("render_mismatch", "a relay packet with this identity holds another text");
    if (packets.some(row => row.packet.id === packet.id && row.packet.body.sha256 !== digest)) throw prepareFailed("render_mismatch", "two relay packets with one identity hold different texts");
    const known = one(db, "SELECT 1 AS found FROM relay_bodies WHERE session_id=? AND sha256=?", id, digest) !== undefined;
    const freshBody = !known && !bodies.has(digest);
    if (freshBody) bodies.add(digest);
    packets.push({ packet, body: write.body, manifest: JSON.stringify(packet), fresh: existing === undefined, freshBody });
  }
  const packetKnown = (packetId: string): boolean => packets.some(row => row.packet.id === packetId) || one(db, "SELECT 1 AS found FROM relay_packets WHERE session_id=? AND packet_id=?", id, packetId) !== undefined;
  const deliveries: CheckedDelivery[] = [], touched = new Map<string, DeliveryStatus>();
  for (const write of rows.deliveries ?? []) {
    if (write.kind === "insert") {
      const record = asRender(() => parseDeliveryRecord(write.record), "the relay delivery is invalid");
      runOf(db, id, record.runId, "a relay delivery");
      if (record.outcome.kind !== "in_flight") throw prepareFailed("render", "a relay delivery starts in flight");
      if (touched.has(record.runId) || one(db, "SELECT 1 AS found FROM relay_deliveries WHERE session_id=? AND run_id=?", id, record.runId) !== undefined)
        throw prepareFailed("storage", "this Turn already has a relay delivery");
      if (!packetKnown(record.packetId)) throw prepareFailed("render", "a relay delivery names a packet that is not kept");
      touched.set(record.runId, "in_flight"); deliveries.push({ kind: "insert", record });
      continue;
    }
    const outcome = parseDeliveryOutcome(write.outcome);
    if (outcome.kind === "in_flight") throw new SessionError("INVALID_TRANSITION", "a delivery never goes back in flight");
    runOf(db, id, write.runId, "a relay delivery outcome");
    const stored = one(db, "SELECT outcome FROM relay_deliveries WHERE session_id=? AND run_id=?", id, write.runId);
    const from = touched.get(write.runId) ?? (stored === undefined ? undefined : stored.outcome as DeliveryStatus);
    if (from === undefined) throw new SessionError("INVALID_DATA", "a delivery outcome names a Turn without a delivery");
    if (!DELIVERY_TRANSITIONS[from].includes(outcome.kind)) throw new SessionError("INVALID_TRANSITION", "illegal delivery transition " + from + " → " + outcome.kind);
    touched.set(write.runId, outcome.kind); deliveries.push({ kind: "outcome", runId: write.runId, from, outcome });
  }
  return { packets, deliveries };
}

/**
 * Lets go of the oldest packet texts of a conversation that no delivery in flight rests on, until `added` more bytes fit under `quota` (or no text is left to let
 * go of). The packet rows and the deliveries stay: a packet whose text is gone keeps its manifest and its evidence. `keep` are the digests the commit in hand names.
 */
function makeRoom(db: DatabaseSync, id: SessionId, added: number, quota: number, keep: ReadonlySet<string>): void {
  let stored = integer(one(db, "SELECT COALESCE(SUM(bytes),0) AS bytes FROM relay_bodies WHERE session_id=?", id)?.bytes, "stored relay text bytes");
  let after = 0;
  while (stored + added > quota) {
    // Oldest first; the digest a packet in flight names (through its manifest, which stays whether or not its text is kept) is not let go.
    const candidates = all(db, "SELECT b.rowid AS at, b.sha256 AS sha256, b.bytes AS bytes FROM relay_bodies b WHERE b.session_id=? AND b.rowid>? AND NOT EXISTS("
      + "SELECT 1 FROM relay_packets p JOIN relay_deliveries d ON d.session_id=p.session_id AND d.packet_id=p.packet_id WHERE p.session_id=b.session_id AND d.outcome='in_flight' "
      + "AND json_extract(p.manifest_json,'$.body.sha256')=b.sha256) ORDER BY b.rowid LIMIT 16", id, after);
    if (candidates.length === 0) return;
    for (const row of candidates) {
      after = integer(row.at, "relay text position");
      if (keep.has(String(row.sha256))) continue;
      db.prepare("UPDATE relay_packets SET body_sha256=NULL WHERE session_id=? AND body_sha256=?").run(id, String(row.sha256));
      db.prepare("DELETE FROM relay_bodies WHERE session_id=? AND sha256=?").run(id, String(row.sha256));
      stored -= integer(row.bytes, "relay text bytes");
      if (stored + added <= quota) return;
    }
  }
}

/**
 * Checks the relay rows of a commit against the conversation's rows, makes room for the texts, and writes them. `quotaBytes` is the most text a conversation keeps
 * (see the top of this file); the rows are checked in full before the first one is written.
 */
export function writeRelayRowsV14(db: DatabaseSync, id: SessionId, rows: RelayRows, quotaBytes: number): void {
  const checked = check(db, id, rows);
  const added = checked.packets.filter(row => row.freshBody).reduce((total, row) => total + row.packet.body.bytes, 0);
  if (added > 0) makeRoom(db, id, added, quotaBytes, new Set(checked.packets.map(row => row.packet.body.sha256)));
  const body = db.prepare("INSERT INTO relay_bodies(session_id,sha256,bytes,body) VALUES(?,?,?,?) ON CONFLICT(session_id, sha256) DO NOTHING");
  const packet = db.prepare("INSERT INTO relay_packets(session_id,packet_id,kind,tier,target_harness,target_control,target_model,native_epoch,from_seq,through_seq,supersedes_packet_id,policy_version,language,body_sha256,est_tokens,manifest_json) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id, packet_id) DO NOTHING");
  for (const row of checked.packets) {
    const p = row.packet;
    if (row.freshBody) body.run(id, p.body.sha256, p.body.bytes, row.body);
    if (row.fresh) packet.run(id, p.id, p.kind, p.tier, p.target.harnessId, p.target.controlId, p.target.model, p.target.nativeEpoch,
      p.range.fromSeq, p.range.throughSeq, p.supersedes, p.policyVersion, p.language, p.body.sha256, p.body.estTokens, row.manifest);
  }
  for (const row of checked.deliveries) {
    if (row.kind === "insert") {
      const r = row.record;
      db.prepare("INSERT INTO relay_deliveries(session_id,run_id,packet_id,channel,handoff_log_seq,input_hmac,auto_resend,redaction_rules_version,redaction_key_id,redaction_set_hmac,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,'in_flight')")
        .run(id, r.runId, r.packetId, r.channel, r.handoffLogSeq, r.inputHmac, r.autoResend ? 1 : 0, r.redaction.rulesVersion, r.redaction.keyId, r.redaction.setHmac);
      continue;
    }
    const o = row.outcome, evidence = o.kind === "recorded" ? o.evidence : null, reason = o.kind === "recorded" ? null : o.reason;
    // The outcome is set only when it changes, so the transition trigger never sees a same-value write.
    const outcome = row.from === o.kind ? "" : "outcome=?,";
    const values = [...(row.from === o.kind ? [] : [o.kind]), evidence, reason, o.decidedSeq, o.decidedAt, id, row.runId];
    db.prepare("UPDATE relay_deliveries SET " + outcome + "evidence=?,reason=?,decided_seq=?,decided_at=? WHERE session_id=? AND run_id=?").run(...values);
  }
}

/**
 * Every packet a relay state of the commit names that the slot it is written to did not name before (a binding's sync state, a Run's packet) is kept for the
 * conversation (ADR-055 §14.3: references across the conversation and the relay rows are checked on write). Called after the commit's relay rows are written;
 * INVALID_DATA names a reference that was not.
 */
export function checkPacketReferencesV14(db: DatabaseSync, id: SessionId, before: Conversation | null, mutation: Mutation): void {
  const wanted = new Set<string>();
  for (const write of mutation.bindings ?? []) {
    const relay = write.row.binding.relay;
    if (relay === undefined) continue;
    const was = before?.nativeBindings?.[write.row.ordinal]?.relay, had = was === undefined ? [] : packetsOf(was);
    for (const packetId of packetsOf(relay)) if (!had.includes(packetId)) wanted.add(packetId);
  }
  for (const write of mutation.runs ?? []) {
    const named = write.row.facts.relay?.packetId;
    if (named === undefined || named === null) continue;
    if (before?.runs[write.row.ordinal]?.relay?.packetId !== named) wanted.add(named);
  }
  for (const packetId of wanted) if (one(db, "SELECT 1 AS found FROM relay_packets WHERE session_id=? AND packet_id=?", id, packetId) === undefined)
    throw new SessionError("INVALID_DATA", "a relay state names a packet this conversation does not keep");
}

/** The conversation's delivery rows in Run order. */
export function readDeliveriesV14(db: DatabaseSync, id: SessionId): readonly DeliveryRecord[] {
  return all(db, "SELECT d.*, COALESCE(r.ordinal, 0) AS run_ordinal FROM relay_deliveries d LEFT JOIN runs r ON r.run_id=d.run_id AND r.session_id=d.session_id WHERE d.session_id=? ORDER BY run_ordinal, d.run_id", id).map(row => parseDeliveryRecord({
    runId: row.run_id, packetId: row.packet_id, channel: row.channel, handoffLogSeq: row.handoff_log_seq, inputHmac: row.input_hmac, autoResend: row.auto_resend === 1,
    redaction: { rulesVersion: row.redaction_rules_version, keyId: row.redaction_key_id, setHmac: row.redaction_set_hmac },
    outcome: row.outcome === "in_flight" ? { kind: "in_flight" } : row.outcome === "recorded" ? { kind: "recorded", evidence: row.evidence, decidedSeq: row.decided_seq, decidedAt: row.decided_at }
      : { kind: row.outcome, reason: row.reason, decidedSeq: row.decided_seq, decidedAt: row.decided_at },
  }));
}
