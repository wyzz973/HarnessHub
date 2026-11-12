import { PAGE, type HeldItem, type ItemRow, type Mutation, type RunRow } from "../contracts/conversation.js";
import { SessionError } from "../contracts/session.js";
import type { SessionCommitFrame, SessionHeadView, WireItem, WireItemUpsert, WireRun, WireTextAppend } from "../contracts/web.js";
import { emptyFields } from "../infrastructure/session/load.js";

/*
 * One commit, one frame (ADR-057 3.4). The stream's frames are applied by their watermark (web/src/session-stream.ts drops a frame whose `lastSeq` is not above
 * the page's), so everything one commit changed travels in ONE frame: the head, the Runs that began or changed with their Turn headers, the items that are new
 * or changed, the text that was appended. The frame is made from the commit's changes AFTER the commit (`Applied.changes`: it has the offset every chunk of
 * text starts at and what each item counted), never before, so that nothing is published that is not kept.
 *
 *  - An item's upsert never carries its text: the text arrives in `texts`, each chunk at the byte offset `from` it starts at (the page applies it only when
 *    `from` is the length of the text it holds, and takes the conversation again when it is not). The `text` that a reasoning segment and a notice must have
 *    to be what the protocol says they are is "" in an upsert.
 *  - What a frame does not carry it says. A chunk longer than `PAGE.itemInlineBytes` is not sent (and neither is any chunk of the same item after it in this
 *    frame): the item's upsert is marked `bodyOmitted` with `textBytes` the size of the text now, or, when the item is not in the frame, a `texts` entry with
 *    `omittedBytes` stands in for the chunks. An item whose JSON is longer than that (a file change of thousands of files) goes as its type with the type's
 *    fields empty, marked `bodyOmitted`. A frame holds no more than a window's worth (`PAGE.windowBytes`) of JSON and text: what comes after that is left
 *    out in the same way, so that no commit, however much it wrote, makes a frame a connection cannot carry. The page reads the range, or the item whole.
 *  - The Harness's own words (`native`) are for the relay's brief and the context table, and are not sent.
 * The Turn header of a Run (executor names, usage in the protocol's meaning) is the display layer's: `views.run` makes the WireRun.
 */

export interface FrameViews { readonly run: (row: RunRow) => WireRun }

const TEXT_REQUIRED: ReadonlySet<string> = new Set(["reasoning", "notice"]);
const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * An item as the wire has it. `text` is its text when the caller carries it (a window does; an upsert of a frame does not); `stub` sends its type with the
 * type's fields empty (its JSON was longer than the transfer carries); `bodyOmitted` says the item's body (its text, or the fields a stub stands in for) was
 * left out, and `textBytes` is the size of the text the transfer does not carry.
 */
export function wireItem(row: ItemRow, options: { readonly text?: string; readonly stub?: boolean; readonly bodyOmitted?: boolean; readonly textBytes?: number } = {}): WireItem {
  const source = options.stub === true ? emptyFields(row.type) : row.fields;
  const { native: _native, ...fields } = source as typeof source & { readonly native?: unknown };
  const item: Record<string, unknown> = { ...fields, id: row.itemId, seq: row.seq, status: row.status };
  if (row.startedAt !== null) item.startedAt = row.startedAt;
  if (row.endedAt !== null) item.endedAt = row.endedAt;
  if (row.parentId !== null) item.parentId = row.parentId;
  if (row.type === "assistant_message") item.phase = (row.fields as { readonly phase?: string }).phase ?? "commentary";
  if (options.text !== undefined) item.text = options.text;
  else if (TEXT_REQUIRED.has(row.type)) item.text = "";
  if (options.bodyOmitted === true) item.bodyOmitted = true;
  if (options.textBytes !== undefined) item.textBytes = options.textBytes;
  return item as unknown as WireItem;
}
/** An item of a page read, as the wire has it: its text joined, or marked left out when the read left it out. */
export function wireItemOf(held: HeldItem): WireItem {
  const leftOut = held.bodyOmitted === true || held.textOmitted === true;
  return wireItem(held, { stub: held.bodyOmitted === true, bodyOmitted: leftOut, ...(held.textOmitted === true || held.text.length === 0 ? {} : { text: held.text.join("") }), ...(leftOut && held.textBytes > 0 ? { textBytes: held.textBytes } : {}) });
}

export function commitFrame(changes: Mutation, head: SessionHeadView, views: FrameViews): SessionCommitFrame {
  const written = changes.head?.row;
  if (written !== undefined && (written.id !== head.id || written.lastSeq !== head.lastSeq)) throw new SessionError("INVALID_DATA", "the head view is not the head this commit wrote");
  const key = (runId: string, seq: number): string => runId + "\u0000" + seq;

  // Items that are new or changed. An item whose JSON is longer than a frame carries goes without it, and so does every item once the frame already holds a window's worth.
  const upserts: WireItemUpsert[] = [], position = new Map<string, number>(), rows = new Map<string, ItemRow>();
  let held = 0;
  for (const write of changes.items ?? []) {
    const row = write.row, size = utf8(JSON.stringify(row.fields)), long = size > PAGE.itemInlineBytes || held >= PAGE.windowBytes;
    if (!long) held += size;
    position.set(key(row.runId, row.seq), upserts.length); rows.set(key(row.runId, row.seq), row);
    upserts.push({ runId: row.runId, item: wireItem(row, long ? { stub: true, bodyOmitted: true, ...(row.textBytes > 0 ? { textBytes: row.textBytes } : {}) } : {}) });
  }

  // Text appended: each chunk where it starts, up to the first one longer than a frame carries; from there the item says it left text out.
  const texts: WireTextAppend[] = [], left = new Map<string, { runId: string; itemSeq: number; from: number; bytes: number }>();
  for (const append of changes.text ?? []) {
    if (append.byteOffset === undefined) throw new SessionError("INVALID_DATA", "a chunk of text is framed from the commit as it was written, which has its offset");
    const id = key(append.runId, append.itemSeq), size = utf8(append.text), omitting = left.get(id);
    if (omitting === undefined && size <= PAGE.itemInlineBytes && held < PAGE.windowBytes) { held += size; texts.push({ runId: append.runId, itemSeq: append.itemSeq, from: append.byteOffset, text: append.text }); continue; }
    if (omitting === undefined) left.set(id, { runId: append.runId, itemSeq: append.itemSeq, from: append.byteOffset, bytes: size });
    else omitting.bytes += size;
  }
  for (const [id, omitted] of left) {
    const at = position.get(id);
    if (at === undefined) { texts.push({ runId: omitted.runId, itemSeq: omitted.itemSeq, from: omitted.from, text: "", omittedBytes: omitted.bytes }); continue; }
    const upsert = upserts[at]!, size = Math.max(rows.get(id)!.textBytes, omitted.from + omitted.bytes);
    upserts[at] = { runId: upsert.runId, item: { ...upsert.item, bodyOmitted: true, textBytes: size } };
  }

  return { type: "commit", sessionId: head.id, version: head.version, lastSeq: head.lastSeq, ...(changes.head === undefined ? {} : { head }),
    ...(changes.runs === undefined ? {} : { runs: changes.runs.map(write => views.run(write.row)) }), ...(upserts.length === 0 ? {} : { items: upserts }), ...(texts.length === 0 ? {} : { texts }) };
}
