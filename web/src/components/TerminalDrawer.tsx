import { Play, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import { Menu } from "../ui/overlay.js";

/*
 * The conversation's terminals (2026-11-14, after the terminal drawer of T3 Code): the user's own login shell in the conversation's workspace, under the conversation,
 * as many as are opened, each in a tab of its own. The Gateway runs each shell on a pseudoterminal and the page talks to it over a WebSocket of its own; closing a tab
 * hangs its shell up, and so does closing the drawer or opening another conversation. A project's scripts (package.json) run in a tab of their own. The terminal's code
 * is read when the drawer is first opened, so a page that never opens one never loads it.
 */

const HEIGHT_KEY = "harnesshub:terminal-height", MIN = 140;
function readHeight(): number { try { const value = Number(localStorage.getItem(HEIGHT_KEY)); return Number.isFinite(value) && value >= MIN && value <= 2000 ? value : 280; } catch { return 280; } }
function writeHeight(value: number): void { try { localStorage.setItem(HEIGHT_KEY, String(Math.round(value))); } catch { /* lasts for this page only */ } }
/** A color of the page as the terminal takes it: the value of one of the page's own variables, now. */
const color = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
/** The terminal in the page's colors: its ground and its words, the selection, and the cursor in the accent. The sixteen colors of a program's own output stay the terminal's. */
const palette = () => ({ background: color("--bg-app", "#ffffff"), foreground: color("--text", "#1a1a1a"), cursor: color("--accent", "#1f6feb"), cursorAccent: color("--bg-app", "#ffffff"), selectionBackground: color("--bg-selected", "rgba(0,0,0,.12)") });

/** A script of the project, as package.json names it, and the command that runs it with the project's own package manager. */
export interface ProjectScript { readonly name: string; readonly command: string }
interface Tab { readonly id: number; readonly title: string; readonly run?: string }

export function TerminalDrawer({ place, url, onClose, scripts }: {
  /** Where the shells are: the folder's name, for the drawer's head. */
  readonly place: string;
  /** The address of the conversation's terminal for a size in columns and rows. */
  readonly url: (cols: number, rows: number) => string;
  readonly onClose: () => void;
  /** Reads the project's scripts when their menu is opened; absent where the workspace cannot be read. */
  readonly scripts?: ((signal: AbortSignal) => Promise<readonly ProjectScript[]>) | undefined;
}) {
  const [height, setHeight] = useState(readHeight), [dragging, setDragging] = useState(false);
  const counter = useRef(1), [tabs, setTabs] = useState<readonly Tab[]>([{ id: 1, title: "终端 1" }]), [current, setCurrent] = useState(1);
  const [found, setFound] = useState<readonly ProjectScript[] | null>(null);
  const open = (run?: ProjectScript) => { const id = ++counter.current; setTabs(list => [...list, { id, title: run?.name ?? "终端 " + id, ...(run === undefined ? {} : { run: run.command }) }]); setCurrent(id); };
  const close = (id: number) => {
    const rest = tabs.filter(tab => tab.id !== id);
    if (rest.length === 0) { onClose(); return; }
    setTabs(rest);
    if (current === id) setCurrent(rest[Math.max(0, tabs.findIndex(tab => tab.id === id) - 1)]!.id);
  };
  const readScripts = (opened: boolean) => {
    if (!opened || scripts === undefined) return;
    const controller = new AbortController();
    scripts(controller.signal).then(setFound, () => setFound([]));
  };
  const from = useRef<{ readonly y: number; readonly height: number } | null>(null);
  const fitHeight = (value: number): number => Math.round(Math.max(MIN, Math.min(value, window.innerHeight * .7)));
  return <section className={cn("terminal-drawer relative flex flex-none flex-col bg-app hairline-t", dragging && "select-none")} style={{ height: fitHeight(height) }} aria-label="终端">
    <div role="separator" aria-orientation="horizontal" aria-label="调整终端高度" tabIndex={0} title="拖动调整高度" className="group/edge absolute inset-x-0 -top-[3px] z-10 h-[7px] cursor-row-resize touch-none outline-none"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); from.current = { y: event.clientY, height: fitHeight(height) }; setDragging(true); }}
      onPointerMove={event => { const start = from.current; if (start !== null) setHeight(fitHeight(start.height + start.y - event.clientY)); }}
      onPointerUp={event => { if (from.current === null) return; from.current = null; event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); writeHeight(fitHeight(height)); }}
      onPointerCancel={() => { from.current = null; setDragging(false); }}
      onKeyDown={event => { const step = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0; if (step !== 0) { event.preventDefault(); const next = fitHeight(height + step); setHeight(next); writeHeight(next); } }}>
      <span aria-hidden="true" className={cn("absolute inset-x-0 top-[3px] h-0.5 bg-accent opacity-0 transition-opacity duration-120 ease-standard group-hover/edge:opacity-100 group-focus-visible/edge:opacity-100", dragging && "opacity-100")}/>
    </div>
    <header className="flex h-8 flex-none items-center gap-1 pr-1.5 pl-3 text-caption text-fg-3">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="终端">
        {tabs.map(tab => <span key={tab.id} className={cn("group/tab flex h-6 flex-none items-center rounded-row pr-0.5 pl-2 transition-colors duration-120 ease-standard", tab.id === current ? "bg-subtle text-fg" : "hover:bg-subtle")}>
          <button type="button" role="tab" aria-selected={tab.id === current} className="max-w-[160px] truncate border-none bg-transparent p-0 text-caption text-inherit" title={tab.run ?? place} onClick={() => setCurrent(tab.id)}>{tab.title}</button>
          <button type="button" className="icon-btn ml-0.5 size-5 text-fg-3" aria-label={"关闭" + tab.title} title="关闭" onClick={() => close(tab.id)}><X size={11} strokeWidth={2.2}/></button>
        </span>)}
        <button type="button" className="icon-btn size-6 flex-none text-fg-3" aria-label="新开一个终端" title="新开一个终端" onClick={() => open()}><Plus size={13} strokeWidth={2}/></button>
      </div>
      <span className="mono hidden min-w-0 max-w-[40%] truncate px-1 sm:block" title={place}>{place}</span>
      {scripts !== undefined ? <Menu align="end" onOpenChange={readScripts} trigger={<button type="button" className="icon-btn size-6 flex-none text-fg-3" aria-label="运行项目脚本" title="运行项目脚本"><Play size={12} strokeWidth={2.2}/></button>}
        items={found === null ? [{ heading: "正在读取 package.json…" }] : found.length === 0 ? [{ heading: "package.json 里没有脚本" }] : found.map(script => ({ label: script.name, hint: script.command, onSelect: () => open(script) }))}/> : null}
      <button type="button" className="icon-btn size-6 flex-none" aria-label="关闭终端" title="关闭" onClick={onClose}><X size={13} strokeWidth={2}/></button>
    </header>
    <div className="relative min-h-0 flex-1">
      {tabs.map(tab => <TerminalPane key={tab.id} active={tab.id === current} url={url} run={tab.run}/>)}
    </div>
  </section>;
}

