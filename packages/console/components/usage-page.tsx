// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  MessagesSquare,
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
import type { Page } from "@/lib/router";
import {
  EmptyState,
  LoadError,
  LocalTime,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";
import { PageTabs } from "./page-tabs";

const groupings: { id: UsageGroupBy; label: string; column: string }[] = [
  { id: "model", label: "按模型", column: "模型" },
  { id: "provider", label: "按 provider", column: "Provider" },
  { id: "credential", label: "按凭据", column: "凭据（provider/凭据）" },
  { id: "key", label: "按 Key", column: "Gateway Key" },
  { id: "adapter", label: "按 Agent", column: "Agent" },
  { id: "day", label: "按日期（UTC）", column: "日期（UTC）" },
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

/** `model.call` entries as rows: time, status, model, provider and credential, tokens, cost, timing. */
function CallsTable({ calls }: { calls: readonly ApiModelCall[] }) {
  return (
    <table className="data-table min-w-[900px]">
      <thead>
        <tr>
          <th>时间</th>
          <th>状态</th>
          <th>模型</th>
          <th>Provider / 凭据</th>
          <th>Token（输入 / 输出）</th>
          <th>费用</th>
          <th>首字节 / 总耗时</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => {
          const total = tokensOf(call.usage);
          return (
            <tr key={call.callId}>
              <td className="text-[12.5px]">
                <LocalTime value={call.occurredAt} />
              </td>
              <td>
                <span
                  className={cn("tag", call.status < 400 ? "good" : "error")}
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
              <td className="text-[12.5px]">
                {call.provider ?? "—"}
                {call.credentialId ? (
                  <span className="block font-mono text-[11.5px] text-subtle">
                    {call.credentialId}
                  </span>
                ) : null}
              </td>
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
        })}
      </tbody>
    </table>
  );
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
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上一页"
            disabled={cursors.length < 2}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular text-[12.5px] whitespace-nowrap text-muted-foreground">
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
        <CallsTable calls={page.state === "ready" ? page.value.items : []} />
        {page.state === "loading" ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : page.state === "error" ? (
          <div className="p-4">
            <LoadError message={page.message} retry={reload} />
          </div>
        ) : !page.value.items.length ? (
          <p className="empty-state">这段时间没有调用</p>
        ) : null}
      </div>
    </>
  );
}

/** Sums by the chosen attribute and the latest calls, for a time range. */
function Summary({ from }: { from: string | undefined }) {
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("model");
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
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
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
              <th>{groupings.find((item) => item.id === groupBy)?.column}</th>
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
          <div className="p-4">
            <LoadError message={report.message} retry={reload} />
          </div>
        ) : !items.length ? (
          <p className="empty-state">这段时间没有调用</p>
        ) : null}
      </div>
      <RecentCalls key={from ?? "all"} from={from} />
    </>
  );
}

