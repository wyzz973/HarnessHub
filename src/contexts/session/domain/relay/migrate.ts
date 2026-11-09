import { EMPTY_CHAIN, MAX_RELAY_COUNTER, MAX_RELAY_MODEL_BYTES, type BindingRelayState, type BindingSync, type ContextEffect, type DeliveredMark, type ExecutedOn, type RelayBehindIndex, type VendorObservation } from "../../../../contracts/relay.js";
import { SessionError, type NativeSessionBinding, type PublicRun, type RunId, type SessionSnapshot } from "../../../../contracts/session.js";
import { terminal } from "../state.js";
import { commandEffect, commandOutcome, dispatched, type InputOutcome } from "./advance.js";

/**
 * The v12 → v13 relay inference (ADR-055 §14.4) and the relay state of a new binding, shared by the migration and the
 * Runtime. Pure: it reads a v12 snapshot and its events and says, for every native binding, its native epoch and sync
 * state, and for every finished dispatched Run where it ran. Nothing here reads a clock, a store or a process.
 *
 * The rule throughout is "only down, never up": a mark never exceeds what the events prove the native session received
 * (a packet whose sources cover every owed fact up to it, or a Turn it ran itself while nothing was owed), and what the
 * events cannot settle is read as not delivered, or as suspect where the native context may have changed.
 */

/** One stored event as the migration reads it: its seq, type and data. */
export interface MigrationEvent { readonly seq: number; readonly type: string; readonly data: Readonly<Record<string, unknown>> }
export interface MigrationOptions {
  /**
   * The declared context effect of a native command by name, for command Turns whose events predate G067 and record no
   * effect ("按 Driver 目录的命令名回推"). Null or absent: unknown, which never starts an epoch.
   */
  readonly commandEffect?: (harnessId: string, name: string) => ContextEffect | null;
}
export interface MigratedSession {
  /** The relay state of each native binding, in the snapshot's order. */
  readonly bindings: readonly BindingRelayState[];
  /** Each finished dispatched Run in Run order, with its fact seq and where it ran (its index row, status behind). */
  readonly runs: readonly RelayBehindIndex[];
}
/** Where a new binding comes from: a Turn's new native session, an import (ADR-029) or a branch's native fork (ADR-025). */
export type BindingSource = "new" | "import" | "fork";

const NO_CACHE = { lastRequestStartedAt: null, contextUsed: null, contextSize: null } as const;
function state(nativeEpoch: number, sync: BindingSync, originIncluded: boolean, epochFloor: number, vendorObserved: VendorObservation | null = null, cache: BindingRelayState["cache"] = NO_CACHE): BindingRelayState {
  return { nativeEpoch, sync, originIncluded, reanchor: false, packetsInEpoch: 0, epochFloor, compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved, cache };
}
const ORIGIN_MARK: DeliveredMark = { throughSeq: 0, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "origin", basis: "origin" };
function legacyMark(throughSeq: number): DeliveredMark { return { throughSeq, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "legacy", basis: "legacy" }; }

/**
 * The relay state a binding starts with (ADR-055 §7.5, §14.4): an import's or a branch's native session holds the history
 * the Session started from (synced at the origin, epoch 1); any other new native session is fresh (`reset` after an earlier
 * binding of the same Harness control, `new` otherwise), takes the next native epoch of that Harness control and inherits
 * the highest clear floor along its bindings.
 */
export function initialBindingRelay(bindings: readonly NativeSessionBinding[], harnessId: string, controlId: string, source: BindingSource): BindingRelayState {
  const lineage = bindings.flatMap(binding => binding.harnessId === harnessId && binding.controlId === controlId && binding.relay !== undefined ? [binding.relay] : []);
  const epoch = Math.max(0, ...lineage.map(relay => relay.nativeEpoch)) + 1, floor = Math.max(-1, ...lineage.map(relay => relay.epochFloor));
  if (source !== "new") return state(epoch, { kind: "synced", mark: ORIGIN_MARK }, true, floor);
  return state(epoch, { kind: "fresh", basis: lineage.length ? "reset" : "new" }, false, floor);
}

