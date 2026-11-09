import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  markOf, parseBindingRelayState, relayPacketId,
  type BindingRelayState, type DeliveredMark, type DeliveryRecord, type Fingerprint, type MarkerResult, type RelayPacketId, type SourceRange, type VerifyResult,
} from "../../src/contracts/relay.js";
import { runId, type NativeSessionBinding, type RunId } from "../../src/contracts/session.js";
import {
  foreignTo, owed, pendingResend, planReturnVerify, admitsWithoutChoice, restorable, retreatedPrior, step,
  type BindingDelivery, type Cursor, type DecidedOutcome, type PlannedMarker, type RelayEvent, type RelayFact, type RelayStep, type VerifyPlan,
} from "../../src/contexts/session/domain/relay/delivery.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";

// G068-P01 (ADR-055 §7.2): random evidence sequences drive one binding's delivery state machine, with the native history
// kept by the reference model tests/fixtures/relay-harness-peer.mjs (a forked process) as the ground truth. Each case
// draws a Driver declaration (when it checks, lateDelivery, compaction evidence, window, readability) and a sequence of
// Turns of another Harness (foreign facts), content Turns with their fates (recorded by E1 or E3, inserted without
// evidence, refused, lost, written late), commands (keep, compact, clear confirmed or not, rewind, unknown), automatic
// compactions, late writes, native resets and D6 continuations. Every case names its seed; a failure reprints it.

const peerPath = fileURLToPath(new URL("../../../tests/fixtures/relay-harness-peer.mjs", import.meta.url));
const X = { harnessId: "xray", controlId: "xray-acp" } as const;
const Y = { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } as const;
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** mulberry32: a small seeded generator, so every case is reproducible from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}

/** The reference model over IPC: one request at a time, answered in order. */
class Peer {
  private readonly child: ChildProcess;
  private next = 1;
  private readonly waiting = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  readonly ready: Promise<unknown>;
  constructor() {
    this.child = fork(peerPath, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.ready = new Promise((resolve, reject) => this.waiting.set(0, { resolve, reject }));
    this.child.on("message", (raw: unknown) => {
      const message = raw as { readonly id: number; readonly ok: boolean; readonly result?: unknown; readonly error?: string };
      const waiter = this.waiting.get(message.id); this.waiting.delete(message.id);
      if (message.ok) waiter?.resolve(message.result); else waiter?.reject(new Error(message.error));
    });
    this.child.once("exit", () => { for (const waiter of this.waiting.values()) waiter.reject(new Error("the reference model exited")); this.waiting.clear(); });
  }
  call<T>(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => { this.waiting.set(id, { resolve: value => resolve(value as T), reject }); this.child.send({ id, op, args }); });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise(resolve => this.child.once("exit", resolve));
    this.child.disconnect(); await exited;
  }
}
async function startPeer(t: TestContext): Promise<Peer> { const peer = new Peer(); await peer.ready; t.after(() => peer.close()); return peer; }

interface Held { readonly facts: readonly string[]; readonly packets: readonly string[]; readonly cursor: Cursor; readonly late: number; readonly entries: number; readonly clears: number }
/** The markers a plan asks the Driver about, the carried packet included. */
function asked(plan: VerifyPlan): readonly PlannedMarker[] {
  switch (plan.kind) {
    case "skip": return [];
    case "pending": return [plan.marker, ...plan.earlier];
    case "synced": return [plan.marker];
    case "unknown_turn": return plan.marker === null ? [] : [plan.marker];
    case "clear": return [...plan.chain, ...(plan.carried === null ? [] : [plan.carried])];
    case "suspect": return [...plan.markers, ...(plan.carried === null ? [] : [plan.carried])];
  }
}
/** Whether a plan has nothing to look for besides the history being empty: the M=∅ cases a restorable mark comes back from. */
function noChain(plan: VerifyPlan): boolean {
  return plan.kind === "skip" || plan.kind === "clear" && plan.chain.length === 0 || plan.kind === "suspect" && plan.markers.length === 0;
}
interface Caps { readonly verify: "on_next_open" | "after_turn" | "none"; readonly lateDelivery: boolean; readonly compaction: boolean; readonly window: number; readonly flaky: number; readonly wholeHistory: boolean; readonly live: boolean }
/** A delivery row as the simulated Hub keeps it, with the packet's facts (what it covered) for the checks. */
interface Row { record: DeliveryRecord; readonly nativeEpoch: number; readonly range: SourceRange; readonly bodySha256: Fingerprint; readonly reanchor: boolean; mark: DeliveredMark | null; readonly facts: readonly string[]; readonly session: string }

/**
 * A Hub as far as one binding's relay state goes: it keeps the binding's state, its delivery rows and the public facts,
 * decides each Turn as §7.2 and §7.4 say (check first, resend or ask, retreat on the user's choice), applies `step`, and
 * after every step checks the properties against the reference model.
 */
class Simulation {
  seq = 1;
  private runs = 0;
  private packets = 0;
  private sessions = 1;
  relay: BindingRelayState = initialBindingRelay([], X.harnessId, X.controlId, "new");
  bindings: NativeSessionBinding[] = [];
  session = "native-1";
  readonly facts: RelayFact[] = [];
  readonly rows: Row[] = [];
  /** The last content Turn on the binding, when it ended unknown (D6 may continue it). */
  private unknownTurn: { readonly runId: RunId; readonly position: number } | null = null;
  /** The reference model's clear count when this binding's epoch last rose (P-F1), and at its last check (P-F2). */
  private clearsAtEpochRise = 0;
  private clearsAtLastCheck = 0;
  /** The last packet refused before insertion: an identical need renders the identical text, so the same identity (INV-13). */
  private lastRefused: { readonly packetId: RelayPacketId; readonly facts: string; readonly body: Fingerprint } | null = null;
  readonly log: string[] = [];
  /** Counters the cases assert on, so a case that never reaches a path is visible. */
  readonly seen = { recorded: 0, retreats: 0, oldPresent: 0, resends: 0, choices: 0, clears: 0, resets: 0, d6: 0, plain: 0, checks: 0,
    epochRises: 0, emptyHistoryClears: 0, restoredWithoutChain: 0, skipChecks: 0, nativeTurns: 0, reusedIds: 0, clearChecks: 0, carriedChecks: 0, supersededBack: 0,
    foldedCarried: 0, carriedPresent: 0, carriedCompacted: 0, pendingCompacted: 0, rewoundChecks: 0, revertedPending: 0, unknownTurnsSettled: 0, afterTurnUnknownSettled: 0 };
  /** The fate the next packet (or plain input: lost, silent) takes, when a directed case sets it (otherwise drawn). */
  forcedFate: "e1" | "e3" | "silent" | "refused" | "lost" | "late" | null = null;
  /** A directed case: a late packet is written before an after_turn Driver's settlement check. */
  landBeforeCheck = false;
  constructor(private readonly peer: Peer, readonly rand: () => number, readonly caps: Caps, readonly label: string) {
    this.bindings = [this.binding("ready")];
  }
  private binding(status: NativeSessionBinding["status"]): NativeSessionBinding { return { ...X, checkpoint: this.session, throughRunId: null, status, relay: this.relay }; }
  private commit(): { readonly seq: number; readonly time: number } { this.seq += 1; return { seq: this.seq, time: this.seq * 10 }; }
  private nextRun(): RunId { return runId("run-" + ++this.runs); }
  private nextPacket(): RelayPacketId {
    const digest = createHash("sha256").update(this.label + ":" + ++this.packets).digest();
    return relayPacketId("relay-" + Array.from(digest.subarray(0, 20), byte => CROCKFORD[byte % 32]).join(""));
  }
  private fail(message: string): never { assert.fail(this.label + ": " + message + "\n" + this.log.slice(-30).join("\n")); }
  private foreign(fact: RelayFact): boolean { return foreignTo(fact, X.harnessId, X.controlId, this.relay); }
  private deliveries(): readonly BindingDelivery[] { return this.rows.filter(row => row.session === this.session); }
  private need(attachOverride = false) { return owed(this.relay, X.harnessId, X.controlId, this.facts, { originHistory: false, attachOverride }); }

