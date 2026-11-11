import { Bell, BellOff, Blocks, Bot, CircleHelp, Folder, FolderOpen, Inbox as InboxIcon, PanelLeft, Search, Settings, SlidersHorizontal, SquarePen, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { TURN_STATUS_WORDS } from "../../../src/contracts/protocol-words.js";
import type { AttentionItem, PermissionRequest } from "../../../src/contracts/session.js";
import type { HarnessView, SessionSummary, SessionView } from "../../../src/contracts/web.js";
import { errorMessage } from "../api.js";
import { attentionKind, liveItems, mostUrgent, remaining } from "../attention.js";
import { cn } from "../lib/cn.js";
import { ago, folderName, homePath } from "../lib/format.js";
import { useNotificationChoice } from "../lib/notify.js";
import { useNow } from "../lib/prefs.js";
import { Collapsible } from "../ui/motion.js";
import { Popover } from "../ui/overlay.js";
import { Badge, LogoMark, Spinner, StatusDot, Tip } from "../ui/primitives.js";
import { lastingOption } from "./Approval.js";

export type Page = "chat" | "providers" | "harnesses" | "capabilities" | "settings";

/**
 * The user's switch for system notifications in this browser (ADR-035, ADR-054 X04), as the inbox shows it: a pressed
 * button. The browser is asked only when the user turns it on; a browser without notifications, or one that refuses them,
 * leaves it off and silent.
 */
export function NotifyToggle({ withLabel = false }: { readonly withLabel?: boolean }) {
  const { supported, on, blocked, toggle } = useNotificationChoice();
  const title = !supported ? "此浏览器不支持通知" : blocked ? "浏览器已阻止本页的通知，可在浏览器的网站设置中允许" : (on ? "已开启：" : "") + "页面在后台时，有事等你或正在看的对话做完时，用系统通知告诉你";
  return <button type="button" className={cn(withLabel ? "btn btn-sm" : "icon-btn icon-btn-sm", "notify-toggle", on && "text-accent-text")} aria-pressed={on} aria-label="待处理时通知我" title={title} disabled={!supported} onClick={() => void toggle()}>
    {on ? <Bell size={14} aria-hidden="true"/> : <BellOff size={14} aria-hidden="true"/>}{withLabel ? <span>{on ? "已开启通知" : "开启通知"}</span> : null}</button>;
}

/** Where the inbox finds what each waiting request asks and how a one-time option is sent (ADR-035, ADR-054 X03). */
export interface InboxSource {
  /** Every waiting approval and question of every conversation, as the Gateway pushed them; expired ones are left out here. */
  readonly items: readonly AttentionItem[];
  readonly sessions: readonly SessionSummary[];
  readonly harnesses: readonly HarnessView[];
  /** The open conversation's live view: its requests need no read. */
  readonly current: SessionView | null;
  /** Reads another conversation's view, for the title and options of its waiting requests; only while the inbox is shown. */
  readonly onLoad: (sessionId: string, signal: AbortSignal) => Promise<SessionView>;
  /** Sends one option of a waiting request; resolves once the Gateway accepted it. */
  readonly onDecide: (item: AttentionItem, optionId: string) => Promise<void>;
  readonly onOpen: (sessionId: string) => void;
}

interface SidebarProps {
  readonly providerManagement: boolean; readonly page: Page; readonly sessions: readonly SessionSummary[];
  readonly harnesses: readonly HarnessView[]; readonly currentId: string | null; readonly interactionBusy: boolean;
  /** Installation tasks running now, and Agents the Gateway reports an update for (those the Agent page lists). */
  readonly activeJobs: number; readonly updates: number;
  /** Conversations whose latest Turn this page saw fail; the summaries carry no outcome of their own. */
  readonly failed: ReadonlySet<string>;
  /** Whether the page's connections to the local service are up; false while one of them is down. */
  readonly connected: boolean;
  readonly inbox: InboxSource;
  readonly inboxOpen: boolean; readonly onInboxOpenChange: (open: boolean) => void;
  /** Set on narrow screens, where the inbox opens as a sheet of its own instead of beside its row. */
  readonly onInbox?: () => void;
  readonly onCollapse: () => void; readonly onClose?: () => void; readonly onPage: (page: Page) => void; readonly onNew: () => void; readonly onSession: (id: string) => void; readonly onPalette: () => void;
}
type RowState = "wait" | "run" | "unknown" | "closed" | "fail" | "idle";
interface Row { readonly session: SessionSummary; readonly items: readonly AttentionItem[]; readonly state: RowState }
interface Project { readonly key: string; readonly name: string; readonly detail: string | null; readonly rows: readonly Row[] }
/** What a row says about its conversation to assistive technology, after the Agent's name (the Interaction board's words). */
const STATE_WORDS: Readonly<Record<RowState, string>> = { wait: TURN_STATUS_WORDS.waiting, run: TURN_STATUS_WORDS.running, unknown: TURN_STATUS_WORDS.unknown, closed: "已结束", fail: "上一轮" + TURN_STATUS_WORDS.failed, idle: "" };
const RANK: Readonly<Record<RowState, number>> = { wait: 0, run: 1, unknown: 2, closed: 2, fail: 2, idle: 2 };

/**
 * Conversations grouped by project, the workspace they run in (ADR-054 §5): projects keep the Gateway's order, newest
 * first; inside one, those waiting for the user come first, then running ones, then the rest by recency. Projects whose
 * folder names collide carry their parent folder so they can be told apart.
 */
function groupProjects(sessions: readonly SessionSummary[], waiting: ReadonlyMap<string, readonly AttentionItem[]>, failed: ReadonlySet<string>): readonly Project[] {
  const byWorkspace = new Map<string, Row[]>();
  for (const session of sessions) {
    const items = waiting.get(session.id) ?? [];
    const state: RowState = items.length ? "wait" : session.activeRunId !== null ? "run" : session.status === "blocked" ? "unknown" : session.status === "closed" ? "closed" : failed.has(session.id) ? "fail" : "idle";
    const rows = byWorkspace.get(session.workspace);
    if (rows) rows.push({ session, items, state }); else byWorkspace.set(session.workspace, [{ session, items, state }]);
  }
  const names = new Map<string, number>();
  for (const key of byWorkspace.keys()) { const name = folderName(key); names.set(name, (names.get(name) ?? 0) + 1); }
  return [...byWorkspace.entries()].map(([key, rows]) => {
    const name = key.trim() ? folderName(key) : "未归入项目", parent = key.replace(/[\\/][^\\/]*[\\/]*$/u, "");
    return { key, name, detail: key.trim() && (names.get(name) ?? 0) > 1 && parent ? homePath(parent) : null,
      rows: rows.map((row, index) => ({ row, index })).sort((a, b) => RANK[a.row.state] - RANK[b.row.state] || a.index - b.index).map(item => item.row) };
  });
}

const PROJECTS_KEY = "harnesshub:sidebar-projects";
/** Projects shown open by default during this page's life: they stay open in every sidebar (the drawer too) until closed. */
const SHOWN_OPEN = new Set<string>();
/** The projects the user opened or closed in this browser, by workspace; a convenience that starts empty without storage. */
function readProjectChoices(): Readonly<Record<string, boolean>> {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw === null || raw.length > 64 * 1024) return {};
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return {}; }
}
function writeProjectChoices(value: Readonly<Record<string, boolean>>): void {
  // The latest 200 choices are enough to remember; older ones fall back to the default.
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(Object.fromEntries(Object.entries(value).slice(-200)))); } catch { /* lasts for this page only */ }
}

