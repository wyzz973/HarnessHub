import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeHarnessModel,
  applyHarnessModel,
  evaluateHarnessModel,
  harnessModelFromEnvironment,
  HarnessModelService,
  parseHarnessModel,
  readHarnessModelFile,
  writeHarnessModelFile,
} from "../../src/application/harness-model.js";
import { builtinConfigurationAdapter } from "../../src/engine/builtins.js";
import { normalizeEngine } from "../../src/engine/registry.js";
import type { EngineRegistration } from "../../src/domain/engines.js";
import { HubError } from "../../src/domain/errors.js";
import {
  HARNESS_MODEL_ALIAS,
  type HarnessModel,
} from "../../src/domain/harness-model.js";

const ports = {
  normalize: normalizeEngine,
  inferAdapter: builtinConfigurationAdapter,
};
const unified: HarnessModel = {
  model: "GLM-V5_1-DX",
  provider: {
    protocol: "openai-completions",
    baseUrl: "http://aigateway.example/v1",
    apiKey: { kind: "env", value: "COMPANY_MODEL_API_KEY" },
    contextWindow: 131072,
    maxOutputTokens: 16384,
  },
};
const active = activeHarnessModel({ file: unified })!;
function code(expected: string) {
  return (error: unknown) =>
    error instanceof HubError && error.code === expected;
}

void test("environment source needs HARNESSHUB_MODEL and stores only the key variable name", () => {
  assert.equal(harnessModelFromEnvironment({}), undefined);
  assert.equal(
    harnessModelFromEnvironment({ HARNESSHUB_MODEL_API_KEY: "sk-unused" }),
    undefined,
  );
  const key = "sk-environment-secret-value-123456";
  const model = harnessModelFromEnvironment({
    HARNESSHUB_MODEL: " GLM-V5_1-DX ",
    HARNESSHUB_MODEL_BASE_URL: "http://aigateway.example/v1",
    HARNESSHUB_MODEL_API_KEY: key,
    HARNESSHUB_MODEL_CONTEXT_WINDOW: "131072",
    HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS: "8192",
  });
  assert.deepEqual(model, {
    model: "GLM-V5_1-DX",
    provider: {
      protocol: "openai-completions",
      baseUrl: "http://aigateway.example/v1",
      apiKey: { kind: "env", value: "HARNESSHUB_MODEL_API_KEY" },
      contextWindow: 131072,
      maxOutputTokens: 8192,
    },
  });
  assert.equal(JSON.stringify(model).includes(key), false);
  assert.equal(
    harnessModelFromEnvironment({
      HARNESSHUB_MODEL: "m",
      HARNESSHUB_MODEL_BASE_URL: "https://x.example/v1",
    })?.provider.apiKey,
    undefined,
  );
  for (const [environment, expected] of [
    [
      { HARNESSHUB_MODEL_BASE_URL: "https://x.example/v1" },
      "INVALID_HARNESS_MODEL",
    ],
    [{ HARNESSHUB_MODEL: "m" }, "INVALID_HARNESS_MODEL"],
    [
      {
        HARNESSHUB_MODEL: "m",
        HARNESSHUB_MODEL_BASE_URL: "https://x.example/v1",
        HARNESSHUB_MODEL_PROTOCOL: "anthropic",
      },
      "HARNESS_MODEL_PROTOCOL_UNSUPPORTED",
    ],
    [
      {
        HARNESSHUB_MODEL: "m",
        HARNESSHUB_MODEL_BASE_URL: "https://x.example/v1",
        HARNESSHUB_MODEL_CONTEXT_WINDOW: "128k",
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        HARNESSHUB_MODEL: "m",
        HARNESSHUB_MODEL_BASE_URL: "https://x.example/v1?key=inline",
      },
      "INVALID_HARNESS_MODEL",
    ],
  ] as const)
    assert.throws(
      () => harnessModelFromEnvironment(environment),
      code(expected),
      JSON.stringify(environment),
    );
});

