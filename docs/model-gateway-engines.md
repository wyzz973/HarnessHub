# 引擎经统一模型网关接入

本页说明 Worker 在准备 Session 配置时，如何让每个引擎只经 [统一模型网关](model-gateway.md) 使用 HarnessHub 配置的同一个模型，以及各引擎写入的原生配置项、上下文窗口与输出上限的映射和已知限制。取舍见 [ADR 0013](decisions/0013-unified-model-gateway.md)；实现位于 [prepare.ts](../src/drivers/configuration/prepare.ts)，Run 结果与错误语义位于 [Worker](../src/worker/main.ts)、[outcome.ts](../src/worker/outcome.ts) 与 [diagnostics.ts](../src/worker/diagnostics.ts)。统一模型如何写入引擎登记见 [引擎独立配置](engine-configuration.md)。

各引擎配置项均按 `vendor/engine-sources` 中的固定源码核对：Codex 0.153.4 与 codex-acp 1.10.0、claude-agent-acp 0.75.1、Gemini CLI 0.58.0、OpenCode 1.18.29、MiMo 0.1.14、Pi 0.85.1 与 pi-acp 0.0.33、Qwen Code 0.23.0、Hermes 0.19.0、OpenClaw 2026.9.2、DSH 0.1.2-rc.1、Kimi CLI 1.50.0。Claude Code 本体与 Copilot CLI 不在源码快照中：Claude Code 的变量按本机安装的 2.1.278 二进制和 SDK 0.3.257 核对，Copilot 沿用原有 BYOK 映射。以上都是源码与配置层面的核对，固定版本引擎经网关的真实任务尚未验收。

## 何时经过网关

`configuration.provider.protocol` 为 `openai-completions` 时，只要适配器可路由，Worker 就在第一次 Run 准备配置时启动本 Session 的网关，并传入：

| 网关选项 | 来源 |
|---|---|
| `upstream.baseUrl`、`upstream.apiKey` | `provider.baseUrl`；`provider.apiKey` 只在 Worker 内解析 |
| `upstream.headers` | `provider.headers` 原样加上 Worker 内解析的 `provider.secretHeaders` |
| `model` | 登记的 `model`，即上游真实模型 |
| `alias` | `provider.modelAlias`，缺省 `harnesshub-model` |
| `contextWindow`、`maxOutputTokens`、`compatibility` | provider 同名字段，未配置时不传 |

可路由适配器为 codex、claude、gemini、opencode、mimo、pi、qwen、hermes、openclaw、dsh、kimi、copilot。cursor、antigravity、kiro、qoder、generic 只能使用引擎自带账号，登记 provider 时校验失败；绕过登记的 Profile 在准备阶段以 `ENGINE_CONFIGURATION_UNSUPPORTED` 失败，不启动网关。其他上游协议（Responses、Anthropic、Google）保持原来的直连映射，不经过网关，也不做下面的凭据隔离。

写入引擎的窗口与输出上限：provider 配置了 `contextWindow`、`maxOutputTokens` 时原样使用；未配置时写入 131072 与 min(16384, 窗口的一半)。这两个缺省值只写入引擎配置，不传给网关，因此网关不会据此截断。引擎自带的缺省值差异很大（OpenCode 32000 输出且未知窗口不压缩、Hermes 65536、Qwen 200K/32000、Pi 128K/16384、Gemini 1M），公司模型应显式配置这两项。

## 凭据与目录隔离

引擎只拿到回环地址、本 Session 的随机令牌和 alias，令牌写入 `HARNESSHUB_PROVIDER_KEY` 及各引擎自己的变量。准备时：

