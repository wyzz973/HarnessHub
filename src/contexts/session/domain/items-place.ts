import { createHash } from "node:crypto";
import type { ContentRef } from "../../../contracts/content.js";
import type { ContentRefRow, HeldItem, ItemFields, ItemRow, ItemWrite, Mutation, NativeFacts, RunRow, TextAppend } from "../../../contracts/conversation.js";
import type { ControlEvent, NativeToolDetail } from "../../../contracts/control.js";
import type { ApprovalItem, ApprovalRole, ItemStatus, ItemType, PlanStep } from "../../../contracts/protocol.js";
import { STREAM_WINDOW_BYTES, type PublicTool, type RunStatus } from "../../../contracts/session.js";
import { classifyTool, detailHead, itemStatus, runItemStatus } from "./protocol/index.js";
import { derive, sound } from "./store-conversion.js";

/*
 * The placement of items (ADR-057 3.2): what a Turn in progress does with each thing its Harness reports, as a pure reduction
 * `place(turn, input) → { turn, changes, store }`. The Turn's items are written in the order the Harness reported them (the old shape kept
 * each kind in a list of its own and lost the order); each is a row of `items`, and the words of the reply and the reasoning are chunks
 * of `item_text`. Nothing here reads a clock, a store or a content store: the time comes with each input, the notice fingerprints
 * come from the caller, and a detail that has to go to the content store is told in `store` (the Runtime stores it and tells `place`
 * its reference in a `detail` input). `changes` is the part of a `Mutation` this reduction writes: items, text, content references and
 * notice fingerprints; the Run's own row and the events are the Runtime's.
 *
 * WHAT COMES IN (`PlaceInput`)
 *   event     a native event of the Driver (`ControlEvent`, every one of its twelve types) with the time it arrived. A `content` output
 *             comes with `stored`, the reference the content store gave its bytes.
 *   flush     the window of text is committed now (the Runtime's timer, every 100 ms).
 *   detail    the content store gave a tool's detail this reference.
 *   decided   the user answered an approval or a question.
 *   expired   the Turn's wait budget ran out: what waits is closed, and said to have timed out.
 *   notice    a notice of the Hub itself (not a Harness's, so it is not kept out as a repeat).
 *   settled   the Turn ended (or a restart found it so): see CLOSING.
 *
 * ORDER AND IDENTITY. An item takes its `seq` when it is first seen, and keeps it. The same id reported again is the same item: it is
 * updated when something changed and not touched when nothing did (the Turn is the same object then). `user` is the Turn's first item
 * (the Runtime puts it there when the input is accepted); the rest are `think:<n>` and `text:<n>` (the segments), `tool:<id>`,
 * `activity:<id>`, `permission:<id>`, `plan`, `notice:<n>` and `output:<n>`: the ids the Harness gave are kept, the others count from 1.
 *
 * SEGMENTS AND WINDOWS (3.2). Text and reasoning come as windows (a flush every 100 ms or 16 KiB, ADR-047); a window is one chunk and
 * never crosses an item. A segment opens at the first window with something but whitespace in it; the windows of the same kind that
 * follow join it. It closes when the kind changes, when an item that takes a place on the timeline arrives (a call, an activity, an
 * approval, a question, a notice, an artifact), and when the Turn ends. A plan, a usage, a diagnostic and the update of an item already
 * there do not cut it. Whitespace alone waits for the segment it will begin; it is written as it is when the kind changes and when
 * the Turn ends, never dropped. A chunk ends on a code point: a high surrogate at the end of a window goes to the start of the next.
 *
 * WHAT IS KEPT. A tool keeps what its Harness reported (`NativeFacts`: title, status word, kind, name, exit code), the same facts the
 * storage conversion keeps, and the fields of its protocol type are worked out from them by the shared normalization — here with the
 * head of the call's detail in hand, so a command and a path that only the detail names are told in full. Everything is kept whole:
 * there is no limit on a count or a length, and nothing is refused.
 *
 * FOREIGN DATA IS NORMALIZED, NEVER REFUSED. A label, an id or a number from the Harness is made storable before it is kept, and each
 * change is told in `native.clipped` as `field:why`: a NUL removed (`nul`), half a surrogate pair replaced by U+FFFD (`surrogate`), an empty
 * label given its placeholder (`empty`), a number that is not a safe integer left out (`range`), a status word the protocol does not know read as
 * `unknown` (`unknown_word`). Text keeps its lone surrogates exactly (`native.surrogates`, as the storage conversion does), and loses
 * only its NUL. Nothing looks at a size.
 *
 * APPROVALS AND QUESTIONS. They open as a `waiting` item, with the options of an approval put into roles (allow once, allow for the
 * conversation, allow always, deny, other). The user's answer changes the same item: `completed` or `declined` with the decision (the role, who, when), a
 * question with its `answer`. An answer typed into a secret question is not kept anywhere: not in the item, not in what comes out, not in the Turn.
 *
 * CLOSING (`settleItems`, the same function for a Turn that ends and for the restart that finds one that did): what is still open when the Turn is
 * over is told as what it was left as, never as done.
 *
 *                              the Turn ended as →   completed   failed      cancelled   unknown
 *     a segment still open (reply, reasoning)          completed   failed      cancelled   unknown
 *     an action or activity pending or running         unknown     unknown     cancelled   unknown
 *     an approval or a question waiting                cancelled   cancelled   cancelled   cancelled
 *     the plan                                         completed   completed   completed   completed
 *     an item that had an outcome                      as it was   as it was   as it was   as it was
 *
 * Items are closed before the Run is given its end (the store refuses to change an item of a finished Run). The `final` phase is not stored: it is the
 * reader's, by `finalItemSeq`.
 *
 * THE RUNTIME'S PART. It opens the Turn (`openTurn`, from the rows of the Run: the `user` item when the input was accepted, or what a restart found), gives
 * every native event to `place` with the time it arrived, and commits `changes` with the events it logs (`env.eventIndex` is the place of the one that
 * made the new items). While `turn.window` is not null a `flush` is owed within 100 ms (the timer is the Runtime's); a `flush` before each event of
 * another kind keeps what is committed in the order it arrived. A `detail` to store is handed over in `store`, once, when its call has ended (and for every
 * call still unsaved when the Turn ends); the content store's reference comes back as a `detail` input. An approval or a question is told by the id its Harness gave
 * it (not the Hub's own `permission-…` id), in `decided`, `expired` and the Harness's own `permission` withdrawal. The Run's row — its usage, its timing, its
 * end — and the events are not placed here: usage and diagnostics change no item. An item's `createdSeq` stays null in what is held and in every write: the store
 * writes it from `createdByEvent` when the item is inserted, and an update must leave it as it is. Not done here: `forItem` of an approval (the Driver does not say which
 * call it is about).
 */

