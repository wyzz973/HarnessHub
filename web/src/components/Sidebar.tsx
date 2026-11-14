import { AlarmClock, AlarmClockOff, Archive, ArchiveRestore, Bell, BellOff, Blocks, Bot, CalendarClock, ChevronRight, CircleDot, CircleHelp, Copy, Folder, FolderOpen, GitBranch, Hash, Inbox as InboxIcon, ListFilter, MessageCircle, MoreHorizontal, PanelLeft, PencilLine, Pin, PinOff, Search, Settings, SlidersHorizontal, SquarePen, Trash2, X } from "lucide-react";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode, RefObject } from "react";
import { TURN_STATUS_WORDS } from "../../../src/contracts/protocol-words.js";
import type { AttentionItem, PermissionRequest } from "../../../src/contracts/session.js";
import type { HarnessView, SessionSummary } from "../../../src/contracts/web.js";
import type { ConversationView } from "../lib/conversation.js";
import type { ClientSessionView } from "../lib/protocol/wire.js";
import { errorMessage } from "../api.js";
import { attentionKind, liveItems, mostUrgent, remaining, secondsLeft } from "../attention.js";
import { cn } from "../lib/cn.js";
import { ariaKeys, keyText, useKeys } from "../lib/keys.js";
import { ago, agoShort, clock, folderName, homePath, inScratch, untilShort } from "../lib/format.js";
import { markSeen, startSeen, unseen, useSeen } from "../lib/seen.js";
import { useNotificationChoice } from "../lib/notify.js";
import { useNow } from "../lib/prefs.js";
import { Collapsible } from "../ui/motion.js";
import { Dialog, Menu, Popover } from "../ui/overlay.js";
import { Badge, LogoMark, Spinner, StatusDot, Tip } from "../ui/primitives.js";
import { lastingOption } from "./Approval.js";
import { BrandIcon } from "./BrandIcon.js";

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
  readonly current: ConversationView | null;
  /** Reads another conversation's view, for the title and options of its waiting requests; only while the inbox is shown. */
  readonly onLoad: (sessionId: string, signal: AbortSignal) => Promise<ClientSessionView>;
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
  /** Where the Gateway keeps the folders of conversations started without one; those are listed together as 临时对话. */
  readonly scratchRoot?: string | undefined;
  /** Whether the page's connections to the local service are up; false while one of them is down. */
  readonly connected: boolean;
  readonly inbox: InboxSource;
  readonly inboxOpen: boolean; readonly onInboxOpenChange: (open: boolean) => void;
  /** Set on narrow screens, where the inbox opens as a sheet of its own instead of beside its row. */
  readonly onInbox?: () => void;
  readonly onCollapse: () => void; readonly onClose?: () => void; readonly onPage: (page: Page) => void; readonly onNew: () => void; readonly onSession: (id: string) => void; readonly onPalette: () => void;
  /** Whether the Gateway has conversations after the ones listed, and the way to read the next page of them; the list asks for it when it is scrolled to its end. */
  readonly more?: boolean; readonly onMore?: () => void;
  /** What a conversation's row does to it (2026-11-14, after the sidebar of T3 Code): another title, put away or brought back, its folder shown in the Finder. */
  readonly actions?: SessionActions | undefined;
}
export interface SessionActions {
  readonly rename: (id: string, title: string) => void;
  readonly archive: (id: string, archived: boolean) => void;
  readonly reveal: (id: string) => void;
  /** Keeps it at the top of the list, or lets it go back among the rest. */
  readonly pin: (id: string, pinned: boolean) => void;
  /** Puts it aside until a moment (milliseconds since the epoch), or brings it back now (null). */
  readonly snooze: (id: string, until: number | null) => void;
  /** Takes it off the list; the way back is offered for a few seconds. */
  readonly remove: (id: string) => void;
  /** Shows it as moved on since it was last seen here, until it is opened or moves again. */
  readonly markUnread: (id: string) => void;
  /** Gives a pinned conversation another place among the pinned (dragged there): the order it is listed by, lowest first. */
  readonly reorderPin?: ((id: string, order: number) => void) | undefined;
  /** Puts a text of the conversation on the clipboard — its folder's path, its id — and says so. */
  readonly copy?: ((text: string, what: string) => void) | undefined;
  /** The same for several conversations picked at once (⌘-click, ⇧-click; after T3 Code), each taken back together for a few seconds. */
  readonly many?: {
    readonly archive: (ids: readonly string[]) => void;
    readonly pin: (ids: readonly string[], pinned: boolean) => void;
    readonly snooze: (ids: readonly string[], until: number) => void;
    readonly markUnread: (ids: readonly string[]) => void;
    readonly remove: (ids: readonly string[]) => void;
  } | undefined;
  /** What was deleted and can still come back (最近删除), read when the shelf is opened; absent where the Gateway keeps no such list. */
  readonly trash?: TrashAccess | undefined;
  /** How the list is grouped, and the way to change it. */
  readonly grouping: "project" | "state"; readonly onGrouping: (grouping: "project" | "state") => void;
  /** Told the conversations in the order the list shows them (closed groups and shelves left out), for the keys that open one by its place. */
  readonly onOrder?: ((ids: readonly string[]) => void) | undefined;
}
/** The conversations deleted and not yet gone for good: read a page at a time, each brought back or deleted for good, or all of them at once. */
export interface TrashAccess {
  readonly load: (before: string | undefined, signal: AbortSignal) => Promise<{ readonly sessions: readonly (SessionSummary & { readonly deletedAt: number })[]; readonly next: string | null }>;
  readonly restore: (id: string) => Promise<void>;
  /** Deletes it for good, once the user has said so; with `removeWorktree`, its Git worktree too (its branch stays). */
  readonly purge: (id: string, removeWorktree: boolean) => Promise<void>;
  /** Deletes every one for good, once the user has said so; with `removeWorktrees`, the worktrees no conversation left works in too. */
  readonly purgeAll: (removeWorktrees: boolean) => Promise<void>;
  /** Where a deleted conversation's worktree stands (its branch, its files not committed, whether another conversation works in it); null when it has none. */
  readonly worktree?: ((id: string, signal: AbortSignal) => Promise<{ readonly branch: string | null; readonly dirty: number; readonly shared: boolean; readonly missing?: true | undefined } | null>) | undefined;
  /** Changes whenever a conversation is deleted, brought back or deleted for good: the shelf reads its list again. */
  readonly stamp: number;
}
/** The moments a conversation can be put aside until, from now: in an hour, this evening (or tomorrow morning once it is evening), tomorrow morning, next Monday morning. */
function snoozeChoices(now: number): readonly { readonly label: string; readonly until: number }[] {
  const at = (days: number, hour: number): number => { const day = new Date(now); day.setDate(day.getDate() + days); day.setHours(hour, 0, 0, 0); return day.getTime(); };
  const today = new Date(now), toMonday = (8 - today.getDay()) % 7 || 7;
  return [{ label: "1 小时后", until: now + 3_600_000 }, { label: "3 小时后", until: now + 3 * 3_600_000 }, ...(today.getHours() < 17 ? [{ label: "今晚 18:00", until: at(0, 18) }] : []), { label: "明天 9:00", until: at(1, 9) }, ...(toMonday > 1 ? [{ label: "下周一 9:00", until: at(toMonday, 9) }] : [])];
}
type RowState = "wait" | "run" | "unknown" | "closed" | "fail" | "idle";
interface Row { readonly session: SessionSummary; readonly items: readonly AttentionItem[]; readonly state: RowState;
  /** A conversation another one in the list delegated work to: it stands right under that one, set in. */
  readonly child?: true;
  /** How many of the conversations it delegated work to are at work now. */
  readonly delegating?: number }
