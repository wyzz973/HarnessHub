import { Popover as BasePopover } from "@base-ui/react/popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
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
const TONES = { success: "badge-green", warning: "badge-amber", danger: "badge-red" } as const;
/**
 * Searchable, keyboard-operated selection. Disabled choices stay visible with their actual reason. The trigger keeps the
 * accessible name `label`; it shows the selected choice, after `prefix` when given. Input-method composition never selects.
 */
export function SearchPicker({ label, value, placeholder, options, onChange, disabled = false, footer, prefix, className, wide = false, side = "top" }: {
  label: string; value: string; placeholder: string; options: readonly PickerOption[];
  onChange: (value: string) => void; disabled?: boolean; footer?: ReactNode; prefix?: string; className?: string; wide?: boolean; side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
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
  const choose = (option: PickerOption) => { if (option.disabled) return; onChange(option.value); setOpen(false); };
  const name = label.replace(/^选择/u, "");
  return <BasePopover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setActiveValue(value); } }}>
    <BasePopover.Trigger render={<button type="button" aria-label={label} disabled={disabled} title={selected?.label ?? placeholder}
      className={cn("selection-trigger inline-flex h-[30px] max-w-[220px] min-w-0 items-center gap-1.5 rounded-lg border-none bg-transparent px-2 text-[13px] text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-50 data-[popup-open]:bg-hover data-[popup-open]:text-fg", selected?.icon && "font-medium text-fg", className)}/>}>
      {selected?.icon ? <span className="flex flex-none items-center">{selected.icon}</span> : null}
      <span className="min-w-0 truncate">{prefix ? <span className="text-fg-3">{prefix} </span> : null}{selected?.short ?? selected?.label ?? placeholder}</span>
      <ChevronDown size={12} className="flex-none text-fg-3" aria-hidden="true"/>
    </BasePopover.Trigger>
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align="start" sideOffset={8} collisionPadding={12} positionMethod="fixed" className="hh-positioner z-[55]">
        <BasePopover.Popup aria-label={label} initialFocus={search} className={cn("picker-popover surface-pop flex max-h-[min(460px,var(--available-height))] flex-col overflow-hidden", wide ? "w-[400px]" : "w-[320px]", "max-w-[calc(100vw-24px)]")}>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={15} className="flex-none text-fg-3" aria-hidden="true"/>
            <input ref={search} className="h-7 min-w-0 flex-1 border-none bg-transparent text-[13.5px] outline-none placeholder:text-fg-3" placeholder={`搜索${name}`} aria-label={`搜索${name}`} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} value={query}
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
          <div className="scroll-area min-h-0 flex-1 p-1" id={listId} role="listbox" aria-label={label}>
            {filtered.length ? filtered.map((option, index) => {
              const id = `${listId}-${options.indexOf(option)}`, describe = option.disabled && option.reason ? option.reason : option.description;
              return <div key={option.value}>
                {option.group && (index === 0 || filtered[index - 1]?.group !== option.group) ? <div className="px-2.5 pt-2.5 pb-1 text-[11.5px] font-medium text-fg-3">{option.group}</div> : null}
                <button type="button" id={id} role="option" aria-label={option.label} aria-describedby={[option.status ? `${id}-status` : "", describe ? `${id}-description` : ""].filter(Boolean).join(" ") || undefined}
                  aria-selected={value === option.value} disabled={option.disabled} aria-disabled={option.disabled ?? false}
                  onPointerMove={() => { if (!option.disabled) setActiveValue(option.value); }} onClick={() => choose(option)}
                  className={cn("picker-option flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-55", active?.value === option.value && "is-active bg-hover")}>
                  {option.icon ? <span className="flex flex-none items-center">{option.icon}</span> : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2"><strong className="truncate text-[13px] font-medium">{option.label}</strong>
                      {option.status ? <span id={`${id}-status`} className={cn("badge flex-none", TONES[option.status.tone])} title={option.status.title}><span className="dot" aria-hidden="true"/>{option.status.label}</span> : null}</span>
                    {describe ? <small id={`${id}-description`} className={cn("truncate text-[12px]", option.disabled ? "text-amber" : "text-fg-3")}>{describe}</small> : null}
                  </span>
                  {value === option.value ? <Check size={15} className="flex-none text-accent" aria-hidden="true"/> : null}
                </button>
              </div>;
            }) : <p className="m-0 px-3 py-6 text-center text-[13px] text-fg-3">没有匹配的选项</p>}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11.5px] text-fg-3">{footer ?? <span>↑ ↓ 切换 · Enter 选择 · Esc 关闭</span>}</div>
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
