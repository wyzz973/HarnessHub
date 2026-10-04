// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ListOrdered,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Trash2,
  X,
} from "lucide-react";
import type {
  ProviderConfig,
  ReasoningEffort,
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
  memberEfforts,
  memberRow,
  memberRowText,
  moved,
  type MemberRow,
} from "@/lib/routing";
import {
  ConfirmDialog,
  ErrorCallout,
  FieldError,
  OtherFieldErrors,
  PageHeader,
  useLoaded,
  EmptyState,
  LoadError,
} from "./model-plane-ui";
import { RulesDialog } from "./rules-editor";

const strategies: { id: RouteStrategy; label: string }[] = [
  { id: "order", label: "按顺序（第一个可用的成员）" },
  { id: "rotate", label: "轮转" },
  { id: "least-used", label: "最少使用" },
  { id: "latency", label: "最低延迟" },
  { id: "smart", label: "按额度读数（smart）" },
  { id: "pace", label: "按额度节奏（pace）" },
];
const stickinessOptions: { id: Stickiness; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "session", label: "会话内固定" },
  { id: "turn", label: "单轮内固定" },
  { id: "off", label: "不固定" },
];

/** A member's effort and fast mode as tags beside its model. */
function MemberTags({ row }: { row: MemberRow }) {
  return (
    <>
      {row.effort ? (
        <span className="tag info ml-1.5" title="固定推理强度">
          {row.effort}
        </span>
      ) : null}
      {row.fast ? (
        <span className="tag brand ml-1.5" title="以厂商的快速模式发送">
          fast
        </span>
      ) : null}
    </>
  );
}

/**
 * The members of a group in order, each a model (fixed at an effort or
 * following the request, sent fast or not) or another group.
 */
