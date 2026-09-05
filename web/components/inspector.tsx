"use client";
import {
  Activity,
  ArrowUpRight,
  Box,
  ChevronRight,
  Download,
  File,
  Fingerprint,
  PanelRightClose,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Artifact,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import { api } from "@/lib/api";
import type { Observation, Run, Selection } from "@/lib/contracts";
import {
  bytes,
  duration,
  quantity,
  modelLabel,
  observationReason,
} from "@/lib/presentation";
import { Status } from "./status";

export function Inspector({
  run,
  observation,
  selection,
  close,
}: {
  run?: Run;
  observation?: Observation;
  selection?: Selection;
  close: () => void;
}) {
  const cost = observation?.cost;
  return (
    <aside className="inspector enter" aria-label="执行详情">
      <div className="flex h-16 items-center justify-between border-b px-5">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <Activity className="size-4 text-muted-foreground" />
          执行详情
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label="收起执行详情"
        >
          <PanelRightClose />
        </Button>
      </div>
      {!run ? (
        <div className="px-6 py-12">
          <div className="mb-5 grid size-10 place-items-center rounded-xl border bg-white">
            <Activity className="size-4 text-muted-foreground" />
          </div>
          <p className="text-[13px] font-medium">让每次执行都有迹可循</p>
          <p className="mt-3 text-xs leading-7 text-muted-foreground">
            任务开始后，这里会显示实际模型、耗时、用量和产物。
          </p>
          <div className="mt-8 space-y-5 text-xs text-muted-foreground">
            <div className="flex gap-3">
              <Fingerprint className="size-4" />
              固定引擎与配置版本
            </div>
            <div className="flex gap-3">
              <ShieldCheck className="size-4" />
              引擎请求授权时由你确认
            </div>
            <div className="flex gap-3">
              <Box className="size-4" />
              产物可下载与追溯
            </div>
          </div>
        </div>
      ) : (
        <>
          <section className="inspector-section">
            <div className="mb-4 flex items-center justify-between">
              <span className="section-label">当前执行</span>
              <Status status={run.status} />
            </div>
            <dl>
              <Metric
                label="引擎"
                value={observation?.engineId ?? selection?.engineId ?? "读取中"}
              />
              <Metric
                label="实际模型"
                value={modelLabel(observation?.model.actual)}
              />
              <Metric
                label="配置模型"
                value={
                  observation?.model.configured
                    ? modelLabel(observation.model.configured)
                    : "默认配置"
                }
              />
              <Metric
                label="开始时间"
                value={new Date(run.createdAt).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              />
            </dl>
            {selection && (
              <details className="mt-3 text-xs">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground">
                  <ChevronRight className="size-3" />
                  {selection.mode === "auto" ? "自动选择依据" : "引擎选择"}
                </summary>
                <p className="mt-3 leading-6 text-muted-foreground">
                  {selection.reason}
                </p>
                <div className="mt-3 space-y-2">
                  {selection.candidates.map((candidate) => (
                    <div
                      key={candidate.engineId}
                      className="rounded-md border p-2"
                    >
                      <div className="flex justify-between gap-2 font-medium">
                        <span>{candidate.engineId}</span>
                        <span>
                          {candidate.eligible ? candidate.score : "不参与"}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] leading-5 text-muted-foreground">
                        {candidate.reasons.join("；")}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>
          <section className="inspector-section">
            <p className="section-label mb-3">性能与用量</p>
            <dl>
              <Metric
                label="总耗时"
                value={duration(observation?.timings.durationMs)}
              />
              <Metric
                label="首字响应"
                value={duration(observation?.timings.timeToFirstOutputMs)}
              />
              <Metric
                label="排队"
                value={duration(observation?.timings.queueMs)}
              />
              <Metric
                label="输入 Token"
                value={quantity(observation?.tokens.input)}
              />
              <Metric
                label="输出 Token"
                value={quantity(observation?.tokens.output)}
              />
              <Metric
                label="缓存读取"
                value={quantity(observation?.tokens.cacheRead)}
              />
              <Metric
                label="费用"
                value={
                  cost?.amount == null
                    ? "未提供"
                    : `${cost.currency ?? ""} ${cost.amount.toFixed(6)}${cost.kind === "estimated" ? "（估算）" : ""}`
                }
              />
            </dl>
            {observation && (
              <p className="mt-3 text-[11px] leading-6 text-muted-foreground">
                {observation.usage.missingReason
                  ? observationReason(observation.usage.missingReason)
                  : `用量来源：${observationReason(observation.usage.source ?? "未提供")}`}
                。估算费用不等于实际账单。
              </p>
            )}
          </section>
          <section className="inspector-section">
            <div className="mb-4 flex items-center justify-between">
              <p className="section-label">任务产物</p>
              <span className="text-[11px] text-muted-foreground">
                {run.artifacts?.length ?? 0} 个
              </span>
            </div>
            {!run.artifacts?.length ? (
              <p className="text-xs leading-6 text-muted-foreground">
                暂无已登记产物。文件完成采集后会显示在这里。
              </p>
            ) : (
              <div className="space-y-2">
                {run.artifacts.map((artifact) => (
                  <Artifact
                    key={artifact.id}
                    className="rounded-lg shadow-none"
                  >
                    <ArtifactHeader className="border-0 bg-white px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <File className="size-4 shrink-0 text-muted-foreground" />
                        <ArtifactTitle className="truncate text-xs">
                          {artifact.name}
                        </ArtifactTitle>
                      </div>
                      <a
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted"
                        href={api.artifactUrl(artifact.id)}
                        download={artifact.name}
                        aria-label={`下载 ${artifact.name}`}
                      >
                        <Download className="size-3.5" />
                      </a>
                    </ArtifactHeader>
                    <ArtifactContent className="pt-0 pb-3 px-3 text-[10px] text-muted-foreground">
                      {bytes(artifact.size)} · {artifact.mediaType}
                      <span
                        className="mt-1 block truncate font-mono"
                        title={artifact.sha256}
                      >
                        SHA256 {artifact.sha256.slice(0, 16)}…
                      </span>
                    </ArtifactContent>
                  </Artifact>
                ))}
              </div>
            )}
          </section>
          <section className="inspector-section">
            <p className="section-label mb-3">可追溯记录</p>
            <dl>
              <Metric label="Run" value={run.id.slice(0, 8)} />
              <Metric
                label="配置版本"
                value={
                  observation?.versions.profileRevision?.slice(0, 12) ??
                  "未提供"
                }
              />
              <Metric label="事件数量" value={String(run.lastSeq)} />
              <Metric
                label="清理状态"
                value={
                  run.cleanupStatus === "confirmed"
                    ? "已确认"
                    : run.cleanupStatus === "failed"
                      ? "清理失败"
                      : "未确认"
                }
              />
            </dl>
            <a
              href={api.rolloutUrl(run.id)}
              className="mt-4 flex items-center gap-2 text-xs text-primary"
              download={`${run.id}.jsonl`}
            >
              导出完整轨迹
              <ArrowUpRight className="size-3" />
            </a>
            {observation?.coverage.missingReasons.length ? (
              <details className="mt-4 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  {observation.coverage.missingReasons.length} 项观测信息缺失
                </summary>
                <ul className="mt-2 space-y-2 pl-4 leading-6 text-muted-foreground">
                  {observation.coverage.missingReasons.map((reason) => (
                    <li key={reason}>{observationReason(reason)}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        </>
      )}
    </aside>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
