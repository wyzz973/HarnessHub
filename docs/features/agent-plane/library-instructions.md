# Library 指令集

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 单元：[library.test.ts](../../../packages/agents/test/library.test.ts) 中 7 个有指令文件的 Agent 在空主目录与已有配置中的写入与审阅过的样本逐字节一致，取出后逐字节还原，以及 CRLF、手改区块与 `AGENTS.override.md` 警告；`library-validate.test.ts` 的无效样例；集成：[library.test.ts](../../../tests/integration/library.test.ts) 经正式守护进程与 SDK 增删查改与同步；macOS arm64 本机通过；没有用真实 Agent 确认读到了区块；Windows 未验证 |
| 对照 Magpie | 部分：写在各 Agent 指令文件的受管区块中为相同；“共享文本加每个 Agent 的追加文本”为部分；从 Agent 已有的指令导入未覆盖（[Library](../../magpie-parity.md#library)） |
| 权威文档 | [Library：条目](../../library.md#条目)、[各 Agent 的位置](../../library.md#各-agent-的位置)、[归属与还原](../../library.md#归属与还原)、[API 参考：create_library_instructions](../../api/reference.md#hh_api_v1_create_library_instructions) |

## 用途

在 HarnessHub 中保存一份或几份团队指令（Markdown），同步到各 Agent 自己的用户级指令文件（`CLAUDE.md`、`AGENTS.md`、`GEMINI.md` 等），不再逐个文件复制粘贴。HarnessHub 只占用文件中带标记的一个区块，区块外用户自己的内容不动。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Library 页（`/library`）的指令集：Markdown 编辑与预览、选择去往的 Agent（Kimi 与 Hermes 不可选，已被其他指令集占用的 Agent 不能再选）；写入 Agent 在“同步到 Agent”中进行 |
| 命令行 | `hh library add instructions <id> --file PATH\|- [--name NAME] [--agent A]... [--replace]`；`hh library list instructions`；`hh library show instructions <id>`；`hh library rm instructions <id>`；写入用 `hh library sync` |
| HTTP | `GET`、`POST /api/v1/library/instructions`；`GET`、`PUT`、`DELETE /api/v1/library/instructions/{id}` |

## 已实现的能力

- 保存：文本存为 `<dataDir>/library/instructions/<id>.md`，索引记录名称、SHA-256、大小与去往的 Agent；CRLF 转为 LF，最多 256 KiB。
- 校验：id 为 1 到 63 个小写字母、数字与连字符；名称可选（缺省为 id，最多 200 字符）；未知字段被拒绝。
- 一个 Agent 只能有一套：登记时若某个 Agent 已经去往另一套指令集，为 409 `LIBRARY_CONFLICT`；Kimi 与 Hermes 没有用户级指令文件，指定它们为 400 `LIBRARY_UNSUPPORTED`。
- 新增与替换：`POST` 遇到已有 id 为 409 `LIBRARY_EXISTS`，`PUT`（命令行 `--replace`）才替换；`add` 只改 Library，不改 Agent 文件。
- 去往：Claude Code 的 `<配置目录>/CLAUDE.md`、Codex 的 `<CODEX_HOME>/AGENTS.md`、Gemini CLI 的 `~/.gemini/GEMINI.md`、Qwen Code 的 `~/.qwen/QWEN.md`、OpenCode 的 `<配置目录>/AGENTS.md`、Pi 的 `~/.pi/agent/AGENTS.md`、Crush 的 `crush/CRUSH.md`；配置目录遵循 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME` 等变量，与全局接线一致。
- 受管区块：同步只写 `<!-- harnesshub:begin id=<id> sha=<SHA-256> -->` 与 `<!-- harnesshub:end -->` 之间的一个区块，接在用户内容之后、以空行分隔；区块外不动，CRLF 文件保持 CRLF。
- 手改检测：区块内容与标记中的哈希不符时，同步给出警告，再替换或移除它。
- Codex 的覆盖文件：`<CODEX_HOME>/AGENTS.override.md` 存在时警告，因为 Codex 读它而不读 `AGENTS.md`。
- 删除：`hh library rm instructions <id>` 只从 Library 删除，下一次同步从 Agent 文件中取出区块；文件仍是上次写入的样子时写回原始字节（原本不存在的文件被删除）。
- 备份与同步：指令集随加密备份保存与恢复，并作为同步的 `library` 部分在多台机器间合并。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [library/validate.ts](../../../packages/agents/src/library/validate.ts)（`parseInstructionSet`）、[library/store.ts](../../../packages/agents/src/library/store.ts)（`putInstructionSet`）、[library/targets.ts](../../../packages/agents/src/library/targets.ts)、[library/sync.ts](../../../packages/agents/src/library/sync.ts)、[library-service.ts](../../../packages/daemon/src/library-service.ts)、[library-routes.ts](../../../packages/daemon/src/http/library-routes.ts)、[cli/library.ts](../../../packages/cli/src/library.ts)、[library-page.tsx](../../../packages/console/components/library-page.tsx) |
| 测试 | [packages/agents/test/library.test.ts](../../../packages/agents/test/library.test.ts)、[library-golden.ts](../../../packages/agents/test/library-golden.ts)、[library-validate.test.ts](../../../packages/agents/test/library-validate.test.ts)、[tests/integration/library.test.ts](../../../tests/integration/library.test.ts) |
| 决策 | 无专门的 ADR；设计见 [04 第 8 节](../../proposals/oss/04-agent-plane.md#8-library) |

## 已知限制与未验证

- 只覆盖 Library 的 9 个 Agent 中有用户级指令文件的 7 个；Kimi 与 Hermes 没有指令文件。
- 每个 Agent 只能有一套，没有“共享文本加每个 Agent 的追加文本”。
- 没有项目级放置（04 设计的 `hh library project add`）、版本历史接口，也不能从 Agent 已有的指令文件导入。
- 没有用真实 Agent 确认它读到了区块中的内容；Qwen Code 的位置在 [Library](../../library.md#各-agent-的位置) 中仍有“待核”的项；Windows 未验证。

## 优化候选

- **现状**：一个 Agent 一套指令，要给某个 Agent 多加几句只能另建一套并改去往。**方向**：一份共享文本加每个 Agent 的追加文本，写进同一个区块。**依据**：对照表 “One shared text plus extra text per agent”（partial）。
- **现状**：只写用户级文件。**方向**：实现显式开启的项目级放置，写入项目的指令文件并把条目加入 `.git/info/exclude`。**依据**：[Library 现状](../../library.md)“尚未实现：项目级放置”；[04 第 8 节](../../proposals/oss/04-agent-plane.md#8-library)。
- **现状**：已有的 `CLAUDE.md`、`AGENTS.md` 内容不能导入 Library。**方向**：从选定 Agent 的指令文件导入为指令集（预览后确认），原文件保持不变。**依据**：对照表 “Importing existing MCP servers, skills and instructions from agents and CC Switch”（not covered）。
- **现状**：`--agent all` 展开为 Library 的全部 9 个 Agent，其中 Kimi 与 Hermes 不接受指令集，整条登记因此以 `LIBRARY_UNSUPPORTED` 失败。**方向**：对指令集把 `all` 解释为能接受它的 Agent，或在错误中给出可用的列表。**依据**：阅读 [cli/library.ts](../../../packages/cli/src/library.ts) 的 `agents()` 与 `parseAgents` 的观察，未实际运行。
