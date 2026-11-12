/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T2): taken from src/contracts/relay.ts (bounds, identity checks, closed unions and parsers) as it was at the end of store v13 (commit 1a5f020), WITHOUT its bounds lifted.
 * The conversion of a v13 database (and the ladder from v1 to v13 that runs before it) reads old snapshots with exactly this code, so that nothing the
 * live code changes later (a bound opened, a field added) can change what an old snapshot means. Do not edit it and do not import a live parser into it;
 * tests/integration/legacy-parse.test.ts holds it to the live code on the repository's fixtures and holds this folder to its own imports.
 */

import type {
  BindingRelayState, ContinuityLevel, DeliveryOutcome, DeliveryRecord, ExecutedOn, Fingerprint, HmacDigest, ItemKind, PendingPacket, PolicyVersion, RedactionTag,
  RelayPacket, RelayPacketId, RunRelay, RunRelayRequest, SourceRange, SwitchTiming, Tier,
} from "../../../contracts/relay.js";
import { SessionError, runId } from "../../../contracts/session.js";

// ---- Bounds (as v13 had them: 16384 events, 256 Runs)

/** The largest event seq a Session can reach: MAX_SESSION_EVENTS of the Session domain (checked equal by its tests). */
export const RELAY_MAX_SEQ = 16_384;
/** The most Runs a Session holds: MAX_RUNS of the Session domain; Run indexes are below it. */
export const RELAY_MAX_RUNS = 256;
/** Native epochs start at 1 and grow by one per new native session or clear, each after at least one event. */
export const RELAY_MAX_EPOCH = RELAY_MAX_SEQ + 1;
/** Counters a native side reports (context tokens). */
export const MAX_RELAY_COUNTER = 2_147_483_647;
/** Epoch milliseconds, as everywhere in the Session. */
export const MAX_RELAY_TIME = 8.64e15;
/** The serialized `relay` of one binding: five small fields and at most one pending packet (163 B at the largest values). */
export const MAX_BINDING_RELAY_BYTES = 256;
/** The serialized relay fields of one Run (`{ relay, relayRequest }`); the snapshot also gains contextReadyAt and recordedAt. */
export const MAX_RUN_RELAY_BYTES = 576;
/** Relay table bounds, checked on serialized bytes before any statement runs. */
export const RELAY_BODY_BYTES = 262_144;
export const RELAY_SESSION_BODY_BYTES = 64 * 1024 * 1024;
export const RELAY_MANIFEST_BYTES = 65_536;
export const RELAY_INDEX_BYTES = 2048;
export const RELAY_PREF_VALUE_BYTES = 64;

// ---- Identities

function invalid(label: string): never { throw new SessionError("INVALID_DATA", label + " is invalid"); }
function patterned<T extends string>(value: unknown, pattern: RegExp, label: string): T {
  if (typeof value !== "string" || !pattern.test(value)) invalid(label);
  return value as T;
}
export function relayPacketId(value: unknown): RelayPacketId { return patterned(value, /^relay-[0-9a-hjkmnp-tv-z]{20}$/u, "relay packet identity"); }
export function fingerprint(value: unknown): Fingerprint { return patterned(value, /^[0-9a-f]{64}$/u, "fingerprint"); }
export function hmacDigest(value: unknown): HmacDigest { return patterned(value, /^[0-9a-f]{64}$/u, "HMAC digest"); }
export function redactionTag(value: unknown): RedactionTag { return patterned(value, /^[0-9a-f]{8}$/u, "redaction tag"); }
export function policyVersion(value: unknown): PolicyVersion { return patterned(value, /^relay\/(?:0|[1-9][0-9]{0,5})$/u, "relay policy version"); }

// ---- The closed unions of v13, as arrays the parsers check against
const TIERS = ["full", "brief"] as const;
const LANGUAGES = ["zh", "en"] as const;
const DELIVERY_EVIDENCE_WORDS = ["E1", "E3"] as const;
const NOT_RECORDED_REASONS = ["rejected_before_insert", "never_dispatched"] as const;
const UNKNOWN_REASONS = ["no_evidence", "owner_ended"] as const;
const DELIVERY_CHANNELS = ["text_block", "single_text"] as const;
const PACKET_KINDS = ["packet", "delta"] as const;
const FIRST_LINE_OMITTED = ["slash", "secret_hit"] as const;
const WINDOW_SOURCES = ["observed", "assumed"] as const;
const BUDGET_CLAMPS = ["window", "input_limit"] as const;
const ITEM_KINDS = ["userMessages", "replies", "outputs", "changes", "calls"] as const;
const BLOCKED_CODES = ["NATIVE_STATE_UNCONFIRMED", "RELAY_PREPARE_FAILED"] as const;
const LEGACY_CONTINUITY: Readonly<Record<string, ContinuityLevel>> = {
  public_context_rehydrate: { kind: "rehydrate", tier: "brief", complete: false },
  native_resume: { kind: "native_resume" },
  native_fork: { kind: "native_fork" },
  native_import: { kind: "native_import" },
};

