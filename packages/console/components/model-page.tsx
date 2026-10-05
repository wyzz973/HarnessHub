// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, type Remote } from "@/lib/api";
import type { HarnessModelTest, HarnessModelView } from "@/lib/contracts";
import type { SecretReference } from "@/lib/engine-configuration";
import {
  DEFAULT_ALIAS,
  engineModelStatusName,
  formFromView,
  harnessModelBody,
  headerRow,
  modelSourceName,
  validateForm,
  type HarnessModelForm,
  type HeaderRow,
} from "@/lib/harness-model";
import { engineName } from "@/lib/engines";
import { duration } from "@/lib/presentation";
import { EngineAvatar } from "./engine-avatar";
import { t } from "@/lib/i18n";
import { navigate } from "@/lib/router";

function referenceLabel(reference: SecretReference) {
  return reference.kind === "keychain"
    ? t("tasks.model.keychain")
    : reference.kind === "file"
      ? t("tasks.model.keyFile", { path: reference.value })
      : t("tasks.model.keyEnv", { name: reference.value });
}
/**
 * Unified model editor (ADR 0013). Secrets are written through `POST /v1/secrets` first and
 * only their references reach `PUT /v1/harness/model`; the Gateway re-registers every engine.
 */
export function ModelPage({
  model,
  reload,
  onSaved,
  openRun,
}: {
  model: Remote<HarnessModelView>;
  reload: () => Promise<void>;
  onSaved: (view: HarnessModelView) => Promise<void>;
  /** Show a Run (the connection test task) in the workbench with its execution details. */
  openRun: (runId: string) => void;
}) {
  const view = model.state === "ready" ? model.value : undefined;
  const [form, setForm] = useState<HarnessModelForm>(() => formFromView(view));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "reload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [testEngine, setTestEngine] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tested, setTested] = useState<
    (HarnessModelTest & { engine: string }) | null
  >(null);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!dirty && view) setForm(formFromView(view));
  }, [view, dirty]);
  function update(patch: Partial<HarnessModelForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
    setSaved(null);
    setError(null);
  }
  function updateRow(key: string, patch: Partial<HeaderRow>) {
    update({
      headers: form.headers.map((row) =>
        row.key === key ? { ...row, ...patch } : row,
      ),
    });
  }
  async function save() {
    const problem = validateForm(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy("save");
    setError(null);
    setSaved(null);
    try {
      let next = form;
      let apiKey: SecretReference | undefined;
      if (next.keyMode === "new") {
        const { reference } = await api.createSecret(next.newKey.trim());
        apiKey = reference;
        next = {
          ...next,
          keyMode: "keep",
          keyReference: reference,
          newKey: "",
        };
      } else if (next.keyMode === "keep") apiKey = next.keyReference;
      else if (next.keyMode === "env")
        apiKey = { kind: "env", value: next.envName.trim() };
      const secretHeaders: Record<string, SecretReference> = {};
      const rows: HeaderRow[] = [];
      for (const row of next.headers) {
        const name = row.name.trim();
        if (row.secret && name && row.value.trim()) {
          const { reference } = await api.createSecret(row.value.trim());
          secretHeaders[name] = reference;
          rows.push({ ...row, value: "", reference });
        } else {
          if (row.secret && name && row.reference)
            secretHeaders[name] = row.reference;
          rows.push(row);
        }
      }
      next = { ...next, headers: rows };
      // Stored secrets are kept as references so a failed save can be retried without duplicates.
      setForm(next);
      const saved = await api.saveHarnessModel(
        harnessModelBody(next, apiKey, secretHeaders),
      );
      await onSaved(saved);
      setForm(formFromView(saved));
      setDirty(false);
      setSaved(t("tasks.model.saved"));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("tasks.model.saveFailed"),
      );
    } finally {
      setBusy(null);
    }
  }
  async function test() {
    setBusy("test");
    setError(null);
    setTested(null);
    try {
      const result = await api.testHarnessModel(testEngine || undefined);
      setTested({
        ...result,
        engine: testEngine || t("tasks.model.defaultEngine"),
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("tasks.model.testFailed"),
      );
    } finally {
      setBusy(null);
    }
  }
  async function refresh() {
    setBusy("reload");
    setDirty(false);
    setError(null);
    try {
      await reload();
    } finally {
      setBusy(null);
    }
  }
  const unsupported = model.state === "unsupported";
  // The Gateway refuses to save while HARNESSHUB_MODEL* provides the model (HTTP 409).
  const environmentLocked = view?.source === "environment";
  const engineStatuses = (view?.engines ?? []).filter(
    (engine) => engine.engineId !== "fake",
  );
  const testable = engineStatuses.filter(
    (engine) => engine.status === "applied",
  );
  return (
    <div className="page-body">
      <div className="page-column">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="page-title">{t("tasks.model.title")}</h1>
            <p className="page-lede">{t("tasks.model.lede")}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className={busy === "reload" ? "animate-spin" : ""} />
            {t("tasks.model.reload")}
          </Button>
        </div>
        <div className="callout mt-6">
          <span>
            {t("tasks.model.deprecated")}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => navigate("providers")}
            >
              {t("tasks.model.openProviders")}
            </button>
          </span>
        </div>
        {unsupported ? (
          <div className="callout warn mt-6">
            {t("tasks.model.unsupported")}
          </div>
        ) : model.state === "error" ? (
          <div className="callout error mt-6" role="alert">
            {t("common.loadFailed", { message: model.message })}
          </div>
        ) : null}
        {model.state === "loading" ? (
          <div className="mt-8 space-y-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}
        {view ? (
          <div className="mt-6 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <section
              className="panel p-6"
              aria-label={t("tasks.model.settings")}
            >
              {environmentLocked ? (
                <div className="callout warn mb-5">
                  {t("tasks.model.environmentLocked")}
                </div>
              ) : null}
              <fieldset className="space-y-4" disabled={environmentLocked}>
                <label className="field-label">
                  {t("tasks.model.baseUrl")}
                  <input
                    className="field font-mono text-[13px]"
                    value={form.baseUrl}
                    placeholder="https://example.com/v1"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      update({ baseUrl: event.target.value })
                    }
                  />
                  <span className="field-hint block">
                    {t("tasks.model.baseUrlHint")}
                  </span>
                </label>
                <label className="field-label">
                  {t("tasks.model.modelId")}
                  <input
                    className="field font-mono text-[13px]"
                    value={form.model}
                    placeholder="deepseek-chat"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => update({ model: event.target.value })}
                  />
                </label>
                <div>
                  <span className="field-label">API Key</span>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
                    <select
                      aria-label={t("tasks.model.keySource")}
                      className="field mt-0"
                      value={form.keyMode}
                      onChange={(event) =>
                        update({
                          keyMode: event.target
                            .value as HarnessModelForm["keyMode"],
                        })
                      }
                    >
                      {form.keyReference ? (
                        <option value="keep">{t("tasks.model.keyKeep")}</option>
                      ) : null}
                      <option value="new">{t("tasks.model.keyNew")}</option>
                      <option value="env">{t("tasks.model.keyFromEnv")}</option>
                      <option value="none">{t("tasks.model.keyNone")}</option>
                    </select>
                    {form.keyMode === "new" ? (
                      <input
                        aria-label={t("tasks.model.newKey")}
                        type="password"
                        autoComplete="off"
                        className="field mt-0 font-mono text-[13px]"
                        value={form.newKey}
                        placeholder="sk-…"
                        onChange={(event) =>
                          update({ newKey: event.target.value })
                        }
                      />
                    ) : form.keyMode === "env" ? (
                      <input
                        aria-label={t("tasks.model.envName")}
                        className="field mt-0 font-mono text-[13px]"
                        value={form.envName}
                        placeholder="UPSTREAM_MODEL_KEY"
                        autoComplete="off"
                        onChange={(event) =>
                          update({ envName: event.target.value })
                        }
                      />
                    ) : form.keyMode === "keep" && form.keyReference ? (
                      <p className="field mt-0 flex items-center truncate bg-muted text-[13px] text-muted-foreground">
                        {referenceLabel(form.keyReference)}
                      </p>
                    ) : null}
                  </div>
                  <p className="field-hint">
                    {form.keyMode === "env"
                      ? t("tasks.model.envHint")
                      : form.keyMode === "none"
                        ? t("tasks.model.noneHint")
                        : t("tasks.model.storedHint")}
                  </p>
                </div>
                <details
                  className="group rounded-xl border"
                  open={advancedOpen}
                  onToggle={(event) =>
                    setAdvancedOpen(event.currentTarget.open)
                  }
                >
                  <summary className="flex h-11 items-center gap-2 px-4 text-[13.5px] font-medium">
                    <ChevronRight className="size-4 text-subtle transition-transform duration-150 group-open:rotate-90" />
                    {t("tasks.model.advanced")}
                  </summary>
                  <div className="space-y-5 border-t px-4 pt-4 pb-5">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <label className="field-label">
                        {t("tasks.model.contextWindow")}
                        <input
                          className="field tabular"
                          inputMode="numeric"
                          value={form.contextWindow}
                          placeholder="131072"
                          onChange={(event) =>
                            update({ contextWindow: event.target.value })
                          }
                        />
                      </label>
                      <label className="field-label">
                        {t("tasks.model.maxOutputField")}
                        <input
                          className="field tabular"
                          inputMode="numeric"
                          value={form.maxOutputTokens}
                          placeholder="8192"
                          onChange={(event) =>
                            update({ maxOutputTokens: event.target.value })
                          }
                        />
                      </label>
                      <label className="field-label">
                        {t("tasks.model.alias")}
                        <input
                          className="field font-mono text-[13px]"
                          value={form.alias}
                          placeholder={DEFAULT_ALIAS}
                          autoComplete="off"
                          onChange={(event) =>
                            update({ alias: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div>
                      <span className="field-label">
                        {t("tasks.model.headers")}
                      </span>
                      {form.headers.length ? (
                        <div className="mt-2 space-y-2">
                          {form.headers.map((row) => (
                            <div
                              key={row.key}
                              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-2"
                            >
                              <input
                                aria-label={t("tasks.model.headerName")}
                                className="field mt-0 font-mono text-[13px]"
                                value={row.name}
                                placeholder="X-Tenant-Id"
                                onChange={(event) =>
                                  updateRow(row.key, {
                                    name: event.target.value,
                                  })
                                }
                              />
                              <input
                                aria-label={t("tasks.model.headerValue", {
                                  name: row.name || "",
                                })}
                                type={row.secret ? "password" : "text"}
                                autoComplete="off"
                                className="field mt-0 font-mono text-[13px]"
                                value={row.value}
                                placeholder={
                                  row.secret && row.reference
                                    ? t("tasks.model.headerKept")
                                    : t("tasks.model.value")
                                }
                                onChange={(event) =>
                                  updateRow(row.key, {
                                    value: event.target.value,
                                  })
                                }
                              />
                              <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                                <input
                                  type="checkbox"
                                  className="accent-(--primary)"
                                  checked={row.secret}
                                  onChange={(event) =>
                                    updateRow(row.key, {
                                      secret: event.target.checked,
                                    })
                                  }
                                />
                                {t("tasks.model.sensitive")}
                              </label>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("tasks.model.removeHeader", {
                                  name: row.name,
                                })}
                                onClick={() =>
                                  update({
                                    headers: form.headers.filter(
                                      (item) => item.key !== row.key,
                                    ),
                                  })
                                }
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() =>
                          update({ headers: [...form.headers, headerRow()] })
                        }
                      >
                        <Plus />
                        {t("tasks.model.addHeader")}
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="field-label">
                        {t("tasks.model.reasoning")}
                        <select
                          className="field"
                          value={form.reasoning}
                          onChange={(event) =>
                            update({
                              reasoning: event.target
                                .value as HarnessModelForm["reasoning"],
                            })
                          }
                        >
                          <option value="passthrough">
                            {t("tasks.model.reasoningPass")}
                          </option>
                          <option value="strip">
                            {t("tasks.model.reasoningStrip")}
                          </option>
                        </select>
                      </label>
                      <label className="field-label">
                        {t("tasks.model.maxTokensField")}
                        <select
                          className="field"
                          value={form.maxTokensField}
                          onChange={(event) =>
                            update({
                              maxTokensField: event.target
                                .value as HarnessModelForm["maxTokensField"],
                            })
                          }
                        >
                          <option value="max_tokens">max_tokens</option>
                          <option value="max_completion_tokens">
                            max_completion_tokens
                          </option>
                        </select>
                      </label>
                    </div>
                    <label className="field-label">
                      {t("tasks.model.drops")}
                      <input
                        className="field font-mono text-[13px]"
                        value={form.dropParameters}
                        placeholder="top_k, seed"
                        onChange={(event) =>
                          update({ dropParameters: event.target.value })
                        }
                      />
                      <span className="field-hint block">
                        {t("tasks.model.dropsHint")}
                      </span>
                    </label>
                    <label className="flex items-center justify-between gap-4 text-[13.5px]">
                      <span>
                        {t("tasks.model.includeUsage")}
                        <span className="field-hint mt-0.5 block">
                          {t("tasks.model.includeUsageHint")}
                        </span>
                      </span>
                      <Switch
                        checked={form.includeUsage}
                        onCheckedChange={(checked) =>
                          update({ includeUsage: checked })
                        }
                        aria-label={t("tasks.model.includeUsage")}
                      />
                    </label>
                  </div>
                </details>
              </fieldset>
              {error ? (
                <p role="alert" className="callout error mt-4">
                  {error}
                </p>
              ) : null}
              {saved ? (
                <p role="status" className="callout good mt-4">
                  <CircleCheck className="mt-0.5 size-4 shrink-0" />
                  {saved}
                </p>
              ) : null}
              {environmentLocked ? null : (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Button
                    disabled={!!busy || unsupported}
                    onClick={() => void save()}
                  >
                    {busy === "save" ? (
                      <Loader2 className="animate-spin" />
                    ) : null}
                    {t("tasks.model.save")}
                  </Button>
                  {dirty ? (
                    <span className="text-[12.5px] text-warning">
                      {t("tasks.model.unsaved")}
                    </span>
                  ) : null}
                </div>
              )}
            </section>
            <div className="space-y-5">
              <section
                className="panel p-5"
                aria-label={t("tasks.model.status")}
              >
                <h2 className="section-title">{t("tasks.model.status")}</h2>
                <dl className="mt-2">
                  <div className="metric-row">
                    <dt>{t("tasks.model.title")}</dt>
                    <dd className="font-mono text-[12.5px]">
                      {view.configured
                        ? (view.model ?? t("tasks.model.notReported"))
                        : t("tasks.model.notConnected")}
                    </dd>
                  </div>
                  {view.configured && view.source ? (
                    <div className="metric-row">
                      <dt>{t("tasks.model.source")}</dt>
                      <dd>{modelSourceName(view.source)}</dd>
                    </div>
                  ) : null}
                </dl>
                <Button
                  className="mt-3 w-full"
                  size="sm"
                  variant="outline"
                  disabled={!!busy || !view.configured || !testable.length}
                  onClick={() => void test()}
                >
                  {busy === "test" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <FlaskConical />
                  )}
                  {busy === "test"
                    ? t("tasks.model.testing")
                    : t("tasks.model.test")}
                </Button>
                {testable.length > 1 ? (
                  <select
                    className="field h-8 text-[12.5px]"
                    aria-label={t("tasks.model.testEngine")}
                    value={testEngine}
                    disabled={!!busy}
                    onChange={(event) => setTestEngine(event.target.value)}
                  >
                    <option value="">{t("tasks.model.testDefault")}</option>
                    {testable.map((engine) => (
                      <option key={engine.engineId} value={engine.engineId}>
                        {t("tasks.model.testWith", {
                          engine: engineName(engine.engineId),
                        })}
                      </option>
                    ))}
                  </select>
                ) : null}
                {dirty && view.configured ? (
                  <p className="field-hint">{t("tasks.model.testUsesSaved")}</p>
                ) : null}
                {tested ? (
                  <div
                    role="status"
                    className={`callout mt-3 ${tested.ok ? "good" : "error"}`}
                  >
                    {tested.ok ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="min-w-0">
                      {tested.ok
                        ? t("tasks.model.testOk")
                        : t("tasks.model.testNotOk")}{" "}
                      · {duration(tested.durationMs)}
                      {tested.error ? (
                        <span className="mt-1 block text-[12.5px] break-words">
                          {tested.error.message}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="mt-1 block text-[12.5px] underline"
                        onClick={() => openRun(tested.runId)}
                      >
                        {t("tasks.model.viewTest")}
                      </button>
                    </span>
                  </div>
                ) : null}
              </section>
              <section
                className="panel p-5"
                aria-label={t("tasks.model.engines")}
              >
                <h2 className="section-title">{t("tasks.model.engines")}</h2>
                {engineStatuses.length ? (
                  <ul className="mt-3 space-y-2.5">
                    {engineStatuses.map((engine) => (
                      <li key={engine.engineId} className="flex gap-2.5">
                        <EngineAvatar id={engine.engineId} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13.5px]">
                              {engineName(engine.engineId)}
                            </span>
                            <span
                              className={`tag ${engine.status === "applied" ? "good" : engine.status === "unsupported" ? "warn" : ""}`}
                            >
                              {engineModelStatusName(engine.status)}
                            </span>
                          </div>
                          {engine.reason ? (
                            <p className="mt-0.5 text-[12px] leading-5 text-subtle">
                              {engine.reason}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    {t("tasks.model.noEngines")}
                  </p>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
