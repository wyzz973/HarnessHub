// SPDX-License-Identifier: MIT
import type {
  ProviderConfig,
  ProviderModel,
  WireProtocol,
} from "@harnesshub/core/model-plane";

/** A failed live listing; `message` is safe to show: no key, query or body. */
export class ModelListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelListError";
  }
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 20;
const MODEL_ID = /^[^\s]{1,512}$/;

type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The protocol whose list endpoint is used: chat or responses, else anthropic, else gemini. */
export function listingProtocol(
  provider: ProviderConfig,
): WireProtocol | undefined {
  const endpoints = provider.endpoints;
  return endpoints.chat !== undefined
    ? "chat"
    : endpoints.responses !== undefined
      ? "responses"
      : endpoints.anthropic !== undefined
        ? "anthropic"
        : endpoints.gemini !== undefined
          ? "gemini"
          : undefined;
}

/** Headers and query of the provider's key scheme, plus its non-secret headers. */
function authenticate(
  provider: ProviderConfig,
  url: URL,
  key: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...provider.headers,
  };
  if (key === undefined) return headers;
  const scheme = provider.auth.apiKeyHeader;
  if (scheme === "authorization-bearer")
    headers.authorization = `Bearer ${key}`;
  else if (scheme === "query-key") url.searchParams.set("key", key);
  else if (scheme.startsWith("custom:")) headers[scheme.slice(7)] = key;
  else headers[scheme] = key;
  return headers;
}

async function getJson(
  url: URL,
  headers: Record<string, string>,
  send: typeof fetch,
): Promise<unknown> {
  // Messages name the host only: the query may hold the key.
  const host = url.host;
  let response: Response;
  try {
    response = await send(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ModelListError(
      error instanceof Error && error.name === "TimeoutError"
        ? `${host} did not answer within ${TIMEOUT_MS / 1000} s`
        : `could not connect to ${host}`,
    );
  }
  const body = await response.arrayBuffer().catch(() => undefined);
  if (!response.ok)
    throw new ModelListError(`${host} answered HTTP ${response.status}`);
  if (!body || body.byteLength > MAX_BYTES)
    throw new ModelListError(`${host} sent no usable model list`);
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    throw new ModelListError(`${host} sent a model list that is not JSON`);
  }
}

function idOf(value: unknown): string | undefined {
  return typeof value === "string" && MODEL_ID.test(value) ? value : undefined;
}

const MODALITIES = ["text", "image", "pdf", "audio", "video"] as const;

/**
 * The metadata an OpenAI-format list item may add to its id: the fields a
 * HarnessHub gateway publishes (`context_window`, `max_output_tokens`,
 * `reasoning`, `input_modalities`) and OpenRouter's `context_length`.
 * Values of the wrong type are ignored.
 */
function listedMetadata(item: Json): Omit<ProviderModel, "id"> {
  const positive = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) > 0
      ? (value as number)
      : undefined;
  const contextWindow =
    positive(item.context_window) ?? positive(item.context_length);
  const maxOutputTokens = positive(item.max_output_tokens);
  const modalities = Array.isArray(item.input_modalities)
    ? item.input_modalities.filter(
        (value): value is (typeof MODALITIES)[number] =>
          (MODALITIES as readonly unknown[]).includes(value),
      )
    : undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(typeof item.reasoning === "boolean"
      ? { reasoning: item.reasoning }
      : {}),
    ...(modalities?.length
      ? { inputModalities: [...new Set(modalities)] }
      : {}),
  };
}

/**
 * List the provider's models from its upstream: `GET {chat base}{listPath}`
 * (default `/models`, OpenAI format, with the window, output and modality
 * fields that HarnessHub and OpenRouter add), `GET {anthropic base}/v1/models` with
 * `anthropic-version`, or `GET {gemini base}/v1beta/models` (models that
 * support `generateContent`). Follows the vendor's pagination up to 20 pages.
 * `key` is sent by the provider's key scheme; without one the request is
 * unauthenticated (local servers).
 *
 * @throws ModelListError on any failure, with a message that names only the
 *   host and the HTTP status.
 */
export async function fetchModelList(
  provider: ProviderConfig,
  key: string | undefined,
  send: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ProviderModel[]> {
  const protocol = listingProtocol(provider);
  if (!protocol) throw new ModelListError("the provider has no endpoint");
  const base = provider.endpoints[protocol]!.replace(/\/+$/, "");
  const models = new Map<string, ProviderModel>();
  const add = (model: ProviderModel) => {
    if (!models.has(model.id)) models.set(model.id, model);
  };
  if (protocol === "chat" || protocol === "responses") {
    const url = new URL(`${base}${provider.models.listPath ?? "/models"}`);
    const body = await getJson(url, authenticate(provider, url, key), send);
    const data = object(body) ? body.data : undefined;
    if (!Array.isArray(data))
      throw new ModelListError(`${url.host} sent no data array`);
    for (const item of data) {
      const id = object(item) ? idOf(item.id) : undefined;
      if (id && object(item)) add({ id, ...listedMetadata(item) });
    }
  } else if (protocol === "anthropic") {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${base}/v1/models`);
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const headers = {
        ...authenticate(provider, url, key),
        "anthropic-version": "2023-06-01",
      };
      const body = await getJson(url, headers, send);
      const data = object(body) ? body.data : undefined;
      if (!Array.isArray(data) || !object(body))
        throw new ModelListError(`${url.host} sent no data array`);
      for (const item of data) {
        const id = object(item) ? idOf(item.id) : undefined;
        if (id) add({ id });
      }
      after = body.has_more === true ? idOf(body.last_id) : undefined;
      if (!after) break;
    }
  } else {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${base}/v1beta/models`);
      url.searchParams.set("pageSize", "1000");
      if (token) url.searchParams.set("pageToken", token);
      const body = await getJson(url, authenticate(provider, url, key), send);
      const list = object(body) ? body.models : undefined;
      if (!Array.isArray(list) || !object(body))
        throw new ModelListError(`${url.host} sent no models array`);
      for (const item of list) {
        if (!object(item)) continue;
        const methods = item.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes("generateContent"))
          continue;
        const id =
          typeof item.name === "string"
            ? idOf(item.name.replace(/^models\//, ""))
            : undefined;
        if (!id) continue;
        const input = item.inputTokenLimit;
        const output = item.outputTokenLimit;
        add({
          id,
          ...(Number.isSafeInteger(input) && (input as number) > 0
            ? { contextWindow: input as number }
            : {}),
          ...(Number.isSafeInteger(output) && (output as number) > 0
            ? { maxOutputTokens: output as number }
            : {}),
        });
      }
      token =
        typeof body.nextPageToken === "string" && body.nextPageToken
          ? body.nextPageToken
          : undefined;
      if (!token) break;
    }
  }
  return [...models.values()];
}
