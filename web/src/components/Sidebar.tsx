import { Bell, BellOff, Blocks, Bot, Check, ChevronDown, CircleHelp, PanelLeft, Plus, Search, Settings, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AttentionItem } from "../../../src/contracts/session.js";
import type { HarnessView, SessionSummary } from "../../../src/contracts/web.js";
import { attentionKind, chooseNotifications, liveItems, mostUrgent, notificationsChosen, notificationsSupported, remaining } from "../attention.js";
import { cn } from "../lib/cn.js";
import { folderName } from "../lib/format.js";
import type { Preferences } from "../lib/prefs.js";
import { Menu, Popover } from "../ui/overlay.js";
import { Badge, Kbd, LogoMark, Tip } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";

export type Page = "chat" | "providers" | "harnesses" | "capabilities" | "settings";

/**
 * The user's switch for browser notifications of waiting approvals and questions (ADR-035). The browser is asked only
 * when the user turns it on here; a browser without notifications, or one that refuses them, leaves it off and silent.
 */
export function NotifyToggle({ withLabel = false }: { readonly withLabel?: boolean }) {
  const supported = notificationsSupported();
  const [on, setOn] = useState(() => supported && notificationsChosen() && Notification.permission === "granted");
  const [blocked, setBlocked] = useState(() => supported && Notification.permission === "denied");
  const toggle = async () => {
    if (!supported) return;
    if (on) { chooseNotifications(false); setOn(false); return; }
    let permission = Notification.permission;
    if (permission === "default") { try { permission = await Notification.requestPermission(); } catch { permission = "denied"; } }
    chooseNotifications(permission === "granted"); setOn(permission === "granted"); setBlocked(permission === "denied");
  };
  const title = !supported ? "此浏览器不支持通知" : blocked ? "浏览器已阻止本页的通知，可在浏览器的网站设置中允许" : on ? "已开启：页面在后台时，有审批或提问会通知你（只写 Harness 名称和剩余时间）" : "页面在后台时，有审批或提问时通知我";
  return <button type="button" className={cn(withLabel ? "btn btn-sm" : "icon-btn icon-btn-sm", "notify-toggle", on && "text-accent-text")} aria-pressed={on} aria-label="待处理时通知我" title={title} disabled={!supported} onClick={() => void toggle()}>
    {on ? <Bell size={14} aria-hidden="true"/> : <BellOff size={14} aria-hidden="true"/>}{withLabel ? <span>{on ? "已开启通知" : "开启通知"}</span> : null}</button>;
}

interface SidebarProps {
  readonly providerManagement: boolean; readonly page: Page; readonly sessions: readonly SessionSummary[]; readonly attention: readonly AttentionItem[];
  readonly harnesses: readonly HarnessView[]; readonly currentId: string | null; readonly interactionBusy: boolean; readonly activeJobs: number; readonly updates: number;
  readonly groupBy: Preferences["groupBy"]; readonly onGroupBy: (value: Preferences["groupBy"]) => void;
  readonly connected: boolean; readonly onCollapse: () => void; readonly onClose?: () => void; readonly onPage: (page: Page) => void; readonly onNew: () => void; readonly onSession: (id: string) => void; readonly onPalette: () => void;
}
interface Row { readonly session: SessionSummary; readonly items: readonly AttentionItem[] }
const GROUP_LABEL: Readonly<Record<Preferences["groupBy"], string>> = { status: "按状态", harness: "按 Harness", workspace: "按工作区" };

