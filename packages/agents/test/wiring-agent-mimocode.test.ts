// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { planWiring } from "../src/wiring/index.js";
import { sandbox, TARGET, writeFiles } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("mimocode", {
  protocol: "chat",
  executables: ["mimo"],
  files: [".config/mimocode/mimocode.json"],
  locations: [
    {
      env: { MIMOCODE_HOME: "mimo", XDG_CONFIG_HOME: "xdg" },
      files: ["mimo/config/mimocode.json"],
    },
    { env: { XDG_CONFIG_HOME: "xdg" }, files: ["xdg/mimocode/mimocode.json"] },
  ],
  existing: {
    ".config/mimocode/mimocode.jsonc": `{
  "$schema": "https://opencode.ai/config.json",
  // MiMo defaults
  "model": "xiaomi/mimo-v2-pro",
  "provider": {
    "xiaomi": { "options": { "baseURL": "https://api.xiaomimimo.com/v1" } },
  },
}
`,
  },
  golden: {
    empty: {
      ".config/mimocode/mimocode.json": `{
  "provider": {
    "harnesshub": {
      "name": "HarnessHub",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3180/v1",
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat",
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "variants": {}
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5",
          "limit": {
            "context": 400000,
            "output": 0
          },
          "variants": {}
        }
      }
    }
  },
  "model": "harnesshub/deepseek/deepseek-chat",
  "small_model": "harnesshub/deepseek/deepseek-chat"
}
`,
    },
    existing: {
      ".config/mimocode/mimocode.jsonc": `{
  "$schema": "https://opencode.ai/config.json",
  // MiMo defaults
  "model": "harnesshub/deepseek/deepseek-chat",
  "provider": {
    "xiaomi": { "options": { "baseURL": "https://api.xiaomimimo.com/v1" } },
    "harnesshub": {
      "name": "HarnessHub",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3180/v1",
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat",
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "variants": {}
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5",
          "limit": {
            "context": 400000,
            "output": 0
          },
          "variants": {}
        }
      }
    },
  },
  "small_model": "harnesshub/deepseek/deepseek-chat",
}
`,
    },
  },
});

void test("mimocode: edits the first of mimocode.jsonc, mimocode.json and config.json that exists", async (t) => {
  const context = await sandbox(t);
  const directory = path.join(context.home, ".config", "mimocode");
  const edited = async () =>
    (await planWiring("mimocode", TARGET, context)).files[0]!.path;
  await writeFiles(context.home, { ".config/mimocode/config.json": "{}\n" });
  assert.equal(await edited(), path.join(directory, "config.json"));
  await writeFiles(context.home, { ".config/mimocode/mimocode.json": "{}\n" });
  assert.equal(await edited(), path.join(directory, "mimocode.json"));
  await writeFiles(context.home, {
    ".config/mimocode/mimocode.jsonc": "{}\n",
  });
  assert.equal(await edited(), path.join(directory, "mimocode.jsonc"));
});
