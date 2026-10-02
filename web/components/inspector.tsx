"use client";
import { useState } from "react";
import {
  CircleCheck,
  Download,
  FileText,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type {
  AgentEvent,
  HarnessModelView,
  ModelCall,
  Observation,
  Run,
  Selection,
} from "@/lib/contracts";
import { engineName } from "@/lib/engines";
import {
  bytes,
  duration,
  inboundNames,
  modelEvidence,
  projectModelCalls,
  quantity,
  modelLabel,
  observationReason,
} from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { EngineAvatar } from "./engine-avatar";
import { LogPanel, LogView } from "./log-panel";
import { Status } from "./status";

export type RunPanelTab = "overview" | "model" | "files" | "logs";

/** Details of one run: overview, model-call evidence, artifacts and diagnostics. */
export function Inspector({
  run,
  observation,
  selection,
  events = [],
  unifiedModel,
  tab,
  onTabChange,
  close,
}: {
  run?: Run;
  observation?: Observation;
  selection?: Selection;
  /** Committed events of `run`, used for `model.call` evidence. */
  events?: AgentEvent[];
  /** Current unified model; comparisons are only made when it is configured. */
  unifiedModel?: HarnessModelView;
  tab: RunPanelTab;
  onTabChange: (tab: RunPanelTab) => void;
  close: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const engineId = observation?.engineId ?? selection?.engineId;
  const { calls, invalid } = projectModelCalls(events);
  return (
    <aside className="run-panel" aria-label="执行详情">
      <div className="flex h-14 shrink-0 items-center gap-2.5 pr-3 pl-5">
        {engineId ? <EngineAvatar id={engineId} /> : null}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
          {engineId ? engineName(engineId) : "执行详情"}
        </span>
        {run ? <Status status={run.status} /> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label="关闭执行详情"
        >
          <X />
        </Button>
      </div>
      {!run ? (
        <p className="empty-state">发送任务后，这里显示执行详情。</p>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as RunPanelTab)}
          className="min-h-0 flex-1"
        >
          <TabsList className="px-5">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="model">
              模型调用
              {calls.length ? (
                <span className="ml-1.5 text-[12px] text-subtle tabular">
                  {calls.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="files">
              产物
              {run.artifacts?.length ? (
                <span className="ml-1.5 text-[12px] text-subtle tabular">
                  {run.artifacts.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="logs">日志</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="overflow-y-auto px-5 py-4">
            <Overview
              run={run}
              observation={observation}
              selection={selection}
            />
          </TabsContent>
          <TabsContent value="model" className="overflow-y-auto px-5 py-4">
            <ModelCalls
              calls={calls}
              invalid={invalid}
              finished={!!run.finishedAt}
              unifiedModel={unifiedModel}
            />
          </TabsContent>
          <TabsContent value="files" className="overflow-y-auto px-5 py-4">
            {!run.artifacts?.length ? (
              <p className="empty-state">没有产物</p>
            ) : (
              <ul className="space-y-2">
                {run.artifacts.map((artifact) => (
                  <li
                    key={artifact.id}
                    className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <FileText className="size-[18px]" strokeWidth={1.6} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium">
                        {artifact.name}
                      </p>
                      <p
                        className="truncate text-[12px] text-subtle"
                        title={`SHA-256 ${artifact.sha256}`}
                      >
                        {bytes(artifact.size)} · {artifact.mediaType}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon-sm" asChild>
                      <a
                        href={api.artifactUrl(artifact.id)}
                        download={artifact.name}
                        aria-label={`下载 ${artifact.name}`}
                      >
                        <Download />
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent
            value="logs"
            className="flex min-h-0 flex-col px-5 pt-4 pb-3 data-[state=inactive]:hidden"
          >
            <LogView
              key={run.sessionId}
              sessionId={run.sessionId}
              active={!run.finishedAt}
              enabled={tab === "logs" && !logsOpen}
              compact
              onExpand={() => setLogsOpen(true)}
            />
          </TabsContent>
          <LogPanel
            key={`dialog-${run.sessionId}`}
            sessionId={run.sessionId}
            active={!run.finishedAt}
            open={logsOpen}
            onOpenChange={setLogsOpen}
          />
        </Tabs>
      )}
    </aside>
  );
}

function Overview({
  run,
  observation,
  selection,
}: {
  run: Run;
  observation: Observation | undefined;
  selection: Selection | undefined;
}) {
  const cost = observation?.cost;
  return (
    <div className="space-y-6">
      <Group title="执行">
        <Metric
          label="实际模型"
          value={modelLabel(observation?.model.actual)}
        />
        <Metric
          label="配置模型"
          value={
            observation?.model.configured
              ? modelLabel(observation.model.configured)
              : "引擎默认"
          }
        />
        <Metric
          label="开始"
          value={new Date(run.createdAt).toLocaleString("zh-CN", {
            hour12: false,
          })}
        />
        <Metric
          label="耗时"
          value={duration(observation?.timings.durationMs)}
        />
        <Metric
          label="首次输出"
          value={duration(observation?.timings.timeToFirstOutputMs)}
        />
        <Metric label="排队" value={duration(observation?.timings.queueMs)} />
      </Group>
      <Group title="用量">
        <Metric label="输入" value={quantity(observation?.tokens.input)} />
        <Metric label="输出" value={quantity(observation?.tokens.output)} />
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
        {observation?.usage.missingReason ? (
          <p className="pt-1 text-[12px] text-subtle">
            {observationReason(observation.usage.missingReason)}
          </p>
        ) : null}
      </Group>
      {selection ? (
        <Group title={selection.mode === "auto" ? "自动选择" : "引擎"}>
          <p className="text-[13px] leading-6 text-muted-foreground">
            {selection.reason}
          </p>
          {selection.mode === "auto" ? (
            <ul className="mt-2 space-y-1.5">
              {selection.candidates.map((candidate) => (
                <li
                  key={candidate.engineId}
                  className="rounded-lg bg-muted px-3 py-2 text-[12.5px]"
                >
                  <div className="flex justify-between gap-2 font-medium">
                    <span>{engineName(candidate.engineId)}</span>
                    <span className="tabular text-muted-foreground">
                      {candidate.eligible ? candidate.score : "不参与"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-5 text-subtle">
                    {candidate.reasons.join("；")}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
      ) : null}
      <Group title="记录">
        <Metric label="Run" value={run.id.slice(0, 8)} mono />
        <Metric
          label="配置版本"
          value={
            observation?.versions.profileRevision?.slice(0, 12) ?? "未提供"
          }
          mono
        />
        <Metric label="事件" value={String(run.lastSeq)} />
        <Metric
          label="进程清理"
          value={
            run.cleanupStatus === "confirmed"
              ? "已确认"
              : run.cleanupStatus === "failed"
                ? "失败"
                : "未确认"
          }
        />
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <a href={api.rolloutUrl(run.id)} download={`${run.id}.jsonl`}>
            <Download />
            导出完整轨迹
          </a>
        </Button>
        {observation?.coverage.missingReasons.length ? (
          <details className="mt-3 text-[12.5px]">
            <summary className="w-fit text-subtle hover:text-foreground">
              {observation.coverage.missingReasons.length} 项信息缺失
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
              {observation.coverage.missingReasons.map((reason) => (
                <li key={reason}>{observationReason(reason)}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Group>
    </div>
  );
}

/** Evidence built only from committed `model.call` events of this run. */
function ModelCalls({
  calls,
  invalid,
  finished,
  unifiedModel,
}: {
  calls: ModelCall[];
  invalid: number;
  finished: boolean;
  unifiedModel: HarnessModelView | undefined;
}) {
  const configured = unifiedModel?.configured ? unifiedModel.model : undefined;
  const evidence = modelEvidence(calls, configured);
  const only = evidence.models[0]?.model;
  if (evidence.verdict === "none")
    return (
      <p className="empty-state">
        {finished ? "没有模型调用记录" : "模型调用会实时出现在这里"}
      </p>
    );
  const good = evidence.verdict === "unified" || evidence.verdict === "single";
  return (
    <div className="space-y-4">
      <div className={cn("callout", good ? "good" : "warn")}>
        {good ? (
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        )}
        <span>
          {evidence.verdict === "unified"
            ? `${evidence.total} 次调用全部发往统一模型 ${only}`
            : evidence.verdict === "single"
              ? `${evidence.total} 次调用全部发往 ${only}`
              : evidence.verdict === "mismatch"
                ? `调用发往 ${only}，与当前统一模型 ${configured} 不同`
                : `调用发往多个模型：${evidence.models.map((item) => `${item.model} ×${item.count}`).join("、")}`}
          {evidence.failed ? `，其中 ${evidence.failed} 次失败` : ""}
        </span>
      </div>
      {invalid ? (
        <p className="text-[12.5px] text-warning">
          另有 {invalid} 条记录格式无法识别
        </p>
      ) : null}
      <dl>
        <Metric
          label="输入 / 输出"
          value={`${quantity(evidence.tokens.input)} / ${quantity(evidence.tokens.output)}`}
        />
        <Metric label="总耗时" value={duration(evidence.durationMs)} />
        {evidence.requested.length ? (
          <Metric label="引擎请求的名称" value={evidence.requested.join("、")} />
        ) : null}
      </dl>
      <ol className="space-y-1.5">
        {calls.map((call, index) => (
          <li
            key={`${call.id}-${index}`}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-[12.5px]",
              !call.ok && "border-danger/30 bg-danger-soft/60",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                <span className="mr-1.5 text-subtle tabular">{index + 1}</span>
                {inboundNames[call.inbound]}
              </span>
              <span className={cn("tabular", !call.ok && "text-danger")}>
                {call.status || "无响应"} · {duration(call.durationMs)}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11.5px] text-subtle">
              {call.requestedModel ?? "—"} → {call.upstreamModel}
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              输入 {quantity(call.usage?.input)} · 输出{" "}
              {quantity(call.usage?.output)}
              {call.toolCalls ? ` · 工具 ${call.toolCalls}` : ""}
              {call.finishReason ? ` · ${call.finishReason}` : ""}
            </p>
            {call.error ? (
              <p className="mt-1 text-[12px] break-words text-danger">
                {call.error.code}：{call.error.message}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-[12.5px] font-medium text-subtle">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}
function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="metric-row">
      <dt>{label}</dt>
      <dd className={cn(mono && "font-mono text-[12.5px]")}>{value}</dd>
    </div>
  );
}
