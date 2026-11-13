import {
  parseBindingRelayState,
  type BindingRelayState, type ContextEffect, type DeliveryOutcome, type ExecutedOn, type PendingPacket, type RelayPacketId,
} from "../../../../contracts/relay.js";
import type { NativeSessionBinding, RunId } from "../../../../contracts/session.js";
import type { CommandOutcome } from "./advance.js";

/**
 * The relay's delivery state machine (slim.md, 2026-11-11): what one native binding is known to hold, and what it is owed.
 *
 * A binding records its `epoch`, its `mark` (the highest fact it is known to hold), the `pending` packet that nothing confirmed
 * yet, `resendAll` (the next packet carries everything) and the `floor` its epoch started from. There is no checking of the native
 * side's history afterwards: a packet is confirmed by evidence at hand (E1, the Driver reporting the input; E3, the Turn's
 * result where the Driver declares that a normal end means the input was received) or it stays pending.
 *
 * Everything here is pure and synchronous: nothing reads a clock, a store or a process; times and seqs come with the events.
 *
 * The transitions, all of `step`:
 *   recorded    a packet reached the binding (E1 or E3)        → mark moves up to the packet's end, pending and resendAll go
 *   unconfirmed a packet was sent and nothing confirmed it     → pending is that packet (count 1 for the one automatic resend,
 *                                                                 else 0); resendAll goes
 *   rewound     a command that may have changed the native    → resendAll
 *               history ran, or an unknown Turn was continued
 *   cleared     the native session was given up                → the next epoch: nothing known, the clear is the floor
 *   reseated    the Hub gave the native session a successor    → the next epoch: nothing known, the floor as it was (everything
 *               because its window was nearly full               above it is owed again, to the new native session)
 *   ran         the native session ran an input of its own     → a binding that held nothing now holds the conversation as it
 *               while nothing was owed to it                     stood before that input, so a later packet is an update
 * A packet known not to have been sent (never dispatched, refused before it was inserted) is no event: the binding stays as it was.
 * A compaction is no event either.
 */

/** A packet as the transitions name it: its identity and the facts it covers. */
export interface PacketRef { readonly id: RelayPacketId; readonly fromSeq: number; readonly throughSeq: number }
export type RelayEvent =
  | { readonly kind: "recorded"; readonly packet: PacketRef }
  /** `autoResend`: the packet is the one automatic resend of the pending packet (its count becomes 1); any other packet starts at 0. */
  | { readonly kind: "unconfirmed"; readonly packet: PacketRef; readonly autoResend: boolean }
  | { readonly kind: "rewound" }
  | { readonly kind: "cleared"; readonly seq: number }
  /** The Hub opens a new native session in the place of one whose window is nearly full (2026-11-13): nothing of the conversation is given up. */
  | { readonly kind: "reseated" }
  /** A Turn the native session ran itself while nothing was owed and that it evidently received; `throughSeq` is the last seq of the conversation before it. */
  | { readonly kind: "ran"; readonly throughSeq: number };
/** The binding's relay state moved by one event. Total: every state × event has a result. */
export function step(relay: BindingRelayState, event: RelayEvent): BindingRelayState {
  switch (event.kind) {
    case "recorded": return check({ ...relay, mark: Math.max(relay.mark, event.packet.throughSeq), pending: null, resendAll: false });
    case "unconfirmed": {
      const pending: PendingPacket = { packetId: event.packet.id, fromSeq: event.packet.fromSeq, throughSeq: event.packet.throughSeq, autoResends: event.autoResend ? 1 : 0 };
      return check({ ...relay, pending, resendAll: false });
    }
    case "rewound": return check({ ...relay, resendAll: true });
    case "cleared": return check({ epoch: relay.epoch + 1, mark: -1, floor: Math.max(relay.floor, event.seq), pending: null, resendAll: false });
    case "reseated": return check({ epoch: relay.epoch + 1, mark: -1, floor: relay.floor, pending: null, resendAll: false });
    // Only a binding that held nothing and waits for nothing: one that holds a part has its mark from a packet, which its own Turns do not move.
    case "ran": return relay.mark >= 0 || relay.pending !== null ? relay : check({ ...relay, mark: Math.max(event.throughSeq, relay.floor, 0) });
  }
}
/** The state checked as a v13 snapshot field (bounds, byte budget); a transition that leaves its bounds is a bug and throws INVALID_DATA. */
function check(relay: BindingRelayState): BindingRelayState { return parseBindingRelayState(relay); }

/**
 * The relay state a binding starts with: an import's or a branch's native session holds the history the Session started from
 * (mark 0: nothing of it is owed, until a rewind or the user's own attach sends everything again); any other new native session
 * holds nothing. It takes the next native epoch of its Harness control and inherits the highest clear floor along that control's
 * bindings, so what the user cleared stays cleared in every later native session of it. A binding archived without ever having
 * been cleared (a fork the Driver refused, a session given up) leaves no floor behind: its successor holds none of its history.
 */
