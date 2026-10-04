// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type {
  CatalogStatus,
  GatewayShareSettings,
  GatewayShareStatus,
  SystemInfo,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  failureOf,
  modelPlane,
  outboundProxyView,
  type Failure,
} from "@/lib/model-plane";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import type { Page } from "@/lib/router";
import { notify } from "@/lib/toast";
import { BackupPage } from "./backup-page";
import { LanguageSwitch } from "./language-switch";
import { GatewayFeaturesPage } from "./gateway-features-page";
import {
  Card,
  ConfirmDialog,
  ErrorCallout,
  LoadError,
  LocalTime,
  PageHeader,
  Row,
  useLoaded,
} from "./model-plane-ui";
import { PageTabs } from "./page-tabs";

const lists = (text: string) =>
  text
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * LAN sharing of the model gateway (`/api/v1/gateway/share`): its settings
 * and the listener's state. Turning it on asks first, as it opens the
 * gateway to other machines over plain HTTP.
 */
function LanSharing({
  status,
  onSaved,
}: {
  status: GatewayShareStatus;
  onSaved: (status: GatewayShareStatus) => void;
}) {
  const [enabled, setEnabled] = useState(status.lan.enabled);
  const [host, setHost] = useState(status.lan.host ?? "");
  const [port, setPort] = useState(
    status.lan.port === undefined ? "" : String(status.lan.port),
  );
  const [names, setNames] = useState(status.lan.names.join(", "));
  const [publicBaseUrl, setPublicBaseUrl] = useState(
    status.publicBaseUrl ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirm, setConfirm] = useState(false);
  const portValid = port === "" || /^\d{1,5}$/.test(port);
  const settings = (): GatewayShareSettings => ({
    lan: {
      enabled,
      ...(host.trim() ? { host: host.trim() } : {}),
      ...(port !== "" ? { port: Number(port) } : {}),
      names: lists(names),
    },
    ...(publicBaseUrl.trim() ? { publicBaseUrl: publicBaseUrl.trim() } : {}),
  });
  const save = async () => {
    setFailure(null);
    const saved = await modelPlane().gatewayShare.update(settings());
    notify.success(
      saved.lan.enabled
        ? t("settings.lan.enabled")
        : t("settings.lan.disabled"),
    );
    onSaved(saved);
  };
  const submit = () => {
    if (enabled && !status.lan.enabled) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    save().then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  return (
    <Card
      title={t("settings.lan.title")}
      lede={t("settings.lan.lede")}
      aside={
        <span className={`tag ${status.listening ? "good" : ""}`}>
          {status.listening
            ? `${t("settings.lan.listening")}${status.boundPort ? t("settings.lan.port", { port: String(status.boundPort) }) : ""}`
            : status.lan.enabled
              ? t("settings.lan.notListening")
              : t("settings.lan.off")}
        </span>
      }
    >
      <div className="callout warn">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{t("settings.lan.warning")}</span>
      </div>
      {status.error ? <p className="callout error">{status.error}</p> : null}
      <label className="flex items-center justify-between gap-3 text-[13.5px]">
        {t("settings.lan.enable")}
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("settings.lan.enable")}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field-label">
          {t("settings.lan.host")}
          <input
            className="field font-mono"
            placeholder={t("settings.lan.hostPlaceholder")}
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
          <span className="field-hint">{t("settings.lan.hostHint")}</span>
        </label>
        <label className="field-label">
          {t("settings.lan.portLabel")}
          <input
            className="field font-mono"
            inputMode="numeric"
            placeholder={t("settings.lan.portPlaceholder")}
            value={port}
            aria-invalid={!portValid}
            onChange={(event) => setPort(event.target.value.trim())}
          />
          <span className="field-hint">{t("settings.lan.portHint")}</span>
        </label>
        <label className="field-label">
          {t("settings.lan.names")}
          <input
            className="field font-mono"
            placeholder="hh.local, studio.lan"
            value={names}
            onChange={(event) => setNames(event.target.value)}
          />
          <span className="field-hint">{t("settings.lan.namesHint")}</span>
        </label>
        <label className="field-label">
          {t("settings.lan.publicBaseUrl")}
          <input
            className="field font-mono"
            placeholder="https://hh.example.lan"
            value={publicBaseUrl}
            onChange={(event) => setPublicBaseUrl(event.target.value)}
          />
          <span className="field-hint">
            {t("settings.lan.publicBaseUrlHint")}
          </span>
        </label>
      </div>
      {status.urls.length ? (
        <p className="text-[12.5px] text-muted-foreground">
          {tr("settings.lan.urls", {
            urls: status.urls.map((url) => (
              <code key={url} className="mr-1 font-mono">
                {url}
              </code>
            )),
          })}
        </p>
      ) : null}
      <ErrorCallout failure={failure} />
      <div className="flex justify-end">
        <Button
          disabled={busy || !portValid || (enabled && !host.trim())}
          onClick={submit}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t("settings.save")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title={t("settings.lan.enable")}
        description={t("settings.lan.confirmBody", {
          address: `${host.trim()}${port ? `:${port}` : ""}`,
        })}
        action={t("settings.lan.confirm")}
        onClose={() => setConfirm(false)}
        onConfirm={save}
      />
    </Card>
  );
}

