// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("omo", {
  protocol: "chat",
  executables: ["omo"],
  files: [".omo/agent/settings.json", ".omo/agent/models.json"],
  locations: [
    {
      env: { OMO_CODING_AGENT_DIR: "omo", SENPI_CODING_AGENT_DIR: "senpi" },
      files: ["omo/settings.json", "omo/models.json"],
    },
    {
      env: { SENPI_CODING_AGENT_DIR: "senpi" },
      files: ["senpi/settings.json", "senpi/models.json"],
    },
  ],
  existing: {
    ".omo/agent/settings.json": `{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4",
  "theme": "light"
}
`,
    ".omo/agent/models.json": `{
  // OmO providers
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions" }
  }
}
`,
  },
  golden: {
    empty: {
      ".omo/agent/models.json": `{
  "providers": {
    "harnesshub": {
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
          "maxTokens": 8192
        },
        {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 400000
        }
      ]
    }
  }
}
`,
      ".omo/agent/settings.json": `{
  "defaultProvider": "harnesshub",
  "defaultModel": "deepseek/deepseek-chat"
}
`,
    },
    existing: {
      ".omo/agent/models.json": `{
  // OmO providers
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions" },
    "harnesshub": {
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
          "maxTokens": 8192
        },
        {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 400000
        }
      ]
    }
  }
}
`,
      ".omo/agent/settings.json": `{
  "defaultProvider": "harnesshub",
  "defaultModel": "deepseek/deepseek-chat",
  "theme": "light"
}
`,
    },
  },
});
