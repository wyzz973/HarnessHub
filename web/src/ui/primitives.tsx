import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { AlertCircle, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

/**
 * HarnessHub's mark, "one point fanning out" (ADR-054 §4): a blue tile, one dot, three lines. Drawn on the 32 grid of the
 * favicon, so its lines stay apart down to 16 px. Decorative: the product name always sits next to it or names its control.
 */
export function LogoMark({ size = 22, className }: { readonly size?: number; readonly className?: string }) {
  const gradient = "hh-mark-" + useId().replace(/[^\w-]/gu, "");
  return <svg className={cn("logo-mark", className)} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#5a87f2"/><stop offset="1" stopColor="#2f5fd6"/></linearGradient></defs>
    <rect width="32" height="32" rx="7.5" fill={`url(#${gradient})`}/>
    <g fill="none" stroke="#fff" strokeWidth="2.75" strokeLinecap="round"><path d="M12 16c4.5 0 5.5-6.5 12.5-6.5"/><path d="M12 16h12.5"/><path d="M12 16c4.5 0 5.5 6.5 12.5 6.5"/></g>
    <circle cx="10" cy="16" r="4" fill="#fff"/>
  </svg>;
}

/**
 * Work in progress: a 90° arc turning once every 0.8 s (Motion board #02). Colored by its text unless `tone` is "run",
 * the blue of a running Turn. With reduced motion it is a still dot. An empty `label` hides it from assistive technology.
 */
export function Spinner({ label = "加载中", size = 15, tone, className }: { readonly label?: string; readonly size?: number; readonly tone?: "run"; readonly className?: string }) {
  return <svg className={cn("spinner text-fg-3", tone === "run" && "text-run", className)} width={size} height={size} viewBox="0 0 50 50"
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
    <circle className="spinner-arc" cx="25" cy="25" r="20" pathLength="100"/><circle className="spinner-still" cx="25" cy="25" r="7"/>
  </svg>;
}

/** A key (⌘, K, esc) drawn as a keycap; `variant="hint"` is the plain small text shown inside a button ("拒绝 esc"). */
export function Kbd({ children, variant = "key", className }: { readonly children: ReactNode; readonly variant?: "key" | "hint"; readonly className?: string }) {
  return <kbd className={cn(variant === "hint" ? "kbd-hint" : "kbd", className)}>{children}</kbd>;
}

type Tone = "neutral" | "accent" | "amber" | "red" | "green";
/**
 * A small pill: a label ("1 个更新", "可更新") or, with `count`, a number ("2"). Amber only for things waiting for you, red
 * only for failures. "green" is kept for existing callers and shows the accent, as success does everywhere (ADR-054 §1).
 */
export function Badge({ tone = "neutral", dot = false, count = false, children, className, title }: {
  readonly tone?: Tone; readonly dot?: boolean; readonly count?: boolean; readonly children: ReactNode; readonly className?: string; readonly title?: string;
}) {
  return <span className={cn("badge", tone !== "neutral" && `badge-${tone}`, count && "badge-count", className)} title={title}>{dot ? <span className="dot" aria-hidden="true"/> : null}{children}</span>;
}

/**
 * A state with a dot ("就绪", "Codex 等你批准", "正在执行 · 0:44"). `live` makes the dot breathe for running work.
 * `size="lg"` is the conversation header's 26 px pill; the default is 24 px.
 */
export function StatusPill({ tone = "neutral", live = false, size = "md", children, className, title }: {
  readonly tone?: "neutral" | "accent" | "amber" | "red"; readonly live?: boolean; readonly size?: "md" | "lg"; readonly children: ReactNode; readonly className?: string; readonly title?: string;
}) {
  const dot = tone === "accent" ? "run" : tone === "amber" ? "wait" : tone === "red" ? "fail" : "idle";
  return <span className={cn("status-pill", size === "lg" && "status-pill-lg", className)} data-tone={tone} title={title}><StatusDot tone={dot} live={live}/>{children}</span>;
}

/**
 * The state dot used in the sidebar, page headers and Turn summaries (Icons board): blue for running (it breathes unless
 * `live` is false), amber for waiting for you, red for failed, grey for idle. Hidden from assistive technology unless
 * given a `label`; the row it marks should say its state in words as well.
 */
export function StatusDot({ tone, live = tone === "run", size = 7, label, className }: {
  readonly tone: "run" | "wait" | "fail" | "idle"; readonly live?: boolean; readonly size?: number; readonly label?: string; readonly className?: string;
}) {
  return <span className={cn("status-dot", className)} data-tone={tone} {...(live ? { "data-live": "" } : {})} style={size === 7 ? undefined : { width: size, height: size }}
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}/>;
}

