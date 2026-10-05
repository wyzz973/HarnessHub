// SPDX-License-Identifier: MIT
/**
 * The usage alert (`GET /api/v1/usage/alerts`, docs/gateway-features.md):
 * allowance windows that reached the threshold set in Gateway features.
 * One poll for the whole page, every minute while the tab is visible and
 * something shows the alerts. Dismissing is this browser's: the newest
 * alert time seen is kept in `localStorage`, and only later alerts show.
 */
import { useSyncExternalStore } from "react";
import type { UsageAlertList } from "@harnesshub/sdk/client";
import { t } from "./i18n";
import { apiClient } from "./session";
import { windowName } from "./routing-state";

export type UsageAlert = UsageAlertList["items"][number];

const DISMISSED_KEY = "harnesshub.usageAlerts.dismissedAt";
const POLL_MS = 60_000;

/** Alerts after the dismissed time, newest first as the daemon lists them. */
export function freshAlerts(
  list: UsageAlertList | undefined,
  dismissedAt: string | undefined,
): UsageAlert[] {
  if (!list) return [];
  const after = dismissedAt === undefined ? -Infinity : Date.parse(dismissedAt);
  return list.items.filter((item) => Date.parse(item.at) > after);
}

/** One alert in words: the credential, its window and how much of it is used. */
export function alertText(alert: UsageAlert): string {
  return t("usage.alerts.item", {
    credential: `${alert.provider}/${alert.credentialName ?? alert.credential}`,
    window: windowName(alert.window),
    percent: String(Math.round(alert.usedPercent)),
  });
}

function storedDismissal(): string | undefined {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

interface AlertsState {
  list?: UsageAlertList;
  dismissedAt?: string;
  fresh: UsageAlert[];
}

let state: AlertsState = { fresh: [] };
let dismissedInMemory: string | undefined;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
/** Bumped when polling stops, so an answer that arrives later is dropped. */
let generation = 0;

function set(
  list: UsageAlertList | undefined,
  dismissedAt: string | undefined,
) {
  state = {
    ...(list ? { list } : {}),
    ...(dismissedAt !== undefined ? { dismissedAt } : {}),
    fresh: freshAlerts(list, dismissedAt),
  };
  for (const listener of listeners) listener();
}

async function poll() {
  if (document.visibilityState !== "visible") return;
  const current = generation;
  try {
    const list = await apiClient().usage.alerts();
    if (current === generation) set(list, state.dismissedAt);
  } catch {
    // The notice is advisory: a failed read keeps what was shown, and the
    // next poll tries again. A signed-out console stops polling by unmounting.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    set(state.list, storedDismissal() ?? dismissedInMemory);
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      generation += 1;
    }
  };
}

/** Hide the alerts shown now; later ones show again. */
export function dismissUsageAlerts(): void {
  const newest = state.fresh[0]?.at;
  if (newest === undefined) return;
  dismissedInMemory = newest;
  try {
    window.localStorage.setItem(DISMISSED_KEY, newest);
  } catch {
    // Without storage the dismissal lasts for this page only.
  }
  set(state.list, newest);
}

/** The alerts not yet dismissed in this browser, and the threshold; polls while used. */
export function useUsageAlerts(): AlertsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
