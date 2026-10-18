import { Blocks, Bot, Columns2, Keyboard, MessageSquarePlus, Monitor, Moon, PanelLeft, RefreshCw, Settings, SlidersHorizontal, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SelectionRequest } from "../../src/contracts/session.js";
import type { ProviderView, ProviderWriteInput } from "../../src/contracts/provider.js";
import { parseProviderTarget } from "../../src/contracts/provider.js";
import type { AttentionFrame, HarnessView, InstallationView, SessionView, WebState } from "../../src/contracts/web.js";
import type { NativeModelCatalog } from "../../src/contracts/control.js";
import type { InstallationJobView, ManagementJobInput } from "../../src/contracts/management.js";
import { parseNativeOptions, sessionId as validateSessionId } from "../../src/contracts/session.js";
import { applySessionStreamFrame } from "./session-stream.js";
import { notifyWaiting } from "./attention.js";
import { ApiError, errorMessage, GatewayApi, requestKey } from "./api.js";
import { ChatPage, effectiveProviderProblem, EMPTY_SELECTION, selectionDraft, selectionProblem, selectionRequest } from "./components/ChatPage.js";
import type { QueuedMessage, SelectionDraft } from "./components/ChatPage.js";
import { HarnessesPage, installationActive } from "./components/HarnessesPage.js";
import type { UnconfirmedInstallation } from "./components/HarnessesPage.js";
import type { UpgradeConsent } from "./components/UpgradeDialog.js";
import type { UninstallConsent } from "./components/UninstallDialog.js";
import { ProvidersPage } from "./components/ProvidersPage.js";
import type { ProviderProbeState } from "./components/ProvidersPage.js";
import { Sidebar } from "./components/Sidebar.js";
import type { Page } from "./components/Sidebar.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { CapabilitiesPage } from "./components/CapabilitiesPage.js";
import { CommandPalette, ShortcutsDialog, type PaletteCommand } from "./components/CommandPalette.js";
import { BrandIcon } from "./components/BrandIcon.js";
import { attachmentKind, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentDraft } from "./components/Attachments.js";
import { parseContentRef, type ContentRef } from "../../src/contracts/content.js";
import { useMedia, usePreferences } from "./lib/prefs.js";
import { finished } from "./lib/turn.js";
import { cn } from "./lib/cn.js";
import { Dialog } from "./ui/overlay.js";
import { LogoMark, Notice, Spinner, TipProvider } from "./ui/primitives.js";

interface PendingMessage { text: string; attachments: readonly string[]; createKey: string; sessionId: string | null; sendKey: string; committed: boolean;
  /** A new conversation chosen to keep its native process records that before its first message is sent (ADR-030). */
  retain?: { readonly key: string; applied: boolean } }
interface PendingSelection { sessionId: string; selection: SelectionRequest; key: string; recovery: boolean; acknowledgeUnknown: boolean }
/** One conversation's unsent state in this tab. A held message (ADR-042) is restored into the composer, never sent, after a reload. */
interface ChatDraft { message: string; attachments: readonly ContentRef[]; selection: SelectionDraft; epoch: number | null; messageIntent: PendingMessage | null; selectionIntent: PendingSelection | null; queued?: QueuedMessage | null }
function draftStorageKey(workspace: string, id: string): string { return "harnessgateway:chat-draft:" + workspace + ":" + id; }
function choiceStorageKey(harnessId: string): string { return "harnessgateway:native-choice:" + harnessId; }
/**
 * The last native choice sent with each Harness from this browser: its entry, model and thinking level, never a Provider.
 * Modes and permission or sandbox settings are not carried into another conversation (the approver's scope); a new
 * conversation follows the program's own defaults for them. A Hub preference only; nothing is written to the Harness's
 * own configuration, and an unreadable entry is ignored.
 */
