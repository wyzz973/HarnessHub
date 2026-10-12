import { ArrowRightLeft, Check, ChevronRight, Copy, GitBranch, Info, PencilLine, RotateCcw } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PublicMessage, PublicRun, PublicSwitch, RunStatus } from "../../../src/contracts/session.js";
import { cancelledLabel } from "../../../src/contracts/session.js";
import type { HarnessView } from "../../../src/contracts/web.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { failureMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { duration } from "../lib/format.js";
import { useNow } from "../lib/prefs.js";
import { finished } from "../lib/turn.js";
import { Tip } from "../ui/primitives.js";
import { ActivityList, NoticeList, OutputList, PlanView, ProcessGroup, UsageLine, type ToolDetailLoader } from "./Activity.js";
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

/** What the Run is doing now, from the phases the Runtime recorded; elapsed time is shown once it is noticeable. */
export function activityLabel(run: PublicRun | undefined, status: RunStatus, harness: string, now: number, startupHint?: { readonly seconds: number; readonly usual: boolean }, queue?: QueueNotice, waiting?: "approval" | "question"): string {
  if (run?.cancelRequested && !finished(status)) return "正在停止并清理资源";
  if (waiting && !finished(status)) return waiting === "question" ? "等待你回答" : "等待你审批";
  if (run?.awaitingSwitchId && status === "queued") return "等待选择切换生效";
  if (queue?.kind === "workspace" && status === "queued") return `排队中：等待对话「${queue.holderTitle}」释放工作区（${queue.holderWaits === "approval" ? "它正在等待你的审批" : queue.holderWaits === "question" ? "它正在等待你的回答" : "它正在运行"}）`;
  if (queue?.kind === "slot" && status === "queued") return `等待开始：${queue.running} 个对话正在执行，其中一个结束后自动开始`;
  const timing = run?.timing, since = (from: number | undefined) => from !== undefined && now - from >= 2000 ? " · " + duration(now - from) : "";
  switch (status) {
    case "queued": return "等待开始";
    case "preparing": return "正在启动 " + harness + since(timing?.preparingAt) + (startupHint !== undefined && startupHint.seconds >= 2 ? (startupHint.usual ? "（通常约 " : "（上次约 ") + Math.round(startupHint.seconds) + " 秒）" : "");
    case "running":
      if (timing === undefined || timing.firstOutputAt !== undefined) return "正在回复" + since(timing?.acceptedAt);
      return timing.dispatchedAt === undefined ? "已连接 " + harness + "，正在发送" : "等待 " + harness + " 回复" + since(timing.dispatchedAt);
    case "settling": return "正在结束执行";
    case "completed": return "本次调用没有文本输出。";
    case "cancelled": return run ? cancelledLabel(run) : "已取消";
    case "failed": return "回复未能完成";
    case "unknown": return "执行结果尚未核实";
  }
}
/** First-output and total time of a finished Run, measured from when its input was accepted. */
export function timingText(run: PublicRun): string | null {
  const timing = run.timing; if (!timing || timing.endedAt === undefined) return null;
  return [...(timing.firstOutputAt === undefined ? [] : ["首字 " + duration(timing.firstOutputAt - timing.acceptedAt)]), "用时 " + duration(timing.endedAt - timing.acceptedAt)].join(" · ");
}

function ActionButton({ label, onClick, children, pressed }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode; readonly pressed?: boolean }) {
  return <Tip label={label} side="bottom"><button type="button" className="icon-btn icon-btn-sm message-action" aria-label={label} {...(pressed === undefined ? {} : { "aria-pressed": pressed })} onClick={onClick}>{children}</button></Tip>;
}

export const UserMessage = memo(function UserMessage({ message, run, onEdit }: { readonly message: PublicMessage; readonly run: PublicRun | undefined; readonly onEdit: (text: string) => void }) {
  return <article className="message user-message group flex flex-col items-end gap-1.5">
    {run?.attachments?.length ? <MessageAttachments attachments={run.attachments}/> : null}
    <div className="max-w-[85%] rounded-[14px] bg-subtle px-3.5 py-2.5 whitespace-pre-wrap break-words sm:max-w-[78%]"><span className="sr-only">你：</span>{message.text}</div>
    <div className="flex h-7 items-center opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
      <ActionButton label="放回输入框" onClick={() => onEdit(message.text)}><PencilLine size={14}/></ActionButton>
    </div>
  </article>;
});

