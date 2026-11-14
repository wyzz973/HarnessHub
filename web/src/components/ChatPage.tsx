import type { TaskBoardAccess } from "./TaskBoard.js";
import { ArrowDown, Check, ChevronUp, Circle, CircleDashed, FileDown, GitBranch, ListChecks, ListTree, Menu as MenuIcon, MoreHorizontal, PanelLeft, PanelRight, Split, SquareTerminal, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeExtensions, NativeModelCatalog } from "../../../src/contracts/control.js";
import type { ProviderView } from "../../../src/contracts/provider.js";
import { TURN_STATUS_WORDS } from "../../../src/contracts/protocol-words.js";
import type { AttentionItem, HarnessSelection, PublicRun, SelectionRequest } from "../../../src/contracts/session.js";
import type { HarnessReadinessView, HarnessView, NativeSessionListView, SessionSummary } from "../../../src/contracts/web.js";
import type { ConversationView } from "../lib/conversation.js";
import { failureMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { actionOf, ariaKeys, keyText, useKeys } from "../lib/keys.js";
import { clock, folderName, homePath, inScratch, shortTitle } from "../lib/format.js";
import { useMedia, useNow, type Preferences } from "../lib/prefs.js";
import { bannerOf, installationNotices, relayHasStory, relayLine } from "../lib/relay-state.js";
import { useClosedNotices } from "../lib/use-relay.js";
import type { RelayApi, RelayPrefs, RelayRequest, RelayView } from "../relay.js";
import type { QueueNotice } from "../lib/protocol/live.js";
import { changeCount, latestPlan, over, planRows, shownPlan, statusParts, stateOf } from "../lib/protocol/runs.js";
import { finished } from "../lib/turn.js";
import { Collapsible, motionStyle, usePresence } from "../ui/motion.js";
import { Dialog, Menu, useToast } from "../ui/overlay.js";
import { EmptyState, Notice, Spinner, StatusPill, Tip } from "../ui/primitives.js";
import type { ToolDetailLoader } from "./Activity.js";
import { decisionRole, dockedRequest, PermissionCard, type Decision, type PermissionRequestView } from "./Approval.js";
import type { AttachmentDraft } from "./Attachments.js";
import { BranchOrigin } from "./BranchOrigin.js";
import { Composer, type DockedApproval } from "./Composer.js";
import { DetailsPanel, type ChangesLoader, type ChangesWant, type PanelTab, type WorkspaceFacts } from "./DetailsPanel.js";
import type { DiffRemark } from "./DiffBody.js";
import type { WorkspaceAccess } from "./WorkspaceTools.js";
import { TerminalDrawer, type ProjectScript, type TerminalAccess } from "./TerminalDrawer.js";
import { FindBar, type FindAccess, type FindHit, type FindTarget } from "./FindBar.js";
import type { GitAccess } from "./GitChanges.js";
import { RelayPacketDialog, type PacketTarget } from "./RelayDetails.js";
import { RelayCard, RelayInstallation, SEND_ALONE, type RelayNext } from "./RelayCard.js";
import { ProtocolTurn, type TurnReads } from "./ProtocolTurn.js";
import { Welcome, type Place } from "./Welcome.js";
import { DelegateDialog, DelegationCards, type DelegationResult } from "./Delegation.js";
import { PERMISSION_WORDS, selectionLevels } from "../../../src/contracts/levels.js";

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
  if (!harness.controls.some(row => row.id === draft.controlId && row.available)) return "这个控制入口目前不可用，请在 Harness 页中检查。";
  if (!draft.providerId) return null;
  const provider = providers.find(row => row.id === draft.providerId);
  if (!provider || !provider.enabled) return "这个 Provider 已停用或不可用，请重新选择。";
  if (!harness.providerProtocols.includes(provider.protocol)) return "这个 Harness 暂不支持所选 Provider 的协议。请选择兼容的 Provider。";
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

/**
 * What the page knows and does about the relay: its data layer, the conversation's relay state (null when the Gateway has
 * none to give, and then nothing of the relay is drawn), and what the user chose for the next message alone.
 */
export interface ChatRelay {
  readonly api: RelayApi;
  readonly view: RelayView | null;
  /** The view was read for the state the conversation is in now (not before the Turn that just ended): what is owed and asked is only said then. */
  readonly fresh: boolean;
  /** The Gateway's relay setting, when it gave it: with the hand-over turned off the line says the message goes with the words alone. */
  readonly prefs: RelayPrefs | null;
  readonly next: RelayNext | null;
  readonly onNext: (next: RelayNext | null) => void;
}

/** A message the user wrote while a reply ran, held by this page until that Turn ends (ADR-042). */
export interface QueuedMessage {
  readonly text: string; readonly attachments: readonly ContentRef[]; readonly afterRunId: string;
  /** The conversation's selection when the message was held; a different one by the time the Turn ends means a switch came between. */
  readonly selection: string;
}

export interface ChatProps {
  nativeModels: NativeModelCatalog | null; nativeModelsLoading: boolean; nativeModelsError: string | null; onRefreshModels: () => void;
  providerManagement?: boolean;
  /** The part of the conversation the page holds: its head and the Turns from the newest back as far as the reader has gone (lib/conversation.ts). */
  session: ConversationView | null; sessionRequested: boolean; sessionError: string | null; loading: boolean; draft: SelectionDraft; providers: readonly ProviderView[];
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
  onDraft: (draft: SelectionDraft) => void;
  /** Where a new conversation works, the folders of earlier ones, and the system's folder dialog. */
  place: Place; onPlace: (place: Place) => void; recentFolders: readonly string[]; onChooseFolder: (start: string | undefined) => Promise<string | null>;
  /** Where the Gateway keeps the folders of conversations started without one. */
  scratchRoot?: string | undefined;
  /** The conversations this one delegated work to, newest first; how one of them stands; and the way to delegate (the conversation goes on meanwhile). */
  delegations?: readonly SessionSummary[]; onLoadDelegation?: (id: string, signal: AbortSignal) => Promise<DelegationResult>;
  onDelegate?: (harness: HarnessView, text: string) => Promise<void>;
  /** Sends the message; `relay` is what the user chose about the history for this one message (a way forward from a refusal). */
  onSend: (text: string, retryAttachments?: readonly ContentRef[], relay?: RelayRequest) => Promise<void>;
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
  /** Sends a message again from the place of the Turn `runId` (edited, or the same to try the reply again): a branch inside this conversation. */
  onBranchSend?: (runId: string, text: string, attachments?: readonly ContentRef[]) => Promise<void>;
  /** Makes the branch through the Turn `runId` this conversation's path; nothing runs. */
  onSelectBranch?: (runId: string) => Promise<void>;
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
  /** Says the message in the box to the Harness now, in the Turn in progress; absent when that Harness cannot be told anything mid-Turn. */
  onSteer?: (() => void) | undefined;
  /** Says the message kept for after the Turn to the Harness now (it can be told something mid-Turn); absent where it cannot. */
  onSteerQueued?: (() => void) | undefined;
  queued: QueuedMessage | null; onQueue?: () => void; onEditQueued?: () => void; onWithdrawQueued?: () => void;
  /** Why the page put a held message back into the composer instead of sending it. */
  queueNotice?: string | null; onDismissQueueNotice?: () => void;
  preferences: Preferences; onPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  /** Gives the open conversation another title; resolves once the Gateway kept it. Absent where it cannot be renamed. */
  onRename?: ((title: string) => Promise<void>) | undefined;
  /** Shows the open conversation's workspace, or a file in it, in the Finder. */
  onReveal?: ((path?: string) => void) | undefined;
  /** The open conversation's workspace as Git sees it, for the changes page; absent where the Gateway cannot read it. */
  git?: GitAccess | undefined;
  /** Finds words in the open conversation, all of it, and reads its Turns down to a place; absent where the Gateway cannot search. */
  find?: FindAccess | undefined;
  /** Putting the files back as they were before a Turn (`ordinal`), offered with a resend where the conversation works in a worktree of its own. */
  restore?: { readonly can: (ordinal: number, signal: AbortSignal) => Promise<boolean>; readonly run: (ordinal: number) => Promise<void> } | undefined;
  /** Find opened from elsewhere — a message the palette found: in this conversation, with these words, at this item. A new `stamp` opens it again. */
  findRequest?: (FindTarget & { readonly sessionId: string; readonly stamp: number }) | null | undefined;
  /** The address of the open conversation's terminal, for a size in columns and rows; absent where the Gateway has none. */
  terminals?: TerminalAccess | undefined;
  /** What is done with the open conversation's workspace: an editor, a commit and a push, a file shown. */
  workspaceTools?: WorkspaceAccess | undefined;
  /** Reads where the open conversation works: its folder and its repository's branch and uncommitted files. */
  onLoadWorkspace?: ((signal: AbortSignal) => Promise<WorkspaceFacts>) | undefined;
  sidebarHidden: boolean; onExpandSidebar: () => void; onHarnesses: () => void;
  /** How many conversations exist; none means this is the first use and the welcome says what was found. */
  conversations: number; onSettings: () => void; onRescan: () => void; scanning: boolean;
  /** The relay (relay-architecture §12): omitted when the page has no relay data layer. */
  relay?: ChatRelay;
  /** Reads the page of Turns before the first one held; resolves when it is in. The reader goes back a page at a time as the top of the list comes into view. */
  onLoadOlder?: () => Promise<void>;
  /** What a Turn reads of itself when shown: the rest of words it holds in part, the middle of a long stretch of work. */
  reads?: TurnReads;
  /** Reads a page of the conversation's changes (the details panel's 改动 tab lists the whole conversation's). */
  onLoadChanges?: ChangesLoader;
  /** The board of the task the open conversation belongs to. */
  taskBoard?: TaskBoardAccess | undefined;
  /** Filled by the page for the composer. */
  contextUsage?: number | null; onShowResume?: (() => void) | undefined; onSendDraft?: (text: string) => Promise<void>;
}

/** The latest values the page's shortcuts act on, read when a key is pressed rather than bound into the listener. */
interface ShortcutState { readonly stop: (() => void) | null; readonly togglePanel: (() => void) | null; readonly openPicker: (() => void) | null; readonly openList: ((list: "model" | "thought" | "permission") => void) | null; readonly answer: (() => void) | null; readonly toggleTerminal: (() => void) | null; readonly find: (() => void) | null }
/** A local decision on an approval, kept until the page leaves the conversation, to write its result back into the Turn. */
type DecisionRecord = Decision & { readonly runId: string };

const PANEL_MIN = 360, PANEL_KEY = "harnesshub:panel-width", PANELS_KEY = "harnesshub:panels";
/** The width the user last dragged the details panel to in this browser, whichever conversation it was; null until they did. */
function readPanelWidth(): number | null {
  try { const value = Number(localStorage.getItem(PANEL_KEY)); return Number.isFinite(value) && value >= PANEL_MIN && value <= 4000 ? value : null; } catch { return null; }
}
function writePanelWidth(value: number | null): void { try { if (value === null) localStorage.removeItem(PANEL_KEY); else localStorage.setItem(PANEL_KEY, String(value)); } catch { /* lasts for this page only */ } }
/**
 * What the details panel was left as in each conversation (after the right panel of T3 Code, which keeps it by thread): the page it showed and the width it was dragged
 * to there. A convenience of this browser: without storage it lasts for the page only, and the latest few hundred conversations are enough to remember.
 */
interface PanelKept { readonly tab?: PanelTab; readonly width?: number }
const TABS: readonly PanelTab[] = ["overview", "changes", "process", "context"];
function readPanels(): Readonly<Record<string, PanelKept>> {
  try {
    const raw = localStorage.getItem(PANELS_KEY), value: unknown = raw === null || raw.length > 256 * 1024 ? null : JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, { tab?: unknown; width?: unknown }>).map(([id, kept]) => [id, {
      ...(TABS.includes(kept?.tab as PanelTab) ? { tab: kept.tab as PanelTab } : {}), ...(typeof kept?.width === "number" && kept.width >= PANEL_MIN && kept.width <= 4000 ? { width: kept.width } : {}) }]));
  } catch { return {}; }
}
function keepPanel(id: string, change: { readonly tab?: PanelTab; readonly width?: number | null }): void {
  const all = { ...readPanels() }, now: { tab?: PanelTab; width?: number } = { ...all[id] };
  if (change.tab !== undefined) now.tab = change.tab;
  if (change.width === null) delete now.width; else if (change.width !== undefined) now.width = change.width;
  delete all[id]; all[id] = now;
  try { localStorage.setItem(PANELS_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-300)))); } catch { /* lasts for this page only */ }
}

