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

## 审批代理对添加、更新、删除技能的裁决（2026-10-18）

设计见正文第 4 节“添加 / 更新 / 删除 / `.skill-lock.json`”，审批代理逐条同意，并附以下条件（均已落实）：

1. **删除时连同别人建的链接一起删**：只扫描声明表里各 Harness 的技能目录，不扫整个家目录；只删 realpath 落在被删文件夹内（含嵌套）的链接；Claude 的 `synced/`、`.trash/` 永不触碰；确认框按“HarnessHub 放置的 / 其他工具建的”分组。
2. **停用设置不随删除清除，但不能隐形**：页面显示为“孤立的停用设置（技能已删除）”，单独清除时走现有开关流程，台账照常跟踪。
3. **统一用 npx skills 的排除规则**：引用 vercel-labs/skills v1.7.2 `13e4063` 的 `src/installer.ts`（`EXCLUDE_FILES = metadata.json`，`EXCLUDE_DIRS = .git、__pycache__、__pypackages__`）。来源记录同时保存上游 tree id（含排除项）与本地副本的 tree id，本地改动以后者为准；确认框写明这些文件不会复制。
4. **快照只保留最近 50 次修改引用的**：页面显示快照数量与总大小，并说明更早的修改无法撤销。
5. **存储升 v2，附降级脚本**，照先例测试降级。
6. **安全补充**：
   - 只访问 github.com、codeload.github.com、api.github.com、objects.githubusercontent.com，重定向到别处即失败；校验证书，不读令牌，不用代理；限额 403 显示恢复时间。
   - 压缩包只接受普通文件与目录；路径段不超过 255 字节，深度有上限；文件夹名为空、`.`、`..` 时拒绝。
   - 确认框列出可执行文件的数量。
   - 暂存目录与 `~/.agents/skills` 在同一文件系统；服务启动时清扫残留。
   - 更新替换的瞬间文件夹短暂缺失，写进已知行为。
   - 文件夹带 `.claude-plugin/plugin.json` 时视图标出，不阻止。
   - lock 写入前后各读一次。
   - 每个动作的第一句说明“只改共享目录和列出的链接与 lock 条目，不改任何 Harness 的模型或登录配置”。

## 第 2 步实现记录（续二）：添加、更新、删除技能与 lock 互操作（2026-10-18）

- **已实现**：
  - **添加**：输入 GitHub 仓库（`owner/repo`、`owner/repo#ref` 或带 `/tree/<ref>/<文件夹>` 的链接）。先读取，列出每个技能的文件数、大小、可执行文件数，以及状态：可添加、已安装（同一来源，请用更新）、同名冲突、不能安装（附原因）。选中的技能进入确认框，确认后写进 `~/.agents/skills/<名>`。
  - **检查更新**：对 HarnessHub 装的技能和 lock 里记了 GitHub 来源的技能，每个“仓库 + ref”调一次 GitHub 的树接口，标出有新版本、已是最新、仓库里已没有、无法检查（附原因），结果保留 10 分钟。其他来源（如 well-known）显示“HarnessHub 不更新这类来源”。
  - **更新**：确认框逐个列出新增、修改、删除的文件，以及 lock 条目的差异。本地改过时阻止，用户选择“覆盖本地改动并更新”后，说明覆盖的文件数。
  - **删除**：确认框列出文件夹，指向它的链接（HarnessHub 放置的、其他工具建的），要删的 lock 条目，以及留在原处的停用设置。
  - **撤销**：添加、更新、删除都可以在“修改与备份”里撤销，每一步只在仍是那次修改留下的样子时进行。
  - **孤立的停用设置**：历史里列出，单独清除走开关检查。
  - **视图**：HarnessHub 装的技能归属显示为 HarnessHub，并附来源；两份 lock 都读，XDG 那份优先。
  - 验收见[添加、更新与删除技能验收](../verification/capability-packages-2026-10-18.md)。
- **实现中的取舍**：
  1. **版本怎样固定**：GitHub 的压缩包链接会重定向到带提交号的 codeload 地址，从这里取得提交号，再下载那个提交的压缩包，不占用树接口的匿名额度。
     - 重定向里没有提交号时，用压缩包全局头里的 comment；两者都有时必须一致，否则拒绝（审批补充）。
     - 更新时核对压缩包里这个文件夹的 tree id 与树接口给的一致，不一致就请用户重新检查（仓库在两次读取之间变了）。
  2. **本地是否改过**：
     - HarnessHub 装的技能，比较文件夹现在的 tree id 与装入时记录的。
     - npx skills 装的技能，按 lock 记的 tree id 向树接口取那个旧版本，去掉排除项后比较。只在检查单个技能的更新时取，状态列表里这一项显示“未知”。
     - 本机只读核对：lock 里 61 个条目中，54 个的本地 tree id 与 `skillFolderHash` 直接相同；vercel-labs/agent-skills 的 3 个因为上游有 `metadata.json` 而不同，按排除规则算进去后才可比。
  3. **lock 的写法**：
     - 用 jsonc-parser 逐字段定点修改，没改的字段一个字节都不动。更新只改 `skillFolderHash`（写树接口给的原始 tree id，与 npx skills 一致）和 `updatedAt`；删除去掉整个条目；撤销逐字段改回。
     - 写前再读比对，写后回读核对；改 lock 之前先把它备份进现有的备份表。
     - HarnessHub 自己添加的技能不写 lock（裁决 5）。
  4. **存储**：
     - `capabilities.sqlite` v2 新增 `skill_sources`（HarnessHub 装的技能的来源记录）和 `skill_undo`（撤销所需的绝对路径、lock 条目与来源记录的前后值）。后者不在修改记录里，因为修改记录会发给页面。
     - 快照不另建表：放在 `capabilities/skills/<tree id>/`（目录 0700、文件 0600、带清单），按内容寻址，由撤销记录引用；只保留最近 50 次修改引用的。
     - 降级用 `tools/capabilities-v2-to-v1.sql`：删除这两张表和技能改动的记录，其他记录保留。
  5. **写入顺序与回滚**：
     - 先核对所有对象仍是检查时的样子，再给要替换或删除的文件夹存快照，然后依次：删链接 → 把旧文件夹移进暂存目录 → 放入新文件夹 → 建链接 → 写 lock。
     - 任何一步失败，按相反顺序回滚已做的步骤。回滚没完成时保留暂存目录并在结果里说明，快照也还在。
     - 暂存目录在 `~/.agents/` 下（与共享目录同一文件系统，但在它之外：Hermes 也读隐藏文件夹）。
  6. **写出的权限**：目录 0755，文件 0644，可执行文件 0755，都显式设置，不受 Gateway umask 077 的影响。
  7. **已知行为**：更新替换的瞬间，技能文件夹会短暂缺失，正在监视技能目录的 Harness 可能看到它消失又出现。
- **未做（不在本步）**：skills.sh 搜索、本地文件夹与开发链接、非 GitHub 来源、私有仓库与令牌、添加时同时放到 Claude Code（确认框与结果里提示可以在技能详情里“放到 Claude Code”）。

## 审批代理对 MCP 统一清单的裁决（2026-10-18）

设计以正文第 5 节为基础，审批代理的裁决如下（均已落实）：

1. **密钥与普通配置分开**：
   - 键名或值命中凭据模式（沿用差异打码的模式）的条目必须是变量引用，否则拒绝；两者都不命中的允许字面值，页面标为“字面值”。误判只能改成变量引用，绝不以存值的方式绕过。
   - 参数含密钥形态的拒绝；地址不得含账号与查询串；`http://` 只允许本机地址，其余必须是 `https://`。
   - 程序不得含 shell 元字符；参数必须是数组；工作目录必须是已存在的绝对路径。
2. **导入时认领一致的条目，需要用户确认**。“一致”指翻译后自有键的语义相等，不是字节相等。
3. **每个 Harness 一张可表达子集表**：Codex 只能同名转发环境变量，请求头只能是 `Authorization: Bearer $VAR`（`bearer_token_env_var`）或无前缀的 `env_http_headers`。任何 Harness 表达不了的组合都阻止并写明原因，不降级、不落明文。
4. **运行中的程序**：
   - Gemini 写前用 `ps` 检测运行中的会话并提示可能被覆盖，写后立即核对；
   - Cursor 提示编辑器共用文件、新服务器可能要在 Cursor 里批准；
   - Codex 提示重启；Hermes 提示 `/reload-mcp`，网关不重启。
5. **分步**：Claude 放在 3b。预演与 OpenClaw 同样的条件：副本放在 0700 的任务目录里，用完删除，启动时清扫；先用真实程序在私有家目录确认 `CLAUDE_CONFIG_DIR` 下 `.claude.json` 的位置；应用后只比对 `mcpServers.<名>` 子树；被运行中的会话冲掉时标“写入丢失”，提供重新应用，不自动重试。DeepSeek Harness 在 3c 按官网版本核实后再接入。
6. **存储升到 v3，附降级脚本**。
7. **安全补充**：
   - 确认框显示完整命令（打码后），并写明“目标 Harness 会以你的身份运行这个程序”。
   - 变量名限 `^[A-Z_][A-Z0-9_]*$`；“是否已设置”只显示布尔值。
   - Codex 的定点编辑覆盖整个表组（`[mcp_servers.<名>]` 及其子表），保留 `enabled`、`startup_timeout_sec`、`tools.*.approval_mode` 等非自有键。
   - 备份文件可能含 Cursor 等处的明文密钥，仍为 0600、每个文件最多 10 份，这里如实写明。
   - 继续不运行任何 MCP 服务器，也不运行 `mcp list/get` 一类命令。
   - 第一次真实写入：把 Codex 现有的一个无密钥服务器导入清单、认领，再经用户确认同步到 Cursor，而不是新建服务器。

