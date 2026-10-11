# 思考输出真实验收（2026-10-11）

逐项状态以[能力矩阵](native-capability-matrix.md)的“思考输出”一行为准。本轮没有改动产品代码，只新增真实验收脚本 `pnpm test:real:native-thinking`：一道需要推理的算术题（37 × 43），检查 Run 记录原程序的思考内容、思考不混入回复、答案正确，并确认原配置不变。证据只保留长度与匹配结果。

| Harness | 设置 | 结果 | 证据 |
|---|---|---|---|
| OpenCode 1.18.35 | 默认模型 | 通过：思考 15 字符，回复 1591 | `.tmp/cc-native-thinking-opencode.json` |
| Pi 0.85.1 | deepseek/deepseek-flash，thinking_level=high（本会话选择） | 通过：思考 52 字符，回复 1591 | `.tmp/cc-native-thinking-pi.json` |
| Claude（haiku，effort=high） | 本会话选择 | 回复正确但没有思考文本：claude-agent-acp 说明新模型默认 `thinking.display` 为 omitted，只流出无文本的签名块；Hub 不修改用户设置 | `.tmp/cc-native-thinking-claude.json` |
| Codex（gpt-6.1-sol，用户配置 effort=xhigh） | 用户配置 | 回复正确但没有推理摘要：用户配置未设置推理摘要，这一回合原程序没有发送 | `.tmp/cc-native-thinking-codex.json` |

各项原配置均未改变。思考与回复的映射在协议测试中已覆盖（ACP `agent_thought_chunk`、Codex reasoning 摘要、Pi thinking 事件、OpenClaw 转录中的 thinking 块）。未做 Windows 验证。
