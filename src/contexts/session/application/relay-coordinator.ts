import { createHash, createHmac, randomBytes } from "node:crypto";
import { MAX_VERIFY_MARKERS, type ContextEffect, type VerifyRequest } from "../../../contracts/control.js";
import type { ContentKind } from "../../../contracts/content.js";
import {
  EPHEMERAL_KEY_ID, MARKER_RESULTS, RELAY_MAX_RUNS, RELAY_MAX_SEQ, RelayError, fingerprint, hmacDigest, markOf, parseDeliveredMark, parseExecutedOn, redactionTag, relayPacketId,
  type BindingRelayState, type ContinuityLevel, type DeliveredMark, type DeliveryPosition, type DeliveryRecord, type ExecutedOn, type Fingerprint, type MarkerResult,
  type RelayCapabilities, type RelayDeliveryWrite, type RelayIndexRow, type RelayPacket, type RelayPacketId, type RunRelay, type SourceRange, type VerifyResult,
} from "../../../contracts/relay.js";
import { SessionError, type EventDraft, type HarnessSelection, type NativeSessionBinding, type PublicRun, type RunId, type SessionEvent, type SessionId, type SessionSnapshot } from "../../../contracts/session.js";
import { commandOutcome, dispatched, type InputOutcome } from "../domain/relay/advance.js";
import {
  admitsWithoutChoice, commandTurnEvent, foreignTo, heldSince, owed, pendingResend, retreatedPrior, settledOutcome, settledWithoutCheck, step,
  type BindingDelivery, type ChoiceCause, type DeliveryChange, type Owed, type RelayAt, type RelayEvent, type RelayFact, type RelayStep, type StepNote, type VerifyPlan,
} from "../domain/relay/delivery.js";
import type { RelayRecord } from "../domain/relay/packet.js";
import { initialBindingRelay } from "../domain/relay/migrate.js";
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
 * G072 extends this file with probe gating, consent and vendor keys, the data-root check, windows and the return decision;
 * `admitRelay` marks where its checks go.
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
    return { declared: false, probed: false, verify: "none", successProvesRecorded: false, lateDelivery: true, execution: "gateway", compactionEvidence: "none", channel: "single_text", capabilities: null };
  return { declared: true, probed: capabilities.probed, verify: capabilities.delivery.verify, successProvesRecorded: capabilities.delivery.successProvesRecorded,
    lateDelivery: capabilities.delivery.lateDelivery, execution: capabilities.execution, compactionEvidence: capabilities.compactionEvidence,
    channel: capabilities.placement.parts === "multiple" ? "text_block" : "single_text", capabilities };
}

// ---------------------------------------------------------------------------------------------------------------------
// The request's choices
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What a request chose for the relay (relay-architecture §12.4, the subset the Runtime acts on in G068 phase two): `attach`
 * "none" sends the input alone ("只发这条消息", event n), "full" attaches the history once even below a clear floor ("附上交接
 * 单", attachOverride) and, on a suspect binding, sends the complete packet again in the same native session ("补发完整交接
 * 单"); `resend` sends a pending packet again ("再附一次"), and on a suspect binding also chooses the complete packet;
 * `clearConfirmed` is the user's ［确认已清空］. Tier, native, notes, exclusions, reveals and consent are G072's and G073's.
 */
export interface RelayChoices { readonly attach?: "full" | "none"; readonly resend?: true; readonly clearConfirmed?: true }
/** The request's relay choices, checked; undefined when it makes none ("auto" is none). INVALID_INPUT for anything else. */
export function parseRelayChoices(value: unknown): RelayChoices | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_INPUT", "relay choices must be an object");
  const item = value as Readonly<Record<string, unknown>>;
  if (Object.keys(item).some(key => key !== "attach" && key !== "resend" && key !== "clearConfirmed")) throw new SessionError("INVALID_INPUT", "unsupported relay choice");
  if (item.attach !== undefined && item.attach !== "auto" && item.attach !== "full" && item.attach !== "none") throw new SessionError("INVALID_INPUT", "relay attach must be auto, full or none");
  if (item.resend !== undefined && item.resend !== true) throw new SessionError("INVALID_INPUT", "relay resend must be true");
  if (item.clearConfirmed !== undefined && item.clearConfirmed !== true) throw new SessionError("INVALID_INPUT", "relay clearConfirmed must be true");
  if (item.attach === "none" && (item.resend === true || item.clearConfirmed === true)) throw new SessionError("INVALID_INPUT", "an input sent alone carries no relay choice besides");
  const choices: RelayChoices = { ...(item.attach === "full" || item.attach === "none" ? { attach: item.attach } : {}), ...(item.resend === true ? { resend: true as const } : {}),
    ...(item.clearConfirmed === true ? { clearConfirmed: true as const } : {}) };
  return Object.keys(choices).length ? choices : undefined;
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
}
/**
 * Admission's relay part (§6.1 coordinator.admit, §9): what can be decided before any Run exists, synchronously and without
 * starting anything. Only an input that would carry relay content is asked anything — what is owed (need≠∅), a packet the
 * binding waits for, `attach:"full"`, or foreign facts while the binding's mark is in doubt (suspect of a rewind-like cause);
 * an input sent alone, a command (by the Driver's own reading) and a single-Harness conversation never are. Throws the 409
 * relay error: RELAY_UNAVAILABLE{recovery_failed}; RELAY_CHOICE_REQUIRED{delivery_unconfirmed} for a pending packet no check
 * before dispatch can settle and none may be resent automatically; RELAY_CHOICE_REQUIRED{verify_required | marker_absent} for a
 * suspect binding no check can settle (admitsWithoutChoice) — a Driver that checks at the open is let through and settled
 * there (§9: only what admission can decide is a 409).
 */
