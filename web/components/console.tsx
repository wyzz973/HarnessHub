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
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Layers2,
  ListFilter,
  Loader2,
  Menu,
  MessageSquare,
  PanelRight,
  Plus,
  Plug,
  RefreshCw,
  Search,
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
import { cn } from "@/lib/utils";
import { dateLabel, projectEvents } from "@/lib/presentation";
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

type ActiveSelection = { type: "session" | "workflow"; id: string } | null;
type Page = "tasks" | "engines" | "observability";
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike =>
  message;
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

export function Console() {
  const [page, setPage] = useState<Page>("tasks");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  const [observations, setObservations] = useState<Record<string, Observation>>(
    {},
  );
  const [selection, setSelection] = useState<Selection | undefined>();
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "direct">("auto");
  const [engineId, setEngineId] = useState("auto");
  const [workspaceId, setWorkspaceId] = useState("");
  const [outputPaths, setOutputPaths] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const report = useCallback((err: unknown) => setError(messageOf(err)), []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [engineList, workspaceList, sessionList, runList, workflowList] =
      await Promise.all([
        api.engines(signal),
        api.workspaces(signal),
        api.sessions(signal),
        api.runs(signal),
        api.workflows(signal),
      ]);
    setEngines(engineList.engines);
    setEngineId((current) =>
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
    setSessions(sessionList.sessions);
    setAllRuns(runList.runs);
    setWorkflows(workflowList.workflows);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const session = params.get("session"),
      workflowId = params.get("workflow");
    if (workflowId) setActive({ type: "workflow", id: workflowId });
    else if (session) {
      setActive({ type: "session", id: session });
      setMode("direct");
    }
    refresh(controller.signal)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) report(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, report]);

  const choose = useCallback((next: ActiveSelection) => {
    activeRef.current = next;
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
  const refreshCurrent = useCallback(
    async (selected: NonNullable<ActiveSelection>, signal?: AbortSignal) => {
      let nextRuns: Run[];
      if (selected.type === "workflow") {
        const nextWorkflow = await api.workflow(selected.id, signal);
        if (activeRef.current?.id !== selected.id) return;
        setWorkflow(nextWorkflow);
        setWorkflows((current) => [
          nextWorkflow,
          ...current.filter((item) => item.id !== nextWorkflow.id),
        ]);
        nextRuns = await Promise.all(
          nextWorkflow.steps.flatMap((step) =>
            step.runId ? [api.run(step.runId, signal)] : [],
          ),
        );
      } else {
        const list = await api.sessionRuns(selected.id, signal);
        nextRuns = await Promise.all(
          list.runs.map((run) => api.run(run.id, signal)),
        );
        nextRuns.sort((a, b) => a.createdAt - b.createdAt);
      }
      if (activeRef.current?.id !== selected.id) return;
      setCurrentRuns(nextRuns);
      setAllRuns((current) =>
        [
          ...nextRuns,
          ...current.filter(
            (run) => !nextRuns.some((next) => next.id === run.id),
          ),
        ].sort((a, b) => b.createdAt - a.createdAt),
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
    [mergeEvents],
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
      )
        .then(flush)
        .catch(() => {
          if (!controller.signal.aborted) {
            flush();
            setStreamError(true);
          }
        });
    }
    return () => {
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [activeRunKey, mergeEvents, refreshEpoch]);
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
        let session =
          active?.type === "session"
            ? sessions.find((item) => item.id === active.id)
            : undefined;
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
          setSessions((current) => [session!, ...current]);
        }
        const outputs = outputPaths
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean)
          .map((path) => ({ path, name: path.split("/").at(-1) || path }));
        const run = await api.submit(
          session.id,
          text,
          crypto.randomUUID(),
          outputs,
        );
        if (active?.id !== session.id)
          choose({ type: "session", id: session.id });
        if (selected) setSelection(selected);
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
  async function perform(work: () => Promise<unknown>) {
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
  }
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
  const inspect = (runId: string) => {
    setFocusedRunId(runId);
    setInspectorOpen(true);
  };
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
    isSendDisabled: !!workflow,
    onNew: submit,
    onCancel: async () => {
      stop();
    },
  });
  const boundSession =
    active?.type === "session"
      ? sessions.find((session) => session.id === active.id)
      : undefined;
  const workflowSessionIds = new Set(
    workflows.flatMap((item) =>
      [
        item.planningSessionId,
        ...item.steps.map((step) => step.sessionId),
      ].filter((id): id is string => !!id),
    ),
  );
  const history = [
    ...workflows.map((item) => ({
      type: "workflow" as const,
      id: item.id,
      title: item.title ?? item.goal,
      status: item.status,
      time: item.createdAt,
    })),
    ...sessions
      .filter((session) => !workflowSessionIds.has(session.id))
      .flatMap((session) => {
        const first = allRuns
          .filter((run) => run.sessionId === session.id)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        return first
          ? [
              {
                type: "session" as const,
                id: session.id,
                title: first.input.text,
                status: first.status,
                time: session.createdAt,
              },
            ]
          : [];
      }),
  ]
    .sort((a, b) => b.time - a.time)
    .filter((item) => item.title.toLowerCase().includes(search.toLowerCase()));
  const title =
    page === "engines"
      ? "引擎管理"
      : page === "observability"
        ? "运行观测"
        : (workflow?.title ??
          (boundSession
            ? allRuns
                .filter((run) => run.sessionId === boundSession.id)
                .sort((a, b) => a.createdAt - b.createdAt)[0]?.input.text
            : undefined) ??
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
    setMode("auto");
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
                LOCAL
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
                  onClick={() => {
                    setPage("tasks");
                    setSidebarOpen(false);
                  }}
                >
                  <MessageSquare className="size-[16px]" strokeWidth={1.65} />
                  任务工作台
                </button>
                <button
                  className={cn("nav-item", page === "engines" && "active")}
                  onClick={() => {
                    setPage("engines");
                    setSidebarOpen(false);
                  }}
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
                  onClick={() => {
                    setPage("observability");
                    setSidebarOpen(false);
                  }}
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
                          className={`block size-1.5 rounded-full ${isTerminal(item.status) ? "bg-[#b7c0ae]" : "bg-[#73955f]"}`}
                        />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] leading-5 text-[#687660]">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block text-[9px] text-muted-foreground">
                        {dateLabel(item.time)}
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
                    "size-1.5 rounded-full",
                    error ? "bg-amber-500" : "bg-[#75976a]",
                  )}
                />
                <span className="text-[10px] text-muted-foreground">
                  {loading
                    ? "正在连接 Gateway"
                    : error
                      ? "需要关注"
                      : "本地 Gateway 已连接"}
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
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground md:flex">
                  <span className="size-1.5 rounded-full bg-[#80a36d]" />
                  本机运行
                </span>
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
            {page === "engines" ? (
              <EnginePage
                engines={engines}
                defaultEngine={defaultEngine}
                refresh={refresh}
                report={report}
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
                <RunThreadProvider
                  value={{
                    runs: currentRuns,
                    events,
                    onDecide: (id, optionId) =>
                      void perform(() => api.decide(id, optionId)),
                    pendingAction,
                    onInspect: inspect,
                  }}
                >
                  <ThreadPrimitive.Root className="conversation">
                    <div className="relative flex min-h-0 flex-1 flex-col">
                      <ThreadPrimitive.Viewport
                        className="thread-viewport flex flex-col"
                        autoScroll
                      >
                        <>
                          {!messages.length && !workflow ? (
                            <Welcome
                              enabledCount={
                                engines.filter((engine) => engine.enabled)
                                  .length
                              }
                              suggest={(text) =>
                                runtime.thread.composer.setText(text)
                              }
                            />
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
                    {boundSession?.status === "closed" ? (
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
                        sessionBound={!!boundSession}
                        onStop={stop}
                        outputPaths={outputPaths}
                        setOutputPaths={setOutputPaths}
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
                    自动规划
                  </strong>
                  <br />
                  描述目标后先生成分步计划，查看引擎选择依据，确认后执行。
                </p>
                <p>
                  <strong className="font-medium text-foreground">
                    直接执行
                  </strong>
                  <br />
                  发送任务或多轮对话。会话固定使用所选引擎和工作区。
                </p>
                <p>
                  <strong className="font-medium text-foreground">
                    运行观测
                  </strong>
                  <br />
                  查看实际模型、耗时、用量和产物。引擎未提供的信息保留为未知。
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
