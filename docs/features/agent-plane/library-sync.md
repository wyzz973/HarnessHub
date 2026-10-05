# Library 同步到 Agent

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 单元：[library.test.ts](../../../packages/agents/test/library.test.ts) 中 9 个 Agent 在空主目录与已有配置中的写入结果与[审阅过的样本](../../../packages/agents/test/library-golden.ts)逐字节一致、再次计划没有改动，全部取出后已有文件逐字节还原、空主目录恢复为空，用户改动后的取出、预览后文件被改、提交失败后的恢复、目录变量与配置目录改变；集成：[library.test.ts](../../../tests/integration/library.test.ts) 经正式守护进程与 SDK 同步与还原、无接线目录时 503、`hh library` 的确认与退出码 5，[backup-library.test.ts](../../../tests/integration/backup-library.test.ts) 覆盖恢复与同步带入后写入 Agent；macOS arm64 本机通过；没有用真实 Agent 确认读到写入的内容；Windows 未验证 |
| 对照 Magpie | 部分：记录写入的内容、备份文件、只移除自己的部分为相同；只覆盖 9 个 Agent、没有 WSL 为部分；终端界面中的 Library 页与 `S` 同步未覆盖；`hh backup` 不能不含 Library 为部分（[Library](../../magpie-parity.md#library)、[Terminal UI and console](../../magpie-parity.md#terminal-ui-and-console)、[Backup and sync](../../magpie-parity.md#backup-and-sync)） |
| 权威文档 | [Library：使用](../../library.md#使用)、[归属与还原](../../library.md#归属与还原)、[各 Agent 的位置](../../library.md#各-agent-的位置)、[接口](../../library.md#接口)、[API 参考：apply_library_sync](../../api/reference.md#hh_api_v1_apply_library_sync) |

## 用途

把 Library 中的指令集、MCP 服务与 Skills 写进各 Agent 自己的文件与目录，并在条目删除或改去往后再取出。写入方式与全局接线相同：先预览，确认后备份、原子写、回读校验；HarnessHub 只拥有自己写入的部分，用户之后的改动不会被覆盖。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Library 页的“同步到 Agent”（`/library?tab=sync`）：选择 Agent、是否允许写入明文秘密、是否复制 Skill；先预览每个文件的 diff、Skill 的放置、被拒绝的条目与警告，确认后按这份预览写入 |
| 命令行 | `hh library sync [agent]...`（`--dry-run` 只打印改动、`--allow-plaintext-secret`、`--copy`、`--yes`）；Agent 为 `claude`、`codex`、`gemini`、`qwen`、`opencode`、`pi`、`crush`、`kimi`、`hermes` |
| HTTP | `POST /api/v1/library/sync/plan`（`agents`、`allowPlaintextSecret`、`placement: auto\|copy`）；`POST /api/v1/library/sync/apply`（另需 `expect`，预览响应即可） |

## 已实现的能力

- 范围：Claude Code、Codex、Gemini CLI、Qwen Code、OpenCode、Pi、Crush、Kimi Code、Hermes Agent 九个 Agent，每个 Agent 得到去往它的条目；`hh library sync` 与 API 不给 Agent 时同步全部九个，控制台默认勾选本机已安装的。
- 预览只读：同样的条目、状态与文件得到同样的计划，已同步的 Agent 为 `changed: false`；计划中秘密值显示为 `<secret>`。
- 按预览写入：应用时在每个 Agent 的锁内重新计划并核对 `expect`，文件在预览后被改动时为 409 `LIBRARY_CONCURRENT_MODIFICATION`，该 Agent 什么都不写（`hh library sync` 以 5 退出）；非交互且没有 `--yes` 时以 4 退出。
- 部分拒绝：有条目被某个 Agent 拒绝（同名冲突、不支持的传输、需要明文同意的秘密）时其余照常写入，命令以 5 退出并列出被拒绝的条目。
- 逐个 Agent 提交：每个 Agent 写完即把状态写入 `<dataDir>/library/applied.json`（写入了哪些条目、写后的哈希与为此创建的目录）；写入、回读或提交失败时该 Agent 已写的内容恢复为写前字节，并停止，之前的 Agent 保持已同步。
- 备份：每个文件第一次改动前把原始字节存入 `<dataDir>/backups/wiring/library-<agent>/`。
- 取出与还原：某个文件中不再有 HarnessHub 的内容时，文件仍是上次写入的样子就写回原始字节（原本不存在的文件被删除），否则只取出自己的区块与条目、保留用户之后的改动；为放置而创建、已经为空的目录被删除。
- 配置目录改变（如 `CODEX_HOME` 换了）后再同步，旧位置逐字节还原、新位置写入。
- 与全局接线共用每个 Agent 的锁（`<dataDir>/backups/wiring/<agent>/.lock`），两者不会同时改写同一 Agent。
- 接线目录：使用 `hh serve` 的接线目录（主目录或 `--wiring-home`）；没有接线目录时条目照常增删，同步返回 503 `AGENT_WIRING_UNAVAILABLE`。
- 与备份、同步的衔接：`hh restore` 带入 Library 后提示同步到本机已安装的 Agent；开启了 Agent 接线同步时，同步带入的 Library 直接写入已安装的 Agent（不写秘密值）。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [library/sync.ts](../../../packages/agents/src/library/sync.ts)（`planLibrarySync`、`applyLibrarySync`）、[library/targets.ts](../../../packages/agents/src/library/targets.ts)（`libraryTarget`）、[library-service.ts](../../../packages/daemon/src/library-service.ts)、[library-routes.ts](../../../packages/daemon/src/http/library-routes.ts)、[library-backup.ts](../../../packages/daemon/src/library-backup.ts)、[cli/library.ts](../../../packages/cli/src/library.ts)、[library-sync.tsx](../../../packages/console/components/library-sync.tsx) |
| 测试 | [packages/agents/test/library.test.ts](../../../packages/agents/test/library.test.ts)、[library-golden.ts](../../../packages/agents/test/library-golden.ts)、[tests/integration/library.test.ts](../../../tests/integration/library.test.ts)、[backup-library.test.ts](../../../tests/integration/backup-library.test.ts) |
| 决策 | 无专门的 ADR；设计见 [04 第 8 节](../../proposals/oss/04-agent-plane.md#8-library)，与 06 第 3 节接口设计的差异见 [Library：接口](../../library.md#接口) |

## 已知限制与未验证

- 只有 9 个 Agent，远少于全局接线的 28 个与 Magpie 的约 30 个，没有 WSL 中的 Agent。
- 没有用真实 Agent 确认它们读到了写入的指令、MCP 服务与 Skills；Qwen Code 的部分位置与格式仍标为“待核”；Windows 未验证。
- 应用逐个 Agent 进行，中途失败时之前的 Agent 已同步，不是跨 Agent 的事务。
- 接口按条目类型分开，计划由客户端带回核对，没有 ETag/`If-Match` 与 `Idempotency-Key`。
- `hh library sync` 与 API 不给 Agent 时同步全部 9 个，不看 Agent 是否已安装，条目去往未安装的 Agent 时会在它的目录下新建文件；控制台默认勾选、恢复与同步带入时只写已安装的 Agent。
- `hh tui` 没有 Library 页；`hh backup` 不能不含 Library，同步也总是包含 Library。
- 没有项目级放置；Profile 中没有 Library 选择。

## 优化候选

- **现状**：`hh library sync` 与 API 不给 Agent 时对 9 个 Agent 全部计划，未安装的 Agent 也会被写入，而控制台与恢复只选已安装的。**方向**：命令行与 API 的缺省也只同步已安装或只有配置目录的 Agent，显式点名的 Agent 照旧写入。**依据**：阅读 [library/sync.ts](../../../packages/agents/src/library/sync.ts) 的 `selected`、[backup.ts](../../../packages/daemon/src/backup.ts) 的 `installedLibraryAgents` 与 [library-sync.tsx](../../../packages/console/components/library-sync.tsx) 默认勾选的观察。
- **现状**：Library 只到 9 个 Agent。**方向**：按全局接线已有的 Adapter 目录逐个补上指令、MCP 与 Skills 的位置（先从 MiMo Code、OmO 等复用核心 Agent 格式的开始）。**依据**：对照表 “About 30 agents plus WSL twins”（partial）。
- **现状**：终端界面只有 Agent 页。**方向**：在 `hh tui` 中加入 Library 页与 `S` 同步键，复用同一份预览。**依据**：对照表 “Other terminal pages … `S` to sync”（not covered）。
- **现状**：备份总是带 Library。**方向**：增加 `hh backup --no-library` 与同步的 `library=no`。**依据**：对照表 Backup and sync 中 `--no-library` 与 settings part 两行（partial）。
- **现状**：没有用真实 Agent 验证读取。**方向**：在一致性套件中加入 Library 用例：同步一个指令区块、一个 stdio MCP 服务与一个 Skill，让 Agent 在沙箱中报告读到的内容。**依据**：[Library 现状](../../library.md)“没有用真实 Agent 验证它们读到了写入的内容”。
