# HarnessHub

**开源的编码 Agent 控制平面。** 让任意 Agent 使用任意模型，通过一套 API 无人值守地运行它们，并保留每一次模型调用的证据。

[English](README.md) · [设计](docs/proposals/oss/README.md) · [路线图](ROADMAP.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

> **状态：预发布（里程碑 M0，开源重置阶段）。** 目前没有正式发布的版本，只能从源码运行，0.1 之前接口还会变化。各里程碑的交付见 [路线图](docs/proposals/oss/12-roadmap-migration.md)。

## 它是什么

开发者越来越多地同时使用多个编码 Agent，例如 Claude Code、Codex、Gemini CLI、OpenCode、Qwen Code。HarnessHub 在一个地方管理它们：

- **模型平面**：本地网关同时支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Gemini 协议，让每个 Agent 都能使用你选择的模型。
- **Agent 平面**：原地编辑本机编码 Agent 自己的配置，把它们接到网关（预览、备份、漂移检测与还原），并把指令、Skills 与 MCP 服务同步给它们。
- **执行平面**：通过 REST + SSE API 无人值守地运行 Agent，提供 Session、Run、权限往返、期限、取消、文件产物和持久事件日志。

[产品定义](docs/proposals/oss/01-product.md) 把 HarnessHub 与 [Magpie](https://github.com/yetone/magpie) 及同类项目做了逐项比较。最主要的区别：HarnessHub 会运行 Agent 并记录可核对的证据，而不只是切换它们的配置。

## 与 Magpie 的关系

HarnessHub 的模型平面与 Agent 平面用 TypeScript 重新实现了 yetone 的 [Magpie](https://github.com/yetone/magpie)（MIT，Go）的能力，逐项对照 Magpie 提交 `2e340f7` 的源码，并在其上加入执行平面与证据链。感谢 Magpie 项目提供的设计与对每个 Agent 的逐字段了解。

- **已覆盖**：网关的四种协议、直通与转换、路由、重试与路由组；Magpie 51 个 provider 预设中的 48 个（[取自 Magpie](THIRD_PARTY_NOTICES.md)，保留其 MIT 声明）；Magpie 35 个 Agent 中 27 个的全局接线（另有 Qwen Code），每个都依照 Magpie 对该 Agent 的写法；Profile、每个 Agent 的模型清单、终端界面、订阅账号（ChatGPT 与 Copilot）、局域网共享、备份与同步。
- **有意不同**：每个 Agent 有自己的 Gateway Key（Magpie 的回环网关接受任意令牌）；用户改过的文件按漂移报告，而不是被重写。
- **未覆盖**：Magpie 只切换其自带模型的 Agent（Goose、Cursor、Copilot CLI、Devin），以及 Antigravity CLI、OpenHanako、Alma 与 Cindy（[原因](docs/global-wiring.md)）；WSL 中的 Agent；Magpie 的桌面应用（HarnessHub 提供 Web 控制台与 `hh tui`）。

HarnessHub 自己的代码使用 MIT 许可证；取自其他项目的代码与数据保留原许可证，列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 目前已有的能力

现有代码来自 HarnessHub 早期的单模型版本，正在按里程碑逐步重构。今天已经提供：

| 领域 | 现有行为 |
|---|---|
| 执行 | SQLite 中的持久 Session 与 Run，同一 Session 串行；SSE 从已提交事件重放；幂等提交；期限与取消；权限请求；声明的输出文件采集为不可变产物；JSONL 导出 |
| Agent | 28 个 Agent 的全局接线（`hh init`、`hh wire`、`hh tui` 与控制台的 Agent 页）：每个 Agent 在自己的配置文件中拿到只属于它的 Gateway Key，有预览、备份、漂移检测与还原（[全局接线](docs/global-wiring.md)）；无人值守运行使用 ACP 与 CLI 驱动，每个 Session 使用私有配置 |
| 模型网关 | 守护进程端口上的共享网关，供任意 OpenAI、Anthropic 或 Gemini 客户端与无人值守的 Run 使用：从预设或手动添加 provider、路由组、带模型白名单的 Gateway Key、直通原生端点或在四种协议之间转换，以及记录用量与费用的 `model.call` 账本 |
| 工具 | 工具包，含 Skills、MCP 服务与 CLI 工具，按内容哈希存储，按 Agent 绑定 |
| 进程监督 | 每个 Session 一个 Worker 进程；POSIX 用进程组，Windows 用 Job Object；重启后恢复 |
| 控制台 | 由守护进程在同一端口提供的 Web 控制台（React + Vite）：Agent、Provider、订阅账号、路由与 Key、用量、Profile、Library 与设置，以及无人值守运行用的任务、引擎、工具与观测页面；用 `hh console` 生成的一次性链接登录，浏览器拿不到管理令牌 |

`hh` 的单可执行文件构建（`pnpm test:sea`）可在 macOS arm64 上运行；其他平台尚未构建，也还没有发布版本。本机网关的用法见 [快速上手](docs/quickstart.md)。

## 从源码快速开始

前置条件：Git、Node.js 24.20.0、pnpm 10.12.3。仓库的 `.node-version` 写明了 Node 版本，读取它的版本管理器（fnm、nodenv、Volta）会自动选用；用其他版本的 Node 时 pnpm 提示“Unsupported engine”。Node 24 自带 Corepack，`corepack enable` 即提供固定版本的 pnpm（也可以 `npm install -g pnpm@10.12.3`）。macOS 需要 Xcode Command Line Tools（`swiftc`）编译钥匙串辅助程序；Windows 使用系统自带的 .NET Framework 编译原生辅助程序。

```sh
git clone https://github.com/wyzz973/HarnessHub.git   # 历史约 500 MB；只想试用时加 --depth 1
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm exec hh serve
```

`pnpm install` 可能提示“Ignored build scripts: @google/genai, protobufjs”：这两个包只供测试套件使用，不需要批准。`hh serve` 监听 `127.0.0.1:3180`，数据目录为 `./data`（`--port` 与 `--data-dir` 修改；改了数据目录时，之后每个 `hh` 命令都要加同样的 `--data-dir`）。它输出 JSON 日志，并打印一行 `Console: http://127.0.0.1:3180/#login=…`：一次性登录链接，60 秒内可用一次，在本机浏览器中打开即可。需要新链接时，在第二个终端运行 `pnpm exec hh console`。

在第二个终端运行 `pnpm exec hh init` 完成其余设置：从预设添加 provider 与 API Key、刷新模型，把所有改动合在一份预览中确认后，把本机已安装的 Agent 接到默认模型（见 [快速上手](docs/quickstart.md#向导hh-init)）。本地服务（vLLM、LM Studio、Ollama）不在预设的默认地址时用 `--base` 给出。没有 API Key 时，[快速上手](docs/quickstart.md#没有-api-key-时)说明怎样对一个本机替身试用全部流程。`pnpm exec hh tui` 在终端中列出每个 Agent 的模型、档位与 effort。

控制台目前只有中文界面，首页是 **Agent**：本机的每个 Agent 与它的模型，点模型即可预览并接线；**Provider**、**路由与 Key** 与 **用量** 管理模型平面；无人值守运行在 **任务** 下（统一模型、引擎、工具、观测）。数据目录、真实 Agent 与排障见 [使用指南](docs/getting-started.md)。秘密只以引用形式保存（钥匙串、DPAPI、环境变量或文件），配置文件中不出现明文。

`pnpm start` 不经 `hh` 命令启动同一个守护进程。

```sh
pnpm check   # 构建、lint、测试（含协议套件）、API 与文档检查、控制台构建
pnpm bench   # 网关延迟、逐块开销、200 路并发流与账本提交，对照 M1 目标
```

## 文档

| 主题 | 位置 |
|---|---|
| 开源版设计：产品、架构、各平面、安全、工程、治理 | [docs/proposals/oss](docs/proposals/oss/README.md) |
| 现行架构与运行契约 | [DESIGN.md](DESIGN.md) · [架构导览](docs/architecture.md) |
| HTTP API | [API 入口](docs/api/README.md) · [逐接口参考](docs/api/reference.md) · [OpenAPI](docs/api/openapi.json) |
| 开发与测试 | [开发规范](docs/development.md) · [测试要求](docs/testing.md) · [文档规范](docs/documentation.md) |
| 全部文档 | [文档索引](docs/README.md) |

## 项目

- **许可证**：[MIT](LICENSE)。
- **维护方式**：项目由 [@wyzz973](https://github.com/wyzz973) 拥有；日常开发与维护由 AI 维护者（Claude）在所有者授权下完成，见 [GOVERNANCE.md](GOVERNANCE.md)。每个改动都经过同样的自动化检查。
- **贡献**：见 [CONTRIBUTING.md](CONTRIBUTING.md)，贡献按 [Developer Certificate of Origin](https://developercertificate.org/) 签署（`git commit -s`）。
- **安全**：漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
- **无隶属关系**：HarnessHub 与 GitHub 组织 `HarnessHub`、Harness Inc. 以及所对接的 Agent 与模型厂商均无隶属关系，产品名只用于说明兼容性，见 [TRADEMARKS.md](TRADEMARKS.md)。
- **历史**：早期单模型版本及其发布产物保留在 `archive/competition` 分支。
