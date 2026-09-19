import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ExecutionSpec } from "../../domain/ports.js";
import type {
  ConfigurationAdapter,
  EngineMcpServer,
  ModelProviderConfiguration,
  SecretReference,
} from "../../domain/engine-configuration.js";
import { HARNESS_MODEL_ALIAS } from "../../domain/harness-model.js";
import { HubError } from "../../domain/errors.js";
import { resolveSecret } from "./secrets.js";
import { portableCommand, unwrapEnvironment } from "./launch.js";
import { codexGatewayCatalog, codexModelCatalog } from "./codex-models.js";
import { prepareNativeMcp } from "./native-mcp.js";
import {
  startModelGateway,
  type ModelCallRecord,
  type ModelGateway,
} from "../chat-completions/gateway.js";
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
  /**
   * Inherited environment names (case-insensitive) the Worker removes before
   * applying `env`: vendor credentials, the profile's credentialEnv and the
   * sources of the upstream model secret. Set only for gateway-routed engines.
   */
  unsetEnv?: string[];
  model?: string;
  instructionPrefix: string;
  mcpServers: RuntimeMcpServer[];
  /** A fixed native provider sets the model before ACP starts and exposes no model-selection capability. */
  nativeModelSelection?: boolean;
  /**
   * Session-owned ADR 0013 model gateway, present when the provider protocol is
   * `openai-completions`. The owner binds each Run with beginRun/endRun and
   * must await close(), including after failed probes. (Named after the former
   * protocol bridge it replaces; the composition root closes it by this name.)
   */
  modelBridge?: ModelGateway;
}
/** Optional Worker callbacks. Neither is required for a configuration probe. */
export interface PreparationHooks {
  /**
   * Receives every gateway call record. Invoked synchronously by the gateway
   * before the call's request task settles; must not throw.
   */
  onModelCall?: (call: ModelCallRecord) => void;
  /** Collects every secret value resolved for the Session, for redaction only. */
  secrets?: Set<string>;
}
/** Session workspace placeholder in stdio MCP arguments and env values (ADR 0013). */
export const SESSION_WORKSPACE_PLACEHOLDER = "${HARNESSHUB_SESSION_WORKSPACE}";
/** Written into engine configuration when the unified model declares no window. */
export const DEFAULT_GATEWAY_CONTEXT_WINDOW = 131_072;
/** Written into engine configuration when the unified model declares no output limit. */
export const DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS = 16_384;
/**
 * Model-vendor credentials, endpoints and account switches engines read on
 * their own. A gateway-routed engine must use only the local gateway token, so
 * these are removed from its environment before gateway variables are set.
 */
export const VENDOR_CREDENTIAL_ENVIRONMENT = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_MODEL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GEMINI_CLI_USE_COMPUTE_ADC",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "MOONSHOT_API_KEY",
  "MOONSHOT_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "KIMI_MODEL_NAME",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DASHSCOPE_API_KEY",
  "QWEN_OAUTH",
  "COPILOT_GITHUB_TOKEN",
  "LLAMA_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "NOUS_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "PERPLEXITY_API_KEY",
  "HF_TOKEN",
  "ZAI_API_KEY",
  "ZHIPU_API_KEY",
  "GLM_API_KEY",
  "MINIMAX_API_KEY",
  "MIMO_API_KEY",
  "CUSTOM_BASE_URL",
  "CUSTOM_API_KEY",
] as const;
/** Copilot model access uses GitHub account tokens; the gateway replaces them. */
const COPILOT_ACCOUNT_ENVIRONMENT = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
/**
 * Engine state/config roots a launch template may point at the user's real
 * home (with its logins). Gateway routing drops them; each adapter sets its
 * own Session-private root where the engine needs one.
 */
const ENGINE_HOME_ENVIRONMENT = [
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_CLI_HOME",
  "QWEN_HOME",
  "OPENCODE_CONFIG_DIR",
  "MIMOCODE_HOME",
  "PI_CODING_AGENT_DIR",
  "HERMES_HOME",
  "DSH_HOME",
  "DSH_AGENTS_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "KIMI_SHARE_DIR",
  "COPILOT_HOME",
] as const;
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
  sink: Set<string> | undefined,
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
        const value = await resolveSecret(reference, environment);
        sink?.add(value);
        return value;
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
/**
 * Replace every literal Session workspace placeholder with the Session's
 * absolute directory. Plain string replacement: no escaping, and `$` sequences
 * in the path have no special meaning.
 */
function workspaceValue(value: string, workspace: string): string {
  return value.split(SESSION_WORKSPACE_PLACEHOLDER).join(workspace);
}
/**
 * Runtime MCP definition for one enabled server. For stdio servers, argument
 * and plain `env` values receive the Session workspace (ADR 0013) before the
 * portable launcher wraps the command and before any native adapter reads
 * them; `command`, secret values and HTTP/SSE URLs and headers are never
 * rewritten. Stored revisions keep the placeholder.
 */
