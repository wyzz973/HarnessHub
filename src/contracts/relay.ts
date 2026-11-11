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

/** The largest event seq a Session can reach: MAX_SESSION_EVENTS of the Session domain (checked equal by its tests). */
export const RELAY_MAX_SEQ = 16_384;
/** The most Runs a Session holds: MAX_RUNS of the Session domain; Run indexes are below it. */
export const RELAY_MAX_RUNS = 256;
/** Native epochs start at 1 and grow by one per new native session or clear, each after at least one event. */
export const RELAY_MAX_EPOCH = RELAY_MAX_SEQ + 1;
/** Bounds of the Drivers' declarations (host names, model identities, authentication kinds); the relay itself no longer reads them. */
export const MAX_HOST_BYTES = 253;
export const MAX_RELAY_MODEL_BYTES = 96;
export const MAX_AUTH_KIND_BYTES = 16;
export const MAX_VENDOR_NAME_BYTES = 128;
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
/** The bound of a Driver's delivery position (a type kept for the Drivers' declarations, see below). */
export const RELAY_POSITION_BYTES = 4096;
export const RELAY_INDEX_BYTES = 2048;
export const RELAY_PREF_VALUE_BYTES = 64;

// ---------------------------------------------------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------------------------------------------------

declare const packetBrand: unique symbol, printBrand: unique symbol, pinBrand: unique symbol, exclBrand: unique symbol, tagBrand: unique symbol, hmacBrand: unique symbol;
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

/** Exactly the members of `B`: a compile-time check that an array lists a union imported from another contract. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** The two tiers of a packet: everything of the record fits (`full`), or whole items were left out and the ledger says which (`brief`). */
export const TIERS = ["full", "brief"] as const;
export type Tier = typeof TIERS[number];
export const LANGUAGES = ["zh", "en"] as const;
export type Language = typeof LANGUAGES[number];
export type { CommandClass, ContextEffect };
export const CONTEXT_EFFECTS = ["keep", "none", "compact", "clear", "rewind", "unknown"] as const;
/** A catalog entry's context effect; it may depend on the arguments (OpenClaw `/reset soft`, Hermes `/compress --preview`). */
export type ContextEffectRule = ContextEffect | { readonly byArgs: (args: string) => ContextEffect };

// ---- Kept for the Drivers -------------------------------------------------------------------------------------------
// The types below are no longer read by the relay: the Drivers' static declarations (RelayCapabilities) and optional members
// (HarnessControl.verifyDelivered, deliveryPosition, relayVendor) still name them until the Driver branch removes those.

export const VENDOR_NAMES = ["anthropic", "openai", "deepseek", "google", "aws-bedrock", "google-vertex", "local"] as const;
export const VENDOR_PREFIXES = ["gateway", "router", "provider", "unknown"] as const;
export type VendorKey = typeof VENDOR_NAMES[number] | `gateway:${string}` | `router:${string}` | `provider:${string}` | `unknown:${string}`;
export const ENDPOINT_LAYERS = ["harness_default", "user_config", "project_config", "workspace_file", "environment"] as const;
export type EndpointLayer = typeof ENDPOINT_LAYERS[number];
export interface VendorObservation {
  readonly model: string | null;
  readonly modelKey: string;
  readonly authKind: string | null;
  readonly endpoint: { readonly host: string; readonly layer: EndpointLayer } | null;
  readonly loopback: boolean;
}
export type DeliveryPosition =
  | { readonly kind: "file_offset"; readonly path: string; readonly bytes: number }
  | { readonly kind: "seq"; readonly before: number }
  | { readonly kind: "client_id"; readonly id: string }
  | { readonly kind: "none" };
