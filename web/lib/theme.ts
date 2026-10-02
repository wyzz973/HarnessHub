"use client";
import { useCallback, useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY } from "./theme-script";

export type Theme = "light" | "dark";
const listeners = new Set<() => void>();

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Current theme and a setter that persists the choice; storage failures only lose persistence. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore<Theme>(subscribe, current, () => "light");
  const setTheme = useCallback((next: Theme) => {
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* Private mode: the choice lasts for this page only. */
    }
    for (const listener of listeners) listener();
  }, []);
  return [theme, setTheme];
}
