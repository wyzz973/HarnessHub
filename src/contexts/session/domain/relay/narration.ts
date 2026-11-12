import { ITEM_KINDS, type ItemKind } from "../../../../contracts/relay.js";
import type { PublicRun, PublicTool, RunStatus } from "../../../../contracts/session.js";
import { outlineOf, type RelayHistory } from "./history.js";
import { plainReply, plainWords, type TextSize, type TurnOutline, type TurnWords } from "../turn-source.js";
import { estimateTokens } from "./budget.js";
import { characters, codeUnitsOf, fence, headUnits, neutralize, normalize, visible, type RelayLanguage } from "./escape.js";
import { marksIn, namesCredentialFile, restoreLabels, type RelayRedactor } from "./redaction.js";
import { changesFrom, classifyTool, commandTextOf, diffFiles, locationOf, normalizeTool, toolOutcome, type FileChange, type ToolFamily } from "../protocol/index.js";
import type { DetailPolicy, DetailRead } from "../detail-read.js";

/**
 * Narration of the record for the slim relay packet (relay/1-mvp.7, ADR-055 §5.2): what one turn of the history says, as
 * facts and nothing else, cut into items — the user's words, a reply, the lines of what was read, changed and run, a failed
 * command's output tail, an error — each of which a packet carries whole or leaves out whole. Only committed public facts
 * enter: the user's words, the tools' titles, kinds, statuses and exit codes, attachments, errors and replies; tool details
 * only when the caller read them. Thinking, plans, diffs and the output of commands that succeeded never do. Pure.
 */

/**
 * What a tool's stored detail adds when its caller could read it (ADR-055 §6.4): the command, its output, its diff, where.
 * `truncated`: what is here is not all there was — the Driver cut a preview to its byte budget when it stored it, or the reader kept only the end of an output too long to read (`outputLines`).
 * `outputLines`: of such an output, how many lines the whole of it has, which `output` (its last lines) cannot say.
 */
export interface RelayToolDetail { readonly input?: string; readonly output?: string; readonly diff?: string; readonly locations?: readonly string[]; readonly truncated?: true; readonly outputLines?: number }

/**
 * What the packet keeps of a stored detail (finding 1 of the cut review): the command whole, a diff whole, an output whole up to 256 KiB and else its last 64 KiB (all the packet quotes of one is
 * its last lines), whatever the detail's size.
 */
export const RELAY_DETAIL_POLICY: DetailPolicy = {
  input: { whole: 1024 * 1024, head: 1024 * 1024, tail: 0 }, output: { whole: 256 * 1024, head: 0, tail: 64 * 1024 }, diff: { whole: 16 * 1024 * 1024, head: 0, tail: 0 },
};
/** A detail as read, in the packet's terms. A command too long to read whole cannot be checked for a credential file, so what it printed and changed is not carried; an output too long to keep whole is its last lines. */
export function relayDetailOf(read: DetailRead): RelayToolDetail {
  const input = read.input, output = read.output, diff = read.diff, inputCut = input?.cut === true;
  const kept: { input?: string; output?: string; diff?: string; locations?: readonly string[]; truncated?: true; outputLines?: number } = {};
  if (input !== undefined) kept.input = input.cut ? input.head : input.text;
  if (!inputCut && output !== undefined) {
    if (!output.cut) kept.output = output.text;
    else {
      // Its last lines, from the start of a line (the first of the kept characters is likely in the middle of one).
      const line = output.tail.indexOf("\n");
      kept.output = line >= 0 ? output.tail.slice(line + 1) : output.tail;
      kept.outputLines = output.newlines + (output.tail.endsWith("\n") ? 0 : 1);
    }
  }
  if (!inputCut && diff !== undefined && !diff.cut) kept.diff = diff.text;
  if (read.locations !== undefined) kept.locations = read.locations;
  if (read.truncated === true || inputCut || output?.cut === true || diff?.cut === true) kept.truncated = true;
  return kept;
}

/**
 * A stored tool detail (the JSON the Runtime keeps for a tool, read back as `unknown`) as far as the packet uses it: its
 * input, output and diff when they are text, up to 16 locations, and whether it was cut; null when it is not an object.
 */
