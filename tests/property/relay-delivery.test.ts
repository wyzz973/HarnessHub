import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BINDING_RELAY_BYTES, parseBindingRelayState, relayPacketId, type BindingRelayState } from "../../src/contracts/relay.js";
import type { RunId } from "../../src/contracts/session.js";
import type { ContextEffect } from "../../src/contracts/control.js";
import { fromOf, initialBindingRelay, plan, throughOf, type PlanInput, type RelayFact, type TurnPlan } from "../../src/contexts/session/domain/relay/delivery.js";
import { recordedStep, relayDeclaration, settleTurn, type RelayDeclaration, type SettledTurn } from "../../src/contexts/session/application/relay-coordinator.js";
import { declared } from "../fixtures/relay-fakes.js";

// The relay's state machine against a reference (slim.md): random conversations over three Harnesses, each with a native session
// the model knows the truth of — which facts it really holds — while the Hub only sees what a Driver's evidence shows. Turns end
// every way a Turn can (recorded, reported live, nothing known, refused, lost), commands clear, rewind, compact or do nothing,
// and the invariants are checked after every step against that truth:
//   S  no false delivery: whatever a binding's state counts as delivered, its native session really holds;
//   N  no silent loss: what a native session lacks is still owed by the state (the next ordinary input carries it), unless the
//      one resend a packet gets is spent, and then the state says a packet is unconfirmed;
//   A  a packet is sent again by itself at most once, and only by a Driver that can ever confirm it;
//   B  nothing from before a clear is attached afterwards, unless the user asks for the whole history;
//   R  a rewound binding's next carry is everything since the clear, once;
//   M  the epoch, the clear boundary and the mark only go forward, and the state stays within its byte bound.
// Every case names its seed; the pure parts only: nothing here opens a store or runs a Harness.

const HARNESSES = ["alpha", "bravo", "charlie"] as const;
type Kind = "event" | "proof" | "blind";
/** A Driver that reports the entry live (E1), one whose normal end proves it, one that can never confirm a thing. */
const DRIVERS: Readonly<Record<Kind, RelayDeclaration>> = {
  event: relayDeclaration(declared({ live: "recorded_event", successProvesRecorded: false })),
  proof: relayDeclaration(declared({ live: "none", successProvesRecorded: true })),
  blind: relayDeclaration(declared({ live: "none", successProvesRecorded: false })),
};
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const encoded = (value: number): string => { let text = ""; for (let rest = value; text.length < 20; rest = Math.floor(rest / 32)) text = ALPHABET[rest % 32]! + text; return text; };

/** mulberry32: a small seeded generator, so every case is reproducible from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
interface Ctx { readonly random: () => number }
const pick = <T>(ctx: Ctx, items: readonly T[]): T => items[Math.floor(ctx.random() * items.length)]!;
const subset = (ctx: Ctx, held: ReadonlySet<number>): Set<number> => new Set([...held].filter(() => ctx.random() < 0.5));

/** One public fact, as the Session records it, and where it ran. */
type Fact = RelayFact
/**
 * One native session, with the truth: `held`, the seqs of the facts it really holds (0 is the history the Session started from).
 * The reference keeps its own count of the clears the Driver reported (`clears`, `clearedAt`) and of the automatic resends.
 */
interface Native { readonly harnessId: string; readonly controlId: string; readonly kind: Kind; relay: BindingRelayState; held: Set<number>; clears: number; clearedAt: number; autos: number;
  /** The unconfirmed packet the binding waits for is the user's own attach of the whole history: its resends carry what the user asked for, below a clear too. */
  userPending: boolean;
  seen: { epoch: number; floor: number; mark: number } }
interface World { seq: number; runs: number; packets: number; origin: boolean; harnesses: readonly string[]; importer: string; facts: Fact[]; natives: Map<string, Native>; kinds: Record<string, Kind>; current: string; trace: string[] }