function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}
const EFFECTS: readonly ContextEffect[] = ["keep", "none", "compact", "clear", "rewind", "unknown"];
function effect(value: unknown): ContextEffect | undefined { return typeof value === "string" && (EFFECTS as readonly string[]).includes(value) ? value as ContextEffect : undefined; }
function input(value: unknown): InputOutcome | undefined { return value === "recorded" || value === "not_recorded" || value === "unknown" ? value : undefined; }
/** What a v12 Turn's own events say of it. */
interface TurnEvents {
  endedSeq: number | null;
  /** The seq of the `session.recovered` that ended it, when no `run.ended` did. */
  recoveredSeq: number | null;
  /** `run.ended.input` (G067 on); absent on older events. */
  input: InputOutcome | undefined;
  /** `run.ended.contextEffect` of a command Turn (G067 on). */
  endedEffect: ContextEffect | undefined;
  command: { readonly name: string; readonly declared: ContextEffect | undefined } | null;
  sources: readonly string[];
  carriedOrigin: boolean;
  sentAlone: boolean;
}
const REJECTED = new Set(["request_rejected", "model_not_applied"]);

/**
 * The relay state of every binding of a v12 Session and where each of its finished dispatched Runs ran (ADR-055 §14.4).
 * `events` are all of the Session's events in seq order. Throws INVALID_DATA when the bindings of the snapshot do not
 * match the bindings its events created, which no v12 runtime writes.
 */
