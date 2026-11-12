import type { ContentRef } from "../../../contracts/content.js";
import { SessionError, type PublicRun, type PublicTool, type RunId, type SessionId, type SessionSnapshot } from "../../../contracts/session.js";
import {
  TABLE_LIMITS, TABLE_PARTS, TABLE_TOOL_PARTS,
  type TablePart, type TableSearchHit, type TableSearchView, type TableSearchWhere, type TableTurnLine, type TableTurnRead, type TableTurnsView,
} from "../../../contracts/table.js";
import { normalize } from "./relay/escape.js";
import { changesOf, kindOf, parseToolDetail, withoutThinking, type FileChange, type RelayToolDetail } from "./relay/narration.js";
import { namesCredentialFile, relayRedactor, restoreLabels } from "./relay/redaction.js";
import type { DetailPolicy, DetailRead } from "./detail-read.js";
import type { ConversationReader } from "../../../contracts/conversation.js";
import { snapshotTurns, turnSource, type TurnRecord, type TurnSource } from "./turn-source.js";

/**
 * The context table's read model (docs/decisions/LOG.md, 2026-11-11): what a conversation holds, as a Harness may read it back
 * for itself — a directory of the Turns, one Turn in full and in pieces, a search over all of it. Everything is derived from
 * the Turns the caller reads (one at a time, only the ones a request needs) and from the tool details it read; nothing is decided
 * here and nothing is read from a disk.
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

/**
 * A stored tool detail as read back: the relay's view of it, and whether the Hub cut it to its byte budget when it stored it. A text the reader kept only the ends of (`cuts`) is its head, a
 * line saying how much was not read, and its tail, so that a page of it and a search of it are over what was read, and the answer says so.
 */
export interface TableToolDetail extends RelayToolDetail { readonly truncated?: true; readonly cuts?: Readonly<Partial<Record<"input" | "output" | "diff", DetailCut>>> }
/** How long a text was, and how many of its characters the reader did not keep. */
export interface DetailCut { readonly chars: number; readonly omitted: number }
/** The line that stands where the middle of a text is not shown. */
export const omittedLine = (omitted: number): string => "\n[… " + omitted + " characters not read …]\n";
function tableText(text: DetailRead["input"]): { readonly text: string; readonly cut?: DetailCut } | undefined {
  if (text === undefined) return undefined;
  if (!text.cut) return { text: text.text };
  const omitted = Math.max(0, text.chars - text.head.length - text.tail.length);
  return { text: text.head + omittedLine(omitted) + text.tail, cut: { chars: text.chars, omitted } };
}
/** A detail as read, in the table's terms. */
export function tableDetailOf(read: DetailRead): TableToolDetail {
  const input = tableText(read.input), output = tableText(read.output), diff = tableText(read.diff);
  const cuts = { ...(input?.cut === undefined ? {} : { input: input.cut }), ...(output?.cut === undefined ? {} : { output: output.cut }), ...(diff?.cut === undefined ? {} : { diff: diff.cut }) };
  return { ...(input === undefined ? {} : { input: input.text }), ...(output === undefined ? {} : { output: output.text }), ...(diff === undefined ? {} : { diff: diff.text }),
    ...(read.locations === undefined ? {} : { locations: read.locations }), ...(read.truncated === true ? { truncated: true as const } : {}), ...(Object.keys(cuts).length ? { cuts } : {}) };
}
/**
 * What the table keeps of a stored detail, by what is asked: to count the files a Turn changed (the directory, the overview, the files) the command, the paths and the diff; to read one
 * text of one call (`input`, `output`, `diff`) that text up to 64 MiB and else its first and last MiB; to search, every text up to 8 MiB and else its first and last 256 KiB. Never "too large, not read".
 */
