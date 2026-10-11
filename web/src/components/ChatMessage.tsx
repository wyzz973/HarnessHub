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
}
function finished(status: RunStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "unknown";
}
function activityLabel(run: PublicRun | undefined, status: RunStatus): string {
  if (run?.cancelRequested && !finished(status)) return "正在停止并清理资源";
  if (run?.awaitingSwitchId && status === "queued") return "等待选择切换生效";
  switch (status) {
    case "queued": return "等待开始";
    case "preparing": return "正在准备回复";
    case "running": return "正在回复";
    case "settling": return "正在结束执行";
    case "completed": return "本次调用没有文本输出。";
    case "cancelled": return "已停止";
    case "failed": return "回复未能完成";
    case "unknown": return "执行结果尚未核实";
  }
}

export const ChatMessage = memo(function ChatMessage({ message, run, harnesses, providers, onEdit, onRetry, loadToolDetail, onBranch }: MessageProps) {
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
      : <div className={`response-status ${terminal ? "is-terminal" : ""} ${status === "failed" || status === "unknown" ? "is-error" : ""}`} role="status">{!terminal ? <span className="activity-dot" aria-hidden="true"/> : null}<span>{activityLabel(run, status)}</span></div>}
    {text && !terminal ? <div className="response-activity" role="status"><span className="activity-dot" aria-hidden="true"/><span>{activityLabel(run, status)}</span></div> : null}
    {text && status === "cancelled" ? <p className="response-ended" role="status">已停止</p> : null}
    {status === "unknown" && text ? <p className="response-ended is-error" role="status">执行结果尚未核实</p> : null}
    {status === "failed" && text ? <p className="response-ended is-error" role="status">回复未能完成</p> : null}
    {run?.outputs?.length ? <OutputList outputs={run.outputs}/> : null}
    {run?.error && (status === "failed" || status === "unknown") ? <div className="run-error" role="status">{failureMessage(run.error)}</div> : null}
    {terminal && run?.usage ? <UsageLine usage={run.usage}/> : null}
    <div className={`message-actions ${details || copied || copyFailed ? "is-revealed" : ""}`}>
      {text ? <button type="button" className="message-action" onClick={() => void copy()} aria-label={copied ? "已复制回复" : "复制回复"} title={copied ? "已复制" : "复制回复"}>{copied ? <Check size={14}/> : <Copy size={14}/>}<span className="sr-only">{copied ? "已复制" : "复制回复"}</span></button> : null}
      {run ? <button type="button" className="message-action" aria-label="执行详情" title="执行详情" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(value => !value)}><Info size={14}/><span className="sr-only">执行详情</span></button> : null}
      {run && onRetry && (status === "failed" || status === "cancelled") ? <button type="button" className="message-action retry-response" onClick={() => onRetry(run.input, run.attachments)}><RotateCcw size={14}/><span>重试回复</span></button> : null}
      {run && onBranch && (status === "completed" || status === "failed" || status === "cancelled") ? <button type="button" className="message-action" aria-label="从这里分支" title="从这里分支：新对话带上到此为止的历史" onClick={() => onBranch(run.id)}><GitBranch size={14}/><span className="sr-only">从这里分支</span></button> : null}
      {copyFailed ? <span className="copy-error" role="status">无法使用剪贴板，可选中文本后复制。</span> : copied ? <span className="copy-feedback" role="status">已复制</span> : null}
    </div>
    {details && run ? <div className="execution-details" id={detailsId}>
      <dl><div><dt>执行者</dt><dd>{harness}</dd></div><div><dt>模型连接</dt><dd>{provider?.name ?? (run.selection.provider ? "Provider" : "Harness 原生连接")}</dd></div>{run.selection.provider ? <><div><dt>模型</dt><dd>{run.selection.provider.model}</dd></div><div><dt>配置版本</dt><dd>v{run.selection.provider.revision}</dd></div></> : null}<div><dt>控制入口</dt><dd><code>{run.selection.controlId}</code></dd></div><div><dt>执行状态</dt><dd>{runStatusLabel(status)}</dd></div><div><dt>执行标识</dt><dd><code>{run.id}</code></dd></div>{run.usage ? <UsageDetails usage={run.usage}/> : null}</dl>
      {run.error ? <p>错误代码：<code>{run.error.code}</code></p> : null}
      {!run.selection.provider && run.selection.nativeModel ? <p>本机模型：<code>{run.selection.nativeModel}</code></p> : null}
      {status === "unknown" ? <p>请先核实执行结果。这个请求不会自动重新执行。</p> : status === "completed" ? <p>本轮执行已结束，结果仍需由你确认。</p> : null}
    </div> : null}
  </article>;
});
