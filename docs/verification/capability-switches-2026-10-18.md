# 技能开关验收（2026-10-18）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 2 步的第一部分（写入框架与按 Harness 停用技能），以及审批代理对三处实现取舍的裁决（同意，附条件，已全部落实）。

## 改动

- **写入框架**（`src/infrastructure/capabilities/`）：
  - `changes.ts`：检查 → 确认 → 写入 → 回读，以及备份恢复。检查只读，返回要改的文件、精确差异、现有设置由谁写的、提示和不能执行的原因。确认 15 分钟内有效、只能用一次，同一命令编号重放返回第一次的结果。
  - `files.ts`：写入前再读比对；同目录临时文件加 rename 原子替换，rename 前再比对一次；保留权限、BOM 和换行。目标是符号链接或有其他硬链接时拒绝。
  - `edits.ts`：按格式定点编辑。JSON/JSONC 用 jsonc-parser（单行列表手工插入，保持在一行），TOML 按行找 `[[skills.config]]` 元素（跳过多行字符串），YAML 按节点范围拼接文本。每次编辑都经过“除目标设置外解析结果完全相等”的校验。
  - `masking.ts`：显示的差异打码，见下文。
  - `store.ts`：`capabilities/capabilities.sqlite`（v1）保存修改记录、备份索引与台账，备份文件在旁边的 `backups/`（0600，每个文件留最近 10 份），带所有者代际防护。
- **各 Harness 的开关**（`switches.ts`）：

  | Harness | 写法 | 启用时 |
  |---|---|---|
  | Claude Code | `skillOverrides.<名>` 设为 `off` | 台账表明 off 是 HarnessHub 写的就恢复原值，否则删除并提示 |
  | Codex | `[[skills.config]]`，按 SKILL.md 的完整路径、每一份分别停用 | 只含 path 与 enabled 的元素删除，否则改回 true |
  | Gemini CLI、Hermes | `skills.disabled` 列表 | 从列表移除 |
  | OpenCode | 最后一个存在的配置文件里 `permission.skill.<名>` 设为 `deny`，规则放到末尾 | 只撤回 deny；仍被其他规则拒绝时，点名那条规则并追加 allow |
  | OpenClaw | `openclaw config set/unset skills.entries.<名>.enabled`，在沙箱里运行 | 同左 |
  | Cursor、Pi、DeepSeek Harness | 没有开关，显示始终可见 | — |

- **接口与页面**：
  - 新接口 `GET /api/v1/capabilities/skill-switch`、`POST /api/v1/capabilities/changes`、`GET /api/v1/capabilities/history`、`GET /api/v1/capabilities/backups/{id}/restore`、`POST /api/v1/capabilities/restores`，契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
  - 能力页展开技能后按 Harness 显示“停用 / 启用”（Codex 按每一份）。确认框显示文件、红绿差异、现有设置由谁写的和提示；结果可一键恢复修改前的文件；页面底部列出“修改与备份”。

## 审批条件的落实

- **OpenClaw 在副本上预演**：
  - 检查阶段把 openclaw.json 复制到私有临时状态目录（0700），在沙箱里对副本运行同一条官方命令，沙箱只可写该目录、禁网；用完即删，服务启动时清扫十分钟前遗留的预演目录。
  - 命令输出不进入日志。
  - 预演结果与原文件比较：改动了需要重启 Gateway 的键（`gateway`、`discovery`、`canvasHost`、`plugins`）就阻止并说明。
  - 应用时在只可写 `~/.openclaw`、禁网的沙箱里运行，回读后与预演结果比对，只忽略 `meta.lastTouchedAt`，不一致记失败并提供恢复。
