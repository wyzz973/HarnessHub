"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  Activity,
  Blocks,
  BrainCircuit,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Layers2,
  Menu,
  MessageSquare,
  PanelRight,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Trophy,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useGatewayStatus } from "@/lib/gateway-status";
import { cn } from "@/lib/utils";
import {
  competitionOrigin,
  dateLabel,
  parseOutputPaths,
  projectEvents,
} from "@/lib/presentation";
import {
  Composer,
  Messages,
  RunThreadProvider,
  ScrollToBottom,
  Welcome,
  WorkflowPlan,
} from "./thread";
import { Inspector } from "./inspector";
import { EnginePage } from "./engine-page";
import { ObservabilityPage } from "./observability-page";
import { ModelPage } from "./model-page";
import { ToolPacksPage } from "./tool-packs-page";
import { StatusBar } from "./status-bar";

type ActiveSelection = { type: "session" | "workflow"; id: string } | null;
type Page = "tasks" | "model" | "tools" | "engines" | "observability";
const pageTitles: Record<Exclude<Page, "tasks">, string> = {
  model: "统一模型",
  tools: "工具与插件",
  engines: "引擎管理",
  observability: "运行观测",
};
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
  const [page, setPage] = useState<Page>("tasks");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
    setSidebarOpen(false);
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
    }),
    [currentRuns, events, decide, pendingAction, inspect],
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
  const history = [
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
  const title =
    page !== "tasks"
      ? pageTitles[page]
      : (workflow?.title ??
        (boundSession ? sessionTitle(boundSession) : undefined) ??
        "新任务");
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
      if (event.key === "Escape") {
        setSidebarOpen(false);
        setInspectorOpen(false);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [newTask]);
  const openPage = (next: Page) => {
    setPage(next);
    setSidebarOpen(false);
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
          setInspectorOpen(true);
        })
        .catch(report);
    },
    [choose, report],
  );
  const health = gateway.health;

  return (
    <TooltipProvider delayDuration={250}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="console-shell">
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:bg-white focus:p-3"
          >
            跳转到主要内容
          </a>
          {sidebarOpen ? (
            <button
              className="sidebar-overlay"
              aria-label="关闭导航菜单"
              onClick={() => setSidebarOpen(false)}
            />
          ) : null}
          <aside
            className={cn("sidebar", sidebarOpen && "mobile-open")}
            aria-label="主导航"
          >
            <div className="flex h-[76px] items-center gap-2.5 px-5">
              <span className="brand-mark">
                <Layers2 className="size-[17px]" strokeWidth={1.7} />
              </span>
              <span className="text-[17px] font-semibold tracking-[-.045em]">
                HarnessHub
              </span>
              <span className="ml-auto rounded border bg-white/70 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                {runtimeInfo?.competition ? "CONTEST" : "LOCAL"}
              </span>
            </div>
            <div className="px-3">
              <button
                className="mb-5 flex h-10 w-full items-center gap-2 rounded-lg border border-[#dce4d4] bg-white px-3 text-[12px] font-medium text-[#4b6541] shadow-xs hover:border-[#acbda1]"
                onClick={newTask}
              >
                <Plus className="size-4" />
                新建任务
                <kbd className="ml-auto flex items-center gap-0.5 rounded border px-1 text-[9px] font-normal text-muted-foreground">
                  <Command className="size-2.5" />K
                </kbd>
              </button>
              <nav className="space-y-1">
                <button
                  className={cn("nav-item", page === "tasks" && "active")}
                  onClick={() => openPage("tasks")}
                >
                  <MessageSquare className="size-[16px]" strokeWidth={1.65} />
                  任务工作台
                </button>
                <button
                  className={cn("nav-item", page === "model" && "active")}
                  onClick={() => openPage("model")}
                >
                  <BrainCircuit className="size-[16px]" strokeWidth={1.65} />
                  统一模型
                  {unifiedModel && !unifiedModel.configured ? (
                    <span className="ml-auto size-1.5 rounded-full bg-amber-500" />
                  ) : null}
                </button>
                <button
                  className={cn("nav-item", page === "tools" && "active")}
                  onClick={() => openPage("tools")}
                >
                  <Blocks className="size-[16px]" strokeWidth={1.65} />
                  工具与插件
                </button>
                <button
                  className={cn("nav-item", page === "engines" && "active")}
                  onClick={() => openPage("engines")}
                >
                  <Plug className="size-[16px]" strokeWidth={1.65} />
                  引擎管理
                  <span className="ml-auto text-[10px] tabular">
                    {engines.length}
                  </span>
                </button>
                <button
                  className={cn(
                    "nav-item",
                    page === "observability" && "active",
                  )}
                  onClick={() => openPage("observability")}
                >
                  <Activity className="size-[16px]" strokeWidth={1.65} />
                  运行观测
                </button>
              </nav>
            </div>
            <div className="mt-8 flex items-center justify-between px-6">
              <span className="section-label">最近任务</span>
              <Clock3 className="size-3 text-muted-foreground" />
            </div>
            <label className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-transparent px-2 focus-within:border-border focus-within:bg-white">
              <Search className="size-3 text-muted-foreground" />
              <input
                aria-label="搜索历史任务"
                className="h-8 w-full min-w-0 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
                placeholder="搜索任务"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-5">
              {loading ? (
                <div className="space-y-4 p-2">
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              ) : history.length ? (
                history.map((item) => (
                  <button
                    key={item.id}
                    className={cn(
                      "history-item",
                      active?.id === item.id && page === "tasks" && "active",
                    )}
                    onClick={() => choose({ type: item.type, id: item.id })}
                  >
                    <span className="mt-1.5 shrink-0">
                      {item.type === "workflow" ? (
                        <WorkflowIcon className="size-3 text-[#8b977f]" />
                      ) : (
                        <span
                          className={`block size-1.5 rounded-full ${item.busy ? "bg-[#73955f]" : "bg-[#b7c0ae]"}`}
                        />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] leading-5 text-[#687660]">
                        {item.title}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground">
                        {dateLabel(item.time)}
                        {item.competition ? (
                          <span className="source-tag">
                            <Trophy className="size-2.5" aria-hidden />
                            比赛 API
                          </span>
                        ) : null}
                        {item.busy ? (
                          <span className="text-[#5a7a49]">执行中</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-4 text-[11px] leading-6 text-muted-foreground">
                  {search
                    ? "没有匹配的任务"
                    : "开始第一项任务，\n执行记录会保存在这里。"}
                </p>
              )}
            </div>
            <div className="mx-4 border-t py-4">
              <div className="flex items-center gap-2 px-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    health === "ready"
                      ? "bg-[#75976a]"
                      : health === "checking"
                        ? "bg-[#b7c0ae]"
                        : health === "not-ready"
                          ? "bg-amber-500"
                          : "bg-red-500",
                  )}
                />
                <span
                  className="min-w-0 truncate text-[10px] text-muted-foreground"
                  title={syncError ?? undefined}
                >
                  {health === "ready"
                    ? syncError
                      ? "Gateway 已连接 · 历史同步失败"
                      : "Gateway 已连接 · 每 3 秒同步"
                    : health === "checking"
                      ? "正在连接 Gateway"
                      : health === "not-ready"
                        ? "Gateway 未就绪"
                        : "无法连接 Gateway"}
                </span>
                <Button
                  className="ml-auto size-6"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="工作台帮助"
                  onClick={() => setHelpOpen(true)}
                >
                  <CircleHelp className="size-3.5" />
                </Button>
              </div>
            </div>
          </aside>
          <main id="main-content" className="main-shell">
            <header className="topbar">
              <div className="flex min-w-0 items-center gap-3">
                <Button
                  className="min-[761px]:hidden"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="打开导航菜单"
                  onClick={() => setSidebarOpen(true)}
                >
                  <Menu />
                </Button>
                <span className="hidden text-[11px] text-muted-foreground sm:block">
                  工作台
                </span>
                <ChevronRight className="hidden size-3 text-[#a3ab9b] sm:block" />
                <span
                  className="topbar-title max-w-[400px] truncate text-[12px] font-medium"
                  title={title}
                >
                  {title}
                </span>
                {page === "tasks" && boundOrigin ? (
                  <span className="source-tag hidden sm:inline-flex">
                    <Trophy className="size-2.5" aria-hidden />
                    比赛 API
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="刷新任务数据"
                      onClick={() => {
                        setError(null);
                        setStreamError(false);
                        setRefreshEpoch((n) => n + 1);
                        void refresh().catch(report);
                        void gateway.reload();
                      }}
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>刷新任务数据</TooltipContent>
                </Tooltip>
                {page === "tasks" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant={inspectorOpen ? "secondary" : "ghost"}
                        aria-label={
                          inspectorOpen ? "收起执行详情" : "打开执行详情"
                        }
                        onClick={() => setInspectorOpen((value) => !value)}
                      >
                        <PanelRight className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>执行详情</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            </header>
            <StatusBar status={gateway} onOpenModel={() => openPage("model")} />
            {error ? (
              <div
                role="alert"
                className="flex items-start gap-3 border-b border-amber-100 bg-amber-50/60 px-6 py-3 text-xs leading-6 text-amber-900"
              >
                <span className="flex-1">{error}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="关闭提示"
                  onClick={() => setError(null)}
                >
                  <X />
                </Button>
              </div>
            ) : null}
            {page === "model" ? (
              <ModelPage
                model={gateway.model}
                runtime={gateway.runtime}
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
                  setInspectorOpen(true);
                }}
              />
            ) : (
              <div className="work-area">
                <RunThreadProvider value={threadValue}>
                  <ThreadPrimitive.Root className="conversation">
                    <div className="relative flex min-h-0 flex-1 flex-col">
                      <ThreadPrimitive.Viewport
                        className="thread-viewport flex flex-col"
                        autoScroll
                      >
                        <>
                          {!messages.length && !workflow ? (
                            active?.type === "session" ? (
                              <div className="thread-content text-xs text-muted-foreground">
                                {boundSession
                                  ? "此会话还没有执行记录。"
                                  : "正在读取会话…"}
                              </div>
                            ) : (
                              <Welcome
                                enabledCount={
                                  engines.filter((engine) => engine.enabled)
                                    .length
                                }
                                {...(runtimeInfo?.competition
                                  ? {
                                      competitionEngine:
                                        runtimeInfo.competitionEngine ??
                                        "（未报告）",
                                    }
                                  : {})}
                                suggest={(text) =>
                                  runtime.thread.composer.setText(text)
                                }
                              />
                            )
                          ) : (
                            <div className="thread-content">
                              {workflow ? (
                                <>
                                  <div className="user-message mb-8">
                                    {workflow.goal}
                                  </div>
                                  <WorkflowPlan
                                    workflow={workflow}
                                    approve={() =>
                                      void perform(() =>
                                        api.approve(workflow.id),
                                      )
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
                          )}
                        </>
                      </ThreadPrimitive.Viewport>
                      <ScrollToBottom />
                    </div>
                    {streamError ? (
                      <div className="mx-auto flex w-full max-w-[716px] items-center gap-2 px-5 text-[11px] text-amber-800">
                        实时连接已断开，正在通过持久记录同步状态。
                        <button
                          className="underline"
                          onClick={() => {
                            setStreamError(false);
                            setRefreshEpoch((n) => n + 1);
                          }}
                        >
                          重新连接
                        </button>
                      </div>
                    ) : null}
                    {boundOrigin ? (
                      <div className="composer-wrap">
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d9e3ec] bg-[#f5f8fb] p-4">
                          <p className="min-w-0 flex-1 text-xs leading-6 text-[#40576b]">
                            此会话由比赛 API 创建
                            {boundOrigin.title
                              ? `（${boundOrigin.title}）`
                              : ""}
                            。为避免影响评测，控制台只读显示执行过程与结果，不发送消息也不停止任务。
                          </p>
                          <Button size="sm" onClick={newTask}>
                            <Plus />
                            新建任务
                          </Button>
                        </div>
                      </div>
                    ) : boundSession?.status === "closed" ? (
                      <div className="composer-wrap">
                        <div className="flex items-center justify-between rounded-xl border bg-muted p-4">
                          <p className="text-xs text-muted-foreground">
                            此会话已关闭，历史记录与产物仍可查看。
                          </p>
                          <Button size="sm" onClick={newTask}>
                            <Plus />
                            新建任务
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Composer
                        mode={mode}
                        setMode={setMode}
                        engineId={boundSession?.engineId ?? engineId}
                        setEngineId={setEngineId}
                        workspaceId={boundSession?.workspaceId ?? workspaceId}
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
                        {...(boundSession
                          ? { sessionCwd: boundSession.cwd }
                          : {})}
                      />
                    )}
                  </ThreadPrimitive.Root>
                </RunThreadProvider>
                {inspectorOpen ? (
                  <>
                    <button
                      className="inspector-overlay"
                      aria-label="关闭执行详情"
                      onClick={() => setInspectorOpen(false)}
                    />
                    <Inspector
                      run={focusedRun}
                      observation={
                        focusedRun ? observations[focusedRun.id] : undefined
                      }
                      selection={currentSelection}
                      events={focusedRun ? (events[focusedRun.id] ?? []) : []}
                      {...(unifiedModel ? { unifiedModel } : {})}
                      close={() => setInspectorOpen(false)}
                    />
                  </>
                ) : null}
              </div>
            )}
          </main>
          <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>一个工作台，连接你的 Agent。</DialogTitle>
                <DialogDescription>
                  HarnessHub 在本机编排引擎，执行记录与任务产物持久保留。
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-5 py-3 text-xs leading-7 text-muted-foreground">
                <p>
                  <strong className="font-medium text-foreground">
                    直接执行（默认）
                  </strong>
                  <br />
                  发送任务或多轮对话。会话固定使用所选引擎和工作区；比赛模式下默认选择比赛引擎。
                </p>
                <p>
                  <strong className="font-medium text-foreground">
                    自动规划
                  </strong>
                  <br />
                  描述目标后先生成分步计划，查看引擎选择依据，确认后执行。需要已登记的真实引擎；Full
                  Access 下规划阶段的工具请求会被自动批准，计划可能被拒绝。
                </p>
                <p>
                  <strong className="font-medium text-foreground">
                    统一模型与工具
                  </strong>
                  <br />
                  “统一模型”设置所有引擎共用的唯一模型；“工具与插件”导入
                  Skills、MCP 与 CLI
                  工具并应用到引擎。执行详情的“模型调用”列出每次调用的证据。
                </p>
                <p>
                  <strong className="font-medium text-foreground">
                    比赛 API 会话
                  </strong>
                  <br />
                  评测方通过比赛接口创建的会话每 3 秒同步到最近任务，带“比赛
                  API”标记，只读显示。
                </p>
                <p className="rounded-lg bg-muted px-3 py-2">
                  关闭页面不会停止任务。需要停止时请使用“停止执行”。
                </p>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