  /**
   * Applies a step that must not be refused, checks its delivery changes against the rows and the properties. P-F1: a native
   * epoch rises on this native session (e, k confirming a clear) only after the reference model ran a clear since the last rise;
   * `emptyHistory` is the one exception, a check that found the history empty (a clear of nothing is a clear).
   */
  private async apply(outcome: RelayStep, what: string, emptyHistory = false): Promise<void> {
    if (outcome.kind === "refused") this.fail(what + " was refused: " + JSON.stringify(outcome.refusal));
    const before = this.relay;
    for (const change of outcome.deliveries) {
      if (change.kind === "insert") continue;
      const row = this.rows.find(item => item.record.runId === change.runId) ?? this.fail(what + " decided a row that does not exist");
      if (row.record.outcome.kind !== change.from) this.fail(what + " moved a row from " + change.from + " that is " + row.record.outcome.kind);
      row.record = { ...row.record, outcome: change.outcome };
    }
    if (outcome.kind === "replaced") {
      if (!(outcome.relay.nativeEpoch > before.nativeEpoch && outcome.relay.epochFloor >= before.epochFloor)) this.fail(what + ": a new native session takes a later epoch and keeps the floor");
      this.bindings = [...this.bindings.slice(0, -1), { ...this.bindings.at(-1)!, status: "archived", relay: before }];
      this.relay = outcome.relay; this.session = "native-" + ++this.sessions; this.bindings.push(this.binding("ready"));
      this.clearsAtEpochRise = 0;
    } else {
      this.monotone(before, outcome.relay, what);
      if (outcome.relay.nativeEpoch > before.nativeEpoch) {
        const clears = (await this.peer.call<Held>("held", { session: this.session })).clears;
        this.seen.epochRises++;
        if (clears <= this.clearsAtEpochRise) {
          if (!emptyHistory) this.fail(what + ": the native epoch rose without a clear in the native session (P-F1)");
          this.seen.emptyHistoryClears++;
        }
        this.clearsAtEpochRise = clears;
      }
      this.relay = outcome.relay; this.bindings = [...this.bindings.slice(0, -1), { ...this.bindings.at(-1)!, relay: this.relay }];
    }
    this.log.push(what + " → " + this.relay.sync.kind + (this.relay.sync.kind === "suspect" ? ":" + this.relay.sync.cause : "") + " mark " + (markOf(this.relay.sync)?.throughSeq ?? "-") + " e" + this.relay.nativeEpoch + " f" + this.relay.epochFloor);
    await this.sound(what);
  }
  /** Within one epoch the mark goes down only from suspect, never below the floor; epochs and floors never go back (INV-30). */
  private monotone(before: BindingRelayState, after: BindingRelayState, what: string): void {
    if (after.nativeEpoch < before.nativeEpoch || after.epochFloor < before.epochFloor) this.fail(what + ": the epoch or the floor went back");
    const old = markOf(before.sync), mark = markOf(after.sync);
    if (mark !== null && mark.throughSeq < after.epochFloor) this.fail(what + ": a mark below the floor");
    if (after.nativeEpoch === before.nativeEpoch && old !== null && (mark === null || mark.throughSeq < old.throughSeq) && before.sync.kind !== "suspect") this.fail(what + ": the mark went down from " + before.sync.kind);
  }
  /**
   * A trusted mark (synced, or a pending binding's synced prior) claims only foreign facts above the floor the native
   * session holds; and the binding's need covers every foreign fact above the floor it does not hold, and nothing at or
   * below the floor (RT2-01, VF1-07). A suspect mark is not trusted until checked.
   */
  private async sound(what: string): Promise<void> {
    const held = new Set((await this.peer.call<Held>("held", { session: this.session })).facts), sync = this.relay.sync;
    const trusted = sync.kind === "synced" ? sync.mark : sync.kind === "pending" && sync.prior.kind === "synced" ? sync.prior.mark : null;
    for (const fact of this.facts) {
      if (!this.foreign(fact) || fact.seq <= this.relay.epochFloor) continue;
      if (trusted !== null && fact.seq <= trusted.throughSeq && !held.has(fact.runId)) this.fail(what + ": the mark " + trusted.throughSeq + " claims " + fact.runId + "@" + fact.seq + ", which the native session does not hold");
    }
    if (sync.kind === "suspect") return;
    const need = new Set(this.need().facts.map(fact => fact.runId as string));
    for (const fact of this.facts) {
      if (!this.foreign(fact)) continue;
      if (fact.seq <= this.relay.epochFloor && need.has(fact.runId)) this.fail(what + ": need holds " + fact.runId + " at or below the floor");
      if (fact.seq > this.relay.epochFloor && !held.has(fact.runId) && !need.has(fact.runId)) this.fail(what + ": need misses " + fact.runId + ", which the native session lacks");
    }
  }