export function initialBindingRelay(bindings: readonly NativeSessionBinding[], harnessId: string, controlId: string, source: "new" | "import" | "fork"): BindingRelayState {
  const lineage = bindings.flatMap(binding => binding.harnessId === harnessId && binding.controlId === controlId && binding.relay !== undefined ? [binding.relay] : []);
  const epoch = Math.max(0, ...lineage.map(relay => relay.epoch)) + 1, floor = Math.max(-1, ...lineage.map(relay => relay.floor));
  return check({ epoch, mark: source === "new" ? -1 : 0, floor, pending: null, resendAll: false });
}

// ---------------------------------------------------------------------------------------------------------------------
// What a binding is owed
// ---------------------------------------------------------------------------------------------------------------------

/** One public fact: a finished, dispatched content Run with its fact seq (its `run.ended` seq, or recovery's) and where it ran. */
export interface RelayFact { readonly runId: RunId; readonly seq: number; readonly executedOn: ExecutedOn | null }
export interface Owed { readonly facts: readonly RelayFact[]; readonly origin: boolean }
/** Whether `fact` is foreign to the binding of `harnessId`/`controlId`: it did not run on this very native session (this Harness control in this epoch). */
export function foreignTo(fact: RelayFact, harnessId: string, controlId: string, relay: BindingRelayState): boolean {
  const on = fact.executedOn;
  return on === null || on.harnessId !== harnessId || on.controlId !== controlId || on.nativeEpoch !== relay.epoch;
}
/** The lower bound (exclusive) of what is owed in the ordinary case: the mark and the clear floor, whichever is higher. */
export function ordinaryLower(relay: BindingRelayState): number { return Math.max(relay.mark, relay.floor); }
/**
 * What the binding is owed above `lower`: the foreign facts with a seq above it, in seq order, and the history the Session
 * started from (fact seq 0) when `lower` is below it and the Session has one.
 */
export function owed(relay: BindingRelayState, harnessId: string, controlId: string, facts: readonly RelayFact[], options: { readonly originHistory: boolean; readonly lower?: number }): Owed {
  const lower = options.lower ?? ordinaryLower(relay);
  return { facts: facts.filter(fact => fact.seq > lower && foreignTo(fact, harnessId, controlId, relay)).sort((left, right) => left.seq - right.seq), origin: options.originHistory && lower < 0 };
}
/** The seq of the latest thing a need carries (the origin is 0); −1 for none. */
export function throughOf(need: Owed): number { return Math.max(need.origin ? 0 : -1, ...need.facts.map(fact => fact.seq)); }
/** The seq of the earliest thing a need carries (the origin is 0); −1 for none. */
export function fromOf(need: Owed): number { return need.origin ? 0 : need.facts[0]?.seq ?? -1; }
export function nothingOwed(need: Owed): boolean { return need.facts.length === 0 && !need.origin; }

// ---------------------------------------------------------------------------------------------------------------------
// What the next content Turn does
// ---------------------------------------------------------------------------------------------------------------------

export type ResendKind = "auto" | "grown" | "all";
export type TurnPlan =
  /** Nothing is owed (or the user asked for the history and there was none): the input goes as typed and the binding stays as it is. */
  | { readonly kind: "plain"; readonly nothingToAttach: boolean }
  /** The input goes as typed and what is owed stays owed: the user chose it, or the policy did because a packet is unconfirmed and its one resend is spent. */
  | { readonly kind: "alone"; readonly by: "user" | "policy"; readonly cause?: "delivery_unconfirmed" }
  /**
   * A packet of `need`. `by`: the need alone, the policy (a resend, everything again) or the user's own attach. `resend` says which
   * kind of resend it is. `whole`: the packet carries everything again (the policy's `all`, the user's attach), so it is a complete
   * one and not an update even to a native session that holds a part. `repeat`: part of it may be in the native history already.
   */
  | { readonly kind: "carry"; readonly need: Owed; readonly by: "need" | "policy" | "user"; readonly resend: ResendKind | null; readonly whole: boolean; readonly repeat: boolean;
      readonly cause?: "delivery_unconfirmed" | "history_changed" };