interface Project { readonly key: string; readonly name: string; readonly detail: string | null; readonly rows: readonly Row[]; readonly scratch: boolean }
/** The group of the conversations started without a folder: each has a folder of its own, and they are listed together. */
const SCRATCH_KEY = "\u0000scratch";
/** What a row says about its conversation to assistive technology, after the Agent's name (the Interaction board's words). */
const STATE_WORDS: Readonly<Record<RowState, string>> = { wait: TURN_STATUS_WORDS.waiting, run: TURN_STATUS_WORDS.running, unknown: TURN_STATUS_WORDS.unknown, closed: "已结束", fail: "上一轮" + TURN_STATUS_WORDS.failed, idle: "" };
const RANK: Readonly<Record<RowState, number>> = { wait: 0, run: 1, unknown: 2, closed: 2, fail: 2, idle: 2 };

/**
 * Conversations grouped by project, the workspace they run in (ADR-054 §5): projects keep the Gateway's order, newest
 * first; inside one, those waiting for the user come first, then running ones, then the rest by recency. Projects whose
 * folder names collide carry their parent folder so they can be told apart.
 */
/**
 * The folder a conversation belongs to in the list: its workspace, or — for one working in a Git worktree of its own — the same place in the repository's main checkout,
 * so that it stands with the project's other conversations.
 */
function projectOf(session: SessionSummary): string {
  const worktree = session.worktree;
  if (worktree === undefined) return session.workspace;
  const inside = session.workspace === worktree.path ? "" : session.workspace.startsWith(worktree.path + "/") ? session.workspace.slice(worktree.path.length) : null;
  return inside === null ? session.workspace : worktree.root + inside;
}
/** A conversation as a row: what waits in it for the user, and how it stands. */
function rowOf(session: SessionSummary, waiting: ReadonlyMap<string, readonly AttentionItem[]>, failed: ReadonlySet<string>): Row {
  const items = waiting.get(session.id) ?? [];
  const state: RowState = items.length ? "wait" : session.activeRunId !== null ? "run" : session.status === "blocked" ? "unknown" : session.status === "closed" ? "closed" : failed.has(session.id) ? "fail" : "idle";
  return { session, items, state };
}
function groupProjects(sessions: readonly SessionSummary[], waiting: ReadonlyMap<string, readonly AttentionItem[]>, failed: ReadonlySet<string>, scratchRoot: string | undefined): readonly Project[] {
  const keyOf = (workspace: string) => inScratch(workspace, scratchRoot) ? SCRATCH_KEY : workspace;
  const byWorkspace = new Map<string, Row[]>();
  for (const session of sessions) {
    const row = rowOf(session, waiting, failed);
    const key = keyOf(projectOf(session)), rows = byWorkspace.get(key);
    if (rows) rows.push(row); else byWorkspace.set(key, [row]);
  }
  const names = new Map<string, number>();
  for (const key of byWorkspace.keys()) { if (key === SCRATCH_KEY) continue; const name = folderName(key); names.set(name, (names.get(name) ?? 0) + 1); }
  return [...byWorkspace.entries()].map(([key, rows]) => {
    const scratch = key === SCRATCH_KEY, name = scratch ? "临时对话" : key.trim() ? folderName(key) : "未归入项目", parent = key.replace(/[\\/][^\\/]*[\\/]*$/u, "");
    return { key, name, scratch, detail: !scratch && key.trim() && (names.get(name) ?? 0) > 1 && parent ? homePath(parent) : null,
      rows: nested(rows.map((row, index) => ({ row, index })).sort((a, b) => RANK[a.row.state] - RANK[b.row.state] || a.index - b.index).map(item => item.row)) };
  });
}

/** The rows with each delegated conversation moved under the one that delegated it (when that one is listed in the same group), in the order they had. */
function nested(rows: readonly Row[]): readonly Row[] {
  const listed = new Set(rows.map(row => row.session.id)), under = new Map<string, Row[]>();
  for (const row of rows) { const parent = row.session.parent?.sessionId; if (parent !== undefined && parent !== row.session.id && listed.has(parent)) under.set(parent, [...(under.get(parent) ?? []), { ...row, child: true }]); }
  if (under.size === 0) return rows;
  const placed = new Set<string>(), out: Row[] = [];
  const put = (row: Row): void => {
    if (placed.has(row.session.id)) return;
    placed.add(row.session.id);
    const children = under.get(row.session.id) ?? [], busy = children.filter(child => child.state === "run" || child.state === "wait").length;
    out.push(busy > 0 ? { ...row, delegating: busy } : row);
    for (const child of children) put(child);
  };
  for (const row of rows) { const parent = row.session.parent?.sessionId; if (parent === undefined || parent === row.session.id || !listed.has(parent)) put(row); }
  // A ring of parents would leave rows out: whatever is left is listed as it was.
  for (const row of rows) put(row);
  return out;
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
/** Where a pinned conversation stands among the pinned: the order the user gave it, else after every ordered one. */
const pinOrder = (session: SessionSummary): number => typeof session.pinnedOrder === "number" && Number.isFinite(session.pinnedOrder) ? session.pinnedOrder : Number.MAX_SAFE_INTEGER;
/** How a pinned row is dropped at another one's place: before or after it. */
interface PinDragging { readonly drop: (id: string, target: string, after: boolean) => void }
const PinDragContext = createContext<PinDragging | null>(null);
/** The conversations picked for an action on several at once, and how a click with ⌘ or ⇧ picks: it answers true when it picked (the row then does not open). */
interface Picking { readonly picked: ReadonlySet<string>; readonly pick: (id: string, keys: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean }) => boolean }
const PickContext = createContext<Picking | null>(null);

