# 路由组与策略

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | core 与网关单元测试（内存存储、回环假上游），经正式守护进程与严格假 provider 的集成测试；macOS arm64 本机 `pnpm check` 通过。没有用真实 provider 跑过路由组（2026-10-05 的 DeepSeek 真实验证只请求单个 Model Ref）；`:fast` 未在真实 OpenAI 与 Anthropic 端点验证；Windows 未验证 |
| 对照 Magpie | 部分：`order`、`rotate`、`least-used`（Magpie 的 `usage`）与嵌套组相同；`smart`、`pace` 与裸名称有意不同；粘性、成员后缀、自动组与组宣称的能力为部分；`manual` 未覆盖（[对照表](../../magpie-parity.md#routing-route-groups-and-rules)） |
| 权威文档 | [路由、重试与熔断](../../model-gateway.md#路由重试与熔断)、[模型解析与列表](../../model-gateway.md#模型解析与列表)、[额度读数与 smart、pace](../../subscriptions.md#额度读数与-smartpace)、[模型平面 CLI](../../model-plane-api.md#cli) |

## 用途

把多个模型或 Credential 组织成一个名字 `group/<id>`，客户端只请求这个名字，网关按策略决定先问谁、失败后换谁。成员可以固定推理强度、使用厂商的快速模式或嵌套另一个组；几个 provider 提供同一个模型时自动成组，不能写 `provider/model` 的客户端也可以只写模型名。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 路由与 Key → 路由组（策略、粘性、成员的推理强度、`fast` 与组中的组，可上下移动）；路由与 Key → 自动路由组（隐藏、恢复） |
| 命令行 | `hh group list`、`hh group add <id> --member REF... [--strategy S] [--stickiness S]`、`hh group remove <id>`、`hh group auto`、`hh group hide\|restore <auto-id>` |
| HTTP | `GET`、`POST /api/v1/route-groups`；`GET`、`PATCH`、`DELETE /api/v1/route-groups/{id}`；`GET /api/v1/auto-groups`、`POST /api/v1/auto-groups/{id}/hide\|restore`；模型调用中的 `model: "group/<id>"` 或裸名称 |

## 已实现的能力

- 六种策略：`order` 按配置；`rotate` 每次调用从下一个成员开始；`latency` 取首内容时间指数平均最小的成员，样本少于 5 次的优先；`least-used` 把全部成员的 Credential 一起排序，先比上游限流头的已用比例，再比每小时减半的 token 数，启动时从账本读最近 8 小时、至多 5000 条成功调用作初值；`smart` 与 `pace` 按 Credential 的额度读数分 fine、low、spent 三档排序。
- `POST /api/v1/route-groups` 不给策略与粘性时为 `order` 与 `auto`。
- 成员写法：`provider/model`、`provider/model:<effort>`（`none` 到 `max`，无论请求要什么都用这个强度）、最后再加 `:fast`，或 `group/<id>`；provider 列出的含冒号的模型 ID（`qwen:7b`）不拆分；写入时校验并把后缀转为小写。
- 固定强度在 Chat 直通时写入 `reasoning_effort`、Responses 直通时写入 `reasoning.effort`，Anthropic 与 Gemini 入站为此改为转换；账本 `patches[]` 记 `member-effort:<level>`。
- `:fast` 只在 api.openai.com 的 GPT 与 o 系列、ChatGPT 账号的 GPT（`service_tier: "priority"`）和 api.anthropic.com 上有快速模式的 Claude Opus（`speed: "fast"` 加 beta 头）上发送；其他上游照常发送，原因记在候选的 `skipped` 中。
- 组中的组最多 8 层、不能包含自身；被其他组用作成员的组不能删除，被用作成员的自动组不能隐藏（409 `ROUTE_GROUP_IN_USE`）。`order`、`rotate`、`latency` 下内层组整体占一个位置，`least-used`、`smart`、`pace` 下以它第一个未休息的候选参与排序。
- 组在 `/v1/models` 与 Agent 接线目录中宣称的能力由 core 的 `groupCapabilities` 统一计算：最小的窗口与输出上限、模态的交集、跟随请求的成员共有的推理档位。
- 粘性让同一会话留在上次应答的 Credential：`auto`（同一轮总是留下，跨轮只在上次读了至少 1024 个缓存 token 且不到 5 分钟时留下）、`session`、`turn`、`off`；会话键依次取 `x-hh-conversation`、客户端自带的标识、system 加第一条用户消息的哈希，按 Gateway Key 隔离；结果写入 `patches[]` 的 `sticky:*`。
- 自动路由组 `group/auto-<slug>`：两个以上就绪的 provider 在 `expose` 中提供同一规范名的模型时派生，不存储，同 ID 的用户组优先，隐藏的 ID 存在 `hidden_auto_groups` 表；Key 要在白名单中列出它才能使用。
- 裸名称（不带 `provider/`）依次解析为 ID 等于名称的组、规范名的组、未隐藏的自动组、唯一在 `expose` 中提供它的模型、唯一列出它的模型，只看这把 Key 能用的；几个 provider 都有时 400 `model_ambiguous`，账本保留请求的名称。
- `group/default` 是 Session 的 Run 没有指定 `model` 时的目标（[Session Run 与共享网关](../../model-gateway.md#session-run-与共享网关)），控制台任务输入框的缺省项在它存在时指向它。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [core/route-groups.ts](../../../packages/core/src/route-groups.ts)、[core/auto-groups.ts](../../../packages/core/src/auto-groups.ts)、[gateway/routing.ts](../../../packages/gateway/src/routing.ts)、[gateway/members.ts](../../../packages/gateway/src/members.ts)、[gateway/sticky.ts](../../../packages/gateway/src/sticky.ts)、[gateway/bare-names.ts](../../../packages/gateway/src/bare-names.ts)、[daemon/model-sessions.ts](../../../packages/daemon/src/model-sessions.ts)、[console/groups-page.tsx](../../../packages/console/components/groups-page.tsx) |
| 测试 | [core route-groups](../../../packages/core/test/route-groups.test.ts)、[core auto-groups](../../../packages/core/test/auto-groups.test.ts)、[group-members](../../../packages/gateway/test/group-members.test.ts)、[shared-gateway-routing](../../../packages/gateway/test/shared-gateway-routing.test.ts)、[shared-gateway-sticky](../../../packages/gateway/test/shared-gateway-sticky.test.ts)、[shared-gateway-allowances](../../../packages/gateway/test/shared-gateway-allowances.test.ts)、[shared-gateway-auto-groups](../../../packages/gateway/test/shared-gateway-auto-groups.test.ts)、[shared-gateway-bare-names](../../../packages/gateway/test/shared-gateway-bare-names.test.ts)；集成 [groups-budgets](../../../tests/integration/groups-budgets.test.ts)、[bare-model-names](../../../tests/integration/bare-model-names.test.ts)、[api-v1](../../../tests/integration/api-v1.test.ts) |
| 决策 | [ADR 0025 对齐 Magpie 的路由](../../decisions/0025-magpie-routing-parity.md)、[ADR 0031 路由组成员与 Key 预算](../../decisions/0031-group-members-and-key-budgets.md) |

## 已知限制与未验证

- 粘性记录只在内存中（最近 512 个会话、24 小时），守护进程重启后重新开始；账本没有专门的粘性字段，只写在 `patches[]` 中。
- `latency` 只统计本次启动以来的调用。
- 固定的强度原样发送，不按模型可用的档位调整，因为模型元数据只记录“会推理”，没有档位清单。
- `smart` 与 `pace` 的读数只来自限流响应头与 Copilot SDK；ChatGPT 账号与没有被调用过的 Credential 没有读数。
- 没有 Magpie 的 `manual` 策略、组自定义的 `context`、`levels` 与 `family`，自动组没有 `modelSameAs` 手工合并与全局开关；新组缺省 `order`，Magpie 缺省 `smart`。
- `hh group` 没有修改已有组的子命令（再次 `add` 得到 409 `ROUTE_GROUP_EXISTS`），改成员、策略或粘性要经控制台或 `PATCH`；组的 `retry` 只能经 API 设置。
- 真实 provider 上的路由组、真实 OpenAI 与 Anthropic 的快速模式、Windows 都未验证。

## 优化候选

- **现状**：粘性记录只在内存中，重启后会话可能换到另一个 Credential，提示缓存与推理签名失效。**方向**：持久化粘性记录，并在账本中加粘性字段代替 `patches[]`。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)的“尚未实现”；对照表 Stays 行为部分。
- **现状**：命令行只能新建或删除组。**方向**：增加 `hh group set <id>`（成员、策略、粘性、重试），对应已有的 `PATCH /api/v1/route-groups/{id}`。**依据**：阅读 [admin.ts](../../../packages/cli/src/admin.ts) 的观察。
- **现状**：固定强度原样发送，模型不支持该档位时由上游拒绝。**方向**：模型元数据增加档位清单后按最接近的档位发送。**依据**：[ADR 0031](../../decisions/0031-group-members-and-key-budgets.md) 的替代方案；对照表 Member suffixes 行为部分。
- **现状**：没有 `manual` 策略与组的 `context`、`levels` 覆盖。**方向**：补齐这两项。**依据**：对照表 `manual` 行未覆盖、组宣称能力行为部分；[ADR 0032](../../decisions/0032-group-rules-and-classifier.md) 后果中的“未做”。
- **现状**：自动组只按规范名合并，不能手工合并不同拼写，也不能整体关闭。**方向**：增加 `modelSameAs` 与全局开关。**依据**：对照表 Automatic groups 行为部分。
