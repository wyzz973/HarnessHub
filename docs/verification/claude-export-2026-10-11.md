# Claude 会话导出（2026-10-11）

逐项状态以[能力矩阵](native-capability-matrix.md)的“导出与产物”一行为准。

## 交付

- `ClaudeControl`（只用于 Claude）：ACP 没有导出方法；Claude Code 把每个会话的转录保存在 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<项目>/<会话 ID>.jsonl`，claude-agent-acp 恢复会话时也在这里查找。代理没有自己的 `export` 命令时，目录中加入 Hub 的 `/export`：只读复制本会话的转录（≤ 20 MiB）作为这次 Run 的产物，不向模型发送任何内容；找不到或超限时明确失败。与 Codex、Pi 的 `/export` 一致。

## 检查

协议测试：目录提供 `/export`；在多个项目目录中找到本会话转录并作为产物返回；配置目录中没有转录时以 `NATIVE_EXPORT_UNAVAILABLE` 失败。全量测试与设计检查结果见本轮提交前的记录（`.tmp/cc-batch13-tests.log`、`.tmp/cc-batch13-design.log`）。

## 本机原安装真实证据

| 验收 | 结果 | 证据 |
|---|---|---|
| Claude（haiku）一次普通回合、`/compact`、确认仍记得、`/export` | 目录同时列出 compact 与 export；压缩完成且仍记得；导出产物为 334,237 字节的 JSONL；settings.json 不变 | `.tmp/cc-native-commands-claude-export.json` |

## 未验证

- 清除上下文后 claude-agent-acp 会以新的转录 ID 继续同一个 ACP 会话，此时按 ACP 会话 ID 找不到转录，导出会明确失败；未做真实验证。
- 未做 Windows 验证。
