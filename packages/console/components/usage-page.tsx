// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { ApiModelCall, UsageGroupBy } from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addAmounts,
  modelPlane,
  rangeStart,
  usageRanges,
  usd,
  type UsageRange,
} from "@/lib/model-plane";
import { duration, quantity } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { LocalTime, PageHeader, useLoaded } from "./model-plane-ui";

const groupings: { id: UsageGroupBy; label: string }[] = [
  { id: "model", label: "按模型" },
  { id: "provider", label: "按 provider" },
  { id: "day", label: "按日期（UTC）" },
];
const PAGE = 20;

function Stat({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: string;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div className="panel px-5 py-4">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-[24px] leading-none font-semibold tabular">
        {value}
      </p>
      <p
        className={cn(
          "mt-2 h-4 text-[12px] text-subtle",
          warn && "text-warning",
        )}
      >
        {note ?? ""}
      </p>
    </div>
  );
}

function tokensOf(usage: ApiModelCall["usage"]) {
  if (!usage || usage.source === "missing") return null;
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/** Recent `model.call` entries, newest first, one cursor page at a time. */
function RecentCalls({ from }: { from: string | undefined }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const load = useCallback(
    () =>
      modelPlane().modelCalls.list({
        limit: PAGE,
        ...(from ? { from } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    [from, cursor],
  );
  const [page, reload] = useLoaded(load);
  return (
    <>
      <div className="mt-9 mb-3 flex items-center justify-between gap-3">
        <h2 className="section-title">最近调用</h2>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上一页"
            disabled={cursors.length < 2}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular text-[12.5px] text-muted-foreground">
            第 {cursors.length} 页
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="下一页"
            disabled={page.state !== "ready" || !page.value.nextCursor}
            onClick={() => {
              if (page.state === "ready" && page.value.nextCursor)
                setCursors((list) => [...list, page.value.nextCursor!]);
            }}
          >
            <ChevronRight />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新调用"
            onClick={reload}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      <div className="panel overflow-x-auto">
        <table className="data-table min-w-[860px]">
          <thead>
            <tr>
              <th>时间</th>
              <th>状态</th>
              <th>模型</th>
              <th>Provider</th>
              <th>Token（输入 / 输出）</th>
              <th>费用</th>
              <th>首字节 / 总耗时</th>
            </tr>
          </thead>
          <tbody>
            {page.state === "ready"
              ? page.value.items.map((call) => {
                  const total = tokensOf(call.usage);
                  return (
                    <tr key={call.callId}>
                      <td className="text-[12.5px]">
                        <LocalTime value={call.occurredAt} />
                      </td>
                      <td>
                        <span
                          className={cn(
                            "tag",
                            call.status < 400 ? "good" : "error",
                          )}
                          title={call.rejectReason ?? call.errorClass ?? ""}
                        >
                          {call.status}
                          {call.rejected ? " 拒绝" : ""}
                        </span>
                      </td>
                      <td className="max-w-[220px]">
                        <p
                          className="truncate font-mono text-[12px]"
                          title={call.modelRef ?? call.requestedModel ?? ""}
                        >
                          {call.modelRef ?? call.requestedModel ?? "—"}
                        </p>
                      </td>
                      <td className="text-[12.5px]">{call.provider ?? "—"}</td>
                      <td className="tabular text-[12.5px]">
                        {total === null || !call.usage ? (
                          <span className="text-subtle">未知</span>
                        ) : (
                          <>
                            {quantity(
                              call.usage.input +
                                call.usage.cacheRead +
                                call.usage.cacheWrite,
                            )}{" "}
                            / {quantity(call.usage.output)}
                            {call.usage.source === "estimated" ? (
                              <span className="ml-1 text-subtle">估算</span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="tabular text-[12.5px]">
                        {call.cost ? (
                          usd(call.cost.amount)
                        ) : (
                          <span className="tag warn">未定价</span>
                        )}
                      </td>
                      <td className="tabular text-[12.5px]">
                        {duration(call.timing.firstByteMs)} /{" "}
                        {duration(call.timing.durationMs)}
                      </td>
                    </tr>
                  );
                })
              : null}
          </tbody>
        </table>
        {page.state === "loading" ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : page.state === "error" ? (
          <p className="empty-state text-danger">读取失败：{page.message}</p>
        ) : !page.value.items.length ? (
          <p className="empty-state">这段时间没有调用</p>
        ) : null}
      </div>
    </>
  );
}

/** Usage from the `model.call` ledger (`/api/v1/usage`, `/api/v1/model-calls`). */
export function UsagePage() {
  const [range, setRange] = useState<UsageRange>("7d");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("model");
  // The range start is fixed when the range is chosen, so pages stay consistent.
  const [from, setFrom] = useState(() => rangeStart("7d", Date.now()));
  const load = useCallback(
    () => modelPlane().usage.aggregate({ groupBy, ...(from ? { from } : {}) }),
    [groupBy, from],
  );
  const [report, reload] = useLoaded(load);
  const items = report.state === "ready" ? report.value.items : [];
  const sum = (pick: (item: (typeof items)[number]) => number) =>
    items.reduce((total, item) => total + pick(item), 0);
  const calls = sum((item) => item.calls);
  const failed = sum((item) => item.failedCalls);
  const unpriced = sum((item) => item.unpricedCalls);
  const tokens = sum(
    (item) =>
      item.usage.input +
      item.usage.cacheRead +
      item.usage.cacheWrite +
      item.usage.output,
  );
  const cost = addAmounts(items.map((item) => item.cost.amount));
  return (
    <div className="page-body">
      <div className="page-column max-w-[1100px]">
        <PageHeader
          title="用量"
          lede="来自网关的 model.call 账本：每次进入网关的调用都有一条记录，包括被拒绝的。"
        >
          <select
            className="field mt-0 h-8 w-auto text-[13px]"
            aria-label="时间范围"
            value={range}
            onChange={(event) => {
              const next = event.target.value as UsageRange;
              setRange(next);
              setFrom(rangeStart(next, Date.now()));
            }}
          >
            {usageRanges.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={() => {
              setFrom(rangeStart(range, Date.now()));
              reload();
            }}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="调用"
            value={report.state === "ready" ? quantity(calls) : "—"}
            note={failed ? `${failed} 次失败` : "没有失败"}
            warn={failed > 0}
          />
          <Stat
            label="Token"
            value={report.state === "ready" ? quantity(tokens) : "—"}
            note="输入、缓存与输出之和"
          />
          <Stat
            label="已知费用"
            value={report.state === "ready" ? usd(cost) : "—"}
            {...(unpriced
              ? { note: `另有 ${unpriced} 次调用未定价`, warn: true }
              : { note: "全部调用已定价" })}
          />
          <Stat
            label="未定价调用"
            value={report.state === "ready" ? quantity(unpriced) : "—"}
            note="价格未知时不按 0 计"
            warn={unpriced > 0}
          />
        </div>
        <div className="mt-9 mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-title">汇总</h2>
          <div className="segmented" role="tablist" aria-label="分组方式">
            {groupings.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={groupBy === item.id}
                onClick={() => setGroupBy(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[760px]">
            <thead>
              <tr>
                <th>
                  {groupings
                    .find((item) => item.id === groupBy)
                    ?.label.replace("按", "")}
                </th>
                <th>调用</th>
                <th>失败</th>
                <th>输入</th>
                <th>缓存读 / 写</th>
                <th>输出</th>
                <th>推理</th>
                <th>费用</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td className="font-mono text-[12.5px]">
                    {item.key || <span className="text-subtle">（无）</span>}
                  </td>
                  <td className="tabular">{quantity(item.calls)}</td>
                  <td
                    className={cn("tabular", item.failedCalls && "text-danger")}
                  >
                    {quantity(item.failedCalls)}
                  </td>
                  <td className="tabular">{quantity(item.usage.input)}</td>
                  <td className="tabular">
                    {quantity(item.usage.cacheRead)} /{" "}
                    {quantity(item.usage.cacheWrite)}
                  </td>
                  <td className="tabular">{quantity(item.usage.output)}</td>
                  <td className="tabular">{quantity(item.usage.reasoning)}</td>
                  <td className="tabular">
                    {usd(item.cost.amount)}
                    {item.unpricedCalls ? (
                      <span
                        className="tag warn ml-2"
                        title="这些调用的价格未知，费用中未计入"
                      >
                        <TriangleAlert className="size-3" />
                        {item.unpricedCalls} 未定价
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.state === "loading" ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : report.state === "error" ? (
            <p className="empty-state text-danger">
              读取失败：{report.message}
            </p>
          ) : !items.length ? (
            <p className="empty-state">这段时间没有调用</p>
          ) : null}
        </div>
        <RecentCalls key={from ?? "all"} from={from} />
      </div>
    </div>
  );
}
