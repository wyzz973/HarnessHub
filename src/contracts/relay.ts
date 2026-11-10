import type { ContentKind } from "./content.js";
import type { CommandClass, ContextEffect } from "./control.js";
import { SessionError, messageId, runId, sessionId, type MessageId, type RunId, type RunStatus, type SessionId, type SessionSnapshot } from "./session.js";

/**
 * The relay's contract (ADR-055, relay-architecture §4, §14): identities, closed unions, the per-binding and per-Run relay
 * state the Session v13 snapshot holds, the rows of the relay tables and the ports that write them. Every closed union is
 * also exported as an `as const` array, the one source the parsers below and the future JSON Schema (C006) check against.
 *
 * External or persisted input enters as `unknown` and becomes one of these types only through a parser here, which checks
 * every field, rejects unknown fields and holds each value to the byte bound written next to it; failures are
 * SessionError("INVALID_DATA"). The bounds are chosen so that the longest legal relay state of a binding and of a Run fits
 * MAX_BINDING_RELAY_BYTES and MAX_RUN_RELAY_BYTES, which the parsers also check (INV-35).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------------------

/** The largest event seq a Session can reach: MAX_SESSION_EVENTS of the Session domain (checked equal by its tests). */
export const RELAY_MAX_SEQ = 16_384;
/** The most Runs a Session holds: MAX_RUNS of the Session domain; Run indexes are below it. */
export const RELAY_MAX_RUNS = 256;
/** Native epochs start at 1 and grow by one per new native session or confirmed clear, each after at least one event. */
export const RELAY_MAX_EPOCH = RELAY_MAX_SEQ + 1;
/** A host name (DNS limit), the longest part of a gateway vendor key. */
export const MAX_HOST_BYTES = 253;
/** A model identity and its normalized key as a binding keeps them (ADR-055 §10.4); longer ones are not kept. */
export const MAX_RELAY_MODEL_BYTES = 96;
/** The authentication kind a Driver reports (account, api_key…), only shown in words. */
export const MAX_AUTH_KIND_BYTES = 16;
/** A named router or Provider in a vendor key. */
export const MAX_VENDOR_NAME_BYTES = 128;
/** Counters a native side reports (compactions, context tokens). */
export const MAX_RELAY_COUNTER = 2_147_483_647;
/** Epoch milliseconds, as everywhere in the Session. */
export const MAX_RELAY_TIME = 8.64e15;
/**
 * The serialized `relay` of one binding. Relay-architecture §0 and §11.1 aim at 1,024 B; with the fields of §4 the longest
 * legal value is about twice that (a pending sync whose prior is a suspect carrying a packet, a 253-byte gateway host in
 * both the consent key and the observed endpoint), so this is the bound every legal value is held to (G066 records the
 * difference in ADR-055's implementation notes).
 */
export const MAX_BINDING_RELAY_BYTES = 2048;
/**
 * The serialized relay fields of one Run (`{ relay, relayRequest }`); the snapshot also gains contextReadyAt and recordedAt,
 * two bounded times (≤ 64 B with their keys). Relay-architecture §0 aims at 320 B; with 96-byte Harness and control
 * identities in `executedOn` and the 64-hex request fingerprint the longest legal value is 562 B, which this bound holds
 * (see MAX_BINDING_RELAY_BYTES).
 */
export const MAX_RUN_RELAY_BYTES = 576;
/** Relay table bounds (relay-architecture §14.1), checked on serialized bytes before any statement runs (INV-35). */
export const RELAY_BODY_BYTES = 262_144;
export const RELAY_SESSION_BODY_BYTES = 64 * 1024 * 1024;
export const RELAY_MANIFEST_BYTES = 65_536;
export const RELAY_POSITION_BYTES = 4096;
export const RELAY_INDEX_BYTES = 2048;
export const RELAY_DIGEST_BYTES = 65_536;
export const RELAY_WORKSPACE_FILES = 1000;
export const RELAY_WORKSPACE_BYTES = 131_072;
export const RELAY_PINS = 24;
export const RELAY_PIN_BYTES = 2048;
export const RELAY_PINS_BYTES = 12_288;
export const RELAY_PREF_VALUE_BYTES = 64;
/** The installation's consent log: rows kept before it is rotated, and rows its archive may reach. */
export const RELAY_LOG_ROWS = 65_536;
export const RELAY_LOG_ARCHIVE_ROWS = 1_048_576;
/** How long an observed context window is kept and read (relay-architecture §14.1). */
export const RELAY_WINDOW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------------------------------------------------

declare const packetBrand: unique symbol, printBrand: unique symbol, pinBrand: unique symbol, tagBrand: unique symbol, exclBrand: unique symbol, hmacBrand: unique symbol;
/** "relay-" + 20 Crockford base32 digits (lower case) of the sha256 of the final text with a placeholder in its ID slot. */
export type RelayPacketId = string & { readonly [packetBrand]: true };
/** sha256, 64 lower-case hex digits; never of a value that may be a secret (INV-29: those use HmacDigest). */
export type Fingerprint = string & { readonly [printBrand]: true };
export type PinId = string & { readonly [pinBrand]: true };
export type ExclusionId = string & { readonly [exclBrand]: true };
/** The first 8 hex digits of HMAC-SHA256(session subkey, value). */
export type RedactionTag = string & { readonly [tagBrand]: true };
/** HMAC-SHA256(session subkey, value), 64 hex digits: every fingerprint of what may be a secret (INV-29). */
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
export function pinId(value: unknown): PinId { return patterned(value, /^pin-[A-Za-z0-9-]{1,96}$/u, "pin identity"); }
export function exclusionId(value: unknown): ExclusionId { return patterned(value, /^exclusion-[A-Za-z0-9-]{1,96}$/u, "exclusion identity"); }
export function policyVersion(value: unknown): PolicyVersion { return patterned(value, /^relay\/(?:0|[1-9][0-9]{0,5})$/u, "relay policy version"); }
/** sha256("") in hex: the chain of a mark that no packet built (relay-architecture §7.2, RT1-m6's legacy chain). */
export const EMPTY_CHAIN = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as Fingerprint;

// ---------------------------------------------------------------------------------------------------------------------
// Closed unions
// ---------------------------------------------------------------------------------------------------------------------

/** Exactly the members of `B`: a compile-time check that an array lists a union imported from another contract. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

export const TIERS = ["goal", "brief", "standard", "fidelity", "full"] as const;
export type Tier = typeof TIERS[number];
export const LANGUAGES = ["zh", "en"] as const;
export type Language = typeof LANGUAGES[number];
export type { CommandClass, ContextEffect };
export const CONTEXT_EFFECTS = ["keep", "none", "compact", "clear", "rewind", "unknown"] as const;
export type ContextEffectsAreListed = Holds<Exact<typeof CONTEXT_EFFECTS[number], ContextEffect>>;
/** A catalog entry's context effect; it may depend on the arguments (OpenClaw `/reset soft`, Hermes `/compress --preview`). */
export type ContextEffectRule = ContextEffect | { readonly byArgs: (args: string) => ContextEffect };

export const VENDOR_NAMES = ["anthropic", "openai", "deepseek", "google", "aws-bedrock", "google-vertex", "local"] as const;
export const VENDOR_PREFIXES = ["gateway", "router", "provider", "unknown"] as const;
/**
 * The vendor that serves a binding's model requests, as its Driver declares it from the endpoint it resolved itself
 * (ADR-055 §10.4); `allow` never overrides `unknown:*`, `gateway:*`, `router:*` or `provider:*`.
 */
export type VendorKey = typeof VENDOR_NAMES[number] | `gateway:${string}` | `router:${string}` | `provider:${string}` | `unknown:${string}`;
export const ENDPOINT_LAYERS = ["harness_default", "user_config", "project_config", "workspace_file", "environment"] as const;
export type EndpointLayer = typeof ENDPOINT_LAYERS[number];
/** The endpoint and model a Driver resolved; host and layer only feed the vendor key and consent records, never logs. */
export interface VendorObservation {
  /** ≤ MAX_RELAY_MODEL_BYTES; null when the Driver could not tell. */
  readonly model: string | null;
  /** normalizeModel(model), ≤ MAX_RELAY_MODEL_BYTES; "" when the model is unknown. */
  readonly modelKey: string;
  /** ≤ MAX_AUTH_KIND_BYTES. */
  readonly authKind: string | null;
  /** host ≤ MAX_HOST_BYTES. */
  readonly endpoint: { readonly host: string; readonly layer: EndpointLayer } | null;
  readonly loopback: boolean;
}

/**
 * What a mark stands on: E1, E2, E3 (evidence of a packet), legacy (the v13 migration), origin (the history a session started
 * from), native (the binding's own Turn while nothing was owed), choice (the epoch base the user chose to send the complete
 * packet again from, F13). A delivery row is decided only by E1, E2 or E3 (DELIVERY_EVIDENCE).
 */
