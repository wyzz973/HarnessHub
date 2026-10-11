import { Check, Copy, GitBranch, Info, PencilLine, RotateCcw } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { ProviderView } from "../../../src/contracts/provider.js";
import type { PublicMessage, PublicRun, RunStatus } from "../../../src/contracts/session.js";
import type { HarnessView } from "../../../src/contracts/web.js";
import { failureMessage, runStatusLabel } from "../api.js";
import { BrandIcon } from "./BrandIcon.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { ActivityList, NoticeList, OutputList, PlanView, ToolList, UsageDetails, UsageLine, type ToolDetailLoader } from "./NativeActivity.js";
import { MessageAttachments } from "./Attachments.js";

interface MessageProps {
  message: PublicMessage | undefined;
  run: PublicRun | undefined;
  harnesses: readonly HarnessView[];
  providers: readonly ProviderView[];
  onEdit: (text: string) => void;
  onRetry: ((text: string, attachments: PublicRun["attachments"]) => void) | undefined;
  loadToolDetail?: ToolDetailLoader;
  onBranch?: (runId: string) => void;
  /** Seconds the same Harness took to start in this conversation's previous Run, shown while this one starts. */
  /** Seconds the same Harness took to start: last time in this conversation, or usually when this conversation has no earlier Run of it. */
  startupHint?: { readonly seconds: number; readonly usual: boolean } | undefined;
}
function finished(status: RunStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "unknown";
}
/** Whole seconds under a minute, then minutes and seconds; one decimal below ten seconds. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return seconds.toFixed(1) + " 秒";
  if (seconds < 60) return Math.round(seconds) + " 秒";
  return Math.floor(seconds / 60) + " 分 " + Math.round(seconds % 60) + " 秒";
}
/** What the Run is doing now, from the phases the Runtime recorded; elapsed time is shown once it is noticeable. */
function activityLabel(run: PublicRun | undefined, status: RunStatus, harness: string, now: number, startupHint: MessageProps["startupHint"]): string {
  if (run?.cancelRequested && !finished(status)) return "正在停止并清理资源";
  if (run?.awaitingSwitchId && status === "queued") return "等待选择切换生效";
  const timing = run?.timing, since = (from: number | undefined) => from !== undefined && now - from >= 2000 ? " · " + duration(now - from) : "";
  switch (status) {
    case "queued": return "等待开始";
    case "preparing": return "正在启动 " + harness + since(timing?.preparingAt) + (startupHint !== undefined && startupHint.seconds >= 2 ? (startupHint.usual ? "（通常约 " : "（上次约 ") + Math.round(startupHint.seconds) + " 秒）" : "");
    case "running":
      if (timing === undefined || timing.firstOutputAt !== undefined) return "正在回复";
      return timing.dispatchedAt === undefined ? "已连接 " + harness + "，正在发送" : "等待 " + harness + " 回复" + since(timing.dispatchedAt);
    case "settling": return "正在结束执行";
    case "completed": return "本次调用没有文本输出。";
    case "cancelled": return "已停止";
    case "failed": return "回复未能完成";
    case "unknown": return "执行结果尚未核实";
  }
}