/** Primary navigation: new conversation, search, conversations grouped by what they need, and the other areas. */
export function Sidebar(props: SidebarProps) {
  const { sessions, attention, currentId, page, interactionBusy } = props;
  // Remaining time is counted here, once a second, only while some waiting item has a deadline.
  const [now, setNow] = useState(() => Date.now());
  const counting = attention.some(item => item.expiresAt !== undefined);
  useEffect(() => { setNow(Date.now()); if (!counting) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [counting, attention]);
  const waiting = liveItems(attention, now);
  const bySession = useMemo(() => { const map = new Map<string, AttentionItem[]>(); for (const item of waiting) map.set(item.sessionId, [...(map.get(item.sessionId) ?? []), item]); return map; }, [waiting]);
  const name = (id: string) => props.harnesses.find(harness => harness.id === id)?.name ?? id;
  const groups = useMemo((): readonly { readonly key: string; readonly label: string; readonly tone?: "amber"; readonly rows: readonly Row[] }[] => {
    const rows = sessions.map(session => ({ session, items: bySession.get(session.id) ?? [] }));
    if (props.groupBy === "status") {
      const pick = (test: (row: Row) => boolean) => rows.filter(test);
      const attentionRows = pick(row => row.items.length > 0), running = pick(row => !row.items.length && row.session.activeRunId !== null);
      const blocked = pick(row => !row.items.length && row.session.activeRunId === null && row.session.status === "blocked");
      const open = pick(row => !row.items.length && row.session.activeRunId === null && row.session.status === "open"), closed = pick(row => !row.items.length && row.session.activeRunId === null && row.session.status === "closed");
      return [{ key: "attention", label: "等你处理", tone: "amber" as const, rows: attentionRows }, { key: "running", label: "进行中", rows: running }, { key: "blocked", label: "需要核实", rows: blocked },
        { key: "open", label: "最近", rows: open }, { key: "closed", label: "已结束", rows: closed }].filter(group => group.rows.length > 0);
    }
    const map = new Map<string, Row[]>();
    for (const row of rows) { const key = props.groupBy === "harness" ? row.session.selection.harnessId : row.session.workspace; map.set(key, [...(map.get(key) ?? []), row]); }
    return [...map.entries()].map(([key, list]) => ({ key, label: props.groupBy === "harness" ? name(key) : folderName(key), rows: list }));
  }, [sessions, bySession, props.groupBy, props.harnesses]);
  const nav = (target: Page, label: string, icon: ReactNode, extra?: ReactNode) => <button type="button" disabled={interactionBusy} aria-current={page === target ? "page" : undefined} onClick={() => props.onPage(target)}
    className={cn("flex h-[34px] w-full items-center gap-2.5 rounded-lg border-none px-2 text-left text-[13.5px] hover:bg-hover disabled:opacity-60", page === target ? "bg-active font-medium text-fg" : "bg-transparent text-fg")}>
    <span className="flex w-4 justify-center text-fg-2" aria-hidden="true">{icon}</span><span className="flex-1">{label}</span>{extra}</button>;
  return <aside className="sidebar flex h-full w-full flex-col bg-sidebar" aria-label="主导航">
    <div className="flex items-center gap-2.5 px-3.5 pt-3.5 pb-2.5">
      <LogoMark/>
      <div className="flex-1 text-[15px] font-semibold tracking-[-0.01em]">HarnessHub</div>
      <Inbox attention={waiting} sessions={sessions} harnesses={props.harnesses} now={now} onOpen={props.onSession}/>
      {props.onClose ? <button type="button" className="icon-btn" aria-label="关闭导航" onClick={props.onClose}><X size={17}/></button>
        : <Tip label="收起侧栏"><button type="button" className="icon-btn" aria-label="收起侧栏" onClick={props.onCollapse}><PanelLeft size={16}/></button></Tip>}
    </div>
    <div className="flex flex-col gap-1 px-2.5 pb-2.5">
      <button type="button" className="new-chat-button flex h-9 items-center gap-2.5 rounded-lg border border-line-strong bg-surface px-2.5 text-[13.5px] font-medium shadow-sm hover:bg-hover disabled:opacity-60" onClick={props.onNew} disabled={interactionBusy} aria-label="新对话">
        <Plus size={16} aria-hidden="true"/><span className="flex-1 text-left">新对话</span><Kbd>⇧⌘O</Kbd></button>
      <button type="button" className="flex h-[34px] items-center gap-2.5 rounded-lg border-none bg-transparent px-2.5 text-[13.5px] text-fg-2 hover:bg-hover" onClick={props.onPalette} aria-label="搜索与命令">
        <Search size={16} aria-hidden="true"/><span className="flex-1 text-left">搜索与命令</span><Kbd>⌘K</Kbd></button>
    </div>
    <div className="session-section flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-1.5 pb-1">
        <span className="text-[12px] text-fg-3">对话</span>
        <Menu align="end" items={(Object.keys(GROUP_LABEL) as Preferences["groupBy"][]).map(key => ({ label: GROUP_LABEL[key], ...(props.groupBy === key ? { icon: <Check size={14}/> } : { icon: <span/> }), onSelect: () => props.onGroupBy(key) }))}
          trigger={<button type="button" className="flex h-6 items-center gap-1 rounded-md border-none bg-transparent px-1.5 text-[12px] text-fg-2 hover:bg-hover" aria-label={"对话分组：" + GROUP_LABEL[props.groupBy]}>{GROUP_LABEL[props.groupBy]}<ChevronDown size={12} aria-hidden="true"/></button>}/>
      </div>
      <nav className="scroll-area min-h-0 flex-1 px-2 pb-3" aria-label="对话列表">
        {sessions.length === 0 ? <p className="m-0 px-2.5 py-3 text-[12.5px] text-fg-3">你的对话会保存在这里。</p> : groups.map(group => <div key={group.key} className="session-group">
          <div className={cn("flex items-center gap-1.5 px-2 pt-3 pb-1 text-[12px] font-medium", group.tone === "amber" ? "text-amber" : "text-fg-2")}>
            <span className="trunc">{group.label}</span><span className="font-normal text-fg-3">{group.rows.length}</span></div>
          {group.rows.map(({ session, items }) => <SessionItem key={session.id} session={session} items={items} now={now} harness={name(session.selection.harnessId)} current={currentId === session.id && page === "chat"} disabled={interactionBusy} onOpen={() => props.onSession(session.id)}/>)}
        </div>)}
      </nav>
    </div>
    <div className="flex flex-col gap-0.5 border-t border-line px-2 pt-2 pb-2.5">
      {nav("harnesses", "我的 Agent", <Bot size={16}/>, props.activeJobs ? <Badge tone="accent">{props.activeJobs} 个任务</Badge> : props.updates ? <Badge tone="amber">{props.updates} 个可升级</Badge> : null)}
      {nav("capabilities", "能力", <Blocks size={16}/>)}
      {props.providerManagement ? nav("providers", "模型与账号", <SlidersHorizontal size={16}/>) : null}
      {nav("settings", "设置", <Settings size={16}/>)}
      <div className="flex items-center gap-2 px-2 pt-1.5 text-[12px] text-fg-3" role="status">
        <span className={cn("h-1.5 w-1.5 rounded-full", props.connected ? "bg-green-dot" : "bg-amber-dot")} aria-hidden="true"/>{props.connected ? "本机服务已连接 · 数据保存在本机" : "正在重新连接本机服务"}</div>
    </div>
  </aside>;
}

function SessionItem({ session, items, now, harness, current, disabled, onOpen }: { readonly session: SessionSummary; readonly items: readonly AttentionItem[]; readonly now: number; readonly harness: string; readonly current: boolean; readonly disabled: boolean; readonly onOpen: () => void }) {
  // A conversation waiting for the user says what for and how long it can wait; deciding happens in the conversation.
  const urgent = mostUrgent(items), left = urgent === null ? null : remaining(urgent, now);
  const indicator = urgent ? <span className="h-2 w-2 rounded-full bg-amber-dot shadow-[0_0_0_3px_var(--amber-soft)]" aria-label="等你处理" role="img"/>
    : session.activeRunId ? <span className="running-dot pulse h-2 w-2 rounded-full bg-accent" aria-label="正在执行" role="img"/>
    : session.status === "blocked" ? <CircleHelp size={14} className="text-amber" aria-label="需要核实"/>
    : session.status === "closed" ? <Check size={13} className="text-fg-3" aria-label="已结束"/> : <span className="h-1.5 w-1.5 rounded-full bg-line-strong" aria-hidden="true"/>;
  const metaId = "session-meta-" + session.id;
  return <button type="button" disabled={disabled} onClick={onOpen} aria-current={current ? "true" : undefined} aria-label={session.title || "新对话"} aria-describedby={metaId}
    className={cn("session-item mb-px flex w-full items-start gap-2 rounded-lg border px-2 py-[7px] text-left disabled:opacity-60", current ? "selected border-line bg-surface shadow-sm" : "border-transparent bg-transparent hover:bg-hover", urgent && "has-attention")}>
    <span className="flex h-[18px] w-4 flex-none items-center justify-center">{indicator}</span>
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className={cn("session-title trunc text-[13.5px]", current ? "font-semibold" : "font-medium")}>{session.title || "新对话"}</span>
      {urgent && left ? <span id={metaId} className="attention-line line-clamp-2 text-[12px] leading-[1.45] text-amber" title={left.hint}>{attentionKind(urgent)}{items.length > 1 ? `（${items.length} 项）` : ""}{left.source ? " · " + left.source : ""} {left.text}</span>
        : <span id={metaId} className="trunc text-[12px] text-fg-3">{harness}{session.activeRunId ? " · 正在执行" : session.status === "blocked" ? " · 需要核实" : session.status === "closed" ? " · 已结束" : ""}</span>}
    </span>
  </button>;
}

/** Waiting approvals and questions of every conversation, one click from each; the notification switch lives here too. */
function Inbox({ attention, sessions, harnesses, now, onOpen }: { readonly attention: readonly AttentionItem[]; readonly sessions: readonly SessionSummary[]; readonly harnesses: readonly HarnessView[]; readonly now: number; readonly onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const sorted = [...attention].sort((a, b) => (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || a.requestedAt - b.requestedAt);
  return <Popover label="等你处理" open={open} onOpenChange={setOpen} align="start" className="inbox-pop w-[340px] max-w-[calc(100vw-24px)]"
    trigger={<button type="button" className={cn("icon-btn relative", attention.length && "text-amber")} aria-label={attention.length ? `等你处理（${attention.length} 项）` : "等你处理"}>
      <Bell size={16} aria-hidden="true"/>{attention.length ? <span className="attention-count absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-dot px-1 text-[10px] font-semibold text-white">{attention.length}</span> : null}</button>}>
    <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5"><h3 className="m-0 flex-1 text-[13px] font-semibold">等你处理</h3><NotifyToggle/></div>
    {sorted.length ? <ul className="m-0 flex list-none flex-col p-1.5">{sorted.map((item, index) => {
      const left = remaining(item, now), session = sessions.find(row => row.id === item.sessionId), harness = harnesses.find(row => row.id === item.harnessId);
      return <li key={item.permissionId}><button ref={index === 0 ? first : undefined} type="button" onClick={() => { setOpen(false); onOpen(item.sessionId); }} className="flex w-full items-start gap-2.5 rounded-lg border-none bg-transparent px-2.5 py-2 text-left hover:bg-hover">
        <BrandIcon brand={item.harnessId} name={harness?.name ?? item.harnessId} size={20}/>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5"><strong className="trunc text-[13px] font-medium">{session?.title || "对话"}</strong>
          <span className="text-[12px] text-amber">{attentionKind(item)}{left.source ? " · " + left.source : ""} {left.text}</span></span>
      </button></li>;
    })}</ul> : <p className="m-0 px-3.5 py-6 text-center text-[12.5px] text-fg-3">没有等你处理的审批或提问。</p>}
    <p className="m-0 border-t border-line px-3.5 py-2 text-[11.5px] text-fg-3">决定在对话里做出；打开对话即可看到审批卡片。</p>
  </Popover>;
}
