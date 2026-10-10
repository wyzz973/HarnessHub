import { AlertCircle, ArrowRight, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SelectionRequest } from "../../src/contracts/session.js";
import type { ProviderView, ProviderWriteInput } from "../../src/contracts/provider.js";
import type { HarnessView, SessionView, WebState } from "../../src/contracts/web.js";
import type { InstallationJobView, ManagementJobInput } from "../../src/contracts/management.js";
import { sessionId as validateSessionId } from "../../src/contracts/session.js";
import { ApiError, errorMessage, GatewayApi, requestKey } from "./api.js";
import { ChatPage, effectiveProviderProblem, EMPTY_SELECTION, selectionDraft, selectionProblem, selectionRequest } from "./components/ChatPage.js";
import type { SelectionDraft } from "./components/ChatPage.js";
import { HarnessesPage, installationActive } from "./components/HarnessesPage.js";
import type { UnconfirmedInstallation } from "./components/HarnessesPage.js";
import { ProvidersPage } from "./components/ProvidersPage.js";
import type { ProviderProbeState } from "./components/ProvidersPage.js";
import { Sidebar } from "./components/Sidebar.js";
import type { Page } from "./components/Sidebar.js";
import { BrandMark, Spinner } from "./components/common.js";

interface PendingMessage { text: string; createKey: string; sessionId: string | null; sendKey: string; committed: boolean }
interface PendingProviderWrite { input: ProviderWriteInput; key: string; current: ProviderView | undefined }
function sessionRoute(): { id: string | null; error: string | null } {
  const value = new URLSearchParams(window.location.hash.slice(1)).get("session");
  if (value === null) return { id: null, error: null };
  try { return { id: validateSessionId(value), error: null }; }
  catch { return { id: null, error: "链接中的会话编号无效。请从最近对话中重新打开，或明确新建一个对话。" }; }
}
function writeSessionRoute(id: string | null): void {
  window.history.replaceState(null, "", window.location.pathname + (id ? "#" + new URLSearchParams({ session: id }).toString() : ""));
}
export function App() {
  const [api] = useState(() => new GatewayApi());
  const [initialRoute] = useState(sessionRoute);
  const [state, setState] = useState<WebState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [page, setPage] = useState<Page>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(initialRoute.id);
  const [session, setSession] = useState<SessionView | null>(null);
  const [sessionLoading, setSessionLoading] = useState(initialRoute.id !== null);
  const [sessionError, setSessionError] = useState<string | null>(initialRoute.error);
  const [chatKey, setChatKey] = useState(0);
  const [draft, setDraft] = useState<SelectionDraft>({ ...EMPTY_SELECTION });
  const [messageDraft, setMessageDraft] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [mutation, setMutation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
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
  const operation = useRef(false);
  const pendingMessage = useRef<PendingMessage | null>(null);
  const pendingSwitchWrite = useRef<{ sessionId: string; selection: SelectionRequest; key: string } | null>(null);
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
        if (!ignored) { snapshot.jobs.filter(job => job.status === "completed").forEach(job => completedInstallations.current.add(job.id)); setState(snapshot); setWorkspace(snapshot.workspace); }
      } catch (failure: unknown) { if (!ignored) setBootError(errorMessage(failure)); }
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
    if (observedVersion.current?.id === value.id && observedVersion.current.version > value.version) return;
    observedVersion.current = { id: value.id, version: value.version };
    setSession(current => current && current.id === value.id && current.version > value.version ? current : value);
    setSessionLoading(false);
    const intent = pendingSwitchWrite.current;
    if (intent?.sessionId === value.id && value.switches.some(item => item.commandId === intent.key)) pendingSwitchWrite.current = null;
    const key = `${value.id}:${value.epoch}`;
    if (observedSelection.current !== key) { observedSelection.current = key; setDraft(selectionDraft(value.selection)); }
    if (pendingMessage.current?.sessionId === value.id && value.runs.some(run => run.commandId === pendingMessage.current?.sendKey)) pendingMessage.current.committed = true;
    setState(current => current ? { ...current, sessions: current.sessions.map(summary => summary.id === value.id
      ? { ...summary, selection: value.selection, status: value.status, activeRunId: value.activeRunId, updatedSeq: value.lastSeq,
          title: value.messages.find(message => message.role === "user")?.text.slice(0, 80) ?? summary.title }
      : summary) } : current);
  }, []);
  useEffect(() => {
    if (!sessionId || !state) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const controller = new AbortController();
    const poll = async () => {
      let delay = 2000;
      try {
        const value = await api.session(sessionId, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (stopped) return;
        failures = 0; setConnectionError(null); acceptSession(value);
        delay = value.activeRunId || value.pendingSwitchId || value.runs.some(run => run.status === "queued") ? 500 : 2000;
      } catch (failure: unknown) {
        if (stopped) return;
        if (failure instanceof ApiError && failure.code.includes("NOT_FOUND")) {
          setSessionError(errorMessage(failure)); setSessionLoading(false); setConnectionError(null); return;
        }
        failures += 1; setConnectionError(errorMessage(failure));
        delay = Math.min(15_000, 1000 * 2 ** Math.min(failures, 4));
      }
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? Math.max(delay, 10_000) : delay);
    };
    void poll();
    return () => { stopped = true; if (timer !== null) clearTimeout(timer); controller.abort(); };
    // State is needed only to start after authentication. Snapshot revisions do not restart the polling owner.
  }, [api, sessionId, state !== null, acceptSession]);
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
  const leave = (action: () => void) => {
    if (operation.current) return;
    const finish = () => { pendingProviderWrite.current = null; action(); };
    if (editorDirty) { setLeaveAction(() => finish); return; }
    finish();
  };
  const navigate = (next: Page) => leave(() => { setPage(next); setEditor(null); setEditorDirty(false); setSidebarOpen(false); setError(null); });
  const newChat = () => leave(() => {
    sessionIdRef.current = null; observedSelection.current = ""; pendingMessage.current = null;
    writeSessionRoute(null); setSessionId(null); setSession(null); setSessionLoading(false); setSessionError(null); setDraft({ ...EMPTY_SELECTION }); setMessageDraft(""); setChatKey(value => value + 1);
    setPage("chat"); setEditor(null); setEditorDirty(false); setSidebarOpen(false); setError(null); setConnectionError(null);
  });
  const selectSession = (id: string) => leave(() => {
    if (sessionIdRef.current !== id) { sessionIdRef.current = id; observedSelection.current = ""; pendingMessage.current = null; writeSessionRoute(id); setSessionId(id); setSession(null); setSessionLoading(true); setSessionError(null); setMessageDraft(""); setChatKey(value => value + 1); }
    setPage("chat"); setEditor(null); setEditorDirty(false); setSidebarOpen(false); setError(null); setConnectionError(null);
  });
  const chooseHarness = (harness: HarnessView) => leave(() => {
    const control = harness.controls.find(row => row.id === harness.defaultControlId && row.available) ?? harness.controls.find(row => row.available); if (!control) return;
    sessionIdRef.current = null; observedSelection.current = ""; pendingMessage.current = null;
    writeSessionRoute(null); setSessionId(null); setSession(null); setSessionLoading(false); setSessionError(null); setDraft({ ...EMPTY_SELECTION, harnessId: harness.id, controlId: control.id }); setMessageDraft("");
    setChatKey(value => value + 1); setPage("chat"); setSidebarOpen(false); setError(null); setConnectionError(null);
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); newChat(); }
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  });
  const startOperation = (label: string): boolean => { if (operation.current) return false; operation.current = true; setMutation(label); setError(null); return true; };
  const endOperation = () => { operation.current = false; if (mounted.current) setMutation(null); };
  const send = async (value: string) => {
    if (!state || !startOperation("sending")) return;
    try {
      const isEffective = session !== null && JSON.stringify(draft) === JSON.stringify(selectionDraft(session.selection));
      const problem = isEffective && session ? effectiveProviderProblem(session.selection, state.providers) : selectionProblem(draft, state.harnesses, state.providers); if (problem) throw new ApiError("INVALID_SELECTION", problem);
      const previous = pendingMessage.current;
      if (previous && !previous.committed && previous.text !== value) throw new ApiError("UNCONFIRMED_REQUEST", "上一条消息的接收结果还未确认。请保留原消息重试，或等待历史更新后再发送新内容。");
      const request = previous?.text === value ? previous : { text: value, createKey: requestKey(), sessionId: sessionIdRef.current, sendKey: requestKey(), committed: false };
      pendingMessage.current = request;
      let id = request.sessionId;
      if (id === null) {
        const created = await api.createSession(workspace, selectionRequest(draft), request.createKey);
        id = created.id; request.sessionId = id; sessionIdRef.current = id; writeSessionRoute(id); setSessionId(id); acceptSession(created);
      }
      if (!request.committed) { await api.send(id, value, request.sendKey); request.committed = true; }
      acceptSession(await api.session(id, AbortSignal.timeout(15_000)));
      await refreshState();
      pendingMessage.current = null;
    } catch (failure: unknown) {
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "UNCONFIRMED_REQUEST"].includes(failure.code) && !pendingMessage.current?.committed) pendingMessage.current = null;
      if (mounted.current) setError(errorMessage(failure)); throw failure;
    } finally { endOperation(); }
  };
  const applySelection = async () => {
    if (!sessionId || !startOperation("switching")) return;
    try {
      const target = selectionRequest(draft), previous = pendingSwitchWrite.current;
      if (previous?.sessionId === sessionId && JSON.stringify(previous.selection) !== JSON.stringify(target))
        throw new ApiError("UNCONFIRMED_REQUEST", "上一次切换的接收结果还未确认。请保留原选择重试，或等待对话更新。");
      const request = previous?.sessionId === sessionId ? previous : { sessionId, selection: target, key: requestKey() };
      pendingSwitchWrite.current = request;
      await api.switchSelection(sessionId, request.selection, request.key); pendingSwitchWrite.current = null;
      acceptSession(await api.session(sessionId, AbortSignal.timeout(15_000)));
    }
    catch (failure: unknown) {
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "UNCONFIRMED_REQUEST"].includes(failure.code)) pendingSwitchWrite.current = null;
      setError(errorMessage(failure));
    }
    finally { endOperation(); }
  };
  const cancel = async () => {
    if (!sessionId || !startOperation("cancelling")) return;
    try { await api.cancel(sessionId, requestKey()); acceptSession(await api.session(sessionId, AbortSignal.timeout(15_000))); }
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
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE", "UNCONFIRMED_REQUEST"].includes(failure.code)) pendingProviderWrite.current = null;
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
      if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE"].includes(failure.code)) { installationWrites.current.delete(input.harnessId); setError(message); }
      else setUnconfirmedInstallations(current => [{ harnessId: input.harnessId, action: input.action, message }, ...current.filter(item => item.harnessId !== input.harnessId)]);
    } finally { installationRequests.current.delete(input.harnessId); if (mounted.current) setSubmittingInstallations(current => current.filter(id => id !== input.harnessId)); }
  };
  const install = (harness: HarnessView, action: "install" | "upgrade") => {
    const previous = installationWrites.current.get(harness.id);
    if (previous && previous.action !== action) { setError("上一次安装请求的接收结果还未确认。请先确认原请求，再发起其他操作。"); return; }
    const controlId = harness.management.recipe?.controlId;
    if (!controlId) { setError("这个 Harness 暂无受管安装配方。"); return; }
    const input = previous ?? { harnessId: harness.id, controlId, action, commandId: requestKey(), expectedDefaultRevision: harness.management.defaultRevision };
    installationWrites.current.set(harness.id, input); void submitInstallation(input);
  };
  const confirmInstallation = (id: string) => { const input = installationWrites.current.get(id); if (input) void submitInstallation(input); };
  const cancelInstallation = async (job: InstallationJobView) => {
    if (cancellationRequests.current.has(job.id)) return;
    cancellationRequests.current.add(job.id); setCancellingInstallations(current => [...current, job.id]); setError(null);
    const key = installationCancels.current.get(job.id) ?? requestKey(); installationCancels.current.set(job.id, key);
    try { acceptInstallation(await api.cancelInstallation(job.id, key)); installationCancels.current.delete(job.id); }
    catch (failure: unknown) { if (failure instanceof ApiError && !["NETWORK_ERROR", "INVALID_RESPONSE"].includes(failure.code)) installationCancels.current.delete(job.id); setError(errorMessage(failure)); }
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
  if (!state) return <div className="boot-screen"><BrandMark/><h1>Harness<span>Hub</span></h1>{bootError ? <><div className="boot-error" role="alert"><AlertCircle size={18}/><p>{bootError}</p></div><p className="boot-help">请使用本机网关启动时提供的入口链接。验证完成后，页面会自动隐藏链接中的令牌。</p><button className="button secondary" onClick={() => setBootAttempt(value => value + 1)}><RefreshCw size={15}/>重新连接</button></> : <div className="boot-progress" role="status"><Spinner/>正在连接你的工作空间</div>}</div>;
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳到主要内容</a><Sidebar page={page} sessions={state.sessions} currentId={sessionId} open={sidebarOpen} collapsed={sidebarCollapsed} activeJobs={state.jobs.filter(installationActive).length} interactionBusy={mutation !== null} onCollapse={() => setSidebarCollapsed(value => !value)} onToggle={() => setSidebarOpen(value => !value)} onPage={navigate} onNew={newChat} onSession={selectSession}/>
    <main id="main-content" className="app-main" tabIndex={-1}>
      {page === "chat" ? <ChatPage key={chatKey} session={session} sessionRequested={sessionId !== null} sessionError={sessionError} loading={sessionLoading} draft={draft} messageDraft={messageDraft} onMessageDraft={setMessageDraft} providers={state.providers} harnesses={state.harnesses} workspace={workspace} mutation={mutation} error={error} connectionError={connectionError} onDraft={setDraft} onWorkspace={setWorkspace} onSend={send} onApply={() => void applySelection()} onCancel={() => void cancel()} onClose={() => void close()} onDismissError={() => setError(null)} onProviders={() => navigate("providers")} onNew={newChat} onMenu={() => setSidebarOpen(value => !value)}/>
        : page === "providers" ? <ProvidersPage providers={state.providers} editor={editor} saving={mutation === "saving"} probes={probes} error={error} onEdit={provider => { setEditor(provider); setError(null); }} onBack={() => leave(() => { setEditor(null); setEditorDirty(false); setError(null); })} onSave={saveProvider} onProbe={provider => void probeProvider(provider)} onDirty={dirtyChanged} onDismissError={() => setError(null)} onMenu={() => setSidebarOpen(value => !value)}/>
          : <HarnessesPage api={api} harnesses={state.harnesses} jobs={state.jobs} scanning={mutation === "scanning"} checking={checkingUpdates} submitting={submittingInstallations} cancelling={cancellingInstallations} unconfirmed={unconfirmedInstallations} error={error} connectionError={managementConnectionError} onRescan={() => void rescan()} onCheckUpdates={ids => void checkUpdates(ids)} onInstall={install} onConfirm={confirmInstallation} onCancelJob={job => void cancelInstallation(job)} onDismissError={() => setError(null)} onMenu={() => setSidebarOpen(value => !value)} onChoose={chooseHarness}/>}
    </main>
    {leaveAction ? <div className="leave-notice" role="alert"><div><strong>有尚未保存的修改</strong><p>离开会丢弃编辑草稿。已受理的请求可在列表中查看。</p></div><button className="button secondary" onClick={() => setLeaveAction(null)}>继续编辑</button><button className="button primary" onClick={() => { const action = leaveAction; setLeaveAction(null); setEditorDirty(false); action(); }}>放弃修改，离开<ArrowRight size={14}/></button><button className="icon-button" aria-label="关闭提示，继续编辑" onClick={() => setLeaveAction(null)}><X size={16}/></button></div> : null}
  </div>;
}
