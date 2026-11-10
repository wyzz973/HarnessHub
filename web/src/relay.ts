import type { ContinuityLevel, DeliveryEvidence, DeliveryStatus, RelayAttention, RelayDecision, RelayPrefKey, RunRelay, Tier } from "../../src/contracts/relay.js";
import type { RelayStreamEvent, RelayStreamEventType } from "../../src/contracts/web.js";

/*
 * The relay as the page sees it (ADR-055, relay-architecture §12, docs/proposals/relay/stage3-workstreams.md §3): the
 * Gateway's relay state of one conversation, the stored text of a packet, the installation's relay preferences, the
 * choices a refused send offers, and the one data layer that reads them.
 *
 * The Gateway may not have these endpoints (an older one), or may answer with fields this page does not know. Nothing here
 * throws for that: a missing endpoint is "no relay information" (`null`), an unreadable row is left out, and an unknown
 * word is never taken for a good one (an unrecognised delivery state is not "delivered"). Components read only the
 * `RelayApi` interface, so a test can hand them any data layer.
 */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

// ---------------------------------------------------------------------------------------------------------------------
// Vocabulary: the words of the wire, each list checked against the contract it mirrors.
// ---------------------------------------------------------------------------------------------------------------------

export const RELAY_TIERS = ["goal", "brief", "standard", "fidelity", "full"] as const;
export type RelayTier = typeof RELAY_TIERS[number];
export type RelayTiersAreListed = Holds<Exact<RelayTier, Tier>>;
export const RELAY_SYNC_STATES = ["fresh", "synced", "pending", "suspect"] as const;
export type RelaySyncState = typeof RELAY_SYNC_STATES[number];
export const RELAY_DELIVERY_STATES = ["in_flight", "recorded", "unknown", "not_recorded"] as const;
export type RelayDeliveryState = typeof RELAY_DELIVERY_STATES[number];
export type RelayDeliveryStatesAreListed = Holds<Exact<RelayDeliveryState, DeliveryStatus>>;
export const RELAY_EVIDENCE = ["E1", "E2", "E3"] as const;
export type RelayEvidence = typeof RELAY_EVIDENCE[number];
export type RelayEvidenceIsListed = Holds<Exact<RelayEvidence, DeliveryEvidence>>;
export const RELAY_CONTINUITY_KINDS = ["native_resume", "native_resume_delta", "rehydrate", "native_fork", "native_import", "native_cleared", "blocked"] as const;
export type RelayContinuityKind = typeof RELAY_CONTINUITY_KINDS[number];
export type RelayContinuityKindsAreListed = Holds<Exact<RelayContinuityKind, ContinuityLevel["kind"]>>;
/** What a refused send may offer (stage3 §3). */
export const RELAY_OPTIONS = ["attach_full", "send_alone", "new_native", "clear_confirmed", "acknowledge"] as const;
export type RelayOption = typeof RELAY_OPTIONS[number];
export const RELAY_CROSS_VENDOR = ["ask", "allow", "goal_only"] as const;
export type RelayCrossVendor = typeof RELAY_CROSS_VENDOR[number];
export const RELAY_PREF_CROSS_VENDOR = "relay.crossVendor" satisfies RelayPrefKey;
/** What the relay does when it is unsure (a delivery nothing confirmed, a history it could not check): settle it itself, or ask. */
export const RELAY_WHEN_UNSURE = ["auto", "ask"] as const;
export type RelayWhenUnsure = typeof RELAY_WHEN_UNSURE[number];
export const RELAY_PREF_WHEN_UNSURE = "relay.whenUnsure" satisfies RelayPrefKey;
/** Why a binding asks the user to look at it (`attention.cause`), and what the relay decided for a Turn (`decision`): the words of the wire. */
export const RELAY_ATTENTION_CAUSES = ["delivery_unconfirmed", "verify_required", "marker_absent", "clear_unconfirmed", "recovery_failed", "input_limit", "consent_revoked", "consent_goal_only"] as const;
export type RelayAttentionCause = typeof RELAY_ATTENTION_CAUSES[number];
export type RelayAttentionCausesAreListed = Holds<Exact<RelayAttentionCause, RelayAttention["cause"]>>;
export const RELAY_DECISION_KINDS = ["carry", "alone", "plain"] as const;
export type RelayDecisionKind = typeof RELAY_DECISION_KINDS[number];
export type RelayDecisionKindsAreListed = Holds<Exact<RelayDecisionKind, RelayDecision["kind"]>>;
export const RELAY_DECISION_BY = ["need", "policy", "user"] as const;
export type RelayDecisionBy = typeof RELAY_DECISION_BY[number];
export type RelayDecisionByIsListed = Holds<Exact<RelayDecisionBy, RelayDecision["by"]>>;
export const RELAY_DECISION_CAUSES = ["delivery_unconfirmed", "verify_required", "marker_absent", "input_limit", "recovery_failed", "consent_revoked", "consent_goal_only", "prepare_failed", "classification_changed"] as const;
export type RelayDecisionCause = typeof RELAY_DECISION_CAUSES[number];
export type RelayDecisionCausesAreListed = Holds<Exact<RelayDecisionCause, NonNullable<RelayDecision["cause"]>>>;

