// SPDX-License-Identifier: MIT
import {
  Activity,
  Blocks,
  Bot,
  BrainCircuit,
  ChartColumn,
  Cpu,
  CreditCard,
  Layers,
  Layers2,
  LibraryBig,
  LogOut,
  Moon,
  PanelLeft,
  Route,
  Search,
  Server,
  Settings,
  SquarePen,
  Sun,
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
import { t, type MessageKey } from "@/lib/i18n";
import type { Page } from "@/lib/router";
import { useIsMac } from "@/lib/platform";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export interface HistoryItem {
  type: "session" | "workflow";
  id: string;
  title: string;
  busy: boolean;
  time: number;
}
interface NavItem {
  page: Exclude<Page, "tasks">;
  label: Extract<MessageKey, `common.nav.${string}`>;
  icon: LucideIcon;
  /** Other pages that belong to this entry (tabs of the same section). */
  also?: Page[];
}
/** The gateway: agents (the home page), providers and accounts, routing, usage, profiles, the Library and settings. */
const gatewayNavigation: NavItem[] = [
  { page: "agents", label: "common.nav.agents", icon: Bot },
  { page: "providers", label: "common.nav.providers", icon: Server },
  {
    page: "subscriptions",
    label: "common.nav.subscriptions",
    icon: CreditCard,
  },
  {
    page: "routing",
    label: "common.nav.routing",
    icon: Route,
    also: ["auto-groups", "keys", "credential-state", "decisions"],
  },
  {
    page: "usage",
    label: "common.nav.usage",
    icon: ChartColumn,
    also: ["conversations"],
  },
  { page: "profiles", label: "common.nav.profiles", icon: Layers },
  { page: "library", label: "common.nav.library", icon: LibraryBig },
  {
    page: "settings",
    label: "common.nav.settings",
    icon: Settings,
    also: ["backup", "features"],
  },
];
/** Tasks run by HarnessHub itself, and their engines and tools. */
const taskNavigation: NavItem[] = [
  { page: "model", label: "common.nav.model", icon: BrainCircuit },
  { page: "engines", label: "common.nav.engines", icon: Cpu },
  { page: "tools", label: "common.nav.tools", icon: Blocks },
  { page: "observability", label: "common.nav.observability", icon: Activity },
];
const healthText = (health: GatewayHealth) => t(`common.health.${health}`);

function dayStart(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
/** Today, yesterday, the last 7 days and earlier, newest first inside each group. */
function groupByDay(items: HistoryItem[], now: number) {
  const today = dayStart(now);
  const day = 86_400_000;
  const groups: { label: string; items: HistoryItem[] }[] = [
    { label: t("common.history.today"), items: [] },
    { label: t("common.history.yesterday"), items: [] },
    { label: t("common.history.week"), items: [] },
    { label: t("common.history.earlier"), items: [] },
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
  onSignOut,
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
  /** End the console session (the page then shows how to sign in again). */
  onSignOut: () => void;
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
      aria-label={t("common.nav.main")}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-[10px] text-brand hover:bg-sidebar-hover"
          aria-label={collapsed ? t("common.nav.expand") : t("common.nav.home")}
          onClick={collapsed ? onToggle : () => onOpenPage("agents")}
        >
          <Layers2 className="size-[20px]" strokeWidth={1.8} />
        </button>
        <span className="sidebar-label flex-1 text-[15px] font-semibold tracking-[-0.01em]">
          HarnessHub
        </span>
        <button
          type="button"
          className="sidebar-only-open grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
          aria-label={t("common.nav.collapse")}
          tabIndex={collapsed ? -1 : 0}
          onClick={onToggle}
        >
          <PanelLeft className="size-[18px]" strokeWidth={1.7} />
        </button>
      </div>
      <nav
        className="shrink-0 space-y-0.5 px-3"
        aria-label={t("common.nav.pages")}
      >
        {gatewayNavigation.map((item) => (
          <Row
            key={item.page}
            icon={item.icon}
            label={t(item.label)}
            active={page === item.page || (item.also?.includes(page) ?? false)}
            collapsed={collapsed}
            onClick={() => onOpenPage(item.page)}
          />
        ))}
        <h2 className="history-group sidebar-label pt-3">
          {t("common.nav.tasks")}
        </h2>
        <Row
          icon={SquarePen}
          label={t("common.nav.newTask")}
          active={page === "tasks" && !activeId}
          collapsed={collapsed}
          onClick={onNewTask}
          trailing={
            <kbd className="text-[11px] text-subtle">
              {mac ? "⌘K" : "Ctrl K"}
            </kbd>
          }
        />
        {taskNavigation.map((item) => (
          <Row
            key={item.page}
            icon={item.icon}
            label={t(item.label)}
            active={page === item.page}
            collapsed={collapsed}
            onClick={() => onOpenPage(item.page)}
            trailing={
              item.page === "model" && modelMissing ? (
                <span
                  className="dot warn"
                  aria-label={t("common.nav.modelMissing")}
                />
              ) : undefined
            }
          />
        ))}
      </nav>
      <div className="sidebar-only-open mt-4 flex min-h-0 flex-1 flex-col">
        <label className="mx-3 flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-2.5 text-subtle focus-within:bg-sidebar-hover focus-within:text-foreground hover:bg-sidebar-hover">
          <Search className="size-4 shrink-0" strokeWidth={1.7} />
          <input
            aria-label={t("common.nav.searchTasks")}
            className="h-full w-full min-w-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-subtle"
            placeholder={t("common.nav.searchTasks")}
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
                        aria-label={t("common.nav.workflow")}
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {item.title}
                    </span>
                    {item.busy ? (
                      <span
                        className="dot live"
                        aria-label={t("common.nav.running")}
                      />
                    ) : null}
                  </button>
                ))}
              </section>
            ))
          ) : (
            <p className="px-2.5 pt-4 text-[13px] text-subtle">
              {search ? t("common.nav.noMatch") : t("common.nav.noTasks")}
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
                  ? t("common.nav.syncFailed")
                  : healthText(health)}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"}>
            {syncError ?? healthText(health)}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
              aria-label={
                theme === "dark"
                  ? t("common.nav.toLight")
                  : t("common.nav.toDark")
              }
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
            {theme === "dark" ? t("common.nav.light") : t("common.nav.dark")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
              aria-label={t("common.nav.signOut")}
              onClick={onSignOut}
            >
              <LogOut className="size-[17px]" strokeWidth={1.7} />
            </button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"}>
            {t("common.nav.signOut")}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
