# 订阅账号

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 回环假服务代替 auth.openai.com 与 api.openai.com 的网关与集成测试（登记与重新登录的参数、PKCE、ID token 校验、未授予套餐 scope 的拒绝、并发调用只续期一次、终止性错误、登出撤销、取消登录、请求整形与错误映射）；Copilot 以假的 SDK 附加组件驱动真实的宿主进程与协议（两种登录、模型列表、工具往返、登出、删除、额度读数），以假的 npm 验证安装；控制台在 Chromium 中走完两种登录与退出；macOS arm64。真实 ChatGPT 账号与 OpenAI 预览端点、真实 Copilot SDK 与 CLI、单可执行文件中的 Copilot 宿主、Windows 都未验证 |
| 对照 Magpie | 相同：Codex 自己的 ChatGPT 登录透传、每种订阅多个账号与重新登录、登出；有意不同：ChatGPT 改用 Sign in with ChatGPT、Copilot 改经官方 SDK、不接 Claude 订阅、版本化的风险告知、不经局域网共享、读数只来自答复；部分：额度提醒；未覆盖：Gemini CLI、Antigravity、Cursor 等账号与中转余额（[对照表](../../magpie-parity.md#subscriptions)） |
| 权威文档 | [订阅账号](../../subscriptions.md)、[资源](../../model-plane-api.md#资源)（subscriptions）、[ADR 0026](../../decisions/0026-subscription-accounts.md) |

## 用途

让本机的 Agent 用用户自己的 ChatGPT 套餐或 GitHub Copilot 订阅调用模型，与 API Key 的 provider 一样参与路由组、熔断与账本。HarnessHub 只用厂商为第三方应用提供的机制（或驱动用户已安装的官方客户端），不冒充其他客户端，也不读其他应用的登录。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 订阅账号（`/subscriptions`）：风险告知须勾选接受；ChatGPT 打开 OpenAI 授权页并查询结果、可取消；Copilot 检查与安装 SDK 附加组件，用 CLI 的登录或细粒度 PAT；账号列表、重新登录、退出登录、删除，账号行显示路由状态与额度读数 |
| 命令行 | `hh subscription notice\|list`、`hh subscription login chatgpt [--provider ID] [--account ID] [--accept-notice]`、`hh subscription login copilot [--provider ID] [--account ID] [--accept-notice] [--token \| --token-from-stdin \| --token-from-env VAR \| --token-from-file PATH]`、`hh subscription setup copilot [--install]`、`hh subscription logout <provider> <account>` |
| HTTP | `GET /api/v1/subscriptions/notices`、`GET /api/v1/subscriptions/accounts`、`POST /api/v1/subscriptions/sign-in`、`GET`、`DELETE /api/v1/subscriptions/sign-in/{id}`、`GET`、`POST /api/v1/subscriptions/copilot/setup`、`POST /api/v1/providers/{id}/credentials/{credentialId}/sign-out` |

## 已实现的能力

- 风险告知按后端只在 core 的 `SUBSCRIPTION_NOTICES` 中维护并带版本（当前 `siwc-2026-10-04`、`copilot-2026-10-04`）；账号记录接受的版本与时间，版本不是当前版本的账号不被网关使用，重新登录后恢复。
- 只服务本机：带 `allowLan` 的 Gateway Key 在 `/v1/models` 中看不到订阅 provider 的模型，调用时这些候选被跳过；局域网 Key 的图片描述也不使用订阅账号。
- 令牌只在秘密存储中，provider 记录、账本、日志与 API 响应都不含令牌；网关与管理接口共用一个令牌管理器，每个账号同一时间至多一次续期。订阅 provider 的调用总是转换（不直通），账本照常记录，`cost` 为 null。
- ChatGPT（`siwc`）：每次尝试有新的 `state`、`nonce` 与 PKCE（S256），回调监听只在 `127.0.0.1` 的随机端口；新账号以 `dynamic_agent_client` 动态注册；ID token 按 OpenAI 的 JWKS 校验；没有授予 `chatgpt.tokens.use.direct` 时失败；尝试 10 分钟未完成即失败，可取消；第一次登录创建 provider `chatgpt`。
- ChatGPT 调用走公开的 Responses API（`store: false`、`stream: true`，函数工具放进命名空间，不支持的参数记入 `unmapped[]`）；access token 到期前 5 分钟内续期，终止性错误使调用以 401 `subscription_sign_in_needed` 转移；`subscription_sharing_usage_limit_exceeded` 归为 `quota`，账号休息 15 分钟。
- Copilot：SDK 是可选附加组件，确认后由守护进程用用户的 npm 把受支持的版本（当前 1.0.16）装到 `<dataDir>/addons/copilot-sdk`，`--omit=optional --ignore-scripts`，4 分钟内未完成即失败；登录用 Copilot CLI 自己的登录（HarnessHub 不读取它）或带 “Copilot Requests” 权限的细粒度 PAT（`github_pat_…`）。
- Copilot 调用：每个账号一个宿主进程驱动用户的 CLI；调用方的 system 提示词以 `replace` 模式原样传入，工具只有调用方的函数，CLI 的内置 shell 与文件工具不可用；工具调用以 `tool_calls` 交回调用方，结果交还同一会话；不能延续的历史以 `<transcript>` 给出（`copilot:transcript`）；每个账号回答之后至多每分钟读一次额度，供 `smart` 与 `pace` 使用。
- 删除账号的 Credential 或 provider 时先结束厂商会话（ChatGPT 撤销 refresh token，Copilot 停止宿主进程）再删除令牌；登出保留账号登记以便重新登录。
- Claude 的 Free、Pro、Max 订阅不实现（Anthropic 条款不允许第三方经这些套餐转发请求）；Codex 以 ChatGPT 登录时自己的请求经 [Codex 透传](../../model-gateway.md#codex-透传)原样转发，HarnessHub 不持有那份登录。
- 订阅 provider 与账号不随备份与同步带走，在每台电脑上分别登录。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [core/subscriptions.ts](../../../packages/core/src/subscriptions.ts)、[gateway/siwc.ts](../../../packages/gateway/src/siwc.ts)、[gateway/copilot.ts](../../../packages/gateway/src/copilot.ts)、[daemon/subscriptions.ts](../../../packages/daemon/src/subscriptions.ts)、[daemon/copilot.ts](../../../packages/daemon/src/copilot.ts)、[daemon/assets/copilot-host.mjs](../../../packages/daemon/assets/copilot-host.mjs)、[daemon/subscription-routes.ts](../../../packages/daemon/src/http/subscription-routes.ts)、[console/subscriptions-page.tsx](../../../packages/console/components/subscriptions-page.tsx) |
| 测试 | [shared-gateway-siwc](../../../packages/gateway/test/shared-gateway-siwc.test.ts)、[shared-gateway-copilot](../../../packages/gateway/test/shared-gateway-copilot.test.ts)、[daemon copilot](../../../packages/daemon/test/copilot.test.ts)；集成 [subscriptions](../../../tests/integration/subscriptions.test.ts)、[subscriptions-copilot](../../../tests/integration/subscriptions-copilot.test.ts) |
| 决策 | [ADR 0026 订阅账号的接入方式](../../decisions/0026-subscription-accounts.md)、[ADR-P09 订阅复用进核心](../../proposals/oss/adr-drafts.md#adr-p09-订阅复用进核心) |

## 已知限制与未验证

- Sign in with ChatGPT 是 OpenAI 的预览，可能改变或结束；它的请求形状不接受 `temperature`、`max_output_tokens` 等参数。ChatGPT 账号没有额度读数，在 `smart` 与 `pace` 中只是“尚无读数”的账号。
- Copilot 会话不接受 `temperature`、`max_tokens`、`stop`、`response_format` 等参数；用量中缓存与推理的拆分未经真实 CLI 核对；HarnessHub 自己的 GitHub OAuth App 暂不注册。
- 订阅账号仍只读一个模型列表，不按账号分别读取；没有按订阅账号的出站代理。
- 没有 Gemini CLI、Antigravity、Cursor、Kiro 等账号（Magpie 借用这些客户端的身份，HarnessHub 不借用）。
- 真实 ChatGPT 账号、真实 Copilot SDK 与 CLI、单可执行文件中的宿主、Windows 上 npm 安装的 `copilot.cmd`（SDK 不经 shell 启动程序，可能无法启动）都未验证。

## 优化候选

- **现状**：两种订阅都只对假服务验证过。**方向**：由所有者用真实 ChatGPT 账号与真实 Copilot CLI 各走一次登录、调用、续期与登出，并记录结果。**依据**：[ADR 0026](../../decisions/0026-subscription-accounts.md) 验证要求的“未验证”；TODO“订阅账号”一条的“真实账号未验证”。
- **现状**：订阅账号只能用守护进程的代理或直连。**方向**：增加按订阅账号的代理设置。**依据**：TODO“出站代理”的“未做：按订阅账号的代理”。
- **现状**：同一订阅 provider 的多个账号共用一个模型列表。**方向**：按账号分别读取模型列表，路由不把模型发给自己的列表没有它的账号。**依据**：TODO“每个 Credential 自己的模型列表”的“未覆盖：订阅账号仍只读一个列表”。
- **现状**：Copilot 登录依赖用户自己的 CLI 登录或手工创建的 PAT。**方向**：注册 HarnessHub 自己的 GitHub OAuth App，提供浏览器登录。**依据**：[订阅账号](../../subscriptions.md#github-copilot)“HarnessHub 自己的 GitHub OAuth App 暂不注册”。
- **现状**：Windows 上 SDK 可能无法启动 npm 安装的 `copilot.cmd`。**方向**：在 Windows 上验证并在需要时由宿主解析 `.cmd` 的真实入口。**依据**：[订阅账号](../../subscriptions.md#github-copilot)的“未验证”。
