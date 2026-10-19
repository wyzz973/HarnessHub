# 九个 Harness 的扩展能力配置（2026-10-18）

用户要求由 HarnessHub 统一管理各 Harness 的技能、MCP、指令文件、插件、子 Agent 与自定义命令、Hooks，只改用户级配置。本页记录这台电脑上已装版本的事实，供后续 ADR 使用。

## 方法与局限

- 三路只读调研（2026-10-18）：只运行各命令的 `--version` 与 `--help`，没有打开任何配置或凭据文件，没有运行会启动或连接 MCP 服务器的命令。事实来自官方文档；文档与本机版本不一致时，核对了同版本源码。
- 本机统计只读取目录结构和 MCP 名称，不读命令、地址、环境变量或任何值；OpenClaw 的配置完全没有读。
- 本机版本：Claude Code 2.1.302（另有 Homebrew 前缀下 2.1.296）、Codex 0.162.1、Cursor CLI 2026.10.01-e373342（命令名 `cursor-agent`，没有 `agent`）、OpenCode 1.18.35、Gemini CLI 0.62.0（Homebrew keg 目录名仍是 0.38.2）、OpenClaw 2026.3.23-2、Hermes 0.12.0、Pi 0.85.1（开发检出，按 ADR-044 不算官网安装）、DeepSeek Harness 0.2.1-alpha.1（源码构建，不在 PATH）。
- 文档页大多没有日期。OpenClaw、Hermes 的最新文档描述的版本比本机新很多（本机分别落后约 7 个月和 10 个小版本），下表以本机版本为准，最新版的差异单独注明。

## 技能