async function mcp(
  server: EngineMcpServer,
  resolve: Resolver,
  workspace: string,
): Promise<RuntimeMcpServer> {
  if (server.type === "stdio") {
    const command = portableCommand([
      server.command!,
      ...(server.args ?? []).map((arg) => workspaceValue(arg, workspace)),
    ]);
    return {
      name: server.name,
      command: command[0]!,
      args: command.slice(1),
      env: Object.entries({
        ...Object.fromEntries(
          Object.entries(server.env ?? {}).map(([name, value]) => [
            name,
            workspaceValue(value, workspace),
          ]),
        ),
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
function fullAccess(
  environment: Readonly<NodeJS.ProcessEnv>,
  launch: Record<string, string>,
): boolean {
  return (
    environment.HARNESSHUB_FULL_ACCESS === "1" ||
    launch.INITIAL_AGENT_MODE === "agent-full-access"
  );
}
/** Prepare one Session's private native configuration without changing global/user configuration. */
export async function prepareConfiguration(
  spec: ExecutionSpec,
  environment: Readonly<NodeJS.ProcessEnv>,
  hooks: PreparationHooks = {},
): Promise<PreparedConfiguration> {
  const config = spec.profile.configuration;
  const resolve = sessionSecretResolver(environment, hooks.secrets);
  const launch = unwrapEnvironment(spec.profile.command ?? []);
  const launchEnvironment = { ...launch.env };
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
      .map((s) => mcp(s, resolve, spec.cwd)),
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
  const provider = config.provider;
  const gatewayRouted = provider?.protocol === "openai-completions";
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
    // A gateway-routed Kimi selects the alias defined in its private config.
    const selected = gatewayRouted
      ? (provider.modelAlias ?? HARNESS_MODEL_ALIAS)
      : spec.profile.model;
    if (config.adapter === "kimi") result.command.push("--model", selected);
    else {
      const at = result.command.indexOf("{prompt}");
      result.command.splice(
        at < 0 ? result.command.length : at,
        0,
        "--model",
        selected,
      );
    }
  }
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
  if (gatewayRouted) {
    await prepareGateway({
      spec,
      result,
      root,
      provider,
      resolve,
      hooks,
      fullAccess: fullAccess(environment, launchEnvironment),
    });
    return finish();
  }
  await prepareDirectProvider(spec, result, root, provider, resolve);
  return finish();
}

interface GatewayPreparation {
  spec: ExecutionSpec;
  result: PreparedConfiguration;
  root: string;
  provider: ModelProviderConfiguration;
  resolve: Resolver;
  hooks: PreparationHooks;
  fullAccess: boolean;
}
interface GatewayWiring {
  spec: ExecutionSpec;
  result: PreparedConfiguration;
  root: string;
  alias: string;
  gateway: ModelGateway;
  /** Chat/Responses base URL including /v1. */
  v1: string;
  contextWindow: number;
  maxOutputTokens: number;
  fullAccess: boolean;
  jsonFile: (name: string, value: unknown) => Promise<string>;
}

/**
 * Route one Session through a Worker-owned model gateway. Only the Worker
 * resolves the upstream key and secret headers; the engine receives the
 * loopback URL, a random local token and the model alias. Vendor credentials
 * and the upstream secret sources are removed from the engine environment,
 * and every engine home points into the Session's private state.
 */
async function prepareGateway(context: GatewayPreparation): Promise<void> {
  const { spec, result, root, provider, resolve, hooks } = context;
  const adapter = spec.profile.configuration!.adapter;
  if (!routable(adapter))
    unsupported(
      "This engine cannot be routed through the HarnessHub model gateway; it would use its own account or provider",
    );
  const apiKey = provider.apiKey ? await resolve(provider.apiKey) : undefined;
  const secretHeaders = await secretMap(provider.secretHeaders, resolve);
  const headers = { ...provider.headers, ...secretHeaders };
  const alias = provider.modelAlias ?? HARNESS_MODEL_ALIAS;
  const gateway = await startModelGateway({
    upstream: {
      protocol: "openai-completions",
      baseUrl: provider.baseUrl!,
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    },
    model: spec.profile.model!,
    alias,
    ...(provider.contextWindow !== undefined
      ? { contextWindow: provider.contextWindow }
      : {}),
    ...(provider.maxOutputTokens !== undefined
      ? { maxOutputTokens: provider.maxOutputTokens }
      : {}),
    ...(provider.compatibility
      ? { compatibility: provider.compatibility }
      : {}),
    ...(hooks.onModelCall ? { onCall: hooks.onModelCall } : {}),
  });
  result.modelBridge = gateway;
  hooks.secrets?.add(gateway.token);
  try {
    isolateEnvironment(spec, result, provider);
    await privateHome(spec, result);
    const contextWindow =
      provider.contextWindow ?? DEFAULT_GATEWAY_CONTEXT_WINDOW;
    // Explicit limits are validated at registration and used unchanged; the
    // default never exceeds half of a small declared window.
    const maxOutputTokens =
      provider.maxOutputTokens ??
      Math.min(
        DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS,
        Math.floor(contextWindow / 2),
      );
    const wiring: GatewayWiring = {
      spec,
      result,
      root,
      alias,
      gateway,
      v1: `${gateway.baseUrl}/v1`,
      contextWindow,
      maxOutputTokens,
      fullAccess: context.fullAccess,
      jsonFile: async (name, value) => {
        const file = path.join(root, name);
        await writeFile(file, JSON.stringify(value, null, 2) + "\n", {
          mode: 0o600,
        });
        return file;
      },
    };
    result.env.HARNESSHUB_PROVIDER_KEY = gateway.token;
    await gatewayAdapters[adapter](wiring);
  } catch (error) {
    await gateway.close();
    delete result.modelBridge;
    throw error;
  }
}

/** Remove vendor credentials and upstream secret sources from the engine environment. */
function isolateEnvironment(
  spec: ExecutionSpec,
  result: PreparedConfiguration,
  provider: ModelProviderConfiguration,
): void {
  const adapter = spec.profile.configuration!.adapter;
  const names = new Set<string>([
    ...VENDOR_CREDENTIAL_ENVIRONMENT,
    ...(adapter === "copilot" ? COPILOT_ACCOUNT_ENVIRONMENT : []),
    ...(spec.profile.credentialEnv ?? []),
    ...[provider.apiKey, ...Object.values(provider.secretHeaders ?? {})]
      .filter((ref) => ref?.kind === "env")
      .map((ref) => ref!.value),
  ]);
  const upper = new Set(
    [...names, ...ENGINE_HOME_ENVIRONMENT].map((name) => name.toUpperCase()),
  );
  for (const name of Object.keys(result.env))
    if (upper.has(name.toUpperCase())) delete result.env[name];
  result.unsetEnv = [...names];
}

/**
 * Point every home/config root at the Session-private home (the same paths the
 * Worker host creates), overriding launch templates that reference the user's
 * real home so native logins, keys and OAuth tokens there are never read.
 */
async function privateHome(
  spec: ExecutionSpec,
  result: PreparedConfiguration,
): Promise<void> {
  const home = path.join(path.resolve(spec.stateDir), "home");
  const paths = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  };
  for (const directory of new Set(Object.values(paths)))
    await mkdir(directory, { recursive: true, mode: 0o700 });
  Object.assign(result.env, paths);
  // A proxy inherited from the launch template must not intercept loopback
  // gateway traffic.
  const bypass = new Set(
    (result.env.NO_PROXY ?? result.env.no_proxy ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const host of ["127.0.0.1", "localhost"]) bypass.add(host);
  result.env.NO_PROXY = result.env.no_proxy = [...bypass].join(",");
}

/** Adapters whose engine can reach the model gateway with a native protocol. */
type RoutableAdapter = Extract<
  ConfigurationAdapter,
  | "codex"
  | "claude"
  | "gemini"
  | "opencode"
  | "mimo"
  | "pi"
  | "qwen"
  | "hermes"
  | "openclaw"
  | "dsh"
  | "kimi"
  | "copilot"
>;
function routable(adapter: ConfigurationAdapter): adapter is RoutableAdapter {
  return Object.hasOwn(gatewayAdapters, adapter);
}
const gatewayAdapters: Record<
  RoutableAdapter,
  (wiring: GatewayWiring) => Promise<void>
> = {
  codex: codexGateway,
  claude: claudeGateway,
  gemini: geminiGateway,
  opencode: openCodeGateway,
  mimo: openCodeGateway,
  pi: piGateway,
  qwen: qwenGateway,
  hermes: hermesGateway,
  openclaw: openClawGateway,
  dsh: dshGateway,
  kimi: kimiGateway,
  copilot: copilotGateway,
};

/** Codex speaks Responses to the gateway; codex-acp approval modes stay explicit. */
/**
 * Codex 0.153.4 via codex-acp 1.10.0 speaks Responses to the gateway. Every
 * key below is typed by the pinned config schema: an invalid config.toml makes
 * app-server silently fall back to defaults (the OpenAI provider), so values
 * are fixed literals. The custom provider needs no OpenAI login; if a fallback
 * ever reports that login is required, codex-acp's default `api-key`
 * authentication uses the local token and the built-in OpenAI route also
 * resolves to the gateway. ChatGPT login, keyring stores, plugins, analytics
 * and the Guardian reviewer model are disabled.
 */
async function codexGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, v1, contextWindow, maxOutputTokens } = wiring;
  const codexHome = path.join(root, "codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const quote = JSON.stringify;
  const catalogFile = await wiring.jsonFile(
    "codex-models.json",
    codexGatewayCatalog(alias, contextWindow),
  );
  // Codex sends no output limit and compacts at 90% of the window by default;
  // keep one full output inside the declared window.
  const compactLimit = Math.max(
    1024,
    Math.min(Math.floor(contextWindow * 0.9), contextWindow - maxOutputTokens),
  );
  const lines = [
    `model = ${quote(alias)}`,
    'model_provider = "harnesshub"',
    `model_catalog_json = ${quote(catalogFile)}`,
    `model_context_window = ${contextWindow}`,
    `model_auto_compact_token_limit = ${compactLimit}`,
    'model_reasoning_effort = "none"',
    "model_supports_reasoning_summaries = false",
    'web_search = "disabled"',
    `openai_base_url = ${quote(v1)}`,
    'forced_login_method = "api"',
    'cli_auth_credentials_store = "ephemeral"',
    'mcp_oauth_credentials_store = "file"',
    "check_for_update_on_startup = false",
    "[model_providers.harnesshub]",
    'name = "HarnessHub"',
    `base_url = ${quote(v1)}`,
    'wire_api = "responses"',
    'env_key = "HARNESSHUB_PROVIDER_KEY"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "[features]",
    "plugins = false",
    "apps = false",
    "image_generation = false",
    "memories = false",
    "unbounded_connection_retries = false",
    "[analytics]",
    "enabled = false",
    "[otel]",
    'metrics_exporter = "none"',
  ];
  await writeFile(
    path.join(codexHome, "config.toml"),
    lines.join("\n") + "\n",
    { mode: 0o600 },
  );
  result.env.CODEX_HOME = codexHome;
  // Used by codex-acp only if its app-server reports that OpenAI auth is
  // required; the value is the local gateway token, never a vendor key.
  result.env.CODEX_API_KEY = wiring.gateway.token;
  result.env.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: "api-key" });
  result.env.NO_BROWSER = "1";
  // codex-acp's default mode reviews approvals with a separately hosted
  // Guardian model. Competition Full Access keeps its explicit full-access
  // mode; otherwise approvals return to HarnessHub through ACP.
  result.env.INITIAL_AGENT_MODE = wiring.fullAccess
    ? "agent-full-access"
    : "read-only";
  result.model = alias;
}

/** Claude Code accepts at most this many output tokens. */
const CLAUDE_MAXIMUM_OUTPUT = 128_000;

/**
 * Claude Code (claude-agent-acp 0.74/0.75) speaks Anthropic Messages to the
 * gateway. A fresh CLAUDE_CONFIG_DIR isolates stored logins (files and the
 * keychain entry are keyed by it); both the bearer and x-api-key sources are
 * the local token so no stored managed key is sent. Every model role maps to
 * the alias, non-essential traffic (bootstrap, telemetry, updates) is off, and
 * Anthropic-hosted web search is denied.
 */
async function claudeGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, gateway, contextWindow, maxOutputTokens } =
    wiring;
  const configDir = path.join(root, "claude");
  const profileDir = path.join(root, "anthropic");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify(
      { skipWebFetchPreflight: true, permissions: { deny: ["WebSearch"] } },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const models = Object.fromEntries(
    [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_CUSTOM_MODEL_OPTION",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ].map((name) => [name, alias]),
  );
  Object.assign(result.env, models, {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_CONFIG_DIR: profileDir,
    ANTHROPIC_BASE_URL: gateway.baseUrl,
    ANTHROPIC_AUTH_TOKEN: gateway.token,
    ANTHROPIC_API_KEY: gateway.token,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(
      Math.min(maxOutputTokens, CLAUDE_MAXIMUM_OUTPUT),
    ),
    MAX_THINKING_TOKENS: "0",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_UPDATES: "1",
    DISABLE_GROWTHBOOK: "1",
    DISABLE_BUG_COMMAND: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  });
  result.nativeModelSelection = true;
  result.model = alias;
}

/** Gemini CLI assumes 1,048,576 tokens for every unknown model name. */
const GEMINI_UNKNOWN_MODEL_WINDOW = 1_048_576;

/**
 * Gemini CLI 0.58.0 speaks Google generateContent to the gateway with the
 * `gemini-api-key` auth type. The system settings file wins over user and
 * workspace settings. Its `core` override forces every unscoped call (main
 * chat, chat compression and utility calls) to the alias; subagents, which use
 * their own scopes and fixed Gemini models, are disabled with the tools that
 * need Google-hosted models. Compression is scaled to the declared window
 * because Gemini sizes unknown models at 1M tokens.
 */
async function geminiGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, gateway, contextWindow, maxOutputTokens } =
    wiring;
  Object.assign(result.env, {
    GEMINI_API_KEY: gateway.token,
    GOOGLE_GEMINI_BASE_URL: gateway.baseUrl,
    GEMINI_MODEL: alias,
    GEMINI_CLI_HOME: root,
    GEMINI_CLI_TRUST_WORKSPACE: "true",
    // Keep API keys and OAuth tokens out of the OS keychain lookup.
    GEMINI_FORCE_FILE_STORAGE: "true",
    GEMINI_TELEMETRY_ENABLED: "false",
  });
  result.nativeModelSelection = true;
  const compressAt = Math.max(
    4096,
    Math.min(Math.floor(contextWindow * 0.8), contextWindow - maxOutputTokens),
  );
  const disabledAgents = [
    "codebase_investigator",
    "cli_help",
    "generalist",
    "browser_agent",
  ];
  result.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = await wiring.jsonFile(
    "gemini-settings.json",
    {
      security: {
        auth: { selectedType: "gemini-api-key" },
        enableConseca: false,
      },
      model: {
        name: alias,
        compressionThreshold:
          Math.ceil((compressAt / GEMINI_UNKNOWN_MODEL_WINDOW) * 10_000) /
          10_000,
        disableLoopDetection: true,
        skipNextSpeakerCheck: true,
      },
      telemetry: { enabled: false, logPrompts: false },
      privacy: { usageStatisticsEnabled: false },
      general: {
        enableAutoUpdate: false,
        enableAutoUpdateNotification: false,
        plan: { modelRouting: false },
      },
      ide: { enabled: false },
      advanced: { ignoreLocalEnv: true },
      experimental: {
        enableAgents: false,
        autoMemory: false,
        modelSteering: false,
        contextManagement: false,
      },
      agents: {
        overrides: Object.fromEntries(
          disabledAgents.map((name) => [name, { enabled: false }]),
        ),
      },
      tools: {
        exclude: ["google_web_search", "web_fetch", "invoke_agent"],
        disableLLMCorrection: true,
      },
      modelConfigs: {
        customOverrides: [
          {
            match: { overrideScope: "core" },
            modelConfig: {
              model: alias,
              generateContentConfig: {
                topK: null,
                maxOutputTokens,
                thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
              },
            },
          },
        ],
      },
    },
  );
  result.model = alias;
}

