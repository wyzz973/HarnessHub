import type { ContentRef } from "../../../contracts/content.js";
import { SessionError, type PublicRun, type PublicTool, type RunId, type SessionSnapshot } from "../../../contracts/session.js";
import {
  TABLE_LIMITS, TABLE_PARTS, TABLE_TOOL_PARTS,
  type TablePart, type TableSearchHit, type TableSearchView, type TableSearchWhere, type TableTurnLine, type TableTurnRead, type TableTurnsView,
} from "../../../contracts/table.js";
import { normalize } from "./relay/escape.js";
import { changesOf, kindOf, parseToolDetail, withoutThinking, type FileChange, type RelayToolDetail } from "./relay/narration.js";
import { namesCredentialFile, relayRedactor, restoreLabels } from "./relay/redaction.js";

/**
 * The context table's read model (docs/decisions/LOG.md, 2026-11-11): what a conversation holds, as a Harness may read it back
 * for itself — a directory of the Turns, one Turn in full and in pieces, a search over all of it. Everything is derived from
 * the committed snapshot and from the tool details the caller read; nothing is decided here and nothing is read from a disk.
 *
 * What it never gives: the reasoning of a Turn (`thinking`, inline `<think>` blocks, the tools of kind think). What it always
 * does: every text is cleaned of terminal control sequences and has its secrets hidden (the relay's redaction, relay/redaction.ts)
 * as a whole before it is cut or paged, so a cut never leaves part of a secret. The output of a tool call that touches a
 * credential file (the relay's rule, ADR-055 §10.1) is withheld. Pure.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------------------

/** How a text is made fit to leave: cleaned (`clean`), then its secrets hidden (`hide`); `redact` is both. `output` also hides credential-named assignments. */
export interface TableRedaction {
  clean(text: string, kind: "text" | "output"): string;
  hide(clean: string, kind: "text" | "output"): string;
  redact(text: string, kind: "text" | "output"): string;
}
/** The relay's redaction with these known secret values (plus its shape rules), labelled in English. */
export function tableRedaction(secrets: readonly string[]): TableRedaction {
  const redactor = relayRedactor(secrets);
  const clean = (text: string, kind: "text" | "output") => normalize(text, kind);
  const hide = (text: string, kind: "text" | "output") => restoreLabels(redactor.redact(text, kind).text, "en");
  return { clean, hide, redact: (text, kind) => hide(clean(text, kind), kind) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool details
// ---------------------------------------------------------------------------------------------------------------------

/** A stored tool detail as read back: the relay's view of it, and whether the Hub cut it to its byte budget when it stored it. */
export interface TableToolDetail extends RelayToolDetail { readonly truncated?: true }
/** The details a caller read, by `runId + "/" + toolId`; a tool whose detail is absent was not stored, or not read. */
export type TableDetails = ReadonlyMap<string, TableToolDetail>;
export function detailKey(runId: string, toolId: string): string { return runId + "/" + toolId; }
/** A stored detail (the JSON the Runtime keeps for a tool, read back as `unknown`); null when it is not an object. */
export function parseTableDetail(value: unknown): TableToolDetail | null {
  const detail = parseToolDetail(value);
  if (detail === null) return null;
  return (value as Readonly<Record<string, unknown>>).truncated === true ? { ...detail, truncated: true } : detail;
}

/** A tool detail a request needs: the Run and tool it belongs to, and the stored content to read. */
export interface TableToolRef { readonly runId: RunId; readonly toolId: string; readonly ref: ContentRef }
function refsOf(run: PublicRun, accept: (tool: PublicTool) => boolean): TableToolRef[] {
  return (run.tools ?? []).flatMap(tool => tool.detail !== undefined && kindOf(tool) !== "think" && accept(tool) ? [{ runId: run.id, toolId: tool.id, ref: tool.detail }] : []);
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff, isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function fold(text: string): string { return text.replace(/\s+/gu, " ").trim(); }
/** The first `max` characters (code points) of a text, with … when it was longer. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let units = 0, seen = 0;
  while (units < text.length && seen < max) { units += text.codePointAt(units)! > 0xffff ? 2 : 1; seen++; }
  return units >= text.length ? text : text.slice(0, units) + "…";
}
/** A count from a request: the number when it is a whole one, else the fallback. */
function whole(value: number | undefined, fallback: number): number { return value !== undefined && Number.isInteger(value) ? value : fallback; }
function size(bytes: number): string { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB"; }
function plural(count: number, one: string, many = one + "s"): string { return count + " " + (count === 1 ? one : many); }
const MODEL = /^[A-Za-z0-9._:/-]{1,128}$/u;
function modelOf(run: PublicRun): string | undefined { const model = run.selection.nativeModel; return model !== undefined && MODEL.test(model) ? model : undefined; }
function runAt(state: SessionSnapshot, n: number): PublicRun {
  const run = Number.isInteger(n) && n >= 1 ? state.runs[n - 1] : undefined;
  if (run === undefined) throw new SessionError("TABLE_TURN_NOT_FOUND", state.runs.length === 0 ? "This conversation has no turns yet."
    : "There is no turn " + (Number.isInteger(n) ? n : "like that") + "; this conversation has " + plural(state.runs.length, "turn") + " (1-" + state.runs.length + ").");
  return run;
}
/** The replies of a conversation by message, so that reading many Turns reads the messages once. */
function repliesOf(state: SessionSnapshot): ReadonlyMap<string, string> {
  return new Map(state.messages.filter(message => message.role === "assistant").map(message => [message.id as string, message.text]));
}
/** The reply of a Turn without the reasoning an inline `<think>` block holds. */
function replyOf(replies: ReadonlyMap<string, string>, run: PublicRun): string { return withoutThinking(replies.get(run.assistantMessageId) ?? ""); }

/** One page of a text from `offset`, `limit` characters at most, ending at a line when it can and never inside a surrogate pair. */
export function pageOf(text: string, offset: number, limit: number): { readonly text: string; readonly offset: number; readonly end: number; readonly size: number } {
  const total = text.length;
  let start = Math.min(Math.max(0, offset), total);
  if (start > 0 && start < total && isLow(text.charCodeAt(start))) start--;
  let end = Math.min(total, start + Math.max(1, limit));
  if (end < total) {
    const line = text.lastIndexOf("\n", end - 1);
    if (line >= start + Math.floor(limit / 2)) end = line + 1;
    else if (end > start && isHigh(text.charCodeAt(end - 1))) end--;
    if (end <= start) end = Math.min(total, start + (isHigh(text.charCodeAt(start)) ? 2 : 1));
  }
  return { text: text.slice(start, end), offset: start, end, size: total };
}

// ---------------------------------------------------------------------------------------------------------------------
// The tool calls of a Turn
// ---------------------------------------------------------------------------------------------------------------------

/** One tool call of a Turn as the table numbers it: from 1, in order, without the reasoning (kind think); `parent` is the number of the tool call it ran inside. */
interface ToolFacts { readonly k: number; readonly tool: PublicTool; readonly parent: number | null }
function toolsOf(run: PublicRun): readonly ToolFacts[] {
  const listed = (run.tools ?? []).filter(tool => kindOf(tool) !== "think"), numbers = new Map(listed.map((tool, index) => [tool.id, index + 1]));
  return listed.map((tool, index) => ({ k: index + 1, tool, parent: tool.parentId === undefined ? null : numbers.get(tool.parentId) ?? null }));
}
/** Whether a tool call touches a credential file, so that what it read or wrote is not given out (the relay's rule, ADR-055 §10.1). */
function withheld(tool: PublicTool, detail: TableToolDetail | undefined): boolean {
  const candidates = kindOf(tool) === "execute" ? [detail?.input ?? tool.title] : [tool.title, ...(detail?.locations ?? [])];
  return candidates.some(candidate => namesCredentialFile(candidate));
}
const WITHHELD = "Withheld: this tool call touches a credential file, so what it read or wrote is not shown.";

function toolLine(facts: ToolFacts, redaction: TableRedaction): string {
  const { tool } = facts;
  const status = tool.status + (tool.exitCode === undefined ? "" : ", exit " + tool.exitCode);
  return ["#" + facts.k + (facts.parent === null ? "" : " (inside #" + facts.parent + ")"), tool.kind ?? "other", ...(tool.name === undefined ? [] : [redaction.redact(tool.name, "text")]),
    clip(fold(redaction.redact(tool.title, "text")), 160), status, tool.detail === undefined ? "no stored detail" : "detail " + size(tool.detail.bytes)].join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------------

/** One file a Turn's changes touched: how (in order of first appearance), how many changes, and the lines added and removed when every change said. */
interface TableFile { readonly path: string; readonly ops: readonly FileChange["op"][]; readonly changes: number; readonly added: number | null; readonly removed: number | null }
/** A path inside the workspace without the workspace's own path in front of it; any other path as it is. */
function inside(workspace: string, path: string): string {
  const prefix = workspace.endsWith("/") ? workspace : workspace + "/";
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path;
}
/** The files a Turn's change tools touched, from the details read; the change tools whose files could not be told are `unread`. */
function filesOf(run: PublicRun, details: TableDetails, workspace: string): { readonly files: readonly TableFile[]; readonly unread: readonly PublicTool[] } {
  const own = new Map<string, TableToolDetail>();
  for (const tool of run.tools ?? []) { const detail = details.get(detailKey(run.id, tool.id)); if (detail !== undefined) own.set(tool.id, detail); }
  const rows = new Map<string, { ops: FileChange["op"][]; changes: number; added: number; removed: number; counted: boolean }>(), unread: PublicTool[] = [];
  for (const tool of run.tools ?? []) {
    if (kindOf(tool) !== "change") continue;
    const changes = changesOf({ details: own }, tool);
    if (changes === null) { unread.push(tool); continue; }
    for (const change of changes) {
      const path = inside(workspace, change.path), row = rows.get(path) ?? { ops: [], changes: 0, added: 0, removed: 0, counted: true };
      rows.set(path, row);
      if (!row.ops.includes(change.op)) row.ops.push(change.op);
      row.changes++;
      if (change.added === null || change.removed === null) row.counted = false; else { row.added += change.added; row.removed += change.removed; }
    }
  }
  return { files: [...rows.entries()].map(([path, row]) => ({ path, ops: row.ops, changes: row.changes, added: row.counted ? row.added : null, removed: row.counted ? row.removed : null })), unread };
}
const OPS: Readonly<Record<FileChange["op"], string>> = { create: "created", edit: "edited", delete: "deleted", move: "moved" };
function fileLine(file: TableFile, redaction: TableRedaction): string {
  return "- " + clip(redaction.redact(file.path, "text"), 240) + " — " + file.ops.map(op => OPS[op]).join(", ") + (file.changes > 1 ? " (" + file.changes + " changes)" : "")
    + (file.added === null || file.removed === null || file.added + file.removed === 0 ? "" : " (+" + file.added + " -" + file.removed + ")");
}
/** The sections the files of a Turn are told in: the files, then the changes whose files could not be read (by title). */
function filesSections(run: PublicRun, details: TableDetails, redaction: TableRedaction, workspace: string): readonly { readonly title: string; readonly lines: readonly string[] }[] {
  const { files, unread } = filesOf(run, details, workspace);
  return [...(files.length ? [{ title: "Files changed (" + files.length + ")", lines: files.map(file => fileLine(file, redaction)) }] : []),
    ...(unread.length ? [{ title: "Changes whose files could not be read (" + unread.length + "), by title", lines: unread.map(tool => "- " + clip(fold(redaction.redact(tool.title, "text")), 160)) }] : [])];
}
function filesText(run: PublicRun, details: TableDetails, redaction: TableRedaction, workspace: string): string {
  return filesSections(run, details, redaction, workspace).map(section => section.title + ":\n" + section.lines.join("\n")).join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------------------------------------------------

/** The window of Turns a directory request lists: `limit` from `from` (the latest Turns when `from` is absent), within the conversation. */
export function directoryRange(state: SessionSnapshot, from: number | undefined, limit: number | undefined): { readonly from: number; readonly to: number } {
  const total = state.runs.length, count = Math.min(Math.max(1, whole(limit, TABLE_LIMITS.turnsDefault)), TABLE_LIMITS.turnsMax);
  const first = from === undefined ? Math.max(1, total - count + 1) : Math.max(1, whole(from, 1));
  return { from: first, to: first > total ? first - 1 : Math.min(total, first + count - 1) };
}
/** The details the directory needs for the Turns `from`..`to`: the change tools' (their files are counted). */
export function directoryNeeds(state: SessionSnapshot, from: number, to: number): readonly TableToolRef[] {
  return state.runs.slice(Math.max(0, from - 1), Math.max(0, to)).flatMap(run => refsOf(run, tool => kindOf(tool) === "change"));
}
/** How many characters of a Turn's words and reply a directory line shows. The whole text is redacted first and cut after, so a cut never leaves part of a secret. */
const LINE_CHARS = 80;
function shown(redaction: TableRedaction, text: string): string { return clip(fold(redaction.redact(text, "text").slice(0, LINE_CHARS * 4)), LINE_CHARS); }

export function turnsView(state: SessionSnapshot, from: number | undefined, limit: number | undefined, details: TableDetails, redaction: TableRedaction): TableTurnsView {
  const range = directoryRange(state, from, limit), replies = repliesOf(state), lines: TableTurnLine[] = [];
  for (let n = range.from; n <= range.to; n++) {
    const run = state.runs[n - 1]!, model = modelOf(run), { files, unread } = filesOf(run, details, state.configuration.workspace);
    lines.push({ n, harnessId: run.selection.harnessId, status: run.status, user: shown(redaction, run.input), reply: shown(redaction, replyOf(replies, run)),
      tools: toolsOf(run).length, files: files.length + unread.length, ...(model === undefined ? {} : { model }), ...(unread.length ? { filesApprox: true as const } : {}) });
  }
  const active = state.activeRunId === null ? 0 : state.runs.findIndex(run => run.id === state.activeRunId) + 1;
  return { total: state.runs.length, from: range.from, to: range.to, lines, ...(active > 0 ? { active } : {}),
    ...(state.origin === undefined ? {} : { origin: { kind: state.origin.kind, messages: state.origin.history.length } }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// One Turn
// ---------------------------------------------------------------------------------------------------------------------

export interface TableReadQuery {
  /** What to read; the overview when absent. */
  readonly part?: TablePart;
  /** The tool call (its number in the `tools` part) that `input`, `output` and `diff` read. */
  readonly tool?: number;
  /** The first character of the page, in the part's redacted text. */
  readonly offset?: number;
  /** The most characters of the page. */
  readonly limit?: number;
}
/** The details reading `part` of Turn `n` needs: the Turn's change tools' for the overview and the files, the one tool's for `input`, `output` and `diff`. */
export function turnNeeds(state: SessionSnapshot, n: number, part: TablePart | undefined, tool: number | undefined): readonly TableToolRef[] {
  const run = runAt(state, n);
  if ((TABLE_TOOL_PARTS as readonly string[]).includes(part ?? "")) {
    const facts = toolsOf(run).find(item => item.k === tool);
    return facts?.tool.detail === undefined ? [] : [{ runId: run.id, toolId: facts.tool.id, ref: facts.tool.detail }];
  }
  return part === undefined || part === "overview" || part === "files" ? refsOf(run, item => kindOf(item) === "change") : [];
}

/** How much of each piece the overview gives before it says where the rest is. */
const OVERVIEW = { user: 2500, reply: 4000, tools: 40, files: 30, plan: 30 } as const;
function planText(run: PublicRun, redaction: TableRedaction): string {
  if (run.plan === undefined || (run.plan.entries.length === 0 && !run.plan.explanation)) return "";
  const mark = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return [...(run.plan.explanation ? [clip(fold(redaction.redact(run.plan.explanation, "text")), 400)] : []),
    ...run.plan.entries.map(entry => mark[entry.status] + " " + clip(fold(redaction.redact(entry.content, "text")), 240) + (entry.priority === undefined ? "" : " (" + entry.priority + ")"))].join("\n");
}
function userText(run: PublicRun, redaction: TableRedaction): string {
  const attachments = (run.attachments ?? []).map(item => "- " + clip(redaction.redact(item.name, "text"), 120) + " (" + item.mediaType + ", " + size(item.bytes) + ")");
  return redaction.redact(run.input, "text") + (attachments.length ? "\n\nAttachments (names only; their bytes are not available here):\n" + attachments.join("\n") : "");
}

/** A piece of a long text for the overview: the first `max` characters ending at a line when it can, and where the rest is read. */
function piece(text: string, max: number, part: "user" | "reply"): string {
  if (text.length <= max) return text === "" ? "(empty)" : text;
  const head = pageOf(text, 0, max);
  return head.text.replace(/\n+$/u, "") + "\n[continues: part=" + part + " offset=" + head.end + "; " + (text.length - head.end) + " more characters]";
}
function overview(state: SessionSnapshot, n: number, run: PublicRun, replies: ReadonlyMap<string, string>, details: TableDetails, redaction: TableRedaction): string {
  const model = modelOf(run), head = ["Turn " + n + " of " + state.runs.length + " · " + run.selection.harnessId + (model === undefined ? "" : " (" + model + ")") + " · " + run.status];
  if (run.error !== null) head.push("Error " + clip(fold(redaction.redact(run.error.code, "text")), 64) + ": " + clip(fold(redaction.redact(run.error.message, "text")), 400));
  const sections = [head.join("\n"), "## The user's words\n" + piece(userText(run, redaction), OVERVIEW.user, "user")];
  const reply = redaction.redact(replyOf(replies, run), "text");
  sections.push("## The reply" + (reply === "" ? "" : " (" + reply.length + " characters)") + "\n" + (reply === "" ? "(none)" : piece(reply, OVERVIEW.reply, "reply")));
  const tools = toolsOf(run);
  if (tools.length) {
    const lines = tools.map(facts => toolLine(facts, redaction)), shownLines = lines.slice(0, OVERVIEW.tools);
    sections.push("## Tool calls (" + tools.length + "; read one's input, output or diff with part and tool)\n" + shownLines.join("\n")
      + (lines.length > shownLines.length ? "\n[" + (lines.length - shownLines.length) + " more: part=tools offset=" + (shownLines.join("\n").length + 1) + "]" : ""));
  }
  for (const section of filesSections(run, details, redaction, state.configuration.workspace))
    sections.push("## " + section.title + "\n" + section.lines.slice(0, OVERVIEW.files).join("\n") + (section.lines.length > OVERVIEW.files ? "\n[" + (section.lines.length - OVERVIEW.files) + " more: part=files]" : ""));
  const plan = planText(run, redaction);
  if (plan !== "") sections.push("## The plan\n" + plan.split("\n").slice(0, OVERVIEW.plan + 1).join("\n") + (plan.split("\n").length > OVERVIEW.plan + 1 ? "\n[more: part=plan]" : ""));
  return sections.join("\n\n");
}

/** Reads one Turn, or one piece of it, as one page; throws SessionError (TABLE_TURN_NOT_FOUND, TABLE_TOOL_NOT_FOUND, TABLE_DETAIL_UNAVAILABLE, INVALID_INPUT). */
export function readTurn(state: SessionSnapshot, n: number, query: TableReadQuery, details: TableDetails, redaction: TableRedaction): TableTurnRead {
  const run = runAt(state, n), part = query.part ?? "overview", model = modelOf(run);
  if (!(TABLE_PARTS as readonly string[]).includes(part)) throw new SessionError("INVALID_INPUT", "part must be one of " + TABLE_PARTS.join(", "));
  const base = { n, total: state.runs.length, harnessId: run.selection.harnessId, status: run.status, ...(model === undefined ? {} : { model }), part };
  const limit = Math.min(Math.max(1, whole(query.limit, TABLE_LIMITS.pageDefault)), TABLE_LIMITS.pageMax), offset = Math.max(0, whole(query.offset, 0));
  const notes: string[] = [];
  let text: string, tool: number | undefined;
  switch (part) {
    case "overview": {
      text = overview(state, n, run, repliesOf(state), details, redaction);
      return { ...base, text, offset: 0, end: text.length, size: text.length };
    }
    case "user": text = userText(run, redaction); break;
    case "reply": text = redaction.redact(replyOf(repliesOf(state), run), "text"); break;
    case "tools": text = toolsOf(run).map(facts => toolLine(facts, redaction)).join("\n"); break;
    case "files": {
      text = filesText(run, details, redaction, state.configuration.workspace);
      if (text === "") text = "(this turn changed no files)";
      break;
    }
    case "plan": text = planText(run, redaction) || "(this turn recorded no plan)"; break;
    case "input": case "output": case "diff": {
      const all = toolsOf(run);
      if (query.tool === undefined || !Number.isInteger(query.tool) || query.tool < 1) throw new SessionError("INVALID_INPUT", "part " + part + " needs tool: the number of a tool call of this turn (see part tools)");
      const facts = all.find(item => item.k === query.tool);
      if (facts === undefined) throw new SessionError("TABLE_TOOL_NOT_FOUND", "Turn " + n + " has " + plural(all.length, "tool call") + (all.length ? " (1-" + all.length + ")" : "") + "; there is no tool " + query.tool + ".");
      tool = facts.k;
      if (facts.tool.detail === undefined) throw new SessionError("TABLE_DETAIL_UNAVAILABLE", "Tool " + facts.k + " of turn " + n + " has no stored detail (it may still be running, or none was stored).");
      const detail = details.get(detailKey(run.id, facts.tool.id));
      if (detail === undefined) throw new SessionError("TABLE_DETAIL_UNAVAILABLE", "The stored detail of tool " + facts.k + " of turn " + n + " could not be read.");
      const value = part === "input" ? detail.input : part === "output" ? detail.output : detail.diff;
      if (part !== "input" && withheld(facts.tool, detail)) text = WITHHELD;
      else if (value === undefined || value === "") text = "(this tool call recorded no " + part + ")";
      else {
        text = redaction.redact(value, part === "input" ? "text" : "output");
        if (detail.truncated === true) notes.push("The Hub cut this tool call's stored detail to its size limits (an output keeps its last 64 KiB, an input its first 16 KiB, a diff its first 64 KiB), so this " + part + " may be incomplete.");
      }
      break;
    }
  }
  const slice = pageOf(text, offset, limit);
  return { ...base, ...(tool === undefined ? {} : { tool }), text: slice.text, offset: slice.offset, end: slice.end, size: slice.size, ...(notes.length ? { notes } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------------------------------

/** The details a search reads, the newest Turn's first: every tool call's stored detail. */
export function searchNeeds(state: SessionSnapshot): readonly TableToolRef[] {
  return [...state.runs].reverse().flatMap(run => refsOf(run, () => true));
}
const SNIPPET = { before: 60, after: 100 } as const;
function excerpt(text: string, at: number, length: number): string {
  let from = Math.max(0, at - SNIPPET.before), to = Math.min(text.length, at + length + SNIPPET.after);
  if (from > 0 && isLow(text.charCodeAt(from))) from--;
  if (to < text.length && isHigh(text.charCodeAt(to - 1))) to--;
  return (from > 0 ? "…" : "") + fold(text.slice(from, to)) + (to < text.length ? "…" : "");
}

/**
 * Finds `query` (a word or phrase, any case) in the user's words, the replies, the tool calls' titles and, for the details read,
 * their inputs, outputs and diffs; newest Turn first. A place counts only when the match is still there once the text is
 * redacted, so a search never confirms a hidden secret. `unread` is how many tool details the caller could not read; with the
 * outputs withheld they make `unsearched`.
 */
export function searchTurns(state: SessionSnapshot, query: string, limit: number | undefined, details: TableDetails, redaction: TableRedaction, unread: number): TableSearchView {
  const words = query.trim();
  if (words === "" || words.length > TABLE_LIMITS.queryMax) throw new SessionError("INVALID_INPUT", "the search words must be 1 to " + TABLE_LIMITS.queryMax + " characters");
  const source = words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), probe = new RegExp(source, "iu"), every = new RegExp(source, "giu");
  const most = Math.min(Math.max(1, whole(limit, TABLE_LIMITS.searchDefault)), TABLE_LIMITS.searchMax), replies = repliesOf(state), hits: TableSearchHit[] = [];
  let total = 0, kept = 0;
  const look = (n: number, where: TableSearchWhere, tool: number | undefined, raw: string, kind: "text" | "output"): void => {
    const clean = redaction.clean(raw, kind);
    if (!probe.test(clean)) return;
    const text = redaction.hide(clean, kind);
    let at = -1, matches = 0;
    for (const found of text.matchAll(every)) { if (at < 0) at = found.index; if (++matches >= 99) break; }
    if (at < 0) return;
    total++;
    if (hits.length < most) hits.push({ n, where, ...(tool === undefined ? {} : { tool }), at, matches, snippet: excerpt(text, at, words.length) });
  };
  for (let n = state.runs.length; n >= 1; n--) {
    const run = state.runs[n - 1]!;
    look(n, "user", undefined, run.input, "text");
    look(n, "reply", undefined, replyOf(replies, run), "text");
    for (const facts of toolsOf(run)) {
      look(n, "tool", facts.k, facts.tool.title, "text");
      const detail = details.get(detailKey(run.id, facts.tool.id));
      if (detail === undefined) continue;
      if (detail.input !== undefined) look(n, "input", facts.k, detail.input, "text");
      if (detail.output !== undefined || detail.diff !== undefined) {
        if (withheld(facts.tool, detail)) { kept++; continue; }
        if (detail.output !== undefined) look(n, "output", facts.k, detail.output, "output");
        if (detail.diff !== undefined) look(n, "diff", facts.k, detail.diff, "output");
      }
    }
  }
  return { query: words, total, hits, turns: state.runs.length, unsearched: unread + kept };
}