void test("unified model validation rejects other protocols, unsafe URLs, inline keys and plain secret headers", () => {
  const valid = parseHarnessModel({
    model: "deepseek-flash",
    alias: "hub-model",
    provider: {
      protocol: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: { kind: "env", value: "DEEPSEEK_API_KEY" },
      headers: { "X-Tenant": "contest" },
      secretHeaders: {
        "X-Gateway-Token": { kind: "env", value: "GATEWAY_TOKEN" },
      },
      contextWindow: 1048576,
      maxOutputTokens: 32768,
      modelAlias: "hub-model",
      compatibility: {
        includeUsage: false,
        dropParameters: ["stream_options"],
        maxTokensField: "max_tokens",
        reasoning: "passthrough",
      },
    },
  });
  assert.equal(valid.alias, "hub-model");
  assert.deepEqual(valid.provider.headers, { "X-Tenant": "contest" });
  const provider = unified.provider;
  for (const [input, expected] of [
    [null, "INVALID_HARNESS_MODEL"],
    [{ ...unified, surprise: 1 }, "INVALID_HARNESS_MODEL"],
    [{ ...unified, model: "" }, "INVALID_HARNESS_MODEL"],
    [{ ...unified, model: " padded" }, "INVALID_HARNESS_MODEL"],
    [
      { ...unified, provider: { ...provider, protocol: "openai-responses" } },
      "HARNESS_MODEL_PROTOCOL_UNSUPPORTED",
    ],
    [
      { ...unified, provider: { ...provider, protocol: "google" } },
      "HARNESS_MODEL_PROTOCOL_UNSUPPORTED",
    ],
    [
      { ...unified, provider: { ...provider, protocol: "grpc" } },
      "INVALID_HARNESS_MODEL",
    ],
    [
      { ...unified, provider: { protocol: "openai-completions" } },
      "INVALID_HARNESS_MODEL",
    ],
    [
      { ...unified, provider: { ...provider, baseUrl: "ftp://x.example" } },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: { ...provider, baseUrl: "https://user:pw@x.example/v1" },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      { ...unified, provider: { ...provider, apiKey: "sk-inline-secret" } },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: { ...provider, apiKey: { kind: "env", value: "lower" } },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: { ...provider, apiKey: { kind: "file", value: "key.txt" } },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: { ...provider, headers: { Authorization: "Bearer x" } },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: {
          ...provider,
          headers: { "X-Trace": "Bearer abcdefghijklmnop" },
        },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: {
          ...provider,
          headers: { "X-A": "1" },
          secretHeaders: { "x-a": { kind: "env", value: "A" } },
        },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: { ...provider, contextWindow: 1000, maxOutputTokens: 16 },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      {
        ...unified,
        provider: { ...provider, contextWindow: 4096, maxOutputTokens: 8192 },
      },
      "INVALID_HARNESS_MODEL",
    ],
    [
      { ...unified, alias: "a", provider: { ...provider, modelAlias: "b" } },
      "INVALID_HARNESS_MODEL",
    ],
    [{ ...unified, alias: "-bad" }, "INVALID_HARNESS_MODEL"],
    [
      {
        ...unified,
        provider: { ...provider, compatibility: { reasoning: "drop" } },
      },
      "INVALID_HARNESS_MODEL",
    ],
  ] as const)
    assert.throws(
      () => parseHarnessModel(input),
      code(expected),
      JSON.stringify(input),
    );
});