/** One conversation's calls, newest first, read when its row is opened. */
function ConversationCalls({ conversation }: { conversation: string }) {
  const load = useCallback(
    () => modelPlane().conversations.get(conversation, { limit: 50 }),
    [conversation],
  );
  const [page, reload] = useLoaded(load);
  if (page.state === "loading")
    return (
      <div className="space-y-2 p-4" role="status" aria-label="正在读取调用">
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  if (page.state === "error")
    return (
      <div className="p-3">
        <LoadError message={page.message} retry={reload} />
      </div>
    );
  return (
    <div className="overflow-x-auto">
      <CallsTable calls={page.value.items} />
      {page.value.nextCursor ? (
        <p className="px-4 py-2 text-[12px] text-subtle">
          只显示最近 50 次调用。
        </p>
      ) : null}
    </div>
  );
}

/**
 * Calls grouped by conversation (`/api/v1/conversations`): the conversation
 * as route stickiness knows it, a digest scoped to the Gateway Key, with its
 * agents, models, credentials, tokens and cost. A row opens its calls.
 */
function Conversations({ from }: { from: string | undefined }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [open, setOpen] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  const load = useCallback(
    () =>
      modelPlane().conversations.list({
        limit: PAGE,
        ...(from ? { from } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    [from, cursor],
  );
  const [page, reload] = useLoaded(load);
  return (
    <>
      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          最近活动的在前；会话由网关按 Key
          与客户端的会话标识区分，不显示原始标识。
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="上一页"
            disabled={cursors.length < 2}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular text-[12.5px] whitespace-nowrap text-muted-foreground">
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
            aria-label="刷新会话"
            onClick={reload}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {page.state === "loading" ? (
        <div
          className="panel space-y-3 p-5"
          role="status"
          aria-label="正在读取"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : page.state === "error" ? (
        <LoadError message={page.message} retry={reload} />
      ) : !page.value.items.length ? (
        <EmptyState icon={MessagesSquare} title="这段时间没有会话">
          Agent 或客户端经网关的调用带有会话标识时，按会话汇总在这里。
        </EmptyState>
      ) : (
        <ul className="panel">
          {page.value.items.map((conversation) => {
            const expanded = open === conversation.key;
            const tokens =
              conversation.usage.input +
              conversation.usage.cacheRead +
              conversation.usage.cacheWrite +
              conversation.usage.output;
            return (
              <li key={conversation.key} className="border-b last:border-b-0">
                <button
                  type="button"
                  aria-expanded={expanded}
                  className="flex w-full flex-wrap items-start gap-x-6 gap-y-1.5 px-5 py-3.5 text-left hover:bg-muted"
                  onClick={() => setOpen(expanded ? null : conversation.key)}
                >
                  <ChevronRight
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-subtle transition-transform",
                      expanded && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 basis-[240px]">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {conversation.agents.length ? (
                        conversation.agents.map((agent) => (
                          <span key={agent} className="tag brand">
                            {agent}
                          </span>
                        ))
                      ) : (
                        <span className="tag">未识别的客户端</span>
                      )}
                      <span
                        className="font-mono text-[11.5px] text-subtle"
                        title={conversation.key}
                      >
                        {conversation.key.slice(0, 12)}
                      </span>
                    </span>
                    <span className="mt-1 block font-mono text-[12px] break-all text-muted-foreground">
                      {conversation.models.join("、") || "—"}
                    </span>
                    {conversation.credentials.length ? (
                      <span className="block font-mono text-[11.5px] break-all text-subtle">
                        凭据 {conversation.credentials.join("、")}
                      </span>
                    ) : null}
                  </span>
                  <span className="grid grid-cols-3 gap-x-6 text-[12.5px] tabular max-sm:w-full max-sm:pl-6">
                    <span>
                      <span className="block text-[11.5px] text-subtle">
                        调用
                      </span>
                      {quantity(conversation.calls)}
                      {conversation.failedCalls ? (
                        <span className="text-danger">
                          {" "}
                          （{conversation.failedCalls} 失败）
                        </span>
                      ) : null}
                    </span>
                    <span>
                      <span className="block text-[11.5px] text-subtle">
                        Token
                      </span>
                      {quantity(tokens)}
                    </span>
                    <span>
                      <span className="block text-[11.5px] text-subtle">
                        费用
                      </span>
                      {usd(conversation.cost.amount)}
                      {conversation.unpricedCalls ? (
                        <span className="text-warning">
                          {" "}
                          +{conversation.unpricedCalls} 未定价
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="w-full pl-6 text-[11.5px] text-subtle">
                    <LocalTime value={conversation.firstAt} /> –{" "}
                    <LocalTime value={conversation.lastAt} />
                  </span>
                </button>
                {expanded ? (
                  <div className="border-t bg-muted/40">
                    <ConversationCalls conversation={conversation.key} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const tabs = [
  { page: "usage", label: "汇总与调用" },
  { page: "conversations", label: "会话" },
] as const;

/**
 * Usage from the `model.call` ledger: sums and the latest calls
 * (`/api/v1/usage`, `/api/v1/model-calls`), or calls by conversation
 * (`/api/v1/conversations`), for one time range.
 */
export function UsagePage({
  tab,
}: {
  tab: Extract<Page, "usage" | "conversations">;
}) {
  const [range, setRange] = useState<UsageRange>("7d");
  // The range start is fixed when the range is chosen, so pages stay consistent.
  const [from, setFrom] = useState(() => rangeStart("7d", Date.now()));
  return (
    <div className="page-body">
      <div className="page-column max-w-[1100px]">
        <PageTabs label="用量" current={tab} tabs={tabs} />
        <PageHeader
          title={tab === "usage" ? "用量" : "会话"}
          lede={
            tab === "usage"
              ? "来自网关的 model.call 账本：每次进入网关的调用都有一条记录，包括被拒绝的。"
              : "同一会话的调用汇总在一起：用了哪些模型与凭据、多少 token、花了多少钱。"
          }
        >
          <select
            className="field mt-0 h-8 w-auto text-[13px]"
            aria-label="时间范围"
            value={range}
            onChange={(event) => {
              const next = usageRanges.find(
                (item) => item.id === event.target.value,
              );
              if (!next) return;
              setRange(next.id);
              setFrom(rangeStart(next.id, Date.now()));
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
            onClick={() => setFrom(rangeStart(range, Date.now()))}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        {tab === "usage" ? (
          <Summary key={from ?? "all"} from={from} />
        ) : (
          <Conversations key={from ?? "all"} from={from} />
        )}
      </div>
    </div>
  );
}
