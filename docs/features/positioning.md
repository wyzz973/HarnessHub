# HarnessHub 的定位

本篇说明 HarnessHub 是什么、为谁做、和同类产品是什么关系、靠什么区别于它们，并逐项对照现在做到了哪一步。定位的权威表述在 [产品定义](../proposals/oss/01-product.md)（2026-10-02 的提案，关键决定已由所有者确认），本篇不改写它，只补上与 `main`（2026-10-06）现状的对照；各功能的细节见本目录的 [功能说明](README.md)。

## 一句话

开源的编码 Agent 控制平面：在一个地方决定每个 Agent 用什么模型、带什么工具，并用一套 API 无人值守地运行它们、比较它们、追溯每一次模型调用（[产品定义第 1 节](../proposals/oss/01-product.md#1-一句话定位)）。

拆开说，HarnessHub 是跑在用户自己电脑上的一个守护进程，同一个端口上有三层：

| 层 | 回答的问题 | 现在有什么 |
|---|---|---|
| 模型平面 | 每个 Agent 用哪个模型、走哪把 Key、花了多少 | 四种模型协议互转的本地网关、46 个 provider 预设、路由组与规则、按 Key 的白名单与预算、每次调用一条的账本（[模型平面](README.md#模型平面)） |
| Agent 平面 | 本机的 Agent 怎么接到这个网关上、带哪些指令与工具 | 28 个 Agent 的全局接线、Profile、Library（指令集、MCP 服务、Skills）同步（[Agent 平面](README.md#agent-平面)） |
| 执行平面 | 怎样让 Agent 无人值守地干活，并知道它干得怎样 | Session 与 Run、权限往返、文件产物、事件回放、结果判定、按任务记账、先做计划（[执行平面](README.md#执行平面)） |

前两层与 [Magpie](https://github.com/yetone/magpie) 做的是同一件事，HarnessHub 对照 Magpie 用 TypeScript 重写，对照表 165 项中 55 项相同、34 项有意不同、47 项部分、29 项未覆盖（[对照表](../magpie-parity.md)）。第三层是 Magpie 没有的：Magpie 只管 Agent 用哪个模型，Agent 始终由人在终端里使用；HarnessHub 还能通过 API 启动、驱动不同的 Agent 去执行任务。

## 在赛道中的位置

产品定义把这个赛道分成三层，目前没有产品把它们合在一起（[同类产品格局](../proposals/oss/01-product.md#8-同类产品格局)，数据取于 2026-10-02）：

| 层 | 代表项目 | HarnessHub 在这一层的取舍 |
|---|---|---|
| 模型层：每个 Agent 用什么模型 | CC Switch、claude-code-router、Magpie、LiteLLM、new-api、Bifrost | 做到与 Magpie 持平即可，不拼预设数量与订阅复用；LiteLLM、new-api、OpenRouter 乃至 Magpie 都可以作为 HarnessHub 的上游 provider |
| 执行层：让 Agent 去干活 | OpenHands（Agent Canvas）、sandbox-agent、acpx、OpenCode server | 主战场。最直接的竞争对手是 OpenHands Agent Canvas 与 sandbox-agent，而不是 Magpie |
| 观测层：花了多少、发生了什么 | ccusage、Langfuse、OpenTelemetry GenAI 语义约定 | 不另做观测平台：账本与 Run 事件是证据，经 OTLP 导出到用户已有的系统 |

一句话的取舍：模型平面对齐 Magpie 这类工具，执行平面与证据是 HarnessHub 自己的；两者在同一个进程里，所以一次任务的模型调用天然记在这次任务上。

## 靠什么区别于同类

产品定义列出五个现有产品都没有很好覆盖的方向。下表逐项对照现状：

| 方向 | 现在做到哪一步 | 还缺什么 |
|---|---|---|
| 基于证据的完成判定：执行结束、模型调用证据、产物校验分开结算 | 已实现主体：Run 结束前先等在途模型调用结算，上游报错或 Agent 没有输出时以 `MODEL_UPSTREAM_ERROR`、`ENGINE_NO_OUTPUT` 失败，不把退出码 0 当成功；声明的产物复制成带 SHA-256 的不可变副本（[任务经共享网关](run-plane/runs-on-gateway.md)、[文件产物](run-plane/artifacts.md)） | 测试或评判器对结果打分只在 Benchmark 中有，日常任务没有 |
| 模型治理与任务执行合一：Run 级账本，能证明 Agent 没有绕过网关 | 部分：任务选了网关的模型时，Agent 只拿到守护进程地址与这次任务专用的 `session:` Key，每次调用带着任务编号记账（[任务经共享网关](run-plane/runs-on-gateway.md)） | 用 Agent 自己接线运行的任务没有按任务的用量；Worker 用私有目录与环境变量白名单，上游凭据不进 Agent 的环境，但没有在网络层阻止 Agent 直连上游，“没有绕过网关”只能从配置与账本间接说明 |
| 公开的四协议互转一致性测试套件 | 已实现：用官方 SDK 客户端对四种协议跑 508 条用例，在本机 `pnpm check` 中执行（[测试体系与检查门禁](operations/testing-gates.md)） | 只有 macOS arm64 的结果；Linux、Windows 与真实 provider 的抽样尚未运行 |
| 同一任务、同一模型、不同 Agent 的日常比较 | 部分：Benchmark 可以让多个引擎做同一组任务并评分（[Benchmark 与 rollout 导出](run-plane/benchmark-rollout.md)） | 没有面向日常任务的多 Agent 并行运行与对比（计划中的 `hh run --agents`） |
| 跨 Agent 统一的权限与秘密策略 | 部分：权限请求经 API 往返并落库；秘密进系统钥匙串，出站请求自动脱敏（[权限往返](run-plane/permissions.md)、[秘密存储](operations/secrets.md)、[出站脱敏](model-plane/outbound-redaction.md)） | 只有单次允许或拒绝，没有按工具类别的策略文件与审计；Full Access 开关没有传到 Worker（见权限往返一篇） |

在与 Magpie 共有的两层上，HarnessHub 的有意不同集中在安全与可追溯：每个 Agent 一把自己的 Key，带白名单与预算、可单独吊销；Key 只存哈希，provider 凭据进系统钥匙串；用户改过的 Agent 文件按漂移报告而不覆盖；订阅只走厂商允许的方式；不发遥测（[对照表](../magpie-parity.md#one-key-per-agent)）。

## 为谁做

产品定义的五类用户，以及他们今天能用到什么（[目标用户与场景](../proposals/oss/01-product.md#3-目标用户与场景)）：

| 用户 | 他们要什么 | 今天能用到什么 |
|---|---|---|
| 同时用多个编码 Agent 的个人开发者 | 让几个 Agent 统一改用某个模型，一处管理 Key，看每个 Agent 花了多少 | 基本可用：`hh init`、`hh wire`、`hh tui`、控制台的 Agent、Provider 与用量页 |
| Agent 工具与平台开发者 | 在自己的产品里调用多种 Agent，不为每个 Agent 写一套集成 | 部分：HTTP API 与 SSE 可以创建 Session、提交 Run、订阅事件、处理权限、下载产物；执行接口还在旧 `/v1`，不受会话保护，SDK 没有 Run 与 SSE 层也未发布，也没有让其他程序经 MCP 调用 HarnessHub 的服务（现有的命令 MCP 服务只把工具包中的命令行程序提供给引擎） |
| 团队负责人、平台工程 | 统一采购 Key、按人或项目分配额度、审计调用 | 部分：局域网共享、带预算的 client Key、账本与 CSV 导出；没有团队服务器、登录与多用户 |
| 评测与研究者 | 同一任务在多个 Agent 与模型组合上跑并打分，结果可复现 | 部分：`hh benchmark` 与 rollout 导出 |
| CI 用户 | 在流水线中让 Agent 修测试、做评审，证据随构建保存 | 还没有：没有 GitHub Action，命令行也没有提交任务的命令 |

## 不做什么

照搬 [产品定义第 6 节](../proposals/oss/01-product.md#6-非目标)：不运营托管服务，数据留在用户自己的机器上；不重做 Claude Code、Codex 等 Agent 自己的交互界面，只管理与运行它们；不做训练、微调与模型托管；核心中不放违反厂商条款的订阅复用或逆向接口；不为单个厂商写硬编码分支，差异只经 Adapter、provider 预设或插件表达。

## 现在处在哪个阶段

预发布，处在里程碑 M0（开源重置）：没有正式发布的版本，只能从源码运行，0.1 之前接口还会变化（[路线图](../../ROADMAP.md)）。完整检查只在 macOS arm64 上通过，Windows 支持已实现但未在 Windows 上验证；单可执行文件只在 macOS arm64 上构建过（[构建身份与打包](operations/build-packaging.md)）。真实 provider 只用 DeepSeek 端到端跑过，真实 Agent 的结果见 [与真实 Agent 的兼容性](../compatibility.md)。

按定位，接下来的重心在执行平面与证据，而不是继续扩大模型平面：把执行接口迁到 `/api/v1` 并补上 SDK、让每个任务都有按任务的用量、日常任务的多 Agent 对比，以及第一个可安装的版本。具体候选与依据见 [优化候选摘要](README.md#优化候选摘要)，决定要做的事项进入 [TODO.md](../../TODO.md)。
