import type { ConversationReader, HeldItem, TurnItems } from "../../../contracts/conversation.js";
import type { PublicMessage, PublicRun, RunId, SessionId } from "../../../contracts/session.js";
import { fromItems, restored } from "./store-conversion.js";
import { withoutThinking } from "./relay/narration.js";

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
  /** The Turn without its bodies (see `TurnOutline`); null when there is none. Read once; a Turn already read whole is not read again. */
  outline(ordinal: number): TurnOutline | null;
  /** The ordinal of a Run of this conversation by its identity; null when it has none (or the reader cannot say). */
  ordinalOf(runId: RunId): number | null;
}

/**
 * How long a text is, in UTF-16 units, as far as it is known without reading it: between `least` and `most`, and `exact()` reads it when only that settles a question (a text is read
 * for its length once, whatever it is). A text known whole has all three the same.
 */
export interface TextSize {
  readonly least: number; readonly most: number;
  /** Whether the text is longer than `chars` units, told from its start alone (a look at the first words, as long as that takes); false says only that the start did not tell, and `exact()` does. */
  exceeds?(chars: number): boolean;
  exact(): number;
}
/** The words a Turn said: how many bytes they are stored in, how long they are, and the text itself, read when it is asked for (the same text each time). */
export interface TurnWords { readonly bytes: number; readonly size: TextSize; text(): string }
/**
 * A Turn without its bodies (ADR-057 3.3, the relay's counting): its Run as the rows make it — the tools, the attachments, the error, the states — and, of the words it said, how big they
 * are and whether the reply has anything to read, never the words themselves. `run.input` and `run.thinking` are not to be used (a text too long for an outline is left out of them): the words
 * are `user` and `reply`. A packet counts every Turn it owes by its outline, and reads the words of those it carries.
 */
export interface TurnOutline {
  readonly ordinal: number;
  readonly run: PublicRun;
  readonly user: TurnWords;
  /** The reply, joined from its segments, inline `<think>` blocks and all (`withoutThinking` takes them out); `visible`: something is left of it once they are, besides whitespace. */
  readonly reply: TurnWords & { readonly visible: boolean };
  readonly legacyOrder: boolean;
}
/** The text of a string held already. */
export function plainWords(text: string): TurnWords { return { bytes: Buffer.byteLength(text, "utf8"), size: { least: text.length, most: text.length, exact: () => text.length }, text: () => text }; }
/** The reply of a text held already. */
export function plainReply(reply: string): TurnOutline["reply"] {
  const shown = withoutThinking(reply);
  return { bytes: Buffer.byteLength(reply, "utf8"), size: { least: shown.length, most: shown.length, exact: () => shown.length }, text: () => reply, visible: shown.trim() !== "" };
}
/** The outline of a Turn read whole. */
export function outlineOfRecord(record: TurnRecord): TurnOutline {
  return { ordinal: record.ordinal, run: record.run, user: plainWords(record.user.text), legacyOrder: record.legacyOrder, reply: plainReply(record.assistant?.text ?? "") };
}

/** Texts up to this many bytes come with an outline read; a longer one is left out of it and read when it is asked for. */
export const OUTLINE_INLINE_BYTES = 1024;
/** How much of a long reply is looked at to tell whether it has anything to read: its first words usually do, and the look widens only when they do not. */
const PROBES: readonly number[] = [512, 64 * 1024];
/** What an outline needs of the reader beyond a Turn: the text of an item, and an item whole. */
export interface OutlineReads { readonly text?: ConversationReader["text"]; readonly items?: ConversationReader["items"] }
/**
 * Whether the first words of a reply settle that there is something to read in it, whatever follows: a character that is not whitespace and does not open a thinking block (a block
 * opens at `<think`, and only what comes before it is sure to stay). False when they settle nothing (the look reaches the end of the first segment, or its limit, and the question is still
 * open): the whole reply is then read, once.
 */
