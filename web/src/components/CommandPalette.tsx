import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { Kbd } from "../ui/primitives.js";

export interface PaletteCommand {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly keywords?: string;
  /** Its shortcut as written on the keys, such as "⇧⌘O" or "⌥⌘↓"; each key is drawn as its own cap. */
  readonly shortcut?: string;
  readonly run: () => void;
}
/** The caps of a written shortcut: modifiers and symbols one by one, a word such as "esc" whole. */
export function shortcutKeys(shortcut: string): readonly string[] { return shortcut.match(/[A-Za-z]{2,}|\S/gu) ?? []; }
function Keys({ keys, className }: { readonly keys: readonly string[]; readonly className?: string }) {
  return <span className={cn("flex flex-none items-center gap-[3px]", className)}>{keys.map((key, index) => <Kbd key={index}>{key}</Kbd>)}</span>;
}

/**
 * How well a command answers the words typed: every word must appear in its label, hint, keywords or group; then an
 * exact label comes first, a label that starts with the words next, then one that contains them, then the rest.
 */
function rank(command: PaletteCommand, words: readonly string[]): number | null {
  if (!words.length) return 0;
  const label = command.label.toLocaleLowerCase(), all = `${label} ${command.hint ?? ""} ${command.keywords ?? ""} ${command.group}`.toLocaleLowerCase(), query = words.join(" ");
  if (!words.every(word => all.includes(word))) return null;
  return label === query ? 0 : label.startsWith(query) ? 1 : label.includes(query) ? 2 : words.every(word => label.includes(word)) ? 3 : 4;
}
/**
 * ⌘K (Linear and Raycast on the Direction board): one search over conversations, places and actions, each with its
 * shortcut beside it. The best matches lead, still grouped; ↑ ↓ move, ⏎ runs the highlighted one, esc closes.
 * Composition never runs a command. A chosen command runs once the palette has closed, so a dialog or popover it opens
 * gets the keyboard from the start; `onClosed` reports each completed close the same way.
 */
export function CommandPalette({ open, onOpenChange, commands, onClosed }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly commands: readonly PaletteCommand[]; readonly onClosed?: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null), chosen = useRef<PaletteCommand | null>(null);
  const listId = useId();
  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const scored = commands.flatMap((command, index) => { const score = rank(command, words); return score === null ? [] : [{ command, index, score }]; });
    // Groups follow their best match; inside a group, the better match first, then the original order.
    const best = new Map<string, { readonly score: number; readonly index: number }>();
    for (const item of scored) { const seen = best.get(item.command.group); if (!seen || item.score < seen.score) best.set(item.command.group, { score: item.score, index: Math.min(item.index, seen?.index ?? item.index) }); }
    const groupOrder = (group: string) => best.get(group)!;
    return scored.sort((a, b) => groupOrder(a.command.group).score - groupOrder(b.command.group).score || groupOrder(a.command.group).index - groupOrder(b.command.group).index || a.score - b.score || a.index - b.index)
      .slice(0, 60).map(item => item.command);
  }, [commands, query]);
  const current = Math.min(active, Math.max(0, filtered.length - 1));
  useEffect(() => { document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" }); }, [current, listId]);
  const run = (command: PaletteCommand | undefined) => { if (!command) return; chosen.current = command; onOpenChange(false); };
  const closed = (opened: boolean) => { if (opened) return; const command = chosen.current; chosen.current = null; command?.run(); onClosed?.(); };
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)} onOpenChangeComplete={closed}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup initialFocus={input} className="palette-pop z-[61] flex max-h-[min(560px,calc(100dvh-16vh-24px))] w-[min(640px,calc(100vw-24px))] flex-col overflow-hidden" aria-label="搜索与命令">
        <BaseDialog.Title className="sr-only">搜索与命令</BaseDialog.Title>
        <div className="flex h-[52px] flex-none items-center gap-2.5 hairline-b pr-3 pl-4">
          <Search size={18} className="flex-none text-fg-3" aria-hidden="true"/>
          <input ref={input} className="h-full min-w-0 flex-1 border-none bg-transparent text-[15px] text-fg outline-none placeholder:text-placeholder" placeholder="搜索对话、页面或操作…" aria-label="搜索对话、页面或操作"
            role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={filtered.length ? `${listId}-${current}` : undefined} value={query} autoComplete="off" spellCheck={false}
            onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (filtered.length) setActive((current + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length); }
              else if (event.key === "Enter") { event.preventDefault(); run(filtered[current]); }
            }}/>
          <Kbd>esc</Kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5" id={listId} role="listbox" aria-label="搜索结果">
          {filtered.length ? filtered.map((command, index) => <Fragment key={command.id}>
            {index === 0 || filtered[index - 1]?.group !== command.group ? <div className="px-2.5 pt-2.5 pb-1 text-caption font-medium text-fg-3" role="presentation">{command.group}</div> : null}
            <button type="button" id={`${listId}-${index}`} role="option" aria-selected={index === current} tabIndex={-1} onPointerMove={() => { if (index !== current) setActive(index); }} onClick={() => run(command)}
              className={cn("flex min-h-9 w-full items-center gap-2.5 rounded-row border-none bg-transparent px-2.5 py-1.5 text-left text-ui text-fg", index === current && "bg-subtle")}>
              {command.icon ? <span className="flex w-5 flex-none justify-center text-fg-2" aria-hidden="true">{command.icon}</span> : null}
              <span className="min-w-0 flex-1 trunc">{command.label}</span>{command.hint ? <span className="max-w-[40%] flex-none trunc text-caption text-fg-3">{command.hint}</span> : null}
              {command.shortcut ? <Keys keys={shortcutKeys(command.shortcut)}/> : null}
            </button></Fragment>) : <p className="m-0 px-3 py-8 text-center text-ui-sm text-fg-3">没有匹配的结果</p>}
        </div>
        <div className="flex flex-none items-center gap-3 hairline-t px-4 py-2 text-caption text-fg-3"><span>↑↓ 选择</span><span>⏎ 打开</span><span>esc 关闭</span><span className="flex-1"/><span>⌘/ 全部快捷键</span></div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}

