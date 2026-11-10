import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayLedger } from "../contexts/session/application/relay-coordinator.js";
import type { RelayChoice } from "../contexts/session/application/runtime.js";
import { dispatched } from "../contexts/session/domain/relay/advance.js";
import { heldSince, owed } from "../contexts/session/domain/relay/delivery.js";
import { terminal } from "../contexts/session/domain/state.js";
import {
  ATTACH_CHOICES, NATIVE_CHOICES, RELAY_PREF_KEYS, RELAY_PREF_VALUES, TIERS, markOf, parseVendorKey,
  type BindingRelayState, type DeliveredMark, type DeliveryOutcome, type DeliveryRecord, type RelayCapabilities, type RelayIndexRow, type RelayLogPort, type RelayStorePort, type Tier, type VendorKey,
} from "../contracts/relay.js";
import { SessionError, sessionId, type HarnessSelection, type NativeSessionBinding, type SessionEvent, type SessionId, type SessionSnapshot } from "../contracts/session.js";
import type { RelayBindingView, RelayDeliveryView, RelayErrorView, RelayOption, RelayPacketView, RelayPrefsView, RelayView, WebRun } from "../contracts/web.js";

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
export interface RequestedConsent { readonly vendor: VendorKey; readonly decision: "acknowledged" | "goal_only"; readonly scope: "session" | "global" }
function consentOf(value: unknown): RequestedConsent {
  const row = plain(value, "relay.consent");
  if (Object.keys(row).some(key => key !== "vendor" && key !== "decision" && key !== "scope") || !("vendor" in row) || !("decision" in row) || !("scope" in row)) invalid("relay.consent names a vendor, a decision and a scope");
  let vendor: VendorKey;
  try { vendor = parseVendorKey(row.vendor); } catch { return invalid("relay.consent.vendor must be a vendor key"); }
  return { vendor, decision: oneOf(row.decision, ["acknowledged", "goal_only"] as const, "relay.consent.decision"), scope: oneOf(row.scope, ["session", "global"] as const, "relay.consent.scope") };
}
/**
 * Fields of the request's `relay` member that are checked here and not yet acted on: the Runtime takes them in G072 (the
 * target's tier, a new native session, a note for the packet, a consent to record). Until then a request that carries them is
 * accepted and they change nothing.
 */
export interface DeferredRelayChoices {
  readonly tier?: Tier;
  readonly native?: "continue" | "new";
  readonly note?: string;
  readonly consent?: RequestedConsent;
}
export interface SendRelay {
  /** What the Runtime acts on today, `runtime.send`'s fifth argument (which also puts it in the command's fingerprint); undefined when the request made no choice. */
  readonly choices: RelayChoice | undefined;
  readonly deferred: DeferredRelayChoices;
}
/**
 * The `relay` member of `POST …/messages`, checked field by field: an object of only the known fields, each with one of its
 * values (INVALID_INPUT, an HTTP 400, for anything else, with a fixed text that quotes nothing of the request). `attach:
 * "auto"` is no choice. An input sent alone (`attach: "none"`) carries no other choice, as the Runtime holds it.
 *
 * RELAY_REQUEST_SEAM: the merge with G072 (the Runtime taking `tier`, `native`, `consent`) changes only `toRuntime` below,
 * the one place that decides what the Runtime is handed.
 */
