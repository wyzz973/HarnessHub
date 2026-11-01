import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { useMedia } from "../lib/prefs.js";

/*
 * Motion primitives of design language 2.0 (ADR-054 §3, the Motion board's 38 details). The look and timing live in
 * styles.css; these components add what CSS alone cannot: knowing when text changed, keeping a leaving element on screen
 * until it has left, and measuring widths. Every one of them degrades to a fade of 150 ms or less, or to nothing, when the
 * system asks to reduce motion, and actions started from the keyboard are not animated (see trackInputModality).
 */

/** Whether the system asks to reduce motion, following changes. */
export function useReducedMotion(): boolean { return useMedia("(prefers-reduced-motion: reduce)"); }

/**
 * Records on the root element whether the last input came from the keyboard or a pointer (`data-input="keyboard"` or
 * `"pointer"`), so that actions started from the keyboard finish without animation (Motion board #37) and the `keyboard:`
 * variant can tell them apart. Composition keys of an input method do not count. Returns the function that stops it.
 */
export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const keyboard = (event: KeyboardEvent) => { if (!event.isComposing) root.dataset.input = "keyboard"; };
  const pointer = () => { root.dataset.input = "pointer"; };
  document.addEventListener("keydown", keyboard, true);
  document.addEventListener("pointerdown", pointer, true);
  return () => { document.removeEventListener("keydown", keyboard, true); document.removeEventListener("pointerdown", pointer, true); delete root.dataset.input; };
}

/**
 * Style for a motion class's optional inputs, all in milliseconds or pixels: a start delay (for staggering), a duration
 * (#19 draws its arrow in 160 ms), the rise of `motion-enter`, the start scale of `motion-pop-in`. They apply to the
 * element they are set on only, not to its children.
 */
export function motionStyle({ delay, duration, shift, scaleFrom }: { readonly delay?: number; readonly duration?: number; readonly shift?: number; readonly scaleFrom?: number }): CSSProperties {
  const style: Record<string, string> = {};
  if (delay !== undefined) style["--motion-delay"] = delay + "ms";
  if (duration !== undefined) style["--motion-duration"] = duration + "ms";
  if (shift !== undefined) style["--motion-shift"] = shift + "px";
  if (scaleFrom !== undefined) style["--motion-scale-from"] = String(scaleFrom);
  return style as CSSProperties;
}

export type Presence = "opening" | "open" | "closing" | "closed";
/**
 * The life of something that animates in and out: "opening" for `enterMs` after `open` turns true, then "open"; "closing"
 * for `exitMs` after it turns false, then "closed", when the caller unmounts it. Timers are owned by the hook and cleared
 * when it unmounts or the direction changes midway.
 */
export function usePresence(open: boolean, enterMs: number, exitMs: number): Presence {
  const [state, setState] = useState<Presence>(open ? "open" : "closed");
  const [wasOpen, setWasOpen] = useState(open);
  let current = state;
  if (open !== wasOpen) { current = open ? "opening" : "closing"; setWasOpen(open); setState(current); }
  useEffect(() => {
    if (state !== "opening" && state !== "closing") return;
    const timer = setTimeout(() => setState(state === "opening" ? "open" : "closed"), state === "opening" ? enterMs : exitMs);
    return () => clearTimeout(timer);
  }, [state, enterMs, exitMs]);
  return current;
}

/**
 * Words with a soft band of light sweeping across them while work is in progress (Motion board #01): it waits 0.6 s,
 * sweeps in 1 s and repeats every 4 s, starting over whenever the words change. With reduced motion the words are still.
 */
export function ShimmerText({ children, active = true, className }: { readonly children: string; readonly active?: boolean; readonly className?: string }) {
  return <span key={children} className={cn(active && "shimmer-text", className)}>{children}</span>;
}

/**
 * A status line whose words change in place (Motion board #07): the old words rise 3 px and fade while the new ones come
 * up from 3 px below, in 180 ms, and the width slides so whatever follows (a timer) moves smoothly instead of jumping.
 * `shimmer` adds the in-progress sweep, restarted with each change. With reduced motion the words are simply replaced.
 * The leaving words are hidden from assistive technology and removed when they have left.
 */
