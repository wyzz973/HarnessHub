import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayLedger, vendorKeyOf, type RequestedConsent } from "../contexts/session/application/relay-coordinator.js";
import type { RelayChoice } from "../contexts/session/application/runtime.js";
import { dispatched } from "../contexts/session/domain/relay/advance.js";
import { estimateTokens, resolveRelayBudget } from "../contexts/session/domain/relay/budget.js";
import { heldSince, owed } from "../contexts/session/domain/relay/delivery.js";
import { terminal } from "../contexts/session/domain/state.js";
import {
  ATTACH_CHOICES, NATIVE_CHOICES, RELAY_PREF_DEFAULTS, RELAY_PREF_KEYS, RELAY_PREF_VALUES, TIERS, markOf, parseVendorKey, relayDecisionOf,
  type BindingRelayState, type DeliveredMark, type DeliveryOutcome, type DeliveryRecord, type RelayAttention, type RelayCapabilities, type RelayDecision, type RelayIndexRow, type RelayLogPort, type RelayPrefKey, type RelayStorePort, type Tier, type VendorKey,
} from "../contracts/relay.js";
import { SessionError, sessionId, type HarnessSelection, type NativeSessionBinding, type SessionEvent, type SessionId, type SessionSnapshot } from "../contracts/session.js";
import type { RelayAttentionView, RelayBindingView, RelayDeliveryView, RelayErrorView, RelayOption, RelayPacketView, RelayPrefsView, RelayView, WebRun } from "../contracts/web.js";

/**
 * The relay's HTTP API (ADR-055 §12.4, G073's server side): the choices a send makes, the error bodies the user can answer,
 * the read model of a Session's bindings and packets, a packet's stored text, the installation's preferences, and the
 * delivery state the Run DTO carries. Everything is derived from committed rows and the Session's own facts; nothing here
 * decides anything about delivery (the Runtime does) and nothing reaches a Harness.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The relay member of a send request
// ---------------------------------------------------------------------------------------------------------------------

/** Longest note (附言) a request carries, in UTF-8 bytes; the packet's own budget for it is tokens (G070). */
const MAX_NOTE_BYTES = 4096;
const SEND_FIELDS = ["attach", "resend", "clearConfirmed", "native", "tier", "note", "consent"] as const;
function invalid(message: string): never { throw new SessionError("INVALID_INPUT", message); }
function plain(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label + " must be an object");
  return value as Readonly<Record<string, unknown>>;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) invalid(label + " is not one of its values");
  return value as T;
}
function onlyTrue(value: unknown, label: string): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) invalid(label + " must be true");
  return true;
}
function noteText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > MAX_NOTE_BYTES || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) invalid("relay.note must be text of at most " + MAX_NOTE_BYTES + " bytes");
  return value;
}
/** What a request asks to record as the user's consent (relay-architecture §10.4); the vendor key is checked, not trusted. */
export type { RequestedConsent };
function consentOf(value: unknown): RequestedConsent {
  const row = plain(value, "relay.consent");
  if (Object.keys(row).some(key => key !== "vendor" && key !== "decision" && key !== "scope") || !("vendor" in row) || !("decision" in row) || !("scope" in row)) invalid("relay.consent names a vendor, a decision and a scope");
  let vendor: VendorKey;
  try { vendor = parseVendorKey(row.vendor); } catch { return invalid("relay.consent.vendor must be a vendor key"); }
  return { vendor, decision: oneOf(row.decision, ["acknowledged", "goal_only"] as const, "relay.consent.decision"), scope: oneOf(row.scope, ["session", "global"] as const, "relay.consent.scope") };
}
export interface SendRelay {
  /**
   * What the Runtime is handed: `runtime.send`'s fifth argument, which also puts the choices in the command's fingerprint; the
   * target's tier, a new native session (`native:"new"`) and a consent to record go with the three history choices. Undefined when the
   * request made no choice.
   */
  readonly choices: RelayChoice | undefined;
}
/**
 * The `relay` member of `POST …/messages`, checked field by field: an object of only the known fields, each with one of its
 * values (INVALID_INPUT, an HTTP 400, for anything else, with a fixed text that quotes nothing of the request). `attach:
 * "auto"` is no choice. An input sent alone (`attach: "none"`) carries no other choice, as the Runtime holds it. A `note` is
 * checked and goes no further: the Runtime takes no note until the packet does (G070), and a request that has one is neither
 * refused nor changed by it.
 */
