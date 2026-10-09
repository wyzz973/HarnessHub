import { AlertCircle, ArrowUp, Check, ChevronDown, Copy, FolderOpen, RefreshCw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import type { ProviderView } from "../../../src/contracts/provider.js";
import type { HarnessSelection, PublicMessage, PublicRun, SelectionRequest } from "../../../src/contracts/session.js";
import type { HarnessView, SessionView } from "../../../src/contracts/web.js";
import { protocolLabel, runStatusLabel } from "../api.js";
import { BrandMark, EmptyState, ErrorNotice, Spinner, StatusBadge } from "./common.js";
import { MobileMenu } from "./Sidebar.js";

export interface SelectionDraft { harnessId: string; controlId: string; providerId: string; providerRevision: number | null; model: string }
export const EMPTY_SELECTION: SelectionDraft = { harnessId: "", controlId: "", providerId: "", providerRevision: null, model: "" };
export function selectionDraft(selection: HarnessSelection): SelectionDraft {
  return { harnessId: selection.harnessId, controlId: selection.controlId, providerId: selection.provider?.providerId ?? "", providerRevision: selection.provider?.revision ?? null, model: selection.provider?.model ?? "" };
}
export function selectionRequest(draft: SelectionDraft): SelectionRequest {
  return { harnessId: draft.harnessId, controlId: draft.controlId, provider: draft.providerId && draft.providerRevision !== null
    ? { providerId: draft.providerId, revision: draft.providerRevision, model: draft.model } : null };
}
export function selectionProblem(draft: SelectionDraft, harnesses: readonly HarnessView[], providers: readonly ProviderView[]): string | null {
  const harness = harnesses.find(row => row.id === draft.harnessId);
  if (!harness) return "先选择一个 Harness，开始协作。";
  if (!harness.controls.some(row => row.id === draft.controlId && row.available)) return "这个控制入口目前不可用，请在 Harnesses 中检查。";
  if (!draft.providerId) return null;
  const provider = providers.find(row => row.id === draft.providerId);
  if (!provider || !provider.enabled) return "这个 Provider 已停用或不可用，请重新选择。";
  if (!harness.providerProtocols.includes(provider.protocol)) return "这个 Harness 暂不支持所选 Provider 的协议。请选择兼容的 Provider。";
  if (provider.protocol === "gemini" && !provider.hasCredential && draft.providerRevision === provider.revision) return "Gemini 连接需要 API Key，请先在 Providers 中补充密钥。";
  if (!draft.model || draft.providerRevision === null) return "请选择要使用的模型。";
  if (draft.providerRevision === provider.revision && !provider.models.includes(draft.model)) return "所选模型不在当前 Provider 的配置中。";
  return null;
}
export function effectiveProviderProblem(selection: HarnessSelection, providers: readonly ProviderView[]): string | null {
  if (!selection.provider) return null;
  const provider = providers.find(row => row.id === selection.provider?.providerId);
  if (!provider) return "当前 Provider 已不可用，请应用另一个选择后继续。";
  return provider.enabled ? null : "当前 Provider 已停用。请启用它，或切换到另一个 Provider 后继续。";
}
function draftMatches(draft: SelectionDraft, selection: HarnessSelection): boolean {
  return JSON.stringify(draft) === JSON.stringify(selectionDraft(selection));
}
interface ChatProps {
  session: SessionView | null; sessionRequested: boolean; sessionError: string | null; loading: boolean; draft: SelectionDraft; providers: readonly ProviderView[]; harnesses: readonly HarnessView[];
  workspace: string; mutation: string | null; error: string | null; connectionError: string | null;
  messageDraft: string; onMessageDraft: Dispatch<SetStateAction<string>>;
  onDraft: (draft: SelectionDraft) => void; onWorkspace: (workspace: string) => void; onSend: (text: string) => Promise<void>;
  onApply: () => void; onCancel: () => void; onClose: () => void; onDismissError: () => void; onProviders: () => void; onNew: () => void; onMenu: () => void;
}
export function ChatPage(props: ChatProps) {
  const { session, draft, harnesses, providers, mutation, error } = props;
  const input = props.messageDraft;
  const setInput = props.onMessageDraft;
  const [followBottom, setFollowBottom] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bytes = new TextEncoder().encode(input).byteLength;
  const active = session?.runs.find(run => run.id === session.activeRunId) ?? null;
  const dirty = session !== null && !draftMatches(draft, session.selection);
  const problem = session !== null && !dirty ? effectiveProviderProblem(session.selection, providers) : selectionProblem(draft, harnesses, providers);
  const pending = session?.pendingSwitchId !== null && session?.pendingSwitchId !== undefined;
  const busy = active !== null || mutation === "sending";
  const blocked = session !== null && session.status !== "open";
  const disableSend = blocked || busy || pending || dirty || props.loading || Boolean(props.sessionError) || Boolean(problem) || bytes > 64 * 1024 || !input.trim() || mutation !== null;
  const title = session?.messages.find(message => message.role === "user")?.text ?? (props.sessionRequested || props.sessionError ? "打开对话" : "新对话");
  useEffect(() => { setFollowBottom(true); }, [session?.id]);
  useEffect(() => {
    if (scroll.current && followBottom) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: "instant" });
  }, [session?.version, followBottom]);
  useEffect(() => {
    const element = textarea.current; if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [input]);
  const send = async () => {
    if (disableSend) return;
    const message = input;
    try { await props.onSend(message); setInput(value => value === message ? "" : value); setFollowBottom(true); }
    catch { /* Parent presents the retained request error; the unsent draft stays editable. */ }
  };
  const composer = <div className="composer-wrap">
    <form className={`composer ${blocked ? "unavailable" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor="message-input">发送消息</label>
      <textarea id="message-input" ref={textarea} placeholder={blocked ? "这个对话暂时无法继续发送消息" : "说说你想完成的事…"} value={input} rows={3} disabled={blocked}
        onChange={event => setInput(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }}/>
      <div className="composer-bottom"><div className="composer-context"><BrandMark small/><span>{active ? runStatusLabel(active.status) : "持续对话，同一份上下文"}</span></div>
        {active ? <button type="button" className="send-button stop-button" aria-label="停止当前回复" title="停止当前回复" disabled={active.cancelRequested || mutation !== null} onClick={props.onCancel}>{mutation === "cancelling" || active.cancelRequested ? <Spinner label="正在停止"/> : <Square size={14} fill="currentColor"/>}</button>
          : <button type="submit" className="send-button" aria-label="发送消息" title="发送消息" disabled={disableSend}>{mutation === "sending" ? <Spinner/> : <ArrowUp size={21}/>}</button>}
      </div>
    </form>
    <div className={`composer-note ${bytes > 64 * 1024 ? "error-text" : ""}`}>
      {bytes > 64 * 1024 ? "单条消息不能超过 64 KiB，请缩短内容。" : active?.cancelRequested ? "停止已受理，正在等待执行结束和资源清理。" : pending ? "选择切换等待生效，暂时停止发送。" : dirty ? "先应用新的选择，再发送消息。" : problem ?? "Enter 发送 · Shift + Enter 换行"}
    </div>
  </div>;
  return <section className="chat-page" aria-labelledby="chat-title">
    <header className="workspace-header"><MobileMenu onClick={props.onMenu}/><div className="chat-heading"><h1 id="chat-title" title={title}>{title}</h1>{session ? <span className="session-caption">{session.status === "closed" ? "已关闭" : session.status === "blocked" ? "需要核实" : "公共会话"}</span> : null}</div>
      {session?.status === "open" ? <button className="icon-button close-chat" aria-label="关闭这个对话" title="关闭对话后保留历史，不再接收消息" disabled={mutation !== null} onClick={props.onClose}><X size={18}/></button> : null}
    </header>
    <SelectionBar {...props} dirty={dirty} pending={pending} problem={problem}/>
    {error ? <div className="chat-error"><ErrorNotice message={error} onDismiss={props.onDismissError}/></div> : null}
    {props.connectionError ? <div className="connection-notice" role="status">{props.connectionError} · 正在重新连接，历史和草稿会保留。</div> : null}
    {session?.status === "blocked" ? <div className="blocked-notice" role="status">上一次执行的结果或资源状态尚未核实。你可以查看历史，这个会话暂时不能继续执行。</div> : null}
    <div className={`chat-scroll ${session === null ? "welcome-scroll" : ""}`} ref={scroll} onScroll={() => { const element = scroll.current; if (element) setFollowBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 100); }}>
      {props.sessionError ? <EmptyState icon={<AlertCircle size={28}/>} title="无法打开这个对话" action={<button className="button secondary" onClick={props.onNew}>新建对话</button>}>{props.sessionError}</EmptyState> : props.loading ? <div className="chat-loading"><Spinner/><span>正在读取对话</span></div> : session === null ? <div className="welcome"><BrandMark/><p className="welcome-eyebrow">一个入口 · 持续协作</p><h2>今天，想完成什么？</h2><p className="welcome-description">选择你的 Harness 和模型，让工作从这里开始。</p>{composer}
        <div className="prompt-suggestions">{["理解一个项目", "帮我完成实现", "排查一个问题"].map(value => <button key={value} onClick={() => { setInput(value); textarea.current?.focus(); }}>{value}</button>)}</div>
        <label className="workspace-field"><FolderOpen size={15} aria-hidden="true"/><span>工作目录</span><input aria-label="新对话工作目录" value={props.workspace} onChange={event => props.onWorkspace(event.target.value)} placeholder="绝对路径"/></label>
        {providers.length === 0 ? <button className="welcome-config-link" onClick={props.onProviders}>添加你的第一个 Provider <span aria-hidden="true">↗</span></button> : null}
      </div> : <div className="transcript" role="log" aria-label="对话历史" aria-live="off">
        {session.messages.length === 0 ? <div className="conversation-empty"><BrandMark/><h2>对话准备好了</h2><p>发出第一条消息，开始这次协作。</p></div> : session.messages.map(message => <Message key={message.id} message={message} run={session.runs.find(run => run.id === message.runId)} hasAssistant={session.messages.some(other => other.runId === message.runId && other.role === "assistant")} harnesses={harnesses} providers={providers}/>)}
        {session.switches.length > 0 ? <details className="selection-history"><summary>选择记录 <span>{session.switches.length}</span></summary>{session.switches.map(item => <div className={`switch-record ${item.status}`} key={item.id}><span>{harnesses.find(h => h.id === item.requested.harnessId)?.name ?? item.requested.harnessId}</span><StatusBadge tone={item.status === "failed" ? "danger" : item.status === "effective" ? "success" : "warning"}>{item.status === "effective" ? "已生效" : item.status === "failed" ? "切换失败" : "等待生效"}</StatusBadge>{item.requested.provider ? <small>{providers.find(p => p.id === item.requested.provider?.providerId)?.name ?? "Provider"} · {item.requested.provider.model}</small> : null}{item.error ? <small className="error-text">{item.error.message}</small> : null}</div>)}</details> : null}
      </div>}
    </div>
    {session !== null && !props.loading ? <footer className="chat-composer-footer">{!followBottom && active ? <button className="follow-stream" onClick={() => setFollowBottom(true)}>回到最新回复 <ChevronDown size={14}/></button> : null}{composer}</footer> : null}
    <div className="sr-only" role="status" aria-live="polite">{active ? active.cancelRequested ? "正在停止回复" : runStatusLabel(active.status) : pending ? "等待选择切换生效" : "可以继续对话"}</div>
  </section>;
}
function SelectionBar(props: ChatProps & { dirty: boolean; pending: boolean; problem: string | null }) {
  const { draft, providers, harnesses, session, dirty, pending } = props;
  const harness = harnesses.find(row => row.id === draft.harnessId);
  const provider = providers.find(row => row.id === draft.providerId);
  const disabled = props.mutation !== null || props.loading || props.sessionError !== null || pending || (session !== null && session.status !== "open");
  const controls = harness?.controls.filter(control => control.available) ?? [];
  return <div className="selection-bar"><div className="selection-pickers">
    <label className="picker-field"><span>Harness</span><div className="select-shell"><select aria-label="选择 Harness" value={draft.harnessId} disabled={disabled} onChange={event => { const next = harnesses.find(row => row.id === event.target.value); props.onDraft({ ...draft, harnessId: event.target.value, controlId: next?.controls.find(row => row.available)?.id ?? "" }); }}><option value="">选择 Harness</option>{harnesses.map(row => <option value={row.id} key={row.id} disabled={!row.controls.some(control => control.available)}>{row.name}{row.controls.some(control => control.available) ? "" : row.installed ? " · 入口待准备" : " · 未发现"}</option>)}</select><ChevronDown size={13} aria-hidden="true"/></div></label>
    <span className="picker-divider" aria-hidden="true"/>
    <label className="picker-field provider-picker"><span>Provider</span><div className="select-shell"><select aria-label="选择 Provider" value={draft.providerId} disabled={disabled} onChange={event => { const next = providers.find(row => row.id === event.target.value); props.onDraft({ ...draft, providerId: next?.id ?? "", providerRevision: next?.revision ?? null, model: next?.defaultModel ?? "" }); }}><option value="">Harness 当前配置</option>{providers.map(row => { const supported = !harness || harness.providerProtocols.includes(row.protocol); const missingKey = row.protocol === "gemini" && !row.hasCredential; return <option key={row.id} value={row.id} disabled={!row.enabled || !supported || missingKey}>{row.name}{!row.enabled ? " · 已停用" : !supported ? " · 协议不兼容" : missingKey ? " · 缺少 API Key" : ""}</option>; })}</select><ChevronDown size={13} aria-hidden="true"/></div></label>
    <label className="picker-field model-picker"><span>Model</span><div className="select-shell"><select aria-label="选择模型" value={draft.model} disabled={disabled || !provider} onChange={event => props.onDraft({ ...draft, model: event.target.value })}><option value="">{provider ? "选择模型" : "跟随 Harness 配置"}</option>{draft.model && provider && !provider.models.includes(draft.model) ? <option value={draft.model}>{draft.model} · 固定版本</option> : null}{provider?.models.map(model => <option key={model} value={model}>{model}</option>)}</select><ChevronDown size={13} aria-hidden="true"/></div></label>
  </div>
    {controls.length > 1 ? <label className="control-picker"><span>控制入口</span><select aria-label="选择控制入口" value={draft.controlId} disabled={disabled} onChange={event => props.onDraft({ ...draft, controlId: event.target.value })}>{controls.map(control => <option key={control.id} value={control.id}>{protocolLabel(control.protocol)} · {control.id}</option>)}</select></label> : null}
    <div className="selection-actions">{pending ? <span className="pending-selection"><Spinner/>下一轮生效</span> : dirty ? <button className="apply-selection" onClick={props.onApply} disabled={disabled || props.problem !== null}>{props.mutation === "switching" ? <Spinner/> : <RefreshCw size={13}/>}应用选择</button> : session ? <span className="effective-selection"><Check size={12} aria-hidden="true"/>已生效</span> : null}
      {provider && draft.providerRevision !== null && provider.revision !== draft.providerRevision ? <button className="revision-update" disabled={disabled} onClick={() => props.onDraft({ ...draft, providerRevision: provider.revision, model: provider.models.includes(draft.model) ? draft.model : provider.defaultModel })}>配置 v{draft.providerRevision} · 使用最新 v{provider.revision}</button> : null}
    </div>
  </div>;
}
function Message({ message, run, hasAssistant, harnesses, providers }: { message: PublicMessage; run: PublicRun | undefined; hasAssistant: boolean; harnesses: readonly HarnessView[]; providers: readonly ProviderView[] }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(message.text); setCopied(true); setCopyFailed(false); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); setCopyFailed(true); }
  };
  const harness = harnesses.find(row => row.id === run?.selection.harnessId)?.name ?? run?.selection.harnessId ?? "Harness";
  const provider = providers.find(row => row.id === run?.selection.provider?.providerId);
  const terminal = ["completed", "cancelled", "failed", "unknown"].includes(message.status);
  if (message.role === "user") return <><article className="message user-message"><span className="sr-only">你：</span><div>{message.text}</div></article>{!hasAssistant && run ? <article className="message assistant-message"><div className="assistant-label"><BrandMark small/><strong>{harness}</strong></div><div className={terminal ? "empty-response" : "thinking-indicator"} role="status">{!terminal ? <Spinner/> : null}<span>{run.cancelRequested && !terminal ? "停止已受理，等待执行结束和资源清理" : run.awaitingSwitchId && run.status === "queued" ? "等待选择切换生效" : runStatusLabel(run.status)}</span></div>{run.error && (run.status === "failed" || run.status === "unknown") ? <div className="run-error">{run.error.message}</div> : null}</article> : null}</>;
  return <article className="message assistant-message"><div className="assistant-label"><BrandMark small/><strong>{harness}</strong>{run?.selection.provider ? <span>{provider?.name ?? "Provider"} · {run.selection.provider.model} <small>v{run.selection.provider.revision}</small></span> : <span>Harness 配置</span>}</div>
    {message.text ? <div className="markdown"><ReactMarkdown skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.text}</ReactMarkdown></div> : terminal ? <p className="empty-response">{message.status === "cancelled" ? "本次回复已停止。" : message.status === "failed" ? "这次调用没有返回可显示的回复。" : message.status === "unknown" ? "这次执行的结果还不能确定。" : "本次调用没有文本输出。"}</p> : <div className="thinking-indicator"><Spinner/><span>{runStatusLabel(message.status)}<span className="thinking-dots" aria-hidden="true">…</span></span></div>}
    {run?.error && (run.status === "failed" || run.status === "unknown") ? <div className="run-error" role="status">{run.error.message}</div> : null}
    <div className="message-meta">{terminal ? <><span className={message.status === "failed" || message.status === "unknown" ? "error-text" : ""}>{runStatusLabel(message.status)}</span>{message.text ? <button className="icon-button" onClick={() => void copy()} aria-label={copied ? "已复制回复" : "复制回复"}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button> : null}{copyFailed ? <span className="error-text" role="status">无法使用剪贴板，可选中文本后复制。</span> : null}</> : run?.cancelRequested ? <span>正在停止并清理资源</span> : null}</div>
  </article>;
}
