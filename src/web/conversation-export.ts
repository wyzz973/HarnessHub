import type { ConversationReader, TurnItems } from "../contracts/conversation.js";
import { statusText, turnFacts } from "../contracts/protocol-lines.js";
import type { ReadTurn } from "../contracts/protocol-read.js";
import { ITEM_STATUS_WORDS } from "../contracts/protocol-words.js";
import type { WorkItem } from "../contracts/protocol.js";
import type { PublicRun, SessionId } from "../contracts/session.js";
import type { SessionView, WireTurn } from "../contracts/web.js";
import { turnRecord } from "../contexts/session/domain/turn-source.js";

function bytes(value: number): string { return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + " MB" : value >= 1024 ? Math.ceil(value / 1024) + " KB" : value + " B"; }
/** Text is quoted as-is; only a line that would close the surrounding fence is indented. */
function fenced(text: string): string { return text.replace(/^(\s*)(```)/gmu, "$1 $2"); }
/** The first line of a text, for a line of a list. */
function firstLine(text: string): string { const first = text.split("\n").map(line => line.trim()).find(Boolean) ?? ""; return first.length > 160 ? first.slice(0, 159) + "…" : first; }
const WORK_TYPES: ReadonlySet<string> = new Set(["command", "file_read", "file_change", "search", "web", "mcp_tool", "tool", "subagent"]);

/** What an action did, as one line of a list, from the protocol's own fields; the program's tool names and the stored detail bodies stay out. */
function actionLine(item: WorkItem): string {
  switch (item.type) {
    case "command": return "运行 " + (firstLine(item.command) || "一条命令") + (item.exitCode === undefined || item.exitCode === 0 ? "" : "，退出码 " + item.exitCode);
    case "file_read": return "读取 " + (item.path ?? "一个文件");
    case "file_change": return (item.changes.length && item.changes.every(change => change.op === "create") ? "新建 " : item.changes.length && item.changes.every(change => change.op === "delete") ? "删除 " : "修改 ") + (item.changes.map(change => change.path).join("、") || "文件");
    case "search": return "搜索 " + (item.query ? firstLine(item.query) : item.scope === "files" ? "文件" : "代码");
    case "web": return item.action === "search" ? "搜索网页 " + (item.query ? firstLine(item.query) : "") : "读取网页 " + (item.url ?? item.title ?? "");
    case "mcp_tool": return item.hub ? "查阅对话记录" : "使用 " + [item.server, item.tool].filter(Boolean).join("：");
    case "tool": return "使用 " + item.name;
    case "subagent": return "子任务 " + firstLine(item.title);
  }
}
/** A Turn's facts under its reply, all read from the protocol Turn, in the words the page uses: the task list, the actions, the products, the Turn's numbers and its error. */
function factsOf(turn: ReadTurn): string[] {
  const lines: string[] = [], plan = turn.items.findLast(item => item.type === "plan" && item.steps.length > 0);
  if (plan?.type === "plan") lines.push("计划：", ...plan.steps.map(step => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`));
  const work = turn.items.filter((item): item is WorkItem => WORK_TYPES.has(item.type));
  if (work.length) lines.push("步骤：", ...work.map(item => `- ${actionLine(item)}（${ITEM_STATUS_WORDS[item.status]}）`));
  const products = turn.items.flatMap(item => item.type === "artifact" ? [item] : []);
  if (products.length) lines.push("产物：", ...products.map(item => item.content !== undefined && item.kind !== "link" ? `- ${item.content.name}（${item.content.mediaType}，${bytes(item.content.bytes)}）` : `- ${item.name}${item.uri === undefined ? "" : "：" + item.uri}`));
  const numbers = turnFacts(turn);
  if (numbers.length) lines.push("统计：" + numbers.join(" · "));
  for (const item of turn.items) if (item.type === "error" && !foldedError(turn, item)) lines.push(`错误：${item.code === undefined ? "" : item.code + " "}${item.message}`);
  return lines;
}
/** A failure the Turn also reports as its own error (`hh:error`) is told once, as the page tells it: the error notices the Harness told as items stand behind it. */
function foldedError(turn: ReadTurn, item: { readonly id: string }): boolean { return item.id !== "hh:error" && turn.items.some(other => other.id === "hh:error"); }
/** The heading of a Harness's part: who answered, with which model, and how the Turn stands. */
function heading(turn: ReadTurn): string {
  return `## ${turn.executor.harness}${turn.executor.model === undefined ? "" : "（" + turn.executor.model.label + "）"} · ${statusText(turn)}`;
}
/** A Run the view has no Turn for: it is named and said to have none, never worded from anything else. */
function withoutTurn(run: PublicRun, harnessName: (id: string) => string): string[] { return [`## ${harnessName(run.selection.harnessId)} · 这一轮没有协议数据`, ""]; }

