// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ProfilePlan, WiringProfile } from "@harnesshub/sdk/client";
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
import { effortText, modelOptional, tierLabel } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import {
  ConfirmDialog,
  EmptyState,
  ErrorCallout,
  LoadError,
  LocalTime,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";
import { PlanFiles } from "./plan-files";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One agent's choice in a profile, as a line of text. */
function choiceText(choice: WiringProfile["agents"][string]): string {
  const parts = modelOptional(choice.options)
    ? [t("agents.profiles.chatgpt"), ...(choice.model ? [choice.model] : [])]
    : [choice.model ?? "—"];
  for (const [tier, ref] of Object.entries(choice.tiers ?? {}))
    parts.push(`${tierLabel(tier)} ${ref}`);
  if (choice.effort) parts.push(`effort ${effortText(choice.effort)}`);
  return parts.join(" · ");
}

/** Name a profile and save every wired agent's choices under it. */
function SaveDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const valid = PROFILE_NAME.test(name);
  const replaces = existing.includes(name);
  const save = () => {
    setBusy(true);
    setFailure(null);
    modelPlane()
      .profiles.save(name)
      .then(
        (profile) => {
          setBusy(false);
          notify.success(
            t("agents.profiles.saved", {
              name: profile.name,
              n: Object.keys(profile.agents).length,
            }),
          );
          onSaved();
          onClose();
        },
        (reason: unknown) => {
          setBusy(false);
          setFailure(failureOf(reason));
        },
      );
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("agents.profiles.save")}</DialogTitle>
          <DialogDescription>
            {t("agents.profiles.saveDescription")}
          </DialogDescription>
        </DialogHeader>
        <label className="field-label">
          {t("agents.profiles.name")}
          <input
            className="field font-mono"
            value={name}
            autoFocus
            placeholder="work"
            aria-invalid={name !== "" && !valid}
            onChange={(event) => setName(event.target.value.trim())}
          />
          <span className="field-hint">{t("agents.profiles.nameHint")}</span>
        </label>
        {replaces ? (
          <p className="callout warn">{t("agents.profiles.replaces")}</p>
        ) : null}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !valid} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {replaces
              ? t("agents.profiles.replace")
              : t("agents.profiles.saveAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The changes applying a profile makes, agent by agent; applied on confirmation. */
function ApplyDialog({
  name,
  onClose,
  onApplied,
}: {
  name: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [plan, setPlan] = useState<ProfilePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    let current = true;
    modelPlane()
      .profiles.plan(name)
      .then(
        (value) => {
          if (current) setPlan(value);
        },
        (reason: unknown) => {
          if (current) setFailure(failureOf(reason));
        },
      );
    return () => {
      current = false;
    };
  }, [name]);
  const changed = plan?.agents.filter((agent) => agent.changed) ?? [];
  const apply = () => {
    if (!plan) return;
    setBusy(true);
    setFailure(null);
    modelPlane()
      .profiles.apply(name, plan)
      .then(
        (result) => {
          setBusy(false);
          const applied = result.agents.filter(
            (agent) => agent.outcome === "applied",
          ).length;
          notify.success(t("agents.profiles.applied", { name, n: applied }));
          onApplied();
          onClose();
        },
        (reason: unknown) => {
          setBusy(false);
          setFailure(failureOf(reason));
        },
      );
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{t("agents.profiles.applyTitle", { name })}</DialogTitle>
          <DialogDescription>
            {t("agents.profiles.applyDescription")}
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          <div className="min-w-0 space-y-4">
            {plan.agents.map((agent) => (
              <section key={agent.adapterId} className="min-w-0 space-y-2">
                <p className="flex items-center gap-2 text-[13.5px] font-medium">
                  <span className="font-mono">{agent.adapterId}</span>
                  <span className={`tag ${agent.changed ? "warn" : "good"}`}>
                    {agent.changed
                      ? t("agents.profiles.willSwitch")
                      : t("agents.profiles.same")}
                  </span>
                </p>
                {agent.plan ? <PlanFiles files={agent.plan.files} /> : null}
              </section>
            ))}
          </div>
        ) : failure ? null : (
          <div
            className="space-y-2"
            role="status"
            aria-label={t("agents.wire.computing")}
          >
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !changed.length} onClick={apply}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {changed.length
              ? t("agents.profiles.switch", { n: changed.length })
              : t("agents.profiles.noChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Wiring profiles: save the current choices, preview and apply one, delete. */
export function ProfilesPage() {
  const load = useCallback(
    async () => (await modelPlane().profiles.list()).items,
    [],
  );
  const [data, reload] = useLoaded(load);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const names = data.state === "ready" ? data.value.map((p) => p.name) : [];
  return (
    <div className="page-body">
      <div className="page-column max-w-[1080px]">
        <PageHeader
          title={t("common.nav.profiles")}
          lede={t("agents.profiles.lede")}
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
            onClick={reload}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" onClick={() => setSaving(true)}>
            <Plus />
            {t("agents.profiles.save")}
          </Button>
        </PageHeader>
        <div className="mt-6">
          {data.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label={t("common.loading")}
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : data.state === "error" ? (
            <LoadError message={data.message} retry={reload} />
          ) : data.value.length ? (
            <ul className="panel">
              {data.value.map((profile) => {
                const agents = Object.entries(profile.agents);
                return (
                  <li
                    key={profile.name}
                    className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-5 py-4 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1 basis-[260px]">
                      <p className="font-mono font-medium">{profile.name}</p>
                      <p className="text-[12px] text-subtle">
                        {tr("agents.profiles.summary", {
                          n: agents.length,
                          time: <LocalTime value={profile.updatedAt} />,
                        })}
                      </p>
                      <ul className="mt-2 space-y-0.5 text-[12.5px]">
                        {agents.map(([id, choice]) => (
                          <li key={id} className="flex min-w-0 gap-2">
                            <span className="w-[92px] shrink-0 font-mono text-muted-foreground">
                              {id}
                            </span>
                            <span className="min-w-0 font-mono break-all">
                              {choiceText(choice)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setApplying(profile.name)}
                      >
                        <Play />
                        {t("agents.profiles.previewApply")}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("agents.profiles.deleteLabel", {
                          name: profile.name,
                        })}
                        onClick={() => setRemoving(profile.name)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              icon={Layers}
              title={t("agents.profiles.empty")}
              action={
                <Button size="sm" onClick={() => setSaving(true)}>
                  <Plus />
                  {t("agents.profiles.save")}
                </Button>
              }
            >
              {t("agents.profiles.emptyBody")}
            </EmptyState>
          )}
        </div>
        {saving ? (
          <SaveDialog
            existing={names}
            onClose={() => setSaving(false)}
            onSaved={reload}
          />
        ) : null}
        {applying ? (
          <ApplyDialog
            name={applying}
            onClose={() => setApplying(null)}
            onApplied={reload}
          />
        ) : null}
        <ConfirmDialog
          open={removing !== null}
          title={t("agents.profiles.deleteTitle", { name: removing ?? "" })}
          description={t("agents.profiles.deleteDescription")}
          action={t("agents.profiles.delete")}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            if (!removing) return;
            await modelPlane().profiles.remove(removing);
            notify.success(t("agents.profiles.deleted", { name: removing }));
            reload();
          }}
        />
      </div>
    </div>
  );
}
