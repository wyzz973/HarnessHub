import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { normalizeEngine } from "../../src/engine/registry.js";
import {
  prepareConfiguration,
  VENDOR_CREDENTIAL_ENVIRONMENT,
  type PreparedConfiguration,
} from "../../src/drivers/configuration/prepare.js";
import type {
  EngineProfile,
  RunId,
  SessionId,
} from "../../src/domain/types.js";
import type { ConfigurationAdapter } from "../../src/domain/engine-configuration.js";

const upstreamKey = "synthetic-upstream-company-key-0001";
const headerSecret = "synthetic-upstream-header-secret-0002";
const environment = {
  HH_UNIT_COMPANY_KEY: upstreamKey,
  HH_UNIT_HEADER_SECRET: headerSecret,
};
const provider = {
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:9/company/v1",
  apiKey: { kind: "env", value: "HH_UNIT_COMPANY_KEY" },
  headers: { "X-Tenant": "unit" },
  secretHeaders: {
    "X-Signature": { kind: "env", value: "HH_UNIT_HEADER_SECRET" },
  },
  contextWindow: 65536,
  maxOutputTokens: 8192,
};
function command(adapter: ConfigurationAdapter): string[] {
  if (adapter === "kimi")
    return [process.execPath, "kimi.js", "--quiet", "--prompt", "{prompt}"];
  if (adapter === "dsh")
    return [process.execPath, "dsh.js", "--profile", "acp"];
  // A discovered template that points the engine at the user's real home and
  // a vendor endpoint (registration already rejects secret-looking argv).
  return [
    "/usr/bin/env",
    "HOME=/Users/real-user",
    "XDG_CONFIG_HOME=/Users/real-user/.config",
    "OPENAI_BASE_URL=https://vendor.example.invalid/v1",
    "GOOGLE_GENAI_USE_VERTEXAI=true",
    "CODEX_HOME=/Users/real-user/.codex",
    process.execPath,
    "engine.js",
  ];
}
function routed(
  adapter: ConfigurationAdapter,
  overrides: Record<string, unknown> = {},
): EngineProfile {
  return normalizeEngine({
    id: adapter,
    driver: adapter === "kimi" ? "cli" : "acp",
    command: command(adapter),
    model: "company-real-model",
    credentialEnv: ["DEEPSEEK_API_KEY"],
    ...(adapter === "kimi"
      ? { cli: { inputMode: "argv", maxOutputBytes: 1048576 } }
      : {}),
    configuration: { adapter, provider },
    ...overrides,
  });
}
async function prepare(
  t: TestContext,
  profile: EngineProfile,
  extra: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), `hh-gateway-${profile.id}-`));
  const secrets = new Set<string>();
  const prepared = await prepareConfiguration(
    {
      profile,
      cwd: root,
      stateDir: path.join(root, "state"),
      sessionId: "session" as SessionId,
      runId: "run" as RunId,
      generation: 1,
      input: { text: "", timeoutMs: 1000 },
    },
    { ...environment, ...extra },
    { secrets },
  );
  t.after(async () => {
    await prepared.modelBridge?.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, state: path.join(root, "state"), prepared, secrets };
}
async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await files(file)));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}
/** Invariants every gateway-routed adapter must satisfy. */
async function assertIsolated(
  prepared: PreparedConfiguration,
  state: string,
  secrets: Set<string>,
) {
  const gateway = prepared.modelBridge;
  assert.ok(gateway, "a gateway-routed engine owns a Session gateway");
  assert.match(gateway.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(prepared.env.HARNESSHUB_PROVIDER_KEY, gateway.token);
  assert.deepEqual(
    [...secrets].sort(),
    [upstreamKey, headerSecret, gateway.token].sort(),
  );
  const home = path.join(path.resolve(state), "home");
  assert.equal(prepared.env.HOME, home);
  assert.equal(prepared.env.USERPROFILE, home);
  assert.equal(prepared.env.XDG_CONFIG_HOME, path.join(home, ".config"));
  for (const name of [
    ...VENDOR_CREDENTIAL_ENVIRONMENT,
    "DEEPSEEK_API_KEY",
    "HH_UNIT_COMPANY_KEY",
    "HH_UNIT_HEADER_SECRET",
  ])
    assert.ok(prepared.unsetEnv?.includes(name), name);
  const values =
    JSON.stringify(prepared.env) + JSON.stringify(prepared.command);
  for (const secret of [upstreamKey, headerSecret, "vendor.example.invalid"])
    assert.equal(values.includes(secret), false, secret);
  assert.equal(prepared.env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(values.includes("/Users/real-user"), false);
  for (const file of await files(state)) {
    const bytes = await readFile(file);
    for (const secret of [upstreamKey, headerSecret, gateway.token])
      assert.equal(bytes.includes(Buffer.from(secret)), false, file);
  }
}

void test("Codex speaks Responses to the gateway alias with a generated catalog and keeps Full Access", async (t) => {
  const { prepared, state, secrets } = await prepare(t, routed("codex"));
  await assertIsolated(prepared, state, secrets);
  const gateway = prepared.modelBridge!;
  assert.equal(
    prepared.env.CODEX_HOME,
    path.join(state, "configuration", "codex"),
  );
  const config = await readFile(
    path.join(prepared.env.CODEX_HOME!, "config.toml"),
    "utf8",
  );
  for (const line of [
    'model = "harnesshub-model"',
    'model_provider = "harnesshub"',
    "model_context_window = 65536",
    `base_url = "${gateway.baseUrl}/v1"`,
    `openai_base_url = "${gateway.baseUrl}/v1"`,
    'wire_api = "responses"',
    'env_key = "HARNESSHUB_PROVIDER_KEY"',
    "requires_openai_auth = false",
    'forced_login_method = "api"',
    'cli_auth_credentials_store = "ephemeral"',
    "plugins = false",
  ])
    assert.ok(config.split("\n").includes(line), line);
  const catalogPath = JSON.parse(
    /^model_catalog_json = (.+)$/m.exec(config)![1]!,
  ) as string;
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    models: { slug: string; context_window: number }[];
  };
  assert.deepEqual(
    catalog.models.map((model) => [model.slug, model.context_window]),
    [["harnesshub-model", 65536]],
  );
  assert.equal(prepared.env.CODEX_API_KEY, gateway.token);
  assert.equal(prepared.env.INITIAL_AGENT_MODE, "read-only");
  assert.equal(prepared.model, "harnesshub-model");
  // Competition Full Access, from the Gateway switch or the bundled command.
  const switched = await prepare(t, routed("codex"), {
    HARNESSHUB_FULL_ACCESS: "1",
  });
  assert.equal(switched.prepared.env.INITIAL_AGENT_MODE, "agent-full-access");
  const bundled = await prepare(
    t,
    routed("codex", {
      command: [
        "/usr/bin/env",
        "INITIAL_AGENT_MODE=agent-full-access",
        process.execPath,
        "codex-acp.js",
      ],
    }),
  );
  assert.equal(bundled.prepared.env.INITIAL_AGENT_MODE, "agent-full-access");
});

void test("Claude Code uses the gateway token and alias for every model role", async (t) => {
  const { prepared, state, secrets } = await prepare(t, routed("claude"));
  await assertIsolated(prepared, state, secrets);
  const gateway = prepared.modelBridge!;
  assert.equal(prepared.env.ANTHROPIC_BASE_URL, gateway.baseUrl);
  assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN, gateway.token);
  for (const name of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ])
    assert.equal(prepared.env[name], "harnesshub-model", name);
  assert.equal(prepared.env.ANTHROPIC_API_KEY, gateway.token);
  assert.equal(prepared.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
  assert.equal(prepared.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
  assert.equal(prepared.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(prepared.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(prepared.env.DISABLE_TELEMETRY, "1");
  const settings = JSON.parse(
    await readFile(
      path.join(prepared.env.CLAUDE_CONFIG_DIR!, "settings.json"),
      "utf8",
    ),
  ) as { permissions: { deny: string[] } };
  assert.deepEqual(settings.permissions.deny, ["WebSearch"]);
  assert.equal(
    prepared.env.CLAUDE_CONFIG_DIR,
    path.join(state, "configuration", "claude"),
  );
  assert.equal(prepared.nativeModelSelection, true);
});

void test("Gemini speaks Google generateContent with one model and no experimental agents", async (t) => {
  const { prepared, state, secrets } = await prepare(t, routed("gemini"));
  await assertIsolated(prepared, state, secrets);
  const gateway = prepared.modelBridge!;
  assert.equal(prepared.env.GEMINI_API_KEY, gateway.token);
  assert.equal(prepared.env.GOOGLE_GEMINI_BASE_URL, gateway.baseUrl);
  assert.equal(prepared.nativeModelSelection, true);
  const settings = JSON.parse(
    await readFile(prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, "utf8"),
  ) as {
    model: { name: string };
    security: { auth: { selectedType: string } };
    experimental: { enableAgents: boolean };
    modelConfigs: {
      customOverrides: {
        modelConfig: {
          model: string;
          generateContentConfig: { maxOutputTokens: number };
        };
      }[];
    };
  };
  assert.equal(settings.model.name, "harnesshub-model");
  assert.equal(settings.security.auth.selectedType, "gemini-api-key");
  assert.equal(settings.experimental.enableAgents, false);
  const core = settings.modelConfigs.customOverrides[0]!.modelConfig;
  assert.equal(core.model, "harnesshub-model");
  assert.equal(core.generateContentConfig.maxOutputTokens, 8192);
});

for (const adapter of ["opencode", "mimo"] as const)
  void test(`${adapter} pins every agent to the gateway alias with explicit limits`, async (t) => {
    const { prepared, state, secrets } = await prepare(t, routed(adapter));
    await assertIsolated(prepared, state, secrets);
    const prefix = adapter === "mimo" ? "MIMOCODE" : "OPENCODE";
    const content = JSON.parse(prepared.env[`${prefix}_CONFIG_CONTENT`]!) as {
      model: string;
      small_model: string;
      enabled_providers: string[];
      agent: Record<string, { model: string }>;
      model_groups?: Record<string, string>;
      provider: {
        harnesshub: {
          npm: string;
          options: { baseURL: string; apiKey: string };
          models: Record<
            string,
            { limit: { context: number; output: number } }
          >;
        };
      };
    };
    assert.equal(content.model, "harnesshub/harnesshub-model");
    assert.equal(content.small_model, content.model);
    assert.deepEqual(content.enabled_providers, ["harnesshub"]);
    assert.ok(
      Object.values(content.agent).every((a) => a.model === content.model),
    );
    const route = content.provider.harnesshub;
    assert.equal(route.npm, "@ai-sdk/openai-compatible");
    assert.equal(route.options.baseURL, `${prepared.modelBridge!.baseUrl}/v1`);
    assert.equal(route.options.apiKey, "{env:HARNESSHUB_PROVIDER_KEY}");
    assert.deepEqual(route.models["harnesshub-model"]!.limit, {
      context: 65536,
      output: 8192,
    });
    assert.equal(prepared.env[`${prefix}_DISABLE_MODELS_FETCH`], "1");
    assert.equal(prepared.env[`${prefix}_AUTH_CONTENT`], "{}");
    if (adapter === "mimo") {
      assert.equal(prepared.env.MIMOCODE_ENABLE_ANALYSIS, "false");
      assert.equal(prepared.env.MIMOCODE_DISABLE_PROVIDER_ENV, "1");
      assert.deepEqual(Object.values(content.model_groups!), [
        content.model,
        content.model,
        content.model,
      ]);
    }
    assert.equal(prepared.model, "harnesshub/harnesshub-model");
  });

void test("Pi, OpenClaw and DSH write the gateway route and model limits into native files", async (t) => {
  const pi = await prepare(t, routed("pi"));
  await assertIsolated(pi.prepared, pi.state, pi.secrets);
  const v1 = (prepared: PreparedConfiguration) =>
    `${prepared.modelBridge!.baseUrl}/v1`;
  const models = JSON.parse(
    await readFile(
      path.join(pi.prepared.env.PI_CODING_AGENT_DIR!, "models.json"),
      "utf8",
    ),
  ) as {
    providers: {
      harnesshub: {
        baseUrl: string;
        apiKey: string;
        models: { id: string; contextWindow: number; maxTokens: number }[];
      };
    };
  };
  assert.equal(models.providers.harnesshub.baseUrl, v1(pi.prepared));
  assert.equal(models.providers.harnesshub.apiKey, "$HARNESSHUB_PROVIDER_KEY");
  assert.deepEqual(
    models.providers.harnesshub.models.map((m) => [
      m.id,
      m.contextWindow,
      m.maxTokens,
    ]),
    [["harnesshub-model", 65536, 8192]],
  );
  assert.equal(pi.prepared.model, "harnesshub/harnesshub-model");

  const claw = await prepare(t, routed("openclaw"));
  await assertIsolated(claw.prepared, claw.state, claw.secrets);
  const native = JSON.parse(
    await readFile(claw.prepared.env.OPENCLAW_CONFIG_PATH!, "utf8"),
  ) as {
    models: {
      providers: {
        harnesshub: {
          baseUrl: string;
          models: { id: string; contextWindow: number; maxTokens: number }[];
        };
      };
    };
    memory: { search: { enabled: boolean } };
    agents: {
      defaults: {
        model: { primary: string };
        utilityModel: string;
        subagents: { model: string };
      };
    };
  };
  assert.equal(native.models.providers.harnesshub.baseUrl, v1(claw.prepared));
  assert.deepEqual(
    native.models.providers.harnesshub.models.map((m) => [
      m.id,
      m.contextWindow,
      m.maxTokens,
    ]),
    [["harnesshub-model", 65536, 8192]],
  );
  assert.equal(native.memory.search.enabled, false);
  for (const selected of [
    native.agents.defaults.model.primary,
    native.agents.defaults.utilityModel,
    native.agents.defaults.subagents.model,
  ])
    assert.equal(selected, "harnesshub/harnesshub-model");
  assert.equal(claw.prepared.nativeModelSelection, true);

  const dsh = await prepare(t, routed("dsh"));
  await assertIsolated(dsh.prepared, dsh.state, dsh.secrets);
  const patch = JSON.parse(
    await readFile(dsh.prepared.command.at(-1)!, "utf8"),
  ) as {
    id: string;
    config: {
      providers?: {
        harnesshub: {
          baseURL: string;
          models: { id: string; contextWindow: number; maxTokens: number }[];
        };
      };
      model?: string;
    };
  }[];
  const route = patch[0]!.config.providers!.harnesshub;
  assert.equal(route.baseURL, v1(dsh.prepared));
  assert.deepEqual(
    route.models.map((m) => [m.id, m.contextWindow, m.maxTokens]),
    [["harnesshub-model", 65536, 8192]],
  );
  assert.deepEqual(
    patch.slice(1).map((entry) => entry.config.model),
    ["harnesshub-model", "harnesshub-model"],
  );
  assert.equal(
    dsh.prepared.model,
    JSON.stringify(["harnesshub", "harnesshub-model"]),
  );
});

void test("Qwen, Hermes, Kimi and Copilot use the gateway through their Chat settings", async (t) => {
  const qwen = await prepare(t, routed("qwen"));
  await assertIsolated(qwen.prepared, qwen.state, qwen.secrets);
  const qwenGateway = qwen.prepared.modelBridge!;
  assert.equal(qwen.prepared.env.OPENAI_BASE_URL, `${qwenGateway.baseUrl}/v1`);
  assert.equal(qwen.prepared.env.OPENAI_API_KEY, qwenGateway.token);
  assert.equal(qwen.prepared.env.OPENAI_MODEL, "harnesshub-model");
  assert.equal(qwen.prepared.model, "$runtime|openai|harnesshub-model(openai)");
  assert.equal(
    qwen.prepared.env.QWEN_HOME,
    path.join(qwen.state, "configuration", "qwen"),
  );
  const qwenSettings = JSON.parse(
    await readFile(qwen.prepared.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, "utf8"),
  ) as {
    security: { auth: { selectedType: string } };
    model: {
      name: string;
      generationConfig: {
        contextWindowSize: number;
        samplingParams: { max_tokens: number };
      };
    };
    privacy: { usageStatisticsEnabled: boolean };
  };
  assert.equal(qwenSettings.security.auth.selectedType, "openai");
  assert.equal(qwenSettings.model.name, "harnesshub-model");
  assert.equal(qwenSettings.model.generationConfig.contextWindowSize, 65536);
  assert.equal(
    qwenSettings.model.generationConfig.samplingParams.max_tokens,
    8192,
  );
  assert.equal(qwenSettings.privacy.usageStatisticsEnabled, false);

  const hermes = await prepare(t, routed("hermes"));
  await assertIsolated(hermes.prepared, hermes.state, hermes.secrets);
  const hermesV1 = `${hermes.prepared.modelBridge!.baseUrl}/v1`;
  const yaml = parse(
    await readFile(
      path.join(hermes.prepared.env.HERMES_HOME!, "config.yaml"),
      "utf8",
    ),
  ) as {
    model: {
      provider: string;
      default: string;
      base_url: string;
      context_length: number;
    };
    providers: { custom: { base_url: string; key_env: string } };
    fallback_providers: unknown[];
    auxiliary: Record<string, Record<string, unknown>>;
  };
  assert.equal(yaml.model.provider, "custom");
  assert.equal(yaml.model.default, "harnesshub-model");
  assert.equal(yaml.model.base_url, hermesV1);
  assert.equal(yaml.model.context_length, 65536);
  assert.equal(yaml.providers.custom.base_url, hermesV1);
  assert.equal(yaml.providers.custom.key_env, "HARNESSHUB_PROVIDER_KEY");
  assert.deepEqual(yaml.fallback_providers, []);
  assert.deepEqual(yaml.auxiliary.compression, {
    provider: "custom",
    model: "harnesshub-model",
    base_url: hermesV1,
    key_env: "HARNESSHUB_PROVIDER_KEY",
    context_length: 65536,
  });
  assert.equal(yaml.auxiliary.vision!.base_url, hermesV1);
  assert.deepEqual(yaml.auxiliary.title_generation, { enabled: false });
  assert.equal(
    hermes.prepared.env.HERMES_MANAGED_DIR,
    path.join(hermes.state, "configuration", "hermes-managed"),
  );
  // Hermes re-routes on ACP model selection; the native file selects instead.
  assert.equal(hermes.prepared.nativeModelSelection, true);
  // Hermes refuses windows below 64000 tokens; fail before starting it.
  await assert.rejects(
    prepare(
      t,
      routed("hermes", {
        configuration: {
          adapter: "hermes",
          provider: {
            ...provider,
            contextWindow: 32768,
            maxOutputTokens: 4096,
          },
        },
      }),
    ),
    { code: "ENGINE_CONFIGURATION_UNSUPPORTED" },
  );

  const kimi = await prepare(t, routed("kimi"));
  await assertIsolated(kimi.prepared, kimi.state, kimi.secrets);
  const kimiGateway = kimi.prepared.modelBridge!;
  const kimiCommand = kimi.prepared.command;
  assert.equal(
    kimiCommand[kimiCommand.indexOf("--model") + 1],
    "harnesshub-model",
  );
  const kimiConfig = JSON.parse(
    await readFile(
      kimiCommand[kimiCommand.indexOf("--config-file") + 1]!,
      "utf8",
    ),
  ) as {
    default_model: string;
    telemetry: boolean;
    providers: { harnesshub: { type: string; base_url: string } };
    models: Record<string, { max_context_size: number }>;
    loop_control: { reserved_context_size: number };
  };
  assert.equal(kimiConfig.default_model, "harnesshub-model");
  assert.equal(kimiConfig.telemetry, false);
  assert.equal(kimiConfig.providers.harnesshub.type, "openai_legacy");
  assert.equal(
    kimiConfig.providers.harnesshub.base_url,
    `${kimiGateway.baseUrl}/v1`,
  );
  assert.equal(kimiConfig.models["harnesshub-model"]!.max_context_size, 65536);
  assert.equal(kimiConfig.loop_control.reserved_context_size, 8192);
  // openai_legacy takes these over the file and never sends an output limit.
  assert.equal(kimi.prepared.env.OPENAI_BASE_URL, `${kimiGateway.baseUrl}/v1`);
  assert.equal(kimi.prepared.env.OPENAI_API_KEY, kimiGateway.token);

  const copilot = await prepare(t, routed("copilot"));
  await assertIsolated(copilot.prepared, copilot.state, copilot.secrets);
  const copilotGateway = copilot.prepared.modelBridge!;
  assert.equal(copilot.prepared.env.COPILOT_PROVIDER_TYPE, "openai");
  assert.equal(
    copilot.prepared.env.COPILOT_PROVIDER_BASE_URL,
    `${copilotGateway.baseUrl}/v1`,
  );
  assert.equal(
    copilot.prepared.env.COPILOT_PROVIDER_API_KEY,
    copilotGateway.token,
  );
  assert.equal(copilot.prepared.env.COPILOT_MODEL, "harnesshub-model");
  assert.equal(copilot.prepared.env.COPILOT_OFFLINE, "true");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"])
    assert.ok(copilot.prepared.unsetEnv?.includes(name), name);
});

void test("engines that cannot reach the gateway reject a managed provider before starting one", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hh-gateway-unroutable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const adapter of [
    "generic",
    "cursor",
    "antigravity",
    "kiro",
    "qoder",
  ] as const) {
    assert.throws(
      () =>
        normalizeEngine({
          id: adapter,
          driver: "acp",
          command: [process.execPath, "engine.js"],
          model: "company-real-model",
          configuration: { adapter, provider },
        }),
      { code: "INVALID_ENGINE_CONFIGURATION" },
    );
    // A profile that bypassed registration still fails explicitly at preparation.
    const profile: EngineProfile = {
      id: adapter,
      driver: "acp",
      revision: "unroutable",
      enabled: true,
      command: [process.execPath, "engine.js"],
      model: "company-real-model",
      maxConcurrency: 1,
      capabilities: { resume: false, permissions: true, images: false },
      configuration: {
        adapter,
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
        },
      },
    };
    await assert.rejects(
      prepareConfiguration(
        {
          profile,
          cwd: root,
          stateDir: path.join(root, adapter),
          sessionId: "s" as SessionId,
          runId: "r" as RunId,
          generation: 1,
          input: { text: "", timeoutMs: 1000 },
        },
        {},
      ),
      { code: "ENGINE_CONFIGURATION_UNSUPPORTED" },
    );
  }
});

