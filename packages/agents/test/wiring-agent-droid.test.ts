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
adapterSuite("droid", {
  protocol: "chat",
  executables: ["droid"],
  files: [".factory/settings.json"],
  locations: [
    {
      env: { FACTORY_HOME_OVERRIDE: "factory" },
      files: ["factory/.factory/settings.json"],
    },
  ],
  existing: {
    ".factory/settings.json": `{
  // Droid settings
  "theme": "dark",
  "customModels": [
    {
      "model": "kimi-k2",
      "displayName": "Kimi K2 [Groq]",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "user-groq-key",
      "provider": "generic-chat-completion-api"
    }
  ],
  "sessionDefaultSettings": {
    "model": "custom:Kimi-K2-[Groq]-0",
    "reasoningEffort": "high"
  }
}
`,
  },
  golden: {
    empty: {
      ".factory/settings.json": `{
  "customModels": [
    {
      "model": "deepseek/deepseek-chat",
      "id": "custom:harnesshub/deepseek/deepseek-chat",
      "displayName": "deepseek/deepseek-chat",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "provider": "generic-chat-completion-api",
      "maxContextLimit": 128000,
      "maxOutputTokens": 8192,
      "noImageSupport": true
    },
    {
      "model": "openai/gpt-5",
      "id": "custom:harnesshub/openai/gpt-5",
      "displayName": "openai/gpt-5",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "provider": "generic-chat-completion-api",
      "maxContextLimit": 400000,
      "noImageSupport": true
    }
  ],
  "sessionDefaultSettings": {
    "model": "custom:harnesshub/deepseek/deepseek-chat"
  }
}
`,
    },
    existing: {
      ".factory/settings.json": `{
  // Droid settings
  "theme": "dark",
  "customModels": [
    {
      "model": "kimi-k2",
      "displayName": "Kimi K2 [Groq]",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "user-groq-key",
      "provider": "generic-chat-completion-api"
    },
    {
      "model": "deepseek/deepseek-chat",
      "id": "custom:harnesshub/deepseek/deepseek-chat",
      "displayName": "deepseek/deepseek-chat",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "provider": "generic-chat-completion-api",
      "maxContextLimit": 128000,
      "maxOutputTokens": 8192,
      "noImageSupport": true
    },
    {
      "model": "openai/gpt-5",
      "id": "custom:harnesshub/openai/gpt-5",
      "displayName": "openai/gpt-5",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "provider": "generic-chat-completion-api",
      "maxContextLimit": 400000,
      "noImageSupport": true
    }
  ],
  "sessionDefaultSettings": {
    "model": "custom:harnesshub/deepseek/deepseek-chat",
    "reasoningEffort": "high"
  }
}
`,
    },
  },
});

void test("droid: a model served natively on Responses or Anthropic Messages is asked there", async (t) => {
  const context = await sandbox(t);
  await applyWiring(
    "droid",
    {
      ...TARGET,
      models: [
        { ref: "deepseek/deepseek-chat", nativeProtocols: ["responses"] },
        {
          ref: "anthropic/claude-opus-5-5",
          nativeProtocols: ["anthropic"],
          images: true,
        },
      ],
    },
    context,
  );
  const settings = JSON.parse(
    await readFile(
      path.join(context.home, ".factory", "settings.json"),
      "utf8",
    ),
  ) as { customModels: Array<Record<string, unknown>> };
  assert.deepEqual(
    settings.customModels.map((model) => [
      model.provider,
      model.baseUrl,
      model.noImageSupport,
    ]),
    [
      ["openai", "http://127.0.0.1:3180/v1", true],
      ["anthropic", "http://127.0.0.1:3180", false],
    ],
  );
});
