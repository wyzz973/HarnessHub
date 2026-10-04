// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import { Eye, EyeOff, RefreshCw, Shuffle } from "lucide-react";
import type { AutoGroup } from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";
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
            ? t("routing.auto.restored", { group: `group/${group.id}` })
            : t("routing.auto.hidden", { group: `group/${group.id}` }),
        );
        reload();
      },
      (reason: unknown) => {
        setBusy(null);
        notify.error(
          reason,
          group.hidden
            ? t("routing.auto.notRestored")
            : t("routing.auto.notHidden"),
        );
      },
    );
  };
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        {tabs}
        <PageHeader
          title={t("routing.auto.title")}
          lede={t("routing.auto.lede")}
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
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
              aria-label={t("common.loading")}
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
                    <th>{t("routing.group")}</th>
                    <th>{t("routing.auto.members")}</th>
                    <th>{t("routing.auto.since")}</th>
                    <th>{t("routing.status")}</th>
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
                          {group.hidden
                            ? t("routing.auto.hiddenTag")
                            : t("routing.auto.active")}
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
                          {group.hidden
                            ? t("routing.auto.restore")
                            : t("routing.auto.hide")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={Shuffle} title={t("routing.auto.empty")}>
              {t("routing.auto.emptyHint")}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

const tabs = () =>
  [
    { page: "routing", label: t("routing.tab.groups") },
    { page: "auto-groups", label: t("routing.tab.auto") },
    { page: "keys", label: t("routing.tab.keys") },
    { page: "credential-state", label: t("routing.tab.credentials") },
    { page: "decisions", label: t("routing.tab.decisions") },
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
  const nav = (
    <PageTabs label={t("common.nav.routing")} current={tab} tabs={tabs()} />
  );
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
