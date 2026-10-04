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
import { isMessageKey, t, translate } from "@/lib/i18n";
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

const strategies: readonly RouteStrategy[] = [
  "order",
  "rotate",
  "least-used",
  "latency",
  "smart",
  "pace",
];
const stickinessOptions: readonly Stickiness[] = [
  "auto",
  "session",
  "turn",
  "off",
];
/** A strategy in words; one the console does not know shows as the daemon names it. */
function strategyName(strategy: string): string {
  const key = `routing.strategy.${strategy}`;
  return isMessageKey(key) ? translate(key) : strategy;
}
/** Stickiness in words; an unknown value shows as the daemon names it. */
function stickinessName(stickiness: string): string {
  const key = `routing.stickiness.${stickiness}`;
  return isMessageKey(key) ? translate(key) : stickiness;
}

/** A member's effort and fast mode as tags beside its model. */
function MemberTags({ row }: { row: MemberRow }) {
  return (
    <>
      {row.effort ? (
        <span
          className="tag info ml-1.5"
          title={t("routing.member.effortTitle")}
        >
          {row.effort}
        </span>
      ) : null}
      {row.fast ? (
        <span
          className="tag brand ml-1.5"
          title={t("routing.member.fastTitle")}
        >
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
      <legend className="field-label mb-1">{t("routing.member.legend")}</legend>
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
                  <span className="tag ml-1.5">
                    {t("routing.member.groupTag")}
                  </span>
                ) : null}
              </span>
              {row.kind === "model" ? (
                <>
                  <select
                    className="field mt-0 h-8 w-[118px] py-0 text-[12.5px]"
                    aria-label={t("routing.member.effortOf", { ref: row.ref })}
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
                    <option value="">
                      {t("routing.member.followRequest")}
                    </option>
                    {memberEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {t("routing.member.fixed", { effort })}
                      </option>
                    ))}
                  </select>
                  <label
                    className="flex items-center gap-1 text-[12.5px]"
                    title={t("routing.member.fastHint")}
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
                aria-label={t("routing.member.up", { ref: row.ref })}
                disabled={index === 0}
                onClick={() => onChange(moved(rows, index, index - 1))}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("routing.member.down", { ref: row.ref })}
                disabled={index === rows.length - 1}
                onClick={() => onChange(moved(rows, index, index + 1))}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("routing.member.remove", { ref: row.ref })}
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
          {t("routing.member.none")}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <select
          className="field mt-0"
          aria-label={t("routing.member.toAdd")}
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
        >
          <option value="">{t("routing.member.choose")}</option>
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
            <optgroup label={t("routing.member.nestedGroups")}>
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
          {t("routing.member.add")}
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
            {group
              ? t("routing.groupDialog.editTitle", {
                  group: `group/${group.id}`,
                })
              : t("routing.groupDialog.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("routing.groupDialog.lede")}</DialogDescription>
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
            {t("routing.groupDialog.strategy")}
            <select
              className="field"
              value={strategy}
              onChange={(event) =>
                setStrategy(event.target.value as RouteStrategy)
              }
            >
              {strategies.map((item) => (
                <option key={item} value={item}>
                  {strategyName(item)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t("routing.groupDialog.stickiness")}
            <select
              className="field"
              value={stickiness}
              onChange={(event) =>
                setStickiness(event.target.value as Stickiness)
              }
            >
              {stickinessOptions.map((item) => (
                <option key={item} value={item}>
                  {stickinessName(item)}
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
            {t("routing.groupDialog.rulesHint", { n: group.rules.length })}
          </p>
        ) : null}
        <ErrorCallout failure={failure} />
        <OtherFieldErrors
          failure={failure}
          shown={["/id", "/members", ...memberPointers]}
        />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || !rows.length || (!group && !id.trim())}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("routing.save")}
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
  return (
    <div className="page-body">
      <div className="page-column max-w-[1100px]">
        {tabs}
        <PageHeader
          title={t("routing.groups.title")}
          lede={t("routing.groups.lede")}
        >
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
            disabled={data.state !== "ready"}
            onClick={() => setEditing({ group: undefined })}
          >
            <Plus />
            {t("routing.groups.add")}
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
                    <th>{t("routing.group")}</th>
                    <th>{t("routing.groupDialog.strategy")}</th>
                    <th>{t("routing.groupDialog.stickiness")}</th>
                    <th>{t("routing.groups.members")}</th>
                    <th>{t("routing.groups.rules")}</th>
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
                        {stickinessName(group.stickiness)}
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
                            {t("routing.groups.ruleCount", {
                              n: group.rules.length,
                            })}
                          </span>
                        ) : (
                          <span className="text-subtle">
                            {t("routing.none")}
                          </span>
                        )}
                        {group.classifier ? (
                          <p
                            className="mt-1 font-mono text-[11.5px] text-muted-foreground"
                            title={t("routing.groups.classifier")}
                          >
                            {t("routing.groups.classifierIs", {
                              model: group.classifier,
                            })}
                          </p>
                        ) : null}
                        {group.effort === "auto" ? (
                          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                            {t("routing.groups.effortAuto")}
                          </p>
                        ) : null}
                      </td>
                      <td className="w-[150px] text-right whitespace-nowrap">
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={t("routing.groups.rulesOf", {
                            group: `group/${group.id}`,
                          })}
                          onClick={() => setRuling(group)}
                        >
                          <ListOrdered />
                          {t("routing.groups.rules")}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("routing.groups.edit", {
                            group: `group/${group.id}`,
                          })}
                          onClick={() => setEditing({ group })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("routing.groups.deleteGroup", {
                            group: `group/${group.id}`,
                          })}
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
            <EmptyState icon={Route} title={t("routing.groups.empty")}>
              {t("routing.groups.emptyHint")}
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
          title={t("routing.groups.deleteGroup", {
            group: `group/${removing?.id ?? ""}`,
          })}
          description={t("routing.groups.deleteHint")}
          action={t("routing.delete")}
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
