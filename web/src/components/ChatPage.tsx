import { ArrowDown, Check, ChevronUp, Circle, CircleDashed, FileDown, GitBranch, ListChecks, ListTree, Menu as MenuIcon, MoreHorizontal, PanelLeft, PanelRight, TerminalSquare, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeExtensions, NativeModelCatalog } from "../../../src/contracts/control.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import type { AttentionItem, HarnessSelection, PublicPlan, PublicRun, SelectionRequest } from "../../../src/contracts/session.js";
import type { HarnessReadinessView, HarnessView, NativeResumeView, NativeSessionListView, SessionView } from "../../../src/contracts/web.js";
import { failureMessage, runStatusLabel } from "../api.js";
import { cn } from "../lib/cn.js";
import { clock, compact, duration, elapsed, folderName, shortTitle } from "../lib/format.js";
import { useMedia, useNow, type Preferences } from "../lib/prefs.js";
import { cancelledWords, changeCount, finished, toolTree, TOOL_PENDING, type QueueNotice } from "../lib/turn.js";
import { Collapsible, motionStyle, usePresence } from "../ui/motion.js";
import { Dialog, Menu } from "../ui/overlay.js";
import { EmptyState, Notice, Spinner, StatusPill, Tip } from "../ui/primitives.js";
import type { ToolDetailLoader } from "./Activity.js";
import { DecisionLine, decisionRole, DockedMarker, dockedRequest, PermissionCard, type Decision, type PermissionRequestView } from "./Approval.js";
import type { AttachmentDraft } from "./Attachments.js";
import { BranchOrigin } from "./BranchOrigin.js";
import { Composer, OPTION_NAMES, THINKING_NAMES, type DockedApproval } from "./Composer.js";
import { DetailsPanel, type PanelTab } from "./DetailsPanel.js";
import { AssistantTurn, SwitchDivider, UserMessage } from "./Turn.js";
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
  if (!harness) return "先选择一个 Agent，开始协作。";
  if (!harness.controls.some(row => row.id === draft.controlId && row.available)) return "这个控制入口目前不可用，请在 Agent 页中检查。";
  if (!draft.providerId) return null;
  const provider = providers.find(row => row.id === draft.providerId);
  if (!provider || !provider.enabled) return "这个 Provider 已停用或不可用，请重新选择。";
  if (!harness.providerProtocols.includes(provider.protocol)) return "这个 Agent 暂不支持所选 Provider 的协议。请选择兼容的 Provider。";
  if (provider.protocol === "gemini" && !provider.hasCredential && draft.providerRevision === provider.revision) return "Gemini 连接需要 API Key，请先在模型连接中补充密钥。";
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
  session: SessionView | null; sessionRequested: boolean; sessionError: string | null; loading: boolean; draft: SelectionDraft; providers: readonly ProviderView[];
  /** Every Harness, for names, details and history. */
  harnesses: readonly HarnessView[];
  /** The Harnesses the picker and the welcome leave out (ADR-050): frozen ones unless shown, never this conversation's or the draft's. */
  hiddenHarnesses: ReadonlySet<string>;
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
  /** Branches after a finished reply, then opens the branch as `onOpenSession` does; omitted while branching is unavailable. */
  onBranch?: (runId: string) => void;
  /**
   * Opens another conversation in place of this page, from an action on it (打开原对话, the conversation that holds the
   * workspace, a native session's conversation); it opens with `focusOnOpen`.
   */
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
  /** Continues a listed native session as a new conversation, then opens it as `onOpenSession` does. */
  onImportNative?: (nativeId: string) => void;
  /**
   * Set while this conversation was opened by an action on the page it replaced (continuing a native session, a branch,
   * 打开原对话, the conversation that holds the workspace), whose pressed control went away with that page. Once the
   * conversation is shown, the focus goes on where the user continues: the message box; the approval waiting in its place;
   * or the title when the conversation cannot take a message. Focus the user moved elsewhere meanwhile stays.
   * `onOpenFocused` then clears the request.
   */
  focusOnOpen?: boolean; onOpenFocused?: () => void;
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

/** A hand-over drawn in the transcript: the effective change and the selection that answered before it. */
interface Divider { readonly change: NonNullable<SessionView["switches"]>[number]; readonly from: HarnessSelection }
/** The latest values the page's shortcuts act on, read when a key is pressed rather than bound into the listener. */
interface ShortcutState { readonly stop: (() => void) | null; readonly togglePanel: (() => void) | null; readonly openPicker: (() => void) | null }
/** A local decision on an approval, kept until the page leaves the conversation, to write its result back into the Turn. */
type DecisionRecord = Decision & { readonly runId: string };

