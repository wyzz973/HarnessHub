// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  ArrowLeft,
  CreditCard,
  Download,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Stethoscope,
  Trash2,
} from "lucide-react";
import type {
  ProviderConfig,
  ProviderCredential,
  WireProtocol,
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
  apiKeyHeaders,
  emptyProviderForm,
  endpointHints,
  failureOf,
  modelIds,
  modelMetadataCells,
  modelPlane,
  protocolNames,
  protocols,
  providerFormOf,
  providerInput,
  providerKinds,
  providerPatch,
  type Failure,
  type ProviderForm,
} from "@/lib/model-plane";
import { providerIcon } from "@/lib/gateway-models";
import { navigate } from "@/lib/router";
import { BrandIcon } from "./brand-icon";
import { ImportDialog } from "./import-dialog";
import {
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorCallout,
  FieldError,
  LoadError,
  LocalTime,
  OtherFieldErrors,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";
import { PresetPane } from "./preset-pane";

const kindName = (kind: ProviderConfig["kind"]) =>
  providerKinds.find((item) => item.id === kind)?.label ?? kind;

/**
 * The provider's models with context, output and price as the daemon
 * resolves them; each value's tooltip names its source. Mounted per provider
 * version, so a refresh or an edit loads the metadata again.
 */
function ModelTable({ provider }: { provider: ProviderConfig }) {
  const load = useCallback(
    () =>
      modelPlane()
        .providers.models(provider.id)
        .then((page) => new Map(page.items.map((item) => [item.ref, item]))),
    [provider.id],
  );
  const [metadata] = useLoaded(load);
  const exposed = (id: string) =>
    provider.models.expose === "all" || provider.models.expose.includes(id);
  return (
    <div className="panel overflow-x-auto">
      <table className="data-table min-w-[760px]">
        <thead>
          <tr>
            <th>Model Ref</th>
            <th>上游名称</th>
            <th>上下文</th>
            <th>最大输出</th>
            <th title="美元 / 百万 token">价格（输入 / 输出）</th>
            <th>对外列出</th>
          </tr>
        </thead>
        <tbody>
          {provider.models.list.map((model) => {
            const ref = `${provider.id}/${model.id}`;
            const cells = modelMetadataCells(
              metadata.state === "ready" ? metadata.value.get(ref) : undefined,
            );
            return (
              <tr key={model.id}>
                <td className="font-mono text-[12.5px]">{ref}</td>
                <td className="font-mono text-[12.5px]">
                  {model.wire ?? model.id}
                </td>
                <td className="tabular" title={cells.context.note}>
                  {cells.context.text}
                </td>
                <td className="tabular" title={cells.output.note}>
                  {cells.output.text}
                </td>
                <td className="tabular" title={cells.price.note}>
                  {cells.price.text}
                </td>
                <td>
                  <span className={exposed(model.id) ? "tag good" : "tag"}>
                    {exposed(model.id) ? "是" : "否"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {metadata.state === "error" ? (
        <p className="px-5 py-2 text-[12.5px] text-muted-foreground">
          元数据读取失败：{metadata.message}
        </p>
      ) : null}
      {!provider.models.list.length ? (
        <p className="empty-state">
          还没有模型，编辑 provider 时每行填写一个模型 ID。
        </p>
      ) : null}
    </div>
  );
}

/** Add or edit a provider; the daemon's base-URL rules come back as field errors. */
function ProviderDialog({
  provider,
  open,
  onClose,
  onSaved,
}: {
  /** Undefined to add a provider. */
  provider: ProviderConfig | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: (saved: ProviderConfig) => void;
}) {
  const [form, setForm] = useState<ProviderForm>(() =>
    provider ? providerFormOf(provider) : emptyProviderForm(),
  );
  const [tab, setTab] = useState<"preset" | "manual">("preset");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const set = (patch: Partial<ProviderForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const models = modelIds(form.models);
  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      const saved = provider
        ? await modelPlane().providers.update(
            provider.id,
            providerPatch(form, provider),
          )
        : await modelPlane().providers.create(providerInput(form));
      onSaved(saved);
    } catch (reason) {
      setFailure(failureOf(reason));
    } finally {
      setBusy(false);
    }
  }
  const shown = [
    "/id",
    "/name",
    "/endpoints",
    ...protocols.map((protocol) => `/endpoints/${protocol}`),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>
            {provider ? `编辑 ${provider.name}` : "添加 provider"}
          </DialogTitle>
          <DialogDescription>
            {!provider && tab === "preset"
              ? "从内置预设创建：端点已按厂商文档填好，填写 API Key 即可使用。"
              : "端点填写厂商官方 SDK 使用的基址；凭据在保存后单独添加。"}
          </DialogDescription>
        </DialogHeader>
        {provider ? null : (
          <div className="segmented w-fit" role="tablist" aria-label="添加方式">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "preset"}
              onClick={() => setTab("preset")}
            >
              从预设
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "manual"}
              onClick={() => setTab("manual")}
            >
              手动填写
            </button>
          </div>
        )}
        {!provider && tab === "preset" ? (
          <PresetPane onSaved={onSaved} onCancel={onClose} onBusy={setBusy} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="field-label">
                ID
                <input
                  className="field font-mono text-[13px]"
                  value={form.id}
                  placeholder="deepseek"
                  readOnly={!!provider}
                  autoFocus={!provider}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => set({ id: event.target.value })}
                />
                <span className="field-hint block">
                  小写字母、数字与连字符；Model Ref 为 ID/模型。
                </span>
                <FieldError failure={failure} pointer="/id" />
              </label>
              <label className="field-label">
                名称
                <input
                  className="field"
                  value={form.name}
                  placeholder="与 ID 相同"
                  autoComplete="off"
                  onChange={(event) => set({ name: event.target.value })}
                />
                <FieldError failure={failure} pointer="/name" />
              </label>
              <label className="field-label">
                类型
                <select
                  className="field"
                  value={form.kind}
                  onChange={(event) =>
                    set({ kind: event.target.value as ProviderForm["kind"] })
                  }
                >
                  {providerKinds.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Key 的发送方式
                <select
                  className="field font-mono text-[13px]"
                  value={form.apiKeyHeader}
                  onChange={(event) =>
                    set({ apiKeyHeader: event.target.value })
                  }
                >
                  {[
                    ...apiKeyHeaders,
                    ...(apiKeyHeaders.includes(
                      form.apiKeyHeader as (typeof apiKeyHeaders)[number],
                    )
                      ? []
                      : [form.apiKeyHeader]),
                  ].map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="space-y-3">
              <legend className="section-title mb-2">端点（至少一个）</legend>
              <FieldError failure={failure} pointer="/endpoints" />
              {protocols.map((protocol) => (
                <label key={protocol} className="field-label">
                  {protocolNames[protocol]}
                  <input
                    className="field font-mono text-[13px]"
                    value={form.endpoints[protocol]}
                    aria-invalid={!!failure?.fields[`/endpoints/${protocol}`]}
                    placeholder="https://"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      set({
                        endpoints: {
                          ...form.endpoints,
                          [protocol]: event.target.value,
                        },
                      })
                    }
                  />
                  <span className="field-hint block">
                    {endpointHints[protocol]}
                  </span>
                  <FieldError
                    failure={failure}
                    pointer={`/endpoints/${protocol}`}
                  />
                </label>
              ))}
            </fieldset>
            <label className="field-label">
              模型
              <textarea
                className="field font-mono text-[12.5px]"
                rows={4}
                value={form.models}
                placeholder={"每行一个模型 ID，例如\ndeepseek-chat"}
                spellCheck={false}
                onChange={(event) => set({ models: event.target.value })}
              />
            </label>
            {models.length ? (
              <div>
                <Checkbox
                  checked={form.expose === "all"}
                  onChange={(all) => set({ expose: all ? "all" : [...models] })}
                >
                  全部模型出现在 /v1/models 与 Agent 的模型选择中
                </Checkbox>
                {form.expose !== "all" ? (
                  <div className="mt-1 grid gap-0.5 pl-6 sm:grid-cols-2">
                    {models.map((id) => {
                      const exposed = form.expose as string[];
                      return (
                        <Checkbox
                          key={id}
                          checked={exposed.includes(id)}
                          onChange={(checked) =>
                            set({
                              expose: checked
                                ? [...exposed, id]
                                : exposed.filter((item) => item !== id),
                            })
                          }
                        >
                          <span className="font-mono text-[12.5px]">{id}</span>
                        </Checkbox>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            <ErrorCallout failure={failure} />
            <OtherFieldErrors failure={failure} shown={shown} />
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                取消
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add a credential or rotate one: the value is sent once to the daemon's
 * secret store and cleared from the form; only the reference comes back.
 */
function SecretDialog({
  provider,
  rotating,
  open,
  onClose,
  onSaved,
}: {
  provider: ProviderConfig;
  /** The credential to rotate; undefined to add one. */
  rotating: ProviderCredential | undefined;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [only, setOnly] = useState<WireProtocol[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const available = protocols.filter(
    (protocol) => provider.endpoints[protocol] !== undefined,
  );
  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      if (rotating)
        await modelPlane().credentials.rotate(provider.id, rotating.id, value);
      else
        await modelPlane().credentials.add(provider.id, {
          name: name.trim() || "default",
          value,
          ...(only.length ? { protocols: only } : {}),
        });
      setValue("");
      onSaved();
    } catch (reason) {
      setFailure(failureOf(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          setValue("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {rotating ? `轮换 ${rotating.name}` : "添加凭据"}
          </DialogTitle>
          <DialogDescription>
            Key
            只发送一次，保存在守护进程的秘密存储中；之后只显示引用，不会再显示值。
          </DialogDescription>
        </DialogHeader>
        {rotating ? null : (
          <label className="field-label">
            名称
            <input
              className="field"
              value={name}
              placeholder="default"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <label className="field-label">
          {rotating ? "新的 API Key" : "API Key"}
          <input
            className="field font-mono text-[13px]"
            type="password"
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
          <FieldError failure={failure} pointer="/value" />
        </label>
        {!rotating && available.length > 1 ? (
          <fieldset>
            <legend className="field-label mb-1">
              只用于这些端点（不选则全部）
            </legend>
            {available.map((protocol) => (
              <Checkbox
                key={protocol}
                checked={only.includes(protocol)}
                onChange={(checked) =>
                  setOnly((current) =>
                    checked
                      ? [...current, protocol]
                      : current.filter((item) => item !== protocol),
                  )
                }
              >
                {protocolNames[protocol]}
              </Checkbox>
            ))}
          </fieldset>
        ) : null}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setValue("");
              onClose();
            }}
          >
            取消
          </Button>
          <Button disabled={busy || !value} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {rotating ? "轮换" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function referenceText(credential: ProviderCredential) {
  const { kind, value } = credential.ref;
  return kind === "store"
    ? `已保存 · ${value.slice(0, 8)}`
    : kind === "env"
      ? `环境变量 ${value}`
      : kind === "file"
        ? `文件 ${value}`
        : `钥匙串 · ${value.slice(0, 8)}`;
}

function ProviderDetail({
  provider,
  icon,
  back,
  edit,
  remove,
  reload,
}: {
  provider: ProviderConfig;
  /** Lobehub slug of the provider's preset. */
  icon: string | undefined;
  back: () => void;
  edit: () => void;
  remove: () => void;
  reload: () => void;
}) {
  const [secret, setSecret] = useState<{
    rotating: ProviderCredential | undefined;
  } | null>(null);
  const [deleting, setDeleting] = useState<ProviderCredential | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<Failure | null>(null);
  return (
    <>
      <button
        type="button"
        className="mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        onClick={back}
      >
        <ArrowLeft className="size-3.5" />
        全部 provider
      </button>
      <PageHeader
        icon={<BrandIcon slug={icon} name={provider.name} className="mt-0.5 size-9" />}
        title={provider.name}
        lede={[
          provider.id,
          kindName(provider.kind),
          ...(provider.preset
            ? [
                `预设 ${provider.preset}${provider.region ? ` · ${provider.region}` : ""}${provider.plan ? ` · ${provider.plan}` : ""}`,
              ]
            : []),
          `更新于 ${new Date(provider.updatedAt).toLocaleString()}`,
        ].join(" · ")}
      >
        <span title="即将推出：检查端点、Key 与模型列表">
          <Button size="sm" variant="outline" disabled>
            <Stethoscope />
            检测
          </Button>
        </span>
        <Button size="sm" variant="outline" onClick={edit}>
          <Pencil />
          编辑
        </Button>
        <Button size="sm" variant="ghost" onClick={remove}>
          <Trash2 />
          删除
        </Button>
      </PageHeader>
      <h2 className="section-title mt-7 mb-3">端点</h2>
      <div className="panel px-5 py-2">
        <dl>
          {protocols
            .filter((protocol) => provider.endpoints[protocol] !== undefined)
            .map((protocol) => (
              <div key={protocol} className="metric-row">
                <dt>{protocolNames[protocol]}</dt>
                <dd className="font-mono text-[12.5px]">
                  {provider.endpoints[protocol]}
                </dd>
              </div>
            ))}
          <div className="metric-row">
            <dt>Key 的发送方式</dt>
            <dd className="font-mono text-[12.5px]">
              {provider.auth.apiKeyHeader}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mt-7 mb-3 flex items-center justify-between gap-3">
        <h2 className="section-title">
          {provider.subscription ? "订阅账号" : "凭据"}
        </h2>
        {provider.subscription ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("subscriptions")}
          >
            <CreditCard />
            管理账号
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSecret({ rotating: undefined })}
          >
            <Plus />
            添加凭据
          </Button>
        )}
      </div>
      <div className="panel overflow-x-auto">
        <table className="data-table min-w-[560px]">
          <thead>
            <tr>
              <th>ID</th>
              <th>名称</th>
              <th>引用</th>
              <th>端点</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {provider.credentials.map((credential) => (
              <tr key={credential.id}>
                <td className="font-mono text-[12.5px]">{credential.id}</td>
                <td>
                  {credential.name}
                  {!credential.enabled ? (
                    <span className="tag warn ml-2">已停用</span>
                  ) : null}
                </td>
                <td
                  className="text-[12.5px] text-muted-foreground"
                  title={`${credential.ref.kind}:${credential.ref.value}`}
                >
                  {referenceText(credential)}
                </td>
                <td className="text-[12.5px]">
                  {credential.protocols
                    ?.map((p) => protocolNames[p])
                    .join("、") ?? "全部"}
                </td>
                <td className="w-[132px] text-right">
                  {credential.ref.kind === "store" && !provider.subscription ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`轮换 ${credential.name}`}
                      title="轮换"
                      onClick={() => setSecret({ rotating: credential })}
                    >
                      <RotateCw />
                    </Button>
                  ) : null}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除 ${credential.name}`}
                    title="删除"
                    onClick={() => setDeleting(credential)}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!provider.credentials.length ? (
          <p className="empty-state">
            <KeyRound className="size-5" strokeWidth={1.7} />
            还没有凭据，请求上游时需要至少一个。
          </p>
        ) : null}
      </div>
      <div className="mt-7 mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-title">模型</h2>
          <span className="text-[12.5px] text-subtle">
            {provider.models.source === "live" ? "来自上游" : "手动或内置"}
            {provider.models.refreshedAt
              ? `，${new Date(provider.models.refreshedAt).toLocaleString()} 刷新`
              : ""}
          </span>
          {provider.models.stale ? (
            <span className="tag warn" title="上次刷新失败，显示的是之前的列表">
              未更新
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            setRefreshFailure(null);
            modelPlane()
              .providers.refreshModels(provider.id)
              .then(
                () => undefined,
                (reason: unknown) => setRefreshFailure(failureOf(reason)),
              )
              .finally(() => {
                setRefreshing(false);
                reload();
              });
          }}
        >
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新模型
        </Button>
      </div>
      <ErrorCallout failure={refreshFailure} className="mb-3" />
      <ModelTable key={provider.updatedAt} provider={provider} />
      {secret ? (
        <SecretDialog
          provider={provider}
          rotating={secret.rotating}
          open
          onClose={() => setSecret(null)}
          onSaved={() => {
            setSecret(null);
            reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`删除凭据 ${deleting?.name ?? ""}`}
        description="由 HarnessHub 保存的 Key 会从秘密存储中删除。"
        action="删除"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting)
            await modelPlane().credentials.remove(provider.id, deleting.id);
          reload();
        }}
      />
    </>
  );
}

/** Providers and their credentials and models (`/api/v1/providers`). */
export function ProvidersPage() {
  const load = useCallback(
    async () => (await modelPlane().providers.list()).items,
    [],
  );
  const [providers, reload] = useLoaded(load);
  // Only for the marks: a provider is shown without one while they load.
  const loadPresets = useCallback(
    async () => (await modelPlane().presets.list()).items,
    [],
  );
  const [presets] = useLoaded(loadPresets);
  const iconOf = (provider: ProviderConfig) =>
    providerIcon(
      provider,
      new Map(
        presets.state === "ready"
          ? presets.value.map((preset) => [preset.id, preset.icon])
          : [],
      ),
    );
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    provider: ProviderConfig | undefined;
  } | null>(null);
  const [removing, setRemoving] = useState<ProviderConfig | null>(null);
  const list = providers.state === "ready" ? providers.value : [];
  const current = list.find((provider) => provider.id === selected);
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        {current ? (
          <ProviderDetail
            provider={current}
            icon={iconOf(current)}
            back={() => setSelected(null)}
            edit={() => setEditing({ provider: current })}
            remove={() => setRemoving(current)}
            reload={reload}
          />
        ) : (
          <>
            <PageHeader
              title="Provider"
              lede="上游模型服务、端点与凭据；网关按 provider/模型 路由请求。"
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
                variant="outline"
                onClick={() => setImporting(true)}
              >
                <Download />
                导入
              </Button>
              <Button
                size="sm"
                onClick={() => setEditing({ provider: undefined })}
              >
                <Plus />
                添加 provider
              </Button>
            </PageHeader>
            <div className="mt-6">
              {providers.state === "loading" ? (
                <div className="panel space-y-3 p-5">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : providers.state === "error" ? (
                <LoadError message={providers.message} retry={reload} />
              ) : list.length ? (
                <div className="panel overflow-x-auto">
                  <table className="data-table min-w-[760px]">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>类型</th>
                        <th>端点</th>
                        <th>凭据</th>
                        <th>模型</th>
                        <th>更新</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((provider) => (
                        <tr
                          key={provider.id}
                          className="cursor-pointer"
                          onClick={() => setSelected(provider.id)}
                        >
                          <td>
                            <div className="flex items-center gap-2.5">
                              <BrandIcon
                                slug={iconOf(provider)}
                                name={provider.name}
                              />
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  className="text-left font-medium hover:underline"
                                  onClick={() => setSelected(provider.id)}
                                >
                                  {provider.name}
                                </button>
                                <p className="font-mono text-[12px] text-subtle">
                                  {provider.id}
                                  {provider.region
                                    ? ` · ${provider.region}`
                                    : ""}
                                  {provider.plan ? ` · ${provider.plan}` : ""}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="whitespace-nowrap">{kindName(provider.kind)}</td>
                          <td className="text-[12.5px]">
                            {protocols
                              .filter(
                                (p) => provider.endpoints[p] !== undefined,
                              )
                              .map((p) => protocolNames[p])
                              .join("、")}
                          </td>
                          <td className="tabular">
                            {provider.credentials.length ? (
                              provider.credentials.length
                            ) : (
                              <span className="tag warn">无</span>
                            )}
                          </td>
                          <td className="tabular">
                            {provider.models.list.length}
                          </td>
                          <td className="text-[12.5px] text-muted-foreground">
                            <LocalTime value={provider.updatedAt} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  icon={Server}
                  title="还没有 provider"
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => setEditing({ provider: undefined })}
                      >
                        <Plus />
                        添加 provider
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setImporting(true)}
                      >
                        <Download />
                        导入
                      </Button>
                    </div>
                  }
                >
                  添加模型厂商、中转网关或本机模型服务；也可以粘贴导入链接，或从
                  Claude Code、Codex 的配置导入。
                </EmptyState>
              )}
            </div>
          </>
        )}
        {editing ? (
          <ProviderDialog
            key={editing.provider?.id ?? "new"}
            provider={editing.provider}
            open
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null);
              setSelected(saved.id);
              reload();
            }}
          />
        ) : null}
        {importing ? (
          <ImportDialog
            onClose={() => setImporting(false)}
            onImported={reload}
          />
        ) : null}
        <ConfirmDialog
          open={removing !== null}
          title={`删除 ${removing?.name ?? ""}`}
          description="同时删除它保存在秘密存储中的 Key。仍被路由组或 Gateway Key 引用时不能删除。"
          action="删除"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            if (removing) await modelPlane().providers.remove(removing.id);
            setSelected(null);
            reload();
          }}
        />
      </div>
    </div>
  );
}
