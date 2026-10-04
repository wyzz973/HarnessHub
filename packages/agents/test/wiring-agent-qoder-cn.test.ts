// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("qoder-cn", {
  protocol: "chat",
  executables: ["qoderclicn"],
  files: [".qoder-cn/settings.json"],
  locations: [
    {
      env: { QODER_CONFIG_DIR: "qoder", QODERCN_CONFIG_DIR: "cn" },
      files: ["cn/settings.json"],
    },
  ],
  existing: {
    ".qoder-cn/settings.json": `{
  "model": { "name": "auto" },
  "providers": {
    "mine": { "displayName": "mine", "protocol": "openai", "baseUrl": "https://x/v1" }
  }
}
`,
  },
  golden: {
    empty: {
      ".qoder-cn/settings.json": `{
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
      ".qoder-cn/settings.json": `{
  "model": { "name": "harnesshub/deepseek/deepseek-chat" },
  "providers": {
    "mine": { "displayName": "mine", "protocol": "openai", "baseUrl": "https://x/v1" },
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