  /**
   * The check a Driver of these declarations runs at `moment`, applied as k for every plan, a skipped one included (the
   * coordinator's rule: a Driver that cannot check still gets a k, which settles a suspect binding that needs no check).
   * P-F2: a check that restores or keeps a mark finds no clear in the reference model since the previous check, unless it had
   * nothing to look for but an empty history (M=∅ with a restorable mark, counted).
   */
  private async check(moment: "open" | "settled"): Promise<void> {
    const plan = planReturnVerify(this.relay, { verify: this.caps.verify, moment, deliveries: this.deliveries() });
    const readable = this.rand() >= this.caps.flaky, markers = asked(plan);
    if (plan.kind === "skip") this.seen.skipChecks++; else this.seen.checks++;
    if (plan.kind === "clear") this.seen.clearChecks++;
    if ((plan.kind === "clear" || plan.kind === "suspect") && plan.carried !== null) this.seen.carriedChecks++;
    if (this.relay.sync.kind === "suspect" && this.relay.sync.rewound && plan.kind !== "skip") this.seen.rewoundChecks++;
    // The prior's last packet is asked about too: a Driver may answer for it, and an old packet present must not move a pending one.
    const prior = this.relay.sync.kind === "pending" ? markOf(this.relay.sync.prior)?.lastPacketId ?? null : null;
    const positionOf = (packetId: string) => { const row = this.rows.findLast(item => item.record.packetId === packetId); return row?.record.position.kind === "seq" ? row.record.position.before : 0; };
    const questions = [...markers.map(marker => ({ packetId: marker.packetId, after: marker.position.kind === "seq" ? marker.position.before : 0 })), ...(prior === null ? [] : [{ packetId: prior, after: positionOf(prior) }])];
    const result: VerifyResult = plan.kind === "skip" ? { markers: [], historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 0 }
      : await this.peer.call<VerifyResult>("verify", { session: this.session, markers: questions, window: this.caps.window, compaction: this.caps.compaction, readable, wholeHistory: this.caps.wholeHistory });
    let turnEntry: MarkerResult | undefined;
    if (plan.kind === "unknown_turn" && plan.marker === null && this.unknownTurn !== null)
      turnEntry = (await this.peer.call<{ readonly result: MarkerResult }>("entry", { session: this.session, runId: this.unknownTurn.runId, after: this.unknownTurn.position, readable })).result;
    const held = await this.peer.call<Held>("held", { session: this.session });
    const at = this.commit(), before = this.relay;
    const answer = (marker: PlannedMarker | null | undefined) => marker == null ? undefined : result.markers.find(item => item.packetId === marker.packetId)?.result;
    const carried = plan.kind === "clear" || plan.kind === "suspect" ? answer(plan.carried) : plan.kind === "unknown_turn" ? answer(plan.marker) : undefined;
    if (carried === "present") this.seen.carriedPresent++;
    if (carried === "compacted") this.seen.carriedCompacted++;
    if (plan.kind === "pending" && answer(plan.marker) === "compacted") this.seen.pendingCompacted++;
    const outcome = step(this.relay, { kind: "verified", plan, result, ...(turnEntry === undefined ? {} : { turnEntry }), inRunId: null, at });
    if (outcome.kind === "applied" && before.sync.kind === "suspect" && outcome.relay.sync.kind === "pending") this.seen.revertedPending++;
    await this.apply(outcome, "k(" + plan.kind + (plan.kind === "skip" ? ":" + plan.reason : ":" + result.markers.map(item => item.result).join("/")) + (turnEntry === undefined ? "" : "+" + turnEntry) + ")",
      result.historyEmpty === true && held.entries === 0);
    if (outcome.kind === "applied" && (outcome.note.verified === "restored" || outcome.note.verified === "kept") && held.clears > this.clearsAtLastCheck) {
      if (!noChain(plan)) this.fail("a check restored or kept a mark after a clear ran in the native session (P-F2)");
      this.seen.restoredWithoutChain++;
    }
    this.clearsAtLastCheck = held.clears;
    if (plan.kind === "pending") {
      const own = result.markers.find(item => item.packetId === plan.marker.packetId)?.result;
      if (own !== "present") {
        // VF1-01: only the pending packet's own marker moves it; an old packet present never does.
        if (this.relay.sync.kind !== "pending" || before.sync.kind !== "pending" || this.relay.sync.packetId !== before.sync.packetId) this.fail("a pending packet moved without its own marker");
        if (result.markers.some(item => item.packetId !== plan.marker.packetId && item.result === "present")) this.seen.oldPresent++;
      } else this.recordedNeed(plan.marker.packetId);
    }
    // Rows a check decided recorded with the binding on them keep the mark they made.
    if (this.relay.sync.kind === "synced" && before.sync.kind !== "synced") this.markRow();
    // An unknown Turn never outlives an open, whatever the Driver: its check, or the table of unchecked suspicion, settles it
    // (2026-11-10; an after_turn Driver checks a suspect binding at the open, since D6 happens outside any Turn).
    if (moment === "open" && this.relay.sync.kind === "suspect" && this.relay.sync.cause === "unknown_turn") this.fail("an unknown Turn is still suspect after an open");
    if (moment === "open" && before.sync.kind === "suspect" && before.sync.cause === "unknown_turn") {
      this.seen.unknownTurnsSettled++;
      if (this.caps.verify === "after_turn") this.seen.afterTurnUnknownSettled++;
    }
  }
  /**
   * The end of a case: one more open, and then no suspect binding that needs no check is left waiting (F2, and the table of
   * 2026-11-10). A Driver that cannot check is never left with an unknown Turn without a packet, nor with an unconfirmed clear
   * on a mark that claims no foreign fact: both would ask the user at every input.
   */
  async settle(): Promise<void> {
    await this.check("open");
    const sync = this.relay.sync;
    // What admission let through without a choice and no check could still change must have been settled by the open's k.
    const independent = sync.kind === "suspect" && (this.caps.verify === "none" || sync.carried === null && sync.mark?.lastPacketId == null);
    if (independent && admitsWithoutChoice(this.relay, this.caps.verify)) this.fail("a suspect binding that needs no check is still waiting after an open (F2)");
    if (this.caps.verify === "none" && sync.kind === "suspect" && sync.carried === null && (sync.cause === "unknown_turn" || sync.cause === "clear_unconfirmed" && restorable(sync.mark)))
      this.fail("a Driver that cannot check is left with " + sync.cause + " on a mark that claims nothing");
  }
  /** One open's check, for directed cases. */
  async open(): Promise<void> { await this.check("open"); }
  /** What the native session holds and what the binding owes, for directed cases. */
  async truth(): Promise<{ readonly held: ReadonlySet<string>; readonly need: readonly string[] }> {
    return { held: new Set((await this.peer.call<Held>("held", { session: this.session })).facts), need: this.need().facts.map(fact => fact.runId as string) };
  }
  /** A packet of what is owed, with the fate `fate` (a directed case). */
  async carryNow(fate: NonNullable<Simulation["forcedFate"]>): Promise<void> {
    this.forcedFate = fate;
    try { await this.carry(this.need(), false, null); } finally { this.forcedFate = null; }
  }
  /** f: an undo of the last `n` user entries (none for an unknown command without effect), with no check at its open. */
  async injectRewind(n: number, cause: "rewind" | "unknown_command" = "rewind"): Promise<void> {
    const at = this.commit();
    if (n > 0) await this.peer.call("rewind", { session: this.session, n });
    await this.apply(step(this.relay, { kind: "rewound", cause }), "f(" + cause + " " + n + ")@" + at.seq);
    this.unknownTurn = null;
  }
  /** e′: a clear that did not run, settled unconfirmed (no check at its open). */
  async injectUnconfirmedClear(): Promise<void> {
    const at = this.commit();
    this.seen.clears++;
    await this.apply(step(this.relay, { kind: "clear_unconfirmed", seq: at.seq }), "e′(not run)@" + at.seq);
    this.unknownTurn = null;
  }
  /** After a packet is recorded, nothing it delivered is owed again (§7.2 property). */
  private recordedNeed(packetId: RelayPacketId): void {
    this.seen.recorded++;
    const row = this.rows.findLast(item => item.record.packetId === packetId)!, need = new Set(this.need().facts.map(fact => fact.runId as string));
    for (const fact of row.facts) if (need.has(fact)) this.fail("need still holds " + fact + ", which packet " + packetId + " delivered");
  }
  private markRow(): void {
    const sync = this.relay.sync;
    if (sync.kind !== "synced" || sync.mark.lastPacketId === null) return;
    const row = this.rows.findLast(item => item.record.packetId === sync.mark.lastPacketId);
    if (row !== undefined && row.record.outcome.kind === "recorded") row.mark = sync.mark;
  }