export function admitRelay(input: AdmitInput): void {
  const { state, binding, target, capabilities, choices } = input;
  if (target.provider !== undefined || choices.attach === "none" || capabilities === undefined) return;
  const declaration = relayDeclaration(capabilities);
  // A command (or what may be one) carries nothing and is never stopped by the relay (VF1-05).
  if (capabilities !== null && capabilities.commands.classify(input.text, null, input.attachments).kind !== "content") return;
  const relay = binding?.relay ?? initialBindingRelay(state.nativeBindings ?? [], target.harnessId, target.controlId, "new");
  const facts = input.facts({ harnessId: target.harnessId, controlId: target.controlId, nativeEpoch: relay.nativeEpoch }), originHistory = (state.origin?.history.length ?? 0) > 0;
  const sync = relay.sync, since = heldSinceIn(state, target.harnessId, target.controlId, relay);
  const need = owed(relay, target.harnessId, target.controlId, facts, { originHistory, attachOverride: choices.attach === "full" || sync.kind === "pending" && sync.attachOverride, heldSince: since });
  const owes = need.facts.length > 0 || need.origin;
  const doubt = sync.kind === "suspect" && SUSPICIONS.has(sync.cause) && foreignAtAll(facts, target.harnessId, target.controlId, relay, originHistory, since);
  if (!owes && !doubt && sync.kind !== "pending" && choices.attach !== "full") return;
  // G072 inserts its checks here, in the order of §6.1: the probe gate (RELAY_TARGET_UNVERIFIED), the data root of a
  // cross-vendor handoff (RELAY_UNAVAILABLE{data_root_in_workspace}); then the user's choice below; then consent
  // (RELAY_CONSENT_REQUIRED) and MIN_PACKET (RELAY_INPUT_LIMIT).
  if (state.relayRecoveryFailed !== undefined) throw recoveryFailed();
  // The user's "再附一次": `resend`, or `attach:"full"` on a pending packet (R9b), which sends it again too.
  const resend = choices.resend === true || choices.attach === "full";
  if (sync.kind === "pending") {
    // A Driver that checks at the open settles the packet there first; the others already checked (after_turn) or never do.
    if (declaration.verify !== "on_next_open" && pendingResend(sync, declaration.lateDelivery) === "choice" && !resend) throw choiceRequired("delivery_unconfirmed");
    return;
  }
  if (sync.kind === "suspect") {
    if (resend || choices.clearConfirmed === true && sync.cause === "clear_unconfirmed") return;
    if (sync.cause === "legacy" || sync.cause === "marker_absent") { if (owes) throw choiceRequired(causeOf(sync.cause)); return; }
    if (!admitsWithoutChoice(relay, declaration.verify)) throw choiceRequired("verify_required");
    // What the open certainly makes of it is read like any binding (R9a): landing on a pending packet whose automatic resend
    // is spent (the table of unchecked suspicion sends a carried packet back with autoResends 1), the user chooses now.
    const landed = settledWithoutCheck(relay, declaration.verify);
    if (landed?.sync.kind === "pending" && pendingResend(landed.sync, declaration.lateDelivery) === "choice") throw choiceRequired("delivery_unconfirmed");
  }
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
    ...(check.turnEntry === undefined ? {} : { turnEntry: check.turnEntry }), result: note.verified ?? "skipped", ...(note.choice === undefined ? {} : { choice: note.choice }),
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
  | { readonly kind: "plain"; readonly foreign: boolean; readonly nothingToAttach: boolean; readonly retreat?: { readonly firstFromSeq: number | null } }
  /** n: the user chose to send it alone; what is owed stays owed. */
  | { readonly kind: "alone" }
  /** a: a packet of `need`, on `relay` (the binding after the check, a confirmed clear and a retreat). */
  | { readonly kind: "carry"; readonly need: Owed; readonly attachOverride: boolean; readonly resend: { readonly by: "auto" | "user"; readonly of: RunId } | null; readonly retreat?: { readonly firstFromSeq: number | null };
      /** The binding state `need` was reckoned on: a retreat's prior (retreatedPrior), else the binding as it is. */
      readonly on: BindingRelayState };
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
}
/** A packet identity no text has (its digits are all 0), for asking the state machine whether a carry would be refused. */
const PROBE_PACKET = relayPacketId("relay-" + "0".repeat(20));
const PROBE_RANGE: SourceRange = { fromSeq: 0, throughSeq: 0, fromRun: 0, throughRun: 0 };
const PROBE_RUN = "run-relay-probe" as RunId;
/**
 * The choice between b, n and a for a content Turn after the open's check (§7.2, §9): sent alone when the user chose it;
 * a pending packet resent once by itself when it may be (pendingResend), otherwise only on the user's `resend` or
 * `attach:"full"`; a suspect binding with a packet only on the user's choice of the complete packet (a with retreat) — as typed,
 * standing on the retreated prior, when that prior owes nothing (R5) — as typed when nothing foreign is there or nothing is
 * owed and the cause allows it, else the user's choice (verify_first → RELAY_CHOICE_REQUIRED); otherwise a packet exactly when
 * something is owed. A request for the history with nothing to attach goes as typed and says so (`nothingToAttach`, A9).
 * Throws the relay error the Run then fails with, undispatched.
 */
