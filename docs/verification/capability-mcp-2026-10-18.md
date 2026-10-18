# MCP 统一清单验收（2026-10-18，第 3 步 3a）

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

- 3b：Claude（官方命令与预演）。3c：DeepSeek Harness。OpenClaw 等升级后再接入。
