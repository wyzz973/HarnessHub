# 原生活动与产物：工具详情、计划、用量、提示、活动与内容存储（2026-10-11）

依据[ADR-022](../decisions/0022-native-activity-and-content-store.md)。本轮把各原接口在回合中实际报告的工具详情、计划、用量、提示、活动与非文本产物接入统一聊天，详情和产物进入独立的内容存储。完整原生能力仍在进行中，逐项状态以[能力矩阵](native-capability-matrix.md)为准。

## 交付

- 控制契约新增 `tool.detail`、`plan`、`usage`、`notice`、`activity`、`output`；输入 16 KiB、输出与差异各 64 KiB 的详情预算。
- Session v7 与 v6→v7 迁移；PublicRun 增加工具种类/名称/父工具/退出码/详情引用、计划、用量、提示、活动与产物。
- 内容存储 `<data>/content`：内容寻址、魔数判型、owner 守卫、7 天未引用回收。
- Runtime：摘要即时提交，详情终态存储，结算后、关闭绑定前写完；存储失败留诊断；同一对话重复出现的相同提示只写日志。
- 驱动映射：ACP（工具 rawInput/rawOutput/diff/locations、Claude `_meta` 工具名与父工具、plan、usage_update 与回合 usage、notice、compaction、非文本块）、Codex（命令/补丁/MCP/搜索/图片/子 Agent 项、增量输出 300 ms 节流、计划、token 用量基线、警告与改路由、生成图片）、Pi（工具参数与流式结果、patch、逐消息用量与上下文窗口、压缩与自动重试、扩展通知与错误）。
- ACP 未宣告的客户端方法回 -32601 并在当前 Run 留审计诊断；Codex 结算前读完生成图片、送达节流中的输出；补丁头路径与 git 一致（去掉开头分隔符）。
- Web：`GET/HEAD /api/v1/content/:id`、SSE `run` 帧；统一聊天显示计划、提示、可展开工具详情（差异着色）、活动、产物与用量行。
- 真实验收脚本 `pnpm test:real:native-activity`（`HH_REAL_HARNESSES`、`HH_REAL_EVIDENCE`，可选 `HH_REAL_MODEL_<ID>`、`HH_REAL_APPROVAL=1`、`HH_REAL_PLAN=1`）。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 505 通过、0 失败、0 跳过；`.tmp/cc-batch2-tests.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch2-tools.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：356 个计划场景、189 个能力格、20 个完整格（上一轮 10）；它不运行这些场景；`.tmp/cc-batch2-design.log` |
| `pnpm web:build` | 通过；主包 500.06 kB，略超 Vite 的 500 kB 提示阈值（上一轮 483 kB），功能不受影响，后续按页面拆分；`.tmp/cc-batch2-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 5 通过、0 失败、0 跳过（新增原生活动界面测试）；`.tmp/cc-batch2-browser.log` |

新增或扩展的测试：内容存储三个集成测试；v6→v7 迁移；Runtime 原生活动（预算截断、结算前写入、日志只含引用、提示去重）；Web 内容路由；客户端与服务端 run 帧；ACP、Codex、Pi 原生活动协议测试；ACP 未宣告方法审计；浏览器原生活动界面。变异核验：去掉提示去重、去掉 Codex 结算前等待图片读取与送达节流输出后，对应测试失败；恢复后通过。

界面截图 `artifacts/chat-v3/native-activity.png`（被忽略的本地产物）已人工检查：计划、工具（输入、输出、位置）、着色差异和用量行“输入 1.2k · 输出 300 · 上下文 15%”。

## 本机原安装真实证据

使用与 4317 服务一致的环境（Homebrew 优先的 PATH、无代理变量），独立临时数据根与工作区，提示词要求在工作区内运行 `cat notes.txt`、用编辑工具把 bravo 改成 delta。判定以文件实际内容为准，不以回复为准。没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。

| 验收 | 结果 | 证据 |
|---|---|---|
| Pi（deepseek/deepseek-flash） | 完成；文件已改；bash、read、edit 工具详情已存储可读，edit 含 patch 差异；用量含输入、输出、缓存、推理、合计、上下文窗口 1,000,000 与本轮费用；原配置不变 | `.tmp/cc-native-activity-pi.json` |
| Codex（本机默认 gpt-6.1-sol） | 完成；文件已改；shell 命令（退出码 0、输出、cwd）与 apply_patch（差异）详情已存储；用量含本轮 token 与上下文 828,400；两条原生配置警告作为提示显示；原配置不变 | `.tmp/cc-native-activity-codex.json` |
| Codex 计划工具 | 未通过：要求先用 update_plan 列计划时，原程序回复当前没有可用的计划工具，未执行任务；本机默认模型回合不提供该工具，计划映射只有协议验证 | `.tmp/cc-native-activity-codex-plan.json` |
| OpenCode（本机默认 opencode/big-pickle） | 完成；文件已改；todowrite、命令、读取、编辑详情已存储，编辑含差异；用量含本轮 token、上下文 200,000 与会话累计费用；原配置不变 | `.tmp/cc-native-activity-opencode.json` |
| OpenCode 工作区级审批 | 临时工作区 `opencode.json` 要求命令与编辑先询问；两次审批均选“允许一次”；批准编辑后原程序调用未宣告的 `fs/write_text_file`，Hub 回 -32601 并留审计行，原程序仍自行完成编辑，回合完成、进程正常关闭；用户全局配置不变 | `.tmp/cc-native-activity-opencode-approval.json` |
| 七个入口只读目录审计（新的 ACP 客户端能力声明） | Claude、OpenCode、OpenClaw、Cursor、Codex、Pi 初始化与目录读取通过；Gemini 仍为 NATIVE_CLIENT_UNSUPPORTED。Cursor 运行时自行更新 `~/.cursor/cli-config.json` 的 `privacyCache.updatedAt`，模型字段仍为 default/Auto | `.tmp/cc-native-catalog-batch2.json` |

真实验收发现并修正的问题：事件分页上限（测试侧）；“允许一次”选项匹配误把 Allow 中的 all 当作“全部”（测试侧）；Codex 每轮重启会重复两条启动警告（Runtime 改为同一对话只显示一次）；绝对路径补丁头出现 `a//`（改为与 git 相同）。

## 未验证与受阻

- Claude（账号周额度用完）、Cursor（账号套餐限制）、Gemini（客户端被服务端停用）只有协议验证，真实受阻。
- OpenClaw 经 ACP 桥不转发工具、用量与审批事件；需要直连 Gateway WebSocket，另行决策。
- 真实图片产物、子 Agent 活动、上下文压缩活动、自动重试尚未在真实回合中出现；Codex 原配置 `approval_policy=never`，不会请求审批。
- 未做 Windows 验证。
- 4317 服务仍运行旧代码与 v6 数据，尚未部署本轮代码。