export const EVIDENCE_CLASSES = ["E1", "E2", "E3", "legacy", "origin", "native", "choice"] as const;
export type EvidenceClass = typeof EVIDENCE_CLASSES[number];
export const DELIVERY_EVIDENCE = ["E1", "E2", "E3"] as const satisfies readonly EvidenceClass[];
export type DeliveryEvidence = typeof DELIVERY_EVIDENCE[number];
export const NOT_RECORDED_REASONS = ["rejected_before_insert", "driver_synthesized", "cancelled_before_insert", "never_dispatched", "gateway_refused"] as const;
export const UNKNOWN_REASONS = ["no_evidence", "owner_ended", "verify_timeout", "verify_unavailable", "absent", "outside_window", "compacted", "late_delivery"] as const;
export const DELIVERY_STATUSES = ["in_flight", "recorded", "not_recorded", "unknown"] as const;
export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
/** What is known of one Run's packet reaching its binding's native history (R8): no evidence is unknown, never not recorded. */
export type DeliveryOutcome =
  | { readonly kind: "in_flight" }
  | { readonly kind: "recorded"; readonly evidence: DeliveryEvidence; readonly decidedSeq: number; readonly decidedAt: number; readonly verifiedInRun: RunId | null }
  | { readonly kind: "not_recorded"; readonly reason: typeof NOT_RECORDED_REASONS[number]; readonly decidedSeq: number; readonly decidedAt: number }
  | { readonly kind: "unknown"; readonly reason: typeof UNKNOWN_REASONS[number]; readonly decidedSeq: number; readonly decidedAt: number };
/**
 * The delivery outcomes a row may move between (relay-architecture §4): from in_flight to any decided one; from unknown to
 * recorded or not recorded; from not recorded to recorded (later positive evidence corrects a misjudgment, RT2-09); and the
 * same outcome again for unknown and recorded (a reason refined, realized counts settled), which is no transition (INV-31).
 */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  in_flight: ["recorded", "not_recorded", "unknown"],
  unknown: ["unknown", "recorded", "not_recorded"],
  not_recorded: ["recorded"],
  recorded: ["recorded"],
};
export function deliveryTransitionAllowed(from: DeliveryStatus, to: DeliveryStatus): boolean { return DELIVERY_TRANSITIONS[from].includes(to); }
export const POSITION_KINDS = ["file_offset", "seq", "client_id", "none"] as const;
/** Where the Driver read the native history before dispatch; a check reads only the first user entry after it (RT3 P03). */
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
export const DELIVERY_CHANNELS = ["text_block", "single_text"] as const;
/**
 * The reserved `redaction.keyId` of a delivery row whose keyed digests were made under a key kept only in the memory of the
 * owner that wrote it (rows written before G072's relay-keys, and a Runtime composed without an installation key, A17): no
 * reader can check them. The installation key (RelayKeyPort) never takes this identity. A reader that finds a `keyId` other
 * than its current key's concludes "not checkable" (不可复核), never "different"; rows are never re-keyed afterwards.
 */
export const EPHEMERAL_KEY_ID = "ephemeral";
export const REALIZED_CLOSED_BY = ["compaction", "clear", "epoch", "idle"] as const;
export interface RealizedWindow { readonly requests: number; readonly cacheHits: number; readonly closedBy: typeof REALIZED_CLOSED_BY[number] }
/**
 * One Run's delivery (at most one row per Run). The fields that vary per Run (consent seq, current input HMAC, redaction
 * context, compaction cursor at delivery, resend relation) live here, not in the packets deduplicated by text (F08).
 */
