"use client";
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
  engineModelStatusNames,
  formFromView,
  harnessModelBody,
  headerRow,
  modelSourceNames,
  validateForm,
  type HarnessModelForm,
  type HeaderRow,
} from "@/lib/harness-model";
import { engineName } from "@/lib/engines";
import { duration } from "@/lib/presentation";
import { EngineAvatar } from "./engine-avatar";

function referenceLabel(reference: SecretReference) {
  return reference.kind === "keychain"
    ? "已保存在系统安全存储"
    : reference.kind === "file"
      ? `密钥文件 ${reference.value}`
      : `环境变量 ${reference.value}`;
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
      setSaved("已保存，新任务开始使用这个模型。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
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
      setTested({ ...result, engine: testEngine || "默认引擎" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "测试请求失败");
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
            <h1 className="page-title">模型</h1>
            <p className="page-lede">所有引擎共用这一个模型。</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className={busy === "reload" ? "animate-spin" : ""} />
            重新读取
          </Button>
        </div>
        {unsupported ? (
          <div className="callout warn mt-6">
            当前服务版本不支持统一模型，请升级。
          </div>
        ) : model.state === "error" ? (
          <div className="callout error mt-6" role="alert">
            读取失败：{model.message}
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
            <section className="panel p-6" aria-label="模型配置">
              {environmentLocked ? (
                <div className="callout warn mb-5">
                  模型由环境变量 HARNESSHUB_MODEL*
                  提供，在这里不能修改。
                </div>
              ) : null}
              <fieldset className="space-y-4" disabled={environmentLocked}>
                <label className="field-label">
                  接口地址
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
                    OpenAI Chat Completions 兼容接口，以 /v1 结尾。
                  </span>
                </label>
                <label className="field-label">
                  模型 ID
                  <input
                    className="field font-mono text-[13px]"
                    value={form.model}
                    placeholder="GLM-V5_1-DX"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => update({ model: event.target.value })}
                  />
                </label>
                <div>
                  <span className="field-label">API Key</span>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
                    <select
                      aria-label="API Key 来源"
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
                        <option value="keep">使用已保存的密钥</option>
                      ) : null}
                      <option value="new">输入新密钥</option>
                      <option value="env">读取环境变量</option>
                      <option value="none">不需要密钥</option>
                    </select>
                    {form.keyMode === "new" ? (
                      <input
                        aria-label="新的 API Key"
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
                        aria-label="API Key 环境变量名称"
                        className="field mt-0 font-mono text-[13px]"
                        value={form.envName}
                        placeholder="COMPANY_MODEL_KEY"
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
                      ? "填写环境变量的名称，服务启动时从该变量读取密钥。"
                      : form.keyMode === "none"
                        ? "请求不带 Authorization。"
                        : "密钥保存在本机系统安全存储中，配置里只保留引用。"}
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
                    高级设置
                  </summary>
                  <div className="space-y-5 border-t px-4 pt-4 pb-5">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <label className="field-label">
                        上下文窗口
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
                        最大输出
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
                        引擎看到的模型名
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
                      <span className="field-label">自定义请求头</span>
                      {form.headers.length ? (
                        <div className="mt-2 space-y-2">
                          {form.headers.map((row) => (
                            <div
                              key={row.key}
                              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-2"
                            >
                              <input
                                aria-label="请求头名称"
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
                                aria-label={`请求头 ${row.name || ""} 的值`}
                                type={row.secret ? "password" : "text"}
                                autoComplete="off"
                                className="field mt-0 font-mono text-[13px]"
                                value={row.value}
                                placeholder={
                                  row.secret && row.reference
                                    ? "已保存，留空保持不变"
                                    : "值"
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
                                敏感
                              </label>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`删除请求头 ${row.name}`}
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
                        添加请求头
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="field-label">
                        推理内容
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
                          <option value="passthrough">回传给引擎</option>
                          <option value="strip">不转发</option>
                        </select>
                      </label>
                      <label className="field-label">
                        输出上限字段
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
                      额外去除的请求参数
                      <input
                        className="field font-mono text-[13px]"
                        value={form.dropParameters}
                        placeholder="top_k, seed"
                        onChange={(event) =>
                          update({ dropParameters: event.target.value })
                        }
                      />
                      <span className="field-hint block">
                        上游报“不支持某参数”时填写，逗号分隔。
                      </span>
                    </label>
                    <label className="flex items-center justify-between gap-4 text-[13.5px]">
                      <span>
                        请求用量统计
                        <span className="field-hint mt-0.5 block">
                          上游支持 stream_options.include_usage 时开启。
                        </span>
                      </span>
                      <Switch
                        checked={form.includeUsage}
                        onCheckedChange={(checked) =>
                          update({ includeUsage: checked })
                        }
                        aria-label="请求用量统计"
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
                    保存
                  </Button>
                  {dirty ? (
                    <span className="text-[12.5px] text-warning">
                      有未保存的修改
                    </span>
                  ) : null}
                </div>
              )}
            </section>
            <div className="space-y-5">
              <section className="panel p-5" aria-label="当前状态">
                <h2 className="section-title">当前状态</h2>
                <dl className="mt-2">
                  <div className="metric-row">
                    <dt>模型</dt>
                    <dd className="font-mono text-[12.5px]">
                      {view.configured ? (view.model ?? "未报告") : "未连接"}
                    </dd>
                  </div>
                  {view.configured && view.source ? (
                    <div className="metric-row">
                      <dt>来源</dt>
                      <dd>{modelSourceNames[view.source]}</dd>
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
                  {busy === "test" ? "测试中，最长约 90 秒" : "测试连接"}
                </Button>
                {testable.length > 1 ? (
                  <select
                    className="field h-8 text-[12.5px]"
                    aria-label="测试引擎"
                    value={testEngine}
                    disabled={!!busy}
                    onChange={(event) => setTestEngine(event.target.value)}
                  >
                    <option value="">用默认引擎测试</option>
                    {testable.map((engine) => (
                      <option key={engine.engineId} value={engine.engineId}>
                        用 {engineName(engine.engineId)} 测试
                      </option>
                    ))}
                  </select>
                ) : null}
                {dirty && view.configured ? (
                  <p className="field-hint">测试使用已保存的配置。</p>
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
                      {tested.ok ? "连接正常" : "测试未通过"} ·{" "}
                      {duration(tested.durationMs)}
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
                        查看测试任务
                      </button>
                    </span>
                  </div>
                ) : null}
              </section>
              <section className="panel p-5" aria-label="引擎">
                <h2 className="section-title">引擎</h2>
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
                              {engineModelStatusNames[engine.status]}
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
                    还没有引擎
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