/** One terminal: its shell over its own connection, drawn by xterm.js; kept while its tab is not the one shown, so its shell goes on. */
function TerminalPane({ active, url, run }: { readonly active: boolean; readonly url: (cols: number, rows: number) => string; readonly run?: string | undefined }) {
  const host = useRef<HTMLDivElement>(null), focus = useRef<(() => void) | null>(null), refit = useRef<(() => void) | null>(null);
  // How the shell stands: starting, at work, ended (it exited, or the connection went), or not started at all (the terminal's code or the connection failed).
  const [state, setState] = useState<"opening" | "open" | "ended" | "failed">("opening"), [attempt, setAttempt] = useState(0);
  const address = useRef(url);
  address.current = url;
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let closed = false, socket: WebSocket | null = null, dispose = () => { /* nothing made yet */ };
    setState("opening");
    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
        if (closed) return;
        // The page's monospace first; a prompt's icons (powerline, Nerd Font glyphs) come from a Nerd Font when one is installed, glyph by glyph.
        const terminal = new Terminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", "MesloLGS Nerd Font Mono", "Hack Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", monospace', fontSize: 12.5,
          lineHeight: 1.25, cursorBlink: true, allowProposedApi: false, macOptionIsMeta: false, scrollback: 10_000, theme: palette() });
        const fit = new FitAddon();
        terminal.loadAddon(fit); terminal.open(element);
        // Fitted only while it has room: a tab that is not shown has none, and keeps the size it had.
        const fitNow = () => { if (element.clientWidth > 0 && element.clientHeight > 0) { try { fit.fit(); } catch { /* not laid out yet */ } } };
        fitNow(); refit.current = fitNow; focus.current = () => terminal.focus();
        const send = (frame: object) => { if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
        socket = new WebSocket(address.current(terminal.cols, terminal.rows));
        socket.onopen = () => { if (closed) return; setState("open"); terminal.focus(); if (run !== undefined) send({ type: "input", data: run + "\r" }); };
        socket.onmessage = event => {
          if (typeof event.data !== "string") return;
          let frame: { readonly type?: unknown; readonly data?: unknown; readonly code?: unknown };
          try { frame = JSON.parse(event.data) as typeof frame; } catch { return; }
          if (frame.type === "output" && typeof frame.data === "string") terminal.write(frame.data);
          else if (frame.type === "exit") { terminal.write("\r\n\x1b[2m[" + (typeof frame.code === "number" ? "shell 已退出，退出码 " + frame.code : "shell 已结束") + "]\x1b[0m\r\n"); if (!closed) setState("ended"); }
        };
        socket.onclose = () => { if (!closed) setState(current => current === "opening" ? "failed" : "ended"); };
        const typed = terminal.onData(data => send({ type: "input", data }));
        const sized = terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
        const watch = new ResizeObserver(fitNow);
        watch.observe(element);
        // The page's colors change with the theme: the terminal follows.
        const scheme = matchMedia("(prefers-color-scheme: dark)"), recolor = () => { terminal.options.theme = palette(); };
        scheme.addEventListener("change", recolor);
        const themed = new MutationObserver(recolor);
        themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        dispose = () => { watch.disconnect(); themed.disconnect(); scheme.removeEventListener("change", recolor); typed.dispose(); sized.dispose(); terminal.dispose(); refit.current = null; focus.current = null; };
        if (closed) dispose();
      } catch { if (!closed) setState("failed"); }
    })();
    return () => { closed = true; socket?.close(); dispose(); };
  }, [attempt]);
  // The tab shown again takes its size and the keys.
  useEffect(() => { if (!active) return; const frame = requestAnimationFrame(() => { refit.current?.(); focus.current?.(); }); return () => cancelAnimationFrame(frame); }, [active]);
  return <div className={cn("terminal-pane absolute inset-0 flex flex-col", !active && "invisible")} role="tabpanel" aria-hidden={!active || undefined}>
    {state === "ended" || state === "failed" ? <div className="absolute top-1 right-3 z-10 flex items-center gap-1.5 text-caption text-fg-3" role="status">{state === "failed" ? "没有连上" : "已结束"}
      <button type="button" className="icon-btn size-6" aria-label="重新打开终端" title="重新打开" onClick={() => setAttempt(value => value + 1)}><RotateCw size={12} strokeWidth={2}/></button></div> : null}
    <div ref={host} className="terminal-host min-h-0 flex-1 overflow-hidden pr-1 pb-1.5 pl-4"/>
  </div>;
}
