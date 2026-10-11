# 原生能力补齐第二轮：能力矩阵、原生偏差容忍与配置来源（2026-10-11）

依据[ADR-021](../decisions/0021-native-profile-and-deviation-tolerance.md)。本轮先建立逐 Harness 能力与验收矩阵，再修复调研发现的会让真实原生回合失败或偏离本机原配置的问题。完整原生能力仍在进行中，矩阵中只有原接口、Hub 接出、协议测试与本机原安装真实验收全部满足的格子标为完整。

## 交付

- [七个原安装的能力面调研](../research/native-capability-surfaces-2026-10-11.md)：只读阅读安装版本的源码/schema，记录来源、版本、推断与局限。
- `plan/native-capabilities.json` 与生成视图[能力矩阵](native-capability-matrix.md)：7 个本机 Harness × 27 项能力，设计检查拒绝缺项、无来源原生结论、无协议测试的“已接出”、无证据的真实通过和无原因的受阻。
- 原生模式只透传用户真实设置的配置位置变量；目录描述符不能重定向原生配置。
- ACP：无进行中 prompt 的内容不归属、其权限请求以 cancelled 应答；重复/未宣告工具 id 合并；工具标题去控制字符；列表外模型值保留；非文本消息块记录诊断；load 响应后回放静默窗口；会话建立最长 60 秒；工具 4096、命令 2048 的连接内预算。
- Codex：外部线程（子 Agent、审查、内部 worker）通知不归属；子线程审批交给用户并标注“子 Agent”；无关线程审批 decline；失败按 `codexErrorInfo` 分类。
- Cursor：模型目录只读，选择模型的回合在派发前以 `NATIVE_MODEL_SWITCH_GLOBAL` 失败，从不发送全局模型写入。
- Pi：编辑器 `prefill`/`{value}`；对话框超时撤回问题；扩展命令/input hook 处理的 prompt 按原生状态结算；terminate 结束为 completed；思考档位来自原生 RPC 与 Model 字段。
- Runtime：原生撤回问题时关闭公开待决请求并记录 `permission.closed`；单回合超过 128 个工具不再失败或进入致命状态。
- 传输预算：原生入站单帧 16 MiB、单连接 256 MiB，测试可用 `maxWireBytes` 证明仍会拒绝洪泛。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后） | 通过 |
| `node --test dist/tests/*/*.test.js` | 494 通过、0 失败、0 跳过；`.tmp/cc-batch1-tests.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过（新增 12 个矩阵拒绝样例）；`.tmp/cc-batch1-tools.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：346 个计划场景、189 个能力格、10 个完整格；它不运行这些场景；`.tmp/cc-batch1-design.log` |
| `pnpm web:build` | 通过；`.tmp/cc-batch1-web-build.log` |
| `node --test dist/tests/browser/web.browser.js` | 4 通过、0 失败、0 跳过；`.tmp/cc-batch1-browser.log` |

新增协议反例：ACP 迟到输出/迟到权限、列表外模型、工具合并与多行标题、load 后回放、Cursor 只读模型；Codex 外部线程与子 Agent 审批、类型化失败；Pi 编辑器、超时撤回、扩展命令结算、迟到运行、terminate、档位来源。Runtime 新增问题撤回与工具预算两个集成测试，并做了变异核验：在构建产物中恢复旧逻辑后两测试无法通过（卡住等待），恢复后通过；随后为两测试加了超时，使变异直接失败而不是挂起。旧测试中编码了错误行为的断言已按原程序真实协议修正：Pi 夹具改用 `prefill`、`agent_start` 与 `isStreaming`，编辑器回答字段改为 `value`；Codex 不再要求外部线程输出使整轮报错；CLI 原生 profile 测试改为要求未设置的配置位置保持未设置。

## 本机原安装真实证据

真实验收使用与 4317 服务一致的环境（Homebrew 优先的 PATH、无代理变量），独立临时数据根与工作区；没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。

| 验收 | 结果 | 证据 |
|---|---|---|
| 七个入口只读目录审计（不发提示词） | Codex 7 模型/认证 ready；Claude 13 模型、223 条命令；OpenCode 11 模型、104 条命令；OpenClaw 4 模型、6 组设置；Pi 11 模型、70 条命令；Gemini `session/new` 返回 NATIVE_CLIENT_UNSUPPORTED；Cursor 首次以原 `~/.cursor` 冷启动 `session/new` 超过旧的 10 秒上限 | `.tmp/cc-native-catalog.json` |
| Cursor 原配置复测（会话建立上限调整后） | 44 模型、默认 Auto（`default[]`）、模型选择只读、模式 3 项、清理确认（exit 143 为原程序不响应 stdin EOF） | `.tmp/cc-native-catalog-cursor.json` |
| OpenCode 原生恢复 | 默认 opencode/big-pickle；第二轮在新的 Hub owner 下 `resumed=true`、`sourceRunIds=[]`、正确复述随机标记、回放未混入、exit 0、原配置不变 | `.tmp/cc-opencode-native-resume.json`、`.tmp/cc-native-resume-batch1.json` |
| OpenClaw 原生恢复 | deepseek/deepseek-chat；同上全部满足；原 ACP 进程 exit 1 如实保留、protocolFailure 为空 | `.tmp/cc-native-resume-batch1.json` |
| Codex 原生恢复 | gpt-6.1-sol；同上全部满足 | `.tmp/cc-native-resume-batch1.json` |
| Pi 原生恢复 | 用户默认 `harnesshub/deepseek/deepseek-flash` 指向未运行的 `127.0.0.1:3180`，第一轮如实失败为 NATIVE_CONNECTION_FAILED；改用原生目录中的 deepseek/deepseek-flash 后全部满足 | `.tmp/cc-native-resume-batch1.json`、`.tmp/cc-native-resume-batch1-pi.json` |
| 原模型配置保护 | Codex、Claude、OpenCode、OpenClaw、Pi、Gemini 的模型配置摘要前后一致。Cursor 的 `~/.cursor/cli-config.json` 在首次以原配置运行时被原程序写入自己的缓存字段（authInfo、privacy、statsig），`selectedModel` 仍为 default、`hasChangedDefaultModel=false` | 同上与 `.tmp/cc-native-catalog.json` |

只读核对：原配置下 `cursor-agent status` 显示已登录（凭据不在配置目录中，输出中的账号已在记录前遮蔽）。此前 Hub 合成 `XDG_CONFIG_HOME` 时 Cursor 使用的 `~/.config/cursor` 中留有 Hub 写入的 `selectedModel=composer-2.5` 与 `acp-config.json`；本轮没有删除这些文件，修复后 Hub 不再使用该目录，是否清理由用户决定。

## 未完成与限制

- 矩阵中“○ 原接口具备但未接出”的项仍为下一批工作：工具详细输入输出、计划、用量、附件输入与非文本输出、原生命令改配置后的同步、原生会话列表/分支/压缩/回退、子 Agent 与后台任务、导出。
- Claude 生成受账号周额度限制、Cursor 生成受套餐限制、Gemini 个人账号被停用：相关真实验收受阻，不计为通过。
- OpenClaw 桥把 Gateway 错误报告为 `end_turn`、不转发工具事件与 exec 审批，需直连 Gateway 另行决策。
- 后台任务与子 Agent 在每轮关闭控制进程后不会存活；需长期资源所有者设计后才能接出。
- 运行中的 4317 服务尚未更新到本轮代码；Windows 未验证。
