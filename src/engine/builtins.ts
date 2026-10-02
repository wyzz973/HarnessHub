import type { ConfigurationAdapter } from "../domain/engine-configuration.js";

/**
 * Reviewed local launch recipes, consumed by discovery and by adapter inference for
 * registrations that omit `configuration`. Adding a recipe does not register an engine
 * or prove its installed version/authentication. Protocol sources and validation
 * coverage live in docs/engine-discovery.md.
 */
export interface BuiltinEngine {
  id: string;
  name: string;
  binary: string;
  /** Configuration adapter matching this recipe's native launch contract. */
  adapter: ConfigurationAdapter;
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
    adapter: "codex",
    launch: { kind: "managed-acp" },
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    adapter: "claude",
    homeBins: [".claude/local"],
    launch: { kind: "managed-acp" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    adapter: "opencode",
    homeBins: [".opencode/bin"],
    launch: { kind: "managed-acp" },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    binary: "openclaw",
    adapter: "openclaw",
    launch: { kind: "managed-acp" },
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    binary: "hermes",
    adapter: "hermes",
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
    adapter: "mimo",
    homeBins: [".mimocode/bin"],
    launch: { kind: "acp", args: ["acp"] },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    binary: "gemini",
    adapter: "gemini",
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    binary: "cursor-agent",
    adapter: "cursor",
    launch: { kind: "cli", args: ["--print", "--output-format", "text"] },
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    binary: "copilot",
    adapter: "copilot",
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "kimi",
    name: "Kimi Code",
    binary: "kimi",
    adapter: "kimi",
    launch: { kind: "acp", args: ["acp"] },
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binary: "qwen",
    adapter: "qwen",
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    binary: "kiro-cli",
    adapter: "kiro",
    launch: { kind: "acp", args: ["acp"] },
  },
  {
    id: "qoder",
    name: "Qoder CLI",
    binary: "qodercli",
    adapter: "qoder",
    homeBins: [".qoder/bin"],
    launch: { kind: "acp", args: ["--acp"] },
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    binary: "agy",
    adapter: "antigravity",
    launch: { kind: "cli", args: ["-p", "{prompt}"] },
  },
  {
    id: "pi",
    name: "Pi",
    binary: "pi",
    adapter: "pi",
    launch: { kind: "pi-acp" },
  },
];

/**
 * Adapter implied by a reviewed recipe id, including DSH's dedicated discovery recipe.
 * Used only when a registration omits `configuration.adapter`; unknown ids return
 * undefined so arbitrary registrations are never guessed to be a known engine.
 */
export function builtinConfigurationAdapter(
  engineId: string,
): ConfigurationAdapter | undefined {
  if (engineId === "dsh") return "dsh";
  return builtinEngines.find((engine) => engine.id === engineId)?.adapter;
}
