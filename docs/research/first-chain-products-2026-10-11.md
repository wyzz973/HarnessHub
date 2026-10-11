# HarnessHub 第一链路调研：Multica、多 Harness 统一界面产品与 Hermes / dsh 的 ACP 接入

调研日期：2026-10-11。目的：为“用户 → HarnessHub → 各 Harness 回复”这条第一链路，以及新接入的 Hermes Agent、DeepSeek Harness（dsh）提供参考依据。

## 0. 结论速览

1. **Multica 支持 Hermes 和 dsh，但两者接法完全不同。**
   - Hermes 走通用 ACP：`hermes acp`，并设置环境变量 `HERMES_YOLO_MODE=1`。它针对 Hermes 做了很多特殊处理：参数位置、跳过冗余的 set_model、识别“恢复会话却被静默新建”、stderr 错误嗅探、prompt 返回后留静默窗口。
   - dsh **不走 ACP**。它要求用户先装一个 Multica 自有的 profile bundle，再执行 `dsh --profile multica --stdio`，用私有的 JSONL v1 协议通信；注册前先跑一次 `--probe`。按 PR #6923（2026-08）的说法，原因是当时 dsh 的 ACP 面缺少会话恢复、MCP 注入和结构化事件。
   - Multica 是“无人值守”的产品：所有审批自动通过，提问一律关闭。它的事件流水线和错误分类值得借鉴，交互模型不宜照搬。
2. **第一链路上最大的差距是进程模型。** Zed、AionUi、Happy、Toad 都让 agent 进程跨回合常驻，并在用户打开对话时就预热。Hub 与 Multica、Vibe Kanban 一样每回合冷启动。按 Hub 旧实现的实测，仅启动并建立会话这一步：Claude 约 2.9s，Codex 约 4.3s，Cursor 约 7.8s。依赖 `session/load` 的 Harness（Gemini、Cursor、Hermes）每轮还要回放全部历史，对话越长越慢。
3. **就绪状态和认证流程是第二大差距。**
   - 就绪状态：AionUi 用“补全 PATH → `--version` → 真实 ACP 握手”三步区分“未安装 / 需登录 / 不可用”。
   - 认证流程：Zed 按 `authMethods` 渲染认证卡，回合中遇到 `-32000` 时把未发出的消息放回输入框。
   - Hub 只在发送时核实认证与额度，也没有利用 ACP 的 `authMethods` 或 `-32000`。
4. **本机 Hermes 0.12.0 比上游落后很多。** 本机版本对应 2026-05-06 的提交 `a0556b8`，上游已到 v0.21.6（2026-10-08）。
   - 上游已新增：模式、终端认证 `hermes-setup`、“本会话允许”、编辑审批、审批超时可配（默认 300s）、修复 set_model 误路由（#59089）、`--check`/`--version`、新会话在有提示词前不落库。
   - 0.12.0 本身还有几个对接要点：set_model 会把同一提供方的模型误路由；内部异常时以 `Error: …` 文本加 `end_turn` 结束；审批请求的工具 id 是合成的 `perm-check`；回复未知选项 id 会被当作“允许一次”；`session/new` 会立即在 `state.db` 写一条空会话。
5. **dsh 官方把 ACP 定位为“仅供自动化”的接口。**
   - 只发送已提交的整条消息和思考，没有逐字增量。
   - 不提供命令、模式、计划、标题、提问、`session/load`、fork。
   - `authMethods` 恒为空，`agentInfo.version` 恒为 `0.0.1`。
   - acp profile 默认用 `deepseek-official/deepseek-v4-flash`，与 Web profile 的模型配置分开。
   - 本机 0.2.1-alpha.1 有两个 ACP 结算缺陷，已在 alpha.2（2026-10-09）修复：部分失败被报成 `end_turn`/`cancelled`；取消时可能一直占住 prompt 槽位。
6. **官方配置示例与注册表收录情况。** Hermes 官方给出了 Zed、VS Code 的配置示例。dsh 官方没有任何编辑器配置示例。官方 ACP Registry（42 个目录）里两者都没有收录。

---

## 1. 方法、版本与证据等级

- **范围限制**：全程只读。没有运行任何 Harness（hermes、dsh、codex、claude 等）；没有安装任何东西；没有读取凭据文件。
- **为核实路径解析读过的启动脚本**：`~/.local/bin/hermes`、cmux 的 hermes shim，以及 cmux 包装脚本。它们都是启动脚本，不含凭据。
- **外部源码的读法**：读本机已有检出，或用 `gh api` 读取，或做只读浅克隆。浅克隆放在本会话 scratchpad：`scratchpad/src/`（Zed、Toad、AionUi、AionCore、vibe-kanban、registry），`scratchpad/hermes-upstream/`（Hermes 上游的 ACP 文件）。
- **代理分工**：Multica 的通用机制、ACP 客户端（Zed/JetBrains/Toad）、多 GUI 产品（AionUi/Vibe Kanban/Happy）三块由子代理阅读，我抽查了关键链接（Zed 连接复用、AionCore 空闲回收常量与 Hermes 观测注释、Happy 的进程复用哈希、Vibe Kanban 的 ACP 续聊方式）。Hermes、dsh 以及 Multica 中的 Hermes/dsh 专项由我直接阅读。
- **标注规则**：
  - 【源码】【文档】：在固定 commit 的源码或官方文档中确认。
  - 【推测】：由阅读推断，未经运行验证。
  - 【分析】：对 Hub 的判断。

**固定版本**

