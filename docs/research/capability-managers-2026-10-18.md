# 跨 Agent 统一管理能力的开源做法（2026-10-18）

用户要求在实现统一的技能、MCP、指令、插件、子 Agent、命令与 Hooks 管理之前，先调研 GitHub 上的相关项目。本页记录三路只读调研的结论，以及对 HarnessHub 的启发。九个 Harness 自身的配置事实见[扩展能力配置](native-extension-configs-2026-10-18.md)。

## 方法与局限

- 只读公开仓库、issue 与官方文档；没有安装或运行任何被调研的工具，没有读本机任何 Agent 配置、凭据或 cc-switch 的数据库。关键结论回到源码抽查过；各项目的版本与 commit 记在下面。
- 被调研的项目更新极快（rulesync 四个月约 28 个大版本），结论只代表所读版本。

## 1. 技能

### 1.1 主要项目

| 项目（读的版本） | 事实源 | 写入 | 不覆盖用户文件 | 更新检测 | 按 Agent 开关 | 删除 |
|---|---|---|---|---|---|---|
| vercel-labs/skills（v1.7.2，`13e4063`，MIT） | 共享目录 `~/.agents/skills`（真实目录）+ `~/.agents/.skill-lock.json` v3 | 复制到共享目录；给不读它的 Agent 建相对链接；`cleanAndCreateDirectory` 先 `rm -rf` 再复制，无临时目录 | 弱：`-y` 或在 Agent 内运行时直接覆盖同名目录（#1723 删掉了 Hermes 一个含 10 个技能的分类目录） | 目录的 GitHub tree SHA；`check` 就是 `update`（#954），只看 lock 不看本地（#1812） | 只能增删非 universal Agent 的链接 | 对所有 Agent 目录里的同名项 `rm -rf` |
| farion1231/cc-switch（v4.0.15） | `~/.cc-switch/skills` 或 unified 模式下 `~/.agents/skills` + SQLite | 先 symlink 后 copy；应用目录副本原子写 | 弱：对账与卸载不验归属；unified 模式会收编 npx 装的目录 | 安装时的内容哈希，看不到本地修改 | 增删投影；对读共享目录的 Agent 无效（#4407、#6343） | 先备份再删 |
| yetone/magpie（`d783df4`） | 库目录 + library.json + applied 账本 | 绝对链接；副本带标记、先写临时目录再换位 | 强：内容相同才接管，不同让用户选 | 目录最后一个 commit + 文件哈希；本地改过拒绝覆盖 | 勾选；读共享目录的 Agent 如实显示“始终可用”（#595） | 挪进备份 |
| runkids/skillshare（0.25.13） | 源目录 + 每个目标的 manifest | 每个技能一个链接 | 中：不在 manifest 的真实目录保留，但会重建别人的链接 | 子目录 tree hash | include/exclude | 进 trash，保留 7 天 |
| xingkongliang/skills-manager（v1.42.1） | 库目录 + SQLite | symlink 或 copy | 强：`ReplacePolicy × TargetState` 决定能否删除 | `git ls-remote` + 子树 | 每个技能 × 每个工具 | 有备份 |
| numman-ali/openskills（v1.5.0，已停更） | 每个技能里的 `.openskills.json` | 只复制；拼接 shell 字符串执行 git | 弱 | 无 | 无 | `rm -rf` |
| ClawHub CLI、Hermes hub | 各自的 lock | 隔离扫描后安装（Hermes）；解压可回滚（ClawHub） | 强（指纹）/ 中 | semver + 指纹反查 / 版本或哈希 | 无 / `skills.disabled` | — |

没有一个项目做到按 Agent 停用：对直接读共享目录的 Agent，删链接没有用，只有写各 Agent 自己的停用配置才有效。

### 1.2 各 Agent 的读取与停用

