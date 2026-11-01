import { Brain, Check, ChevronRight, CircleAlert, CircleDashed, CircleHelp, CircleStop, Copy, GitBranch, Info, PencilLine, RotateCcw } from "lucide-react";
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunStatus } from "../../../src/contracts/session.js";
import type { HarnessView } from "../../../src/contracts/web.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { failureMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { duration, elapsed } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { cancelledWords, finished, liveStatus, noteMount, rememberShown, runDuration, shownSteps, spentText, toolSummary, type LiveStatus, type QueueNotice } from "../lib/turn.js";
import { Collapsible, DrawnCheck, motionStyle, SwapText } from "../ui/motion.js";
import { Spinner, StatusDot, Tip } from "../ui/primitives.js";
import { ActivityList, NoticeList, OutputList, ToolList, usageParts, type SeenSteps, type ToolDetailLoader } from "./Activity.js";
import { MessageAttachments } from "./Attachments.js";
import { BrandIcon } from "./BrandIcon.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** First-output and total time of a finished Run, measured from when its input was accepted. */
export function timingText(run: PublicRun): string | null {
  const timing = run.timing; if (!timing || timing.endedAt === undefined) return null;
  return [...(timing.firstOutputAt === undefined ? [] : ["首字 " + duration(timing.firstOutputAt - timing.acceptedAt)]), "用时 " + spentText(timing.endedAt - timing.acceptedAt)].join(" · ");
}
/** How soon the first output came; the total time is part of the process line above the reply. */
function firstOutputText(run: PublicRun): string | null {
  const timing = run.timing;
  return timing?.endedAt === undefined || timing.firstOutputAt === undefined ? null : "首字 " + duration(timing.firstOutputAt - timing.acceptedAt);
}

/**
 * Whether this element is news (ADR-054 §3: motion only says what happened). Decided once, before the first paint: things
 * drawn with the rest of a page stay still; a Turn just started and a hand-over just made come in. (A message of yours
 * rises by the conversation's own rule, ChatPage's, which knows what arrived after it opened.)
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
/**
 * The symbol of a state (Icons board), 15 px: the arc while working, dashed before it starts, and a still grey dot while
 * the Turn waits for you with no step in progress; the amber of waiting belongs to the Turn's one marker line (decision F).
 */