export function parseSendRelay(value: unknown): SendRelay {
  if (value === undefined) return { choices: undefined, deferred: {} };
  const item = plain(value, "relay");
  if (Object.keys(item).some(key => !(SEND_FIELDS as readonly string[]).includes(key))) invalid("relay has a field this Gateway does not know");
  const attach = item.attach === undefined ? undefined : oneOf(item.attach, ATTACH_CHOICES, "relay.attach");
  const resend = onlyTrue(item.resend, "relay.resend"), clearConfirmed = onlyTrue(item.clearConfirmed, "relay.clearConfirmed");
  const native = item.native === undefined ? undefined : oneOf(item.native, NATIVE_CHOICES, "relay.native");
  const tier = item.tier === undefined ? undefined : oneOf(item.tier, TIERS, "relay.tier");
  const note = item.note === undefined ? undefined : noteText(item.note);
  const consent = item.consent === undefined ? undefined : consentOf(item.consent);
  if (attach === "none" && (resend === true || clearConfirmed === true || native === "new" || consent !== undefined)) invalid("an input sent alone carries no other relay choice");
  return toRuntime({ attach, resend, clearConfirmed }, { tier, native, note, consent });
}
/** The choices the Runtime acts on today (RELAY_REQUEST_SEAM), and the ones it is not yet handed. */
function toRuntime(acted: { readonly attach: typeof ATTACH_CHOICES[number] | undefined; readonly resend: true | undefined; readonly clearConfirmed: true | undefined },
    later: { readonly tier: Tier | undefined; readonly native: "continue" | "new" | undefined; readonly note: string | undefined; readonly consent: RequestedConsent | undefined }): SendRelay {
  const choices: { attach?: "full" | "none"; resend?: true; clearConfirmed?: true } = {
    ...(acted.attach === "full" || acted.attach === "none" ? { attach: acted.attach } : {}), ...(acted.resend === true ? { resend: true as const } : {}),
    ...(acted.clearConfirmed === true ? { clearConfirmed: true as const } : {}) };
  return { choices: Object.keys(choices).length ? choices : undefined,
    deferred: { ...(later.tier === undefined ? {} : { tier: later.tier }), ...(later.native === undefined ? {} : { native: later.native }),
      ...(later.note === undefined ? {} : { note: later.note }), ...(later.consent === undefined ? {} : { consent: later.consent }) } };
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

/** What the API reads of the Store: the relay rows, the preferences it also writes, and the events the ledger pages. */
export interface RelayReads extends Pick<RelayStorePort, "relayDeliveries" | "relayPackets" | "relayIndex">, Pick<RelayLogPort, "relayPrefs" | "setPref"> {
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
}
/**
 * A stored packet text, read through a read-only connection of its own to the business database. The Store keeps no read of
 * `relay_bodies` yet (it is not in RelayStorePort), so this is the interim; it reads committed rows only and holds nothing
 * between reads. A Store method `relayPacketBody(id, bodySha256)` replaces it (and this class goes) when the Store gets one.
 */
export class PacketBodies {
  private readonly path: string;
  constructor(root: string) { this.path = join(resolve(root), "gateway.sqlite"); }
  /** The text kept for `bodySha256` in the Session, or null when none is kept. */
  read(session: SessionId, bodySha256: string): string | null {
    const database = new DatabaseSync(this.path, { readOnly: true, timeout: 2000, allowExtension: false });
    try {
      const row = database.prepare("SELECT body FROM relay_bodies WHERE session_id=? AND sha256=?").get(session, bodySha256);
      if (row === undefined) return null;
      if (typeof row.body !== "string") throw new SessionError("INVALID_DATA", "a stored handoff text is not text");
      return row.body;
    } finally { database.close(); }
  }
}
/** The HTTP helpers of the server this API is mounted on (they live in server.ts). */
export interface RelayHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  headers(response: ServerResponse): void;
  queries(url: URL, allowed: readonly string[]): void;
  body(request: IncomingMessage): Promise<unknown>;
}
export interface RelayApiOptions {
  readonly reads: RelayReads;
  readonly bodies: Pick<PacketBodies, "read">;
  /** The Session as the Runtime reads it (SESSION_NOT_FOUND for an identity it does not hold). */
  readonly read: (id: SessionId) => SessionSnapshot;
  /** The static relay declaration of the Driver that serves a Harness control; null or undefined when it declares none. */
  readonly declaration: (selection: HarnessSelection) => RelayCapabilities | null | undefined;
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

/** Mounts the relay's routes and builds its views; one per Gateway. */
export class RelayApi {
  private readonly ledger: RelayLedger;
  /** The `relay` member of the errors a send was answered with, by the error that is answered (see `explain`). */
  private readonly explained = new WeakMap<object, RelayErrorView>();
  constructor(private readonly options: RelayApiOptions) { this.ledger = new RelayLedger((id, afterSeq, limit) => options.reads.events(id, afterSeq, limit)); }

  // ---- the Run DTO ---------------------------------------------------------------------------------------------------

  /**
   * The Session's Runs as the API shows them: each Run that carried a packet gets its delivery state, read from its delivery
   * row, which can change after the Run ended (a later check, a settled resend). A packet sent to a native side the Gateway
   * keeps no binding of (a Driver without a resumable session) has no delivery row to track: nothing is known of it, which
   * is shown as unknown. A Session whose Runs carried no packet reads no row; rows that cannot be read leave the Runs as the
   * Session holds them (a derived read never fails the conversation).
   */
  runViews(snapshot: SessionSnapshot): readonly WebRun[] {
    if (!snapshot.runs.some(run => run.relay?.packetId != null)) return snapshot.runs;
    let rows: ReadonlyMap<string, DeliveryRecord>;
    try { rows = new Map(this.options.reads.relayDeliveries(snapshot.id).map(row => [row.runId as string, row])); }
    catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") return snapshot.runs; throw error; }
    return snapshot.runs.map(run => {
      if (run.relay?.packetId == null) return run;
      const row = rows.get(run.id);
      return { ...run, relay: { ...run.relay, delivery: row === undefined ? UNTRACKED : deliveryView(row.outcome) } };
    });
  }