## 第 3 步实现记录（3a）：MCP 统一清单（2026-10-18）

- **已实现**：
  - **清单**：HarnessHub 保存服务器的中立定义：传输方式、程序与参数、工作目录或地址、环境变量与请求头。值像密钥的只记变量名，普通设置可以是字面值。清单在 `capabilities.sqlite` v3 的 `mcp_servers` 里，降级用 `tools/capabilities-v3-to-v2.sql`。
  - **导入**：读出各 Harness 用户级配置里的服务器，按“名字 + 定义”归组，同名但定义不同的单列。不能收进清单的写明原因（例如明文密钥、地址带查询串）。导入时可以认领各处与清单一致的条目；认领只记台账（修改记录里是 `mcp-claim`），不改文件。
  - **写入**：每个“服务器 × Harness”一次检查与确认，沿用技能开关的写入框架：精确差异、备份、原子写、回读、语义校验、台账 `mcp/<名>`。
    - Codex：`[mcp_servers.<名>]` 表组。
    - Cursor：`mcpServers.<名>`。
    - OpenCode：最后一个存在的配置文件里的 `mcp.<名>`（`type: local` 的命令数组或 `type: remote`）。
    - Gemini：`mcpServers.<名>`（`httpUrl` 或 `url`）。
    - Hermes：YAML 的 `mcp_servers.<名>`。
    - Claude 与 OpenClaw 只读并说明原因；DeepSeek Harness、Pi 不支持。
  - **状态**：比较清单、台账和文件，每个“服务器 × Harness”显示已写入、一致（可认领）、待更新、同名不同（不覆盖）、被外部改动、被外部移除、未写入或不可写（附原因）。被外部改动或移除的进入漂移列表，经“重新写入”或“重新应用”才写回。
  - **页面**：MCP 页签上方的“MCP 统一清单”。矩阵里每个格子给出能做的一件事：写入、更新、重新写入、认领或移除。另有从现有配置导入、新建与编辑、从清单删除（仍有 HarnessHub 写的条目时拒绝）。所需变量只显示在 HarnessHub 的环境里是否已设置。
  - 验收见 [MCP 统一清单验收](../verification/capability-mcp-2026-10-18.md)。
- **实现中的取舍**：
  1. **没有“目标集合”**：清单不另记“应写入哪些 Harness”，每次写入、移除都是用户在矩阵里点的一个动作，状态由三方比较实时算出。这样外部删除的条目不会因为“应该在那里”而被复活。
  2. **自有键与台账哈希**：每个 Harness 一张自有键表（例如 Codex 是 command、args、env、env_vars、cwd、url、bearer_token_env_var、env_http_headers、http_headers）。台账的哈希只算自有键，按键名排序后再算，Harness 自己重排或用户加了别的键都不算改动。
  3. **定点编辑**：
     - JSON 和 JSONC 逐个自有键修改；
     - YAML 按整行增删条目，删掉最后一个时写回 `{}`，保证仍解析为空映射；
     - TOML 增删整个表组；更新时去掉自有键与自有子表，再在表头后写入新的自有键。自有键跨多行、或子表写在主表前面时，拒绝修改。
     - 每次编辑都校验三点：条目以外没有变化、自有键正是计划的值、用户加的键都在。
  4. **路径显示**：回答里的家目录一律写成 `~`。用户输入时只在开头展开 `~/`；参数中间出现 `~/` 时拒绝，避免改变参数的含义。
- **未做（3b、3c）**：Claude（官方命令与预演）、DeepSeek Harness（patch 行）；OpenClaw 等升级后再接入。
- **3b 的前置核实**（真实程序，私有目录，禁网沙箱）：Claude 2.1.302 的 `claude mcp add-json <名> '<json>' -s user` 把 `.claude.json` 写在 `$CLAUDE_CONFIG_DIR` 下，另写自己的 `backups/` 与 `telemetry/` 记录；全新配置时补 machineID、迁移版本等键。所以 3b 的预演差异要汇总显示 MCP 以外的改动，应用后只比对 `mcpServers.<名>` 子树。
- **真实写入的授权边界**（审批代理，2026-10-18）：用户的“你帮我做，然后接着下一步”是持续授权，无密钥、可撤销、与统一配置直接相关的写入可以由我代为确认执行。以下两类的第一次仍要停下，等用户在页面上点：涉及密钥（变量引用以外）的同步；会触发网关重启或让运行中程序失效的写入。


## 第 3 步实现记录（3b）：Claude Code 的 MCP（2026-10-18）

- **已实现**：MCP 清单可以写入 Claude Code，按裁决 8 和 3b 的预演条件：
  - **命令**：用它自己的命令。没有这一项时 `claude mcp add-json <名> '<json>' -s user`；更新时先 `claude mcp remove <名> -s user` 再 add-json；移除只用 remove。远程服务器更新或移除时，说明里写明会丢掉 OAuth 登录。
  - **预演**：把 `~/.claude.json` 复制进私有的 0700 任务目录，`CLAUDE_CONFIG_DIR` 与 HOME 都指向那里。在沙箱里运行同样的命令（只可写任务目录，禁网），用完删除，服务启动时清扫十分钟前的残留。确认框显示精确差异，并汇总这一项的前后值（打码）和 Claude 自己补的其他键。
  - **应用**：
    - 只比对 `mcpServers.<名>` 这一项与检查时相同（运行中的会话会频繁改写这个文件的其他部分）。
    - 先备份现在的文件，再在沙箱里运行命令。沙箱只可写 `.claude.json` 及它旁边的临时文件、`~/.claude/backups`、`~/.claude/telemetry` 和私有临时目录，禁网，并设置 `DISABLE_AUTOUPDATER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`。
    - 读回时这一项必须与预演相同；不同就记为失败，提供恢复。
  - **写入丢失**：会话之后把旧副本写回、冲掉这一项时，漂移列表显示“写入丢失（可能被运行中的 Claude Code 会话冲掉）”，重新应用时要带 overwrite，不自动重试。
  - **Cursor**：写入 Cursor 前检测运行中的 Cursor（编辑器主进程与 cursor-agent，不算辅助进程），有就提示它可能自行改写 `mcp.json`。远程服务器的说明改用 Harness 的名称。
- **实现中的取舍**：
  1. **沙箱放开的写入**：按真实程序的观察：只放开 `.claude.json` 这一个文件时，Claude 报“was not saved”，因为它经旁边的文件写入。所以按路径前缀放开 `.claude.json*`，并放开它自己的 backups 与 telemetry 目录，不放开整个 `~/.claude`。
  2. **在哪个目录运行**：Claude 启动时会读当前目录，所以命令在私有临时目录里运行。
- **验收**：G064-M4（单元，模拟的 Claude 命令）、G064-M5（本机真实的 Claude Code，私有家目录与禁网沙箱），见 [MCP 统一清单验收](../verification/capability-mcp-2026-10-18.md)。
- **真实环境**（2026-10-18，审批同意）：
  - 经 4317 把 openaiDeveloperDocs 写进真实的 `~/.claude.json`，30 秒后复查仍在。
  - 再用 `claude mcp remove` 移除，文件逐字节回到原样。
  - **决定**：第一次真实写入只做往返验证，最后保持移除，写到哪些 Harness 由用户在页面上决定。

## 第 3 步实现记录（3c）：DeepSeek Harness 的 MCP（2026-10-18）

