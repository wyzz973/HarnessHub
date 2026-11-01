import { Bot, Brain, Check, ChevronRight, Circle, Download, FilePen, FilePlus, FileText, Globe, Image, Info, Layers, Link, Plug, RotateCcw, ScanSearch, Search, SquareTerminal, TriangleAlert, Wrench } from "lucide-react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeUsage } from "../../../src/contracts/control.js";
import type { PublicActivity, PublicNotice, PublicOutput, PublicPlan } from "../../../src/contracts/session.js";
import { contentUrl, errorMessage, type ToolDetailView } from "../api.js";
import { cn } from "../lib/cn.js";
import { bytes, compact } from "../lib/format.js";
import { diffTotals, groupSteps, knownToolDetail, parseUnifiedDiff, readsLabel, readToolDetail, stepLabel, TOOL_PENDING, TOOL_STATUS, toolCategory, toolFailed, toolTree, toolUnfinished, type DiffFile, type Step, type Tool } from "../lib/turn.js";
import { Collapsible, DrawnCheck, motionStyle, useReducedMotion } from "../ui/motion.js";
import { Spinner } from "../ui/primitives.js";

export type ToolDetailLoader = (content: ContentRef) => Promise<ToolDetailView>;

/** The icon of a kind of step (Icons board: 读取 file-text, 修改 file-pen, 新建 file-plus, 运行 square-terminal). */
export function toolIcon(kind: string | undefined, size = 15): ReactNode {
  switch (kind) {
    case "execute": return <SquareTerminal size={size} aria-hidden="true"/>;
    case "edit": case "delete": case "move": return <FilePen size={size} aria-hidden="true"/>;
    case "create": return <FilePlus size={size} aria-hidden="true"/>;
    case "read": return <FileText size={size} aria-hidden="true"/>;
    case "search": return <Search size={size} aria-hidden="true"/>;
    case "fetch": return <Globe size={size} aria-hidden="true"/>;
    case "mcp": return <Plug size={size} aria-hidden="true"/>;
    case "subagent": return <Bot size={size} aria-hidden="true"/>;
    case "think": return <Brain size={size} aria-hidden="true"/>;
    case "image": return <Image size={size} aria-hidden="true"/>;
    default: return <Wrench size={size} aria-hidden="true"/>;
  }
}

/**
 * A stored tool detail, read when `enabled` (a step opened, or an edit whose line counts are shown) and shared with every
 * other view of it on the page. A failed read is reported and asked again only by a later view.
 */
export function useToolDetail(content: ContentRef | undefined, load: ToolDetailLoader | undefined, enabled: boolean): { readonly detail: ToolDetailView | null; readonly problem: string | null; readonly loading: boolean } {
  const id = content?.id ?? null, known = id === null ? undefined : knownToolDetail(id);
  const [result, setResult] = useState<{ readonly id: string; readonly detail: ToolDetailView | null; readonly problem: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !content || !load || knownToolDetail(content.id) !== undefined) return;
    let current = true;
    readToolDetail(content, load).then(detail => { if (current) setResult({ id: content.id, detail, problem: null }); },
      (error: unknown) => { if (current) setResult({ id: content.id, detail: null, problem: errorMessage(error) }); });
    return () => { current = false; };
    // The content is identified by its id: a new reference object for the same id reads nothing again.
  }, [id, enabled, load]);
  const own = result !== null && result.id === id ? result : null;
  const detail = known ?? own?.detail ?? null, problem = detail ? null : own?.problem ?? null;
  return { detail, problem, loading: enabled && id !== null && load !== undefined && detail === null && problem === null };
}

