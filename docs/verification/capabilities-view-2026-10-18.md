# 能力视图验收（2026-10-18）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 1 步（统一视图，只读）与审批代理的裁决。

## 起因

用户要求统一管理各 Harness 的技能、MCP、指令、子 Agent 与命令、Hooks、插件，只改用户级配置。审批代理同意先做只读视图：先如实显示每个 Harness 实际读到什么、是否生效，再分步做写入。

## 改动

- **“谁读什么”表**（`src/adapters/capability-reads.ts`）：九个 Harness 各一张，写明版本区间和证据。内容包括技能的读取位置、优先级、同名规则和停用方式，MCP、指令、子 Agent、命令、Hooks、插件的位置，以及影响位置的环境变量。
- **可见性规则**（`src/contexts/capabilities/domain/visibility.ts`）：按各家规则算出每个技能对每个 Harness 的机制与状态。
  - 同名规则：Claude 同一真实路径只加载一次；Codex 两份都列出；OpenCode 只留一份且不确定是哪份；Gemini、OpenClaw、Pi、Hermes、DeepSeek Harness 按优先级；Cursor 没有说明。
  - OpenClaw 跳过真实路径越界的链接；目标已从共享目录读到时提示“多余”。
  - 断链、缺 SKILL.md、frontmatter 无法解析或不合各家要求，各有状态。
- **读取**（`src/infrastructure/capabilities/`）：
  - `formats.ts` 容错解析 JSONC、TOML、YAML（含 DeepSeek Harness 的 `!!js` 标签）与 JSON5。
  - `scan.ts` 按表读取：技能目录（lstat、跟随链接取真实路径、解析 frontmatter）、各家的停用开关、MCP、指令、子 Agent、命令、Hooks、插件。
  - `service.ts` 解析 Hermes 的当前 profile 与 OpenClaw 的 workspace，组合视图。
  - 读取有大小上限；解析失败的文件列为“无法读取”，不从中猜任何内容。
  - 不运行任何 Harness 命令，不启动或连接 MCP 服务器。
- **不出值**：MCP 只给出传输方式、程序名（npx 类启动器另给包名）、远程主机、变量名与请求头名，以及引用与明文值的个数；路径以 `~` 书写，用户文件里出现的家目录也换成 `~`；服务端返回前做隐私检查。
- **接口与页面**：
  - 新接口 `GET /api/v1/capabilities`，契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
  - 侧栏新增“能力”页：七个页签，每页一张“条目 × Harness”矩阵；格子写机制或状态，展开看位置、原因与提示；可搜索、只看一个 Harness、只看有提示或未生效的条目。
  - Harness 详情可以直接打开这个 Harness 的能力。
- **新依赖**（精确锁定，发布均满两周）：

  | 包 | 版本 | 许可 | 发布日期 | 用途 |
  |---|---|---|---|---|
  | jsonc-parser | 3.3.1 | MIT | 2024-06-24 | JSON 与 JSONC（注释、尾逗号） |
  | yaml | 2.9.1 | ISC | 2026-09-11 | Hermes、DeepSeek Harness 的 YAML |
  | smol-toml | 1.9.0 | BSD-3-Clause | 2026-09-22 | Codex 的 TOML |

  JSON5 用已有的 json5 2.2.3。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 163 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 388 通过，0 失败；第一次运行 387 通过、1 失败，失败项是下面说的日期相关缺陷，修正后全部通过 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 35 通过，0 失败；之后页签改用现有的页签样式，G054-CA1 单独重跑通过 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-R1～R5、G054-CA1 |

- 新增测试：
  - G064-R1：可见性规则，各家同名规则、越界与多余链接、无效条目、停用。
  - G064-R2～R4：在临时家目录里布置九个 Harness 的用户级文件，经读取层读出技能、停用状态、MCP 事实、指令、子 Agent、命令、Hooks 与插件；含无法解析的文件和写着家目录的说明。
  - G064-R5：经正式 Gateway 入口，九个 Harness 按官网渠道的目录形态安装；断言条目、机制、状态和提示，响应里没有任何密钥值、URL 路径与查询、家目录的绝对路径，并确认没有运行任何 Harness 程序。
  - G054-CA1：从侧栏和 Harness 详情打开能力页，七个页签、矩阵格子、展开提示、空状态、无法读取的文件、筛选，以及手机宽度下页面不横向滚动。
- 集成套件里有一项与本次改动无关的失败：内容存储回收测试用固定的假时钟（2026-10-11 加 7 天），却让残留文件带真实的修改时间。今天真实日期越过了假时钟，那个文件就永远“不够旧”。已改为把文件的修改时间设成测试自己的时钟，断言不变，单独提交。

