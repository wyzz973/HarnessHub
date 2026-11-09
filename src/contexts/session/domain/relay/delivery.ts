import { createHash } from "node:crypto";
import {
  CARRIED_CAUSES, DELIVERY_TRANSITIONS, EMPTY_CHAIN, RELAY_MAX_RUNS, markOf, parseBindingRelayState,
  type BindingRelayState, type BindingSync, type ContextEffect, type DeliveredMark, type DeliveryOutcome, type DeliveryPosition, type DeliveryRecord, type DeliveryStatus,
  type DeliveryEvidence, type EvidenceClass, type ExecutedOn, type Fingerprint, type MarkerResult, type RelayPacketId, type SourceRange, type SuspectCause, type SyncPrior, type VerifyResult,
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
  /**
   * d: a compact command that ran (`ran`), or a compaction cursor the Driver reported (an automatic compaction: `ran` false).
   * A command that ran while its Driver reports no cursor is still d (F4); `cursor` is null then and the binding's stays.
   */
  | { readonly kind: "compaction"; readonly cursor: Cursor | null; readonly ran: boolean }
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
  | { readonly kind: "carry_settled"; readonly runId: RunId; readonly packetId: RelayPacketId; readonly bodySha256: Fingerprint; readonly reanchored: boolean; readonly row: DeliveryStatus; readonly outcome: DecidedOutcome;
      /**
       * A resend's settlement names the packet it superseded (from its `resendOf` row and that packet's manifest): a resend
       * refused before insertion (h) goes back to waiting for that packet, not to the prior (point 2 of the approval).
       */
      readonly superseded?: { readonly packetId: RelayPacketId; readonly range: SourceRange } }
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
 * A mark that claims no foreign fact a check could find missing, so it comes back without one: none at all; a native mark
 * (only fresh + b + j make it, while nothing was owed, so no foreign fact lies in (epochFloor, mark]); an origin mark (the
 * history the session started from, which the binding has no other way to get again); and an epoch base (an evidence mark
 * without a packet, whose claim is its first packet's prior's). A legacy mark (v12 envelopes have no marker to look for)
 * and a mark of a packet are not.
 */
export function restorable(mark: DeliveredMark | null): boolean {
  return mark === null || mark.lastPacketId === null && (mark.basis === "native" || mark.basis === "origin" || mark.basis === "evidence");
}
/**
 * Whether a suspect binding leaves suspect at the k of its next open whatever that check finds (F2 and the approval agent's
 * decision of 2026-11-10), so admission does not ask the user about it (no 409 verify_required). For a Driver that checks at
 * the open (`on_next_open`) or never (`none`): a rewind, an unknown command or an unconfirmed clear on a restorable mark with
 * nothing carried (it is restored; an empty history confirms the clear instead), and an unknown Turn with nothing carried (its
 * mark stands). With `none`, whose every plan is skip{unavailable}, also a carried packet whose prior's mark is restorable: it
 * goes back to pending and the next input's `delivery_unconfirmed` choice settles it; a Driver that checks decides a carried
 * packet by its check instead, which may leave the binding suspect. An `after_turn` Driver checks only at a settlement, so its
 * open settles nothing: false.
 */
export function resolvesWithoutCheck(relay: BindingRelayState, verify: PlanContext["verify"]): boolean {
  const sync = relay.sync;
  if (sync.kind !== "suspect" || verify === "after_turn") return false;
  if (sync.carried !== null) return verify === "none" && restorable(markOf(sync.carried.prior));
  switch (sync.cause) {
    case "rewind": case "unknown_command": case "clear_unconfirmed": return restorable(sync.mark);
    case "unknown_turn": return true;
    case "legacy": case "marker_absent": return false;
  }
}
/**
 * The mark of a binding none of whose packets of this epoch is in its native history any more (§7.2 suspect k, VF1-07):
 * max(first packet of the epoch's fromSeq − 1, epochFloor). It claims nothing a packet brought; the foreign facts at or
 * below it are those the first packet was built above. A check's retreat marks it E2, the user's choice of sending the complete
 * packet again marks it `choice` (F13). Null below 0.
 */
function epochBase(relay: BindingRelayState, firstFromSeq: number | null, evidence: "E2" | "choice"): DeliveredMark | null {
  const seq = Math.max(firstFromSeq === null ? -1 : firstFromSeq - 1, relay.epochFloor);
  return seq < 0 ? null : { throughSeq: seq, chain: EMPTY_CHAIN, lastPacketId: null, evidence, basis: "evidence" };
}
/**
 * The mark a recorded packet makes (§7.2 g): through its range, chained on its prior's mark, with the evidence that
 * recorded it. A packet the user attached once after a clear may cover only facts at or below the floor; its mark is then
 * the floor, which claims nothing more (need starts above max(mark, epochFloor)) and keeps every mark at or above the floor.
 */
function packetMark(relay: BindingRelayState, prior: SyncPrior, range: SourceRange, packetId: RelayPacketId, bodySha256: Fingerprint, evidence: EvidenceClass): DeliveredMark {
  return { throughSeq: Math.max(range.throughSeq, relay.epochFloor, 0), chain: chainAfter(markOf(prior)?.chain ?? null, bodySha256), lastPacketId: packetId, evidence, basis: "evidence" };
}
/** A prior saved inside `carried`, which carries nothing itself (§4). */
function bare(prior: SyncPrior): SyncPrior { return prior.kind === "suspect" && prior.carried !== null ? { ...prior, carried: null } : prior; }
type Carried = Extract<SyncPrior, { kind: "suspect" }>["carried"];
/** A suspect state: a packet is carried only under CARRIED_CAUSES, and only an unconfirmed clear is marked rewound (§4). */
function suspect(mark: DeliveredMark | null, cause: SuspectCause, floorCandidate: number | null, carried: Carried = null, rewound = false): SyncPrior {
  return { kind: "suspect", mark, cause, floorCandidate, carried: carried !== null && (CARRIED_CAUSES as readonly string[]).includes(cause) ? carried : null,
    rewound: rewound && cause === "clear_unconfirmed" };
}
/**
 * Causes under which markers may be missing for a reason other than a clear: a rewind, an unknown command, a marker found absent.
 * When one of them meets an unconfirmed clear before either is checked (in either order), the binding keeps its mark, the
 * clear's seq and its carried packet, and is marked `rewound`: a marker missing from the chain may then be the rewind's doing,
 * so the clear check's rule 4 does not apply to it (the approval agent's decision of 2026-11-10).
 */
const REWOUND: ReadonlySet<SuspectCause> = new Set(["rewind", "unknown_command", "marker_absent"]);
/**
 * Whether a pending binding's prior holds a rewind-like suspicion not yet checked (its own cause, or an unconfirmed clear
 * already marked rewound, which the user's complete packet kept), so that an unconfirmed clear meeting the packet is rewound.
 */
function rewoundPrior(prior: SyncPrior): boolean { return prior.kind === "suspect" && (REWOUND.has(prior.cause) || prior.rewound); }
/** The packet a pending binding keeps when it becomes suspect (F8): its prior and the pending packet, still to be checked. */
function carriedOf(sync: Extract<BindingSync, { kind: "pending" }>): NonNullable<Extract<SyncPrior, { kind: "suspect" }>["carried"]> {
  return { prior: bare(sync.prior), packetId: sync.packetId, range: sync.range };
}
const recorded = (evidence: DeliveryEvidence, at: RelayAt, inRun: RunId | null): DecidedOutcome => ({ kind: "recorded", evidence, decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: inRun });
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
  if (outcome === "executed" && declared === "compact") return { kind: "compaction", cursor: facts.cursor, ran: true };
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
  /** `decided`: a settlement of a synced binding (after_turn checks a packet still pending, or a binding a command made suspect, F12). */
  | { readonly kind: "skip"; readonly reason: "fresh" | "no_marker" | "not_now" | "unavailable" | "decided" }
  /** Only the pending packet's own title line (VF1-01); `earlier` are the packets it superseded, a late write may show them. */
  | { readonly kind: "pending"; readonly marker: PlannedMarker; readonly earlier: readonly PlannedMarker[] }
  /**
   * An unconfirmed clear (F1): whether the history is empty; the chain the mark stands on (from its last packet back along the
   * delivery rows' chains, ≤ SUSPECT_MARKERS, oldest first; empty for a mark without a packet); and the packet it carries.
   */
  | { readonly kind: "clear"; readonly chain: readonly PlannedMarker[]; readonly carried: PlannedMarker | null; readonly firstFromSeq: number | null }
  /**
   * Another suspect binding: the epoch's last ≤ SUSPECT_MARKERS recorded packets, oldest first, when its mark stands on a packet
   * (none otherwise); and the packet it carries (F8).
   */
  | { readonly kind: "suspect"; readonly markers: readonly PlannedMarker[]; readonly carried: PlannedMarker | null; readonly firstFromSeq: number | null }
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
 * whether the history is empty, the chain its mark stands on (F1) and the packet it carries; an unknown Turn continued (D6)
 * checks its own user entry; another suspect binding checks the epoch's last ≤4 recorded packets when its mark stands on a
 * packet, and the packet it carries (F8); a synced binding with a packet mark checks its last one; everything else is
 * skipped (a mark of the origin, legacy or native has no marker, RT1-M11). A Driver checks at the open (`on_next_open`) or at
 * the settlement (`after_turn`), never at the other moment; `none` never checks. Every plan, a skipped one included, is meant
 * to reach `step` as k: a suspect binding that needs no check is settled there (F2). Costs and the choice between continuing
 * and a new native session are not here (return-policy, G072).
 */
export function planReturnVerify(relay: BindingRelayState, context: PlanContext): VerifyPlan {
  const sync = relay.sync;
  if (sync.kind === "fresh") return { kind: "skip", reason: "fresh" };
  if (context.verify === "none") return { kind: "skip", reason: "unavailable" };
  if (context.verify === "on_next_open" ? context.moment !== "open" : context.moment !== "settled") return { kind: "skip", reason: "not_now" };
  if (sync.kind === "synced" && context.moment === "settled") return { kind: "skip", reason: "decided" };
  const rows = context.deliveries;
  const latest = (packetId: RelayPacketId) => rows.findLast(row => row.record.packetId === packetId);
  const epochRows = rows.filter(row => row.nativeEpoch === relay.nativeEpoch);
  const recordedRows = epochRows.filter(row => row.record.outcome.kind === "recorded" && row.mark !== null);
  const lastRecorded = recordedRows.slice(-SUSPECT_MARKERS).map(planned);
  const firstFromSeq = epochRows[0]?.range.fromSeq ?? null;
  const carriedMarker = (packetId: RelayPacketId | undefined): PlannedMarker | null => { const row = packetId === undefined ? undefined : latest(packetId); return row === undefined ? null : planned(row); };
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
      const carried = carriedMarker(sync.carried?.packetId);
      if (sync.cause === "clear_unconfirmed") return { kind: "clear", chain: chainOf(sync.mark, epochRows).map(planned), carried, firstFromSeq };
      if (sync.cause === "unknown_turn") {
        if (sync.carried === null) return { kind: "unknown_turn", marker: null };
        return carried === null ? { kind: "skip", reason: "no_marker" } : { kind: "unknown_turn", marker: carried };
      }
      const markers = sync.mark?.lastPacketId == null ? [] : lastRecorded;
      if (markers.length === 0 && carried === null) return { kind: "skip", reason: "no_marker" };
      return { kind: "suspect", markers, carried, firstFromSeq };
    }
    case "synced": {
      if (sync.mark.lastPacketId === null) return { kind: "skip", reason: "no_marker" };
      const last = latest(sync.mark.lastPacketId);
      return last === undefined ? { kind: "skip", reason: "no_marker" } : { kind: "synced", marker: planned(last) };
    }
  }
}

