import type { ChannelRegistry, ControlRecipe } from "../contexts/catalog/domain/catalog.js";
import type { InstallationChannel, OfficialChannels, OfficialInstallMethod, ProductMaintenance } from "../contexts/catalog/domain/channels.js";

const CHECKED = "2026-10-17";
/** OpenCode's pages were read again for OpenCode 2 (2.2.5) on this date; the V1 facts of 2026-10-17 stay as history in the comments. */
const OPENCODE_CHECKED = "2026-11-01";
const none = { npm: [], brewFormulae: [], brewCasks: [], scripts: [], uv: [] } as const;
/**
 * Each product's official macOS installation channels (ADR-044), read from its own documentation on the date given; see
 * docs/research/official-install-channels-2026-10-17.md. A product absent here counts its control packages only.
 */
const products: Readonly<Record<string, OfficialChannels>> = {
  claude: { ...none, npm: ["@anthropic-ai/claude-code"], brewCasks: ["claude-code", "claude-code@latest"],
    // The setup page's "Uninstall a native installation": rm -f ~/.local/bin/claude; rm -rf ~/.local/share/claude.
    scripts: [{ root: ".local/share/claude/versions", launchers: [], program: null, formerPrograms: [],
      removal: { links: [".local/bin/claude"], launchers: [], files: [], directories: [".local/share/claude"], emptyDirectories: [], documented: true },
      upgrade: { kind: "self-update", args: ["update"], command: "claude update" } }],
    source: { url: "https://code.claude.com/docs/en/setup", checkedAt: CHECKED } },
  codex: { ...none, npm: ["@openai/codex"], brewCasks: ["codex"],
    // The installer links codex and codex-code-mode-host into ~/.local/bin and keeps releases under ~/.codex/packages/standalone; it has no uninstall mode.
    scripts: [{ root: ".codex/packages/standalone", launchers: [], program: null, formerPrograms: [],
      removal: { links: [".local/bin/codex", ".local/bin/codex-code-mode-host"], launchers: [], files: [], directories: [".codex/packages/standalone"], emptyDirectories: [], documented: false },
      upgrade: { kind: "rerun" } }],
    source: { url: "https://github.com/openai/codex", checkedAt: CHECKED } },
  // OpenCode 1 and OpenCode 2 are two product lines sharing the `opencode` command and these directories; they are not
  // installed side by side (https://opencode.ai/v2/docs/migrate-v1/, read 2026-11-01), and both lines' channels are
  // official. npm: `@opencode/cli` (V2; its postinstall picks the native binary and also adds an `opencode2` bin) and
  // `opencode-ai` (V1). Homebrew: Homebrew's own `opencode` is V2 (2.2.5, https://formulae.brew.sh/formula/opencode),
  // anomalyco/tap's `opencode` is V1 (1.19.5) and its `opencode-v2` (`conflicts_with "opencode"`) installs
  // Cellar/opencode-v2/<version>/bin/opencode; which tap a keg came from is read from its receipt (`opencodeProductLine`).
  // Script: both lines' installers write ~/.opencode/bin/opencode and, without --no-modify-path, a PATH line HarnessHub
  // never edits; V2's (https://opencode.ai/v2/install) also writes the `opencode2` shim beside it (install_legacy_shim),
  // which is why the shim is in the removal list and tells the lines apart for a script installation.
  opencode: { ...none, npm: ["@opencode/cli", "opencode-ai"], brewFormulae: ["opencode", "opencode-v2"],
    scripts: [{ root: ".opencode/bin", launchers: [], program: null, formerPrograms: [],
      removal: { links: [], launchers: [], files: [".opencode/bin/opencode", ".opencode/bin/opencode2"], directories: [], emptyDirectories: [".opencode/bin"], documented: false },
      upgrade: { kind: "rerun" } }],
    source: { url: "https://opencode.ai/v2/docs/", checkedAt: OPENCODE_CHECKED } },
  openclaw: { ...none, npm: ["openclaw"], source: { url: "https://docs.openclaw.ai/install", checkedAt: CHECKED } },
  gemini: { ...none, npm: ["@google/gemini-cli"], brewFormulae: ["gemini-cli"], source: { url: "https://github.com/google-gemini/gemini-cli", checkedAt: CHECKED } },
  // Cursor's page gives no uninstall; the installer writes versions under ~/.local/share/cursor-agent and links agent and cursor-agent.
  cursor: { ...none, scripts: [{ root: ".local/share/cursor-agent/versions", launchers: [], program: null, formerPrograms: [],
    removal: { links: [".local/bin/agent", ".local/bin/cursor-agent"], launchers: [], files: [], directories: [".local/share/cursor-agent"], emptyDirectories: [], documented: false },
    upgrade: { kind: "self-update", args: ["update"], command: "agent update" } }],
    source: { url: "https://cursor.com/docs/cli/installation", checkedAt: CHECKED } },
  pi: { ...none, npm: ["@earendil-works/pi-coding-agent"], source: { url: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", checkedAt: CHECKED } },
  // Hermes's installer keeps its checkout at ~/.hermes/hermes-agent and writes ~/.local/bin/hermes, hermes-acp and
  // hermes-agent: /bin/sh scripts that exec the checkout's .hermes/bin/hermes (hermes-acp its .hermes/bin/hermes-acp;
  // hermes_cli/_launchers.py at v0.22.4); 0.12's launcher started venv/bin/hermes. Its manual uninstall
  // (website/docs/getting-started/updating.md at v0.22.4) removes ~/.local/bin/hermes and the checkout, ~/.hermes is kept;
  // the other two launchers are its installer's, removed only while they start this checkout.
  hermes: { ...none, scripts: [{ root: ".hermes/hermes-agent", launchers: [".local/bin/hermes", ".local/bin/hermes-acp", ".local/bin/hermes-agent"], program: ".hermes/bin/hermes", formerPrograms: ["venv/bin/hermes"],
    removal: { links: [], launchers: [".local/bin/hermes", ".local/bin/hermes-acp", ".local/bin/hermes-agent"], files: [], directories: [".hermes/hermes-agent"], emptyDirectories: [], documented: true },
    // What `hermes update` does, as v0.22.4's website/docs/getting-started/updating.md describes it; --yes accepts its
    // config-migration and stash-restore prompts (hermes_cli/subcommands/update.py).
    upgrade: { kind: "terminal", command: "hermes update --yes",
      explains: "它会先暂停这份安装的所有网关（QQ 等消息渠道在更新期间离线，通常是拉取代码和准备依赖的那段时间），把 ~/.hermes/hermes-agent 里没有提交的改动 git stash 起来，"
        + "更新到它跟踪的渠道（默认 stable）的最新版本并重新准备依赖，迁移 ~/.hermes/config.yaml（--yes 会接受迁移提示，并在更新后恢复你的改动），再以新代码重启网关。"
        + "新网关会把 ~/.hermes/state.db 迁到新格式，写过之后就不能退回旧版本；更新时被打断的回合会标为未知、不会重放，需要在 hermes chat 里用 /discard 确认。"
        + "想保留退路，请先运行 hermes backup 做完整备份。HarnessHub 不代为运行，请在终端运行。" } }],
    // Read again on 2026-10-22 at v0.22.4 (4d04303): README.md and installation.md for the install, updating.md for the update and uninstall.
    source: { url: "https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/README.md", checkedAt: "2026-10-22" } },
  // Linked to the dsh-v0.2.1-rc.2 tag's commit on 2026-10-22; that README runs the same npm package (`npx @deepseek-ai/dsh web`),
  // and the channel stays as read on 2026-10-17.
  dsh: { ...none, npm: ["@deepseek-ai/dsh"], source: { url: "https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md", checkedAt: CHECKED } },
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
    // Its gateway runs as `hermes gateway run` in a terminal; under launchd as the checkout's .hermes/bin/hermes running
    // hermes_cli.stderr_timestamp with `… -- <checkout>/.hermes/bin/hermes gateway run --external-supervisor`; unsupervised
    // as `python -m hermes_cli.main --profile <name> gateway run` with --replace or --quiet --idle-exit (v0.22.4
    // hermes_cli/gateway_launchd.py, gateway_runtime_start.py); 0.12 ran `python -m hermes_cli.main gateway` under launchd.
    // Options, alone or with a value, may stand between the program and `gateway`.
    resident: [{ command: /(?:(?:^|\/)hermes|hermes_cli\.main)(?:\s+--?[A-Za-z][\w-]*(?:=\S*|\s+(?!-)\S+)?)*\s+gateway(?:\s|$)/u, stop: "hermes gateway stop" }] },
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
    scripts: control.distribution?.kind === "binary" ? [{ root: ".local/share/harnesses/" + harnessId, launchers: [], program: null, formerPrograms: [], removal: null, upgrade: null }] : [] };
}
/** A product's services and data (ADR-044); a product without a record registers no service and its data is not named. */
export function productMaintenance(harnessId: string): ProductMaintenance { return maintenance[harnessId] ?? { services: [], data: [], resident: [] }; }
/**
 * OpenCode's two product lines (ADR-053, 2026-11-01): OpenCode 1 and OpenCode 2 share the `opencode` command and the same
 * configuration and data directories, and differ in their configuration dialect and some CLI commands. The line is a fact
 * of the installation's channel, never of its version number.
 */
