import { Brain, Check, ChevronRight, CircleAlert, CircleDashed, CircleHelp, CircleStop, Copy, GitBranch, Info, PencilLine, RotateCcw } from "lucide-react";
import { Children, memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunStatus } from "../../../src/contracts/session.js";
import { cancelledLabel } from "../../../src/contracts/session.js";
import type { HarnessView } from "../../../src/contracts/web.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { failureMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { duration, elapsed } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { finished, groupSteps, noteMount, readsLabel, runDuration, stepLabel, toolSummary, toolTree, type Tool } from "../lib/turn.js";
import { Collapsible, DrawnCheck, motionStyle, SwapText } from "../ui/motion.js";
import { Spinner, StatusDot, Tip } from "../ui/primitives.js";
import { ActivityList, NoticeList, OutputList, ToolList, usageParts, type ToolDetailLoader } from "./Activity.js";
import { MessageAttachments } from "./Attachments.js";
import { BrandIcon } from "./BrandIcon.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** What a queued Turn shows about what it waits for (ADR-036); no paths. */
export type QueueNotice = ({
  /** Another conversation's work holds the workspace: which one, what it waits for (approval, an answer, or nothing: it runs), and the deadline. */
  readonly kind: "workspace"; readonly holderTitle: string; readonly holderWaits: "approval" | "question" | null; readonly endsAt: number; readonly onOpen?: (() => void) | undefined;
} | {
  /** Every slot is taken: how many conversations run; there is no deadline of its own. */
  readonly kind: "slot"; readonly running: number;
}) & { readonly cancelling: boolean; readonly onCancel?: (() => void) | undefined };

/**
 * What a running Turn says it is doing (ADR-054 §3, Interaction board's states), from the phases the Runtime recorded and
 * the tool running now. `tone` picks the symbol: "run" a turning arc with the sweep over the words, "wait" the amber dot of
 * something waiting for you, "queue" the dashed circle of work not started. Queue explanations wrap instead of sliding.
 */
