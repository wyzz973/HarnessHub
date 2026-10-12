import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { AlertCircle, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.js";

/** HarnessHub's mark: a hub with three connected runtimes, drawn in the text color on a dark tile. */
export function LogoMark({ size = 26, className }: { readonly size?: number; readonly className?: string }) {
  return <span aria-hidden="true" className={cn("inline-flex flex-none items-center justify-center rounded-[7px] bg-fg text-app", className)} style={{ width: size, height: size }}>
    <svg width={Math.round(size * .62)} height={Math.round(size * .62)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="2.6" fill="currentColor"/><circle cx="12" cy="4.5" r="1.8"/><circle cx="5.5" cy="16" r="1.8"/><circle cx="18.5" cy="16" r="1.8"/><path d="M12 9.4V6.3M9.8 13.4l-2.9 1.7M14.2 13.4l2.9 1.7"/>
    </svg>
  </span>;
}
export function Spinner({ label = "加载中", size = 15, className }: { readonly label?: string; readonly size?: number; readonly className?: string }) {
  return <LoaderCircle size={size} className={cn("spin flex-none text-fg-3", className)} aria-label={label} role="img"/>;
}
export function Kbd({ children }: { readonly children: ReactNode }) { return <kbd className="kbd">{children}</kbd>; }

type Tone = "neutral" | "accent" | "amber" | "red" | "green";
export function Badge({ tone = "neutral", dot = false, children, className, title }: { readonly tone?: Tone; readonly dot?: boolean; readonly children: ReactNode; readonly className?: string; readonly title?: string }) {
  return <span className={cn("badge", tone !== "neutral" && `badge-${tone}`, className)} title={title}>{dot ? <span className="dot" aria-hidden="true"/> : null}{children}</span>;
}

/** A message band above content. `role` follows urgency: errors interrupt, everything else is a status. */
export function Notice({ tone = "neutral", title, children, action, onDismiss, className }: {
  readonly tone?: "neutral" | "amber" | "red" | "accent" | "green"; readonly title?: ReactNode; readonly children?: ReactNode; readonly action?: ReactNode; readonly onDismiss?: (() => void) | undefined; readonly className?: string | undefined;
}) {
  const Icon = tone === "red" ? AlertCircle : tone === "amber" ? TriangleAlert : tone === "green" ? CircleCheck : Info;
  const colors = { neutral: "border-line bg-surface", amber: "border-amber-line bg-amber-soft", red: "border-red-line bg-red-soft", accent: "border-accent-soft bg-accent-soft", green: "border-line bg-green-soft" }[tone];
  const iconColor = { neutral: "text-fg-3", amber: "text-amber", red: "text-red", accent: "text-accent-text", green: "text-green" }[tone];
  return <div role={tone === "red" ? "alert" : "status"} className={cn("enter flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px]", colors, className)}>
    <Icon size={16} className={cn("mt-px flex-none", iconColor)} aria-hidden="true"/>
    <div className="min-w-0 flex-1">{title ? <strong className="block font-semibold">{title}</strong> : null}{children ? <div className={cn(title ? "mt-0.5 text-fg-2" : "text-fg")}>{children}</div> : null}</div>
    {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
    {onDismiss ? <button type="button" className="icon-btn icon-btn-sm -mr-1 -mt-0.5" aria-label="关闭提示" onClick={onDismiss}><X size={14}/></button> : null}
  </div>;
}
export function EmptyState({ icon, title, children, action }: { readonly icon?: ReactNode; readonly title: string; readonly children?: ReactNode; readonly action?: ReactNode }) {
  return <div className="enter mx-auto flex max-w-md flex-col items-center px-6 py-14 text-center">
    {icon ? <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-subtle text-fg-2" aria-hidden="true">{icon}</div> : null}
    <h2 className="m-0 text-[15px] font-semibold">{title}</h2>{children ? <p className="mt-1.5 mb-0 text-[13px] text-fg-2">{children}</p> : null}{action ? <div className="mt-4">{action}</div> : null}
  </div>;
}
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
