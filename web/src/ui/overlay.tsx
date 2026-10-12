import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { X } from "lucide-react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { cn } from "../lib/cn.js";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/**
 * A popover anchored to its trigger. The trigger element keeps its own accessible name; the popup is labelled by `label`.
 * Controlled when `open` is given. Focus moves into the popup (or to `initialFocus`) and returns to the trigger.
 */
export function Popover({ trigger, children, label, open, onOpenChange, side = "bottom", align = "start", sideOffset = 8, className, initialFocus }: {
  readonly trigger: ReactElement; readonly children: ReactNode; readonly label: string; readonly open?: boolean; readonly onOpenChange?: (open: boolean) => void;
  readonly side?: Side; readonly align?: Align; readonly sideOffset?: number; readonly className?: string; readonly initialFocus?: RefObject<HTMLElement | null>;
}) {
  return <BasePopover.Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}>
    <BasePopover.Trigger render={trigger}/>
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={12} positionMethod="fixed" className="hh-positioner z-50">
        <BasePopover.Popup aria-label={label} className={cn("surface-pop max-h-[min(560px,var(--available-height))] overflow-y-auto", className)} {...(initialFocus ? { initialFocus } : {})}>{children}</BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
export const PopoverClose = BasePopover.Close;

/** A heading row for a popover or panel with an optional close button. */
export function PopHead({ title, children, closeLabel }: { readonly title: ReactNode; readonly children?: ReactNode; readonly closeLabel?: string }) {
  return <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
    <h3 className="m-0 flex-1 text-[13px] font-semibold">{title}</h3>{children}
    {closeLabel ? <BasePopover.Close className="icon-btn icon-btn-sm" aria-label={closeLabel}><X size={14}/></BasePopover.Close> : null}
  </div>;
}

export interface MenuEntry {
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly hint?: ReactNode;
  readonly onSelect?: () => void;
  readonly href?: string;
  readonly download?: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly separator?: false;
}
/** A menu of actions; links download or navigate natively, items run their handler and close the menu. */
export function Menu({ trigger, items, side = "bottom", align = "end", footer, className }: {
  readonly trigger: ReactElement; readonly items: readonly (MenuEntry | { readonly separator: true } | { readonly heading: string })[];
  readonly side?: Side; readonly align?: Align; readonly footer?: ReactNode; readonly className?: string;
}) {
  return <BaseMenu.Root>
    <BaseMenu.Trigger render={trigger}/>
    <BaseMenu.Portal>
      <BaseMenu.Positioner side={side} align={align} sideOffset={6} collisionPadding={12} positionMethod="fixed" className="hh-positioner z-50">
        <BaseMenu.Popup className={cn("surface-pop min-w-[220px] p-1", className)}>
          {items.map((item, index) => "separator" in item && item.separator ? <div key={index} className="menu-sep" role="separator"/>
            : "heading" in item ? <div key={index} className="menu-label">{item.heading}</div>
            : (() => { const entry = item as MenuEntry; const body = <>{entry.icon ? <span className="flex w-4 flex-none justify-center text-fg-3" aria-hidden="true">{entry.icon}</span> : null}<span className="flex-1">{entry.label}</span>{entry.hint ? <span className="text-[11.5px] text-fg-3">{entry.hint}</span> : null}</>;
              return entry.href !== undefined
                ? <BaseMenu.LinkItem key={index} className={cn("menu-item", entry.danger && "menu-item-danger")} href={entry.href} {...(entry.download ? { download: "" } : {})}>{body}</BaseMenu.LinkItem>
                : <BaseMenu.Item key={index} className={cn("menu-item", entry.danger && "menu-item-danger")} disabled={entry.disabled ?? false} onClick={() => entry.onSelect?.()}>{body}</BaseMenu.Item>; })())}
          {footer ? <div className="border-t border-line px-2.5 pt-2 pb-1.5 text-[11.5px] text-fg-3">{footer}</div> : null}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
}

/** A modal dialog with a title; closing returns focus to whatever opened it. */
export function Dialog({ open, onOpenChange, title, description, children, className, kind = "center", initialFocus }: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly title: ReactNode; readonly description?: ReactNode; readonly children: ReactNode;
  readonly className?: string; readonly kind?: "center" | "drawer" | "left" | "sheet"; readonly initialFocus?: RefObject<HTMLElement | null>;
}) {
  const pop = kind === "drawer" ? "drawer-pop" : kind === "left" ? "drawer-left-pop" : kind === "sheet" ? "sheet-pop" : "dialog-pop";
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup className={cn(pop, "z-[61]", className)} {...(initialFocus ? { initialFocus } : {})}>
        {kind === "center" ? <div className="px-5 pt-5"><BaseDialog.Title className="m-0 text-[15px] font-semibold">{title}</BaseDialog.Title>{description ? <BaseDialog.Description className="mt-1.5 mb-0 text-[13px] text-fg-2">{description}</BaseDialog.Description> : null}</div>
          : <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>}
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}
export const DialogClose = BaseDialog.Close;