function LiveIcon({ tone, className }: { readonly tone: LiveStatus["tone"]; readonly className?: string | undefined }) {
  return <span className={cn("flex size-[15px] flex-none items-center justify-center", className)}>
    {tone === "run" ? <Spinner size={15} tone="run" label=""/> : tone === "wait" ? <StatusDot tone="idle"/> : <CircleDashed size={15} className="text-fg-3" aria-hidden="true"/>}
  </span>;
}
interface Outcome { readonly icon: ReactNode; readonly arriving: string; readonly settled: string; readonly tone: "done" | "fail" | "quiet" }
/** How a finished Turn reads: the drawn check, then its tools, failures and unfinished steps, and how long it took. */
function outcome(run: PublicRun | undefined, status: RunStatus, text: string, drawing: boolean): Outcome {
  const tools = run?.tools ?? [], summary = tools.length ? toolSummary(tools, false).text : "", total = run ? runDuration(run) : null, time = total === null ? "" : spentText(total);
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  switch (status) {
    case "failed": { const words = join("回复未能完成", summary, time); return { icon: <CircleAlert size={15} strokeWidth={1.9} className="text-red" aria-hidden="true"/>, arriving: words, settled: words, tone: "fail" }; }
    case "cancelled": { const words = join(run ? cancelledWords(run) : "已取消", summary, time); return { icon: <CircleStop size={15} strokeWidth={1.9} className="text-fg-3" aria-hidden="true"/>, arriving: words, settled: words, tone: "quiet" }; }
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
  /** The Turn ended and its reply is fully shown: the line hands over only then, after the text it ends. */
  readonly ended: boolean;
  /** Committed reply text is still waiting to be shown at the display pace. */
  readonly behind: boolean;
}
/**
 * The process of a Turn in three layers (ADR-054 §5): one line that says what is happening or, once it ended, what was done;
 * the steps beneath it (open while the Turn runs, and always in the detailed density); and each step's raw input and
 * output. Failures and unfinished steps are always counted in the line, so folding never hides them.
 */
function TurnProcess({ run, status, text, phase, detailed, now, harness, startupHint, queue, waiting, loadDetail, entering, ended, behind }: ProcessProps) {
  const terminal = finished(status), steps = useId();
  const tools = run?.tools ?? [], activities = run?.activities ?? [], thinking = run?.thinking ?? "";
  const expandable = tools.length > 0 || activities.length > 0 || thinking.length > 0;
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = expandable && (choice ?? (detailed || phase !== "settled"));
  const [thoughts, setThoughts] = useState<boolean | null>(null);
  // The record of the steps the reader saw, kept for this Run on the page: steps found here are history, the first step of
  // a Turn seen running comes in, and a Turn drawn again (its conversation opened again) shows nothing twice (Motion board #05).
  const [seen] = useState<SeenSteps>(() => (run ? shownSteps(run.id) : undefined) ?? new Set(tools.map(tool => tool.id)));
  const runId = run?.id;
  useLayoutEffect(() => { if (runId !== undefined) rememberShown(runId, seen); }, [runId, seen]);
  // The words and symbol the status had last, kept for the 200 ms in which they leave (#12), and while the Run has ended but
  // its last words are still on their way (words of work in progress only; anything else gives way to "正在回复"). While
  // it settles with words on their way, the reply is what the line names: it goes on from "正在回复" to "已完成" without
  // passing through "正在结束执行" and back.
  const last = useRef<LiveStatus | null>(null);
  const replying: LiveStatus = { text: "正在回复", tone: "run", timer: true, wrap: false, thinking: false };
  const live = ended ? null : terminal ? last.current?.tone === "run" ? last.current : replying : status === "settling" && behind && !run?.cancelRequested ? replying
    : liveStatus(run, status, harness, now, startupHint, queue, waiting, text);
  if (live) last.current = live;
  const end = ended ? outcome(run, status, text, phase === "handoff" || phase === "done") : null;
  // The timer stops when the Run ends, also while its last words are still being shown, so it never passes the total.
  const since = run?.timing ? elapsed((terminal ? run.timing.endedAt ?? now : now) - run.timing.acceptedAt) : null;
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
  // What a finished Turn did wraps instead: its failures and unfinished steps must stay readable at any width (C04). The
  // words keep their own width (at most the room left), never the measured one of the sliding box: that is rounded to
  // whole pixels and still holds the previous words' width, and wrapping to it would break a line that fits.
  const wrap = "max-w-full min-w-0 overflow-hidden whitespace-normal [&>.swap-text-layer]:w-max [&>.swap-text-layer]:max-w-(--label-max) [&>.swap-text-layer]:whitespace-normal [&>.swap-text-layer]:align-top";
  const liveLayer = (state: LiveStatus, leaving: boolean) => {
    const timer = state.timer && since !== null ? "· 已用 " + since : null;
    // A queue explanation is never cut short: at a narrow width its words wrap.
    const wraps = state.wrap;
    return <span key="live" className={cn("flex min-w-0 gap-[7px]", wraps ? "items-start" : "items-center", leaving && "motion-depart")} aria-hidden={leaving || undefined}>
      <LiveIcon tone={state.tone} className={wraps ? "mt-[2.5px]" : undefined}/>
      {state.wrap ? <span className={cn("min-w-0 whitespace-normal", !leaving && "response-status")} role={leaving ? undefined : "status"}>{state.text}</span>
        : <span className={cn("flex min-w-0", !leaving && "response-status", state.thinking && "motion-breathe")} role={leaving ? undefined : "status"} style={budget(timer)}>
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
  // The line is one element for the whole Turn, a button for its steps once there are any: when the first step arrives the
  // words change in place (#07) and the arc keeps turning, instead of the line being drawn anew.
  const toggle = () => setChoice(!open);
  const control: HTMLAttributes<HTMLDivElement> = expandable ? { role: "button", tabIndex: 0, "aria-expanded": open, "aria-controls": steps, onClick: toggle,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); if (!event.repeat) toggle(); } } } : {};
  // A Turn just started shows its status 0.25 s after the message (Motion board #01).
  return <div ref={box} className={cn("turn-process flex min-w-0 flex-col", entering && "motion-fade-in")} style={entering ? motionStyle({ delay: 250 }) : undefined}>
    <div className={cn("process-summary -ml-2 flex min-h-7 max-w-full min-w-0 items-start gap-[7px] self-start rounded-row px-2 py-1 text-ui-sm text-fg-3", expandable && "row cursor-pointer select-none")} {...control}>{layers}{chevron}</div>
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
        {tools.length ? <ToolList tools={tools} active={!terminal} loadDetail={loadDetail} seen={seen}/> : null}
      </div>
    </Collapsible> : null}
  </div>;
}