- **点号路径**：方括号写法会把引号写进键名（本机 2026.3.23-2 实测），改用点号路径；技能名必须是字母、数字、`-`、`_` 组成的标识符，否则对 OpenClaw 拒绝并说明。
- **差异的显示**：
  - 上下文最多 2 行。
  - 整份重写（OpenClaw）默认只显示目标设置的前后值，以及命令还会新增、删除、改变的键和丢失的注释行数；完整差异要点开，并提示可能仍有无特征的值。
  - 打码规则：名字像凭据的键的值、常见令牌形态（`sk-`、`ghp_`、`xox*-`、`AKIA`、`AIza`、JWT）、`--token` 一类参数、URL 的账号与查询串。变量引用、数字、布尔值保留。
  - 修改记录只存打码后的内容，原字节只在 0600 的备份里。
  - **局限**：没有可识别名字或形态的密钥（例如普通参数里的值）仍可能出现在上下文行里。
- **OpenCode 追加 allow**：计划里写明“你现有的规则 X 拒绝了它；启用会在末尾追加 allow 覆盖它，这条 allow 记为 HarnessHub 写的”，确认后才写。
- **网关进程**：Hermes 与 OpenClaw 的确认框写明正在运行的网关（QQ、飞书、微信等）不会被 HarnessHub 重启。Hermes 要 `/reload-skills` 或重启后生效；OpenClaw 按文档下一轮生效。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 171 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 391 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 36 通过，0 失败 |
| 真实 OpenClaw | `pnpm test:real:openclaw-switch` | 1 通过 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-W1～W4、G054-CA2 |

全套运行之后又改了两处：检查里的 OpenClaw 预演纳入关闭时的等待，并清理过期的确认；确认框在“无需修改”时不显示“现在的设置”。改后补跑了相关测试：开关单元 8 项、能力集成 4 项、真实 OpenClaw 1 项、能力页浏览器 2 项，全部通过。

- **G064-W1**（单元）：含模型键和注释的真实形态文件——Claude JSON、Codex TOML（表数组、注释、多行字符串里伪装的表头）、Hermes YAML、OpenCode JSONC——除目标行外逐字节不变；BOM、CRLF、制表符缩进保留。另有“编辑器越界改动”和“目标值不对”的无效样例被校验拦下，打码规则有正反样例。
- **G064-W2**（单元）：
  - 各 Harness 的计划：恢复 HarnessHub 替换掉的值，已是目标状态的不改，OpenCode 不删用户的 allow 并点名覆盖的 deny。
  - 存储：只留最近 10 份备份，按命令编号重放，较新的所有者代际挡住旧的。
  - OpenClaw：用模拟本机行为的命令验证副本预演、摘要、真实运行只可写自己的目录，以及改动 `gateway.port` 时被阻止。
- **G064-W3**（集成，经正式 Gateway 入口、临时家目录）：
  - Claude 停用后文件只有那一个值变了，同一命令重放返回第一次的结果，确认换命令号为 409，启用后逐字节回到原文件。
  - 确认后文件被改、目标是符号链接、没有开关的 Harness、看不到的技能、非法名字，都在写入前拒绝。
  - Codex、Hermes、OpenCode 保留注释与其他键；差异里家目录写成 `~`，凭据打码。
  - 备份恢复前显示差异，并提示此后是否被改过。
  - 没有在沙箱外运行任何 Harness 程序。
- **G064-W4**（真实程序）：本机真实的 OpenClaw 2026.3.23-2，私有家目录与状态目录，禁网沙箱：
  - 副本预演给出精确差异，摘要列出它补上的 `commands`、`meta` 和丢失的 1 行注释，真实文件不变；
  - 确认后写入的结果与预演一致；`config unset` 启用；恢复备份后文件（含注释）回到原样。
- **G054-CA2**（浏览器）：
  - 各 Harness 的开关按钮（Codex 按每一份）；确认框的红绿差异；确认前不发送，发送的正是确认的检查；
  - 无需修改的检查不能确认；OpenClaw 的摘要与按需显示的完整差异；
  - 结果一键恢复，恢复也先显示差异。

## 4317 部署（2026-10-18）