/**
 * Primary navigation (Sidebar board): the mark, a new conversation, search, the inbox of everything waiting for you, the
 * Agents and capabilities, then conversations by project with a state dot each, and the settings with the local
 * service's port at the bottom.
 */
export function Sidebar(props: SidebarProps) {
  const { sessions, currentId, page, interactionBusy } = props;
  const attention = props.inbox.items;
  // Remaining time is counted here, once a second, only while some waiting item has a deadline.
  const now = useNow(attention.some(item => item.expiresAt !== undefined));
  const waiting = useMemo(() => liveItems(attention, now), [attention, now]);
  const bySession = useMemo(() => { const map = new Map<string, AttentionItem[]>(); for (const item of waiting) map.set(item.sessionId, [...(map.get(item.sessionId) ?? []), item]); return map; }, [waiting]);
  const groups = useMemo(() => groupProjects(sessions, bySession, props.failed), [sessions, bySession, props.failed]);
  const name = (id: string) => props.harnesses.find(harness => harness.id === id)?.name ?? id;
  // Opened and closed projects, remembered per workspace; without a choice a project is open when it holds the open
  // conversation, one waiting for you, or the newest conversation, and once shown open it stays open until closed, so a
  // conversation starting elsewhere never folds a project away by itself.
  const [choices, setChoices] = useState(readProjectChoices);
  const choose = (key: string, open: boolean) => setChoices(current => { const next = { ...current }; delete next[key]; next[key] = open; writeProjectChoices(next); return next; });
  const currentProject = sessions.find(session => session.id === currentId)?.workspace;
  // Opening a conversation opens its project, so the selected row is always in view.
  useEffect(() => { if (currentProject !== undefined && choices[currentProject] === false) choose(currentProject, true); }, [currentId, currentProject]);
  const isOpen = (project: Project, index: number) => {
    const choice = choices[project.key];
    if (choice !== undefined) return choice;
    const open = SHOWN_OPEN.has(project.key) || index === 0 || project.key === currentProject || project.rows.some(row => row.state === "wait");
    if (open) SHOWN_OPEN.add(project.key);
    return open;
  };
  // A conversation that appears after the list was first shown opens its row in place (Motion board #36): its row is
  // marked from its very first render, and the mark is kept until the 200 ms opening has run.
  const known = useRef<ReadonlySet<string> | null>(null), timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(() => new Set());
  const seen = known.current, arriving = seen === null ? arrivals : new Set([...arrivals, ...sessions.flatMap(session => seen.has(session.id) ? [] : [session.id])]);
  useLayoutEffect(() => {
    const ids = sessions.map(session => session.id), before = known.current;
    known.current = new Set(ids);
    const fresh = before === null ? [] : ids.filter(id => !before.has(id));
    if (!fresh.length) return;
    setArrivals(current => new Set([...current, ...fresh]));
    const timer = setTimeout(() => { timers.current.delete(timer); setArrivals(current => new Set([...current].filter(id => !fresh.includes(id)))); }, 400);
    timers.current.add(timer);
  }, [sessions]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);

  const count = waiting.length, firstWaiting = useRef<HTMLButtonElement>(null);
  const icon = (glyph: ReactNode) => <span className="flex w-4 flex-none justify-center text-fg-2" aria-hidden="true">{glyph}</span>;
  const nav = (target: Page, label: string, glyph: ReactNode, extra?: ReactNode) => <button type="button" disabled={interactionBusy} aria-current={page === target ? "page" : undefined} onClick={() => props.onPage(target)}
    className="nav-row w-full flex-none disabled:opacity-60">{icon(glyph)}<span className="min-w-0 flex-1 trunc">{label}</span>{extra}</button>;
  const inboxRow = <button type="button" className="nav-row w-full flex-none data-[popup-open]:bg-selected" aria-label={count ? `等你处理（${count} 项）` : "等你处理"} {...(props.onInbox ? { onClick: props.onInbox } : {})}>
    {icon(<InboxIcon size={16}/>)}<span className="min-w-0 flex-1 trunc">等你处理</span>{count ? <Badge tone="amber" count className="attention-count">{count}</Badge> : null}</button>;
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  // Connected, or not: the page retries on its own most of the time, but not after its login is gone, so it claims no more.
  const service = (props.connected ? "本机服务已连接 · " : "与本机服务的连接中断 · ") + window.location.hostname + ":" + port;
  return <aside className="sidebar flex h-full w-full flex-col gap-0.5 bg-sidebar p-3" aria-label="主导航">
    <div className="flex h-10 flex-none items-center gap-2 pr-0.5 pl-1.5">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-[9px] self-stretch rounded-row border-none bg-transparent p-0 text-left text-fg disabled:opacity-60" aria-label="HarnessHub 首页" onClick={props.onNew} disabled={interactionBusy}>
        <LogoMark/><span className="trunc text-[15px] leading-5 font-semibold tracking-[-0.01em]">HarnessHub</span></button>
      {props.onClose ? <button type="button" className="icon-btn h-7 w-7 text-fg-3 hover:bg-selected" aria-label="关闭导航" onClick={props.onClose}><X size={16}/></button>
        : <Tip label="收起侧栏 ⌘B"><button type="button" className="icon-btn h-7 w-7 text-fg-3 hover:bg-selected" aria-label="收起侧栏" aria-keyshortcuts="Meta+B" onClick={props.onCollapse}><PanelLeft size={16}/></button></Tip>}
    </div>
    <Tip label="新对话 ⇧⌘O"><button type="button" className="new-chat-button btn btn-outline btn-lg mt-2 mb-2.5 w-full flex-none" onClick={props.onNew} disabled={interactionBusy} aria-keyshortcuts="Meta+Shift+O">
      <SquarePen size={15} aria-hidden="true"/>新对话</button></Tip>
    <button type="button" className="nav-row w-full flex-none" onClick={props.onPalette} aria-label="搜索与命令" aria-keyshortcuts="Meta+K">
      {icon(<Search size={16}/>)}<span className="flex-1">搜索</span><span className="text-caption text-fg-3" aria-hidden="true">⌘K</span></button>
    {props.onInbox ? inboxRow : <Popover label="等你处理" open={props.inboxOpen} onOpenChange={props.onInboxOpenChange} side="right" align="start" sideOffset={20} initialFocus={firstWaiting}
      className="inbox-pop flex w-[440px] max-w-[calc(100vw-24px)] flex-col" trigger={inboxRow}><InboxList {...props.inbox} focusRef={firstWaiting}/></Popover>}
    {nav("harnesses", "Harness", <Bot size={16}/>, props.activeJobs ? <Spinner size={13} tone="run" label={`${props.activeJobs} 个安装任务进行中`}/>
      : props.updates ? <Badge tone="accent" className="h-[18px]">{props.updates} 个更新</Badge> : null)}
    {nav("capabilities", "能力", <Blocks size={16}/>)}
    {props.providerManagement ? nav("providers", "模型连接", <SlidersHorizontal size={16}/>) : null}
    <div className="session-section mt-3.5 flex min-h-0 flex-1 flex-col gap-0.5">
      <h2 className="m-0 flex h-[30px] flex-none items-center pr-1 pl-2.5 text-ui-sm font-normal text-fg-3">项目</h2>
      <nav className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 pb-2" aria-label="对话列表">
        {sessions.length === 0 ? <p className="m-0 px-2.5 py-2 text-ui-sm text-fg-3">对话会按项目（工作区）归在这里。</p>
          : groups.map((project, index) => <ProjectGroup key={project.key} project={project} open={isOpen(project, index)} onToggle={open => choose(project.key, open)}
            now={now} currentId={page === "chat" ? currentId : null} disabled={interactionBusy} arrivals={arriving} harness={name} onSession={props.onSession}/>)}
      </nav>
    </div>
    <div className="flex-none pt-1">
      <button type="button" className="nav-row w-full disabled:opacity-60" disabled={interactionBusy} aria-current={page === "settings" ? "page" : undefined} aria-label="设置" onClick={() => props.onPage("settings")}>
        {icon(<Settings size={16}/>)}<span className="flex-1">设置</span>
        <span className="service-status flex items-center gap-1.5 text-[11px] leading-4 text-fg-3" title={service} aria-hidden="true"><StatusDot tone={props.connected ? "run" : "idle"} live={false} size={6}/>{port}</span></button>
      <span className="sr-only" role="status">{props.connected ? "" : "与本机服务的连接中断"}</span>
    </div>
  </aside>;
}

