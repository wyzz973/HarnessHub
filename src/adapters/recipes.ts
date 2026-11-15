import type { HarnessRecipe } from "../contexts/catalog/domain/discovery.js";

/** Observed launch conventions, not proof that the installed binary supports them. */
export const builtinRecipes: readonly HarnessRecipe[] = [
  { id: "codex", name: "Codex", binary: "codex", protocol: "codex-app-server", args: ["app-server", "--listen", "stdio://"] },
  { id: "opencode", name: "OpenCode", binary: "opencode", protocol: "opencode-server", args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"] },
  { id: "claude", name: "Claude Code", binary: "claude", protocol: "claude-agent-sdk", args: [] },
  { id: "gemini", name: "Gemini CLI", binary: "gemini", protocol: "acp-v1", args: ["--acp"] },
  { id: "qwen", name: "Qwen Code", binary: "qwen", protocol: "acp-v1", args: ["--acp"] },
  { id: "pi", name: "Pi", binary: "pi", protocol: "pi-rpc", args: ["--mode", "rpc"] },
  { id: "openclaw", name: "OpenClaw", binary: "openclaw", protocol: "acp-v1", args: ["acp"] },
  { id: "cursor", name: "Cursor CLI", binary: "cursor-agent", protocol: "acp-v1", args: ["acp"] },
];
