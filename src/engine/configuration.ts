import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  engineConfigurationSchema,
  type EngineConfiguration,
  type SecretReference,
  type ConfigurationAdapter,
} from "../domain/engine-configuration.js";
import { HubError } from "../domain/errors.js";
import type { EngineProfile } from "../domain/types.js";
const validate = new Ajv({ allErrors: true }).compile<EngineConfiguration>(
  engineConfigurationSchema,
);
export const providerProtocols: Record<
  ConfigurationAdapter,
  readonly string[]
> = {
  generic: [],
  codex: ["openai-responses", "openai-completions"],
  claude: ["anthropic"],
  opencode: ["openai-completions", "openai-responses", "anthropic"],
  mimo: ["openai-completions", "openai-responses", "anthropic"],
  hermes: ["openai-completions"],
  pi: ["openai-completions", "openai-responses", "anthropic"],
  gemini: ["google", "openai-completions"],
  qwen: ["openai-completions"],
  cursor: [],
  copilot: ["openai-completions", "anthropic"],
  kimi: ["openai-completions", "openai-responses", "anthropic", "google"],
  kiro: [],
  qoder: [],
  dsh: ["openai-completions", "openai-responses", "anthropic"],
  openclaw: ["openai-completions", "openai-responses", "anthropic"],
  antigravity: [],
};
const forbidden =
  /^(?:PATH|HOME|USERPROFILE|XDG_.*|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|HARNESSHUB_.*)$/;