function newWorld(ctx: Ctx, harnesses: number, origin: boolean): World {
  const names = HARNESSES.slice(0, harnesses);
  return { seq: 1, runs: 0, packets: 0, origin, harnesses: names, importer: names[0]!, facts: [], natives: new Map(), current: names[0]!, trace: [],
    kinds: Object.fromEntries(names.map(name => [name, pick(ctx, ["event", "proof", "blind"] as const)])) };
}
/** The native session of `harnessId`, opened on first use (an import's holds the history the Session started from, any other nothing). */
function native(w: World, harnessId: string): Native {
  let found = w.natives.get(harnessId);
  if (found === undefined) {
    const imported = w.origin && harnessId === w.importer, controlId = harnessId + "-acp";
    const relay = initialBindingRelay([], harnessId, controlId, imported ? "import" : "new");
    found = { harnessId, controlId, kind: w.kinds[harnessId]!, relay, held: new Set(imported ? [0] : []), clears: 0, clearedAt: -1, autos: 0, userPending: false, seen: { epoch: relay.epoch, floor: relay.floor, mark: relay.mark } };
    w.natives.set(harnessId, found);
  }
  return found;
}
/** Whether the fact did not run on this very native session. */
const foreign = (fact: Fact, n: Native): boolean => fact.executedOn === null || fact.executedOn.harnessId !== n.harnessId || fact.executedOn.controlId !== n.controlId || fact.executedOn.nativeEpoch !== n.relay.epoch;
/** What the native session lacks of the conversation since its last clear, by the truth: facts it did not run itself and does not hold, and the starting history. */
function lacking(w: World, n: Native): { readonly facts: readonly Fact[]; readonly origin: boolean } {
  return { facts: w.facts.filter(fact => fact.seq > n.clearedAt && foreign(fact, n) && !n.held.has(fact.seq)), origin: w.origin && n.clearedAt < 0 && !n.held.has(0) };
}
const input = (w: World, n: Native, attach?: "full" | "none"): PlanInput => ({ harnessId: n.harnessId, controlId: n.controlId, facts: w.facts, originHistory: w.origin, canConfirm: DRIVERS[n.kind].canConfirm, ...(attach === undefined ? {} : { attach }) });

/** How a Turn ends, and the truth behind it. */
interface Ending {
  readonly dispatched: boolean; readonly status: "completed" | "cancelled" | "failed" | null; readonly input: "recorded" | "not_recorded" | undefined;
  /** The Driver reported the entry while the Turn ran (E1). */
  readonly e1: boolean; readonly agentOutput: boolean;
  /** The truth: the input reached the native session. */
  readonly delivered: boolean;
  /** The Turn ended unknown and its session was continued: the Hub no longer knows what the native session holds. */
  readonly lost: boolean;
}
const ENDINGS = {
  neverDispatched: { dispatched: false, status: null, input: "not_recorded", e1: false, agentOutput: false, delivered: false, lost: false },
  rejected: { dispatched: true, status: "failed", input: "not_recorded", e1: false, agentOutput: false, delivered: false, lost: false },
  recordedThenFailed: { dispatched: true, status: "failed", input: "recorded", e1: false, agentOutput: false, delivered: true, lost: false },
  recorded: { dispatched: true, status: "completed", input: "recorded", e1: false, agentOutput: true, delivered: true, lost: false },
  completed: { dispatched: true, status: "completed", input: undefined, e1: false, agentOutput: true, delivered: true, lost: false },
  live: { dispatched: true, status: "completed", input: undefined, e1: true, agentOutput: true, delivered: true, lost: false },
} as const satisfies Record<string, Ending>;
/** A random end for a Turn on a Driver of `kind`; `quiet` leaves out the ends that are other events (a refusal, a lost Turn). */
function ending(ctx: Ctx, kind: Kind, quiet = false): Ending {
  const draw = ctx.random(), reports = kind === "event";
  if (!quiet) {
    if (draw < 0.04) return ENDINGS.neverDispatched;
    if (draw < 0.09) return ENDINGS.rejected;
    if (draw < 0.13) return { ...ENDINGS.completed, status: null, agentOutput: false, delivered: ctx.random() < 0.5, lost: true };
  }
  if (draw < 0.19) return ENDINGS.recordedThenFailed;
  if (draw < 0.27) { const e1 = reports && ctx.random() < 0.3; return { ...ENDINGS.completed, status: "failed", agentOutput: ctx.random() < 0.5, delivered: e1 || ctx.random() < 0.5, e1 }; }
  if (draw < 0.33) return { ...ENDINGS.completed, status: "cancelled", agentOutput: ctx.random() < 0.3, delivered: ctx.random() < 0.5 };
  if (draw < 0.40) return ENDINGS.recorded;
  return reports && ctx.random() < 0.8 ? ENDINGS.live : ENDINGS.completed;
}
/** The end of a Turn whose Driver did everything it could: the input reached the native session, and the Driver said so where it can. */
const cooperative = (kind: Kind): Ending => kind === "event" ? ENDINGS.live : ENDINGS.recorded;