/**
 * The public conversation as Markdown: committed messages in order with their Turn's facts, worded as the page words them (state, model,
 * time and usage included). Private native state, tool detail bodies and stored bytes are not included; attachments and products are
 * listed by name. (This reads the conversation's old whole shape, as the web server still gives it; `exportMarkdown` below reads rows,
 * a Turn at a time, and is what replaces it.)
 */
export function conversationMarkdown(view: SessionView, harnessName: (id: string) => string, exportedAt: Date): string {
  const runs = new Map(view.runs.map(run => [run.id, run])), title = view.messages.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim().slice(0, 80) || "新对话";
  const out = [`# ${title}`, "", `- 导出时间：${exportedAt.toISOString()}`, `- 工作区：${view.workspace}`, `- 会话：${view.id}（${view.status}）`, ""];
  for (const message of [...view.messages].sort((a, b) => a.seq - b.seq)) {
    const run = runs.get(message.runId);
    if (message.role === "user") {
      out.push("---", "", "## 你", "", "```text", fenced(message.text), "```", "");
      if (run?.attachments?.length) out.push("附件：", ...run.attachments.map(item => `- ${item.name}（${item.mediaType}，${bytes(item.bytes)}）`), "");
      // A Run that produced no reply message (failed before output, still queued) keeps its status and facts in place.
      if (run && !view.messages.some(row => row.runId === run.id && row.role === "assistant")) out.push(...(run.protocol === undefined ? withoutTurn(run, harnessName) : [heading(run.protocol), "", ...factsOf(run.protocol), ""]));
      continue;
    }
    if (run?.protocol === undefined) { out.push(...(run === undefined ? ["## Harness", ""] : withoutTurn(run, harnessName)), message.text, ""); continue; }
    out.push(heading(run.protocol), "", message.text, "");
    const facts = factsOf(run.protocol);
    if (facts.length) out.push(...facts, "");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// From rows, a Turn at a time
// ---------------------------------------------------------------------------------------------------------------------------------

/** What a Turn from before the Hub recorded the order things happened in is told with in an export: its parts stand in a fixed arrangement. */
export const LEGACY_ORDER_LINE = "> 这一轮各部分的顺序是固定排列，不是发生的先后。";
/** A conversation as the export reads it: its head, and its Turns, one at a time, whole. */
export interface ExportSource {
  readonly id: SessionId;
  readonly workspace: string;
  readonly status: string;
  readonly count: number;
  /** One Turn as the rows hold it, every item with its whole text; null when there is none at the place. */
  read(ordinal: number): TurnItems | null;
  /** The protocol's Turn of what `read` gave (`TurnView.turn`, src/web/turn-view.ts): its header and its items in the order of their places. */
  wire(read: TurnItems): WireTurn;
}
/** A conversation kept as rows, read for an export through a `TurnView`. */
export function rowsExport(reader: Pick<ConversationReader, "head" | "turnAt">, id: SessionId, view: { turn(read: TurnItems): WireTurn }): ExportSource {
  const head = reader.head(id);
  return { id, workspace: head.head.configuration.workspace, status: head.status, count: head.runCount, read: ordinal => reader.turnAt(id, ordinal, { inlineBytes: Infinity }), wire: read => view.turn(read) };
}

/** The steps, products and the like of a Turn as the lines they stand in, in the order of their places: the words of the Harness between them, a list for each stretch of its work. */
function inOrder(turn: ReadTurn): string[] {
  const lines: string[] = [];
  let open: "work" | "product" | null = null;
  const close = (): void => { if (open !== null) { lines.push(""); open = null; } };
  for (const item of turn.items) {
    if (WORK_TYPES.has(item.type)) {
      if (open !== "work") { close(); lines.push("步骤："); open = "work"; }
      lines.push(`- ${actionLine(item as WorkItem)}（${ITEM_STATUS_WORDS[item.status]}）`);
    } else if (item.type === "artifact") {
      if (open !== "product") { close(); lines.push("产物："); open = "product"; }
      lines.push(item.content !== undefined && item.kind !== "link" ? `- ${item.content.name}（${item.content.mediaType}，${bytes(item.content.bytes)}）` : `- ${item.name}${item.uri === undefined ? "" : "：" + item.uri}`);
    } else if (item.type === "assistant_message") {
      close();
      if (item.text !== undefined && item.text !== "") lines.push(item.text, "");
    } else if (item.type === "plan") {
      close();
      if (item.steps.length) lines.push("计划：", ...item.steps.map(step => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`), "");
    } else if (item.type === "error") {
      close();
      if (!foldedError(turn, item)) lines.push(`错误：${item.code === undefined ? "" : item.code + " "}${item.message}`);
    }
  }
  close();
  const numbers = turnFacts(turn);
  if (numbers.length) lines.push("统计：" + numbers.join(" · "), "");
  return lines;
}

/**
 * The public conversation as Markdown, a Turn at a time: each yield is the text of one piece (the head, then one Turn after another), and the pieces written one after the other are
 * `conversationMarkdown` of the same conversation. Nothing but the Turn being written is held. A Turn from before the order was recorded
 * is written as it always was (the words of the reply, then its plan, steps, products, numbers and errors) with a line that says its parts stand in a fixed arrangement; a Turn that has the
 * order writes what it did in the order it did it: the words, the steps after them, the words after those.
 */
export function* exportMarkdown(source: ExportSource, exportedAt: Date): Generator<string> {
  const first = source.count > 0 ? source.read(0) : null, said = first === null ? "" : turnRecord(first).user.text.replace(/\s+/gu, " ").trim().slice(0, 80);
  yield [`# ${said || "新对话"}`, "", `- 导出时间：${exportedAt.toISOString()}`, `- 工作区：${source.workspace}`, `- 会话：${source.id}（${source.status}）`, ""].join("\n");
  for (let ordinal = 0; ordinal < source.count; ordinal++) {
    const read = ordinal === 0 ? first : source.read(ordinal);
    if (read === null) continue;
    const record = turnRecord(read), wire = source.wire(read), turn: ReadTurn = { ...wire.run.turn, items: wire.items };
    const out = ["---", "", "## 你", "", "```text", fenced(record.user.text), "```", ""];
    const attachments = wire.run.attachments ?? [];
    if (attachments.length) out.push("附件：", ...attachments.map(item => `- ${item.name}（${item.mediaType}，${bytes(item.bytes)}）`), "");
    if (read.run.legacyOrder) {
      out.push(heading(turn), "", LEGACY_ORDER_LINE, "");
      if (record.assistant === undefined) out.push(...factsOf(turn), "");
      else { out.push(record.assistant.text, ""); const facts = factsOf(turn); if (facts.length) out.push(...facts, ""); }
    } else out.push(heading(turn), "", ...inOrder(turn));
    yield "\n" + out.join("\n");
  }
}
