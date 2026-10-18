# ADR-045：统一管理各 Harness 的能力（技能、MCP、指令、子 Agent、命令、Hooks、插件）

状态：accepted，2026-10-18。审批代理的裁决见文末，与正文冲突时以裁决为准。

## 背景

- **用户要求**（2026-10-18）：完成技能、MCP 等能力的集成与统一配置。用户在选项中确定了四点：
  - 技能沿用 `~/.agents/skills`，并能统一管理所有 Harness 的技能；
  - MCP 由 HarnessHub 统一管理；
  - 只改用户级（全局）配置；
  - 还包括指令文件、插件与扩展、子 Agent 与自定义命令、Hooks。

  用户要求实现前先调研 GitHub 上的同类项目。
- **调研**：
  - [九个 Harness 的扩展能力配置](../research/native-extension-configs-2026-10-18.md)：本机版本的位置、格式、官方命令与写入风险。
  - [跨 Agent 统一管理能力的开源做法](../research/capability-managers-2026-10-18.md)：vercel-labs/skills、cc-switch、magpie、rulesync、skillshare 等。
- **推翻的旧决定**：[ADR-026](0026-native-extensions.md) 只做了只读视图，并否决了“由 Hub 写技能或 MCP 配置”。本 ADR 在“只改用户级、每次写入先预览并经用户确认”的前提下改变这一点。
- **已有前身**：旧仓库 HarnessHub 的 Library（`packages/agents/src/library/`）。它的做法与本 ADR 一致：先预览，确认后备份、原子写、回读校验，只认领自己写入的部分。但它的写入位置有几处与本机版本不符，台账也只记名字。

## 约束

- **只改用户级配置**：不写项目文件，不改模型、Provider 和登录配置（沿用“不修改全局模型配置”）。
- **开发与测试只用临时家目录**（仓库 AGENTS.md：不改用户真实 Harness 配置）。对用户真实配置的写入，只在用户点击并确认后执行。
- **密钥值不进入页面、日志、仓库与 HarnessHub 的存储**：页面只显示变量名，以及“已设置 / 未设置”。
- **不运行会启动或连接 MCP 服务器的命令**做发现（如 `claude mcp list/get`、`gemini mcp list`、`opencode mcp list`）。
- **会重启 OpenClaw Gateway 的操作**（本机版改 `mcp.*`、`plugins.*`）：确认框必须写明飞书、微信等频道会断开，只由用户点击。

## 决定（提案）

### 1. 一个“能力”页面

- **入口**：侧栏在“我的 Agent”与“设置”之间新增“能力”。
- **页签**：技能、MCP、指令、子 Agent、命令、Hooks、插件。
- **矩阵**：每页一张“条目 × Harness”矩阵，只列 ADR-044 认可的官网安装。每个格子写清可见机制与状态，并标出条目的来源与归属：用户、HarnessHub、插件、内置，或其他管理器（vercel skills、cc-switch、magpie 等）。
- **提示**：四类——重复（同一技能被看到两次）、遮蔽（新建文件会让另一个文件失效）、交叉（Cursor 也会运行 Claude 的 Hooks）、不可见（Cursor 的用户规则不在磁盘上）。
- **Harness 详情页**：原来的“技能 / MCP / 插件（只读）”改为同一模型下这个 Harness 的视图。

### 2. 发现：只读文件，按声明表计算

- **“谁读什么”表**：每个 Harness、每个版本范围一张，格式参照 `catalog-channels.ts`，并写明证据。内容包括：
  - 技能的读取位置、优先级、同名规则和原生停用方式；
  - MCP 的文件、格式、密钥写法、支持的传输方式，以及有没有可用的官方命令；
  - 指令文件的选择规则；
  - 子 Agent 与命令的目录和格式；
  - Hooks 的位置；
  - 插件状态文件的位置；
  - 影响位置的环境变量（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`HERMES_HOME`、`OPENCLAW_STATE_DIR`、`PI_CODING_AGENT_DIR`、`DSH_HOME`）。
