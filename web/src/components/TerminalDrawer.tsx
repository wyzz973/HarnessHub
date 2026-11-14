import { RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";

/*
 * The conversation's terminal (2026-11-14, after the terminal drawer of T3 Code): the user's own login shell in the conversation's workspace, under the conversation.
 * The Gateway runs the shell on a pseudoterminal and the page talks to it over a WebSocket of its own; closing the drawer, or opening another conversation, hangs the
 * shell up. The terminal's code is read when the drawer is first opened, so a page that never opens one never loads it.
 */

const HEIGHT_KEY = "harnesshub:terminal-height", MIN = 140;
function readHeight(): number { try { const value = Number(localStorage.getItem(HEIGHT_KEY)); return Number.isFinite(value) && value >= MIN && value <= 2000 ? value : 280; } catch { return 280; } }
function writeHeight(value: number): void { try { localStorage.setItem(HEIGHT_KEY, String(Math.round(value))); } catch { /* lasts for this page only */ } }
/** A color of the page as the terminal takes it: the value of one of the page's own variables, now. */
const color = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
/** The terminal in the page's colors: its ground and its words, the selection, and the cursor in the accent. The sixteen colors of a program's own output stay the terminal's. */
const palette = () => ({ background: color("--bg-app", "#ffffff"), foreground: color("--text", "#1a1a1a"), cursor: color("--accent", "#1f6feb"), cursorAccent: color("--bg-app", "#ffffff"), selectionBackground: color("--bg-selected", "rgba(0,0,0,.12)") });

export function TerminalDrawer({ place, url, onClose }: {
  /** Where the shell is: the folder's name, for the drawer's head. */
  readonly place: string;
  /** The address of the conversation's terminal for a size in columns and rows. */
  readonly url: (cols: number, rows: number) => string;
  readonly onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null), [height, setHeight] = useState(readHeight), [dragging, setDragging] = useState(false);
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
        const terminal = new Terminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", "MesloLGS Nerd Font Mono", "Hack Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", monospace', fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, allowProposedApi: false, macOptionIsMeta: false, scrollback: 10_000, theme: palette() });
        const fit = new FitAddon();
        terminal.loadAddon(fit); terminal.open(element); fit.fit();
        const send = (frame: object) => { if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
        socket = new WebSocket(address.current(terminal.cols, terminal.rows));
        socket.onopen = () => { if (!closed) { setState("open"); terminal.focus(); } };
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
        const watch = new ResizeObserver(() => { try { fit.fit(); } catch { /* not laid out yet */ } });
        watch.observe(element);
        // The page's colors change with the theme: the terminal follows.
        const scheme = matchMedia("(prefers-color-scheme: dark)"), recolor = () => { terminal.options.theme = palette(); };
        scheme.addEventListener("change", recolor);
        const themed = new MutationObserver(recolor);
        themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        dispose = () => { watch.disconnect(); themed.disconnect(); scheme.removeEventListener("change", recolor); typed.dispose(); sized.dispose(); terminal.dispose(); };
        if (closed) dispose();
      } catch { if (!closed) setState("failed"); }
    })();
    return () => { closed = true; socket?.close(); dispose(); };
  }, [attempt]);
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
    <header className="flex h-8 flex-none items-center gap-2 pr-1.5 pl-4 text-caption text-fg-3">
      <span className="text-fg-2">终端</span><span className="mono min-w-0 flex-1 trunc">{place}</span>
      {state === "ended" || state === "failed" ? <span className="flex-none" role="status">{state === "failed" ? "没有连上" : "已结束"}</span> : null}
      {state === "ended" || state === "failed" ? <button type="button" className="icon-btn size-6" aria-label="重新打开终端" title="重新打开" onClick={() => setAttempt(value => value + 1)}><RotateCw size={12} strokeWidth={2}/></button> : null}
      <button type="button" className="icon-btn size-6" aria-label="关闭终端" title="关闭" onClick={onClose}><X size={13} strokeWidth={2}/></button>
    </header>
    <div ref={host} className="terminal-host min-h-0 flex-1 overflow-hidden pr-1 pb-1.5 pl-4"/>
  </section>;
}
