// SPDX-License-Identifier: MIT
import { useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Search, Undo2 } from "lucide-react";
import type { Agent, AgentWiringInput } from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BrandIcon } from "@/components/brand-icon";
import { ModelPicker } from "@/components/model-picker";
import {
  attention,
  draftOf,
  driftReasonText,
  driftText,
  effortText,
  installationText,
  keylessOptions,
  modelVisibility,
  optionText,
  tierText,
  wiringInput,
  type WiringDraft,
} from "@/lib/agents";
import { agentIconSlug } from "@/lib/brand-icons";
import type { GatewayModels } from "@/lib/gateway-models";
import { modelPlane } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { ConfirmDialog, LocalTime } from "./model-plane-ui";
import { WirePlanDialog } from "./wire-plan-dialog";

const keyStateText: Record<string, { label: string; tone: string }> = {
  active: { label: "可用", tone: "good" },
  revoked: { label: "已吊销", tone: "error" },
  expired: { label: "已过期", tone: "error" },
  missing: { label: "不存在", tone: "error" },
  none: { label: "无 Key", tone: "" },
};

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="section-title">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Model, tiers, effort and adapter options; preview opens the plan dialog. */
function WiringForm({
  agent,
  models,
  onPreview,
}: {
  agent: Agent;
  models: GatewayModels;
  onPreview: (input: AgentWiringInput) => void;
}) {
  const [draft, setDraft] = useState<WiringDraft>(() => draftOf(agent));
  const keyless = keylessOptions(draft.options);
  const capabilities = agent.capabilities;
  const set = (patch: Partial<WiringDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  return (
    <div className="space-y-3">
      {Object.entries(capabilities.options).map(([name, values]) => (
        <label key={name} className="field-label">
          {optionText[name]?.label ?? name}
          <select
            className="field"
            value={draft.options[name] ?? values[0]}
            onChange={(event) =>
              set({ options: { ...draft.options, [name]: event.target.value } })
            }
          >
            {values.map((value) => (
              <option key={value} value={value}>
                {optionText[name]?.values[value] ?? value}
              </option>
            ))}
          </select>
        </label>
      ))}
      {keyless ? (
        <p className="callout neutral">
          {agent.name} 自己登录并选择模型；HarnessHub
          只把它的请求经网关转发并记账，不写模型、档位或 Key。
        </p>
      ) : (
        <>
          <div>
            <span className="field-label">主模型</span>
            <ModelPicker
              className="mt-1.5"
              label="主模型"
              models={models}
              value={draft.model}
              onChange={(ref) => set({ model: ref })}
            />
          </div>
          {capabilities.tiers.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {capabilities.tiers.map((tier) => (
                <div key={tier}>
                  <span className="field-label">{tierText[tier]}</span>
                  <ModelPicker
                    className="mt-1.5"
                    label={tierText[tier]}
                    models={models}
                    value={draft.tiers[tier]}
                    none="跟随主模型"
                    onChange={(ref) =>
                      set({ tiers: { ...draft.tiers, [tier]: ref } })
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}
          {capabilities.efforts.length ? (
            <label className="field-label">
              推理强度（effort）
              <select
                className="field"
                value={draft.effort ?? ""}
                onChange={(event) =>
                  set({
                    effort: capabilities.efforts.find(
                      (effort) => effort === event.target.value,
                    ),
                  })
                }
              >
                <option value="">默认（不设置）</option>
                {capabilities.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effortText[effort]}（{effort}）
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      )}
      <div className="flex justify-end">
        <Button
          disabled={!keyless && !draft.model}
          onClick={() => onPreview(wiringInput(agent, draft))}
        >
          预览改动
        </Button>
      </div>
    </div>
  );
}

/** Which of the gateway's models the agent lists; hiding changes its key's deny list in place. */
function ModelVisibility({
  agent,
  models,
  onChanged,
}: {
  agent: Agent;
  models: GatewayModels;
  onChanged: (agent: Agent) => void;
}) {
  const visibility = useMemo(
    () => modelVisibility(agent, models),
    [agent, models],
  );
  const [hidden, setHidden] = useState(() => new Set(agent.wiring?.hidden));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const wiring = agent.wiring;
  if (!wiring) return null;
  const changed =
    hidden.size !== wiring.hidden.length ||
    wiring.hidden.some((ref) => !hidden.has(ref));
  const inUse = new Set(
    [wiring.model, ...Object.values(wiring.tiers ?? {})].filter(Boolean),
  );
  const shown = visibility.allowed.filter((ref) => !hidden.has(ref)).length;
  const needle = query.trim().toLowerCase();
  const list = visibility.allowed.filter((ref) =>
    ref.toLowerCase().includes(needle),
  );
  const save = () => {
    setBusy(true);
    modelPlane()
      .agents.setHidden(agent.id, [...hidden])
      .then(
        (updated) => {
          setBusy(false);
          notify.success(`${agent.name} 现在显示 ${shown} 个模型`);
          onChanged(updated);
        },
        (reason: unknown) => {
          setBusy(false);
          notify.error(reason, "没有保存");
        },
      );
  };
  return (
    <Section
      title={`显示 ${shown} / ${visibility.allowed.length} 个模型`}
      aside={
        <Button size="sm" disabled={!changed || busy} onClick={save}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          保存
        </Button>
      }
    >
      <p className="text-[12.5px] text-muted-foreground">
        隐藏的模型从 {agent.name} 的模型列表和它的 Key 可用的模型中去掉，Key
        不变；网关之后新增的模型默认显示。
      </p>
      <label className="flex h-9 items-center gap-2 rounded-[10px] border px-3">
        <Search className="size-4 shrink-0 text-subtle" />
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
          placeholder="筛选模型"
          aria-label="筛选模型"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ul className="max-h-[260px] space-y-0.5 overflow-y-auto rounded-xl border p-1.5">
        {list.map((ref) => {
          const off = hidden.has(ref);
          const locked = inUse.has(ref);
          return (
            <li key={ref}>
              <button
                type="button"
                disabled={locked}
                aria-pressed={!off}
                title={locked ? "正在使用的模型不能隐藏" : undefined}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() =>
                  setHidden((current) => {
                    const next = new Set(current);
                    if (next.has(ref)) next.delete(ref);
                    else next.add(ref);
                    return next;
                  })
                }
              >
                {off ? (
                  <EyeOff className="size-4 shrink-0 text-subtle" />
                ) : (
                  <Eye className="size-4 shrink-0 text-brand" />
                )}
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${off ? "text-subtle line-through" : ""}`}
                >
                  {ref}
                </span>
                {locked ? <span className="tag">使用中</span> : null}
              </button>
            </li>
          );
        })}
        {!list.length ? (
          <li className="px-2 py-4 text-center text-[13px] text-muted-foreground">
            没有匹配的模型
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/**
 * One agent: where it is installed, its wiring (model, tiers, effort and
 * adapter options) with a preview before every write, the models it shows,
 * its key, its files and their drift, and restoring its configuration.
 */
export function AgentDetail({
  agent,
  models,
  onClose,
  onChanged,
}: {
  agent: Agent;
  models: GatewayModels;
  onClose: () => void;
  onChanged: (agent: Agent) => void;
}) {
  const [plan, setPlan] = useState<AgentWiringInput | null>(null);
  const [confirm, setConfirm] = useState<"rotate" | "unwire" | null>(null);
  const wiring = agent.wiring;
  const keyless = keylessOptions(wiring?.options);
  const install = installationText[agent.installation.status];
  const problems = attention(agent, models);
  const keyState = keyStateText[wiring?.keyState ?? "none"] ?? {
    label: wiring?.keyState ?? "—",
    tone: "",
  };
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BrandIcon slug={agentIconSlug(agent.id)} name={agent.name} />
            <div className="min-w-0">
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {agent.name}
                <span className={`tag ${install.tone}`}>{install.label}</span>
              </DialogTitle>
              <DialogDescription className="font-mono text-[12px]">
                {agent.id} · {agent.protocol} ·{" "}
                {agent.keyDelivery === "env-file"
                  ? "Key 写入 Agent 读取的 .env"
                  : "Key 写入配置文件"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {problems.length ? (
          <ul
            role="alert"
            className="callout warn block list-disc space-y-0.5 pl-8"
          >
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        <dl className="text-[13px]">
          {agent.installation.executable ? (
            <div className="metric-row">
              <dt>命令</dt>
              <dd className="font-mono text-[12px]">
                {agent.installation.executable}
              </dd>
            </div>
          ) : null}
          <div className="metric-row">
            <dt>配置目录</dt>
            <dd className="font-mono text-[12px]">
              {agent.installation.configDirectories.join("、") || "—"}
            </dd>
          </div>
          {wiring ? (
            <div className="metric-row">
              <dt>接线时间</dt>
              <dd>
                <LocalTime value={wiring.wiredAt} />
              </dd>
            </div>
          ) : null}
        </dl>
        <Section title={wiring ? "接线" : "接到网关"}>
          <WiringForm
            key={wiring?.wiredAt ?? "new"}
            agent={agent}
            models={models}
            onPreview={setPlan}
          />
        </Section>
        {wiring && !keyless ? (
          <ModelVisibility
            key={wiring.hidden.join(",")}
            agent={agent}
            models={models}
            onChanged={onChanged}
          />
        ) : null}
        {wiring ? (
          <Section
            title="Key"
            aside={
              keyless ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirm("rotate")}
                >
                  <KeyRound />换 Key
                </Button>
              )
            }
          >
            {keyless ? (
              <p className="text-[13px] text-muted-foreground">
                {agent.name} 自己登录，没有 HarnessHub 的 Key。
              </p>
            ) : (
              <p className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-mono text-[12.5px]">
                  {wiring.keyId ?? "—"}
                </span>
                <span className={`tag ${keyState.tone}`}>{keyState.label}</span>
              </p>
            )}
          </Section>
        ) : null}
        {wiring ? (
          <Section
            title="配置文件"
            aside={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirm("unwire")}
              >
                <Undo2 />
                还原
              </Button>
            }
          >
            <ul className="space-y-1 font-mono text-[12px]">
              {wiring.files.map((file) => (
                <li key={file} className="break-all">
                  {file}
                </li>
              ))}
            </ul>
            {wiring.drift?.findings.length ? (
              <div className="overflow-x-auto rounded-xl border">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>文件</th>
                      <th>字段</th>
                      <th>变化</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wiring.drift.findings.map((finding) => (
                      <tr key={`${finding.path}:${finding.keyPath.join(".")}`}>
                        <td className="font-mono text-[12px] break-all">
                          {finding.path}
                        </td>
                        <td className="font-mono text-[12px]">
                          {finding.keyPath.join(".")}
                        </td>
                        <td>
                          {driftText[finding.kind] ?? finding.kind}（
                          {driftReasonText[finding.reason] ?? finding.reason}）
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : wiring.driftError ? (
              <p className="callout error">{wiring.driftError}</p>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                与接线时写入的内容一致。
              </p>
            )}
          </Section>
        ) : null}
        {plan ? (
          <WirePlanDialog
            agent={agent}
            input={plan}
            title={`${wiring ? "修改" : "接线"} ${agent.name}`}
            onClose={() => setPlan(null)}
            onWired={onChanged}
          />
        ) : null}
        <ConfirmDialog
          open={confirm === "rotate"}
          title={`给 ${agent.name} 换一把新 Key`}
          description="以当前的模型与列表重新接线并签发新 Key，旧 Key 立即失效。正在运行的实例要重启后才用新 Key。"
          action="换 Key"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            onChanged(await modelPlane().agents.rotate(agent.id));
            notify.success(`${agent.name} 已换用新 Key`);
          }}
        />
        <ConfirmDialog
          open={confirm === "unwire"}
          title={`还原 ${agent.name}`}
          description="配置文件未被改动时恢复为接线前的原样；之后改过的文件只撤销 HarnessHub 写入的项。它的 Key 随即吊销。"
          action="还原"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const result = await modelPlane().agents.unwire(agent.id);
            notify.success(
              `${agent.name} 已还原（${result.files.length} 个文件）`,
            );
            onChanged(result.agent);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