/**
 * The recorded rows a mark stands on (F1): the newest row of its last packet whose recording made this very chain, then back
 * along the rows whose mark the next one's chain was built on (chainAfter(prev.mark.chain, row.body) = row.mark.chain), until
 * the head of the chain (built on EMPTY_CHAIN) or SUSPECT_MARKERS rows. Rows a retreat left behind are on no chain the mark
 * stands on, so they are not included. Empty for a mark without a packet, or one whose row is missing.
 */
function chainOf(mark: DeliveredMark | null, rows: readonly BindingDelivery[]): readonly BindingDelivery[] {
  if (mark === null || mark.lastPacketId === null) return [];
  const usable = (row: BindingDelivery) => row.record.outcome.kind === "recorded" && row.mark !== null;
  let index = rows.findLastIndex(row => usable(row) && row.record.packetId === mark.lastPacketId && row.mark!.chain === mark.chain);
  if (index < 0) index = rows.findLastIndex(row => usable(row) && row.record.packetId === mark.lastPacketId);
  if (index < 0) return [];
  const chain: BindingDelivery[] = [rows[index]!];
  while (chain.length < SUSPECT_MARKERS) {
    const current = chain[0]!;
    if (chainAfter(null, current.bodySha256) === current.mark!.chain) break;
    const previous = rows.slice(0, index).findLastIndex(row => usable(row) && chainAfter(row.mark!.chain, current.bodySha256) === current.mark!.chain);
    if (previous < 0) break;
    chain.unshift(rows[previous]!); index = previous;
  }
  return chain;
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
      // F4: a compaction that ran, or a cursor that moved, re-anchors a binding with a packet in this epoch that it may have
      // folded (one recorded, or one pending or carried); a cursor is kept only when one was reported and it moved.
      const moved = event.cursor !== null && !sameCursor(event.cursor, relay.compactionSeen);
      const packets = relay.packetsInEpoch > 0 || sync.kind === "pending" || sync.kind === "suspect" && sync.carried !== null;
      return applied(relay, { ...relay, compactionSeen: moved ? event.cursor! : relay.compactionSeen, reanchor: relay.reanchor || (event.ran || moved) && packets });
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
      // F8: a pending packet stays to be checked (carried); a suspect binding keeps its mark and the packet it carries. A
      // rewind-like suspicion not yet checked marks the clear rewound; a later clear takes the latest seq and keeps the mark.
      if (sync.kind === "pending") return applied(relay, withSync(relay, suspect(markOf(sync.prior), "clear_unconfirmed", floorCandidate, carriedOf(sync), rewoundPrior(sync.prior))));
      if (sync.kind === "suspect") return applied(relay, withSync(relay, suspect(sync.mark, "clear_unconfirmed", floorCandidate, sync.carried, REWOUND.has(sync.cause) || sync.rewound)));
      return applied(relay, withSync(relay, suspect(markOf(sync), "clear_unconfirmed", floorCandidate)));
    }
    case "rewound": {
      // An unconfirmed clear is never replaced by f: its check also finds what a rewind removed, and it holds the clear's seq;
      // it is marked rewound instead, its mark, seq and carried packet kept. Other causes take the latest; a pending packet is
      // carried, a carried one kept (F8).
      if (sync.kind === "pending") {
        const prior = sync.prior;
        if (prior.kind === "suspect" && prior.cause === "clear_unconfirmed")
          return applied(relay, withSync(relay, suspect(prior.mark, "clear_unconfirmed", prior.floorCandidate, carriedOf(sync), true)));
        return applied(relay, withSync(relay, suspect(markOf(prior), event.cause, null, carriedOf(sync))));
      }
      if (sync.kind === "suspect" && sync.cause === "clear_unconfirmed") return applied(relay, withSync(relay, { ...sync, rewound: true }));
      if (sync.kind === "suspect") return applied(relay, withSync(relay, suspect(sync.mark, event.cause, sync.floorCandidate, sync.carried)));
      return applied(relay, withSync(relay, suspect(markOf(sync), event.cause, null)));
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
      // Compared as the parser writes them, so the key order a caller built them in does not matter (F10).
      const own = JSON.stringify(parseBindingRelayState(relay));
      if (!lineage.some(binding => binding.relay !== undefined && JSON.stringify(parseBindingRelayState(binding.relay)) === own))
        return refuse({ code: "invalid", why: "a native reset names the bindings of its own Harness control, this one included" });
      const next = initialBindingRelay(event.bindings, event.harnessId, event.controlId, "new");
      return { kind: "replaced", archived: relay, relay: parseBindingRelayState(next), deliveries: [], note: NOTHING };
    }
    case "unknown_turn_continued": {
      if (sync.kind === "pending") {
        // A packet built on an unconfirmed clear keeps the clear's check (it also checks the carried packet), rewound or not.
        const prior = sync.prior;
        if (prior.kind === "suspect" && prior.cause === "clear_unconfirmed")
          return applied(relay, withSync(relay, suspect(prior.mark, "clear_unconfirmed", prior.floorCandidate, carriedOf(sync), prior.rewound)));
        return applied(relay, withSync(relay, suspect(markOf(prior), "unknown_turn", null, carriedOf(sync))));
      }
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
  const base = epochBase(relay, firstFromSeq, "choice");
  // On a tie the base wins, so the prior never stands on a packet (an unconfirmed clear's chain built on it is then empty). A
  // native mark tied with the base (the first packet built at T + 1) is swapped for the base: both are restorable, only the
  // evidence shown changes (native → choice). The prior keeps `rewound`; the carried packet is no longer checked (its row
  // stays unknown, and the complete packet covers its facts again, at the risk of a repeat the user chose).
  const mark = sync.mark === null || base === null ? null : base.throughSeq <= sync.mark.throughSeq ? base : sync.mark;
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
      const mark = packetMark(relay, sync.prior, sync.range, sync.packetId, event.bodySha256, event.outcome.evidence);
      return applied(relay, { ...withSync(relay, { kind: "synced", mark }), packetsInEpoch: relay.packetsInEpoch + 1, reanchor: relay.reanchor && !event.reanchored }, [change]);
    }
    // RT2-07: a first packet known not to be there goes back to the state before it; its facts are owed again. A resend known
    // not to be there goes back to waiting for the packet it superseded, its counts kept (point 2 of the approval).
    case "not_recorded": {
      const resent = sync.autoResends + sync.manualResends > 0;
      if (resent !== (event.superseded !== undefined)) return refuse({ code: "invalid", why: resent ? "a refused resend names the packet it superseded" : "a first packet supersedes nothing" });
      if (event.superseded !== undefined) return applied(relay, withSync(relay, { ...sync, packetId: event.superseded.packetId, range: event.superseded.range }), [change]);
      return applied(relay, withSync(relay, sync.prior), [change]);
    }
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
  /** F3: a marker absent after the cursor moved since its delivery is classified as compacted (§7.4 ①). */
  const classified = (marker: PlannedMarker): MarkerResult => { const result = resultOf(marker); return result === "absent" && moved(marker) ? "compacted" : result; };
  /** Positive evidence (E2) decides a row recorded, or corrects an unknown or not-recorded one (RT2-09); a recorded row stays. */
  const recordedRow = (marker: PlannedMarker): DeliveryChange[] => marker.row === "recorded" ? [] : [{ kind: "outcome", runId: marker.runId, from: marker.row, outcome: recorded("E2", at, event.inRunId) }];
  /** A row left unknown with the check's reason (a same-value write that refines the reason, VF1-12). */
  const refine = (marker: PlannedMarker, result: MarkerResult): DeliveryChange[] => [{ kind: "outcome", runId: marker.runId, from: marker.row, outcome: unknownOutcome(unknownReason(result), at) }];
  const undecided = () => applied(relay, base, [], { verified: "undecided", choice: "verify_required" });
  /** g on a carried packet found: synced through it, chained on its prior, counted in the epoch. */
  const advance = (carried: NonNullable<Extract<SyncPrior, { kind: "suspect" }>["carried"]>, marker: PlannedMarker, reanchor: boolean, verified: VerifiedOutcome) =>
    applied(relay, { ...withSync(base, { kind: "synced", mark: packetMark(base, carried.prior, carried.range, carried.packetId, marker.bodySha256, "E2") }), packetsInEpoch: relay.packetsInEpoch + 1,
      reanchor: base.reanchor && !marker.reanchor || reanchor }, recordedRow(marker), { verified });
  if (plan.kind === "skip") {
    // A plan skipped for its moment, or a fresh binding, decides nothing; a suspect binding with nothing to check is settled by
    // the table of unchecked suspicion (F2, the approval agent's decision of 2026-11-10).
    if (sync.kind === "suspect" && (plan.reason === "no_marker" || plan.reason === "unavailable")) return uncheckedSuspect(relay, base, sync, undecided);
    return applied(relay, base, [], { verified: "skipped" });
  }
  switch (sync.kind) {
    case "fresh": return applied(relay, base, [], { verified: "skipped" });
    case "pending": {
      if (plan.kind !== "pending" || plan.marker.packetId !== sync.packetId) return refuse({ code: "invalid", why: "a pending binding is checked only against its own packet" });
      // A late write: the packets it superseded may show up after their positions; their rows are corrected, the binding is not moved.
      const late = plan.earlier.flatMap(marker => resultOf(marker) === "present" ? recordedRow(marker) : []);
      const result = classified(plan.marker);
      if (result === "present") {
        const mark = packetMark(base, sync.prior, sync.range, sync.packetId, plan.marker.bodySha256, "E2");
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
          const result = classified(plan.marker);
          if (result === "present") return advance(sync.carried, plan.marker, false, "recorded");
          // Absent (or compacted away, which proves no more) goes back to the state before the packet; the next input owes it again.
          if (result === "absent" || result === "compacted")
            return applied(relay, { ...withSync(base, sync.carried.prior), reanchor: base.reanchor || result === "compacted" }, refine(plan.marker, result), { verified: "retreated" });
          return undecided();
        }
        // The Turn carried no packet, so it did not change what the binding knows: whether its entry is there or not, the mark
        // stands (point 4 of the approval); its result stays unknown and is never re-run. A compaction re-anchors. An entry the
        // check cannot see changes nothing either: the mark stands, undecided, with no choice to make (2026-11-10).
        const result = event.turnEntry ?? "unavailable";
        if (result === "present" || result === "compacted" || result === "absent")
          return applied(relay, { ...withSync(base, standing(base, sync.mark)), reanchor: base.reanchor || result === "compacted" }, [], { verified: "kept" });
        return applied(relay, withSync(base, standing(base, sync.mark)), [], { verified: "undecided" });
      }
      if (sync.cause === "clear_unconfirmed") {
        if (plan.kind !== "clear") return refuse({ code: "invalid", why: "an unconfirmed clear is checked for an empty history and its chain" });
        return clearChecked(relay, base, sync, plan, event, { resultOf, classified, moved, recordedRow, refine, undecided, advance });
      }
      if (plan.kind !== "suspect") return refuse({ code: "invalid", why: "a suspect binding is checked against its epoch's recorded packets" });
      const results = plan.markers.map(resultOf);
      const unexplained = plan.markers.some((marker, index) => results[index] === "absent" && !moved(marker));
      const compaction = plan.markers.some((marker, index) => results[index] === "compacted" || results[index] === "absent" && moved(marker));
      if (sync.carried !== null && plan.carried !== null) {
        const result = classified(plan.carried);
        // F8: the carried packet is there and nothing older is missing without a compaction to explain it: g on it.
        if (result === "present") return unexplained ? undecided() : advance(sync.carried, plan.carried, compaction, "recorded");
        const rows = refine(plan.carried, result);
        if (plan.markers.length === 0) return restorable(sync.mark) ? applied(relay, withSync(base, standing(base, sync.mark)), rows, { verified: "restored" }) : undecided();
        return markers(relay, base, sync.mark, plan.markers, results, plan.firstFromSeq, moved, null, rows);
      }
      if (plan.markers.length === 0) return restorable(sync.mark) ? applied(relay, withSync(base, standing(base, sync.mark)), [], { verified: "restored" }) : undecided();
      return markers(relay, base, sync.mark, plan.markers, results, plan.firstFromSeq, moved, null);
    }
  }
}

