import type { ChannelRegistry, ControlRecipe } from "../contexts/catalog/domain/catalog.js";
import type { OfficialChannels, OfficialInstallMethod, ProductMaintenance } from "../contexts/catalog/domain/channels.js";

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
      removal: { links: [".local/bin/claude"], launchers: [], files: [], directories: [".local/share/claude"], emptyDirectories: [], documented: true },
      upgrade: { kind: "self-update", args: ["update"], command: "claude update" } }],
    source: { url: "https://code.claude.com/docs/en/setup", checkedAt: CHECKED } },
  codex: { ...none, npm: ["@openai/codex"], brewCasks: ["codex"],
    // The installer links codex and codex-code-mode-host into ~/.local/bin and keeps releases under ~/.codex/packages/standalone; it has no uninstall mode.
    scripts: [{ root: ".codex/packages/standalone", launchers: [], program: null,
      removal: { links: [".local/bin/codex", ".local/bin/codex-code-mode-host"], launchers: [], files: [], directories: [".codex/packages/standalone"], emptyDirectories: [], documented: false },
      upgrade: { kind: "rerun" } }],
    source: { url: "https://github.com/openai/codex", checkedAt: CHECKED } },
  opencode: { ...none, npm: ["opencode-ai"], brewFormulae: ["opencode"],
    // The installer writes only ~/.opencode/bin/opencode (and, without --no-modify-path, a PATH line HarnessHub never edits).
    scripts: [{ root: ".opencode/bin", launchers: [], program: null,
      removal: { links: [], launchers: [], files: [".opencode/bin/opencode"], directories: [], emptyDirectories: [".opencode/bin"], documented: false },
      upgrade: { kind: "rerun" } }],
    source: { url: "https://opencode.ai/docs", checkedAt: CHECKED } },
  openclaw: { ...none, npm: ["openclaw"], source: { url: "https://docs.openclaw.ai/install", checkedAt: CHECKED } },
  gemini: { ...none, npm: ["@google/gemini-cli"], brewFormulae: ["gemini-cli"], source: { url: "https://github.com/google-gemini/gemini-cli", checkedAt: CHECKED } },
  // Cursor's page gives no uninstall; the installer writes versions under ~/.local/share/cursor-agent and links agent and cursor-agent.
  cursor: { ...none, scripts: [{ root: ".local/share/cursor-agent/versions", launchers: [], program: null,
    removal: { links: [".local/bin/agent", ".local/bin/cursor-agent"], launchers: [], files: [], directories: [".local/share/cursor-agent"], emptyDirectories: [], documented: false },
    upgrade: { kind: "self-update", args: ["update"], command: "agent update" } }],
    source: { url: "https://cursor.com/docs/cli/installation", checkedAt: CHECKED } },
  pi: { ...none, npm: ["@earendil-works/pi-coding-agent"], source: { url: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", checkedAt: CHECKED } },
  // Hermes's "Manual Uninstall": rm -f ~/.local/bin/hermes; rm -rf the hermes-agent checkout; ~/.hermes otherwise stays.
  hermes: { ...none, scripts: [{ root: ".hermes/hermes-agent", launchers: [".local/bin/hermes"], program: "venv/bin/hermes",
    removal: { links: [], launchers: [".local/bin/hermes"], files: [], directories: [".hermes/hermes-agent"], emptyDirectories: [], documented: true },
    upgrade: { kind: "terminal", command: "hermes update --yes",
      explains: "它会把 ~/.hermes/hermes-agent 里的本地改动先 git stash，再 git pull 或 git reset 到最新、重装依赖、迁移 ~/.hermes/config.yaml，并重启网关（QQ 等消息渠道会断开片刻）。HarnessHub 不代为运行，请在终端运行。" } }],
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
    scripts: control.distribution?.kind === "binary" ? [{ root: ".local/share/harnesses/" + harnessId, launchers: [], program: null, removal: null, upgrade: null }] : [] };
}
/** A product's services and data (ADR-044); a product without a record registers no service and its data is not named. */
export function productMaintenance(harnessId: string): ProductMaintenance { return maintenance[harnessId] ?? { services: [], data: [], resident: [] }; }
/** The registry of recorded channels the inventory classifies found programs with. */
export const channelRegistry: ChannelRegistry = { product: productChannels, adapter: adapterChannels };
const SCRIPT_NOTE = "脚本运行时还会下载程序本体，那部分由脚本自己处理，HarnessHub 不校验，与你在终端里运行相同。";
/**
 * Each product's official way to install it on macOS, as HarnessHub runs it (ADR-044); read from the pages and scripts in
 * docs/research/official-install-channels-2026-10-17.md. OpenClaw's script would install Homebrew and Node.js and start
 * an interactive onboarding, so its equally official npm package is used; Hermes's script clones and builds interactively.
 */
const installs: Readonly<Record<string, OfficialInstallMethod>> = {
  claude: { kind: "script", command: "curl -fsSL https://claude.ai/install.sh | bash", url: "https://claude.ai/install.sh", hosts: ["claude.ai", "downloads.claude.ai"], interpreter: "bash", args: [], env: {},
    writes: [".local/bin", ".local/share/claude", ".claude/downloads"], configFiles: [".claude.json"], shellProfile: null,
    installs: { command: "claude", path: ".local/bin/claude" }, notes: [SCRIPT_NOTE] },
  codex: { kind: "script", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", url: "https://chatgpt.com/codex/install.sh", hosts: ["chatgpt.com", "releases.openai.com"],
    interpreter: "sh", args: [], env: { CODEX_NON_INTERACTIVE: "1" }, writes: [".local/bin", ".codex/packages"], configFiles: [], shellProfile: "codex",
    installs: { command: "codex", path: ".local/bin/codex" }, notes: [SCRIPT_NOTE, "以非交互方式运行（CODEX_NON_INTERACTIVE=1）：不会卸载其他渠道的 Codex，也不会在安装后立即启动。"] },
  opencode: { kind: "script", command: "curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path", url: "https://opencode.ai/install", hosts: ["opencode.ai", "raw.githubusercontent.com"],
    interpreter: "bash", args: ["--no-modify-path"], env: {}, writes: [".opencode"], configFiles: [], shellProfile: null,
    installs: { command: "opencode", path: ".opencode/bin/opencode" }, notes: [SCRIPT_NOTE, "带 --no-modify-path 运行，不改 shell 配置；如果终端里找不到 opencode，需要自己把 ~/.opencode/bin 加入 PATH。"] },
  cursor: { kind: "script", command: "curl https://cursor.com/install -fsS | bash", url: "https://cursor.com/install", hosts: ["cursor.com"], interpreter: "bash", args: [], env: {},
    writes: [".local/bin", ".local/share/cursor-agent"], configFiles: [], shellProfile: null,
    installs: { command: "cursor-agent", path: ".local/bin/cursor-agent" }, notes: [SCRIPT_NOTE, "Cursor 的安装脚本自身不校验下载的完整性。"] },
  openclaw: { kind: "npm", package: "openclaw", bin: "openclaw", command: "npm install -g openclaw@latest",
    notes: ["OpenClaw 的官方脚本会安装 Homebrew 和 Node.js 并进入交互式引导，HarnessHub 不代为运行，改用官网同样列出的 npm 方式。", "装好后请在终端运行 openclaw onboard --install-daemon 完成配置；装好服务之前，OpenClaw 的网关不会运行。"] },
  gemini: { kind: "npm", package: "@google/gemini-cli", bin: "gemini", command: "npm install -g @google/gemini-cli", notes: ["官方仓库写明：自 2026-06-18 起，免费用户与 Google One 用户改用 Antigravity CLI。"] },
  pi: { kind: "npm", package: "@earendil-works/pi-coding-agent", bin: "pi", command: "npm install -g @earendil-works/pi-coding-agent", notes: [] },
  dsh: { kind: "npm", package: "@deepseek-ai/dsh", bin: "dsh", command: "npm install -g @deepseek-ai/dsh", notes: ["DeepSeek Harness 会读取 ~/.dsh 下已有的配置和 acp profile（包括源码版留下的）；HarnessHub 还没有验证它们与官网版的兼容性。"] },
  hermes: { kind: "terminal", command: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    reason: "Hermes 的安装脚本会克隆源码、准备 Python 环境并交互提问，HarnessHub 不代为运行；请在终端运行这条命令。" },
};
/** A product's official install method, or null when HarnessHub records none for it. */
export function officialInstallMethod(harnessId: string): OfficialInstallMethod | null { return installs[harnessId] ?? null; }
