import { Bot, Brain, Check, ChevronRight, CircleAlert, CircleDashed, CircleHelp, CircleStop, Copy, FilePen, FilePlus, FileText, GitBranch, Globe, Info, ListChecks, MessageSquareText, Plug, RotateCcw, Search, SquareTerminal, Wrench } from "lucide-react";
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ReadItem, ReadTurn } from "../../../src/contracts/protocol-read.js";
import type { ReasoningItem, SwitchItem, WorkItem } from "../../../src/contracts/protocol.js";
import type { PublicMessage, PublicOutput, PublicRun } from "../../../src/contracts/session.js";
import { failureMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { elapsed } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { endLine, quietLine, switchLine, turnByline, turnFooter } from "../lib/protocol/lines.js";
import { liveStatus, type QueueNotice } from "../lib/protocol/live.js";
import { hubRecordOf } from "../lib/protocol/runs.js";
import { arrange, gapOf, isGap, lay, opensByDefault, reasoningLabel, summarizeGroup, withReply, workLabel, type Block, type GapRow, type WorkBlock } from "../lib/protocol/work.js";
import { utf8Length } from "../lib/protocol/window.js";
import { rememberShown, shownSteps } from "../lib/turn.js";
import { Collapsible, motionStyle, SwapText } from "../ui/motion.js";
import { Spinner } from "../ui/primitives.js";
import { NoticeList, OutputList, StoredDetail, type ToolDetailLoader } from "./Activity.js";
import { BrandIcon } from "./BrandIcon.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { ActionButton, LiveIcon, QueuedTurn, UserMessage, useEntrance, type TurnBranchView, type UserMessageBranching } from "./Turn.js";

/*
 * A Turn drawn from the protocol's items (docs/proposals/protocol/hub-protocol.html §13), the same for every Harness: each item in
 * the order it came, consecutive actions folded into one summary line that opens to their lines, a thought as one line, the
 * Harness's hand-over as one line, and one footer. Nothing here asks which Harness ran the Turn or what it called a tool; the
 * only thing taken from a Harness's identity is its icon. There is no other way a Turn is drawn: a Run whose Turn could not be read
 * says so, with the reason, and is not drawn from anything else.
 */

/** What a Turn can read of itself when it is shown (App.tsx): the rest of words it holds in part, and the middle of a long stretch of work a window left out. */
export interface TurnReads {
  /** Reads more of an item's words, or the item itself when its body was left out. */
  readonly more: (runId: string, seq: number) => void;
  /** Reads the items of a Turn's folded middle. */
  readonly expand: (ordinal: number) => void;
}
/** The bytes of an item's words the page does not hold: the item says how long they are when it holds only part of them. */
function leftOut(item: { readonly bodyOmitted?: true; readonly textBytes?: number }, held: string): number {
  return item.bodyOmitted === true && item.textBytes !== undefined ? Math.max(0, item.textBytes - utf8Length(held)) : 0;
}
const megabytes = (bytes: number): string => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
/** The words of an item that the page holds the start of: how much is left, and the way to read more of it. */
function MoreText({ runId, seq, rest, label }: { readonly runId: string; readonly seq: number; readonly rest: number; readonly label?: string }) {
  const ctx = useTurn(), [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [rest]);
  if (ctx.reads === undefined) return null;
  return <div className="more-text flex min-w-0 items-center gap-2 px-1.5 text-caption text-fg-3">
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setBusy(true); ctx.reads?.more(runId, seq); }}>{busy ? "正在读取…" : label ?? "显示更多"}</button>
    <span>还有 {megabytes(rest)} 没有显示</span></div>;
}

