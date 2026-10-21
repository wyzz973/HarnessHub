import snapshot from "../infrastructure/catalog/acp-registry.json" with { type: "json" };
import { importRegistry } from "../infrastructure/catalog/registry.js";
import { validateDefinitions } from "../contexts/catalog/domain/catalog-parser.js";
import type { HarnessDefinition } from "../contexts/catalog/domain/catalog.js";

const nativeDefinitions: readonly HarnessDefinition[] = [
  {
    id: "codex", name: "Codex", aliases: [], binaryNames: ["codex"], configHints: [".codex"],
    controls: [{ id: "codex-native", protocol: "codex-app-server", executableNames: ["codex"], args: ["app-server", "--listen", "stdio://"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "openai/codex", revision: "9b738582b13c2cdbeff54af0afd04c50c3e7ba09", upstreamId: "codex", url: "https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server/README.md" } }],
  },
  {
    id: "pi", name: "Pi", aliases: [], binaryNames: ["pi"], configHints: [".pi/agent"],
    controls: [{ id: "pi-native", protocol: "pi-rpc", executableNames: ["pi"], args: ["--mode", "rpc"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "badlogic/pi-mono", revision: "6fb2e7815167e6b19006fc526d1a5d0f5f998787", upstreamId: "pi", url: "https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/rpc.md" } }],
  },
  {
    id: "openclaw", name: "OpenClaw", aliases: [], binaryNames: ["openclaw"], configHints: [".openclaw"],
    controls: [{ id: "openclaw-native", protocol: "acp-v1", executableNames: ["openclaw"], args: ["acp"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "openclaw/acpx", revision: "b3cd84337952e0d2cadd094f564612e89d71daa5", upstreamId: "openclaw", url: "https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/src/agent-registry.ts" } }],
  },
  {
    id: "hermes", name: "Hermes Agent", aliases: [], binaryNames: ["hermes"], configHints: [".hermes"],
    // Its official installer keeps a Python environment behind ~/.local/bin/hermes; the version is read from that metadata.
    controls: [{ id: "hermes-native", protocol: "acp-v1", executableNames: ["hermes"], args: ["acp"], env: {},
      package: { kind: "python", name: "hermes-agent", version: "0.12.0", binNames: ["hermes"] }, distribution: null, requiredExecutables: [],
      source: { repository: "NousResearch/hermes-agent", revision: "a0556b861f2667a49ded048c9cfac88defff8c5f", upstreamId: "hermes-agent", url: "https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_registry/agent.json" } }],
  },
  {
    // The ACP profile is the automation surface of `dsh`; dsh initialises it from its bundled template on first use.
    id: "dsh", name: "DeepSeek Harness", aliases: [], binaryNames: ["dsh"], configHints: [".dsh"],
    // Found like other agent CLIs: `dsh` on PATH or in a standard directory (npm -g, the Desktop app's registered command,
    // the Python SDK). npx caches are not installations; a source checkout is an explicit entry in the discovery manifest.
    // The package version is the official npm `latest`, installed through 4317 on 2026-10-18
    // (docs/verification/management-actions-2026-10-18.md); the verified 0.2.1-alpha.1 was a source build (ADR-038).
    controls: [{ id: "dsh-native", protocol: "acp-v1", executableNames: ["dsh"], args: ["--profile", "acp"], env: {},
      package: { kind: "npm", name: "@deepseek-ai/dsh", version: "0.2.0-rc.2", binNames: ["dsh"] }, distribution: null, requiredExecutables: [],
      source: { repository: "deepseek-ai/deepseek-harness", revision: "5badb15009ae1756c3afe0ae0cef1faafc290ccc", upstreamId: "dsh", url: "https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/README.md" } }],
  },
];

/**
 * Each product's own documented installation on macOS (ADR-044), read from the official page the product's channels cite
 * (docs/research/official-install-channels-2026-10-17.md); shown when the product is missing. HarnessHub never runs it.
 */
const CHECKED = "2026-10-17";
const officialInstallations: Readonly<Record<string, { readonly command: string; readonly docs: string; readonly checkedAt: string; readonly note: string | null }>> = {
  claude: { command: "curl -fsSL https://claude.ai/install.sh | bash", docs: "https://code.claude.com/docs/en/setup", checkedAt: CHECKED, note: null },
  codex: { command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", docs: "https://github.com/openai/codex", checkedAt: CHECKED, note: null },
  opencode: { command: "curl -fsSL https://opencode.ai/install | bash", docs: "https://opencode.ai/docs", checkedAt: CHECKED, note: null },
  openclaw: { command: "curl -fsSL https://openclaw.ai/install.sh | bash", docs: "https://docs.openclaw.ai/install", checkedAt: CHECKED, note: null },
  gemini: { command: "npm install -g @google/gemini-cli", docs: "https://github.com/google-gemini/gemini-cli", checkedAt: CHECKED,
    note: "官方仓库写明：自 2026-06-18 起，免费用户与 Google One 用户改用 Antigravity CLI。" },
  cursor: { command: "curl https://cursor.com/install -fsS | bash", docs: "https://cursor.com/docs/cli/installation", checkedAt: CHECKED, note: null },
  pi: { command: "npm install -g @earendil-works/pi-coding-agent", docs: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", checkedAt: CHECKED, note: null },
  hermes: { command: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    docs: "https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/README.md", checkedAt: CHECKED, note: null },
  dsh: { command: "npm install -g @deepseek-ai/dsh", docs: "https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/README.md", checkedAt: CHECKED, note: null },
};
export function officialInstallation(harnessId: string): { readonly command: string; readonly docs: string; readonly checkedAt: string; readonly note: string | null } | null {
  return officialInstallations[harnessId] ?? null;
}

/** Build the offline catalog. Only reviewed product mappings combine control entries. */
export function loadBuiltinCatalog(platform: string): readonly HarnessDefinition[] {
  const definitions = [...importRegistry(snapshot, platform)];
  for (const native of nativeDefinitions) {
    const index = definitions.findIndex((definition) => definition.id === native.id);
    if (index === -1) { definitions.push(native); continue; }
    const upstream = definitions[index];
    if (upstream === undefined) throw new Error("catalog merge index is invalid");
    definitions[index] = {
      id: upstream.id, name: native.name, aliases: [...new Set([...upstream.aliases, ...native.aliases])],
      binaryNames: [...new Set([...upstream.binaryNames, ...native.binaryNames])],
      configHints: [...new Set([...upstream.configHints, ...native.configHints])], controls: [...native.controls, ...upstream.controls],
    };
  }
  validateDefinitions(definitions);
  return definitions;
}