| Agent | 用户级读取（优先级高到低） | 同名处理 | 原生停用方式 |
|---|---|---|---|
| Claude Code | `~/.claude/skills`（含 `synced/`），插件技能带命名空间 | 多个位置指向同一目标只加载一次 | `~/.claude/settings.json` 的 `skillOverrides: {"<名>": "off"}` |
| Codex | `$CODEX_HOME/skills`（源码注释“已弃用，仍兼容读取”）+ `~/.agents/skills` | 同名不合并，两个都会出现 | `config.toml` 的 `[[skills.config]]`（`name` 或 `path`）`enabled = false`，需重启 |
| Cursor | `~/.agents/skills`、`~/.cursor/skills`，兼容读 `~/.claude/skills`、`~/.codex/skills` | 文档未说明 | 无，只能显示“始终可见” |
| OpenCode | `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills` | 要求名字唯一 | `permission.skill.<名> = "deny"`；`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` 关闭 `.claude` 来源 |
| Gemini CLI | `~/.gemini/skills` 与 `~/.agents/skills`（同层时后者优先） | 高优先级覆盖 | settings 的 `skills.disabled` |
| OpenClaw | workspace > `<ws>/.agents/skills` > `~/.agents/skills`（默认 state 目录时）> `~/.openclaw/skills` > bundled > extraDirs | 最高来源胜出；realpath 必须在根目录内，否则以 `symlink-escape` 跳过 | `skills.entries.<名>.enabled = false` |
| Pi | `~/.agents/skills`、`~/.pi/agent/skills`、settings 的 `skills` 数组 | 先发现者胜出并警告 | settings 数组的 `-path`、`!pattern`（对自动发现的是否生效未确认） |
| Hermes | `~/.hermes/skills` > `skills.create_dir` > `skills.external_dirs`（本机 0.12 不读 `~/.agents/skills`） | 跨层高层胜出；同层内容不同判为 ambiguous | `skills.disabled`、`skills.platform_disabled` |
| DeepSeek Harness | `~/.dsh/skills` + `~/.agents/skills` | 未知 | 只能停用整个 provider 行 |

### 1.3 对 HarnessHub 的启发

- `~/.agents/skills/<名>` 放真实目录；HarnessHub 自己的内容寻址库只用于版本历史和回滚，不要让共享目录里的条目指向它（OpenClaw 会跳过越界链接，vercel 的 add 也会把链接换成真实目录）。
- 只给不读共享目录的 Agent 放置：Claude 用逐个技能的绝对路径链接（不要整目录链接，dotagents #193），不碰 `synced/`、`.trash/`；Hermes 可改为一次性写 `skills.external_dirs`。OpenClaw 原生读共享目录且优先级更高，`~/.openclaw/skills` 里指向共享目录的链接是多余的。Codex、Cursor、OpenCode、Gemini、Pi、DeepSeek Harness 什么都不放。
- 可见性按每条“可见边”建模：机制（native-shared、linked、own-copy、compat-root、external-dir、plugin、bundled、synced）与状态（active、disabled、shadowed、duplicate、ambiguous、rejected、broken-link）。
- `.skill-lock.json`：两份路径都读（XDG 优先）；只在更新或删除已在其中的条目、或用户要求兼容时才写，只写 v3 字段、保留未知字段、原子写，不放 HarnessHub 的状态。不把更新委托给 `skills update`（它不保留 Agent 选择，会发遥测）。
- 更新：上游指纹（tree SHA 或 commit）与本地内容哈希分开；check 只读；本地改过的需要确认才覆盖，替换前列出将被删除的文件。
- 添加：GitHub 用 codeload tarball，解包只接受目录和普通文件、拒绝链接与越界路径、设大小上限，先装进临时目录再 rename；skills.sh 只用 `/api/search` 做发现（未文档化接口，标明不稳定）；本地文件夹可快照或开发链接；同名不同来源返回冲突，不自动改名。
- 删除挪进备份，只删自己建的链接和自己写的停用条目；与 npx skills、cc-switch 共存时，把它们的条目标为“由他人管理”。

## 2. MCP

### 2.1 主要项目

