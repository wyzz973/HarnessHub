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
  legacyKeyless,
  modelOptional,
  modelVisibility,
  optionLabel,
  optionValueText,
  tierText,
  wiringInput,
  withNotice,
  type WiringDraft,
} from "@/lib/agents";
import { agentIconSlug } from "@/lib/brand-icons";
import type { GatewayModels } from "@/lib/gateway-models";
import { t } from "@/lib/i18n";
import { modelPlane } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { ConfirmDialog, LocalTime } from "./model-plane-ui";
import { WirePlanDialog } from "./wire-plan-dialog";
import { WiringNotes } from "./wiring-notes";

/** The state of an agent's key as a tag. */
function keyStateText(state: NonNullable<Agent["wiring"]>["keyState"]): {
  label: string;
  tone: string;
} {
  return {
    label: t(`agents.keyState.${state}`),
    tone: state === "active" ? "good" : state === "none" ? "" : "error",
  };
}

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
  const ownModel = modelOptional(agent, draft.options);
  const capabilities = agent.capabilities;
  const set = (patch: Partial<WiringDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  // Switching to an option that keeps the agent's own model starts without
  // a model: the other mode's model is not carried over (ADR 0030).
  const setOption = (name: string, value: string) => {
    const options = { ...draft.options, [name]: value };
    set(
      modelOptional(agent, options) && !modelOptional(agent, draft.options)
        ? { options, model: undefined, effort: undefined, tiers: {} }
        : { options },
    );
  };
  return (
    <div className="space-y-3">
      {Object.entries(capabilities.options).map(([name, values]) => (
        <label key={name} className="field-label">
          {optionLabel(name)}
          <select
            className="field"
            value={draft.options[name] ?? values[0]}
            onChange={(event) => setOption(name, event.target.value)}
          >
            {values.map((value) => (
              <option key={value} value={value}>
                {optionValueText(name, value)}
              </option>
            ))}
          </select>
        </label>
      ))}
      {ownModel ? (
        <p className="callout neutral">
          {t("agents.detail.chatgptMode", { name: agent.name })}
        </p>
      ) : null}
      <>
        <div>
          <span className="field-label">{t("agents.detail.mainModel")}</span>
          <ModelPicker
            className="mt-1.5"
            label={t("agents.detail.mainModel")}
            models={models}
            value={draft.model}
            {...(ownModel
              ? { none: t("agents.ownModel", { name: agent.name }) }
              : {})}
            onChange={(ref) =>
              set(
                ref || !ownModel
                  ? { model: ref }
                  : { model: undefined, effort: undefined },
              )
            }
          />
        </div>
        {capabilities.tiers.length && !(ownModel && !draft.model) ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {capabilities.tiers.map((tier) => (
              <div key={tier}>
                <span className="field-label">{tierText(tier)}</span>
                <ModelPicker
                  className="mt-1.5"
                  label={tierText(tier)}
                  models={models}
                  value={draft.tiers[tier]}
                  none={t("agents.detail.followMain")}
                  onChange={(ref) =>
                    set({ tiers: { ...draft.tiers, [tier]: ref } })
                  }
                />
              </div>
            ))}
          </div>
        ) : null}
        {capabilities.efforts.length && !(ownModel && !draft.model) ? (
          <label className="field-label">
            {t("agents.detail.effort")}
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
              <option value="">{t("agents.detail.effortDefault")}</option>
              {capabilities.efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {t("agents.detail.effortOption", {
                    label: effortText(effort),
                    effort,
                  })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </>
      <div className="flex justify-end">
        <Button
          disabled={!ownModel && !draft.model}
          onClick={() => onPreview(wiringInput(agent, draft))}
        >
          {t("agents.detail.preview")}
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
          notify.success(
            withNotice(
              t("agents.visibility.saved", { name: agent.name, n: shown }),
              updated.notice,
            ),
          );
          onChanged(updated);
        },
        (reason: unknown) => {
          setBusy(false);
          notify.error(reason, t("agents.visibility.notSaved"));
        },
      );
  };
  return (
    <Section
      title={t("agents.row.shown", {
        shown,
        allowed: visibility.allowed.length,
      })}
      aside={
        <Button size="sm" disabled={!changed || busy} onClick={save}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t("agents.visibility.save")}
        </Button>
      }
    >
      <p className="text-[12.5px] text-muted-foreground">
        {t("agents.visibility.help", { name: agent.name })}
      </p>
      <label className="flex h-9 items-center gap-2 rounded-[10px] border px-3">
        <Search className="size-4 shrink-0 text-subtle" />
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
          placeholder={t("agents.visibility.filter")}
          aria-label={t("agents.visibility.filter")}
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
                title={locked ? t("agents.visibility.locked") : undefined}
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
                {locked ? (
                  <span className="tag">{t("agents.visibility.inUse")}</span>
                ) : null}
              </button>
            </li>
          );
        })}
        {!list.length ? (
          <li className="px-2 py-4 text-center text-[13px] text-muted-foreground">
            {t("agents.picker.noMatch")}
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
  const legacy = legacyKeyless(agent);
  const install = installationText(agent.installation.status);
  const problems = attention(agent, models);
  const keyState = keyStateText(wiring?.keyState ?? "none");
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
                  ? t("agents.detail.keyInEnv")
                  : t("agents.detail.keyInConfig")}
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
              <dt>{t("agents.detail.command")}</dt>
              <dd className="font-mono text-[12px]">
                {agent.installation.executable}
              </dd>
            </div>
          ) : null}
          <div className="metric-row">
            <dt>{t("agents.detail.configDirectories")}</dt>
            <dd className="font-mono text-[12px]">
              {agent.installation.configDirectories.join(
                t("agents.listSeparator"),
              ) || "—"}
            </dd>
          </div>
          {wiring ? (
            <div className="metric-row">
              <dt>{t("agents.detail.wiredAt")}</dt>
              <dd>
                <LocalTime value={wiring.wiredAt} />
              </dd>
            </div>
          ) : null}
          {agent.notice ? (
            <div className="metric-row">
              <dt>{t("agents.notice.label")}</dt>
              <dd className="max-w-[460px]">{agent.notice}</dd>
            </div>
          ) : null}
        </dl>
        <WiringNotes managed={wiring?.managed} />
        <Section
          title={wiring ? t("agents.detail.wiring") : t("agents.detail.wireUp")}
        >
          <WiringForm
            key={wiring?.wiredAt ?? "new"}
            agent={agent}
            models={models}
            onPreview={setPlan}
          />
        </Section>
        {wiring && !legacy ? (
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirm("rotate")}
              >
                <KeyRound />
                {legacy ? t("agents.key.issue") : t("agents.key.rotate")}
              </Button>
            }
          >
            {legacy ? (
              <p className="callout info">
                {t("agents.key.legacy", { name: agent.name })}
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
            title={t("agents.detail.files")}
            aside={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirm("unwire")}
              >
                <Undo2 />
                {t("agents.restore")}
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
                      <th>{t("agents.findings.file")}</th>
                      <th>{t("agents.findings.field")}</th>
                      <th>{t("agents.findings.change")}</th>
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
                          {t("agents.findings.item", {
                            kind: driftText(finding.kind),
                            reason: driftReasonText(finding.reason),
                          })}
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
                {t("agents.findings.none")}
              </p>
            )}
          </Section>
        ) : null}
        {plan ? (
          <WirePlanDialog
            agent={agent}
            input={plan}
            title={t(wiring ? "agents.changeTitle" : "agents.wireTitle", {
              name: agent.name,
            })}
            onClose={() => setPlan(null)}
            onWired={onChanged}
          />
        ) : null}
        <ConfirmDialog
          open={confirm === "rotate"}
          title={t(
            legacy ? "agents.key.issueTitle" : "agents.key.rotateTitle",
            {
              name: agent.name,
            },
          )}
          description={
            legacy
              ? t("agents.key.issueDescription")
              : t("agents.key.rotateDescription")
          }
          action={legacy ? t("agents.key.issue") : t("agents.key.rotate")}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const rotated = await modelPlane().agents.rotate(agent.id);
            onChanged(rotated);
            notify.success(
              withNotice(
                t(legacy ? "agents.key.issued" : "agents.key.rotated", {
                  name: agent.name,
                }),
                rotated.notice,
              ),
            );
          }}
        />
        <ConfirmDialog
          open={confirm === "unwire"}
          title={t("agents.restoreTitle", { name: agent.name })}
          description={t("agents.restoreDescription")}
          action={t("agents.restore")}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const result = await modelPlane().agents.unwire(agent.id);
            notify.success(
              withNotice(
                t("agents.restored", {
                  name: agent.name,
                  n: result.files.length,
                }),
                result.agent.notice,
              ),
            );
            onChanged(result.agent);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
