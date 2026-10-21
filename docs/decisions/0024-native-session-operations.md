# ADR-024：原生会话操作——权限设置、压缩与导出

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)与[能力矩阵](../verification/native-capability-matrix.md)。用户要求按各 Harness 实际能力接出模式、命令、原生会话压缩与产物导出。

## 背景

- Codex 的审批策略与沙箱可以在 `thread/start`/`thread/resume` 上按线程覆盖，线程会回报实际生效的值。本机原配置为 `approval_policy=never`、`danger-full-access`，原程序从不请求审批，统一界面的审批流程在 Codex 上无法使用。
- Codex app-server 没有斜杠命令，压缩和导出分别是 `thread/compact/start` 与线程自己的 rollout 记录；Pi 的手动压缩与 HTML 导出是 RPC 命令 `compact`、`export_html`，不是提示词命令。Claude、OpenClaw 的 `/compact` 本来就是原生命令；OpenCode 的 ACP 命令目录里没有压缩命令。
- ACP 代理在 `session/new` 之后才公告命令。目录读取紧接着打开会话时可能先于公告完成，界面因此拿到空命令目录。
- 用户需要把一次对话带走：公开对话本身没有导出方式。

## 决定

1. **Codex 线程权限设置。** 审批策略（untrusted、on-request、never；仅当原配置仍在用时提供 on-failure）与沙箱（read-only、workspace-write、danger-full-access）作为原生选项出现在高级配置中，当前值取自 `config/read`；原配置未写明时不提供，不猜默认值。选择只覆盖 Hub 自己的线程，不写 config.toml；线程回报的值与请求不一致即失败（`NATIVE_OPTION_MISMATCH`）。计划模式需要 experimentalApi，未接出。
2. **审批说明。** Codex 文件修改审批的标题带文件名，详情带该项已报告的差异；命令审批带原因与目录，供用户判断。
3. **原生操作以命令名提供。** 原接口没有同名命令时，Hub 在命令目录中提供 `compact` 与 `export`：Codex `/compact` 调用 `thread/compact/start`，回合身份从通知绑定；`/export` 复制线程回报的 rollout JSONL 为本次 Run 的产物。Pi `/compact [说明]` 调用 RPC `compact` 并以活动显示前后 token；`/export` 让 Pi 把 HTML 写入私有临时目录后作为产物。原生拒绝（会话过小、没有可导出内容）如实失败，原因见活动或错误说明。已有同名扩展命令时按原样发送，不拦截。
4. **命令公告等待。** ACP 目录读取最多等待 1.5 秒的首次命令公告，公告到达即结束；从不公告的代理每个连接只等待一次。
5. **公开对话导出。** `GET /api/v1/sessions/:id/export?format=markdown|json` 需要登录，返回公开消息、Run 摘要（计划、工具标题、活动、产物与附件名称、用量、错误）；不含原生私有绑定、工具详情正文与存储字节。用户文本中的代码围栏不会截断引用。对话头部提供导出菜单。

## 影响

- Codex 会话可以选择更严格的审批与沙箱，在统一界面完成真实审批；原配置保持不变。
- 产物通道承载原生导出文件；这些文件随 Run 引用保留，回收规则同 ADR-022。
- 未做：会话分支与原生会话列表、子 Agent 会话与后台任务、OpenCode 压缩（ACP 未提供；2026-10-21 起 1.18.x 补入，见文末补充）、Codex 计划模式（后由 [ADR-034](0034-codex-plan-mode.md) 接出）。

## 否决方案

- 把 `/compact` 作为普通提示发给 Codex 或 Pi：原程序不会压缩，只会把它当成一句话。
- 为未写明的审批策略猜一个默认值：可能与原程序实际行为不符。
- 修改 config.toml 来切换审批策略：会改变用户全局配置。

## 验收

见[原生会话操作验收](../verification/native-session-actions-2026-10-11.md)。

## 2026-10-21 补充：OpenCode 1.18.x 的 /compact

[ADR-046](0046-harness-focus-hardening.md) 第 5 项。总指挥只读核对 OpenCode 1.18.35 的 ACP 模块：它接受不在命令目录里列出的 `compact`，转给 `session.summarize`。

- 版本满足 `>=1.18.0 <1.19.0`、而且 OpenCode 自己没有列出 `compact` 时，`OpenCodeControl` 在命令目录里补入 `/compact`。输入原样转发，与其他原生命令一样。
- 其他版本、读不出版本，以及 OpenCode 已经自己列出 `compact` 时，都不补。
- 协议层由 G032-NC24 覆盖（`tests/protocol/acp.test.ts`）。真实回合、压缩期间的流式内容和回合如何结束，等真实重验收。
- 能力矩阵中 OpenCode 的“上下文压缩”改为已接出、协议通过、真实未验证。
