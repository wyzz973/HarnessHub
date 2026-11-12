import type { ConversationRun, HeldItem, RunFacts, RunRow } from "../../../contracts/conversation.js";
import type { PublicRun, SessionId } from "../../../contracts/session.js";

/*
 * A Run as the Runtime holds it (`ConversationRun`) and as its row (`RunRow`): the one pair of functions that says which properties of a Run are columns and which
 * are its `run_json` facts. It is the domain's (the Runtime opens the Turn in progress with the row of its Run, and the storage reads and writes the same pair), and the
 * rows module of the storage re-exports it.
 */

/** The properties of a Run that `run_json` holds (the others are columns, items, or the display's). */
export const RUN_FACT_KEYS = ["userMessageId", "assistantMessageId", "selection", "contextThroughSeq", "sourceRunIds", "backend", "cleanup", "error", "usage", "attachments", "timing", "retained",
  "reused", "relay", "relayRequest", "awaitingSwitchId", "emptyLists"] as const satisfies readonly (keyof RunFacts)[];

/** The object with only its defined properties among `keys` (the contract's optional properties have no place for an undefined). */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out as Pick<T, K>;
}

/**
 * Whether a Run was handed to its Harness: the rule of relay/advance.ts `dispatched`, over the properties a ConversationRun has. A Run from
 * before Session v10 has no times and counts as dispatched when its Harness settled it or it ended unknown.
 */
export function isDispatched(run: Pick<PublicRun, "timing" | "backend" | "status">): boolean {
  return run.timing === undefined ? run.backend !== null || run.status === "unknown" : run.timing.dispatchedAt !== undefined;
}

/** The row of a Run as the conversation holds it. `ordinal` and the seqs are the Run's own; the store writes over the seqs a Mutation takes from events. */
export function runRowOf(sessionId: SessionId, run: ConversationRun): RunRow {
  return { sessionId, ordinal: run.ordinal, runId: run.id, commandId: run.commandId, status: run.status, epoch: run.epoch, harnessId: run.selection.harnessId, controlId: run.selection.controlId,
    managed: run.selection.provider !== undefined, acceptedAt: run.timing?.acceptedAt ?? null, preparingAt: run.timing?.preparingAt ?? null, readyAt: run.timing?.readyAt ?? null, reused: run.reused === true,
    userSeq: run.userSeq, endedSeq: run.endedSeq ?? null, dispatched: isDispatched(run), executedOn: run.relay?.executedOn ?? run.executedOn ?? null, isCommand: run.isCommand, commandEffect: run.commandEffect ?? null,
    settledEffect: run.settledEffect ?? null, acknowledgedBy: run.acknowledgedBy ?? null, cancelRequested: run.cancelRequested, stopRequested: run.stopRequested, legacyOrder: run.legacyOrder === true,
    facts: pick(run, RUN_FACT_KEYS) as RunFacts };
}

/** The Run the Runtime reduces, from its row; `items` only for a Run that is not finished. */
export function conversationRunOf(row: RunRow, items?: readonly HeldItem[]): ConversationRun {
  return { id: row.runId, commandId: row.commandId, epoch: row.epoch, status: row.status, cancelRequested: row.cancelRequested, stopRequested: row.stopRequested, ...row.facts,
    ordinal: row.ordinal, userSeq: row.userSeq, ...(row.endedSeq === null ? {} : { endedSeq: row.endedSeq }), isCommand: row.isCommand,
    ...(row.commandEffect === null ? {} : { commandEffect: row.commandEffect }), ...(row.settledEffect === null ? {} : { settledEffect: row.settledEffect }),
    ...(row.acknowledgedBy === null ? {} : { acknowledgedBy: row.acknowledgedBy }), ...(row.legacyOrder ? { legacyOrder: true as const } : {}),
    ...(row.executedOn !== null && row.facts.relay === undefined ? { executedOn: row.executedOn } : {}), ...(items === undefined ? {} : { items }) };
}
