import { ProviderError, providerId, type ProviderProtocol, type ProviderView, type ProviderWriteInput } from "../../../contracts/provider.js";

/**
 * What one Provider may list as models: a guard on the form's list (an aggregator lists hundreds), not a count of anything the user
 * keeps. The number of Providers, of their revisions and of the commands that made them has no bound (2026-11-12): a store that
 * reaches one must not be what keeps the service from starting.
 */
export const MAX_MODELS = 4096;
/** A credential is a key or a token; a larger value is not one. */
export const MAX_CREDENTIAL_BYTES = 8192;
/** A Provider's revisions count up from 1 for as long as it is edited. */
export const MAX_REVISIONS = Number.MAX_SAFE_INTEGER;
const protocols: readonly ProviderProtocol[] = ["openai-responses", "openai-chat-completions", "anthropic-messages", "gemini"];
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new ProviderError("INVALID_INPUT", "Provider input must be a plain object");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > maximum || /[\x00-\x1f\x7f]/u.test(value))
    throw new ProviderError("INVALID_INPUT", "invalid " + label);
  return value;
}
export function parseProviderProtocol(value: unknown): ProviderProtocol {
  for (const protocol of protocols) if (value === protocol) return protocol;
  throw new ProviderError("INVALID_INPUT", "unsupported Provider protocol");
}
/** Preserve the user's explicit HTTP or HTTPS endpoint without credentials, query or fragment. */
export function parseBaseUrl(value: unknown): string {
  const input = text(value, "Provider base URL", 2048);
  let url: URL;
  try { url = new URL(input); } catch { throw new ProviderError("INVALID_INPUT", "invalid Provider base URL"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash)
    throw new ProviderError("INVALID_INPUT", "Provider endpoint must be HTTP or HTTPS without credentials, query or fragment");
  return url.toString().replace(/\/+$/u, "");
}
export function parseProviderWrite(value: unknown): ProviderWriteInput {
  const row = object(value);
  if (Object.keys(row).some(key => !["name", "protocol", "baseUrl", "models", "defaultModel", "enabled", "apiKey"].includes(key)))
    throw new ProviderError("INVALID_INPUT", "unknown Provider input fields");
  const name = text(row.name, "Provider name", 128), protocol = parseProviderProtocol(row.protocol), baseUrl = parseBaseUrl(row.baseUrl);
  if (!Array.isArray(row.models) || row.models.length < 1 || row.models.length > MAX_MODELS) throw new ProviderError("INVALID_INPUT", "Provider models must be a bounded nonempty list");
  const models = row.models.map(value => text(value, "model identity", 256));
  if (new Set(models).size !== models.length) throw new ProviderError("INVALID_INPUT", "duplicate Provider models");
  const defaultModel = text(row.defaultModel, "default model", 256);
  if (!models.includes(defaultModel) || typeof row.enabled !== "boolean") throw new ProviderError("INVALID_INPUT", "default model must belong to the models list and enabled must be boolean");
  const apiKey = row.apiKey === undefined ? undefined : text(row.apiKey, "API key", MAX_CREDENTIAL_BYTES);
  return { name, protocol, baseUrl, models, defaultModel, enabled: row.enabled, ...(apiKey === undefined ? {} : { apiKey }) };
}
export function parseProviderView(value: unknown): ProviderView {
  const row = object(value);
  if (Object.keys(row).some(key => !["id", "revision", "name", "protocol", "baseUrl", "models", "defaultModel", "enabled", "hasCredential"].includes(key)) ||
      typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision > MAX_REVISIONS || typeof row.hasCredential !== "boolean")
    throw new ProviderError("INVALID_DATA", "invalid stored Provider revision");
  const parsed = parseProviderWrite({ name: row.name, protocol: row.protocol, baseUrl: row.baseUrl,
    models: row.models, defaultModel: row.defaultModel, enabled: row.enabled });
  return { ...parsed, id: providerId(row.id), revision: row.revision, hasCredential: row.hasCredential };
}
/** Provider configuration is product-specific; ACP connectivity never implies Provider compatibility. */
export function assertProviderCompatibility(protocol: ProviderProtocol, harnessId: string): "codex" | "gemini" {
  if (harnessId === "codex" && protocol === "openai-responses") return "codex";
  if (harnessId === "gemini" && protocol === "gemini") return "gemini";
  throw new ProviderError("UNSUPPORTED_PROVIDER", "this Harness and Provider protocol combination is not implemented");
}
export function supportedProviderProtocols(harnessId: string): readonly ProviderProtocol[] {
  if (harnessId === "codex") return ["openai-responses"];
  if (harnessId === "gemini") return ["gemini"];
  return [];
}
export function parseProviderCommand(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new ProviderError("INVALID_INPUT", "invalid Provider command identity");
  return value;
}
