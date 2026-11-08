import type { PublicActivity, PublicOutput, PublicPlan, PublicRun, PublicTool, RunStatus, SessionSnapshot } from "../../../../contracts/session.js";
import { estimateTokens } from "./budget.js";
import { characters, codeUnitsOf, fence, headUnits, neutralize, normalize, tailUnits, visible, type RelayLanguage } from "./escape.js";
import { marksIn, namesCredentialFile, restoreLabels, type RelayRedactor } from "./redaction.js";

/**
 * Narration rules relay/1 on Session v12 (ADR-055 §5.2, the MVP of G070): what one unit of the record (a Run, or a turn of
 * the history a branch or an import started from) says at each grade — verbatim (G1), compact (G2), one line (G3) — and
 * the range line for consecutive units. Only committed public facts enter: the user's words, the tools' titles, kinds,
 * statuses and exit codes, the plan, attachments, outputs, activities, the error and the reply; tool details only when the
 * caller read them. Thinking never does. Pure.
 */

/** What a tool's stored detail adds when its caller could read it (ADR-055 §6.4): the command, its output, its diff, where. */
export interface RelayToolDetail { readonly input?: string; readonly output?: string; readonly diff?: string; readonly locations?: readonly string[] }

/**
 * A stored tool detail (the JSON the Runtime keeps for a tool, read back as `unknown`) as far as the packet uses it: its
 * input, output and diff when they are text, and up to 16 locations; null when it is not an object.
 */
export function parseToolDetail(value: unknown): RelayToolDetail | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>, locations = Array.isArray(row.locations) ? row.locations.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  return { ...(typeof row.input === "string" ? { input: row.input } : {}), ...(typeof row.output === "string" ? { output: row.output } : {}),
    ...(typeof row.diff === "string" ? { diff: row.diff } : {}), ...(locations.length ? { locations } : {}) };
}

/** One unit of the record, built from the public snapshot by `relayUnits`. */
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
  readonly user: string;
  readonly attachments: readonly { readonly name: string; readonly mediaType: string; readonly bytes: number }[];
  readonly tools: readonly PublicTool[];
  readonly plan: PublicPlan | null;
  readonly outputs: readonly PublicOutput[];
  readonly activities: readonly PublicActivity[];
  readonly reply: string;
  readonly thinking: boolean;
  readonly details: ReadonlyMap<string, RelayToolDetail>;
}

/** A model name as the packet may show it (ADR-055 §5.1); anything else is an unknown model. */
export function modelName(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/u.test(value) ? value : null;
}
/**
 * The model a Run ran with, as far as the public record tells: the model its selection named, else the model its binding
 * reported at the end of its last dispatched Turn when this Run was that Turn (`latest`: the last dispatched Run of each
 * Harness and control); unknown otherwise.
 */
