# 各 Harness 在 macOS 上的官方安装渠道（2026-10-17）

用户统一的方向：只做 macOS；只按官网写明的安装方式探测 Harness，源码安装和自定义入口不算“已安装”；平台负责探测、维护版本、升级，点击后按官网方式安装，卸载时只删程序、保留配置、登录和会话数据。

下表依据各产品官网或官方仓库在 2026-10-17 的内容，以及本机已安装版本自带的文档。每条都注明了来源。“本机”一列是这台电脑上现在的安装情况。

## 汇总

| Harness | 官方渠道 | 程序位置 | 升级 | 卸载（只删程序） | 本机 |
|---|---|---|---|---|---|
| Claude Code | 官方脚本 `curl -fsSL https://claude.ai/install.sh \| bash`（推荐）、Homebrew cask `claude-code` / `claude-code@latest`、npm `@anthropic-ai/claude-code` | 脚本：`~/.local/bin/claude` → `~/.local/share/claude/versions/<版本>` | 脚本装的会自动更新，也可运行 `claude update`；cask：`brew upgrade claude-code`；npm：`npm install -g @anthropic-ai/claude-code@latest` | 脚本：`rm -f ~/.local/bin/claude` 并删除 `~/.local/share/claude`；`brew uninstall --cask claude-code`；`npm uninstall -g @anthropic-ai/claude-code` | npm，两份：Homebrew 前缀下一份，nvm 目录下一份 |
| Codex | 官方脚本 `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`（README 首推）、npm `@openai/codex`、Homebrew cask `codex`、GitHub 发布包 | 脚本：`~/.local/bin/codex`（可用 `CODEX_INSTALL_DIR` 改），发布文件在 `~/.codex/packages/standalone` | 脚本：重新运行即升级；npm、cask 走各自的升级命令 | 脚本：没有卸载模式；npm、cask 走各自的卸载命令 | Homebrew cask |
| OpenCode | 官方脚本 `curl -fsSL https://opencode.ai/install \| bash`（推荐）、npm `opencode-ai`、Homebrew `anomalyco/tap/opencode`（推荐）或核心 formula `opencode` | 脚本：`~/.opencode/bin/opencode`，会往 shell 配置加 PATH（`--no-modify-path` 可关） | 各渠道各自的命令 | 各渠道各自的命令 | Homebrew formula |
| OpenClaw | 官方脚本 `curl -fsSL https://openclaw.ai/install.sh \| bash`（基于 npm）、npm `openclaw` | npm 全局前缀 | `openclaw update`（会重启 Gateway），或 npm 安装后 `openclaw gateway restart` | 先 `openclaw gateway stop`、`openclaw gateway uninstall`，再 `npm rm -g openclaw`。`openclaw uninstall` 会连状态一起删，不用它 | npm（Homebrew 前缀） |
| Gemini CLI | npm `@google/gemini-cli`、Homebrew `gemini-cli`、MacPorts | npm 全局前缀或 Homebrew keg | `npm install -g @google/gemini-cli@latest`；`brew upgrade gemini-cli` | 各渠道各自的命令 | Homebrew formula 0.38.2 的 keg 里，自报 0.62.0 |
| Cursor CLI | 官方脚本 `curl https://cursor.com/install -fsS \| bash` | `~/.local/share/cursor-agent/versions/<版本>/cursor-agent`，链接 `~/.local/bin/agent` 与 `~/.local/bin/cursor-agent`；不改 shell 配置 | 默认自动更新，也可运行 `agent update` | 官网没写。按脚本的布局，删除两个链接和 `~/.local/share/cursor-agent` | 官方脚本 |
| Pi | npm `@earendil-works/pi-coding-agent`（当前 1.3.0） | npm 全局前缀 | `npm install -g @earendil-works/pi-coding-agent@latest` | `npm uninstall -g @earendil-works/pi-coding-agent` | 指向开发目录 `~/Desktop/project/pi`（0.85.1），按新原则不算已安装 |
| Hermes Agent | 官方脚本 `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \| bash`（克隆仓库并建 venv） | `~/.hermes/hermes-agent`，启动器 `~/.local/bin/hermes` | `hermes update` | 待核实：Hermes 是否自带卸载命令（只看到 `hermes gateway uninstall`） | 官方脚本 |
| DeepSeek Harness | npm `@deepseek-ai/dsh`（当前 0.2.0-rc.2） | npm 全局前缀 | `npm install -g @deepseek-ai/dsh@latest` | `npm uninstall -g @deepseek-ai/dsh` | 源码构建（0.2.1-alpha.1，经自定义入口接入），按新原则不算已安装 |

## 要点

