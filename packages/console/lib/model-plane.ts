// SPDX-License-Identifier: MIT
/**
 * Data access and presentation helpers of the model-plane pages. Requests go
 * through `@harnesshub/sdk` to the daemon that serves the page, with the
 * console session (lib/session.ts); the browser never holds the admin token.
 */
import {
  type GatewayKeyInput,
  type GatewayKeyQuota,
  type HarnessHubClient,
  HarnessHubError,
  HarnessHubUnavailableError,
  type ProviderConfig,
  type ProviderInput,
  type MetadataSource,
  type ModelMetadataView,
  type ProviderPatch,
  type ResolvedField,
  type WireProtocol,
} from "@harnesshub/sdk/client";
import {
  formatDateTime,
  formatNumber,
  formatUsd,
  isMessageKey,
  t,
  translate,
} from "./i18n";
import { apiClient } from "./session";

/** The SDK client of the signed-in console session (browser only). */
export function modelPlane(): HarnessHubClient {
  return apiClient();
}

export const protocols: readonly WireProtocol[] = [
  "chat",
  "responses",
  "anthropic",
  "gemini",
];
export const protocolNames: Record<WireProtocol, string> = {
  chat: "OpenAI Chat",
  responses: "OpenAI Responses",
  anthropic: "Anthropic Messages",
  gemini: "Gemini",
};
/** The base-URL convention of each endpoint, shown under its field. */
export function endpointHint(protocol: WireProtocol): string {
  return t(`common.endpointHint.${protocol}`);
}
export const providerKinds: readonly ProviderConfig["kind"][] = [
  "vendor",
  "relay",
  "local",
  "custom",
];
export function kindName(kind: ProviderConfig["kind"]): string {
  return t(`common.kind.${kind}`);
}
export const apiKeyHeaders = [
  "authorization-bearer",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "query-key",
] as const;

/** Readable text for known error codes; anything else shows the daemon's detail. */
function codeText(code: string): string | undefined {
  const key = `common.code.${code}`;
  return isMessageKey(key) ? translate(key) : undefined;
}

/** An API failure prepared for a form: one message, field errors by JSON Pointer, blocking references. */
export interface Failure {
  message: string;
  code?: string;
  fields: Record<string, string>;
  references: Array<{ type: string; id: string }>;
}

export function failureOf(reason: unknown): Failure {
  if (reason instanceof HarnessHubError) {
    const problem = reason.problem;
    const fields: Record<string, string> = {};
    for (const item of problem.errors ?? []) {
      const key = item.pointer ?? item.parameter;
      if (key !== undefined && !(key in fields)) fields[key] = item.detail;
    }
    return {
      message: codeText(problem.code) ?? problem.detail ?? problem.title,
      code: problem.code,
      fields,
      references: problem.references ?? [],
    };
  }
  if (reason instanceof HarnessHubUnavailableError)
    return {
      message: t("common.unavailable"),
      fields: {},
      references: [],
    };
  return {
    message:
      reason instanceof Error ? reason.message : t("common.actionFailed"),
    fields: {},
    references: [],
  };
}

/** The name of a kind of record that blocks a change; unknown kinds show as sent. */
export function referenceName(type: string): string {
  const key = `common.reference.${type}`;
  return isMessageKey(key) ? translate(key) : type;
}

/** Whose proxy a provider's requests take: the daemon's (`network.proxy`), none, or its own. */
export type ProxyMode = "daemon" | "direct" | "url";
export const proxyModes: readonly ProxyMode[] = ["daemon", "direct", "url"];

/** The editable fields of a provider form. */
export interface ProviderForm {
  id: string;
  name: string;
  kind: ProviderConfig["kind"];
  apiKeyHeader: string;
  endpoints: Record<WireProtocol, string>;
  /** Base URL of an OpenAI-compatible Images API; empty for none. */
  imageEndpoint: string;
  /** One model ID per line. */
  models: string;
  /** "all", or the model IDs that appear in /v1/models and agent pickers. */
  expose: "all" | string[];
  proxy: ProxyMode;
  /** The provider's own proxy address, sent as typed when `proxy` is "url". */
  proxyUrl: string;
}

export function emptyProviderForm(): ProviderForm {
  return {
    id: "",
    name: "",
    kind: "vendor",
    apiKeyHeader: "authorization-bearer",
    endpoints: { chat: "", responses: "", anthropic: "", gemini: "" },
    imageEndpoint: "",
    models: "",
    expose: "all",
    proxy: "daemon",
    proxyUrl: "",
  };
}

