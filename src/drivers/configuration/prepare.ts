import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionSpec } from "../../domain/ports.js";
import type {
  EngineMcpServer,
  SecretReference,
} from "../../domain/engine-configuration.js";
import { HubError } from "../../domain/errors.js";
import { resolveSecret } from "./secrets.js";
export type RuntimeMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      headers: { name: string; value: string }[];
    };
/** Worker-owned launch material. Contains in-memory credentials: never serialize this into a store or IPC. */
export interface PreparedConfiguration {
  command: string[];
  env: Record<string, string>;
  model?: string;
  instructionPrefix: string;
  mcpServers: RuntimeMcpServer[];
}
type Resolver = (reference: SecretReference) => Promise<string>;
async function settledValues<T>(values: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(values);
  const output: T[] = [];
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    output.push(result.value);
  }
  return output;
}
function sessionSecretResolver(
  environment: Readonly<NodeJS.ProcessEnv>,
): Resolver {
  const cache = new Map<string, Promise<string>>();
  let active = 0;
  const queue: (() => void)[] = [];
  return (reference) => {
    const id = JSON.stringify(reference);
    const previous = cache.get(id);
    if (previous) return previous;
    const resolution = (async () => {
      await new Promise<void>((ready) => {
        if (active < 4) {
          active++;
          ready();
        } else queue.push(ready);
      });
      try {
        return await resolveSecret(reference, environment);
      } finally {
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    })();
    cache.set(id, resolution);
    return resolution;
  };
}
async function secretMap(
  refs: Record<string, SecretReference> | undefined,
  resolve: Resolver,
): Promise<Record<string, string>> {
  const entries = await settledValues(
    Object.entries(refs ?? {}).map(
      async ([name, ref]) => [name, await resolve(ref)] as const,
    ),
  );
  return Object.fromEntries(entries);
}
async function mcp(
  server: EngineMcpServer,
  resolve: Resolver,
): Promise<RuntimeMcpServer> {
  if (server.type === "stdio")
    return {
      name: server.name,
      command: server.command!,
      args: server.args ?? [],
      env: Object.entries({
        ...server.env,
        ...(await secretMap(server.secretEnv, resolve)),
      }).map(([name, value]) => ({ name, value })),
    };
  return {
    name: server.name,
    type: server.type,
    url: server.url!,
    headers: Object.entries({
      ...server.headers,
      ...(await secretMap(server.secretHeaders, resolve)),
    }).map(([name, value]) => ({ name, value })),
  };
}
function unsupported(message: string): never {
  throw new HubError("ENGINE_CONFIGURATION_UNSUPPORTED", message, 400);
}
/** Prepare one Session's private native configuration without changing global/user configuration. */
export async function prepareConfiguration(
  spec: ExecutionSpec,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PreparedConfiguration> {
  const config = spec.profile.configuration;
  const resolve = sessionSecretResolver(environment);
  const result: PreparedConfiguration = {
    command: [...(spec.profile.command ?? [])],
    env: {},
    instructionPrefix: "",
    mcpServers: [],
    ...(spec.profile.model ? { model: spec.profile.model } : {}),
  };
  if (!config) return result;
  // Convert the known env argv wrapper to a child environment so configured values
  // override it. Shell expressions and arbitrary launcher scripts are never rewritten.
  if (result.command[0] === "/usr/bin/env") {
    result.command.shift();
    while (/^[A-Z][A-Z0-9_]*=/.test(result.command[0] ?? "")) {
      const assignment = result.command.shift()!;
      const split = assignment.indexOf("=");
      result.env[assignment.slice(0, split)] = assignment.slice(split + 1);
    }
  }
  Object.assign(
    result.env,
    config.env,
    await secretMap(config.secretEnv, resolve),
  );
  const enabledSkills = config.skills?.filter((s) => s.enabled) ?? [];
  let total = 0;
  for (const skill of enabledSkills) {
    const info = await lstat(skill.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw new HubError(
        "SKILL_UNAVAILABLE",
        "Selected SKILL.md is unavailable or too large",
      );
    const bytes = await readFile(skill.path);
    total += bytes.length;
    if (
      bytes.length > 65536 ||
      total > 262144 ||
      createHash("sha256").update(bytes).digest("hex") !== skill.sha256
    )
      throw new HubError(
        "SKILL_CHANGED",
        "Selected skill changed; inspect and save a new configuration revision",
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    result.instructionPrefix += `\n<configured_skill source=${JSON.stringify(skill.path)} base_directory=${JSON.stringify(path.dirname(skill.path))}>\n${text}\n</configured_skill>\n`;
  }
  if (result.instructionPrefix)
    result.instructionPrefix = `Apply the following user-selected skill instructions to this task. Supporting files are relative to each skill's base directory.\n${result.instructionPrefix}\nTask:\n`;
  result.mcpServers = await settledValues(
    (config.mcpServers ?? [])
      .filter((s) => s.enabled)
      .map((s) => mcp(s, resolve)),
  );
  if (spec.profile.driver === "cli" && spec.profile.model) {
    if (!["cursor", "antigravity"].includes(config.adapter))
      unsupported("This CLI adapter cannot translate model selection");
    if (
      result.command.some(
        (arg) =>
          arg === "--model" || arg === "-m" || arg.startsWith("--model="),
      )
    )
      unsupported(
        "Remove the fixed model command argument before using the model field",
      );
    const at = result.command.indexOf("{prompt}");
    result.command.splice(
      at < 0 ? result.command.length : at,
      0,
      "--model",
      spec.profile.model,
    );
  }
  const provider = config.provider;
  if (!provider) return result;
  if (
    result.command.some((arg) =>
      /launch-(?:pi|opencode|dsh|openclaw)-acp\.mjs$/.test(arg),
    )
  )
    unsupported(
      "This custom launcher fixes its own provider. Select the discovered standard launch template before applying managed provider settings",
    );
  const root = path.join(spec.stateDir, "configuration");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (provider.apiKey)
    result.env.HARNESSHUB_PROVIDER_KEY = await resolve(provider.apiKey);
  const key = result.env.HARNESSHUB_PROVIDER_KEY;
  const model = spec.profile.model!;
  const jsonFile = async (name: string, value: unknown) => {
    const file = path.join(root, name);
    await writeFile(file, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    return file;
  };
  switch (config.adapter) {
    case "codex": {
      const codexHome = path.join(root, "codex");
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const quote = JSON.stringify;
      const lines = [
        `model = ${quote(model)}`,
        'model_provider = "harnesshub"',
        "[model_providers.harnesshub]",
        'name = "HarnessHub"',
        `base_url = ${quote(provider.baseUrl)}`,
        'wire_api = "responses"',
        ...(key ? ['env_key = "HARNESSHUB_PROVIDER_KEY"'] : []),
      ];
      await writeFile(
        path.join(codexHome, "config.toml"),
        lines.join("\n") + "\n",
        { mode: 0o600 },
      );
      result.env.CODEX_HOME = codexHome;
      break;
    }
    case "opencode":
    case "mimo": {
      const prefix = config.adapter === "mimo" ? "MIMOCODE" : "OPENCODE";
      const npm =
        provider.protocol === "anthropic"
          ? "@ai-sdk/anthropic"
          : provider.protocol === "openai-responses"
            ? "@ai-sdk/openai"
            : "@ai-sdk/openai-compatible";
      const selection = `harnesshub/${model}`;
      result.env[`${prefix}_CONFIG_CONTENT`] = JSON.stringify({
        model: selection,
        enabled_providers: ["harnesshub"],
        autoupdate: false,
        provider: {
          harnesshub: {
            name: "HarnessHub",
            npm,
            models: { [model]: { name: model } },
            options: {
              baseURL: provider.baseUrl,
              ...(key ? { apiKey: "{env:HARNESSHUB_PROVIDER_KEY}" } : {}),
            },
          },
        },
      });
      result.env[`${prefix}_DISABLE_AUTOUPDATE`] = "true";
      result.model = selection;
      break;
    }
    case "pi": {
      const api =
        provider.protocol === "anthropic"
          ? "anthropic-messages"
          : provider.protocol;
      await jsonFile("models.json", {
        providers: {
          harnesshub: {
            baseUrl: provider.baseUrl,
            api,
            ...(key ? { apiKey: "$HARNESSHUB_PROVIDER_KEY" } : {}),
            models: [{ id: model }],
          },
        },
      });
      await jsonFile("settings.json", {
        defaultProvider: "harnesshub",
        defaultModel: model,
      });
      result.env.PI_CODING_AGENT_DIR = root;
      result.env.PI_SKIP_VERSION_CHECK = "1";
      result.env.PI_OFFLINE = "1";
      result.model = `harnesshub/${model}`;
      break;
    }
    case "claude":
      if (key) result.env.ANTHROPIC_API_KEY = key;
      if (provider.baseUrl) result.env.ANTHROPIC_BASE_URL = provider.baseUrl;
      break;
    case "hermes": {
      result.env.HERMES_HOME = root;
      result.model = `custom:${model}`;
      await writeFile(
        path.join(root, "config.yaml"),
        `model:\n  provider: custom\n  default: ${JSON.stringify(model)}\n  base_url: ${JSON.stringify(provider.baseUrl)}\n`,
        { mode: 0o600 },
      );
      result.env.OPENAI_BASE_URL = provider.baseUrl!;
      result.env.CUSTOM_BASE_URL = provider.baseUrl!;
      if (key) {
        result.env.OPENAI_API_KEY = key;
        result.env.CUSTOM_API_KEY = key;
      }
      break;
    }
    case "qwen":
      result.env.OPENAI_BASE_URL = provider.baseUrl!;
      result.env.OPENAI_MODEL = model;
      if (key) result.env.OPENAI_API_KEY = key;
      break;
    case "gemini":
      if (key) result.env.GEMINI_API_KEY = key;
      if (provider.baseUrl)
        result.env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl;
      break;
    default:
      unsupported(
        "This engine uses native account/provider configuration; managed provider overrides are not supported",
      );
  }
  return result;
}
