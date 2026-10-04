// SPDX-License-Identifier: MIT
import { Layers2, LoaderCircle, RefreshCw, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startSession, type SessionState } from "@/lib/session";

const reasons: Record<
  Extract<SessionState, { status: "signed-out" }>["reason"],
  string
> = {
  none: "控制台需要登录。登录链接由本机的 hh 命令生成，不需要口令。",
  "invalid-link":
    "这个登录链接已使用、已过期或不完整。每个链接只能用一次，60 秒内有效。",
  ended: "控制台会话已结束（长时间未使用、已退出登录，或守护进程已重启）。",
  "signed-out": "已退出登录。",
};

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
        <div className="flex items-center gap-2.5 text-brand">
          <Layers2 className="size-[22px]" strokeWidth={1.8} aria-hidden />
          <span className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">
            HarnessHub
          </span>
        </div>
        {state.status === "checking" ? (
          <p
            className="flex items-center gap-2 text-muted-foreground"
            role="status"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            正在连接控制台…
          </p>
        ) : state.status === "failed" ? (
          <>
            <h1 id="sign-in-title" className="text-[18px] font-semibold">
              无法连接守护进程
            </h1>
            <p className="text-muted-foreground" role="alert">
              {state.message}
            </p>
            <Button variant="outline" onClick={() => void startSession()}>
              <RefreshCw aria-hidden />
              重试
            </Button>
          </>
        ) : (
          <>
            <h1 id="sign-in-title" className="text-[18px] font-semibold">
              打开控制台
            </h1>
            {state.status === "signed-out" ? (
              <p className="text-muted-foreground">{reasons[state.reason]}</p>
            ) : null}
            <div className="space-y-2">
              <p>在运行守护进程的电脑上执行：</p>
              <pre className="flex items-center gap-2 rounded-[10px] border bg-code px-3.5 py-2.5 text-[13px]">
                <TerminalSquare
                  className="size-4 shrink-0 text-subtle"
                  aria-hidden
                />
                <code>hh console</code>
              </pre>
              <p className="text-[13px] text-muted-foreground">
                然后在本机浏览器中打开它输出的链接。守护进程启动时（hh
                serve）也会打印一个链接。
              </p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
