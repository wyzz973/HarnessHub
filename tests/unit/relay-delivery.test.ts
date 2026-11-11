import assert from "node:assert/strict";
import test from "node:test";
import type { BindingRelayState, DeliveryRecord, ExecutedOn, RelayPacket, RelayPacketId } from "../../src/contracts/relay.js";
import { relayPacketId } from "../../src/contracts/relay.js";
import type { NativeSessionBinding, RunId, SessionSnapshot } from "../../src/contracts/session.js";
import { commandTurnEvent, foreignTo, fromOf, initialBindingRelay, nothingOwed, owed, plan, settledOutcome, step, throughOf, type PacketRef, type RelayFact } from "../../src/contexts/session/domain/relay/delivery.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";

// The relay's state machine and the rules around it (slim.md): pure, so every case is a table of states and events. Nothing here
// opens a store or a process; the properties over random conversations are tests/property/relay-delivery.test.ts's.

const packet = (char: string) => relayPacketId("relay-" + char.repeat(20)) as RelayPacketId;
const ref = (char: string, fromSeq: number, throughSeq: number): PacketRef => ({ id: packet(char), fromSeq, throughSeq });
const state = (extra: Partial<BindingRelayState> = {}): BindingRelayState => ({ epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false, ...extra });
const pending = (char: string, fromSeq: number, throughSeq: number, autoResends: 0 | 1 = 0) => ({ packetId: packet(char), fromSeq, throughSeq, autoResends });
const on = (harnessId: string, epoch = 1): ExecutedOn => ({ harnessId, controlId: harnessId + "-acp", nativeEpoch: epoch });
const fact = (seq: number, executedOn: ExecutedOn | null): RelayFact => ({ runId: ("run-" + seq) as RunId, seq, executedOn });
const A = (seq: number) => fact(seq, on("alpha")), B = (seq: number) => fact(seq, on("bravo"));
const seqs = (need: ReturnType<typeof owed>) => need.facts.map(row => row.seq);

test("the five transitions of a binding", () => {
  // recorded: the mark moves up to the packet's end, and nothing waits any more.
  assert.deepEqual(step(state({ mark: 2, pending: pending("a", 3, 5), resendAll: true }), { kind: "recorded", packet: ref("a", 3, 5) }), state({ mark: 5 }));
  assert.deepEqual(step(state({ mark: 9 }), { kind: "recorded", packet: ref("a", 3, 5) }), state({ mark: 9 }), "a mark never goes down");
  // unconfirmed: the packet is pending; counted once when it is the automatic resend, else from 0; resendAll goes.
  assert.deepEqual(step(state({ mark: 2, resendAll: true }), { kind: "unconfirmed", packet: ref("a", 3, 5), autoResend: false }), state({ mark: 2, pending: pending("a", 3, 5, 0) }));
  assert.deepEqual(step(state({ mark: 2, pending: pending("a", 3, 5) }), { kind: "unconfirmed", packet: ref("b", 3, 5), autoResend: true }), state({ mark: 2, pending: pending("b", 3, 5, 1) }));
  assert.deepEqual(step(state({ pending: pending("a", 3, 5, 1) }), { kind: "unconfirmed", packet: ref("b", 3, 8), autoResend: false }).pending, pending("b", 3, 8, 0), "a packet for newer facts starts again");
  // rewound: only the flag.
  assert.deepEqual(step(state({ mark: 4, pending: pending("a", 5, 6) }), { kind: "rewound" }), state({ mark: 4, pending: pending("a", 5, 6), resendAll: true }));
  // cleared: the next epoch, nothing known, nothing waiting, the clear is the floor, which never goes down.
  assert.deepEqual(step(state({ epoch: 2, mark: 7, floor: 3, pending: pending("a", 5, 7), resendAll: true }), { kind: "cleared", seq: 12 }), state({ epoch: 3, floor: 12 }));
  assert.equal(step(state({ floor: 20 }), { kind: "cleared", seq: 12 }).floor, 20);
  // ran: a binding that held nothing now holds the conversation as it stood; one that holds a part, or waits for a packet, is left alone.
  assert.equal(step(state(), { kind: "ran", throughSeq: 6 }).mark, 6);
  assert.equal(step(state({ floor: 9 }), { kind: "ran", throughSeq: 6 }).mark, 9, "never below the floor");
  assert.deepEqual(step(state({ mark: 3 }), { kind: "ran", throughSeq: 6 }), state({ mark: 3 }));
  assert.deepEqual(step(state({ pending: pending("a", 3, 5) }), { kind: "ran", throughSeq: 6 }), state({ pending: pending("a", 3, 5) }));
});