/** The lines of one file of a diff: numbers, signs and text, with the file's header lines unless `headers` is false. */
export function DiffLines({ file, headers = true }: { readonly file: DiffFile; readonly headers?: boolean }) {
  return <>{file.lines.map((line, row) => line.kind === "file" || line.kind === "meta"
    ? headers || line.kind === "meta" ? <div key={row} className="diff-line is-file"><span className="n"/><span className="s"/><span className="c">{line.text}</span></div> : null
    : line.kind === "hunk" ? <div key={row} className="diff-line is-hunk"><span className="n">⋯</span><span className="s"/><span className="c">{line.text}</span></div>
    : <div key={row} className={cn("diff-line", line.kind === "add" ? "is-add" : line.kind === "remove" ? "is-remove" : "")}>
      <span className="n">{line.kind === "remove" ? line.oldNo : line.newNo}</span><span className="s">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</span><span className="c">{line.text}</span>
    </div>)}</>;
}
/** Unified diff with line numbers and roles; the text stays exact for copying. Only green marks added lines (ADR-054 §1). */
export function DiffView({ text, fallback = "改动", className }: { readonly text: string; readonly fallback?: string; readonly className?: string }) {
  const files = parseUnifiedDiff(text, fallback);
  return <div className={cn("native-diff diff py-1.5", className)}>{files.map((file, index) => <div key={index}><DiffLines file={file}/></div>)}</div>;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-1"><h5 className="m-0 text-caption font-medium text-fg-3">{title}</h5>{children}</section>;
}
/** The third layer of the process: what the program sent and got back for one tool, as it reported it. */
function ToolDetail({ tool, load }: { readonly tool: Tool; readonly load: ToolDetailLoader | undefined }) {
  const { detail, problem, loading } = useToolDetail(tool.detail, load, true);
  const pre = "m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-fg";
  return <div className="native-tool-detail mt-0.5 mb-2 ml-[30px] flex min-w-0 flex-col gap-2.5 rounded-block bg-inset px-3 py-2.5 text-ui-sm">
    {loading ? <p className="m-0 flex items-center gap-1.5 text-fg-3"><Spinner size={12} label=""/>读取工具详情…</p> : null}
    {problem ? <p className="m-0 text-red" role="status">{problem}</p> : null}
    {detail ? <>
      {detail.name || detail.kind ? <p className="m-0 text-caption text-fg-3">{[detail.name, detail.kind].filter(Boolean).join(" · ")}</p> : null}
      {detail.input ? <Section title="输入"><pre className={pre}>{detail.input}</pre></Section> : null}
      {detail.diff ? <Section title="改动"><DiffView text={detail.diff} fallback={detail.locations?.[0] ?? tool.title} className="max-h-96 overflow-auto rounded-row bg-app shadow-hairline"/></Section> : null}
      {detail.output ? <Section title="输出"><pre className={pre}>{detail.output}</pre></Section> : null}
      {detail.locations?.length ? <Section title="位置"><ul className="m-0 list-none p-0">{detail.locations.map(path => <li key={path} className="min-w-0 break-all font-mono text-code text-fg-2">{path}</li>)}</ul></Section> : null}
      {detail.truncated ? <p className="m-0 text-caption text-fg-3">内容较长，已按预算截取显示。</p> : null}
      {!detail.input && !detail.output && !detail.diff && !detail.locations?.length ? <p className="m-0 text-fg-3">这个工具没有返回可显示的输入或输出。</p> : null}
    </> : null}
  </div>;
}

/**
 * Whether a step just finished in front of the reader: its spinner turns into a check drawn in 240 ms (Motion board #06),
 * which stays 1.2 s before the step shows the icon of its kind again, as the Conversation board draws finished steps.
 * Reduced motion shows the icon at once. Steps found finished, or that failed, never draw a check.
 */
function useJustDone(pending: boolean, done: boolean, reduced: boolean): { readonly check: boolean; readonly after: boolean } {
  const [was, setWas] = useState(pending);
  const [check, setCheck] = useState(false);
  const [after, setAfter] = useState(false);
  if (was !== pending) { setWas(pending); if (was && !pending && done && !reduced) setCheck(true); }
  useEffect(() => {
    if (!check) return;
    const timer = setTimeout(() => { setCheck(false); setAfter(true); }, 1200);
    return () => clearTimeout(timer);
  }, [check]);
  return { check, after };
}

/**
 * The steps a reader has already seen, owned by the view that shows a Turn: a list adds every step it shows, and only steps
 * not in it come in (Motion board #05). A list without one counts what it shows first as history.
 */
export type SeenSteps = Set<string>;