/**
 * OpenCode 1.18.29 and MiMo 0.1.14 (an OpenCode fork with the MIMOCODE_
 * prefix) use their bundled `@ai-sdk/openai-compatible` provider. Every
 * built-in agent, the small/title model and MiMo's model groups are pinned to
 * the alias; stored logins, provider env detection, catalog fetches, sharing
 * and analytics are disabled.
 */
async function openCodeGateway(wiring: GatewayWiring): Promise<void> {
  const { result, alias, v1, contextWindow, maxOutputTokens } = wiring;
  const mimo = wiring.spec.profile.configuration!.adapter === "mimo";
  const prefix = mimo ? "MIMOCODE" : "OPENCODE";
  const selection = `harnesshub/${alias}`;
  const pinned = { model: selection };
  result.env[`${prefix}_CONFIG_CONTENT`] = JSON.stringify({
    model: selection,
    small_model: selection,
    enabled_providers: ["harnesshub"],
    autoupdate: false,
    share: "disabled",
    agent: Object.fromEntries(
      [
        "build",
        "plan",
        "general",
        "explore",
        "title",
        "summary",
        "compaction",
      ].map((name) => [name, pinned]),
    ),
    ...(mimo
      ? {
          model_groups: {
            lite: selection,
            standard: selection,
            ultra: selection,
          },
        }
      : {}),
    provider: {
      harnesshub: {
        name: "HarnessHub",
        npm: "@ai-sdk/openai-compatible",
        models: {
          [alias]: {
            name: alias,
            tool_call: true,
            limit: { context: contextWindow, output: maxOutputTokens },
          },
        },
        options: { baseURL: v1, apiKey: "{env:HARNESSHUB_PROVIDER_KEY}" },
      },
    },
  });
  Object.assign(result.env, {
    [`${prefix}_DISABLE_AUTOUPDATE`]: "true",
    [`${prefix}_DISABLE_MODELS_FETCH`]: "1",
    [`${prefix}_DISABLE_LSP_DOWNLOAD`]: "1",
    [`${prefix}_DISABLE_SHARE`]: "1",
    // Ignore any stored provider login (auth.json) in the private data dir.
    [`${prefix}_AUTH_CONTENT`]: "{}",
    // Both engines cap output at 32000 unless this is raised.
    ...(maxOutputTokens > 32_000
      ? { [`${prefix}_EXPERIMENTAL_OUTPUT_TOKEN_MAX`]: String(maxOutputTokens) }
      : {}),
    ...(mimo
      ? {
          MIMOCODE_ENABLE_ANALYSIS: "false",
          MIMOCODE_DISABLE_PROVIDER_ENV: "1",
          MIMOCODE_DISABLE_CLAUDE_CODE: "1",
          MIMOCODE_DISABLE_CLAUDE_IMPORT: "1",
        }
      : { OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" }),
  });
  result.model = selection;
}

/** Chat compat flags understood by pi-ai 0.85 (Pi, DSH) for a plain OpenAI-compatible route. */
const plainChatCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
};

/**
 * Pi 0.85.1 reads models.json/settings.json from PI_CODING_AGENT_DIR. Without
 * explicit values Pi assumes 128K/16384; compaction reserves room for one
 * full output. PI_OFFLINE disables version, catalog and tool downloads.
 */
async function piGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, v1, contextWindow, maxOutputTokens } = wiring;
  await wiring.jsonFile("models.json", {
    providers: {
      harnesshub: {
        baseUrl: v1,
        api: "openai-completions",
        apiKey: "$HARNESSHUB_PROVIDER_KEY",
        models: [
          {
            id: alias,
            name: alias,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens: maxOutputTokens,
            compat: plainChatCompat,
          },
        ],
      },
    },
  });
  await wiring.jsonFile("settings.json", {
    defaultProvider: "harnesshub",
    defaultModel: alias,
    defaultThinkingLevel: "off",
    enableInstallTelemetry: false,
    compaction: {
      enabled: true,
      reserveTokens: Math.max(16_384, maxOutputTokens + 4_096),
      keepRecentTokens: 20_000,
    },
  });
  result.env.PI_CODING_AGENT_DIR = root;
  result.env.PI_SKIP_VERSION_CHECK = "1";
  result.env.PI_OFFLINE = "1";
  result.env.PI_TELEMETRY = "0";
  result.model = `harnesshub/${alias}`;
}

