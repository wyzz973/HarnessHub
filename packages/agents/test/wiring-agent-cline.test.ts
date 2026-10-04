// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { applyWiring, unwire } from "../src/wiring/index.js";
import { editors } from "../src/wiring/formats/index.js";
import { sandbox, TARGET } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("cline", {
  protocol: "chat",
  executables: ["cline"],
  files: [
    ".cline/data/settings/providers.json",
    ".cline/data/settings/models.json",
  ],
  locations: [
    {
      env: { CLINE_DIR: "cline" },
      files: [
        "cline/data/settings/providers.json",
        "cline/data/settings/models.json",
      ],
    },
    {
      env: { CLINE_DIR: "cline", CLINE_DATA_DIR: "data" },
      files: ["data/settings/providers.json", "data/settings/models.json"],
    },
  ],
  existing: {
    ".cline/data/settings/providers.json": `{"version":1,"lastUsedProvider":"anthropic","modes":{},"providers":{
  "anthropic":{"settings":{"provider":"anthropic","apiKey":"sk-a","model":"claude-opus-5","reasoning":{"effort":"high"}},"updatedAt":"2026-09-01T00:00:00.000Z","tokenSource":"manual"},
  "openai-compatible":{"settings":{"provider":"openai-compatible","apiKey":"sk-o","model":"mine","baseUrl":"https://x/v1"},"updatedAt":"2026-09-01T00:00:00.000Z","tokenSource":"manual"}}}
`,
    ".cline/data/settings/models.json": `{"version":1,"providers":{"openai-compatible":{"provider":{"name":"mine","baseUrl":"https://x/v1","defaultModelId":"mine"},"models":{"mine":{"id":"mine"}}},"ollama":{"models":{"q":{"id":"q"}}}}}
`,
  },
  golden: {
    empty: {
      ".cline/data/settings/models.json": `{
  "version": 1,
  "providers": {
    "openai-compatible": {
      "provider": {
        "name": "HarnessHub",
        "baseUrl": "http://127.0.0.1:3180/v1",
        "defaultModelId": "deepseek/deepseek-chat"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "id": "deepseek/deepseek-chat",
          "name": "deepseek/deepseek-chat",
          "capabilities": [
            "streaming",
            "tools"
          ],
          "contextWindow": 128000,
          "maxTokens": 8192
        },
        "openai/gpt-5": {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "capabilities": [
            "streaming",
            "tools"
          ],
          "contextWindow": 400000
        }
      }
    }
  }
}
`,
      ".cline/data/settings/providers.json": `{
  "version": 1,
  "providers": {
    "openai-compatible": {
      "settings": {
        "provider": "openai-compatible",
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "model": "deepseek/deepseek-chat",
        "baseUrl": "http://127.0.0.1:3180/v1"
      },
      "tokenSource": "manual"
    }
  },
  "lastUsedProvider": "openai-compatible"
}
`,
    },
    existing: {
      ".cline/data/settings/models.json": `{"version":1,"providers":{"openai-compatible":{ "provider": { "name": "HarnessHub", "baseUrl": "http://127.0.0.1:3180/v1", "defaultModelId": "deepseek/deepseek-chat" }, "models": { "deepseek/deepseek-chat": { "id": "deepseek/deepseek-chat", "name": "deepseek/deepseek-chat", "capabilities": ["streaming", "tools"], "contextWindow": 128000, "maxTokens": 8192 }, "openai/gpt-5": { "id": "openai/gpt-5", "name": "openai/gpt-5", "capabilities": ["streaming", "tools"], "contextWindow": 400000 } } },"ollama":{"models":{"q":{"id":"q"}}}}}
`,
      ".cline/data/settings/providers.json": `{"version":1,"lastUsedProvider":"openai-compatible","modes":{},"providers":{
  "anthropic":{"settings":{"provider":"anthropic","apiKey":"sk-a","model":"claude-opus-5","reasoning":{"effort":"high"}},"updatedAt":"2026-09-01T00:00:00.000Z","tokenSource":"manual"},
  "openai-compatible":{
    "settings": {
      "provider": "openai-compatible",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "model": "deepseek/deepseek-chat",
      "baseUrl": "http://127.0.0.1:3180/v1"
    },
    "tokenSource": "manual"
  }}}
`,
    },
  },
  restoresByValue: [
    ".cline/data/settings/providers.json",
    ".cline/data/settings/models.json",
  ],
});

void test("cline: starts a missing file from its schema version, which a key-level unwire keeps", async (t) => {
  const context = await sandbox(t);
  const { record, plan } = await applyWiring("cline", TARGET, context);
  for (const file of plan.files) {
    const text = await readFile(file.path, "utf8");
    assert.equal(editors.json.parse(text).version, 1);
    await writeFile(file.path, editors.json.set(text, ["mine"], true));
  }
  const result = await unwire(record, context);
  assert.ok(result.files.every((file) => file.action === "reverse-patched"));
  for (const file of plan.files)
    assert.deepEqual(
      editors.json.parse(await readFile(file.path, "utf8")),
      { version: 1, mine: true },
      file.path,
    );
});
