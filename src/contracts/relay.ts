import type { ContentKind } from "./content.js";
import type { CommandClass, ContextEffect } from "./control.js";
import { SessionError, messageId, runId, type MessageId, type RunId, type RunStatus, type SessionId, type SessionSnapshot } from "./session.js";

/**
 * The relay's contract (ADR-055, slimmed 2026-11-11, docs/proposals/relay/slim.md): identities, closed unions, the per-binding
 * and per-Run relay state the Session v13 snapshot holds, the rows of the relay tables and the ports that write them. Every
 * closed union is also exported as an `as const` array, the one source the parsers below check against.
 *
 * A binding records four things: its `epoch` (which native session of its Harness control it is), its `mark` (how far into the
 * conversation's facts it is known to hold), the packet sent to it that nothing confirmed yet (`pending`) and whether the next
 * packet must carry everything (`resendAll`), with the clear boundary (`floor`) the epoch started from. Nothing else.
 *
 * External or persisted input enters as `unknown` and becomes one of these types only through a parser here, which checks
 * every field, rejects unknown fields and holds each value to the byte bound written next to it; failures are
 * SessionError("INVALID_DATA").
 */

// ---------------------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The largest event seq the relay's state can name: the largest safe integer. The relay put no bound of its own on a conversation
 * (decided 2026-11-12: no conversation has a size limit), so these parsers read every value a conversation can reach; what the Store
 * holds of a conversation is the Store's to bound, not the contract's. They accept all that the earlier bounds (16,384 and 256) did.
 */
export const RELAY_MAX_SEQ = Number.MAX_SAFE_INTEGER;
/** The largest number of Runs a Session can hold as far as the relay is concerned; Run indexes are below it. */
export const RELAY_MAX_RUNS = Number.MAX_SAFE_INTEGER;
/** Native epochs start at 1 and grow by one per new native session or clear, each after at least one event. */
export const RELAY_MAX_EPOCH = Number.MAX_SAFE_INTEGER;
/** Counters a native side reports (context tokens). */
export const MAX_RELAY_COUNTER = 2_147_483_647;
/** Epoch milliseconds, as everywhere in the Session. */
export const MAX_RELAY_TIME = 8.64e15;
/** The serialized `relay` of one binding: five small fields and at most one pending packet (218 B with every number at the largest safe integer). */
export const MAX_BINDING_RELAY_BYTES = 256;
/** The serialized relay fields of one Run (`{ relay, relayRequest }`); the snapshot also gains contextReadyAt and recordedAt (532 B at the largest values). */
export const MAX_RUN_RELAY_BYTES = 576;
/** Relay table bounds, checked on serialized bytes before any statement runs. */
export const RELAY_BODY_BYTES = 262_144;
export const RELAY_SESSION_BODY_BYTES = 64 * 1024 * 1024;
export const RELAY_MANIFEST_BYTES = 65_536;
export const RELAY_INDEX_BYTES = 2048;
export const RELAY_PREF_VALUE_BYTES = 64;

// ---------------------------------------------------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------------------------------------------------

declare const packetBrand: unique symbol, printBrand: unique symbol, tagBrand: unique symbol, hmacBrand: unique symbol;
/** "relay-" + 20 Crockford base32 digits (lower case) of the sha256 of the final text with a placeholder in its ID slot. */
export type RelayPacketId = string & { readonly [packetBrand]: true };
/** sha256, 64 lower-case hex digits; never of a value that may be a secret (those use HmacDigest). */
export type Fingerprint = string & { readonly [printBrand]: true };
/** The first 8 hex digits of HMAC-SHA256(session subkey, value). */
export type RedactionTag = string & { readonly [tagBrand]: true };
/** HMAC-SHA256(session subkey, value), 64 hex digits: every fingerprint of what may be a secret. */
export type HmacDigest = string & { readonly [hmacBrand]: true };
export type PolicyVersion = `relay/${number}`;

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

// ---------------------------------------------------------------------------------------------------------------------
// Closed unions
// ---------------------------------------------------------------------------------------------------------------------

