import { relayDecisionOf, type DeliveryRecord, type RelayDecision } from "../contracts/relay.js";
import type { Conversation } from "../contracts/conversation.js";
import { SessionError, type SessionEvent, type SessionId } from "../contracts/session.js";
import type { RunRow } from "../contracts/conversation.js";
import type { RunRelayReading } from "./turn-view.js";
import { deliveryView } from "./relay-routes.js";

/*
 * What the relay says of a Run that the Run's own row does not (src/web/turn-view.ts `RunRelayReading`): how its packet arrived, which changes after the Turn, and what the
 * relay decided for its context, which only the event that recorded it holds. Read when a Run that carries one is made into the wire's Run, and only then: the delivery rows
 * of the conversation when the first Run with a packet is asked for, the events when the first Run that can have a decision is. A conversation that stayed on one control
 * from nothing has nothing to read. Committed rows only; nothing but the decisions already found is held between reads.
 */

/** The delivery of a packet no row tracks: no evidence of it exists (relay-architecture §4: no evidence is unknown, never not recorded). */
const UNTRACKED = Object.freeze({ state: "unknown" as const, evidence: null });
/** The conversations whose decisions are kept at most (the least recently read go first). */
const DECISION_SESSIONS = 64;

export interface RunRelayReads {
  relayDeliveries(id: SessionId): readonly DeliveryRecord[];
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
  /** The conversation as the Runtime holds it (its light Runs: no items). */
  get(id: SessionId): Conversation;
}

/**
 * Whether a Turn of the conversation can have recorded a relay decision: only a conversation that ran on more than one Harness control, carried a packet, kept a request's choices
 * or began from quoted history owes anything to anyone. A conversation that stayed on one control from nothing needs no read of its events at all.
 */
function mayHaveDecisions(conversation: Conversation): boolean {
  if (conversation.origin !== undefined) return true;
  const controls = new Set<string>();
  for (const run of conversation.runs) {
    if (run.relay?.packetId != null || run.relayRequest !== undefined) return true;
    const on = run.relay?.executedOn ?? run.selection;
    controls.add(on.harnessId + "\0" + on.controlId);
    if (controls.size > 1) return true;
  }
  return false;
}

export class RunRelayReader {
  private readonly ledgers = new Map<SessionId, { after: number; readonly byRun: Map<string, RelayDecision> }>();
  constructor(private readonly reads: RunRelayReads) {}

  /** The decision each Run's `run.context_prepared` recorded, by Run: the conversation's events are read once, from where the last read stopped. */
  private decisions(id: SessionId, lastSeq: number): ReadonlyMap<string, RelayDecision> {
    let known = this.ledgers.get(id);
    if (known === undefined || known.after > lastSeq) known = { after: 0, byRun: new Map() };
    this.ledgers.delete(id); this.ledgers.set(id, known);
    if (this.ledgers.size > DECISION_SESSIONS) this.ledgers.delete(this.ledgers.keys().next().value!);
    while (known.after < lastSeq) {
      const page = this.reads.events(id, known.after, 100);
      if (!page.length) break;
      for (const item of page) {
        const run = item.data.runId;
        if (item.type !== "run.context_prepared" || typeof run !== "string") continue;
        const decision = relayDecisionOf(item.data);
        if (decision !== null) known.byRun.set(run, decision);
      }
      known.after = page.at(-1)!.seq;
    }
    return known.byRun;
  }

  /** The reading of the Runs of one conversation, for one read of it or one commit's frame. */
  of(id: SessionId): (row: RunRow) => RunRelayReading {
    let deliveries: ReadonlyMap<string, DeliveryRecord> | null | undefined;
    let decisions: ReadonlyMap<string, RelayDecision> | undefined;
    const rowsOf = (): ReadonlyMap<string, DeliveryRecord> | null => {
      if (deliveries !== undefined) return deliveries;
      try { deliveries = new Map(this.reads.relayDeliveries(id).map(row => [row.runId as string, row])); }
      // Rows that cannot be read leave out what they would have added (a derived read never fails the conversation).
      catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") deliveries = null; else throw error; }
      return deliveries;
    };
    const decided = (): ReadonlyMap<string, RelayDecision> => {
      if (decisions !== undefined) return decisions;
      const conversation = this.reads.get(id);
      try { decisions = mayHaveDecisions(conversation) ? this.decisions(id, conversation.lastSeq) : new Map(); }
      catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") decisions = new Map(); else throw error; }
      return decisions;
    };
    return row => {
      const relay = row.facts.relay;
      if (relay === undefined) return {};
      let delivery: RunRelayReading["delivery"];
      if (relay.packetId != null) {
        const rows = rowsOf();
        if (rows !== null) { const kept = rows.get(row.runId); delivery = kept === undefined ? UNTRACKED : deliveryView(kept.outcome); }
      }
      const decision = decided().get(row.runId);
      return { ...(delivery === undefined ? {} : { delivery }), ...(decision === undefined ? {} : { decision }) };
    };
  }
}