| 项目（读的版本） | 形态 / 许可 | 九个中覆盖 | 数据源 | 写入 | 归属与删除 | 秘密 |
|---|---|---|---|---|---|---|
| farion1231/cc-switch（`77c6dc7`，v4.0.15，2026-10-17） | Tauri 桌面 / MIT | 6（缺 Cursor、OpenClaw、dsh） | SQLite `~/.cc-switch/cc-switch.db`，每个应用一列开关 | 直接改文件；Codex 用 toml_edit、OpenCode 自写 JSONC 往返且落盘前比对；Claude、Gemini 整份重写 | 数据库里有这个 id 就算自己的；外部删除的条目切换时被写回（#3082、#955，维护者称设计取舍） | 明文原样复制到各应用（#6585 未解决），会随云同步带走 |
| yetone/magpie（`d783df4`，2026-10-17） | 桌面加网关 / MIT | 8（缺 OpenClaw） | `library.json` + `Applied` 台账 | 直接改文件；三种格式都保真（JSONC 原字节拼接、YAML 节点、自写 TOML）；原子写保留 BOM/CRLF/权限；每次备份留 30 份 | 台账 + 每种格式的 owned 键表，只改定义服务的键；同名时接管用户条目；每次启动重同步，会覆盖用户手改（#2144） | `envref.go` 按 Agent 翻译变量引用，不支持引用的 Agent 拒绝下发；远程 OAuth 经网关中继 |
| dyoshikawa/rulesync（`f38fece`，v37.1.0） | CLI / MIT | 7（已删 Gemini CLI 目标） | 仓库内 `.rulesync/mcp.jsonc` | JSONC 原地改；TOML/YAML 重写；非原子、无备份；有 `--dry-run`、`--check` | 多数目标整张服务表替换，会删掉用户用官方命令加的服务（#2506 与 PR #2543 正好说明“没有台账只能二选一”） | 部分翻译；#3170：把 `${VAR}` 原样写进 Codex 会失败 |
| tackroom（`b4599f5`，4 star） | CLI / MIT | 9（Pi 需 ≥1.0） | 状态文件 | JSON 重写丢注释；TOML 文本拼接 | 台账；内容一致才认领、一致才删除；漂移时退出 1 | `${}`；Codex 用专用字段 |
| MCPM、Smithery CLI、add-mcp | CLI | 5–6 | 无或全局清单 | 多数整份重写；**解析失败时以空配置继续写**（MCPM 把原文件改名 `.bak` 后用空配置） | 无台账或靠名字前缀 | 明文，或运行时包装（Smithery 用钥匙串加 `run` 包装） |
| 1MCP、mcp-router、ToolHive、Docker MCP Gateway、MetaMCP | 聚合/代理 | 自动接线 0–6 | 各自的配置 | 往客户端写一个聚合入口；1MCP 的 consolidate 整文件替换，mcp-router 删掉 Cursor 里其他服务（已停止支持） | 固定名字 | 集中保管，客户端只见 localhost 或包装命令 |

Smithery 是唯一调用官方 CLI 的安装器，但没有指定 scope，按官方默认 Claude 装到 local、Gemini 装到 project，都不是用户级。

### 2.2 各 Agent 自己的写入器

- Claude Code：运行中的会话会拿内存副本整份回写 `~/.claude.json`（#73364，2.1.198 可复现，标为 not planned）；`claude mcp remove` 会删除该服务的 OAuth token。
- Codex：`codex mcp add` 同名静默覆盖，整表重序列化，HTTP 服务发现 OAuth 时直接开始登录；stdio 只能写字面 `--env`，写不了 `env_vars`、`env_http_headers`。
- Gemini CLI：保存设置时按会话启动时的内存快照删掉多出来的键（`commentJson.ts` 的 `applyKeyDiff`）；`gemini mcp add` 同名覆盖。
- OpenCode：`opencode mcp add` 用 jsonc-parser 保留注释，同名覆盖，没有 remove；未发布的 dev 分支改成 `mcp.servers.<名>`。

### 2.3 值得采用与应避免

采用：
- 台账加条目级语义哈希（算在 owned 键的取值上，不算原始字节，因为 Codex、Gemini、OpenClaw、Hermes 自己写配置时会重排）。
- 只改 owned 键，保留 Agent 或用户加的 `enabled`、`timeout`、`tools.<t>.approval_mode`、`trust`、`sampling` 等。
- 解析失败就中止。按格式选保真编辑；原子写保留权限、属组、BOM、CRLF；rename 前重读比对。
- 按 Agent 翻译变量引用；按 Agent 限制传输方式，明确拒绝而不是静默降级。
- 导入时按定义分组，同名但定义不同的单列；排除 Agent 自带的服务。
- 漂移检查。

