# 指令区块验收（2026-10-19，第 4 步）

依据 [ADR-045](../decisions/0045-unified-capability-management.md) 第 6 节、“第 4 步设计”与“审批代理对第 4 步的裁决”。用户要求：“要做到我们的 harnesshub 能够统一的配置和读取”。只在 macOS 上验证。

## 改动

- **新模块**（`src/infrastructure/capabilities/`）：
  - `instruction-blocks.ts`：区块的解析、写入与移除；文本校验。
  - `instruction-changes.ts`：每个 Harness 的目标文件与状态，写入、移除的检查，认领。
- **改动的模块**：
  - `changes.ts`：接入指令；`markdown` 编辑与删除新建的空文件；`alsoLedger`；删除了文件的备份记为 `deleted`；运行中的 Codex 与 cc-switch 的检测；漂移、重新应用、不再跟踪、孤立设置识别 `instructions/`，`file/` 记录不进漂移。
  - `files.ts`：`removeTarget`（再比对一次再删除，同步父目录）。
  - `store.ts`：存储 v4，新增 `instruction_texts`；降级脚本 `tools/capabilities-v4-to-v3.sql`。
  - `mcp-changes.ts`：DeepSeek Harness 的补丁文件由 HarnessHub 新建时记下 `file/created`，移除最后一个服务器后删除文件。
  - `capability-reads.ts`：Codex 用户级指令无上限；OpenCode 的回退受两个环境变量控制，路径按源码；`scan.ts` 不再对 Codex 提示 32 KiB。
- **接口**：`/capabilities/instructions`（读、存）、`/instructions/claim`、`/instructions/sync`、`/instructions/remove`，契约见 [provider-web-mvp](../contracts/provider-web-mvp.md)。
- **页面**：指令页签上方的“统一指令”卡片（`InstructionsPanel.tsx`）；确认框支持 `proceed`（只差用户表态时显示按钮，带上选项重新检查）。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元 | `node --test dist/tests/unit/*.test.js` | 192 通过，0 失败 |
| 协议 | `node --test dist/tests/protocol/*.test.js` | 144 通过，0 失败 |
| 集成 | `node --test dist/tests/integration/*.test.js` | 403 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 41 通过，0 失败 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G064-I1～I3、G054-CA7 |

全套运行之后又改了一处：Gemini 在指令语境下的运行中提示不再说“会覆盖 settings.json”（那只对设置成立），改为可以用 `/memory refresh` 重新读取。改后补跑了能力相关的单元与集成测试（10 个文件、46 项），全部通过。

- **G064-I1**（单元）：
  - 区块追加在末尾、空一行，原地替换，移除后逐字节回到原样；覆盖 BOM、BOM 加 CRLF、混合换行、末尾无换行，区块后有用户内容时保留分隔。
  - 无法识别的标记（id 不对、sha 大写、有前导空白）、重复或缺失的标记都拒绝。
  - 文本拒绝超过 16 KiB、NUL 与其他控制字符、孤立的代理项、区块标记和家目录完整路径；制表符、换行、中文与 emoji 可以。
- **G064-I2**（集成，经正式入口，临时家目录，两项）：
  - 选文件：Codex 跳过空白的 override；Gemini 取 `context.fileName` 里第一个存在的名字；Hermes、Cursor 不写并说明原因。
  - 写入、更新、移除：DeepSeek Harness 的区块接在原内容后，权限不变，有备份；命令重放返回第一次的结果；检查后文件被改返回 409；更新保留区块后的用户内容；移除逐字节回到原样。
  - 新建与删除：新建的文件为 0600，移除后删除；备份记下“已删除”，恢复时说明没有被改过，并以 0600 重建。
  - 符号链接拒绝；降级脚本删除指令文本、历史与台账，其他记录保留。
  - OpenCode：回退文件有用户内容时要 `create-own`，并给出改写 Claude 文件的替代做法；两个文件都不存在时直接新建，移除后删除并说明恢复回退。
  - Claude 的检查说明 OpenCode 也会经回退读到、删除后它也读不到；之后 OpenCode 显示经 Claude 文件生效，再新建它自己的文件不用确认。
  - OpenClaw：超过 `bootstrapMaxChars` 时阻止；列出频道名（夹具里频道带着像密钥的值，回答里没有出现）；多个 agent 时只写默认 agent；提示 git；工作区文件不存在时阻止。
  - cc-switch：`~/.cc-switch` 设为不可读的目录，判断仍成立；0 字节文件另有说明；第一次写入要 `acknowledge-cc-switch`，更新 HarnessHub 自己的区块不再阻止；移除回到 0 字节。
