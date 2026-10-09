import type { HarnessRecipe } from "../contexts/catalog/domain/discovery.js";

/** Observed launch conventions, not proof that the installed binary supports them. */
export const builtinRecipes: readonly HarnessRecipe[] = [
  { id: "codex", name: "Codex", binary: "codex", protocol: "codex-app-server", args: ["app-server", "--listen", "stdio://"] },
  { id: "opencode", name: "OpenCode", binary: "opencode", protocol: "acp-v1", args: ["acp"] },
  { id: "claude", name: "Claude Code", binary: "claude", protocol: "acp-v1", adapterBinary: "claude-agent-acp", nativeRequired: false, args: [] },
  { id: "gemini", name: "Gemini CLI", binary: "gemini", protocol: "acp-v1", args: ["--acp"] },
  { id: "qwen", name: "Qwen Code", binary: "qwen", protocol: "acp-v1", args: ["--acp"] },
  { id: "pi", name: "Pi", binary: "pi", protocol: "pi-rpc", args: ["--mode", "rpc"] },
  { id: "openclaw", name: "OpenClaw", binary: "openclaw", protocol: "acp-v1", args: ["acp"] },
  { id: "cursor", name: "Cursor CLI", binary: "cursor-agent", protocol: "acp-v1", args: ["acp"] },
];
