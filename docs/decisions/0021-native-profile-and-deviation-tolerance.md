# ADR-021：原生配置来源透传、原生协议偏差容忍与能力矩阵

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)与[七个原安装的能力面调研](../research/native-capability-surfaces-2026-10-11.md)。用户要求所有接入沿用本机原安装、配置与登录，不修改全局模型配置，并逐项补齐原生能力。

## 背景

只读调研发现若干现行实现与原程序真实行为不符：

- 原生模式会为子进程合成 `XDG_CONFIG_HOME`、`CODEX_HOME`、`OPENCODE_CONFIG_DIR`、`OPENCLAW_CONFIG_PATH` 等默认值。Cursor 依次解析 `CURSOR_CONFIG_DIR`、`$XDG_CONFIG_HOME/cursor`、`~/.cursor`，因此 Hub 启动的 Cursor 实际使用了 `~/.config/cursor`，没有加载用户 `~/.cursor/mcp.json`，并把 Hub 的模型选择写进了这个另立的目录。
- 原生代理在没有进行中 prompt 时发送内容、Codex 把子线程附着到同一连接、工具 id 重复宣告、多行工具标题、模型当前值不在其列表中、非文本消息块、load 响应后的回放，这些在当前实现里都会中断整个连接或让回合失败；超过 128 个工具甚至会让 Runtime 进入致命状态。
- Cursor 的 ACP 模型选择会写入其全局默认模型；Pi 的若干设置命令写全局 `settings.json`。
- Pi 适配器的编辑器字段名、对话框超时、扩展命令结算与 terminate 结束语义与 0.85.1 不符，档位读取依赖加载 Pi 内部 JS。

## 决定

1. **原生配置来源透传。** 原生模式只把用户环境中真实设置的配置位置变量传给子进程；未设置即保持未设置，由原程序按自己的规则解析，与用户终端一致。目录描述符不能借这些变量重定向原生配置。Hub 侧定位文件（缓存指纹、配置保护）仍可计算默认路径，但不导出。显式私有 profile（`--config-home`、测试夹具）保持完整隔离布局。
2. **原生偏差归一而不归属。** 安装版本中的正常协议行为被归一化处理，绝不归属到另一个公开 Run：无进行中 prompt 的内容只计数忽略，其权限请求以 cancelled 应答；Codex 外部线程通知忽略，属于当前线程子树的子 Agent 审批交给用户，其余一律 decline；同一 prompt 内重复或未宣告的工具 id 合并；工具标题中的控制字符替换为空格并截断；模型当前值不在列表时保留实际值；非文本消息块在产物通道实现前记录诊断；load 响应后的回放在 150 ms 无更新（最多 3 秒）后才开始新 prompt。真正的协议违规（格式、版本、身份冲突）仍然失败。
3. **预算面向长回合。** 原生入站单帧 16 MiB、单连接累计 256 MiB（`maxWireBytes` 可配置，测试用小预算证明仍会拒绝）；会话建立请求最长 60 秒且不超过运行预算；公开工具摘要超过 128 项时不再追加新工具，回合与 Runtime 不因此失败。
4. **不代为执行原生全局写。** 会改写用户全局默认值的原生设置不由 Hub 执行：Cursor 模型目录只读展示并说明原因，选择模型的回合在派发前明确失败；Pi 不发送写全局 settings 的命令。会话级设置（Cursor 模式、Pi 模型与思考档位、OpenClaw Hub 会话键上的 patch）照常使用。
5. **Pi 0.85.1 语义修正。** 编辑器使用 `prefill`/`{value}`；带 timeout 的对话框到期时撤回公开问题（Runtime 记录 `permission.closed`，迟到回答被拒绝）；由扩展命令或 input hook 处理而未启动运行的 prompt，按原生 `get_state.isStreaming` 两次探测后结算为 completed/handled；全部工具 terminate 的 toolUse 结束为 completed；思考档位来自 `get_available_thinking_levels` 与 Model 的 reasoning/thinkingLevelMap，不再把 Pi 内部模块加载进 Hub 进程。
6. **Codex 失败按类型分类。** 优先使用 `codexErrorInfo`，消息文本只作旧版本回退；新增额度、上下文窗口、连接与策略拒绝的公开错误代码。
7. **能力矩阵是机器校验的权威。** `plan/native-capabilities.json` 记录每个 Harness 的每项能力：原接口是否具备及来源、Hub 接出程度、协议测试、本机原安装真实验收及证据。设计检查拒绝缺项、无来源的原生结论、无协议测试的“已接出”、无证据的真实通过、无原因的受阻；只有四项全部满足才显示为完整。生成视图为 `docs/verification/native-capability-matrix.md`。

## 影响与迁移

- Hub 启动的 Cursor 改用用户原 `~/.cursor`（已核实原配置下登录有效，模型保持 Auto）。此前 Hub 在 `~/.config/cursor` 留下的配置未删除、不再使用；是否清理由用户决定。Cursor 首次以原配置运行时会写入它自己的缓存字段（authInfo、privacy、statsig），`selectedModel` 仍为 default、`hasChangedDefaultModel=false`。
- 既有公共对话中固定了 Cursor 模型的选择不再能派发，回合会以 `NATIVE_MODEL_SWITCH_GLOBAL` 明确失败，可改为跟随本机配置。
- 公共 Session 格式不变（仍为 v6）；Web DTO 命令目录上限与驱动一致为 2048。
- OpenClaw 桥把 Gateway 错误报告为 `end_turn`、不转发工具事件与审批的问题需要直连 Gateway WebSocket 才能根治，另行决策；矩阵中如实标注。

## 否决方案

- 继续合成 XDG 默认值：对遵循 XDG 规范的程序等价，但 Cursor 等程序的未设置回退不同，违背“沿用本机原配置”。
- 对偏差一律中断：会让真实原生回合因正常行为失败，且外部线程或迟到输出与当前 Run 无关。
- 用私有 `CURSOR_CONFIG_DIR` 隔离模型选择：会脱离用户原登录与配置，属于私有副本冒充。

## 验收

协议测试覆盖每项偏差的反例与 Pi/Codex/Cursor 修正；Runtime 测试覆盖问题撤回与工具预算，且已用变异核验确认测试能拒绝旧实现；设计检查覆盖矩阵规则的拒绝样例。真实原安装：OpenCode、OpenClaw、Codex、Pi 在新环境下跨 Hub owner 重启的原生恢复，七个入口的只读目录审计。见[本轮验收](../verification/native-capabilities-round2-2026-10-11.md)。
