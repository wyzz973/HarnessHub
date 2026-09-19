# 验收：统一模型网关与比赛接口（macOS 真实引擎）

日期：2026-09-19
范围：[ADR 0013](../decisions/0013-unified-model-gateway.md) 的统一模型、Worker 模型网关（Chat、Responses、Anthropic、Google 四种入站协议）与比赛接口规范 v1.1。
结果：部分完成。macOS 上 7 个真实引擎通过；Windows x64、离线包固定版本和公司真实模型未验证。

## 环境与版本

- 源码：分支 `feat/unified-model-gateway`，提交 `f42306a`，工作区无未提交改动。
- 系统：macOS 26.6.2 arm64，Node 24.20.0。
- 引擎为本机已安装版本，与离线包的固定版本不同：

| 引擎 | 本机版本 | 入站协议 |
|---|---|---|
| OpenCode | 1.1.21 | Chat |
| Pi | pi 0.85.0 + pi-acp 0.0.33（标准模板） | Chat |
| MiMo | 0.1.0 | Chat |
| Hermes | 0.12.0 | Chat |
| Codex | codex-cli 0.144.5 + codex-acp 1.10.0 | Responses |
| Claude Code | 2.1.278 + claude-agent-acp 0.74.0 | Anthropic |
| Gemini CLI | 0.38.2 | Google |

- 模型：DeepSeek `deepseek-flash`（推理模型，流式返回 `reasoning_content`，支持工具调用），作为公司模型的替身。
- 链路：引擎 → Worker 统一模型网关 → 本机"模拟公司网关"代理 → DeepSeek。模拟网关的规则：
  - 只接受 `stream: true`；
  - 只接受模型 `deepseek-flash`；
  - 拒绝 `stream_options`、`parallel_tool_calls`、`store`、`metadata`、`service_tier`、`reasoning_effort`、`max_completion_tokens`、`developer` 角色、`json_schema` 输出和 strict 工具定义。
- 密钥与账号：真实 Key 只在模拟网关进程中；Gateway 启动时 `HARNESSHUB_MODEL_API_KEY` 为假值；启动环境清除了 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`。
- 启动方式：源码比赛模式，只用环境变量配置统一模型：
  - `AGENT_ENGINE=<id>`、`HARNESSHUB_FULL_ACCESS=1`；
  - `HARNESSHUB_MODEL=deepseek-flash`、`HARNESSHUB_MODEL_BASE_URL=http://127.0.0.1:18080/v1`；
  - `HARNESSHUB_MODEL_CONTEXT_WINDOW=131072`、`HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS=8192`；
  - `node dist/src/main.js --competition --port 6217`。

  Pi 另用标准启动模板生成的 `--config`，因为本机 manifest 登记的是固定 Provider 的自定义脚本，统一模型下会被拒绝。

## 实际执行

每个引擎在全新数据目录启动比赛 Gateway，按规范 v1.1 做两道题：

1. 基础题：`POST /session`（`directory` 为不存在的目录）→ `prompt_async`“只回复 OK 两个字母，不要调用任何工具。”
2. 文件题：新会话 → `prompt_async`“在当前目录创建 hello.py，内容是打印 hello harnesshub，然后运行它，告诉我输出结果。”

每题检查以下几项，最后删除会话：

- `prompt_async` 的状态码；
- `GET /session/{id}/message` 的最后一条助手消息，要求 `info.finish=stop` 且含 `step-finish`；
- SSE 的 `session.status`；
- 文件是否真实生成；
- `/v1/runs/{id}/event-log` 中的 `model.call` 事件。

