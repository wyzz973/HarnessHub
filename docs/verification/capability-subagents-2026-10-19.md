# 子 Agent 与新建技能验收（2026-10-19，第 5 步）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 7 节、“第 5 步设计”与“审批代理对第 5 步的裁决”。用户要求：“要做到我们的 harnesshub 能够统一的配置和读取”。只在 macOS 上验证。

## 改动

- **新模块**（`src/infrastructure/capabilities/`）：
  - `subagent-definitions.ts`：子 Agent 的校验、四家格式的生成与读回、按各家命名规则查同名。
  - `subagent-changes.ts`：子 Agent 清单、状态、写入与移除的检查、认领。
  - `skill-text.ts`：由文本写技能的校验、生成与读回。
- **改动的模块**：
  - `changes.ts`：接入子 Agent；编辑计划可以新建目录或删除 HarnessHub 新建的空目录；`dir/created` 不进漂移；撤销支持新建与编辑技能。
  - `skill-changes.ts`、`skill-packages.ts`：新建与编辑技能的步骤，来源记为 `local`，检查更新时说明没有上游。
  - `store.ts`：存储 v5，新增 `subagents` 与 `skill_sources.kind`；降级脚本 `tools/capabilities-v5-to-v4.sql`。
  - `capability-reads.ts`、`scan.ts`：读取表按已装版本更正，保留名与内置命令附证据；Gemini 不读的文件列出原因。
- **接口与页面**：见 ADR-045 第 5 步实现记录与 [provider-web-mvp](../contracts/provider-web-mvp.md)；页面新增“统一子 Agent”卡片、“新建技能”与“编辑”。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 195 通过，0 失败 |
| 协议 | `node --test dist/tests/protocol/*.test.js` | 144 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 406 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 42 通过，0 失败 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-A1～A4、G054-CA8，G064-R4 按读取表更正 |

- **G064-A1**（单元）：四家格式的生成与读回（引号、反斜杠、`#`、像 frontmatter 的行都原样往返，只有规定的键）；读取表里四家的每个内置名都被拒绝并写明是哪家的；名字、说明、正文的无效样例；Gemini 的 `${`；按各家规则查同名。
- **G064-A2**（集成，经正式入口，临时家目录）：
  - 四家可写，其余说明原因；无效输入被拒绝。
  - 检查的第一句是声明，并写明继承什么。
  - 文件 0600；OpenCode 没有目录时新建为 0700，移除最后一个文件后删除，原有目录保留。
  - 命令重放、409、覆盖改过的文件；清单在文件还在时不能删除。
- **G064-A3**（集成）：
  - Claude 的嵌套文件、OpenCode 的 `modes/`、Codex `config.toml` 的 `[agents.<名>]` 都算同名定义。
  - Gemini 跳过的 `_` 文件不算；目标位置是链接时不写；`config.toml` 无法解析时不写 Codex。
  - 认领；漂移的改动与移除；旁边出现同名定义时仍可移除；配置目录缺失时不替它新建。
- **G064-A4**（集成）：新建技能的无效输入、不分大小写的重名、内置命令警告、写入权限与来源、不写 lock、检查更新时说明没有上游、编辑与覆盖、撤销、删除、新建后撤销不留记录。
- **G064-R4**（单元，更正）：子 Agent 与命令按本机版本读取，Gemini 不读的文件写明原因，Cursor CLI 只读家目录的命令。
- **存储**：降级链 v5→v4→v3→v2→v1 在三个测试里跑过；v3 数据库重新打开后回到 v5，并为已记录的技能补上来源种类。
- **G054-CA8**（浏览器）：子 Agent 卡片的状态与说明、写入的确认、新建子 Agent 只发送三样、新建技能的对话框走自己的检查。

另外修正了第 4 步测试文件里的一处缩进（0fb4d59 中第二个用例被多缩了两格，不影响语义）。

## 第一次真实写入（2026-10-19，审批同意，由我代为执行）

按审批裁决第六节：一个核对用子 Agent，依次写入 OpenCode、Gemini、Codex、Claude Code，核对后全部移除。4317 运行 `6c1d66f`（PID 51557，部署时数据各表行数与克隆一致，只多了空的 `subagents` 表；存储升到 v5，`skill_sources` 补上 `kind` 列）。只验证文件级契约；各家会话里是否列出这个子 Agent 没有验证。

- **内容**：名字 `harnesshub-roundtrip-check`；说明“HarnessHub 往返核对用的占位子 Agent，不承担任何任务”；正文“这个子 Agent 只用于核对 HarnessHub 的写入与移除，不执行任何操作；被调用时只回答自己是核对用的占位子 Agent。”
- **写入前**：
  - 清单为空；`~/.config/opencode/agents`、`~/.gemini/agents`、`~/.codex/agents`、`~/.claude/agents` 都不存在。
  - 没有 Gemini、OpenCode 进程；3 个 Codex 进程（ChatGPT 应用 2、VS Code 扩展 1）；台账与漂移为空。
- **四家写入**（change `4b6bf876` OpenCode、`310a5d81` Gemini、`5a4c89d7` Codex、`bee8e80d` Claude）：
  - **检查**：都不阻止；第一句是“只新建 HarnessHub 自己的文件 …，不写工具、权限、hooks、MCP，不改模型与登录配置”；都说明会新建目录；Codex 写明有 3 个进程在运行，Claude 写明 6 个。差异只新增这个文件。
  - **应用**：
    - 文件字节与计划一致，0600、本人所有、单链接；目录 0700，台账记下 `dir/created`。
    - 按各家格式读回名字、说明、正文都相等，键只有规定的几个：OpenCode 为 `description`、`mode`，Gemini、Claude 为 `description`、`name`，Codex 为 `description`、`developer_instructions`、`name`。
    - 状态“已写入”，没有漂移。
  - **其他条目**：各家配置目录里没有变化，只多了 `agents`。运行中程序自己的状态文件不计，按第 4 步的口径（两次相隔 10 秒的清单之间就变了的，以及运行状态的名字）。
- **30 秒后**：四个文件的哈希都没变；没有新的 Gemini、OpenCode 进程，也没有 ChatGPT、VS Code 之外的 Codex 进程。
- **移除**（change `6020bec6`、`1baabca5`、`63a99007`、`4dbbbc13`）：
  - 每个检查都写明会删除这个文件，并一并删除 HarnessHub 新建的目录。
  - 应用后文件与目录都不存在，各家配置目录与写入前的清单相同，各留一份移除前的备份（0600）。
- **结束**：
  - 没有漂移，台账里没有 `subagent/` 与 `dir/created` 记录；历史里 8 条都是“已应用”。
  - 核对用的子 Agent 已从清单删除，清单为空。

## 未验证与后续

- **各家会话里能否列出、调用这个子 Agent**：没有验证。要新建会话，不在这次审批范围内。
- **新建技能的第一次真实写入**：留给用户在页面上点。
- **页面记住选项**：没有做。
- **平台**：只在 macOS 上验证。
