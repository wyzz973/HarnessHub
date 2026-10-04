// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from "react";

/** The console's pages; each has one path, served by the daemon's SPA fallback. */
export type Page =
  | "agents"
  | "profiles"
  | "providers"
  | "subscriptions"
  | "library"
  | "routing"
  | "auto-groups"
  | "keys"
  | "usage"
  | "conversations"
  | "settings"
  | "backup"
  | "tasks"
  | "model"
  | "tools"
  | "engines"
  | "observability";

/**
 * Page paths. None may start with a path the daemon keeps for itself
 * (`/api/`, `/v1`, `/health`, `/assets/`, `/openapi.json`) or one the model
 * gateway answers without `/v1` (`/models`, `/responses`, `/messages`,
 * `/chat/completions`): the daemon never falls back to the console there.
 * The agents are the home page.
 */
export const pagePaths: Readonly<Record<Page, string>> = {
  agents: "/",
  profiles: "/profiles",
  providers: "/providers",
  subscriptions: "/subscriptions",
  library: "/library",
  routing: "/routing",
  "auto-groups": "/routing/auto-groups",
  keys: "/routing/keys",
  usage: "/usage",
  conversations: "/usage/conversations",
  settings: "/settings",
  backup: "/settings/backup",
  tasks: "/tasks",
  model: "/model",
  tools: "/tools",
  engines: "/engines",
  observability: "/observability",
};

/** Paths of earlier console versions, kept so bookmarks still open their page. */
const formerPaths: Readonly<Record<string, Page>> = {
  "/agents": "agents",
  "/groups": "routing",
  "/keys": "keys",
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
/** The page of the current location; an unknown path shows the home page. */
function currentPage(): Page {
  return pageOfPath.get(window.location.pathname) ?? "agents";
}

/**
 * Rewrite a former or unknown path to its page's current one, without a new
 * history entry. A task link from when tasks were the home page
 * (`/?session=…`) opens the task page. Call once before the first render.
 */
export function canonicalizeLocation(): void {
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  const page =
    pathname === "/" && (params.has("session") || params.has("workflow"))
      ? "tasks"
      : (formerPaths[pathname] ?? pageOfPath.get(pathname) ?? "agents");
  const keepSearch = page === "tasks" || pathname === pagePaths[page];
  const target = `${pagePaths[page]}${keepSearch ? search : ""}${hash}`;
  if (target !== `${pathname}${search}${hash}`)
    window.history.replaceState(window.history.state, "", target);
}

/** The open page, following `navigate` and the browser's back and forward buttons. */
export function usePage(): Page {
  return useSyncExternalStore(subscribe, currentPage, () => "agents");
}

/** The current query string, following `navigate` and back and forward. */
export function useSearch(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
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