function runModel(state: SessionSnapshot, run: PublicRun, latest: ReadonlyMap<string, PublicRun["id"]>): string | null {
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
export function relayUnits(state: SessionSnapshot, sources: readonly PublicRun[], origin: boolean, details: ReadonlyMap<string, RelayToolDetail> = new Map()): readonly RelayUnit[] {
  const units: RelayUnit[] = [];
  if (origin && state.origin !== undefined) {
    let turn: { user: string; status: RunStatus; harnessId: string | null; attachments: RelayUnit["attachments"]; replies: string[] } | null = null;
    const close = () => {
      if (turn === null) return;
      units.push({ key: "origin-" + (units.length + 1), turn: units.length + 1, origin: true, harnessId: turn.harnessId ?? (state.origin!.kind === "import" ? state.origin!.harnessId : null),
        model: null, status: turn.status, error: null, cancelRequested: false, user: turn.user, attachments: turn.attachments, tools: [], plan: null, outputs: [], activities: [],
        reply: turn.replies.join("\n\n"), thinking: false, details: new Map() });
      turn = null;
    };
    for (const message of state.origin.history) {
      const attachments = (message.attachments ?? []).map(item => ({ name: item.name, mediaType: item.mediaType, bytes: item.bytes }));
      if (message.role === "user") { close(); turn = { user: message.text, status: message.status, harnessId: null, attachments, replies: [] }; continue; }
      turn ??= { user: "", status: message.status, harnessId: null, attachments: [], replies: [] };
      turn.replies.push(message.text); turn.status = message.status; turn.harnessId = message.harnessId ?? turn.harnessId;
    }
    close();
  }
  const replies = new Map(state.messages.filter(message => message.role === "assistant").map(message => [message.id, message.text]));
  const index = new Map(state.runs.map((run, position) => [run.id, position])), latest = new Map<string, PublicRun["id"]>();
  for (const run of state.runs) if (run.timing?.dispatchedAt !== undefined || (run.timing === undefined && run.backend !== null)) latest.set(run.selection.harnessId + "\n" + run.selection.controlId, run.id);
  for (const run of sources) {
    const own = new Map<string, RelayToolDetail>();
    for (const tool of run.tools ?? []) { const detail = details.get(run.id + "/" + tool.id); if (detail !== undefined) own.set(tool.id, detail); }
    units.push({ key: run.id, turn: (index.get(run.id) ?? 0) + 1, origin: false, harnessId: run.selection.harnessId, model: runModel(state, run, latest), status: run.status,
      error: run.error, cancelRequested: run.cancelRequested, user: run.input,
      attachments: (run.attachments ?? []).map(item => ({ name: item.name, mediaType: item.mediaType, bytes: item.bytes })), tools: run.tools ?? [], plan: run.plan ?? null,
      outputs: run.outputs ?? [], activities: run.activities ?? [], reply: replies.get(run.assistantMessageId) ?? "", thinking: (run.thinking ?? "") !== "", details: own });
  }
  return units;
}


/** What a piece cut, to be told in the ledger (M5): the user's words, a reply, a command's output or an error, and how much. */
export interface Cut { readonly what: "words" | "reply" | "output" | "error"; readonly omitted: number }
/** What a rendered piece costs: its estimated tokens, how many of them are model or tool text, its redaction hits and its cuts. */
export interface Piece { readonly text: string; readonly tokens: number; readonly untrusted: number; readonly hits: number; readonly cuts: readonly Cut[] }
/** Counts kept while a piece is written; `untrusted` in tokens. */
export interface Tally { hits: number; untrusted: number; cuts: Cut[] }
export function tally(): Tally { return { hits: 0, untrusted: 0, cuts: [] }; }
function piece(text: string, counted: Tally): Piece { return { text, tokens: estimateTokens(text), untrusted: counted.untrusted, hits: counted.hits, cuts: counted.cuts }; }

/** Inline `<think>` blocks of a reply (and an unclosed one to its end): thinking never leaves (ADR-055 §5.1). */
const THINK = /<think>[\s\S]*?(?:<\/think>|$)/giu;
export function withoutThinking(reply: string): { readonly text: string; readonly blocks: number } {
  let blocks = 0;
  const text = reply.includes("<think") || reply.includes("<THINK") ? reply.replace(THINK, () => { blocks++; return ""; }) : reply;
  return { text, blocks };
}

/**
 * A text ready to cut and quote (ADR-055 §5.2 N19): normalized, then redacted as a whole, so no cut can leave part of a
 * secret; its estimate is of what was read, never of a middle skipped unread (`skipped` characters), so the share kept of
 * a long text does not shrink with its length (M3).
 */
interface Redacted { readonly text: string; readonly tokens: number; readonly skipped: number; characters?: number }
/** A quoted text longer than twice this is read only at its two ends (≤64 KiB in all): no cap keeps more than 8 KiB of it. */
const HUGE_WINDOW = 32 * 1024;
/** Only an inline field's first characters are read, and this much beyond them (N19). */
const SCAN_MARGIN = 8192;

/**
 * Writes the record's sentences in one language with one redactor and one way of naming Harnesses. Every quoted text goes
 * through normalize → redaction → cut (never inside a redaction mark) → visible → neutralize → labels; model and tool text
 * counts as untrusted; what a cut leaves out is reported in the tally.
 */
export class Narrator {
  private readonly names = new Map<string, string>();
  private readonly redactedTexts = { text: new Map<string, Redacted | null>(), output: new Map<string, Redacted | null>() };
  constructor(readonly language: RelayLanguage, private readonly redactor: RelayRedactor, private readonly naming: (harnessId: string) => string | null) {}
  get zh(): boolean { return this.language === "zh"; }
  /** A Harness's display name: its catalog name when known, else its id; an unknown one for none. */
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
  /** A string quoted inline (in backticks or 「」): one line, ≤ `max` characters, closed off from the slot around it. */
  inline(raw: string, max: number, counted: Tally, untrusted = true): string {
    // Only what can be kept is read, and 8 KiB beyond it (N19); it is redacted before it is cut.
    const window = raw.length > max * 8 + SCAN_MARGIN ? raw.slice(0, max * 8 + SCAN_MARGIN) : raw;
    let value = this.redactor.redact(normalize(window, "text").replace(/\t/gu, " ")).text;
    if (characters(value) > max) value = headUnits(value, codeUnitsOf(value, max)) + "…";
    counted.hits += marksIn(value);
    value = restoreLabels(neutralize(visible(value.replace(/\n/gu, "⏎")), this.language, "inline"), this.language).replace(/`/gu, "‘").replace(/\|/gu, "｜");
    if (/^[#>-]/u.test(value)) value = "·" + value;
    if (value === "") value = "∅";
    if (untrusted) counted.untrusted += estimateTokens(value);
    return value;
  }
  /** `inline` in backticks. */
  code(raw: string, max: number, counted: Tally, untrusted = true): string { return "`" + this.inline(raw, max, counted, untrusted) + "`"; }
  /** See Redacted; cached by text and kind, since the fold quotes one text at several caps. Null when nothing is left. */
  private redacted(raw: string, kind: "text" | "output"): Redacted | null {
    const known = this.redactedTexts[kind].get(raw);
    if (known !== undefined) return known;
    const huge = raw.length > 2 * HUGE_WINDOW, window = huge ? headUnits(raw, HUGE_WINDOW) + "\n" + tailUnits(raw, HUGE_WINDOW) : raw;
    const text = this.redactor.redact(normalize(window, kind).replace(/\n+$/u, ""), kind).text;
    const redacted = text.trim() === "" ? null : { text, tokens: estimateTokens(text), skipped: huge ? raw.length - window.length + 1 : 0 };
    this.redactedTexts[kind].set(raw, redacted);
    return redacted;
  }
  /** A redacted body as a verbatim block (N3): visible, neutralized, its labels restored, in a fence `indent` deep. */
  private quote(body: string, indent: string, counted: Tally, untrusted: boolean): string {
    counted.hits += marksIn(body);
    const quoted = fence(restoreLabels(neutralize(visible(body), this.language, "block"), this.language), indent);
    if (untrusted) counted.untrusted += estimateTokens(quoted);
    return quoted;
  }
  private elision(omitted: number): string { return this.zh ? "…（中间省略 " + omitted + " 字）…" : "… (" + omitted + " characters omitted) …"; }
  /**
   * A verbatim block (N3) of a text, whole when it is within `capTokens`, else cut to a head and a tail (`headShare` of what
   * is kept goes to the head) around a line that says how much was left out; the cut is reported as `what`. The share kept
   * follows the text's own characters per token. Null when nothing is left to quote.
   */
  block(raw: string, options: { readonly kind: "text" | "output"; readonly capTokens: number; readonly headShare?: number; readonly indent?: string; readonly untrusted?: boolean; readonly what: Cut["what"] }, counted: Tally): string | null {
    const redacted = this.redacted(raw, options.kind);
    if (redacted === null) return null;
    const { text, tokens, skipped } = redacted;
    let body = text;
    if (tokens > options.capTokens || skipped > 0) {
      const keep = Math.max(0, Math.floor(text.length * Math.min(1, Math.max(0, options.capTokens) / tokens))), head = Math.floor(keep * (options.headShare ?? 0.8)), tail = keep - head;
      const kept = headUnits(text, head), ending = tailUnits(text, tail);
      const omitted = skipped + Math.max(0, (redacted.characters ??= characters(text)) - characters(kept) - characters(ending));
      if (omitted > 0) {
        body = (kept === "" ? "" : kept + "\n") + this.elision(omitted) + (ending === "" ? "" : "\n" + ending);
        counted.cuts.push({ what: options.what, omitted });
      }
    }
    return this.quote(body, options.indent ?? "", counted, options.untrusted !== false);
  }
  /**
   * The last lines of a command's output, cut after it was redacted (B1): 20 lines and 1,200 characters when it failed, 3
   * lines and 300 bytes otherwise; credential-named assignments in it are hidden too. A cut is reported as `output`.
   */
  outputTail(output: string, failed: boolean, counted: Tally): string | null {
    const redacted = this.redacted(output, "output");
    if (redacted === null) return null;
    const lines = redacted.text.split("\n");
    let tail = lines.slice(-(failed ? 20 : 3)).join("\n").replace(/^(?:[ \t]*\n)+/u, "");
    const limit = failed ? 1200 : 300, size = (text: string) => failed ? characters(text) : new TextEncoder().encode(text).byteLength;
    while (tail !== "" && size(tail) > limit) { const at = tail.indexOf("\n"); tail = at >= 0 ? tail.slice(at + 1) : tailUnits(tail, Math.floor(tail.length * 3 / 4)); }
    if (tail.trim() === "") return null;
    const omitted = redacted.skipped + Math.max(0, characters(redacted.text.replace(/^(?:[ \t]*\n)+/u, "")) - characters(tail));
    if (omitted > 0) counted.cuts.push({ what: "output", omitted });
    return this.quote(tail, "  ", counted, true);
  }
  /**
   * A reply's first and last paragraphs, each ≤600 characters (G2), cut after the reply was redacted (B1); null when there is
   * no reply. `cut` when anything was left out, which is reported as a cut of the reply.
   */
  ends(reply: string, counted: Tally): { readonly quoted: string; readonly cut: boolean } | null {
    const redacted = this.redacted(reply, "text");
    if (redacted === null) return null;
    const trimmed = redacted.text.trim();
    // At most two UTF-16 units a character: a short text needs no count.
    if (redacted.skipped === 0 && (trimmed.length <= 1200 || (trimmed.length <= 2400 && characters(trimmed) <= 1200))) return { quoted: this.quote(trimmed, "", counted, true), cut: false };
    const parts = trimmed.split(/\n\s*\n/u), first = parts[0] ?? "", last = parts.length > 1 ? parts.at(-1)! : "";
    const head = characters(first) > 600 ? headUnits(first, codeUnitsOf(first, 600)) + "…" : first;
    const tail = last === "" ? tailUnits(trimmed, codeUnitsOf(trimmed, 600)) : characters(last) > 600 ? "…" + tailUnits(last, last.length - codeUnitsOf(last, characters(last) - 600)) : last;
    counted.cuts.push({ what: "reply", omitted: redacted.skipped + Math.max(0, characters(trimmed) - characters(head) - characters(tail)) });
    return { quoted: this.quote(head + "\n…\n" + tail, "", counted, true), cut: true };
  }

  /** “第 3 轮” / “来源第 2 轮” / “turn 3” / “source turn 2”. */
  turnOf(unit: Pick<RelayUnit, "turn" | "origin">): string {
    return this.zh ? (unit.origin ? "来源第 " : "第 ") + unit.turn + " 轮" : (unit.origin ? "source turn " : "turn ") + unit.turn;
  }
  /** “第 3–9 轮” / “turns 3–9”, for consecutive units of one kind. */
  turnsOf(first: Pick<RelayUnit, "turn" | "origin">, last: Pick<RelayUnit, "turn" | "origin">): string {
    if (first.turn === last.turn) return this.turnOf(first);
    return this.zh ? (first.origin ? "来源第 " : "第 ") + first.turn + "–" + last.turn + " 轮" : (first.origin ? "source turns " : "turns ") + first.turn + "–" + last.turn;
  }
  /**
   * How a unit ended: 完成, 失败（CODE）, why it was cancelled, or 结果未核实. The relay's own words: in a packet “you” is the
   * target, so the wait was the user's (m3), never the interface's 等待你的决定.
   */
  result(unit: RelayUnit, counted: Tally): string {
    const code = unit.error === null ? null : this.inline(unit.error.code, 64, counted, false);
    if (this.zh) switch (unit.status) {
      case "completed": return "完成";
      case "failed": return code === null ? "失败" : "失败（" + code + "）";
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
      case "failed": return code === null ? "failed" : "failed (" + code + ")";
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

type ToolKind = "read" | "change" | "search" | "execute" | "fetch" | "think" | "subagent" | "mcp" | "other";
export function kindOf(tool: PublicTool): ToolKind {
  switch (tool.kind) {
    case "read": return "read";
    case "edit": case "delete": case "move": return "change";
    case "search": return "search";
    case "execute": return "execute";
    case "fetch": return "fetch";
    case "think": return "think";
    case "subagent": case "task": return "subagent";
    case "mcp": return "mcp";
    default: return "other";
  }
}
/** How a tool ended, for the sentence that names it: done, failed, or not finished. */
function toolEnd(tool: PublicTool): "done" | "failed" | "open" {
  if (tool.status === "completed") return "done";
  return ["failed", "error", "declined", "rejected", "cancelled"].includes(tool.status) ? "failed" : "open";
}

/** One file a change made: where, how (created, deleted, edited, moved), and its added and removed lines when known. */
export interface FileChange { readonly path: string; readonly op: "create" | "delete" | "edit" | "move"; readonly added: number | null; readonly removed: number | null }
function diffPath(header: string): string { const path = header.replace(/\t.*$/u, "").trim(); return path === "/dev/null" ? path : path.replace(/^[ab]\//u, ""); }
/**
 * A unified diff split by file (M4): a section starts at `diff --git` or at a `---` line followed by a `+++` line; each
 * section's path, operation (`--- /dev/null` created, `+++ /dev/null` deleted) and added and removed lines (headers excluded).
 */
export function diffFiles(diff: string): readonly FileChange[] {
  const sections: { old: string | null; next: string | null; added: number; removed: number; header: boolean }[] = [];
  let current: (typeof sections)[number] | null = null;
  const lines = diff.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) { current = { old: null, next: null, added: 0, removed: 0, header: false }; sections.push(current); continue; }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      if (current === null || current.header) { current = { old: null, next: null, added: 0, removed: 0, header: false }; sections.push(current); }
      current.old = diffPath(line.slice(4)); current.next = diffPath(lines[index + 1]!.slice(4)); current.header = true; index++; continue;
    }
    if (current === null) { current = { old: null, next: null, added: 0, removed: 0, header: false }; sections.push(current); }
    if (line.startsWith("+")) current.added++; else if (line.startsWith("-")) current.removed++;
  }
  return sections.filter(section => section.added + section.removed > 0 || section.header).map(section => ({
    path: section.next !== null && section.next !== "/dev/null" ? section.next : section.old ?? "",
    op: section.old === "/dev/null" ? "create" : section.next === "/dev/null" ? "delete" : "edit", added: section.added, removed: section.removed,
  }));
}
/** Whether a location and a diff's path name one file: equal once leading slashes and `./` are dropped, or one ends the other. */
function sameFile(location: string, path: string): boolean {
  const a = location.replace(/^(?:\.\/|\/)+/u, ""), b = path.replace(/^(?:\.\/|\/)+/u, "");
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}
/**
 * The files one change tool made, from its read detail (M4): its diff split by file, each matched to one of its locations
 * (a patch over several files lists each); its locations alone when it has no diff; null when nothing was read or the
 * diff and the locations do not correspond, and the tool is then told by its title.
 */
export function changesOf(unit: RelayUnit, tool: PublicTool): readonly FileChange[] | null {
  const detail = unit.details.get(tool.id);
  if (detail === undefined) return null;
  const locations = (detail.locations ?? []).map(location => location.replace(/:\d+$/u, "")).filter(location => location !== "");
  const kindOp = tool.kind === "delete" ? "delete" : tool.kind === "move" ? "move" : null;
  const files = detail.diff === undefined ? [] : diffFiles(detail.diff).filter(file => file.path !== "");
  if (files.length === 0) return locations.length ? locations.slice(0, 16).map(path => ({ path, op: kindOp ?? "edit", added: null, removed: null })) : null;
  // One location and a diff of one file name the same change, whatever path the diff's headers give.
  if (locations.length === 1 && files.length === 1) return [{ ...files[0]!, path: locations[0]!, op: kindOp ?? files[0]!.op }];
  if (locations.length && !files.every(file => locations.some(location => sameFile(location, file.path)))) return null;
  return files.map(file => ({ ...file, path: locations.find(location => sameFile(location, file.path)) ?? file.path, op: kindOp ?? file.op }));
}
/** Where a tool read, from its detail's first location (a trailing `:line` dropped); null without one. */
function locationOf(detail: RelayToolDetail | undefined): string | null {
  const first = detail?.locations?.[0];
  return typeof first === "string" && first !== "" ? first.replace(/:\d+$/u, "") : null;
}
/** A title fully wrapped in one pair of backticks (as some drivers write commands) without them. */
function unwrapped(title: string): string { return /^`[^`]+`$/u.test(title) ? title.slice(1, -1) : title; }
/** The command a tool ran, unquoted: its detail's input when read, else its title. */
export function commandSource(unit: RelayUnit, tool: PublicTool): string {
  const input = unit.details.get(tool.id)?.input;
  return typeof input === "string" && input.trim() !== "" ? input : unwrapped(tool.title);
}

/** The words of one grade's rendering of a unit. */
export interface UnitOptions {
  /** Whether the unit's words are already quoted in the user's-words section, so a one-line rendering leaves them out. */
  readonly wordsQuoted: boolean;
  /** Whether this unit holds the newest plan of the record (only that one is shown). */
  readonly newestPlan: boolean;
  /** Whether the unit's error is shown in the status section already. */
  readonly errorShown: boolean;
  /** The most the reply may take, in tokens. */
  readonly replyCap: number;
}

/** G1: everything the unit says, in order: attachments, actions, plan, activity, outputs, error, reply (ADR-055 §5.2 N5–N18). */
export function verbatimUnit(n: Narrator, unit: RelayUnit, options: UnitOptions): Piece {
  const counted = tally(), zh = n.zh, name = n.name(unit.harnessId), out = [n.heading(unit, counted)];
  if (unit.attachments.length) out.push(attachmentLine(n, unit, counted));
  if (!unit.origin) {
    const top = unit.tools.filter(tool => tool.parentId === undefined && kindOf(tool) !== "think");
    // Only what the record holds: a Turn's tools beyond its bound and a sub-agent's own are not in it (m4).
    if (top.length === 0) out.push(zh ? "这一轮没有记录到 " + name + " 的工具调用。" : "No tool calls of " + name + " were recorded in this turn.");
    else { out.push(zh ? name + " 的操作（按发生顺序）：" : name + "'s actions, in order:"); out.push(...actionLines(n, unit, top, counted)); }
  }
  if (options.newestPlan && unit.plan !== null) out.push(planLine(n, unit.plan, counted));
  const activity = activityLine(n, unit.activities); if (activity !== null) out.push(activity);
  if (unit.outputs.length) out.push(outputLine(n, unit.outputs, counted));
  if (unit.status === "failed" && unit.error !== null && !options.errorShown) {
    const error = n.block(unit.error.message, { kind: "text", capTokens: estimateTokens("x".repeat(400)), headShare: 1, what: "error" }, counted);
    if (error !== null) out.push((zh ? "错误（" : "Error (") + n.inline(unit.error.code, 64, counted, false) + (zh ? "）原文：" : "), as reported:"), error);
  }
  const quoted = n.block(withoutThinking(unit.reply).text, { kind: "text", capTokens: options.replyCap, headShare: 0.25, what: "reply" }, counted);
  if (quoted !== null) out.push(zh ? name + " 的回复：" : name + "'s reply:", quoted);
  return piece(out.join("\n"), counted);
}
/** G2: the heading, attachments, three lines of actions (files ≤12, commands ≤8, the rest counted) and the reply's ends. */
export function compactUnit(n: Narrator, unit: RelayUnit, _options: UnitOptions): Piece {
  const counted = tally(), zh = n.zh, name = n.name(unit.harnessId), out = [n.heading(unit, counted)];
  if (unit.attachments.length) out.push(attachmentLine(n, unit, counted));
  const top = unit.tools.filter(tool => tool.parentId === undefined);
  const changes = top.filter(tool => kindOf(tool) === "change").flatMap(tool => changeItems(n, unit, tool, counted)), commands = top.filter(tool => kindOf(tool) === "execute");
  if (changes.length) out.push((zh ? "- 改动：" : "- Changes: ") + changes.slice(0, 12).join(zh ? "、" : ", ") +
    (changes.length > 12 ? (zh ? "（共 " + changes.length + " 处）" : " (" + changes.length + " in all)") : "") + (zh ? "。" : "."));
  if (commands.length) {
    const failed = commands.filter(tool => (tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed").length;
    out.push((zh ? "- 命令：" : "- Commands: ") + commands.slice(0, 8).map(tool => n.code(commandSource(unit, tool), 200, counted) + " → " + (tool.exitCode ?? "?")).join(zh ? "；" : "; ") +
      (commands.length > 8 ? (zh ? "（共 " + commands.length + " 条，" + failed + " 条失败）" : " (" + commands.length + " in all, " + failed + " failed)") : "") + (zh ? "。" : "."));
  }
  const others = countsOf(top.filter(tool => !["change", "execute", "think"].includes(kindOf(tool))), n);
  if (others !== "") out.push((zh ? "- 其他：" : "- Other: ") + others + (zh ? "。" : "."));
  const ends = n.ends(withoutThinking(unit.reply).text, counted);
  if (ends !== null) out.push(ends.cut ? (zh ? name + " 的回复（首段与末段）：" : name + "'s reply (first and last paragraphs):") : (zh ? name + " 的回复：" : name + "'s reply:"), ends.quoted);
  return piece(out.join("\n"), counted);
}
/** G3: one line of ≤400 bytes: turn, who, result, the user's first words unless quoted already, and counts. */
export function lineUnit(n: Narrator, unit: RelayUnit, options: UnitOptions): Piece {
  const zh = n.zh;
  let words = options.wordsQuoted || unit.user.trim() === "" ? 0 : 120;
  for (;;) {
    const counted = tally(), turn = n.turnOf(unit), who = n.who(unit.harnessId, unit.model), result = n.result(unit, counted);
    const counts = toolCounts(n, unit), quoted = words === 0 ? "" : n.dot(result) + (zh ? "用户：「" : "user: 「") + n.inline(unit.user, words, counted, false) + "」";
    const line = "- " + (zh ? turn : turn[0]!.toUpperCase() + turn.slice(1)) + " · " + who + n.dot(who) + result + quoted + (counts === "" ? "" : n.dot(quoted === "" ? result : "」") + counts);
    if (new TextEncoder().encode(line).byteLength <= 400 || words === 0) return { ...piece(line, counted), untrusted: 0 };
    words = words > 10 ? Math.floor(words * 0.75) : 0;
  }
}
/** A range line of ≤600 bytes for consecutive units: turns, who did how many, failures, changes and commands. */
export function rangeLine(n: Narrator, units: readonly RelayUnit[]): Piece {
  const zh = n.zh, by = new Map<string, number>(), first = units[0]!, last = units.at(-1)!;
  let unfinished = 0, changes = 0, commands = 0, failedCommands = 0;
  for (const unit of units) {
    const name = n.name(unit.harnessId); by.set(name, (by.get(name) ?? 0) + 1);
    if (unit.status !== "completed") unfinished++;
    for (const tool of unit.tools) {
      if (tool.parentId !== undefined) continue;
      const kind = kindOf(tool);
      if (kind === "change") changes++;
      if (kind === "execute") { commands++; if ((tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed") failedCommands++; }
    }
  }
  const named = [...by.entries()].slice(0, 4).map(([name, count]) => zh ? name + " " + count + " 轮" : name + " " + count).join(zh ? "、" : ", ") + (by.size > 4 ? (zh ? " 等" : ", …") : "");
  const turns = n.turnsOf(first, last);
  const head = "- " + (zh ? turns : turns[0]!.toUpperCase() + turns.slice(1)) + (zh ? "（" + named + (unfinished ? "；失败或未完成 " + unfinished + " 轮" : "") + "）" : " (" + named + (unfinished ? "; " + unfinished + " failed or unfinished" : "") + ")");
  const tail = (changes ? n.dot(head) + (zh ? "改动 " + changes + " 处" : changes + " changes") : "") +
    (commands ? (changes ? " · " : n.dot(head)) + (zh ? "执行 " + commands + " 条命令" + (failedCommands ? "（" + failedCommands + " 条失败）" : "") : commands + " commands" + (failedCommands ? " (" + failedCommands + " failed)" : "")) : "");
  return piece(head + tail, tally());
}

/** Counts of a unit's top-level tools by kind, for one-line renderings: “改动 2 处 · 执行 3 条命令（1 条失败）”. */
function toolCounts(n: Narrator, unit: RelayUnit): string {
  const zh = n.zh, top = unit.tools.filter(tool => tool.parentId === undefined);
  const changes = top.filter(tool => kindOf(tool) === "change").length, commands = top.filter(tool => kindOf(tool) === "execute");
  const failed = commands.filter(tool => (tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed").length;
  const parts: string[] = [];
  if (changes) parts.push(zh ? "改动 " + changes + " 处" : changes + " changes");
  if (commands.length) parts.push(zh ? "执行 " + commands.length + " 条命令" + (failed ? "（" + failed + " 条失败）" : "") : commands.length + " commands" + (failed ? " (" + failed + " failed)" : ""));
  if (unit.attachments.length) parts.push(zh ? "附件 " + unit.attachments.length + " 个" : unit.attachments.length + " attachments");
  return parts.join(" · ");
}
/** “读取 3 次、搜索 1 次” / “read 3, searched 1”. */
function countsOf(tools: readonly PublicTool[], n: Narrator): string {
  const order: readonly ToolKind[] = ["read", "search", "fetch", "subagent", "mcp", "other"];
  const words: Readonly<Record<string, readonly [string, string]>> = { read: ["读取", "read"], search: ["搜索", "searched"], fetch: ["获取", "fetched"], subagent: ["子 Agent", "sub-agent"], mcp: ["MCP 工具", "MCP tool"], other: ["其他操作", "other"] };
  return order.flatMap(kind => { const count = tools.filter(tool => kindOf(tool) === kind).length; return count === 0 ? [] : [n.zh ? words[kind]![0] + " " + count + " 次" : words[kind]![1] + " " + count]; }).join(n.zh ? "、" : ", ");
}
function bytesLabel(bytes: number): string { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KB" : (bytes / 1048576).toFixed(1) + " MB"; }
function attachmentLine(n: Narrator, unit: RelayUnit, counted: Tally): string {
  const zh = n.zh, items = unit.attachments.slice(0, 8).map(item => n.code(item.name, 120, counted, false) + (zh ? "（" : " (") + n.inline(item.mediaType, 80, counted, false) + (zh ? "，" : ", ") + bytesLabel(item.bytes) + (zh ? "）" : ")"));
  return (zh ? "用户附件：" : "Attachments from the user: ") + items.join(zh ? "、" : ", ") + (unit.attachments.length > 8 ? (zh ? " 等 " + unit.attachments.length + " 个" : " and " + (unit.attachments.length - 8) + " more") : "") + (zh ? "，只列名称。" : "; names only.");
}
function planLine(n: Narrator, plan: PublicPlan, counted: Tally): string {
  const zh = n.zh, done = plan.entries.filter(entry => entry.status === "completed").length, open = plan.entries.filter(entry => entry.status !== "completed");
  const listed = open.slice(0, 20).map(entry => "「" + n.inline(entry.content, 200, counted) + "」" + (entry.status === "in_progress" ? (zh ? "（进行中）" : " (in progress)") : ""));
  return (zh ? "计划（本轮结束时）：已完成 " + done + " 项" : "Plan at the end of this turn: " + done + " done") +
    (listed.length ? (zh ? "；未完成：" : "; open: ") + listed.join(zh ? "；" : "; ") + (open.length > 20 ? (zh ? " 等 " + open.length + " 项" : " and " + (open.length - 20) + " more") : "") : "") + (zh ? "。" : ".");
}
function activityLine(n: Narrator, activities: readonly PublicActivity[]): string | null {
  const zh = n.zh, count = (kind: PublicActivity["kind"]) => activities.filter(item => item.kind === kind).length;
  const parts = ([["compaction", "压缩 # 次", "# compaction(s)"], ["subagent", "子 Agent # 个", "# sub-agent(s)"], ["task", "后台任务 # 个", "# background task(s)"], ["retry", "重试 # 次", "# retry(ies)"], ["review", "审查 # 次", "# review(s)"]] as const)
    .flatMap(([kind, chinese, english]) => count(kind) ? [(zh ? chinese : english).replace("#", String(count(kind)))] : []);
  return parts.length ? (zh ? "活动：" : "Activity: ") + parts.join(zh ? "、" : ", ") + (zh ? "。" : ".") : null;
}
function outputLine(n: Narrator, outputs: readonly PublicOutput[], counted: Tally): string {
  const zh = n.zh, items = outputs.slice(0, 8).map(output => output.kind === "content"
    ? n.code(output.content.name, 120, counted) + (zh ? "（" : " (") + n.inline(output.content.mediaType, 80, counted, false) + (zh ? "，" : ", ") + bytesLabel(output.content.bytes) + (zh ? "）" : ")")
    : n.code(output.name, 120, counted) + (zh ? "（链接）" : " (link)"));
  return (zh ? "产物：" : "Outputs: ") + items.join(zh ? "、" : ", ") + (outputs.length > 8 ? (zh ? " 等 " + outputs.length + " 个" : " and " + (outputs.length - 8) + " more") : "") + (zh ? "，只列名称。" : "; names only.");
}
/** One change's files as quoted items, `path`（+a −d）, with the tool's end when it did not succeed; its title without a detail. */
function changeItems(n: Narrator, unit: RelayUnit, tool: PublicTool, counted: Tally): readonly string[] {
  const end = toolEnd(tool), status = end === "failed" ? (n.zh ? "（失败）" : " (failed)") : end === "open" ? (n.zh ? "（未完成）" : " (not finished)") : "";
  const files = changesOf(unit, tool);
  if (files === null) return [n.code(unwrapped(tool.title), 200, counted) + status];
  return files.map(file => n.code(file.path, 200, counted) + countsLabel(n, file) + status);
}
function countsLabel(n: Narrator, file: FileChange): string {
  const counts = [file.added ? "+" + file.added : "", file.removed ? "−" + file.removed : ""].filter(Boolean).join(" ");
  return counts === "" ? "" : n.zh ? "（" + counts + "）" : " (" + counts + ")";
}
const CHANGE_WORDS: Readonly<Record<FileChange["op"], readonly [string, string]>> = { create: ["新建", "created"], delete: ["删除", "deleted"], edit: ["修改", "edited"], move: ["移动", "moved"] };
/**
 * G1 actions: consecutive reads, searches and changes merged (≤8 tools a line; a patch over several files lists each file,
 * ≤16), one line per command with its output's tail. A command that names a credential file never has its output quoted
 * (ADR-055 §10.1); the sentence says so.
 */
function actionLines(n: Narrator, unit: RelayUnit, tools: readonly PublicTool[], counted: Tally): readonly string[] {
  const zh = n.zh, lines: string[] = [], sentence = (text: string) => text.slice(0, 1).toUpperCase() + text.slice(1);
  const status = (tool: PublicTool) => { const end = toolEnd(tool); return end === "failed" ? (zh ? "（失败）" : " (failed)") : end === "open" ? (zh ? "（未完成）" : " (not finished)") : ""; };
  for (let index = 0; index < tools.length;) {
    const tool = tools[index]!, kind = kindOf(tool);
    if (kind === "execute") {
      const failed = (tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed", source = commandSource(unit, tool);
      const exit = tool.exitCode !== undefined ? (zh ? " → 退出码 " + tool.exitCode : " → exit code " + tool.exitCode)
        : toolEnd(tool) === "failed" ? (zh ? " → 失败（没有报告退出码）" : " → failed (no exit code reported)") : toolEnd(tool) === "open" ? (zh ? "（未完成）" : " (not finished)") : (zh ? "（没有报告退出码）" : " (no exit code reported)");
      const output = unit.details.get(tool.id)?.output, secretFile = namesCredentialFile(source);
      const tail = !secretFile && typeof output === "string" && output.trim() !== "" ? n.outputTail(output, failed, counted) : null;
      lines.push("- " + (zh ? "执行 " : "Ran ") + n.code(source, 400, counted) + exit + (zh ? "。" : ".") + (secretFile && output !== undefined ? (zh ? "它读取凭据类文件，输出没有附上。" : " It reads a credential file; its output is not included.") : "")
        + (tail === null ? "" : (zh ? "输出末尾：" : " Output tail:") + "\n" + tail));
      index++; continue;
    }
    let end = index + 1;
    while (end < tools.length && kindOf(tools[end]!) === kind) end++;
    const group = tools.slice(index, end), shown = group.slice(0, 8), more = group.length - shown.length;
    const extra = more > 0 ? (zh ? " 等 " + group.length + " 项" : " and " + more + " more") : "";
    if (kind === "change") {
      const parts: string[] = []; let op: FileChange["op"] | null = null, members: string[] = [], listed = 0, beyond = 0;
      for (const item of shown) {
        const files = changesOf(unit, item) ?? [{ path: "", op: item.kind === "delete" ? "delete" as const : item.kind === "move" ? "move" as const : "edit" as const, added: null, removed: null }];
        for (const file of files) {
          if (listed >= 16) { beyond++; continue; }
          listed++;
          if (file.op !== op) { if (op !== null) parts.push(CHANGE_WORDS[op][zh ? 0 : 1] + " " + members.join(zh ? "、" : ", ")); op = file.op; members = []; }
          members.push((file.path === "" ? n.code(unwrapped(item.title), 200, counted) : n.code(file.path, 200, counted) + countsLabel(n, file)) + status(item));
        }
      }
      if (op !== null) parts.push(CHANGE_WORDS[op][zh ? 0 : 1] + " " + members.join(zh ? "、" : ", "));
      const files = beyond > 0 ? (zh ? "，另有 " + beyond + " 个文件" : ", and " + beyond + " more files") : "";
      lines.push("- " + (zh ? parts.join("；") : sentence(parts.join("; "))) + files + extra + (zh ? "。" : "."));
    } else {
      const items = shown.map(item => {
        const detail = unit.details.get(item.id), query = kind === "search" && typeof detail?.input === "string" && detail.input.trim() !== "" && !detail.input.includes("\n") ? detail.input : null;
        const path = kind === "read" ? locationOf(detail) : null;
        return n.code(path ?? query ?? unwrapped(item.title), 200, counted) + status(item);
      }).join(zh ? "、" : ", ");
      const words: Readonly<Record<string, readonly [string, string]>> = { read: ["读取 ", "Read "], search: ["搜索 ", "Searched "], fetch: ["获取 ", "Fetched "], subagent: ["子 Agent：", "Sub-agent: "], mcp: ["调用 MCP 工具 ", "Called MCP tool "], other: ["其他操作：", "Other: "] };
      const [chinese, english] = words[kind] ?? words.other!;
      lines.push("- " + (zh ? chinese : english) + items + extra + (kind === "fetch" ? (zh ? "，正文没有附上。" : "; content not included.") : zh ? "。" : "."));
    }
    index = end;
  }
  return lines;
}
