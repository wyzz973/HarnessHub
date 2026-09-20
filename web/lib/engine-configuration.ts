import { z } from "zod";
export const adapterIds = [
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
export const providerProtocolIds = [
  "openai-completions",
  "openai-responses",
  "anthropic",
  "google",
] as const;
export const secretReferenceSchema = z
  .object({
    kind: z.enum(["env", "file", "keychain"]),
    value: z.string().min(1),
  })
  .strict();
export type SecretReference = z.infer<typeof secretReferenceSchema>;
const strings = z.record(z.string(), z.string());
const secrets = z.record(z.string(), secretReferenceSchema);
/** Upstream adjustments owned by the Worker model gateway (ADR 0013). */
export const compatibilitySchema = z
  .object({
    includeUsage: z.boolean().optional(),
    dropParameters: z.array(z.string()).optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    reasoning: z.enum(["passthrough", "strip"]).optional(),
  })
  .loose();
/**
 * Provider fields as published by the Gateway. Objects are loose so a newer Gateway
 * field is preserved when the console re-saves a revision; the Gateway schema stays
 * the authority that rejects invalid input.
 */
export const providerSchema = z
  .object({
    protocol: z.enum(providerProtocolIds),
    baseUrl: z.string().optional(),
    apiKey: secretReferenceSchema.optional(),
    headers: strings.optional(),
    secretHeaders: secrets.optional(),
    contextWindow: z.number().int().optional(),
    maxOutputTokens: z.number().int().optional(),
    modelAlias: z.string().optional(),
    compatibility: compatibilitySchema.optional(),
  })
  .loose();
export type ProviderConfiguration = z.infer<typeof providerSchema>;
export const configurationSchema = z
  .object({
    adapter: z.enum(adapterIds),
    provider: providerSchema.optional(),
    env: strings.optional(),
    secretEnv: secrets.optional(),
    skills: z
      .array(
        z
          .object({
            path: z.string(),
            enabled: z.boolean(),
            sha256: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
    mcpServers: z
      .array(
        z
          .object({
            name: z.string(),
            type: z.enum(["stdio", "http", "sse"]),
            enabled: z.boolean(),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            url: z.string().optional(),
            env: strings.optional(),
            secretEnv: secrets.optional(),
            headers: strings.optional(),
            secretHeaders: secrets.optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
export type Configuration = z.infer<typeof configurationSchema>;
export const configurationTestSchema = z.object({
  engineId: z.string(),
  revision: z.string(),
  checkedAt: z.number(),
  modelCalled: z.literal(false),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["passed", "failed"]),
      message: z.string(),
    }),
  ),
});
