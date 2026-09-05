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
export const secretReferenceSchema = z
  .object({
    kind: z.enum(["env", "file", "keychain"]),
    value: z.string().min(1),
  })
  .strict();
const strings = z.record(z.string(), z.string());
const secrets = z.record(z.string(), secretReferenceSchema);
export const configurationSchema = z
  .object({
    adapter: z.enum(adapterIds),
    provider: z
      .object({
        protocol: z.enum([
          "openai-completions",
          "openai-responses",
          "anthropic",
          "google",
        ]),
        baseUrl: z.string().optional(),
        apiKey: secretReferenceSchema.optional(),
      })
      .strict()
      .optional(),
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
          .strict(),
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
          .strict(),
      )
      .optional(),
  })
  .strict();
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
