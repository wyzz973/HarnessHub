// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  Agent,
  AgentWiringInput,
  AgentWiringPlan,
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
import { modelOptional } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { ErrorCallout } from "./model-plane-ui";
import { PlanFiles } from "./plan-files";

/**
 * Preview what wiring `agent` with `input` would write, then write exactly
 * that on confirmation (the plan goes back as `expect`; a file changed in
 * between is refused with 409 and nothing is written). Nothing happens
 * without the confirmation, which `hh wire` also asks for.
 */
export function WirePlanDialog({
  agent,
  input,
  title,
  onClose,
  onWired,
}: {
  agent: Agent;
  input: AgentWiringInput;
  title: string;
  onClose: () => void;
  onWired: (agent: Agent) => void;
}) {
  const [plan, setPlan] = useState<AgentWiringPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    let current = true;
    modelPlane()
      .agents.plan(agent.id, input)
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
  }, [agent.id, input]);
  const apply = () => {
    if (!plan) return;
    setBusy(true);
    setFailure(null);
    modelPlane()
      .agents.wire(agent.id, { ...input, expect: plan })
      .then(
        (wired) => {
          setBusy(false);
          notify.success(t("agents.wire.done", { name: agent.name }));
          onWired(wired);
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("agents.wire.description", { name: agent.name })}{" "}
            {modelOptional(input.options)
              ? t("agents.wire.chatgpt", { name: agent.name })
              : ""}
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          plan.changed ? (
            <PlanFiles files={plan.files} />
          ) : (
            <p className="callout neutral">{t("agents.wire.unchanged")}</p>
          )
        ) : failure ? null : (
          <div
            className="space-y-2"
            role="status"
            aria-label={t("agents.wire.computing")}
          >
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !plan?.changed} onClick={apply}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("agents.wire.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