/** The models.dev catalog in use and its refresh (`/api/v1/catalog`). */
function Catalog({
  status,
  onRefreshed,
}: {
  status: CatalogStatus;
  onRefreshed: (status: CatalogStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    modelPlane()
      .catalog.refresh()
      .then(
        (next) => {
          setBusy(false);
          notify.success(
            t(
              `settings.catalog.refreshed.${next.lastRefresh?.outcome ?? "unchanged"}`,
            ),
          );
          onRefreshed(next);
        },
        (reason: unknown) => {
          setBusy(false);
          notify.error(reason, t("settings.catalog.notRefreshed"));
        },
      );
  };
  const snapshot = status.snapshot;
  return (
    <Card
      title={t("settings.catalog.title")}
      lede={t("settings.catalog.lede")}
      aside={
        <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("settings.catalog.refresh")}
        </Button>
      }
    >
      <dl className="text-[13px]">
        <Row label={t("settings.catalog.inUse")}>
          {status.source === "bundled"
            ? t("settings.catalog.bundled")
            : t("settings.catalog.refreshedCopy")}{" "}
          ·{" "}
          {t("settings.catalog.counts", {
            providers: snapshot.providers,
            models: snapshot.models,
          })}
        </Row>
        <Row label={t("settings.catalog.retrieved")}>
          <LocalTime value={snapshot.retrievedAt} />
        </Row>
        <Row label={t("settings.catalog.commit")}>
          <span className="font-mono text-[12px]">
            {snapshot.commit?.slice(0, 12) ?? "—"}
          </span>
        </Row>
        <Row label={t("settings.catalog.auto")}>
          {status.autoRefresh.enabled
            ? t("settings.catalog.autoOn")
            : status.autoRefresh.disabledBy === "offline"
              ? t("settings.catalog.autoOffline")
              : t("settings.catalog.autoOff")}
          {status.nextRefreshAt ? (
            <span className="text-subtle">
              {tr("settings.catalog.next", {
                time: <LocalTime value={status.nextRefreshAt} />,
              })}
            </span>
          ) : null}
        </Row>
        <Row label={t("settings.catalog.last")}>
          {status.lastRefresh ? (
            <>
              <LocalTime value={status.lastRefresh.at} /> ·{" "}
              <span
                className={
                  status.lastRefresh.outcome === "failed" ? "text-danger" : ""
                }
              >
                {t(`settings.catalog.outcome.${status.lastRefresh.outcome}`)}
              </span>
              {status.lastRefresh.error ? (
                <span className="block text-[12px] text-danger">
                  {status.lastRefresh.error}
                </span>
              ) : null}
            </>
          ) : (
            t("settings.catalog.never")
          )}
        </Row>
        <Row label={t("settings.catalog.source")}>
          <span className="font-mono text-[12px] break-all">{status.url}</span>
        </Row>
      </dl>
    </Card>
  );
}

const tabs = () =>
  (["settings", "features", "backup"] as const).map((page) => ({
    page,
    label: t(`settings.tab.${page}`),
  }));