| Harness | 用户级位置 | 格式要点 | 启用与停用 | 生效 |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills`（另有项目、嵌套目录、插件、managed） | `SKILL.md`，字段全可选；目录里有 `.claude-plugin/plugin.json` 时按插件加载 | settings `skillOverrides`、权限 `Skill(name)` | 监视目录，立即生效 |
| Codex | `~/.agents/skills`（另有 `/etc/codex/skills`、内置） | 必须有 `name`、`description`；可带 `agents/openai.yaml` | `config.toml` 的 `[[skills.config]] enabled=false` | 文件变化自动检测；改配置要重启 |
| Cursor | `~/.agents/skills`、`~/.cursor/skills`，并兼容读取 `~/.claude/skills`、`~/.codex/skills` | `name` 必须与目录同名 | 无开关 | 启动时发现 |
| OpenCode | `~/.config/opencode/skills`、`~/.agents/skills`，并读 `~/.claude/skills` | `name`、`description` | `permission.skill` 按名字 allow/deny/ask | 无监视，要重启 |
| Gemini CLI | `~/.gemini/skills`、`~/.agents/skills` | 只读 `name`、`description` | settings `skills.disabled`；`gemini skills enable/disable/install/link/uninstall` | `/skills reload` |
| OpenClaw | `~/.agents/skills`、`~/.openclaw/skills`，另有 workspace、bundled、插件 | 本机版 frontmatter 每键一行，`metadata` 为单行 JSON | `skills.entries.<名>.enabled`（只能 `openclaw config set`） | 目录监视，下一轮生效，不重启 Gateway |
| Pi | `~/.pi/agent/skills`、`~/.agents/skills` | `name`、`description` 必填 | settings 的 `skills` 数组（`pi config` 只有 TUI） | 交互模式 `/reload`；RPC 无 reload |
| Hermes | `~/.hermes/skills` 加 `skills.external_dirs`（本机版不读 `~/.agents/skills`） | 兼容 agentskills.io | `skills.disabled`、`skills.platform_disabled` | 长驻进程要 `/reload-skills` 或重启 |
| DeepSeek Harness | `~/.dsh/skills`、`${DSH_AGENTS_HOME:-~/.agents}/skills` | 目录或单个 `.md`；字段驼峰写法被拒 | 只能停用整个 provider 行 | chokidar 监视，下一步生效 |

**交叉读取**
- 读 `~/.agents/skills` 的有七个：Codex、Cursor、OpenCode、Gemini、OpenClaw、Pi、DeepSeek Harness。Claude 和 Hermes 不读。
- Cursor 和 OpenCode 还读 `~/.claude/skills`。本机 Claude 的技能多是指向 `~/.agents/skills` 的链接，所以同一个技能在这两个 Harness 里会出现两次。
- Cursor 还读 `~/.codex/skills`。在一处增删技能，可能同时改变几个 Harness 的能力。

**本机情况**：`~/.agents/skills` 有 68 个技能目录，由 vercel-labs/skills 工具管理（`~/.agents/.skill-lock.json`，版本 3，记录 61 个，来源多为 GitHub）。`~/.claude/skills` 有 63 个链接指向那里，`~/.hermes/skills` 有 31 个，`~/.openclaw/skills` 52 个全是链接。`~/.codex/skills` 有 28 个独立目录。99 个技能名里，68 个出现在两个以上位置。

## MCP

| Harness | 用户级配置 | 官方命令（本机版） | 密钥写法 | 写入的坑 |
|---|---|---|---|---|
| Claude Code | `~/.claude.json` 顶层 `mcpServers` | `claude mcp add-json <名> '<json>' -s user`、`remove -s user`；`list`、`get` 会启动并检查服务器 | `${VAR}`、`${VAR:-默认}`；`-e`、`-H` 写明文 | 文件由 Claude 自己改写，每次改写前备份 5 份；运行中的会话也会写它 |
| Codex | `~/.codex/config.toml` `[mcp_servers.<名>]` | `codex mcp add/remove`，只写全局；HTTP 的 `add` 发现 OAuth 时会弹出浏览器；`list` 可能联网 | 写变量名：`env_vars`、`bearer_token_env_var`、`env_http_headers` | 没有 SSE；改配置要重启；`[[skills.config]]` 是表数组 |
| Cursor | `~/.cursor/mcp.json` `mcpServers`（与编辑器共用） | 没有增删命令；`cursor-agent mcp enable/disable/login/list` | `${env:NAME}`、`envFile` | 只能改文件；新服务器可能要批准 |
| OpenCode | `~/.config/opencode/opencode.json(c)` 的 `mcp` | `opencode mcp add`（非交互时只写全局）；没有 remove；`list` 会启动服务器 | `{env:VAR}`、`{file:path}` | 按 JSONC 解析；加载时会自己插入 `$schema` 行；本机是 V1，不能写 V2 结构 |
| Gemini CLI | `~/.gemini/settings.json` `mcpServers` | `gemini mcp add/remove -s user`、`enable/disable`；`list` 会连接 | `$VAR`、`${VAR}`；启动子进程时剔除名字像密钥的变量，要在 `env` 里显式写出 | 运行中的会话保存设置时按启动快照覆盖文件，不加锁 |
| OpenClaw | `~/.openclaw/openclaw.json`（JSON5）`mcp.servers` | 隐藏的 `openclaw mcp set/unset/list/show`；`show --json` 输出明文密钥 | `${VAR}`（大写），不收 SecretRef | 本机版运行时只支持 stdio；改 `mcp.*` 会让 Gateway 自动重启，飞书、微信断开；写入时整份改写为 JSON，注释丢失 |
| Pi | 本机 0.85.1 没有 MCP；0.99 起有 `~/.pi/agent/mcp.json` | 新版 `pi mcp add/remove [-l]` | 新版 `${VAR}` | — |
| Hermes | `~/.hermes/config.yaml` `mcp_servers`（profile 时在 `~/.hermes/profiles/<名>/`） | `hermes mcp add` 是交互式的，先连接服务器，无终端时取消；`remove`、`list`（只读） | `${VAR}`，值在 `~/.hermes/.env`；`--env` 写明文 | 本机版没有 SSE；它自己的写入整份重写 YAML，注释丢失；`hermes acp` 改配置后要重启 |
| DeepSeek Harness | profile 或 `~/.dsh/cordis.patch.yml` 的 patch 行 `@deepseek-ai/dsh-mcp-client` | 没有命令 | `!!js process.env.X`；子进程环境会清洗 | 只能插入或覆盖整行；空文件会导致启动失败；0.2.x 不再用 `settings.yaml` |

**本机情况**：Codex 配置了 5 个 MCP 服务器，Cursor 4 个，Claude 用户级 0 个（1 个项目有本地 MCP），Gemini、OpenCode、Hermes 都是 0 个；没有在两个 Harness 里重复配置的名字。

## 指令文件

| Harness | 用户级 | 项目 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md`，`@path` 导入最多 4 层；`~/.claude/rules/` | `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`；只有都没有时才读 `AGENTS.md` |
| Codex | `~/.codex/AGENTS.override.md`，没有时用 `AGENTS.md`（trim 后第一个非空者；整文件读，没有上限，2026-10-19 按 rust-v0.162.1 `codex-home/src/instructions/mod.rs` 更正） | 根到 cwd 每级一个；32 KiB 是项目文档的预算（`project_doc_max_bytes`），不限用户级文件 |
| Cursor | User rules 不在磁盘上 | `.cursor/rules/*.mdc`、根目录 `AGENTS.md`、`CLAUDE.md` |
| OpenCode | `~/.config/opencode/AGENTS.md`，不存在时用 `~/.claude/CLAUDE.md`（只看是否存在，空文件也算；`OPENCODE_DISABLE_CLAUDE_CODE` 或 `…_PROMPT` 为真时不回退） | `AGENTS.md`，没有时 `CLAUDE.md`；`instructions` 数组 |
| Gemini CLI | `~/.gemini/GEMINI.md`（`context.fileName` 可改名，默认不读 AGENTS.md） | 工作区及父目录的 GEMINI.md；`@file` 导入 |
| OpenClaw | agent workspace 的 AGENTS.md、SOUL.md、TOOLS.md 等（默认 `~/.openclaw/workspace`）；单个文件超过 20000 字符（`agents.defaults.bootstrapMaxChars`）时保留头尾、挖掉中间 | ACP 下用 Gateway 的 workspace，不用会话 cwd |
| Pi | `~/.pi/agent/AGENTS.md`；`SYSTEM.md`、`APPEND_SYSTEM.md` | 各级 AGENTS.md 或 CLAUDE.md 全部拼接；`AGENTS.override.md` |
| Hermes | `~/.hermes/SOUL.md` | 只取一种：HERMES.md、AGENTS.md（只看 cwd）、CLAUDE.md、.cursorrules |
| DeepSeek Harness | `~/.dsh/AGENTS.md` | git 根到 cwd 的 AGENTS/CLAUDE(.local).md 叠加 |