- **扫描**：
  - 读法：用 lstat 读条目，跟随链接取 realpath，解析 frontmatter，算内容哈希；配置文件用容错解析器读（JSONC、TOML、YAML、JSON5）。
  - 解析失败的文件标为“无法读取”，不猜。
- **可见边**：每条边由三部分组成——
  - 机制：native-shared、linked、own-copy、compat-root、external-dir、plugin、bundled、synced；
  - 状态：active、disabled（写明原生机制）、shadowed、duplicate、ambiguous、rejected、broken-link、invalid；
  - 证据。
- **来源追溯顺序**：HarnessHub 台账 → `.skill-lock.json`（XDG 优先）→ ClawHub 与 Hermes hub 的 lock → 链接目标所在的管理器目录（例如 `~/.cc-switch/skills`）→ 其他管理器的标记 → 插件 → 内置 → 用户。

### 3. 写入的共同规则

1. **计划 → 确认 → 应用。**
   - 计划按 Harness 列出每个文件的改动（密钥打码）和将要执行的命令。
   - 应用前重新读取并比对目标条目或子树，有变化就返回 409，该 Harness 什么都不写。`~/.claude.json` 只比对目标子树，因为运行中的会话会频繁改写它。
2. **安全写入。**
   - 每个文件第一次被改动前，把原字节备份到数据目录（0600）。
   - 用临时文件加 rename 原子写入，保留权限、BOM 和换行符。
   - 写后按语义回读校验。
   - 文件解析失败就中止，绝不以空配置写回。
   - 目标是符号链接时拒绝写入，并说明原因。
3. **台账。**
   - 记录 HarnessHub 写入的每个条目：类别、Harness、位置，以及 owned 键取值的语义哈希。
   - 重写条目时只改 owned 键，保留 Agent 或用户加的键。
   - 每次同步做三方比较：期望值、上次写入值、当前值。
     - 外部删除的条目不复活，标为“已被外部移除”，由用户选择重新应用或取消。
     - 用户改过的条目从此归用户。
     - 同名但不在台账里的条目不覆盖；只有定义完全一致时，才能经用户确认后认领。
4. **运行中的程序。**
   - Claude、Gemini：写前检测有没有运行中的会话，提示重启，并在写后复查。
   - Hermes：说明要 `/reload-mcp`、`/reload-skills`，或重启 `hermes acp`。
   - Codex：说明要重启。
   - OpenClaw：同一批改动合并成一次写入。
5. **与其他管理器共存。** 其他管理器的条目标为“由他人管理”，未经确认不接管、不删除；页面提示“同一个文件或条目只交给一个工具管理”。

### 4. 技能

- **共享目录**：`~/.agents/skills/<名>` 是唯一实体，放真实目录。HarnessHub 在数据目录保存按内容寻址的快照，只用于回滚。
- **放置**：
  - Claude：建逐个技能的绝对路径链接 `~/.claude/skills/<名>` → `~/.agents/skills/<名>`，不碰 `synced/`、`.trash/`。
  - Hermes：二选一，待裁决——一次性写 `skills.external_dirs: [~/.agents/skills]`，或逐个技能建链接。
  - OpenClaw：不放，它原生读共享目录。
  - Codex、Cursor、OpenCode、Gemini、Pi、DeepSeek Harness：不放。
- **按 Harness 停用**：写各家自己的停用配置。

  | Harness | 停用方式 |
  |---|---|
  | Claude | `skillOverrides` |
  | Codex | `[[skills.config]] enabled = false` |
  | Gemini | `skills.disabled` |
  | OpenCode | `permission.skill` 设为 `deny` |
  | OpenClaw | `skills.entries.<名>.enabled` |
  | Hermes | `skills.disabled` |
  | Pi | settings 数组的排除写法，待本机验证 |
  | Cursor、DeepSeek Harness | 没有开关，如实显示“始终可见” |

