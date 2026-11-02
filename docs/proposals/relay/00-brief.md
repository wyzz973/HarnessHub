# 接力系统重新设计 · 讨论简报（第 0 轮）

日期：2026-11-02。分支 `cc/relay-design`（基点 `07a0825`，`codex/local-discovery`）。主负责人：Claude Opus 5.5（集成、写契约与计划、提交）；总架构师与审批代理：Fable 5.1。本目录是设计过程的全部记录：每一轮的调研、方案、评审与修订都留在这里，最终结论进入 ADR-055（proposed）与契约。

## 0. 用户的要求（原话）

> 今晚先把接力做实，我也发现了这个问题，你需要重新设计一下接力系统，以及上下文的调度设计，参考市面上相关的 harness 的优秀实践思路，最新的论文，superagent 架构等等，想想如何适配我们的 harnesshub，设计出一个我们自己的接力系统。你必须反复迭代，设计，升级，搭建小组讨论。直到最后设计出一个完美架构，性能的接力系统。明早我验收。

用户明早验收的是**设计**（架构、契约、性能目标、实施切片与测试计划），不是实现。任何“已实现 / 已验证”的说法都必须有证据；设计建议与已接受决定分开写。

## 1. 产品核心：接力为什么是关键

用户最初的产品定义（2026-10-11）：“打造一个 harnesshub，为用户统一管理和调度他们的 harness，体验上是真的使用不同的 harness 一样。”拆成三个承诺：

1. **像原生**：在 Hub 里用某个 Harness，和直接用它的原程序一样。
2. **能接力**：同一个对话中途换一个 Harness 接手，前面的工作、决定、改动与待办都不丢；换回来时也知道别人做了什么。
3. **统一管家**：一处安装、管理、调度所有 Harness。

用户已确认的需求（`docs/product/requirements.md`）：R02 公共 Session 独立于 Harness；R08 上下文接续——有来源、预算和水位的公共上下文供新执行者接续；R09 独立切换——同一 Session 可切 Harness、Provider/模型，运行中请求有明确边界；R10 模型资源独立；R05 自动分配（用户暂缓，但接力设计要能支撑以后的“建议交接”，例如额度将尽时建议换人）。旧 HarnessHub 的“八步蓝图”（用户确认的方向，`/Users/sd3/Desktop/project/HarnessHub/docs/proposals/chat-first/README.md`，只读参考）对第 3 步“上下文准备”与第 8 步“切换与接续”给出的验收重点：跨 Agent 的待办与文件变化不丢失；旧摘要不覆盖新事实；超限不静默截断；上下文准备失败时不发起带副作用的执行；A→B→A、同 Agent 换模型、同时切换、执行中请求、交接失败、资源未清理、重启，以及其他执行者已改动文件的场景。

当前阶段的边界：生产页面只使用各 Harness 本机已配置的模型与登录（Provider 统一管理暂缓，`providerManagement:false`）；只做 macOS；焦点 Harness 七个：Claude Code、Codex、OpenCode、DeepSeek Harness（dsh）、Hermes Agent、OpenClaw、WorkBuddy（尚未接入）；Cursor、Gemini CLI、Pi 冻结。

## 2. 现状（as-is，主负责人阅读代码所得，第一轮内部基线会逐条复核）