| 引擎 | 基础题 | 文件题 | 模拟网关请求 | 被拒绝 | 上游模型 |
|---|---|---|---|---|---|
| Pi | 204，回复 OK | 204，文件存在 | 4 | 0 | 全部 deepseek-flash |
| OpenCode | 204，回复 OK | 204，文件存在 | 8 | 0 | 全部 deepseek-flash |
| Gemini | 204，回复 OK | 204，文件存在 | 4 | 0 | 全部 deepseek-flash |
| Claude Code | 204，回复 OK | 204，文件存在 | 6 | 0 | 全部 deepseek-flash |
| Hermes | 204，回复 OK | 204，文件存在 | 7 | 0 | 全部 deepseek-flash |
| MiMo | 204，回复 OK | 204，文件存在 | 7 | 0 | 全部 deepseek-flash |
| Codex | 204，回复 OK | 204，文件存在 | 5 | 0 | 全部 deepseek-flash |

- 每题的 `model.call` 事件中，引擎请求的模型名都是别名 `harnesshub-model`。Codex 内部辅助调用请求的 `gpt-5.6-luna` 也被网关改为统一模型。
- 模拟网关收到的参数只有 `max_tokens`、`stream`、`tool_choice`、`temperature`，以及 Codex 的 `response_format`（已降级为 `json_object`）。
- 部分引擎在本轮结束时还有后台请求（如生成标题），网关按 Run 取消，这些请求记为 499，不影响 Run 结果。
- OpenCode 文件题中，验收脚本在收到 204 后立即检查，没有同时看到 busy 和 idle：204 先于 idle 事件到达脚本。完成判定以 204 和消息为准。

## 验收中发现并修复的问题

| 问题 | 现象 | 修复提交 |
|---|---|---|
| OpenCode 1.1.21 不展开配置里的 `{env:...}` | 网关认证失败，Run 被误报为"引擎未调用模型" | `3731a27`：直接写入本机会话令牌；无令牌的调用记为失败调用 |
| Codex 0.144 模型目录缺少必填字段 | Codex 启动即报 `failed to parse model_catalog_json` | `f42306a`：补齐 `base_instructions` 等字段（0.153.4 会忽略这些字段） |
| Codex 请求带 `parallel_tool_calls` 与 `json_schema` | 被严格网关以 400 拒绝 | `f42306a`：默认去掉 `parallel_tool_calls`，`json_schema` 降级为 `json_object` |
| 模型失败后 ACP 会话被关闭 | 同一会话无法重试 | `47a9d28`：`MODEL_UPSTREAM_ERROR`、`ENGINE_NO_OUTPUT` 保留会话，并加回归测试 |

Codex 的两个问题，真实原因直接出现在公开错误中，例如"上游模型返回 HTTP 400：Unsupported by company gateway: param:parallel_tool_calls"，以前只会显示固定文案。OpenCode 的认证问题一开始被误报为"引擎未调用模型"，要查引擎私有日志才能定位；修复后，无令牌的调用会记为失败调用，Run 的错误会直接指明是凭据接线问题。

## 未验证项与限制

- Windows x64、离线包中的固定引擎版本（Codex 0.153.4、OpenCode 1.18.29、Gemini 0.58.0 等），以及 Qwen、Kimi、OpenClaw、DSH（本机未安装或只有自定义脚本）。
- 公司真实模型 GLM 的参数兼容性、推理内容回传要求和上下文窗口。模拟网关的拒绝清单是保守假设，不代表公司网关的真实规则。
- 长任务、上下文压缩、MCP/Skill/CLI 工具包在真实引擎上的调用、并发会话。
- OpenCode 在全新私有目录首次运行时会从网络安装 `@opencode-ai/plugin`（本机 1.1.21 约 7 秒）。离线包的 1.18.29 源码中，这是分离的后台任务，失败只记警告；只有配置了插件或自定义工具时才会等待它完成（`plugin/index.ts:184`、`tool/registry.ts:187`）。统一模型生成的私有配置不含插件，因此离线时不会阻塞。这一点未在 Windows 离线环境实测。

## 文档与复现

- 验收脚本、模拟网关与结果保存在开发机 scratchpad，未提交；可复用的脚本版本由交付任务放在 `scripts/`。
- 相关文档：[统一模型网关](../model-gateway.md)、[引擎接入](../model-gateway-engines.md)、[比赛接口](../competition-api.md)、[统一模型配置](../engine-configuration.md#统一模型)。