export const MARKER_RESULTS = ["present", "absent", "outside_window", "compacted", "unavailable"] as const;
export type MarkerResult = typeof MARKER_RESULTS[number];
export interface VerifyResult {
  readonly markers: readonly { readonly packetId: RelayPacketId; readonly result: MarkerResult }[];
  readonly historyEmpty: boolean | null;
  readonly compaction: { readonly count: number; readonly digest: Fingerprint | null } | null;
  readonly foreignAfterLast: number | null;
  readonly verifyMs: number;
}

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
export const DELIVERY_VERIFY = ["after_turn", "on_next_open", "none"] as const;
export const EXECUTION_KINDS = ["process", "gateway"] as const;
export const UNLISTED_SLASH = ["executed", "text"] as const;
export const PLACEMENT_PARTS = ["multiple", "single"] as const;
export const WINDOW_REPORTS = ["session_report", "turn_report", "none"] as const;
export const CACHE_TTLS = ["5m", "30m", "1h", "hours", "unknown", "auth_dependent"] as const;
export const COMPACTION_EVIDENCE = ["event", "replay_marker", "usage_drop", "none"] as const;
export const TITLE_MODES = ["set", "none"] as const;
export const HOST_PATH_READ = ["verified", "declared", "needs_grant", "none"] as const;
export const PRE_APPROVAL = ["session_allow_list", "read_only_auto", "unknown"] as const;
/**
 * A Driver's static relay declaration: only mechanisms, never product names; a missing item is the most conservative value. A
 * module-level constant, read at admission without a control instance. What the relay reads of it: `delivery.live` and
 * `delivery.successProvesRecorded` (whether a send can ever be confirmed), `execution`, `commands.classify`, `placement`,
 * `window` and `title`. The other members are still filled by the Drivers and read by nothing.
 */
export interface RelayCapabilities {
  readonly probed: boolean;
  readonly delivery: { readonly live: typeof DELIVERY_LIVE[number]; readonly verify: typeof DELIVERY_VERIFY[number]; readonly successProvesRecorded: boolean; readonly lateDelivery: boolean };
  readonly execution: typeof EXECUTION_KINDS[number];
  readonly commands: {
    readonly unlistedSlash: typeof UNLISTED_SLASH[number];
    readonly hidden: readonly { readonly name: string; readonly effect: ContextEffectRule; readonly acceptsRelay?: boolean }[];
    /**
     * The native side's reading of an input: the same reading as the Driver's HarnessControl.classify, over a catalog of this
     * shape (null before one is read) and the kinds of the input's attachments, which some native sides read by. Pure and synchronous.
     */
    readonly classify: (text: string, catalog: readonly { readonly name: string; readonly effect: ContextEffectRule; readonly acceptsRelay?: boolean }[] | null, attachments: readonly ContentKind[]) => CommandClass;
  };
  readonly placement: { readonly parts: typeof PLACEMENT_PARTS[number]; readonly maxInput: { readonly unit: "chars" | "bytes"; readonly limit: number } | null; readonly pointersAfterUser: boolean;
    /**
     * The size of what this Driver hands its native side for `turn` (the placed text, with an allowance for what the native
     * side or the Driver adds that is unknown before dispatch), in `maxInput`'s unit. Pure and synchronous: the coordinator
     * chooses the packet's size by it before dispatch; the Driver's own refusal of a Turn over the bound stays as the backstop.
     */
    readonly measure: (turn: TurnText, attachments: readonly ContentKind[]) => number };
  readonly window: typeof WINDOW_REPORTS[number];
  readonly fixedPrefix: { readonly tokens: number; readonly basis: "measured" | "assumed" } | null;
  readonly cacheTtl: typeof CACHE_TTLS[number];
  readonly compactionEvidence: typeof COMPACTION_EVIDENCE[number];
  readonly resolveVendor: (observed: VendorObservation) => VendorKey;
  readonly normalizeModel: (model: string | null) => string;
  readonly title: typeof TITLE_MODES[number];
  readonly hostPathRead: typeof HOST_PATH_READ[number];
  readonly sessionTools: null | { readonly owner: "program"; readonly listFrozenAtCreate: true; readonly preApproval: typeof PRE_APPROVAL[number] };
}
/** What a Turn hands its Driver: the input alone, or the user's words with a relay packet the Driver places. */
export type TurnText = string | { readonly user: string; readonly relay: { readonly packetId: RelayPacketId; readonly body: string; readonly firstLine: boolean } };

// ---- The packet manifest --------------------------------------------------------------------------------------------

