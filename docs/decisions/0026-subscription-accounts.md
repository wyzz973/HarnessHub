# ADR 0026：订阅账号的接入方式

Status: proposed

日期：2026-10-04
关联决定：开源版 [ADR-P09](../proposals/oss/adr-drafts.md#adr-p09-订阅复用进核心)（订阅复用进核心）、[ADR 0025](0025-magpie-routing-parity.md)（失败类别与休息）

## 问题

ADR-P09 决定把订阅 provider 内置进核心，只用厂商支持第三方应用的流程或驱动用户已安装的官方客户端。对标的 Magpie 用订阅的方式大多是冒充官方客户端（复制 client ID、User-Agent、originator 与系统提示词）或改写其他应用的钥匙串条目。需要逐个订阅确定在这些约束下能做什么、怎么做，以及账号如何参与路由。

## 决定

- **ChatGPT**：实现 OpenAI 的 Sign in with ChatGPT for open-source apps（预览，开源与本机应用无需审批）。HarnessHub 是按账号与主机动态注册的公共客户端（PKCE、回环回调、持久的 `ext_agent_host_id`、`agent_name_hint=HarnessHub`），ID token 按 JWKS 校验，推理走公开的 Responses API，按预览的要求整形请求（`store: false`、`stream: true`、工具放进命名空间、去掉不支持的字段），错误代码按 OpenAI 的恢复说明映射。
- **Claude**：不实现。Anthropic 明确不允许第三方开发者“route requests through Free, Pro, or Max plan credentials on behalf of their users”；把其他 Agent 的请求经用户的 `claude` 发出属于这种情形，终端用户的例外只覆盖使用未修改的 Claude Code 本身。按 ADR-P09 标为不可用。
- **Copilot**：经 GitHub 的 Copilot SDK 驱动用户安装的 Copilot CLI。认证用用户自己的 Copilot CLI 登录（HarnessHub 不读取它），或用户创建的带 “Copilot Requests” 权限的细粒度 PAT（只在秘密存储中）；HarnessHub 自己的 GitHub OAuth App 暂不注册。SDK 是可选附加组件（`<dataDir>/addons/copilot-sdk`，不装平台运行时，不运行安装脚本），由用户确认后经 `ProcessLauncher` 用用户的 npm 安装，不进依赖与单可执行文件；每个账号一个宿主进程运行 SDK，经 JSON 行协议与守护进程通信。网关的 Copilot 桥按会话持有的消息继续同一会话：调用方的 system 提示词以 SDK 的 `replace` 模式原样传入，调用方的函数是唯一的工具，工具调用以 `tool_calls` 交回调用方，结果交还同一会话；不能延续的历史以转录给出。
- **账号**：订阅 provider（`ProviderConfig.subscription`）的每个 Credential 带 `account`（后端、账号身份、签发的 client ID、接受的告知版本与时间、登出时间），令牌只在秘密存储中。账号在接受该后端当前版本的风险告知之前不可用；告知文本只在 core 中维护，改变即换版本。订阅账号只服务本机：带 `allowLan` 的 Key 既不列出也不路由它们。
- **令牌管理**：网关与管理接口共用一个令牌管理器，每个账号同一时间至多一次续期，轮换后的令牌一起写回；终止性的续期错误记住到令牌改变为止，调用以 401 `subscription_sign_in_needed` 转移。
- **额度读数与策略**：每个 Credential 的额度读数只来自上游自己的信息（答复的限流头、Copilot SDK 的额度报告），最后的值保存在数据目录的文件中；新增路由策略 `smart` 与 `pace`（Magpie 的同名路由）。不轮询私有用量端点，不预热，不切换用户的登录。

## 考虑过的替代方案

- **Claude 经官方二进制作为模型后端**（Magpie 的做法，曾写入设计说明）：技术上可行（MCP 工具桥、诚实的系统提示词），但与 Anthropic 的书面限制冲突，所有者决定不实现。
- **SIWC 令牌放在单独的凭据文件**（OpenAI 文档的示例）：秘密存储已经提供平台加密与原子写入，令牌不应出现在另一个位置。
- **Copilot 由 HarnessHub 直接实现 SDK 的 JSON-RPC 协议**：免去附加组件，但要追随 SDK 拥有的协议版本；用官方 SDK 更稳妥。
- **Copilot 每个请求一个新会话、历史全部转录**：实现简单，但工具结果的每一轮都成为新的提示词（多计请求，模型也看不到真正的工具调用历史）；延续会话与 Copilot CLI 自己的用法一致。
- **SDK 在守护进程内加载**：SDK 会自己启动 CLI 子进程，绕过 `ProcessLauncher` 的所有权；单可执行文件的主脚本也不能从磁盘导入 ES 模块。宿主进程把两者隔离在一个 HarnessHub 拥有、可终止的进程中。
- **订阅 provider 用新的 `kind: "subscription"`**：`kind` 描述厂商类别（ChatGPT 套餐仍是厂商 OpenAI），订阅的用法是另一维度，所以单列 `subscription` 字段，不改变 `kind` 的闭集。
- **账号经局域网共享给其他机器**：各家条款都禁止共享账号或用量；SIWC 的付费或远程托管用法还需要另行申请。

## 后果

- SIWC 是预览，OpenAI 可能改变或结束；请求形状的限制（无 `temperature`、无 `max_output_tokens` 等）使部分客户端参数丢失，账本的 `unmapped[]` 记录它们。
- ChatGPT 没有额度读数，`smart` 与 `pace` 对它只是“尚无读数”的账号；Copilot 账号的读数来自 SDK 的额度报告。
- Copilot 的会话状态在宿主进程中：HarnessHub 重启或会话过期后，同一对话以转录继续（账本补丁 `copilot:transcript`）；`temperature`、`max_tokens` 等参数不能传给会话。
- Copilot 需要用户安装的 Copilot CLI 与 npm；`hh subscription setup copilot` 报告缺什么，`--install` 安装 SDK 附加组件。
- 第一次登录会创建 provider `chatgpt`；重新登录复用签发的 client ID。账号登出后保留登记。
- 新的管理接口：`/api/v1/subscriptions/*`（含 `copilot/setup`）与账号登出；新的 `hh subscription` 命令。

## 验证要求

- 回环假服务代替 auth.openai.com 与 api.openai.com：登录（注册与重新登录的参数、PKCE、无客户端密钥、ID token 的签名与声明校验、未授予套餐 scope 的拒绝）、并发调用只续期一次、轮换写回、终止性错误、登出撤销；请求整形与错误映射；告知未接受与登出的账号不被使用；局域网 Key 看不到也用不到订阅账号；`smart` 与 `pace` 的排序与读数的持久化。
- Copilot：网关单元测试以脚本化的运行时验证系统提示词与工具、工具调用与结果延续同一会话、转录、错误映射、断开时中止；集成测试以假的 SDK 附加组件驱动真实的宿主进程与协议，验证两种登录、模型列表、工具往返、登出、删除与额度读数的持久化，以假的 npm 验证安装（含失败），以及 `hh subscription setup|login copilot`。
- 测试只用合成令牌，从不读取开发者本机的真实凭据。
- 未验证：真实 OpenAI 预览端点与真实 ChatGPT 账号；真实 Copilot SDK 与 Copilot CLI；单可执行文件中的 Copilot 宿主；Windows。
