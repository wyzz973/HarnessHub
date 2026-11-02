# R8 · 补充调研：各焦点 Harness 的输入落盘时机与“已送达”证据（源码级）

调研员 R8（Claude Opus 5.5 子代理）。阅读日期 2026-11-02（按简报口径；本机时钟已跨入 11-03 凌晨）。仓库 `HarnessGateway-relay`，分支 `cc/relay-design`（HEAD `07a0825`）。本文件是 R8 在仓库中唯一写入的文件。

标注约定：**【事实】** 打开源码、文档或本机安装包可复核；**【推断】** 由事实推出、未经真机验证；**【建议】** 只是设计建议，不是已接受的决定。来源编号见第 7 节。全文没有任何真机结论。

**一句话结论**：六家都在**第一次模型请求之前**把用户输入写进原生历史，所以“Provider 拒绝、超窗、限流”并不会丢输入；真正让水位说谎的是另外四类情形——接口或适配器在插入前拒绝、Hub 驱动自己合成的“未发送”结果、插入前的取消，以及清空和回退类原生命令。“已送达”必须定义为 **Driver 拿到的、该输入已进入原生历史的正面证据**，与回合的 completed、failed、cancelled 终态脱钩。四份报告的四种判据：D13 与 I-3 有条件成立，D11 与 H3 不成立。

---

## 1. 范围与方法

### 1.1 对象（版本只作证据，ADR-053）