// ---- Parsers (v13's)

function utf8(value: string): number { return new TextEncoder().encode(value).byteLength; }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}
function only(item: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(item).some(key => !allowed.includes(key))) throw new SessionError("INVALID_DATA", label + " has unknown fields");
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(label);
  return value;
}
function flag(value: unknown, label: string): boolean { if (typeof value !== "boolean") invalid(label); return value; }
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(label);
  return value as T;
}
function bounded(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || /[\0-\x1f\x7f]/u.test(value) || utf8(value) > maximum) invalid(label);
  return value;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function list<T>(value: unknown, label: string, maximum: number, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(label);
  return value.map(parse);
}
const seq = (value: unknown, label: string) => integer(value, label, 0, RELAY_MAX_SEQ);
const time = (value: unknown, label: string) => integer(value, label, 0, MAX_RELAY_TIME);
const counter = (value: unknown, label: string) => integer(value, label, 0, MAX_RELAY_COUNTER);
/** A catalog identity of a Harness or control, as selections hold them. */
export function catalogIdentity(value: unknown, label: string): string {
  const text = bounded(value, label, 96);
  if (!/^[a-z][a-z0-9-]*$/u.test(text)) invalid(label);
  return text;
}
export function parseSourceRange(value: unknown): SourceRange {
  const item = object(value, "source range"); only(item, ["fromSeq", "throughSeq", "fromRun", "throughRun"], "source range");
  const fromSeq = seq(item.fromSeq, "range fromSeq"), throughSeq = seq(item.throughSeq, "range throughSeq");
  const fromRun = integer(item.fromRun, "range fromRun", 0, RELAY_MAX_RUNS - 1), throughRun = integer(item.throughRun, "range throughRun", 0, RELAY_MAX_RUNS - 1);
  if (throughSeq < fromSeq || throughRun < fromRun) invalid("source range");
  return { fromSeq, throughSeq, fromRun, throughRun };
}
function parsePending(value: unknown): PendingPacket {
  const row = object(value, "pending packet"); only(row, ["packetId", "fromSeq", "throughSeq", "autoResends"], "pending packet");
  const fromSeq = seq(row.fromSeq, "pending fromSeq"), throughSeq = seq(row.throughSeq, "pending throughSeq");
  if (throughSeq < fromSeq) invalid("pending packet range");
  return { packetId: relayPacketId(row.packetId), fromSeq, throughSeq, autoResends: integer(row.autoResends, "automatic resends", 0, 1) as 0 | 1 };
}
/** NativeSessionBinding.relay (v13), checked field by field and then against MAX_BINDING_RELAY_BYTES. */
export function parseBindingRelayState(value: unknown): BindingRelayState {
  const item = object(value, "binding relay state");
  only(item, ["epoch", "mark", "floor", "pending", "resendAll"], "binding relay state");
  const state: BindingRelayState = { epoch: integer(item.epoch, "epoch", 1, RELAY_MAX_EPOCH), mark: integer(item.mark, "mark", -1, RELAY_MAX_SEQ), floor: integer(item.floor, "clear floor", -1, RELAY_MAX_SEQ),
    pending: nullable(item.pending, parsePending), resendAll: flag(item.resendAll, "resend all") };
  if (utf8(JSON.stringify(state)) > MAX_BINDING_RELAY_BYTES) throw new SessionError("INVALID_DATA", "binding relay state exceeds its byte budget");
  return state;
}
/** Every packet identity a binding's relay state names, for the Store's check that they exist. */
export function packetsOf(relay: BindingRelayState): readonly RelayPacketId[] { return relay.pending === null ? [] : [relay.pending.packetId]; }
/**
 * A continuity level: an object, or (with `legacy`) one of the strings v12 events wrote (LEGACY_CONTINUITY). Snapshot
 * fields are v13 and take objects only.
 */
