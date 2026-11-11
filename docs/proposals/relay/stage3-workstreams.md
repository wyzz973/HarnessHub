# 接力第三阶段：并行工作流与接缝（2026-11-10）

> **2026-11-11 起已过时。** 接力做了大幅减法：现状以 [slim.md](slim.md) 与代码为准；本文描述的事后核对、待核状态、同意与厂商识别、探针门控、严格设置、多档交接单等机制大多已删除，只作历史参考。

状态：主负责人的分工文档，用户 2026-11-10 要求“启动并行的 agent 开发，模型 Sonnet 5.5（max），主负责人统筹、设计文档、分工”。它不改变 [ADR-055](../../decisions/0055-relay-and-context-scheduling.md) 的任何决定；设计正文仍是[终稿](relay-architecture.md)。

## 1. 目标

把接力从“代码有了、不能用”推到“用户能用、好用”：G072（谁能接力、带多少）、默认放行、界面与 API（G073）、真机探针（G074），同时开始 WorkBuddy 的只读研究。产品方向按用户 2026-11-10 的决定：默认放行、能自动决定的不问、拦截改提示；正确性底线不变（不丢事实、不谎报送达、核对不说谎、不隐式改换）。

## 2. 工作流、所有权与 worktree

基点都是集成分支 `claude/relay-stage2-7cb3e9` 的 `a6853e6`。每个写代码的工作流有自己的 worktree 与分支，只改自己名下的文件；别人的文件需要改动时写进报告，由主负责人在合并时处理。合并只由主负责人做。

| 工作流 | 模型 | worktree / 分支 | 只改这些文件 | 交付 |
|---|---|---|---|---|
| W1 G072 协调器（进行中） | Opus（已在跑） | 集成 worktree | `src/contexts/session/**`、`src/infrastructure/session/**`、`src/contracts/{relay,session,control}.ts`、`src/adapters/control/**`、`src/web/server.ts` 的状态码映射、G072 的测试 | 受理同步 409、门控、同意与厂商键、数据根、relay-keys、窗口与降档、返回决策、Codex 标题 |
| W2 界面（G073 前端） | Sonnet 5.5 max | `.claude/worktrees/relay-ui` · `cc/relay-ui` | `web/**`、`tools/check-ui-wording.mjs`、`tests/unit/check-ui-wording.test.ts`、`tests/browser/relay.browser.ts` | 交接卡、分隔线、首次说明、三选一、只发这条消息、详情栏“接续”、“我的 Agent”改“Harness”、用词检查 |
| W3 API（G073 后端） | Sonnet 5.5 max | `.claude/worktrees/relay-api` · `cc/relay-api` | `src/web/relay-routes.ts`（新）、`src/web/server.ts`（挂路由、请求体的 `relay`、扩展错误体；不动状态码映射那两行）、`src/contracts/web.ts`、`src/web/session-stream.ts`、`tests/integration/relay-api.test.ts`、`tests/security/relay-api.test.ts`、`docs/contracts/public-api.md` | 第 3 节的接口 |
| W4 真机探针（G074） | Sonnet 5.5 max | `.claude/worktrees/relay-probe` · `cc/relay-probe` | `tests/real/relay-conformance.real.ts`（新）、`tests/real/guard.ts`（只加不改）、`docs/verification/relay-conformance.md`（新）、`spikes/relay/**` | Driver 层探针脚本；在 Claude Code、Codex、OpenCode、DeepSeek Harness 上实际运行并记录；Hermes、OpenClaw 只写脚本不运行 |
| W5 默认放行的规则 | Fable（审批代理） | 只读 | 不改文件，交回规则表 | 第 7.2 节每一格在默认模式下“自动决定 / 提示 / 询问”的裁定，供 W1 之后的一批实现 |
| W6 WorkBuddy 只读研究 | Sonnet 5.5 max | 只读 | 不改文件，交回研究记录 | ADR-048 路线 B 的第一步：协议、家目录、会话存储、命令目录、接力声明的各格；不发任何提示 |

独立审查与审批仍由 Fable 子代理做（与实现者不同模型，读法不被实现锚定）。

## 3. W2 与 W3 之间的接缝（界面 ↔ API）