export function providerFormOf(provider: ProviderConfig): ProviderForm {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    apiKeyHeader: provider.auth.apiKeyHeader,
    endpoints: {
      chat: provider.endpoints.chat ?? "",
      responses: provider.endpoints.responses ?? "",
      anthropic: provider.endpoints.anthropic ?? "",
      gemini: provider.endpoints.gemini ?? "",
    },
    imageEndpoint: provider.imageEndpoint ?? "",
    models: provider.models.list.map((model) => model.id).join("\n"),
    expose: provider.models.expose,
    proxy:
      provider.proxy === undefined
        ? "daemon"
        : provider.proxy === "direct"
          ? "direct"
          : "url",
    proxyUrl:
      provider.proxy === undefined || provider.proxy === "direct"
        ? ""
        : provider.proxy,
  };
}

/** The `proxy` field of a form: absent for the daemon's; the daemon checks an address. */
function proxyOf(form: ProviderForm): string | undefined {
  switch (form.proxy) {
    case "daemon":
      return undefined;
    case "direct":
      return "direct";
    case "url":
      return form.proxyUrl.trim();
  }
}

/** How a provider's proxy reads on its page. */
export function proxyText(provider: ProviderConfig): string {
  if (provider.proxy === undefined) return t("providers.proxy.daemon");
  if (provider.proxy === "direct") return t("providers.proxy.direct");
  return provider.proxy;
}

/** Unique, trimmed model IDs, one per line. */
export function modelIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function modelsOf(form: ProviderForm, previous?: ProviderConfig) {
  const ids = modelIds(form.models);
  const known = new Map(
    (previous?.models.list ?? []).map((model) => [model.id, model]),
  );
  return {
    // Metadata of kept models (prices, windows) is preserved.
    source: previous?.models.source ?? ("manual" as const),
    list: ids.map((id) => known.get(id) ?? { id }),
    expose:
      form.expose === "all"
        ? ("all" as const)
        : form.expose.filter((id) => ids.includes(id)),
  };
}

