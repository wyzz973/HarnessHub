# HarnessHub

**一个本地运行的多引擎 Agent 执行网关。** 同一套 HTTP API 和 Web 控制台可以驱动 10 个不同的 Agent 引擎（OpenCode、Codex、Qwen、Gemini、Pi、MiMo、DSH、OpenClaw、Kimi、Hermes），换引擎只改一个环境变量。

**所有引擎只使用你配置的那一个模型。** 各引擎的原生协议（Responses、Anthropic Messages、Google、Chat Completions）由 Worker 内的统一模型网关转换为上游的流式 OpenAI Chat Completions；引擎自带的 API Key、登录和订阅都不会被使用。

**会话、执行事件、工具调用、权限、文件产物、每次模型调用和引擎诊断日志都落盘可查。**

## 下载即用（Windows x64，离线，全新电脑）

裁判机或全新电脑不需要 Node、pnpm、Python、Git，也不需要联网安装任何东西。

1. 从 Release [`competition-latest`](https://github.com/wyzz973/HarnessHub/releases/tag/competition-latest) 下载 `harnesshub-competition-full-windows-x64.zip`（约 1.8 GB）与同名 `.sha256`。
2. **解压到较短的路径**，例如 `D:\hh`：

   ```powershell
   tar.exe -xf harnesshub-competition-full-windows-x64.zip -C D:\hh
   ```

   包内最长的相对路径有 196 个字符。Windows 资源管理器的“全部解压缩”默认解到 `下载\harnesshub-competition-full-windows-x64\`，加上这个长度会超过 260 字符上限并**静默丢文件**；用 7-Zip 或上面的 `tar.exe` 解到短路径可以避免。
3. 双击 `Start.cmd`，浏览器打开 **http://127.0.0.1:3330**。
4. 在控制台里填写模型的**接口地址**（形如 `http://<网关地址>/v1`）、**模型 ID** 和 **API Key**，保存。上游必须是支持**流式**的 OpenAI Chat Completions 接口。
5. 选择一个引擎，输入任务，开始执行。

办公用的 Skill 与工具（Word/Excel/PowerPoint/PDF 生成与读取、.ics 日程、.eml 邮件、打开并核实 Windows 应用）**随包预装**，首次启动自动应用到全部引擎，见 [办公工具包](docs/office-suite.md)。要加自己的工具，在控制台“工具”页导入 Skill 目录、`mcp.json`、`cli.json`，或粘贴 `{"mcpServers":{…}}` 配置；命令行等价物是 `Install-Tool-Pack.cmd --source <路径> --engines all`，见 [Capability Pack](docs/capability-packs.md)。

出问题时先看日志：`state\competition-data\logs\gateway.log`（接口调用、Session/Run 生命周期、每次模型调用）和每个会话的 `…\backends\<sessionId>\diagnostics\engine.log`（引擎进程、stderr、逐条 ACP 请求与响应、工具调用）。控制台“执行详情 → 诊断日志”可直接查看，`Collect-Logs.cmd` 把全部日志打成一个已脱敏的 ZIP。排障路径见 [交接说明](docs/handoff.md)。

## 比赛评测（Agent 网关接口规范 v1.1）

评测方按 [INSTRUCTION.md](distribution/INSTRUCTION.md) 执行，与上面的双击启动互不影响：

```powershell
$env:HARNESSHUB_MODEL      = "<模型 ID>"
$env:HARNESSHUB_MODEL_BASE_URL = "http://<模型网关>/v1"
$env:HARNESSHUB_MODEL_API_KEY  = "<密钥>"
$env:AGENT_ENGINE          = "opencode"   # 换引擎只改这一行
.\Start-Competition.cmd
```

比赛 API 监听 `http://localhost:6217`：`POST /session`（必须传 `directory`）、阻塞到本轮结束的 `POST /session/{id}/prompt_async`、`GET /session/{id}/message`、`GET /event`（SSE）、`abort`、权限与反问。逐项映射与完成判定见 [比赛接口](docs/competition-api.md)；按评委数据格式跑办公任务并按最终状态判分的工具见 [比赛任务测试](docs/competition-tasks.md)。

提交物形态（源码 + 离线依赖 + 固定引擎）从 Release [`offline-dev-latest`](https://github.com/wyzz973/HarnessHub/releases/tag/offline-dev-latest) 下载，在断网机器上执行 `Setup-Competition-Offline.cmd` 完成依赖恢复、编译与比赛布局生成，再用 `Start-Competition.cmd` 启动。

## 验证范围

| 场景 | 环境 | 结果 |
|---|---|---|
| 10 个引擎的比赛接口、工具调用、中断与统一模型核对 | Windows x64 CI，脚本化模拟模型 | 10/10 通过 |
| 同上，真实模型（DeepSeek `deepseek-flash` 经只接受流式的严格网关，对外呈现为 `GLM-V5_1-DX`） | Windows x64 CI | 8/10 通过；Kimi、DSH 的根因已修复并分别复测通过 |
| 一键工具包（Skill + MCP + CLI）安装到全部引擎并被真实调用 | Windows x64 CI，真实模型 | 9/10 通过（Kimi 待复测） |
| 离线开发包：断网 `Setup-Competition-Offline.cmd` → `Start-Competition.cmd` | Windows x64 CI | opencode、codex、hermes 通过 |
| 干净离线 Windows Server Core 容器（无任何运行时、无网络） | Windows x64 CI | 完整性校验、无模型自检、10 引擎模拟模型全部通过 |
| 7 个真实引擎经严格流式网关跑通比赛接口 | macOS | 通过 |

证据、运行编号与**未验证项**（公司自有 GLM 网关、真实 Office/Outlook COM 操作、桌面会话、Windows 10、ARM64）见 [Windows x64 验收记录](docs/verification/2026-09-20-windows-x64.md)与 [统一模型网关验收](docs/verification/2026-09-19-unified-model-gateway.md)。安装发现、协议握手、模型可用和任务正确性分别验证，通过一项不代表其余成立。

## 从源码开发

前置条件：Git、**Node.js 24.20.0**、**pnpm 10.12.3**。macOS 另需 Xcode Command Line Tools（`swiftc` 用于 Keychain helper），Windows 使用系统 .NET Framework 编译原生 helper。

```sh
git clone https://github.com/wyzz973/HarnessHub.git
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
```

公开仓库可直接克隆；新克隆不包含任何 API Key、引擎二进制、用户配置或历史数据库。启动一个空数据目录的 Gateway 并在控制台中登记本机已安装的引擎：

```sh
pnpm start --port 3180 --data-dir ./data/local
```

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm start:console
```

打开 **[http://127.0.0.1:3330](http://127.0.0.1:3330)**，在“模型”页配置统一模型，在“引擎”页发现并登记引擎。**发现不会自动安装或注册程序**；保存配置只影响新会话。也可以从 [engines/example.yaml](engines/example.yaml) 准备自己的 `engines/local.yaml` 后用 `--config` 启动。密钥只使用 [秘密引用](docs/engine-configuration.md#密钥与环境)，不要写进提交内容或 command。

```sh
pnpm check          # 当前平台完整检查：构建、测试、API 文档同步与前端构建
pnpm docs:api       # 从正式路由与实现说明重新生成 API 文档
pnpm check:api      # 检查生成文档是否过期；需先 build
```

项目默认 Gateway 为 `3180`、Console 为 `3330`；新环境**总是显式设置** `HARNESSHUB_GATEWAY_URL`。`fake` 引擎只是自动测试用的替身，不出现在发行包中，也不用于演示。

## 文档导航

| 想了解什么 | 文档 |
|---|---|
| 从零启动、数据目录、常见问题 | [使用指南](docs/getting-started.md) |
| 交接、环境变量全集、排障路径、发布流程 | [交接说明](docs/handoff.md) |
| 本次发布的全部变更 | [变更记录](CHANGELOG.md) |
| 模块边界、调用链、状态和存储 | [架构与实现导览](docs/architecture.md) · [设计基线](DESIGN.md) |
| 全部 HTTP 操作的参数、实现和副作用 | [API 入口](docs/api/README.md) · [逐接口实现](docs/api/reference.md) · [OpenAPI](docs/api/openapi.json) |
| 统一模型、密钥、Skills、MCP | [引擎独立配置](docs/engine-configuration.md) · [统一模型网关](docs/model-gateway.md) |
| 比赛接口、评测调用与办公任务测试 | [比赛接口](docs/competition-api.md) · [比赛任务测试](docs/competition-tasks.md) · [INSTRUCTION.md](distribution/INSTRUCTION.md) |
| 预装办公 Skill 与工具 | [办公工具包](docs/office-suite.md) · [Capability Pack](docs/capability-packs.md) |
| 诊断日志、模型用量与证据 | [观测](docs/observability.md) |
| 动态登记、版本、发现与原生连接 | [引擎管理](docs/engine-management.md) · [发现](docs/engine-discovery.md) |
| 发行包制备与 Windows 能力边界 | [Windows 便携发布包](docs/portable-bundle.md) · [Windows 指南](docs/windows.md) |
| 开发、测试、贡献与发布 | [开发规范](docs/development.md) · [测试](docs/testing.md) · [贡献](CONTRIBUTING.md) |
| 全部文档和历史验收 | [文档索引](docs/README.md) |

## 许可与来源

自有代码尚未指定开源许可证；仓库可见性不等于授予开源许可。第三方组件与参考项目的来源、许可位置见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
