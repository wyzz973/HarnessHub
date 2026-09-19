"use client";
import { useEffect, useState } from "react";
import {
  BrainCircuit,
  CircleCheck,
  CircleX,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Remote } from "@/lib/api";
import type {
  HarnessModelTest,
  HarnessModelView,
  RuntimeInfo,
} from "@/lib/contracts";
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
import { duration, statusNames } from "@/lib/presentation";

function referenceLabel(reference: SecretReference) {
  return reference.kind === "keychain"
    ? `系统安全存储 · ${reference.value.slice(0, 8)}…`
    : reference.kind === "file"
      ? `密钥文件 · ${reference.value}`
      : `环境变量 · ${reference.value}`;
}
/**
 * Unified model editor (ADR 0013). Secrets are written through `POST /v1/secrets` first and
 * only their references reach `PUT /v1/harness/model`; the Gateway re-registers every engine.
 */
export function ModelPage({
  model,
  runtime,
  reload,
  onSaved,
  openRun,
}: {
  model: Remote<HarnessModelView>;
  runtime: Remote<RuntimeInfo>;
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
      setSaved(
        "已保存。所有引擎已登记新版本：新会话使用该模型，已有会话保持原版本。",
      );
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
  const competition =
    runtime.state === "ready" && runtime.value.competition
      ? runtime.value
      : undefined;
  const testable = (view?.engines ?? []).filter(
    (engine) => engine.status === "applied",
  );
  return (
    <div className="page-body enter">
      <div className="mx-auto max-w-[1040px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] tracking-wider text-muted-foreground">
              <BrainCircuit className="size-3.5" />
              UNIFIED MODEL
            </div>
            <h1 className="page-heading">所有引擎，只用一个模型。</h1>
            <p className="mt-3 max-w-[640px] text-[13px] leading-6 text-muted-foreground">
              每个会话的 Worker
              在本机启动统一模型网关，引擎只拿到本地地址和令牌，所有调用都发往这里配置的上游模型。
            </p>
          </div>
          <Button
            className="mt-6"
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
          <div className="notice warn mt-8">
            当前 Gateway
            不支持统一模型接口（/v1/harness/model）。请升级到包含统一模型网关的版本；在此之前各引擎继续使用自身的模型配置。
          </div>
        ) : model.state === "error" ? (
          <div className="notice error mt-8" role="alert">
            读取统一模型失败：{model.message}
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
          <div className="mt-8 space-y-3">
            <div
              className={view.configured ? "notice good" : "notice info"}
              role="status"
            >
              {view.configured
                ? `当前生效：${view.model ?? "未报告"}（引擎看到的名称 ${view.alias}），来源：${view.source ? modelSourceNames[view.source] : "未报告"}。`
                : "尚未配置统一模型：各引擎使用自身的模型配置。保存后所有引擎只使用这里的模型。"}
            </div>
            {environmentLocked ? (
              <div className="notice warn">
                当前统一模型由 HARNESSHUB_MODEL*
                环境变量提供，优先级最高，控制台不能修改。请修改环境变量并重启服务。
              </div>
            ) : null}
            {competition ? (
              <div className="notice info">
                比赛模式：比赛接口请求中的 model
                字段只做校验，实际执行使用统一模型；比赛引擎为{" "}
                {competition.competitionEngine ?? "未报告"}。
              </div>
            ) : null}
          </div>
        ) : null}
        {view ? (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
            <section className="panel space-y-6" aria-label="统一模型配置">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="form-label">
                  上游真实模型 ID
                  <input
                    className="form-input font-mono"
                    value={form.model}
                    placeholder="例如 GLM-V5_1-DX"
                    autoComplete="off"
                    onChange={(event) => update({ model: event.target.value })}
                  />
                </label>
                <label className="form-label">
                  引擎看到的模型名（别名）
                  <input
                    className="form-input font-mono"
                    value={form.alias}
                    placeholder={DEFAULT_ALIAS}
                    autoComplete="off"
                    onChange={(event) => update({ alias: event.target.value })}
                  />
                  <span className="form-hint block font-normal">
                    留空使用 {DEFAULT_ALIAS}，避免引擎按模型名改路由或推断上限。
                  </span>
                </label>
              </div>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
                <label className="form-label">
                  上游地址（Base URL）
                  <input
                    className="form-input font-mono"
                    value={form.baseUrl}
                    placeholder="https://model.example.com/v1"
                    autoComplete="off"
                    onChange={(event) =>
                      update({ baseUrl: event.target.value })
                    }
                  />
                  <span className="form-hint block font-normal">
                    网关会在地址后追加 /chat/completions。
                  </span>
                </label>
                <div className="form-label">
                  上游协议
                  <p className="form-input bg-muted text-muted-foreground">
                    OpenAI Chat Completions · 流式
                  </p>
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="form-label">API Key</legend>
                <select
                  aria-label="API Key 来源"
                  className="form-input"
                  value={form.keyMode}
                  onChange={(event) =>
                    update({
                      keyMode: event.target
                        .value as HarnessModelForm["keyMode"],
                    })
                  }
                >
                  {form.keyReference ? (
                    <option value="keep">
                      保留已保存的 Key（{referenceLabel(form.keyReference)}）
                    </option>
                  ) : null}
                  <option value="new">输入新 Key，保存到系统安全存储</option>
                  <option value="env">使用环境变量</option>
                  <option value="none">不使用 API Key</option>
                </select>
                {form.keyMode === "new" ? (
                  <input
                    aria-label="新的 API Key"
                    type="password"
                    autoComplete="off"
                    className="form-input font-mono"
                    value={form.newKey}
                    placeholder="保存时写入本机安全存储，配置中只保留引用"
                    onChange={(event) => update({ newKey: event.target.value })}
                  />
                ) : form.keyMode === "env" ? (
                  <input
                    aria-label="API Key 环境变量名称"
                    className="form-input font-mono"
                    value={form.envName}
                    placeholder="COMPANY_MODEL_KEY"
                    autoComplete="off"
                    onChange={(event) =>
                      update({ envName: event.target.value })
                    }
                  />
                ) : null}
                <p className="form-hint">
                  Key 通过 /v1/secrets 写入本机安全存储（Windows DPAPI、macOS
                  钥匙串），只在所属 Worker
                  内解析；环境变量方式填写变量名，不要填写 Key 本身。
                </p>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="form-label">
                  上下文窗口（token）
                  <input
                    className="form-input tabular"
                    inputMode="numeric"
                    value={form.contextWindow}
                    placeholder="例如 131072"
                    onChange={(event) =>
                      update({ contextWindow: event.target.value })
                    }
                  />
                </label>
                <label className="form-label">
                  输出上限（token）
                  <input
                    className="form-input tabular"
                    inputMode="numeric"
                    value={form.maxOutputTokens}
                    placeholder="例如 8192"
                    onChange={(event) =>
                      update({ maxOutputTokens: event.target.value })
                    }
                  />
                  <span className="form-hint block font-normal">
                    引擎请求更大的输出时由网关截断到此值。
                  </span>
                </label>
              </div>
              <fieldset className="space-y-2">
                <legend className="form-label">自定义请求头</legend>
                {form.headers.length ? (
                  <div className="space-y-2">
                    {form.headers.map((row) => (
                      <div
                        key={row.key}
                        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-2"
                      >
                        <input
                          aria-label="请求头名称"
                          className="form-input mt-0 font-mono"
                          value={row.name}
                          placeholder="X-Tenant-Id"
                          onChange={(event) =>
                            updateRow(row.key, { name: event.target.value })
                          }
                        />
                        <input
                          aria-label={`请求头 ${row.name || ""} 的值`}
                          type={row.secret ? "password" : "text"}
                          autoComplete="off"
                          className="form-input mt-0 font-mono"
                          value={row.value}
                          placeholder={
                            row.secret && row.reference
                              ? "已保存到安全存储，留空保持不变"
                              : "值"
                          }
                          onChange={(event) =>
                            updateRow(row.key, { value: event.target.value })
                          }
                        />
                        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
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
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    update({ headers: [...form.headers, headerRow()] })
                  }
                >
                  <Plus />
                  添加请求头
                </Button>
                <p className="form-hint">
                  勾选“敏感”的值保存到系统安全存储；Authorization、Token
                  一类的请求头必须标为敏感。
                </p>
              </fieldset>
              <fieldset className="space-y-3 rounded-lg border p-4">
                <legend className="px-1 text-xs font-medium">兼容选项</legend>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.includeUsage}
                    onChange={(event) =>
                      update({ includeUsage: event.target.checked })
                    }
                  />
                  <span>
                    请求用量统计（stream_options.include_usage）
                    <span className="form-hint block">
                      上游支持时开启以获得 token
                      数；很多网关会拒绝该参数，默认关闭。
                    </span>
                  </span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="form-label">
                    推理内容
                    <select
                      className="form-input"
                      value={form.reasoning}
                      onChange={(event) =>
                        update({
                          reasoning: event.target
                            .value as HarnessModelForm["reasoning"],
                        })
                      }
                    >
                      <option value="passthrough">
                        回传给引擎（默认，推理模型的工具调用需要）
                      </option>
                      <option value="strip">不转发推理内容</option>
                    </select>
                  </label>
                  <label className="form-label">
                    输出上限字段
                    <select
                      className="form-input"
                      value={form.maxTokensField}
                      onChange={(event) =>
                        update({
                          maxTokensField: event.target
                            .value as HarnessModelForm["maxTokensField"],
                        })
                      }
                    >
                      <option value="max_tokens">max_tokens（默认）</option>
                      <option value="max_completion_tokens">
                        max_completion_tokens
                      </option>
                    </select>
                  </label>
                </div>
                <label className="form-label">
                  额外去除的请求参数
                  <input
                    className="form-input font-mono"
                    value={form.dropParameters}
                    placeholder="例如 parallel_tool_calls, top_k"
                    onChange={(event) =>
                      update({ dropParameters: event.target.value })
                    }
                  />
                  <span className="form-hint block font-normal">
                    逗号或空格分隔。默认已去除
                    store、metadata、service_tier、user 等非通用参数。
                  </span>
                </label>
              </fieldset>
              {error ? (
                <p role="alert" className="notice error">
                  {error}
                </p>
              ) : null}
              {saved ? (
                <p role="status" className="notice good">
                  {saved}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                <Button
                  disabled={!!busy || unsupported || environmentLocked}
                  title={
                    environmentLocked
                      ? "环境变量提供的统一模型不能在控制台修改"
                      : undefined
                  }
                  onClick={() => void save()}
                >
                  {busy === "save" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Save />
                  )}
                  保存并应用到所有引擎
                </Button>
                {dirty ? (
                  <span className="text-[11px] text-amber-800">
                    有未保存的修改
                  </span>
                ) : null}
              </div>
            </section>
            <div className="space-y-6">
              <section className="panel" aria-label="测试连接">
                <h2 className="panel-title">测试连接</h2>
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  用已保存的配置，在所选引擎上运行一个极短的真实任务（最长约 90
                  秒），确认该引擎经统一模型网关拿到回复。会实际调用模型并消耗少量额度。
                </p>
                {dirty ? (
                  <p className="mt-2 text-[11px] text-amber-800">
                    当前修改尚未保存，测试的是已保存的配置。
                  </p>
                ) : null}
                <label className="form-label mt-4">
                  测试引擎
                  <select
                    className="form-input"
                    value={testEngine}
                    disabled={!!busy}
                    onChange={(event) => setTestEngine(event.target.value)}
                  >
                    <option value="">默认引擎</option>
                    {testable.map((engine) => (
                      <option key={engine.engineId} value={engine.engineId}>
                        {engine.engineId}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={!!busy || !view.configured}
                  onClick={() => void test()}
                >
                  {busy === "test" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <FlaskConical />
                  )}
                  {busy === "test" ? "测试任务运行中…" : "测试连接"}
                </Button>
                {tested ? (
                  <div
                    role="status"
                    className={`notice mt-4 ${tested.ok ? "good" : "error"}`}
                  >
                    {tested.ok ? (
                      <CircleCheck className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <CircleX className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="min-w-0">
                      {tested.ok ? "测试通过" : "测试未通过"} · {tested.engine}{" "}
                      · {statusNames[tested.status] ?? tested.status} ·{" "}
                      {duration(tested.durationMs)}
                      {tested.error ? (
                        <span className="mt-1 block break-words">
                          {tested.error.code}：{tested.error.message}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="mt-1 block underline underline-offset-2"
                        onClick={() => openRun(tested.runId)}
                      >
                        查看测试任务与模型调用
                      </button>
                    </span>
                  </div>
                ) : null}
              </section>
              <section className="panel" aria-label="各引擎状态">
                <h2 className="panel-title">各引擎状态</h2>
                {view.engines.length ? (
                  <table className="data-table mt-3">
                    <thead>
                      <tr>
                        <th>引擎</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.engines.map((engine) => (
                        <tr key={engine.engineId}>
                          <td className="font-medium">{engine.engineId}</td>
                          <td>
                            <span
                              className={`status-badge ${engine.status === "applied" ? "" : engine.status === "unsupported" ? "error" : "neutral"}`}
                            >
                              {engineModelStatusNames[engine.status]}
                            </span>
                            {engine.reason ? (
                              <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                                {engine.reason}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    暂无引擎状态。
                  </p>
                )}
                <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                  无法经统一模型网关接入的引擎会被禁用并说明原因，不会回落到原生账号或其他模型。
                </p>
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
