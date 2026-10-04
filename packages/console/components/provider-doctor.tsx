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
import { formatUsd, t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import {
  doctorCheckName,
  doctorStatus,
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
              <th>{t("providers.doctor.endpoint")}</th>
              <th>{t("providers.doctor.result")}</th>
              <th>{t("providers.doctor.duration")}</th>
              <th>{t("providers.doctor.servedModel")}</th>
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
                    {endpoint.ok
                      ? t("providers.doctor.ok")
                      : t("providers.doctor.failed")}{" "}
                    · {endpoint.status || t("providers.doctor.noResponse")}
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
                      {t("providers.doctor.firstByte", {
                        ms: endpoint.firstByteMs,
                      })}
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
        {t("providers.doctor.testSummary", {
          model: report.wireModel,
          calls: report.modelCalls,
          cost: formatUsd(Number(report.costUsd.toFixed(4))),
          unpriced: report.unpricedCalls
            ? t("providers.doctor.unpriced", { n: report.unpricedCalls })
            : "",
        })}
      </p>
    </div>
  );
}

function PlanView({ plan }: { plan: DoctorPlan }) {
  return (
    <div className="rounded-xl border p-3 text-[13px]">
      <p>
        {tr("providers.doctor.plan", {
          protocol: protocolNames[plan.protocol],
          model: <span className="font-mono">{plan.wireModel}</span>,
          calls: plan.modelCalls,
          max: plan.maxModelCalls,
          lists: plan.listRequests,
          cost: planCost(plan),
        })}
      </p>
      <p className="mt-1 text-[12px] text-subtle">
        {plan.checks
          .map((item) => `${doctorCheckName(item.check)} ${item.modelCalls}`)
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
        {t("providers.doctor.reportSummary", {
          pass: counts.pass,
          warn: counts.warn,
          fail: counts.fail,
          skip: counts.skip,
          calls: report.modelCalls,
          cost: formatUsd(Number(report.costUsd.toFixed(4))),
          unpriced: report.unpricedCalls
            ? t("providers.doctor.unpriced", { n: report.unpricedCalls })
            : "",
          seconds: (report.durationMs / 1000).toFixed(1),
        })}
      </p>
      <ul className="divide-y rounded-xl border">
        {report.items.map((item) => {
          const status = doctorStatus(item.status);
          return (
            <li key={item.check} className="space-y-1 px-3 py-2.5">
              <p className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className={`tag ${status.tone}`}>{status.label}</span>
                <span className="font-medium">
                  {doctorCheckName(item.check)}
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
          <DialogTitle>
            {t("providers.doctor.title", { name: provider.name })}
          </DialogTitle>
          <DialogDescription>{t("providers.doctor.lede")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div
            className="segmented"
            role="tablist"
            aria-label={t("providers.doctor.mode")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "test"}
              disabled={busy}
              onClick={() => setMode("test")}
            >
              {t("providers.doctor.test")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "doctor"}
              disabled={busy}
              onClick={() => setMode("doctor")}
            >
              {t("providers.doctor.doctor")}
            </button>
          </div>
          <label className="field-label min-w-[220px] flex-1">
            {t("providers.models")}
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
            {t("providers.doctor.testLede")}
          </p>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground">
              {t("providers.doctor.doctorLede")}
            </p>
            <div className="grid gap-x-3 sm:grid-cols-[1fr_200px] sm:items-end">
              <Checkbox checked={deep} onChange={setDeep} disabled={busy}>
                {t("providers.doctor.deep")}
              </Checkbox>
              <label className="field-label">
                {t("providers.doctor.slowMs")}
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
            <p className="text-[13px]">{t("providers.doctor.patchLede")}</p>
            <pre className="max-h-[30vh] overflow-auto rounded-lg bg-muted p-2.5 font-mono text-[12px]">
              {JSON.stringify(report.patch, null, 2)}
            </pre>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setPatching(true)}>
                <Wrench />
                {t("providers.doctor.applyPatch")}
              </Button>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.close")}
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
            {mode === "test"
              ? t("providers.doctor.startTest")
              : t("providers.doctor.startDoctor")}
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={patching}
          title={t("providers.doctor.patchTitle", { name: provider.name })}
          description={t("providers.doctor.patchBody", {
            request: "PATCH /providers/{id}",
          })}
          action={t("providers.doctor.apply")}
          onClose={() => setPatching(false)}
          onConfirm={async () => {
            if (!report?.patch) return;
            await modelPlane().providers.update(
              provider.id,
              report.patch as ProviderPatch,
            );
            notify.success(
              t("providers.doctor.patched", { name: provider.name }),
            );
            setReport(null);
            onPatched();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