/**
 * A suspect binding with nothing to check (a plan skip{no_marker | unavailable}; the approval agent's decision of 2026-11-10).
 * R is `restorable`:
 * - rewind, unknown_command, clear_unconfirmed with nothing carried: R(mark) → the mark (an unconfirmed clear is then taken as
 *   not having happened: floor and epoch unchanged, what is owed above the mark still owed), restored; otherwise unchanged,
 *   verify_required;
 * - unknown_turn with nothing carried: the mark stands (no check ever changes it), undecided with no choice;
 * - a packet carried (any of the four carrying causes, rewound or not): R(its prior's mark) → pending on it again, with the
 *   automatic resend spent and no one-time attach (`carried` does not keep it), restored, so the next input's
 *   delivery_unconfirmed choice settles it; otherwise unchanged, verify_required;
 * - legacy, marker_absent: unchanged.
 */
function uncheckedSuspect(relay: BindingRelayState, base: BindingRelayState, sync: Extract<SyncPrior, { kind: "suspect" }>, undecided: () => RelayStep): RelayStep {
  if (sync.cause === "legacy" || sync.cause === "marker_absent") return applied(relay, base, [], { verified: "skipped" });
  if (sync.carried !== null) {
    const carried = sync.carried;
    if (!restorable(markOf(carried.prior))) return undecided();
    return applied(relay, withSync(base, { kind: "pending", prior: carried.prior, packetId: carried.packetId, range: carried.range, autoResends: 1, manualResends: 0, attachOverride: false }), [], { verified: "restored" });
  }
  if (sync.cause === "unknown_turn") return applied(relay, withSync(base, standing(base, sync.mark)), [], { verified: "undecided" });
  return restorable(sync.mark) ? applied(relay, withSync(base, standing(base, sync.mark)), [], { verified: "restored" }) : undecided();
}

