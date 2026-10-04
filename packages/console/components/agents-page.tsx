// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  CircleAlert,
  Layers,
  RefreshCw,
  Settings2,
  Undo2,
} from "lucide-react";
import type { Agent, AgentWiringInput } from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BrandIcon } from "@/components/brand-icon";
import { ModelPicker } from "@/components/model-picker";
import {
  attention,
  draftOf,
  driftText,
  installationText,
  legacyKeyless,
  modelOptional,
  modelVisibility,
  wiringInput,
} from "@/lib/agents";
import { agentIconSlug } from "@/lib/brand-icons";
import { loadGatewayModels, type GatewayModels } from "@/lib/gateway-models";
import { modelPlane } from "@/lib/model-plane";
import { navigate, useSearch } from "@/lib/router";
import { notify } from "@/lib/toast";
import { AgentDetail } from "./agent-detail";
import { FirstRun } from "./first-run";
import {
  ConfirmDialog,
  EmptyState,
  LoadError,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";
import { WirePlanDialog } from "./wire-plan-dialog";

function Badges({ agent, models }: { agent: Agent; models: GatewayModels }) {
  const wiring = agent.wiring;
  const problems = attention(agent, models);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {wiring ? (
        wiring.driftError ? (
          <span className="tag error" title={wiring.driftError}>
            无法检查
          </span>
        ) : wiring.drift?.drifted ? (
          <span className="tag warn">
            {wiring.drift.kinds
              .map((kind) => driftText[kind] ?? kind)
              .join("、")}
          </span>
        ) : (
          <span className="tag good">一致</span>
        )
      ) : null}
      {problems.length ? (
        <span className="tag error" title={problems.join("\n")}>
          <CircleAlert className="size-3" aria-hidden />
          需要处理
        </span>
      ) : null}
    </span>
  );
}