## 插件与扩展

| Harness | 是什么 | 命令 |
|---|---|---|
| Claude Code | 插件可含 skills、commands、agents、hooks、MCP、LSP、bin 等；marketplace | `claude plugin install/uninstall/enable/disable/update/list --json`，带作用域；会话启动或 `/reload-plugins` 生效。启停就是 `settings.json` 的 `enabledPlugins.<名@市场>`（没有条目时按 `defaultEnabled`，市场条目优先、缺省 true）；claude.ai 同步的插件以 `<名>@synced` 加载，清单在 `plugins/synced/<账户>/manifest.json`；2.1.303 不读 `plugins/blocklist.json`（旧版留下的文件）。运行命令会补齐插件缓存，新的配置目录里还会执行 `npm ci` |
| Codex | 插件可含 skills、MCP、hooks、apps | `codex plugin add/remove/list`、`marketplace add/list/upgrade/remove`；新会话生效。没有启停命令：`/plugins` 与 app-server 都改 `config.toml` 的 `[plugins."名@市场"].enabled`；缓存在 `plugins/cache/<市场>/<名>/<版本>` |
| Cursor | 插件可含 rules、skills、agents、commands、hooks、MCP | shell 里只能管理 marketplace；安装要在会话内 `/plugin` |
| OpenCode | JS/TS 插件 | `opencode plugin <module> [-g]`，没有卸载。读 `{plugin,plugins}/*.{ts,js}`（含点开头的文件、跟随链接）与 `plugin` 数组（`string` 或 `[string, 选项]`）；`tui.json` 的 `plugin` 只在终端界面加载 |
| Gemini CLI | 扩展可含 MCP、上下文、commands、skills、agents、hooks、策略、主题 | `gemini extensions install/uninstall/enable/disable/update/list` |
| OpenClaw | native 插件，以及兼容 Claude/Codex/Cursor 布局的 bundle | `openclaw plugins install/uninstall/enable/disable/list/update`；本机版改 `plugins.*` 会让 Gateway 自动重启 |
| Pi | TS 扩展与 npm/git 包 | `pi install/remove/list/update [-l]` |
| Hermes | Python 插件，需显式启用 | `hermes plugins install/remove/enable/disable/list`；`remove` 不清理启用列表。`plugins.enabled` 缺失时一个用户插件都不启用，`disabled` 优先；`<分类>/<名>` 布局，键按路径；记忆提供方由 `<分类>.provider` 选择，模型提供方不受启用列表约束；`enable` 经 `save_config` 整份重写 `config.yaml` |
| DeepSeek Harness | 插件就是 npm bundle | `dsh plugin --profile <名> add/remove <包>`，要重启该 profile；插件是 `$DSH_HOME/profiles/<名>/package.json` 的依赖，参数原样交给 pnpm |

