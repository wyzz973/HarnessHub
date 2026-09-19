# 引擎独立配置

## 统一模型

配置统一模型后，所有引擎只使用 HarnessHub 配置的同一个模型，不能再使用引擎自带的 API Key、登录态、订阅或各自的 Provider。类型见 [统一模型定义](../src/domain/harness-model.ts)，决定见 [ADR 0013](decisions/0013-unified-model-gateway.md)，实现见 [统一模型服务](../src/application/harness-model.ts)。未配置统一模型时，本页后续的逐引擎配置保持原有行为。

### 三种配置方式

三种来源任选其一；同时存在时按下表优先级取用，低优先级来源被忽略。启动时会校验所有已提供的来源，任何一个无效都会导致启动失败；模型文件不存在视为未配置。

| 优先级 | 来源 | 写入方式 | 生效范围 |
|---|---|---|---|
| 1 | 环境变量 `HARNESSHUB_MODEL*` | 启动前由评测系统或启动脚本设置 | 仅本次进程，不写回文件；此时 `PUT /v1/harness/model` 返回 409 `HARNESS_MODEL_ENVIRONMENT_OVERRIDE` |
| 2 | 统一模型文件 | `PUT /v1/harness/model`、控制台统一模型页、`hub.cmd model set` | 发行包为 `state/harness-model.json`；源码入口默认 `<数据目录>/harness-model.json`，可用 `--harness-model-file` 指定；PUT 立即生效，`hub.cmd model set` 在下次启动生效 |
| 3 | 配置文件顶层 `model` | 发行包 `state/settings.json`（经 `hub.cmd configure`），或源码入口 `--config` 指定的 YAML/JSON | 修改后需要重启；热加载会返回 `CONFIG_RESTART_REQUIRED`，不部分生效 |

环境变量如下。只要设置了 `HARNESSHUB_MODEL`，环境变量来源就生效。以下情况会启动失败：设置了 `HARNESSHUB_MODEL` 但缺少 `HARNESSHUB_MODEL_BASE_URL`；设置了基址、协议、上下文窗口或输出上限变量，却没有设置 `HARNESSHUB_MODEL`。只设置 `HARNESSHUB_MODEL_API_KEY` 不会启用环境变量来源，文件或 settings 可以引用这个变量。

| 变量 | 含义 |
|---|---|
| `HARNESSHUB_MODEL` | 上游真实模型 ID |
| `HARNESSHUB_MODEL_BASE_URL` | 上游 Chat Completions 基址，通常是网关的 `/v1` 根路径，不要填到 `/chat/completions` |
| `HARNESSHUB_MODEL_API_KEY` | 密钥值本身；配置中只记录引用 `{"kind":"env","value":"HARNESSHUB_MODEL_API_KEY"}`，未设置时上游请求不带密钥 |
| `HARNESSHUB_MODEL_PROTOCOL` | 上游协议；缺省为 `openai-completions`，目前也只允许这个值 |
| `HARNESSHUB_MODEL_CONTEXT_WINDOW` | 模型上下文窗口，正整数 token |
| `HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS` | 模型最大输出，正整数 token |

文件内容、settings 顶层 `model` 和 `PUT` 请求体都是同一个 `HarnessModel` 对象。以下为格式示意，尖括号内容需替换：

```json
{
  "model": "<上游模型 ID>",
  "alias": "harnesshub-model",
  "provider": {
    "protocol": "openai-completions",
    "baseUrl": "https://<模型网关>/v1",
    "apiKey": { "kind": "env", "value": "COMPANY_MODEL_API_KEY" },
    "headers": { "X-Tenant": "<非秘密值>" },
    "secretHeaders": { "X-Gateway-Token": { "kind": "env", "value": "GATEWAY_TOKEN" } },
    "contextWindow": 131072,
    "maxOutputTokens": 16384
  }
}
```

