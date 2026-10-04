// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("minimax-code", {
  protocol: "anthropic",
  executables: ["mcode"],
  files: [".minimax/config.yaml"],
  locations: [
    { env: { MINIMAX_DATA_DIR: "minimax" }, files: ["minimax/config.yaml"] },
  ],
  existing: {
    ".minimax/config.yaml": `# MiniMax Code
defaultModel: minimax/MiniMax-M2.7
provider:
  minimax:
    enabled: true
custom_provider:
  mine:
    name: mine
    kind: custom
    options:
      baseURL: https://example.invalid
`,
  },
  golden: {
    empty: {
      ".minimax/config.yaml": `custom_provider:
  harnesshub:
    name: HarnessHub
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
      baseURL: http://127.0.0.1:3180
      authMode: api-key
    models:
      deepseek/deepseek-chat:
        name: deepseek/deepseek-chat
        limit:
          context: 128000
          output: 8192
        reasoning: false
      openai/gpt-5:
        name: openai/gpt-5
        limit:
          context: 400000
        reasoning: false
defaultModel: custom_provider:harnesshub/deepseek/deepseek-chat
`,
    },
    existing: {
      ".minimax/config.yaml": `# MiniMax Code
defaultModel: custom_provider:harnesshub/deepseek/deepseek-chat
provider:
  minimax:
    enabled: true
custom_provider:
  mine:
    name: mine
    kind: custom
    options:
      baseURL: https://example.invalid
  harnesshub:
    name: HarnessHub
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
      baseURL: http://127.0.0.1:3180
      authMode: api-key
    models:
      deepseek/deepseek-chat:
        name: deepseek/deepseek-chat
        limit:
          context: 128000
          output: 8192
        reasoning: false
      openai/gpt-5:
        name: openai/gpt-5
        limit:
          context: 400000
        reasoning: false
`,
    },
  },
});