- 从启动模板、普通 env 和引擎级 secretEnv 得到的环境中，删除 [厂商凭据变量](../src/drivers/configuration/prepare.ts)（`VENDOR_CREDENTIAL_ENVIRONMENT`，包括 OpenAI/Codex、Anthropic/Claude、Google/Gemini、Moonshot/Kimi、DeepSeek、DashScope、OpenRouter 等 API Key、Base URL 与账号开关）；Copilot 另外删除 `GH_TOKEN`、`GITHUB_TOKEN`。
- `PreparedConfiguration.unsetEnv` 列出上述变量、登记的 `credentialEnv`，以及 provider apiKey/secretHeaders 的 env 引用源变量；Worker 启动引擎前从进程环境中删除它们（大小写不敏感），然后才写入准备好的环境。公司密钥因此不进入引擎进程。
- 启动模板中指向用户目录的引擎根目录变量（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GEMINI_CLI_HOME`、`QWEN_HOME`、`PI_CODING_AGENT_DIR`、`HERMES_HOME`、`DSH_HOME`、`OPENCLAW_STATE_DIR`、`KIMI_SHARE_DIR` 等）被丢弃，由各适配器改为 `<stateDir>/configuration` 下的私有目录。
- `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME` 一律改为 `<stateDir>/home` 下与 Worker 宿主一致的路径，覆盖把 HOME 指向真实用户目录的发现模板，也覆盖发行包 `engine-homes/<id>` 的跨 Session 目录。原生登录文件（auth.json、.credentials.json、OAuth 令牌）因此不会被读取。
- `NO_PROXY`/`no_proxy` 追加 `127.0.0.1,localhost`，避免继承的代理截获回环请求。

MCP 服务显式配置的 secretEnv/secretHeaders 不受影响：它们由 ACP 或原生 MCP 配置直接交给对应服务。令牌仍在引擎进程环境中，引擎的 Shell 工具可以读到；它只能访问本 Session 的回环网关，Session 结束即失效，这不是操作系统级隔离。

## 各引擎映射

| 引擎 | 入站协议 | 原生配置 | 窗口与输出 | 关闭的额外模型与外联 |
|---|---|---|---|---|
| Codex | Responses | 私有 `CODEX_HOME/config.toml`：`model_provider = "harnesshub"`、`base_url = <网关>/v1`、`wire_api = "responses"`、`env_key`、`requires_openai_auth = false`；alias 的 `model_catalog_json` | `model_context_window` 与目录 `context_window`；`model_auto_compact_token_limit` = min(0.9×窗口, 窗口−输出)；Codex 不发送输出上限 | web_search、plugins、apps、image_generation、memories、analytics、OTEL 指标、无限重连；Guardian 见下节 |
| Claude Code | Anthropic | 环境：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 均为令牌；私有 `CLAUDE_CONFIG_DIR`、`ANTHROPIC_CONFIG_DIR`；所有模型角色变量为 alias | `CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`（至多 128000） | 非必要流量、遥测、错误上报、更新、实验 beta、advisor、自动记忆、模型回退；`settings.json` 禁用 WebSearch 并跳过 WebFetch 预检 |
| Gemini CLI | Google | 环境：`GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL`、私有 `GEMINI_CLI_HOME`、`GEMINI_FORCE_FILE_STORAGE`；系统设置：`gemini-api-key`、`model.name` 与 `core` 覆盖均为 alias | `core` 覆盖写入 `maxOutputTokens`；`compressionThreshold` 按窗口换算 | 子代理（codebase_investigator、cli_help 等）、`invoke_agent`、google_web_search、web_fetch、LLM 修正、循环检测、使用统计、遥测、IDE |
| OpenCode、MiMo | Chat | `OPENCODE_CONFIG_CONTENT`/`MIMOCODE_CONFIG_CONTENT`：`@ai-sdk/openai-compatible`、`baseURL = <网关>/v1`、alias；`small_model`、内置 agent 与 MiMo `model_groups` 均为 alias | `limit.context`、`limit.output`；输出超过 32000 时设 `*_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | 模型目录拉取、已存登录（`*_AUTH_CONTENT={}`）、分享、LSP 下载；OpenCode 默认插件；MiMo 分析上报、环境凭据探测、Claude 配置导入 |
| Pi | Chat | 私有 `PI_CODING_AGENT_DIR` 的 models.json（`apiKey: "$HARNESSHUB_PROVIDER_KEY"`、alias、`compat`）与 settings.json | `contextWindow`、`maxTokens`；压缩保留至少一次完整输出 | `PI_OFFLINE`、安装遥测、thinking |
| Qwen Code | Chat | `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`；私有 `QWEN_HOME`；`QWEN_CODE_SYSTEM_SETTINGS_PATH` 固定 `openai` 认证 | `contextWindowSize`、`samplingParams.max_tokens` 与 `QWEN_CODE_MAX_OUTPUT_TOKENS` | 后续建议、托管记忆、Web 搜索、自动标题、使用统计 |
| Hermes | Chat | 私有 `HERMES_HOME/config.yaml`：`custom` provider、`key_env`、alias；全部辅助任务固定到同一路由；私有 `HERMES_MANAGED_DIR` | `model.context_length`、`model.max_tokens`，压缩辅助任务同窗口；窗口低于 64000 明确失败 | 回退 provider、标题生成、模型目录、tirith 下载、LSP 自动安装；不发送 ACP 选模型 |
| OpenClaw | Chat | 私有 `openclaw.json`：`models.mode: "replace"`、harnesshub provider 的 SecretRef、alias；primary、utility、压缩、记忆刷新、子代理均为 alias | 模型定义 `contextWindow`、`maxTokens` | 更新检查、模型目录刷新、OpenAI 嵌入的记忆搜索、图片工具、Web 搜索、heartbeat |
| DSH | Chat | `--patch` 覆盖：`llm-pi-ai` 的 harnesshub 路由（`apiKeyEnv`、alias、`compat`），`agent-default-model` 与 `acp` 选中该路由 | 路由与模型的 `contextWindow`、`maxTokens` | 遥测（`DSH_TELEMETRY_DISABLED`） |
| Kimi CLI | Chat | 私有 `--config-file`：`openai_legacy`、alias、`--model <alias>`；`OPENAI_BASE_URL`/`OPENAI_API_KEY` 覆盖文件值 | `max_context_size` 取 provider 窗口，否则 `KIMI_MODEL_MAX_CONTEXT_SIZE`；`reserved_context_size` 取输出上限；Kimi 不发送输出上限 | 遥测、自动更新、合并其他目录的 Skills |
| Copilot CLI | Chat | `COPILOT_PROVIDER_TYPE=openai`、`COPILOT_PROVIDER_BASE_URL`、`COPILOT_PROVIDER_API_KEY`、`COPILOT_MODEL`、`COPILOT_OFFLINE` | 未写入：没有固定源码可核对对应变量 | GitHub 账号令牌变量被删除 |

