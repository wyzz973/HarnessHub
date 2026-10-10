import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly description?: string;
  readonly group?: string;
  readonly disabled?: boolean;
  readonly reason?: string;
}
/** Searchable, keyboard-operated selection. Disabled choices stay visible with their actual reason. */
export function SearchPicker({ label, value, placeholder, options, onChange, disabled = false, footer }: {
  label: string; value: string; placeholder: string; options: readonly PickerOption[];
  onChange: (value: string) => void; disabled?: boolean; footer?: ReactNode;
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
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setActiveValue(value); } }}>
    <Popover.Trigger asChild><button type="button" className={`selection-trigger ${selected ? "has-selection" : ""}`} aria-label={label} disabled={disabled} title={selected?.label ?? placeholder}>
      {selected?.icon ? <span className="selection-trigger-icon">{selected.icon}</span> : null}<span className="selection-trigger-copy"><small>{label.replace(/^选择/u, "")}</small><strong>{selected?.label ?? placeholder}</strong></span><ChevronDown size={14} aria-hidden="true"/>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="picker-popover" align="start" sideOffset={8} collisionPadding={16} aria-label={label} onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}>
      <div className="picker-search"><Search size={16} aria-hidden="true"/><input ref={search} placeholder={`搜索${label.replace(/^选择/u, "")}`} aria-label={`搜索${label.replace(/^选择/u, "")}`} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} value={query} onChange={event => { setQuery(event.target.value); setActiveValue(null); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); if (!enabled.length) return;
          const current = enabled.findIndex(option => option.value === active?.value);
          const next = enabled[(current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length];
          if (next) setActiveValue(next.value);
        } else if (event.key === "Enter") { event.preventDefault(); if (active) choose(active); }
      }}/></div>
      <div className="picker-options" id={listId} role="listbox" aria-label={label}>
        {filtered.length ? filtered.map((option, index) => <div className="picker-option-wrap" key={option.value}>
          {option.group && (index === 0 || filtered[index - 1]?.group !== option.group) ? <div className="picker-group">{option.group}</div> : null}
          <button type="button" className={`picker-option ${active?.value === option.value ? "is-active" : ""}`} id={`${listId}-${options.indexOf(option)}`} role="option" aria-label={option.label} aria-describedby={option.description || option.reason ? `${listId}-${options.indexOf(option)}-description` : undefined} aria-selected={value === option.value} disabled={option.disabled} aria-disabled={option.disabled ?? false} onPointerMove={() => { if (!option.disabled) setActiveValue(option.value); }} onClick={() => choose(option)}>
            {option.icon ? <span className="picker-option-icon">{option.icon}</span> : null}<span className="picker-option-copy"><strong>{option.label}</strong>{option.disabled && option.reason ? <small id={`${listId}-${options.indexOf(option)}-description`} className="picker-reason">{option.reason}</small> : option.description ? <small id={`${listId}-${options.indexOf(option)}-description`}>{option.description}</small> : null}</span>{value === option.value ? <Check size={15} className="picker-check" aria-hidden="true"/> : null}
          </button>
        </div>) : <p className="picker-empty">没有匹配的选项</p>}
      </div>
      <div className="picker-footer">{footer ?? <span>↑ ↓ 切换 · Enter 选择 · Esc 关闭</span>}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