test("a binding starts empty; an import's or a branch's native session holds the history it started from; the epoch and the clear floor follow the lineage", () => {
  assert.deepEqual(initialBindingRelay([], "alpha", "alpha-acp", "new"), state());
  assert.deepEqual(initialBindingRelay([], "alpha", "alpha-acp", "import"), state({ mark: 0 }));
  assert.deepEqual(initialBindingRelay([], "alpha", "alpha-acp", "fork"), state({ mark: 0 }));
  const archived = (harnessId: string, relay: BindingRelayState): NativeSessionBinding => ({ harnessId, controlId: harnessId + "-acp", checkpoint: "native", throughRunId: null, status: "archived", relay });
  const lineage = [archived("alpha", state({ epoch: 2, floor: 14 })), archived("bravo", state({ epoch: 5, floor: 40 })), archived("alpha", state({ epoch: 3, floor: 9 }))];
  assert.deepEqual(initialBindingRelay(lineage, "alpha", "alpha-acp", "new"), state({ epoch: 4, floor: 14 }), "the next epoch of that control; what was cleared stays cleared");
  assert.deepEqual(initialBindingRelay(lineage, "bravo", "bravo-acp", "new"), state({ epoch: 6, floor: 40 }));
  assert.deepEqual(initialBindingRelay(lineage, "charlie", "charlie-acp", "new"), state());
});

test("what a binding is owed: the foreign facts above its mark and floor, and the history the Session started from", () => {
  const facts = [A(1), B(2), A(3), B(4), fact(5, null), fact(6, on("bravo", 2))];
  const bravo = state({ epoch: 1 });
  assert.equal(foreignTo(B(2), "bravo", "bravo-acp", bravo), false, "what ran on this very native session");
  assert.equal(foreignTo(fact(6, on("bravo", 2)), "bravo", "bravo-acp", bravo), true, "another epoch of the same control");
  assert.equal(foreignTo(fact(5, null), "bravo", "bravo-acp", bravo), true, "a Turn nobody can place is owed, never lost");
  assert.deepEqual(seqs(owed(bravo, "bravo", "bravo-acp", facts, { originHistory: false })), [1, 3, 5, 6]);
  assert.deepEqual(seqs(owed(state({ mark: 3 }), "bravo", "bravo-acp", facts, { originHistory: false })), [5, 6]);
  assert.deepEqual(seqs(owed(state({ floor: 5 }), "bravo", "bravo-acp", facts, { originHistory: false })), [6], "the clear boundary");
  assert.deepEqual(seqs(owed(state({ floor: 5 }), "bravo", "bravo-acp", facts, { originHistory: false, lower: -1 })), [1, 3, 5, 6], "attached by the user");
  // The history the Session started from is owed until something at or above it is known.
  assert.equal(owed(state(), "bravo", "bravo-acp", [], { originHistory: true }).origin, true);
  assert.equal(owed(state({ mark: 0 }), "bravo", "bravo-acp", [], { originHistory: true }).origin, false);
  assert.equal(owed(state({ floor: 8 }), "bravo", "bravo-acp", [], { originHistory: true }).origin, false, "cleared");
  assert.equal(owed(state({ floor: 8 }), "bravo", "bravo-acp", [], { originHistory: true, lower: -1 }).origin, true);
  assert.equal(owed(state(), "bravo", "bravo-acp", [], { originHistory: false }).origin, false);
  const need = owed(state(), "bravo", "bravo-acp", facts.slice(0, 3), { originHistory: true });
  assert.deepEqual([fromOf(need), throughOf(need), nothingOwed(need)], [0, 3, false]);
  assert.deepEqual([fromOf({ facts: [], origin: false }), throughOf({ facts: [], origin: false }), nothingOwed({ facts: [], origin: false })], [-1, -1, true]);
});