/**
 * The details panel's left edge, which is dragged to make it wider or narrower (after the right panel of T3 Code): a hairline that thickens under the pointer, the
 * arrow keys for the keyboard, and a double click back to the width it had before anyone dragged it. The width is kept when the drag ends, not on every move.
 */
function PanelEdge({ width, dragging, onDrag, onWidth }: { readonly width: number; readonly dragging: boolean; readonly onDrag: (on: boolean) => void; readonly onWidth: (width: number | null, keep: boolean) => void }) {
  const from = useRef<{ readonly x: number; readonly width: number } | null>(null), latest = useRef(width);
  latest.current = width;
  return <div role="separator" aria-orientation="vertical" aria-label="调整详情栏宽度" aria-valuenow={width} aria-valuemin={PANEL_MIN} tabIndex={0} title="拖动调整宽度，双击恢复"
    className={cn("panel-edge group/edge absolute inset-y-0 left-0 z-10 w-[7px] cursor-col-resize touch-none outline-none", dragging && "is-dragging")}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); from.current = { x: event.clientX, width }; onDrag(true); }}
    onPointerMove={event => { const start = from.current; if (start !== null) onWidth(start.width + start.x - event.clientX, false); }}
    onPointerUp={event => { if (from.current === null) return; from.current = null; event.currentTarget.releasePointerCapture(event.pointerId); onDrag(false); onWidth(latest.current, true); }}
    onPointerCancel={() => { from.current = null; onDrag(false); }}
    onDoubleClick={() => onWidth(null, true)}
    onKeyDown={event => { const step = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0; if (step !== 0) { event.preventDefault(); onWidth(width + step, true); } }}>
    <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent opacity-0 transition-opacity duration-120 ease-standard group-hover/edge:opacity-100 group-focus-visible/edge:opacity-100 group-[.is-dragging]/edge:opacity-100"/>
  </div>;
}

/**
 * The project's scripts, as its package.json lists them, each run with the project's own package manager: the one package.json names (`packageManager`), else the one
 * whose lockfile the project has, else npm. None where the workspace has no package.json.
 */
function projectScripts(file: NonNullable<WorkspaceAccess["file"]>): (signal: AbortSignal) => Promise<readonly ProjectScript[]> {
  return async signal => {
    const page = await file("package.json", 0, signal).catch(() => null);
    if (page === null || page.binary === true || typeof page.text !== "string") return [];
    let manifest: { readonly scripts?: unknown; readonly packageManager?: unknown };
    try { manifest = JSON.parse(page.text) as typeof manifest; } catch { return []; }
    const scripts = manifest.scripts !== null && typeof manifest.scripts === "object" ? Object.keys(manifest.scripts as Record<string, unknown>) : [];
    if (scripts.length === 0) return [];
    let manager = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] ?? "" : "";
    if (!["pnpm", "yarn", "bun", "npm"].includes(manager)) {
      manager = "npm";
      // npm's lockfile first: the commonest, and found with one read.
      for (const [lock, name] of [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]] as const) {
        if (await file(lock, 0, signal).then(() => true, () => false)) { manager = name; break; }
      }
    }
    return scripts.map(name => ({ name, command: manager === "yarn" ? "yarn " + name : manager + " run " + name }));
  };
}

/** The conversation's title as a field, in the title's place: Enter or leaving it keeps what was typed, Escape leaves the title as it was. */
function TitleField({ value, onDone }: { readonly value: string; readonly onDone: (next: string | null) => void }) {
  const [draft, setDraft] = useState(value), field = useRef<HTMLInputElement>(null), done = useRef(false);
  useLayoutEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const finish = (next: string | null) => { if (done.current) return; done.current = true; onDone(next); };
  return <input ref={field} className="title-field m-0 h-7 min-w-0 flex-1 rounded-row border-none bg-subtle px-1.5 text-ui font-medium text-fg shadow-focus outline-none" value={draft} aria-label="对话标题" maxLength={200}
    onChange={event => setDraft(event.target.value)} onBlur={() => finish(draft)}
    onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); finish(draft); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); } }}/>;
}

