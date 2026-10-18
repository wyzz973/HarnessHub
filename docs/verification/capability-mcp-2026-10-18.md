# MCP 统一清单验收（2026-10-18，第 3 步 3a–3c）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 5 节与“审批代理对 MCP 统一清单的裁决”（七条，均已落实）。用户要求：“要做到我们的 harnesshub 能够统一的配置和读取”。

## 改动

- **新模块**（`src/infrastructure/capabilities/`）：
  - `mcp-definitions.ts`：中立定义；六种写法的读取与写回；每个 Harness 的可表达子集与自有键；密钥、地址、程序、参数、工作目录与变量名的规则。
  - `mcp-edits.ts`：Codex 表组、Hermes YAML 条目、JSON/JSONC 条目的定点编辑，以及每次编辑都要通过的校验。
  - `mcp-changes.ts`：清单的增删改、导入与认领、三方比较的状态，以及写入、移除的检查。
- **改动的模块**：
  - `changes.ts`：接入上述功能；漂移列表增加 MCP 项，重新应用走带 overwrite 的写入检查；孤立的停用设置不包括 MCP 项。
  - `switches.ts`：漂移读取 `mcp/<名>`。
  - `store.ts`：存储 v3，新增 `mcp_servers`；降级脚本 `tools/capabilities-v3-to-v2.sql`。
  - `masking.ts`：新增“名字或值像密钥”的判断。
- **接口**：`/capabilities/mcp`、`/mcp/servers`、`/mcp/servers/delete`、`/mcp/import`、`/mcp/claim`、`/mcp/sync`、`/mcp/remove`，契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
- **页面**：MCP 页签上方的“MCP 统一清单”（`McpInventoryPanel.tsx`）：服务器 × Harness 的状态矩阵、从现有配置导入、新建与编辑、从清单删除。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 187 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 400 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 40 通过，0 失败 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-M1～M3、G054-CA6 |

全套运行之后又改了一处：导入改用读到的原始定义，所以参数中间带家目录路径的服务器也能导入（显示时写成 `~`）；另给 Gemini 加了 `mcp.allowed` / `mcp.excluded` 的提示。改后补跑了 MCP 的单元与集成测试（7 项），全部通过；G064-M3 增加了这种情况的断言。

- **G064-M1**（单元）：
  - 六种写法读成同一个定义，并按各自的引用写回。
  - Codex 只能同名转发、请求头不能带前缀、不支持 SSE，Hermes 不支持 SSE，表达不了时拒绝并说明。
  - 密钥与非法写法的反例都被拒绝，普通设置可以是字面值。
  - Codex 表组整组增删；更新时保留用户的超时与工具审批，模型与 profile 逐字节不变。
  - Hermes 的条目增删按整行，删完回到 `{}`，并逐字节回原样；JSON 保留注释与用户的键。
- **G064-M2**（集成，经正式入口，临时家目录）：
  - 导入并认领 Hermes 的 fs，不改文件。
  - 写入 Codex 时只多出它自己的表；确认框写明会以用户身份运行的程序，以及所需变量是否已设置。
  - 写入 Gemini、Cursor 时用各自的引用写法，模型不变。
  - 清单改动后各处显示待更新；更新保留用户加的 `startup_timeout_sec`，家目录在回答里写成 `~`、写进文件时展开。
  - 从 Cursor 移除时只删 HarnessHub 写的那一项；仍有条目时不能从清单删除。
- **G064-M3**（集成）：
  - 用户自己的同名条目不覆盖。
  - HarnessHub 写的条目被手改后进入漂移列表，经重新应用写回。
  - SSE 服务器对 Codex、Hermes 不可写。
  - 非法定义被拒绝；变量改名的服务器对 Codex 阻止。
  - 降级到 v2 删除清单、MCP 的修改记录与台账，备份保留。
- **G054-CA6**（浏览器）：
  - 矩阵的状态与变量提示正确。
  - 写入先显示差异与要运行的程序，只发送这次检查。
  - 认领与导入不改文件，含明文密钥的不能导入；新建的服务器只保存变量名。

