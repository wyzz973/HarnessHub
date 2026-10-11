# ADR-031：接入 Hermes Agent 与 DeepSeek Harness

状态：accepted，2026-10-11。发现方式、目录读取副作用与验收边界由用户授权的审批代理（Fable 5.1）决定。依据 [ADR-020](0020-complete-native-harness-capabilities.md)。

## 背景

- 用户本机装有 Hermes Agent（NousResearch/hermes-agent 0.12.0，官方安装方式：`~/.hermes/hermes-agent` 加启动器 `~/.local/bin/hermes`）与 DeepSeek Harness（deepseek-ai/deepseek-harness，CLI `dsh`，本机为源码构建 0.2.1-alpha.1）。用户要求先把两者接入并适配，目标是“体验上是真的使用不同的 harness 一样”。
- 用户同时要求：Harness 的探测发现要与市面上同类产品方向一致，不能为本机的源码安装写专用逻辑。

## 决定

1. **两者都经各自内置的 ACP 服务接入**：Hermes 用 `hermes acp`，dsh 用 `dsh --profile acp`。ACP 是两者面向编辑器和自动化的官方接口。dsh 另有 SDK 协议（`dsh --profile sdk`，事件更丰富），但没有取消和审批，不适合交互式对话。dsh 的 ACP 是“仅面向自动化”的子集：没有命令、模式、计划、提问和逐字增量，矩阵如实标为原接口不提供。
2. **Hermes 与 ACP v1 的差异在 `HermesControl` 中处理，不由通用层吸收**：
   - 恢复只用 `session/load`。Hermes 的 `session/resume` 遇到未知标识会静默新建会话，而响应里没有会话标识，客户端无法察觉，这违反“恢复失败不新建空会话”。
   - 文件改为在提示词中附上只读副本路径（与 Codex、Pi 相同），因为 Hermes 不会把 `resource_link` 和嵌入资源交给模型。
   - 已审查的 0.12 版本中，Hermes 的审批在 ACP 模式下最多等待 60 秒，之后自行拒绝。公共请求提前 2 秒关闭并说明原因，避免出现“界面上批准了、Hermes 实际已拒绝”的情况。只对 0.12.x 生效：上游新版本把期限改为可配置（默认 300 秒），不能被 Hub 提前关闭。
   - Hermes 的最后一段回复可能在 prompt 响应之后才到（Multica 也为此等待 250 毫秒）。回合在响应后再静默 250 毫秒（最长 2 秒）才结束，迟到的回复仍归这一回合。
   - 模型请求失败时，Hermes 仍以 end_turn 结束，回复为空（或只有它自己的 “Error: …”），失败只写在 stderr。回合完成却没有回答、并且本回合的日志带终态失败标记时，判为失败并按日志归类，不发布日志原文。
   - `/model <名称>` 不发 ACP 更新，只回固定文本。只有提示词本身是这条命令时，驱动才读取回复，把新模型记为当前模型（遵循 ADR-028：下一回合沿用，不改回所选）。
3. **两项通用 ACP 修正**（对所有 ACP Harness 生效）：
   - `session/load` 之后的回放等待窗口从响应时刻开始计算。Gemini 与 Hermes 都在响应之后才回放历史；原来从请求时刻计时，加载较慢时会跳过等待，回放可能混入下一回合。代价是每次 load 恢复至少多等 150 毫秒。
   - `session/load` 返回 `null` 视为会话不存在（`NATIVE_SESSION_NOT_FOUND`），不当成协议错误，也不新建会话。
   - 会话已在使用所选模型或选项值时，不再重复发送设置请求。Hermes 0.12 的 `set_model` 在模型未变时可能把请求误路由到其他提供方（hermes-agent#59089）；对其他 ACP Harness 也只是少了冗余请求。
4. **目录条目**：两者作为经审查的原生条目加入（固定上游修订），目录由 43 个产品、47 个控制入口变为 45 个和 49 个。两者都不提供安装配方，Hub 不会安装它们。

## 发现方式（审批代理决定）

