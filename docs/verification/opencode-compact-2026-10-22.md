# OpenCode 1.18.35 `/compact` 真实核对（2026-10-22）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.5 节的可选核对运行（审批上限 5 次提示）。对象是 [ADR-046](../decisions/0046-harness-focus-hardening.md) 第 5 项：Hub 在 OpenCode 1.18.x 的命令目录里补上不列出的 `/compact`，原样转发给 ACP 模块（调用 `session.summarize`）。

## 环境与证据头

- commit：`66e0b59`（uncommittedChanges：false）；安装策略 official；macOS 27.0.1。
- 安装：`opencode` 1.18.35，Homebrew，product，active；入口 `opencode-binary`（acp-v1，来源 path）。ADR-038 判定：verified（1.18.35）。
- 环境与 [dsh 重验](dsh-rc2-reverification-2026-10-22.md)相同：`env -i`，`zsh -lic` 读取的 PATH，`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`，未设 `HH_REAL_MANIFEST`。会话模型用 OpenCode 本机配置的默认模型。

## 守护

轮前、轮后的 opencode 与共享清单快照（10 个位置）比较退出码 0；套件内 `guard.unchanged: true`。

## 命令与结果

`RUN HH_REAL_HARNESSES=opencode HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/native-commands.real.js`，通过：

- 目录：`/compact` 在（Hub 补入），`/export` 不在，所以没有发导出命令。
- 首轮 completed。
- `/compact` completed：OpenCode 以一段回复文本（393 字节）交回压缩结果，没有发出压缩活动（`activities` 为空）。
- 压缩后的回合 completed，仍记得先前的事实（sourceRunIds 0）。

提示 3 次（首轮、`/compact`、压缩后）。

## 局限

- 压缩的结果只以回复文本呈现，界面上没有像 Claude 那样的“压缩完成”活动。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。