/** How a Turn ended; the words of a Run's last states. */
export type TerminalStatus = Extract<RunStatus, "completed" | "failed" | "cancelled" | "unknown">;

// ---------------------------------------------------------------------------------------------------------------------------------
// The Turn in progress
// ---------------------------------------------------------------------------------------------------------------------------------

/** A paged persistent array: a change copies a page and the list of pages, so that a Turn of thousands of items is not copied whole for each event. */
interface Vec<T> { readonly length: number; readonly pages: readonly (readonly T[])[] }
const PAGE_BITS = 6, PAGE_SIZE = 1 << PAGE_BITS, PAGE_MASK = PAGE_SIZE - 1;
function vecOf<T>(values: readonly T[]): Vec<T> {
  const pages: (readonly T[])[] = [];
  for (let at = 0; at < values.length; at += PAGE_SIZE) pages.push(values.slice(at, at + PAGE_SIZE));
  return { length: values.length, pages };
}
function vecAt<T>(vec: Vec<T>, at: number): T | undefined { return vec.pages[at >> PAGE_BITS]?.[at & PAGE_MASK]; }
function vecSet<T>(vec: Vec<T>, at: number, value: T): Vec<T> {
  const pages = vec.pages.slice(), page = [...pages[at >> PAGE_BITS]!];
  page[at & PAGE_MASK] = value; pages[at >> PAGE_BITS] = page;
  return { length: vec.length, pages };
}
function vecPush<T>(vec: Vec<T>, value: T): Vec<T> {
  const pages = vec.pages.slice();
  if ((vec.length & PAGE_MASK) === 0) pages.push([value]); else pages[pages.length - 1] = [...pages[pages.length - 1]!, value];
  return { length: vec.length + 1, pages };
}
function vecList<T>(vec: Vec<T>): T[] { return vec.pages.flat(); }

/** What a waiting approval or question needs from its request when the user answers (the Harness's own option ids and words; the item has the roles). */
interface Request { readonly kind: "approval" | "question"; readonly options: readonly { readonly id: string; readonly name: string }[]; readonly secret: boolean }
/** An item and what is kept beside it while the Turn goes on: the merged native detail of a call, whether it is yet to be stored, the request that waits. */
interface Entry { readonly item: HeldItem; readonly detail?: NativeToolDetail; readonly dirty?: true; readonly request?: Request }
type Kind = "text" | "thinking";
/** Text that arrived and is not committed yet. */
interface Window { readonly kind: Kind; readonly text: string; readonly bytes: number; readonly at: number; readonly nul: boolean }
/** Whitespace written by no segment yet: it begins the next segment of its kind, or is written as it is. */
interface Hold { readonly kind: Kind; readonly text: string; readonly at: number; readonly nul: boolean }
/** The open segment: its item, how many chunks it has, how many UTF-16 units, and the high surrogate at the end of its last window (waiting for its other half). */
interface Segment { readonly kind: Kind; readonly itemId: string; readonly units: number; readonly carry: string }

/**
 * A Turn in progress: the Run's row, the next `seq`, every item so far with what is kept beside it, the counts that name the segments, the
 * notices shown, and the state of the text (window, held whitespace, open segment). It is a value: `place` returns the next one and leaves
 * this one as it was (the index of ids is shared between the versions of a Turn and trusted only where the Turn's own items agree).
 */
export interface ActiveTurn {
  readonly run: RunRow;
  readonly nextSeq: number;
  readonly entries: Vec<Entry>;
  readonly ids: Map<string, number>;
  readonly counts: { readonly text: number; readonly think: number; readonly notice: number; readonly output: number };
  readonly prints: ReadonlySet<string>;
  readonly window: Window | null;
  readonly hold: Hold | null;
  readonly segment: Segment | null;
  /** How the Turn ended once it has: nothing is placed after that. */
  readonly settled: TerminalStatus | null;
}

/** The Turn of a Run, from the items it holds (at least its `user` item when the Runtime opens it; the items a restart finds when it recovers one). */
export function openTurn(run: RunRow, items: readonly HeldItem[] = []): ActiveTurn {
  const ids = new Map<string, number>(), counts = { text: 0, think: 0, notice: 0, output: 0 };
  items.forEach((item, position) => {
    ids.set(item.itemId, position);
    const counted = /^(text|think|notice|output):(\d+)$/u.exec(item.itemId);
    if (counted !== null) { const key = counted[1] as keyof typeof counts; counts[key] = Math.max(counts[key], Number(counted[2])); }
  });
  return { run, nextSeq: items.reduce((top, item) => Math.max(top, item.seq), 0) + 1, entries: vecOf(items.map((item): Entry => ({ item }))), ids, counts, prints: new Set(), window: null, hold: null, segment: null, settled: null };
}
/** The items of the Turn so far, in the order of their `seq`. */
export function itemsOf(turn: ActiveTurn): readonly HeldItem[] { return vecList(turn.entries).map(entry => entry.item); }

// ---------------------------------------------------------------------------------------------------------------------------------
// What comes in, what comes out
// ---------------------------------------------------------------------------------------------------------------------------------

export type PlaceInput =
  | { readonly kind: "event"; readonly event: ControlEvent; readonly at: number; readonly stored?: ContentRef }
  | { readonly kind: "flush"; readonly at: number }
  | { readonly kind: "detail"; readonly toolId: string; readonly ref: ContentRef; readonly at: number }
  /** The content store could not keep a call's detail: the call's item says so (`DETAIL_NOT_SAVED`), and does until a detail is kept. */
  | { readonly kind: "detail_lost"; readonly toolId: string; readonly at: number }
  | { readonly kind: "decided"; readonly id: string; readonly option: string; readonly input?: string; readonly by?: "user" | "policy"; readonly at: number }
  | { readonly kind: "expired"; readonly at: number }
  | { readonly kind: "notice"; readonly severity: "info" | "warning"; readonly title: string; readonly detail?: string; readonly code?: string; readonly at: number }
  | { readonly kind: "settled"; readonly status: TerminalStatus; readonly at: number };
