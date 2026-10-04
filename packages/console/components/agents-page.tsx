// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import { Bot, Loader2, RefreshCw } from "lucide-react";
import type {
  Agent,
  AgentWiringPlan,
  ProviderConfig,
  RouteGroup,
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
import { Skeleton } from "@/components/ui/skeleton";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import {
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  LocalTime,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";

const installationText: Record<
  Agent["installation"]["status"],
  { label: string; tone: string }
> = {
  installed: { label: "已安装", tone: "good" },
  "configured-only": { label: "只有配置", tone: "" },
  "not-found": { label: "未发现", tone: "" },
};

const driftText: Record<string, string> = {
  unwired: "未接到网关",
  replaced: "接线字段被改",
  "foreign-gateway": "指向其他网关",
};

/** Every model the gateway offers: exposed provider models and route groups. */
function gatewayModels(providers: ProviderConfig[], groups: RouteGroup[]) {
  return [
    ...providers.flatMap((provider) =>
      provider.models.list
        .filter(
          (model) =>
            provider.models.expose === "all" ||
            provider.models.expose.includes(model.id),
        )
        .map((model) => `${provider.id}/${model.id}`),
    ),
    ...groups.map((group) => `group/${group.id}`),
  ];
}

function DriftBadge({ agent }: { agent: Agent }) {
  const wiring = agent.wiring;
  if (!wiring) return <span className="text-subtle">—</span>;
  if (wiring.driftError)
    return (
      <span className="tag error" title={wiring.driftError}>
        无法检查
      </span>
    );
  if (!wiring.drift?.drifted) return <span className="tag good">一致</span>;
  return (
    <span
      className="tag warn"
      title={wiring.drift.findings
        .map((finding) => `${finding.path}: ${finding.keyPath.join(".")}`)
        .join("\n")}
    >
      {wiring.drift.kinds.map((kind) => driftText[kind] ?? kind).join("、")}
    </span>
  );
}

/** Choose a model and the models the agent lists, preview the file changes, then wire. */
function WireDialog({
  agent,
  models,
  onClose,
  onWired,
}: {
  agent: Agent;
  models: string[];
  onClose: () => void;
  onWired: () => void;
}) {
  const [model, setModel] = useState(agent.wiring?.model ?? models[0] ?? "");
  const [listed, setListed] = useState<string[]>(
    agent.wiring?.models ?? (models[0] ? [models[0]] : []),
  );
  const [plan, setPlan] = useState<AgentWiringPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const shown = [...new Set([model, ...listed])].filter(Boolean);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    action().then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  const preview = () =>
    run(async () => {
      setPlan(
        await modelPlane().agents.plan(agent.id, { model, models: shown }),
      );
    });
  const apply = () =>
    run(async () => {
      if (!plan) return;
      await modelPlane().agents.wire(agent.id, {
        model,
        models: shown,
        expect: plan,
      });
      onWired();
      onClose();
    });
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>
            {agent.wiring ? "修改" : "接线"} {agent.name}
          </DialogTitle>
          <DialogDescription>
            改写 {agent.name}{" "}
            自己的用户配置，让它经网关调用所选模型，并获得一把只属于它的
            Key。写入前先备份，之后可以还原。
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          // min-w-0: the dialog is a grid, and a long path or diff line
          // must scroll inside the block instead of widening the dialog.
          <div className="min-w-0 space-y-3">
            {plan.files.map((file) => (
              <section key={file.path} className="min-w-0 space-y-1">
                <p className="text-[13px] font-medium">
                  {file.exists ? "修改" : "新建"}{" "}
                  <span className="font-mono text-[12.5px] break-all">
                    {file.path}
                  </span>
                </p>
                <pre className="max-h-[40vh] overflow-auto rounded-xl border bg-muted p-3 font-mono text-[12px] leading-5">
                  {file.diff || "（无改动）"}
                </pre>
              </section>
            ))}
            <p className="text-[12.5px] text-muted-foreground">
              Key 以 hhk_a_xxxx… 显示；实际的 Key
              只写入上面的文件，不会显示或保存在别处。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="field-label">
              模型
              <select
                className="field"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map((ref) => (
                  <option key={ref} value={ref}>
                    {ref}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend className="field-label mb-1">
                在 {agent.name} 中显示的模型（{shown.length}/{models.length}）
              </legend>
              <div className="max-h-[34vh] space-y-1 overflow-y-auto rounded-xl border p-2">
                {models.map((ref) => (
                  <Checkbox
                    key={ref}
                    checked={shown.includes(ref)}
                    disabled={ref === model}
                    onChange={(on) =>
                      setListed((current) =>
                        on
                          ? [...current, ref]
                          : current.filter((item) => item !== ref),
                      )
                    }
                  >
                    <span className="font-mono text-[12.5px]">{ref}</span>
                  </Checkbox>
                ))}
              </div>
            </fieldset>
          </div>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          {plan ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPlan(null)}
              >
                返回
              </Button>
              <Button disabled={busy} onClick={apply}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                确认写入
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                取消
              </Button>
              <Button disabled={busy || !model} onClick={preview}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                预览改动
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The local agents: installation, wiring, drift and the wiring actions. */
export function AgentsPage() {
  const load = useCallback(async () => {
    const client = modelPlane();
    const [agents, providers, groups] = await Promise.all([
      client.agents.list(),
      client.providers.list(),
      client.routeGroups.list(),
    ]);
    return {
      agents: agents.items,
      models: gatewayModels(providers.items, groups.items),
    };
  }, []);
  const [data, reload] = useLoaded(load);
  const [wiring, setWiring] = useState<Agent | null>(null);
  const [rotating, setRotating] = useState<Agent | null>(null);
  const [unwiring, setUnwiring] = useState<Agent | null>(null);
  return (
    <div className="page-body">
      <div className="page-column max-w-[1080px]">
        <PageHeader
          title="Agent"
          lede="把本机的编码 Agent 接到网关：选择 Agent 与模型，预览配置文件的改动后写入；随时可以还原。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={reload}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6">
          {data.state === "loading" ? (
            <div className="panel space-y-3 p-5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : data.state === "error" ? (
            <p className="empty-state text-danger">读取失败：{data.message}</p>
          ) : (
            <div className="panel overflow-x-auto">
              <table className="data-table min-w-[820px]">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>安装</th>
                    <th>模型</th>
                    <th>漂移</th>
                    <th>接线时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.value.agents.map((agent) => {
                    const installed =
                      installationText[agent.installation.status];
                    return (
                      <tr key={agent.id}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <span className="grid size-8 place-items-center rounded-xl bg-muted text-muted-foreground">
                              <Bot className="size-4" strokeWidth={1.7} />
                            </span>
                            <div>
                              <p className="font-medium">{agent.name}</p>
                              <p className="font-mono text-[12px] text-subtle">
                                {agent.id} · {agent.protocol}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`tag ${installed.tone}`}
                            title={
                              agent.installation.executable ??
                              agent.installation.configDirectories.join("\n")
                            }
                          >
                            {installed.label}
                          </span>
                        </td>
                        <td className="max-w-[280px]">
                          {agent.wiring ? (
                            <>
                              <p className="truncate font-mono text-[12.5px]">
                                {agent.wiring.model}
                              </p>
                              <p
                                className="text-[12px] text-subtle"
                                title={agent.wiring.models.join("\n")}
                              >
                                显示 {agent.wiring.models.length}/
                                {data.value.models.length} 个模型
                                {agent.wiring.keyState !== "active"
                                  ? ` · Key ${agent.wiring.keyState}`
                                  : ""}
                              </p>
                            </>
                          ) : (
                            <span className="text-subtle">未接线</span>
                          )}
                        </td>
                        <td>
                          <DriftBadge agent={agent} />
                        </td>
                        <td className="text-[12.5px] text-muted-foreground">
                          <LocalTime value={agent.wiring?.wiredAt} />
                        </td>
                        <td className="w-[210px] text-right whitespace-nowrap">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!data.value.models.length}
                            title={
                              data.value.models.length
                                ? undefined
                                : "先在 Provider 页面添加模型"
                            }
                            onClick={() => setWiring(agent)}
                          >
                            {agent.wiring ? "修改" : "接线"}
                          </Button>
                          {agent.wiring ? (
                            <>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setRotating(agent)}
                              >
                                换 Key
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setUnwiring(agent)}
                              >
                                还原
                              </Button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {wiring && data.state === "ready" ? (
          <WireDialog
            agent={wiring}
            models={data.value.models}
            onClose={() => setWiring(null)}
            onWired={reload}
          />
        ) : null}
        <ConfirmDialog
          open={rotating !== null}
          title={`为 ${rotating?.name ?? ""} 更换 Key`}
          description="重新写入它的配置文件；旧 Key 立即失效，正在运行的实例需要重启。"
          action="更换"
          onClose={() => setRotating(null)}
          onConfirm={async () => {
            if (rotating) await modelPlane().agents.rotate(rotating.id);
            reload();
          }}
        />
        <ConfirmDialog
          open={unwiring !== null}
          title={`还原 ${unwiring?.name ?? ""}`}
          description="配置文件未被改动时恢复为接线前的原样；之后改过的文件只撤销 HarnessHub 写入的项。它的 Key 随即吊销。"
          action="还原"
          onClose={() => setUnwiring(null)}
          onConfirm={async () => {
            if (unwiring) await modelPlane().agents.unwire(unwiring.id);
            reload();
          }}
        />
      </div>
    </div>
  );
}
