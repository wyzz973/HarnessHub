# HarnessHub

**开源的编码 Agent 控制平面。** 让任意 Agent 使用任意模型，通过一套 API 无人值守地运行它们，并保留每一次模型调用的证据。

[English](README.md) · [文档](docs/README.md) · [设计](docs/proposals/oss/README.md) · [路线图](ROADMAP.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

> 本文是 [英文 README](README.md) 的译文，两者不一致时以英文为准。

> **状态：预发布（里程碑 M0，开源重置阶段）。** 目前没有正式发布的版本，只能从源码运行，0.1 之前接口还会变化。各里程碑的交付见 [路线图](docs/proposals/oss/12-roadmap-migration.md)。

## 它是什么

开发者越来越多地同时使用多个编码 Agent，例如 Claude Code、Codex、Gemini CLI、OpenCode、Qwen Code。HarnessHub 在一个地方管理它们：

- **模型平面**：本地网关同时支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Gemini 协议，让每个 Agent 都能使用你选择的模型，按 Key 限定可用的模型，并记录每一次调用。
- **Agent 平面**：原地编辑本机编码 Agent 自己的配置，把它们接到网关（预览、备份、漂移检测与还原），并把指令、Skills 与 MCP 服务同步给它们。
- **执行平面**：通过 REST + SSE API 无人值守地运行 Agent，提供 Session、Run、权限往返、期限、取消、文件产物和持久事件日志。

[产品定义](docs/proposals/oss/01-product.md) 把 HarnessHub 与 [Magpie](https://github.com/yetone/magpie) 及同类项目做了逐项比较。最主要的区别：HarnessHub 会运行 Agent 并记录可核对的证据，而不只是切换它们的配置。

## 与 Magpie 的关系

HarnessHub 的模型平面与 Agent 平面用 TypeScript 重新实现了 yetone 的 [Magpie](https://github.com/yetone/magpie)（MIT，Go）的能力，逐项对照 Magpie 提交 `2e340f7` 的源码，并在其上加入执行平面与证据链。感谢 Magpie 项目提供的设计与对每个 Agent 的逐字段了解。

- **已覆盖**：网关的四种协议、直通与转换、路由、重试与路由组；Magpie 51 个 provider 预设中的 48 个（[取自 Magpie](THIRD_PARTY_NOTICES.md)，保留其 MIT 声明）；Magpie 35 个 Agent 中 27 个的全局接线（另有 Qwen Code），每个都依照 Magpie 对该 Agent 的写法；Profile、每个 Agent 的模型清单、终端界面、订阅账号（ChatGPT 与 Copilot）、局域网共享、备份与同步。
- **有意不同**：每个 Agent 有自己的 Gateway Key（Magpie 的回环网关接受任意令牌）；用户改过的文件按漂移报告，而不是被重写。
- **未覆盖**：Magpie 只切换其自带模型的 Agent（Goose、Cursor、Copilot CLI、Devin），以及 Antigravity CLI、OpenHanako、Alma 与 Cindy（[原因](docs/global-wiring.md)）；WSL 中的 Agent；Magpie 的桌面应用（HarnessHub 提供 Web 控制台与 `hh tui`）。

[HarnessHub for Magpie users](docs/magpie-parity.md)（英文）逐个领域对比两者，列出差距，并说明如何迁移。

HarnessHub 自己的代码使用 MIT 许可证；取自其他项目的代码与数据保留原许可证，列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 目前已有的能力

现有代码来自 HarnessHub 早期的单模型版本，正在按里程碑逐步重构。今天已经提供：

| 领域 | 现有行为 |
|---|---|
| 模型网关 | 守护进程端口上的共享网关，供任意 OpenAI、Anthropic 或 Gemini 客户端与无人值守的 Run 使用：从 46 个预设或手动添加 provider、带规则的路由组、带模型白名单与预算的 Gateway Key、直通原生端点或在四种协议之间转换、故障转移，以及记录用量与费用的 `model.call` 账本 |
| Agent | 28 个 Agent 的全局接线（`hh init`、`hh wire`、`hh tui` 与控制台的 Agent 页）：每个 Agent 在自己的配置文件中拿到只属于它的 Gateway Key，有预览、备份、漂移检测与还原（[全局接线](docs/global-wiring.md)）；Profile；把指令、MCP 服务与 Skills 同步到 9 个 Agent 的 Library |
| 账号与共享 | ChatGPT 套餐（Sign in with ChatGPT）与 GitHub Copilot 作为订阅 provider，只服务本机的 Agent；局域网共享，以及把另一台 HarnessHub 作为上游 |
| 执行 | SQLite 中的持久 Session 与 Run，同一 Session 串行；SSE 从已提交事件重放；幂等提交；期限与取消；权限请求；声明的输出文件采集为不可变产物；JSONL 导出；ACP 与 CLI 驱动，每个 Session 使用私有配置 |
| 工具 | 工具包，含 Skills、MCP 服务与 CLI 工具，按内容哈希存储，按 Agent 绑定 |
| 运维 | `config.jsonc` 与 `hh config`；加密备份、恢复与 WebDAV/S3 同步；模型调用的 OTLP 导出；每个 Session 一个 Worker 进程，POSIX 用进程组、Windows 用 Job Object，重启后恢复 |
| 控制台 | 由守护进程在同一端口提供的 Web 控制台（React + Vite），有中文与英文界面。用一次性链接登录，浏览器拿不到管理令牌 |

`hh` 的单可执行文件构建（`pnpm test:sea`）可在 macOS arm64 上运行；其他平台尚未构建，也还没有发布版本。Windows 支持已经实现，但尚未在 Windows 上验证。

## 从源码安装

前置条件：Git、Node.js 24.20.0、pnpm 10.12.3。仓库的 `.node-version` 写明了 Node 版本，读取它的版本管理器（fnm、nodenv、Volta）会自动选用；用其他版本的 Node 时 pnpm 提示“Unsupported engine”。Node 24 自带 Corepack，`corepack enable` 即提供固定版本的 pnpm（也可以 `npm install -g pnpm@10.12.3`）。macOS 需要 Xcode Command Line Tools（`swiftc`）编译钥匙串辅助程序；Windows 使用系统自带的 .NET Framework 编译原生辅助程序。

```sh
git clone https://github.com/wyzz973/HarnessHub.git   # 历史约 500 MB；只想试用时加 --depth 1
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
```

`pnpm install` 只执行 esbuild 的依赖构建脚本；`@google/genai` 与 `protobufjs` 只供测试套件使用，HarnessHub 不需要它们的脚本所做的事，已在 `package.json` 中声明不执行，安装时不再询问。下面的命令都在仓库根目录执行，`pnpm exec hh` 就是 `hh` 命令（[apps/hh](apps/hh/README.md)）。

## 快速上手

### 1. 启动守护进程

```sh
pnpm exec hh serve
```

它监听 `127.0.0.1:3180`，数据目录为 `./data`（`--port` 与 `--data-dir` 修改；改了之后，每个 `hh` 命令都要加同样的 `--data-dir`，端口不同时还要加 `--url`）。它输出 JSON 日志，并打印 `Console: http://127.0.0.1:3180/#login=…`，即控制台的一次性登录链接。provider 的 API Key 存入系统的秘密存储（macOS 钥匙串、Windows DPAPI，其他平台为加密文件；`--secrets-backend file` 在任何平台都用加密文件），配置中只保留引用。让它保持运行，另开一个终端。

### 2. 添加 provider 并接入 Agent

`pnpm exec hh init` 一步步完成：从预设添加 provider 与它的 API Key（不回显输入）、刷新模型、列出本机已安装的 Agent，把各 Agent 的文件改动合在一起显示后，接到你选的默认模型。没有终端时由选项给出答案：

```sh
pnpm exec hh init --preset deepseek --credential-from-env DEEPSEEK_API_KEY \
  --agents claude,codex --model deepseek/<model> --yes
```

`pnpm exec hh provider presets` 列出预设（厂商、中转与本地服务），`pnpm exec hh provider models <provider>` 列出某个 provider 的模型，写作 `provider/model`。本地服务（vLLM、LM Studio、Ollama）向导会询问地址，回车沿用预设的地址；没有终端时用 `--base` 给出其他地址。同 id 的 provider 已存在时按原样使用，与它不同的选项会列出，在终端中询问怎样处理。

**没有 API Key 时**，仓库自带的假 provider（[tools/fake-provider](tools/fake-provider/README.md)）可以代替。它不调用任何真实模型，只在回环地址监听，对每个请求回答固定的文字，足以试用这里的每一步。在另一个终端运行：

```sh
HH_FAKE_KEY=sk-test-only node tools/fake-provider/index.mjs --key-env HH_FAKE_KEY --port 8790
```

再把它当作 vLLM 预设的服务：

```sh
HH_FAKE_KEY=sk-test-only pnpm exec hh init --preset vllm --base http://127.0.0.1:8790 \
  --credential-from-env HH_FAKE_KEY --agents codex --model vllm/upstream-sim --yes
```

### 3. 经网关调用模型

```sh
HH_KEY=$(pnpm exec hh key create --name me --allow 'vllm/*')
curl http://127.0.0.1:3180/v1/chat/completions \
  -H "Authorization: Bearer $HH_KEY" -H 'content-type: application/json' \
  -d '{"model":"vllm/upstream-sim","messages":[{"role":"user","content":"Hello"}]}'
pnpm exec hh usage --by model --since 1d
```

`hh key create` 只打印一次 Gateway Key；`--allow` 限定它能用的模型。OpenAI 客户端以 `http://127.0.0.1:3180/v1` 为基址，Anthropic 与 Gemini 客户端以 `http://127.0.0.1:3180` 为基址，API Key 填 Gateway Key；`hh status` 打印这些地址。网关只接受本机回环连接，除非开启了 [局域网共享](docs/model-gateway.md#局域网共享)。每次调用，包括被拒绝的，都记在 `hh usage` 读取的账本中。

### 4. Agent

```sh
pnpm exec hh agents                         # 本机的 Agent：是否安装、是否接线、模型、漂移
pnpm exec hh wire codex vllm/upstream-sim   # 显示文件改动，确认后接线
pnpm exec hh tui                            # 终端界面：模型、档位、effort、Profile
pnpm exec hh unwire codex                   # 还原它的文件并吊销它的 Key
```

接线先备份 Agent 自己的配置文件，写入只属于这个 Agent 的 Key，再回读校验。正在运行的 Agent 会话重启后生效。在终端中，`wire`、`unwire` 以及其他会改动文件或设置的命令都先询问；没有终端时（脚本、CI 或另一个 Agent 的 shell）它们显示改动后以 “No terminal to confirm; pass --yes” 停止（退出码 4），什么都不改，这时加 `--yes`，如上面 `hh init` 的示例。28 个 Agent 各自写入哪些文件与键、以及安全规则，见 [全局接线](docs/global-wiring.md)。

### 5. 控制台

打开 `hh serve` 打印的登录链接，或用 `pnpm exec hh console` 生成新的；每个链接只能在本机浏览器中使用一次，60 秒内有效。控制台有中文与英文界面：在“设置 → 语言”中选择之前跟随浏览器的语言，选择后保存在这个浏览器中。首页是 **Agent**：本机的每个 Agent 与它的模型，点模型即可预览并接线。**Provider**、**订阅账号**、**路由与 Key**、**用量**、**Profile**、**Library** 与 **设置**（语言、网关功能、备份与同步）管理其余部分。无人值守运行在 **任务** 下，包括引擎、工具与观测；任务可以在输入框中选网关的模型，已弃用的统一模型页只在配置了旧来源时出现；这些页面、数据目录与排障见 [使用指南](docs/getting-started.md)。

`pnpm start` 不经 `hh` 命令启动同一个守护进程。

## 命令一览

`hh --help` 列出全部命令，`hh <命令> --help` 说明其中一个。

| 命令 | 作用 |
|---|---|
| `serve`、`version`、`config`、`status`、`console` | 启动守护进程、打印构建身份、查看或修改 `config.jsonc`、显示运行中的守护进程、登录控制台 |
| `init` | 一次完成从预设添加 provider 与接入本机已安装的 Agent |
| `provider`、`import`、`credential`、`model`、`catalog` | 从预设或手动添加 provider、导入链接、它们的 Key、模型元数据与 models.dev 目录；`provider test` 与 `provider doctor` 检查一个 provider |
| `key`、`group`、`usage`、`gateway` | Gateway Key 与预算、路由组与规则、账本中的用量、局域网共享与网关功能 |
| `subscription` | 登录 ChatGPT 或 Copilot 账号，供本机的 Agent 使用 |
| `agents`、`wire`（`use`）、`unwire`、`profile`、`tui` | 本机 Agent 的全局接线 |
| `library` | 指令、MCP 服务与 Skills，同步到各 Agent |
| `backup`、`restore`、`sync` | 加密备份，以及经 WebDAV 或 S3 同步 |
| `benchmark`、`tools`、`rollout` | 无人值守运行的 Benchmark、工具包与 rollout 导出 |

## 开发

```sh
pnpm check              # 构建、lint、测试（含协议套件）、API 与文档检查、控制台构建
pnpm bench              # 网关延迟、逐块开销、200 路并发流与账本提交，对照 M1 目标
pnpm test:conformance   # 本机安装的真实 Agent，在沙箱中离线接线并运行（macOS）
```

每个改动遵循的规则见 [AGENTS.md](AGENTS.md)、[开发规范](docs/development.md) 与 [测试要求](docs/testing.md)。

## 文档

大多数文档目前是中文；英文将随 0.1 计划中的文档站成为主要文档语言。[文档索引](docs/README.md) 用英文说明每一份文档。

| 主题 | 位置（除标注外为中文） |
|---|---|
| 快速上手、配置与控制台 | [快速上手](docs/quickstart.md) · [配置参考](docs/configuration.md) · [使用指南](docs/getting-started.md) · [控制台](packages/console/README.md) |
| 模型网关、provider 与 Key | [模型网关](docs/model-gateway.md) · [模型平面 API 与 CLI](docs/model-plane-api.md) · [Provider 预设](docs/provider-presets.md) · [网关功能](docs/gateway-features.md) |
| Agent | [全局接线](docs/global-wiring.md) · [Library](docs/library.md) · [真实 Agent 兼容性](docs/compatibility.md) |
| HTTP API | [API 入口](docs/api/README.md) · [逐接口参考](docs/api/reference.md) · [OpenAPI](docs/api/openapi.json)（机器可读） |
| 设计与架构 | [开源版设计](docs/proposals/oss/README.md) · [DESIGN.md](DESIGN.md) · [架构导览](docs/architecture.md) · [决策记录](docs/decisions/README.md) |
| 项目（英文） | [路线图](ROADMAP.md) · [变更记录](CHANGELOG.md) · [治理](GOVERNANCE.md) · [获取帮助](SUPPORT.md) · [维护者](MAINTAINERS.md) |

## 项目

- **许可证**：[MIT](LICENSE)。第三方代码与数据保留各自的许可证：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **维护方式**：项目由 [@wyzz973](https://github.com/wyzz973) 拥有；日常开发与维护由 AI 维护者（Claude）在所有者授权下完成，见 [GOVERNANCE.md](GOVERNANCE.md)。每个改动都经过同样的自动化检查。
- **贡献**：见 [CONTRIBUTING.md](CONTRIBUTING.md)，贡献按 [Developer Certificate of Origin](https://developercertificate.org/) 签署（`git commit -s`）。
- **安全**：漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
- **无隶属关系**：HarnessHub 与 GitHub 组织 `HarnessHub`、Harness Inc. 以及所对接的 Agent 与模型厂商均无隶属关系，产品名只用于说明兼容性，见 [TRADEMARKS.md](TRADEMARKS.md)。
- **历史**：早期单模型版本及其发布产物保留在 `archive/competition` 分支。
