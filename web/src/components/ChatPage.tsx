import { ArrowDown, Download, FolderOpen, GitBranch, Menu as MenuIcon, MoreHorizontal, PanelLeft, PanelRight, TerminalSquare, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeExtensions, NativeModelCatalog } from "../../../src/contracts/control.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import type { AttentionItem, HarnessSelection, PublicRun, SelectionRequest } from "../../../src/contracts/session.js";
import type { HarnessReadinessView, HarnessView, NativeResumeView, NativeSessionListView, SessionView } from "../../../src/contracts/web.js";
import { failureMessage, runStatusLabel } from "../api.js";
import { cn } from "../lib/cn.js";
import { folderName, homePath, shortTitle } from "../lib/format.js";
import { useMedia, type Preferences } from "../lib/prefs.js";
import { Dialog, Menu, Popover, PopHead } from "../ui/overlay.js";
import { EmptyState, Notice, Spinner, Tip } from "../ui/primitives.js";
import type { ToolDetailLoader } from "./Activity.js";
import { PermissionCard } from "./Approval.js";
import type { AttachmentDraft } from "./Attachments.js";
import { BranchOrigin } from "./BranchOrigin.js";
import { BrandIcon } from "./BrandIcon.js";
import { Composer, OPTION_NAMES, THINKING_NAMES } from "./Composer.js";
import { DetailsPanel, type PanelTab } from "./DetailsPanel.js";
import { NativeResume } from "./NativeResume.js";
import { AssistantTurn, SwitchDivider, UserMessage, type QueueNotice } from "./Turn.js";
import { Welcome } from "./Welcome.js";

export interface SelectionDraft { harnessId: string; controlId: string; providerId: string; providerRevision: number | null; model: string; nativeOptions: Readonly<Record<string, string>> }
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
  if (!harness.controls.some(row => row.id === draft.controlId && row.available)) return "这个控制入口目前不可用，请在“我的 Agent”中检查。";
  if (!draft.providerId) return null;
  const provider = providers.find(row => row.id === draft.providerId);
  if (!provider || !provider.enabled) return "这个 Provider 已停用或不可用，请重新选择。";
  if (!harness.providerProtocols.includes(provider.protocol)) return "这个 Harness 暂不支持所选 Provider 的协议。请选择兼容的 Provider。";
  if (provider.protocol === "gemini" && !provider.hasCredential && draft.providerRevision === provider.revision) return "Gemini 连接需要 API Key，请先在模型与账号中补充密钥。";
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
function draftMatches(draft: SelectionDraft, selection: HarnessSelection): boolean { return JSON.stringify(draft) === JSON.stringify(selectionDraft(selection)); }

