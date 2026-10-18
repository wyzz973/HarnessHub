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
- **台账原值的接续**：漂移后再写入时，原值换成这次写入前的值（规则见 ADR-045 第 2 步取舍 1，审批代理确认）。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 175 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 394 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 38 通过，0 失败 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-W5～W7、G054-CA3、G054-CA4 |

- **G064-W5**（集成，经正式 Gateway 入口、临时家目录）：
  - Hermes 读取或停止读取共享目录，差异只在 `external_dirs` 这一项；
  - 没读取共享目录时不提供清理它的链接；清理只删指向共享目录的链接，撤销按原样（相对路径）放回；确认后被改动的链接一个都不动；
  - Claude Code 用绝对路径链接放置看不到的共享技能，只能移除 HarnessHub 放置的；不适用的 Harness 与不存在的技能被拒绝。
- **G064-W6**（单元）：共享目录那一项只加一次，按任何解析到它的写法移除，单个字符串的写法不改。按各家规则找技能（嵌套、隐藏目录、`.git`）由 G064-R2 覆盖。
- **G064-W7**（集成，经正式入口）：
  - Hermes 整份重写 `config.yaml`、去掉 HarnessHub 加的那一项后，显示“已被外部移除”，文件逐字节不变，视图里 Hermes 回到“经链接”；
  - Claude 的 `off` 被手改成 `on` 显示“已被外部改动”，放置的链接被删显示“已被外部移除”；
  - 重新应用走原来的检查与确认，之后启用改回用户的 `on`；
  - 文件无法解析显示“无法核对”；
  - 不再跟踪只删台账，重复时返回 `forgotten: false`，仍是 HarnessHub 写的值时 409。
- **G064-W3**（集成）：在 umask 077 与 umask 0 下写入后，目标仍是 0644，备份是 0600。
- **G064-W2**（单元）：台账按各开关的读法读回 HarnessHub 写的值；不认识的键、解析失败的文件被拒绝，不当作已移除；原值只在替换 HarnessHub 自己的值时保留。
- **G054-CA3、CA4**（浏览器）：共享技能目录卡片与各项操作；漂移提示、重新应用（先显示检查、确认才发送）与不再跟踪。

## 4317 部署（2026-10-18）

- 部署前服务空闲：没有子进程，没有进行中的管理任务。主检出快进到 `3aa14df`。没有新依赖。
- 第一次发停止信号时进程没有退出，当时拍的数据克隆因此可能不一致，已删除；进程退出后重拍克隆，再在登录 shell 环境里构建并启动。
- 部署前后存储相同：业务库 v12（会话 5、事件 1493），管理库 v6（任务 12、日志 19），能力库 v1（修改 4、备份 4、台账 0）。核对后删除了克隆。
- 服务环境里没有沙箱的代理变量。

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

## 真实写入（2026-10-18）

审批代理同意部署后执行 Hermes 的这次写入（附条件），两项清理不代为执行。

- **执行方式**：
  - 按页面同样的流程，经 4317 自己的接口：检查 → 确认 → 写入 → 回读。
  - 部署后的一次性口令由脚本读取，没有打印；完成后再次重启，经本机重定向给用户打开新的登录链接。
  - 只打印状态、行数、哈希前缀、权限和比对结果。
- **检查**：
  - 文件 `~/.hermes/config.yaml`，现有设置“还没有这项设置”；
  - 显示的差异恰好是 `external_dirs: []` 改为 `external_dirs: ["~/.agents/skills"]` 这一行；
  - 提示会多看到 6 个技能，网关不重启。
- **写入**：
  - 留了备份，实际改动与显示的一致。
  - 文件只有那一行不同（多 18 字节），行数不变；权限 0600、所有者、链接数都不变。
  - 解析后 `skills.external_dirs` 等于 `["~/.agents/skills"]`，其余内容完全相同。
  - sha256 由 `3e2c2f96e57c3f94…` 变为 `a2508d3fbd0c3c84…`。
- **视图**：
  - Hermes 改为“经 external_dirs 读取”，生效技能 163 → 169；自己目录里的 31 个链接现在全部多余。
  - 4317 的修改记录 5 次、备份 5 份（都是 0600），台账 1 项（就是这一项），漂移 0。
- **Hermes 侧核实**：
  - 用 Hermes 自己的发现函数只读核对：`tools/skills_tool.py` 的 `_find_all_skills`（第 549 行），它经 `agent/skill_utils.py` 第 174 行的 `get_external_skills_dirs` 读取 `external_dirs`。版本是 Hermes 0.12.0（源码 `a0556b861f`）。
  - 这是私有接口，只作这一次核实。
  - 用 Hermes venv 的 `python -I` 在 sandbox-exec 里运行，只可写一个临时目录，禁网。
  - 结果：写入前 163，写入后 169（排除停用的技能后同为 169），那 6 个技能都出现。
  - 没有用 `hermes skills list`：它启动时要建 `~/.hermes/skills/.hub/quarantine`，在禁写沙箱里报错；没有为此放开对用户目录的写入。
- **网关**：Hermes 网关（QQ 等消息渠道，已运行 4 天多）没有重启，它重启后才看到这 6 个技能；长驻的 Hermes 进程要 `/reload-skills` 或重启后生效。
- **没有执行的**：OpenClaw 的 52 个、Hermes 的 31 个多余链接，留给用户在页面上决定。清理可以撤销；`npx skills` 以后可能重新建这些链接。

## 未验证与后续

- 添加、更新、删除技能，与 `.skill-lock.json` 互操作，属于第 2 步后续。
- Hermes 网关与长驻进程何时读到 `external_dirs` 的改动，取决于它们自己的重载；HarnessHub 不重启它们，也没有核对它们何时生效。
- 漂移检查在读取“修改与备份”时进行（打开能力页、每次修改之后），没有后台监视。
