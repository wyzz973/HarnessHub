// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("hermes", {
  protocol: "chat",
  executables: ["hermes"],
  files: [".hermes/config.yaml"],
  locations: [
    { env: { HERMES_HOME: "hermes" }, files: ["hermes/config.yaml"] },
  ],
  existing: {
    ".hermes/config.yaml": `# Hermes Agent settings
model:
  default: anthropic/claude-sonnet-4 # mine
  provider: openrouter
providers:
  local:
    base_url: http://localhost:11434/v1
    api_mode: chat_completions

agent:
  reasoning_effort: medium
`,
  },
  golden: {
    empty: {
      ".hermes/config.yaml": `providers:
  harnesshub:
    name: HarnessHub
    base_url: http://127.0.0.1:3180/v1
    api_key: hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
    api_mode: chat_completions
    models:
      - deepseek/deepseek-chat
      - openai/gpt-5
model:
  provider: harnesshub
  default: deepseek/deepseek-chat
`,
    },
    existing: {
      ".hermes/config.yaml": `# Hermes Agent settings
model:
  default: deepseek/deepseek-chat # mine
  provider: harnesshub
providers:
  local:
    base_url: http://localhost:11434/v1
    api_mode: chat_completions
  harnesshub:
    name: HarnessHub
    base_url: http://127.0.0.1:3180/v1
    api_key: hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
    api_mode: chat_completions
    models:
      - deepseek/deepseek-chat
      - openai/gpt-5

agent:
  reasoning_effort: medium
`,
    },
  },
});