避免：
- 把清单当唯一真相反复投影，让外部删除的条目复活。
- 整表或整文件替换；接管用户的同名条目（官方 add 命令本身也会静默覆盖，冲突要由 HarnessHub 先查）。
- 原样复制占位符或把值写进文件；秘密随云同步带走。
- 用会启动或连接服务的命令做发现；调官方 CLI 不指定 scope；恢复备份不检查之后的改动；每次启动跑 `npx …@latest`。

### 2.4 聚合与代理

聚合器避免了每个客户端都配一遍，但带来单点故障、工具过多、按工具的审批变粗、roots 与 OAuth 容易坏、拿不到会话 cwd 等问题（1MCP #641、mcp-router #178、ToolHive #5786、Docker #79）。比较稳妥的分阶段做法：
1. stdio 启动器包装（`hh mcp run <名>`）：各家配置里只写包装命令，启动时从钥匙串取秘密注入，服务名与审批规则不变，只支持 stdio 的 OpenClaw 也能用。
2. 远程服务经本机网关中继，OAuth 只登录一次。
3. 每个 Agent 一个 hub 端点（Magpie #2679 正在做），不能作为默认。

## 3. 指令、子 Agent、命令、Hooks 与插件

### 3.1 主要项目

| 项目（读的版本） | 九个中覆盖 | 指令 | 子 Agent | 命令 | Hooks | 用户级 | 写入与归属 |
|---|---|---|---|---|---|---|---|
| rulesync | 8（无 Gemini CLI） | 整文件生成 | 有，含转 Codex TOML | 有 | 规范事件名，默认整组替换 | 有 | 整文件 + 顶层键；用户级不备份；`--delete` 会删别的工具装的 skill |
| intellectronica/ruler（v0.3.44） | 6 | 整文件拼接 | 4 个 | 拒绝做 | 无 | **不支持** | 生成头 + `.bak` |
| davila7/claude-code-templates（1.30.0） | 1（只有 Claude） | — | 覆盖写入 | 覆盖写入 | 追加不去重 | 部分 | 不记录，没有卸载 |
| cc-switch | 7 | **整文件覆盖，停用即清空**；Hermes 写的是人格文件 SOUL.md | 无 | 只有 Pi | 无 | 有 | 数据库 |
| magpie | 8（无 OpenClaw） | 标记区块，共享文本 + 每个 Agent 的追加 | 中立模型，按 Agent 渲染（Codex 写 TOML） | 无 | 5 个可移植事件，只取出与写入时完全一致的条目 | 有 | 记录 hash；用户改过的归用户；同名但非自己写的不碰 |
| runkids/skillshare（v0.25.13） | skills 9 个 | 区块含 sha256 | 3 个 | 拒绝 | 原生格式，不翻译 | 有 | “内容相同不算归属”；导入只读不执行 |
| Goldziher/ai-rulez（v5.5.1） | 9（深浅不一） | 不碰手写文件 | 有 | 转成 skills | 部分 | 显式开启 | 清单 + 键级归属；转换附有损报告 |

### 3.2 收敛程度

- 指令：项目级的事实标准是 AGENTS.md（agents.md，Agentic AI Foundation），用户级没有统一位置，规范也不定义 `@import`。各家用户级读取不同，且有遮蔽：OpenCode 在没有自己的 AGENTS.md 时读 `~/.claude/CLAUDE.md`；Pi 每个目录只取第一个匹配文件；Codex 的 override 遮蔽 AGENTS.md；Gemini 列出多个文件名时全部拼接、不按 inode 去重。
- 命令：正在并入 Agent Skills（Claude：“Custom commands have been merged into skills”；Codex：“Custom prompts are deprecated”）。转换的坑：Claude 的 `$0` 是第一个参数，OpenCode、Codex、Pi 的 `$1` 才是；Gemini 用 `{{args}}`。
- 子 Agent：主流是 Markdown 加 YAML，只有 Codex 用 TOML；能跨产品保留的只有 name、description 和正文；model 不能原样复制（ruler #790）。
- Hooks：没有标准。Cursor 默认执行 Claude 三个 settings 文件里的 hooks，且与自己的 hooks 都运行、不去重；Gemini 的 `hooks migrate --from-claude` 有超时单位（毫秒对秒）和事件名的已知缺陷。
- 插件：事实上的交换格式是 Claude Code 插件；Codex 和 OpenClaw 能读它的清单，但会丢掉 agents 和 Claude hooks；Cursor 默认导入 Claude 已装的插件；Gemini 不接受（not planned）。Agent Plugins 1.0 只定义 skills 和 MCP。社区已从“转换插件格式”转向“维护多份原生清单、各用原生 CLI 安装”（obra/superpowers、getsentry/dotagents、skillshare）。

