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
import { portableCommand, unwrapEnvironment } from "./launch.js";
import { codexModelCatalog } from "./codex-models.js";
import { prepareNativeMcp } from "./native-mcp.js";
import {
  startModelBridge,
  type ModelBridge,
} from "../chat-completions/bridge.js";
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
  /** A fixed native provider sets the model before ACP starts and exposes no model-selection capability. */
  nativeModelSelection?: boolean;
  /** Session-owned protocol adapter; caller must bind Runs and await close, including failed probes. */
  modelBridge?: ModelBridge;
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
  if (server.type === "stdio") {
    const command = portableCommand([server.command!, ...(server.args ?? [])]);
    return {
      name: server.name,
      command: command[0]!,
      args: command.slice(1),
      env: Object.entries({
        ...server.env,
        ...(await secretMap(server.secretEnv, resolve)),
      }).map(([name, value]) => ({ name, value })),
    };
  }
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
  const launch = unwrapEnvironment(spec.profile.command ?? []);
  const result: PreparedConfiguration = {
    command: launch.command,
    env: launch.env,
    instructionPrefix: "",
    mcpServers: [],
    ...(spec.profile.model ? { model: spec.profile.model } : {}),
  };
  const finish = async () => {
    try {
      await prepareNativeMcp(spec, result);
      result.command = portableCommand(result.command);
      return result;
    } catch (error) {
      await result.modelBridge?.close();
      throw error;
    }
  };
  if (!config) return finish();
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
  if (config.adapter === "mimo" && result.mcpServers.length > 0) {
    // MiMo 0.1.14 logs the complete ACP session state, including resolved
    // MCP credentials, at INFO. Set its native logger before initialization.
    const levels = result.command.flatMap((argument, index) =>
      argument === "--log-level"
        ? [result.command[index + 1]]
        : argument.startsWith("--log-level=")
          ? [argument.slice("--log-level=".length)]
          : [],
    );
    if (levels.some((level) => level !== "ERROR"))
      unsupported(
        "Managed MiMo MCP requires --log-level ERROR to keep credentials out of native session logs",
      );
    if (levels.length === 0) result.command.push("--log-level", "ERROR");
  }
  if (config.adapter === "qwen" && result.mcpServers.length > 0) {
    // Qwen 0.23's ACP prompt can race its background MCP discovery. Its
    // supported blocking mode completes registration during initialize so
    // the first model request includes the selected server's tools.
    result.env.QWEN_CODE_LEGACY_MCP_BLOCKING = "1";
  }
  if (config.adapter === "copilot") {
    const stdio = result.mcpServers.filter((server) => "command" in server);
    if (stdio.length) {
      if (
        result.command.some((argument) =>
          /^--additional-mcp-config(?:=|$)/.test(argument),
        )
      )
        unsupported(
          "Remove the fixed additional MCP configuration before selecting managed stdio servers",
        );
      const directory = path.join(spec.stateDir, "configuration");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const servers = Object.fromEntries(
        stdio.map((server, serverIndex) => {
          const env = Object.fromEntries(
            server.env.map(({ name, value }, variableIndex) => {
              const reference = `HARNESSHUB_COPILOT_MCP_${serverIndex}_${variableIndex}`;
              result.env[reference] = value;
              return [name, `\${${reference}}`];
            }),
          );
          return [
            server.name,
            {
              type: "stdio",
              command: server.command,
              args: server.args,
              env,
              tools: ["*"],
            },
          ];
        }),
      );
      const file = path.join(directory, "copilot-mcp.json");
      await writeFile(
        file,
        JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
        { mode: 0o600 },
      );
      result.command.push("--additional-mcp-config", `@${file}`);
      // Copilot 1.0.83 deliberately rejects client-supplied ACP stdio servers.
      // Its owner-supplied native config is loaded before the ACP server starts.
      result.mcpServers = result.mcpServers.filter(
        (server) => !("command" in server),
      );
    }
  }
  if (spec.profile.driver === "cli" && spec.profile.model) {
    if (!["cursor", "antigravity", "kimi"].includes(config.adapter))
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
    if (config.adapter === "kimi")
      result.command.push("--model", spec.profile.model);
    else {
      const at = result.command.indexOf("{prompt}");
      result.command.splice(
        at < 0 ? result.command.length : at,
        0,
        "--model",
        spec.profile.model,
      );
    }
  }
  const provider = config.provider;
  if (!provider) return finish();
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
      const catalog = codexModelCatalog(model);
      const catalogFile = catalog
        ? await jsonFile("codex-models.json", catalog)
        : undefined;
      const bridge =
        provider.protocol === "openai-completions"
          ? await startModelBridge({
              baseUrl: provider.baseUrl!,
              model,
              ...(key ? { apiKey: key } : {}),
            })
          : undefined;
      if (bridge) {
        result.modelBridge = bridge;
        result.env.HARNESSHUB_PROVIDER_KEY = bridge.token;
        // codex-acp's default uses a separately hosted Guardian model. Its
        // official user-review mode keeps ACP approvals without that service.
        result.env.INITIAL_AGENT_MODE = "read-only";
      }
      const lines = [
        `model = ${quote(model)}`,
        'model_provider = "harnesshub"',
        ...(catalogFile ? [`model_catalog_json = ${quote(catalogFile)}`] : []),
        ...(bridge
          ? [
              'model_reasoning_effort = "none"',
              "model_supports_reasoning_summaries = false",
              'web_search = "disabled"',
            ]
          : []),
        "[model_providers.harnesshub]",
        'name = "HarnessHub"',
        `base_url = ${quote(bridge?.baseUrl ?? provider.baseUrl)}`,
        'wire_api = "responses"',
        ...(key || bridge ? ['env_key = "HARNESSHUB_PROVIDER_KEY"'] : []),
        ...(bridge
          ? [
              "supports_websockets = false",
              "request_max_retries = 0",
              "stream_max_retries = 0",
            ]
          : []),
      ];
      try {
        await writeFile(
          path.join(codexHome, "config.toml"),
          lines.join("\n") + "\n",
          { mode: 0o600 },
        );
      } catch (error) {
        await bridge?.close();
        throw error;
      }
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
    case "dsh": {
      const profileAt = result.command.indexOf("--profile");
      if (
        profileAt < 0 ||
        result.command[profileAt + 1] !== "acp" ||
        profileAt !== result.command.length - 2 ||
        result.command.some(
          (arg) => arg === "--patch" || arg.startsWith("--patch="),
        )
      )
        unsupported(
          "DSH managed providers require the standard --profile acp launch template without trailing application arguments or fixed patches",
        );
      // DSH 0.1.2-rc.1 overlays replace an entry's config. Configure the native
      // route and both defaults; ACP's selector carries the full route as JSON.
      const selection = { provider: "harnesshub", model };
      const file = await jsonFile("dsh.patch.json", [
        {
          id: "llm-pi-ai",
          config: {
            providers: {
              harnesshub: {
                api:
                  provider.protocol === "anthropic"
                    ? "anthropic-messages"
                    : provider.protocol,
                baseURL: provider.baseUrl,
                ...(key ? { apiKeyEnv: "HARNESSHUB_PROVIDER_KEY" } : {}),
                models: [{ id: model, name: model }],
              },
            },
          },
        },
        { id: "agent-default-model", config: selection },
        { id: "acp", config: selection },
      ]);
      result.command.push("--patch", file);
      result.env.DSH_HOME = root;
      result.env.DSH_TELEMETRY_DISABLED = "1";
      result.model = JSON.stringify([selection.provider, model]);
      break;
    }
    case "openclaw": {
      result.nativeModelSelection = true;
      // SecretRef preserves the environment variable name when OpenClaw writes
      // its models catalog; an interpolated ${KEY} could persist the value.
      const nativeModel = `harnesshub/${model}`;
      result.env.OPENCLAW_STATE_DIR = root;
      result.env.OPENCLAW_CONFIG_PATH = await jsonFile("openclaw.json", {
        ...(key
          ? {
              secrets: {
                providers: {
                  harnesshub: {
                    source: "env",
                    allowlist: ["HARNESSHUB_PROVIDER_KEY"],
                  },
                },
              },
            }
          : {}),
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            harnesshub: {
              baseUrl: provider.baseUrl,
              api:
                provider.protocol === "anthropic"
                  ? "anthropic-messages"
                  : provider.protocol,
              ...(key
                ? {
                    apiKey: {
                      source: "env",
                      provider: "harnesshub",
                      id: "HARNESSHUB_PROVIDER_KEY",
                    },
                  }
                : {}),
              models: [{ id: model, name: model, input: ["text"] }],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: nativeModel },
            models: { [nativeModel]: {} },
            workspace: spec.cwd,
          },
        },
      });
      result.model = nativeModel;
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
        `model:\n  provider: custom\n  default: ${JSON.stringify(model)}\n  base_url: ${JSON.stringify(provider.baseUrl)}\nproviders:\n  custom:\n    base_url: ${JSON.stringify(provider.baseUrl)}\n    default_model: ${JSON.stringify(model)}\n    transport: chat_completions\n${key ? "    key_env: HARNESSHUB_PROVIDER_KEY\n" : ""}security:\n  allow_lazy_installs: false\n`,
        { mode: 0o600 },
      );
      result.env.OPENAI_BASE_URL = provider.baseUrl!;
      result.env.CUSTOM_BASE_URL = provider.baseUrl!;
      break;
    }
    case "qwen":
      result.env.OPENAI_BASE_URL = provider.baseUrl!;
      result.env.OPENAI_MODEL = model;
      if (key) result.env.OPENAI_API_KEY = key;
      result.model = `$runtime|openai|${model}(openai)`;
      break;
    case "gemini": {
      if (provider.protocol === "openai-completions") {
        const bridge = await startModelBridge({
          baseUrl: provider.baseUrl!,
          model,
          wire: "google",
          ...(key ? { apiKey: key } : {}),
        });
        result.modelBridge = bridge;
        result.env.HARNESSHUB_PROVIDER_KEY = bridge.token;
        result.env.GEMINI_API_KEY = bridge.token;
        result.env.GOOGLE_GEMINI_BASE_URL = bridge.baseUrl;
        result.env.GEMINI_CLI_HOME = root;
        result.env.GEMINI_CLI_TRUST_WORKSPACE = "true";
        result.nativeModelSelection = true;
        try {
          result.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = await jsonFile(
            "gemini-settings.json",
            {
              security: { auth: { selectedType: "gemini-api-key" } },
              model: { name: model },
              telemetry: { enabled: false },
              general: { enableAutoUpdate: false },
              tools: { exclude: ["google_web_search", "web_fetch"] },
              modelConfigs: {
                customOverrides: [
                  {
                    match: { overrideScope: "core" },
                    modelConfig: {
                      model,
                      generateContentConfig: {
                        topK: null,
                        thinkingConfig: {
                          thinkingBudget: 0,
                          includeThoughts: false,
                        },
                      },
                    },
                  },
                ],
              },
            },
          );
        } catch (error) {
          await bridge.close();
          throw error;
        }
      } else {
        if (key) result.env.GEMINI_API_KEY = key;
        if (provider.baseUrl)
          result.env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl;
      }
      break;
    }
    case "kimi": {
      if (
        result.command.some((arg) =>
          /^(?:--config(?:-file)?(?:=|$)|--?acp$)/.test(arg),
        ) ||
        result.command.includes("acp") ||
        !result.command.some((arg) => arg === "--quiet" || arg === "--print")
      )
        unsupported(
          "Kimi managed providers require a CLI --quiet/--print template without fixed --config/--config-file or ACP arguments",
        );
      const type = {
        "openai-completions": "openai_legacy",
        "openai-responses": "openai_responses",
        anthropic: "anthropic",
        google: "gemini",
      }[provider.protocol];
      // Kimi 1.50.0's print CLI accepts this file. Its ACP server requires native
      // OAuth and its deprecated --acp mode rejects every protocol method.
      const file = await jsonFile("kimi.json", {
        default_model: model,
        telemetry: false,
        providers: {
          harnesshub: { type, base_url: provider.baseUrl, api_key: "" },
        },
        models: {
          [model]: {
            provider: "harnesshub",
            model,
            max_context_size: Number(config.env!.KIMI_MODEL_MAX_CONTEXT_SIZE),
          },
        },
      });
      result.command.push("--config-file", file);
      result.env.KIMI_SHARE_DIR = path.join(root, "kimi");
      result.env.KIMI_DISABLE_TELEMETRY = "1";
      if (provider.protocol === "anthropic") {
        // The pinned Anthropic SDK emits Authorization: Bearer with this key.
        // A gateway that only accepts X-Api-Key needs a different adapter.
        if (key) result.env.ANTHROPIC_AUTH_TOKEN = key;
      } else if (provider.protocol === "google") {
        if (key) result.env.GOOGLE_API_KEY = key;
      } else {
        result.env.OPENAI_BASE_URL = provider.baseUrl!;
        if (key) result.env.OPENAI_API_KEY = key;
      }
      break;
    }
    case "copilot":
      result.nativeModelSelection = true;
      if (
        result.command.some(
          (arg) => arg === "--model" || arg.startsWith("--model="),
        )
      )
        unsupported(
          "Remove the fixed Copilot --model argument before applying managed provider settings",
        );
      result.env.COPILOT_PROVIDER_TYPE =
        provider.protocol === "anthropic" ? "anthropic" : "openai";
      result.env.COPILOT_PROVIDER_BASE_URL = provider.baseUrl!;
      result.env.COPILOT_MODEL = model;
      result.env.COPILOT_OFFLINE = "true";
      if (key) result.env.COPILOT_PROVIDER_API_KEY = key;
      break;
    default:
      unsupported(
        "This engine uses native account/provider configuration; managed provider overrides are not supported",
      );
  }
  return finish();
}
