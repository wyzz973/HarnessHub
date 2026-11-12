import type { Conversation, ConversationReader, ConversationRun, ConvertedRun, HeadRow, HeldItem, OriginHistoryRow, RunRow, TurnItems } from "../../../../src/contracts/conversation.js";
import type { PublicMessage, PublicRun, SessionEvent, SessionSnapshot } from "../../../../src/contracts/session.js";
import { fromItems, originToRows, toItems, type ConversionAt } from "../../../../src/contexts/session/domain/store-conversion.js";
import { runEnded } from "../../../../src/contexts/session/domain/protocol/index.js";
import { V13_FIXTURES, loadV13Fixture, type V13FixtureName } from "./database.js";

/**
 * The conversations of the v13 fixtures as the new storage holds them (ADR-057 stage 1): each Run converted by `toItems`, the `Conversation` the
 * Runtime would reduce (light rows; the items of the Runs not finished), and a `ConversationReader` standing in for the store, which hands back the
 * Turns and the head as the tables would. Test helpers: nothing here is the storage's own code.
 */
export type StoredEvent = Pick<SessionEvent, "seq" | "type" | "data">;
export interface BuiltConversation {
  readonly name: string;
  readonly conversation: Conversation;
  /** The Turn of each Run as the store holds it (the row, and the items with the counters the store keeps), by ordinal. */
  readonly turns: readonly TurnItems[];
  /** The content ids the conversion registers a reference to (`content_refs`), whatever the role. */
  readonly references: ReadonlySet<string>;
  /** The history a branch or an import quoted, as the rows the conversion writes. */
  readonly originHistory: readonly OriginHistoryRow[];
}

/** What a migration reads of the event log for each Run (see the top of store-conversion.ts), and the Run with its messages. */
export function atOf(snapshot: SessionSnapshot, events: readonly StoredEvent[]): { readonly run: PublicRun; readonly user: PublicMessage; readonly assistant?: PublicMessage; readonly at: ConversionAt }[] {
  const ended = new Map<string, number>(), commands = new Map<string, unknown>(), settled = new Map<string, unknown>();
  for (const event of events) {
    const run = typeof event.data.runId === "string" ? event.data.runId : null;
    if (event.type === "run.ended" && run !== null && !ended.has(run)) { ended.set(run, event.seq); settled.set(run, event.data.contextEffect); }
    else if (event.type === "run.native_command" && run !== null) commands.set(run, event.data.contextEffect);
    else if (event.type === "session.recovered") for (const id of [...(event.data.unknownRunIds as string[] ?? []), ...(event.data.cancelledRunIds as string[] ?? [])]) if (!ended.has(id)) ended.set(id, event.seq);
  }
  return snapshot.runs.map((run, ordinal) => {
    const user = snapshot.messages.find(message => message.id === run.userMessageId)!, assistant = snapshot.messages.find(message => message.id === run.assistantMessageId);
    const claimed = run.status === "unknown" ? snapshot.switches.find(sw => sw.status === "effective" && (sw.sourceRunIds.includes(run.id) || sw.acknowledgedUnknown?.includes(run.id) === true)) : undefined;
    const at: ConversionAt = { sessionId: snapshot.id, ordinal, ...(ended.has(run.id) ? { endedSeq: ended.get(run.id)! } : {}), ...(commands.has(run.id) ? { isCommand: true } : {}),
      ...(typeof commands.get(run.id) === "string" ? { commandEffect: commands.get(run.id) as never } : {}), ...(typeof settled.get(run.id) === "string" ? { settledEffect: settled.get(run.id) as never } : {}),
      ...(claimed === undefined ? {} : { acknowledgedBy: claimed.id }) };
    return { run, user, ...(assistant === undefined ? {} : { assistant }), at };
  });
}
/** An item as the store holds it: its counters are those of its chunks. */
export function stored(item: HeldItem): HeldItem {
  return { ...item, textChunks: item.text.length, textBytes: item.text.reduce((total, chunk) => total + Buffer.byteLength(chunk, "utf8"), 0) };
}
/** The Run as a conversation holds it in memory: the old Run without its display fields, the facts the old model read from the events, and the items while it is not finished. */
export function conversationRun(converted: ConvertedRun): ConversationRun {
  const { run } = fromItems(converted), row = converted.row;
  const { thinking: _t, tools: _l, plan: _p, notices: _n, activities: _a, outputs: _o, protocol: _x, input: _i, ...kept } = run;
  return { ...kept, ordinal: row.ordinal, userSeq: row.userSeq, ...(row.endedSeq === null ? {} : { endedSeq: row.endedSeq }), isCommand: row.isCommand,
    ...(row.commandEffect === null ? {} : { commandEffect: row.commandEffect }), ...(row.settledEffect === null ? {} : { settledEffect: row.settledEffect }),
    ...(row.acknowledgedBy === null ? {} : { acknowledgedBy: row.acknowledgedBy }), ...(row.legacyOrder ? { legacyOrder: true as const } : {}),
    ...(runEnded(row.status) ? {} : { items: converted.items.map(stored) }) };
}
export function conversationOf(name: string, snapshot: SessionSnapshot, events: readonly StoredEvent[]): BuiltConversation {
  const converted = atOf(snapshot, events).map(turn => toItems(turn.run, { user: turn.user, ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }) }, turn.at));
  const { schemaVersion: _version, runs: _runs, messages: _messages, origin, ...head } = snapshot;
  const parts = origin === undefined ? null : originToRows(snapshot.id, origin, -1);
  const conversation: Conversation = { ...head, format: 14, runs: converted.map(conversationRun), ...(parts === null ? {} : { origin: parts.stored }) };
  const references = new Set([...converted.flatMap(run => run.contentRefs.map(ref => ref.contentId as string)), ...(parts?.contentRefs.map(ref => ref.contentId as string) ?? [])]);
  return { name, conversation, turns: converted.map(run => ({ run: run.row, items: run.items.map(stored) })), references, originHistory: parts?.rows ?? [] };
}
/** Every conversation of every v13 fixture. */
export function fixtureConversations(): readonly BuiltConversation[] {
  const all: BuiltConversation[] = [];
  for (const name of V13_FIXTURES) for (const row of loadV13Fixture(name).sessions) all.push(conversationOf(name + " " + row.id, row.snapshot as unknown as SessionSnapshot, row.events));
  return all;
}
export function fixtureConversation(name: V13FixtureName, index = 0): BuiltConversation {
  const row = loadV13Fixture(name).sessions[index]!;
  return conversationOf(name + " " + row.id, row.snapshot as unknown as SessionSnapshot, row.events);
}

