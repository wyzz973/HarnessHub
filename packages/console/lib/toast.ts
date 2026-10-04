// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from "react";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { t } from "./i18n";
import { failureOf } from "./model-plane";

/** One notice in the corner of the page. */
export interface Toast {
  id: number;
  tone: "error" | "success";
  title: string;
  /** The daemon's own words and identifiers, shown under the technical details. */
  detail?: { code: string; requestId?: string; message?: string };
}

let toasts: readonly Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish(list: readonly Toast[]) {
  toasts = list;
  for (const listener of listeners) listener();
}

/** Remove a notice (its close button, or its timer). */
export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  publish(toasts.filter((toast) => toast.id !== id));
}

function show(toast: Omit<Toast, "id">, ms: number) {
  const id = next++;
  // At most four at a time; the oldest goes first.
  publish([...toasts.slice(-3), { ...toast, id }]);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
}

export const notify = {
  /**
   * A failed action: the readable message of `reason` (problem details are
   * mapped by code, see `failureOf`), with the problem's code, request ID and
   * English detail kept for the technical details. Errors stay 10 s.
   */
  error(reason: unknown, title?: string): void {
    const failure = failureOf(reason);
    show(
      {
        tone: "error",
        title: title
          ? t("common.failureTitle", { title, message: failure.message })
          : failure.message,
        ...(reason instanceof HarnessHubError
          ? {
              detail: {
                code: reason.code,
                ...(reason.requestId ? { requestId: reason.requestId } : {}),
                ...(reason.problem.detail
                  ? { message: reason.problem.detail }
                  : {}),
              },
            }
          : {}),
      },
      10_000,
    );
  },
  /** A finished action, for 4 s. */
  success(title: string): void {
    show({ tone: "success", title }, 4_000);
  },
};

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
    () => toasts,
  );
}
