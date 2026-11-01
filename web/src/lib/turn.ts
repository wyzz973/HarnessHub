import type { ContentRef } from "../../../src/contracts/content.js";
import type { PublicRun, PublicTool, RunStatus } from "../../../src/contracts/session.js";
import type { ToolDetailView } from "../api.js";
import { toolParents } from "../tool-tree.js";
import { elapsed } from "./format.js";

export type Tool = PublicTool;
export const TOOL_PENDING = new Set(["pending", "in_progress", "inProgress", "running"]);
export const TOOL_STATUS: Readonly<Record<string, string>> = { pending: "等待", in_progress: "执行中", inProgress: "执行中", running: "执行中", completed: "完成", failed: "失败", declined: "已拒绝", cancelled: "已取消", interrupted: "已中断" };
export function finished(status: RunStatus): boolean { return status === "completed" || status === "cancelled" || status === "failed" || status === "unknown"; }
export function toolFailed(tool: Pick<Tool, "status">): boolean { return tool.status === "failed" || tool.status === "declined"; }
/** Once the Turn has ended, a tool whose end was never reported did not finish as far as anyone can tell. */
export function toolUnfinished(tool: Pick<Tool, "status">, active: boolean): boolean { return !active && TOOL_PENDING.has(tool.status); }
/** What a Run's state is called in facts and lists; the same words as the sidebar and the page header (ADR-054, X01). */
export const RUN_STATE: Readonly<Record<RunStatus, string>> = { queued: "排队中", preparing: "正在启动", running: "正在执行", settling: "正在结束", completed: "完成", cancelled: "已停止", failed: "失败", unknown: "结果未知" };

export type Category = "read" | "search" | "edit" | "execute" | "fetch" | "mcp" | "agent" | "other";
/** The kind of step a tool is; a call with tools of its own is a sub-agent, whatever its kind. */
export function toolCategory(tool: Pick<Tool, "kind">, nested: boolean): Category {
  if (nested) return "agent";
  switch (tool.kind) {
    case "read": return "read";
    case "search": return "search";
    case "execute": return "execute";
    case "edit": case "delete": case "move": return "edit";
    case "fetch": return "fetch";
    case "mcp": return "mcp";
    case "subagent": return "agent";
    default: return "other";
  }
}
/** The summary's order: what was looked at, what was changed, what ran, then the rest. */
const ORDER: readonly Category[] = ["read", "search", "edit", "execute", "fetch", "mcp", "agent", "other"];
/** Past tense, as the folded process reads once the Turn ended (Conversation board: "读了 4 个文件，搜索 2 次"). Counts are calls. */
const PHRASES: Readonly<Record<Category, (n: number) => string>> = {
  read: n => `读了 ${n} 个文件`, search: n => `搜索 ${n} 次`, edit: n => `改了 ${n} 处`, execute: n => `运行 ${n} 条命令`,
  fetch: n => `访问 ${n} 个网页`, mcp: n => `调用 ${n} 次 MCP 工具`, agent: n => `子 Agent ${n} 个`, other: n => `其他工具 ${n} 个`,
};
/** The short form of the details panel's list of Turns ("读取 4 · 搜索 2 · 修改 2 · 运行 2"). */
const SHORT: Readonly<Record<Category, string>> = { read: "读取", search: "搜索", edit: "修改", execute: "运行", fetch: "访问", mcp: "MCP", agent: "子 Agent", other: "其他" };

export interface ToolTree { readonly roots: readonly Tool[]; readonly children: ReadonlyMap<string, readonly Tool[]> }
/** Tools in call order; a tool whose parent call is listed is shown under it, as the sub-agent work of that call. */
export function toolTree(tools: readonly Tool[]): ToolTree {
  const parents = toolParents(tools), children = new Map<string, Tool[]>();
  for (const tool of tools) { const parent = parents.get(tool.id); if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), tool]); }
  return { roots: tools.filter(tool => !parents.has(tool.id)), children };
}
export interface ToolSummary {
  /** "读了 2 个文件，运行 1 条命令，1 项失败": every kind counted, failures and unfinished tools always named. */
  readonly text: string;
  /** "读取 2 · 运行 1 · 失败 1", for a list of Turns. */
  readonly compact: string;
  readonly failed: number; readonly unfinished: number;
  /** The tool running now, while the Turn runs. */
  readonly running: Tool | null;
}
/**
 * One line for a Turn's tools, such as "读了 2 个文件，运行 1 条命令". Failed and unfinished tools are always counted in it
 * (the approver's condition for folding the process): folding never hides them.
 */