- **G064-I3**（集成）：
  - 未安装的 Pi 不出现。
  - 区块里被改过：显示被改动，进入漂移列表，覆盖与移除都要 `overwrite`；孤立设置列表为空。
  - HarnessHub 更早写的版本被写回时如实说明；手工删掉的区块显示被移除，重新应用后回来。
  - 无法使用的标记在漂移里显示无法读取，阻止写入，可以不再跟踪。
  - 认领：内容一致时成功且文件不变，不一致时拒绝。
  - Codex 出现 override 后原区块显示被遮蔽，先从原文件移除；原文件已没有区块的旧记录随新写入删除；不留临时文件。
  - 存储：读取器拒绝比它新的版本；降级后的数据库能重新打开并回到 v4，备份数不变。
- **G064-M2**（集成，补充）：DeepSeek Harness 的补丁文件由 HarnessHub 新建时，移除最后一个服务器后删除文件；原来就有的回到 `[]`；“由 HarnessHub 新建”的记录不进漂移列表。
- **G054-CA7**（浏览器）：
  - 编辑后提示未保存并停用写入，保存只发送文本。
  - 写入的确认框被 cc-switch 阻止，点“我知道，仍然写入”后带上选项重新检查，显示区块差异，只确认这次检查。
  - Cursor 一行提供复制共享指令。

## 第一次真实写入（2026-10-19，审批同意，由我代为执行）

按审批裁决第二节：DeepSeek Harness 与 Codex 各做一次往返，用规定的验证文本，最后保持移除。4317 运行 `0fb4d59`。脚本只打印状态、哈希、权限、大小、计数和标识，不打印任何配置的值。

- **写入前**：
  - 指令视图：dsh 与 Codex 都是“未写入”（`~/.dsh/AGENTS.md`、`~/.codex/AGENTS.md`）。Claude、Codex、Gemini、OpenCode 带 cc-switch 提示，其中 Codex 与 Gemini 另有“0 字节”一句；OpenCode 另有“新建后不再回退”。Cursor、Hermes 不支持；Pi 没有安装，不在列表里。没有漂移。
  - 没有 dsh 进程；`~/.codex/AGENTS.override.md` 不存在；`~/.codex/AGENTS.md` 为 0 字节、0644、单链接。
  - 运行中的 Codex：ChatGPT 应用内置的 2 个，编辑器扩展内置的 1 个。
- **第一次运行（PID 33113）**：
  - 保存验证文本：只改 HarnessHub 的存储，两个文件不变。
  - dsh 的写入（change `8b7346b2`）完全符合计划：
    - 检查的差异只新增区块，第一句是“只改 … 区块”的声明，并写明“下一步就会收到更新”；
    - 新文件 322 字节、0600、本人所有、单链接，字节与计划一致，没有备份（原来没有文件）；
    - 状态“已同步”，没有漂移，`~/.dsh` 里其他条目没有变化。
  - 随后脚本在“dsh 自己读取”这一步停下。原因在我的核对脚本：`loadBaselineInstructions` 返回 `{ text, omitted, truncated }`，脚本把它当成字符串，独立的 node 进程报 TypeError 退出。审批列出的停止条件一条都没有触发。
  - 区块在 `~/.dsh/AGENTS.md` 里留了一段时间，期间没有 dsh 进程运行。
