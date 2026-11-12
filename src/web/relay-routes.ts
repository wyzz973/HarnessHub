import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RelayLedger } from "../contexts/session/application/relay-coordinator.js";
import type { RelayChoice } from "../contexts/session/application/runtime.js";
import type { Conversation, ConversationReader } from "../contracts/conversation.js";
import { turnSource } from "../contexts/session/domain/turn-source.js";
import { dispatched } from "../contexts/session/domain/relay/advance.js";
import { estimateTokens, resolveRelayBudget } from "../contexts/session/domain/relay/budget.js";
import { owed } from "../contexts/session/domain/relay/delivery.js";
import { terminal } from "../contexts/session/domain/state.js";
import {
  ATTACH_CHOICES, RELAY_PREF_DEFAULTS, RELAY_PREF_KEYS, RELAY_PREF_VALUES,
  type BindingRelayState, type DeliveryEvidence, type DeliveryOutcome, type DeliveryRecord, type RelayAttention, type RelayCapabilities, type RelayInstallationNotice, type RelayLogPort, type RelayPacket, type RelayPrefKey, type RelayStorePort,
} from "../contracts/relay.js";
import { SessionError, sessionId, type HarnessSelection, type NativeSessionBinding, type SessionEvent, type SessionId } from "../contracts/session.js";
import { SYNC_KINDS, type RelayAttentionView, type RelayBindingView, type RelayDeliveryView, type RelayPacketView, type RelayPrefsView, type RelayView } from "../contracts/web.js";

/**
 * The relay's HTTP API (ADR-055 §12.4, G073's server side): the choices a send makes, the error bodies the user can answer,
 * the read model of a Session's bindings and packets, a packet's stored text, and the installation's preferences (the delivery state a
 * Run carries is read by `RunRelayReader`, run-relay.ts). Everything is derived from committed rows and the Session's own facts; nothing here
 * decides anything about delivery (the Runtime does) and nothing reaches a Harness.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The relay member of a send request
// ---------------------------------------------------------------------------------------------------------------------

const SEND_FIELDS = ["attach"] as const;
function invalid(message: string): never { throw new SessionError("INVALID_INPUT", message); }
function plain(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label + " must be an object");
  return value as Readonly<Record<string, unknown>>;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) invalid(label + " is not one of its values");
  return value as T;
}
export interface SendRelay {
  /** What the Runtime is handed: `runtime.send`'s fifth argument, which also puts the choice in the command's fingerprint. Undefined when the request made no choice. */
  readonly choices: RelayChoice | undefined;
}
/**
 * The `relay` member of `POST …/messages`, checked field by field: an object of only the known field (`attach`), with one of its
 * values (INVALID_INPUT, an HTTP 400, for anything else, with a fixed text that quotes nothing of the request). `attach: "auto"` is no choice.
 */
export function parseSendRelay(value: unknown): SendRelay {
  if (value === undefined) return { choices: undefined };
  const item = plain(value, "relay");
  if (Object.keys(item).some(key => !(SEND_FIELDS as readonly string[]).includes(key))) invalid("relay has a field this Gateway does not know");
  const attach = item.attach === undefined ? undefined : oneOf(item.attach, ATTACH_CHOICES, "relay.attach");
  return { choices: attach === "full" || attach === "none" ? { attach } : undefined };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the API reads of the Store: the relay rows (a packet's manifest and its stored text included), the preferences it also
 * writes, the conversation's rows (the light rows of its Runs, its head, and the Turns of the Runs a binding is owed, one at a time), and
 * the events the decision ledger pages. Committed rows only; nothing is held between reads.
 */
export interface RelayReads extends Pick<RelayStorePort, "relayDeliveries" | "relayPackets" | "relayPacket" | "relayPacketBody">, Pick<RelayLogPort, "relayPrefs" | "setPref" | "handoffs" | "handoffUsed">,
  Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory"> {
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
  /** The conversation as the Runtime holds it: its head and the light rows of its Runs (`ConversationStore.get`). */
  get(id: SessionId): Conversation;
}
/** The HTTP helpers of the server this API is mounted on (they live in server.ts). */
export interface RelayHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  headers(response: ServerResponse): void;
  queries(url: URL, allowed: readonly string[]): void;
  body(request: IncomingMessage): Promise<unknown>;
}
/** What `Runtime.relayAttention` says of one binding: what it asks the user to look at. */
export interface BindingAttention { readonly harnessId: string; readonly controlId: string; readonly attention: RelayAttention | null }
export interface RelayApiOptions {
  readonly reads: RelayReads;
  /** The static relay declaration of the Driver that serves a Harness control; null or undefined when it declares none. */
  readonly declaration: (selection: HarnessSelection) => RelayCapabilities | null | undefined;
  /** What each of a Session's bindings asks the user to look at (the Runtime's `relayAttention`); none when the Runtime is not asked. */
  readonly attention?: (id: SessionId) => readonly BindingAttention[];
  /** What the installation as a whole cannot do for the relay while it stays so (the Runtime's `relayInstallation`). */
  readonly installation?: () => readonly RelayInstallationNotice[];
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

/** What a binding is owed now: the Runs a handoff to it would carry, and whether the history the Session started from goes too. */
interface OwedNow { readonly runIds: readonly string[]; readonly origin: boolean }
/** The packet frame and the most a standard handoff holds, in tokens, for an estimate of what is owed (the budget of a target whose window is unknown). */
const FRAME_TOKENS = 300;

/** Mounts the relay's routes and builds its views; one per Gateway. */
export class RelayApi {
  private readonly ledger = new RelayLedger();
  constructor(private readonly options: RelayApiOptions) {}
  /** Whether the Session exists (SESSION_NOT_FOUND for an identity the store does not hold, and for a conversation that was deleted). */
  private exists(id: SessionId): void { this.options.reads.get(id); }