export function ChatPage(props: ChatProps) {
  const { session, draft, harnesses, providers, mutation, error, preferences } = props;
  const [followBottom, setFollowBottom] = useState(true);
  const [dismissedSwitch, setDismissedSwitch] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [tab, setTab] = useState<PanelTab | null>(null);
  const [panelRun, setPanelRun] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [agentPicker, setAgentPicker] = useState(false);
  const [decisions, setDecisions] = useState<ReadonlyMap<string, DecisionRecord>>(() => new Map());
  const wide = useMedia("(min-width: 1200px)"), narrow = useMedia("(max-width: 759px)");
  const following = useRef(true);
  const mounted = useRef(true);
  const viewport = useRef({ width: 0, height: 0 });
  const previousScrollTop = useRef(0), previousScrollHeight = useRef(0);
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
  // Names a selection's model and thinking level with the catalog's own names when the composer has that Harness's catalog
  // loaded: a Turn's identity line ("Native B · 思考 高"), and the same words on the pill of a hand-over to it.
  const describeSelection = useCallback((selection: HarnessSelection): string => {
    const catalog = selection.harnessId === draft.harnessId && !selection.provider ? props.nativeModels : null;
    const model = selection.provider?.model ?? (selection.nativeModel ? catalog?.models.find(row => row.id === selection.nativeModel)?.name ?? selection.nativeModel : null);
    const known = [...(catalog?.options ?? []), ...(catalog?.models.find(row => row.id === (selection.nativeModel ?? catalog.defaultModel))?.options ?? [])];
    const options = Object.entries(selection.nativeOptions ?? {}).map(([id, value]) => {
      const option = known.find(row => row.id === id), name = option?.values.find(row => row.value === value)?.name ?? value;
      if (option?.category === "thought_level" || id === "thought_level" || /thought|effort|reasoning/u.test(id)) return "思考 " + (THINKING_NAMES[value] ?? name);
      return (option?.category === "mode" ? "模式" : OPTION_NAMES[id] ?? option?.name ?? id) + " " + name;
    });
    return [model, ...options].filter(Boolean).join(" · ");
  }, [draft.harnessId, props.nativeModels]);
  const describe = useCallback((run: PublicRun): string => describeSelection(run.selection), [describeSelection]);
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
    previousScrollTop.current = element.scrollTop; previousScrollHeight.current = element.scrollHeight;
  }, []);
  const resumeFollowing = useCallback(() => { following.current = true; setFollowBottom(true); scrollToLatest(); }, [scrollToLatest]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { following.current = true; setFollowBottom(true); if (session) scrollToLatest(); else scroll.current?.scrollTo({ top: 0 }); setTab(null); setPanelRun(null); setOverlay(false); setDecisions(new Map()); }, [session?.id, scrollToLatest]);
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
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!session || !refocus.current) return;
    refocus.current = false;
    if (document.activeElement === null || document.activeElement === document.body) textarea.current?.focus({ preventScroll: true });
  }, [session?.id]);
  // Opened by an action on the page it replaced (`focusOnOpen`: continuing a native session, a branch, 打开原对话, the
  // conversation that holds the workspace), the conversation takes the focus that went away with that page once it is read:
  // the message box, or the title while there is none to write in (R03). An approval waiting in the box's place took it as
  // it was shown (Composer); the title is there should it not have. Focus the user moved meanwhile stays where it is.
  const heading = useRef<HTMLHeadingElement>(null);
  const { focusOnOpen, onOpenFocused } = props;
  useLayoutEffect(() => {
    if (!focusOnOpen || props.loading) return;
    onOpenFocused?.();
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const field = textarea.current;
    (field !== null && !field.disabled && docked === null ? field : heading.current)?.focus({ preventScroll: true });
  }, [focusOnOpen, props.loading]);
  // A first message sent from here: the conversation it goes to (one it creates, `id` null until it is shown) opens empty
  // until the message is in its view, also for a moment after the send was acknowledged. It is not shown as ready then.
  const [firstSend, setFirstSend] = useState<{ readonly id: string | null } | null>(null);
  useEffect(() => {
    if (firstSend === null || session === null) return;
    if (session.messages.length > 0 || firstSend.id !== null && firstSend.id !== session.id) setFirstSend(null);
    else if (firstSend.id === null) setFirstSend({ id: session.id });
  }, [firstSend, session?.id, session?.messages.length]);
  // A retry resends the original input with the attachments it was sent with; a new message takes the composer's.
  const send = async (text: string, retryAttachments?: readonly ContentRef[]) => {
    // The first message moves the composer from the welcome to the foot of the new conversation; the focus goes with it.
    if (session === null && document.activeElement === textarea.current) refocus.current = true;
    const first = session === null || session.messages.length === 0;
    if (first) setFirstSend({ id: session?.id ?? null });
    try { await props.onSend(text, retryAttachments); }
    catch (failure: unknown) { if (first && mounted.current) setFirstSend(null); throw failure; }
    if (mounted.current) { props.onMessageDraft(value => value === text ? "" : value); resumeFollowing(); }
  };
  // The latest message was refused because another conversation's kept process holds this workspace (ADR-030, option C).
  const refused = session?.runs.at(-1)?.status === "failed" && session.runs.at(-1)?.error?.code === "WORKSPACE_KEPT" ? session.runs.at(-1)! : null;
  const [freeing, setFreeing] = useState(false);
  // Panel: beside the conversation on wide screens, otherwise a drawer or a bottom sheet, always on demand. It stays closed
  // until opened, changes or not (decision E: the button carries the number); on wide screens an opening or closing is
  // remembered by this browser.
  const inline = wide && session !== null;
  const panelOpen = session !== null && (inline ? preferences.panel : overlay);
  // How many changes the conversation made, from the tools' summaries: the button, its 改动 tab and the tab's scopes say this
  // one number, and nothing is read while the panel is closed.
  const changes = useMemo(() => changeCount(session?.runs ?? []), [session?.runs]);
  // The number comes in as news only (ADR-054 §3): when changes arrive while the conversation is shown. Drawn with the
  // conversation, or back on the button because the panel closed (from the keyboard as well, #37), it is simply there.
  const shownChanges = useRef<{ id: string | null; count: number }>({ id: null, count: 0 });
  const changesArrived = session !== null && shownChanges.current.id === session.id && changes > shownChanges.current.count;
  useLayoutEffect(() => { shownChanges.current = { id: session?.id ?? null, count: changes }; });
  const panelTab: PanelTab = tab ?? (changes ? "changes" : session?.runs.some(run => run.plan?.entries.length) ? "plan" : "run");
  // Opened from the keyboard (⌘\), the panel's content does not slide in (#37). Decided once per opening: an animation
  // that followed the live input mode would start over whenever the next input came from the pointer.
  const [panelFromKeyboard, setPanelFromKeyboard] = useState(false);
  const setPanel = (open: boolean) => { if (open && !panelOpen) setPanelFromKeyboard(document.documentElement.dataset.input === "keyboard"); if (inline) props.onPreference("panel", open); else setOverlay(open); };
  const openDetails = (runId: string) => {
    if (panelOpen && panelTab === "run" && (panelRun ?? session?.runs.at(-1)?.id) === runId) { setPanel(false); return; }
    setPanelRun(runId); setTab("run"); setPanel(true);
  };
  const showResume = () => { setPanelRun(session?.runs.at(-1)?.id ?? null); setTab("run"); setPanel(true); };
  const detailed = preferences.density === "detailed";
  // Effective changes of Harness or model, placed after the history they carried (ADR-042), each with `from`, the selection
  // before it, which the pill draws with an arrow to the new one (C08). Changes with no message between them are one
  // hand-over, from the first one's `from` to the last one's target; none is left when they come back to where they began.
  const dividers = useMemo(() => {
    const result = new Map<number, Divider>();
    const differs = (a: HarnessSelection, b: HarnessSelection) => a.harnessId !== b.harnessId || a.nativeModel !== b.nativeModel || a.provider?.model !== b.provider?.model;
    let previous: HarnessSelection | null = session?.runs[0]?.selection ?? null;
    for (const change of session?.switches ?? []) {
      if (change.status !== "effective" || change.target === null) continue;
      const from = result.get(change.throughSeq)?.from ?? previous;
      if (from !== null && differs(from, change.target) && session!.messages.some(message => message.seq <= change.throughSeq)) result.set(change.throughSeq, { change, from });
      else result.delete(change.throughSeq);
      previous = change.target;
    }
    return result;
  }, [session?.switches, session?.runs, session?.messages]);
  const dividerAfter = useMemo(() => {
    const result = new Map<string, Divider>(), messages = session?.messages ?? [];
    for (const [through, divider] of dividers) { const last = messages.filter(message => message.seq <= through).at(-1); if (last) result.set(last.id, divider); }
    return result;
  }, [dividers, session?.messages]);
  const lastDivider = [...dividers.values()].at(-1);
  const revertTo = lastDivider ? [...(session?.runs ?? [])].reverse().find(run => run.selection.harnessId !== lastDivider.change.target?.harnessId || run.selection.nativeModel !== lastDivider.change.target?.nativeModel)?.selection : undefined;

  // Approvals wait in the composer's place, oldest first (ADR-054 §5); questions and forms stay in their Turn.
  const requestHarness = (request: PermissionRequestView) => harnessName(runs.get(request.runId as never)?.selection.harnessId ?? session?.selection.harnessId ?? "");
  const waitingApprovals = useMemo(() => (session?.permissions ?? []).filter(request => !request.decided && dockedRequest(request)).sort((a, b) => a.requestedAt - b.requestedAt), [session?.permissions]);
  const docked = session !== null && session.status !== "closed" ? waitingApprovals[0] ?? null : null;
  const decide = (request: PermissionRequestView, option: string, input?: string) => {
    const chosen = request.options.find(row => row.id === option);
    if (dockedRequest(request)) setDecisions(map => new Map(map).set(request.id, { title: request.title, option: chosen ? { ...chosen, role: decisionRole(request.options, chosen.id) } : null, harness: requestHarness(request), runId: request.runId }));
    props.onPermission?.(request.id, option, input);
  };
  // A decision is written back only once the Gateway has it: one whose request is still waiting after the page's work
  // ended was not taken (refused or not sent), and is forgotten rather than shown later as if it had been.
  useEffect(() => {
    if (mutation !== null || decisions.size === 0) return;
    const waiting = [...decisions.keys()].filter(id => session?.permissions?.some(request => request.id === id && !request.decided));
    if (waiting.length) setDecisions(map => { const next = new Map(map); for (const id of waiting) next.delete(id); return next; });
  }, [mutation, decisions, session?.permissions]);
  // The rule that asked, by the program's own name, when its configuration reports one (Codex's approval policy).
  const policy = (() => {
    if (!docked || !session) return undefined;
    const run = runs.get(docked.runId as never), harnessId = run?.selection.harnessId ?? session.selection.harnessId;
    if (harnessId !== draft.harnessId || run?.selection.provider) return undefined;
    const option = props.nativeModels?.options?.find(row => row.category === "permission");
    if (!option) return undefined;
    const value = session.nativeStates?.find(state => state.harnessId === harnessId)?.observed?.options[option.id] ?? run?.selection.nativeOptions?.[option.id] ?? option.currentValue;
    return option.values.find(row => row.value === value)?.name;
  })();
  const approval: DockedApproval | null = docked ? { request: docked, harness: requestHarness(docked), waiting: waitingApprovals.length, policy, onDecision: option => decide(docked, option) } : null;
  // What a Turn shows of its requests: the result of each approval decided here or elsewhere, a mark while one waits in
  // the composer's place, and its questions in full.
  const turnRequests = (runId: string): ReactNode => {
    const requests = session?.permissions?.filter(request => request.runId === runId) ?? [];
    const lines = [...decisions.entries()].filter(([id, record]) => record.runId === runId && requests.find(request => request.id === id)?.decided !== false)
      .map(([id, record]) => <DecisionLine key={"decision:" + id} decision={record}/>);
    const elsewhere = requests.filter(request => request.decided && dockedRequest(request) && !decisions.has(request.id))
      .map(request => <DecisionLine key={"decision:" + request.id} decision={{ title: request.title, option: null, harness: requestHarness(request) }}/>);
    const waiting = requests.some(request => !request.decided && dockedRequest(request)) && session?.status !== "closed";
    const cards = requests.filter(request => !dockedRequest(request)).map(request => <PermissionCard key={request.id} request={request} harness={requestHarness(request)} busy={mutation !== null} onDecision={(option, input) => decide(request, option, input)}/>);
    return lines.length || elsewhere.length || waiting || cards.length ? <>{lines}{elsewhere}{waiting ? <DockedMarker/> : null}{cards}</> : null;
  };
  const orphanCards = (session?.permissions ?? []).filter(request => !runs.has(request.runId as never) && !dockedRequest(request))
    .map(request => <PermissionCard key={request.id} request={request} harness={requestHarness(request)} busy={mutation !== null} onDecision={(option, input) => decide(request, option, input)}/>);
  /**
   * The transcript, one flat list of keyed parts: each message of yours, then its Turn, drawn once and keyed by its Run. The
   * Runtime creates the reply's message when its first text is committed; that message joins the Turn already drawn instead
   * of having it drawn anew in another place, so the Turn never remounts as its reply starts: its status, timer and arc carry
   * on. A reply without a message of yours in this history stands where it is; a hand-over follows the last message before it.
   */
  const transcriptItems = (current: SessionView): ReactNode[] => {
    const replies = new Map(current.messages.filter(message => message.role === "assistant").map(message => [message.runId, message] as const));
    const drawn = new Set<string>(), items: ReactNode[] = [];
    const turn = (runId: PublicRun["id"]) => {
      const run = runs.get(runId), open = (current.permissions ?? []).filter(request => request.runId === runId && !request.decided);
      return <AssistantTurn key={"turn:" + runId} message={replies.get(runId)} run={run} harnesses={harnesses} providers={providers} describe={describe} detailed={detailed}
        onRetry={canRetry ? (text, sent) => { void send(text, sent ?? []).catch(() => {}); } : undefined} loadToolDetail={props.onToolDetail} onBranch={canBranch ? props.onBranch : undefined}
        onDetails={openDetails} detailsOpen={panelOpen && panelTab === "run" && (panelRun ?? current.runs.at(-1)?.id) === runId} startupHint={startupHints.get(runId)}
        queue={queue?.runId === runId ? queueNotice : undefined} busyHolder={busyHolder(runId)}
        waiting={run && open.length ? open.some(request => dockedRequest(request)) ? "approval" : "question" : undefined}>{run ? turnRequests(runId) : null}</AssistantTurn>;
    };
    for (const message of current.messages) {
      const run = runs.get(message.runId);
      if (message.role === "user") items.push(known.current.messages.has(message.id) ? <UserMessage key={message.id} message={message} run={run} onEdit={fillDraft}/>
        : <div key={message.id} className="motion-message-in"><UserMessage message={message} run={run} onEdit={fillDraft}/></div>);
      if (!drawn.has(message.runId) && (run !== undefined || message.role === "assistant")) { drawn.add(message.runId); items.push(turn(message.runId)); }
      const divider = dividerAfter.get(message.id);
      if (divider) items.push(<SwitchDivider key={"switch:" + divider.change.id} change={divider.change} from={divider.from} detail={divider.change.target ? describeSelection(divider.change.target) : undefined} harnesses={harnesses}
        {...(divider === lastDivider && revertTo && current.status === "open" ? { onRevert: () => props.onDraft(selectionDraft(revertTo)), revertDisabled: mutation !== null || pending || active !== null } : {})}/>);
    }
    return items;
  };

  // ↑ in an empty composer: the held message comes back first, otherwise the last message sent becomes the draft.
  const editLast = session ? () => {
    if (props.queued && props.onEditQueued) { props.onEditQueued(); return; }
    const last = [...session.messages].reverse().find(message => message.role === "user");
    if (last) fillDraft(last.text);
  } : undefined;
  // Messages that arrive after the conversation opened rise into place (Motion board #15); the history does not. This is the
  // one rule for the rise (the bubble has none of its own). It covers the first message sent from the home: the conversation
  // it creates opens with an empty history (App accepts the created conversation before sending), and the message arrives after.
  const known = useRef<{ id: string | null; messages: ReadonlySet<string> }>({ id: null, messages: new Set() });
  if (session && known.current.id !== session.id) known.current = { id: session.id, messages: new Set(session.messages.map(message => message.id)) };

  // ⌘J opens the Agent list, ⌘. stops the reply, ⌘\ opens or closes the details (ADR-054 §5). The page's own listener runs
  // first and keeps these keys, so none of them reaches another binding while the conversation is shown.
  const shortcuts = useRef<ShortcutState>({ stop: null, togglePanel: null, openPicker: null });
  shortcuts.current = {
    stop: active && !active.cancelRequested && mutation === null ? props.onCancel : null,
    togglePanel: session ? () => setPanel(!panelOpen) : null,
    openPicker: docked === null && !props.loading && props.sessionError === null && session?.status !== "closed" && (mutation === null || mutation === "switching") ? () => setAgentPicker(true) : null,
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.code === "Period" || event.key === "." ? "stop" : event.code === "Backslash" || event.key === "\\" ? "panel" : event.code === "KeyJ" || event.key.toLowerCase() === "j" ? "picker" : null;
      if (key === null) return;
      // A dialog (a confirmation, the palette) keeps its own keys; toasts are dialogs that never take them.
      if (event.target instanceof Element && event.target.closest("[role='dialog']:not(.toast)")) return;
      event.preventDefault(); event.stopPropagation();
      const current = shortcuts.current;
      if (key === "stop") current.stop?.(); else if (key === "panel") current.togglePanel?.(); else current.openPicker?.();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const composer = <Composer {...props} onSendDraft={text => send(text)} active={active} dirty={dirty} pending={pending} problem={problem} blocked={blocked} inputRef={textarea}
    onShowResume={session ? showResume : undefined} approval={approval} agentPickerOpen={agentPicker} onAgentPickerOpen={setAgentPicker} onEditLast={editLast}
    above={session ? <>
      {props.queued ? <div className="queued-message motion-fade-in flex items-center gap-2.5 rounded-block bg-subtle py-1.5 pr-1.5 pl-3 text-ui-sm" role="status">
        <CircleDashed size={15} className="flex-none text-fg-3" aria-hidden="true"/>
        <span className="flex-none text-caption text-fg-3">将在本轮结束后发送</span><span className="min-w-0 flex-1 truncate" title={props.queued.text}>{props.queued.text}</span>
        {props.queued.attachments.length ? <span className="flex-none text-caption text-fg-3">附件 {props.queued.attachments.length}</span> : null}
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onEditQueued}>编辑</button><button type="button" className="btn btn-ghost btn-sm" onClick={props.onWithdrawQueued}>撤回</button>
      </div> : null}
      <PlanBar session={session} active={active} harnessName={harnessName}/>
    </> : null}
    below={session ? <StatusLine session={session} active={active}/> : null}/>;
  // What the page announces of the Turn in progress, or of one waiting in the queue (never the active Run), in the header's
  // words for the same state: the two waits as 等你批准 and 等你回答 (decision G), a Turn not started yet as 排队中 (ruling N).
  const latestRun = session?.runs.at(-1), current = active ?? (latestRun?.status === "queued" ? latestRun : null);
  const currentWaits = current ? (session?.permissions ?? []).filter(request => request.runId === current.id && !request.decided) : [];
  const currentState = current === null ? null : current.cancelRequested ? "正在停止回复" : currentWaits.length ? currentWaits.some(dockedRequest) ? "等你批准" : "等你回答"
    : current.status === "queued" ? "排队中" : runStatusLabel(current.status);
  const status = props.loading ? "正在读取对话" : props.sessionError ? "对话读取失败" : session?.status === "blocked" ? "执行暂时暂停，可以编辑草稿和检查恢复连接" : session?.status === "closed" ? "对话已关闭，可查看历史"
    : currentState ?? (pending ? "等待选择切换生效" : session ? "可以继续对话" : "选择执行者后开始新对话");
  const panel = session ? <DetailsPanel session={session} harnesses={harnesses} providers={providers} tab={panelTab} onTab={setTab} runId={panelRun} onRun={setPanelRun} describe={describe}
    loadToolDetail={props.onToolDetail} loadDiagnostics={props.onDiagnostics} loadNativeResume={props.onLoadNativeResume} onEndProcess={props.onEndProcess} busy={mutation !== null} onClose={() => setPanel(false)}/> : null;
  // #23: the panel opens by widening (300 ms) and pushes the conversation aside; its content follows 60 ms later from 24 px to
  // the right; it closes in 200 ms. From the keyboard (⌘\) it opens and closes at once.
  const asidePresence = usePresence(inline && panelOpen, 300, 200);
  const exportBase = session ? `/api/v1/sessions/${encodeURIComponent(session.id)}/export?format=` : "";

  return <section className="chat-page flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-labelledby="chat-title">
    {/* The header of the Conversation board: 54 px on a hairline, its parts 10 px apart (closer on a phone). */}
    <header className={cn("flex h-[54px] flex-none items-center gap-2 bg-app pr-3 pl-3 sm:gap-2.5", session ? "hairline-b sm:pl-6" : "sm:pl-4")}>
      {narrow ? <button type="button" className="icon-btn navigation-toggle" onClick={props.onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
        : props.sidebarHidden ? <Tip label="展开侧栏 ⌘B"><button type="button" className="icon-btn" aria-label="展开侧栏" aria-keyshortcuts="Meta+B" onClick={props.onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null}
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <h1 ref={heading} id="chat-title" tabIndex={-1} className={cn("m-0 min-w-0 truncate text-ui font-semibold outline-none", !session && "sr-only")} title={title}>{title}{session && session.status !== "open" ? <span className="ml-2 text-caption font-medium text-fg-3">{session.status === "closed" ? "已结束" : "需要核实"}</span> : null}</h1>
        {session ? <span className="hidden min-w-0 flex-none truncate text-caption text-fg-3 sm:inline sm:max-w-[40%]" title={session.workspace}>{folderName(session.workspace)}</span> : null}
      </div>
      {session ? <>
        <HeaderState session={session} active={active} harnessName={harnessName}/>
        {/* The Conversation board's header ends with the details button and "…": showing every step and ending the conversation
            are items of that menu (rulings R1, R3), so they are there at every width. */}
        <div className="flex items-center gap-0.5 sm:gap-2.5">
          <Tip label={<>{panelOpen ? "收起详情" : "打开详情"}（⌘\）</>}><button type="button" className="icon-btn relative" aria-label="详情栏" aria-pressed={panelOpen} aria-describedby={changes ? "details-changes" : undefined} onClick={() => setPanel(!panelOpen)}>
            <PanelRight size={16}/>{!panelOpen && changes ? <ChangeBadge count={changes} news={changesArrived}/> : null}
          </button></Tip>
          {changes ? <span id="details-changes" className="sr-only">本对话改动 {changes} 处</span> : null}
          <Menu align="end" trigger={<button type="button" className="icon-btn" aria-label="更多操作" title="更多操作"><MoreHorizontal size={16}/></button>} items={[
            { label: "从最新回复分支", icon: <GitBranch size={14}/>, disabled: !canBranch || !props.onBranch || !session.runs.some(run => ["completed", "failed", "cancelled"].includes(run.status)), onSelect: () => { const last = [...session.runs].reverse().find(run => ["completed", "failed", "cancelled"].includes(run.status)); if (last) props.onBranch?.(last.id); } },
            { label: "在原程序中继续的方式", icon: <TerminalSquare size={14}/>, onSelect: showResume },
            { separator: true },
            { label: panelOpen ? "收起详情" : "打开详情", icon: <PanelRight size={14}/>, hint: "⌘\\", onSelect: () => setPanel(!panelOpen) },
            // Checked is the detailed density: every Turn's steps open. This browser keeps it, as the setting does (ruling R1).
            { label: "显示每一步", icon: <ListTree size={14}/>, checked: detailed, onSelect: () => props.onPreference("density", detailed ? "compact" : "detailed") },
            { separator: true },
            { label: "导出 Markdown", icon: <FileDown size={14}/>, href: exportBase + "markdown", download: true },
            { label: "导出 JSON", icon: <FileDown size={14}/>, href: exportBase + "json", download: true },
            { separator: true },
            // The one way to end the conversation (ruling R3); the confirmation below is unchanged.
            { label: "结束对话…", icon: <X size={14}/>, description: "结束会话，保留历史", danger: true, disabled: session.status === "closed" || mutation !== null, onSelect: () => setConfirmClose(true) },
          ]} footer="导出公开对话与执行摘要；原生内部状态不包含在内。"/>
        </div>
      </> : null}
    </header>
    <div className="flex flex-col gap-2 empty:hidden">
      {error ? <div className="chat-error px-4 pt-3 sm:px-8"><Notice tone="red" onDismiss={props.onDismissError} className="mx-auto max-w-reading">{error}</Notice></div> : null}
      {props.connectionError ? <div className="px-4 pt-3 sm:px-8"><Notice tone="amber" className="connection-notice mx-auto max-w-reading" action={props.onRetryConnection ? <button type="button" className="btn btn-sm" onClick={props.onRetryConnection}>重新连接</button> : undefined}>{props.connectionError}</Notice></div> : null}
      {failedSwitch && session?.status === "open" ? <div className="px-4 pt-3 sm:px-8"><Notice tone="red" className="selection-failure mx-auto max-w-reading" title={`未能切换到 ${harnessName(failedSwitch.requested.harnessId)}`}
        action={<button className="btn btn-sm" type="button" disabled={mutation !== null || pending} onClick={() => { props.onDraft(selectionDraft(session.selection)); setDismissedSwitch(failedSwitch.id); }}>继续使用当前选择</button>}>
        {failedSwitch.error ? failureMessage(failedSwitch.error) : "目标连接没有通过验证。"} 当前选择仍是 {harnessName(session.selection.harnessId)}。</Notice></div> : null}
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn("chat-scroll scroll-area min-h-0 flex-1 px-4 sm:px-8", session === null ? "welcome-scroll" : "pt-[30px] pb-5")} ref={scroll} onScroll={() => {
          const element = scroll.current;
          if (!element || viewport.current.width !== element.clientWidth || viewport.current.height !== element.clientHeight) return;
          // Content that got shorter (a Markdown block replacing its plain-text placeholder) pulls the position up by
          // itself; only the reader moving up stops following the latest reply.
          const shrank = element.scrollHeight < previousScrollHeight.current; previousScrollHeight.current = element.scrollHeight;
          if (shrank) { previousScrollTop.current = element.scrollTop; if (following.current) scrollToLatest(); return; }
          const upward = element.scrollTop < previousScrollTop.current - 1;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          if (upward || nearBottom) { following.current = !upward && nearBottom; setFollowBottom(following.current); }
          previousScrollTop.current = element.scrollTop;
        }}>
          {props.sessionError ? <EmptyState title="无法打开这个对话" action={<button className="btn" onClick={props.onNew}>新建对话</button>}>{props.sessionError}</EmptyState>
            : props.loading ? <div className="flex items-center justify-center gap-2 py-24 text-ui-sm text-fg-2"><Spinner/><span>正在读取对话</span></div>
            : session === null ? <Welcome harnesses={harnesses.filter(harness => !props.hiddenHarnesses.has(harness.id))} readiness={props.readiness ?? []} firstUse={props.conversations === 0} selected={draft.harnessId} workspace={props.workspace} onWorkspace={props.onWorkspace}
              onSuggest={fillDraft} onHarnesses={props.onHarnesses} onSettings={props.onSettings} onRescan={props.onRescan} scanning={props.scanning} composer={composer}
              onChoose={harness => {
                // Another Harness's model and options never carry over; this Harness's last choice from this browser does.
                const remembered = props.rememberedChoice?.(harness.id), entry = remembered && harness.controls.some(control => control.id === remembered.controlId && control.available) ? remembered : null;
                props.onDraft({ ...draft, harnessId: harness.id, controlId: entry?.controlId ?? harness.controls.find(control => control.id === harness.defaultControlId && control.available)?.id ?? harness.controls.find(control => control.available)?.id ?? "",
                  model: draft.providerId ? draft.model : entry?.nativeModel ?? "", nativeOptions: draft.providerId ? {} : entry?.nativeOptions ?? {} });
                textarea.current?.focus();
              }}/>
            : <div className="transcript mx-auto flex max-w-reading flex-col gap-7 pb-4" ref={transcript} role="log" aria-label="对话历史" aria-live="off">
              {session.origin ? <BranchOrigin origin={session.origin} session={session} harnesses={harnesses} onOpenSource={props.onOpenSession}/> : null}
              {/* A first message sent from the home opens its conversation empty for a moment: it is not shown as ready meanwhile. */}
              {session.messages.length === 0 && !session.origin && mutation !== "sending" && !(firstSend !== null && (firstSend.id === null || firstSend.id === session.id))
                ? <EmptyState title="对话准备好了">发出第一条消息，开始这次协作。</EmptyState> : null}
              {transcriptItems(session)}
              {orphanCards.length ? orphanCards : null}
            </div>}
        </div>
        {session !== null && !props.loading ? <footer className="relative flex-none px-4 pt-1.5 pb-4 sm:px-8 sm:pb-3.5"><div className="mx-auto flex max-w-reading flex-col gap-2">
          {!followBottom ? <button type="button" className="follow-stream motion-enter press absolute -top-11 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border-none bg-surface pr-3 pl-3.5 text-caption font-medium text-fg-2 shadow-pop transition-[color,background-color,transform] duration-120 ease-standard hover:text-fg"
            style={motionStyle({ shift: 6 })} onClick={resumeFollowing} aria-label="回到最新回复"><span>回到最新</span><ArrowDown size={13} aria-hidden="true"/></button> : null}
          {props.queueNotice ? <Notice tone="amber" onDismiss={props.onDismissQueueNotice}>{props.queueNotice}</Notice> : null}
          {refused && props.onFreeWorkspace ? <Notice tone="amber" className="kept-conflict" title="工作区正被另一个对话占用" action={<button type="button" className="btn btn-sm" disabled={freeing || mutation !== null} onClick={() => { setFreeing(true); void props.onFreeWorkspace!(refused).finally(() => setFreeing(false)); }}>{freeing ? "正在结束…" : "结束那个对话的后台进程并重试"}</button>}>那个对话保留着原生进程，它的后台任务可能还在运行。可以结束它的后台进程后重试这条消息，也可以稍后再试。</Notice> : null}
          {composer}
        </div></footer> : null}
      </div>
      {inline && asidePresence !== "closed" ? <aside className={cn("details-aside flex-none overflow-hidden bg-app hairline-l transition-[width] ease-panel keyboard:duration-0",
        panelOpen ? "w-[400px] duration-300 starting:w-0 min-[1440px]:w-[420px]" : "w-0 duration-200")} aria-label="详情栏" aria-hidden={!panelOpen || undefined} inert={!panelOpen}>
        <div className={cn("flex h-full w-[400px] min-[1440px]:w-[420px]", !panelFromKeyboard && "motion-panel-in")}>{panel}</div>
      </aside> : null}
    </div>
    {!inline && session ? <Dialog open={overlay} onOpenChange={setOverlay} title="详情栏" kind={narrow ? "sheet" : "drawer"} className={narrow ? "h-[80dvh]" : ""}><aside className="flex min-h-0 flex-1 flex-col" aria-label="详情栏">{panel}</aside></Dialog> : null}
    <div className="sr-only" role="status" aria-live="polite">{status}</div>
    <Dialog open={confirmClose} onOpenChange={setConfirmClose} title="结束这次会话？" description="历史会保留。这次会话将不再接收新消息；之后可以新建对话。">
      <div className="flex flex-col gap-4 px-5 pt-2 pb-5">
        {active || pending ? <p className="m-0 text-ui-sm text-fg-2">当前执行或待生效的选择会停止，已经产生的内容与文件会保留。</p> : null}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setConfirmClose(false)} autoFocus>继续对话</button><button type="button" className="btn btn-primary" onClick={() => { setConfirmClose(false); props.onClose(); }}>结束会话</button></div>
      </div>
    </Dialog>
  </section>;
}