以终稿第 12.4 节为准，下面是本阶段做的最小集合与它**最终合并后的形状**（集成者 2026-11-10 按默认放行对齐；确切字段以 [public-api.md](../../contracts/public-api.md) 的“第三阶段已实现的 HTTP 形状”与 `src/contracts/web.ts`、`web/src/relay.ts` 为准）。分工时的原稿与最终形状的差异在每条末尾以“最终”标出。

**发送**：`POST /api/v1/sessions/:id/messages` 的请求体增加可选
`relay?: { attach?: "auto" | "full" | "none"; resend?: true; clearConfirmed?: true; native?: "continue" | "new"; tier?: Tier; note?: string; consent?: { vendor: string; decision: "acknowledged" | "goal_only"; scope: "session" | "global" } }`。不带 `relay` 即默认行为。最终：`attach`、`resend`、`clearConfirmed`、`tier`、`native`、`consent` 全部交给 `runtime.send` 的第五个参数（G072 接受了它们，`native:"new"` 即［新开原生会话］，不再经 `native-branch`）；`note` 只校验、不使用（交接单还不收附言）。

**错误体**：`{ code, message, relay?: { binding: { harnessId, controlId }, cause?, options, counts?: { runs, packets }, vendor? } }`，`options` 取 `attach_full | send_alone | new_native | clear_confirmed | acknowledge`。状态码不变：`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED`、`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE` 为 409，`RELAY_INPUT_LIMIT` 为 429。最终：**默认放行下受理不再返回这些码**，它们只在严格设置（`relay.whenUnsure=ask`、`relay.crossVendor=ask`、`relay.allowUnprobed=false`、`relay.dataRootInWorkspace=block`）或显式选择无法满足时出现；界面两种都处理：默认下读 `attention` 画提示条，严格设置下出现 409 时在输入框上方给说明和按钮、草稿保留。

**只读**：
- `GET /api/v1/sessions/:id/relay` → `{ bindings, packets, dataRootExposed?, installation? }`。每个绑定 `{ harnessId, controlId, nativeEpoch, sync, throughRun, evidence, cleared, probed }`，最终另有可选的 `canConfirm`（这个 Harness 能否确认送达）、`vendor`（固定词的模型服务名）、`owed { runs, estTokens }`（现在向它交接会带什么，分支引用的父会话历史也算入）、`vendorChange { from, to, runIndex }`（最近一次换了模型服务，页面在那个 Turn 的消息下写明；独立审查后加）与 `attention { cause, options, counts, key, packet?, vendor? }`（运行时请用户看一眼的事，**按这一刻的状态现算**，不从最近一个 Run 的决定推；从不拦路；同一 `key` 只提示一次）。`installation`（独立审查后加）是安装整体做不到的事（现有 `key_unavailable`：接力密钥文件不能用），常驻、写明原因与怎么修。`packets` 每项 `{ packetId, runId, runIndex, number, kind, tier, target, estTokens, omissions, redactions, delivery, evidence }`，`number` 是会话内序号（“交接单 #n”）。`dataRootExposed` 是数据目录在工作区可及范围内的警告。
- `GET /api/v1/sessions/:id/relay/:packetId` → 存储的正文，`text/plain; charset=utf-8`，`ETag` 为正文的 sha256；别的会话的 packetId 与不存在的一律 404 `RELAY_PACKET_NOT_FOUND`（页面不会把它当成“网关没有接力 API”：那只认 `GET …/relay` 的 404 加 `NOT_FOUND`）。
- `GET /api/v1/relay/prefs`、`PUT /api/v1/relay/prefs`（`{ key, value }`，键与取值取 `RELAY_PREF_KEYS`、`RELAY_PREF_VALUES`）。最终：`GET` 一律列出六个键（`relay.crossVendor` 默认 `allow`、`relay.whenUnsure` 默认 `auto`、`relay.returnPreference` 默认 `continue`、`relay.allowUnprobed` 默认 `true`、`relay.dataRootInWorkspace` 默认 `warn`、`relay.localModelsOffline` 默认 `false`），没设过的给默认。
- 最终：`GET /api/v1/state` 的应答带可选的 `relay: true`，页面据此只向有接力的网关读接力。