/** The two tiers of a packet: everything of the record fits (`full`), or whole items were left out and the ledger says which (`brief`). */
export const TIERS = ["full", "brief"] as const;
export type Tier = typeof TIERS[number];
export const LANGUAGES = ["zh", "en"] as const;
export type Language = typeof LANGUAGES[number];
export type { CommandClass, ContextEffect };
export const CONTEXT_EFFECTS = ["keep", "none", "compact", "clear", "rewind", "unknown"] as const;
/** A catalog entry's context effect; it may depend on the arguments (OpenClaw `/reset soft`, Hermes `/compress --preview`). */
export type ContextEffectRule = ContextEffect | { readonly byArgs: (args: string) => ContextEffect };

// ---- Delivery -------------------------------------------------------------------------------------------------------

/** What a delivery is decided by: E1, the native side's own report of the input (or the Turn's first agent output), and E3, the Turn's result. */
export const DELIVERY_EVIDENCE = ["E1", "E3"] as const;
export type DeliveryEvidence = typeof DELIVERY_EVIDENCE[number];
/** The name the interface knows the evidence classes by. */
export type EvidenceClass = DeliveryEvidence;
export const NOT_RECORDED_REASONS = ["rejected_before_insert", "never_dispatched"] as const;
export const UNKNOWN_REASONS = ["no_evidence", "owner_ended"] as const;
export const DELIVERY_STATUSES = ["in_flight", "recorded", "not_recorded", "unknown"] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
/** What is known of one Run's packet reaching its binding's native history: no evidence is unknown, never not recorded. */
export type DeliveryOutcome =
  | { readonly kind: "in_flight" }
  | { readonly kind: "recorded"; readonly evidence: DeliveryEvidence; readonly decidedSeq: number; readonly decidedAt: number }
  | { readonly kind: "not_recorded"; readonly reason: typeof NOT_RECORDED_REASONS[number]; readonly decidedSeq: number; readonly decidedAt: number }
  | { readonly kind: "unknown"; readonly reason: typeof UNKNOWN_REASONS[number]; readonly decidedSeq: number; readonly decidedAt: number };
/** The delivery outcomes a row may move between: from in_flight to any decided one; a decided one only to itself (a reason refined). */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  in_flight: ["recorded", "not_recorded", "unknown"],
  unknown: ["unknown"],
  not_recorded: ["not_recorded"],
  recorded: ["recorded"],
};
export function deliveryTransitionAllowed(from: DeliveryStatus, to: DeliveryStatus): boolean { return DELIVERY_TRANSITIONS[from].includes(to); }
export const DELIVERY_CHANNELS = ["text_block", "single_text"] as const;
/**
 * The reserved `redaction.keyId` of a delivery row whose keyed digests were made under a key kept only in the memory of the
 * owner that wrote it (a Runtime composed without an installation key): no reader can check them. The installation key
 * (RelayKeyPort) never takes this identity.
 */
export const EPHEMERAL_KEY_ID = "ephemeral";
/** One Run's delivery (at most one row per Run). */
export interface DeliveryRecord {
  readonly runId: RunId;
  readonly packetId: RelayPacketId;
  readonly channel: typeof DELIVERY_CHANNELS[number];
  readonly outcome: DeliveryOutcome;
  /** The installation's handoff log row of the first handoff to this Harness (relay_log), which the packet's delivery rests on. */
  readonly handoffLogSeq: number | null;
  readonly inputHmac: HmacDigest;
  readonly redaction: { readonly rulesVersion: string; readonly keyId: string; readonly setHmac: RedactionTag };
  /** The packet was the one automatic resend of the pending packet. */
  readonly autoResend: boolean;
}

// ---- Drivers' declarations ------------------------------------------------------------------------------------------

