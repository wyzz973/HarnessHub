# 目录同步

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 集成：[agents-wiring-sync.test.ts](../../../tests/integration/agents-wiring-sync.test.ts) 经 `startHub`（临时 `wiringHome`）与严格假上游：provider 增删模型与改窗口后 OpenCode 与 Droid 的清单随之改写，Key 不变且与 `/v1/models` 一致，用户改过的 Pi 文件不被改写并标出 `AGENT_FILES_CHANGED`，所选模型离开网关的 Crush 标出 `AGENT_MODEL_UNAVAILABLE`，`autoSync: false` 不改写，无效设置启动失败；[switches.test.ts](../../../tests/integration/switches.test.ts) 验证关闭 provider 后不等同步就标出；macOS arm64 本机通过；其他 Adapter 只经同一路径，没有单独的同步用例；没有用真实 Agent 验证；Windows 未验证 |
| 对照 Magpie | 有意不同：目录变化时同样改写 Agent 文件，但用户改过的 Agent 被跳过并标为需要处理，而不是被覆盖（[Agents and wiring](../../magpie-parity.md#agents-and-wiring)） |
| 权威文档 | [目录同步](../../global-wiring.md#目录同步)、[配置参考：设置](../../configuration.md#设置)（`wiring.autoSync`）、[ADR 0022](../../decisions/0022-agent-wiring-semantics.md) |

## 用途

provider、模型或路由组变化后，让已接线 Agent 文件中的模型清单跟上网关现在能给这把 Key 的模型，用户不必逐个重新接线。用户自己改过的 Agent 不会被覆盖，而是被标出来，由用户决定。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 自动进行；Agent 首页与详情把被跳过的 Agent 标为“需要处理”，并显示原因 |
| 命令行 | 自动进行；`hh agents` 的 DRIFT 列显示原因，`hh provider disable` 的输出标出受影响的 Agent；`config.jsonc` 的 `wiring.autoSync` 关闭（`hh config set`） |
| HTTP | 没有触发接口；`GET /api/v1/agents` 的 `wiring.attention{code、message、at}` |

## 已实现的能力

- 触发：provider 保存或删除（包括模型列表刷新与元数据补齐）、路由组的保存与删除，以及网关从没有搜索后端变为有、或反过来（影响 Codex 的 `web_search`）。
- 合并：守护进程等改动停下 500 ms 后才运行一轮，连续的改动只触发一次。
- 改写：对每个已接线、有 Key 的 Agent，把文件中的模型清单改写为该 Key 现在可见的模型；走正常的计划与写入路径（备份、原子写、回读校验），沿用文件中的 Key 与隐藏列表，与其他接线操作串行；清单没有变化时什么都不写。
- 跳过并标出：自上次写入后文件被改动（漂移，`AGENT_FILES_CHANGED`）、Key 已吊销或丢失（`AGENT_KEY_INACTIVE`）、文件中已没有它的 Key（`AGENT_KEY_NOT_IN_FILES`）、所选模型、档位模型或 Key 允许的模型已不在网关上（`AGENT_MODEL_UNAVAILABLE`）；标记留到下一次同步或接线操作成功。
- 即时判断：`AGENT_MODEL_UNAVAILABLE` 不等同步，每次生成 Agent 视图时按当时的目录判断；关闭 provider 或删除模型一提交就标出，模型回来时标记随即消失，关闭同步时也一样；`at` 是第一次标出的时间。
- 每个 Agent 单独处理，一个失败不影响其他；每轮结果写入日志（`wiring.synced`、`wiring.sync_skipped`，整轮失败为 `wiring.sync_failed`）。
- 关闭：`wiring.autoSync: false`（`config.jsonc` 或 `startHub` 的 `wiring` 选项）停止改写，默认开启，由 `resolveWiringSettings` 解析，其他取值使启动失败；守护进程关闭时等待进行中的一轮结束。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [agents-wiring.ts](../../../packages/daemon/src/agents-wiring.ts)（`catalogChanged`、`syncCatalog`、`resolveWiringSettings`）、[main.ts](../../../packages/daemon/src/main.ts)（模型平面存储的写入与搜索后端变化时调用）、[config-file.ts](../../../packages/daemon/src/config-file.ts) |
| 测试 | [agents-wiring-sync.test.ts](../../../tests/integration/agents-wiring-sync.test.ts)、[switches.test.ts](../../../tests/integration/switches.test.ts) |
| 决策 | [ADR 0022 补充（目录同步）](../../decisions/0022-agent-wiring-semantics.md) |

## 已知限制与未验证

- 标记（`attention`）只在内存中，守护进程重启后由下一次同步或视图重新得出；漂移本身仍由每次视图的 `drift` 字段显示。
- 一轮同步只在目录变化时发生，没有命令或接口可以手动再同步一次；整轮失败只记日志，不重试。
- 没有 Key 的旧记录（ADR 0030 之前的 Codex ChatGPT 模式）不参与同步。
- 被跳过的 Agent 要重新接线（换一把新 Key）或还原才能恢复，没有“接受用户改动后只更新清单”的路径。
- 只有 OpenCode、Droid、Pi、Crush 有专门的同步用例；没有用真实 Agent 验证改写后的清单生效；Windows 未验证。

## 优化候选

- **现状**：同步只能由目录变化触发，整轮失败只写日志。**方向**：提供手动同步的命令与接口（例如对单个 Agent 重新按当前目录改写），失败时在视图中标出并可重试。**依据**：阅读 [agents-wiring.ts](../../../packages/daemon/src/agents-wiring.ts) `catalogChanged` 的观察（失败只记 `wiring.sync_failed`）。
- **现状**：漂移的 Agent 只能换 Key 重新接线。**方向**：对只改了 HarnessHub 未写的键或只改了模型选择的情况，允许在预览后保留用户改动、只更新模型清单与 Key。**依据**：对照表 catalog 一行的有意不同；[ADR 0022](../../decisions/0022-agent-wiring-semantics.md) 中“跳过并标出，由用户决定重新接线”。
- **现状**：同步只覆盖 4 个 Adapter 的专门用例。**方向**：把“目录变化后清单改写、Key 不变”加入 `wiring-suite.ts` 的共用用例，让每个写模型清单的 Adapter 都跑一遍。**依据**：[全局接线：验证](../../global-wiring.md#验证)中的覆盖范围。
