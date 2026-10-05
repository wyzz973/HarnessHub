# 失败转移、熔断与凭据休息

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试覆盖失败类别的判定顺序与每张词表的正反样例、每种类别的休息时长（推进时钟）、退避与重试上限、拒绝类转移、并发位与排队期限、钉选；经正式守护进程与严格假 provider 的集成测试覆盖拒绝转移、安全审查的路由项（回显、暂定休息、同厂商拒绝）与开关；协议一致性套件覆盖上游 400/401/429/500 与上下文超长的错误映射；macOS arm64 本机 `pnpm check` 通过。真实厂商的错误措辞与限流响应头没有录制语料；Windows 未验证 |
| 对照 Magpie | 相同：失败类别与休息、转移与只在最后一个候选上重试、`X-HH-Credential` 钉选；有意不同：休息的候选被跳过并半开探测、有界排队；部分：首字节前扣留、凭据状态视图；未覆盖：套餐拒绝推理档位时换账号（[对照表](../../magpie-parity.md#routing-route-groups-and-rules)） |
| 权威文档 | [路由、重试与熔断](../../model-gateway.md#路由重试与熔断)（“失败类别”“休息”“休息不受请求左右”“转移与重试”“首字节前扣留”）、[资源上限](../../model-gateway.md#资源上限)、[ADR 0025](../../decisions/0025-magpie-routing-parity.md) |

## 用途

上游失败时，网关按失败的原因决定这个 Credential 休息多久、要不要换下一个候选、要不要原处重试，让 Agent 尽量拿到一个回答，又不反复敲已知坏掉的上游。用户能看到每个凭据为什么在休息、何时恢复，也能把一次调用钉在某个凭据上。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 路由与 Key → 凭据状态（熔断状态、休息到期与倒计时、最近一次失败、额度读数）；Provider 详情的凭据表“路由状态”列与启用开关；Provider 编辑中的每凭据并发与排队 |
| 命令行 | `hh credential disable\|enable <provider> <credential>`、`hh provider disable\|enable <id>`（重新打开时清除休息）；`hh provider limits <id> [--concurrency N] [--queue N] [--clear]`；`hh config set gateway.limits.<键> <值>`（启动设置，重启守护进程后生效） |
| HTTP | `GET /api/v1/routing/state`；`PATCH /api/v1/providers/{id}/credentials/{credentialId}` 的 `enabled`；路由组的 `retry`；模型调用的 `X-HH-Credential: <ID 或名称>` 请求头 |

## 已实现的能力

- 失败类别（`failureKind`，词表集中在 `FAILURE_WORDS`）：先判断安全过滤器的拒绝 `policy`，再依次为 `proxy`、`verify`、`credit`、`rate`、`quota`、`auth`、`model`，400/422 中先排除客户端自己的错误（`request`），再分 `model`、`refused`、`other`、`shape`；408、5xx、超时与连接失败为 `other`；账本 `errorClass` 按类别取值。
- 休息：`credit` 与 `verify` 30 分钟；`quota` 到厂商说明的重置时间，否则 15 分钟、最长 8 天；`rate` 取响应头的等待，否则 1 分钟；`auth` 10 分钟；`model` 只标记该 Credential 与模型 10 分钟；`proxy`、`policy`、`shape` 不休息；`other` 连续 3 次后打开，60 秒起翻倍到 10 分钟。到期后半开放行一个探测，成功的调用随时结束休息；全部候选都在休息时不访问上游，只返回最近一次失败的状态与类别。
- 休息不受请求左右：决定休息的类别从去掉请求自身词语的错误体判断（`echoFree`）；一把 Key 的一次失败最多让共享的 Credential 休息 1 分钟（`PROVISIONAL_MS`），另一把 Key 的探测再次失败才给完整时长；模型标记的暂定 1 分钟只对触发它的 Key 生效。
- 转移：`request` 直接返回客户端，其他失败只要还有不在休息的候选就立即转移；`shape` 跳过同一 provider、同一上游协议的候选；`policy` 跳过同一厂商（端点主机相同）的候选，一次调用至多再问一个厂商，一把 Key 10 分钟内被拒绝超过 5 次后不再转移。
- 400 说出回复长度下限、而请求要求得更短时，同一候选抬高后重发一次（`max-tokens:floor:<n>`）；2xx 但什么都没说的安全拒绝回答按 400 `policy` 处理，它的用量计入账本与 Key 预算（`refused:usage:<n>`）。
- 重试只在最后一个还能尝试的候选上：`rate`、408、500、502、503、504、529 与连接失败，等待 1、2、4 秒或响应头给出的等待；计算的等待或 `Retry-After` 超过 8 秒、或本次调用等待合计超过 30 秒时不再等；5xx 最多 2 次、`rate` 最多 3 次；组的 `retry` 缺省 `perCandidate: 3`、`totalAttempts: 4`，不加抖动。
- 首字节前扣留：还有替代路径时，流式输出在第一个内容事件之前最多扣留 15 秒或 1 MiB，期间的流内错误按首字节前失败转移；首字节送达后的失败只在流内报告。
- 每个 Credential 默认同时 8 个上游请求、排队 64 个，provider 的 `limits` 可另设；空出的并发位给占用最少的 Key；排满或排队超过 `slotWaitMs`（60 秒）时 429 `busy` 并转移。
- 守护进程出站代理的失败为 `proxy_failed`：不在同一候选上重试，不计入熔断。
- `X-HH-Credential` 按 ID 或名称钉选：都在休息时 429 `credential_resting`，候选不能服务该模型时 400 `credential_unserved`，候选之外的 Credential 一律 404 `credential_not_found`；请求头不发往上游，账本记 `credential:pinned`。
- 关闭再打开 Credential 或 provider 时调用 `liftRest`，清除其休息与模型标记，额度读数保留；`GET /api/v1/routing/state` 给出每个 Credential 的 `closed`/`open`/`half-open`、`restingUntil`、不含消息文字的 `lastFailure` 与读数。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/routing.ts](../../../packages/gateway/src/routing.ts)（`failureKind`、`echoFree`、`Breakers`、`REST_MS`）、[gateway/http.ts](../../../packages/gateway/src/http.ts)（`Slots`）、[gateway/limits.ts](../../../packages/gateway/src/limits.ts)、[gateway/server.ts](../../../packages/gateway/src/server.ts)、[daemon/routing-state-routes.ts](../../../packages/daemon/src/http/routing-state-routes.ts)、[console/routing-state.tsx](../../../packages/console/components/routing-state.tsx) |
| 测试 | [shared-gateway-failover](../../../packages/gateway/test/shared-gateway-failover.test.ts)、[refusal-failover](../../../packages/gateway/test/refusal-failover.test.ts)、[slots](../../../packages/gateway/test/slots.test.ts)、[shared-gateway-concurrency](../../../packages/gateway/test/shared-gateway-concurrency.test.ts)、[shared-gateway-pinning](../../../packages/gateway/test/shared-gateway-pinning.test.ts)、[shared-gateway-routing-state](../../../packages/gateway/test/shared-gateway-routing-state.test.ts)；集成 [refusal-failover](../../../tests/integration/refusal-failover.test.ts)、[routing-review](../../../tests/integration/routing-review.test.ts)、[switches](../../../tests/integration/switches.test.ts)、[concurrency-stand-in](../../../tests/integration/concurrency-stand-in.test.ts) |
| 决策 | [ADR 0025 对齐 Magpie 的路由、失败休息与 Codex 透传](../../decisions/0025-magpie-routing-parity.md)（含补充“拒绝类 400/422 与安全拒绝的转移”与 2026-10-05 修订）、[ADR 0035 出站代理](../../decisions/0035-outbound-proxy.md) |

## 已知限制与未验证

- 熔断状态与模型标记只在内存中，守护进程重启后清空（额度读数会恢复）；熔断状态变化只写日志，没有 `route.breaker` 事件。
- 没有单独“结束休息”的操作：只能关闭再打开 Credential 或 provider；`auth` 休息最长 10 分钟后进入半开，而不是一直保持到 Credential 更新。
- 套餐拒绝所请求推理档位的账号没有对应的失败类别；没有 Magpie 对 ChatGPT `safety_buffering` 与只有推理的流的 4 分钟扣留，推理已送达后才出现的拒绝不再转移。
- 尚未对齐：OpenRouter 免费模型共享池只休息该模型、最后的失败是额度类时返回更早的其他失败；被拒绝的尝试的用量只计在该尝试上，不进入这次调用的用量（Magpie 单独记一条）。
- 没有查看在途请求与排队数的端点（Magpie 的 `GET /v1/magpie/concurrency`）；命令行没有凭据状态视图。
- 真实厂商的错误措辞、限流响应头与重置时间格式只按公开文档实现，没有录制语料；Windows 未验证。

## 优化候选

- **现状**：结束一个 Credential 的休息只能关闭再打开它。**方向**：增加 `liftRest` 的独立接口与 `hh credential` 子命令，并给出 `hh` 的凭据状态视图。**依据**：对照表 Per-credential state 行为部分。
- **现状**：熔断状态变化只写日志。**方向**：发布 `route.breaker` 事件，供控制台与 OTLP 使用。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)的“尚未实现”。
- **现状**：套餐不接受所请求推理档位的账号会把错误交给客户端。**方向**：增加对应失败类别，转给同一 provider 中接受该档位的其他账号且不休息。**依据**：对照表 refused reasoning level 行未覆盖。
- **现状**：看不到每个 Credential 的在途请求与排队。**方向**：在 `/api/v1/routing/state` 与凭据状态页签中加入并发位与排队数。**依据**：对照表 Concurrency limit 行的说明。
- **现状**：失败分类的词表只有手写样例。**方向**：录制真实厂商的错误与限流响应头语料，作为分类测试的输入。**依据**：[ADR 0025](../../decisions/0025-magpie-routing-parity.md) 验证要求中“没有录制语料”；TODO OSS-009 未做的 `tools/capture-corpus`。