/**
 * The actions of a queued Turn. One waiting for its workspace says how long it may still wait (it is never sent after
 * that); one waiting for a slot has no deadline of its own, since every running Turn is bounded by its budgets.
 */
function QueuedTurn({ queue, now }: { readonly queue: QueueNotice; readonly now: number }) {
  return <div className="queued-turn flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
    {queue.kind === "workspace"
      ? <small className="text-fg-2" title="HarnessHub 为外部等待设的期限；到期后这条消息不会发出，也不会自动重试。">最多再等 {Math.max(1, Math.ceil((queue.endsAt - now) / 60000))} 分钟，到时这条消息不会发出。</small>
      : <small className="text-fg-2" title="同时执行的对话有上限；每个正在执行的回合都受自己的期限约束，所以位置总会空出。">没有单独的等待期限，按发送先后轮到。</small>}
    {queue.kind === "workspace" && queue.onOpen ? <button type="button" className="link-btn" onClick={queue.onOpen}>打开那个对话</button> : null}
    {queue.onCancel ? <button type="button" className="link-btn" disabled={queue.cancelling} onClick={queue.onCancel}>{queue.cancelling ? "正在取消…" : "取消排队"}</button> : null}
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
/** One assistant Turn: who answered, the process behind one line, the reply, and what it produced. */
export const AssistantTurn = memo(function AssistantTurn({ message, run, harnesses, describe, detailed, onRetry, loadToolDetail, onBranch, onDetails, detailsOpen, startupHint, queue, busyHolder, waiting, children }: TurnProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [thinking, setThinking] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); }; }, []);
  const status = run?.status ?? message?.status ?? "unknown";
  const terminal = finished(status);
  const now = useNow(!terminal);
  const text = message?.text ?? "";
  const harnessName = harnesses.find(row => row.id === run?.selection.harnessId)?.name ?? run?.selection.harnessId ?? "Harness";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setCopied(true); setCopyFailed(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { if (mounted.current) { setCopied(false); setCopyFailed(true); } }
  };
  const thinkingOpen = thinking ?? detailed;
  const error = status === "failed" || status === "unknown";
  const meta = run && terminal ? [run.usage ? <UsageLine key="usage" usage={run.usage}/> : null, timingText(run) ? <span key="timing" className="run-timing">{timingText(run)}</span> : null].filter(Boolean) : [];
  return <article className={cn("message assistant-message group flex flex-col gap-2.5", !terminal && "is-active")} data-run-status={status} aria-busy={!terminal}>
    <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
      <BrandIcon brand={run?.selection.harnessId ?? ""} name={harnessName} size={20}/>
      <strong className="font-semibold text-fg">{harnessName}</strong>{run ? <span className="min-w-0 truncate">{describe(run)}</span> : null}
    </div>
    {run?.notices?.length ? <NoticeList notices={run.notices}/> : null}
    {run?.thinking ? <div className="flex flex-col">
      <button type="button" aria-expanded={thinkingOpen} onClick={() => setThinking(!thinkingOpen)} className="flex items-center gap-1.5 self-start rounded-md border-none bg-transparent py-0.5 pr-1.5 pl-1 text-[12.5px] text-fg-2 hover:bg-hover">
        <ChevronRight size={12} className={cn("transition-transform duration-150", thinkingOpen && "rotate-90")} aria-hidden="true"/>{terminal || text ? "思考过程" : <span className="shimmer">正在思考</span>}</button>
      {thinkingOpen ? <div className="native-thinking enter mt-1 ml-2.5 border-l-2 border-line pl-3 text-[13px] text-fg-2"><StreamingMarkdown text={run.thinking} isStreaming={!terminal}/></div> : null}
    </div> : null}
    {run?.plan?.entries.length ? <PlanView plan={run.plan} compact/> : null}
    {run?.activities?.length ? <ActivityList activities={run.activities}/> : null}
    {run?.tools?.length ? <ProcessGroup tools={run.tools} active={!terminal} loadDetail={loadToolDetail} defaultOpen={detailed}/> : null}
    {text ? <StreamingMarkdown text={text} isStreaming={!terminal && !run?.cancelRequested} className={cn(!terminal && !run?.cancelRequested && "caret-host")}/>
      : <div className={cn("response-status flex items-center gap-2 text-[13px]", terminal ? "text-fg-2" : "", error && "is-error text-red")} role="status">
        {!terminal ? <span className="pulse h-2 w-2 flex-none rounded-full bg-accent" aria-hidden="true"/> : null}
        <span className={cn(!terminal && !waiting && "shimmer font-medium", waiting && !terminal && "font-medium text-amber")}>{activityLabel(run, status, harnessName, now, startupHint, queue, waiting)}</span></div>}
    {queue !== undefined && status === "queued" && !run?.cancelRequested ? <QueuedTurn queue={queue} now={now}/> : null}
    {text && !terminal ? <div className="response-activity flex items-center gap-2.5 text-[12.5px]" role="status"><span className={waiting ? "font-medium text-amber" : "shimmer font-medium"}>{activityLabel(run, status, harnessName, now, startupHint, undefined, waiting)}</span>{waiting ? null : <span className="text-fg-3">Esc 停止</span>}</div> : null}
    {text && status === "cancelled" ? <p className="response-ended m-0 text-[12.5px] text-fg-2" role="status">{run ? cancelledLabel(run) : "已取消"}</p> : null}
    {status === "unknown" && text ? <p className="response-ended is-error m-0 text-[12.5px] text-red" role="status">执行结果尚未核实</p> : null}
    {status === "failed" && text ? <p className="response-ended is-error m-0 text-[12.5px] text-red" role="status">回复未能完成</p> : null}
    {run?.outputs?.length ? <OutputList outputs={run.outputs}/> : null}
    {run?.error && error ? <div className="run-error rounded-lg border border-red-line bg-red-soft px-3 py-2 text-[13px]" role="status">{failureMessage(run.error)}{busyHolder && run.error.code === "WORKSPACE_BUSY"
      ? <>占用它的是对话「{busyHolder.title}」。<button type="button" className="link-btn" onClick={busyHolder.onOpen}>打开那个对话</button></> : null}</div> : null}
    {children}
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
      {meta.length ? <div className="run-meta flex flex-wrap items-center gap-x-3.5 text-[12px] text-fg-3">{meta}</div> : null}
      <div className={cn("message-actions -ml-1 flex items-center gap-0.5 transition-opacity duration-150", !(copied || copyFailed || detailsOpen) && terminal && "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100")}>
        {text ? <ActionButton label={copied ? "已复制回复" : "复制回复"} onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>}</ActionButton> : null}
        {run && onDetails ? <ActionButton label="执行详情" pressed={detailsOpen ?? false} onClick={() => onDetails(run.id)}><Info size={14}/></ActionButton> : null}
        {run && onBranch && (status === "completed" || status === "failed" || status === "cancelled") ? <ActionButton label="从这里分支" onClick={() => onBranch(run.id)}><GitBranch size={14}/></ActionButton> : null}
        {run && onRetry && (status === "failed" || status === "cancelled") ? <button type="button" className="btn btn-ghost btn-sm retry-response min-w-24" onClick={() => onRetry(run.input, run.attachments)}><RotateCcw size={13}/>重试回复</button> : null}
        {copyFailed ? <span className="text-[12px] text-red" role="status">无法使用剪贴板，可选中文本后复制。</span> : copied ? <span className="text-[12px] text-fg-3" role="status">已复制</span> : null}
      </div>
    </div>
  </article>;
});