/**
 * Qwen Code 0.23.0 uses its OpenAI auth type with the local token (a missing
 * key blocks session creation). The system settings file wins over user and
 * workspace files and pins the window, output cap and auth type; follow-up
 * suggestions, managed memory, web search and usage statistics are disabled.
 */
async function qwenGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, v1, gateway, contextWindow, maxOutputTokens } =
    wiring;
  const qwenHome = path.join(root, "qwen");
  await mkdir(qwenHome, { recursive: true, mode: 0o700 });
  Object.assign(result.env, {
    OPENAI_BASE_URL: v1,
    OPENAI_MODEL: alias,
    OPENAI_API_KEY: gateway.token,
    QWEN_HOME: qwenHome,
    QWEN_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    QWEN_DISABLE_AUTO_TITLE: "1",
    QWEN_USAGE_STATISTICS_ENABLED: "0",
  });
  result.env.QWEN_CODE_SYSTEM_SETTINGS_PATH = await wiring.jsonFile(
    "qwen-settings.json",
    {
      security: { auth: { selectedType: "openai" } },
      model: {
        name: alias,
        skipNextSpeakerCheck: true,
        skipLoopDetection: true,
        generationConfig: {
          contextWindowSize: contextWindow,
          samplingParams: { max_tokens: maxOutputTokens },
        },
      },
      privacy: { usageStatisticsEnabled: false },
      telemetry: { enabled: false },
      general: { enableAutoUpdate: false },
      ide: { enabled: false },
      ui: { enableFollowupSuggestions: false },
      memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
      tools: { webSearch: { enabled: false } },
    },
  );
  result.model = `$runtime|openai|${alias}(openai)`;
}

