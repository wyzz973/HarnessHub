# ADR-034：Codex 计划模式（实验接口按回合声明）

状态：accepted，2026-10-12。依据用户授权的审批代理（Fable 5.1）的决定：Codex 的 `experimentalApi` 只在选择了计划模式的回合的 initialize 中声明，要求 0.162.1 及以上，未知通知只记诊断。

## 背景

- Codex 的计划模式（collaboration mode）是 app-server 的实验接口。连接在 `initialize.capabilities.experimentalApi` 中声明后，`turn/start` 才接受 `collaborationMode: {mode: "plan"|"default", settings: {model, reasoning_effort, developer_instructions}}`；它优先于本回合的模型、思考档位和开发者说明，`developer_instructions: null` 表示使用该模式内置的说明（上游 `rust-v0.162.1` 的实验导出）。
- 计划模式的方案以 `{type: "plan", text}` 条目返回，`item/plan/delta` 只是草稿，以完成的条目为准。Hub 原来丢弃这个条目，用户看不到方案。
- 协作模式会保存在线程设置里：用过计划模式之后，不显式发送 `default` 就会一直留在计划模式。
- 声明了实验接口的连接会收到额外的实验通知。

## 决定

1. **选项。** Codex 0.162.1 及以上（版本取自 initialize 返回的 userAgent，形如 `<客户端名>/0.162.1 (…)`）在模型目录中提供“协作模式”选项：默认、计划，当前值为默认。读不出版本或版本更低时不提供。
2. **按回合声明。** 回合所选的原生选项在建立连接时交给驱动（`ControlOptions.selectedOptions`）。只有明确选择了协作模式（计划或默认）的连接才声明 `experimentalApi`；选“跟随本机配置”时不声明，线程沿用自己保存的模式。审批代理原定“只在选择了计划模式的回合”声明；由于模式会保存在线程里，退出计划模式也必须显式发送 `default`，所以范围放宽为“明确选择了协作模式的回合”。目录读取从不声明。
3. **设置的来源。** 计划模式的 `settings` 依次取：对话所选的模型和思考档位；用户为该模式配置的预设（`collaborationMode/list` 返回的预设，例如 `plan_mode_reasoning_effort`）；本机配置的模型及其思考档位。`developer_instructions` 为 null。
4. **校验在发送前完成。** 选择了协作模式、但连接建立时没有声明实验接口，或版本不支持时，`open()` 在建立线程之前以 `NATIVE_OPTION_UNAVAILABLE` 拒绝。打开线程时只读取配置和模型列表来校验所选项，不再读取账号和技能（这两项会联网，真实环境中出现过 10 秒超时）。
5. **最后确认的模式（审批代理附加条件）。** 一个回合选择了协作模式且 Codex 接受后，驱动把这个模式作为线程的原生当前值回报（ADR-028 的 `nativeConfig`，只报这一项）。“跟随本机配置”的回合读不到线程的模式，回报为空（null），保留上一次确认的值，不再整体替换。这时如果线程仍为计划模式，输入框下方提示：“这个 Codex 线程仍为计划模式：跟随本机配置不会改回，在高级配置里把协作模式改为‘默认’即可退出。”
6. **方案显示。** 完成的 `plan` 条目作为回复文本显示；`item/plan/delta` 和 `thread/settings/updated` 归为已知的被动通知。其他未知通知只记诊断，不影响回合。选择计划模式时，输入框下方提示：Codex 先给出方案，要让它执行，需要把协作模式改为“默认”后再发送。

## 影响

- `ControlOptions` 增加可选的 `selectedOptions`，只用于在 initialize 前确定能力；`open()` 仍校验实际收到的选项。
- `nativeConfig()` 可以返回 null，表示本回合没有可回报的原生值，上一次的回报继续有效（其他驱动不受影响）。
- Codex 的 `ProtocolObservation.agentVersion` 由 null 改为 userAgent 中的版本。
- 实验接口没有稳定性保证。升级 Codex 后，应先在开发实例中核对计划模式，再部署。
- 同时修复了两个在本次真实验证中发现的问题：执行配置面板里的下拉列表被面板遮住（层级 60 低于面板的 62），以及 Hub 升级后仍复用旧构建读出的目录（见 ADR-033 的构建标识）。

## 不做

- 不提供“按计划执行”的一键操作；用户切换模式后自己发送下一条消息。
- 计划模式下不尝试流式显示方案草稿。