- `provider.protocol` 表示上游协议，只接受 `openai-completions`，即流式 Chat Completions；其他协议返回 `HARNESS_MODEL_PROTOCOL_UNSUPPORTED`。
- `provider.baseUrl` 必填，只允许 HTTP(S)，不能包含账号、查询参数或片段。
- `apiKey` 和 `secretHeaders` 只接受秘密引用，规则同下文“密钥与环境”，不能直接填写密钥。普通 `headers` 不能包含 Authorization、Cookie 或名称含 token、key、secret、password、credential 的请求头，也不能包含看似凭据的值；同名请求头不能同时出现在 `headers` 和 `secretHeaders` 中。
- `alias` 是引擎看到的模型名，缺省 `harnesshub-model`，用于避开引擎按模型名做的路由和上限推断。上游请求始终使用真实 `model`。`alias` 与 `provider.modelAlias` 同时填写时必须一致。
- `contextWindow` 取值 1024–16777216，`maxOutputTokens` 取值 16–4194304，且输出上限不能大于上下文窗口。
- 兼容选项 `provider.compatibility` 可省略，由 Worker 内的模型网关执行，行为见 ADR 0013：`includeUsage` 控制是否发送 `stream_options.include_usage`，默认 false；`dropParameters` 追加要删除的上游请求参数；`maxTokensField` 选择输出上限字段，默认 `max_tokens`，也可为 `max_completion_tokens`；`reasoning` 为 `passthrough`（默认）或 `strip`。

### 强制生效

Gateway 在每个引擎登记或替换前应用统一模型。文件配置加载与热加载、`POST/PUT /v1/engines`、SQLite overlay 恢复和工具包 apply 都经过同一个登记策略，效果如下：

- 登记的 `model` 改为上游真实模型；`configuration.provider` 改为统一 Provider，并写入 `modelAlias`。登记中原有的模型和 Provider 被覆盖。
- 移除 `credentialEnv` 和引擎级 `configuration.secretEnv`，厂商凭据不再传给引擎进程。引擎的 `adapter`、普通 `env`、Skills、MCP 服务及其自身的秘密引用保持不变。
- 以下引擎会被停用：适配器为 cursor、antigravity、kiro、qoder 或 generic 的引擎；没有声明适配器、且 ID 也不是内置引擎的引擎；应用统一模型后被引擎层校验拒绝的登记，例如固定 Provider 的自定义启动脚本、ACP 方式的 Kimi。内置引擎 ID（codex、claude、opencode、openclaw、hermes、mimo、gemini、copilot、kimi、qwen、pi、dsh 等）在未声明适配器时按同名适配器处理。
- 覆盖和停用的原因会出现在 `GET /v1/harness/model` 的引擎状态中；为停用引擎创建 Session 时，`ENGINE_UNAVAILABLE` 也会带上原因。
- 演示引擎 `fake` 不调用模型，不受统一模型影响。
- 配置文件和 overlay 保存原始登记。`GET /v1/engines`、登记接口的响应和新 Session 使用应用统一模型后的 revision，两种 revision 都会持久化。统一模型变化时（PUT，或重启后来源变化），全部引擎生成新 revision；已有 Session 继续使用创建时的 revision。去掉统一模型并重启后，会恢复原始登记。
- 比赛模式下，启动引擎（`--engine` 或 `AGENT_ENGINE`）不可用时，Gateway 启动失败并给出原因。源码入口若只设置了 `AGENT_ENGINE` 和 `HARNESSHUB_MODEL*`，而配置中没有该引擎，Gateway 会按内置发现配方登记本机安装的同名引擎；发现不到则启动失败。

### 接口与命令

