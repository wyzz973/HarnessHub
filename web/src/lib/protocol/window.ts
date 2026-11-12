import type { DeferredWork, TextRange } from "../../../../src/contracts/conversation.js";
import type { ReadItem } from "../../../../src/contracts/protocol-read.js";
import type { SessionHeadView } from "../../../../src/contracts/web.js";
import type { ClientCommitFrame, ClientRun, ClientRunItemsPage, ClientSessionView, ClientTurn, ClientWindow } from "./wire.js";

/*
 * The part of a conversation the page holds (ADR-057 3.4): the head, and a run of its Turns that begins at the newest and reaches back as far as the reader has gone.
 * It is a value: every function here takes a state and gives the next, and none of them changes the one it was given. What it holds follows the window and not the
 * conversation: opening a conversation of two thousand Turns holds ten, and the older ones come one page at a time (`prependOlder`) when the reader goes up.
 *
 * HOW IT FOLLOWS THE STREAM. A commit is one frame, applied when it is the next: its version is the held version plus one and its watermark is above the held one.
 * A frame at or below the held watermark is one the page already has (ignored). A frame that is not the next (a commit missing before it, or arriving out of
 * order), a text that does not begin where the held text ends, a Turn or an item that should be held and is not: the page cannot say what it would be, and says so —
 * `resync` — and the caller asks for the conversation again (`replaceWithSnapshot`). It never guesses.
 *
 * HOW IT HOLDS A TEXT. An item's text is held as a prefix of what the item has, with the byte count of what is held. A text that is whole has no mark; one the
 * Gateway left out for its size (`bodyOmitted`, with `textBytes`) is held as far as it has been fetched (`fillText`), and a text that grows on the stream is followed
 * only while it is held whole: a chunk that begins at the end of what the page knows of an omitted text only makes the total larger. `incomplete` lists what the
 * page still has to fetch.
 */

/** An item and the bytes of its text that are held (the text of a user message, a reply, a thought or a notice is in `text`). */
export interface WindowItem { readonly item: ReadItem; readonly held: number }
export interface WindowTurn { readonly run: ClientRun; readonly items: readonly WindowItem[]; readonly deferred?: DeferredWork }
export interface WindowState {
  readonly head: SessionHeadView;
  /** Oldest first; the ordinals follow one another. */
  readonly turns: readonly WindowTurn[];
  /** The cursor of the page before `turns[0]`; null when `turns[0]` is the first Turn. */
  readonly older: string | null;
}
/** What a step gave: the next state; the same state, when the step was not about it (a frame it already has, a page it already holds); or that the page must ask for the conversation again. */
export type Applied =
  | { readonly kind: "applied"; readonly state: WindowState }
  | { readonly kind: "ignored"; readonly state: WindowState }
  | { readonly kind: "resync"; readonly reason: string };
const resync = (reason: string): Applied => ({ kind: "resync", reason });

// ---------------------------------------------------------------------------------------------------------------------
// Small readings
// ---------------------------------------------------------------------------------------------------------------------

/** The bytes a text is in UTF-8 (a lone surrogate counts three, as the Gateway's column keeps it as U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) { bytes += 4; at++; }
    else bytes += 3;
  }
  return bytes;
}
export const textOf = (item: ReadItem): string | undefined => (item as { readonly text?: unknown }).text as string | undefined;
const hasText = (item: ReadItem): boolean => item.type === "user_message" || item.type === "assistant_message" || item.type === "reasoning" || item.type === "notice";
/** The item with its text replaced (and the marks of an omission as given). */
function withText(item: ReadItem, text: string | undefined, marks: { readonly bodyOmitted: boolean; readonly textBytes: number | undefined }): ReadItem {
  const { text: _text, bodyOmitted: _omitted, textBytes: _bytes, ...rest } = item as ReadItem & { text?: string; bodyOmitted?: true; textBytes?: number };
  // A thought and a notice always have a `text` (empty while none is held); a message has it only when something is held.
  const keep = text !== undefined && (text !== "" || item.type === "reasoning" || item.type === "notice");
  return { ...rest, ...(keep ? { text } : {}), ...(marks.bodyOmitted ? { bodyOmitted: true as const } : {}), ...(marks.textBytes === undefined ? {} : { textBytes: marks.textBytes }) } as ReadItem;
}
/** What an item's text comes to when whole: its size as the Gateway told it, else what is held. */
export const totalOf = (entry: WindowItem): number => Math.max(entry.item.textBytes ?? 0, entry.held);
const heldItem = (item: ReadItem): WindowItem => ({ item, held: utf8Length(textOf(item) ?? "") });
/** Where an item of place `seq` is, or would be, in a list in the order of their places. */
function placeOf(items: readonly WindowItem[], seq: number): number {
  let low = 0, high = items.length;
  while (low < high) { const middle = (low + high) >> 1; if (items[middle]!.item.seq < seq) low = middle + 1; else high = middle; }
  return low;
}
function turnOf(turn: ClientTurn): WindowTurn {
  const held = turn.items.map(heldItem);
  // The Gateway sends them in the order of their places; a list that is not is put in order (a stable sort leaves an ordered one as it is).
  const ordered = held.every((entry, index) => index === 0 || held[index - 1]!.item.seq <= entry.item.seq) ? held : [...held].sort((left, right) => left.item.seq - right.item.seq);
  return { run: turn.run, items: ordered, ...(turn.deferred === undefined ? {} : { deferred: turn.deferred }) };
}
const finished = (run: ClientRun): boolean => run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "unknown";

