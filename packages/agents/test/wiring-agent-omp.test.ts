// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { applyWiring, planWiring, WiringError } from "../src/wiring/index.js";
import { adapterSuite } from "./wiring-suite.js";
import { sandbox, snapshot, TARGET, writeFiles } from "./wiring-support.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("omp", {
  protocol: "chat",
  executables: ["omp"],
  files: [".omp/agent/config.yml", ".omp/agent/models.yml"],
  locations: [
    {
      env: { PI_CODING_AGENT_DIR: "agent" },
      files: ["agent/config.yml", "agent/models.yml"],
    },
  ],
  existing: {
    ".omp/agent/config.yml": `# omp settings
modelRoles:
  default: anthropic/claude-sonnet-4-5 # mine
  smol: openai/gpt-5-mini
theme: dark
`,
    ".omp/agent/models.yml": `providers:
  mine:
    baseUrl: https://x
    apiKey: X
    api: openai-completions
    models:
      - id: a
`,
  },
  golden: {
    empty: {
      ".omp/agent/config.yml": `modelRoles:
  default: harnesshub/deepseek/deepseek-chat
`,
      ".omp/agent/models.yml": `providers:
  harnesshub:
    baseUrl: http://127.0.0.1:3180/v1
    api: openai-completions
    apiKey: hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
    models:
      - id: deepseek/deepseek-chat
        name: deepseek/deepseek-chat
        reasoning: false
        contextWindow: 128000
        maxTokens: 8192
      - id: openai/gpt-5
        name: openai/gpt-5
        reasoning: false
        contextWindow: 400000
`,
    },
    existing: {
      ".omp/agent/config.yml": `# omp settings
modelRoles:
  default: harnesshub/deepseek/deepseek-chat # mine
  smol: openai/gpt-5-mini
theme: dark
`,
      ".omp/agent/models.yml": `providers:
  mine:
    baseUrl: https://x
    apiKey: X
    api: openai-completions
    models:
      - id: a
  harnesshub:
    baseUrl: http://127.0.0.1:3180/v1
    api: openai-completions
    apiKey: hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
    models:
      - id: deepseek/deepseek-chat
        name: deepseek/deepseek-chat
        reasoning: false
        contextWindow: 128000
        maxTokens: 8192
      - id: openai/gpt-5
        name: openai/gpt-5
        reasoning: false
        contextWindow: 400000
`,
    },
  },
});

void test("omp: finds its agent directory as omp does", async (t) => {
  const context = await sandbox(t);
  const located = async (env: Record<string, string>) =>
    (await planWiring("omp", TARGET, { ...context, env })).files.map((file) =>
      path.relative(context.root, file.path),
    );
  const files = (directory: string) =>
    ["config.yml", "models.yml"].map((name) => path.join(directory, name));
  const pi = path.join(context.root, "pi");
  assert.deepEqual(
    await located({ PI_CONFIG_DIR: ".pi-config" }),
    files("home/.pi-config/agent"),
  );
  // A profile wins over PI_CODING_AGENT_DIR; OMP_PROFILE over PI_PROFILE,
  // even when set empty.
  assert.deepEqual(
    await located({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: pi }),
    files("home/.omp/profiles/work/agent"),
  );
  assert.deepEqual(
    await located({ PI_PROFILE: "work" }),
    files("home/.omp/profiles/work/agent"),
  );
  assert.deepEqual(
    await located({ OMP_PROFILE: "", PI_PROFILE: "work" }),
    files("home/.omp/agent"),
  );
  // "default" and names omp refuses are no profile.
  for (const profile of ["default", "Work", "a.", "../x"])
    assert.deepEqual(
      await located({ OMP_PROFILE: profile, PI_CODING_AGENT_DIR: pi }),
      files("pi"),
      profile,
    );
  await assert.rejects(
    planWiring("omp", TARGET, { ...context, env: { PI_CONFIG_DIR: "../x" } }),
    (error: unknown) =>
      error instanceof WiringError && error.code === "WIRING_CONTEXT_INVALID",
  );
});

void test("omp: edits a .yaml file when only that exists", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, {
    ".omp/agent/models.yaml": "providers: {}\n",
  });
  const plan = await planWiring("omp", TARGET, context);
  assert.deepEqual(
    plan.files.map((file) => path.relative(context.home, file.path)),
    [".omp/agent/config.yml", ".omp/agent/models.yaml"],
  );
});

void test("omp: refuses to create models.yml while omp has yet to migrate models.json", async (t) => {
  const context = await sandbox(t);
  const older = '{ "providers": { "mine": { "baseUrl": "https://x" } } }\n';
  await writeFiles(context.home, { ".omp/agent/models.json": older });
  const before = await snapshot(context.home);
  for (const attempt of [
    planWiring("omp", TARGET, context),
    applyWiring("omp", TARGET, context),
  ])
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof WiringError);
      assert.equal(error.code, "WIRING_UNSUPPORTED_STRUCTURE");
      assert.equal(
        error.path,
        path.join(context.home, ".omp", "agent", "models.json"),
      );
      return true;
    });
  assert.deepEqual(await snapshot(context.home), before);
  // Once omp has moved it, wiring edits models.yml.
  await writeFiles(context.home, {
    ".omp/agent/models.yml": "providers: {}\n",
  });
  const { plan } = await applyWiring("omp", TARGET, context);
  assert.equal(
    plan.files[1]!.path,
    path.join(context.home, ".omp", "agent", "models.yml"),
  );
});
