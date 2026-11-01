import { useCallback, useEffect, useState } from "react";
import type { HarnessView } from "../../../src/contracts/web.js";

/**
 * Per-browser display preferences (ADR-042). They are conveniences only: storage can be unavailable, in which case each
 * page starts from the defaults. Nothing here changes a conversation, a Harness or the Gateway.
 */
export interface Preferences {
  /** "system" follows the operating system's appearance. */
  readonly theme: "system" | "light" | "dark";
  /** How much of each Turn's process shows by default: one summary line, or every step. */
  readonly density: "compact" | "detailed";
  /** Whether the details panel stands beside a conversation on wide screens: closed until the user opens it (ADR-054 decision E). */
  readonly panel: boolean;
  readonly sidebar: boolean;
  readonly groupBy: "status" | "harness" | "workspace";
  /** Whether the frozen Harnesses (Cursor, Gemini CLI, Pi) are listed for new work as well (ADR-050); off by default. */
  readonly showFrozen: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = { theme: "system", density: "compact", panel: false, sidebar: true, groupBy: "status", showFrozen: false };
const KEY = "harnesshub:preferences";
/**
 * The stored shape's version. Every write stores the whole set, so before version 2 each one also stored the details panel's
 * old default, open: a stored `panel` from then is not a choice, is not read, and the panel starts closed (decision E). From
 * version 2 on, an opening or a closing is the user's own and is kept.
 */
const VERSION = 2;
const CHOICES: { readonly [K in keyof Preferences]: readonly Preferences[K][] } = {
  theme: ["system", "light", "dark"], density: ["compact", "detailed"], panel: [true, false], sidebar: [true, false], groupBy: ["status", "harness", "workspace"], showFrozen: [false, true],
};
/**
 * The Harnesses that the lists offering one for new work leave out (ADR-050, ADR-048 decision 1): the frozen ones, unless
 * `showFrozen`. Those in `keep` — the open conversation's and the draft's choice — stay listed, so hiding never takes away
 * what is already chosen. Names, the inbox, details and history look Harnesses up in the full list and never use this.
 */
export function hiddenHarnesses(harnesses: readonly Pick<HarnessView, "id" | "tier">[], showFrozen: boolean, keep: readonly string[]): ReadonlySet<string> {
  if (showFrozen) return new Set();
  return new Set(harnesses.flatMap(harness => harness.tier === "frozen" && !keep.includes(harness.id) ? [harness.id] : []));
}
export function readPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null || raw.length > 4096) return DEFAULT_PREFERENCES;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return DEFAULT_PREFERENCES;
    const row = value as Record<string, unknown>, result: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
    for (const key of Object.keys(CHOICES) as (keyof Preferences)[]) {
      if (key === "panel" && row.version !== VERSION) continue;
      if ((CHOICES[key] as readonly unknown[]).includes(row[key])) result[key] = row[key];
    }
    return result as unknown as Preferences;
  } catch { return DEFAULT_PREFERENCES; }
}
function writePreferences(value: Preferences): void { try { localStorage.setItem(KEY, JSON.stringify({ ...value, version: VERSION })); } catch { /* lasts for this page only */ } }
/** Applies the theme to the root element; "system" removes the attribute so the stylesheet follows the media query. */
export function applyTheme(theme: Preferences["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme);
}
/** The page's preferences, kept in sync across tabs of this browser. */
export function usePreferences(): readonly [Preferences, <K extends keyof Preferences>(key: K, value: Preferences[K]) => void] {
  const [value, setValue] = useState(readPreferences);
  useEffect(() => { applyTheme(value.theme); }, [value.theme]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === KEY) setValue(readPreferences()); };
    window.addEventListener("storage", changed); return () => window.removeEventListener("storage", changed);
  }, []);
  const set = useCallback(<K extends keyof Preferences>(key: K, next: Preferences[K]) => {
    setValue(current => { const updated = { ...current, [key]: next }; writePreferences(updated); return updated; });
  }, []);
  return [value, set] as const;
}
/** Whether the viewport matches a media query, following changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query), changed = () => setMatches(list.matches);
    changed(); list.addEventListener("change", changed); return () => list.removeEventListener("change", changed);
  }, [query]);
  return matches;
}
/** Re-renders every second while `active`, so elapsed times and deadlines stay current; the clock stops with it. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