Codex 与 Kimi 请求不带输出上限，网关只在引擎给出上限时按 `maxOutputTokens` 截断，因此这两个引擎的实际输出上限由公司上游的缺省值决定。Codex、Claude Code、Gemini、Hermes、OpenClaw、Copilot 的模型由原生配置选定，Worker 不再通过 ACP 选择模型；其余引擎的 ACP 选择值同样指向 alias。

## Codex 认证与 Full Access

codex-acp 只在 app-server 报告当前 provider 需要 OpenAI 登录且没有账号时返回 ACP `Authentication required`。自定义 provider 显式设置 `requires_openai_auth = false`，不会触发这条路径。作为兜底，`DEFAULT_AUTH_REQUEST` 选择 `api-key` 方法、`CODEX_API_KEY` 为本地令牌，`openai_base_url` 也指向网关，所以即使回落到内置 OpenAI provider，请求仍只到网关。ChatGPT 登录由 `forced_login_method = "api"` 与 `NO_BROWSER` 关闭，凭据存储为 `ephemeral`，私有 `CODEX_HOME` 让钥匙串键也与用户目录不同。

codex-acp 缺省的 `agent` 模式用另一个 Guardian 模型自动审批，因此普通模式固定为 `INITIAL_AGENT_MODE=read-only`，审批经 ACP 回到 HarnessHub。Worker 环境中 `HARNESSHUB_FULL_ACCESS=1`，或登记命令已设置 `INITIAL_AGENT_MODE=agent-full-access`（比赛 Full Access 由发行包写入）时，保持 `agent-full-access`，不再改回只读。

## MCP 与会话工作目录