export const DELIVERY_LIVE = ["recorded_event", "agent_output", "none"] as const;
export const EXECUTION_KINDS = ["process", "gateway"] as const;
export const PLACEMENT_PARTS = ["multiple", "single"] as const;
export const TITLE_MODES = ["set", "none"] as const;
/**
 * A Driver's static relay declaration: only mechanisms, never product names; a missing item is the most conservative value. A
 * module-level constant, read at admission without a control instance. Every member has a reader in the relay: `delivery` (whether a
 * send can ever be confirmed: it reports the input as it happens, or a normal end proves it received), `execution` (whether the
 * Hub may continue its original session after an unknown Turn), `commands.classify`, `placement` (how a packet and the words are
 * handed over, and the bound of what the channel takes) and `title`.
 */
export interface RelayCapabilities {
  readonly delivery: {
    /** How the Driver shows a delivery while it happens: it reports the input as an event, its first output proves it, or it shows none. */
    readonly live: typeof DELIVERY_LIVE[number];
    /** A Turn that ended normally proves the input was received. */
    readonly successProvesRecorded: boolean;
  };
  readonly execution: typeof EXECUTION_KINDS[number];
  readonly commands: {
    /**
     * The native side's reading of an input: the same reading as the Driver's HarnessControl.classify, over a catalog of this
     * shape (null before one is read) and the kinds of the input's attachments, which some native sides read by. Pure and synchronous.
     */
    readonly classify: (text: string, catalog: readonly { readonly name: string; readonly effect: ContextEffectRule; readonly acceptsRelay?: boolean }[] | null, attachments: readonly ContentKind[]) => CommandClass;
  };
  readonly placement: { readonly parts: typeof PLACEMENT_PARTS[number]; readonly maxInput: { readonly unit: "chars" | "bytes"; readonly limit: number } | null;
    /**
     * The size of what this Driver hands its native side for `turn` (the placed text, with an allowance for what the native
     * side or the Driver adds that is unknown before dispatch), in `maxInput`'s unit. Pure and synchronous: the coordinator
     * chooses the packet's size by it before dispatch; the Driver's own refusal of a Turn over the bound stays as the backstop.
     */
    readonly measure: (turn: TurnText, attachments: readonly ContentKind[]) => number };
  readonly title: typeof TITLE_MODES[number];
}
/** What a Turn hands its Driver: the input alone, or the user's words with a relay packet the Driver places. */
export type TurnText = string | { readonly user: string; readonly relay: { readonly packetId: RelayPacketId; readonly body: string; readonly firstLine: boolean } };

// ---- The packet manifest --------------------------------------------------------------------------------------------

/**
 * One entry of the Run indexes a packet quotes: an index, or an inclusive span `[first, last]` (`first < last`) of consecutive ones. A
 * list of up to `RELAY_EXPLICIT_RUNS` indexes is stored one by one, as manifests always were; a longer one is stored as spans, so the
 * manifest stays inside its byte bound however long the conversation is (`packRunIndexes`).
 */
export type RunSpan = number | readonly [number, number];
/** The longest list of Run indexes stored one by one: what a manifest could hold before spans (256 Runs); a longer list is stored as spans. */
export const RELAY_EXPLICIT_RUNS = 256;
/** Run indexes, ascending, as a manifest stores them: explicit up to RELAY_EXPLICIT_RUNS, otherwise runs of consecutive indexes as spans. */
export function packRunIndexes(indexes: readonly number[]): readonly RunSpan[] {
  if (indexes.length <= RELAY_EXPLICIT_RUNS) return indexes;
  const packed: RunSpan[] = [];
  for (let at = 0; at < indexes.length;) {
    let last = at;
    while (last + 1 < indexes.length && indexes[last + 1] === indexes[last]! + 1) last++;
    packed.push(last === at ? indexes[at]! : [indexes[at]!, indexes[last]!]);
    at = last + 1;
  }
  return packed;
}
/** The span a stored entry is: an index alone is a span of itself. */
export function spanOf(entry: RunSpan): readonly [number, number] { return typeof entry === "number" ? [entry, entry] : entry; }
/** How many Run indexes a stored list names. */
export function countRunIndexes(runs: readonly RunSpan[]): number {
  let count = 0;
  for (const entry of runs) { const [first, last] = spanOf(entry); count += last - first + 1; }
  return count;
}

