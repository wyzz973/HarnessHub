# HarnessHub

**开源的编码 Agent 控制平面。** 让任意 Agent 使用任意模型，通过一套 API 无人值守地运行它们，并保留每一次模型调用的证据。

[English](README.md) · [设计](docs/proposals/oss/README.md) · [路线图](ROADMAP.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

> **状态：预发布（里程碑 M0，开源重置阶段）。** 目前没有正式发布的版本，只能从源码运行，0.1 之前接口还会变化。各里程碑的交付见 [路线图](docs/proposals/oss/12-roadmap-migration.md)。

## 它是什么

开发者越来越多地同时使用多个编码 Agent，例如 Claude Code、Codex、Gemini CLI、OpenCode、Qwen Code。HarnessHub 在一个地方管理它们：

- **模型平面**：本地网关同时支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Gemini 协议，让每个 Agent 都能使用你选择的模型。
- **Agent 平面**：发现本机已安装的 Agent，准备它们的配置、Skills 与 MCP 服务。
- **执行平面**：通过 REST + SSE API 无人值守地运行 Agent，提供 Session、Run、权限往返、期限、取消、文件产物和持久事件日志。

[产品定义](docs/proposals/oss/01-product.md) 把 HarnessHub 与 [Magpie](https://github.com/yetone/magpie) 及同类项目做了逐项比较。最主要的区别：HarnessHub 会运行 Agent 并记录可核对的证据，而不只是切换它们的配置。

## 目前已有的能力

现有代码来自 HarnessHub 早期的单模型版本，正在按里程碑逐步重构。今天已经提供：

| 领域 | 现有行为 |
|---|---|
| 执行 | SQLite 中的持久 Session 与 Run，同一 Session 串行；SSE 从已提交事件重放；幂等提交；期限与取消；权限请求；声明的输出文件采集为不可变产物；JSONL 导出 |
| Agent | ACP 与 CLI 驱动；发现本机已安装的 Agent（OpenCode、Codex、Qwen Code、Gemini CLI、Pi、MiMo、DSH、OpenClaw、Kimi、Hermes 等）；每个 Session 使用私有配置，从不修改用户自己的配置文件 |
| 模型网关 | 一个配置好的上游模型（OpenAI 兼容的流式 Chat Completions）；转换 Responses、Anthropic Messages 与 Gemini 请求；每次调用记录为 `model.call` 事件 |
| 工具 | 工具包，含 Skills、MCP 服务与 CLI 工具，按内容哈希存储，按 Agent 绑定 |
| 进程监督 | 每个 Session 一个 Worker 进程；POSIX 用进程组，Windows 用 Job Object；重启后恢复 |
| 控制台 | 本地 Web 控制台（Next.js），包含任务、模型、工具、Agent 与观测页面 |

多 provider 路由、全局接线、单文件分发与新控制台计划在 0.1–0.3 实现，目前尚未实现。

## 从源码快速开始

前置条件：Git、Node.js 24.20.0、pnpm 10.12.3。macOS 需要 Xcode Command Line Tools（`swiftc`）编译钥匙串辅助程序；Windows 使用系统自带的 .NET Framework 编译原生辅助程序。

```sh
git clone https://github.com/wyzz973/HarnessHub.git
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm start --port 3180 --data-dir ./data/local
```

在第二个终端启动控制台，然后打开 <http://127.0.0.1:3330>：

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm start:console
```

在“模型”页配置模型，在“引擎”页登记已安装的 Agent。发现过程不会安装任何程序；秘密只以引用形式保存（钥匙串、DPAPI、环境变量或文件），配置文件中不出现明文。数据目录、真实 Agent 与排障见 [使用指南](docs/getting-started.md)。

```sh
pnpm check   # 构建、lint、测试、API 与文档检查、控制台构建
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