export interface DeliveryRecord {
  readonly runId: RunId;
  readonly packetId: RelayPacketId;
  readonly channel: typeof DELIVERY_CHANNELS[number];
  /** Serialized ≤ RELAY_POSITION_BYTES. */
  readonly position: DeliveryPosition;
  readonly outcome: DeliveryOutcome;
  readonly consentLogSeq: number | null;
  readonly inputHmac: HmacDigest;
  readonly redaction: { readonly rulesVersion: string; readonly keyId: string; readonly setHmac: RedactionTag };
  readonly compactionAtDelivery: { readonly count: number; readonly digest: Fingerprint | null } | null;
  readonly resendOf: RunId | null;
  readonly attachOverride: boolean;
  readonly verifyMs: number | null;
  readonly realized: RealizedWindow | null;
}

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
 * A Driver's static relay declaration (relay-architecture §3.2, §8): only mechanisms, never product names; a missing item
 * is the most conservative value (INV-16). A module-level constant, read at admission without a control instance (F10).
 * Drivers declare it (G069: each Driver module's relayCapabilities, also HarnessControl.relayCapabilities).
 */
export interface RelayCapabilities {
  readonly probed: boolean;
  readonly delivery: { readonly live: typeof DELIVERY_LIVE[number]; readonly verify: typeof DELIVERY_VERIFY[number]; readonly successProvesRecorded: boolean; readonly lateDelivery: boolean };
  readonly execution: typeof EXECUTION_KINDS[number];
  readonly commands: {
    readonly unlistedSlash: typeof UNLISTED_SLASH[number];
    readonly hidden: readonly { readonly name: string; readonly effect: ContextEffectRule; readonly acceptsRelay?: boolean }[];
    /**
     * The native side's reading of an input (VF1-06): the same reading as the Driver's HarnessControl.classify, over a
     * catalog of this shape (null before one is read) and the kinds of the input's attachments, which some native sides read
     * by (an image makes Hermes run no command; any attachment makes Codex's thread operations text). Pure and synchronous.
     */
    readonly classify: (text: string, catalog: readonly { readonly name: string; readonly effect: ContextEffectRule; readonly acceptsRelay?: boolean }[] | null, attachments: readonly ContentKind[]) => CommandClass;
  };
  readonly placement: { readonly parts: typeof PLACEMENT_PARTS[number]; readonly maxInput: { readonly unit: "chars" | "bytes"; readonly limit: number } | null; readonly pointersAfterUser: boolean;
    /**
     * The size of what this Driver hands its native side for `turn` (the placed text, with an allowance for what the native
     * side or the Driver adds that is unknown before dispatch: each attachment's pointer, a working-directory prefix), in
     * `maxInput`'s unit (Unicode code points without a bound). Pure and synchronous: the coordinator chooses the packet's
     * size by it before dispatch (ADR-055 C3, the approval agent's decision on the stage-two review); the Driver's own refusal
     * of a Turn over the bound (INPUT_LIMIT_REFUSED) stays as the backstop. Never smaller than what the Driver measures itself.
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
/** What a Turn hands its Driver: the input alone, or the user's words with a relay packet the Driver places (§3.2). */
export type TurnText = string | { readonly user: string; readonly relay: { readonly packetId: RelayPacketId; readonly body: string; readonly firstLine: boolean } };

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
export const WINDOW_SOURCES = ["session_report", "observed_recent", "documented", "assumed_cloud", "assumed_gateway", "assumed_local"] as const;
export const BUDGET_CLAMPS = ["window", "input_limit", "cost_tier", "latency_tier", "cliff_tier"] as const;
export const FOLD_WHY = ["tail", "head", "anchor", "user", "middle"] as const;
export const USER_EDIT_KINDS = ["excluded_run", "excluded_section", "note_added", "tier_changed", "pinned", "revealed"] as const;
export const FIRST_LINE_OMITTED = ["slash", "secret_hit"] as const;
/** A packet's manifest (immutable; its text lives in relay_bodies, deduplicated by (session, sha256)). */
export interface RelayPacket {
  readonly id: RelayPacketId;
  readonly kind: RelayPacketKind;
  readonly tier: Tier;
  readonly complete: boolean;
  readonly reanchor: boolean;
  readonly target: { readonly harnessId: string; readonly controlId: string; readonly model: string | null; readonly vendor: VendorKey; readonly nativeEpoch: number };
  readonly source: { readonly kind: typeof SOURCE_KINDS[number]; readonly names: readonly { readonly harnessId: string; readonly model: string | null; readonly runs: readonly [number, number] }[] };
  readonly range: SourceRange;
  readonly basePacketId: RelayPacketId | null;
  readonly supersedes: RelayPacketId | null;
  readonly policyVersion: PolicyVersion;
  readonly language: Language;
  readonly factsFingerprint: Fingerprint;
  readonly workspaceObservationSeq: number | null;
  readonly inputs: { readonly attachOverride: boolean; readonly digestBehind: readonly number[]; readonly detailsMissing: readonly number[]; readonly noteIncluded: boolean; readonly firstLineOmitted: typeof FIRST_LINE_OMITTED[number] | null };
  readonly redaction: { readonly profile: "egress"; readonly count: number; readonly byClass: Readonly<Record<string, number>>; readonly overridden: number; readonly unscanned: number };
  readonly body: { readonly sha256: Fingerprint; readonly bytes: number; readonly estTokens: number; readonly estimator: "est/2"; readonly family: string; readonly untrustedTokens: number; readonly userTokens: number };
  readonly budget: { readonly capTokens: number; readonly userCap: number; readonly untrustedCap: number; readonly window: number; readonly fixedPrefix: number; readonly windowSource: typeof WINDOW_SOURCES[number]; readonly clampedBy: readonly typeof BUDGET_CLAMPS[number][] };
  readonly sections: readonly { readonly id: SectionId; readonly author: Author; readonly items: number; readonly estTokens: number; readonly dataClasses: readonly DataClass[] }[];
  readonly fold: readonly ({ readonly kind: "unit"; readonly runIndex: number; readonly grade: Grade; readonly why: typeof FOLD_WHY[number] } | { readonly kind: "range"; readonly fromRun: number; readonly throughRun: number; readonly units: number } | { readonly kind: "excluded"; readonly runIndex: number; readonly by: "user" | "unscanned" })[];
  readonly omissions: readonly Omission[];
  readonly userEdits: readonly { readonly kind: typeof USER_EDIT_KINDS[number]; readonly ref: string }[];
}

/** Where a Run ran: its binding's Harness, control and native epoch at dispatch; null when no native session holds it. */
export interface ExecutedOn { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }
/** The narrow index of one finished Run's digest (about 200 B), read without parsing the digest (RT3 P05). G070 builds it. */
export interface RunDigestIndex {
  readonly runId: RunId; readonly index: number; readonly seq: number; readonly executedOn: ExecutedOn | null; readonly dispatched: boolean;
  readonly status: RunStatus; readonly input: "recorded" | "not_recorded" | "unknown"; readonly commandEffect: ContextEffect | null; readonly failed: boolean; readonly hasPlan: boolean; readonly detailsMissing: boolean;
  readonly size: Readonly<Record<Language, Readonly<Record<Grade, number>>>>; readonly untrusted: number; readonly userChars: number;
  readonly counts: Readonly<Record<OmissionCategory, number>>;
  readonly line: { readonly displayName: string; readonly model: string | null; readonly result: string; readonly userHead: string; readonly files: number; readonly commands: number; readonly failedCommands: number };
}
/**
 * The index a v13 migration writes for each finished dispatched Run of a v12 Session (status behind, policy "relay/0"):
 * only what the Run's events say, chiefly where it ran (relay-architecture §14.4); the digest is rebuilt lazily (§6.4).
 */
export interface RelayBehindIndex {
  readonly runId: RunId; readonly index: number; readonly seq: number; readonly executedOn: ExecutedOn | null; readonly dispatched: true;
  readonly status: RunStatus; readonly input: "recorded" | "not_recorded" | "unknown"; readonly commandEffect: ContextEffect | null;
}
export const NARRATED_KINDS = ["read", "search", "edit", "create", "delete", "move", "exec", "fetch", "subagent", "other"] as const;
export const FILE_OPS = ["edit", "create", "delete", "move", "unknown"] as const;
export const APPROVAL_OUTCOMES = ["approved", "denied", "closed", "expired"] as const;
export const DIGEST_BOUND_ORDER = ["narrated", "commands", "failures", "files", "plan", "approvals", "reply", "user"] as const;
/** One finished Run's digest, ≤48 KiB once bound (the CHECK of 65,536 B is only a bug assertion). G070 builds it. */
export interface RunDigest {
  readonly runId: RunId; readonly index: number; readonly seq: number; readonly policyVersion: PolicyVersion; readonly secretSetHmac: RedactionTag;
  readonly executedOn: ExecutedOn | null; readonly by: { readonly harnessId: string; readonly model: string | null }; readonly status: RunStatus; readonly dispatched: boolean; readonly input: RunDigestIndex["input"];
  readonly error: { readonly code: string; readonly message: string } | null; readonly command: { readonly name: string; readonly effect: ContextEffect } | null;
  readonly sent: { readonly hmac: RedactionTag; readonly packetId: RelayPacketId | null };
  readonly user: { readonly chars: number; readonly hmac: RedactionTag; readonly head: string; readonly tail: string; readonly attachments: readonly { readonly name: string; readonly mediaType: string; readonly bytes: number }[] };
  readonly reply: { readonly chars: number; readonly head: string; readonly tail: string };
  readonly tools: { readonly total: number; readonly failed: number; readonly byKind: Readonly<Record<string, number>>; readonly capped: boolean };
  readonly narrated: readonly { readonly kind: typeof NARRATED_KINDS[number]; readonly items: readonly string[]; readonly exitCode?: number | null; readonly tail?: string }[];
  readonly commands: readonly { readonly text: string; readonly exitCode: number | null; readonly failed: boolean; readonly verification: boolean; readonly irreversible: boolean; readonly tail: string }[];
  readonly failures: readonly { readonly title: string; readonly command: string | null; readonly exitCode: number | null; readonly tail: string }[];
  readonly files: readonly { readonly path: string; readonly op: typeof FILE_OPS[number]; readonly added: number | null; readonly removed: number | null; readonly credentialPath: boolean }[];
  readonly plan: { readonly completed: number; readonly open: number; readonly openItems: readonly string[] } | null;
  readonly approvals: readonly { readonly title: string; readonly outcome: typeof APPROVAL_OUTCOMES[number]; readonly kind: "approval" | "question" }[];
  readonly activities: { readonly compaction: number; readonly compactionCapped: boolean; readonly subagents: number; readonly background: number };
  readonly detailsMissing: boolean;
  readonly bound: readonly typeof DIGEST_BOUND_ORDER[number][];
}
export const DIGEST_STATUSES = ["current", "behind"] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Binding and Run relay state (Session v13)
// ---------------------------------------------------------------------------------------------------------------------

export const MARK_BASES = ["evidence", "origin", "legacy", "native"] as const;
/** The upper bound of facts the binding is known to hold, by positive evidence or by running them itself. */
export interface DeliveredMark { readonly throughSeq: number; readonly chain: Fingerprint; readonly lastPacketId: RelayPacketId | null; readonly evidence: EvidenceClass; readonly basis: typeof MARK_BASES[number] }
export const FRESH_BASES = ["new", "user_cleared", "reset"] as const;
export const SUSPECT_CAUSES = ["rewind", "unknown_command", "legacy", "marker_absent", "clear_unconfirmed", "unknown_turn"] as const;
export type SuspectCause = typeof SUSPECT_CAUSES[number];
/**
 * The causes a suspect state may keep a packet for (`carried`): a packet still unconfirmed when the binding became suspect —
 * a pending packet under a rewind, an unknown command or an unconfirmed clear, and an unknown Turn's packet (D6). legacy and
 * marker_absent never arise from a pending binding (ADR-055 implementation notes, the approval agent's decisions of 2026-11-09).
 */
export const CARRIED_CAUSES = ["rewind", "unknown_command", "clear_unconfirmed", "unknown_turn"] as const satisfies readonly SuspectCause[];
/**
 * A sync state a pending sync can return to. Neither the prior nested in `carried` nor a pending sync's prior carries a
 * packet itself: a packet is built only on a state that carries none (a suspect binding moves back first, retreatedPrior).
 */
export type SyncPrior =
  | { readonly kind: "fresh"; readonly basis: typeof FRESH_BASES[number] }
  | { readonly kind: "synced"; readonly mark: DeliveredMark }
  | { readonly kind: "suspect"; readonly mark: DeliveredMark | null; readonly cause: SuspectCause; readonly floorCandidate: number | null;
      /**
       * Only with a cause of CARRIED_CAUSES: the packet `packetId` that was pending when the binding became suspect, the prior it
       * was built on, and the pending sync's one-time attach, which a return to pending gives back (VF1-07; kept since the
       * review of 2026-11-10).
       */
      readonly carried: { readonly prior: SyncPrior; readonly packetId: RelayPacketId; readonly range: SourceRange; readonly attachOverride: boolean } | null;
      /**
       * True only with cause clear_unconfirmed: this unconfirmed clear met a rewind-like suspicion (rewind, unknown_command,
       * marker_absent) not yet checked, in either order, so a marker missing from the chain cannot be put down to the clear
       * (the clear check's rule 4 does not apply). False otherwise (the approval agent's decision of 2026-11-10).
       */
      readonly rewound: boolean };
export const SYNC_KINDS = ["fresh", "synced", "pending", "suspect"] as const;
export type BindingSync =
  | SyncPrior
  | { readonly kind: "pending"; readonly prior: SyncPrior; readonly packetId: RelayPacketId; readonly range: SourceRange; readonly autoResends: 0 | 1; readonly manualResends: number; readonly attachOverride: boolean };
/** A native binding's relay state (Session v13: NativeSessionBinding.relay). Serialized ≤ MAX_BINDING_RELAY_BYTES. */
export interface BindingRelayState {
  readonly nativeEpoch: number;
  readonly sync: BindingSync;
  readonly originIncluded: boolean;
  readonly reanchor: boolean;
  readonly packetsInEpoch: number;
  /** The clear floor: −1 for none; inherited along the binding lineage; need starts above max(mark, epochFloor). */
  readonly epochFloor: number;
  readonly compactionSeen: { readonly count: number; readonly digest: Fingerprint | null };
  readonly consentKey: VendorKey | null;
  readonly vendorObserved: VendorObservation | null;
  readonly cache: { readonly lastRequestStartedAt: number | null; readonly contextUsed: number | null; readonly contextSize: number | null };
}

export const BLOCKED_CODES = ["RELAY_INPUT_LIMIT", "NATIVE_STATE_UNCONFIRMED", "RELAY_CONSENT_REQUIRED", "RELAY_CHOICE_REQUIRED", "RELAY_TARGET_UNVERIFIED", "RELAY_UNAVAILABLE"] as const;
export const CONTINUITY_KINDS = ["native_resume", "native_resume_delta", "rehydrate", "native_fork", "native_import", "native_cleared", "blocked"] as const;
/** How a Turn continued its context (relay-architecture §12.2): an object since v13; v12 events wrote a string. */
export type ContinuityLevel =
  | { readonly kind: "native_resume" }
  | { readonly kind: "native_resume_delta"; readonly tier: Tier; readonly runs: number }
  | { readonly kind: "rehydrate"; readonly tier: Tier; readonly complete: boolean }
  | { readonly kind: "native_fork" } | { readonly kind: "native_import" }
  | { readonly kind: "native_cleared" }
  | { readonly kind: "blocked"; readonly code: typeof BLOCKED_CODES[number] };
/**
 * The strings v12 events wrote for continuity, and the level each reads as. A v12 rehydration is read as an incomplete
 * standard one: no v12 event says what was folded (relay-architecture §14.4, read conservatively).
 */
export const LEGACY_CONTINUITY: Readonly<Record<string, ContinuityLevel>> = {
  public_context_rehydrate: { kind: "rehydrate", tier: "standard", complete: false },
  native_resume: { kind: "native_resume" },
  native_fork: { kind: "native_fork" },
  native_import: { kind: "native_import" },
};
/** PublicRun.relay (v13). Serialized with relayRequest ≤ MAX_RUN_RELAY_BYTES; immutable once the Run is running. */
export interface RunRelay { readonly packetId: RelayPacketId | null; readonly kind: RelayPacketKind | null; readonly continuity: ContinuityLevel; readonly executedOn: ExecutedOn | null }
export const ATTACH_CHOICES = ["auto", "full", "none"] as const;
export const NATIVE_CHOICES = ["continue", "new"] as const;
/** PublicRun.relayRequest (v13): the request's relay choices and an HMAC of all of them; notes and reveals live in relay rows. */
export interface RunRelayRequest { readonly tier?: Tier; readonly attach?: typeof ATTACH_CHOICES[number]; readonly native?: typeof NATIVE_CHOICES[number]; readonly resend?: true; readonly fingerprint: HmacDigest }
/** A request's relay options (they enter the command fingerprint, RT2-19). */
export interface RelayRequest {
  readonly tier?: Tier; readonly attach?: typeof ATTACH_CHOICES[number]; readonly native?: typeof NATIVE_CHOICES[number]; readonly resend?: true;
  readonly excludeRuns?: readonly number[]; readonly excludeSections?: readonly SectionId[]; readonly note?: string;
  readonly reveal?: readonly { readonly runId: RunId; readonly ref: string; readonly offset: number; readonly length: number; readonly tag: RedactionTag }[];
  readonly consent?: { readonly vendor: VendorKey; readonly decision: "acknowledged" | "goal_only"; readonly scope: "session" | "global" };
  /**
   * The user's ［确认已清空］ on a binding whose clear is unconfirmed (relay-architecture §9, the approval agent's decision of
   * 2026-11-10): the clear is taken as confirmed (event e at its floor candidate). Only the user's own choice in the chat sets it.
   */
  readonly clearConfirmed?: true;
}
export const SWITCH_MODES = ["wait_current", "cancel_current"] as const;
export type SwitchMode = typeof SWITCH_MODES[number];
/** When a switch was requested, validated and became effective (epoch milliseconds, the Runtime's clock). */
export interface SwitchTiming { readonly requestedAt: number; readonly validatedAt?: number; readonly effectiveAt?: number }

export const CONSENT_DECISIONS = ["acknowledged", "goal_only", "revoked"] as const;
/** One consent decision for a vendor key; append-only, the latest row per (vendor, scope) decides (relay-architecture §10.4). */
export interface ConsentRecord {
  readonly logSeq: number;
  readonly commandId: string;
  readonly vendor: VendorKey;
  readonly scope: { readonly kind: "global" } | { readonly kind: "session"; readonly sessionId: SessionId };
  readonly decision: typeof CONSENT_DECISIONS[number];
  readonly categories: readonly DataClass[];
  readonly policyVersion: PolicyVersion;
  readonly authKind: string | null;
  readonly decidedAt: number;
}
export const FILE_CHANGES = ["modified", "added", "deleted", "renamed", "untracked"] as const;
export const OBSERVATION_STATUSES = ["complete", "partial"] as const;
export const WORKSPACE_UNAVAILABLE_REASONS = ["timeout", "error", "no_workspace", "lease_not_held", "gitdir_outside", "root_is_home", "root_is_fs", "data_root_inside"] as const;
/** A workspace observation kept with a packet, ≤ RELAY_WORKSPACE_FILES entries and ≤ RELAY_WORKSPACE_BYTES of files (RT3 P04). */
export type WorkspaceObservation =
  | { readonly kind: "git"; readonly status: typeof OBSERVATION_STATUSES[number]; readonly branch: string | null; readonly head: string | null; readonly fingerprint: Fingerprint; readonly durationMs: number;
      readonly files: readonly { readonly path: string; readonly change: typeof FILE_CHANGES[number]; readonly added: number | null; readonly removed: number | null; readonly credentialPath: boolean; readonly lfs: boolean }[];
      readonly counted: { readonly total: number; readonly listed: number }; readonly neutralized: readonly string[]; readonly attributesIncluded: boolean }
  | { readonly kind: "tree"; readonly status: typeof OBSERVATION_STATUSES[number]; readonly fingerprint: Fingerprint; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly size: number; readonly mtimeMs: number }[]; readonly scanned: number; readonly counted: number }
  | { readonly kind: "unavailable"; readonly reason: typeof WORKSPACE_UNAVAILABLE_REASONS[number] };
export const RELAY_PREF_KEYS = ["relay.crossVendor", "relay.returnPreference", "relay.allowUnprobed", "relay.localModelsOffline", "relay.whenUnsure", "relay.dataRootInWorkspace"] as const;
export type RelayPrefKey = typeof RELAY_PREF_KEYS[number];
/** The values each installation preference takes (public-api.md, relay-architecture §3.1, §7.3, §10.4, permissive-defaults §4). */
export const RELAY_PREF_VALUES: Readonly<Record<RelayPrefKey, readonly string[]>> = {
  "relay.crossVendor": ["ask", "allow", "goal_only"],
  "relay.returnPreference": ["continue", "new_when_cold", "ask"],
  "relay.allowUnprobed": ["true", "false"],
  "relay.localModelsOffline": ["true", "false"],
  "relay.whenUnsure": ["auto", "ask"],
  "relay.dataRootInWorkspace": ["warn", "block"],
};
/**
 * What each preference is while none is stored (the owner's decision of 2026-11-10: relay is permissive by default, the strict
 * behaviors are settings): a handoff to another vendor is allowed and logged, an unprobed Driver takes history, what the relay
 * is unsure of it settles itself, and a data directory in the workspace is warned about, not refused.
 */
export const RELAY_PREF_DEFAULTS: Readonly<Record<RelayPrefKey, string>> = {
  "relay.crossVendor": "allow",
  "relay.returnPreference": "continue",
  "relay.allowUnprobed": "true",
  "relay.localModelsOffline": "false",
  "relay.whenUnsure": "auto",
  "relay.dataRootInWorkspace": "warn",
};
/** The four preferences that turn every strict behavior of the design back on (the relay before the permissive defaults; permissive-defaults P9). */
export const RELAY_STRICT_PREFS: Readonly<Partial<Record<RelayPrefKey, string>>> = {
  "relay.crossVendor": "ask",
  "relay.allowUnprobed": "false",
  "relay.whenUnsure": "ask",
  "relay.dataRootInWorkspace": "block",
};

// ---------------------------------------------------------------------------------------------------------------------
// What the relay decided for a Turn, and what a binding asks the user to look at (permissive-defaults §2.6)
// ---------------------------------------------------------------------------------------------------------------------

export const DECISION_KINDS = ["carry", "alone", "plain"] as const;
/** Who decided: the need alone (an ordinary packet), the policy (an automatic resend, a send alone, a complete packet again), or the user's own choice. */
export const DECISION_BY = ["need", "policy", "user"] as const;
/**
 * The situation a decision of the policy answered (the 409 causes of the strict mode and the failures that no longer stop a Turn):
 * the delivery of a packet is unconfirmed, a suspect binding could not be checked, the marker is gone, the smallest packet does
 * not fit, the relay's record could not be recovered, the vendor's consent was withdrawn (or is for the goal only, which the
 * MVP cannot render), a packet could not be prepared, or the reading of the input changed after the open.
 */
export const DECISION_CAUSES = ["delivery_unconfirmed", "verify_required", "marker_absent", "input_limit", "recovery_failed", "consent_revoked", "consent_goal_only", "prepare_failed", "classification_changed"] as const;
/**
 * `run.context_prepared.data.relay.decision`: what the relay did with a content Turn's history. `reason` names the failure of a
 * `prepare_failed` (a RELAY_PREPARE_REASONS or RELAY_UNAVAILABLE_REASONS value). An ordinary Turn that owes nothing records none.
 */
export interface RelayDecision {
  readonly kind: typeof DECISION_KINDS[number];
  readonly by: typeof DECISION_BY[number];
  readonly cause?: typeof DECISION_CAUSES[number];
  readonly reason?: string;
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
  return { kind: row.kind as RelayDecision["kind"], by: row.by as RelayDecision["by"], ...(cause === undefined ? {} : { cause }), ...(typeof row.reason === "string" ? { reason: row.reason.slice(0, 64) } : {}) };
}
export const ATTENTION_CAUSES = ["delivery_unconfirmed", "verify_required", "marker_absent", "clear_unconfirmed", "recovery_failed", "input_limit", "consent_revoked", "consent_goal_only"] as const;
/**
 * The user's ways out, as the buttons of a banner (the options of the 409's error body, relay-architecture §12.4, stage3-workstreams §3).
 * `send_alone` is the 409's own option: under the defaults sending alone is what the next input does without being asked, so a banner
 * never lists it.
 */
export const ATTENTION_OPTIONS = ["attach_full", "send_alone", "new_native", "clear_confirmed", "acknowledge"] as const;
/**
 * What a binding asks the user to look at (`GET …/relay`, per binding): why, the options that answer it (never a block: the next
 * input goes anyway), how much is at stake (`runs` of the conversation's Turns it still owes, `packets` sent and not confirmed),
 * and `key`, which names one episode (the same cause within one wait for a check shows once, and a closed banner does not come back).
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

export const RELAY_PREPARE_REASONS = ["render", "render_mismatch", "redaction_failed", "storage", "storage_quota", "target_start", "classification_changed"] as const;
export const RELAY_UNAVAILABLE_REASONS = ["data_root_in_workspace", "consent_log_full", "recovery_failed"] as const;
/** Why the next content input needs the user's choice (relay-architecture §9 "需要用户选择"), the cause of RELAY_CHOICE_REQUIRED. */
export const RELAY_CHOICE_CAUSES = ["delivery_unconfirmed", "verify_required", "marker_absent"] as const;
/**
 * Why the target takes no relay content (D11, G072): `unprobed`, its Driver declares relay mechanisms its probes have not
 * proved on the latest release (and `relay.allowUnprobed` is off, which is the strict design; the default is on); `undeclared`, its
 * Driver declares none (WorkBuddy, Pi, Cursor, a control the Gateway cannot place), which the same preference opens in the default.
 */
export const RELAY_TARGET_REASONS = ["unprobed", "undeclared"] as const;
/** Why the target's vendor needs the user's consent (§10.4): none recorded (or withdrawn), the vendor changed in this epoch, or withdrawn since the Turn was prepared. */
export const RELAY_CONSENT_REASONS = ["missing", "vendor_changed", "revoked"] as const;
/**
 * Why the smallest packet does not fit (§6.2, G072): `min_packet`, the target's window (conservative at admission, refined at
 * the open) leaves less than MIN_PACKET of its family; `input_limit`, the placed Turn exceeds the Driver's input bound.
 */
export const RELAY_LIMIT_REASONS = ["min_packet", "input_limit"] as const;
export type RelayErrorReason =
  | { readonly code: "RELAY_PREPARE_FAILED"; readonly reason: typeof RELAY_PREPARE_REASONS[number] }
  | { readonly code: "RELAY_UNAVAILABLE"; readonly reason: typeof RELAY_UNAVAILABLE_REASONS[number] }
  | { readonly code: "RELAY_CHOICE_REQUIRED"; readonly reason: typeof RELAY_CHOICE_CAUSES[number] }
  | { readonly code: "RELAY_TARGET_UNVERIFIED"; readonly reason: typeof RELAY_TARGET_REASONS[number] }
  | { readonly code: "RELAY_CONSENT_REQUIRED"; readonly reason: typeof RELAY_CONSENT_REASONS[number] }
  | { readonly code: "RELAY_INPUT_LIMIT"; readonly reason: typeof RELAY_LIMIT_REASONS[number] };
/**
 * What a relay error tells the page besides its code and reason (G073 turns it into the error body's `relay` member, §12.4):
 * the vendor key a consent is asked for and the one consented to before, the Harness control it concerns. Plain values, never
 * a secret, a path or the history's text.
 */
export interface RelayErrorDetail {
  readonly vendor?: VendorKey;
  readonly previousVendor?: VendorKey;
  readonly harnessId?: string;
  readonly controlId?: string;
}
/**
 * An expected relay failure (INV-35): it fails one Run or one consent command and nothing else. The Store throws it before
 * any statement of the failing write runs, so it never disables the Store; `reason` is the code's closed reason.
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
  | { readonly kind: "outcome"; readonly runId: RunId; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }>; readonly verifyMs?: number };
export interface RelayPin { readonly pinId: PinId; readonly messageId: MessageId; readonly author: "user" | "assistant"; readonly offset: number; readonly length: number; readonly quoteHmac: HmacDigest; readonly pinnedSeq: number }
export type RelayPinWrite = { readonly kind: "add"; readonly pin: RelayPin } | { readonly kind: "withdraw"; readonly pinId: PinId; readonly withdrawnSeq: number };
export interface RelayExclusion { readonly exclusionId: ExclusionId; readonly kind: "run" | "section"; readonly ref: string; readonly addedSeq: number }
export type RelayExclusionWrite = { readonly kind: "add"; readonly exclusion: RelayExclusion } | { readonly kind: "withdraw"; readonly exclusionId: ExclusionId; readonly withdrawnSeq: number };
/** A Run's digest row: index and digest are plain JSON objects; a row of a newer policy replaces the Run's older ones. */
export interface RelayDigestWrite {
  readonly runId: RunId; readonly runIndex: number; readonly policyVersion: PolicyVersion; readonly status: typeof DIGEST_STATUSES[number];
  readonly secretSetHmac: RedactionTag | ""; readonly index: Readonly<Record<string, unknown>>; readonly digest: Readonly<Record<string, unknown>>;
}
export interface RelayWorkspaceWrite { readonly observedSeq: number; readonly runId: RunId; readonly observation: WorkspaceObservation }
/** Rows derived from committed facts (digests, observations): written in a SAVEPOINT, and a failure only leaves them behind. */
export interface RelayDerivedRows { readonly digests?: readonly RelayDigestWrite[]; readonly workspace?: readonly RelayWorkspaceWrite[] }
/**
 * What a Session transaction writes besides its snapshot and events (SessionMutation.relay). Authoritative rows (packets,
 * deliveries, pins, exclusions) are checked in full before any statement runs: an expected failure is a RelayError for
 * the Run (RELAY_PREPARE_FAILED) and the transaction writes nothing. `derived` is called inside a SAVEPOINT, so a failure of
 * its own (a scanner error, a bound, a statement) rolls back only those rows and the commit says so.
 */
export interface RelayRows {
  readonly packets?: readonly RelayPacketWrite[];
  readonly deliveries?: readonly RelayDeliveryWrite[];
  readonly pins?: readonly RelayPinWrite[];
  readonly exclusions?: readonly RelayExclusionWrite[];
  readonly derived?: () => RelayDerivedRows;
}
/** How a transaction's derived rows went: none given, written, or left behind (rolled back to their SAVEPOINT). */
export interface RelayCommitResult { readonly derived: "none" | "written" | "behind"; readonly diagnostic?: string }
/** Rows the Store writes outside snapshots without moving the Session version (relay-architecture §3.2, F07). */
export interface RelayWriteRows { readonly digests?: readonly RelayDigestWrite[]; readonly realized?: readonly { readonly runId: RunId; readonly realized: RealizedWindow }[] }
export type RelayWriteResult = { readonly written: true } | { readonly written: false; readonly diagnostic: string };
/** An observed context window of one Harness control and model (installation level, last writer wins). */
export interface RelayWindow { readonly harnessId: string; readonly controlId: string; readonly modelKey: string; readonly size: number; readonly firstTurnUsed: number | null; readonly observedAt: number }
/** A consent decision to append; the log assigns its seq. */
export type ConsentAppend = Omit<ConsentRecord, "logSeq">;
/** The command identity every default-allow row of the log starts with: the source of a row is `default` when it does, `user` otherwise. */
export const DEFAULT_ALLOW_PREFIX = "default-allow:";
/**
 * The command identity of the row a vendor's first use writes while `relay.crossVendor` allows it by default (permissive-defaults
 * §2.4): `default-allow:<vendor key>:<policy>` (`relay/1` spelled `relay-1`), the same for every first use of that vendor under that policy, so a repeat is the
 * same command. A key too long (a gateway host may take 253 bytes) or not spelled for a command identity is named by a 64-bit
 * FNV-1a digest of its text instead: an identity for an idempotent row, not a secret and not a proof of anything.
 */
export function defaultAllowCommand(vendor: VendorKey, policy: PolicyVersion): string {
  // A command identity has no "/": the policy `relay/1` is spelled `relay-1` in it.
  const spelled = policy.replace("/", "-"), readable = DEFAULT_ALLOW_PREFIX + vendor + ":" + spelled;
  if (utf8(readable) <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(readable)) return readable;
  let digest = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(vendor)) digest = BigInt.asUintN(64, (digest ^ BigInt(byte)) * 0x100000001b3n);
  return DEFAULT_ALLOW_PREFIX + "fnv-" + digest.toString(16).padStart(16, "0") + ":" + spelled;
}
/** Where a row of the consent log came from: the user's own decision, or the default that allowed a vendor's first use. */
export function consentSourceOf(record: Pick<ConsentRecord, "commandId">): "default" | "user" {
  return record.commandId.startsWith(DEFAULT_ALLOW_PREFIX) ? "default" : "user";
}
/** One Run's delivery changed by recovery. */
export interface RelayRecoveredDelivery { readonly runId: RunId; readonly outcome: Exclude<DeliveryOutcome, { readonly kind: "in_flight" }> }
/** What recovery changes of a Session's relay state besides recoverSession's own changes. */
export interface RelayRecovery { readonly next: SessionSnapshot; readonly deliveries: readonly RelayRecoveredDelivery[] }
/**
 * The relay part of recovery (relay-architecture §9, S15): given a Session as recoverSession left it and its delivery rows,
 * the Session with its bindings' relay state recovered and the deliveries to decide; null when nothing changes. Pure and
 * synchronous; the Store calls it in claimAndRecover's transaction, inside a SAVEPOINT of the Session's own. G068 provides it.
 * `packets` are the Session's packet manifests (a resend never dispatched goes back to waiting for the packet it superseded,
 * whose range its manifest holds; G068 fix batch R9g); a caller without them passes none.
 */
export type RecoverRelay = (state: SessionSnapshot, deliveries: readonly DeliveryRecord[], packets?: readonly RelayPacket[]) => RelayRecovery | null;
/** The Session Store's relay writes and reads beyond SessionStore (relay-architecture §3.2). */
export interface RelayStorePort {
  /**
   * Writes derived rows (rebuilt digests, settled realized counts) in a transaction of their own without moving the
   * Session's version, so a concurrent transact neither conflicts with it nor loses its own rows. A row it would replace that
   * a transaction wrote as current, and realized counts already settled, are kept. A failure of its statements rolls it back
   * and is returned as a diagnostic (also kept in relayDiagnostics) instead of disabling the Store; invalid rows throw.
   */
  relayWrite(id: SessionId, rows: RelayWriteRows): RelayWriteResult;
  /** Deletes a closed Session that keeps no process, with its events, create key and every relay row, in one transaction. */
  deleteSession(id: SessionId): void;
  /** The Session's delivery rows in Run order. */
  relayDeliveries(id: SessionId): readonly DeliveryRecord[];
  /** The manifests of the packets the Session keeps (G068 phase two: the range, text digest and epoch a check reads). */
  relayPackets(id: SessionId): readonly RelayPacket[];
  /** The Session's digest index rows (every policy version), as plain objects; the migration's are RelayBehindIndex. */
  relayIndex(id: SessionId): readonly RelayIndexRow[];
}
/** One row of relay_digests' narrow index (relay-architecture §14.1): which Run, under which policy, and its index object. */
export interface RelayIndexRow { readonly runId: RunId; readonly policyVersion: PolicyVersion; readonly status: typeof DIGEST_STATUSES[number]; readonly index: Readonly<Record<string, unknown>> }
/** The installation's relay log, windows and preferences (relay-architecture §3.1, §14.1). */
export interface RelayLogPort {
  /**
   * Appends one consent decision in a transaction of its own and returns it with its seq; the same command again returns the
   * first record, a different one under the same command id is IDEMPOTENCY_CONFLICT. At RELAY_LOG_ROWS rows the log is first
   * rotated in the same transaction (the latest row of each vendor, scope and Session stays); RelayError RELAY_UNAVAILABLE
   * (consent_log_full) when it would still be full or its archive would pass RELAY_LOG_ARCHIVE_ROWS.
   */
  appendRelayLog(record: ConsentAppend): ConsentRecord;
  /** Keeps the latest observed window of one Harness control and model; the last writer wins. */
  upsertWindow(window: RelayWindow): void;
  /** The window last observed for one Harness control and model key (G072, the window's second source, §6.2); null when none is kept. */
  relayWindow(harnessId: string, controlId: string, modelKey: string): RelayWindow | null;
  /** Sets one installation preference to one of its values; the last writer wins. */
  setPref(key: RelayPrefKey, value: string): void;
  relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>>;
  /** The current consent view: the latest record of each vendor and scope. */
  relayConsents(): readonly ConsentRecord[];
}

/**
 * The installation's relay key as the relay uses it (ADR-055 §10.2, D5, INV-29; G072's relay-keys): HMACs under a subkey
 * derived per Session (HMAC(installation key, "relay-tag/1" ‖ sessionId)), so one value keys differently in every Session and
 * nothing in a relay row can be checked against a guessed value without the key. The key itself is never exported. `keyId`
 * names the key in the rows; it is never EPHEMERAL_KEY_ID (A17). Each method may throw a RelayError (RELAY_PREPARE_FAILED,
 * redaction_failed) when the key cannot be used; nothing is then written with a digest of another key.
 */
export interface RelayKeyPort {
  readonly keyId: string;
  /** HMAC-SHA256 of the current input (a delivery row's inputHmac). */
  inputHmac(session: SessionId, text: string): HmacDigest;
  /** The first 8 hex of the HMAC of a known-secret set (a delivery row's redaction.setHmac): the same set, whatever its order, tags alike. */
  setTag(session: SessionId, secrets: readonly string[]): RedactionTag;
  /** HMAC-SHA256 of a request's relay options as canonical JSON (PublicRun.relayRequest.fingerprint, RT2-19). */
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
/** A host name or address literal as a gateway key holds it: lower case, ≤ MAX_HOST_BYTES. */
function host(value: unknown, label: string): string {
  const text = bounded(value, label, MAX_HOST_BYTES);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])$/u.test(text)) invalid(label);
  return text;
}
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
export function parseDeliveredMark(value: unknown): DeliveredMark {
  const item = object(value, "delivered mark"); only(item, ["throughSeq", "chain", "lastPacketId", "evidence", "basis"], "delivered mark");
  return { throughSeq: seq(item.throughSeq, "mark throughSeq"), chain: fingerprint(item.chain), lastPacketId: nullable(item.lastPacketId, relayPacketId),
    evidence: choice(item.evidence, EVIDENCE_CLASSES, "mark evidence"), basis: choice(item.basis, MARK_BASES, "mark basis") };
}
/** A sync prior; `nested` is the prior inside a suspect's `carried`, which carries nothing itself. */
function syncPrior(value: unknown, nested: boolean): SyncPrior {
  const item = object(value, "sync state");
  switch (item.kind) {
    case "fresh": only(item, ["kind", "basis"], "fresh sync"); return { kind: "fresh", basis: choice(item.basis, FRESH_BASES, "fresh basis") };
    case "synced": only(item, ["kind", "mark"], "synced sync"); return { kind: "synced", mark: parseDeliveredMark(item.mark) };
    case "suspect": {
      only(item, ["kind", "mark", "cause", "floorCandidate", "carried", "rewound"], "suspect sync");
      const cause = choice(item.cause, SUSPECT_CAUSES, "suspect cause");
      const carried = nullable(item.carried, raw => {
        if (nested) throw new SessionError("INVALID_DATA", "a nested prior carries no packet");
        const row = object(raw, "carried packet"); only(row, ["prior", "packetId", "range", "attachOverride"], "carried packet");
        return { prior: syncPrior(row.prior, true), packetId: relayPacketId(row.packetId), range: parseSourceRange(row.range), attachOverride: flag(row.attachOverride, "carried attach override") };
      });
      if (carried !== null && !(CARRIED_CAUSES as readonly string[]).includes(cause)) throw new SessionError("INVALID_DATA", "a suspect state of this cause carries no packet");
      const rewound = flag(item.rewound, "suspect rewound");
      if (rewound && cause !== "clear_unconfirmed") throw new SessionError("INVALID_DATA", "only an unconfirmed clear is marked rewound");
      return { kind: "suspect", mark: nullable(item.mark, parseDeliveredMark), cause, floorCandidate: nullable(item.floorCandidate, raw => integer(raw, "floor candidate", 1, RELAY_MAX_SEQ)), carried, rewound };
    }
  }
  throw new SessionError("INVALID_DATA", "unknown sync state kind");
}
export function parseBindingSync(value: unknown): BindingSync {
  const item = object(value, "binding sync");
  if (item.kind !== "pending") return syncPrior(item, false);
  only(item, ["kind", "prior", "packetId", "range", "autoResends", "manualResends", "attachOverride"], "pending sync");
  const autoResends = integer(item.autoResends, "automatic resends", 0, 1) as 0 | 1;
  // A pending sync's prior carries no packet: a packet is built on a state that carries none.
  return { kind: "pending", prior: syncPrior(item.prior, true), packetId: relayPacketId(item.packetId), range: parseSourceRange(item.range), autoResends,
    manualResends: integer(item.manualResends, "manual resends", 0, RELAY_MAX_RUNS), attachOverride: flag(item.attachOverride, "attach override") };
}
/** NativeSessionBinding.relay (v13), checked field by field and then against MAX_BINDING_RELAY_BYTES. */
export function parseBindingRelayState(value: unknown): BindingRelayState {
  const item = object(value, "binding relay state");
  only(item, ["nativeEpoch", "sync", "originIncluded", "reanchor", "packetsInEpoch", "epochFloor", "compactionSeen", "consentKey", "vendorObserved", "cache"], "binding relay state");
  const compaction = object(item.compactionSeen, "compaction cursor"); only(compaction, ["count", "digest"], "compaction cursor");
  const cache = object(item.cache, "relay cache"); only(cache, ["lastRequestStartedAt", "contextUsed", "contextSize"], "relay cache");
  const state: BindingRelayState = { nativeEpoch: integer(item.nativeEpoch, "native epoch", 1, RELAY_MAX_EPOCH), sync: parseBindingSync(item.sync),
    originIncluded: flag(item.originIncluded, "origin included"), reanchor: flag(item.reanchor, "reanchor"), packetsInEpoch: integer(item.packetsInEpoch, "packets in epoch", 0, RELAY_MAX_RUNS),
    epochFloor: integer(item.epochFloor, "clear floor", -1, RELAY_MAX_SEQ),
    compactionSeen: { count: counter(compaction.count, "compaction count"), digest: nullable(compaction.digest, fingerprint) },
    consentKey: nullable(item.consentKey, parseVendorKey), vendorObserved: nullable(item.vendorObserved, parseVendorObservation),
    cache: { lastRequestStartedAt: nullable(cache.lastRequestStartedAt, raw => time(raw, "last request start")), contextUsed: nullable(cache.contextUsed, raw => counter(raw, "context used")),
      contextSize: nullable(cache.contextSize, raw => integer(raw, "context size", 1, MAX_RELAY_COUNTER)) } };
  if (utf8(JSON.stringify(state)) > MAX_BINDING_RELAY_BYTES) throw new SessionError("INVALID_DATA", "binding relay state exceeds its byte budget");
  return state;
}
/** The mark a sync state stands on: a synced or suspect mark, or a pending sync's prior's; none for fresh. */
export function markOf(sync: BindingSync): DeliveredMark | null {
  switch (sync.kind) {
    case "fresh": return null;
    case "synced": return sync.mark;
    case "suspect": return sync.mark;
    case "pending": return markOf(sync.prior);
  }
}
/** Every packet identity a sync state names, for the Store's check that they exist (relay-architecture §14.3). */
export function packetsOf(sync: BindingSync): readonly RelayPacketId[] {
  const ids: RelayPacketId[] = [];
  const visit = (state: BindingSync): void => {
    switch (state.kind) {
      case "fresh": return;
      case "synced": if (state.mark.lastPacketId !== null) ids.push(state.mark.lastPacketId); return;
      case "suspect":
        if (state.mark?.lastPacketId != null) ids.push(state.mark.lastPacketId);
        if (state.carried !== null) { ids.push(state.carried.packetId); visit(state.carried.prior); }
        return;
      case "pending": ids.push(state.packetId); visit(state.prior); return;
    }
  };
  visit(sync);
  return [...new Set(ids)];
}
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
  const item = object(value, "Run relay request"); only(item, ["tier", "attach", "native", "resend", "fingerprint"], "Run relay request");
  if (item.resend !== undefined && item.resend !== true) invalid("relay resend choice");
  return { ...(item.tier === undefined ? {} : { tier: choice(item.tier, TIERS, "requested tier") }), ...(item.attach === undefined ? {} : { attach: choice(item.attach, ATTACH_CHOICES, "requested attach") }),
    ...(item.native === undefined ? {} : { native: choice(item.native, NATIVE_CHOICES, "requested native session") }), ...(item.resend === undefined ? {} : { resend: true as const }),
    fingerprint: hmacDigest(item.fingerprint) };
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
    case "recorded": only(item, ["kind", "evidence", "decidedSeq", "decidedAt", "verifiedInRun"], "delivery outcome");
      return { kind: "recorded", evidence: choice(item.evidence, DELIVERY_EVIDENCE, "delivery evidence"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at"), verifiedInRun: nullable(item.verifiedInRun, runId) };
    case "not_recorded": only(item, ["kind", "reason", "decidedSeq", "decidedAt"], "delivery outcome");
      return { kind: "not_recorded", reason: choice(item.reason, NOT_RECORDED_REASONS, "not recorded reason"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at") };
    case "unknown": only(item, ["kind", "reason", "decidedSeq", "decidedAt"], "delivery outcome");
      return { kind: "unknown", reason: choice(item.reason, UNKNOWN_REASONS, "unknown reason"), decidedSeq: integer(item.decidedSeq, "decided seq", 1, RELAY_MAX_SEQ), decidedAt: time(item.decidedAt, "decided at") };
  }
  return invalid("delivery outcome");
}
export function parseDeliveryPosition(value: unknown): DeliveryPosition {
  const item = object(value, "delivery position");
  let position: DeliveryPosition;
  switch (item.kind) {
    case "file_offset": only(item, ["kind", "path", "bytes"], "delivery position"); position = { kind: "file_offset", path: bounded(item.path, "position path", RELAY_POSITION_BYTES - 64), bytes: integer(item.bytes, "position bytes", 0, Number.MAX_SAFE_INTEGER) }; break;
    case "seq": only(item, ["kind", "before"], "delivery position"); position = { kind: "seq", before: integer(item.before, "position seq", 0, Number.MAX_SAFE_INTEGER) }; break;
    case "client_id": only(item, ["kind", "id"], "delivery position"); position = { kind: "client_id", id: bounded(item.id, "position client id", 512) }; break;
    case "none": only(item, ["kind"], "delivery position"); position = { kind: "none" }; break;
    default: return invalid("delivery position");
  }
  if (utf8(JSON.stringify(position)) > RELAY_POSITION_BYTES) throw new SessionError("INVALID_DATA", "delivery position exceeds its byte budget");
  return position;
}
const cursor = (value: unknown, label: string) => { const row = object(value, label); only(row, ["count", "digest"], label); return { count: counter(row.count, label + " count"), digest: nullable(row.digest, fingerprint) }; };
export function parseRealizedWindow(value: unknown): RealizedWindow {
  const item = object(value, "realized window"); only(item, ["requests", "cacheHits", "closedBy"], "realized window");
  return { requests: counter(item.requests, "realized requests"), cacheHits: counter(item.cacheHits, "realized cache hits"), closedBy: choice(item.closedBy, REALIZED_CLOSED_BY, "realized close") };
}
export function parseDeliveryRecord(value: unknown): DeliveryRecord {
  const item = object(value, "delivery record");
  only(item, ["runId", "packetId", "channel", "position", "outcome", "consentLogSeq", "inputHmac", "redaction", "compactionAtDelivery", "resendOf", "attachOverride", "verifyMs", "realized"], "delivery record");
  const redaction = object(item.redaction, "delivery redaction context"); only(redaction, ["rulesVersion", "keyId", "setHmac"], "delivery redaction context");
  return { runId: runId(item.runId), packetId: relayPacketId(item.packetId), channel: choice(item.channel, DELIVERY_CHANNELS, "delivery channel"), position: parseDeliveryPosition(item.position),
    outcome: parseDeliveryOutcome(item.outcome), consentLogSeq: nullable(item.consentLogSeq, raw => integer(raw, "consent log seq", 1, Number.MAX_SAFE_INTEGER)), inputHmac: hmacDigest(item.inputHmac),
    redaction: { rulesVersion: bounded(redaction.rulesVersion, "redaction rules version", 64), keyId: bounded(redaction.keyId, "redaction key id", 64), setHmac: redactionTag(redaction.setHmac) },
    compactionAtDelivery: nullable(item.compactionAtDelivery, raw => cursor(raw, "compaction at delivery")), resendOf: nullable(item.resendOf, runId), attachOverride: flag(item.attachOverride, "attach override"),
    verifyMs: nullable(item.verifyMs, raw => counter(raw, "verify ms")), realized: nullable(item.realized, parseRealizedWindow) };
}
const ids = (value: unknown, label: string) => list(value, label, RELAY_MAX_RUNS, raw => integer(raw, label, 0, RELAY_MAX_RUNS - 1));
const tokens = (value: unknown, label: string) => counter(value, label);
const runSpan = (value: unknown, label: string): readonly [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) invalid(label);
  const from = integer(value[0], label, 0, RELAY_MAX_RUNS - 1), through = integer(value[1], label, 0, RELAY_MAX_RUNS - 1);
  if (through < from) invalid(label);
  return [from, through];
};
/** A packet manifest as G070 renders it, checked field by field and against RELAY_MANIFEST_BYTES. */
export function parseRelayPacket(value: unknown): RelayPacket {
  const item = object(value, "relay packet");
  only(item, ["id", "kind", "tier", "complete", "reanchor", "target", "source", "range", "basePacketId", "supersedes", "policyVersion", "language", "factsFingerprint", "workspaceObservationSeq", "inputs", "redaction", "body", "budget", "sections", "fold", "omissions", "userEdits"], "relay packet");
  const target = object(item.target, "packet target"); only(target, ["harnessId", "controlId", "model", "vendor", "nativeEpoch"], "packet target");
  const source = object(item.source, "packet source"); only(source, ["kind", "names"], "packet source");
  const inputs = object(item.inputs, "packet inputs"); only(inputs, ["attachOverride", "digestBehind", "detailsMissing", "noteIncluded", "firstLineOmitted"], "packet inputs");
  const redaction = object(item.redaction, "packet redaction"); only(redaction, ["profile", "count", "byClass", "overridden", "unscanned"], "packet redaction");
  const body = object(item.body, "packet body"); only(body, ["sha256", "bytes", "estTokens", "estimator", "family", "untrustedTokens", "userTokens"], "packet body");
  const budget = object(item.budget, "packet budget"); only(budget, ["capTokens", "userCap", "untrustedCap", "window", "fixedPrefix", "windowSource", "clampedBy"], "packet budget");
  const byClass = object(redaction.byClass, "packet redaction classes");
  if (redaction.profile !== "egress" || body.estimator !== "est/2") invalid("packet redaction profile or estimator");
  const packet: RelayPacket = {
    id: relayPacketId(item.id), kind: choice(item.kind, PACKET_KINDS, "packet kind"), tier: choice(item.tier, TIERS, "packet tier"), complete: flag(item.complete, "packet completeness"), reanchor: flag(item.reanchor, "packet reanchor"),
    target: { harnessId: catalogIdentity(target.harnessId, "packet target Harness"), controlId: catalogIdentity(target.controlId, "packet target control"), model: nullable(target.model, raw => bounded(raw, "packet target model", 1024)),
      vendor: parseVendorKey(target.vendor), nativeEpoch: integer(target.nativeEpoch, "packet target epoch", 1, RELAY_MAX_EPOCH) },
    source: { kind: choice(source.kind, SOURCE_KINDS, "packet source kind"), names: list(source.names, "packet source names", 64, raw => { const row = object(raw, "packet source name"); only(row, ["harnessId", "model", "runs"], "packet source name");
      return { harnessId: catalogIdentity(row.harnessId, "packet source Harness"), model: nullable(row.model, raw => bounded(raw, "packet source model", 1024)), runs: runSpan(row.runs, "packet source runs") }; }) },
    range: parseSourceRange(item.range), basePacketId: nullable(item.basePacketId, relayPacketId), supersedes: nullable(item.supersedes, relayPacketId),
    policyVersion: policyVersion(item.policyVersion), language: choice(item.language, LANGUAGES, "packet language"), factsFingerprint: fingerprint(item.factsFingerprint),
    workspaceObservationSeq: nullable(item.workspaceObservationSeq, raw => integer(raw, "packet observation seq", 1, RELAY_MAX_SEQ)),
    inputs: { attachOverride: flag(inputs.attachOverride, "packet attach override"), digestBehind: ids(inputs.digestBehind, "packet digests behind"), detailsMissing: ids(inputs.detailsMissing, "packet details missing"),
      noteIncluded: flag(inputs.noteIncluded, "packet note included"), firstLineOmitted: nullable(inputs.firstLineOmitted, raw => choice(raw, FIRST_LINE_OMITTED, "packet first line omission")) },
    redaction: { profile: "egress", count: counter(redaction.count, "packet redactions"), byClass: Object.fromEntries(Object.entries(byClass).map(([key, count]) => [bounded(key, "redaction class", 64), counter(count, "redaction class count")])),
      overridden: counter(redaction.overridden, "packet redactions overridden"), unscanned: counter(redaction.unscanned, "packet unscanned") },
    body: { sha256: fingerprint(body.sha256), bytes: integer(body.bytes, "packet body bytes", 1, RELAY_BODY_BYTES), estTokens: tokens(body.estTokens, "packet tokens"), estimator: "est/2", family: bounded(body.family, "packet model family", 64),
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
export function parseWorkspaceObservation(value: unknown): WorkspaceObservation {
  const item = object(value, "workspace observation");
  switch (item.kind) {
    case "git": {
      only(item, ["kind", "status", "branch", "head", "fingerprint", "durationMs", "files", "counted", "neutralized", "attributesIncluded"], "git observation");
      const counted = object(item.counted, "observation counts"); only(counted, ["total", "listed"], "observation counts");
      return { kind: "git", status: choice(item.status, OBSERVATION_STATUSES, "observation status"), branch: nullable(item.branch, raw => bounded(raw, "observed branch", 256)), head: nullable(item.head, raw => patterned(raw, /^[0-9a-f]{40,64}$/u, "observed head")),
        fingerprint: fingerprint(item.fingerprint), durationMs: counter(item.durationMs, "observation duration"),
        files: list(item.files, "observed files", RELAY_WORKSPACE_FILES, raw => { const row = object(raw, "observed file"); only(row, ["path", "change", "added", "removed", "credentialPath", "lfs"], "observed file");
          return { path: relativePath(row.path, "observed path"), change: choice(row.change, FILE_CHANGES, "observed change"), added: nullable(row.added, raw => counter(raw, "added lines")), removed: nullable(row.removed, raw => counter(raw, "removed lines")),
            credentialPath: flag(row.credentialPath, "credential path"), lfs: flag(row.lfs, "large file") }; }),
        counted: { total: counter(counted.total, "observed total"), listed: counter(counted.listed, "observed listed") }, neutralized: list(item.neutralized, "neutralized drivers", 64, raw => bounded(raw, "neutralized driver", 64)),
        attributesIncluded: flag(item.attributesIncluded, "attributes included") };
    }
    case "tree":
      only(item, ["kind", "status", "fingerprint", "durationMs", "files", "scanned", "counted"], "tree observation");
      return { kind: "tree", status: choice(item.status, OBSERVATION_STATUSES, "observation status"), fingerprint: fingerprint(item.fingerprint), durationMs: counter(item.durationMs, "observation duration"),
        files: list(item.files, "observed files", RELAY_WORKSPACE_FILES, raw => { const row = object(raw, "observed file"); only(row, ["path", "size", "mtimeMs"], "observed file");
          return { path: relativePath(row.path, "observed path"), size: integer(row.size, "observed size", 0, Number.MAX_SAFE_INTEGER), mtimeMs: time(row.mtimeMs, "observed mtime") }; }),
        scanned: counter(item.scanned, "observed scanned"), counted: counter(item.counted, "observed counted") };
    case "unavailable": only(item, ["kind", "reason"], "unavailable observation"); return { kind: "unavailable", reason: choice(item.reason, WORKSPACE_UNAVAILABLE_REASONS, "unavailable reason") };
  }
  return invalid("workspace observation");
}
export function parseConsentRecord(value: unknown): ConsentRecord {
  const item = object(value, "consent record"); only(item, ["logSeq", "commandId", "vendor", "scope", "decision", "categories", "policyVersion", "authKind", "decidedAt"], "consent record");
  const scope = object(item.scope, "consent scope");
  const parsedScope: ConsentRecord["scope"] = scope.kind === "global" ? (only(scope, ["kind"], "consent scope"), { kind: "global" })
    : scope.kind === "session" ? (only(scope, ["kind", "sessionId"], "consent scope"), { kind: "session", sessionId: sessionId(scope.sessionId) }) : invalid("consent scope");
  const commandId = bounded(item.commandId, "consent command", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(commandId)) invalid("consent command");
  const categories = list(item.categories, "consent categories", DATA_CLASSES.length, raw => choice(raw, DATA_CLASSES, "consent category"));
  if (new Set(categories).size !== categories.length) invalid("consent categories");
  return { logSeq: integer(item.logSeq, "consent log seq", 1, Number.MAX_SAFE_INTEGER), commandId, vendor: parseVendorKey(item.vendor), scope: parsedScope,
    decision: choice(item.decision, CONSENT_DECISIONS, "consent decision"), categories, policyVersion: policyVersion(item.policyVersion),
    authKind: nullable(item.authKind, raw => bounded(raw, "consent authentication kind", MAX_AUTH_KIND_BYTES)), decidedAt: time(item.decidedAt, "consent decided at") };
}
export function parseRelayPin(value: unknown): RelayPin {
  const item = object(value, "relay pin"); only(item, ["pinId", "messageId", "author", "offset", "length", "quoteHmac", "pinnedSeq"], "relay pin");
  return { pinId: pinId(item.pinId), messageId: messageId(item.messageId), author: choice(item.author, ["user", "assistant"] as const, "pin author"), offset: integer(item.offset, "pin offset", 0, 8 * 1024 * 1024),
    length: integer(item.length, "pin length", 1, RELAY_PIN_BYTES), quoteHmac: hmacDigest(item.quoteHmac), pinnedSeq: integer(item.pinnedSeq, "pin seq", 1, RELAY_MAX_SEQ) };
}
export function parseRelayExclusion(value: unknown): RelayExclusion {
  const item = object(value, "relay exclusion"); only(item, ["exclusionId", "kind", "ref", "addedSeq"], "relay exclusion");
  const kind = choice(item.kind, ["run", "section"] as const, "exclusion kind");
  const ref = kind === "section" ? choice(item.ref, SECTION_IDS, "excluded section") : runId(item.ref);
  return { exclusionId: exclusionId(item.exclusionId), kind, ref, addedSeq: integer(item.addedSeq, "exclusion seq", 1, RELAY_MAX_SEQ) };
}
export function parseRelayWindow(value: unknown): RelayWindow {
  const item = object(value, "relay window"); only(item, ["harnessId", "controlId", "modelKey", "size", "firstTurnUsed", "observedAt"], "relay window");
  return { harnessId: catalogIdentity(item.harnessId, "window Harness"), controlId: catalogIdentity(item.controlId, "window control"), modelKey: bounded(item.modelKey, "window model key", MAX_RELAY_MODEL_BYTES, true),
    size: integer(item.size, "window size", 1, MAX_RELAY_COUNTER), firstTurnUsed: nullable(item.firstTurnUsed, raw => counter(raw, "first Turn tokens")), observedAt: time(item.observedAt, "window observed at") };
}
export function parseRelayPref(key: unknown, value: unknown): { readonly key: RelayPrefKey; readonly value: string } {
  const name = choice(key, RELAY_PREF_KEYS, "relay preference key");
  const text = bounded(value, "relay preference value", RELAY_PREF_VALUE_BYTES);
  if (!RELAY_PREF_VALUES[name].includes(text)) invalid("relay preference value");
  return { key: name, value: text };
}
