import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessModelService } from "../../src/application/harness-model.js";
import { builtinConfigurationAdapter } from "../../src/engine/builtins.js";
import { EngineManager } from "../../src/engine/manager.js";
import { normalizeEngine, type HubConfig } from "../../src/engine/registry.js";
import type { EngineRegistration } from "../../src/domain/engines.js";
import { HubError } from "../../src/domain/errors.js";
import type { HarnessModel } from "../../src/domain/harness-model.js";
import type { EngineProfile } from "../../src/domain/types.js";

const ports = {
  normalize: normalizeEngine,
  inferAdapter: builtinConfigurationAdapter,
};
const first: HarnessModel = {
  model: "GLM-V5_1-DX",
  provider: {
    protocol: "openai-completions",
    baseUrl: "http://aigateway.example/v1",
    apiKey: { kind: "env", value: "COMPANY_MODEL_API_KEY" },
  },
};
const second: HarnessModel = {
  model: "deepseek-flash",
  alias: "contest-model",
  provider: {
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: { kind: "env", value: "DEEPSEEK_API_KEY" },
    maxOutputTokens: 8192,
  },
};
const vendorOpenCode: EngineRegistration = {
  id: "opencode",
  driver: "acp",
  command: ["/opt/opencode", "acp"],
  model: "deepseek-v4-flash",
  credentialEnv: ["DEEPSEEK_API_KEY"],
  configuration: {
    adapter: "opencode",
    provider: {
      protocol: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: { kind: "env", value: "DEEPSEEK_API_KEY" },
    },
  },
};
const cursor: EngineRegistration = {
  id: "cursor",
  driver: "cli",
  command: ["/opt/cursor-agent", "--print"],
  configuration: { adapter: "cursor" },
};
const apiEngine: EngineRegistration = {
  id: "copilot",
  driver: "acp",
  command: ["/opt/copilot", "--acp"],
  model: "gpt-vendor",
  credentialEnv: ["GITHUB_TOKEN"],
  configuration: {
    adapter: "copilot",
    provider: {
      protocol: "openai-completions",
      baseUrl: "https://vendor.example/v1",
    },
  },
};
const demo: EngineProfile = {
  id: "fake",
  driver: "fake",
  revision: "fake-v1",
  enabled: true,
  maxConcurrency: 4,
  capabilities: { resume: false, permissions: true, images: false },
};

function hubConfig(engines: EngineProfile[], defaultEngine = ""): HubConfig {
  return {
    engines,
    workspaces: [{ id: "default", path: os.tmpdir() }],
    defaultEngine,
    defaultWorkspace: "default",
    maxConcurrency: 4,
    maxWorkers: 16,
    maxQueuedRuns: 1000,
    defaultTimeoutMs: 60000,
    cancelGraceMs: 500,
  };
}
function memoryCatalog() {
  let stored: unknown;
  return {
    readEngineCatalog: () => stored,
    writeEngineCatalog: (value: unknown) => {
      stored = structuredClone(value);
    },
  };
}
async function start(options: {
  file?: string;
  config: HubConfig;
  persistence: ReturnType<typeof memoryCatalog>;
  reload?: () => Promise<HubConfig>;
  initialDefault?: string;
}) {
  const service = await HarnessModelService.load({
    environment: {},
    ...(options.file ? { file: options.file } : {}),
    ports,
  });
  const manager = new EngineManager({
    config: options.config,
    persistence: options.persistence,
    load: options.reload ?? (async () => options.config),
    discover: async () => [],
    policy: service.policy(),
    ...(options.initialDefault
      ? { initialDefault: options.initialDefault }
      : {}),
  });
  service.bind({
    catalog: manager,
    sessions: {} as never,
    scratchDirectory: os.tmpdir(),
  });
  return { service, manager };
}
const byId = (profiles: EngineProfile[]) =>
  new Map(profiles.map((profile) => [profile.id, profile]));

void test("without a unified model the manager publishes declared registrations unchanged", async () => {
  const declared = [normalizeEngine(vendorOpenCode), demo];
  const { manager } = await start({
    config: hubConfig(declared),
    persistence: memoryCatalog(),
  });
  assert.deepEqual(manager.list(), declared);
  const registered = await manager.register(apiEngine);
  assert.equal(registered.revision, normalizeEngine(apiEngine).revision);
  assert.deepEqual(registered.credentialEnv, ["GITHUB_TOKEN"]);
  await manager.close();
});

