import type { ContinuityLevel, DeliveryEvidence, DeliveryStatus, RelayAttention, RelayDecision, RelayInstallationNotice, RunRelay, Tier } from "../../src/contracts/relay.js";
import type { RelayStreamEvent, RelayStreamEventType } from "../../src/contracts/web.js";

/*
 * The relay as the page sees it (ADR-055, docs/proposals/relay/slim.md): the Gateway's relay state of one conversation, the stored
 * text of a packet, the installation's one relay preference, and the one data layer that reads them.
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

export const RELAY_TIERS = ["full", "brief"] as const;
export type RelayTier = typeof RELAY_TIERS[number];
export type RelayTiersAreListed = Holds<Exact<RelayTier, Tier>>;
export const RELAY_SYNC_STATES = ["fresh", "synced", "pending"] as const;
export type RelaySyncState = typeof RELAY_SYNC_STATES[number];
export const RELAY_DELIVERY_STATES = ["in_flight", "recorded", "unknown", "not_recorded"] as const;
export type RelayDeliveryState = typeof RELAY_DELIVERY_STATES[number];
export type RelayDeliveryStatesAreListed = Holds<Exact<RelayDeliveryState, DeliveryStatus>>;
/** What a delivery was decided by: the native side's own report as it happened (E1), or the Turn's normal end where that proves receipt (E3). */
export const RELAY_EVIDENCE = ["E1", "E3"] as const;
export type RelayEvidence = typeof RELAY_EVIDENCE[number];
export type RelayEvidenceIsListed = Holds<Exact<RelayEvidence, DeliveryEvidence>>;
export const RELAY_CONTINUITY_KINDS = ["native_resume", "native_resume_delta", "rehydrate", "native_fork", "native_import", "native_cleared", "blocked"] as const;
export type RelayContinuityKind = typeof RELAY_CONTINUITY_KINDS[number];
export type RelayContinuityKindsAreListed = Holds<Exact<RelayContinuityKind, ContinuityLevel["kind"]>>;
/** The one way a banner is settled: the next message attaches the whole earlier conversation. */
export const RELAY_OPTIONS = ["attach_full"] as const;
export type RelayOption = typeof RELAY_OPTIONS[number];
/** The installation's one relay setting: whether a switch to another Harness attaches the earlier conversation by itself (`auto`, the default) or not (`off`). */
export const RELAY_ATTACH = ["auto", "off"] as const;
export type RelayAttach = typeof RELAY_ATTACH[number];
export const RELAY_PREF_ATTACH = "relay.attach";
/** Why a binding asks the user to look at it (`attention.cause`), and what the relay decided for a Turn (`decision`): the words of the wire. */
export const RELAY_ATTENTION_CAUSES = ["delivery_unconfirmed", "attach_available"] as const;
export type RelayAttentionCause = typeof RELAY_ATTENTION_CAUSES[number];
export type RelayAttentionCausesAreListed = Holds<Exact<RelayAttentionCause, RelayAttention["cause"]>>;
export const RELAY_DECISION_KINDS = ["carry", "alone", "plain"] as const;
export type RelayDecisionKind = typeof RELAY_DECISION_KINDS[number];
export type RelayDecisionKindsAreListed = Holds<Exact<RelayDecisionKind, RelayDecision["kind"]>>;
/** How a `carry` decision sent a pending packet again: the automatic resend, a packet for newer facts that also holds the unconfirmed one's, everything again. */
export const RELAY_DECISION_RESENDS = ["auto", "grown", "all"] as const;
export type RelayDecisionResend = typeof RELAY_DECISION_RESENDS[number];
export type RelayDecisionResendsAreListed = Holds<Exact<RelayDecisionResend, NonNullable<RelayDecision["resend"]>>>;
/** What the installation as a whole cannot do for the relay while it stays so (`installation` of the relay view). */
export const RELAY_INSTALLATION_CAUSES = ["key_unavailable"] as const;
export type RelayInstallationCause = typeof RELAY_INSTALLATION_CAUSES[number];
export type RelayInstallationCausesAreListed = Holds<Exact<RelayInstallationCause, RelayInstallationNotice["cause"]>>;
export const RELAY_DECISION_BY = ["need", "policy", "user"] as const;
export type RelayDecisionBy = typeof RELAY_DECISION_BY[number];
export type RelayDecisionByIsListed = Holds<Exact<RelayDecisionBy, RelayDecision["by"]>>;
export const RELAY_DECISION_CAUSES = ["delivery_unconfirmed", "history_changed", "input_limit", "recovery_failed", "prepare_failed"] as const;
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
  /** The kind of proof behind `throughRun`: E1 or E3. */
  readonly evidence: RelayEvidence | null;
  /** 1 when the conversation was cleared on this Harness at some point, else 0 (the Gateway keeps no count). */
  readonly cleared: number;
  /** Whether anything this Harness does can tell the Gateway that a handoff arrived; null when the Gateway does not say. */
  readonly canConfirm: boolean | null;
  /** What a handoff to it would carry now: Turns and an estimate of their tokens (which errs high). Null when nothing is owed or the Gateway does not say. */
  readonly owed: { readonly runs: number; readonly estTokens: number | null } | null;
  /** What the binding asks the user to look at, when it does: never a block, the next message goes anyway. */
  readonly attention: RelayAttentionInfo | null;
}
/** `attention` of a binding: why, the way to settle it, how much is at stake, and the name of the episode. */
export interface RelayAttentionInfo {
  readonly cause: RelayAttentionCause;
  readonly options: readonly RelayOption[];
  readonly counts: { readonly runs: number; readonly packets: number };
  /** One episode: a closed banner of the same key does not come back. */
  readonly key: string;
  /** For `delivery_unconfirmed`: the "交接单 #n" the wait is about. */
  readonly packet: number | null;
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
  /** The Harnesses this installation has handed a conversation to before: the first handoff to any other is told in one line, once. */
  readonly handedOver: readonly string[];
  /** What the installation as a whole cannot do for the relay while it stays so: a standing notice, with its reason, until it is mended. Empty when nothing is wrong. */
  readonly installation: readonly { readonly cause: RelayInstallationCause; readonly detail: string | null }[];
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
  /** On a `carry` that sent a pending packet again: how. Null on any other (and from a Gateway that does not say). */
  readonly resend: RelayDecisionResend | null;
}
/** A Turn's relay member with the delivery and the decision a Gateway attaches to it (the contract's RunRelay does not have them). */
export type ClientRunRelay = RunRelay & { readonly delivery?: { readonly state?: unknown; readonly evidence?: unknown }; readonly decision?: { readonly kind?: unknown; readonly by?: unknown; readonly cause?: unknown; readonly reason?: unknown; readonly resend?: unknown } };