- **按官网 0.2.0-rc.2 核实**（已安装的程序 `dsh-app-boot`，以及包里的 `docs/user/guide/mcp-memory.md`）：
  - dsh 依次应用各 bundle 的补丁、profile 自己的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`（每个 profile 都会读）。
  - 补丁文件只要存在，就必须是顶层 YAML 数组；否则启动失败（`loadOptionalPatches` → `parsePatchList`）。
  - MCP 服务器是一条 `insert`，`name: '@deepseek-ai/dsh-mcp-client'`，`config` 里有 `serverName`、`transport`（`stdio` 或 `streamable-http`）、`command/args/env/cwd` 或 `url/headers`。
  - 它的 stdio 桥会去掉名字像凭据的环境变量。
  - 客户端的 `serverName` 必须匹配 `^[A-Za-z0-9_-]{1,32}$`。连不上的服务器不会让启动失败（`failOnStartupError` 默认 false），只记警告并按策略重连。
- **已实现**：
  - **读取**：视图与清单读出每个 profile 的补丁和全局补丁里的 MCP 客户端行。`!!js process.env.X` 算作变量引用，`!!js process.cwd()` 等同于不写工作目录；读不了的表达式不能导入，并说明原因。
  - **写入**：写到全局补丁 `~/.dsh/cordis.patch.yml`（每个 profile 都会读，包括 HarnessHub 用的 acp）。每个服务器是一条独立的 `insert`，`id` 为 `harnesshub-mcp-<名>`。
    - 变量都显式写在 `env` 里，写成带引号的 `!!js "process.env.NAME"`；带前缀的请求头写成 `!!js "'Bearer ' + process.env.NAME"`，前缀只允许字母、数字、空格和 `_ : -`。
    - 不支持 SSE。
    - 服务器名最多 32 个字符：清单允许 64 个，超过 32 个的在 DeepSeek Harness 标为不支持并说明原因，不写入。
    - 按整行增删这一条；列表空了就写回 `[]`，绝不留空文件。原来没有的文件新建为列表；按第 4 步裁决第 3 条，HarnessHub 新建的文件在移除最后一个服务器后删除（见第 4 步实现记录），原来就有的回到 `[]`。
    - 用户自己的同名服务器（`id` 不同）不覆盖。
- **验收**：G064-M6（单元），G064-M2 增加的流程与 G064-M3 的名字长度（集成）。写入后的验证不用模型目录读取，因为它会新建一个原生会话。改为两步：
  1. `dsh --profile acp --dump-config`：dsh 按自己的补丁算法合成各层，不启动，不求值 `!!js`。
  2. 只发 ACP `initialize` 启动一次 acp，不新建会话，确认 dsh 能带着这份补丁启动、没有停用或未激活的条目。
- **真实环境**（2026-10-18，审批同意）：
  - 写入、dsh 的合成、启动检查和移除都通过。
  - 启动期间采样到客户端连接服务器（:443），基线没有任何连接。会话里的工具没有验证。
  - 同样往返验证后保持移除，留下 `[]`。
  - **待决（已决，2026-10-19）**：移除最后一行时删掉 HarnessHub 新建的文件；本机留下的 `[]` 由主代理按审批条件手工删除，见第 4 步实现记录。

## 第 4 步设计：指令区块（2026-10-18 提案，2026-10-19 按审批更正事实）

### 本机核实（只读，已装版本）

| Harness | 用户级文件与本机现状 | 什么时候读到改动 | 上限 |
|---|---|---|---|
| Claude Code 2.1.302 | `~/.claude/CLAUDE.md`，不存在 | 新会话。HarnessHub 的会话经 claude-agent-acp 0.89.1 启动（`settingSources: ["user", "project", "local"]`），同样读它 | 无硬上限 |
| Codex 0.162.1 | `~/.codex/AGENTS.override.md` 非空时用它，否则 `AGENTS.md`；本机 override 不存在，`AGENTS.md` 为 0 字节 | 新会话。本机有 ChatGPT 应用和编辑器扩展内置的 Codex 在运行，它们也用 `~/.codex` | 无：用户级文件整读（rust-v0.162.1 `codex-home/src/instructions/mod.rs`）；32 KiB 的 `project_doc_max_bytes` 只限项目里的文件（`core/src/agents_md.rs`） |
| Gemini CLI 0.62.0 | `~/.gemini/GEMINI.md`，0 字节；`context.fileName` 未设置 | 新会话，或会话里 `/memory refresh` | — |
| OpenCode 1.18.35 | `~/.config/opencode/AGENTS.md`，不存在时回退读 `~/.claude/CLAUDE.md`（`session/instruction.ts`）；两个都不存在。只看文件是否存在，空文件也会挡住回退。`OPENCODE_DISABLE_CLAUDE_CODE` 或 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` 为真时不回退（`effect/runtime-flags.ts`） | 每一步都重新读：运行中的会话下一步就用新内容 | — |
| OpenClaw 2026.3.23-2 | 工作区 `~/.openclaw/workspace/AGENTS.md`，7874 字节（OpenClaw 的模板）；工作区是 git 仓库；配置的频道为 `feishu`、`openclaw-weixin` | 网关按会话缓存（`bootstrap-cache`），新会话或会话重置后才读到；不需要重启网关 | 单个文件 20000 字符（`agents.defaults.bootstrapMaxChars`，按 `trimEnd()` 后的长度），超出时保留头尾、把中间换成截断说明（`trimBootstrapContent`）；所有文件合计 150000 |
| DeepSeek Harness 0.2.0-rc.2 | `$DSH_HOME/AGENTS.md`（`dsh-agent-instructions`），不存在 | 每一步之前比对：运行中的会话下一步收到“Updated instructions” | 指令总预算 64 KiB，含项目里的文件 |
| Hermes | 不支持：SOUL.md 是人格文件 | — | — |
| Cursor | 用户规则在应用设置里，不在磁盘上 | — | — |

**cc-switch**（本机装的是 3.15.0，`~/.cc-switch` 存在，当前未运行）。行为按 4.0.15（`77c6dc7`）的 `src-tauri/src/services/prompt.rs` 与 `prompt_files.rs` 读出；本机 3.15.0 的程序里只证实了 `CLAUDE.md`、`AGENTS.md`、`GEMINI.md`、`SOUL.md` 四个文件名，下面其余的文件按 4.0.15 保守列入：
- 启用一个提示词时，把它整份写进对应文件：`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.config/opencode/AGENTS.md`、`~/.openclaw/AGENTS.md`、`~/.hermes/SOUL.md`、`~/.pi/agent/AGENTS.md`。
- 打开提示词列表或切换前，把文件当前的内容回填进已启用的那条提示词。
- 停用最后一条启用中的提示词时，把文件清空成 0 字节。本机 Codex 与 Gemini 的两个 0 字节文件与此一致。
- HarnessHub 不读 cc-switch 的数据库（用户规则），无从知道哪个应用启用了提示词。

### 设计

1. **内容**：
   - 一份共享指令，加每个 Harness 的追加文本（可以为空）。
   - 存在 `capabilities.sqlite` v4 的新表 `instruction_texts`，附降级脚本 `tools/capabilities-v4-to-v3.sql`。
   - 文本校验：
     - UTF-8，换行统一为 LF，每份最多 16 KiB；
     - 不能含 `<!-- harnesshub:` 标记；
     - 不能含家目录的绝对路径，要写成 `~`，与隐私检查一致，不做隐式替换。
   - 保存只改 HarnessHub 自己的存储，不碰任何 Harness 的文件。
2. **区块格式**：
   ```
   <!-- harnesshub:begin id=instructions sha=<正文 sha256 的前 12 位> -->
   正文：共享指令；有追加文本时空一行再接上
   <!-- harnesshub:end id=instructions -->
   ```
   - 每个文件最多一个区块。
   - 第一次写入：追加到文件末尾，与原内容之间空一行。
   - 之后：原地替换。
   - 区块外的字节不变。回读校验：去掉区块和当初加的分隔后，与写入前逐字节相同，区块正文与计划相同。
   - 换行符沿用文件原有的（CRLF 文件写 CRLF），BOM 保留。
   - 区块标记残缺（只有开始或只有结束、开始不止一个、sha 格式不对）时拒绝写入，并说明原因。
3. **移除**：
   - 删掉区块和当初加的分隔。分隔记在台账里，所以文件能回到写入前的字节。
   - HarnessHub 新建的文件，移除后为空时删除文件，回到“不存在”。原因：OpenCode 只看文件是否存在，留下空文件会挡住它对 CLAUDE.md 的回退。
   - 原来就有的文件，哪怕是 0 字节，也只回到原来的字节。
4. **目标文件**：按“谁读什么”表取实际生效的那个。
   - Codex：有非空的 override 时写 override，并提示原因。
   - Gemini：取 `context.fileName` 的第一个名字，已存在的优先。
   - OpenClaw：写当前工作区的 AGENTS.md。
   - 父目录不存在时拒绝：说明这个 Harness 还没有初始化。
5. **状态**（每个目标一个）：
   - 已同步。
   - 可更新：区块是 HarnessHub 上次写的，内容与现在的指令不同。
   - 已被改动：区块正文与标记里的 sha 或台账不符，说明有人改过，归用户。覆盖要单独确认（`overwrite`）。
   - 已被外部移除：台账有记录，文件里没有区块。可以重新写入，或不再跟踪。
   - 未写入。
   - 可认领：文件里有 HarnessHub 区块但台账没有记录；只有内容与现在的指令完全相同才能认领。
   - 不支持：Hermes、Cursor。
6. **OpenCode 的回退**：
   - 它自己的 AGENTS.md 存在：写进这个文件。
   - 不存在，且回退读的 `~/.claude/CLAUDE.md` 有区块外的内容：新建 OpenCode 自己的文件会让回退失效，OpenCode 从此读不到那些内容。检查默认阻止，用户选“新建 OpenCode 自己的文件”（`createOwn`）后才给确认。
   - 不存在，且回退文件不存在或只有 HarnessHub 区块：可以直接新建，确认框写明之后不再回退读 CLAUDE.md。
   - 回退文件里已有 HarnessHub 区块：OpenCode 显示“经 Claude Code 的文件生效”，用的是 Claude Code 的追加文本。
7. **cc-switch**：
   - 条件：`~/.cc-switch` 目录存在（只看是否存在），且目标是 cc-switch 的提示词文件。
   - 这时检查默认阻止，并说明 cc-switch 启用或切换提示词时会整份改写这个文件（区块随之消失，或被收进它的提示词），停用时会清空。
   - 用户选“仍然写入”（`acknowledge=cc-switch`）后才给确认。
8. **写入流程**：
   - 沿用第 2 步：检查（精确差异，上下文 2 行）→ 确认（15 分钟、单次）→ 再读比对 → 备份 → 原子替换或删除 → 回读校验 → 台账 → 修改记录。
   - 台账的键是 `instructions`，值是正文哈希；原值记录分隔和“是否新建”。
   - 漂移检查加入指令区块：被移除、被改动、文件读不到。
9. **运行中的程序**：
   - 确认框按上表写明什么时候生效。
   - Claude、Gemini 报运行中的会话数。
   - OpenClaw 写明：飞书、微信等频道的会话，新会话或重置后才用到；不重启网关。工作区是 git 仓库时，写明这次改动会出现在它的 git status 里。
10. **体积**（按审批更正）：
    - Codex 的用户级文件没有上限，不提示。
    - OpenClaw：写入后超过它的单个文件上限时阻止，因为它会挖掉中间的部分，区块或模板会残缺。
    - DeepSeek Harness：写明总预算 64 KiB，含项目里的文件，只提示。