function settledVisible(first: HeldItem, only: boolean, head: (limit: number) => string): boolean {
  const inline = first.textOmitted !== true;
  for (const limit of inline ? [Infinity] : PROBES) {
    const text = restored({ ...first, text: [head(limit)] }), whole = inline || first.textBytes <= limit, lead = text.search(/\S/u);
    // What follows the first character must be in view to say it opens no thinking block: the end of the whole reply is in view when this is its only segment and the look covers it.
    if (lead >= 0 && (lead + 6 <= text.length || (whole && only)) && !/^<think/iu.test(text.slice(lead, lead + 6))) return true;
    if (whole) return false;
  }
  return false;
}
/** The outline of a Turn read with its long texts left out (`OUTLINE_INLINE_BYTES`). Nothing it keeps holds a text: the words come back from the rows. */
export function outlineOfRows(turn: TurnItems, reads: Required<OutlineReads>): TurnOutline {
  const sorted = [...turn.items].sort((left, right) => left.seq - right.seq);
  // An item whose own JSON was too long to come with the read is read whole (a call over very many files): its tool is not told from the empty fields.
  const whole = sorted.map(item => item.bodyOmitted === true ? reads.items(item.runId, item.seq - 1, 1, { inlineBytes: Infinity }).items.find(read => read.seq === item.seq) ?? item : item);
  const { run } = fromItems({ row: turn.run, items: whole, contentRefs: [] });
  /** The item without its text, which is all the words need of it to be read again. */
  const stub = (item: HeldItem): HeldItem => ({ ...item, text: [] });
  const fetched = (item: HeldItem): string => restored({ ...item, text: [reads.text(item.runId, item.seq, { from: 0 }).text] });
  /** The first `bytes` bytes of the words of `items` (a reply's segments, in order), each read from its start as far as that goes; `whole`: that is all of them. */
  const startOf = (items: readonly HeldItem[]) => (bytes: number): { readonly text: string; readonly whole: boolean } => {
    let text = "", left = bytes;
    for (const item of items) {
      if (item.textOmitted !== true) { text += restored(item); left -= item.textBytes; continue; }
      if (left <= 0) return { text, whole: false };
      const whole = item.textBytes <= left;
      text += restored({ ...item, text: [reads.text(item.runId, item.seq, whole ? { from: 0 } : { from: 0, to: left }).text] });
      left -= item.textBytes;
      if (!whole) return { text, whole: false };
    }
    return { text, whole: true };
  };
  const user = sorted.find(item => item.itemId === "user"), segments = sorted.filter(item => item.itemId.startsWith("text:"));
  const userWords: TurnWords = user === undefined ? plainWords("") : (() => {
    const kept = stub(user), chars = user.textOmitted === true ? undefined : restored(user).length, bytes = user.textBytes;
    return { bytes, size: chars !== undefined ? { least: chars, most: chars, exact: () => chars } : sizeOf(bytes, () => fetched(kept).length, Math.ceil(bytes / 3), exceedsFrom(startOf([user]), false)), text: () => fetched(kept) };
  })();
  const kept = segments.map(stub), bytes = segments.reduce((sum, item) => sum + item.textBytes, 0);
  const joined = (): string => kept.map(fetched).join("");
  let visible: boolean, size: TextSize;
  if (segments.every(item => item.textOmitted !== true)) {
    // The whole reply came with the read.
    const reply = segments.map(restored).join(""), shown = withoutThinking(reply);
    visible = shown.trim() !== ""; size = { least: shown.length, most: shown.length, exact: () => shown.length };
  } else if (settledVisible(segments[0]!, segments.length === 1, limit => segments[0]!.textOmitted === true ? reads.text(segments[0]!.runId, segments[0]!.seq, { from: 0, to: limit }).text : segments[0]!.text.join(""))) {
    // Something to read, whatever follows; how long it is once its thinking is out is not known until it is read.
    visible = true; size = sizeOf(bytes, () => withoutThinking(joined()).length, 0, exceedsFrom(startOf(segments), true));
  } else {
    const reply = joined(), shown = withoutThinking(reply);
    visible = shown.trim() !== ""; size = { least: shown.length, most: shown.length, exact: () => shown.length };
  }
  return { ordinal: turn.run.ordinal, run, user: userWords, legacyOrder: turn.run.legacyOrder, reply: { bytes, size, text: joined, visible } };
}
/** The size of a text of `bytes` UTF-8 bytes that is not held: a unit of UTF-16 is one to three bytes (`least` is lower still for a text that may have thinking taken out of it). */
function sizeOf(bytes: number, exact: () => number, least: number, exceeds: (chars: number) => boolean): TextSize {
  let known: number | undefined;
  return { least, most: bytes, exceeds, exact: () => known ??= exact() };
}
/**
 * Whether a text is longer than `chars` units, told from its start (`start(bytes)` reads that many bytes of it, and says whether that was all of it). A unit is one to three bytes, so a look of
 * `chars` bytes settles plain text and three times as many settle the rest. `thinking`: blocks may be taken out of the text, so only the words before the first `<think` stay whatever follows it.
 */
