// SPDX-License-Identifier: MIT
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Overview, Workflow } from "@/lib/contracts";
import { engineName } from "@/lib/engines";
import { dateLabel, duration, quantity, modelLabel } from "@/lib/presentation";
import { EngineAvatar } from "./engine-avatar";
import { Status } from "./status";
import { formatNumber, t } from "@/lib/i18n";

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="panel px-5 py-4">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-[24px] leading-none font-semibold tabular">
        {value}
      </p>
      <p className="mt-2 h-4 text-[12px] text-subtle">{note ?? ""}</p>
    </div>
  );
}

export function ObservabilityPage({
  overview,
  refresh,
  loading,
  inspect,
  workflows = [],
}: {
  workflows?: Workflow[];
  overview: Overview | null;
  refresh: () => void;
  loading: boolean;
  inspect: (sessionId: string, runId: string) => void;
}) {
  const summary = overview?.summary;
  const labels = new Map<string, string>();
  for (const workflow of workflows) {
    if (workflow.planningRunId)
      labels.set(
        workflow.planningRunId,
        t("tasks.observe.planLabel", {
          title: workflow.title ?? workflow.goal,
        }),
      );
    for (const step of workflow.steps)
      if (step.runId) labels.set(step.runId, step.title);
  }
  const engines = (overview?.engines ?? []).filter(
    (engine) => engine.id !== "fake",
  );
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="page-title">{t("tasks.observe.title")}</h1>
            <p className="page-lede">
              {overview
                ? t("tasks.observe.scope", {
                    n: overview.scope.sampledRuns,
                    time: dateLabel(overview.generatedAt),
                  })
                : t("tasks.observe.lede")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            {t("tasks.observe.refresh")}
          </Button>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t("tasks.observe.runs")}
            value={quantity(summary?.totalRuns)}
            {...(summary
              ? { note: t("tasks.observe.active", { n: summary.activeRuns }) }
              : {})}
          />
          <Stat
            label={t("tasks.observe.completed")}
            value={quantity(summary?.completedRuns)}
            {...(summary
              ? {
                  note: t("tasks.observe.failed", {
                    n:
                      summary.failedRuns +
                      summary.timedOutRuns +
                      summary.interruptedRuns,
                  }),
                }
              : {})}
          />
          <Stat
            label={t("tasks.observe.median")}
            value={duration(summary?.p50DurationMs)}
            {...(summary
              ? { note: `P95 ${duration(summary.p95DurationMs)}` }
              : {})}
          />
          <Stat
            label="Token"
            value={quantity(summary?.knownTotalTokens)}
            {...(summary?.usageCoverage != null
              ? {
                  note: t("tasks.observe.coverage", {
                    percent: Math.round(summary.usageCoverage * 100),
                  }),
                }
              : {})}
          />
        </div>
        <h2 className="section-title mt-9 mb-3">
          {t("tasks.observe.engines")}
        </h2>
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[560px]">
            <thead>
              <tr>
                <th>{t("tasks.observe.engine")}</th>
                <th>{t("tasks.observe.activeLimit")}</th>
                <th>{t("tasks.observe.queued")}</th>
                <th>{t("tasks.observe.doneFailed")}</th>
                <th>{t("tasks.observe.median")}</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((engine) => (
                <tr key={engine.id}>
                  <td>
                    <span className="flex items-center gap-2.5 font-medium">
                      <EngineAvatar id={engine.id} />
                      {engineName(engine.id)}
                    </span>
                  </td>
                  <td className="tabular">
                    {engine.activeRuns} / {engine.maxConcurrency}
                  </td>
                  <td className="tabular">{engine.queuedRuns}</td>
                  <td className="tabular">
                    <span className="text-success">
                      {engine.completedRuns}
                    </span>{" "}
                    /{" "}
                    <span className={engine.failedRuns ? "text-danger" : ""}>
                      {engine.failedRuns}
                    </span>
                  </td>
                  <td className="tabular">{duration(engine.p50DurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!engines.length ? (
            <p className="empty-state">{t("tasks.observe.noRecords")}</p>
          ) : null}
        </div>
        <h2 className="section-title mt-9 mb-3">
          {t("tasks.observe.recent")}
        </h2>
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>{t("tasks.observe.task")}</th>
                <th>{t("tasks.observe.engine")}</th>
                <th>{t("tasks.observe.status")}</th>
                <th>{t("tasks.observe.duration")}</th>
                <th>Token</th>
                <th>{t("tasks.observe.cost")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview?.recentRuns.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <p
                      className="max-w-[260px] truncate"
                      title={labels.get(run.runId) ?? run.prompt}
                    >
                      {labels.get(run.runId) ??
                        (run.prompt || run.runId.slice(0, 8))}
                    </p>
                    <p className="mt-0.5 text-[12px] text-subtle">
                      {dateLabel(run.timings.acceptedAt)}
                    </p>
                  </td>
                  <td>
                    <p>{engineName(run.engineId)}</p>
                    <p
                      className="mt-0.5 max-w-[170px] truncate text-[12px] text-subtle"
                      title={run.model.actual ?? ""}
                    >
                      {modelLabel(run.model.actual)}
                    </p>
                  </td>
                  <td>
                    <Status status={run.status} />
                  </td>
                  <td className="tabular">
                    {duration(run.timings.durationMs)}
                  </td>
                  <td className="tabular">{quantity(run.tokens.total)}</td>
                  <td className="tabular">
                    {run.cost.amount == null ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      <span>
                        {run.cost.currency}{" "}
                        {formatNumber(run.cost.amount, undefined, {
                          minimumFractionDigits: 5,
                          maximumFractionDigits: 5,
                        })}
                        {run.cost.kind === "estimated" ? (
                          <span className="ml-1 text-[12px] text-subtle">
                            {t("tasks.observe.estimated")}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="w-10">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("tasks.observe.view", {
                        id: run.runId.slice(0, 8),
                      })}
                      onClick={() => inspect(run.sessionId, run.runId)}
                    >
                      <ArrowUpRight />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!overview?.recentRuns.length ? (
            <p className="empty-state">{t("tasks.observe.noRuns")}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
