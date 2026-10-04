// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type {
  CatalogStatus,
  GatewayShareSettings,
  GatewayShareStatus,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import type { Page } from "@/lib/router";
import { notify } from "@/lib/toast";
import { BackupPage } from "./backup-page";
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
    notify.success(saved.lan.enabled ? "局域网共享已开启" : "局域网共享已关闭");
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
      title="局域网共享"
      lede="让同一网络中的其他电脑或 HarnessHub 使用本机的模型网关。只开放模型协议；管理接口与控制台仍只在本机。"
      aside={
        <span className={`tag ${status.listening ? "good" : ""}`}>
          {status.listening
            ? `监听中${status.boundPort ? ` · 端口 ${status.boundPort}` : ""}`
            : status.lan.enabled
              ? "未在监听"
              : "已关闭"}
        </span>
      }
    >
      <div className="callout warn">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          局域网上的请求是明文 HTTP：只在可信网络中开启，或放在 TLS
          反向代理之后。只有创建时勾选了局域网、并设置了有效期的 client Key
          能在局域网上使用。
        </span>
      </div>
      {status.error ? <p className="callout error">{status.error}</p> : null}
      <label className="flex items-center justify-between gap-3 text-[13.5px]">
        开启局域网共享
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="开启局域网共享"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field-label">
          监听地址
          <input
            className="field font-mono"
            placeholder="192.168.1.20 或 0.0.0.0"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
          <span className="field-hint">
            本机的一个 IP 地址；0.0.0.0 监听全部地址。开启时必填。
          </span>
        </label>
        <label className="field-label">
          端口
          <input
            className="field font-mono"
            inputMode="numeric"
            placeholder="与守护进程相同"
            value={port}
            aria-invalid={!portValid}
            onChange={(event) => setPort(event.target.value.trim())}
          />
          <span className="field-hint">留空则使用守护进程的端口。</span>
        </label>
        <label className="field-label">
          主机名
          <input
            className="field font-mono"
            placeholder="hh.local, studio.lan"
            value={names}
            onChange={(event) => setNames(event.target.value)}
          />
          <span className="field-hint">
            其他电脑访问时使用的名字，以逗号分隔；只接受列出的名字与 IP。
          </span>
        </label>
        <label className="field-label">
          公开地址（可选）
          <input
            className="field font-mono"
            placeholder="https://hh.example.lan"
            value={publicBaseUrl}
            onChange={(event) => setPublicBaseUrl(event.target.value)}
          />
          <span className="field-hint">
            位于反向代理之后时，客户端使用的地址。
          </span>
        </label>
      </div>
      {status.urls.length ? (
        <p className="text-[12.5px] text-muted-foreground">
          其他电脑使用{" "}
          {status.urls.map((url) => (
            <code key={url} className="mr-1 font-mono">
              {url}
            </code>
          ))}
          ，另一台 HarnessHub 用 harnesshub-remote 预设添加它。
        </p>
      ) : null}
      <ErrorCallout failure={failure} />
      <div className="flex justify-end">
        <Button
          disabled={busy || !portValid || (enabled && !host.trim())}
          onClick={submit}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          保存
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="开启局域网共享"
        description={`本机的模型网关将在 ${host.trim()}${port ? `:${port}` : ""} 上对局域网开放，请求是明文 HTTP。只有勾选了局域网的 client Key 能使用它。`}
        action="开启"
        onClose={() => setConfirm(false)}
        onConfirm={save}
      />
    </Card>
  );
}

