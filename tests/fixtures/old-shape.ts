import type { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import type { RelayHistory } from "../../src/contexts/session/domain/relay/history.js";
import type { TableConversation } from "../../src/contexts/session/domain/table.js";
import { outlineOfRecord, type TurnRecord, type TurnSource } from "../../src/contexts/session/domain/turn-source.js";
import { relayDecisionOf, type DeliveryRecord, type RelayDecision } from "../../src/contracts/relay.js";
import { SessionError, type PublicMessage, type PublicRun, type SessionEvent, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import type { WebRun } from "../../src/contracts/web.js";
import { turnDiagnostics, type TurnDiagnosticsInput } from "../../src/web/run-diagnostics.js";
import { deliveryView } from "../../src/web/relay-routes.js";

/*
 * A conversation in its old whole shape (`SessionSnapshot`), for the tests that hold what a reader says to what the old store said, and for the ones that look at a Run's whole
 * record. Nothing in `src/` reads a conversation so any more (tools/check-boundaries.mjs, B11 and B12): the production readers read pages of rows and one Turn at a time. The shape is made by the
 * store's own adapter over the rows (`SqliteConversationStore.snapshot`, kept for this and for the migration's checks), so a test that reads it sees the rows through the conversion that
 * is held to be the inverse of the one that wrote them. The adapters below are the ones the readers had for a caller that held the snapshot already; they stand here as the oracle the
 * readers over rows are compared with, and as a way to give a reader a conversation made by hand.
 */

/** What the old shape is read from: a store with the adapter, or a Runtime that holds one. */
export interface OldShapeStore { snapshot(id: SessionId): SessionSnapshot }
/** The conversation `id` in the old shape, from a store, or from the store a Runtime was made with. */
export function oldShape(from: OldShapeStore | SessionRuntime, id: SessionId): SessionSnapshot {
  const store = "snapshot" in from ? from : (from as unknown as { readonly store: OldShapeStore }).store;
  return store.snapshot(id);
}

/** The Turns of a conversation as the old whole shape tells them. Nothing is read, and no Turn is `legacyOrder` (the old shape does not say). */
export function snapshotTurns(snapshot: SessionSnapshot): TurnSource {
  const messages = new Map(snapshot.messages.map(message => [message.id as string, message]));
  const turn = (ordinal: number): TurnRecord | null => {
    const run = Number.isInteger(ordinal) && ordinal >= 0 ? snapshot.runs[ordinal] : undefined;
    if (run === undefined) return null;
    const user = messages.get(run.userMessageId) ?? { id: run.userMessageId, runId: run.id, role: "user" as const, text: run.input, seq: 0, status: run.status };
    return { ordinal, run, user, assistant: messages.get(run.assistantMessageId), legacyOrder: false };
  };
  return {
    id: snapshot.id, count: snapshot.runs.length, turn,
    outline: ordinal => { const record = turn(ordinal); return record === null ? null : outlineOfRecord(record); },
    ordinalOf: runId => { const found = snapshot.runs.findIndex(run => run.id === runId); return found < 0 ? null : found; },
  };
}
/** A conversation in the old whole shape as the context table reads it. */
export function snapshotTable(state: SessionSnapshot): TableConversation {
  return { id: state.id, workspace: state.configuration.workspace, activeRunId: state.activeRunId, turns: snapshotTurns(state), harnessIds: () => [...new Set(state.runs.map(run => run.selection.harnessId))].sort(),
    ...(state.origin === undefined ? {} : { origin: { kind: state.origin.kind, messages: state.origin.history.length } }) };
}
/** A conversation in the old whole shape as the relay's renderer reads it. */
export function snapshotHistory(state: SessionSnapshot): RelayHistory {
  const places = new Map(state.messages.map(message => [message.id as string, message.seq])), turns = snapshotTurns(state);
  return { id: state.id, lastSeq: state.lastSeq, runs: state.runs.map(run => places.has(run.userMessageId) ? { ...run, userSeq: places.get(run.userMessageId)! } : run),
    ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings }), ...(state.origin === undefined ? {} : { origin: state.origin }), turn: ordinal => turns.turn(ordinal), outline: ordinal => turns.outline(ordinal) };
}

