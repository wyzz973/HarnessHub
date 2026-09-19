import type { HarnessModelInput } from "./api";
import type { HarnessModelView } from "./contracts";
import type { SecretReference } from "./engine-configuration";

export const DEFAULT_ALIAS = "harnesshub-model";
export interface HeaderRow {
  key: string;
  name: string;
  /** New value typed by the user; a secret row with a reference and no value keeps that reference. */
  value: string;
  secret: boolean;
  reference?: SecretReference;
}
/** Editable state of the unified model form; numbers stay text until validation. */
export interface HarnessModelForm {
  model: string;
  alias: string;
  baseUrl: string;
  keyMode: "keep" | "new" | "env" | "none";
  keyReference?: SecretReference;
  newKey: string;
  envName: string;
  contextWindow: string;
  maxOutputTokens: string;
  headers: HeaderRow[];
  includeUsage: boolean;
  reasoning: "passthrough" | "strip";
  maxTokensField: "max_tokens" | "max_completion_tokens";
  dropParameters: string;
}
let rowSequence = 0;
export function headerRow(values: Partial<HeaderRow> = {}): HeaderRow {
  rowSequence += 1;
  return {
    key: `header-${rowSequence}`,
    name: "",
    value: "",
    secret: false,
    ...values,
  };
}
export function formFromView(view: HarnessModelView | undefined) {
  const provider = view?.provider;
  const key = provider?.apiKey;
  const form: HarnessModelForm = {
    model: view?.model ?? "",
    alias: view?.alias && view.alias !== DEFAULT_ALIAS ? view.alias : "",
    baseUrl: provider?.baseUrl ?? "",
    keyMode: key
      ? key.kind === "env"
        ? "env"
        : "keep"
      : view?.configured
        ? "none"
        : "new",
    ...(key && key.kind !== "env" ? { keyReference: key } : {}),
    newKey: "",
    envName: key?.kind === "env" ? key.value : "",
    contextWindow: provider?.contextWindow
      ? String(provider.contextWindow)
      : "",
    maxOutputTokens: provider?.maxOutputTokens
      ? String(provider.maxOutputTokens)
      : "",
    headers: [
      ...Object.entries(provider?.headers ?? {}).map(([name, value]) =>
        headerRow({ name, value }),
      ),
      ...Object.entries(provider?.secretHeaders ?? {}).map(
        ([name, reference]) => headerRow({ name, secret: true, reference }),
      ),
    ],
    includeUsage: provider?.compatibility?.includeUsage ?? false,
    reasoning: provider?.compatibility?.reasoning ?? "passthrough",
    maxTokensField: provider?.compatibility?.maxTokensField ?? "max_tokens",
    dropParameters: (provider?.compatibility?.dropParameters ?? []).join(", "),
  };
  return form;
}
// Mirrors the Gateway unified-model rules (src/application/harness-model.ts) so mistakes are
// explained before any secret is stored; the Gateway remains the authority.
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const sensitiveHeader =
  /authorization|api[-_]?key|token|secret|password|cookie|credential/i;
