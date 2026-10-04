// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  planWiring,
  unwire,
  WiringError,
} from "../src/wiring/index.js";
import { sandbox, TARGET, writeFiles } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's agents at 2e340f7; the golden files are
// reviewed output: regenerate them only after reviewing a change to what the
// adapter writes.
adapterSuite("workbuddy", {
  protocol: "chat",
  executables: [],
  files: [".workbuddy/models.json"],
  locations: [
    { env: { WORKBUDDY_CONFIG_DIR: "wb" }, files: ["wb/models.json"] },
  ],
  existing: {
    ".workbuddy/models.json": `{
  "models": [
    {
      "id": "local-qwen",
      "name": "Qwen (local)",
      "vendor": "ollama",
      "url": "http://localhost:11434/v1/chat/completions",
      "local": true
    }
  ],
  "availableModels": ["local-qwen"]
}
`,
  },
  golden: {
    empty: {
      ".workbuddy/models.json": `{
  "models": [
    {
      "name": "deepseek/deepseek-chat",
      "id": "deepseek/deepseek-chat",
      "vendor": "harnesshub",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "url": "http://127.0.0.1:3180/v1/chat/completions",
      "maxInputTokens": 128000,
      "maxOutputTokens": 8192,
      "supportsToolCall": true,
      "supportsImages": false,
      "supportsReasoning": false
    },
    {
      "name": "openai/gpt-5",
      "id": "openai/gpt-5",
      "vendor": "harnesshub",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "url": "http://127.0.0.1:3180/v1/chat/completions",
      "maxInputTokens": 400000,
      "supportsToolCall": true,
      "supportsImages": false,
      "supportsReasoning": false
    }
  ]
}
`,
    },
    existing: {
      ".workbuddy/models.json": `{
  "models": [
    {
      "id": "local-qwen",
      "name": "Qwen (local)",
      "vendor": "ollama",
      "url": "http://localhost:11434/v1/chat/completions",
      "local": true
    },
    {
      "name": "deepseek/deepseek-chat",
      "id": "deepseek/deepseek-chat",
      "vendor": "harnesshub",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "url": "http://127.0.0.1:3180/v1/chat/completions",
      "maxInputTokens": 128000,
      "maxOutputTokens": 8192,
      "supportsToolCall": true,
      "supportsImages": false,
      "supportsReasoning": false
    },
    {
      "name": "openai/gpt-5",
      "id": "openai/gpt-5",
      "vendor": "harnesshub",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "url": "http://127.0.0.1:3180/v1/chat/completions",
      "maxInputTokens": 400000,
      "supportsToolCall": true,
      "supportsImages": false,
      "supportsReasoning": false
    }
  ],
  "availableModels": ["local-qwen", "deepseek/deepseek-chat", "openai/gpt-5"]
}
`,
    },
  },
});

void test("workbuddy: a models.json that is a bare list is refused and left as it is", async (t) => {
  const context = await sandbox(t);
  const bare = '[{"id": "local-qwen", "vendor": "ollama"}]\n';
  await writeFiles(context.home, { ".workbuddy/models.json": bare });
  await assert.rejects(
    planWiring("workbuddy", TARGET, context),
    (error: unknown) =>
      error instanceof WiringError &&
      error.code === "WIRING_UNSUPPORTED_STRUCTURE",
  );
  assert.equal(
    await readFile(
      path.join(context.home, ".workbuddy", "models.json"),
      "utf8",
    ),
    bare,
  );
});

void test("workbuddy: reasoning levels become its efforts, none its switch to turn thinking off", async (t) => {
  const context = await sandbox(t);
  const { record } = await applyWiring(
    "workbuddy",
    {
      ...TARGET,
      models: [
        {
          ref: "deepseek/deepseek-chat",
          efforts: ["none", "low", "high"],
          images: true,
          maxOutputTokens: 500_000,
        },
      ],
    },
    context,
  );
  const file = path.join(context.home, ".workbuddy", "models.json");
  const [entry] = (
    JSON.parse(await readFile(file, "utf8")) as {
      models: Array<Record<string, unknown>>;
    }
  ).models;
  assert.equal(entry!.supportsReasoning, true);
  assert.equal(entry!.supportsImages, true);
  assert.equal(entry!.maxOutputTokens, 128_000);
  assert.deepEqual(entry!.reasoning, {
    supportedEfforts: ["low", "high"],
    canDisableThinking: true,
    defaultEffort: "high",
  });
  await unwire(record, context);
});