export function Sidebar(props: SidebarProps) {
  const { sessions, currentId, page, interactionBusy } = props;
  useKeys();
  const attention = props.inbox.items;
  // Remaining time is counted here, once a second, only while some waiting item has a deadline.
  const now = useNow(attention.some(item => item.expiresAt !== undefined) || sessions.some(session => session.activeRunId !== null));
  const waiting = useMemo(() => liveItems(attention, now), [attention, now]);
  const bySession = useMemo(() => { const map = new Map<string, AttentionItem[]>(); for (const item of waiting) map.set(item.sessionId, [...(map.get(item.sessionId) ?? []), item]); return map; }, [waiting]);
  // A conversation the user put away is listed apart, at the end; one that is at work or waits for them stands among the rest whatever it was.
  const quiet = (session: SessionSummary): boolean => session.activeRunId === null && !bySession.has(session.id);
  const away = useMemo(() => new Set(sessions.filter(session => session.archived === true && quiet(session)).map(session => session.id)), [sessions, bySession]);
  // One put aside until a moment stands apart until that moment (a timer brings the list round then), unless it is at work or waits for the user meanwhile.
  const [, wake] = useState(0);
  const aside = useMemo(() => new Set(sessions.filter(session => session.snoozedUntil !== undefined && session.snoozedUntil > Date.now() && !away.has(session.id) && quiet(session)).map(session => session.id)), [sessions, away, bySession, now]);
  useEffect(() => {
    const next = Math.min(...sessions.flatMap(session => session.snoozedUntil !== undefined && session.snoozedUntil > Date.now() ? [session.snoozedUntil] : []));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => wake(value => value + 1), Math.min(next - Date.now() + 500, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [sessions, aside]);
  const listed = useMemo(() => sessions.filter(session => !away.has(session.id) && !aside.has(session.id)), [sessions, away, aside]);
  // Pinned conversations lead the list, in either grouping, and are not listed a second time under their folder or their state.
  const pinned = useMemo(() => nested(listed.filter(session => session.pinned === true).sort((left, right) => pinOrder(left) - pinOrder(right) || right.updatedAt - left.updatedAt)
    .map(session => rowOf(session, bySession, props.failed))), [listed, bySession, props.failed]);
  // Dragging a pinned conversation to another place among the pinned (after T3 Code): the place it is dropped at gives it an order between its new neighbours.
  const reorderPin = props.actions?.reorderPin;
  const dragPin = useMemo<PinDragging | null>(() => reorderPin === undefined ? null : { drop: (id, target, after) => {
    const order = pinned.map(row => row.session).filter(session => session.id !== id), at = order.findIndex(session => session.id === target);
    if (at < 0) return;
    const index = after ? at + 1 : at, before = order[index - 1], next = order[index];
    const value = before === undefined && next === undefined ? 0 : before === undefined ? pinOrder(next!) - 1 : next === undefined ? pinOrder(before) + 1 : (pinOrder(before) + pinOrder(next)) / 2;
    reorderPin(id, Number.isFinite(value) ? value : 0);
  } }, [reorderPin, pinned]);
  const rest = useMemo(() => listed.filter(session => session.pinned !== true), [listed]);
  const grouping = props.actions?.grouping ?? "project";
  const groups = useMemo(() => grouping === "project" ? groupProjects(rest, bySession, props.failed, props.scratchRoot) : [], [grouping, rest, bySession, props.failed, props.scratchRoot]);
  const shelfRow = (session: SessionSummary): Row => ({ session, items: [], state: session.status === "closed" ? "closed" : "idle" });
  const shelf = useMemo(() => sessions.filter(session => away.has(session.id)).map(shelfRow), [sessions, away]);
  const later = useMemo(() => sessions.filter(session => aside.has(session.id)).map(shelfRow), [sessions, aside]);
  // What this browser has seen of each conversation: the first list is all seen, the open conversation is seen as it moves, and the rest are unread once they move on.
  const looked = useSeen(), openRow = page === "chat" ? sessions.find(session => session.id === currentId) : undefined;
  useEffect(() => { if (sessions.length > 0) startSeen(sessions); }, [sessions.length > 0]);
  useEffect(() => { if (openRow !== undefined) markSeen([openRow]); }, [openRow?.id, openRow?.updatedSeq]);
  const name = (id: string) => props.harnesses.find(harness => harness.id === id)?.name ?? id;
  // Opened and closed projects, remembered per workspace; without a choice a project is open when it holds the open
  // conversation, one waiting for you, or the newest conversation, and once shown open it stays open until closed, so a
  // conversation starting elsewhere never folds a project away by itself.
  const [choices, setChoices] = useState(readProjectChoices);
  const choose = (key: string, open: boolean) => setChoices(current => { const next = { ...current }; delete next[key]; next[key] = open; writeProjectChoices(next); return next; });
  const currentRow = sessions.find(session => session.id === currentId), currentWorkspace = currentRow === undefined ? undefined : projectOf(currentRow);
  const currentProject = currentWorkspace === undefined ? undefined : inScratch(currentWorkspace, props.scratchRoot) ? SCRATCH_KEY : currentWorkspace;
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

  // By state: a conversation that waits for you, failed, stands unknown or has moved on unseen needs you; one at work is at work; the rest are the rest.
  const byState = useMemo(() => {
    const rows = grouping === "state" ? nested(rest.map(session => rowOf(session, bySession, props.failed))) : [];
    const needs = (row: Row): boolean => row.state === "wait" || row.state === "fail" || row.state === "unknown" || (row.state === "idle" && !(page === "chat" && row.session.id === currentId) && unseen(looked, row.session));
    return { need: rows.filter(needs), work: rows.filter(row => !needs(row) && row.state === "run"), rest: rows.filter(row => !needs(row) && row.state !== "run") };
  }, [grouping, rest, bySession, props.failed, looked, page, currentId]);
  const folder = (session: SessionSummary): string => inScratch(session.workspace, props.scratchRoot) ? "临时对话" : folderName(session.workspace);
  // The rows in the order they stand, for ⌥⌘1–9: the pinned, then the groups as they are drawn (a closed project's rows are not in sight, and not counted).
  const shownOrder = [...pinned, ...(grouping === "project" ? groups.flatMap((project, index) => isOpen(project, index) ? project.rows : []) : [...byState.need, ...byState.work, ...byState.rest])].map(row => row.session.id);
  const orderKey = shownOrder.join(",");
  useEffect(() => { props.actions?.onOrder?.(shownOrder); }, [orderKey]);
  // Several conversations picked at once (after T3 Code): ⌘-click picks or drops one, ⇧-click the run from the last one picked, Esc lets them go; a plain click opens
  // one as ever and lets the others go. The actions on them stand at the foot of the list.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set()), anchor = useRef<string | null>(null);
  const many = props.actions?.many;
  const picking = useMemo<Picking>(() => ({ picked, pick: (id, keys) => {
    if (many === undefined) return false;
    if (keys.metaKey || keys.ctrlKey) { anchor.current = id; setPicked(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; }); return true; }
    if (keys.shiftKey) {
      const order = shownOrder, from = anchor.current === null ? -1 : order.indexOf(anchor.current), to = order.indexOf(id);
      if (to < 0) return false;
      const [low, high] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      setPicked(current => new Set([...current, ...order.slice(low, high + 1)])); if (from < 0) anchor.current = id;
      return true;
    }
    if (picked.size > 0) setPicked(new Set());
    return false;
  } }), [picked, many, orderKey]);
  // Picked conversations that left the list are let go.
  useEffect(() => { if ([...picked].some(id => !sessions.some(session => session.id === id))) setPicked(current => new Set([...current].filter(id => sessions.some(session => session.id === id)))); }, [sessions]);
  useEffect(() => {
    if (picked.size === 0) return;
    const off = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setPicked(new Set()); anchor.current = null; } };
    document.addEventListener("keydown", off);
    return () => document.removeEventListener("keydown", off);
  }, [picked.size]);
  const pickedIds = [...picked], done = () => { setPicked(new Set()); anchor.current = null; };
  const rowProps = { now, currentId: page === "chat" ? currentId : null, disabled: interactionBusy, harness: name, onSession: props.onSession, unread: (session: SessionSummary) => unseen(looked, session), actions: props.actions, arrivals: arriving };
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
        : <Tip label={"收起侧栏 " + keyText("sidebar")}><button type="button" className="icon-btn h-7 w-7 text-fg-3 hover:bg-selected" aria-label="收起侧栏" aria-keyshortcuts={ariaKeys("sidebar")} onClick={props.onCollapse}><PanelLeft size={16}/></button></Tip>}
    </div>
    <Tip label={"新对话 " + keyText("new")}><button type="button" className="new-chat-button btn btn-outline btn-lg mt-2 mb-2.5 w-full flex-none" onClick={props.onNew} disabled={interactionBusy} aria-keyshortcuts={ariaKeys("new")}>
      <SquarePen size={15} aria-hidden="true"/>新对话</button></Tip>
    <button type="button" className="nav-row w-full flex-none" onClick={props.onPalette} aria-label="搜索与命令" aria-keyshortcuts={ariaKeys("palette")}>
      {icon(<Search size={16}/>)}<span className="flex-1">搜索</span><span className="text-caption text-fg-3" aria-hidden="true">{keyText("palette")}</span></button>
    {props.onInbox ? inboxRow : <Popover label="等你处理" open={props.inboxOpen} onOpenChange={props.onInboxOpenChange} side="right" align="start" sideOffset={20} initialFocus={firstWaiting}
      className="inbox-pop flex w-[440px] max-w-[calc(100vw-24px)] flex-col" trigger={inboxRow}><InboxList {...props.inbox} focusRef={firstWaiting}/></Popover>}
    {nav("harnesses", "Harness", <Bot size={16}/>, props.activeJobs ? <Spinner size={13} tone="run" label={`${props.activeJobs} 个安装任务进行中`}/>
      : props.updates ? <Badge tone="accent" className="h-[18px]">{props.updates} 个更新</Badge> : null)}
    {nav("capabilities", "能力", <Blocks size={16}/>)}
    {props.providerManagement ? nav("providers", "模型连接", <SlidersHorizontal size={16}/>) : null}
    <div className="session-section mt-3.5 flex min-h-0 flex-1 flex-col gap-0.5">
      <div className="flex h-[30px] flex-none items-center pr-0.5 pl-2.5">
        <h2 className="m-0 flex-1 text-ui-sm font-normal text-fg-3">对话</h2>
        {props.actions ? <Menu align="end" trigger={<button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:bg-selected" aria-label="对话怎么分组" title="分组方式"><ListFilter size={14} aria-hidden="true"/></button>} items={[
          { label: "按项目分组", checked: grouping === "project", onSelect: () => props.actions!.onGrouping("project") },
          { label: "按状态分组", checked: grouping === "state", onSelect: () => props.actions!.onGrouping("state") },
        ]}/> : null}
      </div>
      {/* `relative`: the labels for assistive technology in the rows are placed out of the flow, and are held (and clipped) by the list they scroll in. Placed by the
          page itself they made the whole page scrollable once a row stood below the window. */}
      <PickContext.Provider value={picking}>
      <nav className="relative -mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 pb-2" aria-label="对话列表">
        {pinned.length > 0 ? <PinDragContext.Provider value={pinned.length > 1 ? dragPin : null}><Plain title="置顶" icon={<Pin size={11} strokeWidth={2.2} aria-hidden="true"/>} rows={pinned} {...rowProps} where={folder}/></PinDragContext.Provider> : null}
        {sessions.length === 0 ? null : grouping === "project"
          ? groups.map((project, index) => <ProjectGroup key={project.key} project={project} open={isOpen(project, index)} onToggle={open => choose(project.key, open)}
            now={now} currentId={page === "chat" ? currentId : null} disabled={interactionBusy} arrivals={arriving} harness={name} onSession={props.onSession} unread={session => unseen(looked, session)} actions={props.actions}/>)
          : <>
            {/* By how they stand (after the sidebar of T3 Code): what needs you leads, then what is at work, then the rest by how lately they moved. */}
            {byState.need.length > 0 ? <Plain title="要你看的" rows={byState.need} {...rowProps} where={folder}/> : null}
            {byState.work.length > 0 ? <Plain title="进行中" rows={byState.work} {...rowProps} where={folder}/> : null}
            {byState.rest.length > 0 ? <Plain title="最近" rows={byState.rest} {...rowProps} where={folder}/> : null}
          </>}
        {props.more ? <MoreSessions onMore={props.onMore}/> : null}
        {later.length > 0 ? <Shelf title="稍后提醒" icon={<AlarmClock size={12} aria-hidden="true"/>} rows={later} now={now} currentId={page === "chat" ? currentId : null} disabled={interactionBusy} harness={name} onSession={props.onSession} actions={props.actions} away="later"/> : null}
        {props.actions?.trash ? <Trash access={props.actions.trash} now={now} harness={name}/> : null}
        {shelf.length > 0 ? <Shelf title="已归档" icon={<Archive size={12} aria-hidden="true"/>} rows={shelf} now={now} currentId={page === "chat" ? currentId : null} disabled={interactionBusy} harness={name} onSession={props.onSession} actions={props.actions} away="archived"/> : null}
      </nav>
      </PickContext.Provider>
      {many !== undefined && picked.size > 0 ? <div className="pick-bar motion-enter mx-0.5 mt-1 flex flex-none flex-wrap items-center gap-1 rounded-block bg-surface p-1.5 shadow-pop" role="toolbar" aria-label={"已选 " + picked.size + " 段对话"}>
        <span className="min-w-0 flex-1 pl-1.5 text-ui-sm text-fg-2 tabular-nums">已选 {picked.size} 段</span>
        <Tip label="置顶"><button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label="全部置顶" onClick={() => { many.pin(pickedIds, true); done(); }}><Pin size={14} aria-hidden="true"/></button></Tip>
        <Tip label="标为未读"><button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label="全部标为未读" onClick={() => { many.markUnread(pickedIds); done(); }}><CircleDot size={14} aria-hidden="true"/></button></Tip>
        <Menu align="end" side="top" trigger={<button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label="全部稍后提醒"><AlarmClock size={14} aria-hidden="true"/></button>}
          items={[{ heading: "稍后提醒" }, ...snoozeChoices(Date.now()).map(choice => ({ label: choice.label, icon: <AlarmClock size={14}/>, onSelect: () => { many.snooze(pickedIds, choice.until); done(); } }))]}/>
        <Tip label="归档"><button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label="全部归档" onClick={() => { many.archive(pickedIds); done(); }}><Archive size={14} aria-hidden="true"/></button></Tip>
        <Tip label="删除"><button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:text-red" aria-label="全部删除" onClick={() => { many.remove(pickedIds); done(); }}><Trash2 size={14} aria-hidden="true"/></button></Tip>
        <Tip label="取消选择（Esc）"><button type="button" className="icon-btn icon-btn-sm text-fg-3" aria-label="取消选择" onClick={done}><X size={14} aria-hidden="true"/></button></Tip>
      </div> : null}
    </div>
    <div className="flex-none pt-1">
      <button type="button" className="nav-row w-full disabled:opacity-60" disabled={interactionBusy} aria-current={page === "settings" ? "page" : undefined} aria-label="设置" onClick={() => props.onPage("settings")}>
        {icon(<Settings size={16}/>)}<span className="flex-1">设置</span>
        <span className="service-status flex items-center gap-1.5 text-[11px] leading-4 text-fg-3" title={service} aria-hidden="true"><StatusDot tone={props.connected ? "run" : "fail"} live={false} size={6}/></span></button>
      <span className="sr-only" role="status">{props.connected ? "" : "与本机服务的连接中断"}</span>
    </div>
  </aside>;
}