const secretName = /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE/i;
function fail(message: string): never {
  throw new HubError("INVALID_ENGINE_CONFIGURATION", message);
}
function url(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("URL must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    fail("URL must use HTTP(S), without credentials, query or fragment");
}
function references(values: Record<string, SecretReference> | undefined): void {
  for (const ref of Object.values(values ?? {})) reference(ref);
}
function reference(ref: SecretReference): void {
  if (ref.kind === "env" && !/^[A-Z][A-Z0-9_]*$/.test(ref.value))
    fail("Secret environment reference must name a variable");
  if (ref.kind === "file" && !path.isAbsolute(ref.value))
    fail("Secret file reference must be absolute");
  if (ref.kind === "keychain" && !/^[a-f0-9-]{36}$/.test(ref.value))
    fail("Keychain reference must be a HarnessHub credential ID");
}
function environment(
  env: Record<string, string> | undefined,
  refs: Record<string, SecretReference> | undefined,
): void {
  for (const [name, value] of Object.entries(env ?? {})) {
    if (
      forbidden.test(name) ||
      secretName.test(name) ||
      value.includes("\0") ||
      /\b(?:sk-|ghp_|Bearer )[a-zA-Z0-9_-]{12,}/.test(value)
    )
      fail(
        "Environment secrets require secretEnv references; process-control environment overrides are not allowed",
      );
    if (refs?.[name])
      fail(
        "An environment name cannot have both a value and a secret reference",
      );
  }
  for (const name of Object.keys(refs ?? {}))
    if (forbidden.test(name))
      fail("Process-control environment overrides are not allowed");
  references(refs);
}
/** Validate explicit configuration without reading credentials or inspecting the machine. */
export function parseEngineConfiguration(
  raw: unknown,
  driver: string,
  model?: string,
): EngineConfiguration {
  if (!validate(raw)) fail("Invalid engine configuration shape");
  const config = structuredClone(raw);
  environment(config.env, config.secretEnv);
  if (config.provider) {
    if (!providerProtocols[config.adapter].includes(config.provider.protocol))
      fail(
        "This adapter does not support the selected provider protocol; use its native login or explicit environment references",
      );
    if (!model) fail("An explicit provider requires a model");
    if (config.provider.baseUrl) url(config.provider.baseUrl);
    if (
      config.adapter === "gemini" &&
      config.provider.protocol === "openai-completions" &&
      !config.provider.baseUrl
    )
      fail("A Chat gateway requires an explicit base URL");
    if (config.provider.apiKey) reference(config.provider.apiKey);
    if (
      [
        "codex",
        "opencode",
        "mimo",
        "hermes",
        "pi",
        "qwen",
        "copilot",
        "kimi",
        "dsh",
        "openclaw",
      ].includes(config.adapter) &&
      !config.provider.baseUrl
    )
      fail("A custom provider requires an explicit base URL");
    if (config.adapter === "kimi") {
      if (driver !== "cli")
        fail(
          "Kimi 1.50.0 ACP requires native OAuth; use a CLI --quiet --prompt {prompt} template for a managed provider",
        );
      const contextSize = config.env?.KIMI_MODEL_MAX_CONTEXT_SIZE;
      if (
        !contextSize ||
        !/^[1-9][0-9]*$/.test(contextSize) ||
        !Number.isSafeInteger(Number(contextSize))
      )
        fail(
          "Kimi custom providers require env.KIMI_MODEL_MAX_CONTEXT_SIZE to be the model's positive integer context window",
        );
    }
  }
  if (
    ["pi", "openclaw"].includes(config.adapter) &&
    config.mcpServers?.some((server) => server.enabled) &&
    (driver !== "acp" || !config.provider)
  )
    fail("Pi and OpenClaw managed MCP require ACP and a managed provider");
  if (
    driver === "cli" &&
    config.adapter !== "kimi" &&
    config.mcpServers?.some((s) => s.enabled)
  )
    fail(
      "MCP injection requires an ACP engine; this CLI adapter cannot apply it",
    );
  if (
    driver === "cli" &&
    model &&
    !["cursor", "antigravity", "kimi"].includes(config.adapter)
  )
    fail(
      "Automatic CLI model arguments are supported only for Cursor, Antigravity and Kimi; use native command arguments for generic CLI",
    );
  const servers = config.mcpServers ?? [];
  if (
    config.adapter === "kimi" &&
    servers.some(
      (server) =>
        server.enabled &&
        (Object.keys(server.secretEnv ?? {}).length > 0 ||
          Object.keys(server.secretHeaders ?? {}).length > 0),
    )
  )
    fail(
      "Kimi native MCP cannot resolve secret references without persisting their values; use a local credential-free MCP server",
    );
  if (new Set(servers.map((s) => s.name)).size !== servers.length)
    fail("MCP names must be unique");
  for (const server of servers) {
    environment(server.env, server.secretEnv);
    references(server.secretHeaders);
    if (server.type === "stdio") {
      if (
        !server.command ||
        !path.isAbsolute(server.command) ||
        server.url ||
        server.headers ||
        server.secretHeaders
      )
        fail("stdio MCP requires an absolute command and no URL/headers");
      if (
        server.args?.some((v) =>
          /^(?:--?(?:api-key|token|password|secret)|[A-Z_]*(?:KEY|TOKEN|SECRET)=)/i.test(
            v,
          ),
        )
      )
        fail("MCP credentials must use secretEnv references");
    } else {
      if (
        !server.url ||
        server.command ||
        server.args ||
        server.env ||
        server.secretEnv
      )
        fail("Remote MCP requires a URL and no command/environment");
      url(server.url);
      for (const [name, value] of Object.entries(server.headers ?? {}))
        if (secretName.test(name) || /[\r\n]/.test(name + value))
          fail("Sensitive MCP headers require secretHeaders references");
      for (const name of Object.keys(server.secretHeaders ?? {}))
        if (/[\r\n]/.test(name)) fail("Invalid MCP header name");
    }
  }
  for (const skill of config.skills ?? [])
    if (
      !path.isAbsolute(skill.path) ||
      path.basename(skill.path) !== "SKILL.md"
    )
      fail("Skills require an absolute SKILL.md path");
  if (
    new Set(config.skills?.map((s) => s.path)).size !==
    (config.skills?.length ?? 0)
  )
    fail("Skill paths must be unique");
  return config;
}
/** Pin skill instructions into the revision. Changed pinned content is an explicit error. */
export async function pinConfigurationSkills(
  profile: EngineProfile,
): Promise<EngineProfile> {
  if (!profile.configuration?.skills?.length) return profile;
  let bytes = 0;
  const skills = [];
  for (const skill of profile.configuration.skills) {
    if (!skill.enabled) {
      skills.push(skill);
      continue;
    }
    const info = await lstat(skill.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      fail("SKILL.md must be a regular file of at most 64 KiB");
    const content = await readFile(skill.path);
    bytes += content.byteLength;
    if (content.byteLength > 65536 || bytes > 262144)
      fail("Selected skill instructions exceed the 256 KiB combined limit");
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (skill.sha256 && skill.sha256 !== sha256)
      fail(
        "Skill contents changed; inspect and save a new configuration revision",
      );
    skills.push({ ...skill, sha256 });
  }
  return { ...profile, configuration: { ...profile.configuration, skills } };
}
