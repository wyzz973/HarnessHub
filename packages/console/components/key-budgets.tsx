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
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import {
  budgetPeriodNames,
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
      <legend className="field-label mb-1">额度（可选）</legend>
      <label className="field-label">
        每分钟请求数
        <input
          className="field w-[160px]"
          inputMode="numeric"
          value={form.rpm}
          placeholder="不限"
          onChange={(event) => onChange({ ...form, rpm: event.target.value })}
        />
        {problem("rpm")}
      </label>
      <div className="space-y-2 rounded-xl border p-3">
        <p className="text-[12.5px] text-muted-foreground">
          预算按守护进程本地时区的日历窗口计算（日从零点、周从周一、月从 1
          日）。token
          计入未命中缓存的输入、输出、推理与缓存写入；成本是账本的估算，没有价格的调用不计。上限为
          0 时，这个窗口内的每次调用都被拒绝。
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
                {budgetPeriodNames[period]}的预算
              </label>
              {fields.on ? (
                <div className="grid gap-2 pl-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <label className="field-label">
                    token 上限
                    <input
                      className="field"
                      inputMode="numeric"
                      aria-label={`${budgetPeriodNames[period]}的 token 上限`}
                      value={fields.tokens}
                      placeholder="不限"
                      onChange={(event) =>
                        budget(period, { tokens: event.target.value })
                      }
                    />
                    {problem(`${period}.tokens`)}
                  </label>
                  <label className="field-label">
                    成本上限（美元）
                    <input
                      className="field"
                      inputMode="decimal"
                      aria-label={`${budgetPeriodNames[period]}的成本上限`}
                      value={fields.cost}
                      placeholder="不限"
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
                    计入缓存读取
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
          <DialogTitle>{gatewayKey.name} 的额度</DialogTitle>
          <DialogDescription>
            超过时网关以 429
            拒绝，并告诉客户端何时重置、不要自动重试。新的额度从这个 Key
            的下一个请求起生效；全部留空即不限。
          </DialogDescription>
        </DialogHeader>
        <QuotaFields form={form} onChange={setForm} problems={problems} />
        <ErrorCallout failure={failure} />
        <OtherFieldErrors failure={failure} shown={[]} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
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
          {held ? ` + 在途预留 ${format(held)}` : ""} / {format(limit)}
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
          {budgetPeriodNames[status.period]}
        </h3>
        {status.spent ? (
          <span className="tag error">已用尽，到重置前拒绝</span>
        ) : (
          <span className="tag good">可用</span>
        )}
        <span className="ml-auto text-[12px] text-muted-foreground">
          重置于 <LocalTime value={status.resetsAt} />
        </span>
      </div>
      {use.tokens ? (
        <Meter
          label={`token${status.cacheReads ? "（含缓存读取）" : ""}`}
          {...use.tokens}
          format={(value) => value.toLocaleString()}
        />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          token：{status.tokens.toLocaleString()}（不设上限）
        </p>
      )}
      {use.cost ? (
        <Meter
          label="估算成本"
          {...use.cost}
          format={(value) => `$${Number(value.toFixed(6))}`}
        />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          估算成本：${Number(status.costUsd.toFixed(6))}（不设上限）
        </p>
      )}
      <p className="text-[12px] text-subtle">
        本窗口 {status.calls} 次调用，在途 {status.inFlight} 个
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
          <DialogTitle>{gatewayKey.name} 的用量</DialogTitle>
          <DialogDescription>
            每个预算本窗口已用多少、在途请求持有多少预留，以及何时重置；持有这个
            Key 的客户端也可以自己读取 GET /v1/harnesshub/limit。
          </DialogDescription>
        </DialogHeader>
        {limit.state === "loading" ? (
          <p
            role="status"
            className="flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            正在读取
          </p>
        ) : limit.state === "error" ? (
          <LoadError message={limit.message} retry={refresh} />
        ) : (
          <div className="space-y-3">
            <p className="text-[12.5px] text-muted-foreground">
              窗口按 {limit.value.timeZone} 时区计算
              {limit.value.requestsPerMinute !== undefined
                ? `；每分钟最多 ${limit.value.requestsPerMinute} 次请求`
                : ""}
              。
            </p>
            {limit.value.budgets.length ? (
              limit.value.budgets.map((status) => (
                <BudgetStatus key={status.period} status={status} />
              ))
            ) : (
              <p className="rounded-xl border px-3 py-3 text-[13px] text-muted-foreground">
                这个 Key 没有预算。
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={refresh}>
            <RefreshCw />
            刷新
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
