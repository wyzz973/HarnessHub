---
name: harnesshub-company-gateway
description: 在公司内网继续开发 HarnessHub：架构与不变量、离线构建与检查、Windows 引擎排障、接入公司 GLM 网关、扩展办公工具包与发布；用于没有外网安装条件的 Windows 评测/开发机。
---

# HarnessHub 公司内网开发

本技能给在公司内网接手这套代码的 Agent。公司代码不能上传外网；一切修改、备份、日志与轨迹只留在公司批准的本地位置。

先核实现场：公司 checkout 的 HEAD 与未提交改动、实际构建入口、正在运行的进程，以及手上是哪种交付物（Release `competition-latest` 的免编译运行包，还是 `offline-dev-latest` 的源码+离线依赖开发包）。读 checkout 里的 `AGENTS.md`、`DESIGN.md`、`docs/handoff.md`，不要按本文件的转述替代仓库现状。

## 不能破坏的不变量

1. **所有引擎只使用统一模型**。来源优先级 `HARNESSHUB_MODEL*` > `state/harness-model.json` > 配置文件顶层 `model`，在每次引擎登记时强制生效；引擎自带的 API Key、登录、订阅一律不用，无法经统一模型驱动的适配器停用而不是降级。
2. **Gateway 不按引擎分支**。引擎差异属于 Driver 与配置适配层；第三方 SDK 类型止于 Driver，不进入公共 Session/Run 类型。`scripts/check-boundaries.mjs` 会检查。
3. **Worker 不写公共数据库**，只上报事件、权限请求与结果；Gateway 父进程是唯一逻辑写入者。
4. **秘密只在所属 Worker 解析**，数据库与配置快照保存引用；不得写进 argv、日志、测试证据或提交内容。
5. **不用清库、空会话 fallback、无依据重试或放宽断言掩盖失败**。未验证的能力如实标注。

## 代码地图（改之前先定位）

| 要改什么 | 去哪里 |
|---|---|
| 统一模型、协议转换、参数清理、推理回传 | `src/drivers/chat-completions/`（网关在 Worker 内，每 Session 一个环回端点），说明见 `docs/model-gateway.md` |
| 统一模型的来源与强制 | `src/application/harness-model.ts`、`src/domain/harness-model.ts`、`src/engine/` |
| 比赛接口 v1.1 | `src/gateway/competition/`，映射见 `docs/competition-api.md` |
| 引擎启动参数、原生配置、Skill 与 MCP 下发 | `src/drivers/configuration/prepare.ts`，发行包内引擎目录由 `scripts/prepare-engine-catalog.mjs` 生成 |
| 完全访问模式下各引擎的差异开关 | `src/distribution/full-access.ts` |
| 工具包导入、绑定、一键应用、预装 | `src/tool-packages/`、`src/preinstalled-tool-packs.ts` |
| 诊断日志与日志读取接口 | `src/logging/`、ACP 流量在 `src/drivers/acp/traffic-log.ts` |
| 发行包打包与比赛入口 | `scripts/build-competition-full-bundle.mjs`、`src/competition-bundle-main.ts` |
| 办公工具与 Skill | `packs/office-suite/`，工具源码 `scripts/office-suite/src/`，生成器 `scripts/build-office-suite.mjs` |

## 离线开发与检查

源码开发包解压后执行 `Setup-Competition-Offline.cmd` 完成依赖恢复、编译与比赛布局生成（全程禁网，任何下载尝试直接失败）。之后：

```powershell
pnpm build            # 改了 src 必须重建，比赛入口跑的是 dist
pnpm check            # 构建、lint、格式、模块边界、文档、API 文档同步、单元/集成/冒烟测试、前端构建
pnpm docs:api         # 改了 HTTP 接口后重新生成 API 文档，再 pnpm check:api
```

改 HTTP 接口、持久格式、配置或依赖时，同次更新使用方、迁移、测试与文档。关键变更要从正式 Gateway/Worker 入口验证，Mock 只替代外部依赖。

## 接公司 GLM 网关

只用环境变量配置，不写进文件：

