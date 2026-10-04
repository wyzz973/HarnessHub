# ADR 0022：Agent 的模型列表、无 Key 接线与接线 Profile

Status: proposed

日期：2026-10-04
关联决定：[04 Agent 平面](../proposals/oss/04-agent-plane.md)（第 4、5 节）、[03 模型平面](../proposals/oss/03-model-plane.md)（第 2 节 Gateway Key）、[ADR 0018](0018-schema-migrations-and-managed-secrets.md)、[全局接线](../global-wiring.md)

## 问题

全局接线按 Magpie 对标后，有三处需要改变已有契约：

- 每个 Agent 的模型列表：Magpie 以白名单（`visible`）加黑名单（`hiddenModels`）保存，新上架的模型默认显示，网关的 `/v1/models` 与写进 Agent 文件的清单来自同一个过滤结果。原实现把 Agent 文件中的模型列表直接作为 Key 的 `modelAllow`，新模型默认不可用，也没有“隐藏”的概念。
- Codex 的 ChatGPT 登录：用户想保留 ChatGPT 订阅、只让 Codex 经网关转发。这种接线不需要也不应该签发 Gateway Key（Codex 自己认证），而 `WiringRecord.keyId` 与 `wirings.key_id` 都是必填。
- Profile：一次保存并切换所有已接线 Agent 的模型选择，需要记录每个 Agent 的档位、effort 与选项，而记录中只有 `model`。

## 决定

- Gateway Key 的 `modelAllow` 接受 `*`（所有模型，包括之后新增的），并新增可选的 `modelDeny`（同样的条目形式）。`modelAllowed(allow, target, deny?)` 要求白名单接纳且黑名单不接纳；网关检查 Key 的四处传入 `key.modelDeny`。新接线的 Agent Key 默认 `modelAllow: ["*"]`；隐藏模型即修改该 Key 的 `modelDeny`。Agent 文件中的清单与网关对该 Key 的列表都按这对名单过滤网关的模型。
- 隐藏模型不换 Key：`AgentWiringStore.setGatewayKeyModels` 原地改写名单，守护进程从 Agent 文件中读回它的 Key（`wiredKeyText`），以同一把 Key 重写清单。这是“每次接线签发新 Key”之外唯一不换 Key 的写入。
- `WiringRecord.keyId` 与 `model` 变为可选：Adapter 可声明在某组选项下自己登录（`keyless`），此时不签发 Key、不写模型。Codex 以选项 `codexAuth: gateway-key | chatgpt` 选择；`chatgpt` 只写 `openai_base_url = <网关>/backend-api/codex`。迁移 4 重建 `wirings`，`key_id` 改为可空。
- `WiringRecord` 记录 `tiers`、`effort` 与 `options`（`WiringChoice`）。Profile 是按名称保存的每个已接线 Agent 的 `WiringChoice`，存于迁移 4 新增的 `wiring_profiles` 表；不含隐藏名单与 Key。应用 Profile 对选择不同的 Agent 逐个走接线的同一路径（预览、确认、新 Key、备份、回读校验），先确认所有要改的 Agent 都有确认过的预览，遇到第一个失败即停止。

补充（2026-10-04，`feat/wiring-arrays`）：

- **数组元素归属**：键路径的最后一段可以是元素选择器（`{match}` 或 `{equals}`），HarnessHub 在用户自己的数组中只拥有它写入的元素，重新接线原地更新、还原只删除这些元素。备份清单格式升为版本 2，仍读取版本 1。Droid、WorkBuddy、ZCode、Claude Desktop 因此可以接线。
- **目录同步**：网关的 provider 或路由组改变后，守护进程把已接线 Agent 文件中的模型清单改写为该 Key 现在可见的模型，走正常的计划与写入路径并沿用文件中的 Key；自上次写入后被用户改过（漂移）等情况不改写，在 `GET /agents` 标为 `attention`。`wiring.autoSync: false` 关闭。
- **Claude 风格的模型别名**：Key 可带 `modelIdStyle: claude-alias`，网关对它以 `claude-hh-<数字>` 列出并接受模型，供只保留 Anthropic 风格 id 的客户端（Claude Desktop）。这是 Key 的属性而不是按 Agent 分支。

## 考虑过的替代方案

- **把隐藏列表存在守护进程的设置文件里，接线时把过滤后的列表写进 `modelAllow`**（原做法的延伸）：新模型要等重新接线才可用，与“默认显示”相反；名单也会与 Key 的实际权限分成两处。
- **每次隐藏都轮换 Key**：可以完全复用接线路径，但正在运行的 Agent 会立即 401，直到重启；隐藏一个模型不应打断正在进行的会话。
- **ChatGPT 模式签发一把不写入文件的 Key 以满足必填字段**：Key 没有使用方，吊销与轮换也无意义，等于在存储中留一条假的引用。
- **Profile 存为数据目录中的 JSON 文件**（Magpie 的 `profiles.json`）：模型平面存储已有迁移框架，`wirings` 也需要同一次迁移；放进同一个库可以在一个事务里校验并随备份走。
- **应用 Profile 时撤掉不在 Profile 中的 Agent 的接线**（Magpie 以空值表示“恢复 Agent 自己的默认”）：会在用户没有明确要求时改动其他 Agent 的文件；只切换 Profile 中的 Agent 更可预期。

- **数组整体替换**（把 Agent 的 `customModels` 等整个数组当作 HarnessHub 的条目）：还原时会丢掉用户在接线之后加入的元素，也会覆盖用户在接线前的元素顺序。
- **按调用方 Agent 在网关中改写模型 id**（Magpie 的 `gw/desktop.go` 按 User-Agent 识别 Desktop）：违反“网关不按引擎分支”；放在 Key 上的显式属性由接线设置，网关只看 Key。
- **目录变化时重写所有文件、不看漂移**：会覆盖用户在 Agent 中做的改动；跳过并标出，由用户决定重新接线。

## 后果

- `GatewayKeyRecord`、`WiringRecord` 是附加的可选字段；但读取方必须处理没有 `keyId` 与 `model` 的记录（守护进程的视图以 `keyState: none` 表示）。
- 网关新增模型后，Key 立即可用并出现在 `/v1/models`，但 Agent 文件中的清单要到下次接线或隐藏操作时才更新；需要时再实现 Magpie 的自动同步。
- Profile 应用不是跨 Agent 的事务：中途失败时之前的 Agent 已切换，错误信息列出它们，用户可再次应用。
- ChatGPT 模式依赖网关的 `/backend-api/codex` 透传路由。

## 验证要求

- 隐藏与显示模型后，Agent 文件中的清单、该 Key 的 `/v1/models` 与调用结果一致，Key 不变；新增模型默认出现在 `/v1/models`。
- ChatGPT 模式只写 `openai_base_url`，不签发 Key；从 API 模式切换过来时旧 Key 被吊销，还原回原文件。
- Profile 保存、切走、应用后各 Agent 的文件与保存时相同（Key 除外）；预览后有 Agent 改变时应用被拒绝且不写文件。
- 迁移 4 保留已有 `wirings` 行，之后可以写入没有 Key 的记录。

以上由 `tests/integration/agents-wiring-semantics.test.ts`、`tests/integration/store-migrations.test.ts` 与 `tests/integration/model-plane-store.test.ts` 覆盖；没有以真实 Codex 或 Claude Code 验证，也没有在 Windows 上运行。
