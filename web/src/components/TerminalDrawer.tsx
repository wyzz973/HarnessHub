import { Columns2, Play, Plus, RotateCw, TextQuote, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";
import { Menu } from "../ui/overlay.js";
import { Spinner, Tip } from "../ui/primitives.js";

/*
 * The conversation's terminals (2026-11-14, after the terminal drawer of T3 Code): the user's own login shell in the conversation's workspace, under the conversation.
 * The Gateway keeps each shell running and writes down what it prints, so closing the drawer or opening another conversation only lets go of it: coming back shows
 * what it printed meanwhile. A tab holds one terminal or two side by side; closing a terminal ends its shell. A project's scripts (package.json) run in a terminal of
 * their own. What is selected in a terminal can be put into the message box. The terminal's code is read when the drawer is first opened.
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
/** A terminal the Gateway keeps for the conversation: its name, when it started, and how its shell ended when it has. */
export interface TerminalInfo { readonly id: string; readonly title: string; readonly createdAt: number; readonly exited?: { readonly code: number | null; readonly signal: string | null } | undefined }
/** The conversation's terminals at the Gateway: listed, started, renamed, ended, and the address a page attaches to one by. */
export interface TerminalAccess {
  readonly list: (signal: AbortSignal) => Promise<readonly TerminalInfo[]>;
  readonly open: (cols: number, rows: number, title?: string) => Promise<TerminalInfo>;
  readonly close: (id: string) => Promise<void>;
  readonly socketUrl: (id: string, cols: number, rows: number) => string;
}

/** The tabs of a conversation's drawer, each one terminal or two side by side, remembered in this browser by the terminals' ids. */
type Groups = readonly (readonly string[])[];
const groupsKey = (session: string) => "harnesshub:terminal-tabs:" + session;
function readGroups(session: string): Groups { try { const value: unknown = JSON.parse(localStorage.getItem(groupsKey(session)) ?? "[]"); return Array.isArray(value) ? value.filter((group): group is string[] => Array.isArray(group) && group.every(id => typeof id === "string")) : []; } catch { return []; } }
function writeGroups(session: string, groups: Groups): void { try { if (groups.length === 0) localStorage.removeItem(groupsKey(session)); else localStorage.setItem(groupsKey(session), JSON.stringify(groups)); } catch { /* lasts for this page only */ } }
/** The tabs as remembered, without terminals that are gone, and with each terminal the Gateway has that no tab holds as a tab of its own. */
function reconcile(groups: Groups, terminals: readonly TerminalInfo[]): Groups {
  const known = new Set(terminals.map(terminal => terminal.id)), kept = groups.map(group => group.filter(id => known.has(id))).filter(group => group.length > 0);
  const held = new Set(kept.flat());
  return [...kept, ...terminals.filter(terminal => !held.has(terminal.id)).map(terminal => [terminal.id])];
}

export function TerminalDrawer({ session, place, access, onClose, scripts, onQuote }: {
  /** The conversation the terminals belong to: what the tabs are remembered by. */
  readonly session: string;
  /** Where the shells are: the folder's name, for the drawer's head. */
  readonly place: string;
  readonly access: TerminalAccess;
  readonly onClose: () => void;
  /** Reads the project's scripts when their menu is opened; absent where the workspace cannot be read. */
  readonly scripts?: ((signal: AbortSignal) => Promise<readonly ProjectScript[]>) | undefined;
  /** Puts text from a terminal into the message box, as a block of its own. */
  readonly onQuote?: ((text: string) => void) | undefined;
}) {
  const [height, setHeight] = useState(readHeight), [dragging, setDragging] = useState(false);
  const [terminals, setTerminals] = useState<readonly TerminalInfo[] | null>(null), [groups, setGroups] = useState<Groups>([]), [current, setCurrent] = useState(0);
  const [focused, setFocused] = useState<string | null>(null), [selection, setSelection] = useState(""), [problem, setProblem] = useState<string | null>(null);
  const [found, setFound] = useState<readonly ProjectScript[] | null>(null);
  // A script's command waits here for its terminal's first attachment, which types it.
  const pending = useRef(new Map<string, string>());
  const change = useCallback((next: Groups) => { setGroups(next); writeGroups(session, next); }, [session]);
  const start = useCallback(async (title?: string): Promise<TerminalInfo | null> => {
    try { const made = await access.open(100, 24, title); setTerminals(list => [...(list ?? []), made]); return made; }
    catch (failure: unknown) { setProblem(errorMessage(failure)); return null; }
  }, [access]);
  // The conversation's terminals as the Gateway keeps them; with none, the drawer starts one.
  useEffect(() => {
    const controller = new AbortController();
    access.list(controller.signal).then(async list => {
      if (controller.signal.aborted) return;
      setTerminals(list);
      const next = reconcile(readGroups(session), list);
      if (next.length > 0) { change(next); setCurrent(next.length - 1); return; }
      const made = await start();
      if (made !== null && !controller.signal.aborted) { change([[made.id]]); setCurrent(0); }
    }, (failure: unknown) => { if (!controller.signal.aborted) { setProblem(errorMessage(failure)); setTerminals([]); } });
    return () => controller.abort();
  }, [session]);
  const add = async (script?: ProjectScript) => {
    const made = await start(script?.name);
    if (made === null) return;
    if (script !== undefined) pending.current.set(made.id, script.command);
    const next = [...groups, [made.id]]; change(next); setCurrent(next.length - 1);
  };
  const split = async () => {
    const group = groups[current];
    if (group === undefined || group.length >= 2) return;
    const made = await start();
    if (made === null) return;
    change(groups.map((ids, index) => index === current ? [...ids, made.id] : ids));
  };
  // Ending terminals ends their shells (a tab's, or one of two side by side); a tab left with none goes, and the drawer closes with its last one.
  const end = (ids: readonly string[]) => {
    for (const id of ids) void access.close(id).catch((failure: unknown) => setProblem(errorMessage(failure)));
    setTerminals(list => (list ?? []).filter(terminal => !ids.includes(terminal.id)));
    const next = groups.map(group => group.filter(other => !ids.includes(other))).filter(group => group.length > 0);
    change(next);
    if (next.length === 0) { onClose(); return; }
    setCurrent(index => Math.min(index, next.length - 1));
  };
  const readScripts = (opened: boolean) => {
    if (!opened || scripts === undefined) return;
    const controller = new AbortController();
    scripts(controller.signal).then(setFound, () => setFound([]));
  };
  const from = useRef<{ readonly y: number; readonly height: number } | null>(null);
  const fitHeight = (value: number): number => Math.round(Math.max(MIN, Math.min(value, window.innerHeight * .7)));
  const info = (id: string) => terminals?.find(terminal => terminal.id === id);
  const tabTitle = (group: readonly string[]) => group.map(id => info(id)?.title ?? "终端").join(" · ");
  return <section className={cn("terminal-drawer relative flex flex-none flex-col bg-app hairline-t", dragging && "select-none")} style={{ height: fitHeight(height) }} aria-label="终端">
    <div role="separator" aria-orientation="horizontal" aria-label="调整终端高度" tabIndex={0} title="拖动调整高度" className="group/edge absolute inset-x-0 -top-[3px] z-10 h-[7px] cursor-row-resize touch-none outline-none"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); from.current = { y: event.clientY, height: fitHeight(height) }; setDragging(true); }}
      onPointerMove={event => { const begin = from.current; if (begin !== null) setHeight(fitHeight(begin.height + begin.y - event.clientY)); }}
      onPointerUp={event => { if (from.current === null) return; from.current = null; event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); writeHeight(fitHeight(height)); }}
      onPointerCancel={() => { from.current = null; setDragging(false); }}
      onKeyDown={event => { const step = event.key === "ArrowUp" ? 24 : event.key === "ArrowDown" ? -24 : 0; if (step !== 0) { event.preventDefault(); const next = fitHeight(height + step); setHeight(next); writeHeight(next); } }}>
      <span aria-hidden="true" className={cn("absolute inset-x-0 top-[3px] h-0.5 bg-accent opacity-0 transition-opacity duration-120 ease-standard group-hover/edge:opacity-100 group-focus-visible/edge:opacity-100", dragging && "opacity-100")}/>
    </div>
    <header className="flex h-8 flex-none items-center gap-1 pr-1.5 pl-3 text-caption text-fg-3">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="终端">
        {groups.map((group, index) => <span key={group.join("+")} className={cn("group/tab flex h-6 flex-none items-center rounded-row pr-0.5 pl-2 transition-colors duration-120 ease-standard", index === current ? "bg-subtle text-fg" : "hover:bg-subtle")}>
          <button type="button" role="tab" aria-selected={index === current} className="max-w-[200px] truncate border-none bg-transparent p-0 text-caption text-inherit" title={place} onClick={() => setCurrent(index)}>{tabTitle(group)}</button>
          <button type="button" className="icon-btn ml-0.5 size-5 text-fg-3" aria-label={"关闭" + tabTitle(group)} title="关闭（结束它的 shell）" onClick={() => end(group)}><X size={11} strokeWidth={2.2}/></button>
        </span>)}
        <Tip label="新开一个终端"><button type="button" className="icon-btn size-6 flex-none text-fg-3" aria-label="新开一个终端" onClick={() => void add()}><Plus size={13} strokeWidth={2}/></button></Tip>
      </div>
      <span className="mono hidden min-w-0 max-w-[30%] truncate px-1 sm:block" title={place}>{place}</span>
      {onQuote ? <Tip label="把选中的内容放进输入框"><button type="button" className="icon-btn size-6 flex-none text-fg-3" aria-label="把选中的内容放进输入框" disabled={selection.trim() === ""} onClick={() => { onQuote(selection); setSelection(""); }}><TextQuote size={12} strokeWidth={2.2}/></button></Tip> : null}
      <Tip label="左右分开再开一个"><button type="button" className="icon-btn size-6 flex-none text-fg-3" aria-label="左右分开再开一个终端" disabled={(groups[current]?.length ?? 2) >= 2} onClick={() => void split()}><Columns2 size={12} strokeWidth={2.2}/></button></Tip>
      {scripts !== undefined ? <Menu align="end" onOpenChange={readScripts} trigger={<button type="button" className="icon-btn size-6 flex-none text-fg-3" aria-label="运行项目脚本" title="运行项目脚本"><Play size={12} strokeWidth={2.2}/></button>}
        items={found === null ? [{ heading: "正在读取 package.json…" }] : found.length === 0 ? [{ heading: "package.json 里没有脚本" }] : found.map(script => ({ label: script.name, hint: script.command, onSelect: () => void add(script) }))}/> : null}
      <Tip label="收起终端（shell 继续运行）"><button type="button" className="icon-btn size-6 flex-none" aria-label="收起终端" onClick={onClose}><X size={13} strokeWidth={2}/></button></Tip>
    </header>
    <div className="relative min-h-0 flex-1">
      {terminals === null ? <p className="m-0 flex items-center gap-2 px-4 py-3 text-caption text-fg-3"><Spinner size={12} label=""/>正在打开终端</p> : null}
      {problem ? <p className="absolute top-1 right-3 z-10 m-0 max-w-[60%] truncate text-caption text-red" role="alert" title={problem}>{problem}</p> : null}
      {groups.map((group, index) => <div key={group.join("+")} className={cn("absolute inset-0 flex", index !== current && "invisible")} role="tabpanel" aria-hidden={index !== current || undefined}>
        {group.map((id, at) => <div key={id} className={cn("relative min-w-0 flex-1", at > 0 && "hairline-l")}>
          <TerminalPane id={id} active={index === current} access={access} exited={info(id)?.exited} run={pending.current.get(id)} onRan={() => pending.current.delete(id)}
            onFocus={() => setFocused(id)} onSelection={text => { if (focused === null || focused === id) setSelection(text); }}/>
          {group.length > 1 ? <button type="button" className="icon-btn absolute top-1 right-1.5 z-10 size-5 text-fg-3 opacity-60 hover:opacity-100" aria-label={"结束" + (info(id)?.title ?? "终端")} title="结束这个终端" onClick={() => end([id])}><X size={11} strokeWidth={2.2}/></button> : null}
        </div>)}
      </div>)}
    </div>
  </section>;
}