export function ChatPage(props: ChatProps) {
  useKeys();
  const { session, draft, harnesses, providers, mutation, error, preferences } = props;
  const [followBottom, setFollowBottom] = useState(true);
  const [dismissedSwitch, setDismissedSwitch] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false), [delegating, setDelegating] = useState(false);
  const [tab, setTab] = useState<PanelTab | null>(null);
  const [panelRun, setPanelRun] = useState<string | null>(null);
  // What the panel's overview brings into view: a Turn's facts, asked for from that Turn's own button; any other way into the panel asks for nothing.
  const [panelFocus, setPanelFocus] = useState<"run" | null>(null);
  const [changesWant, setChangesWant] = useState<ChangesWant | null>(null);
  // The terminal under the conversation: closed until asked for, and closed again when another conversation opens (its shell belongs to this one's workspace).
  const [terminal, setTerminal] = useState(false), [finding, setFinding] = useState(false), [findFrom, setFindFrom] = useState<{ readonly target: FindTarget; readonly stamp: number } | null>(null);
  useEffect(() => { setTerminal(false); setFinding(false); setFindFrom(null); }, [session?.id]);
  // Find opened by the palette's search, once the conversation it found is the one shown (after the effect above, which closes find as another opens).
  const findHandled = useRef<number | null>(null);
  useEffect(() => {
    const request = props.findRequest;
    if (!request || session?.id !== request.sessionId || findHandled.current === request.stamp) return;
    findHandled.current = request.stamp;
    setFindFrom({ target: { query: request.query, runId: request.runId, itemId: request.itemId }, stamp: request.stamp }); setFinding(true);
  }, [props.findRequest?.stamp, session?.id]);
  const [overlay, setOverlay] = useState(false);
  const [agentPicker, setAgentPicker] = useState(false);
  const [decisions, setDecisions] = useState<ReadonlyMap<string, DecisionRecord>>(() => new Map());
  // The packet whose text is open, by its identity (relay-architecture §12.1 T3).
  const [viewing, setViewing] = useState<string | null>(null);
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
  const latestSwitch = session?.lastSwitch;
  const failedSwitch = latestSwitch?.status === "failed" && latestSwitch.id !== dismissedSwitch && !session?.runs.some(run =>
    run.status === "completed" && run.userSeq > latestSwitch.requestedSeq) ? latestSwitch : null;
  const canRetry = session?.status === "open" && active === null && !dirty && !pending && problem === null && mutation === null;
  const canBranch = session !== null && session.activeRunId === null && session.pendingSwitchId === null && mutation === null;
  const branchedTitle = session?.origin?.history.find(message => message.role === "user")?.text;
  // A title the user just gave stands at once; the conversation's head brings the same one when the Gateway kept it.
  const [renaming, setRenaming] = useState<string | null>(null), [renamed, setRenamed] = useState<{ readonly id: string; readonly title: string } | null>(null);
  useEffect(() => { setRenaming(null); }, [session?.id]);
  useEffect(() => { if (renamed !== null && (session === null || session.id !== renamed.id || session.title === renamed.title)) setRenamed(null); }, [session?.id, session?.title, renamed]);
  const place = session === null ? "" : inScratch(session.workspace, props.scratchRoot) ? "临时对话" : folderName(session.workspace);
  const title = session !== null ? renamed?.id === session.id ? renamed.title : session.title : branchedTitle ? "分支 · " + branchedTitle : props.sessionRequested || props.sessionError ? "打开对话" : "新对话";
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
  // A Turn queues only for a slot, when an operator limited how many conversations run at once; conversations that share a workspace do not wait.
  const [cancellingQueue, setCancellingQueue] = useState<string | null>(null);
  const queue = session?.queue ?? null;
  const queueNotice = useMemo((): QueueNotice | undefined => {
    if (queue === null) return undefined;
    return { kind: "slot", running: queue.running, cancelling: cancellingQueue === queue.runId,
      onCancel: props.onCancelQueued ? () => { setCancellingQueue(queue.runId); void props.onCancelQueued!(queue.runId).finally(() => setCancellingQueue(null)); } : undefined };
  }, [queue, props.onCancelQueued, cancellingQueue]);

  const scrollToLatest = useCallback(() => {
    const element = scroll.current; if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    previousScrollTop.current = element.scrollTop; previousScrollHeight.current = element.scrollHeight;
  }, []);
  const resumeFollowing = useCallback(() => { following.current = true; setFollowBottom(true); scrollToLatest(); }, [scrollToLatest]);
  // The Turns before the first one held come a page at a time as the top of the list comes into view; the place the reader is looking at stays where it is while they come in above it.
  const olderCursor = session?.window.older ?? null, firstOrdinal = session?.runs[0]?.ordinal;
  const topMark = useRef<HTMLDivElement>(null), loadingOlder = useRef(false), keptPlace = useRef<{ readonly top: number; readonly height: number; readonly first: number | undefined } | null>(null);
  const firstOrdinalNow = useRef(firstOrdinal); firstOrdinalNow.current = firstOrdinal;
  const { onLoadOlder } = props;
  const loadOlder = useCallback(async () => {
    const element = scroll.current;
    if (onLoadOlder === undefined || element === null || loadingOlder.current) return;
    loadingOlder.current = true;
    keptPlace.current = { top: element.scrollTop, height: element.scrollHeight, first: firstOrdinalNow.current };
    try { await onLoadOlder(); } finally { loadingOlder.current = false; }
  }, [onLoadOlder]);
  useLayoutEffect(() => {
    const kept = keptPlace.current, element = scroll.current;
    if (kept === null || element === null || firstOrdinal === kept.first) return;
    keptPlace.current = null;
    element.scrollTop = kept.top + (element.scrollHeight - kept.height);
    previousScrollTop.current = element.scrollTop; previousScrollHeight.current = element.scrollHeight;
  }, [firstOrdinal]);
  useEffect(() => {
    const mark = topMark.current, root = scroll.current;
    if (!mark || !root || olderCursor === null || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadOlder(); }, { root, rootMargin: "400px 0px 0px 0px" });
    watch.observe(mark);
    return () => watch.disconnect();
  }, [olderCursor, loadOlder, firstOrdinal, session?.id]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { following.current = true; setFollowBottom(true); if (session) scrollToLatest(); else scroll.current?.scrollTo({ top: 0 }); setTab(null); setPanelRun(null); setPanelFocus(null); setChangesWant(null); setOverlay(false); setDecisions(new Map()); setViewing(null); }, [session?.id, scrollToLatest]);
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
  // A draft the user wrote is never lost to an action that fills the composer (放回输入框, a suggestion, 原生命令): for a
  // few seconds it can be put back, as long as the composer still holds what replaced it.
  // The draft is read through a ref, so the callback stays the same while the user types and memoised messages keep it.
  const toast = useToast(), draftNow = useRef(props.messageDraft);
  draftNow.current = props.messageDraft;
  const fillDraft = useCallback((text: string) => {
    const previous = draftNow.current;
    props.onMessageDraft(text); textarea.current?.focus();
    if (!previous.trim() || previous === text) return;
    const id = toast.show({ title: "已替换输入框里的草稿", action: { label: "撤销", onClick: () => { toast.close(id); props.onMessageDraft(value => value === text ? previous : value); textarea.current?.focus(); } } });
  }, [props.onMessageDraft, toast]);
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
    if (session.runCount > 0 || firstSend.id !== null && firstSend.id !== session.id) setFirstSend(null);
    else if (firstSend.id === null) setFirstSend({ id: session.id });
  }, [firstSend, session?.id, session?.runCount]);
  // A retry resends the original input with the attachments it was sent with; a new message takes the composer's.
  const send = async (text: string, retryAttachments?: readonly ContentRef[], relayChoice?: RelayRequest) => {
    // The first message moves the composer from the welcome to the foot of the new conversation; the focus goes with it.
    if (session === null && document.activeElement === textarea.current) refocus.current = true;
    const first = session === null || session.runCount === 0;
    if (first) setFirstSend({ id: session?.id ?? null });
    try { await props.onSend(text, retryAttachments, relayChoice); }
    catch (failure: unknown) { if (first && mounted.current) setFirstSend(null); throw failure; }
    if (mounted.current) { props.onMessageDraft(value => value === text ? "" : value); resumeFollowing(); }
  };
  // The relay: what the line above the box says, and the banner a binding asks the user to look at.
  const relay = props.relay;
  const closed = useClosedNotices();
  const viewPacket = useCallback((packetId: string) => setViewing(packetId), []);
  // The messages by identity, for the Turns the protocol draws: each reply and your message is found by the id its item names.
  const messagesById = useMemo(() => new Map((session?.messages ?? []).map(message => [message.id as string, message])), [session?.messages]);
  const messageOf = useCallback((id: string) => messagesById.get(id), [messagesById]);
  const arrived = useCallback((id: string) => !known.current.messages.has(id), []);
  const relayNow = useMemo(() => session && relay?.fresh ? relayLine(session, relay.view, relay.prefs) : null, [session, relay?.view, relay?.fresh, relay?.prefs]);
  // What a binding asks the user to look at, for the Harness the conversation is on, once the conversation is idle: said once, and a closed one
  // of the same episode (its key, with the conversation and the Harness) does not come back.
  const idle = session !== null && session.status === "open" && session.activeRunId === null && session.pendingSwitchId === null && session.runCount > 0 && session.facts.settled;
  const onBinding = session && relay?.view ? relay.view.bindings.find(item => item.harnessId === session.selection.harnessId && item.controlId === session.selection.controlId) : undefined;
  const closedKey = (key: string) => `${session?.id ?? ""}|${session?.selection.harnessId ?? ""}|${key}`;
  const banner = useMemo(() => idle && relay?.fresh && session ? bannerOf(onBinding, harnessName(session.selection.harnessId), key => closed.has(closedKey(key))) : null,
    [idle, relay?.fresh, onBinding, session?.id, session?.selection.harnessId, closed.has, harnesses]);
  // A choice for the next message alone is only meaningful where its words are shown: with them gone (another Harness, nothing owed any
  // more, the banner closed) it is put away, so a message never goes out under a choice the user can no longer see.
  const offered = banner?.key ?? (relayNow === null ? null : relayNow.off ? "off" : "owed");
  const nextFits = relay === undefined || relay.next === null || relay.next.for === offered;
  useEffect(() => { if (!nextFits) relay?.onNext(null); }, [nextFits]);
  // The latest message was refused because another conversation's kept process holds this workspace (ADR-030, option C).
  const refused = session?.runs.at(-1)?.status === "failed" && session.runs.at(-1)?.error?.code === "WORKSPACE_KEPT" ? session.runs.at(-1)! : null;
  const [freeing, setFreeing] = useState(false);
  // Panel: beside the conversation on wide screens, otherwise a drawer or a bottom sheet, always on demand. It stays closed
  // until opened, changes or not (decision E: the button carries the number); on wide screens an opening or closing is
  // remembered by this browser.
  const inline = wide && session !== null;
  const panelOpen = session !== null && (inline ? preferences.panel : overlay);
  const [panelWidth, setPanelWidth] = useState(readPanelWidth), [dragging, setDragging] = useState(false), row = useRef<HTMLDivElement>(null);
  // As wide as it was dragged to, within what the row has: the conversation keeps 360 px, the panel is never under 360 px nor over seven tenths of the row.
  const fit = useCallback((width: number): number => { const room = row.current?.clientWidth ?? window.innerWidth; return Math.round(Math.max(PANEL_MIN, Math.min(width, room - 360, room * .7))); }, []);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setRowWidth(element.clientWidth));
    watch.observe(element); return () => watch.disconnect();
  }, []);
  const shownWidth = useMemo(() => fit(panelWidth ?? (window.innerWidth >= 1440 ? 420 : 400)), [fit, panelWidth, rowWidth]);
  const resize = (width: number | null, keep: boolean) => { const next = width === null ? null : fit(width); setPanelWidth(next); if (keep) { writePanelWidth(next); if (session) keepPanel(session.id, { width: next }); } };
  // A conversation opens its panel as it was left there: the page it showed and its width; one never touched has the width last dragged anywhere.
  useLayoutEffect(() => { if (session === null) return; const kept = readPanels()[session.id]; setPanelWidth(kept?.width ?? readPanelWidth()); setTab(kept?.tab ?? null); }, [session?.id]);
  // A remark on some lines of a diff is put into the message box with the lines it is about, after what is already written there: it goes with the next message.
  const remark = useCallback((value: DiffRemark) => {
    const where = "关于 `" + value.path + "` " + (value.side === "old" ? "改动前的" : "") + (value.from === value.to ? "第 " + value.from + " 行" : "第 " + value.from + "–" + value.to + " 行") + "：";
    const block = where + "\n```diff\n" + value.quoted + "\n```\n" + value.remark + "\n";
    props.onMessageDraft(draft => draft.trim() === "" ? block : draft.replace(/\n*$/u, "\n\n") + block);
    requestAnimationFrame(() => { const field = textarea.current; if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); } });
  }, [props.onMessageDraft]);
  const chooseTab = (value: PanelTab) => { setTab(value); setPanelFocus(null); if (session) keepPanel(session.id, { tab: value }); };
  // How many changes the conversation made, from the tools' summaries: the button, its 改动 tab and the tab's scopes say this
  // one number, and nothing is read while the panel is closed.
  const changes = session?.facts.changes ?? 0;
  // The number comes in as news only (ADR-054 §3): when changes arrive while the conversation is shown. Drawn with the
  // conversation, or back on the button because the panel closed (from the keyboard as well, #37), it is simply there.
  const shownChanges = useRef<{ id: string | null; count: number }>({ id: null, count: 0 });
  const changesArrived = session !== null && shownChanges.current.id === session.id && changes > shownChanges.current.count;
  useLayoutEffect(() => { shownChanges.current = { id: session?.id ?? null, count: changes }; });
  const panelTab: PanelTab = tab ?? "overview";
  // Opened from the keyboard (⌘\), the panel's content does not slide in (#37). Decided once per opening: an animation
  // that followed the live input mode would start over whenever the next input came from the pointer.
  const [panelFromKeyboard, setPanelFromKeyboard] = useState(false);
  const setPanel = (open: boolean) => { if (open && !panelOpen) setPanelFromKeyboard(document.documentElement.dataset.input === "keyboard"); if (inline) props.onPreference("panel", open); else setOverlay(open); };
  const openDetails = (runId: string) => {
    if (panelOpen && panelTab === "overview" && panelFocus === "run" && (panelRun ?? session?.runs.at(-1)?.id) === runId) { setPanel(false); return; }
    setPanelRun(runId); setTab("overview"); setPanelFocus("run"); setPanel(true);
  };
  // From a Turn's card of changed files: the panel's Changes page at that Turn, and at one file of it when a file was chosen.
  const openChanges = (runId: string, path?: string) => {
    setPanelRun(runId); setTab("changes"); setPanelFocus(null); setChangesWant({ scope: "turn", ...(path === undefined ? {} : { path }), at: Date.now() }); setPanel(true);
  };
  const detailed = preferences.density === "detailed", quiet = preferences.density === "failures" || preferences.density === "answer" ? preferences.density : undefined;
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
    // The unified permission level the Turn ran with, when its selection named one; else the program's own rule by its own name.
    const unified = selectionLevels(run?.selection.nativeOptions).permission;
    if (unified !== undefined) return PERMISSION_WORDS[unified];
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
    // A decision is written by the Turn itself (the approval item's own line, when it is a refusal or a standing permission), so nothing is added here.
    const cards = requests.filter(request => !dockedRequest(request)).map(request => <PermissionCard key={request.id} request={request} harness={requestHarness(request)} busy={mutation !== null} onDecision={(option, input) => decide(request, option, input)}/>);
    return cards.length ? <>{cards}</> : null;
  };
  const orphanCards = (session?.permissions ?? []).filter(request => !runs.has(request.runId as never) && !dockedRequest(request))
    .map(request => <PermissionCard key={request.id} request={request} harness={requestHarness(request)} busy={mutation !== null} onDecision={(option, input) => decide(request, option, input)}/>);
  /**
   * The transcript, one flat list of keyed parts: each Run's Turn, drawn once and keyed by its Run. A Turn draws its own hand-over
   * line, your message and everything the Harness did from its protocol items, in the order they came, so that the Turn never remounts as
   * its reply starts: its status, timer and arc carry on. The Runtime creates the reply's message when its first text is committed;
   * the Turn finds it by the Run's `assistantMessageId`.
   */
  const delegated = props.delegations ?? [], loadDelegation = props.onLoadDelegation;
  const delegationCards = (items: readonly SessionSummary[], key: string): ReactNode => items.length === 0 || loadDelegation === undefined || session === null ? null
    : <DelegationCards key={key} items={items} harness={harnessName} load={loadDelegation} onOpen={id => props.onOpenSession?.(id)} onReport={answer} reportTo={harnessName(session.selection.harnessId)} busy={answerBlocked !== null}
      told={(id, runId) => { const entry = session.delegationsTold?.[id]; if (entry === undefined || entry.runId !== runId) return false;
        // Told with a Turn that did not go through is told again with the next one.
        const by = session.runs.find(run => run.id === entry.by); return by === undefined || by.status === "completed" || !finished(by.status); }}/>;
  const transcriptItems = (current: ConversationView): ReactNode[] => current.runs.flatMap(run => {
    const open = (current.permissions ?? []).filter(request => request.runId === run.id && !request.decided);
    return [<ProtocolTurn key={"turn:" + run.id} run={run} message={messageOf} arrived={arrived} detailed={detailed} onEdit={fillDraft}
      onRetry={canRetry ? (text, sent) => { void (props.onBranchSend ? props.onBranchSend(run.id, text, sent ?? []) : send(text, sent ?? [])).catch(() => {}); } : undefined} loadToolDetail={props.onToolDetail} onBranch={canBranch ? props.onBranch : undefined}
      onResend={props.onBranchSend && session?.status === "open" ? (runId, text, sent) => { void props.onBranchSend!(runId, text, sent ?? []).catch(() => {}); } : undefined}
      restore={props.restore && session?.status === "open" ? turnRun => { const ordinal = runs.get(turnRun.id)?.ordinal; return ordinal === undefined ? undefined : { check: signal => props.restore!.can(ordinal, signal), run: () => props.restore!.run(ordinal) }; } : undefined}
      onSelectBranch={props.onSelectBranch ? runId => { void props.onSelectBranch!(runId).catch(() => {}); } : undefined} branchBusy={!canRetry}
      onDetails={openDetails} detailsOpen={panelOpen && panelTab === "overview" && panelFocus === "run" && (panelRun ?? current.runs.at(-1)?.id) === run.id} onViewPacket={relay ? viewPacket : undefined} reads={props.reads} workspace={current.workspace} onOpenChanges={openChanges} quiet={quiet}
      startupHint={startupHints.get(run.id)} queue={queue?.runId === run.id ? queueNotice : undefined}
      waiting={open.length ? open.some(request => dockedRequest(request)) ? "approval" : "question" : undefined}>{turnRequests(run.id)}</ProtocolTurn>,
      // What was handed to another Harness after this Turn stands right after it.
      delegationCards(delegated.filter(item => item.parent?.afterRunId === run.id).reverse(), "delegated:" + run.id)];
  });

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

  // The wrap-up the latest Turn gave (`hub_wrap_up`), while nothing came after it: once you send a message, or press one of its answers, it goes. A Turn that gave none shows none.
  const latest = session?.runs.at(-1), nextStep = session?.recap !== undefined && latest !== undefined && latest.id === session.recap.runId && active === null && session.status === "open"
    && latest.protocol !== undefined && over(latest.protocol) && (session.recap.ask || session.recap.actions?.length) ? session.recap : null;
  // Why its answers cannot be sent now (they are a message like any other): the Harness's own problem first, then what the conversation is in the middle of.
  const answerBlocked = canRetry ? null : problem ?? (pending ? "Harness 正在切换，切换完成后再选。" : dirty ? "Harness 的选择改了还没应用：先应用，或直接在输入框里回复。"
    : mutation !== null ? "正在处理上一个操作，完成后再选。" : "现在不能发送消息。");
  const answer = (text: string) => { void send(text).catch(() => {}); };

  // ⌘J opens the Agent list, ⌘. stops the reply, ⌘\ opens or closes the details (ADR-054 §5); ⌘⏎ with an empty message box presses the
  // next-step box's first answer. The page's own listener runs first and keeps these keys, so none of them reaches another binding while the conversation is shown.
  const shortcuts = useRef<ShortcutState>({ stop: null, togglePanel: null, openPicker: null, openList: null, answer: null, toggleTerminal: null, find: null });
  // A list of the message box opened by its keys (the model, the thinking level, the permission): asked for by a new stamp.
  const [openList, setOpenList] = useState<{ readonly list: "model" | "thought" | "permission"; readonly at: number } | null>(null);
  const firstAnswer = nextStep?.actions?.[0];
  shortcuts.current = {
    stop: active && !active.cancelRequested && mutation === null ? props.onCancel : null,
    togglePanel: session ? () => setPanel(!panelOpen) : null,
    toggleTerminal: session && props.terminals ? () => setTerminal(value => !value) : null,
    find: session && props.find ? () => setFinding(true) : null,
    openPicker: docked === null && !props.loading && props.sessionError === null && session?.status !== "closed" && (mutation === null || mutation === "switching") ? () => setAgentPicker(true) : null,
    openList: docked === null && !props.loading && props.sessionError === null && session?.status !== "closed" && (mutation === null || mutation === "switching") ? list => setOpenList({ list, at: Date.now() }) : null,
    answer: firstAnswer !== undefined && answerBlocked === null && props.messageDraft.trim() === "" ? () => answer(firstAnswer) : null,
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.metaKey || event.ctrlKey)) return;
      // The conversation's own shortcuts, by the keys chosen now (lib/keys.ts); ⌘⏎, the first answer of the next-step box, is not one that is given other keys.
      const action = actionOf(event), key = action === "stop" || action === "panel" || action === "picker" || action === "model" || action === "effort" || action === "permission" || action === "terminal" || action === "find" ? action : !event.altKey && !event.shiftKey && event.key === "Enter" ? "answer" : null;
      if (key === null) return;
      // A dialog (a confirmation, the palette) keeps its own keys; toasts are dialogs that never take them.
      if (event.target instanceof Element && event.target.closest("[role='dialog']:not(.toast)")) return;
      const current = shortcuts.current;
      // ⌘⏎ with nothing to answer, or with words in the box, is the box's own (it sends them).
      if (key === "answer" && current.answer === null) return;
      // Find where it is offered; elsewhere ⌘F stays the browser's own.
      if (key === "find" && current.find === null) return;
      event.preventDefault(); event.stopPropagation();
      if (key === "stop") current.stop?.(); else if (key === "panel") current.togglePanel?.(); else if (key === "answer") current.answer?.(); else if (key === "terminal") current.toggleTerminal?.(); else if (key === "find") current.find?.();
      else if (key === "model" || key === "effort" || key === "permission") current.openList?.(key === "effort" ? "thought" : key); else current.openPicker?.();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // The choice to send the next message without the earlier conversation lives in the message box's "+" menu, in the one case the line
  // above the box offers it: something is owed, no banner is up, and the setting does not already send the words alone.
  const sendAlone = relay && banner === null && relayNow !== null && !relayNow.off ? (() => {
    const checked = relay.next?.option === SEND_ALONE.option && relay.next.for === SEND_ALONE.for;
    return { checked, onToggle: () => relay.onNext(checked ? null : SEND_ALONE) };
  })() : undefined;
  const composer = <Composer {...props} sendAlone={sendAlone} onSendDraft={text => send(text)} active={active} dirty={dirty} pending={pending} problem={problem} blocked={blocked} inputRef={textarea}
    onOpenDelegate={props.onDelegate && session?.status === "open" ? () => setDelegating(true) : undefined} approval={approval} agentPickerOpen={agentPicker} onAgentPickerOpen={setAgentPicker} openList={openList} onEditLast={editLast} onReplaceDraft={fillDraft}
    above={session ? <>
      {relay ? <RelayCard line={relayNow} banner={banner} target={harnessName(session.selection.harnessId)} next={relay.next} onNext={relay.onNext}
        onDismissBanner={() => { if (banner !== null) closed.add(closedKey(banner.key)); }}/> : null}
      {props.queued ? <div className="queued-message motion-fade-in flex items-center gap-2.5 rounded-block bg-subtle py-1.5 pr-1.5 pl-3 text-ui-sm" role="status">
        <CircleDashed size={15} className="flex-none text-fg-3" aria-hidden="true"/>
        <span className="flex-none text-caption text-fg-3">将在本轮结束后发送</span><span className="min-w-0 flex-1 truncate" title={props.queued.text}>{props.queued.text}</span>
        {props.queued.attachments.length ? <span className="flex-none text-caption text-fg-3">附件 {props.queued.attachments.length}</span> : null}
        {props.onSteerQueued && props.queued.attachments.length === 0 ? <button type="button" className="btn btn-ghost btn-sm" onClick={props.onSteerQueued}>现在就告诉它</button> : null}
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onEditQueued}>编辑</button><button type="button" className="btn btn-ghost btn-sm" onClick={props.onWithdrawQueued}>撤回</button>
      </div> : null}
      {nextStep ? <NextStep recap={nextStep} harness={harnessName(nextStep.harnessId)} blocked={answerBlocked} onAnswer={answer}/> : <PlanBar session={session} active={active} harness={harnessName}/>}
    </> : null}
    below={session ? <StatusLine session={session} active={active}/> : null}/>;
  // What the page announces of the Turn in progress, or of one waiting in the queue (never the active Run), in the header's
  // words for the same state: the two waits as 等你批准 and 等你回答 (decision G), a Turn not started yet as 排队中 (ruling N).
  const latestRun = session?.runs.at(-1), current = active ?? (latestRun?.status === "queued" ? latestRun : null);
  const currentWaits = current ? (session?.permissions ?? []).filter(request => request.runId === current.id && !request.decided) : [];
  const currentState = current === null ? null : current.cancelRequested ? "正在停止回复" : currentWaits.length ? currentWaits.some(dockedRequest) ? "等你批准" : "等你回答"
    : TURN_STATUS_WORDS[stateOf(current)];
  const status = props.loading ? "正在读取对话" : props.sessionError ? "对话读取失败" : session?.status === "blocked" ? "执行暂时暂停，可以编辑草稿和检查恢复连接" : session?.status === "closed" ? "对话已关闭，可查看历史"
    : currentState ?? (pending ? "等待选择切换生效" : session ? "可以继续对话" : "选择执行者后开始新对话");
  const panel = session ? <DetailsPanel session={session} harnesses={harnesses} providers={providers} loadChanges={props.onLoadChanges} tab={panelTab} onTab={chooseTab} runId={panelRun} onRun={setPanelRun} onOpenSession={props.onOpenSession} focus={panelFocus} want={changesWant} onReveal={props.onReveal} loadWorkspace={props.onLoadWorkspace} onRemark={session.status === "open" ? remark : undefined} tools={props.workspaceTools} git={props.git} onSaid={(words, link) => toast.show({ title: words, ...(link ? { action: { label: "打开", onClick: () => { window.open(link, "_blank", "noopener,noreferrer"); } } } : {}) })}
    loadToolDetail={props.onToolDetail} loadDiagnostics={props.onDiagnostics} onEndProcess={props.onEndProcess} busy={mutation !== null} onClose={() => setPanel(false)} board={props.taskBoard}
    relay={relay?.view && relayHasStory(relay.view) ? { view: relay.view, onViewPacket: viewPacket } : undefined}/> : null;
  // #23: the panel opens by widening (300 ms) and pushes the conversation aside; its content follows 60 ms later from 24 px to
  // the right; it closes in 200 ms. From the keyboard (⌘\) it opens and closes at once.
  const asidePresence = usePresence(inline && panelOpen, 300, 200);
  const exportBase = session ? `/api/v1/sessions/${encodeURIComponent(session.id)}/export?format=` : "";
  const viewedFacts = viewing === null ? null : relay?.view?.packets.find(item => item.packetId === viewing) ?? null;
  const viewedPacket: PacketTarget | null = viewing === null ? null : { packetId: viewing, number: viewedFacts?.number ?? null, facts: viewedFacts };

  return <section className="chat-page flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-labelledby="chat-title">
    {/* The header of the Conversation board: 54 px on a hairline, its parts 10 px apart (closer on a phone). */}
    <header className={cn("flex h-[54px] flex-none items-center gap-2 bg-app pr-3 pl-3 sm:gap-2.5", session ? "hairline-b sm:pl-6" : "sm:pl-4")}>
      {narrow ? <button type="button" className="icon-btn navigation-toggle" onClick={props.onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
        : props.sidebarHidden ? <Tip label={"展开侧栏 " + keyText("sidebar")}><button type="button" className="icon-btn" aria-label="展开侧栏" aria-keyshortcuts={ariaKeys("sidebar")} onClick={props.onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null}
      {/* Where the conversation runs, then what it is called (after the header of T3 Code): the folder quiet, the title plain, one line. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {session ? <>{props.onReveal ? <Tip label={<>在访达中显示 <span className="text-fg-3">{homePath(session.workspace)}</span></>}><button type="button" className="crumb hidden max-w-[34%] min-w-0 flex-none truncate rounded-row border-none bg-transparent px-1.5 py-1 text-ui text-fg-3 transition-colors duration-120 ease-standard hover:bg-subtle hover:text-fg-2 sm:block" onClick={() => props.onReveal?.()}>{place}</button></Tip>
          : <span className="hidden max-w-[34%] min-w-0 flex-none truncate px-1.5 text-ui text-fg-3 sm:block" title={session.workspace}>{place}</span>}
          <span className="hidden flex-none text-ui text-fg-3 opacity-50 sm:block" aria-hidden="true">/</span></> : null}
        {renaming !== null && session ? <TitleField value={renaming} onDone={next => { setRenaming(null); const text = next?.trim().replace(/\s+/gu, " "); if (text && text !== session.title) { setRenamed({ id: session.id, title: text }); props.onRename?.(text).catch(() => setRenamed(null)); } }}/> : null}
        <h1 ref={heading} id="chat-title" tabIndex={-1} className={cn("m-0 min-w-0 truncate rounded-row px-1.5 py-1 text-ui font-medium outline-none", !session && "sr-only", renaming !== null && "sr-only", session && props.onRename && "cursor-text")} title={props.onRename && session ? "双击改名" : title}
          onDoubleClick={session && props.onRename ? () => setRenaming(title) : undefined}>{title}{session && session.status !== "open" ? <span className="ml-2 text-caption font-normal text-fg-3">{session.status === "closed" ? "已结束" : "需要核实"}</span> : null}</h1>
      </div>
      {session ? <>
        <HeaderState session={session} active={active} harnessName={harnessName}/>
        {/* The Conversation board's header ends with the details button and "…": showing every step and ending the conversation
            are items of that menu (rulings R1, R3), so they are there at every width. */}
        <div className="flex items-center gap-0.5 sm:gap-2.5">
          {props.terminals ? <Tip label={<>{terminal ? "收起终端" : "打开终端"}（{keyText("terminal")}）</>}><button type="button" className="icon-btn max-sm:hidden" aria-label="终端" aria-pressed={terminal} onClick={() => setTerminal(value => !value)}><SquareTerminal size={16}/></button></Tip> : null}
          <Tip label={<>{panelOpen ? "收起详情" : "打开详情"}（{keyText("panel")}）</>}><button type="button" className="icon-btn relative" aria-label="详情栏" aria-pressed={panelOpen} aria-describedby={changes ? "details-changes" : undefined} onClick={() => setPanel(!panelOpen)}>
            <PanelRight size={16}/>{!panelOpen && changes ? <ChangeBadge count={changes} news={changesArrived}/> : null}
          </button></Tip>
          {changes ? <span id="details-changes" className="sr-only">本对话改动 {changes} 处</span> : null}
          <Menu align="end" trigger={<button type="button" className="icon-btn" aria-label="更多操作" title="更多操作"><MoreHorizontal size={16}/></button>} items={[
            ...(props.onDelegate ? [{ label: "委派给另一个 Harness…", icon: <Split size={14}/>, disabled: session.status !== "open", onSelect: () => setDelegating(true) }] : []),
            { label: "从最新回复分支", icon: <GitBranch size={14}/>, disabled: !canBranch || !props.onBranch || session.facts.branchable === null, onSelect: () => { const last = session.facts.branchable; if (last !== null) props.onBranch?.(last.runId); } },
            { separator: true },
            { label: panelOpen ? "收起详情" : "打开详情", icon: <PanelRight size={14}/>, hint: keyText("panel"), onSelect: () => setPanel(!panelOpen) },
            ...(props.terminals ? [{ label: terminal ? "收起终端" : "打开终端", icon: <SquareTerminal size={14}/>, hint: keyText("terminal"), onSelect: () => setTerminal(value => !value) }] : []),
            // Checked is the detailed density: every Turn's steps open. This browser keeps it, as the setting does (ruling R1).
            { label: "显示每一步", icon: <ListTree size={14}/>, checked: detailed, onSelect: () => props.onPreference("density", detailed ? "compact" : "detailed") },
            { separator: true },
            { label: "导出 Markdown", icon: <FileDown size={14}/>, href: exportBase + "markdown", download: true },
            { label: "导出 JSON", icon: <FileDown size={14}/>, href: exportBase + "json", download: true },
            { separator: true },
            // The one way to end the conversation (ruling R3); the confirmation below is unchanged.
            { label: "结束对话…", icon: <X size={14}/>, description: "结束会话，保留历史", danger: true, disabled: session.status === "closed" || mutation !== null, onSelect: () => setConfirmClose(true) },
          ]}/>
        </div>
      </> : null}
    </header>
    <div className="flex flex-col gap-2 empty:hidden">
      {error ? <div className="chat-error px-4 pt-3 sm:px-8"><Notice tone="red" onDismiss={props.onDismissError} className="mx-auto max-w-reading">{error}</Notice></div> : null}
      {props.connectionError ? <div className="px-4 pt-3 sm:px-8"><Notice tone="amber" className="connection-notice mx-auto max-w-reading" action={props.onRetryConnection ? <button type="button" className="btn btn-sm" onClick={props.onRetryConnection}>重新连接</button> : undefined}>{props.connectionError}</Notice></div> : null}
      {session && relay?.view ? installationNotices(relay.view.installation).map(notice => <div key={notice.cause} className="px-4 pt-3 sm:px-8"><RelayInstallation notice={notice}/></div>) : null}
      {failedSwitch && session?.status === "open" ? <div className="px-4 pt-3 sm:px-8"><Notice tone="red" className="selection-failure mx-auto max-w-reading" title={`未能切换到 ${harnessName(failedSwitch.requested.harnessId)}`}
        action={<button className="btn btn-sm" type="button" disabled={mutation !== null || pending} onClick={() => { props.onDraft(selectionDraft(session.selection)); setDismissedSwitch(failedSwitch.id); }}>继续使用当前选择</button>}>
        {failedSwitch.error ? failureMessage(failedSwitch.error) : "目标连接没有通过验证。"} 当前选择仍是 {harnessName(session.selection.harnessId)}。</Notice></div> : null}
    </div>
    <div ref={row} className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {finding && session && props.find ? <FindBar key={session.id + ":" + (findFrom?.stamp ?? 0)} access={props.find} initial={findFrom?.target} onClose={() => { setFinding(false); setFindFrom(null); }}
          scroller={() => scroll.current} textOf={id => messageOf(id)?.text} messageAt={(hit: FindHit) => {
            // The page's message an item of a held Turn draws: your words and the replies are found by the message id their item names.
            const run = runs.get(hit.runId as Parameters<typeof runs.get>[0]) as { readonly protocol?: { readonly items: readonly { readonly seq: number; readonly type: string; readonly messageId?: unknown }[] } } | undefined;
            const item = run?.protocol?.items.find(entry => entry.seq === hit.itemSeq);
            return item !== undefined && (item.type === "user_message" || item.type === "assistant_message") && typeof item.messageId === "string" ? item.messageId : undefined;
          }}/> : null}
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
            : session === null ? <Welcome harnesses={harnesses.filter(harness => !props.hiddenHarnesses.has(harness.id))} readiness={props.readiness ?? []} place={props.place} onPlace={props.onPlace}
              recents={props.recentFolders} chooseFolder={props.onChooseFolder} onHarnesses={props.onHarnesses} composer={composer}/>
            : <div className="transcript mx-auto flex max-w-reading flex-col gap-7 pb-4" ref={transcript} role="log" aria-label="对话历史" aria-live="off">
              {olderCursor !== null ? <div ref={topMark} className="older-turns flex justify-center"><button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadOlder()}>加载更早的对话</button></div> : null}
              {session.origin && olderCursor === null ? <BranchOrigin origin={session.origin} session={session} harnesses={harnesses} onOpenSource={props.onOpenSession} delegated={session.parent !== undefined}/> : null}
              {/* A first message sent from the home opens its conversation empty for a moment: it is not shown as ready meanwhile. */}
              {session.runCount === 0 && !session.origin && mutation !== "sending" && !(firstSend !== null && (firstSend.id === null || firstSend.id === session.id))
                ? <EmptyState title="对话准备好了">发出第一条消息，开始这次协作。</EmptyState> : null}
              {/* Handed over before any Turn had finished, or after a Turn the page does not hold (every Turn is held: it was one of another branch). */}
              {olderCursor === null ? delegationCards(delegated.filter(item => item.parent?.afterRunId == null || !session.runs.some(run => run.id === item.parent?.afterRunId)).reverse(), "delegated:first") : null}
              {transcriptItems(session)}
              {orphanCards.length ? orphanCards : null}
            </div>}
        </div>
        {session !== null && !props.loading ? <footer className="relative flex-none px-4 pt-1.5 pb-4 sm:px-8 sm:pb-3.5"><div className="mx-auto flex max-w-reading flex-col gap-2">
          {!followBottom ? <button type="button" className="follow-stream motion-enter press absolute -top-11 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border-none bg-surface pr-3 pl-3.5 text-caption font-medium text-fg-2 shadow-pop transition-[color,background-color,transform] duration-120 ease-standard hover:text-fg"
            style={motionStyle({ shift: 6 })} onClick={resumeFollowing} aria-label="回到最新回复"><span>回到最新</span><ArrowDown size={13} aria-hidden="true"/></button> : null}
          {props.queueNotice ? <Notice tone="amber" onDismiss={props.onDismissQueueNotice}>{props.queueNotice}</Notice> : null}
          {refused && props.onFreeWorkspace ? <Notice tone="amber" className="kept-conflict" title="工作区正被另一个对话占用" action={<button type="button" className="btn btn-sm" disabled={freeing || mutation !== null} onClick={() => { setFreeing(true); void props.onFreeWorkspace!(refused).finally(() => setFreeing(false)); }}>{freeing ? "正在结束…" : "结束那个对话的后台进程并重试"}</button>}>那个对话的后台进程还在：结束它再重试，或稍后再试。</Notice> : null}
          {composer}
        </div></footer> : null}
        {session && terminal && props.terminals ? <TerminalDrawer key={session.id} session={session.id} place={inScratch(session.workspace, props.scratchRoot) ? "临时对话" : homePath(session.workspace)} access={props.terminals} onClose={() => setTerminal(false)}
          onQuote={text => { props.onMessageDraft(value => (value.trim() ? value.replace(/\s+$/u, "") + "\n\n" : "") + "```\n" + text.replace(/\s+$/u, "") + "\n```\n"); textarea.current?.focus(); }}
          {...(props.workspaceTools?.file ? { scripts: projectScripts(props.workspaceTools.file) } : {})}/> : null}
      </div>
      {inline && asidePresence !== "closed" ? <aside className={cn("details-aside relative flex-none overflow-hidden bg-app hairline-l ease-panel keyboard:duration-0", dragging ? "transition-none" : "transition-[width]",
        panelOpen ? "w-(--panel-width) duration-300 starting:w-0" : "w-0 duration-200")} style={{ "--panel-width": shownWidth + "px" } as CSSProperties} aria-label="详情栏" aria-hidden={!panelOpen || undefined} inert={!panelOpen}>
        <div className={cn("flex h-full w-(--panel-width)", !panelFromKeyboard && "motion-panel-in")}>{panel}</div>
        <PanelEdge width={shownWidth} dragging={dragging} onDrag={setDragging} onWidth={resize}/>
      </aside> : null}
    </div>
    {!inline && session ? <Dialog open={overlay} onOpenChange={setOverlay} title="详情栏" kind={narrow ? "sheet" : "drawer"} className={narrow ? "h-[80dvh]" : ""}><aside className="flex min-h-0 flex-1 flex-col" aria-label="详情栏">{panel}</aside></Dialog> : null}
    <div className="sr-only" role="status" aria-live="polite">{status}</div>
    {session && relay ? <RelayPacketDialog api={relay.api} sessionId={session.id} packet={viewedPacket} onClose={() => setViewing(null)} name={harnessName}/> : null}
    {props.onDelegate && session ? <DelegateDialog open={delegating} onClose={() => setDelegating(false)} current={session.selection.harnessId} onDelegate={props.onDelegate}
      harnesses={harnesses.filter(harness => !props.hiddenHarnesses.has(harness.id) && harness.controls.some(control => control.available))}/> : null}
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
 * words the sidebar and the Turn use, from the Turn's own state. Running work is blue with a breathing dot and a clock; waiting for the user
 * is amber; a failure is red; a Turn that ended quietly is grey: "已停止", whoever stopped it (the Turn's own line says whose). A Turn
 * waiting in the queue is not the active Run (only a started one is), and is named 排队中 as the Turn names it (ruling N).
 */
function HeaderState({ session, active, harnessName }: { readonly session: ConversationView; readonly active: PublicRun | null; readonly harnessName: (id: string) => string }) {
  const latest = active ?? session.runs.at(-1) ?? null;
  // Who works is the Turn's executor; a Run whose Turn could not be read is named by the selection it was sent with.
  const name = latest?.protocol?.executor.harness ?? harnessName((latest ?? session).selection.harnessId);
  const state: { readonly text: string; readonly tone: "neutral" | "accent" | "amber" | "red"; readonly live?: boolean } = (() => {
    if (active) {
      const open = session.permissions?.filter(request => request.runId === active.id && !request.decided) ?? [];
      // Work going on is said where it happens (the Turn's own line, the sidebar's dot); an approval where it is answered.
      if (active.cancelRequested) return { text: "正在停止", tone: "neutral" };
      return { text: open.length === 0 && stateOf(active) === "queued" ? TURN_STATUS_WORDS.queued : "", tone: "neutral" };
    }
    if (!latest) return { text: "", tone: "neutral" };
    const status = stateOf(latest);
    switch (status) {
      case "queued": return { text: latest.cancelRequested ? "正在停止" : TURN_STATUS_WORDS.queued, tone: "neutral" };
      case "completed": case "cancelled": return { text: "", tone: "neutral" };
      case "failed": return { text: TURN_STATUS_WORDS.failed, tone: "red" };
      case "unknown": return { text: TURN_STATUS_WORDS.unknown, tone: "amber" };
      default: return { text: "", tone: "neutral" };
    }
  })();
  if (!state.text) return null;
  return <StatusPill tone={state.tone} live={state.live ?? false} size="lg" className="hidden max-w-[260px] min-w-0 sm:inline-flex" title={`${name} ${state.text}`}>
    <span className="min-w-0 truncate">{name} {state.text}</span>
  </StatusPill>;
}

/**
 * The plan bar above the composer (P01, Motion board #22): the conversation's latest task list — a Harness's own, or the one it gave with the Hub's `hub_update_plan` — as
 * the head tells it (the Turns the page holds may not reach it). One line, "3/7 · 正在：…", that opens every step, the arrow turning 180°; the step in progress stands out and
 * the finished ones are struck through. Not shown when every step is done, or when no Turn has a list.
 */
function PlanBar({ session, active, harness }: { readonly session: ConversationView; readonly active: PublicRun | null; readonly harness: (id: string) => string }) {
  const [open, setOpen] = useState(false), [unfolded, setUnfolded] = useState(false);
  const id = useId();
  const found = shownPlan(session.runs, session.plan);
  if (found === undefined || found.steps.length === 0 || found.steps.every(step => step.status === "completed")) return null;
  // A list is the latest Turn's or it is history: one a later Turn left behind is not what is being done now.
  if (found.runId !== (active ?? session.runs.at(-1))?.id) return null;
  // Nothing is in progress once the Turn has ended: the step it stopped at is the next one.
  const working = active !== null;
  const steps = found.steps, done = steps.filter(step => step.status === "completed").length, total = steps.length;
  const current = steps.find(step => step.status === "in_progress") ?? steps.find(step => step.status === "pending");
  const where = current ? `${working && current.status === "in_progress" ? "正在" : "下一步"}：${current.text}` : "已完成";
  // The 8 px between the bar and its steps belongs to the steps, so a closed plan leaves no gap above the composer.
  return <div className="plan-bar flex flex-col">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}
      className="card card-interactive flex h-10 w-full items-center gap-[9px] border-none px-4 text-left text-ui-sm outline-offset-2">
      <ListChecks size={15} className="flex-none text-fg-2" aria-hidden="true"/>
      <span className="flex-none font-medium">任务清单</span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{done}/{total} · {where}</span>
      <span className="relative h-1 w-[72px] flex-none overflow-hidden rounded-[2px] bg-hover max-sm:hidden" aria-hidden="true">
        <span className="absolute inset-0 origin-left rounded-[2px] bg-run transition-transform duration-200 ease-standard" style={{ transform: `scaleX(${total ? done / total : 0})` }}/></span>
      <ChevronUp size={12} strokeWidth={2} className={cn("flex-none text-fg-3 motion-rotate", open && "rotate-180")} aria-hidden="true"/>
    </button>
    <Collapsible open={open} id={id}>
      <div className="pt-2"><ul className="card m-0 flex max-h-[min(40vh,320px)] list-none flex-col gap-2 overflow-y-auto p-4 text-ui-sm" aria-label={`${harness(found.harnessId)} 的任务清单`}>
        {(unfolded ? steps.map((_, index) => ({ kind: "step" as const, index })) : planRows(steps)).map((row, position) => row.kind === "fold"
          ? <li key={"fold-" + position} className="flex min-w-0"><button type="button" className="plan-fold btn btn-ghost btn-sm -ml-1.5 text-fg-3" onClick={() => setUnfolded(true)}>还有 {row.count} 步，展开</button></li>
          : (step => <li key={row.index} className="flex min-w-0 items-start gap-2">
          {step.status === "completed" ? <Check size={15} strokeWidth={1.9} className="mt-0.5 flex-none text-fg-3" aria-label="已完成" role="img"/>
            : step.status === "in_progress" && working ? <Spinner size={15} tone="run" label="进行中"/>
            : <Circle size={15} strokeWidth={1.9} className="mt-0.5 flex-none text-fg-3" aria-label="待办" role="img"/>}
          <span className={cn("min-w-0 break-words", step.status === "completed" ? "text-fg-3 line-through decoration-line-strong" : step.status === "in_progress" ? "font-medium text-fg" : "text-fg-2")}>{step.text}</span>
        </li>)(steps[row.index]!))}
      </ul></div>
    </Collapsible>
  </div>;
}

