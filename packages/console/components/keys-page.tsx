// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  Check,
  ChartNoAxesColumn,
  Copy,
  Gauge,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  CreatedGatewayKey,
  GatewayKeyView,
  ProviderConfig,
  RouteGroup,
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
import { t } from "@/lib/i18n";
import {
  expiryAllowed,
  expiryChoices,
  expiryLabel,
  failureOf,
  keyCreateInput,
  modelPlane,
  modelRefChoices,
  type ExpiryChoice,
  type Failure,
} from "@/lib/model-plane";
import { quotaFormOf, quotaOf, quotaSummary } from "@/lib/routing";
import { LimitDialog, QuotaDialog, QuotaFields } from "./key-budgets";
import {
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  FieldError,
  LocalTime,
  OtherFieldErrors,
  PageHeader,
  useLoaded,
  EmptyState,
  LoadError,
} from "./model-plane-ui";

function keyState(key: GatewayKeyView, now: number) {
  if (key.revokedAt) return { label: t("routing.key.revoked"), tone: "" };
  if (key.expiresAt && Date.parse(key.expiresAt) <= now)
    return { label: t("routing.key.expired"), tone: "warn" };
  return { label: t("routing.key.active"), tone: "good" };
}

/** The new key's text, shown once with a copy button. */
function CreatedKey({
  created,
  onDone,
}: {
  created: CreatedGatewayKey;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t("routing.key.createdTitle", { name: created.gatewayKey.name })}
        </DialogTitle>
        <DialogDescription>{t("routing.key.createdLede")}</DialogDescription>
      </DialogHeader>
      <div className="callout warn items-start">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        {t("routing.key.shownOnce")}
      </div>
      <div className="flex items-center gap-2">
        <input
          className="field mt-0 font-mono text-[12.5px]"
          value={created.key}
          readOnly
          aria-label="Gateway Key"
          onFocus={(event) => event.target.select()}
        />
        <Button
          variant="outline"
          aria-label={t("routing.key.copyLabel")}
          onClick={() => {
            void navigator.clipboard.writeText(created.key).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("routing.key.copied") : t("routing.key.copy")}
        </Button>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>{t("routing.key.saved")}</Button>
      </DialogFooter>
    </>
  );
}