interface Sent { readonly plan: TurnPlan; readonly ending: Ending }
/** One content input to the current Harness, planned by the state machine and settled by the Turn's end. */
function send(w: World, ctx: Ctx, options: { readonly attach?: "full" | "none"; readonly ending?: Ending } = {}): Sent {
  const n = native(w, w.current), before = n.relay, planned = plan(before, input(w, n, options.attach));
  const end = options.ending ?? ending(ctx, n.kind), runId = ("run-" + ++w.runs) as RunId, contextThroughSeq = w.seq, endedSeq = (w.seq += 1 + Math.floor(ctx.random() * 3));
  w.trace.push(`${n.harnessId} send${options.attach === undefined ? "" : "(" + options.attach + ")"} -> ${planned.kind}${planned.kind === "carry" ? "/" + planned.by + "/" + String(planned.resend) : planned.kind === "alone" ? "/" + planned.by : ""} end=${end.status}${end.input === undefined ? "" : "/" + end.input}${end.e1 ? "/e1" : ""}${end.delivered ? "/delivered" : ""}${end.lost ? "/lost" : ""} state=${JSON.stringify(before)}`);
  // The plan, against the rules it must keep.
  if (options.attach === "none") assert.deepEqual(planned, { kind: "alone", by: "user" }, "the user's only-this-message goes alone");
  if (planned.kind === "carry") {
    assert.ok(planned.need.facts.every(fact => foreign(fact, n)), "a packet carries what the native session did not run itself");
    if (options.attach !== "full") {
      // Below a clear only what the user asked for: the whole history they attached, still unconfirmed, is what its resends carry.
      assert.ok(n.userPending || planned.need.facts.every(fact => fact.seq > n.clearedAt) && !(planned.need.origin && n.clearedAt >= 0), "B: nothing from before a clear is attached afterwards");
      assert.equal(planned.by === "user", false);
    } else assert.equal(planned.by, "user");
    if (planned.resend === "auto") { assert.ok(DRIVERS[n.kind].canConfirm, "A: only a Driver that can ever confirm is sent to again by itself"); assert.equal(before.pending?.autoResends, 0, "A: one automatic resend per packet"); }
    if (planned.resend === "all") assert.ok(before.resendAll, "R: only a rewound binding is sent everything again");
    assert.equal(planned.whole, planned.resend === "all" || planned.by === "user");
  }
  if (before.resendAll && options.attach === undefined) {
    // R: everything since the clear, once; nothing to send means nothing is done.
    const everything = w.facts.filter(fact => fact.seq > before.floor && foreign(fact, n)), origin = w.origin && before.floor < 0;
    if (everything.length === 0 && !origin) assert.equal(planned.kind, "plain", "R: a rewind with nothing to send again does nothing");
    else { assert.equal(planned.kind, "carry"); if (planned.kind === "carry") { assert.equal(planned.resend, "all"); assert.deepEqual(planned.need.facts.map(fact => fact.seq), everything.map(fact => fact.seq)); assert.equal(planned.need.origin, origin); } }
  }
  // The Turn: a carried packet is E1-recorded at once when the Driver reports it, then the Turn settles.
  let relay = before;
  let turn: SettledTurn;
  if (planned.kind === "carry") {
    const carried = { runId, packet: { id: relayPacketId("relay-" + encoded(++w.packets)), fromSeq: fromOf(planned.need), throughSeq: throughOf(planned.need) }, autoResend: planned.resend === "auto" };
    if (end.e1 && end.dispatched) relay = recordedStep(relay, carried);
    turn = { kind: "carry", recorded: end.e1 && end.dispatched, ...carried };
  } else if (planned.kind === "alone") turn = { kind: "alone" };
  else turn = { kind: "plain", contextThroughSeq, agentOutput: end.agentOutput };
  const settled = settleTurn({ relay, runId, turn, dispatched: end.dispatched, status: end.status, input: end.input, noop: false, cleared: false, declaration: DRIVERS[n.kind], unknownTurn: end.lost, endedSeq, time: endedSeq * 10 });
  n.relay = settled.relay;
  // What the Turn did to the budget of automatic resends: a packet known not to have been sent used none.
  const happened = end.dispatched && end.input !== "not_recorded";
  if (planned.kind === "carry" && happened) {
    n.autos = planned.resend === "auto" ? n.autos + 1 : 0; assert.ok(n.autos <= 1, "A: a second automatic resend in a row");
    n.userPending = n.relay.pending !== null && (options.attach === "full" || before.pending !== null && n.userPending);
  }
  // A carry that settled has sent everything it was to send (R), unless the Turn itself was lost and continued: then the native history is in doubt again.
  if (planned.kind === "carry" && end.dispatched && end.input !== "not_recorded") assert.equal(n.relay.resendAll, end.lost, "R: a settled carry has sent everything it was to send");
  if (planned.kind === "carry" && end.dispatched && end.input === "not_recorded") assert.deepEqual(n.relay, before, "a packet known not to have been sent changes nothing");
  if (n.relay.pending === null) { n.autos = 0; n.userPending = false; }
  // The truth.
  if (end.dispatched) {
    if (planned.kind === "carry" && end.delivered) { for (const fact of planned.need.facts) n.held.add(fact.seq); if (planned.need.origin) n.held.add(0); }
    w.facts.push({ runId, seq: endedSeq, executedOn: { harnessId: n.harnessId, controlId: n.controlId, nativeEpoch: before.epoch } });
    n.held.add(endedSeq);
    if (end.lost) n.held = subset(ctx, n.held);
  }
  return { plan: planned, ending: end };
}
/** A native command Turn on the current Harness: what the Driver said it does, what became of it, and the truth it leaves. */
function command(w: World, ctx: Ctx): void {
  const n = native(w, w.current), declaredEffect = pick(ctx, ["clear", "rewind", "compact", "keep", "none", "unknown"] as const satisfies readonly ContextEffect[]);
  const how = pick(ctx, ["executed", "executed", "executed", "noop", "refused", "lost"] as const), endedSeq = (w.seq += 1 + Math.floor(ctx.random() * 3));
  const ran = how === "executed" || how === "lost" && ctx.random() < 0.5, reported = declaredEffect === "clear" && how === "executed" && ctx.random() < 0.8;
  w.trace.push(`${n.harnessId} /${declaredEffect} ${how}${reported ? " reported" : ""} state=${JSON.stringify(n.relay)}`);
  const settled = settleTurn({ relay: n.relay, runId: ("run-" + ++w.runs) as RunId, turn: { kind: "command", declared: declaredEffect }, dispatched: how !== "refused", status: how === "lost" ? null : how === "refused" ? null : "completed",
    input: undefined, noop: how === "noop", cleared: reported, declaration: DRIVERS[n.kind], unknownTurn: false, endedSeq, time: endedSeq * 10 });
  const before = n.relay;
  n.relay = settled.relay;
  if (reported) { n.clears += 1; n.clearedAt = endedSeq; n.held = new Set(); n.autos = 0; n.userPending = false; assert.equal(n.relay.epoch, before.epoch + 1, "a clear the Driver reported is a new native session"); }
  else if (ran && (declaredEffect === "clear")) n.held = new Set();
  else if (ran && (declaredEffect === "rewind" || declaredEffect === "unknown")) n.held = subset(ctx, n.held);
  // A command that did not run, changed nothing or keeps the history leaves the state as it was; compacting changes nothing the Hub counts on.
  if (!reported && (how === "refused" || how === "noop" || declaredEffect === "keep" || declaredEffect === "none" || declaredEffect === "compact")) assert.deepEqual(n.relay, before, "no event for " + declaredEffect + " " + how);
  if (!reported && ran && (declaredEffect === "rewind" || declaredEffect === "unknown" || declaredEffect === "clear") && how === "executed") assert.equal(n.relay.resendAll, true, "R: a rewind is sent everything again");
}
const switchTo = (w: World, ctx: Ctx): void => { const to = pick(ctx, w.harnesses.filter(name => name !== w.current).concat(w.harnesses.length === 1 ? [w.current] : [])); w.trace.push("switch to " + to); w.current = to; };

