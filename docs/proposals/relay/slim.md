# 接力瘦身后的样子（2026-11-11）

一页目标，给并行做减法的几条工作流对齐用。依据：[决定记录](../../decisions/LOG.md)、[同类产品调研](../../research/similar-products-2026-11-11.md)、[真机走查](../../verification/relay-real-walk-2026-11-11.md)。v13 没有部署到任何真实数据，持久格式可以直接改，不写迁移。

## 用户看到的

- 换 Harness 发第一条消息：自动附上它没看过的对话。回到原来那家：续它的原生会话，只补它离开期间的部分。只用一家：什么都不附。
- 第一次向某个 Harness 交接：输入框上方一行说明，不用点。之后不再出现。
- 交接单发出后没确认收到：下一条自动再附一次，并在交接单开头写明“这部分可能与你已有的内容重复”。还不确认：之后只发原话，直到又有新内容要交。全程不问用户，不拦消息。
- 清空：在任何 Harness 上输入清空命令，都是“Hub 给它开一个新的原生会话”。之后的消息不附清空前的内容；下一条消息上方给一个［附上交接单］。
- 每条消息可以选［只发这条消息］。
- 设置只有一项：换 Harness 时附上之前的对话（默认开）。

## 底线（不变）

不丢用户的内容；不谎报（没确认的不显示成已接手）；不隐式改换 Harness、模型或配置；不自动重跑结果未知的执行。

## 每个绑定记什么

`epoch`（第几个原生会话）、`mark`（它看到了哪里，按事实的追加序号）、`pending`（发出还没确认的那份包，和已自动补发的次数 0 或 1）、`resendAll`（下次整份重发，见下）。没有别的状态。

- 送达证据只有两种：**实时确认**（Driver 发 `input_recorded`，或声明 `agent_output` 的 Driver 出现第一条输出）和**按结果推断**（回合正常结束，且该 Driver 声明正常结束即已收到）。有证据就把 `mark` 推到包的末尾、清掉 `pending`。
- 没有证据：留 `pending`。下一条内容消息自动补发一次（计数 1）；再没有证据就只发原话；有新事实要交时再发一份包含全部欠交的新包（计数归零）。确知没发出（派发前失败、Driver 在读取前拒绝）：撤回 `pending`，不算一次。
- **不再事后读对方的历史核对**。
- 清空命令：`epoch + 1`，`mark` 取当下，`pending` 清掉。新绑定从空的原生会话开始。
- 效果是“回退”或“未知”的原生命令执行之后：置 `resendAll`。下次要交接时发整份（从本纪元开始的全部），并带“可能重复”的说明；发出后清掉标记。没有新内容要交时什么都不做。
- 压缩命令：不动任何状态。
- 结果未知的回合（进程崩了）：进程型 Driver 在 Hub 确认进程组已结束后可以继续原会话（Claude Code、Codex、OpenCode 真机证实不会自己重跑）；绑定置 `resendAll`。其余照旧要求用户新开原生会话。
- 用户选［附上交接单］（清空后）：这一条发整份，忽略清空的边界，一次有效。

## 砍掉的

- 事后核对：`planReturnVerify`、`verifyDelivered`、`deliveryPosition`、`relay.verified`、E2、位置记录。
- 待核状态：`suspect` 及其全部原因、`floorCandidate`、`rewound`、`carried`、“清空待确认”、〔确认已清空〕、`epochFloor` 与 `nativeEpoch` 的并存（收成 `epoch` 加清空边界）。
- 严格模式与门：`relay.whenUnsure`、`relay.crossVendor` 的三档、`relay.allowUnprobed`、`relay.dataRootInWorkspace`、`relay.localModelsOffline`、`relay.returnPreference`；`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED`、`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE`、`RELAY_INPUT_LIMIT`（受理与派发前都不再因接力拒绝或失败；只关乎交接单的失败一律原样发出并记下原因）。
- 探针门控与 `probed`；数据根检查与横幅。
- 厂商识别：按配置文件解析端点（`relay-vendor.ts` 的端点层）、`VendorObservation`、`vendor_changed`、`relayVendor()`。接力里“交给谁”就是 Harness 的名字。
- 同意机制：三档、作用域、撤回、`goal_only`、`relay.withheld`。只留：第一次向某个 Harness 交接时写一行安装级日志（`relay_log`），界面据此显示那一行说明。
- 返回决策里的费用与时延估算（`return-policy.ts` 的估算部分）、`relay_windows` 的假设窗口表之外的统计。保留：窗口上限、放不下就压缩、再放不下只发原话。
- 声明里没人读的格：`probed`、`fixedPrefix`、`hostPathRead`、`sessionTools`、`cacheTtl`、`compactionEvidence`、`resolveVendor`、`title` 以外的装饰项——以代码里还有没有读者为准。
- 交接单：5 档收成 2 档（完整、精简）；去掉判断性的节（“状态与风险”这类），只留事实：用户原话、谁做了什么、改了哪些文件、失败的命令与输出、省略了什么。

## 留着的

记住看到哪里并只补增量；回原会话续接；永不因历史太长卡死；省略有账；送达不明不丢原生会话；分隔线只在有证据后写“接手”；交接单原文可查看；取消与失败的回合照旧进交接；命令回合不带交接单；水位按追加序号；Codex 因交接新开的会话设原生标题；已知密钥的精确替换与常见形状的脱敏；安装级密钥（送达行的指纹）。

## 分工

| 工作流 | 分支 / worktree | 改哪些 | 不碰 |
|---|---|---|---|
| A 核心 | `claude/relay-stage2-7cb3e9`（集成 worktree） | `src/contexts/session/**`（`domain/relay/packet.ts`、`narration.ts`、`escape.ts`、`redaction.ts` 除外）、`src/infrastructure/session/**`、`src/contracts/relay.ts`、`session.ts`、`src/cli/session-application.ts`，以及对应测试 | `src/adapters/**`、`src/contracts/control.ts`、`src/web/**`、`web/**`、交接单渲染 |
| B Driver | `cc/slim-drivers` · `.claude/worktrees/slim-drivers` | `src/adapters/control/**` 与对应的协议测试、夹具 | 契约文件（合并时由主负责人清理不再有实现的成员）、运行时 |
| C 交接单 | `cc/slim-packet` · `.claude/worktrees/slim-packet` | `src/contexts/session/domain/relay/{packet,narration,escape,redaction,budget}.ts` 与对应测试、夹具 | 状态机、运行时、Driver |
| D 界面与 API | A 合并之后在集成 worktree 上做 | `src/web/**`、`web/**` | — |

合并只由主负责人做。每条工作流：自己的测试通过、`pnpm exec tsc --noEmit -p .` 无错、在自己的分支上本地提交。合并后重跑 `pnpm check`、`pnpm test`、`pnpm test:web`，再用真实的 Claude Code 与 Codex 走一遍 9 步，然后对“持久格式与会不会丢内容”做一轮独立审查。
