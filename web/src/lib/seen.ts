import { useSyncExternalStore } from "react";

/**
 * What this browser has seen of each conversation: the place (`updatedSeq`) it stood at when it was last shown. A conversation that has moved on
 * since, and is not the one open, is unread in the sidebar. A convenience of this browser: without storage it lasts for the page only, and the first
 * time there is nothing remembered, everything listed counts as seen (so a list is never all unread).
 */
const KEY = "harnesshub:sidebar-seen", MOST = 2000;
type Seen = Readonly<Record<string, number>>;
let held: Seen | null = null, started = false;
const listeners = new Set<() => void>();

function read(): Seen {
  if (held !== null) return held;
  try {
    const raw = localStorage.getItem(KEY), value: unknown = raw === null || raw.length > 512 * 1024 ? null : JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) { started = true; held = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")); return held; }
  } catch { /* starts empty */ }
  held = {};
  return held;
}
function write(next: Seen): void {
  held = next; started = true;
  // The latest entries are enough to remember.
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(next).slice(-MOST)))); } catch { /* lasts for this page only */ }
  for (const listener of listeners) listener();
}
interface Row { readonly id: string; readonly updatedSeq: number }
/** Marks these conversations as seen where they stand now. `onlyNew`: only those nothing is remembered of (older ones the list reads in later). */
export function markSeen(rows: readonly Row[], onlyNew = false): void {
  const now = read(), next: Record<string, number> = { ...now };
  let changed = false;
  for (const row of rows) {
    const known = now[row.id];
    if (known === undefined ? true : !onlyNew && known < row.updatedSeq) { delete next[row.id]; next[row.id] = row.updatedSeq; changed = true; }
  }
  if (changed) write(next);
}
/** The first list this browser shows is all seen: called with every listed conversation, it remembers them only when nothing was remembered before. */
export function startSeen(rows: readonly Row[]): void { read(); if (!started) write(Object.fromEntries(rows.map(row => [row.id, row.updatedSeq]))); }
/** Whether a conversation has moved on since it was last seen here (one nothing is remembered of has). */
export function unseen(seen: Seen, row: Row): boolean { const known = seen[row.id]; return known === undefined || known < row.updatedSeq; }
/** What has been seen, kept current for a component. */
export function useSeen(): Seen {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, read);
}
