// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  BellRing,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
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
  rangeLabel,
  rangeStart,
  usageRanges,
  usd,
  type UsageRange,
} from "@/lib/model-plane";
import { featureSections } from "@/lib/gateway-features";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { duration, finishReasonText, quantity } from "@/lib/presentation";
import { errorClassText } from "@/lib/routing-state";
import { notify } from "@/lib/toast";
import {
  alertText,
  dismissUsageAlerts,
  useUsageAlerts,
} from "@/lib/usage-alerts";
import { downloadUsageCsv } from "@/lib/usage-export";
import { cn } from "@/lib/utils";
import { navigate, type Page } from "@/lib/router";
import {
  EmptyState,
  LoadError,
  LocalTime,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";
import { PageTabs } from "./page-tabs";

/** The groupings the summary offers, in order. */
const groupings = [
  "model",
  "provider",
  "credential",
  "key",
  "adapter",
  "day",
] as const satisfies readonly UsageGroupBy[];
type Grouping = (typeof groupings)[number];
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
          <th>{t("usage.calls.time")}</th>
          <th>{t("usage.calls.status")}</th>
          <th>{t("usage.calls.model")}</th>
          <th>{t("usage.calls.provider")}</th>
          <th>{t("usage.calls.tokens")}</th>
          <th>{t("usage.calls.cost")}</th>
          <th>{t("usage.calls.timing")}</th>
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
                  {call.rejected ? t("usage.calls.rejected") : ""}
                </span>
                {call.status >= 400 && call.errorClass ? (
                  <span
                    className="mt-1 block text-[12px] text-muted-foreground"
                    title={`errorClass: ${call.errorClass}`}
                  >
                    {errorClassText(call.errorClass)}
                  </span>
                ) : null}
                {call.finishReason ? (
                  <span
                    className="mt-1 block text-[12px] text-muted-foreground"
                    title={`finishReason: ${call.finishReason}`}
                  >
                    {finishReasonText(call.finishReason)}
                  </span>
                ) : null}
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
                  <span className="text-subtle">
                    {t("usage.calls.unknown")}
                  </span>
                ) : (
                  <>
                    {quantity(
                      call.usage.input +
                        call.usage.cacheRead +
                        call.usage.cacheWrite,
                    )}{" "}
                    / {quantity(call.usage.output)}
                    {call.usage.source === "estimated" ? (
                      <span className="ml-1 text-subtle">
                        {t("usage.calls.estimated")}
                      </span>
                    ) : null}
                  </>
                )}
              </td>
              <td className="tabular text-[12.5px]">
                {call.cost ? (
                  usd(call.cost.amount)
                ) : (
                  <span className="tag warn">{t("usage.calls.unpriced")}</span>
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

/** Download the calls or the sums shown, as CSV; the request carries the session like every other. */
function CsvButton({
  what,
  from,
  label,
}: {
  what: { kind: "calls" } | { kind: "usage"; groupBy: UsageGroupBy };
  from: string | undefined;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        downloadUsageCsv(what, from ? { from } : {}).then(
          () => setBusy(false),
          (reason: unknown) => {
            setBusy(false);
            notify.error(reason, t("usage.csv.failed"));
          },
        );
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Download />}
      {label}
    </Button>
  );
}

/** Usage alerts not yet dismissed in this browser, with the way to the threshold. */
function AlertsNotice() {
  const { list, fresh } = useUsageAlerts();
  if (!fresh.length) return null;
  const shown = fresh.slice(0, 5);
  return (
    <div role="status" className="callout warn mt-6 items-start">
      <BellRing className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">{t("usage.alerts.title")}</p>
        <ul className="space-y-0.5">
          {shown.map((alert) => (
            <li
              key={`${alert.at}\u0000${alert.provider}\u0000${alert.credential}\u0000${alert.window}`}
            >
              {alertText(alert)}
              <span className="text-[12px] opacity-80">
                {" · "}
                {tr("usage.alerts.at", {
                  time: <LocalTime value={alert.at} />,
                })}
                {alert.resetsAt ? (
                  <>
                    {" · "}
                    {tr("usage.alerts.resets", {
                      time: <LocalTime value={alert.resetsAt} />,
                    })}
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {fresh.length > shown.length ? (
          <p>{t("usage.alerts.more", { n: fresh.length - shown.length })}</p>
        ) : null}
        {list?.usagePercent != null ? (
          <p className="text-[12px]">
            {t("usage.alerts.threshold", {
              percent: String(list.usagePercent),
            })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            navigate("features", { search: featureSections.alerts })
          }
        >
          {t("usage.alerts.settings")}
        </Button>
        <Button size="xs" variant="outline" onClick={dismissUsageAlerts}>
          {t("usage.alerts.dismiss")}
        </Button>
      </div>
    </div>
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
        <h2 className="section-title">{t("usage.recent")}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <CsvButton
            what={{ kind: "calls" }}
            from={from}
            label={t("usage.csv.calls")}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("usage.previousPage")}
            disabled={cursors.length < 2}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular text-[12.5px] whitespace-nowrap text-muted-foreground">
            {t("usage.page", { n: cursors.length })}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("usage.nextPage")}
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
            aria-label={t("usage.refreshCalls")}
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
          <p className="empty-state">{t("usage.noCalls")}</p>
        ) : null}
      </div>
    </>
  );
}

/** Sums by the chosen attribute and the latest calls, for a time range. */
function Summary({ from }: { from: string | undefined }) {
  const [groupBy, setGroupBy] = useState<Grouping>("model");
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
          label={t("usage.stat.calls")}
          value={report.state === "ready" ? quantity(calls) : "—"}
          note={
            failed
              ? t("usage.stat.failed", { n: failed })
              : t("usage.stat.noFailures")
          }
          warn={failed > 0}
        />
        <Stat
          label="Token"
          value={report.state === "ready" ? quantity(tokens) : "—"}
          note={t("usage.stat.tokensNote")}
        />
        <Stat
          label={t("usage.stat.cost")}
          value={report.state === "ready" ? usd(cost) : "—"}
          {...(unpriced
            ? {
                note: t("usage.stat.someUnpriced", { n: unpriced }),
                warn: true,
              }
            : { note: t("usage.stat.allPriced") })}
        />
        <Stat
          label={t("usage.stat.unpriced")}
          value={report.state === "ready" ? quantity(unpriced) : "—"}
          note={t("usage.stat.unpricedNote")}
          warn={unpriced > 0}
        />
      </div>
      <div className="mt-9 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-title">{t("usage.summary")}</h2>
        <CsvButton
          what={{ kind: "usage", groupBy }}
          from={from}
          label={t("usage.csv.usage")}
        />
        <div
          className="segmented"
          role="tablist"
          aria-label={t("usage.groupBy")}
        >
          {groupings.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={groupBy === item}
              onClick={() => setGroupBy(item)}
            >
              {t(`usage.group.${item}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="panel overflow-x-auto">
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th>{t(`usage.column.${groupBy}`)}</th>
              <th>{t("usage.stat.calls")}</th>
              <th>{t("usage.table.failed")}</th>
              <th>{t("usage.table.input")}</th>
              <th>{t("usage.table.cache")}</th>
              <th>{t("usage.table.output")}</th>
              <th>{t("usage.table.reasoning")}</th>
              <th>{t("usage.calls.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td className="font-mono text-[12.5px]">
                  {item.key || (
                    <span className="text-subtle">{t("usage.table.none")}</span>
                  )}
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
                      title={t("usage.table.unpricedHint")}
                    >
                      <TriangleAlert className="size-3" />
                      {t("usage.table.unpriced", { n: item.unpricedCalls })}
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
          <p className="empty-state">{t("usage.noCalls")}</p>
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
      <div
        className="space-y-2 p-4"
        role="status"
        aria-label={t("usage.loadingCalls")}
      >
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
          {t("usage.conversations.latestOnly")}
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
          {t("usage.conversations.help")}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("usage.previousPage")}
            disabled={cursors.length < 2}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular text-[12.5px] whitespace-nowrap text-muted-foreground">
            {t("usage.page", { n: cursors.length })}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("usage.nextPage")}
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
            aria-label={t("usage.conversations.refresh")}
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
          aria-label={t("common.loading")}
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : page.state === "error" ? (
        <LoadError message={page.message} retry={reload} />
      ) : !page.value.items.length ? (
        <EmptyState
          icon={MessagesSquare}
          title={t("usage.conversations.empty")}
        >
          {t("usage.conversations.emptyBody")}
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
                        <span className="tag">
                          {t("usage.conversations.unknownClient")}
                        </span>
                      )}
                      <span
                        className="font-mono text-[11.5px] text-subtle"
                        title={conversation.key}
                      >
                        {conversation.key.slice(0, 12)}
                      </span>
                    </span>
                    <span className="mt-1 block font-mono text-[12px] break-all text-muted-foreground">
                      {conversation.models.join(t("agents.listSeparator")) ||
                        "—"}
                    </span>
                    {conversation.credentials.length ? (
                      <span className="block font-mono text-[11.5px] break-all text-subtle">
                        {t("usage.conversations.credentials", {
                          list: conversation.credentials.join(
                            t("agents.listSeparator"),
                          ),
                        })}
                      </span>
                    ) : null}
                  </span>
                  <span className="grid grid-cols-3 gap-x-6 text-[12.5px] tabular max-sm:w-full max-sm:pl-6">
                    <span>
                      <span className="block text-[11.5px] text-subtle">
                        {t("usage.stat.calls")}
                      </span>
                      {quantity(conversation.calls)}
                      {conversation.failedCalls ? (
                        <span className="text-danger">
                          {t("usage.conversations.failed", {
                            n: conversation.failedCalls,
                          })}
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
                        {t("usage.calls.cost")}
                      </span>
                      {usd(conversation.cost.amount)}
                      {conversation.unpricedCalls ? (
                        <span className="text-warning">
                          {t("usage.conversations.unpriced", {
                            n: conversation.unpricedCalls,
                          })}
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
        <PageTabs
          label={t("common.nav.usage")}
          current={tab}
          tabs={[
            { page: "usage", label: t("usage.tab.usage") },
            { page: "conversations", label: t("usage.tab.conversations") },
          ]}
        />
        <PageHeader
          title={
            tab === "usage"
              ? t("common.nav.usage")
              : t("usage.tab.conversations")
          }
          lede={
            tab === "usage" ? t("usage.lede") : t("usage.conversations.lede")
          }
        >
          <select
            className="field mt-0 h-8 w-auto text-[13px]"
            aria-label={t("usage.range")}
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
                {rangeLabel(item.id)}
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
            onClick={() => setFrom(rangeStart(range, Date.now()))}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <AlertsNotice />
        {tab === "usage" ? (
          <Summary key={from ?? "all"} from={from} />
        ) : (
          <Conversations key={from ?? "all"} from={from} />
        )}
      </div>
    </div>
  );
}
