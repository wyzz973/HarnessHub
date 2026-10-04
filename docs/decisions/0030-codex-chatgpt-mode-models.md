# ADR 0030：Codex 的 ChatGPT 模式携带 Gateway Key 并列出 HarnessHub 的模型

Status: proposed

日期：2026-10-05
关联决定：[ADR 0022](0022-agent-wiring-semantics.md)（本记录取代其中 ChatGPT 模式不签发 Key 的部分）、[ADR 0025](0025-magpie-routing-parity.md)（本记录扩展其 Codex 透传）、[全局接线](../global-wiring.md#codex-的两种模式)、[模型网关](../model-gateway.md#codex-透传)

## 问题

以 ChatGPT 登录的 Codex 接线后只写 `openai_base_url = <网关>/backend-api/codex`，网关把这条路径下的请求全部转发到 chatgpt.com。Codex 因此选不到 HarnessHub 的模型。Magpie 在同样的模式下在本地服务自己的模型，`/models` 返回 ChatGPT 的列表与 Magpie 的列表合并后的结果（`codex_backend.go` 的 `codexBackend` 与 `codexModels`）。

Magpie 的回环网关不鉴权；HarnessHub 的模型调用都要求 Gateway Key，按 Key 做模型白名单、额度与账本归属。ChatGPT 模式下 Codex 用的是内置的 OpenAI provider：它带着自己的 ChatGPT 令牌（`Authorization`、`ChatGPT-Account-Id`），配置里只有 `openai_base_url` 一项，不能加请求头。用内置 provider 之外的任何认证方式，都要改 Codex 的登录或冒充它的客户端，这两样都不做（ADR-P09）。

## 决定

- **Key 放在基址的路径里**：ChatGPT 模式写 `openai_base_url = "<网关>/backend-api/codex/<agent Key>"`。Codex 把 `/responses`、`/models` 等接在后面。网关在任何其他处理之前去掉这一段（必须是格式有效的 Gateway Key），Key 文本从不保存或输出：转发到 ChatGPT 的 URL、账本的 `inbound.path`、网关与守护进程的日志、错误答复、OTLP 导出（只导出账本字段，不含路径）与路由状态都不含它。Codex 自己的 ChatGPT 登录不变，网关不读 `~/.codex/auth.json`。
- **只在回环上，Key 必须有效**：这条路径与原来的透传一样只服务回环监听器上的回环对端（局域网监听器不提供它，网关的局域网入口在查看 Key 之前就以 403 拒绝）。路径中的 Key 按现有方式比较（SHA-256 后常数时间比较）；无效、未知或已吊销时，这个请求无论做什么都在本地答复 401，消息不重复路径或 Key。
- **按模型名分流**（Magpie：命名空间决定路由）：`/responses` 的 `model` 带 `/`（Model Ref 或 `group/<id>`）时，用路径中的 Key 鉴权，按 `/v1/responses` 的正常路径服务（路由、转移、账本、额度、`session:` Key 的 Run 规则）。进入之前删掉请求中的 `Authorization` 与 `ChatGPT-Account-Id`，ChatGPT 的令牌因此不可能到达任何其他上游；网关本来也只转发固定的几个客户端请求头。没有 Key 时在本地答复 401，不转发给 ChatGPT。其他模型带着有效的 Key 或不带 Key 照旧原样转发。
- **合并的模型列表**：`GET /models` 带有效 Key 时，网关用 Codex 的请求头取 ChatGPT 的列表，再在后面追加该 Key 可用的模型（与 `/v1/models` 同一个过滤），条目格式与 API 模式写入 `harnesshub-models.json` 的相同（`codexWiringCatalog`，由守护进程注入网关，网关不依赖 agents 包）。`ETag` 与转发答复的 `X-Models-Etag` 加上 HarnessHub 列表的标记（`+hh-<12 位十六进制>`），任一列表变化时 Codex 会重新获取。ChatGPT 拒绝或答复不是模型列表时原样返回，Codex 保留已有的列表。
- **还原吊销 Key**：`hh unwire codex` 恢复文件并吊销这把 Key；轮换签发新 Key、旧 Key 立即失效。
- **接线签发 Key，模型可选**：Adapter 的 `keyless` 能力改为 `modelOptional`：ChatGPT 模式照样签发 agent Key，没有指定模型时 Codex 保留自己的默认模型（不写 `model`，也不接受档位与 effort）；指定了 HarnessHub 的模型时写 `model` 与 `model_reasoning_effort`。请求的 `model: null`（`hh wire --no-model`）回到 Codex 自己的模型；选项切换到 ChatGPT 模式时不沿用 API 模式的模型。Key 的模型白名单与隐藏列表同样适用于合并列表。
- **旧记录**：本记录之前以 ChatGPT 模式接线的记录没有 Key，照旧只转发；它们的 HarnessHub 模型请求得到 401。`hh wire codex --rotate` 给它们签发第一把 Key。

## 考虑过的替代方案

- **信任回环连接、不要求 Key**（Magpie 的做法，或网关按 Agent 自己查找 Key）：任何本机进程都能不带凭据使用 HarnessHub 的 provider 凭据，绕过了 `/v1` 上要求的 Key，也没有按 Agent 的白名单、额度与账本归属。
- **按 User-Agent 识别 Codex**：User-Agent 不是凭据，任何进程都能发送 `codex_cli_rs/…`。
- **Key 放在查询串里**：Codex 把路径接在基址字符串后面，查询串会落在路径中间。
- **改用 `model_provider = harnesshub` 并保留 ChatGPT 的模型**：Codex 的内置 OpenAI provider 不能被用户条目覆盖，自定义 provider 又不能使用 ChatGPT 登录；那就是现有的 API 模式。
- **用 ChatGPT 账号 ID 识别调用方**：账号 ID 不是秘密，任何进程都能伪造；验证令牌还需要访问 OpenAI。
- **ChatGPT 模式必须指定模型**（Magpie 写 `model = <ref>`，它的 Ref 也能指向 Codex 自己的模型）：HarnessHub 的 Model Ref 不包括 ChatGPT 自己的模型，必须指定就会替换用户原来的默认模型。

## 后果

- Key 以明文出现在 `config.toml` 的 `openai_base_url` 中。API 模式本来就把它写在 `experimental_bearer_token` 里，但 URL 可能出现在 Codex 自己的调试日志与诊断信息中，那里不受 HarnessHub 控制；这是这种方式的已知风险。Key 只能在回环监听器上使用，按 Agent 签发，可以轮换（`hh wire codex --rotate`），还原时吊销。
- 接线的公共语义改变：`WiringAdapter.keyless` 与 `isKeyless` 移除，改为 `modelOptional` 与 `isModelOptional`；`AdapterTarget` 增加 `ownModel`；`WiringRequest.model` 可以为 null。`WiringRecord.keyId` 仍是可选，只为旧记录保留。
- 每次转发的 Codex 请求在带 Key 时多做一次 Key 校验与模型列表计算（用于 `X-Models-Etag`）。
- ChatGPT 的模型列表取不到时，Codex 看不到 HarnessHub 的模型（Magpie 退回 Codex 缓存的列表；本网关不读 Codex 的目录）。

## 验证

- 网关 HTTP（回环假 ChatGPT 与假上游、合成密钥）：路径中的 Key 不转发、不入账、不进日志；HarnessHub 的模型在本地服务，上游收到的是 provider 的凭据，没有 ChatGPT 的令牌与账号头；合并列表的顺序、优先级与 `ETag`，转发答复的 `X-Models-Etag` 与之相同；没有 Key 时 HarnessHub 的模型本地 401；错误、未知或已吊销的 Key 对列表、调用与压缩一律本地 401，答复不含 Key 与路径；局域网入口拒绝带 Key 的形式。
- 正式守护进程（白名单之外拒绝 `ChatGPT-Account-Id` 与 `originator` 请求头的假 provider、OTLP 收集器、debug 日志级别，ChatGPT 是记录请求的回环替身，测试不会访问 chatgpt.com）：Codex 自己的模型转发到替身时带着它的登录、不带 Key；接线写入的 Key 能调用，错误的或没有 Key 时 401，轮换后旧 Key 401，还原后 Key 被吊销；上游只收到 provider 的凭据；结束后在数据目录（SQLite 与 WAL、日志、接线备份）、配置目录、Agent 的 home 与 OTLP 导出中逐字节查找每把 Key、ChatGPT 令牌与账号 ID，都不存在。
- 没有 Key 的旧记录重新接线时，预览显示 `openai_base_url` 从不带 Key 到带 Key（掩码）的改动与新 Key 的 ID。
- 接线（库层与正式守护进程入口）：ChatGPT 模式写入带 Key 的基址并通过漂移检测与 `wiredKeyText`；写入的 Key 能经 Codex 路径调用网关的模型，没有 Key 时 401；指定模型与 effort、`model: null` 还原用户原来的模型；与 API 模式互相切换；Profile 应用。
- 尚未用真实的 Codex（ChatGPT 登录）验证模型选择器中的合并列表与 HarnessHub 模型的调用。