```powershell
$env:HARNESSHUB_MODEL          = "GLM-V5_1-DX"
$env:HARNESSHUB_MODEL_BASE_URL = "http://<公司网关>/v1"    # 网关根，不含 /chat/completions
$env:HARNESSHUB_MODEL_API_KEY  = "<密钥>"
$env:HARNESSHUB_MODEL_CONTEXT_WINDOW  = "131072"          # Hermes 要求 ≥ 64000
$env:HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS = "8192"
```

先用 `POST /v1/harness/model/test`（请求体 `{}`）或控制台“模型”页的测试按钮确认链路，再跑任务。上游必须支持流式 Chat Completions。公司网关拒绝某个参数时，把参数名加进 `HARNESSHUB_MODEL_DROP_PARAMETERS`；拒绝回传推理内容时设 `HARNESSHUB_MODEL_REASONING=strip`；这两个开关不需要改代码。其余字段差异在协议边界加显式映射与脱敏的失败样例测试，**不要**把不支持的请求静默丢弃、回退到外部模型或伪造成功。

公司已有网关的鉴权、路由与模型映射要保留，合并方式见 [合并与离线开发](references/company-integration.md)，协议与验收细节见 [协议、工具与验收](references/adaptation-and-verification.md)。

## Windows 上排查引擎问题

先看日志，再猜原因。比赛布局的日志根是 `state\competition-data\`：

1. `logs\gateway.log` 找该 Run 的 `run.finish`、`worker.exit`，以及 `session.create` 行里的 `engineLog` 路径。
2. 打开对应 `backends\<sessionId>\diagnostics\engine.log`：`engine.stderr` 是引擎自己的报错，`acp.request`/`acp.response`（`ok:false`）是协议层，`acp.tool` 是工具调用状态，`model.call` 是模型网关与上游的结果。
3. 需要提示词与回答摘录时，启动前设 `HARNESSHUB_LOG_LEVEL=debug`。要把现场交给别人分析，运行 `Collect-Logs.cmd` 生成已脱敏的 ZIP。

已知并已修复的根因（再次出现说明用的不是本版本）：Run 期限 60 秒、缺 `PSModulePath` 导致每条 PowerShell 命令慢约 22 秒、Kimi 按 ANSI 代码页写 stdout 遇中文崩溃、Hermes 探测 Git Bash 时继承 ACP stdin 挂起、DSH 受限令牌拒绝启动外部程序、MiMo 不接受 `--yolo`、OpenClaw 冷启动超时。排障对照表见 `docs/handoff.md`。

仍然要按现场情况处理的限制：Gemini CLI 拦截含 `$()`、反引号或括号表达式的 PowerShell 单行命令（改写成 `.ps1` 文件执行）；引擎直接启动的应用会随会话的 kill-on-close Job 一起关闭（用办公工具包的 `cli_app_open` 经资源管理器代启动）；Kimi 每轮是独立进程，没有跨轮 shell 状态。

## 扩展

- **加引擎**：在引擎目录生成器中登记启动命令与环境，在 `prepare.ts` 写它的原生配置适配（统一模型必须落到它的 Provider 配置上），必要时在 `full-access.ts` 加完全访问开关，并补一条模拟模型的验收。
- **加工具/Skill**：优先做成工具包（`packs/<id>/` 内 `skills/`、`cli.json`、`mcp.json`），用 `POST /v1/tool-packs/import` 或 `Install-Tool-Pack.cmd` 应用到全部引擎；随包预装的机制见 `docs/capability-packs.md`。办公工具的源码改完要用 `scripts/build-office-suite.mjs` 重新生成并提交产物。
- **改办公 Skill 文字**：直接改 `packs/office-suite/skills/office-assistant/`，内容摘要变化后下次启动自动重新应用。

## 交付报告

列出：修改了哪些文件、保留了公司的哪些行为、实际执行的命令与结果、证据位置、未验证项。安装成功、进程退出码为 0 或 Agent 自称完成都不等于任务达标；本地 fixture 不能证明公司网关已通过。不要自行扩大公司模型预算。
