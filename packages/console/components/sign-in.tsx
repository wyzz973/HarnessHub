// SPDX-License-Identifier: MIT
import { Layers2, LoaderCircle, RefreshCw, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LanguageSwitch } from "@/components/language-switch";
import { t } from "@/lib/i18n";
import { startSession, type SessionState } from "@/lib/session";

/**
 * The page before sign-in: how to open the console with `hh console`, or why
 * the daemon could not be reached. There is no password form (07 section 5.2).
 */
export function SignIn({ state }: { state: SessionState }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <section
        className="w-full max-w-[440px] space-y-5"
        aria-labelledby="sign-in-title"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-brand">
            <Layers2 className="size-[22px]" strokeWidth={1.8} aria-hidden />
            <span className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">
              HarnessHub
            </span>
          </div>
          <LanguageSwitch />
        </div>
        {state.status === "checking" ? (
          <p
            className="flex items-center gap-2 text-muted-foreground"
            role="status"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {t("common.signIn.connecting")}
          </p>
        ) : state.status === "failed" ? (
          <>
            <h1 id="sign-in-title" className="text-[18px] font-semibold">
              {t("common.signIn.unreachable")}
            </h1>
            <p className="text-muted-foreground" role="alert">
              {state.message}
            </p>
            <Button variant="outline" onClick={() => void startSession()}>
              <RefreshCw aria-hidden />
              {t("common.retry")}
            </Button>
          </>
        ) : (
          <>
            <h1 id="sign-in-title" className="text-[18px] font-semibold">
              {t("common.signIn.title")}
            </h1>
            {state.status === "signed-out" ? (
              <p className="text-muted-foreground">
                {t(`common.signIn.${state.reason}`)}
              </p>
            ) : null}
            <div className="space-y-2">
              <p>{t("common.signIn.run")}</p>
              <pre className="flex items-center gap-2 rounded-[10px] border bg-code px-3.5 py-2.5 text-[13px]">
                <TerminalSquare
                  className="size-4 shrink-0 text-subtle"
                  aria-hidden
                />
                <code>hh console</code>
              </pre>
              <p className="text-[13px] text-muted-foreground">
                {t("common.signIn.then")}
              </p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
