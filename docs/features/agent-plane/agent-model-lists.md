# 每个 Agent 的模型清单

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 集成：[agents-wiring-semantics.test.ts](../../../tests/integration/agents-wiring-semantics.test.ts) 经 `startHub` 与严格假上游：隐藏与显示同时改变 Agent 文件中的清单、该 Key 的 `/v1/models` 与调用（403），Key 不变，网关新增的模型默认显示，真实 `hh agents models` 入口；单元：`wiring-semantics.test.ts` 覆盖 `wiredKeyText`；macOS arm64 本机通过；控制台的隐藏与显示只有手工走查；没有用真实 Agent 验证它的选择器；Windows 未验证 |
| 对照 Magpie | 部分：对 Agent 隐藏模型为相同（另外拒绝调用被隐藏的模型）；按家族、provider 或组决定显示哪些模型为部分，没有家族标签，控制台只能编辑隐藏列表（[Agents and wiring](../../magpie-parity.md#agents-and-wiring)） |
| 权威文档 | [每个 Agent 的模型列表](../../global-wiring.md#每个-agent-的模型列表)、[守护进程与 Key](../../global-wiring.md#守护进程与-key)、[API 参考：set_agent_models](../../api/reference.md#hh_api_v1_set_agent_models)、[ADR 0022](../../decisions/0022-agent-wiring-semantics.md) |

## 用途

决定每个 Agent 的模型选择器里出现哪些网关模型，并且让 Agent 的 Key 只能调用这些模型。默认显示网关的全部模型（包括之后新增的），用户可以缩小范围或逐个隐藏，不必重新接线。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Agent 详情（`/?agent=<id>`）的“显示 N / M 个模型”：逐个隐藏或显示，正在使用的模型不能隐藏；首页与详情的模型选择器标出对该 Agent 隐藏的模型 |
| 命令行 | `hh agents models <agent>` 列出显示与隐藏的模型；`hh agents models <agent> --hide REF --show REF`（可重复）；`hh wire <agent> --models REF[,REF]` 设置白名单；`hh tui` 的选择器标出隐藏的模型 |
| HTTP | `PUT /api/v1/agents/{id}/models`（`{hidden}`）；`GET /api/v1/agents/{id}` 的 `wiring.models` 与 `wiring.hidden`；接线请求的 `models` |

## 已实现的能力

- 两张名单都放在 Agent 的 Key 上：`modelAllow` 是白名单（默认 `*`，包括之后新增的模型），`modelDeny` 是隐藏列表；条目可以是 `provider/model`、`provider/*`、`group/<id>` 或 `*`。
- 白名单：`hh wire --models` 给出 Agent 可列出的模型，缺省沿用当前列表，首次接线为 `*`；白名单不含 `*` 时自动加上所选模型与各档模型。
- 一致的过滤：网关对该 Key 的 `/v1/models` 与调用、写进 Agent 文件的模型清单（OpenCode、Pi、Crush、Kimi 的模型条目，Codex 的模型目录，Claude Code 的 `CLAUDE_CODE_MODEL_CAPABILITIES` 等）都用同一个 `modelAllowed(allow, ref, deny)` 过滤网关的模型；调用被隐藏的模型得到 403。
- 隐藏不换 Key：`PUT …/models` 把 `modelDeny` 改为 `hidden`，守护进程从 Agent 文件中读回这把 Key（`wiredKeyText`），以过滤后的列表经 `applyWiring` 重写文件（备份、原子写、回读校验同接线）；重写失败时 `modelDeny` 改回原值。这是“每次接线签发新 Key”之外唯一不换 Key 的写入，正在运行的 Agent 不会因此 401。
- 拒绝：隐藏 Agent 正在用的模型或档位模型为 409 `AGENT_MODEL_IN_USE`，接线时选择被隐藏的模型同样被拒绝；Agent 文件中已没有它的 Key 为 409 `AGENT_KEY_NOT_IN_FILES`（需要 `--rotate`）；没有 Key 的旧记录为 `AGENT_KEYLESS`，Key 已吊销为 `AGENT_KEY_INACTIVE`，名单无效为 400 `AGENT_MODELS_INVALID`。
- 沿用：重新接线、换 Key 与目录同步都沿用当前的隐藏列表；网关新增模型后该 Key 立即列出它，Agent 文件中的清单由[目录同步](catalog-sync.md)更新。
- 绕不过去：第二轮安全审查（F 组）修复了 Agent Key 隐藏的模型可经自动路由组或裸模型名使用的问题。
- 范围：隐藏列表与 Key 不属于 Profile；备份恢复时随 Agent 的接线选择带回。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码（名单判断） | [core/model-plane.ts](../../../packages/core/src/model-plane.ts)（`modelAllowed`） |
| 源码（服务与接口） | [agents-wiring.ts](../../../packages/daemon/src/agents-wiring.ts)（`setHidden`）、[agents-routes.ts](../../../packages/daemon/src/http/agents-routes.ts)、[operations.ts](../../../packages/agents/src/wiring/operations.ts)（`wiredKeyText`） |
| 源码（入口） | [cli/agents.ts](../../../packages/cli/src/agents.ts)、[agent-detail.tsx](../../../packages/console/components/agent-detail.tsx)、[tui/app.ts](../../../packages/cli/src/tui/app.ts) |
| 测试 | [agents-wiring-semantics.test.ts](../../../tests/integration/agents-wiring-semantics.test.ts)、[wiring-semantics.test.ts](../../../packages/agents/test/wiring-semantics.test.ts)、[backup-restore.test.ts](../../../tests/integration/backup-restore.test.ts)（恢复带回隐藏列表） |
| 决策 | [ADR 0022 Agent 的模型列表、无 Key 接线与接线 Profile](../../decisions/0022-agent-wiring-semantics.md) |

## 已知限制与未验证

- 没有 Magpie 的按模型家族（标签）显示；白名单只能用 Ref、provider 通配与路由组表达。
- 控制台只编辑隐藏列表，白名单（`--models`）只能在命令行中设置；`hh tui` 只在选择器中标出隐藏的模型，不能隐藏或显示。
- 用户换掉了 Agent 文件中的 Key 时不能隐藏模型，必须先换 Key。
- 没有用真实 Agent 确认它的模型选择器按改写后的清单显示；Windows 未验证。

## 优化候选

- **现状**：显示范围只能按 Ref、provider 与组表达。**方向**：在模型元数据中加入家族标签，`--models` 接受家族条目。**依据**：对照表 “Models shown to an agent, by family, provider or group”（partial）。
- **现状**：控制台只有隐藏列表，看不到也改不了白名单。**方向**：在 Agent 详情中显示并编辑白名单（provider 通配与路由组），写入仍经预览确认。**依据**：同一行的说明 “the console edits only the hidden list”。
- **现状**：`hh tui` 只能看到哪些模型被隐藏。**方向**：在选择器中加一个键切换当前模型的隐藏状态，走 `PUT /api/v1/agents/{id}/models`。**依据**：阅读 [tui/app.ts](../../../packages/cli/src/tui/app.ts) 的观察（只读取 `wiring.hidden` 作标注）。