function ProjectGroup({ project, open, onToggle, now, currentId, disabled, arrivals, harness, onSession }: {
  readonly project: Project; readonly open: boolean; readonly onToggle: (open: boolean) => void; readonly now: number; readonly currentId: string | null; readonly disabled: boolean;
  readonly arrivals: ReadonlySet<string>; readonly harness: (id: string) => string; readonly onSession: (id: string) => void;
}) {
  const listId = useId(), summaryId = listId + "-summary";
  // A closed project still shows the most pressing state inside it, so nothing waiting for you hides in it.
  const strongest = project.rows.find(row => row.state === "wait") ?? project.rows.find(row => row.state === "run") ?? project.rows.find(row => row.state === "fail");
  return <div className="session-group flex flex-col gap-0.5">
    <Tip label={project.key || "没有工作区的对话"} side="right"><button type="button" className="nav-row w-full gap-2 pr-2.5 pl-2" aria-expanded={open} aria-controls={listId}
      aria-label={project.name + (project.detail ? " · " + project.detail : "")} aria-describedby={summaryId} onClick={() => onToggle(!open)}>
      {open ? <FolderOpen size={16} className="text-accent-text" aria-hidden="true"/> : <Folder size={16} className="text-fg-2" aria-hidden="true"/>}
      <span className="min-w-0 flex-1 trunc">{project.name}{project.detail ? <span className="text-fg-3"> · {project.detail}</span> : null}</span>
      {!open && strongest ? <StatusDot tone={strongest.state === "wait" ? "wait" : strongest.state === "run" ? "run" : "fail"} live={false}/> : null}
      {!open ? <span className="text-caption text-fg-3" aria-hidden="true">{project.rows.length}</span> : null}
      <span id={summaryId} className="sr-only">{project.rows.length} 个对话{strongest ? "，有" + STATE_WORDS[strongest.state] + "的" : ""}</span>
    </button></Tip>
    <Collapsible open={open} id={listId}>
      <div className="flex flex-col gap-0.5">{project.rows.map(row => <div key={row.session.id} className={cn(arrivals.has(row.session.id) && "motion-list-insert")}><div>
        <SessionRow row={row} now={now} harness={harness(row.session.selection.harnessId)} current={currentId === row.session.id} disabled={disabled} onOpen={() => onSession(row.session.id)}/>
      </div></div>)}</div>
    </Collapsible>
  </div>;
}

