// SPDX-License-Identifier: MIT
import type { HarnessModelInput } from "./api";
import type { HarnessModelView } from "./contracts";
import type { SecretReference } from "./engine-configuration";
import { t } from "./i18n";

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
// Mirrors the Gateway unified-model rules (packages/agents/src/application/harness-model.ts) so mistakes are
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
    return {
      error: t("tasks.model.integerRange", {
        label,
        min: String(min),
        max: String(max),
      }),
    };
  return { value };
}
export function dropParameterList(text: string) {
  return text
    .split(/[\s,\uff0c]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
/** Returns the first problem in the console's language, or null when the Gateway can be asked to save. */
export function validateForm(form: HarnessModelForm): string | null {
  const model = form.model.trim();
  if (!model) return t("tasks.model.needModel");
  if (model.length > 256 || /[\u0000-\u001f]/.test(model))
    return t("tasks.model.modelInvalid");
  if (
    form.alias.trim() &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(form.alias.trim())
  )
    return t("tasks.model.aliasInvalid");
  let url: URL;
  try {
    url = new URL(form.baseUrl.trim());
  } catch {
    return t("tasks.model.needUrl");
  }
  if (!["http:", "https:"].includes(url.protocol))
    return t("tasks.model.urlScheme");
  if (url.username || url.password) return t("tasks.model.urlCredentials");
  if (url.search || url.hash) return t("tasks.model.urlQuery");
  if (form.keyMode === "new") {
    const key = form.newKey.trim();
    if (!key) return t("tasks.model.needKey");
    if (/[\r\n\0]/.test(key) || key.length > 8192)
      return t("tasks.model.keyInvalid");
  }
  if (form.keyMode === "keep" && !form.keyReference)
    return t("tasks.model.noKeyReference");
  if (form.keyMode === "env" && !environmentName.test(form.envName.trim()))
    return t("tasks.model.envInvalid");
  const context = integer(
    form.contextWindow,
    1024,
    16777216,
    t("tasks.model.contextWindow"),
  );
  if (context.error) return context.error;
  const output = integer(
    form.maxOutputTokens,
    16,
    4194304,
    t("tasks.model.maxOutput"),
  );
  if (output.error) return output.error;
  if (context.value && output.value && output.value > context.value)
    return t("tasks.model.outputOverContext");
  const names = new Set<string>();
  const rows = form.headers.filter(
    (row) => row.name.trim() || row.value || row.reference,
  );
  if (rows.length > 32) return t("tasks.model.tooManyHeaders");
  for (const row of rows) {
    const name = row.name.trim();
    if (!headerName.test(name))
      return t("tasks.model.headerNameInvalid", {
        name: name || t("tasks.model.empty"),
      });
    if (names.has(name.toLowerCase()))
      return t("tasks.model.headerDuplicate", { name });
    names.add(name.toLowerCase());
    const value = row.value.trim();
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 8192)
      return t("tasks.model.headerValueInvalid", { name });
    if (row.secret) {
      if (!value && !row.reference)
        return t("tasks.model.needSecretHeader", { name });
    } else {
      if (!value) return t("tasks.model.needHeader", { name });
      if (sensitiveHeader.test(name) || inlineCredential.test(value))
        return t("tasks.model.headerLooksSecret", { name });
    }
  }
  const drops = dropParameterList(form.dropParameters);
  if (drops.length > 64) return t("tasks.model.tooManyDrops");
  const invalid = drops.find((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name));
  if (invalid) return t("tasks.model.dropInvalid", { name: invalid });
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
export function modelSourceName(
  source: NonNullable<HarnessModelView["source"]>,
): string {
  return t(`tasks.model.source.${source}`);
}
export function engineModelStatusName(
  status: HarnessModelView["engines"][number]["status"],
): string {
  return t(`tasks.model.engine.${status}`);
}