11. **页面**：
    - 指令页签上方新增“统一指令”卡片：共享指令编辑框、每个 Harness 的追加文本（折叠）、保存。
    - 下面每个 Harness 一行：文件、状态、什么时候生效、操作（写入、更新、移除）。
    - Cursor 一行提供“复制共享指令”，提示粘贴到 Cursor 设置的 User Rules。
12. **不做**：
    - 导入已有文件的内容：本机没有可导入的，Claude 的文件不存在，Codex 与 Gemini 的为空，OpenClaw 的是模板。
    - 项目级文件。
    - Hermes 的 SOUL.md。

### 第一次真实写入（提案）

- 用户没有给出指令内容，所以只做往返验证：共享指令写一行无害的验证文本，写入、核对、移除，最后回到原样。
- **DeepSeek Harness**：
  - 新建 `~/.dsh/AGENTS.md`。没有运行中的进程，也不是 cc-switch 的文件。
  - 用 dsh 自己导出的 `loadBaselineInstructions` 只读核对它确实读到区块。这个函数只读文件，不建会话。
  - 移除后文件删除。
- **Codex**：
  - 在原有的 0 字节 `~/.codex/AGENTS.md` 里写入。这是 cc-switch 的文件，需要确认 cc-switch。
  - 移除后回到 0 字节。
- **待决**：DeepSeek Harness 的 MCP 补丁是否也按第 3 条处理，即 HarnessHub 新建的文件，移除最后一项后只剩 HarnessHub 写的骨架时删除文件。若同意，现在留下的 3 字节 `[]` 是否一并删除。

## 审批代理对第 4 步的裁决（2026-10-19）

审批代理只读核对了提案、写入框架、已写出的实现与本机程序，更正了四处事实（已改进上面的设计），并逐条裁决：

1. **事实更正**：本机 cc-switch 是 3.15.0；Codex 的用户级指令文件没有字节上限；OpenClaw 超长时保留头尾、挖掉中间；本机有 ChatGPT 应用内置的 Codex 在运行。
2. **区块格式**：同意。文本另拒绝孤立的代理项和换行、制表符以外的控制字符；混合换行、BOM 加 CRLF 要有夹具；任何以 `<!-- harnesshub:` 开头却不是精确标记的行都视为残缺。
3. **移除**：同意。删除文件前先备份、重验，回读必须已不存在；备份要能记下“这次改动删除了文件”，恢复时不误报“此后被改过”。新建的文件和恢复出的文件都是 0600。
4. **家目录**：同意不做隐式替换；编辑框在输入前就提示写 `~`。
5. **OpenCode 回退**：同意 `create-own`。阻止时给出替代做法（改写 Claude 的 CLAUDE.md）；`elsewhere` 的按钮写明“改为新建自己的文件（之后不再回退）”；Claude 的写入与移除说明 OpenCode 也受影响；关闭回退的环境变量按源码核实；两个文件都不存在时直接新建。
6. **cc-switch**：同意，但只在第一次写入、区块被移除后重写、覆盖 HarnessHub 没有对应记录的完整区块时要求确认；更新 HarnessHub 自己的区块只提示。0 字节文件另加一句说明；cc-switch 在运行时写明；不读 `~/.cc-switch` 里的任何东西，以不可读的目录测试。
7. **OpenClaw**：同意作为普通目标，附条件：确认框列出实际配置的频道名；超过单个文件上限时阻止；工作区文件不存在时阻止、不替它新建；配置了多个 agent 时说明只写默认 agent；**OpenClaw 的第一次真实写入由用户在页面上点**。
8. **不做导入**：同意；认领要有成功与拒绝的测试。
9. **其余**：存储 v4 与降级脚本同意，按先例测试；Gemini 的 settings.json 读取不应拒绝链接；sha 完好但与记录不符的区块说成“HarnessHub 更早写的版本（可能被别的工具写回）”；每个 Harness 只留一条区块记录，旧文件已没有区块的记录随新写入删除；`instructions/` 在孤立设置、漂移、重新应用、不再跟踪里都要识别；运行中的程序加 Codex；每次检查的第一句声明只改区块、不改模型与登录配置。
10. **第一次真实写入**：同意由主代理代为执行 DeepSeek Harness 与 Codex 各一次往返，用规定的验证文本，最后保持移除；OpenClaw、Claude、Gemini、OpenCode 的第一次写入留给用户。
11. **`[]` 文件**：同意统一规则“HarnessHub 新建的文件，移除最后一项后只剩 HarnessHub 写的骨架时删除”，并补上 DeepSeek Harness MCP 的实现；同意由主代理按前置核对手工删除本机现有的 `[]`，不伪造台账。

## 第 4 步实现记录：指令区块（2026-10-19）

- **已实现**：
  - `instruction-blocks.ts`：区块的解析、写入、移除，与文本校验（16 KiB、NUL 与控制字符、孤立代理项、区块标记、家目录完整路径）。
  - `instruction-changes.ts`：每个 Harness 的目标文件、状态、写入与移除的检查、认领。
  - 写入框架：`format: "markdown"` 的编辑；`remove` 删除 HarnessHub 新建、已为空的文件；`alsoLedger` 随同一次写入记下或删掉同一 Harness 的其他记录；删除了文件的备份记为 `deleted`，恢复时据此判断有没有被改过。
  - 存储 v4：`instruction_texts`；降级脚本 `tools/capabilities-v4-to-v3.sql`。
  - 接口：`/capabilities/instructions`（读、存）、`/instructions/claim`、`/instructions/sync`、`/instructions/remove`；检查带 `options` 与 `proceed`，契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
  - 页面：指令页签上方的“统一指令”卡片；确认框对只差用户表态的检查显示 `proceed` 按钮，带上选项重新检查。
  - DeepSeek Harness 的 MCP 补丁：HarnessHub 新建文件时随写入记下 `file/created`；移除最后一个服务器、只剩 `[]` 时删除文件并清掉这条记录。这条记录不进漂移列表，降级到 v3 时一并删除。
  - 读取表：Codex 的指令证据改为用户级无上限；OpenCode 的回退在两个环境变量为真时不存在，回退路径按源码用家目录下的 `~/.claude/CLAUDE.md`；视图不再对 Codex 的大文件提示 32 KiB。
- **实现中的取舍**：
  1. **新建文件的权限**：沿用写入框架，新建的文件为 0600；从备份恢复一个被删除的文件也是 0600。
  2. **恢复之后**：恢复会清掉这个文件的全部记录，所以恢复出的区块显示为“可认领”，不算 HarnessHub 记录里的区块。
  3. **cc-switch 的进程**：按命令行里的 `cc-switch` 程序名识别（应用包路径里有空格，不能只取第一段）。
  4. **Codex 的进程**：程序名为 `codex` 的都算，包括 ChatGPT 应用和编辑器扩展内置的；技能与 MCP 的检查也会显示这条说明。
  5. **页面记住“仍然写入”**：审批允许但没有做，每次检查都要用户自己点。
- **已知行为**：
  - OpenClaw 升级或重新初始化工作区时可能重写模板，HarnessHub 的区块随之消失，漂移列表会显示“已被外部移除”。
  - cc-switch 启用或切换提示词时整份改写它管理的文件，区块随之消失，同样显示在漂移列表里。
  - 运行中的 Claude Code、Codex、Gemini 会话不读新内容；OpenCode 与 DeepSeek Harness 下一步就读到；OpenClaw 新会话或重置后读到。
- **验收**：G064-I1（单元），G064-I2、G064-I3（集成），G064-M2 增加的 dsh 新建文件删除，G054-CA7（浏览器）；真实环境见[指令区块验收](../verification/capability-instructions-2026-10-19.md)。
- **真实环境**（2026-10-19，审批同意）：
  - DeepSeek Harness 与 Codex 各做一次往返，最后保持移除：
    - dsh：新建 0600 的文件；dsh 自带的读取函数读到区块；移除后文件删除。
    - Codex：第一次写入先被 cc-switch 挡住，确认后写入；保持 0644；移除后回到 0 字节。
    - 两个文件 30 秒内没有被改动；结束时没有漂移和台账记录，验证文本已清空。
  - 第一次运行在 dsh 读取的核对处停下：我的脚本把读取函数返回的对象当成了字符串，审批的停止条件没有触发。修正后续跑；中间登录会话过期，重启 4317 拿了新口令。
  - 本机留下的 `~/.dsh/cordis.patch.yml`（`[]`）按审批核对后手工删除，属于产品流程外的清理。dsh 的配置合成回到 3c 之前的 380 行。


## 第 5 步设计：子 Agent 与命令（2026-10-19 提案，同日按审批更正事实）

### 本机核实（只读，已装版本；两路调研的证据见文末各条）

本机所有 Harness 的用户级子 Agent 与命令目录都不存在，现在一个都没有。