- `GET /v1/harness/model` 返回 `HarnessModelView`：`configured`、`source`、`model`、`alias`、只含秘密引用的 `provider`，以及每个引擎的 `{engineId,status,reason?}`。`status` 取值：`applied` 已使用统一模型；`unsupported` 无法接入并已停用；`disabled` 登记本身为停用。
- `PUT /v1/harness/model` 的请求体为 `HarnessModel`。校验通过后原子写入模型文件，为全部引擎发布新 revision，返回 `HarnessModelView`。POSIX 下文件权限为 0600；Windows 下不额外设置 ACL，依赖所在 state 目录的权限。文件只保存秘密引用，不保存密钥。
- `POST /v1/harness/model/test` 的请求体为 `{"engineId"?}`。Gateway 在默认引擎或指定引擎上，用私有临时目录创建 Session，提交“只回复 OK”，最多等待 90 秒，结束后关闭 Session。返回 `{ok,status,durationMs,runId,error?}`，只有 Run 正常完成且回复非空时 `ok` 为 true。该接口会实际调用模型并消耗额度，密钥只在 Worker 中解析。以下情况返回错误：未配置统一模型（409）；演示引擎或未应用统一模型的引擎（409）；已有测试在运行（429）。
- `GET /v1/runtime/info` 返回 `{competition, competitionEngine?, fullAccess, consoleUrl?}`，其值在 Gateway 启动时确定。
- 发行包中，`hub.cmd model set --model <id> --base-url <url> --api-key-env <NAME> [--context-window N] [--max-output-tokens N] [--header NAME=VALUE]... [--alias NAME]` 校验后写入 `state/harness-model.json`；如果当前环境设置了 `HARNESSHUB_MODEL` 或缺少密钥变量，命令会给出提示。`hub.cmd model show` 和 `hub.cmd doctor` 显示生效来源和各引擎状态。这三个命令都不调用模型。
- `settings.json` 顶层 `model` 可以与旧的 `modelProfiles` 和逐引擎 `modelProfile` 共存，此时统一模型优先。随包示例（`examples/deepseek.json`、`examples/company-chat.json`）只使用统一模型。

## 逐引擎配置

控制台“引擎管理”中，每个已注册引擎有“配置”和“检查连接”入口。配置弹窗支持模型、Provider / URL / API Key、Skills、MCP 和环境变量；保存后生成新 revision，已有 Session 不切换配置。配置了统一模型时，保存的模型和 Provider 仍会被统一模型覆盖。接口字段由 [配置类型与 schema](../src/domain/engine-configuration.ts)定义，决定见 [ADR 0006](decisions/0006-engine-configuration.md)。

## 操作顺序

1. 发现并登记引擎，点击对应行“配置”。
2. 选择实际使用的配置适配器与模型。保留“沿用原生账号与配置”时只调整明确填写的字段。
3. 使用自定义 Provider 时选择协议，填 API URL 和密钥来源；界面只列出该适配器支持的协议。
4. 添加 Skills 的绝对 SKILL.md 路径；在 MCP 页添加服务，并以 enabled 选择启停。
5. 保存配置。校验失败不会替换现有目录；成功后新建 Session 使用新 revision。
6. “检查连接”解析配置/秘密引用/Skill 指纹，并对 ACP 执行 initialize。此步骤不调用模型、不证明认证/额度有效，也不执行 MCP 工具。“测试模型”会使用当前引擎配置发送一条简短请求并打开正式任务记录，沿用 Gateway 预算与取消/权限流程；会实际消耗所配置模型的额度。工具验证继续使用任务工作台创建明确任务。

固定 Provider 的旧 launcher（例如本机独立 OpenCode DeepSeek、定制 Pi）会拒绝被新 Provider 字段隐式覆盖。需要切换时明确勾选“使用本机标准启动模板”，审阅展示的命令后保存；原 revision 和旧会话仍保留。

ACP 注册配置可单独填写 `acp.initializeTimeoutMs`，范围为 1–60,000 毫秒，不要求启用 `sessionMode: resume`。HTTP 注册、更新、列表与控制台编辑均保留此字段；检查连接和实际 Worker 启动使用同一上限。恢复会话也要完成真实重连和 resume 后才能解除初始化计时，不能用旧 checkpoint 的 capabilities 提前解除。此字段只限制初始化，不延长 Run 的总期限；发行包仅对冷启动较慢的指定引擎配置较长上限。

## Provider 适配范围

