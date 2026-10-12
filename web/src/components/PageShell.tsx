import { ArrowLeft, Menu as MenuIcon, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { useMedia } from "../lib/prefs.js";
import { Tip } from "../ui/primitives.js";

/** The frame of a management page: a header with the way back to the conversation, and one scrolling body. */
export function PageShell({ title, titleId, description, actions, children, onMenu, sidebarHidden, onExpandSidebar, onBack, backLabel = "返回对话", className, wide = false, bodyClassName }: {
  readonly title: ReactNode; readonly titleId: string; readonly description?: ReactNode; readonly actions?: ReactNode; readonly children: ReactNode;
  readonly onMenu: () => void; readonly sidebarHidden: boolean; readonly onExpandSidebar: () => void; readonly onBack?: () => void; readonly backLabel?: string; readonly className?: string; readonly wide?: boolean; readonly bodyClassName?: string;
}) {
  const narrow = useMedia("(max-width: 759px)");
  return <section className={cn("management-page flex h-full min-h-0 min-w-0 flex-1 flex-col", className)} aria-labelledby={titleId}>
    <header className="flex h-14 flex-none items-center gap-2 border-b border-line bg-app pr-3.5 pl-3 sm:pl-[18px]">
      {narrow ? <button type="button" className="icon-btn navigation-toggle" onClick={onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
        : sidebarHidden ? <Tip label="展开侧栏"><button type="button" className="icon-btn" aria-label="展开侧栏" onClick={onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null}
      {onBack ? <Tip label={backLabel}><button type="button" className="icon-btn" aria-label={backLabel} onClick={onBack}><ArrowLeft size={17}/></button></Tip> : null}
      <h1 id={titleId} className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.005em]">{title}</h1>
      {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
    </header>
    <div className={cn("management-body scroll-area min-h-0 flex-1", bodyClassName)}>
      <div className={cn("mx-auto flex w-full flex-col gap-5 px-4 pt-6 pb-16 sm:px-7", wide ? "max-w-[1040px]" : "max-w-[860px]")}>
        {description ? <p className="m-0 text-[13.5px] text-fg-2">{description}</p> : null}
        {children}
      </div>
    </div>
  </section>;
}
/** A titled group of settings or facts on a management page. */
export function Section({ title, description, children, actions, id }: { readonly title: ReactNode; readonly description?: ReactNode; readonly children: ReactNode; readonly actions?: ReactNode; readonly id?: string }) {
  return <section className="flex flex-col gap-3" {...(id ? { id } : {})}>
    <div className="flex flex-wrap items-end justify-between gap-2"><div className="min-w-0"><h2 className="m-0 text-[14px] font-semibold">{title}</h2>{description ? <p className="m-0 mt-0.5 text-[12.5px] text-fg-2">{description}</p> : null}</div>{actions}</div>
    {children}
  </section>;
}
export function Card({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn("rounded-xl border border-line bg-surface shadow-sm", className)}>{children}</div>;
}