interface StepProps { readonly step: Step; readonly active: boolean; readonly loadDetail: ToolDetailLoader | undefined; readonly children: ReadonlyMap<string, readonly Tool[]>; readonly fresh: boolean; readonly reduced: boolean; readonly seen: SeenSteps | undefined }
/**
 * One step of the process (Conversation board): the icon of its kind (a spinner while it runs), the verb in its tense, what
 * it acted on, and what came of it: lines added and removed by an edit, the exit code of a command, a failure in red. A
 * step with stored detail opens its raw input and output; consecutive reads open the reads they group.
 */
const StepItem = memo(function StepItem({ step, active, loadDetail, children, fresh, reduced, seen }: StepProps) {
  const [open, setOpen] = useState(false);
  const [entering] = useState(fresh);
  const panel = useId();
  const tools = step.kind === "reads" ? step.tools : [step.tool], first = tools[0]!;
  const nested = step.kind === "tool" ? children.get(first.id) ?? [] : [];
  const pending = active && tools.some(tool => TOOL_PENDING.has(tool.status));
  const failed = tools.some(toolFailed), unfinished = tools.some(tool => toolUnfinished(tool, active));
  const done = !pending && !failed && !unfinished && tools.every(tool => !TOOL_PENDING.has(tool.status));
  const { check, after } = useJustDone(pending, done, reduced);
  const category = toolCategory(first, nested.length > 0), edit = step.kind === "tool" && category === "edit";
  // An edit's diff gives its line counts and whether it created the file: read as soon as the step is shown.
  const { detail } = useToolDetail(edit ? first.detail : undefined, loadDetail, edit);
  const diff = useMemo(() => detail?.diff ? diffTotals(parseUnifiedDiff(detail.diff, first.title)) : null, [detail, first.title]);
  const label = step.kind === "reads" ? readsLabel(step.tools) : stepLabel(first, nested.length > 0);
  const verb = pending ? label.running : diff?.created && label.verb === "修改" ? "新建" : label.verb;
  const expandable = step.kind === "reads" || first.detail !== undefined && loadDetail !== undefined;
  const iconKind = nested.length ? "subagent" : diff?.created ? "create" : first.kind;
  const icon = pending ? <Spinner size={14} tone="run" label=""/> : check ? <DrawnCheck size={15} className="text-fg-3"/>
    : <span className={cn("flex", after && "motion-fade-in", failed || unfinished ? "text-red" : category === "edit" ? "text-fg-2" : "text-fg-3")} style={after ? motionStyle({ duration: 120 }) : undefined}>{toolIcon(iconKind, 15)}</span>;
  const note = nested.length ? <span>子 Agent · {nested.length} 个工具</span>
    : step.kind === "tool" && first.exitCode !== undefined ? <span className={first.exitCode === 0 ? undefined : "text-red"}>退出码 {first.exitCode}</span> : null;
  const status = unfinished ? <span className="text-red" title="回合结束时原程序没有报告这个工具已结束；它可能执行过，也可能没有">未完成</span>
    : failed ? <span className="text-red">{TOOL_STATUS[tools.find(toolFailed)!.status] ?? "失败"}</span>
    : pending && !label.verb ? <span className="text-accent-text">进行中</span>
    : !pending && !done && step.kind === "tool" && first.status !== "completed" ? <span>{TOOL_STATUS[first.status] ?? first.status}</span> : null;
  const facts = diff && (diff.add || diff.del) ? <span className="mono flex gap-1.5 text-[11px]">{diff.add ? <span className="text-add">+{diff.add}</span> : null}{diff.del ? <span className="text-del">−{diff.del}</span> : null}</span> : null;
  const right = facts || note || status ? <span className={cn("flex flex-none items-center gap-2 whitespace-nowrap text-caption text-fg-3", check && "motion-fade-in")}>{facts}{note}{status}</span> : null;
  const content = <>
    <span className="flex size-[15px] flex-none items-center justify-center">{icon}</span>
    {verb ? <><span className="flex-none text-fg-2">{verb}</span>{" "}</> : null}
    <span className={cn("min-w-0 trunc", label.verb && step.kind === "tool" && category !== "other" ? "font-mono text-code text-fg" : step.kind === "reads" ? "font-mono text-code text-fg" : "text-fg")} title={step.kind === "reads" ? step.tools.map(tool => tool.title).join("\n") : first.title}>{label.target}</span>
    <span className="min-w-2 flex-1"/>
    {right}
    {expandable ? <ChevronRight size={12} strokeWidth={2.2} className={cn("flex-none text-fg-3 opacity-0 transition-[rotate,opacity] duration-200 ease-expo group-hover/step:opacity-100 group-focus-visible/step:opacity-100 keyboard:transition-none", open && "rotate-90 opacity-100")} aria-hidden="true"/> : null}
  </>;
  const row = "group/step flex min-h-[30px] w-full min-w-0 items-center gap-[9px] rounded-row px-1.5 py-[5px] text-left text-ui-sm leading-[18px]";
  return <li className={cn("native-tool min-w-0", failed && "is-failed", open && "is-open", entering && "motion-row-in")}>
    {expandable ? <button type="button" className={cn(row, "row border-none bg-transparent text-fg")} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}
      title={step.kind === "reads" ? "查看每一次读取" : "查看工具输入与输出"}>{content}</button>
      : <div className={row}>{content}</div>}
    {expandable ? <Collapsible open={open} id={panel} className="grid-cols-[minmax(0,1fr)]">
      {step.kind === "reads" ? <ol className="m-0 mb-1 ml-[30px] flex list-none flex-col gap-px p-0" aria-label={"读取的文件：" + step.tools.length + " 个"}>
        {step.tools.map(tool => <StepItem key={tool.id} step={{ kind: "tool", key: tool.id, tool }} active={active} loadDetail={loadDetail} children={children} fresh={false} reduced={reduced} seen={seen}/>)}</ol>
        : <ToolDetail tool={first} load={loadDetail}/>}
    </Collapsible> : null}
    {nested.length ? <StepList tools={nested} all={children} active={active} loadDetail={loadDetail} seen={seen} label={"子 Agent 的工具：" + first.title} className="mb-1 ml-[13px] border-l border-line-strong pl-2"/> : null}
  </li>;
});