void test("the unified model covers file, reload, API and restored overlay registrations and PUT publishes new revisions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-manager-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness-model.json");
  const persistence = memoryCatalog();
  const base = hubConfig(
    [normalizeEngine(vendorOpenCode), normalizeEngine(cursor), demo],
    "opencode",
  );
  let current = base;
  const setup = await start({
    file,
    config: base,
    persistence,
    reload: async () => current,
  });
  assert.equal(setup.manager.list()[0]!.model, "deepseek-v4-flash");
  const configured = await setup.service.set(first);
  assert.equal(configured.source, "file");

  const effective = byId(setup.manager.list());
  const declared = byId(setup.manager.declared());
  const opencode = effective.get("opencode")!;
  assert.equal(opencode.model, "GLM-V5_1-DX");
  assert.equal(opencode.credentialEnv, undefined);
  assert.deepEqual(opencode.configuration?.provider, {
    ...first.provider,
    modelAlias: "harnesshub-model",
  });
  assert.equal(declared.get("opencode")!.model, "deepseek-v4-flash");
  assert.equal(effective.get("cursor")!.enabled, false);
  assert.equal(effective.get("fake"), demo);
  assert.throws(
    () => setup.manager.resolve("cursor"),
    (error: unknown) =>
      error instanceof HubError &&
      error.code === "ENGINE_UNAVAILABLE" &&
      /cursor/.test(error.message) &&
      /网关/.test(error.message),
  );

  const registered = await setup.manager.register(apiEngine);
  assert.equal(registered.model, "GLM-V5_1-DX");
  assert.equal(registered.credentialEnv, undefined);
  assert.equal(
    registered.configuration?.provider?.baseUrl,
    "http://aigateway.example/v1",
  );
  assert.equal(
    byId(setup.manager.declared()).get("copilot")!.model,
    "gpt-vendor",
  );

  current = hubConfig(
    [
      ...base.engines,
      normalizeEngine({
        id: "hermes",
        driver: "acp",
        command: ["/opt/hermes", "acp"],
      }),
    ],
    "opencode",
  );
  await setup.manager.reload();
  const reloaded = byId(setup.manager.list()).get("hermes")!;
  assert.equal(reloaded.model, "GLM-V5_1-DX");
  assert.equal(reloaded.configuration?.adapter, "hermes");

  const before = byId(setup.manager.list());
  const view = await setup.service.set(second);
  assert.equal(view.alias, "contest-model");
  const after = byId(setup.manager.list());
  for (const id of ["opencode", "copilot", "hermes"]) {
    assert.notEqual(after.get(id)!.revision, before.get(id)!.revision, id);
    assert.equal(after.get(id)!.model, "deepseek-flash", id);
    assert.equal(
      setup.manager.resolve(id, before.get(id)!.revision).model,
      "GLM-V5_1-DX",
      id,
    );
  }
  assert.deepEqual(
    view.engines.map((engine) => [engine.engineId, engine.status]),
    [
      ["opencode", "applied"],
      ["cursor", "unsupported"],
      ["hermes", "applied"],
      ["copilot", "applied"],
    ],
  );
  assert.match(
    view.engines.find((engine) => engine.engineId === "copilot")!.reason!,
    /GITHUB_TOKEN/,
  );
  await setup.manager.close();

  const restarted = await start({ file, config: current, persistence });
  assert.deepEqual(
    restarted.manager.list().map((profile) => profile.revision),
    setup.manager.list().map((profile) => profile.revision),
  );
  await restarted.manager.close();

  const unconfigured = await start({ config: current, persistence });
  const restored = byId(unconfigured.manager.list()).get("copilot")!;
  assert.equal(restored.model, "gpt-vendor");
  assert.deepEqual(restored.credentialEnv, ["GITHUB_TOKEN"]);
  assert.equal(
    unconfigured.manager.resolve("copilot", after.get("copilot")!.revision)
      .model,
    "deepseek-flash",
  );
  await unconfigured.manager.close();

  await assert.rejects(
    start({ file, config: current, persistence, initialDefault: "cursor" }),
    (error: unknown) =>
      error instanceof HubError && /适配器 cursor/.test(error.message),
  );
});
