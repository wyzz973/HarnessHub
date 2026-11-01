import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { useMemo, type ReactElement, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/cn.js";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/*
 * Floating layers of design language 2.0: popovers and menus grow from their trigger (.98 → 1, 120 ms, back in 100 ms),
 * dialogs from the middle over a fading scrim (200 ms), drawers slide in from their edge, toasts rise from the bottom.
 * All of them sit on the surface color with the floating shadow (radius 14), open and close at once from the keyboard,
 * and only fade when the system asks to reduce motion. Layers stack: popovers and menus 50, option lists 55, dialogs 60–61, tips 70, toasts 80.
 */

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
  return <div className="flex items-center gap-2 hairline-b px-3.5 py-2.5">
    <h3 className="m-0 flex-1 text-ui-sm font-semibold">{title}</h3>{children}
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
        <BaseMenu.Popup className={cn("surface-pop min-w-[220px] p-[5px]", className)}>
          {items.map((item, index) => "separator" in item && item.separator ? <div key={index} className="menu-sep" role="separator"/>
            : "heading" in item ? <div key={index} className="menu-label">{item.heading}</div>
            : (() => { const entry = item as MenuEntry; const body = <>{entry.icon ? <span className="flex w-4 flex-none justify-center text-fg-3" aria-hidden="true">{entry.icon}</span> : null}<span className="flex-1">{entry.label}</span>{entry.hint ? <span className="text-caption text-fg-3">{entry.hint}</span> : null}</>;
              return entry.href !== undefined
                ? <BaseMenu.LinkItem key={index} className={cn("menu-item", entry.danger && "menu-item-danger")} href={entry.href} {...(entry.download ? { download: "" } : {})}>{body}</BaseMenu.LinkItem>
                : <BaseMenu.Item key={index} className={cn("menu-item", entry.danger && "menu-item-danger")} disabled={entry.disabled ?? false} onClick={() => entry.onSelect?.()}>{body}</BaseMenu.Item>; })())}
          {footer ? <div className="mt-1 hairline-t px-2 pt-2 pb-1.5 text-caption text-fg-3">{footer}</div> : null}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  </BaseMenu.Root>;
}

/**
 * A modal dialog with a title; closing returns focus to whatever opened it. "center" grows from the middle and shows the
 * title and description (panel title 17/24); "drawer" slides in from the right, "left" is the narrow-screen navigation
 * drawer and "sheet" rises from the bottom; those three keep the title for assistive technology only.
 */
export function Dialog({ open, onOpenChange, title, description, children, className, kind = "center", initialFocus }: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly title: ReactNode; readonly description?: ReactNode; readonly children: ReactNode;
  readonly className?: string; readonly kind?: "center" | "drawer" | "left" | "sheet"; readonly initialFocus?: RefObject<HTMLElement | null>;
}) {
  const pop = kind === "drawer" ? "drawer-pop" : kind === "left" ? "drawer-left-pop" : kind === "sheet" ? "sheet-pop" : "dialog-pop";
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup className={cn(pop, "z-[61]", className)} {...(initialFocus ? { initialFocus } : {})}>
        {kind === "center" ? <div className="px-5 pt-5"><BaseDialog.Title className="m-0 text-panel">{title}</BaseDialog.Title>{description ? <BaseDialog.Description className="mt-1.5 mb-0 text-ui-sm text-fg-2">{description}</BaseDialog.Description> : null}</div>
          : <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>}
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}
export const DialogClose = BaseDialog.Close;

/** What a toast says: one line, and at most one action such as "撤销". */
export interface ToastOptions {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Milliseconds before it leaves on its own; 0 keeps it until dismissed. Default 2.4 s, or 5 s with an action. */
  readonly timeout?: number;
  /** "high" is announced at once (assertive); the default waits politely. */
  readonly priority?: "low" | "high";
}
/**
 * Shows short notes at the bottom of the page (Motion board #27): each slides up in 200 ms and leaves shrinking to .85
 * with a fade; while several are shown, each older one sits 14 px higher and 4 % smaller, and hovering spreads them out.
 * Hovering or focusing them pauses their timers. Needs a ToastProvider above the caller (main.tsx provides it).
 */
export function useToast(): { readonly show: (options: ToastOptions) => string; readonly close: (id: string) => void } {
  const manager = BaseToast.useToastManager();
  return useMemo(() => ({
    show: (options: ToastOptions) => manager.add({
      title: options.title, ...(options.description === undefined ? {} : { description: options.description }), priority: options.priority ?? "low",
      timeout: options.timeout ?? (options.action ? 5000 : 2400),
      ...(options.action ? { actionProps: { children: options.action.label, onClick: options.action.onClick } } : {}),
    }),
    close: (id: string) => manager.close(id),
  }), [manager]);
}
/** Holds the page's toasts and renders them above everything else; wrap the application once. */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  return <BaseToast.Provider limit={3}>
    {children}
    <BaseToast.Portal><BaseToast.Viewport className="toast-viewport"><ToastList/></BaseToast.Viewport></BaseToast.Portal>
  </BaseToast.Provider>;
}
function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map(toast => <BaseToast.Root key={toast.id} toast={toast} className="toast">
    <BaseToast.Content className="toast-content">
      <div className="min-w-0"><BaseToast.Title className="m-0 text-caption font-medium"/>{toast.description ? <BaseToast.Description className="m-0 text-caption opacity-80"/> : null}</div>
      {toast.actionProps ? <BaseToast.Action className="toast-action"/> : null}
    </BaseToast.Content>
  </BaseToast.Root>);
}