## 部署时发现并修正的问题

第一次部署 `0fdd5c4` 后，4317 读取清单时返回 500（PRIVACY_GUARD）：本机有服务器的环境变量字面值里写着家目录下的路径，而显示时只把程序、参数和工作目录换成了 `~`。隐私守卫按设计拦下了这个回答，没有把路径发给页面。修正：环境变量和请求头的字面值也换成 `~`，用户输入时只在开头展开 `~/`。G064-M3 加了这种情况的断言（带家目录路径的环境变量值显示为 `~/data`）。

修正后的只读核对又发现两处，也已修正并部署：

- **Cursor 的远程条目**：本机 Cursor 的远程条目只写 `url`，不带 `type`（只看了键名）。原来写入 Cursor 时会加上 `type: "http"`，改为与 Cursor 自己的写法一致；Claude 仍写 `type`。
- **名字不合规的服务器**：Cursor 里有一个名字带 `@` 和 `/` 的服务器，原来被静默跳过。现在列出来并说明原因（Codex 等不接受这类名字，请在原处改名后再导入）。G064-M2 加了这种情况的断言。

## 4317 部署与真实环境的只读核对

- **部署**：提交 `0fdd5c4`，修正 `596de9c`、`5dd63d4`，每次都按惯例进行：先确认空闲，克隆数据，在登录 shell 环境里构建、启动，核对后删除克隆。能力库由 v2 升到 v3。部署前后：会话 5、事件 1493、管理任务 15、能力修改 8、备份 8、台账 1。
- **可写**：Codex、Cursor、Gemini、OpenCode、Hermes。不可写的各附原因：Claude（下一步）、OpenClaw（等升级）、DeepSeek Harness（3c）。
- **9 个服务器**（Codex 5、Cursor 4），只打印了名字、传输方式和计数：
  - 可以收进清单：Codex 的 figma、langchain-docs、openaiDeveloperDocs（HTTP）和 node_repl（stdio，15 个普通字面值）；Cursor 的 Context7（HTTP）和 BroswerTools（stdio）。
  - 不能收进清单：postman（`POSTMAN_API_KEY` 是明文密钥，页面只出现键名）、computer-use（工作目录不是绝对路径）、@21st-dev/magic（名字不合规）。

## 第一次真实写入（审批同意，由我代为执行）

对象：Codex 的 openaiDeveloperDocs（HTTP，无请求头、无变量、无密钥）。经 4317 的接口执行：

| 步骤 | 核对 | 结果 |
|---|---|---|
| 写前 | `ps` 检测运行中的 Cursor：编辑器 0 个，cursor-agent 0 个；没有运行 `cursor-agent mcp list` | — |
| 导入并认领 Codex 的这一项 | 修改记录为 `mcp-claim`；`~/.codex/config.toml` 的 sha256 前后相同；清单里 Codex 显示“已写入” | 通过 |
| 写入 Cursor | 检查显示 3 行新增；实际改动与检查相同；只多了只含 `url` 的这一项 | 通过 |
| | 其他 4 个服务器（含 postman）与文件其余部分不变；缩进（2 个空格）、键序、末尾无换行、LF 都不变；权限 0644 与所有者不变；硬链接数 1；备份 0600 | 通过 |
| | Cursor 与 Codex 都显示“已写入”；漂移 0 | 通过 |
| 往返：从备份恢复 | 恢复后逐字节回到写入前；Cursor 显示“未写入”（恢复是 HarnessHub 自己的动作，台账一并撤回），不是“被外部移除” | 通过 |
| 再写回 | 与第一次写入的字节完全相同；两处都显示“已写入”；漂移 0 | 通过 |

- 修改记录依次是 `mcp-claim`、`mcp-sync`、`restore`、`mcp-sync`。
- Cursor 里可能要批准一次这个新服务器。postman 在 Cursor 配置里是明文密钥，建议用户自己改成环境变量引用，HarnessHub 不替他搬值。
- **待改进**：写入远程服务器时，检查的说明里写的是 Harness 的标识而不是名称（“cursor 会连接它”）；检测运行中的 Cursor 还没有做进产品，这次是脚本里做的。两处在 3b 一并修改。