export interface PlanInput {
  readonly harnessId: string;
  readonly controlId: string;
  readonly facts: readonly RelayFact[];
  /** Whether the Session has history it started from (a branch's or an import's). */
  readonly originHistory: boolean;
  /** The user's choice for this input: "none" sends it alone, "full" attaches the whole history once (below the clear boundary too). */
  readonly attach?: "full" | "none";
  /** Whether a send to this Driver can ever be confirmed: it reports the input as an event, or a normal end proves it was received. */
  readonly canConfirm: boolean;
}
/**
 * The choice between a plain input, an input alone and a packet for a content Turn (slim.md):
 * - the user's "none" sends it alone; the user's "full" sends the whole history (everything foreign, from the beginning);
 * - `resendAll` sends everything since the epoch's floor again;
 * - an unconfirmed packet is sent again once by itself when the Driver can ever confirm one (its count becomes 1); after that the
 *   input goes alone, until there are facts newer than the packet's, when one packet with everything owed goes (its count 0);
 * - otherwise a packet exactly when something is owed.
 * One packet's facts are thereby sent at most twice by themselves, and again only when more facts arrive.
 */
export function plan(relay: BindingRelayState, input: PlanInput): TurnPlan {
  const needOn = (lower: number) => owed(relay, input.harnessId, input.controlId, input.facts, { originHistory: input.originHistory, lower });
  if (input.attach === "none") return { kind: "alone", by: "user" };
  if (input.attach === "full") {
    const need = needOn(-1);
    return nothingOwed(need) ? { kind: "plain", nothingToAttach: true } : { kind: "carry", need, by: "user", resend: null, whole: true, repeat: relay.mark >= 0 || relay.pending !== null };
  }
  if (relay.resendAll) {
    const need = needOn(relay.floor);
    return nothingOwed(need) ? { kind: "plain", nothingToAttach: false } : { kind: "carry", need, by: "policy", resend: "all", whole: true, repeat: true, cause: "history_changed" };
  }
  const pending = relay.pending;
  if (pending !== null) {
    const need = needOn(Math.min(ordinaryLower(relay), pending.fromSeq - 1));
    if (nothingOwed(need)) return { kind: "plain", nothingToAttach: false };
    if (pending.autoResends === 0 && input.canConfirm) return { kind: "carry", need, by: "policy", resend: "auto", whole: false, repeat: true, cause: "delivery_unconfirmed" };
    if (throughOf(need) > pending.throughSeq) return { kind: "carry", need, by: "policy", resend: "grown", whole: false, repeat: true, cause: "delivery_unconfirmed" };
    return { kind: "alone", by: "policy", cause: "delivery_unconfirmed" };
  }
  const need = needOn(ordinaryLower(relay));
  return nothingOwed(need) ? { kind: "plain", nothingToAttach: false } : { kind: "carry", need, by: "need", resend: null, whole: false, repeat: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules that turn a Turn's end into an event
// ---------------------------------------------------------------------------------------------------------------------

/** A delivery outcome once decided. */
export type DecidedOutcome = Exclude<DeliveryOutcome, { readonly kind: "in_flight" }>;
/**
 * What a settled carrying Turn's delivery is: never dispatched is not recorded; the Driver's own `input` decides when it gives one
 * (not recorded: it refused the input before inserting it); a completed Turn proves recorded only where the Driver declares
 * `successProvesRecorded`; anything else is unknown{no_evidence}. The outcome follows from evidence alone, never from the Turn's
 * status as such. E1 is decided when its event arrives, not here.
 */
export function settledOutcome(facts: { readonly dispatched: boolean; readonly status: "completed" | "cancelled" | "failed" | null; readonly input: "recorded" | "not_recorded" | undefined; readonly successProvesRecorded: boolean },
    at: { readonly seq: number; readonly time: number }): DecidedOutcome {
  if (!facts.dispatched) return { kind: "not_recorded", reason: "never_dispatched", decidedSeq: at.seq, decidedAt: at.time };
  if (facts.input === "recorded") return { kind: "recorded", evidence: "E3", decidedSeq: at.seq, decidedAt: at.time };
  if (facts.input === "not_recorded") return { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: at.seq, decidedAt: at.time };
  if (facts.status === "completed" && facts.successProvesRecorded) return { kind: "recorded", evidence: "E3", decidedSeq: at.seq, decidedAt: at.time };
  return { kind: "unknown", reason: "no_evidence", decidedSeq: at.seq, decidedAt: at.time };
}
/**
 * The event of a settled command Turn (the effect is the declared one only when it ran): a clear the Driver confirmed gives the
 * native session up (`cleared`); a command that did not run or changed nothing, or one that keeps or leaves the history alone, or
 * compacts it, is no event; any other effect that ran or may have run (a rewind, a clear nobody confirmed, an unknown effect) may
 * have changed what the native session holds: everything is sent again (`rewound`). Null for no event.
 */
export function commandTurnEvent(declared: ContextEffect, outcome: CommandOutcome, facts: { readonly cleared: boolean; readonly seq: number }): RelayEvent | null {
  if (facts.cleared) return { kind: "cleared", seq: facts.seq };
  if (outcome === "not_recorded" || outcome === "noop" || declared === "keep" || declared === "none" || declared === "compact") return null;
  return { kind: "rewound" };
}
