# 全局接线

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 单元（`packages/agents/test/wiring-*.test.ts`：格式、安全、回滚、托管配置）与集成（经 `startHub`、临时 `wiringHome` 与严格假上游的 `agents-wiring*.test.ts`、`codex-chatgpt-key.test.ts`、`agents-keypath.test.ts`、`tui.test.ts`），在本机 macOS arm64 的 `pnpm check` 中通过；7 个真实 Agent 在 macOS Seatbelt 沙箱中以假上游跑过一致性套件，5 个经真实 DeepSeek 跑过（见[兼容性](../../compatibility.md#结果)）；用户真实配置中的端到端未做；Windows 未验证 |
| 对照 Magpie | 部分：格式保真编辑、一个 Agent 的多个文件一起写入、还原、Claude Code 托管配置为相同；漂移检测、只在 Agent 运行时提示重启为部分；按 Key 而不是 User-Agent 识别调用方为有意不同（[Agents and wiring](../../magpie-parity.md#agents-and-wiring)、[One key per agent](../../magpie-parity.md#one-key-per-agent)） |
| 权威文档 | [全局接线](../../global-wiring.md)、[备份与安全](../../global-wiring.md#备份与安全)、[格式保真编辑](../../global-wiring.md#格式保真编辑)、[库接口](../../global-wiring.md#库接口)、[API 参考：list_agents](../../api/reference.md#hh_api_v1_list_agents) |

## 用途

把本机已安装的编码 Agent 改为经 HarnessHub 网关调用模型：直接改写 Agent 自己的用户配置，写入只属于这个 Agent 的 Gateway Key 与所选模型。写入前先给出带掩码 Key 的 diff，写入有备份、原子写与回读校验，随时可以还原；用户之后手改了文件，会以漂移的形式报告出来。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Agent 首页（`/`）：点模型 → 选择器 → 预览 diff → 确认写入；行上的漂移、“需要处理”与“被托管设置覆盖”标记，还原。详情 `/?agent=<id>`：档位、effort、选项、换 Key、暂停与恢复 Key、配置文件与逐项漂移 |
| 命令行 | `hh agents`；`hh wire <agent> [model]`（`--tier`、`--effort`/`--no-effort`、`--option`、`--models`、`--no-model`）；`hh wire <agent> --rotate`；`hh use <agent> <model>`；`hh unwire <agent>`；`hh tui`；`hh serve --wiring-home DIR` |
| HTTP | `GET /api/v1/agents`、`GET /api/v1/agents/{id}`、`POST /api/v1/agents/{id}/wiring/plan`、`POST /api/v1/agents/{id}/wiring`、`POST /api/v1/agents/{id}/wiring/rotate`、`DELETE /api/v1/agents/{id}/wiring` |

## 已实现的能力

- 预览只读：`planWiring` 返回每个文件的键级变更与统一 diff；新 Key 显示为 `hhk_a_xxxx…`，被替换的旧 Key 显示为 `<redacted>`，dotenv 不带上下文行，HarnessHub 生成的整个文件（Codex 的模型目录）只显示大小。预览用一把不保存的临时 Key，不签发 Key、不写文件。
- 按确认过的预览写入：`POST …/wiring` 必须带 `expect`；文件在预览之后被改动时为 409 `WIRING_CONCURRENT_MODIFICATION`，新 Key 被吊销、什么都不写。`hh wire` 此时以 5 退出；非交互且没有 `--yes` 时以 4 退出。
- 每个 Agent 一把 Key：每次接线签发新的 `agent:<id>` 作用域 Key（不过期），Key 文本只写进 Agent 的文件，存储中只有哈希；文件写入、回读与 `WiringRecord` 提交之后才吊销上一把，任何一步失败都吊销新 Key。
- 换 Key：`hh wire <agent> --rotate` 以当前选择重新接线，旧 Key 立即失效；ADR 0030 之前接线、没有 Key 的 Codex ChatGPT 模式记录由此得到第一把 Key。
- 暂停 Key：`hh key suspend <keyId>` 之后该 Agent 的请求得到 401 `key_suspended`，视图的 `keyState` 为 `suspended`，文件不变，`hh key resume` 恢复。
- 备份：每个文件第一次改动前，原始字节存入 `<dataDir>/backups/wiring/<adapterId>/objects/<sha256>`；清单记录原文件是否存在、权限、新建的目录、HarnessHub 拥有的键与写入值的模板（Key 与基址为占位符，清单中没有 Key），均为 0600，读取时校验哈希。
- 原子写：同目录临时文件、fsync、保留原权限、rename 前再核对哈希、目录 fsync；新文件 0600、新目录 0700；符号链接写其目标，多个硬链接时原地写；中断留下的临时文件在下次写入前清理。
- 回读校验：写入后用真实解析器确认每个目标键的值，并确认去掉这些键后文档与写前相同；任一步失败，已写文件恢复为写前字节，写入之后又被别人改动的文件保持原样并在 `rollback` 中报告为未恢复。
- 格式保真：JSON/JSONC、TOML、YAML、dotenv 按键编辑，保留注释、键顺序、缩进、BOM 与换行风格；数组元素选择器让 HarnessHub 在用户自己的数组中只拥有它写入的元素。
- 拒绝写入：无法解析或不是 UTF-8 的文件、经符号链接离开 home（或 Agent 目录变量所指目录）的路径、悬空或循环链接、目标键的上级是非对象值，以及各格式不支持的结构；错误信息只含路径、键路径与行列号，不含文件内容。
- 还原：`hh unwire` 在文件哈希等于写后哈希时写回原始字节（接线新建的文件连同为它新建且仍为空的目录被删除），否则只恢复 HarnessHub 写过的键；之后吊销 Key、删除记录；失败时记录与 Key 保留，可以重试。例外是 Codex 留下不带 Key 的 `[model_providers.harnesshub]`，结果的 `kept` 列出它。
- 漂移检测：`detectDrift` 只读，报告 `unwired`（基址或 Key 字段缺失、换成别的 Key）、`foreign-gateway`（基址指向别处）与 `replaced`（写过的其他字段被改，或删除的条目又出现）；`hh agents` 的 DRIFT 列、`hh tui` 与控制台显示它。
- 重启提示：`restartNotice(adapter)` 是唯一来源。Claude Code 与 Codex 有自己的说明，WorkBuddy 与 T3 Code 自己读取改动、没有提示，其余为“重启正在运行的 <Agent> 会话”；出现在预览、`GET /api/v1/agents` 的 `notice`、CLI、`hh tui` 与控制台，同一段文字只打印一次。
- Claude Code 托管配置：只读取各平台的 `managed-settings.json`；它设置了接线写入或删除的同一项时，预览的 `managed`、视图的 `wiring.managed`、`hh wire`、`hh tui`（`! managed`）与控制台列出文件与被覆盖的项。无法解析、不是普通文件或超过 1 MiB 时报告为无法读取，先 `lstat`、不跟随链接、不等待管道，从不写入。
- 串行与锁：接线、换 Key、隐藏模型、Profile、目录同步与还原在守护进程内串行；库对每个 Adapter 另有跨进程锁（`<dataDir>/backups/wiring/<adapterId>/.lock`，`owner.json` 记录 pid），已被持有时立即以 409 `WIRING_BUSY` 失败，Library 同步共用同一把锁。
- 接线目录：`hh serve` 以当前用户的主目录与环境为接线目录，`--wiring-home DIR` 改用另一个目录并忽略 shell 中的 `CODEX_HOME` 等变量；未给 `wiringHome` 的 `startHub`（测试与嵌入）对全部接线操作返回 503 `AGENT_WIRING_UNAVAILABLE`，不回落到账户的主目录。
- 安装检测：`detectAgent` 只看 PATH 与 Adapter 的配置目录，不执行 Agent；cmux 包装器所在目录不算已安装。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码（库：计划、写入、还原、漂移） | [operations.ts](../../../packages/agents/src/wiring/operations.ts)（`planWiring`、`applyWiring`、`unwire`、`detectDrift`）、[files.ts](../../../packages/agents/src/wiring/files.ts)（原子写与锁）、[backups.ts](../../../packages/agents/src/wiring/backups.ts)、[diff.ts](../../../packages/agents/src/wiring/diff.ts)、[formats/](../../../packages/agents/src/wiring/formats/index.ts) |
| 源码（安装检测、托管配置） | [detect.ts](../../../packages/agents/src/wiring/detect.ts)（`detectAgent`）、[managed.ts](../../../packages/agents/src/wiring/managed.ts) |
| 源码（守护进程与入口） | [agents-wiring.ts](../../../packages/daemon/src/agents-wiring.ts)、[agents-routes.ts](../../../packages/daemon/src/http/agents-routes.ts)、[cli/agents.ts](../../../packages/cli/src/agents.ts)、[tui/app.ts](../../../packages/cli/src/tui/app.ts) |
| 源码（控制台） | [agents-page.tsx](../../../packages/console/components/agents-page.tsx)、[agent-detail.tsx](../../../packages/console/components/agent-detail.tsx)、[wire-plan-dialog.tsx](../../../packages/console/components/wire-plan-dialog.tsx) |
| 测试（集成） | [agents-wiring.test.ts](../../../tests/integration/agents-wiring.test.ts)、[agents-wiring-details.test.ts](../../../tests/integration/agents-wiring-details.test.ts)、[codex-chatgpt-key.test.ts](../../../tests/integration/codex-chatgpt-key.test.ts)、[tui.test.ts](../../../tests/integration/tui.test.ts) |
| 测试（单元与一致性） | [wiring-safety.test.ts](../../../packages/agents/test/wiring-safety.test.ts)、[wiring-formats.test.ts](../../../packages/agents/test/wiring-formats.test.ts)、[wiring-rollback.test.ts](../../../packages/agents/test/wiring-rollback.test.ts)、[wiring-claude-managed.test.ts](../../../packages/agents/test/wiring-claude-managed.test.ts)、[conformance/agents.test.ts](../../../tests/conformance/agents.test.ts) |
| 决策 | [ADR 0022 Agent 的模型列表、无 Key 接线与接线 Profile](../../decisions/0022-agent-wiring-semantics.md)、[ADR 0028 终端界面](../../decisions/0028-terminal-ui.md)、[ADR 0030 Codex 的 ChatGPT 模式](../../decisions/0030-codex-chatgpt-mode-models.md)、[ADR 0033 路径中的 Key](../../decisions/0033-gateway-key-in-path.md) |

## 已知限制与未验证

- 大多数 Adapter 没有用真实 Agent 读取接线后的配置；一致性套件只覆盖本机装有的 7 个（Codex 的 Tools 为 partial），且只在有 Seatbelt 的 macOS 上运行，Linux 与 Windows 上整个套件跳过。
- 用户真实配置中的端到端（改写所有者的真实文件）、以 ChatGPT 登录的 Codex 与 Windows 均未验证（[TODO.md](../../../TODO.md) 的“未验证”条目）；Windows 上 rename 遇共享冲突的重试与托管配置的 Windows 路径只有代码与单元测试。
- 漂移没有 `bypassed`（Agent 绕过网关）与 `stale-key`，二者需要网关账本；基址不同一律为 `foreign-gateway`，不区分另一台 HarnessHub。
- 备份的首个版本永久保留，“其余保留 20 份”的清理未实现。
- 持有者崩溃留下的 `.lock` 需要在确认 `owner.json` 中的进程已退出后手工删除，之前该 Agent 的接线、还原与 Library 同步都返回 `WIRING_BUSY`。
- 接线前不检查 Agent 是否正在运行；重启提示总是给出。
- 每次接线都签发新 Key，所以对已接线的 Agent 预览时，即使模型不变，Key 一项也显示为改动。
- Shell 环境中已有的同名变量优先于 dotenv（Gemini、Qwen），`OPENCODE_CONFIG_DIR` 等也会覆盖全局文件；这类绕过接线无法发现。设置了代理变量时 Gemini CLI 把发往回环网关的请求也交给代理（[Gemini CLI 与代理](../../global-wiring.md#支持的-agent)）。
- “rename 前被并发修改”之外的写后篡改注入测试未做（[04 第 9 节](../../proposals/oss/04-agent-plane.md#9-一致性测试)第 6 项）。

## 优化候选

- **现状**：崩溃留下的 Adapter 锁只能手工删除，期间该 Agent 的一切写入以 `WIRING_BUSY` 失败。**方向**：读取 `owner.json` 的 pid 与启动时间，确认持有者已退出后自动回收，或提供显式的清理命令并在错误中给出。**依据**：[备份与安全](../../global-wiring.md#备份与安全)；阅读 `withAdapterLock` 的观察（锁被占用时不等待、不判断持有者）。
- **现状**：备份对象与清单只增不减。**方向**：实现首版永久保留、其余保留 20 份的清理，并说明清理不影响逐字节还原。**依据**：[备份与安全](../../global-wiring.md#备份与安全)、[与 04 的差异与待做](../../global-wiring.md#与-04-的差异与待做)。
- **现状**：漂移只能发现文件被改，发现不了 Agent 实际没走网关。**方向**：按网关账本中各 `agent:` Key 的最近调用实现 `bypassed` 与 `stale-key`。**依据**：[对照表 Drift 一行](../../magpie-parity.md#agents-and-wiring)（partial）、[与 04 的差异与待做](../../global-wiring.md#与-04-的差异与待做)。
- **现状**：重启提示总是给出，接线前也不检查 Agent 是否在运行。**方向**：按平台判断 Agent 进程是否在运行，只在运行时提示，并在接线前提醒。**依据**：[对照表 restart notice 一行](../../magpie-parity.md#agents-and-wiring)（partial）、[ADR 0022 补充](../../decisions/0022-agent-wiring-semantics.md#补充还原后留下的条目托管配置与重启提示2026-10-05)中记录的代价。
- **现状**：真实用户配置与 Windows 上没有证据。**方向**：由所有者在真实配置上执行一次接线、使用与还原；在 Windows 上补跑接线与托管配置用例。**依据**：[TODO.md](../../../TODO.md) 的“未验证”条目。