/** One action and its keys; `range` reads "1 – 9", `or` is another way to do the same, such as esc in the composer. */
interface ShortcutRow { readonly label: string; readonly keys: readonly string[]; readonly range?: boolean; readonly or?: readonly string[] }
/**
 * Every shortcut of the page (Interaction board, "键盘优先"; ADR-054 §5), in the board's words. The application handles
 * the first group; the conversation's composer, approval dock and details panel handle the others. The browser keeps
 * ⌘N, ⌘T and ⌘W, so HarnessHub takes none of them, and a lasting approval option has no key at all.
 */
export const SHORTCUT_GROUPS: readonly { readonly title: string; readonly rows: readonly ShortcutRow[] }[] = [
  { title: "通用", rows: [
    { label: "新对话", keys: ["⇧", "⌘", "O"] }, { label: "搜索与命令", keys: ["⌘", "K"] }, { label: "下一件“等你处理”", keys: ["⌥", "⌘", "↓"] },
    { label: "收起或展开侧栏", keys: ["⌘", "B"] }, { label: "全部快捷键", keys: ["⌘", "/"] }, { label: "关闭弹出层", keys: ["esc"] },
  ] },
  { title: "对话", rows: [
    { label: "发送；回复进行中时先暂存下一条", keys: ["⏎"] }, { label: "换行", keys: ["⇧", "⏎"] }, { label: "换 Harness", keys: ["⌘", "J"] }, { label: "停止当前回复", keys: ["⌘", "."], or: ["esc"] },
    { label: "打开或收起详情面板", keys: ["⌘", "\\"] }, { label: "编辑上一条（输入框为空时）", keys: ["↑"] }, { label: "原生命令 · 引用文件", keys: ["/", "@"] },
  ] },
  { title: "审批停在输入框时", rows: [
    { label: "允许一次", keys: ["⏎"] }, { label: "拒绝这次请求", keys: ["esc"] }, { label: "选择一次性选项", keys: ["1", "9"], range: true },
  ] },
];
/** The shortcut groups as rows of words and keycaps; used by the ⌘/ sheet and the settings page. */
export function ShortcutList({ className }: { readonly className?: string }) {
  const id = useId();
  return <div className={cn("flex flex-col gap-4", className)}>{SHORTCUT_GROUPS.map((group, index) => <div key={group.title} className="flex flex-col" role="group" aria-labelledby={`${id}-${index}`}>
    <h3 id={`${id}-${index}`} className="m-0 px-1 pb-1 text-caption font-medium text-fg-3">{group.title}</h3>
    <dl className="m-0 flex flex-col">{group.rows.map(row => <div key={row.label} className="flex min-h-9 items-center gap-3 hairline-b px-1 last:border-b-0">
      <dt className="min-w-0 flex-1 text-ui-sm text-fg">{row.label}</dt>
      <dd className="m-0 flex flex-none items-center gap-[3px]">{row.range ? <><Kbd>{row.keys[0]}</Kbd><span className="px-0.5 text-caption text-fg-3">–</span><Kbd>{row.keys[1]}</Kbd></> : row.keys.map((key, index) => <Kbd key={index}>{key}</Kbd>)}
        {row.or ? <><span className="px-1 text-caption text-fg-3">或</span>{row.or.map((key, index) => <Kbd key={"or-" + index}>{key}</Kbd>)}</> : null}</dd>
    </div>)}</dl>
  </div>)}</div>;
}
/**
 * ⌘/: the sheet of every shortcut, with what the browser keeps and what has no key; a centered dialog like the others
 * (overlay.tsx), which also reports when its close has completed, so whatever replaces it opens after it.
 */
export function ShortcutsDialog({ open, onOpenChange, onClosed }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onClosed?: () => void }) {
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)} onOpenChangeComplete={opened => { if (!opened) onClosed?.(); }}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup className="dialog-pop z-[61] flex w-[min(520px,calc(100vw-32px))] flex-col">
        <div className="px-5 pt-5"><BaseDialog.Title className="m-0 text-panel">快捷键</BaseDialog.Title></div>
        <ShortcutList className="px-4 pt-4"/>
        <p className="m-0 px-5 pt-3 pb-5 text-caption text-fg-3">浏览器保留 ⌘N、⌘T、⌘W，所以不占用它们。“这个对话都允许”不绑快捷键，只能点选。</p>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}