export type OpenCodeLine = "v1" | "v2";
/**
 * The product line an OpenCode installation's channel record names: npm `@opencode/cli` (V2) or `opencode-ai` (V1), the
 * `opencode-v2` formula (V2), Homebrew's own `opencode` (no tap in the receipt; V2) or anomalyco/tap's `opencode` (V1).
 * Null when the record does not tell: a script installation (both lines' installers write the same program; the `opencode2`
 * shim beside it does tell, which the capability layer checks), a formula of another tap, a cask. Pure; reads no version.
 */
export function opencodeProductLine(channel: Pick<InstallationChannel, "kind" | "name" | "tap">): OpenCodeLine | null {
  switch (channel.kind) {
    case "npm": case "pnpm": case "bun": return channel.name === "@opencode/cli" ? "v2" : channel.name === "opencode-ai" ? "v1" : null;
    case "brew-formula":
      if (channel.name === "opencode-v2") return "v2";
      if (channel.name !== "opencode") return null;
      return channel.tap === undefined ? "v2" : channel.tap.toLowerCase() === "anomalyco/tap" ? "v1" : null;
    case "brew-cask": case "script": case "uv": return null;
  }
}
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
  // OpenCode 2's installer (https://opencode.ai/v2/docs/; the script at https://opencode.ai/v2/install was read on 2026-11-01:
  // served by opencode.ai itself, while the V1 address https://opencode.ai/install redirects to raw.githubusercontent.com,
  // so both hosts stay allowed). Its options are --no-modify-path, --version and --binary; it asks opencode.ai for the
  // latest version and fetches the program from registry.npmjs.org (the part HarnessHub does not check), writes
  // ~/.opencode/bin/opencode and the opencode2 shim, and replaces a V1 program in that directory.
  opencode: { kind: "script", command: "curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path", url: "https://opencode.ai/v2/install", hosts: ["opencode.ai", "raw.githubusercontent.com"],
    interpreter: "bash", args: ["--no-modify-path"], env: {}, writes: [".opencode"], configFiles: [], shellProfile: null,
    installs: { command: "opencode", path: ".opencode/bin/opencode" }, notes: [SCRIPT_NOTE, "带 --no-modify-path 运行，不改 shell 配置；如果终端里找不到 opencode，需要自己把 ~/.opencode/bin 加入 PATH。",
      "装的是 OpenCode 2：脚本还会在 ~/.opencode/bin 写一个 opencode2 垫片，并替换同一目录里的 OpenCode 1。OpenCode 1 与 2 共用 opencode 命令、不能并存；按迁移指南（https://opencode.ai/v2/docs/migrate-v1/），Homebrew 或 npm 装的 OpenCode 1 要先卸载再装。"
        + "OpenCode 2 读 OpenCode 1 的配置而不改写它，并一次性把 ~/.local/share/opencode 里的数据库迁到新表，能否退回未见文档说明。"] },
  cursor: { kind: "script", command: "curl https://cursor.com/install -fsS | bash", url: "https://cursor.com/install", hosts: ["cursor.com"], interpreter: "bash", args: [], env: {},
    writes: [".local/bin", ".local/share/cursor-agent"], configFiles: [], shellProfile: null,
    installs: { command: "cursor-agent", path: ".local/bin/cursor-agent" }, notes: [SCRIPT_NOTE, "Cursor 的安装脚本自身不校验下载的完整性。"] },
  // The npm command as docs/install/index.md gives it at v2026.10.5 (read 2026-10-22); the launcher's own completion of
  // skipped lifecycle scripts is in its openclaw.mjs at that tag.
  openclaw: { kind: "npm", package: "openclaw", bin: "openclaw", command: "npm install -g openclaw@latest --allow-scripts=openclaw",
    notes: ["OpenClaw 的官方脚本会安装 Homebrew 和 Node.js 并进入交互式引导，HarnessHub 不代为运行，改用官网同样列出的 npm 方式。",
      "官网命令里的 --allow-scripts=openclaw 明确允许 OpenClaw 的 preinstall 与 postinstall：npm 11.16 起没有它时 npm 只警告、仍会运行这两个脚本，npm 12 起默认不运行；npm 11.15 及更早没有这个选项，要去掉它。没运行的安装脚本由 OpenClaw 在下一次启动时自己补跑，补跑失败会提示 package lifecycle is incomplete。",
      "装好后请在终端运行 openclaw onboard --install-daemon 完成配置；装好服务之前，OpenClaw 的网关不会运行。"] },
  gemini: { kind: "npm", package: "@google/gemini-cli", bin: "gemini", command: "npm install -g @google/gemini-cli", notes: ["官方仓库写明：自 2026-06-18 起，免费用户与 Google One 用户改用 Antigravity CLI。"] },
  pi: { kind: "npm", package: "@earendil-works/pi-coding-agent", bin: "pi", command: "npm install -g @earendil-works/pi-coding-agent", notes: [] },
  dsh: { kind: "npm", package: "@deepseek-ai/dsh", bin: "dsh", command: "npm install -g @deepseek-ai/dsh", notes: ["DeepSeek Harness 会读取 ~/.dsh 下已有的配置和 acp profile（包括源码版留下的）；HarnessHub 还没有验证它们与官网版的兼容性。"] },
  // The command v0.22.4's README and installation page give (read 2026-10-22).
  hermes: { kind: "terminal", command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    reason: "Hermes 的安装脚本会克隆源码、准备 Python 环境并交互提问，HarnessHub 不代为运行；请在终端运行这条命令。" },
};
/** A product's official install method, or null when HarnessHub records none for it. */
export function officialInstallMethod(harnessId: string): OfficialInstallMethod | null { return installs[harnessId] ?? null; }