/** The kinds of item a packet's ledger counts, as the record holds them (narration.ts picks them from the Runs). */
export const ITEM_KINDS = ["userMessages", "replies", "outputs", "changes", "calls"] as const;
export type ItemKind = typeof ITEM_KINDS[number];
/** Fact seqs (a Run's `run.ended` seq, the origin's 0) and Run indexes a packet carries. */
export interface SourceRange { readonly fromSeq: number; readonly throughSeq: number; readonly fromRun: number; readonly throughRun: number }
/** A packet is a whole one, or an update to a native session that holds a part of the conversation. */
export const PACKET_KINDS = ["packet", "delta"] as const;
export type RelayPacketKind = typeof PACKET_KINDS[number];
/** Where the window a packet was budgeted against came from: what the target's own Turn reported, or the assumption. */
export const WINDOW_SOURCES = ["observed", "assumed"] as const;
export const BUDGET_CLAMPS = ["window", "input_limit"] as const;
export const FIRST_LINE_OMITTED = ["slash", "secret_hit"] as const;
/**
 * A packet's manifest (immutable; its text lives in relay_bodies, deduplicated by (session, sha256)): who it went to, which facts
 * and Runs it carries, what it left out and how it was budgeted. Only what the text and the facts decide; what is per Run (the
 * redaction context, the delivery) is in relay_deliveries.
 */
export interface RelayPacket {
  readonly id: RelayPacketId;
  readonly kind: RelayPacketKind;
  /** `full`: the whole record fit; `brief`: whole items were left out, and `omissions` and the text's ledger count them. */
  readonly tier: Tier;
  readonly target: { readonly harnessId: string; readonly controlId: string; readonly model: string | null; readonly nativeEpoch: number };
  readonly range: SourceRange;
  /** The Run indexes the packet quotes: each has finished and its user message came before the current input's (checked when it is written). Long lists are stored as spans (`packRunIndexes`). */
  readonly runs: readonly RunSpan[];
  /** The unconfirmed packet this one sends again (the facts again, or with newer ones). */
  readonly supersedes: RelayPacketId | null;
  readonly policyVersion: PolicyVersion;
  readonly language: Language;
  /** Its opening says that parts of it may be known to the target already. */
  readonly repeat: boolean;
  /** The user attached it (`attach: "full"`). */
  readonly attachOverride: boolean;
  readonly firstLineOmitted: typeof FIRST_LINE_OMITTED[number] | null;
  /** How many suspected secrets the text hides. */
  readonly redactions: number;
  readonly body: { readonly sha256: Fingerprint; readonly bytes: number; readonly estTokens: number };
  /** The cap the packet was folded to (tokens), the window it came from, and what lowered it below the standard cap. */
  readonly budget: { readonly capTokens: number; readonly window: number; readonly windowSource: typeof WINDOW_SOURCES[number]; readonly clampedBy: readonly typeof BUDGET_CLAMPS[number][] };
  /** What the packet left out whole, by kind (the ledger's counts); empty for a `full` one. */
  readonly omissions: readonly { readonly kind: ItemKind; readonly count: number }[];
}

/** Where a Run ran: its binding's Harness, control and native epoch at dispatch; null when no native session holds it. */
export interface ExecutedOn { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }
/**
 * The index a v13 migration writes for each finished dispatched Run of a v12 Session (status behind, policy "relay/0"): only
 * what the Run's events say, chiefly where it ran; the digest is rebuilt lazily.
 */
