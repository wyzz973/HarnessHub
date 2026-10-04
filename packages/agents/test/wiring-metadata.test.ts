// SPDX-License-Identifier: MIT
/**
 * Reasoning levels, image input and the start effort of the adapters that
 * follow Magpie's agents, for a reasoning model that takes images and one
 * that does neither.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  applyWiring,
  planWiring,
  WiringError,
  type WiringTarget,
} from "../src/wiring/index.js";
import { KEY, sandbox } from "./wiring-support.js";

const PLAIN: WiringTarget = {
  baseUrl: "http://127.0.0.1:3180",
  ...KEY,
  model: "anthropic/claude-opus-5-5",
  models: [
    {
      ref: "anthropic/claude-opus-5-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      efforts: ["low", "medium", "high", "max"],
      images: true,
      nativeProtocols: ["anthropic"],
    },
    { ref: "deepseek/deepseek-chat", contextWindow: 128_000 },
  ],
};
const TARGET: WiringTarget = { ...PLAIN, effort: "high" };

/** The value at a path of parsed configuration, or undefined. */
function at(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys)
    current =
      typeof current === "object" && current !== null
        ? (current as Record<string | number, unknown>)[key]
        : undefined;
  return current;
}

async function wired(
  t: Parameters<typeof sandbox>[0],
  id: string,
  file: string,
  target: WiringTarget = TARGET,
): Promise<unknown> {
  const context = await sandbox(t);
  await applyWiring(id, target, context);
  const text = await readFile(path.join(context.home, file), "utf8");
  return file.endsWith(".toml")
    ? parseToml(text)
    : file.endsWith(".yaml") || file.endsWith(".yml")
      ? (parseYaml(text) as unknown)
      : (JSON.parse(text) as unknown);
}

void test("hermes: the effort goes to agent.reasoning_effort", async (t) => {
  const config = await wired(t, "hermes", ".hermes/config.yaml");
  assert.equal(at(config, "agent", "reasoning_effort"), "high");
});

void test("minimax-code: a thinking model offers its levels, starting at high, and says it takes images", async (t) => {
  const config = await wired(t, "minimax-code", ".minimax/config.yaml", PLAIN);
  const models = at(config, "custom_provider", "harnesshub", "models");
  assert.deepEqual(at(models, "anthropic/claude-opus-5-5"), {
    name: "anthropic/claude-opus-5-5",
    limit: { context: 1_000_000, output: 128_000 },
    reasoning: true,
    thinking: {
      effortOptions: ["low", "medium", "high", "max"],
      defaultEffort: "high",
    },
    capabilities: { support_image: true },
  });
  assert.deepEqual(at(models, "deepseek/deepseek-chat"), {
    name: "deepseek/deepseek-chat",
    limit: { context: 128_000 },
    reasoning: false,
  });
});

void test("grok: each model lists its reasoning efforts in Grok's order, and the effort is the default", async (t) => {
  const config = await wired(t, "grok", ".grok/config.toml");
  assert.deepEqual(
    at(
      config,
      "model",
      "harnesshub/anthropic/claude-opus-5-5",
      "reasoning_efforts",
    ),
    ["low", "medium", "high", "max"],
  );
  assert.equal(
    at(
      config,
      "model",
      "harnesshub/deepseek/deepseek-chat",
      "reasoning_efforts",
    ),
    undefined,
  );
  assert.equal(at(config, "models", "default_reasoning_effort"), "high");
});

void test("qoder: vision and thinking capabilities per model, the effort as the model's preference", async (t) => {
  const settings = await wired(t, "qoder", ".qoder/settings.json");
  const [opus, deepseek] = at(
    settings,
    "providers",
    "harnesshub",
    "models",
  ) as unknown[];
  assert.deepEqual(at(opus, "capabilities"), {
    tools: true,
    vision: true,
    thinking: {
      modes: ["enabled"],
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
      requiresBudgetForEnabled: false,
    },
  });
  assert.deepEqual(at(deepseek, "capabilities"), {
    tools: true,
    vision: false,
  });
  assert.equal(
    at(
      settings,
      "model",
      "preferences",
      "harnesshub/anthropic/claude-opus-5-5",
      "reasoning",
      "effort",
    ),
    "high",
  );
  assert.equal(at(settings, "model", "reasoningEffort"), "high");
});

void test("cline: images and reasoning among the capabilities, the effort as the slot's reasoning", async (t) => {
  const context = await sandbox(t);
  await applyWiring("cline", { ...TARGET, effort: "none" }, context);
  const read = async (name: string) =>
    JSON.parse(
      await readFile(
        path.join(context.home, ".cline", "data", "settings", name),
        "utf8",
      ),
    ) as unknown;
  const models = at(
    await read("models.json"),
    "providers",
    "openai-compatible",
    "models",
  );
  assert.deepEqual(at(models, "anthropic/claude-opus-5-5", "capabilities"), [
    "streaming",
    "tools",
    "images",
    "reasoning",
  ]);
  assert.deepEqual(at(models, "deepseek/deepseek-chat", "capabilities"), [
    "streaming",
    "tools",
  ]);
  assert.deepEqual(
    at(
      await read("providers.json"),
      "providers",
      "openai-compatible",
      "settings",
      "reasoning",
    ),
    { enabled: false },
  );
  await assert.rejects(
    planWiring("cline", { ...TARGET, effort: "max" }, await sandbox(t)),
    (error: unknown) =>
      error instanceof WiringError && error.code === "WIRING_TARGET_INVALID",
  );
});

void test("omp: native protocol, image input and thinking levels per model, xhigh standing in for max", async (t) => {
  const context = await sandbox(t);
  await applyWiring("omp", TARGET, context);
  const read = async (name: string) =>
    parseYaml(
      await readFile(path.join(context.home, ".omp", "agent", name), "utf8"),
    ) as unknown;
  const [opus, deepseek] = at(
    await read("models.yml"),
    "providers",
    "harnesshub",
    "models",
  ) as unknown[];
  assert.deepEqual(opus, {
    id: "anthropic/claude-opus-5-5",
    name: "anthropic/claude-opus-5-5",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:3180",
    reasoning: true,
    input: ["text", "image"],
    thinking: { mode: "budget", efforts: ["low", "medium", "high", "xhigh"] },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  });
  assert.deepEqual(deepseek, {
    id: "deepseek/deepseek-chat",
    name: "deepseek/deepseek-chat",
    reasoning: false,
    contextWindow: 128_000,
  });
  assert.equal(at(await read("config.yml"), "defaultThinkingLevel"), "high");
});

void test("pencil: reasoning, image input and Pi's thinking-level map, as Pi has them", async (t) => {
  const models = at(
    await wired(t, "pencil", ".pencil/models.json", PLAIN),
    "providers",
    "harnesshub",
    "models",
  ) as unknown[];
  assert.equal(at(models[0], "reasoning"), true);
  assert.deepEqual(at(models[0], "input"), ["text", "image"]);
  assert.deepEqual(at(models[0], "thinkingLevelMap"), {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    max: "max",
  });
  assert.equal(at(models[1], "reasoning"), false);
  assert.equal(at(models[1], "thinkingLevelMap"), undefined);
});