/**
 * One conversation: its title, then the state mark of the Icons board (blue breathing while running, amber while it waits
 * for you, red when its latest Turn failed, a question mark when the result is unknown). One waiting for you also says
 * for what and whose deadline runs; deciding happens in the conversation or the inbox.
 */
function SessionRow({ row, now, harness, current, disabled, onOpen }: { readonly row: Row; readonly now: number; readonly harness: string; readonly current: boolean; readonly disabled: boolean; readonly onOpen: () => void }) {
  const { session, items, state } = row;
  const urgent = mostUrgent(items), left = urgent === null ? null : remaining(urgent, now);
  const id = useId(), metaId = id + "-meta", lineId = id + "-line", title = session.title || "新对话";
  const indicator = state === "wait" ? <StatusDot tone="wait"/> : state === "run" ? <StatusDot tone="run"/> : state === "fail" ? <StatusDot tone="fail"/>
    : state === "unknown" ? <CircleHelp size={14} className="text-fg-3" aria-hidden="true"/> : null;
  return <button type="button" disabled={disabled} onClick={onOpen} aria-current={current ? "page" : undefined} aria-label={title} aria-describedby={left ? metaId + " " + lineId : metaId}
    className={cn("session-item nav-row w-full flex-col items-stretch justify-center gap-0 pr-2.5 pl-8 disabled:opacity-60", left ? "has-attention h-auto py-1.5" : "h-8")}>
    <span className="flex h-5 min-w-0 items-center gap-2">
      <span className={cn("session-title min-w-0 flex-1 trunc", state === "closed" && "text-fg-2")}>{title}</span>{indicator}
    </span>
    {urgent && left ? <span id={lineId} className="attention-line line-clamp-2 text-caption text-amber-on-tint" title={left.hint}>{attentionKind(urgent)}{items.length > 1 ? `（${items.length} 项）` : ""}{left.source ? " · " + left.source : ""} <span className="whitespace-nowrap">{left.text}</span></span> : null}
    <span id={metaId} className="sr-only">{harness}{STATE_WORDS[state] ? " · " + STATE_WORDS[state] : ""}</span>
  </button>;
}