| Harness | 子 Agent | 命令 |
|---|---|---|
| Claude Code 2.1.302（nvm 那份 2026-10-19 自动升到 2.1.303） | `~/.claude/agents/**/*.md`，必填 `name`、`description`（名字不能含 `:`、不能以 `-` 开头），正文是系统提示；未知字段忽略；与内置同名时顶替内置（如 `Explore`）。不写 `tools` 即继承全部工具；`hooks`、`mcpServers` 不经信任对话框就运行。会话启动时加载；只有启动时已存在的目录才会热加载。HarnessHub 的会话经 claude-agent-acp 0.89.1（`settingSources` 含 `user`）同样加载 | `~/.claude/commands/**/*.md` 仍读（已并入技能），`$0` 是第一个参数，`` !`cmd` `` 经权限检查；Cursor CLI 也读这个目录，但 `$1` 才是第一个参数、不解析 frontmatter |
| Codex 0.162.1 | `~/.codex/agents/**/*.toml`（递归），另有 `config.toml` 的 `[agents.<名>]` 也声明角色；必填 `name`、`description`、`developer_instructions`；名字以 `name` 字段为准；未知键会让整个文件被拒；`default`、`explorer`、`worker`（`awaiter` 已注释）会被同名的用户角色顶替；角色能改模型、推理强度、features、skills 等，但不能放宽父会话的沙箱与审批。默认启用（`[agents] enabled` 与 `features.multi_agent` 缺省都为 true，本机显式写了 true）。app-server 每次新线程重读 | `~/.codex/prompts` 自 0.118.0 起不再读取（代码已删除），官方改用技能；技能没有参数占位符 |
| Gemini CLI 0.62.0 | `~/.gemini/agents/*.md`（只看顶层、只认普通文件），必填 `name`（`^[a-z0-9-_]+$`）、`description`；字段严格校验，未知键整个文件失败；不写 `tools` 即继承全部工具；正文里的 `${…}` 是模板，只认 `query`、`cliVersion`、`activeModel`、`today`，别的名字调用时失败；内置名 `codebase_investigator`、`cli_help`、`generalist`、`browser_agent` 先注册、同名的用户 Agent 被忽略。默认启用。ACP 每个新会话重读 | `~/.gemini/commands/**/*.toml`（`prompt`、`description`，`{{args}}`、`!{…}`、`@{…}`）；**`--acp` 模式不展开自定义命令**，HarnessHub 的会话里用不了 |
| OpenCode 1.18.35 | `~/.config/opencode/{agent,agents}/**/*.md`（另有 `{mode,modes}/*.md` 也定义 Agent），名字取自相对路径，以 `/` 连接，frontmatter 的 `name` 优先；字段代码上都可选，但类型写错可能让整个实例起不来，未知键会被送进模型请求参数；不写 `mode` 默认 `all`（同时出现在主模式列表）；内置 `build`、`plan`、`general`、`explore`、`compaction`、`title`、`summary` 可被同名文件逐字段覆盖。建实例时读一次，HarnessHub 每个会话起新进程 | `~/.config/opencode/{command,commands}/**/*.md`，`$1` 起 1 基；`` !`cmd` `` 在参数替换后执行，**不经权限检查** |
| Cursor（cursor-agent 2026.10.01） | 文档写读 `~/.cursor/agents`、`~/.claude/agents`、`~/.codex/agents`，**本机 CLI 只读工作区里的** `.cursor/agents`、`.claude/agents`、`.grok/agents`（`index.js` 的 `computeAgentsDirs`），不读家目录；编辑器是否读取未核实 | CLI 读 `~/.cursor/commands` 与 `~/.claude/commands` 顶层的 `.md`（`9577.index.js` 的 `loadCommandsFromDirectory`），不解析 frontmatter |
| Pi | 未安装 | 未安装 |
| Hermes、OpenClaw、DeepSeek Harness | 没有子 Agent 文件格式 | 没有 |

另外：选了 HarnessHub 管理的 Provider 的 Codex、Gemini 会话用私有目录，读不到用户级子 Agent。

### 设计

1. **统一子 Agent 清单**（与 MCP 清单同一模式）：
   - 中立定义只有三样：`name`（`^[a-z][a-z0-9-]{0,63}$`，四家都能用）、`description`（一行，最多 1024 字符）、`prompt`（正文，最多 32 KiB）。文本校验与指令相同（控制字符、孤立代理项、家目录完整路径）。
   - **不写**工具、模型、权限、hooks、MCP：子 Agent 继承父会话的模型、工具和权限；HarnessHub 不写任何会放宽权限或拉起程序的字段。确认框写明“这个子 Agent 继承父会话的全部工具和权限”。
   - 保留名：四家内置的名字一律拒绝（`default`、`explorer`、`worker`、`generalist`、`build`、`plan`、`general`、`explore`、`compaction`、`title`、`summary`、`general-purpose`、`statusline-setup`、`claude-code-guide`、`claude`），以免顶替内置。
   - 存在 `capabilities.sqlite` v5 的 `subagents` 表，附降级脚本。
2. **按家写成 HarnessHub 自己的文件**（整份归 HarnessHub，台账记文件哈希）：
   - Claude Code：`~/.claude/agents/<名>.md`，frontmatter 只有 `name`、`description`。
   - Codex：`~/.codex/agents/<名>.toml`，只有 `name`、`description`、`developer_instructions` 三个键。
   - Gemini：`~/.gemini/agents/<名>.md`，frontmatter 只有 `name`、`description`。正文含 `${` 时 Gemini 标为不支持并说明原因。
   - OpenCode：`~/.config/opencode/agents/<名>.md`，frontmatter 只有 `description` 和 `mode: subagent`。
   - Cursor 不写：本机 CLI 不读家目录的子 Agent。Pi 未安装；Hermes、OpenClaw、DeepSeek Harness 不支持。
3. **状态与冲突**：已写入、待更新、被外部改动、被外部移除、未写入、一致可认领、同名不同（不覆盖）、不支持。同名的判断按各家的命名规则扫描整个目录：Claude、Codex、Gemini 看 `name` 字段，OpenCode 看路径；别人的同名定义一律不覆盖。
4. **目录**：四个目录本机都不存在。第一次写入时建目录（0700），并记下“由 HarnessHub 新建”；移除最后一个文件后目录为空就删除，与裁决第 3 条对文件的规则一致。
5. **写入流程**：沿用框架：检查（新文件或差异）→ 确认 → 再读比对 → 备份 → 原子写或删除 → 回读校验（按各家格式解析，只含这几个键）→ 台账 → 修改记录；漂移检查加入子 Agent。
6. **什么时候生效**：
   - Claude：新会话；运行中的会话只有在目录早已存在时才热加载，所以第一次建目录要开新会话。
   - Codex：新线程，包括 ChatGPT 应用、编辑器扩展内置的 Codex。
   - Gemini：新会话，或会话里 `/agents reload`。
   - OpenCode：新会话（新进程）。
   - 用 HarnessHub 管理的 Provider 的 Codex、Gemini 会话读不到。
7. **命令：不写各家的原生命令文件**，理由：
   - 本机一个命令都没有；Codex 已不读；Gemini 在 HarnessHub 的 ACP 会话里不展开；`~/.claude/commands` 同时被 Cursor 读、参数下标不同；OpenCode 的 `` !`cmd` `` 不经权限检查。
   - 统一的做法是**共享技能**：`~/.agents/skills` 被本机所有 Harness 读取，Claude、OpenCode、Cursor 把技能列成 `/` 命令，Codex 用 `$名`。
   - 提案在技能页签加“新建技能”：名称、说明、正文写成 `~/.agents/skills/<名>/SKILL.md`，走现有的添加流程（快照、撤销、删除），来源记为“HarnessHub 新建”。确认框说明各家参数占位符不同、Codex 的技能没有参数。
   - 命令页签保持只读，并说明上面的取舍。
8. **读取表更正**（视图的准确性）：
   - Cursor：子 Agent 改为“本机 CLI 不读家目录”，命令改为读 `~/.cursor/commands` 与 `~/.claude/commands` 顶层。
   - Codex：命令（prompts）改为不支持并写明 0.118 起删除；子 Agent 改为递归。
   - Claude、OpenCode 的子 Agent 改为递归；Gemini 的子 Agent 只认普通文件。

### 第一次真实写入（提案）

- 用一个只做核对的子 Agent：名字 `harnesshub-roundtrip-check`，说明“HarnessHub 往返核对用，请不要调用”，正文“这个子 Agent 只用于核对写入与移除，不做任何事。”
- 依次写入 Codex、OpenCode、Gemini、Claude Code，核对后全部移除。四个目录都由 HarnessHub 新建，移除后删除，最后回到原样。
- 只验证文件级契约：按各家规则解析，并确认目录里没有同名冲突。各家会话里是否列出这个子 Agent 不验证，因为要新建会话。
- “新建技能”的第一次真实写入留给用户。

## 审批代理对第 5 步的裁决（2026-10-19）

审批代理只读核对了提案与本机程序、上游源码，补正了事实（已改进上面的设计），并逐条裁决：

1. **子 Agent 只写三样**：同意附条件。
   - 确认框按家写明继承什么：Claude 继承全部工具与权限模式、加载 CLAUDE.md；Codex 不能放宽父会话沙箱与审批；Gemini 继承全部工具、用户级不需确认；OpenCode 继承全局权限配置。
   - 保留名按证据扩充，写进读取表并附证据：Claude 另有 `comment-thread-analyst`、`teammate`、`agent`、`subagent`、`main`、`main-session`；Codex 加 `awaiter`；Gemini、OpenCode 各自的内置名。
   - 文本：说明单行、去掉首尾空白、最多 1024；正文去掉首尾空白、最多 32 KiB、不得以 `---` 行开头。
   - 不做每家覆盖块。