| Harness | 本机版本与位置 | 写入原生历史的层 | Hub 控制入口与恢复方式 |
|---|---|---|---|
| Claude Code | CLI 2.1.316（`~/.nvm/…/@anthropic-ai/claude-code/bin/claude.exe`，Hub 经 `CLAUDE_CODE_EXECUTABLE` 绑定它而非 SDK 自带二进制 [S8]）+ `@agentclientprotocol/claude-agent-acp` 0.99.1（内含 claude-agent-sdk 0.3.312、ACP SDK 2.1.0） | CLI（转录 JSONL） | ACP；`session/resume`（不回放） |
| Codex | 0.166.0；上游 `openai/codex` tag `rust-v0.166.0` → commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` | core + rollout 写线程 | app-server；`thread/resume`（`excludeTurns: true`） |
| OpenCode | 2.2.5；上游 `anomalyco/opencode` tag `v2.2.5` → commit `9bbb8ce18c80f099e0e448775f59d965ead40a21` | 私有 `opencode serve --stdio` 的 core（SQLite） | `opencode acp`；`session/resume`（不回放） |
| DeepSeek Harness（dsh） | `@deepseek-ai/dsh` 0.2.1-rc.5（nvm 全局） | agent loop + JSONL 持久化插件 | `dsh --profile acp`（通用 `AcpControl`）；只有 `session/resume` |
| Hermes Agent | v0.22.5（`~/.hermes/hermes-agent` @ `bf0203a794`，2026-10-22） | launchd 网关里的 agent（会话库） | `hermes acp` 网关查看器；`session/load`（每回合全量回放） |
| OpenClaw | 2026.10.9（`/opt/homebrew/lib/node_modules/openclaw`） | 网关嵌入式运行时（SQLite 转录） | `openclaw acp` 桥 + `gateway call`；`session/resume`（不回放） |

WorkBuddy 尚未接入，不在本报告范围。

### 1.2 方法与来源类型

- **HarnessHub 侧**：逐行阅读 `runtime.ts:1303–1510` 以及 `src/adapters/control/` 下的 `acp.ts`、`claude.ts`、`codex.ts`、`opencode.ts`、`hermes.ts`、`openclaw.ts`、`factory.ts`，还有 `contracts/control.ts`。
- **本机安装包只读源码**：
  - claude-agent-acp 的 `dist/*.js`，以及 SDK 的 `sdk.d.ts`、ACP SDK 的 v2 schema；
  - dsh 各插件包的 `lib/index.js`；
  - Hermes 的 `acp_adapter/`、`gateway/`、`agent/`（只看这三处源码，没有打开 sessions、memories、`state.db`）；
  - OpenClaw 的 `dist/*.mjs` 与随包 `docs/`。
- **原生二进制**：Claude CLI 只做 `strings -n 8`，再用一个只读的 mmap 小脚本截取上下文窗口（scratchpad `relay/r8tools/win.py`）。Claude 2.1.316 是压缩过的 JS，结论只依据其中可读的属性名、字符串与性能打点名（如 `transcript_persist`）。
- **固定 tag 的上游源码**：用 `gh api` 把 tag 解析成 commit，再用 `/usr/bin/curl` 从 raw.githubusercontent 下载单个文件到 scratchpad `relay/r8/codex-src`、`relay/r8/opencode-src`，逐行阅读。
- **协议规范**：用 curl 抓取 agentclientprotocol.com 的 `.md` 页面（v1 prompt-turn、session-setup，v2 prompt-lifecycle，RFD message-id、v2 prompt）。WebFetch 工具连接失败，所以没用它。
- **二手交叉核对**：R5 由本机 Codex 0.166.0 二进制生成的 TS/JSON schema（[S31]），只用来核对字段名，主证据仍是固定 tag 的源码。

运行过的命令：`claude --version`、`dsh --help`、`strings`、`gh api`、`curl`、`grep`、`sed`、Python 只读脚本。没有启动任何 Harness 会话或提示，也没有运行 `codex app-server generate-*`。没有改用户配置，没有碰 4317 与 `data/`，没有读用户对话内容。

### 1.3 局限

- **全部结论都没有真机证据**，第 6.2 节给出核实配方。
- Claude CLI 的时序结论来自压缩代码中的片段，置信度标为“中高”。
- OpenClaw 是打包产物，只读了 ACP 桥、`chat.send` 处理器与用户回合记录器三个模块，以及文档。
- Hermes 网关“查看器死亡后回合继续”以及 OpenCode “取消后的僵尸输入”是推断，必须真机核实。

---

## 2. 发现

### 2.0 HarnessHub 现状：水位何时推进，驱动丢掉了哪些证据

1. 【事实】回合结算时，`runtime.ts:1492–1497` 推进绑定水位（`throughRunId = run.id`）需要同时满足四个条件 [S1]：
   - 已存检查点；
   - 进程被保留，或干净关闭；
   - 已派发时 `nativeConfirmed && backend !== null`；
   - 只要 `execution.dispatched` 为真就推进（1496）。

   **与 `backend.status` 无关**：completed、cancelled、failed（REMOTE_ERROR 被驱动包成 `failed/request_rejected`，`acp.ts:557–560`、`codex.ts:525–528`）都会推进。只有 `backend === null`（进程或协议故障、超时）时记为 unknown（1481），会话 blocked，绑定停在 `unconfirmed`，水位不动 [S1][S2][S4]。

2. 【事实】`dispatchedAt` 在调用 `startText` **之前**提交（1415–1417）。它只说明 Hub 打算发送，不说明原程序收到 [S1]。

3. 【事实】Hub 已经收到、却丢掉的证据：

| 驱动 | 已收到但被丢弃 | 位置 |
|---|---|---|
| ACP 通用 | 活动提示期间的 `user_message_chunk`（解析后不产生事件） | `acp.ts:653–665` [S2] |
| ACP 通用 | `session/load` 回放中的 user 与 agent 文本（只在 import 时收集） | `acp.ts:619–625` [S2] |
| Codex | `item/started`、`item/completed` 中 `type: "userMessage"` 的条目 | `codex.ts:706` [S4] |
| OpenClaw | 回合后 `sessions.get` 已读回本回合的转录行，但 `reconcileTurn` 只处理 assistant 与 toolResult；cancelled 回合干脆不读 | `openclaw.ts:132–174、440` [S7] |
| Claude | 没有请求适配器的原始 SDK 消息；扩展通知只认 `_auth/status_update` | `claude.ts:58–63` [S3] |

4. 【事实】驱动自己合成、根本没有发给原程序的结果，同样推进水位：
   - OpenClaw 选模未确认时返回 `failed/model_not_applied`（`openclaw.ts:91–94、422–423`）；
   - Claude 的 `/remote-control` 拒绝与 Hub 自带的 `/export`（`claude.ts:24–25、70–72`）；
   - Codex 与 Hermes 的 `/export`（`codex.ts:506–507`、`hermes.ts:134–136`）；
   - OpenCode 的 `COMPACT_IGNORED`（`opencode.ts:79–84`）。

   其中 export 与 compact 属于命令回合，本来也不该推进（D1）；`model_not_applied` 却是普通内容回合，会实打实地丢掉增量 [S3–S7]。

5. 【事实】执行顺序是先在 1334–1340 计算增量，再在 1345–1375 打开原生会话，最后在 1392 组装输入。所以任何需要在 open 之后才能做的核对（例如 Hermes 回放）目前插不进来 [S1]。

### 2.1 协议层：ACP v1 / v2 怎样定义“受理”“插入”“持久”

- 【事实·v1 稳定】`session/prompt` 一直持续到回合结束，响应只带 `stopReason`（end_turn、max_tokens、max_turn_requests、refusal、cancelled）。规范要求取消后以 `cancelled` 应答。v1 **没有**插入确认 [S15]。
  - Message ID RFD 于 2026-06-05 进入 Completed，v1 只稳定了可选的、由 Agent 生成的 `messageId`。2026-06-02 的修订**删除了**客户端提示 ID 与 prompt 响应确认（`userMessageId`）[S18]。
  - `session/load` 必须用 `session/update` 重放整段对话；`session/resume` 不得重放 [S16]。
- 【事实·v2 提案（RFD，docs 已有 `protocol/v2/*` 页面；ACP SDK 2.1.0 标为 experimental）】
  - 受理等于插入：Agent 把用户消息逻辑上加入对话、分配 `messageId` 并确定位置后才应答，此前不得应答；插入之后即使失败或被取消，也不得再返回错误。
  - 插入前被拒绝必须返回 JSON-RPC 错误，且不得发出 user-message 更新。
  - 适配器可以拿运行时的用户回显或插入事件当插入证据。
  - 关键限制：插入既不承诺持久存储，也不承诺模型已消费；Agent 不必保留它；响应丢失时，提交结果不确定，重试可能产生第二次提交 [S17][S19]。
- 【事实】claude-agent-acp 0.99.1 已实现 v2：`v2Prompt` 在 `events.inserted` 时发 `user_message` 并以 `{messageId}` 应答（`dist/v2/prompt.js:1–45`）。v1 路径里 `inserted()` 是空函数（`acp-agent.js:2135–2141`）[S10][S11]。HarnessHub 只协商 v1，返回别的版本即视为失败（`acp.ts:177–180`）[S2]。
- 【推断】就算将来改用 v2，插入事件也只能作为“已受理”的标准化证据，不能当作“已持久、会被下一次请求读到”的证明。持久与否仍要看各家实现，也就是下面各节的内容。

### 2.2 Claude Code（CLI 2.1.316 + claude-agent-acp 0.99.1）

| # | 问题 | 结论 | 证据位置 | 核实方式 | 置信度 |
|---|---|---|---|---|---|
| C1 | 何时、由谁写入 | 【事实】适配器把一次 ACP prompt 的所有块合成**一条** Claude user message，推入 SDK 输入流，同时打上 `origin: human` 和 `uuid = promptUuid`。各块的处理：text 原样；`resource_link` 变成链接文字；text resource 变成链接文字，并在同一条消息末尾附 `<context ref>` 文本块；图片和 PDF 转成对应的块；**audio 和 v1 不支持的 blob 被静默丢弃**。【事实】真正写转录的是 **CLI 的 print/SDK 提交路径**：`processUserInput` 之后先 `await` 转录写入（打点 `conversation_append → transcript_persist`），再计算 `--replay-user-messages` 的回显、刷新工具池、组装 init 帧，最后进入模型请求。转录写队列 `FLUSH_INTERVAL_MS=100`，每 100 ms 批量 `appendToFile`，写完才 resolve；写失败只记 “Transcript write failed” 也 resolve；只有设置了 `CLAUDE_CODE_EAGER_FLUSH` 或 `CLAUDE_CODE_IS_COWORK` 才额外 flush。→ **模型请求之前**写入；写入层是 CLI。 | acp-agent.js:10316–10399（`promptToClaude`）、2222–2293（`session.input.push`）、9090–9093（`replay-user-messages`）；claude.exe strings：`Wb("transcript_persist")` 所在提交段（`strings -n 8` 输出约 44.33 MB 处）、`FLUSH_INTERVAL_MS=100`、`enqueueWrite` 与 `drainQueuesOnce`（约 25.19 MB 处） | 本机源码逐行；二进制 strings 截取可读片段 | 适配器：高；CLI 时序：中高 |
| C2 | 回合被取消（`session/cancel`） | 【事实】`cancelTurns` 先 `query.interrupt()`。已被 CLI 取走的提示（已回显，或收到 `command_lifecycle started`）已写入，CLI 另写 `[Request interrupted by user]` 标记。还在 SDK 队列里的提示，适配器直接以 cancelled 结算并从 CLI 队列撤下，**不写入**。`command_lifecycle cancelled` 帧本身有歧义：可能是派发前被丢，也可能是派发后被中止。【推断】Hub 每次只有一个提示，这个窗口是从 push 到 CLI 完成 `processUserInput` 的毫秒级时间。 | acp-agent.js:6392–6600、4105–4152；strings `[Request interrupted by user]` | 源码；strings | 中高 |
| C3 | Provider 拒绝（超窗、4xx、限流、额度、登录） | 【事实】**已写入**，因为转录在请求之前写。CLI 还把合成的 API 错误助手消息（`isApiErrorMessage`，model `<synthetic>`）记进转录：适配器重放时按“前一条已持久的 user uuid 就是 live prompt uuid”恢复额度受限这类失败。“Prompt is too long” 还会触发反应式压缩。适配器用 `failActiveWithSessionFailure` 返回 JSON-RPC internalError，并附 `data.errorKind`（rate_limit、invalid_request、authentication_failed、overloaded…）。Hub 记成 `failed/request_rejected` 并推进水位——**这里推进碰巧是对的**。 | acp-agent.js:5456–5530、9907–9909、7225–7250；session-failure-extension.js:329–357；strings `Prompt is too long` | 源码；strings | 适配器：高；合成错误消息落盘：中 |
| C4 | 适配器参数校验失败 | 【事实】以下情形在入队前拒绝，**不写入**：`sessionNotFound`、查询流已结束（`SESSION_ENDED_MESSAGE`）、Remote Control 冲突、会话已拆除（以 cancelled 结算，但从未插入）。【事实】v1 不报错，而是**静默丢掉**无法转换的块，其余块照常写入。所以交接标记不能只放在 resource 块里。 | acp-agent.js:2149–2255、10340–10390；claude.ts:24–25、70 | 源码 | 高 |
| C5 | 进程在回合中被杀 | 【推断】回显之后被杀：转录 append 已完成（进入 page cache，没有 fsync，进程死亡不丢）。回显之前被杀（≤100 ms 写队列加处理时间）：整条可能丢失。流式到一半的助手内容不写，消息完成时才写。【事实】Hub 侧 `backend === null`，记为 unknown，不推进水位，绑定 unconfirmed。 | strings `FLUSH_INTERVAL_MS=100`、`drainQueuesOnce`；runtime.ts:1481、1492 | 推断 | 中 |
| C6 | 输入是原生斜杠命令 | 【事实】本地命令（/model、/status、/usage、/context、/mcp 等）以“仅标记”记录写入转录，重放时隐藏。`/compact` 写压缩边界与摘要。技能和自定义命令以 `<command-name>` 标记写入，可以重放。 | acp-agent.js:724–735 | 源码 | 中高 |
| C7 | Hub 能收到的证明事件 | 【事实】**ACP v1 默认没有**：适配器用 CLI 的 `isReplay` 用户回显激活回合后，把自己这条回显从 feed 里丢掉；prompt 响应只有 `stopReason`、`usage` 与 `_meta.quota`。【事实】有一个可选通道：会话 `_meta.claudeCode.emitRawSDKMessages` 接受布尔值或 `{type, subtype, origin}` 过滤器，适配器据此把原始 SDK 消息以扩展通知 `_claude/sdkMessage` 转发。转发发生在丢回显**之前**，所以过滤 `{type:"user", origin:"human"}` 就能拿到“已写转录、模型请求之前”的回显，带 uuid 与完整内容。`{type:"command_lifecycle"}` 能拿到 started 与终态帧，但 started 早于持久化，不能单独作证。【事实】适配器在 push 提示**之前**可能先发一次 `plan`（未完成的任务计划），所以 Hub 的 `firstOutputAt` 会早于插入。【事实】Hub 驱动目前没有请求原始消息。 | acp-agent.js:2135–2141、4038–4043、4045–4100、5806–5889、9615–9623、511、9474、2219–2221；claude.ts:58–63 | 源码 | 源码：高；过滤器在真机上是否命中回显：未核实 |
| C8 | 事后核对 | 【事实】Hub 对 Claude 用 `session/resume`，不回放。`session/load` 经 SDK `getSessionMessages` 重放整个转录：用户文本（含 `<context ref>` 块）作为 `user_message_chunk`。隐藏的有：`/compact`、`/model` 等仅标记命令，来自对端或频道的 meta 消息，合成的登录消息。【建议】更便宜的做法：Driver 只读本会话 `projects/<项目>/<会话>.jsonl` 的尾部（ClaudeControl 的 `/export` 已经有同样的定位逻辑），按 promptUuid 或包内标记匹配。 | acp-agent.js:6978–7250、902–930；claude.ts:76–96 | 源码 | 高 |
| C9 | `/compact`、`/clear` 等的影响与公告 | 【事实】公告列表 = SDK `supportedCommands` 减去 {clear, cost, keybindings-help, login, logout, output-style:new, release-notes, todos}，再减去终端专用命令，加上 `mcp` 与 `remote-control`。`compact`（压缩）和技能（保持）都在列。【事实】CLI 的 `clear` 命令有别名 `reset`、`new`，`supportsNonInteractive: true`，语义是“开新会话、上下文清空、旧会话留在盘上”。【推断】适配器不公告它，但会把 `/clear` 原样交给 CLI 执行。Hub 在“没有新增来源”时原样发送任何输入（runtime.ts:1392），所以用户在 Hub 里打 `/clear` 会清空 Claude 的原生上下文，而绑定照常推进。进程重启后按旧的 ACP 会话 id resume，可能又回到清空前的转录（未核实）。 | acp-agent.js:10212–10300；strings `name:"clear"…aliases:["reset","new"],supportsNonInteractive:!0`（约 26.52 MB 处） | 源码；strings | 公告：高；执行效果：中 |

### 2.3 Codex 0.166.0（app-server JSON-RPC）

| # | 问题 | 结论 | 证据位置 | 核实方式 | 置信度 |
|---|---|---|---|---|---|
| X1 | 何时、由谁写入 | 【事实】`turn/start` 在 app-server 做完全部校验后调用 `start_or_steer_turn`，一提交就返回 `{turn: {status: inProgress, items: []}}`，**此时尚未写入**。【事实】core 的 `run_turn` 依次是：上下文更新 → 技能与插件 → session-start hooks → UserPromptSubmit hooks（`run_hooks_and_record_inputs`）→ `record_pending_input` → `record_user_prompt_and_emit_turn_item`。最后一步先把输入写进内存历史，并交给 rollout 后台写线程（mpsc 容量 256；已物化的 rollout 立即 `write_all` + `flush`，没有 fsync）；再发 `item/started` 与 `item/completed`（userMessage，带 `clientId`）；再 `ensure_rollout_materialized`，这是 Persist 屏障，等写完回执，新线程在这里第一次物化。之后才采样。→ **模型请求之前**写入；写入层是 core 加 rollout 写线程。 | turn_processor.rs:495–717；turn.rs:175–395、956–1008；hook_runtime.rs:750–807；session/mod.rs:5489–5552、4979–4987、1544–1561；recorder.rs:1825–1870、1950–1960、1993–2030、2156–2162（均为 rust-v0.166.0） | 固定 tag 源码逐行 | 高 |
| X2 | 回合被取消（`turn/interrupt`） | 【事实】Hub 先等 `turn/started`，再发 `turn/interrupt`（codex.ts:555–562）。中断发生在写入之后：输入已写入；core 还会记一条 `<turn_aborted>` 标记（contextual user 或 developer 角色），**先 flush 再发 TurnAborted**，源码注释说明有客户端一收到中断事件就同步重读 rollout。中断发生在写入之前：大多数早退路径**会先记录输入再返回**，包括预采样压缩失败、MCP 启动需求被取消、step context 遇到 TurnAborted；**不记录**的只有几条：技能与插件构建被取消（返回 None）、session-start hook 要求停止、上下文更新出错、非中断类的 step context 错误。 | turn.rs:198–300、329–343；tasks/mod.rs:962–1075；context/turn_aborted.rs | 源码 | 高 |
| X3 | Provider 拒绝 | 【事实】**已写入**。遇到 ContextWindowExceeded 只把 token 用量置满并返回错误。`Error` 事件是瞬态的，不进 rollout；rollout 持久化的是 TurnStarted、TurnComplete、TurnAborted 和 ItemCompleted。Hub 收到 `turn/completed` failed（带 codexErrorInfo）并推进水位，这次也碰巧正确。 | turn.rs:1842–1845；policy.rs:127–175 | 源码 | 高 |
| X4 | 接口参数校验失败 | 【事实】以下情形返回 JSON-RPC 错误，**不写入**：线程不存在、子代理直连、模型提供方检查失败、`toolOutput` 与 input 组合非法、`input_too_large`（超过 1,048,576 字符）、`additionalContext` 校验失败、环境或设置构建失败、`NotSubmitted`（服务排空中）。Hub 把“REMOTE_ERROR 且尚无 turnId”记成 `failed/request_rejected` 并**推进水位**，这是 D11 真正会丢增量的地方。【推断】Hub 信封上限是 1 MiB **字节**，再追加 fileMentions，就可能越过 1,048,576 **字符**。【事实】UserPromptSubmit hook 拦截时，回合以 completed 结束，却没有任何 userMessage。 | turn_processor.rs:502–690；turn.rs:956–1008；codex.ts:525–528 | 源码 | 高 |
| X5 | 进程在回合中被杀 | 【事实】userMessage 事件之后约一毫秒内就有 Persist 屏障，所以那之后被杀，rollout 里已有这条输入。新线程在第一次 Persist 之前被杀时，rollout 文件可能还没创建（deferred creation），恢复会失败。 | recorder.rs:1825–1834、1093–1118 | 源码 | 高（代码）；未真机 |
| X6 | 输入是原生斜杠命令 | 【事实】app-server 本身没有斜杠命令，Hub 合成三类：`/compact` 调 `thread/compact/start`，**不写用户消息**，只产生 contextCompaction；`/export` 不发给模型；`/skill:<name> …` 变成 turn/start 的 text 加 skill 输入项，作为 userMessage 写入。 | codex.ts:104、250、500–513 | 源码 | 高 |
| X7 | 证明事件 | 【事实】`item/started` 与 `item/completed` 的 `userMessage`（`id`、`clientId`、`content`）在写入之后、模型请求之前发出。turn/start 的**稳定字段** `clientUserMessageId` 会原样出现在 `userMessage.clientId`（turn/steer 也有这个字段）。`turn/completed{interrupted}` 在中断标记 flush 之后才发。【事实】Hub 不发 `clientUserMessageId`（codex.ts:514），还在 codex.ts:706 **丢掉**了 userMessage 事件。 | v2/turn.rs:180、323；protocol/items.rs:83–89；session/mod.rs:5547–5551；codex.ts:514、706；[S31] ThreadItem.ts:45 | 源码；生成 schema 交叉核对 | 高 |
| X8 | 事后核对 | 【事实】`thread/turns/list`（`itemsView: full`）和 `thread/items/list` 返回的 ThreadItem 与实时通知相同；Hub 的 importSession 已经在用 turns/list。【推断】paginated 历史模式持久化 ItemCompleted（含 clientId）；legacy 模式只持久化旧式 UserMessage 事件，clientId 可能缺失，需要退回文本标记匹配。【事实】`thread/inject_items` 的写入有两种：没有活动回合时直接进历史和 rollout，没有 Persist 屏障（新线程物化之前只在内存里）；有活动回合时并入该回合的待处理输入。注入的原始 ResponseItem 在 turns/list 中是否可见，未核实。 | README.md:647–667；policy.rs:228–288；inject.rs:74–103、173–201；turn_processor.rs:976–1005；codex.ts:395 | 源码 | 中高 |
| X9 | 命令的影响与公告 | 【事实】没有原生公告。Hub 由 `skills/list` 生成 `skill:*`（保持上下文），另加 compact（压缩：保留最近不超过 20k tokens 的用户消息，并重新注入规范上下文 [S9]）和 export（无影响）。没有清空类命令。 | codex.ts:104、250 | 源码 | 高 |

### 2.4 OpenCode 2.2.5（`opencode acp`）

| # | 问题 | 结论 | 证据位置 | 核实方式 | 置信度 |
|---|---|---|---|---|---|
| O1 | 何时、由谁写入 | 【事实】`opencode acp` 只是私有 `opencode serve --stdio` 的 HTTP 客户端。ACP 层的 `prepare` 做四件事：生成用户消息 ID（`SessionMessage.ID.create()`）；把带 `annotations.audience: ["assistant"]` 的文本拆成 synthetic；把带 `["user"]` 的文本**直接丢掉**（标为 ignored，不进可见文本）；检测斜杠命令。`submit` 先调 `session.synthetic`（delivery steer、resume false），再按情况调 compaction、command 或 prompt。【事实】core 的 `Session.prompt` 不可中断：按消息 ID 做幂等对账 → prepare（插件 hook、附件物化）→ **admit**，发布 `InboxEnqueued`，投影器在同一事件事务里写入 inbox 行（**持久的待处理输入**）→ wake。runner 执行时 **promote**：发布 `InboxDelivered`，同一事务里删除 inbox 行并插入可见消息；模型只基于“已记录的会话历史”运行。→ 准入在 HTTP 返回前持久，**送达在模型步骤之前**。 | acp/prompt.ts:21–43；acp/content.ts:17–26；acp/turn.ts:226–259；core/session/session.ts:155–190、286–327；inbox.ts:191–224、299–330、348–372、574–610；runner/index.ts:30–41（均为 v2.2.5） | 固定 tag 源码 | 高 |
| O2 | 回合被取消 | 【事实】ACP 回合只有收到自己消息 ID 的 `session.inbox.delivered` 才算 started（translate.ts:126–128）。取消时 windDown 调 `session.interrupt`，未 started 的直接以 cancelled 返回。【推断】还没送达的提示仍是一条持久的 steer 待处理行：core 的中断不清理 steer 行（它们要么仍可 promote，要么已完整送达），ACP 层也没有调用 `cancelInbox`。所以**下次执行被唤醒时（例如下一条提示），它会被一起送达**——“僵尸输入”。已送达之后取消，输入已写入。 | translate.ts:126–128；turn.ts:261–279；execution.ts:151–170；session.ts:140–150 | 源码；推断 | 中（必须真机） |
| O3 | Provider 拒绝 | 【事实】已送达，因为 started 之后才会有步骤事件。失败的助手消息由 `failAssistant` 记录。ACP 返回 ServiceFailureError（带 errorName）或 AuthRequiredError；aborted 和 content-filter 不报错。 | translate.ts:132–147；runner/step.ts:180–230 | 源码 | 高 |
| O4 | 参数校验失败 | 【事实】以下情形**不准入**：图片既无 data 也无 uri（InvalidRequest）、会话不存在、`PromptConflictError`（同一 ID 不同内容）、`AttachmentError`、`SkillNotFoundError`。【推断】如果同一个 prompt 还带了 synthetic 块，synthetic 已经先准入；prompt 失败后，synthetic 留在 inbox，等下次唤醒送达。 | prompt.ts:22–24；session.ts:155–190；turn.ts:228–257；core/session/prompt.ts:34–90 | 源码 | 中高 |
| O5 | 进程在回合中被杀 | 【事实】准入和送达都是 SQLite 事务，进程死亡不丢。【事实】core 有“预写执行认领”：回合开始时，认领和 started 事件写在同一个事务里；进程异常死亡后认领会残留。**受管服务**启动时扫描残留认领并自动续跑，并注入提示：服务器重启了，请从中断处继续，不要重复已完成的工作。最多 10 次，at-least-once。【推断】`opencode acp` 的 stdio 私有服务器不注册为受管服务，所以它自己不扫描；残留的认领可能在用户之后启动受管服务（如桌面版）时被续跑。 | execution.ts:73–80；execution/restart.ts:16–60；server-process.ts:63–160 | 源码；推断 | 中 |
| O6 | 输入是原生斜杠命令 | 【事实】内置命令只有 `compact`，走 `admitCompaction`，生成压缩消息，回放时是 compaction 条目。其余是配置中的 commands，经 `session.command` 展开模板后作为输入；**ACP 在提交后立即返回 succeeded，不等执行结束**。不在目录里的 `/x` 当作普通文本提示。 | catalog.ts:9–11；turn.ts:239–255、290；core/session/command.ts:11–37 | 源码 | 高 |
| O7 | 证明事件 | 【事实】ACP 实时**没有**：不回显用户消息；`session.inbox.delivered` 只在适配器内部用来判定 started；响应是 `{stopReason, usage, _meta.retry}`。【推断·高】非命令提示的 `end_turn`、`max_tokens`、`refusal` 只可能在 started（已送达）之后产生，所以可以当作“已写入”的结算证据。JSON-RPC 错误分准入前和送达后两类，只能按错误类别区分。 | translate.ts:150–166、126–128；turn.ts:290、314–326 | 源码 | 高 |
| O8 | 事后核对（含 synthetic） | 【事实】`session/load` 回放：user 消息变成 `user_message_chunk`（messageId 就是 OpenCode 消息 ID，内容是正文加文件）；compaction 变成压缩条目；assistant 变成文本、思考和工具。**synthetic、skill、shell、system 等消息类型一律不回放**——既不带注解，也根本不出现。`partsToContentChunks` 能把 synthetic 文本还原成 audience 注解，但 v2.2.5 的回放只把它用在文件部分。Hub 对 OpenCode 用 resume，不回放；要核对就得另开连接做 load，全量回放，成本随历史线性增长。 | replay.ts:43–60；content.ts:68–81；schema session-message.ts:93–100 | 源码 | 高 |
| O9 | 命令公告 | 【事实】`available_commands_update` 包含内置 compact 和配置里的 commands，目录变化时重发；Hub 另外补了一个 compact。ACP 面没有清空类命令。 | sessions.ts:75–90；opencode.ts:85–91 | 源码 | 高 |

### 2.5 DeepSeek Harness 0.2.1-rc.5（`dsh --profile acp`）

| # | 问题 | 结论 | 证据位置 | 核实方式 | 置信度 |
|---|---|---|---|---|---|
| D1 | 何时、由谁写入 | 【事实】ACP 桥先校验内容：resource、audio、空提示、未公告的图片都返回 invalidParams；图片先写附件库。然后 `createUserMessage` → `agent.followup`，inbox 用 `agent/inbox/spliced` 事件把消息记为待处理（next-turn）。回合流程：`turn/start` → preStep 里 `inbox.claim`（带 removedCount 的 splice）→ 组装系统提示 → `agent/pre-step` 瀑布（可以 reject）→ step 第一次尝试时 `session.append("user/message")` → 构建请求。持久化插件把这些 live 事件缓冲**最多 200 ms**，再 append 并 fsync。→ **模型请求之前**写入会话事件；落盘有 ≤200 ms 的窗口。 | dsh-acp/lib/index.js:105–169、796–866；dsh-agent-loop/lib/index.js:63–110、180–208、800–820、895–960、1040–1080；dsh-session-persistence-jsonl/lib/index.js:178–222、3293–3331 | 本机包源码 | 高 |
| D2 | 回合被取消 | 【事实】ACP 取消调 `agent.cancel({kind: "user"})`，不带 keepInbox，所以 inbox 被**持久地清空**（splice 的 outcome 记为 canceled），然后中止。认领之前取消：只留下“插入”和“取消”两条 inbox 记录，**不进历史**。认领之后、追加 user/message 之前中止：被认领的输入随回合一起丢掉。追加之后取消：已写入。 | dsh-acp:1005–1023；dsh-agent-loop:91–96、815–820；dsh-agent/lib/index.js:41–80 | 源码 | 高 |
| D3 | Provider 拒绝 | 【事实】user/message 在请求之前已追加，所以**已写入**；turn/end 为 error 时返回 JSON-RPC `turn failed: …`。 | dsh-acp:1050–1060 | 源码 | 高 |
| D4 | 参数校验失败 | 【事实】返回 invalidParams 或 internalError，消息**没有入队**；源码注释写明，取消不会排入迟到的用户消息。 | dsh-acp:95–169、845–859 | 源码 | 高 |
| D5 | 进程在回合中被杀 | 【事实】200 ms 缓冲窗口内被杀，事件（包括 inbox 插入和 user/message）可能丢失；fsync 之后就落盘了。 | persistence-jsonl:181–195、3295–3331 | 源码 | 中高 |
| D6 | 输入是原生斜杠命令 | 【事实】ACP 面没有命令：不发 available_commands，也不解析斜杠。`/compact` 这类文本当作普通消息交给模型，照常写入，**不会触发压缩**。 | dsh-acp:1185–1205；[S9] R5 §2.4 | 源码 | 高 |
| D7 | 证明事件 | 【事实】**没有**。ACP 只发由已提交会话事件投影出来的 assistant 与 tool 更新。`end_turn` 同时覆盖 completed、aborted 和 blocked；blocked 指预步骤被拒绝，且认领的输入已被丢弃。cancelled 还覆盖“回合根本没有结束”的情形。【推断·中高】本回合内第一条 assistant/message 或 tool/call 更新只可能出现在 step 之后，可以当弱证据。 | dsh-acp:539–551、880–925、1024–1065 | 源码；推断 | 中高 |
| D8 | 事后核对 | 【事实】不支持 `session/load`，只有 resume（不回放）和 list，协议层没法核对。CLI 也没有导出子命令（见 `dsh --help`）。 | dsh-acp:1185–1205；`dsh --help` | 源码；帮助输出 | 高 |
| D9 | 命令 | 无。 | 同上 | — | 高 |

### 2.6 Hermes Agent v0.22.5（`hermes acp` 网关查看器）

| # | 问题 | 结论 | 证据位置 | 核实方式 | 置信度 |
|---|---|---|---|---|---|
| H1 | 何时、由谁写入 | 【事实】查看器先在本地处理斜杠：命中 ROUTES 的直接作答，不准入。否则 `_prepare_submit`：转换内容、暂存图片，并按“会话 + 内容指纹”保留重试身份。然后调网关的 `prompt.submit(session_id, input_id, text …)`。网关以（主体、会话、request id）作为持久身份**准入**（能力 `durable-admission-v1`），再回执 `admission_id` 与 status。网关里的 agent 在 `build_turn_context` 末尾调用 `_persist_turn_start`，**在第一次 LLM 调用之前**把用户回合写进会话库。 | gateway_server.py:621–704、706–726、746–760；session_controls.py:501、690–769；session_authority.py:636–680；agent/turn_context.py:1019–1032、1212 | 本机源码 | 高 |
| H2 | 回合被取消 | 【事实】查看器转成 prompt.cancel：仍在排队的准入被撤销，不运行，也不写用户回合；已开始的回合被中断，用户回合此前已写入。准入回执丢失时，查看器保留 input_id，同一提示重试时去重。 | gateway_server.py:640–665、688–700；session_controls.py:803–821 | 源码 | 高 |
| H3 | Provider 拒绝 | 【事实】用户回合已写入。结果为 failed 时返回 ACP 错误 `admitted_turn_failed`；为 unknown 时返回错误，并要求先 `/discard`。【推断】网关在 `_persist_turn_start` 之前就失败（例如系统提示构建出错）时也会得到 failed，所以 failed 不能证明已写入。 | gateway_server.py:695–704；turn_context.py:1180–1212 | 源码 | 中高 |
| H4 | 参数校验失败 | 【事实】以下情形**不准入**：not_found、存在未决的 unknown 准入、invalid_params、permission_denied。暂存期间收到停止，则返回 cancelled，不提交。 | gateway_server.py:621–640、746–760；session_controls.py:750–769 | 源码 | 高 |
| H5 | 进程在回合中被杀 | 【推断】Hub 杀的是查看器，回合在 launchd 网关里继续，准入和用户回合都已持久。Hub 这边记 unknown（驱动已处理 `UNKNOWN_OUTCOME`）。 | hermes.ts:38–40、117–130 | 推断 | 中 |
| H6 | 输入是原生斜杠命令 | 【事实】ROUTES 的含义：`new` 和 `clear` → `session.mutate reset`（**清空历史**）；`compress` → 压缩；`undo` 和 `retry` → `session.mutate rewind`（**删除最近 N 个用户回合及其回复**，retry 再重新提交）；`model`、`tools`、`title`、`help` 不影响上下文；`branch` 拒绝；`discard` 用来解决 unknown；`steer` 和 `queue` 作为提示提交。其余命令交给网关 `slash.exec`，得到一份报告，或者一个要提交的回合（例如技能正文）。本地作答的命令以 `end_turn` 结束，**不准入**。未识别的 `/x` 当作普通消息交给模型。 | gateway_commands.py:21–66、192–205、281–295；gateway_session_meta.py:26–56 | 源码 | 高 |
| H7 | 证明事件 | 【事实】准入回执只在查看器内部，Hub 拿不到。成功时只有 `end_turn` 或 `cancelled` 加 usage。错误数据里出现 `unknown_execution` 或 `admitted_turn_failed`，说明已经准入。 | gateway_server.py:651–704 | 源码 | 高 |
| H8 | 事后核对 | 【事实】Hermes 驱动每回合都做 `session/load`（restoreByLoad），查看器按 row_id 回放**未归档**的会话行：user 与 assistant 文本、思考、工具。被压缩归档的行不回放。Hub 在 open() 期间收到这些 `user_message_chunk`，然后**丢掉**（acp.ts:619–625）。→ 下一回合 open 时，可以零额外成本地核对上一回合是否写入。 | gateway_server.py:368–386；server.py:126–166；hermes.ts:100；acp.ts:619–625 | 源码 | 高 |
| H9 | 命令公告 | 【事实】公告 help、model、tools、context、**reset**、**compress**、steer、queue、usage、status、version、title、**undo**、**retry**；`new` 和 `clear` 有路由，但不公告。 | gateway_session_meta.py:26–41 | 源码 | 高 |

### 2.7 OpenClaw 2026.10.9（`openclaw acp` 桥）

| # | 问题 | 结论 | 证据位置 | 核实方式 | 置信度 |
|---|---|---|---|---|---|
| W1 | 何时、由谁写入 | 【事实】ACP 桥把整段提示拼成一条消息：text resource 原样拼接，图片作附件，默认加 `[Working directory: …]` 前缀。经网关 `chat.send` 提交，`idempotencyKey` 是随机 runId。ACK 在**运行时所有权确立之后、转录提交之前**发出。随包文档写明：ACK 可以在输入还处于持久待处理托管时到达，客户端不得把 `status: "started"` 当作持久化；`messageSeq` 只来自已提交的转录回执。【事实】网关的嵌入式运行时把模型可见的 user、assistant、toolResult 行写入 SQLite 转录；用户回合在模型提示投影之前持久，因为投影要求一个已持久的用户回合。桥在 ACK 被接受后，把用户提示记进自己的 ACP 事件账本，供 load 回放使用。 | server-DNoj34fZ.mjs:1239–1373（1274 前缀、1338、1347）；chat-send-handler-B0jivtwJ.mjs:846–866；user-turn-transcript-DuAfBkUt.mjs:180–260、548–560；docs/web/webchat.md:52–80 | dist 源码；随包文档 | 中高 |
| W2 | 回合被取消 | 【事实】桥发 `chat.abort {sessionKey, runId}` 并以 cancelled 应答。网关在 ACK 之后的中止或派发错误路径里，如果用户回合还没持久、也没被阻止，会补写用户回合（尽力而为，失败只记日志）。【事实】Hub 驱动对 cancelled 回合**跳过**转录回读。 | server:1374–1407；chat-send-handler:486–525；openclaw.ts:440 | 源码 | 中高 |
| W3 | Provider 拒绝 | 【事实】用户回合已持久，转录中助手行的 `stopReason` 是 `"error"`。桥把 error 状态报成 `end_turn`（或 refusal）；Hub 驱动回读转录后改判为 failed。 | server:1452–1455；openclaw.ts:169–172 | 源码 | 高 |
| W4 | 参数校验失败 | 【事实】超过 `MAX_PROMPT_BYTES`（2,097,152 字节，含 resource 文本）时，在 chat.send 之前就抛错。ACK 状态为 error 时，提示“运行开始前失败”。ACK 之后的准备失败表现为运行错误。【事实】Hub 驱动选模未确认时合成 `failed/model_not_applied`，**根本没有发送**，目前仍推进水位。 | server:1185、1268–1297、1325–1333；docs/web/webchat.md:55–60；openclaw.ts:91–94、422–423 | 源码；文档 | 高 |
| W5 | 进程在回合中被杀 | 【推断】Hub 杀的是 `openclaw acp` 桥，回合在网关里继续，转录照常提交。 | — | 推断 | 低中 |
| W6 | 输入是原生斜杠命令 | 【事实】`/new [model]`：归档当前会话，开一个新会话。`/reset [soft [message]]`：原地重置；soft 保留转录，丢掉复用的 CLI 后端会话 id，并重跑启动流程。单独的 `/new`、`/reset` 不启动模型回合。`/compact [instructions]` 压缩。其余是设置类命令（think、verbose、model、queue…），以及 `stop`、`restart`（重启网关）、`bash`（执行主机命令）。【推断】桥默认给提示加 cwd 前缀，网关是否仍能识别出斜杠命令，未核实。 | server:2185–2290；docs/tools/slash-commands.md:177–215；docs/concepts/compaction.md:315–321 | 源码；文档 | 公告：高；前缀影响：低 |
| W7 | 证明事件 | 【事实】ACP 实时没有。Hub 驱动在每个非取消回合后都调 `sessions.get {key, limit: 200}` 回读转录，并按 `__openclaw.seq > before` 过滤——这一步已经拿到本回合的 user 行，但 `reconcileTurn` 只处理 assistant 与 toolResult，user 行被忽略。 | openclaw.ts:401–449、132–174 | 源码 | 高 |
| W8 | 事后核对 | 【事实】权威来源是 `sessions.get` 和 `chat.history`，即原生转录。`session/load` 只回放桥自己的事件账本（限桥创建的会话），没有账本时退回存储的 user/assistant 文本；账本证明的是“桥收到了 ACK”，不是“原生转录已提交”。`session/resume` 不回放。 | docs/cli/acp.md:31–47；openclaw.ts:429、442 | 文档；源码 | 高 |
| W9 | 命令公告 | 【事实】W6 列出的命令都经 `available_commands_update` 公告，其中包括 new、reset、compact。 | server:2288–2290、2377–2378 | 源码 | 高 |

### 2.8 汇总矩阵：情形 × Harness

每格格式为：输入是否已写入原生历史 / 现在的 Hub 是否推进水位 / 结果。✓ 表示正确，✗ 表示错误，△ 表示另有副作用。

| 情形 | Claude | Codex | OpenCode | dsh | Hermes | OpenClaw |
|---|---|---|---|---|---|---|
| 正常完成 | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ |
| 模型已开始后取消 | 是（另有中断标记） / 推进 / ✓ | 是（`<turn_aborted>`） / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是（推断） / 推进 / ✓ |
| 插入前取消 | 否 / 推进 / ✗ | 多数路径是，少数否 / 推进 / △ | 暂未，但持久挂起，**以后会被送达** / 推进 / △ | 否（inbox 清空） / 推进 / ✗ | 否（撤销准入） / 推进 / ✗ | 视 ACK 时机而定 / 推进 / ? |
| Provider 拒绝（超窗、4xx、限流） | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 是 / 推进 / ✓ | 多数是 / 推进 / △ | 是 / 推进 / ✓ |
| 接口或适配器校验失败 | 否 / 推进 / ✗ | 否 / 推进 / ✗ | 否 / 推进 / ✗ | 否 / 推进 / ✗ | 否 / 推进 / ✗ | 否 / 推进 / ✗ |
| Hub 驱动合成“未发送” | 否（/remote-control） / 推进 / ✗ | — | — | — | — | 否（model_not_applied） / 推进 / ✗ |
| 原生成功报告但输入被丢 | — | 是（hook 拦截后 completed） / 推进 / ✗ | — | 是（blocked 也报 end_turn） / 推进 / ✗ | — | — |
| 进程在回合中被杀 | 回显后是，之前可能否 / 不推进（unknown） / ✓ | userMessage 后是 / 不推进 / ✓ | 是 / 不推进 / ✓ | 200 ms 窗口外是 / 不推进 / ✓ | 网关继续，是 / 不推进 / ✓ | 推断是 / 不推进 / ✓ |
| 清空类命令 | `/clear`、`/reset`、`/new` 未公告，但原样发送会被执行 / 推进 / ✗ | 无 | 无 | 无 | `/reset`（公告）、`/new`、`/clear` / 推进 / ✗ | `/new`、`/reset`（公告） / 推进 / ✗ |
| 回退类命令 | — | — | — | — | `/undo`、`/retry`（公告） / 推进 / ✗ | — |

读法：表中所有 ✗ 都不是“原程序在写入前就失败”造成的，而是 Hub 把“已派发”或“终态非空”当成了送达。R4 D11 担心超窗导致丢失，在这六家都**不会发生**。

### 2.9 原生命令对原生上下文的影响

| Harness | 保持（技能/模板/普通） | 压缩 | 清空 | 回退 | 公告方式 | 现在 Hub 的风险 |
|---|---|---|---|---|---|---|
| Claude | 技能、自定义命令；本地命令只读 | `/compact [指令]` | `/clear`（`/reset`、`/new`）：开新会话 | — | ACP `available_commands_update`，clear 被排除 | 未公告的清空命令经 1392 原样到达并被执行 |
| Codex | `/skill:<name>`（Hub 合成） | `/compact`（Hub 合成，调 thread/compact/start） | — | — | Hub 由 `skills/list` 生成 | 只有 D1 |
| OpenCode | 配置 commands（模板） | `/compact`（内置） | — | — | `available_commands_update` | D1；命令回合提前结束 |
| dsh | 斜杠只是文本 | 不可经 ACP 压缩 | — | — | 无 | 无 |
| Hermes | steer、queue、技能（`slash.exec` 返回的回合） | `/compress [focus]` | `/reset`（公告）、`/new`、`/clear` | `/undo [N]`、`/retry` | `available_commands_update` | 清空与回退之后，水位反向失真 |
| OpenClaw | 设置类命令 | `/compact [指令]` | `/new`（归档后新开）、`/reset [soft]` | — | `available_commands_update` | 清空之后水位失真 |

---

## 3. 模式归纳

1. **【事实】写入点高度一致：六家都在第一次模型请求之前写入。** 依据分别是：
   - Claude：转录 `await` 之后才进入查询循环；
   - Codex：`record_user_prompt_and_emit_turn_item` 之后才采样；
   - OpenCode：runner 只从已记录的历史运行；
   - dsh：step 先追加 user/message，再构建请求；
   - Hermes：`_persist_turn_start` 的注释写明在第一次 LLM 调用之前；
   - OpenClaw：模型提示投影要求一个已持久的用户回合。

   推论：只要原生侧真的开始处理这次输入，失败、超窗、限流都不会丢输入。

2. **【事实】普遍是两段式：先准入或受理，再写入历史，两者不是同一件事。**
   - OpenCode 的 inbox，先 `InboxEnqueued`，再 `InboxDelivered`；
   - Hermes 的 durable admission，之后才 `_persist_turn_start`；
   - OpenClaw 的 ACK 与持久待处理托管，之后才是转录行（文档明确禁止把 started 当作持久）；
   - dsh 的 inbox splice，之后才有 `user/message`；
   - Codex 的 turn/start 响应，之后才有 userMessage；
   - ACP v2 的插入，规范也说明它不等于持久。

   ACK 或受理只证明“会被处理”，不证明“已在历史里”。

3. **【事实】终态不是证据，两个方向都会错。**
   - 失败或取消的回合可能已写入：Claude、Codex、OpenCode、Hermes、OpenClaw 的 Provider 错误，以及插入之后的取消。
   - 成功的回合可能没写入：dsh 的 blocked 和 aborted 也报 end_turn；Codex 被 hook 拦截后报 completed；Hermes 本地作答的斜杠报 end_turn；OpenClaw 的 ACK 状态 ok 直接以 end_turn 结束。

4. **【事实】证据的可得性差别很大。**

| 类型 | Harness |
|---|---|
| 实时 | Codex（userMessage 加 clientId）；Claude（需打开原始消息开关） |
| 便宜的事后核对 | OpenClaw 回读（已在做）；Hermes 下一回合回放（已在收）；Claude 读 JSONL 尾部；Codex turns/list |
| 昂贵的事后核对 | OpenCode 另开连接全量回放 |
| 完全没有 | dsh（只能退回“本回合有了 agent 输出”这一弱证据） |

5. **【事实】持久化窗口各不相同。**
   - Claude 有 100 ms 写队列，写完不 fsync；
   - dsh 有 200 ms 批量窗口，然后 fsync；
   - Codex 每批 write 加 flush，不 fsync，新线程要等第一次 Persist 才物化；
   - OpenCode、Hermes、OpenClaw 用 SQLite 事务。

   对“进程被杀”来说，证据到达之后的写入都能扛住进程死亡（page cache 已在内核里）；扛不住的只有机器掉电，这不在本设计范围内。

6. **【事实·推断】原生侧自己也有 at-least-once 或“僵尸”语义。**
   - OpenCode：未送达的 steer 会滞留，并在以后被送达；受管服务启动时还会自动续跑残留回合。
   - Hermes：准入持久，有重试身份。
   - Claude：取消后，已被 CLI 取走的命令照样执行，适配器称之为 orphan 或 zombie。
   - OpenClaw：有持久待处理托管与 `idempotencyKey` 去重。

   这与 INV-11“未知执行不自动重跑”存在张力：Hub 自己不重跑，原程序可能替它重跑。

7. **【事实】清空和回退命令真实存在，而且被公告**（Hermes、OpenClaw），或者虽未公告但能执行（Claude）。D18 应从 P3 上调到 P1。

8. **【事实】Hub 驱动丢掉了已收到的大部分证据**（见 2.0 节），修复成本主要是“不再丢弃”，而不是“新造通道”。

---

## 4. 对 HarnessHub 接力的启示

### 4.1 推荐的统一判据（【建议】）

**已送达（delivered）**：Hub 持有一条**正面证据**，表明携带本次增量（交接单或增量包）的那条输入，已经进入目标 Harness 的**原生历史**，会被之后的模型请求读到。

- 证据与回合终态（completed、failed、cancelled、unknown）**脱钩**，与“已派发”“已受理”也脱钩。
- 证据分三级，由 Driver 提供：
  - **E1 实时**：原生侧发来“已写入”事件（Codex userMessage；Claude 原始回显）。
  - **E2 事后核对**：Driver 回读或回放原生历史，命中本次的标记（clientId、packetId 文本）。
  - **E3 结算推断**：Driver 依据原生语义，把某些终态解释为已写入。例如 OpenCode 非命令回合的 end_turn；Claude 的 end_turn，或带 `data.errorKind` 的错误。
- **没有证据等于 unknown，不等于 not_recorded。** Driver 确知“根本没发出去”的情形才标 not_recorded：合成的拒绝、接口在插入前的错误。
- 水位规则：
  - 只有带增量的输入有了 recorded 证据，`deliveredThroughSeq` 才推进到该输入的 `contextThroughSeq`；
  - `dispatchedThroughSeq` 只用于诊断；
  - 证据为 unknown 时，绑定记一条 `pendingPacket`；
  - not_recorded 时增量照旧待送。

### 4.2 Driver 能力声明草案（【建议】，Runtime 不按产品名分支）

```ts
/** What a native interface lets the Hub know about a dispatched input reaching the native history. */
export interface NativeDeliveryCapability {
  /** Emits `input_recorded` during a Turn once the native side reports the input in its history. */
  readonly live: "recorded_event" | "agent_output" | "none";
  /** Can check afterwards whether marker text (or a client id) is in the native history. */
  readonly verify: "after_turn" | "on_next_open" | "costly" | "none";
  /** Whether a native success report proves the input was recorded (false when a native turn can succeed having dropped it). */
  readonly successProvesRecorded: boolean;
  /** What happens to a slash input the catalog does not list: executed natively, or sent to the model as text. */
  readonly unlistedSlash: "executed" | "text";
}
export type ControlEvent = /* … */ | { readonly type: "input_recorded"; readonly nativeMessageId?: string };
export interface BackendResult { /* … */ readonly input?: "recorded" | "not_recorded" } // absent = unknown
export interface NativeCommand { readonly name: string; readonly description: string;
  /** Effect on the native context; absent = "unknown". */
  readonly contextEffect?: "keep" | "none" | "compact" | "clear" | "rewind" | "unknown" }