/**
 * The number of changes on the details button while the panel is closed (Conversation board: top right, 15 px, accent).
 * Decided once, when it appears: as news it pops in from .6; otherwise it is simply there.
 */
function ChangeBadge({ count, news }: { readonly count: number; readonly news: boolean }) {
  const [entering] = useState(news);
  return <span className={cn("absolute top-px right-0 min-w-[15px] rounded-full bg-accent px-1 text-center text-[10px] leading-[15px] font-semibold text-on-accent", entering && "motion-pop-in")}
    style={entering ? motionStyle({ scaleFrom: .6 }) : undefined} aria-hidden="true">{count}</span>;
}

/**
 * The conversation's state in the header (Conversation and Interaction boards): who works and what it does now, in the
 * words the sidebar and the Turn use. Running work is blue with a breathing dot and a clock; waiting for the user is
 * amber; a failure is red; a Turn that ended quietly is grey: "已停止" when the user stopped it, "已取消" when the Runtime
 * cancelled it (ADR-036, decision H). A Turn waiting in the queue is not the active Run (only a started one is), and is
 * named 排队中 as the Turn names it (ruling N).
 */
function HeaderState({ session, active, harnessName }: { readonly session: SessionView; readonly active: PublicRun | null; readonly harnessName: (id: string) => string }) {
  const now = useNow(active !== null);
  const latest = active ?? session.runs.at(-1) ?? null;
  const name = harnessName((latest ?? session).selection.harnessId);
  const since = active?.timing ? clock(now - active.timing.acceptedAt) : null;
  const state: { readonly text: string; readonly tone: "neutral" | "accent" | "amber" | "red"; readonly live?: boolean } = (() => {
    if (active) {
      const open = session.permissions?.filter(request => request.runId === active.id && !request.decided) ?? [];
      if (active.cancelRequested) return { text: "正在停止", tone: "neutral" };
      if (open.length) return { text: open.some(dockedRequest) ? "等你批准" : "等你回答", tone: "amber" };
      const clockText = since ? " · " + since : "";
      switch (active.status) {
        case "queued": return { text: "排队中", tone: "neutral" };
        case "preparing": return { text: "正在启动" + clockText, tone: "accent", live: true };
        case "settling": return { text: "正在结束", tone: "accent", live: true };
        default: {
          const tool = active.tools?.some(row => TOOL_PENDING.has(row.status)), replying = session.messages.some(message => message.runId === active.id && message.role === "assistant" && message.text);
          return { text: (tool ? "正在执行" : replying ? "正在回复" : "正在思考") + clockText, tone: "accent", live: true };
        }
      }
    }
    if (!latest) return { text: "", tone: "neutral" };
    switch (latest.status) {
      case "queued": return { text: latest.cancelRequested ? "正在停止" : "排队中", tone: "neutral" };
      case "completed": return { text: "已完成", tone: "neutral" };
      case "failed": return { text: "失败", tone: "red" };
      case "cancelled": return { text: cancelledWords(latest, true), tone: "neutral" };
      case "unknown": return { text: "结果未知", tone: "amber" };
      default: return { text: "", tone: "neutral" };
    }
  })();
  return <StatusPill tone={state.tone} live={state.live ?? false} size="lg" className="hidden max-w-[260px] min-w-0 sm:inline-flex" title={state.text ? `${name} ${state.text}` : name}>
    <span className="min-w-0 truncate">{name}{state.text ? " " + state.text : ""}</span>
  </StatusPill>;
}