export function parseToolDetail(value: unknown): RelayToolDetail | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>, locations = Array.isArray(row.locations) ? row.locations.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  return { ...(typeof row.input === "string" ? { input: row.input } : {}), ...(typeof row.output === "string" ? { output: row.output } : {}),
    ...(typeof row.diff === "string" ? { diff: row.diff } : {}), ...(locations.length ? { locations } : {}), ...(row.truncated === true ? { truncated: true as const } : {}) };
}

/** One unit of the history, built from the public snapshot by `relayUnits`: a Run, or a turn of the history a branch or an import started from. */
export interface RelayUnit {
  readonly key: string;
  /** The Run's turn number in its conversation (its position, from 1), or the position of an origin turn in its history. */
  readonly turn: number;
  readonly origin: boolean;
  readonly harnessId: string | null;
  readonly model: string | null;
  readonly status: RunStatus;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly cancelRequested: boolean;
  /** The user's words, read when a piece of the packet needs them; null for a turn of an origin's history that starts with a reply, which has no user message. */
  readonly user: TurnWords | null;
  readonly attachments: readonly { readonly name: string; readonly mediaType: string; readonly bytes: number }[];
  readonly tools: readonly PublicTool[];
  /** The reply, inline `<think>` blocks and all, read when a piece needs it; `visible`: something is left of it once they are taken out. */
  readonly reply: TurnOutline["reply"];
  readonly details: ReadonlyMap<string, RelayToolDetail>;
}

/** A model name as the packet may show it (ADR-055 §5.1); anything else is an unknown model. */
function modelName(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/u.test(value) ? value : null;
}
/**
 * The model a Run ran with, as far as the public record tells: the model its selection named, else the model its binding
 * reported at the end of its last dispatched Turn when this Run was that Turn (`latest`: the last dispatched Run of each
 * Harness and control); unknown otherwise.
 */
function runModel(state: Pick<RelayHistory, "nativeBindings">, run: PublicRun, latest: ReadonlyMap<string, PublicRun["id"]>): string | null {
  const selected = modelName(run.selection.nativeModel);
  if (selected !== null) return selected;
  const binding = state.nativeBindings?.find(row => row.harnessId === run.selection.harnessId && row.controlId === run.selection.controlId && row.status !== "archived");
  if (binding?.observed?.model == null) return null;
  return latest.get(run.selection.harnessId + "\n" + run.selection.controlId) === run.id ? modelName(binding.observed.model) : null;
}

/**
 * The units a packet narrates, oldest first: the turns of the history this Session started from when `origin` is owed (a
 * user message and the replies after it make one turn), then `sources` in their order. `details` holds what callers read
 * of tool details, by `runId + "/" + toolId`.
 */
export function relayUnits(state: RelayHistory, sources: readonly PublicRun[], origin: boolean, details: ReadonlyMap<string, RelayToolDetail> = new Map()): readonly RelayUnit[] {
  const units: RelayUnit[] = [];
  if (origin && state.origin !== undefined) {
    let turn: { user: string | null; status: RunStatus; harnessId: string | null; attachments: RelayUnit["attachments"]; replies: string[] } | null = null;
    const close = () => {
      if (turn === null) return;
      units.push({ key: "origin-" + (units.length + 1), turn: units.length + 1, origin: true, harnessId: turn.harnessId ?? (state.origin!.kind === "import" ? state.origin!.harnessId : null),
        model: null, status: turn.status, error: null, cancelRequested: false, user: turn.user === null ? null : plainWords(turn.user), attachments: turn.attachments, tools: [], reply: plainReply(turn.replies.join("\n\n")), details: new Map() });
      turn = null;
    };
    for (const message of state.origin.history) {
      const attachments = (message.attachments ?? []).map(item => ({ name: item.name, mediaType: item.mediaType, bytes: item.bytes }));
      if (message.role === "user") { close(); turn = { user: message.text, status: message.status, harnessId: null, attachments, replies: [] }; continue; }
      turn ??= { user: null, status: message.status, harnessId: null, attachments: [], replies: [] };
      turn.replies.push(message.text); turn.status = message.status; turn.harnessId = message.harnessId ?? turn.harnessId;
    }
    close();
  }
  const index = new Map(state.runs.map((run, position) => [run.id, position])), latest = new Map<string, PublicRun["id"]>();
  for (const run of state.runs) if (run.timing?.dispatchedAt !== undefined || (run.timing === undefined && run.backend !== null)) latest.set(run.selection.harnessId + "\n" + run.selection.controlId, run.id);
  for (const run of sources) {
    const own = new Map<string, RelayToolDetail>();
    for (const tool of run.tools ?? []) { const detail = details.get(run.id + "/" + tool.id); if (detail !== undefined) own.set(tool.id, detail); }
    // The words of a Turn are not read here: its outline says how big they are and whether the reply has anything to read, and the words come when a piece of the packet is written.
    const outline = outlineOf(state, index.get(run.id) ?? -1);
    units.push({ key: run.id, turn: (index.get(run.id) ?? 0) + 1, origin: false, harnessId: run.selection.harnessId, model: runModel(state, run, latest), status: run.status,
      error: run.error, cancelRequested: run.cancelRequested, user: outline?.user ?? plainWords(run.input),
      attachments: (run.attachments ?? []).map(item => ({ name: item.name, mediaType: item.mediaType, bytes: item.bytes })), tools: run.tools ?? [], reply: outline?.reply ?? plainReply(""), details: own });
  }
  return units;
}