| 对象 | 固定点 |
|---|---|
| Multica | `c8d6a1fad03d20a020ca90d1e50257d9f060ee87`（2026-10-10）。main 当前是 `a820c9a0`，之后的 4 个提交没有改 runtime 适配代码；hermes.go 最后修改于 09-27，dsh.go 于 09-12。 |
| Hermes（本机） | `a0556b861f2667a49ded048c9cfac88defff8c5f`，pyproject 0.12.0，2026-05-06，`git describe` 为 `v2026.4.30-649`。 |
| Hermes（上游） | main `97a9ae8ee55d31bebce49f1fb6b5ef775323976a`（2026-10-11），最新发行 v0.21.6（2026-10-08）。 |
| dsh（本机） | tag `dsh-v0.2.1-alpha.1` = `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（2026-10-03）。上游已有 `dsh-v0.2.1-alpha.2` = `d743267388641bc76f17c45ce8b4c231aed1d32c`（2026-10-09）。 |
| Zed | `93d745668805029476e6d7fbb19652116fed51de` |
| Toad | `dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1` |
| ACP 规范 | `7725341d46d7d60f907133cd77fa9f1737c35d3b` |
| ACP Registry | `09ab427109ec5779bab31b7c9216ef294b693bf4` |
| AionUi / AionCore | `6744099b279b991c17e31c243f0920477bd31cb6` / `6dff72c8fd93db8adf381e31ea381f30e72156aa` |
| Vibe Kanban | `d5cbb5380fa0b32e98ef9b8d987f63decce4be3a` |
| Happy | `99f415fa0d12d233a80a77fd88122bfb19b17477` |

**Hub 现状的依据**：

- 实现仓库（HarnessGateway 开发工作树）的 README、能力矩阵和 ADR-030。
- 工作区中**尚未提交**的 Hermes/dsh 接入改动：`src/adapters/control/hermes.ts`，以及 `plan/native-capabilities.json` 中 hermes、dsh 两节。这部分可能随后变化。

---

## 2. Multica 如何接入不同 runtime

链接前缀统一为 `https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/`，下文以 `M:` 代替。

### 2.1 产品形态

【源码】Multica 的主要用法是把 issue 指派给 agent，结果写回 issue 评论（[M:README.md#L9-L15](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/README.md?plain=1#L9-L15)）。

Direct Chat 以及 Slack、飞书等频道的消息也进入同一个任务队列，一条消息就是一个任务（[M:server/internal/service/task.go#L1906-L1919](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/service/task.go#L1906-L1919)）。

界面上：

- 审批与提问不会展示给用户。
- 聊天里把执行过程折叠起来，答案单独显示（[M:packages/views/chat/components/chat-message-list.tsx#L1062-L1150](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/packages/views/chat/components/chat-message-list.tsx#L1062-L1150)）。

【分析】它的发现、恢复、事件和错误工程可以迁移到 Hub，交互模型不行。

### 2.2 发现与就绪

【源码】

- **支持范围**：25 个协议族，外加复用 pi 协议的 omp（[M:server/pkg/agent/agent.go#L364-L390](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/agent.go#L364-L390)）。其中包括 `hermes` 和 `dsh`。Gemini CLI 已于 2026-06-24 移除（[76c58a4](https://github.com/multica-ai/multica/commit/76c58a4ee860b1b4a0fd57ac72997b6743a4fcf8)）。
- **查找顺序**（[M:server/internal/daemon/agents_probe.go#L118-L176](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/agents_probe.go#L118-L176)）：
  1. 环境变量 `MULTICA_<X>_PATH`；
  2. `exec.LookPath`；
  3. 登录 shell 兜底：用 `$SHELL -ilc` 一次解析全部命令，脚本先 `unalias`，超时 3s；结果缓存 30 分钟，PATH/SHELL/HOME 一变就失效（[M:server/internal/daemon/config.go#L1257-L1378](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/config.go#L1257-L1378)）；
  4. 已知安装位置：Codex 桌面版内置 CLI、DSH Desktop 生成的 shim。
  - `MULTICA_HERMES_PATH`/`MULTICA_HERMES_MODEL` 见 [agents_probe.go#L218](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/agents_probe.go#L218)，`MULTICA_DSH_PATH`/`MULTICA_DSH_MODEL` 见 [#L256](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/agents_probe.go#L256)。
- **版本与可用性判定**：
  - 运行 `<cli> --version`，超时 10s，带最低版本表（[M:server/pkg/agent/version.go#L18-L36](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/version.go#L18-L36)）。
  - 结果分五类：`unavailable` 表示瞬时问题，不拆掉已有注册；`below_minimum`；`not_executable`；`missing_profile`；`incompatible_profile`。
  - 除版本过低外，下线都要两轮确认（[M:server/internal/daemon/daemon.go#L2301-L2426](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L2301-L2426)）。
  - 可用集合只增不减；每 2 分钟重新发现，每 10 分钟重测版本（[M:server/internal/daemon/agents_refresh.go#L10-L43](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/agents_refresh.go#L10-L43)）。
- **发现阶段不检查登录**：认证问题只在运行时被归类。Grok 是例外，每次运行都按 `authMethods` 调用 `authenticate`（[M:server/pkg/agent/grok.go#L639-L670](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/grok.go#L639-L670)）。
- **上报与显示**：
  - 下线原因结构化，并附修复命令（[M:server/internal/daemon/client.go#L1028-L1073](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/client.go#L1028-L1073)）。
  - 前端派生四种状态：online、recently_lost、offline、long_offline（[M:packages/core/runtimes/derive-health.ts#L9-L28](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/packages/core/runtimes/derive-health.ts#L9-L28)）。
  - 模型目录按需拉取；失败时选择器显示原因，并保留手填入口（[M:server/internal/daemon/daemon.go#L4702-L4864](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L4702-L4864)）。

### 2.3 启动方式（摘要）

【源码】

| runtime | 命令 | 协议 |
|---|---|---|
| Codex | `codex app-server --listen stdio://`（[codex.go#L363-L370](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/codex.go#L363-L370)） | JSON-RPC |
| Claude | `claude -p --output-format stream-json --input-format stream-json --permission-mode bypassPermissions --disallowedTools AskUserQuestion [--resume]…`（[claude.go#L1078-L1136](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/claude.go#L1078-L1136)） | stream-json，非 ACP |
| OpenCode | `opencode run --format json --dangerously-skip-permissions [--session]`（[opencode.go#L95-L152](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/opencode.go#L95-L152)） | JSON 事件 |
| Cursor | `cursor-agent -p --output-format stream-json --yolo …`（[cursor.go#L1015-L1054](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/cursor.go#L1015-L1054)） | stream-json |
| OpenClaw | `openclaw agent --json --session-id <id> --message …`（[openclaw.go#L226-L271](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/openclaw.go#L226-L271)） | 一次性 JSON |
| Pi | `pi -p --mode json --session <jsonl>`（[pi.go#L1067-L1116](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/pi.go#L1067-L1116)） | JSON 事件，非 RPC |
| **Hermes** | `hermes [全局参数] acp [acp 子命令参数]`，环境变量 `HERMES_YOLO_MODE=1`（[hermes.go#L495](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L495)） | ACP |
| **dsh** | `dsh --profile multica --stdio`（[dsh.go#L119-L121](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/dsh.go#L119-L121)） | 私有 JSONL v1 |
| Kimi、Kiro、Grok、Qoder、Trae、Reasonix、QwenPaw、Dim、MCode、ZeroClaw | 各自的 `acp` 子命令或参数 | ACP |

**通用 ACP 路径**（代码集中在 hermes.go 的 `hermesClient`）：

- `initialize` 声明的 `clientCapabilities` 为 `{}`（[#L683](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L683)），不声明 fs、terminal、elicitation。
- runtime 没在 `mcpCapabilities` 里声明 http/sse 时，丢掉这类 MCP（[#L702](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L702)）。
- 没有发送 `session/cancel`，取消就是杀进程树。
- 所有进程都经统一入口启动：Unix 用进程组，Windows 用 Job Object（[launch.go#L105-L140](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/launch.go#L105-L140)）。

### 2.4 模型、恢复、权限、事件与错误

【源码】

- **模型**：ACP 用 `session/set_model`，失败即判任务失败（[kimi.go#L304-L346](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/kimi.go#L304-L346)）。effort 走 `set_config_option` 并回读确认，只对确认真正生效的 runtime 开启（[acp_effort.go#L226-L305](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/acp_effort.go#L226-L305)、[thinking.go#L955-L999](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/thinking.go#L955-L999)）。
- **会话恢复**：
  - setup 成功、即将发 prompt 时才把会话 id 落库（[hermes.go#L870](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L870)）。这是 MUL-7120 的修复：避免下一轮去恢复一个从未持久化的“幽灵会话”。
  - `ResumeRejected` 必须有正面证据才置位（[agent.go#L260-L295](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/agent.go#L260-L295)）。
  - 只有“失败、有旧会话、本回合没执行任何工具”三者同时满足，才换新会话重试一次，并给 prompt 加连续性说明（[daemon.go#L9125-L9203](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L9125-L9203)）。
  - ACP 拒绝统一由 `classifyACPResumeFailure` 判定（[acp_session.go#L13-L114](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/acp_session.go#L13-L114)）。
- **权限**：
  - 一律自动批准，各 runtime 用 yolo、bypass 或 always-approve 一类参数。
  - ACP 的 `request_permission` 按顺序选：会话级授权 → `allow_once` → `reject_once`。从不选 `allow_always`，也从不回 `cancelled`；都没有就回 `-32603`（[hermes.go#L1558](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L1558)）。
  - 提问全部关闭，例如 `--disallowedTools AskUserQuestion`。
- **事件**：
  - 统一成 7 种消息：text、thinking、tool-use、tool-result、status、error、log。**没有 plan**（[agent.go#L199-L223](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/agent.go#L199-L223)）。
  - daemon 每 500ms 批量上送一次，但**第一条可见事件立即发出**（[daemon.go#L9431-L9513](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L9431-L9513)）。
  - 服务端存入 Postgres，再经 WebSocket 推给前端。
- **终态与错误**：
  - 必须见到 result 才算完成，进程干净退出不算（[stream_json_result.go#L73-L162](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/stream_json_result.go#L73-L162)）。
  - 有序子串分类器（[taskfailure/classify.go#L78-L318](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/taskfailure/classify.go#L78-L318)），覆盖：
    - context_overflow；
    - auth：401/403、not logged in、invalid api key；
    - quota：402、usage limit、credits；
    - 限流：429/529、overloaded；
    - 网络、model not found、超时、版本过低等。
  - 每类有中文提示，例如“智能体的模型账号登录已失效。重新登录后再试。”（[chat.json#L66-L70](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/packages/views/locales/zh-Hans/chat.json#L66-L70)）。
- **进程**：没有跨回合复用；收到 result 或 prompt 返回后就关闭。阶段耗时（runtime_started、first_output_received 等）只记日志，不进指标（[task_phase_timing.go#L12-L90](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/task_phase_timing.go#L12-L90)）。

### 2.5 Hermes 专项（Multica 支持，走 ACP）

【源码，均在 hermes.go 及其所引文件】

1. **启动参数布局**
   - 全局参数（`--provider`、`-m`、`-p/--profile` 等）必须放在 `acp` **之前**；`acp` 子命令自己的参数（`--accept-hooks --version --check --setup --setup-browser --yes`）放在**之后**。原来写成 `hermes acp <custom args>` 时，全局参数会导致 argparse 在握手前就报错退出（GH #8878；[#L147-L154](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L147-L154)、[#L204-L235](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L204-L235)）。
   - 用户自定义参数里的 `acp` 会被拦截。
2. **审批**
   - 设置 `HERMES_YOLO_MODE=1`（[#L495](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L495)）。注释说明它只关闭“危险 shell 命令”的审批；较新的 Hermes 另有 ACP 编辑审批（`acp_adapter/edit_approval.py`），写文件前仍会询问，所以客户端仍须应答（[#L1296-L1301](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L1296-L1301)）。
   - 编辑审批只提供 `["allow_once","deny"]`，回复任何其他 id 都会被当作拒绝。Multica 曾硬编码 `approve_for_session`，结果所有写文件都被静默拒绝（multica#5300；[#L1330-L1341](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L1330-L1341)）。
3. **会话恢复**
   - 用 `session/resume`，然后读 `_meta.hermes.sessionProvenance.acpSessionId`，判断恢复是否真的落在请求的会话上（[#L720-L736](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L720-L736)、[#L2547](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L2547)）。原因是 Hermes 恢复不存在的会话时会**静默新建**并返回成功（GH #6806）。
   - 若 prompt 返回 `stopReason=refusal` 且本回合没有任何活动，就判为会话丢失（GH #6150；[#L1006](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L1006)）。
   - 收到 400 “assistant must not be empty” 时判为历史中毒，不再恢复该会话（[#L1026](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L1026)）。
4. **模型切换**
   - 会话当前模型与所选等价时，跳过 `session/set_model`（[#L799-L806](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L799-L806)、[#L2459](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L2459)）。
   - 原因：Hermes 的 set_model 在“解析出的提供方等于当前提供方”时会再做一次探测，可能把 `custom:deepseek-v4-pro` 改路由到 OpenRouter，然后报认证错误（MUL-5029 / [hermes-agent#59089](https://github.com/NousResearch/hermes-agent/issues/59089)，2026-09-10 关闭）。
   - 模型 id 的格式是 `provider:model`，提供方小写。
5. **事件时序**
   - 发 prompt 之前收到的回放一律丢弃（[#L558](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L558)）。
   - prompt 返回后再等 250ms 无新通知（最长 2s）；关闭 stdin 后再给 2s 让输出排空（[#L442-L443](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L442-L443)、[#L923](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L923)）。原因是 Hermes 的最后一个回复块可能在 prompt 响应**之后**才到。
   - Hermes 的中间叙述和最终答案都用 `agent_message_chunk` 发送。
6. **假成功识别**
   - 上游 LLM 失败时，Hermes 仍报 `end_turn`。
   - Multica 嗅探 stderr：出现 ❌、`[ERROR]`、`after N retries`、`Non-retryable`、`BadRequestError`、`AuthenticationError` 这类**终态**标记，或回复中出现 `API call failed after N retries`，才把结果改判为失败（[#L3093-L3155](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L3093-L3155)、[#L3492](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L3492)）。
   - INFO/DEBUG 级别的回显日志被排除。
7. **上下文与工具名**：不在 prompt 前拼接系统提示，Hermes 自己从 cwd 加载 AGENTS.md（[#L854](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L854)；daemon.go [#L6510-L6524](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L6510-L6524) 记录了 hermes 0.18.2 的实测）。工具名从标题 `terminal: ls`、`read: /path` 中解析（[#L3005](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/hermes.go#L3005)）。
8. **模型目录**
   - 另起一个 `hermes acp` 进程，走到 `session/new`，超时 40s。配置正常时约 2s 返回；未配置提供方时约 25s 才报错（[models.go#L1521-L1540](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/models.go#L1521-L1540)、[#L1931-L1940](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/models.go#L1931-L1940)）。
   - 未配置时附加提示：daemon 的环境与登录 shell 不同，并给出复现命令 `env -i HOME="$HOME" PATH="$PATH" hermes model`（[#L1565-L1571](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/models.go#L1565-L1571)）。
   - Hermes 不提供 configOptions；Multica 在 v0.20.0 上复核过，`set_config_option` 会被接受但不生效（[thinking.go#L955-L996](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/thinking.go#L955-L996)）。
9. **隔离环境**
   - 只有 agent 绑定了技能时，才为每个任务构造 `HERMES_HOME` overlay（[execenv/hermes_home.go#L29-L55](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/execenv/hermes_home.go#L29-L55)）。
   - `state.db` 与 memories 按 (agent, 源 home, 对话) 链接到持久存储（[daemon.go#L7975-L8050](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L7975-L8050)），GC 期限分别为 14 天和 90 天（[config.go#L80-L81](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/config.go#L80-L81)）。
   - Hermes 的会话不依赖 cwd，只看 `state.db` 能否找到（[daemon.go#L6775](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/daemon.go#L6775)）。

### 2.6 dsh 专项（Multica 支持，但不走 ACP）

【源码 / 文档】

- **协议**：dsh.go 写明“不依赖 ACP”，自己定义 JSONL stdio 协议 v1，消息类型有 execute、cancel、ready、session、text、thinking、tool_call、tool_result、usage、result（[dsh.go#L17-L33](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/dsh.go#L17-L33)、[#L385-L428](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/dsh.go#L385-L428)）。
  - 模型 id 是 `provider/model`（[#L123](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/pkg/agent/dsh.go#L123)）。
  - 取消时先发 cancel，等 3s 后再终止进程。
- **前置安装**：这个协议由 Multica 自己的 bundle [multica-ai/dsh-multica-runtime](https://github.com/multica-ai/dsh-multica-runtime) 提供，需要先执行 `dsh plugin --profile multica add <bundle>`，或设置 `MULTICA_DSH_PROFILE_BUNDLE` 让 daemon 代装。
- **注册条件**：只有 `dsh --profile multica --probe` 成功后才注册 dsh；同时要求 `DEEPSEEK_API_KEY`（或写在 dsh 自己的设置里）（[install-agent-runtime.mdx#L58](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/apps/docs/content/docs/install-agent-runtime.mdx?plain=1#L58)）。
- **探测超时 15s**：注释说明健康路径要启动一整个 DSH 进程，冷 VM 上 5 秒不够；profile 缺失时 DSH 会挂住而不是拒绝（[agents_probe.go#L399-L414](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/agents_probe.go#L399-L414)）。
- **模型目录**：来自 `dsh --profile multica --list-models`（[providers.zh.mdx#L59](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/apps/docs/content/docs/providers.zh.mdx?plain=1#L59)）。
- **DSH Desktop**：不会把 `dsh` 装到 PATH 上。daemon 会去 `~/Library/Application Support/DSH Desktop` 找它生成的 shim（[config.go#L1003-L1043](https://github.com/multica-ai/multica/blob/c8d6a1fad03d20a020ca90d1e50257d9f060ee87/server/internal/daemon/config.go#L1003-L1043)）。
- **为什么不用 ACP**：PR [#6923](https://github.com/multica-ai/multica/pull/6923)（2026-08-13 合并，验证对象是 `@deepseek-ai/dsh@0.1.0-rc.6`）写明：“DSH's built-in headless and ACP surfaces do not currently expose the complete contract Multica needs: session resume, MCP server injection, structured thinking/tool/usage events, and runtime model/thinking-level discovery.”
  - 【分析】0.2.1 的 ACP 已经支持 resume、MCP 注入、模型与 effort 配置项、思考与工具事件（见 4.2）。这个理由对 0.2.x 已部分失效，但“没有逐字增量”仍然成立。

### 2.7 借鉴与不照搬（Multica）

【分析】

**可借鉴**

1. 恢复失败分级：区分“拒绝 / 暂时不可用 / 无法判断”；setup 失败不发布会话 id；识别静默新建的会话。
2. 终态契约：exit 0 不算成功；ACP 的 `end_turn` 需要结合 stderr 的终态标记一起判断。
3. 发现稳健性：登录 shell 兜底并缓存；两轮确认后才下线；离线原因附修复命令。
4. ACP 客户端细节：不选 `allow_always`；只回复对方提供的 optionId；prompt 返回后留静默窗口。
5. 首个可见事件立即推送，并记录各阶段耗时。

**不宜照搬**

1. 全面自动批准、关闭提问。
2. 每个任务改写运行环境：overlay `HERMES_HOME`、`--strict-mcp-config`、`--settings`、往工作区写文件。这与“沿用原安装”冲突。
3. 失败后自动换新会话重跑。即使限定“未执行工具”，也与 Hub“不自动重跑未知结果”的契约冲突。

---

## 3. 其他把多个 agent CLI 统一到一个界面的产品

入选 6 个：Zed、JetBrains、Toad、AionUi、Vibe Kanban、Happy。

未入选及原因：

- **Conductor**：闭源，文档写明自带 Claude Code/Codex/OpenCode，与“沿用原安装”相反（[文档](https://www.conductor.build/docs/reference/harnesses)）。
- **Omnara**：README 已改为 managed agent 平台（[README#L10-L12](https://github.com/omnara-ai/omnara/blob/53926089ac019e975805b33cf5f0e4b591a30abe/README.md#L10-L12)）。
- **Magpie、CC Switch**：已有调研。

### 3.1 Zed 外部 agent（ACP 参考客户端）

前缀 `Z:` = `https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/`

**a. 首次使用**

【源码 / 文档】

- **安装**：从 ACP Registry 安装，入口是 `zed: acp registry` 或 Settings → External Agents → Add Agent。注册表每小时最多刷新一次（[Z:crates/project/src/agent_registry_store.rs#L20-L25](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/project/src/agent_registry_store.rs#L20-L25)）。
- **安装时机**：点 Install 只写入设置，首次连接时才真正下载。
- **没有就绪预检**：设置页对外部 agent 固定显示 Stopped（[Z:crates/settings_ui/src/pages/external_agents_page.rs#L211-L222](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/settings_ui/src/pages/external_agents_page.rs#L211-L222)）。状态只在线程里出现：Loading、Installing、认证卡、"{agent} Exited"（[Z:crates/agent_ui/src/conversation_view.rs#L1758-L1778](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/conversation_view.rs#L1758-L1778)）。
- **认证**：
  - `session/new` 返回 `-32000` 时，显示 “Authenticate to {agent}” 卡片，按 `authMethods` 渲染按钮（[Z:…/conversation_view.rs#L2552-L2650](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/conversation_view.rs#L2552-L2650)）。
  - terminal 类认证方法：用同一条启动命令，追加该方法的 args/env，在终端面板里运行（[Z:crates/agent_servers/src/acp.rs#L1900-L1983](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_servers/src/acp.rs#L1900-L1983)）。
  - 认证成功后在原连接上重新 `session/new`，不重启进程。
  - 输入框里的 `/login`、`/logout` 会被拦截成认证流程。

**b. 原生感**

【源码】

- **客户端能力声明**：fs、terminal、`auth.terminal`、boolean 配置项、compaction/notices、elicitation（form/url）（[Z:…/acp.rs#L764-L795](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_servers/src/acp.rs#L764-L795)）。
- **配置项选择器**：configOptions 放在工具栏，按 category 绑定快捷键：mode `shift-tab`，model `alt-tab`，thought_level `ctrl-'`。
- **记住选择**：用户选中的值会写回 `agent_servers.<id>.default_config_options`，以后新会话自动套用（[Z:crates/agent_ui/src/config_options.rs#L800-L830](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/config_options.rs#L800-L830)）。
- **审批**：按钮直接显示 agent 给的选项名（[Z:…/thread_view.rs#L10471-L10588](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/conversation_view/thread_view.rs#L10471-L10588)）。
- **计划**：固定在输入框上方。
- **等待输入**：发桌面通知 “Waiting for input”。
- **重开线程**：优先 `session/load`，其次 `session/resume`。只能 resume 时显示 “Resumed Session — This agent does not support viewing previous messages”（[Z:…/thread_view.rs#L12339-L12349](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/conversation_view/thread_view.rs#L12339-L12349)）。
- **导入外部会话**：用 `session/list` 导入。

**c. 进程复用**

【源码，已抽查】

- 每个工作区的 Agent Panel 持有一个连接库，按 agent 复用同一个连接（[Z:crates/agent_ui/src/agent_connection_store.rs#L127-L151](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/agent_connection_store.rs#L127-L151)）。
- 一个子进程承载多个会话（[Z:…/acp.rs#L317-L338](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_servers/src/acp.rs#L317-L338)）。
- **预热**：新建草稿线程时就连接并 `session/new`（[Z:…/conversation_view.rs#L1226-L1365](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/conversation_view.rs#L1226-L1365)）。
- **回收**：只卸载“空闲且支持 load”的线程，默认最多保留 5 个（[Z:…/agent_panel.rs#L4299-L4328](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/agent_panel.rs#L4299-L4328)）。

**d. 失败提示**

【源码】

- 启动失败显示 “Failed to Launch”，附退出码、stderr，以及 Retry 和复制按钮。
- 回合中的 `-32000` 显示 “Authentication Required”；点认证后，未发出的消息回到输入框（[Z:…/thread_view.rs#L12176-L12235](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/agent_ui/src/conversation_view/thread_view.rs#L12176-L12235)）。
- 其他错误统一为 “An Error Happened”。
- 调试入口 `dev: open acp logs`，带 Restart Connection 和 Copy All Messages。
- ACP 规范只定义了 `-32000`、`-32002`、`-32800`，没有“额度用尽”的错误码（[ACP schema#L3492-L3557](https://github.com/agentclientprotocol/agent-client-protocol/blob/7725341d46d7d60f907133cd77fa9f1737c35d3b/schema/v1/schema.json#L3492-L3557)）。

**e. 自定义 agent 配置**

【文档】见第 4 节表格。

### 3.2 JetBrains IDE（AI Assistant 的 ACP 支持，闭源，只依据文档）

【文档】

- **安装与发现**：
  - 可从 ACP Registry 安装，IDE 会管理所需的 Node/Python 运行时。
  - 文档原文：“The IDE can detect ACP-compatible agents already installed on your machine and offers to add them”（[acp.html](https://www.jetbrains.com/help/ai-assistant/acp.html)）。
- **认证**：内置的 Claude/Codex 首次使用时选择认证方式；每段对话开头有 “Configured authentication”，可以 Reset；更换认证只影响新对话（[activate-agents.html](https://www.jetbrains.com/help/ai-assistant/activate-agents.html)）。
- **审批**：按 agent 的原始选项名显示，例如 Codex 的 “Allow for Session”、“Allow Commands Starting With”；支持查看 diff、单文件回滚和整体 Rollback（[codex-agent.html](https://www.jetbrains.com/help/ai-assistant/codex-agent.html)）。
- **诊断**：可导出 “Get ACP Logs”；详细日志另有开关，并提示其中含对话内容。
- **配置**：自定义 agent 写在 `~/.jetbrains/acp.json`，`default_mcp_settings` 控制是否透传 MCP。
- **进程复用**：文档没写，无法确认。

### 3.3 Toad（终端 ACP 客户端）

前缀 `T:` = `https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/`

【源码】

- **agent 商店**：21 个 agent 由 TOML 描述，install 动作的命令先显示在可编辑框里由用户确认（[T:src/toad/screens/agent_modal.py#L54-L91](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/screens/agent_modal.py#L54-L91)）。
- **不检测、不认证**：不检测是否已安装，也不显示版本；完全不实现 ACP 认证（[T:src/toad/acp/agent.py#L717-L743](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/acp/agent.py#L717-L743)）。
- **进程**：每个会话一个进程，跨回合常驻，会话挂载时就完成 initialize 和 `session/new`（[T:…/agent.py#L543-L661](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/acp/agent.py#L543-L661)）。
- **会话总览**：显示 notready / busy / **asking** / idle，便于找出卡在审批上的会话（[T:src/toad/session_tracker.py#L7](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/session_tracker.py#L7)）。
- **状态栏**：用 `usage_update` 显示上下文占用与费用。
- **恢复**：`ctrl+r` 打开本地记录的会话列表，只用 `session/load`。
- **一处误读**：`stopReason=max_tokens` 被显示成 “account is out of tokens”，与规范含义不符（[T:src/toad/widgets/conversation.py#L127-L152](https://github.com/batrachianai/toad/blob/dd4f90e8b3700c3de80ad4b0eaa488ad0105e2c1/src/toad/widgets/conversation.py#L127-L152)）。

### 3.4 AionUi（后端为 AionCore）

前缀 `AC:` = `https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/`；`AU:` = `https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/`

**a. 首次使用**

【源码】

- **补全 PATH**：合并登录 shell 的 PATH（最多等 3s）与常见目录（[AC:crates/aionui-runtime/src/shell_env.rs#L159-L185](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-runtime/src/shell_env.rs#L159-L185)）。
- **直连 CLI 的探测**：运行 `--version`，失败分四类：`command_not_found`、`version_probe_failed`、`version_probe_timeout`、`package_lock_invalid`。注释写明“超时不等于安装损坏”（[AC:crates/aionui-ai-agent/src/cli_probe.rs#L8-L52](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-ai-agent/src/cli_probe.rs#L8-L52)）。
- **ACP agent 的探测**：真实执行 `initialize` 和 `session/new`，区分 `command_not_found`、`acp_init_failed`、`auth_required`；握手拿到的 modes/models/configOptions 直接写入目录（[AC:…/services/availability/mod.rs#L206-L307](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-ai-agent/src/services/availability/mod.rs#L206-L307)）。
- **界面**：6 档状态，其中“需登录”单独显示为金色；修复页写明“在线不代表已登录”（[AU:…/AgentCard.tsx#L42-L62](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/desktop/src/renderer/pages/settings/AgentSettings/AgentCard.tsx#L42-L62)）。
- **版本漂移**：与“已验证版本”比较，不一致仍可用但附提示（[AC:crates/aionui-session/src/backend/cli_version.rs#L1-L40](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-session/src/backend/cli_version.rs#L1-L40)）。

**b. 原生感**

【源码】

- ACP configOptions 中 mode、model 两类做专用选择器，其余项进参数面板。
- 审批卡用 agent 的原生选项渲染。
- 计划固定在输入框上方。
- 斜杠命令按会话缓存。

**c. 进程复用**

【源码，已抽查】

- 每个会话一个进程，打开会话即预热（`/runtime/ensure`，同一会话的重复请求合并）。
- 页面可见时每 30s 续租一次，租期 90s（[AU:…/useActiveLease.ts#L4-L55](https://github.com/iOfficeAI/AionUi/blob/6744099b279b991c17e31c243f0920477bd31cb6/packages/desktop/src/renderer/pages/conversation/hooks/useActiveLease.ts#L4-L55)）。
- 单聊空闲 10 分钟回收，每 60s 扫描一次（[AC:crates/aionui-ai-agent/src/idle_scanner.rs#L10-L24](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-ai-agent/src/idle_scanner.rs#L10-L24)）。

**d. 失败提示**

【源码】

- **统一错误结构**：包含归属（应用 / Agent / 模型服务商 / 上游）、42 个错误码、是否可重试、14 种建议（retry、check_agent_login、check_provider_billing、change_model、reduce_context、start_new_session 等），以及跳转目标（[AC:crates/aionui-api-types/src/agent_error.rs#L1-L95](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-api-types/src/agent_error.rs#L1-L95)）。
- **分类关键词**：如 402、insufficient balance、401、invalid api key、429、rate limit、session not found（[AC:…/protocol/send_error.rs#L548-L720](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-ai-agent/src/protocol/send_error.rs#L548-L720)）。
- 【分析】不宜照搬的两点：会话不存在时静默新建；无副作用时自动重发一次。

**e. 启动命令与 Hermes / dsh**

【源码】

- 内置 Hermes，启动命令为 `hermes acp`（[AC:crates/aionui-db/migrations/001_initial_schema.sql#L312-L318](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-db/migrations/001_initial_schema.sql#L312-L318)）。
- 不给 Hermes 映射“全自动”模式（迁移 010）。
- 注释记录了它实际抓到的 Hermes 行为：
  - `initialize` 返回 `authMethods` `[bedrock, hermes-setup]`（[AC:crates/aionui-session/src/backend/acp_conn.rs#L405-L416](https://github.com/iOfficeAI/AionCore/blob/6dff72c8fd93db8adf381e31ea381f30e72156aa/crates/aionui-session/src/backend/acp_conn.rs#L405-L416)）；
  - 用量只有 `{used,size}`；
  - 会原生发出“消息已受理”信号。
- **不支持 dsh**。

### 3.5 Vibe Kanban（已宣布停运，转为社区维护）

前缀 `VK:` = `https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/`

【源码】

- **登录推断**：靠配置文件推断登录状态，界面用推断语气，例如“检测到以前使用（可能需要登录）”。Claude 看 `~/.claude.json` 的修改时间（[VK:crates/executors/src/executors/mod.rs#L205-L286](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/mod.rs#L205-L286)）。
- **Codex 发送前先查登录**：开线程前先查账号，未登录直接报需要认证（[VK:…/codex.rs#L593-L633](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/codex.rs#L593-L633)）。
- **统一日志格式**：区分读文件、改文件（附统一 diff）、执行命令、计划、待办、提问等动作，工具状态含“等待审批”（[VK:crates/executors/src/logs/mod.rs#L65-L255](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/logs/mod.rs#L65-L255)）。
- **进程**：每次执行起新进程，与 Hub 相同。
- **ACP 续聊（已抽查）**：不调用 `session/load`，而是把保存的历史拼成 “RESUME CONTEXT” 提示词，发给一个新会话（[VK:crates/executors/src/executors/acp/harness.rs#L338-L380](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/crates/executors/src/executors/acp/harness.rs#L338-L380)）。
- **默认启动方式**：用 `npx -y` 加固定版本号，不用用户自己装的版本。
- **不支持 Hermes 和 dsh**。

### 3.6 Happy（手机端加本机 daemon）

前缀 `HP:` = `https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/`

【源码，已抽查】

- **进程复用规则**：同一个 Claude 进程连续处理多个回合。只有“启动时就定下的参数”变化时，才结束进程并带 `--resume` 重启；这些参数包括 plan 模式、model、fallbackModel、系统提示、允许/禁止的工具、effort。它们的哈希见 [HP:packages/happy-cli/src/claude/runClaude.ts#L521-L531](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-cli/src/claude/runClaude.ts#L521-L531)，比较逻辑见 [HP:…/claudeRemoteLauncher.ts#L325-L345](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-cli/src/claude/claudeRemoteLauncher.ts#L325-L345)。
- **Codex**：一个 app-server 连接从会话开始用到结束。
- **“回到终端继续”**：每个会话提供一条可复制的命令，例如 `happy claude --resume <id>`（[HP:packages/happy-app/sources/utils/resumeCommand.ts#L29-L40](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-app/sources/utils/resumeCommand.ts#L29-L40)）。
- **认证失败**：只认明确的错误类型；提示用户在本机运行 `claude auth login`，并明说 “Happy has not retried it”（[HP:…/providerAuth.ts#L1-L30](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-cli/src/claude/utils/providerAuth.ts#L1-L30)）。
- **额度**：把限流事件整理成用量窗口，用到 90% 预警，100% 拒绝。
- **通用 ACP 入口**：`happy acp -- <command>`（[HP:packages/happy-cli/src/agent/acp/acpAgentConfig.ts#L6-L53](https://github.com/slopus/happy/blob/99f415fa0d12d233a80a77fd88122bfb19b17477/packages/happy-cli/src/agent/acp/acpAgentConfig.ts#L6-L53)）。没有内置 Hermes 和 dsh；用 `happy acp -- hermes acp` 接 Hermes 理论上可行（【推测】未验证）。

### 3.7 横向对照（第一链路）

| 维度 | Zed | JetBrains | Toad | AionUi | Vibe Kanban | Happy | Multica | Hub 现状 |
|---|---|---|---|---|---|---|---|---|
| 发现本机已装 | 注册表或手动配置 | 自动检测并提示加入 | 不检测 | PATH 补全、`--version`、ACP 握手 | 推断配置文件 | `command -v` | PATH、环境变量、登录 shell、已知位置 | PATH、已知目录、显式路径（probe=not_run） |
| 登录就绪 | 建会话时 `-32000` 弹认证卡 | 首用时选择认证方式 | 无 | 握手判出“需登录” | 推断；Codex 发送前查账号 | 失败后提示命令 | 运行时才分类 | 发送时核实；模型目录接口可返回 `authentication=missing` |
| 进程跨回合 | 常驻；每 agent×工作区一个进程，多会话共用 | 未知 | 每会话常驻 | 每会话常驻，预热，空闲 10 分钟回收 | 每回合新进程 | 常驻，启动参数变化才重启 | 每任务新进程 | 每回合新进程（ADR-030 待决） |
| 认证失效后的处理 | 认证卡，消息放回输入框 | 每段对话可 Reset 认证 | 无 | 卡片附“检查登录”建议 | 归入“需要安装/配置” | 明确命令，未自动重试 | 中文提示 | 文本正则判定 NATIVE_AUTH_REQUIRED |
| Hermes | 有配置示例（Hermes 文档提供） | 只有一句说明，指向 `hermes acp`（Hermes 文档） | 可临时自定义 | 内置 | 无 | 走通用 ACP（推测可用） | 内置（ACP） | 接入中 |
| dsh | 无 | 无 | 可临时自定义 | 无 | 无 | 无 | 内置（私有协议） | 接入中 |

---

## 4. Hermes 与 dsh 的官方 ACP 说明

### 4.1 Hermes Agent

前缀：本机版本 `HL:` = `https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/`；上游 main `HU:` = `https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/`。

**官方给客户端的接入配置**【文档】：

```json
// VS Code（ACP Client 扩展）
{ "acp.agents": { "Hermes Agent": { "command": "hermes", "args": ["acp"] } } }
// Zed
{ "agent_servers": { "hermes-agent": { "type": "custom", "command": "hermes", "args": ["acp"] } } }
```

- 来源：本机文档 [HL:website/docs/user-guide/features/acp.md#L66-L113](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/website/docs/user-guide/features/acp.md#L66-L113)；上游文档 [HU:…/acp.md#L198-L248](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/features/acp.md#L198-L248)；网站 [hermes-agent.nousresearch.com/docs/user-guide/features/acp](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)。
- **启动入口**：`hermes acp`、`hermes-acp`、`python -m acp_adapter` 三者等价；日志写 stderr，stdout 只承载 ACP。
- **JetBrains**：本机文档说指向 `acp_registry/`，本机注册描述为 `{"distribution":{"type":"command","command":"hermes","args":["acp"]}}`（[HL:acp_registry/agent.json](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_registry/agent.json)）。上游已于 2026-07-22 删除 `acp_registry/`（提交 `d84e11af4d`），文档改为直接指向 `hermes acp`。
- **官方 ACP Registry**（42 个目录）没有收录 Hermes，Zed 和 JetBrains 的官方文档也没有 Hermes 条目。

**能力对照：官方文档 vs 本机 0.12.0 源码 vs 上游 main**

| 能力 | 官方文档 | 本机 0.12.0 源码【源码】 | 上游 main【源码 / 文档】 |
|---|---|---|---|
| initialize | — | `loadSession`、`promptCapabilities.image`、`sessionCapabilities{fork,list,resume}`；`agentInfo.version` 为 0.12.0；**未声明** `mcpCapabilities`、`audio`、`embeddedContext`、`close`（[HL:acp_adapter/server.py#L452-L493](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L452-L493)） | 同左（[HU:acp_adapter/server.py#L528-L551](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/acp_adapter/server.py#L528-L551)） |
| 认证 | 0.12 文档写“ACP 没有自己的登录流程，用 `hermes model`”；上游文档写有 terminal 认证 `--setup` | 只有一个 agent 类方法，id 为当前提供方，**且仅在解析到 provider 与 api_key 时才给出**；未配置时 `authMethods` 为空；`authenticate` 只接受该 id（[HL:acp_adapter/auth.py#L8-L19](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/auth.py#L8-L19)、[server.py#L463-L509](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L463-L509)） | 恒带 terminal 方法 `hermes-setup`（args `["--setup"]`）；配置了提供方时另加 agent 类方法（[HU:acp_adapter/auth.py#L8-L51](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/acp_adapter/auth.py#L8-L51)） |
| session/new | — | 返回 `sessionId` 与 `models`，**无** modes、configOptions；**立即写入 `~/.hermes/state.db`**（[HL:acp_adapter/session.py#L210-L229](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/session.py#L210-L229)） | 同时返回 modes；新会话在有提示词之前**只存内存**，探测不再产生空记录（文档 [HU:…/acp.md#L351-L360](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/features/acp.md#L351-L360)） |
| session/load | 0.12 用户指南称 list/load/resume/fork 只在当前进程内有效，**与源码和 internals 文档不符** | 从 `state.db` 恢复；未知 id 返回 `null`；历史回放在**响应之后**才发出（[HL:server.py#L661-L689](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L661-L689)） | 同左，回放增加思考与压缩摘要的 `_meta` |
| session/resume | — | 未知 id **静默新建**会话；响应不带 id；**也会回放历史**（[HL:server.py#L691-L707](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L691-L707)） | 仍静默新建，但响应带 `_meta.hermes.sessionProvenance`，可据此识别 |
| session/list | — | 只列 `source=acp` 且有消息的会话；可按 cwd 过滤；游标分页，每页 50；含 title、updatedAt（[HL:session.py#L283-L355](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/session.py#L283-L355)） | 同左 |
| fork / cancel / close | — | fork 支持，源会话不存在时返回空 id；cancel 支持；不支持 close | 同左 |
| modes | — | 不公布；`set_session_mode` 只记录不生效 | `default` / `accept_edits` / `dont_ask`，对应编辑审批策略（[HU:server.py#L236-L252](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/acp_adapter/server.py#L236-L252)） |
| models | 上游文档：id 为 `provider:model` 或 `custom:<name>:<model>`；选择只影响该会话 | 当前提供方的精选目录；`set_session_model` 在**提供方相同**时会二次探测并可能误路由（#59089）；不校验，失败要到下一次 prompt 才显现（[HL:server.py#L303-L320](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L303-L320)、[#L1365-L1397](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L1365-L1397)） | 列出所有已认证提供方的模型；回合进行中切换返回 `-32603 Session is busy`；无效模型返回 `-32602`（[HU:server.py#L1022-L1058](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/acp_adapter/server.py#L1022-L1058)） |
| config options | — | 不公布；`set_config_option` 只保存不生效 | 只认 `edit_approval_policy`，其余只保存 |
| available commands | — | help、model、tools、context、reset、compact、steer、queue、version，由 Hermes 本地处理；`/model` 只回固定文本，不发配置更新 | 新增“回合中禁止 reset/compress/model” |
| plan | — | 无；todo 只作为工具文本出现 | 同左 |
| 输入 | 0.12 internals 文档称“非文本块不参与请求文本提取”；源码另有图片转换路径 | 图片转为 OpenAI `image_url`；音频、`resource_link`、嵌入资源都不交给模型 | 新增 `content.py` |
| MCP | 上游文档：`session/new` 传入的 MCP 一律追加 | 启动时**同步**发现 `config.yaml` 中的 MCP，之后才进入 ACP 循环（[HL:acp_adapter/entry.py#L115-L124](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/entry.py#L115-L124)）；会话级 stdio/http/sse 都会注册 | 新增环境变量 `HERMES_ACP_SKIP_CONFIGURED_MCP=1`，由宿主设置，跳过全局 MCP 启动（文档 [#L317-L337](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/features/acp.md#L317-L337)） |
| 权限请求 | 危险命令走审批：允许一次 / 始终允许 / 拒绝；超时或出错即拒绝 | 只覆盖危险终端命令；**超时硬编码 60s**；toolCall 是合成的 `perm-check`，不对应实际工具卡；**回复未知 optionId 会被当作“允许一次”**（[HL:acp_adapter/permissions.py#L26-L80](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/permissions.py#L26-L80)） | 增加 `allow_session`、`deny_always` 和**编辑审批**；超时取 `approvals.timeout`，默认 300s（[HU:acp_adapter/permissions.py#L18-L50](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/acp_adapter/permissions.py#L18-L50)、文档 [#L366-L396](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/features/acp.md#L366-L396)） |
| elicitation | — | 无；hermes-acp 工具集不含 clarify | 无 |
| 非交互检查 | 上游文档：`hermes acp --version`、`hermes acp --check` | `acp` 子命令只有 `--accept-hooks`（[HL:hermes_cli/main.py#L10453-L10471](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/hermes_cli/main.py#L10453-L10471)） | 有 `--check`、`--version`、`--setup` |

**本机 0.12.0 中与第一链路相关的行为**【源码】

- prompt 指向未知会话时返回 `stopReason: "refusal"`（[HL:server.py#L800-L802](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L800-L802)）。
- agent 抛出异常时，最终回复是文本 `Error: <异常>`，结果仍是 `end_turn`（[#L972](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L972)）。同时 stderr 会有 `[ERROR] … Agent error in session …`。
- 同一会话运行中又收到 prompt 时，回复 “Queued for the next turn” 并立即返回 `end_turn`；排队的 prompt 会在**前一个 prompt 的响应之前**、在同一调用里执行完（[#L862-L874](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L862-L874)、[#L1028-L1050](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py#L1028-L1050)）。
- 用量：`PromptResponse.usage` 含 input、output、total、thought、cache_read；另发 `usage_update{size,used}`。
- 其他 JSON-RPC 方法：`ping`、`health`、`healthcheck` 返回 `-32601`，Hermes 把它们视为正常的存活探测。

**环境变量与配置**

- 【源码 / 文档】
  - `HERMES_HOME`：默认 `~/.hermes`。
  - `~/.hermes/.env`：ACP 入口启动时加载，并以 override=True **覆盖**继承来的环境变量。
  - `~/.hermes/config.yaml`：提供方、MCP、审批配置（`approvals.mode`、`approvals.timeout`；0.12 的 ACP 审批不读 timeout）。
  - `-p/--profile` 是全局参数，必须放在 `acp` 之前。
  - `HERMES_YOLO_MODE`：为真时跳过危险命令审批（[HL:tools/approval.py#L820](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/tools/approval.py#L820)）。**Hub 不应设置它。**
  - `HERMES_INTERACTIVE`：ACP 在回合内部自行设置，宿主不用管。
  - 上游新增 `HERMES_ACP_SKIP_CONFIGURED_MCP`。
- 【源码】本机环境观察：在当前 shell 里，`hermes` 解析到 cmux 的 shim（`~/.cmuxterm/cmux-cli-shims/…/hermes`），真正的启动器是 `~/.local/bin/hermes`，它执行 `~/.hermes/hermes-agent/venv/bin/hermes`。cmux 包装脚本对 `acp` 子命令是透传：去掉 shim 目录和 `CMUX_*` 变量后，exec 真实的 hermes。【分析】发现阶段应记录解析出的真实目标，Hub 的 plan 中已记为 `~/.local/bin/hermes`。

**对 Hub 接入的建议**【分析，对照工作区未提交的 `src/adapters/control/hermes.ts`】

已覆盖：

- 用 `session/load` 恢复，`null` 视为会话已丢失；
- 回放窗口从响应开始计算；
- 文件以只读副本路径传给 Hermes；
- 审批 60s 截止；
- `/model` 回复文本的解析。

建议补充：

1. **set_model 去重**：所选模型与会话当前模型等价时，不发 `session/set_model`，规避 #59089 的误路由。切换后用下一次 load 返回的 `currentModelId` 核对。Hermes 在本机用的是 DeepSeek 提供方，正处在这个风险里。
2. **失败提升**：stderr 中出现 `[ERROR]` / ❌ 加终态标记、`Agent error in session`，或回复中出现 Hermes 自己注入的 `API call failed after N retries` 时，把 `end_turn` 改判为失败。规则要限定来源，避免把模型回复里的同样字样误判为失败。
3. **审批应答**：只回复请求里给出的 optionId。审批卡不关联到 `perm-check` 这个合成 id，而是独立显示命令文本。
4. **不用 `session/new` 做探测**：0.12 会写入空会话记录；如需模型目录，优先从现有会话的 load 结果读取。
5. **初始化即可判断提供方**：`initialize` 返回的 `authMethods` 为空，说明 Hermes 没有可用的提供方凭据，不建会话也能得出“需配置”（`hermes model`）。
6. **按版本门控 Hermes 特化**：若用户升级到 0.19 以上，上表上游一列的差异都会生效，包括审批超时 300s、modes、`hermes-setup`、编辑审批、busy 错误。60s 截止、`/model` 文本解析这些特化需要按版本判断。

### 4.2 DeepSeek Harness（dsh）

前缀 `D:` = `https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/`

**官方定位**【文档】

- ACP 包 `@deepseek-ai/dsh-acp` 是 “Automation-only ACP server for programmatic clients”。文档原文：“Avoid it when a human needs DSH-specific presentation cards, plans, titles, todos, terminal views, or elicitation”（[D:packages/acp/acp/README.md#L1-L32](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/README.md#L1-L32)）。
- 启动方式：`dsh --profile acp`（[D:apps/cli/README.md#L13](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/README.md#L13)）。acp profile 首次使用时由模板自动初始化（[#L20](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/README.md#L20)）。
- 配套的官方客户端是仓库内的 `dsh-subagent-acp`。
- **没有任何编辑器配置示例**（仓库文档中搜不到 Zed、JetBrains、`agent_servers`），**也未进入 ACP Registry**。

**协议面**【文档 [D:packages/acp/acp/README.md#L58-L76](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/README.md#L58-L76)，与源码 [D:packages/acp/acp/src/index.ts#L155-L300](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/index.ts#L155-L300) 一致】

| 能力 | 0.2.1-alpha.1 |
|---|---|
| initialize | `mcpCapabilities.http`；`promptCapabilities.image` 仅在附件存储可用且路由支持图片时为真；`audio` 和 `embeddedContext` 为 false；`sessionCapabilities{close,list,resume}`；**`authMethods: []`**；**`agentInfo` 固定为 `deepseek-harness-acp 0.0.1`** |
| authenticate | 立即成功，不需要认证 |
| session/new | `cwd` **必须是绝对路径**；返回完整 configOptions；会立即持久化一个空会话（[#L196-L235](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/index.ts#L196-L235)） |
| session/resume | 不回放历史。以下情况返回 `-32602`：会话已在本进程激活、子 Agent 会话或非根会话、cwd 不一致（[#L238-L253](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/index.ts#L238-L253)） |
| session/list | 从新到旧列出持久化的根会话；可按绝对路径 cwd 过滤；每页默认 100 |
| session/close | 支持，静默收尾 |
| 不支持 | `session/load`、删除、fork、额外目录、SSE MCP、modes、commands、plans、terminals、客户端文件系统、elicitation |
| config options | `model` 和 `reasoning_effort`（category 为 `thought_level`，仅当模型声明了推理档位时出现）。**选项值是不透明的 JSON 字符串 `["provider","model"]`**；`reasoning_effort` 的空串表示提供方默认（[D:packages/acp/acp/src/model-control.ts#L187-L237](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/model-control.ts#L187-L237)） |
| 输出 | **只发已提交的 assistant 消息与思考块，没有逐字增量**；工具 `kind` 恒为 `other`；`usage_update` 只含 `{used,size}`；prompt 结果不带用量（[D:packages/acp/acp/src/updates.ts#L16-L61](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/updates.ts#L16-L61)） |
| 输入 | 文本、`resource_link`（以 `[resource_link name=… uri=…]` 交给模型）、受支持的图片 |
| 权限 | 选项为 `allow-once` / `reject-once`；请求的 toolCall **只有 `toolCallId`**，需关联到之前的 `tool_call` 卡片（[#L155-L174](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/index.ts#L155-L174)） |
| 失败 | 回合失败返回 **JSON-RPC `-32603`，消息为 “turn failed: …”**；blocked/aborted 映射为 `end_turn`；同一会话重复 prompt 返回 `-32602`（[D:packages/acp/acp/src/session.ts#L483-L523](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/session.ts#L483-L523)、[codec.ts#L14-L35](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/codec.ts#L14-L35)） |

**alpha.1 的已知缺陷（alpha.2 已修复）**【源码 / 提交说明】

- 取消时，prompt 槽位可能被一直占住（[cbf6188](https://github.com/deepseek-ai/deepseek-harness/commit/cbf618845a6fd6de4bbd77d72b5204f3ca170521)）。
- 某些失败被报成 `end_turn` 或 `cancelled`（[57226b3](https://github.com/deepseek-ai/deepseek-harness/commit/57226b392b198530d4ede419b15a33e98227cac0)）。对应 alpha.1 中 [session.ts#L508-L509](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/acp/acp/src/session.ts#L508-L509)：没有 turn/end 时直接 resolve 为 `cancelled`。
- 【分析】在 alpha.1 上，Hub 不能把 `cancelled` 当作“用户取消已确认”的证据。

**配置与环境变量**【文档 / 源码】

- **默认模型**：acp profile 默认 `deepseek-official` / `deepseek-v4-flash`（[D:packages/bundle/acp-app/cordis.patch.yml#L16-L21](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/acp-app/cordis.patch.yml#L16-L21)）。提供方和模型按 profile 写在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
  - 【分析】在 Web profile 里改的模型不会自动作用于 acp profile，除非写进家目录级的 `$DSH_HOME/cordis.patch.yml`。界面上应说明 dsh 用的是 acp profile 的设置。
- **生命周期**：配置只在启动时读取；stdin EOF 即有界退出；模型生成的标题被关闭（[D:packages/bundle/acp-app/README.md#L27-L29](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/acp-app/README.md#L27-L29)）。
- **凭据来源顺序**：继承的环境变量 → `$DSH_HOME/.credentials.yaml` → **启动目录的 `.env`** → `$DSH_HOME/.env`（[D:apps/cli/reference/README.md#L129](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/reference/README.md#L129)）。
  - 【分析】如果 Hub 以工作区为 cwd 启动 dsh，工作区里的 `.env` 会进入 dsh 的启动环境。
- **权限预设**：`DSH_PERMISSION_MODE`，取值 read-only / workspace-write（默认）/ danger-full-access；danger-full-access 时审批为 never（[D:packages/bundle/base/cordis.patch.yml#L226-L262](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/base/cordis.patch.yml#L226-L262)、[reference#L123](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/cli/reference/README.md#L123)）。
- **其他文档中的变量**：`DSH_HOME`（默认 `~/.dsh`）、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DSH_TELEMETRY_MODE=DISABLED`、`DSH_TELEMETRY_DISABLED`。
- **数据上传**：base bundle **默认开启**向 DeepSeek 上传会话日志，可在设置里关闭（reference#L129）。Hub 沿用原配置，不应改动，但可以在 Harness 详情里如实提示。

**对 Hub 接入的建议**【分析，对照工作区的 plan 条目】

1. **流式**：界面要如实说明“dsh 的 ACP 入口按整条消息返回，不逐字流式”。首字等待要靠阶段提示来填补（见差距 6）。
2. **就绪判断**：ACP 层判断不了，因为 `authMethods` 恒空、`authenticate` 恒成功。只能看 `dsh --version` 加试跑，或提示用户检查凭据来源（Hub 不读凭据）。版本用 `dsh --version` 取，`agentInfo` 固定为 0.0.1，不可用。
3. **恢复的 cwd**：恢复时 cwd 必须与原会话完全一致。将来若常驻进程，同一会话不能在同一进程里重复 resume。
4. **模型选项值**：按不透明字符串原样回传，不要拆解。
5. **版本建议**：建议用户使用 alpha.2 及以上，或在 Hub 中把 alpha.1 标为“已知取消/失败结算缺陷”。

---

## 5. 差距清单（按对第一链路体验的影响排序）

“现状”一栏依据 HarnessGateway-cc 的 README、能力矩阵、ADR 和源码。

| # | 差距 | 别人怎么做（参考） | Hub 现状与证据 | 建议【分析】 |
|---|---|---|---|---|
| 1 | **每回合冷启动**：进程不跨回合保持，也不预热。首字延迟高，长对话的 load 回放越来越慢，后台任务被中断。 | **Zed**：每 agent×工作区一个常驻进程，多会话共用；打开草稿就 initialize + `session/new`；只回收“空闲且可 load”的线程。**AionUi**：打开会话即预热，页面可见 30s 续租、租期 90s，空闲 10 分钟回收。**Happy**：同一进程连续处理回合，只有启动期参数（模型、思考、系统提示、工具、plan）变化才带 resume 重启。**Toad**：每会话常驻。 | 每个 Run 结束即关闭进程（[ADR-030](../../docs/decisions/0030-retained-native-processes.md)，待决，范围只限后台任务）。旧实现“启动 + 建会话”实测：Claude≈2.9s、Codex≈4.3s、Cursor≈7.8s、OpenClaw≈1.3s、Pi≈0.7s（[验收 L7](../../docs/verification/native-session-experience-2026-10-11.md)）。Hermes 0.12 每次启动都同步发现 MCP；dsh 冷启动可能超过 5s（Multica 注释）。 | 把 ADR-030 的动机扩展到首字延迟。采用 Happy 的“启动参数哈希”复用规则，加上 AionUi 的可见续租与空闲回收；可以先从“选中 Harness 或打开对话时预热 initialize + load”做起。复用与工作区唯一写入者之间的冲突按 ADR-030 的方案 C 处理。 |
| 2 | **就绪状态没有前置**：首次发送前看不到安装、版本、登录、默认模型和不可用原因。 | **AionUi**：补全 PATH → `--version`（区分没找到、运行失败、超时）→ ACP 真实握手，六档状态，“需登录”单独显示。**Multica**：五类判定、两轮确认，离线原因附修复命令，模型目录失败时显示原因。**JetBrains**：自动检测已装 agent 并提示加入。 | discover 不执行程序（probe=not_run，[harness-discovery.md#L27](../../docs/research/harness-discovery.md)）；README 写明“原生连接、认证与额度在发送时分别核实”（[README#L24](../../README.md)）；只有模型目录接口能给出 `authentication=missing`（[server.ts#L391](../../src/web/server.ts)）。 | 在 Harness 选择器和 Harnesses 页增加“就绪”列：未安装 / 版本 / 需配置或登录 / 不可用（附原因与本机修复命令）/ 未检测。ACP 类用一次 initialize 判断，例如 Hermes 0.12 的 `authMethods` 为空即表示未配置提供方。结果缓存，且只读。 |
| 3 | **认证失效没有原生流程**：不识别 ACP `-32000`，不调用 `authenticate`，没有 terminal 认证命令，消息不回填。 | **Zed**：建会话时的认证卡（按 `authMethods` 渲染）；回合中 “Authentication Required” 并把消息放回输入框；terminal 方法用同一启动命令追加 args 在终端执行，成功后重新 `session/new`。**JetBrains**：每段对话开头可 Reset 认证。**Happy**：只认明确错误类型，给出本机命令并说明未重试。 | `classifyRemoteFailure` 只按文本正则判断（[json-rpc-process.ts#L11-L17](../../src/infrastructure/control/json-rpc-process.ts)）；`acp.ts` 只记录 authMethods 的 id（[#L154-L175](../../src/adapters/control/acp.ts)）。 | 把 `-32000` 映射为 NATIVE_AUTH_REQUIRED，并保留 agent 给出的 message。卡片展示 authMethods：agent 类可一键 `authenticate`，terminal 类给出可复制命令（如 Hermes 上游的 `hermes acp --setup`、0.12 的 `hermes model`）。失败的消息回填草稿，并写明“未自动重试”。 |
| 4 | **失败分类窄，“假成功”识别不全**。 | **Multica**：有序分类器，覆盖 context_overflow、auth、quota(402)、429/529、model not found 等，附中文文案；stderr 只认终态标记；结构化的终止原因优先。**AionUi**：归属、错误码、是否可重试、建议、跳转五要素的错误卡。**Happy**：90% 额度预警。 | 只有 4 类：客户端不支持、未登录、额度、连接（[json-rpc-process.ts#L11-L17](../../src/infrastructure/control/json-rpc-process.ts)）。Hermes 的 `Error: …` + `end_turn`、`API call failed after N retries`、stderr `[ERROR]` 都没有统一的提升规则。 | 补充 429/限流、402/余额、上下文超限、模型不可用、历史中毒（400 “assistant must not be empty”）。为 Hermes 增加 stderr 终态嗅探。错误卡加上“归属 + 建议动作”，例如重新登录、换模型、新建对话。不引入自动重试。 |
| 5 | **版本漂移没有产品化**：没有“已验证版本”提示。 | **AionUi**：与已验证版本比较，不一致仍可用但提示。**Multica**：最低版本表，低于即下线并说明原因。 | 矩阵记录了原安装版本，但界面不提示。本机 Hermes 0.12.0 与上游 0.21.6 在审批、模式、认证、set_model 上差异很大；dsh alpha.1 有结算缺陷。 | 每个 Harness 记录“已验证版本区间”，超出时在选择器里提示“未经验证的版本，部分能力可能不同”。特化逻辑（例如 Hermes 60s 审批截止）按版本门控。 |
| 6 | **生成过程的阶段不可见**，首个事件不够及时。 | **Multica**：首个可见事件立即推送，记录 runtime_started / first_output_received 等阶段。**Zed**：Loading、Installing、认证中等状态。**AionUi**：区分原生和合成的 PromptAccepted 信号。 | 只有“正在准备回复 / 正在回复”（[ChatMessage.tsx#L26-L32](../../web/src/components/ChatMessage.tsx)）。dsh 只发整条消息；Hermes 冷启动约 2s（Multica 注释中已配置时的个例），且每次启动先同步发现 MCP。 | 在 Run 上记录并显示阶段：启动原程序 → 恢复原生会话 → 已受理 → 首字。对非流式入口标注“按整段返回”。按 Harness 统计首字耗时，作为第 1 条的验收指标。 |
| 7 | **配置选择不按 Harness 记住**。 | **Zed**：选中的值写回 `default_config_options`，新会话沿用；按 category 绑定快捷键，选项多时可搜索。**AionUi**：mode、model 专用选择器，其余进参数面板。 | 选择按对话保存；源码中未见按 Harness 记住上次选择（`web/src` 无相关存储）。 | 新对话默认沿用该 Harness 上次的模型、思考、模式选择。只记在 Hub 自己的偏好里，不写原配置。 |
| 8 | **“等待你处理”没有跨对话提醒**。 | **Toad**：会话总览显示 asking 状态。**Zed**：发 “Waiting for input” 桌面通知。 | 侧栏只显示运行点和 blocked 图标（[Sidebar.tsx#L46](../../web/src/components/Sidebar.tsx)）。Hermes 0.12 审批 60s 不答即拒绝。 | 审批或提问挂起时，在侧栏标记“待你处理”并显示剩余时间，可选浏览器通知。 |
| 9 | **原生身份与“在原程序中继续”不可见**。 | **Happy**：每个会话一条可复制的原生恢复命令。**Zed**：只能 resume 时明确提示“该 agent 不支持查看之前的消息”。 | 界面不显示原生会话 ID 或恢复命令。dsh 没有 load，接续后看不到旧历史。 | 在对话详情显示“原生会话 ID + 在原程序中继续”的命令，例如 `codex resume <id>`、`claude --resume <id>`，具体以各原程序 CLI 为准，需逐个核实。接续不带历史时给出明确提示。 |
| 10 | **缺少面向用户的诊断入口**。 | **Zed**：`dev: open acp logs`，可 Restart Connection、Copy All Messages。**JetBrains**：Get ACP Logs，并提示日志含对话内容。 | 证据与日志主要供验收使用，界面上没有“复制诊断”。 | 每个 Run 提供“复制诊断信息”：协议版本、原程序版本、阶段耗时、脱敏后的末段 stderr。注明是否含对话内容。 |

**对照中 Hub 已经做得不错的地方**（不列为差距）：

- 审批卡直接显示原生选项名（[ChatPage.tsx#L74](../../web/src/components/ChatPage.tsx)）。
- `elicitation.form` 已声明并承接提问。
- 本机会话的接续（ADR-029）。
- “先提交再发布”加 SSE。
- 恢复失败明确拒绝、不静默新建。这一点比 AionUi 和 Vibe Kanban 更符合用户预期。

---

## 6. 未验证项与后续验证建议

1. 本报告**没有运行**任何 Harness。Hermes 和 dsh 的所有结论都来自源码与文档阅读。以下行为需要真实回合确认：
   - Hermes 0.12 的 set_model 误路由在本机 DeepSeek 配置下能否复现；
   - stderr 的实际格式；
   - dsh 的冷启动耗时与 alpha.1 的取消缺陷。
2. JetBrains 是闭源产品，只有文档依据；其进程复用方式未知。
3. Zed、AionUi、Happy 的结论来自固定 commit 的源码，没有运行这些产品。
4. 首字延迟的数据只有 Hub 旧实现的“启动 + 建会话”耗时，以及 Multica 注释里的个例（Hermes 约 2s，dsh 冷 VM 超过 5s），**不是**现行 Hub 的首字实测。建议先补一项按 Harness 统计“发送 → 首个可见事件”的真实测量，再决定第 1 条的实施顺序。
5. Hub 侧的 Hermes/dsh 接入是工作区中尚未提交的改动，4.1、4.2 的对照可能已经过时。