export interface RelayBehindIndex {
  readonly runId: RunId; readonly index: number; readonly seq: number; readonly executedOn: ExecutedOn | null; readonly dispatched: true;
  readonly status: RunStatus; readonly input: "recorded" | "not_recorded" | "unknown"; readonly commandEffect: ContextEffect | null;
}
/** A packet that was sent and not confirmed: its identity and the facts it covers (seqs of the facts; the origin is 0). */
export interface PendingPacket {
  readonly packetId: RelayPacketId;
  /** The lowest and the highest fact seq the packet carries. */
  readonly fromSeq: number;
  readonly throughSeq: number;
  /** How many times the relay sent this packet's facts again by itself: 0 or 1, never more. A packet for newer facts starts at 0. */
  readonly autoResends: 0 | 1;
}
/**
 * A native binding's relay state (Session v13: NativeSessionBinding.relay). Serialized ≤ MAX_BINDING_RELAY_BYTES.
 * - `epoch`: which native session of its Harness control it is (1 for the first; a clear or a new native session takes the next).
 *   A fact is foreign to the binding unless it ran on this very Harness control in this very epoch.
 * - `mark`: the highest fact seq the binding is known to hold (a recorded packet's, the history it started from is 0); −1: none.
 * - `floor`: the clear boundary the epoch started from; facts at or below it are not owed (unless the user attaches them); −1: none.
 *   Along the bindings of one Harness control it never goes down.
 * - `pending`: the packet sent and not confirmed, if any.
 * - `resendAll`: a command that may have changed the native history ran (rewind, unknown) or an unknown Turn was continued: the
 *   next packet carries everything since `floor`, saying it may repeat.
 */
export interface BindingRelayState {
  readonly epoch: number;
  readonly mark: number;
  readonly floor: number;
  readonly pending: PendingPacket | null;
  readonly resendAll: boolean;
}

export const BLOCKED_CODES = ["NATIVE_STATE_UNCONFIRMED", "RELAY_PREPARE_FAILED"] as const;
/** How a Turn continued its context: an object since v13; v12 events wrote a string. */
export type ContinuityLevel =
  | { readonly kind: "native_resume" }
  | { readonly kind: "native_resume_delta"; readonly tier: Tier; readonly runs: number }
  | { readonly kind: "rehydrate"; readonly tier: Tier; readonly complete: boolean }
  | { readonly kind: "native_fork" } | { readonly kind: "native_import" }
  | { readonly kind: "native_cleared" }
  | { readonly kind: "blocked"; readonly code: typeof BLOCKED_CODES[number] };
/**
 * The strings v12 events wrote for continuity, and the level each reads as. A v12 rehydration is read as an incomplete
 * (brief) one: no v12 event says what was folded.
 */
export const LEGACY_CONTINUITY: Readonly<Record<string, ContinuityLevel>> = {
  public_context_rehydrate: { kind: "rehydrate", tier: "brief", complete: false },
  native_resume: { kind: "native_resume" },
  native_fork: { kind: "native_fork" },
  native_import: { kind: "native_import" },
};
/** PublicRun.relay (v13). Serialized with relayRequest ≤ MAX_RUN_RELAY_BYTES; immutable once the Run is running. */
export interface RunRelay { readonly packetId: RelayPacketId | null; readonly kind: RelayPacketKind | null; readonly continuity: ContinuityLevel; readonly executedOn: ExecutedOn | null }
export const ATTACH_CHOICES = ["auto", "full", "none"] as const;
/** PublicRun.relayRequest (v13): the request's relay choice and an HMAC of it. */
export interface RunRelayRequest { readonly attach?: "full" | "none"; readonly fingerprint: HmacDigest }
export const SWITCH_MODES = ["wait_current", "cancel_current"] as const;
export type SwitchMode = typeof SWITCH_MODES[number];
/** When a switch was requested, validated and became effective (epoch milliseconds, the Runtime's clock). */
export interface SwitchTiming { readonly requestedAt: number; readonly validatedAt?: number; readonly effectiveAt?: number }

/**
 * The installation's handoff log: one row for the first handoff to each Harness (the key is the Harness's id), written before the
 * packet that is the handoff leaves, never changed. The delivery rows of that Harness name it; the interface shows the one-time
 * explanation for a Harness that has a row and none before it.
 */
export interface HandoffRecord { readonly logSeq: number; readonly harnessId: string; readonly firstAt: number }

/** The one installation preference: whether a switch to another Harness attaches the earlier conversation by itself (`auto`, the default) or not (`off`; the user may still attach it per message). */
export const RELAY_PREF_KEYS = ["relay.attach"] as const;
export type RelayPrefKey = typeof RELAY_PREF_KEYS[number];
export const RELAY_PREF_VALUES: Readonly<Record<RelayPrefKey, readonly string[]>> = {
  "relay.attach": ["auto", "off"],
};
export const RELAY_PREF_DEFAULTS: Readonly<Record<RelayPrefKey, string>> = {
  "relay.attach": "auto",
};