## 3b：Claude Code 的 MCP（2026-10-18）

- **改动**：
  - `claude-mcp.ts`：Claude 命令的执行器（沙箱可写目录，加 `.claude.json*` 的路径前缀，禁网，在私有临时目录里运行）。
  - `changes.ts`：Claude 的副本预演，以及只比对服务器这一项的应用路径；运行中 Cursor 的检测。
  - `mcp-changes.ts`：Claude 可写，计划为 add-json、remove 加 add-json，或 remove；说明里写明会话可能冲掉写入，以及远程服务器的 OAuth 会丢失。
  - 页面：漂移列表里的“写入丢失”。
- **G064-M4**（单元）：用模拟的 Claude 命令（按真实程序观察到的行为）。
  - 检查在私有副本上运行，真实文件不变，确认框显示命令与 Claude 自己补的键。
  - 确认前会话改了其他键，照常写入。
  - 真实运行只可写 Claude 的文件和它的 backups、telemetry 目录。
  - 更新先删后加；会话写回旧副本后显示被移除，并进入漂移列表。
  - 确认后服务器被改动时拒绝；移除只删 HarnessHub 写的那一项。
- **G064-M5**（真实程序，`pnpm test:real:claude-mcp`）：本机 Claude Code 2.1.302，私有家目录，禁网沙箱。
  - 副本预演通过，真实文件不变。
  - 应用后这一项按 Claude 的写法写入，`${DOCS_TOKEN}` 保持引用；其他服务器、`numStartups` 和项目设置不变；留有备份。
  - 删除后只剩原有的服务器。
  - 通过。

## 3c：DeepSeek Harness 的 MCP（2026-10-18）

- **核实**：在本机已安装的 0.2.0-rc.2 里确认三点：补丁层的顺序与全局补丁 `$DSH_HOME/cordis.patch.yml`；补丁文件必须是顶层数组，否则启动失败；MCP 客户端行的格式。只看了用户 profile 补丁文件的结构（三个 profile 都是带注释的 `[]`），没有读取 `~/.dsh` 里的凭据文件。
- **G064-M6**（单元）：
  - `!!js` 引用的读写，`process.cwd()` 等同于不写工作目录；不支持 SSE；读不了的表达式拒绝。
  - 空列表里增删、原位替换，全部移除后逐字节回原样。
  - 原来没有的文件新建为列表，移除后留下 `[]`。
  - 单行非空列表与非列表的顶层被拒绝。
- **G064-M2**（集成）：
  - 读出 web profile 里用户自己的服务器作为可导入项。
  - 写入时新建只含 HarnessHub 那条 insert 的全局补丁，移除后文件是 `[]`。

## 3b、3c 部署前后发现并修正的问题

1. **Claude 的运行进程提示自相矛盾**：MCP 检查沿用了技能开关的提示“有 N 个 Claude Code 进程在运行，它们会立即读到这次改动”。这句话只对技能开关成立（Claude 监视技能开关），却和“新开的会话会读到它”并列。现在 MCP 检查只报进程数，技能开关的提示不变（3e6d515；G064-M4 增加断言）。
2. **dsh 的服务器名长度**：dsh 客户端的 `serverName` 规则是 `^[A-Za-z0-9_-]{1,32}$`，清单允许 64 个字符。33 到 64 个字符的名字会写进补丁，直到 dsh 加载时才失败。现在这样的服务器在 dsh 显示“不支持”并拒绝写入（2f6f59c；G064-M6、G064-M3 增加无效样例）。
3. **差异把末尾换行算成一行**：公用的差异生成器按 `\n` 切分，新建文件的差异多一个空的 `+` 行，行数多一（dsh 的 7 行补丁显示成 `+1,8`）；改动靠近文件末尾时，还会多出一个空白的上下文行。现在末尾换行算作行结束，没有末尾换行的最后一行后面按 git 的格式加 `\ No newline at end of file`，只改末尾换行的差异也能显示（e67b277；G064-W1 增加用例，ACP 协议测试的期望随之更新）。
- **检查结果**：e67b277 上 unit 190/190、protocol 144/144、integration 400/400、browser 40/40，设计检查通过。
- **发现但未处理**：部署目录里有一个 10 月 11 日留下的管理检查目录 `data/management/native-inspect-BqWjR0`（432K，node 编译缓存与 npm 日志）。检查结束时如果清理失败或服务被停，这类目录之后不会被清扫。留作后续：服务启动时清扫十分钟前、属于本用户的这类目录。