// HarnessControl: verifyDelivered?(marker: { readonly text: string; readonly clientId?: string }): Promise<"present" | "absent" | "unknown">;
```

Runtime 的通用规则（伪代码）：

```
settle(run):  if !run.carriesRelay → binding.delivered 不变（命令回合与普通回合都一样）
  ev = run.facts.inputRecorded ? "recorded" : backend.input
  if ev === undefined && cap.verify === "after_turn": ev = await timeout(2s, verifyDelivered(marker))
  recorded/present → delivered = run.contextThroughSeq; pending = null
  not_recorded/absent → pending = null（增量下一条照送）
  其余 → pending = {packetId, range}
open 之后、组装输入之前:
  if pending && cap.verify in {"on_next_open","after_turn","costly"}: 先核对；present → 推进
  仍未知 → 下一条内容输入再次带上 pending 范围，沿用同一个 packetId，L0 写明“已见过 P 的内容可忽略”
命令（目录给出 contextEffect；目录里没有、而 unlistedSlash="executed" 的按 unknown 处理）:
  keep/none → 不推进；compact → 不推进，并标记 reanchor（R3 I-7）
  clear → delivered = 空，nativeEpoch++（下一条内容输入发完整交接单）
  rewind/unknown → delivered = 未知（下一条：能核对就核对，否则发完整交接单并去重）
