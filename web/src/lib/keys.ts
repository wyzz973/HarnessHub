import { useSyncExternalStore } from "react";

/*
 * The application's shortcuts that the user may give other keys (2026-11-14, after the keybindings of T3 Code): each is one chord of ⌘ (Ctrl elsewhere) with a key, and
 * maybe ⌥ or ⇧. They are matched by the key's place on the keyboard, since ⌥ and ⇧ change what a key types. The choices are this browser's; without storage they last
 * for the page only. The keys of the message box and of a waiting approval (⏎, ⇧⏎, ↑, esc, 1–9, ⌘⏎) belong to where they are typed and are not given other keys.
 */
export type KeyAction = "new" | "palette" | "shortcuts" | "nextWaiting" | "previous" | "next" | "sidebar" | "panel" | "picker" | "stop" | "terminal" | "find";
export interface Chord { readonly code: string; readonly alt: boolean; readonly shift: boolean }
export const KEY_ACTIONS: readonly { readonly id: KeyAction; readonly label: string; readonly group: "通用" | "对话" }[] = [
  { id: "new", label: "新对话", group: "通用" }, { id: "palette", label: "搜索与命令", group: "通用" }, { id: "nextWaiting", label: "下一件“等你处理”", group: "通用" },
  { id: "previous", label: "上一个对话", group: "通用" }, { id: "next", label: "下一个对话", group: "通用" }, { id: "sidebar", label: "收起或展开侧栏", group: "通用" },
  { id: "shortcuts", label: "全部快捷键", group: "通用" },
  { id: "picker", label: "换 Harness", group: "对话" }, { id: "stop", label: "停止当前回复", group: "对话" }, { id: "panel", label: "打开或收起详情面板", group: "对话" },
  { id: "terminal", label: "打开或收起终端", group: "对话" }, { id: "find", label: "在对话里查找", group: "对话" },
];
export const DEFAULT_KEYS: Readonly<Record<KeyAction, Chord>> = {
  new: { code: "KeyO", alt: false, shift: true }, palette: { code: "KeyK", alt: false, shift: false }, shortcuts: { code: "Slash", alt: false, shift: false },
  nextWaiting: { code: "ArrowDown", alt: true, shift: false }, previous: { code: "BracketLeft", alt: true, shift: false }, next: { code: "BracketRight", alt: true, shift: false },
  sidebar: { code: "KeyB", alt: false, shift: false }, panel: { code: "Backslash", alt: false, shift: false }, picker: { code: "KeyJ", alt: false, shift: false },
  stop: { code: "Period", alt: false, shift: false }, terminal: { code: "Backquote", alt: false, shift: false }, find: { code: "KeyF", alt: false, shift: false },
};
const KEY = "harnesshub:keys";
type Keys = Readonly<Record<KeyAction, Chord>>;
let held: Keys | null = null;
const listeners = new Set<() => void>();
const isChord = (value: unknown): value is Chord => typeof value === "object" && value !== null && typeof (value as Chord).code === "string" && (value as Chord).code.length < 32 && typeof (value as Chord).alt === "boolean" && typeof (value as Chord).shift === "boolean";
function read(): Keys {
  if (held !== null) return held;
  let chosen: Record<string, unknown> = {};
  try { const raw = localStorage.getItem(KEY), value: unknown = raw === null || raw.length > 4096 ? null : JSON.parse(raw); if (value !== null && typeof value === "object" && !Array.isArray(value)) chosen = value as Record<string, unknown>; } catch { /* the defaults */ }
  held = Object.fromEntries(KEY_ACTIONS.map(({ id }) => [id, isChord(chosen[id]) ? { code: (chosen[id] as Chord).code, alt: (chosen[id] as Chord).alt, shift: (chosen[id] as Chord).shift } : DEFAULT_KEYS[id]])) as Keys;
  return held;
}
function write(next: Keys): void {
  held = next;
  const chosen = Object.fromEntries(KEY_ACTIONS.flatMap(({ id }) => sameChord(next[id], DEFAULT_KEYS[id]) ? [] : [[id, next[id]]]));
  try { if (Object.keys(chosen).length === 0) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(chosen)); } catch { /* lasts for this page only */ }
  for (const listener of listeners) listener();
}
export const sameChord = (left: Chord, right: Chord): boolean => left.code === right.code && left.alt === right.alt && left.shift === right.shift;
/** The place on the keyboard of the key a character is typed with on a US layout, for an event that names the key it gives but not its place. */
const PLACES: Readonly<Record<string, string>> = { "/": "Slash", "\\": "Backslash", ".": "Period", ",": "Comma", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "`": "Backquote",
  "{": "BracketLeft", "}": "BracketRight", "?": "Slash", "|": "Backslash", "~": "Backquote" };
