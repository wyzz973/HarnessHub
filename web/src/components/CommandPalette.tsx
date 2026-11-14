import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { chordKeys, chordOf, DEFAULT_KEYS, KEY_ACTIONS, resetKey, sameChord, setKey, useKeys, type KeyAction } from "../lib/keys.js";
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
/** A place the words were found in what was said (a message, or a title), from the Gateway's search of every conversation. */
export interface PaletteFound {
  readonly id: string;
  /** The text around the place; `match` is where the words are in it. */
  readonly label: string; readonly match?: readonly [number, number];
  readonly hint?: string; readonly icon?: ReactNode;
  readonly run: () => void;
}
/** Searches what was said in every conversation, a page at a time. */
export type PaletteSearch = (query: string, cursor: string | undefined, signal: AbortSignal) => Promise<{ readonly found: readonly PaletteFound[]; readonly next: string | null }>;
/** The words found, marked, with the text before them cut to a few characters so they stand in sight on one line. */
function marked(label: string, match: readonly [number, number] | undefined): ReactNode {
  if (match === undefined) return label;
  let [start, end] = match, text = label;
  if (start > 16) {
    let cut = start - 12;
    if (cut > 0 && /[\udc00-\udfff]/u.test(label[cut] ?? "")) cut--;
    text = "…" + label.slice(cut); start = start - cut + 1; end = end - cut + 1;
  }
  return <>{text.slice(0, start)}<mark className="palette-mark">{text.slice(start, end)}</mark>{text.slice(end)}</>;
}
/** Whether words are enough to search what was said for: two characters, or one that is not plain Latin (a Chinese character is a word). */
const searchable = (words: string): boolean => words.length >= 2 || /[^\x00-\x7f]/u.test(words);
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
  if (words.every(word => all.includes(word))) return label === query ? 0 : label.startsWith(query) ? 1 : label.includes(query) ? 2 : words.every(word => label.includes(word)) ? 3 : 4;
  // Typed loosely (after T3 Code's forgiving search): the letters in their order with others between them, starting where a word of the label starts — "cdx" finds
  // "用 Codex 开始新对话". Only for the actions and places, whose labels are short; a conversation's long title would answer almost anything. Last of all.
  return command.group !== "对话" && words.every(word => inOrder(word, label)) ? 5 : null;
}
/** Whether every character of `word` appears in `text` in the same order, the first at the start of one of its words. */
function inOrder(word: string, text: string): boolean {
  const first = [...word][0];
  if (first === undefined) return false;
  for (let start = text.indexOf(first); start >= 0; start = text.indexOf(first, start + 1)) {
    if (start > 0 && !/[\s\-_/·.(（]/u.test(text[start - 1]!)) continue;
    let at = start + first.length, ok = true;
    for (const character of [...word].slice(1)) { at = text.indexOf(character, at); if (at < 0) { ok = false; break; } at += character.length; }
    if (ok) return true;
  }
  return false;
}
const USED_KEY = "harnesshub:palette-used";
/** How often and how lately each command was run from the palette in this browser: a tie between equal matches goes to the one used more, and lately. */
function readUsed(): Readonly<Record<string, { readonly count: number; readonly at: number }>> {
  try { const value: unknown = JSON.parse(localStorage.getItem(USED_KEY) ?? "{}"); return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, { count: number; at: number }> : {}; } catch { return {}; }
}
function noteUsed(id: string): void {
  try {
    const used = { ...readUsed() }, was = used[id];
    delete used[id]; used[id] = { count: (was?.count ?? 0) + 1, at: Date.now() };
    localStorage.setItem(USED_KEY, JSON.stringify(Object.fromEntries(Object.entries(used).slice(-300))));
  } catch { /* lasts for this page only */ }
}
/** A command's standing from its use: each use counts, and a use within the last week counts double. */
function frecency(entry: { readonly count: number; readonly at: number } | undefined, now: number): number { return entry === undefined ? 0 : entry.count * (now - entry.at < 7 * 86_400_000 ? 2 : 1); }
/**
 * ⌘K (Linear and Raycast on the Direction board): one search over conversations, places and actions, each with its
 * shortcut beside it. The best matches lead, still grouped; ↑ ↓ move, ⏎ runs the highlighted one, esc closes.
 * Composition never runs a command. A chosen command runs once the palette has closed, so a dialog or popover it opens
 * gets the keyboard from the start; `onClosed` reports each completed close the same way.
 */
export function CommandPalette({ open, onOpenChange, commands, onClosed, search }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly commands: readonly PaletteCommand[]; readonly onClosed?: () => void;
  /** Searches what was said in every conversation; its places follow the commands. */
  readonly search?: PaletteSearch | undefined }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null), chosen = useRef<{ readonly run: () => void } | null>(null);
  // What was said, searched a moment after typing stops (not for ">", the actions alone): the places follow the commands, a page at a time.
  const searcher = useRef(search); searcher.current = search;
  const [found, setFound] = useState<{ readonly words: string; readonly items: readonly PaletteFound[]; readonly next: string | null } | null>(null), [searching, setSearching] = useState(false);
  const words = query.trimStart().startsWith(">") ? "" : query.trim(), canSearch = search !== undefined;
  useEffect(() => {
    const read = searcher.current;
    if (!open || read === undefined || !searchable(words)) { setFound(null); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      read(words, undefined, controller.signal).then(page => { if (!controller.signal.aborted) setFound({ words, items: page.found, next: page.next }); },
        () => { if (!controller.signal.aborted) setFound({ words, items: [], next: null }); }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, words, canSearch]);
  const readMore = () => {
    const read = searcher.current, from = found;
    if (read === undefined || from === null || from.next === null || searching) return;
    setSearching(true);
    read(from.words, from.next, new AbortController().signal).then(page => setFound(now => now !== null && now.words === from.words ? { words: now.words, items: [...now.items, ...page.found.filter(item => !now.items.some(known => known.id === item.id))], next: page.next } : now), () => undefined)
      .finally(() => setSearching(false));
  };
  const listId = useId();
  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  const filtered = useMemo(() => {
    // ">" first: the actions alone, without the conversations and places (after T3 Code).
    const actionsOnly = query.trimStart().startsWith(">"), text = actionsOnly ? query.trimStart().slice(1) : query;
    const words = text.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean), used = readUsed(), now = Date.now();
    const scored = commands.flatMap((command, index) => {
      if (actionsOnly && (command.group === "对话" || command.group === "前往")) return [];
      const score = rank(command, words);
      return score === null ? [] : [{ command, index: words.length ? index - frecency(used[command.id], now) * 1000 : index, score }];
    });
    // Groups follow their best match; inside a group, the better match first, then the original order.
    const best = new Map<string, { readonly score: number; readonly index: number }>();
    for (const item of scored) { const seen = best.get(item.command.group); if (!seen || item.score < seen.score) best.set(item.command.group, { score: item.score, index: Math.min(item.index, seen?.index ?? item.index) }); }
    const groupOrder = (group: string) => best.get(group)!;
    return scored.sort((a, b) => groupOrder(a.command.group).score - groupOrder(b.command.group).score || groupOrder(a.command.group).index - groupOrder(b.command.group).index || a.score - b.score || a.index - b.index)
      .map(item => item.command);
  }, [commands, query]);
  // The places found follow the commands; a conversation the commands already list by its title is not listed again.
  const places = found !== null && found.words === words ? found.items.filter(item => !filtered.some(command => command.id === item.id)) : [];
  type Row = { readonly kind: "command"; readonly command: PaletteCommand } | { readonly kind: "found"; readonly found: PaletteFound } | { readonly kind: "more" };
  const rows: readonly Row[] = [...filtered.map(command => ({ kind: "command" as const, command })), ...places.map(place => ({ kind: "found" as const, found: place })),
    ...(found !== null && found.words === words && found.next !== null ? [{ kind: "more" as const }] : [])];
  const current = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => { document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" }); }, [current, listId]);
  const run = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "more") { readMore(); return; }
    if (row.kind === "command") noteUsed(row.command.id);
    chosen.current = row.kind === "command" ? row.command : row.found; onOpenChange(false);
  };
  const closed = (opened: boolean) => { if (opened) return; const command = chosen.current; chosen.current = null; command?.run(); onClosed?.(); };
  return <BaseDialog.Root open={open} onOpenChange={next => onOpenChange(next)} onOpenChangeComplete={closed}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="backdrop z-[60]"/>
      <BaseDialog.Popup initialFocus={input} className="palette-pop z-[61] flex max-h-[min(560px,calc(100dvh-16vh-24px))] w-[min(640px,calc(100vw-24px))] flex-col overflow-hidden" aria-label="搜索与命令">
        <BaseDialog.Title className="sr-only">搜索与命令</BaseDialog.Title>
        <div className="flex h-[52px] flex-none items-center gap-2.5 hairline-b pr-3 pl-4">
          <Search size={18} className="flex-none text-fg-3" aria-hidden="true"/>
          <input ref={input} className="h-full min-w-0 flex-1 border-none bg-transparent text-[15px] text-fg outline-none placeholder:text-placeholder" placeholder={canSearch ? "搜索对话、消息、页面或操作…" : "搜索对话、页面或操作…"} aria-label={canSearch ? "搜索对话、消息、页面或操作" : "搜索对话、页面或操作"}
            role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={rows.length ? `${listId}-${current}` : undefined} value={query} autoComplete="off" spellCheck={false}
            onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (rows.length) setActive((current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length); }
              else if (event.key === "Enter") { event.preventDefault(); run(rows[current]); }
            }}/>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5" id={listId} role="listbox" aria-label="搜索结果">
          {rows.length ? rows.map((row, index) => {
            const option = cn("flex min-h-9 w-full items-center gap-2.5 rounded-row border-none bg-transparent px-2.5 py-1.5 text-left text-ui text-fg", index === current && "bg-subtle");
            const pointer = { id: `${listId}-${index}`, role: "option", "aria-selected": index === current, tabIndex: -1, onPointerMove: () => { if (index !== current) setActive(index); }, onClick: () => run(row) } as const;
            const before = rows[index - 1];
            if (row.kind === "more") return <button key="more" type="button" {...pointer} className={cn(option, "text-fg-2")}><span className="w-5 flex-none" aria-hidden="true"/><span className="min-w-0 flex-1 trunc">{searching ? "正在读取…" : "显示更多消息"}</span></button>;
            if (row.kind === "found") return <Fragment key={"found:" + row.found.id}>
              {before?.kind !== "found" ? <div className="px-2.5 pt-2.5 pb-1 text-caption font-medium text-fg-3" role="presentation">消息</div> : null}
              <button type="button" {...pointer} className={option}>
                {row.found.icon ? <span className="flex w-5 flex-none justify-center text-fg-2" aria-hidden="true">{row.found.icon}</span> : null}
                <span className="min-w-0 flex-1 trunc">{marked(row.found.label, row.found.match)}</span>{row.found.hint ? <span className="max-w-[40%] flex-none trunc text-caption text-fg-3">{row.found.hint}</span> : null}
              </button></Fragment>;
            const command = row.command;
            return <Fragment key={command.id}>
              {before?.kind !== "command" || before.command.group !== command.group ? <div className="px-2.5 pt-2.5 pb-1 text-caption font-medium text-fg-3" role="presentation">{command.group}</div> : null}
              <button type="button" {...pointer} className={option}>
                {command.icon ? <span className="flex w-5 flex-none justify-center text-fg-2" aria-hidden="true">{command.icon}</span> : null}
                <span className="min-w-0 flex-1 trunc">{command.label}</span>{command.hint ? <span className="max-w-[40%] flex-none trunc text-caption text-fg-3">{command.hint}</span> : null}
                {command.shortcut ? <Keys keys={shortcutKeys(command.shortcut)}/> : null}
              </button></Fragment>;
          }) : <p className="m-0 px-3 py-8 text-center text-ui-sm text-fg-3">{searching ? "正在搜索…" : "没有匹配的结果"}</p>}
          {rows.length > 0 && searching && (found === null || found.words !== words) ? <p className="m-0 flex items-center gap-2 px-2.5 pt-2.5 pb-1.5 text-caption text-fg-3" role="status">正在搜索消息…</p> : null}
        </div>
        {/* The keys that work here, said once at the foot (after the palette of T3 Code). */}
        <div className="palette-keys flex h-9 flex-none items-center gap-4 hairline-t px-4 text-caption text-fg-3" aria-hidden="true">
          <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>移动</span><span className="flex items-center gap-1.5"><Kbd>⏎</Kbd>打开</span><span className="flex items-center gap-1.5"><Kbd>esc</Kbd>关闭</span>
        </div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}