/** `POST /providers` body; empty endpoints are left out. */
export function providerInput(form: ProviderForm): ProviderInput {
  const endpoints = Object.fromEntries(
    protocols
      .map((protocol) => [protocol, form.endpoints[protocol].trim()] as const)
      .filter(([, url]) => url),
  );
  const models = modelsOf(form);
  const proxy = proxyOf(form);
  return {
    id: form.id.trim(),
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    kind: form.kind,
    auth: { apiKeyHeader: form.apiKeyHeader as "authorization-bearer" },
    endpoints,
    ...(form.imageEndpoint.trim()
      ? { imageEndpoint: form.imageEndpoint.trim() }
      : {}),
    ...(models.list.length ? { models } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
  };
}

/** `PATCH /providers/{id}` merge patch from the edited form: a cleared endpoint becomes null. */
export function providerPatch(
  form: ProviderForm,
  previous: ProviderConfig,
): ProviderPatch {
  const endpoints: Record<string, string | null> = {};
  for (const protocol of protocols) {
    const url = form.endpoints[protocol].trim();
    if (url) endpoints[protocol] = url;
    else if (previous.endpoints[protocol] !== undefined)
      endpoints[protocol] = null;
  }
  const proxy = proxyOf(form);
  return {
    name: form.name.trim() || previous.id,
    kind: form.kind,
    auth: { apiKeyHeader: form.apiKeyHeader as "authorization-bearer" },
    endpoints: endpoints as ProviderPatch["endpoints"],
    ...(form.imageEndpoint.trim()
      ? { imageEndpoint: form.imageEndpoint.trim() }
      : previous.imageEndpoint !== undefined
        ? { imageEndpoint: null }
        : {}),
    models: modelsOf(form, previous),
    ...(proxy !== undefined
      ? { proxy }
      : previous.proxy !== undefined
        ? { proxy: null }
        : {}),
  };
}

export const expiryChoices = [
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
  { id: "365d", days: 365 },
  { id: "never", days: null },
] as const;
export type ExpiryChoice = (typeof expiryChoices)[number]["id"];
export function expiryLabel(choice: ExpiryChoice): string {
  return t(`common.expiry.${choice}`);
}

/** `expiresAt` for a choice: an RFC 3339 time, or null for never. */
export function expiresAtFor(choice: ExpiryChoice, now: number): string | null {
  const found = expiryChoices.find((item) => item.id === choice);
  const days = found === undefined ? 90 : found.days;
  return days === null ? null : new Date(now + days * 86_400_000).toISOString();
}

/** Whether the key form offers an expiry choice: a LAN key must expire. */
export function expiryAllowed(
  choice: ExpiryChoice,
  allowLan: boolean,
): boolean {
  return !(allowLan && choice === "never");
}

/** The key form's fields; `quota` is already checked (lib/routing.ts). */
export interface KeyForm {
  name: string;
  modelAllow: string[];
  expiry: ExpiryChoice;
  quota?: GatewayKeyQuota;
  /** Usable through LAN sharing, as `hh key create --lan`. */
  allowLan: boolean;
}

/** The body of `POST /gateway-keys` for the key form. */
export function keyCreateInput(form: KeyForm, now: number): GatewayKeyInput {
  return {
    name: form.name.trim(),
    modelAllow: form.modelAllow,
    expiresAt: expiresAtFor(form.expiry, now),
    ...(form.quota ? { quota: form.quota } : {}),
    ...(form.allowLan ? { allowLan: true } : {}),
  };
}

/** Model Ref choices from providers: `provider/*` and every listed model. */
export function modelRefChoices(providers: ProviderConfig[]) {
  return providers.map((provider) => ({
    provider: provider.id,
    refs: provider.models.list.map((model) => `${provider.id}/${model.id}`),
  }));
}

/** A USD amount as the API sends it (a decimal string), in the locale's currency format. */
export function usd(amount: string): string {
  return formatUsd(amount);
}

export const usageRanges = [
  { id: "24h", ms: 86_400_000 },
  { id: "7d", ms: 7 * 86_400_000 },
  { id: "30d", ms: 30 * 86_400_000 },
  { id: "all", ms: null },
] as const;
export type UsageRange = (typeof usageRanges)[number]["id"];
export function rangeLabel(range: UsageRange): string {
  return t(`common.range.${range}`);
}

/** The `from` filter of a range, or undefined for all time. */
export function rangeStart(range: UsageRange, now: number): string | undefined {
  const found = usageRanges.find((item) => item.id === range);
  const ms = found === undefined ? null : found.ms;
  return ms === null ? undefined : new Date(now - ms).toISOString();
}

/** Sum of decimal strings without floating-point drift (up to 10 decimals). */
export function addAmounts(amounts: string[]): string {
  const scale = 10_000_000_000n;
  let total = 0n;
  for (const amount of amounts) {
    const [whole = "0", fraction = ""] = amount.split(".");
    total +=
      BigInt(whole) * scale + BigInt(fraction.padEnd(10, "0").slice(0, 10));
  }
  const whole = total / scale;
  const fraction = (total % scale)
    .toString()
    .padStart(10, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Where a model's value came from (03-model-plane section 7). */
export function sourceName(source: MetadataSource): string {
  return t(`common.source.${source}`);
}

/** Tooltip of one value: its source and when the source produced it. */
export function sourceNote(field: ResolvedField | undefined): string {
  if (!field) return t("common.source.unknown");
  const source = sourceName(field.source);
  if (field.at === undefined) return t("common.source.note", { source });
  return field.at.includes("T")
    ? t("common.source.noteAt", { source, at: formatDateTime(field.at) })
    : t("common.source.noteChecked", { source, date: field.at });
}

/** Context, output and price cells of one model, with their tooltips. */
export function modelMetadataCells(metadata: ModelMetadataView | undefined) {
  const fields = metadata?.fields ?? {};
  const tokens = (field: ResolvedField | undefined) =>
    typeof field?.value === "number" ? formatNumber(field.value) : "—";
  const price = (field: ResolvedField | undefined) =>
    typeof field?.value === "number" ? formatUsd(field.value) : "?";
  const input = fields["price.input"];
  const output = fields["price.output"];
  return {
    context: {
      text: tokens(fields.contextWindow),
      note: sourceNote(fields.contextWindow),
    },
    output: {
      text: tokens(fields.maxOutputTokens),
      note: sourceNote(fields.maxOutputTokens),
    },
    price: {
      text: input || output ? `${price(input)} / ${price(output)}` : "—",
      note: t("common.source.priceNote", {
        input: sourceNote(input),
        output: sourceNote(output),
      }),
    },
  };
}