/**
 * The plan bar above the composer (P01, Motion board #22): how far the plan is and what it works on now; pressing it opens
 * every step, the arrow turning 180°. Shown while a Turn with a plan runs, and while the latest plan has steps left.
 */
function PlanBar({ session, active, harnessName }: { readonly session: SessionView; readonly active: PublicRun | null; readonly harnessName: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const owner = active?.plan?.entries.length ? active : [...session.runs].reverse().find(run => run.plan?.entries.length) ?? null;
  const plan: PublicPlan | undefined = owner?.plan;
  if (!owner || !plan || !plan.entries.length || active === null && plan.entries.every(entry => entry.status === "completed")) return null;
  const done = plan.entries.filter(entry => entry.status === "completed").length, total = plan.entries.length;
  const current = plan.entries.find(entry => entry.status === "in_progress") ?? plan.entries.find(entry => entry.status === "pending");
  const where = current ? `${current.status === "in_progress" ? "正在" : "下一步"}：${current.content}` : "已完成";
  // The 8 px between the bar and its steps belongs to the steps, so a closed plan leaves no gap above the composer.
  return <div className="plan-bar flex flex-col">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      className="card card-interactive flex h-10 w-full items-center gap-[9px] border-none px-3.5 text-left text-ui-sm outline-offset-2">
      <ListChecks size={15} className="flex-none text-fg-2" aria-hidden="true"/>
      <span className="flex-none font-medium">计划</span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{done} / {total} · {where}</span>
      <span className="relative h-1 w-[72px] flex-none overflow-hidden rounded-[2px] bg-hover max-sm:hidden" aria-hidden="true">
        <span className="absolute inset-0 origin-left rounded-[2px] bg-run transition-transform duration-200 ease-standard" style={{ transform: `scaleX(${total ? done / total : 0})` }}/></span>
      <ChevronUp size={12} strokeWidth={2} className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-180")} aria-hidden="true"/>
    </button>
    <Collapsible open={open} id={id}>
      <div className="pt-2"><ul className="card m-0 grid max-h-[min(40vh,320px)] list-none grid-cols-1 gap-x-4 gap-y-2 overflow-y-auto px-4 py-3 text-ui-sm sm:grid-cols-2" aria-label={`${harnessName(owner.selection.harnessId)} 维护的计划`}>
        {plan.entries.map((entry, index) => <li key={index} className="flex min-w-0 items-start gap-2">
          {entry.status === "completed" ? <Check size={15} strokeWidth={1.9} className="mt-0.5 flex-none text-fg-3" aria-label="已完成" role="img"/>
            : <Circle size={15} strokeWidth={1.9} className={cn("mt-0.5 flex-none", entry.status === "in_progress" ? "text-run" : "text-fg-3")} aria-label={entry.status === "in_progress" ? "进行中" : "待办"} role="img"/>}
          <span className={cn("min-w-0 break-words", entry.status === "completed" ? "text-fg-3 line-through decoration-line-strong" : entry.status === "in_progress" ? "font-medium text-fg" : "text-fg-2")}>{entry.content}</span>
        </li>)}
      </ul></div>
    </Collapsible>
  </div>;
}

/** An amount in its own currency, as the program reported it. */
function money(cost: { readonly amount: number; readonly currency: string }): string {
  try { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: cost.currency, maximumFractionDigits: 2 }).format(cost.amount); }
  catch { return cost.amount.toFixed(2) + " " + cost.currency; }
}
/**
 * The line under the composer (P05): the round, its steps and its time, and only the usage the Gateway reported for it —
 * input tokens, the context share when the program gave its size, the cost in its own currency and scope. Nothing is
 * estimated; a fact the program did not report is left out.
 */
