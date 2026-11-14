import { ArrowLeft, Menu as MenuIcon, PanelLeft } from "lucide-react";
import { useState } from "react";
import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn.js";
import { ariaKeys, keyText } from "../lib/keys.js";
import { useMedia } from "../lib/prefs.js";
import { Tip } from "../ui/primitives.js";

/**
 * The frame of a page beside the conversation (Agent, settings, model connections), as on the Agent board: one scrolling
 * body whose head is the page title (28/36 · 600), its description and the page's actions, aligned to the description's
 * last line, then `belowHeader` (notices, a task list) and the page itself. `wide` is for pages of cards or tables
 * (1040 px); others read at 760.
 *
 * Above the body sits a quiet bar, only while it holds something: the navigation on a narrow screen, the button that
 * shows a hidden sidebar, and the way back when `onBack` is given. It draws its hairline only once the body has scrolled
 * under it. Without it the title starts 44 px below the top, as on the board, where the sidebar is the way back.
 * `ref` reaches the page's section, for a page that measures the room it has.
 */
export function PageShell({ title, titleId, description, actions, belowHeader, children, onMenu, sidebarHidden, onExpandSidebar, onBack, backLabel = "返回对话", className, wide = false, bodyClassName, ref }: {
  readonly title: ReactNode; readonly titleId: string; readonly description?: ReactNode; readonly actions?: ReactNode; readonly belowHeader?: ReactNode; readonly children: ReactNode;
  readonly onMenu: () => void; readonly sidebarHidden: boolean; readonly onExpandSidebar: () => void; readonly onBack?: () => void; readonly backLabel?: string; readonly className?: string; readonly wide?: boolean; readonly bodyClassName?: string;
  readonly ref?: Ref<HTMLElement>;
}) {
  const narrow = useMedia("(max-width: 759px)");
  const [scrolled, setScrolled] = useState(false);
  const bar = narrow || sidebarHidden || onBack !== undefined;
  return <section ref={ref} className={cn("management-page flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app", className)} aria-labelledby={titleId}>
    {bar ? <div className={cn("flex h-[52px] flex-none items-center gap-1 border-b-[0.5px] px-3 transition-[border-color] duration-120", scrolled ? "border-line" : "border-transparent")}>
      {narrow ? <button type="button" className="icon-btn navigation-toggle" onClick={onMenu} aria-label="打开导航"><MenuIcon size={18}/></button>
        : sidebarHidden ? <Tip label={"展开侧栏 " + keyText("sidebar")}><button type="button" className="icon-btn" aria-label="展开侧栏" aria-keyshortcuts={ariaKeys("sidebar")} onClick={onExpandSidebar}><PanelLeft size={16}/></button></Tip> : null}
      {onBack ? <Tip label={backLabel}><button type="button" className="icon-btn" aria-label={backLabel} onClick={onBack}><ArrowLeft size={16}/></button></Tip> : null}
    </div> : null}
    <div className={cn("management-body scroll-area min-h-0 flex-1", bodyClassName)} onScroll={event => setScrolled(event.currentTarget.scrollTop > 0)}>
      <div className={cn("mx-auto flex w-full flex-col gap-7 px-4 pb-16 sm:px-10", bar ? "pt-1" : "pt-11", wide ? "max-w-[1040px]" : "max-w-[760px]")}>
        <div className="flex flex-col">
          <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="flex min-w-[min(240px,100%)] flex-1 flex-col gap-1.5">
              <h1 id={titleId} className="m-0 text-title break-words">{title}</h1>
              {description ? <p className="m-0 max-w-[720px] text-ui leading-[22px] text-fg-2">{description}</p> : null}
            </div>
            {actions ? <div className="flex max-w-full flex-none flex-wrap items-center gap-2">{actions}</div> : null}
          </header>
          {belowHeader}
        </div>
        {children}
      </div>
    </div>
  </section>;
}
/**
 * A titled group on a page: the title (17/24 · 600) with an optional short note beside it on the same baseline, and an
 * optional action at the far end, as "还可以安装 · 36 个 · 全部" on the Agent board.
 */
export function Section({ title, description, children, actions, id }: { readonly title: ReactNode; readonly description?: ReactNode; readonly children: ReactNode; readonly actions?: ReactNode; readonly id?: string }) {
  return <section className="flex flex-col gap-3" {...(id ? { id } : {})}>
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <h2 className="m-0 text-panel">{title}</h2>{description ? <p className="m-0 min-w-0 text-ui-sm text-fg-3">{description}</p> : null}
      {actions ? <div className="ml-auto flex items-center gap-2 self-center">{actions}</div> : null}
    </div>
    {children}
  </section>;
}
/** A card of the page (radius 14, the card shadow); rows inside separate themselves with hairlines. */
export function Card({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn("card", className)}>{children}</div>;
}
