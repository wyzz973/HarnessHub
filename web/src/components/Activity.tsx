import { Bot, ChevronRight, Download, FilePen, FileText, Globe, Image, Info, Layers, Link, ListChecks, Plug, Search, Terminal, TriangleAlert, Wrench } from "lucide-react";
import { memo, useState } from "react";
import type { ReactNode } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeUsage } from "../../../src/contracts/control.js";
import type { PublicActivity, PublicNotice, PublicOutput, PublicPlan } from "../../../src/contracts/session.js";
import { contentUrl, errorMessage, type ToolDetailView } from "../api.js";
import { cn } from "../lib/cn.js";
import { bytes, compact } from "../lib/format.js";
import { parseUnifiedDiff, TOOL_PENDING, TOOL_STATUS, toolFailed, toolSummary, toolTree, toolUnfinished, type Tool } from "../lib/turn.js";
import { Spinner } from "../ui/primitives.js";

export type ToolDetailLoader = (content: ContentRef) => Promise<ToolDetailView>;

export function toolIcon(kind: string | undefined, size = 14): ReactNode {
  switch (kind) {
    case "execute": return <Terminal size={size} aria-hidden="true"/>;
    case "edit": case "delete": case "move": return <FilePen size={size} aria-hidden="true"/>;
    case "read": return <FileText size={size} aria-hidden="true"/>;
    case "search": return <Search size={size} aria-hidden="true"/>;
    case "fetch": return <Globe size={size} aria-hidden="true"/>;
    case "mcp": return <Plug size={size} aria-hidden="true"/>;
    case "subagent": case "think": return <Bot size={size} aria-hidden="true"/>;
    case "image": return <Image size={size} aria-hidden="true"/>;
    default: return <Wrench size={size} aria-hidden="true"/>;
  }
}
/** Unified diff with line numbers and roles; the text stays exact for copying. */
export function DiffView({ text, fallback = "改动", className }: { readonly text: string; readonly fallback?: string; readonly className?: string }) {
  const files = parseUnifiedDiff(text, fallback);
  return <div className={cn("native-diff diff rounded-lg border border-line bg-surface", className)}>
    {files.map((file, index) => <div key={index}>
      {file.lines.map((line, row) => line.kind === "file" || line.kind === "meta"
        ? <div key={row} className="diff-line is-file"><span className="n"/><span className="s"/><span className="c">{line.text}</span></div>
        : line.kind === "hunk" ? <div key={row} className="diff-line is-hunk"><span className="n">⋯</span><span className="s"/><span className="c">{line.text}</span></div>
        : <div key={row} className={cn("diff-line", line.kind === "add" ? "is-add" : line.kind === "remove" ? "is-remove" : "")}>
          <span className="n">{line.kind === "remove" ? line.oldNo : line.newNo}</span><span className="s">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</span><span className="c">{line.text}</span>
        </div>)}
    </div>)}
  </div>;
}
function ToolRow({ tool, active, loadDetail, children, depth }: { tool: Tool; active: boolean; loadDetail: ToolDetailLoader | undefined; children: ReadonlyMap<string, readonly Tool[]>; depth: number }) {
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
  // Claude reports a running command as pending until it ends, so whether an unreported tool ran is not known.
  const unfinished = toolUnfinished(tool, active), running = active && TOOL_PENDING.has(tool.status);
  const status = unfinished ? "未完成（原程序未报告结束）" : TOOL_STATUS[tool.status] ?? tool.status, failed = toolFailed(tool);
  const nested = children.get(tool.id) ?? [];
  return <li className={cn("native-tool", failed && "is-failed", open && "is-open")}>
    <button type="button" onClick={toggle} aria-expanded={expandable ? open : undefined} disabled={!expandable}
      title={expandable ? "查看工具输入与输出" : running ? "工具执行中" : unfinished ? "回合结束时原程序没有报告这个工具已结束；它可能执行过，也可能没有" : "工具没有可显示的详情"}
      className="group flex w-full items-center gap-2 rounded-[7px] border-none bg-transparent px-2 py-[5px] text-left text-[13px] text-fg enabled:hover:bg-hover disabled:cursor-default">
      <span className={cn("flex w-3 flex-none justify-center text-fg-3 transition-transform duration-150", open && "rotate-90", !expandable && "invisible")} aria-hidden="true"><ChevronRight size={12}/></span>
      <span className="flex w-4 flex-none justify-center text-fg-3">{toolIcon(nested.length ? "subagent" : tool.kind)}</span>
      <span className={cn("min-w-0 flex-1 truncate", tool.kind === "execute" && "mono text-[12.5px]")}>{tool.title}</span>
      {nested.length ? <small className="flex-none text-[12px] text-fg-3">子 Agent · {nested.length} 个工具</small> : null}
      {tool.exitCode !== undefined ? <small className={cn("flex-none text-[12px]", tool.exitCode === 0 ? "text-fg-3" : "text-red")}>退出码 {tool.exitCode}</small> : null}
      {running ? <Spinner size={13} label="正在执行" className="text-accent"/> : <small className={cn("flex-none text-[12px]", failed || unfinished ? "text-red" : "text-fg-3")}>{status}</small>}
    </button>
    {open ? <div className="native-tool-detail enter ml-[26px] mt-1 mb-2 flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-[12.5px]">
      {loading ? <p className="m-0 flex items-center gap-1.5 text-fg-3"><Spinner size={12}/> 读取工具详情…</p> : null}
      {problem ? <p className="m-0 text-red">{problem}</p> : null}
      {detail ? <>
        {detail.name || detail.kind ? <p className="m-0 text-fg-3">{[detail.name, detail.kind].filter(Boolean).join(" · ")}</p> : null}
        {detail.input ? <section><h5 className="m-0 mb-1 text-[11.5px] font-medium text-fg-3">输入</h5><pre className="m-0 max-h-72 overflow-auto rounded-md bg-subtle p-2 text-[12px] whitespace-pre-wrap break-words">{detail.input}</pre></section> : null}
        {detail.diff ? <section><h5 className="m-0 mb-1 text-[11.5px] font-medium text-fg-3">改动</h5><DiffView text={detail.diff} fallback={detail.locations?.[0] ?? tool.title} className="max-h-96 overflow-auto"/></section> : null}
        {detail.output ? <section><h5 className="m-0 mb-1 text-[11.5px] font-medium text-fg-3">输出</h5><pre className="m-0 max-h-72 overflow-auto rounded-md bg-subtle p-2 text-[12px] whitespace-pre-wrap break-words">{detail.output}</pre></section> : null}
        {detail.locations?.length ? <section><h5 className="m-0 mb-1 text-[11.5px] font-medium text-fg-3">位置</h5><ul className="m-0 list-none p-0">{detail.locations.map(path => <li key={path}><code className="text-[12px]">{path}</code></li>)}</ul></section> : null}
        {detail.truncated ? <p className="m-0 text-fg-3">内容较长，已按预算截取显示。</p> : null}
        {!detail.input && !detail.output && !detail.diff && !detail.locations?.length ? <p className="m-0 text-fg-3">这个工具没有返回可显示的输入或输出。</p> : null}
      </> : null}
    </div> : null}
    {nested.length ? <ul className="m-0 ml-[26px] list-none border-l-2 border-line py-0.5 pl-2" aria-label={"子 Agent 的工具：" + tool.title}>{nested.map(child => <ToolRow key={child.id} tool={child} active={active} loadDetail={loadDetail} children={children} depth={depth + 1}/>)}</ul> : null}
  </li>;
}
/** Tools in call order; a tool whose parent call is listed is shown under it, as the sub-agent work of that call. */
export function ToolList({ tools, active, loadDetail }: { tools: readonly Tool[]; active: boolean; loadDetail: ToolDetailLoader | undefined }) {
  const { roots, children } = toolTree(tools);
  return <ul className="native-tools m-0 list-none p-0" aria-label="工具活动">{roots.map(tool => <ToolRow key={tool.id} tool={tool} active={active} loadDetail={loadDetail} children={children} depth={0}/>)}</ul>;
}
/**
 * The Turn's tools behind one summary line ("读取 2 个文件，执行 1 条命令"); failures and unfinished tools are counted in
 * the line itself. Open by default in the detailed density, or when the user opened it.
 */
