import { ChevronsLeft, ChevronsRight, CircleHelp, HardDrive, Layers3, Menu, MessageSquare, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../../src/contracts/web.js";
import { BrandMark, StatusBadge } from "./common.js";

export type Page = "chat" | "providers" | "harnesses";
export function Sidebar({ providerManagement = true, page, sessions, currentId, open, collapsed, interactionBusy, activeJobs, onToggle, onCollapse, onPage, onNew, onSession }: {
  providerManagement?: boolean; page: Page; sessions: readonly SessionSummary[]; currentId: string | null; open: boolean; collapsed: boolean; interactionBusy: boolean; activeJobs: number; onToggle: () => void; onCollapse: () => void;
  onPage: (page: Page) => void; onNew: () => void; onSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { const query = window.matchMedia("(max-width: 800px)"); const changed = () => setMobile(query.matches); query.addEventListener("change", changed); return () => query.removeEventListener("change", changed); }, []);
  useEffect(() => {
    if (!open || !mobile || !panel.current) return;
    const element = panel.current;
    const original = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...element.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])")].filter(item => item.getClientRects().length > 0);
    (element.querySelector<HTMLButtonElement>(".new-chat-button:not([disabled])") ?? focusable()[0])?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); if (original?.isConnected) original.focus(); };
  }, [open, mobile]);
  const visible = sessions.filter(session => session.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    {open ? <button className="sidebar-scrim" aria-label="关闭导航" onClick={onToggle}/> : null}
    <aside ref={panel} className={`sidebar ${open ? "is-open" : ""}`} aria-label="主导航" role={mobile && open ? "dialog" : undefined} aria-modal={mobile && open ? true : undefined} inert={mobile && !open} aria-hidden={mobile && !open ? true : undefined}>
      <div className="sidebar-brand"><BrandMark small/><span>Harness<span className="brand-light">Hub</span></span><button className="icon-button desktop-collapse" onClick={onCollapse} aria-label={collapsed ? "展开侧栏" : "收起侧栏"}>{collapsed ? <ChevronsRight size={16}/> : <ChevronsLeft size={16}/>}</button><button className="icon-button mobile-close" onClick={onToggle} aria-label="关闭导航"><X size={18}/></button></div>
      <button className="new-chat-button" onClick={onNew} disabled={interactionBusy} aria-label="新对话" title="新对话 · ⌘ N"><Plus size={18} aria-hidden="true"/><span>新对话</span><kbd>⌘ N</kbd></button>
      <div className="nav-section-label">工作空间</div>
      <nav className="primary-nav">
        <button disabled={interactionBusy} title="对话" aria-label="对话" aria-current={page === "chat" ? "page" : undefined} className={page === "chat" ? "active" : ""} onClick={() => onPage("chat")}><MessageSquare size={18} aria-hidden="true"/><span>对话</span></button>
        <button disabled={interactionBusy || !providerManagement} title={providerManagement ? "Providers" : "统一 Provider 管理将在后续接入"} aria-label="Providers" aria-current={page === "providers" ? "page" : undefined} className={page === "providers" ? "active" : ""} onClick={() => onPage("providers")}><SlidersHorizontal size={18} aria-hidden="true"/><span>Providers</span></button>
        <button disabled={interactionBusy} title="Harnesses" aria-label="Harnesses" aria-current={page === "harnesses" ? "page" : undefined} className={page === "harnesses" ? "active" : ""} onClick={() => onPage("harnesses")}><Layers3 size={18} aria-hidden="true"/><span>Harnesses</span>{activeJobs ? <b className="nav-count">{activeJobs}</b> : null}</button>
      </nav>
      <div className="session-section"><div className="section-eyebrow">最近对话<span>{sessions.length}</span></div>
        {sessions.length > 5 ? <label className="session-search"><Search size={13} aria-hidden="true"/><input aria-label="搜索最近对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)}/></label> : null}
        <div className="session-list">
          {visible.length === 0 ? <p className="sidebar-empty">{query ? "没有匹配的对话" : "你的对话会保存在这里。"}</p> : visible.map(session => <button disabled={interactionBusy} key={session.id} className={`session-item ${currentId === session.id && page === "chat" ? "selected" : ""}`} onClick={() => onSession(session.id)} aria-current={currentId === session.id && page === "chat" ? "true" : undefined}><span className="session-title">{session.title || "新对话"}</span>{session.activeRunId ? <span className="running-dot" aria-label="正在执行"/> : session.status === "blocked" ? <CircleHelp size={13} aria-label="需要核实"/> : null}</button>)}
        </div>
      </div>
      <div className="sidebar-footer"><div className="local-avatar"><HardDrive size={18} aria-hidden="true"/></div><div><strong>本机工作空间</strong><span><StatusBadge>数据保存在本机</StatusBadge></span></div></div>
    </aside>
  </>;
}
export function MobileMenu({ onClick }: { onClick: () => void }) { return <button className="icon-button navigation-toggle" onClick={onClick} aria-label="打开导航"><Menu size={20}/></button>; }
