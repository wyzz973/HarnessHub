import snapshot from "../infrastructure/catalog/acp-registry.json" with { type: "json" };
import { importRegistry } from "../infrastructure/catalog/registry.js";
import { validateDefinitions } from "../contexts/catalog/domain/catalog-parser.js";
import type { HarnessDefinition } from "../contexts/catalog/domain/catalog.js";
import type { HarnessTier } from "../contracts/web.js";

export type { HarnessTier };
/** The seven Harnesses HarnessHub supports in full (ADR-048); WorkBuddy has no catalog definition yet and counts already. */
const FOCUS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "dsh", "hermes", "openclaw", "workbuddy"]);
/** Frozen by ADR-046 item 6 and hidden by default by ADR-048 decision 1: adapters, tests and history stay, new work does not come. */
const FROZEN: ReadonlySet<string> = new Set(["cursor", "gemini", "pi"]);
/**
 * A Harness's tier by its catalog identity (ADR-048, ADR-050): `focus` for the seven above, `frozen` for Cursor, Gemini CLI
 * and Pi, and `catalog` for anything else, including identities the catalog does not know. Pure. The capability matrix
 * (`plan/native-capabilities.json`) records a tier for each of its Harnesses as well, and the two must agree.
 */
export function harnessTier(id: string): HarnessTier {
  return FOCUS.has(id) ? "focus" : FROZEN.has(id) ? "frozen" : "catalog";
}

/**
 * Claude Code's control: the user's own `claude`, driven by the Claude Agent SDK (2026-11-15; no adapter in between). It keeps the id of the
 * ACP adapter's control it replaces, so that conversations bound to it go on (their native sessions are the same Claude Code sessions); the
 * adapter's control is gone from the catalog.
 */
export const CLAUDE_CONTROL_ID = "claude-acp-npm";
const nativeDefinitions: readonly HarnessDefinition[] = [
  {
    id: "claude", name: "Claude Code", aliases: [], binaryNames: ["claude"], configHints: [".claude"],
    controls: [{ id: CLAUDE_CONTROL_ID, protocol: "claude-agent-sdk", executableNames: ["claude"], args: [], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "anthropics/claude-agent-sdk-typescript", revision: "v0.3.325", upstreamId: "claude", url: "https://code.claude.com/docs/en/agent-sdk/typescript" } }],
  },
  {
    id: "codex", name: "Codex", aliases: [], binaryNames: ["codex"], configHints: [".codex"],
    controls: [{ id: "codex-native", protocol: "codex-app-server", executableNames: ["codex"], args: ["app-server", "--listen", "stdio://"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "openai/codex", revision: "9b738582b13c2cdbeff54af0afd04c50c3e7ba09", upstreamId: "codex", url: "https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server/README.md" } }],
  },
  {
    // OpenCode 2's own server (`opencode serve --stdio`, HTTP and events), the Hub's private one per connection. The control keeps the id the ACP registry's
    // entry had, so that a conversation begun over ACP goes on with this driver (its native session ids are OpenCode's own either way).
    id: "opencode", name: "OpenCode", aliases: [], binaryNames: ["opencode"], configHints: [".config/opencode"],
    controls: [{ id: "opencode-binary", protocol: "opencode-server", executableNames: ["opencode"], args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "anomalyco/opencode", revision: "v2.3.0", upstreamId: "opencode", url: "https://opencode.ai/docs/server/" } }],
  },
  {
    id: "pi", name: "Pi", aliases: [], binaryNames: ["pi"], configHints: [".pi/agent"],
    controls: [{ id: "pi-native", protocol: "pi-rpc", executableNames: ["pi"], args: ["--mode", "rpc"], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "badlogic/pi-mono", revision: "6fb2e7815167e6b19006fc526d1a5d0f5f998787", upstreamId: "pi", url: "https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/rpc.md" } }],
  },
  {
    id: "openclaw", name: "OpenClaw", aliases: [], binaryNames: ["openclaw"], configHints: [".openclaw"],
    controls: [{ id: "openclaw-native", protocol: "openclaw-gateway", executableNames: ["openclaw"], args: [], env: {}, package: null, distribution: null, requiredExecutables: [],
      source: { repository: "openclaw/openclaw", revision: "v2026.11.3", upstreamId: "openclaw", url: "https://docs.openclaw.ai/gateway/external-apps" } }],
  },
  {
    id: "hermes", name: "Hermes Agent", aliases: [], binaryNames: ["hermes"], configHints: [".hermes"],
    // Its official installer keeps a checkout behind ~/.local/bin/hermes; discovery reads the version its install stamp
    // names (installation-channels.ts), not this package. The control is the user's running gateway (`hermes-gateway-v1`,
    // adapters/control/hermes/): nothing is started, the executable only places the installation. The source is v0.23.1's
    // developer guide of programmatic integration.
    controls: [{ id: "hermes-native", protocol: "hermes-gateway", executableNames: ["hermes"], args: [], env: {},
      package: { kind: "python", name: "hermes-agent", version: "latest", binNames: ["hermes"] }, distribution: null, requiredExecutables: [],
      source: { repository: "NousResearch/hermes-agent", revision: "3b421578588243f920886e6fe79a6faa87ea026e", upstreamId: "hermes-agent", url: "https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/website/docs/developer-guide/programmatic-integration.md" } }],
  },
  {
    // The ACP profile is the automation surface of `dsh`; dsh initialises it from its bundled template on first use.
    id: "dsh", name: "DeepSeek Harness", aliases: [], binaryNames: ["dsh"], configHints: [".dsh"],
    // Found like other agent CLIs: `dsh` on PATH or in a standard directory (npm -g, the Desktop app's registered command,
    // the Python SDK). npx caches are not installations; a source checkout is an explicit entry in the discovery manifest.
    // The package version follows the official npm channel's latest: the versions really verified are evidence only, in
    // docs/verification and the matrix's installation (ADR-053). The source is the dsh-v0.2.2-rc.1 tag's commit (npm latest on 2026-11-15).
    controls: [{ id: "dsh-native", protocol: "acp-v1", executableNames: ["dsh"], args: ["--profile", "acp"], env: {},
      package: { kind: "npm", name: "@deepseek-ai/dsh", version: "latest", binNames: ["dsh"] }, distribution: null, requiredExecutables: [],
      source: { repository: "deepseek-ai/deepseek-harness", revision: "66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db", upstreamId: "dsh", url: "https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/acp/acp/README.md" } }],
  },
];