void test("non-Chat providers keep their direct native mapping without a gateway", async (t) => {
  const direct = await prepare(
    t,
    routed("codex", {
      configuration: {
        adapter: "codex",
        provider: {
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: { kind: "env", value: "HH_UNIT_COMPANY_KEY" },
        },
      },
    }),
  );
  assert.equal(direct.prepared.modelBridge, undefined);
  assert.equal(direct.prepared.unsetEnv, undefined);
  assert.equal(direct.prepared.env.HARNESSHUB_PROVIDER_KEY, upstreamKey);
});

void test("stdio MCP arguments and env values receive the Session workspace at run time only", async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), "hh-workspace-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const placeholder = "${HARNESSHUB_SESSION_WORKSPACE}";
  // A Windows competition directory with spaces, Chinese and `$` sequences.
  const workspace = "C:\\Users\\评测 用户\\比赛 目录\\$& $1 work";
  const stdio = {
    name: "local",
    type: "stdio",
    enabled: true,
    command: process.execPath,
    args: ["server.js", "--root", placeholder, `--out=${placeholder}\\out`],
    env: { WORKDIR: placeholder, BOTH: `${placeholder};${placeholder}` },
    secretEnv: { TOKEN: { kind: "env", value: "HH_LITERAL_SECRET" } },
  };
  const remote = {
    name: "remote",
    type: "http",
    enabled: true,
    url: `http://127.0.0.1:1/${placeholder}/mcp`,
    headers: { "X-Workspace": placeholder },
  };
  const run = async (
    adapter: ConfigurationAdapter,
    servers: Record<string, unknown>[],
    driver: "acp" | "cli" = "acp",
  ) => {
    const profile = normalizeEngine({
      id: adapter,
      driver,
      command:
        driver === "cli"
          ? [process.execPath, "kimi.js", "--quiet", "--prompt", "{prompt}"]
          : [process.execPath, `${adapter}.js`],
      ...(driver === "cli"
        ? { cli: { inputMode: "argv", maxOutputBytes: 1048576 } }
        : {}),
      configuration: { adapter, mcpServers: servers },
    });
    const prepared = await prepareConfiguration(
      {
        profile,
        cwd: workspace,
        stateDir: path.join(state, adapter),
        sessionId: "s" as SessionId,
        runId: "r" as RunId,
        generation: 1,
        input: { text: "", timeoutMs: 1000 },
      },
      { HH_LITERAL_SECRET: `secret-with-${placeholder}` },
    );
    // Stored revisions keep the placeholder; only the prepared copy changes.
    assert.deepEqual(profile.configuration?.mcpServers?.[0]?.args, stdio.args);
    return prepared;
  };
  const expectedArgs = [
    "server.js",
    "--root",
    workspace,
    `--out=${workspace}\\out`,
  ];
  // Forwarded over ACP.
  const qwen = await run("qwen", [stdio, remote]);
  const [local, http] = qwen.mcpServers;
  assert.ok(local && "command" in local);
  assert.equal(local.command, process.execPath);
  assert.deepEqual(local.args, expectedArgs);
  assert.deepEqual(local.env, [
    { name: "WORKDIR", value: workspace },
    { name: "BOTH", value: `${workspace};${workspace}` },
    // Secret values are never rewritten.
    { name: "TOKEN", value: `secret-with-${placeholder}` },
  ]);
  // HTTP/SSE URLs and headers are not rewritten.
  assert.ok(http && "url" in http);
  assert.equal(http.url, remote.url);
  assert.deepEqual(http.headers, [{ name: "X-Workspace", value: placeholder }]);
  // Native adapters receive the substituted runtime values.
  const copilot = await run("copilot", [stdio]);
  const copilotFile = JSON.parse(
    await readFile(copilot.command.at(-1)!.slice(1), "utf8"),
  ) as { mcpServers: { local: { args: string[] } } };
  assert.deepEqual(copilotFile.mcpServers.local.args, expectedArgs);
  // Kimi's native file cannot carry secret references.
  const { secretEnv: _secretEnv, ...credentialFree } = stdio;
  const kimi = await run("kimi", [credentialFree], "cli");
  const kimiFile = JSON.parse(
    await readFile(
      kimi.command[kimi.command.indexOf("--mcp-config-file") + 1]!,
      "utf8",
    ),
  ) as {
    mcpServers: { local: { args: string[]; env: Record<string, string> } };
  };
  assert.deepEqual(kimiFile.mcpServers.local.args, expectedArgs);
  assert.equal(kimiFile.mcpServers.local.env.WORKDIR, workspace);
});

