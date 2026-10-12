import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { Dialog } from "../ui/overlay.js";
import { Kbd } from "../ui/primitives.js";

export interface PaletteCommand {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly keywords?: string;
  readonly shortcut?: string;
  readonly run: () => void;
}
/** ⌘K: one search over conversations, places and actions; Enter runs the highlighted one. Composition never runs a command. */
export function CommandPalette({ open, onOpenChange, commands }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly commands: readonly PaletteCommand[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => commands.filter(command => !needle || `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""} ${command.group}`.toLocaleLowerCase().includes(needle)).slice(0, 60), [commands, needle]);
  const current = Math.min(active, Math.max(0, filtered.length - 1));
  useEffect(() => { document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" }); }, [current, listId]);
  const run = (command: PaletteCommand | undefined) => { if (!command) return; onOpenChange(false); command.run(); };
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup initialFocus={input} className="palette-pop z-[61] flex w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden" aria-label="搜索与命令">
        <BaseDialog.Title className="sr-only">搜索与命令</BaseDialog.Title>
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search size={17} className="flex-none text-fg-3" aria-hidden="true"/>
          <input ref={input} className="h-7 min-w-0 flex-1 border-none bg-transparent text-[15px] outline-none placeholder:text-fg-3" placeholder="搜索对话、页面或操作…" aria-label="搜索对话、页面或操作" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={filtered.length ? `${listId}-${current}` : undefined} value={query}
            onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (filtered.length) setActive((current + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length); }
              else if (event.key === "Enter") { event.preventDefault(); run(filtered[current]); }
            }}/>
          <Kbd>Esc</Kbd>
        </div>
        <div className="scroll-area max-h-[min(440px,56vh)] p-1.5" id={listId} role="listbox" aria-label="搜索结果">
          {filtered.length ? filtered.map((command, index) => <div key={command.id}>
            {index === 0 || filtered[index - 1]?.group !== command.group ? <div className="px-2.5 pt-2.5 pb-1 text-[11.5px] font-medium text-fg-3">{command.group}</div> : null}
            <button type="button" id={`${listId}-${index}`} role="option" aria-selected={index === current} onPointerMove={() => setActive(index)} onClick={() => run(command)}
              className={cn("flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2.5 py-2 text-left text-[13.5px]", index === current && "bg-hover")}>
              {command.icon ? <span className="flex w-5 flex-none justify-center text-fg-2" aria-hidden="true">{command.icon}</span> : null}
              <span className="min-w-0 flex-1 truncate">{command.label}</span>{command.hint ? <span className="flex-none truncate text-[12px] text-fg-3">{command.hint}</span> : null}
              {command.shortcut ? <Kbd>{command.shortcut}</Kbd> : null}
            </button></div>) : <p className="m-0 px-3 py-8 text-center text-[13px] text-fg-3">没有匹配的结果</p>}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-fg-3"><span>↑ ↓ 选择</span><span>Enter 打开</span><span className="flex-1"/><span>⌘/ 快捷键</span></div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}
const SHORTCUTS: readonly (readonly [string, string])[] = [["新对话", "⇧⌘O"], ["搜索与命令", "⌘K"], ["快捷键表", "⌘/"], ["显示或隐藏详情栏", "⌘."], ["收起或展开侧栏", "⌘B"], ["发送", "Enter"], ["换行", "Shift Enter"], ["回复进行中暂存下一条", "Enter"], ["停止当前回复（输入框中）", "Esc"], ["审批卡片上选择一次性选项", "1–9"]];
export function ShortcutsDialog({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange} title="快捷键" description="在 macOS 上用 ⌘，在 Windows 与 Linux 上用 Ctrl。">
    <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 px-5 pt-4 pb-5 text-[13px]">{SHORTCUTS.map(([label, keys]) => <div key={label} className="contents"><dt className="text-fg-2">{label}</dt><dd className="m-0 flex justify-end gap-1">{keys.split(" ").map(key => <Kbd key={key}>{key}</Kbd>)}</dd></div>)}</dl>
  </Dialog>;
}