function StatusLine({ session, active }: { readonly session: SessionView; readonly active: PublicRun | null }) {
  const run = active ?? session.runs.at(-1) ?? null;
  const running = run !== null && !finished(run.status);
  // A Turn waiting in the queue has not started: as its own line says 排队中 without a timer (ruling N), this line counts no
  // time for it either, until a stop is asked for, when the Turn's line counts again (liveStatus).
  const counting = running && (run.status !== "queued" || run.cancelRequested);
  const now = useNow(counting);
  if (!run) return null;
  const round = session.runs.indexOf(run) + 1, steps = toolTree(run.tools ?? []).roots.length, timing = run.timing;
  const spent = timing ? (counting ? now : running ? null : timing.endedAt ?? null) : null;
  const usage = run.usage, context = usage?.context;
  const share = context?.size ? Math.min(100, Math.round(context.used / context.size * 100)) : null;
  // A running time counts whole seconds (#03); an ended one is said as the Turn says it, with tenths under ten seconds.
  const parts: ReactNode[] = [`第 ${round} 轮`, ...(steps ? [`${steps} 步`] : []), ...(timing && spent !== null ? [running ? "已用 " + elapsed(spent - timing.acceptedAt) : "用时 " + duration(spent - timing.acceptedAt)] : [])];
  if (usage?.turn?.input !== undefined) parts.push(`输入 ${compact(usage.turn.input)}`);
  if (context && share !== null) parts.push(<span key="context" className="inline-flex items-center gap-[5px]" title={`上下文已用 ${share}%（由原程序报告）`}>
    <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--bg-hover)" strokeWidth="3"/>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--text-3)" strokeWidth="3" strokeDasharray={`${(share / 100 * 47.1).toFixed(1)} 47.1`} strokeLinecap="round" transform="rotate(-90 10 10)"/></svg>上下文 {share}%</span>);
  else if (context) parts.push(`上下文 ${compact(context.used)}`);
  if (usage?.cost) parts.push(`${usage.cost.scope === "session" ? "会话累计" : "本轮"} ${money(usage.cost)}`);
  return <p className="composer-status m-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-1 text-caption text-fg-3" aria-label="本轮状态">
    {parts.map((part, index) => <Fragment key={index}>{index ? <span aria-hidden="true">·</span> : null}{typeof part === "string" ? <span>{part}</span> : part}</Fragment>)}
  </p>;
}
