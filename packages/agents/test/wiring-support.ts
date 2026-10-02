// SPDX-License-Identifier: MIT
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { GatewayKeyId } from "@harnesshub/core/model-plane";
import type { WiringContext, WiringTarget } from "../src/wiring/index.js";

/** A synthetic agent key; it never reaches a network. */
export function syntheticKey(
  id: string,
  fill = "S",
): { keyText: string; keyId: GatewayKeyId } {
  return {
    keyText: `hhk_a_${id}_${fill.repeat(43)}`,
    keyId: id as GatewayKeyId,
  };
}

export const KEY = syntheticKey("abcdefghijkl");
export const NEW_KEY = syntheticKey("mnopqrstuvwx", "N");

export const TARGET: WiringTarget = {
  baseUrl: "http://127.0.0.1:3180",
  ...KEY,
  model: "deepseek/deepseek-chat",
  models: [
    {
      ref: "deepseek/deepseek-chat",
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    { ref: "openai/gpt-5", contextWindow: 400000 },
  ],
};

/** A private home and data directory, removed after the test. */
export async function sandbox(
  t: TestContext,
): Promise<WiringContext & { root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "hh-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  return {
    root,
    home,
    dataDir: path.join(root, "data"),
    clock: () => new Date("2026-10-02T08:00:00.000Z"),
  };
}

/** Writes files given relative to `home`, creating their directories. */
export async function writeFiles(
  home: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(home, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** Every regular file under `directory`, relative and sorted, with its text. */
export async function snapshot(
  directory: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw error;
  }
  for (const entry of entries)
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      result[path.relative(directory, file)] = await readFile(file, "utf8");
    }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Every directory under `directory`, relative and sorted. */
export async function directories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)),
    )
    .sort();
}

/** Existing user configuration per adapter: comments, unrelated keys and a value wiring replaces. */
export const EXISTING: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  claude: {
    ".claude/settings.json": `{
  // Personal settings
  "theme": "dark",
  "env": {
    "MY_TOOL_HOME": "/opt/tool",
    "ANTHROPIC_MODEL": "claude-opus-4-5"
  },
  "permissions": {
    "allow": ["Bash(ls:*)"]
  }
}
`,
  },
  codex: {
    ".codex/config.toml": `# Codex settings
model = "o3" # my default
approval_policy = "on-request"

[projects."/Users/me/work"]
trust_level = "trusted"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"] # pinned
`,
  },
  gemini: {
    ".gemini/settings.json": `{
  // Gemini CLI settings
  "ui": { "theme": "GitHub" },
  "security": {
    "folderTrust": { "enabled": true }
  }
}
`,
    ".gemini/.env": `# Keys for Gemini
OTHER_TOKEN=abc123 # mine
export GEMINI_API_KEY=user-google-api-key
`,
  },
  qwen: {
    ".qwen/settings.json": `{
    "ui": {"theme": "Qwen Dark"},
    "model": {"name": "qwen3-coder-plus"}
}
`,
    ".qwen/.env": `# Qwen
DASHSCOPE_REGION=intl
`,
  },
  opencode: {
    ".config/opencode/opencode.jsonc": `{
  "$schema": "https://opencode.ai/config.json",
  // My theme
  "theme": "tokyonight",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:11434/v1" },
    },
  },
}
`,
  },
  pi: {
    ".pi/agent/settings.json": `{
\t"theme": "dark",
\t"defaultProvider": "anthropic"
}
`,
    ".pi/agent/models.json": `{
  // Local models
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions" }
  }
}
`,
  },
  crush: {
    ".config/crush/crush.json": `{
  "$schema": "https://charm.land/crush.json",
  "options": { "debug": false }
}
`,
  },
  kimi: {
    ".kimi/config.toml": `default_model = "kimi-k2" # mine

[providers.moonshot]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "user-moonshot-key"

[models.kimi-k2]
provider = "moonshot"
model = "kimi-k2"
max_context_size = 131072
`,
  },
};
