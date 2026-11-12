import type { Conversation, ConversationReader, TurnRelayCounts } from "../../../../contracts/conversation.js";
import type { NativeSessionBinding, PublicRun, SessionId, SessionOrigin } from "../../../../contracts/session.js";
import { originFromRows } from "../store-conversion.js";
import { outlineOfRecord, turnSource, type OutlineReads, type TurnOutline, type TurnRecord } from "../turn-source.js";

/*
 * What the relay's renderer reads of a conversation (ADR-057 3.3, readers): the Runs without their words, which are light and all there; the native bindings; the history the conversation started
 * from; and the words of one Turn when one is asked for — its user's words, its reply, its tool calls — read from the rows then and not before. A packet is made of the Turns a binding is owed, so
 * a packet reads those and no others; nothing reads the conversation whole.
 */

/** A Run as the renderer's first look sees it: everything a Run is but its words and lists; `userSeq` places the user's message among the events (the place the old shape gave it as its message's seq). */
export type RelayRun = Omit<PublicRun, "thinking" | "tools" | "plan" | "notices" | "activities" | "outputs" | "protocol" | "input"> & { readonly userSeq?: number };
export interface RelayHistory {
  readonly id: SessionId;
  readonly lastSeq: number;
  /** In conversation order: the index of a Run is its ordinal. */
  readonly runs: readonly RelayRun[];
  readonly nativeBindings?: readonly NativeSessionBinding[];
  /** The history the conversation started from (a branch's quote, an import's messages); absent for none. */
  readonly origin?: SessionOrigin | undefined;
  /** The Turn at an ordinal, with its words; null when there is none. A Turn is read once. */
  turn(ordinal: number): TurnRecord | null;
  /** The Turn at an ordinal without its bodies (turn-source.ts `TurnOutline`): what a packet counts every Turn it owes by; the words are read when a piece of the packet needs them. Absent: `turn` tells it. */
  outline?(ordinal: number): TurnOutline | null;
  /** What the ledger counts of the finished Turn at an ordinal, recorded when it ended; null when nothing was recorded (the Turn is then read). Optional. */
  counts?(ordinal: number): TurnRelayCounts | null;
  /** How the work stands: the conversation's latest task list, and the wrap-up of its latest finished Turn, each with the Turn it belongs to. Optional. */
  progress?(): RelayProgress;
}
/** The task list a packet carries (its steps and their states) and the wrap-up of the Turn before; `turn` counts from 1. */
export interface RelayProgress {
  readonly plan?: { readonly turn: number; readonly harnessId: string; readonly steps: readonly { readonly text: string; readonly status: "pending" | "in_progress" | "completed" }[] };
  readonly recap?: { readonly turn: number; readonly harnessId: string; readonly summary: string; readonly ask?: string };
}
type ProgressRow = { readonly ordinal: number; readonly harnessId: string; readonly row: { readonly fields: unknown } } | null;
/** The outline of a Turn of a history: its own when it has one, else made of the Turn read whole. */
export function outlineOf(history: RelayHistory, ordinal: number): TurnOutline | null {
  if (history.outline !== undefined) return history.outline(ordinal);
  const record = history.turn(ordinal);
  return record === null ? null : outlineOfRecord(record);
}

/** A conversation kept as rows, as the renderer reads it: the light rows of its Runs now, its Turns when asked for, the history it quoted when a packet owes it. */
export function rowsHistory(conversation: Conversation, reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory"> & OutlineReads
  & { readonly relayCounts?: (id: Conversation["id"], runId: Conversation["runs"][number]["id"]) => TurnRelayCounts | null; readonly latestPlan?: (id: Conversation["id"]) => ProgressRow;
    readonly latestRecap?: (id: Conversation["id"]) => ProgressRow }): RelayHistory {
  const turns = turnSource(reader, conversation.id);
  let origin: SessionOrigin | null | undefined;
  return {
    id: conversation.id, lastSeq: conversation.lastSeq, runs: conversation.runs, ...(conversation.nativeBindings === undefined ? {} : { nativeBindings: conversation.nativeBindings }),
    get origin(): SessionOrigin | undefined {
      if (conversation.origin === undefined) return undefined;
      origin ??= originFromRows(conversation.origin, reader.originHistory?.(conversation.id) ?? []);
      return origin ?? undefined;
    },
    turn: ordinal => turns.turn(ordinal),
    outline: ordinal => turns.outline(ordinal),
    counts: ordinal => { const run = conversation.runs[ordinal]; return run === undefined ? null : reader.relayCounts?.(conversation.id, run.id) ?? null; },
    progress: () => {
      const plan = reader.latestPlan?.(conversation.id) ?? null, recap = reader.latestRecap?.(conversation.id) ?? null;
      const steps = (plan?.row.fields as { readonly steps?: unknown } | undefined)?.steps, said = recap?.row.fields as { readonly summary?: unknown; readonly ask?: unknown } | undefined;
      return { ...(plan === null || !Array.isArray(steps) || steps.length === 0 ? {} : { plan: { turn: plan.ordinal + 1, harnessId: plan.harnessId, steps: steps as NonNullable<RelayProgress["plan"]>["steps"] } }),
        ...(recap === null || typeof said?.summary !== "string" ? {} : { recap: { turn: recap.ordinal + 1, harnessId: recap.harnessId, summary: said.summary, ...(typeof said.ask === "string" ? { ask: said.ask } : {}) } }) };
    },
  };
}
