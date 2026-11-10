import { createHash, createHmac, randomBytes } from "node:crypto";
import { MAX_VERIFY_MARKERS, type CommandClass, type ContextEffect, type VerifyRequest } from "../../../contracts/control.js";
import type { ContentKind } from "../../../contracts/content.js";
import {
  EPHEMERAL_KEY_ID, MARKER_RESULTS, RELAY_MAX_RUNS, RELAY_MAX_SEQ, RELAY_PREF_DEFAULTS, RelayError, TIERS, fingerprint, hmacDigest, markOf, parseDeliveredMark, parseExecutedOn, parseVendorKey, redactionTag, relayPacketId,
  DEFAULT_ALLOW_PREFIX, defaultAllowCommand,
  type BindingRelayState, type ConsentAppend, type ConsentRecord, type ContinuityLevel, type DeliveredMark, type DeliveryPosition, type DeliveryRecord, type EndpointLayer, type ExecutedOn, type Fingerprint, type HmacDigest, type MarkerResult,
  type RedactionTag, type RelayAttention, type RelayCapabilities, type RelayDecision, type RelayDeliveryWrite, type RelayIndexRow, type RelayKeyPort, type RelayPacket, type RelayPacketId, type RelayPrefKey, type RelayWindow, type RunRelay,
  type RunRelayRequest, type SourceRange, type Tier, type VendorKey, type VendorObservation, type VerifyResult,
} from "../../../contracts/relay.js";
import { SessionError, type EventDraft, type HarnessSelection, type NativeSessionBinding, type PublicRun, type RunId, type SessionEvent, type SessionId, type SessionSnapshot } from "../../../contracts/session.js";
import { commandOutcome, dispatched, type InputOutcome } from "../domain/relay/advance.js";
import { estimateTokens } from "../domain/relay/budget.js";
import {
  admitsWithoutChoice, commandTurnEvent, foreignTo, heldSince, owed, pendingResend, retreatedPrior, settledOutcome, settledWithoutCheck, step,
  type BindingDelivery, type ChoiceCause, type DeliveryChange, type Owed, type RelayAt, type RelayEvent, type RelayFact, type RelayStep, type ResendPlan, type StepNote, type VerifyPlan,
} from "../domain/relay/delivery.js";
import type { RelayRecord } from "../domain/relay/packet.js";
import { initialBindingRelay } from "../domain/relay/migrate.js";
import { fitsMinPacket, hardCap, packetFamily, resolveWindow, type ResolvedWindow } from "../domain/relay/windows.js";
import { terminal } from "../domain/state.js";

/**
 * The relay coordinator (ADR-055 §3.2, §6.1, §7; G068 phase two): what the Runtime asks of the relay at each point of a
 * Turn, kept out of runtime.ts so that it only calls these hooks. It wires the v13 delivery state machine
 * (domain/relay/delivery.ts) into the Turn: the facts a binding owes and the delivery rows a check reads (the read path);
 * admission's synchronous choice (`admitRelay`, 409 before any Run exists); the open's check, the choice between sending the
 * input as typed, alone or with a packet, and the rows written with `run.context_prepared` and `run.authorized`
 * (`checkAtOpen`, `decideTurn`, `packetRows`); E1 (`recordedStep`); and the settlement written with `run.ended`
 * (`settleTurn`). Every function here is synchronous and pure over what it is given, except the ledger, which pages
 * the Session's events through the reader it was built with; the Runtime does the I/O (the Driver's check, the store) and
 * commits.
 *
 * G072 adds the gates of an input that carries another Harness's history (relayAdmission, admitCarrying): the probe gate (D11),
 * the data root of a cross-vendor handoff (INV-36), consent by the target's vendor key (§10.4, INV-33: consentStanding,
 * consentGate) and the smallest packet on the target's window (windows.ts); the request's relay options (parseRelayChoices,
 * runRelayRequest) and the decision for a pending binding owed nothing (A7 point 4). Their reads (preferences, consents,
 * windows, the data root) are the Runtime's, given here as values; nothing in this file does I/O (A15).
 *
 * The permissive defaults (the owner's decision of 2026-11-10, docs/proposals/relay/permissive-defaults.md): the strict design's
 * gates and questions are settings now (RelaySettings, `relay_prefs`), off by default. Three rules govern what replaces them:
 * a matter of the packet alone never stops the message (the input goes alone and the Run says so: `TurnDecision.alone` by
 * "policy", `RelayDecision` in `run.context_prepared`); the policy does only three things on its own — send alone, send a
 * pending packet again (once per packet, and again for newer facts), send the complete packet again from the epoch base — and
 * never raises a mark, a floor or an epoch; what the user chose herself (`explicitChoice`) is not rewritten. Without a setting
 * given — the functions' own default — every check is the strict design's, so the strict cases are the defaults' control (P9).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------------

/** A Driver's relay declaration as the coordinator reads it; the most conservative value wherever a Driver declares none (INV-16). */
export interface RelayDeclaration {
  /** Whether the Driver declares anything at all. */
  readonly declared: boolean;
  readonly probed: boolean;
  readonly verify: "after_turn" | "on_next_open" | "none";
  readonly successProvesRecorded: boolean;
  readonly lateDelivery: boolean;
  /**
   * Whether a send to this Driver can ever be confirmed or refuted: it reports the input as an event (`live`), can be asked
   * whether it holds the packet (`verify`), or a completed Turn proves the input recorded (`successProvesRecorded`). False for a
   * Driver that declares nothing: its packets are sent once and never sent again by themselves (permissive-defaults §2.1).
   */
  readonly evidence: boolean;
  readonly execution: "process" | "gateway";
  readonly compactionEvidence: RelayCapabilities["compactionEvidence"];
  /** How its packets go: as a text block of their own, or flattened into one text with the user's words (singleText). */
  readonly channel: DeliveryRecord["channel"];
  readonly capabilities: RelayCapabilities | null;
}
/**
 * The declaration of `capabilities`, or the most conservative one without it: no check, no proof of delivery from success,
 * inputs that may arrive late (so no automatic resend), a gateway's execution (no "continue the original session" after an
 * unknown Turn) and no compaction evidence.
 */
export function relayDeclaration(capabilities: RelayCapabilities | null | undefined): RelayDeclaration {
  if (capabilities === null || capabilities === undefined)
    return { declared: false, probed: false, verify: "none", successProvesRecorded: false, lateDelivery: true, evidence: false, execution: "gateway", compactionEvidence: "none", channel: "single_text", capabilities: null };
  return { declared: true, probed: capabilities.probed, verify: capabilities.delivery.verify, successProvesRecorded: capabilities.delivery.successProvesRecorded,
    lateDelivery: capabilities.delivery.lateDelivery, evidence: capabilities.delivery.live !== "none" || capabilities.delivery.verify !== "none" || capabilities.delivery.successProvesRecorded,
    execution: capabilities.execution, compactionEvidence: capabilities.compactionEvidence, channel: capabilities.placement.parts === "multiple" ? "text_block" : "single_text", capabilities };
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings: what the installation's preferences make of the policy
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The relay's settings with their defaults applied (the owner's decision of 2026-11-10: permissive by default, the strict
 * behaviors are settings; permissive-defaults §4). `crossVendor` "allow" lets another vendor take the history (logged at its
 * first use); `whenUnsure` "auto" settles what the relay is unsure of — a packet whose delivery is unconfirmed, a binding in
 * doubt, a failure concerning the packet only — without asking, and never stops the message; "ask" asks as the strict design
 * did; `allowUnprobed` lets a Driver whose probes have not proved its mechanisms take history; `dataRootInWorkspace` "block"
 * refuses a cross-vendor handoff into a workspace the data directory is in reach of, "warn" only says so.
 */
export interface RelaySettings {
  readonly crossVendor: "ask" | "allow" | "goal_only";
  readonly whenUnsure: "auto" | "ask";
  readonly allowUnprobed: boolean;
  readonly dataRootInWorkspace: "warn" | "block";
  readonly returnPreference: "continue" | "new_when_cold" | "ask";
  readonly localModelsOffline: boolean;
}
/** The settings of a Store's stored preferences (RelayLogPort.relayPrefs): a missing or unreadable value is the default. */
export function relaySettings(prefs: Readonly<Partial<Record<RelayPrefKey, string>>>): RelaySettings {
  const value = (key: RelayPrefKey): string => prefs[key] ?? RELAY_PREF_DEFAULTS[key];
  const crossVendor = value("relay.crossVendor"), returnPreference = value("relay.returnPreference");
  return { crossVendor: crossVendor === "ask" || crossVendor === "goal_only" ? crossVendor : "allow", whenUnsure: value("relay.whenUnsure") === "ask" ? "ask" : "auto",
    allowUnprobed: value("relay.allowUnprobed") !== "false", dataRootInWorkspace: value("relay.dataRootInWorkspace") === "block" ? "block" : "warn",
    returnPreference: returnPreference === "new_when_cold" || returnPreference === "ask" ? returnPreference : "continue", localModelsOffline: value("relay.localModelsOffline") === "true" };
}
/** The strict design's settings: the four preferences that turn every strict behavior back on (RELAY_STRICT_PREFS). */
export const STRICT_SETTINGS: RelaySettings = { crossVendor: "ask", whenUnsure: "ask", allowUnprobed: false, dataRootInWorkspace: "block", returnPreference: "continue", localModelsOffline: false };
/** What the Runtime's defaults are when nothing is stored. */
export const DEFAULT_SETTINGS: RelaySettings = relaySettings({});

// ---------------------------------------------------------------------------------------------------------------------
// The request's choices
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What a request chose for the relay (relay-architecture §12.4, the subset the Runtime acts on): `attach` "none" sends the
 * input alone ("只发这条消息", event n), "full" attaches the history once even below a clear floor ("附上交接单",
 * attachOverride) and, on a suspect binding, sends the complete packet again in the same native session ("补发完整交接单");
 * `resend` sends a pending packet again ("再附一次"), and on a suspect binding also chooses the complete packet;
 * `clearConfirmed` is the user's ［确认已清空］; `native` "new" opens a new native session for this input with the whole packet
 * ("新开原生会话", §7.3, D9; "continue" is the default, continuing the original one); `consent` is the user's consent to the
 * target's vendor key (§10.4), recorded in the installation's log when the input is accepted; `tier` is recorded with the Run
 * (the MVP renders the standard tier only). Notes, exclusions and reveals are G073's.
 */
export interface RelayChoices {
  readonly attach?: "full" | "none"; readonly resend?: true; readonly clearConfirmed?: true;
  readonly tier?: Tier; readonly native?: "continue" | "new"; readonly consent?: RequestedConsent;
}
const CHOICE_KEYS = ["attach", "resend", "clearConfirmed", "tier", "native", "consent"];
/** The request's relay choices, checked; undefined when it makes none ("auto" is none). INVALID_INPUT for anything else. */
export function parseRelayChoices(value: unknown): RelayChoices | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_INPUT", "relay choices must be an object");
  const item = value as Readonly<Record<string, unknown>>;
  if (Object.keys(item).some(key => !CHOICE_KEYS.includes(key))) throw new SessionError("INVALID_INPUT", "unsupported relay choice");
  if (item.attach !== undefined && item.attach !== "auto" && item.attach !== "full" && item.attach !== "none") throw new SessionError("INVALID_INPUT", "relay attach must be auto, full or none");
  if (item.resend !== undefined && item.resend !== true) throw new SessionError("INVALID_INPUT", "relay resend must be true");
  if (item.clearConfirmed !== undefined && item.clearConfirmed !== true) throw new SessionError("INVALID_INPUT", "relay clearConfirmed must be true");
  if (item.tier !== undefined && !(TIERS as readonly unknown[]).includes(item.tier)) throw new SessionError("INVALID_INPUT", "relay tier must be one of " + TIERS.join(", "));
  if (item.native !== undefined && item.native !== "continue" && item.native !== "new") throw new SessionError("INVALID_INPUT", "relay native must be continue or new");
  let consent: RequestedConsent | undefined;
  if (item.consent !== undefined) {
    const raw = item.consent;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "vendor" && key !== "decision" && key !== "scope")) throw new SessionError("INVALID_INPUT", "relay consent must name a vendor, a decision and a scope");
    const row = raw as Readonly<Record<string, unknown>>;
    let vendor: VendorKey;
    try { vendor = parseVendorKey(row.vendor); } catch { throw new SessionError("INVALID_INPUT", "relay consent must name a vendor key"); }
    if (row.decision !== "acknowledged" && row.decision !== "goal_only") throw new SessionError("INVALID_INPUT", "relay consent decision must be acknowledged or goal_only");
    if (row.scope !== "session" && row.scope !== "global") throw new SessionError("INVALID_INPUT", "relay consent scope must be session or global");
    consent = { vendor, decision: row.decision, scope: row.scope };
  }
  if (item.attach === "none" && (item.resend === true || item.clearConfirmed === true || item.native === "new" || consent !== undefined)) throw new SessionError("INVALID_INPUT", "an input sent alone carries no relay choice besides");
  const choices: RelayChoices = { ...(item.attach === "full" || item.attach === "none" ? { attach: item.attach } : {}), ...(item.resend === true ? { resend: true as const } : {}),
    ...(item.clearConfirmed === true ? { clearConfirmed: true as const } : {}), ...(item.tier === undefined ? {} : { tier: item.tier as Tier }),
    ...(item.native === "continue" || item.native === "new" ? { native: item.native } : {}), ...(consent === undefined ? {} : { consent }) };
  return Object.keys(choices).length ? choices : undefined;
}
/**
 * Whether the request steered the relay itself: it asked for the history (`attach:"full"`, `resend`), confirmed a clear or chose a
 * new native session. What the user chose this way the policy never rewrites (permissive-defaults §0 rule 3): when it cannot be
 * done the Run fails and the draft stays, instead of going alone. `tier` is recorded with the Run only (the MVP renders the
 * standard tier), and a consent is the user's answer to the vendor, not a request for history; neither counts.
 */
