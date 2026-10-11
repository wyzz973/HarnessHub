# Claude 真实验收补测与 ACP 审批详情（2026-10-11）

此前 Claude 账号周额度用完，矩阵中多项记为受阻。本日晚些时候在接续验收中发现 `claude -p` 与 Hub 回合均正常完成，于是用已有真实验收脚本逐项补测。逐项状态以[能力矩阵](native-capability-matrix.md)为准。

## 交付

- ACP 审批请求带上工具调用中的内容：编辑显示将要修改的统一差异，命令显示命令文本，否则显示输入与位置（4096 字符内）。
- 托管 Provider 会话的脱敏包装同时清理审批详情（此前只清理标题与选项名）。
- 测试修正：OpenCode 图片能力的协议测试给需要启动夹具 CLI 的驱动 10 秒请求预算。此前偶发失败的原因已确认：`opencode models --verbose` 夹具进程在负载下超过 1 秒预算时，驱动按设计放弃逐模型输入能力，断言因此失败；以 1.5 秒延迟模拟可稳定复现原失败，修正后同样延迟下通过。断言未改变。
- 真实验收脚本：`native-config` 支持 `HH_REAL_CONFIG_OPTION=model`（选择并观测模型）；其余脚本为 Claude 记录 settings.json 是否变化；`native-import` 增加 Claude。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 545 通过、0 失败、0 跳过；`.tmp/cc-batch10-tests.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：405 个计划场景、189 个能力格、51 个完整格；它不运行这些场景；`.tmp/cc-batch10-design.log` |

新增或扩展的测试：正式入口的 ACP 审批带工具标题与统一差异；脱敏包装清理审批标题、详情与选项名。变异核验：去掉审批详情的脱敏后脱敏测试失败；核验后重新构建。界面未改动（审批详情使用已有的审批卡显示），浏览器测试沿用上一轮结果。

## 本机原安装真实证据（Claude Code 2.1.296 + claude-agent-acp 0.89.1）

环境同前几轮（干净环境变量、本机原安装与原登录）；模型只作为 Hub 会话的选择（haiku，配置同步用 sonnet），不改全局配置；每项都确认 `~/.claude/settings.json` 不变。没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。

| 验收 | 结果 | 证据 |
|---|---|---|
| 目录（不发送提示） | 13 个模型（默认 opus）；选项 mode、effort、fast、agent；223 条命令；声明 load、resume、fork、list、subagents | `.tmp/cc-native-catalog-claude.json` |
| 工具活动（mode=default 手动审批） | `cat notes.txt`、读取与编辑真实执行，文件被改；编辑前请求审批并一次允许；详情可读、含差异；用量含上下文窗口与会话费用 | `.tmp/cc-native-activity-claude.json` |
| 审批详情（本轮改动后） | 审批卡“Edit notes.txt”带 5 行差异（含 +delta） | `.tmp/cc-native-activity-claude-approval.json` |
| 计划 | 受阻：该会话中模型没有 TodoWrite 类工具（模型自述），未产生计划 | `.tmp/cc-native-activity-claude.json` |
| 原生恢复 | 第二回合以原生会话恢复，未注入公共上下文并答对 | `.tmp/cc-native-resume-claude.json` |
| 附件 | 文本文件内标记被答出；红色图片被识别 | `.tmp/cc-native-attachments-claude.json` |
| 原生分支 | `session/fork` 副本答出源标记，源对话不知道分支标记 | `.tmp/cc-native-branch-claude.json` |
| `/compact` | 压缩活动完成，压缩后仍记得先前事实 | `.tmp/cc-native-commands-claude.json` |
| 配置同步 `/model haiku`（所选 sonnet） | 命令后读回 haiku；下一回合沿用；同选择显式切换后恢复 sonnet | `.tmp/cc-native-config-claude-model.json` |
| 配置同步 `/effort low`（所选 medium） | 代理没有宣告变化，回报仍为 medium，因此不沿用（记录为该命令的原生行为） | `.tmp/cc-native-config-claude.json` |
| 本机会话接续 | 见[接续验收](native-session-import-2026-10-11.md) | `.tmp/cc-native-import-claude.json` |

OpenCode 审批详情：命令审批显示 1 行命令，编辑审批显示 8 行差异；opencode.json 不变（`.tmp/cc-native-activity-opencode-approval.json`）。

## 未验证与受阻

- Claude 的思考输出、非文本输出尚未单独真实验收；AskUserQuestion（elicitation 表单）、子 Agent、后台任务、导出未接出。
- Claude 计划受阻于会话内没有计划工具。
- 未做 Windows 验证；4317 服务尚未部署第 7–10 轮代码（需要 v8→v9 迁移）。

## 部署到 4317 服务（第 7–10 轮）

2026-10-11 20:36–20:37，服务空闲（唯一会话无在途 Run 与待决切换，19:14 部署后无新写入）时部署 OpenClaw 转录对账、原生配置同步、本机会话接续与审批详情：核实 PID 与命令行后 SIGTERM 正常退出（WAL 已合并）；以 APFS 克隆冷备份 `data/` 到 `.tmp/backup-data-v8-20261011-203625/`；在副本上演练会话库 v8→v9（原会话除版本号外完全一致，325 条事件保留）。完整应用在副本路径上无法启动，因为托管安装槽绑定数据根路径（预期的安全检查，与会话迁移无关），所以演练只针对会话库。主检出快进到 `9f478cc` 并构建；经干净环境的登录 shell（无代理变量）启动，输出写入私有 `.tmp/service-4317.log`。

部署后核对：业务库 `user_version=9`，325 条事件；原会话 schema 9、open、14 个 Run、27 条消息、OpenClaw 原生会话 ready；静态页 200、未登录 API 401、无同源头的导入写入 403。一次性启动链接只在私有日志中，未使用、未展开。回退：停止服务后用 v8 备份替换 `data/`，检出 `cd0445f` 重新构建。