function StepList({ tools, all, active, loadDetail, seen: known, label, className }: { readonly tools: readonly Tool[]; readonly all: ReadonlyMap<string, readonly Tool[]>; readonly active: boolean; readonly loadDetail: ToolDetailLoader | undefined; readonly seen: SeenSteps | undefined; readonly label: string; readonly className?: string }) {
  const reduced = useReducedMotion();
  // Steps the reader has seen are history; the others come in (Motion board #05). Without a record from the Turn, the steps
  // present when this list is first shown are history.
  const seen = useRef<SeenSteps | null>(null);
  seen.current ??= known ?? new Set(tools.map(tool => tool.id));
  useLayoutEffect(() => { for (const tool of tools) seen.current!.add(tool.id); }, [tools]);
  const steps = useMemo(() => groupSteps(tools, all), [tools, all]);
  return <ul className={cn("native-tools m-0 flex list-none flex-col gap-px p-0", className)} aria-label={label}>
    {steps.map(step => <StepItem key={step.key} step={step} active={active} loadDetail={loadDetail} children={all} fresh={!seen.current!.has(step.key)} reduced={reduced} seen={known}/>)}
  </ul>;
}
/**
 * A Turn's tools as steps, in call order (ADR-054 §5): consecutive reads are one group, and a tool whose parent call is
 * listed is shown under it, as the sub-agent work of that call. `seen` is the Turn's record of the steps its reader saw.
 */
export function ToolList({ tools, active, loadDetail, seen }: { tools: readonly Tool[]; active: boolean; loadDetail: ToolDetailLoader | undefined; seen?: SeenSteps | undefined }) {
  const { roots, children } = useMemo(() => toolTree(tools), [tools]);
  return <StepList tools={roots} all={children} active={active} loadDetail={loadDetail} seen={seen} label="工具活动"/>;
}

/**
 * The plan a program reported (Conversation board): finished steps checked and struck through, the one in progress in
 * blue, the rest open. `owner` names whose plan it is.
 */