export function explicitChoice(choices: RelayChoices): boolean {
  return choices.attach === "full" || choices.resend === true || choices.clearConfirmed === true || choices.native === "new";
}
/**
 * PublicRun.relayRequest for a request's choices (§4, RT2-19): the tier, attach, native and resend it chose, and the HMAC of
 * all of them (consent and ［确认已清空］ included) as canonical JSON under the Session's subkey; undefined when it chose none.
 */
export function runRelayRequest(session: SessionId, choices: RelayChoices | undefined, keys: RelayKeyPort): RunRelayRequest | undefined {
  if (choices === undefined) return undefined;
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(choices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, key === "consent" ? { vendor: (value as RequestedConsent).vendor, decision: (value as RequestedConsent).decision, scope: (value as RequestedConsent).scope } : value])));
  return { ...(choices.tier === undefined ? {} : { tier: choices.tier }), ...(choices.attach === undefined ? {} : { attach: choices.attach }), ...(choices.native === undefined ? {} : { native: choices.native }),
    ...(choices.resend === true ? { resend: true as const } : {}), fingerprint: keys.requestFingerprint(session, canonical) };
}
/** The choices a `message.accepted` event recorded (its `relay`); none when it recorded none or something else. */
export function acceptedChoices(data: Readonly<Record<string, unknown>> | undefined): RelayChoices {
  try { return parseRelayChoices(data?.relay) ?? {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------------------------------
// The read path: facts and delivery rows
// ---------------------------------------------------------------------------------------------------------------------

type EventReader = (id: SessionId, afterSeq: number, limit: number) => readonly SessionEvent[];
/**
 * The public facts of each Session as its events place them (§2): the fact seq of each finished Run (its `run.ended`, or
 * the `session.recovered` that ended it) and the Runs that were native commands (no fact). Events are append-only, so each
 * Session's are read once, from where the last read stopped; a new owner reads them again from the start.
 */
export class RelayLedger {
  private readonly sessions = new Map<SessionId, { after: number; readonly ended: Map<string, number>; readonly commands: Set<string> }>();
  constructor(private readonly events: EventReader) {}
  private scan(state: SessionSnapshot): { readonly ended: ReadonlyMap<string, number>; readonly commands: ReadonlySet<string> } {
    let known = this.sessions.get(state.id);
    if (known === undefined || known.after > state.lastSeq) { known = { after: 0, ended: new Map(), commands: new Set() }; this.sessions.set(state.id, known); }
    while (known.after < state.lastSeq) {
      const page = this.events(state.id, known.after, 100);
      if (!page.length) break;
      for (const item of page) {
        const data = item.data, run = typeof data.runId === "string" ? data.runId : null;
        if (item.type === "run.ended" && run !== null && !known.ended.has(run)) known.ended.set(run, item.seq);
        else if (item.type === "run.native_command" && run !== null) known.commands.add(run);
        else if (item.type === "session.recovered")
          for (const id of [...strings(data.unknownRunIds), ...strings(data.cancelledRunIds)]) if (!known.ended.has(id)) known.ended.set(id, item.seq);
      }
      known.after = page.at(-1)!.seq;
    }
    return known;
  }
  /** The fact seq of a finished Run, when its events place it. */
  endedSeq(state: SessionSnapshot, run: RunId): number | undefined { return this.scan(state).ended.get(run); }
  /**
   * The public facts of the Session (§2) foreign to `binding` (its Harness control in its current native epoch): each
   * finished, dispatched Run that was no native command and did not run there, with its fact seq and where it ran — the
   * Run's own `relay.executedOn` (v13), else the migration's index row (`index`), else null, which makes it foreign to every
   * binding (a conservative reading: it may be sent again, never lost). Only the facts a binding may owe are read: the
   * events are paged only when there is a foreign Run to place, so a single-Harness conversation reads none (§11.1).
   */
  facts(state: SessionSnapshot, index: readonly RelayIndexRow[], binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }): readonly RelayFact[] {
    const rows = new Map<string, Readonly<Record<string, unknown>>>();
    for (const row of index) if (!rows.has(row.runId)) rows.set(row.runId, row.index);
    const candidates: { readonly run: PublicRun; readonly row: Readonly<Record<string, unknown>> | undefined; readonly executedOn: ExecutedOn | null }[] = [];
    for (const run of state.runs) {
      if (!terminal(run.status) || !dispatched(run)) continue;
      const row = rows.get(run.id);
      if (run.relay === undefined && row !== undefined && row.commandEffect !== null && row.commandEffect !== undefined) continue;
      const executedOn = run.relay !== undefined ? run.relay.executedOn : executedOf(row?.executedOn);
      if (executedOn !== null && executedOn.harnessId === binding.harnessId && executedOn.controlId === binding.controlId && executedOn.nativeEpoch === binding.nativeEpoch) continue;
      candidates.push({ run, row, executedOn });
    }
    if (candidates.length === 0) return [];
    const scanned = this.scan(state), facts: RelayFact[] = [];
    for (const { run, row, executedOn } of candidates) {
      if (scanned.commands.has(run.id)) continue;
      const indexed = typeof row?.seq === "number" && Number.isSafeInteger(row.seq) && row.seq >= 0 && row.seq <= RELAY_MAX_SEQ ? row.seq : undefined;
      facts.push({ runId: run.id, seq: scanned.ended.get(run.id) ?? indexed ?? state.lastSeq, executedOn });
    }
    return facts;
  }
  forget(id: SessionId): void { this.sessions.delete(id); }
}
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function executedOf(value: unknown): ExecutedOn | null {
  if (value === null || value === undefined) return null;
  try { return parseExecutedOn(value); } catch { return null; }
}
/**
 * Whether a fact is foreign to the binding at all, whatever the mark (F≠∅ of §7.2), or the Session's own starting history is.
 * `since` is the binding's `heldSince` (delivery.ts foreignTo).
 */
export function foreignAtAll(facts: readonly RelayFact[], harnessId: string, controlId: string, relay: BindingRelayState, originHistory: boolean, since?: number): boolean {
  return facts.some(fact => foreignTo(fact, harnessId, controlId, relay, since)) || originHistory && !relay.originIncluded;
}
/** The first native epoch the binding's own native session holds, from the Session's bindings (delivery.ts heldSince, R1). */
export function heldSinceIn(state: SessionSnapshot, harnessId: string, controlId: string, relay: BindingRelayState): number {
  return heldSince(relay, state.nativeBindings ?? [], harnessId, controlId);
}
/**
 * Whether a binding's native session holds nothing the relay counts on it holding (ADR-055 C5; G068 fix batch 2, I-1b), so that
 * a new native session may take its place when its Driver refuses to open it as a session it does not have: fresh (no
 * watermark, nothing pending or in doubt), without the history the Session started from, nothing ever dispatched into it
 * (`throughRunId`), and no Turn of its Harness control dispatched in an epoch it holds — its own, or one before it that a clear
 * raised in place (heldSince, R1: those Turns are in the history the clear left) — nor one the relay cannot place. Stricter than
 * "no content Turn in this epoch": a native session that holds Turns since a clear confirmed after the fact is never replaced in
 * place, since nothing would then owe them to the new one. A binding that opens a new native session anyway (opensNew) resumes
 * nothing, so it is never asked.
 */
export function holdsNothing(state: SessionSnapshot, binding: NativeSessionBinding): boolean {
  const relay = binding.relay;
  if (relay === undefined || relay.sync.kind !== "fresh" || relay.originIncluded || binding.throughRunId !== null || binding.opensNew === true) return false;
  const since = heldSinceIn(state, binding.harnessId, binding.controlId, relay);
  return !state.runs.some(run => run.selection.provider === undefined && run.selection.harnessId === binding.harnessId && run.selection.controlId === binding.controlId && dispatched(run)
    && (run.relay?.executedOn == null || run.relay.executedOn.nativeEpoch >= since));
}
/**
 * Whether a binding's native session holds exactly the conversation through `through` (ADR-055 §7.5, RT1-B7), for a native
 * fork: synced, `through` ran in its current native epoch, and nothing foreign up to `through`'s fact (`endedSeq`, the seq of
 * its end) is owed to it. A binding without relay state is never exact: nothing says what its native session holds (A1, R10a;
 * none exists in a v13 Session, and this is pinned by a unit test). `endedSeq` and `facts` (those foreign to it) are read only
 * when the cheaper conditions hold: they page the Session's events.
 */
export function nativeExactAt(state: SessionSnapshot, binding: NativeSessionBinding, through: PublicRun, endedSeq: () => number | undefined,
    facts: (on: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }) => readonly RelayFact[]): boolean {
  const relay = binding.relay;
  if (relay === undefined) return false;
  if (relay.sync.kind !== "synced" || through.relay?.executedOn?.nativeEpoch !== relay.nativeEpoch) return false;
  const seq = endedSeq();
  if (seq === undefined) return false;
  const need = owed(relay, binding.harnessId, binding.controlId, facts({ harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: relay.nativeEpoch }).filter(fact => fact.seq <= seq),
    { originHistory: (state.origin?.history.length ?? 0) > 0, heldSince: heldSinceIn(state, binding.harnessId, binding.controlId, relay) });
  return need.facts.length === 0 && !need.origin;
}

/** How many of an epoch's latest recorded rows keep the mark their recording made, for a check's fall back (≥ 8 × SUSPECT_MARKERS). */
const MARKED_ROWS = 32;
/**
 * The delivery rows of one binding as a check reads them (§7.3, ADR-055's stage-two seam): each row of a packet sent to
 * this binding's Harness control in one of its own epochs (an archived binding's epochs come before them), with its
 * packet's epoch, range, text digest and re-anchor flag from the manifest, and for a recorded row the mark its recording
 * made, read from the event its decision was committed with (`markAt`). A row whose packet is not kept is left out.
 */
export function bindingDeliveries(state: SessionSnapshot, binding: NativeSessionBinding, rows: readonly DeliveryRecord[], packets: readonly RelayPacket[],
    markAt: (seq: number, run: RunId) => DeliveredMark | null): readonly BindingDelivery[] {
  const manifests = new Map(packets.map(packet => [packet.id as string, packet]));
  const archived = (state.nativeBindings ?? []).filter(item => item !== binding && item.status === "archived" && item.harnessId === binding.harnessId && item.controlId === binding.controlId && item.relay !== undefined);
  const firstEpoch = Math.max(0, ...archived.map(item => item.relay!.nativeEpoch)) + 1, epoch = binding.relay?.nativeEpoch ?? firstEpoch;
  const own = rows.flatMap(record => {
    const packet = manifests.get(record.packetId);
    return packet === undefined || packet.target.harnessId !== binding.harnessId || packet.target.controlId !== binding.controlId || packet.target.nativeEpoch < firstEpoch ? [] : [{ record, packet }];
  });
  // Only the current epoch's recorded rows stand for a mark a check may fall back to (planReturnVerify), and of those only the
  // latest MARKED_ROWS: a check looks at ≤4 of them along a chain, so older ones keep no mark (they are left out, never trusted).
  const marked = new Set(own.filter(({ record, packet }) => record.outcome.kind === "recorded" && packet.target.nativeEpoch === epoch).slice(-MARKED_ROWS).map(({ record }) => record.runId as string));
  return own.map(({ record, packet }) => ({ record, nativeEpoch: packet.target.nativeEpoch, range: packet.range, bodySha256: packet.body.sha256, reanchor: packet.reanchor,
    mark: record.outcome.kind === "recorded" && marked.has(record.runId) ? markAt(record.outcome.decidedSeq, record.runId) : null }));
}
/**
 * The mark a decision event says a Run's recorded delivery made (G068 phase two): `relay.input_recorded` (E1) and
 * `run.ended` (E3) name it for their Run, `relay.verified` (E2) lists it under `recorded`. Null when the event names none
 * (a late write recorded without moving the binding) or names something unreadable.
 */
export function markIn(event: SessionEvent | undefined, run: RunId): DeliveredMark | null {
  if (event === undefined) return null;
  const data = event.data;
  let raw: unknown;
  if (event.type === "relay.input_recorded" && data.runId === run) raw = data.mark;
  else if (event.type === "run.ended" && data.runId === run) raw = (data.delivery as Readonly<Record<string, unknown>> | undefined)?.mark;
  else if (event.type === "relay.verified" && Array.isArray(data.recorded)) raw = (data.recorded as readonly Readonly<Record<string, unknown>>[]).find(item => item?.runId === run)?.mark;
  if (raw === null || raw === undefined) return null;
  try { return parseDeliveredMark(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Admission (send): the synchronous 409
// ---------------------------------------------------------------------------------------------------------------------

const SUSPICIONS = new Set(["rewind", "unknown_command", "clear_unconfirmed", "unknown_turn"]);
/** The relay error of a cause of the user's choice (§9), in the user's words; the Run is not created or not dispatched. */
export function choiceRequired(cause: ChoiceCause): RelayError {
  const message = cause === "delivery_unconfirmed" ? "上一份交接单是否送达还不确定。可以再附一次、只发这条消息，或新开原生会话；这条消息没有发出，草稿已保留。"
    : cause === "marker_absent" ? "原生会话里找不到之前送达的交接单。可以在同一会话补发完整交接单（可能与已有内容重复），或新开原生会话；这条消息没有发出，草稿已保留。"
    : "原生会话里的交接内容需要核对，但现在核对不了。可以补发完整交接单（可能与已有内容重复）、只发这条消息，或新开原生会话；这条消息没有发出，草稿已保留。";
  return new RelayError({ code: "RELAY_CHOICE_REQUIRED", reason: cause }, message);
}
export function recoveryFailed(): RelayError {
  return new RelayError({ code: "RELAY_UNAVAILABLE", reason: "recovery_failed" }, "服务重启时没能恢复这个对话的交接记录，暂时不能附带交接内容。可以只发这条消息，或新开原生会话。");
}
/**
 * The user's ［确认已清空］ when it is not offered (§9: only while an unconfirmed clear's check is undecided; G068 fix batch 2,
 * M-1): at admission, where no Run is made. Never let through to be dropped at the open.
 */
export function clearNotOffered(): SessionError {
  return new SessionError("INVALID_INPUT", "现在不需要［确认已清空］：没有待确认的清空，或清空是否执行已经有了结论。这条消息没有发出，草稿已保留，可以不带这个选择再发一次。");
}
/**
 * The user's ［确认已清空］ the open could not act on: its own check settled the clear otherwise than by confirming it (M-1). The
 * Run fails before dispatch; nothing was sent.
 */
export function clearNotConfirmed(): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能确认清空：这次打开原生会话时的核对已经有了结论，不再需要［确认已清空］。这条消息没有发出，草稿已保留，可以不带这个选择再发一次。");
}
/**
 * Whether admission can take the user's ［确认已清空］ (§9, M-1): only on an unconfirmed clear whose check is undecided. One the
 * open settles without the user (`settledWithoutCheck`) is answered as its landing is — a pending packet whose automatic resend
 * is spent asks for that choice (409 delivery_unconfirmed) — or else refused (clearNotOffered); one a check at the open decides,
 * or the table leaves to the user, is let through, and the open acts on it or fails the Run (clearNotConfirmed).
 */
function admitClearConfirmed(relay: BindingRelayState, declaration: RelayDeclaration): void {
  const sync = relay.sync;
  if (sync.kind !== "suspect" || sync.cause !== "clear_unconfirmed" || sync.floorCandidate === null || sync.floorCandidate <= relay.epochFloor) throw clearNotOffered();
  const landed = settledWithoutCheck(relay, declaration.verify);
  if (landed === null) return;
  if (landed.sync.kind === "pending" && pendingResend(landed.sync, declaration.lateDelivery) === "choice") throw choiceRequired("delivery_unconfirmed");
  throw clearNotOffered();
}
/** step's verify_first cause as the 409 cause (F11): marker_absent stays, every other (legacy included) is verify_required. */
export function causeOf(cause: string): ChoiceCause { return cause === "marker_absent" ? "marker_absent" : "verify_required"; }
export interface AdmitInput {
  readonly state: SessionSnapshot;
  /** The binding the input will run on (pendingSwitch?.target ?? selection); undefined when it has none yet. */
  readonly binding: NativeSessionBinding | undefined;
  readonly target: HarnessSelection;
  /** The target Driver's static declaration; undefined when the factory cannot tell (admission then asks nothing). */
  readonly capabilities: RelayCapabilities | null | undefined;
  readonly text: string;
  readonly attachments: readonly ContentKind[];
  readonly choices: RelayChoices;
  /** The facts foreign to the binding of this Harness control in this native epoch (RelayLedger.facts). */
  readonly facts: (binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }) => readonly RelayFact[];
  /**
   * What G072's checks read (the probe gate, the data root, consent and the window), given only for an input that would carry
   * relay content (relayAdmission said so): its reads are the Runtime's. Absent: only G068's checks run (a caller that cannot
   * tell them, and the unit tests of those checks).
   */
  readonly gates?: AdmitGates;
  /**
   * The relay's settings (relaySettings of the stored preferences). Absent: the strict design's (STRICT_SETTINGS), which is what
   * the pure checks and their unit tests mean; the Runtime always gives the installation's, whose defaults are permissive.
   */
  readonly settings?: RelaySettings | (() => RelaySettings);
}
/** An input that would carry relay content, as admission found it (relayAdmission): what its binding is and owes. */
export interface Carrying {
  readonly relay: BindingRelayState;
  readonly declaration: RelayDeclaration;
  readonly facts: readonly RelayFact[];
  readonly need: Owed;
  /** Something is owed now (need≠∅). */
  readonly owes: boolean;
  /** Foreign facts while the binding's mark is in doubt (suspect of a rewind-like cause): a check decides what is owed. */
  readonly doubt: boolean;
  readonly originHistory: boolean;
  readonly heldSince: number;
  /**
   * Whether what would be carried includes another Harness control's history (or the history the Session started from): only
   * then are G072's gates asked. What ran on the target's own Harness control (an earlier native session of it, a Turn its
   * Driver keeps no session for) is its own history coming back to it, which no probe, vendor or data root changes (§6.1's
   * "单 Harness 对话不做任何接力检查"); the epoch's vendor key is still held to (`consentKey`, vendor_changed).
   */
  readonly crossHarness: boolean;
}
/**
 * Whether facts include one that ran on another Harness control than `target` (by its relay, else its Run's selection; a Run
 * the Session cannot place counts as another's), or the Session's own starting history is owed.
 */
export function crossHarnessFacts(state: SessionSnapshot, facts: readonly RelayFact[], origin: boolean, target: { readonly harnessId: string; readonly controlId: string }): boolean {
  if (origin) return true;
  return facts.some(fact => {
    const run = state.runs.find(row => row.id === fact.runId);
    const harnessId = fact.executedOn?.harnessId ?? (run?.selection.provider === undefined ? run?.selection.harnessId : undefined), controlId = fact.executedOn?.controlId ?? run?.selection.controlId;
    return harnessId !== target.harnessId || controlId !== target.controlId;
  });
}
/** The installation's consent view for one Session, and the request's own consent (§10.4). */
export interface ConsentView {
  readonly session: SessionId;
  /** The latest record of each vendor, scope and Session (RelayLogPort.relayConsents). */
  readonly records: readonly ConsentRecord[];
  readonly crossVendor: "ask" | "allow" | "goal_only";
  readonly localModelsOffline: boolean;
  /** The consent the request itself gives (`relay.consent`), not recorded yet. */
  readonly request: RequestedConsent | null;
}
/** What G072's checks read for an input that would carry relay content (relayGatesOf builds the vendor part). */
export interface AdmitGates {
  /** `relay.allowUnprobed` (D11): an unprobed Driver may take relay content; on by default, off in the strict design (permissive-defaults §2.4). */
  readonly allowUnprobed: boolean;
  /** The data directory and relay key are out of the workspace's reach (INV-36). */
  readonly isolated: boolean;
  /** The target's vendor key as admission can tell it (the binding's cached observation; unknown:<harnessId> without one) and the layer its endpoint came from. */
  readonly target: { readonly vendor: VendorKey; readonly layer: EndpointLayer | null };
  /** The vendor keys of what would be carried (§6.1 "任一来源的厂商键与目的不同即算跨厂商"). */
  readonly sources: readonly VendorKey[];
  readonly consent: ConsentView;
  /** The window last observed for the target's Harness control and model (relay_windows), for MIN_PACKET. */
  readonly window: RelayWindow | null;
  readonly now: number;
}
/**
 * Whether an input would carry relay content and is asked anything (§6.1 coordinator.admit's premise): none for an input sent
 * alone, a managed Provider's, one the target's Driver reads as a command or a possible command (its own reading without a
 * catalog; acceptsRelay commands excepted, carriesWithReading), and one whose binding owes
 * nothing, waits for no packet, is not in doubt and was not asked for the history. Null: nothing is asked and nothing is read.
 * A factory that cannot tell the declaration (undefined) leaves every question to the open.
 */
export function relayAdmission(input: AdmitInput): Carrying | null {
  const { state, binding, target, capabilities, choices } = input;
  if (target.provider !== undefined || choices.attach === "none" || capabilities === undefined) return null;
  const declaration = relayDeclaration(capabilities);
  // A command carries nothing and is never stopped by the relay (VF1-05); one whose arguments the native side submits as a
  // prompt (acceptsRelay) may carry, and so may a word only the catalog settles.
  if (capabilities !== null && !carriesWithReading(capabilities.commands.classify(input.text, null, input.attachments))) return null;
  // The user's ［新开原生会话］ (`native:"new"`): the input runs on a new binding of its Harness control (send archives this one).
  const relay = choices.native === "new" || binding?.relay === undefined ? initialBindingRelay([...(state.nativeBindings ?? []).map(row => row === binding ? { ...row, status: "archived" as const } : row)], target.harnessId, target.controlId, "new") : binding.relay;
  const facts = input.facts({ harnessId: target.harnessId, controlId: target.controlId, nativeEpoch: relay.nativeEpoch }), originHistory = (state.origin?.history.length ?? 0) > 0;
  const sync = relay.sync, since = choices.native === "new" ? relay.nativeEpoch : heldSinceIn(state, target.harnessId, target.controlId, relay);
  const need = owed(relay, target.harnessId, target.controlId, facts, { originHistory, attachOverride: choices.attach === "full" || sync.kind === "pending" && sync.attachOverride, heldSince: since });
  const owes = need.facts.length > 0 || need.origin;
  const doubt = sync.kind === "suspect" && SUSPICIONS.has(sync.cause) && foreignAtAll(facts, target.harnessId, target.controlId, relay, originHistory, since);
  // The user's ［确认已清空］ is answered whatever is owed (M-1): returned so that admitRelay answers it.
  if (!owes && !doubt && sync.kind !== "pending" && choices.attach !== "full" && choices.clearConfirmed !== true) return null;
  const crossHarness = crossHarnessFacts(state, owes ? need.facts : facts, need.origin || doubt && originHistory && !relay.originIncluded, target);
  return { relay, declaration, facts, need, owes, doubt, originHistory, heldSince: since, crossHarness };
}
/**
 * Whether a reading may carry relay content: content, or a command that submits its arguments as a prompt (acceptsRelay). A
 * command and a word only the catalog settles (possible_command) carry none at admission (§6.1: they skip every relay check, a
 * command is never stopped by the relay); what the open's catalog then settles as content meets the open's own checks (the
 * probe gate, the data root, consent, the window and the user's choice are all checked again there) and fails before dispatch
 * with the same codes, since admission could not decide it.
 */
export function carriesWithReading(reading: CommandClass): boolean {
  return reading.kind === "content" || reading.kind === "command" && reading.acceptsRelay === true;
}
/**
 * Admission's relay part (§6.1 coordinator.admit, §9): what can be decided before any Run exists, synchronously and without
 * starting anything, for an input relayAdmission found would carry relay content; an input sent alone, a command and a
 * single-Harness conversation are never asked (relayAdmission). In §6.1's order, each the first failing one thrown:
 * - the probe gate (D11): a Driver that declares no relay mechanisms takes none (RELAY_TARGET_UNVERIFIED{undeclared}), an
 *   unprobed one only with `relay.allowUnprobed` — which is on by default, so this is a setting of the strict design;
 * - a relay recovery that could not be written (RELAY_UNAVAILABLE{recovery_failed});
 * - the data root (INV-36): a cross-vendor handoff (any source's vendor key differs from the target's) into a workspace the
 *   data directory or relay key is not out of reach of (RELAY_UNAVAILABLE{data_root_in_workspace}), when `relay.dataRootInWorkspace`
 *   is "block"; "warn" (the default) does not refuse;
 * - the user's choice (G068): a pending packet no check before dispatch can settle and none may be resent automatically
 *   (RELAY_CHOICE_REQUIRED{delivery_unconfirmed}), a suspect binding no check can settle (verify_required | marker_absent); a
 *   Driver that checks at the open is let through and settled there (§9: only what admission can decide is a 409);
 * - consent (§10.4, INV-33): a vendor key that changed since the epoch's first packet without this request's consent to the
 *   new one (RELAY_CONSENT_REQUIRED{vendor_changed}); a cross-vendor handoff without a consent that stands
 *   (RELAY_CONSENT_REQUIRED{missing});
 * - the smallest packet (§6.2): the hard cap on the conservative window below MIN_PACKET (RELAY_INPUT_LIMIT{min_packet}).
 * The user's ［确认已清空］ is answered first (admitClearConfirmed: INVALID_INPUT where it is not offered). Without `gates`,
 * only G068's checks run.
 *
 * The permissive defaults (permissive-defaults §0, owner's decision of 2026-11-10): with `relay.whenUnsure` "auto" and a request
 * that made no choice of its own (explicitChoice), nothing but the settings above stops an input: the recovery, the user's
 * choice, the consent (a withdrawal, or a goal-only consent the MVP cannot render) and the smallest packet are settled at the
 * open, where the Turn goes on without the packet and says so. A request that steered the relay is held to every check.
 */
export function admitRelay(input: AdmitInput): void {
  const carrying = relayAdmission(input);
  if (carrying !== null) admitCarrying(input, carrying, input.gates);
}
export function admitCarrying(input: AdmitInput, carrying: Carrying, gates: AdmitGates | undefined): void {
  const { state, target, choices } = input, { relay, declaration } = carrying, sync = relay.sync;
  if (choices.clearConfirmed === true) admitClearConfirmed(relay, declaration);
  if (!carrying.owes && !carrying.doubt && sync.kind !== "pending" && choices.attach !== "full") return;
  // The settings are read (the installation's preferences) only for an input that carries relay content.
  const settings = typeof input.settings === "function" ? input.settings() : input.settings ?? STRICT_SETTINGS, lenient = settings.whenUnsure === "auto" && !explicitChoice(choices);
  // G072's gates apply to another Harness's history only (Carrying.crossHarness); the epoch's vendor key always.
  const gated = gates !== undefined && carrying.crossHarness ? gates : undefined;
  if (gated !== undefined) probeGate(declaration, gated.allowUnprobed, target);
  if (state.relayRecoveryFailed !== undefined && !lenient) throw recoveryFailed();
  const cross = gated !== undefined && crossVendor(gated.target.vendor, gated.sources);
  if (gated !== undefined && cross && !gated.isolated && settings.dataRootInWorkspace === "block") throw dataRootInWorkspace(target);
  if (!lenient) admitChoice(carrying, choices);
  if (gates === undefined) return;
  // A consent is settled at the open when the preference allows or the policy settles what it cannot (the open reads the vendor
  // the Driver really resolved): only a strict preference (ask), or a request that steered the relay, is asked here.
  if (!(lenient && gates.consent.crossVendor !== "ask")) consentGate({ relay, vendor: gates.target.vendor, layer: gates.target.layer, cross, consent: gates.consent, target, predicted: null });
  if (gated === undefined || lenient) return;
  const window = resolveWindow({ relay, report: declaration.capabilities?.window ?? "none", stored: gates.window, vendor: gates.target.vendor, fixedPrefix: declaration.capabilities?.fixedPrefix ?? null, now: gates.now });
  const channel = declaration.capabilities?.placement.maxInput ?? null, size = declaration.capabilities?.placement.measure(input.text, input.attachments) ?? [...input.text].length;
  const modelKey = relay.vendorObserved?.modelKey ?? "";
  if (!fitsMinPacket(hardCap(window, estimateTokens(input.text), channel, size), packetFamily(gates.target.vendor, modelKey))) throw inputLimit("min_packet", target);
}
/** G068's checks of the user's choice at admission (§9 "需要用户选择"), for an input that would carry relay content. */
function admitChoice(carrying: Carrying, choices: RelayChoices): void {
  const { relay, declaration } = carrying, sync = relay.sync;
  // The user's ［新开原生会话］ starts a fresh binding: nothing of this one's state needs a choice.
  if (choices.native === "new") return;
  // The user's "再附一次": `resend`, or `attach:"full"` on a pending packet (R9b), which sends it again too.
  const resend = choices.resend === true || choices.attach === "full";
  if (sync.kind === "pending") {
    // A Driver that checks at the open settles the packet there first; the others already checked (after_turn) or never do.
    if (declaration.verify !== "on_next_open" && pendingResend(sync, declaration.lateDelivery) === "choice" && !resend) throw choiceRequired("delivery_unconfirmed");
    return;
  }
  if (sync.kind === "suspect") {
    if (resend || choices.clearConfirmed === true && sync.cause === "clear_unconfirmed") return;
    if (sync.cause === "legacy" || sync.cause === "marker_absent") { if (carrying.owes) throw choiceRequired(causeOf(sync.cause)); return; }
    if (!admitsWithoutChoice(relay, declaration.verify)) throw choiceRequired("verify_required");
    // What the open certainly makes of it is read like any binding (R9a): landing on a pending packet whose automatic resend
    // is spent (the table of unchecked suspicion sends a carried packet back with autoResends 1), the user chooses now.
    const landed = settledWithoutCheck(relay, declaration.verify);
    if (landed?.sync.kind === "pending" && pendingResend(landed.sync, declaration.lateDelivery) === "choice") throw choiceRequired("delivery_unconfirmed");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// G072's gates: probes, vendors and consent, the data root, the window
// ---------------------------------------------------------------------------------------------------------------------

/** RELAY_TARGET_UNVERIFIED (D11) in the user's words: "只发这条消息" is what is left. */
export function targetUnverified(reason: "unprobed" | "undeclared", target: { readonly harnessId: string; readonly controlId: string }): RelayError {
  const message = reason === "undeclared" ? "这个 Harness 还不支持接收交接内容，HarnessHub 不会把之前的对话交给它。可以只发这条消息（不附交接单）；这条消息没有发出，草稿已保留。"
    : "这个 Harness 的交接方式还没有在它的最新正式版上验证过，HarnessHub 暂不把之前的对话交给它。可以只发这条消息（不附交接单）；这条消息没有发出，草稿已保留。";
  return new RelayError({ code: "RELAY_TARGET_UNVERIFIED", reason }, message, { harnessId: target.harnessId, controlId: target.controlId });
}
/**
 * The probe gate (D11): only a probed Driver takes another Harness's history while `relay.allowUnprobed` is off (the strict design).
 * With it on — the default (permissive-defaults §2.4: an unprobed Driver is marked "未经真机验证" on its card, not refused) — an
 * unprobed one does too, and so does a Driver that declares nothing, which is then read by the most conservative declaration
 * (relayDeclaration(null): no check, lateDelivery, no success proof, so no automatic resend of its packets).
 */
export function probeGate(declaration: RelayDeclaration, allowUnprobed: boolean, target: { readonly harnessId: string; readonly controlId: string }): void {
  if (declaration.probed || allowUnprobed) return;
  throw targetUnverified(declaration.declared ? "unprobed" : "undeclared", target);
}
export function dataRootInWorkspace(target: { readonly harnessId: string; readonly controlId: string }): RelayError {
  return new RelayError({ code: "RELAY_UNAVAILABLE", reason: "data_root_in_workspace" }, "HarnessHub 的数据目录或接力密钥在这个工作区里，目标 Harness 能直接读到它们；把数据目录移到工作区外（--data-dir）后再交接。同一厂商的接力与单个 Harness 的对话不受影响；也可以只发这条消息。",
    { harnessId: target.harnessId, controlId: target.controlId });
}
export function inputLimit(reason: "min_packet" | "input_limit", target: { readonly harnessId: string; readonly controlId: string }): RelayError {
  const message = reason === "min_packet" ? "这个 Harness 的上下文窗口放不下最小的交接单和这条消息。可以只发这条消息（不附交接单）；这条消息没有发出，草稿已保留。"
    : "这条消息和交接单合起来超过了这个 Harness 的输入上限。可以只发这条消息（不附交接单），或把消息拆短；这条消息没有发出，草稿已保留。";
  return new RelayError({ code: "RELAY_INPUT_LIMIT", reason }, message, { harnessId: target.harnessId, controlId: target.controlId });
}
/**
 * The vendor key a Driver declares for what it observed (§10.4): `resolveVendor` of the observation, checked as a key;
 * unknown:<harnessId> without a declaration or an observation, or when the declaration's answer is no key.
 */
export function vendorKeyOf(capabilities: RelayCapabilities | null | undefined, harnessId: string, observed: VendorObservation | null): VendorKey {
  const unknown = ("unknown:" + harnessId) as VendorKey;
  if (capabilities === null || capabilities === undefined || observed === null) return unknown;
  try { return parseVendorKey(capabilities.resolveVendor(observed)); } catch { return unknown; }
}
/** Cross-vendor (§6.1, §10.1): any source's vendor key differs from the target's (several sources: any one differing). */
export function crossVendor(target: VendorKey, sources: readonly VendorKey[]): boolean { return sources.some(source => source !== target); }
/**
 * The vendor keys of what would be carried (§6.1): for each fact, the Harness control it ran on (its relay, else its Run's
 * selection) as that control's binding last saw its vendor (the latest binding of that control, archived ones included) and
 * its Driver declares it (`declarationOf`); a managed Provider's Run, a Run the Session cannot place, and the history the
 * Session started from (owed when `origin`) are unknown:<harnessId> — conservatively cross-vendor, so the data root and consent
 * are asked rather than skipped.
 */
export function sourceVendors(state: SessionSnapshot, facts: readonly RelayFact[], origin: boolean, declarationOf: (selection: HarnessSelection) => RelayCapabilities | null | undefined): readonly VendorKey[] {
  const keys = new Set<VendorKey>();
  for (const fact of facts) {
    const run = state.runs.find(row => row.id === fact.runId);
    if (run?.selection.provider !== undefined) { keys.add(("unknown:" + (run?.selection.harnessId ?? "harness")) as VendorKey); continue; }
    const harnessId = fact.executedOn?.harnessId ?? run?.selection.harnessId, controlId = fact.executedOn?.controlId ?? run?.selection.controlId;
    if (harnessId === undefined || controlId === undefined) { keys.add("unknown:harness" as VendorKey); continue; }
    const bound = (state.nativeBindings ?? []).filter(row => row.harnessId === harnessId && row.controlId === controlId).at(-1);
    keys.add(vendorKeyOf(declarationOf({ harnessId, controlId }), harnessId, bound?.relay?.vendorObserved ?? null));
  }
  if (origin) keys.add(("unknown:" + (state.origin?.kind === "import" ? state.origin.harnessId : "origin")) as VendorKey);
  return [...keys];
}
/** A request's own consent (`relay.consent`, §12.4): to one vendor key, acknowledged or goal only, for this Session or every one. */
export interface RequestedConsent { readonly vendor: VendorKey; readonly decision: "acknowledged" | "goal_only"; readonly scope: "session" | "global" }
/** What stands for a vendor key (§10.4): exempt (local, offline models), a consent (and the record it rests on), or none. */
export type ConsentStanding =
  | { readonly kind: "exempt" }
  /**
   * `via` "default": nothing was recorded for the vendor and `relay.crossVendor` allows it (the permissive default): no log row yet,
   * so the Runtime writes one (appendDefaultAllow) before the Turn that rests on it; `logSeq` is then that row's.
   */
  | { readonly kind: "given"; readonly decision: "acknowledged" | "goal_only"; readonly logSeq: number | null; readonly via: "request" | "session" | "global" | "preference" | "default" }
  | { readonly kind: "missing"; readonly revoked: boolean };
/** The vendor keys `relay.crossVendor:goal_only` never covers, and only a Session's own record does for unknown ones (§10.4, INV-33) — the strict design's. */
function guarded(vendor: VendorKey): boolean { return /^(?:unknown|gateway|router|provider):/u.test(vendor); }
/**
 * Whether a consent stands for `vendor` in this Session (§10.4, INV-33): `local` with "本机模型不出网" needs none (unless the
 * preference allows, which logs every first use); the request's own consent to it stands; else this Session's latest record
 * decides (withdrawn: none), else — in the strict design (`ask`, `goal_only`), except for an unknown key and an endpoint a
 * workspace file gave, which every Session asks anew — the latest global record, else `relay.crossVendor`: `goal_only` covers a
 * named vendor for the goal only, `ask` nothing. With `allow` (the default; the owner's decision of 2026-11-10) any key stands unless
 * withdrawn — unknown, gateway, router and Provider keys and an endpoint from a workspace file included: the Harness is already
 * sending the user's input and code to that endpoint, and the history goes with a notice, not a question. A withdrawal is never
 * overridden by a broader consent or the preference. A row the default wrote (consentSourceOf) is a consent only while the
 * preference is `allow`: under a strict preference it is no consent the user gave.
 */
export function consentStanding(vendor: VendorKey, layer: EndpointLayer | null, view: ConsentView): ConsentStanding {
  const permissive = view.crossVendor === "allow";
  if (vendor === "local" && view.localModelsOffline && !permissive) return { kind: "exempt" };
  if (view.request !== null && view.request.vendor === vendor) return { kind: "given", decision: view.request.decision, logSeq: null, via: "request" };
  const latest = (scope: "session" | "global") => view.records.filter(record => record.vendor === vendor && (permissive || !record.commandId.startsWith(DEFAULT_ALLOW_PREFIX))
    && (scope === "session" ? record.scope.kind === "session" && record.scope.sessionId === view.session : record.scope.kind === "global"))
    .reduce<ConsentRecord | null>((last, record) => last === null || record.logSeq > last.logSeq ? record : last, null);
  const own = latest("session");
  if (own !== null) return own.decision === "revoked" ? { kind: "missing", revoked: true } : { kind: "given", decision: own.decision, logSeq: own.logSeq, via: "session" };
  if (!permissive && (vendor.startsWith("unknown:") || layer === "workspace_file")) return { kind: "missing", revoked: false };
  const global = latest("global");
  if (global !== null) return global.decision === "revoked" ? { kind: "missing", revoked: true } : { kind: "given", decision: global.decision, logSeq: global.logSeq, via: "global" };
  if (permissive) return { kind: "given", decision: "acknowledged", logSeq: null, via: "default" };
  if (!guarded(vendor) && view.crossVendor === "goal_only") return { kind: "given", decision: "goal_only", logSeq: null, via: "preference" };
  return { kind: "missing", revoked: false };
}
export function consentRequired(reason: "missing" | "vendor_changed" | "revoked", vendor: VendorKey, target: { readonly harnessId: string; readonly controlId: string }, previous?: VendorKey, goalOnly = false): RelayError {
  const message = reason === "vendor_changed" ? "这个 Harness 现在用的模型服务（" + vendor + "）和本段对话之前交接时（" + (previous ?? "另一家") + "）不同。可以同意交给新的服务、新开原生会话，或取消；这条消息没有发出，草稿已保留。"
    : reason === "revoked" ? "你已经撤回了把对话交给 " + vendor + " 的同意，这条消息没有发出，草稿已保留。可以重新同意，或只发这条消息（不附交接单）。"
    : goalOnly ? "你只同意了把目标交给 " + vendor + "（只交目标），HarnessHub 现在还只能生成标准档的交接单。可以同意交出标准档，或只发这条消息（不附交接单）；这条消息没有发出，草稿已保留。"
    : "这条消息会附上之前的对话记录交给 " + vendor + "，需要你先同意。可以同意后发送，或只发这条消息（不附交接单）；这条消息没有发出，草稿已保留。";
  return new RelayError({ code: "RELAY_CONSENT_REQUIRED", reason }, message, { vendor, ...(previous === undefined ? {} : { previousVendor: previous }), harnessId: target.harnessId, controlId: target.controlId });
}
/** What the consent checks found for a Turn that carries history: the consent that stands (null when none is needed), and the key it moved from. */
export interface ConsentOutcome {
  readonly standing: ConsentStanding | null;
  /** The epoch's earlier vendor key when this Turn goes to another one and the preference allows it (the strict design refuses): `relay.vendor_changed` is recorded, nothing stops. */
  readonly changedFrom: VendorKey | null;
}
/**
 * The consent checks (§10.4) for a Turn that would carry relay content: the vendor key changed since the epoch's first packet
 * (`consentKey`) without this request's consent to the new one → vendor_changed, whether cross-vendor or not (the native
 * history the new vendor reads holds the earlier packets) — unless `relay.crossVendor` is `allow`, which lets it go with the
 * change recorded (`changedFrom`); a cross-vendor handoff without a standing consent → missing (or revoked, or vendor_changed
 * when `predicted`, what admission read, differs from this key and the preference does not allow). A goal-only consent stands
 * for no packet yet: the MVP renders the standard tier only (G070), so it is asked again (missing). Returns the consent that
 * stands (null when none is needed) and the change.
 */
export function consentGate(input: { readonly relay: BindingRelayState; readonly vendor: VendorKey; readonly layer: EndpointLayer | null; readonly cross: boolean; readonly consent: ConsentView;
    readonly target: { readonly harnessId: string; readonly controlId: string }; readonly predicted: VendorKey | null }): ConsentOutcome {
  const { relay, vendor, consent, target } = input, permissive = consent.crossVendor === "allow";
  let changedFrom: VendorKey | null = null;
  if (relay.consentKey !== null && relay.consentKey !== vendor && consent.request?.vendor !== vendor) {
    if (!permissive) throw consentRequired("vendor_changed", vendor, target, relay.consentKey);
    changedFrom = relay.consentKey;
  }
  if (!input.cross && changedFrom === null) return { standing: null, changedFrom: null };
  const standing = consentStanding(vendor, input.layer, consent);
  if (standing.kind === "missing") throw consentRequired(!permissive && input.predicted !== null && input.predicted !== vendor ? "vendor_changed" : standing.revoked ? "revoked" : "missing", vendor, target, input.predicted ?? undefined);
  if (standing.kind === "given" && standing.decision === "goal_only") throw consentRequired("missing", vendor, target, undefined, true);
  return { standing, changedFrom };
}
/** The data classes a relay packet may carry (§10.1), recorded with a consent the request gives. */
export const CONSENT_CATEGORIES = ["user_text", "hub_text", "harness_text", "exec_output", "workspace_meta", "credential_path"] as const;
/** The policy version the consent log's rows are written under (the request's own consent, and the default's). */
export const CONSENT_POLICY = "relay/1" as const;
/**
 * The row the first use of a vendor writes to the installation's log while `relay.crossVendor` allows it by default
 * (permissive-defaults §2.4): global, acknowledged, the same data classes a consent covers, its command the vendor's and the
 * policy's (`default-allow:<vendor key>:<policy>`), so a repeat is the same command and the row says by its identity that the
 * default wrote it (consentSourceOf). It is the trace of what left, not a decision of the user's: a withdrawal after it is the
 * user's, and wins.
 */
export function defaultAllowAppend(vendor: VendorKey, authKind: string | null, now: number): ConsentAppend {
  return { commandId: defaultAllowCommand(vendor, CONSENT_POLICY), vendor, scope: { kind: "global" }, decision: "acknowledged", categories: [...CONSENT_CATEGORIES], policyVersion: CONSENT_POLICY, authKind, decidedAt: now };
}
/** The command identity of the consent a send carries in the installation's log: unique across Sessions, the same for a replay. */
export function consentCommandOf(session: SessionId, command: string): string {
  return "send-" + createHash("sha256").update(session + "\0" + command, "utf8").digest("hex").slice(0, 40);
}

// ---------------------------------------------------------------------------------------------------------------------
// The open's check (k)
// ---------------------------------------------------------------------------------------------------------------------

/** A check as it was planned and answered, kept until it is committed with the Turn's next transaction. */
export interface Check {
  readonly plan: VerifyPlan;
  readonly result: VerifyResult;
  /** An unknown Turn without a packet: whether its own entry follows its position (unavailable: the Driver contract cannot ask, G068 phase two). */
  readonly turnEntry?: MarkerResult;
  /**
   * Why the Driver was not asked and every marker is unavailable (G068 fix batch 2, M-3): `alone`, the open of an input the user
   * sends alone, which a read could only stop; `connection`, a binding an earlier read of this process broke the connection of.
   */
  readonly unasked?: "alone" | "connection";
  readonly moment: "open" | "settled";
}
/**
 * The markers a plan asks the Driver about, oldest first, each once (the newest row of a packet), ≤ MAX_VERIFY_MARKERS, and
 * for an unconfirmed clear whether the history is empty (even with no marker); null when the plan asks nothing.
 */
export function verifyRequestOf(plan: VerifyPlan): VerifyRequest | null {
  const markers = (() => {
    switch (plan.kind) {
      case "skip": return [];
      case "pending": return [...plan.earlier.filter(marker => marker.packetId !== plan.marker.packetId).slice(-(MAX_VERIFY_MARKERS - 1)), plan.marker];
      case "clear": case "suspect": { const listed = plan.kind === "clear" ? plan.chain : plan.markers; return [...listed, ...(plan.carried === null ? [] : [plan.carried])]; }
      case "unknown_turn": return plan.marker === null ? [] : [plan.marker];
      case "synced": return [plan.marker];
    }
  })();
  const seen = new Set<string>(), unique = [...markers].reverse().filter(marker => { if (seen.has(marker.packetId)) return false; seen.add(marker.packetId); return true; }).reverse().slice(-MAX_VERIFY_MARKERS);
  // An unconfirmed clear asks whether the history is empty even with no marker to look for (rule 1, F1): a binding that stood on
  // no packet has no chain, and an empty replay still confirms its clear (found pinning G067-C04's replay, R9f).
  if (unique.length === 0) return plan.kind === "clear" ? { markers: [], historyEmpty: true } : null;
  return { markers: unique.map(marker => ({ packetId: marker.packetId, position: marker.position })), historyEmpty: plan.kind === "clear" };
}
/** A check no Driver answered: every marker unavailable, nothing else known. */
export function unavailableResult(request: VerifyRequest | null): VerifyResult {
  return { markers: (request?.markers ?? []).map(marker => ({ packetId: marker.packetId, result: "unavailable" as const })), historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 0 };
}
/**
 * A Driver's answer, checked: a marker it did not answer, or answered with anything but a marker result, is unavailable; a
 * history it says nothing of is null; a cursor that is not one is none. Never trusts more than it can read.
 */
export function checkedResult(raw: unknown, request: VerifyRequest): VerifyResult {
  const item = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Readonly<Record<string, unknown>> : {};
  const answered = Array.isArray(item.markers) ? item.markers as readonly unknown[] : [];
  const resultOf = (packetId: string): MarkerResult => {
    for (const entry of answered) {
      const row = entry !== null && typeof entry === "object" ? entry as Readonly<Record<string, unknown>> : {};
      if (row.packetId === packetId && typeof row.result === "string" && (MARKER_RESULTS as readonly string[]).includes(row.result)) return row.result as MarkerResult;
    }
    return "unavailable";
  };
  let compaction: VerifyResult["compaction"] = null;
  const cursor = item.compaction !== null && typeof item.compaction === "object" ? item.compaction as Readonly<Record<string, unknown>> : null;
  if (cursor !== null && typeof cursor.count === "number" && Number.isSafeInteger(cursor.count) && cursor.count >= 0) {
    try { compaction = { count: cursor.count, digest: cursor.digest === null ? null : fingerprint(cursor.digest) }; } catch { compaction = null; }
  }
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { markers: request.markers.map(marker => ({ packetId: marker.packetId, result: resultOf(marker.packetId) })),
    historyEmpty: typeof item.historyEmpty === "boolean" ? item.historyEmpty : null, compaction, foreignAfterLast: count(item.foreignAfterLast), verifyMs: count(item.verifyMs) ?? 0 };
}
/** k on `relay` with a check, its decisions taking `at`; a refused k (a bug) leaves the binding as it was and decides nothing. */
export function checkStep(relay: BindingRelayState, check: Check, inRunId: RunId | null, at: RelayAt): Extract<RelayStep, { kind: "applied" }> {
  const outcome = step(relay, { kind: "verified", plan: check.plan, result: check.result, ...(check.turnEntry === undefined ? {} : { turnEntry: check.turnEntry }), inRunId, at });
  return outcome.kind === "applied" ? outcome : { kind: "applied", relay, changed: false, deliveries: [], note: { verified: "undecided" } };
}
/** Whether a check is worth an event (§14.2: an ordinary Turn adds none): it looked for something, or it changed the binding. */
export function checkWorthAnEvent(check: Check, outcome: Extract<RelayStep, { kind: "applied" }>): boolean {
  // A packet whose row is missing is never let pass as an ordinary skip (ADR-055's stage-two seam): it is always recorded.
  return check.plan.kind !== "skip" || outcome.changed || outcome.deliveries.length > 0 || outcome.note.rowMissing === true;
}
/** The marks a step's recorded decisions made, for the event committed with them (the read path finds them there). */
export function recordedMarks(outcome: { readonly relay: BindingRelayState; readonly deliveries: readonly DeliveryChange[] }, packetOf: (run: RunId) => RelayPacketId | null): readonly { readonly runId: RunId; readonly mark: DeliveredMark | null }[] {
  const sync = outcome.relay.sync;
  return outcome.deliveries.flatMap(change => {
    if (change.kind !== "outcome" || change.outcome.kind !== "recorded") return [];
    const packet = packetOf(change.runId);
    return [{ runId: change.runId, mark: sync.kind === "synced" && packet !== null && sync.mark.lastPacketId === packet ? sync.mark : null }];
  });
}
/** Every marker a plan names, oldest first. */
function plannedMarkers(plan: VerifyPlan): readonly { readonly runId: RunId; readonly packetId: RelayPacketId }[] {
  switch (plan.kind) {
    case "skip": return [];
    case "pending": return [...plan.earlier, plan.marker];
    case "clear": return [...plan.chain, ...(plan.carried === null ? [] : [plan.carried])];
    case "suspect": return [...plan.markers, ...(plan.carried === null ? [] : [plan.carried])];
    case "unknown_turn": return plan.marker === null ? [] : [plan.marker];
    case "synced": return [plan.marker];
  }
}
/** `relay.verified` (§14.2) for a check and what it concluded; `recorded` names the marks its E2 decisions made. */
export function verifiedEvent(check: Check, outcome: Extract<RelayStep, { kind: "applied" }>, inRunId: RunId | null): EventDraft {
  const note: StepNote = outcome.note, markers = plannedMarkers(check.plan);
  const packetOf = (run: RunId) => markers.find(marker => marker.runId === run)?.packetId ?? null;
  const asked = verifyRequestOf(check.plan)?.markers ?? [];
  const verifiedRunIds = asked.flatMap(marker => { const run = markers.findLast(item => item.packetId === marker.packetId)?.runId; return run === undefined ? [] : [run]; });
  return { type: "relay.verified", data: { verifiedRunIds, moment: check.moment, plan: check.plan.kind === "skip" ? "skip:" + check.plan.reason : check.plan.kind,
    markers: check.result.markers, historyEmpty: check.result.historyEmpty, compaction: check.result.compaction, foreignAfterLast: check.result.foreignAfterLast, verifyMs: check.result.verifyMs,
    ...(check.turnEntry === undefined ? {} : { turnEntry: check.turnEntry }), ...(check.unasked === undefined ? {} : { unasked: check.unasked }),
    result: note.verified ?? "skipped", ...(note.choice === undefined ? {} : { choice: note.choice }),
    ...(note.rowMissing ? { rowMissing: true } : {}), inRunId, recorded: recordedMarks(outcome, packetOf), sync: outcome.relay.sync.kind } };
}
/**
 * `relay.verified` (§14.2) for the user's choice of the complete packet when it had nothing to carry (R5): no check ran and
 * nothing was asked; the binding stands on the prior the choice moved back to (`result` nothing_owed), the input went as typed.
 */
export function retreatEvent(relay: BindingRelayState, inRunId: RunId): EventDraft {
  return { type: "relay.verified", data: { verifiedRunIds: [], moment: "open", plan: "choice", markers: [], historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 0,
    result: "nothing_owed", retreat: true, nothingToAttach: true, inRunId, recorded: [], sync: relay.sync.kind } };
}
/** A step's delivery changes as Store writes (an insert takes the Runtime's fields of the row, given separately). */
export function outcomeWrites(changes: readonly DeliveryChange[]): readonly RelayDeliveryWrite[] {
  return changes.flatMap(change => change.kind === "outcome" ? [{ kind: "outcome" as const, runId: change.runId, outcome: change.outcome }] : []);
}

// ---------------------------------------------------------------------------------------------------------------------
// What the Turn sends
// ---------------------------------------------------------------------------------------------------------------------

/** What a content Turn does with what its binding is owed, before anything is rendered. */
export type TurnDecision =
  /**
   * b: nothing owed; the input goes as typed. `nothingToAttach`: the user asked for the history (`attach:"full"`, or `resend`)
   * and there was none to attach (A9, R10c), which `run.context_prepared` records. `retreat`: that request was the complete
   * packet on a suspect binding, whose retreated prior owes nothing; the binding stands on that prior (R5).
   */
  | { readonly kind: "plain"; readonly foreign: boolean; readonly nothingToAttach: boolean; readonly retreat?: { readonly firstFromSeq: number | null };
      /**
       * A7 point 4: the binding waited for a packet and nothing is owed any more (the facts it carried are no longer owed, as
       * once the user excludes them): it goes back to the packet's prior (`owed_nothing`), its row stays as it is, and the user
       * is not asked; the input goes as typed.
       */
      readonly owedNothing?: true }
  /**
   * n: the input goes as typed and what is owed stays owed, the binding exactly as it was (no row, no evidence). `by` "user":
   * the user chose it (`attach:"none"`). `by` "policy" (permissive-defaults §0): the policy did, because a packet is still
   * unconfirmed after its resend and nothing newer is owed, a binding in doubt owes nothing new, or something concerning the
   * packet alone could not be done (`cause`; `reason` for a failed preparation).
   */
  | { readonly kind: "alone"; readonly by: "user" | "policy"; readonly cause?: DecisionCause; readonly reason?: string }
  /**
   * a: a packet of `need`, on `relay` (the binding after the check, a confirmed clear and a retreat). `by`: "need" an ordinary
   * packet of what is owed; "user" the user's `attach:"full"` or `resend`; "policy" an automatic resend (once per packet, and
   * again only for newer facts: `resend.by` "grown"), or the complete packet again on a binding in doubt that is owed newer facts.
   * `lateDelivery` is what the state machine is told (the Driver's declaration, but never in auto mode: a late write lands once
   * more at most).
   */
  | { readonly kind: "carry"; readonly need: Owed; readonly attachOverride: boolean; readonly resend: { readonly by: "auto" | "user" | "grown"; readonly of: RunId } | null; readonly retreat?: { readonly firstFromSeq: number | null };
      /** The binding state `need` was reckoned on: a retreat's prior (retreatedPrior), else the binding as it is. */
      readonly on: BindingRelayState; readonly by: "need" | "policy" | "user"; readonly cause?: DecisionCause; readonly lateDelivery: boolean };
/** The causes a decision of the policy answers (contracts/relay.ts DECISION_CAUSES). */
export type DecisionCause = NonNullable<RelayDecision["cause"]>;
export interface DecideInput {
  /** The binding's relay state after the open's check (and the user's ［确认已清空］). */
  readonly relay: BindingRelayState;
  readonly harnessId: string;
  readonly controlId: string;
  readonly facts: readonly RelayFact[];
  readonly originHistory: boolean;
  readonly choices: RelayChoices;
  readonly declaration: RelayDeclaration;
  /** The epoch's first packet's fromSeq (planReturnVerify's), for a retreat. */
  readonly firstFromSeq: number | null;
  /** The Run that carried the pending packet: its delivery row's, else the latest Run whose relay names it; null when none does. */
  readonly pendingRun: RunId | null;
  readonly recoveryFailed: boolean;
  /** The first native epoch the binding's own native session holds (heldSinceIn); absent, only its current one. */
  readonly heldSince?: number;
  /** `relay.whenUnsure`: "auto" settles what the relay is unsure of by itself; "ask" (absent too) asks as the strict design did. */
  readonly whenUnsure?: "auto" | "ask" | (() => "auto" | "ask");
  /**
   * The through seq of the packet `need` would make (rangeOf of its Runs): what a pending packet's newer facts are measured by.
   * Absent: the latest seq of `need`'s facts, which is the same when every fact is carried.
   */
  readonly topOf?: (need: Owed) => number;
}
/** A packet identity no text has (its digits are all 0), for asking the state machine whether a carry would be refused. */
const PROBE_PACKET = relayPacketId("relay-" + "0".repeat(20));
const PROBE_RANGE: SourceRange = { fromSeq: 0, throughSeq: 0, fromRun: 0, throughRun: 0 };
const PROBE_RUN = "run-relay-probe" as RunId;
/**
 * The choice between b, n and a for a content Turn after the open's check (§7.2, §9; permissive-defaults §0–§2): sent alone when
 * the user chose it (by "user"); a pending packet resent once by itself when the Driver can show delivery (pendingResend), and
 * again only for newer facts (`grown`) — otherwise sent alone by the policy; a suspect binding owed newer facts than its mark by
 * the complete packet again in the same native session (a with retreat), owed nothing new alone by the policy (or as typed when
 * nothing foreign is there or the cause allows it); otherwise a packet exactly when something is owed. The user's own choice of
 * `attach:"full"`, `resend` (and the request's other explicit choices) is acted on as before, and when it cannot be done the Run
 * fails. A request for the history with nothing to attach goes as typed and says so (`nothingToAttach`, A9). With `whenUnsure`
 * "ask" (the strict design) each of the policy's decisions is the user's choice instead: RELAY_CHOICE_REQUIRED.
 * Throws the relay error the Run then fails with, undispatched.
 */
export function decideTurn(input: DecideInput): TurnDecision {
  const { relay, choices, declaration } = input, sync = relay.sync;
  if (choices.attach === "none") return { kind: "alone", by: "user" };
  // Read only where it matters (the preferences are an installation read, which an ordinary Turn that owes nothing never makes).
  let known: "auto" | "ask" | null = null;
  const mode = (): "auto" | "ask" => known ??= typeof input.whenUnsure === "function" ? input.whenUnsure() : input.whenUnsure ?? "ask";
  const lenient = (): boolean => mode() === "auto" && !explicitChoice(choices);
  const needOn = (state: BindingRelayState, attachOverride: boolean) => owed(state, input.harnessId, input.controlId, input.facts,
    { originHistory: input.originHistory, attachOverride, ...(input.heldSince === undefined ? {} : { heldSince: input.heldSince }) });
  const nonEmpty = (need: Owed) => need.facts.length > 0 || need.origin;
  const topOf = input.topOf ?? ((need: Owed) => Math.max(0, ...need.facts.map(fact => fact.seq)));
  const alone = (cause: DecisionCause, reason?: string): TurnDecision => ({ kind: "alone", by: "policy", cause, ...(reason === undefined ? {} : { reason }) });
  /** A refusal of the state machine: the policy's send alone when it may settle it, else the error the Run fails with. */
  const refusedBy = (outcome: RelayStep): TurnDecision | null => {
    if (outcome.kind !== "refused") return null;
    const refusal = outcome.refusal;
    if (lenient()) return refusal.code === "RELAY_CHOICE_REQUIRED" ? alone(refusal.cause) : refusal.code === "verify_first" ? alone(causeOf(refusal.cause)) : alone("prepare_failed", "render");
    if (refusal.code === "RELAY_CHOICE_REQUIRED") throw choiceRequired(refusal.cause);
    if (refusal.code === "verify_first") throw choiceRequired(causeOf(refusal.cause));
    throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render" }, "没能准备交接单：送达状态不允许这样发送（" + refusal.why + "）。这条消息没有发出。");
  };
  /** The relay's record could not be recovered: nothing it keeps can be carried; the policy sends the input alone. */
  const unrecovered = (): TurnDecision => { if (lenient()) return alone("recovery_failed"); throw recoveryFailed(); };
  // A late write lands once more at most when the policy resends by itself: the resend's template carries its own dedupe line.
  const lateDelivery = (): boolean => mode() === "auto" ? false : declaration.lateDelivery;
  const foreign = () => foreignAtAll(input.facts, input.harnessId, input.controlId, relay, input.originHistory, input.heldSince);
  // The user asked for the history: the complete packet or the pending one again ("附上交接单", "补发完整交接单", "再附一次").
  const requested = choices.attach === "full" || choices.resend === true;
  if (sync.kind === "pending") {
    const attachOverride = sync.attachOverride || choices.attach === "full", need = needOn(relay, attachOverride);
    // A7 point 4 (G072): nothing is owed any more, so nothing is sent again and nobody is asked; the binding goes back to the prior.
    if (!nonEmpty(need)) {
      const back = refusedBy(step(relay, { kind: "owed_nothing" }));
      if (back !== null) return back;
      return { kind: "plain", foreign: foreign(), nothingToAttach: requested, owedNothing: true };
    }
    if (input.recoveryFailed) return unrecovered();
    // On a pending packet `attach:"full"` is the user's resend too (R9b). The automatic resend is for a Driver that can show
    // delivery, once; newer facts than the pending packet's are sent again with it (permissive-defaults §2.1).
    const plan = pendingResend(sync, { lateDelivery: declaration.lateDelivery, evidence: declaration.evidence }, mode(), topOf(need) > sync.range.throughSeq) as ResendPlan;
    const by = plan === "auto" ? "auto" as const : requested ? "user" as const : plan === "grown" ? "grown" as const : null;
    if (by === null) { if (plan === "alone") return alone("delivery_unconfirmed"); throw choiceRequired("delivery_unconfirmed"); }
    // Without the Run that carried it, a resend could not name what it supersedes (G068 phase two): the policy sends alone, a
    // request that asked for it fails, and the strict design lets the user decide.
    if (input.pendingRun === null) { if (lenient()) return alone("delivery_unconfirmed"); throw choiceRequired("delivery_unconfirmed"); }
    const resend = { by, of: input.pendingRun };
    const refused = refusedBy(step(relay, { kind: "carry", runId: PROBE_RUN, packet: { id: PROBE_PACKET, range: by === "grown" ? { ...PROBE_RANGE, throughSeq: topOf(need) } : PROBE_RANGE }, attachOverride, lateDelivery: lateDelivery(), resend }));
    if (refused !== null) return refused;
    return { kind: "carry", need, attachOverride, resend, on: relay, by: by === "user" ? "user" : "policy", ...(by === "user" ? {} : { cause: "delivery_unconfirmed" as const }), lateDelivery: lateDelivery() };
  }
  const attachOverride = choices.attach === "full";
  if (sync.kind === "suspect") {
    // A suspect mark is not trusted, so a packet is never built on it: what is owed above it would make the binding synced on a
    // mark nothing has checked. The user's complete packet retreats to the epoch base first; so does the policy's, when newer
    // facts are owed than the mark claims (permissive-defaults §2.2) — and with nothing newer owed the input goes alone and the
    // binding stays in doubt until the next open's check or the user settles it.
    const policyRetreat = !requested && lenient() && nonEmpty(needOn(relay, false));
    if (requested || policyRetreat) {
      const on: BindingRelayState = { ...relay, sync: retreatedPrior(relay, input.firstFromSeq)! }, need = needOn(on, attachOverride);
      const cause: DecisionCause = sync.cause === "marker_absent" ? "marker_absent" : "verify_required";
      if (!nonEmpty(need)) {
        // Nothing to send again on the prior the choice moves back to (R5): the input goes as typed and the binding stands there,
        // which no check would otherwise ever let it do; a mark that does not come back (legacy) still needs the user.
        const retreat = { firstFromSeq: input.firstFromSeq }, isForeign = foreign();
        const refused = refusedBy(step(relay, { kind: "plain", foreign: isForeign, retreat }));
        if (refused !== null) return refused;
        return { kind: "plain", foreign: isForeign, nothingToAttach: true, retreat };
      }
      if (input.recoveryFailed) return unrecovered();
      return { kind: "carry", need, attachOverride, resend: null, retreat: { firstFromSeq: input.firstFromSeq }, on, by: requested ? "user" : "policy", ...(requested ? {} : { cause }), lateDelivery: lateDelivery() };
    }
  }
  const need = needOn(relay, attachOverride);
  if (!nonEmpty(need)) {
    const isForeign = foreign();
    const refused = refusedBy(step(relay, { kind: "plain", foreign: isForeign }));
    if (refused !== null) return refused;
    return { kind: "plain", foreign: isForeign, nothingToAttach: requested };
  }
  if (input.recoveryFailed) return unrecovered();
  const refused = refusedBy(step(relay, { kind: "carry", runId: PROBE_RUN, packet: { id: PROBE_PACKET, range: PROBE_RANGE }, attachOverride, lateDelivery: lateDelivery(), resend: null }));
  if (refused !== null) return refused;
  return { kind: "carry", need, attachOverride, resend: null, on: relay, by: attachOverride ? "user" : "need", lateDelivery: lateDelivery() };
}
/**
 * What a Turn records of its decision in `run.context_prepared.data.relay.decision` (contracts RelayDecision): the kind, who decided
 * and what for. An ordinary Turn that owes nothing records none (it has no `relay` at all); one asked for the history with none to
 * attach says the user asked; one whose pending packet is no longer owed says the need decided.
 */
export function decisionRecord(decision: TurnDecision | null): RelayDecision | null {
  if (decision === null) return null;
  switch (decision.kind) {
    case "carry": return { kind: "carry", by: decision.by, ...(decision.cause === undefined ? {} : { cause: decision.cause }) };
    case "alone": return { kind: "alone", by: decision.by, ...(decision.cause === undefined ? {} : { cause: decision.cause }), ...(decision.reason === undefined ? {} : { reason: decision.reason }) };
    case "plain": return decision.nothingToAttach ? { kind: "plain", by: "user" } : decision.owedNothing === true ? { kind: "plain", by: "need" } : null;
  }
}
/**
 * Whether a relay failure concerns the packet only, so that the policy sends the input alone instead of failing the Run
 * (permissive-defaults §0 rule 1, rows 13, 15, 16 and 20): the cause it is recorded under, and for a failed preparation the
 * reason. Null when it does not: the strict setting (`whenUnsure` "ask"), a request that steered the relay (rule 3), a failure of
 * the message itself (the target did not start, a limit of the message's own), and a failure the settings themselves name (a
 * data directory in the workspace with `block`, an unprobed Driver with `allowUnprobed` off, a consent the strict preference asks).
 */
export function policyAloneOf(error: unknown, settings: RelaySettings, choices: RelayChoices): { readonly cause: DecisionCause; readonly reason?: string } | null {
  if (settings.whenUnsure !== "auto" || explicitChoice(choices)) return null;
  if (error instanceof RelayError) {
    switch (error.code) {
      case "RELAY_INPUT_LIMIT": return { cause: "input_limit", reason: error.reason };
      case "RELAY_UNAVAILABLE": return error.reason === "recovery_failed" ? { cause: "recovery_failed" } : error.reason === "consent_log_full" ? { cause: "prepare_failed", reason: error.reason } : null;
      case "RELAY_CONSENT_REQUIRED": return settings.crossVendor === "ask" ? null : error.reason === "revoked" ? { cause: "consent_revoked" } : { cause: "consent_goal_only", reason: error.reason };
      case "RELAY_PREPARE_FAILED": return error.reason === "target_start" || error.reason === "classification_changed" ? null : { cause: "prepare_failed", reason: error.reason };
      case "RELAY_CHOICE_REQUIRED": return { cause: error.reason as ChoiceCause };
      default: return null;
    }
  }
  // The known secrets could not be read (relaySecretsOf): no packet can be redacted, so none is sent (INV-29, fail closed).
  if (error instanceof SessionError && error.code === "RELAY_PREPARE_FAILED") return { cause: "prepare_failed", reason: "redaction_failed" };
  return null;
}
/** What `attentionOf` reads of one binding. */
export interface AttentionInput {
  readonly relay: BindingRelayState;
  /** The Session's relay record could not be recovered after a restart (SessionSnapshot.relayRecoveryFailed). */
  readonly recoveryFailed: boolean;
  /** The decision of the latest Turn that ran on the binding, when it has one (decisionRecord). */
  readonly latest: RelayDecision | null;
  /** How many of the conversation's Turns the binding still owes (owed()). */
  readonly owedRuns: number;
}
/**
 * What a binding asks the user to look at (permissive-defaults §2.6; `GET …/relay` gives it per binding): from its sync state —
 * a packet sent and not confirmed, a mark in doubt, a clear not confirmed, a record that could not be recovered — and from what
 * its latest Turn was sent alone for when that outlasts the Turn (a window too small for the smallest packet, a consent withdrawn
 * or for the goal only). Never a block: every option is a way the user may settle it, the next input goes anyway. Null when the
 * binding needs nothing. `key` names the episode: the same cause within one wait for a check is the same key, so a banner shown
 * once and closed does not come back.
 */
export function attentionOf(input: AttentionInput): RelayAttention | null {
  const { relay } = input, sync = relay.sync, counts = (packets: number) => ({ runs: input.owedRuns, packets });
  if (input.recoveryFailed) return { cause: "recovery_failed", options: ["new_native"], counts: counts(0), key: "recovery_failed:" + relay.nativeEpoch };
  if (sync.kind === "pending") return { cause: "delivery_unconfirmed", options: ["attach_full", "new_native"], counts: counts(1 + sync.autoResends + sync.manualResends), key: "delivery_unconfirmed:" + sync.packetId };
  if (sync.kind === "suspect") {
    const cause = sync.cause === "marker_absent" ? "marker_absent" as const : sync.cause === "clear_unconfirmed" ? "clear_unconfirmed" as const : "verify_required" as const;
    const confirmable = sync.cause === "clear_unconfirmed" && sync.floorCandidate !== null && sync.floorCandidate > relay.epochFloor;
    return { cause, options: ["attach_full", "new_native", ...(confirmable ? ["clear_confirmed" as const] : [])], counts: counts(sync.carried === null ? 0 : 1),
      key: cause + ":" + relay.nativeEpoch + ":" + (sync.floorCandidate ?? markOf(sync)?.throughSeq ?? "none") + (sync.carried === null ? "" : ":" + sync.carried.packetId) };
  }
  const latest = input.latest;
  if (input.owedRuns > 0 && latest?.kind === "alone" && latest.by === "policy") {
    if (latest.cause === "input_limit") return { cause: "input_limit", options: [], counts: counts(0), key: "input_limit:" + relay.nativeEpoch };
    if (latest.cause === "consent_revoked" || latest.cause === "consent_goal_only") return { cause: latest.cause, options: ["acknowledge"], counts: counts(0), key: latest.cause + ":" + relay.nativeEpoch };
  }
  return null;
}
/** The Runs of what is owed, in conversation order, each a finished fact whose input came before the current one's. */
export function needRuns(state: SessionSnapshot, current: PublicRun, need: Owed): readonly RunId[] {
  const seqOf = (run: PublicRun) => state.messages.find(message => message.id === run.userMessageId)?.seq ?? Number.MAX_SAFE_INTEGER;
  const before = seqOf(current), owedRuns = new Set<string>(need.facts.map(fact => fact.runId));
  return state.runs.filter(run => owedRuns.has(run.id) && run.id !== current.id && terminal(run.status) && seqOf(run) < before).map(run => run.id);
}
/** The facts of `need` its Runs cover (the ones a packet of `runs` carries), and their range (§4 SourceRange). */
export function rangeOf(state: SessionSnapshot, need: Owed, runs: readonly RunId[]): SourceRange {
  const carried = need.facts.filter(fact => runs.includes(fact.runId)), index = (run: RunId) => state.runs.findIndex(row => row.id === run);
  const seqs = [...carried.map(fact => fact.seq), ...(need.origin ? [0] : [])], indexes = carried.map(fact => index(fact.runId)).filter(value => value >= 0);
  if (seqs.length === 0) return PROBE_RANGE;
  return { fromSeq: Math.min(...seqs), throughSeq: Math.max(...seqs), fromRun: indexes.length ? Math.min(...indexes) : 0, throughRun: indexes.length ? Math.max(...indexes) : 0 };
}
/**
 * The snapshot the packet renderer reads (G070's packet.ts decides between a whole packet and a delta by the target
 * binding's native position): in v13 a delta goes only to a native session known to hold part of the conversation, so the
 * position is shown as none when the binding's mark is none — a first packet not recorded, a clear, a new native session.
 */
export function renderView(state: SessionSnapshot, harnessId: string, controlId: string, relay: BindingRelayState | null): SessionSnapshot {
  if (relay === null || markOf(relay.sync) !== null) return state;
  return { ...state, ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings.map(binding =>
    binding.harnessId === harnessId && binding.controlId === controlId && binding.status !== "archived" ? { ...binding, throughRunId: null } : binding) }) };
}
/** The relay policy the v13 manifest names: the contract's `relay/<n>`; the MVP's own version stays in `run.context_prepared`. */
export const MANIFEST_POLICY = "relay/1" as const;
/**
 * A packet manifest (§4 RelayPacket) for a packet G070's renderer made (its record and text): only what the record, the facts
 * and the budget it was folded to say (G072 fills the target's vendor key, the estimator family, the window's source, the fixed
 * prefix and the caps from windows.ts); what the MVP does not keep stays conservative — no sections, no omission ledger, no
 * re-anchor section, and no token counts of the user's or the models' text (0) — and a reader never reads "complete" or "no
 * omissions" from them (A13). The Store checks it with the text in the same transaction.
 */
export function packetManifest(input: { readonly state: SessionSnapshot; readonly run: PublicRun; readonly relay: BindingRelayState; readonly record: RelayRecord; readonly body: string;
    readonly range: SourceRange; readonly runs: readonly RunId[]; readonly attachOverride: boolean; readonly supersedes: RelayPacketId | null; readonly firstLineOmitted: boolean;
    readonly vendor?: VendorKey; readonly window?: ResolvedWindow; readonly clamped?: readonly ("window" | "input_limit")[] }): RelayPacket {
  const { state, run, record } = input, harnessId = run.selection.harnessId;
  const indexes = input.runs.map(id => state.runs.findIndex(row => row.id === id)).filter(index => index >= 0);
  const sources = new Map<string, { harnessId: string; model: string | null; from: number; through: number }>();
  for (const index of indexes) {
    const source = state.runs[index]!, key = source.selection.harnessId, prior = sources.get(key);
    sources.set(key, prior === undefined ? { harnessId: key, model: source.selection.nativeModel ?? null, from: index, through: index } : { ...prior, through: Math.max(prior.through, index), from: Math.min(prior.from, index) });
  }
  const names = [...sources.values()].slice(0, 64).map(item => ({ harnessId: item.harnessId, model: item.model === null ? null : item.model.slice(0, 1024), runs: [item.from, item.through] as const }));
  const kind = names.length > 1 ? "multiple" as const : names.length === 1 && names[0]!.harnessId === harnessId ? "same_program" as const : "other" as const;
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex") as Fingerprint;
  const vendor = input.vendor ?? ("unknown:" + harnessId) as VendorKey, window = input.window;
  const userCap = Math.min(2500, Math.floor(0.5 * record.budget.cap)), untrustedCap = Math.floor(0.6 * record.budget.cap);
  return {
    id: relayPacketId(record.packetId), kind: record.kind, tier: "standard", complete: record.complete, reanchor: false,
    target: { harnessId, controlId: run.selection.controlId, model: run.selection.nativeModel ?? null, vendor, nativeEpoch: input.relay.nativeEpoch },
    source: { kind, names }, range: input.range, basePacketId: null, supersedes: input.supersedes, policyVersion: MANIFEST_POLICY, language: record.language,
    factsFingerprint: sha(JSON.stringify({ runs: input.runs, range: input.range })), workspaceObservationSeq: null,
    inputs: { attachOverride: input.attachOverride, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: input.firstLineOmitted ? "slash" : null },
    redaction: { profile: "egress", count: record.redactions, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: sha(input.body), bytes: Buffer.byteLength(input.body, "utf8"), estTokens: record.tokens, estimator: "est/2", family: packetFamily(vendor, input.relay.vendorObserved?.modelKey ?? ""), untrustedTokens: 0, userTokens: 0 },
    budget: { capTokens: record.budget.cap, userCap, untrustedCap, window: record.budget.window, fixedPrefix: window?.fixedPrefix ?? 0,
      windowSource: window?.source ?? (record.budget.windowSource === "observed" ? "session_report" : "assumed_cloud"), clampedBy: [...new Set(input.clamped ?? [])] },
    sections: [], fold: indexes.slice(0, RELAY_MAX_RUNS).map(runIndex => ({ kind: "unit" as const, runIndex, grade: record.complete ? "verbatim" as const : "compact" as const, why: "tail" as const })),
    omissions: [], userEdits: [],
  };
}
/** How a Turn continued its context (§12.2), for its `relay`. */
export function continuityOf(decision: TurnDecision | null, record: RelayRecord | null, runs: number): ContinuityLevel {
  if (decision?.kind !== "carry" || record === null) return { kind: "native_resume" };
  return record.kind === "delta" ? { kind: "native_resume_delta", tier: "standard", runs: Math.max(1, Math.min(RELAY_MAX_RUNS, runs)) } : { kind: "rehydrate", tier: "standard", complete: record.complete };
}
export function runRelayOf(packet: RelayPacket | null, continuity: ContinuityLevel, executedOn: ExecutedOn | null): RunRelay {
  return { packetId: packet?.id ?? null, kind: packet === null ? null : packet.kind, continuity, executedOn };
}
/**
 * The keyed digests of a Runtime composed without the installation's relay key (SessionRuntimeOptions.relayKeys; the Gateway's
 * own entries always give one): HMACs under a key made for this owner and never kept, with a subkey per Session as the
 * installation key derives them, so the rows hold nothing anyone can check a guessed input against (INV-29); they identify
 * nothing across owners either. Their rows name the reserved key identity EPHEMERAL_KEY_ID (A17): no reader can check them.
 */
export class UnkeptRelayKeys implements RelayKeyPort {
  readonly #key = randomBytes(32);
  readonly keyId = EPHEMERAL_KEY_ID;
  private subkey(session: SessionId): Buffer { return createHmac("sha256", this.#key).update("relay-tag/1\0" + session, "utf8").digest(); }
  inputHmac(session: SessionId, text: string): HmacDigest { return hmacDigest(createHmac("sha256", this.subkey(session)).update("input\0" + text, "utf8").digest("hex")); }
  setTag(session: SessionId, secrets: readonly string[]): RedactionTag {
    const hmac = createHmac("sha256", this.subkey(session)).update("secret-set\0", "utf8");
    for (const value of [...new Set(secrets)].sort()) hmac.update(value + "\0", "utf8");
    return redactionTag(hmac.digest("hex").slice(0, 8));
  }
  requestFingerprint(session: SessionId, canonical: string): HmacDigest { return hmacDigest(createHmac("sha256", this.subkey(session)).update("request\0" + canonical, "utf8").digest("hex")); }
}
/**
 * The delivery row inserted with a carrying Turn (§4, §6.1): in flight, at the position the Driver read before dispatch,
 * with the cursor the binding knew at delivery — none when the Driver has no compaction evidence, unless its declaration
 * says it never compacts and a probe proved it (then the constant cursor, so the clear check's rule 4 still applies).
 */
export function deliveryRow(input: { readonly change: Extract<DeliveryChange, { kind: "insert" }>; readonly position: DeliveryPosition; readonly relay: BindingRelayState; readonly declaration: RelayDeclaration;
    readonly inputHmac: DeliveryRecord["inputHmac"]; readonly setTag: DeliveryRecord["redaction"]["setHmac"]; readonly rulesVersion: string; readonly keyId: string;
    /** The installation log's seq of the consent the dispatch rests on (§10.4); null when none was needed (same vendor, local exempt) or it is the request's, recorded later. */
    readonly consentLogSeq?: number | null }): DeliveryRecord {
  const { declaration } = input;
  const cursor = declaration.compactionEvidence !== "none" ? input.relay.compactionSeen : declaration.probed ? { count: 0, digest: null } : null;
  return { runId: input.change.runId, packetId: input.change.packetId, channel: declaration.channel, position: input.position, outcome: { kind: "in_flight" }, consentLogSeq: input.consentLogSeq ?? null, inputHmac: input.inputHmac,
    redaction: { rulesVersion: input.rulesVersion.slice(0, 64), keyId: input.keyId, setHmac: input.setTag }, compactionAtDelivery: cursor, resendOf: input.change.resendOf, attachOverride: input.change.attachOverride, verifyMs: null, realized: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// E1 and the settlement
// ---------------------------------------------------------------------------------------------------------------------

/** The packet a carrying Turn sent, as its settlement needs it. */
export interface CarriedTurn { readonly runId: RunId; readonly packetId: RelayPacketId; readonly range: SourceRange; readonly bodySha256: Fingerprint; readonly reanchored: boolean }
/** E1 (§7.1): the native side recorded the Turn's input; g on the pending packet, its row in flight. */
export function recordedStep(relay: BindingRelayState, turn: CarriedTurn, at: RelayAt): Extract<RelayStep, { kind: "applied" }> | null {
  const outcome = step(relay, { kind: "carry_settled", runId: turn.runId, packetId: turn.packetId, bodySha256: turn.bodySha256, reanchored: turn.reanchored, row: "in_flight",
    outcome: { kind: "recorded", evidence: "E1", decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: null } });
  return outcome.kind === "applied" && outcome.changed ? outcome : null;
}
/** What a Turn was authorized to do, as its settlement reads it. */
export type SettledTurn =
  | { readonly kind: "none" }
  | ({ readonly kind: "carry"; readonly recorded: boolean; readonly superseded: { readonly packetId: RelayPacketId; readonly range: SourceRange } | null; readonly resent: boolean } & CarriedTurn)
  | { readonly kind: "plain"; readonly contextThroughSeq: number; readonly agentOutput: boolean; readonly recorded: boolean }
  | { readonly kind: "alone" }
  | { readonly kind: "command"; readonly declared: ContextEffect };
export interface SettleInput {
  readonly relay: BindingRelayState;
  readonly runId: RunId;
  /** The open's check when it was not committed yet (the Turn failed before its authorization). */
  readonly openCheck: Check | null;
  readonly turn: SettledTurn;
  readonly dispatched: boolean;
  readonly status: "completed" | "cancelled" | "failed" | null;
  /** What the Driver knew of the input reaching the native history (BackendResult.input). */
  readonly input: "recorded" | "not_recorded" | undefined;
  readonly noop: boolean;
  /** BackendResult.native: the Driver confirmed this Turn cleared the native history, and whether it replaced the session. */
  readonly cleared: { readonly replaced: boolean } | null;
  readonly declaration: RelayDeclaration;
  /** after_turn's check at the settlement, planned on the provisional settlement (null when none ran). */
  readonly settledCheck: Check | null;
  /** D6: the Turn ended unknown, its process group is confirmed ended, and its native session is continued. */
  readonly unknownTurn: boolean;
  /** The seq of `run.ended`, and the seq the first relay event after it takes. */
  readonly endedSeq: number;
  readonly time: number;
}
export interface Settled {
  /** The binding's relay state after the Turn; with `replaced`, the archived binding keeps its own and the new one takes this. */
  readonly relay: BindingRelayState;
  readonly replaced: boolean;
  readonly deliveries: readonly RelayDeliveryWrite[];
  /** Relay events committed right after `run.ended`, in order (their seqs follow it). */
  readonly events: readonly EventDraft[];
  /** `run.ended.delivery` (§14.2) of a carrying Turn: its packet, outcome and the mark a recording made. */
  readonly delivery: Readonly<Record<string, unknown>> | null;
  readonly binding: Readonly<Record<string, unknown>>;
  /** The settlement's plain input outcome (j), for `run.ended.input`'s note. */
  readonly shown: StepNote["shown"] | null;
}
/**
 * The relay part of `run.ended` (§6.1, §7.2): in order, the open's check when the Turn never got to commit it; the Turn's
 * own event — g/h/i for a carrying Turn by settledOutcome (a resend's h names what it superseded), j for b, nothing for n,
 * the command's effect for a command Turn (commandTurnEvent; a replaced native session is e with `replaced`); after_turn's
 * check; and D6. Each step that is refused leaves the binding as it was (a bug, never a silent advance).
 */
export function settleTurn(input: SettleInput): Settled {
  let relay = input.relay, replaced = false, delivery: Record<string, unknown> | null = null, shown: StepNote["shown"] | null = null;
  const deliveries: RelayDeliveryWrite[] = [], events: EventDraft[] = [], before = relay.sync.kind;
  let nextSeq = input.endedSeq + 1;
  const at = (seq: number): RelayAt => ({ seq, time: input.time });
  const apply = (outcome: RelayStep): Extract<RelayStep, { kind: "applied" }> | null => {
    if (outcome.kind === "refused") return null;
    if (outcome.kind === "replaced") { relay = outcome.relay; replaced = true; deliveries.push(...outcomeWrites(outcome.deliveries)); return null; }
    relay = outcome.relay; deliveries.push(...outcomeWrites(outcome.deliveries)); return outcome;
  };
  const runCheck = (check: Check) => {
    const seq = nextSeq++, outcome = checkStep(relay, check, input.runId, at(seq));
    if (!checkWorthAnEvent(check, outcome)) { nextSeq--; return; }
    relay = outcome.relay; deliveries.push(...outcomeWrites(outcome.deliveries)); events.push(verifiedEvent(check, outcome, input.runId));
  };
  if (input.openCheck !== null) runCheck(input.openCheck);
  const turn = input.turn;
  switch (turn.kind) {
    case "none": case "alone": break;
    case "carry": {
      if (turn.recorded) {
        // E1 decided it before the Turn ended: the settlement finds the row recorded and the binding synced on it (no-op).
        apply(step(relay, { kind: "carry_settled", runId: turn.runId, packetId: turn.packetId, bodySha256: turn.bodySha256, reanchored: turn.reanchored, row: "recorded",
          outcome: { kind: "recorded", evidence: "E1", decidedSeq: input.endedSeq, decidedAt: input.time, verifiedInRun: null } }));
        delivery = { packetId: turn.packetId, outcome: "recorded", evidence: "E1", mark: null };
        break;
      }
      const outcome = settledOutcome({ dispatched: input.dispatched, status: input.status, input: input.input, successProvesRecorded: input.declaration.successProvesRecorded, lateDelivery: input.declaration.lateDelivery }, at(input.endedSeq));
      // A refused resend names the packet it superseded; without it (no row to read it from) its outcome stays unknown, never not recorded.
      const decided = outcome.kind === "not_recorded" && turn.resent && turn.superseded === null ? { kind: "unknown" as const, reason: "no_evidence" as const, decidedSeq: input.endedSeq, decidedAt: input.time } : outcome;
      const settled = apply(step(relay, { kind: "carry_settled", runId: turn.runId, packetId: turn.packetId, bodySha256: turn.bodySha256, reanchored: turn.reanchored, row: "in_flight",
        outcome: decided, ...(turn.resent && turn.superseded !== null ? { superseded: turn.superseded } : {}) }));
      const sync = relay.sync;
      delivery = { packetId: turn.packetId, outcome: decided.kind, ...(decided.kind === "recorded" ? { evidence: decided.evidence } : { reason: decided.reason }),
        mark: settled !== null && decided.kind === "recorded" && sync.kind === "synced" && sync.mark.lastPacketId === turn.packetId ? sync.mark : null };
      break;
    }
    case "plain": {
      if (!input.dispatched) break;
      const known: InputOutcome = turn.recorded || input.input === "recorded" || input.status === "completed" && input.declaration.successProvesRecorded ? "recorded" : input.input === "not_recorded" ? "not_recorded" : "unknown";
      const outcome = apply(step(relay, { kind: "plain_settled", input: known, agentOutput: turn.agentOutput, contextThroughSeq: turn.contextThroughSeq }));
      shown = outcome?.note.shown ?? null;
      break;
    }
    case "command": {
      // A clear the Driver confirmed is e whatever else is known (commandTurnEvent reads `cleared` first).
      const outcomeOf = commandOutcome(input.dispatched, input.status, !input.dispatched ? "not_recorded" : input.input ?? "unknown", input.noop);
      const event: RelayEvent = commandTurnEvent(turn.declared, outcomeOf, { cleared: input.cleared !== null, seq: input.endedSeq, cursor: null });
      apply(event.kind === "cleared" && input.cleared?.replaced === true ? step(relay, { ...event, replaced: true }) : step(relay, event));
      break;
    }
  }
  // A clear the Driver confirmed is e whatever the Turn was (A18, R10d): on a pending packet its delivery is no longer pursued.
  if (turn.kind !== "command" && input.cleared !== null && input.dispatched && !replaced)
    apply(step(relay, { kind: "cleared", seq: input.endedSeq, ...(input.cleared.replaced ? { replaced: true } : {}) }));
  if (input.settledCheck !== null && !replaced) runCheck(input.settledCheck);
  if (input.unknownTurn && !replaced) apply(step(relay, { kind: "unknown_turn_continued" }));
  return { relay, replaced, deliveries, events, delivery, shown,
    binding: { before, after: relay.sync.kind, nativeEpoch: relay.nativeEpoch, epochFloor: relay.epochFloor, packetsInEpoch: relay.packetsInEpoch, ...(replaced ? { replaced: true } : {}) } };
}