/** The invariants S, N, M against the truth, after a step. */
function check(w: World): void {
  for (const n of w.natives.values()) {
    const r = n.relay, where = n.harnessId + " " + JSON.stringify(r);
    assert.deepEqual(parseBindingRelayState(r), r, "M: a well-formed state, " + where);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= MAX_BINDING_RELAY_BYTES, "M: within the byte bound");
    assert.equal(r.epoch, 1 + n.clears, "M: the epoch counts the clears, " + where); assert.equal(r.floor, n.clearedAt, "M: the clear boundary is the last clear, " + where);
    assert.ok(r.epoch >= n.seen.epoch && r.floor >= n.seen.floor && (r.epoch > n.seen.epoch || r.mark >= n.seen.mark), "M: forward only, " + where + " after " + JSON.stringify(n.seen));
    assert.ok(r.mark <= w.seq && (r.pending === null || r.pending.throughSeq <= w.seq && r.pending.fromSeq <= r.pending.throughSeq));
    n.seen = { epoch: r.epoch, floor: r.floor, mark: r.mark };
    // S: what the state counts as delivered — the mark above the clear boundary, but not past an unconfirmed packet's start, and nothing when everything is to be sent again — is really held.
    const trusted = r.resendAll ? r.floor : r.pending !== null ? Math.min(Math.max(r.mark, r.floor), r.pending.fromSeq - 1) : Math.max(r.mark, r.floor);
    for (const fact of w.facts) if (foreign(fact, n) && fact.seq > r.floor && fact.seq <= trusted) assert.ok(n.held.has(fact.seq), "S: " + where + " counts fact " + fact.seq + " as delivered; the native session never held it");
    if (w.origin && r.floor < 0 && trusted >= 0) assert.ok(n.held.has(0), "S: " + where + " counts the starting history as delivered; the native session never held it");
    // N: what the native session lacks is owed by the state.
    const lack = lacking(w, n);
    if (lack.facts.length > 0 || lack.origin) {
      const next = plan(r, input(w, n));
      assert.notEqual(next.kind, "plain", "N: " + where + " lacks " + lack.facts.map(fact => fact.seq).join() + (lack.origin ? " and the starting history" : "") + " and would send the next input as typed with nothing owed");
      if (next.kind === "carry") { for (const fact of lack.facts) assert.ok(next.need.facts.some(row => row.seq === fact.seq), "N: the next packet leaves out fact " + fact.seq + ", " + where); assert.ok(!lack.origin || next.need.origin, "N: the next packet leaves out the starting history"); }
      else assert.ok(next.kind === "alone" && next.by === "policy" && r.pending !== null, "N: the input would go alone without a packet being unconfirmed, " + where);
    }
  }
}
function walk(ctx: Ctx, w: World, steps: number): void {
  for (let at = 0; at < steps; at++) {
    const draw = ctx.random();
    if (draw < 0.5) send(w, ctx, { ...(ctx.random() < 0.25 ? { attach: ctx.random() < 0.5 ? "none" as const : "full" as const } : {}) });
    else if (draw < 0.7) switchTo(w, ctx);
    else if (draw < 0.85) command(w, ctx);
    else probe(w, ctx);
    check(w);
  }
}
/**
 * The liveness probe: on a copy of the world, the next input goes to a Harness whose Driver does everything it can. Whatever its
 * native session lacked is then held — except when the state is the one that sends the input alone, after its packet's one resend.
 */