### 3.3 值得采用与应避免

采用：只拥有条目不拥有文件；以写入记录判定归属，用户改过就归用户；先预览再写，提供漂移检查；第一次写入前备份并证明来历，不写穿链接；中立模型只放可移植字段，外加每个 Agent 的覆盖块；不支持的字段或事件要报告；插件交给各 Agent 的原生 CLI；导入只读、只复制，不移动原文件内容。

避免：整文件覆盖用户级指令；在用户级按位置清扫；整键或整组替换 hooks、重复追加不去重；不记录装了什么；静默改变语义的转换；把人格文件当指令目标；把变化极快的外部生成器当运行时依赖；忽略交叉读取和体积上限（Codex 32 KiB）。

## 4. 对 HarnessHub 的启发

1. 没有可以直接采用的项目。最接近的是 magpie（用户级、标记区块、台账、owned 键、按 Agent 翻译变量引用）与旧仓库 HarnessHub 的 Library（预览后核对、首次写入前备份、字节还原）。
2. 能力分三档：
   - 集中管理：技能、MCP、指令（区块）。
   - 显式确认后复制并转换：子 Agent、命令（优先转成技能）、少量有官方映射的 hooks。
   - 只读：插件（装卸交给各家 CLI）、大部分 hooks、不在磁盘上的 Cursor 用户规则、Hermes 的 SOUL.md。
3. 统一视图要按“谁读什么”的声明表计算各 Agent 的生效集合，并给出四类提示：重复、遮蔽、交叉读取、不可见；每个条目标出归属（用户、HarnessHub、插件、其他管理器）。
4. 本机装有 cc-switch，它整文件覆盖指令、以自己的数据库为准写 MCP。HarnessHub 要识别并提示“同一个文件只交给一个工具管”，未经确认不接管、不删除其他管理器的条目。

## 来源

主要仓库（读的 commit 见上表）：
- https://github.com/vercel-labs/skills 、https://github.com/numman-ali/openskills 、https://github.com/xingkongliang/skills-manager 、https://github.com/getsentry/dotagents 、https://github.com/openclaw/clawhub 、https://github.com/agentskills/agentskills 、https://github.com/cloudflare/agent-skills-discovery-rfc
- https://github.com/farion1231/cc-switch
- https://github.com/yetone/magpie
- https://github.com/dyoshikawa/rulesync
- https://github.com/intellectronica/ruler
- https://github.com/davila7/claude-code-templates
- https://github.com/runkids/skillshare
- https://github.com/Goldziher/ai-rulez
- https://github.com/pathintegral-institute/mcpm.sh
- https://github.com/arcadeai-labs/smithery-cli
- https://github.com/neon-solutions/add-mcp
- https://github.com/1mcp-app/agent 、https://github.com/mcp-router/mcp-router 、https://github.com/stacklok/toolhive 、https://github.com/docker/mcp-gateway 、https://github.com/metatool-ai/metamcp
- https://github.com/yourconscience/tackroom 、https://github.com/amtiYo/agents
- https://agents.md 、https://agentskills.io 、https://agent-plugins.org
- https://github.com/obra/superpowers
- 官方：code.claude.com/docs/en/{mcp,skills,hooks,sub-agents}、cursor.com/docs/{context/subagents,cli/using,reference/third-party-hooks}、opencode.ai/docs/{rules,skills,agents}、learn.chatgpt.com/docs/{agent-configuration/subagents,custom-prompts.md}、github.com/openai/codex/pull/12660
