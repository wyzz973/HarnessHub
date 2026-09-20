"use client";
import {
  Activity,
  Blocks,
  BrainCircuit,
  Cpu,
  Layers2,
  Moon,
  PanelLeft,
  Search,
  SquarePen,
  Sun,
  Trophy,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import type { GatewayHealth } from "@/lib/api";
import { useIsMac } from "@/lib/platform";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type Page = "tasks" | "model" | "tools" | "engines" | "observability";
export interface HistoryItem {
  type: "session" | "workflow";
  id: string;
  title: string;
  busy: boolean;
  competition: boolean;
  time: number;
}
const navigation: { page: Exclude<Page, "tasks">; label: string; icon: LucideIcon }[] =
  [
    { page: "model", label: "模型", icon: BrainCircuit },
    { page: "tools", label: "工具", icon: Blocks },
    { page: "engines", label: "引擎", icon: Cpu },
    { page: "observability", label: "观测", icon: Activity },
  ];
const healthText: Record<GatewayHealth, string> = {
  ready: "已连接",
  checking: "正在连接",
  "not-ready": "服务未就绪",
  offline: "无法连接服务",
};

function dayStart(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
/** 今天 / 昨天 / 近 7 天 / 更早, newest first inside each group. */
function groupByDay(items: HistoryItem[], now: number) {
  const today = dayStart(now);
  const day = 86_400_000;
  const groups: { label: string; items: HistoryItem[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "近 7 天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const item of items) {
    const index =
      item.time >= today
        ? 0
        : item.time >= today - day
          ? 1
          : item.time >= today - 7 * day
            ? 2
            : 3;
    groups[index]!.items.push(item);
  }
  return groups.filter((group) => group.items.length);
}

function Row({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  const row = (
    <button
      type="button"
      className="sidebar-row"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      onClick={onClick}
    >
      <Icon className="size-[18px]" strokeWidth={1.7} />
      <span className="sidebar-label flex-1">{label}</span>
      {trailing ? <span className="sidebar-only-open">{trailing}</span> : null}
    </button>
  );
  if (!collapsed) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  page,
  collapsed,
  mobileOpen,
  onToggle,
  onNewTask,
  onOpenPage,
  history,
  loading,
  activeId,
  onChoose,
  search,
  onSearch,
  health,
  syncError,
  modelMissing,
}: {
  page: Page;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onNewTask: () => void;
  onOpenPage: (page: Page) => void;
  history: HistoryItem[];
  loading: boolean;
  activeId: string | undefined;
  onChoose: (item: HistoryItem) => void;
  search: string;
  onSearch: (value: string) => void;
  health: GatewayHealth;
  /** Last history synchronization failure; shown on the connection row. */
  syncError: string | null;
  /** The unified model still has to be connected. */
  modelMissing: boolean;
}) {
  const [theme, setTheme] = useTheme();
  const mac = useIsMac();
  const groups = groupByDay(history, Date.now());
  const healthy = health === "ready" && !syncError;
  return (
    <aside
      className="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      data-mobile-open={mobileOpen ? "true" : "false"}
      aria-label="主导航"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-[10px] text-brand hover:bg-sidebar-hover"
          aria-label={collapsed ? "展开侧栏" : "HarnessHub"}
          onClick={collapsed ? onToggle : onNewTask}
        >
          <Layers2 className="size-[20px]" strokeWidth={1.8} />
        </button>
        <span className="sidebar-label flex-1 text-[15px] font-semibold tracking-[-0.01em]">
          HarnessHub
        </span>
        <button
          type="button"
          className="sidebar-only-open grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
          aria-label="收起侧栏"
          tabIndex={collapsed ? -1 : 0}
          onClick={onToggle}
        >
          <PanelLeft className="size-[18px]" strokeWidth={1.7} />
        </button>
      </div>
      <nav className="shrink-0 space-y-0.5 px-3" aria-label="页面">
        <Row
          icon={SquarePen}
          label="新建任务"
          collapsed={collapsed}
          onClick={onNewTask}
          trailing={
            <kbd className="text-[11px] text-subtle">
              {mac ? "⌘K" : "Ctrl K"}
            </kbd>
          }
        />
        {navigation.map((item) => (
          <Row
            key={item.page}
            icon={item.icon}
            label={item.label}
            active={page === item.page}
            collapsed={collapsed}
            onClick={() => onOpenPage(item.page)}
            trailing={
              item.page === "model" && modelMissing ? (
                <span className="dot warn" aria-label="尚未连接模型" />
              ) : undefined
            }
          />
        ))}
      </nav>
      <div className="sidebar-only-open mt-4 flex min-h-0 flex-1 flex-col">
        <label className="mx-3 flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-2.5 text-subtle focus-within:bg-sidebar-hover focus-within:text-foreground hover:bg-sidebar-hover">
          <Search className="size-4 shrink-0" strokeWidth={1.7} />
          <input
            aria-label="搜索任务"
            className="h-full w-full min-w-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-subtle"
            placeholder="搜索任务"
            value={search}
            tabIndex={collapsed ? -1 : 0}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {loading ? (
            <div className="space-y-3 px-2.5 pt-4">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ) : groups.length ? (
            groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="history-group">{group.label}</h2>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="history-row"
                    data-active={
                      activeId === item.id && page === "tasks"
                        ? "true"
                        : undefined
                    }
                    tabIndex={collapsed ? -1 : 0}
                    title={item.title}
                    onClick={() => onChoose(item)}
                  >
                    {item.type === "workflow" ? (
                      <WorkflowIcon
                        className="size-3.5 shrink-0 text-subtle"
                        aria-label="计划任务"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {item.title}
                    </span>
                    {item.competition ? (
                      <Trophy
                        className="size-3.5 shrink-0 text-info"
                        aria-label="比赛接口创建"
                      />
                    ) : null}
                    {item.busy ? (
                      <span className="dot live" aria-label="执行中" />
                    ) : null}
                  </button>
                ))}
              </section>
            ))
          ) : (
            <p className="px-2.5 pt-4 text-[13px] text-subtle">
              {search ? "没有匹配的任务" : "还没有任务"}
            </p>
          )}
        </div>
      </div>
      <div
        className={cn(
          "mt-auto flex shrink-0 items-center gap-2 border-t px-3 py-2.5",
          collapsed && "flex-col-reverse",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-muted-foreground",
                collapsed && "w-9 flex-none justify-center px-0",
              )}
              role="status"
            >
              <span
                className={cn(
                  "dot",
                  healthy
                    ? "good"
                    : health === "checking"
                      ? ""
                      : health === "ready" || health === "not-ready"
                        ? "warn"
                        : "error",
                )}
              />
              <span className="sidebar-label">
                {health === "ready" && syncError
                  ? "同步失败"
                  : healthText[health]}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"}>
            {syncError ?? healthText[health]}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
              aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun className="size-[17px]" strokeWidth={1.7} />
              ) : (
                <Moon className="size-[17px]" strokeWidth={1.7} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"}>
            {theme === "dark" ? "浅色" : "深色"}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