function exceedsFrom(start: (bytes: number) => { readonly text: string; readonly whole: boolean }, thinking: boolean): (chars: number) => boolean {
  return chars => {
    for (const factor of [1, 3]) {
      const { text, whole } = start(Math.ceil(chars + 8) * factor);
      if (whole) return (thinking ? withoutThinking(text) : text).length > chars;
      // A block opening in the last five units of the look would not show in it.
      const found = thinking ? text.search(/<think/iu) : -1, sure = found >= 0 ? found : text.length - (thinking ? 5 : 0);
      if (sure > chars) return true;
      if (found >= 0) return false;
    }
    return false;
  };
}

/** The Turn a Turn's rows make (items whole: nothing is left out for its size). */
export function turnRecord(turn: TurnItems): TurnRecord {
  const { run, messages } = fromItems({ row: turn.run, items: turn.items, contentRefs: [] });
  return { ordinal: turn.run.ordinal, run, user: messages[0]!, assistant: messages[1], legacyOrder: turn.run.legacyOrder };
}

/** The Turns of a conversation kept as rows: read from `reader` one at a time, each once. */
export function turnSource(reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal"> & OutlineReads, id: SessionId): TurnSource {
  const read = new Map<number, TurnRecord | null>(), outlines = new Map<number, TurnOutline | null>();
  const count = reader.head(id).runCount;
  const valid = (ordinal: number): boolean => Number.isInteger(ordinal) && ordinal >= 0 && ordinal < count;
  return {
    id, count,
    turn(ordinal: number): TurnRecord | null {
      if (!valid(ordinal)) return null;
      let found = read.get(ordinal);
      if (found === undefined) {
        const turn = reader.turnAt(id, ordinal, { inlineBytes: Infinity });
        found = turn === null ? null : turnRecord(turn);
        read.set(ordinal, found);
      }
      return found;
    },
    outline(ordinal: number): TurnOutline | null {
      if (!valid(ordinal)) return null;
      let found = outlines.get(ordinal);
      if (found === undefined) {
        const whole = read.get(ordinal);
        if (whole !== undefined) found = whole === null ? null : outlineOfRecord(whole);
        else if (reader.text === undefined || reader.items === undefined) { const record = this.turn(ordinal); found = record === null ? null : outlineOfRecord(record); }
        else { const turn = reader.turnAt(id, ordinal, { inlineBytes: OUTLINE_INLINE_BYTES }); found = turn === null ? null : outlineOfRows(turn, { text: reader.text.bind(reader), items: reader.items.bind(reader) }); }
        outlines.set(ordinal, found);
      }
      return found;
    },
    ordinalOf: runId => reader.runOrdinal?.(id, runId) ?? null,
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