export interface PlaceEnv {
  /** Whether a Harness notice with this fingerprint was already shown in the conversation (`notice_prints`); one that was is not shown again. */
  readonly noticeShown?: (print: string) => boolean;
  /** The place, among the events of the commit, of the event the input is logged as: what the new items are told to have been created by. 0 when absent. */
  readonly eventIndex?: number;
}
/** The part of a `Mutation` the placement writes. */
export type PlaceChanges = Pick<Mutation, "items" | "text" | "contentRefs" | "noticePrints">;
/** A tool's detail to hand to the content store: the Runtime stores it and answers with a `detail` input. */
export interface StoreRequest { readonly toolId: string; readonly detail: NativeToolDetail }
export interface Placed { readonly turn: ActiveTurn; readonly changes: PlaceChanges; readonly store: readonly StoreRequest[] }

/** The writes of one call: an item written twice (opened, then closed) is one write; text and references are in the order they were made. */
class Writes {
  private readonly rows = new Map<number, ItemWrite>();
  readonly text: TextAppend[] = [];
  readonly refs: ContentRefRow[] = [];
  readonly prints: string[] = [];
  readonly store: StoreRequest[] = [];
  constructor(readonly created: number) {}
  put(row: ItemRow, fresh: boolean): void {
    const prior = this.rows.get(row.seq);
    this.rows.set(row.seq, fresh || prior?.op === "insert" ? { op: "insert", row, createdByEvent: prior?.createdByEvent ?? this.created } : { op: "update", row });
  }
  changes(): PlaceChanges {
    const items = [...this.rows.values()];
    return { ...(items.length === 0 ? {} : { items }), ...(this.text.length === 0 ? {} : { text: this.text }), ...(this.refs.length === 0 ? {} : { contentRefs: this.refs }),
      ...(this.prints.length === 0 ? {} : { noticePrints: this.prints }) };
  }
}
type Draft = { -readonly [K in keyof ActiveTurn]: ActiveTurn[K] };

// ---------------------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------------------

