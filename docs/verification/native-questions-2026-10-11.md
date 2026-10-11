# 原生提问表单（2026-10-11）

逐项状态以[能力矩阵](native-capability-matrix.md)的“原生提问与表单”一行为准。

## 交付

- ACP 初始化声明 `clientCapabilities.elicitation.form`。claude-agent-acp 只有在客户端声明它时才启用 AskUserQuestion（否则把该工具加入禁用列表），并以 `elicitation/create` 发来表单。
- Hub 把表单逐字段作为对话中的原生提问（沿用 Codex 原生问答的交互）：单选给出各选项；Claude 的 `question_<n>_custom` 自填字段并入同一问题的“提交回答”（带文本输入）；多选题以一个选项或自填回答作为列表返回；是否题给出“是/否”。每题都可“跳过”（整表 `decline`，Claude 视为用户跳过）或“取消”（整表 `cancel`，中止该工具）。选项说明作为提问详情显示。
- 无法在对话中填写的字段（数字、对象等）整表拒绝并给出提示，不猜测；没有交互式对话（例如目录探测）时拒绝。回答映射本身不会失败，所以 Runtime“先记录决定再发送”后不会卡住。
- 真实验收脚本 `pnpm test:real:native-question`。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 547 通过、0 失败、0 跳过；`.tmp/cc-batch12-tests.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：410 个计划场景、189 个能力格、53 个完整格；它不运行这些场景；`.tmp/cc-batch12-design.log` |

新增测试（协议）：能力声明；单选与选项说明、自填并入“提交回答”、多选列表、跳过、取消、含数字字段整表拒绝、非交互拒绝。界面未改动（沿用原生提问卡片），浏览器测试沿用上一轮结果。

## 本机原安装真实证据

| Harness | 结果 | 证据 |
|---|---|---|
| Claude（haiku） | Claude 用 AskUserQuestion 提问“选择一种颜色”（红色、蓝色，另有提交回答、跳过、取消，带选项说明）；选择“蓝色”后回复“蓝色”；回合完成，settings.json 不变 | `.tmp/cc-native-question-claude.json` |

## 未验证与受阻

- 经 Claude 转发的 MCP 服务器表单、多选题同时勾选多项、其他 ACP 代理的表单未做真实验收；URL 模式（MCP OAuth）未声明，也未接出。
- 未做 Windows 验证。
