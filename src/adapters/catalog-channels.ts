import type { ChannelRegistry, ControlRecipe } from "../contexts/catalog/domain/catalog.js";
import type { OfficialChannels, ProductMaintenance } from "../contexts/catalog/domain/channels.js";

const CHECKED = "2026-10-17";
const none = { npm: [], brewFormulae: [], brewCasks: [], scripts: [], uv: [] } as const;
/**
 * Each product's official macOS installation channels (ADR-044), read from its own documentation on the date given; see
 * docs/research/official-install-channels-2026-10-17.md. A product absent here counts its control packages only.
 */
const products: Readonly<Record<string, OfficialChannels>> = {
  claude: { ...none, npm: ["@anthropic-ai/claude-code"], brewCasks: ["claude-code", "claude-code@latest"],
    // The setup page's "Uninstall a native installation": rm -f ~/.local/bin/claude; rm -rf ~/.local/share/claude.
    scripts: [{ root: ".local/share/claude/versions", launchers: [], program: null,
      removal: { links: [".local/bin/claude"], launchers: [], files: [], directories: [".local/share/claude"], emptyDirectories: [], documented: true } }],
    source: { url: "https://code.claude.com/docs/en/setup", checkedAt: CHECKED } },
  codex: { ...none, npm: ["@openai/codex"], brewCasks: ["codex"],
    // The installer links codex and codex-code-mode-host into ~/.local/bin and keeps releases under ~/.codex/packages/standalone; it has no uninstall mode.
    scripts: [{ root: ".codex/packages/standalone", launchers: [], program: null,
      removal: { links: [".local/bin/codex", ".local/bin/codex-code-mode-host"], launchers: [], files: [], directories: [".codex/packages/standalone"], emptyDirectories: [], documented: false } }],
    source: { url: "https://github.com/openai/codex", checkedAt: CHECKED } },
  opencode: { ...none, npm: ["opencode-ai"], brewFormulae: ["opencode"],
    // The installer writes only ~/.opencode/bin/opencode (and, without --no-modify-path, a PATH line HarnessHub never edits).
    scripts: [{ root: ".opencode/bin", launchers: [], program: null,
      removal: { links: [], launchers: [], files: [".opencode/bin/opencode"], directories: [], emptyDirectories: [".opencode/bin"], documented: false } }],
    source: { url: "https://opencode.ai/docs", checkedAt: CHECKED } },
  openclaw: { ...none, npm: ["openclaw"], source: { url: "https://docs.openclaw.ai/install", checkedAt: CHECKED } },
  gemini: { ...none, npm: ["@google/gemini-cli"], brewFormulae: ["gemini-cli"], source: { url: "https://github.com/google-gemini/gemini-cli", checkedAt: CHECKED } },
  // Cursor's page gives no uninstall; the installer writes versions under ~/.local/share/cursor-agent and links agent and cursor-agent.
  cursor: { ...none, scripts: [{ root: ".local/share/cursor-agent/versions", launchers: [], program: null,
    removal: { links: [".local/bin/agent", ".local/bin/cursor-agent"], launchers: [], files: [], directories: [".local/share/cursor-agent"], emptyDirectories: [], documented: false } }],
    source: { url: "https://cursor.com/docs/cli/installation", checkedAt: CHECKED } },
  pi: { ...none, npm: ["@earendil-works/pi-coding-agent"], source: { url: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", checkedAt: CHECKED } },
  // Hermes's "Manual Uninstall": rm -f ~/.local/bin/hermes; rm -rf the hermes-agent checkout; ~/.hermes otherwise stays.
  hermes: { ...none, scripts: [{ root: ".hermes/hermes-agent", launchers: [".local/bin/hermes"], program: "venv/bin/hermes",
    removal: { links: [], launchers: [".local/bin/hermes"], files: [], directories: [".hermes/hermes-agent"], emptyDirectories: [], documented: true } }],
    source: { url: "https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/README.md", checkedAt: CHECKED } },
  dsh: { ...none, npm: ["@deepseek-ai/dsh"], source: { url: "https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/README.md", checkedAt: CHECKED } },
};
/**
 * Services each product's installation registers and where it keeps its data (ADR-044). OpenClaw's uninstall page stops
 * and unregisters its gateway with its own commands; its node host has the same pair (docs/cli/node.md). Hermes documents
 * `hermes gateway stop` before removal, and `hermes gateway uninstall` unregisters the launchd job.
 */
const maintenance: Readonly<Record<string, ProductMaintenance>> = {
  claude: { services: [], data: [".claude", ".claude.json"], resident: [] },
  codex: { services: [], data: [".codex"], resident: [] },
  opencode: { services: [], data: [".config/opencode", ".local/share/opencode"], resident: [] },
  openclaw: { services: [
    { label: "ai.openclaw.gateway", name: "OpenClaw Gateway", stop: [["gateway", "stop"], ["gateway", "uninstall"]], interrupts: "Gateway 连接的消息渠道（例如微信、飞书）会断开，重新安装并运行 openclaw onboard --install-daemon 后才恢复。" },
    { label: "ai.openclaw.node", name: "OpenClaw Node", stop: [["node", "stop"], ["node", "uninstall"]], interrupts: "这台电脑上的 OpenClaw 节点会停止，重新安装并运行 openclaw node install 后才恢复。" }],
    data: [".openclaw"],
    // OpenClaw's gateway and node host rename their process title (ADR-043's recipe names them the same way).
    resident: [{ command: /^openclaw-gateway(?:\s|$)/u, stop: "openclaw gateway stop" }, { command: /^openclaw-node(?:\s|$)/u, stop: "openclaw node stop" }] },
  gemini: { services: [], data: [".gemini"], resident: [] },
  cursor: { services: [], data: [".cursor"], resident: [] },
  pi: { services: [], data: [".pi"], resident: [] },
  hermes: { services: [{ label: "ai.hermes.gateway", name: "Hermes Gateway", stop: [["gateway", "stop"], ["gateway", "uninstall"]], interrupts: "Gateway 连接的消息渠道（例如 QQ）会断开，重新安装并运行 hermes gateway install 后才恢复。" }],
    data: [".hermes"],
    // Its gateway runs as `python -m hermes_cli.main gateway` under launchd, or `hermes gateway run` in a terminal.
    resident: [{ command: /(?:^|\/)hermes(?:\s+--?[A-Za-z][\w-]*)*\s+gateway(?:\s|$)|hermes_cli\.main\s+gateway(?:\s|$)/u, stop: "hermes gateway stop" }] },
  dsh: { services: [], data: [".dsh"], resident: [] },
};
/** The official channels of a product, or null when they are not recorded. */
export function productChannels(harnessId: string): OfficialChannels | null { return products[harnessId] ?? null; }
/**
 * The official channels of an adapter control in front of the product: the npm or Python package or the archive its
 * registry entry publishes. Returns null for a control that publishes none.
 */
export function adapterChannels(harnessId: string, control: ControlRecipe): OfficialChannels | null {
  if (control.package === null && control.distribution === null) return null;
  return { ...none, source: { url: control.source.url, checkedAt: CHECKED },
    npm: control.package?.kind === "npm" ? [control.package.name] : [], uv: control.package?.kind === "python" ? [control.package.name] : [],
    // A registry archive is installed under ~/.local/share/harnesses/<id> (ADR-017).
    scripts: control.distribution?.kind === "binary" ? [{ root: ".local/share/harnesses/" + harnessId, launchers: [], program: null, removal: null }] : [] };
}
/** A product's services and data (ADR-044); a product without a record registers no service and its data is not named. */
export function productMaintenance(harnessId: string): ProductMaintenance { return maintenance[harnessId] ?? { services: [], data: [], resident: [] }; }
/** The registry of recorded channels the inventory classifies found programs with. */
export const channelRegistry: ChannelRegistry = { product: productChannels, adapter: adapterChannels };