export function migrateSession(state12: SessionSnapshot, events: readonly MigrationEvent[], options: MigrationOptions = {}): MigratedSession {
  const runs = state12.runs, bindings = state12.nativeBindings ?? [];
  const position = new Map(runs.map((run, index) => [run.id as string, index]));
  const turns = new Map<string, TurnEvents>(runs.map(run => [run.id, { endedSeq: null, recoveredSeq: null, input: undefined, endedEffect: undefined, command: null, sources: [], carriedOrigin: false, sentAlone: false }]));
  const turn = (id: unknown): TurnEvents | undefined => typeof id === "string" ? turns.get(id) : undefined;
  // Pass 1: each Turn's own facts.
  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case "message.accepted": { const row = turn(data.runId); if (row && object(data.relay)?.attach === "none") row.sentAlone = true; break; }
      case "run.context_prepared": { const row = turn(data.runId); if (row) { row.sources = strings(data.sourceRunIds); row.carriedOrigin = data.carriedOrigin === true; } break; }
      case "run.native_command": { const row = turn(data.runId), name = text(data.name); if (row && name !== undefined) row.command = { name, declared: effect(data.contextEffect) }; break; }
      case "run.ended": { const row = turn(data.runId); if (row && row.endedSeq === null) { row.endedSeq = event.seq; row.input = input(data.input); row.endedEffect = effect(data.contextEffect); } break; }
      case "session.recovered":
        for (const id of [...strings(data.unknownRunIds), ...strings(data.cancelledRunIds)]) { const row = turn(id); if (row && row.endedSeq === null && row.recoveredSeq === null) row.recoveredSeq = event.seq; }
        break;
    }
  }
  const factSeq = (run: PublicRun): number | null => { const row = turns.get(run.id)!; return row.endedSeq ?? row.recoveredSeq; };
  /** A command Turn's effect: recorded at its end (G067 on), else its declared one as far as it ran (G067's own rule). */
  const effectOf = (run: PublicRun, harnessId: string): ContextEffect => {
    const row = turns.get(run.id)!;
    if (row.command === null) return "none";
    if (row.endedEffect !== undefined) return row.endedEffect;
    const declared = row.command.declared ?? options.commandEffect?.(harnessId, row.command.name) ?? "unknown";
    return commandEffect(declared, commandOutcome(dispatched(run), run.backend?.status ?? null, row.input ?? (dispatched(run) ? "unknown" : "not_recorded")));
  };
  // Pass 2: the binding lineage. Bindings are made by the Session's creation (an import, a branch's native fork) and by each
  // `native.binding_prepared{resumed: false}`; each takes the next epoch of its Harness control, a confirmed clear adds one.
  interface Lineage { readonly harnessId: string; readonly controlId: string; readonly source: BindingSource; epoch: number; readonly startEpoch: number; archivedAt: number | null }
  const made: Lineage[] = [], active = new Map<string, number>(), maxEpoch = new Map<string, number>();
  const runBinding = new Map<string, number>(), runEpoch = new Map<string, number>();
  const make = (harnessId: string, controlId: string, source: BindingSource): void => {
    const key = harnessId + ":" + controlId, epoch = (maxEpoch.get(key) ?? 0) + 1;
    maxEpoch.set(key, epoch); active.set(key, made.length); made.push({ harnessId, controlId, source, epoch, startEpoch: epoch, archivedAt: null });
  };
  const archive = (harnessId: string, controlId: string, seq: number): void => {
    const key = harnessId + ":" + controlId, index = active.get(key);
    if (index !== undefined) { made[index]!.archivedAt = seq; active.delete(key); }
  };
  for (const event of events) {
    const data = event.data, harnessId = text(data.harnessId), controlId = text(data.controlId);
    switch (event.type) {
      case "session.created": {
        const first = bindings[0];
        if (first === undefined) break;
        if (state12.origin?.kind === "import") make(first.harnessId, first.controlId, "import");
        else if (data.continuity === "native_fork") make(first.harnessId, first.controlId, "fork");
        break;
      }
      case "native.binding_prepared": {
        if (harnessId === undefined || controlId === undefined) throw new SessionError("INVALID_DATA", "a native binding event names no Harness control");
        if (data.resumed === false) make(harnessId, controlId, "new");
        const index = active.get(harnessId + ":" + controlId), id = text(data.runId);
        if (index !== undefined && id !== undefined && turns.has(id)) { runBinding.set(id, index); runEpoch.set(id, made[index]!.epoch); }
        break;
      }
      case "native.branch_requested": case "native.fork_failed":
        if (harnessId !== undefined && controlId !== undefined) archive(harnessId, controlId, event.seq);
        break;
      case "run.ended": {
        const id = text(data.runId), index = id === undefined ? undefined : runBinding.get(id), run = id === undefined ? undefined : runs[position.get(id) ?? -1];
        if (index === undefined || run === undefined || runEpoch.get(run.id) !== made[index]!.epoch) break;
        const binding = made[index]!, key = binding.harnessId + ":" + binding.controlId;
        if (effectOf(run, binding.harnessId) === "clear") { binding.epoch = (maxEpoch.get(key) ?? 0) + 1; maxEpoch.set(key, binding.epoch); }
        break;
      }
    }
  }
  if (made.length !== bindings.length || made.some((row, index) => row.harnessId !== bindings[index]!.harnessId || row.controlId !== bindings[index]!.controlId))
    throw new SessionError("INVALID_DATA", "a v12 Session's native bindings do not match the bindings its events made");
  const executedOn = (run: PublicRun): ExecutedOn | null => {
    const index = runBinding.get(run.id), epoch = runEpoch.get(run.id);
    return index === undefined || epoch === undefined || run.selection.provider !== undefined ? null : { harnessId: made[index]!.harnessId, controlId: made[index]!.controlId, nativeEpoch: epoch };
  };
  // The public facts: finished dispatched Turns that are not native commands, with their fact seq (their run.ended's, or the
  // recovery's that ended them) and where they ran.
  interface Fact { readonly runId: string; readonly index: number; readonly seq: number; readonly on: ExecutedOn | null }
  const facts: Fact[] = [];
  for (const [index, run] of runs.entries()) {
    const seq = factSeq(run);
    if (terminal(run.status) && dispatched(run) && seq !== null && turns.get(run.id)!.command === null) facts.push({ runId: run.id, index, seq, on: executedOn(run) });
  }
  const originHistory = (state12.origin?.history.length ?? 0) > 0;
  const foreign = (fact: Fact, harnessId: string, controlId: string, epoch: number): boolean =>
    fact.on === null || fact.on.harnessId !== harnessId || fact.on.controlId !== controlId || fact.on.nativeEpoch !== epoch;
  // Pass 3: each binding's own Turns, in Run order.
  const floors = new Map<string, number>();
  const result = made.map((binding, index): BindingRelayState => {
    const key = binding.harnessId + ":" + binding.controlId, snapshot = bindings[index]!;
    const through = snapshot.throughRunId === null ? -1 : position.get(snapshot.throughRunId) ?? -1;
    const asOf = binding.archivedAt ?? Number.MAX_SAFE_INTEGER;
    let floor = binding.source === "new" ? floors.get(key) ?? -1 : -1, mark: number | null = binding.source === "new" ? null : 0;
    let originIncluded = binding.source !== "new", cleared = false, suspicious = false, epoch = binding.startEpoch;
    /** The facts owed at `epoch` with seq in (base, upTo], and whether the Session's own history is owed too. */
    const owed = (base: number, upTo: number, at: number) => ({
      facts: facts.filter(fact => fact.seq > base && fact.seq <= upTo && foreign(fact, binding.harnessId, binding.controlId, at)).sort((a, b) => a.seq - b.seq),
      origin: !originIncluded && originHistory && base < 0 });
    for (const run of runs) {
      if (runBinding.get(run.id) !== index || !dispatched(run)) continue;
      const row = turns.get(run.id)!, at = runEpoch.get(run.id) ?? epoch, base = Math.max(mark ?? -1, floor);
      epoch = at;
      const legacy = row.input === undefined, rejected = REJECTED.has(run.backend?.reason ?? "");
      const delivered = run.status !== "unknown" && run.status !== "cancelled" && !rejected && (row.input === "recorded" || legacy && run.status === "completed");
      const within = (position.get(run.id) ?? Number.MAX_SAFE_INTEGER) <= through;
      if (row.command !== null) {
        if (effectOf(run, binding.harnessId) === "clear") { floor = factSeq(run) ?? floor; mark = null; cleared = true; suspicious = false; originIncluded = false; epoch = at + 1; }
        else suspicious = true;
        continue;
      }
      const sources = new Set(row.sources), carried = row.sources.length > 0 || row.carriedOrigin;
      if (carried) {
        if (within && delivered) {
          // A packet moves the mark only as far as its sources cover every fact owed from the old mark on; a packet that
          // skipped an owed fact (pre-G067 data, where a command could move the v12 position past it) stops before it.
          const carriedFacts = facts.filter(fact => sources.has(fact.runId));
          const top = Math.max(-1, ...carriedFacts.map(fact => fact.seq)), gap = owed(base, top, at);
          // Before G067 every packet repeated the history the Session started from; from G067 it says so itself.
          const originCovered = row.carriedOrigin || legacy && row.sources.length > 0;
          if (!gap.origin || originCovered) {
            let reached = gap.origin ? 0 : -1;
            for (const fact of gap.facts) { if (!sources.has(fact.runId)) break; reached = fact.seq; }
            if (reached >= 0) mark = Math.max(mark ?? -1, reached);
          }
          cleared = false; suspicious = false;
        } else if (rejected || run.status === "unknown" || run.status === "cancelled" || row.input === "unknown") suspicious = true;
        continue;
      }
      if (within && delivered && !row.sentAlone) {
        // A Turn the native session ran itself while nothing was owed: everything before its context is known there.
        const gap = owed(base, run.contextThroughSeq, at);
        if (!gap.origin && gap.facts.length === 0) mark = Math.max(mark ?? -1, run.contextThroughSeq);
      } else if (rejected) suspicious = true;
    }
    floors.set(key, floor);
    const last = runs.findLast(run => runBinding.get(run.id) === index && dispatched(run) && run.usage?.context !== undefined)?.usage?.context;
    const cache = last === undefined ? NO_CACHE : { lastRequestStartedAt: null, contextUsed: last.used <= MAX_RELAY_COUNTER ? last.used : null, contextSize: last.size !== undefined && last.size <= MAX_RELAY_COUNTER ? last.size : null };
    const model = snapshot.observed?.model ?? null;
    const vendor: VendorObservation | null = snapshot.observed === undefined ? null
      : { model: model !== null && new TextEncoder().encode(model).byteLength <= MAX_RELAY_MODEL_BYTES ? model : null, modelKey: "", authKind: null, endpoint: null, loopback: false };
    const finalEpoch = binding.epoch, withSync = (sync: BindingSync) => state(finalEpoch, sync, originIncluded, floor, vendor, cache);
    // A clear after the last packet: the native session holds nothing the Hub must count on (§14.4).
    if (cleared) return withSync({ kind: "fresh", basis: "user_cleared" });
    // An import's or a branch's native session holds the Session's starting history (§14.4, RT1-B2).
    if (binding.source !== "new") return withSync({ kind: "synced", mark: ORIGIN_MARK });
    const need = owed(Math.max(mark ?? -1, floor), asOf, finalEpoch), owing = need.origin || need.facts.length > 0;
    // Without any evidence of what it holds a binding is fresh, or suspect when a command or a refusal may have changed it
    // while facts are owed (the D1 shape, RT1-B1).
    if (mark === null) return withSync(suspicious && owing ? { kind: "suspect", mark: null, cause: "legacy", floorCandidate: null, carried: null, rewound: false }
      : { kind: "fresh", basis: made.slice(0, index).some(row => row.harnessId === binding.harnessId && row.controlId === binding.controlId) ? "reset" : "new" });
    return withSync(owing && suspicious ? { kind: "suspect", mark: legacyMark(mark), cause: "legacy", floorCandidate: null, carried: null, rewound: false } : { kind: "synced", mark: legacyMark(mark) });
  });
  const indexes = runs.flatMap((run, index): RelayBehindIndex[] => {
    const seq = factSeq(run);
    if (!terminal(run.status) || !dispatched(run) || seq === null) return [];
    const row = turns.get(run.id)!, on = executedOn(run);
    return [{ runId: run.id as RunId, index, seq, executedOn: on, dispatched: true, status: run.status, input: row.input ?? "unknown",
      commandEffect: row.command === null ? null : effectOf(run, run.selection.harnessId) }];
  });
  return { bindings: result, runs: indexes };
}
