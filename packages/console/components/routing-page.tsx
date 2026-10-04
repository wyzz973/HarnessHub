// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import { Eye, EyeOff, RefreshCw, Shuffle } from "lucide-react";
import type { AutoGroup } from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { modelPlane } from "@/lib/model-plane";
import type { Page } from "@/lib/router";
import { notify } from "@/lib/toast";
import { GroupsPage } from "./groups-page";
import { KeysPage } from "./keys-page";
import {
  EmptyState,
  LoadError,
  LocalTime,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";
import { PageTabs } from "./page-tabs";
import { DecisionsPage } from "./route-decisions";
import { CredentialStatesPage } from "./routing-state";

/**
 * Groups of models that two or more providers serve under one name
 * (`group/auto-<name>`): derived from the providers, never edited, only
 * hidden (the gateway stops listing and routing it) and restored.
 */
function AutoGroupsPage({ tabs }: { tabs: React.ReactNode }) {
  const load = useCallback(
    async () => (await modelPlane().autoGroups.list()).items,
    [],
  );
  const [data, reload] = useLoaded(load);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = (group: AutoGroup) => {
    setBusy(group.id);
    const client = modelPlane();
    (group.hidden
      ? client.autoGroups.restore(group.id)
      : client.autoGroups.hide(group.id)
    ).then(
      () => {
        setBusy(null);
        notify.success(
          group.hidden
            ? `已恢复 group/${group.id}`
            : `已隐藏 group/${group.id}，网关不再列出和路由它`,
        );
        reload();
      },
      (reason: unknown) => {
        setBusy(null);
        notify.error(reason, group.hidden ? "没有恢复" : "没有隐藏");
      },
    );
  };
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        {tabs}
        <PageHeader
          title="自动路由组"
          lede="两个以上 provider 以同一个名字提供的模型，自动组成 group/auto-<名字>，按顺序路由并在失败时切换。不需要时可以隐藏。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={reload}
          >
            <RefreshCw />
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
            <div className="panel overflow-x-auto">
              <table className="data-table min-w-[640px]">
                <thead>
                  <tr>
                    <th>路由组</th>
                    <th>成员（按添加顺序）</th>
                    <th>出现于</th>
                    <th>状态</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.value.map((group) => (
                    <tr key={group.id}>
                      <td className="font-mono text-[12.5px] font-medium">
                        group/{group.id}
                      </td>
                      <td className="font-mono text-[12px]">
                        {group.members.map((member) => (
                          <span key={member} className="block">
                            {member}
                          </span>
                        ))}
                      </td>
                      <td className="text-[12.5px] text-muted-foreground">
                        <LocalTime value={group.createdAt} />
                      </td>
                      <td>
                        <span className={`tag ${group.hidden ? "" : "good"}`}>
                          {group.hidden ? "已隐藏" : "使用中"}
                        </span>
                      </td>
                      <td className="text-right">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy === group.id}
                          onClick={() => toggle(group)}
                        >
                          {group.hidden ? <Eye /> : <EyeOff />}
                          {group.hidden ? "恢复" : "隐藏"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={Shuffle} title="还没有自动路由组">
              两个 provider 提供同名模型（例如都列出
              deepseek-chat）时，这里自动出现对应的组。
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

const tabs = [
  { page: "routing", label: "路由组" },
  { page: "auto-groups", label: "自动路由组" },
  { page: "keys", label: "Gateway Key" },
  { page: "credential-state", label: "凭据状态" },
  { page: "decisions", label: "路由决定" },
] as const;

/** Route groups, automatic groups, Gateway Keys, the credentials' routing state and the route decisions, one tab each. */
export function RoutingPage({
  tab,
}: {
  tab: Extract<
    Page,
    "routing" | "auto-groups" | "keys" | "credential-state" | "decisions"
  >;
}) {
  const nav = <PageTabs label="路由与 Key" current={tab} tabs={tabs} />;
  return tab === "routing" ? (
    <GroupsPage tabs={nav} />
  ) : tab === "auto-groups" ? (
    <AutoGroupsPage tabs={nav} />
  ) : tab === "credential-state" ? (
    <CredentialStatesPage tabs={nav} />
  ) : tab === "decisions" ? (
    <DecisionsPage tabs={nav} />
  ) : (
    <KeysPage tabs={nav} />
  );
}
