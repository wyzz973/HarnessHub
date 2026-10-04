// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Loader2, Play, Stethoscope, Wrench } from "lucide-react";
import type {
  DoctorPlan,
  DoctorReport,
  ProviderConfig,
  ProviderPatch,
  ProviderTestReport,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { exposedModels } from "@/lib/first-run";
import {
  failureOf,
  modelPlane,
  protocolNames,
  type Failure,
} from "@/lib/model-plane";
import {
  doctorCheckNames,
  doctorStatuses,
  planCost,
  statusCounts,
} from "@/lib/provider-doctor";
import { notify } from "@/lib/toast";
import { Checkbox, ConfirmDialog, ErrorCallout } from "./model-plane-ui";

type Mode = "test" | "doctor";

function TestResult({ report }: { report: ProviderTestReport }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border">
        <table className="data-table min-w-[560px]">
          <thead>
            <tr>
              <th>端点</th>
              <th>结果</th>
              <th>耗时</th>
              <th>实际模型</th>
            </tr>
          </thead>
          <tbody>
            {report.endpoints.map((endpoint) => (
              <tr key={endpoint.protocol}>
                <td>
                  <span className="block">
                    {protocolNames[endpoint.protocol]}
                  </span>
                  <span className="font-mono text-[11.5px] break-all text-subtle">
                    {endpoint.url}
                  </span>
                </td>
                <td>
                  <span className={`tag ${endpoint.ok ? "good" : "error"}`}>
                    {endpoint.ok ? "可用" : "失败"} ·{" "}
                    {endpoint.status || "无响应"}
                  </span>
                  {endpoint.error ? (
                    <span className="mt-1 block text-[12px] break-all text-danger">
                      {endpoint.error}
                    </span>
                  ) : null}
                </td>
                <td className="text-[12.5px] tabular-nums">
                  {endpoint.durationMs} ms
                  {endpoint.firstByteMs !== undefined ? (
                    <span className="block text-subtle">
                      首字节 {endpoint.firstByteMs} ms
                    </span>
                  ) : null}
                </td>
                <td className="font-mono text-[12px]">
                  {endpoint.servedModel ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        模型 {report.wireModel}；{report.modelCalls} 次调用，成本 $
        {report.costUsd.toFixed(4)}
        {report.unpricedCalls ? `（${report.unpricedCalls} 次价格未知）` : ""}
        ，记入用量的 client:doctor。
      </p>
    </div>
  );
}

function PlanView({ plan }: { plan: DoctorPlan }) {
  return (
    <div className="rounded-xl border p-3 text-[13px]">
      <p>
        经 {protocolNames[plan.protocol]} 检查模型{" "}
        <span className="font-mono">{plan.wireModel}</span>：{plan.modelCalls}{" "}
        次模型请求（失败时至多 {plan.maxModelCalls} 次）、
        {plan.listRequests} 次模型列表请求，{planCost(plan)}。
      </p>
      <p className="mt-1 text-[12px] text-subtle">
        {plan.checks
          .map((item) => `${doctorCheckNames[item.check]} ${item.modelCalls}`)
          .join(" · ")}
      </p>
    </div>
  );
}

function ReportView({ report }: { report: DoctorReport }) {
  const counts = statusCounts(report.items);
  return (
    <div className="space-y-2">
      <p className="text-[13px]">
        通过 {counts.pass}、警告 {counts.warn}、失败 {counts.fail}、跳过{" "}
        {counts.skip}；{report.modelCalls} 次请求，成本 $
        {report.costUsd.toFixed(4)}
        {report.unpricedCalls ? `（${report.unpricedCalls} 次价格未知）` : ""}
        ，用时 {(report.durationMs / 1000).toFixed(1)} 秒。
      </p>
      <ul className="divide-y rounded-xl border">
        {report.items.map((item) => {
          const status = doctorStatuses[item.status];
          return (
            <li key={item.check} className="space-y-1 px-3 py-2.5">
              <p className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className={`tag ${status.tone}`}>{status.label}</span>
                <span className="font-medium">
                  {doctorCheckNames[item.check]}
                </span>
                <span className="min-w-0 text-muted-foreground">
                  {item.summary}
                </span>
              </p>
              {item.details.length ? (
                <ul className="space-y-0.5 pl-1 font-mono text-[11.5px] break-all text-subtle">
                  {item.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
              {item.excerpt || item.url ? (
                <p className="font-mono text-[11.5px] break-all text-danger">
                  {item.httpStatus ? `HTTP ${item.httpStatus} ` : ""}
                  {item.url ? `${item.url} ` : ""}
                  {item.excerpt ?? ""}
                </p>
              ) : null}
              {item.suggestions.length ? (
                <pre className="overflow-x-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[11.5px]">
                  {item.suggestions.join("\n")}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Test a provider's endpoints or run the doctor against its upstream. Both
 * send real, billed requests, recorded in the ledger under `client:doctor`:
 * the doctor shows its plan (requests and cost) first and runs only on the
 * click after it. Its proposed patch is applied only after confirming.
 */
export function ProviderDoctorDialog({
  provider,
  onClose,
  onPatched,
}: {
  provider: ProviderConfig;
  onClose: () => void;
  onPatched: () => void;
}) {
  const models = exposedModels(provider).map((ref) =>
    ref.slice(provider.id.length + 1),
  );
  const [mode, setMode] = useState<Mode>("test");
  const [model, setModel] = useState(models[0] ?? "");
  const [deep, setDeep] = useState(false);
  const [slowMs, setSlowMs] = useState("10000");
  const [test, setTest] = useState<ProviderTestReport | null>(null);
  const [plan, setPlan] = useState<DoctorPlan | null>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [patching, setPatching] = useState(false);
  const slow = Number(slowMs);
  const options = {
    ...(model ? { model } : {}),
    ...(deep ? { deep: true } : {}),
    ...(Number.isInteger(slow) && slow > 0 && slow !== 10000
      ? { slowMs: slow }
      : {}),
  };
  const optionsKey = JSON.stringify(options);
  // The plan of the current choices; nothing is sent to the upstream.
  useEffect(() => {
    if (mode !== "doctor") return;
    let current = true;
    setPlan(null);
    setReport(null);
    setFailure(null);
    modelPlane()
      .providers.doctor(provider.id, {
        ...JSON.parse(optionsKey),
        dryRun: true,
      })
      .then(
        (value) => {
          if (current) setPlan(value.plan);
        },
        (reason: unknown) => {
          if (current) setFailure(failureOf(reason));
        },
      );
    return () => {
      current = false;
    };
  }, [mode, optionsKey, provider.id]);
  const run = () => {
    setBusy(true);
    setFailure(null);
    const client = modelPlane();
    if (mode === "test") {
      setTest(null);
      client.providers
        .test(provider.id, model ? { model } : {})
        .then(
          (value) => setTest(value),
          (reason: unknown) => setFailure(failureOf(reason)),
        )
        .finally(() => setBusy(false));
      return;
    }
    setReport(null);
    client.providers
      .doctor(provider.id, options)
      .then(
        (value) => setReport(value as DoctorReport),
        (reason: unknown) => setFailure(failureOf(reason)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[760px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>检测 {provider.name}</DialogTitle>
          <DialogDescription>
            向上游发送真实请求，会消耗额度；每个请求记入用量（client:doctor）。检测从不修改
            provider。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="segmented" role="tablist" aria-label="检测方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "test"}
              disabled={busy}
              onClick={() => setMode("test")}
            >
              测试端点
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "doctor"}
              disabled={busy}
              onClick={() => setMode("doctor")}
            >
              体检
            </button>
          </div>
          <label className="field-label min-w-[220px] flex-1">
            模型
            <select
              className="field font-mono text-[13px]"
              value={model}
              disabled={busy}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
        {mode === "test" ? (
          <p className="text-[13px] text-muted-foreground">
            对每个声明的端点发一个最小的非流式请求（输出上限 16
            token），列出状态、耗时与上游自报的模型。
          </p>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              逐项检查端点、Key
              的发送方式、模型列表、流式、usage、输出上限字段、工具、推理回传、可选字段、图片、延迟等，给出结论、上游错误与建议；建议的修改可以在确认后应用。
            </p>
            <div className="grid gap-x-3 sm:grid-cols-[1fr_200px] sm:items-end">
              <Checkbox checked={deep} onChange={setDeep} disabled={busy}>
                另发一个超过上下文窗口的输入，检查超长的识别（费用较高）
              </Checkbox>
              <label className="field-label">
                慢响应阈值（毫秒）
                <input
                  className="field tabular-nums"
                  inputMode="numeric"
                  value={slowMs}
                  disabled={busy}
                  onChange={(event) => setSlowMs(event.target.value)}
                />
              </label>
            </div>
            {plan ? <PlanView plan={plan} /> : null}
          </>
        )}
        <ErrorCallout failure={failure} />
        {mode === "test" && test ? <TestResult report={test} /> : null}
        {mode === "doctor" && report ? <ReportView report={report} /> : null}
        {mode === "doctor" && report?.patch ? (
          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-[13px]">
              建议对 provider 的修改（合并后的 JSON Merge Patch）：
            </p>
            <pre className="max-h-[30vh] overflow-auto rounded-lg bg-muted p-2.5 font-mono text-[12px]">
              {JSON.stringify(report.patch, null, 2)}
            </pre>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setPatching(true)}>
                <Wrench />
                应用建议的修改
              </Button>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button
            disabled={busy || !model || (mode === "doctor" && !plan)}
            onClick={run}
          >
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : mode === "test" ? (
              <Play />
            ) : (
              <Stethoscope />
            )}
            {mode === "test" ? "开始测试" : "开始体检"}
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={patching}
          title={`修改 ${provider.name}`}
          description="按体检的建议修改 provider 的设置（PATCH /providers/{id}）；模型元数据的建议不在其中，以上面的命令设置。修改后可以再体检一次确认。"
          action="应用"
          onClose={() => setPatching(false)}
          onConfirm={async () => {
            if (!report?.patch) return;
            await modelPlane().providers.update(
              provider.id,
              report.patch as ProviderPatch,
            );
            notify.success(`已修改 ${provider.name}`);
            setReport(null);
            onPatched();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