## 子 Agent、自定义命令与 Hooks

- **子 Agent**：Claude `~/.claude/agents/**/*.md`（递归，按 `name`）；Codex `~/.codex/agents/**/*.toml`（递归，必填 `name`、`description`、`developer_instructions`；`config.toml` 的 `[agents.<名>]` 也声明角色）；Cursor 的文档写读 `.cursor/agents`、`.claude/agents`、`.codex/agents`（含用户级），但本机 cursor-agent 2026.10.01 只读工作区里的；OpenCode `~/.config/opencode/{agent,agents}/**/*.md` 与 `{mode,modes}/*.md`；Gemini `~/.gemini/agents/*.md`（只读顶层普通文件，跳过 `_` 开头的与链接）；OpenClaw 用 `openclaw agents` 管理多 agent；Pi、Hermes、DeepSeek Harness 没有同类文件格式（DeepSeek Harness 的 agent preset 在 Web 界面里）。2026-10-19 按已装版本补正，见 ADR-045 第 5 步。
- **自定义命令**：Claude `~/.claude/commands/*.md`（已并入 skills）；Codex `~/.codex/prompts/*.md` 自 0.118.0 起不再读取（代码已删除）；OpenCode `~/.config/opencode/{command,commands}/**/*.md`（`` !`cmd` `` 不经权限执行）；Gemini `~/.gemini/commands/*.toml`（`--acp` 不展开）；Pi `~/.pi/agent/prompts/*.md`；Cursor CLI 读 `~/.cursor/commands` 与 `~/.claude/commands` 顶层。
- **Hooks**：Claude 在 settings.json 的 `hooks`；Codex `~/.codex/hooks.json`，非托管 hook 要按哈希信任；Cursor `~/.cursor/hooks.json`，还会合并 Claude 的 hooks；Gemini settings.json 的 `hooks`，有 `gemini hooks migrate --from-claude`；OpenClaw `HOOK.md` 加 handler，`openclaw hooks enable/disable`；Hermes config.yaml 的 `hooks`，首次运行要确认；DeepSeek Harness 用 hooks 行指向 Claude 或 Codex 的 hooks.json。Hooks 会执行命令，事件名各家不同。

## 与旧版 Library 假设的冲突

旧仓库 HarnessHub 的 Library（`packages/agents/src/library/targets.ts`、`docs/library.md`）按当时版本写入各 Agent。对照本机版本，至少有这些不符：

