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
  endpointHint,
  failureOf,
  modelIds,
  modelMetadataCells,
  modelPlane,
  protocolNames,
  protocols,
  providerFormOf,
  providerInput,
  kindName,
  providerKinds,
  providerPatch,
  type Failure,
  type ProviderForm,
} from "@/lib/model-plane";
import { providerIcon } from "@/lib/gateway-models";
import { formatDateTime, t } from "@/lib/i18n";
import { stateKey } from "@/lib/routing-state";
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
import { ProviderDoctorDialog } from "./provider-doctor";
import {
  CredentialState,
  Readings,
  useRoutingStates,
  type RoutingStates,
} from "./routing-state";

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
            <th>{t("providers.table.upstreamName")}</th>
            <th>{t("providers.table.context")}</th>
            <th>{t("providers.table.maxOutput")}</th>
            <th title={t("providers.table.priceUnit")}>
              {t("providers.table.price")}
            </th>
            <th>{t("providers.table.listed")}</th>
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
                    {exposed(model.id) ? t("providers.yes") : t("providers.no")}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {metadata.state === "error" ? (
        <p className="px-5 py-2 text-[12.5px] text-muted-foreground">
          {t("providers.table.metadataFailed", { message: metadata.message })}
        </p>
      ) : null}
      {!provider.models.list.length ? (
        <p className="empty-state">{t("providers.table.noModels")}</p>
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
    "/imageEndpoint",
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
            {provider
              ? t("providers.dialog.editTitle", { name: provider.name })
              : t("providers.add")}
          </DialogTitle>
          <DialogDescription>
            {!provider && tab === "preset"
              ? t("providers.dialog.presetLede")
              : t("providers.dialog.manualLede")}
          </DialogDescription>
        </DialogHeader>
        {provider ? null : (
          <div
            className="segmented w-fit"
            role="tablist"
            aria-label={t("providers.dialog.how")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "preset"}
              onClick={() => setTab("preset")}
            >
              {t("providers.dialog.fromPreset")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "manual"}
              onClick={() => setTab("manual")}
            >
              {t("providers.dialog.manual")}
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
                  {t("providers.dialog.idHint")}
                </span>
                <FieldError failure={failure} pointer="/id" />
              </label>
              <label className="field-label">
                {t("providers.name")}
                <input
                  className="field"
                  value={form.name}
                  placeholder={t("providers.dialog.namePlaceholder")}
                  autoComplete="off"
                  onChange={(event) => set({ name: event.target.value })}
                />
                <FieldError failure={failure} pointer="/name" />
              </label>
              <label className="field-label">
                {t("providers.dialog.kind")}
                <select
                  className="field"
                  value={form.kind}
                  onChange={(event) =>
                    set({ kind: event.target.value as ProviderForm["kind"] })
                  }
                >
                  {providerKinds.map((item) => (
                    <option key={item} value={item}>
                      {kindName(item)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                {t("providers.apiKeyHeader")}
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
              <legend className="section-title mb-2">
                {t("providers.dialog.endpointsLegend")}
              </legend>
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
                    {endpointHint(protocol)}
                  </span>
                  <FieldError
                    failure={failure}
                    pointer={`/endpoints/${protocol}`}
                  />
                </label>
              ))}
            </fieldset>
            <label className="field-label">
              {t("providers.dialog.imageEndpoint")}
              <input
                className="field font-mono text-[13px]"
                value={form.imageEndpoint}
                aria-invalid={!!failure?.fields["/imageEndpoint"]}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set({ imageEndpoint: event.target.value })}
              />
              <span className="field-hint block">
                {t("providers.dialog.imageEndpointHint")}
              </span>
              <FieldError failure={failure} pointer="/imageEndpoint" />
            </label>
            <label className="field-label">
              {t("providers.models")}
              <textarea
                className="field font-mono text-[12.5px]"
                rows={4}
                value={form.models}
                placeholder={t("providers.dialog.modelsPlaceholder")}
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
                  {t("providers.dialog.exposeAll")}
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
                {t("common.cancel")}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {t("providers.save")}
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
            {rotating
              ? t("providers.secret.rotateTitle", { name: rotating.name })
              : t("providers.secret.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("providers.secret.lede")}</DialogDescription>
        </DialogHeader>
        {rotating ? null : (
          <label className="field-label">
            {t("providers.name")}
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
          {rotating ? t("providers.secret.newKey") : "API Key"}
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
              {t("providers.secret.only")}
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
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !value} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {rotating ? t("providers.secret.rotate") : t("providers.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function referenceText(credential: ProviderCredential) {
  const { kind, value } = credential.ref;
  return kind === "store"
    ? t("providers.ref.store", { id: value.slice(0, 8) })
    : kind === "env"
      ? t("providers.ref.env", { name: value })
      : kind === "file"
        ? t("providers.ref.file", { path: value })
        : t("providers.ref.keychain", { id: value.slice(0, 8) });
}

function ProviderDetail({
  provider,
  icon,
  back,
  edit,
  remove,
  reload,
  states,
}: {
  provider: ProviderConfig;
  /** Lobehub slug of the provider's preset. */
  icon: string | undefined;
  back: () => void;
  edit: () => void;
  remove: () => void;
  reload: () => void;
  /** The gateway's routing state of the credentials. */
  states: RoutingStates;
}) {
  const [secret, setSecret] = useState<{
    rotating: ProviderCredential | undefined;
  } | null>(null);
  const [deleting, setDeleting] = useState<ProviderCredential | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<Failure | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <>
      <button
        type="button"
        className="mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        onClick={back}
      >
        <ArrowLeft className="size-3.5" />
        {t("providers.detail.back")}
      </button>
      <PageHeader
        icon={
          <BrandIcon
            slug={icon}
            name={provider.name}
            className="mt-0.5 size-9"
          />
        }
        title={provider.name}
        lede={[
          provider.id,
          kindName(provider.kind),
          ...(provider.preset
            ? [
                `${t("providers.detail.preset", { preset: provider.preset })}${provider.region ? ` · ${provider.region}` : ""}${provider.plan ? ` · ${provider.plan}` : ""}`,
              ]
            : []),
          t("providers.detail.updated", {
            time: formatDateTime(provider.updatedAt),
          }),
        ].join(" · ")}
      >
        {provider.subscription ? (
          <span title={t("providers.detail.checkSubscription")}>
            <Button size="sm" variant="outline" disabled>
              <Stethoscope />
              {t("providers.detail.check")}
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setChecking(true)}>
            <Stethoscope />
            {t("providers.detail.check")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={edit}>
          <Pencil />
          {t("providers.edit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={remove}>
          <Trash2 />
          {t("providers.delete")}
        </Button>
      </PageHeader>
      <h2 className="section-title mt-7 mb-3">{t("providers.endpoints")}</h2>
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
          {provider.imageEndpoint ? (
            <div className="metric-row">
              <dt>{t("providers.detail.image")}</dt>
              <dd className="font-mono text-[12.5px]">
                {provider.imageEndpoint}
              </dd>
            </div>
          ) : null}
          <div className="metric-row">
            <dt>{t("providers.apiKeyHeader")}</dt>
            <dd className="font-mono text-[12.5px]">
              {provider.auth.apiKeyHeader}
            </dd>
          </div>
        </dl>
      </div>
      <div className="mt-7 mb-3 flex items-center justify-between gap-3">
        <h2 className="section-title">
          {provider.subscription
            ? t("providers.detail.accounts")
            : t("providers.credentials")}
        </h2>
        {provider.subscription ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("subscriptions")}
          >
            <CreditCard />
            {t("providers.detail.manageAccounts")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSecret({ rotating: undefined })}
          >
            <Plus />
            {t("providers.detail.addCredential")}
          </Button>
        )}
      </div>
      <div className="panel overflow-x-auto">
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th>ID</th>
              <th>{t("providers.name")}</th>
              <th>{t("providers.detail.reference")}</th>
              <th>{t("providers.endpoints")}</th>
              <th>{t("providers.detail.routing")}</th>
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
                    <span className="tag warn ml-2">
                      {t("providers.disabled")}
                    </span>
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
                    .join(t("providers.separator")) ?? t("providers.all")}
                </td>
                <td className="min-w-[200px]">
                  {states.state === "ready" ? (
                    <>
                      <CredentialState
                        state={states.byCredential.get(
                          stateKey(provider.id, credential.id),
                        )}
                      />
                      <Readings
                        className="mt-1.5"
                        readings={
                          states.byCredential.get(
                            stateKey(provider.id, credential.id),
                          )?.readings ?? []
                        }
                      />
                    </>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className="w-[132px] text-right">
                  {credential.ref.kind === "store" && !provider.subscription ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("providers.detail.rotateCredential", {
                        name: credential.name,
                      })}
                      title={t("providers.secret.rotate")}
                      onClick={() => setSecret({ rotating: credential })}
                    >
                      <RotateCw />
                    </Button>
                  ) : null}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("providers.detail.deleteCredential", {
                      name: credential.name,
                    })}
                    title={t("providers.delete")}
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
            {t("providers.detail.noCredentials")}
          </p>
        ) : null}
      </div>
      <div className="mt-7 mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-title">{t("providers.models")}</h2>
          <span className="text-[12.5px] text-subtle">
            {provider.models.source === "live"
              ? t("providers.detail.fromUpstream")
              : t("providers.detail.manualModels")}
            {provider.models.refreshedAt
              ? t("providers.detail.refreshedAt", {
                  time: formatDateTime(provider.models.refreshedAt),
                })
              : ""}
          </span>
          {provider.models.stale ? (
            <span className="tag warn" title={t("providers.detail.staleHint")}>
              {t("providers.detail.stale")}
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
          {t("providers.detail.refreshModels")}
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
      {checking ? (
        <ProviderDoctorDialog
          provider={provider}
          onClose={() => setChecking(false)}
          onPatched={reload}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t("providers.detail.deleteCredentialTitle", {
          name: deleting?.name ?? "",
        })}
        description={t("providers.detail.deleteCredentialBody")}
        action={t("providers.delete")}
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
  const [states] = useRoutingStates();
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
            states={states}
          />
        ) : (
          <>
            <PageHeader title="Provider" lede={t("providers.list.lede")}>
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
                variant="outline"
                onClick={() => setImporting(true)}
              >
                <Download />
                {t("providers.importButton")}
              </Button>
              <Button
                size="sm"
                onClick={() => setEditing({ provider: undefined })}
              >
                <Plus />
                {t("providers.add")}
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
                        <th>{t("providers.list.kind")}</th>
                        <th>{t("providers.endpoints")}</th>
                        <th>{t("providers.credentials")}</th>
                        <th>{t("providers.models")}</th>
                        <th>{t("providers.list.updated")}</th>
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
                          <td className="whitespace-nowrap">
                            {kindName(provider.kind)}
                          </td>
                          <td className="text-[12.5px]">
                            {protocols
                              .filter(
                                (p) => provider.endpoints[p] !== undefined,
                              )
                              .map((p) => protocolNames[p])
                              .join(t("providers.separator"))}
                          </td>
                          <td className="tabular">
                            {provider.credentials.length ? (
                              provider.credentials.length
                            ) : (
                              <span className="tag warn">
                                {t("providers.list.none")}
                              </span>
                            )}
                            {states.state === "ready" &&
                            provider.credentials.some(
                              (credential) =>
                                states.byCredential.get(
                                  stateKey(provider.id, credential.id),
                                )?.state === "open",
                            ) ? (
                              <span className="tag warn ml-1.5">
                                {t("providers.list.resting")}
                              </span>
                            ) : null}
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
                  title={t("providers.list.empty")}
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => setEditing({ provider: undefined })}
                      >
                        <Plus />
                        {t("providers.add")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setImporting(true)}
                      >
                        <Download />
                        {t("providers.importButton")}
                      </Button>
                    </div>
                  }
                >
                  {t("providers.list.emptyBody")}
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
          title={t("providers.list.deleteTitle", {
            name: removing?.name ?? "",
          })}
          description={t("providers.list.deleteBody")}
          action={t("providers.delete")}
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
