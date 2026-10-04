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
    ? ["ChatGPT 登录", ...(choice.model ? [choice.model] : [])]
    : [choice.model ?? "—"];
  for (const [tier, ref] of Object.entries(choice.tiers ?? {}))
    parts.push(`${tierLabel(tier)} ${ref}`);
  if (choice.effort) parts.push(`effort ${effortText[choice.effort]}`);
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
            `已保存 Profile ${profile.name}（${Object.keys(profile.agents).length} 个 Agent）`,
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
          <DialogTitle>保存当前接线</DialogTitle>
          <DialogDescription>
            保存每个已接线 Agent 的模型、档位、effort 与选项；隐藏的模型与 Key
            不属于 Profile。
          </DialogDescription>
        </DialogHeader>
        <label className="field-label">
          名称
          <input
            className="field font-mono"
            value={name}
            autoFocus
            placeholder="work"
            aria-invalid={name !== "" && !valid}
            onChange={(event) => setName(event.target.value.trim())}
          />
          <span className="field-hint">
            1–64 个字母、数字、点、下划线或连字符，以字母或数字开头。
          </span>
        </label>
        {replaces ? (
          <p className="callout warn">已有同名 Profile，保存会替换它。</p>
        ) : null}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !valid} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {replaces ? "替换" : "保存"}
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
          notify.success(`已应用 Profile ${name}：切换了 ${applied} 个 Agent`);
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
          <DialogTitle>应用 Profile {name}</DialogTitle>
          <DialogDescription>
            选择与当前接线不同的 Agent 会按下面的改动重新接线（新
            Key、写前备份）；不在 Profile 中的 Agent
            不受影响。遇到第一个失败即停止。
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          <div className="min-w-0 space-y-4">
            {plan.agents.map((agent) => (
              <section key={agent.adapterId} className="min-w-0 space-y-2">
                <p className="flex items-center gap-2 text-[13.5px] font-medium">
                  <span className="font-mono">{agent.adapterId}</span>
                  <span className={`tag ${agent.changed ? "warn" : "good"}`}>
                    {agent.changed ? "将切换" : "已经一致"}
                  </span>
                </p>
                {agent.plan ? <PlanFiles files={agent.plan.files} /> : null}
              </section>
            ))}
          </div>
        ) : failure ? null : (
          <div className="space-y-2" role="status" aria-label="正在计算改动">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !changed.length} onClick={apply}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {changed.length ? `切换 ${changed.length} 个 Agent` : "没有改动"}
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
          title="Profile"
          lede="一组 Agent 的模型选择。保存当前的接线，之后一键切换回来：例如工作与个人用不同的 provider。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={reload}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" onClick={() => setSaving(true)}>
            <Plus />
            保存当前接线
          </Button>
        </PageHeader>
        <div className="mt-6">
          {data.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label="正在读取"
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
                        {agents.length} 个 Agent · 更新于{" "}
                        <LocalTime value={profile.updatedAt} />
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
                        预览并应用
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除 ${profile.name}`}
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
              title="还没有 Profile"
              action={
                <Button size="sm" onClick={() => setSaving(true)}>
                  <Plus />
                  保存当前接线
                </Button>
              }
            >
              先在 Agent 页面接好线，再把这组选择保存为 Profile。
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
          title={`删除 Profile ${removing ?? ""}`}
          description="只删除保存的选择，不改动任何 Agent 的配置。"
          action="删除"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            if (!removing) return;
            await modelPlane().profiles.remove(removing);
            notify.success(`已删除 Profile ${removing}`);
            reload();
          }}
        />
      </div>
    </div>
  );
}