/** Re-renders every second while `active`, so elapsed times stay current; the clock stops with the Run. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
/** First-output and total time of a finished Run, measured from when its input was accepted. */
function RunTiming({ run }: { run: PublicRun }) {
  const timing = run.timing; if (!timing || timing.endedAt === undefined) return null;
  const parts = [...(timing.firstOutputAt === undefined ? [] : ["首字 " + duration(timing.firstOutputAt - timing.acceptedAt)]), "用时 " + duration(timing.endedAt - timing.acceptedAt)];
  return <p className="run-timing" title="从发送到首个可见输出、到回合结束的时间">{parts.join(" · ")}</p>;
}
export const ChatMessage = memo(function ChatMessage({ message, run, harnesses, providers, onEdit, onRetry, loadToolDetail, onBranch, startupHint }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [details, setDetails] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  const status = run?.status ?? message?.status ?? "unknown";
  const terminal = finished(status);
  const now = useNow(!terminal);
  const text = message?.text ?? "";
  const harness = harnesses.find(row => row.id === run?.selection.harnessId)?.name ?? run?.selection.harnessId ?? "Harness";
  const provider = providers.find(row => row.id === run?.selection.provider?.providerId);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setCopied(true);
      setCopyFailed(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      if (mounted.current) { setCopied(false); setCopyFailed(true); }
    }
  };
  if (message?.role === "user") return <article className="message user-message">
    {run?.attachments?.length ? <MessageAttachments attachments={run.attachments}/> : null}
    <div className="user-bubble"><span className="sr-only">你：</span>{text}</div>
    <div className="message-actions user-actions"><button type="button" className="message-action" aria-label="放回输入框" title="放回输入框" onClick={() => onEdit(text)}><PencilLine size={14}/><span className="sr-only">放回输入框</span></button></div>
  </article>;
  const detailsId = `execution-${message?.id ?? run?.id ?? "unavailable"}`;
  return <article className={`message assistant-message ${!terminal ? "is-active" : ""}`} data-run-status={status}>
    <div className="assistant-label"><BrandIcon brand={run?.selection.harnessId ?? ""} name={harness} size={22}/><strong>{harness}</strong></div>
    {run?.notices?.length ? <NoticeList notices={run.notices}/> : null}
    {run?.thinking ? <details className="native-thinking"><summary>思考过程</summary><StreamingMarkdown text={run.thinking} isStreaming={!terminal}/></details> : null}
    {run?.plan?.entries.length ? <PlanView plan={run.plan}/> : null}
    {run?.activities?.length ? <ActivityList activities={run.activities}/> : null}
    {run?.tools?.length ? <ToolList tools={run.tools} active={!terminal} loadDetail={loadToolDetail}/> : null}
    {text ? <StreamingMarkdown text={text} isStreaming={!terminal && !run?.cancelRequested}/>
      : <div className={`response-status ${terminal ? "is-terminal" : ""} ${status === "failed" || status === "unknown" ? "is-error" : ""}`} role="status">{!terminal ? <span className="activity-dot" aria-hidden="true"/> : null}<span>{activityLabel(run, status, harness, now, startupHint)}</span></div>}
    {text && !terminal ? <div className="response-activity" role="status"><span className="activity-dot" aria-hidden="true"/><span>{activityLabel(run, status, harness, now, startupHint)}</span></div> : null}
    {text && status === "cancelled" ? <p className="response-ended" role="status">已停止</p> : null}
    {status === "unknown" && text ? <p className="response-ended is-error" role="status">执行结果尚未核实</p> : null}
    {status === "failed" && text ? <p className="response-ended is-error" role="status">回复未能完成</p> : null}
    {run?.outputs?.length ? <OutputList outputs={run.outputs}/> : null}
    {run?.error && (status === "failed" || status === "unknown") ? <div className="run-error" role="status">{failureMessage(run.error)}</div> : null}
    {terminal && run && (run.usage || run.timing?.endedAt !== undefined) ? <div className="run-meta">{run.usage ? <UsageLine usage={run.usage}/> : null}<RunTiming run={run}/></div> : null}
    <div className={`message-actions ${details || copied || copyFailed ? "is-revealed" : ""}`}>
      {text ? <button type="button" className="message-action" onClick={() => void copy()} aria-label={copied ? "已复制回复" : "复制回复"} title={copied ? "已复制" : "复制回复"}>{copied ? <Check size={14}/> : <Copy size={14}/>}<span className="sr-only">{copied ? "已复制" : "复制回复"}</span></button> : null}
      {run ? <button type="button" className="message-action" aria-label="执行详情" title="执行详情" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(value => !value)}><Info size={14}/><span className="sr-only">执行详情</span></button> : null}
      {run && onRetry && (status === "failed" || status === "cancelled") ? <button type="button" className="message-action retry-response" onClick={() => onRetry(run.input, run.attachments)}><RotateCcw size={14}/><span>重试回复</span></button> : null}
      {run && onBranch && (status === "completed" || status === "failed" || status === "cancelled") ? <button type="button" className="message-action" aria-label="从这里分支" title="从这里分支：新对话带上到此为止的历史" onClick={() => onBranch(run.id)}><GitBranch size={14}/><span className="sr-only">从这里分支</span></button> : null}
      {copyFailed ? <span className="copy-error" role="status">无法使用剪贴板，可选中文本后复制。</span> : copied ? <span className="copy-feedback" role="status">已复制</span> : null}
    </div>
    {details && run ? <div className="execution-details" id={detailsId}>
      <dl><div><dt>执行者</dt><dd>{harness}</dd></div><div><dt>模型连接</dt><dd>{provider?.name ?? (run.selection.provider ? "Provider" : "Harness 原生连接")}</dd></div>{run.selection.provider ? <><div><dt>模型</dt><dd>{run.selection.provider.model}</dd></div><div><dt>配置版本</dt><dd>v{run.selection.provider.revision}</dd></div></> : null}<div><dt>控制入口</dt><dd><code>{run.selection.controlId}</code></dd></div><div><dt>执行状态</dt><dd>{runStatusLabel(status)}</dd></div><div><dt>执行标识</dt><dd><code>{run.id}</code></dd></div>{run.timing?.readyAt !== undefined && run.timing.preparingAt !== undefined ? <div><dt>启动原程序</dt><dd>{duration(run.timing.readyAt - run.timing.preparingAt)}</dd></div> : null}{run.timing?.firstOutputAt !== undefined && run.timing.dispatchedAt !== undefined ? <div><dt>发送后首个输出</dt><dd>{duration(run.timing.firstOutputAt - run.timing.dispatchedAt)}</dd></div> : null}{run.usage ? <UsageDetails usage={run.usage}/> : null}</dl>
      {run.error ? <p>错误代码：<code>{run.error.code}</code></p> : null}
      {!run.selection.provider && run.selection.nativeModel ? <p>本机模型：<code>{run.selection.nativeModel}</code></p> : null}
      {status === "unknown" ? <p>请先核实执行结果。这个请求不会自动重新执行。</p> : status === "completed" ? <p>本轮执行已结束，结果仍需由你确认。</p> : null}
    </div> : null}
  </article>;
});