export function toolSummary(tools: readonly Tool[], active: boolean): ToolSummary {
  const { roots, children } = toolTree(tools), counts = new Map<Category, number>();
  for (const tool of roots) { const kind = toolCategory(tool, (children.get(tool.id)?.length ?? 0) > 0); counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  const kinds = ORDER.filter(kind => counts.has(kind));
  const parts = kinds.map(kind => PHRASES[kind](counts.get(kind)!)), short = kinds.map(kind => SHORT[kind] + " " + counts.get(kind)!);
  const failed = tools.filter(toolFailed).length, unfinished = tools.filter(tool => toolUnfinished(tool, active)).length;
  if (failed) { parts.push(`${failed} 项失败`); short.push("失败 " + failed); }
  if (unfinished) { parts.push(`${unfinished} 项未完成`); short.push("未完成 " + unfinished); }
  const running = active ? [...tools].reverse().find(tool => TOOL_PENDING.has(tool.status)) ?? null : null;
  return { text: parts.join("，"), compact: short.join(" · "), failed, unfinished, running };
}

/** A step of the process: one tool, or consecutive reads shown as one group (ADR-054 §5). */
export type Step = { readonly kind: "tool"; readonly key: string; readonly tool: Tool } | { readonly kind: "reads"; readonly key: string; readonly tools: readonly Tool[] };
/**
 * The steps of one level of the tool tree: consecutive reads without tools of their own become one group. A group keeps
 * the key of its first read, so a read that grows into a group stays the same row.
 */
export function groupSteps(tools: readonly Tool[], children: ReadonlyMap<string, readonly Tool[]>): readonly Step[] {
  const steps: Step[] = [];
  for (const tool of tools) {
    const read = toolCategory(tool, (children.get(tool.id)?.length ?? 0) > 0) === "read", last = steps.at(-1);
    if (read && last?.kind === "reads") { steps[steps.length - 1] = { kind: "reads", key: last.key, tools: [...last.tools, tool] }; continue; }
    if (read && last?.kind === "tool" && toolCategory(last.tool, (children.get(last.tool.id)?.length ?? 0) > 0) === "read") { steps[steps.length - 1] = { kind: "reads", key: last.key, tools: [last.tool, tool] }; continue; }
    steps.push({ kind: "tool", key: tool.id, tool });
  }
  return steps;
}

/**
 * The verb a kind of step is shown with, and the words a program may already have put in front of its title for it: a
 * word followed by a colon or a space ("Read a.ts", "terminal: ls", "搜索：query"), never part of a longer word.
 */
const SEPARATOR = String.raw`(?:\s*[:：]\s*|\s+)`;
function prefix(words: string): RegExp { return new RegExp("^(?:" + words + ")" + SEPARATOR, "iu"); }
const VERBS: Readonly<Partial<Record<string, { readonly verb: string; readonly prefix: RegExp | null; readonly path: boolean }>>> = {
  read: { verb: "读取", prefix: prefix("读取|查看|阅读|read(?:_?file)?|view"), path: true },
  search: { verb: "搜索", prefix: prefix("搜索|查找|search(?:_?files)?|web_?search|find|glob"), path: false },
  execute: { verb: "运行", prefix: prefix("运行|执行|run|bash|terminal|shell|exec(?:ute)?|command"), path: false },
  edit: { verb: "修改", prefix: prefix("修改|编辑|写入|新建|创建|edit|multi_?edit|write(?:_?file)?|update|patch|apply_?patch|create"), path: true },
  delete: { verb: "删除", prefix: prefix("删除|delete|remove"), path: true },
  move: { verb: "移动", prefix: prefix("移动|重命名|move|rename"), path: true },
  fetch: { verb: "访问", prefix: prefix("访问|获取|fetch|web_?fetch|open"), path: false },
  mcp: { verb: "调用", prefix: null, path: false },
};
const CREATE = prefix("新建|创建|create");
/** The last part of an absolute file path; the whole path stays in the step's title. Anything else is kept as it is. */
function shortPath(target: string): string {
  return /^(?:\/|~\/)\S*\/[^\s/]+$/u.test(target) ? target.slice(target.lastIndexOf("/") + 1) : target;
}
export interface StepLabel {
  /** The verb as the step finished ("读取"), or null for a kind without one. */
  readonly verb: string | null;
  /** The verb while it runs ("正在读取"). */
  readonly running: string | null;
  /** What it acted on, from the program's own title without a verb the program put in front. */
  readonly target: string;
}
/**
 * How one tool reads as a step: the program's title, with the verb of its kind in front (ADR-054 §3: "正在读取" while it
 * runs, "读取" once done). A verb the program already wrote ("Read", "修改", "terminal:") is not repeated, and backticks
 * around a command are dropped. A sub-agent call and a kind without a verb keep the title as it is.
 */
export function stepLabel(tool: Pick<Tool, "kind" | "title">, nested = false): StepLabel {
  const verbs = nested || tool.kind === undefined ? undefined : VERBS[tool.kind];
  if (!verbs) return { verb: null, running: null, target: tool.title };
  const title = tool.title.trim(), stripped = verbs.prefix ? title.replace(verbs.prefix, "").trim() : title;
  const target = (stripped || title).replace(/^`([^`]+)`$/u, "$1");
  const verb = tool.kind === "edit" && CREATE.test(title) ? "新建" : verbs.verb;
  return { verb, running: "正在" + verb, target: verbs.path ? shortPath(target) : target };
}
/** The label of a group of consecutive reads, with the files' names joined as the board shows them. */
export function readsLabel(tools: readonly Pick<Tool, "kind" | "title">[]): StepLabel {
  return { verb: `读取 ${tools.length} 个文件`, running: `正在读取 ${tools.length} 个文件`, target: tools.map(tool => stepLabel(tool).target).join(" · ") };
}

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
    if (/^(index |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/u.test(line)) { file.created ||= line.startsWith("new file mode"); file.lines.push({ kind: "meta", text: line }); continue; }
    file.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}
/** Lines added and removed across a tool's diff, and whether every file in it is new: what its step shows beside it. */
export function diffTotals(files: readonly DiffFile[]): { readonly add: number; readonly del: number; readonly created: boolean } {
  return { add: files.reduce((sum, file) => sum + file.add, 0), del: files.reduce((sum, file) => sum + file.del, 0), created: files.length > 0 && files.every(file => file.created) };
}
/** Tools of a Turn that edited files and carry stored detail, in call order. */
export function editTools(run: Pick<PublicRun, "tools">): readonly Tool[] {
  return (run.tools ?? []).filter(tool => (tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move") && tool.detail !== undefined);
}
/** How long a finished Run took, from the input being accepted to its final status; null without both facts. */
export function runDuration(run: Pick<PublicRun, "timing">): number | null {
  const timing = run.timing;
  return timing?.endedAt === undefined ? null : timing.endedAt - timing.acceptedAt;
}
/**
 * The time a finished Turn took, in the words of the timer that counted it while it ran (Motion board #03): one decimal
 * under ten seconds ("3.6 秒"), then whole seconds as the timer last showed them ("42 秒", "1 分 05 秒"). Both are cut,
 * never rounded up, so the total never reads more than the timer could have shown.
 */
export function spentText(milliseconds: number): string {
  return milliseconds < 10_000 ? (Math.floor(Math.max(0, milliseconds) / 100) / 10).toFixed(1) + " 秒" : elapsed(milliseconds);
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
 * What the reader has already been shown of each Turn on this page, kept when the page draws a Turn again in another
 * place (the conversation moves a Turn once its reply begins): a Turn shown before is not news, and the record of the
 * steps it showed carries over, so nothing comes in twice. At most 500 Turns are remembered; a forgotten one is drawn
 * as history. Read during render, recorded from a layout effect.
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
      // Never between the two halves of a character outside the basic plane.
      const unit = state.text.charCodeAt(to - 1);
      if (to < state.text.length && unit >= 0xD800 && unit <= 0xDBFF) to++;
      return { ...state, rate, shown: to, chunks: [...state.chunks, { from: state.shown, to }] };
    }
    case "flush": return state.shown < state.text.length || state.chunks.length ? { ...state, shown: state.text.length, chunks: [] } : state;
    case "settle": return state.chunks.length ? { ...state, chunks: [] } : state;
  }
}