/** Inline `<think>` blocks of a reply (and an unclosed one to its end): thinking never leaves (ADR-055 §5.1). */
const THINK = /<think>[\s\S]*?(?:<\/think>|$)/giu;
export function withoutThinking(reply: string): string {
  return reply.includes("<think") || reply.includes("<THINK") ? reply.replace(THINK, "") : reply;
}

/** Redaction hits counted while a piece is written. */
interface Tally { hits: number }
/** A rendered piece of the record: its text, its estimated tokens and its redaction hits. */
export interface Piece { readonly text: string; readonly tokens: number; readonly hits: number }

/** A quoted line (a command, a path, a title) longer than this is never carried: it is one line, so it is left out whole. */
const MAX_INLINE = 4000;
/** A failed command's output is carried as its last lines: at most this many, and as many fewer as keep it within this many characters. */
export const OUTPUT_LINES = 20;
const OUTPUT_CHARS = 1200;

/**
 * Writes the record's sentences in one language with one redactor and one way of naming Harnesses. Every quoted text goes
 * through normalize → redaction → visible → neutralize → labels (escape.ts, ADR-055 N19) and is quoted whole.
 */
export class Narrator {
  private readonly names = new Map<string, string>();
  /**
   * `tools`: the Harness the packet goes to has the Hub's tools this Turn (hub_turns, hub_read_turn, hub_search), so that what the
   * packet leaves out can be read back: the packet then says how, and notes every command whose output it does not carry.
   */
  constructor(readonly language: RelayLanguage, private readonly redactor: RelayRedactor, private readonly naming: (harnessId: string) => string | null, readonly tools = false) {}
  get zh(): boolean { return this.language === "zh"; }
  /** A Harness's display name: its catalog name when known, else its id; an unknown one for none. Always a name, never "the other". */
  name(harnessId: string | null): string {
    if (harnessId === null) return this.zh ? "未知 Harness" : "an unknown Harness";
    let shown = this.names.get(harnessId);
    if (shown === undefined) {
      const named = this.naming(harnessId), text = typeof named === "string" && named.trim() !== "" ? named : harnessId;
      shown = neutralize(visible(normalize(text, "text").replace(/[\n\t]/gu, " ")), this.language, "inline").replace(/`/gu, "‘").slice(0, 64);
      this.names.set(harnessId, shown);
    }
    return shown;
  }
  /** One line of a string, redacted, closed off from the slot around it; `max` clamps an identifier (a code, a media type, a file name). */
  private slot(raw: string, counted: Tally, max: number | null): string {
    let value = this.redactor.redact(normalize(raw, "text").replace(/\t/gu, " ")).text;
    if (max !== null && characters(value) > max) value = headUnits(value, codeUnitsOf(value, max)) + "…";
    counted.hits += marksIn(value);
    value = restoreLabels(neutralize(visible(value.replace(/\n/gu, "⏎")), this.language, "inline"), this.language).replace(/`/gu, "‘");
    return value === "" ? "∅" : value;
  }
  /** A string quoted inline, whole; null when it is longer than MAX_INLINE (then it is not carried). */
  inline(raw: string, counted: Tally): string | null { return raw.length > MAX_INLINE ? null : this.slot(raw, counted, null); }
  /** `inline` in backticks. */
  code(raw: string, counted: Tally): string | null { const value = this.inline(raw, counted); return value === null ? null : "`" + value + "`"; }
  /** An identifier clamped to `max` characters (the one place a string is cut): an error code, a media type, an attachment's name. */
  label(raw: string, max: number, counted: Tally): string { return this.slot(raw.slice(0, MAX_INLINE), counted, max); }
  /** A redacted body as a verbatim block in a fence `indent` deep (N3), escaped (N2, N4) with its labels restored. */
  private quote(body: string, indent: string, counted: Tally): string {
    counted.hits += marksIn(body);
    return fence(restoreLabels(neutralize(visible(body), this.language, "block"), this.language), indent);
  }
  /** A text as a verbatim block, whole; null when nothing is left of it once normalized and redacted. */
  block(raw: string, kind: "text" | "output", counted: Tally): string | null {
    const text = this.redactor.redact(normalize(raw, kind).replace(/\n+$/u, ""), kind).text;
    return text.trim() === "" ? null : this.quote(text, "", counted);
  }
  /**
   * The end of a command's output, as whole lines, after the whole output was redacted: its last OUTPUT_LINES lines, fewer
   * while they take more than OUTPUT_CHARS characters. "unfit" when even the last line is longer than that; null when
   * nothing is left of the output.
   */
  tail(output: string, counted: Tally): { readonly block: string; readonly shown: number; readonly total: number } | "unfit" | null {
    const text = this.redactor.redact(normalize(output, "output").replace(/\n+$/u, ""), "output").text.replace(/\s+$/u, "");
    if (text.trim() === "") return null;
    const lines = text.split("\n");
    let from = Math.max(0, lines.length - OUTPUT_LINES);
    while (from < lines.length && characters(lines.slice(from).join("\n")) > OUTPUT_CHARS) from++;
    if (from >= lines.length) return "unfit";
    while (lines[from]!.trim() === "") from++;
    return { block: this.quote(lines.slice(from).join("\n"), "  ", counted), shown: lines.length - from, total: lines.length };
  }

  /** “第 3 轮” / “来源第 2 轮” / “turn 3” / “source turn 2”. */
  turnOf(unit: Pick<RelayUnit, "turn" | "origin">): string {
    return this.zh ? (unit.origin ? "来源第 " : "第 ") + unit.turn + " 轮" : (unit.origin ? "source turn " : "turn ") + unit.turn;
  }
  /**
   * How a unit ended: 完成, 失败（CODE）, why it was cancelled, or 结果未核实. The relay's own words: in a packet “you” is the
   * target, so the wait was the user's, never the interface's 等待你的决定.
   */
  result(unit: RelayUnit, counted: Tally): string {
    const code = () => unit.error === null ? null : this.label(unit.error.code, 64, counted);
    if (this.zh) switch (unit.status) {
      case "completed": return "完成";
      case "failed": { const shown = code(); return shown === null ? "失败" : "失败（" + shown + "）"; }
      case "cancelled": switch (unit.error?.code) {
        case "RUN_TIMEOUT": return "已取消（执行预算用尽）";
        case "WAIT_EXPIRED": return "已取消（等待用户决定超时）";
        case "OWNER_ENDED": return "已取消（服务重启，这条消息没有发出）";
        default: return unit.cancelRequested ? "已取消（用户停止）" : "已取消";
      }
      case "unknown": return "结果未核实";
      default: return "未结束（" + unit.status + "）";
    }
    switch (unit.status) {
      case "completed": return "completed";
      case "failed": { const shown = code(); return shown === null ? "failed" : "failed (" + shown + ")"; }
      case "cancelled": switch (unit.error?.code) {
        case "RUN_TIMEOUT": return "cancelled (execution budget ran out)";
        case "WAIT_EXPIRED": return "cancelled (the wait for the user's decision ran out)";
        case "OWNER_ENDED": return "cancelled (the service restarted; this message was not sent)";
        default: return unit.cancelRequested ? "cancelled (stopped by the user)" : "cancelled";
      }
      case "unknown": return "result not verified";
      default: return "not finished (" + unit.status + ")";
    }
  }
  /** “Claude Code（claude-opus-5-5）” / “Claude Code (claude-opus-5-5)”, or the name alone. */
  who(harnessId: string | null, model: string | null): string {
    return this.name(harnessId) + (model === null ? "" : this.zh ? "（" + model + "）" : " (" + model + ")");
  }
  /** A separator after a clause: “· ” after a full-width closing bracket in Chinese, “ · ” otherwise. */
  dot(before: string): string { return this.zh && /[）」]$/u.test(before) ? "· " : " · "; }
  /** The unit's heading: “### 第 2 轮 · Claude Code（model）· 完成”. */
  heading(unit: RelayUnit, counted: Tally): string {
    const turn = this.turnOf(unit), who = this.who(unit.harnessId, unit.model);
    return "### " + (this.zh ? turn : turn[0]!.toUpperCase() + turn.slice(1)) + " · " + who + this.dot(who) + this.result(unit, counted);
  }
}

/**
 * What a tool is, in the relay's words: the shared classification (domain/protocol/tools.ts), which trusts the kind the Harness reported
 * and tells a tool that reported none by the name table. How a tool ended is the shared status words'.
 */
type ToolKind = ToolFamily;
export function kindOf(tool: PublicTool): ToolKind { return classifyTool(tool).family; }
/** How a tool ended: done, failed, or not finished. */
function toolEnd(tool: PublicTool): "done" | "failed" | "open" { return toolOutcome(tool); }
/** Whether a command failed: a non-zero exit code, or an end that is a failure. */
function commandFailed(tool: PublicTool): boolean { return (tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed"; }

/** One file a change made, and the split of a unified diff by file: read one way by the packet, the table and the protocol (domain/protocol/changes.ts). */
export { diffFiles, type FileChange };
/** The files one change tool made, from its read detail; null when nothing was read or the diff and the locations do not correspond. */
export function changesOf(unit: Pick<RelayUnit, "details">, tool: PublicTool): readonly FileChange[] | null { return changesFrom(tool, unit.details.get(tool.id)); }
/** A title fully wrapped in one pair of backticks (as some drivers write commands) without them. */
function unwrapped(title: string): string { return /^`[^`]+`$/u.test(title) ? title.slice(1, -1) : title; }
/** The lines of a command's recorded output as the table counts them: normalized like any output, blank lines at either end not counted; 0 for none. */
function linesOf(output: string): number {
  const lines = normalize(output, "output").split("\n");
  let from = 0, to = lines.length;
  while (from < to && lines[from]!.trim() === "") from++;
  while (to > from && lines[to - 1]!.trim() === "") to--;
  return to - from;
}
/** The command a tool ran, unquoted: its detail's input when read, else its title. */
function commandSource(unit: RelayUnit, tool: PublicTool): string {
  const input = unit.details.get(tool.id)?.input;
  return typeof input === "string" && input.trim() !== "" ? input : unwrapped(tool.title);
}
/**
 * What a tool that only the name table could tell acted on, from its stored detail: the command, the path, the query or the address. Such a
 * tool's title is just its name (a DeepSeek Harness `bash`), so without the detail there is nothing to quote and null is returned, and the tool
 * is told as the operation of no known kind it was before the name table knew it.
 */
function namedObject(tool: PublicTool, detail: RelayToolDetail | undefined, family: ToolKind): string | null {
  if (family === "execute") { const command = commandTextOf(tool, detail ?? null); return command === "" ? null : command; }
  const result = normalizeTool(tool, { seq: 0, detail: detail ?? null, turn: "going" });
  if (!result.row) return null;
  const item = result.item;
  return item.type === "file_read" ? item.path : item.type === "search" ? item.query : item.type === "web" ? item.query ?? item.url ?? null : null;
}
/** The files a change tool that only the name table could tell made, from its stored detail (its input names a path); null when it says none. */
function namedChanges(tool: PublicTool, detail: RelayToolDetail | undefined): readonly FileChange[] | null {
  const result = normalizeTool(tool, { seq: 0, detail: detail ?? null, turn: "going" });
  if (!result.row || result.item.type !== "file_change" || result.item.changes.length === 0) return null;
  const ops = { create: "create", delete: "delete", modify: "edit", rename: "move" } as const;
  return result.item.changes.map(file => ({ path: file.path, op: ops[file.op], added: file.added ?? null, removed: file.removed ?? null }));
}

/** The words of the items, in each language: both are listed here so that they stay the same text. */
type Verb = "read" | "search" | "fetch" | "mcp" | "subagent" | "other" | "ran" | FileChange["op"];
interface Words {
  readonly user: string;
  readonly empty: string;
  readonly attachments: (items: readonly string[], total: number) => string;
  readonly ops: (name: string) => string;
  readonly reply: (name: string) => string;
  readonly error: (name: string, code: string) => string;
  readonly output: (name: string, shown: number, total: number) => string;
  readonly verb: Readonly<Record<Verb, string>>;
  readonly unread: string;
  readonly failed: string;
  readonly open: string;
  readonly counts: (added: number | null, removed: number | null) => string;
  readonly exit: (tool: PublicTool) => string;
  /** What a command's line says of its output when the packet does not carry it: how many lines it has ("at least" when the stored output was cut), and that they are not attached. */
  readonly unattached: (lines: number, atLeast: boolean) => string;
}
function countsOf(added: number | null, removed: number | null): string {
  return [added ? "+" + added : "", removed ? "−" + removed : ""].filter(Boolean).join(" ");
}
const WORDS: Readonly<Record<RelayLanguage, Words>> = {
  zh: {
    user: "用户原话：", empty: "（空）",
    attachments: (items, total) => "用户附件：" + items.join("、") + (total > items.length ? " 等 " + total + " 个" : "") + "，只列名称。",
    ops: name => name + " 的操作（按发生顺序）：",
    reply: name => name + " 的回复：",
    error: (name, code) => name + " 报告的错误（" + code + "）原文：",
    output: (name, shown, total) => "  " + name + " 记录的输出" + (shown < total ? "末尾（最后 " + shown + " 行，共 " + total + " 行）：" : "（共 " + total + " 行）："),
    verb: { read: "读取", search: "搜索", fetch: "获取", mcp: "调用 MCP 工具", subagent: "子 Agent", other: "其他操作", ran: "执行", create: "新建", delete: "删除", edit: "修改", move: "移动" },
    unread: "（路径未读取）", failed: "（失败）", open: "（未完成）",
    counts: (added, removed) => { const text = countsOf(added, removed); return text === "" ? "" : "（" + text + "）"; },
    exit: tool => tool.exitCode !== undefined ? " → 退出码 " + tool.exitCode : toolEnd(tool) === "failed" ? " → 失败（没有报告退出码）" : toolEnd(tool) === "open" ? "（未完成）" : "（没有报告退出码）",
    unattached: (lines, atLeast) => "输出" + (atLeast ? "至少" : "共") + " " + lines + " 行，未附",
  },
  en: {
    user: "The user's words:", empty: "(empty)",
    attachments: (items, total) => "Attachments from the user: " + items.join(", ") + (total > items.length ? " and " + (total - items.length) + " more" : "") + "; names only.",
    ops: name => name + "'s actions, in order:",
    reply: name => name + "'s reply:",
    error: (name, code) => "Error reported by " + name + " (" + code + "), as written:",
    output: (name, shown, total) => "  Output recorded by " + name + (shown < total ? " (last " + shown + " of " + total + " lines):" : " (" + total + " lines):"),
    verb: { read: "Read", search: "Searched", fetch: "Fetched", mcp: "Called MCP tool", subagent: "Sub-agent", other: "Other", ran: "Ran", create: "Created", delete: "Deleted", edit: "Edited", move: "Moved" },
    unread: " (path not read)", failed: " (failed)", open: " (not finished)",
    counts: (added, removed) => { const text = countsOf(added, removed); return text === "" ? "" : " (" + text + ")"; },
    exit: tool => tool.exitCode !== undefined ? " → exit code " + tool.exitCode : toolEnd(tool) === "failed" ? " → failed (no exit code reported)" : toolEnd(tool) === "open" ? " (not finished)" : " (no exit code reported)",
    unattached: (lines, atLeast) => "output: " + (atLeast ? "at least " : "") + lines + (lines === 1 ? " line" : " lines") + ", not attached",
  },
};
function bytesLabel(bytes: number): string { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KB" : (bytes / 1048576).toFixed(1) + " MB"; }

/** The kinds of item a packet counts (the contract's ITEM_KINDS): what it carries and what it leaves out are told by these, and add up to what the record holds. */
export { ITEM_KINDS, type ItemKind };
/** Where an item stands in its unit: the user's words, the lines of operations (a command's output under its line), an error, the reply. */
export type ItemGroup = "user" | "ops" | "output" | "error" | "reply";
/** One thing the record says that a packet may carry, whole or not at all. */
export interface Candidate {
  readonly kind: ItemKind;
  readonly group: ItemGroup;
  /** The index of its unit among the packet's units. */
  readonly unit: number;
  /** Its place in the unit's own order. */
  readonly seq: number;
  /** Its priority among the unit's items when not all fit: lower first (changes, commands, errors, the reply, outputs, other calls). */
  readonly rank: number;
  /** How many characters of the record it quotes whole (none for an output: only its last lines are quoted), to leave a text that cannot fit unrendered; a text not read yet is known by bounds, and read for its length only when they do not settle it. */
  readonly size: TextSize;
  /** The item it stands under: a command's output goes only with the command. */
  readonly needs: Candidate | null;
  /**
   * For a command of a target that has the Hub's tools whose recorded output can be read back (Narrator.tools): the note its line takes
   * when its output is not in the packet — not as a failed command's output tail, which says its own size. Null: nothing to say.
   */
  readonly unattached: { readonly text: string; readonly tokens: number } | null;
  /** Whether a rule keeps it out whatever the budget (the output of a command that reads a credential file). */
  readonly withheld: boolean;
  /** The rendering, made once; null when the item cannot be carried whole (too long, or nothing is left of it). */
  piece(): Piece | null;
}
const RANK = { change: 0, command: 1, error: 2, reply: 3, output: 4, call: 5 } as const;
/** The rank from which items are the least worth carrying: a packet takes them last, after the user's words (the reads, the searches and the like). */
export const LEAST = RANK.call;

/**
 * The items of one unit, in the order the unit tells them: the user's words, each tool's lines (a patch over several files is
 * a line for each file, a failed command's output tail under the command), the error, the reply. The totals a packet counts
 * come from this list alone, whatever is carried.
 */
export function candidatesOf(n: Narrator, unit: RelayUnit, index: number): readonly Candidate[] {
  const out: Candidate[] = [], words = WORDS[n.language], name = n.name(unit.harnessId);
  let seq = 0;
  const add = (kind: ItemKind, group: ItemGroup, rank: number, raw: number | TextSize, make: (counted: Tally) => string | null, needs: Candidate | null = null, withheld = false, unattached: string | null = null): Candidate => {
    let made: Piece | null | undefined;
    const size: TextSize = typeof raw === "number" ? { least: raw, most: raw, exact: () => raw } : raw;
    const candidate: Candidate = { kind, group, unit: index, seq: seq++, rank, size, needs, withheld, unattached: unattached === null ? null : { text: unattached, tokens: estimateTokens(unattached) }, piece() {
      if (made === undefined) {
        const counted: Tally = { hits: 0 }, text = withheld ? null : make(counted);
        made = text === null ? null : { text, tokens: estimateTokens(text), hits: counted.hits };
      }
      return made;
    } };
    out.push(candidate);
    return candidate;
  };
  const status = (tool: PublicTool) => { const end = toolEnd(tool); return end === "failed" ? words.failed : end === "open" ? words.open : ""; };
  const line = (verb: Verb, code: string, tail: string) => "- " + words.verb[verb] + " " + code + tail;
  if (unit.user !== null) {
    const user = unit.user;
    add("userMessages", "user", 0, user.size, counted => {
      const attachments = unit.attachments.slice(0, 8).map(item => "`" + n.label(item.name, 120, counted) + "`" + (n.zh ? "（" : " (") + n.label(item.mediaType, 80, counted) + (n.zh ? "，" : ", ") + bytesLabel(item.bytes) + (n.zh ? "）" : ")"));
      return [words.user, n.block(user.text(), "text", counted) ?? words.empty, ...(attachments.length ? [words.attachments(attachments, unit.attachments.length)] : [])].join("\n");
    });
  }
  for (const tool of unit.tools) {
    if (tool.parentId !== undefined) continue;
    const { family, via } = classifyTool(tool), detail = unit.details.get(tool.id);
    if (family === "think") continue;
    // A tool only the name table could tell is worded by what its stored detail says, and by what it was before the name table when it has none.
    const changes = family === "change" ? changesOf(unit, tool) ?? (via === "name" ? namedChanges(tool, detail) : null) : null;
    const named = via === "name" && (family === "execute" || family === "read" || family === "search" || family === "fetch") ? namedObject(tool, detail, family) : undefined;
    const kind: ToolKind = named === null || (via === "name" && family === "change" && changes === null) ? "other" : family;
    if (kind === "change") {
      const files = changes, op: FileChange["op"] = tool.kind === "delete" ? "delete" : tool.kind === "move" ? "move" : "edit";
      if (files === null) add("changes", "ops", RANK.change, tool.title.length, counted => { const code = n.code(unwrapped(tool.title), counted); return code === null ? null : line(op, code, words.unread + status(tool)); });
      else for (const file of files) add("changes", "ops", RANK.change, file.path.length, counted => { const code = n.code(file.path, counted); return code === null ? null : line(file.op, code, words.counts(file.added, file.removed) + status(tool)); });
    } else if (kind === "execute") {
      const source = named ?? commandSource(unit, tool), exit = words.exit(tool), keptBack = namesCredentialFile(source), output = detail?.output;
      // With the Hub's tools the whole output can be read back, so the line says there is one the packet does not carry (never for a rule's withheld output: the table keeps it back too).
      const lines = n.tools && !keptBack && typeof output === "string" ? detail?.outputLines ?? linesOf(output) : 0;
      const command = add("calls", "ops", RANK.command, source.length, counted => { const code = n.code(source, counted); return code === null ? null : line("ran", code, exit); }, null, false,
        lines > 0 ? n.dot(exit) + words.unattached(lines, detail?.truncated === true) : null);
      if (commandFailed(tool) && typeof output === "string" && output.trim() !== "")
        add("outputs", "output", RANK.output, 0, counted => {
          const tail = n.tail(output, counted);
          // Of an output the reader kept only the end of, the whole's lines are the detail's count.
          return tail === null || tail === "unfit" ? null : words.output(name, tail.shown, detail?.outputLines ?? tail.total) + "\n" + tail.block;
        }, command, keptBack);
    } else {
      const raw = named ?? (kind === "read" ? locationOf(detail) ?? unwrapped(tool.title)
        : kind === "search" && typeof detail?.input === "string" && detail.input.trim() !== "" && !detail.input.includes("\n") ? detail.input : unwrapped(tool.title));
      add("calls", "ops", RANK.call, raw.length, counted => { const code = n.code(raw, counted); return code === null ? null : line(kind, code, status(tool)); });
    }
  }
  if (unit.status === "failed" && unit.error !== null && unit.error.message.trim() !== "") {
    const error = unit.error;
    add("outputs", "error", RANK.error, error.message.length, counted => words.error(name, n.label(error.code, 64, counted)) + "\n" + (n.block(error.message, "text", counted) ?? words.empty));
  }
  // A reply that has something to read once its thinking is taken out is a candidate; it is read, and its thinking taken out, when its piece is written.
  const reply = unit.reply;
  if (reply.visible) add("replies", "reply", RANK.reply, reply.size, counted => words.reply(name) + "\n" + (n.block(withoutThinking(reply.text()), "text", counted) ?? words.empty));
  return out;
}
/** The line that opens a unit's operations. */
export function opsLabel(n: Narrator, unit: RelayUnit): string { return WORDS[n.language].ops(n.name(unit.harnessId)); }