/** The end of a list that goes on: it reads the next page of conversations as it comes into view, and says so with a button for a reader who cannot scroll to it. */
function MoreSessions({ onMore }: { readonly onMore: (() => void) | undefined }) {
  const end = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = end.current;
    if (!element || onMore === undefined || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) onMore(); }, { rootMargin: "200px" });
    watch.observe(element);
    return () => watch.disconnect();
  }, [onMore]);
  return <button ref={end} type="button" className="more-sessions btn btn-ghost btn-sm mx-1 my-1 flex-none" onClick={onMore}>更多对话</button>;
}

function ProjectGroup({ project, open, onToggle, now, currentId, disabled, arrivals, harness, onSession, unread, actions }: {
  readonly project: Project; readonly open: boolean; readonly onToggle: (open: boolean) => void; readonly now: number; readonly currentId: string | null; readonly disabled: boolean;
  readonly arrivals: ReadonlySet<string>; readonly harness: (id: string) => string; readonly onSession: (id: string) => void; readonly unread: (session: SessionSummary) => boolean;
  readonly actions: SessionActions | undefined;
}) {
  const listId = useId(), summaryId = listId + "-summary";
  // A closed project still shows the most pressing state inside it, so nothing waiting for you hides in it.
  const strongest = project.rows.find(row => row.state === "wait") ?? project.rows.find(row => row.state === "run") ?? project.rows.find(row => row.state === "fail");
  return <div className="session-group flex flex-col gap-px">
    <button type="button" className="group-heading" aria-expanded={open} aria-controls={listId} title={project.scratch ? undefined : project.key}
      aria-label={project.name + (project.detail ? " · " + project.detail : "")} aria-describedby={summaryId} onClick={() => onToggle(!open)}>
      <ChevronRight size={11} strokeWidth={2.4} aria-hidden="true" className={cn("flex-none motion-rotate", open && "rotate-90")}/>
      <span className="min-w-0 flex-1 trunc">{project.name}{project.detail ? <span className="opacity-70"> · {project.detail}</span> : null}</span>
      {!open && strongest ? <StatusDot tone={strongest.state === "wait" ? "wait" : strongest.state === "run" ? "run" : "fail"} live={false} size={6}/> : null}
      {!open ? <span className="tabular-nums" aria-hidden="true">{project.rows.length}</span> : null}
      <span id={summaryId} className="sr-only">{project.rows.length} 个对话{strongest ? "，有" + STATE_WORDS[strongest.state] + "的" : ""}</span>
    </button>
    <Collapsible open={open} id={listId}>
      <div className="flex flex-col gap-0.5">{project.rows.map(row => <div key={row.session.id} className={cn(arrivals.has(row.session.id) && "motion-list-insert")}><div>
        <SessionRow row={row} now={now} harness={harness(row.session.selection.harnessId)} current={currentId === row.session.id} disabled={disabled} onOpen={() => onSession(row.session.id)}
          unread={currentId !== row.session.id && row.state === "idle" && unread(row.session)} actions={actions}/>
      </div></div>)}</div>
    </Collapsible>
  </div>;
}