/**
 * Each product's own documented installation on macOS (ADR-044), read from the official page the product's channels cite
 * (docs/research/official-install-channels-2026-10-17.md); shown when the product is missing. HarnessHub never runs it.
 * Hermes's was read again on 2026-10-22 from its v0.22.4 README and installation page (commit 4d04303); DeepSeek
 * Harness's link moved to the dsh-v0.2.1-rc.2 tag the same day (to dsh-v0.2.2-rc.1 on 2026-11-15), but that README gives only `npx @deepseek-ai/dsh web`,
 * so its command stays as read on 2026-10-17.
 */
const CHECKED = "2026-10-17";
const officialInstallations: Readonly<Record<string, { readonly command: string; readonly docs: string; readonly checkedAt: string; readonly note: string | null }>> = {
  claude: { command: "curl -fsSL https://claude.ai/install.sh | bash", docs: "https://code.claude.com/docs/en/setup", checkedAt: CHECKED, note: null },
  codex: { command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", docs: "https://github.com/openai/codex", checkedAt: CHECKED, note: null },
  // OpenCode 2's command (https://opencode.ai/v2/docs/, read 2026-11-01); the V1 line installs with https://opencode.ai/install.
  opencode: { command: "curl -fsSL https://opencode.ai/v2/install | bash", docs: "https://opencode.ai/v2/docs/", checkedAt: "2026-11-01",
    note: "装的是 OpenCode 2。OpenCode 1 与 2 共用 opencode 命令、不能并存：按迁移指南先卸载 Homebrew 或 npm 装的 OpenCode 1，再安装。" },
  openclaw: { command: "curl -fsSL https://openclaw.ai/install.sh | bash", docs: "https://docs.openclaw.ai/install", checkedAt: CHECKED, note: null },
  gemini: { command: "npm install -g @google/gemini-cli", docs: "https://github.com/google-gemini/gemini-cli", checkedAt: CHECKED,
    note: "官方仓库写明：自 2026-06-18 起，免费用户与 Google One 用户改用 Antigravity CLI。" },
  cursor: { command: "curl https://cursor.com/install -fsS | bash", docs: "https://cursor.com/docs/cli/installation", checkedAt: CHECKED, note: null },
  pi: { command: "npm install -g @earendil-works/pi-coding-agent", docs: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", checkedAt: CHECKED, note: null },
  hermes: { command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    docs: "https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/README.md", checkedAt: "2026-10-22", note: null },
  dsh: { command: "npm install -g @deepseek-ai/dsh", docs: "https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/README.md", checkedAt: CHECKED, note: null },
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
    // The programs only a replaced control ran (Claude Code's ACP adapter) are not the product's any more: an installation of one is nobody's.
    const retired = new Set(upstream.controls.filter(control => native.controls.some(own => own.id === control.id)).flatMap(control => control.executableNames).filter(name => !native.binaryNames.includes(name)));
    definitions[index] = {
      id: upstream.id, name: native.name, aliases: [...new Set([...upstream.aliases, ...native.aliases])],
      binaryNames: [...new Set([...upstream.binaryNames.filter(name => !retired.has(name)), ...native.binaryNames])],
      // A native control replaces the registry's control of the same id (Claude Code's SDK control takes the ACP adapter's place).
      configHints: [...new Set([...upstream.configHints, ...native.configHints])], controls: [...native.controls, ...upstream.controls.filter(control => !native.controls.some(own => own.id === control.id))],
    };
  }
  validateDefinitions(definitions);
  return definitions;
}
