"use client";
import { useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  EyeOff,
  Loader2,
  PlugZap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { HarnessModelTest, HarnessModelView } from "@/lib/contracts";
import type { SecretReference } from "@/lib/engine-configuration";
import { engineName } from "@/lib/engines";
import {
  formFromView,
  harnessModelBody,
  validateForm,
  type HarnessModelForm,
} from "@/lib/harness-model";
import { cn } from "@/lib/utils";

type Phase =
  | { step: "idle" }
  | { step: "saving" }
  | { step: "testing"; engine: string }
  | { step: "done"; tested: boolean }
  | { step: "failed"; test: HarnessModelTest; engine: string };

/**
 * First-run model connection. The key is stored through `POST /v1/secrets` and only its
 * reference reaches `PUT /v1/harness/model`; the optional check runs one short real task on
 * the first engine the model was applied to.
 */
export function ConnectModel({
  onSaved,
  onDone,
  onSkip,
  openRun,
}: {
  /** Adopt the saved view (and refresh engines) as soon as the Gateway accepted it. */
  onSaved: (view: HarnessModelView) => Promise<void>;
  /** The person finished onboarding, with or without a passed check. */
  onDone: () => void;
  onSkip: () => void;
  openRun: (runId: string) => void;
}) {
  const [form, setForm] = useState<HarnessModelForm>(() => ({
    ...formFromView(undefined),
    keyMode: "new",
  }));
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  /** A key stored by an earlier attempt is reused so retries do not create duplicates. */
  const [storedKey, setStoredKey] = useState<SecretReference>();
  const busy = phase.step === "saving" || phase.step === "testing";
  function update(patch: Partial<HarnessModelForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
    if ("newKey" in patch) setStoredKey(undefined);
    if (phase.step === "failed") setPhase({ step: "idle" });
  }
  async function connect(check: boolean) {
    const typedKey = form.newKey.trim();
    const candidate: HarnessModelForm = {
      ...form,
      keyMode: typedKey ? "new" : "none",
    };
    const problem = validateForm(candidate);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPhase({ step: "saving" });
    try {
      let reference = storedKey;
      if (typedKey && !reference) {
        reference = (await api.createSecret(typedKey)).reference;
        setStoredKey(reference);
      }
      const view = await api.saveHarnessModel(
        harnessModelBody(candidate, reference, {}),
      );
      await onSaved(view);
      const engine = view.engines.find((item) => item.status === "applied");
      if (!check || !engine) {
        setPhase({ step: "done", tested: false });
        window.setTimeout(onDone, 900);
        return;
      }
      setPhase({ step: "testing", engine: engine.engineId });
      const test = await api.testHarnessModel(engine.engineId);
      if (test.ok) {
        setPhase({ step: "done", tested: true });
        window.setTimeout(onDone, 900);
      } else setPhase({ step: "failed", test, engine: engine.engineId });
    } catch (reason) {
      setPhase({ step: "idle" });
      setError(reason instanceof Error ? reason.message : "保存失败");
    }
  }
  return (
    <section
      className="w-full max-w-[460px] rounded-[24px] border bg-card p-7 shadow-float"
      aria-label="连接模型"
    >
      <div className="mb-5 flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-brand-soft text-brand">
          <PlugZap className="size-5" strokeWidth={1.8} />
        </span>
        <div>
          <h1 className="text-[18px] font-semibold">连接模型</h1>
          <p className="text-[13px] text-muted-foreground">
            所有引擎共用这一个模型
          </p>
        </div>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void connect(true);
        }}
      >
        <label className="field-label">
          接口地址
          <input
            className="field font-mono text-[13px]"
            value={form.baseUrl}
            placeholder="https://example.com/v1"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        </label>
        <label className="field-label">
          模型 ID
          <input
            className="field font-mono text-[13px]"
            value={form.model}
            placeholder="GLM-V5_1-DX"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => update({ model: event.target.value })}
          />
        </label>
        <label className="field-label">
          API Key
          <span className="relative block">
            <input
              className="field pr-10 font-mono text-[13px]"
              type={showKey ? "text" : "password"}
              value={form.newKey}
              placeholder="无需密钥可留空"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => update({ newKey: event.target.value })}
            />
            <button
              type="button"
              className="absolute top-[7px] right-1 grid size-9 place-items-center rounded-lg text-subtle hover:text-foreground"
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </span>
        </label>
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform duration-150",
                advanced && "rotate-90",
              )}
            />
            高级
          </button>
          {advanced ? (
            <div className="mt-3 grid animate-in grid-cols-2 gap-3 duration-150 fade-in-0 slide-in-from-top-1">
              <label className="field-label">
                上下文窗口
                <input
                  className="field tabular"
                  inputMode="numeric"
                  value={form.contextWindow}
                  placeholder="131072"
                  disabled={busy}
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
                  disabled={busy}
                  onChange={(event) =>
                    update({ maxOutputTokens: event.target.value })
                  }
                />
              </label>
            </div>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="callout error">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
        {phase.step === "failed" ? (
          <div role="alert" className="callout error">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p>
                已保存，但 {engineName(phase.engine)} 未能通过模型拿到回复。
              </p>
              {phase.test.error ? (
                <p className="mt-1 text-[12.5px] opacity-80">
                  {phase.test.error.message}
                </p>
              ) : null}
              <div className="mt-2 flex gap-3 text-[12.5px]">
                <button
                  type="button"
                  className="underline"
                  onClick={() => openRun(phase.test.runId)}
                >
                  查看测试任务
                </button>
                <button type="button" className="underline" onClick={onDone}>
                  仍然继续
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" className="h-10 flex-1" disabled={busy}>
            {phase.step === "saving" ? (
              <>
                <Loader2 className="animate-spin" />
                正在保存
              </>
            ) : phase.step === "testing" ? (
              <>
                <Loader2 className="animate-spin" />
                正在用 {engineName(phase.engine)} 测试
              </>
            ) : phase.step === "done" ? (
              <>
                <Check />
                {phase.tested ? "连接成功" : "已保存"}
              </>
            ) : (
              "保存并测试"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-10"
            disabled={busy || phase.step === "done"}
            onClick={() => void connect(false)}
          >
            仅保存
          </Button>
        </div>
      </form>
      <button
        type="button"
        className="mx-auto mt-4 block text-[12.5px] text-subtle hover:text-foreground"
        disabled={busy}
        onClick={onSkip}
      >
        稍后设置
      </button>
    </section>
  );
}