- **添加**：
  - GitHub 来源用 codeload tarball 下载。解包只接受目录和普通文件，拒绝链接与越界路径，设大小上限，按 agentskills 规范校验；先装进临时目录，再 rename 进共享目录。
  - 本地文件夹：快照，或开发链接。
  - skills.sh 只用搜索接口做发现，界面上标明它是未文档化接口。
  - 同名不同来源：返回冲突，不自动改名。
- **更新**：
  - 上游指纹（tree SHA 或 commit）与本地内容哈希分开记录。
  - 检查只读；更新要确认，本地改过的要单独确认，替换前列出将被删除的文件。
- **删除**：挪进备份；只删自己建的链接和自己写的停用条目。
- **`.skill-lock.json`**：两份路径都读。只在更新或删除已在其中的条目时写；写入只用 v3 字段，保留未知字段，原子写，不放 HarnessHub 的状态。
- **重复的处理**：
  - OpenCode、Cursor 经 `~/.claude/skills` 会看到第二份。OpenCode 可以用 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` 关掉 `.claude` 来源，是否采用、作用范围待裁决。
  - Codex 同时读 `~/.codex/skills`，同名的两份都会出现，要提示。

### 5. MCP

- **清单**：HarnessHub 保存每个服务的定义：名称、传输方式、command/args 或 url、cwd、环境变量名与 header 的变量引用、每个 Harness 的覆盖，以及勾选的 Harness。不保存密钥值。
- **各 Harness 的写法**：

  | Harness | 写法 | 变量引用 | 传输限制 |
  |---|---|---|---|
  | Claude | 官方命令 `claude mcp add-json <名> '<json>' -s user` / `claude mcp remove <名> -s user`；更新时先删后加，远程服务会丢 OAuth，要提示 | `${NAME}` | stdio、http、sse |
  | Codex | 保真编辑 TOML。不用 `codex mcp add`：它写不了变量名字段，同名静默覆盖，HTTP 会自动开始 OAuth | `env_vars`、`bearer_token_env_var`、`env_http_headers` | 不支持 SSE |
  | Cursor | 保真编辑 `~/.cursor/mcp.json`；可选再执行 `cursor-agent mcp enable <名>`；要说明编辑器也会用这个文件 | `${env:NAME}` | — |
  | OpenCode | 保真编辑 JSONC 的 `mcp.<名>` | `{env:NAME}` | — |
  | Gemini | 保真编辑 JSONC | `${NAME}`；`env` 里要显式写出 | — |
  | OpenClaw | 官方命令 `openclaw mcp set/unset`，合并成一次写入，确认框写明 Gateway 会重启 | `${NAME}`（本机版是否支持待确认） | 只支持 stdio |
  | Hermes | 保真编辑 YAML，保留 Hermes 自有的键 | `${NAME}`，值在 `~/.hermes/.env` 或用户环境 | 不支持 SSE |
  | Pi | 本机 0.85.1 不支持；检测到 ≥0.99 才写 | — | — |
  | DeepSeek Harness | 在 `cordis.patch.yml` 插入一条带标记的独立行，id 前缀 `harnesshub-mcp-` | `!!js process.env.NAME`，NAME 严格校验 | 不支持 SSE |

- **导入**：把各 Harness 已有的服务按定义分组导入清单，同名但定义不同的单列。导入不改 Agent 配置。发现明文密钥时只提示，不移动值。
- **环境变量**：页面显示每个服务需要的变量名，以及它们在 HarnessHub 服务进程环境里是否已设置。设置变量的方式交给用户。
- **以后再做**：启动器包装（`hh mcp run <名>` 从钥匙串取值注入）与本机中继，不在本 ADR 的步骤内。

### 6. 指令

- **内容**：一份共享指令，加每个 Harness 的追加文本。
- **写入方式**：以 `<!-- harnesshub:begin id=… sha=… -->` 区块写进各 Harness 实际生效的用户级指令文件，区块外的内容不动。
- **遮蔽检查**：
  - OpenCode：已在回退读 `~/.claude/CLAUDE.md` 时，新建它自己的 AGENTS.md 会让回退失效，要先让用户选择。
  - Pi：已有 CLAUDE.md 就写进 CLAUDE.md。
  - Codex：override 文件存在时给出警告。
  - Gemini：按 `context.fileName` 选文件。
- **各 Harness 的目标**：
  - Hermes 不写 SOUL.md。
  - OpenClaw 写 agent workspace 里的 AGENTS.md，路径用官方命令读出。
  - Cursor 的用户规则不在磁盘上，只做说明。
- **体积**：超过 Codex 的 32 KiB 等上限时给出警告。

### 7. 子 Agent 与命令

- **子 Agent**：
  - HarnessHub 定义一个中立模型，只放 name、description、正文，外加每个 Harness 的覆盖块；按 Harness 渲染给 Claude（md）、Codex（toml）、Gemini（md）、OpenCode（md，`mode: subagent`）。
  - Cursor 默认不写，因为它读 Claude 和 Codex 的子 Agent。Pi、Hermes、OpenClaw、DeepSeek Harness 标为不支持。
  - 整个文件按台账里的哈希认领。
  - 从某个 Harness 复制到其他 Harness 时，预览字段映射和丢失项；model 默认不复制。
- **命令**：
  - 优先转成技能（Claude、Codex 官方都写着命令已并入技能或已弃用）。
  - 对仍读原生命令的 Gemini（toml）、OpenCode、Pi 做“复制并转换”，预览占位符的转换：Claude 的 `$0` 是第一个参数；Gemini 用 `{{args}}`。

### 8. Hooks

- 只读视图：按 Harness 列出会运行的 Hooks 及来源，并标出交叉执行（Cursor 默认也运行 Claude 的 Hooks；插件里的 Hook 与 settings 里的相同 Hook 不去重）。
- 本 ADR 的步骤里不写 Hooks。

### 9. 插件

- 按 Harness 列出已装插件及其启停状态。
- 装卸和启停委托给各家的官方命令：
  - Claude：`claude plugin … --scope user --json`
  - Codex：`codex plugin add/remove`
  - Gemini：`gemini extensions …`
  - OpenClaw：`openclaw plugins …`，确认框写明 Gateway 会重启
  - Pi：`pi install/remove`
  - Hermes：`hermes plugins …`
  - DeepSeek Harness：`dsh plugin --profile …`
  - OpenCode：只有添加；删除只删 HarnessHub 自己加进 `plugin` 数组的条目
  - Cursor：只读，提示在会话里用 `/plugin`
- 标出交叉使用：Cursor 默认导入 Claude 已装的插件；Codex 和 OpenClaw 能读 Claude 的插件清单，但会丢掉其中的 agents 和 hooks。

### 10. 存储

- 新的独立存储 `data/capabilities/capabilities.sqlite`（schema v1），保存清单、台账、备份索引和计划；数据目录下另存技能快照与文件备份。
- 旧构建不读这个文件，所以不需要降级脚本；回退时只是忽略它。

### 11. 依赖（提案）

- `jsonc-parser`：编辑 JSONC 和 JSON（Claude 以外的 JSON 文件），保留注释。
- `yaml`：Document API，用于 Hermes 与 DeepSeek Harness；要支持 `!!js` 自定义标签往返。
- TOML：在 `smol-toml` 解析校验的基础上，移植旧仓库 Library 的定点编辑器，只改 `[mcp_servers.<名>]` 和 `[[skills.config]]`。
- `json5`（已有）：只读解析 OpenClaw；写入走官方命令。

## 步骤

1. **统一视图（只读）**：七类能力的发现、“谁读什么”表、可见边与四类提示、能力页面，以及 Harness 详情页的能力小节。
2. **技能管理**：放置、按 Harness 停用、添加、更新、删除、与 lock 互操作。
3. **MCP 统一清单**：导入、写入、三方比较。
4. **指令区块。**
5. **子 Agent 与命令。**
6. **插件装卸**（官方命令）。
7. **以后**：HarnessHub 自己的 Hooks，MCP 启动器包装与中继。

每一步都在临时家目录里经正式入口验证，第一次真实写入由用户在页面上点击。

## 影响

- 取代 ADR-026 的“否决方案：由 Hub 写技能或 MCP 配置”。ADR-026 的只读面板并入能力页面。
- 旧仓库 Library 的经验与代码（格式保真编辑、计划与应用）可以移植，写入位置以本 ADR 的表为准。

## 本机核实（2026-10-18，第 1 步之前）

- **OpenCode 1.18.35 的同名技能**：源码 `packages/opencode/src/skill/index.ts` 与 v1.18.35 标签逐字节一致。
  - 发现阶段：先收集 `~/.claude/skills`、`~/.agents/skills`（以及项目目录、配置目录、`skills.paths`）下所有 `SKILL.md` 的路径。用的是 glob 返回的路径，不是 realpath，所以经链接指向同一处的两份也算两条。
  - 加载阶段：以 `concurrency: "unbounded"` 逐个解析，后写入的同名技能覆盖前一个，并记 `duplicate skill name` 警告。
  - 结论：同名技能在 OpenCode 里只保留一份，保留哪一份取决于解析完成的先后，不确定。
- **OpenClaw 2026.3.23-2 的技能来源**：本机程序 `dist/skills-M0AZJeXx.js`。
  - 读取位置：extraDirs 与插件目录、bundled、`~/.openclaw/skills`、`~/.agents/skills`（总是读，用的是 `os.homedir()`）、`<workspace>/.agents/skills`、`<workspace>/skills`。
  - 优先级：按上面的顺序合并，后面的覆盖前面的。
  - 越界跳过：技能目录或 `SKILL.md` 的 realpath 不在所属根目录内时跳过，并警告 “Skipping skill path that resolves outside its configured root.”（`filterLoadedSkillsInsideRoot`）。所以 `~/.openclaw/skills` 里指向 `~/.agents/skills` 的链接会被跳过，这些技能实际从 `~/.agents/skills` 加载。

## 审批代理的裁决（2026-10-18）

1. **步骤与第 1 步**：同意先做只读统一视图。第 1 步必须交付带证据与版本区间的“谁读什么”表；OpenCode 1.18.35 对同名技能（两个根目录各一份）的实际行为要按源码核实后写进表里，“重复”状态反映真实行为。
2. **Hermes**：用 `skills.external_dirs`。
   - YAML Document API 保留注释；先预览、确认、首次备份。
   - 写后说明：长驻进程要 `/reload-skills` 或重启；QQ 网关重启后才生效，HarnessHub 不重启它。
   - 现有 31 个链接不动。“清理多余链接”是单独确认的动作，只删指向 `~/.agents/skills` 的链接，并提示 `npx skills` 以后可能重建它们。
3. **OpenClaw 技能**：
   - 清理 52 个多余链接单独确认，只删指向共享目录的。
   - 停用用 `openclaw config set skills.entries.<名>.enabled false`（skills 热更新，不重启 Gateway）。
   - 确认框写明 OpenClaw 会把 openclaw.json 以 JSON 整份重写、注释丢失；先只读检测文件里有没有注释，没有就不提。
4. **OpenCode 的重复**：默认不注入 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`，以免 Hub 与终端行为不同。视图如实显示重复及原因，并说明用户可以自己在终端环境里设置。用户以后明确要求时，再做成默认关闭、标注“仅 HarnessHub 会话”的开关。Cursor 只提示。
5. **`.skill-lock.json`**：同意。写前重读、原子写、只改已有条目、保留未知字段。
6. **按 Harness 停用技能**：同意，附硬条件。
   - 这些文件同时存放模型配置，所以计划阶段要显示精确的字节 diff，应用后的实际 diff 必须与计划一致，否则记失败并提供恢复备份。
   - 夹具测试用含模型键与注释的文件，证明其他内容逐字节不变。
   - Pi 在官网安装存在并验证前不提供停用；Cursor、DeepSeek Harness 显示“始终可见”。
