# 公司 Windows ARM64 离线交接

目标是 Windows 11 ARM64，模型 URL 只提供 Chat Completions。公司现有网关改动保留在内网；公共基线是 `1989d224b93f0344cae744444d656ad7519e8398`，适配分支是 `feat/offline-chat-completions`。

## 交付内容

| 内容 | 用途 |
| --- | --- |
| 本分支和带历史的 Git bundle | 公司 Agent 离线比较、合并公共适配 |
| `vendor/engine-sources` | 10 个引擎、3 个 ACP Adapter、acpx 的固定源码；见 [来源清单](open-source-engines.md) |
| Windows ARM64 完整运行包 | 固定引擎程序、Node/Python/Git、本地工具和控制台，无需安装或 registry 下载 |
| 运行包 `development` 与 `Dev.cmd` | 向公司 checkout 复制固定依赖并构建 HarnessHub/控制台 |
| [公司 Agent Skill](../skills/harnesshub-company-gateway/SKILL.md) | 保留公司改动、配置模型、适配 MCP/Skill 与验收 |

开源发行版包含 Codex、Gemini、Qwen、Pi、MiMo、DSH、OpenClaw、Kimi、OpenCode、Hermes。其余 6 个已登记引擎不宣称存在可 clone 的公开实现。Hermes 的固定 Python 程序通过 Windows 11 x64 仿真运行，其余构件按清单记录架构。完整运行包单独作为 GitHub Release 附件分发，普通 Git clone 不会自动取得运行文件。

Release 附件的完整校验、分片重组及系统 PowerShell 解压流程见 [离线归档与恢复](offline-artifacts.md)。

## 内网启动

将完整包带入内网，按随包 README 启动。先复制 `examples/company-chat.json` 到公司私有配置位置，填写实际模型、base URL 和 Kimi 上下文窗口。密钥使用 `COMPANY_MODEL_API_KEY` 环境引用或 Windows 加密引用，不放入公共 JSON。执行 `hub.cmd configure --file <私有配置绝对路径>`，再执行 `Start.cmd`。

`hub.cmd doctor --full` 检查清单和文件，`hub.cmd smoke` 只检查程序/协议可启动，不证明模型有效或任务正确。配置变化后重启发行服务并创建新 Session；已保存的控制台 overlay 和历史不会被配置文件偷偷覆盖。

Codex/Gemini 的本地 Driver bridge 将支持的文本/函数工具协议转为 Chat Completions，限制见 [ADR 0011](decisions/0011-chat-completions-bridge.md)。公司自有的鉴权、模型名、附加 header 和网关差异在公司现有实现上合并；公司真实模型测试须按公司授权额度另行执行。

## 工具与后续开发

随包 workspace-tools 包含本地 MCP 与 Skill，按 [工具包指南](tool-packages.md) 安装、校验并绑定引擎；这里的安装是本地文件登记和复制，不访问软件仓库。Pi/OpenClaw/Kimi 的原生接入及秘密限制见 [原生 MCP](native-mcp.md)。便携 Skill 是固定哈希的指令与资源前缀，并不声称所有厂商原生 Skill 机制完全一致。

从包路径执行 `Dev.cmd prepare <公司 checkout 绝对路径>`、`Dev.cmd typecheck <绝对路径>`、`Dev.cmd build <绝对路径>`。prepare 会拒绝已有 root/web node_modules，并且在复制前检查依赖版本、lockfile 与补丁是否匹配离线包。typecheck 检查 Gateway/测试，build 还包含控制台正式编译。不要覆盖公司源码，新增依赖需在允许联网的环境更新离线包。

构建后使用公司自己的新产物入口；旧包 dist 不会自动更新。重建上游 Rust/Bun/Python 引擎需要对应的完整离线工具链，本包提供其源码与固定可执行程序，不承诺上游所有编译链已打包。发行取舍见 [ADR 0012](decisions/0012-offline-company-edition.md)。

公司代码、私有配置、`state`、运行数据库和轨迹不能随公共包上传。合并与验收流程由交接 Skill 维护；公司内网没有提供的代码和真实模型行为不能由公共测试推断为通过。
