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
  managedLines,
  modelVisibility,
  wiringInput,
  withNotice,
} from "@/lib/agents";
import { agentIconSlug } from "@/lib/brand-icons";
import { loadGatewayModels, type GatewayModels } from "@/lib/gateway-models";
import { modelPlane } from "@/lib/model-plane";
import { t } from "@/lib/i18n";
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
            {t("agents.badge.uncheckable")}
          </span>
        ) : wiring.drift?.drifted ? (
          <span className="tag warn">
            {wiring.drift.kinds.map(driftText).join(t("agents.listSeparator"))}
          </span>
        ) : (
          <span className="tag good">{t("agents.badge.consistent")}</span>
        )
      ) : null}
      {wiring?.managed?.length ? (
        <span
          className="tag warn"
          title={managedLines(wiring.managed).join("\n")}
        >
          {t("agents.badge.managed")}
        </span>
      ) : null}
      {problems.length ? (
        <span className="tag error" title={problems.join("\n")}>
          <CircleAlert className="size-3" aria-hidden />
          {t("agents.badge.attention")}
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
  const install = installationText(agent.installation.status);
  const ownModel = modelOptional(agent, wiring?.options);
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
          label={t("agents.row.modelOf", { name: agent.name })}
          models={models}
          value={wiring?.model}
          disabled={!models.sections.length}
          {...(ownModel
            ? { none: t("agents.ownModel", { name: agent.name }) }
            : {})}
          onChange={(ref) => {
            if (ref !== wiring?.model && (ref || ownModel)) onModel(ref);
          }}
        />
        <p className="mt-1 text-[12px] text-subtle">
          {wiring
            ? legacy
              ? t("agents.row.legacy")
              : ownModel && !wiring.model
                ? t("agents.row.chatgptOwn")
                : visibility
                  ? t(
                      ownModel ? "agents.row.chatgptShown" : "agents.row.shown",
                      {
                        shown: visibility.shown.length,
                        allowed: visibility.allowed.length,
                      },
                    )
                  : null
            : t("agents.row.unwired")}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-sm:w-full max-sm:justify-between sm:w-[310px]">
        <Badges agent={agent} models={models} />
        <span className="flex items-center">
          <Button size="xs" variant="ghost" onClick={onDetail}>
            <Settings2 />
            {t("agents.row.details")}
          </Button>
          {wiring ? (
            <Button size="xs" variant="ghost" onClick={onUnwire}>
              <Undo2 />
              {t("agents.restore")}
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
        <PageHeader title={t("agents.title")} lede={t("agents.lede")}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
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
            {t("common.nav.profiles")}
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
          {data.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label={t("common.loading")}
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
                    {t("agents.noProvider")}
                  </span>
                  <Button size="xs" onClick={() => setFirstRun("open")}>
                    {t("agents.startSetup")}
                  </Button>
                </div>
              ) : !data.value.models.sections.length ? (
                <div className="callout info items-center">
                  <span className="min-w-0 flex-1">{t("agents.noModels")}</span>
                  <Button size="xs" onClick={() => navigate("providers")}>
                    {t("agents.addProvider")}
                  </Button>
                </div>
              ) : null}
              {lists.needs.length ? (
                <div role="alert" className="callout warn items-start">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0">
                    <p>{t("agents.needs", { n: lists.needs.length })}</p>
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
                          {t("agents.needsReasons", {
                            reasons: attention(agent, data.value.models).join(
                              t("agents.reasonSeparator"),
                            ),
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
              {lists.here.length ? (
                <ul className="panel" aria-label={t("agents.here")}>
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
                <EmptyState icon={Bot} title={t("agents.empty.title")}>
                  {t("agents.empty.body")}
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
                    {t("agents.missingCount", { n: lists.missing.length })}
                  </button>
                  {showMissing ? (
                    <ul className="panel mt-2" aria-label={t("agents.missing")}>
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
            title={t(
              wiring.agent.wiring ? "agents.switchTitle" : "agents.wireTitle",
              {
                name: wiring.agent.name,
              },
            )}
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
          title={t("agents.restoreTitle", { name: unwiring?.name ?? "" })}
          description={t("agents.restoreDescription")}
          action={t("agents.restore")}
          onClose={() => setUnwiring(null)}
          onConfirm={async () => {
            if (!unwiring) return;
            const result = await modelPlane().agents.unwire(unwiring.id);
            notify.success(
              withNotice(
                t("agents.restored", {
                  name: unwiring.name,
                  n: result.files.length,
                }),
                result.agent.notice,
              ),
            );
            reload();
          }}
        />
      </div>
    </div>
  );
}