// ---------------------------------------------------------------------------------------------------------------------
// Opening, reopening, going back
// ---------------------------------------------------------------------------------------------------------------------

/** The state of a conversation just read: its head and its window. */
export function openWindow(view: ClientSessionView): WindowState { return { head: view.head, turns: view.window.turns.map(turnOf), older: view.window.older }; }

/**
 * The conversation read again (the page reconnected, or a frame could not be followed). A read older than what the page holds is not used. By default the Turns the reader had
 * gone back to stay when they are finished and join the new window (finished Turns do not change), so that a reconnection does not take the reader back to the bottom; with
 * `keepOlder: false` the state is the read alone.
 */
export function replaceWithSnapshot(state: WindowState | null, view: ClientSessionView, options: { readonly keepOlder?: boolean } = {}): WindowState {
  const next = openWindow(view);
  if (state === null || state.head.id !== next.head.id) return next;
  if (next.head.lastSeq < state.head.lastSeq || (next.head.lastSeq === state.head.lastSeq && next.head.version < state.head.version)) return state;
  // Nothing was committed meanwhile (the page lost its connection and found the conversation as it was): the Turns it holds are right and it may hold more than the reading has
  // (pages the reader went back to, texts it fetched). What the service knows beyond the commits (requests that wait, a process it keeps) is the reading's.
  if (next.head.lastSeq === state.head.lastSeq && next.head.version === state.head.version && options.keepOlder !== false) return { ...state, head: next.head };
  const first = next.turns[0]?.run.ordinal;
  if (options.keepOlder === false || first === undefined) return next;
  // The Turns before the new window that the reader had loaded stay when they are all over and run on into it without a gap.
  const kept = state.turns.filter(turn => turn.run.ordinal < first);
  if (kept.length === 0 || !kept.every(turn => finished(turn.run)) || kept.at(-1)!.run.ordinal !== first - 1) return next;
  return { ...next, turns: [...kept, ...next.turns], older: state.older };
}

/** A page of Turns before the held ones joins them. A page that is not the one before (it holds nothing older, or it does not reach the Turns held) is not used; the Turns of it the page already holds are left out. */
export function prependOlder(state: WindowState, page: ClientWindow): WindowState {
  const first = state.turns[0]?.run.ordinal;
  if (first === undefined) return state;
  const fresh = page.turns.filter(turn => turn.run.ordinal < first);
  if (fresh.length === 0 || fresh.at(-1)!.run.ordinal !== first - 1) return state;
  for (let at = 1; at < fresh.length; at++) if (fresh[at]!.run.ordinal !== fresh[at - 1]!.run.ordinal + 1) return state;
  return { ...state, turns: [...fresh.map(turnOf), ...state.turns], older: page.older };
}

