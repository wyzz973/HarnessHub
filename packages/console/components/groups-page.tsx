// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Route, Trash2 } from "lucide-react";
import type {
  ProviderConfig,
  RouteGroup,
  RouteStrategy,
  Stickiness,
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
import {
  failureOf,
  modelPlane,
  modelRefChoices,
  type Failure,
} from "@/lib/model-plane";
import {
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  FieldError,
  OtherFieldErrors,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";

const strategies: { id: RouteStrategy; label: string }[] = [
  { id: "order", label: "按顺序（第一个可用的成员）" },
  { id: "rotate", label: "轮转" },
  { id: "least-used", label: "最少使用" },
  { id: "latency", label: "最低延迟" },
];
const stickinessOptions: { id: Stickiness; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "session", label: "会话内固定" },
  { id: "turn", label: "单轮内固定" },
  { id: "off", label: "不固定" },
];

function GroupDialog({
  group,
  providers,
  onClose,
  onSaved,
}: {
  /** Undefined to add a group. */
  group: RouteGroup | undefined;
  providers: ProviderConfig[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(group?.id ?? "");
  const [strategy, setStrategy] = useState<RouteStrategy>(
    group?.strategy ?? "order",
  );
  const [stickiness, setStickiness] = useState<Stickiness>(
    group?.stickiness ?? "auto",
  );
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const choices = modelRefChoices(providers);
  // Members of removed models stay visible so they can be unselected.
  const listed = new Set(choices.flatMap((choice) => choice.refs));
  const orphaned = members.filter((member) => !listed.has(member));
  const toggle = (ref: string, on: boolean) =>
    setMembers((current) =>
      on ? [...current, ref] : current.filter((item) => item !== ref),
    );
  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      if (group)
        await modelPlane().routeGroups.update(group.id, {
          strategy,
          stickiness,
          members,
        });
      else
        await modelPlane().routeGroups.create({
          id: id.trim(),
          strategy,
          stickiness,
          members,
        });
      onSaved();
    } catch (reason) {
      setFailure(failureOf(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {group ? `编辑 group/${group.id}` : "添加路由组"}
          </DialogTitle>
          <DialogDescription>
            调用 group/ID
            时，网关按策略在成员模型之间选择与故障转移；顺序即优先级。
          </DialogDescription>
        </DialogHeader>
        <label className="field-label">
          ID
          <input
            className="field font-mono text-[13px]"
            value={id}
            placeholder="fast"
            readOnly={!!group}
            autoFocus={!group}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setId(event.target.value)}
          />
          <FieldError failure={failure} pointer="/id" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            策略
            <select
              className="field"
              value={strategy}
              onChange={(event) =>
                setStrategy(event.target.value as RouteStrategy)
              }
            >
              {strategies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            粘性
            <select
              className="field"
              value={stickiness}
              onChange={(event) =>
                setStickiness(event.target.value as Stickiness)
              }
            >
              {stickinessOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset>
          <legend className="field-label mb-1">
            成员（按选择顺序：{members.length ? members.join(" → ") : "未选择"}
            ）
          </legend>
          <div className="max-h-[36vh] space-y-2 overflow-y-auto rounded-xl border p-2">
            {choices.map((choice) => (
              <div key={choice.provider}>
                <p className="px-2 pt-1 text-[12px] text-subtle">
                  {choice.provider}
                </p>
                {choice.refs.length ? (
                  choice.refs.map((ref) => (
                    <Checkbox
                      key={ref}
                      checked={members.includes(ref)}
                      onChange={(on) => toggle(ref, on)}
                    >
                      <span className="font-mono text-[12.5px]">{ref}</span>
                    </Checkbox>
                  ))
                ) : (
                  <p className="px-2 py-1 text-[12.5px] text-muted-foreground">
                    这个 provider 还没有列出模型。
                  </p>
                )}
              </div>
            ))}
            {orphaned.map((ref) => (
              <Checkbox key={ref} checked onChange={(on) => toggle(ref, on)}>
                <span className="font-mono text-[12.5px]">{ref}</span>
                <span className="tag warn ml-2">模型不在列表中</span>
              </Checkbox>
            ))}
            {!choices.length ? (
              <p className="px-2 py-3 text-[13px] text-muted-foreground">
                先添加 provider 和它的模型。
              </p>
            ) : null}
          </div>
          <FieldError failure={failure} pointer="/members" />
        </fieldset>
        <ErrorCallout failure={failure} />
        <OtherFieldErrors failure={failure} shown={["/id", "/members"]} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !members.length || (!group && !id.trim())}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Route groups (`/api/v1/route-groups`). */
export function GroupsPage() {
  const load = useCallback(async () => {
    const client = modelPlane();
    const [groups, providers] = await Promise.all([
      client.routeGroups.list(),
      client.providers.list(),
    ]);
    return { groups: groups.items, providers: providers.items };
  }, []);
  const [data, reload] = useLoaded(load);
  const [editing, setEditing] = useState<{
    group: RouteGroup | undefined;
  } | null>(null);
  const [removing, setRemoving] = useState<RouteGroup | null>(null);
  const strategyName = (id: RouteStrategy) =>
    strategies.find((item) => item.id === id)?.label ?? id;
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        <PageHeader
          title="路由组"
          lede="把多个模型组成 group/ID，按策略路由并在失败时切换。"
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
            disabled={data.state !== "ready"}
            onClick={() => setEditing({ group: undefined })}
          >
            <Plus />
            添加路由组
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
          ) : data.value.groups.length ? (
            <div className="panel overflow-x-auto">
              <table className="data-table min-w-[640px]">
                <thead>
                  <tr>
                    <th>路由组</th>
                    <th>策略</th>
                    <th>粘性</th>
                    <th>成员</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.value.groups.map((group) => (
                    <tr key={group.id}>
                      <td className="font-mono text-[12.5px] font-medium">
                        group/{group.id}
                      </td>
                      <td className="text-[12.5px]">
                        {strategyName(group.strategy)}
                      </td>
                      <td className="text-[12.5px]">
                        {stickinessOptions.find(
                          (item) => item.id === group.stickiness,
                        )?.label ?? group.stickiness}
                      </td>
                      <td>
                        <ol className="space-y-0.5 font-mono text-[12px]">
                          {group.members.map((member) => (
                            <li key={member}>{member}</li>
                          ))}
                        </ol>
                      </td>
                      <td className="w-[96px] text-right">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`编辑 group/${group.id}`}
                          onClick={() => setEditing({ group })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`删除 group/${group.id}`}
                          onClick={() => setRemoving(group)}
                        >
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel empty-state py-16">
              <span className="mb-2 grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Route className="size-5" strokeWidth={1.7} />
              </span>
              <p className="text-[14px] font-medium text-foreground">
                还没有路由组
              </p>
              <p>
                例如把两个 provider 的同类模型组成一组，一个失败时自动切换。
              </p>
            </div>
          )}
        </div>
        {editing && data.state === "ready" ? (
          <GroupDialog
            key={editing.group?.id ?? "new"}
            group={editing.group}
            providers={data.value.providers}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
        ) : null}
        <ConfirmDialog
          open={removing !== null}
          title={`删除 group/${removing?.id ?? ""}`}
          description="仍被 Gateway Key 允许使用时不能删除。"
          action="删除"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            if (removing) await modelPlane().routeGroups.remove(removing.id);
            reload();
          }}
        />
      </div>
    </div>
  );
}
