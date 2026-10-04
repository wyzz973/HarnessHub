// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import type {
  AllowanceReading,
  CredentialRoutingState,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { failureOf, modelPlane } from "@/lib/model-plane";
import {
  breakerStates,
  failureText,
  readingView,
  restLeft,
  statesByCredential,
} from "@/lib/routing-state";
import { cn } from "@/lib/utils";
import { EmptyState, LoadError, LocalTime, PageHeader } from "./model-plane-ui";

export type RoutingStates =
  | { state: "loading" }
  | {
      state: "ready";
      byCredential: ReadonlyMap<string, CredentialRoutingState>;
    }
  | { state: "error"; message: string };

/**
 * The gateway's routing state of every credential, read now and every 5
 * seconds while the page is visible (an in-memory snapshot, cheap to read).
 * The timer and the request in flight belong to the component and end with it.
 */
export function useRoutingStates(): readonly [RoutingStates, () => void] {
  const [states, setStates] = useState<RoutingStates>({ state: "loading" });
  const refresh = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = () => {
      window.clearTimeout(timer);
      modelPlane()
        .routing.state()
        .then(
          (page) => {
            if (!stopped)
              setStates({
                state: "ready",
                byCredential: statesByCredential(page.items),
              });
          },
          (reason: unknown) => {
            if (!stopped)
              setStates({ state: "error", message: failureOf(reason).message });
          },
        )
        .finally(() => {
          if (!stopped && document.visibilityState === "visible")
            timer = window.setTimeout(tick, 5000);
        });
    };
    const visible = () => {
      if (document.visibilityState === "visible") tick();
    };
    refresh.current = tick;
    tick();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      refresh.current = () => undefined;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return [states, () => refresh.current()] as const;
}

/** "休息到 22:20:28，还剩 9:52", counting down each second until the rest ends. */
export function RestingUntil({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = restLeft(until, now);
  return (
    <span className="text-[12px] text-muted-foreground">
      休息到 <LocalTime value={until} />
      {left ? (
        <>
          ，还剩 <span className="tabular-nums">{left}</span>
        </>
      ) : (
        "，等待下一次请求探测"
      )}
    </span>
  );
}

/** The breaker as a tag; the rest and the last failure in its tooltip and next to it. */
export function CredentialState({
  state,
  compact,
}: {
  state: CredentialRoutingState | undefined;
  /** Only the tag (lists); otherwise the rest and last failure follow it. */
  compact?: boolean;
}) {
  if (!state) return <span className="text-subtle">—</span>;
  const breaker = breakerStates[state.state];
  const rest = state.restingUntil
    ? `，休息到 ${new Date(state.restingUntil).toLocaleString()}`
    : "";
  const failure = state.lastFailure
    ? `最近一次失败：${failureText(state.lastFailure)}，${new Date(state.lastFailure.at).toLocaleString()}`
    : "";
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span
        className={`tag ${breaker.tone}`}
        title={[`${breaker.hint}${rest}`, failure].filter(Boolean).join("\n")}
      >
        {breaker.label}
      </span>
      {!compact && state.state === "open" && state.restingUntil ? (
        <RestingUntil until={state.restingUntil} />
      ) : null}
      {!compact && state.lastFailure ? (
        <span className="text-[12px] text-muted-foreground">
          {failureText(state.lastFailure)}，
          <LocalTime value={state.lastFailure.at} />
        </span>
      ) : null}
    </span>
  );
}

/** Allowance readings as bars: the window, the share used and when it renews. */
export function Readings({
  readings,
  className,
}: {
  readings: readonly AllowanceReading[];
  className?: string;
}) {
  if (!readings.length) return null;
  const now = Date.now();
  return (
    <ul className={cn("space-y-1.5", className)} aria-label="额度读数">
      {readings.map((reading) => {
        const view = readingView(reading, now);
        return (
          <li
            key={reading.window}
            className="min-w-[160px] text-[12px]"
            title={`读取于 ${new Date(reading.observedAt).toLocaleString()}`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-muted-foreground">
                {view.name}
              </span>
              <span className="tabular-nums">
                {view.renewed ? "已续期" : `已用 ${view.percent}%`}
              </span>
            </span>
            <span
              className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`${view.name} 已用`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={view.percent}
            >
              <span
                className={cn(
                  "block h-full rounded-full",
                  view.tone === "good"
                    ? "bg-success"
                    : view.tone === "warn"
                      ? "bg-warning"
                      : "bg-danger",
                )}
                style={{ width: `${view.percent}%` }}
              />
            </span>
            {reading.resetsAt && !view.renewed ? (
              <span className="text-subtle">
                <LocalTime value={reading.resetsAt} /> 续期
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Every credential as the gateway routes it: breaker state, the rest after
 * a failure, the last failure's class and the allowance readings. A daemon
 * restart clears the breakers; readings persist.
 */
export function CredentialStatesPage({ tabs }: { tabs: React.ReactNode }) {
  const [states, refresh] = useRoutingStates();
  const items =
    states.state === "ready" ? [...states.byCredential.values()] : [];
  const resting = items.filter((item) => item.state !== "closed").length;
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        {tabs}
        <PageHeader
          title="凭据状态"
          lede="网关如何使用每个凭据：失败后休息，到期后放行一次探测；额度读数来自上游的限流头与官方客户端的额度报告，smart 与 pace 路由按它排序。每 5 秒刷新。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={refresh}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
          {states.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label="正在读取"
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : states.state === "error" ? (
            <LoadError message={states.message} retry={refresh} />
          ) : items.length ? (
            <>
              {resting ? (
                <p className="callout warn">
                  {resting} 个凭据正在休息或等待探测；网关在此期间使用其他候选。
                </p>
              ) : null}
              <div className="panel overflow-x-auto">
                <table className="data-table min-w-[720px]">
                  <thead>
                    <tr>
                      <th>凭据</th>
                      <th>状态</th>
                      <th>最近一次失败</th>
                      <th>额度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={`${item.provider}/${item.credential}`}>
                        <td>
                          <span className="block">
                            {item.credentialName}
                            {!item.enabled ? (
                              <span className="tag warn ml-2">已停用</span>
                            ) : null}
                          </span>
                          <span className="font-mono text-[12px] text-subtle">
                            {item.provider}/{item.credential}
                          </span>
                        </td>
                        <td>
                          <CredentialState state={item} compact />
                          {item.state === "open" && item.restingUntil ? (
                            <span className="block">
                              <RestingUntil until={item.restingUntil} />
                            </span>
                          ) : null}
                        </td>
                        <td className="text-[12.5px]">
                          {item.lastFailure ? (
                            <>
                              {failureText(item.lastFailure)}
                              <span className="block text-[12px] text-subtle">
                                <LocalTime value={item.lastFailure.at} />
                              </span>
                            </>
                          ) : (
                            <span className="text-subtle">—</span>
                          )}
                        </td>
                        <td className="w-[240px]">
                          {item.readings.length ? (
                            <Readings readings={item.readings} />
                          ) : (
                            <span className="text-[12.5px] text-subtle">
                              尚无读数
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyState icon={Activity} title="还没有凭据">
              添加 provider 与凭据后，这里显示网关使用它们的状态。
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
