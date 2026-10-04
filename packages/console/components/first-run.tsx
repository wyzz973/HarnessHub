// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, Loader2, Sparkles } from "lucide-react";
import type {
  Agent,
  AgentWiringPlan,
  ProviderConfig,
  ProviderPreset,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BrandIcon } from "@/components/brand-icon";
import { ModelPicker } from "@/components/model-picker";
import { installationText } from "@/lib/agents";
import { agentIconSlug } from "@/lib/brand-icons";
import {
  exposedModels,
  firstRunSteps,
  sameWiring,
  type FirstRunStep,
} from "@/lib/first-run";
import { gatewayModels } from "@/lib/gateway-models";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Checkbox, ErrorCallout } from "./model-plane-ui";
import { PlanFiles } from "./plan-files";
import { PresetPane } from "./preset-pane";

interface Planned {
  agent: Agent;
  /** Undefined: already wired this way, left alone. */
  plan: AgentWiringPlan | undefined;
}

interface Outcome {
  agent: Agent;
  outcome: "wired" | "unchanged" | "failed";
  error?: string;
}

function Steps({ current }: { current: FirstRunStep }) {
  const at = firstRunSteps.findIndex((step) => step.id === current);
  return (
    <ol
      className="flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]"
      aria-label="步骤"
    >
      {firstRunSteps.map((step, index) => (
        <li
          key={step.id}
          aria-current={index === at ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5 text-subtle",
            index === at && "font-medium text-foreground",
            index < at && "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "grid size-5 place-items-center rounded-full border text-[11px]",
              index === at && "border-brand bg-brand text-white",
              index < at && "border-brand text-brand",
            )}
          >
            {index < at ? <Check className="size-3" /> : index + 1}
          </span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * The first run on the home page, the browser's `hh init`: add a provider
 * from a preset with its region, plan and key, read its models, choose the
 * agents and their default model, then review one combined preview of every
 * file and write it on confirmation. Each step uses the same API as the
 * console's other pages; agents already wired the same way are left alone.
 */
export function FirstRun({
  agents,
  onClose,
}: {
  agents: readonly Agent[];
  /** Leaves the flow; the provider and wiring made so far stay. */
  onClose: () => void;
}) {
  const [step, setStep] = useState<FirstRunStep>("provider");
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [refresh, setRefresh] = useState<
    { state: "busy" } | { state: "done"; error?: string }
  >({ state: "busy" });
  const installed = useMemo(
    () => agents.filter((agent) => agent.installation.status !== "not-found"),
    [agents],
  );
  const [chosen, setChosen] = useState<string[]>(() =>
    installed.map((agent) => agent.id),
  );
  const [picked, setModel] = useState<string | undefined>();
  const [planned, setPlanned] = useState<Planned[] | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const models = provider ? exposedModels(provider) : [];
  // The first model until the user picks one, as `hh init` offers it.
  const model = picked ?? models[0];
  const pickerModels = useMemo(
    () => (provider ? gatewayModels([provider], presets, [], []) : null),
    [provider, presets],
  );

  // 2. Reading the new provider's models, as `hh init` does after adding it.
  const created = provider?.id;
  useEffect(() => {
    if (!created) return;
    let current = true;
    const client = modelPlane();
    void client.presets.list().then(
      (page) => {
        if (current) setPresets(page.items);
      },
      () => undefined,
    );
    client.providers.refreshModels(created).then(
      (refreshed) => {
        if (!current) return;
        setProvider(refreshed);
        setRefresh({ state: "done" });
      },
      (reason: unknown) => {
        if (!current) return;
        setRefresh({ state: "done", error: failureOf(reason).message });
      },
    );
    return () => {
      current = false;
    };
  }, [created]);

  const selected = installed.filter((agent) => chosen.includes(agent.id));
  const review = () => {
    if (!model) return;
    setBusy(true);
    setFailure(null);
    const client = modelPlane();
    Promise.all(
      selected.map(async (agent): Promise<Planned> => {
        const input = { model };
        return {
          agent,
          plan: sameWiring(agent, input)
            ? undefined
            : await client.agents.plan(agent.id, input),
        };
      }),
    ).then(
      (plans) => {
        setBusy(false);
        setPlanned(plans);
        setStep("review");
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  const apply = async () => {
    if (!planned || !model) return;
    setBusy(true);
    setFailure(null);
    const results: Outcome[] = [];
    // One agent at a time; one failing does not stop the others.
    for (const { agent, plan } of planned) {
      if (!plan?.changed) {
        results.push({ agent, outcome: "unchanged" });
        continue;
      }
      try {
        await modelPlane().agents.wire(agent.id, { model, expect: plan });
        results.push({ agent, outcome: "wired" });
      } catch (reason) {
        results.push({
          agent,
          outcome: "failed",
          error: failureOf(reason).message,
        });
      }
    }
    setBusy(false);
    setOutcomes(results);
    if (results.some((item) => item.outcome === "failed"))
      notify.error(new Error("部分 Agent 没有接线"), "接线未全部完成");
    else notify.success("设置完成，重启正在运行的 Agent 后生效");
  };
  const changing = planned?.filter((item) => item.plan?.changed) ?? [];

  return (
    <section className="panel space-y-5 p-5 sm:p-6" aria-label="开始使用">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand">
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold">开始使用 HarnessHub</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              添加一个模型 provider，再让本机的编码 Agent
              经网关使用它。与终端里的 hh init
              相同，每一步都可以之后在各个页面修改。
            </p>
          </div>
        </div>
      </div>
      <Steps current={step} />
      {step === "provider" ? (
        <div className="space-y-4">
          <PresetPane
            cancelLabel="跳过，稍后添加"
            submitLabel="添加并继续"
            onBusy={() => undefined}
            onCancel={onClose}
            onSaved={(saved) => {
              setProvider(saved);
              setRefresh({ state: "busy" });
              setStep("models");
            }}
          />
        </div>
      ) : null}
      {step === "models" && provider ? (
        <div className="space-y-3">
          <p className="text-[13.5px]">
            已添加 provider <span className="font-mono">{provider.id}</span>
            {provider.region ? `，区域 ${provider.region}` : ""}
            {provider.plan ? `，套餐 ${provider.plan}` : ""}。
          </p>
          {refresh.state === "busy" ? (
            <p
              className="flex items-center gap-2 text-[13px] text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" />
              正在从上游读取模型列表…
            </p>
          ) : (
            <>
              {refresh.error ? (
                <p className="callout warn">
                  读取模型列表失败（{refresh.error}），使用预设中的列表。
                </p>
              ) : null}
              <p className="text-[13px]">
                {provider.name} 提供 {models.length} 个模型
                {models.length
                  ? `：${models.slice(0, 5).join("、")}${models.length > 5 ? " 等" : ""}`
                  : "。可以之后在 Provider 页手动添加。"}
              </p>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              到此为止
            </Button>
            <Button
              disabled={refresh.state === "busy"}
              onClick={() =>
                setStep(installed.length && models.length ? "agents" : "review")
              }
            >
              继续
            </Button>
          </div>
        </div>
      ) : null}
      {step === "agents" ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            选择要经网关使用这个 provider 的 Agent。每个 Agent
            写入自己的配置文件，写入前先备份，随时可以还原。
          </p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {installed.map((agent) => (
              <li key={agent.id}>
                <Checkbox
                  checked={chosen.includes(agent.id)}
                  onChange={(checked) =>
                    setChosen((current) =>
                      checked
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id),
                    )
                  }
                >
                  <span className="flex items-center gap-2">
                    <BrandIcon
                      slug={agentIconSlug(agent.id)}
                      name={agent.name}
                      className="size-6"
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{agent.name}</span>
                      <span className="block truncate text-[12px] text-subtle">
                        {agent.wiring?.model
                          ? `现在 ${agent.wiring.model}`
                          : installationText[agent.installation.status].label}
                      </span>
                    </span>
                  </span>
                </Checkbox>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              跳过接线
            </Button>
            <Button
              disabled={!selected.length}
              onClick={() => setStep("model")}
            >
              继续
            </Button>
          </div>
        </div>
      ) : null}
      {step === "model" && pickerModels ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            {selected.map((agent) => agent.name).join("、")}{" "}
            默认使用的模型。Claude Code 的各档位跟随这个模型，之后可以在 Agent
            详情中分别设置。
          </p>
          <div className="max-w-[420px]">
            <ModelPicker
              label="默认模型"
              models={pickerModels}
              value={model}
              onChange={(ref) => {
                if (ref) setModel(ref);
              }}
            />
          </div>
          <ErrorCallout failure={failure} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setStep("agents")}
            >
              上一步
            </Button>
            <Button disabled={busy || !model} onClick={review}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              预览改动
            </Button>
          </div>
        </div>
      ) : null}
      {step === "review" ? (
        <div className="space-y-4">
          {!planned ? (
            <p className="text-[13px] text-muted-foreground">
              {!installed.length
                ? "本机没有发现编码 Agent；安装 Claude Code、Codex、OpenCode 等之后在 Agent 页接线。"
                : !models.length
                  ? "这个 provider 还没有模型；在 Provider 页添加模型后，再到 Agent 页接线。"
                  : "没有选择 Agent。之后可以在 Agent 页为它们选择模型。"}
            </p>
          ) : outcomes ? (
            <ul className="space-y-1.5 text-[13.5px]" aria-label="结果">
              {outcomes.map((item) => (
                <li
                  key={item.agent.id}
                  className="flex flex-wrap items-center gap-2"
                >
                  {item.outcome === "failed" ? (
                    <CircleAlert className="size-4 text-danger" />
                  ) : (
                    <Check className="size-4 text-success" />
                  )}
                  {item.agent.name}
                  <span className="text-muted-foreground">
                    {item.outcome === "wired"
                      ? `已接线到 ${model}`
                      : item.outcome === "unchanged"
                        ? "已经这样接线，未改动"
                        : `接线失败：${item.error}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {planned.map(({ agent, plan }) => (
                <section
                  key={agent.id}
                  className="min-w-0 space-y-2 rounded-xl border p-3"
                >
                  <p className="flex items-center gap-2 text-[13.5px] font-medium">
                    <BrandIcon
                      slug={agentIconSlug(agent.id)}
                      name={agent.name}
                      className="size-6"
                    />
                    {agent.name}
                    {plan?.changed ? null : (
                      <span className="tag">已经这样接线</span>
                    )}
                  </p>
                  {plan?.changed ? (
                    <PlanFiles files={plan.files} keyNote={false} />
                  ) : null}
                </section>
              ))}
              <p className="text-[12.5px] text-muted-foreground">
                确认后依次写入；每个 Agent 签发一把自己的 Key。正在运行的 Agent
                重启后生效。
              </p>
            </>
          )}
          <ErrorCallout failure={failure} />
          <div className="flex justify-end gap-2">
            {outcomes || !planned ? (
              <Button onClick={onClose}>完成</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStep("model")}
                >
                  上一步
                </Button>
                <Button
                  disabled={busy || !changing.length}
                  onClick={() => void apply()}
                >
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  写入 {changing.length} 个 Agent
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {step === "model" && !pickerModels ? (
        <Skeleton className="h-9 w-[420px]" />
      ) : null}
    </section>
  );
}