/** Hermes rejects windows below this many tokens at startup. */
const HERMES_MINIMUM_CONTEXT = 64_000;
/** Hermes 0.19.0 helper tasks; each would otherwise auto-select a provider. */
const HERMES_AUXILIARY_TASKS = [
  "vision",
  "web_extract",
  "compression",
  "skills_hub",
  "approval",
  "mcp",
  "memory_query_rewrite",
  "tts_audio_tags",
  "triage_specifier",
  "kanban_decomposer",
  "profile_describer",
  "goal_judge",
  "curator",
  "monitor",
  "background_review",
  "moa_reference",
  "moa_aggregator",
];

/**
 * Hermes 0.19.0 selects its model only from the private config.yaml: ACP
 * model selection re-resolves the provider and can route a name that matches
 * the OpenRouter catalog away from the gateway, so it is never sent. Every
 * helper task is pinned to the same custom route, fallback providers and
 * title generation are disabled, and machine-wide overlays are redirected to
 * a private empty directory.
 */
async function hermesGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, v1, gateway, contextWindow, maxOutputTokens } =
    wiring;
  if (contextWindow < HERMES_MINIMUM_CONTEXT)
    unsupported(
      `Hermes requires a model context window of at least ${HERMES_MINIMUM_CONTEXT} tokens`,
    );
  const managed = path.join(root, "hermes-managed");
  await mkdir(managed, { recursive: true, mode: 0o700 });
  const route = {
    provider: "custom",
    model: alias,
    base_url: v1,
    key_env: "HARNESSHUB_PROVIDER_KEY",
  };
  const auxiliary: Record<string, unknown> = Object.fromEntries(
    HERMES_AUXILIARY_TASKS.map((task) => [task, route]),
  );
  auxiliary.compression = { ...route, context_length: contextWindow };
  auxiliary.title_generation = { enabled: false };
  await writeFile(
    path.join(root, "config.yaml"),
    stringifyYaml({
      model: {
        provider: "custom",
        default: alias,
        base_url: v1,
        context_length: contextWindow,
        max_tokens: maxOutputTokens,
      },
      providers: {
        custom: {
          base_url: v1,
          default_model: alias,
          transport: "chat_completions",
          key_env: "HARNESSHUB_PROVIDER_KEY",
          models: { [alias]: { context_length: contextWindow } },
        },
      },
      fallback_providers: [],
      auxiliary,
      approvals: { mode: "manual" },
      memory: { nudge_interval: 0 },
      skills: { creation_nudge_interval: 0 },
      model_catalog: { enabled: false },
      security: { allow_lazy_installs: false, tirith_enabled: false },
      lsp: { install_strategy: "manual" },
    }),
    { mode: 0o600 },
  );
  Object.assign(result.env, {
    HERMES_HOME: root,
    HERMES_MANAGED_DIR: managed,
    TIRITH_ENABLED: "0",
    CUSTOM_BASE_URL: v1,
    // Pinned helper tasks fall back to this variable for the same route.
    OPENAI_API_KEY: gateway.token,
  });
  result.nativeModelSelection = true;
  result.model = `custom:${alias}`;
}