7. **MCP 密钥**：只存变量名，不做钥匙串。不支持变量引用的目标一律拒绝写入，绝不落明文。
8. **Claude 的 MCP**：用官方命令，写后语义复查并提示重启会话。复查发现写入被运行中的会话冲掉时，标“写入丢失”，提供“无会话运行时重新应用”，不自动重试。
9. **OpenClaw 的 MCP 与插件装卸**：推迟到 OpenClaw 升级并重新核实之后。本机版改 `mcp.*` 会重启网关、只支持 stdio，还会把 JSON5 改写成 JSON；用户当前 OpenClaw MCP 为 0。第 3 步里 OpenClaw 只读并注明原因，声明表按版本区间留位。`plugins.*` 同样会重启，装卸一并推迟。
10. **指令**：同意。
    - Hermes 显示“不支持用户级指令（SOUL.md 是人格文件，不写）”。
    - 检测到文件由 cc-switch 管理时拒绝写入区块，除非用户确认并被告知 cc-switch 会整文件覆盖。
11. **子 Agent、命令、Hooks、插件**：同意。转换附有损报告，model 不复制；Pi 未安装时跳过；OpenClaw 插件见第 9 条。
12. **依赖**：同意，精确锁定、发布满两周、登记许可。移植的 TOML 定点编辑器要有 Codex 真实形态的夹具测试（表数组、注释、模型键不变）。
13. **真机验证**：
    - 第 1 步的验收口径：数量与本机统计一致——技能 68/63/31/52/28，MCP 5/4。
    - 第 2 步第一次真实写入：对 Claude Code 停用一个由用户指定的技能再恢复，核对 settings.json 的 diff 只含 `skillOverrides`。第二次才是 Hermes 的 `external_dirs`。