interface TurnContext {
  readonly turn: ReadTurn; readonly run: PublicRun;
  readonly reads: TurnReads | undefined; readonly over: boolean; readonly cancelling: boolean; readonly detailed: boolean;
  readonly children: ReadonlyMap<string, readonly ReadItem[]>;
  readonly message: (id: string) => PublicMessage | undefined;
  readonly loadDetail: ToolDetailLoader | undefined;
  /** The ids of the items the reader has already seen: only others come in. */
  readonly seen: ReadonlySet<string>;
  readonly onViewPacket: ((packetId: string) => void) | undefined;
}
const Context = createContext<TurnContext | null>(null);
function useTurn(): TurnContext {
  const value = useContext(Context);
  if (value === null) throw new Error("A protocol item is drawn outside its Turn");
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------------------

/** The icon of a kind of action. The kind is the protocol's, never a Harness's own word for it. */
function actionIcon(item: WorkItem, size = 15): ReactNode {
  switch (item.type) {
    case "command": return <SquareTerminal size={size} aria-hidden="true"/>;
    case "file_read": return <FileText size={size} aria-hidden="true"/>;
    case "file_change": return item.changes.length > 0 && item.changes.every(change => change.op === "create") ? <FilePlus size={size} aria-hidden="true"/> : <FilePen size={size} aria-hidden="true"/>;
    case "search": return <Search size={size} aria-hidden="true"/>;
    case "web": return <Globe size={size} aria-hidden="true"/>;
    case "mcp_tool": return <Plug size={size} aria-hidden="true"/>;
    case "tool": return <Wrench size={size} aria-hidden="true"/>;
    case "subagent": return <Bot size={size} aria-hidden="true"/>;
  }
}
/** What stands before an action's words: it turns while the action runs, and shows its kind once it is over. */
function ActionMark({ item }: { readonly item: WorkItem }) {
  switch (item.status) {
    case "running": return <Spinner size={14} tone="run" label=""/>;
    case "pending": return <CircleDashed size={15} className="text-fg-3" aria-hidden="true"/>;
    default: return <span className={cn("flex", item.status === "failed" || item.status === "unknown" ? "text-red" : "text-fg-3")}>{actionIcon(item)}</span>;
  }
}

const ROW = "group/step flex min-h-[30px] w-full min-w-0 items-center gap-[9px] rounded-row px-1.5 py-[5px] text-left text-ui-sm leading-[18px]";
function Chevron({ open }: { readonly open: boolean }) {
  return <ChevronRight size={12} strokeWidth={2.2} className={cn("flex-none text-fg-3 opacity-0 transition-[rotate,opacity] duration-200 ease-expo group-hover/step:opacity-100 group-focus-visible/step:opacity-100 keyboard:transition-none", open && "rotate-90 opacity-100")} aria-hidden="true"/>;
}
/** What a task hands back from inside: its own items, laid out as a Turn's are, under the task. */
function Inside({ items, label }: { readonly items: readonly ReadItem[]; readonly label: string }) {
  const blocks = useMemo(() => lay(items), [items]);
  return <div className="mb-1 ml-[13px] flex min-w-0 flex-col gap-px border-l border-line-strong pl-2" role="group" aria-label={label}><Blocks blocks={blocks}/></div>;
}

/**
 * One action as one line, in the voice of its state ("正在运行 npm test", "运行了 npm test", "运行失败 npm test"), with what came of it
 * beside it: lines added and removed, a failed exit code, the state's word for a state the verb does not say. An action with a stored
 * detail opens its input, output or diff; the program's own name for it is a small line there, never in the line itself.
 */
function ActionRow({ item }: { readonly item: WorkItem }) {
  const ctx = useTurn(), label = workLabel(item), inside = item.type === "subagent" ? ctx.children.get(item.id) ?? [] : [];
  const [open, setOpen] = useState(false), [entering] = useState(!ctx.seen.has(item.id)), panel = useId();
  const expandable = item.detail !== undefined && ctx.loadDetail !== undefined || inside.length > 0;
  const bad = item.status === "failed" || item.status === "unknown";
  const facts = label.added !== undefined || label.removed !== undefined || label.exit !== undefined || label.status !== null
    ? <span className="flex flex-none items-center gap-2 whitespace-nowrap text-caption text-fg-3">
      {label.added !== undefined || label.removed !== undefined ? <span className="mono flex gap-1.5 text-[11px]">{label.added !== undefined ? <span className="text-add-on-tint">+{label.added}</span> : null}{" "}{label.removed !== undefined ? <span className="text-del-on-tint">−{label.removed}</span> : null}</span> : null}
      {" "}{label.exit !== undefined ? <span className="text-red-on-tint">退出码 {label.exit}</span> : null}
      {" "}{label.status !== null ? <span className={item.status === "unknown" ? "text-red-on-tint" : undefined}>{label.status}</span> : null}
    </span> : null;
  const content = <>
    <span className="flex size-[15px] flex-none items-center justify-center"><ActionMark item={item}/></span>
    <span className={cn("flex-none", bad ? "text-red-on-tint" : "text-fg-3")}>{label.verb}</span>{label.object !== null && !label.object.startsWith("“") ? " " : ""}
    {label.object !== null ? <span className={cn("min-w-0 trunc text-fg-2 transition-colors group-hover/step:text-fg", label.mono && "font-mono text-code")} title={label.title}>{label.object}</span> : null}{" "}
    <span className="min-w-2 flex-1"/>{" "}{facts}
    {expandable ? <Chevron open={open}/> : null}
  </>;
  return <li className={cn("action-row min-w-0", entering && "motion-row-in")} data-type={item.type} data-state={item.status}>
    {expandable ? <button type="button" className={cn(ROW, "row border-none bg-transparent text-fg hover:bg-subtle")} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>{content}</button>
      : <div className={ROW}>{content}</div>}
    {expandable ? <Collapsible open={open} id={panel}>
      {item.detail !== undefined && ctx.loadDetail !== undefined ? <StoredDetail content={item.detail} fallback={item.type === "file_change" ? item.changes[0]?.path ?? label.title : label.title} load={ctx.loadDetail} native={item.nativeName}/> : null}
      {inside.length ? <Inside items={inside} label={"子任务里的动作：" + label.text}/> : null}
    </Collapsible> : null}
  </li>;
}

/** A thought as one line, "思考了 3 秒" (or "思考中" while it goes on), folded; it opens to what was thought. A thought with nothing to show is not drawn. */
function ReasoningRow({ item }: { readonly item: ReasoningItem }) {
  const ctx = useTurn(), [choice, setChoice] = useState<boolean | null>(null), panel = useId(), [entering] = useState(!ctx.seen.has(item.id));
  const running = !ctx.over && (item.status === "running" || item.status === "pending"), has = item.text.trim().length > 0;
  if (!has && !running && item.durationMs === undefined) return null;
  const open = has && (choice ?? ctx.detailed);
  const content = <>
    <span className="flex size-[15px] flex-none items-center justify-center text-fg-3">{running ? <Spinner size={14} tone="run" label=""/> : <Brain size={15} aria-hidden="true"/>}</span>
    <span className="flex-1 text-fg-2">{reasoningLabel(item, ctx.over)}</span>
    {has ? <Chevron open={open}/> : null}
  </>;
  return <li className={cn("reasoning-row min-w-0", entering && "motion-row-in")} data-state={item.status}>
    {has ? <button type="button" className={cn(ROW, "row border-none bg-transparent hover:bg-subtle")} aria-expanded={open} aria-controls={panel} onClick={() => setChoice(!open)}>{content}</button> : <div className={ROW}>{content}</div>}
    {has ? <Collapsible open={open} id={panel}><div className="native-thinking mt-0.5 mb-2 ml-[30px] border-l border-line-strong pl-3 text-ui-sm text-fg-2"><StreamingMarkdown text={item.text} isStreaming={running}/>
      {leftOut(item, item.text) > 0 ? <MoreText runId={ctx.run.id} seq={item.seq} rest={leftOut(item, item.text)}/> : null}</div></Collapsible> : null}
  </li>;
}

/** The middle of a long stretch of work the window left out: one line that says how much, and reads it when asked. */
function GapRowView({ gap }: { readonly gap: GapRow }) {
  const ctx = useTurn(), [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [gap.count]);
  return <li className="gap-row min-w-0" data-gap={gap.count}>
    <button type="button" className={cn(ROW, "row border-none bg-transparent text-fg-2 hover:bg-subtle")} disabled={busy || ctx.reads === undefined} onClick={() => { setBusy(true); ctx.reads?.expand(gap.ordinal); }}>
      <span className="flex size-[15px] flex-none items-center justify-center text-fg-3">{busy ? <Spinner size={14} tone="run" label=""/> : <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true"/>}</span>
      <span className="min-w-0 flex-1">{busy ? "正在读取中间的 " : "展开中间的 "}{gap.count} 项</span></button></li>;
}

/** Several actions in a row as one summary line ("运行了 6 条命令，读取了 7 个文件"), folded; it opens to each action's line. */
function ActionGroup({ block }: { readonly block: WorkBlock }) {
  const ctx = useTurn(), summary = useMemo(() => summarizeGroup(block.work), [block.work]), panel = useId();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? opensByDefault(block, !ctx.over, ctx.detailed), live = block.work.some(item => item.status === "running");
  return <div className="action-group min-w-0" data-open={open ? "true" : "false"} data-problems={summary.problems || undefined}>
    <button type="button" className={cn(ROW, "row group/step !w-fit max-w-full border-none bg-transparent pr-2 text-fg hover:bg-subtle")} aria-expanded={open} aria-controls={panel} onClick={() => setChoice(!open)}>
      {live ? <span className="flex size-[15px] flex-none items-center justify-center"><Spinner size={14} tone="run" label=""/></span> : null}
      <span className={cn("min-w-0 trunc transition-colors group-hover/step:text-fg", open ? "text-fg" : "text-fg-2")}>{summary.parts.map((part, index) => <span key={index} className={part.failed ? "text-red-on-tint" : undefined}>{index ? "，" : ""}{part.text}</span>)}
        {block.rows.some(isGap) ? <span className="font-normal text-fg-3">，中间 {block.rows.map(gapOf).find(gap => gap !== undefined)?.count} 项未载入</span> : null}</span>
      <ChevronRight size={12} strokeWidth={2.2} className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-90")} aria-hidden="true"/>
    </button>
    <Collapsible open={open} id={panel}>
      <ul className="m-0 mt-0.5 mb-1.5 ml-[7px] flex min-w-0 list-none flex-col gap-px border-l border-line-strong p-0 pl-[9px]" aria-label="这一组的动作">
        {block.rows.map(row => { const gap = gapOf(row); return gap !== undefined ? <GapRowView key={row.id} gap={gap}/> : row.type === "reasoning" ? <ReasoningRow key={row.id} item={row}/> : <ActionRow key={row.id} item={row as WorkItem}/>; })}
      </ul>
    </Collapsible>
  </div>;
}
/** One action stands as its own line; several are a group. */
function ActionBlock({ block }: { readonly block: WorkBlock }) {
  const only = block.work.length === 1 && block.rows.length === 1 ? block.work[0] : undefined;
  return only !== undefined ? <ul className="m-0 list-none p-0"><ActionRow item={only}/></ul> : <ActionGroup block={block}/>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The other items
// ---------------------------------------------------------------------------------------------------------------------

function QuietLine({ children, icon, tone = "quiet", item }: { readonly children: ReactNode; readonly icon?: ReactNode; readonly tone?: "quiet" | "failed"; readonly item?: string }) {
  return <div className={cn("quiet-line flex min-w-0 items-start gap-2 px-1.5 text-caption", tone === "failed" ? "text-red-on-tint" : "text-fg-3")} role="status" {...(item === undefined ? {} : { "data-item": item })}>
    {icon ? <span className="mt-px flex size-[15px] flex-none items-center justify-center" aria-hidden="true">{icon}</span> : null}<span className="min-w-0 break-words">{children}</span></div>;
}
function outputOf(item: Extract<ReadItem, { type: "artifact" }>): PublicOutput | null {
  if (item.content !== undefined && item.kind !== "link") return { kind: "content", content: item.content };
  return item.uri !== undefined ? { kind: "link", uri: item.uri, name: item.name } : null;
}

/** One item that is not an action or a thought, drawn as what it is. */
function ItemView({ item }: { readonly item: ReadItem }) {
  const ctx = useTurn();
  switch (item.type) {
    case "reasoning": return <ul className="m-0 list-none p-0"><ReasoningRow item={item}/></ul>;
    case "assistant_message": {
      const text = ctx.message(item.messageId)?.text ?? "", rest = leftOut(item, text);
      return text || rest > 0 ? <>{text ? <StreamingMarkdown text={text} isStreaming={!ctx.over && !ctx.cancelling && item.status === "running" && rest === 0} caret={rest === 0} className="text-reading"/> : null}
        {rest > 0 ? <MoreText runId={ctx.run.id} seq={item.seq} rest={rest} label={text ? "显示更多" : "显示这段回复"}/> : null}</> : null;
    }
    case "plan_proposal": return <div className="plan-proposal flex min-w-0 flex-col gap-1"><span className="px-1.5 text-caption text-fg-3">方案</span><StreamingMarkdown text={item.markdown} isStreaming={false} className="text-reading"/></div>;
    // The task list and the wrap-up stand above the message box (the plan bar, the next-step box) and nowhere in the timeline, as in the app.
    case "plan": case "recap": return null;
    case "notice": return <NoticeList notices={[{ severity: item.severity, title: item.text, ...(item.more ? { detail: item.more } : {}) }]}/>;
    case "error": {
      return <div className="run-error flex items-start gap-2 rounded-block bg-surface px-3 py-2.5 text-ui-sm text-fg shadow-hairline" role="status" data-class={item.class}>
        {item.status === "unknown" ? <CircleHelp size={17} strokeWidth={1.9} className="mt-px flex-none text-fg-3" aria-hidden="true"/> : <CircleAlert size={17} strokeWidth={1.9} className="mt-px flex-none text-red" aria-hidden="true"/>}
        <span className="min-w-0 break-words">{failureMessage({ code: item.code ?? "", message: item.message })}</span>
      </div>;
    }
    case "artifact": { const output = outputOf(item); return output === null ? <QuietLine item="artifact">{item.name}</QuietLine> : <OutputList outputs={[output]}/>; }
    case "interrupt": return <QuietLine item="interrupt" icon={<CircleStop size={14}/>}>{quietLine(item)}</QuietLine>;
    case "context_event": case "delegation": case "approval": case "question": { const line = quietLine(item); return line === null ? null : <QuietLine item={item.type} icon={<Info size={14}/>}>{line}</QuietLine>; }
    case "unrecognized": return <QuietLine item="unrecognized" icon={<CircleHelp size={14}/>}>{quietLine(item)}</QuietLine>;
    // Actions are blocks of their own; messages and switches are drawn elsewhere (Segments).
    default: return null;
  }
}

function Blocks({ blocks }: { readonly blocks: readonly Block[] }) {
  return <>{blocks.map(block => block.kind === "work" ? <ActionBlock key={block.key} block={block}/> : <ItemView key={block.item.id} item={block.item}/>)}</>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The hand-over, the end, the footer
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where another Harness, or another model, took the conversation over: a hairline with one sentence in its middle, "<从> → <到> ·
 * <带了什么>", and "查看" after it when there is a packet to read. It is the same line for every hand-over; the tooltip has the rest.
 */
function SwitchView({ item, fresh }: { readonly item: SwitchItem; readonly fresh: boolean }) {
  const ctx = useTurn(), line = switchLine(item), entering = useEntrance(fresh), packetId = line.packetId, view = packetId !== null && ctx.onViewPacket !== undefined ? () => ctx.onViewPacket?.(packetId) : null;
  const between = item.from.harnessId !== item.to.harnessId;
  const edge = (side: "left" | "right") => <span className={cn("h-[.5px] min-w-3 flex-1 bg-line-strong", side === "left" ? "origin-right" : "origin-left", entering && "motion-line-grow")} style={entering ? motionStyle({ delay: 120 }) : undefined}/>;
  const icon = (id: string, name: string) => <BrandIcon brand={id} name={name} size={18}/>;
  return <div className="switch-divider switch-line flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 sm:flex-nowrap" data-delivery={item.delivery ?? "none"} {...(line.attention ? { "data-attention": "" } : {})}>
    {view ? <span aria-hidden="true" className="invisible flex-none text-caption font-medium max-sm:hidden">查看</span> : null}
    <div role="separator" aria-label={line.text} className="flex min-w-0 flex-1 items-center gap-3 text-caption text-fg-3 max-sm:basis-full">
      {edge("left")}
      <span className={cn("flex min-h-[30px] min-w-0 items-center gap-[7px] rounded-[15px] bg-surface py-[3px] pr-3 pl-[7px] shadow-hairline", entering && "motion-fade-in")} title={line.details}>
        {between ? <>{icon(item.from.harnessId, item.from.harness)}<span aria-hidden="true">{line.from}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
            <path pathLength={1} className={entering ? "motion-draw" : undefined} style={entering ? motionStyle({ duration: 160, delay: 100 }) : undefined} d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span className={cn("flex flex-none", entering && "motion-pop-in")} style={entering ? motionStyle({ delay: 220, scaleFrom: .6 }) : undefined}>{icon(item.to.harnessId, item.to.harness)}</span>
          <span aria-hidden="true" className={cn("font-medium text-fg", entering && "motion-fade-in")} style={entering ? motionStyle({ delay: 300 }) : undefined}>{line.to}</span></>
          : <>{icon(item.to.harnessId, item.to.harness)}{line.head !== null ? <span aria-hidden="true" className="font-medium text-fg">{line.head}</span> : null}</>}
        {line.context ? <span aria-hidden="true">{line.head !== null ? "· " : ""}{line.context}</span> : null}
        {line.flag ? <span aria-hidden="true" className={cn("flex-none", line.attention ? "text-amber-on-tint" : undefined)}>{line.head !== null || line.context ? "· " : ""}{line.flag}</span> : null}
      </span>
      {edge("right")}
    </div>
    {view ? <button type="button" className="link-btn flex-none text-caption max-sm:basis-full" aria-label="查看交接单" onClick={view}>查看</button> : null}
  </div>;
}

/**
 * What the Turn changed in its workspace as the Hub saw it, compared at its start and its end: "这一轮改了 3 个文件 +12 −4"; one that shared the
 * workspace with another conversation's Turn says the changes may include that one's. The diff is in the details panel's 改动 tab.
 */
function WorkspaceLine({ turn }: { readonly turn: ReadTurn }) {
  const record = hubRecordOf(turn);
  if (record === undefined || record.changes.length === 0) return null;
  // Not said twice: when the Harness's own lines already show every changed file with its counts, the Hub's record adds nothing to read.
  const shown = turn.items.flatMap(item => item.type === "file_change" && item.by !== "hub" ? item.changes.filter(change => change.added !== undefined || change.removed !== undefined).map(change => change.path) : []);
  if (!record.shared && record.changes.every(change => shown.some(path => path === change.path || path.endsWith("/" + change.path) || change.path.endsWith("/" + path)))) return null;
  const added = record.changes.reduce((sum, change) => sum + (change.added ?? 0), 0), removed = record.changes.reduce((sum, change) => sum + (change.removed ?? 0), 0);
  const counted = added || removed ? " +" + added + " −" + removed : "";
  const files = record.changes.length === 1 ? record.changes[0]!.path : record.changes.length + " 个文件";
  return <QuietLine item="workspace" icon={<FilePen size={14}/>}><span title={record.changes.map(change => change.path).join("\n")}>{record.shared ? "这段时间工作区里的改动（可能含别的对话的）：" + files + counted : "这一轮改了 " + files + counted}</span></QuietLine>;
}

/** How a Turn that is over ended, when that needs saying: "失败 · 模型拒绝了这个请求", "已停止 · 你停止了这一轮". */
function EndView({ turn }: { readonly turn: ReadTurn }) {
  const end = endLine(turn);
  if (end === null) return null;
  const icon = turn.status === "failed" ? <CircleAlert size={15} strokeWidth={1.9} className="text-red" aria-hidden="true"/> : turn.status === "unknown" ? <CircleHelp size={15} strokeWidth={1.9} aria-hidden="true"/> : <CircleStop size={15} strokeWidth={1.9} aria-hidden="true"/>;
  return <QuietLine item="end" icon={icon} tone={end.tone}>{end.text}</QuietLine>;
}

/**
 * What a Turn that goes on is doing now, at its tail: its place in the queue, its start, the action in progress, the reply it writes, what it
 * waits for from you. The arc turns and the words sweep while it works, the time counts every second, and the line leaves when the Turn is over
 * and the footer takes its place.
 */
function LiveLine({ queue, startupHint, waiting, replying }: { readonly queue: QueueNotice | undefined; readonly startupHint: { readonly seconds: number; readonly usual: boolean } | undefined; readonly waiting: "approval" | "question" | undefined; readonly replying: boolean }) {
  const { run, turn } = useTurn(), now = useNow(true);
  const state = liveStatus({ turn, run, now, startupHint, queue, waiting, replying });
  const since = turn.startedAt === undefined || now - turn.startedAt < 3000 ? null : elapsed(now - turn.startedAt);
  if (state.quiet) return null;
  return <div className="live-line motion-fade-in flex min-w-0 items-start gap-[7px] px-1.5 text-ui-sm text-fg-3" data-state={state.tone}>
    <LiveIcon tone={state.tone} className="mt-[2.5px]"/>
    <span className={cn("response-status min-w-0", state.thinking && "motion-breathe")} role="status">{state.wrap ? state.text : <SwapText text={state.text} shimmer={state.tone === "run"} className="max-w-full"/>}</span>
    {state.timer && since !== null ? <span className="motion-fade-in flex-none whitespace-nowrap tabular-nums">· {since}</span> : null}
  </div>;
}

/** The explanation of a Turn that waits in the queue, with the deadline counting down. */
function QueuedLine({ queue }: { readonly queue: QueueNotice }) { return <QueuedTurn queue={queue}/>; }

function useCopy(text: string): { readonly state: "idle" | "copied" | "failed"; readonly write: () => void } {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle"), timer = useRef<ReturnType<typeof setTimeout> | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const write = () => {
    void navigator.clipboard.writeText(text).then(() => {
      if (!mounted.current) return;
      setState("copied");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1800);
    }, () => { if (mounted.current) setState("failed"); });
  };
  return { state, write };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Turn
// ---------------------------------------------------------------------------------------------------------------------

type Segment = { readonly kind: "switch"; readonly item: SwitchItem } | { readonly kind: "user"; readonly item: Extract<ReadItem, { type: "user_message" }> } | { readonly kind: "assistant"; readonly blocks: readonly Block[] };
/**
 * The Turn's blocks cut at what the transcript draws on its own: a hand-over line and your message each stand in the column as they
 * always did, and what the Harness did between them is one block of content. The last piece is always the Harness's, even when
 * empty: it carries what the Turn waits for, how it ended and its footer.
 */
function segments(blocks: readonly Block[]): readonly Segment[] {
  const result: Segment[] = [];
  let current: Block[] | null = null;
  for (const block of blocks) {
    if (block.kind === "item" && (block.item.type === "switch" || block.item.type === "user_message")) {
      current = null;
      result.push(block.item.type === "switch" ? { kind: "switch", item: block.item } : { kind: "user", item: block.item as Extract<ReadItem, { type: "user_message" }> });
      continue;
    }
    if (current === null) { current = []; result.push({ kind: "assistant", blocks: current }); }
    current.push(block);
  }
  if (result.at(-1)?.kind !== "assistant") result.push({ kind: "assistant", blocks: [] });
  return result;
}

const turnIsOver = (run: PublicRun): boolean => run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "unknown";

export interface ProtocolTurnProps {
  readonly run: PublicRun;
  /** A message of the conversation by its identity: where the text of each reply and of your message comes from. */
  readonly message: (id: string) => PublicMessage | undefined;
  /** Whether a message of yours arrived after the conversation opened, so that it rises into place. */
  readonly arrived: (id: string) => boolean;
  readonly detailed: boolean;
  readonly onEdit: (text: string) => void;
  readonly onRetry: ((text: string, attachments: PublicRun["attachments"]) => void) | undefined;
  readonly loadToolDetail?: ToolDetailLoader | undefined;
  readonly onBranch?: ((runId: string) => void) | undefined;
  /** Sends this Turn's message again, edited, from its place: a branch of the conversation (ChatPage decides when it may). */
  readonly onResend?: ((runId: string, text: string, attachments: PublicRun["attachments"]) => void) | undefined;
  /** Makes another alternative of a Turn's place the conversation's path. */
  readonly onSelectBranch?: ((runId: string) => void) | undefined;
  /** A Turn goes on: neither of the two is taken now, and the page says why. */
  readonly branchBusy?: boolean;
  readonly onDetails?: ((runId: string) => void) | undefined;
  readonly detailsOpen?: boolean;
  /** Opens the handoff packet of a hand-over line. */
  readonly onViewPacket?: ((packetId: string) => void) | undefined;
  readonly startupHint?: { readonly seconds: number; readonly usual: boolean } | undefined;
  readonly queue?: QueueNotice | undefined;
  /** What this Turn waits for from the user now, when it waits. */
  readonly waiting?: "approval" | "question" | undefined;
  /** Waiting approvals and questions of this Turn, drawn at its end. */
  readonly children?: ReactNode;
  /** What the Turn reads of itself when shown; absent where nothing can be read (the details panel). */
  readonly reads?: TurnReads | undefined;
}

/**
 * A Run whose Turn the page could not read: your message where it stands, and one line that says so with the reason (the protocol's
 * version, a Turn without what it must have). Nothing else of the Turn is drawn from anything but the protocol, so that the fault is seen
 * and not covered; only the reply's own words, which are a message of the conversation, are kept.
 */
function UnreadableTurn({ run, message, arrived, onEdit }: Pick<ProtocolTurnProps, "run" | "message" | "arrived" | "onEdit">) {
  const sent = message(run.userMessageId), answer = message(run.assistantMessageId), bubble = sent === undefined ? null : <UserMessage message={sent} run={run} onEdit={onEdit}/>;
  return <>
    {sent === undefined ? null : arrived(sent.id) ? <div className="motion-message-in">{bubble}</div> : <div>{bubble}</div>}
    <article className="message assistant-message unreadable-turn flex min-w-0 flex-col gap-2.5" data-run-status={run.status} aria-label="这一轮无法显示">
      <QuietLine item="unreadable" icon={<CircleHelp size={14}/>} tone="failed">这一轮无法显示：{run.protocolProblem ?? "服务没有给出这一轮的协议数据"}</QuietLine>
      {/* The reply is a message of the conversation, not part of the Turn: its words are not lost with the Turn that could not be read. */}
      {answer?.text ? <StreamingMarkdown text={answer.text} isStreaming={false} className="text-reading"/> : null}
    </article>
  </>;
}

/**
 * One Turn from the protocol: the hand-over line and your message where they stand, then the Harness's items in order. While the
 * Turn goes on a line says what it waits for when nothing else shows that it works; once it is over, a line says why it ended
 * as it did when that is not the ordinary end, and one footer, "Harness · 模型 · 用时 · 输入 · 输出", ends it. A reply's actions
 * (copy, branch, details, try again) show when it is pointed at, and a way forward from a failure stays in sight.
 */
export const ProtocolTurn = memo(function ProtocolTurn(props: ProtocolTurnProps) {
  return props.run.protocol === undefined ? <UnreadableTurn run={props.run} message={props.message} arrived={props.arrived} onEdit={props.onEdit}/> : <TurnView {...props} turn={props.run.protocol}/>;
});

function TurnView({ run, turn: given, message, arrived, detailed, onEdit, onRetry, loadToolDetail, onBranch, onResend, onSelectBranch, branchBusy, onDetails, detailsOpen, onViewPacket, startupHint, queue, waiting, reads, children }: ProtocolTurnProps & { readonly turn: ReadTurn }) {
  // The reply is a message of the conversation, which arrives on the stream apart from the Turn's other items: its words are shown at once.
  const replyMessage = message(run.assistantMessageId), turn = useMemo(() => withReply(given, replyMessage), [given, replyMessage]);
  const arrangement = useMemo(() => arrange(turn, { asking: waiting === "approval" }), [turn, waiting]), over = arrangement.over, cancelling = run.cancelRequested;
  // A hand-over line comes in only when the Turn that carries it was accepted moments ago; one drawn with the page's history stays still.
  const [recent] = useState(() => run.timing !== undefined && Date.now() - run.timing.acceptedAt < 5000 && !turnIsOver(run));
  // A Turn watched to its end brings its footer in; one found ended has it from the start.
  const [watched] = useState(() => !turnIsOver(run));
  // The items the reader has seen: a Turn found as it is has none that come in; one watched running has each as it arrives.
  const [seen] = useState<Set<string>>(() => shownSteps(run.id) ?? new Set(turn.items.map(item => item.id)));
  useLayoutEffect(() => { rememberShown(run.id, seen); }, [run.id, seen]);
  useLayoutEffect(() => { for (const item of turn.items) seen.add(item.id); }, [turn.items, seen]);
  const context = useMemo<TurnContext>(() => ({ turn, run, reads, over, cancelling, detailed, children: arrangement.children, message, loadDetail: loadToolDetail, seen, onViewPacket }),
    [turn, run, reads, over, cancelling, detailed, arrangement.children, message, loadToolDetail, seen, onViewPacket]);
  const pieces = useMemo(() => segments(arrangement.blocks), [arrangement.blocks]);
  // What the Harness said in this Turn, for copying and for the line that says the Turn is replying: its segments, which stand between its actions, one after another.
  const replies = turn.items.flatMap(item => item.type === "assistant_message" ? [message(item.messageId)?.text ?? ""] : []);
  const reply = replies.filter(Boolean).join("\n\n");
  const copy = useCopy(reply);
  const retry = onRetry !== undefined && (turn.status === "failed" || turn.status === "cancelled");
  // A reply that ended may be tried again: the same message sent again from its place, on a branch of its own.
  const again = onRetry !== undefined && !retry && over;
  const quiet = !(copy.state !== "idle" || detailsOpen === true || retry);
  const harness = turn.executor.harness;
  return <Context.Provider value={context}>{pieces.map((piece, index) => {
    if (piece.kind === "switch") return <SwitchView key={"switch:" + piece.item.id} item={piece.item} fresh={recent}/>;
    if (piece.kind === "user") {
      const sent = message(piece.item.messageId);
      if (sent === undefined) return null;
      const branching: UserMessageBranching = { branch: (run as { readonly branch?: TurnBranchView }).branch, onResend: onResend === undefined ? undefined : text => onResend(run.id, text, run.attachments), onSelectBranch, busy: branchBusy === true };
      const bubble = <UserMessage message={sent} run={run} onEdit={onEdit} branching={branching}/>;
      return arrived(sent.id) ? <div key={"user:" + piece.item.id} className="motion-message-in">{bubble}</div> : <div key={"user:" + piece.item.id}>{bubble}</div>;
    }
    const last = index === pieces.length - 1;
    return <article key={"turn:" + run.id + ":" + index} className={cn("message assistant-message protocol-turn group flex min-w-0 flex-col gap-2.5", !over && "is-active")} data-run-status={run.status} aria-busy={!over} aria-label={harness + " 的回复" + (over ? "" : "（进行中）")}>
      <Blocks blocks={piece.blocks}/>
      {last ? <>
        {!over ? <LiveLine queue={queue} startupHint={startupHint} waiting={waiting} replying={reply !== ""}/> : null}
        {queue !== undefined && run.status === "queued" && !cancelling ? <QueuedLine queue={queue}/> : null}
        {children}
        {over ? <WorkspaceLine turn={turn}/> : null}
        {over ? <EndView turn={turn}/> : null}
        {over ? <div className={cn("turn-meta -mt-1 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-3", watched && "motion-fade-in")}>
          <span className="turn-footer flex min-w-0 items-center gap-1.5"><BrandIcon brand={turn.executor.harnessId} name={harness} size={16}/><span className="min-w-0 break-words" title={turnFooter(turn)}>{turnByline(turn)}</span></span>
          <div className={cn("message-actions flex items-center gap-0.5 transition-opacity duration-150", quiet && "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
            {reply ? <ActionButton label={copy.state === "copied" ? "已复制回复" : "复制回复"} onClick={copy.write}>{copy.state === "copied" ? <Check size={14}/> : <Copy size={14}/>}</ActionButton> : null}
            {onBranch && (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") ? <ActionButton label="从这里分支" onClick={() => onBranch(run.id)}><GitBranch size={14}/></ActionButton> : null}
            {onDetails ? <ActionButton label="执行详情" pressed={detailsOpen ?? false} onClick={() => onDetails(run.id)}><Info size={14}/></ActionButton> : null}
            {again ? <ActionButton label="重试这条回复" onClick={() => onRetry(run.input, run.attachments)}><RotateCcw size={14}/></ActionButton> : null}
            {retry ? <button type="button" className="btn btn-ghost btn-sm retry-response ml-1 min-w-24" onClick={() => onRetry(run.input, run.attachments)}><RotateCcw size={13}/>重试回复</button> : null}
          </div>
          {copy.state === "failed" ? <span className="text-red" role="status">无法使用剪贴板，可选中文本后复制。</span> : copy.state === "copied" ? <span className="sr-only" role="status">已复制</span> : null}
        </div> : null}
      </> : null}
    </article>;
  })}</Context.Provider>;
}

/**
 * The steps of a Turn for the details panel: its actions, thoughts and compactions as the transcript draws them, each run of them open, and
 * not its reply, its notices or the rest. Nothing in it comes in: the panel shows what has happened.
 */
export function TurnSteps({ run, turn, loadDetail, asking }: { readonly run: PublicRun; readonly turn: ReadTurn; readonly loadDetail: ToolDetailLoader | undefined; readonly asking: boolean }) {
  const arrangement = useMemo(() => arrange(turn, { asking }), [turn, asking]);
  const [seen] = useState<Set<string>>(() => new Set(turn.items.map(item => item.id)));
  useLayoutEffect(() => { for (const item of turn.items) seen.add(item.id); }, [turn.items, seen]);
  const blocks = useMemo(() => arrangement.blocks.filter(block => block.kind === "work" || block.item.type === "reasoning" || block.item.type === "context_event"), [arrangement.blocks]);
  const context = useMemo<TurnContext>(() => ({ turn, run, reads: undefined, over: arrangement.over, cancelling: false, detailed: true, children: arrangement.children, message: () => undefined, loadDetail, seen, onViewPacket: undefined }),
    [turn, run, arrangement, loadDetail, seen]);
  if (blocks.length === 0) return null;
  return <Context.Provider value={context}><div className="turn-steps flex min-w-0 flex-col gap-px" role="group" aria-label="这一轮的步骤"><Blocks blocks={blocks}/></div></Context.Provider>;
}
