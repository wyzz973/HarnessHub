import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeEngine, prepareEngine } from "../../src/engine/registry.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import {
  createSecret,
  deleteSecret,
  resolveSecret,
} from "../../src/drivers/configuration/secrets.js";
import type {
  EngineProfile,
  RunId,
  SessionId,
} from "../../src/domain/types.js";
import type { ConfigurationAdapter } from "../../src/domain/engine-configuration.js";
const base = {
  id: "configured",
  driver: "acp",
  command: [process.execPath, "peer.js"],
  model: "alpha",
};
function spec(profile: EngineProfile, directory: string) {
  return {
    profile,
    stateDir: directory,
    cwd: directory,
    sessionId: "configuration-session" as SessionId,
    runId: "configuration-run" as RunId,
    generation: 1,
    input: { text: "task", timeoutMs: 1000 },
  };
}
void test("configuration schema rejects credentials in plain fields, unsafe URLs, unsupported capabilities and duplicate tools", () => {
  for (const configuration of [
    { adapter: "generic", apiKey: "secret" },
    { adapter: "generic", env: { OPENAI_API_KEY: "secret" } },
    {
      adapter: "generic",
      secretEnv: { NODE_OPTIONS: { kind: "env", value: "KEY" } },
    },
    { adapter: "codex", provider: { protocol: "anthropic" } },
    {
      adapter: "hermes",
      provider: {
        protocol: "openai-completions",
        baseUrl: "https://user:password@example.com",
      },
    },
    {
      adapter: "hermes",
      provider: {
        protocol: "openai-completions",
        baseUrl: "https://example.com?api_key=secret",
      },
    },
    {
      adapter: "generic",
      secretEnv: { KEY: { kind: "file", value: "relative" } },
    },
    {
      adapter: "generic",
      mcpServers: [
        {
          name: "x",
          type: "http",
          enabled: true,
          url: "https://example.com",
          headers: { Authorization: "secret" },
        },
      ],
    },
    {
      adapter: "generic",
      mcpServers: [
        { name: "x", type: "stdio", enabled: true, command: "relative" },
      ],
    },
    {
      adapter: "generic",
      skills: [{ path: "/tmp/not-a-skill", enabled: true }],
    },
  ])
    assert.throws(() => normalizeEngine({ ...base, configuration }), {
      code: "INVALID_ENGINE_CONFIGURATION",
    });
  assert.throws(
    () =>
      normalizeEngine({
        ...base,
        driver: "cli",
        configuration: {
          adapter: "cursor",
          mcpServers: [
            {
              name: "tools",
              type: "stdio",
              enabled: true,
              command: process.execPath,
            },
          ],
        },
      }),
    { code: "INVALID_ENGINE_CONFIGURATION" },
  );
  assert.throws(
    () =>
      normalizeEngine({
        ...base,
        command: [process.execPath, "/tmp/launch-pi-acp.mjs"],
        configuration: {
          adapter: "pi",
          provider: {
            protocol: "openai-completions",
            baseUrl: "http://localhost:1/v1",
          },
        },
      }),
    { code: "ENGINE_CONFIGURATION_UNSUPPORTED" },
  );
});
void test("native provider mappings resolve distinct keys without writing key values into profile or native files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-native-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const key = "synthetic-key-fixture";
  const pairs: [ConfigurationAdapter, string][] = [
    ["codex", "openai-responses"],
    ["claude", "anthropic"],
    ["opencode", "openai-completions"],
    ["mimo", "openai-responses"],
    ["hermes", "openai-completions"],
    ["pi", "openai-completions"],
    ["gemini", "google"],
    ["qwen", "openai-completions"],
    ["copilot", "openai-completions"],
    ["copilot", "anthropic"],
  ];
  for (const [adapter, protocol] of pairs) {
    const root = path.join(directory, `${adapter}-${protocol}`);
    await mkdir(root);
    const profile = normalizeEngine({
      ...base,
      configuration: {
        adapter,
        provider: {
          protocol,
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: { kind: "env", value: "ENGINE_A_KEY" },
        },
      },
    });
    const prepared = await prepareConfiguration(spec(profile, root), {
      ENGINE_A_KEY: key,
    });
    assert.equal(prepared.env.HARNESSHUB_PROVIDER_KEY, key);
    if (adapter === "copilot") {
      assert.equal(
        prepared.env.COPILOT_PROVIDER_TYPE,
        protocol === "anthropic" ? "anthropic" : "openai",
      );
      assert.equal(prepared.env.COPILOT_PROVIDER_API_KEY, key);
      assert.equal(
        prepared.env.COPILOT_PROVIDER_BASE_URL,
        "http://127.0.0.1:1234/v1",
      );
      assert.equal(prepared.env.COPILOT_MODEL, "alpha");
      assert.equal(prepared.env.COPILOT_OFFLINE, "true");
      assert.equal(
        prepared.command.some((arg) => arg.includes(key)),
        false,
      );
      assert.equal(prepared.model, "alpha");
    }
    if (adapter === "hermes") assert.equal(prepared.model, "custom:alpha");
    assert.equal(JSON.stringify(profile).includes(key), false);
    if (adapter === "codex")
      assert.equal(
        (
          await readFile(
            path.join(prepared.env.CODEX_HOME!, "config.toml"),
            "utf8",
          )
        ).includes(key),
        false,
      );
    if (adapter === "pi") {
      const models: unknown = JSON.parse(
        await readFile(
          path.join(prepared.env.PI_CODING_AGENT_DIR!, "models.json"),
          "utf8",
        ),
      );
      assert.deepEqual(models, {
        providers: {
          harnesshub: {
            baseUrl: "http://127.0.0.1:1234/v1",
            api: "openai-completions",
            apiKey: "$HARNESSHUB_PROVIDER_KEY",
            models: [{ id: "alpha" }],
          },
        },
      });
      assert.equal(
        (
          await readFile(
            path.join(prepared.env.PI_CODING_AGENT_DIR!, "models.json"),
            "utf8",
          )
        ).includes(key),
        false,
      );
    }
    if (adapter === "opencode" || adapter === "mimo") {
      const content =
        prepared.env[
          `${adapter === "mimo" ? "MIMOCODE" : "OPENCODE"}_CONFIG_CONTENT`
        ]!;
      assert.equal(content.includes(key), false);
      assert.equal(prepared.model, "harnesshub/alpha");
    }
  }
});
void test("Codex receives only the known DeepSeek model catalog with its pinned native baseline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-codex-models-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const profile = normalizeEngine({
    ...base,
    model: "deepseek-v4-flash",
    configuration: {
      adapter: "codex",
      provider: {
        protocol: "openai-responses",
        baseUrl: "https://api.deepseek.com",
        apiKey: { kind: "env", value: "FIXTURE_KEY" },
      },
    },
  });
  const prepared = await prepareConfiguration(spec(profile, directory), {
    FIXTURE_KEY: "synthetic-codex-secret",
  });
  const native = await readFile(
    path.join(prepared.env.CODEX_HOME!, "config.toml"),
    "utf8",
  );
  const match = /^model_catalog_json = (.+)$/m.exec(native);
  assert.ok(match?.[1]);
  const catalogPath: unknown = JSON.parse(match[1]);
  assert.equal(typeof catalogPath, "string");
  if (typeof catalogPath !== "string") throw new Error("Expected catalog path");
  assert.equal(path.isAbsolute(catalogPath), true);
  const catalogBytes = await readFile(catalogPath, "utf8");
  assert.equal(catalogBytes.includes("synthetic-codex-secret"), false);
  const catalog = JSON.parse(catalogBytes) as {
    models: {
      slug: string;
      context_window: number;
      max_context_window: number;
      input_modalities: string[];
      model_messages: { instructions_template: string };
    }[];
  };
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0]!;
  assert.equal(model.slug, "deepseek-v4-flash");
  assert.equal(model.context_window, 1_048_576);
  assert.equal(model.max_context_window, 1_048_576);
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.equal(
    createHash("sha256")
      .update(model.model_messages.instructions_template)
      .digest("hex"),
    "ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807",
  );
  const other = await prepareConfiguration(
    spec({ ...profile, model: "unknown-model" }, path.join(directory, "other")),
    { FIXTURE_KEY: "synthetic-codex-secret" },
  );
  assert.equal(
    (
      await readFile(path.join(other.env.CODEX_HOME!, "config.toml"), "utf8")
    ).includes("model_catalog_json"),
    false,
  );
});
void test("managed Copilot rejects unsupported wire protocols, missing endpoints and conflicting model arguments", async (t) => {
  for (const provider of [
    { protocol: "openai-responses", baseUrl: "http://127.0.0.1:1234/v1" },
    { protocol: "google", baseUrl: "http://127.0.0.1:1234/v1" },
    { protocol: "openai-completions" },
  ])
    assert.throws(
      () =>
        normalizeEngine({
          ...base,
          configuration: { adapter: "copilot", provider },
        }),
      { code: "INVALID_ENGINE_CONFIGURATION" },
    );
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-copilot-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const profile = normalizeEngine({
    ...base,
    command: [...base.command, "--model=other"],
    configuration: {
      adapter: "copilot",
      provider: {
        protocol: "openai-completions",
        baseUrl: "http://127.0.0.1:1234/v1",
      },
    },
  });
  await assert.rejects(prepareConfiguration(spec(profile, directory), {}), {
    code: "ENGINE_CONFIGURATION_UNSUPPORTED",
  });
});
void test("Copilot stdio MCP uses a private native configuration while remote servers stay on ACP and secrets stay off disk", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-copilot-mcp-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const secret = "synthetic-value-${HOME}-中文";
  const profile = normalizeEngine({
    ...base,
    configuration: {
      adapter: "copilot",
      mcpServers: [
        {
          name: "local",
          type: "stdio",
          command: process.execPath,
          args: ["server.js", "literal & argument"],
          env: { MODE: "read-only" },
          secretEnv: { MCP_TOKEN: { kind: "env", value: "FIXTURE_SECRET" } },
          enabled: true,
        },
        {
          name: "remote",
          type: "http",
          url: "http://127.0.0.1:4321/mcp",
          secretHeaders: {
            Authorization: { kind: "env", value: "FIXTURE_SECRET" },
          },
          enabled: true,
        },
      ],
    },
  });
  const prepared = await prepareConfiguration(spec(profile, directory), {
    FIXTURE_SECRET: secret,
  });
  assert.deepEqual(
    prepared.mcpServers.map((server) => server.name),
    ["remote"],
  );
  assert.equal(prepared.command.at(-2), "--additional-mcp-config");
  const nativeFile = prepared.command.at(-1)!.slice(1);
  assert.equal(
    nativeFile,
    path.join(directory, "configuration", "copilot-mcp.json"),
  );
  const bytes = await readFile(nativeFile, "utf8");
  assert.equal(bytes.includes(secret), false);
  const native = JSON.parse(bytes) as {
    mcpServers: Record<
      string,
      {
        command: string;
        args: string[];
        env: Record<string, string>;
        tools: string[];
      }
    >;
  };
  assert.deepEqual(Object.keys(native.mcpServers), ["local"]);
  assert.deepEqual(native.mcpServers.local!.args, [
    "server.js",
    "literal & argument",
  ]);
  assert.equal(
    native.mcpServers.local!.env.MCP_TOKEN,
    "${HARNESSHUB_COPILOT_MCP_0_1}",
  );
  assert.equal(prepared.env.HARNESSHUB_COPILOT_MCP_0_1, secret);
  assert.deepEqual(native.mcpServers.local!.tools, ["*"]);
  const conflicting = normalizeEngine({
    ...base,
    command: [...base.command, "--additional-mcp-config=@existing.json"],
    configuration: profile.configuration,
  });
  await assert.rejects(
    prepareConfiguration(spec(conflicting, directory), {
      FIXTURE_SECRET: secret,
    }),
    { code: "ENGINE_CONFIGURATION_UNSUPPORTED" },
  );
  assert.equal(await readFile(nativeFile, "utf8"), bytes);
});
void test("Pi and OpenClaw reject enabled ACP MCP injection instead of silently dropping tools", () => {
  for (const adapter of ["pi", "openclaw"]) {
    const configuration = {
      adapter,
      mcpServers: [
        {
          name: "tools",
          type: "stdio",
          enabled: true,
          command: process.execPath,
        },
      ],
    };
    assert.throws(() => normalizeEngine({ ...base, configuration }), {
      code: "INVALID_ENGINE_CONFIGURATION",
    });
    assert.doesNotThrow(() =>
      normalizeEngine({
        ...base,
        configuration: {
          ...configuration,
          mcpServers: configuration.mcpServers.map((server) => ({
            ...server,
            enabled: false,
          })),
        },
      }),
    );
  }
});
void test("Kimi print CLI maps four protocols without persisting credentials or splitting prompt arguments", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-kimi-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const pairs = [
    ["openai-completions", "openai_legacy", "OPENAI_API_KEY"],
    ["openai-responses", "openai_responses", "OPENAI_API_KEY"],
    ["anthropic", "anthropic", "ANTHROPIC_AUTH_TOKEN"],
    ["google", "gemini", "GOOGLE_API_KEY"],
  ];
  for (const [protocol, nativeType, keyName] of pairs) {
    const profile = normalizeEngine({
      ...base,
      driver: "cli",
      command: [
        process.execPath,
        "kimi-fixture.js",
        "--quiet",
        "--prompt",
        "{prompt}",
      ],
      configuration: {
        adapter: "kimi",
        env: { KIMI_MODEL_MAX_CONTEXT_SIZE: "131072" },
        provider: {
          protocol,
          baseUrl: "http://127.0.0.1:1234",
          apiKey: { kind: "env", value: "KIMI_FIXTURE_KEY" },
        },
      },
    });
    const prepared = await prepareConfiguration(
      spec(profile, path.join(directory, protocol!)),
      { KIMI_FIXTURE_KEY: "synthetic-kimi-secret" },
    );
    assert.equal(prepared.env[keyName!], "synthetic-kimi-secret");
    assert.equal(prepared.env.KIMI_DISABLE_TELEMETRY, "1");
    assert.equal(
      prepared.command[prepared.command.indexOf("--prompt") + 1],
      "{prompt}",
    );
    assert.equal(
      prepared.command[prepared.command.indexOf("--model") + 1],
      "alpha",
    );
    assert.equal(
      JSON.stringify(prepared.command).includes("synthetic-kimi-secret"),
      false,
    );
    const bytes = await readFile(
      prepared.command[prepared.command.indexOf("--config-file") + 1]!,
      "utf8",
    );
    assert.equal(bytes.includes("synthetic-kimi-secret"), false);
    assert.deepEqual(JSON.parse(bytes), {
      default_model: "alpha",
      telemetry: false,
      providers: {
        harnesshub: {
          type: nativeType,
          base_url: "http://127.0.0.1:1234",
          api_key: "",
        },
      },
      models: {
        alpha: {
          provider: "harnesshub",
          model: "alpha",
          max_context_size: 131072,
        },
      },
    });
  }
});
void test("Kimi rejects managed ACP, invalid context windows and conflicting native configuration", async (t) => {
  const configuration = {
    adapter: "kimi",
    env: { KIMI_MODEL_MAX_CONTEXT_SIZE: "131072" },
    provider: {
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:1234",
    },
  };
  assert.throws(() => normalizeEngine({ ...base, configuration }), {
    code: "INVALID_ENGINE_CONFIGURATION",
  });
  for (const value of [
    undefined,
    "0",
    "-1",
    "1.5",
    "131072tokens",
    "9007199254740992",
  ]) {
    assert.throws(
      () =>
        normalizeEngine({
          ...base,
          driver: "cli",
          command: [...base.command, "--quiet", "--prompt", "{prompt}"],
          configuration: {
            ...configuration,
            env:
              value === undefined ? {} : { KIMI_MODEL_MAX_CONTEXT_SIZE: value },
          },
        }),
      { code: "INVALID_ENGINE_CONFIGURATION" },
    );
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-kimi-conflict-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  for (const args of [
    ["--quiet", "--config-file=existing.json"],
    ["--acp"],
    ["acp"],
  ]) {
    const profile = normalizeEngine({
      ...base,
      driver: "cli",
      command: [...base.command, ...args, "{prompt}"],
      configuration,
    });
    await assert.rejects(prepareConfiguration(spec(profile, directory), {}), {
      code: "ENGINE_CONFIGURATION_UNSUPPORTED",
    });
  }
});
void test("skill revisions pin exact bytes and fail when a source changes; missing credentials fail explicitly", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-skill-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, "fixture skill instruction");
  const raw = {
    ...base,
    configuration: {
      adapter: "generic",
      skills: [{ path: file, enabled: true }],
    },
  };
  const profile = await prepareEngine(raw);
  assert.ok(profile.configuration?.skills?.[0]?.sha256);
  assert.ok(
    (
      await prepareConfiguration(spec(profile, directory), {})
    ).instructionPrefix.includes("fixture skill instruction"),
  );
  await writeFile(file, "changed instructions");
  await assert.rejects(prepareConfiguration(spec(profile, directory), {}), {
    code: "SKILL_CHANGED",
  });
  assert.notEqual((await prepareEngine(raw)).revision, profile.revision);
  await assert.rejects(resolveSecret({ kind: "env", value: "ABSENT" }, {}), {
    code: "SECRET_UNAVAILABLE",
  });
});
void test(
  "system secret storage keeps immutable references and resolves them without argv secrets",
  {
    skip: !["darwin", "win32"].includes(process.platform)
      ? "System secret storage requires macOS or Windows"
      : false,
  },
  async () => {
    const ref = await createSecret("HarnessHub owned synthetic key fixture");
    try {
      assert.equal(ref.kind, "keychain");
      assert.equal(
        await resolveSecret(ref, {}),
        "HarnessHub owned synthetic key fixture",
      );
    } finally {
      await deleteSecret(ref);
    }
  },
);

void test(
  "protocol probe reclaims a descendant that ignores SIGTERM after its parent exits",
  { timeout: 15_000 },
  async () => {
    const { probeConfiguration } =
      await import("../../src/drivers/configuration/probe.js");
    const { fileURLToPath } = await import("node:url");
    const result = await probeConfiguration(
      {
        command: [
          process.execPath,
          fileURLToPath(
            new URL("../fixtures/configuration-probe-peer.js", import.meta.url),
          ),
        ],
        env: {},
        instructionPrefix: "",
        mcpServers: [],
      },
      "acp",
      process.cwd(),
      new AbortController().signal,
    );
    assert.equal(result.status, "passed", result.message);
  },
);
