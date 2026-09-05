import assert from "node:assert/strict";
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
  ];
  for (const [adapter, protocol] of pairs) {
    const root = path.join(directory, adapter);
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
    if (adapter === "pi")
      assert.equal(
        (
          await readFile(
            path.join(prepared.env.PI_CODING_AGENT_DIR!, "models.json"),
            "utf8",
          )
        ).includes(key),
        false,
      );
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
  "macOS Keychain stores write-only immutable references and resolves them without argv secrets",
  { skip: process.platform !== "darwin" ? "Keychain requires macOS" : false },
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
  { skip: process.platform === "win32" ? "POSIX process groups" : false },
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