export interface LiveStatus {
  readonly text: string;
  readonly tone: "run" | "wait" | "queue";
  /** The time since the input was accepted follows the words. */
  readonly timer: boolean;
  readonly wrap: boolean;
  /** Thinking: the words breathe after 3 s and change at 15, 30, 45 and 60 s (Motion board #04). */
  readonly thinking: boolean;
}
const THINKING: readonly (readonly [number, string])[] = [[60_000, "快想好了"], [45_000, "想得更深"], [30_000, "再想想"], [15_000, "还在想"]];
function clip(text: string, limit = 80): string { const characters = [...text]; return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : text; }
/** The running tool in the words of its step: "正在运行 git diff --stat", or "正在读取 3 个文件" inside a group of reads. */
function runningText(tools: readonly Tool[], running: Tool): string {
  const { roots, children } = toolTree(tools);
  const group = groupSteps(roots, children).find(step => step.kind === "reads" && step.tools.includes(running));
  const label = group?.kind === "reads" ? readsLabel(group.tools) : stepLabel(running, (children.get(running.id)?.length ?? 0) > 0);
  if (group) return label.running!;
  return label.running ? label.running + " " + clip(label.target) : "正在执行 " + clip(label.target);
}
/** What a running Turn says now, and with which symbol; a finished one is described by its process line instead. */
export function liveStatus(run: PublicRun | undefined, status: RunStatus, harness: string, now: number, startupHint?: { readonly seconds: number; readonly usual: boolean }, queue?: QueueNotice, waiting?: "approval" | "question", text = "", docked = true): LiveStatus {
  const plain = { tone: "run" as const, timer: true, wrap: false, thinking: false };
  if (run?.cancelRequested) return { ...plain, text: "正在停止并清理资源" };
  // An approval stands in the composer's place (ADR-054 §5); one still shown inside the Turn is pointed at by nothing.
  if (waiting) return { ...plain, tone: "wait", text: waiting === "question" ? "等你回答" : docked ? "等你批准，请求停在下方输入框的位置" : "等你批准" };
  const queued = { tone: "queue" as const, timer: false, wrap: true, thinking: false };
  if (run?.awaitingSwitchId && status === "queued") return { ...queued, text: "等待选择切换生效" };
  if (queue?.kind === "workspace" && status === "queued") return { ...queued, text: `排队中：等待对话「${queue.holderTitle}」释放工作区（${queue.holderWaits === "approval" ? "它正在等待你的审批" : queue.holderWaits === "question" ? "它正在等待你的回答" : "它正在运行"}）` };
  if (queue?.kind === "slot" && status === "queued") return { ...queued, text: `等待开始：${queue.running} 个对话正在执行，其中一个结束后自动开始` };
  switch (status) {
    case "queued": return { ...queued, text: "等待开始" };
    case "preparing": return { ...plain, text: "正在启动 " + harness + (startupHint !== undefined && startupHint.seconds >= 2 ? (startupHint.usual ? "（通常约 " : "（上次约 ") + Math.round(startupHint.seconds) + " 秒）" : "") };
    case "settling": return { ...plain, text: "正在结束执行" };
    case "running": {
      const tools = run?.tools ?? [], running = toolSummary(tools, true).running, timing = run?.timing;
      if (running) return { ...plain, text: runningText(tools, running) };
      if (text) return { ...plain, text: "正在回复" };
      if (timing !== undefined && timing.dispatchedAt === undefined) return { ...plain, text: "已连接 " + harness + "，正在发送" };
      const waited = timing?.dispatchedAt !== undefined && timing.firstOutputAt === undefined ? now - timing.dispatchedAt : 0;
      return { ...plain, thinking: true, text: THINKING.find(([after]) => waited >= after)?.[1] ?? "正在思考" };
    }
    default: return { ...plain, timer: false, text: activityLabel(run, status, harness, now) };
  }
}
/** What the Turn is doing, or how it ended, in words (the Interaction board's eight states). */
export function activityLabel(run: PublicRun | undefined, status: RunStatus, harness: string, now: number, startupHint?: { readonly seconds: number; readonly usual: boolean }, queue?: QueueNotice, waiting?: "approval" | "question"): string {
  switch (status) {
    case "completed": return "已完成";
    case "cancelled": return run ? cancelledLabel(run) : "已取消";
    case "failed": return "回复未能完成";
    case "unknown": return "结果未知：可能已经执行，不会自动重发";
    default: return liveStatus(run, status, harness, now, startupHint, queue, waiting).text;
  }
}
/** First-output and total time of a finished Run, measured from when its input was accepted. */
export function timingText(run: PublicRun): string | null {
  const timing = run.timing; if (!timing || timing.endedAt === undefined) return null;
  return [...(timing.firstOutputAt === undefined ? [] : ["首字 " + duration(timing.firstOutputAt - timing.acceptedAt)]), "用时 " + duration(timing.endedAt - timing.acceptedAt)].join(" · ");
}
/** How soon the first output came; the total time is part of the process line above the reply. */
function firstOutputText(run: PublicRun): string | null {
  const timing = run.timing;
  return timing?.endedAt === undefined || timing.firstOutputAt === undefined ? null : "首字 " + duration(timing.firstOutputAt - timing.acceptedAt);
}

/**
 * Whether this element is news (ADR-054 §3: motion only says what happened). Decided once, before the first paint: things
 * drawn with the rest of a page stay still; a message just sent, a Turn just started, a hand-over just made come in.
 */
function useEntrance(fresh: boolean): boolean {
  const [entering, setEntering] = useState(false);
  useLayoutEffect(() => { if (noteMount(fresh)) setEntering(true); }, []);
  return entering;
}
function acceptedRecently(run: PublicRun | undefined): boolean { return run?.timing !== undefined && Date.now() - run.timing.acceptedAt < 5000; }

