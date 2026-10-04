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
          notify.success(
            `${agent.name} 已接线，重启正在运行的 ${agent.name} 后生效`,
          );
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
            确认后写入 {agent.name} 自己的配置文件；写入前先备份，之后可以还原。
            每次接线都签发一把新 Key，旧 Key 随即失效。
            {modelOptional(input.options)
              ? `${agent.name} 保留自己的 ChatGPT 登录，Key 写在它的网关基址中。`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          plan.changed ? (
            <PlanFiles files={plan.files} />
          ) : (
            <p className="callout neutral">
              当前接线已经是这样，没有要写入的改动。
            </p>
          )
        ) : failure ? null : (
          <div className="space-y-2" role="status" aria-label="正在计算改动">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !plan?.changed} onClick={apply}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            确认写入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
