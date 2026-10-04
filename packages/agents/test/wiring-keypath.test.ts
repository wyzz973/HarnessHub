// SPDX-License-Identifier: MIT
/**
 * The agents that send no key of their own carry it in the base URL's path
 * (ADR 0033): the key is found there again, a key the user put in its place
 * is drift, and what each agent lists follows Magpie.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  detectDrift,
  unwire,
  wiredKeyText,
  type WiringModel,
} from "../src/wiring/index.js";
import { NEW_KEY, sandbox, TARGET, writeFiles } from "./wiring-support.js";

const FILES: Record<string, { file: string; base: string[] }> = {
  commandcode: {
    file: ".commandcode/providers.json",
    base: ["provider", "harnesshub", "baseURL"],
  },
  fx: {
    file: ".fx/settings.json",
    base: ["providers", "harnesshub", "base_url"],
  },
  muse: {
    file: ".config/muse/settings.json",
    base: ["endpoint_transport", "base_url"],
  },
};

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function at(document: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key],
    document,
  );
}

for (const [id, { file, base }] of Object.entries(FILES))
  void test(`${id}: the key is in the base URL's path, found there again, and another key there is drift`, async (t) => {
    const context = await sandbox(t);
    const { record } = await applyWiring(id, TARGET, context);
    const full = path.join(context.home, file);
    assert.equal(
      at(await json(full), base),
      `${TARGET.baseUrl}/k/${TARGET.keyText}/v1`,
    );
    assert.equal(await wiredKeyText(record, context), TARGET.keyText);
    await writeFile(
      full,
      (await readFile(full, "utf8")).replace(TARGET.keyText, NEW_KEY.keyText),
    );
    const report = await detectDrift(record, context);
    assert.equal(report.drifted, true);
    assert.equal(await wiredKeyText(record, context), undefined);
    assert.doesNotMatch(JSON.stringify(report), /hhk_/);
  });

const MODELS: WiringModel[] = [
  {
    ref: "deepseek/deepseek-chat",
    contextWindow: 128_000,
    maxOutputTokens: 128_000,
    efforts: ["none", "low", "high", "max"],
    images: false,
  },
  {
    ref: "openai/gpt-5",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    images: true,
  },
];

void test("commandcode: each model offers its levels, and the effort is the chosen model's own", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, {
    ".commandcode/settings.json":
      '{"reasoningEffort": {"anthropic/claude-sonnet-4-5": "high"}}\n',
  });
  const { record } = await applyWiring(
    "commandcode",
    { ...TARGET, models: MODELS, effort: "max" },
    context,
  );
  const providers = await json(
    path.join(context.home, ".commandcode/providers.json"),
  );
  assert.deepEqual(at(providers, ["provider", "harnesshub", "models"]), {
    "deepseek/deepseek-chat": {
      name: "deepseek/deepseek-chat",
      reasoning: true,
      reasoningEfforts: ["low", "high", "max"],
    },
    "openai/gpt-5": { name: "openai/gpt-5" },
  });
  const settings = path.join(context.home, ".commandcode/settings.json");
  assert.deepEqual((await json(settings)).reasoningEffort, {
    "anthropic/claude-sonnet-4-5": "high",
    "harnesshub/deepseek/deepseek-chat": "max",
  });
  await unwire(record, context);
  assert.equal(
    await readFile(settings, "utf8"),
    '{"reasoningEffort": {"anthropic/claude-sonnet-4-5": "high"}}\n',
  );
});

void test("fx: the chosen model comes first in at most 256, with an output limit only below the window", async (t) => {
  const context = await sandbox(t);
  const many: WiringModel[] = Array.from({ length: 300 }, (_, index) => ({
    ref: `bulk/m${String(index).padStart(3, "0")}`,
  }));
  await applyWiring(
    "fx",
    {
      ...TARGET,
      model: "openai/gpt-5",
      models: [...many, ...MODELS],
    },
    context,
  );
  const metadata = at(
    await json(path.join(context.home, ".fx/settings.json")),
    ["providers", "harnesshub", "model_metadata"],
  ) as Record<string, unknown>;
  const ids = Object.keys(metadata);
  assert.equal(ids.length, 256);
  assert.equal(ids[0], "openai/gpt-5");
  assert.deepEqual(metadata["openai/gpt-5"], {
    supports_tool_use: true,
    supports_vision: true,
    context_window: 400_000,
    max_output_tokens: 128_000,
  });
});

void test("fx: an output limit as large as the window is not written", async (t) => {
  const context = await sandbox(t);
  await applyWiring("fx", { ...TARGET, models: MODELS }, context);
  const metadata = at(
    await json(path.join(context.home, ".fx/settings.json")),
    ["providers", "harnesshub", "model_metadata"],
  ) as Record<string, unknown>;
  assert.deepEqual(metadata["deepseek/deepseek-chat"], {
    supports_tool_use: true,
    supports_vision: false,
    context_window: 128_000,
  });
});

void test("muse: a settings file without its schema version gets one, and unwire takes it away again", async (t) => {
  const context = await sandbox(t);
  const original = '{"theme": "dark"}\n';
  await writeFiles(context.home, { ".config/muse/settings.json": original });
  const file = path.join(context.home, ".config/muse/settings.json");
  const { record } = await applyWiring("muse", TARGET, context);
  const wired = await json(file);
  assert.equal(wired.schema_version, 1);
  assert.deepEqual(wired.endpoint_transport, {
    base_url: `${TARGET.baseUrl}/k/${TARGET.keyText}/v1`,
    auth: "none",
  });
  await unwire(record, context);
  assert.equal(await readFile(file, "utf8"), original);
});