/**
 * The life of a Turn's status line. A Turn found finished is "settled" at once. One seen finishing hands over (Motion board
 * #12): the arc and the words leave in 200 ms, "已完成" arrives 0.21 s later, and at 1.1 s the process folds into one
 * summary line (#13). The timers belong to the hook and stop when the Turn unmounts.
 */
type Phase = "live" | "handoff" | "done" | "settled";
function usePhase(terminal: boolean): Phase {
  const [phase, setPhase] = useState<Phase>(terminal ? "settled" : "live");
  const [was, setWas] = useState(terminal);
  if (was !== terminal) { setWas(terminal); setPhase(terminal ? "handoff" : "live"); }
  useEffect(() => {
    if (phase !== "handoff" && phase !== "done") return;
    const timer = setTimeout(() => setPhase(phase === "handoff" ? "done" : "settled"), phase === "handoff" ? 460 : 640);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase;
}

/** About how wide text of the status line (13 px) is: full-width characters 13 px, the rest 8 px; a little over, never under. */
function textWidth(text: string): number { let width = 0; for (const character of text) width += /[\u2e80-\uffff]/u.test(character) ? 13 : 8; return width; }
/** The symbol of a state (Icons board), 15 px: the arc while working, amber while waiting for you, dashed before it starts. */
function LiveIcon({ tone, className }: { readonly tone: LiveStatus["tone"]; readonly className?: string | undefined }) {
  return <span className={cn("flex size-[15px] flex-none items-center justify-center", className)}>
    {tone === "run" ? <Spinner size={15} tone="run" label=""/> : tone === "wait" ? <StatusDot tone="wait"/> : <CircleDashed size={15} className="text-fg-3" aria-hidden="true"/>}
  </span>;
}
interface Outcome { readonly icon: ReactNode; readonly arriving: string; readonly settled: string; readonly tone: "done" | "fail" | "quiet" }
/** How a finished Turn reads: the drawn check, then its tools, failures and unfinished steps, and how long it took. */
function outcome(run: PublicRun | undefined, status: RunStatus, text: string, drawing: boolean): Outcome {
  const tools = run?.tools ?? [], summary = tools.length ? toolSummary(tools, false).text : "", total = run ? runDuration(run) : null, time = total === null ? "" : duration(total);
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  switch (status) {
    case "failed": { const words = join("回复未能完成", summary, time); return { icon: <CircleAlert size={15} strokeWidth={1.9} className="text-red" aria-hidden="true"/>, arriving: words, settled: words, tone: "fail" }; }
    case "cancelled": { const words = join(run ? cancelledLabel(run) : "已取消", summary, time); return { icon: <CircleStop size={15} strokeWidth={1.9} className="text-fg-3" aria-hidden="true"/>, arriving: words, settled: words, tone: "quiet" }; }
    case "unknown": { const words = join("结果未知：可能已经执行，不会自动重发", summary, time); return { icon: <CircleHelp size={15} strokeWidth={1.9} className="text-fg-3" aria-hidden="true"/>, arriving: words, settled: words, tone: "quiet" }; }
    default: {
      const done = (text ? "已完成" : "已完成，没有文本输出") + (time ? " · 用时 " + time : "");
      return { icon: <DrawnCheck circle size={15} animate={drawing} delay={210} className="text-fg-3"/>, arriving: done, settled: summary ? join(summary, time) : done, tone: "done" };
    }
  }
}

interface ProcessProps {
  readonly run: PublicRun | undefined; readonly status: RunStatus; readonly text: string; readonly phase: Phase; readonly detailed: boolean; readonly now: number;
  readonly harness: string; readonly startupHint?: { readonly seconds: number; readonly usual: boolean } | undefined; readonly queue?: QueueNotice | undefined;
  readonly waiting?: "approval" | "question" | undefined; readonly loadDetail: ToolDetailLoader | undefined; readonly entering: boolean;
  /** No approval or question is shown inside the Turn: a waiting approval stands where the composer is. */
  readonly docked: boolean;
  /** The Turn ended and its reply is fully shown: the line hands over only then, after the text it ends. */
  readonly ended: boolean;
}
/**
 * The process of a Turn in three layers (ADR-054 §5): one line that says what is happening or, once it ended, what was done;
 * the steps beneath it (open while the Turn runs, and always in the detailed density); and each step's raw input and
 * output. Failures and unfinished steps are always counted in the line, so folding never hides them.
 */
function TurnProcess({ run, status, text, phase, detailed, now, harness, startupHint, queue, waiting, loadDetail, entering, docked, ended }: ProcessProps) {
  const terminal = finished(status), steps = useId();
  const tools = run?.tools ?? [], activities = run?.activities ?? [], thinking = run?.thinking ?? "";
  const expandable = tools.length > 0 || activities.length > 0 || thinking.length > 0;
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = expandable && (choice ?? (detailed || phase !== "settled"));
  const [thoughts, setThoughts] = useState<boolean | null>(null);
  // A Turn that ended while its last words are still being shown keeps saying it is replying until they are.
  const live = ended ? null : terminal ? { text: "正在回复", tone: "run" as const, timer: true, wrap: false, thinking: false } : liveStatus(run, status, harness, now, startupHint, queue, waiting, text, docked);
  // The words and symbol the status had last, kept for the 200 ms in which they leave (Motion board #12).
  const last = useRef<LiveStatus | null>(live);
  if (live) last.current = live;
  const end = ended ? outcome(run, status, text, phase === "handoff" || phase === "done") : null;
  const since = run?.timing ? elapsed(now - run.timing.acceptedAt) : null;
  // The words slide to their own width (SwapText); a label longer than the column ends in "…" at the room left beside the
  // symbol, the timer and the chevron, measured from the column so that the sliding width never limits itself.
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setRoom(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const budget = (timer: string | null) => room === null ? undefined : { "--label-max": Math.max(48, room - 16 - 22 - (timer === null ? 0 : textWidth(timer) + 7) - (expandable ? 19 : 0) - 2) + "px" } as CSSProperties;
  const fit = "max-w-full min-w-0 overflow-hidden [&>.swap-text-layer]:max-w-(--label-max) [&>.swap-text-layer]:overflow-hidden [&>.swap-text-layer]:text-ellipsis [&>.swap-text-layer]:align-bottom";
  // What a finished Turn did wraps instead: its failures and unfinished steps must stay readable at any width (C04).
  const wrap = "max-w-full min-w-0 overflow-hidden whitespace-normal [&>.swap-text-layer]:max-w-(--label-max) [&>.swap-text-layer]:whitespace-normal [&>.swap-text-layer]:align-top";
  const liveLayer = (state: LiveStatus, leaving: boolean) => {
    const timer = state.timer && since !== null ? "· 已用 " + since : null;
    return <span key="live" className={cn("flex min-w-0 items-center gap-[7px]", state.wrap && "items-start", leaving && "motion-depart")} aria-hidden={leaving || undefined}>
      <LiveIcon tone={state.tone} className={state.wrap ? "mt-[2.5px]" : undefined}/>
      {state.wrap ? <span className={cn("min-w-0 whitespace-normal", !leaving && "response-status")} role={leaving ? undefined : "status"}>{state.text}</span>
        : <span className={cn("flex min-w-0", !leaving && "response-status", state.tone === "wait" && "font-medium text-amber", state.thinking && "motion-breathe")} role={leaving ? undefined : "status"} style={budget(timer)}>
          <SwapText text={state.text} shimmer={state.tone === "run"} className={fit}/></span>}
      {timer ? <span className="flex-none whitespace-nowrap">{timer}</span> : null}
    </span>;
  };
  const words = end ? phase === "settled" ? end.settled : end.arriving : "";
  const doneLayer = end ? <span key="done" className={cn("flex min-w-0 items-start gap-[7px]", (phase === "handoff" || phase === "done") && "motion-arrive")}>
    <span className="mt-[2.5px] flex size-[15px] flex-none items-center justify-center">{end.icon}</span>
    <span className={cn("flex min-w-0", !text && "response-status", end.tone === "fail" ? "text-red" : "")} style={budget(null)}><SwapText text={words} className={wrap}/></span>
  </span> : null;
  const layers = <span className="grid min-w-0 [&>*]:col-start-1 [&>*]:row-start-1">
    {ended ? <>{phase === "handoff" && last.current ? liveLayer(last.current, true) : null}{doneLayer}</> : live ? liveLayer(live, false) : null}
  </span>;
  const chevron = expandable ? <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("mt-1 flex-none self-start text-fg-3 transition-[rotate] duration-200 ease-expo keyboard:transition-none", open && "rotate-90")}/> : null;
  const rowClass = "process-summary flex min-h-7 max-w-full min-w-0 items-start gap-[7px] self-start rounded-row py-1 text-ui-sm text-fg-3";
  // A Turn just started shows its status 0.25 s after the message (Motion board #01); the container stays the same element
  // when the line becomes a button for the first step, so the entrance never plays twice.
  return <div ref={box} className={cn("turn-process flex min-w-0 flex-col", entering && "motion-fade-in")} style={entering ? motionStyle({ delay: 250 }) : undefined}>
    {expandable ? <button type="button" className={cn(rowClass, "row -ml-2 border-none bg-transparent px-2 text-left")} aria-expanded={open} aria-controls={steps} onClick={() => setChoice(!open)}>{layers}{chevron}</button>
      : <div className={cn(rowClass, "-ml-2 px-2")}>{layers}</div>}
    {expandable ? <Collapsible open={open} id={steps} className="grid-cols-[minmax(0,1fr)]">
      <div className="mt-1 mb-1.5 ml-[7px] flex min-w-0 flex-col gap-px border-l border-line-strong pl-[9px]">
        {thinking ? <div className="flex min-w-0 flex-col">
          <button type="button" aria-expanded={thoughts ?? detailed} onClick={() => setThoughts(!(thoughts ?? detailed))} className="row group/step flex min-h-[30px] w-full items-center gap-[9px] border-none bg-transparent px-1.5 py-[5px] text-left text-ui-sm leading-[18px] text-fg-2">
            <span className="flex size-[15px] flex-none items-center justify-center text-fg-3"><Brain size={15} aria-hidden="true"/></span><span className="flex-1">思考过程</span>
            <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" className={cn("flex-none text-fg-3 transition-[rotate] duration-200 ease-expo keyboard:transition-none", (thoughts ?? detailed) && "rotate-90")}/>
          </button>
          <Collapsible open={thoughts ?? detailed} className="grid-cols-[minmax(0,1fr)]"><div className="native-thinking mt-0.5 mb-2 ml-[30px] border-l border-line-strong pl-3 text-ui-sm text-fg-2"><StreamingMarkdown text={thinking} isStreaming={!terminal}/></div></Collapsible>
        </div> : null}
        {activities.length ? <ActivityList activities={activities}/> : null}
        {tools.length ? <ToolList tools={tools} active={!terminal} loadDetail={loadDetail}/> : null}
      </div>
    </Collapsible> : null}
  </div>;
}

function ActionButton({ label, onClick, children, pressed }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode; readonly pressed?: boolean }) {
  return <Tip label={label} side="bottom"><button type="button" className="icon-btn message-action size-7 text-fg-3" aria-label={label} {...(pressed === undefined ? {} : { "aria-pressed": pressed })} onClick={onClick}>{children}</button></Tip>;
}

/** Your message: a light grey bubble on the right of the reading column (Conversation board), with the way to edit it again. */
export const UserMessage = memo(function UserMessage({ message, run, onEdit }: { readonly message: PublicMessage; readonly run: PublicRun | undefined; readonly onEdit: (text: string) => void }) {
  // A message just sent springs up 10 px as it fades in (Motion board #15); one drawn with the page does not.
  const entering = useEntrance(acceptedRecently(run));
  return <article className="message user-message group flex flex-col items-end gap-1.5">
    {run?.attachments?.length ? <MessageAttachments attachments={run.attachments}/> : null}
    <div className="flex w-full min-w-0 items-end justify-end gap-1">
      <div className="flex h-7 flex-none items-center opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <ActionButton label="放回输入框" onClick={() => onEdit(message.text)}><PencilLine size={14}/></ActionButton>
      </div>
      <div className={cn("max-w-[82%] min-w-0 rounded-[18px] bg-subtle px-[15px] py-2.5 text-reading leading-6 whitespace-pre-wrap break-words text-fg", entering && "motion-message-in")}><span className="sr-only">你：</span>{message.text}</div>
    </div>
  </article>;
});

/**
 * The actions of a queued Turn. One waiting for its workspace says how long it may still wait (it is never sent after
 * that); one waiting for a slot has no deadline of its own, since every running Turn is bounded by its budgets.
 */
function QueuedTurn({ queue, now }: { readonly queue: QueueNotice; readonly now: number }) {
  return <div className="queued-turn -mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] text-caption text-fg-3">
    {queue.kind === "workspace"
      ? <small className="text-caption" title="HarnessHub 为外部等待设的期限；到期后这条消息不会发出，也不会自动重试。">最多再等 {Math.max(1, Math.ceil((queue.endsAt - now) / 60000))} 分钟，到时这条消息不会发出。</small>
      : <small className="text-caption" title="同时执行的对话有上限；每个正在执行的回合都受自己的期限约束，所以位置总会空出。">没有单独的等待期限，按发送先后轮到。</small>}
    {queue.kind === "workspace" && queue.onOpen ? <button type="button" className="link-btn text-caption" onClick={queue.onOpen}>打开那个对话</button> : null}
    {queue.onCancel ? <button type="button" className="link-btn text-caption" disabled={queue.cancelling} onClick={queue.onCancel}>{queue.cancelling ? "正在取消…" : "取消排队"}</button> : null}
  </div>;
}

export interface TurnProps {
  readonly message: PublicMessage | undefined;
  readonly run: PublicRun | undefined;
  readonly harnesses: readonly HarnessView[];
  readonly providers: readonly ProviderView[];
  /** Display names of models and option values for the Harness the composer has loaded. */
  readonly describe: (run: PublicRun) => string;
  readonly detailed: boolean;
  readonly onRetry: ((text: string, attachments: PublicRun["attachments"]) => void) | undefined;
  readonly loadToolDetail?: ToolDetailLoader | undefined;
  readonly onBranch?: ((runId: string) => void) | undefined;
  readonly onDetails?: ((runId: string) => void) | undefined;
  readonly detailsOpen?: boolean;
  readonly startupHint?: { readonly seconds: number; readonly usual: boolean } | undefined;
  readonly queue?: QueueNotice | undefined;
  readonly busyHolder?: { readonly title: string; readonly onOpen: () => void } | undefined;
  /** What this Turn waits for from the user now, when it waits. */
  readonly waiting?: "approval" | "question" | undefined;
  /** Waiting approvals and questions of this Turn, rendered at its end. */
  readonly children?: ReactNode;
}
/**
 * One assistant Turn (Conversation board): who answered with which model and thinking level, the process behind one line,
 * the reply, and what it produced. Usage and actions appear on hover, except where a way forward (retry) is needed.
 */
export const AssistantTurn = memo(function AssistantTurn({ message, run, harnesses, describe, detailed, onRetry, loadToolDetail, onBranch, onDetails, detailsOpen, startupHint, queue, busyHolder, waiting, children }: TurnProps) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const status = run?.status ?? message?.status ?? "unknown";
  const terminal = finished(status);
  // Whether the reply is still being shown (its last words come in at the display pace after the Run ended, ADR-054 §3).
  const [writing, setWriting] = useState(false);
  const ended = terminal && !writing;
  const now = useNow(!ended);
  const phase = usePhase(ended);
  const entering = useEntrance(!terminal && acceptedRecently(run));
  const text = message?.text ?? "";
  const harnessName = harnesses.find(row => row.id === run?.selection.harnessId)?.name ?? run?.selection.harnessId ?? "Harness";
  const detail = run ? describe(run) : "";
  const write = async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setCopy("copied");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopy("idle"), 1800);
    } catch { if (mounted.current) setCopy("failed"); }
  };
  const error = status === "failed" || status === "unknown";
  const usage = run && terminal && run.usage ? usageParts(run.usage).join(" · ") : "", first = run && terminal ? firstOutputText(run) : null;
  const retry = run && onRetry && (status === "failed" || status === "cancelled");
  // A finished reply keeps its actions and usage out of the way until pointed at; a way forward stays in sight.
  const quiet = !(copy !== "idle" || detailsOpen || retry);
  return <article className={cn("message assistant-message group flex min-w-0 flex-col gap-2.5", !terminal && "is-active")} data-run-status={status} aria-busy={!terminal} aria-label={harnessName + " 的回复" + (terminal ? "" : "（进行中）")}>
    <div className="flex min-w-0 items-center gap-[9px]">
      <BrandIcon brand={run?.selection.harnessId ?? ""} name={harnessName} size={24}/>
      <span className="flex-none text-ui-sm font-semibold text-fg">{harnessName}</span>
      {detail ? <span className="min-w-0 trunc text-caption text-fg-3">{detail}</span> : null}
    </div>
    <TurnProcess run={run} status={status} text={text} phase={phase} detailed={detailed} now={now} harness={harnessName} startupHint={startupHint} queue={queue} waiting={waiting} loadDetail={loadToolDetail} entering={entering} docked={Children.toArray(children).length === 0} ended={ended}/>
    {queue !== undefined && status === "queued" && !run?.cancelRequested ? <QueuedTurn queue={queue} now={now}/> : null}
    {run?.notices?.length ? <NoticeList notices={run.notices}/> : null}
    {text ? <StreamingMarkdown text={text} isStreaming={!terminal && !run?.cancelRequested} caret className="text-reading" onWriting={setWriting}/> : null}
    {run?.error && error ? <div className={cn("run-error flex items-start gap-2.5 rounded-block px-3 py-2.5 text-ui-sm text-fg", status === "failed" ? "bg-red-soft" : "bg-surface shadow-hairline")} role="status">
      {status === "failed" ? <CircleAlert size={16} className="mt-0.5 flex-none text-red" aria-hidden="true"/> : <CircleHelp size={16} className="mt-0.5 flex-none text-fg-2" aria-hidden="true"/>}
      <span className="min-w-0 break-words">{failureMessage(run.error)}{busyHolder && run.error.code === "WORKSPACE_BUSY" ? <>占用它的是对话「{busyHolder.title}」。<button type="button" className="link-btn" onClick={busyHolder.onOpen}>打开那个对话</button></> : null}</span>
    </div> : null}
    {run?.outputs?.length ? <OutputList outputs={run.outputs}/> : null}
    {children}
    <div className={cn("turn-meta -mt-1 -ml-1.5 flex min-h-7 flex-wrap items-center gap-x-0.5 gap-y-1 text-caption text-fg-3 transition-opacity duration-150", quiet && "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100")}>
      <div className="message-actions flex items-center gap-0.5">
        {text ? <ActionButton label={copy === "copied" ? "已复制回复" : "复制回复"} onClick={() => void write()}>{copy === "copied" ? <Check size={14}/> : <Copy size={14}/>}</ActionButton> : null}
        {run && onBranch && (status === "completed" || status === "failed" || status === "cancelled") ? <ActionButton label="从这里分支" onClick={() => onBranch(run.id)}><GitBranch size={14}/></ActionButton> : null}
        {run && onDetails ? <ActionButton label="执行详情" pressed={detailsOpen ?? false} onClick={() => onDetails(run.id)}><Info size={14}/></ActionButton> : null}
        {retry ? <button type="button" className="btn btn-ghost btn-sm retry-response ml-1 min-w-24" onClick={() => onRetry(run.input, run.attachments)}><RotateCcw size={13}/>重试回复</button> : null}
      </div>
      {usage || first ? <span className="run-meta ml-1.5 flex min-w-0 flex-wrap items-center gap-x-1">{usage ? <span className="native-usage">{usage}</span> : null}{usage && first ? <span aria-hidden="true">·</span> : null}{first ? <span className="run-timing">{first}</span> : null}</span> : null}
      {copy === "failed" ? <span className="ml-1.5 text-red" role="status">无法使用剪贴板，可选中文本后复制。</span> : copy === "copied" ? <span className="ml-1.5" role="status">已复制</span> : null}
    </div>
  </article>;
});

