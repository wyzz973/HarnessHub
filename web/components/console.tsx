"use client";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  CircleAlert,
  Menu,
  PanelRight,
  RefreshCw,
  ShieldAlert,
  SquarePen,
  Trophy,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, readEvents } from "@/lib/api";
import {
  type AgentEvent,
  type Engine,
  type HarnessModelView,
  type Observation,
  type Overview,
  type Run,
  type Selection,
  type Session,
  type Workflow,
  type Workspace,
  isTerminal,
  selectionSchema,
} from "@/lib/contracts";
import { engineName } from "@/lib/engines";
import { useGatewayStatus } from "@/lib/gateway-status";
import { cn } from "@/lib/utils";
import {
  competitionOrigin,
  parseOutputPaths,
  projectEvents,
} from "@/lib/presentation";
import {
  Composer,
  Greeting,
  Messages,
  RunThreadProvider,
  ScrollToBottom,
  Suggestions,
  WorkflowPlan,
} from "./thread";
import { ConnectModel } from "./onboarding";
import { Inspector, type RunPanelTab } from "./inspector";
import { EnginePage } from "./engine-page";
import { LogPanel } from "./log-panel";
import { ObservabilityPage } from "./observability-page";
import { ModelPage } from "./model-page";
import { Sidebar, type HistoryItem, type Page } from "./sidebar";
import { ToolPacksPage } from "./tool-packs-page";