/** One action and its keys; `range` reads "1 – 9", `or` is another way to do the same, such as esc in the composer. `action`: one whose keys the user may change. */
interface ShortcutRow { readonly label: string; readonly keys: readonly string[]; readonly range?: boolean; readonly or?: readonly string[]; readonly action?: KeyAction }
const chosen = (id: KeyAction): ShortcutRow => ({ label: KEY_ACTIONS.find(row => row.id === id)!.label, keys: [], action: id });
/**
 * Every shortcut of the page (Interaction board, "键盘优先"; ADR-054 §5), in the board's words. The application handles
 * the first group; the conversation's composer, approval dock and details panel handle the others. The browser keeps
 * ⌘N, ⌘T and ⌘W, so HarnessHub takes none of them, and a lasting approval option has no key at all.
 */
export const SHORTCUT_GROUPS: readonly { readonly title: string; readonly rows: readonly ShortcutRow[] }[] = [
  { title: "通用", rows: [chosen("new"), chosen("palette"), chosen("nextWaiting"), chosen("previous"), chosen("next"), { label: "第 1–9 个对话", keys: ["⌥⌘1", "⌥⌘9"], range: true },
    chosen("sidebar"), { label: "撤销侧栏操作", keys: ["⌘", "Z"] }, chosen("shortcuts"), { label: "关闭", keys: ["esc"] }] },
  { title: "对话", rows: [
    { label: "发送", keys: ["⏎"] }, { label: "换行", keys: ["⇧", "⏎"] }, chosen("picker"), chosen("model"), chosen("effort"), chosen("permission"), { ...chosen("stop"), or: ["esc"] }, chosen("panel"), chosen("terminal"), chosen("find"),
    { label: "选第一个建议回答", keys: ["⌘", "⏎"] }, { label: "编辑上一条", keys: ["↑"] }, { label: "命令 · 引用文件", keys: ["/", "@"] },
  ] },
  { title: "审批", rows: [
    { label: "允许一次", keys: ["⏎"] }, { label: "拒绝", keys: ["esc"] }, { label: "选第几个选项", keys: ["1", "9"], range: true },
  ] },
];
/**
 * The keys of a shortcut the user may change, as a control (the settings): pressing it listens for the next chord — ⌘ with a key, and ⌥ or ⇧ if wanted — and takes it;
 * Escape leaves the keys as they were. A chord another shortcut has is refused, with that shortcut's name. Beside it, the way back to its own keys once they differ.
 */