export type TableDetailUse = "files" | "input" | "output" | "diff" | "search";
const MIB = 1024 * 1024, SKIP = { whole: 0, head: 0, tail: 0 } as const;
export function tableDetailPolicy(use: TableDetailUse): DetailPolicy {
  const base: DetailPolicy = { input: { whole: MIB, head: MIB, tail: 0 }, output: SKIP, diff: { whole: 16 * MIB, head: 0, tail: 0 } };
  switch (use) {
    case "files": return base;
    case "input": return { ...base, input: { whole: 64 * MIB, head: MIB, tail: MIB } };
    case "output": return { ...base, output: { whole: 64 * MIB, head: MIB, tail: MIB } };
    case "diff": return { ...base, diff: { whole: 64 * MIB, head: MIB, tail: MIB } };
    case "search": return { input: { whole: 8 * MIB, head: 256 * 1024, tail: 256 * 1024 }, output: { whole: 8 * MIB, head: 256 * 1024, tail: 256 * 1024 }, diff: { whole: 8 * MIB, head: 256 * 1024, tail: 256 * 1024 } };
  }
}
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
/**
 * What the table reads of a conversation: a few facts of its head, and its Turns, which are read one at a time and only when a request asks for one (a directory of forty Turns reads forty,
 * a search reads as many as it goes through to fill its page).
 */
export interface TableConversation {
  readonly id: SessionId;
  readonly workspace: string;
  readonly activeRunId: RunId | null;
  /** The earlier history the conversation began from, which the Turns do not include. */
  readonly origin?: { readonly kind: "fork" | "import"; readonly messages: number };
  readonly turns: TurnSource;
  /** The Harnesses the conversation has run on, whose secrets the table hides. */
  harnessIds(): readonly string[];
}
/** A conversation kept as rows, as the table reads it: its head now, its Turns when asked for. */
export function rowsTable(reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory" | "harnessIds">, id: SessionId): TableConversation {
  const head = reader.head(id), origin = head.head.origin;
  // A branch that refers to its source instead of quoting it has no history of its own to count.
  const quoted = origin !== undefined && (origin.kind === "import" || origin.quoted);
  return { id, workspace: head.head.configuration.workspace, activeRunId: head.activeRunId, turns: turnSource(reader, id), harnessIds: () => reader.harnessIds?.(id) ?? [head.head.selection.harnessId],
    ...(quoted ? { origin: { kind: origin.kind, messages: reader.originHistory?.(id).length ?? 0 } } : {}) };
}
/** A conversation in the old whole shape as the table's: for a caller that has the snapshot already. Nothing is read, and no Turn is `legacyOrder` (the old shape does not say). */
export function snapshotTable(state: SessionSnapshot): TableConversation {
  return { id: state.id, workspace: state.configuration.workspace, activeRunId: state.activeRunId, turns: snapshotTurns(state), harnessIds: () => [...new Set(state.runs.map(run => run.selection.harnessId))].sort(),
    ...(state.origin === undefined ? {} : { origin: { kind: state.origin.kind, messages: state.origin.history.length } }) };
}
/** What the table's functions take: the conversation as the table reads it, or the old whole shape of one (read through `snapshotTable`). */
export type TableState = TableConversation | SessionSnapshot;
function conversationOf(state: TableState): TableConversation { return "turns" in state ? state : snapshotTable(state); }
function turnAt(table: TableConversation, n: number): TurnRecord {
  const turn = Number.isInteger(n) && n >= 1 ? table.turns.turn(n - 1) : null, total = table.turns.count;
  if (turn === null) throw new SessionError("TABLE_TURN_NOT_FOUND", total === 0 ? "This conversation has no turns yet."
    : "There is no turn " + (Number.isInteger(n) ? n : "like that") + "; this conversation has " + plural(total, "turn") + " (1-" + total + ").");
  return turn;
}
/** The reply of a Turn without the reasoning an inline `<think>` block holds. */
function replyOf(turn: TurnRecord): string { return withoutThinking(turn.assistant?.text ?? ""); }
/** What a Turn from before the Hub kept the order things happened in is told with: its parts stand in a fixed arrangement. */
export const LEGACY_ORDER_NOTE = "The order of this turn is a fixed arrangement, not the order of occurrence.";

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
export function directoryRange(state: TableState, from: number | undefined, limit: number | undefined): { readonly from: number; readonly to: number } {
  const total = conversationOf(state).turns.count, count = Math.min(Math.max(1, whole(limit, TABLE_LIMITS.turnsDefault)), TABLE_LIMITS.turnsMax);
  const first = from === undefined ? Math.max(1, total - count + 1) : Math.max(1, whole(from, 1));
  return { from: first, to: first > total ? first - 1 : Math.min(total, first + count - 1) };
}
/** The details the directory needs for the Turns `from`..`to`: the change tools' (their files are counted). */
export function directoryNeeds(state: TableState, from: number, to: number): readonly TableToolRef[] {
  const table = conversationOf(state), refs: TableToolRef[] = [];
  for (let n = Math.max(1, from); n <= Math.min(to, table.turns.count); n++) refs.push(...refsOf(table.turns.turn(n - 1)!.run, tool => kindOf(tool) === "change"));
  return refs;
}
/** How many characters of a Turn's words and reply a directory line shows. The whole text is redacted first and cut after, so a cut never leaves part of a secret. */
const LINE_CHARS = 80;
function shown(redaction: TableRedaction, text: string): string { return clip(fold(redaction.redact(text, "text").slice(0, LINE_CHARS * 4)), LINE_CHARS); }

