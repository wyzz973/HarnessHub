# Gateway Key

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（每种拒绝及其账本记录与节流、白名单、预算窗口跨夏令时与跨月、在途预留、路径中的 Key）、core Key 文本测试；经正式守护进程的集成测试（签发与吊销、预算与 `hh key`、迁移 6、重命名与暂停、Key 文本不出现在答复、日志、账本与数据目录中、路径中的 Key）；2026-10-05 的 DeepSeek 真实验证中 SDK 以 `client:` Key、5 个真实 Agent 以各自的 `agent:` Key 调用并正确归属；macOS arm64。Windows 未验证 |
| 对照 Magpie | 相同：按 Key 的本地日历预算、预留与 429、Key 自查额度、局域网 Key；有意不同：回环调用也必须带 Key、Key 文本只显示一次、不能发请求头的 Agent 把 Key 放在路径中；部分：改名、停用与轮换（[对照表](../../magpie-parity.md#lan-sharing-and-gateway-keys)） |
| 权威文档 | [鉴权与拒绝](../../model-gateway.md#鉴权与拒绝)、[路径中的 Key](../../model-gateway.md#路径中的-key)、[模型平面 API 的资源](../../model-plane-api.md#资源)、[模型平面 CLI](../../model-plane-api.md#cli) |

## 用途

每个使用网关的 Agent、脚本或 Run 都持有一把 Gateway Key：它决定能用哪些模型、每天每周每月能花多少、每分钟能发多少请求，账本也按它归属用量。Key 可以随时改名、暂停、恢复或吊销，丢失的 Key 不会因为备份或数据目录泄露而被还原出来。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 路由与 Key → Gateway Key（创建时可勾选“局域网”与设置额度，列表中改名、暂停、恢复、吊销，“用量”看每个预算本窗口的用量）；Agent 详情（换 Key、暂停与恢复 Key） |
| 命令行 | `hh key list`、`hh key create --name N --allow REF... [--expires-at TIME \| --no-expiry] [--lan] [--rpm N] [--budget PERIOD:tokens=N,cost=USD,cache-reads]...`、`hh key quota <keyId> ... \| --clear`、`hh key limit\|rename\|suspend\|resume\|revoke <keyId>`；`hh wire <agent> --rotate` |
| HTTP | `GET`、`POST /api/v1/gateway-keys`；`GET`、`PATCH /api/v1/gateway-keys/{id}`；`POST .../suspend`、`.../resume`、`.../revoke`；`GET .../limit`；`PUT .../quota`；持 Key 的客户端读自己的 `GET /v1/harnesshub/limit` |

## 已实现的能力

- 三种作用域：`agent:`（接线时为每个 Agent 签发，只写入该 Agent 的配置文件）、`client:`（`hh key create` 与管理接口只签发这一种，`modelAllow` 必填）、`session:`（Session 的 Run 使用，只能用 Run 选定的目标，没有活动 Run 时 409 `no_active_run`）。
- 格式 `hhk_<a|c|s>_<12 位 ID>_<43 位密钥>`；文本只在创建响应中出现一次，存储只保存密钥部分的 SHA-256，列表与详情不含哈希；备份只带 `client:` Key 的名称、白名单、局域网标记、预算与过期时间，恢复时打印可重新签发的 `hh key create` 选项。
- Key 可放在 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 或 Gemini 的 `?key=`；同一请求中取值不同返回 401。按 `key_revoked`、`key_suspended`、`key_expired`、`invalid_key` 的顺序拒绝，错误消息从不回显 Key；网关每个请求都读 Key 记录，暂停、恢复与吊销从下一个请求起生效。
- 白名单 `modelAllow`（Model Ref、`provider/*`、`group/<id>`、`*`）与 `modelDeny`（Agent 隐藏的模型，经路由组、自动组与裸名称同样用不到）；不允许时 403 `model_not_allowed`。
- 缺省 90 天后过期，`expiresAt: null` 不过期；`allowLan` 只能用于 `client:` Key，且必须有过期时间。
- 预算 `budgets[]`：日、周、月为守护进程本地时区的日历窗口，每个窗口 `tokens` 与/或 `costUsd`，`cacheReads` 时缓存读取也计入，上限 0 表示封住；放行的请求持有预留（请求体字节 / 4 加本窗口平均输出），已用加在途预留达到上限即拒绝，并发请求最多超出约一次调用。
- `requestsPerMinute` 是令牌桶；超额返回 429 `quota_exceeded`，带 `retry-after`、`x-should-retry: false`（预算拒绝）与 `x-hh-limit-reset`，Gemini 错误体带 `RetryInfo`；拒绝写入账本并按 Key 与原因节流。
- 网关为一次请求自己发出的调用（图片描述、分类器）与联网搜索的每次查询都记在这把 Key 名下，占用它的预算或每分钟请求数。
- 改名（`client:` Key 的 `scope.name` 一并更新）、暂停（`suspendedAt`，Key 保留）、恢复、吊销；Agent 的 Key 同样可以暂停，接线视图 `keyState` 为 `suspended`，解除接线照常吊销；`hh wire <agent> --rotate` 给 Agent 换一把新 Key。
- 不能发送请求头的 Agent（Command Code、fx、Muse）把 `agent:` Key 写在基址路径 `<网关>/k/<Key>/v1` 中，ChatGPT 模式的 Codex 写在 `/backend-api/codex/<Key>/`；两者只在回环监听器上可用，`client:` 与 `session:` Key 放在路径中返回 401。
- Key 文本不出现在日志、问题详情、账本、CSV 与 OTLP 导出中（`redactKeyText`、`keylessPath`），出站脱敏也在发往上游之前替换它；`lastUsedAt` 每把 Key 每分钟至多更新一次。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [core/model-plane.ts](../../../packages/core/src/model-plane.ts)（`GatewayKeyRecord`、`issueGatewayKey`）、[core/key-text.ts](../../../packages/core/src/key-text.ts)、[gateway/server.ts](../../../packages/gateway/src/server.ts)、[gateway/quota.ts](../../../packages/gateway/src/quota.ts)、[gateway/key-path.ts](../../../packages/gateway/src/key-path.ts)、[daemon/model-plane-routes.ts](../../../packages/daemon/src/http/model-plane-routes.ts)、[console/keys-page.tsx](../../../packages/console/components/keys-page.tsx)、[console/key-budgets.tsx](../../../packages/console/components/key-budgets.tsx) |
| 测试 | [shared-gateway](../../../packages/gateway/test/shared-gateway.test.ts)、[key-budgets](../../../packages/gateway/test/key-budgets.test.ts)、[shared-gateway-keypath](../../../packages/gateway/test/shared-gateway-keypath.test.ts)、[core key-text](../../../packages/core/test/key-text.test.ts)；集成 [api-v1](../../../tests/integration/api-v1.test.ts)、[groups-budgets](../../../tests/integration/groups-budgets.test.ts)、[switches](../../../tests/integration/switches.test.ts)、[key-text-leaks](../../../tests/integration/key-text-leaks.test.ts)、[agents-keypath](../../../tests/integration/agents-keypath.test.ts)、[codex-chatgpt-key](../../../tests/integration/codex-chatgpt-key.test.ts) |
| 决策 | [ADR 0031 路由组成员与 Gateway Key 预算](../../decisions/0031-group-members-and-key-budgets.md)、[ADR 0033 Key 放在路径中](../../decisions/0033-gateway-key-in-path.md)、[ADR 0030 Codex 的 ChatGPT 模式](../../decisions/0030-codex-chatgpt-mode-models.md) |

## 已知限制与未验证

- `client:` Key 不能轮换，只能吊销后重新签发（Agent 的 Key 可以 `hh wire --rotate`）。
- 成本预算只计有价格的调用：没有价格的模型与联网搜索 API 的费用不进入 `costUsd`，只受 token 预算与每分钟请求数约束。
- 在途预留只在网关进程的内存中；局域网 Key 不要求设置预算，也没有按来源 IP 的失败锁定。
- 路径中的 Key 以明文出现在这些 Agent 的配置文件中，也可能出现在它们自己的调试日志里；`GET /muse-code/models` 是网关唯一不要求凭据的读取。
- Key 文本识别不了只有 43 个字符的密钥本身（与较长的部署名无法可靠区分）。
- Key 列表一次返回全部，没有分页；没有 ETag 与 `Idempotency-Key`。
- 真实 Command Code、fx、Muse 与 ChatGPT 模式的 Codex 未验证路径中的 Key；Windows 未验证。

## 优化候选

- **现状**：`client:` Key 只能吊销重签，持有它的脚本要同时换配置。**方向**：增加轮换（新文本、同 ID 的名称、白名单与预算），可设旧文本的宽限期。**依据**：对照表 Rename, disable, rotate 行为部分。
- **现状**：只有成本预算的 Key 可以无限使用没有价格的模型。**方向**：为 `costUsd` 预算增加“拒绝未定价模型”的选项，或在创建时提示。**依据**：阅读 [鉴权与拒绝](../../model-gateway.md#鉴权与拒绝)中额度规则的观察。
- **现状**：局域网 Key 没有预算要求与失败锁定。**方向**：签发 `--lan` Key 时要求至少一项预算，并按来源 IP 锁定反复失败的鉴权。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)；[ADR 0021](../../decisions/0021-gateway-lan-sharing.md) 后果。
- **现状**：Key 等配置列表不分页，也没有并发写保护。**方向**：实现游标分页、ETag 与 `If-Match`。**依据**：[认证与错误](../../model-plane-api.md#认证与错误)末尾的“尚未实现”。
