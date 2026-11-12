/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T4): `RelayLedger` of src/contexts/session/application/relay-coordinator.ts as it was at the end of store v13 (commit
 * 1a5f020): the public facts of a Session as its events place them. The v14 migration holds the new reading of these facts (the Runs' columns) to this one on
 * every binding of every conversation it converts, so this copy is the "old" side of that comparison whatever the live ledger becomes (at the cut it is
 * rewritten to read columns). Do not edit it and do not import a live parser into it.
 */
import type { ContextEffect } from "../../../contracts/control.js";
import type { ExecutedOn, RelayIndexRow } from "../../../contracts/relay.js";
import type { RunId, SessionEvent, SessionId, SessionSnapshot, PublicRun } from "../../../contracts/session.js";
import type { RelayFact } from "../../../contexts/session/domain/relay/delivery.js";
import { dispatched } from "./advance.js";
import { RELAY_MAX_SEQ, parseExecutedOn } from "./relay-contract.js";
import { terminal } from "./state.js";

const CONTEXT_EFFECTS = ["keep", "none", "compact", "clear", "rewind", "unknown"] as const;
type EventReader = (id: SessionId, afterSeq: number, limit: number) => readonly SessionEvent[];

function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
/** A stored context effect, or undefined for anything else. */
function contextEffectOf(value: unknown): ContextEffect | undefined { return typeof value === "string" && (CONTEXT_EFFECTS as readonly string[]).includes(value) ? value as ContextEffect : undefined; }
function executedOf(value: unknown): ExecutedOn | null {
  if (value === null || value === undefined) return null;
  try { return parseExecutedOn(value); } catch { return null; }
}

export class LegacyRelayLedger {
  private readonly sessions = new Map<SessionId, { after: number; readonly ended: Map<string, number>; readonly commands: Map<string, ContextEffect | undefined>; readonly settled: Map<string, ContextEffect> }>();
  constructor(private readonly events: EventReader) {}
  private scan(state: SessionSnapshot): { readonly ended: ReadonlyMap<string, number>; readonly commands: ReadonlyMap<string, ContextEffect | undefined>; readonly settled: ReadonlyMap<string, ContextEffect> } {
    let known = this.sessions.get(state.id);
    if (known === undefined || known.after > state.lastSeq) { known = { after: 0, ended: new Map(), commands: new Map(), settled: new Map() }; this.sessions.set(state.id, known); }
    while (known.after < state.lastSeq) {
      const page = this.events(state.id, known.after, 100);
      if (!page.length) break;
      for (const item of page) {
        const data = item.data, run = typeof data.runId === "string" ? data.runId : null;
        if (item.type === "run.ended" && run !== null && !known.ended.has(run)) {
          known.ended.set(run, item.seq);
          const effect = contextEffectOf(data.contextEffect);
          if (effect !== undefined) known.settled.set(run, effect);
        }
        else if (item.type === "run.native_command" && run !== null) known.commands.set(run, contextEffectOf(data.contextEffect));
        else if (item.type === "session.recovered")
          for (const id of [...strings(data.unknownRunIds), ...strings(data.cancelledRunIds)]) if (!known.ended.has(id)) known.ended.set(id, item.seq);
      }
      known.after = page.at(-1)!.seq;
    }
    return known;
  }
  /** The fact seq of a finished Run, when its events place it. */
  endedSeq(state: SessionSnapshot, run: RunId): number | undefined { return this.scan(state).ended.get(run); }
  /** The public facts of the Session foreign to `binding`: each finished, dispatched Run that did not run there (a native command only when its effect kept), with its fact seq and where it ran. */
  facts(state: SessionSnapshot, index: readonly RelayIndexRow[], binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }): readonly RelayFact[] {
    const rows = new Map<string, Readonly<Record<string, unknown>>>();
    for (const row of index) if (!rows.has(row.runId)) rows.set(row.runId, row.index);
    const candidates: { readonly run: PublicRun; readonly row: Readonly<Record<string, unknown>> | undefined; readonly executedOn: ExecutedOn | null }[] = [];
    for (const run of state.runs) {
      if (!terminal(run.status) || !dispatched(run)) continue;
      const row = rows.get(run.id);
      // A Run from before v13 that the migration found to be a command (its effect is in its index row) is a fact only when it kept.
      if (run.relay === undefined && row?.commandEffect != null && row.commandEffect !== "keep") continue;
      const executedOn = run.relay !== undefined ? run.relay.executedOn : executedOf(row?.executedOn);
      if (executedOn !== null && executedOn.harnessId === binding.harnessId && executedOn.controlId === binding.controlId && executedOn.nativeEpoch === binding.nativeEpoch) continue;
      candidates.push({ run, row, executedOn });
    }
    if (candidates.length === 0) return [];
    const scanned = this.scan(state), facts: RelayFact[] = [];
    for (const { run, row, executedOn } of candidates) {
      // A command Turn is a fact only when it kept: its effect is the index row's for a Run from before v13, else the one its end settled
      // (a keep that never ran is none), else the one it was read with (a Turn that a recovery ended).
      if (scanned.commands.has(run.id) && (run.relay === undefined ? row?.commandEffect : scanned.settled.get(run.id) ?? scanned.commands.get(run.id)) !== "keep") continue;
      const indexed = typeof row?.seq === "number" && Number.isSafeInteger(row.seq) && row.seq >= 0 && row.seq <= RELAY_MAX_SEQ ? row.seq : undefined;
      facts.push({ runId: run.id, seq: scanned.ended.get(run.id) ?? indexed ?? state.lastSeq, executedOn });
    }
    return facts;
  }
}