interface CheckTools {
  readonly resultOf: (marker: PlannedMarker) => MarkerResult;
  readonly classified: (marker: PlannedMarker) => MarkerResult;
  readonly moved: (marker: PlannedMarker) => boolean;
  readonly recordedRow: (marker: PlannedMarker) => DeliveryChange[];
  readonly refine: (marker: PlannedMarker, result: MarkerResult) => DeliveryChange[];
  readonly undecided: () => RelayStep;
  readonly advance: (carried: NonNullable<Extract<SyncPrior, { kind: "suspect" }>["carried"]>, marker: PlannedMarker, reanchor: boolean, verified: VerifiedOutcome) => RelayStep;
}
/**
 * The check of an unconfirmed clear (F1, the approval agent's decision): only the chain the mark stands on (M) and the carried
 * packet count, never the epoch's other recorded packets. In order:
 * 1. an empty history → cleared;
 * 2. the carried packet there: with no marker of M missing unexplained (absent while the cursor did not move) the clear did not
 *    happen and the packet arrived (g on it, restored); otherwise the two disagree (a late write after the clear) → verify_required;
 * 3. a marker of M there (present or compacted) → the clear did not happen: restore or move back as the markers show;
 * 4. M all absent, the binding not rewound, and for each marker a compaction is ruled out (its row kept the cursor at delivery
 *    and the cursor has not moved since) → cleared; an empty history is not required, the user may have typed in the original
 *    program since;
 * 5. M all absent where a compaction may explain a marker (the cursor moved, or the Driver keeps no cursor to tell) or a rewind
 *    not yet checked may (rewound) → verify_required;
 * 6. no chain (a mark without a packet): a restorable mark comes back, any other waits → verify_required;
 * 7. anything else (only unavailable or outside_window) → verify_required.
 * The floor rises only on 1 and 4; a mark comes back only to a chain node still there or to a restorable mark.
 */