/** Where another Harness took over the conversation (ADR-042), with the way back for the latest change. */
export function SwitchDivider({ change, harnesses, onRevert, revertDisabled }: { readonly change: PublicSwitch; readonly harnesses: readonly HarnessView[]; readonly onRevert?: (() => void) | undefined; readonly revertDisabled?: boolean }) {
  const target = change.target ?? null, name = (id: string) => harnesses.find(row => row.id === id)?.name ?? id;
  if (target === null) return null;
  return <div className="switch-divider flex items-center gap-3 text-[12px] text-fg-3" role="note">
    <span className="h-px flex-1 bg-line"/>
    <span className="flex items-center gap-1.5"><ArrowRightLeft size={12} aria-hidden="true"/>从这里起由 <BrandIcon brand={target.harnessId} name={name(target.harnessId)} size={14}/><strong className="font-medium text-fg-2">{name(target.harnessId)}</strong> 接手{target.nativeModel ? <span className="mono">· {target.nativeModel}</span> : target.provider ? <span className="mono">· {target.provider.model}</span> : null}</span>
    {onRevert ? <button type="button" className="link-btn text-[12px]" disabled={revertDisabled} onClick={onRevert}>改回</button> : null}
    <span className="h-px flex-1 bg-line"/>
  </div>;
}