export function decideTurn(input: DecideInput): TurnDecision {
  const { relay, choices, declaration } = input, sync = relay.sync;
  if (choices.attach === "none") return { kind: "alone" };
  const needOn = (state: BindingRelayState, attachOverride: boolean) => owed(state, input.harnessId, input.controlId, input.facts,
    { originHistory: input.originHistory, attachOverride, ...(input.heldSince === undefined ? {} : { heldSince: input.heldSince }) });
  const nonEmpty = (need: Owed) => need.facts.length > 0 || need.origin;
  const refusedBy = (outcome: RelayStep): void => {
    if (outcome.kind !== "refused") return;
    const refusal = outcome.refusal;
    if (refusal.code === "RELAY_CHOICE_REQUIRED") throw choiceRequired(refusal.cause);
    if (refusal.code === "verify_first") throw choiceRequired(causeOf(refusal.cause));
    throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render" }, "没能准备交接单：送达状态不允许这样发送（" + refusal.why + "）。这条消息没有发出。");
  };
  const foreign = () => foreignAtAll(input.facts, input.harnessId, input.controlId, relay, input.originHistory, input.heldSince);
  // The user asked for the history: the complete packet or the pending one again ("附上交接单", "补发完整交接单", "再附一次").
  const requested = choices.attach === "full" || choices.resend === true;
  if (sync.kind === "pending") {
    const attachOverride = sync.attachOverride || choices.attach === "full", need = needOn(relay, attachOverride);
    if (!nonEmpty(need)) throw choiceRequired("delivery_unconfirmed");
    if (input.recoveryFailed) throw recoveryFailed();
    // On a pending packet `attach:"full"` is the user's resend too (R9b).
    const by = pendingResend(sync, declaration.lateDelivery) === "auto" ? "auto" as const : requested ? "user" as const : null;
    if (by === null) throw choiceRequired("delivery_unconfirmed");
    // Without the Run that carried it, a resend could not name what it supersedes: the user decides instead (G068 phase two).
    if (input.pendingRun === null) throw choiceRequired("delivery_unconfirmed");
    const resend = { by, of: input.pendingRun };
    refusedBy(step(relay, { kind: "carry", runId: PROBE_RUN, packet: { id: PROBE_PACKET, range: PROBE_RANGE }, attachOverride, lateDelivery: declaration.lateDelivery, resend }));
    return { kind: "carry", need, attachOverride, resend, on: relay };
  }
  const attachOverride = choices.attach === "full";
  if (sync.kind === "suspect" && requested) {
    const on: BindingRelayState = { ...relay, sync: retreatedPrior(relay, input.firstFromSeq)! }, need = needOn(on, attachOverride);
    if (!nonEmpty(need)) {
      // Nothing to send again on the prior the choice moves back to (R5): the input goes as typed and the binding stands there,
      // which no check would otherwise ever let it do; a mark that does not come back (legacy) still needs the user.
      const retreat = { firstFromSeq: input.firstFromSeq }, isForeign = foreign();
      refusedBy(step(relay, { kind: "plain", foreign: isForeign, retreat }));
      return { kind: "plain", foreign: isForeign, nothingToAttach: true, retreat };
    }
    if (input.recoveryFailed) throw recoveryFailed();
    return { kind: "carry", need, attachOverride, resend: null, retreat: { firstFromSeq: input.firstFromSeq }, on };
  }
  const need = needOn(relay, attachOverride);
  if (!nonEmpty(need)) {
    const isForeign = foreign();
    refusedBy(step(relay, { kind: "plain", foreign: isForeign }));
    return { kind: "plain", foreign: isForeign, nothingToAttach: requested };
  }
  if (input.recoveryFailed) throw recoveryFailed();
  refusedBy(step(relay, { kind: "carry", runId: PROBE_RUN, packet: { id: PROBE_PACKET, range: PROBE_RANGE }, attachOverride, lateDelivery: declaration.lateDelivery, resend: null }));
  return { kind: "carry", need, attachOverride, resend: null, on: relay };
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
 * A packet manifest (§4 RelayPacket) for a packet G070's renderer made (its record and text): only what the record and
 * the facts say; counts the MVP does not keep are 0 or empty. The Store checks it with the text in the same transaction.
 */
export function packetManifest(input: { readonly state: SessionSnapshot; readonly run: PublicRun; readonly relay: BindingRelayState; readonly record: RelayRecord; readonly body: string;
    readonly range: SourceRange; readonly runs: readonly RunId[]; readonly attachOverride: boolean; readonly supersedes: RelayPacketId | null; readonly firstLineOmitted: boolean }): RelayPacket {
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
  return {
    id: relayPacketId(record.packetId), kind: record.kind, tier: "standard", complete: record.complete, reanchor: false,
    target: { harnessId, controlId: run.selection.controlId, model: run.selection.nativeModel ?? null, vendor: ("unknown:" + harnessId) as RelayPacket["target"]["vendor"], nativeEpoch: input.relay.nativeEpoch },
    source: { kind, names }, range: input.range, basePacketId: null, supersedes: input.supersedes, policyVersion: MANIFEST_POLICY, language: record.language,
    factsFingerprint: sha(JSON.stringify({ runs: input.runs, range: input.range })), workspaceObservationSeq: null,
    inputs: { attachOverride: input.attachOverride, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: input.firstLineOmitted ? "slash" : null },
    redaction: { profile: "egress", count: record.redactions, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: sha(input.body), bytes: Buffer.byteLength(input.body, "utf8"), estTokens: record.tokens, estimator: "est/2", family: "unknown", untrustedTokens: 0, userTokens: 0 },
    budget: { capTokens: record.budget.cap, userCap: 0, untrustedCap: 0, window: record.budget.window, fixedPrefix: 0, windowSource: record.budget.windowSource === "observed" ? "session_report" : "assumed_cloud", clampedBy: [] },
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
 * The keyed digests a delivery row needs (the current input's, the redaction set's tag) until the session subkeys of
 * G070's relay-keys exist: an HMAC under a key made for this owner and never kept, so the rows hold nothing anyone can
 * check a guessed input against (INV-29); they identify nothing across owners either. Their rows name the reserved key
 * identity EPHEMERAL_KEY_ID (A17), which no reader can check them with.
 */
export class EphemeralKeys {
  private readonly key = randomBytes(32);
  readonly keyId = EPHEMERAL_KEY_ID;
  input(session: SessionId, text: string): DeliveryRecord["inputHmac"] { return hmacDigest(createHmac("sha256", this.key).update("input\0" + session + "\0" + text, "utf8").digest("hex")); }
  setTag(session: SessionId): DeliveryRecord["redaction"]["setHmac"] { return redactionTag(createHmac("sha256", this.key).update("secret-set\0" + session, "utf8").digest("hex").slice(0, 8)); }
}
/**
 * The delivery row inserted with a carrying Turn (§4, §6.1): in flight, at the position the Driver read before dispatch,
 * with the cursor the binding knew at delivery — none when the Driver has no compaction evidence, unless its declaration
 * says it never compacts and a probe proved it (then the constant cursor, so the clear check's rule 4 still applies).
 */
export function deliveryRow(input: { readonly change: Extract<DeliveryChange, { kind: "insert" }>; readonly position: DeliveryPosition; readonly relay: BindingRelayState; readonly declaration: RelayDeclaration;
    readonly inputHmac: DeliveryRecord["inputHmac"]; readonly setTag: DeliveryRecord["redaction"]["setHmac"]; readonly rulesVersion: string; readonly keyId: string }): DeliveryRecord {
  const { declaration } = input;
  const cursor = declaration.compactionEvidence !== "none" ? input.relay.compactionSeen : declaration.probed ? { count: 0, digest: null } : null;
  return { runId: input.change.runId, packetId: input.change.packetId, channel: declaration.channel, position: input.position, outcome: { kind: "in_flight" }, consentLogSeq: null, inputHmac: input.inputHmac,
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