## 3b、3c 的第一次真实写入（审批同意，由我代为执行）

- **前提**：
  - 4317 运行 e67b277（PID 46973），全量检查结果见上一节。部署目录另有未跟踪的 `docs/HANDOVER.md`，与代码无关，没有动。
  - 本机有三个 `claude`（cmux 的 shim、nvm v26.11.1、`/opt/homebrew/bin`），都是 2.1.302；4317 按它自己的 PATH 解析到 nvm v26.11.1 那份。
- **审批**：Fable 5.1 审批子代理批准两项，认为都在“无密钥、可撤销、与统一配置直接相关”的授权内。它附加的条件都执行了：
  - 差异上下文行只报键名；
  - 写入期间不新开 Claude 会话；
  - 等 30 秒复查；
  - Claude 的备份只列名字和权限；
  - dsh 的 dump 前后核对根文件哈希；
  - 启动检查限时 30 秒；
  - 核对 dsh 的 sessions 与 storages 没有新增。

  它还定下了各种异常情况下的停止与恢复规则，这次一条都没有触发。
- **决定**：两者都做往返验证，最后保持移除。
  - 理由：用户要的是统一配置的能力，没有点名要把这个服务器加进日常工具，以后可以在页面上自己写入。
  - dsh 留下 HarnessHub 自建的 3 字节 0600 文件，内容是 `[]`，dsh 把它当作文件不存在。要回到“不存在”可以手动删除；“移除最后一行时删掉自建的文件”记为待决项。
- **DeepSeek Harness**（先做，因为没有运行中的 dsh）：
  - **写入前**：
    - 没有 dsh 进程，文件不存在，状态 absent。
    - `dsh --profile acp --dump-config` 退出 0，输出 380 行，没有家目录层。
    - sessions 15 个条目、329 个文件；storages 4 个条目、272 个文件。
  - **写入**（change decd0cac）：
    - 新文件 233 字节、7 行、0600、属主 501，sha256 17e52c5b… 与确认框计划的字节一致。
    - 没有备份，因为是新文件；实际改动与显示的改动相同。
    - 状态 synced，没有漂移。
  - **dsh 自己的合成**：退出 0，输出 387 行，出现家目录层和 HarnessHub 写的那一行（1 个 MCP 客户端）；acp 根文件的哈希在 dump 前后都是 c300dcf2…。
  - **只发 `initialize` 启动一次**：503 毫秒应答，stderr 0 行，没有停用或未激活的条目，进程全部退出，sessions 和 storages 不变。
  - **移除**（change e252087d）：文件变成 `[]\n`（3 字节，哈希与常量一致），dump 回到 380 行，状态 absent，没有漂移。
  - **连接证据**：又做了一次同样的往返写入（change 318b842d、e3e2a27c），最后仍然移除；启动期间每 0.2 秒采样 dsh 的 TCP 连接。
    - 基线（`[]`）29 次采样，没有任何连接。
    - 有这一行时，约 610 毫秒建立了一个到 :443 的连接，29 次采样中 20 次看到。
    - 结论：HarnessHub 写的配置在真实的 dsh 里生效，客户端启动时就去连接服务器。
    - 第一次启动检查只在约 6.5 秒时取了一次快照，那时连接已经关闭，所以没看到。
    - 工具在会话里能不能用没有验证，因为那需要新建会话。
