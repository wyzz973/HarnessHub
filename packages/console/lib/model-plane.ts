// SPDX-License-Identifier: MIT
/**
 * Data access and presentation helpers of the model-plane pages. Requests go
 * through `@harnesshub/sdk` to the same-origin proxy, which adds the admin
 * token on the server; the browser never holds it.
 */
import {
  HarnessHubClient,
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

let client: HarnessHubClient | undefined;
/** The SDK client for this page's origin (browser only). */
export function modelPlane(): HarnessHubClient {
  client ??= new HarnessHubClient({
    url: new URL("/api/gateway/", window.location.origin),
  });
  return client;
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
export const endpointHints: Record<WireProtocol, string> = {
  chat: "官方 SDK 的基址，通常含 /v1，例如 https://api.openai.com/v1；不要包含 /chat/completions",
  responses:
    "官方 SDK 的基址，通常含 /v1，例如 https://api.openai.com/v1；不要包含 /responses",
  anthropic:
    "不含版本段，例如 https://api.anthropic.com；网关会追加 /v1/messages",
  gemini:
    "不含版本段，例如 https://generativelanguage.googleapis.com；网关会追加 /v1beta/models/…",
};
export const providerKinds: { id: ProviderConfig["kind"]; label: string }[] = [
  { id: "vendor", label: "模型厂商" },
  { id: "relay", label: "中转或聚合网关" },
  { id: "local", label: "本机服务" },
  { id: "custom", label: "自定义" },
];
export const apiKeyHeaders = [
  "authorization-bearer",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "query-key",
] as const;

/** Readable text for known error codes; anything else shows the daemon's detail. */
const codeText: Record<string, string> = {
  PROVIDER_EXISTS: "已有同名 provider",
  PROVIDER_INVALID: "provider 配置不正确",
  PROVIDER_IN_USE: "仍有路由组或 Gateway Key 引用此 provider",
  PROVIDER_NOT_FOUND: "provider 不存在",
  CREDENTIAL_EXISTS: "已有同 ID 的凭据",
  CREDENTIAL_INVALID: "凭据不正确",
  CREDENTIAL_NOT_MANAGED: "只有由 HarnessHub 保存的凭据可以在这里轮换",
  CREDENTIAL_NOT_FOUND: "凭据不存在",
  INVALID_SECRET: "密钥必须是非空的单行文本，最长 8 KiB",
  ROUTE_GROUP_EXISTS: "已有同名路由组",
  ROUTE_GROUP_INVALID: "路由组配置不正确",
  ROUTE_GROUP_IN_USE: "仍有 Gateway Key 允许使用此路由组",
  ROUTE_GROUP_NOT_FOUND: "路由组不存在",
  GATEWAY_KEY_INVALID: "Key 设置不正确",
  GATEWAY_KEY_NOT_FOUND: "Key 不存在",
  INVALID_REQUEST: "输入不符合接口要求",
  ADMIN_TOKEN_UNAVAILABLE:
    "控制台无法读取守护进程的管理令牌，请用 pnpm start:local 启动或设置 HARNESSHUB_DATA_DIR",
  ADMIN_TOKEN_INVALID: "管理令牌与正在运行的守护进程不符，请重启控制台",
  GATEWAY_UNAVAILABLE: "暂时无法连接守护进程，请确认它已启动",
};

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
      message: codeText[problem.code] ?? problem.detail ?? problem.title,
      code: problem.code,
      fields,
      references: problem.references ?? [],
    };
  }
  if (reason instanceof HarnessHubUnavailableError)
    return {
      message: "暂时无法连接控制台服务",
      fields: {},
      references: [],
    };
  return {
    message: reason instanceof Error ? reason.message : "操作失败",
    fields: {},
    references: [],
  };
}

export const referenceNames: Record<string, string> = {
  "route-group": "路由组",
  "gateway-key": "Gateway Key",
};

