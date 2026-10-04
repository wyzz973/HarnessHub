// SPDX-License-Identifier: MIT
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { dismissToast, useToasts } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * Notices of finished and failed actions, bottom right (full width on a
 * phone). Failures are announced assertively, successes politely.
 */
export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex gap-2.5 rounded-xl border bg-popover p-3 text-[13px] shadow-float",
            toast.tone === "error" ? "border-danger/30" : "border-success/30",
          )}
        >
          {toast.tone === "error" ? (
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-danger"
              aria-hidden
            />
          ) : (
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-success"
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="break-words">{toast.title}</p>
            {toast.detail ? (
              <details className="mt-1 text-[12px] text-muted-foreground">
                <summary>{t("common.technicalDetails")}</summary>
                <p className="mt-1 font-mono break-all">
                  {toast.detail.code}
                  {toast.detail.requestId ? ` · ${toast.detail.requestId}` : ""}
                </p>
                {toast.detail.message ? (
                  <p className="mt-0.5 break-words">{toast.detail.message}</p>
                ) : null}
              </details>
            ) : null}
          </div>
          <button
            type="button"
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("common.dismissNotice")}
            onClick={() => dismissToast(toast.id)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