- Codex 的用户级技能读 `~/.agents/skills`，旧版写的是 `<CODEX_HOME>/skills`（是否仍被扫描没能确认）。
- Hermes 本机版已支持 `${VAR}`（旧版标为“无”）；本机版没有 SSE，旧版写的是 `transport: sse`。
- OpenClaw 本机版运行时只支持 stdio MCP，改 `mcp.*` 会自动重启 Gateway。
- DeepSeek Harness 0.2.x 的持久设置写 `cordis.patch.yml`，不是 `settings.yaml`。
- Hermes 和 OpenClaw 自己的写入会整份重写配置，按字节比较的漂移检测会误报，需要按语义比较。

## 未确认

- Codex 0.162.1 是否仍扫描 `$CODEX_HOME/skills`；`codex mcp add --url` 自动 OAuth 与 `mcp list` 的网络行为只来自 main 分支源码，没有在本机版本上实测。
- Claude MCP OAuth token 的存放位置、`.mcp.json` 批准结果的存放位置、`~/.claude.json` 是否有并发锁。
- Cursor 批准列表与 OAuth token 的存放位置、已安装插件的位置；社区报告 CLI 不读项目级 `.cursor/mcp.json`。
- Gemini 的 Homebrew keg 目录是 0.38.2，里面的程序却是 0.62.0，是谁原地更新的不清楚。
- Antigravity CLI 不共用 Gemini CLI 的 settings 与 extensions（官方 Google Cloud 文档 2026-10-15），迁移是一次性复制。

## 来源

- Claude Code：code.claude.com/docs/en/ 下的 mcp、skills、settings、settings-reference、claude-directory、memory、sub-agents、hooks、output-styles、plugins-reference、plugins/loading、plugins/cli-reference、authentication、cli-reference（访问 2026-10-18，页面引用到 v2.1.295–2.1.296）。
- Codex：learn.chatgpt.com/docs/ 下的 extend/mcp、build-skills、config-file/config-reference、config-basic、config-advanced、agent-configuration/agents-md、subagents、plugins、hooks、custom-prompts、codex-manual；源码 github.com/openai/codex 的 `codex-rs/cli/src/mcp_cmd.rs`、`core/src/config/edit.rs`、`rmcp-client/src/oauth.rs`（main 分支，不一定等于 0.162.1）。
- Cursor：cursor.com/docs/ 下的 cli/mcp、context/mcp、context/skills、context/rules、cli/using、plugins、reference/plugins、cli/reference/configuration、agent/hooks、context/subagents、cli/acp、cli/changelog。
- OpenCode：opencode.ai/docs/ 下的 config、mcp-servers、skills、rules、cli、plugins、agents、commands、server（页面标 2026-10-17）；源码 github.com/anomalyco/opencode tag v1.18.35。
- Gemini CLI：github.com/google-gemini/gemini-cli tag v0.62.0 的 docs 与源码（configuration、mcp-server、skills、extensions、gemini-md、subagents、custom-commands、hooks、settings.schema.json）；Antigravity：developers.googleblog.com 2026-05-19 公告、gemini-cli discussions #28017、docs.cloud.google.com/cloud-assist/design-deploy-antigravity-cli（2026-10-15）。
- Pi：github.com/earendil-works/pi tag v0.85.1 的 README、docs/skills、settings、packages、extensions、rpc；v1.3.0 的 docs/mcp 与 CHANGELOG。
- OpenClaw：本机 npm 包 openclaw@2026.3.23-2 的 docs 与 dist（对应 commit 7ffe7e4）；docs.openclaw.ai（2026-10-18，跟随 main）。
- Hermes：本机检出 a0556b8（v0.12.0）的 website/docs 与源码；github.com/NousResearch/hermes-agent main 18c525b。
- DeepSeek Harness：本机源码 5badb15（0.2.1-alpha.1）；github.com/deepseek-ai/deepseek-harness main 687f282。
- vercel-labs/skills：github.com/vercel-labs/skills README（2026-10-18）。
