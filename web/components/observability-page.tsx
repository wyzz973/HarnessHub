"use client";
import { Activity, ArrowUpRight, Gauge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Overview, Workflow } from "@/lib/contracts";
import { dateLabel, duration, quantity, modelLabel } from "@/lib/presentation";
import { Status } from "./status";
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
        `规划 · ${workflow.title ?? workflow.goal}`,
      );
    for (const step of workflow.steps)
      if (step.runId) labels.set(step.runId, step.title);
  }
  return (
    <div className="page-body enter">
      <div className="mx-auto max-w-[1040px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] tracking-wider text-muted-foreground">
              <Activity className="size-3.5" />
              OBSERVABILITY
            </div>
            <h1 className="page-heading">每一次执行，清晰可见。</h1>
            <p className="mt-3 text-[13px] text-muted-foreground">
              从真实运行记录中了解性能、用量和引擎表现。
            </p>
          </div>
          <Button
            className="mt-6"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            刷新
          </Button>
        </div>
        <div className="stats-grid">
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">总执行次数</p>
            <p className="mt-3 text-3xl font-medium tabular">
              {quantity(summary?.totalRuns)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {summary ? `${summary.activeRuns} 个正在执行` : "读取持久记录"}
            </p>
          </div>
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">正常结束</p>
            <p className="mt-3 text-3xl font-medium tabular text-[#5a7950]">
              {quantity(summary?.completedRuns)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              执行结束，评分独立计算
            </p>
          </div>
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">P50 / P95 耗时</p>
            <p className="mt-3 text-xl font-medium tabular">
              {duration(summary?.p50DurationMs)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              P95 · {duration(summary?.p95DurationMs)}
            </p>
          </div>
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">已观测 Token</p>
            <p className="mt-3 text-3xl font-medium tabular">
              {quantity(summary?.knownTotalTokens)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              覆盖{" "}
              {summary?.usageCoverage == null
                ? "未提供"
                : `${Math.round(summary.usageCoverage * 100)}%`}{" "}
              的样本
            </p>
          </div>
        </div>
        <div className="mt-5 flex items-start gap-2.5 rounded-lg bg-[#f6f8f2] px-4 py-3 text-[11px] leading-6 text-muted-foreground">
          <Gauge className="mt-1 size-3.5 shrink-0" />
          <span>
            状态计数覆盖全部任务；耗时与用量基于最近{" "}
            {overview?.scope.sampledRuns ?? 0} 次执行。未返回的 Token
            和费用显示为“未提供”，不会计为零。
          </span>
        </div>
        <div className="mt-9 mb-4 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">引擎运行概况</h2>
          <span className="text-[10px] text-muted-foreground">
            当前负载与历史表现
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="data-table min-w-[560px]">
            <thead>
              <tr>
                <th>引擎</th>
                <th>执行中 / 容量</th>
                <th>排队</th>
                <th>完成 / 失败</th>
                <th>P50 耗时</th>
              </tr>
            </thead>
            <tbody>
              {overview?.engines.map((engine) => (
                <tr key={engine.id}>
                  <td className="font-medium">{engine.id}</td>
                  <td className="tabular">
                    {engine.activeRuns} / {engine.maxConcurrency}
                  </td>
                  <td className="tabular">{engine.queuedRuns}</td>
                  <td className="tabular">
                    <span className="text-[#59764f]">
                      {engine.completedRuns}
                    </span>{" "}
                    / {engine.failedRuns}
                  </td>
                  <td className="tabular">{duration(engine.p50DurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!overview?.engines.length ? (
            <p className="empty-note">暂无引擎运行记录</p>
          ) : null}
        </div>
        <div className="mt-9 mb-4 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">最近执行</h2>
          <span className="text-[10px] text-muted-foreground">
            {overview ? `${dateLabel(overview.generatedAt)} 更新` : ""}
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>任务 / Run</th>
                <th>引擎 / 实际模型</th>
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
                      className="max-w-[205px] truncate text-xs"
                      title={labels.get(run.runId) ?? run.prompt}
                    >
                      {labels.get(run.runId) ??
                        (run.prompt || run.runId.slice(0, 8))}
                    </p>
                    <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                      {run.runId.slice(0, 8)} ·{" "}
                      {dateLabel(run.timings.acceptedAt)}
                    </p>
                  </td>
                  <td>
                    <p>{run.engineId}</p>
                    <p
                      className="mt-1.5 max-w-[165px] truncate text-[10px] text-muted-foreground"
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
                      <span className="text-muted-foreground">未提供</span>
                    ) : (
                      <span>
                        {run.cost.currency} {run.cost.amount.toFixed(5)}
                        {run.cost.kind === "estimated" ? (
                          <span className="mt-1 block text-[9px] text-muted-foreground">
                            估算
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`查看执行 ${run.runId.slice(0, 8)}`}
                      onClick={() => inspect(run.sessionId, run.runId)}
                    >
                      <ArrowUpRight className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!overview?.recentRuns.length ? (
            <p className="empty-note">开始一个任务，观测信息会出现在这里。</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