function CreateKeyDialog({
  providers,
  groups,
  onClose,
  onCreated,
}: {
  providers: ProviderConfig[];
  groups: RouteGroup[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [allow, setAllow] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("90d");
  const [allowLan, setAllowLan] = useState(false);
  const [quotaForm, setQuotaForm] = useState(() => quotaFormOf(undefined));
  const [quotaProblems, setQuotaProblems] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [created, setCreated] = useState<CreatedGatewayKey | null>(null);
  const toggle = (ref: string, on: boolean) =>
    setAllow((current) =>
      on ? [...current, ref] : current.filter((item) => item !== ref),
    );
  const typed = extra
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const modelAllow = [...new Set([...allow, ...typed])];
  async function create() {
    const quota = quotaOf(quotaForm);
    if (!quota.ok) {
      setQuotaProblems(quota.problems);
      return;
    }
    setQuotaProblems({});
    setBusy(true);
    setFailure(null);
    try {
      setCreated(
        await modelPlane().gatewayKeys.create(
          keyCreateInput(
            {
              name,
              modelAllow,
              expiry,
              allowLan,
              ...(quota.quota ? { quota: quota.quota } : {}),
            },
            Date.now(),
          ),
        ),
      );
      onCreated();
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
        // The key text is gone once the dialog closes; only an explicit button closes it.
        if (!next && !busy && !created) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[560px]">
        {created ? (
          <CreatedKey created={created} onDone={onClose} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("routing.key.createTitle")}</DialogTitle>
              <DialogDescription>
                {t("routing.key.createLede")}
              </DialogDescription>
            </DialogHeader>
            <label className="field-label">
              {t("routing.key.name")}
              <input
                className="field"
                value={name}
                placeholder="ci"
                autoFocus
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
              <FieldError failure={failure} pointer="/name" />
            </label>
            <fieldset>
              <legend className="field-label mb-1">
                {t("routing.key.allowLegend")}
              </legend>
              <div className="max-h-[34vh] space-y-2 overflow-y-auto rounded-xl border p-2">
                {modelRefChoices(providers).map((choice) => (
                  <div key={choice.provider}>
                    <Checkbox
                      checked={allow.includes(`${choice.provider}/*`)}
                      onChange={(on) => toggle(`${choice.provider}/*`, on)}
                    >
                      <span className="font-mono text-[12.5px]">
                        {choice.provider}/*
                      </span>
                      <span className="ml-2 text-[12px] text-subtle">
                        {t("routing.key.allProviderModels")}
                      </span>
                    </Checkbox>
                    {choice.refs.map((ref) => (
                      <div key={ref} className="pl-6">
                        <Checkbox
                          checked={allow.includes(ref)}
                          disabled={allow.includes(`${choice.provider}/*`)}
                          onChange={(on) => toggle(ref, on)}
                        >
                          <span className="font-mono text-[12.5px]">{ref}</span>
                        </Checkbox>
                      </div>
                    ))}
                  </div>
                ))}
                {groups.map((group) => (
                  <Checkbox
                    key={group.id}
                    checked={allow.includes(`group/${group.id}`)}
                    onChange={(on) => toggle(`group/${group.id}`, on)}
                  >
                    <span className="font-mono text-[12.5px]">
                      group/{group.id}
                    </span>
                  </Checkbox>
                ))}
                {!providers.length && !groups.length ? (
                  <p className="px-2 py-3 text-[13px] text-muted-foreground">
                    {t("routing.key.noProviders")}
                  </p>
                ) : null}
              </div>
            </fieldset>
            <label className="field-label">
              {t("routing.key.extra")}
              <input
                className="field font-mono text-[13px]"
                value={extra}
                placeholder={t("routing.key.extraPlaceholder")}
                spellCheck={false}
                onChange={(event) => setExtra(event.target.value)}
              />
              <FieldError failure={failure} pointer="/modelAllow" />
            </label>
            <label className="field-label">
              {t("routing.key.expiry")}
              <select
                className="field"
                value={expiry}
                onChange={(event) =>
                  setExpiry(event.target.value as ExpiryChoice)
                }
              >
                {expiryChoices.map((choice) => (
                  <option
                    key={choice.id}
                    value={choice.id}
                    disabled={!expiryAllowed(choice.id, allowLan)}
                  >
                    {expiryLabel(choice.id)}
                  </option>
                ))}
              </select>
              <FieldError failure={failure} pointer="/expiresAt" />
            </label>
            <div className="space-y-2">
              <Checkbox
                checked={allowLan}
                onChange={(on) => {
                  setAllowLan(on);
                  if (!expiryAllowed(expiry, on)) setExpiry("90d");
                }}
              >
                {t("routing.key.lan")}
              </Checkbox>
              <p className="field-hint">{t("routing.key.lanHint")}</p>
              {allowLan ? (
                <div className="callout warn items-start">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  {t("routing.key.lanWarning")}
                </div>
              ) : null}
            </div>
            <QuotaFields
              form={quotaForm}
              onChange={setQuotaForm}
              problems={quotaProblems}
            />
            <ErrorCallout failure={failure} />
            <OtherFieldErrors
              failure={failure}
              shown={["/name", "/modelAllow", "/expiresAt"]}
            />
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                disabled={busy || !name.trim() || !modelAllow.length}
                onClick={() => void create()}
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                {t("routing.key.create")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** `client:` Gateway Keys (`/api/v1/gateway-keys`). */
export function KeysPage({ tabs }: { tabs?: React.ReactNode }) {
  const load = useCallback(async () => {
    const client = modelPlane();
    const [keys, providers, groups] = await Promise.all([
      client.gatewayKeys.list(),
      client.providers.list(),
      client.routeGroups.list(),
    ]);
    return {
      keys: keys.items,
      providers: providers.items,
      groups: groups.items,
    };
  }, []);
  const [data, reload] = useLoaded(load);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<GatewayKeyView | null>(null);
  const [quotaOfKey, setQuotaOfKey] = useState<GatewayKeyView | null>(null);
  const [limitOfKey, setLimitOfKey] = useState<GatewayKeyView | null>(null);
  const now = Date.now();
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        {tabs}
        <PageHeader
          title={t("routing.keys.title")}
          lede={t("routing.keys.lede")}
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
            onClick={() => setCreating(true)}
          >
            <Plus />
            {t("routing.keys.createButton")}
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
          ) : data.value.keys.length ? (
            <div className="panel overflow-x-auto">
              <table className="data-table min-w-[880px]">
                <thead>
                  <tr>
                    <th>{t("routing.key.name")}</th>
                    <th>{t("routing.keys.scope")}</th>
                    <th>{t("routing.keys.allowed")}</th>
                    <th>{t("routing.keys.limits")}</th>
                    <th>{t("routing.keys.expires")}</th>
                    <th>{t("routing.keys.lastUsed")}</th>
                    <th>{t("routing.status")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.value.keys.map((key) => {
                    const state = keyState(key, now);
                    return (
                      <tr key={key.keyId}>
                        <td>
                          <p className="font-medium">{key.name}</p>
                          <p className="font-mono text-[12px] text-subtle">
                            {key.keyId}
                          </p>
                        </td>
                        <td>
                          <span className="tag">{key.scope.kind}</span>
                          {key.allowLan ? (
                            <span className="tag warn ml-1">
                              {t("routing.keys.lan")}
                            </span>
                          ) : null}
                        </td>
                        <td className="max-w-[260px]">
                          <p
                            className="truncate font-mono text-[12px]"
                            title={key.modelAllow.join("\n")}
                          >
                            {key.modelAllow.join(", ")}
                          </p>
                        </td>
                        <td className="min-w-[170px] text-[12.5px]">
                          {key.quota ? (
                            quotaSummary(key.quota).map((line) => (
                              <span key={line} className="block">
                                {line}
                              </span>
                            ))
                          ) : (
                            <span className="text-subtle">
                              {t("routing.quota.noLimit")}
                            </span>
                          )}
                        </td>
                        <td className="text-[12.5px]">
                          {key.expiresAt ? (
                            <LocalTime value={key.expiresAt} />
                          ) : (
                            t("routing.keys.never")
                          )}
                        </td>
                        <td className="text-[12.5px] text-muted-foreground">
                          <LocalTime value={key.lastUsedAt} />
                        </td>
                        <td>
                          <span className={`tag ${state.tone}`}>
                            {state.label}
                          </span>
                        </td>
                        <td className="w-[200px] text-right whitespace-nowrap">
                          {key.quota ? (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t("routing.keys.usageOf", {
                                name: key.name,
                              })}
                              title={t("routing.keys.usage")}
                              onClick={() => setLimitOfKey(key)}
                            >
                              <ChartNoAxesColumn />
                            </Button>
                          ) : null}
                          {key.revokedAt ? null : (
                            <>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("routing.keys.limitsOf", {
                                  name: key.name,
                                })}
                                title={t("routing.keys.limits")}
                                onClick={() => setQuotaOfKey(key)}
                              >
                                <Gauge />
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setRevoking(key)}
                              >
                                {t("routing.keys.revoke")}
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={KeyRound} title={t("routing.keys.empty")}>
              {t("routing.keys.emptyHint")}
            </EmptyState>
          )}
        </div>
        {creating && data.state === "ready" ? (
          <CreateKeyDialog
            providers={data.value.providers}
            groups={data.value.groups}
            onClose={() => setCreating(false)}
            onCreated={reload}
          />
        ) : null}
        {quotaOfKey ? (
          <QuotaDialog
            key={quotaOfKey.keyId}
            gatewayKey={quotaOfKey}
            onClose={() => setQuotaOfKey(null)}
            onSaved={() => {
              setQuotaOfKey(null);
              reload();
            }}
          />
        ) : null}
        {limitOfKey ? (
          <LimitDialog
            key={limitOfKey.keyId}
            gatewayKey={limitOfKey}
            onClose={() => setLimitOfKey(null)}
          />
        ) : null}
        <ConfirmDialog
          open={revoking !== null}
          title={t("routing.keys.revokeTitle", { name: revoking?.name ?? "" })}
          description={t("routing.keys.revokeHint")}
          action={t("routing.keys.revoke")}
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            if (revoking) await modelPlane().gatewayKeys.revoke(revoking.keyId);
            reload();
          }}
        />
      </div>
    </div>
  );
}