export function parseSendRelay(value: unknown): SendRelay {
  if (value === undefined) return { choices: undefined };
  const item = plain(value, "relay");
  if (Object.keys(item).some(key => !(SEND_FIELDS as readonly string[]).includes(key))) invalid("relay has a field this Gateway does not know");
  const attach = item.attach === undefined ? undefined : oneOf(item.attach, ATTACH_CHOICES, "relay.attach");
  const resend = onlyTrue(item.resend, "relay.resend"), clearConfirmed = onlyTrue(item.clearConfirmed, "relay.clearConfirmed");
  const native = item.native === undefined ? undefined : oneOf(item.native, NATIVE_CHOICES, "relay.native");
  const tier = item.tier === undefined ? undefined : oneOf(item.tier, TIERS, "relay.tier");
  if (item.note !== undefined) noteText(item.note);
  const consent = item.consent === undefined ? undefined : consentOf(item.consent);
  if (attach === "none" && (resend === true || clearConfirmed === true || native === "new" || consent !== undefined)) invalid("an input sent alone carries no other relay choice");
  const choices: { attach?: "full" | "none"; resend?: true; clearConfirmed?: true; tier?: Tier; native?: "continue" | "new"; consent?: RequestedConsent } = {
    ...(attach === "full" || attach === "none" ? { attach } : {}), ...(resend === true ? { resend: true as const } : {}), ...(clearConfirmed === true ? { clearConfirmed: true as const } : {}),
    ...(tier === undefined ? {} : { tier }), ...(native === undefined ? {} : { native }), ...(consent === undefined ? {} : { consent }) };
  return { choices: Object.keys(choices).length ? choices : undefined };
}

// ---------------------------------------------------------------------------------------------------------------------
// Error bodies
// ---------------------------------------------------------------------------------------------------------------------

/** The relay errors a send answers with a `relay` member: the ones the user can answer by choosing (ADR-055 §9, §12.4). */
const ANSWERABLE = new Set(["RELAY_CHOICE_REQUIRED", "RELAY_CONSENT_REQUIRED", "RELAY_TARGET_UNVERIFIED", "RELAY_UNAVAILABLE", "RELAY_INPUT_LIMIT"]);
const CATALOG_IDENTITY = /^[a-z][a-z0-9-]{0,95}$/u, REASON = /^[a-z][a-z_]{0,63}$/u;
/** The Harness control and vendor key a relay error names itself, when the Runtime says (RelayError.detail); checked, never trusted. */
function namedBy(error: SessionError): { readonly harnessId?: string; readonly controlId?: string; readonly vendor?: string } {
  const detail = (error as { readonly detail?: unknown }).detail;
  if (detail === null || typeof detail !== "object") return {};
  const row = detail as Readonly<Record<string, unknown>>;
  const harnessId = typeof row.harnessId === "string" && CATALOG_IDENTITY.test(row.harnessId) ? row.harnessId : undefined;
  const controlId = typeof row.controlId === "string" && CATALOG_IDENTITY.test(row.controlId) ? row.controlId : undefined;
  let vendor: string | undefined;
  try { vendor = row.vendor === undefined ? undefined : parseVendorKey(row.vendor); } catch { vendor = undefined; }
  return { ...(harnessId !== undefined && controlId !== undefined ? { harnessId, controlId } : {}), ...(vendor === undefined ? {} : { vendor }) };
}
/**
 * What the user may choose after a relay error (relay-architecture §9, §12.1 T2; the user's decision of 2026-11-10 keeps these
 * 409s to what only the user can settle): by the error's code and reason and the binding's state.
 */
