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
export interface ModelProviderConfiguration {
  protocol: "openai-completions" | "openai-responses" | "anthropic" | "google";
  baseUrl?: string;
  apiKey?: SecretReference;
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
    ...(config?.mcpServers ?? [])
      .filter((s) => s.enabled)
      .flatMap((s) => [
        ...Object.values(s.secretEnv ?? {}),
        ...Object.values(s.secretHeaders ?? {}),
      ]),
  ];
  return [...new Set(refs.filter((r) => r.kind === "env").map((r) => r.value))];
}
