import type { PublicRun } from "../contracts/session.js";
import type { SessionView } from "../contracts/web.js";

const STATUS: Readonly<Record<string, string>> = { queued: "等待", preparing: "准备中", running: "进行中", settling: "结束中", completed: "完成", cancelled: "已停止", failed: "失败", unknown: "结果未核实" };
function bytes(value: number): string { return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + " MB" : value >= 1024 ? Math.ceil(value / 1024) + " KB" : value + " B"; }
/** Text is quoted as-is; only a line that would close the surrounding fence is indented. */
function fenced(text: string): string { return text.replace(/^(\s*)(```)/gmu, "$1 $2"); }
function runFacts(run: PublicRun): string[] {
  const lines: string[] = [];
  if (run.plan?.entries.length) lines.push("计划：", ...run.plan.entries.map(entry => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`));
  if (run.tools?.length) lines.push("工具：", ...run.tools.map(tool => `- ${tool.title}（${tool.status}${tool.exitCode === undefined ? "" : "，退出码 " + tool.exitCode}）`));
  if (run.activities?.length) lines.push("活动：", ...run.activities.map(activity => `- ${activity.title}（${activity.status}）`));
  if (run.outputs?.length) lines.push("产物：", ...run.outputs.map(output => output.kind === "link" ? `- ${output.title ?? output.name}：${output.uri}` : `- ${output.content.name}（${output.content.mediaType}，${bytes(output.content.bytes)}）`));
  const turn = run.usage?.turn;
  if (turn && (turn.input !== undefined || turn.output !== undefined)) lines.push(`用量：输入 ${turn.input ?? "—"} · 输出 ${turn.output ?? "—"}`);
  if (run.error) lines.push(`错误：${run.error.code} ${run.error.message}`);
  return lines;
}

/**
 * The public conversation as Markdown: committed messages in order with their Run facts. Private native state, tool
 * detail bodies and stored bytes are not included; attachments and outputs are listed by name.
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
      if (run && !view.messages.some(row => row.runId === run.id && row.role === "assistant")) out.push(`## ${harnessName(run.selection.harnessId)} · ${STATUS[run.status] ?? run.status}`, "", ...runFacts(run), "");
      continue;
    }
    const selection = run?.selection, model = selection?.provider?.model ?? selection?.nativeModel;
    out.push(`## ${selection ? harnessName(selection.harnessId) : "Harness"}${model ? "（" + model + "）" : ""} · ${STATUS[run?.status ?? message.status] ?? message.status}`, "", message.text, "");
    if (run) { const facts = runFacts(run); if (facts.length) out.push(...facts, ""); }
  }
  return out.join("\n");
}
