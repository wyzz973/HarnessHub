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
import {
  expiresAtFor,
  expiryChoices,
  failureOf,
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
  if (key.revokedAt) return { label: "已吊销", tone: "" };
  if (key.expiresAt && Date.parse(key.expiresAt) <= now)
    return { label: "已过期", tone: "warn" };
  return { label: "可用", tone: "good" };
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
        <DialogTitle>已创建 {created.gatewayKey.name}</DialogTitle>
        <DialogDescription>
          复制后交给使用它的脚本或工具，调用网关时作为 API Key 发送。
        </DialogDescription>
      </DialogHeader>
      <div className="callout warn items-start">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        这是唯一一次显示 Key。关闭后无法再次查看，只能吊销后重新创建。
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
          aria-label="复制 Key"
          onClick={() => {
            void navigator.clipboard.writeText(created.key).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>我已保存</Button>
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
        await modelPlane().gatewayKeys.create({
          name: name.trim(),
          modelAllow,
          expiresAt: expiresAtFor(expiry, Date.now()),
          ...(quota.quota ? { quota: quota.quota } : {}),
        }),
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
              <DialogTitle>创建 Gateway Key</DialogTitle>
              <DialogDescription>
                client 作用域的 Key，供脚本、IDE
                与其他工具调用网关；只能使用允许的模型。
              </DialogDescription>
            </DialogHeader>
            <label className="field-label">
              名称
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
                允许的模型（至少一个）
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
                        该 provider 的全部模型
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
                    还没有 provider，可以在下方直接填写 Model Ref。
                  </p>
                ) : null}
              </div>
            </fieldset>
            <label className="field-label">
              其他 Model Ref（可选）
              <input
                className="field font-mono text-[13px]"
                value={extra}
                placeholder="provider/model，以空格或逗号分隔"
                spellCheck={false}
                onChange={(event) => setExtra(event.target.value)}
              />
              <FieldError failure={failure} pointer="/modelAllow" />
            </label>
            <label className="field-label">
              有效期
              <select
                className="field"
                value={expiry}
                onChange={(event) =>
                  setExpiry(event.target.value as ExpiryChoice)
                }
              >
                {expiryChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <FieldError failure={failure} pointer="/expiresAt" />
            </label>
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
                取消
              </Button>
              <Button
                disabled={busy || !name.trim() || !modelAllow.length}
                onClick={() => void create()}
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                创建
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
          title="Gateway Key"
          lede="调用网关的凭据；本机来源同样需要 Key。Key 文本只在创建时显示一次。"
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
            onClick={() => setCreating(true)}
          >
            <Plus />
            创建 Key
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
                    <th>名称</th>
                    <th>作用域</th>
                    <th>允许的模型</th>
                    <th>额度</th>
                    <th>过期</th>
                    <th>最近使用</th>
                    <th>状态</th>
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
                            <span className="text-subtle">不限</span>
                          )}
                        </td>
                        <td className="text-[12.5px]">
                          {key.expiresAt ? (
                            <LocalTime value={key.expiresAt} />
                          ) : (
                            "永不"
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
                              aria-label={`${key.name} 的用量`}
                              title="用量"
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
                                aria-label={`${key.name} 的额度`}
                                title="额度"
                                onClick={() => setQuotaOfKey(key)}
                              >
                                <Gauge />
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => setRevoking(key)}
                              >
                                吊销
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
            <EmptyState icon={KeyRound} title="还没有 Gateway Key">
              为脚本、IDE 或其他工具创建一个 client Key。
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
          title={`吊销 ${revoking?.name ?? ""}`}
          description="吊销后新请求立即被拒绝，无法撤销。"
          action="吊销"
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