2. **渲染**：同意附条件。Codex 的正文用多行基本字符串转义；Codex 关了子 Agent 时写明“文件写入但不会被用”；回读按各家格式核对三个字段、没有多余键；文件 0600、目录 0700。
3. **同名与目录**：同意附条件。Codex 还要查 `config.toml` 的 `[agents.<名>]`（无法解析时阻止）；OpenCode 还要查 `{mode,modes}`；目录由 HarnessHub 新建时记下，移除最后一个文件后目录完全为空（含点文件）才删除；父目录不存在时阻止，不替它新建。
4. **命令改为“新建技能”**：同意附条件。名字按 agentskills 规范、与现有文件夹不分大小写比较；与各家内置命令同名时警告；只写 `name`、`description`；拒绝 `` !`…` `` 与 ```` ```! ````（OpenCode 不经权限执行）；来源记为 HarnessHub 新建（存储 v5）、不写 lock；编辑走更新流程（快照、本地改动检测、撤销）；完成后提示放到 Claude Code。
5. **读取表更正**：同意附条件；Cursor 命令要给出代码位置（已给出 `9577.index.js`）。
6. **第一次真实写入**：同意，由主代理代为执行一个核对用子 Agent 在四家的往返，最后全部移除；“新建技能”的第一次真实写入留给用户。
7. **其他**：存储 v5 与降级脚本；`subagent/`、`file/created`、`dir/created` 在漂移、重新应用、不再跟踪、孤立设置里都要识别；测试 G064-A1～A3；验证记录 `capability-subagents-2026-10-19.md`。

## 第 5 步实现记录：子 Agent 与新建技能（2026-10-19）

- **已实现**：
  - `subagent-definitions.ts`：中立定义的校验、四家格式的生成与读回、按各家命名规则查同名。
  - `subagent-changes.ts`：子 Agent 清单、每家的状态、写入与移除的检查、认领。
  - 写入框架：编辑计划可以先建目录（0700，父目录须已存在）或在删除文件后删掉 HarnessHub 新建、已空的目录；`dir/created` 与 `file/created` 一样只是记录，不进漂移。
  - `skill-text.ts` 与技能改动：由文本新建技能、编辑 HarnessHub 新建的技能（快照与撤销沿用），来源记为 `local`；检查更新时说明没有上游。
  - 存储 v5：`subagents` 表与 `skill_sources.kind`；降级脚本 `tools/capabilities-v5-to-v4.sql`（删除子 Agent 与 HarnessHub 新建技能的记录，文件夹留给用户）。
  - 接口：`/capabilities/subagents`（读）、`/subagents/save`、`/subagents/delete`、`/subagents/claim`、`/subagents/sync`、`/subagents/remove`；`/skill-create`、`/skill-edit`（POST 检查）、`/skill-text`。契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
  - 页面：子 Agent 页签上方的“统一子 Agent”卡片；共享目录卡片的“新建技能”，HarnessHub 新建的技能在详情里“编辑”；编辑被本地改动挡住时，确认框给出“覆盖本地改动并改写”。
  - 读取表与视图：按第 5 条更正；Gemini 不读的文件列出并写明原因。
- **实现中的取舍**：
  1. **同名冲突与已写入的文件**：HarnessHub 写入之后旁边出现同名定义，状态保持“已写入”并说明“只会用其中一个”；再写入被阻止，移除仍可以。
  2. **Codex 子 Agent 关闭的判断**：只有显式写了 `[agents] enabled = false` 或 `features.multi_agent = false` 才提示；缺省时两者都是开启（`config/mod.rs`、`features/src/lib.rs`），与审批第 2 条“缺省也提示”不同，如实写在这里。
  3. **测试编号**：同名冲突与漂移是 G064-A3，新建技能单列为 G064-A4。
  4. **页面记住选项**：没有做，每次检查都要用户自己点。
- **已知行为**：
  - 新建的子 Agent 文件为 0600，HarnessHub 新建的子 Agent 目录为 0700；新建技能的文件夹 0755、SKILL.md 0644。
  - Claude Code 只检测会话启动时已存在的目录；第一次建 `~/.claude/agents` 后，运行中的会话看不到。
  - 用 HarnessHub 管理的 Provider 的 Codex、Gemini 会话读不到用户级子 Agent。
- **验收**：G064-A1（单元），G064-A2～A4（集成），G054-CA8（浏览器），G064-R4 按读取表更正；真实环境见[子 Agent 验收](../verification/capability-subagents-2026-10-19.md)。
- **真实环境**（2026-10-19，审批同意）：
  - 一个核对用子 Agent 依次写入 OpenCode、Gemini、Codex、Claude Code，四个目录都由 HarnessHub 新建。
  - 文件字节与计划一致，按各家格式读回无误，30 秒内没有变化。
  - 移除后文件与目录都不存在，各家配置目录回到写入前。
  - 各家会话里能否列出这个子 Agent 没有验证；新建技能的第一次真实写入留给用户。


## 第 6 步设计：插件（2026-10-19 提案，同日按审批更正事实）

### 本机核实（只读；两路调研读已装包、tag 源码与文档；Claude 的停用另在禁网沙箱里对私有副本实测一次）

| Harness | 启用 / 停用 | 卸载 | 安装 | 何时生效 | 本机 |
|---|---|---|---|---|---|
| Claude Code 2.1.303（nvm）、2.1.302（Homebrew） | 设置项 `enabledPlugins`：键是 `插件名@市场名`，值是布尔（设置参考 `#enabledplugins`）。<br>没有条目时按 `defaultEnabled`：市场条目的值优先，其次 `plugin.json`，缺省 `true`；被启用插件依赖的插件即使没有条目也会启用。<br>`/plugin` 与 `claude plugin enable` 写的就是这个键。命令启用时会连带启用已装的依赖，依赖未装则失败；停用时，如果另一个启用中的插件需要它，就拒绝。<br>来源优先级：`--add-dir` < 用户 < 项目 < 本地 < `--settings` < 管理设置，按 id 逐键合并 | `uninstall`：最后一个作用域时删掉 `data/`、`pluginConfigs` 与钥匙串里的密钥（`--keep-data` 保留数据） | 联网；command 型来源要确认 | 新会话（HarnessHub 的每个 ACP 会话都是新进程）；运行中的会话要 `/reload-plugins`，ACP 里隐藏了这个命令 | 已装 18 个（启用 17，superpowers 停用），都显式写在 `enabledPlugins` 里。<br>插件清单和 5 个市场清单的 319 个条目都没有声明依赖。<br>claude.ai 同步的 5 个以 `<名>@synced` 加载，清单在 `plugins/synced/<账户>/manifest.json`，按代际放在 `<名>~g<代>` 目录，不在 `installed_plugins.json`。<br>`plugins/blocklist.json` 是旧版本留下的文件，2.1.303 不引用它（二进制里没有这个文件名；列在里面的 `code-review` 在会话里照常加载）。<br>管理设置（文件、`.d`、MDM 描述文件）本机都不存在 |
| Codex 0.162.1 | 没有命令；配置参考列出 `plugins.<插件名@市场名>.enabled`；TUI `/plugins` 与 app-server 的 `SetPluginEnabled` 写的也是它（上游 `core-plugins/src/toggles.rs`）。<br>受信任项目的 `.codex/config.toml` 可以覆盖用户级。<br>`[features] plugins = false` 会关掉整个插件功能 | `codex plugin remove`：删掉缓存里所有版本与整个 `[plugins."id"]` 表（含用户加的子键） | 联网（Git、npm、远端市场） | 新线程 | `[plugins]` 41 张表都显式写了 `enabled`（停用的是 superpowers、minimax-skills），`playwright` 那张后面跟着 5 个 `mcp_servers` 子表。<br>`@openai-bundled` 8 个随 Codex 安装。<br>没有设置 `features.plugins` |
| Gemini CLI 0.62.0 | `gemini extensions enable\|disable <名> --scope user`：改 `extension-enablement.json` | 删扩展目录 | 联网，要 `--consent` | 新会话 | 0 个扩展，未实测 |
| OpenCode 1.18.35 | 没有启停：`ConfigPlugin.load` 用 `{plugin,plugins}/*.{ts,js}`（含点开头的文件、跟随链接）；`plugin` 数组的条目是 `string \| [string, 选项]`。<br>`tui.json` 的 `plugin` 是 TUI 插件 | 没有命令 | `opencode plugin`：先引导实例、运行已配置的插件 | 新进程 | npm 插件 0；`~/.config/opencode/plugin/` 里有 1 个本地文件（视图漏读了单数目录） |
| Hermes 0.12.0 | `hermes plugins enable\|disable` 经 `save_config` 整份重写 `config.yaml`（注释丢失、写入默认键）。<br>`hermes_cli/plugins.py`：<br>- `plugins.disabled` 永远优先；`plugins.enabled` 缺失表示一个都没启用。<br>- 键按路径取（`<名>` 或 `<分类>/<名>`），也认裸名；`plugin.yaml` 或 `plugin.yml`。<br>- `exclusive`（记忆提供方）由 `<分类>.provider` 选择；`model-provider` 不受 `plugins.enabled` 约束。<br>- 没写 `kind` 时，按 `__init__.py` 前 8 KiB 归类 | 删整个插件目录，不清启用列表 | git clone，可能询问并写 `.env` | 新的 `hermes acp` 进程；ACP 会话里看不到插件工具 | 用户插件 0 |
| DeepSeek Harness 0.2.0-rc.2 | 没有命令；插件是各 profile `package.json` 的依赖（`dsh plugin` 把参数交给 pnpm） | `dsh plugin --profile <名> remove`（pnpm 透传） | `add` 联网，装上即启用 | 新的 acp 进程 | `~/.dsh/profiles/{acp,headless,web}/package.json` 的依赖都是 0 |
| OpenClaw 2026.3.23-2 | `openclaw plugins …`：写 `plugins.*`，运行中的网关按 `hybrid` 模式排队重启（`gateway-cli-*.js` 的重载规则） | 同左 | 同左 | — | 按裁决第 9 条继续只读 |