function ActionButton({ label, onClick, children, pressed }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode; readonly pressed?: boolean }) {
  return <Tip label={label} side="bottom"><button type="button" className="icon-btn message-action size-7 text-fg-3" aria-label={label} {...(pressed === undefined ? {} : { "aria-pressed": pressed })} onClick={onClick}>{children}</button></Tip>;
}

/** Your message: a light grey bubble on the right of the reading column (Conversation board), with the way to edit it again. */
export const UserMessage = memo(function UserMessage({ message, run, onEdit }: { readonly message: PublicMessage; readonly run: PublicRun | undefined; readonly onEdit: (text: string) => void }) {
  // Whether it rises into place (Motion board #15) is the conversation's call: ChatPage wraps a message that arrived after
  // the conversation opened, so a message never rises twice and history never moves.
  return <article className="message user-message group flex flex-col items-end gap-1.5">
    {run?.attachments?.length ? <MessageAttachments attachments={run.attachments}/> : null}
    <div className="flex w-full min-w-0 items-end justify-end gap-1">
      <div className="flex h-7 flex-none items-center transition-opacity duration-150 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <ActionButton label="放回输入框" onClick={() => onEdit(message.text)}><PencilLine size={14}/></ActionButton>
      </div>
      <div className="max-w-[82%] min-w-0 rounded-[18px] bg-subtle px-[15px] py-2.5 text-reading leading-6 whitespace-pre-wrap break-words text-fg"><span className="sr-only">你：</span>{message.text}</div>
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
  const text = message?.text ?? "";
  // How much of the reply was shown in full when last told (its last words come in at the display pace, ADR-054 §3):
  // committed text beyond it is still on its way, and the Turn has ended for the reader only once all of it is shown.
  // Known in the same render as each commit, so a Run ending with new words never hands over before showing them.
  const [shownLength, setShownLength] = useState(text.length);
  const behind = text.length > shownLength;
  const ended = terminal && !behind;
  const now = useNow(!ended);
  const phase = usePhase(ended);
  // Only a Turn's first showing on the page can be news: one drawn again, when its conversation is opened again, is not.
  const [firstShowing] = useState(() => run === undefined || shownSteps(run.id) === undefined);
  const entering = useEntrance(firstShowing && !terminal && acceptedRecently(run));
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
    <TurnProcess run={run} status={status} text={text} phase={phase} detailed={detailed} now={now} harness={harnessName} startupHint={startupHint} queue={queue} waiting={waiting} loadDetail={loadToolDetail} entering={entering} ended={ended} behind={behind}/>
    {queue !== undefined && status === "queued" && !run?.cancelRequested ? <QueuedTurn queue={queue} now={now}/> : null}
    {run?.notices?.length ? <NoticeList notices={run.notices}/> : null}
    {text ? <StreamingMarkdown text={text} isStreaming={!terminal && !run?.cancelRequested} caret className="text-reading" onShown={setShownLength}/> : null}
    {/* Interaction board: the reason sits on a quiet card; only the failure's own symbol is red. */}
    {run?.error && error ? <div className="run-error flex items-start gap-2 rounded-block bg-surface px-3 py-2.5 text-ui-sm text-fg shadow-hairline" role="status">
      {status === "failed" ? <CircleAlert size={17} strokeWidth={1.9} className="mt-px flex-none text-red" aria-hidden="true"/> : <CircleHelp size={17} strokeWidth={1.9} className="mt-px flex-none text-fg-3" aria-hidden="true"/>}
      <span className="min-w-0 break-words">{failureMessage(run.error)}{busyHolder && run.error.code === "WORKSPACE_BUSY" ? <>占用它的是对话「{busyHolder.title}」。<button type="button" className="link-btn" onClick={busyHolder.onOpen}>打开那个对话</button></> : null}</span>
    </div> : null}
    {run?.outputs?.length ? <OutputList outputs={run.outputs}/> : null}
    {children}
    {/* Out of the way until pointed at, where there is a pointer to point with; on touch screens it stays in sight. */}
    <div className={cn("turn-meta -mt-1 -ml-1.5 flex min-h-7 flex-wrap items-center gap-x-0.5 gap-y-1 text-caption text-fg-3 transition-opacity duration-150", quiet && "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
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
 * is the same Harness, the pill says "从这里起改用 模型" instead (the program's default model when the new choice names
 * none). `detail` is the target's model and thinking level in the words of a Turn's identity line (without it, the model's
 * id). A hand-over made while the conversation is open comes in: the pill fades in, the arrow draws in 160 ms, the new mark
 * pops from .6 and the lines grow (#19, ~500 ms); one drawn with the page's history stays still.
 */
export function SwitchDivider({ change, harnesses, onRevert, revertDisabled, from, detail }: { readonly change: PublicSwitch; readonly harnesses: readonly HarnessView[]; readonly onRevert?: (() => void) | undefined; readonly revertDisabled?: boolean; readonly from?: Pick<HarnessSelection, "harnessId"> | undefined; readonly detail?: string | undefined }) {
  const entering = useEntrance(true);
  const target = change.target ?? null, name = (id: string) => harnesses.find(row => row.id === id)?.name ?? id;
  if (target === null) return null;
  const model = detail || target.provider?.model || target.nativeModel || "", same = from !== undefined && from.harnessId === target.harnessId;
  const changed = target.provider?.model || target.nativeModel ? model : ["本机默认模型", model].filter(Boolean).join(" · ");
  const label = same ? "从这里起改用 " + changed : "从这里起由 " + name(target.harnessId) + " 接手" + (model ? " · " + model : "");
  const line = (side: "left" | "right") => <span className={cn("h-[.5px] min-w-3 flex-1 bg-line-strong", side === "left" ? "origin-right" : "origin-left", entering && "motion-line-grow")} style={entering ? motionStyle({ delay: 120 }) : undefined}/>;
  return <div className="switch-divider flex min-w-0 items-center gap-2">
    {/* "改回" on the right is matched on the left, so the pill stays in the middle of the column where there is room */}
    {onRevert ? <span aria-hidden="true" className="invisible flex-none text-caption font-medium max-sm:hidden">改回</span> : null}
    <div role="separator" aria-label={label} className="flex min-w-0 flex-1 items-center gap-3 text-caption text-fg-3">
      {line("left")}
      <span className={cn("flex h-[30px] min-w-0 items-center gap-[7px] rounded-full bg-surface pr-3 pl-[7px] whitespace-nowrap shadow-hairline", entering && "motion-fade-in")}>
        {from && from.harnessId !== target.harnessId ? <>
          <BrandIcon brand={from.harnessId} name={name(from.harnessId)} size={18}/>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
            <path pathLength={1} className={entering ? "motion-draw" : undefined} style={entering ? motionStyle({ duration: 160, delay: 100 }) : undefined} d="M5 12h14M12 5l7 7-7 7"/></svg>
        </> : null}
        <span className={cn("flex flex-none", entering && "motion-pop-in")} style={entering ? motionStyle({ delay: 220, scaleFrom: .6 }) : undefined}><BrandIcon brand={target.harnessId} name={name(target.harnessId)} size={18}/></span>
        <span className={cn("min-w-0 trunc", entering && "motion-fade-in")} style={entering ? motionStyle({ delay: 300 }) : undefined}>{same ? <>从这里起改用 <strong className="font-semibold text-fg">{changed}</strong></>
          : <>从这里起由 <strong className="font-semibold text-fg">{name(target.harnessId)}</strong> 接手{model ? " · " + model : ""}</>}</span>
      </span>
      {line("right")}
    </div>
    {onRevert ? <button type="button" className="link-btn flex-none text-caption" disabled={revertDisabled} onClick={onRevert}>改回</button> : null}
  </div>;
}
