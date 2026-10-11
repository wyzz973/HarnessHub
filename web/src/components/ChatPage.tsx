import * as Popover from "@radix-ui/react-popover";
import { AlertCircle, ArrowDown, ArrowRight, Bug, Download, FolderOpen, FolderSearch, SquareTerminal, X } from "lucide-react";
import { BranchOrigin } from "./BranchOrigin.js";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ProviderView } from "../../../src/contracts/provider.js";
import type { HarnessSelection, SelectionRequest } from "../../../src/contracts/session.js";
import type { HarnessReadinessView, HarnessView, SessionView } from "../../../src/contracts/web.js";
import type { NativeModelCatalog } from "../../../src/contracts/control.js";
import { failureMessage, runStatusLabel } from "../api.js";
import { remaining } from "../attention.js";
import { BrandMark, EmptyState, ErrorNotice, Spinner, StatusBadge } from "./common.js";
import { MobileMenu } from "./Sidebar.js";
import { BrandIcon } from "./BrandIcon.js";
import { ChatComposer } from "./ChatComposer.js";
import { ChatMessage, type QueueNotice } from "./ChatMessage.js";

export interface SelectionDraft { harnessId: string; controlId: string; providerId: string; providerRevision: number | null; model: string; nativeOptions: Readonly<Record<string,string>> }
export const EMPTY_SELECTION: SelectionDraft = { harnessId: "", controlId: "", providerId: "", providerRevision: null, model: "", nativeOptions: {} };
export function selectionDraft(selection: HarnessSelection): SelectionDraft {
  return { harnessId: selection.harnessId, controlId: selection.controlId, providerId: selection.provider?.providerId ?? "", providerRevision: selection.provider?.revision ?? null, model: selection.provider?.model ?? selection.nativeModel ?? "", nativeOptions: selection.nativeOptions ?? {} };
}
export function selectionRequest(draft: SelectionDraft): SelectionRequest {
  return { harnessId: draft.harnessId, controlId: draft.controlId, provider: draft.providerId && draft.providerRevision !== null
    ? { providerId: draft.providerId, revision: draft.providerRevision, model: draft.model } : null, ...(!draft.providerId && draft.model ? { nativeModel: draft.model } : {}), ...(!draft.providerId && Object.keys(draft.nativeOptions).length ? { nativeOptions: draft.nativeOptions } : {}) };
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
/** Another conversation's title, short enough to name it within a sentence. */
function shortTitle(title: string | null | undefined): string {
  if (!title) return "另一个对话";
  const characters = [...title];
  return characters.length > 30 ? characters.slice(0, 30).join("") + "…" : title;
}
function draftMatches(draft: SelectionDraft, selection: HarnessSelection): boolean {
  return JSON.stringify(draft) === JSON.stringify(selectionDraft(selection));
}
export interface ChatProps {
  nativeModels: NativeModelCatalog | null; nativeModelsLoading: boolean; nativeModelsError: string | null; onRefreshModels: () => void;
  providerManagement?: boolean;
  session: SessionView | null; sessionRequested: boolean; sessionError: string | null; loading: boolean; draft: SelectionDraft; providers: readonly ProviderView[]; harnesses: readonly HarnessView[];
  /** What the latest catalog reads and Runs showed of each Harness entry. */
  readiness?: readonly HarnessReadinessView[];
  /** The last native choice sent with a Harness from this browser, offered when a conversation picks it for the first time. */
  rememberedChoice?: (harnessId: string) => { readonly controlId: string; readonly nativeModel?: string; readonly nativeOptions?: Readonly<Record<string, string>> } | null;
  workspace: string; mutation: string | null; error: string | null; connectionError: string | null;
  messageDraft: string; onMessageDraft: Dispatch<SetStateAction<string>>;
  onDraft: (draft: SelectionDraft) => void; onWorkspace: (workspace: string) => void; onSend: (text: string, retryAttachments?: readonly import("../../../src/contracts/content.js").ContentRef[]) => Promise<void>;
  onApply: () => void; onCancel: () => void; onClose: () => void; onDismissError: () => void; onProviders: () => void; onNew: () => void; onMenu: () => void;
  onPermission?: (id: string, option: string, input?: string) => void;
  onNativeBranch?: () => void;
  /** Keeps this conversation's native process between Turns (ADR-030), or stops keeping it; before a new conversation exists, records the choice for it. */
  onRetention?: (enabled: boolean) => void;
  /** A new conversation's choice to keep its native process, applied when its first message creates it. */
  retainNew?: boolean;
  /** Ends this conversation's kept native process. */
  onEndProcess?: () => void;
  /** Ends the kept process of the conversation that holds this workspace, then sends the refused message again. */
  onFreeWorkspace?: (run: import("../../../src/contracts/session.js").PublicRun) => Promise<void>;
  onRetryConnection?: () => void;
  onToolDetail?: import("./NativeActivity.js").ToolDetailLoader;
  /** One Turn's diagnostics, assembled and scrubbed by the Gateway (ADR-037). */
  onDiagnostics?: (runId: string, includeContent: boolean) => Promise<string>;
  attachments: readonly import("./Attachments.js").AttachmentDraft[];
  /** Branches after a finished reply; omitted while branching is unavailable. */
  onBranch?: (runId: string) => void;
  onOpenSession?: (id: string) => void;
  /** Another conversation's title, to name the one whose work holds this conversation's workspace (ADR-036). */
  sessionTitle?: (id: string) => string | null;
  /** Approvals and questions waiting in every conversation, as last pushed; null until the first list arrives. */
  attention?: readonly import("../../../src/contracts/session.js").AttentionItem[] | null;
  /** Cancels a Turn still waiting for its workspace; resolves once the cancellation is recorded or refused. */
  onCancelQueued?: (runId: string) => Promise<void>;
  /** How to continue the conversation's native session in its own program (ADR-039), read when shown. */
  onLoadNativeResume?: ((signal: AbortSignal) => Promise<import("../../../src/contracts/web.js").NativeResumeView | null>) | undefined;
  /** Reads the selected Harness's native skills, MCP servers and plugins on demand. */
  onLoadExtensions?: (signal: AbortSignal) => Promise<import("../../../src/contracts/control.js").NativeExtensions | null>;
  /** `probes` includes the sessions that catalog reads opened, which are left out otherwise. */
  onLoadNativeSessions?: (cursor: string | undefined, signal: AbortSignal, probes?: boolean) => Promise<import("../../../src/contracts/web.js").NativeSessionListView>;
  onImportNative?: (nativeId: string) => void;
  onAttach: (files: readonly File[]) => void;
  onRemoveAttachment: (local: string) => void;
}

function NativeQuestion({request,busy,onDecision}:{request:NonNullable<SessionView["permissions"]>[number];busy:boolean;onDecision:(option:string,input?:string)=>void}) {
  const [input,setInput]=useState(request.input?.value??"");
  // How long the request can still wait and whose deadline that is (ADR-035), counted once a second until it is decided.
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{ if(request.expiresAt===undefined||request.decided)return; const timer=setInterval(()=>setNow(Date.now()),1000); return ()=>clearInterval(timer); },[request.expiresAt,request.decided]);
  const left=request.expiresAt===undefined||request.decided?null:remaining(request,now);
  return <section className="native-permission" aria-label={request.input?"Harness 交互":"工具审批"}><strong>{request.title}</strong>{request.detail?<p>{request.detail}</p>:null}{request.input?.kind === "secret" ? <input type="password" autoComplete="off" aria-label={request.title} value={input} disabled={busy||request.decided} onChange={event=>setInput(event.target.value)}/> : request.input?<textarea aria-label={request.title} value={input} rows={request.input.kind==="editor"?6:2} disabled={busy||request.decided} onChange={event=>setInput(event.target.value)}/>:null}<div>{request.options.map(option=><button type="button" key={option.id} disabled={busy||request.decided} onClick={()=>onDecision(option.id,request.input&&option.id==="submit"?input:undefined)}>{option.name}</button>)}</div>{request.decided?<small>决定已记录，等待 Harness 继续。</small>:left?<small className="permission-deadline" title={left.hint}>{left.source} · {left.text}</small>:null}</section>;
}
export function ChatPage(props: ChatProps) {
  const { session, draft, harnesses, providers, mutation, error } = props;
  const [followBottom, setFollowBottom] = useState(true);
  const [dismissedSwitch, setDismissedSwitch] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const following = useRef(true);
  const mounted = useRef(true);
  const viewport = useRef({ width: 0, height: 0 });
  const previousScrollTop = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const active = session?.runs.find(run => run.id === session.activeRunId) ?? null;
  const dirty = session !== null && !draftMatches(draft, session.selection);
  const problem = (session !== null && !dirty ? effectiveProviderProblem(session.selection, providers) : null) ?? selectionProblem(draft, harnesses, providers);
  const pending = session?.pendingSwitchId !== null && session?.pendingSwitchId !== undefined;
  const blocked = session !== null && session.status !== "open";
  const latestSwitch = session?.switches.at(-1);
  const failedSwitch = latestSwitch?.status === "failed" && latestSwitch.id !== dismissedSwitch && !session?.runs.some(run =>
    run.status === "completed" && session.messages.some(message => message.runId === run.id && message.role === "user" && message.seq > latestSwitch.requestedSeq)) ? latestSwitch : null;
  const canRetry = session?.status === "open" && active === null && !dirty && !pending && problem === null && mutation === null;
  const canBranch = session !== null && session.activeRunId === null && session.pendingSwitchId === null && mutation === null;
  const branchedTitle = session?.origin?.history.find(message => message.role === "user")?.text;
  const title = session?.messages.find(message => message.role === "user")?.text ?? (branchedTitle ? "分支 · " + branchedTitle : props.sessionRequested || props.sessionError ? "打开对话" : "新对话");
  const runs = useMemo(() => new Map(session?.runs.map(run => [run.id, run])), [session?.runs]);
  const assistantRuns = useMemo(() => new Set(session?.messages.filter(message => message.role === "assistant").map(message => message.runId)), [session?.messages]);
  // How long the same Harness took to start in the latest earlier Run of this conversation, shown while a Run starts;
  // without one, its usual startup over its latest Runs anywhere.
  const startupHints = useMemo(() => {
    const hints = new Map<string, { readonly seconds: number; readonly usual: boolean }>(), latest = new Map<string, number>();
    for (const run of session?.runs ?? []) {
      const known = latest.get(run.selection.harnessId), usual = props.readiness?.find(item => item.harnessId === run.selection.harnessId && item.controlId === run.selection.controlId)?.startupMs;
      if (known !== undefined) hints.set(run.id, { seconds: known, usual: false });
      else if (usual !== undefined) hints.set(run.id, { seconds: usual / 1000, usual: true });
      if (run.timing?.preparingAt !== undefined && run.timing.readyAt !== undefined) latest.set(run.selection.harnessId, (run.timing.readyAt - run.timing.preparingAt) / 1000);
    }
    return hints;
  }, [session?.runs, props.readiness]);
  const availableHarnesses = harnesses.filter(harness => harness.controls.some(control => control.available));
  // The queued Turn names the conversation whose work holds the workspace (ADR-036); whether that one waits for the user
  // follows the pushed list of waiting requests, and the view's own answer until the first list arrives.
  const [cancellingQueue, setCancellingQueue] = useState<string | null>(null);
  const queue = session?.queue ?? null;
  const queueNotice = useMemo((): QueueNotice | undefined => {
    if (queue === null) return undefined;
    const cancel = { cancelling: cancellingQueue === queue.runId,
      onCancel: props.onCancelQueued ? () => { setCancellingQueue(queue.runId); void props.onCancelQueued!(queue.runId).finally(() => setCancellingQueue(null)); } : undefined };
    if (queue.kind === "slot") return { kind: "slot", running: queue.running, ...cancel };
    const holder = queue.holderSessionId, waiting = props.attention?.filter(item => item.sessionId === holder);
    const holderWaits = waiting === undefined ? queue.holderWaitsForUser ? "approval" as const : null
      : waiting.some(item => item.kind === "approval") ? "approval" as const : waiting.length ? "question" as const : null;
    return { kind: "workspace", holderTitle: shortTitle(props.sessionTitle?.(holder)), holderWaits, endsAt: queue.endsAt, ...cancel,
      onOpen: props.onOpenSession ? () => props.onOpenSession!(holder) : undefined };
  }, [queue, props.attention, props.sessionTitle, props.onOpenSession, props.onCancelQueued, cancellingQueue]);
  const busyHolder = useCallback((runId: string) => {
    const holder = session?.busyHolders?.[runId];
    return holder === undefined || !props.onOpenSession ? undefined : { title: shortTitle(props.sessionTitle?.(holder)), onOpen: () => props.onOpenSession!(holder) };
  }, [session?.busyHolders, props.sessionTitle, props.onOpenSession]);

  const scrollToLatest = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    previousScrollTop.current = element.scrollTop;
  }, []);
  const resumeFollowing = useCallback(() => {
    following.current = true;
    setFollowBottom(true);
    scrollToLatest();
  }, [scrollToLatest]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    following.current = true;
    setFollowBottom(true);
    scrollToLatest();
  }, [session?.id, scrollToLatest]);
  useLayoutEffect(() => {
    if (following.current) scrollToLatest();
  }, [session?.version, followBottom, scrollToLatest]);
  useEffect(() => {
    const element = scroll.current;
    const content = transcript.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      viewport.current = { width: element.clientWidth, height: element.clientHeight };
      if (following.current) scrollToLatest();
      previousScrollTop.current = element.scrollTop;
    });
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, [session?.id, props.loading, scrollToLatest]);
  const fillDraft = useCallback((text: string) => {
    props.onMessageDraft(text);
    textarea.current?.focus();
  }, [props.onMessageDraft]);
  // A retry resends the original input with the attachments it was sent with; a new message takes the composer's.
  const send = async (text: string, retryAttachments?: readonly import("../../../src/contracts/content.js").ContentRef[]) => {
    await props.onSend(text, retryAttachments);
    if (mounted.current) {
      props.onMessageDraft(value => value === text ? "" : value);
      resumeFollowing();
    }
  };
  // The latest message was refused because another conversation's kept process holds this workspace (ADR-030, option C).
  const refused = session?.runs.at(-1)?.status === "failed" && session.runs.at(-1)?.error?.code === "WORKSPACE_KEPT" ? session.runs.at(-1)! : null;
  const [freeing, setFreeing] = useState(false);
  const composer = <>{session?.permissions?.map(request => <NativeQuestion key={request.id} request={request} busy={mutation!==null} onDecision={(option,input)=>props.onPermission?.(request.id,option,input)}/>)}
    {refused && props.onFreeWorkspace ? <div className="native-permission kept-conflict" role="status"><strong>工作区正被另一个对话占用</strong><p>那个对话保留着原生进程，它的后台任务可能还在运行。可以结束它的后台进程后重试这条消息，也可以稍后再试。</p><div>
      <button type="button" disabled={freeing || mutation !== null} onClick={() => { setFreeing(true); void props.onFreeWorkspace!(refused).finally(() => setFreeing(false)); }}>{freeing ? "正在结束…" : "结束那个对话的后台进程并重试"}</button></div></div> : null}
    <ChatComposer {...props} onSend={send} active={active} dirty={dirty} pending={pending} problem={problem} blocked={blocked} inputRef={textarea}/></>;
  useEffect(() => {
    const dialog = closeDialog.current;
    if (!dialog) return;
    if (confirmClose && !dialog.open) dialog.showModal();
    else if (!confirmClose && dialog.open) dialog.close();
  }, [confirmClose]);

  return <section className="chat-page" aria-labelledby="chat-title">
    <header className="workspace-header">
      <MobileMenu onClick={props.onMenu}/>
      <div className="chat-heading"><h1 id="chat-title" title={title}>{title}</h1>{session && session.status !== "open" ? <span className="session-caption">{session.status === "closed" ? "已关闭" : "需要核实"}</span> : null}</div>
      <label className="header-workspace"><FolderOpen size={14} aria-hidden="true"/>{session ? <span title={session.workspace}>{session.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? session.workspace}</span> : <input aria-label="新对话工作目录" value={props.workspace} onChange={event => props.onWorkspace(event.target.value)} placeholder="工作目录的绝对路径" title={props.workspace}/>}</label>
      {session ? <Popover.Root><Popover.Trigger asChild><button type="button" className="icon-button export-chat" aria-label="导出对话" title="导出对话"><Download size={16}/></button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="export-menu" side="bottom" align="end" sideOffset={8} collisionPadding={16}>
          <a href={`/api/v1/sessions/${encodeURIComponent(session.id)}/export?format=markdown`} download>导出 Markdown</a>
          <a href={`/api/v1/sessions/${encodeURIComponent(session.id)}/export?format=json`} download>导出 JSON</a>
          <small>公开对话与执行摘要；原生内部状态不包含在内。</small>
        </Popover.Content></Popover.Portal></Popover.Root> : null}
      {session && session.status !== "closed" ? <button className="icon-button close-chat" aria-label="关闭这个对话" title="结束会话，保留历史" disabled={mutation !== null} onClick={() => setConfirmClose(true)}><X size={18}/></button> : null}
    </header>
    {error ? <div className="chat-error"><ErrorNotice message={error} onDismiss={props.onDismissError}/></div> : null}
    {props.connectionError ? <div className="connection-notice" role="status"><span>{props.connectionError}</span>{props.onRetryConnection ? <button type="button" onClick={props.onRetryConnection}>重新连接</button> : null}</div> : null}
    {session?.status === "blocked" ? <div className="blocked-notice" role="status"><strong>执行已暂停，对话历史和草稿仍保留。</strong><span>{session.runs.some(run => run.status === "unknown") ? "上一轮结果未知，不会自动重跑。资源确认停止后，可以明确继续新的任务。" : "可以重新选择 Harness，并检查连接后尝试恢复。所有权或存储故障需要先处理本机服务。"}</span></div> : null}
    {failedSwitch && session?.status === "open" ? <div className="selection-failure" role="status"><strong>未能切换到 {harnesses.find(harness => harness.id === failedSwitch.requested.harnessId)?.name ?? failedSwitch.requested.harnessId}</strong><p>{failedSwitch.error ? failureMessage(failedSwitch.error) : "目标连接没有通过验证。"}</p><p>当前选择仍是 {harnesses.find(harness => harness.id === session.selection.harnessId)?.name ?? session.selection.harnessId}。</p><button className="text-button" type="button" disabled={mutation !== null || pending} onClick={() => { props.onDraft(selectionDraft(session.selection)); setDismissedSwitch(failedSwitch.id); }}>继续使用当前选择</button></div> : null}
    <div className={`chat-scroll ${session === null ? "welcome-scroll" : ""}`} ref={scroll} onScroll={() => {
      const element = scroll.current;
      if (!element || viewport.current.width !== element.clientWidth || viewport.current.height !== element.clientHeight) return;
      const upward = element.scrollTop < previousScrollTop.current - 1;
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      if (upward || nearBottom) {
        following.current = !upward && nearBottom;
        setFollowBottom(following.current);
      }
      previousScrollTop.current = element.scrollTop;
    }}>
      {props.sessionError ? <EmptyState icon={<AlertCircle size={28}/>} title="无法打开这个对话" action={<button className="button secondary" onClick={props.onNew}>新建对话</button>}>{props.sessionError}</EmptyState>
        : props.loading ? <div className="chat-loading"><Spinner/><span>正在读取对话</span></div>
        : session === null ? <div className="welcome">
          <div className="welcome-identity"><BrandMark/><span>HarnessHub</span></div>
          <h2>从一个想法，开始协作。</h2>
          <p className="welcome-description">在同一对话里，与不同 Agent 协作。</p>
          {composer}
          <div className="prompt-suggestions">{[{ text: "理解一个项目", icon: FolderSearch }, { text: "帮我完成实现", icon: SquareTerminal }, { text: "排查一个问题", icon: Bug }].map(({ text, icon: Icon }) => <button key={text} onClick={() => fillDraft(text)}><Icon size={15} aria-hidden="true"/><span>{text}</span></button>)}</div>
          <div className="welcome-harness-strip"><span>本机发现</span>{availableHarnesses.slice(0, 7).map(harness => <button type="button" key={harness.id} aria-label={`选择 ${harness.name}`} title={harness.name} onClick={() => {
            // Another Harness's model and options never carry over; this Harness's last choice from this browser does.
            const remembered = props.rememberedChoice?.(harness.id), entry = remembered && harness.controls.some(control => control.id === remembered.controlId && control.available) ? remembered : null;
            props.onDraft({ ...draft, harnessId: harness.id, controlId: entry?.controlId ?? harness.controls.find(control => control.id === harness.defaultControlId && control.available)?.id ?? harness.controls.find(control => control.available)?.id ?? "",
              model: draft.providerId ? draft.model : entry?.nativeModel ?? "", nativeOptions: draft.providerId ? {} : entry?.nativeOptions ?? {} });
          }}><BrandIcon brand={harness.id} name={harness.name} size={21}/></button>)}<span>{availableHarnesses.length} 个 Harness 有入口</span></div>
          {providers.length === 0 ? <button className="welcome-config-link" onClick={props.onProviders}>配置模型连接 <ArrowRight size={14} aria-hidden="true"/></button> : null}
        </div>
        : <div className="transcript" ref={transcript} role="log" aria-label="对话历史" aria-live="off">
          {session.origin ? <BranchOrigin origin={session.origin} session={session} harnesses={harnesses} onOpenSource={props.onOpenSession}/> : null}
          {session.messages.length === 0 && session.origin ? null : session.messages.length === 0 ? <div className="conversation-empty"><BrandMark/><h2>对话准备好了</h2><p>发出第一条消息，开始这次协作。</p></div> : session.messages.map(message => <Fragment key={message.id}>
            <ChatMessage message={message} run={runs.get(message.runId)} startupHint={startupHints.get(message.runId)} harnesses={harnesses} providers={providers} onEdit={fillDraft} onRetry={canRetry ? (text, sent) => { void send(text, sent ?? []).catch(() => {}); } : undefined} {...(props.onToolDetail ? { loadToolDetail: props.onToolDetail } : {})} {...(canBranch && props.onBranch ? { onBranch: props.onBranch } : {})} loadDiagnostics={props.onDiagnostics}/>
            {message.role === "user" && !assistantRuns.has(message.runId) && runs.has(message.runId) ? <ChatMessage message={undefined} run={runs.get(message.runId)} startupHint={startupHints.get(message.runId)} harnesses={harnesses} providers={providers} onEdit={fillDraft} onRetry={canRetry ? (text, sent) => { void send(text, sent ?? []).catch(() => {}); } : undefined} {...(props.onToolDetail ? { loadToolDetail: props.onToolDetail } : {})} loadDiagnostics={props.onDiagnostics}
              queue={queue?.runId === message.runId ? queueNotice : undefined} busyHolder={busyHolder(message.runId)}/> : null}
          </Fragment>)}
          {session.switches.length > 0 ? <details className="selection-history"><summary>选择记录 <span>{session.switches.length}</span></summary>{session.switches.map(item => <div className={`switch-record ${item.status}`} key={item.id}><span>{harnesses.find(harness => harness.id === item.requested.harnessId)?.name ?? item.requested.harnessId}</span><StatusBadge tone={item.status === "failed" ? "danger" : item.status === "effective" ? "success" : "warning"}>{item.status === "effective" ? "已生效" : item.status === "failed" ? "切换失败" : "等待生效"}</StatusBadge>{item.requested.provider ? <small>{providers.find(provider => provider.id === item.requested.provider?.providerId)?.name ?? "Provider"} · {item.requested.provider.model}</small> : null}{item.error ? <small className="error-text">{failureMessage(item.error)}</small> : null}</div>)}</details> : null}
        </div>}
    </div>
    {session !== null && !props.loading ? <footer className="chat-composer-footer">{!followBottom ? <button className="follow-stream" onClick={resumeFollowing} aria-label="回到最新回复"><ArrowDown size={14} aria-hidden="true"/><span>回到最新回复</span></button> : null}{composer}</footer> : null}
    <div className="sr-only" role="status" aria-live="polite">{props.loading ? "正在读取对话" : props.sessionError ? "对话读取失败" : session?.status === "blocked" ? "执行暂时暂停，可以编辑草稿和检查恢复连接" : session?.status === "closed" ? "对话已关闭，可查看历史" : active ? active.cancelRequested ? "正在停止回复" : runStatusLabel(active.status) : pending ? "等待选择切换生效" : session ? "可以继续对话" : "选择执行者后开始新对话"}</div>
    <dialog ref={closeDialog} className="close-conversation-dialog" aria-labelledby="close-dialog-title" onCancel={() => setConfirmClose(false)}>
      <h2 id="close-dialog-title">结束这次会话？</h2><p>历史会保留。这次会话将不再接收新消息；之后可以新建对话。</p>{active || pending ? <p>当前执行或待生效的选择会停止，已经产生的内容与文件会保留。</p> : null}
      <div><button type="button" className="button secondary" onClick={() => setConfirmClose(false)} autoFocus>继续对话</button><button type="button" className="button primary" onClick={() => { setConfirmClose(false); props.onClose(); }}>结束会话</button></div>
    </dialog>
  </section>;
}
