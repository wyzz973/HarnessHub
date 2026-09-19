import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  harnessModelCommand,
  harnessModelReport,
} from "../../src/release-main.js";
import type { EngineRegistration } from "../../src/domain/engines.js";
import type { BundleSettings } from "../../src/distribution/types.js";

const registrations: EngineRegistration[] = [
  {
    id: "opencode",
    driver: "acp",
    command: [
      "C:/bundle/runtime/node.exe",
      "launch-engine.mjs",
      "--",
      "opencode.exe",
      "acp",
    ],
    credentialEnv: ["DEEPSEEK_API_KEY"],
    configuration: { adapter: "opencode" },
  },
  {
    id: "cursor",
    driver: "cli",
    command: ["C:/bundle/engines/cursor/cursor-agent.exe", "--print"],
    configuration: { adapter: "cursor" },
  },
];
const setArgs = [
  "set",
  "--model",
  "GLM-V5_1-DX",
  "--base-url",
  "http://aigateway.example/v1",
  "--api-key-env",
  "COMPANY_MODEL_API_KEY",
  "--context-window",
  "131072",
  "--max-output-tokens",
  "16384",
  "--header",
  "X-Tenant=contest",
  "--header",
  "X-App=hub=1",
  "--alias",
  "contest-model",
];

void test("hub.cmd model set writes a private validated model file and reports shadowing and missing keys", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-release-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state", "harness-model.json");
  const options = {
    file,
    settings: { schemaVersion: 1 } as BundleSettings,
    environment: { HARNESSHUB_MODEL: "from-environment" },
    registrations: async () => registrations,
  };
  const output = (await harnessModelCommand(setArgs, options)) as {
    saved: boolean;
    modelCalled: boolean;
    alias: string;
    warnings: string[];
  };
  assert.equal(output.saved, true);
  assert.equal(output.modelCalled, false);
  assert.equal(output.alias, "contest-model");
  assert.equal(output.warnings.length, 2);
  assert.match(output.warnings.join("\n"), /HARNESSHUB_MODEL/);
  assert.match(output.warnings.join("\n"), /COMPANY_MODEL_API_KEY/);
  const saved = JSON.parse(await readFile(file, "utf8")) as unknown;
  assert.deepEqual(saved, {
    model: "GLM-V5_1-DX",
    alias: "contest-model",
    provider: {
      protocol: "openai-completions",
      baseUrl: "http://aigateway.example/v1",
      apiKey: { kind: "env", value: "COMPANY_MODEL_API_KEY" },
      headers: { "X-Tenant": "contest", "X-App": "hub=1" },
      contextWindow: 131072,
      maxOutputTokens: 16384,
    },
  });
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const bytes = await readFile(file, "utf8");
  const withValue = (flag: string, value: string) => {
    const copy = [...setArgs];
    copy[copy.indexOf(flag) + 1] = value;
    return copy;
  };
  for (const args of [
    setArgs.filter((_, i) => i < 5),
    withValue("--context-window", "128k"),
    withValue("--max-output-tokens", "0"),
    withValue("--base-url", "https://x.example/v1?key=1"),
    withValue("--api-key-env", "lower-case"),
    ["set", ...setArgs.slice(1), "--header", "no-separator"],
    ["set", ...setArgs.slice(1), "--header", "x-tenant=again"],
    [
      "set",
      ...setArgs.slice(1),
      "--header",
      "Authorization=Bearer abcdefghijklmnop",
    ],
    ["set", ...setArgs.slice(1), "--unknown"],
    ["unset"],
    ["show", "--extra"],
  ])
    await assert.rejects(
      harnessModelCommand(args, { ...options, environment: {} }),
      args.join(" "),
    );
  assert.equal(await readFile(file, "utf8"), bytes);
});

void test("hub.cmd model show applies the Gateway priority and reports per-engine outcomes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-release-show-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness-model.json");
  const settings: BundleSettings = {
    schemaVersion: 1,
    model: {
      model: "settings-model",
      provider: {
        protocol: "openai-completions",
        baseUrl: "https://settings.example/v1",
        apiKey: { kind: "env", value: "SETTINGS_KEY" },
      },
    },
  };
  const none = await harnessModelReport({
    file,
    settings: { schemaVersion: 1 },
    environment: {},
    registrations,
  });
  assert.equal(none.configured, false);
  assert.deepEqual(none.engines, []);
  const fromSettings = (await harnessModelCommand(["show"], {
    file,
    settings,
    environment: {},
    registrations: async () => registrations,
  })) as Awaited<ReturnType<typeof harnessModelReport>>;
  assert.equal(fromSettings.source, "settings");
  assert.equal(fromSettings.model, "settings-model");
  assert.equal(fromSettings.alias, "harnesshub-model");
  assert.deepEqual(
    fromSettings.engines.map((engine) => [engine.engineId, engine.status]),
    [
      ["opencode", "applied"],
      ["cursor", "unsupported"],
    ],
  );
  assert.match(fromSettings.engines[0]!.reason!, /DEEPSEEK_API_KEY/);
  await harnessModelCommand(setArgs, {
    file,
    settings,
    environment: {},
    registrations: async () => registrations,
  });
  const fromFile = await harnessModelReport({
    file,
    settings,
    environment: {},
    registrations,
  });
  assert.equal(fromFile.source, "file");
  assert.deepEqual(fromFile.sources, {
    environment: false,
    file: true,
    settings: true,
  });
  const fromEnvironment = await harnessModelReport({
    file,
    settings,
    environment: {
      HARNESSHUB_MODEL: "env-model",
      HARNESSHUB_MODEL_BASE_URL: "https://env.example/v1",
    },
    registrations,
  });
  assert.equal(fromEnvironment.source, "environment");
  assert.equal(fromEnvironment.model, "env-model");
  await assert.rejects(
    harnessModelReport({
      file,
      settings,
      environment: { HARNESSHUB_MODEL_BASE_URL: "https://env.example/v1" },
      registrations,
    }),
  );
});