export const DATA_CLASSES = ["user_text", "hub_text", "harness_text", "exec_output", "external_output", "file_diff", "credential_path", "workspace_meta", "thinking"] as const;
export type DataClass = typeof DATA_CLASSES[number];
export const AUTHORS = ["hub", "user", "harness_report", "harness_note", "imported"] as const;
export type Author = typeof AUTHORS[number];
export const SECTION_IDS = ["words", "state", "record", "failures", "files", "plan", "approvals", "note", "away", "anchor", "omissions"] as const;
export type SectionId = typeof SECTION_IDS[number];
export const OMISSION_CATEGORIES = ["user_message", "reply", "tool_call", "tool_output", "diff", "external_output", "thinking", "attachment", "origin_message", "file_row", "plan_entry", "approval", "redacted_secret", "unscanned", "excluded_by_user", "uncounted"] as const;
export type OmissionCategory = typeof OMISSION_CATEGORIES[number];
export const RETRIEVALS = ["hub_detail_view", "workspace", "native_session", "none"] as const;
export interface Omission { readonly category: OmissionCategory; readonly count: number; readonly chars: number | null; readonly runs: readonly [number, number] | null; readonly retrieval: typeof RETRIEVALS[number] }
/** Fact seqs (a Run's `run.ended` seq, the origin's 0) and Run indexes a packet carries. */
export interface SourceRange { readonly fromSeq: number; readonly throughSeq: number; readonly fromRun: number; readonly throughRun: number }
export const GRADES = ["verbatim", "compact", "line", "range"] as const;
export type Grade = typeof GRADES[number];
export const PACKET_KINDS = ["packet", "delta", "anchor", "resend"] as const;
export type RelayPacketKind = typeof PACKET_KINDS[number];
export const SOURCE_KINDS = ["other", "same_program", "multiple"] as const;
/** Where the window a packet was budgeted against came from: what the target's own Turn reported, or the assumption. */
export const WINDOW_SOURCES = ["session_report", "assumed"] as const;
export const BUDGET_CLAMPS = ["window", "input_limit"] as const;
export const FOLD_WHY = ["tail", "head", "anchor", "user", "middle"] as const;
export const USER_EDIT_KINDS = ["excluded_run", "excluded_section", "note_added", "tier_changed", "pinned", "revealed"] as const;
export const FIRST_LINE_OMITTED = ["slash", "secret_hit"] as const;
/** A packet's manifest (immutable; its text lives in relay_bodies, deduplicated by (session, sha256)). */
export interface RelayPacket {
  readonly id: RelayPacketId;
  readonly kind: RelayPacketKind;
  readonly tier: Tier;
  readonly complete: boolean;
  readonly target: { readonly harnessId: string; readonly controlId: string; readonly model: string | null; readonly nativeEpoch: number };
  readonly source: { readonly kind: typeof SOURCE_KINDS[number]; readonly names: readonly { readonly harnessId: string; readonly model: string | null; readonly runs: readonly [number, number] }[] };
  readonly range: SourceRange;
  readonly basePacketId: RelayPacketId | null;
  readonly supersedes: RelayPacketId | null;
  readonly policyVersion: PolicyVersion;
  readonly language: Language;
  readonly factsFingerprint: Fingerprint;
  readonly inputs: { readonly attachOverride: boolean; readonly digestBehind: readonly number[]; readonly detailsMissing: readonly number[]; readonly noteIncluded: boolean; readonly firstLineOmitted: typeof FIRST_LINE_OMITTED[number] | null };
  readonly redaction: { readonly profile: "egress"; readonly count: number; readonly byClass: Readonly<Record<string, number>>; readonly overridden: number; readonly unscanned: number };
  readonly body: { readonly sha256: Fingerprint; readonly bytes: number; readonly estTokens: number; readonly estimator: "est/2"; readonly untrustedTokens: number; readonly userTokens: number };
  readonly budget: { readonly capTokens: number; readonly userCap: number; readonly untrustedCap: number; readonly window: number; readonly fixedPrefix: number; readonly windowSource: typeof WINDOW_SOURCES[number]; readonly clampedBy: readonly typeof BUDGET_CLAMPS[number][] };
  readonly sections: readonly { readonly id: SectionId; readonly author: Author; readonly items: number; readonly estTokens: number; readonly dataClasses: readonly DataClass[] }[];
  readonly fold: readonly ({ readonly kind: "unit"; readonly runIndex: number; readonly grade: Grade; readonly why: typeof FOLD_WHY[number] } | { readonly kind: "range"; readonly fromRun: number; readonly throughRun: number; readonly units: number } | { readonly kind: "excluded"; readonly runIndex: number; readonly by: "user" | "unscanned" })[];
  readonly omissions: readonly Omission[];
  readonly userEdits: readonly { readonly kind: typeof USER_EDIT_KINDS[number]; readonly ref: string }[];
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
/** What recovery changes of a Session's relay state besides recoverSession's own changes. */
export interface RelayRecovery { readonly next: SessionSnapshot; readonly deliveries: readonly RelayRecoveredDelivery[] }
/**
 * The relay part of recovery: given a Session as recoverSession left it and its delivery rows, the Session with its bindings'
 * relay state recovered and the deliveries to decide; null when nothing changes. Pure and synchronous; the Store calls it in
 * claimAndRecover's transaction, inside a SAVEPOINT of the Session's own. `packets` are the Session's packet manifests (the
 * range of a packet that was in flight comes from its manifest); a caller without them passes none.
 */
export type RecoverRelay = (state: SessionSnapshot, deliveries: readonly DeliveryRecord[], packets?: readonly RelayPacket[]) => RelayRecovery | null;
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
/** A host name or address literal as a gateway key holds it: lower case, ≤ MAX_HOST_BYTES (kept for the Drivers' vendor declarations). */
function host(value: unknown, label: string): string {
  const text = bounded(value, label, MAX_HOST_BYTES);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])$/u.test(text)) invalid(label);
  return text;
}
/** Kept for the Drivers' vendor declarations (their tests): the relay itself reads no vendor key any more. */
export function parseVendorKey(value: unknown): VendorKey {
  if (typeof value === "string" && (VENDOR_NAMES as readonly string[]).includes(value)) return value as VendorKey;
  if (typeof value !== "string") invalid("vendor key");
  const at = value.indexOf(":"), prefix = value.slice(0, at), rest = value.slice(at + 1);
  if (at < 1 || !(VENDOR_PREFIXES as readonly string[]).includes(prefix)) invalid("vendor key");
  if (prefix === "gateway") host(rest, "gateway vendor host");
  else if (prefix === "unknown") catalogIdentity(rest, "unknown vendor Harness");
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(bounded(rest, "vendor name", MAX_VENDOR_NAME_BYTES))) invalid("vendor name");
  return value as VendorKey;
}
export function parseVendorObservation(value: unknown): VendorObservation {
  const item = object(value, "vendor observation"); only(item, ["model", "modelKey", "authKind", "endpoint", "loopback"], "vendor observation");
  return { model: nullable(item.model, raw => bounded(raw, "observed model", MAX_RELAY_MODEL_BYTES)), modelKey: bounded(item.modelKey, "observed model key", MAX_RELAY_MODEL_BYTES, true),
    authKind: nullable(item.authKind, raw => bounded(raw, "observed authentication kind", MAX_AUTH_KIND_BYTES)),
    endpoint: nullable(item.endpoint, raw => { const row = object(raw, "observed endpoint"); only(row, ["host", "layer"], "observed endpoint");
      return { host: host(row.host, "observed endpoint host"), layer: choice(row.layer, ENDPOINT_LAYERS, "observed endpoint layer") }; }),
    loopback: flag(item.loopback, "observed loopback") };
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
const ids = (value: unknown, label: string) => list(value, label, RELAY_MAX_RUNS, raw => integer(raw, label, 0, RELAY_MAX_RUNS - 1));
const tokens = (value: unknown, label: string) => counter(value, label);
const runSpan = (value: unknown, label: string): readonly [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) invalid(label);
  const from = integer(value[0], label, 0, RELAY_MAX_RUNS - 1), through = integer(value[1], label, 0, RELAY_MAX_RUNS - 1);
  if (through < from) invalid(label);
  return [from, through];
};
/** A packet manifest, checked field by field and against RELAY_MANIFEST_BYTES. */
export function parseRelayPacket(value: unknown): RelayPacket {
  const item = object(value, "relay packet");
  only(item, ["id", "kind", "tier", "complete", "target", "source", "range", "basePacketId", "supersedes", "policyVersion", "language", "factsFingerprint", "inputs", "redaction", "body", "budget", "sections", "fold", "omissions", "userEdits"], "relay packet");
  const target = object(item.target, "packet target"); only(target, ["harnessId", "controlId", "model", "nativeEpoch"], "packet target");
  const source = object(item.source, "packet source"); only(source, ["kind", "names"], "packet source");
  const inputs = object(item.inputs, "packet inputs"); only(inputs, ["attachOverride", "digestBehind", "detailsMissing", "noteIncluded", "firstLineOmitted"], "packet inputs");
  const redaction = object(item.redaction, "packet redaction"); only(redaction, ["profile", "count", "byClass", "overridden", "unscanned"], "packet redaction");
  const body = object(item.body, "packet body"); only(body, ["sha256", "bytes", "estTokens", "estimator", "untrustedTokens", "userTokens"], "packet body");
  const budget = object(item.budget, "packet budget"); only(budget, ["capTokens", "userCap", "untrustedCap", "window", "fixedPrefix", "windowSource", "clampedBy"], "packet budget");
  const byClass = object(redaction.byClass, "packet redaction classes");
  if (redaction.profile !== "egress" || body.estimator !== "est/2") invalid("packet redaction profile or estimator");
  const packet: RelayPacket = {
    id: relayPacketId(item.id), kind: choice(item.kind, PACKET_KINDS, "packet kind"), tier: choice(item.tier, TIERS, "packet tier"), complete: flag(item.complete, "packet completeness"),
    target: { harnessId: catalogIdentity(target.harnessId, "packet target Harness"), controlId: catalogIdentity(target.controlId, "packet target control"), model: nullable(target.model, raw => bounded(raw, "packet target model", 1024)),
      nativeEpoch: integer(target.nativeEpoch, "packet target epoch", 1, RELAY_MAX_EPOCH) },
    source: { kind: choice(source.kind, SOURCE_KINDS, "packet source kind"), names: list(source.names, "packet source names", 64, raw => { const row = object(raw, "packet source name"); only(row, ["harnessId", "model", "runs"], "packet source name");
      return { harnessId: catalogIdentity(row.harnessId, "packet source Harness"), model: nullable(row.model, raw => bounded(raw, "packet source model", 1024)), runs: runSpan(row.runs, "packet source runs") }; }) },
    range: parseSourceRange(item.range), basePacketId: nullable(item.basePacketId, relayPacketId), supersedes: nullable(item.supersedes, relayPacketId),
    policyVersion: policyVersion(item.policyVersion), language: choice(item.language, LANGUAGES, "packet language"), factsFingerprint: fingerprint(item.factsFingerprint),
    inputs: { attachOverride: flag(inputs.attachOverride, "packet attach override"), digestBehind: ids(inputs.digestBehind, "packet digests behind"), detailsMissing: ids(inputs.detailsMissing, "packet details missing"),
      noteIncluded: flag(inputs.noteIncluded, "packet note included"), firstLineOmitted: nullable(inputs.firstLineOmitted, raw => choice(raw, FIRST_LINE_OMITTED, "packet first line omission")) },
    redaction: { profile: "egress", count: counter(redaction.count, "packet redactions"), byClass: Object.fromEntries(Object.entries(byClass).map(([key, count]) => [bounded(key, "redaction class", 64), counter(count, "redaction class count")])),
      overridden: counter(redaction.overridden, "packet redactions overridden"), unscanned: counter(redaction.unscanned, "packet unscanned") },
    body: { sha256: fingerprint(body.sha256), bytes: integer(body.bytes, "packet body bytes", 1, RELAY_BODY_BYTES), estTokens: tokens(body.estTokens, "packet tokens"), estimator: "est/2",
      untrustedTokens: tokens(body.untrustedTokens, "packet untrusted tokens"), userTokens: tokens(body.userTokens, "packet user tokens") },
    budget: { capTokens: tokens(budget.capTokens, "packet cap"), userCap: tokens(budget.userCap, "packet user cap"), untrustedCap: tokens(budget.untrustedCap, "packet untrusted cap"), window: tokens(budget.window, "packet window"),
      fixedPrefix: tokens(budget.fixedPrefix, "packet fixed prefix"), windowSource: choice(budget.windowSource, WINDOW_SOURCES, "packet window source"), clampedBy: list(budget.clampedBy, "packet clamps", BUDGET_CLAMPS.length, raw => choice(raw, BUDGET_CLAMPS, "packet clamp")) },
    sections: list(item.sections, "packet sections", SECTION_IDS.length, raw => { const row = object(raw, "packet section"); only(row, ["id", "author", "items", "estTokens", "dataClasses"], "packet section");
      return { id: choice(row.id, SECTION_IDS, "packet section id"), author: choice(row.author, AUTHORS, "packet section author"), items: counter(row.items, "packet section items"), estTokens: tokens(row.estTokens, "packet section tokens"),
        dataClasses: list(row.dataClasses, "packet section data classes", DATA_CLASSES.length, raw => choice(raw, DATA_CLASSES, "packet data class")) }; }),
    fold: list(item.fold, "packet fold", RELAY_MAX_RUNS, raw => {
      const row = object(raw, "packet fold unit");
      switch (row.kind) {
        case "unit": only(row, ["kind", "runIndex", "grade", "why"], "packet fold unit"); return { kind: "unit" as const, runIndex: integer(row.runIndex, "fold Run index", 0, RELAY_MAX_RUNS - 1), grade: choice(row.grade, GRADES, "fold grade"), why: choice(row.why, FOLD_WHY, "fold reason") };
        case "range": { only(row, ["kind", "fromRun", "throughRun", "units"], "packet fold range"); const [fromRun, throughRun] = runSpan([row.fromRun, row.throughRun], "fold range");
          return { kind: "range" as const, fromRun, throughRun, units: integer(row.units, "fold range units", 1, RELAY_MAX_RUNS) }; }
        case "excluded": only(row, ["kind", "runIndex", "by"], "packet fold exclusion"); return { kind: "excluded" as const, runIndex: integer(row.runIndex, "fold Run index", 0, RELAY_MAX_RUNS - 1), by: choice(row.by, ["user", "unscanned"] as const, "fold exclusion") };
      }
      return invalid("packet fold unit");
    }),
    omissions: list(item.omissions, "packet omissions", OMISSION_CATEGORIES.length * 4, raw => { const row = object(raw, "packet omission"); only(row, ["category", "count", "chars", "runs", "retrieval"], "packet omission");
      return { category: choice(row.category, OMISSION_CATEGORIES, "omission category"), count: counter(row.count, "omission count"), chars: nullable(row.chars, raw => counter(raw, "omission chars")),
        runs: nullable(row.runs, raw => runSpan(raw, "omission runs")), retrieval: choice(row.retrieval, RETRIEVALS, "omission retrieval") }; }),
    userEdits: list(item.userEdits, "packet user edits", 64, raw => { const row = object(raw, "packet user edit"); only(row, ["kind", "ref"], "packet user edit");
      return { kind: choice(row.kind, USER_EDIT_KINDS, "user edit kind"), ref: bounded(row.ref, "user edit ref", 256) }; }),
  };
  if (utf8(JSON.stringify(packet)) > RELAY_MANIFEST_BYTES) throw new SessionError("INVALID_DATA", "relay packet manifest exceeds its byte budget");
  return packet;
}
const relativePath = (value: unknown, label: string) => {
  const text = bounded(value, label, 1024);
  if (text.startsWith("/") || text.split("/").includes("..")) invalid(label);
  return text;
};
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