**全局补充**
- 备份有界：每个文件保留最近 10 份，可以在界面列出并恢复；恢复前比对此后有没有外部改动。
- 所有外部 CLI 调用（`claude mcp`、`openclaw config get/set`、`gemini skills` 等）带期限、无网络，不运行会连接 MCP 的命令。
- 任何写入都不触发 OpenClaw Gateway 与 Hermes 网关重启。
- ADR-026 的否决条标注被本 ADR 取代，以及取代的前提。
- `capabilities.sqlite` v1 独立，旧构建忽略它，可以不配降级脚本。

## 第 1 步实现记录（2026-10-18）

- **已实现**：只读统一视图。
  - `GET /api/v1/capabilities` 返回七类能力的条目、每个 Harness 的可见边与提示，以及“谁读什么”表的版本核实情况。
  - 侧栏“能力”页：七个页签，每页一张“条目 × Harness”矩阵，展开看位置、原因和提示；可按名称搜索、只看一个 Harness、只看有提示或未生效的条目。
  - Harness 详情可以直接打开按这个 Harness 过滤的能力页。
  - 验收见[能力视图验收](../verification/capabilities-view-2026-10-18.md)。
- **实现中的取舍**（正文没写或与正文不同的地方）：
  1. **OpenClaw 的读取**：按决定 11 以 JSON5 只读解析 `openclaw.json`，与 OpenClaw 驱动读模型的做法一致，不运行 `openclaw config get`。配置用了 `$include` 时，说明里写明被包含的文件没有读取。
  2. **Claude 的同步技能**：本机 2.1.302 程序把 `~/.claude/skills/synced/<org>_<account>/` 下的技能作为账户同步的技能（`syncedSkills`）加载，机制与归属都记为“账户同步”。它和本机同名技能都会加载，用名字调用时用哪一份没有文档，所以两份都显示生效，另给重复提示。
  3. **Codex 的系统技能**：`~/.codex/skills/.system` 是随程序安装的技能，记为“内置”。
  4. **Cursor 的同名技能**：文档没有说明怎样处理，同名的每一份都标“重复”，原因写明“没有说明”。正文的 `ambiguous` 状态没有单列，由“重复”加原因表达。
  5. **共享目录里的链接**（开发链接）：Harness 是从共享目录读到它的，机制记为“共享目录”。
  6. **家目录路径**：来自用户文件的说明、名称、匹配条件等文字里出现家目录时换成 `~`。服务端的隐私检查保留为兜底，避免一条说明让整页失败。
  7. **ADR-026 的面板**：对话输入框旁的“原生扩展”弹层继续用于在对话中填入技能命令，完整的只读视图在能力页。Harness 详情不内嵌矩阵，改为打开过滤后的能力页。
  8. **Gemini 的指令文件**：`context.fileName` 写了多个文件名时，每个存在的文件都读。