/**
 * A message band above content: what happened first, then why, then at most two ways forward, shown below the words as on
 * the Interaction board. `role` follows urgency: errors interrupt, everything else is a status. Amber only for something
 * waiting for you, red only for a failure; "green" is kept for existing callers and shows the accent, as success does.
 */
export function Notice({ tone = "neutral", title, children, action, onDismiss, className }: {
  readonly tone?: "neutral" | "amber" | "red" | "accent" | "green"; readonly title?: ReactNode; readonly children?: ReactNode; readonly action?: ReactNode; readonly onDismiss?: (() => void) | undefined; readonly className?: string | undefined;
}) {
  const Icon = tone === "red" ? AlertCircle : tone === "amber" ? TriangleAlert : tone === "green" ? CircleCheck : Info;
  const colors = { neutral: "bg-surface shadow-hairline", amber: "bg-amber-soft", red: "bg-red-soft", accent: "bg-accent-soft", green: "bg-accent-soft" }[tone];
  const accent = { neutral: "text-fg-3", amber: "text-amber", red: "text-red", accent: "text-accent-text", green: "text-accent-text" }[tone];
  // The title is text on the tint: the tone's higher-contrast shade (ruling M); the icon is a mark and keeps the tone's colour.
  const ink = { neutral: "text-fg", amber: "text-amber-on-tint", red: "text-red-on-tint", accent: "text-accent-text", green: "text-accent-text" }[tone];
  return <div role={tone === "red" ? "alert" : "status"} className={cn("motion-fade-in flex items-start gap-2.5 rounded-block px-3 py-2.5 text-ui-sm", colors, className)}>
    <Icon size={16} className={cn("mt-0.5 flex-none", accent)} aria-hidden="true"/>
    <div className="min-w-0 flex-1">
      {title ? <strong className={cn("block font-semibold", ink)}>{title}</strong> : null}{children ? <div className={cn(title ? "mt-0.5 text-fg-2" : "text-fg")}>{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{action}</div> : null}
    </div>
    {onDismiss ? <button type="button" className="icon-btn icon-btn-sm -mt-0.5 -mr-1" aria-label="关闭提示" onClick={onDismiss}><X size={14}/></button> : null}
  </div>;
}
/** An empty place: a quiet icon, what is missing, and at most one way forward. */
export function EmptyState({ icon, title, children, action }: { readonly icon?: ReactNode; readonly title: string; readonly children?: ReactNode; readonly action?: ReactNode }) {
  return <div className="motion-fade-in mx-auto flex max-w-sm flex-col items-center gap-2 px-6 py-10 text-center">
    {icon ? <div className="mb-1 flex text-fg-3 [&_svg]:size-7" aria-hidden="true">{icon}</div> : null}
    <h2 className="m-0 text-ui font-medium text-fg-2">{title}</h2>{children ? <p className="m-0 text-ui-sm text-fg-3">{children}</p> : null}{action ? <div className="mt-2">{action}</div> : null}
  </div>;
}
/** An on/off setting (Motion board #33): 28 × 16, blue when on; the thumb slides in 200 ms. */
export function Switch({ checked, onChange, disabled, label, className }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly disabled?: boolean; readonly label: string; readonly className?: string }) {
  return <BaseSwitch.Root className={cn("switch", className)} checked={checked} onCheckedChange={value => onChange(value)} disabled={disabled ?? false} aria-label={label}><BaseSwitch.Thumb className="switch-thumb"/></BaseSwitch.Root>;
}
/** A short hint for an icon control; the control keeps its own accessible name. */
export function Tip({ label, children, side = "bottom" }: { readonly label: ReactNode; readonly children: ReactElement; readonly side?: "top" | "bottom" | "left" | "right" }) {
  return <BaseTooltip.Root>
    <BaseTooltip.Trigger render={children}/>
    <BaseTooltip.Portal><BaseTooltip.Positioner side={side} sideOffset={6} positionMethod="fixed" className="z-[70]"><BaseTooltip.Popup className="tooltip-pop">{label}</BaseTooltip.Popup></BaseTooltip.Positioner></BaseTooltip.Portal>
  </BaseTooltip.Root>;
}
export const TipProvider = BaseTooltip.Provider;
/** A labelled row of a definition list, for facts shown two columns wide. */
export function Fact({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return <><dt className="text-fg-3">{label}</dt><dd className="m-0 min-w-0 break-words">{children}</dd></>;
}

/**
 * Places a sliding mark (the underline or the thumb) on the chosen item and keeps it there through resizes and changed
 * items (`layout`); moves are animated once the first placement has painted.
 */
function useSlidingMark(container: { readonly current: HTMLElement | null }, selected: string, mark: { readonly current: HTMLElement | null }, layout: string): void {
  useLayoutEffect(() => {
    const root = container.current, indicator = mark.current;
    if (!root || !indicator) return;
    const place = () => {
      const target = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`);
      if (!target) { indicator.style.opacity = "0"; return; }
      indicator.style.opacity = ""; indicator.style.width = target.offsetWidth + "px"; indicator.style.transform = `translateX(${target.offsetLeft}px)`;
    };
    place();
    const frame = requestAnimationFrame(() => root.setAttribute("data-ready", ""));
    const observer = new ResizeObserver(place); observer.observe(root);
    for (const child of root.children) observer.observe(child);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [container, selected, mark, layout]);
}
/** Arrow keys, Home and End move through the enabled items and choose the one reached (automatic activation). */
function rovingKey(event: KeyboardEvent<HTMLElement>, keys: readonly string[], current: string, choose: (key: string) => void): void {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  const index = keys.indexOf(current);
  const next = event.key === "Home" ? keys[0] : event.key === "End" ? keys.at(-1) : step !== 0 && keys.length ? keys[((index < 0 ? 0 : index) + step + keys.length) % keys.length] : undefined;
  if (next === undefined || event.nativeEvent.isComposing) return;
  event.preventDefault(); choose(next);
  event.currentTarget.querySelector<HTMLElement>(`[data-key="${CSS.escape(next)}"]`)?.focus();
}

export interface TabItem<T extends string> { readonly id: T; readonly label: ReactNode; readonly count?: number | null; readonly disabled?: boolean }
/**
 * A row of tabs whose underline slides to the chosen tab, position and width together (Motion board #24). Renders the
 * tablist only: each tab gets the id `${idPrefix}-${id}` and, with `panelId`, controls that single panel, which the caller
 * renders with role="tabpanel" and aria-labelledby. Arrow keys, Home and End move and choose.
 */
export function Tabs<T extends string>({ items, value, onChange, label, idPrefix, panelId, className }: {
  readonly items: readonly TabItem<T>[]; readonly value: T; readonly onChange: (value: T) => void; readonly label: string;
  readonly idPrefix?: string; readonly panelId?: string; readonly className?: string;
}) {
  const list = useRef<HTMLDivElement>(null), indicator = useRef<HTMLSpanElement>(null);
  useSlidingMark(list, value, indicator, items.map(item => item.id + ":" + (item.count ?? "")).join("|"));
  const enabled = items.filter(item => !item.disabled).map(item => item.id);
  const choose = useCallback((key: string) => { if (key !== value) onChange(key as T); }, [onChange, value]);
  return <div ref={list} role="tablist" aria-label={label} className={cn("tabs", className)} data-indicator="" onKeyDown={event => rovingKey(event, enabled, value, choose)}>
    {items.map(item => <button key={item.id} type="button" role="tab" data-key={item.id} id={idPrefix ? `${idPrefix}-${item.id}` : undefined} aria-selected={item.id === value}
      aria-controls={panelId} tabIndex={item.id === value ? 0 : -1} disabled={item.disabled ?? false} className="tab" onClick={() => choose(item.id)}>
      {item.label}{item.count !== undefined && item.count !== null ? <span className="tab-count">{item.count}</span> : null}
    </button>)}
    <span ref={indicator} className="tabs-indicator" aria-hidden="true"/>
  </div>;
}

/**
 * One choice of a few, as a segmented control whose thumb slides to the chosen option (Motion board #25). A radio group:
 * arrow keys, Home and End move and choose. `size="md"` is 30 px tall; the default is 24 px.
 */
export function Segmented<T extends string>({ options, value, onChange, label, size = "sm", className }: {
  readonly options: readonly { readonly value: T; readonly label: ReactNode; readonly disabled?: boolean }[]; readonly value: T; readonly onChange: (value: T) => void;
  readonly label: string; readonly size?: "sm" | "md"; readonly className?: string;
}) {
  const group = useRef<HTMLDivElement>(null), thumb = useRef<HTMLSpanElement>(null);
  useSlidingMark(group, value, thumb, options.map(option => option.value).join("|"));
  const enabled = options.filter(option => !option.disabled).map(option => option.value);
  const choose = useCallback((key: string) => { if (key !== value) onChange(key as T); }, [onChange, value]);
  return <div ref={group} role="radiogroup" aria-label={label} className={cn("segmented", size === "md" && "segmented-md", className)} data-thumb="" onKeyDown={event => rovingKey(event, enabled, value, choose)}>
    <span ref={thumb} className="segmented-thumb" aria-hidden="true"/>
    {options.map(option => <button key={option.value} type="button" role="radio" data-key={option.value} aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1}
      disabled={option.disabled ?? false} onClick={() => choose(option.value)}>{option.label}</button>)}
  </div>;
}
