// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type {
  BudgetPeriod,
  GatewayKeyLimit,
  GatewayKeyView,
  KeyBudgetStatus,
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
import { formatNumber, formatUsd, t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import {
  budgetPeriodName,
  budgetUse,
  quotaFormOf,
  quotaOf,
  type QuotaForm,
} from "@/lib/routing";
import {
  ErrorCallout,
  LoadError,
  LocalTime,
  OtherFieldErrors,
} from "./model-plane-ui";

const periods: readonly BudgetPeriod[] = ["day", "week", "month"];

/**
 * Requests per minute and one budget per calendar window (the daemon's
 * local day, week from Monday, month from the 1st): tokens and/or an
 * estimated cost, 0 refusing every call of the window.
 */
export function QuotaFields({
  form,
  onChange,
  problems,
}: {
  form: QuotaForm;
  onChange: (form: QuotaForm) => void;
  /** Problems found in the form, by field (`rpm`, `day.tokens`, `week`…). */
  problems: Record<string, string>;
}) {
  const budget = (
    period: BudgetPeriod,
    patch: Partial<QuotaForm["budgets"][BudgetPeriod]>,
  ) =>
    onChange({
      ...form,
      budgets: {
        ...form.budgets,
        [period]: { ...form.budgets[period], ...patch },
      },
    });
  const problem = (field: string) =>
    problems[field] ? (
      <span role="alert" className="field-hint block text-danger">
        {problems[field]}
      </span>
    ) : null;
  return (
    <fieldset className="space-y-3">
      <legend className="field-label mb-1">{t("routing.quota.legend")}</legend>
      <label className="field-label">
        {t("routing.quota.rpmLabel")}
        <input
          className="field w-[160px]"
          inputMode="numeric"
          value={form.rpm}
          placeholder={t("routing.quota.noLimit")}
          onChange={(event) => onChange({ ...form, rpm: event.target.value })}
        />
        {problem("rpm")}
      </label>
      <div className="space-y-2 rounded-xl border p-3">
        <p className="text-[12.5px] text-muted-foreground">
          {t("routing.quota.explain")}
        </p>
        {periods.map((period) => {
          const fields = form.budgets[period];
          return (
            <div key={period} className="space-y-1.5">
              <label className="flex items-center gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  className="size-4 accent-(--primary)"
                  checked={fields.on}
                  onChange={(event) =>
                    budget(period, { on: event.target.checked })
                  }
                />
                {t("routing.quota.budgetOf", {
                  period: budgetPeriodName(period),
                })}
              </label>
              {fields.on ? (
                <div className="grid gap-2 pl-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <label className="field-label">
                    {t("routing.quota.tokenCap")}
                    <input
                      className="field"
                      inputMode="numeric"
                      aria-label={t("routing.quota.tokenCapOf", {
                        period: budgetPeriodName(period),
                      })}
                      value={fields.tokens}
                      placeholder={t("routing.quota.noLimit")}
                      onChange={(event) =>
                        budget(period, { tokens: event.target.value })
                      }
                    />
                    {problem(`${period}.tokens`)}
                  </label>
                  <label className="field-label">
                    {t("routing.quota.costCap")}
                    <input
                      className="field"
                      inputMode="decimal"
                      aria-label={t("routing.quota.costCapOf", {
                        period: budgetPeriodName(period),
                      })}
                      value={fields.cost}
                      placeholder={t("routing.quota.noLimit")}
                      onChange={(event) =>
                        budget(period, { cost: event.target.value })
                      }
                    />
                    {problem(`${period}.cost`)}
                  </label>
                  <label className="flex min-h-9 items-center gap-2 text-[12.5px]">
                    <input
                      type="checkbox"
                      className="size-4 accent-(--primary)"
                      checked={fields.cacheReads}
                      onChange={(event) =>
                        budget(period, { cacheReads: event.target.checked })
                      }
                    />
                    {t("routing.quota.cacheReads")}
                  </label>
                  <span className="sm:col-span-3">{problem(period)}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Replace a key's quota (`PUT /gateway-keys/{id}/quota`); it applies from the key's next request. */
export function QuotaDialog({
  gatewayKey,
  onClose,
  onSaved,
}: {
  gatewayKey: GatewayKeyView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() => quotaFormOf(gatewayKey.quota));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  async function save() {
    const read = quotaOf(form);
    if (!read.ok) {
      setProblems(read.problems);
      return;
    }
    setProblems({});
    setBusy(true);
    setFailure(null);
    try {
      await modelPlane().gatewayKeys.setQuota(
        gatewayKey.keyId,
        read.quota ?? {},
      );
      onSaved();
    } catch (reason) {
      setFailure(failureOf(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {t("routing.quota.dialogTitle", { name: gatewayKey.name })}
          </DialogTitle>
          <DialogDescription>{t("routing.quota.dialogLede")}</DialogDescription>
        </DialogHeader>
        <QuotaFields form={form} onChange={setForm} problems={problems} />
        <ErrorCallout failure={failure} />
        <OtherFieldErrors failure={failure} shown={[]} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("routing.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Meter({
  label,
  used,
  held,
  limit,
  share,
  format,
}: {
  label: string;
  used: number;
  held: number;
  limit: number;
  share: number;
  format: (value: number) => string;
}) {
  const percent = Math.round(share * 100);
  return (
    <div>
      <div className="flex justify-between text-[12.5px]">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {format(used)}
          {held
            ? t("routing.budget.held", { amount: format(held) })
            : ""} / {format(limit)}
        </span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`h-full rounded-full ${share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-warning" : "bg-brand"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function BudgetStatus({ status }: { status: KeyBudgetStatus }) {
  const use = budgetUse(status);
  return (
    <section className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13.5px] font-medium">
          {budgetPeriodName(status.period)}
        </h3>
        {status.spent ? (
          <span className="tag error">{t("routing.budget.spent")}</span>
        ) : (
          <span className="tag good">{t("routing.budget.available")}</span>
        )}
        <span className="ml-auto text-[12px] text-muted-foreground">
          {tr("routing.budget.resets", {
            time: <LocalTime value={status.resetsAt} />,
          })}
        </span>
      </div>
      {use.tokens ? (
        <Meter
          label={
            status.cacheReads
              ? t("routing.budget.tokensWithCache")
              : t("routing.budget.tokens")
          }
          {...use.tokens}
          format={(value) => formatNumber(value)}
        />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          {t("routing.budget.tokensNoCap", { n: status.tokens })}
        </p>
      )}
      {use.cost ? (
        <Meter
          label={t("routing.budget.cost")}
          {...use.cost}
          format={(value) => formatUsd(Number(value.toFixed(6)))}
        />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          {t("routing.budget.costNoCap", {
            amount: formatUsd(Number(status.costUsd.toFixed(6))),
          })}
        </p>
      )}
      <p className="text-[12px] text-subtle">
        {t("routing.budget.calls", {
          calls: status.calls,
          inFlight: status.inFlight,
        })}
      </p>
    </section>
  );
}

/** What a key used of its budgets now (`GET /gateway-keys/{id}/limit`), read again every 5 seconds while open. */
export function LimitDialog({
  gatewayKey,
  onClose,
}: {
  gatewayKey: GatewayKeyView;
  onClose: () => void;
}) {
  const [limit, setLimit] = useState<
    | { state: "loading" }
    | { state: "ready"; value: GatewayKeyLimit }
    | { state: "error"; message: string }
  >({ state: "loading" });
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    modelPlane()
      .gatewayKeys.limit(gatewayKey.keyId)
      .then(
        (value) => {
          if (current) setLimit({ state: "ready", value });
        },
        (reason: unknown) => {
          if (current)
            setLimit({ state: "error", message: failureOf(reason).message });
        },
      );
    const timer = window.setTimeout(refresh, 5000);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [gatewayKey.keyId, epoch, refresh]);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {t("routing.limit.title", { name: gatewayKey.name })}
          </DialogTitle>
          <DialogDescription>{t("routing.limit.lede")}</DialogDescription>
        </DialogHeader>
        {limit.state === "loading" ? (
          <p
            role="status"
            className="flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("common.loading")}
          </p>
        ) : limit.state === "error" ? (
          <LoadError message={limit.message} retry={refresh} />
        ) : (
          <div className="space-y-3">
            <p className="text-[12.5px] text-muted-foreground">
              {limit.value.requestsPerMinute !== undefined
                ? t("routing.limit.zoneRpm", {
                    zone: limit.value.timeZone,
                    n: limit.value.requestsPerMinute,
                  })
                : t("routing.limit.zone", { zone: limit.value.timeZone })}
            </p>
            {limit.value.budgets.length ? (
              limit.value.budgets.map((status) => (
                <BudgetStatus key={status.period} status={status} />
              ))
            ) : (
              <p className="rounded-xl border px-3 py-3 text-[13px] text-muted-foreground">
                {t("routing.limit.noBudgets")}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={refresh}>
            <RefreshCw />
            {t("common.refresh")}
          </Button>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