/**
 * One terminal, drawn by xterm.js over its own connection: the connection first gives what the shell printed so far, then what it prints. Kept while its tab is not
 * the one shown; letting go of it (the drawer closed, another conversation opened) leaves the shell running.
 */
function TerminalPane({ id, active, access, exited, run, onRan, onFocus, onSelection }: {
  readonly id: string; readonly active: boolean; readonly access: TerminalAccess; readonly exited?: TerminalInfo["exited"];
  /** A command typed once the terminal is first attached (a project's script), then forgotten. */
  readonly run?: string | undefined; readonly onRan: () => void;
  readonly onFocus: () => void; readonly onSelection: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null), focus = useRef<(() => void) | null>(null), refit = useRef<(() => void) | null>(null);
  // How the attachment stands: being made, attached, the shell ended, or not attached (the terminal's code or the connection failed).
  const [state, setState] = useState<"opening" | "open" | "ended" | "failed">(exited ? "ended" : "opening"), [attempt, setAttempt] = useState(0);
  const said = useRef({ onRan, onFocus, onSelection, run }); said.current = { onRan, onFocus, onSelection, run };
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
        // What the shell printed before is replayed first; xterm answers some of its sequences by itself, and those answers are not the user's input.
        let replayed = false;
        socket = new WebSocket(access.socketUrl(id, terminal.cols, terminal.rows));
        socket.onopen = () => { if (!closed) setState("open"); };
        socket.onmessage = event => {
          if (typeof event.data !== "string") return;
          let frame: { readonly type?: unknown; readonly data?: unknown; readonly code?: unknown };
          try { frame = JSON.parse(event.data) as typeof frame; } catch { return; }
          if (frame.type === "output" && typeof frame.data === "string") terminal.write(frame.data);
          else if (frame.type === "replayed") {
            // The history is on the screen: from here on the keys are the user's, and a script waiting for its terminal is typed.
            terminal.write("", () => { replayed = true; const command = said.current.run; if (command !== undefined) { send({ type: "input", data: command + "\r" }); said.current.onRan(); } });
            if (active) terminal.focus();
          }
          else if (frame.type === "exit") { terminal.write("\r\n\x1b[2m[" + (typeof frame.code === "number" ? "shell 已退出，退出码 " + frame.code : "shell 已结束") + "]\x1b[0m\r\n"); if (!closed) setState("ended"); replayed = false; }
        };
        socket.onclose = () => { if (!closed) setState(current => current === "opening" ? "failed" : current === "open" ? "failed" : current); };
        const typed = terminal.onData(data => { if (replayed) send({ type: "input", data }); });
        const sized = terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
        const selected = terminal.onSelectionChange(() => said.current.onSelection(terminal.getSelection()));
        const textarea = element.querySelector("textarea"), focused = () => said.current.onFocus();
        textarea?.addEventListener("focus", focused);
        const watch = new ResizeObserver(fitNow);
        watch.observe(element);
        // The page's colors change with the theme: the terminal follows.
        const scheme = matchMedia("(prefers-color-scheme: dark)"), recolor = () => { terminal.options.theme = palette(); };
        scheme.addEventListener("change", recolor);
        const themed = new MutationObserver(recolor);
        themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        dispose = () => { watch.disconnect(); themed.disconnect(); scheme.removeEventListener("change", recolor); textarea?.removeEventListener("focus", focused); typed.dispose(); sized.dispose(); selected.dispose(); terminal.dispose(); refit.current = null; focus.current = null; };
        if (closed) dispose();
      } catch { if (!closed) setState("failed"); }
    })();
    // Letting go: the connection closes and the shell goes on.
    return () => { closed = true; socket?.close(); dispose(); };
  }, [attempt, id]);
  // The tab shown again takes its size and the keys.
  useEffect(() => { if (!active) return; const frame = requestAnimationFrame(() => { refit.current?.(); focus.current?.(); }); return () => cancelAnimationFrame(frame); }, [active]);
  return <div className="terminal-pane absolute inset-0 flex flex-col">
    {state === "failed" ? <div className="absolute top-1 right-8 z-10 flex items-center gap-1.5 text-caption text-fg-3" role="status">没有连上
      <button type="button" className="icon-btn size-6" aria-label="重新连上终端" title="重新连上" onClick={() => setAttempt(value => value + 1)}><RotateCw size={12} strokeWidth={2}/></button></div>
      : state === "ended" ? <div className="absolute top-1 right-8 z-10 text-caption text-fg-3" role="status">shell 已结束</div> : null}
    <div ref={host} className="terminal-host min-h-0 flex-1 overflow-hidden pr-1 pb-1.5 pl-4"/>
  </div>;
}