/** The middle of a long stretch of work, read by place, joins the Turn it was left out of. */
export function fillDeferred(state: WindowState, ordinal: number, page: ClientRunItemsPage): WindowState {
  const index = state.turns.findIndex(turn => turn.run.ordinal === ordinal), turn = state.turns[index];
  const gap = turn?.deferred;
  if (turn === undefined || gap === undefined) return state;
  const items = [...turn.items];
  let added = 0;
  for (const item of page.items) {
    if (item.seq < gap.fromSeq || item.seq > gap.toSeq) continue;
    const at = placeOf(items, item.seq);
    if (items[at]?.item.seq === item.seq) continue;
    items.splice(at, 0, heldItem(item)); added++;
  }
  if (added === 0) return state;
  // What is still missing of the stretch: from its first missing place to its last, as many as are not held.
  const have = new Set(items.map(entry => entry.item.seq));
  let first = -1, last = -1, missing = 0;
  for (let seq = gap.fromSeq; seq <= gap.toSeq; seq++) if (!have.has(seq)) { if (first < 0) first = seq; last = seq; missing++; }
  const { deferred: _filled, ...rest } = turn;
  const next: WindowTurn = missing === 0 ? { ...rest, items } : { ...rest, items, deferred: { fromSeq: first, toSeq: last, count: missing } };
  return { ...state, turns: state.turns.map((entry, at) => at === index ? next : entry) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Following the stream
// ---------------------------------------------------------------------------------------------------------------------

/** One item of a frame joins its Turn: a new one in its place, a known one replacing the fields it had and keeping the text it holds. */
function upsert(turn: WindowTurn, incoming: ReadItem): WindowTurn {
  const items = [...turn.items], at = placeOf(items, incoming.seq), prior = items[at]?.item.seq === incoming.seq ? items[at] : undefined;
  if (prior === undefined) { items.splice(at, 0, heldItem(incoming)); return { ...turn, items }; }
  const own = textOf(incoming);
  if (own !== undefined && own !== "") { items[at] = heldItem(incoming); return { ...turn, items }; }
  // The words come in the frames' texts; an item sent again says nothing of them. What is left out of an item whose text is not whole stays left out.
  const incomplete = totalOf(prior) > prior.held, carried = textOf(prior.item);
  const total = incomplete ? Math.max(totalOf(prior), incoming.textBytes ?? 0) : incoming.textBytes;
  const marks = { bodyOmitted: incoming.bodyOmitted === true || incomplete, textBytes: total };
  items[at] = { item: hasText(incoming) ? withText(incoming, carried, marks) : incoming, held: prior.held };
  return { ...turn, items };
}
/**
 * A chunk of text for an item. It is taken when it goes on from the text held (`from` is the end of it: the text goes on, and if the item has more than is held, as when a
 * frame left out a later chunk of it, the item stays incomplete), or when it begins where the text the page knows of ends and part of it was never held (the text grows and
 * is not held). `omittedBytes` is a chunk that the frame did not carry. Anything else is a text the page cannot place: null.
 */
function append(turn: WindowTurn, add: { readonly itemSeq: number; readonly from: number; readonly text: string; readonly omittedBytes?: number | undefined }): WindowTurn | null {
  const at = placeOf(turn.items, add.itemSeq), entry = turn.items[at];
  if (entry === undefined || entry.item.seq !== add.itemSeq || !hasText(entry.item)) return null;
  const known = totalOf(entry), items = [...turn.items], text = textOf(entry.item);
  if (add.omittedBytes !== undefined) {
    if (add.from !== known) return null;
    items[at] = { item: withText(entry.item, text, { bodyOmitted: true, textBytes: add.from + add.omittedBytes }), held: entry.held };
  } else if (add.from === entry.held) {
    const held = entry.held + utf8Length(add.text), total = Math.max(known, held), whole = held >= total;
    items[at] = { item: withText(entry.item, (text ?? "") + add.text, { bodyOmitted: !whole || entry.item.bodyOmitted === true, textBytes: whole ? entry.item.textBytes === undefined ? undefined : held : total }), held };
  } else if (add.from === known && known > entry.held) {
    items[at] = { item: withText(entry.item, text, { bodyOmitted: true, textBytes: known + utf8Length(add.text) }), held: entry.held };
  } else return null;
  return { ...turn, items };
}

/** One commit's frame. See the head of this file for when it is applied, ignored, or cannot be followed. */
export function applyCommit(state: WindowState, frame: ClientCommitFrame): Applied {
  if (frame.sessionId !== state.head.id) return resync("the frame is of another conversation");
  if (frame.lastSeq <= state.head.lastSeq) return { kind: "ignored", state };
  if (frame.version !== state.head.version + 1) return resync("a commit is missing: the frame is version " + frame.version + " and the page holds version " + state.head.version);
  const turns = [...state.turns], at = (runId: string): number => turns.findIndex(turn => turn.run.id === runId);
  for (const run of frame.runs ?? []) {
    const index = at(run.id);
    if (index >= 0) {
      if (turns[index]!.run.ordinal !== run.ordinal) return resync("a Run changed its place in the conversation");
      turns[index] = { ...turns[index]!, run };
      continue;
    }
    const last = turns.at(-1)?.run.ordinal ?? -1;
    if (run.ordinal === last + 1) turns.push({ run, items: [] });
    else if (run.ordinal > last + 1) return resync("a Turn is missing before the Turn that began");
    else if (run.ordinal >= (turns[0]?.run.ordinal ?? 0)) return resync("a Run of the window is not the one the page holds at its place");
  }
  for (const entry of frame.items ?? []) {
    const index = at(entry.runId);
    if (index >= 0) turns[index] = upsert(turns[index]!, entry.item);
  }
  for (const add of frame.texts ?? []) {
    const index = at(add.runId);
    if (index < 0) continue;
    const next = append(turns[index]!, add);
    if (next === null) return resync("a text begins at byte " + add.from + " of an item whose text the page does not hold up to there");
    turns[index] = next;
  }
  const head: SessionHeadView = frame.head ?? { ...state.head, version: frame.version, lastSeq: frame.lastSeq };
  return { kind: "applied", state: { head, turns, older: state.older } };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the page fetches
// ---------------------------------------------------------------------------------------------------------------------

/** Something the page holds in part: the rest of an item's text from byte `from` (of `total`), or the item itself (its fields were left out for their size). */
export type Incomplete =
  | { readonly kind: "text"; readonly runId: string; readonly ordinal: number; readonly seq: number; readonly from: number; readonly total: number }
  | { readonly kind: "item"; readonly runId: string; readonly ordinal: number; readonly seq: number };
export function incomplete(state: WindowState): readonly Incomplete[] {
  const found: Incomplete[] = [];
  for (const turn of state.turns) {
    for (const entry of turn.items) {
      if (totalOf(entry) > entry.held) found.push({ kind: "text", runId: turn.run.id, ordinal: turn.run.ordinal, seq: entry.item.seq, from: entry.held, total: totalOf(entry) });
      else if (entry.item.bodyOmitted === true) found.push({ kind: "item", runId: turn.run.id, ordinal: turn.run.ordinal, seq: entry.item.seq });
    }
  }
  return found;
}

/** A byte range of an item's text the page asked for. It is used when it goes on from the held text; one that does not (the page asked twice, or the item has gone) leaves the state as it was. */
export function fillText(state: WindowState, at: { readonly runId: string; readonly seq: number }, range: TextRange): WindowState {
  const index = state.turns.findIndex(turn => turn.run.id === at.runId), turn = state.turns[index];
  if (turn === undefined) return state;
  const place = placeOf(turn.items, at.seq), entry = turn.items[place];
  if (entry === undefined || entry.item.seq !== at.seq || !hasText(entry.item) || range.from !== entry.held || range.to < range.from) return state;
  const held = entry.held + utf8Length(range.text), total = Math.max(range.total, totalOf(entry)), whole = held >= total;
  // Whole again: the fields of a message and of a thought are small and were never what was left out, so the marks go; a notice may have had more left out than its words.
  const clear = whole && entry.item.type !== "notice";
  const item = withText(entry.item, (textOf(entry.item) ?? "") + range.text, clear ? { bodyOmitted: false, textBytes: undefined } : { bodyOmitted: true, textBytes: whole ? undefined : total });
  const items = [...turn.items];
  items[place] = { item, held };
  return { ...state, turns: state.turns.map((current, i) => i === index ? { ...turn, items } : current) };
}
/** An item read whole (its fields and its text) replaces the one the page holds of that place. */
export function fillItem(state: WindowState, runId: string, item: ReadItem): WindowState {
  const index = state.turns.findIndex(turn => turn.run.id === runId), turn = state.turns[index];
  if (turn === undefined) return state;
  const place = placeOf(turn.items, item.seq);
  if (turn.items[place]?.item.seq !== item.seq) return state;
  const items = [...turn.items];
  items[place] = heldItem(item);
  return { ...state, turns: state.turns.map((current, i) => i === index ? { ...turn, items } : current) };
}

/** The state as the Gateway's read of it would be: the shape of `ClientSessionView`, for comparing what a stream built with what a read gives. */
export function viewOf(state: WindowState): ClientSessionView {
  return { head: state.head, window: { turns: state.turns.map((turn): ClientTurn => ({ run: turn.run, items: turn.items.map(entry => entry.item), ...(turn.deferred === undefined ? {} : { deferred: turn.deferred }) })), older: state.older } };
}
