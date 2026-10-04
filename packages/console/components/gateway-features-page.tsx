// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type {
  GatewayFeaturesView,
  ProviderConfig,
  SearchBackendKind,
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
import { Switch } from "@/components/ui/switch";
import { ModelPicker } from "@/components/model-picker";
import {
  ruleOf,
  rulesWith,
  searchKinds,
  type RuleForm,
} from "@/lib/gateway-features";
import { gatewayModels, type GatewayModels } from "@/lib/gateway-models";
import { t } from "@/lib/i18n";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { navigate } from "@/lib/router";
import { notify } from "@/lib/toast";
import {
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  LoadError,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";

/** What a feature costs and what it sends where, one line each. */
function Implications({ cost, privacy }: { cost: string; privacy: string }) {
  return (
    <dl className="callout neutral grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <dt className="font-medium text-foreground">
        {t("settings.features.cost")}
      </dt>
      <dd>{cost}</dd>
      <dt className="font-medium text-foreground">
        {t("settings.features.privacy")}
      </dt>
      <dd>{privacy}</dd>
    </dl>
  );
}

/** The details of a refused change, without the JSON Pointers. */
function Details({ failure }: { failure: Failure | null }) {
  const details = Object.values(failure?.fields ?? {});
  if (!details.length) return null;
  return (
    <ul className="callout error block list-disc space-y-0.5 pl-8">
      {details.map((detail) => (
        <li key={detail}>{detail}</li>
      ))}
    </ul>
  );
}

/**
 * Outbound redaction: on by default; turning it off asks first. The
 * user's rules are added (one of the same name is replaced) and removed
 * one at a time, each a `PUT` of the whole list.
 */
function Redaction({
  features,
  onChange,
}: {
  features: GatewayFeaturesView;
  onChange: (features: GatewayFeaturesView) => void;
}) {
  const [form, setForm] = useState<RuleForm>({
    name: "",
    pattern: "",
    ignoreCase: false,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [disabling, setDisabling] = useState(false);
  const save = (
    input: Parameters<
      ReturnType<typeof modelPlane>["gatewayFeatures"]["setRedaction"]
    >[0],
    done: string,
  ) => {
    setBusy(true);
    setFailure(null);
    return modelPlane()
      .gatewayFeatures.setRedaction(input)
      .then(
        (next) => {
          setBusy(false);
          onChange(next);
          notify.success(done);
          return true;
        },
        (reason: unknown) => {
          setBusy(false);
          setFailure(failureOf(reason));
          return false;
        },
      );
  };
  const rules = features.redaction.rules;
  return (
    <Card
      title={t("settings.redaction.title")}
      lede={t("settings.redaction.lede")}
      aside={
        <Switch
          checked={features.redaction.enabled}
          disabled={busy}
          aria-label={t("settings.redaction.title")}
          onCheckedChange={(checked) => {
            if (checked)
              void save({ enabled: true }, t("settings.redaction.enabled"));
            else setDisabling(true);
          }}
        />
      }
    >
      <Implications
        cost={t("settings.redaction.cost")}
        privacy={t("settings.redaction.privacy")}
      />
      <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted-foreground">
        <li>{t("settings.redaction.known1")}</li>
        <li>{t("settings.redaction.known2")}</li>
        <li>{t("settings.redaction.known3")}</li>
      </ul>
      {!features.redaction.enabled ? (
        <p className="callout warn">{t("settings.redaction.offWarning")}</p>
      ) : null}
      <div className="overflow-x-auto rounded-xl border">
        <table className="data-table min-w-[520px]">
          <thead>
            <tr>
              <th>{t("settings.redaction.rule")}</th>
              <th>{t("settings.redaction.pattern")}</th>
              <th>{t("settings.redaction.case")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.name}>
                <td className="font-mono text-[12.5px]">{rule.name}</td>
                <td className="max-w-[320px] font-mono text-[12.5px] break-all">
                  {rule.pattern}
                </td>
                <td className="text-[12.5px]">
                  {rule.flags === "i"
                    ? t("settings.redaction.ignore")
                    : t("settings.redaction.match")}
                </td>
                <td className="w-[56px] text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("settings.redaction.deleteRule", {
                      name: rule.name,
                    })}
                    disabled={busy}
                    onClick={() =>
                      void save(
                        {
                          rules: rulesWith(features, { remove: rule.name }),
                        },
                        t("settings.redaction.deleted", { name: rule.name }),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rules.length ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">
            {t("settings.redaction.noRules")}
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
        <label className="field-label">
          {t("settings.redaction.ruleName")}
          <input
            className="field font-mono text-[13px]"
            value={form.name}
            placeholder="codename"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <label className="field-label">
          {t("settings.redaction.pattern")}
          <input
            className="field font-mono text-[13px]"
            value={form.pattern}
            placeholder="falcon-[0-9]+"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                pattern: event.target.value,
              }))
            }
          />
        </label>
        <Button
          variant="outline"
          disabled={busy || !form.name.trim() || !form.pattern}
          onClick={() => {
            const rule = ruleOf(form);
            void save(
              { rules: rulesWith(features, { add: rule }) },
              t("settings.redaction.saved", { name: rule.name }),
            ).then((saved) => {
              if (saved) setForm({ name: "", pattern: "", ignoreCase: false });
            });
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          {t("settings.redaction.addRule")}
        </Button>
      </div>
      <Checkbox
        checked={form.ignoreCase}
        onChange={(ignoreCase) =>
          setForm((current) => ({ ...current, ignoreCase }))
        }
      >
        {t("settings.redaction.ignoreCase")}
      </Checkbox>
      <p className="field-hint">{t("settings.redaction.hint")}</p>
      <ErrorCallout failure={failure} />
      <Details failure={failure} />
      <ConfirmDialog
        open={disabling}
        title={t("settings.redaction.offTitle")}
        description={t("settings.redaction.offBody")}
        action={t("settings.redaction.offAction")}
        onClose={() => setDisabling(false)}
        onConfirm={async () => {
          onChange(
            await modelPlane().gatewayFeatures.setRedaction({ enabled: false }),
          );
          notify.success(t("settings.redaction.disabled"));
        }}
      />
    </Card>
  );
}