**副本实测**：
- 条件：Claude 2.1.303；`CLAUDE_CONFIG_DIR` 指向私有目录，里面只放 `enabledPlugins` 与两个插件清单的副本；禁网，只能写这个目录。
- 结果：`claude plugin disable swift-lsp@claude-plugins-official --scope user --json` 退出码 0，`settings.json` 只有这一项从 true 变成 false。
- 副作用：Claude 启动时按自己的缓存路径把 15 个插件重新铺了一遍（从本地市场目录复制），claude-hud 还执行了 `npm ci --ignore-scripts`。因为禁网，`npm ci` 失败了，但命令照样报告成功。这与 loading 文档“启用的插件还没缓存时，会话开始时会安装”一致。
- 结论：“在副本上预演”对插件不成立，副本本身就会触发安装。实验目录已删除。

### 设计（6a：启停与视图；6b：装卸）

1. **分两步**：
   - ADR 定的第 6 步包括装卸与启停。6a 先做启停和视图改正；6b 做装卸（官方命令），在 6a 真机往返通过后设计并送审。
   - 装卸要联网，装上后第三方代码会在 Harness 进程里运行；卸载会删数据和密钥。所以 6b 单独审批，第一次真实写入留给用户点。
   - 6a 只有 Claude Code 与 Codex 有开关。其余只读，视图逐家写明原因：
     - Gemini：本机 0 个扩展，没有核实；
     - Hermes：`hermes plugins enable` 经 `save_config` 整份重写 `config.yaml`；
     - OpenCode、DeepSeek Harness：没有启停；
     - OpenClaw：裁决第 9 条；
     - Cursor：不在磁盘上记录。
2. **Claude Code 的启停**：定点改 `~/.claude/settings.json` 的 `enabledPlugins.<id>`，做法与第 2 步的 `skillOverrides` 相同。
   - 精确的字节差异、确认后再读比对（变了就 409）、备份、原子替换、回读 `onlyChanged(["enabledPlugins", id])` 且目标值符合预期。
   - **这一条修改了第 9 节“启停委托给官方命令”**，依据有三：
     - 设置参考写明，`/plugin` 与 `claude plugin enable` 写的就是这个键；
     - 副本实测中，命令对 `settings.json` 的改动也只有这一项；
     - 运行命令会启动 Claude 的插件整理（补齐缓存、`npm ci`），超出一个开关该做的事，也没法预演。
     装卸（6b）仍用官方命令。
   - **范围**：id 必须是 `^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$`。以下几类不提供开关：
     - `@inline`、`@skills-dir`、`@builtin` 这些保留来源；
     - `@synced`（见第 6 条）；
     - `enabledPlugins` 里有条目但用户级没有安装的。
   - **有效状态**：用户级条目 → 取值；没有条目 → 市场条目的 `defaultEnabled` → `plugin.json` 的 `defaultEnabled` → `true`。另外，被启用的插件依赖的插件也算启用。视图写“按默认启用（没有条目）”。
   - **依赖**：Claude 的命令会连带启用依赖、拒绝停用被依赖的插件。HarnessHub 不做连带改动，改为拒绝并点名原因；提示写“在 Claude 里用 `/plugin` 或 `claude plugin enable` 会连带启用依赖”。
     - 依赖取 `installPath/.claude-plugin/plugin.json` 与市场条目的 `dependencies` 的并集。
     - 写法有三种：`"名"`（同一市场）、`"名@市场"`、`{name, marketplace, version}`。版本约束 HarnessHub 不求值。
     - 启用时，依赖里有解析不到已装 id 的、没装的或停用的，就拒绝。
     - 停用时，用户级已装且有效启用的插件，以及读得到清单的账户同步插件里，有依赖它的，就拒绝。只装在项目里的不算，但要提示。
     - 读不到要用的清单（`installPath` 不存在、市场清单读不到）就拒绝，写“无法核对依赖”。
   - **管理设置**：读 `/Library/Application Support/ClaudeCode/managed-settings.json` 与 `managed-settings.d/*.json`（先主文件，再按字母序，嵌套块逐键合并）。
     - 写了这一项就拒绝：`true` 写“强制启用，停用无效”；`false` 写“被组织策略阻止”。
     - MDM 描述文件（`/Library/Managed Preferences/` 下的 `com.anthropic.claudecode.plist`，含按用户的）存在就拒绝，因为 HarnessHub 不读它。
     - 说明里写明：服务器下发的管理设置无法从文件核对。
   - **开关规则**，与第 2 步的技能开关相同，并加一条例外：
     - 停用写 false，台账记下原值；
     - 启用一个 HarnessHub 停用的插件，就写回原值，并删除台账；
     - 例外：原值是“没有条目”，而默认会让它停用（`defaultEnabled` 为 false）时，写 `true` 并记台账；
     - 其他情况写 `true` 并记台账。
   - **确认框写明**：
     - 新会话生效，包括 HarnessHub 的 ACP 会话；运行中的会话要 `/reload-plugins`；
     - 桌面应用与 VS Code 扩展读同一个文件；
     - 项目的 `.claude/settings.json`、`settings.local.json`、`--settings` 与管理设置都能覆盖用户级（用户级写 `false` 关不掉项目启用的插件）；
     - 运行中的会话随后把旧值写回时，由漂移列表显示，不自动重试。
3. **Codex 的启停**：定点改 `[plugins."<id>"].enabled`。
   - 新的 TOML 定位器按 TOML 规则解析表头：裸键、`"…"`、`'…'`、点号两侧的空白都认，逐段比较 `["plugins", id]`。表的范围到下一个表头为止，后面的 `[plugins."…".mcp_servers.…]` 子表不动。
   - 解析结果里有 `plugins[id]`，却找不到这样的表头（写在 `[plugins]` 下的点号键、内联表）就拒绝。**绝不追加第二张同名表**：那样整个 `config.toml` 都会无效。
   - 表里没有 `enabled` 时，停用就在表里最后一个键之后插入 `enabled = false`。原值是“没有键”时，启用写显式的 `enabled = true` 并记台账，不删行（Codex 的缺省值没有核实）；视图对缺键的写“Codex 缺省值未核实”。
   - 回读：`onlyChanged(["plugins", id, "enabled"])`，smol-toml 重新解析成功，字节差异恰好一行（改值或插入一行）。
   - 提示：
     - 新线程生效；
     - 本机运行着 Codex 进程和 ChatGPT 应用，它们可能改写同一个文件，表现为 409 或漂移；
     - `features.plugins = false` 会关掉整个插件功能（设置了就写明）；
     - 受信任项目的 `.codex/config.toml` 可以覆盖用户级，管理层（cloud-managed、`/etc/codex`）无法核对；
     - `@openai-bundled` 的归属显示“随 Codex 安装”。
4. **视图**：
   - 只把 `名@市场` 形式、在 Claude 与 Codex 都出现的 id 合成一行，按 Harness 显示各自的版本、位置、状态与开关。例如 `swift-lsp@claude-plugins-official` 在两边都启用，就是一行两个开关，各管各的、互不连带。
   - Hermes、Gemini、OpenCode、DeepSeek Harness 的条目各自成行，不跨家合并。
   - 没有开关的 Harness 只显示状态与原因。
5. **台账与漂移**：
   - 按 `plugin/<id>` 记台账，值是写入的布尔，同时记下原值。`heldValue` 认识这个前缀：Claude 读 `enabledPlugins.<id>`，Codex 读表里的 `enabled`，缺失为 undefined。
   - 被外部改回的进入漂移列表；“重新应用”走原检查，“不再跟踪”只删台账。
   - 孤立设置：插件已从用户级卸载，但 HarnessHub 写的条目还在，列入孤立列表，清除走开关检查。
   - 沿用现有台账表，存储不升版本。回退到旧构建时，这些台账行在漂移列表里会显示为“无法读取”（旧版的 `heldValue` 不认识这个前缀），无害；升版本则会让旧构建整个打不开能力库，所以选择不升。
6. **视图改正**（只读）：
   - **Claude**：
     - 账户同步插件按 `synced/<账户>/manifest.json` 的 `plugins[].name/version/marketplaceName` 列出，按名字去重，不按目录名（同一插件有多个代际目录）。
     - 位置只显示到 `~/.claude/plugins/synced`，不显示账户 ID；来源标为“claude.ai 账户同步”。
     - 有效状态按 `enabledPlugins["<名>@synced"]` 与它的 `plugin.json` 的 `defaultEnabled` 计算；`syncClaudeAiPlugins: false` 时全部停用。
     - 6a 不提供开关，原因写“6a 不做；Claude 用 `<名>@synced` 条目停用，组织要求的除外”。
     - `enabledPlugins` 里有、却没有安装的条目，显示“有条目但未安装”。
   - **OpenCode**：
     - 读 `plugin/` 与 `plugins/` 两个目录，只认 `.ts`、`.js`，含点开头的文件、跟随链接；
     - `plugin` 数组里 `[spec, {…}]` 形式的条目也读；
     - `tui.json` 里的插件标为 TUI 插件，并写明 HarnessHub 的 ACP 会话不加载它们。
   - **Hermes**：按上表的规则逐条显示，并按 `kind` 写明为什么启用或没启用。
   - **DeepSeek Harness**：读各 profile `package.json` 的依赖，只读。