const REFUSING = /reject|deny|decline|cancel|abort|拒绝|取消|中止/iu;
/** The option the inbox may send directly: the first one that answers this request only and is not a refusal. */
function directOption(request: PermissionRequest | undefined): { readonly id: string; readonly name: string } | null {
  if (!request || request.decided || request.input !== undefined || request.kind === "question") return null;
  return request.options.find(option => !lastingOption(option) && !REFUSING.test(option.id + " " + option.name)) ?? null;
}
/** Most urgent first: the earliest deadline, then the oldest request; one without a deadline comes after those with one. */
export function byUrgency(a: AttentionItem, b: AttentionItem): number {
  return (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || a.requestedAt - b.requestedAt;
}

/** What the inbox knows of another conversation's waiting requests: the last read of its view, and whether one is under way. */
interface ConversationRead { readonly requests: readonly PermissionRequest[] | null; readonly loading: boolean }

/**
 * The inbox of everything waiting for you (Interaction board, X03): every conversation's approvals and questions, most
 * urgent first, each with the Agent, what it asks once its conversation has been read, the conversation and whose
 * deadline runs (or, without one, how long it has waited). Only an option that answers this one request can be sent from
 * here; anything that lasts, and every question, is decided in the conversation. The notification switch sits in its
 * head, beside `onClose` when the layer showing the list has no other way out on a touch screen. `focusRef` receives the
 * first waiting item, for that layer to focus when it opens.
 */
export function InboxList({ items, sessions, harnesses, current, onLoad, onDecide, onOpen, focusRef, onClose }: InboxSource & {
  readonly focusRef?: RefObject<HTMLButtonElement | null>; readonly onClose?: () => void;
}) {
  // The list exists only while it is shown; its clock runs then, for deadlines and for how long each request has waited.
  const now = useNow(items.length > 0);
  const sorted = [...liveItems(items, now)].sort(byUrgency);
  // Other conversations' requests, read while the inbox is shown: once for the requests each one has waiting, and again
  // when a request it was not read for arrives. A read is cancelled only when its conversation leaves the list, or the
  // list closes; a failed one leaves its rows to open their conversation.
  const [read, setRead] = useState<ReadonlyMap<string, ConversationRead>>(() => new Map());
  const reads = useRef(new Map<string, { readonly asked: ReadonlySet<string>; readonly controller: AbortController }>());
  const wanted = new Map<string, string[]>();
  for (const item of sorted) if (item.sessionId !== current?.id) wanted.set(item.sessionId, [...(wanted.get(item.sessionId) ?? []), item.permissionId]);
  const wantedKey = JSON.stringify([...wanted].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  useEffect(() => {
    for (const [id, entry] of reads.current) if (!wanted.has(id)) { entry.controller.abort(); reads.current.delete(id); }
    for (const [id, permissions] of wanted) {
      const known = reads.current.get(id);
      if (known && permissions.every(permission => known.asked.has(permission))) continue;
      known?.controller.abort();
      const entry = { asked: new Set(permissions), controller: new AbortController() };
      reads.current.set(id, entry);
      setRead(map => new Map(map).set(id, { requests: map.get(id)?.requests ?? null, loading: true }));
      onLoad(id, entry.controller.signal).then(view => {
        if (!entry.controller.signal.aborted) setRead(map => new Map(map).set(id, { requests: view.permissions ?? [], loading: false }));
      }, () => {
        if (entry.controller.signal.aborted) return;
        if (reads.current.get(id) === entry) reads.current.delete(id);
        setRead(map => new Map(map).set(id, { requests: map.get(id)?.requests ?? null, loading: false }));
      });
    }
  }, [wantedKey]);
  useEffect(() => () => { for (const entry of reads.current.values()) entry.controller.abort(); reads.current.clear(); }, []);
  const [sending, setSending] = useState<Readonly<Record<string, "sending" | "sent" | { readonly error: string }>>>({});
  const request = (item: AttentionItem): PermissionRequest | undefined =>
    (item.sessionId === current?.id ? current.permissions ?? [] : read.get(item.sessionId)?.requests ?? []).find(row => row.id === item.permissionId);
  const decide = (item: AttentionItem, option: { readonly id: string }) => {
    setSending(state => ({ ...state, [item.permissionId]: "sending" }));
    onDecide(item, option.id).then(() => setSending(state => ({ ...state, [item.permissionId]: "sent" })),
      (failure: unknown) => setSending(state => ({ ...state, [item.permissionId]: { error: errorMessage(failure) } })));
  };
  return <>
    <div className="flex flex-none items-center gap-1 hairline-b py-2 pr-2 pl-3.5">
      <h3 className="m-0 flex-1 text-ui-sm font-semibold">等你处理{sorted.length ? <span className="ml-1.5 font-normal text-fg-3">{sorted.length}</span> : null}</h3><NotifyToggle/>
      {onClose ? <button type="button" className="icon-btn icon-btn-sm" aria-label="关闭等你处理" onClick={onClose}><X size={14}/></button> : null}</div>
    {sorted.length ? <ul className="m-0 flex min-h-0 list-none flex-col gap-0.5 overflow-y-auto p-1.5">{sorted.map((item, index) => {
      const left = remaining(item, now), session = sessions.find(row => row.id === item.sessionId), harness = harnesses.find(row => row.id === item.harnessId)?.name ?? item.harnessId;
      const ask = request(item), option = directOption(ask), state = sending[item.permissionId], lineId = "inbox-" + item.permissionId;
      const loading = ask === undefined && item.sessionId !== current?.id && (read.get(item.sessionId)?.loading ?? true);
      // Whose deadline runs and what is left of it; a request without one says how long it has waited (the board's "2 分钟前").
      const when = item.expiresAt === undefined ? ago(item.requestedAt, now) : (left.source ? left.source + " " : "") + left.text;
      return <li key={item.permissionId} className="row flex items-center gap-2 pr-2">
        <button type="button" ref={index === 0 ? focusRef : undefined} className="flex min-w-0 flex-1 items-start gap-2.5 rounded-row border-none bg-transparent py-2 pl-2.5 text-left text-fg" onClick={() => onOpen(item.sessionId)}>
          <StatusDot tone="wait" className="mt-[7px]"/>
          {/* Where the column is narrow (a phone's sheet), the conversation and the deadline take a line each. */}
          <span className="@container flex min-w-0 flex-1 flex-col gap-px">
            <span className="trunc text-ui-sm font-medium" id={lineId}>{harness}{ask ? <span className="font-normal">：{ask.title}</span> : " " + attentionKind(item)}</span>
            <span className="flex min-w-0 items-baseline gap-1 text-caption text-fg-3 @max-[280px]:flex-col @max-[280px]:items-start @max-[280px]:gap-0">
              <span className="min-w-0 max-w-full trunc">{session?.title || "另一个对话"}</span><span className="flex-none @max-[280px]:hidden">·</span>
              <span className="max-w-full flex-none" title={left.hint}>{attentionKind(item)} · {when}</span></span>
            {typeof state === "object" ? <span className="text-caption text-red" role="alert">没有送达：{state.error}</span> : null}
          </span>
          {option === null && state !== "sent" ? loading ? <Spinner size={13} label="正在读取请求" className="mt-1"/> : <span className="mt-px flex-none rounded-row bg-subtle px-2 text-caption leading-6 text-fg">打开</span> : null}
        </button>
        {state === "sent" ? <span className="flex-none px-1 text-caption text-fg-3" role="status">已送出</span>
          : option ? <button type="button" className="btn btn-sm btn-primary flex-none" aria-describedby={lineId} disabled={state === "sending"} onClick={() => decide(item, option)}>
            {state === "sending" ? <Spinner size={12} label="" className="text-on-accent"/> : null}{option.name}</button> : null}
      </li>;
    })}</ul> : <p className="m-0 px-3.5 py-6 text-center text-ui-sm text-fg-3">没有等你处理的审批或提问。</p>}
    <p className="m-0 flex-none hairline-t px-3.5 py-2 text-caption text-fg-3">只有一次性的选项能在这里直接点；持续生效的选项和提问要进对话里看清楚再选。</p>
  </>;
}