- **唯一业务权威是公共 Session**（SQLite，业务库 v12）。每个 Harness 在对话里有一个私有原生绑定 `nativeBindings[] = {harnessId, controlId, checkpoint, throughRunId, status}`；`throughRunId` 是“这个原生会话已经同步到哪一轮公共历史”的水位。
- **交接材料 = 全部公共历史的 JSON**：`src/contexts/session/domain/context.ts` 的 `buildPublicContext` 把此前每个已结束 Run 的用户消息正文、附件名、回复正文与结果状态，加上分支来源的历史，序列化成 JSON，前面加一句英文说明（“只继续 currentInput，不要重新执行之前的输入”），**作为用户消息正文**发给目标 Harness。工具结果、改了哪些文件、差异、计划、待办、审批、用量都不带。
- **超限即失败**：超过 `MAX_CONTEXT_BYTES = 1 MiB` 报 `CONTEXT_TOO_LARGE`，不截断、不摘要；长对话因此无法换人。
- **换回原 Harness 的增量**：`runtime.ts:1334–1340` 在目标已有 ready 绑定时只补 `throughRunId` 之后的 Run（仍是同样的 JSON 包装）；没有新增 Run 时原样发送用户输入（`runtime.ts:1392`）。
- **疑似缺陷（待内部基线核实）**：切换回来后第一条输入若是原程序目录里的斜杠命令（如 `/compact`），`runtime.ts:1393–1396` 改为原样发送、不注入增量；而回合结算时 `runtime.ts:1496` 只要已派发就把 `throughRunId` 推进到本轮。于是另一 Harness 在中间完成的工作**永远不会补给**这个原生会话，违反 INV-14（“返回 A 时不能复用未同步 B 已完成变更的旧原生上下文”）。
- **已经持久化、但交接没用上的公共事实**：每个 `PublicRun`（`src/contracts/session.ts:92`）已有 `tools`（标题、状态、kind、exitCode、`detail: ContentRef`——输入/输出/差异在内容存储里）、`plan`、`usage`、`notices`、`activities`（子 Agent、后台任务、压缩、重试、评审）、`outputs`（产物）、`attachments`、`thinking`、`timing`。详情栏“改动”页已经展示这些差异。
- **容量上限**：`MAX_RUNS = 256`、`MAX_SESSION_BYTES = 8 MiB`、`MAX_SESSION_EVENTS = 16384`、单次输入 64 KiB、输出 1 MiB（`src/contexts/session/domain/state.ts`）。
- **已有但只是 proposed 的设计**：`docs/contracts/context-transfer.md`（ContextManifest：目标与约束、已完成/待办、用户批准的决定、工作区快照/修改摘要、产物 hash、来源指纹、策略版本、预算估计；接续等级 native_resume / public_context_rehydrate / blocked）、`docs/contracts/switching.md`（切换状态机与竞态清单）、`docs/domain/invariants.md`（INV-13 ContextManifest 可追溯、INV-14、INV-21 交接失败保留真实结果、INV-22 派生摘要可重建）。它们从未实现。
- **原生通道线索**：ACP 会话以 `mcpServers: []` 建立（`src/adapters/control/acp.ts:390`），Claude 另带 `_meta`（`src/adapters/control/claude.ts:20`）——按会话注入 MCP 或说明文字可能可行，待第一轮“原生通道”核实。能力矩阵见 `docs/verification/native-capability-matrix.md`（文件/文档输入、上下文压缩、会话恢复等格）。
- **真实证据**：README 记录的接力验收只有一组 Codex→Gemini→Codex，模型是本地确定性服务；能力矩阵 27 项里没有“接力”这一项。

## 3. 本次设计必须回答的问题

| 编号 | 问题 |
|---|---|
| Q1 交接内容 | 一次交接交什么：目标、约束、决定、进展、文件改动与差异、计划/待办、未决问题与审批、失败与教训、产物、环境事实？哪些可确定性地由公共事实生成，哪些需要模型写？如何标注来源与水位？ |
| Q2 上下文调度 | 何时构建（切换时、后台持续维护、用户打开选择器时预取）？如何增量维护（工作账本）？按目标 Harness 与模型的窗口如何分配预算与分层（常驻 / 近期 / 按需取用）？与原生压缩如何配合？ |
| Q3 注入通道 | 每个焦点 Harness 用什么通道交付：用户消息、系统/开发者说明、嵌入资源、按会话注入的 MCP、Hub 自有目录中的文件？如何不改用户全局配置、不污染原生转录、对提示缓存友好？ |
| Q4 返回与增量 | A→B→A 的水位语义（已送达 vs 已派发）；多个 Harness 各自的水位；分支、接续本机会话、显式重建这些来源如何纳入？ |
| Q5 质量与确认 | 怎样知道接手方“接住了”（接棒确认/复述）？接续等级如何扩展并对用户可见？如何评测接力质量（基准任务、指标）？ |
| Q6 失败与边界 | 执行中切换、unknown 结果、取消/失败的回合、未提交的工作区改动、外部改动、超限、摘要失败、摘要用哪个模型（当前没有 Hub 自有模型，不能静默使用用户没选的模型）？ |
| Q7 安全与隐私 | 内容跨厂商流动（Claude 会话的内容交给 DeepSeek）、工具输出中的秘密、文件与工具输出中的提示注入、用户知情与控制。 |
| Q8 性能 | 切换到派发的时延、交接构建 p50/p95、注入 token 数、费用、提示缓存命中、存储增长、内存与并发；可测量的目标与基准方法。 |
| Q9 体验 | 交接单是否可见/可编辑、接续等级展示、接手方被告知了什么、交接方式（完整/精简/只有目标）的选择、“交接区”式的交互时刻；接手方要像原生续写。 |
| Q10 演进 | 建议交接与自动路由、同 Harness 换模型、API/SDK 使用方（用户 B）、以后并行多 Harness、WorkBuddy 接入。 |
| Q11 存储与契约 | 新实体（交接单、工作账本……）、v13 迁移与降级、事件、不变量、幂等、测试计划与真实验收配方。 |

