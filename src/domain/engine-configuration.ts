import type { EngineCandidate } from "./engines.js";
/** Secret locations only. Values never belong to a profile, IPC message or public response. */
export interface SecretReference {
  kind: "env" | "file" | "keychain";
  value: string;
}
export const configurationAdapters = [
  "generic",
  "codex",
  "claude",
  "opencode",
  "mimo",
  "hermes",
  "pi",
  "gemini",
  "qwen",
  "cursor",
  "copilot",
  "kimi",
  "kiro",
  "qoder",
  "dsh",
  "openclaw",
  "antigravity",
] as const;
export type ConfigurationAdapter = (typeof configurationAdapters)[number];
/**
 * Upstream request adjustments applied by the Worker-owned model gateway.
 * Absent fields use the gateway defaults documented in ADR 0013.
 */
export interface ModelCompatibility {
  /** Send `stream_options.include_usage` upstream. Default false because many gateways reject it. */
  includeUsage?: boolean;
  /** Extra top-level request parameters removed before the upstream call. */
  dropParameters?: string[];
  /** Upstream field name for the output-token limit. Default `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Whether upstream reasoning text is forwarded to engines. Default `passthrough`. */
  reasoning?: "passthrough" | "strip";
  /**
   * Chat `image_url` parts: `placeholder` (default) replaces them with text so a text-only
   * model keeps working; `passthrough` forwards them to a vision-capable model. Media of
   * the other inbound protocols is always replaced with text.
   */
  images?: "placeholder" | "passthrough";
}
export interface ModelProviderConfiguration {
  protocol: "openai-completions" | "openai-responses" | "anthropic" | "google";
  baseUrl?: string;
  apiKey?: SecretReference;
  /** Non-secret upstream request headers, e.g. a tenant or application id. */
  headers?: Record<string, string>;
  /** Secret upstream request headers resolved only inside the owning Worker. */
  secretHeaders?: Record<string, SecretReference>;
  /** Model context window in tokens, used for engine-native limits and request clamping. */
  contextWindow?: number;
  /** Maximum output tokens accepted by the model; larger engine requests are clamped. */
  maxOutputTokens?: number;
  /** Model id shown to engines by the gateway; the registration `model` stays the upstream id. */
  modelAlias?: string;
  compatibility?: ModelCompatibility;
}
/** Portable skill instructions; registration pins SKILL.md bytes, execution verifies them. */
export interface EngineSkill {
  path: string;
  enabled: boolean;
  sha256?: string;
}
export interface EngineMcpServer {
  name: string;
  type: "stdio" | "http" | "sse";
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, SecretReference>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, SecretReference>;
}
/** Optional additive configuration. Absent means the existing native launch contract is unchanged. */
export interface EngineConfiguration {
  adapter: ConfigurationAdapter;
  provider?: ModelProviderConfiguration;
  env?: Record<string, string>;
  secretEnv?: Record<string, SecretReference>;
  skills?: EngineSkill[];
  mcpServers?: EngineMcpServer[];
}
const text = { type: "string", minLength: 1, maxLength: 8192 } as const;
const envName = "^[A-Z][A-Z0-9_]*$";
export const secretReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "value"],
  properties: { kind: { enum: ["env", "file", "keychain"] }, value: text },
} as const;
const map = {
  type: "object",
  maxProperties: 32,
  additionalProperties: text,
} as const;
const secrets = {
  type: "object",
  maxProperties: 32,
  additionalProperties: secretReferenceSchema,
} as const;
const environment = { ...map, propertyNames: { pattern: envName } } as const;
const secretEnvironment = {
  ...secrets,
  propertyNames: { pattern: envName },
} as const;
export const engineConfigurationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["adapter"],
  properties: {
    adapter: { enum: configurationAdapters },
    provider: {
      type: "object",
      additionalProperties: false,
      required: ["protocol"],
      properties: {
        protocol: {
          enum: [
            "openai-completions",
            "openai-responses",
            "anthropic",
            "google",
          ],
        },
        baseUrl: text,
        apiKey: secretReferenceSchema,
        headers: map,
        secretHeaders: secrets,
        contextWindow: { type: "integer", minimum: 1024, maximum: 16777216 },
        maxOutputTokens: { type: "integer", minimum: 16, maximum: 4194304 },
        modelAlias: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
        },
        compatibility: {
          type: "object",
          additionalProperties: false,
          properties: {
            includeUsage: { type: "boolean" },
            dropParameters: {
              type: "array",
              maxItems: 64,
              items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            },
            maxTokensField: { enum: ["max_tokens", "max_completion_tokens"] },
            reasoning: { enum: ["passthrough", "strip"] },
            images: { enum: ["placeholder", "passthrough"] },
          },
        },
      },
    },
    env: environment,
    secretEnv: secretEnvironment,
    skills: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "enabled"],
        properties: {
          path: text,
          enabled: { type: "boolean" },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
    mcpServers: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "enabled"],
        properties: {
          name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" },
          type: { enum: ["stdio", "http", "sse"] },
          enabled: { type: "boolean" },
          command: text,
          args: { type: "array", maxItems: 128, items: text },
          url: text,
          env: environment,
          secretEnv: secretEnvironment,
          headers: map,
          secretHeaders: secrets,
        },
      },
    },
  },
} as const;
export interface ConfigurationCheck {
  name: string;
  status: "passed" | "failed";
  message: string;
}
export interface ConfigurationTestResult {
  engineId: string;
  revision: string;
  checkedAt: number;
  checks: ConfigurationCheck[];
  modelCalled: false;
}
/** Injected by the composition root; Gateway never handles engine-specific launch details. */
export interface ConfigurationManagement {
  templates(): Promise<EngineCandidate[]>;
  inspect(input: unknown): Promise<unknown>;
  test(id: string): Promise<ConfigurationTestResult>;
  createSecret(value: string): Promise<SecretReference>;
  adapters(): {
    id: ConfigurationAdapter;
    providerProtocols: string[];
    description: string;
  }[];
}

/** Source environment names to pass into only the owning Worker for reference resolution. */
export function configurationEnvironmentNames(
  config: EngineConfiguration | undefined,
): string[] {
  const refs = [
    ...Object.values(config?.secretEnv ?? {}),
    ...(config?.provider?.apiKey ? [config.provider.apiKey] : []),
    ...Object.values(config?.provider?.secretHeaders ?? {}),
    ...(config?.mcpServers ?? [])
      .filter((s) => s.enabled)
      .flatMap((s) => [
        ...Object.values(s.secretEnv ?? {}),
        ...Object.values(s.secretHeaders ?? {}),
      ]),
  ];
  return [...new Set(refs.filter((r) => r.kind === "env").map((r) => r.value))];
}