- 只有一个方向：在 PATH 与标准安装目录中按官方命令名查找，非标准安装通过显式自定义入口接入，与 Multica、AionUi、Zed 等同类产品一致。不扫描用户项目目录，也不把 npm 的 npx 缓存当作安装（缓存可能被清理，版本也不确定）；有反例测试保证缓存里的副本不会被发现。
- dsh 的 `package` 身份保留，用于观察 npm 全局安装的 `dsh` 入口的身份与版本。用户本机的源码构建只作为发现清单中的自定义入口，用于本机真实验收，矩阵中已注明。
- Harness 页对自定义入口显示“自定义入口（发现清单）”；入口路径不进入浏览器状态（沿用“浏览器状态不含私有命令”的既有约束，审批代理原要求显示路径，经说明后按此执行），以服务启动时的发现清单为准；自定义入口不可用时说明原因；未发现时显示产品官方安装方式（目前只列 Hermes 与 dsh 这两条已核实的命令），Hub 不运行它。清单的编辑界面放到下一阶段。

## 读取模型目录的副作用（审批代理决定）

接受，但附条件：目录缓存改为“配置指纹不变就复用”，最长 24 小时，跨 Hub 重启保留，保留“刷新本机模型”；Hub 有界记录目录探测创建的原生会话标识，“本机会话”列表默认隐藏它们，可展开查看；不改为首条消息时才读取（选择器需要目录）。dsh 读完目录后可调用 `session/close`，但它不删除持久状态。已按 [ADR-033](0033-native-catalog-cache-and-readiness.md) 实施。

## 验收边界（审批代理决定）

- Hermes：只用文件与终端类工具在隔离工作区做无害任务，不触发浏览器、`process`、记忆、`skill_manage` 与网页搜索；`delegate_task` 只在子 Agent 验收中用一次。工作区放在 `$HOME` 下的非系统路径（Hermes 拒绝写 `/private/etc`、`/private/var`）。审批中禁止选“始终允许”。只运行 `hermes acp`，不触碰用户的 Hermes 网关。
- dsh：沿用用户自己的权限预设，Hub 不改 `~/.dsh`；预设为 danger-full-access 时审批一行标为受阻。
- 花费：每个 Harness 每轮完整验收不超过 ¥10，本阶段两者合计不超过 ¥50；单回合超过 150k token 或 5 分钟即停止并报告；不为了凑通过而重跑。

## 工具失败与没有发出的审批（2026-10-12，审批代理决定）

- Hermes 0.12 的 `build_tool_complete`（`acp_adapter/tools.py`）对每个结束的调用都报告 `completed`，失败只写在文本里：各格式化函数输出“<工具> failed: <错误>”，被拒绝的命令的错误是“BLOCKED: …”（`tools/approval.py`）。HermesControl 把文本符合这两种形式的调用标为失败，只对 Hermes 生效。
- 本机 0.12.0 中 `approval.py` 以 `allow_permanent` 调用审批回调，而 `permissions.py` 的回调不接受这个参数，异常后一律按拒绝处理，审批请求从不发出（上游 v0.21.6 的回调已接受它）。一次回合中没有收到任何 `session/request_permission`、却出现了 Hermes 的拒绝文本（“BLOCKED: User denied”或“Command denied: ”）时，只对 0.12.x 加一条提示：Hermes 拒绝了这条命令，但没有向 HarnessHub 请求审批，并说明这个缺陷；HarnessHub 没有修改 Hermes，回复内容可能与实际结果不符。每个回合最多一次，对话中相同的提示只显示一次。

## 影响

- 新增 `src/adapters/control/hermes.ts`；`acp.ts` 增加三个由子类覆盖的扩展点（`restoreByLoad`、`approvalDeadlineMs`、`fileBlocks`）和 `adoptModel`。
- 能力矩阵增加两列：27 项 × 9 个 Harness。
- 验收记录：[接入 Hermes Agent 与 DeepSeek Harness](../verification/hermes-dsh-onboarding-2026-10-11.md)。参考调研：[第一链路调研](../research/first-chain-products-2026-10-11.md)。