## 本机真实读取

经正式入口在本机真实家目录上读取：用这次的构建起一个临时 Gateway（数据、工作区、工作区租约都在临时目录），由脚本取启动链接登录，请求 `GET /api/v1/capabilities`，只打印数量，结束后删除临时目录。

- 结果：200，含首次检测用时 0.7 秒，297 个条目（技能 201、MCP 9、指令 3、Hooks 23、插件 61），没有无法读取的文件，响应里没有家目录的绝对路径。
- 覆盖的官网安装与版本：

  | Harness | 版本 | 读取规则 |
  |---|---|---|
  | Claude Code | 2.1.302 | 已按这个版本核实 |
  | Codex | 0.162.1 | 已核实 |
  | Cursor | 2026.10.01-e373342 | 已核实 |
  | OpenCode | 1.18.35 | 已核实 |
  | Gemini CLI | 0.38.2 | 未核实 |
  | OpenClaw | 2026.3.23-2 | 已核实 |
  | Hermes Agent | 未知 | 未核实 |

  - Gemini 显示的是 Homebrew 记录里的 0.38.2，程序本身是 0.62.0（调研里已记为未确认的现象），所以标“未核实”。
  - Hermes 的官方安装脚本不记录版本。
- 各 Harness 的技能：
  - Claude：62 个链接、8 个自有目录、23 个账户同步的技能，全部生效。
  - Codex：共享目录 68、自有目录 26、内置 5，全部列出；MCP 5 个，其中 1 个停用。
  - Cursor：多数技能经 `~/.agents/skills` 和 `~/.claude/skills` 各看到一次，同名的每一份标“重复”；3 个因名字与目录不同而无效。
  - OpenCode：经 `~/.claude/skills` 和共享目录看到的同名技能只留一份，135 个标“重复”。
  - Gemini：共享目录 68 个生效，自有的 2 个里 1 个被共享目录的同名技能覆盖。
  - OpenClaw：共享目录 66 个生效，52 个链接被跳过并提示多余，workspace 里 4 个；开发链接因真实路径越界被跳过。
  - Hermes：自有目录 126 个（其中 81 个由 Hermes 随程序安装），31 个链接。
- 提示：重复 136、多余 52、交叉 12、遮蔽 2、明文 1（一个 MCP 服务的配置里直接写着名字像密钥的变量值；视图只给变量名）。
- 技能的归属：vercel skills 61、随程序安装 86（Hermes 81、Codex 5）、账户同步 22、ClawHub 1、用户 31。

## 与本机统计的对照（审批第 13 条）

审批的口径来自目录统计（技能 68/63/31/52/28，MCP 5/4），视图按“含 SKILL.md、Harness 实际会读的技能”计。逐项对照：

| 统计 | 原数 | 视图 | 差异的原因 |
|---|---|---|---|
| `~/.agents/skills` 的目录 | 68 | 67 个技能目录，另有 1 个开发链接 | `playwright-cli` 顶层没有 SKILL.md，只有 OpenCode 的递归读取找到它里面嵌套的技能；`xiaohongshu-skill` 是指向项目目录的链接，frontmatter 里的名字与目录名不同 |
| `~/.claude/skills` 的链接 | 63 | 62 个生效的链接 | 有 1 个链接指向上面那个没有 SKILL.md 的目录；另有 8 个自有目录与 23 个账户同步的技能 |
| `~/.hermes/skills` 的链接 | 31 | 31 | 一致 |
| `~/.openclaw/skills` 的链接 | 52 | 52，全部“被跳过”并提示多余 | 一致；OpenClaw 直接从 `~/.agents/skills` 读到它们 |
| `~/.codex/skills` 的目录 | 28 | 26 个自有技能、5 个内置技能 | 28 项里 `.system` 是放内置技能的目录，`codex-primary-runtime` 没有 SKILL.md |
| MCP | Codex 5、Cursor 4 | Codex 5（1 个停用）、Cursor 4 | 一致 |

## 未验证与后续

- 视图只读。停用、添加、同步等写入是 ADR-045 第 2 步起的内容；第一次真实写入按审批第 13 条，由用户在页面上对 Claude Code 停用一个指定技能再恢复。
- Claude 同步技能与本机同名技能并存时，用名字调用的是哪一份没有文档，视图只给提示。
- Cursor 是否按真实路径去掉重复没有文档，视图把同名的每一份标为“重复”。
- Codex 的 Hook 信任记录、Cursor 的 MCP 批准与启停状态不在用户级文件里，视图没有读取，按配置里写的显示。
- Pi 与 DeepSeek Harness 在本机不是官网安装，真实视图里没有它们；它们的读取规则只经临时家目录的测试验证。
