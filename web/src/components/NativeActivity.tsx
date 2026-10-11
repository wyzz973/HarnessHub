import { Bot, ChevronRight, Circle, CircleCheck, CircleDot, Download, FilePen, FileText, Globe, Image, Info, Layers, Link, ListChecks, LoaderCircle, Plug, Search, Terminal, TriangleAlert, Wrench } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeUsage } from "../../../src/contracts/control.js";
import type { PublicActivity, PublicNotice, PublicOutput, PublicPlan, PublicRun } from "../../../src/contracts/session.js";
import { contentUrl, errorMessage, type ToolDetailView } from "../api.js";

export type ToolDetailLoader = (content: ContentRef) => Promise<ToolDetailView>;
type Tool = NonNullable<PublicRun["tools"]>[number];

const TOOL_PENDING = new Set(["pending", "in_progress", "inProgress", "running"]);
const STATUS: Readonly<Record<string, string>> = { pending: "等待", in_progress: "执行中", inProgress: "执行中", running: "执行中", completed: "完成", failed: "失败", declined: "已拒绝", cancelled: "已取消", interrupted: "已中断" };
function compact(value: number): string { return value >= 1_000_000 ? (value / 1_000_000).toFixed(1) + "M" : value >= 1000 ? (value / 1000).toFixed(1) + "k" : String(value); }
function bytes(value: number): string { return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + " MB" : value >= 1024 ? Math.ceil(value / 1024) + " KB" : value + " B"; }
function toolIcon(kind: string | undefined): ReactNode {
  switch (kind) {
    case "execute": return <Terminal size={13} aria-hidden="true"/>;
    case "edit": case "delete": case "move": return <FilePen size={13} aria-hidden="true"/>;
    case "read": return <FileText size={13} aria-hidden="true"/>;
    case "search": return <Search size={13} aria-hidden="true"/>;
    case "fetch": return <Globe size={13} aria-hidden="true"/>;
    case "mcp": return <Plug size={13} aria-hidden="true"/>;
    case "subagent": case "think": return <Bot size={13} aria-hidden="true"/>;
    case "image": return <Image size={13} aria-hidden="true"/>;
    default: return <Wrench size={13} aria-hidden="true"/>;
  }
}
/** Unified diff with line roles for color; text stays exact for copy. */
function Diff({ text }: { text: string }) {
  return <pre className="native-diff">{text.replace(/\n$/u, "").split("\n").map((line, index) => <span key={index} className={line.startsWith("+++") || line.startsWith("---") ? "is-file" : line.startsWith("@@") ? "is-hunk" : line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-remove" : undefined}>{line + "\n"}</span>)}</pre>;
}
function ToolRow({ tool, active, loadDetail }: { tool: Tool; active: boolean; loadDetail: ToolDetailLoader | undefined }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ToolDetailView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const expandable = tool.detail !== undefined && loadDetail !== undefined;
  const toggle = () => {
    if (!expandable) return;
    const next = !open; setOpen(next);
    if (next && detail === null && !loading && tool.detail !== undefined) {
      setLoading(true); setProblem(null);
      loadDetail!(tool.detail).then(setDetail, error => setProblem(errorMessage(error))).finally(() => setLoading(false));
    }
  };
  const status = STATUS[tool.status] ?? tool.status, failed = ["failed", "declined"].includes(tool.status);
  return <li className={`native-tool ${failed ? "is-failed" : ""} ${open ? "is-open" : ""}`}>
    <button type="button" className="native-tool-head" onClick={toggle} aria-expanded={expandable ? open : undefined} disabled={!expandable} title={expandable ? "查看工具输入与输出" : active && TOOL_PENDING.has(tool.status) ? "工具执行中" : "工具没有可显示的详情"}>
      {expandable ? <ChevronRight size={12} className="native-tool-chevron" aria-hidden="true"/> : <span className="native-tool-chevron-space"/>}
      {toolIcon(tool.kind)}<span className="native-tool-title">{tool.title}</span>
      {tool.exitCode !== undefined ? <small className={tool.exitCode === 0 ? "" : "is-error"}>退出码 {tool.exitCode}</small> : null}
      <small className={failed ? "is-error" : ""}>{status}</small>
    </button>
    {open ? <div className="native-tool-detail">
      {loading ? <p className="native-muted"><LoaderCircle size={12} className="spin" aria-hidden="true"/> 读取工具详情…</p> : null}
      {problem ? <p className="native-muted is-error">{problem}</p> : null}
      {detail ? <>
        {detail.name || detail.kind ? <p className="native-muted">{[detail.name, detail.kind].filter(Boolean).join(" · ")}</p> : null}
        {detail.input ? <section><h5>输入</h5><pre>{detail.input}</pre></section> : null}
        {detail.diff ? <section><h5>改动</h5><Diff text={detail.diff}/></section> : null}
        {detail.output ? <section><h5>输出</h5><pre>{detail.output}</pre></section> : null}
        {detail.locations?.length ? <section><h5>位置</h5><ul className="native-locations">{detail.locations.map(path => <li key={path}><code>{path}</code></li>)}</ul></section> : null}
        {detail.truncated ? <p className="native-muted">内容较长，已按预算截取显示。</p> : null}
        {!detail.input && !detail.output && !detail.diff && !detail.locations?.length ? <p className="native-muted">这个工具没有返回可显示的输入或输出。</p> : null}
      </> : null}
    </div> : null}
  </li>;
}
export function ToolList({ tools, active, loadDetail }: { tools: readonly Tool[]; active: boolean; loadDetail: ToolDetailLoader | undefined }) {
  return <ul className="native-tools" aria-label="工具活动">{tools.map(tool => <ToolRow key={tool.id} tool={tool} active={active} loadDetail={loadDetail}/>)}</ul>;
}
export function PlanView({ plan }: { plan: PublicPlan }) {
  const done = plan.entries.filter(entry => entry.status === "completed").length;
  return <details className="native-plan" open>
    <summary><ListChecks size={13} aria-hidden="true"/> 计划 · {done}/{plan.entries.length} 完成</summary>
    {plan.explanation ? <p className="native-muted">{plan.explanation}</p> : null}
    <ol>{plan.entries.map((entry, index) => <li key={index} className={`is-${entry.status}`}>
      {entry.status === "completed" ? <CircleCheck size={13} aria-label="已完成"/> : entry.status === "in_progress" ? <CircleDot size={13} aria-label="进行中"/> : <Circle size={13} aria-label="待办"/>}
      <span>{entry.content}</span>{entry.priority === "high" ? <small>高优先</small> : null}
    </li>)}</ol>
  </details>;
}
export function NoticeList({ notices }: { notices: readonly PublicNotice[] }) {
  return <div className="native-notices">{notices.map((notice, index) => <div key={index} className={`native-notice is-${notice.severity}`} role={notice.severity === "error" ? "alert" : "status"}>
    {notice.severity === "info" ? <Info size={13} aria-hidden="true"/> : <TriangleAlert size={13} aria-hidden="true"/>}
    <div><strong>{notice.title}</strong>{notice.detail ? <p>{notice.detail}</p> : null}</div>
  </div>)}</div>;
}
const ACTIVITY: Readonly<Record<PublicActivity["kind"], string>> = { subagent: "子 Agent", task: "后台任务", compaction: "上下文压缩", retry: "自动重试", review: "代码审查" };
export function ActivityList({ activities }: { activities: readonly PublicActivity[] }) {
  return <ul className="native-activities" aria-label="原生活动">{activities.map(activity => <li key={activity.id} className={`is-${activity.status}`}>
    {activity.kind === "compaction" ? <Layers size={13} aria-hidden="true"/> : <Bot size={13} aria-hidden="true"/>}
    <span><strong>{ACTIVITY[activity.kind]}</strong> {activity.title}{activity.detail ? <small> · {activity.detail}</small> : null}</span>
    <small>{activity.status === "running" ? "进行中" : activity.status === "completed" ? "完成" : activity.status === "failed" ? "失败" : "已取消"}</small>
  </li>)}</ul>;
}
export function OutputList({ outputs }: { outputs: readonly PublicOutput[] }) {
  return <div className="native-outputs">{outputs.map((output, index) => output.kind === "link"
    ? <a key={index} className="native-output-chip" href={output.uri} target="_blank" rel="noopener noreferrer"><Link size={13} aria-hidden="true"/>{output.title ?? output.name}</a>
    : output.content.kind === "image"
      ? <a key={index} className="native-output-image" href={contentUrl(output.content)} target="_blank" rel="noopener noreferrer" title={output.content.name}><img src={contentUrl(output.content)} alt={output.content.name} loading="lazy"/></a>
      : <a key={index} className="native-output-chip" href={contentUrl(output.content, true)} download={output.content.name}><Download size={13} aria-hidden="true"/>{output.content.name}<small>{bytes(output.content.bytes)}</small></a>)}</div>;
}
/** Compact line under a finished reply; scopes stay explicit (turn tokens, context occupancy, cost scope). */
export function UsageLine({ usage }: { usage: NativeUsage }) {
  const parts: string[] = [];
  if (usage.turn?.input !== undefined) parts.push("输入 " + compact(usage.turn.input));
  if (usage.turn?.output !== undefined) parts.push("输出 " + compact(usage.turn.output));
  if (usage.context) parts.push("上下文 " + (usage.context.size ? Math.round(usage.context.used / usage.context.size * 100) + "%" : compact(usage.context.used)));
  if (usage.cost) parts.push((usage.cost.currency === "USD" ? "$" : usage.cost.currency + " ") + usage.cost.amount.toFixed(usage.cost.amount < 1 ? 4 : 2) + (usage.cost.scope === "session" ? "（会话累计）" : ""));
  return parts.length ? <p className="native-usage">{parts.join(" · ")}</p> : null;
}
export function UsageDetails({ usage }: { usage: NativeUsage }) {
  const turn = usage.turn;
  return <>
    {turn ? <div><dt>本轮用量</dt><dd>{[["输入", turn.input], ["输出", turn.output], ["缓存读取", turn.cachedInput], ["缓存写入", turn.cacheWrite], ["推理", turn.reasoning], ["合计", turn.total]].filter(([, value]) => value !== undefined).map(([label, value]) => label + " " + Number(value).toLocaleString()).join(" · ")}</dd></div> : null}
    {usage.context ? <div><dt>上下文</dt><dd>{usage.context.used.toLocaleString()}{usage.context.size ? " / " + usage.context.size.toLocaleString() + " tokens" : " tokens"}</dd></div> : null}
    {usage.cost ? <div><dt>费用</dt><dd>{usage.cost.amount.toFixed(4)} {usage.cost.currency} · {usage.cost.scope === "session" ? "原生会话累计" : "本轮"}</dd></div> : null}
  </>;
}