/**
 * The conversations the user put away, at the end of the list behind one row (after the Settled shelf of T3 Code): closed until opened, and open while the conversation
 * shown is one of them, so the selected row is in sight.
 */
function Shelf({ title, icon, rows, now, currentId, disabled, harness, onSession, actions, away }: { readonly title: string; readonly icon: ReactNode; readonly rows: readonly Row[]; readonly now: number; readonly currentId: string | null; readonly disabled: boolean;
  readonly harness: (id: string) => string; readonly onSession: (id: string) => void; readonly actions: SessionActions | undefined; readonly away: "archived" | "later" }) {
  const listId = useId(), [choice, setChoice] = useState<boolean | null>(null), open = choice ?? rows.some(row => row.session.id === currentId);
  const shelf = useRef<HTMLDivElement>(null);
  // It stands at the list's end: opened, what it holds is brought into sight once it has its height.
  const toggle = () => { setChoice(!open); if (!open) setTimeout(() => shelf.current?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }), 220); };
  return <div ref={shelf} className="session-shelf mt-1.5 flex flex-col gap-0.5">
    <button type="button" className="group-heading" aria-expanded={open} aria-controls={listId} onClick={toggle}>
      <ChevronRight size={11} strokeWidth={2.4} aria-hidden="true" className={cn("flex-none motion-rotate", open && "rotate-90")}/>{icon}<span className="min-w-0 flex-1 trunc">{title}</span>
      <span className="tabular-nums" aria-hidden="true">{rows.length}</span><span className="sr-only">{rows.length} 个对话</span>
    </button>
    <Collapsible open={open} id={listId}>
      <div className="flex flex-col gap-0.5">{rows.map(row => <SessionRow key={row.session.id} row={row} now={now} harness={harness(row.session.selection.harnessId)} current={currentId === row.session.id} disabled={disabled}
        onOpen={() => onSession(row.session.id)} unread={false} actions={actions} away={away}/>)}</div>
    </Collapsible>
  </div>;
}

