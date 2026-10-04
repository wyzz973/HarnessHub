// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("qoder", {
  protocol: "chat",
  executables: ["qodercli"],
  files: [".qoder/settings.json"],
  locations: [
    {
      env: { QODER_CONFIG_DIR: "qoder", QODERCN_CONFIG_DIR: "cn" },
      files: ["qoder/settings.json"],
    },
  ],
  existing: {
    ".qoder/settings.json": `{
  "model": { "name": "auto", "reasoningEffort": "high" },
  "theme": "dark"
}
`,
  },
  golden: {
    empty: {
      ".qoder/settings.json": `{
  "providers": {
    "harnesshub": {
      "displayName": "HarnessHub",
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "model": "deepseek/deepseek-chat",
      "models": [
        {
          "model": "deepseek/deepseek-chat",
          "displayName": "deepseek/deepseek-chat",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextWindow": 128000,
          "maxOutputTokens": 8192
        },
        {
          "model": "openai/gpt-5",
          "displayName": "openai/gpt-5",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextWindow": 400000
        }
      ]
    }
  },
  "model": {
    "name": "harnesshub/deepseek/deepseek-chat"
  }
}
`,
    },
    existing: {
      ".qoder/settings.json": `{
  "model": { "name": "harnesshub/deepseek/deepseek-chat", "reasoningEffort": "high" },
  "theme": "dark",
  "providers": {
    "harnesshub": {
      "displayName": "HarnessHub",
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:3180/v1",
      "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "model": "deepseek/deepseek-chat",
      "models": [
        {
          "model": "deepseek/deepseek-chat",
          "displayName": "deepseek/deepseek-chat",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextWindow": 128000,
          "maxOutputTokens": 8192
        },
        {
          "model": "openai/gpt-5",
          "displayName": "openai/gpt-5",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextWindow": 400000
        }
      ]
    }
  }
}
`,
    },
  },
});