// ---------------------------------------------------------------------------------------------------------------------
// What the Gateway tells
// ---------------------------------------------------------------------------------------------------------------------

/** One native binding of the conversation: a Harness entry's own session and what it is known to hold. */
export interface RelayBinding {
  readonly harnessId: string;
  readonly controlId: string;
  readonly nativeEpoch: number;
  /** "unknown" when the Gateway used a word this page does not know. */
  readonly sync: RelaySyncState | "unknown";
  /** Index (from 0) of the conversation's last Turn this binding is known to hold; null when none. */
  readonly throughRun: number | null;
  /** The kind of proof behind `throughRun`: E1, E2, E3, or native, origin, legacy, choice. */
  readonly evidence: string | null;
  /** How many times the native context was cleared. */
  readonly cleared: number;
  /** Whether a real run of this Harness has proved the relay; until then the card says so (and nothing is held back for it). */
  readonly probed: boolean;
  /** Whether anything this Harness does can tell the Gateway that a handoff arrived; null when the Gateway does not say. */
  readonly canConfirm: boolean | null;
  /** The named service this Harness was last seen running on (`openai`); null while unknown or when it is not a named one. */
  readonly vendor: string | null;
  /** What a handoff to it would carry now: Turns and an estimate of their tokens (which errs high). Null when nothing is owed or the Gateway does not say. */
  readonly owed: { readonly runs: number; readonly estTokens: number | null } | null;
  /** What the binding asks the user to look at, when it does: never a block, the next message goes anyway. */
  readonly attention: RelayAttentionInfo | null;
}
/** `attention` of a binding (permissive-defaults §2.6): why, the ways to settle it, how much is at stake, and the name of the episode. */
export interface RelayAttentionInfo {
  readonly cause: RelayAttentionCause;
  readonly options: readonly RelayOption[];
  readonly counts: { readonly runs: number; readonly packets: number };
  /** One episode: a closed banner of the same key does not come back. */
  readonly key: string;
  /** For `delivery_unconfirmed`: the "交接单 #n" the wait is about. */
  readonly packet: number | null;
  /** For an `acknowledge`: the vendor key the allowance would be for. */
  readonly vendor: string | null;
}
/** One packet the Gateway built and sent. */
export interface RelayPacket {
  readonly packetId: string;
  readonly runId: string;
  /** Index (from 0) of the Turn that carried it. */
  readonly runIndex: number;
  /** Its number in the conversation: "交接单 #1". */
  readonly number: number;
  readonly kind: string;
  readonly tier: RelayTier | null;
  readonly target: { readonly harnessId: string; readonly model: string | null };
  readonly estTokens: number;
  readonly omissions: number;
  readonly redactions: number;
  /** null when the Gateway used a word this page does not know. */
  readonly delivery: RelayDeliveryState | null;
  readonly evidence: RelayEvidence | null;
}
export interface RelayView {
  readonly bindings: readonly RelayBinding[]; readonly packets: readonly RelayPacket[];
  /** The data directory is within reach of this conversation's workspace: a warning for the workspace, never a block. */
  readonly dataRootExposed: boolean;
}