/**
 * Where another Harness took over the conversation (ADR-054 §5, Conversation board): a hairline with a pill in its middle,
 * "从这里起由 X 接手 · 模型 · 思考". `from` names the Harness before the change, drawn with an arrow to the new one; when it
 * is the same Harness, the pill says "从这里起改用 模型" instead. `detail` is the target's model and thinking level in the
 * caller's words (without it, the model's id). A hand-over made while the conversation is open comes in: the pill rises,
 * the arrow draws, the new mark pops and the lines grow (#19, ~500 ms).
 */
export function SwitchDivider({ change, harnesses, onRevert, revertDisabled, from, detail }: { readonly change: PublicSwitch; readonly harnesses: readonly HarnessView[]; readonly onRevert?: (() => void) | undefined; readonly revertDisabled?: boolean; readonly from?: Pick<HarnessSelection, "harnessId"> | undefined; readonly detail?: string | undefined }) {
  const entering = useEntrance(true);
  const target = change.target ?? null, name = (id: string) => harnesses.find(row => row.id === id)?.name ?? id;
  if (target === null) return null;
  const model = detail || target.provider?.model || target.nativeModel || "", same = from !== undefined && from.harnessId === target.harnessId && model !== "";
  const label = same ? "从这里起改用 " + model : "从这里起由 " + name(target.harnessId) + " 接手" + (model ? " · " + model : "");
  const line = (side: "left" | "right") => <span className={cn("h-[.5px] min-w-3 flex-1 bg-line-strong", side === "left" ? "origin-right" : "origin-left", entering && "motion-line-grow")} style={entering ? motionStyle({ delay: 120 }) : undefined}/>;
  return <div className="switch-divider flex min-w-0 items-center gap-2">
    <div role="separator" aria-label={label} className="flex min-w-0 flex-1 items-center gap-3 text-caption text-fg-3">
      {line("left")}
      <span className={cn("flex h-[30px] min-w-0 items-center gap-[7px] rounded-full bg-surface pr-3 pl-[7px] whitespace-nowrap shadow-hairline", entering && "motion-fade-in")}>
        {from && from.harnessId !== target.harnessId ? <>
          <BrandIcon brand={from.harnessId} name={name(from.harnessId)} size={18}/>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
            <path pathLength={1} className={entering ? "motion-draw" : undefined} style={entering ? motionStyle({ duration: 160, delay: 100 }) : undefined} d="M5 12h14M12 5l7 7-7 7"/></svg>
        </> : null}
        <span className={cn("flex flex-none", entering && "motion-pop-in")} style={entering ? motionStyle({ delay: 220, scaleFrom: .6 }) : undefined}><BrandIcon brand={target.harnessId} name={name(target.harnessId)} size={18}/></span>
        <span className={cn("min-w-0 trunc", entering && "motion-fade-in")} style={entering ? motionStyle({ delay: 300 }) : undefined}>{same ? <>从这里起改用 <strong className="font-semibold text-fg">{model}</strong></>
          : <>从这里起由 <strong className="font-semibold text-fg">{name(target.harnessId)}</strong> 接手{model ? " · " + model : ""}</>}</span>
      </span>
      {line("right")}
    </div>
    {onRevert ? <button type="button" className="link-btn flex-none text-caption" disabled={revertDisabled} onClick={onRevert}>改回</button> : null}
  </div>;
}