export function parseContinuityLevel(value: unknown, legacy = false): ContinuityLevel {
  if (typeof value === "string") {
    const level = legacy ? LEGACY_CONTINUITY[value] : undefined;
    if (level === undefined || !Object.hasOwn(LEGACY_CONTINUITY, value)) invalid("continuity level");
    return level;
  }
  const item = object(value, "continuity level");
  switch (item.kind) {
    case "native_resume": case "native_fork": case "native_import": case "native_cleared": only(item, ["kind"], "continuity level"); return { kind: item.kind };
    case "native_resume_delta": only(item, ["kind", "tier", "runs"], "continuity level"); return { kind: "native_resume_delta", tier: choice(item.tier, TIERS, "continuity tier"), runs: integer(item.runs, "continuity runs", 1, RELAY_MAX_RUNS) };
    case "rehydrate": only(item, ["kind", "tier", "complete"], "continuity level"); return { kind: "rehydrate", tier: choice(item.tier, TIERS, "continuity tier"), complete: flag(item.complete, "continuity completeness") };
    case "blocked": only(item, ["kind", "code"], "continuity level"); return { kind: "blocked", code: choice(item.code, BLOCKED_CODES, "blocked continuity code") };
  }
  return invalid("continuity level");
}
export function parseExecutedOn(value: unknown): ExecutedOn {
  const item = object(value, "executed on"); only(item, ["harnessId", "controlId", "nativeEpoch"], "executed on");
  return { harnessId: catalogIdentity(item.harnessId, "executed-on Harness"), controlId: catalogIdentity(item.controlId, "executed-on control"), nativeEpoch: integer(item.nativeEpoch, "executed-on epoch", 1, RELAY_MAX_EPOCH) };
}
/** PublicRun.relay (v13): a packet identity and kind together or neither, an object continuity level, where it ran. */
export function parseRunRelay(value: unknown): RunRelay {
  const item = object(value, "Run relay"); only(item, ["packetId", "kind", "continuity", "executedOn"], "Run relay");
  const packetId = nullable(item.packetId, relayPacketId), kind = nullable(item.kind, raw => choice(raw, PACKET_KINDS, "Run packet kind"));
  if ((packetId === null) !== (kind === null)) throw new SessionError("INVALID_DATA", "a Run's packet identity and kind go together");
  return { packetId, kind, continuity: parseContinuityLevel(item.continuity), executedOn: nullable(item.executedOn, parseExecutedOn) };
}
/** PublicRun.relayRequest (v13). */
export function parseRunRelayRequest(value: unknown): RunRelayRequest {
  const item = object(value, "Run relay request"); only(item, ["attach", "fingerprint"], "Run relay request");
  return { ...(item.attach === undefined ? {} : { attach: choice(item.attach, ["full", "none"] as const, "requested attach") }), fingerprint: hmacDigest(item.fingerprint) };
}
/** The serialized relay fields of one Run, held to MAX_RUN_RELAY_BYTES. */
export function assertRunRelayBytes(relay: RunRelay | undefined, request: RunRelayRequest | undefined): void {
  if (relay === undefined && request === undefined) return;
  if (utf8(JSON.stringify({ relay, relayRequest: request })) > MAX_RUN_RELAY_BYTES) throw new SessionError("INVALID_DATA", "Run relay fields exceed their byte budget");
}
export function parseSwitchTiming(value: unknown): SwitchTiming {
  const item = object(value, "switch timing"); only(item, ["requestedAt", "validatedAt", "effectiveAt"], "switch timing");
  const requestedAt = time(item.requestedAt, "switch requestedAt");
  const validatedAt = item.validatedAt === undefined ? undefined : time(item.validatedAt, "switch validatedAt");
  const effectiveAt = item.effectiveAt === undefined ? undefined : time(item.effectiveAt, "switch effectiveAt");
  if ((validatedAt !== undefined && validatedAt < requestedAt) || (effectiveAt !== undefined && effectiveAt < (validatedAt ?? requestedAt))) throw new SessionError("INVALID_DATA", "switch phases must not go back in time");
  return { requestedAt, ...(validatedAt === undefined ? {} : { validatedAt }), ...(effectiveAt === undefined ? {} : { effectiveAt }) };
}
export function parseDeliveryOutcome(value: unknown): DeliveryOutcome {
  const item = object(value, "delivery outcome");
  switch (item.kind) {
    case "in_flight": only(item, ["kind"], "delivery outcome"); return { kind: "in_flight" };
    case "recorded": only(item, ["kind", "evidence", "decidedSeq", "decidedAt"], "delivery outcome");
      return { kind: "recorded", evidence: choice(item.evidence, DELIVERY_EVIDENCE_WORDS, "delivery evidence"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at") };
    case "not_recorded": only(item, ["kind", "reason", "decidedSeq", "decidedAt"], "delivery outcome");
      return { kind: "not_recorded", reason: choice(item.reason, NOT_RECORDED_REASONS, "not recorded reason"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at") };
    case "unknown": only(item, ["kind", "reason", "decidedSeq", "decidedAt"], "delivery outcome");
      return { kind: "unknown", reason: choice(item.reason, UNKNOWN_REASONS, "unknown reason"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at") };
  }
  return invalid("delivery outcome");
}
export function parseDeliveryRecord(value: unknown): DeliveryRecord {
  const item = object(value, "delivery record");
  only(item, ["runId", "packetId", "channel", "outcome", "handoffLogSeq", "inputHmac", "redaction", "autoResend"], "delivery record");
  const redaction = object(item.redaction, "delivery redaction context"); only(redaction, ["rulesVersion", "keyId", "setHmac"], "delivery redaction context");
  return { runId: runId(item.runId), packetId: relayPacketId(item.packetId), channel: choice(item.channel, DELIVERY_CHANNELS, "delivery channel"),
    outcome: parseDeliveryOutcome(item.outcome), handoffLogSeq: nullable(item.handoffLogSeq, raw => integer(raw, "handoff log seq", 1, Number.MAX_SAFE_INTEGER)), inputHmac: hmacDigest(item.inputHmac),
    redaction: { rulesVersion: bounded(redaction.rulesVersion, "redaction rules version", 64), keyId: bounded(redaction.keyId, "redaction key id", 64), setHmac: redactionTag(redaction.setHmac) },
    autoResend: flag(item.autoResend, "automatic resend") };
}
const ids = (value: unknown, label: string) => list(value, label, RELAY_MAX_RUNS, raw => integer(raw, label, 0, RELAY_MAX_RUNS - 1));
const tokens = (value: unknown, label: string) => counter(value, label);
/** A packet manifest, checked field by field and against RELAY_MANIFEST_BYTES. */
export function parseRelayPacket(value: unknown): RelayPacket {
  const item = object(value, "relay packet");
  only(item, ["id", "kind", "tier", "target", "range", "runs", "supersedes", "policyVersion", "language", "repeat", "attachOverride", "firstLineOmitted", "redactions", "body", "budget", "omissions"], "relay packet");
  const target = object(item.target, "packet target"); only(target, ["harnessId", "controlId", "model", "nativeEpoch"], "packet target");
  const body = object(item.body, "packet body"); only(body, ["sha256", "bytes", "estTokens"], "packet body");
  const budget = object(item.budget, "packet budget"); only(budget, ["capTokens", "window", "windowSource", "clampedBy"], "packet budget");
  const packet: RelayPacket = {
    id: relayPacketId(item.id), kind: choice(item.kind, PACKET_KINDS, "packet kind"), tier: choice(item.tier, TIERS, "packet tier"),
    target: { harnessId: catalogIdentity(target.harnessId, "packet target Harness"), controlId: catalogIdentity(target.controlId, "packet target control"), model: nullable(target.model, raw => bounded(raw, "packet target model", 1024)),
      nativeEpoch: integer(target.nativeEpoch, "packet target epoch", 1, RELAY_MAX_EPOCH) },
    range: parseSourceRange(item.range), runs: ids(item.runs, "packet runs"), supersedes: nullable(item.supersedes, relayPacketId),
    policyVersion: policyVersion(item.policyVersion), language: choice(item.language, LANGUAGES, "packet language"), repeat: flag(item.repeat, "packet repeat"),
    attachOverride: flag(item.attachOverride, "packet attach override"), firstLineOmitted: nullable(item.firstLineOmitted, raw => choice(raw, FIRST_LINE_OMITTED, "packet first line omission")),
    redactions: counter(item.redactions, "packet redactions"),
    body: { sha256: fingerprint(body.sha256), bytes: integer(body.bytes, "packet body bytes", 1, RELAY_BODY_BYTES), estTokens: tokens(body.estTokens, "packet tokens") },
    budget: { capTokens: tokens(budget.capTokens, "packet cap"), window: tokens(budget.window, "packet window"), windowSource: choice(budget.windowSource, WINDOW_SOURCES, "packet window source"),
      clampedBy: list(budget.clampedBy, "packet clamps", BUDGET_CLAMPS.length, raw => choice(raw, BUDGET_CLAMPS, "packet clamp")) },
    omissions: list(item.omissions, "packet omissions", ITEM_KINDS.length, raw => { const row = object(raw, "packet omission"); only(row, ["kind", "count"], "packet omission");
      return { kind: choice(row.kind, ITEM_KINDS, "omission kind"), count: counter(row.count, "omission count") }; }),
  };
  if (utf8(JSON.stringify(packet)) > RELAY_MANIFEST_BYTES) throw new SessionError("INVALID_DATA", "relay packet manifest exceeds its byte budget");
  return packet;
}
