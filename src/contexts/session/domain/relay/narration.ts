import { cancelledLabel, type PublicActivity, type PublicOutput, type PublicPlan, type PublicRun, type PublicTool, type RunStatus, type SessionSnapshot } from "../../../../contracts/session.js";
import { estimateTokens } from "./budget.js";
import { characters, codeUnitsOf, fence, headUnits, neutralize, normalize, tailUnits, visible, type RelayLanguage } from "./escape.js";
import { restoreLabels, type RelayRedactor } from "./redaction.js";

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

/** What a rendered piece costs: its estimated tokens, how many of them are model or tool text, and its redaction hits. */
export interface Piece { readonly text: string; readonly tokens: number; readonly untrusted: number; readonly hits: number }
/** Counts kept while a piece is written; `untrusted` in tokens. */
export interface Tally { hits: number; untrusted: number }

/** Inline `<think>` blocks of a reply (and an unclosed one to its end): thinking never leaves (ADR-055 §5.1). */
const THINK = /<think>[\s\S]*?(?:<\/think>|$)/giu;
export function withoutThinking(reply: string): { readonly text: string; readonly blocks: number } {
  let blocks = 0;
  const text = reply.includes("<think") || reply.includes("<THINK") ? reply.replace(THINK, () => { blocks++; return ""; }) : reply;
  return { text, blocks };
}

/** A text ready to quote: normalized, its estimate, and whether its middle was skipped unread (and how much of it). */
interface Prepared { readonly text: string; readonly tokens: number; readonly huge: boolean; readonly skipped: number; characters?: number }
/** How much of a text, around what is kept, the redactor reads (ADR-055 §5.2 N19): each kept window and 8 KiB beyond it. */
const SCAN_MARGIN = 8192;
/** A quoted text longer than twice this is read only at its two ends: no cap keeps more than 8 KiB of one text. */
const HUGE_WINDOW = 32 * 1024;

/**
 * Writes the record's sentences in one language with one redactor and one way of naming Harnesses. Every quoted string
 * goes through normalize → redaction → truncation → visible → neutralize → labels; harness text counts as untrusted.
 */