/** A message the user wrote while a reply ran, held by this page until that Turn ends (ADR-042). */
export interface QueuedMessage {
  readonly text: string; readonly attachments: readonly ContentRef[]; readonly afterRunId: string;
  /** The conversation's selection when the message was held; a different one by the time the Turn ends means a switch came between. */
  readonly selection: string;
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
  onDraft: (draft: SelectionDraft) => void; onWorkspace: (workspace: string) => void; onSend: (text: string, retryAttachments?: readonly ContentRef[]) => Promise<void>;
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
  onFreeWorkspace?: (run: PublicRun) => Promise<void>;
  onRetryConnection?: () => void;
  onToolDetail?: ToolDetailLoader;
  /** One Turn's diagnostics, assembled and scrubbed by the Gateway (ADR-037). */
  onDiagnostics?: (runId: string, includeContent: boolean) => Promise<string>;
  attachments: readonly AttachmentDraft[];
  /** Branches after a finished reply; omitted while branching is unavailable. */
  onBranch?: (runId: string) => void;
  onOpenSession?: (id: string) => void;
  /** Another conversation's title, to name the one whose work holds this conversation's workspace (ADR-036). */
  sessionTitle?: (id: string) => string | null;
  /** Approvals and questions waiting in every conversation, as last pushed; null until the first list arrives. */
  attention?: readonly AttentionItem[] | null;
  /** Cancels a Turn still waiting for its workspace; resolves once the cancellation is recorded or refused. */
  onCancelQueued?: (runId: string) => Promise<void>;
  /** How to continue the conversation's native session in its own program (ADR-039), read when shown. */
  onLoadNativeResume?: ((signal: AbortSignal) => Promise<NativeResumeView | null>) | undefined;
  /** Reads the selected Harness's native skills, MCP servers and plugins on demand. */
  onLoadExtensions?: (signal: AbortSignal) => Promise<NativeExtensions | null>;
  /** `probes` includes the sessions that catalog reads opened, which are left out otherwise. */
  onLoadNativeSessions?: (cursor: string | undefined, signal: AbortSignal, probes?: boolean) => Promise<NativeSessionListView>;
  onImportNative?: (nativeId: string) => void;
  onAttach: (files: readonly File[]) => void;
  onRemoveAttachment: (local: string) => void;
  /** The message held until the current Turn ends, and its actions (ADR-042). */
  queued: QueuedMessage | null; onQueue?: () => void; onEditQueued?: () => void; onWithdrawQueued?: () => void;
  /** Why the page put a held message back into the composer instead of sending it. */
  queueNotice?: string | null; onDismissQueueNotice?: () => void;
  preferences: Preferences; onPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  sidebarHidden: boolean; onExpandSidebar: () => void; onHarnesses: () => void;
  /** How many conversations exist; none means this is the first use and the welcome says what was found. */
  conversations: number; onSettings: () => void; onRescan: () => void; scanning: boolean;
  /** Filled by the page for the composer. */
  contextUsage?: number | null; onShowResume?: (() => void) | undefined; onSendDraft?: (text: string) => Promise<void>;
}