- **本机统计的对照**（审批第 13 条，详见验收记录）：
  - 原统计按目录数计，视图按“含 SKILL.md 的技能”计，差异都有具体原因：
    - `~/.agents/skills` 的 68 个目录里，`playwright-cli` 顶层没有 SKILL.md（只有 OpenCode 的递归读取找到它里面嵌套的技能），另有一个指向项目目录的开发链接。
    - `~/.claude/skills` 的 63 个链接里，有一个指向上面那个没有 SKILL.md 的目录。
    - `~/.codex/skills` 的 28 项里，`.system` 是 5 个内置技能，`codex-primary-runtime` 没有 SKILL.md。
  - Hermes 的 31 个链接、OpenClaw 的 52 个多余链接，以及 MCP 的 Codex 5 个、Cursor 4 个与原统计一致。

## 第 2 步实现记录：写入框架与技能开关（2026-10-18）

- **已实现**：
  - 写入框架按决定 3：检查（显示文件与精确差异、现有设置由谁写的、提示）→ 确认（15 分钟、单次、commandId 幂等）→ 再读比对 → 备份原字节（每个文件留最近 10 份，可在页面恢复）→ 原子替换 → 回读校验。校验要求写入的字节与计划一致，解析后除目标设置外完全相等，且目标值符合预期；否则记失败并提供恢复。
  - 目标是符号链接或有其他硬链接时拒绝写入；配置文件无法解析时拒绝，绝不以空配置写回。
  - 各 Harness 的技能开关按决定 4 的表实现；Cursor、Pi、DeepSeek Harness 显示“始终可见”，不提供开关。
  - 存储按决定 10：`capabilities/capabilities.sqlite`（v1）保存修改记录、备份索引与台账，带所有者代际防护。
  - 页面：展开技能后按 Harness 显示“停用 / 启用”（Codex 按每一份），确认框显示红绿差异；结果可一键恢复；页面底部列出“修改与备份”。
  - 验收见[技能开关验收](../verification/capability-switches-2026-10-18.md)。
