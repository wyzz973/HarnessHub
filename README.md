# HarnessHub

**一个本地运行的多引擎 Agent 执行网关。** 用同一套 HTTP API 和 Web 控制台发现、配置与运行不同 Harness，保留会话、执行事件、工具权限、文件产物和模型用量证据。

HarnessHub 管理任务的生命周期与公共状态，具体推理和工具执行交给所选引擎。当前提供 ACP Driver 和文本 CLI Driver，不要求每个引擎使用相同模型服务。

## 当前能力

- **引擎发现与管理**：16 种已知 Harness 启动配方、PATH/常见目录扫描、自定义 manifest；运行中登记、替换、停用和切换默认引擎。
- **独立配置**：按适配能力设置模型、Provider、API URL、Keychain/环境/文件密钥引用、便携 Skills 和 ACP MCP。已有 Session 固定原配置版本。
- **执行控制**：独立 Worker、同 Session 串行、跨 Session 有界并发、期限、取消、权限决定与进程清理状态。
- **可追溯结果**：SQLite 提交日志、SSE 重放、JSONL 导出、不可变文件产物、配置与实际模型/用量的分别记录。
- **工作流与评测**：模型生成计划、人工确认、有界 DAG 串行执行；文本/JSON/文件评判器与离线成绩汇总。
- **本地控制台**：Next.js/React 工作台、引擎配置、连接检查、模型测试、执行详情与观测页。

**验证范围**：macOS 上已取得指定版本的执行证据；自动测试使用真实 Gateway/SQLite/IPC/Worker 和确定的外部引擎替身。安装发现、协议握手、模型可用和任务正确性分别验证。Windows 原生运行仍待验收；不是已完成的跨平台发行版。详见 [能力范围](docs/engine-discovery.md)、[配置支持表](docs/engine-configuration.md)和 [验收记录](docs/README.md#验收与历史资料)。

## 快速开始：不需要 API Key

前置条件：Git、**Node.js 24.20.0**、**pnpm 10.12.3**。macOS 构建另需 Xcode Command Line Tools（`swiftc` 用于 Keychain helper）；缺少时先运行 `xcode-select --install`。Linux 不构建此 macOS helper，可使用 env/file 秘密引用。

```sh
git clone https://github.com/wyzz973/HarnessHub.git
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
```

公开仓库可直接克隆。新克隆不包含任何 API Key、本机引擎安装、用户配置或历史数据库。

终端一，启动显式 demo Gateway：

```sh
pnpm start --demo --port 3180 --data-dir ./data/demo
```

终端二，在同一仓库启动控制台：

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm start:console
```

打开 **[http://127.0.0.1:3330](http://127.0.0.1:3330)**，将“执行模式”从“自动规划”切换为“直接执行”，选择 `fake` 引擎并发送文本。demo 只回显/模拟协议，不代表真实 AI 推理；默认的自动规划会排除 `fake`，需要另外接入真实引擎。

验证 HTTP、事件、幂等、产物和关闭流程：

```sh
node examples/http-lifecycle.mjs http://127.0.0.1:3180
```

脚本仅接受含 `fake` 引擎的 demo 服务，成功输出 `status: completed`、Run ID、事件数和产物 hash，最后关闭自己创建的 Session。停止服务使用终端 Ctrl+C；同一数据目录不能由两个 Gateway 同时写入。

## 接入真实引擎

先在本机安装所需引擎及固定版本 Adapter，再启动空目录 Gateway：

```sh
pnpm start --port 3180 --data-dir ./data/local
```

在控制台“引擎管理”中发现、登记并配置。**发现不会自动安装或注册程序**；保存配置只影响新会话。“检查连接”解析配置并检查 ACP 握手，不调用模型；“测试模型”会创建正式任务并实际使用所配置模型。

也可从 [engines/example.yaml](engines/example.yaml) 准备自己的 `engines/local.yaml`：

```sh
cp engines/example.yaml engines/local.yaml
# 按说明编辑成本机真实存在的命令与工作区，移除未安装的示例引擎
pnpm start --config engines/local.yaml --port 3180 --data-dir ./data/local
```

密钥只使用 [秘密引用](docs/engine-configuration.md#密钥与环境)，不要写入提交内容或 command。Skills 当前采用显式任务上下文模式；MCP 统一注入要求 ACP；任意 Provider URL 并非所有引擎都支持。

## 文档导航

| 想了解什么 | 文档 |
|---|---|
| 从零启动、数据目录、常见问题 | [使用指南](docs/getting-started.md) |
| 模块边界、调用链、状态和存储 | [架构与实现导览](docs/architecture.md) · [设计基线](DESIGN.md) |
| 40 个 HTTP 操作的参数、实现和副作用 | [API 入口](docs/api/README.md) · [逐接口实现](docs/api/reference.md) · [OpenAPI](docs/api/openapi.json) |
| 模型、密钥、Skills、MCP | [引擎独立配置](docs/engine-configuration.md) |
| 动态登记、版本、发现与原生连接 | [引擎管理](docs/engine-management.md) · [发现](docs/engine-discovery.md) |
| 计划确认、选路与失败恢复 | [工作流](docs/workflows.md) |
| 文件、用量、Benchmark | [产物](docs/file-artifacts.md) · [观测](docs/observability.md) · [评测](docs/benchmark.md) |
| 开发、测试、贡献与发布 | [开发规范](docs/development.md) · [测试](docs/testing.md) · [贡献](CONTRIBUTING.md) |
| 全部文档和历史验收 | [文档索引](docs/README.md) |

## 开发与检查

```sh
pnpm check          # 当前平台完整检查，包含构建、测试、API 文档同步与前端构建
pnpm docs:api       # 从正式路由和实现说明重新生成 API 文档
pnpm check:api      # 检查生成文档是否过期；需先 build
pnpm dev:console   # 前端开发模式；同样需设置 HARNESSHUB_GATEWAY_URL
```

项目默认 Gateway 为 `3180`，Console 为 `3330`。Console 未显式设置后端时的兼容默认仍是 `3182`，因此新环境**总是显式设置** `HARNESSHUB_GATEWAY_URL`。历史验收中的 `3181/3182/3184` 和 `.tmp/.tools` 是本机记录，不是新克隆前置条件。

目录结构和具体脚本见 [架构导览](docs/architecture.md#源码地图)；开发任务与未验证项见 [TODO.md](TODO.md)。

## 许可与来源

自有代码尚未指定开源许可证；仓库可见性不等于授予开源许可。第三方组件与参考项目的来源、许可位置见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
