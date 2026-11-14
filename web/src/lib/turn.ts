import type { ContentRef } from "../../../src/contracts/content.js";
import type { RunStatus } from "../../../src/contracts/session.js";
import type { ToolDetailView } from "../api.js";

/** Whether a Run's state is an end state: nothing of it runs any more. */
export function finished(status: RunStatus): boolean { return status === "completed" || status === "cancelled" || status === "failed" || status === "unknown"; }

export interface DiffLine { readonly kind: "add" | "remove" | "context" | "hunk" | "file" | "meta"; readonly text: string; readonly oldNo?: number; readonly newNo?: number }
export interface DiffFile {
  readonly path: string; readonly add: number; readonly del: number; readonly lines: readonly DiffLine[];
  /** The diff creates this file (its old side is /dev/null or it says "new file mode"). */
  readonly created: boolean;
}
function stripPrefix(path: string): string { return path.replace(/^[ab]\//u, "").replace(/\t.*$/u, ""); }
/**
 * Splits unified diff text into files with numbered lines. Text without file headers becomes one file named `fallback`.
 * Counting is display data only; the text itself is shown exactly as the program reported it.
 */
export function parseUnifiedDiff(text: string, fallback: string): readonly DiffFile[] {
  interface Draft { path: string; add: number; del: number; lines: DiffLine[]; created: boolean }
  const files: Draft[] = [];
  let oldNo = 0, newNo = 0;
  const open = (path: string): Draft => { const file: Draft = { path, add: 0, del: 0, lines: [], created: false }; files.push(file); return file; };
  const lines = text.replace(/\n$/u, "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, last = files.at(-1);
    if (line.startsWith("diff --git ")) { const match = / b\/(.+)$/u.exec(line); open(match ? match[1]! : fallback).lines.push({ kind: "file", text: line }); continue; }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const next = lines[index + 1]!, target = stripPrefix(next.slice(4)), source = stripPrefix(line.slice(4));
      const path = target === "/dev/null" ? source : target;
      // A "diff --git" header already opened this file; its ---/+++ lines name it more exactly.
      const file = last !== undefined && last.lines.every(row => row.kind === "file" || row.kind === "meta") ? last : open(path);
      file.path = path; file.created ||= source === "/dev/null"; file.lines.push({ kind: "file", text: line }, { kind: "file", text: next }); index++; continue;
    }
    const file = last ?? open(fallback);
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); file.lines.push({ kind: "hunk", text: line }); continue; }
    if (line.startsWith("+")) { file.add++; file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ }); continue; }
    if (line.startsWith("-")) { file.del++; file.lines.push({ kind: "remove", text: line.slice(1), oldNo: oldNo++ }); continue; }
    if (line.startsWith("\\")) { file.lines.push({ kind: "meta", text: line }); continue; }
    // Git's extended header lines say what the file row already says (new, renamed, its mode): kept as the file's header, not drawn.
    if (/^(index |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode)/u.test(line)) { file.created ||= line.startsWith("new file mode"); file.lines.push({ kind: "file", text: line }); continue; }
    file.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}
/**
 * Stored tool details, read once per page (stored content is never rewritten under its id): the steps, the changes panel
 * and the header share them. A failed read is forgotten so that a later view can ask again; at most 400 details are kept.
 */
interface DetailEntry { readonly promise: Promise<ToolDetailView>; value: ToolDetailView | undefined }
const details = new Map<string, DetailEntry>();
/** A detail already read, without asking for it. */
export function knownToolDetail(id: string): ToolDetailView | undefined { return details.get(id)?.value; }
/** Reads a stored tool detail once; callers asking for the same detail share one request. */
export function readToolDetail(content: ContentRef, load: (content: ContentRef) => Promise<ToolDetailView>): Promise<ToolDetailView> {
  const known = details.get(content.id);
  if (known) { details.delete(content.id); details.set(content.id, known); return known.promise; }
  const entry: DetailEntry = { value: undefined, promise: load(content).then(value => { entry.value = value; return value; }, (error: unknown) => {
    if (details.get(content.id) === entry) details.delete(content.id);
    throw error;
  }) };
  details.set(content.id, entry);
  if (details.size > 400) { const oldest = details.keys().next().value; if (oldest !== undefined) details.delete(oldest); }
  return entry.promise;
}