/**
 * OpenClaw 2026.9.2 reads one private openclaw.json. Every agent model role
 * (primary, utility, compaction, memory flush, subagents) is the alias; the
 * OpenAI-embedding memory search, media/web tools that auto-pick other
 * providers, heartbeat and update checks are disabled.
 */
async function openClawGateway(wiring: GatewayWiring): Promise<void> {
  const { spec, result, root, alias, v1, contextWindow, maxOutputTokens } =
    wiring;
  result.nativeModelSelection = true;
  // SecretRef preserves the environment variable name when OpenClaw writes
  // its models catalog; an interpolated ${KEY} could persist the value.
  const nativeModel = `harnesshub/${alias}`;
  result.env.OPENCLAW_STATE_DIR = root;
  result.env.OPENCLAW_NO_AUTO_UPDATE = "1";
  result.env.OPENCLAW_OFFLINE = "1";
  result.env.DO_NOT_TRACK = "1";
  result.env.OPENCLAW_CONFIG_PATH = await wiring.jsonFile("openclaw.json", {
    update: { checkOnStart: false, auto: { enabled: false } },
    secrets: {
      providers: {
        harnesshub: { source: "env", allowlist: ["HARNESSHUB_PROVIDER_KEY"] },
      },
    },
    models: {
      mode: "replace",
      catalogRefresh: { enabled: false },
      providers: {
        harnesshub: {
          baseUrl: v1,
          api: "openai-completions",
          apiKey: {
            source: "env",
            provider: "harnesshub",
            id: "HARNESSHUB_PROVIDER_KEY",
          },
          models: [
            {
              id: alias,
              name: alias,
              reasoning: false,
              input: ["text"],
              contextWindow,
              maxTokens: maxOutputTokens,
            },
          ],
        },
      },
    },
    memory: { search: { enabled: false } },
    tools: {
      media: { image: { enabled: false } },
      web: { search: { enabled: false } },
    },
    agents: {
      defaults: {
        model: { primary: nativeModel, fallbacks: [] },
        models: { [nativeModel]: {} },
        utilityModel: nativeModel,
        compaction: {
          model: nativeModel,
          memoryFlush: { model: nativeModel },
        },
        subagents: { model: nativeModel },
        heartbeat: { every: "0m" },
        workspace: spec.cwd,
      },
    },
  });
  result.model = nativeModel;
}

