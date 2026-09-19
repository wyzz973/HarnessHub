"use client";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Overview, Workflow } from "@/lib/contracts";
import { engineName } from "@/lib/engines";
import { dateLabel, duration, quantity, modelLabel } from "@/lib/presentation";
import { EngineAvatar } from "./engine-avatar";
import { Status } from "./status";

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
        `计划 · ${workflow.title ?? workflow.goal}`,
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
            <h1 className="page-title">观测</h1>
            <p className="page-lede">
              {overview
                ? `基于最近 ${overview.scope.sampledRuns} 次执行，${dateLabel(overview.generatedAt)} 更新。`
                : "执行耗时、用量与引擎负载。"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            刷新
          </Button>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="执行次数"
            value={quantity(summary?.totalRuns)}
            {...(summary ? { note: `${summary.activeRuns} 个进行中` } : {})}
          />
          <Stat
            label="已完成"
            value={quantity(summary?.completedRuns)}
            {...(summary
              ? {
                  note: `${summary.failedRuns + summary.timedOutRuns + summary.interruptedRuns} 个失败`,
                }
              : {})}
          />
          <Stat
            label="耗时中位数"
            value={duration(summary?.p50DurationMs)}
            {...(summary
              ? { note: `P95 ${duration(summary.p95DurationMs)}` }
              : {})}
          />
          <Stat
            label="Token"
            value={quantity(summary?.knownTotalTokens)}
            {...(summary?.usageCoverage != null
              ? { note: `覆盖 ${Math.round(summary.usageCoverage * 100)}% 的执行` }
              : {})}
          />
        </div>
        <h2 className="section-title mt-9 mb-3">引擎</h2>
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[560px]">
            <thead>
              <tr>
                <th>引擎</th>
                <th>进行中 / 并发上限</th>
                <th>排队</th>
                <th>完成 / 失败</th>
                <th>耗时中位数</th>
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
          {!engines.length ? <p className="empty-state">还没有记录</p> : null}
        </div>
        <h2 className="section-title mt-9 mb-3">最近执行</h2>
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>任务</th>
                <th>引擎</th>
                <th>状态</th>
                <th>耗时</th>
                <th>Token</th>
                <th>费用</th>
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
                        {run.cost.currency} {run.cost.amount.toFixed(5)}
                        {run.cost.kind === "estimated" ? (
                          <span className="ml-1 text-[12px] text-subtle">
                            估算
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="w-10">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`查看执行 ${run.runId.slice(0, 8)}`}
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
            <p className="empty-state">还没有执行记录</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