/**
 * 最近删除 (2026-11-14, after macOS's Recently Deleted; T3 Code takes a deletion back for five seconds only): the conversations deleted and not yet gone for good,
 * newest first, read when the shelf is opened. Each comes back to the list, or is deleted for good after the user says so; so can all of them at once. Nothing
 * here empties itself with time. The shelf is not shown while nothing is in it.
 */
function Trash({ access, now, harness }: { readonly access: TrashAccess; readonly now: number; readonly harness: (id: string) => string }) {
  const listId = useId(), [open, setOpen] = useState(false), [rows, setRows] = useState<readonly (SessionSummary & { readonly deletedAt: number })[]>([]), [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [asking, setAsking] = useState<{ readonly id: string | null; readonly title: string } | null>(null);
  // Before erasing one with a worktree of its own, where that worktree stands; the choice to remove it starts off.
  const [held, setHeld] = useState<{ readonly branch: string | null; readonly dirty: number; readonly shared: boolean } | null>(null), [withWorktree, setWithWorktree] = useState(false);
  useEffect(() => {
    setHeld(null); setWithWorktree(false);
    const id = asking?.id, row = rows.find(item => item.id === id);
    if (id === undefined || id === null || row?.worktree === undefined || reader.current.worktree === undefined) return;
    const controller = new AbortController();
    reader.current.worktree(id, controller.signal).then(view => { if (!controller.signal.aborted) setHeld(view); }, () => undefined);
    return () => controller.abort();
  }, [asking?.id]);
  const reader = useRef(access); reader.current = access;
  // Read at once for the count, again when something was deleted or brought back, and the next page when asked.
  useEffect(() => {
    const controller = new AbortController();
    reader.current.load(undefined, controller.signal).then(page => { if (!controller.signal.aborted) { setRows(page.sessions); setNext(page.next); } }, () => undefined);
    return () => controller.abort();
  }, [access.stamp]);
  const more = () => { if (next === null) return; reader.current.load(next, new AbortController().signal).then(page => { setRows(current => [...current, ...page.sessions.filter(row => !current.some(known => known.id === row.id))]); setNext(page.next); }, () => undefined); };
  const act = (id: string, run: () => Promise<void>) => { setBusy(id); run().then(() => setRows(current => current.filter(row => row.id !== id)), () => undefined).finally(() => setBusy(null)); };
  if (rows.length === 0 && next === null) return null;
  const count = rows.length + (next !== null ? "+" : "");
  return <div className="session-shelf trash-shelf mt-1.5 flex flex-col gap-0.5">
    <div className="group/trash relative flex items-center">
      <button type="button" className="group-heading" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <ChevronRight size={11} strokeWidth={2.4} aria-hidden="true" className={cn("flex-none motion-rotate", open && "rotate-90")}/><Trash2 size={12} aria-hidden="true"/>
        <span className="min-w-0 flex-1 trunc">最近删除</span><span className="tabular-nums transition-opacity duration-120 ease-standard group-hover/trash:opacity-0" aria-hidden="true">{count}</span>
      </button>
      <button type="button" className="link-btn absolute right-2 text-caption opacity-0 transition-opacity duration-120 ease-standard group-hover/trash:opacity-100 focus-visible:opacity-100" onClick={() => setAsking({ id: null, title: "" })}>清空</button>
    </div>
    <Collapsible open={open} id={listId}>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="最近删除的对话">{rows.map(row => <li key={row.id} className="group/deleted relative flex min-w-0 items-start gap-2 rounded-row py-[5px] pr-2.5 pl-2 hover:bg-sidebar-hover">
        <span className="flex h-5 w-4 flex-none items-center justify-center"/>
        <span className="flex min-w-0 flex-1 flex-col">
          {/* As a conversation's row: the title, and beside it when it was deleted — the place the actions stand in on hover, never over the title. */}
          <span className="flex min-w-0 items-center gap-1.5"><span className="min-w-0 flex-1 trunc text-ui text-fg-2">{row.title || "新对话"}</span>
            <span className="flex h-5 min-w-[46px] flex-none items-center justify-end text-caption text-fg-3 tabular-nums transition-opacity duration-120 ease-standard group-hover/deleted:opacity-0 group-has-[:focus-visible]/deleted:opacity-0"
              title={"删除于 " + new Date(row.deletedAt).toLocaleString()} aria-hidden="true">{agoShort(row.deletedAt, now)}</span></span>
          <span className="flex min-w-0 items-center gap-1 text-caption text-fg-3"><BrandIcon brand={row.selection.harnessId} name={harness(row.selection.harnessId)} size={13} className="flex-none opacity-90"/>
            <span className="min-w-0 trunc">{harness(row.selection.harnessId)}</span></span>
        </span>
        <span className="absolute top-[3px] right-2 flex items-center gap-0.5 opacity-0 transition-opacity duration-120 ease-standard group-hover/deleted:opacity-100 group-has-[:focus-visible]/deleted:opacity-100">
          <Tip label="恢复"><button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:bg-selected" disabled={busy !== null} aria-label={"恢复：" + (row.title || "新对话")} onClick={() => act(row.id, () => access.restore(row.id))}><ArchiveRestore size={14} aria-hidden="true"/></button></Tip>
          <Tip label="彻底删除"><button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:bg-selected" disabled={busy !== null} aria-label={"彻底删除：" + (row.title || "新对话")} onClick={() => setAsking({ id: row.id, title: row.title || "新对话" })}><Trash2 size={14} aria-hidden="true"/></button></Tip>
        </span>
      </li>)}</ul>
      {next !== null ? <button type="button" className="btn btn-ghost btn-sm mx-1 my-1" onClick={more}>更多</button> : null}
    </Collapsible>
    <Dialog open={asking !== null} onOpenChange={value => { if (!value) setAsking(null); }} title={asking?.id === null ? "清空最近删除？" : "彻底删除这段对话？"}
      description={asking?.id === null ? count + " 段对话删除后找不回来。" : "“" + (asking?.title ?? "") + "”删除后找不回来。"}>
      {asking !== null && (asking.id === null ? rows.some(row => row.worktree !== undefined) : held !== null) ? <label className="mx-5 flex cursor-pointer items-start gap-2 rounded-row bg-inset px-3 py-2 text-ui-sm text-fg-2">
        <input type="checkbox" className="mt-0.5 size-3.5 flex-none accent-[var(--accent)]" checked={withWorktree} onChange={event => setWithWorktree(event.target.checked)}/>
        <span className="flex flex-col gap-0.5"><span>{asking.id === null ? "同时删除这些对话自己的工作树" : "同时删除它的工作树" + (held?.branch ? "（分支 " + held.branch + " 保留）" : "（分支保留）")}</span>
          {asking.id !== null && held !== null && held.shared ? <span className="text-caption text-fg-3">别的对话还在用，会留下</span>
            : asking.id !== null && held !== null && held.dirty > 0 && withWorktree ? <span className="text-caption text-red">{held.dirty} 个未提交的文件会一起删掉</span> : null}</span></label> : null}
      <div className="flex justify-end gap-2 px-5 pt-2 pb-5"><button type="button" className="btn" autoFocus onClick={() => setAsking(null)}>取消</button>
        <button type="button" className="btn btn-danger" onClick={() => {
          const target = asking, worktreeToo = withWorktree; setAsking(null);
          if (target === null) return;
          if (target.id === null) { setBusy("*"); access.purgeAll(worktreeToo).then(() => { setRows([]); setNext(null); }, () => undefined).finally(() => setBusy(null)); }
          else act(target.id, () => access.purge(target.id!, worktreeToo));
        }}>{asking?.id === null ? "全部彻底删除" : "彻底删除"}</button></div>
    </Dialog>
  </div>;
}

/**
 * A run of conversations under a quiet title, always open: the pinned ones, and — when the list is grouped by state — what needs you, what is at work and the rest.
 * `where` names the folder each works in, which the grouping by project says with its headings.
 */
function Plain({ title, icon, rows, now, currentId, disabled, harness, onSession, unread, actions, arrivals, where }: { readonly title: string; readonly icon?: ReactNode; readonly rows: readonly Row[]; readonly now: number; readonly currentId: string | null;
  readonly disabled: boolean; readonly harness: (id: string) => string; readonly onSession: (id: string) => void; readonly unread: (session: SessionSummary) => boolean; readonly actions: SessionActions | undefined;
  readonly arrivals: ReadonlySet<string>; readonly where: (session: SessionSummary) => string }) {
  return <section className="session-run flex flex-col gap-0.5 pb-1.5" aria-label={title}>
    <h3 className="group-heading m-0 font-normal">{icon}{title}</h3>
    {rows.map(row => <div key={row.session.id} className={cn(arrivals.has(row.session.id) && "motion-list-insert")}><div>
      <SessionRow row={row} now={now} harness={harness(row.session.selection.harnessId)} current={currentId === row.session.id} disabled={disabled} onOpen={() => onSession(row.session.id)}
        unread={currentId !== row.session.id && row.state === "idle" && unread(row.session)} actions={actions} where={where(row.session)}/></div></div>)}
  </section>;
}

/** One conversation in one line: its Harness's mark with the state as a dot on it, the title, and the time — or what waits for you — that the actions replace on hover. */
function SessionRow({ row, now, harness, current, disabled, onOpen, unread, actions, away, where }: { readonly row: Row; readonly now: number; readonly harness: string; readonly current: boolean; readonly disabled: boolean; readonly onOpen: () => void; readonly unread: boolean;
  readonly actions?: SessionActions | undefined; readonly away?: "archived" | "later" | undefined; readonly where?: string | undefined }) {
  const { session, items, state } = row;
  const urgent = mostUrgent(items), left = urgent === null ? null : remaining(urgent, now);
  const id = useId(), metaId = id + "-meta", title = session.title || "新对话";
  const [editing, setEditing] = useState<string | null>(null), [menu, setMenu] = useState(false), [custom, setCustom] = useState(false);
  const picking = useContext(PickContext), picked = picking?.picked.has(session.id) === true;
  const pinDrag = useContext(PinDragContext), [landing, setLanding] = useState<"before" | "after" | null>(null);
  const dragging = pinDrag !== null && session.pinned === true && editing === null ? {
    draggable: true,
    onDragStart: (event: DragEvent) => { event.dataTransfer.setData("text/x-hh-pinned", session.id); event.dataTransfer.effectAllowed = "move"; },
    onDragOver: (event: DragEvent) => { if (!event.dataTransfer.types.includes("text/x-hh-pinned")) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; const box = event.currentTarget.getBoundingClientRect(); setLanding(event.clientY > box.top + box.height / 2 ? "after" : "before"); },
    onDragLeave: () => setLanding(null),
    onDrop: (event: DragEvent) => { const id = event.dataTransfer.getData("text/x-hh-pinned"); const after = landing === "after"; setLanding(null); if (id && id !== session.id) { event.preventDefault(); pinDrag.drop(id, session.id, after); } },
    onDragEnd: () => setLanding(null),
  } : {};
  const dot = state === "wait" || state === "unknown" ? "wait" : state === "run" || row.delegating ? "work" : state === "fail" ? "fail" : unread ? "run" : null;
  const standing = row.delegating ? row.delegating + " 个委派进行中" : session.line ?? STATE_WORDS[state];
  const meta = [where, harness, urgent ? STATE_WORDS[state] + "：" + attentionKind(urgent) : standing, unread ? "未读" : ""].filter(Boolean).join(" · ");
  const wait = urgent?.expiresAt === undefined ? null : secondsLeft(urgent.expiresAt, now);
  const when = state === "run" && session.activeSince !== undefined ? clock(now - session.activeSince) : urgent ? (wait === null ? attentionKind(urgent) : wait < 100 ? wait + " 秒" : Math.ceil(wait / 60) + " 分")
    : away === "later" && session.snoozedUntil !== undefined ? untilShort(session.snoozedUntil, now) : session.updatedAt ? agoShort(session.updatedAt, now) : "";
  const quiet = !current && (away !== undefined || state === "idle" && !unread || state === "closed");
  const look = cn("session-item nav-row relative w-full gap-2 pr-2.5 disabled:opacity-60", row.child ? "pl-[26px]" : "pl-2", urgent && "has-attention", picked && "is-picked bg-selected");
  const inside = <>
    {row.child ? <span className="pointer-events-none absolute top-0 left-[15px] h-[15px] w-2 rounded-bl-[5px] border-b border-l border-line-strong" aria-hidden="true"/> : null}
    <span className="relative flex size-4 flex-none items-center justify-center">
      <BrandIcon brand={session.selection.harnessId} name={harness} size={14} className={cn("flex-none transition-[filter,opacity] duration-120 ease-standard", quiet && "opacity-60 grayscale group-hover/session:opacity-100 group-hover/session:grayscale-0")}/>
      {dot ? <span className="absolute -top-[3px] -right-[3px] flex rounded-full bg-sidebar p-px"><StatusDot tone={dot} size={6} live={dot === "work"}/></span> : null}
    </span>
    {editing !== null ? <input className="session-rename -my-px -ml-1 h-[22px] min-w-0 flex-1 rounded-[5px] border-none bg-app px-1 text-ui-sm text-fg shadow-focus outline-none" value={editing} autoFocus aria-label="对话标题" maxLength={200}
        onFocus={event => event.currentTarget.select()} onChange={event => setEditing(event.target.value)}
        onBlur={() => { const next = editing.trim().replace(/\s+/gu, " "); setEditing(null); if (next && next !== session.title) actions?.rename(session.id, next); }}
        onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); } }}/>
      : <span className={cn("session-title min-w-0 flex-1 trunc", quiet && "text-fg-2", unread && "font-medium text-fg")}>{title}</span>}
    {session.worktree && editing === null ? <GitBranch size={11} strokeWidth={2.2} className="flex-none text-fg-3" aria-hidden="true"/> : null}
    {editing === null && (when || actions) ? <span className={cn("session-when flex min-w-[46px] flex-none justify-end text-caption tabular-nums transition-opacity duration-120 ease-standard",
      urgent ? "text-amber-on-tint" : state === "run" ? "text-accent-text" : "text-fg-3",
      actions && (menu ? "opacity-0" : "group-hover/session:opacity-0 group-has-[:focus-visible]/session:opacity-0"))} title={left?.hint} aria-hidden="true">{when}</span> : null}
    <span id={metaId} className="sr-only">{meta}</span>
  </>;
  return <div className="session-row group/session relative" {...dragging} onContextMenu={actions && editing === null ? event => { event.preventDefault(); setMenu(true); } : undefined}>
    {editing !== null ? <div className={cn(look, "bg-sidebar-hover")}>{inside}</div>
      : <button type="button" disabled={disabled} onClick={event => { if (picking?.pick(session.id, event) === true) return; onOpen(); }} aria-current={current ? "page" : undefined} aria-label={title}
        aria-describedby={metaId} title={left?.hint ?? session.line} {...(picking !== null && picking.picked.size > 0 ? { "aria-pressed": picked } : {})} className={look}>{inside}</button>}
    {actions && editing === null ? <span className={cn("session-actions absolute top-1/2 right-2 flex -translate-y-1/2 items-center transition-opacity duration-120 ease-standard", menu ? "opacity-100" : "opacity-0 group-hover/session:opacity-100 group-has-[:focus-visible]/session:opacity-100")}>
      {away === "later" ? <Tip label="现在就看"><button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:bg-selected" disabled={disabled} aria-label={"现在就看：" + title} onClick={() => actions.snooze(session.id, null)}><AlarmClockOff size={14} aria-hidden="true"/></button></Tip>
        : <Tip label={away === "archived" ? "取消归档" : "归档"}><button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:bg-selected" disabled={disabled} aria-label={(away === "archived" ? "取消归档：" : "归档：") + title} onClick={() => actions.archive(session.id, away !== "archived")}>
          {away === "archived" ? <ArchiveRestore size={14} aria-hidden="true"/> : <Archive size={14} aria-hidden="true"/>}</button></Tip>}
      <Menu align="start" open={menu} onOpenChange={setMenu} trigger={<button type="button" className="icon-btn icon-btn-sm text-fg-3 hover:bg-selected" disabled={disabled} aria-label={"更多操作：" + title}><MoreHorizontal size={14} aria-hidden="true"/></button>} items={[
        ...(away === undefined ? [{ label: session.pinned === true ? "取消置顶" : "置顶", icon: session.pinned === true ? <PinOff size={14}/> : <Pin size={14}/>, onSelect: () => actions.pin(session.id, session.pinned !== true) }] : []),
        { label: "重命名", icon: <PencilLine size={14}/>, onSelect: () => setEditing(title) },
        ...(away === undefined && !unread && !current ? [{ label: "标为未读", icon: <CircleDot size={14}/>, onSelect: () => actions.markUnread(session.id) }] : []),
        { label: "在访达中显示", icon: <FolderOpen size={14}/>, onSelect: () => actions.reveal(session.id) },
        ...(actions.copy ? [{ label: "复制文件夹路径", icon: <Copy size={14}/>, onSelect: () => actions.copy?.(session.workspace, "文件夹路径") },
          { label: "复制对话 ID", icon: <Hash size={14}/>, onSelect: () => actions.copy?.(session.id, "对话 ID") }] : []),
        ...(away === "later" ? [{ separator: true as const }, { label: "现在就看", icon: <AlarmClockOff size={14}/>, onSelect: () => actions.snooze(session.id, null) }]
          : away === undefined && state !== "run" && state !== "wait" ? [{ separator: true as const }, { heading: "稍后提醒" }, ...snoozeChoices(Date.now()).map(choice => ({ label: choice.label, icon: <AlarmClock size={14}/>, onSelect: () => actions.snooze(session.id, choice.until) })),
            { label: "自定义时间…", icon: <CalendarClock size={14}/>, onSelect: () => setCustom(true) }] : []),
        { separator: true as const },
        ...(away !== "later" ? [{ label: away === "archived" ? "取消归档" : "归档", icon: away === "archived" ? <ArchiveRestore size={14}/> : <Archive size={14}/>, onSelect: () => actions.archive(session.id, away !== "archived") }] : []),
        { label: "删除", icon: <Trash2 size={14}/>, danger: true, disabled: state === "run" || state === "wait", onSelect: () => actions.remove(session.id) },
      ]}/>
    </span> : null}
    {landing !== null ? <span className={cn("pointer-events-none absolute inset-x-2 z-[1] h-0.5 rounded-full bg-accent", landing === "before" ? "-top-px" : "-bottom-px")} aria-hidden="true"/> : null}
    {actions && custom ? <SnoozeDialog title={title} onClose={() => setCustom(false)} onChoose={until => { setCustom(false); actions.snooze(session.id, until); }}/> : null}
  </div>;
}

