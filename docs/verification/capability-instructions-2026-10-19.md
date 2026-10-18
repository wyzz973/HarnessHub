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