test("what the next content input does", () => {
  const facts = [A(1), A(2)], input = { harnessId: "bravo", controlId: "bravo-acp", facts, originHistory: false, canConfirm: true } as const;
  const planned = (relay: BindingRelayState, extra: Partial<Parameters<typeof plan>[1]> = {}) => plan(relay, { ...input, ...extra });
  const carry = (relay: BindingRelayState, extra: Partial<Parameters<typeof plan>[1]> = {}) => { const result = planned(relay, extra); assert.equal(result.kind, "carry"); return result as Extract<typeof result, { kind: "carry" }>; };
  // Nothing owed: as typed. Something owed: a packet of it, by the need alone.
  assert.deepEqual(planned(state(), { facts: [] }), { kind: "plain", nothingToAttach: false });
  assert.deepEqual(planned(state({ mark: 2 })), { kind: "plain", nothingToAttach: false });
  const first = carry(state());
  assert.deepEqual([seqs(first.need), first.by, first.resend, first.whole, first.repeat, first.cause], [[1, 2], "need", null, false, false, undefined]);
  // The user: alone, or the whole history (below a clear too), or nothing to attach.
  assert.deepEqual(planned(state(), { attach: "none" }), { kind: "alone", by: "user" });
  assert.deepEqual(planned(state({ pending: pending("a", 1, 2) }), { attach: "none" }), { kind: "alone", by: "user" });
  const full = carry(state({ mark: 2, floor: 2 }), { attach: "full" });
  assert.deepEqual([seqs(full.need), full.by, full.whole, full.repeat], [[1, 2], "user", true, true], "everything, even what the mark covers");
  assert.equal(carry(state({ floor: 2 }), { attach: "full" }).repeat, false, "a cleared native session holds none of it");
  assert.deepEqual(planned(state(), { attach: "full", facts: [] }), { kind: "plain", nothingToAttach: true });
  // Everything again after a rewind, from the floor, once.
  const again = carry(state({ mark: 2, floor: 1, resendAll: true }));
  assert.deepEqual([seqs(again.need), again.by, again.resend, again.whole, again.repeat, again.cause], [[2], "policy", "all", true, true, "history_changed"]);
  assert.deepEqual(planned(state({ resendAll: true }), { facts: [] }), { kind: "plain", nothingToAttach: false }, "nothing to send again");
  assert.equal(carry(state({ resendAll: true, pending: pending("a", 1, 2, 1) })).resend, "all", "a rewind outranks a spent resend");
  // An unconfirmed packet: sent again once when the Driver can ever confirm, then alone, until there are newer facts.
  const resend = carry(state({ pending: pending("a", 1, 2, 0) }));
  assert.deepEqual([seqs(resend.need), resend.by, resend.resend, resend.cause, resend.repeat], [[1, 2], "policy", "auto", "delivery_unconfirmed", true]);
  assert.deepEqual(planned(state({ pending: pending("a", 1, 2, 1) })), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  assert.deepEqual(planned(state({ pending: pending("a", 1, 2, 0) }), { canConfirm: false }), { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, "a Driver that never confirms is not sent again by itself");
  const grown = carry(state({ pending: pending("a", 1, 2, 1) }), { facts: [A(1), A(2), A(3)] });
  assert.deepEqual([seqs(grown.need), grown.resend], [[1, 2, 3], "grown"], "newer facts: one packet with everything owed");
  assert.equal(carry(state({ pending: pending("a", 1, 2, 0) }), { canConfirm: false, facts: [A(1), A(2), A(3)] }).resend, "grown");
  assert.equal(carry(state({ pending: pending("a", 1, 2, 0) }), { facts: [A(1), A(2), A(3)] }).resend, "auto", "the automatic resend comes first, and carries the newer facts too");
  // A pending packet that was the user's whole history is sent again whole.
  assert.deepEqual(seqs(carry(state({ mark: 2, pending: pending("a", 1, 2, 0) })).need), [1, 2]);
  // Purity: the same input, the same plan.
  assert.deepEqual(planned(state({ pending: pending("a", 1, 2, 0) })), planned(state({ pending: pending("a", 1, 2, 0) })));
});

test("a Turn's end: the delivery by evidence alone, and what a command does", () => {
  const at = { seq: 9, time: 100 };
  const outcome = (facts: Partial<Parameters<typeof settledOutcome>[0]>) => settledOutcome({ dispatched: true, status: "completed", input: undefined, successProvesRecorded: false, ...facts }, at);
  assert.deepEqual(outcome({ dispatched: false }), { kind: "not_recorded", reason: "never_dispatched", decidedSeq: 9, decidedAt: 100 });
  assert.deepEqual(outcome({ input: "recorded", status: "failed" }), { kind: "recorded", evidence: "E3", decidedSeq: 9, decidedAt: 100 });
  assert.deepEqual(outcome({ input: "not_recorded", status: "failed" }), { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: 9, decidedAt: 100 });
  assert.equal(outcome({ successProvesRecorded: true }).kind, "recorded");
  assert.equal(outcome({ successProvesRecorded: true, status: "cancelled" }).kind, "unknown", "a stopped Turn proves nothing");
  assert.equal(outcome({ successProvesRecorded: true, status: "failed" }).kind, "unknown");
  assert.deepEqual(outcome({}), { kind: "unknown", reason: "no_evidence", decidedSeq: 9, decidedAt: 100 });
  assert.deepEqual(outcome({ status: null }), { kind: "unknown", reason: "no_evidence", decidedSeq: 9, decidedAt: 100 });
  // Commands: a clear the Driver confirmed gives the native session up; a rewind or an unknown effect that ran, or may have, sends everything again; the rest is nothing.
  const event = (declared: Parameters<typeof commandTurnEvent>[0], result: Parameters<typeof commandTurnEvent>[1], cleared = false) => commandTurnEvent(declared, result, { cleared, seq: 7 });
  assert.deepEqual(event("clear", "executed", true), { kind: "cleared", seq: 7 });
  assert.deepEqual(event("keep", "executed", true), { kind: "cleared", seq: 7 }, "whatever it was declared to do");
  for (const declared of ["rewind", "unknown", "clear"] as const) for (const result of ["executed", "unknown"] as const) assert.deepEqual(event(declared, result), { kind: "rewound" }, declared + " " + result);
  for (const declared of ["keep", "none", "compact"] as const) for (const result of ["executed", "unknown", "noop", "not_recorded"] as const) assert.equal(event(declared, result), null, declared + " " + result);
  for (const declared of ["rewind", "unknown", "clear"] as const) for (const result of ["noop", "not_recorded"] as const) assert.equal(event(declared, result), null, declared + " " + result + " changed nothing");
});

test("recovery decides what a previous owner left in flight, and changes a binding only for a packet that may have arrived", () => {
  const record = (runId: string, packetId: RelayPacketId, autoResend = false, outcome: unknown = { kind: "in_flight" }): DeliveryRecord => ({ runId, packetId, channel: "single_text", outcome, handoffLogSeq: null,
    inputHmac: "a".repeat(64), redaction: { rulesVersion: "x", keyId: "k", setHmac: "01234567" }, autoResend }) as unknown as DeliveryRecord;
  const run = (id: string, dispatchedAt: number | undefined) => ({ id, selection: { harnessId: "bravo", controlId: "bravo-acp" }, status: "unknown", relay: { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: on("bravo") },
    timing: { acceptedAt: 5, ...(dispatchedAt === undefined ? {} : { dispatchedAt }) } });
  const manifest = (id: RelayPacketId, fromSeq: number, throughSeq: number): RelayPacket => ({ id, range: { fromSeq, throughSeq, fromRun: 0, throughRun: 0 } }) as unknown as RelayPacket;
  const snapshot = (relay: BindingRelayState, runs: unknown[]): SessionSnapshot => ({ lastSeq: 30, runs, nativeBindings: [{ harnessId: "bravo", controlId: "bravo-acp", checkpoint: "n", throughRunId: null, status: "ready", relay }] }) as unknown as SessionSnapshot;
  const relayOf = (recovery: ReturnType<typeof recoverRelay>) => recovery!.next.nativeBindings![0]!.relay;
  // Dispatched: unknown (owner_ended), and the binding waits for the packet; the automatic resend counts as one.
  const sent = recoverRelay(snapshot(state({ mark: 1 }), [run("run-1", 10)]), [record("run-1", packet("a"))], [manifest(packet("a"), 2, 6)]);
  assert.deepEqual(sent!.deliveries, [{ runId: "run-1", outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: 31, decidedAt: 10 } }]);
  assert.deepEqual(relayOf(sent), state({ mark: 1, pending: pending("a", 2, 6, 0) }));
  assert.equal(relayOf(recoverRelay(snapshot(state({ mark: 1, pending: pending("z", 2, 6) }), [run("run-1", 10)]), [record("run-1", packet("a"), true)], [manifest(packet("a"), 2, 6)]))!.pending?.autoResends, 1);
  // Never dispatched: not recorded, and the binding is as it was.
  const unsent = recoverRelay(snapshot(state({ mark: 1 }), [run("run-1", undefined)]), [record("run-1", packet("a"))], [manifest(packet("a"), 2, 6)]);
  assert.deepEqual([unsent!.deliveries.map(row => row.outcome.kind), relayOf(unsent)], [["not_recorded"], state({ mark: 1 })]);
  // A row already decided, or nothing in flight, changes nothing.
  assert.equal(recoverRelay(snapshot(state(), []), [], []), null);
  assert.equal(recoverRelay(snapshot(state(), [run("run-1", 10)]), [record("run-1", packet("a"), false, { kind: "recorded", evidence: "E1", decidedSeq: 3, decidedAt: 4 })], []), null);
  // The binding of another epoch (a later clear) did not receive it.
  const later = recoverRelay(snapshot(state({ epoch: 2 }), [run("run-1", 10)]), [record("run-1", packet("a"))], [manifest(packet("a"), 2, 6)]);
  assert.deepEqual(relayOf(later), state({ epoch: 2 }));
});