function rememberedChoice(harnessId: string): { readonly controlId: string; readonly nativeModel?: string; readonly nativeOptions?: Readonly<Record<string, string>> } | null {
  try {
    const raw = localStorage.getItem(choiceStorageKey(harnessId));
    if (raw === null || raw.length > 16 * 1024) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["controlId", "model", "nativeOptions"].includes(key)) || typeof row.controlId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(row.controlId) ||
        row.model !== undefined && (typeof row.model !== "string" || !row.model.trim() || row.model.length > 1024 || /[\0\r\n]/u.test(row.model))) return null;
    return { controlId: row.controlId, ...(typeof row.model === "string" ? { nativeModel: row.model } : {}), ...(row.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(row.nativeOptions) }) };
  } catch { return null; }
}
function rememberChoice(draft: SelectionDraft, catalog: NativeModelCatalog | null): void {
  if (draft.providerId || !draft.harnessId || !draft.controlId) return;
  // Only thinking levels, as the catalog names them; any option the catalog does not describe is left out.
  const thinking = new Set([...(catalog?.options ?? []), ...(catalog?.models.find(model => model.id === (draft.model || catalog.defaultModel))?.options ?? [])].filter(option => option.category === "thought_level").map(option => option.id));
  const options = Object.fromEntries(Object.entries(draft.nativeOptions).filter(([id]) => thinking.has(id)));
  try { localStorage.setItem(choiceStorageKey(draft.harnessId), JSON.stringify({ controlId: draft.controlId, ...(draft.model ? { model: draft.model } : {}), ...(Object.keys(options).length ? { nativeOptions: options } : {}) })); }
  catch { /* A convenience only: without storage the next conversation follows the native configuration. */ }
}
function readyAttachments(items: readonly AttachmentDraft[]): readonly ContentRef[] { return items.flatMap(item => item.status === "ready" && item.ref ? [item.ref] : []); }
function draftAttachments(refs: readonly ContentRef[] | undefined): readonly AttachmentDraft[] { return (refs ?? []).map(ref => ({ local: ref.id, name: ref.name, bytes: ref.bytes, kind: ref.kind, status: "ready", ref })); }
function savedChatDraft(workspace: string, id: string): ChatDraft | null {
  try {
    const raw = sessionStorage.getItem(draftStorageKey(workspace, id));
    if (raw === null || new TextEncoder().encode(raw).byteLength > 256 * 1024) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>, selected = row.selection;
    if (Object.keys(row).some(key => !["message", "attachments", "selection", "epoch", "messageIntent", "selectionIntent", "queued"].includes(key)) || typeof row.message !== "string" ||
        !(row.epoch === null || typeof row.epoch === "number" && Number.isSafeInteger(row.epoch) && row.epoch > 0) || selected === null || typeof selected !== "object" || Array.isArray(selected)) return null;
    const selection = selected as Record<string, unknown>;
    if (Object.keys(selection).some(key => !["harnessId", "controlId", "providerId", "providerRevision", "model", "nativeOptions"].includes(key)) ||
        !["harnessId", "controlId", "providerId", "model"].every(key => typeof selection[key] === "string" && selection[key].length <= 1024) ||
        !(selection.providerRevision === null || typeof selection.providerRevision === "number" && Number.isSafeInteger(selection.providerRevision) && selection.providerRevision > 0)) return null;
    if (selection.nativeOptions !== undefined) { try { parseNativeOptions(selection.nativeOptions); } catch { return null; } }
    const parseMessage = (input: unknown): PendingMessage | null => {
      if (input === null) return null;
      if (typeof input !== "object" || Array.isArray(input)) throw new Error("invalid stored message intent");
      const item = input as Record<string, unknown>;
      if (Object.keys(item).some(key => !["text", "attachments", "createKey", "sessionId", "sendKey", "committed"].includes(key)) || typeof item.text !== "string" || typeof item.committed !== "boolean" ||
          !(item.attachments === undefined || Array.isArray(item.attachments) && item.attachments.length <= 8 && item.attachments.every(value => typeof value === "string" && /^content-[a-zA-Z0-9-]{1,96}$/u.test(value))) ||
          ![item.createKey, item.sendKey].every(key => typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key)) ||
          !(item.sessionId === null || typeof item.sessionId === "string" && item.sessionId === id)) throw new Error("invalid stored message intent");
      return { text: item.text, attachments: (item.attachments ?? []) as string[], createKey: String(item.createKey), sessionId: item.sessionId, sendKey: String(item.sendKey), committed: false };
    };
    // A saved receipt is never authoritative; canonical Session facts confirm it after reload.
    let selectionIntent: PendingSelection | null = null;
    if (row.selectionIntent !== null) {
      if (row.selectionIntent === undefined || typeof row.selectionIntent !== "object" || Array.isArray(row.selectionIntent)) return null;
      const item = row.selectionIntent as Record<string, unknown>, input = item.selection;
      if (Object.keys(item).some(key => !["sessionId", "selection", "key", "recovery", "acknowledgeUnknown"].includes(key)) || item.sessionId !== id || typeof item.key !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.key) || typeof item.recovery !== "boolean" || typeof item.acknowledgeUnknown !== "boolean" ||
          input === null || typeof input !== "object" || Array.isArray(input)) return null;
      const target = input as Record<string, unknown>;
      if (Object.keys(target).some(key => !["harnessId", "controlId", "provider", "nativeModel", "nativeOptions"].includes(key)) || typeof target.harnessId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(target.harnessId) ||
          typeof target.controlId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(target.controlId)) return null;
      selectionIntent = { sessionId: id, selection: { harnessId: target.harnessId, controlId: target.controlId,
        ...(target.provider === undefined ? {} : { provider: target.provider === null ? null : parseProviderTarget(target.provider) }),
        ...(target.nativeModel === undefined ? {} : { nativeModel: typeof target.nativeModel === "string" && target.nativeModel.length <= 1024 ? target.nativeModel : (() => { throw new Error("invalid native model"); })() }) , ...(target.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(target.nativeOptions) }) }, key: item.key, recovery: item.recovery, acknowledgeUnknown: item.acknowledgeUnknown };
    }
    // Drafts saved before attachments existed have none; a damaged list drops the whole draft like any other field.
    const attachments = row.attachments === undefined ? [] : Array.isArray(row.attachments) && row.attachments.length <= 8 ? row.attachments.map(parseContentRef) : (() => { throw new Error("invalid stored attachments"); })();
    // A message held until a Turn ended goes back into the composer after a reload: it is never sent without the user.
    let queued: QueuedMessage | null = null;
    if (row.queued !== undefined && row.queued !== null) {
      if (typeof row.queued !== "object" || Array.isArray(row.queued)) return null;
      const item = row.queued as Record<string, unknown>;
      if (Object.keys(item).some(key => !["text", "attachments", "afterRunId", "selection"].includes(key)) || typeof item.text !== "string" || typeof item.afterRunId !== "string" || typeof item.selection !== "string" || !Array.isArray(item.attachments) || item.attachments.length > 8) return null;
      queued = { text: item.text, attachments: item.attachments.map(parseContentRef), afterRunId: item.afterRunId, selection: item.selection };
    }
    const restored = restoreQueued({ message: row.message, attachments }, queued);
    return { message: restored.message, attachments: restored.attachments, selection: { harnessId: String(selection.harnessId), controlId: String(selection.controlId), providerId: String(selection.providerId),
      providerRevision: selection.providerRevision, model: String(selection.model), nativeOptions: parseNativeOptions(selection.nativeOptions ?? {}) }, epoch: row.epoch, messageIntent: parseMessage(row.messageIntent), selectionIntent, queued: null };
  } catch { return null; }
}
/** Puts a held message back in front of whatever the composer holds; attachments stay within the per-message limit. */
function restoreQueued(draft: { readonly message: string; readonly attachments: readonly ContentRef[] }, queued: QueuedMessage | null | undefined): { readonly message: string; readonly attachments: readonly ContentRef[] } {
  if (!queued) return draft;
  return { message: queued.text + (draft.message.trim() ? "\n\n" + draft.message : ""), attachments: [...queued.attachments, ...draft.attachments.filter(ref => !queued.attachments.some(item => item.id === ref.id))].slice(0, MAX_ATTACHMENTS) };
}
interface PendingProviderWrite { input: ProviderWriteInput; key: string; current: ProviderView | undefined }
/** The page named in the address, so a reload stays where the user was; the conversation route is the default. */
function pageRoute(): Page {
  const value = new URLSearchParams(window.location.hash.slice(1)).get("page");
  return value === "harnesses" || value === "capabilities" || value === "settings" || value === "providers" ? value : "chat";
}
function writePageRoute(page: Exclude<Page, "chat">): void { window.history.replaceState(null, "", window.location.pathname + "#" + new URLSearchParams({ page }).toString()); }
function sessionRoute(): { id: string | null; error: string | null } {
  const value = new URLSearchParams(window.location.hash.slice(1)).get("session");
  if (value === null) return { id: null, error: null };
  try { return { id: validateSessionId(value), error: null }; }
  catch { return { id: null, error: "链接中的会话编号无效。请从最近对话中重新打开，或明确新建一个对话。" }; }
}
function writeSessionRoute(id: string | null): void {
  window.history.replaceState(null, "", window.location.pathname + (id ? "#" + new URLSearchParams({ session: id }).toString() : ""));
}
const SHORTCUT_TARGETS = "input, textarea, select, [contenteditable=true]";
export function App() {
  const [api] = useState(() => new GatewayApi());
  const [initialRoute] = useState(sessionRoute);
  const [state, setState] = useState<WebState | null>(null);
  // Waiting approvals and questions of every conversation, pushed by the Gateway (ADR-035); the newest revision wins.
  const [attention, setAttention] = useState<AttentionFrame | null>(null);
  const attentionSeen = useRef(new Set<string>());
  const openFromNotice = useRef<(id: string) => void>(() => {});
  const acceptAttention = useCallback((frame: AttentionFrame) => {
    setAttention(current => current !== null && current.revision > frame.revision ? current : frame);
    const names = new Map((liveState.current?.harnesses ?? []).map(harness => [harness.id, harness.name]));
    for (const item of frame.items) {
      if (attentionSeen.current.has(item.permissionId)) continue;
      attentionSeen.current.add(item.permissionId);
      notifyWaiting(item, names.get(item.harnessId) ?? item.harnessId, Date.now(), id => openFromNotice.current(id));
    }
  }, []);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [page, setPage] = useState<Page>(pageRoute);
  // The Harness the capability page opens on, when it was opened from that Harness's details.
  const [capabilityHarness, setCapabilityHarness] = useState<string | null>(null);
  // On a narrow screen the sidebar is a drawer; on a wide one the user may hide it (a preference of this browser).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [preferences, setPreference] = usePreferences();
  const narrow = useMedia("(max-width: 759px)");
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  // The message written while a reply runs, held by this tab until that Turn ends (ADR-042).
  const [queued, setQueued] = useState<QueuedMessage | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialRoute.id);
  const [session, setSession] = useState<SessionView | null>(null);
  const [sessionLoading, setSessionLoading] = useState(initialRoute.id !== null);
  const [sessionError, setSessionError] = useState<string | null>(initialRoute.error);
  const [chatKey, setChatKey] = useState(0);
  const [draft, setDraft] = useState<SelectionDraft>({ ...EMPTY_SELECTION });
  const [messageDraft, setMessageDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [mutation, setMutation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [nativeCatalog, setNativeCatalog] = useState<NativeModelCatalog | null>(null);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null);
  const [editor, setEditor] = useState<ProviderView | "new" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [probes, setProbes] = useState<Record<string, ProviderProbeState>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [managementConnectionError, setManagementConnectionError] = useState<string | null>(null);
  const [cancellingInstallations, setCancellingInstallations] = useState<readonly string[]>([]);
  const [submittingInstallations, setSubmittingInstallations] = useState<readonly string[]>([]);
  const [unconfirmedInstallations, setUnconfirmedInstallations] = useState<readonly UnconfirmedInstallation[]>([]);
  const installationWrites = useRef(new Map<string, ManagementJobInput>());
  const installationCancels = useRef(new Map<string, string>());
  const installationRequests = useRef(new Set<string>());
  const cancellationRequests = useRef(new Set<string>());
  const completedInstallations = useRef(new Set<string>());
  const viewGeneration = useRef(0);
  const liveState = useRef<WebState | null>(null); liveState.current = state;
  const sessionIdRef = useRef<string | null>(initialRoute.id);
  const liveSession = useRef<SessionView | null>(null);
  const operation = useRef(false);
  const pendingMessage = useRef<PendingMessage | null>(null);
  // A new conversation's choice to keep its native process, applied when its first message creates it.
  const [keepNew, setKeepNew] = useState(false);
  const pendingSwitchWrite = useRef<PendingSelection | null>(null);
  const chatDrafts = useRef(new Map<string, ChatDraft>());
  const selectionWish = useRef<{ id: string; draft: SelectionDraft } | null>(null);
  const lastAutoSelection = useRef<string | null>(null);
  const pendingProviderWrite = useRef<PendingProviderWrite | null>(null);
  const observedSelection = useRef("");
  const observedVersion = useRef<{ id: string; version: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let ignored = false;
    const controller = new AbortController();
    setBootError(null);
    void (async () => {
      try {
        // Bootstrap consumes a one-use token. StrictMode shares this exchange; cleanup only aborts reads.
        await api.authenticate();
        if (ignored) return;
        const snapshot = await api.state(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (!ignored) {
          snapshot.jobs.filter(job => job.status === "completed").forEach(job => completedInstallations.current.add(job.id)); setState(snapshot); setWorkspace(snapshot.workspace);
          const key = sessionIdRef.current ?? "new", saved = savedChatDraft(snapshot.workspace, key);
          if (saved && !chatDrafts.current.has(key)) { chatDrafts.current.set(key, saved); setMessageDraft(saved.message); setAttachments(draftAttachments(saved.attachments)); setDraft(saved.selection); pendingMessage.current = saved.messageIntent; pendingSwitchWrite.current = saved.selectionIntent; }
        }
      } catch (failure: unknown) {
        // Without a session the page says so in the product's words; the help below names the startup link.
        if (!ignored) setBootError(failure instanceof ApiError && failure.code === "AUTH_REQUIRED" ? "这个页面还没有登录。" : errorMessage(failure));
      }
    })();
    return () => { ignored = true; controller.abort(); };
  }, [api, bootAttempt]);

  const refreshState = useCallback(async () => {
    const generation = viewGeneration.current;
    const value = await api.state(AbortSignal.timeout(15_000));
    if (mounted.current && generation === viewGeneration.current) setState(value);
  }, [api]);
  const acceptSession = useCallback((value: SessionView) => {
    if (!mounted.current || sessionIdRef.current !== value.id) return;
    const live = liveSession.current;
    if (live?.id === value.id && (live.version > value.version || live.lastSeq > value.lastSeq)) return;
    liveSession.current = value;
    if (observedVersion.current?.id === value.id && observedVersion.current.version > value.version) return;
    observedVersion.current = { id: value.id, version: value.version };
    setSession(current => current && current.id === value.id && current.version > value.version ? current : value);
    setSessionLoading(false);
    const intent = pendingSwitchWrite.current;
    if (intent?.sessionId === value.id && value.switches.some(item => item.commandId === intent.key)) pendingSwitchWrite.current = null;
    const key = `${value.id}:${value.epoch}`;
    if (observedSelection.current !== key) {
      observedSelection.current = key;
      const saved = chatDrafts.current.get(value.id);
      const wish = selectionWish.current;
      const restored = wish?.id === value.id ? wish.draft : saved?.epoch === value.epoch ? saved.selection : selectionDraft(value.selection);
      const latest = value.switches.at(-1);
      if (saved && latest?.status === "failed" && JSON.stringify(selectionRequest(restored)) === JSON.stringify(latest.requested))
        lastAutoSelection.current = JSON.stringify({ id: value.id, selection: latest.requested });
      if (wish?.id === value.id) {
        if (JSON.stringify(wish.draft) === JSON.stringify(selectionDraft(value.selection))) selectionWish.current = null;
        setDraft(wish.draft);
      } else setDraft(restored);
    }
    if (pendingMessage.current?.sessionId === value.id && value.runs.some(run => run.commandId === pendingMessage.current?.sendKey)) pendingMessage.current.committed = true;
    setState(current => {
      if (!current) return current;
      const summary = { id: value.id, title: value.messages.find(message => message.role === "user")?.text.slice(0, 80) ?? "新对话",
        status: value.status, workspace: value.workspace, selection: value.selection, updatedSeq: value.lastSeq, activeRunId: value.activeRunId };
      return { ...current, sessions: current.sessions.some(item => item.id === value.id)
        ? current.sessions.map(item => item.id === value.id ? summary : item) : [summary, ...current.sessions].slice(0, 1000) };
    });
  }, []);
  useEffect(() => {
    if (!sessionId || !state) return;
    let stopped = false, failures = 0, animation: number | null = null, pending: SessionView | null = null;
    const controller = new AbortController();
    const flush = () => { animation = null; const value = pending; pending = null; if (!stopped && sessionIdRef.current === sessionId && value) acceptSession(value); };
    const stage = (value: SessionView) => {
      liveSession.current = value; pending = value;
      if (animation === null) animation = requestAnimationFrame(flush);
    };
    const wait = (ms: number): Promise<void> => new Promise(resolve => {
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms); controller.signal.addEventListener("abort", finish, { once: true });
      if (controller.signal.aborted) finish();
    });
    void (async () => {
      while (!stopped) {
        try {
          const current = liveSession.current, started = performance.now();
          await api.streamSession(sessionId, current?.id === sessionId ? current.lastSeq : 0, controller.signal, frame => {
            if (stopped || sessionIdRef.current !== sessionId) return;
            const base = liveSession.current?.id === sessionId ? liveSession.current : null;
            const next = applySessionStreamFrame(base, frame, sessionId);
            setConnectionError(null); stage(next);
          }, frame => { if (!stopped) acceptAttention(frame); });
          if (!stopped) {
            if (performance.now() - started < 45_000) throw new ApiError("STREAM_EARLY_EOF", "实时连接提前结束。");
            failures = 0; await wait(250);
          }
        } catch (failure: unknown) {
          if (stopped || sessionIdRef.current !== sessionId) return;
          if (failure instanceof ApiError && failure.code.includes("NOT_FOUND")) {
            setSessionError(errorMessage(failure)); setSessionLoading(false); setConnectionError(null); return;
          }
          failures += 1;
          const terminal = failures >= 8 || failure instanceof ApiError && ["AUTH_REQUIRED", "HOST_REJECTED", "ORIGIN_REJECTED"].includes(failure.code);
          setConnectionError(terminal ? "实时连接未能恢复，历史和草稿已保留。点击重新连接可再试。" : "实时连接暂时中断，正在恢复；历史和草稿已保留。");
          if (terminal) { setSessionLoading(false); return; }
          await wait(Math.min(15000, 500 * 2 ** Math.min(failures, 5)));
        }
      }
    })();
    return () => { stopped = true; controller.abort(); if (animation !== null) cancelAnimationFrame(animation); pending = null; };
  }, [api, sessionId, state !== null, streamAttempt, acceptSession, acceptAttention]);
  useEffect(() => {
    if (!state) return;
    let stopped = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const poll = async () => {
      let delay = 5000;
      const generation = viewGeneration.current;
      try {
        const snapshot = await api.state(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (stopped) return;
        failures = 0; setManagementConnectionError(null);
        if (generation === viewGeneration.current) setState(snapshot);
        const newlyCompleted = snapshot.jobs.filter(job => job.status === "completed" && !completedInstallations.current.has(job.id));
        if (newlyCompleted.length) {
          const harnesses = await api.rescan(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
          if (!stopped && generation === viewGeneration.current) {
            newlyCompleted.forEach(job => completedInstallations.current.add(job.id));
            setState(current => current ? { ...current, harnesses } : current);
          }
        }
        delay = snapshot.jobs.some(installationActive) ? 800 : 5000;
      } catch (failure: unknown) {
        if (stopped) return;
        failures += 1; setManagementConnectionError(errorMessage(failure)); delay = Math.min(15_000, 1000 * 2 ** Math.min(failures, 4));
      }
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? Math.max(delay, 10_000) : delay);
    };
    timer = setTimeout(() => void poll(), liveState.current?.jobs.some(installationActive) ? 800 : 1500);
    return () => { stopped = true; if (timer !== null) clearTimeout(timer); controller.abort(); };
  }, [api, state !== null]);
  // Without a conversation open, the page subscribes to waiting requests alone; with one open, that conversation's stream
  // carries them, so a page holds one long-lived connection either way.
  useEffect(() => {
    if (!state || sessionId !== null) return;
    let stopped = false, failures = 0;
    const controller = new AbortController();
    const wait = (ms: number): Promise<void> => new Promise(resolve => {
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms); controller.signal.addEventListener("abort", finish, { once: true });
      if (controller.signal.aborted) finish();
    });
    void (async () => {
      while (!stopped) {
        try {
          await api.streamAttention(controller.signal, frame => { if (!stopped) { failures = 0; acceptAttention(frame); } });
          if (!stopped) await wait(250);
        } catch (failure: unknown) {
          if (stopped) return;
          // The reminder is secondary: it retries quietly and gives up only when the login is gone.
          if (failure instanceof ApiError && ["AUTH_REQUIRED", "HOST_REJECTED", "ORIGIN_REJECTED"].includes(failure.code)) return;
          failures += 1; await wait(Math.min(15000, 500 * 2 ** Math.min(failures, 5)));
        }
      }
    })();
    return () => { stopped = true; controller.abort(); };
  }, [api, state !== null, sessionId === null, acceptAttention]);
  const leave = (action: () => void) => {
    if (operation.current) return;
    const finish = () => { pendingProviderWrite.current = null; action(); };
    if (editorDirty) { setLeaveAction(() => finish); return; }
    finish();
  };
  const navigate = (next: Page) => leave(() => {
    setPage(next); setEditor(null); setEditorDirty(false); setSidebarOpen(false); setError(null);
    if (next === "chat") writeSessionRoute(sessionIdRef.current); else writePageRoute(next);
  });
  const saveChatDraft = () => {
    chatDrafts.current.set(sessionIdRef.current ?? "new", { message: messageDraft, attachments: readyAttachments(attachments), selection: draft,
      epoch: session?.epoch ?? null, messageIntent: pendingMessage.current, selectionIntent: pendingSwitchWrite.current, queued });
    try {
      const saved = chatDrafts.current.get(sessionIdRef.current ?? "new")!;
      const serialized = JSON.stringify(saved);
      if (new TextEncoder().encode(serialized).byteLength > 256 * 1024) throw new Error("draft byte budget exceeded");
      sessionStorage.setItem(draftStorageKey(state?.workspace ?? workspace, sessionIdRef.current ?? "new"), serialized); setDraftStorageError(null);
    } catch { setDraftStorageError("浏览器暂时无法保存草稿。内容仍在当前页面，请暂时保留此页面。"); }
  };
  useEffect(() => { if (state && !sessionLoading && !sessionError) saveChatDraft(); }, [messageDraft, attachments, draft, session?.epoch, mutation, state !== null, sessionLoading, sessionError, queued]);
  const newChat = () => leave(() => {
    selectionWish.current = null; lastAutoSelection.current = null;
    saveChatDraft(); const saved = chatDrafts.current.get("new"); pendingSwitchWrite.current = saved?.selectionIntent ?? null;
    sessionIdRef.current = null; liveSession.current = null; observedSelection.current = ""; pendingMessage.current = null; setKeepNew(false);
    pendingMessage.current = saved?.messageIntent ?? null; setQueued(null); setQueueNotice(null);
    writeSessionRoute(null); setSessionId(null); setSession(null); setSessionLoading(false); setSessionError(null); setDraft(saved?.selection ?? { ...EMPTY_SELECTION }); setMessageDraft(saved?.message ?? ""); setAttachments(draftAttachments(saved?.attachments)); setChatKey(value => value + 1);
    setPage("chat"); setEditor(null); setEditorDirty(false); setSidebarOpen(false); setError(null); setConnectionError(null);
  });
  const selectSession = (id: string) => leave(() => {
    if (sessionIdRef.current !== id) {
      saveChatDraft(); const stored = chatDrafts.current.get(id) ?? savedChatDraft(state?.workspace ?? workspace, id);
      // Leaving a conversation stops watching its Turn, so a message held there goes back into its composer, unsent.
      const restored = stored?.queued ? restoreQueued(stored, stored.queued) : null, saved = stored && restored ? { ...stored, ...restored, queued: null } : stored;
      if (saved) chatDrafts.current.set(id, saved);
      setQueued(null); setQueueNotice(restored ? "离开对话时暂存的消息已放回输入框，没有发出。" : null);
      selectionWish.current = saved ? { id, draft: saved.selection } : null; lastAutoSelection.current = null;
      sessionIdRef.current = id; liveSession.current = null; observedSelection.current = "";
      pendingMessage.current = saved?.messageIntent ?? null; pendingSwitchWrite.current = saved?.selectionIntent ?? null;
      writeSessionRoute(id); setSessionId(id); setSession(null); setSessionLoading(true); setSessionError(null);
      setMessageDraft(saved?.message ?? ""); setAttachments(draftAttachments(saved?.attachments)); if (saved) setDraft(saved.selection); setChatKey(value => value + 1);
    }
    setPage("chat"); setEditor(null); setEditorDirty(false); setSidebarOpen(false); setError(null); setConnectionError(null);
  });
  openFromNotice.current = selectSession;
  const chooseHarness = (harness: HarnessView) => leave(() => {
    selectionWish.current = null; lastAutoSelection.current = null;
    const control = harness.controls.find(row => row.id === harness.defaultControlId && row.available) ?? harness.controls.find(row => row.available); if (!control) return;
    saveChatDraft(); pendingSwitchWrite.current = null; setQueued(null); setQueueNotice(null);
    sessionIdRef.current = null; liveSession.current = null; observedSelection.current = ""; pendingMessage.current = null; setKeepNew(false);
    const remembered = rememberedChoice(harness.id), entry = remembered && harness.controls.some(row => row.id === remembered.controlId && row.available) ? remembered : null;
    writeSessionRoute(null); setSessionId(null); setSession(null); setSessionLoading(false); setSessionError(null);
    setDraft({ ...EMPTY_SELECTION, harnessId: harness.id, controlId: entry?.controlId ?? control.id, model: entry?.nativeModel ?? "", nativeOptions: entry?.nativeOptions ?? {} }); setMessageDraft(""); setAttachments([]);
    setChatKey(value => value + 1); setPage("chat"); setSidebarOpen(false); setError(null); setConnectionError(null);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const command = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
      if (command && event.shiftKey && key === "o") { event.preventDefault(); newChat(); return; }
      if (command && !event.shiftKey && key === "k") { event.preventDefault(); setShortcuts(false); setPalette(value => !value); return; }
      if (command && event.key === "/") { event.preventDefault(); setPalette(false); setShortcuts(value => !value); return; }
      if (command && event.key === ".") { event.preventDefault(); setPreference("panel", !preferences.panel); return; }
      if (command && !event.shiftKey && key === "b" && !(event.target instanceof Element && event.target.closest(SHORTCUT_TARGETS))) { event.preventDefault(); if (narrow) setSidebarOpen(value => !value); else setPreference("sidebar", !preferences.sidebar); return; }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  });
  const startOperation = (label: string): boolean => { if (operation.current) return false; operation.current = true; setMutation(label); setError(null); return true; };
  const endOperation = () => { operation.current = false; if (mounted.current) setMutation(null); };
  const send = async (value: string, retryAttachments?: readonly ContentRef[]) => {
    if (!state) throw new ApiError("NOT_READY", "工作空间尚未连接。");
    if (!startOperation("sending")) throw new ApiError("OPERATION_PENDING", "正在处理当前选择，请稍候；草稿已保留。");
    const sent = retryAttachments ?? readyAttachments(attachments), ids = sent.map(item => item.id);
    try {
      if (retryAttachments === undefined && attachments.some(item => item.status !== "ready")) throw new ApiError("ATTACHMENT_PENDING", "附件还在上传或上传失败，处理后再发送。");
      if (session && (session.pendingSwitchId !== null || JSON.stringify(draft) !== JSON.stringify(selectionDraft(session.selection))))
        throw new ApiError("SELECTION_PENDING", "正在切换到所选 Harness 或模型，请稍候；草稿已保留。");
      const isEffective = session !== null && JSON.stringify(draft) === JSON.stringify(selectionDraft(session.selection));
      const problem = (isEffective && session ? effectiveProviderProblem(session.selection, state.providers) : null) ?? selectionProblem(draft, state.harnesses, state.providers); if (problem) throw new ApiError("INVALID_SELECTION", problem);
      const previous = pendingMessage.current, same = previous !== null && previous.text === value && previous.attachments.join() === ids.join();
      if (previous && !previous.committed && !same) throw new ApiError("UNCONFIRMED_REQUEST", "上一条消息的接收结果还未确认。请保留原消息重试，或等待历史更新后再发送新内容。");
      const request: PendingMessage = same ? previous : { text: value, attachments: ids, createKey: requestKey(), sessionId: sessionIdRef.current, sendKey: requestKey(), committed: false,
        ...(sessionIdRef.current === null && keepNew ? { retain: { key: requestKey(), applied: false } } : {}) };
      pendingMessage.current = request;
      saveChatDraft();
      let id = request.sessionId;
      if (id === null) {
        const created = await api.createSession(workspace, selectionRequest(draft), request.createKey);
        id = created.id; request.sessionId = id; chatDrafts.current.delete("new");
        try { sessionStorage.removeItem(draftStorageKey(state.workspace, "new")); } catch { /* The owned in-memory draft remains available. */ }
        sessionIdRef.current = id; writeSessionRoute(id); setSessionId(id); acceptSession(created);
      }
      // Recorded before the first message, so the first Turn's process is already kept.
      if (request.retain && !request.retain.applied) { acceptSession(await api.setRetention(id, true, request.retain.key)); request.retain.applied = true; setKeepNew(false); }
      if (!request.committed) { await api.send(id, value, request.sendKey, request.attachments); request.committed = true; rememberChoice(draft, nativeCatalog); }
      pendingMessage.current = null;
      // Sent attachments now belong to the message; the composer keeps only what was added meanwhile.
      if (retryAttachments === undefined && mounted.current) setAttachments(current => current.filter(item => item.ref === undefined || !ids.includes(item.ref.id)));
      // The command ACK releases the draft. Durable facts arrive on the independently owned stream.
      void api.session(id, AbortSignal.timeout(15_000)).then(acceptSession).catch(() => {
        if (mounted.current && sessionIdRef.current === id) setConnectionError("消息已接收，正在恢复实时回复连接。历史和草稿已保留。");
      });
    } catch (failure: unknown) {
      const pending = pendingMessage.current, live = liveSession.current;
      if (failure instanceof ApiError && ["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT"].includes(failure.code) && pending !== null && live !== null && pending.sessionId === live.id &&
          live.runs.some(run => run.commandId === pending.sendKey && run.input === pending.text)) {
        pendingMessage.current = null; setError(null); return;
      }
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT", "UNCONFIRMED_REQUEST"].includes(failure.code) && !pendingMessage.current?.committed) pendingMessage.current = null;
      if (mounted.current) setError(errorMessage(failure)); throw failure;
    } finally { endOperation(); }
  };
  /**
   * Holds the composer's message until the running Turn ends (ADR-042, the approver's conditions): it is sent once, through
   * the same idempotent path as a click, only if that Turn completed, the conversation still accepts messages and no
   * selection change waits; otherwise it goes back into the composer unsent. Only this tab sends it.
   */
  const queueMessage = () => {
    const live = liveSession.current, run = live?.runs.find(item => item.id === live.activeRunId);
    if (!live || !run || queued !== null || !messageDraft.trim() || attachments.some(item => item.status !== "ready")) return;
    setQueued({ text: messageDraft, attachments: readyAttachments(attachments), afterRunId: run.id, selection: JSON.stringify(selectionDraft(live.selection)) });
    setMessageDraft(""); setAttachments([]); setQueueNotice(null);
  };
  const returnQueued = (item: QueuedMessage, notice: string | null) => {
    setQueued(null); setQueueNotice(notice);
    setMessageDraft(current => item.text + (current.trim() ? "\n\n" + current : ""));
    setAttachments(current => [...draftAttachments(item.attachments), ...current.filter(row => !item.attachments.some(ref => ref.id === row.ref?.id))].slice(0, MAX_ATTACHMENTS));
  };
  const withdrawQueued = () => {
    const item = queued; if (!item) return;
    setQueued(null);
    // Withdrawing is best effort; an unsent upload is collected after the retention window anyway.
    for (const ref of item.attachments) void api.discardAttachment(ref.id).catch(() => {});
  };
  useEffect(() => {
    const item = queued, live = session;
    if (!item || !live || sessionIdRef.current !== live.id || mutation !== null || operation.current) return;
    const run = live.runs.find(row => row.id === item.afterRunId);
    if (run !== undefined && !finished(run.status)) return;
    if (live.activeRunId !== null && live.activeRunId !== item.afterRunId) { returnQueued(item, "对话开始了另一轮回复，暂存的消息已放回输入框，没有发出。"); return; }
    if (run === undefined || run.status !== "completed") { returnQueued(item, "上一轮没有正常结束，暂存的消息已放回输入框，没有发出。"); return; }
    if (live.status !== "open") { returnQueued(item, "这个对话现在不能接收消息，暂存的消息已放回输入框，没有发出。"); return; }
    // A selection change made after the message was held, applied or still pending, puts it back: it was written for the earlier one.
    if (live.pendingSwitchId !== null || JSON.stringify(draft) !== JSON.stringify(selectionDraft(live.selection)) || JSON.stringify(selectionDraft(live.selection)) !== item.selection) { returnQueued(item, "所选 Harness 或模型已改变，暂存的消息已放回输入框，没有发出。"); return; }
    setQueued(null);
    void send(item.text, item.attachments).catch((failure: unknown) => { if (mounted.current) returnQueued(item, "暂存的消息没有发出：" + errorMessage(failure) + " 已放回输入框。"); });
  }, [queued, session?.version, session?.activeRunId, mutation]);
  /** Uploads run per chat; a finished upload for a chat no longer on screen goes into that chat's saved draft. */
  const attachFiles = (files: readonly File[]) => {
    const owner = sessionIdRef.current ?? "new", room = MAX_ATTACHMENTS - attachments.length;
    let total = attachments.reduce((sum, item) => sum + item.bytes, 0);
    const added: AttachmentDraft[] = files.slice(0, Math.max(0, room)).map(file => {
      const item: AttachmentDraft = { local: requestKey(), name: file.name || "附件", bytes: file.size, kind: attachmentKind(file.type), status: "uploading" };
      total += file.size;
      const problem = file.size < 1 ? "文件为空" : file.size > MAX_ATTACHMENT_BYTES ? "单个附件不能超过 20 MB" : total > MAX_MESSAGE_ATTACHMENT_BYTES ? "一条消息的附件合计不能超过 32 MB" : null;
      return problem ? { ...item, status: "failed", error: problem } : item;
    });
    if (files.length > room) setError(`一条消息最多 ${MAX_ATTACHMENTS} 个附件，多出的文件没有添加。`);
    setAttachments(current => [...current, ...added]);
    for (const [index, item] of added.entries()) {
      if (item.status !== "uploading") continue;
      const file = files[index]!;
      void api.uploadAttachment(file, item.name, requestKey()).then(ref => {
        if ((sessionIdRef.current ?? "new") === owner) { if (mounted.current) setAttachments(current => current.map(row => row.local === item.local ? { ...row, status: "ready", ref, kind: ref.kind, bytes: ref.bytes } : row)); return; }
        const saved = chatDrafts.current.get(owner);
        if (saved && saved.attachments.length < MAX_ATTACHMENTS) chatDrafts.current.set(owner, { ...saved, attachments: [...saved.attachments, ref] });
        else void api.discardAttachment(ref.id).catch(() => {});
      }, (failure: unknown) => {
        const message = failure instanceof ApiError && failure.code === "INVALID_INPUT" ? "文件内容与类型不符或名称无效" : failure instanceof ApiError && failure.code === "ATTACHMENT_LIMIT" ? "附件超过大小上限" : errorMessage(failure);
        if (mounted.current && (sessionIdRef.current ?? "new") === owner) setAttachments(current => current.map(row => row.local === item.local ? { ...row, status: "failed", error: message } : row));
      });
    }
  };
  const removeAttachment = (local: string) => {
    const item = attachments.find(row => row.local === local);
    setAttachments(current => current.filter(row => row.local !== local));
    // Withdrawing is best effort; an unsent upload is collected after the retention window anyway.
    if (item?.ref) void api.discardAttachment(item.ref.id).catch(() => {});
  };
  /** Creates the branch, then opens it; the new conversation keeps the same Harness selection. */
  /** Continues a listed native session as a new conversation and opens it; the selection stays the Harness's own. */
  const importNative = (nativeId: string) => {
    if (!startOperation("importing")) return;
    const target = { harnessId: draft.harnessId, controlId: draft.controlId };
    void api.importNativeSession(session?.workspace ?? workspace, target, nativeId, requestKey()).then(async created => { await refreshState().catch(() => {}); endOperation(); selectSession(created.id); },
      failure => { setError(errorMessage(failure)); endOperation(); });
  };
  const branch = (runId: string) => {
    if (!sessionId || !startOperation("branching")) return;
    // Navigation waits for the operation to end; leaving a chat is refused while an operation is in flight.
    void api.forkSession(sessionId, requestKey(), runId).then(async created => { await refreshState().catch(() => {}); endOperation(); selectSession(created.id); }, failure => { setError(errorMessage(failure)); endOperation(); });
  };
  const applySelection = async () => {
    if (!sessionId || !startOperation("switching")) return;
    let submittedKey: string | null = null;
    try {
      const target = selectionRequest(draft), previous = pendingSwitchWrite.current;
      const recovery = session?.status === "blocked", acknowledgeUnknown = recovery && session.runs.some(run => run.status === "unknown");
      const request = previous?.sessionId === sessionId ? previous : { sessionId, selection: target, key: requestKey(), recovery, acknowledgeUnknown };
      pendingSwitchWrite.current = request; submittedKey = request.key;
      lastAutoSelection.current = JSON.stringify({ id: sessionId, selection: request.selection });
      saveChatDraft();
      if (request.recovery) await api.resumeSelection(sessionId, request.selection, request.key, request.acknowledgeUnknown);
      else await api.switchSelection(sessionId, request.selection, request.key);
      pendingSwitchWrite.current = null;
      acceptSession(await api.session(sessionId, AbortSignal.timeout(15_000)));
    }
    catch (failure: unknown) {
      if (failure instanceof ApiError && ["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT"].includes(failure.code) && liveSession.current?.id === sessionId &&
          liveSession.current.switches.some(item => item.commandId === submittedKey)) {
        pendingSwitchWrite.current = null; setError(null); return;
      }
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT", "UNCONFIRMED_REQUEST"].includes(failure.code)) pendingSwitchWrite.current = null;
      setError(errorMessage(failure));
    }
    finally { endOperation(); }
  };
  const changeSelection = (value: SelectionDraft) => {
    lastAutoSelection.current = null;
    if (sessionIdRef.current !== null) selectionWish.current = { id: sessionIdRef.current, draft: value };
    setDraft(value);
  };
  useEffect(() => {
    if (!state || !session || session.status !== "open" || session.pendingSwitchId !== null || mutation !== null || operation.current ||
        JSON.stringify(draft) === JSON.stringify(selectionDraft(session.selection)) || selectionProblem(draft, state.harnesses, state.providers)) return;
    const key = JSON.stringify({ id: session.id, selection: selectionRequest(draft) });
    if (lastAutoSelection.current === key) return;
    void applySelection();
  }, [draft, session?.id, session?.version, mutation, state?.harnesses, state?.providers]);
  const nativeCache = useRef(new Map<string,{value:NativeModelCatalog;expires:number}>());
  const nativeRefresh = useRef(false);
  const nativeScope = useRef("");
  const refreshNativeModels = () => { nativeRefresh.current=true; setModelAttempt(value=>value+1); };
  // Readiness changes after each catalog read and each finished Run; a failed refresh keeps the previous observations.
  const refreshReadiness = useCallback(() => { void api.readiness().then(readiness => setState(current => current ? { ...current, readiness } : current), () => undefined); }, [api]);
  const activeRun = session?.activeRunId ?? null, previousActiveRun = useRef<string | null>(null);
  useEffect(() => { if (previousActiveRun.current !== null && activeRun === null) refreshReadiness(); previousActiveRun.current = activeRun; }, [activeRun, refreshReadiness]);
  useEffect(() => {
    const key=JSON.stringify([draft.harnessId,draft.controlId,draft.model,session?.workspace??workspace]), cached=nativeCache.current.get(key);
    const scope=JSON.stringify([draft.harnessId,draft.controlId,session?.workspace??workspace]), sameScope=nativeScope.current===scope; nativeScope.current=scope;
    setNativeCatalog(previous=>cached && cached.expires>Date.now()?cached.value:sameScope?previous:null); setNativeError(null); setNativeLoading(false);
    if (!state || draft.providerId || !draft.harnessId || !draft.controlId) return;
    const controller = new AbortController(), refresh=nativeRefresh.current; nativeRefresh.current=false; setNativeLoading(true);
    void api.nativeModels(draft.harnessId, draft.controlId, session?.workspace ?? workspace, controller.signal, refresh, draft.model || undefined).then(value => {
      if (!controller.signal.aborted) { if (value.models.length) { if (nativeCache.current.size>=8) nativeCache.current.delete(nativeCache.current.keys().next().value!); nativeCache.current.set(key,{value,expires:Date.now()+60000}); } setNativeCatalog(value); setNativeError(value.selectionError?.message??null); refreshReadiness(); }
    }, (failure: unknown) => { if (!controller.signal.aborted) { setNativeError(errorMessage(failure)); refreshReadiness(); } }).finally(() => { if (!controller.signal.aborted) setNativeLoading(false); });
    return () => controller.abort();
  }, [api, state !== null, draft.harnessId, draft.controlId, draft.model, draft.providerId, session?.workspace, workspace, modelAttempt]);
  const cancel = async () => {
    if (!sessionId || !startOperation("cancelling")) return;
    try { await api.cancel(sessionId, requestKey()); acceptSession(await api.session(sessionId, AbortSignal.timeout(15_000))); }
    catch (failure: unknown) { setError(errorMessage(failure)); }
    finally { endOperation(); }
  };
  // A Turn still waiting for its workspace is cancelled by name: it is not the conversation's active Turn (ADR-036).
  const cancelQueued = async (runId: string) => {
    if (!sessionId || !startOperation("cancelling")) return;
    try { await api.cancelRun(sessionId, runId, requestKey()); acceptSession(await api.session(sessionId, AbortSignal.timeout(15_000))); }
    catch (failure: unknown) { setError(errorMessage(failure)); }
    finally { endOperation(); }
  };
  const close = async () => {
    if (!sessionId || !startOperation("closing")) return;
    try { acceptSession(await api.closeSession(sessionId, requestKey())); await refreshState(); }
    catch (failure: unknown) { setError(errorMessage(failure)); }
    finally { endOperation(); }
  };
  const saveProvider = async (input: ProviderWriteInput, current?: ProviderView) => {
    if (!startOperation("saving")) return;
    try {
      const previous = pendingProviderWrite.current;
      if (previous && (previous.current?.id !== current?.id || JSON.stringify(previous.input) !== JSON.stringify(input)))
        throw new ApiError("UNCONFIRMED_REQUEST", "上一条保存请求的结果还未确认。请保留原配置重试，确认后再修改。");
      const request = previous ?? { input, key: requestKey(), current };
      pendingProviderWrite.current = request;
      const saved = await api.writeProvider(request.input, request.key, request.current);
      viewGeneration.current += 1;
      setState(snapshot => snapshot ? { ...snapshot, providers: snapshot.providers.some(provider => provider.id === saved.id)
        ? snapshot.providers.map(provider => provider.id === saved.id ? saved : provider) : [...snapshot.providers, saved] } : snapshot);
      pendingProviderWrite.current = null; setEditorDirty(false); setEditor(null);
    }
    catch (failure: unknown) {
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT", "UNCONFIRMED_REQUEST"].includes(failure.code)) pendingProviderWrite.current = null;
      setError(errorMessage(failure)); throw failure;
    }
    finally { endOperation(); }
  };
  const probeProvider = async (provider: ProviderView) => {
    setProbes(current => ({ ...current, [provider.id]: { revision: provider.revision, status: "checking", models: [], message: null } }));
    try { const models = await api.probeProvider(provider.id); if (mounted.current) setProbes(current => ({ ...current, [provider.id]: { revision: provider.revision, status: "reachable", models, message: null } })); }
    catch (failure: unknown) { if (mounted.current) setProbes(current => ({ ...current, [provider.id]: { revision: provider.revision, status: "failed", models: [], message: errorMessage(failure) } })); }
  };
  const rescan = async () => {
    if (!startOperation("scanning")) return;
    try { const harnesses = await api.rescan(); setState(current => current ? { ...current, harnesses } : current); }
    catch (failure: unknown) { setError(errorMessage(failure)); }
    finally { endOperation(); }
  };
  const acceptInstallation = (job: InstallationJobView) => {
    viewGeneration.current += 1;
    setState(snapshot => snapshot ? { ...snapshot, jobs: [job, ...snapshot.jobs.filter(item => item.id !== job.id)].slice(0, 50) } : snapshot);
  };
  const submitInstallation = async (input: ManagementJobInput) => {
    if (installationRequests.current.has(input.harnessId)) return;
    installationRequests.current.add(input.harnessId); setSubmittingInstallations(current => [...current, input.harnessId]); setError(null);
    try {
      const job = await api.submitInstallation(input); acceptInstallation(job); installationWrites.current.delete(input.harnessId);
      setUnconfirmedInstallations(current => current.filter(item => item.harnessId !== input.harnessId));
    } catch (failure: unknown) {
      const message = errorMessage(failure);
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT"].includes(failure.code)) { installationWrites.current.delete(input.harnessId); setError(message); }
      else setUnconfirmedInstallations(current => [{ harnessId: input.harnessId, action: input.action, message }, ...current.filter(item => item.harnessId !== input.harnessId)]);
    } finally { installationRequests.current.delete(input.harnessId); if (mounted.current) setSubmittingInstallations(current => current.filter(id => id !== input.harnessId)); }
  };
  const install = (harness: HarnessView, action: "install" | "upgrade", consent?: UpgradeConsent) => {
    const previous = installationWrites.current.get(harness.id);
    if (previous && previous.action !== action) { setError("上一次安装请求的接收结果还未确认。请先确认原请求，再发起其他操作。"); return; }
    const controlId = harness.management.recipe?.controlId;
    if (!controlId) { setError("这个 Harness 暂无受管安装配方。"); return; }
    // An upgrade carries what the user agreed to in its confirmation, for the installation that confirmation described (ADR-043).
    const input = previous ?? { harnessId: harness.id, controlId, action, commandId: requestKey(), expectedDefaultRevision: harness.management.defaultRevision,
      ...(harness.management.native ? { expectedNativeFingerprint: consent?.fingerprint ?? harness.management.native.fingerprint } : {}), ...(consent ? { restartServices: consent.restartServices } : {}) };
    installationWrites.current.set(harness.id, input); void submitInstallation(input);
  };
  // An uninstall carries the confirmed check's fingerprint and the services the user agreed to stop (ADR-044).
  const uninstall = (harness: HarnessView, installation: InstallationView, consent: UninstallConsent) => {
    const previous = installationWrites.current.get(harness.id);
    if (previous && (previous.action !== "uninstall" || previous.installation !== installation.ref)) { setError("上一次请求的接收结果还未确认。请先确认原请求，再发起其他操作。"); return; }
    const input = previous ?? { harnessId: harness.id, action: "uninstall" as const, commandId: requestKey(), installation: installation.ref, expectedInstallationFingerprint: consent.fingerprint, stopServices: consent.stopServices };
    installationWrites.current.set(harness.id, input); void submitInstallation(input);
  };
  // An installation upgrade names the installation and carries the fingerprint of the check the user confirmed (ADR-044).
  const upgradeInstallation = (harness: HarnessView, installation: InstallationView, fingerprint: string) => {
    const previous = installationWrites.current.get(harness.id);
    if (previous && (previous.action !== "upgrade" || previous.installation !== installation.ref)) { setError("上一次请求的接收结果还未确认。请先确认原请求，再发起其他操作。"); return; }
    const input = previous ?? { harnessId: harness.id, action: "upgrade" as const, commandId: requestKey(), installation: installation.ref, expectedInstallationFingerprint: fingerprint };
    installationWrites.current.set(harness.id, input); void submitInstallation(input);
  };
  // An official install carries the fingerprint of the check the user confirmed (ADR-044).
  const installOfficial = (harness: HarnessView, fingerprint: string) => {
    const previous = installationWrites.current.get(harness.id);
    if (previous && previous.expectedInstallFingerprint !== fingerprint) { setError("上一次请求的接收结果还未确认。请先确认原请求，再发起其他操作。"); return; }
    const input = previous ?? { harnessId: harness.id, action: "install" as const, commandId: requestKey(), expectedInstallFingerprint: fingerprint };
    installationWrites.current.set(harness.id, input); void submitInstallation(input);
  };
  const confirmInstallation = (id: string) => { const input = installationWrites.current.get(id); if (input) void submitInstallation(input); };
  const cancelInstallation = async (job: InstallationJobView) => {
    if (cancellationRequests.current.has(job.id)) return;
    cancellationRequests.current.add(job.id); setCancellingInstallations(current => [...current, job.id]); setError(null);
    const key = installationCancels.current.get(job.id) ?? requestKey(); installationCancels.current.set(job.id, key);
    try { acceptInstallation(await api.cancelInstallation(job.id, key)); installationCancels.current.delete(job.id); }
    catch (failure: unknown) { if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "REQUEST_TIMEOUT"].includes(failure.code)) installationCancels.current.delete(job.id); setError(errorMessage(failure)); }
    finally { cancellationRequests.current.delete(job.id); if (mounted.current) setCancellingInstallations(current => current.filter(id => id !== job.id)); }
  };
  const checkUpdates = async (ids?: readonly string[]) => {
    if (checkingUpdates) return;
    setCheckingUpdates(true); setError(null);
    try { const harnesses = await api.checkUpdates(ids); viewGeneration.current += 1; setState(current => current ? { ...current, harnesses } : current); }
    catch (failure: unknown) { setError(errorMessage(failure)); }
    finally { setCheckingUpdates(false); }
  };
  const dirtyChanged = useCallback((dirty: boolean) => setEditorDirty(dirty), []);
  const harnessName = (id: string) => state?.harnesses.find(harness => harness.id === id)?.name ?? id;
  const commands = ((): readonly PaletteCommand[] => {
    if (!state) return [];
    const go = (target: Page) => () => navigate(target);
    const theme = (value: "system" | "light" | "dark") => () => setPreference("theme", value);
    return [
      { id: "new", group: "操作", label: "新对话", icon: <MessageSquarePlus size={16}/>, shortcut: "⇧⌘O", run: newChat },
      ...state.sessions.slice(0, 200).map(item => ({ id: "session:" + item.id, group: "对话", label: item.title || "新对话", hint: harnessName(item.selection.harnessId), keywords: item.workspace, icon: <BrandIcon brand={item.selection.harnessId} name={harnessName(item.selection.harnessId)} size={16}/>, run: () => selectSession(item.id) })),
      ...state.harnesses.filter(harness => harness.controls.some(control => control.available)).map(harness => ({ id: "start:" + harness.id, group: "用 Agent 开始新对话", label: "用 " + harness.name + " 开始新对话", keywords: harness.id, icon: <BrandIcon brand={harness.id} name={harness.name} size={16}/>, run: () => chooseHarness(harness) })),
      { id: "harnesses", group: "前往", label: "我的 Agent", icon: <Bot size={16}/>, run: go("harnesses") },
      { id: "capabilities", group: "前往", label: "能力", icon: <Blocks size={16}/>, run: () => { setCapabilityHarness(null); go("capabilities")(); } },
      { id: "settings", group: "前往", label: "设置", icon: <Settings size={16}/>, run: go("settings") },
      ...(state.providerManagement !== false ? [{ id: "providers", group: "前往", label: "模型与账号", icon: <SlidersHorizontal size={16}/>, run: go("providers") }] : []),
      { id: "panel", group: "显示", label: preferences.panel ? "隐藏详情栏" : "显示详情栏", icon: <Columns2 size={16}/>, shortcut: "⌘.", run: () => setPreference("panel", !preferences.panel) },
      { id: "sidebar", group: "显示", label: preferences.sidebar ? "收起侧栏" : "展开侧栏", icon: <PanelLeft size={16}/>, shortcut: "⌘B", run: () => setPreference("sidebar", !preferences.sidebar) },
      { id: "density", group: "显示", label: preferences.density === "compact" ? "过程显示：详细" : "过程显示：简洁", icon: <Columns2 size={16}/>, run: () => setPreference("density", preferences.density === "compact" ? "detailed" : "compact") },
      { id: "theme-system", group: "显示", label: "主题：跟随系统", icon: <Monitor size={16}/>, run: theme("system") },
      { id: "theme-light", group: "显示", label: "主题：浅色", icon: <Sun size={16}/>, run: theme("light") },
      { id: "theme-dark", group: "显示", label: "主题：深色", icon: <Moon size={16}/>, run: theme("dark") },
      { id: "shortcuts", group: "帮助", label: "快捷键", icon: <Keyboard size={16}/>, shortcut: "⌘/", run: () => setShortcuts(true) },
    ];
  })();
  if (!state) return <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-app px-6 text-center">
    <LogoMark size={40}/><h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">HarnessHub</h1>
    {bootError ? <div className="flex max-w-md flex-col items-center gap-3"><Notice tone="red">{bootError}</Notice><p className="m-0 text-[13px] text-fg-2">请使用本机网关启动时提供的入口链接。验证完成后，页面会自动隐藏链接中的令牌。</p>
      <button className="btn" onClick={() => setBootAttempt(value => value + 1)}><RefreshCw size={14}/>重新连接</button></div>
      : <div className="flex items-center gap-2 text-[13px] text-fg-2" role="status"><Spinner/>正在连接你的工作空间</div>}
  </div>;
  const chooseAndClose = (id: string) => { setSidebarOpen(false); selectSession(id); };
  // An address naming the Provider page where Provider management is off opens the conversation instead.
  const shown: Page = page === "providers" && state.providerManagement === false ? "chat" : page;
  const sidebar = <Sidebar providerManagement={state.providerManagement !== false} page={shown} sessions={state.sessions} attention={attention?.items ?? []} harnesses={state.harnesses} currentId={sessionId}
    interactionBusy={mutation !== null} activeJobs={state.jobs.filter(installationActive).length} updates={state.harnesses.filter(harness => harness.management.updateStatus === "available").length}
    groupBy={preferences.groupBy} onGroupBy={value => setPreference("groupBy", value)} connected={connectionError === null && managementConnectionError === null}
    onCollapse={() => setPreference("sidebar", false)} {...(narrow ? { onClose: () => setSidebarOpen(false) } : {})} onPage={next => { setSidebarOpen(false); if (next === "capabilities") setCapabilityHarness(null); navigate(next); }} onNew={newChat} onSession={chooseAndClose} onPalette={() => { setSidebarOpen(false); setPalette(true); }}/>;
  const shell = { onMenu: () => setSidebarOpen(value => !value), sidebarHidden: !preferences.sidebar, onExpandSidebar: () => setPreference("sidebar", true), onChat: () => navigate("chat") };
  return <TipProvider delay={500}><div className="app-shell flex h-dvh overflow-hidden bg-app text-fg" data-page={shown}>
    <a className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳到主要内容</a>
    {narrow ? <Dialog open={sidebarOpen} onOpenChange={setSidebarOpen} title="主导航" kind="left">{sidebar}</Dialog>
      : preferences.sidebar ? <div className="w-[264px] flex-none border-r border-line">{sidebar}</div> : null}
    <main id="main-content" className={cn("flex min-w-0 flex-1 flex-col outline-none")} tabIndex={-1}>
      {shown === "chat" ? <ChatPage providerManagement={state.providerManagement !== false} onToolDetail={content => api.toolDetail(content)} {...(sessionId === null ? {} : { onDiagnostics: (run: string, includeContent: boolean) => api.runDiagnostics(sessionId, run, includeContent) })} onNativeBranch={()=>{ if(!session||!startOperation("native-branch"))return; void api.branchNative(session.id,session.epoch,requestKey()).then(acceptSession).catch(failure=>setError(errorMessage(failure))).finally(endOperation); }}
        retainNew={keepNew}
        onRetention={enabled=>{ if(!session){ setKeepNew(enabled); return; } if(!startOperation("retention"))return; void api.setRetention(session.id,enabled,requestKey()).then(acceptSession).catch(failure=>setError(errorMessage(failure))).finally(endOperation); }}
        onEndProcess={()=>{ if(!session||!startOperation("ending-process"))return; void api.endKeptProcess(session.id,requestKey()).then(acceptSession).catch(failure=>setError(errorMessage(failure))).finally(endOperation); }}
        onFreeWorkspace={async run=>{ if(!session)return;
          // The conversation whose kept process holds this workspace ends it with the normal stop chain, then this message is sent again.
          try { const holder=(await api.keptProcesses()).find(item=>item.workspace===session.workspace&&item.sessionId!==session.id); if(holder) await api.endKeptProcess(holder.sessionId,requestKey()); await send(run.input,run.attachments ?? []); }
          catch(failure){ setError(errorMessage(failure)); } }} onPermission={(permission,option,input)=>{ if(!sessionId||!startOperation("permission"))return; void api.decidePermission(sessionId,permission,option,requestKey(),input).then(()=>api.session(sessionId)).then(acceptSession).catch(failure=>setError(errorMessage(failure))).finally(endOperation); }}
        nativeModels={nativeCatalog} nativeModelsLoading={nativeLoading} nativeModelsError={nativeError} onRefreshModels={refreshNativeModels} key={chatKey} session={session} sessionRequested={sessionId !== null} sessionError={sessionError} loading={sessionLoading} draft={draft}
        messageDraft={messageDraft} onMessageDraft={setMessageDraft} providers={state.providers} harnesses={state.harnesses} readiness={state.readiness} rememberedChoice={rememberedChoice} workspace={workspace} mutation={mutation} error={error ?? draftStorageError} connectionError={connectionError}
        onRetryConnection={() => setStreamAttempt(value => value + 1)} onDraft={changeSelection} onWorkspace={setWorkspace} onSend={send} attachments={attachments} onAttach={attachFiles} onRemoveAttachment={removeAttachment} onBranch={branch} onOpenSession={selectSession}
        sessionTitle={id => state.sessions.find(item => item.id === id)?.title ?? null} attention={attention?.items ?? null} onCancelQueued={cancelQueued} onLoadNativeResume={session ? signal => api.nativeResume(session.id, signal) : undefined}
        onLoadExtensions={signal => api.nativeExtensions(draft.harnessId, draft.controlId, session?.workspace ?? workspace, signal)} onLoadNativeSessions={(cursor, signal, probes) => api.nativeSessions(draft.harnessId, draft.controlId, session?.workspace ?? workspace, cursor, signal, probes)}
        onImportNative={importNative} onApply={() => { lastAutoSelection.current = null; void applySelection(); }} onCancel={() => void cancel()} onClose={() => void close()} onDismissError={() => { setError(null); setDraftStorageError(null); }}
        onProviders={() => navigate("providers")} onNew={newChat} onMenu={shell.onMenu}
        queued={queued} onQueue={queueMessage} onEditQueued={() => { if (queued) returnQueued(queued, null); }} onWithdrawQueued={withdrawQueued} queueNotice={queueNotice} onDismissQueueNotice={() => setQueueNotice(null)}
        preferences={preferences} onPreference={setPreference} conversations={state.sessions.length} sidebarHidden={!narrow && !preferences.sidebar} onExpandSidebar={shell.onExpandSidebar} onHarnesses={() => navigate("harnesses")} onSettings={() => navigate("settings")} onRescan={() => void rescan()} scanning={mutation === "scanning"}/>
        : shown === "providers" ? <ProvidersPage providers={state.providers} editor={editor} saving={mutation === "saving"} probes={probes} error={error} onEdit={provider => { setEditor(provider); setError(null); }} onBack={() => leave(() => { setEditor(null); setEditorDirty(false); setError(null); })} onSave={saveProvider} onProbe={provider => void probeProvider(provider)} onDirty={dirtyChanged} onDismissError={() => setError(null)} {...shell} sidebarHidden={!narrow && !preferences.sidebar}/>
        : shown === "capabilities" ? <CapabilitiesPage api={api} initialHarness={capabilityHarness} {...shell} sidebarHidden={!narrow && !preferences.sidebar}/>
        : shown === "settings" ? <SettingsPage api={api} preferences={preferences} onPreference={setPreference} onRescan={() => void rescan()} scanning={mutation === "scanning"} {...shell} sidebarHidden={!narrow && !preferences.sidebar}/>
        : <HarnessesPage api={api} harnesses={state.harnesses} installationPolicy={state.installationPolicy} onUninstall={uninstall} onInstallOfficial={installOfficial} onUpgradeInstallation={upgradeInstallation} jobs={state.jobs} scanning={mutation === "scanning"} checking={checkingUpdates} submitting={submittingInstallations} cancelling={cancellingInstallations} unconfirmed={unconfirmedInstallations} error={error} connectionError={managementConnectionError} onRescan={() => void rescan()} onCheckUpdates={ids => void checkUpdates(ids)} onInstall={install} onOpenSession={selectSession} onConfirm={confirmInstallation} onCancelJob={job => void cancelInstallation(job)} onDismissError={() => setError(null)} onChoose={chooseHarness} onCapabilities={id => { setCapabilityHarness(id); navigate("capabilities"); }} {...shell} sidebarHidden={!narrow && !preferences.sidebar}/>}
    </main>
    {leaveAction ? <div className="fixed right-4 bottom-4 left-4 z-[70] mx-auto max-w-[560px]"><Notice tone="amber" title="有尚未保存的修改" action={<><button className="btn btn-sm" onClick={() => setLeaveAction(null)}>继续编辑</button><button className="btn btn-sm btn-primary" onClick={() => { const action = leaveAction; setLeaveAction(null); setEditorDirty(false); action(); }}>放弃修改，离开</button></>} onDismiss={() => setLeaveAction(null)}>离开会丢弃编辑草稿。已受理的请求可在列表中查看。</Notice></div> : null}
    <CommandPalette open={palette} onOpenChange={setPalette} commands={commands}/>
    <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts}/>
  </div></TipProvider>;
}
