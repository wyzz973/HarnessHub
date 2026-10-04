// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's agents at 2e340f7; the golden files are
// reviewed output: regenerate them only after reviewing a change to what the
// adapter writes. The key goes in the base URL's path (ADR 0033).
adapterSuite("commandcode", {
  protocol: "chat",
  executables: ["command-code"],
  files: [".commandcode/providers.json", ".commandcode/settings.json"],
  locations: [],
  existing: {
    ".commandcode/providers.json": `{
  "provider": {
    "mine": {
      "name": "Mine",
      "api": "openai-completions",
      "baseURL": "https://x.example/v1",
      "apiKey": "$X",
      "models": { "a": {} }
    }
  }
}
`,
    ".commandcode/settings.json": `{
  "theme": "dark",
  "model": "anthropic/claude-sonnet-4-5",
  "reasoningEffort": { "anthropic/claude-sonnet-4-5": "high" }
}
`,
  },
  golden: {
    empty: {
      ".commandcode/providers.json": `{
  "provider": {
    "harnesshub": {
      "name": "HarnessHub",
      "api": "openai-completions",
      "baseURL": "http://127.0.0.1:3180/k/hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/v1",
      "apiKey": false,
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat"
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5"
        }
      }
    }
  }
}
`,
      ".commandcode/settings.json": `{
  "model": "harnesshub/deepseek/deepseek-chat",
  "modelProvider": "harnesshub"
}
`,
    },
    existing: {
      ".commandcode/providers.json": `{
  "provider": {
    "mine": {
      "name": "Mine",
      "api": "openai-completions",
      "baseURL": "https://x.example/v1",
      "apiKey": "$X",
      "models": { "a": {} }
    },
    "harnesshub": {
      "name": "HarnessHub",
      "api": "openai-completions",
      "baseURL": "http://127.0.0.1:3180/k/hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/v1",
      "apiKey": false,
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat"
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5"
        }
      }
    }
  }
}
`,
      ".commandcode/settings.json": `{
  "theme": "dark",
  "model": "harnesshub/deepseek/deepseek-chat",
  "reasoningEffort": { "anthropic/claude-sonnet-4-5": "high" },
  "modelProvider": "harnesshub"
}
`,
    },
  },
});
