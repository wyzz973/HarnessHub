// SPDX-License-Identifier: MIT
/**
 * Reviewed results of wiring TARGET (wiring-support.ts) into an empty home
 * and into the EXISTING configuration of each adapter, by path relative to
 * the home. The key is synthetic. Regenerate only after reviewing a change
 * to what an adapter writes.
 */
export const GOLDEN: Readonly<
  Record<
    string,
    { empty: Record<string, string>; existing: Record<string, string> }
  >
> = {
  claude: {
    empty: {
      ".claude/settings.json": `{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3180",
    "ANTHROPIC_AUTH_TOKEN": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
    "ANTHROPIC_MODEL": "deepseek/deepseek-chat",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek/deepseek-chat",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek/deepseek-chat",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-chat",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "128000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192"
  }
}
`,
    },
    existing: {
      ".claude/settings.json": `{
  // Personal settings
  "theme": "dark",
  "env": {
    "MY_TOOL_HOME": "/opt/tool",
    "ANTHROPIC_MODEL": "deepseek/deepseek-chat",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3180",
    "ANTHROPIC_AUTH_TOKEN": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek/deepseek-chat",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek/deepseek-chat",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-chat",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "128000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192"
  },
  "permissions": {
    "allow": ["Bash(ls:*)"]
  }
}
`,
    },
  },
  codex: {
    empty: {
      ".codex/config.toml": `model_provider = "harnesshub"
model = "deepseek/deepseek-chat"
model_context_window = 128000

[model_providers.harnesshub]
name = "HarnessHub"
base_url = "http://127.0.0.1:3180/v1"
wire_api = "responses"
experimental_bearer_token = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
`,
    },
    existing: {
      ".codex/config.toml": `# Codex settings
model = "deepseek/deepseek-chat" # my default
approval_policy = "on-request"
model_provider = "harnesshub"
model_context_window = 128000

[projects."/Users/me/work"]
trust_level = "trusted"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"] # pinned

[model_providers.harnesshub]
name = "HarnessHub"
base_url = "http://127.0.0.1:3180/v1"
wire_api = "responses"
experimental_bearer_token = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
`,
    },
  },
  gemini: {
    empty: {
      ".gemini/.env": `GEMINI_API_KEY=hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3180
`,
      ".gemini/settings.json": `{
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  },
  "model": {
    "name": "deepseek/deepseek-chat"
  }
}
`,
    },
    existing: {
      ".gemini/.env": `# Keys for Gemini
OTHER_TOKEN=abc123 # mine
export GEMINI_API_KEY=hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3180
`,
      ".gemini/settings.json": `{
  // Gemini CLI settings
  "ui": { "theme": "GitHub" },
  "security": {
    "folderTrust": { "enabled": true },
    "auth": {
      "selectedType": "gemini-api-key"
    }
  },
  "model": {
    "name": "deepseek/deepseek-chat"
  }
}
`,
    },
  },
  qwen: {
    empty: {
      ".qwen/.env": `OPENAI_BASE_URL=http://127.0.0.1:3180/v1
OPENAI_API_KEY=hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
OPENAI_MODEL=deepseek/deepseek-chat
`,
      ".qwen/settings.json": `{
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "deepseek/deepseek-chat",
    "generationConfig": {
      "contextWindowSize": 128000,
      "samplingParams": {
        "max_tokens": 8192
      }
    }
  }
}
`,
    },
    existing: {
      ".qwen/.env": `# Qwen
DASHSCOPE_REGION=intl
OPENAI_BASE_URL=http://127.0.0.1:3180/v1
OPENAI_API_KEY=hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS
OPENAI_MODEL=deepseek/deepseek-chat
`,
      ".qwen/settings.json": `{
    "ui": {"theme": "Qwen Dark"},
    "model": {"name": "deepseek/deepseek-chat", "generationConfig": { "contextWindowSize": 128000, "samplingParams": { "max_tokens": 8192 } }},
    "security": {
        "auth": {
            "selectedType": "openai"
        }
    }
}
`,
    },
  },
  opencode: {
    empty: {
      ".config/opencode/opencode.json": `{
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
          }
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5"
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
      ".config/opencode/opencode.jsonc": `{
  "$schema": "https://opencode.ai/config.json",
  // My theme
  "theme": "tokyonight",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:11434/v1" },
    },
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
          }
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5"
        }
      }
    },
  },
  "model": "harnesshub/deepseek/deepseek-chat",
  "small_model": "harnesshub/deepseek/deepseek-chat",
}
`,
    },
  },
  pi: {
    empty: {
      ".pi/agent/models.json": `{
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
      ".pi/agent/settings.json": `{
  "defaultProvider": "harnesshub",
  "defaultModel": "deepseek/deepseek-chat"
}
`,
    },
    existing: {
      ".pi/agent/models.json": `{
  // Local models
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
      ".pi/agent/settings.json": `{
\t"theme": "dark",
\t"defaultProvider": "harnesshub",
\t"defaultModel": "deepseek/deepseek-chat"
}
`,
    },
  },
  crush: {
    empty: {
      ".config/crush/crush.json": `{
  "providers": {
    "harnesshub": {
      "name": "HarnessHub",
      "type": "openai-compat",
      "base_url": "http://127.0.0.1:3180/v1",
      "api_key": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "models": [
        {
          "id": "deepseek/deepseek-chat",
          "name": "deepseek/deepseek-chat",
          "context_window": 128000,
          "default_max_tokens": 8192
        },
        {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "context_window": 400000
        }
      ]
    }
  },
  "models": {
    "large": {
      "model": "deepseek/deepseek-chat",
      "provider": "harnesshub"
    },
    "small": {
      "model": "deepseek/deepseek-chat",
      "provider": "harnesshub"
    }
  }
}
`,
    },
    existing: {
      ".config/crush/crush.json": `{
  "$schema": "https://charm.land/crush.json",
  "options": { "debug": false },
  "providers": {
    "harnesshub": {
      "name": "HarnessHub",
      "type": "openai-compat",
      "base_url": "http://127.0.0.1:3180/v1",
      "api_key": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
      "models": [
        {
          "id": "deepseek/deepseek-chat",
          "name": "deepseek/deepseek-chat",
          "context_window": 128000,
          "default_max_tokens": 8192
        },
        {
          "id": "openai/gpt-5",
          "name": "openai/gpt-5",
          "context_window": 400000
        }
      ]
    }
  },
  "models": {
    "large": {
      "model": "deepseek/deepseek-chat",
      "provider": "harnesshub"
    },
    "small": {
      "model": "deepseek/deepseek-chat",
      "provider": "harnesshub"
    }
  }
}
`,
    },
  },
  kimi: {
    empty: {
      ".kimi/config.toml": `default_model = "deepseek/deepseek-chat"

[providers.harnesshub]
type = "openai_legacy"
base_url = "http://127.0.0.1:3180/v1"
api_key = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"

[models."deepseek/deepseek-chat"]
provider = "harnesshub"
model = "deepseek/deepseek-chat"
max_context_size = 128000

[models."openai/gpt-5"]
provider = "harnesshub"
model = "openai/gpt-5"
max_context_size = 400000
`,
    },
    existing: {
      ".kimi/config.toml": `default_model = "deepseek/deepseek-chat" # mine

[providers.moonshot]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "user-moonshot-key"

[models.kimi-k2]
provider = "moonshot"
model = "kimi-k2"
max_context_size = 131072

[providers.harnesshub]
type = "openai_legacy"
base_url = "http://127.0.0.1:3180/v1"
api_key = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"

[models."deepseek/deepseek-chat"]
provider = "harnesshub"
model = "deepseek/deepseek-chat"
max_context_size = 128000

[models."openai/gpt-5"]
provider = "harnesshub"
model = "openai/gpt-5"
max_context_size = 400000
`,
    },
  },
};