void test("source priority is environment, then file, then settings, with the neutral alias by default", async (t) => {
  const settings = { ...unified, model: "settings-model" };
  const file = { ...unified, model: "file-model", alias: "file-alias" };
  const environment = { ...unified, model: "env-model" };
  assert.equal(activeHarnessModel({}), undefined);
  assert.equal(activeHarnessModel({ settings })!.source, "settings");
  assert.equal(activeHarnessModel({ settings })!.alias, HARNESS_MODEL_ALIAS);
  assert.deepEqual(
    [
      activeHarnessModel({ settings, file })!.source,
      activeHarnessModel({ settings, file })!.alias,
      activeHarnessModel({ settings, file })!.provider.modelAlias,
    ],
    ["file", "file-alias", "file-alias"],
  );
  assert.equal(
    activeHarnessModel({ settings, file, environment })!.model,
    "env-model",
  );
  assert.equal(
    activeHarnessModel({
      settings: {
        ...unified,
        provider: { ...unified.provider, modelAlias: "p" },
      },
    })!.alias,
    "p",
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-model-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stored = path.join(directory, "state", "harness-model.json");
  const load = (environmentVariables: NodeJS.ProcessEnv) =>
    HarnessModelService.load({
      environment: environmentVariables,
      file: stored,
      settings,
      ports,
    });
  assert.equal((await load({})).active()!.source, "settings");
  await writeHarnessModelFile(stored, file);
  if (process.platform !== "win32")
    assert.equal((await stat(stored)).mode & 0o777, 0o600);
  assert.deepEqual(await readHarnessModelFile(stored), file);
  assert.equal((await load({})).active()!.model, "file-model");
  assert.equal(
    (
      await load({
        HARNESSHUB_MODEL: "env-model",
        HARNESSHUB_MODEL_BASE_URL: "https://env.example/v1",
      })
    ).active()!.source,
    "environment",
  );
  assert.equal(
    await readHarnessModelFile(path.join(directory, "missing.json")),
    undefined,
  );
  await writeFile(stored, "{broken");
  await assert.rejects(load({}), code("INVALID_HARNESS_MODEL"));
  await assert.rejects(
    writeHarnessModelFile(stored, {
      ...unified,
      provider: { ...unified.provider, protocol: "anthropic" },
    }),
    code("HARNESS_MODEL_PROTOCOL_UNSUPPORTED"),
  );
  assert.equal(await readFile(stored, "utf8"), "{broken");
});

void test("applying the unified model overrides vendor model, provider and credentials but keeps engine-owned settings", () => {
  const registration: EngineRegistration = {
    id: "opencode",
    driver: "acp",
    command: ["/opt/opencode", "acp"],
    model: "deepseek-v4-flash",
    credentialEnv: ["DEEPSEEK_API_KEY"],
    maxConcurrency: 2,
    acp: { initializeTimeoutMs: 30000 },
    configuration: {
      adapter: "opencode",
      provider: {
        protocol: "anthropic",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: { kind: "env", value: "DEEPSEEK_API_KEY" },
      },
      env: { OPENCODE_DISABLE_AUTOUPDATE: "true" },
      secretEnv: { OPENAI_API_KEY: { kind: "env", value: "VENDOR_KEY" } },
      skills: [{ path: "/skills/review/SKILL.md", enabled: true }],
      mcpServers: [
        {
          name: "files",
          type: "stdio",
          enabled: true,
          command: "/opt/mcp",
          secretEnv: { TOOL_TOKEN: { kind: "env", value: "TOOL_TOKEN" } },
        },
      ],
    },
  };
  const before = JSON.stringify(registration);
  const plan = applyHarnessModel(registration, active);
  assert.equal(JSON.stringify(registration), before);
  assert.equal(plan.status, "applied");
  assert.equal(plan.registration.model, "GLM-V5_1-DX");
  assert.equal(plan.registration.credentialEnv, undefined);
  assert.deepEqual(plan.registration.configuration, {
    adapter: "opencode",
    env: { OPENCODE_DISABLE_AUTOUPDATE: "true" },
    skills: registration.configuration!.skills,
    mcpServers: registration.configuration!.mcpServers,
    provider: { ...unified.provider, modelAlias: HARNESS_MODEL_ALIAS },
  });
  assert.equal(plan.registration.maxConcurrency, 2);
  assert.deepEqual(plan.registration.acp, { initializeTimeoutMs: 30000 });
  assert.deepEqual(plan.registration.command, registration.command);
  for (const fragment of [
    "deepseek-v4-flash",
    "anthropic https://api.deepseek.com/anthropic",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
  ])
    assert.ok(plan.reason?.includes(fragment), fragment);

  const clean = applyHarnessModel(
    {
      id: "qwen",
      driver: "acp",
      command: ["/opt/qwen"],
      configuration: { adapter: "qwen" },
    },
    active,
  );
  assert.equal(clean.status, "applied");
  assert.equal(clean.reason, undefined);

  for (const adapter of [
    "cursor",
    "antigravity",
    "kiro",
    "qoder",
    "generic",
  ] as const) {
    const blocked = applyHarnessModel(
      {
        id: adapter,
        driver: "acp",
        command: ["/opt/agent"],
        credentialEnv: ["VENDOR_TOKEN"],
        configuration: { adapter },
      },
      active,
    );
    assert.equal(blocked.status, "unsupported", adapter);
    assert.equal(blocked.registration.enabled, false, adapter);
    assert.equal(blocked.registration.credentialEnv, undefined, adapter);
    assert.match(blocked.reason!, new RegExp(adapter));
  }
  const unknown = applyHarnessModel(
    { id: "custom", driver: "acp", command: ["/opt/custom"] },
    active,
  );
  assert.equal(unknown.status, "unsupported");
  assert.equal(unknown.registration.enabled, false);
  const inferred = applyHarnessModel(
    { id: "pi", driver: "acp", command: ["/opt/pi-acp"] },
    active,
    "pi",
  );
  assert.equal(inferred.status, "applied");
  assert.equal(inferred.registration.configuration?.adapter, "pi");
  const stopped = applyHarnessModel(
    {
      id: "codex",
      driver: "acp",
      command: ["/opt/codex"],
      enabled: false,
      configuration: { adapter: "codex" },
    },
    active,
  );
  assert.equal(stopped.status, "disabled");
  assert.equal(stopped.registration.model, "GLM-V5_1-DX");
});

void test("evaluation validates with the engine layer, disables rejected registrations and is deterministic", () => {
  const evaluate = (registration: EngineRegistration) =>
    evaluateHarnessModel(normalizeEngine(registration), active, ports);
  const applied = evaluate({
    id: "dsh",
    driver: "acp",
    command: ["/opt/dsh", "--profile", "acp"],
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.profile.configuration?.adapter, "dsh");
  assert.equal(applied.profile.enabled, true);
  assert.equal(
    applied.profile.revision,
    evaluate({
      id: "dsh",
      driver: "acp",
      command: ["/opt/dsh", "--profile", "acp"],
    }).profile.revision,
  );
  const fixedLauncher = evaluate({
    id: "fixed",
    driver: "acp",
    command: ["/usr/bin/node", "/repo/scripts/launch-opencode-acp.mjs"],
    credentialEnv: ["DEEPSEEK_API_KEY"],
    configuration: { adapter: "opencode" },
  });
  assert.equal(fixedLauncher.status, "unsupported");
  assert.equal(fixedLauncher.profile.enabled, false);
  assert.equal(fixedLauncher.profile.credentialEnv, undefined);
  assert.match(fixedLauncher.reason!, /固定了 Provider/);
  const kimiAcp = evaluate({
    id: "kimi",
    driver: "acp",
    command: ["/opt/kimi", "acp"],
    configuration: { adapter: "kimi" },
  });
  assert.equal(kimiAcp.status, "unsupported");
  assert.match(kimiAcp.reason!, /Kimi/);
  const cursor = evaluate({
    id: "cursor",
    driver: "cli",
    command: ["/opt/cursor-agent", "--print"],
  });
  assert.equal(cursor.status, "unsupported");
  assert.equal(cursor.profile.enabled, false);
});

void test("the service exempts demo engines, rejects saving while the environment wins and republishes through its catalog", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-model-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness-model.json");
  const declared = [
    normalizeEngine({
      id: "qwen",
      driver: "acp",
      command: ["/opt/qwen", "--acp"],
      model: "qwen-max",
      configuration: {
        adapter: "qwen",
        provider: {
          protocol: "openai-completions",
          baseUrl: "https://dashscope.example/v1",
        },
      },
    }),
    normalizeEngine({ id: "cursor", driver: "cli", command: ["/opt/cursor"] }),
  ];
  const refreshed: string[] = [];
  const service = await HarnessModelService.load({
    environment: {},
    file,
    ports,
  });
  service.bind({
    catalog: {
      declared: () => declared,
      refresh: async (change) => {
        await change();
        refreshed.push(service.active()!.model);
      },
    },
    sessions: {
      defaultEngine: () => "qwen",
      createSessionAtDirectory: () => Promise.reject(new Error("unused")),
      submit: () => {
        throw new Error("unused");
      },
      getRun: () => {
        throw new Error("unused");
      },
      cancel: () => Promise.reject(new Error("unused")),
      closeSession: () => Promise.reject(new Error("unused")),
    },
    scratchDirectory: directory,
  });
  assert.deepEqual(service.view(), {
    configured: false,
    alias: HARNESS_MODEL_ALIAS,
    engines: [],
  });
  const policy = service.policy();
  assert.equal(policy.apply(declared[0]!).profile, declared[0]);
  await assert.rejects(service.test({}), code("HARNESS_MODEL_NOT_CONFIGURED"));
  const view = await service.set(unified);
  assert.deepEqual(refreshed, ["GLM-V5_1-DX"]);
  assert.equal(view.source, "file");
  assert.deepEqual(
    view.engines.map((engine) => [engine.engineId, engine.status]),
    [
      ["qwen", "applied"],
      ["cursor", "unsupported"],
    ],
  );
  assert.match(view.engines[0]!.reason!, /qwen-max/);
  assert.deepEqual(await readHarnessModelFile(file), unified);
  const blocked = policy.apply(declared[1]!);
  assert.equal(blocked.profile.enabled, false);
  assert.match(blocked.unavailableReason!, /cursor/);
  const demo = { ...declared[0]!, id: "fake", driver: "fake" as const };
  assert.equal(policy.apply(demo).profile, demo);
  await assert.rejects(
    service.set({ ...unified, provider: { ...unified.provider, apiKey: "x" } }),
    code("INVALID_HARNESS_MODEL"),
  );
  assert.deepEqual(refreshed, ["GLM-V5_1-DX"]);

  const fromEnvironment = await HarnessModelService.load({
    environment: {
      HARNESSHUB_MODEL: "env-model",
      HARNESSHUB_MODEL_BASE_URL: "https://env.example/v1",
    },
    file,
    ports,
  });
  await assert.rejects(
    fromEnvironment.set(unified),
    code("HARNESS_MODEL_ENVIRONMENT_OVERRIDE"),
  );
  const fromNowhere = await HarnessModelService.load({
    environment: {},
    ports,
  });
  fromNowhere.bind({
    catalog: { declared: () => [], refresh: async () => {} },
    sessions: {} as never,
    scratchDirectory: directory,
  });
  await assert.rejects(
    fromNowhere.set(unified),
    code("HARNESS_MODEL_FILE_UNAVAILABLE"),
  );
  assert.equal(fromNowhere.active(), undefined);
});