  async foreignTurn(): Promise<void> {
    const at = this.commit(), id = this.nextRun();
    this.facts.push({ runId: id, seq: at.seq, executedOn: Y });
    this.log.push("Y " + id + "@" + at.seq);
  }

  /** A content input on the binding: the open's check, then b, n or a as the state and the user decide. */
  async contentTurn(): Promise<void> {
    await this.check("open");
    const attach = this.relay.sync.kind === "fresh" && this.relay.sync.basis === "user_cleared" && this.rand() < 0.3;
    let need = this.need(attach);
    const sync = this.relay.sync, foreign = this.facts.some(fact => this.foreign(fact));
    if (sync.kind === "pending") {
      // A resend renders all of need again with the one-time attach of the packet it supersedes (VF1-07).
      need = this.need(sync.attachOverride);
      if (pendingResend(sync, this.caps.lateDelivery) === "auto") return this.carry(need, sync.attachOverride, { by: "auto", of: this.pendingRun() });
      this.seen.choices++;
      const choice = this.rand();
      if (choice < 0.4) return this.carry(need, sync.attachOverride, { by: "user", of: this.pendingRun() });
      if (choice < 0.8) return this.alone();
      await this.reset(); return this.contentTurn();
    }
    if (sync.kind === "suspect") {
      if (need.facts.length === 0 && !attach) {
        const plain = step(this.relay, { kind: "plain", foreign });
        if (plain.kind !== "refused") return this.plain(plain);
      }
      // A check left it suspect (or none was possible): the user chooses (§9 verify_required / marker_absent).
      this.seen.choices++;
      const choice = this.rand(), first = this.deliveries().find(row => row.nativeEpoch === this.relay.nativeEpoch)?.range.fromSeq ?? null;
      if (choice < 0.5) {
        const prior = retreatedPrior(this.relay, first)!;
        need = owed({ ...this.relay, sync: prior }, X.harnessId, X.controlId, this.facts, { originHistory: false });
        if (need.facts.length > 0) { this.seen.retreats++; return this.carry(need, false, null, first); }
      }
      if (choice < 0.85) return this.alone();
      await this.reset(); return this.contentTurn();
    }
    if (need.facts.length === 0) return this.plain(step(this.relay, { kind: "plain", foreign }));
    if (this.rand() < 0.1) return this.alone();
    return this.carry(need, attach, null);
  }
  private pendingRun(): RunId { const sync = this.relay.sync; return this.rows.findLast(row => sync.kind === "pending" && row.record.packetId === sync.packetId)!.record.runId; }
  private async position(): Promise<number> { return (await this.peer.call<{ readonly before: number }>("position", { session: this.session })).before; }

