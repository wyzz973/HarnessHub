// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from "react";

/** The console's pages; each has one path, served by the daemon's SPA fallback. */
export type Page =
  | "tasks"
  | "model"
  | "tools"
  | "engines"
  | "observability"
  | "providers"
  | "groups"
  | "keys"
  | "usage"
  | "agents";

/**
 * Page paths. None may start with a path the daemon keeps for itself
 * (`/api/`, `/v1`, `/health`, `/assets/`, `/openapi.json`) or one the model
 * gateway answers without `/v1` (`/models`, `/responses`, `/messages`,
 * `/chat/completions`): the daemon never falls back to the console there.
 */
export const pagePaths: Readonly<Record<Page, string>> = {
  tasks: "/",
  model: "/model",
  tools: "/tools",
  engines: "/engines",
  observability: "/observability",
  providers: "/providers",
  groups: "/groups",
  keys: "/keys",
  usage: "/usage",
  agents: "/agents",
};

const pageOfPath = new Map(
  Object.entries(pagePaths).map(([page, path]) => [path, page as Page]),
);
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}
/** The page of the current location; an unknown path shows the task page. */
function currentPage(): Page {
  return pageOfPath.get(window.location.pathname) ?? "tasks";
}

/** The open page, following `navigate` and the browser's back and forward buttons. */
export function usePage(): Page {
  return useSyncExternalStore(subscribe, currentPage, () => "tasks");
}

/**
 * Open a page. `search` (with its leading `?`, or empty) replaces the query;
 * by default it is kept only when the page does not change. `replace` rewrites
 * the current history entry instead of adding one.
 */
export function navigate(
  page: Page,
  options: { search?: string; replace?: boolean } = {},
): void {
  const path = pagePaths[page];
  const search =
    options.search ??
    (window.location.pathname === path ? window.location.search : "");
  const target = `${path}${search}`;
  if (target === `${window.location.pathname}${window.location.search}`) return;
  if (options.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  notify();
}