/**
 * Whether something entering the transcript now is news or part of a page being drawn (ADR-054 §3: motion only for what
 * just happened). Things mounted in the same commit as a message inherit that message's answer; anything else decides from
 * `fresh`, the caller's own evidence (a message accepted moments ago). Call it from a layout effect, in tree order.
 */
let lastMount = { at: Number.NEGATIVE_INFINITY, live: false };
export function noteMount(fresh: boolean, now = performance.now()): boolean {
  const live = now - lastMount.at < 50 ? lastMount.live : fresh;
  lastMount = { at: now, live };
  return live;
}

/*
 * What the reader has already been shown of each Turn on this page, kept when the page draws a Turn again (its
 * conversation left and opened again): a Turn shown before is not news, and the record of the steps it showed carries
 * over, so nothing comes in twice. At most 500 Turns are remembered; a forgotten one is drawn as history. Read during
 * render, recorded from a layout effect.
 */
const shownTurns = new Map<string, Set<string>>();
/** The record of the steps a Turn showed, or undefined when this Run's Turn has not been shown on this page. */
export function shownSteps(runId: string): Set<string> | undefined { return shownTurns.get(runId); }
/** Records that a Run's Turn is shown, with the record its steps keep. */
export function rememberShown(runId: string, steps: Set<string>): void {
  if (shownTurns.get(runId) === steps) return;
  shownTurns.delete(runId); shownTurns.set(runId, steps);
  if (shownTurns.size > 500) { const oldest = shownTurns.keys().next().value; if (oldest !== undefined) shownTurns.delete(oldest); }
}

/** Committed characters released together, [from, to) in the text; they fade in as one piece (Motion board #09). */
export interface Chunk { readonly from: number; readonly to: number }

/*
 * The parts of a rehype tree this file touches. Text nodes carry the offsets of the Markdown they came from, which is how
 * a released piece of the committed text is found again in the rendered tree.
 */
export interface HastText { type: "text"; value: string; position?: { start: { offset?: number }; end: { offset?: number } } }
export interface HastElement { type: "element"; tagName: string; properties: Record<string, unknown>; children: HastNode[] }
export type HastNode = HastText | HastElement | { type: "root" | "comment" | "doctype" | "raw"; children?: HastNode[] };

function fading(value: string): HastElement { return { type: "element", tagName: "span", properties: { className: ["motion-token"] }, children: [{ type: "text", value }] }; }
/** Splits a text node at the released pieces it overlaps; a node whose characters do not map one to one fades whole. */
function splitText(node: HastText, chunks: readonly Chunk[]): HastNode[] {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start === undefined || end === undefined || !node.value || end <= chunks[0]!.from) return [node];
  if (node.value.length !== end - start) return chunks.some(chunk => chunk.from < end && chunk.to > start) ? [fading(node.value)] : [node];
  const parts: HastNode[] = [];
  let cursor = start;
  // Chunks are in order and never overlap: start from the first one that ends after this node starts.
  let low = 0, high = chunks.length;
  while (low < high) { const middle = (low + high) >> 1; if (chunks[middle]!.to <= start) low = middle + 1; else high = middle; }
  for (let index = low; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    if (chunk.from >= end) break;
    const from = Math.max(chunk.from, cursor), to = Math.min(chunk.to, end);
    if (from > cursor) parts.push({ type: "text", value: node.value.slice(cursor - start, from - start) });
    parts.push(fading(node.value.slice(from - start, to - start)));
    cursor = to;
  }
  if (cursor < end) parts.push({ type: "text", value: node.value.slice(cursor - start) });
  return parts;
}
export function wrapChunks(node: HastNode, chunks: readonly Chunk[]): void {
  if (!("children" in node) || !node.children || node.type === "element" && node.tagName === "pre") return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") next.push(...splitText(child, chunks));
    else { wrapChunks(child, chunks); next.push(child); }
  }
  node.children = next;
}
/**
 * Wraps each released piece of text in a span that fades in over 700 ms. Code blocks stay whole: their text is handed to
 * the highlighter as one string. Spans are counted per parent, so pieces keep their keys while more text arrives.
 */
