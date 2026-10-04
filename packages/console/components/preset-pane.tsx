// SPDX-License-Identifier: MIT
import { useCallback, useMemo, useState } from "react";
import { ArrowLeftRight, Loader2, Search } from "lucide-react";
import type {
  ProviderConfig,
  ProviderPreset,
  WireProtocol,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { BrandIcon } from "@/components/brand-icon";
import {
  failureOf,
  modelPlane,
  protocolNames,
  protocols,
  providerKinds,
  type Failure,
} from "@/lib/model-plane";
import {
  ErrorCallout,
  FieldError,
  OtherFieldErrors,
  useLoaded,
} from "./model-plane-ui";

type Endpoints = Partial<Record<WireProtocol, string>>;

/** The endpoints a preset serves in a region with a plan (a plan's replace the region's). */
function presetEndpoints(
  preset: ProviderPreset,
  region: string,
  plan: string,
): Endpoints {
  const chosenPlan = preset.plans?.find((item) => item.id === plan);
  const chosenRegion = preset.regions?.find((item) => item.id === region);
  return chosenPlan?.endpoints ?? chosenRegion?.endpoints ?? preset.endpoints;
}

/** A searchable list of the presets, grouped by kind, each with its mark. */
function PresetList({
  presets,
  onChoose,
}: {
  presets: readonly ProviderPreset[];
  onChoose: (preset: ProviderPreset) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = presets.filter(
    (preset) =>
      !needle ||
      preset.name.toLowerCase().includes(needle) ||
      preset.id.includes(needle),
  );
  return (
    <div className="space-y-2">
      <label className="flex h-9 items-center gap-2 rounded-[10px] border px-3">
        <Search className="size-4 shrink-0 text-subtle" />
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-subtle"
          placeholder="搜索预设，例如 deepseek、openrouter"
          aria-label="搜索预设"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="max-h-[46vh] overflow-y-auto rounded-xl border p-1.5">
        {providerKinds.map((kind) => {
          const items = matches.filter((preset) => preset.kind === kind.id);
          if (!items.length) return null;
          return (
            <div key={kind.id} role="group" aria-label={kind.label}>
              <p className="px-2 pt-2 pb-1 text-[12px] text-subtle">
                {kind.label}
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                {items.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="flex min-h-11 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-accent"
                    onClick={() => onChoose(preset)}
                  >
                    <BrandIcon
                      slug={preset.icon}
                      name={preset.name}
                      className="size-7"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">
                        {preset.name}
                      </span>
                      <span className="block truncate font-mono text-[11.5px] text-subtle">
                        {preset.id}
                        {preset.regions
                          ? ` · ${preset.regions.length} 个区域`
                          : ""}
                        {preset.plans ? ` · ${preset.plans.length} 种套餐` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!matches.length ? (
          <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
            没有匹配的预设，可以改用“手动填写”。
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Create a provider from a shipped preset: its region and plan, the headers
 * its vendor documents, edited endpoints and optionally its first key.
 */
export function PresetPane({
  onSaved,
  onCancel,
  onBusy,
  cancelLabel = "取消",
  submitLabel = "创建",
}: {
  onSaved: (saved: ProviderConfig) => void;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
  cancelLabel?: string;
  submitLabel?: string;
}) {
  const load = useCallback(
    async () => (await modelPlane().presets.list()).items,
    [],
  );
  const [presets] = useLoaded(load);
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [region, setRegion] = useState("");
  const [plan, setPlan] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoints>({});
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const defaults = useMemo(
    () => (preset ? presetEndpoints(preset, region, plan) : {}),
    [preset, region, plan],
  );
  function choose(next: ProviderPreset) {
    const firstRegion = next.regions?.[0]?.id ?? "";
    const firstPlan = next.plans?.[0]?.id ?? "";
    setPreset(next);
    setRegion(firstRegion);
    setPlan(firstPlan);
    setId("");
    setName("");
    setKey("");
    setHeaders({});
    setFailure(null);
    setEndpoints({ ...presetEndpoints(next, firstRegion, firstPlan) });
  }
  function chooseVariant(nextRegion: string, nextPlan: string) {
    if (!preset) return;
    setRegion(nextRegion);
    setPlan(nextPlan);
    setEndpoints({ ...presetEndpoints(preset, nextRegion, nextPlan) });
  }
  const hints = preset?.headerHints ?? [];
  const missingHeader = hints.some(
    (hint) => hint.required && !headers[hint.name]?.trim(),
  );
  const chosenPlan = preset?.plans?.find((item) => item.id === plan);
  const chosenRegion = preset?.regions?.find((item) => item.id === region);
  const keysUrl =
    chosenPlan?.keysUrl ?? chosenRegion?.keysUrl ?? preset?.keysUrl;
  async function save() {
    if (!preset) return;
    setBusy(true);
    onBusy(true);
    setFailure(null);
    // Only edited endpoints are sent; the rest come from the preset's region and plan.
    const changed = Object.fromEntries(
      protocols
        .map(
          (protocol) => [protocol, endpoints[protocol]?.trim() ?? ""] as const,
        )
        .filter(([protocol, url]) => url && url !== defaults[protocol]),
    );
    const headerValues = Object.fromEntries(
      Object.entries(headers)
        .map(([header, value]) => [header, value.trim()] as const)
        .filter(([, value]) => value),
    );
    try {
      const created = await modelPlane().providers.create({
        preset: preset.id,
        ...(region ? { region } : {}),
        ...(plan ? { plan } : {}),
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(Object.keys(changed).length ? { endpoints: changed } : {}),
        ...(Object.keys(headerValues).length ? { headers: headerValues } : {}),
        ...(key ? { credential: { value: key } } : {}),
      });
      setKey("");
      onSaved(created);
    } catch (reason) {
      setFailure(failureOf(reason));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  if (!preset)
    return (
      <>
        {presets.state === "ready" ? (
          <PresetList presets={presets.value} onChoose={choose} />
        ) : presets.state === "error" ? (
          <p className="callout error">读取预设失败：{presets.message}</p>
        ) : (
          <p className="text-[13px] text-muted-foreground" role="status">
            正在读取预设…
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
        </DialogFooter>
      </>
    );
  return (
    <>
      <div className="flex items-center gap-3 rounded-xl border p-3">
        <BrandIcon slug={preset.icon} name={preset.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{preset.name}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-subtle">
            <span className="font-mono">{preset.id}</span>
            {preset.verified === "unverified" ? (
              <span className="text-warning">端点未核对</span>
            ) : (
              <span>已按文档核对 {preset.verified}</span>
            )}
            {preset.website ? (
              <a
                className="text-brand hover:underline"
                href={preset.website}
                target="_blank"
                rel="noopener noreferrer"
              >
                官网
              </a>
            ) : null}
            {keysUrl ? (
              <a
                className="text-brand hover:underline"
                href={keysUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                获取 API Key
              </a>
            ) : null}
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => setPreset(null)}
        >
          <ArrowLeftRight />
          更换
        </Button>
      </div>
      {preset.notes ? <p className="callout neutral">{preset.notes}</p> : null}
      {preset.regions || preset.plans ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {preset.regions ? (
            <label className="field-label">
              区域
              <select
                className="field"
                value={region}
                onChange={(event) => chooseVariant(event.target.value, plan)}
              >
                {preset.regions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {chosenRegion?.notes ? (
                <span className="field-hint">{chosenRegion.notes}</span>
              ) : null}
              <FieldError failure={failure} pointer="/region" />
            </label>
          ) : null}
          {preset.plans ? (
            <label className="field-label">
              套餐
              <select
                className="field"
                value={plan}
                onChange={(event) => chooseVariant(region, event.target.value)}
              >
                {preset.plans.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {chosenPlan?.notes ? (
                <span className="field-hint">{chosenPlan.notes}</span>
              ) : null}
              <FieldError failure={failure} pointer="/plan" />
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field-label">
          ID
          <input
            className="field font-mono text-[13px]"
            value={id}
            placeholder={preset.id}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setId(event.target.value)}
          />
          <FieldError failure={failure} pointer="/id" />
        </label>
        <label className="field-label">
          名称
          <input
            className="field"
            value={name}
            placeholder={preset.name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </div>
      {preset.userEndpoint ? (
        <p className="callout warn">
          这个预设的地址因人而异（例如 Azure
          资源或另一台电脑），请把下面的地址改成你自己的。
        </p>
      ) : null}
      {protocols
        .filter((protocol) => defaults[protocol] !== undefined)
        .map((protocol) => (
          <label key={protocol} className="field-label">
            {protocolNames[protocol]}
            <input
              className="field font-mono text-[13px]"
              value={endpoints[protocol] ?? ""}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                setEndpoints((current) => ({
                  ...current,
                  [protocol]: event.target.value,
                }))
              }
            />
            <FieldError failure={failure} pointer={`/endpoints/${protocol}`} />
          </label>
        ))}
      {hints.map((hint) => (
        <label key={hint.name} className="field-label">
          请求头 <span className="font-mono">{hint.name}</span>
          {hint.required ? (
            <span className="text-danger">（必填）</span>
          ) : (
            <span className="text-subtle">（可选）</span>
          )}
          <input
            className="field font-mono text-[13px]"
            value={headers[hint.name] ?? ""}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={hint.required && !headers[hint.name]?.trim()}
            onChange={(event) =>
              setHeaders((current) => ({
                ...current,
                [hint.name]: event.target.value,
              }))
            }
          />
          {hint.notes ? <span className="field-hint">{hint.notes}</span> : null}
        </label>
      ))}
      {preset.auth.methods.includes("api-key") ? (
        <label className="field-label">
          API Key
          {preset.auth.methods.includes("none") ? (
            <span className="text-subtle">（本机服务可以留空）</span>
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
            只发送一次，保存在守护进程的秘密存储中；也可以稍后在凭据中添加。
          </span>
          <FieldError failure={failure} pointer="/credential/value" />
        </label>
      ) : null}
      <ErrorCallout failure={failure} />
      <OtherFieldErrors
        failure={failure}
        shown={[
          "/preset",
          "/region",
          "/plan",
          "/id",
          "/credential/value",
          ...protocols.map((protocol) => `/endpoints/${protocol}`),
        ]}
      />
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button disabled={busy || missingHeader} onClick={() => void save()}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
