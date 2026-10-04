# 订阅账号

订阅 provider 的 Credential 是用户自己的订阅账号，而不是 API Key（[ADR-P09](proposals/oss/adr-drafts.md#adr-p09-订阅复用进核心)，取舍见 [ADR 0026](decisions/0026-subscription-accounts.md)）。HarnessHub 只用厂商为第三方应用提供的机制（或驱动用户已安装的官方客户端）使用订阅，不复制其他客户端的 OAuth client ID、User-Agent、originator 或请求头，不改写其他应用的钥匙串条目或凭据文件，也不改写调用方的提示词来规避厂商的分类。每个账号在用户接受该后端当前版本的风险告知之前不可用，并且只服务本机的 Agent。

| 订阅                        | 状态                        | 机制                                                                                                                        |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT（Plus、Pro 等套餐） | 已实现：后端 `siwc`         | OpenAI 的 [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)（预览） |
| Codex 自己的 ChatGPT 登录   | 已实现（不是订阅 provider） | 网关的 [Codex 透传](model-gateway.md#codex-透传)：只转发 Codex 自己的请求，HarnessHub 不持有这份登录                        |
| GitHub Copilot              | 计划中                      | 官方 Copilot SDK，用户自己的 `copilot` 登录或带 “Copilot Requests” 权限的细粒度 PAT                                         |
| Claude（Free、Pro、Max）    | 不可用，不实现              | 见下文“Claude 订阅”                                                                                                         |

## 共同规则

- **风险告知**：告知文本按后端只在 [subscriptions.ts](../packages/core/src/subscriptions.ts) 的 `SUBSCRIPTION_NOTICES` 中维护，带版本号；文本改变即换版本。账号记录接受的版本与时间（`account.consent`）；版本不是当前版本的账号不被网关使用，用户重新登录（重新接受）后恢复。`GET /api/v1/subscriptions/notices` 与 `hh subscription notice` 显示全文。
- **只服务本机**：带 `allowLan` 的 Gateway Key（局域网共享用的 Key）既看不到也用不到订阅 provider 的模型：`/v1/models` 不列出，调用时这些候选被跳过（`subscription accounts serve agents on this computer only`）。各家条款都禁止共享账号或其用量。
- **令牌**：令牌只在秘密存储中，以 Credential 的引用保存（单行 JSON：refresh token、access token 与到期时间、ID token、授予的 scope；超过秘密存储 8 KiB 上限时先省去 access token，再省去 ID token）。provider 记录、账本、日志与 API 响应都不含令牌。网关与管理接口共用一个令牌管理器，每个账号同一时间至多一次续期，续期得到的新 refresh token 与 access token 一起写回。
- **请求**：订阅 provider 的调用总是转换（不直通），按后端要求的形状发出；账本照常记录，`cost` 为 null。

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
- `logout` 向撤销端点提交 refresh token 结束可续期会话，清空令牌，Credential 停用并记 `signedOutAt`，保留账号登记（client ID），以便以后重新登录。OpenAI 没有确认撤销时命令如实说明，用户可在 ChatGPT 设置中断开 HarnessHub。删除账号的 Credential 或整个 provider 时，先以同样方式撤销，再删除令牌；撤销没有确认不阻止删除。
- 用量在 ChatGPT 设置中查看与限制：<https://chatgpt.com/settings/usage>。

### 调用

- 模型列表：`GET https://api.openai.com/v1/models`（带 access token），只保留 `visibility: "list"` 的模型，`slug` 是模型 ID。
- 推理：`POST https://api.openai.com/v1/responses`，`store: false`、`stream: true`；system 成为 `instructions`（不发送 system 消息项）；函数工具放在一个命名空间 `functions` 中，历史中的 `function_call` 带 `namespace`；`max_output_tokens`、`temperature`、`top_p`、`user` 不发送，记入账本的 `unmapped[]`；指定某个函数的 `tool_choice` 改为 `required`（补丁 `tool_choice:required`）。
- access token 在到期前 5 分钟内续期：`grant_type=refresh_token`、签发的 client ID、`resource`，不带 `scope`。续期返回 `invalid_grant`、`refresh_token_reused` 等终止性错误时，账号需要重新登录：调用以 401 `subscription_sign_in_needed` 转移到其他候选，消息给出 `hh subscription login chatgpt --provider <id>`；同一失效令牌不再重复请求续期。
- 错误：`subscription_sharing_usage_limit_exceeded`（429）归为 `quota`，该账号休息 15 分钟（OpenAI 要求不要从这个错误推断重置时间），返回给客户端的消息为“Usage limit reached. Review your plan or this app's limit in ChatGPT settings: https://chatgpt.com/settings/usage”；`subscription_sharing_usage_unavailable`、`subscription_sharing_user_unavailable`（503）可重试；`subscription_sharing_user_not_eligible`、`…_route_not_supported`、`chatpass_v2_*`（403）与 `subscription_sharing_invalid_user`（401）归为 `auth`；`subscription_sharing_unsupported_capability`（400）直接返回。流内的 `response.failed` 按同样的代码映射。
- OpenAI 不提供额度窗口读数，所以 ChatGPT 账号没有 `smart` 与 `pace` 的输入（在这两种策略中作为“尚无读数”的账号排在最前）。

## Claude 订阅

不实现。Anthropic 的 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 写明：“Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.” 以用户已安装的 `claude` 为后端、把其他 Agent 的请求经用户的 Claude 订阅发出，属于这里禁止的“route requests through … plan credentials”。该页对终端用户的例外（“an end user … signing in to the unmodified Claude Code binary with their own Claude subscription”）覆盖的是使用未修改的 Claude Code 本身，而不是把它当作模型后端。按 ADR-P09，厂商明确禁止的机制标为不可用，不寻找绕过方式。使用 Claude 模型请配置 Anthropic API Key（Claude Console）或支持的云厂商。

## 额度读数与 `smart`、`pace`

路由组的 `smart` 与 `pace` 按每个 Credential 的额度读数排序（Magpie 的同名路由，[routing.ts](../packages/gateway/src/routing.ts) 的 `Router.weigh`）：

- **读数**：`{window, usedPercent, resetsAt?, spanSeconds?, observedAt}`，只来自上游自己给出的信息：每个答复的限流头（OpenAI `x-ratelimit-*`、Anthropic `anthropic-ratelimit-*`），以及官方客户端自己的额度事件（Copilot 接入后）。不轮询任何私有用量端点，不发预热请求，不切换用户的登录。读数在内存中，最后的值在变化后一分钟内与关闭时写入 `<dataDir>/allowance-readings.json`（`schemaVersion: 1`，0600，原子替换），启动时读回。过了重置时间的窗口算作未用；没有重置时间的读数 24 小时后失效。
- **`smart`**：按已用比例分为 fine（低于 90%）、low、spent（98% 及以上）三档；fine 中先放还没有读数的订阅账号（它们回答之后才有读数），再按续期时间：从最长的窗口比起，取到整点，越早续期越靠前，未知的排在已知之后，相同则保持配置顺序；low 与 spent 各按已用比例升序。
- **`pace`**：同样三档；fine 中先放没有读数的订阅账号，再按每小时剩余额度（跨度不少于一天的窗口：剩余百分比除以距续期的小时数，取最紧的窗口；没有这类窗口的订阅账号按一周摊开；不是订阅账号的 Credential 为 0）降序分带（低于带首 90% 开新带），带内按每小时减半的 token 数升序。
- 没有读数时两种策略都保持配置顺序。