/** The installation's relay preference the page lets the user change. */
export interface RelayPrefs { readonly attach: RelayAttach }
/** The stored text of one packet, as it was sent. */
export interface RelayPacketText {
  readonly text: string;
  /** sha256 of the text, when the Gateway sent it as the ETag. */
  readonly etag: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the page asks
// ---------------------------------------------------------------------------------------------------------------------

/** The `relay` member of a message: what to do about the history for this one message. `full` attaches the whole earlier conversation, `none` sends the words alone. */
export interface RelayRequest { readonly attach?: "auto" | "full" | "none" }
/** The request as it goes in the body, or null when it asks for nothing. */
export function relayBody(request: RelayRequest | undefined): Record<string, unknown> | null {
  if (request === undefined) return null;
  const body: Record<string, unknown> = {};
  if (request.attach !== undefined) body.attach = request.attach;
  return Object.keys(body).length ? body : null;
}

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
    counts: { runs: whole(counts.runs) ?? 0, packets: whole(counts.packets) ?? 0 }, packet: whole(value.packet) };
}
function decodeBinding(value: unknown): RelayBinding | null {
  if (!isRecord(value)) return null;
  const harnessId = word(value.harnessId, 96), controlId = word(value.controlId, 96);
  if (harnessId === null || controlId === null) return null;
  const runs = isRecord(value.owed) ? whole(value.owed.runs) : null;
  return { harnessId, controlId, nativeEpoch: whole(value.nativeEpoch) ?? 1, sync: oneOf(value.sync, RELAY_SYNC_STATES) ?? "unknown",
    throughRun: whole(value.throughRun), evidence: oneOf(value.evidence, RELAY_EVIDENCE), cleared: whole(value.cleared) ?? 0,
    canConfirm: typeof value.canConfirm === "boolean" ? value.canConfirm : null,
    owed: runs === null || !isRecord(value.owed) || runs === 0 ? null : { runs, estTokens: whole(value.owed.estTokens) }, attention: decodeAttention(value.attention) };
}
/** What the installation cannot do for the relay; a cause this page does not know is left out (it is not shown as another). */
function decodeInstallation(value: unknown): RelayView["installation"] {
  return Array.isArray(value) ? value.slice(0, 8).flatMap(row => { const cause = isRecord(row) ? oneOf(row.cause, RELAY_INSTALLATION_CAUSES) : null; return cause === null || !isRecord(row) ? [] : [{ cause, detail: word(row.detail, 200) }]; }) : [];
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
  return { bindings: value.bindings.flatMap(row => decodeBinding(row) ?? []), packets: value.packets.flatMap(row => decodePacket(row) ?? []),
    handedOver: Array.isArray(value.handedOver) ? value.handedOver.flatMap(item => word(item, 96) ?? []) : [], installation: decodeInstallation(value.installation) };
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
  const decision = isRecord(value.decision) ? { kind: word(value.decision.kind, 16), by: word(value.decision.by, 16), cause: word(value.decision.cause, 48), reason: word(value.decision.reason, 64), resend: word(value.decision.resend, 16) } : undefined;
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
  return kind === null || by === null ? null : { kind, by, cause: oneOf(value.cause, RELAY_DECISION_CAUSES), reason: word(value.reason, 64), resend: oneOf(value.resend, RELAY_DECISION_RESENDS) };
}
/**
 * The preference, from the shapes a Gateway may answer with (`{ prefs: { "relay.attach": … } }`, the same without the wrapper, or a
 * list of key and value); null when none is recognised. A key the Gateway does not name has its default.
 */
export function decodeRelayPrefs(value: unknown): RelayPrefs | null {
  const rows = Array.isArray(value) ? Object.fromEntries(value.flatMap(item => isRecord(item) && typeof item.key === "string" ? [[item.key, item.value]] : []))
    : isRecord(value) ? isRecord(value.prefs) ? value.prefs : value : null;
  if (rows === null) return null;
  // A value this page cannot read is not shown as another: the whole answer is then no answer.
  const attach = rows[RELAY_PREF_ATTACH] ?? rows.attach, chosen = attach === undefined ? "auto" : oneOf(attach, RELAY_ATTACH);
  return chosen === null ? null : { attach: chosen };
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
  /** The installation's relay preference; null when the Gateway has none to give. Never rejects. */
  prefs(signal?: AbortSignal): Promise<RelayPrefs | null>;
  /** Sets one preference; rejects with a `RelayReadError` when the Gateway refuses it. */
  setPref<K extends keyof RelayPrefs>(name: K, value: RelayPrefs[K]): Promise<void>;
}
const PREF_KEYS: Readonly<Record<keyof RelayPrefs, string>> = { attach: RELAY_PREF_ATTACH };
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
