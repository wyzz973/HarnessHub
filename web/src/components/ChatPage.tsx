import { AlertCircle, ArrowRight, ArrowUp, Bug, Check, ChevronDown, Copy, FolderOpen, FolderSearch, RefreshCw, Square, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ProviderView } from "../../../src/contracts/provider.js";
import type { HarnessSelection, PublicMessage, PublicRun, SelectionRequest } from "../../../src/contracts/session.js";
import type { HarnessView, SessionView } from "../../../src/contracts/web.js";
import { protocolLabel, runStatusLabel } from "../api.js";
import { BrandMark, EmptyState, ErrorNotice, Spinner, StatusBadge } from "./common.js";
import { MobileMenu } from "./Sidebar.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import { SearchPicker } from "./SearchPicker.js";
import type { PickerOption } from "./SearchPicker.js";

const MarkdownContent = lazy(async () => {
  const { default: ReactMarkdown } = await import("react-markdown");
  return { default: ({ text }: { text: string }) => <ReactMarkdown skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown> };
});

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
  const following = useRef(true);
  const viewport = useRef({ width: 0, height: 0 });
  const previousScrollTop = useRef(0);
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
  useEffect(() => { following.current = true; setFollowBottom(true); }, [session?.id]);
  useEffect(() => {
    if (scroll.current && following.current) { scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: "instant" }); previousScrollTop.current = scroll.current.scrollTop; }
  }, [session?.version, followBottom]);
  useEffect(() => {
    const element = scroll.current; if (!element || session === null) return;
    const observer = new ResizeObserver(() => {
      if (viewport.current.width === element.clientWidth && viewport.current.height === element.clientHeight) return;
      viewport.current = { width: element.clientWidth, height: element.clientHeight };
      if (following.current) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      previousScrollTop.current = element.scrollTop;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [session !== null]);
  useEffect(() => {
    const element = textarea.current; if (!element) return;
    const resize = () => { element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 220)}px`; };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [input, session !== null]);
  const send = async () => {
    if (disableSend) return;
    const message = input;
    try { await props.onSend(message); setInput(value => value === message ? "" : value); following.current = true; setFollowBottom(true); }
    catch { /* Parent presents the retained request error; the unsent draft stays editable. */ }
  };
  const composer = <div className="composer-wrap">
    <form className={`composer ${blocked ? "unavailable" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor="message-input">发送消息</label>
      <textarea id="message-input" ref={textarea} placeholder={blocked ? "这个对话暂时无法继续发送消息" : "说说你想完成的事…"} value={input} rows={session ? 1 : 3} disabled={blocked}
        onChange={event => setInput(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }}/>
      <SelectionBar {...props} dirty={dirty} pending={pending} problem={problem}/>
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
    <header className="workspace-header"><MobileMenu onClick={props.onMenu}/><div className="chat-heading"><h1 id="chat-title" title={title}>{title}</h1>{session ? <span className="session-caption">{session.status === "closed" ? "已关闭" : session.status === "blocked" ? "需要核实" : "持续会话"}</span> : null}</div>
      <label className="header-workspace"><FolderOpen size={14} aria-hidden="true"/>{session ? <span title={session.workspace}>{session.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? session.workspace}</span> : <input aria-label="新对话工作目录" value={props.workspace} onChange={event => props.onWorkspace(event.target.value)} placeholder="工作目录的绝对路径" title={props.workspace}/>}</label>
      {session?.status === "open" ? <button className="icon-button close-chat" aria-label="关闭这个对话" title="关闭对话后保留历史，不再接收消息" disabled={mutation !== null} onClick={props.onClose}><X size={18}/></button> : null}
    </header>
    {error ? <div className="chat-error"><ErrorNotice message={error} onDismiss={props.onDismissError}/></div> : null}
    {props.connectionError ? <div className="connection-notice" role="status">{props.connectionError} · 正在重新连接，历史和草稿会保留。</div> : null}
    {session?.status === "blocked" ? <div className="blocked-notice" role="status">上一次执行的结果或资源状态尚未核实。你可以查看历史，这个会话暂时不能继续执行。</div> : null}
    <div className={`chat-scroll ${session === null ? "welcome-scroll" : ""}`} ref={scroll} onScroll={() => {
      const element = scroll.current; if (!element) return;
      if (viewport.current.width !== element.clientWidth || viewport.current.height !== element.clientHeight) return;
      const upward = element.scrollTop < previousScrollTop.current - 1;
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      if (upward || nearBottom) { following.current = !upward && nearBottom; setFollowBottom(following.current); }
      previousScrollTop.current = element.scrollTop;
    }}>
      {props.sessionError ? <EmptyState icon={<AlertCircle size={28}/>} title="无法打开这个对话" action={<button className="button secondary" onClick={props.onNew}>新建对话</button>}>{props.sessionError}</EmptyState> : props.loading ? <div className="chat-loading"><Spinner/><span>正在读取对话</span></div> : session === null ? <div className="welcome"><div className="welcome-identity"><BrandMark/><span>你的 Agent 工作空间</span></div><h2>从一个想法，开始协作。</h2><p className="welcome-description">同一份上下文，不同的 Harness 与模型。</p>{composer}
        <div className="prompt-suggestions">{[{ text: "理解一个项目", icon: FolderSearch }, { text: "帮我完成实现", icon: SquareTerminal }, { text: "排查一个问题", icon: Bug }].map(({ text, icon: Icon }) => <button key={text} onClick={() => { setInput(text); textarea.current?.focus(); }}><Icon size={16} aria-hidden="true"/><span>{text}</span><ArrowRight size={13} aria-hidden="true"/></button>)}</div>
        <div className="welcome-harness-strip"><span>本机发现</span>{harnesses.filter(h => h.controls.some(c => c.available)).slice(0, 7).map(h => <button type="button" key={h.id} aria-label={`选择 ${h.name}`} title={h.name} onClick={() => props.onDraft({ ...draft, harnessId: h.id, controlId: h.controls.find(c => c.id === h.defaultControlId && c.available)?.id ?? h.controls.find(c => c.available)?.id ?? "" })}><BrandIcon brand={h.id} name={h.name} size={23}/></button>)}<span>{harnesses.filter(h => h.controls.some(c => c.available)).length} 个 Harness 有入口</span></div>
        {providers.length === 0 ? <button className="welcome-config-link" onClick={props.onProviders}>配置模型连接 <ArrowRight size={14} aria-hidden="true"/></button> : null}
      </div> : <div className="transcript" role="log" aria-label="对话历史" aria-live="off">
        {session.messages.length === 0 ? <div className="conversation-empty"><BrandMark/><h2>对话准备好了</h2><p>发出第一条消息，开始这次协作。</p></div> : session.messages.map(message => <Message key={message.id} message={message} run={session.runs.find(run => run.id === message.runId)} hasAssistant={session.messages.some(other => other.runId === message.runId && other.role === "assistant")} harnesses={harnesses} providers={providers}/>)}
        {session.switches.length > 0 ? <details className="selection-history"><summary>选择记录 <span>{session.switches.length}</span></summary>{session.switches.map(item => <div className={`switch-record ${item.status}`} key={item.id}><span>{harnesses.find(h => h.id === item.requested.harnessId)?.name ?? item.requested.harnessId}</span><StatusBadge tone={item.status === "failed" ? "danger" : item.status === "effective" ? "success" : "warning"}>{item.status === "effective" ? "已生效" : item.status === "failed" ? "切换失败" : "等待生效"}</StatusBadge>{item.requested.provider ? <small>{providers.find(p => p.id === item.requested.provider?.providerId)?.name ?? "Provider"} · {item.requested.provider.model}</small> : null}{item.error ? <small className="error-text">{item.error.message}</small> : null}</div>)}</details> : null}
      </div>}
    </div>
    {session !== null && !props.loading ? <footer className="chat-composer-footer">{!followBottom && active ? <button className="follow-stream" onClick={() => { following.current = true; setFollowBottom(true); }}>回到最新回复 <ChevronDown size={14}/></button> : null}{composer}</footer> : null}
    <div className="sr-only" role="status" aria-live="polite">{active ? active.cancelRequested ? "正在停止回复" : runStatusLabel(active.status) : pending ? "等待选择切换生效" : "可以继续对话"}</div>
  </section>;
}
function SelectionBar(props: ChatProps & { dirty: boolean; pending: boolean; problem: string | null }) {
  const { draft, providers, harnesses, session, dirty, pending } = props;
  const harness = harnesses.find(row => row.id === draft.harnessId);
  const provider = providers.find(row => row.id === draft.providerId);
  const disabled = props.mutation !== null || props.loading || props.sessionError !== null || pending || (session !== null && session.status !== "open");
  const controls = harness?.controls.filter(control => control.available) ?? [];
  const harnessOptions: PickerOption[] = harnesses.map(row => {
    const available = row.controls.some(control => control.available);
    return { value: row.id, label: row.name, icon: <BrandIcon brand={row.id} name={row.name}/>, group: available ? "已发现控制入口" : "更多 Harness",
      description: row.management.installedVersion ? `v${row.management.installedVersion}` : row.controls.filter(control => control.available).map(control => protocolLabel(control.protocol)).join(" / "),
      disabled: !available, reason: row.installed ? "已发现程序，控制入口尚未就绪" : "尚未安装，请在 Harnesses 中管理" };
  }).sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)));
  const providerOptions: PickerOption[] = [{ value: "", label: "Harness 当前配置", description: "沿用执行者自己的模型设置", icon: <BrandMark small/> }, ...providers.map(row => {
    const supported = !harness || harness.providerProtocols.includes(row.protocol), missingKey = row.protocol === "gemini" && !row.hasCredential;
    return { value: row.id, label: row.name, icon: <BrandIcon brand={providerBrand(row.baseUrl)} name={row.name}/>, description: protocolLabel(row.protocol),
      disabled: !row.enabled || !supported || missingKey, reason: !row.enabled ? "已停用" : !supported ? "当前 Harness 暂不支持这个协议" : missingKey ? "缺少 Gemini API Key" : "" };
  })];
  const modelOptions: PickerOption[] = provider ? provider.models.map(model => ({ value: model, label: model, icon: <BrandIcon brand={providerBrand(provider.baseUrl)} name={provider.name}/>, group: provider.name })) : [{ value: "", label: "跟随 Harness 配置", description: "由执行者自身配置决定" }];
  if (provider && draft.model && !provider.models.includes(draft.model)) modelOptions.unshift({ value: draft.model, label: draft.model, description: `固定配置 v${draft.providerRevision}`, group: "会话当前版本" });
  return <div className="selection-bar"><div className="selection-pickers">
    <SearchPicker label="选择 Harness" value={draft.harnessId} placeholder="选择 Harness" options={harnessOptions} disabled={disabled} onChange={value => { const next = harnesses.find(row => row.id === value); props.onDraft({ ...draft, harnessId: value, controlId: next?.controls.find(row => row.id === next.defaultControlId && row.available)?.id ?? next?.controls.find(row => row.available)?.id ?? "" }); }}/>
    <SearchPicker label="选择 Provider" value={draft.providerId} placeholder="选择 Provider" options={providerOptions} disabled={disabled} onChange={value => { const next = providers.find(row => row.id === value); props.onDraft({ ...draft, providerId: next?.id ?? "", providerRevision: next?.revision ?? null, model: next?.defaultModel ?? "" }); }} footer={<button type="button" className="text-button" onClick={props.onProviders}>管理模型连接 <ArrowRight size={13}/></button>}/>
    <SearchPicker label="选择模型" value={draft.model} placeholder="选择模型" options={modelOptions} disabled={disabled || !provider} onChange={value => props.onDraft({ ...draft, model: value })}/>
  </div>
    {controls.length > 1 ? <div className="control-picker"><SearchPicker label="选择控制入口" value={draft.controlId} placeholder="控制入口" options={controls.map(control => ({ value: control.id, label: protocolLabel(control.protocol), description: control.id }))} disabled={disabled} onChange={value => props.onDraft({ ...draft, controlId: value })}/></div> : null}
    <div className="selection-actions">{pending ? <span className="pending-selection"><Spinner/>当前任务结束后生效</span> : dirty ? <button type="button" className="apply-selection" onClick={props.onApply} disabled={disabled || props.problem !== null}>{props.mutation === "switching" ? <Spinner/> : <RefreshCw size={13}/>}应用选择</button> : session ? <span className="effective-selection"><Check size={12} aria-hidden="true"/>已生效</span> : null}
      {provider && draft.providerRevision !== null && provider.revision !== draft.providerRevision ? <button type="button" className="revision-update" disabled={disabled} onClick={() => props.onDraft({ ...draft, providerRevision: provider.revision, model: provider.models.includes(draft.model) ? draft.model : provider.defaultModel })}>配置 v{draft.providerRevision} · 使用最新 v{provider.revision}</button> : null}
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
  if (message.role === "user") return <><article className="message user-message"><span className="sr-only">你：</span><div>{message.text}</div></article>{!hasAssistant && run ? <article className="message assistant-message"><div className="assistant-label"><BrandIcon brand={run?.selection.harnessId ?? ""} name={harness}/><strong>{harness}</strong></div><div className={terminal ? "empty-response" : "thinking-indicator"} role="status">{!terminal ? <Spinner/> : null}<span>{run.cancelRequested && !terminal ? "停止已受理，等待执行结束和资源清理" : run.awaitingSwitchId && run.status === "queued" ? "等待选择切换生效" : runStatusLabel(run.status)}</span></div>{run.error && (run.status === "failed" || run.status === "unknown") ? <div className="run-error">{run.error.message}</div> : null}</article> : null}</>;
  return <article className="message assistant-message"><div className="assistant-label"><BrandIcon brand={run?.selection.harnessId ?? ""} name={harness}/><strong>{harness}</strong>{run?.selection.provider ? <span>{provider?.name ?? "Provider"} · {run.selection.provider.model} <small>v{run.selection.provider.revision}</small></span> : <span>Harness 配置</span>}</div>
    {message.text ? <div className="markdown"><Suspense fallback={<p className="plain-response">{message.text}</p>}><MarkdownContent text={message.text}/></Suspense></div> : terminal ? <p className="empty-response">{message.status === "cancelled" ? "本次回复已停止。" : message.status === "failed" ? "这次调用没有返回可显示的回复。" : message.status === "unknown" ? "这次执行的结果还不能确定。" : "本次调用没有文本输出。"}</p> : <div className="thinking-indicator"><Spinner/><span>{runStatusLabel(message.status)}<span className="thinking-dots" aria-hidden="true">…</span></span></div>}
    {run?.error && (run.status === "failed" || run.status === "unknown") ? <div className="run-error" role="status">{run.error.message}</div> : null}
    <div className="message-meta">{terminal ? <><span className={message.status === "failed" || message.status === "unknown" ? "error-text" : ""}>{runStatusLabel(message.status)}</span>{message.text ? <button className="icon-button" onClick={() => void copy()} aria-label={copied ? "已复制回复" : "复制回复"}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button> : null}{copyFailed ? <span className="error-text" role="status">无法使用剪贴板，可选中文本后复制。</span> : null}</> : run?.cancelRequested ? <span>正在停止并清理资源</span> : null}</div>
  </article>;
}