/**
 * DSH 0.1.2-rc.1 `--patch` overlay. Without explicit limits DSH assumes
 * 262144/32768 for the route; compaction, titles and subagents use the
 * session model. Telemetry is disabled by DSH_TELEMETRY_DISABLED.
 */
async function dshGateway(wiring: GatewayWiring): Promise<void> {
  const { result, root, alias, v1, contextWindow, maxOutputTokens } = wiring;
  dshLaunchTemplate(result.command);
  // DSH 0.1.2-rc.1 overlays replace an entry's config. Configure the native
  // route and both defaults; ACP's selector carries the full route as JSON.
  const selection = { provider: "harnesshub", model: alias };
  const file = await wiring.jsonFile("dsh.patch.json", [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          harnesshub: {
            api: "openai-completions",
            baseURL: v1,
            apiKeyEnv: "HARNESSHUB_PROVIDER_KEY",
            defaultContextWindow: contextWindow,
            defaultMaxTokens: maxOutputTokens,
            models: [
              {
                id: alias,
                name: alias,
                contextWindow,
                maxTokens: maxOutputTokens,
                input: ["text"],
                reasoningEfforts: false,
                compat: plainChatCompat,
              },
            ],
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
  result.model = JSON.stringify([selection.provider, alias]);
}

/**
 * Kimi 1.50.0 print CLI with a private `--config-file`. Its `openai_legacy`
 * provider takes OPENAI_BASE_URL/OPENAI_API_KEY over the file values and never
 * sends an output limit (the gateway enforces maxOutputTokens); the window
 * comes from the unified model, else the configured KIMI_MODEL_MAX_CONTEXT_SIZE
 * (which Kimi itself reads only for its own provider type).
 */
async function kimiGateway(wiring: GatewayWiring): Promise<void> {
  const { spec, result, root, alias, v1, gateway, maxOutputTokens } = wiring;
  kimiLaunchTemplate(result.command);
  const configured =
    spec.profile.configuration!.env?.KIMI_MODEL_MAX_CONTEXT_SIZE;
  const contextWindow =
    spec.profile.configuration!.provider?.contextWindow ??
    (configured ? Number(configured) : wiring.contextWindow);
  // Kimi 1.50.0's print CLI accepts this file. Its ACP server requires native
  // OAuth and its deprecated --acp mode rejects every protocol method.
  const file = await wiring.jsonFile("kimi.json", {
    default_model: alias,
    default_thinking: false,
    telemetry: false,
    merge_all_available_skills: false,
    providers: {
      harnesshub: { type: "openai_legacy", base_url: v1, api_key: "" },
    },
    models: {
      [alias]: {
        provider: "harnesshub",
        model: alias,
        max_context_size: contextWindow,
      },
    },
    // Default 50000 would compact very early in a small window.
    loop_control: {
      reserved_context_size: Math.max(
        1000,
        Math.min(maxOutputTokens, Math.floor(contextWindow / 2)),
      ),
    },
  });
  result.command.push("--config-file", file);
  Object.assign(result.env, {
    KIMI_SHARE_DIR: path.join(root, "kimi"),
    KIMI_DISABLE_TELEMETRY: "1",
    KIMI_CLI_NO_AUTO_UPDATE: "1",
    OPENAI_BASE_URL: v1,
    OPENAI_API_KEY: gateway.token,
  });
}

async function copilotGateway(wiring: GatewayWiring): Promise<void> {
  const { result, alias, v1, gateway } = wiring;
  copilotLaunchTemplate(result.command);
  result.nativeModelSelection = true;
  result.env.COPILOT_PROVIDER_TYPE = "openai";
  result.env.COPILOT_PROVIDER_BASE_URL = v1;
  result.env.COPILOT_PROVIDER_API_KEY = gateway.token;
  result.env.COPILOT_MODEL = alias;
  result.env.COPILOT_OFFLINE = "true";
}

function dshLaunchTemplate(command: string[]): void {
  const profileAt = command.indexOf("--profile");
  if (
    profileAt < 0 ||
    command[profileAt + 1] !== "acp" ||
    profileAt !== command.length - 2 ||
    command.some((arg) => arg === "--patch" || arg.startsWith("--patch="))
  )
    unsupported(
      "DSH managed providers require the standard --profile acp launch template without trailing application arguments or fixed patches",
    );
}
function kimiLaunchTemplate(command: string[]): void {
  if (
    command.some((arg) => /^(?:--config(?:-file)?(?:=|$)|--?acp$)/.test(arg)) ||
    command.includes("acp") ||
    !command.some((arg) => arg === "--quiet" || arg === "--print")
  )
    unsupported(
      "Kimi managed providers require a CLI --quiet/--print template without fixed --config/--config-file or ACP arguments",
    );
}
function copilotLaunchTemplate(command: string[]): void {
  if (command.some((arg) => arg === "--model" || arg.startsWith("--model=")))
    unsupported(
      "Remove the fixed Copilot --model argument before applying managed provider settings",
    );
}

/**
 * Direct native provider mapping for non-Chat upstream protocols. The engine
 * receives the resolved upstream key; no gateway is started.
 */
async function prepareDirectProvider(
  spec: ExecutionSpec,
  result: PreparedConfiguration,
  root: string,
  provider: ModelProviderConfiguration,
  resolve: Resolver,
): Promise<void> {
  const config = spec.profile.configuration!;
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
      const lines = [
        `model = ${quote(model)}`,
        'model_provider = "harnesshub"',
        ...(catalogFile ? [`model_catalog_json = ${quote(catalogFile)}`] : []),
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
          : "@ai-sdk/openai";
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
      dshLaunchTemplate(result.command);
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
    case "gemini":
      if (key) result.env.GEMINI_API_KEY = key;
      if (provider.baseUrl)
        result.env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl;
      break;
    case "kimi": {
      kimiLaunchTemplate(result.command);
      const type = {
        "openai-completions": "openai_legacy",
        "openai-responses": "openai_responses",
        anthropic: "anthropic",
        google: "gemini",
      }[provider.protocol];
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
      copilotLaunchTemplate(result.command);
      result.nativeModelSelection = true;
      result.env.COPILOT_PROVIDER_TYPE = "anthropic";
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
}
