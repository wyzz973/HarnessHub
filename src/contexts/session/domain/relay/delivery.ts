import { createHash } from "node:crypto";
import {
  DELIVERY_TRANSITIONS, EMPTY_CHAIN, RELAY_MAX_RUNS, markOf, parseBindingRelayState,
  type BindingRelayState, type BindingSync, type ContextEffect, type DeliveredMark, type DeliveryOutcome, type DeliveryPosition, type DeliveryRecord, type DeliveryStatus,
  type EvidenceClass, type ExecutedOn, type Fingerprint, type MarkerResult, type RelayPacketId, type SourceRange, type SuspectCause, type SyncPrior, type VerifyResult,
} from "../../../../contracts/relay.js";
import { SessionError, type NativeSessionBinding, type RunId } from "../../../../contracts/session.js";
import type { CommandOutcome } from "./advance.js";
import { initialBindingRelay } from "./migrate.js";

/**
 * The relay's delivery state machine (ADR-055 §7.2): one native binding's sync state moved by one event, with the change of
 * the delivery row that goes with it, so that a caller writes both in one transaction (E1 is written with its event, the
 * settlement with `run.ended`, a check with the Turn that ran it). It also holds the check part of §7.3's planReturn (what
 * to check, given the binding's state and its Driver's `verify` mode), the facts a binding still owes (need), and the pure
 * rules that turn a Turn's end into an event (E3, command effects).
 *
 * Pure and synchronous: nothing here reads a clock, a store or a process; times and seqs come with the events. Every
 * (state, event) pair of the table has a defined result. A pair the table marks "does not happen" (—), and an event whose
 * preconditions the table states but the caller did not meet, is a `refused` step that names why, never a silent no-op;
 * every state a step returns is checked by the v13 parser (its byte budget included), and every delivery change it
 * returns follows DELIVERY_TRANSITIONS.
 *
 * The table's events, by letter: a carry, b plain, n alone, c command_kept, d compaction, e cleared, e′ clear_unconfirmed,
 * f rewound, g/h/i carry_settled (recorded / not_recorded / unknown), j plain_settled, k verified, l reset. m (migration)
 * lives in migrate.ts. Two events the table's rows reference outside its columns are here too: `unknown_turn_continued`,
 * the D6 path (§9 S6) that makes a binding suspect{unknown_turn} and saves `carried`; and the user's choice of "补发完整交接单"
 * on a suspect binding, which is event a with `retreat` (§9 "需要用户选择").
 */

// ---------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------

/** A compaction cursor as a binding keeps it (`compactionSeen`) and a delivery row records it at delivery. */
export interface Cursor { readonly count: number; readonly digest: Fingerprint | null }
/** Where and when a change is committed: the seq its decision takes (the event it is committed with) and the Runtime's time. */
export interface RelayAt { readonly seq: number; readonly time: number }
/** A packet as a carrying Turn's event names it: its identity and the facts it covers. */
export interface CarriedPacket { readonly id: RelayPacketId; readonly range: SourceRange }
/** A delivery outcome once decided. */
export type DecidedOutcome = Exclude<DeliveryOutcome, { readonly kind: "in_flight" }>;

/**
 * One event on one binding (§7.2). `seq` fields are fact seqs (the `run.ended` seq of the Run); the settlement and check
 * events carry the delivery row's current status as `row`, so the change they return can be checked against
 * DELIVERY_TRANSITIONS here.
 */
export type RelayEvent =
  /**
   * a: a content Turn that carries packet `packet` (committed with its `run.context_prepared`, before dispatch). On a pending
   * binding only as a resend of the pending packet: `resend.by` "auto" (allowed once, never with `lateDelivery`) or "user"
   * (`relay.resend`). On a suspect binding only with `retreat`: a check that decides anything leaves the binding synced or
   * fresh, so what remains is the user's choice of sending the complete packet again in the same native session, which
   * first moves the mark back to max(first packet of the epoch's fromSeq − 1, epochFloor) (§9, retreatedPrior); without it
   * the step is refused verify_first. `attachOverride` is the request's `relay.attach:"full"`.
   */
  | { readonly kind: "carry"; readonly runId: RunId; readonly packet: CarriedPacket; readonly attachOverride: boolean; readonly lateDelivery: boolean;
      readonly resend: { readonly by: "auto" | "user"; readonly of: RunId } | null; readonly retreat?: { readonly firstFromSeq: number | null } }
  /** b: a content Turn without a packet while nothing is owed (need=∅); `foreign` is F≠∅ (the Session has foreign facts at all). */
  | { readonly kind: "plain"; readonly foreign: boolean }
  /** n: a content Turn without a packet while facts are owed: only after the user chose `relay.attach:"none"`. */
  | { readonly kind: "alone" }
  /** c: a command Turn whose effect is keep or none (or that did not run). */
  | { readonly kind: "command_kept" }
  /** d: a compact command that ran, or a compaction cursor the Driver reported; `cursor` null when none was reported. */
  | { readonly kind: "compaction"; readonly cursor: Cursor | null }
  /**
   * e: a clear command the Hub confirmed (`native.cleared`, a fixed receipt, a new session seen); `seq` is its `run.ended` seq.
   * `replaced`: the Driver ended the native session and opened a new one (Claude's synthesized clear, §7.5): the binding is
   * archived as it is and the cleared state belongs to the new binding of the same Harness control.
   */
  | { readonly kind: "cleared"; readonly seq: number; readonly replaced?: boolean }
  /** e′: a clear command whose effect could not be confirmed at settlement; `seq` is its `run.ended` seq. */
  | { readonly kind: "clear_unconfirmed"; readonly seq: number }
  /** f: a rewind command, or a command whose effect is unknown. */
  | { readonly kind: "rewound"; readonly cause: "rewind" | "unknown_command" }
  /**
   * g / h / i: the carrying Turn's delivery decided (recorded by E1, E2 or E3; not recorded; unknown). `bodySha256` is the
   * packet text's digest (the chain), `reanchored` whether the packet carried the re-anchor section, `row` the row's status now.
   */
  | { readonly kind: "carry_settled"; readonly runId: RunId; readonly packetId: RelayPacketId; readonly bodySha256: Fingerprint; readonly reanchored: boolean; readonly row: DeliveryStatus; readonly outcome: DecidedOutcome }
  /** j: b's settlement. `input` is what is known of its input reaching the native history; `agentOutput` an agent output seen. */
  | { readonly kind: "plain_settled"; readonly input: "recorded" | "not_recorded" | "unknown"; readonly agentOutput: boolean; readonly contextThroughSeq: number }
  /**
   * k: the result of a check planReturnVerify planned, marker by marker. `turnEntry` answers an unknown Turn without a packet
   * (whether its own user entry follows its position); `inRunId` is the Run the check ran in.
   */
  | { readonly kind: "verified"; readonly plan: VerifyPlan; readonly result: VerifyResult; readonly turnEntry?: MarkerResult; readonly inRunId: RunId | null; readonly at: RelayAt }
  /** l: native-reset: this binding is archived and the next one of its Harness control starts; `bindings` are the Session's. */
  | { readonly kind: "reset"; readonly bindings: readonly NativeSessionBinding[]; readonly harnessId: string; readonly controlId: string }
  /**
   * D6 (§9 S6): a process Driver's Turn ended unknown, the Hub confirmed its process group ended, and the user continues the
   * original native session: the binding becomes suspect{unknown_turn}; a pending packet is saved in `carried`.
   */
  | { readonly kind: "unknown_turn_continued" };