/**
 * Settings of the daemon: LAN sharing, the model catalog and what is
 * running; the gateway features, and backup, restore and sync, are tabs
 * of their own.
 */
export function SettingsPage({
  tab,
}: {
  tab: Extract<Page, "settings" | "features" | "backup">;
}) {
  const nav = (
    <PageTabs label={t("settings.title")} current={tab} tabs={tabs()} />
  );
  return tab === "backup" ? (
    <BackupPage tabs={nav} />
  ) : tab === "features" ? (
    <GatewayFeaturesPage tabs={nav} />
  ) : (
    <General tabs={nav} />
  );
}

/** The daemon's outbound proxy, read-only: it is a startup setting. */
function OutboundProxy({ network }: { network: SystemInfo["network"] }) {
  const view = outboundProxyView(network);
  return (
    <Card title={t("settings.proxy.title")} lede={t("settings.proxy.lede")}>
      <dl className="text-[13px]">
        <Row label={t("settings.proxy.proxy")}>
          <span
            className={
              view.address ? "font-mono text-[12px] break-all" : undefined
            }
          >
            {view.proxy}
          </span>
        </Row>
        <Row label={t("settings.proxy.source")}>{view.source}</Row>
        <Row label={t("settings.proxy.noProxy")}>
          <span className="font-mono text-[12px] break-all">
            {view.noProxy}
          </span>
        </Row>
      </dl>
      <p className="field-hint">{t("settings.proxy.always")}</p>
    </Card>
  );
}

function General({ tabs }: { tabs: React.ReactNode }) {
  const load = useCallback(async () => {
    const client = modelPlane();
    const [share, catalog, system] = await Promise.all([
      client.gatewayShare.status(),
      client.catalog.status(),
      client.system.info(),
    ]);
    return { share, catalog, system };
  }, []);
  const [data, reload] = useLoaded(load);
  const [override, setOverride] = useState<{
    share?: GatewayShareStatus;
    catalog?: CatalogStatus;
  }>({});
  return (
    <div className="page-body">
      <div className="page-column max-w-[880px]">
        {tabs}
        <PageHeader title={t("settings.title")} lede={t("settings.lede")}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
            onClick={() => {
              setOverride({});
              reload();
            }}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
          <Card title={t("common.language")} lede={t("common.languageLede")}>
            <LanguageSwitch />
          </Card>
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
          ) : (
            <>
              <LanSharing
                key={JSON.stringify(override.share ?? data.value.share)}
                status={override.share ?? data.value.share}
                onSaved={(share) =>
                  setOverride((current) => ({ ...current, share }))
                }
              />
              <Catalog
                status={override.catalog ?? data.value.catalog}
                onRefreshed={(catalog) =>
                  setOverride((current) => ({ ...current, catalog }))
                }
              />
              <OutboundProxy network={data.value.system.network} />
              <Card title={t("settings.about.title")}>
                <dl className="text-[13px]">
                  <Row label={t("settings.about.version")}>
                    {data.value.system.version}{" "}
                    <span className="font-mono text-[12px] text-subtle">
                      {data.value.system.commit.slice(0, 12)}
                    </span>
                  </Row>
                  <Row label={t("settings.about.process")}>
                    {tr("settings.about.started", {
                      pid: String(data.value.system.pid),
                      time: <LocalTime value={data.value.system.startedAt} />,
                    })}
                  </Row>
                  <Row label={t("settings.about.dataDir")}>
                    <span className="font-mono text-[12px] break-all">
                      {data.value.system.dataDir}
                    </span>
                  </Row>
                  <Row label={t("settings.about.secrets")}>
                    {t(`settings.about.${data.value.system.secretBackend}`)}
                  </Row>
                  {data.value.system.gateway ? (
                    <>
                      <Row label={t("settings.about.openai")}>
                        <span className="font-mono text-[12px]">
                          {data.value.system.gateway.openaiBaseUrl}
                        </span>
                      </Row>
                      <Row label={t("settings.about.anthropic")}>
                        <span className="font-mono text-[12px]">
                          {data.value.system.gateway.anthropicBaseUrl}
                        </span>
                      </Row>
                    </>
                  ) : null}
                </dl>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
