# Profile

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 集成：[agents-wiring-semantics.test.ts](../../../tests/integration/agents-wiring-semantics.test.ts) 经 `startHub` 与严格假上游：保存、切走、应用后文件与保存时相同（Key 除外），过期的预览被拒绝，真实 `hh profile list\|apply\|rm` 入口；[tui.test.ts](../../../tests/integration/tui.test.ts) 覆盖 `s` 保存、`p` 预览并应用、再次应用无需改动；macOS arm64 本机通过；控制台页面只有手工走查；没有用真实 Agent 验证；Windows 未验证 |
| 对照 Magpie | 部分：保存、应用、列出、删除，只应用不同的部分且遇错即停，随备份与同步走，均为相同；只快照已接线的 Agent、不能借 Profile 取消接线为部分；Profile 中的 Library 选择未覆盖（[Profiles](../../magpie-parity.md#profiles)） |
| 权威文档 | [全局接线：Profile](../../global-wiring.md#profile)、[终端界面](../../global-wiring.md#终端界面)、[API 参考：apply_profile](../../api/reference.md#hh_api_v1_apply_profile)、[ADR 0022](../../decisions/0022-agent-wiring-semantics.md) |

## 用途

把所有已接线 Agent 当前的模型选择存成一个有名字的 Profile，之后一次切换回去，例如“工作”与“个人”用不同的模型。切换前逐个 Agent 显示 diff，确认后才写入。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Profile 页（`/profiles`）：保存（同名时提示将替换）、应用（逐个 Agent 显示改动后确认）、删除（先确认） |
| 命令行 | `hh profile list`、`hh profile save <name>`、`hh profile show <name>`、`hh profile apply <name>`、`hh profile rm <name>`；`hh tui` 中 `s` 输入名称保存、`p` 列出并在回车后预览、确认应用 |
| HTTP | `GET /api/v1/profiles`、`GET`/`PUT`/`DELETE /api/v1/profiles/{name}`、`POST /api/v1/profiles/{name}/plan`、`POST /api/v1/profiles/{name}/apply` |

## 已实现的能力

- 保存：`PUT /api/v1/profiles/{name}` 把每个已接线 Agent 的模型、档位、effort 与选项（`WiringChoice`）存为该名称的 Profile，同名替换并保留 `createdAt`；不改 Agent 文件。
- 内容范围：隐藏的模型与 Key 不属于 Profile；保留 Codex 自己模型的 ChatGPT 模式记为没有模型，`hh profile show` 显示为 `(its own)`。
- 名称：1 到 64 个字母、数字、`.`、`_`、`-`，以字母或数字开头。
- 存储：模型平面存储的 `wiring_profiles` 表（迁移 4），随备份保存，并作为同步的 `profiles` 部分在多台机器间合并（同名替换，应用仍由用户执行）。
- 预览：`POST …/plan` 对选择与当前接线不同的 Agent 计算接线预览（临时 Key、不写文件），相同的 Agent 为 `changed: false`；全部相同时 `hh profile apply` 直接说明无需改动。
- 应用：`POST …/apply` 先确认每个不同的 Agent 都有确认过的预览，否则 409 `PROFILE_PLAN_STALE` 且什么都不写；再逐个经接线的同一路径切换（新 Key、备份、原子写、回读校验、吊销旧 Key），遇到第一个失败即停止，错误信息列出已切换的 Agent。
- 范围：不在 Profile 中的 Agent 不受影响；Profile 中当前未接线的 Agent 会被接线。
- 输出：应用后打印各 Agent 的结果（`applied`、`unchanged`）与切换过的 Agent 的重启提示；`--json` 输出结构化结果。
- 终端界面：`s` 与 `p` 走同样的接口；预览生成期间提前键入的 `y` 不会确认尚未显示的预览。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码（服务与接口） | [agents-wiring.ts](../../../packages/daemon/src/agents-wiring.ts)（`saveProfile`、`planProfile`、`applyProfile`）、[agents-routes.ts](../../../packages/daemon/src/http/agents-routes.ts)、[model-plane-store.ts](../../../packages/store/src/storage/model-plane-store.ts)、[migrations.ts](../../../packages/store/src/storage/migrations.ts) |
| 源码（入口） | [cli/agents.ts](../../../packages/cli/src/agents.ts)（`profileCommand`）、[tui/app.ts](../../../packages/cli/src/tui/app.ts)、[profiles-page.tsx](../../../packages/console/components/profiles-page.tsx) |
| 测试 | [agents-wiring-semantics.test.ts](../../../tests/integration/agents-wiring-semantics.test.ts)、[tui.test.ts](../../../tests/integration/tui.test.ts)、[backup-restore.test.ts](../../../tests/integration/backup-restore.test.ts)（恢复带回 Profile）、[sync.test.ts](../../../tests/integration/sync.test.ts)（Profile 作为同步的一部分，含删除） |
| 决策 | [ADR 0022 Agent 的模型列表、无 Key 接线与接线 Profile](../../decisions/0022-agent-wiring-semantics.md) |

## 已知限制与未验证

- 应用不是跨 Agent 的事务：中途失败时之前的 Agent 已经切换并换了 Key，用户需要再次应用；[04 第 7 节](../../proposals/oss/04-agent-plane.md#7-profile)设计的是失败时按备份恢复已切换的 Agent。
- 每个切换的 Agent 都得到新 Key，正在运行的 Agent 会话需要重启。
- 没有 Library 选择、`defaultGroup`、`hh profile diff`、导出与导入，执行平面的 Session 也不能指定 Profile（都在 04 第 7 节的设计中）。
- 不能用 Profile 取消某个 Agent 的接线；Magpie 以空字段表示“回到 Agent 自己的默认”。
- `hh profile save` 同名时直接替换、`hh profile rm` 不询问，而控制台两者都先提示；`hh tui` 中不能删除 Profile。
- 没有用真实 Agent 验证切换后的效果；Windows 未验证。

## 优化候选

- **现状**：应用中途失败时，前面的 Agent 留在新选择上。**方向**：按 04 的设计，失败时用各 Agent 的备份恢复已切换的 Agent 并吊销新 Key，使结果与切换前一致。**依据**：[04 第 7 节](../../proposals/oss/04-agent-plane.md#7-profile)；[ADR 0022 后果](../../decisions/0022-agent-wiring-semantics.md#后果)。
- **现状**：Profile 只含模型选择。**方向**：加入 Library 选择（指令集、Skills、MCP），应用时一并预览与同步。**依据**：对照表 “The Library setup in a profile”（not covered）；[04 第 7 节](../../proposals/oss/04-agent-plane.md#7-profile)。
- **现状**：没有比较两个 Profile 或导出分享的方式。**方向**：实现 `hh profile diff <a> <b>` 与不含秘密的导出、导入，导入时缺少的 provider 列为待补项。**依据**：[04 第 7 节](../../proposals/oss/04-agent-plane.md#7-profile)。
- **现状**：命令行保存同名 Profile 与删除 Profile 都不确认，控制台确认。**方向**：命令行与控制台一致，替换与删除先询问，`--yes` 跳过。**依据**：阅读 [cli/agents.ts](../../../packages/cli/src/agents.ts) `profileCommand` 与 [profiles-page.tsx](../../../packages/console/components/profiles-page.tsx) 的观察。