const refreshOutcome: Record<string, string> = {
  updated: "已更新",
  unchanged: "没有变化",
  failed: "失败",
};

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
            `模型目录${refreshOutcome[next.lastRefresh?.outcome ?? "unchanged"] ?? ""}`,
          );
          onRefreshed(next);
        },
        (reason: unknown) => {
          setBusy(false);
          notify.error(reason, "目录没有刷新");
        },
      );
  };
  const snapshot = status.snapshot;
  return (
    <Card
      title="模型目录"
      lede="models.dev 的模型窗口、输出上限与价格，补齐 provider 没有给出的元数据。"
      aside={
        <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          立即刷新
        </Button>
      }
    >
      <dl className="text-[13px]">
        <Row label="使用中">
          {status.source === "bundled" ? "内置快照" : "刷新后的副本"} ·{" "}
          {snapshot.providers} 个 provider、{snapshot.models} 个模型
        </Row>
        <Row label="取得时间">
          <LocalTime value={snapshot.retrievedAt} />
        </Row>
        <Row label="上游提交">
          <span className="font-mono text-[12px]">
            {snapshot.commit?.slice(0, 12) ?? "—"}
          </span>
        </Row>
        <Row label="后台刷新">
          {status.autoRefresh.enabled
            ? "开启"
            : status.autoRefresh.disabledBy === "offline"
              ? "关闭（离线模式 HH_OFFLINE）"
              : "关闭（设置）"}
          {status.nextRefreshAt ? (
            <span className="text-subtle">
              {" "}
              · 下次 <LocalTime value={status.nextRefreshAt} />
            </span>
          ) : null}
        </Row>
        <Row label="上次刷新">
          {status.lastRefresh ? (
            <>
              <LocalTime value={status.lastRefresh.at} /> ·{" "}
              <span
                className={
                  status.lastRefresh.outcome === "failed" ? "text-danger" : ""
                }
              >
                {refreshOutcome[status.lastRefresh.outcome]}
              </span>
              {status.lastRefresh.error ? (
                <span className="block text-[12px] text-danger">
                  {status.lastRefresh.error}
                </span>
              ) : null}
            </>
          ) : (
            "还没有刷新过"
          )}
        </Row>
        <Row label="来源">
          <span className="font-mono text-[12px] break-all">{status.url}</span>
        </Row>
      </dl>
    </Card>
  );
}

/** Gateway features that are coming: shown so their place is known, not settable yet. */
function GatewayFeatures() {
  const features = [
    { name: "脱敏", text: "请求发往上游之前替换其中的敏感内容" },
    { name: "图片理解", text: "让不支持图片输入的模型也能处理图片" },
    { name: "联网搜索", text: "为模型调用提供搜索" },
  ];
  return (
    <Card
      title="网关功能"
      lede="守护进程提供对应接口后，在这里为网关开启。"
      aside={<span className="tag neutral">即将推出</span>}
    >
      <ul className="divide-y rounded-xl border">
        {features.map((feature) => (
          <li
            key={feature.name}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <span className="min-w-0">
              <span className="block text-[13.5px]">{feature.name}</span>
              <span className="block text-[12.5px] text-muted-foreground">
                {feature.text}
              </span>
            </span>
            <Switch
              checked={false}
              disabled
              aria-label={`${feature.name}（即将推出）`}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

const tabs = [
  { page: "settings", label: "通用" },
  { page: "backup", label: "备份与同步" },
] as const;

/**
 * Settings of the daemon: LAN sharing, the model catalog, gateway features
 * and what is running; backup, restore and sync are the second tab.
 */
export function SettingsPage({
  tab,
}: {
  tab: Extract<Page, "settings" | "backup">;
}) {
  const nav = <PageTabs label="设置" current={tab} tabs={tabs} />;
  return tab === "backup" ? <BackupPage tabs={nav} /> : <General tabs={nav} />;
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
        <PageHeader
          title="设置"
          lede="局域网共享、模型目录、网关功能与这个守护进程的信息。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={() => {
              setOverride({});
              reload();
            }}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
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
              <GatewayFeatures />
              <Card title="关于">
                <dl className="text-[13px]">
                  <Row label="版本">
                    {data.value.system.version}{" "}
                    <span className="font-mono text-[12px] text-subtle">
                      {data.value.system.commit.slice(0, 12)}
                    </span>
                  </Row>
                  <Row label="进程">
                    pid {data.value.system.pid} · 启动于{" "}
                    <LocalTime value={data.value.system.startedAt} />
                  </Row>
                  <Row label="数据目录">
                    <span className="font-mono text-[12px] break-all">
                      {data.value.system.dataDir}
                    </span>
                  </Row>
                  <Row label="秘密存储">
                    {
                      {
                        keychain: "macOS 钥匙串",
                        dpapi: "Windows DPAPI",
                        file: "加密文件",
                      }[data.value.system.secretBackend]
                    }
                  </Row>
                  {data.value.system.gateway ? (
                    <>
                      <Row label="OpenAI 基址">
                        <span className="font-mono text-[12px]">
                          {data.value.system.gateway.openaiBaseUrl}
                        </span>
                      </Row>
                      <Row label="Anthropic / Gemini 基址">
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