type ActiveSelection = { type: "session" | "workflow"; id: string } | null;
const ENGINE_KEY = "harnesshub.engine";
const SIDEBAR_KEY = "harnesshub.sidebar";
const panelTransition = { duration: 0.24, ease: [0.22, 0.8, 0.24, 1] } as const;
const overlayQuery = "(max-width: 1100px)";
function subscribeOverlay(listener: () => void) {
  const media = window.matchMedia(overlayQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is optional; the choice then lasts for this page only. */
  }
}
/** History refresh period; also picks up sessions created through the Competition API. */
const HISTORY_POLL_MS = 3000;
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike =>
  message;
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
/** Newer records replace older ones by id; records only known locally (opened by id) are kept. */
function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const ids = new Set(incoming.map((item) => item.id));
  return [...incoming, ...current.filter((item) => !ids.has(item.id))];
}
function sameItems<T>(a: T[], b: T[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
const runSignature = (runs: Run[]) =>
  runs
    .map((run) => `${run.id}:${run.status}:${run.lastSeq}:${run.cleanupStatus}`)
    .join("|");

export function Console() {
  const gateway = useGatewayStatus();
  const runtimeInfo =
    gateway.runtime.state === "ready" ? gateway.runtime.value : undefined;
  const unifiedModel =
    gateway.model.state === "ready" ? gateway.model.value : undefined;
  const modelMissing =
    gateway.model.state === "ready" && !gateway.model.value.configured;
  const [page, setPage] = useState<Page>("tasks");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<RunPanelTab>("overview");
  const [logsRunId, setLogsRunId] = useState<string | null>(null);
  // The card stays open from the moment a missing model is seen until the person finishes
  // or skips; saving alone must not close it because the connection check is still running.
  const [onboarding, setOnboarding] = useState<"idle" | "open" | "closed">(
    "idle",
  );
  const overlayPanel = useSyncExternalStore(
    subscribeOverlay,
    () => window.matchMedia(overlayQuery).matches,
    () => false,
  );
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [defaultEngine, setDefaultEngine] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [allRuns, setAllRuns] = useState<Run[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [active, setActive] = useState<ActiveSelection>(null);
  const [currentRuns, setCurrentRuns] = useState<Run[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const eventSequences = useRef(new Map<string, number>());
  const runCache = useRef(new Map<string, Run>());
  const historySignature = useRef("");
  const requestedSessions = useRef(new Set<string>());
  // Several refreshers overlap (active change, running poll, history poll, local submit);
  // only results newer than the last applied view may replace the displayed runs.
  const viewStarted = useRef(0);
  const viewApplied = useRef(0);
  const [observations, setObservations] = useState<Record<string, Observation>>(
    {},
  );
  const [selection, setSelection] = useState<Selection | undefined>();
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "direct">("direct");
  const [engineId, setEngineIdState] = useState("auto");
  const engineChosen = useRef(false);
  const setEngineId = useCallback((id: string) => {
    engineChosen.current = true;
    setEngineIdState(id);
    store(ENGINE_KEY, id);
  }, []);
  useEffect(() => {
    if (modelMissing)
      setOnboarding((current) => (current === "idle" ? "open" : current));
  }, [modelMissing]);
  const toggleSidebar = useCallback(() => {
    setMobileNav(false);
    setSidebarCollapsed((value) => {
      store(SIDEBAR_KEY, value ? "open" : "collapsed");
      return !value;
    });
  }, []);
  // Remembered choices are applied after hydration so server and client markup agree.
  useEffect(() => {
    setSidebarCollapsed(stored(SIDEBAR_KEY) === "collapsed");
    const remembered = stored(ENGINE_KEY);
    if (remembered) {
      engineChosen.current = true;
      setEngineIdState(remembered);
    }
  }, []);
  const [workspaceId, setWorkspaceId] = useState("");
  const [outputPaths, setOutputPaths] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const report = useCallback((err: unknown) => setError(messageOf(err)), []);

  const applyHistory = useCallback(
    (sessionList: Session[], runList: Run[], workflowList: Workflow[]) => {
      const signature = [
        sessionList.map((s) => `${s.id}:${s.status}:${s.updatedAt}`).join("|"),
        runSignature(runList),
        workflowList.map((w) => `${w.id}:${w.status}:${w.updatedAt}`).join("|"),
      ].join("#");
      // Unchanged polls keep state identity so the thread does not re-render every period.
      if (signature === historySignature.current) return;
      historySignature.current = signature;
      setSessions((current) => mergeById(current, sessionList));
      setAllRuns((current) =>
        mergeById(current, runList).sort((a, b) => b.createdAt - a.createdAt),
      );
      setWorkflows((current) => mergeById(current, workflowList));
    },
    [],
  );
  const refreshHistory = useCallback(
    async (signal?: AbortSignal) => {
      const [sessionList, runList, workflowList] = await Promise.all([
        api.sessions(signal),
        api.runs(signal),
        api.workflows(signal),
      ]);
      applyHistory(sessionList.sessions, runList.runs, workflowList.workflows);
    },
    [applyHistory],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [engineList, workspaceList] = await Promise.all([
        api.engines(signal),
        api.workspaces(signal),
      ]);
      setEngines(engineList.engines);
      setEngineIdState((current) =>
        current === "auto" ||
        engineList.engines.some(
          (engine) => engine.id === current && engine.enabled,
        )
          ? current
          : "auto",
      );
      setWorkspaces(workspaceList.workspaces);
      setDefaultEngine(workspaceList.defaultEngine);
      setWorkspaceId(
        (current) =>
          current ||
          workspaceList.defaultWorkspace ||
          workspaceList.workspaces[0]?.id ||
          "",
      );
      historySignature.current = "";
      await refreshHistory(signal);
    },
    [refreshHistory],
  );
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const session = params.get("session"),
      workflowId = params.get("workflow");
    if (workflowId) {
      setActive({ type: "workflow", id: workflowId });
      setMode("auto");
    } else if (session) setActive({ type: "session", id: session });
    refresh(controller.signal)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) report(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, report]);
  // Competition mode preselects the engine used by the Competition API until the user picks one.
  useEffect(() => {
    const target = runtimeInfo?.competition
      ? runtimeInfo.competitionEngine
      : undefined;
    if (!target || engineChosen.current) return;
    if (engines.some((engine) => engine.id === target && engine.enabled))
      setEngineIdState(target);
  }, [runtimeInfo, engines]);
  // A session opened by id (URL, observability page) may be older than the history page.
  useEffect(() => {
    if (
      loading ||
      active?.type !== "session" ||
      sessions.some((session) => session.id === active.id) ||
      requestedSessions.current.has(active.id)
    )
      return;
    requestedSessions.current.add(active.id);
    const controller = new AbortController();
    api
      .session(active.id, controller.signal)
      .then((session) =>
        setSessions((current) => mergeById(current, [session])),
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted) report(err);
      });
    return () => controller.abort();
  }, [loading, active, sessions, report]);

  const choose = useCallback((next: ActiveSelection) => {
    activeRef.current = next;
    viewApplied.current = ++viewStarted.current;
    setActive(next);
    setCurrentRuns([]);
    setWorkflow(null);
    setFocusedRunId(null);
    setSelection(undefined);
    setError(null);
    setStreamError(false);
    setPage("tasks");
    setMobileNav(false);
    window.history.replaceState(
      null,
      "",
      next
        ? `?${next.type}=${encodeURIComponent(next.id)}`
        : window.location.pathname,
    );
    if (next?.type === "session") setMode("direct");
    if (next?.type === "workflow") setMode("auto");
  }, []);

  const mergeEvents = useCallback((id: string, batch: AgentEvent[]) => {
    if (!batch.length) return;
    eventSequences.current.set(
      id,
      Math.max(
        eventSequences.current.get(id) ?? 0,
        ...batch.map((event) => event.seq),
      ),
    );
    setEvents((current) => {
      const previous = current[id] ?? [];
      const known = new Set(previous.map((event) => event.seq));
      const additions = batch.filter((event) => !known.has(event.seq));
      return additions.length
        ? {
            ...current,
            [id]: [...previous, ...additions].sort((a, b) => a.seq - b.seq),
          }
        : current;
    });
  }, []);
  /** Terminal runs whose summary did not change reuse the cached detail (permissions, artifacts). */
  const loadRun = useCallback(async (summary: Run, signal?: AbortSignal) => {
    const cached = runCache.current.get(summary.id);
    if (
      cached &&
      isTerminal(summary.status) &&
      cached.status === summary.status &&
      cached.lastSeq === summary.lastSeq &&
      cached.cleanupStatus === summary.cleanupStatus
    )
      return cached;
    const full = await api.run(summary.id, signal);
    runCache.current.set(full.id, full);
    return full;
  }, []);
  const refreshCurrent = useCallback(
    async (selected: NonNullable<ActiveSelection>, signal?: AbortSignal) => {
      const started = ++viewStarted.current;
      const stale = () =>
        activeRef.current?.id !== selected.id || started < viewApplied.current;
      let nextRuns: Run[];
      let nextWorkflow: Workflow | undefined;
      if (selected.type === "workflow") {
        const loaded = await api.workflow(selected.id, signal);
        if (stale()) return;
        nextWorkflow = loaded;
        nextRuns = await Promise.all(
          loaded.steps.flatMap((step) =>
            step.runId ? [api.run(step.runId, signal)] : [],
          ),
        );
      } else {
        const list = await api.sessionRuns(selected.id, signal);
        nextRuns = await Promise.all(
          list.runs.map((run) => loadRun(run, signal)),
        );
        nextRuns.sort((a, b) => a.createdAt - b.createdAt);
      }
      // An older response must not overwrite a newer view, e.g. a run just submitted.
      if (stale()) return;
      viewApplied.current = started;
      if (nextWorkflow) {
        const applied = nextWorkflow;
        setWorkflow(applied);
        setWorkflows((current) => [
          applied,
          ...current.filter((item) => item.id !== applied.id),
        ]);
      }
      setCurrentRuns((current) =>
        sameItems(current, nextRuns) ? current : nextRuns,
      );
      setAllRuns((current) =>
        nextRuns.every((run) => current.includes(run))
          ? current
          : mergeById(current, nextRuns).sort(
              (a, b) => b.createdAt - a.createdAt,
            ),
      );
      setFocusedRunId((current) =>
        current && nextRuns.some((run) => run.id === current)
          ? current
          : (nextRuns.findLast((run) => !isTerminal(run.status))?.id ??
            nextRuns.at(-1)?.id ??
            null),
      );
      await Promise.all(
        nextRuns.map(async (run) => {
          let cursor = eventSequences.current.get(run.id) ?? 0;
          while (cursor < run.lastSeq) {
            const batch = await api.events(run.id, cursor, signal);
            if (!batch.events.length) break;
            mergeEvents(run.id, batch.events);
            cursor = batch.events.at(-1)!.seq;
          }
        }),
      );
    },
    [loadRun, mergeEvents],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    refreshCurrent(active, controller.signal).catch((err: unknown) => {
      if (!controller.signal.aborted) report(err);
    });
    return () => controller.abort();
  }, [active, refreshEpoch, refreshCurrent, report]);
  const running =
    pendingAction ||
    currentRuns.some((run) => !isTerminal(run.status)) ||
    (!!workflow &&
      ["planning", "running", "cancelling"].includes(workflow.status));
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    if (!active || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await refreshCurrent(active, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) report(err);
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void tick(), 1300);
      }
    };
    timer = setTimeout(() => void tick(), 1300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, running, refreshCurrent, report]);
  // History and the idle open session refresh every period while the tab is visible,
  // so runs submitted by other clients (e.g. judges via the Competition API) appear.
  useEffect(() => {
    if (loading) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          await refreshHistory(controller.signal);
          const selected = activeRef.current;
          if (selected?.type === "session" && !runningRef.current)
            await refreshCurrent(selected, controller.signal);
          setSyncError(null);
        } catch (err) {
          if (controller.signal.aborted) return;
          setSyncError(messageOf(err));
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void tick(), HISTORY_POLL_MS);
    };
    timer = setTimeout(() => void tick(), HISTORY_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [loading, refreshHistory, refreshCurrent]);
  const activeRunKey = currentRuns
    .filter((run) => !isTerminal(run.status))
    .map((run) => run.id)
    .join(",");
  useEffect(() => {
    if (!activeRunKey) return;
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    for (const id of activeRunKey.split(",")) {
      let batch: AgentEvent[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        if (timer) {
          clearTimeout(timer);
          timers.delete(timer);
          timer = undefined;
        }
        if (batch.length && !controller.signal.aborted) {
          mergeEvents(id, batch);
          batch = [];
        }
      };
      readEvents(
        id,
        eventSequences.current.get(id) ?? 0,
        (event) => {
          batch.push(event);
          if (!timer) {
            timer = setTimeout(flush, 40);
            timers.add(timer);
          }
        },
        controller.signal,
      ).then(
        () => {
          flush();
          const selected = activeRef.current;
          if (!selected || controller.signal.aborted) return;
          // The Gateway ends the stream only at the committed terminal state;
          // show it now instead of waiting for the next poll.
          return refreshCurrent(selected, controller.signal).catch(
            (err: unknown) => {
              if (!controller.signal.aborted) report(err);
            },
          );
        },
        () => {
          if (!controller.signal.aborted) {
            flush();
            setStreamError(true);
          }
        },
      );
    }
    return () => {
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [activeRunKey, mergeEvents, refreshCurrent, refreshEpoch, report]);
  const focusedRun =
    currentRuns.find((run) => run.id === focusedRunId) ?? currentRuns.at(-1);
  useEffect(() => {
    if (!focusedRun) return;
    const controller = new AbortController();
    api
      .observation(focusedRun.id, controller.signal)
      .then((value) =>
        setObservations((current) => ({ ...current, [value.runId]: value })),
      )
      .catch((err: unknown) => {
        if (!controller.signal.aborted) report(err);
      });
    return () => controller.abort();
  }, [focusedRun?.id, focusedRun?.lastSeq, focusedRun?.status, report]);
  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      setOverview(await api.overview());
    } catch (err) {
      report(err);
    } finally {
      setOverviewLoading(false);
    }
  }, [report]);
  useEffect(() => {
    if (page === "observability") void loadOverview();
  }, [page, loadOverview]);

  const boundSession =
    active?.type === "session"
      ? sessions.find((session) => session.id === active.id)
      : undefined;
  const boundOrigin = competitionOrigin(boundSession);
  async function submit(message: AppendMessage) {
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (!text || running) return;
    setPendingAction(true);
    setError(null);
    try {
      if (mode === "auto") {
        const created = await api.createWorkflow(
          text,
          engineId,
          workspaceId || undefined,
          crypto.randomUUID(),
        );
        choose({ type: "workflow", id: created.id });
        setWorkflow(created);
        setWorkflows((current) => [created, ...current]);
      } else {
        // Continue the open session even when it is not in the loaded history page.
        let session =
          active?.type === "session"
            ? (sessions.find((item) => item.id === active.id) ??
              (await api.session(active.id)))
            : undefined;
        if (session && competitionOrigin(session))
          throw new Error("此会话由比赛 API 创建，控制台只读显示。");
        let selected: Selection | undefined;
        if (!session) {
          if (engineId === "auto") {
            const response = await api.autoSession(workspaceId || undefined);
            session = response.session;
            selected = response.selection;
          } else
            session = await api.createSession(
              engineId,
              workspaceId || undefined,
            );
        }
        const opened = session;
        setSessions((current) => mergeById(current, [opened]));
        const run = await api.submit(
          opened.id,
          text,
          crypto.randomUUID(),
          parseOutputPaths(outputPaths),
        );
        if (active?.id !== opened.id)
          choose({ type: "session", id: opened.id });
        if (selected) setSelection(selected);
        // Refreshes that started before this submission cannot know the new run.
        viewApplied.current = ++viewStarted.current;
        setCurrentRuns((current) => [...current, run]);
        setAllRuns((current) => [run, ...current]);
        setFocusedRunId(run.id);
      }
    } catch (err) {
      report(err);
      throw err;
    } finally {
      setPendingAction(false);
    }
  }
  const perform = useCallback(
    async (work: () => Promise<unknown>) => {
      setPendingAction(true);
      setError(null);
      try {
        await work();
        if (activeRef.current) await refreshCurrent(activeRef.current);
        await refresh();
      } catch (err) {
        report(err);
      } finally {
        setPendingAction(false);
      }
    },
    [refresh, refreshCurrent, report],
  );
  const stop = () =>
    void perform(async () => {
      if (workflow && !isTerminal(workflow.status))
        await api.cancelWorkflow(workflow.id);
      else
        await Promise.all(
          currentRuns
            .filter((run) => !isTerminal(run.status))
            .map((run) => api.cancel(run.id)),
        );
    });
  const inspect = useCallback((runId: string) => {
    setFocusedRunId(runId);
    setInspectorOpen(true);
  }, []);
  const sessionEngines = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.engineId])),
    [sessions],
  );
  const engineOf = useCallback(
    (run: Run) => sessionEngines.get(run.sessionId),
    [sessionEngines],
  );
  const decide = useCallback(
    (id: string, optionId: string) =>
      void perform(() => api.decide(id, optionId)),
    [perform],
  );
  const threadValue = useMemo(
    () => ({
      runs: currentRuns,
      events,
      onDecide: decide,
      pendingAction,
      onInspect: inspect,
      onOpenLogs: setLogsRunId,
      engineOf,
    }),
    [currentRuns, events, decide, pendingAction, inspect, engineOf],
  );
  const messages = useMemo<ThreadMessageLike[]>(() => {
    const output: ThreadMessageLike[] = [];
    for (const run of currentRuns) {
      if (!workflow)
        output.push({
          id: `user-${run.id}`,
          role: "user",
          content: run.input.text,
          createdAt: new Date(run.createdAt),
        });
      output.push({
        id: `assistant-${run.id}`,
        role: "assistant",
        content: [
          {
            type: "text",
            text: projectEvents(run, events[run.id] ?? []).output,
          },
        ],
        createdAt: new Date(run.createdAt),
        status: isTerminal(run.status)
          ? { type: "complete", reason: "stop" }
          : { type: "running" },
      });
    }
    return output;
  }, [workflow, currentRuns, events]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: running,
    isDisabled: loading,
    isSendDisabled: !!workflow || !!boundOrigin,
    onNew: submit,
    onCancel: async () => {
      stop();
    },
  });
  const workflowSessionIds = new Set(
    workflows.flatMap((item) =>
      [
        item.planningSessionId,
        ...item.steps.map((step) => step.sessionId),
      ].filter((id): id is string => !!id),
    ),
  );
  const runsBySession = new Map<string, Run[]>();
  for (const run of allRuns)
    runsBySession.set(run.sessionId, [
      ...(runsBySession.get(run.sessionId) ?? []),
      run,
    ]);
  const sessionTitle = (session: Session) => {
    const first = (runsBySession.get(session.id) ?? []).reduce<Run | undefined>(
      (earliest, run) =>
        !earliest || run.createdAt < earliest.createdAt ? run : earliest,
      undefined,
    );
    return (
      first?.input.text ??
      competitionOrigin(session)?.title ??
      `会话 ${session.id.slice(0, 8)}`
    );
  };
  const history: HistoryItem[] = [
    ...workflows.map((item) => ({
      type: "workflow" as const,
      id: item.id,
      title: item.title ?? item.goal,
      busy: ["planning", "running", "cancelling"].includes(item.status),
      competition: false,
      time: item.createdAt,
    })),
    ...sessions
      .filter(
        (session) =>
          !workflowSessionIds.has(session.id) &&
          // Empty console sessions carry nothing to show; judge sessions appear before their first prompt.
          (runsBySession.has(session.id) ||
            !!competitionOrigin(session) ||
            session.id === active?.id),
      )
      .map((session) => {
        const runs = runsBySession.get(session.id) ?? [];
        return {
          type: "session" as const,
          id: session.id,
          title: sessionTitle(session),
          busy: runs.some((run) => !isTerminal(run.status)),
          competition: !!competitionOrigin(session),
          time: Math.max(
            session.createdAt,
            ...runs.map((run) => run.createdAt),
          ),
        };
      }),
  ]
    .sort((a, b) => b.time - a.time)
    .filter((item) => item.title.toLowerCase().includes(search.toLowerCase()));
  // Pages carry their own heading; the top bar names only the open task.
  const title =
    page !== "tasks"
      ? ""
      : (workflow?.title ??
        (boundSession ? sessionTitle(boundSession) : undefined) ??
        "");
  const storedSelection = selectionSchema.safeParse(
    boundSession?.configSnapshot?.routing,
  );
  const currentSelection =
    workflow?.steps.find((step) => step.runId === focusedRun?.id)?.selection ??
    selection ??
    (storedSelection.success ? storedSelection.data : undefined);
  const newTask = useCallback(() => {
    choose(null);
    setMode("direct");
    setOutputPaths("");
  }, [choose]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        newTask();
      }
      if (event.key === "Escape") setMobileNav(false);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [newTask]);
  const openPage = (next: Page) => {
    setPage(next);
    setMobileNav(false);
    // Engine revisions change after unified-model and tool-pack updates from any client.
    if (next === "engines" || next === "tools") void refresh().catch(report);
  };
  const { setModel } = gateway;
  const saveModel = useCallback(
    async (view: HarnessModelView) => {
      setModel(view);
      await refresh();
    },
    [setModel, refresh],
  );
  const openRun = useCallback(
    (runId: string) => {
      void api
        .run(runId)
        .then((run) => {
          choose({ type: "session", id: run.sessionId });
          setFocusedRunId(runId);
          setPanelTab("model");
          setInspectorOpen(true);
        })
        .catch(report);
    },
    [choose, report],
  );
  const health = gateway.health;
  const logsRun = logsRunId
    ? (currentRuns.find((run) => run.id === logsRunId) ??
      allRuns.find((run) => run.id === logsRunId))
    : undefined;
  const modelState = gateway.model;
  const needsModel =
    modelState.state === "ready" && !modelState.value.configured;
  const showOnboarding = onboarding === "open";
  // Until the model state is known the slot stays empty, so the composer never flashes
  // before the connection card on a first run.
  const modelKnown = modelState.state !== "loading";
  const emptyThread = !messages.length && !workflow && !active;
  const competitionEngine = runtimeInfo?.competition
    ? runtimeInfo.competitionEngine
    : undefined;
  const panel = (
    <Inspector
      run={focusedRun}
      observation={focusedRun ? observations[focusedRun.id] : undefined}
      selection={currentSelection}
      events={focusedRun ? (events[focusedRun.id] ?? []) : []}
      {...(unifiedModel ? { unifiedModel } : {})}
      tab={panelTab}
      onTabChange={setPanelTab}
      close={() => setInspectorOpen(false)}
    />
  );

  return (
    <TooltipProvider delayDuration={300}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="app-shell">
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-lg focus:bg-popover focus:px-3 focus:py-2 focus:shadow-float"
          >
            跳到主要内容
          </a>
          {mobileNav ? (
            <button
              className="scrim min-[821px]:hidden"
              aria-label="关闭导航"
              onClick={() => setMobileNav(false)}
            />
          ) : null}
          <Sidebar
            page={page}
            collapsed={sidebarCollapsed}
            mobileOpen={mobileNav}
            onToggle={toggleSidebar}
            onNewTask={newTask}
            onOpenPage={openPage}
            history={history}
            loading={loading}
            activeId={active?.id}
            onChoose={(item) => choose({ type: item.type, id: item.id })}
            search={search}
            onSearch={setSearch}
            health={health}
            syncError={syncError}
            modelMissing={needsModel}
          />
          <main id="main-content" className="main-shell">
            <header className="topbar">
              <div className="flex min-w-0 items-center gap-1.5">
                <Button
                  className="min-[821px]:hidden"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="打开导航"
                  onClick={() => setMobileNav(true)}
                >
                  <Menu />
                </Button>
                <h1
                  className="min-w-0 truncate text-[14.5px] font-medium"
                  title={title}
                >
                  {title}
                </h1>
                {page === "tasks" && boundOrigin ? (
                  <span className="tag info shrink-0">
                    <Trophy className="size-3" aria-hidden />
                    比赛接口
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {competitionEngine ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="status-chip max-lg:hidden">
                        <Trophy className="size-3.5 text-info" aria-hidden />
                        比赛模式 · {engineName(competitionEngine)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      比赛接口固定使用 {engineName(competitionEngine)}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {runtimeInfo?.fullAccess ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="status-chip max-lg:hidden">
                        <ShieldAlert
                          className="size-3.5 text-warning"
                          aria-hidden
                        />
                        完全访问
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>工具与权限请求自动批准</TooltipContent>
                  </Tooltip>
                ) : null}
                {modelState.state === "ready" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="status-chip max-sm:hidden"
                        onClick={() => openPage("model")}
                      >
                        <span
                          className={cn(
                            "dot",
                            modelState.value.configured ? "good" : "warn",
                          )}
                        />
                        <span className="truncate">
                          {modelState.value.configured
                            ? (modelState.value.model ?? "模型")
                            : "未连接模型"}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {modelState.value.configured
                        ? "所有引擎共用的模型"
                        : "连接模型后才能执行任务"}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="刷新"
                      onClick={() => {
                        setError(null);
                        setStreamError(false);
                        setRefreshEpoch((n) => n + 1);
                        void refresh().catch(report);
                        void gateway.reload();
                      }}
                    >
                      <RefreshCw />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>刷新</TooltipContent>
                </Tooltip>
                {page === "tasks" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className={cn(
                          inspectorOpen && "bg-accent text-foreground",
                        )}
                        aria-label={
                          inspectorOpen ? "关闭执行详情" : "打开执行详情"
                        }
                        aria-pressed={inspectorOpen}
                        onClick={() => setInspectorOpen((value) => !value)}
                      >
                        <PanelRight />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>执行详情</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            </header>
            {error ? (
              <div className="thread-column shrink-0 pb-2">
                <div role="alert" className="callout error items-center">
                  <CircleAlert className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">{error}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                    aria-label="关闭提示"
                    onClick={() => setError(null)}
                  >
                    <X />
                  </Button>
                </div>
              </div>
            ) : null}
            {page === "model" ? (
              <ModelPage
                model={gateway.model}
                reload={gateway.reload}
                onSaved={saveModel}
                openRun={openRun}
              />
            ) : page === "tools" ? (
              <ToolPacksPage engines={engines} refreshEngines={refresh} />
            ) : page === "engines" ? (
              <EnginePage
                engines={engines}
                defaultEngine={defaultEngine}
                refresh={refresh}
                report={report}
                {...(runtimeInfo ? { runtime: runtimeInfo } : {})}
                {...(unifiedModel ? { unifiedModel } : {})}
                testModel={async (id) => {
                  const session = await api.createSession(
                    id,
                    workspaceId || undefined,
                  );
                  await api.submit(
                    session.id,
                    "连接测试：请仅回复 HARNESSHUB_CONNECTION_OK。不要使用工具或修改文件。",
                    crypto.randomUUID(),
                  );
                  await refresh();
                  choose({ type: "session", id: session.id });
                }}
              />
            ) : page === "observability" ? (
              <ObservabilityPage
                workflows={workflows}
                overview={overview}
                refresh={() => void loadOverview()}
                loading={overviewLoading}
                inspect={(sessionId, runId) => {
                  choose({ type: "session", id: sessionId });
                  setFocusedRunId(runId);
                  setPanelTab("overview");
                  setInspectorOpen(true);
                }}
              />
            ) : (
              <div className="work-area">
                <RunThreadProvider value={threadValue}>
                  <ThreadPrimitive.Root className="conversation">
                    {emptyThread ? (
                      <div className="min-h-6 flex-1" />
                    ) : (
                      <div className="relative flex min-h-0 flex-1 flex-col">
                        <ThreadPrimitive.Viewport
                          className="thread-viewport"
                          autoScroll
                        >
                          <div className="thread-column thread-content">
                            {!messages.length && !workflow ? (
                              <p className="text-[13.5px] text-muted-foreground">
                                {boundSession ? "还没有执行记录" : "正在读取"}
                              </p>
                            ) : null}
                            {workflow ? (
                              <>
                                <div className="user-bubble mb-7">
                                  {workflow.goal}
                                </div>
                                <WorkflowPlan
                                  workflow={workflow}
                                  approve={() =>
                                    void perform(() => api.approve(workflow.id))
                                  }
                                  cancel={() =>
                                    void perform(() =>
                                      api.cancelWorkflow(workflow.id),
                                    )
                                  }
                                  pendingAction={pendingAction}
                                  inspect={inspect}
                                />
                              </>
                            ) : null}
                            {!workflow || currentRuns.length ? (
                              <Messages />
                            ) : null}
                          </div>
                        </ThreadPrimitive.Viewport>
                        <ScrollToBottom />
                      </div>
                    )}
                    <AnimatePresence mode="popLayout" initial={false}>
                      {emptyThread && !modelKnown ? null : emptyThread &&
                        showOnboarding ? (
                        <motion.div
                          key="onboarding"
                          className="thread-column flex justify-center"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ duration: 0.2, ease: "easeOut" }}
                        >
                          <ConnectModel
                            onSaved={saveModel}
                            onDone={() => setOnboarding("closed")}
                            onSkip={() => setOnboarding("closed")}
                            openRun={openRun}
                          />
                        </motion.div>
                      ) : (
                        <motion.div
                          key="composer"
                          layout="position"
                          className="thread-column shrink-0 pb-5"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            layout: {
                              type: "spring",
                              stiffness: 420,
                              damping: 40,
                            },
                            duration: 0.2,
                          }}
                        >
                          {emptyThread ? (
                            <div className="mb-7">
                              <Greeting />
                            </div>
                          ) : null}
                          {streamError ? (
                            <p className="mb-2 px-4 text-[12.5px] text-warning">
                              实时连接已断开，正在通过记录同步。
                              <button
                                className="ml-1 underline"
                                onClick={() => {
                                  setStreamError(false);
                                  setRefreshEpoch((n) => n + 1);
                                }}
                              >
                                重新连接
                              </button>
                            </p>
                          ) : null}
                          {boundOrigin || boundSession?.status === "closed" ? (
                            <div className="flex items-center gap-3 rounded-2xl border bg-muted/50 py-3 pr-3 pl-4">
                              <p className="min-w-0 flex-1 text-[13.5px] text-muted-foreground">
                                {boundOrigin
                                  ? "比赛接口创建的会话，仅供查看"
                                  : "会话已结束"}
                              </p>
                              <Button size="sm" onClick={newTask}>
                                <SquarePen />
                                新建任务
                              </Button>
                            </div>
                          ) : (
                            <Composer
                              mode={mode}
                              setMode={setMode}
                              engineId={boundSession?.engineId ?? engineId}
                              setEngineId={setEngineId}
                              workspaceId={
                                boundSession?.workspaceId ?? workspaceId
                              }
                              setWorkspaceId={setWorkspaceId}
                              engines={engines}
                              workspaces={workspaces}
                              running={running}
                              workflowActive={!!workflow}
                              sessionBound={active?.type === "session"}
                              onStop={stop}
                              outputPaths={outputPaths}
                              setOutputPaths={setOutputPaths}
                              fullAccess={runtimeInfo?.fullAccess ?? false}
                              onManageEngines={() => openPage("engines")}
                              autoFocus
                              {...(boundSession
                                ? { sessionCwd: boundSession.cwd }
                                : {})}
                            />
                          )}
                          {emptyThread ? (
                            <div className="mt-6">
                              <Suggestions
                                onPick={(text) =>
                                  runtime.thread.composer.setText(text)
                                }
                              />
                            </div>
                          ) : null}
                        </motion.div>
                      )}
                    </AnimatePresence>
                    {emptyThread ? <div className="flex-[1.35]" /> : null}
                  </ThreadPrimitive.Root>
                </RunThreadProvider>
                <AnimatePresence initial={false}>
                  {inspectorOpen ? (
                    overlayPanel ? (
                      <Fragment key="overlay">
                        <motion.button
                          className="scrim absolute z-10"
                          aria-label="关闭执行详情"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          onClick={() => setInspectorOpen(false)}
                        />
                        <motion.div
                          className="absolute inset-y-0 right-0 z-20 flex w-[min(400px,100%)] shadow-(--shadow-panel)"
                          initial={{ x: "100%" }}
                          animate={{ x: 0 }}
                          exit={{ x: "100%" }}
                          transition={panelTransition}
                        >
                          {panel}
                        </motion.div>
                      </Fragment>
                    ) : (
                      <motion.div
                        key="docked"
                        className="flex shrink-0 justify-end overflow-hidden"
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: 400, opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={panelTransition}
                      >
                        {panel}
                      </motion.div>
                    )
                  ) : null}
                </AnimatePresence>
              </div>
            )}
          </main>
          {logsRun ? (
            <LogPanel
              key={logsRun.sessionId}
              sessionId={logsRun.sessionId}
              active={!logsRun.finishedAt}
              open
              onOpenChange={(open) => {
                if (!open) setLogsRunId(null);
              }}
            />
          ) : null}
        </div>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
