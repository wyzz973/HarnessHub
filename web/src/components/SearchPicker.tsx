import { Popover as BasePopover } from "@base-ui/react/popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { cn } from "../lib/cn.js";

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  /** What the trigger shows when this option is chosen, when shorter than its label. */
  readonly short?: string;
  readonly icon?: ReactNode;
  readonly description?: string;
  readonly group?: string;
  readonly disabled?: boolean;
  readonly reason?: string;
  /** A short state shown beside the label, such as whether a Harness is ready. */
  readonly status?: { readonly tone: "success" | "warning" | "danger"; readonly label: string; readonly title?: string };
}
/** Ready reads as the accent, waiting for the user as amber and a failed read as red (ADR-054 §1: no green for success). */
const TONES = { success: "badge-accent", warning: "badge-amber", danger: "badge-red" } as const;
/**
 * Searchable, keyboard-operated selection (design language 2.0): the list grows from its trigger on the floating surface,
 * the active row is tinted and the chosen one carries a blue check. Disabled choices stay visible with their actual reason,
 * in amber. The trigger keeps the accessible name `label`; by default it shows the selected choice, after `prefix` when
 * given, and `trigger` replaces that content (the composer's merged picker draws its segments this way). Input-method
 * composition never selects. `open` and `onOpenChange` make it controlled, so a shortcut (⌘J) can open it; focus goes to
 * the search field and returns to the trigger when the list closes. A list closed by a choice gives the focus to `focusAfterChoice`
 * when there is one (the message box, for the composer's lists: what is typed next is the message, not a key pressed on the
 * control that opened the list) and says so by `onFocusHandedOver`; one closed without a choice still gives it back to where it came from.
 */