  /** b: the input alone while nothing is owed (dispatched === input), then j. */
  private async plain(outcome: RelayStep): Promise<void> {
    this.seen.plain++;
    await this.apply(outcome, "b");
    const id = this.nextRun(), position = await this.position(), drawn = this.rand();
    // A directed case's lost input never arrives; a silent one arrives without evidence and without output.
    const fate = this.forcedFate === "lost" ? 0.95 : this.forcedFate === "silent" ? 0.7 : drawn;
    const inserted = fate < 0.8, input = fate < 0.6 ? "recorded" as const : fate < 0.8 ? "unknown" as const : fate < 0.9 ? "not_recorded" as const : "unknown" as const;
    await this.peer.call("send", { session: this.session, runId: id, insert: inserted ? "now" : "never" });
    const at = this.commit();
    this.facts.push({ runId: id, seq: at.seq, executedOn: { ...X, nativeEpoch: this.relay.nativeEpoch } });
    const output = inserted && this.rand() < 0.5 && this.forcedFate !== "silent";
    await this.apply(step(this.relay, { kind: "plain_settled", input, agentOutput: output, contextThroughSeq: at.seq - 1 }), "j(" + input + ")");
    this.unknownTurn = input === "unknown" ? { runId: id, position } : null;
  }
  /** n: the input alone while facts are owed (the user chose attach:"none"); no evidence, nothing changes. */
  private async alone(): Promise<void> {
    await this.apply(step(this.relay, { kind: "alone" }), "n");
    const id = this.nextRun();
    await this.peer.call("send", { session: this.session, runId: id, insert: this.rand() < 0.8 ? "now" : "never" });
    const at = this.commit();
    this.facts.push({ runId: id, seq: at.seq, executedOn: { ...X, nativeEpoch: this.relay.nativeEpoch } });
    this.unknownTurn = null;
  }
  /** a: a packet covering `need`, then its fate in the native history and the evidence a truthful Driver gives of it. */
  private async carry(need: ReturnType<typeof owed>, attachOverride: boolean, resend: { readonly by: "auto" | "user"; readonly of: RunId } | null, retreatFrom?: number | null): Promise<void> {
    if (need.facts.length === 0) return this.alone();
    const id = this.nextRun(), facts = need.facts.map(fact => fact.runId as string);
    // The same need rendered again (not a resend, whose template differs) gives the same text and so the same identity as the
    // packet refused before: half the time the case takes that, so identities shared by two Runs are covered (INV-13).
    const reuse = resend === null && this.lastRefused !== null && this.lastRefused.facts === facts.join() && this.rand() < 0.5;
    const packetId = reuse ? this.lastRefused!.packetId : this.nextPacket();
    if (reuse) this.seen.reusedIds++;
    const range: SourceRange = { fromSeq: need.facts[0]!.seq, throughSeq: need.facts.at(-1)!.seq, fromRun: 0, throughRun: 0 };
    const body = createHash("sha256").update(packetId).digest("hex") as Fingerprint, position = await this.position();
    const cursor = this.caps.compaction ? (await this.peer.call<Held>("held", { session: this.session })).cursor : null;
    const prepared = this.commit();
    const event: RelayEvent = { kind: "carry", runId: id, packet: { id: packetId, range }, attachOverride, lateDelivery: this.caps.lateDelivery, resend, ...(retreatFrom === undefined ? {} : { retreat: { firstFromSeq: retreatFrom } }) };
    const outcome = step(this.relay, event);
    if (outcome.kind === "applied") for (const change of outcome.deliveries) if (change.kind === "insert")
      this.rows.push({ record: { runId: id, packetId, channel: "text_block", position: { kind: "seq", before: position }, outcome: { kind: "in_flight" }, consentLogSeq: null, inputHmac: "c".repeat(64) as DeliveryRecord["inputHmac"],
        redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" as DeliveryRecord["redaction"]["setHmac"] }, compactionAtDelivery: cursor, resendOf: change.resendOf, attachOverride: change.attachOverride, verifyMs: null, realized: null },
        nativeEpoch: this.relay.nativeEpoch, range, bodySha256: body, reanchor: this.relay.reanchor, mark: null, facts, session: this.session });
    if (resend !== null) this.seen.resends++;
    await this.apply(outcome, "a(" + packetId.slice(-4) + (resend === null ? "" : " resend " + resend.by) + (retreatFrom === undefined ? "" : " retreat") + ") @" + prepared.seq);
    // The packet's fate: inserted with E1 or E3, inserted without evidence, refused before insertion, lost, or written late.
    const fate = this.rand();
    const kind = this.forcedFate ?? (fate < 0.3 ? "e1" : fate < 0.45 ? "e3" : fate < 0.6 ? "silent" : fate < 0.72 ? "refused" : fate < 0.86 ? "lost" : this.caps.lateDelivery ? "late" : "lost");
    const insert = kind === "e1" || kind === "e3" || kind === "silent" ? "now" : kind === "late" ? "late" : "never";
    await this.peer.call("send", { session: this.session, runId: id, packetId, facts, insert });
    if (kind === "e1" && this.caps.live) {
      const at = this.commit();
      await this.apply(step(this.relay, { kind: "carry_settled", runId: id, packetId, bodySha256: body, reanchored: false, row: "in_flight", outcome: { kind: "recorded", evidence: "E1", decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: null } }), "E1");
      this.markRow(); this.recordedNeed(packetId);
    }
    const at = this.commit();
    const decided: DecidedOutcome = kind === "e3" || kind === "e1" && !this.caps.live ? { kind: "recorded", evidence: "E3", decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: null }
      : kind === "refused" ? { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: at.seq, decidedAt: at.time }
      : { kind: "unknown", reason: kind === "late" ? "late_delivery" : "no_evidence", decidedSeq: at.seq, decidedAt: at.time };
    const row = this.rows.find(item => item.record.runId === id)!;
    // A resend's settlement names the packet it superseded (its resendOf row): a refused resend goes back to waiting for it.
    const supersededRow = resend === null ? undefined : this.rows.find(item => item.record.runId === resend.of);
    const superseded = supersededRow === undefined ? {} : { superseded: { packetId: supersededRow.record.packetId, range: supersededRow.range } };
    if (!(kind === "e1" && this.caps.live)) {
      await this.apply(step(this.relay, { kind: "carry_settled", runId: id, packetId, bodySha256: body, reanchored: false, row: row.record.outcome.kind, outcome: decided, ...superseded }), (decided.kind === "recorded" ? "g" : decided.kind === "not_recorded" ? "h" : "i") + "(" + kind + ")");
      if (decided.kind === "recorded") { this.markRow(); this.recordedNeed(packetId); }
      if (decided.kind === "not_recorded" && resend !== null) {
        this.seen.supersededBack++;
        if (this.relay.sync.kind !== "pending" || this.relay.sync.packetId !== supersededRow!.record.packetId) this.fail("a refused resend did not go back to the packet it superseded");
      }
    } else {
      // The settlement finds E1's row recorded and the binding synced on it: nothing changes.
      const again = step(this.relay, { kind: "carry_settled", runId: id, packetId, bodySha256: body, reanchored: false, row: "recorded", outcome: { kind: "recorded", evidence: "E3", decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: null } });
      if (again.kind !== "applied" || again.changed) this.fail("a settlement after E1 changed the binding");
    }
    this.facts.push({ runId: id, seq: at.seq, executedOn: { ...X, nativeEpoch: this.relay.nativeEpoch } });
    this.unknownTurn = decided.kind === "unknown" ? { runId: id, position } : null;
    this.lastRefused = kind === "refused" ? { packetId, facts: facts.join(), body } : this.lastRefused;
    if (kind === "late" && this.landBeforeCheck) await this.peer.call("flushLate", { session: this.session });
    if (this.caps.verify === "after_turn") await this.check("settled");
  }

  /** A command Turn: what it does in the native history, and the event its settlement gives (§7.4). */
  async command(): Promise<void> {
    // A command Turn opens the native session too; half the cases check there, the others leave it to the next content input.
    if (this.rand() < 0.5) await this.check("open");
    const kind = this.rand(), at = this.commit();
    let event: RelayEvent;
    if (kind < 0.25) event = { kind: "command_kept" };
    else if (kind < 0.45) {
      const done = await this.peer.call<{ readonly cursor: Cursor }>("compact", { session: this.session, keep: 1 });
      event = { kind: "compaction", cursor: this.caps.compaction ? done.cursor : null, ran: true };
    } else if (kind < 0.65) {
      this.seen.clears++;
      const ran = this.rand() < 0.8;
      if (ran) await this.peer.call("clear", { session: this.session });
      event = ran && this.rand() < 0.5 ? { kind: "cleared", seq: at.seq } : { kind: "clear_unconfirmed", seq: at.seq };
    } else if (kind < 0.85) {
      await this.peer.call("rewind", { session: this.session, n: this.rand() < 0.5 ? 1 : 2 });
      event = { kind: "rewound", cause: "rewind" };
    } else {
      const effect = this.rand();
      if (effect < 0.25) await this.peer.call("rewind", { session: this.session, n: 1 });
      else if (effect < 0.5) await this.peer.call("compact", { session: this.session, keep: 1 });
      else if (effect < 0.75) await this.peer.call("clear", { session: this.session });
      event = { kind: "rewound", cause: "unknown_command" };
    }
    const outcome = step(this.relay, event);
    await this.apply(outcome, event.kind + "@" + at.seq);
    this.unknownTurn = null;
    if (this.caps.verify === "after_turn") await this.check("settled");
  }
  /** The Harness compacts by itself; a Driver with compaction evidence reports the cursor (d), another one says nothing. */
  async autoCompaction(): Promise<void> {
    const done = await this.peer.call<{ readonly cursor: Cursor; readonly folded: number }>("compact", { session: this.session, keep: 2 });
    if (this.caps.compaction && done.folded > 0) await this.apply(step(this.relay, { kind: "compaction", cursor: done.cursor, ran: false }), "d(auto)");
  }
  /**
   * A packet still to be decided (pending, or carried by a suspect binding) folded away: the user types once in the original
   * program and the Harness compacts all but that last entry, so the next check answers compacted for the packet (or absent
   * after the cursor moved, for a Driver without compaction evidence).
   */
  async foldCarried(): Promise<void> {
    this.seen.foldedCarried++;
    await this.nativeTurn();
    const done = await this.peer.call<{ readonly cursor: Cursor; readonly folded: number }>("compact", { session: this.session, keep: 1 });
    if (this.caps.compaction && done.folded > 0) await this.apply(step(this.relay, { kind: "compaction", cursor: done.cursor, ran: false }), "d(auto, folding)");
  }
  async lateWrites(): Promise<void> { await this.peer.call("flushLate", { session: this.session }); await this.sound("late writes"); }
  /** The user types in the original program: no Hub Turn, no fact, but the history is no longer empty after a clear. */
  async nativeTurn(): Promise<void> { this.seen.nativeTurns++; await this.peer.call("nativeTurn", { session: this.session }); await this.sound("native turn"); }
  /** l: the user starts a new native session of the same Harness control. */
  async reset(): Promise<void> {
    this.seen.resets++;
    await this.apply(step(this.relay, { kind: "reset", bindings: this.bindings, ...X }), "l");
    this.unknownTurn = null;
  }
  /** D6: the last Turn ended unknown, the Hub confirmed its process group ended, the user continues the native session. */
  async continueUnknown(): Promise<void> {
    if (this.unknownTurn === null) return;
    this.seen.d6++;
    await this.apply(step(this.relay, { kind: "unknown_turn_continued" }), "D6");
  }
}

function capsOf(rand: () => number): Caps {
  const verify = (["on_next_open", "after_turn", "none"] as const)[Math.floor(rand() * 3)]!;
  return { verify, lateDelivery: rand() < 0.4, compaction: rand() < 0.6, window: rand() < 0.3 ? 4 : 200, flaky: rand() < 0.3 ? 0.25 : 0, wholeHistory: rand() < 0.6, live: rand() < 0.5 };
}
async function run(simulation: Simulation, steps: number): Promise<void> {
  for (let index = 0; index < steps; index++) {
    const choice = simulation.rand(), sync = simulation.relay.sync;
    // A packet still to be decided is folded away more often, so its compacted answers are reached (the review's hit counts).
    if ((sync.kind === "pending" || sync.kind === "suspect" && sync.carried !== null) && simulation.rand() < 0.15) { await simulation.foldCarried(); continue; }
    if (choice < 0.24) await simulation.foreignTurn();
    else if (choice < 0.6) await simulation.contentTurn();
    else if (choice < 0.8) await simulation.command();
    else if (choice < 0.85) await simulation.autoCompaction();
    else if (choice < 0.88) await simulation.lateWrites();
    else if (choice < 0.9) await simulation.nativeTurn();
    else if (choice < 0.93) await simulation.reset();
    else await simulation.continueUnknown();
  }
  await simulation.settle();
}

const SEEDS = Array.from({ length: 160 }, (_, index) => 0x6806_0000 + index * 7919);

test("G068-P01 under any evidence sequence a trusted mark never exceeds what the native session holds, goes down only when suspect, never below the floor; need covers what is missing; epochs rise only on a clear (P-F1); no mark is restored over a clear (P-F2); nothing that needs no check is left waiting", async t => {
  const peer = await startPeer(t);
  const totals: Record<string, number> = {};
  for (const seed of SEEDS) {
    await peer.call("reset");
    const rand = generator(seed), simulation = new Simulation(peer, rand, capsOf(rand), "seed 0x" + seed.toString(16));
    await run(simulation, 70);
    for (const [key, count] of Object.entries(simulation.seen)) totals[key] = (totals[key] ?? 0) + count;
  }
  t.diagnostic("seeds 0x" + SEEDS[0]!.toString(16) + "… (" + SEEDS.length + " cases × 70 steps): " + JSON.stringify(totals));
  // Every path the properties are about was taken somewhere (the two exception counters may stay at zero).
  for (const [key, count] of Object.entries(totals)) if (key !== "emptyHistoryClears" && key !== "restoredWithoutChain") assert.ok(count > 0, key + " never happened");
});

test("G068-P01 an unchecked rewind and a clear that never ran, in either order: no epoch rises without a clear, and a mark restored repeats nothing the history holds (rewound)", async t => {
  const peer = await startPeer(t);
  const shapes: Record<string, number> = {}, totals: Record<string, number> = {};
  let restored = 0;
  for (const seed of SEEDS.slice(0, 40)) {
    await peer.call("reset");
    const rand = generator(seed ^ 0x7e57), label = "rewound seed 0x" + seed.toString(16);
    const caps: Caps = { verify: "on_next_open", lateDelivery: rand() < 0.5, compaction: rand() < 0.7, window: 200, flaky: 0, wholeHistory: rand() < 0.5, live: rand() < 0.5 };
    const simulation = new Simulation(peer, rand, caps, label);
    // Synced on two packets of the epoch, P1 then P2.
    for (let index = 0; index < 2; index++) { await simulation.foreignTurn(); await simulation.carryNow("e3"); }
    const sync = simulation.relay.sync;
    assert.ok(sync.kind === "synced" && sync.mark.lastPacketId !== null && simulation.relay.packetsInEpoch === 2, label + ": synced on two packets");
    // Sometimes a third packet still pending (inserted without evidence, or to be written late), sometimes the user's own entry last.
    const drawn = (["none", "silent", "late"] as const)[Math.floor(rand() * 3)]!, pending = drawn === "late" && !caps.lateDelivery ? "none" : drawn;
    if (pending !== "none") { await simulation.foreignTurn(); await simulation.carryNow(pending); }
    const own = rand() < 0.3;
    if (own) await simulation.nativeTurn();
    const n = rand() < 0.5 ? 1 : 2, order = rand() < 0.5 ? ["f", "e′"] as const : ["e′", "f"] as const;
    for (const event of order) if (event === "f") await simulation.injectRewind(n); else await simulation.injectUnconfirmedClear();
    const marked = simulation.relay.sync;
    assert.ok(marked.kind === "suspect" && marked.cause === "clear_unconfirmed" && marked.rewound, label + ": " + JSON.stringify(marked));
    await simulation.lateWrites();
    await simulation.open();
    const after = simulation.relay.sync, shape = order.join("") + " undo " + n + (pending === "none" ? "" : " +" + pending) + (own ? " +own" : "") + " → " + after.kind;
    shapes[shape] = (shapes[shape] ?? 0) + 1;
    if (after.kind === "synced") {
      // (a): the mark came back to a chain node still there; what is owed again is only what the history lost.
      const { held, need } = await simulation.truth();
      for (const fact of need) if (held.has(fact)) assert.fail(label + " (" + shape + "): need repeats " + fact + ", which the native session still holds\n" + simulation.log.slice(-12).join("\n"));
      restored++;
    }
    await run(simulation, 10);
    for (const [key, count] of Object.entries(simulation.seen)) totals[key] = (totals[key] ?? 0) + count;
  }
  t.diagnostic("shapes: " + JSON.stringify(shapes) + "; counters: " + JSON.stringify(totals));
  assert.ok(restored >= 5, "enough cases came back to a chain node (" + restored + ")");
  assert.ok(Object.keys(shapes).some(key => key.endsWith("→ suspect")), "some cases were left to the user");
});

test("G068-P01 a packet pending when an unchecked command comes is still checked: found, it advances; gone, its facts are owed again (F8)", async t => {
  const peer = await startPeer(t);
  let found = 0, gone = 0;
  for (const seed of SEEDS.slice(0, 30)) {
    await peer.call("reset");
    const rand = generator(seed ^ 0x0c0c), label = "carried seed 0x" + seed.toString(16);
    const simulation = new Simulation(peer, rand, { verify: "on_next_open", lateDelivery: false, compaction: rand() < 0.7, window: 200, flaky: 0, wholeHistory: rand() < 0.5, live: false }, label);
    await simulation.foreignTurn(); await simulation.carryNow("e3");
    await simulation.foreignTurn(); await simulation.carryNow("silent");
    const pending = simulation.relay.sync;
    assert.ok(pending.kind === "pending", label + ": the second packet is pending");
    if (pending.kind !== "pending") continue;
    // The user's own entry after the packet, sometimes; then an unknown command without effect, or an undo of the last entry
    // (the user's own one, or else the packet).
    if (rand() < 0.5) await simulation.nativeTurn();
    if (rand() < 0.4) await simulation.injectRewind(0, "unknown_command"); else await simulation.injectRewind(1);
    const carrying = simulation.relay.sync;
    assert.ok(carrying.kind === "suspect" && carrying.carried?.packetId === pending.packetId, label + ": the packet is carried");
    await simulation.open();
    const sync = simulation.relay.sync, { held, need } = await simulation.truth();
    if (sync.kind === "synced" && sync.mark.lastPacketId === pending.packetId) found++; else gone++;
    for (const fact of need) if (held.has(fact)) assert.fail(label + ": need repeats " + fact + ", which the native session still holds\n" + simulation.log.slice(-12).join("\n"));
    await run(simulation, 10);
  }
  t.diagnostic("carried packets found " + found + ", gone " + gone);
  assert.ok(found >= 5 && gone >= 3, "both outcomes were reached");
});

test("G068-P01 the reviewer's shortest dead corner Ilost Isil E Ilate X Ie1 (after_turn, no compaction evidence, no whole history): the open settles the unknown Turn and the input goes out", async t => {
  const peer = await startPeer(t);
  for (const live of [true, false]) {
    await peer.call("reset");
    const label = "dead corner, E1 " + (live ? "live" : "not live");
    const simulation = new Simulation(peer, generator(0x6805), { verify: "after_turn", lateDelivery: true, compaction: false, window: 200, flaky: 0, wholeHistory: false, live }, label);
    const as = async (fate: NonNullable<Simulation["forcedFate"]>, run: () => Promise<void>) => { simulation.forcedFate = fate; try { await run(); } finally { simulation.forcedFate = null; } };
    // Ilost, Isil: two inputs while nothing is owed, one lost, one arriving without evidence. E: another Harness's Turn.
    await as("lost", () => simulation.contentTurn()); await as("silent", () => simulation.contentTurn());
    await simulation.foreignTurn();
    // Ilate: the packet of E's fact, written late but before the after_turn settlement check, so the check finds it and the
    // binding is synced on it while the Turn's own result stays unknown.
    simulation.landBeforeCheck = true;
    try { await simulation.carryNow("late"); } finally { simulation.landBeforeCheck = false; }
    const synced = simulation.relay.sync;
    assert.ok(synced.kind === "synced" && synced.mark.lastPacketId !== null, label + ": synced on the late packet: " + JSON.stringify(synced));
    // X: the user continues the native session (D6) outside any Turn: suspect{unknown_turn}, nothing carried, nothing owed.
    await simulation.continueUnknown();
    const continued = simulation.relay.sync;
    assert.ok(continued.kind === "suspect" && continued.cause === "unknown_turn" && continued.carried === null, label + ": " + JSON.stringify(continued));
    assert.equal(admitsWithoutChoice(simulation.relay, "after_turn"), true, label + ": admission asks nothing");
    // Ie1: the next input. Its open checks the unknown Turn (after_turn checks a suspect binding at the open) and it goes out as typed.
    const plainBefore = simulation.seen.plain;
    await as("e1", () => simulation.contentTurn());
    assert.equal(simulation.relay.sync.kind, "synced", label + ": " + simulation.log.slice(-6).join(" | "));
    assert.equal(simulation.seen.plain, plainBefore + 1, label + ": the input went out alone, nothing owed, no choice");
    await run(simulation, 20);
  }
});

test("G068-P01 an old packet present never moves a pending packet, whatever else the check reports (VF1-01)", async t => {
  const peer = await startPeer(t);
  let cases = 0;
  for (const seed of SEEDS.slice(0, 60)) {
    await peer.call("reset");
    const rand = generator(seed ^ 0x55aa), simulation = new Simulation(peer, rand, { verify: "on_next_open", lateDelivery: false, compaction: true, window: 200, flaky: 0, wholeHistory: true, live: false }, "old-present seed 0x" + seed.toString(16));
    // Deliver one packet for sure, then keep sending until a packet stays pending; the next open checks it with the old one there.
    for (let index = 0; index < 40 && simulation.relay.sync.kind !== "pending"; index++) { await simulation.foreignTurn(); await simulation.contentTurn(); }
    if (simulation.relay.sync.kind !== "pending" || markOf(simulation.relay.sync.prior)?.lastPacketId == null) continue;
    cases++;
    await simulation.contentTurn();
  }
  t.diagnostic("pending packets checked with an older packet in the history: " + cases);
  assert.ok(cases >= 5, "enough cases reached a pending packet over a delivered one");
});

test("G068-P01 on a fresh binding no sequence of commands changes need, except that a confirmed clear drops what lies at or below its floor (VF1-04)", () => {
  const facts: RelayFact[] = Array.from({ length: 12 }, (_, index) => ({ runId: runId("run-f" + index), seq: 2 + index * 2, executedOn: index % 3 === 0 ? { ...X, nativeEpoch: 1 } : Y }));
  for (const seed of SEEDS) {
    const rand = generator(seed ^ 0x0f0f);
    let relay = parseBindingRelayState({ ...initialBindingRelay([], X.harnessId, X.controlId, "new"), epochFloor: rand() < 0.5 ? -1 : 3 });
    const before = owed(relay, X.harnessId, X.controlId, facts, { originHistory: true });
    let seq = 40;
    for (let index = 0; index < 12; index++) {
      const choice = rand(); seq += 1;
      const event: RelayEvent = choice < 0.25 ? { kind: "command_kept" } : choice < 0.45 ? { kind: "compaction", cursor: { count: index + 1, digest: null }, ran: rand() < 0.5 } : choice < 0.65 ? { kind: "clear_unconfirmed", seq }
        : choice < 0.85 ? { kind: "rewound", cause: rand() < 0.5 ? "rewind" : "unknown_command" } : { kind: "cleared", seq };
      const outcome = step(relay, event);
      assert.notEqual(outcome.kind, "refused", "seed 0x" + seed.toString(16) + ": " + JSON.stringify(outcome));
      if (outcome.kind === "refused") return;
      relay = outcome.relay;
      assert.ok(relay.sync.kind === "fresh" || relay.sync.kind === "suspect", "a command never makes a binding synced or pending");
      assert.equal(markOf(relay.sync), null, "a command never brings a mark");
      const after = owed(relay, X.harnessId, X.controlId, facts, { originHistory: true });
      assert.deepEqual(after.facts.map(fact => fact.runId), before.facts.filter(fact => fact.seq > relay.epochFloor).map(fact => fact.runId), "seed 0x" + seed.toString(16) + " step " + index);
      assert.equal(after.origin, before.origin && relay.epochFloor < 0);
    }
  }
});

test("G068-P01 after a packet was received, a /clear and 20 more inputs all go out as typed: dispatched === input (VF1-03)", async t => {
  const peer = await startPeer(t);
  for (const seed of SEEDS.slice(0, 40)) {
    await peer.call("reset");
    const rand = generator(seed ^ 0x2020), caps = { ...capsOf(rand), flaky: 0 }, label = "clear-20 seed 0x" + seed.toString(16);
    const simulation = new Simulation(peer, rand, caps, label);
    await run(simulation, 30);
    // Make sure a packet is in the native history before the clear.
    for (let tries = 0; tries < 30 && !simulation.rows.some(row => row.session === simulation.session && row.record.outcome.kind === "recorded"); tries++) { await simulation.foreignTurn(); await simulation.contentTurn(); }
    if (!simulation.rows.some(row => row.session === simulation.session && row.record.outcome.kind === "recorded")) continue;
    // The clear: confirmed at settlement, or (a Driver reading the whole history on the next open) unconfirmed and then confirmed by the check.
    await peer.call("clear", { session: simulation.session });
    const at = simulation.seq + 1; simulation.seq = at;
    const unconfirmed = caps.verify === "on_next_open" && caps.wholeHistory && rand() < 0.5;
    const first = step(simulation.relay, unconfirmed ? { kind: "clear_unconfirmed", seq: at } : { kind: "cleared", seq: at });
    assert.equal(first.kind, "applied", label);
    if (first.kind !== "applied") continue;
    simulation.relay = first.relay;
    if (unconfirmed) {
      const plan: VerifyPlan = planReturnVerify(simulation.relay, { verify: "on_next_open", moment: "open", deliveries: simulation.rows.filter(row => row.session === simulation.session) });
      const markers = asked(plan).map(marker => ({ packetId: marker.packetId, after: marker.position.kind === "seq" ? marker.position.before : 0 }));
      const result = await peer.call<VerifyResult>("verify", { session: simulation.session, markers, window: caps.window, compaction: caps.compaction, readable: true, wholeHistory: true });
      const confirmed = step(simulation.relay, { kind: "verified", plan, result, inRunId: null, at: { seq: at + 1, time: 0 } });
      assert.equal(confirmed.kind === "applied" && confirmed.relay.sync.kind, "fresh", label + ": the replay shows the clear");
      if (confirmed.kind === "applied") simulation.relay = confirmed.relay;
      simulation.seq = at + 1;
    }
    assert.deepEqual(simulation.relay.sync, { kind: "fresh", basis: "user_cleared" }, label);
    for (let index = 0; index < 20; index++) {
      const need = owed(simulation.relay, X.harnessId, X.controlId, simulation.facts, { originHistory: false });
      assert.deepEqual(need.facts, [], label + " input " + index + ": nothing is owed after the clear");
      const plain = step(simulation.relay, { kind: "plain", foreign: true });
      assert.equal(plain.kind, "applied", label + " input " + index + ": it goes out alone");
      const fate = rand(), id = runId("run-after-clear-" + index), seq = simulation.seq + 1; simulation.seq = seq;
      await peer.call("send", { session: simulation.session, runId: id, insert: fate < 0.85 ? "now" : "never" });
      simulation.facts.push({ runId: id, seq, executedOn: { ...X, nativeEpoch: simulation.relay.nativeEpoch } });
      const settled = step(simulation.relay, { kind: "plain_settled", input: fate < 0.7 ? "recorded" : fate < 0.85 ? "unknown" : "not_recorded", agentOutput: fate < 0.85, contextThroughSeq: seq - 1 });
      assert.equal(settled.kind, "applied", label);
      if (settled.kind === "applied") simulation.relay = settled.relay;
    }
  }
});