  /** An event as the API shows it: a `message.accepted` keeps no `relayRequest.fingerprint` (an HMAC of the user's choices). */
  publicEvent(event: SessionEvent): SessionEvent {
    const request = event.data.relayRequest;
    if (event.type !== "message.accepted" || request === null || typeof request !== "object" || Array.isArray(request) || !("fingerprint" in request)) return event;
    const { fingerprint: _hidden, ...kept } = request as Readonly<Record<string, unknown>>;
    return { ...event, data: { ...event.data, relayRequest: kept } };
  }

  // ---- GET …/relay ---------------------------------------------------------------------------------------------------

  /** The view of a Session: its rows tell it. */
  view(sessionIdentity: SessionId): RelayView {
    const state = this.options.reads.get(sessionIdentity), id = state.id;
    const manifests = new Map(this.options.reads.relayPackets(id).map(packet => [packet.id as string, packet]));
    const rows = new Map(this.options.reads.relayDeliveries(id).map(row => [row.runId as string, row])), packets: RelayPacketView[] = [];
    // One entry per packet-carrying Run, in Run order: "交接单 #n" is the n-th Run whose `relay.packetId` is not null, whether or not
    // a row tracks its delivery (a packet nothing stored is left out, and its number with it).
    let number = 0;
    const numbers = new Map<string, number>();
    for (let runIndex = 0; runIndex < state.runs.length; runIndex++) {
      const run = state.runs[runIndex]!;
      if (run.relay?.packetId == null) continue;
      number += 1;
      if (!numbers.has(run.relay.packetId)) numbers.set(run.relay.packetId, number);
      const packet = manifests.get(run.relay.packetId);
      if (packet === undefined) continue;
      const row = rows.get(run.id), delivery = row === undefined ? UNTRACKED : deliveryView(row.outcome);
      packets.push({ packetId: packet.id, runId: run.id, runIndex, number, kind: packet.kind, tier: packet.tier, target: { harnessId: packet.target.harnessId, model: packet.target.model },
        estTokens: packet.body.estTokens, omissions: packet.omissions.reduce((sum, item) => sum + item.count, 0), redactions: packet.redactions, delivery: delivery.state, evidence: delivery.evidence });
    }
    const attended = this.attended(id);
    const bindings = (state.nativeBindings ?? []).flatMap(binding => binding.status === "archived" || binding.relay === undefined ? [] : [this.bindingView(state, binding, binding.relay, attended, numbers, rows, manifests)]);
    const installation = this.installation();
    return { bindings, packets, handedOver: this.handedOver(), ...(installation.length ? { installation } : {}) };
  }
  /**
   * The Harnesses the installation has handed a conversation to: its handoff log's rows that a delivery rests on (a row written for a
   * handoff that then failed before it went is not one). A read that fails says none, so the explanation is told again, never left out.
   */
  private handedOver(): readonly string[] {
    try { return this.options.reads.handoffs().filter(row => this.options.reads.handoffUsed(row.logSeq)).map(row => row.harnessId); } catch { return []; }
  }
  /** What the installation as a whole cannot do for the relay (the Runtime's `relayInstallation`); a read that fails says nothing. */
  private installation(): readonly RelayInstallationNotice[] {
    try { return (this.options.installation?.() ?? []).map(notice => ({ cause: notice.cause, ...(notice.detail === undefined ? {} : { detail: notice.detail.slice(0, 200) }) })); } catch { return []; }
  }
  /** What the Runtime says each binding asks the user to look at, by binding; none when it says nothing (or cannot be asked). */
  private attended(id: SessionId): ReadonlyMap<string, BindingAttention> {
    try { return new Map((this.options.attention?.(id) ?? []).map(row => [row.harnessId + "\0" + row.controlId, row])); } catch { return new Map(); }
  }
  private bindingView(state: Conversation, binding: NativeSessionBinding, relay: BindingRelayState, attended: ReadonlyMap<string, BindingAttention>, numbers: ReadonlyMap<string, number>,
      rows: ReadonlyMap<string, DeliveryRecord>, manifests: ReadonlyMap<string, RelayPacket>): RelayBindingView {
    let declared: RelayCapabilities | null | undefined;
    try { declared = this.options.declaration({ harnessId: binding.harnessId, controlId: binding.controlId }); } catch { declared = undefined; }
    const known = attended.get(binding.harnessId + "\0" + binding.controlId);
    const canConfirm = declared === undefined ? undefined : declared !== null && (declared.delivery.live !== "none" || declared.delivery.successProvesRecorded);
    const need = this.owedNow(state, binding);
    const asked = known?.attention ?? null;
    let attention: RelayAttentionView | undefined;
    if (asked !== null) {
      const packet = relay.pending === null ? undefined : numbers.get(relay.pending.packetId);
      attention = { cause: asked.cause, options: asked.options, counts: asked.counts, key: asked.key, ...(packet === undefined ? {} : { packet }) };
    }
    // The native session holds a part of the conversation once a packet was recorded on it or it ran a Turn of its own while nothing was owed (its mark).
    const sync = relay.pending !== null ? "pending" : relay.mark >= 0 ? "synced" : "fresh";
    // What its latest recorded packet was decided by.
    let evidence: DeliveryEvidence | null = null;
    for (const [runId, row] of rows) {
      const packet = manifests.get(row.packetId);
      if (row.outcome.kind === "recorded" && packet !== undefined && packet.target.harnessId === binding.harnessId && packet.target.controlId === binding.controlId && packet.target.nativeEpoch === relay.epoch && runId !== "") evidence = row.outcome.evidence;
    }
    return { harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.epoch, sync: SYNC_KINDS.find(kind => kind === sync)!, throughRun: this.throughRun(state, relay.mark),
      evidence, cleared: relay.floor >= 1 ? 1 : 0,
      ...(canConfirm === undefined ? {} : { canConfirm }),
      ...(need === undefined || need.runIds.length === 0 && !need.origin ? {} : { owed: { runs: this.owedRuns(state, need), estTokens: this.estimate(state, need) } }),
      ...(attention === undefined ? {} : { attention }) };
  }
  /**
   * The index (in the Session's Runs) of the latest finished Run whose fact the mark covers: a Run's fact is placed by the seq of the event that ended it
   * (its row's `endedSeq`), and a mark covers the facts up to it. None when it covers none (a mark of the history the Session
   * started from, or no mark), and a Run whose end no event placed is covered by no mark.
   */
  private throughRun(state: Conversation, mark: number): number | null {
    if (mark <= 0) return null;
    let through: number | null = null;
    for (let index = 0; index < state.runs.length; index++) {
      const run = state.runs[index]!;
      if (!terminal(run.status)) continue;
      if (run.endedSeq !== undefined && run.endedSeq <= mark) through = index;
    }
    return through;
  }
  /** How many messages of the history the Session started from there are, and how many of them are the user's: its rows. */
  private origin(state: Conversation): { readonly messages: readonly { readonly role: string; readonly text: string }[] } {
    return { messages: state.origin === undefined ? [] : this.options.reads.originHistory?.(state.id).map(row => row.message) ?? [] };
  }
  /** The Runs (and whether the starting history) a handoff to the binding would carry now; undefined when it cannot be told. */
  private owedNow(state: Conversation, binding: NativeSessionBinding): OwedNow | undefined {
    const relay = binding.relay;
    if (relay === undefined) return undefined;
    try {
      const facts = this.ledger.facts(state, { harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.epoch });
      const need = owed(relay, binding.harnessId, binding.controlId, facts, { originHistory: this.origin(state).messages.length > 0 });
      return { runIds: need.facts.map(fact => fact.runId as string), origin: need.origin };
    } catch { return undefined; }
  }
  /**
   * What the owed Runs would take if they were sent as they stand, in the estimator's tokens: their words and replies (read from the Turns
   * the binding is owed, one at a time), the history the Session started from when it goes too, and the packet's frame, held to what a
   * standard packet of an unknown window may take. It errs high and is not the packet's size; the page says "约".
   */
  private estimate(state: Conversation, need: OwedNow): number {
    const turns = turnSource(this.options.reads, state.id), position = new Map(state.runs.map((run, index) => [run.id as string, index]));
    let tokens = FRAME_TOKENS;
    for (const runId of need.runIds) {
      const turn = turns.turn(position.get(runId) ?? -1);
      if (turn !== null) tokens += estimateTokens(turn.user.text) + (turn.assistant === undefined ? 0 : estimateTokens(turn.assistant.text));
    }
    if (need.origin) for (const message of this.origin(state).messages) tokens += estimateTokens(message.text);
    return Math.min(resolveRelayBudget(null).cap, tokens);
  }
  /**
   * How many Turns a handoff to the binding would carry: the finished Runs it owes, and the Turns of the history the Session started
   * from when that goes too (a branch's quoted history counts, as the Runtime's attention counts it).
   */
  private owedRuns(state: Conversation, need: OwedNow): number {
    return need.runIds.length + (need.origin ? Math.max(1, this.origin(state).messages.filter(row => row.role === "user").length) : 0);
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
    if (listed !== null && method === "GET") { http.queries(url, []); const id = sessionId(listed[1]!); this.exists(id); http.json(response, 200, this.view(id)); return true; }
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
    this.exists(id);
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