## 4. 硬约束（摘自 AGENTS.md、不变量与既有 ADR）

- 公共 Session 是唯一业务权威；派生材料（摘要、账本、交接单）必须可追溯来源 ID、水位、内容指纹与策略版本，可由原始事实重建，不能覆写原始消息（INV-13、INV-22）。
- 不隐式改换 Harness、Provider、模型或配置；未知如实报告；不把模型自评当质量证明。不能静默用用户没选的模型做摘要。
- 事实先持久提交再发布；未知执行不自动重跑；切换不转移正在运行的工具；交接失败保留真实结果，不假称迁移成功（INV-11、INV-21）。
- 领域层不依赖 SDK、HTTP、数据库或子进程库；第三方协议类型留在 Driver（防腐层）；Runtime 不按产品名分支。
- 不改用户真实 Harness 全局配置、不建空 HOME；凭据不进入公共事实、事件、argv 或错误（INV-17）。
- 所有异步资源有所有者、上限与可等待的关闭入口；队列与流有上限（INV-20、INV-26）。
- 超限不静默截断；需要摘要时另建派生记录并标注未包含的内容与水位（`context-transfer.md`）。
- 业务库升版本前自动备份（ADR-049），升版本要有迁移、降级说明与测试。

## 5. 讨论成员守则

- **不提问、不等回复**：遇到不确定，自己判断并在文中写明假设与理由。任何人都不会回你的消息。
- **只写分配给你的文件**；不改仓库其他文件；不做 git 操作。
- **不运行任何 Harness 的会话或提示**，不启动 `claude`、`codex`、`opencode`、`dsh`、`hermes`、`openclaw` 的会话；只允许只读查看已安装的包与文档（`--version`、`--help` 可以）。不改 `~/.claude`、`~/.codex`、`~/.config/opencode`、`~/.dsh`、`~/.hermes`、`~/.openclaw` 等任何用户配置。
- **不碰正在运行的 4317 服务和任何 `data/` 目录**；不读取用户对话内容（只允许统计）。
- **网络调研**：优先一手来源（厂商文档、作者原文、论文、仓库源码）。每条来源记 URL、标题、作者/机构、发布日期或版本/commit、阅读日期，并注明是打开原文核实的还是只看到搜索摘要。今天是 2026-11-02，你的训练知识可能过时，涉及“最新”的内容必须搜索核实。
- **写中文**，技术名词与标识符保留原文；事实、推断与建议分开标注。

## 6. 术语（本轮暂定，设计可修改）

- **接力（Relay）**：整个系统——在同一公共对话中，让不同执行者（Harness，或同 Harness 换模型）连续推进同一份工作。
- **交接（Handoff）**：一次从来源执行者到目标执行者的转移。
- **交接单（Relay Packet / Handoff Manifest）**：一次交接实际交给目标的、不可变、可追溯的材料。
- **工作账本（Work Ledger）**：由公共事实持续维护的结构化工作状态（目标、决定、改动、待办……），交接单从它投影出来。
- **上下文调度（Context Scheduling）**：决定在什么时候、以什么预算、经什么通道、把哪些上下文交给哪个执行者。
- **接续等级**：现有 native_resume / public_context_rehydrate / blocked，设计可扩展。
