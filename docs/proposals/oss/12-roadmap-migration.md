# 12 路线图与迁移

状态：提案（草案），2026-10-02。迁移基线为 `feat/unified-model-gateway` 分支的 `324c9e8`。版本范围以 [01 产品定义](01-product.md#5-版本范围) 为准，目标包结构以 [02 系统架构](02-architecture.md#8-模块与依赖规则) 为准，工程门禁见 [10 工程体系](10-engineering.md)，治理见 [11 开源治理与社区](11-governance.md)。按 [ADR-P12](adr-drafts.md#adr-p12-仓库与历史)，开源版沿用 `wyzz973/HarnessHub`，`main` 改为从干净快照开始的孤立分支，旧历史保留在 `archive/competition` 分支与 `competition-final` 标签。选择从干净快照开始的理由：现有 221 个提交包含约 480 MB 第三方归档、比赛与公司材料、个人邮箱与多 Agent 工作分支的合并，逐个过滤并审查的成本与遗漏风险都高于从经审查的快照重新开始；证据链断开的代价由归档分支与验收记录摘要承担。

## 1. 现有模块去留

处置分四类：**保留**指逻辑基本不变，迁入新包；**重构**指保留核心逻辑，改变接口、归属或拆分方式；**替换**指由新实现取代；**移除**指不进入公开仓库，必要时留在归档分支。迁移以行为不变为前提：被保留的测试随代码迁移，断言不放宽，迁移前后的用例数在 M0 验收中对账。

| 现有位置 | 处置 | 开源版位置 | 理由 |
|---|---|---|---|
| `src/domain` | 重构 | `core` | 品牌 ID、错误、事件信封保留；“引擎”术语改为 Agent 与 Adapter；统一模型相关类型删除 |
| `src/storage` | 保留 | `store` | 事务、事件序号与幂等规则是运行契约的基础；抽出 Store 接口与一致性测试，为 Postgres（1.x）做准备 |
| `src/runtime`、`src/artifacts`、`src/rollout` | 保留 | `runtime` | Run 仲裁、队列、权限、期限、产物与 JSONL 导出沿用 |
| `src/application` | 重构 | `daemon` 与 `runtime` | 按三个平面拆分服务；统一模型服务 `harness-model.ts` 删除 |
| `src/gateway`（REST、SSE、API 目录、OpenAPI） | 重构 | `daemon` | 路径迁到 `/api/v1`；API 目录、OpenAPI 生成与新鲜度检查保留 |
| `src/gateway/competition` | 移除 | 归档分支 | 比赛接口规范 v1.1 专用 |
| `src/engine`（注册表、发现、可执行文件解析、管理器） | 重构 | `agents` | 发现规则与可执行文件解析保留；内置引擎表改为声明式 Adapter 清单；revision 机制留给隔离接线 |
| `src/engine/installation.ts` | 移除 | — | 开源版不安装、不分发 Agent；1.x 如有需要以插件提供 |
| `src/process`（Worker 宿主、Job Object、租约、清理结算） | 保留 | `runtime` | “先归属后执行”的 Worker 监督是已在 Windows 验证过的优势 |
| `src/worker` | 保留 | `daemon` 的 Worker 入口 | 事件上报沿用 generation 与序号去重 |
| `src/worker/outcome.ts` | 替换 | `runtime` 的证据规则表 | 修复“失败被判为 completed”，规则见 [05 第 4 节](05-run-plane.md#4-run-结果判定) |
| `src/drivers/acp`、`src/drivers/cli` | 保留 | `drivers` | ACP 与 CLI 驱动契约不变 |
| `src/drivers/fake` | 重构 | `tools/fake-agent` | 扩展为可脚本化的假 Agent（10 第 8 节） |
| `src/drivers/chat-completions` | 重构 | `gateway` | 四协议编解码与推理回填作为 IR 的入口和出口复用；每个 Session 一个私有网关改为守护进程内的共享网关；“只转 Chat Completions”与“严格企业网关”默认丢弃表改为 provider 预设中的兼容声明 |
| `src/drivers/configuration` | 重构 | `agents` | Session 私有配置生成成为隔离接线，按 Adapter 拆分 |
| `src/drivers/tool-command`、`src/tool-packages` | 重构 | `agents` 的 Library | 内容寻址存储、跨进程锁、路径校验保留；新增同步到用户 Agent 配置 |
| `src/benchmark` | 重构 | `runtime` 的评测 | `hh eval` 先以实验性提供，1.x 正式发布（01 第 5 节） |
| Workflow 自动规划（`src/application/workflows.ts` 及其存储） | 重构 | `runtime` 的 experimental 命名空间 | 不进入 1.0 API，是否保留由 M3 的使用数据决定（05 第 11 节） |
| `src/platform` | 保留 | 所属包的 `platform/` 子目录 | Windows ACL、文件锁按使用方归属 |
| `src/logging` | 重构 | `daemon` | 统一脱敏规则，接入 OpenTelemetry；`hh debug bundle` 取代 Collect-Logs |
| `src/distribution`、`src/preinstalled-tool-packs.ts` | 移除 | — | 便携包清单与预装工具包机制 |
| `src/main.ts`、`src/cli.ts` | 重构 | `daemon`、`cli` | 成为 `hh serve` 与 `hh` 子命令 |
| 其他入口（`competition-bundle-main.ts`、`release-main.ts`、`collect-logs-main.ts`、`tool-packages-oneclick-main.ts`） | 移除 | — | 对应功能由 `hh` 子命令提供；`benchmark-main.ts`、`tool-packages-main.ts` 并入 `hh eval` 与 `hh library` |
| `scripts/native`（Keychain、DPAPI、Job Object、ACL 辅助程序） | 保留 | `secrets/native`、`runtime/native` | Linux Secret Service 后端为新增 |
| `web/`（Next.js 控制台） | 替换 | `console`（React + Vite） | [ADR-P10](adr-drafts.md#adr-p10-控制台改为内嵌静态单页)；shadcn/ui、assistant-ui 组件与展示逻辑按需复用 |
| `scripts/check-*`（边界、文档、运行时、API 文档）及其测试 | 保留 | `tools/` | 按包结构扩展，拒绝样例一并迁移 |
| `scripts/mock-company-model.mjs`、`scripts/lib/strict-chat.mjs`、`scripts/strict-chat-proxy.mjs` | 重构 | `tools/fake-provider` | 扩展为四协议，增加白名单模式（10 第 3.4 节）；严格代理不移植，对真实 provider 的检验由 M1 一致性套件的在线抽样承担（已在 OSS-009 实现，见 [ADR 0017 补充](../../decisions/0017-package-layout-migration.md#补充假-provider-取代模拟上游与严格代理oss-0092026-10-02)） |
| 比赛与离线交付脚本（`competition-*`、`prepare-*`、`package-bundle.mjs`、`offline-development.mjs`、`vendor-engine-sources.mjs`、`launch-*.mjs`、`archive-offline.py`、`*.ps1` 等） | 移除 | 归档分支 | 只服务于 Windows 离线比赛包 |
| `tests/`（单元 42、集成 48、smoke 3 个文件，约 2.8 万行） | 保留 | 各包 `test/` 与顶层 `tests/` | 比赛、统一模型与便携包的用例随模块删除，其余全部迁移 |
| `engines/*.example*` | 替换 | Adapter 清单 | |
| `examples/` | 重构 | `examples/` | `http-lifecycle.mjs` 改为 SDK 示例；`competition-tasks` 删除；工具包示例改为 Library 示例 |
| `packs/office-suite`、`scripts/office-suite` | 移除 | 独立仓库 | 见下文 |
| `skills/harnesshub-company-gateway` | 移除 | 归档分支 | 公司交接专用 |
| `vendor/engine-sources`、`distribution/` | 移除 | — | 第三方源码归档与发行配置，见 [11 第 1 节](11-governance.md#1-许可证) |
| `.github/workflows/ci.yml` | 重构 | 10 第 4 节 | 增加 macOS；其余 5 个比赛与离线发布工作流移除 |
| `DESIGN.md`、`docs/` | 重构 | `docs/` 与 `docs-site/` | DESIGN 按 02 重写；比赛、公司、便携包相关文档移除；ADR 0011–0013、0015 标为 superseded，正文去掉公司信息；验收记录留在归档分支，新 `main` 只引用结论摘要 |
| `TODO.md`、`CHANGELOG.md` | 替换 | GitHub Issues 与 Projects；changesets | 比赛版变更记录移入归档分支 |
| `patches/acpx@0.13.2.patch` | 保留 | 根目录 `patches/` | 向上游提交，合入后删除 |

**比赛与公司专属部分的处置**：

- **比赛接口**（`src/gateway/competition`、比赛接口文档、比赛任务测试）：从开源版移除。仓库在 `324c9e8` 打标签 `competition-final`，旧历史保留在 `archive/competition` 分支，保留可复现的最终状态。
- **Windows 便携包**（约 1.8 GB，含 10 个引擎、固定 Node、Python 组件与 PortableGit）：由各平台的单可执行文件与包管理器渠道取代，不再捆绑任何 Agent。“全新机器可运行”的要求转化为发布流水线中的干净容器与虚拟机安装验收（10 第 4.3 节）。已发布的 `competition-latest`、`offline-dev-latest` 等 Release 原样保留在仓库中，不再更新。
- **公司交接**（`docs/handoff.md`、`skills/harnesshub-company-gateway`、`distribution/company-chat.json`、ADR 0011 与 0012 中的公司部分）：移除。公开仓库中不出现公司名称、内部网关名与现场环境信息。
- **预装办公包**：移到独立仓库，作为可选的 Library 包发布，标明只支持 Windows；不再预装，ADR 0015 的预装机制标为 superseded。
- **统一单模型约束**：不再是硬约束。需要“所有 Agent 只用一个模型”的用户，用 Profile 的默认模型加 Gateway Key 的模型白名单表达（[ADR-P03](adr-drafts.md#adr-p03-共享网关与作用域-gateway-key)）。`HARNESSHUB_MODEL*` 环境变量与 `harness-model.json` 删除。
- **数据迁移**：开源版的 `store` schema 从版本 1 开始，不把旧数据库纳入迁移链；从 0.1 起执行 [07 第 2.2 节](07-data-security.md#22-只进不退的版本化迁移) 的规则。现有数据目录由一次性导入命令 `hh migrate import --from <旧数据目录>`（[06 第 5 节](06-interfaces.md#5-cli)）处理：只读打开旧数据目录，`--dry-run` 只输出导入计划，导入完成后写入记录了来源路径与哈希的标记，重复执行不会重复导入。导入范围随里程碑交付：M1 导入统一模型配置（转为一个 custom provider 与 `group/default`，见 03 第 10 节）与秘密引用；M2 导入引擎登记与工具包绑定（转为 Adapter 的 `run` 段、Profile 与 Library 选择，见 04 第 10 节）；M3 导入 Session、Run、事件与产物（保留原终态，见 05 第 11 节）。秘密引用的迁移方法：`env` 引用原样保留；旧 `keychain` 引用（macOS 钥匙串条目，或 Windows 当前用户 LocalAppData 下的 DPAPI 文件）经旧后端读出值，写入新的 `store` 引用，映射关系写入导入报告；旧条目不删除，导入报告列出每个旧条目的位置，由用户核对后自行删除；指向 `HARNESSHUB_*` 的 MCP 秘密引用不迁移，只列出并要求改用独立凭据。

## 2. 里程碑

里程碑按顺序推进，不做工时与日期估算（所有者于 2026-10-02 决定，开发与维护全程由 AI 维护者负责）。每个里程碑以下列验收标准判定完成，验收从正式入口执行，子任务各自通过不能代替组合验收。

| 里程碑 | 版本 | 主题 |
|---|---|---|
| M0 | 无公开版本 | 开源准备与重构 |
| M1 | 0.1 | 模型平面 |
| M2 | 0.2 | 对标 Magpie 的 Agent 平面 |
| M3 | 0.3 | 执行平面开源化 |
| M4 | 1.0 | 加固 |
| M5 | 1.x | 团队与生态（滚动） |

### M0 开源准备与重构

交付：MIT 许可证与权属记录（[11 第 1 节](11-governance.md#1-许可证)，权属已于 2026-10-02 确认）；按第 1 节去留表在新的 `main` 中建立 pnpm workspace，代码迁入 12 个包，行为不变；包级边界检查；测试启动器与沙箱；三平台 CI；单可执行文件可行性验证（[ADR-P01](adr-drafts.md#adr-p01-语言与运行时)）；假 Agent 与假 provider；治理文件（11 第 8 节中阶段为 M0 的全部文件）；第 3 节中阶段为 M0 的先行修复；开源转型、许可证、仓库与历史、品牌四份 ADR。

验收标准：

- 从全新克隆执行 `pnpm install --frozen-lockfile` 与 `pnpm check`，在 Linux x64、macOS arm64、Windows x64 上通过。
- 迁移后保留的用例数与迁移清单逐项对账，差额都有删除理由（随比赛、统一模型或便携包移除）。
- 新 `main` 的全部历史经 gitleaks 与 trufflehog 扫描，无已验证的秘密；`.git` 目录不超过 50 MB。
- 边界检查对每条依赖规则的拒绝样例返回非零。
- 单可执行文件在 macOS arm64 与 x64、Linux x64 与 arm64、Windows x64 上构建成功；记录体积与冷启动 p50/p95，并跑通 `hh serve` 加一次假上游调用；按 ADR-P01 的重新评估条件给出结论。
- Scorecard 基线分数已记录。

### M1 模型平面（0.1）

交付：守护进程内的共享网关，支持四协议、`/v1/models` 与 count_tokens，IR 互转与原生透传；Gateway Key 及其作用域、模型白名单、额度与吊销；至少 10 个 provider 预设；路由组（order、rotate、least-used、latency）与粘性，首字节前故障转移；离线目录快照；用量与成本账本（`model.call` 证据）；秘密后端（macOS 钥匙串、Windows DPAPI、Linux Secret Service 与加密文件，见 [07 第 4 节](07-data-security.md#4-秘密管理)）；`hh migrate import` 的第一部分（第 1 节）；与模型平面相关的 `hh` 命令（`init`、`serve`、`status`、`doctor`、`version`、`provider`、`credential`、`model`、`group`、`key`、`catalog`、`usage`，命令树见 06 第 5 节）；能力体检；协议一致性套件（离线）与第一版语料；发布流水线与 0.1.0 首次发布（签名、SBOM、构建溯源、构建身份）；第 3 节中阶段为 M1 的先行修复。

验收标准：

- 4×4 协议矩阵与原生透传在官方 SDK 客户端下 100% 通过。
- 10 个以上预设通过 schema 与回放测试，其中至少 5 个有带日期的在线能力体检记录，其余标为“未实测”。
- 故障注入下网关调用证据完整率为 100%（01 第 7 节的口径）。
- [ADR-P03](adr-drafts.md#adr-p03-共享网关与作用域-gateway-key) 规定的五种 Key 拒绝与 [ADR-P05](adr-drafts.md#adr-p05-路由重试与故障转移) 规定的五个重试场景都有通过的用例。
- 扫描数据目录与日志，找不到任何 provider 秘密的明文。
- 网关附加延迟、空闲内存与冷启动进入夜间基准并记录基线；此时不作为门槛。
- 0.1.0 经 10 第 4.3 节的完整流水线发布，并通过各渠道的安装验收。

### M2 对标 Magpie 的 Agent 平面（0.2）

交付：Adapter 清单 schema 与注册表；12 个核心 Adapter（名单与入选标准见 [04 第 2 节](04-agent-plane.md#2-核心-adapter-范围)，M0 时按 Star 与下载量复核一次）；全局接线的预览、备份、原子写入、回读校验与 `hh unwire`；结合网关证据的漂移检测；隔离接线；JSONC、YAML、TOML 的格式保真编辑器；Profile；Library 同步；React + Vite 控制台的 Agents、Providers、Usage 页；浏览器测试进入必需检查；Adapter 一致性套件（离线与夜间在线）；兼容矩阵初版。

验收标准：

- 12 个 Adapter 在固定版本、在各自支持的平台上通过稳定级一致性测试。
- 在真实安装与黄金文件上，接线后还原的配置文件都与接线前逐字节一致。
- 配置编辑器的属性测试在夜间各运行 10⁵ 例，无失败。
- 浏览器测试覆盖 10 第 3.6 节的接线与用量旅程。
- 3 名内部测试者完成 01 的旅程 1，中位时间不超过 5 分钟（8 名外部用户的测试在 M4 进行）。

### M3 执行平面开源化（0.3）

交付：API v1（`/api/v1`）上的 Session 与 Run，模型请求使用 Session 作用域的 Key 经共享网关；基于证据规则表的结果判定；git worktree 工作区与清理策略；`hh run --agents` 多 Agent 并行运行与比较；TypeScript SDK 与 Python SDK；MCP Server；控制台 Runs 页；JSONL 与 OpenTelemetry 导出；winget 渠道。

验收标准：

- [测试要求](../../testing.md#第一条执行链路) 列出的全部关键路径在三平台的集成层通过。
- “零调用但有输出”“最后一次主调用失败”“Agent 断开”“流完整性异常”四类判定各有 Fails-without 用例。
- SDK 示例在 CI 中对构建产物运行通过。
- MCP Server 至少由 2 种 MCP 客户端调用通过。
- 3 个 Agent 在独立 worktree 中并行运行，没有交叉写入，结束后无残留进程。
- 在 Windows 原生环境中通过 Job Object 的清理验证。

### M4 1.0 加固

交付：API、配置与插件协议冻结（API 报告与 OpenAPI 兼容检查成为门槛）；公开兼容矩阵；全部分发渠道签名发布，包括 deb/rpm；文档站完成，含英文与中文；安全审查与威胁模型复核；性能达到目标；从 0.3 升级到 1.0 的测试；局域网共享；GitHub Action；不含秘密的导出与导入；可用性测试；OpenSSF Best Practices 徽章（passing）。

验收标准：

- 01 第 7 节的全部指标由自动化或可用性测试测得并达标，包括至少 8 名首次使用者参与的上手测试。
- 没有打开的 p0 与 p1 问题。
- 连续 2 个 beta 版本没有破坏性变更。
- Scorecard 不低于 8。
- 完成一次由非创始人主持的发布演练。
- 满足 [11 第 3 节](11-governance.md#3-治理模型) 中 1.0 的维护者目标；未达成的项写进 1.0 发布说明。

### M5 1.x 团队与生态

按次版本滚动交付，每项先过 RFC：团队服务器（PostgreSQL、OIDC、RBAC、审计、额度），桌面托盘，插件注册表，`hh eval` 评测，会话管理，局域网同步，Adapter 扩充到 25 个以上，图片与视频生成端点，级联到另一个 HarnessHub，WSL 内的 Agent，签名的 apt/yum 仓库。代表性验收：Postgres Store 通过与 SQLite 相同的 Store 一致性测试；多租户隔离测试证明跨租户读写全部被拒绝；兼容矩阵列出 25 个以上 Adapter 的结果。

## 3. 先行修复

下表列出上一轮核验发现中，在开源版仍然适用、应在 M0 或 M1 修复的项。每项按 [10 第 2 节](10-engineering.md#2-代码规范) 的要求附 Fails-without 用例；Windows 相关项需要 Windows 原生证据。

| 编号 | 问题（上一轮的发现） | 开源版位置 | 阶段 |
|---|---|---|---|
| F01 | 测试继承开发者 shell 的产品变量，32–58 个集成用例假失败，并有请求带着开发者的 Key 发往上游 | `tools/test-runner` | M0 |
| F02 | 集成测试在启动成功之后才登记清理，启动失败时临时目录泄漏；句柄未关导致测试文件不退出；没有默认超时 | `tools/test-runner`、`tests/` | M0 |
| F03 | 发布先于验收：先替换 latest，再运行矩阵，矩阵失败也不回退；两个分支向同一 tag 并发发布 | 发布工作流 | M0 |
| F04 | 包内没有构建身份，现场无法回答“正在运行哪个提交” | `build-info.json` | M0 |
| F05 | 第二次启动在取得所有权之前改写运行中实例的配置；所有权只看 PID 是否存活，PID 复用后无法启动 | `daemon` 单实例锁 | M0 |
| F06 | Windows 上 Worker 环境白名单缺 ProgramFiles、ProgramData、ALLUSERSPROFILE 等系统变量 | `runtime` 的 Worker 环境 | M0 |
| F07 | POSIX 上用 setsid 自建会话的后代逃出 Worker 进程组，清理状态仍报 confirmed | `runtime` 进程监督 | M0 |
| F08 | 子进程创建没有收口到一个封装，无法静态保证归属登记 | `runtime` 与 ESLint 规则 | M0 |
| F09 | SSE 响应头不 flush（Gemini 因 60 s 头部超时反复重发）；没有协议内保活（Codex 空闲超时） | 先在现有 `src/drivers/chat-completions` 上修复（03 第 10 节），随迁移带入 `gateway` | M0 |
| F10 | Gemini 流内错误写成 `data: {"error":…}`，SDK 不识别，最终以退出码 0 输出重复的半截文本 | `gateway` | M1 |
| F11 | 非流式入站请求被完整缓冲，长时间的非流式调用超过 Agent 的超时 | `gateway` | M1 |
| F12 | 转换路径不请求 `include_usage`，上游不返回 usage 时 Agent 不会主动压缩上下文 | `gateway` | M1 |
| F13 | 429 与限速措辞被判为上下文超长，部分厂商的超长措辞又识别不到 | `gateway` 错误分类 | M1 |
| F14 | 上下文窗口与输出上限没有单一生效值，两层校验口径不一致；网关不为未发送输出上限的 Agent 补写 | `gateway` 目录 | M1 |
| F15 | 8 MiB 入站上限早于媒体处理生效；上游上限按原始 SSE 字节计 | `gateway` | M1 |
| F16 | 流完整性：没有有效 choice 的 2xx、HTML 响应、异常结束原因、只有 index≠0 的 choice 被记为成功 | `gateway` | M1 |
| F17 | 基址误填 `/chat/completions` 后所有调用 404，错误中看不到实际请求的地址 | `gateway` provider 校验 | M1 |
| F18 | 422 校验错误丢失 pydantic 的 `loc`，看不出是哪个字段 | `gateway` 错误映射 | M1 |
| F19 | Retry-After 丢失，Agent 在限流窗口内耗尽重试 | `gateway` 路由（按 ADR-P05 设上限） | M1 |
| F20 | 企业私有 CA 无法生效（`NODE_EXTRA_CA_CERTS` 被丢弃） | `daemon` 网络配置 | M1 |
| F21 | Codex 下所有 MCP 工具名变成 `hh_<32hex>`，模型无法按名称理解 | `gateway` 工具名映射 | M1 |
| F22 | 推理缓存的 LRU 逐出仍被引用的条目；相同文本的键互相冲突 | `gateway` 推理回填 | M1 |
| F23 | 本地拒绝显示为上游 401；路由层拒绝的请求不留调用记录；缺少应答模型、上游 request-id 与分段时延 | `gateway` 账本 | M1 |
| F24 | 零单价被当成“估算 0”，未知与零无法区分；Agent 回报的 token 只含最后一次调用 | `gateway` 账本 | M1 |
| F25 | 日志先序列化后脱敏，会吞掉 `\"` 中的反斜杠，使整条记录丢失；两套脱敏规则不一致 | `daemon` 日志 | M1 |
| F26 | 绑定非回环地址时配置接口对网络开放，并接受 DNS rebinding 形态的请求 | `daemon` 鉴权（[07 第 5 节](07-data-security.md#5-认证与授权)） | M1 |
| F27 | 上游 Key 可经 MCP 秘密引用流向 Agent 与任意 MCP 地址 | `secrets` 引用规则（[07 第 4.6 节](07-data-security.md#46-禁止把-harnesshub-自身凭据作为工具秘密)；M1 定义，M2 的 Library 执行） | M1 |
| F28 | 观测查询阻塞事件循环约 0.5 s（100 个 Run、每个 5000 条事件） | `store` 索引与分页 | M1 |

**带入后续里程碑**：Run 结果误判（零调用但有输出、最后一次主调用失败、引擎断开）在 M3 随证据规则表修复；工作区 `.codex/config.toml` 与机器级托管配置覆盖隔离接线、Pi 看不到 MCP 工具错误详情、Kimi 提示词改走 stdin、远程 MCP 传输按 Agent 检查，在 M2 随对应 Adapter 修复；CLI 驱动等待后代关闭管道才结算、Session 数据没有清理入口，在 M3 修复；控制台没有浏览器测试，在 M2 随控制台重写解决。

**不再适用**：比赛接口的 204 映射、比赛入口的 CLI 冲突检查读错数据目录、发行包中 Kimi 写死 1M 窗口（并入 F14）、办公包的 Windows 环境依赖（随办公包移出）、硬编码运行号的 `competition-release.yml`、需要现场采集的公司网关数据（由 M1 的能力体检取代）。

## 4. 风险与缓解

| 风险 | 早期信号 | 缓解 | 决策点 |
|---|---|---|---|
| Node 单文件打包不可行：原生辅助程序内嵌、`node:sqlite`、macOS 公证、体积与冷启动 | M0 验证中冷启动 p95 超过 1.5 s，或体积超过 150 MB | 启用 SEA 的 code cache 与启动快照；控制台资源压缩后内嵌；原生辅助程序作为带哈希的资源；退路是“npm 包 + 随附固定 Node 的目录发行” | M0 结束，按 ADR-P01 的条件决定是否重新评估语言 |
| Adapter 随上游 Agent 版本漂移：主流 Agent 每周发布多次 | 夜间“上游漂移”任务失败率上升 | 固定版本加夜间漂移任务；Adapter 声明已验证的版本范围；未验证的版本只警告、不阻断；只改清单的修复可以在补丁版本中发布；每个 Adapter 有维护人；1.x 评估签名的 Adapter 清单单独更新通道（需 RFC） | 每月复核兼容矩阵，连续 2 个月无人维护的 Adapter 降为实验级 |
| 厂商条款：部分 Agent 或模型服务限制第三方网关、订阅复用或配置改写 | 厂商条款变更，或收到厂商联系 | 核心只使用官方允许的认证方式（ADR-P09）；M2 开始前对 12 个核心 Agent 的条款做一次书面审阅，结论写进 Adapter 清单的条款说明；收到厂商要求时 7 天内处理；不使用厂商 logo | M2 开始前 |
| AI 维护的连续性与质量：开发与维护全部由 AI 维护者在多次会话中完成，上下文不连续，可能引入回归或文档漂移 | 回归缺陷数、文档与代码不一致的报告、门禁被绕过的记录 | 设计文档、ADR、TODO 与发布手册是每次会话的唯一依据；每个行为变更都有“无此改动必失败”的测试；编写与审查使用不同会话；必需检查不可跳过；控制范围，不追求 Magpie 的 Agent 数量；维护状况写进每个版本的发布说明 | 每个里程碑结束时复核，回归增多就收缩下一阶段范围 |
| 性能目标：网关附加延迟 p99 不超过 10/15 ms，空闲内存不超过 150 MB，冷启动不超过 1.5 s | M1 起的夜间基准相对目标的差距 | 透传路径不重新序列化每个流块；IR 转换流式进行，不缓冲；从 M1 起跟踪性能预算；必要时把热路径改为原生透传 | M3 结束时差距仍超过 50%，按 ADR-P01 的条件重新评估 |
| 历史中的秘密与内部信息（权属已于 2026-10-02 由所有者确认） | 秘密扫描命中或人工审查发现内部信息 | 第 6 节检查清单；新 `main` 从干净快照开始 | M0 公开之前 |
| 全局接线损坏用户配置，导致信任受损 | 涉及还原失败的 issue | 五步写入、属性测试、逐字节还原测试；新 Adapter 先以 beta 级发布；`hh unwire --all` 与备份清单 | 任何一例无法还原的报告都按 p0 处理 |
| Linux 无图形会话或容器中没有 Secret Service | 用户报告无法保存 Key | 显式选择加密文件后端（07 第 4.2 节），或显式引用环境变量；默认后端不可用时明确失败，绝不静默回退 | M1 |
| 供应链投毒 | 依赖审查告警 | 10 第 7 节：最短发布时长、锁文件、禁止生命周期脚本、签名与溯源 | 持续 |
| 控制台重写的工作量被低估 | M2 中期页面完成度落后于计划 | 复用组件与展示逻辑；浏览器测试先行；托盘、会话管理等页面推到 1.x | M2 中期评审 |

## 5. 维护模式与工作方式

开发与维护全程由 AI 维护者负责，所有者保留否决与最终决定权（[11 第 3 节](11-governance.md#3-治理模型)）。工作方式：

1. 每次会话开始先读本提案、对应 ADR 与 TODO，确认当前里程碑与未完成项；结束时更新 TODO 中的状态与证据，未验证不勾选。
2. 跨包契约（Store 接口、IPC、Gateway Key 作用域、Adapter 清单 schema、API v1）先定稿并写入 ADR 或 schema，再围绕固定版本开发；可并行的独立包由子 Agent 在独立 worktree 中开发，主会话负责集成与组合验收，沿用 [开发规范](../../development.md#git-与多-agent-协作)。
3. 编写与审查分离：每个非琐碎 PR 由另一个只读审查会话给出结论；安全敏感路径另做一次安全审查。
4. 需要所有者介入的事项只有：账户与凭据（GitHub、npm、域名、代码签名证书）、治理与许可证变更、安全公告的最终发布，以及推翻已采纳的 ADR。这些事项在 TODO 中单独列出，并在会话结束时报告。
5. 社区贡献从 M1 开始接受：provider 预设与 Adapter 是最适合外部贡献的入口。

## 6. 开源前检查清单

公开前由两名维护者逐项签字，结果记入 M0 的验收记录。

**秘密**

- [ ] 现有仓库的全部 ref（含 `worktree-agent-*` 分支与 `competition-latest`、`offline-dev-latest` 等标签）经 gitleaks 与 trufflehog 全历史扫描。即使新 `main` 不带旧历史，扫描到的真实凭据也一律吊销或轮换。
- [ ] 新 `main` 的初始快照与之后全部提交扫描结果为零；开启秘密扫描与推送保护。
- [ ] 测试夹具、语料与示例中的凭据都是金丝雀值或明显的占位符。
- [ ] 远端已存在 `archive/competition` 分支与 `competition-final` 标签，再强制推送新的 `main`；已发布的比赛版 Release 仍可下载。

**许可证**

- [x] 权属确认：所有者于 2026-10-02 确认全部自有代码的权利归其所有（11 第 1 节），记入许可证 ADR。
- [ ] 添加 MIT `LICENSE` 与 `SPDX-License-Identifier: MIT` 文件头，CI 检查通过。
- [ ] `vendor/engine-sources`、`distribution/vendor-notices`、办公包与修改第三方二进制的脚本不在新 `main` 中。
- [ ] 保留的第三方代码（shadcn/ui、AI Elements、Codex 提示词、acpx 补丁）附原许可与 NOTICE。
- [ ] 依赖许可证白名单检查通过；models.dev 快照的条款已核查。

**内部信息**

- [ ] 全文检索“公司”“company”、内部网关与模型名（如 `GLM-V5_1-DX`）、比赛规范编号、内部运行号、私有仓库链接，确认无残留。
- [ ] 删除或改写比赛与公司相关的文档、ADR 正文、验收记录、CHANGELOG 条目与 `skills/harnesshub-company-gateway`。
- [ ] 删除开发机绝对路径（如 `/Users/<name>/`）、主机名与本机运行数据。
- [ ] 根目录两份中文调研稿经审阅后移入 `docs/history/`，或留在归档分支。
- [ ] 用 `.mailmap` 统一提交署名；决定是否以 noreply 地址替代个人邮箱。
- [ ] 重写 `AGENTS.md`，去掉比赛与 Windows 专用规则。

**品牌**

- [ ] 完成商标与命令名冲突检索（11 第 7 节），确定名称或启用备选名。
- [ ] GitHub 组织、npm 组织、PyPI 项目名、容器命名空间、域名与 Discord 已注册，并由至少 2 人持有。
- [ ] README 写明与各 Agent 厂商没有隶属或背书关系；仓库中没有厂商 logo。
- [ ] `TRADEMARKS.md` 与品牌资产就位。

**工程与社区**

- [ ] M0 的验收标准全部满足（第 2 节）。
- [ ] 分支保护、merge queue、必需检查 `ci-ok`、DCO 检查、CODEOWNERS 已启用；组织强制 2FA。
- [ ] 私有漏洞报告已开启，`SECURITY.md` 中的联系方式经实测可以送达。
- [ ] Issue 模板与标签已同步；至少 10 个 good first issue 附导师。
- [ ] 路线图看板与 M0–M5 一致；公开公告说明项目状态为 pre-1.0。