function MembersEditor({
  rows,
  onChange,
  providers,
  groups,
  self,
  failure,
}: {
  rows: MemberRow[];
  onChange: (rows: MemberRow[]) => void;
  providers: ProviderConfig[];
  groups: RouteGroup[];
  /** The group being edited, which cannot be its own member. */
  self: string | undefined;
  failure: Failure | null;
}) {
  const [adding, setAdding] = useState("");
  const choices = modelRefChoices(providers);
  const update = (index: number, patch: Partial<MemberRow>) =>
    onChange(
      rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  const add = () => {
    const ref = adding.trim();
    if (!ref) return;
    onChange([
      ...rows,
      ref.startsWith("group/")
        ? { kind: "group", ref, fast: false }
        : { kind: "model", ref, fast: false },
    ]);
    setAdding("");
  };
  return (
    <fieldset>
      <legend className="field-label mb-1">成员（按顺序，上面的优先）</legend>
      {rows.length ? (
        <ol className="space-y-1.5 rounded-xl border p-2">
          {rows.map((row, index) => (
            <li
              key={`${row.ref}-${index}`}
              className="flex flex-wrap items-center gap-2 rounded-[10px] px-1 py-1 hover:bg-accent"
            >
              <span className="w-5 text-right text-[12px] text-subtle">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 font-mono text-[12.5px] break-all">
                {row.ref}
                {row.kind === "group" ? (
                  <span className="tag ml-1.5">组</span>
                ) : null}
              </span>
              {row.kind === "model" ? (
                <>
                  <select
                    className="field mt-0 h-8 w-[118px] py-0 text-[12.5px]"
                    aria-label={`${row.ref} 的推理强度`}
                    value={row.effort ?? ""}
                    onChange={(event) =>
                      update(
                        index,
                        event.target.value
                          ? { effort: event.target.value as ReasoningEffort }
                          : { effort: undefined },
                      )
                    }
                  >
                    <option value="">跟随请求</option>
                    {memberEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        固定 {effort}
                      </option>
                    ))}
                  </select>
                  <label
                    className="flex items-center gap-1 text-[12.5px]"
                    title="以厂商的快速模式发送（api.openai.com 的 GPT 与 o 系列、ChatGPT 账号的 GPT、有快速模式的 Claude Opus）"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-(--primary)"
                      checked={row.fast}
                      onChange={(event) =>
                        update(index, { fast: event.target.checked })
                      }
                    />
                    fast
                  </label>
                </>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`上移 ${row.ref}`}
                disabled={index === 0}
                onClick={() => onChange(moved(rows, index, index - 1))}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`下移 ${row.ref}`}
                disabled={index === rows.length - 1}
                onClick={() => onChange(moved(rows, index, index + 1))}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`移除 ${row.ref}`}
                onClick={() => onChange(rows.filter((_, at) => at !== index))}
              >
                <X />
              </Button>
              <span className="w-full pl-7">
                <FieldError failure={failure} pointer={`/members/${index}`} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border px-3 py-3 text-[13px] text-muted-foreground">
          还没有成员。
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <select
          className="field mt-0"
          aria-label="要添加的成员"
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
        >
          <option value="">选择模型或路由组…</option>
          {choices.map((choice) => (
            <optgroup key={choice.provider} label={choice.provider}>
              {choice.refs.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </optgroup>
          ))}
          {groups.some((group) => group.id !== self) ? (
            <optgroup label="路由组（组中的组，最多 8 层）">
              {groups
                .filter((group) => group.id !== self)
                .map((group) => (
                  <option key={group.id} value={`group/${group.id}`}>
                    group/{group.id}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>
        <Button variant="outline" disabled={!adding} onClick={add}>
          <Plus />
          添加
        </Button>
      </div>
      <FieldError failure={failure} pointer="/members" />
    </fieldset>
  );
}

function GroupDialog({
  group,
  groups,
  providers,
  onClose,
  onSaved,
}: {
  /** Undefined to add a group. */
  group: RouteGroup | undefined;
  groups: RouteGroup[];
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
  const [rows, setRows] = useState<MemberRow[]>(
    (group?.members ?? []).map((member) => memberRow(member, providers)),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  async function save() {
    setBusy(true);
    setFailure(null);
    const members = rows.map(memberRowText);
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
  const memberPointers = rows.map((_, index) => `/members/${index}`);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {group ? `编辑 group/${group.id}` : "添加路由组"}
          </DialogTitle>
          <DialogDescription>
            调用 group/ID
            时，网关按策略在成员之间选择与故障转移。成员可以固定推理强度、以快速模式发送，或是另一个路由组。
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
        <MembersEditor
          rows={rows}
          onChange={setRows}
          providers={providers}
          groups={groups}
          self={group?.id}
          failure={failure}
        />
        {group?.rules?.length ? (
          <p className="field-hint">
            这个组有 {group.rules.length}{" "}
            条规则；移除规则用到的成员前，先在“规则”中删去或修改那些规则。
          </p>
        ) : null}
        <ErrorCallout failure={failure} />
        <OtherFieldErrors
          failure={failure}
          shown={["/id", "/members", ...memberPointers]}
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !rows.length || (!group && !id.trim())}
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
export function GroupsPage({ tabs }: { tabs?: React.ReactNode }) {
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
  const [ruling, setRuling] = useState<RouteGroup | null>(null);
  const [removing, setRemoving] = useState<RouteGroup | null>(null);
  const strategyName = (id: RouteStrategy) =>
    strategies.find((item) => item.id === id)?.label ?? id;
  return (
    <div className="page-body">
      <div className="page-column max-w-[1100px]">
        {tabs}
        <PageHeader
          title="路由组"
          lede="把多个模型组成 group/ID，按策略路由并在失败时切换；规则按请求的长度、图片、推理强度、Agent、意图、压缩与时段把某个成员放到最前。"
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
            <LoadError message={data.message} retry={reload} />
          ) : data.value.groups.length ? (
            <div className="panel overflow-x-auto">
              <table className="data-table min-w-[760px]">
                <thead>
                  <tr>
                    <th>路由组</th>
                    <th>策略</th>
                    <th>粘性</th>
                    <th>成员</th>
                    <th>规则</th>
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
                          {group.members.map((member) => {
                            const row = memberRow(member, data.value.providers);
                            return (
                              <li key={member}>
                                {row.ref}
                                <MemberTags row={row} />
                              </li>
                            );
                          })}
                        </ol>
                      </td>
                      <td className="text-[12.5px]">
                        {group.rules?.length ? (
                          <span className="tag info">
                            {group.rules.length} 条
                          </span>
                        ) : (
                          <span className="text-subtle">无</span>
                        )}
                        {group.classifier ? (
                          <p
                            className="mt-1 font-mono text-[11.5px] text-muted-foreground"
                            title="分类器"
                          >
                            分类器 {group.classifier}
                          </p>
                        ) : null}
                        {group.effort === "auto" ? (
                          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                            推理强度：自动
                          </p>
                        ) : null}
                      </td>
                      <td className="w-[150px] text-right whitespace-nowrap">
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`group/${group.id} 的规则`}
                          onClick={() => setRuling(group)}
                        >
                          <ListOrdered />
                          规则
                        </Button>
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
            <EmptyState icon={Route} title="还没有路由组">
              例如把两个 provider 的同类模型组成一组，一个失败时自动切换。
            </EmptyState>
          )}
        </div>
        {editing && data.state === "ready" ? (
          <GroupDialog
            key={editing.group?.id ?? "new"}
            group={editing.group}
            groups={data.value.groups}
            providers={data.value.providers}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
        ) : null}
        {ruling && data.state === "ready" ? (
          <RulesDialog
            key={ruling.id}
            group={ruling}
            groups={data.value.groups}
            providers={data.value.providers}
            onClose={() => setRuling(null)}
            onSaved={() => {
              setRuling(null);
              reload();
            }}
          />
        ) : null}
        <ConfirmDialog
          open={removing !== null}
          title={`删除 group/${removing?.id ?? ""}`}
          description="仍被 Gateway Key 允许使用、或被其他路由组用作成员或分类器时不能删除。"
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