export type RelayEventKind = RelayEvent["kind"];
/** The 14 events of §7.2's table, by their letters. */
export const RELAY_EVENT_LETTERS = ["a", "b", "n", "c", "d", "e", "e′", "f", "g", "h", "i", "j", "k", "l"] as const;
export type RelayEventLetter = typeof RELAY_EVENT_LETTERS[number];
/** The letter of an event in §7.2's table; null for the D6 event, which the table names only in its rows. */
export function eventLetter(event: RelayEvent): RelayEventLetter | null {
  switch (event.kind) {
    case "carry": return "a";
    case "plain": return "b";
    case "alone": return "n";
    case "command_kept": return "c";
    case "compaction": return "d";
    case "cleared": return "e";
    case "clear_unconfirmed": return "e′";
    case "rewound": return "f";
    case "carry_settled": return event.outcome.kind === "recorded" ? "g" : event.outcome.kind === "not_recorded" ? "h" : "i";
    case "plain_settled": return "j";
    case "verified": return "k";
    case "reset": return "l";
    case "unknown_turn_continued": return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------------

/** A delivery row change to write with the step's state: an insert in flight, or an outcome along DELIVERY_TRANSITIONS. */
export type DeliveryChange =
  | { readonly kind: "insert"; readonly runId: RunId; readonly packetId: RelayPacketId; readonly attachOverride: boolean; readonly resendOf: RunId | null }
  | { readonly kind: "outcome"; readonly runId: RunId; readonly from: DeliveryStatus; readonly outcome: DecidedOutcome };
/** What a check concluded, for its `relay.verified` event (§14.2). */
export type VerifiedOutcome = "nothing_owed" | "recorded" | "unconfirmed" | "kept" | "retreated" | "reanchored" | "marker_absent" | "cleared" | "restored" | "undecided" | "skipped";
/** The 409 cause the next content input meets at admission when this state stays as it is (§9 "需要用户选择"). */
export type ChoiceCause = "delivery_unconfirmed" | "verify_required" | "marker_absent";
export interface StepNote {
  /** j's words for the Turn: its input was not sent ("没有发出"), or not confirmed ("未确认"). */
  readonly shown?: "not_sent" | "unconfirmed";
  readonly verified?: VerifiedOutcome;
  readonly choice?: ChoiceCause;
}
/** Why a step is refused: a cell of the table that does not happen, a precondition not met, or a bound. */
export type Refusal =
  | { readonly code: "not_applicable"; readonly why: string }
  | { readonly code: "RELAY_CHOICE_REQUIRED"; readonly cause: ChoiceCause }
  | { readonly code: "verify_first"; readonly cause: SuspectCause }
  | { readonly code: "invalid"; readonly why: string };
export type RelayStep =
  /** The binding's next relay state (the same value when `changed` is false) and the delivery changes to write with it. */
  | { readonly kind: "applied"; readonly relay: BindingRelayState; readonly changed: boolean; readonly deliveries: readonly DeliveryChange[]; readonly note: StepNote }
  /** l: the binding is archived with `archived` (its relay state, frozen) and the new binding starts with `relay`. */
  | { readonly kind: "replaced"; readonly archived: BindingRelayState; readonly relay: BindingRelayState; readonly deliveries: readonly DeliveryChange[]; readonly note: StepNote }
  | { readonly kind: "refused"; readonly refusal: Refusal };

// ---------------------------------------------------------------------------------------------------------------------
// Small rules
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The chain of a mark a packet makes: sha256 of the prior mark's chain and the packet text's sha256, both as lower-case hex,
 * concatenated (§7.2 `sha256(prior.chain ‖ P.body.sha256)`). A binding without a mark chains from EMPTY_CHAIN, the chain of
 * a mark no packet built (sha256("")).
 */
export function chainAfter(prior: Fingerprint | null, bodySha256: Fingerprint): Fingerprint {
  return createHash("sha256").update((prior ?? EMPTY_CHAIN) + bodySha256, "utf8").digest("hex") as Fingerprint;
}
function sameCursor(left: Cursor | null, right: Cursor | null): boolean { return left?.count === right?.count && (left?.digest ?? null) === (right?.digest ?? null); }
/**
 * The basis a fresh state takes when a check leaves a binding without a mark: user_cleared after a confirmed clear of its
 * lineage (a floor), reset after an earlier native session of its Harness control, new otherwise.
 */
function freshBasis(relay: BindingRelayState): "new" | "user_cleared" | "reset" {
  return relay.epochFloor >= 0 ? "user_cleared" : relay.nativeEpoch > 1 ? "reset" : "new";
}
/** A sync state with the mark `mark`: synced, or fresh when there is none. */
function standing(relay: BindingRelayState, mark: DeliveredMark | null): SyncPrior {
  return mark === null ? { kind: "fresh", basis: freshBasis(relay) } : { kind: "synced", mark };
}
/**
 * The mark of a binding none of whose packets of this epoch is in its native history any more (§7.2 suspect k, VF1-07):
 * max(first packet of the epoch's fromSeq − 1, epochFloor). It claims nothing a packet brought; the foreign facts at or
 * below it are those the first packet was built above. The E2 check is what established it. Null below 0.
 */
function epochBase(relay: BindingRelayState, firstFromSeq: number | null): DeliveredMark | null {
  const seq = Math.max(firstFromSeq === null ? -1 : firstFromSeq - 1, relay.epochFloor);
  return seq < 0 ? null : { throughSeq: seq, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "E2", basis: "evidence" };
}
/** A prior saved inside `carried`, which carries nothing itself (§4). */
function bare(prior: SyncPrior): SyncPrior { return prior.kind === "suspect" && prior.carried !== null ? { ...prior, carried: null } : prior; }
function suspect(mark: DeliveredMark | null, cause: SuspectCause, floorCandidate: number | null): SyncPrior { return { kind: "suspect", mark, cause, floorCandidate, carried: null }; }
const recorded = (evidence: EvidenceClass, at: RelayAt, inRun: RunId | null): DecidedOutcome => ({ kind: "recorded", evidence, decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: inRun });
const unknownOutcome = (reason: Extract<DecidedOutcome, { kind: "unknown" }>["reason"], at: RelayAt): DecidedOutcome => ({ kind: "unknown", reason, decidedSeq: at.seq, decidedAt: at.time });
/** The unknown reason a marker result gives a still-unconfirmed delivery. */
function unknownReason(result: MarkerResult): Extract<DecidedOutcome, { kind: "unknown" }>["reason"] {
  switch (result) {
    case "absent": return "absent";
    case "compacted": return "compacted";
    case "outside_window": return "outside_window";
    case "unavailable": case "present": return "verify_unavailable";
  }
}

/**
 * What a settled carrying Turn's delivery is (§7.1, E3 and not_recorded): never dispatched is not recorded; the Driver's own
 * `input` decides when it gives one (a not-recorded `reason` of the Driver's, else rejected_before_insert); a completed Turn
 * proves recorded only where the Driver declares `successProvesRecorded`; a cancelled Turn of a Driver that declares
 * `lateDelivery` is unknown{late_delivery}; anything else is unknown{no_evidence}. The outcome follows from evidence alone,
 * never from the Turn's status as such. E1 is decided when its event arrives, not here.
 */
export function settledOutcome(facts: {
  readonly dispatched: boolean; readonly status: "completed" | "cancelled" | "failed" | null; readonly input: "recorded" | "not_recorded" | undefined;
  readonly notRecorded?: Extract<DecidedOutcome, { kind: "not_recorded" }>["reason"]; readonly successProvesRecorded: boolean; readonly lateDelivery: boolean;
}, at: RelayAt): DecidedOutcome {
  if (!facts.dispatched) return { kind: "not_recorded", reason: "never_dispatched", decidedSeq: at.seq, decidedAt: at.time };
  if (facts.input === "recorded") return recorded("E3", at, null);
  if (facts.input === "not_recorded") return { kind: "not_recorded", reason: facts.notRecorded ?? "rejected_before_insert", decidedSeq: at.seq, decidedAt: at.time };
  if (facts.status === "completed" && facts.successProvesRecorded) return recorded("E3", at, null);
  if (facts.status === "cancelled" && facts.lateDelivery) return unknownOutcome("late_delivery", at);
  return unknownOutcome("no_evidence", at);
}

/**
 * The event of a settled command Turn (§7.4: effect = declared effect ∧ it ran). A command that did not run or changed
 * nothing is c; a confirmed clear (`cleared`, or the Driver's `native.cleared` whatever was declared) is e; a clear that ran
 * or may have run without confirmation is e′; a compact that ran is d (with the cursor the Driver reported); a rewind that
 * ran is f{rewind}; any other effect that may have changed the context is f{unknown_command}.
 */
export function commandTurnEvent(declared: ContextEffect, outcome: CommandOutcome, facts: { readonly cleared: boolean; readonly seq: number; readonly cursor: Cursor | null }): RelayEvent {
  if (facts.cleared) return { kind: "cleared", seq: facts.seq };
  if (outcome === "not_recorded" || outcome === "noop" || declared === "keep" || declared === "none") return { kind: "command_kept" };
  if (declared === "clear") return { kind: "clear_unconfirmed", seq: facts.seq };
  if (outcome === "executed" && declared === "compact") return { kind: "compaction", cursor: facts.cursor };
  if (outcome === "executed" && declared === "rewind") return { kind: "rewound", cause: "rewind" };
  return { kind: "rewound", cause: "unknown_command" };
}

/**
 * What the next content input of a pending binding does once its check left the packet unconfirmed (§7.2 pending i, §7.4):
 * an automatic resend while none was made and the Driver does not declare `lateDelivery`, otherwise the user's choice
 * (409 RELAY_CHOICE_REQUIRED{delivery_unconfirmed}). Null when the binding is not pending.
 */
export function pendingResend(sync: BindingSync, lateDelivery: boolean): "auto" | "choice" | null {
  if (sync.kind !== "pending") return null;
  return sync.autoResends === 0 && !lateDelivery ? "auto" : "choice";
}

/**
 * Whether a kept native process may run the binding's next Turn without opening it again (§7.4, VF1-09): not while a Driver
 * that checks on the next open (`on_next_open`) has the binding pending or suspect, and never while a clear is unconfirmed;
 * the process is closed first and the open's replay is checked.
 */
export function mayReuseKept(relay: BindingRelayState, verify: "after_turn" | "on_next_open" | "none"): boolean {
  if (relay.sync.kind === "suspect" && relay.sync.cause === "clear_unconfirmed") return false;
  return !(verify === "on_next_open" && (relay.sync.kind === "pending" || relay.sync.kind === "suspect"));
}

// ---------------------------------------------------------------------------------------------------------------------
// need
// ---------------------------------------------------------------------------------------------------------------------

/** One public fact: a finished, dispatched content Run with its fact seq (its `run.ended` seq, or recovery's) and where it ran. */
export interface RelayFact { readonly runId: RunId; readonly seq: number; readonly executedOn: ExecutedOn | null }
export interface Owed { readonly facts: readonly RelayFact[]; readonly origin: boolean }
/** Whether `fact` is foreign to the binding of `harnessId`/`controlId` in its current epoch (§2: not run there in that epoch). */
export function foreignTo(fact: RelayFact, harnessId: string, controlId: string, relay: BindingRelayState): boolean {
  return fact.executedOn === null || fact.executedOn.harnessId !== harnessId || fact.executedOn.controlId !== controlId || fact.executedOn.nativeEpoch !== relay.nativeEpoch;
}
/**
 * What the binding still owes (need, §2, §6.3): the foreign facts above max(mark, epochFloor), in seq order, and the history
 * the Session started from (fact seq 0) when its native session does not hold it and nothing at or above 0 is known.
 * `attachOverride` (the user's one-time `relay.attach:"full"`) ignores the floor, which brings back the facts before a
 * clear, the binding's own earlier epochs included (§7.4). A pending binding owes from its prior's mark: the pending
 * packet is not known to be there.
 */
export function owed(relay: BindingRelayState, harnessId: string, controlId: string, facts: readonly RelayFact[], options: { readonly originHistory: boolean; readonly attachOverride?: boolean }): Owed {
  const mark = markOf(relay.sync)?.throughSeq ?? -1, lower = options.attachOverride === true ? mark : Math.max(mark, relay.epochFloor);
  return { facts: facts.filter(fact => fact.seq > lower && foreignTo(fact, harnessId, controlId, relay)).sort((left, right) => left.seq - right.seq),
    origin: options.originHistory && !relay.originIncluded && lower < 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// planReturn: the check part (§7.3)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One delivery row of the binding as a check needs it: the row, the epoch and range of its packet, its text digest and
 * re-anchor flag (from the packet's manifest), and for a recorded row the mark its recording made (the sync committed with
 * it), which a check falls back to when the packets after it are missing.
 */
export interface BindingDelivery {
  readonly record: DeliveryRecord;
  readonly nativeEpoch: number;
  readonly range: SourceRange;
  readonly bodySha256: Fingerprint;
  readonly reanchor: boolean;
  readonly mark: DeliveredMark | null;
}
/** A marker a check asks the Driver about: a packet's title line after the position its delivery recorded. */
export interface PlannedMarker {
  readonly runId: RunId;
  readonly packetId: RelayPacketId;
  readonly position: DeliveryPosition;
  readonly compactionAtDelivery: Cursor | null;
  readonly range: SourceRange;
  readonly bodySha256: Fingerprint;
  readonly reanchor: boolean;
  readonly mark: DeliveredMark | null;
  readonly row: DeliveryStatus;
}
/** At most this many recorded packets of the epoch are checked for a suspect binding (§7.1, §7.3). */
export const SUSPECT_MARKERS = 4;
export type VerifyPlan =
  | { readonly kind: "skip"; readonly reason: "fresh" | "no_marker" | "not_now" | "unavailable" }
  /** Only the pending packet's own title line (VF1-01); `earlier` are the packets it superseded, a late write may show them. */
  | { readonly kind: "pending"; readonly marker: PlannedMarker; readonly earlier: readonly PlannedMarker[] }
  /** An unconfirmed clear: whether the history is empty, and which of the epoch's recorded packets are still there. */
  | { readonly kind: "clear"; readonly markers: readonly PlannedMarker[]; readonly firstFromSeq: number | null }
  /** The epoch's last ≤ SUSPECT_MARKERS recorded packets, oldest first. */
  | { readonly kind: "suspect"; readonly markers: readonly PlannedMarker[]; readonly firstFromSeq: number | null }
  /** D6: the unknown Turn's user entry: its carried packet's title line, or (`marker` null) its own entry. */
  | { readonly kind: "unknown_turn"; readonly marker: PlannedMarker | null }
  /** The last marker of a synced binding. */
  | { readonly kind: "synced"; readonly marker: PlannedMarker };
export interface PlanContext {
  /** The Driver's declared `delivery.verify`. */
  readonly verify: "after_turn" | "on_next_open" | "none";
  /** When the plan is made: at the open before a Turn's input, or at a Turn's settlement. */
  readonly moment: "open" | "settled";
  /** The binding's delivery rows, in Run order. */
  readonly deliveries: readonly BindingDelivery[];
}
function planned(row: BindingDelivery): PlannedMarker {
  return { runId: row.record.runId, packetId: row.record.packetId, position: row.record.position, compactionAtDelivery: row.record.compactionAtDelivery, range: row.range,
    bodySha256: row.bodySha256, reanchor: row.reanchor, mark: row.mark, row: row.record.outcome.kind };
}
/**
 * What to check before a binding's next input or after its Turn (the check part of §7.3's planReturn): a pending binding
 * checks only its pending packet's own title line, the first packet of an epoch included (VF1-01); an unconfirmed clear checks
 * whether the history is empty and which recorded packets are still there; an unknown Turn continued (D6) checks its own
 * user entry; another suspect binding with a packet mark checks the epoch's last ≤4 recorded packets; a synced binding with a
 * packet mark checks its last one; everything else is skipped (a mark of the origin, legacy or native has no marker,
 * RT1-M11). A Driver checks at the open (`on_next_open`) or at the settlement (`after_turn`), never at the other moment;
 * `none` never checks. Costs and the choice between continuing and a new native session are not here (return-policy, G072).
 */
export function planReturnVerify(relay: BindingRelayState, context: PlanContext): VerifyPlan {
  const sync = relay.sync;
  if (sync.kind === "fresh") return { kind: "skip", reason: "fresh" };
  if (context.verify === "none") return { kind: "skip", reason: "unavailable" };
  if (context.verify === "on_next_open" ? context.moment !== "open" : context.moment !== "settled") return { kind: "skip", reason: "not_now" };
  const rows = context.deliveries;
  const latest = (packetId: RelayPacketId) => rows.findLast(row => row.record.packetId === packetId);
  const epochRows = rows.filter(row => row.nativeEpoch === relay.nativeEpoch);
  const recordedRows = epochRows.filter(row => row.record.outcome.kind === "recorded" && row.mark !== null);
  const lastRecorded = recordedRows.slice(-SUSPECT_MARKERS).map(planned);
  const firstFromSeq = epochRows[0]?.range.fromSeq ?? null;
  switch (sync.kind) {
    case "pending": {
      const own = latest(sync.packetId);
      if (own === undefined) return { kind: "skip", reason: "no_marker" };
      const earlier: PlannedMarker[] = [];
      for (let previous = own.record.resendOf; previous !== null;) {
        const row = rows.find(item => item.record.runId === previous);
        if (row === undefined || earlier.length >= RELAY_MAX_RUNS) break;
        if (row.record.outcome.kind !== "recorded") earlier.push(planned(row));
        previous = row.record.resendOf;
      }
      return { kind: "pending", marker: planned(own), earlier: earlier.reverse() };
    }
    case "suspect": {
      if (sync.cause === "clear_unconfirmed") return { kind: "clear", markers: lastRecorded, firstFromSeq };
      if (sync.cause === "unknown_turn") {
        if (sync.carried === null) return { kind: "unknown_turn", marker: null };
        const carried = latest(sync.carried.packetId);
        return carried === undefined ? { kind: "skip", reason: "no_marker" } : { kind: "unknown_turn", marker: planned(carried) };
      }
      if (sync.mark?.lastPacketId == null || lastRecorded.length === 0) return { kind: "skip", reason: "no_marker" };
      return { kind: "suspect", markers: lastRecorded, firstFromSeq };
    }
    case "synced": {
      if (sync.mark.lastPacketId === null) return { kind: "skip", reason: "no_marker" };
      const last = latest(sync.mark.lastPacketId);
      return last === undefined ? { kind: "skip", reason: "no_marker" } : { kind: "synced", marker: planned(last) };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------------------------------

const NOTHING: StepNote = {};
function refuse(refusal: Refusal): RelayStep { return { kind: "refused", refusal }; }
function notApplicable(why: string): RelayStep { return refuse({ code: "not_applicable", why }); }
/** The step's state, checked as a v13 snapshot field (bounds and byte budget); an out-of-bound result is refused. */
function applied(before: BindingRelayState, next: BindingRelayState, deliveries: readonly DeliveryChange[] = [], note: StepNote = NOTHING): RelayStep {
  for (const change of deliveries) if (change.kind === "outcome" && !DELIVERY_TRANSITIONS[change.from].includes(change.outcome.kind)) return refuse({ code: "invalid", why: "delivery transition " + change.from + " → " + change.outcome.kind });
  let relay: BindingRelayState;
  try { relay = parseBindingRelayState(next); }
  catch (error) { if (error instanceof SessionError) return refuse({ code: "invalid", why: error.message }); throw error; }
  return { kind: "applied", relay, changed: JSON.stringify(parseBindingRelayState(before)) !== JSON.stringify(relay), deliveries, note };
}
const unchanged = (relay: BindingRelayState, note: StepNote = NOTHING): RelayStep => applied(relay, relay, [], note);
const withSync = (relay: BindingRelayState, sync: BindingSync): BindingRelayState => ({ ...relay, sync });
/** A confirmed clear (e, and an unconfirmed one confirmed by k): a new epoch with its floor, nothing known, nothing owed before it. */
function clearedState(relay: BindingRelayState, floor: number): BindingRelayState {
  return { ...relay, nativeEpoch: relay.nativeEpoch + 1, sync: { kind: "fresh", basis: "user_cleared" }, epochFloor: Math.max(relay.epochFloor, floor), reanchor: false, packetsInEpoch: 0, originIncluded: false, consentKey: null };
}

/**
 * One binding's relay state moved by one event (§7.2), with the delivery row changes that go with it. Total: every state ×
 * event pair returns `applied` (possibly unchanged), `replaced` (l) or `refused` with the reason the table gives.
 */
export function step(relay: BindingRelayState, event: RelayEvent): RelayStep {
  const sync = relay.sync;
  switch (event.kind) {
    case "carry": return carry(relay, event);
    case "plain": {
      if (sync.kind === "pending") return notApplicable("a pending binding owes its packet: a content Turn without a packet is n, after the user chose to send it alone");
      if (sync.kind !== "suspect") return unchanged(relay);
      if (sync.cause === "legacy" || sync.cause === "marker_absent") return unchanged(relay, { verified: "nothing_owed" });
      return event.foreign ? refuse({ code: "verify_first", cause: sync.cause }) : unchanged(relay);
    }
    case "alone": return unchanged(relay);
    case "command_kept": return unchanged(relay);
    case "compaction": {
      if (event.cursor === null || sameCursor(event.cursor, relay.compactionSeen)) return unchanged(relay);
      const reanchor = relay.reanchor || sync.kind === "synced" && relay.packetsInEpoch > 0;
      return applied(relay, { ...relay, compactionSeen: event.cursor, reanchor });
    }
    case "cleared": {
      if (event.seq <= relay.epochFloor) return refuse({ code: "invalid", why: "a clear's seq lies at or below the binding's clear floor" });
      if (event.replaced !== true) return applied(relay, clearedState(relay, event.seq));
      // The new native session takes the next epoch of the lineage: this binding is its latest, so its epoch + 1.
      return { kind: "replaced", archived: relay, relay: parseBindingRelayState(clearedState(relay, event.seq)), deliveries: [], note: NOTHING };
    }
    case "clear_unconfirmed": {
      const floorCandidate = event.seq;
      if (floorCandidate <= relay.epochFloor) return refuse({ code: "invalid", why: "a clear's seq lies at or below the binding's clear floor" });
      return applied(relay, withSync(relay, suspect(markOf(sync), "clear_unconfirmed", floorCandidate)));
    }
    case "rewound": {
      const kept = sync.kind === "suspect" ? sync.floorCandidate : sync.kind === "pending" && sync.prior.kind === "suspect" ? sync.prior.floorCandidate : null;
      return applied(relay, withSync(relay, suspect(markOf(sync), event.cause, kept)));
    }
    case "carry_settled": return carrySettled(relay, event);
    case "plain_settled": {
      if (sync.kind === "pending") return notApplicable("a pending binding never runs b, so it has no b settlement");
      const shown: StepNote = event.input === "not_recorded" ? { shown: "not_sent" } : event.input === "unknown" && !event.agentOutput ? { shown: "unconfirmed" } : NOTHING;
      if (sync.kind !== "fresh" || shown !== NOTHING) return unchanged(relay, shown);
      const throughSeq = Math.max(event.contextThroughSeq, relay.epochFloor, 0);
      return applied(relay, withSync(relay, { kind: "synced", mark: { throughSeq, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" } }));
    }
    case "verified": return verified(relay, event);
    case "reset": {
      const lineage = event.bindings.filter(binding => binding.harnessId === event.harnessId && binding.controlId === event.controlId);
      if (!lineage.some(binding => binding.relay !== undefined && JSON.stringify(binding.relay) === JSON.stringify(relay)))
        return refuse({ code: "invalid", why: "a native reset names the bindings of its own Harness control, this one included" });
      const next = initialBindingRelay(event.bindings, event.harnessId, event.controlId, "new");
      return { kind: "replaced", archived: relay, relay: parseBindingRelayState(next), deliveries: [], note: NOTHING };
    }
    case "unknown_turn_continued": {
      if (sync.kind === "pending")
        return applied(relay, withSync(relay, { kind: "suspect", mark: markOf(sync.prior), cause: "unknown_turn", floorCandidate: sync.prior.kind === "suspect" ? sync.prior.floorCandidate : null,
          carried: { prior: bare(sync.prior), packetId: sync.packetId, range: sync.range } }));
      // A binding already suspect keeps its cause: its own check is the stronger one, and an unknown Turn without a packet
      // finding its entry would otherwise make an untrusted mark synced.
      if (sync.kind === "suspect") return unchanged(relay);
      return applied(relay, withSync(relay, suspect(markOf(sync), "unknown_turn", null)));
    }
  }
}

function carry(relay: BindingRelayState, event: Extract<RelayEvent, { kind: "carry" }>): RelayStep {
  const sync = relay.sync;
  const insert = (attachOverride: boolean): DeliveryChange => ({ kind: "insert", runId: event.runId, packetId: event.packet.id, attachOverride, resendOf: event.resend?.of ?? null });
  if (sync.kind === "pending") {
    if (event.resend === null) return notApplicable("a pending binding carries a packet only as a resend of its pending packet");
    if (event.retreat !== undefined) return refuse({ code: "invalid", why: "only a suspect binding moves its mark back before a complete packet" });
    if (event.resend.by === "auto" && (sync.autoResends !== 0 || event.lateDelivery)) return refuse({ code: "RELAY_CHOICE_REQUIRED", cause: "delivery_unconfirmed" });
    if (event.resend.by === "user" && sync.manualResends >= RELAY_MAX_RUNS) return refuse({ code: "invalid", why: "a packet is sent again at most " + RELAY_MAX_RUNS + " times" });
    // A resend keeps the prior and inherits the one-time attach of the packet it supersedes (VF1-07).
    const attachOverride = sync.attachOverride || event.attachOverride;
    const next: BindingSync = { ...sync, packetId: event.packet.id, range: event.packet.range, attachOverride,
      autoResends: event.resend.by === "auto" ? 1 : sync.autoResends, manualResends: event.resend.by === "user" ? sync.manualResends + 1 : sync.manualResends };
    return applied(relay, withSync(relay, next), [insert(attachOverride)]);
  }
  if (event.resend !== null) return refuse({ code: "invalid", why: "only a pending binding resends a packet" });
  let prior: SyncPrior = sync;
  if (sync.kind === "suspect") {
    // A suspect mark is not trusted: a packet built on it would make it synced on g unchecked (RT2-07's "洗白"). After a check
    // the binding is no longer suspect; what is left is the user's choice of the complete packet again, which moves back first.
    if (event.retreat === undefined) return refuse({ code: "verify_first", cause: sync.cause });
    prior = retreatedPrior(relay, event.retreat.firstFromSeq)!;
  } else if (event.retreat !== undefined) return refuse({ code: "invalid", why: "only a suspect binding moves its mark back before a complete packet" });
  return applied(relay, withSync(relay, { kind: "pending", prior, packetId: event.packet.id, range: event.packet.range, autoResends: 0, manualResends: 0, attachOverride: event.attachOverride }), [insert(event.attachOverride)]);
}

/**
 * The prior a suspect binding's complete packet is built on when the user chooses to send it again in the same native
 * session (§9: "mark 退到 max(本纪元第一份包 range.fromSeq − 1, epochFloor) 后按 a 发包"): its mark moved back to the epoch base,
 * never up, and nothing carried. Null for a binding that is not suspect. The packet's need is computed from this prior.
 */
export function retreatedPrior(relay: BindingRelayState, firstFromSeq: number | null): SyncPrior | null {
  const sync = relay.sync;
  if (sync.kind !== "suspect") return null;
  const base = epochBase(relay, firstFromSeq);
  const mark = sync.mark === null || base === null ? null : base.throughSeq < sync.mark.throughSeq ? base : sync.mark;
  return { ...sync, mark, carried: null };
}

function carrySettled(relay: BindingRelayState, event: Extract<RelayEvent, { kind: "carry_settled" }>): RelayStep {
  const sync = relay.sync;
  if (sync.kind !== "pending") {
    // E1 decided it before the Turn ended: the settlement finds the row recorded and the binding synced on it already.
    if (event.row === "recorded" && sync.kind === "synced" && sync.mark.lastPacketId === event.packetId) return unchanged(relay);
    return notApplicable("only a pending binding has a carrying Turn to settle");
  }
  if (sync.packetId !== event.packetId) return refuse({ code: "invalid", why: "the settled packet is not the binding's pending packet" });
  if (event.row === "recorded") return refuse({ code: "invalid", why: "a recorded delivery leaves its binding pending only by a bug" });
  const change: DeliveryChange = { kind: "outcome", runId: event.runId, from: event.row, outcome: event.outcome };
  switch (event.outcome.kind) {
    case "recorded": {
      const mark: DeliveredMark = { throughSeq: sync.range.throughSeq, chain: chainAfter(markOf(sync.prior)?.chain ?? null, event.bodySha256), lastPacketId: sync.packetId, evidence: event.outcome.evidence, basis: "evidence" };
      return applied(relay, { ...withSync(relay, { kind: "synced", mark }), packetsInEpoch: relay.packetsInEpoch + 1, reanchor: relay.reanchor && !event.reanchored }, [change]);
    }
    // RT2-07: a packet known not to be there goes back to the state before it; its facts are owed again.
    case "not_recorded": return applied(relay, withSync(relay, sync.prior), [change]);
    // Still pending: the next content input checks the packet first, then resends it or asks the user (pendingResend).
    case "unknown": return applied(relay, relay, [change]);
  }
}

function verified(relay: BindingRelayState, event: Extract<RelayEvent, { kind: "verified" }>): RelayStep {
  const sync = relay.sync, plan = event.plan, at = event.at;
  const resultOf = (marker: PlannedMarker): MarkerResult => event.result.markers.find(item => item.packetId === marker.packetId)?.result ?? "unavailable";
  // The check reports the native compaction cursor too; the binding keeps the latest one (VF1-08).
  const cursor: Cursor = event.result.compaction ?? relay.compactionSeen;
  const base: BindingRelayState = event.result.compaction === null ? relay : { ...relay, compactionSeen: event.result.compaction };
  const moved = (marker: PlannedMarker) => marker.compactionAtDelivery !== null && !sameCursor(marker.compactionAtDelivery, cursor);
  /** Positive evidence (E2) decides a row recorded, or corrects an unknown or not-recorded one (RT2-09); a recorded row stays. */
  const recordedRow = (marker: PlannedMarker): DeliveryChange[] => marker.row === "recorded" ? [] : [{ kind: "outcome", runId: marker.runId, from: marker.row, outcome: recorded("E2", at, event.inRunId) }];
  /** A row left unknown with the check's reason (a same-value write that refines the reason, VF1-12). */
  const refine = (marker: PlannedMarker, result: MarkerResult): DeliveryChange[] => [{ kind: "outcome", runId: marker.runId, from: marker.row, outcome: unknownOutcome(unknownReason(result), at) }];
  if (plan.kind === "skip") return unchanged(base, { verified: "skipped" });
  switch (sync.kind) {
    case "fresh": return unchanged(base, { verified: "skipped" });
    case "pending": {
      if (plan.kind !== "pending" || plan.marker.packetId !== sync.packetId) return refuse({ code: "invalid", why: "a pending binding is checked only against its own packet" });
      // A late write: the packets it superseded may show up after their positions; their rows are corrected, the binding is not moved.
      const late = plan.earlier.flatMap(marker => resultOf(marker) === "present" ? recordedRow(marker) : []);
      const result = resultOf(plan.marker);
      if (result === "present") {
        const mark: DeliveredMark = { throughSeq: sync.range.throughSeq, chain: chainAfter(markOf(sync.prior)?.chain ?? null, plan.marker.bodySha256), lastPacketId: sync.packetId, evidence: "E2", basis: "evidence" };
        return applied(relay, { ...withSync(base, { kind: "synced", mark }), packetsInEpoch: relay.packetsInEpoch + 1, reanchor: base.reanchor && !plan.marker.reanchor },
          [...late, ...recordedRow(plan.marker)], { verified: "recorded" });
      }
      return applied(relay, { ...base, reanchor: base.reanchor || result === "compacted" }, [...late, ...refine(plan.marker, result)], { verified: "unconfirmed" });
    }
    case "synced": {
      if (plan.kind !== "synced" || plan.marker.packetId !== sync.mark.lastPacketId) return refuse({ code: "invalid", why: "a synced binding is checked against its last packet" });
      const result = resultOf(plan.marker);
      if (result === "present") return applied(relay, base, [], { verified: "kept" });
      if (result === "outside_window" || result === "unavailable") return applied(relay, base, [], { verified: "undecided" });
      if (result === "compacted" || moved(plan.marker)) return applied(relay, { ...base, reanchor: true }, [], { verified: "reanchored" });
      return applied(relay, withSync(base, suspect(sync.mark, "marker_absent", null)), [], { verified: "marker_absent" });
    }
    case "suspect": {
      if (sync.cause === "unknown_turn") {
        if (plan.kind !== "unknown_turn" || (plan.marker?.packetId ?? null) !== (sync.carried?.packetId ?? null)) return refuse({ code: "invalid", why: "an unknown Turn is checked against its own entry" });
        if (sync.carried !== null && plan.marker !== null) {
          const carried = sync.carried, result = resultOf(plan.marker);
          if (result === "present") {
            const mark: DeliveredMark = { throughSeq: carried.range.throughSeq, chain: chainAfter(markOf(carried.prior)?.chain ?? null, plan.marker.bodySha256), lastPacketId: carried.packetId, evidence: "E2", basis: "evidence" };
            return applied(relay, { ...withSync(base, { kind: "synced", mark }), packetsInEpoch: relay.packetsInEpoch + 1, reanchor: base.reanchor && !plan.marker.reanchor },
              recordedRow(plan.marker), { verified: "recorded" });
          }
          // Absent (or compacted away, which proves no more) goes back to the state before the packet; the next input owes it again.
          if (result === "absent" || result === "compacted")
            return applied(relay, { ...withSync(base, carried.prior), reanchor: base.reanchor || result === "compacted" }, refine(plan.marker, result), { verified: "retreated" });
          return applied(relay, base, [], { verified: "undecided", choice: "verify_required" });
        }
        const result = event.turnEntry ?? "unavailable";
        if (result === "present" || result === "compacted") return applied(relay, { ...withSync(base, standing(base, sync.mark)), reanchor: base.reanchor || result === "compacted" }, [], { verified: "kept" });
        if (result === "absent") return applied(relay, base, [], { verified: "undecided" });
        return applied(relay, base, [], { verified: "undecided", choice: "verify_required" });
      }
      if (sync.cause === "clear_unconfirmed") {
        if (plan.kind !== "clear") return refuse({ code: "invalid", why: "an unconfirmed clear is checked for an empty history and its markers" });
        if (sync.floorCandidate === null) return refuse({ code: "invalid", why: "an unconfirmed clear keeps the seq of its clear" });
        const results = plan.markers.map(resultOf);
        const allGone = plan.markers.length > 0 && results.every(result => result === "absent") && !plan.markers.some(moved);
        if (event.result.historyEmpty === true || allGone) {
          if (sync.floorCandidate <= relay.epochFloor) return refuse({ code: "invalid", why: "a clear's seq lies at or below the binding's clear floor" });
          return applied(relay, clearedState(base, sync.floorCandidate), [], { verified: "cleared" });
        }
        // The clear did not happen: the binding is what it was before it, as far as the markers still show (§7.4).
        if (results.includes("present")) return markers(relay, base, sync.mark, plan.markers, results, plan.firstFromSeq, moved, "restored");
        if (plan.markers.length === 0 && event.result.historyEmpty === false) return applied(relay, withSync(base, standing(base, sync.mark)), [], { verified: "restored" });
        return applied(relay, base, [], { verified: "undecided", choice: "verify_required" });
      }
      if (plan.kind !== "suspect") return refuse({ code: "invalid", why: "a suspect binding is checked against its epoch's recorded packets" });
      return markers(relay, base, sync.mark, plan.markers, plan.markers.map(resultOf), plan.firstFromSeq, moved, null);
    }
  }
}

/**
 * The suspect k cell (§7.2): all markers present → synced on the current mark; some present → synced on the newest present
 * marker's mark ("最后一个仍在的标记"), the packets after it owed again; none present and every one absent or compacted →
 * the epoch base (max(first packet's fromSeq − 1, epochFloor)); a compacted marker or a cursor moved since an absent one's
 * delivery also sets reanchor. Markers that only answer outside_window or unavailable decide nothing: with none present the
 * binding stays suspect and the next content input needs the user's choice (verify_required).
 */
function markers(relay: BindingRelayState, base: BindingRelayState, mark: DeliveredMark | null, checked: readonly PlannedMarker[], results: readonly MarkerResult[],
    firstFromSeq: number | null, moved: (marker: PlannedMarker) => boolean, restored: "restored" | null): RelayStep {
  const reanchor = base.reanchor || results.some((result, index) => result === "compacted" || result === "absent" && moved(checked[index]!));
  if (checked.length > 0 && results.every(result => result === "present")) return applied(relay, { ...withSync(base, standing(base, mark)), reanchor }, [], { verified: restored ?? "kept" });
  const newest = results.lastIndexOf("present");
  if (newest >= 0) {
    const kept = checked[newest]!.mark;
    if (kept === null) return refuse({ code: "invalid", why: "a recorded marker keeps the mark its recording made" });
    const back = mark !== null && kept.throughSeq > mark.throughSeq ? mark : kept;
    return applied(relay, { ...withSync(base, standing(base, back)), reanchor }, [], { verified: restored ?? "retreated" });
  }
  if (checked.length > 0 && results.every(result => result === "absent" || result === "compacted"))
    return applied(relay, { ...withSync(base, standing(base, epochBase(base, firstFromSeq))), reanchor }, [], { verified: restored ?? "retreated" });
  return applied(relay, base, [], { verified: "undecided", choice: "verify_required" });
}