function placeOf(key: string): string {
  if (/^[a-z]$/iu.test(key)) return "Key" + key.toUpperCase();
  if (/^\d$/u.test(key)) return "Digit" + key;
  return PLACES[key] ?? (/^(Arrow(Up|Down|Left|Right)|Enter|Escape|Tab|Backspace|Delete|Space)$/u.test(key) ? key : "");
}
/**
 * The chord a key press is, when it is one: ⌘ or Ctrl held, and a key that is not itself a modifier. The key is known by its place (⌥ and ⇧ change what it types);
 * an event that says only what it types (a synthetic one, or a layout that reports no place) is known by the place that character has on a US layout.
 */
export function chordOf(event: Pick<KeyboardEvent, "code" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey"> & { readonly key?: string }): Chord | null {
  if (!(event.metaKey || event.ctrlKey) || /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/u.test(event.code)) return null;
  const code = event.code !== "" ? event.code : placeOf(event.key ?? "");
  return code === "" ? null : { code, alt: event.altKey, shift: event.shiftKey };
}
/** Which of the application's shortcuts a key press is, with the keys chosen now. */
export function actionOf(event: Pick<KeyboardEvent, "code" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey"> & { readonly key?: string }): KeyAction | null {
  const chord = chordOf(event);
  if (chord === null) return null;
  const keys = read();
  return KEY_ACTIONS.find(({ id }) => sameChord(keys[id], chord))?.id ?? null;
}
const NAMES: Readonly<Record<string, string>> = { Slash: "/", Backslash: "\\", Period: ".", Comma: ",", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "⏎", Space: "space", Backspace: "⌫", Delete: "⌦", Tab: "⇥", Escape: "esc" };
/** A chord as keycaps: ["⌥", "⌘", "["]. */
export function chordKeys(chord: Chord): readonly string[] {
  const key = NAMES[chord.code] ?? (/^Key[A-Z]$/u.test(chord.code) ? chord.code.slice(3) : /^Digit\d$/u.test(chord.code) ? chord.code.slice(5) : chord.code);
  return [...(chord.alt ? ["⌥"] : []), ...(chord.shift ? ["⇧"] : []), "⌘", key];
}
/** A shortcut's keys as one string beside a label: "⇧⌘O". */
export function keyText(action: KeyAction): string { return chordKeys(read()[action]).join(""); }
/** The value of `aria-keyshortcuts` for a shortcut: "Meta+Shift+O". */
export function ariaKeys(action: KeyAction): string { const chord = read()[action], key = chordKeys(chord).at(-1)!; return ["Meta", ...(chord.alt ? ["Alt"] : []), ...(chord.shift ? ["Shift"] : []), key.length === 1 ? key.toUpperCase() : chord.code].join("+"); }
/** Gives a shortcut other keys. Refused, with the shortcut that has them, when another one already has those keys. */
export function setKey(action: KeyAction, chord: Chord): { readonly taken: KeyAction } | null {
  const keys = read(), other = KEY_ACTIONS.find(({ id }) => id !== action && sameChord(keys[id], chord));
  if (other !== undefined) return { taken: other.id };
  write({ ...keys, [action]: chord });
  return null;
}
/** Gives a shortcut its own keys back; if another shortcut was given those meanwhile, that one goes back to its own too. */
export function resetKey(action: KeyAction): void {
  const keys = read(), mine = DEFAULT_KEYS[action], next: Record<KeyAction, Chord> = { ...keys, [action]: mine };
  for (const { id } of KEY_ACTIONS) if (id !== action && sameChord(next[id], mine)) next[id] = DEFAULT_KEYS[id];
  write(next);
}
/** The keys chosen now, kept current for a component. */
export function useKeys(): Keys { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, read); }
