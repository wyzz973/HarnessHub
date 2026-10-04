// SPDX-License-Identifier: MIT
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
  finishReasonText,
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
import { formatDateTime, formatNumber, t } from "@/lib/i18n";

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
    <aside className="run-panel" aria-label={t("tasks.inspector.title")}>
      <div className="flex h-14 shrink-0 items-center gap-2.5 pr-3 pl-5">
        {engineId ? <EngineAvatar id={engineId} /> : null}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
          {engineId ? engineName(engineId) : t("tasks.inspector.title")}
        </span>
        {run ? <Status status={run.status} /> : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label={t("tasks.inspector.close")}
        >
          <X />
        </Button>
      </div>
      {!run ? (
        <p className="empty-state">{t("tasks.inspector.empty")}</p>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as RunPanelTab)}
          className="min-h-0 flex-1"
        >
          <TabsList className="px-5">
            <TabsTrigger value="overview">
              {t("tasks.inspector.overview")}
            </TabsTrigger>
            <TabsTrigger value="model">
              {t("tasks.inspector.modelCalls")}
              {calls.length ? (
                <span className="ml-1.5 text-[12px] text-subtle tabular">
                  {calls.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="files">
              {t("tasks.inspector.artifacts")}
              {run.artifacts?.length ? (
                <span className="ml-1.5 text-[12px] text-subtle tabular">
                  {run.artifacts.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="logs">{t("tasks.inspector.logs")}</TabsTrigger>
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
              <p className="empty-state">{t("tasks.inspector.noArtifacts")}</p>
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
                        aria-label={t("tasks.inspector.download", {
                          name: artifact.name,
                        })}
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
      <Group title={t("tasks.inspector.run")}>
        <Metric
          label={t("tasks.inspector.actualModel")}
          value={modelLabel(observation?.model.actual)}
        />
        <Metric
          label={t("tasks.inspector.configuredModel")}
          value={
            observation?.model.configured
              ? modelLabel(observation.model.configured)
              : t("tasks.inspector.engineDefault")
          }
        />
        <Metric
          label={t("tasks.inspector.started")}
          value={formatDateTime(run.createdAt)}
        />
        <Metric
          label={t("tasks.inspector.duration")}
          value={duration(observation?.timings.durationMs)}
        />
        <Metric
          label={t("tasks.inspector.firstOutput")}
          value={duration(observation?.timings.timeToFirstOutputMs)}
        />
        <Metric
          label={t("tasks.inspector.queue")}
          value={duration(observation?.timings.queueMs)}
        />
      </Group>
      <Group title={t("tasks.inspector.usage")}>
        <Metric
          label={t("tasks.inspector.input")}
          value={quantity(observation?.tokens.input)}
        />
        <Metric
          label={t("tasks.inspector.output")}
          value={quantity(observation?.tokens.output)}
        />
        <Metric
          label={t("tasks.inspector.cacheRead")}
          value={quantity(observation?.tokens.cacheRead)}
        />
        <Metric
          label={t("tasks.inspector.cost")}
          value={
            cost?.amount == null
              ? t("common.notProvided")
              : t(
                  cost.kind === "estimated"
                    ? "tasks.inspector.costEstimated"
                    : "tasks.inspector.costValue",
                  {
                    currency: cost.currency ?? "",
                    amount: formatNumber(cost.amount, undefined, {
                      minimumFractionDigits: 6,
                      maximumFractionDigits: 6,
                    }),
                  },
                ).trim()
          }
        />
        {observation?.usage.missingReason ? (
          <p className="pt-1 text-[12px] text-subtle">
            {observationReason(observation.usage.missingReason)}
          </p>
        ) : null}
      </Group>
      {selection ? (
        <Group
          title={
            selection.mode === "auto"
              ? t("tasks.inspector.autoSelection")
              : t("tasks.inspector.engine")
          }
        >
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
                      {candidate.eligible
                        ? candidate.score
                        : t("tasks.inspector.notEligible")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-5 text-subtle">
                    {candidate.reasons.join(t("tasks.reasonSeparator"))}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
      ) : null}
      <Group title={t("tasks.inspector.records")}>
        <Metric label="Run" value={run.id.slice(0, 8)} mono />
        <Metric
          label={t("tasks.inspector.profileRevision")}
          value={
            observation?.versions.profileRevision?.slice(0, 12) ??
            t("common.notProvided")
          }
          mono
        />
        <Metric label={t("tasks.inspector.events")} value={String(run.lastSeq)} />
        <Metric
          label={t("tasks.inspector.cleanup")}
          value={
            run.cleanupStatus === "confirmed"
              ? t("tasks.inspector.cleanupConfirmed")
              : run.cleanupStatus === "failed"
                ? t("tasks.inspector.cleanupFailed")
                : t("tasks.inspector.cleanupUnconfirmed")
          }
        />
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <a href={api.rolloutUrl(run.id)} download={`${run.id}.jsonl`}>
            <Download />
            {t("tasks.inspector.exportTrace")}
          </a>
        </Button>
        {observation?.coverage.missingReasons.length ? (
          <details className="mt-3 text-[12.5px]">
            <summary className="w-fit text-subtle hover:text-foreground">
              {t("tasks.inspector.missing", {
                n: observation.coverage.missingReasons.length,
              })}
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
        {finished ? t("tasks.calls.none") : t("tasks.calls.live")}
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
            ? t("tasks.calls.unified", {
                n: evidence.total,
                model: only ?? "",
              })
            : evidence.verdict === "single"
              ? t("tasks.calls.single", {
                  n: evidence.total,
                  model: only ?? "",
                })
              : evidence.verdict === "mismatch"
                ? t("tasks.calls.mismatch", {
                    model: only ?? "",
                    configured: configured ?? "",
                  })
                : t("tasks.calls.mixed", {
                    models: evidence.models
                      .map((item) => `${item.model} ×${item.count}`)
                      .join(t("tasks.separator")),
                  })}
          {evidence.failed
            ? t("tasks.calls.failed", { n: evidence.failed })
            : ""}
        </span>
      </div>
      {invalid ? (
        <p className="text-[12.5px] text-warning">
          {t("tasks.calls.invalid", { n: invalid })}
        </p>
      ) : null}
      <dl>
        <Metric
          label={t("tasks.calls.inputOutput")}
          value={`${quantity(evidence.tokens.input)} / ${quantity(evidence.tokens.output)}`}
        />
        <Metric
          label={t("tasks.calls.totalDuration")}
          value={duration(evidence.durationMs)}
        />
        {evidence.requested.length ? (
          <Metric
            label={t("tasks.calls.requested")}
            value={evidence.requested.join(t("tasks.separator"))}
          />
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
                {call.status || t("tasks.calls.noResponse")} ·{" "}
                {duration(call.durationMs)}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11.5px] text-subtle">
              {call.requestedModel ?? "—"} → {call.upstreamModel}
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {[
                t("tasks.calls.input", { n: quantity(call.usage?.input) }),
                t("tasks.calls.output", { n: quantity(call.usage?.output) }),
                ...(call.toolCalls
                  ? [t("tasks.calls.tools", { n: call.toolCalls })]
                  : []),
                ...(call.finishReason
                  ? [finishReasonText(call.finishReason)]
                  : []),
              ].join(" · ")}
            </p>
            {call.error ? (
              <p className="mt-1 text-[12px] break-words text-danger">
                {t("tasks.calls.error", {
                  code: call.error.code,
                  message: call.error.message,
                })}
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