export function turnsView(state: TableState, from: number | undefined, limit: number | undefined, details: TableDetails, redaction: TableRedaction): TableTurnsView {
  const table = conversationOf(state), range = directoryRange(table, from, limit), lines: TableTurnLine[] = [];
  for (let n = range.from; n <= range.to; n++) {
    const turn = table.turns.turn(n - 1)!, run = turn.run, model = modelOf(run), { files, unread } = filesOf(run, details, table.workspace);
    lines.push({ n, harnessId: run.selection.harnessId, status: run.status, user: shown(redaction, run.input), reply: shown(redaction, replyOf(turn)),
      tools: toolsOf(run).length, files: files.length + unread.length, ...(model === undefined ? {} : { model }), ...(unread.length ? { filesApprox: true as const } : {}) });
  }
  const active = table.activeRunId === null ? 0 : (table.turns.ordinalOf(table.activeRunId) ?? -1) + 1;
  return { total: table.turns.count, from: range.from, to: range.to, lines, ...(active > 0 ? { active } : {}), ...(table.origin === undefined ? {} : { origin: table.origin }) };
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
export function turnNeeds(state: TableState, n: number, part: TablePart | undefined, tool: number | undefined): readonly TableToolRef[] {
  const run = turnAt(conversationOf(state), n).run;
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
function overview(table: TableConversation, n: number, turn: TurnRecord, details: TableDetails, redaction: TableRedaction): string {
  const run = turn.run, model = modelOf(run), head = ["Turn " + n + " of " + table.turns.count + " · " + run.selection.harnessId + (model === undefined ? "" : " (" + model + ")") + " · " + run.status];
  if (run.error !== null) head.push("Error " + clip(fold(redaction.redact(run.error.code, "text")), 64) + ": " + clip(fold(redaction.redact(run.error.message, "text")), 400));
  const sections = [head.join("\n"), "## The user's words\n" + piece(userText(run, redaction), OVERVIEW.user, "user")];
  const reply = redaction.redact(replyOf(turn), "text");
  sections.push("## The reply" + (reply === "" ? "" : " (" + reply.length + " characters)") + "\n" + (reply === "" ? "(none)" : piece(reply, OVERVIEW.reply, "reply")));
  const tools = toolsOf(run);
  if (tools.length) {
    const lines = tools.map(facts => toolLine(facts, redaction)), shownLines = lines.slice(0, OVERVIEW.tools);
    sections.push("## Tool calls (" + tools.length + "; read one's input, output or diff with part and tool)\n" + shownLines.join("\n")
      + (lines.length > shownLines.length ? "\n[" + (lines.length - shownLines.length) + " more: part=tools offset=" + (shownLines.join("\n").length + 1) + "]" : ""));
  }
  for (const section of filesSections(run, details, redaction, table.workspace))
    sections.push("## " + section.title + "\n" + section.lines.slice(0, OVERVIEW.files).join("\n") + (section.lines.length > OVERVIEW.files ? "\n[" + (section.lines.length - OVERVIEW.files) + " more: part=files]" : ""));
  const plan = planText(run, redaction);
  if (plan !== "") sections.push("## The plan\n" + plan.split("\n").slice(0, OVERVIEW.plan + 1).join("\n") + (plan.split("\n").length > OVERVIEW.plan + 1 ? "\n[more: part=plan]" : ""));
  return sections.join("\n\n");
}

/** Reads one Turn, or one piece of it, as one page; throws SessionError (TABLE_TURN_NOT_FOUND, TABLE_TOOL_NOT_FOUND, TABLE_DETAIL_UNAVAILABLE, INVALID_INPUT). */
export function readTurn(state: TableState, n: number, query: TableReadQuery, details: TableDetails, redaction: TableRedaction): TableTurnRead {
  const table = conversationOf(state), turn = turnAt(table, n), run = turn.run, part = query.part ?? "overview", model = modelOf(run);
  if (!(TABLE_PARTS as readonly string[]).includes(part)) throw new SessionError("INVALID_INPUT", "part must be one of " + TABLE_PARTS.join(", "));
  const base = { n, total: table.turns.count, harnessId: run.selection.harnessId, status: run.status, ...(model === undefined ? {} : { model }), part };
  const limit = Math.min(Math.max(1, whole(query.limit, TABLE_LIMITS.pageDefault)), TABLE_LIMITS.pageMax), offset = Math.max(0, whole(query.offset, 0));
  // A Turn kept from before the Hub recorded the order things happened in says so wherever its parts are listed in order: its overview, its tool calls, its files.
  const notes: string[] = turn.legacyOrder && (part === "overview" || part === "tools" || part === "files") ? [LEGACY_ORDER_NOTE] : [];
  let text: string, tool: number | undefined;
  switch (part) {
    case "overview": {
      text = overview(table, n, turn, details, redaction);
      return { ...base, text, offset: 0, end: text.length, size: text.length, ...(notes.length ? { notes } : {}) };
    }
    case "user": text = userText(run, redaction); break;
    case "reply": text = redaction.redact(replyOf(turn), "text"); break;
    case "tools": text = toolsOf(run).map(facts => toolLine(facts, redaction)).join("\n"); break;
    case "files": {
      text = filesText(run, details, redaction, table.workspace);
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
        const cut = detail.cuts?.[part];
        if (cut !== undefined) notes.push("This " + part + " is " + cut.chars + " characters long; the middle " + cut.omitted + " were not read, so the text here is its beginning and its end with a line where the rest is.");
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

/** The details a search through the whole conversation reads, the newest Turn's first: every tool call's stored detail. */
export function searchNeeds(state: TableState): readonly TableToolRef[] {
  const table = conversationOf(state), refs: TableToolRef[] = [];
  for (let n = table.turns.count; n >= 1; n--) refs.push(...refsOf(table.turns.turn(n - 1)!.run, () => true));
  return refs;
}
const SNIPPET = { before: 60, after: 100 } as const;
function excerpt(text: string, at: number, length: number): string {
  let from = Math.max(0, at - SNIPPET.before), to = Math.min(text.length, at + length + SNIPPET.after);
  if (from > 0 && isLow(text.charCodeAt(from))) from--;
  if (to < text.length && isHigh(text.charCodeAt(to - 1))) to--;
  return (from > 0 ? "…" : "") + fold(text.slice(from, to)) + (to < text.length ? "…" : "");
}

/** The words of a search, checked, and the patterns they are looked for with. */
interface Search { readonly words: string; readonly probe: RegExp; readonly every: RegExp }
function searchOf(query: string): Search {
  const words = query.trim();
  if (words === "" || words.length > TABLE_LIMITS.queryMax) throw new SessionError("INVALID_INPUT", "the search words must be 1 to " + TABLE_LIMITS.queryMax + " characters");
  const source = words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return { words, probe: new RegExp(source, "iu"), every: new RegExp(source, "giu") };
}
/**
 * The places one Turn has that match, in the order the table lists them (the user's words, the reply, then each tool call's title, input, output and diff), and how many outputs were withheld
 * (a call that touches a credential file). A place counts only when the match is still there once the text is redacted, so a search never confirms a hidden secret.
 */
function turnPlaces(n: number, turn: TurnRecord, search: Search, details: TableDetails, redaction: TableRedaction, only?: "user" | "reply"): { readonly hits: readonly TableSearchHit[]; readonly kept: number } {
  const run = turn.run, hits: TableSearchHit[] = [];
  let kept = 0;
  const look = (where: TableSearchWhere, tool: number | undefined, raw: string, kind: "text" | "output"): void => {
    const clean = redaction.clean(raw, kind);
    if (!search.probe.test(clean)) return;
    const text = redaction.hide(clean, kind);
    let at = -1, matches = 0;
    for (const found of text.matchAll(search.every)) { if (at < 0) at = found.index; if (++matches >= 99) break; }
    if (at < 0) return;
    hits.push({ n, where, ...(tool === undefined ? {} : { tool }), at, matches, snippet: excerpt(text, at, search.words.length) });
  };
  if (only !== "reply") look("user", undefined, run.input, "text");
  if (only !== "user") look("reply", undefined, replyOf(turn), "text");
  if (only !== undefined) return { hits, kept };
  for (const facts of toolsOf(run)) {
    look("tool", facts.k, facts.tool.title, "text");
    const detail = details.get(detailKey(run.id, facts.tool.id));
    if (detail === undefined) continue;
    if (detail.input !== undefined) look("input", facts.k, detail.input, "text");
    if (detail.output !== undefined || detail.diff !== undefined) {
      if (withheld(facts.tool, detail)) { kept++; continue; }
      if (detail.output !== undefined) look("output", facts.k, detail.output, "output");
      if (detail.diff !== undefined) look("diff", facts.k, detail.diff, "output");
    }
  }
  return { hits, kept };
}

/**
 * Finds `query` (a word or phrase, any case) in the user's words, the replies, the tool calls' titles and, for the details read,
 * their inputs, outputs and diffs; newest Turn first, through the whole conversation. `unread` is how many tool details the caller
 * could not read; with the outputs withheld they make `unsearched`. (The Turns are read one after the other; a request that pages
 * through a conversation is `searchPage`.)
 */
export function searchTurns(state: TableState, query: string, limit: number | undefined, details: TableDetails, redaction: TableRedaction, unread: number): TableSearchView {
  const table = conversationOf(state), search = searchOf(query), most = Math.min(Math.max(1, whole(limit, TABLE_LIMITS.searchDefault)), TABLE_LIMITS.searchMax), hits: TableSearchHit[] = [];
  let total = 0, kept = 0;
  for (let n = table.turns.count; n >= 1; n--) {
    const found = turnPlaces(n, table.turns.turn(n - 1)!, search, details, redaction);
    kept += found.kept;
    for (const hit of found.hits) { total++; if (hits.length < most) hits.push(hit); }
  }
  return { query: search.words, total, hits, turns: table.turns.count, unsearched: unread + kept };
}

/** What the full-text indexes say of one match: the item (its id is the cursor), the Turn it is in, and what kind of item it is. */
export interface WordsFound { readonly id: number; readonly ordinal: number; readonly type: string }
/** The full-text search of one conversation, newest match first, `limit` at most, from below the item `after`. */
export type WordsFinder = (words: string, scope: { readonly limit: number; readonly after?: number }) => readonly WordsFound[];
/**
 * One page of a search of the words alone — the user's and the replies, never the tool calls — found by the conversation's full-text indexes and not by reading the Turns: quick however long the
 * conversation is. A place is the same as in a search of everything (a Turn's reply is one place, over its segments joined), so the matches the indexes find are looked at again in the Turn they
 * are in and kept only if the match is still there once the text is redacted. The cursor is the last match consumed and the place it belonged to, so that a reply whose segments the page boundary
 * falls between is not told twice.
 */
export function searchWordsPage(state: TableState, query: string, options: { readonly limit?: number | undefined; readonly after?: string | undefined }, find: WordsFinder, redaction: TableRedaction): TableSearchView {
  const table = conversationOf(state), search = searchOf(query), most = Math.min(Math.max(1, whole(options.limit, TABLE_LIMITS.searchDefault)), TABLE_LIMITS.searchMax);
  const cursor = options.after === undefined ? null : /^w([0-9]{1,15})\.([0-9]{1,9})(user|reply)$/u.exec(options.after);
  if (options.after !== undefined && cursor === null) throw new SessionError("INVALID_INPUT", "after must be the cursor an earlier search gave");
  let after = cursor === null ? undefined : Number(cursor[1]), last = cursor === null ? "" : cursor[2]! + cursor[3]!;
  const hits: TableSearchHit[] = [], seen = new Set<string>(cursor === null ? [] : [last]);
  let next: string | undefined;
  for (;;) {
    const found = find(search.words, { limit: Math.max(20, most * 4), ...(after === undefined ? {} : { after }) });
    if (found.length === 0) break;
    for (const hit of found) {
      after = hit.id;
      const where = hit.type === "user_message" ? "user" as const : hit.type === "assistant_message" ? "reply" as const : null;
      if (where === null) continue;
      const key = hit.ordinal + where;
      if (seen.has(key)) continue;
      // A page that is full ends at a place's end: the matches of the place it stopped at are the cursor's.
      if (hits.length >= most) { next = "w" + (hit.id + 1) + "." + last; break; }
      seen.add(key); last = key;
      const turn = table.turns.turn(hit.ordinal);
      if (turn === null) continue;
      const place = turnPlaces(hit.ordinal + 1, turn, search, none(), redaction, where).hits[0];
      if (place !== undefined) hits.push(place);
    }
    if (next !== undefined || found.length < Math.max(20, most * 4)) break;
  }
  return { query: search.words, total: hits.length, hits, turns: table.turns.count, unsearched: 0, scope: "words", ...(next === undefined ? {} : { next }) };
}
const NO_DETAILS: TableDetails = new Map();
function none(): TableDetails { return NO_DETAILS; }

/** Where a search goes on from: the Turn to look at next (counting down) and how many of its places were given already. */
function searchStart(after: string | undefined, total: number): { readonly n: number; readonly skip: number } {
  if (after === undefined) return { n: total, skip: 0 };
  const found = /^([0-9]{1,9})\.([0-9]{1,9})$/u.exec(after);
  if (found === null) throw new SessionError("INVALID_INPUT", "after must be the cursor an earlier search gave");
  return { n: Math.min(Number(found[1]), total), skip: Number(found[2]) };
}
/** Reads the stored details a Turn's tool calls have, within the bounds of the request being answered; `unread` counts the ones that could not be. */
export type SearchLoad = (refs: readonly TableToolRef[]) => Promise<{ readonly details: TableDetails; readonly unread: number }>;
/**
 * One page of a search: the places that match, newest Turn first, `limit` of them at most, from where `after` (the cursor of the page before) says, and `next` to go on from when
 * the conversation has more. The Turns are read one at a time and the search stops reading when the page is full, so a conversation of any length is searched a page at a time.
 */
export async function searchPage(state: TableState, query: string, options: { readonly limit?: number | undefined; readonly after?: string | undefined }, load: SearchLoad, redaction: TableRedaction): Promise<TableSearchView> {
  const table = conversationOf(state), search = searchOf(query), most = Math.min(Math.max(1, whole(options.limit, TABLE_LIMITS.searchDefault)), TABLE_LIMITS.searchMax);
  const start = searchStart(options.after, table.turns.count), hits: TableSearchHit[] = [];
  let unsearched = 0, next: string | undefined;
  for (let n = start.n; n >= 1 && next === undefined; n--) {
    const turn = table.turns.turn(n - 1);
    if (turn === null) continue;
    const loaded = await load(refsOf(turn.run, () => true)), found = turnPlaces(n, turn, search, loaded.details, redaction), skip = n === start.n ? start.skip : 0;
    unsearched += loaded.unread + found.kept;
    for (const [index, hit] of found.hits.entries()) {
      if (index < skip) continue;
      if (hits.length >= most) { next = n + "." + index; break; }
      hits.push(hit);
    }
  }
  return { query: search.words, total: hits.length, hits, turns: table.turns.count, unsearched, ...(next === undefined ? {} : { next }) };
}
