# 放置与清理验收（2026-10-18）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 2 步的后续部分（共享目录、逐个放置、清理多余链接与撤销），以及审批代理的第 2、3、13 条。

## 改动

- **Hermes 读取共享目录**：在 `config.yaml` 的 `skills.external_dirs` 里加上或去掉 `~/.agents/skills`。任何解析到共享目录的写法都算（`~`、`${VAR}`、相对 HERMES_HOME 的路径），单个字符串的写法不改写。检查里写明会多看到哪些技能，以及网关与长驻进程何时生效。
- **Claude Code 逐个放置**：为看不到的共享技能建绝对路径链接 `~/.claude/skills/<文件夹>`，台账记下；只移除 HarnessHub 放置的链接；已能看到的、位置已被占用的都不做。
- **清理多余链接**：Hermes、OpenClaw 自己目录里指向共享目录的链接。只删指向 `~/.agents/skills` 的；Hermes 要先读取共享目录。应用前逐个核对，有一个变了就全部不做；做了的链接记在修改记录里。
- **撤销**：链接改动按记录撤销，删掉当初建的、放回当初删的；目标沿用当初的写法。
- **视图**：
  - 每个 Harness 写明怎样读共享目录（自己读、经 `external_dirs`、经链接、不读），以及自己目录里有几个指向它的链接、其中几个多余；共享技能写明它在共享目录的文件夹和 HarnessHub 放置的链接。
  - Hermes 与 OpenCode 改按它们自己的方式找技能：每个 SKILL.md 都算，包括技能文件夹里嵌套的。Hermes 读隐藏目录，只跳过 `.git/.github/.hub/.archive`；OpenCode 跳过隐藏目录。本机 Hermes 计数因此是 163，与它自己的遍历相同。
- **页面**：技能页签上方的“共享技能目录”卡片；技能详情里的“放到 Claude Code / 从 Claude Code 移除（HarnessHub 放置的）”；历史里的“撤销”。
- **漂移检查**（审批条件）：
  - 台账里 HarnessHub 写过的每一项（技能开关的设置、Hermes `external_dirs` 里的那一项、放置的链接），按写入它的开关的读法从文件读回比对，结果在 `GET /api/v1/capabilities/history` 的 `drift` 里。
  - 页面顶部列出“已被外部移除 / 已被外部改动 / 文件无法读取，无法核对”的项，写明不会自动改回。
  - “重新应用”走原来的检查与确认；“不再跟踪”只删台账、不改文件，仍是 HarnessHub 写的值时拒绝。
- **台账原值的接续**：同一设置再次写入时，只有被替换的仍是 HarnessHub 自己的值，才保留它第一次写入前的原值；否则换成这次写入前的值。

## 检查结果

RESULTS

## 真实环境只读预检（2026-10-18）

用工作区构建起临时 Gateway（临时数据目录），对真实家目录只做检查，没有写入：

- 各 Harness 读共享目录的方式：
  - Claude Code 经自己目录里的 60 个链接；
  - Codex、Cursor、OpenCode、Gemini 自己读取；
  - OpenClaw 自己读取，另有 52 个链接，全部多余；
  - Hermes 经自己目录里的 31 个链接，`external_dirs` 为空。
- Hermes 读取共享目录的计划：只改一行，`external_dirs: []` 改为 `external_dirs: ["~/.agents/skills"]`。会多看到 6 个技能：agently-mail、dev（在 playwright-cli 的隐藏目录 `.claude/skills` 里）、playwright-cli（嵌套在同名文件夹里）、wechatpay-basic-payment、worldcup-score-simulator、xcodebuildmcp-cli。
- 清理：OpenClaw 的 52 个链接可以清理；Hermes 的 31 个在它读取共享目录之前被拒绝（否则这些技能会从 Hermes 里消失）。
- `~/.hermes/config.yaml` 的修改时间与大小前后相同。只打印了改动行与数量。

## 真实写入

WRITE

## 未验证与后续

- 添加、更新、删除技能，与 `.skill-lock.json` 互操作，属于第 2 步后续。
- Hermes 网关与长驻进程何时读到 `external_dirs` 的改动，取决于它们自己的重载；HarnessHub 不重启它们，也没有核对它们何时生效。