/** The relay facts a Turn carries, as the page reads them from the conversation view. */
export interface RunRelayInfo {
  readonly packetId: string | null;
  readonly kind: string | null;
  readonly continuity: { readonly kind: RelayContinuityKind; readonly tier?: RelayTier; readonly runs?: number; readonly complete?: boolean; readonly code?: string };
  readonly executedOn: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number } | null;
  /** Present when the Gateway tells the delivery in the conversation view; a state is null when it used a word this page does not know. */
  readonly delivery: { readonly state: RelayDeliveryState | null; readonly evidence: RelayEvidence | null } | null;
  /** What the relay decided for the Turn and why, when it recorded a decision (an ordinary Turn that owes nothing records none). */
  readonly decision: RelayDecisionInfo | null;
}
/** `decision` of a Turn: what the relay did with its history (carried it, sent the words alone, sent them as typed), who decided, and the situation. */
export interface RelayDecisionInfo {
  readonly kind: RelayDecisionKind;
  readonly by: RelayDecisionBy;
  readonly cause: RelayDecisionCause | null;
  readonly reason: string | null;
}
/** A Turn's relay member with the delivery and the decision a Gateway attaches to it (the contract's RunRelay does not have them). */
export type ClientRunRelay = RunRelay & { readonly delivery?: { readonly state?: unknown; readonly evidence?: unknown }; readonly decision?: { readonly kind?: unknown; readonly by?: unknown; readonly cause?: unknown; readonly reason?: unknown } };

