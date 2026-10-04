# 订阅账号

订阅 provider 的 Credential 是用户自己的订阅账号，而不是 API Key（[ADR-P09](proposals/oss/adr-drafts.md#adr-p09-订阅复用进核心)，取舍见 [ADR 0026](decisions/0026-subscription-accounts.md)）。HarnessHub 只用厂商为第三方应用提供的机制（或驱动用户已安装的官方客户端）使用订阅，不复制其他客户端的 OAuth client ID、User-Agent、originator 或请求头，不改写其他应用的钥匙串条目或凭据文件，也不改写调用方的提示词来规避厂商的分类。每个账号在用户接受该后端当前版本的风险告知之前不可用，并且只服务本机的 Agent。

| 订阅                        | 状态                        | 机制                                                                                                                                             |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ChatGPT（Plus、Pro 等套餐） | 已实现：后端 `siwc`         | OpenAI 的 [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)（预览）                      |
| Codex 自己的 ChatGPT 登录   | 已实现（不是订阅 provider） | 网关的 [Codex 透传](model-gateway.md#codex-透传)：只转发 Codex 自己的请求，HarnessHub 不持有这份登录                                             |
| GitHub Copilot              | 已实现：后端 `copilot`      | GitHub 的 Copilot SDK（用户安装的可选附加组件）驱动用户安装的 Copilot CLI；用户自己的 Copilot CLI 登录，或带 “Copilot Requests” 权限的细粒度 PAT |
| Claude（Free、Pro、Max）    | 不可用，不实现              | 见下文“Claude 订阅”                                                                                                                              |

## 共同规则

- **风险告知**：告知文本按后端只在 [subscriptions.ts](../packages/core/src/subscriptions.ts) 的 `SUBSCRIPTION_NOTICES` 中维护，带版本号；文本改变即换版本。账号记录接受的版本与时间（`account.consent`）；版本不是当前版本的账号不被网关使用，用户重新登录（重新接受）后恢复。`GET /api/v1/subscriptions/notices` 与 `hh subscription notice` 显示全文。
- **只服务本机**：带 `allowLan` 的 Gateway Key（局域网共享用的 Key）既看不到也用不到订阅 provider 的模型：`/v1/models` 不列出，调用时这些候选被跳过（`subscription accounts serve agents on this computer only`）。各家条款都禁止共享账号或其用量。
- **令牌**：令牌只在秘密存储中，以 Credential 的引用保存（单行 JSON：refresh token、access token 与到期时间、ID token、授予的 scope；超过秘密存储 8 KiB 上限时先省去 access token，再省去 ID token）。provider 记录、账本、日志与 API 响应都不含令牌。网关与管理接口共用一个令牌管理器，每个账号同一时间至多一次续期，续期得到的新 refresh token 与 access token 一起写回。
- **请求**：订阅 provider 的调用总是转换（不直通），按后端要求的形状发出；账本照常记录，`cost` 为 null。
- **删除**：删除账号的 Credential 或整个 provider 时，先结束该账号与厂商的会话（ChatGPT 撤销 refresh token，Copilot 停止宿主进程），再删除令牌；撤销没有确认不阻止删除。

## ChatGPT（Sign in with ChatGPT）

### 登录

```sh
hh subscription notice                 # 风险告知全文与版本
hh subscription login chatgpt          # 显示告知，确认后打印“Continue with ChatGPT”链接，等待浏览器完成
hh subscription list                   # 账号：provider、账号、邮箱、状态
hh subscription login chatgpt --account account-1   # 让已有账号重新登录
hh subscription logout chatgpt account-1
```

- `login` 先显示“Use your ChatGPT plan”与风险告知，询问是否接受并 Continue with ChatGPT（`--accept-notice` 表示已接受；非交互且没有该参数时退出码 4，什么也不开始）。随后守护进程在 `127.0.0.1` 的随机端口开回调监听（路径 `/auth/callback`），命令打印授权链接，用户在浏览器中完成 OpenAI 自己的登录与授权，命令轮询结果。第一次成功时打印“You're using your ChatGPT plan. Eligible usage in HarnessHub uses your ChatGPT plan. Manage usage in your ChatGPT settings”，再读取模型列表。
- 新账号以 `client_id=dynamic_agent_client`、`agent_name_hint=HarnessHub` 动态注册，回调返回为该账号签发的 client ID；以后同一账号在本机重新登录时使用它（不带 `agent_name_hint`，带 `login_hint` 与保存的 `id_token_hint`）。本机的 `ext_agent_host_id`（`urn:uuid:…`）首次登录前生成，保存在 `<dataDir>/subscriptions/siwc-host.json`。
- 每次尝试有新的 `state`、`nonce` 与 PKCE（S256）；换取令牌不用客户端密钥。ID token 按 OpenAI 公布的 JWKS 校验 RS256 签名、`iss`、`aud`（签发的 client ID）、`exp` 与 `nonce`，以 `sub` 为账号身份；重新登录必须是同一 `sub`。没有授予 `chatgpt.tokens.use.direct` 时登录失败（“ChatGPT plan use was not granted”）。尝试 10 分钟未完成即失败。
- 第一次登录创建 provider `chatgpt`（名称 “ChatGPT plan”，Responses 端点 `https://api.openai.com/v1`，`subscription: {backend: "siwc"}`），账号是 Credential `account-<n>`，名称为邮箱。`--provider` 可以指定另一个订阅 provider。
- `logout` 向撤销端点提交 refresh token 结束可续期会话，清空令牌，Credential 停用并记 `signedOutAt`，保留账号登记（client ID），以便以后重新登录。OpenAI 没有确认撤销时命令如实说明，用户可在 ChatGPT 设置中断开 HarnessHub。
- 用量在 ChatGPT 设置中查看与限制：<https://chatgpt.com/settings/usage>。

### 调用

- 模型列表：`GET https://api.openai.com/v1/models`（带 access token），只保留 `visibility: "list"` 的模型，`slug` 是模型 ID。
- 推理：`POST https://api.openai.com/v1/responses`，`store: false`、`stream: true`；system 成为 `instructions`（不发送 system 消息项）；函数工具放在一个命名空间 `functions` 中，历史中的 `function_call` 带 `namespace`；`max_output_tokens`、`temperature`、`top_p`、`user` 不发送，记入账本的 `unmapped[]`；指定某个函数的 `tool_choice` 改为 `required`（补丁 `tool_choice:required`）。
- access token 在到期前 5 分钟内续期：`grant_type=refresh_token`、签发的 client ID、`resource`，不带 `scope`。续期返回 `invalid_grant`、`refresh_token_reused` 等终止性错误时，账号需要重新登录：调用以 401 `subscription_sign_in_needed` 转移到其他候选，消息给出 `hh subscription login chatgpt --provider <id>`；同一失效令牌不再重复请求续期。
- 错误：`subscription_sharing_usage_limit_exceeded`（429）归为 `quota`，该账号休息 15 分钟（OpenAI 要求不要从这个错误推断重置时间），返回给客户端的消息为“Usage limit reached. Review your plan or this app's limit in ChatGPT settings: https://chatgpt.com/settings/usage”；`subscription_sharing_usage_unavailable`、`subscription_sharing_user_unavailable`（503）可重试；`subscription_sharing_user_not_eligible`、`…_route_not_supported`、`chatpass_v2_*`（403）与 `subscription_sharing_invalid_user`（401）归为 `auth`；`subscription_sharing_unsupported_capability`（400）直接返回。流内的 `response.failed` 按同样的代码映射。
- OpenAI 不提供额度窗口读数，所以 ChatGPT 账号没有 `smart` 与 `pace` 的输入（在这两种策略中作为“尚无读数”的账号排在最前）。

## GitHub Copilot

### 安装与登录

```sh
hh subscription setup copilot          # SDK 附加组件与 Copilot CLI 是否就绪；缺 SDK 时给出 npm 命令
hh subscription login copilot          # 告知；确认后用 Copilot CLI 自己的登录
hh subscription login copilot --token  # 改用细粒度 PAT（隐藏输入；或 --token-from-stdin、--token-from-env VAR、--token-from-file PATH）
hh subscription logout copilot account-1
```

- **两个前提**，都由用户自己安装：GitHub 的 Copilot CLI（`copilot`，在 PATH 上），以及 Copilot SDK `@github/copilot-sdk`。SDK 是可选附加组件，不在 HarnessHub 的依赖与单可执行文件中；`setup` 给出的命令把受支持的版本（当前 1.0.16）装到 `<dataDir>/addons/copilot-sdk`，带 `--omit=optional`，不装 SDK 自带的平台运行时（约 110 MB），因为 HarnessHub 驱动的是用户已装的 CLI。
- **登录方式**：缺省用 Copilot CLI 自己的登录（用户先在 `copilot` 中用 `/login` 登录）；HarnessHub 从不读取这份登录，只经 SDK 的 `getAuthStatus` 得到 GitHub 登录名。或者用用户在 GitHub 创建的、带 “Copilot Requests” 权限的细粒度个人访问令牌（`github_pat_…`；其他形式的令牌被拒绝，`COPILOT_TOKEN_INVALID`）：令牌只在秘密存储中，经宿主进程的 `start` 请求交给 SDK，再由 SDK 以环境变量交给 CLI；这种账号的 CLI 使用 `<dataDir>/subscriptions/copilot/homes/` 下自己的目录（`COPILOT_HOME`），环境中的 `GH_TOKEN`、`GITHUB_TOKEN`、`COPILOT_GITHUB_TOKEN` 等不传给它。HarnessHub 自己的 GitHub OAuth App 暂不注册。
- `login` 先显示“Use your GitHub Copilot plan”与风险告知（非交互且没有 `--accept-notice` 时退出码 4，什么也不开始），然后在返回前完成：成功时给出 GitHub 登录名并读取模型列表。第一次登录创建 provider `copilot`（名称 “GitHub Copilot”，`subscription: {backend: "copilot"}`，没有端点），账号是 Credential `account-<n>`，`account` 记 `subject`（GitHub 登录名）、`host`、`auth`（`login` 或 `token`）与接受的告知。
- `logout` 停止该账号的宿主进程、清空令牌、停用 Credential 并记 `signedOutAt`，返回 `revoked: false`：CLI 的登录属于用户，不受影响；令牌在用户于 GitHub 撤销之前仍然有效，命令如实说明。
- 用量与高级请求预算在 GitHub 的计费设置中查看：<https://github.com/settings/billing>。

### 调用

- 每个账号一个宿主进程（[copilot-host.mjs](../packages/daemon/assets/copilot-host.mjs)），由守护进程经 `ProcessLauncher` 以 HarnessHub 自己的 Node 启动（单可执行文件中以 node 兼容方式运行）。宿主从附加组件目录导入 SDK，以 `RuntimeConnection.forStdio({path})` 驱动用户的 CLI；`login` 账号用 `mode: "copilot-cli"`（CLI 自己的配置与登录），`token` 账号用 `mode: "empty"`。宿主在第一次使用时启动，没有会话 15 分钟后停止，守护进程关闭时全部停止。宿主与守护进程之间的 JSON 行协议见 [copilot.ts](../packages/daemon/src/copilot.ts)。
- 模型列表来自 SDK 的 `listModels`，只保留策略为 enabled 的模型，带上下文窗口、输出上限、推理与图片输入。
- 网关把对 `copilot/<model>` 的调用交给 Copilot 会话（[copilot.ts](../packages/gateway/src/copilot.ts) 的 `CopilotBridge`）：
  - 会话以 `clientName: "HarnessHub"` 标识自己；`systemMessage` 用 SDK 文档中的 `replace` 模式，内容就是调用方自己的 system 提示词，不改写也不添加。工具只有调用方的函数（`availableTools` 限定为它们，没有处理器的声明，`skipPermission`），CLI 的内置 shell 与文件工具不可用，其他权限请求一律拒绝。会话不读取工作区的自定义指令（工作目录是空目录 `<dataDir>/subscriptions/copilot/work`，状态在 `…/state`），不开会话存储与无限会话压缩。
  - 模型请求工具时，答复以 `finish_reason: "tool_calls"` 结束，交给调用方执行；调用方下一次请求带回的结果经 SDK 的 `handlePendingToolCall` 交还同一会话，会话继续。之后的新用户消息也继续同一会话。会话按“它持有的消息在调用方回传时的样子”的散列索引，不依赖会话 ID；工具参数 JSON 的空白与键序不影响匹配。
  - 请求的历史不是某个会话的延续时（第一次请求、调用方压缩或编辑了历史、HarnessHub 重启之后），新会话的第一个提示词以 `<transcript>` 给出之前的消息，再接最新的用户消息；账本记补丁 `copilot:transcript`。早先消息中的图片不进入转录；最新用户消息中的 base64 data URL 图片作为附件发送。
  - 会话只接受消息、工具与 `reasoning_effort`；`temperature`、`max_tokens`、`stop`、`response_format`、非 `auto` 的 `tool_choice` 等不发送，记入账本的 `unmapped[]`。
  - 用量取自会话的 `assistant.usage` 事件；输入与输出数按总数记，缓存与推理是其中的部分（未经真实 CLI 核对）。客户端断开、超时或会话出错时，回合被中止、会话关闭。空闲会话 10 分钟后关闭，每个账号至多保留 8 个。
- 错误：会话在任何输出之前报错时，按它的状态码（没有时按消息归类：额度与限流 429，认证 401，权限与策略 403，其他 502）作为上游错误返回，额度错误使账号按 `quota` 休息并附 GitHub 计费设置的提示；输出之后的错误在流中报告。账号未登录或令牌不被接受时，以 401 `subscription_sign_in_needed` 转移，消息给出 `hh subscription login copilot --provider <id>`；SDK 未安装、找不到 CLI 或 CLI 版本不被 SDK 支持时，以 503 `subscription_unavailable` 转移。
- 额度读数：每个账号回答之后（至多每分钟一次）经 SDK 的 `account.getQuota` 读取额度快照，每个非无限的窗口（如 `premium_interactions`）成为读数：已用比例为 100 减剩余比例，续期时间为 `resetDate`，跨度为续期前的一个月。`smart` 与 `pace` 因此可以在多个 Copilot 账号之间分配。
- 未验证：真实的 Copilot SDK 与 Copilot CLI（测试用假的 SDK 附加组件驱动真实的宿主进程与协议）；单可执行文件中运行宿主；Windows 上 npm 安装的 `copilot.cmd`（SDK 不经 shell 启动程序，可能无法启动 `.cmd`）。

## Claude 订阅

不实现。Anthropic 的 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 写明：“Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.” 以用户已安装的 `claude` 为后端、把其他 Agent 的请求经用户的 Claude 订阅发出，属于这里禁止的“route requests through … plan credentials”。该页对终端用户的例外（“an end user … signing in to the unmodified Claude Code binary with their own Claude subscription”）覆盖的是使用未修改的 Claude Code 本身，而不是把它当作模型后端。按 ADR-P09，厂商明确禁止的机制标为不可用，不寻找绕过方式。使用 Claude 模型请配置 Anthropic API Key（Claude Console）或支持的云厂商。

## 额度读数与 `smart`、`pace`

路由组的 `smart` 与 `pace` 按每个 Credential 的额度读数排序（Magpie 的同名路由，[routing.ts](../packages/gateway/src/routing.ts) 的 `Router.weigh`）：

- **读数**：`{window, usedPercent, resetsAt?, spanSeconds?, observedAt}`，只来自上游自己给出的信息：每个答复的限流头（OpenAI `x-ratelimit-*`、Anthropic `anthropic-ratelimit-*`），以及官方客户端自己的额度报告（Copilot SDK 的 `account.getQuota`）。不轮询任何私有用量端点，不发预热请求，不切换用户的登录。读数在内存中，最后的值在变化后一分钟内与关闭时写入 `<dataDir>/allowance-readings.json`（`schemaVersion: 1`，0600，原子替换），启动时读回。过了重置时间的窗口算作未用；没有重置时间的读数 24 小时后失效。
- **`smart`**：按已用比例分为 fine（低于 90%）、low、spent（98% 及以上）三档；fine 中先放还没有读数的订阅账号（它们回答之后才有读数），再按续期时间：从最长的窗口比起，取到整点，越早续期越靠前，未知的排在已知之后，相同则保持配置顺序；low 与 spent 各按已用比例升序。
- **`pace`**：同样三档；fine 中先放没有读数的订阅账号，再按每小时剩余额度（跨度不少于一天的窗口：剩余百分比除以距续期的小时数，取最紧的窗口；没有这类窗口的订阅账号按一周摊开；不是订阅账号的 Credential 为 0）降序分带（低于带首 90% 开新带），带内按每小时减半的 token 数升序。
- 没有读数时两种策略都保持配置顺序。