function probe(w: World, ctx: Ctx): void {
  const copy = structuredClone(w), to = pick(ctx, copy.harnesses); copy.current = to;
  const n = native(copy, to), lack = lacking(copy, n), pending = n.relay.pending, expected = plan(n.relay, input(copy, n));
  send(copy, ctx, { ending: cooperative(n.kind) });
  const after = lacking(copy, native(copy, to));
  if (lack.facts.length > 0 || lack.origin) {
    if (expected.kind === "alone") assert.ok(pending !== null, "a native session that lacks the conversation is sent alone only for an unconfirmed packet");
    else assert.deepEqual([after.facts.length, after.origin], [0, false], "a cooperative Driver is handed everything it lacked: " + JSON.stringify(lack.facts.map(fact => fact.seq)));
  }
}
/** Runs a case and says which seed and which steps led to a failure. */
function counted(seed: number, w: World, run: () => void): void {
  try { run(); } catch (error) { throw new Error("seed " + seed + ": " + (error instanceof Error ? error.message : String(error)) + "\n  " + w.trace.slice(-14).join("\n  "), { cause: error }); }
}

test("PR-01 over random conversations the state never counts as delivered what a native session does not hold, and never loses what it lacks", t => {
  let turns = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const ctx: Ctx = { random: generator(seed) }, w = newWorld(ctx, 1 + Math.floor(ctx.random() * 3), ctx.random() < 0.3);
    counted(seed, w, () => walk(ctx, w, 70));
    turns += w.facts.length;
  }
  t.diagnostic(`PR-01 400 conversations of 70 steps, ${turns} Turns`);
});