7. **什么时候生效**（确认框里写明）：
   - Claude：新会话，包括 HarnessHub 新开的会话；运行中的会话不变。
   - Codex：新线程，包括 ChatGPT 应用和编辑器扩展内置的 Codex。
8. **测试**：
   - **单元测试**：
     - TOML 表定位：各种引号、点号空白、紧随的子表、注释、CRLF、没有 `enabled` 的表；点号键、内联表与缺 `[plugins]` 都拒绝；编辑后必须能解析；用接近本机形态的夹具证明其余字节不变。
     - Claude 开关：停用、启用、恢复缺失，以及缺失且默认 false 时写 true；id 校验与保留来源；有效状态的解析顺序。
     - 依赖：并集、三种写法、两个方向的拒绝、依赖者已停用时不阻止、清单读不到时拒绝。
     - 管理设置：主文件与 `.d` 的合并顺序、`true` 与 `false` 两种拒绝、plist 存在就拒绝、全都缺失时的说明。
     - 读取器：同步清单去重且输出不含账户 ID、残留条目、只装在项目里的提示；OpenCode 的两个目录、点文件、链接、tuple、`tui.json`；Hermes 的分类布局、`plugin.yml`、缺 `plugins.enabled`、`disabled` 优先、各种 `kind`；DeepSeek Harness 的三个 profile。
   - **集成测试**（临时家目录，经正式入口）：
     - Claude：往返、外部改动后的漂移与重新应用、不再跟踪、卸载后的孤立设置；
     - Codex：带 `mcp_servers` 子表与注释的表、没有 `enabled` 的表、外部重写后的漂移。
   - **浏览器测试**：合成后的一行、两个开关、确认框里的生效时机与覆盖提示。

### 第一次真实写入（提案）

- **插件**：`swift-lsp@claude-plugins-official`。它在两边都启用，只给 Swift 文件提供语言服务；往返期间新开的会话少了它，影响最小。
- **Claude Code**：停用，回读核对只改了这一项；再启用（按开关规则写回原值、删除台账），`settings.json` 逐字节回到原样。
- **Codex**：同样往返，`config.toml` 逐字节回到原样。
- **授权**：只改启停的布尔，不涉及安装、卸载与网络，属于无密钥、可撤销的写入，由主代理代为执行。

## 审批代理对第 6 步的裁决（2026-10-19）

审批代理只读核对了设计、写入框架、本机 Claude 2.1.303 与 Codex 0.162.1 的二进制、Codex 上游源码、Hermes 与 OpenCode 的源码、本机配置的键名，以及 Claude 和 Codex 的官方文档。它更正了四处事实（已改进上面的设计），并逐条裁决：

1. **拆成 6a 与 6b**：同意附条件。
   - 6a 写明只有 Claude Code 与 Codex 有开关，其余逐家写明只读原因；
   - 6b 在 6a 真机往返通过后再设计。
2. **Claude 改为定点编辑 `enabledPlugins.<id>`**：同意附条件。
   - 沿用 `skillOverrides` 的框架；
   - 校验 id，保留来源不给开关；
   - 有效状态按“条目 → 市场条目 → `plugin.json` → `true`”计算；
   - 恢复“没有条目”而默认停用时，写 `true`；
   - 确认框写明生效时机与各级覆盖；
   - 被会话写回由漂移列表显示，不重试。
3. **依赖拒绝并点名**：同意附条件。
   - 依赖来源是 `plugin.json` 与市场条目的并集；原设计按 `strict` 区分是错的：没有 `plugin.json` 时，不论 `strict`，市场条目就是清单；
   - 三种写法，版本约束不求值；
   - 依赖者包括可读的账户同步插件；
   - 读不到就拒绝。
4. **黑名单不同意**。2.1.303 不引用 `plugins/blocklist.json`，相关判定与测试删除。管理设置与项目覆盖同意附条件：
   - 读文件与 `.d`，plist 存在就拒绝，说明服务器下发的无法核对；
   - 提示 `--settings`；
   - Codex 侧提示受信任项目与管理层。
5. **Codex 定点改 `enabled`**：同意附条件。
   - 按 TOML 规则解析表头，子表不动；
   - 点号键或内联表形式就拒绝，绝不追加同名表；
   - 缺键时启用写显式 `true`；
   - 回读核对一行差异；
   - 提示 `features.plugins`、运行中的进程与随 Codex 安装的插件。
6. **合成一行**：同意附条件。只合并 `名@市场` 形式且两家都有的 id，其他各自成行；行内按 Harness 显示版本与位置。
7. **台账**：同意附条件。
   - 沿用第 2 步的规则，加上第 2 条的例外；
   - `heldValue`、漂移、重新应用、不再跟踪、孤立设置都识别 `plugin/`；
   - 不升存储版本可以，但要写明回退到旧构建时的表现（已写在第 5 条）。
8. **视图改正**：同意附条件。
   - 账户同步插件“没有文档说明”不实，已更正为 `<名>@synced` 规则；列表按 `manifest.json` 去重；
   - OpenCode 含点文件、跟随链接，`tui.json` 标明；
   - Hermes 补上 `model-provider` 与随程序安装的类别。
9. **第一次真实写入**：同意，由主代理经 4317 的正式入口代为执行，不运行 `claude plugin` 或 `codex` 命令，Harness 一律不重启。
   - 顺序是 Claude 先、Codex 后；出现 409、回读不符或外部改动，就停下报告，用页面的恢复功能，不重试。
   - Claude：记下写前的 sha256 → 停用 → 回读只有这一项从 true 变成 false → 30 秒后复查没有外部改动 → 启用 → `settings.json` 与写前逐字节一致，`installed_plugins.json` 没变，台账与漂移为空。
   - Codex：差异恰好是第 278 行那张表下的一行，恢复后逐字节一致。
   - 验证记录写进 `docs/verification/capability-plugins-2026-10-19.md`，并写明没有验证往返期间新会话是否真的少了 swift-lsp。

## 第 6a 步实现记录：插件启停（2026-10-19）

- **已实现**：
  - `claude-plugins.ts`：Claude Code 插件模型。
    - 用户级安装来自 `installed_plugins.json`，只装在项目里的计数；账户同步插件来自各账户的 `manifest.json`，按名字去重，从代际目录读清单。
    - 有效状态：用户级条目 → 市场条目的 `defaultEnabled` → `plugin.json` 的 → `true`，再加上依赖规则（没有条目、被启用插件依赖的也算启用）；`syncClaudeAiPlugins: false` 时同步插件全部停用。
    - 依赖取 `plugin.json` 与市场条目的并集，三种写法；读不到时记为无法核对。
    - 管理设置：主文件与 `.d`，MDM 描述文件存在即无法确定。
  - `switches.ts`：`claudePluginSwitch` 与 `codexPluginSwitch`；`heldValue` 认识 `plugin/` 前缀。
  - `edits.ts`：
    - 表头按 TOML 规则解析（`tomlHeader`），新增 `tomlTable` 与 `oneLineChange`；
    - `setTomlKey` 改值时保留行尾注释，插入时沿用缩进；
    - 修正 CRLF 文件插入新行时落在 `\r` 之后的错误（也影响第 2 步 Codex 技能开关的插入）。
  - `changes.ts`：
    - 插件开关的检查：依赖、管理设置、保留来源与账户同步、未安装、确认框的生效时机与覆盖提示、运行中的进程；
    - 漂移与重新应用、不再跟踪、孤立设置（Claude 已卸载插件上 HarnessHub 写的 `false`）都识别 `plugin/`。
  - `scan.ts` 与读取表：
    - Claude 与 Codex 都有的 `名@市场` 插件合成一行；各家写明有没有开关、只读的原因；
    - Codex 读缓存版本、标出随 Codex 安装的插件；
    - OpenCode、Hermes、DeepSeek Harness 按设计第 6 条改正。
  - 接口：`GET /api/v1/capabilities/plugin-switch`；视图字段 `pluginSwitch`、`pluginReason`、插件的 `switchable`、孤立设置的 `kind`。契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
  - 页面：插件页上方写明哪些 Harness 能启停、其余为什么只读；展开插件后每家一个开关，各自显示版本与状态。
- **实现中的取舍**：
  1. **系统根目录**：管理设置在 `/Library` 下。`NativeEnvironment` 与 `ReadEnvironment` 增加可选的 `system`（缺省 `/`），只让测试指向私有目录，集成测试因此不受运行机器上管理设置的影响。`native-environment.ts` 归 G026，这里只加了一个可选字段，G026 的行为不变。
  2. **孤立设置只收 `false`**：HarnessHub 为已卸载插件写过的 `true` 不列为孤立设置，因为它和默认状态一样，不会在重装后造成意外。
  3. **账户同步插件的依赖**：读不到清单的同步插件不挡停用，只在确认框里说明没有核对；用户级插件读不到依赖时挡停用（裁决第 3 条）。
  4. **测试编号**：TOML 表与 Codex 开关是 G064-P1，Claude 开关是 G064-P2，插件模型与管理设置是 G064-P3，正式入口是 G064-P4，读取器是 G064-R6，页面是 G054-CA9。
- **已知行为**：
  - Claude 的运行中会话可能把旧值写回 `settings.json`，由漂移列表显示，不自动重试。
  - 存储不升版本；回退到旧构建时，`plugin/` 台账行在漂移列表里显示为“无法读取”。
- **验收**：G064-P1～P3、G064-R6（单元），G064-P4（集成），G054-CA9（浏览器）；变异核对：去掉依赖拒绝，或撤回 CRLF 修正，对应测试都会失败。真实环境见[插件验收](../verification/capability-plugins-2026-10-19.md)。