| 配置适配器 | 支持的协议/行为 |
|---|---|
| Codex | OpenAI Responses；显式 Chat Completions 使用本地 Driver bridge；私有 CODEX_HOME/config.toml |
| Claude Code | Anthropic；进程级 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL |
| OpenCode、MiMo | OpenAI Chat Completions、Responses、Anthropic；进程级配置选择 harnesshub/model，Key 用环境替换语法 |
| OpenClaw | OpenAI Chat Completions、Responses、Anthropic；独立 OPENCLAW_STATE_DIR 与原生 Gateway，models provider 使用环境 SecretRef |
| Hermes | OpenAI Chat Completions；私有 HERMES_HOME/config.yaml，custom provider 使用 `key_env: HARNESSHUB_PROVIDER_KEY`；ACP 模型选择使用 custom:model |
| Pi | OpenAI Chat Completions、Responses、Anthropic；私有 models.json/settings.json，固定 Pi 0.85.1 的 API Key 引用为 `$HARNESSHUB_PROVIDER_KEY` |
| Gemini CLI | Google；显式 Chat Completions 使用本地 Driver bridge；独立模型与本地认证令牌 |
| Qwen Code | OpenAI Chat Completions；OPENAI_MODEL / OPENAI_BASE_URL / OPENAI_API_KEY |
| Copilot CLI | OpenAI Chat Completions、Anthropic；COPILOT_PROVIDER_TYPE / BASE_URL / API_KEY 与 COPILOT_MODEL；启用 COPILOT_OFFLINE，不需要 GitHub 账号 |
| Cursor、Antigravity | model 转为 CLI 的 `--model` 参数；仍使用原生账号/API；不支持此层的任意 Provider URL |
| Kimi CLI | OpenAI Chat Completions、Responses、Anthropic、Google；仅 `driver: cli` 的 `--quiet` / `--print` 模板，私有无密钥 JSON，密钥经 SDK 环境变量；ACP 自定义 Provider 明确拒绝 |
| DSH | OpenAI Chat Completions、Responses、Anthropic；私有 profile overlay 配置 `llm-pi-ai`，密钥只经 `apiKeyEnv` 引用；ACP 使用包含 provider/model 的原生模型选择值 |
| Kiro、Qoder、generic | 保留原生 Provider 配置；可配置该引擎明确支持的普通环境与秘密映射，不能把不支持的统一 Provider 字段保存后忽略 |