- **实现中的取舍**：
  1. **台账与“谁写的”**：只记录 HarnessHub 自己写入的值及其原值。启用时，若台账表明现在的“关”是 HarnessHub 写的，就恢复原值（例如 Claude 原来的 `user-invocable-only`），否则删除并提示“不是 HarnessHub 写的”。同一设置再次写入时，只有被替换的仍是 HarnessHub 自己的值，才保留它第一次写入前的原值（例如 OpenCode 先写 `deny`、启用时改写 `allow`，原值仍是用户最初的值）；否则说明有人改过，原值换成这次写入前的值：用户把 HarnessHub 写的 `off` 改成 `on` 后再重新应用，之后启用会改回 `on`，而不是更早的 `user-invocable-only`（2026-10-18 随漂移检查调整，审批代理确认）。
  2. **OpenCode**：写进最后一个存在的配置文件，规则移到末尾，保证“最后匹配者胜”。启用时只撤回 `deny`，用户自己写的 `allow`、`ask` 不删；仍被其他规则拒绝时写入 `allow`。更早的配置文件无法解析时，因为无法判断最终权限而拒绝。
  3. **Codex**：按官方文档，以 SKILL.md 的完整路径停用某一份；显示的差异把家目录写成 `~`，写入的是完整路径。
  4. **OpenClaw**：本机 2026.3.23-2 的 `config set` 会补上它自己的默认项（实测加了 `commands` 与 `meta`），`--dry-run` 看不到结果。所以检查阶段先把 openclaw.json 复制到私有临时状态目录，在沙箱（只可写该目录、禁网）里对副本运行同一条官方命令，显示真实差异；应用时在只可写 `~/.openclaw`、禁网的沙箱里运行，回读后与预演结果比对，只忽略 `meta.lastTouchedAt`。另外，方括号路径会把引号写进键名，改用点号路径；名字含点号的技能对 OpenClaw 拒绝并说明原因。
  5. **密钥打码**：显示的差异与记录里存的差异都会替换凭据：名字像凭据的键的值、常见令牌形态、`--token` 一类参数、URL 的账号与查询串。变量引用、数字、布尔值保留。没有特征的密钥仍可能出现在上下文行里。
  6. **Hermes**：本步只写 `skills.disabled`。`skills.external_dirs` 的放置属于下一部分，仍按审批第 2 条，在 Claude 的第一次真实写入之后进行。