- **Claude Code**：
  - **写入前**：
    - 4 个 Claude 会话在运行（其中一个是我自己）。
    - `~/.claude.json` 是 0600、属主 501、单链接，没有 MCP 服务器，状态 absent。
    - `~/.claude/backups` 里有 5 个文件。
  - **检查**：
    - 命令是 `claude mcp add-json openaiDeveloperDocs '<json>' -s user`。
    - before 为 null；Claude 没有额外补键，也没有改动其他键。
    - 差异上下文行的键名是 `rc-active-badge`、`teamOnboardingLastUsedAt`、`cachedGrowthBookFeaturesAt`，不是账号或凭据字段。
  - **写入**（change c3b5886c，备份 633102df，0600）：
    - 这一项只有 `type: http` 和 `url`。
    - 其他服务器和其他顶层键都没变；文件仍是 0600、属主不变、单链接。
    - 状态 synced；会话数前后都是 4。
  - **30 秒后**：这一项还在，文件哈希和刚写入时相同，说明没有会话写回旧副本，也没有漂移。
  - **移除**（change f4528a6f，`claude mcp remove openaiDeveloperDocs -s user`）：
    - 这一项消失，文件哈希回到写入前的 434bee0f…，逐字节回到原样；状态 absent。
    - 30 秒后仍不在，没有漂移。
  - **Claude 自己的备份**：
    - 这次运行新增 1 份 `.claude.json.backup.<时间>`（0600），并按 Claude 只保留 5 份的规则删掉了最旧的一份。
    - 5 份都是完整配置，都是 0600。
    - 从时间戳看，运行中的会话每隔几分钟就写一份，这是 Claude 自己的行为。
- **结论**（分开表述）：
  - 设计：ADR-045 第 3 步已采纳。
  - 代码：已完成。
  - 测试：通过（见上一节）。
  - 真实引擎：
    - Claude Code 2.1.302 的写入与移除通过。
    - DeepSeek Harness 0.2.0-rc.2 的合成、启动与连接通过，会话里的工具没有验证。
  - 只做 macOS，没有 Windows 验证。

## 3b 的前置核实：Claude 的官方命令（真实程序，私有目录）

按审批第 5 条，先用真实程序确认 `CLAUDE_CONFIG_DIR` 下 `.claude.json` 的位置。

- **做法**：本机 Claude Code 2.1.302（nvm v26.11.1 那份），HOME 与 `CLAUDE_CONFIG_DIR` 都指向临时目录，在 macOS 沙箱里运行（禁网，只可写临时目录）：`claude mcp add-json probe '<json>' -s user`。
- **结果**：
  - 退出码 0，输出 “Added stdio MCP server probe to user config”。
  - 写入的是 `$CLAUDE_CONFIG_DIR/.claude.json`（HOME 下没有），`mcpServers.probe` 与给定的 JSON 一致，`${PROBE_TOKEN}` 原样保留。
  - 它还写了 `$CLAUDE_CONFIG_DIR/backups/.claude.json.backup.<时间>`；禁网时还写了 `$CLAUDE_CONFIG_DIR/telemetry/` 下的一个发送失败记录。
  - 全新配置时它补上了 machineID、userID、迁移版本等键。所以对真实文件的副本预演时，差异可能包含 MCP 以外的改动，要汇总显示；应用后只比对 `mcpServers.<名>` 子树。
- 临时目录用后已删除。
- **顺带的发现**：这个会话的进程读不了旧仓库目录 `/Users/sd3/Desktop/project/HarnessHub`（EPERM，沙箱外也一样），所以从那里运行 `claude` 会报 “An unknown error occurred (Unexpected)”；从其他目录运行一切正常。这与 HarnessHub 无关，没有去改它。

## 未验证与后续

- OpenClaw 等升级后再接入。
- DeepSeek Harness 的 MCP 工具在会话里能不能调用，没有验证，因为需要新建会话。
- 待决：移除最后一行时，是否删掉 HarnessHub 自建的 `~/.dsh/cordis.patch.yml`。现在的做法是留下 `[]`。
- 管理检查目录的启动清扫，见“3b、3c 部署前后发现并修正的问题”。
