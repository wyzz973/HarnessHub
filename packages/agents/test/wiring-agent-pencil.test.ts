// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { detectAgent } from "../src/wiring/index.js";
import { sandbox } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("pencil", {
  protocol: "chat",
  executables: [],
  files: [".pencil/models.json"],
  locations: [],
  existing: {
    ".pencil/models.json": `{
  "providers": {
    "mine": {
      "name": "mine",
      "baseUrl": "https://x/v1",
      "api": "openai-responses",
      "models": [{ "id": "m", "name": "M" }]
    }
  }
}
`,
  },
  golden: {
    empty: {
      ".pencil/models.json": `{
  "providers": {
    "harnesshub": {
      "name": "HarnessHub",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "api": "openai-completions",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "models": [
        {
          "id": "deepseek/deepseek-chat",
          "name": "deepseek/deepseek-chat",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {}
        },
        {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 400000,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {}
        }
      ]
    }
  }
}
`,
    },
    existing: {
      ".pencil/models.json": `{
  "providers": {
    "mine": {
      "name": "mine",
      "baseUrl": "https://x/v1",
      "api": "openai-responses",
      "models": [{ "id": "m", "name": "M" }]
    },
    "harnesshub": {
      "name": "HarnessHub",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "api": "openai-completions",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "models": [
        {
          "id": "deepseek/deepseek-chat",
          "name": "deepseek/deepseek-chat",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {}
        },
        {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 400000,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {}
        }
      ]
    }
  }
}
`,
    },
  },
});

void test("pencil: having no command, is found by its configuration directory", async (t) => {
  const context = await sandbox(t);
  const env = { PATH: path.join(context.root, "bin") };
  await mkdir(env.PATH);
  assert.equal(
    (await detectAgent("pencil", { ...context, env })).status,
    "not-found",
  );
  const directory = path.join(context.home, ".pencil");
  await mkdir(directory);
  assert.deepEqual(await detectAgent("pencil", { ...context, env }), {
    status: "configured-only",
    configDirectories: [directory],
  });
});