/** The head row the store would hold for a conversation. */
export function headOf(conversation: Conversation): HeadRow {
  return { id: conversation.id, version: conversation.version, lastSeq: conversation.lastSeq, format: 14, status: conversation.status, epoch: conversation.epoch, activeRunId: conversation.activeRunId,
    pendingSwitchId: conversation.pendingSwitchId, kept: conversation.retained !== undefined, title: "", runCount: conversation.runs.length, updatedAt: 0, deletedAt: null, lastError: null,
    head: { configuration: conversation.configuration, selection: conversation.selection, ...(conversation.retainNative === undefined ? {} : { retainNative: conversation.retainNative }),
      ...(conversation.retained === undefined ? {} : { retained: conversation.retained }), ...(conversation.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: conversation.relayRecoveryFailed }),
      ...(conversation.origin === undefined ? {} : { origin: conversation.origin }) } };
}
/** The row the store holds for a Run: the base row, with what the conversation says of the Run on top (a store that follows the memory it was written from). */
export function rowOf(run: ConversationRun, base: RunRow | undefined): RunRow {
  return { sessionId: base?.sessionId ?? ("session-none" as never), ordinal: run.ordinal, runId: run.id, commandId: run.commandId, status: run.status, epoch: run.epoch, harnessId: run.selection.harnessId, controlId: run.selection.controlId,
    managed: run.selection.provider !== undefined, acceptedAt: base?.acceptedAt ?? null, preparingAt: base?.preparingAt ?? null, readyAt: base?.readyAt ?? null, reused: run.reused === true, userSeq: run.userSeq,
    endedSeq: run.endedSeq ?? null, dispatched: base?.dispatched ?? false, executedOn: run.relay?.executedOn ?? null, isCommand: run.isCommand, commandEffect: run.commandEffect ?? null, settledEffect: run.settledEffect ?? null,
    acknowledgedBy: run.acknowledgedBy ?? null, cancelRequested: run.cancelRequested, stopRequested: run.stopRequested, legacyOrder: true,
    facts: base?.facts ?? { userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId, selection: run.selection, contextThroughSeq: run.contextThroughSeq, sourceRunIds: run.sourceRunIds, backend: run.backend, cleanup: run.cleanup, error: run.error, awaitingSwitchId: run.awaitingSwitchId } };
}
/** What a test may change in what the store holds, apart from the conversation: the items of a Run's Turn, the head, the row of a Run. */
export interface StoreOverrides {
  readonly items?: Readonly<Record<number, (items: readonly HeldItem[]) => readonly HeldItem[]>>;
  readonly head?: (head: HeadRow) => HeadRow;
  readonly rows?: Readonly<Record<number, (row: RunRow) => RunRow>>;
  /** The references the store has registered for the conversation, when they are not those the conversion wrote. */
  readonly references?: (references: ReadonlySet<string>) => ReadonlySet<string>;
  readonly originHistory?: (rows: readonly OriginHistoryRow[]) => readonly OriginHistoryRow[];
}
/** A reader standing in for the store: it follows the conversation it is given (the Turn at an ordinal is the Run whose ordinal that is) and answers only what `verify` asks. */
export function readerOf(conversation: Conversation, built: BuiltConversation, overrides: StoreOverrides = {}): ConversationReader {
  const unused = (): never => { throw new Error("not used by verify"); };
  return {
    head: () => overrides.head === undefined ? headOf(conversation) : overrides.head(headOf(conversation)),
    turnAt: (_id, ordinal) => {
      const index = conversation.runs.findIndex(run => run.ordinal === ordinal), run = conversation.runs[index];
      if (run === undefined) return null;
      const base = built.turns[index], row = rowOf(run, base?.run), items = (overrides.items?.[ordinal] ?? ((value: readonly HeldItem[]) => value))(base?.items ?? [stored({ runId: run.id, seq: 1, itemId: "user", type: "user_message", status: "completed", startedAt: null, endedAt: null, parentId: null,
        createdSeq: run.userSeq, textBytes: 0, textChunks: 0, fields: { type: "user_message", messageId: run.userMessageId }, text: ["input"] })]);
      return { run: overrides.rows?.[ordinal] === undefined ? row : overrides.rows[ordinal]!(row), items };
    },
    references: () => (overrides.references ?? ((value: ReadonlySet<string>) => value))(built.references),
    originHistory: () => (overrides.originHistory ?? ((value: readonly OriginHistoryRow[]) => value))(built.originHistory),
    window: unused, older: unused, items: unused, text: unused, search: unused,
  };
}
