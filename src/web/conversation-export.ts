import { statusText, turnFacts } from "../contracts/protocol-lines.js";
import type { ReadTurn } from "../contracts/protocol-read.js";
import { ITEM_STATUS_WORDS } from "../contracts/protocol-words.js";
import type { WorkItem } from "../contracts/protocol.js";
import type { PublicRun } from "../contracts/session.js";
import type { SessionView } from "../contracts/web.js";

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
  for (const item of turn.items) if (item.type === "error") lines.push(`错误：${item.code === undefined ? "" : item.code + " "}${item.message}`);
  return lines;
}
/** The heading of a Harness's part: who answered, with which model, and how the Turn stands. */
function heading(turn: ReadTurn): string {
  return `## ${turn.executor.harness}${turn.executor.model === undefined ? "" : "（" + turn.executor.model.label + "）"} · ${statusText(turn)}`;
}
/** A Run the view has no Turn for: it is named and said to have none, never worded from anything else. */
function withoutTurn(run: PublicRun, harnessName: (id: string) => string): string[] { return [`## ${harnessName(run.selection.harnessId)} · 这一轮没有协议数据`, ""]; }

/**
 * The public conversation as Markdown: committed messages in order with their Turn's facts, worded as the page words them (state, model,
 * time and usage included). Private native state, tool detail bodies and stored bytes are not included; attachments and products are
 * listed by name.
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