/**
 * The next-step box above the composer: the wrap-up the latest Turn's Harness gave (`hub_wrap_up`) — a short recap, and when the next move is yours, its question and one or
 * two answers as buttons, the first the Harness's recommendation. An answer is sent as your next message. The page never makes one up: a Turn that gave none shows none.
 */
function NextStep({ recap, harness, blocked, onAnswer }: { readonly recap: NonNullable<ConversationView["recap"]>; readonly harness: string; readonly blocked: string | null; readonly onAnswer: (text: string) => void }) {
  const why = useId();
  // The box is the question and its answers: the Turn's reply above it already says what was done.
  return <section className="next-step card motion-enter flex flex-col gap-2.5 px-4 py-3.5 text-ui-sm" data-turn-next="" aria-label={harness + " 的提问"} title={recap.summary}>
    {recap.ask ? <p className="m-0 break-words font-medium text-fg">{recap.ask}</p> : null}
    {recap.actions?.length ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label="回答">
      {recap.actions.map((label, index) => <button key={index} type="button" className={cn("btn btn-sm next-step-answer", index === 0 ? "btn-primary" : "btn-ghost")} disabled={blocked !== null}
        aria-describedby={blocked === null ? undefined : why} {...(index === 0 ? { "aria-keyshortcuts": "Meta+Enter", title: blocked ?? "⌘⏎（输入框为空时）" } : blocked === null ? {} : { title: blocked })}
        onClick={() => onAnswer(label)}>{label}</button>)}
      {blocked === null ? <span className="text-caption text-fg-3 max-sm:hidden" aria-hidden="true">⌘⏎</span> : null}
    </div> : null}
    {recap.actions?.length && blocked !== null ? <p id={why} className="next-step-blocked m-0 text-caption text-fg-3">{blocked}</p> : null}
  </section>;
}