export function SearchPicker({ label, value, placeholder, options, onChange, disabled = false, footer, prefix, className, wide = false, side = "top", align = "start",
  open: controlledOpen, onOpenChange, title, trigger, chevron = true, size = "md", empty, triggerRef: outerTrigger, describedBy, focusAfterChoice, onFocusHandedOver, aside, anchor }: {
  label: string; value: string; placeholder: string; options: readonly PickerOption[];
  onChange: (value: string) => void; disabled?: boolean; footer?: ReactNode; prefix?: string; className?: string; wide?: boolean; side?: "top" | "bottom";
  align?: "start" | "end";
  /** Controlled open state; leave both undefined to let the picker own it. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
  /** A caption above the search field, such as "由谁来做 · ⌘J". */
  title?: ReactNode;
  /** The trigger's content in place of the default icon and label; the trigger keeps `label` as its accessible name. */
  trigger?: (selected: PickerOption | undefined) => ReactNode;
  chevron?: boolean;
  /** "lg" rows carry 14 px names beside larger icons (the Agent list); "md" rows are 13 px. */
  size?: "md" | "lg";
  /** What the list says when it has no choices at all (rather than none matching the search). */
  empty?: ReactNode;
  /** Receives the trigger, for a panel the list's footer opens to give the focus back to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** The id of what describes the trigger beyond its name, such as a mark the trigger shows. */
  describedBy?: string | undefined;
  /** Where the focus goes when the list closes because a choice was made, in place of the trigger; used only while that element can take it. */
  focusAfterChoice?: RefObject<HTMLElement | null>;
  /** Called when a choice handed the focus to `focusAfterChoice`: what the page does with the next key there (an Esc, say) can depend on it. */
  onFocusHandedOver?: () => void;
  /**
   * More to choose beside the list, in the same layer (2026-11-14, after the model picker of T3 Code: the Harnesses, then the current one's models, then its thinking
   * levels). A choice in the list closes the layer and hands the keys to the message box, as ever; a choice beside it leaves the layer open, so the model and then
   * the level can be chosen one after the other. The focus going elsewhere closes it. On a narrow screen the list stands alone.
   */
  aside?: ReactNode;
  /** What the layer is placed against, in place of its trigger: the group the trigger is a part of, so a wide layer lines up with the group's edge. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find(option => option.value === value);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = options.filter(option => `${option.label} ${option.description ?? ""} ${option.group ?? ""}`.toLocaleLowerCase().includes(needle));
  const enabled = filtered.filter(option => !option.disabled);
  const active = enabled.find(option => option.value === activeValue) ?? enabled[0];
  const activeId = active ? `${listId}-${options.indexOf(active)}` : undefined;
  useEffect(() => { if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" }); }, [open, activeId]);
  // Opening, from the trigger or from a shortcut, starts with an empty search and the current choice active.
  const [wasOpen, setWasOpen] = useState(open);
  // Opened from elsewhere (a shortcut), it gives the focus back to where it was when it closes, not to its trigger.
  const triggerRef = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), returnTo = useRef<Element | null>(null), chosen = useRef(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setQuery(""); setActiveValue(value); chosen.current = false; const focused = document.activeElement; returnTo.current = focused !== triggerRef.current && focused !== document.body ? focused : null; }
  }
  const setOpen = (next: boolean) => { if (controlledOpen === undefined) setOwnOpen(next); onOpenChange?.(next); };
  /** The field the focus goes to for a choice, if it can take it now. */
  const target = (): HTMLElement | null => { const next = focusAfterChoice?.current; return next instanceof HTMLElement && next.isConnected && !(next as HTMLTextAreaElement).disabled ? next : null; };
  const choose = (option: PickerOption) => {
    if (option.disabled) return;
    chosen.current = true; onChange(option.value); setOpen(false);
    // The keys pressed next are the message: the focus is there at once, not when the list has finished closing (a key pressed meanwhile would land on the row just chosen).
    const next = target();
    next?.focus({ preventScroll: true });
    if (next !== null && document.activeElement === next) onFocusHandedOver?.();
  };
  const name = label.replace(/^选择/u, "");
  const large = size === "lg";
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { triggerRef.current = node; if (outerTrigger) outerTrigger.current = node; }, [outerTrigger]);
  return <BasePopover.Root open={open} onOpenChange={next => setOpen(next)}>
    <BasePopover.Trigger render={<button ref={setTrigger} type="button" aria-label={label} aria-describedby={describedBy} disabled={disabled} title={selected?.label ?? placeholder}
      className={cn("selection-trigger inline-flex h-[30px] max-w-[220px] min-w-0 items-center gap-1.5 rounded-row border-none bg-transparent px-2 text-ui-sm text-fg-2 transition-[color,background-color] duration-120 ease-standard hover:bg-subtle hover:text-fg disabled:opacity-45 data-[popup-open]:bg-subtle data-[popup-open]:text-fg",
        selected?.icon && !trigger && "font-medium text-fg", className)}/>}>
      {trigger ? trigger(selected) : <>
        {selected?.icon ? <span className="flex flex-none items-center">{selected.icon}</span> : null}
        <span className="min-w-0 truncate">{prefix ? <span className="text-fg-3">{prefix} </span> : null}{selected?.short ?? selected?.label ?? placeholder}</span>
      </>}
      {chevron ? <ChevronDown size={12} strokeWidth={2} className="flex-none text-fg-3" aria-hidden="true"/> : null}
    </BasePopover.Trigger>
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={8} collisionPadding={12} positionMethod="fixed" className="hh-positioner z-[55]" {...(anchor ? { anchor } : {})}>
        <BasePopover.Popup aria-label={label} initialFocus={search} ref={popup} finalFocus={() => {
          // Focus the user already moved elsewhere (into the message, say) stays there.
          const focused = document.activeElement;
          if (focused !== null && focused !== document.body && !popup.current?.contains(focused)) return false;
          const next = chosen.current ? target() : null;
          if (next !== null) { onFocusHandedOver?.(); return next; }
          return returnTo.current instanceof HTMLElement && returnTo.current.isConnected ? returnTo.current : true;
        }} onBlur={aside === undefined ? undefined : event => { const next = event.relatedTarget; if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false); }}
          className={cn("picker-popover surface-pop flex max-h-[min(460px,var(--available-height))] overflow-hidden", aside === undefined ? "flex-col" : "flex-row",
          aside !== undefined ? "w-[320px] sm:w-[760px]" : wide ? "w-[360px]" : "w-[320px]", "max-w-[calc(100vw-24px)]")}>
          <div className={cn("flex min-h-0 min-w-0 flex-col", aside === undefined ? "flex-1" : "w-[300px] flex-none max-sm:w-full")}>
          {title ? <div className="px-3.5 pt-2.5 text-caption text-fg-3">{title}</div> : null}
          <div className="flex items-center gap-2 px-3.5 py-1.5 hairline-b">
            <Search size={15} className="flex-none text-fg-3" aria-hidden="true"/>
            <input ref={search} className="h-8 min-w-0 flex-1 border-none bg-transparent text-ui-sm outline-none placeholder:text-placeholder" placeholder={`搜索${name}`} aria-label={`搜索${name}`} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} value={query}
              onChange={event => { setQuery(event.target.value); setActiveValue(null); }} onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault(); if (!enabled.length) return;
                  const current = enabled.findIndex(option => option.value === active?.value);
                  const next = enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length];
                  if (next) setActiveValue(next.value);
                } else if (event.key === "Enter") { event.preventDefault(); if (active) choose(active); }
              }}/>
          </div>
          <div className="scroll-area min-h-0 flex-1 p-[5px]" id={listId} role="listbox" aria-label={label}>
            {filtered.length ? filtered.map((option, index) => {
              const id = `${listId}-${options.indexOf(option)}`, describe = option.disabled && option.reason ? option.reason : option.description;
              return <div key={option.value}>
                {option.group && (index === 0 || filtered[index - 1]?.group !== option.group) ? <div className="px-2.5 pt-2 pb-1 text-caption font-medium text-fg-3">{option.group}</div> : null}
                <button type="button" id={id} role="option" aria-label={option.label} aria-describedby={[option.status ? `${id}-status` : "", describe ? `${id}-description` : ""].filter(Boolean).join(" ") || undefined}
                  aria-selected={value === option.value} disabled={option.disabled} aria-disabled={option.disabled ?? false}
                  onPointerMove={() => { if (!option.disabled) setActiveValue(option.value); }} onClick={() => choose(option)}
                  className={cn("picker-option flex w-full items-center gap-2.5 rounded-row border-none bg-transparent px-2.5 text-left outline-offset-[-2px] transition-[color,background-color] duration-120 ease-standard disabled:cursor-not-allowed disabled:opacity-55",
                    large ? "py-2" : "py-[7px]", active?.value === option.value && "is-active bg-subtle")}>
                  {option.icon ? <span className="flex flex-none items-center">{option.icon}</span> : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2"><strong className={cn("truncate font-medium", large ? "text-ui" : "text-ui-sm")}>{option.label}</strong>
                      {option.status ? <span id={`${id}-status`} className={cn("badge flex-none", TONES[option.status.tone])} title={option.status.title}><span className="dot" aria-hidden="true"/>{option.status.label}</span> : null}</span>
                    {describe ? <small id={`${id}-description`} className={cn("truncate text-caption", option.disabled ? "text-amber" : "text-fg-3")}>{describe}</small> : null}
                  </span>
                  <Check size={15} strokeWidth={2.2} className={cn("flex-none text-accent-text", value !== option.value && "invisible")} aria-hidden="true"/>
                </button>
              </div>;
            }) : <p className="m-0 px-3 py-6 text-center text-ui-sm text-fg-3">{options.length === 0 && empty !== undefined ? empty : "没有匹配的选项"}</p>}
          </div>
          <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-caption text-fg-3 hairline-t">{footer ?? <span>↑ ↓ 选择 · Enter 确认 · Esc 关闭</span>}</div>
          </div>
          {aside !== undefined ? <div className="picker-aside flex min-h-0 min-w-0 flex-1 hairline-l max-sm:hidden">{aside}</div> : null}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
