export type ProviderProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages" | "gemini";
export interface ProviderTarget { readonly providerId: string; readonly revision: number; readonly model: string }
export interface ProviderView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly enabled: boolean;
  readonly hasCredential: boolean;
}
export interface ProviderWriteInput {
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly enabled: boolean;
  readonly apiKey?: string;
}
export class ProviderError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ProviderError"; }
}
export function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^provider-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value))
    throw new ProviderError("INVALID_INPUT", "invalid Provider identity");
  return value;
}
/** Strict public target parsing; a target pins one immutable Provider revision and explicit model. */
export function parseProviderTarget(value: unknown): ProviderTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new ProviderError("INVALID_INPUT", "Provider target must be a plain object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["providerId", "revision", "model"].includes(key))) throw new ProviderError("INVALID_INPUT", "unknown Provider target fields");
  if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      typeof row.model !== "string" || row.model.trim().length === 0 || new TextEncoder().encode(row.model).byteLength > 256 || /[\x00-\x1f\x7f]/u.test(row.model))
    throw new ProviderError("INVALID_INPUT", "invalid Provider revision or model");
  return { providerId: providerId(row.providerId), revision: row.revision, model: row.model };
}
export interface ProviderTextRedactor { push(text: string): string; flush(): string }