/**
 * The line under the composer (P05): the round, its steps and its time, and only the usage the Turn reported, in the words of the Turn's
 * footer (statusParts) — input tokens when the Hub counted the whole Turn, the context share when the Harness gave its size, the cost under its
 * scope when something was spent. Nothing is estimated; a fact the Turn did not report is left out.
 */
function StatusLine({ session, active }: { readonly session: ConversationView; readonly active: PublicRun | null }) {
  const run = active ?? session.runs.at(-1) ?? null, turn = run?.protocol;
  // A Turn waiting in the queue has not started: as its own line says 排队中 without a timer (ruling N), this line counts no
  // time for it either, until a stop is asked for, when the Turn's line counts again (liveStatus).
  const counting = run !== null && turn !== undefined && !over(turn) && (turn.status !== "queued" || run.cancelRequested);
  const now = useNow(counting);
  if (turn === undefined) return null;
  const parts = statusParts(turn, counting ? now : undefined);
  return <p className="composer-status m-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-1 text-caption text-fg-3" aria-label="本轮状态">
    {parts.map((part, index) => <Fragment key={index}>{index ? <span aria-hidden="true">·</span> : null}{part.share === undefined ? <span>{part.text}</span>
      : <span className="inline-flex items-center gap-[5px]" title={`上下文已用 ${part.share}%（由原程序报告）`}>
        <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--bg-hover)" strokeWidth="3"/>
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--text-3)" strokeWidth="3" strokeDasharray={`${(part.share / 100 * 47.1).toFixed(1)} 47.1`} strokeLinecap="round" transform="rotate(-90 10 10)"/></svg>{part.text}</span>}</Fragment>)}
  </p>;
}
