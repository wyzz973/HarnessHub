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
  firstRunStepLabel,
  firstRunSteps,
  sameWiring,
  type FirstRunStep,
} from "@/lib/first-run";
import { gatewayModels } from "@/lib/gateway-models";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Checkbox, ErrorCallout } from "./model-plane-ui";
import { PlanFiles } from "./plan-files";
import { WiringNotes } from "./wiring-notes";
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
  /** What to do for the wiring to take effect, as the daemon words it. */
  notice?: string;
}

function Steps({ current }: { current: FirstRunStep }) {
  const at = firstRunSteps.indexOf(current);
  return (
    <ol
      className="flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]"
      aria-label={t("agents.firstRun.steps")}
    >
      {firstRunSteps.map((step, index) => (
        <li
          key={step}
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
          {firstRunStepLabel(step)}
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
        const wired = await modelPlane().agents.wire(agent.id, {
          model,
          expect: plan,
        });
        results.push({
          agent,
          outcome: "wired",
          ...(wired.notice ? { notice: wired.notice } : {}),
        });
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
      notify.error(
        new Error(t("agents.firstRun.someFailed")),
        t("agents.firstRun.incomplete"),
      );
    else notify.success(t("agents.firstRun.done"));
  };
  const changing = planned?.filter((item) => item.plan?.changed) ?? [];

  return (
    <section
      className="panel space-y-5 p-5 sm:p-6"
      aria-label={t("agents.firstRun.label")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand">
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold">
              {t("agents.firstRun.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("agents.firstRun.lede")}
            </p>
          </div>
        </div>
      </div>
      <Steps current={step} />
      {step === "provider" ? (
        <div className="space-y-4">
          <PresetPane
            cancelLabel={t("agents.firstRun.skipProvider")}
            submitLabel={t("agents.firstRun.addProvider")}
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
            {tr("agents.firstRun.added", {
              id: <span className="font-mono">{provider.id}</span>,
              region: provider.region
                ? t("agents.firstRun.region", { region: provider.region })
                : "",
              plan: provider.plan
                ? t("agents.firstRun.plan", { plan: provider.plan })
                : "",
            })}
          </p>
          {refresh.state === "busy" ? (
            <p
              className="flex items-center gap-2 text-[13px] text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" />
              {t("agents.firstRun.refreshing")}
            </p>
          ) : (
            <>
              {refresh.error ? (
                <p className="callout warn">
                  {t("agents.firstRun.refreshFailed", { error: refresh.error })}
                </p>
              ) : null}
              <p className="text-[13px]">
                {models.length
                  ? t(
                      models.length > 5
                        ? "agents.firstRun.modelsMore"
                        : "agents.firstRun.models",
                      {
                        name: provider.name,
                        n: models.length,
                        list: models
                          .slice(0, 5)
                          .join(t("agents.listSeparator")),
                      },
                    )
                  : t("agents.firstRun.noModels", { name: provider.name })}
              </p>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("agents.firstRun.stop")}
            </Button>
            <Button
              disabled={refresh.state === "busy"}
              onClick={() =>
                setStep(installed.length && models.length ? "agents" : "review")
              }
            >
              {t("agents.firstRun.continue")}
            </Button>
          </div>
        </div>
      ) : null}
      {step === "agents" ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            {t("agents.firstRun.chooseAgents")}
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
                          ? t("agents.firstRun.now", {
                              model: agent.wiring.model,
                            })
                          : installationText(agent.installation.status).label}
                      </span>
                    </span>
                  </span>
                </Checkbox>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("agents.firstRun.skipWiring")}
            </Button>
            <Button
              disabled={!selected.length}
              onClick={() => setStep("model")}
            >
              {t("agents.firstRun.continue")}
            </Button>
          </div>
        </div>
      ) : null}
      {step === "model" && pickerModels ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            {t("agents.firstRun.chooseModel", {
              names: selected
                .map((agent) => agent.name)
                .join(t("agents.listSeparator")),
            })}
          </p>
          <div className="max-w-[420px]">
            <ModelPicker
              label={t("agents.firstRun.step.model")}
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
              {t("agents.firstRun.back")}
            </Button>
            <Button disabled={busy || !model} onClick={review}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t("agents.detail.preview")}
            </Button>
          </div>
        </div>
      ) : null}
      {step === "review" ? (
        <div className="space-y-4">
          {!planned ? (
            <p className="text-[13px] text-muted-foreground">
              {!installed.length
                ? t("agents.firstRun.noAgents")
                : !models.length
                  ? t("agents.firstRun.providerNoModels")
                  : t("agents.firstRun.noneChosen")}
            </p>
          ) : outcomes ? (
            <ul
              className="space-y-1.5 text-[13.5px]"
              aria-label={t("agents.firstRun.results")}
            >
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
                      ? t("agents.firstRun.wired", { model: model ?? "" })
                      : item.outcome === "unchanged"
                        ? t("agents.firstRun.unchanged")
                        : t("agents.firstRun.failed", {
                            error: item.error ?? "",
                          })}
                  </span>
                  {item.notice ? (
                    <span className="basis-full pl-6 text-[12.5px] text-muted-foreground">
                      {item.notice}
                    </span>
                  ) : null}
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
                      <span className="tag">
                        {t("agents.firstRun.alreadyWired")}
                      </span>
                    )}
                  </p>
                  {plan?.changed ? (
                    <PlanFiles files={plan.files} keyNote={false} />
                  ) : null}
                  <WiringNotes
                    notice={plan?.changed ? plan.notice : undefined}
                    managed={plan?.managed}
                    after
                  />
                </section>
              ))}
              <p className="text-[12.5px] text-muted-foreground">
                {t("agents.firstRun.writeNote")}
              </p>
            </>
          )}
          <ErrorCallout failure={failure} />
          <div className="flex justify-end gap-2">
            {outcomes || !planned ? (
              <Button onClick={onClose}>{t("agents.firstRun.finish")}</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStep("model")}
                >
                  {t("agents.firstRun.back")}
                </Button>
                <Button
                  disabled={busy || !changing.length}
                  onClick={() => void apply()}
                >
                  {busy ? <Loader2 className="animate-spin" /> : null}
                  {t("agents.firstRun.write", { n: changing.length })}
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