function KeyRecorder({ action }: { readonly action: KeyAction }) {
  const keys = useKeys(), [listening, setListening] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const changed = !sameChord(keys[action], DEFAULT_KEYS[action]);
  return <span className="flex flex-none items-center gap-2">
    {problem ? <span className="text-caption text-red" role="status">{problem}</span> : null}
    {changed && !listening ? <button type="button" className="link-btn text-caption" onClick={() => { resetKey(action); setProblem(null); }}>恢复</button> : null}
    <button type="button" className={cn("key-recorder flex min-h-7 items-center gap-[3px] rounded-row border-none bg-transparent px-1.5 hover:bg-subtle", listening && "bg-subtle shadow-focus")} aria-label={"更改“" + KEY_ACTIONS.find(row => row.id === action)!.label + "”的快捷键"}
      onClick={() => { setListening(true); setProblem(null); }} onBlur={() => setListening(false)}
      onKeyDown={event => {
        if (!listening) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") { setListening(false); return; }
        const chord = chordOf(event.nativeEvent);
        if (chord === null) { if (!/^(Meta|Control|Alt|Shift)/u.test(event.code)) setProblem("要带 ⌘"); return; }
        const refused = setKey(action, chord);
        if (refused !== null) { setProblem("“" + KEY_ACTIONS.find(row => row.id === refused.taken)!.label + "”在用"); return; }
        setProblem(null); setListening(false);
      }}>
      {listening ? <span className="px-1 text-caption text-fg-2">按下新的组合键</span> : chordKeys(keys[action]).map((key, index) => <Kbd key={index}>{key}</Kbd>)}
    </button>
  </span>;
}
/** The shortcut groups as rows of words and keycaps; used by the ⌘/ sheet and the settings, where (`editable`) the ones that are given other keys are changed in place. */
export function ShortcutList({ className, editable = false }: { readonly className?: string; readonly editable?: boolean }) {
  const id = useId(), keys = useKeys();
  return <div className={cn("flex flex-col gap-4", className)}>{SHORTCUT_GROUPS.map((group, index) => <div key={group.title} className="flex flex-col" role="group" aria-labelledby={`${id}-${index}`}>
    <h3 id={`${id}-${index}`} className="m-0 px-1 pb-1 text-caption font-medium text-fg-3">{group.title}</h3>
    <dl className="m-0 flex flex-col">{group.rows.map(row => { const shown = row.action === undefined ? row.keys : chordKeys(keys[row.action]); return <div key={row.label} className="flex min-h-9 items-center gap-3 hairline-b px-1 last:border-b-0">
      <dt className="min-w-0 flex-1 text-ui-sm text-fg">{row.label}</dt>
      <dd className="m-0 flex flex-none items-center gap-[3px]">{editable && row.action !== undefined ? <KeyRecorder action={row.action}/> : row.range ? <><Kbd>{shown[0]}</Kbd><span className="px-0.5 text-caption text-fg-3">–</span><Kbd>{shown[1]}</Kbd></> : shown.map((key, index) => <Kbd key={index}>{key}</Kbd>)}
        {row.or ? <><span className="px-1 text-caption text-fg-3">或</span>{row.or.map((key, index) => <Kbd key={"or-" + index}>{key}</Kbd>)}</> : null}</dd>
    </div>; })}</dl>
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