  // ---- GET …/relay ---------------------------------------------------------------------------------------------------

  view(snapshot: SessionSnapshot): RelayView {
    const manifests = new Map(this.options.reads.relayPackets(snapshot.id).map(packet => [packet.id as string, packet]));
    const bindings = (snapshot.nativeBindings ?? []).flatMap(binding => binding.status === "archived" || binding.relay === undefined ? [] : [this.bindingView(snapshot, binding, binding.relay)]);
    const rows = new Map(this.options.reads.relayDeliveries(snapshot.id).map(row => [row.runId as string, row])), packets: RelayPacketView[] = [];
    // One entry per packet-carrying Run, in Run order: "交接单 #n" is the n-th Run whose `relay.packetId` is not null, whether or not
    // a row tracks its delivery (a packet nothing stored is left out, and its number with it).
    let number = 0;
    for (let runIndex = 0; runIndex < snapshot.runs.length; runIndex++) {
      const run = snapshot.runs[runIndex]!;
      if (run.relay?.packetId == null) continue;
      number += 1;
      const packet = manifests.get(run.relay.packetId);
      if (packet === undefined) continue;
      const row = rows.get(run.id), delivery = row === undefined ? UNTRACKED : deliveryView(row.outcome);
      packets.push({ packetId: packet.id, runId: run.id, runIndex, number, kind: packet.kind, tier: packet.tier, target: { harnessId: packet.target.harnessId, model: packet.target.model },
        estTokens: packet.body.estTokens, omissions: packet.omissions.reduce((sum, item) => sum + item.count, 0), redactions: packet.redaction.count, delivery: delivery.state, evidence: delivery.evidence });
    }
    return { bindings, packets };
  }
  private bindingView(snapshot: SessionSnapshot, binding: NativeSessionBinding, relay: BindingRelayState): RelayBindingView {
    const mark = markOf(relay.sync);
    let declared: RelayCapabilities | null | undefined;
    try { declared = this.options.declaration({ harnessId: binding.harnessId, controlId: binding.controlId }); } catch { declared = undefined; }
    return { harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.nativeEpoch, sync: relay.sync.kind, throughRun: this.throughRun(snapshot, mark),
      evidence: mark?.evidence ?? null, cleared: Math.max(0, relay.nativeEpoch - heldSince(relay, snapshot.nativeBindings ?? [], binding.harnessId, binding.controlId)), probed: declared?.probed === true };
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
    try {
      // The migration's index rows place a v12 Run (where it ran); a Session without migrated Runs needs none of them.
      let index: readonly RelayIndexRow[] = [];
      if (snapshot.runs.some(run => run.relay === undefined && terminal(run.status) && dispatched(run))) index = this.options.reads.relayIndex(snapshot.id);
      const facts = this.ledger.facts(snapshot, index, { harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.nativeEpoch });
      const need = owed(relay, binding.harnessId, binding.controlId, facts, { originHistory: (snapshot.origin?.history.length ?? 0) > 0, heldSince: heldSince(relay, snapshot.nativeBindings ?? [], binding.harnessId, binding.controlId) });
      return { runs: need.facts.length, packets: relay.packetsInEpoch };
    } catch { return undefined; }
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
  private prefs(): RelayPrefsView { return { prefs: this.options.reads.relayPrefs() }; }
  /**
   * A packet's stored text, byte for byte as it was sent (relay-architecture §10.2: not scanned again on the way out),
   * with the sha256 of those bytes as its ETag. The Session's own packets only: another Session's identity, or none, is the
   * same not-found, so the answer says nothing of whether it exists elsewhere.
   */
  private packet(request: IncomingMessage, response: ServerResponse, method: string, id: SessionId, packetId: string): void {
    this.options.read(id);
    const manifest = this.options.reads.relayPackets(id).find(row => row.id === packetId);
    if (manifest === undefined) throw new SessionError("RELAY_PACKET_NOT_FOUND", "this conversation has no such handoff packet");
    const text = this.options.bodies.read(id, manifest.body.sha256);
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