export function SwapText({ text, shimmer = false, className }: { readonly text: string; readonly shimmer?: boolean; readonly className?: string }) {
  const [shown, setShown] = useState<{ readonly text: string; readonly previous: string | null; readonly turn: number }>({ text, previous: null, turn: 0 });
  if (shown.text !== text) setShown({ text, previous: shown.text, turn: shown.turn + 1 });
  const layer = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = layer.current;
    if (!node) return;
    setWidth(node.offsetWidth);
    const observer = new ResizeObserver(() => setWidth(node.offsetWidth)); observer.observe(node);
    return () => observer.disconnect();
  }, [shown.turn]);
  useEffect(() => {
    if (shown.previous === null) return;
    const turn = shown.turn, timer = setTimeout(() => setShown(state => state.turn === turn ? { ...state, previous: null } : state), 180);
    return () => clearTimeout(timer);
  }, [shown.turn, shown.previous]);
  return <span className={cn("swap-text", className)} style={width === null ? undefined : { width }}>
    {shown.previous !== null ? <span key={"out-" + shown.turn} className="swap-text-layer swap-text-out" aria-hidden="true">{shown.previous}</span> : null}
    <span key={"in-" + shown.turn} ref={layer} className={cn("swap-text-layer", shown.turn > 0 && "swap-text-in")}>{shimmer ? <ShimmerText>{shown.text}</ShimmerText> : shown.text}</span>
  </span>;
}

/**
 * A check that draws itself in one stroke over 240 ms (Motion board #06), plain or in a circle (a finished summary).
 * Pass `animate` only when the step has just finished; a check for work done earlier appears drawn.
 */
export function DrawnCheck({ size = 15, circle = false, animate = true, delay, className }: {
  readonly size?: number; readonly circle?: boolean; readonly animate?: boolean; readonly delay?: number; readonly className?: string;
}) {
  return <svg className={cn("flex-none", className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={circle ? 2 : 2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {circle ? <circle cx="12" cy="12" r="10"/> : null}
    <path className={animate ? "motion-draw" : undefined} pathLength={1} d={circle ? "m16 9-5.5 5.5L8 12" : "M20 6 9 17l-5-5"} style={delay === undefined ? undefined : motionStyle({ delay })}/>
  </svg>;
}

/** The 7 px dot at the end of a reply still being written (Motion board #11); `done` fades it out in 200 ms. */
export function EndDot({ done = false }: { readonly done?: boolean }) {
  return <span className="end-dot" aria-hidden="true" {...(done ? { "data-done": "" } : {})}/>;
}

/**
 * Content that opens and closes in place (Motion board #13, #18, #22): its height goes from nothing to its content with a
 * fade, 200 ms on the expand curve, both ways. Closed content is inert and, unless `keepMounted`, unmounted once it has
 * closed. The trigger keeps aria-expanded and, with `id`, aria-controls.
 */
export function Collapsible({ open, children, id, keepMounted = false, className }: {
  readonly open: boolean; readonly children: ReactNode; readonly id?: string; readonly keepMounted?: boolean; readonly className?: string;
}) {
  const presence = usePresence(open, 200, 200);
  return <div id={id} className={cn("collapsible", className)} data-open={open ? "true" : "false"} data-state={presence}>
    <div className="collapsible-inner" inert={!open}>{keepMounted || presence !== "closed" ? children : null}</div>
  </div>;
}

/**
 * A bar that rises from the bottom while there is something to act on (Motion board #29), such as "已选 3 处 · 预览写入":
 * up 16 px in 300 ms, down in 200 ms, then unmounted. It centres itself in its containing block at its content's width,
 * keeping 16 px from either side, so its words wrap only when that room runs out. The caller gives the position and the
 * bottom offset with `className`, for example "absolute bottom-6" or "fixed bottom-6"; a translate or left: 50% would
 * halve the room its width is worked out in.
 */
export function FloatingBar({ open, label, children, className }: { readonly open: boolean; readonly label: string; readonly children: ReactNode; readonly className?: string }) {
  const presence = usePresence(open, 300, 200);
  if (presence === "closed") return null;
  return <div role="region" aria-label={label} className={cn("floating-bar", className)} data-state={presence === "closing" ? "closing" : "open"}>{children}</div>;
}

/**
 * The glyph of the send button that becomes a stop button while a reply runs (Motion board #16, #17): the arrow turns
 * through 96° to 90° and lifts 2.5 px as it becomes a square, and turns back through −6°; 480 ms. Decorative: the button
 * carries the name ("发送" or "停止"). With reduced motion the glyph is swapped at once.
 */
export function SendStopIcon({ stop, size = 15 }: { readonly stop: boolean; readonly size?: number }) {
  const [morph, setMorph] = useState<"stop" | "send" | null>(null);
  const [was, setWas] = useState(stop);
  if (was !== stop) { setWas(stop); setMorph(stop ? "stop" : "send"); }
  useEffect(() => {
    if (morph === null) return;
    const timer = setTimeout(() => setMorph(null), 480);
    return () => clearTimeout(timer);
  }, [morph]);
  const square = Math.round(size * .73);
  return <span className="send-stop" data-state={stop ? "stop" : "send"} {...(morph ? { "data-morph": morph } : {})} style={{ width: size, height: size }} aria-hidden="true">
    <svg className="send-stop-arrow" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
    <svg className="send-stop-square" width={square} height={square} viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/></svg>
  </span>;
}