/** A moment of the user's own to be reminded of a conversation at (after T3 Code's custom snooze): a day and a time, tomorrow at 9:00 to start with, never one past. */
function SnoozeDialog({ title, onClose, onChoose }: { readonly title: string; readonly onClose: () => void; readonly onChoose: (until: number) => void }) {
  const local = (at: Date): string => { const pad = (value: number) => String(value).padStart(2, "0"); return at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + "T" + pad(at.getHours()) + ":" + pad(at.getMinutes()); };
  const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(9, 0, 0, 0);
  const [value, setValue] = useState(local(start)), at = new Date(value).getTime(), valid = Number.isFinite(at) && at > Date.now();
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title="稍后提醒" description={title}>
    <form className="flex flex-col gap-3 px-5 pt-2 pb-5" onSubmit={event => { event.preventDefault(); if (valid) onChoose(at); }}>
      <input type="datetime-local" className="h-9 rounded-control border border-line bg-surface px-2.5 text-ui-sm text-fg" value={value} min={local(new Date())} aria-label="提醒时间" autoFocus onChange={event => setValue(event.target.value)}/>
      {!valid ? <p className="m-0 text-caption text-red">要选一个以后的时间</p> : null}
      <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary" disabled={!valid}>稍后提醒</button></div>
    </form>
  </Dialog>;
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
        if (!entry.controller.signal.aborted) setRead(map => new Map(map).set(id, { requests: view.head.permissions ?? [], loading: false }));
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
    })}</ul> : <p className="m-0 px-3.5 py-6 text-center text-ui-sm text-fg-3">没有等你处理的事</p>}
  </>;
}
