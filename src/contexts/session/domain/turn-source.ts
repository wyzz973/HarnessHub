import type { ConversationReader, HeldItem, TurnItems } from "../../../contracts/conversation.js";
import type { PublicMessage, PublicRun, RunId, SessionId, SessionSnapshot } from "../../../contracts/session.js";
import { fromItems, restored } from "./store-conversion.js";

/*
 * What the readers of a conversation's history take it from (ADR-057 3.3, readers): one Turn at a time, by its place, read from the rows when it is asked for and not
 * before. A reader that wants the Turns of a window, or one Turn, or the newest ones until a budget is spent, reads exactly those; none of them is handed the whole
 * conversation. A Turn is its Run with the words said in it (what the readers have always been given, worked out from the Run's row and its items), and whether its
 * parts stand in a fixed order that is not the order they happened in (`legacyOrder`: a Turn kept from before the items had their place).
 */

/** One Turn as a reader of the history takes it. */
export interface TurnRecord {
  /** From 0, as the Run's row numbers it; the Turn's number to a reader (the table's `n`) is this plus one. */
  readonly ordinal: number;
  readonly run: PublicRun;
  readonly user: PublicMessage;
  /** The reply, joined from its segments; absent when the Turn has said nothing. */
  readonly assistant: PublicMessage | undefined;
  /** The Turn's parts are in the fixed arrangement a Turn from before v14 has, not in the order they happened. */
  readonly legacyOrder: boolean;
}
/** The Turns of one conversation, read when asked for. */
export interface TurnSource {
  readonly id: SessionId;
  /** How many Turns the conversation has. */
  readonly count: number;
  /** The Turn at an ordinal (from 0), or null when there is none. The same Turn is read once. */
  turn(ordinal: number): TurnRecord | null;
  /** The ordinal of a Run of this conversation by its identity; null when it has none (or the reader cannot say). */
  ordinalOf(runId: RunId): number | null;
}

/** The Turn a Turn's rows make (items whole: nothing is left out for its size). */
export function turnRecord(turn: TurnItems): TurnRecord {
  const { run, messages } = fromItems({ row: turn.run, items: turn.items, contentRefs: [] });
  return { ordinal: turn.run.ordinal, run, user: messages[0]!, assistant: messages[1], legacyOrder: turn.run.legacyOrder };
}

/** The Turns of a conversation kept as rows: read from `reader` one at a time, each once. */
export function turnSource(reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal">, id: SessionId): TurnSource {
  const read = new Map<number, TurnRecord | null>();
  const count = reader.head(id).runCount;
  return {
    id, count,
    turn(ordinal: number): TurnRecord | null {
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= count) return null;
      let found = read.get(ordinal);
      if (found === undefined) {
        const turn = reader.turnAt(id, ordinal, { inlineBytes: Infinity });
        found = turn === null ? null : turnRecord(turn);
        read.set(ordinal, found);
      }
      return found;
    },
    ordinalOf: runId => reader.runOrdinal?.(id, runId) ?? null,
  };
}

/**
 * The Turns of a conversation as the old whole shape tells them: for a caller that has the snapshot already (the web server, until it reads rows) and gives it to a
 * reader that reads Turns. Nothing is read, and no Turn is `legacyOrder` (the old shape does not say).
 */
export function snapshotTurns(snapshot: SessionSnapshot): TurnSource {
  const messages = new Map(snapshot.messages.map(message => [message.id as string, message]));
  return {
    id: snapshot.id, count: snapshot.runs.length,
    turn(ordinal: number): TurnRecord | null {
      const run = Number.isInteger(ordinal) && ordinal >= 0 ? snapshot.runs[ordinal] : undefined;
      if (run === undefined) return null;
      const user = messages.get(run.userMessageId) ?? { id: run.userMessageId, runId: run.id, role: "user" as const, text: run.input, seq: 0, status: run.status };
      return { ordinal, run, user, assistant: messages.get(run.assistantMessageId), legacyOrder: false };
    },
    ordinalOf: runId => { const found = snapshot.runs.findIndex(run => run.id === runId); return found < 0 ? null : found; },
  };
}

/** How many bytes of a message's text its start is taken from: more than the 32 characters a start is, so that leading blanks do not leave it short. */
const START_BYTES = 512;
/**
 * The start of every message of a conversation, the user's words and each reply, read from the first bytes of each message's text and not from the messages: what a program's log is checked
 * against when a report is made without the conversation's content (`withholdConversation` looks for the first 32 characters of each). A reply is the start of its segments joined while they
 * are short, as the whole reply's start would be.
 */
export function messageStarts(reader: Pick<ConversationReader, "head" | "turnAt" | "text">, id: SessionId): readonly string[] {
  const starts: string[] = [], count = reader.head(id).runCount;
  const head = (item: HeldItem): string => item.textOmitted === true ? restored({ ...item, text: [reader.text(item.runId, item.seq, { from: 0, to: START_BYTES }).text] }) : restored(item);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const turn = reader.turnAt(id, ordinal, { inlineBytes: START_BYTES });
    if (turn === null) continue;
    const items = [...turn.items].sort((left, right) => left.seq - right.seq);
    const user = items.find(item => item.itemId === "user");
    if (user !== undefined) starts.push(head(user));
    let reply = "";
    for (const item of items) { if (!item.itemId.startsWith("text:")) continue; reply += head(item); if (reply.trim().length >= START_BYTES / 4) break; }
    if (reply !== "") starts.push(reply);
  }
  return starts;
}