/** One agent: its mark, installation, current model (a picker) and badges. */
function AgentRow({
  agent,
  models,
  onModel,
  onDetail,
  onUnwire,
}: {
  agent: Agent;
  models: GatewayModels;
  /** A model, or undefined for the agent's own (agents that may keep theirs). */
  onModel: (ref: string | undefined) => void;
  onDetail: () => void;
  onUnwire: () => void;
}) {
  const wiring = agent.wiring;
  const install = installationText[agent.installation.status];
  const ownModel = modelOptional(wiring?.options);
  const legacy = legacyKeyless(agent);
  const visibility = wiring ? modelVisibility(agent, models) : undefined;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b px-4 py-3.5 last:border-b-0 sm:px-5">
      <button
        type="button"
        className="flex min-w-0 flex-1 basis-[220px] items-center gap-3 rounded-lg text-left"
        onClick={onDetail}
      >
        <BrandIcon slug={agentIconSlug(agent.id)} name={agent.name} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{agent.name}</span>
            <span className={`tag ${install.tone}`}>{install.label}</span>
          </span>
          <span className="block truncate font-mono text-[12px] text-subtle">
            {agent.id} · {agent.protocol}
          </span>
        </span>
      </button>
      <div className="w-full min-w-0 sm:w-[300px]">
        <ModelPicker
          label={`${agent.name} 的模型`}
          models={models}
          value={wiring?.model}
          disabled={!models.sections.length}
          {...(ownModel ? { none: `${agent.name} 自己的模型` } : {})}
          onChange={(ref) => {
            if (ref !== wiring?.model && (ref || ownModel)) onModel(ref);
          }}
        />
        <p className="mt-1 text-[12px] text-subtle">
          {wiring
            ? legacy
              ? "ChatGPT 登录 · 旧接线没有 Key"
              : ownModel && !wiring.model
                ? "ChatGPT 登录 · 用 Codex 自己的模型"
                : visibility
                  ? `${ownModel ? "ChatGPT 登录 · " : ""}显示 ${visibility.shown.length} / ${visibility.allowed.length} 个模型`
                  : null
            : "未接线，选择模型即可预览接线"}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-sm:w-full max-sm:justify-between sm:w-[310px]">
        <Badges agent={agent} models={models} />
        <span className="flex items-center">
          <Button size="xs" variant="ghost" onClick={onDetail}>
            <Settings2 />
            详情
          </Button>
          {wiring ? (
            <Button size="xs" variant="ghost" onClick={onUnwire}>
              <Undo2 />
              还原
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * The home page (Magpie's main screen): every agent on this machine with
 * the model it uses through the gateway. Picking a model previews the file
 * changes and writes them on confirmation; the detail holds tiers, effort,
 * adapter options, shown models, the key and the files. `?agent=<id>`
 * opens an agent's detail.
 */
export function AgentsPage() {
  const load = useCallback(async () => {
    const [agents, models, providers] = await Promise.all([
      modelPlane().agents.list(),
      loadGatewayModels(),
      modelPlane().providers.list(),
    ]);
    return {
      agents: agents.items,
      models,
      providers: providers.items.length,
    };
  }, []);
  const [data, reload] = useLoaded(load);
  // Offered once per visit when there is no provider; it stays open while it
  // runs, as the provider it adds would otherwise end it.
  const [firstRun, setFirstRun] = useState<"unknown" | "open" | "closed">(
    "unknown",
  );
  const noProvider = data.state === "ready" && data.value.providers === 0;
  useEffect(() => {
    if (firstRun === "unknown" && data.state === "ready")
      setFirstRun(noProvider ? "open" : "closed");
  }, [firstRun, data.state, noProvider]);
  const showFirstRun =
    firstRun === "open" || (firstRun === "unknown" && noProvider);
  const [wiring, setWiring] = useState<{
    agent: Agent;
    input: AgentWiringInput;
  } | null>(null);
  const [unwiring, setUnwiring] = useState<Agent | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const search = useSearch();
  const detailId = new URLSearchParams(search).get("agent");
  const openDetail = (id: string | null) =>
    navigate("agents", {
      search: id ? `?agent=${encodeURIComponent(id)}` : "",
    });
  const wire = (agent: Agent, model: string | undefined) =>
    setWiring({
      agent,
      input: wiringInput(agent, { ...draftOf(agent), model }),
    });
  const lists = useMemo(() => {
    if (data.state !== "ready") return { here: [], missing: [], needs: [] };
    const { agents, models } = data.value;
    const here = agents.filter(
      (agent) => agent.wiring || agent.installation.status !== "not-found",
    );
    // Agents that need attention first, then wired ones, then the rest as listed.
    const rank = (agent: Agent) =>
      attention(agent, models).length ? 0 : agent.wiring ? 1 : 2;
    here.sort((a, b) => rank(a) - rank(b));
    return {
      here,
      missing: agents.filter(
        (agent) => !agent.wiring && agent.installation.status === "not-found",
      ),
      needs: here.filter((agent) => attention(agent, models).length),
    };
  }, [data]);
  const detail =
    data.state === "ready" && detailId
      ? data.value.agents.find((agent) => agent.id === detailId)
      : undefined;
  return (
    <div className="page-body">
      <div className="page-column max-w-[1080px]">
        <PageHeader
          title="Agent"
          lede="本机的编码 Agent 经网关使用的模型。点模型即可切换：先预览配置文件的改动，确认后写入，随时可以还原。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={reload}
          >
            <RefreshCw />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("profiles")}
          >
            <Layers />
            Profile
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
          {data.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label="正在读取"
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : data.state === "error" ? (
            <LoadError message={data.message} retry={reload} />
          ) : showFirstRun ? (
            <FirstRun
              agents={data.value.agents}
              onClose={() => {
                setFirstRun("closed");
                reload();
              }}
            />
          ) : (
            <>
              {noProvider ? (
                <div className="callout info items-center">
                  <span className="min-w-0 flex-1">
                    还没有 provider：添加一个模型 provider，再给 Agent
                    选择模型。
                  </span>
                  <Button size="xs" onClick={() => setFirstRun("open")}>
                    开始设置
                  </Button>
                </div>
              ) : !data.value.models.sections.length ? (
                <div className="callout info items-center">
                  <span className="min-w-0 flex-1">
                    网关还没有模型：先添加一个 provider，再给 Agent 选择模型。
                  </span>
                  <Button size="xs" onClick={() => navigate("providers")}>
                    添加 provider
                  </Button>
                </div>
              ) : null}
              {lists.needs.length ? (
                <div role="alert" className="callout warn items-start">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0">
                    <p>{lists.needs.length} 个 Agent 需要处理：</p>
                    <ul className="mt-1 list-disc pl-5">
                      {lists.needs.map((agent) => (
                        <li key={agent.id}>
                          <button
                            type="button"
                            className="underline underline-offset-2"
                            onClick={() => openDetail(agent.id)}
                          >
                            {agent.name}
                          </button>
                          ：{attention(agent, data.value.models).join("；")}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
              {lists.here.length ? (
                <ul className="panel" aria-label="本机的 Agent">
                  {lists.here.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      models={data.value.models}
                      onDetail={() => openDetail(agent.id)}
                      onUnwire={() => setUnwiring(agent)}
                      onModel={(ref) => wire(agent, ref)}
                    />
                  ))}
                </ul>
              ) : (
                <EmptyState icon={Bot} title="本机没有发现 Agent">
                  安装 Claude Code、Codex、OpenCode 等编码 Agent
                  后刷新；也可以在下面为尚未安装的 Agent 预先写好配置。
                </EmptyState>
              )}
              {lists.missing.length ? (
                <section>
                  <button
                    type="button"
                    className="flex min-h-8 items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
                    aria-expanded={showMissing}
                    onClick={() => setShowMissing((value) => !value)}
                  >
                    <ChevronDown
                      className={`size-4 transition-transform ${showMissing ? "" : "-rotate-90"}`}
                    />
                    未发现的 Agent（{lists.missing.length}）
                  </button>
                  {showMissing ? (
                    <ul className="panel mt-2" aria-label="未发现的 Agent">
                      {lists.missing.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          models={data.value.models}
                          onDetail={() => openDetail(agent.id)}
                          onUnwire={() => setUnwiring(agent)}
                          onModel={(ref) => wire(agent, ref)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
            </>
          )}
        </div>
        {wiring ? (
          <WirePlanDialog
            agent={wiring.agent}
            input={wiring.input}
            title={`${wiring.agent.wiring ? "切换" : "接线"} ${wiring.agent.name}`}
            onClose={() => setWiring(null)}
            onWired={reload}
          />
        ) : null}
        {detail && data.state === "ready" ? (
          <AgentDetail
            key={detail.id}
            agent={detail}
            models={data.value.models}
            onClose={() => openDetail(null)}
            onChanged={reload}
          />
        ) : null}
        <ConfirmDialog
          open={unwiring !== null}
          title={`还原 ${unwiring?.name ?? ""}`}
          description="配置文件未被改动时恢复为接线前的原样；之后改过的文件只撤销 HarnessHub 写入的项。它的 Key 随即吊销。"
          action="还原"
          onClose={() => setUnwiring(null)}
          onConfirm={async () => {
            if (!unwiring) return;
            const result = await modelPlane().agents.unwire(unwiring.id);
            notify.success(
              `${unwiring.name} 已还原（${result.files.length} 个文件）`,
            );
            reload();
          }}
        />
      </div>
    </div>
  );
}