function clearChecked(relay: BindingRelayState, base: BindingRelayState, sync: Extract<SyncPrior, { kind: "suspect" }>, plan: Extract<VerifyPlan, { kind: "clear" }>,
    event: Extract<RelayEvent, { kind: "verified" }>, tools: CheckTools): RelayStep {
  if (sync.floorCandidate === null) return refuse({ code: "invalid", why: "an unconfirmed clear keeps the seq of its clear" });
  const floor = sync.floorCandidate;
  const cleared = () => floor <= relay.epochFloor ? refuse({ code: "invalid", why: "a clear's seq lies at or below the binding's clear floor" }) : applied(relay, clearedState(base, floor), [], { verified: "cleared" });
  const chain = plan.chain, results = chain.map(tools.resultOf);
  const unexplained = chain.some((marker, index) => results[index] === "absent" && !tools.moved(marker));
  const compaction = chain.some((marker, index) => results[index] === "compacted" || results[index] === "absent" && tools.moved(marker));
  if (event.result.historyEmpty === true) return cleared();
  const carried = sync.carried !== null && plan.carried !== null ? tools.classified(plan.carried) : null;
  if (carried === "present") return unexplained ? tools.undecided() : tools.advance(sync.carried!, plan.carried!, compaction, "restored");
  const rows = carried === null ? [] : tools.refine(plan.carried!, carried);
  if (chain.length > 0 && results.some(result => result === "present" || result === "compacted")) return markers(relay, base, sync.mark, chain, results, plan.firstFromSeq, tools.moved, "restored", rows);
  // Rule 4 needs a compaction ruled out marker by marker: a Driver without compaction evidence cannot tell a marker folded into
  // a summary from one cleared away (the property test's counterexample: a clear that never ran, then /compact). Nor does it
  // apply to a rewound clear: a rewind not yet checked may have removed the chain just as well (2026-11-10).
  if (chain.length > 0 && results.every(result => result === "absent"))
    return !sync.rewound && chain.every(marker => marker.compactionAtDelivery !== null && !tools.moved(marker)) ? cleared() : tools.undecided();
  if (chain.length === 0) return restorable(sync.mark) ? applied(relay, withSync(base, standing(base, sync.mark)), rows, { verified: "restored" }) : tools.undecided();
  return tools.undecided();
}