test("PR-02 with one Harness and no history from before, nothing is ever attached, whatever the commands do", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const ctx: Ctx = { random: generator(1000 + seed) }, w = newWorld(ctx, 1, false);
    counted(seed, w, () => {
      for (let at = 0; at < 60; at++) {
        if (ctx.random() < 0.75) { const sent = send(w, ctx, { ...(ctx.random() < 0.1 ? { attach: "none" as const } : {}) }); assert.ok(sent.plan.kind === "plain" || sent.plan.kind === "alone", "a conversation on one Harness has nothing to attach: " + sent.plan.kind); }
        else command(w, ctx);
        check(w);
      }
    });
  }
});

test("PR-03 after a switch, twenty messages in a row with nothing else happening send a packet by themselves at most twice", t => {
  const counts = new Map<number, number>();
  for (let seed = 1; seed <= 300; seed++) {
    const ctx: Ctx = { random: generator(2000 + seed) }, w = newWorld(ctx, 3, ctx.random() < 0.3);
    counted(seed, w, () => {
      walk(ctx, w, 25);
      const target = pick(ctx, w.harnesses); w.current = target;
      let automatic = 0;
      for (let message = 0; message < 20; message++) {
        const sent = send(w, ctx, { ending: ending(ctx, native(w, target).kind, true) });
        if (sent.plan.kind === "carry") automatic += 1;
        check(w);
      }
      assert.ok(automatic <= 2, "a packet went " + automatic + " times in twenty messages");
      counts.set(automatic, (counts.get(automatic) ?? 0) + 1);
    });
  }
  t.diagnostic("PR-03 packets sent in twenty messages (count: conversations) " + JSON.stringify([...counts].sort((a, b) => a[0] - b[0])));
  assert.ok((counts.get(2) ?? 0) > 0, "the cases include a packet sent again that nothing confirmed");
});

test("PR-04 an unconfirmed packet is sent again once; newer facts bring one new packet with everything owed, and a Driver that confirms is not sent anything twice", () => {
  const ctx: Ctx = { random: generator(7) }, w = newWorld(ctx, 2, false);
  w.kinds.alpha = "blind"; w.kinds.bravo = "blind"; w.kinds.charlie = "proof";
  const sentFrom = (name: string, how: Ending) => { w.current = name; const sent = send(w, ctx, { ending: how }); check(w); return sent; };
  sentFrom("alpha", ENDINGS.completed); sentFrom("alpha", ENDINGS.completed);
  // bravo cannot ever confirm: the packet goes once, and since it cannot confirm it is not sent again by itself.
  const first = sentFrom("bravo", ENDINGS.completed); assert.deepEqual([first.plan.kind, first.plan.kind === "carry" ? first.plan.by : null], ["carry", "need"]);
  assert.equal(sentFrom("bravo", ENDINGS.completed).plan.kind, "alone"); assert.equal(sentFrom("bravo", ENDINGS.completed).plan.kind, "alone");
  // New facts from alpha: one new packet with everything owed, once.
  sentFrom("alpha", ENDINGS.completed);
  const grown = sentFrom("bravo", ENDINGS.completed); assert.deepEqual([grown.plan.kind, grown.plan.kind === "carry" ? grown.plan.resend : null], ["carry", "grown"]);
  assert.equal(sentFrom("bravo", ENDINGS.completed).plan.kind, "alone");
  // A Driver whose normal end proves it: the packet is recorded, and nothing is owed any more.
  const toCharlie = sentFrom("charlie", ENDINGS.recorded); assert.equal(toCharlie.plan.kind, "carry"); assert.equal(sentFrom("charlie", ENDINGS.recorded).plan.kind, "plain");
});
