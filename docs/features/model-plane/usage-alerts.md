# 额度读数与用量提醒

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关测试（读数来自限流响应头、经处理函数保存并在启动时读回、每个 Credential 至多 16 个窗口，`smart` 与 `pace` 的排序）；守护进程单元测试（到线、同一轮不重复、窗口重置后再提醒、回落后清除、过期读数、40 天删除、0600 文件、损坏文件按空处理）；经正式守护进程与带限流响应头的本地上游的集成测试；Copilot 额度读数经假的 SDK 附加组件验证；控制台在 Chromium 中走查过凭据状态与 Copilot 读数；macOS arm64。真实厂商的限流响应头与真实 Copilot 额度未验证；Windows 未验证 |
| 对照 Magpie | 部分：只有额度窗口提醒，阈值、节奏与“每轮一次”同 Magpie，没有余额提醒与系统通知；有意不同：读数只来自调用的答复与 Copilot SDK，不轮询厂商用量接口；未覆盖：中转站余额（[对照表](../../magpie-parity.md#subscriptions)） |
| 权威文档 | [用量提醒](../../gateway-features.md#用量提醒)、[额度读数与 smart、pace](../../subscriptions.md#额度读数与-smartpace)、[资源](../../model-plane-api.md#资源)（usage alerts） |

## 用途

网关从上游的答复中记下每个凭据的额度窗口用了多少、何时重置，用来在多个账号或 Key 之间分配请求，并在某个窗口用到设定的百分比时提醒用户，避免额度在工作中途用完。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 网关功能 → 用量提醒（1–100% 或关闭）；用量页顶部的提醒与导航中“用量”的标记；路由与 Key → 凭据状态、Provider 详情与订阅账号页中的额度读数 |
| 命令行 | `hh gateway alert [PERCENT\|off]`（不带参数时显示阈值与最近 40 天的提醒） |
| HTTP | `PUT`、`DELETE /api/v1/gateway/features/alerts`；`GET /api/v1/usage/alerts`；`GET /api/v1/routing/state` 的 `readings` |

## 已实现的能力

- 读数 `{window, usedPercent, resetsAt?, spanSeconds?, observedAt}` 只来自上游自己给出的信息：每个答复的限流响应头（OpenAI `x-ratelimit-*`、Anthropic `anthropic-ratelimit-*`），以及 Copilot SDK 的 `account.getQuota`（每个账号回答之后至多每分钟读一次，`premium_interactions` 等非无限窗口）。
- 读数保存在 `<dataDir>/allowance-readings.json`（0600，原子替换），变化后一分钟内与关闭时写入，启动时读回；过了重置时间的窗口算作未用，没有重置时间的读数 24 小时后失效；每个 Credential 至多 16 个窗口，编造窗口名的上游不能让它无限增长。
- `least-used`、`smart` 与 `pace` 路由组按读数排序；关闭再打开凭据时休息被清除，读数保留。
- 提醒阈值 `alerts.usagePercent` 保存在网关功能设置中，随备份与同步带走；守护进程启动 1 分钟后、之后每 5 分钟检查一次，阈值设置或改变时立即检查。
- 某个窗口的已用百分比不低于阈值时提醒一次；同一轮窗口不再提醒，重置后再次到线时再提醒；回落到阈值以下时清除标记；窗口已重置的旧读数既不提醒也不清除。
- 每次检查在 `gateway.log` 写一行 `usage.alert`（阈值、到期提醒数与至多 16 个提醒的 provider、凭据 ID、窗口、已用百分比、重置时间，不含凭据值）；`GET /api/v1/usage/alerts` 返回阈值与最近 40 天的提醒，新到旧、至多 100 条，凭据仍在时带当前名称。
- 已提醒的窗口与提醒列表保存在 `<dataDir>/usage-alerts.json`，重启后不重复提醒；标记至多 2048 条，不再出现的窗口 40 天后删除；文件损坏时记 `usage.alerts_invalid` 并按空文件处理，从不阻止启动。
- 控制台在页面可见时每分钟读取提醒，显示在用量页顶部，导航中的“用量”带标记；“知道了”只在这个浏览器中隐藏已显示的提醒。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/routing.ts](../../../packages/gateway/src/routing.ts)（读数与 `MAX_WINDOWS`）、[gateway/copilot.ts](../../../packages/gateway/src/copilot.ts)（额度报告）、[daemon/subscriptions.ts](../../../packages/daemon/src/subscriptions.ts)（读数文件）、[daemon/usage-alerts.ts](../../../packages/daemon/src/usage-alerts.ts)、[daemon/usage-alerts-routes.ts](../../../packages/daemon/src/http/usage-alerts-routes.ts)、[console/usage-alerts.ts](../../../packages/console/lib/usage-alerts.ts) |
| 测试 | [shared-gateway-allowances](../../../packages/gateway/test/shared-gateway-allowances.test.ts)、[shared-gateway-routing-state](../../../packages/gateway/test/shared-gateway-routing-state.test.ts)、[daemon usage-alerts](../../../packages/daemon/test/usage-alerts.test.ts)；集成 [usage-alerts](../../../tests/integration/usage-alerts.test.ts)、[subscriptions-copilot](../../../tests/integration/subscriptions-copilot.test.ts) |
| 决策 | [ADR 0026 订阅账号的接入方式](../../decisions/0026-subscription-accounts.md)（额度读数与策略） |

## 已知限制与未验证

- HarnessHub 不主动查询厂商的用量接口：没有被调用过的凭据没有读数，ChatGPT 账号没有任何读数（OpenAI 不提供）。
- 没有余额提醒（不读取中转站的余额），没有系统通知或其他推送渠道；Magpie 的系统通知由它的菜单栏应用发出，HarnessHub 没有菜单栏应用。
- 命令行看不到全部读数：`hh gateway alert` 只列出到线的窗口，读数只在控制台与 `GET /api/v1/routing/state` 中。
- 控制台的“知道了”只保存在这个浏览器中，换浏览器或清除站点数据后已显示的提醒会再出现。
- Magpie 跳过的“不影响使用”的窗口在 HarnessHub 中没有对应。
- 真实厂商的限流响应头、真实 Copilot SDK 的额度报告与 Windows 都未验证。

## 优化候选

- **现状**：命令行没有读数视图。**方向**：增加列出每个凭据读数与熔断状态的 `hh` 命令。**依据**：对照表 Allowances 行的说明“no CLI view”。
- **现状**：中转站的余额既不读取也不提醒。**方向**：为提供余额接口的中转预设读取余额并按阈值提醒。**依据**：对照表 Balances of API-key relays 行未覆盖；[用量提醒](../../gateway-features.md#用量提醒)的“与 Magpie 的差别”。
- **现状**：提醒只写日志、接口与控制台。**方向**：可选的推送渠道（例如 webhook 或桌面通知）。**依据**：对照表 Quota and balance alerts 行为部分（no OS notification）。
- **现状**：关闭提醒只在一个浏览器中生效。**方向**：在守护进程记录确认状态，`GET /api/v1/usage/alerts` 返回是否已确认。**依据**：阅读 [控制台说明](../../../packages/console/README.md#页面与状态)用量页的观察。