const inlineCredential = /\b(?:sk-|ghp_|Bearer )[A-Za-z0-9_-]{12,}/;
const environmentName = /^[A-Z][A-Z0-9_]{0,127}$/;
function integer(text: string, min: number, max: number, label: string) {
  if (!text.trim()) return { value: undefined };
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < min || value > max)
    return { error: `${label}需为 ${min}–${max} 之间的整数` };
  return { value };
}
export function dropParameterList(text: string) {
  return text
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
/** Returns the first problem in Chinese, or null when the Gateway can be asked to save. */
export function validateForm(form: HarnessModelForm): string | null {
  const model = form.model.trim();
  if (!model) return "请填写上游真实模型 ID";
  if (model.length > 256 || /[\u0000-\u001f]/.test(model))
    return "模型 ID 过长或包含控制字符";
  if (
    form.alias.trim() &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(form.alias.trim())
  )
    return "别名只能使用字母、数字和 . _ : / -，且以字母或数字开头";
  let url: URL;
  try {
    url = new URL(form.baseUrl.trim());
  } catch {
    return "请填写完整的上游地址，例如 https://model.example.com/v1";
  }
  if (!["http:", "https:"].includes(url.protocol))
    return "上游地址需使用 http 或 https";
  if (url.username || url.password)
    return "不要把凭证写在上游地址中，请使用 API Key 或敏感请求头";
  if (url.search || url.hash) return "上游地址不能包含查询参数（?）或片段（#）";
  if (form.keyMode === "new") {
    const key = form.newKey.trim();
    if (!key) return "请输入新的 API Key，或选择其他来源";
    if (/[\r\n\0]/.test(key) || key.length > 8192)
      return "API Key 需为单行文本，最长 8192 字符";
  }
  if (form.keyMode === "keep" && !form.keyReference)
    return "没有可保留的 API Key 引用，请重新选择来源";
  if (form.keyMode === "env" && !environmentName.test(form.envName.trim()))
    return "请填写大写的环境变量名称（如 COMPANY_MODEL_KEY），不要填写 Key 本身";
  const context = integer(form.contextWindow, 1024, 16777216, "上下文窗口");
  if (context.error) return context.error;
  const output = integer(form.maxOutputTokens, 16, 4194304, "输出上限");
  if (output.error) return output.error;
  if (context.value && output.value && output.value > context.value)
    return "输出上限不能超过上下文窗口";
  const names = new Set<string>();
  const rows = form.headers.filter(
    (row) => row.name.trim() || row.value || row.reference,
  );
  if (rows.length > 32) return "自定义请求头最多 32 个";
  for (const row of rows) {
    const name = row.name.trim();
    if (!headerName.test(name)) return `请求头名称无效：${name || "（空）"}`;
    if (names.has(name.toLowerCase())) return `请求头重复：${name}`;
    names.add(name.toLowerCase());
    const value = row.value.trim();
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 8192)
      return `请求头 ${name} 的值需为单行文本，最长 8192 字符`;
    if (row.secret) {
      if (!value && !row.reference) return `请填写敏感请求头 ${name} 的值`;
    } else {
      if (!value) return `请填写请求头 ${name} 的值`;
      if (sensitiveHeader.test(name) || inlineCredential.test(value))
        return `请求头 ${name} 看起来包含凭证，请勾选“敏感”，值会保存到系统安全存储`;
    }
  }
  const drops = dropParameterList(form.dropParameters);
  if (drops.length > 64) return "额外去除的参数最多 64 个";
  const invalid = drops.find((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name));
  if (invalid) return `参数名无效：${invalid}（使用小写字母、数字和下划线）`;
  return null;
}
/**
 * Build the `PUT /v1/harness/model` body after secrets were stored. `secretHeaders` maps
 * each sensitive header to the reference created or kept for it; values never appear here.
 */
export function harnessModelBody(
  form: HarnessModelForm,
  apiKey: SecretReference | undefined,
  secretHeaders: Record<string, SecretReference>,
): HarnessModelInput {
  const headers = Object.fromEntries(
    form.headers
      .filter((row) => !row.secret && row.name.trim())
      .map((row) => [row.name.trim(), row.value.trim()]),
  );
  const drops = dropParameterList(form.dropParameters);
  const context = form.contextWindow.trim();
  const output = form.maxOutputTokens.trim();
  return {
    model: form.model.trim(),
    ...(form.alias.trim() ? { alias: form.alias.trim() } : {}),
    provider: {
      protocol: "openai-completions",
      baseUrl: form.baseUrl.trim(),
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(secretHeaders).length ? { secretHeaders } : {}),
      ...(context ? { contextWindow: Number(context) } : {}),
      ...(output ? { maxOutputTokens: Number(output) } : {}),
      compatibility: {
        includeUsage: form.includeUsage,
        reasoning: form.reasoning,
        maxTokensField: form.maxTokensField,
        ...(drops.length ? { dropParameters: drops } : {}),
      },
    },
  };
}
export const modelSourceNames: Record<
  NonNullable<HarnessModelView["source"]>,
  string
> = {
  environment: "环境变量 HARNESSHUB_MODEL*",
  file: "统一模型文件",
  settings: "发行包 settings.json",
};
export const engineModelStatusNames: Record<
  HarnessModelView["engines"][number]["status"],
  string
> = {
  applied: "已应用",
  unsupported: "不支持",
  disabled: "已禁用",
};
