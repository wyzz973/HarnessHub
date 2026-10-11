# OpenClaw 回合按原生转录对账（2026-10-11）

依据[ADR-027](../decisions/0027-openclaw-transcript-reconciliation.md)。

## 交付

- `OpenClawControl.startText`：发送前读取转录最高序号，桥结束后读取本轮追加的转录条目，补记工具、思考、用量，并按转录的真实停止原因修正结果。
- 原 CLI 只读调用新增 `sessions.get`。
- `test:real:native-activity` 新增 `HH_REAL_READONLY=1`（只做 `echo`，用于工具作用在原程序自己工作区的 Harness），并记录 OpenClaw 原配置。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 532 通过、0 失败、0 跳过；`.tmp/cc-batch7-tests.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：387 个计划场景、189 个能力格、35 个完整格；它不运行这些场景；`.tmp/cc-batch7-design.log` |

协议测试覆盖：只计本轮条目（较早条目的用量不计入）、工具参数与结果、思考、用量与费用、桥报告完成而转录为错误时按额度错误失败。本轮没有界面改动，浏览器测试沿用上一轮结果。

## 本机原安装真实证据

| 验收 | 结果 | 证据 |
|---|---|---|
| OpenClaw（deepseek/deepseek-chat）只读工具回合 | `exec: echo HH-TOOL-OK` 工具与输出在回合后出现并存储为可读详情；本轮用量与上下文占用记录；回复 HH-TOOL-OK；openclaw.json 不变 | `.tmp/cc-native-activity-openclaw.json` |

## 未验证与受阻

- 转录为错误时的失败修正：同日晚些时候有了真实实例——在 Hub 会话中选择 OpenClaw 目录里的 `openai-codex/gpt-5.4`（该提供方在本机 OpenClaw 中不可用），桥报告回合结束，Hub 按本会话转录的错误停止原因判为失败（`MODEL_REQUEST_FAILED`），openclaw.json 不变（`.tmp/cc-native-thinking-openclaw-gpt.json`、`.tmp/cc-native-attachments-openclaw-gpt.json`）。
- 思考补记只有协议验证（deepseek-chat 不输出思考）。
- 实时工具流与执行审批需要直连 Gateway，待用户决定。
- 未做 Windows 验证。