/**
 * The suspect k cell (§7.2, F7): a compacted marker counts as still there. The newest marker there → synced on the current mark;
 * an older one there → synced on that marker's mark ("最后一个仍在的标记"), the packets after it owed again; none there and
 * every one absent → the epoch base (max(first packet's fromSeq − 1, epochFloor)); a compacted marker or a cursor moved since
 * an absent one's delivery also sets reanchor. Markers that only answer outside_window or unavailable decide nothing: with none present the
 * binding stays suspect and the next content input needs the user's choice (verify_required). `extra` are delivery changes
 * of the same check (a carried packet's row).
 */
function markers(relay: BindingRelayState, base: BindingRelayState, mark: DeliveredMark | null, checked: readonly PlannedMarker[], results: readonly MarkerResult[],
    firstFromSeq: number | null, moved: (marker: PlannedMarker) => boolean, restored: "restored" | null, extra: readonly DeliveryChange[] = []): RelayStep {
  const reanchor = base.reanchor || results.some((result, index) => result === "compacted" || result === "absent" && moved(checked[index]!));
  // F7: a compacted marker was delivered and folded into the summary, so it counts as still there (§7.4 ①: an anchor, not the packet again).
  const newest = results.findLastIndex(result => result === "present" || result === "compacted");
  if (checked.length > 0 && newest === checked.length - 1) return applied(relay, { ...withSync(base, standing(base, mark)), reanchor }, extra, { verified: restored ?? "kept" });
  if (newest >= 0) {
    const kept = checked[newest]!.mark;
    if (kept === null) return refuse({ code: "invalid", why: "a recorded marker keeps the mark its recording made" });
    const back = mark !== null && kept.throughSeq > mark.throughSeq ? mark : kept;
    return applied(relay, { ...withSync(base, standing(base, back)), reanchor }, extra, { verified: restored ?? "retreated" });
  }
  if (checked.length > 0 && results.every(result => result === "absent"))
    return applied(relay, { ...withSync(base, standing(base, epochBase(base, firstFromSeq, "E2"))), reanchor }, extra, { verified: restored ?? "retreated" });
  return applied(relay, base, [], { verified: "undecided", choice: "verify_required" });
}