- **第一次真实写入**：按审批第 13 条，由用户在页面上对 Claude Code 停用一个自己指定的技能再恢复，核对 `settings.json` 的差异只含 `skillOverrides`。

## 第 2 步实现记录（续）：共享目录、逐个放置与清理多余链接（2026-10-18）

- **已实现**：
  - Hermes：在 `skills.external_dirs` 里加上或去掉 `~/.agents/skills`，按审批第 2 条。检查里写明 Hermes 会多看到哪些技能，以及网关与长驻进程何时生效；现有链接不动。
  - Claude Code：为看不到的共享技能建绝对路径链接 `~/.claude/skills/<文件夹>`；只移除 HarnessHub 放置的（台账记录），别人建的链接留给“停用”。
  - 清理多余链接（审批第 2、3 条）：Hermes、OpenClaw 自己目录里指向共享目录的链接。单独确认，只删指向 `~/.agents/skills` 的；Hermes 要先读取共享目录，否则不提供。
  - 撤销：链接改动按记录撤销，删掉当初建的、放回当初删的；放回时沿用当初的目标写法，相对路径仍是相对路径。
  - 页面：技能页签上方是“共享技能目录”卡片，写明各 Harness 怎样读取、自己目录里有几个链接、其中几个多余，并提供上述操作；技能详情里有“放到 Claude Code”和“从 Claude Code 移除（HarnessHub 放置的）”；历史里的链接改动可以撤销。
  - 验收见[放置与清理验收](../verification/capability-placement-2026-10-18.md)。
- **实现中的取舍**：
  1. **按各家规则找技能**：Hermes（本地目录与 external_dirs）用 `os.walk(followlinks=True)`，每个 SKILL.md 都算，包括技能文件夹里嵌套的，只跳过 `.git/.github/.hub/.archive`，隐藏目录也读；OpenCode 的 glob 也是每个 SKILL.md 都算，但跳过隐藏目录。视图原来对它们按“含 SKILL.md 的文件夹算一个、不再往下”计算，现已改为与它们一致。改后本机 Hermes 计数 163，与它自己的遍历相同。
  2. **YAML 的写法**：以 `~` 开头的值写成带引号的 `"~/.agents/skills"`，YAML 一定把它读成字符串。
  3. **链接改动不留文件备份**：要撤销所需的，是每个链接的路径和当初写的目标，都记在修改记录里。
  4. **漂移检查**（审批条件）：台账里 HarnessHub 写过的每一项（技能开关的设置、Hermes `external_dirs` 里的那一项、放置的链接），按写入它的开关的读法从文件读回比对。被移除、被改动、文件读不到或无法解析的，页面上显示“已被外部移除 / 已被外部改动 / 文件无法读取，无法核对”。不自动改回：可以“重新应用”（走原来的检查与确认），或“不再跟踪”（只删台账，不改文件；仍是 HarnessHub 写的值时拒绝）。
  5. **台账原值的接续**：漂移后再写入时原值换成这次写入前的值，规则见上一节取舍 1。
