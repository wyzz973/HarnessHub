// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's agents at 2e340f7; the golden files are
// reviewed output: regenerate them only after reviewing a change to what the
// adapter writes. The key goes in the base URL's path (ADR 0033).
adapterSuite("fx", {
  protocol: "chat",
  executables: ["fx"],
  files: [".fx/settings.json"],
  locations: [],
  existing: {
    ".fx/settings.json": `{
  "theme": "dark",
  "model": "anthropic/claude-sonnet-5",
  "providers": {
    "local": {
      "protocol": "openai-chat-completions",
      "base_url": "http://localhost:11434/v1",
      "auth": { "type": "none" }
    }
  }
}
`,
  },
  golden: {
    empty: {
      ".fx/settings.json": `{
  "providers": {
    "harnesshub": {
      "protocol": "openai-chat-completions",
      "base_url": "http://127.0.0.1:3180/k/hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/v1",
      "auth": {
        "type": "none"
      },
      "tool_choice_mode": "send",
      "model_metadata": {
        "deepseek/deepseek-chat": {
          "supports_tool_use": true,
          "supports_vision": false,
          "context_window": 128000,
          "max_output_tokens": 8192
        },
        "openai/gpt-5": {
          "supports_tool_use": true,
          "supports_vision": false,
          "context_window": 400000
        }
      }
    }
  },
  "provider": "harnesshub",
  "models": {
    "harnesshub": "deepseek/deepseek-chat"
  }
}
`,
    },
    existing: {
      ".fx/settings.json": `{
  "theme": "dark",
  "model": "anthropic/claude-sonnet-5",
  "providers": {
    "local": {
      "protocol": "openai-chat-completions",
      "base_url": "http://localhost:11434/v1",
      "auth": { "type": "none" }
    },
    "harnesshub": {
      "protocol": "openai-chat-completions",
      "base_url": "http://127.0.0.1:3180/k/hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/v1",
      "auth": {
        "type": "none"
      },
      "tool_choice_mode": "send",
      "model_metadata": {
        "deepseek/deepseek-chat": {
          "supports_tool_use": true,
          "supports_vision": false,
          "context_window": 128000,
          "max_output_tokens": 8192
        },
        "openai/gpt-5": {
          "supports_tool_use": true,
          "supports_vision": false,
          "context_window": 400000
        }
      }
    }
  },
  "provider": "harnesshub",
  "models": {
    "harnesshub": "deepseek/deepseek-chat"
  }
}
`,
    },
  },
});