/** The editable fields of a provider form. */
export interface ProviderForm {
  id: string;
  name: string;
  kind: ProviderConfig["kind"];
  apiKeyHeader: string;
  endpoints: Record<WireProtocol, string>;
  /** One model ID per line. */
  models: string;
  /** "all", or the model IDs that appear in /v1/models and agent pickers. */
  expose: "all" | string[];
}

export function emptyProviderForm(): ProviderForm {
  return {
    id: "",
    name: "",
    kind: "vendor",
    apiKeyHeader: "authorization-bearer",
    endpoints: { chat: "", responses: "", anthropic: "", gemini: "" },
    models: "",
    expose: "all",
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
    models: provider.models.list.map((model) => model.id).join("\n"),
    expose: provider.models.expose,
  };
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
  return {
    id: form.id.trim(),
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    kind: form.kind,
    auth: { apiKeyHeader: form.apiKeyHeader as "authorization-bearer" },
    endpoints,
    ...(models.list.length ? { models } : {}),
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
  return {
    name: form.name.trim() || previous.id,
    kind: form.kind,
    auth: { apiKeyHeader: form.apiKeyHeader as "authorization-bearer" },
    endpoints: endpoints as ProviderPatch["endpoints"],
    models: modelsOf(form, previous),
  };
}

export const expiryChoices = [
  { id: "30d", label: "30 天", days: 30 },
  { id: "90d", label: "90 天（默认）", days: 90 },
  { id: "365d", label: "1 年", days: 365 },
  { id: "never", label: "永不过期", days: null },
] as const;
export type ExpiryChoice = (typeof expiryChoices)[number]["id"];

/** `expiresAt` for a choice: an RFC 3339 time, or null for never. */
export function expiresAtFor(choice: ExpiryChoice, now: number): string | null {
  const found = expiryChoices.find((item) => item.id === choice);
  const days = found === undefined ? 90 : found.days;
  return days === null ? null : new Date(now + days * 86_400_000).toISOString();
}

/** Model Ref choices from providers: `provider/*` and every listed model. */
export function modelRefChoices(providers: ProviderConfig[]) {
  return providers.map((provider) => ({
    provider: provider.id,
    refs: provider.models.list.map((model) => `${provider.id}/${model.id}`),
  }));
}

/** `0.3000001` → `$0.3000001`; amounts stay decimal strings, as the API sends them. */
export function usd(amount: string): string {
  return `$${amount}`;
}

export const usageRanges = [
  { id: "24h", label: "24 小时", ms: 86_400_000 },
  { id: "7d", label: "7 天", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 天", ms: 30 * 86_400_000 },
  { id: "all", label: "全部", ms: null },
] as const;
export type UsageRange = (typeof usageRanges)[number]["id"];

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
export const sourceNames: Record<MetadataSource, string> = {
  override: "模型覆盖",
  "override-provider": "provider 级覆盖（provider/*）",
  provider: "provider 配置中手工填写",
  live: "上游模型列表",
  preset: "provider 预设",
  catalog: "models.dev 目录快照",
};

/** Tooltip of one value: its source and when the source produced it. */
export function sourceNote(field: ResolvedField | undefined): string {
  if (!field) return "未知：没有来源提供此值，不会按默认值估计";
  const at =
    field.at === undefined
      ? ""
      : field.at.includes("T")
        ? `，${new Date(field.at).toLocaleString()}`
        : `，核对于 ${field.at}`;
  return `来源：${sourceNames[field.source]}${at}`;
}

/** Context, output and price cells of one model, with their tooltips. */
export function modelMetadataCells(metadata: ModelMetadataView | undefined) {
  const fields = metadata?.fields ?? {};
  const tokens = (field: ResolvedField | undefined) =>
    typeof field?.value === "number" ? field.value.toLocaleString() : "—";
  const price = (field: ResolvedField | undefined) =>
    typeof field?.value === "number" ? `$${field.value}` : "?";
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
      note: `输入：${sourceNote(input)}\n输出：${sourceNote(output)}`,
    },
  };
}