export class Narrator {
  private readonly names = new Map<string, string>();
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
  inline(raw: string, max: number, tally: Tally, untrusted = true): string {
    // Only what can be kept is read, and 8 KiB beyond it (N19).
    const window = raw.length > max * 8 + SCAN_MARGIN ? raw.slice(0, max * 8 + SCAN_MARGIN) : raw;
    const redacted = this.redactor.redact(normalize(window, "text").replace(/\t/gu, " "));
    tally.hits += redacted.hits;
    let value = redacted.text;
    if (characters(value) > max) value = headUnits(value, codeUnitsOf(value, max)) + "…";
    value = restoreLabels(neutralize(visible(value.replace(/\n/gu, "⏎")), this.language, "inline"), this.language).replace(/`/gu, "‘").replace(/\|/gu, "｜");
    if (/^[#>-]/u.test(value)) value = "·" + value;
    if (value === "") value = "∅";
    if (untrusted) tally.untrusted += estimateTokens(value);
    return value;
  }
  /** `inline` in backticks. */
  code(raw: string, max: number, tally: Tally, untrusted = true): string { return "`" + this.inline(raw, max, tally, untrusted) + "`"; }
  /** Normalized texts by kind, kept for the rendering: the fold quotes one reply at several caps. */
  private readonly normalized = { text: new Map<string, Prepared | null>(), output: new Map<string, Prepared | null>() };
  /**
   * A text normalized for quoting, with its estimate; null when nothing is left. A text far beyond any cap is read only at
   * its two ends (what can be kept, and 8 KiB beyond); its middle is left out, and counted.
   */
  private prepared(raw: string, kind: "text" | "output"): Prepared | null {
    const known = this.normalized[kind].get(raw);
    if (known !== undefined) return known;
    const huge = raw.length > 2 * HUGE_WINDOW, skipped = huge ? raw.length - 2 * HUGE_WINDOW : 0;
    const text = normalize(huge ? headUnits(raw, HUGE_WINDOW) + "\n" + tailUnits(raw, HUGE_WINDOW) : raw, kind).replace(/\n+$/u, "");
    const prepared = text.trim() === "" ? null : { text, tokens: estimateTokens(text) + (huge ? Math.ceil(skipped / 3.2) : 0), huge, skipped };
    this.normalized[kind].set(raw, prepared);
    return prepared;
  }
  /**
   * A verbatim block (N3): the text normalized, redacted and, when it is over `capTokens`, cut to a head and a tail
   * (`headShare` of what is kept goes to the head) around a line that says how much was left out; the redactor reads only
   * the kept windows and 8 KiB beyond each. Null when nothing is left to quote.
   */
  block(raw: string, options: { readonly kind: "text" | "output"; readonly capTokens: number; readonly headShare?: number; readonly indent?: string; readonly untrusted?: boolean }, tally: Tally): string | null {
    const prepared = this.prepared(raw, options.kind);
    if (prepared === null) return null;
    const { text, tokens, huge, skipped } = prepared;
    let body: string;
    if (tokens <= options.capTokens && !huge) {
      const whole = this.redactor.redact(text); tally.hits += whole.hits; body = whole.text;
    } else {
      const keep = Math.max(0, Math.floor(text.length * Math.max(0, options.capTokens) / tokens)), head = Math.floor(keep * (options.headShare ?? 0.8)), tail = keep - head;
      const front = this.redactor.redact(text.slice(0, Math.min(text.length, head + SCAN_MARGIN))), back = this.redactor.redact(text.slice(Math.max(0, text.length - tail - SCAN_MARGIN)));
      tally.hits += front.hits + back.hits;
      const kept = headUnits(front.text, head), ending = tailUnits(back.text, tail);
      const omitted = skipped + Math.max(0, (prepared.characters ??= characters(text)) - characters(text.slice(0, head)) - characters(text.slice(text.length - tail)));
      body = (kept === "" ? "" : kept + "\n") + (this.zh ? "…（中间省略 " + omitted + " 字）…" : "… (" + omitted + " characters omitted) …") + (ending === "" ? "" : "\n" + ending);
    }
    const quoted = fence(restoreLabels(neutralize(visible(body), this.language, "block"), this.language), options.indent ?? "");
    if (options.untrusted !== false) tally.untrusted += estimateTokens(quoted);
    return quoted;
  }
  /** The last lines of a command's output: 20 lines and 1,200 characters when it failed, 3 lines and 300 bytes otherwise. */
  outputTail(output: string, failed: boolean, tally: Tally): string | null {
    const lines = normalize(output, "output").replace(/\n+$/u, "").split("\n");
    let tail = lines.slice(-(failed ? 20 : 3)).join("\n").replace(/^(?:[ \t]*\n)+/u, "");
    const limit = failed ? 1200 : 300;
    while (tail !== "" && (failed ? characters(tail) : new TextEncoder().encode(tail).byteLength) > limit) tail = tail.slice(tail.indexOf("\n") >= 0 ? tail.indexOf("\n") + 1 : Math.ceil(tail.length / 4));
    return this.block(tail, { kind: "output", capTokens: Number.MAX_SAFE_INTEGER, indent: "  " }, tally);
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
  /** How a unit ended: 完成, 失败（CODE）, why it was cancelled, or 结果未核实. */
  result(unit: RelayUnit, tally: Tally): string {
    const code = unit.error === null ? null : this.inline(unit.error.code, 64, tally, false);
    if (this.zh) switch (unit.status) {
      case "completed": return "完成";
      case "failed": return code === null ? "失败" : "失败（" + code + "）";
      case "cancelled": return cancelledLabel({ error: unit.error, cancelRequested: unit.cancelRequested });
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
  heading(unit: RelayUnit, tally: Tally): string {
    const turn = this.turnOf(unit), who = this.who(unit.harnessId, unit.model);
    return "### " + (this.zh ? turn : turn[0]!.toUpperCase() + turn.slice(1)) + " · " + who + this.dot(who) + this.result(unit, tally);
  }
}

type ToolKind = "read" | "change" | "search" | "execute" | "fetch" | "think" | "subagent" | "mcp" | "other";
function kindOf(tool: PublicTool): ToolKind {
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
/** A diff's change: created, deleted or modified, with its added and removed line counts (headers excluded). */
export function diffChange(diff: string): { readonly op: "create" | "delete" | "edit"; readonly added: number; readonly removed: number } {
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++; else if (line.startsWith("-")) removed++;
  }
  return { op: /^--- \/dev\/null$/mu.test(diff) ? "create" : /^\+\+\+ \/dev\/null$/mu.test(diff) ? "delete" : "edit", added, removed };
}
/** Where a tool worked, from its detail's first location (a trailing `:line` dropped); null without one. */
function locationOf(detail: RelayToolDetail | undefined): string | null {
  const first = detail?.locations?.[0];
  return typeof first === "string" && first !== "" ? first.replace(/:\d+$/u, "") : null;
}
/** A title fully wrapped in one pair of backticks (as some drivers write commands) without them. */
function unwrapped(title: string): string { return /^`[^`]+`$/u.test(title) ? title.slice(1, -1) : title; }

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
  const tally: Tally = { hits: 0, untrusted: 0 }, zh = n.zh, name = n.name(unit.harnessId), out = [n.heading(unit, tally)];
  if (unit.attachments.length) out.push(attachmentLine(n, unit, tally));
  if (!unit.origin) {
    const top = unit.tools.filter(tool => tool.parentId === undefined && kindOf(tool) !== "think");
    if (top.length === 0) out.push(zh ? name + " 这一轮没有调用工具。" : name + " used no tools in this turn.");
    else { out.push(zh ? name + " 的操作（按发生顺序）：" : name + "'s actions, in order:"); out.push(...actionLines(n, unit, top, tally)); }
  }
  if (options.newestPlan && unit.plan !== null) out.push(planLine(n, unit.plan, tally));
  const activity = activityLine(n, unit.activities); if (activity !== null) out.push(activity);
  if (unit.outputs.length) out.push(outputLine(n, unit.outputs, tally));
  if (unit.status === "failed" && unit.error !== null && !options.errorShown) {
    const error = n.block(unit.error.message, { kind: "text", capTokens: estimateTokens("x".repeat(400)), headShare: 1 }, tally);
    if (error !== null) out.push((zh ? "错误（" : "Error (") + n.inline(unit.error.code, 64, tally, false) + (zh ? "）原文：" : "), as reported:"), error);
  }
  const reply = withoutThinking(unit.reply).text, quoted = n.block(reply, { kind: "text", capTokens: options.replyCap, headShare: 0.25 }, tally);
  if (quoted !== null) out.push(zh ? name + " 的回复：" : name + "'s reply:", quoted);
  const text = out.join("\n");
  return { text, tokens: estimateTokens(text), untrusted: tally.untrusted, hits: tally.hits };
}
/** G2: the heading, attachments, three lines of actions (files ≤12, commands ≤8, the rest counted) and the reply's ends. */
export function compactUnit(n: Narrator, unit: RelayUnit, _options: UnitOptions): Piece {
  const tally: Tally = { hits: 0, untrusted: 0 }, zh = n.zh, name = n.name(unit.harnessId), out = [n.heading(unit, tally)];
  if (unit.attachments.length) out.push(attachmentLine(n, unit, tally));
  const top = unit.tools.filter(tool => tool.parentId === undefined);
  const changes = top.filter(tool => kindOf(tool) === "change"), commands = top.filter(tool => kindOf(tool) === "execute");
  if (changes.length) out.push((zh ? "- 改动：" : "- Changes: ") + changes.slice(0, 12).map(tool => changeItem(n, unit, tool, tally)).join(zh ? "、" : ", ") +
    (changes.length > 12 ? (zh ? "（共 " + changes.length + " 处）" : " (" + changes.length + " in all)") : "") + (zh ? "。" : "."));
  if (commands.length) {
    const failed = commands.filter(tool => (tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed").length;
    out.push((zh ? "- 命令：" : "- Commands: ") + commands.slice(0, 8).map(tool => commandText(n, unit, tool, tally, 200) + " → " + (tool.exitCode ?? "?")).join(zh ? "；" : "; ") +
      (commands.length > 8 ? (zh ? "（共 " + commands.length + " 条，" + failed + " 条失败）" : " (" + commands.length + " in all, " + failed + " failed)") : "") + (zh ? "。" : "."));
  }
  const others = countsOf(top.filter(tool => !["change", "execute", "think"].includes(kindOf(tool))), n);
  if (others !== "") out.push((zh ? "- 其他：" : "- Other: ") + others + (zh ? "。" : "."));
  const reply = withoutThinking(unit.reply).text;
  const ends = paragraphs(reply.length > 2 * HUGE_WINDOW ? headUnits(reply, HUGE_WINDOW) + "\n\n" + tailUnits(reply, HUGE_WINDOW) : reply);
  const quoted = n.block(ends.text, { kind: "text", capTokens: estimateTokens(ends.text) + 1 }, tally);
  if (quoted !== null) out.push(ends.cut ? (zh ? name + " 的回复（首段与末段）：" : name + "'s reply (first and last paragraphs):") : (zh ? name + " 的回复：" : name + "'s reply:"), quoted);
  const text = out.join("\n");
  return { text, tokens: estimateTokens(text), untrusted: tally.untrusted, hits: tally.hits };
}
/** G3: one line of ≤400 bytes: turn, who, result, the user's first words unless quoted already, and counts. */
export function lineUnit(n: Narrator, unit: RelayUnit, options: UnitOptions): Piece {
  const zh = n.zh;
  let words = options.wordsQuoted || unit.user.trim() === "" ? 0 : 120;
  for (;;) {
    const tally: Tally = { hits: 0, untrusted: 0 }, turn = n.turnOf(unit), who = n.who(unit.harnessId, unit.model), result = n.result(unit, tally);
    const counts = toolCounts(n, unit), quoted = words === 0 ? "" : n.dot(result) + (zh ? "用户：「" : "user: 「") + n.inline(unit.user, words, tally, false) + "」";
    const line = "- " + (zh ? turn : turn[0]!.toUpperCase() + turn.slice(1)) + " · " + who + n.dot(who) + result + quoted + (counts === "" ? "" : n.dot(quoted === "" ? result : "」") + counts);
    if (new TextEncoder().encode(line).byteLength <= 400 || words === 0) return { text: line, tokens: estimateTokens(line), untrusted: 0, hits: tally.hits };
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
  const text = head + tail;
  return { text, tokens: estimateTokens(text), untrusted: 0, hits: 0 };
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
function attachmentLine(n: Narrator, unit: RelayUnit, tally: Tally): string {
  const zh = n.zh, items = unit.attachments.slice(0, 8).map(item => n.code(item.name, 120, tally, false) + (zh ? "（" : " (") + n.inline(item.mediaType, 80, tally, false) + (zh ? "，" : ", ") + bytesLabel(item.bytes) + (zh ? "）" : ")"));
  return (zh ? "用户附件：" : "Attachments from the user: ") + items.join(zh ? "、" : ", ") + (unit.attachments.length > 8 ? (zh ? " 等 " + unit.attachments.length + " 个" : " and " + (unit.attachments.length - 8) + " more") : "") + (zh ? "，只列名称。" : "; names only.");
}
function planLine(n: Narrator, plan: PublicPlan, tally: Tally): string {
  const zh = n.zh, done = plan.entries.filter(entry => entry.status === "completed").length, open = plan.entries.filter(entry => entry.status !== "completed");
  const listed = open.slice(0, 20).map(entry => "「" + n.inline(entry.content, 200, tally) + "」" + (entry.status === "in_progress" ? (zh ? "（进行中）" : " (in progress)") : ""));
  return (zh ? "计划（本轮结束时）：已完成 " + done + " 项" : "Plan at the end of this turn: " + done + " done") +
    (listed.length ? (zh ? "；未完成：" : "; open: ") + listed.join(zh ? "；" : "; ") + (open.length > 20 ? (zh ? " 等 " + open.length + " 项" : " and " + (open.length - 20) + " more") : "") : "") + (zh ? "。" : ".");
}
function activityLine(n: Narrator, activities: readonly PublicActivity[]): string | null {
  const zh = n.zh, count = (kind: PublicActivity["kind"]) => activities.filter(item => item.kind === kind).length;
  const parts = ([["compaction", "压缩 # 次", "# compaction(s)"], ["subagent", "子 Agent # 个", "# sub-agent(s)"], ["task", "后台任务 # 个", "# background task(s)"], ["retry", "重试 # 次", "# retry(ies)"], ["review", "审查 # 次", "# review(s)"]] as const)
    .flatMap(([kind, chinese, english]) => count(kind) ? [(zh ? chinese : english).replace("#", String(count(kind)))] : []);
  return parts.length ? (zh ? "活动：" : "Activity: ") + parts.join(zh ? "、" : ", ") + (zh ? "。" : ".") : null;
}
function outputLine(n: Narrator, outputs: readonly PublicOutput[], tally: Tally): string {
  const zh = n.zh, items = outputs.slice(0, 8).map(output => output.kind === "content"
    ? n.code(output.content.name, 120, tally) + (zh ? "（" : " (") + n.inline(output.content.mediaType, 80, tally, false) + (zh ? "，" : ", ") + bytesLabel(output.content.bytes) + (zh ? "）" : ")")
    : n.code(output.name, 120, tally) + (zh ? "（链接）" : " (link)"));
  return (zh ? "产物：" : "Outputs: ") + items.join(zh ? "、" : ", ") + (outputs.length > 8 ? (zh ? " 等 " + outputs.length + " 个" : " and " + (outputs.length - 8) + " more") : "") + (zh ? "，只列名称。" : "; names only.");
}
/** A command's text: its detail's input when read, else its title (without one wrapping pair of backticks). */
function commandText(n: Narrator, unit: RelayUnit, tool: PublicTool, tally: Tally, max = 400): string {
  const input = unit.details.get(tool.id)?.input;
  return n.code(typeof input === "string" && input.trim() !== "" ? input : unwrapped(tool.title), max, tally);
}
function changeItem(n: Narrator, unit: RelayUnit, tool: PublicTool, tally: Tally): string {
  const detail = unit.details.get(tool.id), path = locationOf(detail), change = detail?.diff === undefined ? null : diffChange(detail.diff);
  const counts = change === null ? "" : [change.added ? "+" + change.added : "", change.removed ? "−" + change.removed : ""].filter(Boolean).join(" ");
  const end = toolEnd(tool);
  return n.code(path ?? unwrapped(tool.title), 200, tally) + (counts === "" ? "" : n.zh ? "（" + counts + "）" : " (" + counts + ")") +
    (end === "failed" ? (n.zh ? "（失败）" : " (failed)") : end === "open" ? (n.zh ? "（未完成）" : " (not finished)") : "");
}
const CHANGE_WORDS: Readonly<Record<"create" | "delete" | "edit" | "move", readonly [string, string]>> = { create: ["新建", "created"], delete: ["删除", "deleted"], edit: ["修改", "edited"], move: ["移动", "moved"] };
/** G1 actions: consecutive reads, searches and changes merged (≤8 items a line), one line per command with its output's tail. */
function actionLines(n: Narrator, unit: RelayUnit, tools: readonly PublicTool[], tally: Tally): readonly string[] {
  const zh = n.zh, lines: string[] = [], sentence = (text: string) => text.slice(0, 1).toUpperCase() + text.slice(1);
  const status = (tool: PublicTool) => { const end = toolEnd(tool); return end === "failed" ? (zh ? "（失败）" : " (failed)") : end === "open" ? (zh ? "（未完成）" : " (not finished)") : ""; };
  for (let index = 0; index < tools.length;) {
    const tool = tools[index]!, kind = kindOf(tool);
    if (kind === "execute") {
      const failed = (tool.exitCode !== undefined && tool.exitCode !== 0) || toolEnd(tool) === "failed";
      const exit = tool.exitCode !== undefined ? (zh ? " → 退出码 " + tool.exitCode : " → exit code " + tool.exitCode)
        : toolEnd(tool) === "failed" ? (zh ? " → 失败（没有报告退出码）" : " → failed (no exit code reported)") : toolEnd(tool) === "open" ? (zh ? "（未完成）" : " (not finished)") : (zh ? "（没有报告退出码）" : " (no exit code reported)");
      const output = unit.details.get(tool.id)?.output, tail = typeof output === "string" && output.trim() !== "" ? n.outputTail(output, failed, tally) : null;
      lines.push("- " + (zh ? "执行 " : "Ran ") + commandText(n, unit, tool, tally) + exit + (zh ? "。" : ".") + (tail === null ? "" : (zh ? "输出末尾：" : " Output tail:") + "\n" + tail));
      index++; continue;
    }
    let end = index + 1;
    while (end < tools.length && kindOf(tools[end]!) === kind) end++;
    const group = tools.slice(index, end), shown = group.slice(0, 8), more = group.length - shown.length;
    const extra = more > 0 ? (zh ? " 等 " + group.length + " 项" : " and " + more + " more") : "";
    if (kind === "change") {
      const parts: string[] = []; let op: string | null = null, members: string[] = [];
      for (const item of shown) {
        const detail = unit.details.get(item.id), itemOp = item.kind === "delete" ? "delete" : item.kind === "move" ? "move" : detail?.diff === undefined ? "edit" : diffChange(detail.diff).op;
        if (itemOp !== op) { if (op !== null) parts.push(CHANGE_WORDS[op as keyof typeof CHANGE_WORDS][zh ? 0 : 1] + " " + members.join(zh ? "、" : ", ")); op = itemOp; members = []; }
        members.push(changeItem(n, unit, item, tally));
      }
      if (op !== null) parts.push(CHANGE_WORDS[op as keyof typeof CHANGE_WORDS][zh ? 0 : 1] + " " + members.join(zh ? "、" : ", "));
      lines.push("- " + (zh ? parts.join("；") : sentence(parts.join("; "))) + extra + (zh ? "。" : "."));
    } else {
      const items = shown.map(item => {
        const detail = unit.details.get(item.id), query = kind === "search" && typeof detail?.input === "string" && detail.input.trim() !== "" && !detail.input.includes("\n") ? detail.input : null;
        const path = kind === "read" ? locationOf(detail) : null;
        return n.code(path ?? query ?? unwrapped(item.title), 200, tally) + status(item);
      }).join(zh ? "、" : ", ");
      const words: Readonly<Record<string, readonly [string, string]>> = { read: ["读取 ", "Read "], search: ["搜索 ", "Searched "], fetch: ["获取 ", "Fetched "], subagent: ["子 Agent：", "Sub-agent: "], mcp: ["调用 MCP 工具 ", "Called MCP tool "], other: ["其他操作：", "Other: "] };
      const [chinese, english] = words[kind] ?? words.other!;
      lines.push("- " + (zh ? chinese : english) + items + extra + (kind === "fetch" ? (zh ? "，正文没有附上。" : "; content not included.") : zh ? "。" : "."));
    }
    index = end;
  }
  return lines;
}
/** A reply's first and last paragraphs, each ≤600 characters (G2); `cut` when anything between them was left out. */
function paragraphs(reply: string): { readonly text: string; readonly cut: boolean } {
  const trimmed = reply.trim();
  // At most two UTF-16 units a character: a short text needs no count.
  if (trimmed.length <= 1200 || (trimmed.length <= 2400 && characters(trimmed) <= 1200)) return { text: trimmed, cut: false };
  const parts = trimmed.split(/\n\s*\n/u), first = parts[0] ?? "", last = parts.length > 1 ? parts.at(-1)! : "";
  const head = characters(first) > 600 ? headUnits(first, codeUnitsOf(first, 600)) + "…" : first;
  const tail = last === "" ? tailUnits(trimmed, codeUnitsOf(trimmed, 600)) : characters(last) > 600 ? "…" + tailUnits(last, last.length - codeUnitsOf(last, characters(last) - 600)) : last;
  return { text: head + "\n…\n" + tail, cut: true };
}