export function ChatPage(props: ChatProps) {
  const { session, draft, harnesses, providers, mutation, error, preferences } = props;
  const [followBottom, setFollowBottom] = useState(true);
  const [dismissedSwitch, setDismissedSwitch] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [tab, setTab] = useState<PanelTab | null>(null);
  const [panelRun, setPanelRun] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);
  const wide = useMedia("(min-width: 1200px)"), narrow = useMedia("(max-width: 759px)");
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
  const harnessName = (id: string) => harnesses.find(row => row.id === id)?.name ?? id;
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
  // Names a Turn's model and thinking level with the catalog's own names when the composer has that Harness's catalog loaded.
  const describe = useCallback((run: PublicRun): string => {
    const catalog = run.selection.harnessId === draft.harnessId && !run.selection.provider ? props.nativeModels : null;
    const model = run.selection.provider?.model ?? (run.selection.nativeModel ? catalog?.models.find(row => row.id === run.selection.nativeModel)?.name ?? run.selection.nativeModel : null);
    const known = [...(catalog?.options ?? []), ...(catalog?.models.find(row => row.id === (run.selection.nativeModel ?? catalog.defaultModel))?.options ?? [])];
    const options = Object.entries(run.selection.nativeOptions ?? {}).map(([id, value]) => {
      const option = known.find(row => row.id === id), name = option?.values.find(row => row.value === value)?.name ?? value;
      if (option?.category === "thought_level" || id === "thought_level" || /thought|effort|reasoning/u.test(id)) return "思考 " + (THINKING_NAMES[value] ?? name);
      return (option?.category === "mode" ? "模式" : OPTION_NAMES[id] ?? option?.name ?? id) + " " + name;
    });
    return [model, ...options].filter(Boolean).join(" · ");
  }, [draft.harnessId, props.nativeModels]);
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
    const element = scroll.current; if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    previousScrollTop.current = element.scrollTop;
  }, []);
  const resumeFollowing = useCallback(() => { following.current = true; setFollowBottom(true); scrollToLatest(); }, [scrollToLatest]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { following.current = true; setFollowBottom(true); if (session) scrollToLatest(); else scroll.current?.scrollTo({ top: 0 }); setTab(null); setPanelRun(null); setOverlay(false); }, [session?.id, scrollToLatest]);
  useLayoutEffect(() => { if (following.current && session) scrollToLatest(); }, [session?.version, followBottom, scrollToLatest, props.queued]);
  useEffect(() => {
    const element = scroll.current, content = transcript.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      viewport.current = { width: element.clientWidth, height: element.clientHeight };
      if (following.current && session !== null) scrollToLatest();
      previousScrollTop.current = element.scrollTop;
    });
    observer.observe(element); observer.observe(content);
    return () => observer.disconnect();
  }, [session?.id, props.loading, scrollToLatest]);
  const fillDraft = useCallback((text: string) => { props.onMessageDraft(text); textarea.current?.focus(); }, [props.onMessageDraft]);
  // A retry resends the original input with the attachments it was sent with; a new message takes the composer's.
  const send = async (text: string, retryAttachments?: readonly ContentRef[]) => {
    await props.onSend(text, retryAttachments);
    if (mounted.current) { props.onMessageDraft(value => value === text ? "" : value); resumeFollowing(); }
  };
  // The latest message was refused because another conversation's kept process holds this workspace (ADR-030, option C).
  const refused = session?.runs.at(-1)?.status === "failed" && session.runs.at(-1)?.error?.code === "WORKSPACE_KEPT" ? session.runs.at(-1)! : null;
  const [freeing, setFreeing] = useState(false);
  // Panel: beside the conversation on wide screens (open by preference), otherwise a drawer or a bottom sheet on demand.
  const inline = wide && session !== null;
  const panelOpen = session !== null && (inline ? preferences.panel : overlay);
  const panelTab: PanelTab = tab ?? (session?.runs.some(run => run.tools?.some(tool => ["edit", "delete", "move"].includes(tool.kind ?? "") && tool.detail)) ? "changes" : session?.runs.some(run => run.plan?.entries.length) ? "plan" : "run");
  const setPanel = (open: boolean) => { if (inline) props.onPreference("panel", open); else setOverlay(open); };
  const openDetails = (runId: string) => {
    if (panelOpen && panelTab === "run" && (panelRun ?? session?.runs.at(-1)?.id) === runId) { setPanel(false); return; }
    setPanelRun(runId); setTab("run"); setPanel(true);
  };
  const showResume = () => { setPanelRun(session?.runs.at(-1)?.id ?? null); setTab("run"); setPanel(true); };
  const latestUsage = [...(session?.runs ?? [])].reverse().find(run => run.usage?.context?.size)?.usage?.context;
  const contextUsage = latestUsage?.size ? Math.round(latestUsage.used / latestUsage.size * 100) : null;
  const detailed = preferences.density === "detailed";
  // Effective changes of Harness or model, placed after the history they carried (ADR-042).
  const dividers = useMemo(() => {
    const result = new Map<number, NonNullable<SessionView["switches"]>[number]>();
    let previous: HarnessSelection | null = session?.runs[0]?.selection ?? null;
    for (const change of session?.switches ?? []) {
      if (change.status !== "effective" || change.target === null) continue;
      if (previous !== null && (previous.harnessId !== change.target.harnessId || previous.nativeModel !== change.target.nativeModel || previous.provider?.model !== change.target.provider?.model) && session!.messages.some(message => message.seq <= change.throughSeq)) result.set(change.throughSeq, change);
      previous = change.target;
    }
    return result;
  }, [session?.switches, session?.runs, session?.messages]);
  const dividerAfter = useMemo(() => {
    const result = new Map<string, NonNullable<SessionView["switches"]>[number]>(), messages = session?.messages ?? [];
    for (const [through, change] of dividers) { const last = messages.filter(message => message.seq <= through).at(-1); if (last) result.set(last.id, change); }
    return result;
  }, [dividers, session?.messages]);
  const lastDivider = [...dividers.values()].at(-1);
  const revertTo = lastDivider ? [...(session?.runs ?? [])].reverse().find(run => run.selection.harnessId !== lastDivider.target?.harnessId || run.selection.nativeModel !== lastDivider.target?.nativeModel)?.selection : undefined;
  const orphanPermissions = session?.permissions?.filter(request => !runs.has(request.runId as never)) ?? [];
  const permissionsFor = (runId: string) => session?.permissions?.filter(request => request.runId === runId) ?? [];
  const permissionCards = (requests: NonNullable<SessionView["permissions"]>) => requests.map(request => <PermissionCard key={request.id} request={request} harness={harnessName(session?.runs.find(run => run.id === request.runId)?.selection.harnessId ?? session?.selection.harnessId ?? "")} busy={mutation !== null} onDecision={(option, input) => props.onPermission?.(request.id, option, input)}/>);
  const composer = <Composer {...props} onSendDraft={text => send(text)} active={active} dirty={dirty} pending={pending} problem={problem} blocked={blocked} inputRef={textarea} contextUsage={contextUsage} onShowResume={session ? showResume : undefined}/>;
  const status = props.loading ? "正在读取对话" : props.sessionError ? "对话读取失败" : session?.status === "blocked" ? "执行暂时暂停，可以编辑草稿和检查恢复连接" : session?.status === "closed" ? "对话已关闭，可查看历史" : active ? active.cancelRequested ? "正在停止回复" : runStatusLabel(active.status) : pending ? "等待选择切换生效" : session ? "可以继续对话" : "选择执行者后开始新对话";
  const workspace = session?.workspace ?? props.workspace;
  const panel = session ? <DetailsPanel session={session} harnesses={harnesses} providers={providers} tab={panelTab} onTab={setTab} runId={panelRun} onRun={setPanelRun} describe={describe}
    loadToolDetail={props.onToolDetail} loadDiagnostics={props.onDiagnostics} loadNativeResume={props.onLoadNativeResume} onEndProcess={props.onEndProcess} busy={mutation !== null} {...(inline ? {} : { onClose: () => setOverlay(false) })}/> : null;

  return <section className="chat-page flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-labelledby="chat-title">
    <header className="flex h-14 flex-none items-center gap-2 border-b border-line bg-app pr-2.5 pl-3 sm:gap-3 sm:pr-3.5 sm:pl-[18px]">
      {narrow ? <button type="button" className="icon-btn navigation-toggle" onClick={props.onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
        : props.sidebarHidden ? <Tip label="展开侧栏"><button type="button" className="icon-btn" aria-label="展开侧栏" onClick={props.onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 id="chat-title" className="m-0 truncate text-[15px] font-semibold tracking-[-0.005em]" title={title}>{title}{session && session.status !== "open" ? <span className="ml-2 align-middle text-[11.5px] font-medium text-fg-3">{session.status === "closed" ? "已结束" : "需要核实"}</span> : null}</h1>
        {session ? <div className="flex min-w-0 items-center gap-2 text-[12px] text-fg-2">
          <span className="flex flex-none items-center gap-1.5"><BrandIcon brand={session.selection.harnessId} name={harnessName(session.selection.harnessId)} size={14}/>{harnessName(session.selection.harnessId)}</span>
          <span className="text-fg-3">·</span><span className="flex min-w-0 items-center gap-1" title={session.workspace}><FolderOpen size={12} className="flex-none" aria-hidden="true"/><span className="mono truncate text-[11.5px]">{homePath(session.workspace) || folderName(session.workspace)}</span></span>
        </div> : null}
      </div>
      {session ? <>
        <div className="hidden sm:flex"><div className="segmented" role="group" aria-label="过程显示">
          <button type="button" aria-pressed={!detailed} onClick={() => props.onPreference("density", "compact")}>简洁</button>
          <button type="button" aria-pressed={detailed} onClick={() => props.onPreference("density", "detailed")}>详细</button></div></div>
        <div className="flex items-center gap-0.5">
          {session.nativeStates?.some(state => state.harnessId === session.selection.harnessId && state.status === "ready") && props.onLoadNativeResume ? <Popover label="在原程序中继续这段对话" align="end" className="w-[380px] max-w-[calc(100vw-24px)]"
            trigger={<button type="button" className="icon-btn hidden sm:inline-flex" aria-label="继续到原程序" title="在原程序中继续"><TerminalSquare size={16}/></button>}>
            <PopHead title="在原程序中继续" closeLabel="关闭"/><div className="p-3.5"><NativeResume key={session.id} load={props.onLoadNativeResume}/></div></Popover> : null}
          <Popover label="导出对话" align="end" className="w-[260px]" trigger={<button type="button" className="icon-btn export-chat" aria-label="导出对话" title="导出对话"><Download size={16}/></button>}>
            <div className="flex flex-col p-1.5">
              <a className="menu-item" href={`/api/v1/sessions/${encodeURIComponent(session.id)}/export?format=markdown`} download>导出 Markdown</a>
              <a className="menu-item" href={`/api/v1/sessions/${encodeURIComponent(session.id)}/export?format=json`} download>导出 JSON</a>
              <small className="px-2.5 pt-1.5 pb-1 text-[11.5px] text-fg-3">公开对话与执行摘要；原生内部状态不包含在内。</small>
            </div>
          </Popover>
          <Menu align="end" trigger={<button type="button" className="icon-btn" aria-label="更多操作" title="更多操作"><MoreHorizontal size={16}/></button>} items={[
            { label: "从最新回复分支", icon: <GitBranch size={14}/>, disabled: !canBranch || !props.onBranch || !session.runs.some(run => ["completed", "failed", "cancelled"].includes(run.status)), onSelect: () => { const last = [...session.runs].reverse().find(run => ["completed", "failed", "cancelled"].includes(run.status)); if (last) props.onBranch?.(last.id); } },
            { label: "在原程序中继续的方式", icon: <TerminalSquare size={14}/>, onSelect: showResume },
            { label: panelOpen ? "隐藏详情栏" : "显示详情栏", icon: <PanelRight size={14}/>, onSelect: () => setPanel(!panelOpen) },
            { separator: true },
            { label: "结束对话…", icon: <X size={14}/>, danger: true, disabled: session.status === "closed" || mutation !== null, onSelect: () => setConfirmClose(true) },
          ]}/>
          {session.status !== "closed" ? <Tip label="结束会话，保留历史"><button type="button" className="icon-btn close-chat" aria-label="关闭这个对话" disabled={mutation !== null} onClick={() => setConfirmClose(true)}><X size={17}/></button></Tip> : null}
          <span className="mx-1.5 hidden h-5 w-px bg-line sm:block" aria-hidden="true"/>
          <Tip label={panelOpen ? "隐藏详情栏" : "显示详情栏"}><button type="button" className="icon-btn" aria-label="详情栏" aria-pressed={panelOpen} onClick={() => setPanel(!panelOpen)}><PanelRight size={16}/></button></Tip>
        </div>
      </> : null}
    </header>
    <div className="flex flex-col gap-2 empty:hidden">
      {error ? <div className="chat-error px-4 pt-3 sm:px-7"><Notice tone="red" onDismiss={props.onDismissError} className="mx-auto max-w-[760px]">{error}</Notice></div> : null}
      {props.connectionError ? <div className="px-4 pt-3 sm:px-7"><Notice tone="amber" className="connection-notice mx-auto max-w-[760px]" action={props.onRetryConnection ? <button type="button" className="btn btn-sm" onClick={props.onRetryConnection}>重新连接</button> : undefined}>{props.connectionError}</Notice></div> : null}
      {session?.status === "blocked" ? <div className="px-4 pt-3 sm:px-7"><Notice tone="amber" className="blocked-notice mx-auto max-w-[760px]" title="执行已暂停，对话历史和草稿仍保留。">{session.runs.some(run => run.status === "unknown") ? "上一轮结果未知，不会自动重跑。资源确认停止后，可以明确继续新的任务。" : "可以重新选择 Harness，并检查连接后尝试恢复。所有权或存储故障需要先处理本机服务。"}</Notice></div> : null}
      {failedSwitch && session?.status === "open" ? <div className="px-4 pt-3 sm:px-7"><Notice tone="red" className="selection-failure mx-auto max-w-[760px]" title={`未能切换到 ${harnessName(failedSwitch.requested.harnessId)}`}
        action={<button className="btn btn-sm" type="button" disabled={mutation !== null || pending} onClick={() => { props.onDraft(selectionDraft(session.selection)); setDismissedSwitch(failedSwitch.id); }}>继续使用当前选择</button>}>
        {failedSwitch.error ? failureMessage(failedSwitch.error) : "目标连接没有通过验证。"} 当前选择仍是 {harnessName(session.selection.harnessId)}。</Notice></div> : null}
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn("chat-scroll scroll-area min-h-0 flex-1 px-4 sm:px-7", session === null ? "welcome-scroll pt-0" : "pt-7 pb-2")} ref={scroll} onScroll={() => {
          const element = scroll.current;
          if (!element || viewport.current.width !== element.clientWidth || viewport.current.height !== element.clientHeight) return;
          const upward = element.scrollTop < previousScrollTop.current - 1;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          if (upward || nearBottom) { following.current = !upward && nearBottom; setFollowBottom(following.current); }
          previousScrollTop.current = element.scrollTop;
        }}>
          {props.sessionError ? <EmptyState title="无法打开这个对话" action={<button className="btn" onClick={props.onNew}>新建对话</button>}>{props.sessionError}</EmptyState>
            : props.loading ? <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-fg-2"><Spinner/><span>正在读取对话</span></div>
            : session === null ? <Welcome harnesses={harnesses} readiness={props.readiness ?? []} firstUse={props.conversations === 0} selected={draft.harnessId} workspace={props.workspace} onWorkspace={props.onWorkspace}
              onSuggest={fillDraft} onHarnesses={props.onHarnesses} onSettings={props.onSettings} onRescan={props.onRescan} scanning={props.scanning} composer={composer}
              onChoose={harness => {
                // Another Harness's model and options never carry over; this Harness's last choice from this browser does.
                const remembered = props.rememberedChoice?.(harness.id), entry = remembered && harness.controls.some(control => control.id === remembered.controlId && control.available) ? remembered : null;
                props.onDraft({ ...draft, harnessId: harness.id, controlId: entry?.controlId ?? harness.controls.find(control => control.id === harness.defaultControlId && control.available)?.id ?? harness.controls.find(control => control.available)?.id ?? "",
                  model: draft.providerId ? draft.model : entry?.nativeModel ?? "", nativeOptions: draft.providerId ? {} : entry?.nativeOptions ?? {} });
                textarea.current?.focus();
              }}/>
            : <div className="transcript mx-auto flex max-w-[760px] flex-col gap-[22px] pb-4" ref={transcript} role="log" aria-label="对话历史" aria-live="off">
              {session.origin ? <BranchOrigin origin={session.origin} session={session} harnesses={harnesses} onOpenSource={props.onOpenSession}/> : null}
              {session.messages.length === 0 && !session.origin ? <EmptyState title="对话准备好了">发出第一条消息，开始这次协作。</EmptyState> : null}
              {session.messages.map(message => {
                const run = runs.get(message.runId), divider = dividerAfter.get(message.id);
                const turn = (msg: typeof message | undefined) => <AssistantTurn message={msg} run={run} harnesses={harnesses} providers={providers} describe={describe} detailed={detailed}
                  onRetry={canRetry ? (text, sent) => { void send(text, sent ?? []).catch(() => {}); } : undefined} loadToolDetail={props.onToolDetail} onBranch={canBranch ? props.onBranch : undefined}
                  onDetails={openDetails} detailsOpen={panelOpen && panelTab === "run" && (panelRun ?? session.runs.at(-1)?.id) === run?.id} startupHint={startupHints.get(message.runId)}
                  queue={queue?.runId === message.runId ? queueNotice : undefined} busyHolder={busyHolder(message.runId)}
                  waiting={run ? (() => { const open = permissionsFor(run.id).filter(request => !request.decided); return open.length ? open.some(request => request.kind !== "question" && request.input === undefined) ? "approval" as const : "question" as const : undefined; })() : undefined}>{run ? permissionCards(permissionsFor(run.id)) : null}</AssistantTurn>;
                return <Fragment key={message.id}>
                  {message.role === "user" ? <UserMessage message={message} run={run} onEdit={fillDraft}/> : turn(message)}
                  {message.role === "user" && !assistantRuns.has(message.runId) && run ? turn(undefined) : null}
                  {divider ? <SwitchDivider change={divider} harnesses={harnesses} {...(divider === lastDivider && revertTo && session.status === "open" ? { onRevert: () => props.onDraft(selectionDraft(revertTo)), revertDisabled: mutation !== null || pending || active !== null } : {})}/> : null}
                </Fragment>;
              })}
              {orphanPermissions.length ? permissionCards(orphanPermissions) : null}
            </div>}
        </div>
        {session !== null && !props.loading ? <footer className="relative flex-none px-4 pt-1.5 pb-4 sm:px-7 sm:pb-[18px]"><div className="mx-auto flex max-w-[760px] flex-col gap-2">
          {!followBottom ? <button type="button" className="follow-stream absolute -top-11 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] shadow-md hover:bg-hover" onClick={resumeFollowing} aria-label="回到最新回复"><ArrowDown size={13} aria-hidden="true"/><span>回到最新回复</span></button> : null}
          {props.queueNotice ? <Notice tone="amber" onDismiss={props.onDismissQueueNotice}>{props.queueNotice}</Notice> : null}
          {refused && props.onFreeWorkspace ? <Notice tone="amber" className="kept-conflict" title="工作区正被另一个对话占用" action={<button type="button" className="btn btn-sm" disabled={freeing || mutation !== null} onClick={() => { setFreeing(true); void props.onFreeWorkspace!(refused).finally(() => setFreeing(false)); }}>{freeing ? "正在结束…" : "结束那个对话的后台进程并重试"}</button>}>那个对话保留着原生进程，它的后台任务可能还在运行。可以结束它的后台进程后重试这条消息，也可以稍后再试。</Notice> : null}
          {props.queued ? <div className="queued-message enter flex items-center gap-2.5 rounded-[10px] border border-dashed border-line-strong bg-app py-[7px] pr-2 pl-3 text-[13px]" role="status">
            <span className="flex-none text-[11.5px] text-fg-3">将在本轮结束后发送</span><span className="min-w-0 flex-1 truncate" title={props.queued.text}>{props.queued.text}</span>
            {props.queued.attachments.length ? <span className="flex-none text-[11.5px] text-fg-3">附件 {props.queued.attachments.length}</span> : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={props.onEditQueued}>编辑</button><button type="button" className="btn btn-ghost btn-sm" onClick={props.onWithdrawQueued}>撤回</button>
          </div> : null}
          {composer}
        </div></footer> : null}
      </div>
      {inline && panelOpen ? <aside className="hidden w-[400px] flex-none border-l border-line bg-surface min-[1200px]:flex min-[1440px]:w-[420px]" aria-label="详情栏">{panel}</aside> : null}
    </div>
    {!inline && session ? <Dialog open={overlay} onOpenChange={setOverlay} title="详情栏" kind={narrow ? "sheet" : "drawer"} className={narrow ? "h-[80dvh]" : ""}><aside className="flex min-h-0 flex-1 flex-col" aria-label="详情栏">{panel}</aside></Dialog> : null}
    <div className="sr-only" role="status" aria-live="polite">{status}</div>
    <Dialog open={confirmClose} onOpenChange={setConfirmClose} title="结束这次会话？" description="历史会保留。这次会话将不再接收新消息；之后可以新建对话。">
      <div className="flex flex-col gap-4 px-5 pt-2 pb-5">
        {active || pending ? <p className="m-0 text-[13px] text-fg-2">当前执行或待生效的选择会停止，已经产生的内容与文件会保留。</p> : null}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setConfirmClose(false)} autoFocus>继续对话</button><button type="button" className="btn btn-primary" onClick={() => { setConfirmClose(false); props.onClose(); }}>结束会话</button></div>
      </div>
    </Dialog>
  </section>;
}