export const ProcessGroup = memo(function ProcessGroup({ tools, active, loadDetail, defaultOpen }: { tools: readonly Tool[]; active: boolean; loadDetail: ToolDetailLoader | undefined; defaultOpen: boolean }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? defaultOpen;
  const summary = toolSummary(tools, active);
  return <div className="flex flex-col">
    <button type="button" aria-expanded={open} onClick={() => setChoice(!open)} className="process-summary flex max-w-full items-center gap-1.5 self-start rounded-md border-none bg-transparent py-[3px] pr-1.5 pl-1 text-left text-[12.5px] text-fg-2 hover:bg-hover">
      <ChevronRight size={12} className={cn("flex-none transition-transform duration-150", open && "rotate-90")} aria-hidden="true"/>
      <span className={cn("min-w-0", summary.failed || summary.unfinished ? "" : "truncate")}>{summary.text}{summary.running ? <span className="text-fg-3"> · 正在执行 <span className="mono text-[12px]">{summary.running.title}</span></span> : null}</span>
      {summary.running ? <Spinner size={12} label="正在执行" className="text-accent"/> : null}
    </button>
    {open ? <div className="enter mt-1 ml-2.5 border-l-2 border-line pl-2"><ToolList tools={tools} active={active} loadDetail={loadDetail}/></div> : null}
  </div>;
});
export function PlanView({ plan, compact: small = false }: { plan: PublicPlan; compact?: boolean }) {
  const done = plan.entries.filter(entry => entry.status === "completed").length;
  return <section className={cn("native-plan flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface", small ? "px-3 py-2.5" : "p-3")} aria-label="计划">
    <div className="flex items-center gap-2 text-[12.5px]"><ListChecks size={14} aria-hidden="true"/><span className="font-semibold">计划 · {done}/{plan.entries.length} 完成</span></div>
    {plan.explanation ? <p className="m-0 text-[12.5px] text-fg-2">{plan.explanation}</p> : null}
    <ol className="m-0 flex list-none flex-col gap-1 p-0">{plan.entries.map((entry, index) => <li key={index} className="flex items-start gap-2 text-[13px]">
      <span aria-label={entry.status === "completed" ? "已完成" : entry.status === "in_progress" ? "进行中" : "待办"} role="img" className={cn("mt-[3px] flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border-[1.5px]",
        entry.status === "completed" ? "border-fg-3 bg-fg-3" : entry.status === "in_progress" ? "border-accent" : "border-line-strong")}>
        {entry.status === "completed" ? <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--bg-surface)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
          : entry.status === "in_progress" ? <span className="pulse h-1.5 w-1.5 rounded-full bg-accent"/> : null}
      </span>
      <span className={cn("min-w-0 flex-1", entry.status === "completed" && "text-fg-3 line-through")}>{entry.content}</span>{entry.priority === "high" ? <small className="badge badge-amber flex-none">高优先</small> : null}
    </li>)}</ol>
  </section>;
}
export function NoticeList({ notices }: { notices: readonly PublicNotice[] }) {
  return <div className="flex flex-col gap-1.5">{notices.map((notice, index) => <div key={index} role={notice.severity === "error" ? "alert" : "status"}
    className={cn("native-notice flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]", notice.severity === "error" ? "border-red-line bg-red-soft" : notice.severity === "warning" ? "border-amber-line bg-amber-soft" : "border-line bg-surface")}>
    {notice.severity === "info" ? <Info size={14} className="mt-0.5 flex-none text-fg-3" aria-hidden="true"/> : <TriangleAlert size={14} className={cn("mt-0.5 flex-none", notice.severity === "error" ? "text-red" : "text-amber")} aria-hidden="true"/>}
    <div className="min-w-0"><strong className="font-semibold">{notice.title}</strong>{notice.detail ? <p className="m-0 mt-0.5 text-fg-2">{notice.detail}</p> : null}</div>
  </div>)}</div>;
}
export const ACTIVITY_KIND: Readonly<Record<PublicActivity["kind"], string>> = { subagent: "子 Agent", task: "后台任务", compaction: "上下文压缩", retry: "自动重试", review: "代码审查" };
export const ACTIVITY_STATUS: Readonly<Record<PublicActivity["status"], string>> = { running: "进行中", completed: "完成", failed: "失败", cancelled: "已取消" };
export function ActivityList({ activities }: { activities: readonly PublicActivity[] }) {
  return <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="原生活动">{activities.map(activity => <li key={activity.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]">
    <span className="flex-none text-fg-3">{activity.kind === "compaction" ? <Layers size={14} aria-hidden="true"/> : <Bot size={14} aria-hidden="true"/>}</span>
    <span className="min-w-0 flex-1"><strong className="font-medium">{ACTIVITY_KIND[activity.kind]}</strong> {activity.title}{activity.detail ? <small className="text-fg-3"> · {activity.detail}</small> : null}</span>
    {activity.status === "running" ? <span className="pulse h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-hidden="true"/> : null}
    <small className={cn("flex-none text-[12px]", activity.status === "failed" ? "text-red" : "text-fg-3")}>{ACTIVITY_STATUS[activity.status]}</small>
  </li>)}</ul>;
}
export function OutputList({ outputs }: { outputs: readonly PublicOutput[] }) {
  const chip = "inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-fg no-underline hover:bg-hover";
  return <div className="flex flex-wrap gap-2">{outputs.map((output, index) => output.kind === "link"
    ? <a key={index} className={chip} href={output.uri} target="_blank" rel="noopener noreferrer"><Link size={13} aria-hidden="true"/><span className="truncate">{output.title ?? output.name}</span></a>
    : output.content.kind === "image"
      ? <a key={index} className="block overflow-hidden rounded-lg border border-line" href={contentUrl(output.content)} target="_blank" rel="noopener noreferrer" title={output.content.name}><img className="block max-h-64 max-w-full" src={contentUrl(output.content)} alt={output.content.name} loading="lazy"/></a>
      : <a key={index} className={chip} href={contentUrl(output.content, true)} download={output.content.name}><Download size={13} aria-hidden="true"/><span className="truncate">{output.content.name}</span><small className="text-fg-3">{bytes(output.content.bytes)}</small></a>)}</div>;
}
/** Compact line under a finished reply; scopes stay explicit (turn tokens, context occupancy, cost scope). */
export function usageParts(usage: NativeUsage): readonly string[] {
  const parts: string[] = [];
  if (usage.turn?.input !== undefined) parts.push("输入 " + compact(usage.turn.input));
  if (usage.turn?.output !== undefined) parts.push("输出 " + compact(usage.turn.output));
  if (usage.context) parts.push("上下文 " + (usage.context.size ? Math.round(usage.context.used / usage.context.size * 100) + "%" : compact(usage.context.used)));
  if (usage.cost) parts.push((usage.cost.currency === "USD" ? "$" : usage.cost.currency + " ") + usage.cost.amount.toFixed(usage.cost.amount < 1 ? 4 : 2) + (usage.cost.scope === "session" ? "（会话累计）" : ""));
  return parts;
}
export function UsageLine({ usage }: { usage: NativeUsage }) {
  const parts = usageParts(usage);
  return parts.length ? <span className="native-usage">{parts.join(" · ")}</span> : null;
}
export function usageFacts(usage: NativeUsage): readonly (readonly [string, string])[] {
  const turn = usage.turn, facts: (readonly [string, string])[] = [];
  if (turn) facts.push(["本轮用量", [["输入", turn.input], ["输出", turn.output], ["缓存读取", turn.cachedInput], ["缓存写入", turn.cacheWrite], ["推理", turn.reasoning], ["合计", turn.total]].filter(([, value]) => value !== undefined).map(([label, value]) => label + " " + Number(value).toLocaleString()).join(" · ")]);
  if (usage.context) facts.push(["上下文", usage.context.used.toLocaleString() + (usage.context.size ? " / " + usage.context.size.toLocaleString() + " tokens" : " tokens")]);
  if (usage.cost) facts.push(["费用", usage.cost.amount.toFixed(4) + " " + usage.cost.currency + " · " + (usage.cost.scope === "session" ? "原生会话累计" : "本轮")]);
  return facts;
}