/** What a Turn's report was made from when the conversation was held whole: the snapshot and the Run in it. */
export interface RunDiagnosticsInput extends Omit<TurnDiagnosticsInput, "turn" | "turns" | "messages"> {
  readonly session: SessionSnapshot;
  readonly run: PublicRun;
}
/** The report of a Run of a conversation held whole in the old shape: the messages the log is checked against are all the conversation's. */
export function runDiagnostics(input: RunDiagnosticsInput): string {
  const { session, run, ...rest } = input, ordinal = session.runs.findIndex(item => item.id === run.id);
  const user: PublicMessage = session.messages.find(message => message.id === run.userMessageId) ?? { id: run.userMessageId, runId: run.id, role: "user", text: run.input, seq: 0, status: run.status };
  return turnDiagnostics({ ...rest, turn: { ordinal, run, user, assistant: session.messages.find(message => message.id === run.assistantMessageId), legacyOrder: false }, turns: session.runs.length,
    messages: () => session.messages.map(message => message.text) });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Runs as the old view showed them
// ---------------------------------------------------------------------------------------------------------------------

/** What the old view read to show the relay's part of a Run: the delivery rows of the conversation and its events. */
export interface RunViewReads {
  relayDeliveries(id: SessionId): readonly DeliveryRecord[];
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
}
/** The delivery of a packet no row tracks: no evidence of it exists. */
const UNTRACKED = Object.freeze({ state: "unknown" as const, evidence: null });
/** Whether a Turn of the conversation can have recorded a relay decision (a conversation that stayed on one control from nothing owes nothing to anyone). */
function mayHaveDecisions(snapshot: SessionSnapshot): boolean {
  if ((snapshot.origin?.history.length ?? 0) > 0) return true;
  const controls = new Set<string>();
  for (const run of snapshot.runs) {
    if (run.relay?.packetId != null || run.relayRequest !== undefined) return true;
    const on = run.relay?.executedOn ?? run.selection;
    controls.add(on.harnessId + "\0" + on.controlId);
    if (controls.size > 1) return true;
  }
  return false;
}
/**
 * The Runs of a conversation as the API showed them before the Runs were read from rows (`RelayApi.runViews`): each Run that carried a packet with its delivery state, each Run the relay decided
 * something for with that decision, and no Run with the choices it was asked with. The oracle of what `RunRelayReader` (src/web/run-relay.ts) says of a Run.
 */
export function runViews(snapshot: SessionSnapshot, reads: RunViewReads): readonly WebRun[] {
  if (!snapshot.runs.some(run => run.relay !== undefined || run.relayRequest !== undefined)) return snapshot.runs;
  let rows: ReadonlyMap<string, DeliveryRecord> | null = new Map();
  if (snapshot.runs.some(run => run.relay?.packetId != null)) {
    try { rows = new Map(reads.relayDeliveries(snapshot.id).map(row => [row.runId as string, row])); }
    catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") rows = null; else throw error; }
  }
  const decisions = new Map<string, RelayDecision>();
  if (mayHaveDecisions(snapshot)) {
    try {
      for (let after = 0; after < snapshot.lastSeq;) {
        const page = reads.events(snapshot.id, after, 100);
        if (!page.length) break;
        for (const item of page) {
          const run = item.data.runId;
          if (item.type !== "run.context_prepared" || typeof run !== "string") continue;
          const decision = relayDecisionOf(item.data);
          if (decision !== null) decisions.set(run, decision);
        }
        after = page.at(-1)!.seq;
      }
    } catch (error) { if (!(error instanceof SessionError && error.code === "INVALID_DATA")) throw error; }
  }
  return snapshot.runs.map(run => {
    const { relayRequest: _hidden, relay, ...rest } = run;
    if (relay === undefined) return run.relayRequest === undefined ? run : rest;
    const row = rows?.get(run.id), decision = decisions.get(run.id);
    const delivery = relay.packetId == null || rows === null ? undefined : row === undefined ? UNTRACKED : deliveryView(row.outcome);
    if (run.relayRequest === undefined && delivery === undefined && decision === undefined) return run;
    return { ...rest, relay: { ...relay, ...(delivery === undefined ? {} : { delivery }), ...(decision === undefined ? {} : { decision }) } };
  });
}