- **接着运行**：
  - 中间脚本保存的登录会话已失效（401），启动口令只能用一次。按惯例确认空闲（没有子进程、没有进行中的管理任务）、APFS 克隆数据后重启，PID 变为 32408；各表行数与重启前一致，克隆随后删除。
  - 续跑先确认现场与停下时相同：验证文本仍在；dsh 仍为“已同步”且字节与计划一致；Codex 未动；台账里只有 dsh 一行。
  - **dsh 的读取**：在禁网、家目录禁写的沙箱里，用独立的 node 进程调用 dsh 0.2.0-rc.2 自带的 `loadBaselineInstructions({ cwd: 空目录, dshHome: ~/.dsh, maxBytes: 65536 })`。渲染结果 633 字节，包含验证句和“Instructions from: ~/.dsh/AGENTS.md”。`~/.dsh/sessions`、`storages` 的条目数为 653、274，与第一次运行时相同。
  - **Codex 的写入**（change `6b124ec7`）：
    - 第一次检查因 cc-switch 阻止，`proceed` 为 `acknowledge-cc-switch`；带上它重新检查后不再阻止。
    - 确认框第一句是声明，写明“有 3 个 Codex 进程在运行”和“新开的 Codex 会话读到”；差异只新增两段的区块。
    - 应用后 399 字节、仍是 0644、单链接，字节与计划一致；有一份 0 字节的备份（0600）。状态“已同步”，没有漂移。
  - 30 秒后两个文件的哈希都没变；没有新的 dsh 进程或 Codex 进程。
  - **移除**：
    - dsh（change `18c1cec6`）：检查写明“会删除这个文件”。应用后文件已删除，留有 322 字节的备份（0600），`~/.dsh` 其他条目没有变化。
    - Codex（change `727e3541`）：回到 0 字节、0644、单链接，哈希与空文件相同，留有 399 字节的备份（0600）。
  - **结束**：
    - 没有漂移，台账里指令记录为 0；历史里四条修改都是“已应用”。
    - 验证文本已清空，HarnessHub 不再保存任何指令文本。
    - 各 Harness 都回到“未写入”或“不支持”。
- **目录对照的口径**：审批的停止条件包括“目标以外的任何文件大小或 mtime 变化”。运行中的 ChatGPT 与编辑器扩展的 Codex 一直在改它们自己的状态文件，所以有两类条目不算 HarnessHub 的改动：
  - 写入前两次相隔 10 秒的目录清单之间就变了的；
  - 名字是运行状态的：`*.sqlite*`、`sessions`、`log`、`logs`、`.tmp`、`tmp`、`cache`、`shell_snapshots`。

  这次被排除的有：`.tmp`、`cache`、`goals_1.sqlite`、`log`、`logs_2.sqlite`（含 `-shm`、`-wal`）、`memories_1.sqlite`、`queue_1.sqlite`（含 `-shm`、`-wal`）、`sessions`、`shell_snapshots`、`state_5.sqlite`、`thread_history_1.sqlite`、`tmp`。其余条目在整个过程中没有变化。`~/.dsh` 没有需要排除的条目。

## DeepSeek Harness 留下的 `[]`（2026-10-19，审批同意，产品流程外的清理）

3c 的第一次真实写入新建了 `~/.dsh/cordis.patch.yml`，移除后留下 `[]`。按审批裁决第三节手工删除，不伪造台账记录；之后 HarnessHub 新建的补丁文件由产品流程自己删除（见上）。

- **删除前核对**：
  - 没有 dsh 进程；文件 3 字节，sha256 前缀 `37517e5f3dc6`，与 `[]\n` 相同；0600、本人所有、单链接，不是链接。
  - 台账里没有 dsh 的 `mcp/` 或 `file/` 记录。
  - 三个 profile 的补丁文件哈希都记下了。
- **删除后**：
  - `dsh --profile acp --dump-config` 退出 0，输出 380 行，没有家目录层，MCP 客户端行为 0，stderr 为空，与 3c 之前相同。
  - profile 的补丁文件不变；没有 dsh 进程。

## 未验证与后续

- **Codex 是否真的读到**：只验证了文件级的契约；会话里能不能读到没有验证，因为没有不建会话的官方核对手段。
- **其余 Harness 的第一次写入**：OpenClaw、Claude Code、Gemini、OpenCode 留给用户在页面上点。审批要求 OpenClaw 的第一次由用户点。
- **页面记住“仍然写入”**：审批允许，但没有做。
- **平台**：只在 macOS 上验证。
