/**
 * Reviewed local launch recipes, consumed only by discovery. Adding a recipe
 * does not register an engine or prove its installed version/authentication.
 * Protocol sources and validation coverage live in docs/engine-discovery.md.
 */
export interface BuiltinEngine {
  id: string;
  name: string;
  binary: string;
  homeBins?: readonly string[];
  launch:
    | { kind: "managed-acp" }
    | { kind: "pi-acp" }
    | { kind: "acp"; args: readonly string[] }
    | { kind: "cli"; args: readonly string[] };
  notes?: readonly string[];
}

/** Finite, explicit identities: arbitrary executables are never guessed to be agents. */
export const builtinEngines: readonly BuiltinEngine[] = [
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    launch: { kind: "managed-acp" },
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    homeBins: [".claude/local"],
    launch: { kind: "managed-acp" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    homeBins: [".opencode/bin"],
    launch: { kind: "managed-acp" },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    binary: "openclaw",
    launch: { kind: "managed-acp" },
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    binary: "hermes",
    homeBins: [".hermes/hermes-agent/venv/bin"],
    launch: { kind: "acp", args: ["acp"] },
    notes: [
      "Requires a Hermes version with ACP support and its optional agent-client-protocol dependency; discovery does not import Python packages.",
    ],
  },
  {
    id: "mimo",
    name: "MiMo Code",
    binary: "mimo",
    homeBins: [".mimocode/bin"],
    launch: { kind: "acp", args: ["acp"] },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    binary: "gemini",
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    binary: "cursor-agent",
    launch: { kind: "cli", args: ["--print", "--output-format", "text"] },
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    binary: "copilot",
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "kimi",
    name: "Kimi Code",
    binary: "kimi",
    launch: { kind: "acp", args: ["acp"] },
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binary: "qwen",
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    binary: "kiro-cli",
    launch: { kind: "acp", args: ["acp"] },
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    binary: "qodercli",
    homeBins: [".qoder/bin"],
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    binary: "agy",
    launch: { kind: "cli", args: ["-p", "{prompt}"] },
  },
  { id: "pi", name: "Pi", binary: "pi", launch: { kind: "pi-acp" } },
];
