# Session 原生 MCP 适配

Pi、OpenClaw 和 Kimi 使用固定程序自己的工具注册/配置入口接收 Session MCP。它们收到的定义不会再次通过 ACP 下发，避免同一个服务启动两次。Skill 继续走已固定哈希的 `SKILL.md` 内容与 `base_directory` 前缀；MCP 验收必须有真实 `tools/call`，读取 Skill 或运行 CLI 不算 MCP 调用。

| 引擎 | 固定版本与入口 | Session MCP | 秘密引用 | 原生限制 |
| --- | --- | --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent@0.85.1`、`pi-acp@0.0.33` | ACP 启动前，在私有 `settings.json` 加载本地扩展；扩展向 Pi 注册 MCP 工具 | Worker 解密后存于所属 Pi 环境；配置只保存环境变量名 | 需要 managed provider；Pi 扩展工具按 Pi 原生规则执行，不新增公共权限承诺 |
| OpenClaw | `openclaw@2026.9.2` 私有 Gateway | 写入 Session 私有 `openclaw.json` 的 `mcp.servers` | 文件使用 `${HARNESSHUB_NATIVE_MCP_…}`；不写秘密值 | 需要 managed provider；保留原生工具策略，不覆盖 `tools.allow/deny` |
| Kimi | `kimi@1.50.0` 的 `--quiet` / `--print` CLI | 通过 `--mcp-config-file` 加载私有文件 | `secretEnv`、`secretHeaders` 明确拒绝 | print 原生自动批准工具；仍是 CLI，不能声明 ACP 权限请求/流式工具事件 |

三个适配器映射 stdio、Streamable HTTP 和 SSE。配置定义与已有 native 参数冲突时拒绝，不读取或修改个人 MCP 配置。Kimi 使用独立 MCP 文件；Pi/OpenClaw 只修改当前 Session 的 `stateDir/configuration`。Pi/OpenClaw 的 stdio `secretEnv` 已通过固定程序验证，且整份 backend 私有状态没有写入合成秘密的字节。

Kimi 的限制来自固定源码：CLI 直接解析 JSON，交给 FastMCP 3.2.4；其 stdio `env` 与 HTTP `headers` 原样传递，不展开环境引用。Python MCP stdio 客户端也只默认继承基础系统环境。写入 `${KEY}` 不能把环境密钥交给工具，因此配置期和 Worker 准备期均拒绝秘密字段；普通环境参数仍可用。[Kimi CLI 1.50.0 配置入口](https://github.com/MoonshotAI/kimi-cli/blob/1.50.0/src/kimi_cli/cli/__init__.py)、[FastMCP 3.2.4 配置格式](https://github.com/PrefectHQ/fastmcp/blob/v3.2.4/src/fastmcp/mcp_config.py)。

## Pi 扩展与资源所有权

`scripts/native-mcp/pi-extension.mjs` 使用 Pi 的原生异步扩展工厂与 `registerTool()`。MCP SDK 从已固定引擎安装旁解析，当前准备包为 `@modelcontextprotocol/sdk@1.30.0`，运行时不下载依赖。SDK 缺失会在启动前明确拒绝；发行必须包含该 SDK 及本地扩展文件。[Pi 扩展 API](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)。

- 工具名为 `mcp__<server>__<tool>`，须满足 1–64 位 ASCII 字母、数字、下划线或短横线；冲突或不合法时启动失败。
- 完整读取 `tools/list` 分页，重复 cursor 作为协议错误拒绝。每次初始化、工具目录请求超时为 10 秒；工具调用沿用 SDK 请求超时及 Pi 的取消信号。
- 工具结果支持 MCP `text`、`image`；其他内容类型明确报错。`structuredContent` 保留于工具 details。
- 初始化失败会先关闭已建立的客户端，再退出所属 Pi，防止 Pi 默认的“扩展加载失败后继续运行”造成工具静默缺失。
- stdio 只向所属 MCP 进程传递其配置的 env 与 SDK 规定的基础系统环境；MCP stderr 被 drain，不进入公开事件。
- `session_shutdown` 等待 SDK 客户端关闭并确认直接子进程退出；最终进程树由正式 Worker 的 Windows Job 负责回收。取消 Run 仍走同一 ProcessHost，不创建另一套任务循环。

OpenClaw 直接使用其内置 MCP 客户端与生命周期，支持 `mcp.servers` 的三个传输类型；不需要下载插件。工具仍经过 OpenClaw 自身的 profile 和 policy。[OpenClaw MCP 文档](https://docs.openclaw.ai/tools/mcp)、[原生配置](https://docs.openclaw.ai/gateway/config-extensions)。

MiMo 0.1.14 的原生 INFO 日志会序列化 ACP Session 的 `mcpServers`，包含解密后的 env。托管 MCP 因而要求原生 `--log-level ERROR`：缺少参数时添加；已有 ERROR 保留，其他日志等级或缺值明确拒绝。固定程序验收会检查整个 backend 私有目录，不能仅因为秘密没有进入公开事件就认定没有落盘。

## 验证

单元测试覆盖私有路径约束、已有模型/工具策略保留、秘密引用、重复 native owner、错误 Driver、Kimi 秘密及固定参数拒绝。

`tests/integration/native-mcp-engines.test.ts` 是显式启用的固定程序验收；默认不启动原生引擎并记录 skipped，不代替单元检查。设置开关后若缺少准备包则明确失败。在准备好 Windows 11 ARM64 固定引擎后运行：

```powershell
$env:HARNESSHUB_TEST_NATIVE_MCP = '1'
& '.tools/node-v24.20.0-win-arm64/node.exe' node_modules/typescript/bin/tsc -p tsconfig.json
& '.tools/node-v24.20.0-win-arm64/node.exe' --test dist/tests/integration/native-mcp-engines.test.js
```

测试通过正式 Gateway 创建 Session、提交 Run，由编译后的 Worker 启动原生程序。本地 Chat Completions 服务返回工具调用；独立 stdio MCP 服务记录 `tools/call` 的真实参数，随后确认工具结果回到模型。固定 Skill 内容和附件 `base_directory` 必须出现在原生程序发出的模型请求中；这证明上下文注入，不将其称作附件文件已被工具读取。出现原生权限请求时，仅对 fixture 指定的工具调用通过正式权限 API 执行一次允许。关闭 Session 后核实工具进程及故意保留的子进程不存在，并扫描 backend 文件不含合成 MCP 密钥。另有 Pi 初始化失败及工具执行中取消分支。所有模型请求只到随机 loopback 端口，HTTP 代理拒绝外部 CONNECT，使用合成密钥，未调用外部模型。

2026-09-07 本机 Windows 11 ARM64、Node 24.20.0 已完成十个固定引擎的 Chat + Skill 注入 + stdio MCP 成功链路：Codex、Gemini、Qwen、Pi、MiMo、DSH、OpenClaw、Kimi、OpenCode、Hermes。Codex/Gemini 经过本地 Chat Completions 转换；Hermes 使用固定 x64 Python 仿真。加上 Pi 初始化失败、执行中取消，共十二个分支通过。MiMo 在原生日志等级修复后通过全量秘密扫描。

HTTP/SSE 的配置映射已实现，当前固定程序验收用例不覆盖远程服务器的 OAuth、TLS 证书或资源/提示词调用。没有提供这些能力的等价承诺。