上表是逐引擎配置时各适配器接受的协议。配置统一模型时，登记中的上游协议固定为 `openai-completions`，各适配器由 Worker 如何接入统一模型见 ADR 0013；如果某适配器的登记校验不接受该协议，引擎会按[统一模型](#统一模型)一节被停用，并给出原因。

实际能力随安装版本、原生账户、原生配置合并和后端协议而变化。配置适配不等于所有厂商版本均已完成真实任务验收；本轮版本与证据见 [验收记录](verification/2026-09-05-engine-configuration.md)。不自动改变模型预算或安装依赖。工作区原生指令、原生 MCP、插件和工具仍由对应引擎管理；本页的显式 MCP/Skills 不宣称禁用了所有原生工具。

## 密钥与环境

Codex 对 `deepseek-v4-flash` 额外写入 `model_catalog_json`，按[DeepSeek 官方 Codex 集成](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)声明 1,048,576 上下文、文本输入与推理等级。目录只含该模型；未知名称仍交由 Codex 处理。目录保留 Codex 0.153.4 自身默认基线，没有复制 DeepSeek 网页的系统提示词，也不含密钥。Pi 固定为 `@earendil-works/pi-coding-agent@0.85.1`，其 models.json 使用 `$HARNESSHUB_PROVIDER_KEY` 插值；旧 0.73.1 的裸变量名语法不再适用。升级同时提供 pi-acp 0.0.33 完成请求所需的 `agent_settled` 事件。

Copilot 的映射针对固定 CLI 1.0.83，按[官方 BYOK 环境变量](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)配置。模型必须支持 streaming 和工具调用；此处不把 SDK 的 Responses 能力推断为 CLI 的支持。`COPILOT_OFFLINE=true` 禁止访问 GitHub 服务，配置的模型 API 仍会收到请求。命令已有固定 `--model` 时拒绝覆盖。

固定 Copilot 1.0.83 的 ACP 只接受 HTTP/SSE MCP。显式选择的 stdio 服务由配置适配器写入 Session 私有的 `copilot-mcp.json`，通过原生 `--additional-mcp-config @文件` 加载，不再重复向 ACP 注入。环境值只在文件中保存 Copilot 的变量引用，真实值传给所属子进程；HTTP/SSE 仍沿用 ACP。命令已经含该原生参数时明确拒绝管理，避免两个配置来源覆盖。配置文件和模板不会写入实际 MCP 秘密。

Kimi 1.50.0 的[原生 ACP 服务](https://github.com/MoonshotAI/kimi-cli/blob/1.50.0/src/kimi_cli/acp/server.py)在创建会话时要求 Kimi OAuth；旧 `--acp` 入口已经拒绝协议方法。统一 API 应选择 CLI 模板 `["<绝对 kimi.exe 路径>","--quiet","--prompt","{prompt}"]`。它逐 Run 启动，沿用 CLI 输出与进程清理契约；不承诺 ACP 会话恢复或原生结构化用量。MCP 通过独立 `--mcp-config-file` 接入，print 模式原生自动批准工具；秘密字段限制见 [原生 MCP](native-mcp.md)。Skills 仍可作为任务指令前缀。

Kimi 必须在普通 `env` 填写模型实际上下文窗口，例如 `{"KIMI_MODEL_MAX_CONTEXT_SIZE":"131072"}`；数值仅为格式示例，应按模型契约填写，系统不替用户猜测上下文预算。配置层生成私有 JSON，并传 `--config-file`；命令已有固定配置参数会拒绝。OpenAI 两协议使用 `OPENAI_API_KEY`；Google 使用 `GOOGLE_API_KEY`；Anthropic 使用 `ANTHROPIC_AUTH_TOKEN`，请求为 **Authorization: Bearer**，只接受 `X-Api-Key` 的网关须选其他适配器。Base URL 应填写该协议 SDK 的基址，Anthropic/Google SDK 会追加自身 API 路径。四种映射已经通过固定 Windows 二进制与本地合成 HTTP/SSE fixture 验证，真实模型认证、工具调用和额度另行验收。[协议与环境实现依据](https://github.com/MoonshotAI/kimi-cli/blob/1.50.0/src/kimi_cli/llm.py)。

`provider.apiKey` 或 `secretEnv` / `secretHeaders` 使用 `{kind,value}` 引用：

- `kind: env`：value 是 Gateway 启动环境中的变量名称；Windows 大小写不敏感，存在值不同的大小写别名时明确失败。
- `kind: file`：value 是绝对路径；必须为普通文件、非符号链接、至多 8 KiB，POSIX 下不允许组/其他用户权限；Windows 检查所有者与 DACL，拒绝其他用户授权及路径中的 reparse point。文件内容为单行密钥，不是整份 .env。
- `kind: keychain`：value 是此应用创建的 UUID。该稳定引用类型在 macOS 对应 Keychain，在 Windows 对应当前用户的 DPAPI 加密存储；不能读取任意其他应用的秘密。

例如引擎 A 的 `secretEnv` 可配置 `{"OPENAI_API_KEY":{"kind":"env","value":"ENGINE_A_KEY"}}`，引擎 B 则引用 ENGINE_B_KEY。目标变量名相同，解析后的值属于不同 Worker。同一来源在一次准备中只解析一次，并发解析最多4项；Provider字段的原生映射优先于普通/秘密环境映射，应避免重复设置同一个Provider选项。普通 env 不接受常见秘密名称及进程控制变量；敏感 MCP 请求头必须用 secretHeaders。Authorization 引用应包含所需完整值，例如 Bearer 前缀。

新密钥保存到系统安全存储，不写 SQLite/配置/IPC/argv；没有提供读取原值的 HTTP API。Windows 密文位于当前 Windows 账户的 LocalApplicationData/HarnessHub/secrets-v1，目录限制为当前用户可访问，以 DPAPI CurrentUser 加密。复制配置引用到另一台机器或账户不会复制秘密。每次更换 Key 都创建新引用，旧引用保留以支持历史配置，不自动删除。保存 Key 后若后续配置写入失败，编辑器保留该引用以便重试；未引用 Key 的清理/轮换管理页尚未提供。env/file 的内容由外部管理，重新启动 Worker 时可能读取到更新后的值，不能把引用固定解释成外部秘密值也永久固定。

构建 macOS Keychain helper 需要 Xcode Command Line Tools；Windows helper 使用系统 .NET Framework C# 编译器。`pnpm build` 自动生成所属平台的 helper。系统安全存储锁定/不可用时明确报错，不自动写到明文文件。Linux 使用 env/file 引用。秘密会进入所选引擎和工具的内存环境；同一 Windows 用户下的程序可以调用 DPAPI，不宣称对这些进程构成秘密隔离。取舍见 [Windows 密钥存储](decisions/0008-windows-secret-storage.md)。

## Skills 与 MCP

Skills 为 `{path,enabled,sha256?}` 数组，最多 16 项。每项主指令限 64 KiB、合计 256 KiB；这些是本层新增输入的限制，不更改模型的输出/上下文预算。保存时 pin 主指令 hash；运行中的 Worker 使用已读取的主指令，重建 Worker 时检查来源是否仍匹配。内容改变后需审阅并重新保存。附件仍引用原目录，不复制/固定整个 Skill 包。

MCP 最多 16 项，名称唯一：stdio 需要 absolute command，可带 args/env/secretEnv；HTTP/SSE 需要 url，可带 headers/secretHeaders。URL 只允许 HTTP(S)，不允许内嵌身份、query 或 fragment；请用请求头秘密引用。程序按 argv 启动，配置本身不会执行脚本或安装包。enabled:false 不解析其秘密也不下发。Pi 通过本地扩展注册工具，OpenClaw 使用原生 Gateway 的 `mcp.servers`，Kimi CLI 使用独立 MCP 文件，具体要求和验证见 [原生 MCP](native-mcp.md)。其他普通 CLI 明确拒绝统一注入；其他 ACP 引擎下发后的服务建立、工具审批和调用按引擎协议分别验证。

公司只支持 Chat Completions 时，Codex/Gemini 可显式选择 `openai-completions`。协议转换范围、错误/断流/取消及资源责任见 [ADR 0011](decisions/0011-chat-completions-bridge.md)，免安装和公司代码合并见 [公司离线交接](offline-company.md)。原生托管搜索、多模态等未支持请求会明确失败，不提供所有厂商 API 的等价实现。

Qwen 0.23.0 的 ACP 首次请求会与后台 MCP 发现竞争。选择启用的 MCP 时，配置层设置原生 `QWEN_CODE_LEGACY_MCP_BLOCKING=1`，使初始化等待工具注册后再调用模型；不改变模型选择、工具权限或 Run 总期限。没有启用的 MCP 时不设置该选项。已通过固定 Windows 包与本地合成 API 验证首次请求的工具列表、秘密环境和进程清理；真实模型任务另行记录。

## 接口与兼容

- `POST /v1/engine-configuration/inspect`：输入完整注册配置，返回校验后的 Profile 与 Skill 指纹；不注册、不调用模型。
- `GET /v1/engine-configuration/adapters`：支持的配置适配器与 Provider 协议。
- `GET /v1/engine-configuration/templates`：本机已安装的标准启动模板，忽略自定义 manifest 覆盖，供明确切换使用。
- `POST /v1/secrets`：body 为 value；创建只写的系统安全存储条目，返回 reference。
- `POST /v1/engines/:id/test`：返回 revision、检查时间、分项结果及 modelCalled:false；不记录为模型任务通过。
- 原 POST/PUT 引擎接口接受可选 configuration，全部未知字段仍明确拒绝。

SQLite 业务表版本不变；`runtime_metadata.engine_catalog` 从 version 1 单向升级至 version 2。新版读取旧目录并保持历史 hash，新写入使用 2；未知版本拒绝。旧程序无法读取新目录，应保留升级前备份，不能靠删库或自动回退解决。IPC 为同一发行版本一起更新的 Gateway/Worker 增加可选配置字段，不支持混用新旧二进制。