每个启用的 stdio MCP 服务，其 `args` 每一项和 `env` 每个值中的字面量 `${HARNESSHUB_SESSION_WORKSPACE}` 在运行时替换为 Session 的绝对工作目录（比赛中即评测方传入的 `directory`）。替换是纯字符串替换，不做转义，路径中的 `$` 没有特殊含义；发生在 Windows 启动器包装命令之前，也在 Copilot、Pi、OpenClaw、Kimi 写原生 MCP 文件之前。`command`、secretEnv/secretHeaders 的值、HTTP/SSE 的 URL 与请求头不替换。已保存的 revision 保留占位符。

## Run 结果与错误

- 网关每次调用的 `ModelCallRecord` 由 Worker 作为 `model.call` 事件按 IPC 顺序上报，在 Run 结果之前全部送达；Run 之外的调用没有 Run 身份，不上报。错误消息再按本 Session 秘密脱敏并限制为 500 个字符。
- 经网关的引擎，Run 出现过上游失败（`runErrors()` 非空），且没有非 thought 文本、工具事件或权限请求，或者本 Run 没有一次成功的模型调用时，结果改为 failed，`MODEL_UPSTREAM_ERROR`，消息形如 `上游模型返回 HTTP 400：<脱敏的上游原因>`。第二个条件覆盖把上游错误当作正文输出的引擎（例如 codex-acp）。取消的 Run 不改写。
- 经网关的引擎以 completed 结束，但本 Run 没有任何模型调用、文本、工具事件时，改为 failed，`ENGINE_NO_OUTPUT`，消息为“引擎未调用模型也未产生输出”。
- 非 HubError 异常以 `DRIVER_ERROR` 公开脱敏后的真实原因（含 ACP RequestError 的 message、`data.message`/`details` 与 cause 链，至多 500 个字符），不再使用固定文案。脱敏删除本 Session 已解析的秘密值与网关令牌，以及 Bearer、`sk-`、token/key/secret/password 赋值形态。完整堆栈与 cause 链脱敏后追加写入 `<stateDir>/diagnostics/worker-errors.log`（目录 0700、文件 0600；Windows 依赖 Session 私有目录的 ACL）。
- Runtime 对 failed 结果回收 Worker 并关闭 ACP Session，改判后的 Run 同样如此；比赛接口需要为下一轮新建 Session。ACP 驱动在 prompt 失败时仍只返回 `ACP_TURN_FAILED` 固定文案，这部分不在 Worker 内改写。

## 验证

单元与集成测试使用本地假上游和假 ACP 引擎，不调用真实模型：

- [gateway 接入配置](../tests/unit/model-gateway-configuration.test.ts)：各适配器的原生配置指向网关、使用 alias、写入窗口与输出上限、请求头秘密不落盘、厂商变量与用户目录被移除、Full Access 保留、不可路由适配器报错、占位符替换（含带空格与中文的 Windows 路径）以及 provider 字段校验。
- [Worker 结果语义](../tests/unit/worker-outcome.test.ts)：`MODEL_UPSTREAM_ERROR`、`ENGINE_NO_OUTPUT`、事件数据、脱敏、截断与诊断日志。
- [正式 Gateway/Worker 集成](../tests/integration/chat-completions.test.ts)：OpenCode、Qwen、Pi 三种原生配置经同一网关到达同一上游模型并带公司密钥与请求头；上游 400 使 Run 失败并带真实原因；`model.call` 事件提交到 SQLite；引擎环境不含厂商与上游秘密；数据库不含公司密钥、厂商密钥与网关令牌；Codex/Gemini 经 Responses 与 Google 入口完成 MCP、Skills、权限、产物与取消；ACP 会话创建时的 `Authentication required` 以真实原因公开并写入诊断日志。

```sh
pnpm build
node --test dist/tests/unit/model-gateway-configuration.test.js dist/tests/unit/worker-outcome.test.js
node --test dist/tests/integration/chat-completions.test.js
```

未验证：固定版本引擎经网关的真实任务（`native-mcp-engines` 的显式验收在 Windows ARM64 准备包上运行，本次未执行）、Windows x64、公司真实模型；Copilot 的窗口与输出变量；各引擎在私有 HOME 下首次启动时的离线行为（例如 OpenCode/MiMo 后台安装插件包失败被忽略、pi-acp 每次新建会话执行一次 `npm view`）。