/** The installation's relay preferences the page lets the user change (the Gateway has more, which only the API sets). */
export interface RelayPrefs { readonly crossVendor: RelayCrossVendor; readonly whenUnsure: RelayWhenUnsure }
/** The stored text of one packet, as it was sent. */
export interface RelayPacketText {
  readonly text: string;
  /** sha256 of the text, when the Gateway sent it as the ETag. */
  readonly etag: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the page asks, and what a refusal says
// ---------------------------------------------------------------------------------------------------------------------

/** The `relay` member of a message: what to do about the history for this one message (stage3 §3). */
export interface RelayRequest {
  readonly attach?: "auto" | "full" | "none";
  readonly resend?: true;
  readonly clearConfirmed?: true;
  readonly native?: "continue" | "new";
  readonly tier?: RelayTier;
  readonly note?: string;
  readonly consent?: { readonly vendor: string; readonly decision: "acknowledged" | "goal_only"; readonly scope: "session" | "global" };
}
/** The request as it goes in the body, or null when it asks for nothing. */
export function relayBody(request: RelayRequest | undefined): Record<string, unknown> | null {
  if (request === undefined) return null;
  const body: Record<string, unknown> = {};
  if (request.attach !== undefined) body.attach = request.attach;
  if (request.resend === true) body.resend = true;
  if (request.clearConfirmed === true) body.clearConfirmed = true;
  if (request.native !== undefined) body.native = request.native;
  if (request.tier !== undefined) body.tier = request.tier;
  if (request.note !== undefined && request.note !== "") body.note = request.note;
  if (request.consent !== undefined) body.consent = { vendor: request.consent.vendor, decision: request.consent.decision, scope: request.consent.scope };
  return Object.keys(body).length ? body : null;
}

/** The `relay` member of a refused send's error body: which binding, why, and the ways forward. */
export interface RelayErrorBody {
  readonly binding: { readonly harnessId: string; readonly controlId: string } | null;
  /** `delivery_unconfirmed`, `verify_required`, `marker_absent`, `missing`, `vendor_changed`, or a reason such as `data_root_in_workspace`. */
  readonly cause: string | null;
  readonly options: readonly RelayOption[];
  readonly counts: { readonly runs: number; readonly packets: number } | null;
  /** Optional, from a Gateway that names the vendor a consent is asked for; a consent request echoes it back. */
  readonly vendor: string | null;
}
/** A refused send that waits for the user's choice: the code the Gateway refused with, and what it offered. */
export interface RelayChoice { readonly code: string; readonly body: RelayErrorBody }

// ---------------------------------------------------------------------------------------------------------------------
// Reading: every decoder is lenient and never throws
// ---------------------------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function word(value: unknown, limit = 256): string | null { return typeof value === "string" && value.length > 0 && value.length <= limit ? value : null; }
function whole(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] | null { return typeof value === "string" && (choices as readonly string[]).includes(value) ? value as T[number] : null; }

/** The attention of a binding; null for none, and for one whose cause this page does not know (it is not shown as another). */
function decodeAttention(value: unknown): RelayAttentionInfo | null {
  if (!isRecord(value)) return null;
  const cause = oneOf(value.cause, RELAY_ATTENTION_CAUSES), key = word(value.key, 256), counts = isRecord(value.counts) ? value.counts : {};
  if (cause === null || key === null) return null;
  return { cause, options: Array.isArray(value.options) ? [...new Set(value.options.flatMap(item => oneOf(item, RELAY_OPTIONS) ?? []))] : [], key,
    counts: { runs: whole(counts.runs) ?? 0, packets: whole(counts.packets) ?? 0 }, packet: whole(value.packet), vendor: word(value.vendor, 253) };
}
function decodeBinding(value: unknown): RelayBinding | null {
  if (!isRecord(value)) return null;
  const harnessId = word(value.harnessId, 96), controlId = word(value.controlId, 96);
  if (harnessId === null || controlId === null) return null;
  const runs = isRecord(value.owed) ? whole(value.owed.runs) : null;
  return { harnessId, controlId, nativeEpoch: whole(value.nativeEpoch) ?? 1, sync: oneOf(value.sync, RELAY_SYNC_STATES) ?? "unknown",
    throughRun: whole(value.throughRun), evidence: word(value.evidence, 32), cleared: whole(value.cleared) ?? 0, probed: value.probed === true,
    canConfirm: typeof value.canConfirm === "boolean" ? value.canConfirm : null, vendor: word(value.vendor, 32),
    owed: runs === null || !isRecord(value.owed) || runs === 0 ? null : { runs, estTokens: whole(value.owed.estTokens) }, attention: decodeAttention(value.attention) };
}
function decodePacket(value: unknown): RelayPacket | null {
  if (!isRecord(value)) return null;
  const packetId = word(value.packetId, 128), runId = word(value.runId, 128), runIndex = whole(value.runIndex), number = whole(value.number);
  const target = isRecord(value.target) ? value.target : {}, harnessId = word(target.harnessId, 96);
  if (packetId === null || runId === null || runIndex === null || number === null || harnessId === null) return null;
  return { packetId, runId, runIndex, number, kind: word(value.kind, 32) ?? "packet", tier: oneOf(value.tier, RELAY_TIERS), target: { harnessId, model: word(target.model, 128) },
    estTokens: whole(value.estTokens) ?? 0, omissions: whole(value.omissions) ?? 0, redactions: whole(value.redactions) ?? 0,
    delivery: oneOf(value.delivery, RELAY_DELIVERY_STATES), evidence: oneOf(value.evidence, RELAY_EVIDENCE) };
}
/** The conversation's relay state; null when the answer is not the relay view (an older Gateway, another shape). */
export function decodeRelayView(value: unknown): RelayView | null {
  if (!isRecord(value) || !Array.isArray(value.bindings) || !Array.isArray(value.packets)) return null;
  return { bindings: value.bindings.slice(0, 64).flatMap(row => decodeBinding(row) ?? []), packets: value.packets.slice(0, 512).flatMap(row => decodePacket(row) ?? []), dataRootExposed: value.dataRootExposed === true };
}
/** The `relay` member of an error body; null when there is none. A member that offers nothing has no options. */
export function decodeRelayErrorBody(value: unknown): RelayErrorBody | null {
  if (!isRecord(value)) return null;
  const harnessId = isRecord(value.binding) ? word(value.binding.harnessId, 96) : null, controlId = isRecord(value.binding) ? word(value.binding.controlId, 96) : null;
  const runs = isRecord(value.counts) ? whole(value.counts.runs) : null;
  return { binding: harnessId === null || controlId === null ? null : { harnessId, controlId }, cause: word(value.cause, 64),
    options: Array.isArray(value.options) ? [...new Set(value.options.flatMap(item => oneOf(item, RELAY_OPTIONS) ?? []))] : [],
    counts: runs === null || !isRecord(value.counts) ? null : { runs, packets: whole(value.counts.packets) ?? 0 }, vendor: word(value.vendor, 253) };
}

function decodeContinuity(value: unknown): RunRelayInfo["continuity"] | null {
  // Events of the first relay version wrote the level as a bare word.
  const level = typeof value === "string" ? { kind: value } : isRecord(value) ? value : null, kind = level === null ? null : oneOf(level.kind, RELAY_CONTINUITY_KINDS);
  if (level === null || kind === null) return null;
  const tier = oneOf(level.tier, RELAY_TIERS), runs = whole(level.runs), code = word(level.code, 64);
  return { kind, ...(tier === null ? {} : { tier }), ...(runs === null ? {} : { runs }), ...(typeof level.complete === "boolean" ? { complete: level.complete } : {}), ...(code === null ? {} : { code }) };
}
function decodeExecutedOn(value: unknown): RunRelayInfo["executedOn"] {
  if (!isRecord(value)) return null;
  const harnessId = word(value.harnessId, 96), controlId = word(value.controlId, 96);
  return harnessId === null || controlId === null ? null : { harnessId, controlId, nativeEpoch: whole(value.nativeEpoch) ?? 1 };
}
/**
 * A Turn's `relay` member as the conversation view carries it, kept on the decoded Turn; null, as if the Turn had none,
 * when it is not what a Turn carries (an unknown continuity). The delivery a newer Gateway adds is kept as its words.
 */
export function decodeRunRelay(value: unknown): ClientRunRelay | null {
  if (!isRecord(value)) return null;
  const packetId = value.packetId == null ? null : word(value.packetId, 128), kind = value.kind == null ? null : word(value.kind, 32), continuity = decodeContinuity(value.continuity);
  if (continuity === null || (value.packetId != null && packetId === null) || (value.kind != null && kind === null)) return null;
  const delivery = isRecord(value.delivery) ? { state: word(value.delivery.state, 32), evidence: word(value.delivery.evidence, 8) } : undefined;
  const decision = isRecord(value.decision) ? { kind: word(value.decision.kind, 16), by: word(value.decision.by, 16), cause: word(value.decision.cause, 48), reason: word(value.decision.reason, 64) } : undefined;
  // The contract types brand the identity and close the words; the page keeps what it read and checks the words where it uses them.
  return { packetId, kind, continuity, executedOn: decodeExecutedOn(value.executedOn), ...(delivery === undefined ? {} : { delivery }), ...(decision === undefined ? {} : { decision }) } as unknown as ClientRunRelay;
}
/** What a Turn's relay member says, normalised; null when the Turn carries none. */
export function runRelayInfo(run: { readonly relay?: RunRelay | undefined }): RunRelayInfo | null {
  const raw: unknown = run.relay;
  if (!isRecord(raw)) return null;
  const continuity = decodeContinuity(raw.continuity);
  if (continuity === null) return null;
  return { packetId: word(raw.packetId, 128), kind: word(raw.kind, 32), continuity, executedOn: decodeExecutedOn(raw.executedOn),
    delivery: isRecord(raw.delivery) ? { state: oneOf(raw.delivery.state, RELAY_DELIVERY_STATES), evidence: oneOf(raw.delivery.evidence, RELAY_EVIDENCE) } : null,
    decision: decodeDecision(raw.decision) };
}
/** A Turn's decision; null for none, and for one whose kind or author this page does not know (an unknown cause is only left out). */
function decodeDecision(value: unknown): RelayDecisionInfo | null {
  if (!isRecord(value)) return null;
  const kind = oneOf(value.kind, RELAY_DECISION_KINDS), by = oneOf(value.by, RELAY_DECISION_BY);
  return kind === null || by === null ? null : { kind, by, cause: oneOf(value.cause, RELAY_DECISION_CAUSES), reason: word(value.reason, 64) };
}
/**
 * The preferences, from the shapes a Gateway may answer with (`{ prefs: { "relay.crossVendor": … } }`, the same without the wrapper,
 * or a list of key and value); null when none is recognised. A key the Gateway does not name has its default.
 */
export function decodeRelayPrefs(value: unknown): RelayPrefs | null {
  const rows = Array.isArray(value) ? Object.fromEntries(value.flatMap(item => isRecord(item) && typeof item.key === "string" ? [[item.key, item.value]] : []))
    : isRecord(value) ? isRecord(value.prefs) ? value.prefs : value : null;
  if (rows === null) return null;
  // A value this page cannot read is not shown as another: the whole answer is then no answer.
  const cross = rows[RELAY_PREF_CROSS_VENDOR] ?? rows.crossVendor, unsure = rows[RELAY_PREF_WHEN_UNSURE] ?? rows.whenUnsure;
  const crossVendor = cross === undefined ? "allow" : oneOf(cross, RELAY_CROSS_VENDOR), whenUnsure = unsure === undefined ? "auto" : oneOf(unsure, RELAY_WHEN_UNSURE);
  return crossVendor === null || whenUnsure === null ? null : { crossVendor, whenUnsure };
}
/** One event the Gateway pushes about the relay. The page needs to know only that the relay state changed, and of what. */
export interface RelayEvent { readonly type: string; readonly sessionId: string | null; readonly runId: string | null; readonly packetId: string | null }
/**
 * The `event` of a relay notice frame as the contract types it (RelayStreamEvent); null when it is not one. The event's kind is
 * kept as the Gateway named it: a kind this page does not know is still a notice that the relay changed.
 */
export function decodeRelayStreamEvent(value: unknown): RelayStreamEvent | null {
  if (!isRecord(value)) return null;
  const type = word(value.type, 64), sessionId = word(value.sessionId, 128), at = whole(value.at);
  if (type === null || sessionId === null || at === null) return null;
  const runId = word(value.runId, 128), packetId = word(value.packetId, 128);
  return { type: type as RelayStreamEventType, sessionId, ...(runId === null ? {} : { runId }), ...(packetId === null ? {} : { packetId }), at };
}
export function decodeRelayFrame(value: unknown): RelayEvent | null {
  if (!isRecord(value) || value.type !== "relay" || !isRecord(value.event)) return null;
  const type = word(value.event.type, 64);
  return type === null ? null : { type, sessionId: word(value.event.sessionId, 128), runId: word(value.event.runId, 128), packetId: word(value.event.packetId, 128) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The data layer
// ---------------------------------------------------------------------------------------------------------------------

/** One answer from the Gateway: its status, its body (parsed JSON, or text for a text read; undefined if unreadable) and ETag. */
export interface RelayReply { readonly status: number; readonly body: unknown; readonly etag: string | null }
/** The one door to the Gateway's relay endpoints. It resolves for every HTTP status and rejects only when the Gateway could not be reached. */
export interface RelayTransport {
  send(request: { readonly method: "GET" | "PUT"; readonly path: string; readonly body?: unknown; readonly as: "json" | "text"; readonly signal?: AbortSignal | undefined }): Promise<RelayReply>;
}
/** Why a read or a write of the relay failed, in the words the page shows. */
export class RelayReadError extends Error {
  constructor(readonly status: number | null, message: string) { super(message); this.name = "RelayReadError"; }
}

/** One read of the conversation's relay state: the view, or null with whether the Gateway said it has no such endpoint at all. */
export interface RelayViewRead { readonly view: RelayView | null; readonly absent: boolean }
/** What components read and write; a test hands them its own. */
export interface RelayApi {
  /** The conversation's relay state; `view` is null when the Gateway has none to give (`absent` says it has no relay endpoint). Never rejects. */
  view(sessionId: string, signal?: AbortSignal): Promise<RelayViewRead>;
  /** The stored text of one packet; rejects with a `RelayReadError` when it cannot be read. */
  packetText(sessionId: string, packetId: string, signal?: AbortSignal): Promise<RelayPacketText>;
  /** The installation's relay preferences; null when the Gateway has none to give. Never rejects. */
  prefs(signal?: AbortSignal): Promise<RelayPrefs | null>;
  /** Sets one preference; rejects with a `RelayReadError` when the Gateway refuses it. */
  setPref<K extends keyof RelayPrefs>(name: K, value: RelayPrefs[K]): Promise<void>;
}
const PREF_KEYS: Readonly<Record<keyof RelayPrefs, RelayPrefKey>> = { crossVendor: RELAY_PREF_CROSS_VENDOR, whenUnsure: RELAY_PREF_WHEN_UNSURE };
export function createRelayApi(transport: RelayTransport): RelayApi {
  const id = encodeURIComponent;
  return {
    async view(sessionId, signal) {
      try {
        const reply = await transport.send({ method: "GET", path: `/sessions/${id(sessionId)}/relay`, as: "json", signal });
        // A route the Gateway does not have is NOT_FOUND; a conversation it does not have is a different code and not an absent relay.
        const code = isRecord(reply.body) ? reply.body.code : undefined;
        return reply.status === 200 ? { view: decodeRelayView(reply.body), absent: false }
          : { view: null, absent: reply.status === 405 || reply.status === 501 || reply.status === 404 && (code === undefined || code === "NOT_FOUND") };
      } catch { return { view: null, absent: false }; }
    },
    async packetText(sessionId, packetId, signal) {
      const reply = await transport.send({ method: "GET", path: `/sessions/${id(sessionId)}/relay/${id(packetId)}`, as: "text", signal });
      if (reply.status !== 200 || typeof reply.body !== "string") throw new RelayReadError(reply.status, reply.status === 404 ? "这份交接单已不存在，或不属于这个对话。" : `这份交接单没有读到（网关返回 ${reply.status}）。`);
      return { text: reply.body, etag: reply.etag };
    },
    async prefs(signal) {
      try {
        const reply = await transport.send({ method: "GET", path: "/relay/prefs", as: "json", signal });
        return reply.status === 200 ? decodeRelayPrefs(reply.body) : null;
      } catch { return null; }
    },
    async setPref(name, value) {
      const reply = await transport.send({ method: "PUT", path: "/relay/prefs", as: "json", body: { key: PREF_KEYS[name], value } });
      if (reply.status < 200 || reply.status >= 300) throw new RelayReadError(reply.status, `这项设置没有保存（网关返回 ${reply.status}）。`);
    },
  };
}