// ---------------------------------------------------------------------------------------------------------------------
// What the relay decided for a Turn, and what a binding asks the user to look at
// ---------------------------------------------------------------------------------------------------------------------

export const DECISION_KINDS = ["carry", "alone", "plain"] as const;
/** Who decided: the need alone (an ordinary packet), the policy (an automatic resend, a send alone, everything again), or the user's own choice. */
export const DECISION_BY = ["need", "policy", "user"] as const;
/**
 * The situation a decision of the policy answered: a packet is unconfirmed and its one automatic resend is spent; the native
 * history may have changed (a rewind, an unknown command, an unknown Turn), so everything goes again; even the smallest packet
 * does not fit; the relay's record could not be recovered; a packet could not be prepared (`reason` says why).
 */
export const DECISION_CAUSES = ["delivery_unconfirmed", "history_changed", "input_limit", "recovery_failed", "prepare_failed"] as const;
/**
 * Which kind of resend a `carry` decision is: `auto`, the one automatic resend of an unconfirmed packet (the same facts again);
 * `grown`, a packet for newer facts that also carries what the unconfirmed one carried; `all`, everything since the epoch's start.
 * Absent for a packet that resends nothing.
 */
export const DECISION_RESENDS = ["auto", "grown", "all"] as const;
/**
 * `run.context_prepared.data.relay.decision`: what the relay did with a content Turn's history. `reason` names the failure of a
 * `prepare_failed` or an `input_limit`. An ordinary Turn that owes nothing records none.
 */
export interface RelayDecision {
  readonly kind: typeof DECISION_KINDS[number];
  readonly by: typeof DECISION_BY[number];
  readonly cause?: typeof DECISION_CAUSES[number];
  readonly reason?: string;
  readonly resend?: typeof DECISION_RESENDS[number];
}
/** The decision a `run.context_prepared` event records; null when it records none (or something that is not one). */
export function relayDecisionOf(data: Readonly<Record<string, unknown>> | undefined): RelayDecision | null {
  const relay = data?.relay;
  if (relay === null || typeof relay !== "object" || Array.isArray(relay)) return null;
  const item = (relay as Readonly<Record<string, unknown>>).decision;
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Readonly<Record<string, unknown>>;
  if (!(DECISION_KINDS as readonly unknown[]).includes(row.kind) || !(DECISION_BY as readonly unknown[]).includes(row.by)) return null;
  const cause = (DECISION_CAUSES as readonly unknown[]).includes(row.cause) ? row.cause as typeof DECISION_CAUSES[number] : undefined;
  const resend = row.kind === "carry" && (DECISION_RESENDS as readonly unknown[]).includes(row.resend) ? row.resend as typeof DECISION_RESENDS[number] : undefined;
  return { kind: row.kind as RelayDecision["kind"], by: row.by as RelayDecision["by"], ...(cause === undefined ? {} : { cause }), ...(typeof row.reason === "string" ? { reason: row.reason.slice(0, 64) } : {}),
    ...(resend === undefined ? {} : { resend }) };
}
/**
 * What the installation as a whole cannot do for the relay, as long as it stays so: `key_unavailable`, the relay key file is
 * unusable, so no packet can be keyed and every handoff goes as the words alone until it is mended. `detail` is the Gateway's
 * reason in a few words, never a path or a value.
 */
export const INSTALLATION_NOTICE_CAUSES = ["key_unavailable"] as const;
export interface RelayInstallationNotice { readonly cause: typeof INSTALLATION_NOTICE_CAUSES[number]; readonly detail?: string }
/** Why a binding asks the user to look at it: a packet was sent and nothing confirmed it, or the conversation was cleared and the earlier part can still be attached. */
export const ATTENTION_CAUSES = ["delivery_unconfirmed", "attach_available"] as const;
export const ATTENTION_OPTIONS = ["attach_full"] as const;
/**
 * What a binding asks the user to look at (`GET …/relay`, per binding): why, the option that answers it (never a block: the next
 * input goes anyway), how much is at stake (`runs` of the conversation's Turns it still owes, `packets` sent and not confirmed),
 * and `key`, which names one episode (the same cause within one wait shows once, and a closed banner does not come back).
 */