- 部署前服务空闲（没有子进程，没有进行中的管理任务），做了数据克隆备份。主检出快进到 `ebc21da`，在登录 shell 环境里构建并启动（PID 66806）。没有新依赖。
- 启动时新建了 `data/capabilities/`（目录 0700，标记文件与 `capabilities.sqlite` 0600，schema v1，0 条修改、0 份备份）。管理库仍是 v6，任务数 12、日志数 19 与部署前相同，业务库仍是 v12。核对后删除了备份。
- 只读预检：用部署后的构建起临时 Gateway（临时数据目录），对真实的 `~/.claude/settings.json` 准备一次停用检查。结果：没有被拒绝；现有设置为“还没有这项设置”；差异改 3 行，都在新增的 `skillOverrides` 里；文件的修改时间和大小前后相同，没有写入。只打印了这些形状，没有打印文件内容。
- 一次性登录链接经本机重定向打开，没有贴出。

## 第一次真实写入

按审批第 13 条，应由用户在 4317 的能力页上对 Claude Code 停用一个自己指定的技能，再启用。核对：`~/.claude/settings.json` 的差异只含 `skillOverrides`，启用后逐字节回到原样。

- **执行方式**：用户回复“你执行一下吧”，授权代为执行。
  - 经 4317 自己的接口，按页面同样的流程执行：检查 → 确认 → 写入 → 回读，再启用。修改记录与备份都在 4317 的数据目录里。
  - 页面的一次性登录口令已被浏览器用掉，所以重启了空闲的 4317，由脚本读取新口令登录，口令没有打印。完成后再次重启，给用户打开新的登录链接。
  - 选的技能是 `remotion-captions`：它在 Claude 里是指向 `~/.agents/skills` 的链接，与当前工作无关。
  - 全程只打印状态、行数、哈希前缀和比对结果，没有打印文件内容。
- **第一次（commit `ebc21da` 的构建）**：
  - 停用：检查显示改 3 行、现有设置“还没有这项设置”；写入后实际改动与显示的一致，留了备份，文件只多了 `skillOverrides.remotion-captions = "off"`（58 字节），解析后其他内容完全相同；能力页随即显示“已停用”。
  - 启用：台账认出这个 off 是 HarnessHub 写的；写入后文件逐字节回到原样，sha256 前后都是 `25fc4d7f9d78f675…`。
  - **发现的问题**：文件权限由 `0644` 变成了 `0600`。原因是 4317 以 `umask 077` 运行，替换用的临时文件按 umask 创建，与 ADR 的“保留权限”不符。已把文件改回 `0644`（内容哈希不变）。
  - **修正**（commit `61621e7`）：建临时文件后用 `fchmod` 显式设置原权限；补了在 `umask 077` 下替换 0644 文件的单元测试。之后按审批又补了经正式入口的集成测试（G064-W3）：在 `umask 077` 下停用技能后，`settings.json` 仍是 0644，备份是 0600；在 `umask 0` 下启用，两者同样不变。
- **第二次（修正后的构建）**：同一技能再停用、再启用。全程权限保持 `0644`，停用后同样只多了那一个值，启用后逐字节回到原样（sha256 `25fc4d7f9d78f675…`）。
- 4317 上的修改记录现有 4 次修改、4 份 `~/.claude/settings.json` 的备份（0600，在 `data/capabilities/backups/`），台账为空，因为最后一次启用撤回了 HarnessHub 写的值。

## 未验证与后续

- Hermes 的 `skills.external_dirs` 放置、清理多余链接、添加 / 更新 / 删除技能、与 `.skill-lock.json` 互操作，属于第 2 步的后续部分。
- Claude、Gemini 的运行中会话只做了计数提示；Gemini 会话按启动快照覆盖 settings.json 的情形，写后没有持续复查。
- OpenClaw 的预演依赖本机版本的命令行为；升级 OpenClaw 后要重新核实（审批第 9 条）。