export function PlanView({ plan, owner, compact: small = false }: { plan: PublicPlan; owner?: string; compact?: boolean }) {
  const done = plan.entries.filter(entry => entry.status === "completed").length;
  return <section className={cn("native-plan flex flex-col", small ? "gap-2" : "gap-2.5")} aria-label="计划">
    <p className="m-0 text-caption text-fg-3">{owner ? owner + " 维护的计划" : "计划"} · {done} / {plan.entries.length} 完成</p>
    {plan.explanation ? <p className="m-0 text-ui-sm text-fg-2">{plan.explanation}</p> : null}
    <ol className={cn("m-0 flex list-none flex-col p-0", small ? "gap-2" : "gap-2.5")}>{plan.entries.map((entry, index) => <li key={index} className="flex items-start gap-2 text-ui-sm">
      <span role="img" aria-label={entry.status === "completed" ? "已完成" : entry.status === "in_progress" ? "进行中" : "待办"} className={cn("mt-[2.5px] flex flex-none", entry.status === "completed" ? "text-fg-3" : entry.status === "in_progress" ? "text-run" : "text-placeholder")}>
        {entry.status === "completed" ? <Check size={15} strokeWidth={1.9} aria-hidden="true"/> : <Circle size={15} strokeWidth={1.9} aria-hidden="true"/>}
      </span>
      <span className={cn("min-w-0 flex-1", entry.status === "completed" ? "text-fg-3 line-through decoration-line-strong" : entry.status === "in_progress" ? "font-medium text-fg" : "text-fg-2")}>{entry.content}</span>
      {entry.priority === "high" ? <small className="badge flex-none">高优先</small> : null}
    </li>)}</ol>
  </section>;
}
/**
 * What the program announced during the Turn. Its warnings stay neutral (amber means only "waiting for you"); errors are red.
 */
export function NoticeList({ notices }: { notices: readonly PublicNotice[] }) {
  return <div className="flex flex-col gap-1.5">{notices.map((notice, index) => <div key={index} role={notice.severity === "error" ? "alert" : "status"}
    className={cn("native-notice flex items-start gap-2.5 rounded-block px-3 py-2.5 text-ui-sm", notice.severity === "error" ? "bg-red-soft" : "bg-surface shadow-hairline")}>
    {notice.severity === "info" ? <Info size={16} className="mt-0.5 flex-none text-fg-3" aria-hidden="true"/> : <TriangleAlert size={16} className={cn("mt-0.5 flex-none", notice.severity === "error" ? "text-red" : "text-fg-2")} aria-hidden="true"/>}
    <div className="min-w-0"><strong className={cn("font-semibold", notice.severity === "error" && "text-red")}>{notice.title}</strong>{notice.detail ? <p className="m-0 mt-0.5 break-words text-fg-2">{notice.detail}</p> : null}</div>
  </div>)}</div>;
}
export const ACTIVITY_KIND: Readonly<Record<PublicActivity["kind"], string>> = { subagent: "子 Agent", task: "后台任务", compaction: "上下文压缩", retry: "自动重试", review: "代码审查" };
export const ACTIVITY_STATUS: Readonly<Record<PublicActivity["status"], string>> = { running: "进行中", completed: "完成", failed: "失败", cancelled: "已取消" };
function activityIcon(kind: PublicActivity["kind"]): ReactNode {
  switch (kind) {
    case "compaction": return <Layers size={15} aria-hidden="true"/>;
    case "retry": return <RotateCcw size={15} aria-hidden="true"/>;
    case "review": return <ScanSearch size={15} aria-hidden="true"/>;
    default: return <Bot size={15} aria-hidden="true"/>;
  }
}
/** The program's own activities (sub-agents, background tasks, context compaction), as steps of the process. */
export function ActivityList({ activities }: { activities: readonly PublicActivity[] }) {
  return <ul className="m-0 flex list-none flex-col gap-px p-0" aria-label="原生活动">{activities.map(activity => <li key={activity.id} className="flex min-h-[30px] min-w-0 items-center gap-[9px] px-1.5 py-[5px] text-ui-sm leading-[18px]">
    <span className={cn("flex size-[15px] flex-none items-center justify-center", activity.status === "failed" ? "text-red" : "text-fg-3")}>{activity.status === "running" ? <Spinner size={14} tone="run" label=""/> : activityIcon(activity.kind)}</span>
    <span className="flex-none text-fg-2">{ACTIVITY_KIND[activity.kind]}</span>{" "}
    <span className="min-w-0 trunc text-fg">{activity.title}{activity.detail ? <span className="text-fg-3"> · {activity.detail}</span> : null}</span>
    <span className="min-w-2 flex-1"/>
    <span className={cn("flex-none whitespace-nowrap text-caption", activity.status === "failed" ? "text-red" : activity.status === "running" ? "text-accent-text" : "text-fg-3")}>{ACTIVITY_STATUS[activity.status]}</span>
  </li>)}</ul>;
}
/** Files, images and links the program produced; an image is shown, files are downloaded, links open elsewhere. */
export function OutputList({ outputs }: { outputs: readonly PublicOutput[] }) {
  const chip = "press inline-flex max-w-full items-center gap-1.5 rounded-control bg-surface px-2.5 py-1.5 text-ui-sm text-fg no-underline shadow-hairline hover:bg-subtle hover:no-underline";
  return <div className="flex flex-wrap gap-2">{outputs.map((output, index) => output.kind === "link"
    ? <a key={index} className={chip} href={output.uri} target="_blank" rel="noopener noreferrer"><Link size={14} className="text-fg-3" aria-hidden="true"/><span className="trunc">{output.title ?? output.name}</span></a>
    : output.content.kind === "image"
      ? <a key={index} className="block overflow-hidden rounded-block shadow-hairline" href={contentUrl(output.content)} target="_blank" rel="noopener noreferrer" title={output.content.name}><img className="block max-h-64 max-w-full" src={contentUrl(output.content)} alt={output.content.name} loading="lazy"/></a>
      : <a key={index} className={chip} href={contentUrl(output.content, true)} download={output.content.name}><Download size={14} className="text-fg-3" aria-hidden="true"/><span className="trunc">{output.content.name}</span><small className="text-caption text-fg-3">{bytes(output.content.bytes)}</small></a>)}</div>;
}
/**
 * The usage facts under a finished reply (Conversation board: "输入 18.2k · 输出 0.6k · ¥0.21"), each only when the program
 * reported it; scopes stay explicit. The context share belongs to the composer's status bar and the details, not here,
 * unless `context` asks for it.
 */