/** The model that describes images for models without image input, or none. */
function Vision({
  features,
  models,
  onChange,
}: {
  features: GatewayFeaturesView;
  models: GatewayModels;
  onChange: (features: GatewayFeaturesView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const choose = (model: string | undefined) => {
    if (model === features.vision?.model) return;
    setBusy(true);
    setFailure(null);
    const client = modelPlane().gatewayFeatures;
    (model === undefined ? client.clearVision() : client.setVision(model)).then(
      (next) => {
        setBusy(false);
        onChange(next);
        notify.success(
          model === undefined
            ? t("settings.vision.off")
            : t("settings.vision.using", { model }),
        );
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  return (
    <Card title={t("settings.vision.title")} lede={t("settings.vision.lede")}>
      <div className="max-w-[420px]">
        <ModelPicker
          label={t("settings.vision.model")}
          models={models}
          value={features.vision?.model}
          none={t("settings.vision.none")}
          disabled={busy || !models.sections.length}
          onChange={choose}
        />
      </div>
      <p className="field-hint">{t("settings.vision.hint")}</p>
      <p className="field-hint">{t("settings.vision.key")}</p>
      <Implications
        cost={t("settings.vision.cost")}
        privacy={t("settings.vision.privacy")}
      />
      <ErrorCallout failure={failure} />
      <Details failure={failure} />
    </Card>
  );
}

/** Register a search API; its key is sent once and kept in the secret store. */
function AddSearchDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (features: GatewayFeaturesView) => void;
}) {
  const [kind, setKind] = useState<SearchBackendKind>("tavily");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const info = searchKinds[kind];
  const ready =
    (info.key === "optional" || key.length > 0) &&
    (info.baseUrl === "optional" || baseUrl.trim().length > 0);
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("settings.search.addTitle")}</DialogTitle>
          <DialogDescription>{t("settings.search.addLede")}</DialogDescription>
        </DialogHeader>
        <label className="field-label">
          {t("settings.search.service")}
          <select
            className="field"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as SearchBackendKind)
            }
          >
            {(Object.keys(searchKinds) as SearchBackendKind[]).map((item) => (
              <option key={item} value={item}>
                {searchKinds[item].name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          API Key
          {info.key === "optional" ? (
            <span className="text-subtle">
              {t("settings.search.keyOptional")}
            </span>
          ) : null}
          <input
            className="field font-mono text-[13px]"
            type="password"
            value={key}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />
          <span className="field-hint block">
            {t("settings.search.keyHint")}
          </span>
        </label>
        <label className="field-label">
          {info.baseUrl === "required"
            ? t("settings.search.instance")
            : t("settings.search.apiUrl")}
          <input
            className="field font-mono text-[13px]"
            value={baseUrl}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              info.baseUrl === "required"
                ? "http://127.0.0.1:8888"
                : t("settings.search.defaultUrl", { name: info.name })
            }
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <ErrorCallout failure={failure} />
        <Details failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              modelPlane()
                .gatewayFeatures.addSearch({
                  kind,
                  ...(key ? { key } : {}),
                  ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                })
                .then(
                  (next) => {
                    setBusy(false);
                    setKey("");
                    onAdded(next);
                    notify.success(
                      t("settings.search.added", { name: info.name }),
                    );
                    onClose();
                  },
                  (reason: unknown) => {
                    setBusy(false);
                    setFailure(failureOf(reason));
                  },
                );
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("settings.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebSearch({
  features,
  onChange,
}: {
  features: GatewayFeaturesView;
  onChange: (features: GatewayFeaturesView) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const backends = features.search?.backends ?? [];
  return (
    <Card
      title={t("settings.search.title")}
      lede={t("settings.search.lede")}
      aside={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          {t("settings.search.addBackend")}
        </Button>
      }
    >
      <Implications
        cost={t("settings.search.cost")}
        privacy={t("settings.search.privacy")}
      />
      {backends.length ? (
        <ol className="divide-y rounded-xl border">
          {backends.map((backend, index) => (
            <li
              key={backend.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <span className="text-[12px] text-subtle tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px]">
                  {searchKinds[backend.kind].name}
                  <span className="ml-2 font-mono text-[12px] text-subtle">
                    {backend.id}
                  </span>
                </span>
                {backend.baseUrl ? (
                  <span className="block font-mono text-[12px] break-all text-muted-foreground">
                    {backend.baseUrl}
                  </span>
                ) : null}
              </span>
              <span className={`tag ${backend.hasKey ? "good" : ""}`}>
                {backend.hasKey
                  ? t("settings.search.keySaved")
                  : t("settings.search.noKey")}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("settings.search.deleteBackend", {
                  id: backend.id,
                })}
                onClick={() => setRemoving(backend.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Search className="size-4" />
          {t("settings.search.none")}
        </p>
      )}
      {adding ? (
        <AddSearchDialog onClose={() => setAdding(false)} onAdded={onChange} />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t("settings.search.deleteTitle", { id: removing ?? "" })}
        description={t("settings.search.deleteBody")}
        action={t("settings.delete")}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          onChange(await modelPlane().gatewayFeatures.removeSearch(removing));
          notify.success(t("settings.search.deleted", { id: removing }));
        }}
      />
    </Card>
  );
}

/** Image generation goes to providers with an image endpoint; they are set on the provider. */
function Images({ providers }: { providers: readonly ProviderConfig[] }) {
  const serving = providers.filter((provider) => provider.imageEndpoint);
  return (
    <Card
      title={t("settings.images.title")}
      lede={t("settings.images.lede")}
      aside={
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate("providers")}
        >
          <ImageIcon />
          {t("settings.images.configure")}
        </Button>
      }
    >
      {serving.length ? (
        <ul className="space-y-1 text-[13px]">
          {serving.map((provider) => (
            <li key={provider.id} className="flex flex-wrap gap-x-2">
              <span>{provider.name}</span>
              <span className="font-mono text-[12px] break-all text-muted-foreground">
                {provider.imageEndpoint}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t("settings.images.none")}
        </p>
      )}
    </Card>
  );
}

/** The gateway's optional features (docs/gateway-features.md); changes apply to the next request. */
export function GatewayFeaturesPage({ tabs }: { tabs: React.ReactNode }) {
  const load = useCallback(async () => {
    const client = modelPlane();
    const [features, providers, presets, groups, autoGroups] =
      await Promise.all([
        client.gatewayFeatures.get(),
        client.providers.list(),
        client.presets.list(),
        client.routeGroups.list(),
        client.autoGroups.list(),
      ]);
    return {
      features,
      providers: providers.items,
      models: gatewayModels(
        providers.items,
        presets.items,
        groups.items,
        autoGroups.items,
      ),
    };
  }, []);
  const [data, reload] = useLoaded(load);
  const [features, setFeatures] = useState<GatewayFeaturesView | null>(null);
  return (
    <div className="page-body">
      <div className="page-column max-w-[880px]">
        {tabs}
        <PageHeader
          title={t("settings.features.title")}
          lede={t("settings.features.lede")}
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
            onClick={() => {
              setFeatures(null);
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
              aria-label={t("common.loading")}
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : data.state === "error" ? (
            <LoadError message={data.message} retry={reload} />
          ) : (
            <>
              <Redaction
                features={features ?? data.value.features}
                onChange={setFeatures}
              />
              <Vision
                features={features ?? data.value.features}
                models={data.value.models}
                onChange={setFeatures}
              />
              <WebSearch
                features={features ?? data.value.features}
                onChange={setFeatures}
              />
              <Images providers={data.value.providers} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
