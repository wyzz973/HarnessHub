// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { applyWiring, detectDrift, unwire } from "../src/wiring/index.js";
import { editors } from "../src/wiring/formats/index.js";
import { sandbox, TARGET, writeFiles } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// The existing settings follow the layout of a real ~/.dsh (dsh 0.1.5: the
// Models page's agent-default-model and custom providers in settings.yaml);
// the golden files are reviewed output: regenerate them only after
// reviewing a change to what the adapter writes.
const EXISTING: Record<string, string> = {
  ".dsh/settings.yaml": `# dsh settings: the Models page writes here too
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: max
llm-pi-ai:
  providers:
    # a gateway of my own
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
agent-presets:
  default: research
`,
  ".dsh/.env": `# keys dsh reads
GATEWAY_API_KEY=user-own-value
`,
};

adapterSuite("dsh", {
  protocol: "chat",
  keyDelivery: "env-file",
  executables: ["dsh"],
  files: [".dsh/settings.yaml", ".dsh/.env"],
  locations: [
    {
      env: { DSH_HOME: "dsh-home" },
      files: ["dsh-home/settings.yaml", "dsh-home/.env"],
    },
  ],
  existing: EXISTING,
  golden: {
    empty: {
      ".dsh/.env": `HARNESSHUB_GATEWAY_KEY=hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
`,
      ".dsh/settings.yaml": `llm-pi-ai:
  providers:
    harnesshub:
      displayName: HarnessHub
      apiKeyEnv: HARNESSHUB_GATEWAY_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:3180/v1
      models:
        - id: deepseek/deepseek-chat
          name: deepseek/deepseek-chat
          contextWindow: 128000
          maxTokens: 8192
          reasoningEfforts: false
        - id: openai/gpt-5
          name: openai/gpt-5
          contextWindow: 400000
          reasoningEfforts: false
agent-default-model:
  provider: harnesshub
  model: deepseek/deepseek-chat
`,
    },
    existing: {
      ".dsh/.env": `# keys dsh reads
GATEWAY_API_KEY=user-own-value
HARNESSHUB_GATEWAY_KEY=hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
`,
      ".dsh/settings.yaml": `# dsh settings: the Models page writes here too
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: harnesshub
  model: deepseek/deepseek-chat
llm-pi-ai:
  providers:
    # a gateway of my own
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
    harnesshub:
      displayName: HarnessHub
      apiKeyEnv: HARNESSHUB_GATEWAY_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:3180/v1
      models:
        - id: deepseek/deepseek-chat
          name: deepseek/deepseek-chat
          contextWindow: 128000
          maxTokens: 8192
          reasoningEfforts: false
        - id: openai/gpt-5
          name: openai/gpt-5
          contextWindow: 400000
          reasoningEfforts: false
agent-presets:
  default: research
`,
    },
  },
  // The default model of the user's is an object wiring replaces.
  restoresByValue: [".dsh/settings.yaml"],
});

const SETTINGS = ".dsh/settings.yaml";

async function settingsOf(file: string): Promise<Record<string, unknown>> {
  return parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
}

void test("dsh: each model offers the levels it has, and the effort is the default model's level", async (t) => {
  const context = await sandbox(t);
  await applyWiring(
    "dsh",
    {
      ...TARGET,
      effort: "none",
      models: [
        {
          ref: "deepseek/deepseek-chat",
          efforts: ["none", "low", "high"],
          images: true,
        },
        { ref: "openai/gpt-5", efforts: ["none"], images: false },
      ],
    },
    context,
  );
  const settings = await settingsOf(path.join(context.home, SETTINGS));
  const route = (
    settings["llm-pi-ai"] as {
      providers: { harnesshub: { models: unknown[] } };
    }
  ).providers.harnesshub;
  assert.deepEqual(route.models, [
    {
      id: "deepseek/deepseek-chat",
      name: "deepseek/deepseek-chat",
      input: ["text", "image"],
      reasoningEfforts: { off: "none", low: "low", high: "high" },
    },
    // dsh refuses a model whose only level is off.
    {
      id: "openai/gpt-5",
      name: "openai/gpt-5",
      input: ["text"],
      reasoningEfforts: false,
    },
  ]);
  assert.deepEqual(settings["agent-default-model"], {
    provider: "harnesshub",
    model: "deepseek/deepseek-chat",
    reasoningEffort: "off",
  });
});

void test("dsh: a model picked in dsh's Models page is drift until wired again; a provider it adds beside ours is not", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, EXISTING);
  const file = path.join(context.home, SETTINGS);
  let { record } = await applyWiring("dsh", TARGET, context);
  // dsh writes settings.yaml as a leaf-level diff: another provider of the
  // user's leaves ours as it is.
  const wired = await readFile(file, "utf8");
  await writeFile(
    file,
    editors.yaml.set(wired, ["llm-pi-ai", "providers", "another"], {
      apiKeyEnv: "ANOTHER_KEY",
      api: "openai-completions",
      baseURL: "https://another.example/v1",
      models: [{ id: "m" }],
    }),
  );
  assert.equal((await detectDrift(record, context)).drifted, false);
  // Picking dsh's own model there replaces the default model.
  let text = await readFile(file, "utf8");
  for (const [key, value] of [
    ["provider", "deepseek-official"],
    ["model", "deepseek-v4-pro"],
  ] as const)
    text = editors.yaml.set(text, ["agent-default-model", key], value);
  await writeFile(file, text);
  const report = await detectDrift(record, context);
  assert.deepEqual(report.kinds, ["replaced"]);
  assert.deepEqual(
    report.findings.map((finding) => finding.keyPath.join(".")).sort(),
    ["agent-default-model.model", "agent-default-model.provider"],
  );
  // Wiring again takes the default model over; unwire puts the user's back.
  ({ record } = await applyWiring("dsh", TARGET, context, {
    previous: record,
  }));
  assert.equal((await detectDrift(record, context)).drifted, false);
  await unwire(record, context);
  const restored = await settingsOf(file);
  assert.deepEqual(restored["agent-default-model"], {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
  });
  assert.deepEqual(
    Object.keys(
      (restored["llm-pi-ai"] as { providers: Record<string, unknown> })
        .providers,
    ),
    ["my-gateway", "another"],
  );
});