const str = (value: unknown): string => typeof value === "string" ? value : value === undefined || value === null ? "" : typeof value === "symbol" ? "" : String(value);
/** An object, whatever else it is a list or a number or null: events are typed, and a Driver's mistake is still no reason to throw. */
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
function note(clipped: string[], entry: string): void { if (!clipped.includes(entry)) clipped.push(entry); }
/** The UTF-8 length of a text (a lone surrogate counts as the three bytes of U+FFFD, which is how a column keeps it). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHigh(unit) && at + 1 < text.length && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) { bytes += 4; at++; }
    else bytes += 3;
  }
  return bytes;
}
const bytesOf = (chunks: readonly string[]): number => chunks.reduce((total, chunk) => total + utf8Length(chunk), 0);
/** A label of the Harness as it can be stored: no NUL, and no half of a surrogate pair. What was changed is told in `clipped`. */
function scrub(value: string, field: string, clipped: string[]): string {
  let text = value;
  if (text.includes("\0")) { text = text.replace(/\0/gu, ""); note(clipped, field + ":nul"); }
  const sane = sound(text);
  if (sane.marks.length > 0) { text = sane.text; note(clipped, field + ":surrogate"); }
  return text;
}
/** A label that must say something: an empty one (or only spaces) is given its placeholder. */
function label(value: unknown, field: string, placeholder: string, clipped: string[]): string {
  const text = scrub(str(value), field, clipped);
  if (text.trim() !== "") return text;
  note(clipped, field + ":empty");
  return placeholder;
}
function scrubDeep(value: unknown, clipped: string[]): unknown {
  if (typeof value === "string") return scrub(value, "fields", clipped);
  if (Array.isArray(value)) return value.map(entry => scrubDeep(entry, clipped));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDeep(entry, clipped)]));
  return value;
}
/** A number from the Harness that JSON and a column keep exactly (a safe integer); anything else is left out. */
function whole(value: unknown, field: string, clipped: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  note(clipped, field + ":range");
  return undefined;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const rowOf = (item: HeldItem): ItemRow => { const { text: _text, ...row } = item; return { ...row, textBytes: 0, textChunks: 0 }; };
const withNative = (fields: ItemFields, native: NativeFacts): ItemFields => ({ ...fields, native } as ItemFields);
const nativeOf = (facts: NativeFacts, clipped: readonly string[]): NativeFacts => clipped.length === 0 ? facts : { ...facts, clipped: [...clipped] };
const TERMINAL: ReadonlySet<ItemStatus> = new Set<ItemStatus>(["completed", "failed", "declined", "cancelled"]);

// ---------------------------------------------------------------------------------------------------------------------------------
// Finding, putting and changing items
// ---------------------------------------------------------------------------------------------------------------------------------

function find(s: Draft, itemId: string): number | undefined {
  const at = s.ids.get(itemId);
  if (at === undefined) return undefined;
  if (vecAt(s.entries, at)?.item.itemId === itemId) return at;
  // Another version of this Turn put something else at this place (the index is shared and only grows): look through this version's own items.
  const found = vecList(s.entries).findIndex(entry => entry.item.itemId === itemId);
  return found < 0 ? undefined : found;
}
interface NewItem {
  readonly itemId: string; readonly fields: ItemFields; readonly status: ItemStatus; readonly at: number; readonly endedAt?: number | null; readonly parentId?: string | null;
  readonly text?: readonly string[]; readonly request?: Request; readonly detail?: NativeToolDetail; readonly dirty?: boolean;
}
function insert(s: Draft, w: Writes, made: NewItem): number {
  const seq = s.nextSeq, text = made.text ?? [], position = s.entries.length;
  const item: HeldItem = { runId: s.run.runId, seq, itemId: made.itemId, type: made.fields.type, status: made.status, startedAt: made.at, endedAt: made.endedAt ?? null, parentId: made.parentId ?? null,
    createdSeq: null, textBytes: bytesOf(text), textChunks: text.length, fields: made.fields, text };
  s.entries = vecPush(s.entries, { item, ...(made.detail === undefined ? {} : { detail: made.detail }), ...(made.dirty === true ? { dirty: true as const } : {}), ...(made.request === undefined ? {} : { request: made.request }) });
  s.ids.set(made.itemId, position); s.nextSeq = seq + 1;
  w.put(rowOf(item), true);
  text.forEach((chunk, chunkAt) => w.text.push({ runId: item.runId, itemSeq: seq, chunk: chunkAt, text: chunk }));
  return position;
}
/** Puts a changed item in place of the one at `position`, with what is kept beside it. `write` is false for a change the store need not hear of (the text, whose counters it keeps). */
function change(s: Draft, w: Writes, position: number, item: HeldItem, beside: Omit<Entry, "item"> = {}, write = true): void {
  s.entries = vecSet(s.entries, position, { ...beside, item });
  if (write) w.put(rowOf(item), false);
}
/** An item that takes a place on the timeline arrives: the segment that was open is over. */
function takePlace(s: Draft, w: Writes, at: number): void { closeSegment(s, w, at, "completed"); }

// ---------------------------------------------------------------------------------------------------------------------------------
// Text: windows, held whitespace, segments
// ---------------------------------------------------------------------------------------------------------------------------------

function takeText(s: Draft, w: Writes, kind: Kind, raw: string, at: number): void {
  const nul = raw.includes("\0"), text = nul ? raw.replace(/\0/gu, "") : raw;
  if (text === "") return;
  if (s.window !== null && s.window.kind !== kind) flushWindow(s, w, false);
  if (s.segment !== null && s.segment.kind !== kind) closeSegment(s, w, at, "completed");
  if (s.hold !== null && s.hold.kind !== kind) writeHold(s, w, at, "completed");
  const open = s.window;
  s.window = open === null ? { kind, text, bytes: utf8Length(text), at, nul } : { ...open, text: open.text + text, bytes: open.bytes + utf8Length(text), nul: open.nul || nul };
  if (s.window.bytes >= STREAM_WINDOW_BYTES) flushWindow(s, w, false);
}
/** The window is committed: a chunk of the open segment, the first of a segment it opens, or whitespace that waits. `final`: the Turn ends, so nothing is carried to a next window. */
function flushWindow(s: Draft, w: Writes, final: boolean): void {
  const window = s.window;
  if (window === null) return;
  s.window = null;
  const segment = s.segment !== null && s.segment.kind === window.kind ? s.segment : null, hold = s.hold !== null && s.hold.kind === window.kind ? s.hold : null;
  let joined = (segment !== null ? segment.carry : hold !== null ? hold.text : "") + window.text, carry = "";
  if (!final && joined !== "" && isHigh(joined.charCodeAt(joined.length - 1))) { carry = joined.slice(-1); joined = joined.slice(0, -1); }
  if (segment !== null) {
    s.segment = { ...segment, carry };
    if (joined !== "") appendChunk(s, w, joined, window.nul);
  } else if (/\S/u.test(joined)) {
    s.hold = null;
    s.segment = openSegment(s, w, window.kind, joined, carry, hold?.at ?? window.at, window.nul || hold?.nul === true, "running", null);
  } else {
    s.hold = { kind: window.kind, text: joined + carry, at: hold?.at ?? window.at, nul: window.nul || hold?.nul === true };
  }
}
/** Opens the item of a segment with its first chunk. `endedAt`: when it is written closed (whitespace that was held, written because the kind changed or the Turn ended). */
function openSegment(s: Draft, w: Writes, kind: Kind, body: string, carry: string, at: number, nul: boolean, status: ItemStatus, endedAt: number | null): Segment {
  const count = kind === "text" ? s.counts.text + 1 : s.counts.think + 1, itemId = (kind === "text" ? "text:" : "think:") + count;
  s.counts = kind === "text" ? { ...s.counts, text: count } : { ...s.counts, think: count };
  const { text, marks } = sound(body), clipped: string[] = nul ? ["text:nul"] : [];
  const fields: ItemFields = kind === "text" ? { type: "assistant_message", messageId: s.run.facts.assistantMessageId } : { type: "reasoning" };
  const native: NativeFacts = nativeOf(marks.length === 0 ? {} : { surrogates: marks }, clipped);
  insert(s, w, { itemId, fields: Object.keys(native).length === 0 ? fields : withNative(fields, native), status, at, endedAt, text: [text] });
  return { kind, itemId, units: body.length, carry };
}
/** A chunk after the first, in the open segment: the lone surrogates it holds are told by their place in the whole text. */
function appendChunk(s: Draft, w: Writes, body: string, nul: boolean): void {
  const segment = s.segment!, position = find(s, segment.itemId)!, entry = vecAt(s.entries, position)!, item = entry.item, { text, marks } = sound(body);
  const surrogates = [...item.fields.native?.surrogates ?? [], ...marks.map(([index, unit]) => [segment.units + index, unit] as const)];
  const clipped = [...item.fields.native?.clipped ?? []];
  if (nul) note(clipped, "text:nul");
  const told = marks.length > 0 || clipped.length !== (item.fields.native?.clipped?.length ?? 0);
  const native = nativeOf({ ...item.fields.native, ...(surrogates.length === 0 ? {} : { surrogates }) }, clipped);
  w.text.push({ runId: item.runId, itemSeq: item.seq, chunk: item.text.length, text });
  change(s, w, position, { ...item, text: [...item.text, text], textChunks: item.textChunks + 1, textBytes: item.textBytes + utf8Length(text), ...(told ? { fields: withNative(item.fields, native) } : {}) },
    { ...entry }, told);
  s.segment = { ...segment, units: segment.units + body.length };
}
function closeSegment(s: Draft, w: Writes, at: number, status: ItemStatus): void {
  const segment = s.segment;
  if (segment === null) return;
  if (segment.carry !== "") { const carry = segment.carry; s.segment = { ...segment, carry: "" }; appendChunk(s, w, carry, false); }
  const position = find(s, segment.itemId)!, entry = vecAt(s.entries, position)!;
  change(s, w, position, { ...entry.item, status, endedAt: at }, entry);
  s.segment = null;
}
function writeHold(s: Draft, w: Writes, at: number, status: ItemStatus): void {
  const hold = s.hold;
  if (hold === null) return;
  s.hold = null;
  openSegment(s, w, hold.kind, hold.text, "", hold.at, hold.nul, status, at);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------------------------

/** What a call's detail is after one more report of it: what is newer replaces what was, and nothing is cut. */
export function mergeToolDetail(prior: NativeToolDetail | undefined, next: NativeToolDetail): NativeToolDetail {
  const kind = next.kind ?? prior?.kind, name = next.name ?? prior?.name, input = next.input ?? prior?.input, output = next.output ?? prior?.output, diff = next.diff ?? prior?.diff;
  const locations = next.locations ?? prior?.locations, exitCode = next.exitCode ?? prior?.exitCode, parentId = next.parentId ?? prior?.parentId;
  return { ...(kind === undefined ? {} : { kind }), ...(name === undefined ? {} : { name }), ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
    ...(diff === undefined ? {} : { diff }), ...(locations === undefined ? {} : { locations }), ...(exitCode === undefined ? {} : { exitCode }), ...(parentId === undefined ? {} : { parentId }),
    ...(prior?.truncated === true || next.truncated === true ? { truncated: true } : {}) };
}
function placeTool(s: Draft, w: Writes, event: Extract<ControlEvent, { type: "tool" }>, at: number): void {
  const clipped: string[] = [], id = scrub(str(event.id), "id", clipped), itemId = "tool:" + id, position = find(s, itemId), entry = position === undefined ? undefined : vecAt(s.entries, position);
  const given = record(event.detail) as NativeToolDetail | undefined, merged = given === undefined ? entry?.detail : mergeToolDetail(entry?.detail, given);
  const title = label(event.title, "title", "工具调用", clipped), word = scrub(str(event.status), "status", clipped);
  // What the item says of its detail (that it could not be kept) stays until a detail is kept: it is not rebuilt from this event.
  if (entry !== undefined) for (const mark of savedMarks(entry.item.fields.native?.clipped)) note(clipped, mark);
  const kind = merged?.kind === undefined ? undefined : scrub(str(merged.kind), "kind", clipped), name = merged?.name === undefined ? undefined : scrub(str(merged.name), "name", clipped);
  const parent = merged?.parentId === undefined ? undefined : scrub(str(merged.parentId), "parentId", clipped), exitCode = whole(merged?.exitCode, "exitCode", clipped);
  const call: PublicTool = { id, title, status: word, ...(kind === undefined ? {} : { kind }), ...(name === undefined ? {} : { name }), ...(parent === undefined ? {} : { parentId: parent }), ...(exitCode === undefined ? {} : { exitCode }) };
  const head = merged === undefined ? null : detailHead(merged), derived = derive(call, "going", head === null || Object.keys(head).length === 0 ? null : head);
  if (derived.status === "unknown" && itemStatus(word) === "unknown" && word.toLowerCase() !== "unknown") note(clipped, "status:unknown_word");
  const fields = scrubDeep(derived.fields, clipped) as Record<string, unknown>;
  const native: NativeFacts = nativeOf({ title, status: word, ...(kind === undefined ? {} : { kind }), ...(name === undefined ? {} : { name }), ...(exitCode === undefined ? {} : { exitCode }) }, clipped);
  const ref = entry === undefined ? undefined : (entry.item.fields as { readonly detail?: ContentRef }).detail;
  const made = { ...fields, ...(ref === undefined ? {} : { detail: ref }), native } as ItemFields, parentId = parent === undefined ? null : "tool:" + parent;
  const dirty = given !== undefined || entry?.dirty === true;
  if (position === undefined || entry === undefined) {
    takePlace(s, w, at);
    insert(s, w, { itemId, fields: made, status: derived.status, at, endedAt: TERMINAL.has(derived.status) ? at : null, parentId, ...(merged === undefined ? {} : { detail: merged }), dirty });
  } else {
    const item = entry.item, ended = item.endedAt ?? (TERMINAL.has(derived.status) ? at : null);
    const next: HeldItem = { ...item, status: derived.status, endedAt: ended, parentId, type: made.type, fields: made };
    const differs = !(item.status === next.status && item.parentId === next.parentId && item.type === next.type && sameJson(item.fields, next.fields));
    if (differs || merged !== entry.detail || dirty !== (entry.dirty === true)) change(s, w, position, differs ? next : item, { ...(merged === undefined ? {} : { detail: merged }), ...(dirty ? { dirty: true as const } : {}) }, differs);
  }
  const placed = vecAt(s.entries, find(s, itemId)!)!;
  if (placed.dirty === true && TERMINAL.has(placed.item.status) && placed.detail !== undefined) {
    w.store.push({ toolId: id, detail: placed.detail });
    const { dirty: _cleared, ...rest } = placed;
    s.entries = vecSet(s.entries, find(s, itemId)!, rest);
  }
}
/**
 * What an item of a call says in `native.clipped` when the content store could not keep its detail (disk full, a failed write): the call's input, output and diff are not
 * kept, and a reader says so instead of listing the call as if it had none. A detail kept later takes the mark away.
 */
export const DETAIL_NOT_SAVED = "detail:not_saved";
const savedMarks = (clipped: readonly string[] | undefined): readonly string[] => (clipped ?? []).filter(mark => mark.startsWith("detail:"));
/** The content store gave a tool's detail this reference. */
function placeDetail(s: Draft, w: Writes, toolId: string, ref: ContentRef): void {
  const position = find(s, "tool:" + scrub(str(toolId), "id", [])), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined || record(ref) === undefined) return;
  const held = (entry.item.fields as { readonly detail?: ContentRef }).detail, native = entry.item.fields.native;
  if (held?.id === ref.id && savedMarks(native?.clipped).length === 0) return;
  const clipped = (native?.clipped ?? []).filter(mark => !mark.startsWith("detail:")), { clipped: _gone, ...facts } = native ?? {};
  change(s, w, position, { ...entry.item, fields: { ...entry.item.fields, detail: ref, ...(native === undefined ? {} : { native: clipped.length === 0 ? facts : { ...facts, clipped } }) } as ItemFields }, entry);
  if (held?.id !== ref.id) w.refs.push({ contentId: ref.id, sessionId: s.run.sessionId, runId: s.run.runId, itemSeq: entry.item.seq, role: "tool_detail" });
}
/** The content store could not keep a tool's detail: its item is marked. */
function placeDetailLost(s: Draft, w: Writes, toolId: string): void {
  const position = find(s, "tool:" + scrub(str(toolId), "id", [])), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined) return;
  const native = entry.item.fields.native ?? {}, clipped = native.clipped ?? [];
  if (clipped.includes(DETAIL_NOT_SAVED)) return;
  change(s, w, position, { ...entry.item, fields: { ...entry.item.fields, native: { ...native, clipped: [...clipped, DETAIL_NOT_SAVED] } } as ItemFields }, entry);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Activities, the plan, notices, outputs
// ---------------------------------------------------------------------------------------------------------------------------------

function placeActivity(s: Draft, w: Writes, event: Extract<ControlEvent, { type: "activity" }>, at: number): void {
  const clipped: string[] = [], id = scrub(str(event.id), "id", clipped), itemId = "activity:" + id, kind = scrub(str(event.kind), "kind", clipped);
  const title = label(event.title, "title", kind || "task", clipped), word = scrub(str(event.status), "status", clipped), status = itemStatus(word);
  if (status === "unknown" && word.toLowerCase() !== "unknown") note(clipped, "status:unknown_word");
  const detailed = event.detail === undefined ? "" : scrub(str(event.detail), "detail", clipped), more = detailed === "" ? undefined : detailed;
  const native = nativeOf({ title, kind, status: word, ...(more === undefined ? {} : { more }) }, clipped);
  let fields: ItemFields, text: readonly string[] = [];
  switch (kind) {
    case "subagent": case "task": fields = { type: "subagent", title, native }; break;
    case "compaction": fields = { type: "context_event", kind: "compaction", native }; break;
    default: fields = { type: "notice", severity: kind === "retry" ? "warning" : "info", code: kind, ...(more === undefined ? {} : { more }), native }; text = [title];
  }
  const position = find(s, itemId), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined) { takePlace(s, w, at); insert(s, w, { itemId, fields, status, at, endedAt: TERMINAL.has(status) ? at : null, text }); return; }
  // The words of a notice are its first chunk and never change; the label that is current is `native.title`.
  const item = entry.item, next: HeldItem = { ...item, status, endedAt: item.endedAt ?? (TERMINAL.has(status) ? at : null), type: fields.type, fields };
  if (!(item.status === next.status && item.type === next.type && sameJson(item.fields, next.fields))) change(s, w, position, next, entry);
}
function placePlan(s: Draft, w: Writes, event: Extract<ControlEvent, { type: "plan" }>, at: number): void {
  const clipped: string[] = [], steps: PlanStep[] = [];
  for (const entry of (Array.isArray(event.entries) ? event.entries : []).filter(candidate => record(candidate) !== undefined)) {
    const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
    if (entry.status !== status) note(clipped, "steps.status:unknown_word");
    steps.push({ text: label(entry.content, "steps.text", "…", clipped), status, ...(entry.priority === "high" || entry.priority === "medium" || entry.priority === "low" ? { priority: entry.priority } : {}) });
  }
  const explained = event.explanation === undefined ? "" : scrub(str(event.explanation), "explanation", clipped);
  const fields = { type: "plan" as const, steps, ...(explained === "" ? {} : { explanation: explained }), ...(clipped.length === 0 ? {} : { native: { clipped } }) } as ItemFields;
  const position = find(s, "plan"), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined) { insert(s, w, { itemId: "plan", fields, status: "running", at }); return; }
  if (!sameJson(entry.item.fields, fields)) change(s, w, position, { ...entry.item, fields }, entry);
}
const noticeSeverity = (value: string): "error" | "warning" | "info" => value === "error" ? "error" : value === "warning" ? "warning" : "info";
const printOf = (severity: string, title: string, more: string | undefined): string => createHash("sha256").update(JSON.stringify([severity, title, more ?? null])).digest("hex");
/**
 * The fingerprint of a Harness notice, by which one already shown in a conversation is not shown again (`notice_prints`): its severity, its words and its detail, as they are
 * placed. The storage conversion writes the fingerprint of every notice a converted Run showed, so that a Harness started again after the upgrade does not show them twice.
 */