export interface RelayAttention {
  readonly cause: typeof ATTENTION_CAUSES[number];
  readonly options: readonly typeof ATTENTION_OPTIONS[number][];
  readonly counts: { readonly runs: number; readonly packets: number };
  readonly key: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------

/** Why a packet could not be prepared when the user asked for it explicitly (otherwise the input goes alone and the Run records the reason). */
export const RELAY_PREPARE_REASONS = ["render", "render_mismatch", "redaction_failed", "storage", "storage_quota", "input_limit", "recovery_failed"] as const;
export type RelayErrorReason = { readonly code: "RELAY_PREPARE_FAILED"; readonly reason: typeof RELAY_PREPARE_REASONS[number] };
/** What a relay error tells the page besides its code and reason: the Harness control it concerns. Plain values, never a secret, a path or the history's text. */
export interface RelayErrorDetail {
  readonly harnessId?: string;
  readonly controlId?: string;
}
/**
 * An expected relay failure: it fails one Run and nothing else. The Store throws it before any statement of the failing write
 * runs, so it never disables the Store; `reason` is the code's closed reason.
 */
export class RelayError extends SessionError {
  readonly reason: RelayErrorReason["reason"];
  readonly detail: RelayErrorDetail | undefined;
  constructor(failure: RelayErrorReason, message: string, detail?: RelayErrorDetail) { super(failure.code, message); this.name = "RelayError"; this.reason = failure.reason; this.detail = detail; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Store ports
// ---------------------------------------------------------------------------------------------------------------------

/** A packet to keep with the Run that sends it: its manifest and text; the text's sha256 and bytes are its manifest's. */
export interface RelayPacketWrite { readonly runId: RunId; readonly packet: RelayPacket; readonly body: string }
/** A delivery row: inserted in flight with the packet, then decided by evidence along DELIVERY_TRANSITIONS. */
export type RelayDeliveryWrite =
  | { readonly kind: "insert"; readonly record: DeliveryRecord }
  | { readonly kind: "outcome"; readonly runId: RunId; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }> };
/**
 * What a Session transaction writes besides its snapshot and events (SessionMutation.relay): the packet a Turn sends and its
 * delivery row, checked in full before any statement runs. An expected failure is a RelayError for the Run (RELAY_PREPARE_FAILED)
 * and the transaction writes nothing.
 */
export interface RelayRows {
  readonly packets?: readonly RelayPacketWrite[];
  readonly deliveries?: readonly RelayDeliveryWrite[];
}
/** One Run's delivery changed by recovery. */
export interface RelayRecoveredDelivery { readonly runId: RunId; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }> }
/** The Session Store's relay writes and reads beyond SessionStore. */
export interface RelayStorePort {
  /** Deletes a closed Session that keeps no process, with its events, create key and every relay row, in one transaction. */
  deleteSession(id: SessionId): void;
  /** The Session's delivery rows in Run order. */
  relayDeliveries(id: SessionId): readonly DeliveryRecord[];
  /** The manifests of the packets the Session keeps. */
  relayPackets(id: SessionId): readonly RelayPacket[];
  /** One packet's manifest by its identity in the Session; null when the Session keeps no such packet (another Session's packet is none). */
  relayPacket(id: SessionId, packetId: string): RelayPacket | null;
  /**
   * The text the Session keeps for a body digest, exactly as it was stored when the packet was sent (never scanned again);
   * null when none is kept. INVALID_DATA when what is kept is not text. Reads committed rows only and holds nothing between reads.
   */
  relayPacketBody(id: SessionId, bodySha256: string): string | null;
  /** The Session's index rows, as plain objects: where the Runs a migration indexed ran (they are RelayBehindIndex). */
  relayIndex(id: SessionId): readonly RelayIndexRow[];
}
/** One row of relay_index: which Run, and its index object. */
export interface RelayIndexRow { readonly runId: RunId; readonly index: Readonly<Record<string, unknown>> }
/** The installation's handoff log and preference. */
export interface RelayLogPort {
  /**
   * The log row of the first handoff to `harnessId`, written in a transaction of its own when there is none; the same Harness
   * again returns the first row unchanged. `created` says whether this call wrote it.
   */
  logHandoff(harnessId: string): { readonly record: HandoffRecord; readonly created: boolean };
  /** The log rows, oldest first (one per Harness that was ever handed history). */
  handoffs(): readonly HandoffRecord[];
  /** Whether any delivery row of any Session names the log row `logSeq` (its `handoffLogSeq`): a packet was sent to that Harness on it. */
  handoffUsed(logSeq: number): boolean;
  /** Sets one installation preference to one of its values; the last writer wins. */
  setPref(key: RelayPrefKey, value: string): void;
  relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>>;
}

/**
 * The installation's relay key as the relay uses it (ADR-055 §10.2, D5; relay-keys.ts): HMACs under a subkey derived per Session
 * (HMAC(installation key, "relay-tag/1" ‖ sessionId)), so one value keys differently in every Session and nothing in a relay row
 * can be checked against a guessed value without the key. The key itself is never exported. `keyId` names the key in the rows;
 * it is never EPHEMERAL_KEY_ID. Each method may throw a RelayError (RELAY_PREPARE_FAILED, redaction_failed) when the key cannot
 * be used; nothing is then written with a digest of another key.
 */
export interface RelayKeyPort {
  readonly keyId: string;
  /** Why the key cannot be used (a file of the wrong length, a directory in its place), in words without a path; null when it can. Absent: a key kept in memory. */
  readonly unusable?: string | null;
  /** HMAC-SHA256 of the current input (a delivery row's inputHmac). */
  inputHmac(session: SessionId, text: string): HmacDigest;
  /** The first 8 hex of the HMAC of a known-secret set (a delivery row's redaction.setHmac): the same set, whatever its order, tags alike. */
  setTag(session: SessionId, secrets: readonly string[]): RedactionTag;
  /** HMAC-SHA256 of a request's relay choice as canonical JSON (PublicRun.relayRequest.fingerprint). */
  requestFingerprint(session: SessionId, canonical: string): HmacDigest;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------------------------------

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
      return { kind: "recorded", evidence: choice(item.evidence, DELIVERY_EVIDENCE, "delivery evidence"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at") };
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
/** A list of Run indexes as a manifest stores them: indexes, and spans of consecutive ones (a span is two indexes with the first below the last). */
const ids = (value: unknown, label: string): readonly RunSpan[] => list(value, label, RELAY_MAX_RUNS, (raw): RunSpan => {
  if (!Array.isArray(raw)) return integer(raw, label, 0, RELAY_MAX_RUNS - 1);
  if (raw.length !== 2) invalid(label);
  const first = integer(raw[0], label, 0, RELAY_MAX_RUNS - 1), last = integer(raw[1], label, 0, RELAY_MAX_RUNS - 1);
  if (last <= first) invalid(label);
  return [first, last];
});
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
export function parseHandoffRecord(value: unknown): HandoffRecord {
  const item = object(value, "handoff record"); only(item, ["logSeq", "harnessId", "firstAt"], "handoff record");
  return { logSeq: integer(item.logSeq, "handoff log seq", 1, Number.MAX_SAFE_INTEGER), harnessId: catalogIdentity(item.harnessId, "handoff Harness"), firstAt: time(item.firstAt, "handoff first at") };
}
export function parseRelayPref(key: unknown, value: unknown): { readonly key: RelayPrefKey; readonly value: string } {
  const name = choice(key, RELAY_PREF_KEYS, "relay preference key");
  const text = bounded(value, "relay preference value", RELAY_PREF_VALUE_BYTES);
  if (!RELAY_PREF_VALUES[name].includes(text)) invalid("relay preference value");
  return { key: name, value: text };
}