**流**：SSE 增加帧 `{ type: "relay", sessionId, version, lastSeq, event: { type: "relay.input_recorded" | "relay.verified" | "relay.vendor_changed" | "relay.clear_confirmed", sessionId, runId?, packetId?, at } }`，不含正文、原值与原值的哈希；跟在承载事实的帧之后、同一水位。最终：它是 `SessionStreamFrame` 的成员，页面的解码先读 `event`，reducer 把它当同水位的空操作。`run` 帧与快照里的 Run 带 `relay?: { packetId, kind, continuity, executedOn, delivery?: { state, evidence }, decision?: { kind, by, cause?, reason?, resend? } }`（`resend`：`auto`｜`grown`｜`user`，补发的是哪一种，独立审查后加）；最终：Web 的 Run 不带 `relayRequest`（它是用户选择的 HMAC，留在网关里）。

本阶段不做：预览估算（`relay/preview`）、`relay/observe`、钉住与排除、按位置放行、同意记录的列表与撤回页、费用显示。设置页露出两个开关：`relay.crossVendor`（允许（默认）／每次询问／只交目标）与 `relay.whenUnsure`（自动处理（默认）／每次问我）。

## 4. 界面的最小集合（W2）

按终稿第 12.1 节的文案，统一称 Harness，默认一行、不抢焦点：
1. **分隔线**（T5）：派发时占位“交给 X · 交接单 #n · 送达中”；有证据后“从这里起由 X 接手 · …　[查看交接单]”；未知与未送达各自的文案。证据到达之前不出现“已接手”。
2. **附件条**（T3）：带包的用户消息下显示“附交接单 #n”，点开是逐字原文（`GET …/relay/:packetId`）。
3. **输入框上方的一行**（T2 的精简版）：有东西要交时“将交给 X：N 轮 · 约 k tokens　[查看] [只发这条消息]”；首次跨厂商时多一句不拦路的说明；409 出现时换成说明加按钮。
4. **清空之后**（T7）：“X 的上下文已清空 · 下一条不附历史 [附上交接单]”（只在清空后的下一条内容消息提供）。
5. **详情栏“接续”**：每个 Harness 一行同步状态，交接单列表。
6. **设置页**：跨厂商交接“允许（默认）/ 每次询问”。
7. “我的 Agent”等 11 处改为“Harness”；`tools/check-ui-wording.mjs` 检查全部界面字符串与无障碍名（例外清单：`Hermes Agent`、`Claude Agent`、`子 Agent`），附一个无效样例证明能拒绝。

设计语言沿用 2.0（ADR-054）：系统字体、中性色、蓝色强调、不用绿色；W2 用仓库已有的组件与样式变量，不引新依赖。

## 5. 合并顺序与验收

1. W1（G072）回报 → 主负责人重跑全量 → 独立审查与审批裁定 → 修正 → 提交。
2. W5 的规则表 → 在集成 worktree 上实现“默认放行”（一批，Sonnet 5.5 max）→ 审查 → 提交。
3. 合并 W3（API）→ 合并 W2（界面）→ 对齐第 3 节的类型 → 浏览器里走一遍 A→B→A（合成 Harness）。
4. 合并 W4（探针脚本与记录）→ 按证据翻转 `probed`（默认放行之后它只影响交接卡上的“未经真机验证”标注）。
5. 每次合并后：`pnpm check` 与全量 `pnpm test` 串行通过；ADR、验证记录、`plan/` 同步。只在本地提交；推送等用户点头。

每个工作流的完成定义：自己的测试通过；`pnpm exec tsc --noEmit -p .` 无错；报告里分开写“代码完成 / 合成测试通过 / 真机通过”；没做完的直说。

## 6. 所有工作流共同遵守

不提交到别的分支、不推送、不用 `git stash`；不碰主检出 `/Users/sd3/Desktop/project/HarnessHub`、4317 上的服务、`/Users/sd3/Desktop/project/HarnessGateway/data`；不改、不整段打印真实 Harness 配置（可能含明文令牌），不输出凭据；不杀不是自己启动的进程；测试数据放临时目录、用完删；测试里形状完整的假密钥拆成字符串拼接；界面文字叫 Harness；不触发 OpenClaw、Hermes 的出站消息。