- **一个产品往往有多个官方渠道。** 用户可能用不止一种方式装过，例如 Claude Code 在这台电脑上就有两份。探测要列出所有官方渠道的安装，标明终端实际使用的是哪一份（PATH 里排在最前面的那份），升级和卸载按各自渠道执行。
- **官方脚本的安装位置是固定的。** Claude Code、Cursor、Codex 的脚本装在 `~/.local/bin`、`~/.local/share/...` 或 `~/.codex/...`，OpenCode 装在 `~/.opencode/bin`，Hermes 装在 `~/.hermes/hermes-agent`。这些是探测脚本安装的依据，不必扫描用户的其他目录。
- **有的官方脚本会改 shell 配置**，往里加 PATH：OpenCode、Codex 会，Cursor 不会。平台代为安装时，确认框里要写明会改哪个文件。如果产品支持不改配置的参数（例如 OpenCode 的 `--no-modify-path`），就由平台自己确保程序能被找到。
- **官方卸载命令不一定“只删程序”。** `openclaw uninstall` 会连状态和配置一起删，按用户的选择不能用它，要按 OpenClaw 文档里的手动步骤只删服务和程序。Codex 脚本没有卸载模式，Cursor 官网没写卸载，都要按它们的安装布局删除程序文件。
- **Gemini CLI 已被 Antigravity CLI 取代**（官方仓库写着自 2026-06-18 起，对免费用户和 Google One 用户生效）。这和它在能力矩阵里全部受阻是一致的。是否接入 Antigravity CLI 另行决定。
- **适配器单独计。** HarnessHub 通过 `claude-agent-acp` 控制 Claude Code。这个适配器是 ACP 注册表里的 npm 包，它的安装和升级与 Claude Code 本身分开维护。

## 卸载与安装脚本的补充核对（2026-10-17，只读）

- **Claude Code**：官网卸载节写明脚本版删 `~/.local/bin/claude` 和 `~/.local/share/claude`。安装脚本把程序下载到 `~/.claude/downloads`，再运行 `claude install` 设置启动器。
- **Codex**（`https://chatgpt.com/codex/install.sh`）：
  - 在 `~/.local/bin` 写 `codex` 和 `codex-code-mode-host` 两个链接，发布文件放在 `~/.codex/packages/standalone`。
  - macOS 的 zsh 会往 `~/.zprofile` 加一段 PATH；`~/.local/bin` 已在 PATH 上、且没有其他渠道的 Codex 时不加。
  - `CODEX_NON_INTERACTIVE=1` 跳过两处提问：卸载其他渠道的 Codex，和立即启动。脚本没有卸载模式。
- **Cursor**（`https://cursor.com/install`）：写 `~/.local/share/cursor-agent/versions/<版本>`，并链接 `~/.local/bin/agent` 与 `~/.local/bin/cursor-agent`。不改 shell 配置，下载不校验摘要，官网没有卸载说明。
- **OpenCode**（`https://opencode.ai/install`）：
  - 只写 `~/.opencode/bin/opencode`；`--no-modify-path` 时不改 shell 配置。
  - PATH 里已有同版本的 `opencode` 时，脚本直接退出。
  - CLI 有 `opencode uninstall [--keep-config --keep-data --force]` 和 `opencode upgrade [--method curl|npm|pnpm|bun|brew]`。
- **OpenClaw**：
  - 安装脚本在需要时会安装 Homebrew、Node.js、cmake 等，并通过 `/dev/tty` 交互；`--no-onboard --no-prompt` 可以跳过引导。
  - 本机自带文档的卸载手动步骤是 `openclaw gateway stop` → `openclaw gateway uninstall` → `npm rm -g openclaw`。node host 服务另有 `openclaw node stop` 和 `openclaw node uninstall`。
- **Hermes**：
  - `hermes uninstall` 是交互式的（选 1/2/3，再输 yes）；选保留数据时，它会删除 shell 配置里的 PATH 行。
  - 文档的手动卸载是 `rm -f ~/.local/bin/hermes; rm -rf <hermes-agent>`；网关先 `hermes gateway stop`，macOS 上再 `launchctl remove ai.hermes.gateway`。CLI 另有 `hermes gateway uninstall`。

- **安装脚本地址的跳转**（2026-10-17 用 `curl -L` 核对）：
  - `https://claude.ai/install.sh` 跳到 `https://downloads.claude.ai/claude-code-releases/bootstrap.sh`；
  - `https://chatgpt.com/codex/install.sh` 跳到 `https://releases.openai.com/codex/install.sh`；
  - `https://opencode.ai/install` 跳到 `https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/v1/install`；
  - `https://cursor.com/install` 和 `https://openclaw.ai/install.sh` 不跳转。
- **Claude Code 的 npm 安装**：官网写明用 npm 安装时，postinstall 会把原生程序链接到位，所以 HarnessHub 用 npm 安装时不能加 `--ignore-scripts`。

## 来源

- Claude Code：https://code.claude.com/docs/en/setup （安装、更新、卸载各节）
- Cursor CLI：https://cursor.com/docs/cli/installation 与安装脚本 https://cursor.com/install
- OpenCode：https://opencode.ai/docs 与安装脚本 https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/v1/install
- Codex：https://github.com/openai/codex （README，2026-10-17 再读：首推 `https://chatgpt.com/codex/install.sh`，脚本默认从 `https://releases.openai.com/codex` 下载）
- Gemini CLI：https://github.com/google-gemini/gemini-cli （README）
- OpenClaw：本机 2026.3.23-2 自带文档 `docs/install/updating.md`、`docs/install/uninstall.md`、`docs/cli/uninstall.md`
- Hermes Agent：本机 `~/.hermes/hermes-agent/README.md`（只读）
- Pi、DeepSeek Harness：npm 注册表 `npm view @earendil-works/pi-coding-agent`、`npm view @deepseek-ai/dsh`，以及目录里记录的官方说明链接