export function noticePrint(notice: { readonly severity: string; readonly title: string; readonly detail?: string }): string {
  const clipped: string[] = [], title = label(notice.title, "title", "提示", clipped), detailed = notice.detail === undefined ? "" : scrub(str(notice.detail), "detail", clipped);
  return printOf(noticeSeverity(notice.severity), title, detailed === "" ? undefined : detailed);
}
function placeNotice(s: Draft, w: Writes, notice: { readonly severity: string; readonly title: string; readonly detail?: string; readonly code?: string }, at: number, env: PlaceEnv, harness: boolean): void {
  const clipped: string[] = [], title = label(notice.title, "title", "提示", clipped), detailed = notice.detail === undefined ? "" : scrub(str(notice.detail), "detail", clipped), more = detailed === "" ? undefined : detailed;
  const severity = noticeSeverity(notice.severity);
  if (harness) {
    // A Harness started again for every Turn repeats its start-up warnings: a notice already shown in the conversation is not shown again.
    const print = printOf(severity, title, more);
    if (s.prints.has(print) || env.noticeShown?.(print) === true) return;
    s.prints = new Set([...s.prints, print]); w.prints.push(print);
  }
  takePlace(s, w, at);
  const count = s.counts.notice + 1, native = nativeOf({ title, ...(more === undefined ? {} : { more }) }, clipped);
  s.counts = { ...s.counts, notice: count };
  if (severity === "error") insert(s, w, { itemId: "notice:" + count, fields: { type: "error", class: "unknown", message: more === undefined ? title : title + "\n" + more, native }, status: "failed", at, endedAt: at });
  else insert(s, w, { itemId: "notice:" + count, fields: { type: "notice", severity, ...(notice.code === undefined ? {} : { code: notice.code }), ...(more === undefined ? {} : { more }), native }, status: "completed", at, endedAt: at, text: [title] });
}
function placeOutput(s: Draft, w: Writes, given: Extract<ControlEvent, { type: "output" }>["output"] | undefined, stored: ContentRef | undefined, at: number): void {
  const output = record(given) as Extract<ControlEvent, { type: "output" }>["output"] | undefined, clipped: string[] = [];
  if (output === undefined) return;
  let fields: ItemFields;
  if (output.kind === "content") {
    // Its bytes are the content store's: without the reference the store gave them there is nothing to place.
    if (stored === undefined) return;
    fields = { type: "artifact", kind: stored.kind === "image" ? "image" : "file", name: stored.name, content: stored };
  } else {
    const name = label(output.name, "name", "链接", clipped), title = output.title === undefined ? "" : scrub(str(output.title), "title", clipped), media = output.mediaType === undefined ? "" : scrub(str(output.mediaType), "mediaType", clipped);
    fields = { type: "artifact", kind: "link", name: title === "" ? name : title, uri: scrub(str(output.uri), "uri", clipped), native: nativeOf({ name, ...(title === "" ? {} : { title }), ...(media === "" ? {} : { mediaType: media }) }, clipped) };
  }
  takePlace(s, w, at);
  const count = s.counts.output + 1;
  s.counts = { ...s.counts, output: count };
  const position = insert(s, w, { itemId: "output:" + count, fields, status: "completed", at, endedAt: at });
  if (output.kind === "content" && stored !== undefined) w.refs.push({ contentId: stored.id, sessionId: s.run.sessionId, runId: s.run.runId, itemSeq: vecAt(s.entries, position)!.item.seq, role: "output" });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Approvals and questions
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The role of an option of an approval, from what its Harness calls it (the drivers pass an option's id and words, not its kind): refusing
 * words first, then the narrower allowance (for the conversation), the lasting one, and last the plain allow. What no word places is `other`.
 */
export function approvalRole(option: { readonly id: string; readonly name: string }): ApprovalRole {
  const text = (option.id + " " + option.name).toLowerCase();
  if (/reject|deny|denied|decline|refuse|abort|cancel|拒绝|不允许|取消|中止|禁止/u.test(text) || /^\s*(?:no|n|nope|不|否)\b/u.test(option.name.toLowerCase())) return "deny";
  if (/session|会话/u.test(text)) return "allow_session";
  if (/always|forever|persist|remember|don'?t ask again|始终|总是|永久|一直|记住|以后/u.test(text)) return "allow_always";
  if (/allow|accept|approve|yes|once|proceed|ok\b|允许|同意|批准|一次/u.test(text)) return "allow_once";
  return "other";
}
/** What an approval is about, as far as its title says (a derived value, worked out again when the rule is better: `other` when nothing says). */
function subjectOf(title: string): ApprovalItem["subject"] {
  const words = title.replace(/^子 Agent\s*·\s*/u, "").trim();
  if (/请求修改文件|^(?:edit|write|create|update|patch|apply|delete|remove|move|rename|modify)\b/iu.test(words)) return "file_change";
  if (/请求执行命令|^(?:run|bash|shell|exec|execute|terminal|command)\b/iu.test(words)) return "command";
  if (/^(?:read|view|open|cat)\b/iu.test(words)) return "file_read";
  if (/^(?:fetch|browse|curl|web)\b|^https?:\/\//iu.test(words)) return "network";
  switch (classifyTool({ title: words, status: "pending" }).family) {
    case "execute": return "command";
    case "change": return "file_change";
    case "read": return "file_read";
    case "fetch": return "network";
    case "mcp": case "subagent": return "tool";
    default: return "other";
  }
}
function placeRequest(s: Draft, w: Writes, event: Extract<ControlEvent, { type: "permission_requested" }>, at: number): void {
  const clipped: string[] = [], itemId = "permission:" + scrub(str(event.id), "id", clipped), question = event.kind === "question" || event.input !== undefined;
  const options = (Array.isArray(event.options) ? event.options : []).filter(candidate => record(candidate) !== undefined).map(option => ({ id: scrub(str(option.id), "options.id", clipped), name: scrub(str(option.name), "options.name", clipped) }));
  const title = label(event.title, "title", question ? "Harness 提问" : "Harness 请求批准", clipped), detailed = event.detail === undefined ? "" : scrub(str(event.detail), "detail", clipped);
  const native = nativeOf(detailed === "" ? {} : { more: detailed }, clipped), secret = event.input?.kind === "secret";
  const fields: ItemFields = question ? { type: "question", title, ...(secret ? { secret: true as const } : {}), ...(Object.keys(native).length === 0 ? {} : { native }) }
    : { type: "approval", subject: subjectOf(title), title, options: options.map(option => ({ id: option.id, role: approvalRole(option), label: option.name.trim() === "" ? option.id : option.name })), ...(Object.keys(native).length === 0 ? {} : { native }) };
  const request: Request = { kind: question ? "question" : "approval", options, secret };
  const position = find(s, itemId), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined) { takePlace(s, w, at); insert(s, w, { itemId, fields, status: "waiting", at, request }); return; }
  // The same request asked again while it waits is the same item; one that was answered stays as it was answered.
  if (entry.item.status === "waiting" && !sameJson(entry.item.fields, fields)) change(s, w, position, { ...entry.item, fields }, { request });
}
/** A request that waited ends: the item says how, and the decision when there is one. */
function endRequest(s: Draft, w: Writes, position: number, status: ItemStatus, at: number, decision: NonNullable<ApprovalItem["decision"]> | null, answer: string | null): void {
  const entry = vecAt(s.entries, position)!, item = entry.item;
  const fields = { ...item.fields, ...(decision === null ? {} : { decision }), ...(answer === null ? {} : { answer }) } as ItemFields;
  const { request: _answered, ...rest } = entry;
  change(s, w, position, { ...item, status, endedAt: at, fields }, rest);
}
function decide(s: Draft, w: Writes, id: string, option: string, input: string | undefined, by: "user" | "policy", at: number): void {
  const position = find(s, "permission:" + scrub(str(id), "id", [])), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined || entry.request === undefined || entry.item.status !== "waiting") return;
  const request = entry.request, chosen = request.options.find(candidate => candidate.id === str(option));
  if (request.kind === "approval") {
    const role = chosen === undefined ? "other" : approvalRole(chosen);
    endRequest(s, w, position, role === "deny" ? "declined" : "completed", at, { role, by, at }, null);
    return;
  }
  const refusing = /^(?:cancel|skip|decline|reject|deny)$/iu.test(str(option));
  // What the user typed (or the words of the choice) is the answer, unless the question asks for a secret: that is kept nowhere.
  const answer = refusing || request.secret ? null : scrub(input !== undefined ? str(input) : chosen?.name ?? "", "answer", []);
  endRequest(s, w, position, refusing ? (/^cancel$/iu.test(str(option)) ? "cancelled" : "declined") : "completed", at, null, answer);
}
/** The Harness took a request back (its own deadline, or the Turn was stopped): what waited is closed, as refused when it was denied and as cancelled otherwise. */
function withdraw(s: Draft, w: Writes, event: Extract<ControlEvent, { type: "permission" }>, at: number): void {
  const position = find(s, "permission:" + scrub(str(event.id), "id", [])), entry = position === undefined ? undefined : vecAt(s.entries, position);
  if (position === undefined || entry === undefined || entry.request === undefined || entry.item.status !== "waiting") return;
  const denied = event.decision === "denied";
  endRequest(s, w, position, denied ? "declined" : "cancelled", at, entry.request.kind === "approval" ? { role: "deny", by: "harness", at } : null, null);
}
/** The wait budget ran out: every approval that waited timed out, every question was left unanswered. */
function expire(s: Draft, w: Writes, at: number): void {
  vecList(s.entries).forEach((entry, position) => {
    if (entry.request === undefined || entry.item.status !== "waiting") return;
    endRequest(s, w, position, "cancelled", at, entry.request.kind === "approval" ? { role: "deny", by: "timeout", at } : null, null);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------------------------------------------

/** What an item that was still open is told as when the Turn ended as `turn` (see the table at the top). */
function closedStatus(item: { readonly status: ItemStatus; readonly type: ItemType }, turn: TerminalStatus): ItemStatus {
  switch (item.status) {
    case "waiting": return "cancelled";
    case "pending": case "running":
      if (item.type === "plan") return "completed";
      if (item.type === "assistant_message" || item.type === "reasoning") return runItemStatus(turn);
      return turn === "cancelled" ? "cancelled" : "unknown";
    default: return item.status;
  }
}
/**
 * The writes that close the items of a Turn that is over, whichever way it came to be (it ended, or a restart found it unfinished): the items
 * that were still open are told as the table at the top says, with the time they were closed, and every other item is left alone.
 */
export function settleItems(items: readonly HeldItem[], status: TerminalStatus, at: number): readonly ItemWrite[] {
  const writes: ItemWrite[] = [];
  for (const item of items) {
    const next = closedStatus(item, status);
    if (next !== item.status) writes.push({ op: "update", row: { ...rowOf(item), status: next, endedAt: item.endedAt ?? at } });
  }
  return writes;
}
/**
 * The details of calls still waiting to be stored, taken now: `place` hands over the detail of a call when it ends, and the details of the calls that never
 * ended only when the Turn is settled, which is after the Turn's program is closed; the Runtime takes them before that, while the program is still owned, stores them
 * and tells each reference in a `detail` input. A detail taken is no longer waiting (the Turn comes back without it, and the same call is not stored twice).
 */
export function takeDetails(turn: ActiveTurn): { readonly turn: ActiveTurn; readonly store: readonly StoreRequest[] } {
  const store: StoreRequest[] = [];
  let entries = turn.entries;
  vecList(turn.entries).forEach((entry, position) => {
    if (entry.dirty !== true || entry.detail === undefined) return;
    store.push({ toolId: entry.item.itemId.slice(5), detail: entry.detail });
    const { dirty: _taken, ...rest } = entry;
    entries = vecSet(entries, position, rest);
  });
  return store.length === 0 ? { turn, store } : { turn: { ...turn, entries }, store };
}
const BESIDE_THE_ANSWER: ReadonlySet<ItemType> = new Set<ItemType>(["notice", "error", "plan", "artifact", "context_event"]);
/**
 * The seq of the item that is the Turn's answer (`phase: "final"`), for a reader to put in: only a completed Turn has one, and it is the last
 * reply segment of the Turn, found past the notices, the plan, the artifacts and the context events. A Turn that ended on an action, or
 * that was cancelled, failed or left unknown, has none (review I4). `items` are in the order of their `seq`.
 */
export function finalItemSeq(items: readonly { readonly seq: number; readonly type: ItemType }[], status: RunStatus): number | null {
  if (status !== "completed") return null;
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!;
    if (BESIDE_THE_ANSWER.has(item.type)) continue;
    return item.type === "assistant_message" ? item.seq : null;
  }
  return null;
}
function settle(s: Draft, w: Writes, status: TerminalStatus, at: number): void {
  flushWindow(s, w, true);
  closeSegment(s, w, at, runItemStatus(status));
  writeHold(s, w, at, runItemStatus(status));
  vecList(s.entries).forEach((entry, position) => {
    const next = closedStatus(entry.item, status);
    const { request: _closed, dirty, ...rest } = entry;
    if (dirty === true && entry.detail !== undefined) w.store.push({ toolId: entry.item.itemId.slice(5), detail: entry.detail });
    if (next !== entry.item.status) change(s, w, position, { ...entry.item, status: next, endedAt: entry.item.endedAt ?? at }, rest);
    else if (dirty === true || entry.request !== undefined) s.entries = vecSet(s.entries, position, { ...rest, item: entry.item });
  });
  s.settled = status;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// place
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * One input to a Turn in progress. Total: nothing the Harness sends throws or is refused. Pure: `turn` is not changed (the Turn comes back
 * as the same object when the input changed nothing). Before anything but text of the same kind, the window of text is committed, so that
 * the order in which things arrived is the order they are written in; a caller that commits the window on its own (a `flush` before
 * each event, as the Runtime does) never sees that happen here. A Turn that has ended takes no more.
 */
export function place(turn: ActiveTurn, input: PlaceInput, env: PlaceEnv = {}): Placed {
  const s: Draft = { ...turn }, w = new Writes(env.eventIndex ?? 0);
  if (turn.settled === null) {
    switch (input.kind) {
      case "event": {
        const event = record(input.event) as ControlEvent | undefined, at = input.at;
        if (event === undefined) break;
        if (event.type === "text" || event.type === "thinking") { takeText(s, w, event.type, str(event.text), at); break; }
        flushWindow(s, w, false);
        switch (event.type) {
          case "tool": placeTool(s, w, event, at); break;
          case "plan": placePlan(s, w, event, at); break;
          case "notice": placeNotice(s, w, event, at, env, true); break;
          case "activity": placeActivity(s, w, event, at); break;
          case "output": placeOutput(s, w, event.output, input.stored, at); break;
          case "permission_requested": placeRequest(s, w, event, at); break;
          case "permission": withdraw(s, w, event, at); break;
          case "usage": case "diagnostic": case "input_recorded": break;
        }
        break;
      }
      case "flush": flushWindow(s, w, false); break;
      case "detail": flushWindow(s, w, false); placeDetail(s, w, input.toolId, input.ref); break;
      case "detail_lost": flushWindow(s, w, false); placeDetailLost(s, w, input.toolId); break;
      case "decided": flushWindow(s, w, false); decide(s, w, input.id, input.option, input.input, input.by ?? "user", input.at); break;
      case "expired": flushWindow(s, w, false); expire(s, w, input.at); break;
      case "notice": flushWindow(s, w, false); placeNotice(s, w, input, input.at, env, false); break;
      case "settled": settle(s, w, input.status, input.at); break;
    }
  }
  const changed = (Object.keys(s) as (keyof ActiveTurn)[]).some(key => s[key] !== turn[key]);
  return { turn: changed ? s : turn, changes: w.changes(), store: w.store };
}