export function rehypeReveal(options: { readonly chunks: readonly Chunk[] }) {
  return (tree: unknown) => { if (options.chunks.length) wrapChunks(tree as HastNode, options.chunks); };
}

/*
 * The display pace of streamed text (Motion board #08–#10, ADR-054 §3). Committed text is buffered and released every
 * 50 ms at a speed that follows the backlog: `rate` characters a second, a moving average of the backlog with weight 0.1,
 * started at the backlog itself when text arrives at rest, so a reply catches up in about a second. A burst of more than
 * 120 characters, or faster than 1.6 characters per millisecond, is shown at once. The released text is always a prefix of
 * the committed text: order and content never change (ADR-047), only when each part becomes visible.
 */
export interface Reveal { readonly text: string; readonly shown: number; readonly rate: number; readonly chunks: readonly Chunk[]; readonly at: number }
export type RevealAction = { readonly type: "arrive"; readonly text: string; readonly at: number; readonly animate: boolean } | { readonly type: "tick" } | { readonly type: "flush" } | { readonly type: "settle" };
/**
 * Where a release ending at `to` may stop: never inside a run of fence characters (` or ~) that opens a line after at most
 * three spaces. Half a closing fence ("``") would show as one more line of code until the rest came, so the block would grow
 * by a line and shrink again just as the reply ends (ruling L: its end must not jump); the whole run goes at once instead.
 */
function fenceStop(text: string, to: number): number {
  const mark = text[to - 1];
  if ((mark !== "`" && mark !== "~") || text[to] !== mark) return to;
  let start = to - 1;
  while (start > 0 && text[start - 1] === mark) start--;
  if (!/^ {0,3}$/u.test(text.slice(text.lastIndexOf("\n", start - 1) + 1, start))) return to;
  let end = to;
  while (end < text.length && text[end] === mark) end++;
  return end;
}
export function reveal(state: Reveal, action: RevealAction): Reveal {
  switch (action.type) {
    case "arrive": {
      if (action.text === state.text) return state;
      const appended = action.text.startsWith(state.text), delta = action.text.length - state.text.length;
      const burst = delta > 120 || delta / Math.max(1, action.at - state.at) > 1.6;
      if (!action.animate || !appended || burst) return { text: action.text, shown: action.text.length, rate: 0, chunks: appended ? state.chunks : [], at: action.at };
      return { ...state, text: action.text, at: action.at, rate: state.shown >= state.text.length ? delta : state.rate };
    }
    case "tick": {
      const backlog = state.text.length - state.shown;
      if (backlog <= 0) return state;
      const rate = state.rate * .9 + backlog * .1;
      let to = state.shown + Math.max(1, Math.min(backlog, Math.ceil(rate / 20)));
      // Never between the two halves of a character outside the basic plane, nor inside a fence marker.
      const unit = state.text.charCodeAt(to - 1);
      if (to < state.text.length && unit >= 0xD800 && unit <= 0xDBFF) to++;
      to = fenceStop(state.text, to);
      return { ...state, rate, shown: to, chunks: [...state.chunks, { from: state.shown, to }] };
    }
    case "flush": return state.shown < state.text.length || state.chunks.length ? { ...state, shown: state.text.length, chunks: [] } : state;
    case "settle": return state.chunks.length ? { ...state, chunks: [] } : state;
  }
}
