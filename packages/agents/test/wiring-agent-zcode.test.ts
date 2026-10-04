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
adapterSuite("zcode", {
  protocol: "anthropic",
  executables: [],
  files: [".zcode/v2/config.json", ".zcode/v2/provider_config.json"],
  locations: [],
  existing: {
    ".zcode/v2/config.json": `{
  "provider": {
    "zhipu": {
      "name": "Zhipu",
      "kind": "anthropic",
      "options": { "baseURL": "https://open.bigmodel.cn/api/anthropic" }
    }
  }
}
`,
    ".zcode/v2/provider_config.json": `{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        { "providerId": "zhipu", "providerName": "Zhipu", "enabled": true }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [
        { "providerId": "zhipu", "modelId": "glm-5", "config": {} }
      ],
      "manualProviderModelRules": [
        { "providerId": "harnesshub", "modelId": "openai/gpt-5", "config": { "properties": { "contextWindow": 1000 } } }
      ]
    }
  }
}
`,
  },
  golden: {
    empty: {
      ".zcode/v2/config.json": `{
  "provider": {
    "harnesshub": {
      "name": "HarnessHub",
      "kind": "anthropic",
      "enabled": true,
      "source": "custom",
      "options": {
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "baseURL": "http://127.0.0.1:3180"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat",
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          }
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5",
          "limit": {
            "context": 400000
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          }
        }
      }
    }
  }
}
`,
      ".zcode/v2/provider_config.json": `{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "harnesshub",
          "providerName": "HarnessHub",
          "enabled": true,
          "config": {
            "group": "standard-personal",
            "access": {
              "type": "api-key",
              "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
            },
            "api": {
              "type": "anthropic-messages",
              "baseUrl": "http://127.0.0.1:3180"
            },
            "personalModelIds": [
              "deepseek/deepseek-chat",
              "openai/gpt-5"
            ],
            "modelOrder": [
              "deepseek/deepseek-chat",
              "openai/gpt-5"
            ]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [
        {
          "providerId": "harnesshub",
          "modelId": "deepseek/deepseek-chat",
          "config": {
            "properties": {
              "contextWindow": 128000,
              "inputFormat": {
                "supportsImage": false
              }
            },
            "optionSpecs": {
              "maxOutputTokens": {
                "max": 8192
              }
            }
          }
        },
        {
          "providerId": "harnesshub",
          "modelId": "openai/gpt-5",
          "config": {
            "properties": {
              "contextWindow": 400000,
              "inputFormat": {
                "supportsImage": false
              }
            }
          }
        }
      ]
    }
  }
}
`,
    },
    existing: {
      ".zcode/v2/config.json": `{
  "provider": {
    "zhipu": {
      "name": "Zhipu",
      "kind": "anthropic",
      "options": { "baseURL": "https://open.bigmodel.cn/api/anthropic" }
    },
    "harnesshub": {
      "name": "HarnessHub",
      "kind": "anthropic",
      "enabled": true,
      "source": "custom",
      "options": {
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
        "baseURL": "http://127.0.0.1:3180"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat",
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          }
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5",
          "limit": {
            "context": 400000
          },
          "modalities": {
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          }
        }
      }
    }
  }
}
`,
      ".zcode/v2/provider_config.json": `{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        { "providerId": "zhipu", "providerName": "Zhipu", "enabled": true },
        {
          "providerId": "harnesshub",
          "providerName": "HarnessHub",
          "enabled": true,
          "config": {
            "group": "standard-personal",
            "access": {
              "type": "api-key",
              "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
            },
            "api": {
              "type": "anthropic-messages",
              "baseUrl": "http://127.0.0.1:3180"
            },
            "personalModelIds": [
              "deepseek/deepseek-chat",
              "openai/gpt-5"
            ],
            "modelOrder": [
              "deepseek/deepseek-chat",
              "openai/gpt-5"
            ]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [
        { "providerId": "zhipu", "modelId": "glm-5", "config": {} },
        {
          "providerId": "harnesshub",
          "modelId": "deepseek/deepseek-chat",
          "config": {
            "properties": {
              "contextWindow": 128000,
              "inputFormat": {
                "supportsImage": false
              }
            },
            "optionSpecs": {
              "maxOutputTokens": {
                "max": 8192
              }
            }
          }
        }
      ],
      "manualProviderModelRules": [
        { "providerId": "harnesshub", "modelId": "openai/gpt-5", "config": { "properties": { "contextWindow": 1000 } } }
      ]
    }
  }
}
`,
    },
  },
});

void test("zcode: a provider switched off in ZCode stays off when wired again", async (t) => {
  const context = await sandbox(t);
  const first = await applyWiring("zcode", TARGET, context);
  for (const name of ["config.json", "provider_config.json"]) {
    const file = path.join(context.home, ".zcode", "v2", name);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        '"enabled": true',
        '"enabled": false',
      ),
    );
  }
  const second = await applyWiring("zcode", TARGET, context, {
    previous: first.record,
  });
  for (const name of ["config.json", "provider_config.json"])
    assert.match(
      await readFile(path.join(context.home, ".zcode", "v2", name), "utf8"),
      /"enabled": false/,
      name,
    );
  await unwire(second.record, context);
});