export function relayOptions(code: string, reason: string | undefined, binding: NativeSessionBinding | undefined): readonly RelayOption[] {
  switch (code) {
    case "RELAY_CHOICE_REQUIRED": {
      const options: RelayOption[] = ["attach_full", "send_alone", "new_native"];
      // An unconfirmed clear whose check settles nothing can be confirmed by the user (relay-architecture §9).
      const relay = binding?.relay;
      if (reason === "verify_required" && relay !== undefined && relay.sync.kind === "suspect" && relay.sync.cause === "clear_unconfirmed" && relay.sync.floorCandidate !== null && relay.sync.floorCandidate > relay.epochFloor) options.push("clear_confirmed");
      return options;
    }
    case "RELAY_CONSENT_REQUIRED": return ["acknowledge", "send_alone"];
    case "RELAY_UNAVAILABLE": return reason === "recovery_failed" ? ["send_alone", "new_native"] : ["send_alone"];
    case "RELAY_TARGET_UNVERIFIED": case "RELAY_INPUT_LIMIT": return ["send_alone"];
    default: return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the API reads of the Store: the relay rows (a packet's manifest and its stored text included), the preferences it also
 * writes, and the events the ledgers page. Committed rows only; nothing is held between reads.
 */
export interface RelayReads extends Pick<RelayStorePort, "relayDeliveries" | "relayPackets" | "relayPacket" | "relayPacketBody" | "relayIndex">, Pick<RelayLogPort, "relayPrefs" | "setPref"> {
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
}
/** The HTTP helpers of the server this API is mounted on (they live in server.ts). */
export interface RelayHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  headers(response: ServerResponse): void;
  queries(url: URL, allowed: readonly string[]): void;
  body(request: IncomingMessage): Promise<unknown>;
}
/** What `Runtime.relayAttention` says of one binding: whether its Driver's mechanisms are proved (null: the factory cannot tell) and what it asks the user to look at. */
export interface BindingAttention { readonly harnessId: string; readonly controlId: string; readonly probed: boolean | null; readonly attention: RelayAttention | null }
export interface RelayApiOptions {
  readonly reads: RelayReads;
  /** The Session as the Runtime reads it (SESSION_NOT_FOUND for an identity it does not hold). */
  readonly read: (id: SessionId) => SessionSnapshot;
  /** The static relay declaration of the Driver that serves a Harness control; null or undefined when it declares none. */
  readonly declaration: (selection: HarnessSelection) => RelayCapabilities | null | undefined;
  /** What each of a Session's bindings asks the user to look at (the Runtime's `relayAttention`); none when the Runtime is not asked. */
  readonly attention?: (id: SessionId) => readonly BindingAttention[];
  /** Whether the data directory is within reach of the Session's workspace (the Runtime's `relayDataRootExposed`). */
  readonly dataRootExposed?: (id: SessionId) => boolean;
  readonly http: RelayHttp;
}

export function deliveryView(outcome: DeliveryOutcome): RelayDeliveryView { return { state: outcome.kind, evidence: outcome.kind === "recorded" ? outcome.evidence : null }; }
/** The delivery of a packet no row tracks: no evidence of it exists (relay-architecture §4: no evidence is unknown, never not recorded). */
const UNTRACKED: RelayDeliveryView = Object.freeze({ state: "unknown", evidence: null });
/** Whether an If-None-Match header names the tag (weak comparison, RFC 9110 §13.1.2). */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some(part => { const tag = part.trim(); return (tag.startsWith("W/") ? tag.slice(2) : tag) === etag; });
}
const LIST = /^\/api\/v1\/sessions\/([^/]+)\/relay$/u, PACKET = /^\/api\/v1\/sessions\/([^/]+)\/relay\/(relay-[0-9a-hjkmnp-tv-z]{20})$/u;
/** A vendor key that names a service by a fixed word (`openai`); a key with a colon carries a host, a provider id or an unknown Harness. */
const NAMED_VENDOR = /^[a-z][a-z0-9-]{0,31}$/u;
/** The Sessions whose decisions are kept at most (the least recently read go first). */
const DECISION_SESSIONS = 64;

/**
 * Whether a Turn of the Session can have recorded a relay decision: only a conversation that ran on more than one Harness control,
 * carried a packet, kept a request's choices or began from quoted history owes anything to anyone. A conversation that stayed on
 * one control from nothing needs no read of its events at all.
 */
function mayHaveDecisions(snapshot: SessionSnapshot): boolean {
  if ((snapshot.origin?.history.length ?? 0) > 0) return true;
  const controls = new Set<string>();
  for (const run of snapshot.runs) {
    if (run.relay?.packetId != null || run.relayRequest !== undefined) return true;
    const on = run.relay?.executedOn ?? run.selection;
    controls.add(on.harnessId + "\0" + on.controlId);
    if (controls.size > 1) return true;
  }
  return false;
}
/**
 * The relay decision each Run's `run.context_prepared` recorded (`relayDecisionOf`), by Run. Events are append-only, so each
 * Session's are read once, from where the last read stopped; a Session the process has not seen is read from its start. Bounded:
 * the least recently read Sessions are forgotten.
 */
class DecisionLedger {
  private readonly sessions = new Map<SessionId, { after: number; readonly byRun: Map<string, RelayDecision> }>();
  constructor(private readonly events: (id: SessionId, afterSeq: number, limit: number) => readonly SessionEvent[]) {}
  of(state: SessionSnapshot): ReadonlyMap<string, RelayDecision> {
    let known = this.sessions.get(state.id);
    if (known === undefined || known.after > state.lastSeq) known = { after: 0, byRun: new Map() };
    // Used last: moved to the end of the map, which is where the forgetting starts from the other side.
    this.sessions.delete(state.id); this.sessions.set(state.id, known);
    if (this.sessions.size > DECISION_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    while (known.after < state.lastSeq) {
      const page = this.events(state.id, known.after, 100);
      if (!page.length) break;
      for (const item of page) {
        const run = item.data.runId;
        if (item.type !== "run.context_prepared" || typeof run !== "string") continue;
        const decision = relayDecisionOf(item.data);
        if (decision !== null) known.byRun.set(run, decision);
      }
      known.after = page.at(-1)!.seq;
    }
    return known.byRun;
  }
}
/** What a binding is owed now: the Runs a handoff to it would carry, and whether the history the Session started from goes too. */
interface OwedNow { readonly runIds: readonly string[]; readonly origin: boolean }
/** The packet frame and the most a standard handoff holds, in tokens, for an estimate of what is owed (the budget of a target whose window is unknown). */
const FRAME_TOKENS = 300;

/** Mounts the relay's routes and builds its views; one per Gateway. */
export class RelayApi {
  private readonly ledger: RelayLedger;
  private readonly decisions: DecisionLedger;
  /** The `relay` member of the errors a send was answered with, by the error that is answered (see `explain`). */
  private readonly explained = new WeakMap<object, RelayErrorView>();
  constructor(private readonly options: RelayApiOptions) {
    this.ledger = new RelayLedger((id, afterSeq, limit) => options.reads.events(id, afterSeq, limit));
    this.decisions = new DecisionLedger((id, afterSeq, limit) => options.reads.events(id, afterSeq, limit));
  }

  // ---- the Run DTO ---------------------------------------------------------------------------------------------------

  /**
   * The Session's Runs as the API shows them. Each Run that carried a packet gets its delivery state, read from its delivery
   * row, which can change after the Run ended (a later check, a settled resend). A packet sent to a native side the Gateway
   * keeps no binding of (a Driver without a resumable session) has no delivery row to track: nothing is known of it, which
   * is shown as unknown. Each Run the relay decided something for gets that decision (what it did and why: a resend, a send
   * alone, a complete packet again), read from the event that recorded it. A Run's `relayRequest` never leaves: it holds an HMAC
   * of the user's choices. A Session whose Runs carried no relay fact is shown as it is; rows that cannot be read leave out
   * what they would have added (a derived read never fails the conversation).
   */
  runViews(snapshot: SessionSnapshot): readonly WebRun[] {
    if (!snapshot.runs.some(run => run.relay !== undefined || run.relayRequest !== undefined)) return snapshot.runs;
    let rows: ReadonlyMap<string, DeliveryRecord> | null = new Map();
    if (snapshot.runs.some(run => run.relay?.packetId != null)) {
      try { rows = new Map(this.options.reads.relayDeliveries(snapshot.id).map(row => [row.runId as string, row])); }
      catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") rows = null; else throw error; }
    }
    let decisions: ReadonlyMap<string, RelayDecision> = new Map();
    if (mayHaveDecisions(snapshot)) {
      try { decisions = this.decisions.of(snapshot); }
      catch (error) { if (!(error instanceof SessionError && error.code === "INVALID_DATA")) throw error; }
    }
    const shown = snapshot.runs.map(run => {
      const { relayRequest: _hidden, relay, ...rest } = run;
      if (relay === undefined) return run.relayRequest === undefined ? run : rest;
      const row = rows?.get(run.id), decision = decisions.get(run.id);
      const delivery = relay.packetId == null || rows === null ? undefined : row === undefined ? UNTRACKED : deliveryView(row.outcome);
      // A Run that gains nothing is the Run itself.
      if (run.relayRequest === undefined && delivery === undefined && decision === undefined) return run;
      return { ...rest, relay: { ...relay, ...(delivery === undefined ? {} : { delivery }), ...(decision === undefined ? {} : { decision }) } };
    });
    // Nothing added and nothing hidden: the Session's own Runs.
    return shown.every((run, index) => run === snapshot.runs[index]) ? snapshot.runs : shown;
  }
  /** An event as the API shows it: a `message.accepted` keeps no `relayRequest.fingerprint` (an HMAC of the user's choices). */
  publicEvent(event: SessionEvent): SessionEvent {
    const request = event.data.relayRequest;
    if (event.type !== "message.accepted" || request === null || typeof request !== "object" || Array.isArray(request) || !("fingerprint" in request)) return event;
    const { fingerprint: _hidden, ...kept } = request as Readonly<Record<string, unknown>>;
    return { ...event, data: { ...event.data, relayRequest: kept } };
  }

  // ---- GET …/relay ---------------------------------------------------------------------------------------------------

  view(snapshot: SessionSnapshot): RelayView {
    const manifests = new Map(this.options.reads.relayPackets(snapshot.id).map(packet => [packet.id as string, packet]));
    const rows = new Map(this.options.reads.relayDeliveries(snapshot.id).map(row => [row.runId as string, row])), packets: RelayPacketView[] = [];
    // One entry per packet-carrying Run, in Run order: "交接单 #n" is the n-th Run whose `relay.packetId` is not null, whether or not
    // a row tracks its delivery (a packet nothing stored is left out, and its number with it).
    let number = 0;
    const numbers = new Map<string, number>();
    for (let runIndex = 0; runIndex < snapshot.runs.length; runIndex++) {
      const run = snapshot.runs[runIndex]!;
      if (run.relay?.packetId == null) continue;
      number += 1;
      if (!numbers.has(run.relay.packetId)) numbers.set(run.relay.packetId, number);
      const packet = manifests.get(run.relay.packetId);
      if (packet === undefined) continue;
      const row = rows.get(run.id), delivery = row === undefined ? UNTRACKED : deliveryView(row.outcome);
      packets.push({ packetId: packet.id, runId: run.id, runIndex, number, kind: packet.kind, tier: packet.tier, target: { harnessId: packet.target.harnessId, model: packet.target.model },
        estTokens: packet.body.estTokens, omissions: packet.omissions.reduce((sum, item) => sum + item.count, 0), redactions: packet.redaction.count, delivery: delivery.state, evidence: delivery.evidence });
    }
    const attended = this.attended(snapshot.id);
    const bindings = (snapshot.nativeBindings ?? []).flatMap(binding => binding.status === "archived" || binding.relay === undefined ? [] : [this.bindingView(snapshot, binding, binding.relay, attended, numbers)]);
    return { bindings, packets, ...(this.exposed(snapshot.id) ? { dataRootExposed: true as const } : {}) };
  }
  /** What the Runtime says each binding asks the user to look at, by binding; none when it says nothing (or cannot be asked). */
  private attended(id: SessionId): ReadonlyMap<string, BindingAttention> {
    try { return new Map((this.options.attention?.(id) ?? []).map(row => [row.harnessId + "\0" + row.controlId, row])); } catch { return new Map(); }
  }
  private exposed(id: SessionId): boolean { try { return this.options.dataRootExposed?.(id) === true; } catch { return false; } }
  private bindingView(snapshot: SessionSnapshot, binding: NativeSessionBinding, relay: BindingRelayState, attended: ReadonlyMap<string, BindingAttention>, numbers: ReadonlyMap<string, number>): RelayBindingView {
    const mark = markOf(relay.sync);
    let declared: RelayCapabilities | null | undefined;
    try { declared = this.options.declaration({ harnessId: binding.harnessId, controlId: binding.controlId }); } catch { declared = undefined; }
    const known = attended.get(binding.harnessId + "\0" + binding.controlId);
    const probed = known?.probed ?? (declared?.probed === true);
    // The named service the Harness runs on (a fixed word), never a host or a provider id of the user's own.
    const service = relay.vendorObserved == null ? undefined : vendorKeyOf(declared, binding.harnessId, relay.vendorObserved);
    const named = service !== undefined && NAMED_VENDOR.test(service) ? service : undefined;
    const canConfirm = declared === undefined ? undefined : declared !== null && (declared.delivery.live !== "none" || declared.delivery.verify !== "none" || declared.delivery.successProvesRecorded);
    const need = this.owedNow(snapshot, binding);
    const asked = known?.attention ?? null;
    let attention: RelayAttentionView | undefined;
    if (asked !== null) {
      const packet = relay.sync.kind === "pending" ? numbers.get(relay.sync.packetId) : undefined;
      // The vendor an `acknowledge` is for is the one place the relay view names one: the page cannot answer the banner without it.
      const vendor = asked.options.includes("acknowledge") ? vendorKeyOf(declared, binding.harnessId, relay.vendorObserved ?? null) : undefined;
      attention = { cause: asked.cause, options: asked.options, counts: asked.counts, key: asked.key, ...(packet === undefined ? {} : { packet }), ...(vendor === undefined ? {} : { vendor }) };
    }
    // A clear raises the epoch within the native session it cleared; one that replaced the native session (Claude Code's, which gives up the
    // old one) raises none in the new one, and the fresh state it left says it was a clear.
    const clears = Math.max(0, relay.nativeEpoch - heldSince(relay, snapshot.nativeBindings ?? [], binding.harnessId, binding.controlId));
    const cleared = clears === 0 && relay.sync.kind === "fresh" && relay.sync.basis === "user_cleared" ? 1 : clears;
    return { harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.nativeEpoch, sync: relay.sync.kind, throughRun: this.throughRun(snapshot, mark),
      evidence: mark?.evidence ?? null, cleared, probed,
      ...(canConfirm === undefined ? {} : { canConfirm }), ...(named === undefined ? {} : { vendor: named }),
      ...(need === undefined || need.runIds.length === 0 ? {} : { owed: { runs: need.runIds.length, estTokens: this.estimate(snapshot, need) } }),
      ...(attention === undefined ? {} : { attention }) };
  }
  /**
   * The index (in the Session's Runs) of the latest finished Run whose fact the mark covers: a Run's fact is placed by its
   * `run.ended` (RelayLedger), and a mark covers the facts up to its `throughSeq`. None when it covers none (a mark of the
   * history the Session started from, or no mark).
   */
  private throughRun(snapshot: SessionSnapshot, mark: DeliveredMark | null): number | null {
    if (mark === null || mark.throughSeq <= 0) return null;
    let through: number | null = null;
    for (let index = 0; index < snapshot.runs.length; index++) {
      const run = snapshot.runs[index]!;
      if (!terminal(run.status)) continue;
      const seq = this.ledger.endedSeq(snapshot, run.id);
      if (seq !== undefined && seq <= mark.throughSeq) through = index;
    }
    return through;
  }
  /** The Runs (and whether the starting history) a handoff to the binding would carry now; undefined when it cannot be told. */
  private owedNow(snapshot: SessionSnapshot, binding: NativeSessionBinding): OwedNow | undefined {
    const relay = binding.relay;
    if (relay === undefined) return undefined;
    try {
      // The migration's index rows place a v12 Run (where it ran); a Session without migrated Runs needs none of them.
      let index: readonly RelayIndexRow[] = [];
      if (snapshot.runs.some(run => run.relay === undefined && terminal(run.status) && dispatched(run))) index = this.options.reads.relayIndex(snapshot.id);
      const facts = this.ledger.facts(snapshot, index, { harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.nativeEpoch });
      const need = owed(relay, binding.harnessId, binding.controlId, facts, { originHistory: (snapshot.origin?.history.length ?? 0) > 0, heldSince: heldSince(relay, snapshot.nativeBindings ?? [], binding.harnessId, binding.controlId) });
      return { runIds: need.facts.map(fact => fact.runId as string), origin: need.origin };
    } catch { return undefined; }
  }
  /**
   * What the owed Runs would take if they were sent as they stand, in the estimator's tokens: their words and replies, the
   * history the Session started from when it goes too, and the packet's frame, held to what a standard packet of an unknown
   * window may take. It errs high and is not the packet's size; the page says "约".
   */
  private estimate(snapshot: SessionSnapshot, need: OwedNow): number {
    const wanted = new Set(need.runIds);
    let tokens = FRAME_TOKENS;
    for (const message of snapshot.messages) if (wanted.has(message.runId)) tokens += estimateTokens(message.text);
    if (need.origin) for (const turn of snapshot.origin?.history ?? []) tokens += estimateTokens(turn.text);
    return Math.min(resolveRelayBudget(null).cap, tokens);
  }

  // ---- the error body ------------------------------------------------------------------------------------------------

  /**
   * Remembers, for the error a send is about to be answered with, the `relay` member of its body: the binding the input would
   * have run on (the pending switch's target, else the selection, as admission takes it), the closed reason, what the user may
   * choose and what a handoff to that binding is owed. The error itself is left as it is, so the status and message keep their
   * own rules. Never throws: an error that cannot be explained is answered with its code and message alone.
   */
  explain(error: unknown, id: SessionId): void {
    if (!(error instanceof SessionError) || !ANSWERABLE.has(error.code)) return;
    try {
      const snapshot = this.options.read(id), named = namedBy(error);
      const pending = snapshot.pendingSwitchId === null ? undefined : snapshot.switches.find(item => item.id === snapshot.pendingSwitchId);
      const target = pending?.target ?? snapshot.selection;
      const harnessId = named.harnessId ?? target.harnessId, controlId = named.controlId ?? target.controlId;
      const binding = snapshot.nativeBindings?.find(row => row.harnessId === harnessId && row.controlId === controlId && row.status !== "archived");
      const raw = (error as { readonly reason?: unknown }).reason, reason = typeof raw === "string" && REASON.test(raw) ? raw : undefined;
      const counts = error.code === "RELAY_CHOICE_REQUIRED" || error.code === "RELAY_CONSENT_REQUIRED" ? this.counts(snapshot, binding) : undefined;
      this.explained.set(error, { binding: { harnessId, controlId }, ...(reason === undefined ? {} : { cause: reason }), options: relayOptions(error.code, reason, binding),
        ...(counts === undefined ? {} : { counts }), ...(named.vendor === undefined ? {} : { vendor: named.vendor }) });
    } catch { /* The answer keeps its code and message. */ }
  }
  /** The `relay` member to add to the body an error is answered with; none for an error `explain` did not explain. */
  errorBody(error: unknown): { readonly relay?: RelayErrorView } {
    const view = typeof error === "object" && error !== null ? this.explained.get(error) : undefined;
    return view === undefined ? {} : { relay: view };
  }
  /** What the binding is owed now (the Runs a handoff would carry) and how many packets it was sent in its epoch; none when it cannot be told. */
  private counts(snapshot: SessionSnapshot, binding: NativeSessionBinding | undefined): RelayErrorView["counts"] | undefined {
    const relay = binding?.relay;
    if (binding === undefined || relay === undefined) return undefined;
    const need = this.owedNow(snapshot, binding);
    return need === undefined ? undefined : { runs: need.runIds.length, packets: relay.packetsInEpoch };
  }

  // ---- routes --------------------------------------------------------------------------------------------------------

  /**
   * Answers the relay's routes: `GET …/relay`, `GET|HEAD …/relay/:packetId` and `GET|PUT /api/v1/relay/prefs`. Called after the
   * server's own checks (Host, Origin, login, and for a write the CSRF token); false for any other request.
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const { http } = this.options, path = url.pathname;
    if (path === "/api/v1/relay/prefs") {
      if (method === "GET") { http.queries(url, []); http.json(response, 200, this.prefs()); return true; }
      if (method === "PUT") {
        http.queries(url, []);
        const input = plain(await http.body(request), "the request");
        if (Object.keys(input).some(key => key !== "key" && key !== "value") || !("key" in input) || !("value" in input)) invalid("a preference is written as a key and a value");
        const key = oneOf(input.key, RELAY_PREF_KEYS, "the preference key"), value = oneOf(input.value, RELAY_PREF_VALUES[key], "the preference value");
        this.options.reads.setPref(key, value);
        http.json(response, 200, this.prefs()); return true;
      }
      return false;
    }
    const listed = LIST.exec(path);
    if (listed !== null && method === "GET") { http.queries(url, []); http.json(response, 200, this.view(this.options.read(sessionId(listed[1]!)))); return true; }
    const packet = PACKET.exec(path);
    if (packet !== null && (method === "GET" || method === "HEAD")) { http.queries(url, []); this.packet(request, response, method, sessionId(packet[1]!), packet[2]!); return true; }
    return false;
  }
  /** Every preference with its value: the one the user set, else its default (RELAY_PREF_DEFAULTS), so the page never guesses one. */
  private prefs(): RelayPrefsView {
    const stored = this.options.reads.relayPrefs();
    return { prefs: Object.fromEntries(RELAY_PREF_KEYS.map(key => [key, stored[key] ?? RELAY_PREF_DEFAULTS[key]])) as Record<RelayPrefKey, string> };
  }
  /**
   * A packet's stored text, byte for byte as it was sent (relay-architecture §10.2: not scanned again on the way out),
   * with the sha256 of those bytes as its ETag. The Session's own packets only: another Session's identity, or none, is the
   * same not-found, so the answer says nothing of whether it exists elsewhere.
   */
  private packet(request: IncomingMessage, response: ServerResponse, method: string, id: SessionId, packetId: string): void {
    this.options.read(id);
    const manifest = this.options.reads.relayPacket(id, packetId);
    if (manifest === null) throw new SessionError("RELAY_PACKET_NOT_FOUND", "this conversation has no such handoff packet");
    const text = this.options.reads.relayPacketBody(id, manifest.body.sha256);
    if (text === null) throw new SessionError("INVALID_DATA", "a handoff packet is kept without its text");
    const bytes = Buffer.from(text, "utf8"), digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== manifest.body.sha256 || bytes.length !== manifest.body.bytes) throw new SessionError("INVALID_DATA", "a stored handoff text does not match its manifest");
    if (response.destroyed || response.writableEnded) return;
    const etag = "\"" + digest + "\"";
    this.options.http.headers(response);
    // The text never changes (its identity derives from it), but it holds the conversation: revalidated, never shared.
    response.setHeader("Cache-Control", "private, no-cache"); response.setHeader("ETag", etag);
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    if (matches(request.headers["if-none-match"], etag)) { response.statusCode = 304; response.end(); return; }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.setHeader("Content-Length", bytes.length);
    response.end(method === "HEAD" ? undefined : bytes);
  }
}
