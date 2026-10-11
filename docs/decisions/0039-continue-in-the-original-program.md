# ADR-039：在原程序中继续原生会话

状态：accepted，2026-10-12。依据用户授权的审批代理（Fable 5.1）为排序第 6 项 C 定下的条件，以及它对验证方式的裁决（采纳方案 B）。对应[第一链路调研](../research/first-chain-products-2026-10-11.md)的差距 9。

## 背景

- 用户在 HarnessHub 里与某个 Harness 对话，原程序自己也保存着这段原生会话。用户有时想回到原程序的终端里继续，例如使用 Hub 还没有接出的原生功能。界面原来不显示原生会话 ID，也不给出继续的方法。
- 参考产品：Happy 为每个会话给出一条可复制的原生恢复命令；Zed 在只能恢复时明确提示，不显示之前的消息。

## 决定

1. **只给验证过的命令。** 每个产品有两种形式：
   - 交互形式，例如 `claude --resume <id>`：在已安装版本的 `--help` 中逐一确认，不从非交互形式推断；
   - 只问一次的非交互形式，例如 `claude -p --resume <id> "你的问题"`：在开发实例的测试对话上做了真实验证。HarnessHub 先在对话中让原程序记住一个标记，再用这条命令恢复 Hub 记录的原生会话 ID，原程序答出了标记数字的倒序（这串数字不出现在历史中）。

   表在 `src/infrastructure/management/verified-versions.ts`，与 ADR-038 的验证版本放在一起。安装版本在验证范围内才给出命令；超出范围只显示原生会话 ID，并注明“恢复命令未在此版本验证”。
2. **与审批代理“与验证形式完全一致”要求的偏离（裁决 B）。**
   - 交互形式在新目录中会先询问是否信任这个目录，接受后会写入用户自己的全局配置，例如 `~/.claude.json`、`~/.codex/config.toml`。后者还存放用户的模型设置。因此真实验证使用非交互形式：它们不询问信任，也不写这些配置，恢复标志、ID 和目录都与交互形式相同。
   - 界面主显示交互形式，悬停说明“交互形式按原程序帮助给出，恢复机制以非交互形式真实验证”。展开后提供“只问一次（已用真实回合验证）”的非交互形式。两种都只供复制。
3. **各产品（2026-10-12，本机安装）：**

   | Harness | 交互形式 | 已验证的非交互形式 | 结论 |
   |---|---|---|---|
   | Claude Code 2.1.296（claude-agent-acp 0.89.1） | `claude --resume <id>` | `claude -p --resume <id> "…"` | 给出 |
   | Codex 0.162.1 | `codex resume <id>` | `codex exec --skip-git-repo-check resume <id> "…"` | 给出 |
   | OpenCode 1.18.35 | `opencode -s <id>` | `opencode run -s <id> "…"` | 给出 |
   | Hermes 0.12.0 | `hermes --resume <id>`（Hermes 自己在回合结束时也打印这条命令） | `hermes chat --resume <id> -q "…"` | 给出 |
   | DeepSeek Harness 0.2.1-alpha.1 | `dsh tui --resume <id>` | `dsh headless --session-id <id> "…"` | 给出 |
   | Cursor Agent 2026.10.01-e373342 | `--resume [chatId]` 存在 | `-p --resume` 停在工作区信任，要求 `--trust` | 只显示 ID：为不写用户配置，没有加 `--trust`；它的 ACP 会话存放在 `~/.cursor/acp-sessions` 下，能否被 `--resume` 找到也未验证 |
   | Gemini CLI 0.62.0 | `--resume` 只接受 `latest` 或序号 | — | 不验证：测试回合被模型服务以客户端版本过旧拒绝 |
   | Pi 0.85.1 | — | — | 会话标识是文件路径，只显示“见 Pi 自己的会话列表” |
   | OpenClaw | — | — | 不显示：它的会话在用户自己的 OpenClaw Gateway 中，Hub 不读取其目录 |

4. **ID 与安全。** 原生会话 ID 只有在是普通标识符（字母、数字、`_`、`-`，至多 128 个字符）时才显示或放进命令。原程序返回的其他内容一律不出现在页面或命令中，避免复制出意外的 shell 命令。命令中不含工作区路径，文字写“在该对话的工作区目录中运行”。
5. **提示。** 命令旁边说明两点：
   - 原程序首次在这个目录运行时可能先询问是否信任这个目录，接受会写入它自己的全局配置；
   - 在原程序中继续会使两边的回合交错，回到 HarnessHub 继续前，先在原程序中结束。

   原生会话中多出的回合按 ADR-029 的既有说明处理。
6. **接口。** `GET /api/v1/sessions/:id/native-resume` 返回当前选择的已就绪原生会话的 `{resume: {harnessId, nativeId?, interactive?, once?, list?, note?} | null}`。它在打开执行配置时按需读取，不进入会话视图和导出。HarnessHub 不执行这些命令。

## 维护

在新版本上做真实验收时，同时验证这些命令；扩展 ADR-038 的版本表与本表，并更新能力矩阵与验证记录。新的产品要先完成本 ADR 第 1 项的两种验证，才能加入表中。