export function usageParts(usage: NativeUsage, context = false): readonly string[] {
  const parts: string[] = [];
  if (usage.turn?.input !== undefined) parts.push("输入 " + compact(usage.turn.input));
  if (usage.turn?.output !== undefined) parts.push("输出 " + compact(usage.turn.output));
  if (context && usage.context) parts.push("上下文 " + (usage.context.size ? Math.round(usage.context.used / usage.context.size * 100) + "%" : compact(usage.context.used)));
  if (usage.cost) parts.push((usage.cost.currency === "USD" ? "$" : usage.cost.currency === "CNY" ? "¥" : usage.cost.currency + " ") + money(usage.cost.amount) + (usage.cost.scope === "session" ? "（会话累计）" : ""));
  return parts;
}
/** An amount with two decimals, or up to four for small amounts, without trailing zeros: 0.21, 0.0012, 3.06. */
function money(amount: number): string {
  if (amount >= 1) return amount.toFixed(2);
  const fine = amount.toFixed(4).replace(/0+$/u, "");
  return (fine.split(".")[1] ?? "").length < 2 ? amount.toFixed(2) : fine;
}
export function UsageLine({ usage }: { usage: NativeUsage }) {
  const parts = usageParts(usage);
  return parts.length ? <span className="native-usage">{parts.join(" · ")}</span> : null;
}
export function usageFacts(usage: NativeUsage): readonly (readonly [string, string])[] {
  const turn = usage.turn, facts: (readonly [string, string])[] = [];
  if (turn) facts.push(["本轮用量", [["输入", turn.input], ["输出", turn.output], ["缓存读取", turn.cachedInput], ["缓存写入", turn.cacheWrite], ["推理", turn.reasoning], ["合计", turn.total]].filter(([, value]) => value !== undefined).map(([label, value]) => label + " " + Number(value).toLocaleString()).join(" · ")]);
  if (usage.context) facts.push(["上下文", usage.context.used.toLocaleString() + (usage.context.size ? " / " + usage.context.size.toLocaleString() + " tokens（" + Math.round(usage.context.used / usage.context.size * 100) + "%）" : " tokens")]);
  if (usage.cost) facts.push(["费用", usage.cost.amount.toFixed(4) + " " + usage.cost.currency + " · " + (usage.cost.scope === "session" ? "原生会话累计" : "本轮")]);
  return facts;
}