void test("provider gateway fields are validated at registration without reading credentials", () => {
  const register = (adapter: string, provided: Record<string, unknown>) =>
    normalizeEngine({
      id: adapter,
      driver: adapter === "kimi" ? "cli" : "acp",
      command:
        adapter === "kimi"
          ? [process.execPath, "kimi.js", "--quiet", "--prompt", "{prompt}"]
          : [process.execPath, "engine.js"],
      model: "company-real-model",
      configuration: { adapter, provider: provided },
    });
  for (const adapter of ["claude", "codex", "gemini"])
    assert.doesNotThrow(() => register(adapter, provider));
  assert.doesNotThrow(() =>
    register("claude", {
      protocol: "anthropic",
      baseUrl: "https://example.invalid",
    }),
  );
  // Kimi accepts the unified context window instead of its env variable.
  assert.doesNotThrow(() => register("kimi", provider));
  for (const invalid of [
    { ...provider, headers: { "X-Api-Key": "value" } },
    { ...provider, headers: { Authorization: "Bearer abcdefghijkl" } },
    { ...provider, headers: { Host: "evil.example" } },
    { ...provider, headers: { "Bad Name": "x" } },
    { ...provider, headers: { "X-Tenant": "a\r\nb" } },
    {
      ...provider,
      headers: { "x-tenant": "a" },
      secretHeaders: { "X-Tenant": { kind: "env", value: "TENANT" } },
    },
    {
      ...provider,
      secretHeaders: { Authorization: { kind: "env", value: "AUTH" } },
    },
    { ...provider, contextWindow: 8192, maxOutputTokens: 8192 },
    { ...provider, compatibility: { dropParameters: ["messages"] } },
    { ...provider, modelAlias: "bad alias" },
    { ...provider, baseUrl: undefined },
    {
      protocol: "openai-responses",
      baseUrl: "https://example.invalid",
      contextWindow: 65536,
    },
  ])
    assert.throws(() => register("opencode", invalid), {
      code: "INVALID_ENGINE_CONFIGURATION",
    });
});
