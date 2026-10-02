# 01 产品定义

状态：提案（草案），2026-10-02。架构术语见 [02 系统架构](02-architecture.md#2-术语)。

## 1. 一句话定位

**HarnessHub：开源的编码 Agent 控制平面。在一个地方决定每个 Agent 用什么模型、带什么工具，并用一套 API 无人值守地运行它们、比较它们、追溯每一次模型调用。**

英文对外表述（README 首行候选）：*One control plane for every coding agent — wire any agent to any model, run them headless through one API, and keep the evidence.*

## 2. 为什么对标 Magpie，以及差异在哪里

Magpie（[yetone/magpie](https://github.com/yetone/magpie)，Go，MIT）证明了一个真实需求：开发者同时使用多个编码 Agent，希望在一个地方切换它们的模型、共享订阅与 Key、看清用量。它在 10 天内积累了 1066 个提交、支持约 33 个 Agent 与 72 个 provider 预设，说明需求强、迭代快。

它的边界同样清楚。以下依据是 2026-10-02 对 `yetone/magpie@d874adb` 源码与提交历史的阅读（如 `internal/gateway/trace.go` 的 `traceKeep=60`、`internal/usage/usage.go` 写账本失败直接返回、`internal/provider/provider.go` 的明文存储、`internal/gateway/lan.go` 对回环来源的放行、`git shortlog` 统计）：

| Magpie 的边界 | 对 HarnessHub 的机会 |
|---|---|
| 只改配置、只转发流量，不执行任务，也不判断结果 | 执行平面：API 驱动的 Session/Run、权限、产物、结果判定、并行比较与评测 |
| 观测数据主要在内存（trace 保留 60 条），账本与历史写失败时吞掉错误 | 先提交后发布的事件存储，可重建、可导出、可接 OpenTelemetry |
| provider Key 明文存在 `providers.json`（0600），回环来源接受任意 token | 秘密进系统密钥库，按作用域签发 Gateway Key，可吊销、可归因 |
| 改写用户全局配置，没有差异预览；部分错误被静默吞掉 | 写前预览、备份、回读校验、一键还原，失败明确报告 |
| 单人维护（1066 个提交中 956 个来自同一作者），浏览器测试不进 CI，Windows CI 只编译 | 公开的维护模式与不可跳过的自动化门禁、三平台 CI 跑完整测试、公开的 Agent 兼容性矩阵 |
| 单机单用户为主，局域网共享是附加能力 | 本机、局域网、团队服务器、CI 四种形态共用一套代码 |
| 依赖复用订阅登录（部分路径存在被厂商封号的风险，Magpie 自己在 README 中提示） | 核心只走官方允许的认证方式，其余放进有风险标注的社区插件 |

**结论**：HarnessHub 在“管理模型与工具”上对齐 Magpie，在“运行、证据、安全、团队”上建立差异。目标用户不是“只想换模型的人”的全部，而是其中需要更进一步的人：要批量运行 Agent、要比较、要审计、要在团队里统一管理的人。

## 3. 目标用户与场景

| 用户 | 典型需求 | 主要使用面 |
|---|---|---|
| 多 Agent 个人开发者 | 让 Codex、Claude Code、Gemini CLI、OpenCode 统一改用某个模型；一处管理 Key；看每个 Agent 花了多少钱 | CLI、控制台 |
| Agent 工具与平台开发者 | 在自己的产品（IDE 插件、内部机器人、批处理）里调用多种 Agent，不想为每个 Agent 写一套集成 | REST/SSE API、SDK、MCP Server |
| 团队负责人、平台工程 | 统一采购 Key、按人或项目分配额度、审计调用、控制可用模型 | 团队服务器、控制台 |
| 评测与研究者 | 同一任务在多个 Agent × 模型组合上跑，按文件、测试或评判器打分，结果可复现 | `hh eval`、API |
| CI 用户 | 在流水线中让 Agent 修复失败测试、做代码评审，结果和证据随构建保存 | GitHub Action、CLI |

核心用户旅程（1.0 必须顺畅）：

1. **五分钟上手**：安装，执行 `hh init`，粘贴一个 Key，看到本机所有已安装的 Agent，执行 `hh use codex deepseek/deepseek-chat` 并确认差异，启动 Codex，在控制台看到这次调用。
2. **一次运行多个 Agent**：`hh run --agents codex,claude-code,opencode --model group/fast "修复 tests/foo 的失败"`，每个 Agent 使用独立的 git worktree，结束后给出各自的 diff、测试结果、用量和成本对比。
3. **嵌入自己的程序**：用 SDK 创建 Session、提交 Run、订阅事件、处理权限请求、下载产物。
4. **团队落地**：用 Docker 部署团队服务器，OIDC 登录，管理员配置 provider 与额度，成员本机的 `hh` 把团队服务器作为上游。

## 4. 与 Magpie 的功能对标矩阵

标记：**持平**＝1.0 达到同等能力；**超越**＝1.0 提供更强或 Magpie 没有的能力；**1.x**＝1.0 之后；**不做**＝有意不提供。

| 领域 | Magpie 能力 | HarnessHub 计划 | 说明 |
|---|---|---|---|
| Agent | 一屏列出本机 Agent 与当前模型 | 持平 | `hh ls` 与控制台首页 |
| Agent | 约 33 个 Agent 的配置改写 | 1.0 核心 12 个，1.x 达到 25 个以上 | Adapter 是声明式清单，社区可贡献；每个 Adapter 必须通过一致性测试才能标为稳定 |
| Agent | 外科式改写配置、原子写、stash 还原 | 超越 | 增加写前差异预览、备份清单、回读校验、`hh unwire` 一键还原 |
| Agent | 漂移检测（unwired/replaced/bypassed） | 超越 | 结合网关证据判定“已接线但请求没有到达网关” |
| Agent | 每个 Agent 可见的模型列表 | 持平 | |
| Agent | WSL 内的 Agent | 1.x | |
| Agent | 档案（Profile）快照与切换 | 持平 | Profile 也包含 Library 选择 |
| Provider | 72 个预设，自定义 provider | 1.0 至少 30 个预设 | 预设是数据文件，走 PR 贡献与校验 |
| Provider | Key 从不读环境变量 | 超越 | Key 进系统密钥库；配置只存引用；也可显式引用环境变量 |
| Provider | 复用 Claude/Codex/Copilot 等订阅登录 | 不做（核心） | 涉及厂商条款与封号风险；允许社区插件实现，并强制风险提示 |
| Provider | 运行 OpenCode provider 插件（Bun） | 1.x | 作为兼容插件提供 |
| Provider | 导入链接 `magpie://import` | 持平（方式不同） | `hh import <链接>` 与控制台粘贴预览，不注册系统 URL scheme |
| 网关 | Chat、Responses、Anthropic、Gemini、count_tokens、models | 持平 | |
| 网关 | 厂商原生协议直通 | 持平 | |
| 网关 | 协议内保活 | 持平 | 吸收上一轮发现的 Gemini 与 Codex 超时问题 |
| 网关 | 图片与视频生成端点 | 1.x | |
| 网关 | 局域网共享、命名网关 Key | 超越 | 每个 Key 有作用域、额度与过期时间 |
| 网关 | 级联到另一台 Magpie | 1.x | 以“上游为另一个 HarnessHub”的 provider 类型实现 |
| 路由 | 路由组 smart/order/rotate/usage，粘性 | 持平 | smart 依赖订阅额度信息，改为 latency 与 least-used |
| 路由 | 按意图分类的路由规则 | 1.x | 需要额外调用一个模型，默认关闭 |
| 路由 | 首字节前故障转移与有限重试 | 持平 | 重试判据与上限写入策略文档，每次尝试都有证据 |
| 模型 | models.dev 目录与厂商实时列表 | 持平 | 发行包内置目录快照，可离线使用 |
| 模型 | 价格、窗口、输出上限、wire 名覆盖并显示来源 | 持平 | |
| 模型 | 每个 API 的连通性测试 | 超越 | 能力体检：流式、工具往返、usage、推理回传、输出上限字段 |
| 用量 | 账本、CSV、按上游 Key 与调用方归因 | 超越 | 持久事件存储、OpenTelemetry 导出、团队版按用户与项目归因 |
| 会话 | 读取各 Agent 原生会话文件，恢复、删除到回收站 | 1.x | 1.0 只读列表 |
| Library | 指令、MCP、Skills 同步到各 Agent | 持平 | 内容寻址存储，变更可回滚 |
| Library | 在线市场与更新检查 | 1.x | 通过插件与 Library 注册表 |
| 备份 | 加密备份与恢复、WebDAV/S3 同步 | 1.0 导出与导入；同步 1.x | 导出默认不含秘密，可选口令加密 |
| 交互面 | 菜单栏 GUI（Wails）、TUI、CLI、Web、Docker | CLI、Web 控制台、Docker 持平；托盘 1.x；TUI 不做 | 交互式选择由 CLI 提供 |
| 分发 | 签名与公证、自动更新 | 超越 | 签名、SBOM、构建溯源证明；更新前校验签名并可回滚 |
| 遥测 | 每天一次匿名计数，默认开启 | 不做默认开启 | 只做显式同意的匿名统计 |
| — | 无 | 超越：执行平面 | Session/Run API、SDK、权限往返、产物、工作区隔离、并行比较、评测、MCP Server |
| — | 无 | 超越：团队服务器 | PostgreSQL、OIDC、RBAC、审计、额度 |

## 5. 版本范围

| 版本 | 主题 | 必须具备 |
|---|---|---|
| 0.1（M1 结束） | 模型平面可用 | 共享网关四协议、10 个以上 provider 预设、路由组、用量账本、`hh` CLI 基本命令、系统密钥库 |
| 0.2（M2 结束） | 对标 Magpie | 12 个核心 Adapter 的全局接线与还原、Profile、Library 同步、控制台 Agents/Providers/Usage 页 |
| 0.3（M3 结束） | 执行平面开源化 | API v1、TypeScript 与 Python SDK、MCP Server、worktree、并行运行、控制台 Runs 页 |
| 1.0（M4 结束） | 可依赖 | API 与配置格式稳定承诺、一致性测试与兼容矩阵、签名发布、文档站、安全审查完成 |
| 1.x | 扩展 | 团队服务器、托盘、插件注册表、评测、会话管理、局域网同步、更多 Adapter |

## 6. 非目标

- 托管服务：项目不运营 SaaS，所有数据留在用户自己的机器或服务器上。
- 替代 Agent 自身的界面：HarnessHub 不重做 Claude Code 或 Codex 的交互体验，只管理与运行它们。
- 训练、微调、模型托管。
- 在核心仓库内置违反厂商条款的订阅复用或逆向接口。
- 为单个厂商或单个比赛写硬编码分支：所有差异必须通过 Adapter、provider 预设或插件表达。

## 7. 成功指标

指标在 1.0 发布前由自动化测量，未测量的项不得写进发布说明。

| 类别 | 指标 | 1.0 目标 | 测量方式 |
|---|---|---|---|
| 上手 | 从安装到第一次网关调用的中位时间 | 不超过 5 分钟 | 可用性测试，至少 8 名首次使用者 |
| 兼容 | 核心 Adapter 在其固定版本上的一致性测试通过率 | 100% 稳定级，结果公开在兼容矩阵 | 夜间 CI |
| 网关性能 | 非流式请求的附加延迟 p99；流式首字节附加延迟 p99 | 不超过 10 ms；不超过 15 ms | 基准测试，假上游 |
| 资源 | 守护进程空闲常驻内存；冷启动到就绪 | 不超过 150 MB；不超过 1.5 s | 三平台基准 |
| 可靠性 | 网关调用证据完整率（客户端收到响应且账本有记录） | 100% | 一致性测试与故障注入 |
| 安全 | OpenSSF Scorecard 分数；已知高危漏洞修复时限 | 不低于 8；不超过 14 天 | Scorecard Action、安全响应记录 |
| 社区 | 首次贡献 PR 的首次响应时间中位数 | 不超过 3 个工作日 | GitHub 数据 |

## 8. 同类产品格局

数据于 2026-10-02 通过 GitHub API 与各项目 README、官网取得；Star 数只反映关注度，不代表质量。赛道分成三层，目前没有产品把它们合在一起：

| 层 | 代表项目 | 现状 |
|---|---|---|
| 模型层：每个 Agent 用什么模型 | [CC Switch](https://github.com/farion1231/cc-switch)（约 13.9 万 Star，Rust/Tauri）、[claude-code-router](https://github.com/musistudio/claude-code-router)（约 3.75 万，TypeScript）、[Magpie](https://github.com/yetone/magpie)（约 4.1 千，Go）、[LiteLLM](https://github.com/BerriAI/litellm)、[new-api](https://github.com/QuantumNous/new-api)、[Bifrost](https://github.com/maximhq/bifrost) | 高度拥挤且同质：本地端点、协议互转、故障转移、用量、MCP/Skills 同步几乎人人都有 |
| 执行层：让 Agent 去干活 | [OpenHands](https://github.com/OpenHands/OpenHands)（Agent Canvas，可运行任意 ACP Agent）、[sandbox-agent](https://github.com/rivet-dev/sandbox-agent)（统一 HTTP/SSE 与会话 schema）、[acpx](https://github.com/openclaw/acpx)（无头 ACP 客户端，HarnessHub 的现有依赖）、[OpenCode server](https://opencode.ai/docs/server/)、Claude Squad、Emdash、Conductor | 正在向 ACP 与结构化协议收敛；抓取终端界面的 [coder/agentapi](https://github.com/coder/agentapi) 已归档 |
| 观测层：花了多少、发生了什么 | [ccusage](https://github.com/ccusage/ccusage)、[Langfuse](https://github.com/langfuse/langfuse)、[OpenTelemetry GenAI 语义约定](https://github.com/open-telemetry/semantic-conventions-genai) | 规范仍处 Development 状态；工具各自读取引擎本地日志 |

格局对本提案的三点影响：

1. **模型平面做到对标即可，不拼规模。** 在预设数量、订阅复用和模型目录上与 CC Switch、claude-code-router 正面竞争收益低。模型平面按第 4 节达到与 Magpie 持平；目录数据直接使用开源的 [models.dev](https://github.com/anomalyco/models.dev)；LiteLLM、new-api、OpenRouter 乃至 Magpie 本身都可以作为 HarnessHub 的上游 provider。
2. **差异化投在空白处。** 现有产品都没有很好覆盖下面五项，它们是 HarnessHub 的主战场：
   - 基于证据的完成判定，即执行结束、模型调用证据、产物校验三者分开结算；
   - 把模型治理与任务执行合在一起，形成 Run 级账本，并能证明 Agent 没有绕过网关；
   - 公开的四协议（Chat、Responses、Messages、Gemini）互转一致性测试套件；
   - 同一任务、同一模型、不同 Agent 的日常比较；
   - 跨 Agent 统一的权限与秘密策略。
3. **依赖开放协议，适配层保持轻薄。** 这一领域的基础设施变化很快：Vibe Kanban 已停止运营，Daytona 开源仓库停止维护，Helicone 进入维护模式。驱动层只依赖 ACP、MCP、Agent Skills、AGENTS.md、OTel 这类开放规范；引擎原生控制面（Claude Code 的 stream-json、Codex App Server、OpenCode server）只作为 ACP 适配滞后时的补充。

最直接的竞争对手是 OpenHands Agent Canvas 与 sandbox-agent，而不是 Magpie。与它们相比，HarnessHub 的优势在于运行契约的严谨程度（先提交后发布、结果判定）、模型治理与证据，以及同时提供 Magpie 式的日常模型管理。