```

### 4.3 每家推荐的“已送达”判据与能力映射（【建议】）

| Harness | E1 实时 | E2 事后核对 | E3 结算推断 | 已知的 not_recorded | 能力声明 |
|---|---|---|---|---|---|
| Claude | 会话 `_meta.claudeCode.emitRawSDKMessages: [{type:"user", origin:"human"}]`；收到 `_claude/sdkMessage` 中 `isReplay` 且含本回合标记的 user 消息，即 `input_recorded`（需真机） | 读本会话 JSONL 尾部（建议上限 2 MiB），找标记或 promptUuid | end_turn、max_tokens、max_turn_requests 可证明已写入；带 `data.errorKind` 的 JSON-RPC 错误可证明；cancelled 记 unknown | sessionNotFound、会话已结束、RC 冲突；Hub 合成的 `/remote-control` 与 `/export` | `live: recorded_event, verify: after_turn, successProvesRecorded: true, unlistedSlash: executed` |
| Codex | 发 `clientUserMessageId = 公共 runId`，收到 `userMessage.clientId` 相同的条目即 `input_recorded`；不再丢弃 codex.ts:706 那些事件 | `thread/turns/list`（desc，limit 2，full）找 clientId，找不到再退回文本标记 | 不依赖结算推断 | 尚无 turnId 时 turn/start 的 JSON-RPC 错误；hook 拦截（completed 而无 userMessage）；`/export` | `live: recorded_event, verify: after_turn, successProvesRecorded: false, unlistedSlash: text` |
| OpenCode | 无 | 另开连接 `session/load` 回放（只在 unknown 时做，预算 5 s） | 非命令回合的 end_turn、max_tokens、refusal 可证明；ServiceFailure 推断可证明；cancelled 记 unknown，**而且可能稍后被送达** | InvalidRequest、PromptConflict、Attachment、SkillNotFound；Hub 合成的 `COMPACT_IGNORED` | `live: none, verify: costly, successProvesRecorded: true, unlistedSlash: text` |
| dsh | 本回合第一条 agent_message、agent_thought 或 tool_call 更新（弱证据） | 无 | 其余一律 unknown | invalidParams（resource、audio、空） | `live: agent_output, verify: none, successProvesRecorded: false, unlistedSlash: text` |
| Hermes | 无 | 下一回合 `session/load` 回放（本来就收）；要求 Runtime 在 open 之后再组装输入 | 非斜杠回合的 end_turn 可证明；`admitted_turn_failed` 与 cancelled 记 unknown | not_found、invalid_params、存在未决 unknown；本地作答的斜杠命令；Hub 合成的 `/export` | `live: none, verify: on_next_open, successProvesRecorded: true, unlistedSlash: text` |
| OpenClaw | 无 | 回合结束后 `sessions.get` 回读（本来就做，扩展到 cancelled 与 failed 回合）；本回合 seq 之后出现含标记的 `role: "user"` 行即可证明 | end_turn 不能证明（错误也报 end_turn） | 超过 MAX_PROMPT_BYTES；ACK 状态 error；Hub 合成的 `model_not_applied` | `live: none, verify: after_turn, successProvesRecorded: false, unlistedSlash: text`（前缀问题待核实） |

命令效果的声明：

| Harness | `contextEffect` |
|---|---|
| Claude | compact 为 compact；clear、reset、new（未公告）为 clear；技能为 keep；/model、/status、/usage、/context、/mcp 为 none |
| Codex | compact 为 compact；`skill:*` 为 keep；export 为 none |
| OpenCode | compact 为 compact；配置 commands 为 keep |
| Hermes | reset、new、clear 为 clear；compress 为 compact；undo、retry 为 rewind；steer、queue 为 keep；只读类为 none；`slash.exec` 转发的命令为 unknown |
| OpenClaw | new、reset 为 clear；compact 为 compact；stop 为 none（等同取消）；restart、bash 为 unknown；设置类为 none |

### 4.4 四种判据逐一判定

| 判据 | 内容摘要 | 判定 | 理由（对照 2.8 节） |
|---|---|---|---|
| **R1 D13** | 设两条水位：`deliveredThroughSeq` 在携带增量的回合被目标**接受且结算**后推进，未知结果不推进；`dispatchedThroughSeq` 只用于诊断；斜杠命令回合不推进，增量顺延到下一个内容回合 | **有条件成立** | 结构正确：两条水位、命令回合不推进、unknown 不推进、增量顺延。条件是“接受”必须换成 4.1 节的正面证据，而且推进不能挂在“结算”上：已插入后取消或失败的回合应当推进，否则会重复注入；被 hook 拦截的 Codex、blocked 的 dsh、本地斜杠的 Hermes、ACK ok 的 OpenClaw 不应推进。另需补上 clear 与 rewind 的效果，以及 OpenCode 的滞留输入。 |
| **R3 I-3** | `syncedThroughSeq` 在“目标真正处理了嵌入增量的输入”时推进：该 Run 有 `firstOutputAt`，或终态证据表明模型读过；不嵌入增量的斜杠命令不推进；`packetId` 幂等，至少一次投递 | **有条件成立** | packetId、至少一次投递、按绑定分别维护水位，都应采用。但 `firstOutputAt` 既不必要也不充分。不必要：输入已写入、在任何输出之前失败的回合（各家的 Provider 错误）会被漏判，然后重复发送。不充分：Claude 适配器在插入**之前**可能先发 `plan`（acp-agent.js:2219–2221），而 `plan` 属于 VISIBLE_OUTPUT（runtime.ts:153）。“终态证据”没有定义。可以保留为 dsh 这类没有显式证据的 Driver 的 E1 弱证据，但要排除 plan 与 activity（compaction）。 |
| **R4 D11** | 定义送达确认：`backend.status` 为 completed，或 Driver 声明“失败回合也会写入转录” | **不成立**（作为判据） | completed 不充分：dsh 的 blocked、aborted，Codex 被 hook 拦截，Hermes 本地斜杠，OpenClaw ACK ok。completed 也不必要：插入后失败的回合普遍已写入。“失败回合也会写入转录”是按 Driver 的静态声明，同一 Driver 里插入前失败（Claude 的适配器拒绝、Codex 的 turn/start 校验）和插入后失败（Provider 错误）结果相反，静态声明必然在一类情形上出错。可以保留的部分：由 Driver 判断——改为**逐回合**的 `BackendResult.input` 与 `input_recorded` 事件。 |
| **R7 H3** | 分隔线只在交接单已送达后出现，即目标原程序已受理输入（`dispatchedAt`）；原生水位按“已送达”而非“已派发”推进 | **不成立**（自相矛盾） | `dispatchedAt` 是 Runtime 在调用 `startText` **之前**提交的时间（runtime.ts:1415–1417），本身就是“已派发”。拿它定义“已送达”，等于原样保留了 1496 的缺陷。界面规则可以采用：送达前显示“交接中”，失败时不画分隔线并说明当前仍由谁执行。但要改成以 E1 或 E2 证据为触发，详见 4.5 节 G9。 |

### 4.5 逐条决定

- **G1【采用】以正面证据定义“已送达”，与终态脱钩**（4.1 节）。理由：2.8 节的 ✗ 全部来自“已派发”或“终态非空”被当作送达；而六家都在模型请求前写入，证据大多已经到了 Hub 手边。
- **G2【采用】Codex：发 `clientUserMessageId`，用 userMessage 事件作 E1。**
  - `clientUserMessageId` 填公共 runId，是稳定字段（v2/turn.rs:180）。
  - 删掉 codex.ts:706 对 userMessage 的丢弃，改为 `input_recorded`。
  - 预期证据在第一个 token 之前到达，零额外 RPC。
  - 事后核对：`thread/turns/list` 一次 RPC（本机预计 <50 ms，未测量）。
- **G3【改造后采用】Claude：E1 用原始回显。**
  - 在 `_meta.claudeCode` 里加 `emitRawSDKMessages: [{type: "user", origin: "human"}]`，只放行人类来源的 user 消息，不放行工具结果。
  - 代价是每条输入在 stdio 上多传一份内容：200 KB 的交接单多 200 KB 的 JSON，与模型时延相比可以忽略。
  - 改造点：
    - ClaudeControl 的 `extensionNotification` 识别 `_claude/sdkMessage`，只取 `isReplay` 且内容含本回合标记的那条；
    - E3 退化规则见 4.3 节；
    - E2 读 JSONL 尾部。
  - 真机核实过滤器生效之前，只能把它当成可选增强。
- **G4【采用】OpenClaw：回读到 user 行即 E2。** 驱动已经在做 `sessions.get`（openclaw.ts:442），只需：
  - 把 user 行纳入 `reconcileTurn`；
  - cancelled 与 failed 回合也回读，每回合最多多一次 RPC；
  - `model_not_applied` 改为 `input: not_recorded`。
- **G5【采用】Hermes：在下一次 open 时核对。** 驱动每回合都会 `session/load`，回放就在手边（acp.ts:619–625 现在把它丢了）。Runtime 改为在 open 之后再计算并组装增量（runtime.ts:1334–1340 后移到 1376 之后），这样核对正好落在需要它的时刻，额外成本为零。
- **G6【改造后采用】OpenCode：非命令回合的 end_turn 视为 E3。**
  - 取消和错误回合记 unknown，下一条带同一个 packetId 重发。
  - 不能把 synthetic 当作唯一的交接通道：它不回放、不可核对；prompt 失败或取消后它会滞留在 inbox。
  - 用了 synthetic 时，标记必须同时放在可见正文里。
- **G7【改造后采用】dsh：用“本回合第一条 agent 输出”作弱证据，否则 unknown。** 通用 `AcpControl` 按能力开关发 `input_recorded`：只认 agent_message、agent_thought、tool_call，不认 plan、usage、notice。
- **G8【采用】命令效果由 Driver 声明，Runtime 通用处理**（4.2 节）。理由：Hermes 的 `/reset`、`/undo`，OpenClaw 的 `/new`、`/reset` 都已公告；Claude 的 `/clear` 未公告但可执行（2.9 节）。`unlistedSlash: executed` 的 Driver（Claude），目录外的 `/name` 一律按 unknown 处理，不再走 1392 的“原样发送、照常推进”。
- **G9【采用】分隔线和接棒状态随证据走。**
  - E1 到达，即第一个 token 之前，画分隔线“已接棒”。
  - 没有 E1 的 Driver，在结算时得到 E3 或 E2 之后再画。
  - 结算后仍为 unknown，显示“交接未确认，下一条消息会再次附上”。
  - 绝不用 `dispatchedAt`。
- **G10【采用】Driver 合成的结果必须标注 `input: "not_recorded"`**：openclaw `notSent`、claude 的 `REMOTE_CONTROL_REFUSED` 与 `/export`、codex 与 hermes 的 `/export`、opencode 的 `COMPACT_IGNORED`。
- **G11【采用】unknown 才至少一次重发，并按 packetId 去重。**
  - 预计只在 Claude 与 Codex 很少出现（证据齐全）；OpenCode 的取消或错误、dsh 无输出的失败回合会较常见。
  - 成本：每次 unknown 多注入一份交接单的 token。
  - 不做自动重跑：重发只附在用户的下一条输入上，与 INV-11 不冲突。
- **G12【拒绝】把 ACP v2 插入、OpenClaw ACK、Hermes 回执、Codex 的 turn/start 响应当作“已送达”。** 理由：这些都是受理，规范和文档都写明它们不等于持久（[S17][S44]）。它们可以作为“已受理”的诊断状态显示。
- **G13【拒绝】Hub 直接读 OpenCode、dsh、Hermes 的私有数据库来证明送达。** 这样越过了 Driver 的公开接口，跟着版本变就会坏，也与“不读用户会话数据”的习惯冲突。【改造后采用】Claude 的 JSONL（驱动的 `/export` 已在读，而且只读 Hub 自己的会话）和 OpenClaw 的 `sessions.get`（公开的网关方法）可以接受。
- **G14【改造后采用】如果用 Codex `thread/inject_items` 交付交接单：**
  - 响应 `{}` 表示已进内存历史，可算 E1′；
  - 但新线程在第一次 Persist 之前不落盘，所以紧接着发 turn/start，让 userMessage 的 Persist 屏障把两者一起写下；
  - 有活动回合时不要 inject，否则会并入该回合的待处理输入，回合结束时去向未核实。
- **G15【采用】Claude 交接标记放在第一段 text 块里**，不只放在 resource 块：v1 会静默丢弃不认识的块（C4），OpenCode 会丢弃 `audience: ["user"]` 的文本（O1）。

### 4.6 P0 最小修复顺序（【建议】，不依赖任何新通道）

1. **命令回合与 Driver 合成的结果不推进 delivered**，覆盖 D1、D2、G10。这只需 Runtime 通用逻辑加上 `BackendResult.input`。
2. **REMOTE_ERROR 分两类**：
   - Codex 在尚无 turnId 时，标 `input: not_recorded`；
   - ACP 的错误默认 unknown；Claude 带 `errorKind` 的，标 recorded。
3. **命令效果声明**：先覆盖 Hermes 的 reset、new、clear、undo、retry，OpenClaw 的 new、reset，Claude 的 clear、reset、new。clear 把水位清空，rewind 把水位置为未知。
4. **信封加入 `relayPacketId`**，unknown 时重发同一个 id；现有 JSON 信封加一个字段即可，同时同步夹具（R4 U16）。
5. 然后再接 E1 与 E2：先做 Codex 的 clientUserMessageId 和 OpenClaw 回读（零额外成本），再做 Hermes 的 open 后核对（需要改顺序），最后做 Claude 的原始回显（需要真机）。

---

## 5. 风险与反模式

- **把受理当持久**：OpenClaw 的 `status: "started"`、ACP v2 的插入、Hermes 的回执、Codex 的 turn/start 响应。各自的文档或规范都明确说明它们不是持久化。
- **把成功当写入**：dsh 的 blocked 也报 end_turn；Codex 被 hook 拦截后报 completed。**把失败当未写入**：Provider 错误时已经写入了，这时重发就是重复注入。
- **静默丢块**：Claude v1 丢 audio 与不支持的 blob；OpenCode 丢 `audience: ["user"]` 的文本；OpenClaw 丢非图片 blob。只放在资源块里的交接内容可能根本没送到，而回合照样成功。
- **synthetic 不可核对**：OpenCode 回放里没有 synthetic；prompt 失败后 synthetic 留在 inbox，下一次唤醒时才送达。
- **原生侧的僵尸与自动续跑**：OpenCode 未送达的 steer 会滞留；受管服务会自动续跑残留回合（at-least-once，最多 10 次）；Claude 取消后，已被 CLI 取走的命令照样执行。Hub 的 unknown 处理必须预期“原程序可能自己继续”。
- **进程被杀的窗口**：Claude ≤100 ms，dsh ≤200 ms，Codex 新线程在第一次 Persist 之前。这些窗口很小，但会让“已派发、没有证据”的情形真实存在。
- **清空和回退让水位反向说谎**：Hermes 的 `/reset`、`/undo`、`/retry`，OpenClaw 的 `/new`、`/reset`，Claude 的 `/clear`。之后 Hub 会照常发送原样输入，接手方却什么都不记得。
- **Hermes 查看器死亡之后**：网关里的回合继续运行，Hermes 自己要求“不要重发”。Hub 不得因为 unknown 就自动重发，只能等用户下一条输入时，经核对再决定补发。
- **核对时读取原生转录**：只做标记匹配，不得把读到的原生内容回灌进公共事实或交接单（防提示注入、防跨厂商泄露），也不得读 Hub 自有会话以外的会话。
- **过度核对**：OpenCode 的 load 是全量回放，只应在 unknown 时做，并给出时限。
- **标记设计不当**：标记要短（例如 `HH-PKT-<16 位 hex>`），不能用自然语言里会被模型复述的形态；Codex 优先用 clientId，避免依赖文本匹配。

---

## 6. 未解决的问题

### 6.1 问题清单

1. Claude 的 `emitRawSDKMessages` 过滤器在真机上是否放行本回合的 `isReplay` 回显？回显是否稳定地早于第一个流式事件？打开它会不会改变适配器的回合行为？
2. Claude：原样发送 `/clear` 之后，适配器与 CLI 的会话 id 怎样变化；在保留进程和重启进程两种情况下，原生上下文是否一致？
3. OpenCode：插入前取消的提示，是否真的会在下一次唤醒时被送达（僵尸输入）？stdio 私有服务器是否扫描残留认领？
4. Codex：legacy 历史模式的 rollout 回读时是否带 clientId？`thread/inject_items` 注入的条目在 turns/list 中是否可见？有活动回合时 inject 的条目去向如何？
5. Hermes：`hermes acp` 被杀之后，网关回合是否继续并正常结算？下次 load 时，查看器怎样报告这个准入？
6. OpenClaw：cwd 前缀是否让网关识别不出斜杠命令？桥被杀之后回合是否继续？cancelled 回合的 user 行是否一定会补写？
7. dsh：实际使用中 blocked 与 aborted 出现的频率；第一条 agent 输出之前是否可能已有其他更新（例如子代理）？
8. Hub 信封的字节上限（1 MiB）与 Codex 的字符上限（1,048,576）对齐问题：建议 Driver 声明自己的单条输入上限。
9. `pendingPacket` 跨重启：v13 迁移怎样表示 pending 与 nativeEpoch，与 R4 第 6 节第 7 条一起定。

### 6.2 给主负责人的最小真机核实配方（只写不执行）

**通用前提**：

- 工作区用新建的临时目录，例如 `/private/tmp/hh-probe-<日期>`，不碰用户项目。
- 只用 Hub 自有的会话；Hermes 和 OpenClaw 在 Hub 自有的会话键下进行。
- 每次探针的输入以唯一标记开头，例如 `HH-PROBE-<uuid>`。
- 记录原始线路日志，含收发时间戳。
- 事后只用各家自己的读取路径核对，只匹配标记。
- 结束后用原生的删除或归档方法清理测试会话；无法删除的记下 id，交给用户决定。
- 只用进程级环境变量或线程级覆盖，不写任何用户配置；不碰 4317 与 `data/`；模型自己的说法不作证据。

| 编号 | 探针 | 适用 | 操作 | 观察与判定 |
|---|---|---|---|---|
| P1 | 正常路径的时序 | 全部 | 发一条带标记的输入，记录 dispatch、E1（Codex userMessage、Claude 原始回显）、第一个模型输出、结算四个时间点 | E1 应早于第一个模型输出；回合结束后事后核对命中标记 |
| P2a | 插入前取消 | 全部 | dispatch 后约 20–50 ms 发 cancel（Codex 在收到 turn/started 后立刻 interrupt） | 核对是否写入；OpenCode 接着再发第二条，看第一条是否被一并送达（僵尸） |
| P2b | 模型已开始后取消 | 全部 | 第一个模型输出之后 cancel | 应已写入；Codex 应有 `<turn_aborted>`；Claude 应有中断标记 |
| P3 | Provider 拒绝 | Codex、Claude 优先 | Codex 用线程级 `model` 指定一个不存在的模型；Claude 用进程级环境变量把 API 地址指向关闭的本地端口。其余几家，模型目录里有不可用模型就用它，否则记“未测” | 应已写入；记录 Hub 的终态与错误数据（Claude 的 `errorKind`） |
| P4 | 接口校验失败 | 分家 | Codex 发超过 1,048,576 字符的输入；dsh 发嵌入 resource；OpenCode 发无 data 的 image；OpenClaw 发超过 2 MiB 的输入；Claude 发 audio 块加文本 | 前四个应不写入；Claude 应写入文本、静默丢掉 audio |
| P5 | 进程被杀 | 全部 | 对 Hub 启动的进程组发 SIGKILL，三个时点：dispatch 后约 20 ms、E1 之后、流式进行中。然后重启并 resume | 核对写入情况；Hermes 和 OpenClaw 看网关回合是否继续、是否结算；OpenCode 看是否出现自动续跑 |
| P6 | 原生命令的效果 | Claude、Hermes、OpenClaw、OpenCode、Codex | 写入标记后，分别执行 `/compact`（各家）、Claude 原样 `/clear`、Hermes 的 `/reset` 和 `/undo 1`、OpenClaw 的 `/new` 和 `/reset` | 用各家的读取路径看标记是否还在：Claude 看是否生成了新 JSONL；Hermes 看 load 回放里是否还有；OpenClaw 看 `sessions.get` 的 sessionId 是否变化；Codex 看 turns/list 是否出现 compaction |
| P7 | Codex 的 clientId | Codex | 带 `clientUserMessageId` 发起；重启 app-server 后再 turns/list | userMessage 实时带 clientId；重启后回读仍带（区分 paginated 与 legacy 两种历史模式） |
| P8 | Claude 原始回显 | Claude | 会话 `_meta` 加 emitRawSDKMessages 过滤器 | 收到 `_claude/sdkMessage` 的 user `isReplay`；对比回显前后 JSONL 文件大小，确认回显时已写入；回合行为不变 |
| P9 | OpenClaw 斜杠与前缀 | OpenClaw | 默认前缀发 `/compact`，再用 `_meta.prefixCwd=false` 发一次 | 两种情况下网关是否都执行了压缩 |

---

## 7. 来源清单

阅读日期均为 2026-11-02（本机时钟 11-03 凌晨）。核实方式的写法：“本机源码”表示打开本机安装包或仓库文件逐行阅读；“固定 tag 源码”表示经 `gh api` 解析 tag 后从 raw.githubusercontent 下载到 scratchpad 阅读；“打开原文”表示用 curl 抓取原文。

| 编号 | 位置或 URL | 标题或内容 | 作者或机构 | 版本、commit 或日期 | 核实方式 |
|---|---|---|---|---|---|
| S1 | `src/contexts/session/application/runtime.ts`（:153、1303–1510） | Runtime execute 与结算 | HarnessHub | `cc/relay-design` @ 07a0825 | 本机源码 |
| S2 | `src/adapters/control/acp.ts` | ACP 防腐层 | HarnessHub | 同上 | 本机源码 |
| S3 | `src/adapters/control/claude.ts` | Claude 驱动 | HarnessHub | 同上 | 本机源码 |
| S4 | `src/adapters/control/codex.ts` | Codex 驱动 | HarnessHub | 同上 | 本机源码 |
| S5 | `src/adapters/control/opencode.ts` | OpenCode 驱动 | HarnessHub | 同上 | 本机源码 |
| S6 | `src/adapters/control/hermes.ts` | Hermes 驱动 | HarnessHub | 同上 | 本机源码 |
| S7 | `src/adapters/control/openclaw.ts` | OpenClaw 驱动 | HarnessHub | 同上 | 本机源码 |
| S8 | `src/contracts/control.ts`、`src/adapters/control/{factory,native-dependencies}.ts` | 控制契约与驱动选择 | HarnessHub | 同上 | 本机源码 |
| S9 | `docs/proposals/relay/round1/r1、r3、r4、r5、r7*.md` | 第一轮报告（D13、I-3、D11、H3、D18 及背景） | 接力设计小组 | 2026-11-02 | 本机文件 |
| S10 | `/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` | claude-agent-acp 主实现 | agentclientprotocol | 0.99.1 | 本机源码 |
| S11 | 同包 `dist/v2/prompt.js`、`dist/v2/initialize.js`、`dist/session-failure-extension.js` | ACP v2 提示、失败类别 | agentclientprotocol | 0.99.1 | 本机源码 |
| S12 | 同包 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（:1862–1869、6600–6735） | SDK 类型（persistSession、SDKUserMessageReplay、shouldQuery、client_composed） | Anthropic | 0.3.312 | 本机源码 |
| S13 | `~/.nvm/versions/node/v26.11.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` | Claude Code CLI（`strings -n 8`，片段见 C1、C5、C9） | Anthropic | 2.1.316 | 二进制 strings |
| S14 | claude-agent-acp 的 `node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts`（:2607–2640） | ACP v2 PromptResponse 定义 | agentclientprotocol | SDK 2.1.0 | 本机源码 |
| S15 | https://agentclientprotocol.com/protocol/prompt-turn.md | Prompt Turn（v1） | ACP | 2026-11-02 读取 | 打开原文 |
| S16 | https://agentclientprotocol.com/protocol/session-setup.md | Session Setup（v1：load 必须重放，resume 不得重放） | ACP | 同上 | 打开原文 |
| S17 | https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md | Prompt Lifecycle（v2：受理等于插入；插入不等于持久） | ACP | 同上（v2 提案阶段） | 打开原文 |
| S18 | https://agentclientprotocol.com/rfds/message-id.md | RFD：Message ID（2026-06-05 Completed） | michelTho、nemtecl，倡导人 benbrandt | 同上 | 打开原文 |
| S19 | https://agentclientprotocol.com/rfds/v2/prompt.md | RFD：v2 Prompt Lifecycle | benbrandt | 同上 | 打开原文 |
| S20 | https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/request_processors/turn_processor.rs | turn/start、inject_items、interrupt | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S21 | 同 tag `codex-rs/core/src/session/turn.rs` | run_turn 与写入点 | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S22 | 同 tag `codex-rs/core/src/session/mod.rs` | record_user_prompt_and_emit_turn_item、persist | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S23 | 同 tag `codex-rs/core/src/hook_runtime.rs` | record_pending_input | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S24 | 同 tag `codex-rs/core/src/tasks/mod.rs`、`core/src/context/turn_aborted.rs` | 中断标记与 flush | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S25 | 同 tag `codex-rs/rollout/src/recorder.rs` | rollout 写线程 | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S26 | 同 tag `codex-rs/rollout/src/policy.rs` | 哪些事件进 rollout | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S27 | 同 tag `codex-rs/core/src/session/inject.rs` | 注入语义 | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S28 | 同 tag `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`、`codex-rs/protocol/src/items.rs` | clientUserMessageId 与 UserMessageItem.client_id | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S29 | 同 tag `codex-rs/app-server/README.md`（:647–667） | Item history anchors | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S30 | 同 tag `codex-rs/thread-store/src/live_thread.rs`、`codex-rs/thread-store/src/local/live_writer.rs` | append 与 persist 语义 | OpenAI | 6ff1e1ca | 固定 tag 源码 |
| S31 | scratchpad `relay/r5/codex-ts/v2/{TurnStartParams,ThreadItem}.ts` | 由本机 0.166.0 生成的 schema（R5 产出） | OpenAI / R5 | 0.166.0 | 二手交叉核对 |
| S32 | https://github.com/anomalyco/opencode/tree/v2.2.5/packages/cli/src/acp （prompt、turn、translate、replay、catalog、sessions、content） | OpenCode ACP 层 | anomalyco | 9bbb8ce1 | 固定 tag 源码 |
| S33 | 同 tag `packages/core/src/session/{session,prompt,inbox,execution,command,store}.ts`、`execution/restart.ts`、`runner/{index,step}.ts` | 准入、送达、中断、恢复 | anomalyco | 9bbb8ce1 | 固定 tag 源码 |
| S34 | 同 tag `packages/schema/src/session-message.ts` | 消息类型（含 synthetic） | anomalyco | 9bbb8ce1 | 固定 tag 源码 |
| S35 | 同 tag `packages/cli/src/server-process.ts`、`packages/cli/src/commands/handlers/{acp,serve}.ts` | stdio 私有服务器、注册 | anomalyco | 9bbb8ce1 | 固定 tag 源码 |
| S36 | `~/.nvm/…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-acp/lib/index.js` | dsh ACP 桥 | DeepSeek | 0.2.1-rc.5 | 本机源码 |
| S37 | 同目录 `dsh-agent-loop/lib/index.js`、`dsh-agent/lib/index.js` | inbox、回合、consumed-work | DeepSeek | 0.2.1-rc.5 | 本机源码 |
| S38 | 同目录 `dsh-session-persistence-jsonl/lib/index.js`；`dsh --help` | 200 ms 批量与 fsync；CLI 帮助 | DeepSeek | 0.2.1-rc.5 | 本机源码；帮助输出 |
| S39 | `~/.hermes/hermes-agent/acp_adapter/{gateway_server,gateway_commands,gateway_session_meta,server}.py` | Hermes 查看器 | Nous Research（Hermes Agent） | v0.22.5 @ bf0203a794 | 本机源码 |
| S40 | 同仓 `gateway/{session_controls,session_authority}.py` | 网关准入 | 同上 | 同上 | 本机源码 |
| S41 | 同仓 `agent/turn_context.py` | `_persist_turn_start` | 同上 | 同上 | 本机源码 |
| S42 | `/opt/homebrew/lib/node_modules/openclaw/dist/server-DNoj34fZ.mjs` | ACP 桥 | OpenClaw | 2026.10.9 | 本机源码（打包产物） |
| S43 | 同目录 `dist/chat-send-handler-B0jivtwJ.mjs`、`dist/user-turn-transcript-DuAfBkUt.mjs` | chat.send 与用户回合记录 | OpenClaw | 2026.10.9 | 本机源码（打包产物） |
| S44 | 同包 `docs/web/webchat.md`（:52–80）、`docs/cli/acp.md`（:31–47）、`docs/tools/slash-commands.md`（:177–215）、`docs/concepts/compaction.md`（:315–321） | 准入与持久的区别、ACP 兼容性、斜杠命令 | OpenClaw | 2026.10.9 随包 | 本机文件 |
