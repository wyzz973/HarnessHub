# 05 执行平面

状态：提案（草案），2026-10-02。术语、模块名、端口与数据归属以 [02 系统架构](02-architecture.md) 为准，产品范围与版本划分以 [01 产品定义](01-product.md) 为准；采纳后拆分进 [DESIGN.md](../../../DESIGN.md) 与正式 ADR。接口形态见 [06 接口与交互面](06-interfaces.md)，`model.call` 的字段与网关行为见 [03 模型平面](03-model-plane.md)。

执行平面由 `packages/runtime`（Session/Run、Worker 监督、工作区、评测）和运行在 Worker 内的 `packages/drivers` 组成，HTTP 入口在 `packages/daemon`。与同类执行层产品（OpenHands Agent Canvas、sandbox-agent，见 [01 产品定义](01-product.md#8-同类产品格局)）相比，本文把差异放在四处：执行结束、模型调用证据与产物校验分开结算（第 4 节）；Run 级账本与“未绕过网关”的证据等级（第 2、4、6 节）；同一模型下多个 Agent 的日常比较（第 7 节）；跨 Agent 统一的权限策略（第 5 节）。

## 1. 沿用的运行契约

下表中的契约原样沿用，本文不复述，只记录开源版的变化：

| 契约 | 权威位置 | 开源版的变化 |
|---|---|---|
| Session 固定绑定、同 Session 串行 Run、Worker 懒启动、空闲回收前提、恢复失败不建空会话 | [DESIGN.md §4](../../../DESIGN.md#4-sessionworker-与引擎切换)、[会话恢复](../../session-recovery.md) | 绑定对象扩展为第 2 节的字段 |
| 状态机、executionGeneration、总 deadline、取消幂等与逐级终止、完成/取消/deadline 串行仲裁、终态与唯一终止事件同事务、cleanupStatus | [DESIGN.md §5](../../../DESIGN.md#5-run-生命周期与控制契约) | 状态枚举不变；判定位置从 Worker 移到守护进程 |
| 权限记录、先持久化后发送、重复决定幂等、冲突与过期明确拒绝 | 同上 | 增加策略自动决定与审计字段（第 5 节） |
| 事件信封、先提交后发布、SSE 从已提交日志重放、JSONL 可重建 | [DESIGN.md §6](../../../DESIGN.md#6-业务存储与事件) | 信封升为 schemaVersion 2 |
| outputs 采集的路径规则、16/64 MiB 限额、链接与越界拒绝 | [文件产物](../../file-artifacts.md) | 增加工作区 diff 采集（第 3 节） |
| 重启后 interrupted、按 lease 核实进程归属、不自动重放副作用 | [运行 API](../../runtime-api.md) | 增加工作区孤儿核对（第 10 节） |
| 隔离分维度如实声明 none/partial/full，未实现即 unsupported | [DESIGN.md §8](../../../DESIGN.md#8-windows-能力与验证边界) | 从 Windows 扩展到三平台（第 6 节） |

开源版的变化：

1. **判定位置**：现状由 Worker 内的 `settleGatewayResult`（`packages/daemon/src/worker/outcome.ts:126-165`）改判结果。开源版网关在守护进程内，`model.call` 由守护进程直接提交；Worker 只上报 Driver 结果与输出观测，Runtime 在守护进程内按第 4 节的规则表判定，规则只读已提交的证据。
2. **调用归属**：Session 作用域的 Gateway Key 取代现状每个 Worker 的私有网关与令牌。Session 的 Run 串行，所以带该 Key 的调用归属当时活动 Run 的 `runId` 与 generation；没有活动 Run 时返回 409 `no_active_run`，并按 [03 第 2 节](03-model-plane.md#2-gateway-key-与作用域) 留下拒绝记录。
3. **事件信封 v2**：增加 `generation` 与全库递增的 `gseq`（控制台全局事件流用它续传）；事件类型统一为小写点分，如 `run.accepted`、`run.status`、`run.finished`、`permission.requested`，旧名称映射见第 11 节。
4. **默认期限**：现状默认 60 秒（`packages/agents/src/engine/registry.ts` 的 `defaultTimeoutMs`），对编码任务过短；开源版默认 30 分钟、上限 24 小时，由配置解析器集中解析。
5. **状态枚举保持封闭**：不新增 Run 状态。新增内容只出现在 stopReason、错误码与结算字段，这三者是开放枚举，客户端必须容忍未知值（见 [06 第 2 节](06-interfaces.md#2-rest-api-规范)）。

## 2. Session 与 Run 模型

Session 创建时解析并冻结以下字段，之后修改 Profile、路由组或 Library 不影响已建 Session，与现状“Session 固定 revision”一致。

| 字段 | 含义与约束 |
|---|---|
| `agent` | Adapter ID（如 `codex`），只做精确匹配；快照 Adapter 版本与清单摘要、探测到的 Agent 版本与可执行文件 hash |
| `model` | Model Ref `provider/model` 或 `group/<id>`；快照路由组 revision、成员列表，以及各成员窗口与输出上限的生效值和来源。1.0 不支持在 Session 内换模型，比较模型就建多个 Session |
| `workspace` | 第 3 节的工作区描述，或已登记的 Workspace ID |
| `profile` | 可选，只提供 `model` 与 `library` 的默认值；创建时展开并记录 revision |
| `library` | 选中的 Skills、MCP 服务与指令集，各自解析为内容摘要，以隔离接线写入 Session 私有配置 |
| `policy` | 权限策略 ID 或内联策略（第 5 节）；记录生效 revision 与覆盖报告 |
| `isolation` | 请求的隔离等级与逐维度的实际等级（第 6 节） |
| `budget` | Session 总预算；每个 Run 的预算不得超过剩余额度 |
| `gatewayKeyId` | 创建时签发的 `session:` Key 的 ID。明文只进入 Worker 私有配置，不出现在响应中；关闭 Session 时吊销 |
| `modelTraffic` | 1.0 只有 `gateway`：Agent 的全部模型请求必须经过网关。让 Agent 用自身登录的 `native` 模式放到 1.x，届时零调用规则不适用，证据等级固定为 `agent_reported` |
| `labels` | 最多 32 个键值对，用于过滤与比较批次 |

Run 的输入：`text`（必填，仍不接受图像或文件上传，见 [DESIGN.md §7](../../../DESIGN.md#7-通用-api-基线)）；`timeoutMs`（从持久接收起算）；`budget`（`maxModelCalls`、`maxTokens`、`maxCost`，只能收紧）；`policy`（只能更严格，放宽返回 `POLICY_WIDENING_REJECTED`）；`outputs`（沿用）；`verify`（结束后运行的评分器，第 8 节，结果写成 Evaluation，不改变 Run 状态）；`interactive`（`false` 表示无人值守，第 5 节）；`parentRunId` 与 `batchId`（MCP 委派与比较批次的关联）。

Run 的结果：`status`、`stopReason`、`error` 与 `settlement` 见第 4 节。`usage` 与 `cost` 取本 Run 全部 `model.call` 的合计，即 Run 级账本（[03 第 8 节](03-model-plane.md#8-用量与成本账本)）。Agent 自报的用量另存为 `agentReportedUsage`，两者不相加也不互相覆盖：现状 ACP 只回报最后一次调用的用量，上一轮实测中引擎回报 21,160 token，网关合计为 466,202。`modelEvidence` 表示账本的证据强度（第 4.4 节），`workspaceResult` 是 diff 摘要与产物（第 3 节），`cleanupStatus` 沿用。

预算在网关转发每次调用之前检查，触顶后以拒绝原因 `run_budget_exceeded` 拒绝后续调用（在 03 第 2 节的拒绝原因上新增一项），Runtime 随即停止 Run。调用开始后不能中途截断，因此超支上限是单次调用的用量，与 03 中 Key 额度的规则相同。上游没有返回 usage 时，设置了 `maxTokens` 的 Run 以 `BUDGET_UNVERIFIABLE` 失败，不按字符数估算；`maxCost` 要求路由涉及的每个模型都有已知价格，否则创建时返回 `BUDGET_UNENFORCEABLE`。

## 3. 工作区

| 类型 | 来源 | 所有者 | 能否被 HarnessHub 删除 | 适用场景 |
|---|---|---|---|---|
| `path` | 用户登记的现有目录 | 用户 | 永不删除 | 在自己的仓库里直接运行，与现状 Workspace 相同 |
| `worktree` | 对 git 仓库执行 `git worktree add`，位于 `<数据根>/workspaces/<id>/`（数据根见 [07 第 1 节](07-data-security.md#1-数据目录与文件布局)） | HarnessHub | 满足删除条件时 | 并行比较、CI、委派任务，默认类型 |
| `temp` | 空目录，或由数据集 fixture、压缩包展开 | HarnessHub | 满足删除条件时 | 评测、无仓库的任务 |

**创建 worktree**：先把 `baseRef`（默认 `HEAD`）解析为提交 SHA，以该 SHA 建分离 HEAD 的 worktree，再创建分支 `hh/<sessionId>` 供审阅与合并。源仓库有未提交改动时，默认 `snapshot: head` 只用已提交内容，并记录 `sourceDirty: true`；`snapshot: working-tree` 用临时索引文件（`GIT_INDEX_FILE`）执行 `git add -A`、`git write-tree` 与 `git commit-tree` 生成快照提交作为基准，包含已跟踪的改动与未忽略的新文件，不改动用户的索引与工作区。

**写入租约**：同一工作区同时最多一个活动 Run 写入。`path` 工作区可被多个 Session 引用；被占用时新 Run 留在 `queued`，原因 `workspace_busy`，等待时间计入 deadline。

**删除条件**（全部满足）：没有活动或排队的 Run；没有被 pin 的 Run 或评测引用；存储中的所有者记录、`<数据根>/workspaces/<id>.owner.json` 旁车文件与 `git worktree list` 三者一致；未提交的改动已作为 diff 产物保存，或用户明确确认丢弃。删除用 `git worktree remove --force`；分支 `hh/<sessionId>` 只在没有新提交时删除，否则保留，除非显式 `--delete-branch`。与进程 lease 的做法一致，身份不明的目录不删除，只进入隔离列表。保留期见第 10 节。

**diff 采集**：声明式 `outputs` 的采集沿用 [文件产物](../../file-artifacts.md) 的全部规则；此外，Runtime 在启动 Agent 之前与 Driver 返回结果之后各做一次快照，tree SHA 记入 `workspace.snapshot` 事件，然后计算 `git diff --binary --find-renames <起点> <终点>`。

- `worktree` 直接在 HarnessHub 自有的 worktree 上计算。`path` 与 `temp` 使用 `<数据根>/workspaces/shadow/<workspaceId>.git` 影子仓库，以 `--git-dir` 与 `--work-tree` 指向工作区：用户仓库的 `.git`、索引与对象库都不被写入，Agent 也看不到影子仓库。工作区的 `.gitignore` 照常生效；只使用 `add`、`write-tree`、`diff` 这类不触发 hook 的命令，并关闭 fsmonitor 与换行转换。
- 结果登记为不可变产物 `changes.patch`，附文件数、增删行数与二进制文件数。超过 16 MiB 时只保存统计并记 `workspace.diff_too_large`，不截断，也不因此判失败。
- 工作区超过 20 万个文件或 2 GiB 时，创建 Session 即返回 `WORKSPACE_DIFF_UNSUPPORTED` 警告，之后不做 diff，而不是静默跳过。Agent 留下的后台进程可能在终点快照后继续写文件，事件中保留快照时间。

## 4. Run 结果判定

### 4.1 三个结算面

Run 的结果分三个面分别结算、分别记录，公共 `status` 由 4.3 的规则表推导；任务是否做对由第 8 节的 Evaluation 判断，不进入 Run 状态。

| 结算面 | 回答的问题 | 取值 | 输入 |
|---|---|---|---|
| `execution` | 执行是否正常结束 | `ended`、`agent_failed`、`crashed`、`cancelled`、`deadline`、`budget`、`setup_failed`、`interrupted` | Driver 结果、Runtime 仲裁 |
| `evidence` | 调用证据是否支持“Agent 经网关正常完成了一轮” | `consistent`、`gateway_unused`、`no_output`、`last_main_failed`、`empty_responses`、`not_applicable` | 本 Run 的 `model.call` 与输出观测 |
| `outputs` | 声明的产物是否齐全、完整 | `complete`、`missing`、`error`、`none_declared` | 采集器结果 |

`completed` 当且仅当 `execution = ended`、`evidence` 为 `consistent` 或 `not_applicable`、`outputs` 不是 `error`。`outputs = missing` 不改变状态，只记 `artifact.missing`，由评分器判任务失败，与现状一致。`completed` 因此只表示“执行正常结束，且调用证据一致”，Evaluation 也永不修改 Run 状态。控制台与 CLI 分栏显示，例如“执行：完成 · 证据：一致（observed）· 产物：齐全 · 验证：2/3 通过”，不合并成一个“成功”标记。

### 4.2 调用的判定类别

Runtime 从 [03 第 8 节](03-model-plane.md#8-用量与成本账本) 的 `model.call` 字段推导每次调用的判定类别，不新增存储字段。网关如何把这些情况返回给 Agent 由 03 规定。

| 类别 | 由 `model.call` 的哪些事实得出 | 用法 |
|---|---|---|
| `ok` | 2xx 且有有效内容；包括缺终止事件而记为 `completion: inferred` 的调用，以及原样透传的未知停止原因 | 成功 |
| `empty` | 2xx、协议完整，但既无文本也无工具调用 | 只用于 R12 |
| `upstream_error` | 全部尝试都以上游 4xx/5xx 或连接失败结束，`errorSource = upstream` | 失败 |
| `invalid_response` | 502 `upstream_invalid_response`（HTML、业务错误 JSON、空 SSE、只有不可读 choice），或已知异常停止原因（如 `network_error`、`sensitive`）被转为错误，或响应体中途断开 | 失败 |
| `content_filtered` | 停止原因为 `content_filter`，且没有正文与工具调用 | 失败 |
| `rejected` | `rejected = true`：Key 无效或吊销、模型越权、来源不允许、额度或 Run 预算触顶，以及路由层拒绝（未知路径、畸形路由、带 Origin 头，核验 V7-N2） | 失败 |
| `engine_disconnected` | 同名 `errorClass`：Run 仍有效时 Agent 先断开（通常是 Agent 自身超时） | 失败 |
| `client_cancelled` | 同名 `errorClass`：Run 取消、超时、会话关闭，或第 4.4 节的结算屏障中止了在途调用 | 不参与判定 |

调用角色：`shape` 中工具数大于 0 的调用是**主调用**，否则是**侧调用**（标题生成、摘要等）；请求体尚未解析就被拒绝的调用按主调用处理。1.0 只依据请求形状判定角色，不按提示词前缀猜测用途。

### 4.3 证据规则表

规则自上而下匹配，第一条命中即确定结果。R1–R8 处理仲裁与执行失败；R9–R13 只在 Driver 报告完成时检查调用证据与产物。

| ID | 条件 | 终态 | 错误码 / stopReason | 理由 |
|---|---|---|---|---|
| R1 | Runtime 已受理取消请求 | `cancelled` | — / `cancel_requested` | 仲裁结果不被晚到的后端完成覆盖 |
| R2 | deadline 先于完成到达 | `timed_out` | `RUN_DEADLINE_EXCEEDED` / `deadline` | 同上 |
| R3 | Run 预算耗尽或无法核实 | `failed` | `BUDGET_EXCEEDED`、`BUDGET_UNVERIFIABLE` / `budget_<kind>` | 被 HarnessHub 截断的执行不算正常结束 |
| R4 | 守护进程重启或存储故障后无法证明结果 | `interrupted` | `RUN_INTERRUPTED` / `daemon_restarted` | 沿用现状，不自动重跑 |
| R5 | 工作区准备、私有配置生成、隔离或策略无法生效 | `failed` | `WORKSPACE_PREPARE_FAILED`、`ISOLATION_UNSUPPORTED`、`POLICY_UNENFORCEABLE`，以及 04 第 6 节的 `ISOLATION_OVERRIDDEN`、`ISOLATION_MANAGED_CONFIG` / `setup_failed` | 不支持的能力明确失败，不降级执行 |
| R6 | Worker 或 Agent 异常退出、协议错误，没有 Driver 结果 | `failed` | `AGENT_CRASHED`、`AGENT_PROTOCOL_ERROR` / `backend_error` | 细分现状的 `BACKEND_ERROR` |
| R7 | 无人值守 Run 遇到 `ask` 且 `onAsk = fail` | `failed` | `PERMISSION_REQUIRED` / `permission_required` | 见第 5 节 |
| R8 | Driver 报告失败，或 Agent 自行取消 | `failed` | `AGENT_REPORTED_FAILURE` / `agent_failed`、`agent_cancelled` | 公开 Agent 给出的原因，最多 500 字符 |
| R9 | 本 Run 没有任何调用（不计 `client_cancelled`），有可见输出（非思考文本、工具事件或权限请求，沿用 `packages/daemon/src/worker/outcome.ts:17-37`），且输入不是 Adapter 声明的本地命令 | `failed` | `MODEL_GATEWAY_UNUSED` | 输出不是经网关的模型回答，可能是 Agent 打印的连接错误、本地命令或配置层绕过（核验 V5-N1、zero-calls-completed） |
| R10 | 没有任何调用，也没有可见输出 | `failed` | `AGENT_NO_OUTPUT` | 即现状的 `ENGINE_NO_OUTPUT` |
| R11 | 按开始时间排序的最后一次主调用属于失败类别，且其后没有 `ok` 的主调用 | `failed` | `upstream_error`、`invalid_response` → `MODEL_UPSTREAM_ERROR`；`engine_disconnected` → `AGENT_DISCONNECTED`；`content_filtered` → `MODEL_CONTENT_FILTERED`；`rejected` → `GATEWAY_REJECTED` | Agent 可能把错误写成正文后以 end_turn 结束（codex-acp 1.10.0 未协商 sessionFailure 时即如此），也可能静默结束；“之前成功过”不能掩盖最后一次失败（核验 V7-N1、V3-N1、abort-vs-cancel、stream-integrity、V7-N2） |
| R12 | 有主调用且全部为 `empty`，并且没有可见输出 | `failed` | `MODEL_EMPTY_RESPONSE` | 模型没有给出任何回答 |
| R13 | 采集声明产物时发生 I/O 或完整性错误 | `failed` | 采集器错误码，如 `ARTIFACT_CHANGED` | HarnessHub 无法交付已声明的产物 |
| R14 | 其余情况 | `completed` | — / Driver 原值，如 `end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`local_command` | 执行正常结束；正确性由 Evaluation 判断 |

补充约定：

- R9 的豁免只认 Adapter 清单 `run.localCommands`（在 [04 第 1 节](04-agent-plane.md#1-adapter-清单) 的 `run` 段新增）逐条声明的本地命令（如 codex-acp 的 `/status`），按输入首个词精确匹配，不笼统放行所有以 `/` 开头的输入。Magpie 用网关侧观测反证 Agent 侧的做法（`internal/agent/applied.go` 的 `bypassed`：Agent 被使用过而网关没有收到请求）是 R9 的参照，但它按时间窗判断，不涉及单次任务的结果。命中时 `evidence = not_applicable`，stopReason 为 `local_command`。
- 侧调用在最后一次主调用成功之后失败，不触发 R11，避免并发的标题调用造成误判。
- Agent 自身的限制触顶（`max_tokens`、`max_turn_requests`）按 [DESIGN.md §5](../../../DESIGN.md#5-run-生命周期与控制契约) 记为 `completed` 加具体 stopReason。
- R9–R12 失败时 Agent 进程本身健康：Session 保留 Worker，可以继续提交下一个 Run，与现状 `modelRunFailureCodes`（`packages/core/src/errors.ts`）的语义一致。

### 4.4 判定时机、可解释性与证据强度

**结算屏障**：Runtime 收到 Driver 结果或作出仲裁后，先关闭该 Run 的调用作用域，之后带该 Key 的新请求返回 409 `no_active_run`；在途调用最多等待 5 秒，到时中止并记为 `client_cancelled`。屏障结束后规则才读取已提交的事件；终态、`settlement` 与 `run.finished` 在同一事务提交。

**可解释**：`settlement` 记录三个结算面、命中的规则 ID、规则集版本（首版 `settle/1`）与引用的证据事件序号，通过 `GET /api/v1/runs/{id}/settlement` 与 `hh runs explain` 查看。规则修改产生新的规则集版本，已结束的 Run 永不重新结算。

**证据强度** `modelEvidence`：`enforced` 表示 Session 的网络隔离为 `gateway-only` 且实际生效（第 6 节），Agent 进程树只能连到网关，在该隔离等级声明的范围内不存在绕过路径；其余情况为 `observed`，此时只有导致零调用的绕过能被发现（R9），部分请求经网关、部分直连的混合绕过发现不了。控制台与 CLI 必须显示这一等级，不能把 `observed` 说成“已证明只用了配置的模型”。

**启用前核实**：每个 Adapter 标为 `stable` 级之前，一致性测试（[04 第 9 节](04-agent-plane.md#9-一致性测试)）必须在其固定版本上覆盖下列真实 Agent 场景，结果与预期一致。场景沿用上一轮核验在正式入口复现时的 BYPASS、LATEFAIL、MISROUTE 对端模式，改写为本仓库的固定 fixture。

| 场景 | 预期 |
|---|---|
| 带工具调用的正常任务 | `completed` |
| 第二次主调用被上游以 400（上下文超长）拒绝，Agent 把错误写成正文 | `MODEL_UPSTREAM_ERROR` |
| 上游返回 200 HTML 页面 | `MODEL_UPSTREAM_ERROR` |
| Agent 因空闲超时断开 | `AGENT_DISCONNECTED` |
| Agent 不调用模型，只输出连接错误文本 | `MODEL_GATEWAY_UNUSED` |
| 最后一次主调用成功之后，侧调用失败 | `completed` |

## 5. 权限与策略

### 5.1 工具类别

策略按工具类别匹配。类别从 ACP 的 ToolKind 映射，ACP 以外的 Driver 由 Adapter 提供映射。

| 类别 | ACP ToolKind 来源 | 补充匹配字段 |
|---|---|---|
| `read` | `read`、`search` | 路径 |
| `write` | `edit`、`delete`、`move` | 路径 |
| `execute` | `execute` | 命令 argv |
| `network` | `fetch` | 主机 |
| `mcp` | Adapter 识别为 MCP 工具的调用（如 Claude Code 的 `mcp__<server>__<tool>`） | 服务名、工具名 |
| `other` | `think`、`switch_mode`、`other` | — |

### 5.2 策略格式

规则自上而下匹配，第一条命中即生效，都不命中时用 `default`。设计示意，不可直接运行：

```yaml
id: workspace-write
default: ask
rules:
  - match: { category: read }
    action: allow
  - match: { category: write, path: { within: workspace } }
    action: allow
  - match: { category: write }
    action: deny
  - match: { category: execute, argv: { prefix: [["pnpm", "test"], ["git", "status"]] } }
    action: allow
  - match: { category: network }
    action: deny
  - match: { category: mcp, server: github, tool: "create_*" }
    action: ask
unattended:
  onAsk: deny
```

`execute` 只匹配 Agent 给出的结构化 argv；含 `;`、`&&`、`|`、`$()`、反引号或重定向的 shell 字符串永远不匹配 `allow` 规则，只能落到 `default`，防止 `pnpm test; rm -rf ~` 借前缀放行。路径按工作区规范路径解析。HarnessHub 判断的是 Agent 申报的路径，不能保证工具实际访问的就是它（例如跟随符号链接），真正的访问限制依赖第 6 节的隔离。

### 5.3 执行路径与覆盖报告

策略经两条路径生效。**路由决定**：Agent 发出权限请求（ACP `session/request_permission`）后，HarnessHub 按策略选择实际 option ID，`allow` 选 `allow_once`，`deny` 选 `reject_once`，`ask` 生成待决权限，由 API、控制台或 CLI 回答；现状只有这一条路径，基线是全部拒绝（[运行 API](../../runtime-api.md)）。**原生配置**：Adapter 把策略中能表达的部分翻译为 Agent 原生配置并写入 Session 私有配置，例如 Claude Code 的 `permissions.allow/deny/ask`、Codex 的 `approval_policy` 与 `sandbox_mode`、OpenCode 的 `permission`、Gemini CLI 的审批模式与排除工具列表，具体字段按 Adapter 固定的 Agent 版本核实。

创建 Session 时生成覆盖报告，对每个“类别 × 动作”标注 `routed`、`native` 或 `unenforced`。只要有 `deny` 或 `ask` 规则落在 `unenforced` 上，创建即以 `POLICY_UNENFORCEABLE` 失败并列出缺口，用户可以修改策略或换 Agent；`allow` 规则落在 `unenforced` 上不算缺口。这把 [DESIGN.md §3](../../../DESIGN.md#3-模块和执行所有权) 中“公共权限回调并不自动覆盖所有原生工具路径”的说明变成了可机读、可拒绝的检查。

### 5.4 预设、无人值守与审计

内置三个预设：`read-only`、`workspace-write`（上例）与 `full-access`。`full-access` 必须显式指定并写入审计；MCP 发起的 Run 只有在委派令牌明确授予时才能使用它（第 9 节）。

`interactive: false` 的 Run 没有人回答 `ask`，由 `onAsk` 决定：`deny`（默认，选 `reject_once` 并让 Agent 继续）、`fail`（按 R7 结束 Run）、`wait`（等待 API 决定直到 deadline，供有外部审批人的 CI 使用）。策略自动决定只选择 `*_once` 选项；`allow_always`、`reject_always` 只能由人显式选择，记录 `scope: agent-session`。同一类别有多个候选 option ID 时明确拒绝，沿用现状。

审计事件：`policy.applied`（策略 ID 与 revision、覆盖报告、原生配置摘要 hash）；`permission.requested`（类别、工具标题、脱敏后的路径或命令摘要、toolCallId、可选 option）；`permission.decided`（决定者 `policy`、`user`、`api` 或 `mcp`，命中的规则 ID，选中的 option ID）；`permission.applied`（Worker 已应用，不代表工具执行成功）。它们进入 rollout 导出，可用 `GET /api/v1/permissions?decidedBy=policy` 等条件查询。

## 6. 沙箱与隔离等级

隔离按维度声明，每个维度取 `none`（不做限制，Agent 拥有当前用户的全部权限）、`partial`（由操作系统机制强制部分限制，已知缺口逐条列出）或 `full`（默认拒绝，并有金丝雀测试证明在声明的威胁模型内没有已知绕过）。1.0 的实际能力：

| 维度 | macOS | Linux | Windows |
|---|---|---|---|
| 文件写 | `partial`：Seatbelt（`sandbox-exec`）只允许写工作区、Session 状态目录与临时目录 | `partial`：Landlock（内核 5.13 及以上）限制同样的目录；更早的内核为 `none` | `none` |
| 文件读 | `none`：Agent 需要读工具链与系统目录；1.x 评估拒读 `~/.ssh`、密钥库目录与 HarnessHub 数据目录 | `none` | `none` |
| 网络 | `partial`：`gateway-only` 时只允许连接回环地址上的网关端口 | `partial`：Landlock ABI v4（内核 6.7 及以上）只能按端口限制 TCP 连接，不能按地址；更早的内核为 `none` | `none` |
| 进程 | 生命周期归属（进程组），不是安全边界 | 同左 | 生命周期归属（Job Object，[ADR 0007](../../decisions/0007-windows-process-supervision.md)） |

1.0 范围与规则：

- 隔离默认关闭，界面显示“未隔离”。请求格式为 `isolation: { filesystem: "workspace-write", network: "gateway-only" | "open" }`。请求的等级在当前平台达不到时，以 `ISOLATION_UNSUPPORTED` 失败并返回各维度可用等级，不静默降级；实际等级逐维度写入 Session。
- macOS 与 Linux 的隔离在 1.0 标为实验性；Windows 在 1.0 不提供文件或网络隔离，AppContainer 等方案在 1.x 评估。`full` 在 1.0 不对任何平台声明；1.x 通过容器执行后端（Docker 或 Podman）为文件与网络提供 `full`，也为第 8 节需要容器环境的评测任务提供基础。
- 隔离作用于 Worker 启动的 Agent 进程树，包括 Agent 拉起的 stdio MCP 服务，不影响远程 MCP 服务。`gateway-only` 会让 Agent 自带的联网工具与远程 MCP 失效，这是该等级的预期后果。
- 部分 Agent 自带沙箱（如 Codex 在 macOS 上用 Seatbelt）。嵌套沙箱能否工作逐个 Adapter 实测；不兼容时由 Adapter 关闭 Agent 自带沙箱并在覆盖报告中说明，或者拒绝该隔离请求。`sandbox-exec` 已被 Apple 标为弃用，每个 macOS 大版本复验。
- 每项声明都有金丝雀测试：在工作区外写文件、连接外部主机、读取另一个 Session 的状态目录，在三平台 CI 中分别断言“被拒绝”或“如实标为 none”。没有 Windows 原生证据的条目不得写成已支持。

## 7. 并行运行与比较

`hh run --agents codex,claude-code,opencode --model deepseek/deepseek-chat "…"` 创建一个比较批次。每个目标有独立的 Session 与 worktree，全部从同一个已解析的基准 SHA 创建，使用相同的提示、策略、隔离、预算、deadline 与 `verify` 评分器。

- **调度**：全局并发上限 `maxConcurrentRuns` 默认 4（沿用现状 `maxConcurrency`），每个 Agent 另有上限，批次可再设 `concurrency`。批次调度器只在有空闲容量时才把目标提交为 Run，所以每个 Run 的 deadline 从真正被接收时起算，排队不消耗某个目标的期限；“deadline 从接收起算”的契约不变，各目标的期限仍然公平。
- **同一模型**：具体的 Model Ref 直接满足。使用路由组时（如 01 旅程 2 的 `--model group/fast`），批次创建时按该组策略解析一次首选成员，写入每个 Session 的路由快照作为粘性初值，使各目标从同一成员开始；之后的故障转移仍按 [03 第 5 节](03-model-plane.md#5-路由故障转移与重试) 进行。比较表逐目标列出实际应答的模型，不一致时标记 `modelMismatch`，CLI 同时给出警告。
- **比较表**（`GET /api/v1/runs/batches/{id}`）：逐目标给出状态与 stopReason、三个结算面、`verify` 结果、diff 统计、调用次数、token、成本、总耗时、首个输出时间、实际应答模型与 `modelEvidence`。没有评分器时不选“最佳”；有评分器时只按评分排序，成本与耗时并列展示。
- **采纳结果**：`hh runs apply <runId>` 生成计划，把该 Run 的 `changes.patch` 以 `git apply --3way` 应用到源目录；被改动的文件在源目录有未提交修改时拒绝。先显示计划，确认后写入。批次的 worktree 在采纳或保留期到期前都保留。
- **日常比较**：带 `verify` 的批次产生 Evaluation。控制台 Runs 页按标签把多个批次聚合为“同一模型下各 Agent 的通过率、成本与耗时”，只读取已保存的结果，不重新执行。

## 8. 评测

评测由现有 Benchmark（[说明](../../benchmark.md)、`src/benchmark/`）演进而来，保留：dataset schema v1 的读取；`text-exact`、`json-equal`、`file-sha256` 三种确定性评分器；fixture 路径规则；证据原文与 hash 的保存及只读重新评分；Evaluation 状态 `passed`、`failed`、`execution_failed`、`interrupted`、`evaluator_error`；事后 best-of 覆盖指标；评测表独立管理版本。

| dataset v2 新增 | 内容 |
|---|---|
| 工作区来源 | v1 的 `fixtureFiles`；`repo`（URL 或本地路径，必须给出提交 SHA）；`archive`（必须给出 sha256） |
| `setup` | Agent 启动前在同一隔离等级下执行的 argv 列表，有独立期限，不计入 Agent 的 deadline |
| `command` 评分器 | 在 Run 结束后的工作区执行 argv：退出码 0 为 `passed`，非 0 为 `failed`，超时为 `failed`（原因 `grader_timeout`）；stdout、stderr 各最多 1 MiB，作为产物保存；不注入 Gateway Key |
| `junit` 评分器 | 解析 JUnit XML，记录通过数与总数，可设通过阈值 |
| `model-judge` 评分器（1.x） | 指定评判模型与评分细则；评判调用同样记录为 `model.call` 并计入成本；默认不能单独决定 `passed` |
| `targets`、`repeats` | Agent × 模型 × 策略的矩阵，每个组合重复 k 次 |

每个 attempt 保存可复现元数据：HarnessHub 版本与提交、Adapter ID/版本/清单摘要、Agent 版本与可执行文件 hash、请求的 Model Ref 与路由组 revision、各调用实际应答的模型、dataset 与 task 的版本和内容 hash、工作区基准 SHA、策略与覆盖报告、实际隔离等级、预算、Library 内容摘要、操作系统/架构/Node 版本，以及规则集版本。这里的“可复现”指环境与证据可复核、可重新评分，不承诺模型输出逐字相同。报告给出 pass@k（Chen 等 2021 年的无偏估计）、得分均值与 95% bootstrap 置信区间、token 与成本中位数；缺失的 usage 与 cost 保持 null，不补零。

外部格式：1.x 提供 Harbor（Terminal-Bench 2.0 官方 harness）任务目录的导入器，把指令、环境定义、测试脚本与参考解映射到 dataset v2；它依赖容器执行后端，字段映射以导入时固定的 Harbor 版本核实。

范围：01 的版本表把评测列在 1.x。0.3 起 `verify` 中的 `command` 与 `junit` 评分器随并行比较提供；`hh eval` 与 `/api/v1/evals` 在 1.0 标为实验性，不纳入 API 兼容承诺；1.x 完成 dataset v2、`model-judge`、Harbor 导入与控制台评测页。

## 9. MCP Server

HarnessHub 以 MCP Server 向其他 Agent 暴露执行平面，让它们把任务委派给 HarnessHub 管理的 Agent。传输有两种：stdio（`hh mcp serve`，内部经 SDK 调用守护进程）与 Streamable HTTP（`/api/v1/mcp`）。工具名不加前缀，以服务名 `harnesshub` 接入后，Claude Code 看到的名称形如 `mcp__harnesshub__start_run`。

| 工具 | 输入 | 输出 |
|---|---|---|
| `list_agents` | — | 允许的 Agent、版本与能力摘要 |
| `list_models` | `agent?` | 允许的 Model Ref |
| `start_run` | `agent`、`model`、`prompt`、`workspace`（`{repo, baseRef}` 或 `{temp: true}`）、`timeoutMs`、`budget`、`policy`（预设名）、`verify`、`outputs` | `runId`、`sessionId`、`workspaceId` |
| `wait_run` | `runId`、`afterSeq`、`waitSeconds`（最多 60） | 状态、最多 50 条事件摘要、`lastSeq` |
| `get_run` | `runId` | 状态、`settlement`、usage 与成本、diff 统计、Evaluation |
| `get_diff` | `runId`、`maxBytes`（最多 1 MiB） | patch 文本；超过上限时返回大小与产物 ID，不截断 |
| `cancel_run` | `runId` | 取消已受理及当前状态 |
| `compare` | `agents` 及 `start_run` 的其余字段 | `batchId` |
| `get_batch` | `batchId` | 第 7 节的比较表 |

权限边界：

- 认证使用**委派令牌**：一种只能调用 MCP 端点的控制面令牌，由 `hh mcp grant` 签发，与 Gateway Key 分开（03 规定 Gateway Key 不能访问 `/api/v1`）。令牌规定 Agent 白名单、Model Ref 白名单、仓库白名单（只能基于已登记仓库建 worktree 或 temp 工作区，不能用 `path` 指向任意目录）、策略上限（默认最高 `workspace-write`）、同时运行的 Run 数（默认 2）、单 Run 与每日预算上限，以及委派深度（默认 1）。
- 不暴露：provider、credential、Gateway Key、接线、Library、插件的写操作；权限决定（防止委派方替被委派的 Agent 批准提权）；事件中的提示词与正文，只返回摘要。
- 经 MCP 发起的 Run 一律 `interactive: false`，`onAsk` 由令牌规定，默认 `deny`。
- 递归委派：HarnessHub 为自己管理的 Session 注入的 MCP 配置使用绑定了 `parentRunId` 的令牌。子 Run 的 deadline 不超过父 Run 的剩余时间，预算从父 Run 的剩余额度中扣除，父 Run 取消时级联取消；深度按令牌绑定计算，不信任调用方自报。
- 每次工具调用记录 `mcp.tool_call` 事件（有父 Run 时写入父 Run）与守护进程审计日志，包含令牌 ID。

1.x 评估把 HarnessHub 暴露为 [A2A](https://a2a-protocol.org/latest/) Agent：Agent Card 列出可用的 Agent 与模型，A2A Task 映射为 Run，任务状态与产物分别映射到 Run 状态与 Artifact。它依赖 1.0 冻结的 Run API。

## 10. 容量、回收与数据保留

| 资源 | 默认值 | 达到上限时 |
|---|---|---|
| 并发 Run（`maxConcurrentRuns`） | 4，范围 1–64 | 新 Run 排队 |
| 排队 Run（`maxQueuedRuns`） | 1000（沿用现状） | 新提交返回 429；已有幂等键的重放仍返回原 Run |
| 常驻 Worker（`maxWorkers`） | 16（沿用现状） | 明确失败，要求先关闭空闲 Session，不静默回收不可恢复的上下文 |
| Worker 空闲回收 | 空闲 10 分钟，且满足 DESIGN §4 的可恢复条件 | 不满足条件的保留到显式关闭或 Session 过期 |
| 工作区磁盘软上限 | 20 GiB | 拒绝新建 worktree 与 temp，返回 `WORKSPACE_QUOTA_EXCEEDED` 并列出可回收项 |
| SSE 订阅者 | 每个 Run 64 个，全局 256 个 | 返回 429 |

数据保留以 [07 第 2.3 节](07-data-security.md#23-数据保留) 为准：本机默认不自动删除 Session、Run、事件、权限与产物，`model.call` 明细保留 180 天且删除前先汇总，HarnessHub 创建的 worktree 与 temp 工作区在 Session 关闭 24 小时后删除；清理由每日任务或 `hh gc` 执行，完成后提交 `retention.pruned` 事件，未进入终态的 Run 不参与清理。执行平面补充三条：

- `hh run` 与比较批次创建的 Session 在 Run 结束后保持打开，直到用户采纳或丢弃结果，或闲置 7 天后自动关闭，给用户留出审阅 diff 的时间；之后才进入 07 的 24 小时删除窗口。
- 工作区删除还必须满足第 3 节的条件；不满足的工作区保留并在 `hh workspace list` 中标出原因，不强行删除。
- 守护进程启动时，除沿用 lease 核实与 interrupted 处理外，还对照工作区登记表与磁盘：磁盘上有而登记表里没有的目录进入隔离列表、不删除；登记了但目录丢失的工作区记 `workspace.lost`。

## 11. 与现状的差异与迁移

| 现状 | 开源版 | 迁移动作 |
|---|---|---|
| Worker 内 `settleGatewayResult` 两条改判规则（[ADR 0013](../../decisions/0013-unified-model-gateway.md) 的“Run 结果”） | 守护进程内的规则表 R1–R14 与三个结算面 | 新 ADR 替代该节；`tests/unit/worker-outcome.test.ts` 中“有文本、0 次调用仍为 completed”的断言改为期望 `MODEL_GATEWAY_UNUSED` 并写明理由 |
| `ENGINE_NO_OUTPUT`、`MODEL_UPSTREAM_ERROR` | `AGENT_NO_OUTPUT`、`MODEL_UPSTREAM_ERROR`，新增 `MODEL_GATEWAY_UNUSED`、`AGENT_DISCONNECTED`、`MODEL_CONTENT_FILTERED`、`GATEWAY_REJECTED`、`MODEL_EMPTY_RESPONSE` | 保留 Session 的失败码集合同步扩展；旧码只出现在导入的历史数据中 |
| 调用记录在 Worker 内存中，499 同时表示取消与断开 | 读 03 的 `model.call` 字段推导判定类别 | 依赖 03 先区分 `client_cancelled` 与 `engine_disconnected`；规则集在 Adapter 一致性测试通过后启用 |
| `engineId`、`profileRevision`、`workspaceId` | `agent`、Adapter 与 Agent 版本快照、`workspace` 描述 | API 字段改名，见 06 |
| 默认期限 60 秒 | 30 分钟 | 改配置解析器默认值并同步文档 |
| `RUN_QUEUED`、`RUN_STATUS`、`RUN_COMPLETED`/`RUN_FAILED`/`RUN_CANCELLED`/`RUN_TIMED_OUT`/`RUN_INTERRUPTED` | `run.accepted`、`run.status`、单一的 `run.finished`（携带 status） | rollout 导出保留各事件原来的 schemaVersion |
| 权限只有 `allow_once`、`reject_once` 与全部拒绝的基线 | 四种选项、策略、覆盖报告与审计 | Benchmark 的 `--permissions deny/allow-once` 映射为预设加 `onAsk` |
| `benchmark-main.ts` 独立入口 | `hh eval`（实验性） | dataset v1 原样可读 |
| Workflow 自动规划（[说明](../../workflows.md)） | 不进入 1.0 API | 代码移入 experimental 命名空间，是否保留由 M3 的使用数据决定 |
| 比赛入口、统一模型、便携包 | 移出核心（[02 第 10 节](02-architecture.md#10-与现状的关系)） | 见路线图 |

数据迁移：`hh migrate import --from <旧数据目录>` 以只读方式打开旧 SQLite，把 Session、Run、事件、权限与产物导入新存储，产物文件复制后重新校验 hash。导入的 Run 保留原终态，`settlement.ruleSet` 标为 `adr0013-legacy`，不按新规则重新结算；旧事件保持 schemaVersion 1。

验收要求（在实现任务中执行，本文不声称已完成）：从正式守护进程入口，用本地假上游与 ACP 对端为 R1–R14 各写至少一条应命中的正例和一条不应命中的反例；第 4.4 节的六个场景在每个核心 Adapter 的固定版本上通过；工作区删除条件与影子仓库在中文与空格路径、超过 260 字符的 Windows 路径上验证；第 6 节的金丝雀测试在三平台 CI 中运行，Windows 结果单独记录，不以 macOS 或 Linux 结果代替。
