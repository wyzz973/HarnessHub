# ADR-046：聚焦七个 Harness 的工程加固切片

状态：accepted，2026-10-21。方向由用户 2026-10-21 的指令决定：只支持 Claude Code、Codex、OpenCode、DeepSeek Harness、WorkBuddy、Hermes Agent 六个并做精；用户同日补充：OpenClaw 保留并加入接入清单，焦点 Harness 共七个。切片划分、六项加固的边界与对 ADR-001～007 的处置由总指挥兼用户授权的审批代理（Fable 5.1）裁决，裁决见文末。范围收窄的用户待决项（非焦点三个的处置、WorkBuddy 接入路线等）另见 [ADR-048](0048-harness-scope-and-workbuddy.md)（proposed）；第一批加固不被它阻塞。

## 背景

用户的指令（2026-10-21）：

> 现在就支持一下最流行的几个harness， claude code， codex， opencode， deepseek harness， work buddy， hermes agent。我们把这些适配好，做精。我需要你对我们的harnesshub的整体架构，代码架构，规范，可拓展性，性能，审计，都要有全面的把控！

总指挥在 440ba52 上做了一轮只读评估：没有运行任何 Harness，没有读凭据，没有触碰 4317 上运行的服务。与本切片直接相关的事实如下，均按 file:line 复核过：

- **已验证版本表与本机脱节。** `src/infrastructure/management/verified-versions.ts:13` 把 Claude Code 记为 `2.1.296`，本机是 2.1.306（nvm，当前使用）与 2.1.302（npm，Homebrew 前缀）；`:21` 把 dsh 记为 `0.2.1-alpha.1`，本机是 npm 官网的 0.2.0-rc.2（2026-10-18 经 4317 安装）。`src/adapters/catalog.ts:35` 的 dsh 包版本也还是 `0.2.1-alpha.1`。选择器因此把两个焦点 Harness 都标为“未经验证的版本”。（2026-10-22 按 [ADR-053](0053-latest-version-baseline.md) 删除：这张表与这条提示都不存在了，`verified-versions.ts` 只剩续接命令表，版本只作证据；见文末补记。）
- **dsh 的读表区间按 semver 不含 0.2.0-rc.2。** `src/adapters/capability-reads.ts:296` 写 `>=0.2.0 <0.3.0`，`src/infrastructure/capabilities/scan.ts:804-805` 以 `satisfies(…, { includePrerelease: true })` 判定；按 semver，预发布版本 `0.2.0-rc.2` 小于 `0.2.0`，所以能力页把本机 dsh 标为“未核实”。同一台机器上，选择器说“未经验证”，能力页说“未核实”，两套版本语义并存。（2026-10-22 按 ADR-053 修订：读表不再有版本区间，只记 `checkedOn`；“未核实”与“未经验证”两种提示都已删除，两套语义不再存在；见文末补记。）
- **dsh 的继续命令有一条不成立。** `verified-versions.ts:69` 给 dsh 的交互命令是 `dsh tui --resume`；总指挥只读核对本机安装的 `dsh-app-boot/lib/index.js`，rc.2 发运的 profile 只有 acp、web、headless、sdk、sdk-minimal，没有 tui，对不存在的 profile 直接抛错。
- **Hermes 的版本读不到。** Hermes 是官方脚本渠道，`src/infrastructure/discovery/installation-channels.ts` 的 `script` 分支只认 `…/versions/<版本>` 的布局，Hermes 没有这种布局，所以版本恒为 null；而它的 venv 里有 `site-packages/hermes_agent-0.12.0.dist-info`，能给出版本。
- **失败的写入记录带家目录绝对路径。** `src/infrastructure/capabilities/changes.ts:680`、`:959` 与 `skill-changes.ts:490` 把 Node 的 `failure.message` 原文持久化；`src/web/server.ts:393-394` 的 `privateJson` 一旦在应答里发现家目录形式的路径就回 500 `PRIVACY_GUARD`。只要出过一次这样的失败，“修改与备份”视图就永久 500。
- **每个文本块一次整份快照事务。** `src/contexts/session/application/runtime.ts:1121-1147` 对每个 text 或 thinking 块各提交一次，并产生一条 `run.output` 事件；`src/infrastructure/session/sqlite-store.ts:304-324` 的 `transact` 每次重读会话、整份 `JSON.stringify` 写回。合成测量：1 MB 会话每块 7.8 ms；每会话 16,384 条事件的上限（`src/contexts/session/domain/state.ts:18`）在长回复十几轮后就能逼近。
- **G063 从未落地。** `plan/tasks.json` 的 G063（依赖与公共类型边界检查）仍是 planned，`tools/` 下没有 `check-boundaries.mjs`；`src/contracts/control.ts:1-2`、`src/contracts/management.ts:1` 反向导入 `contexts/catalog/domain`，没有工具拒绝它。
- **两项控制层缺口。** claude-agent-acp 0.89.1 推送 `_auth/status_update`，`src/adapters/control/acp.ts:542` 把它记成“Unsupported ACP notification”诊断，Claude 的就绪状态因此恒为 unknown；OpenCode 1.18.35 的 ACP 模块含隐藏的 `compact` 命令（调用 `session.summarize`），`src/adapters/control/opencode.ts` 没有接它，矩阵里“只能在原 TUI 压缩”的注记已过期。
- **非焦点的 Harness。** 评估时是四个（Cursor、Gemini CLI、OpenClaw、Pi）。用户同日把 OpenClaw 加回接入清单：本机 OpenClaw 网关正在运行并接着消息渠道，ADR-027/028 的真实验证来自它，本机安装 2026.3.23-2（npm 全局，Homebrew 前缀）就是已验证版本。余下三个（Cursor、Gemini CLI、Pi）中，仓库唯一的 A→B→A 真实切换证据是 codex↔gemini；ADR-044 第 6 条承诺历史对话保留。删除它们不可逆。

## 决定

建立切片 **harness-focus**（`plan/slices.json`，decision 指向本文件）。任务 G065“六焦点工程加固（ADR-046）”与 G063 归入它。第一批承接下面六项加固，彼此文件不重叠，可并行：

1. **版本单一来源与一致性检查。**
   - 一个 Harness 的已验证版本、目录里的包版本与读表区间来自同一来源，并有测试把三者绑在一起；版本比较用预发布语义，`0.2.0-rc.2` 不再被 `>=0.2.0` 排除。
   - Hermes 的脚本渠道从 venv 的 `dist-info` 读版本。
   - dsh 的继续命令只保留 headless（`dsh headless --session-id <id> …`）；交互命令在有真实回合验证前不给。
   - dsh 的读表区间按 ADR-045 第 3c 步与第 4 步在 rc.2 上的真实往返记录改为覆盖 rc.2。
   - `VERIFIED_VERSIONS` 的数字在真实重验收前不改：Claude 仍为 2.1.296，dsh 仍为源码版的 0.2.1-alpha.1（按 ADR-044 为历史证据）。界面照 ADR-038 提示，不冒充验证。
   - 2026-10-22 起本项被 [ADR-053](0053-latest-version-baseline.md) 取代：`VERIFIED_VERSIONS`、`versionConsistency` 与读表的 semver 区间删除，版本只作工程证据（矩阵 `installation`、验收记录、读表 `checkedOn`）；“界面照 ADR-038 提示”不再成立，任何版本都不提示；Hermes 的版本改从 `install-stamp.json` 读（0.12 布局没有 stamp 时仍退回 dist-info；第三批 D4）；dsh 的一次性命令对任何版本给出并附凭据前提。本项在第一批里做过的事（预发布语义、dist-info 版本、headless 命令、rc.2 读表）作为当时的加固保留记录。
2. **失败的写入记录只存错误码与 `~` 形式的路径。** `/api/v1/capabilities/history` 逐条降级：一条坏记录只让那一条显示为无法读取，不让整页 500；公开错误消息把家目录替换为 `~`。
3. **流式输出按窗口合并提交。** 独立为 ADR-047（`0047-stream-output-coalescing.md`，由并行任务撰写）：每回合的事件数与提交成本降一个量级；先提交再发布（INV-06）与断线不取消（INV-19）不变。
4. **G063 落地。** `tools/check-boundaries.mjs` 加 `tools/boundary-rules.json`，纳入 `pnpm check`；含“组合应用或启动 Gateway 的测试必须用自己的临时租约目录”这一条静态规则（`docs/engineering/testing.md` 第 4 节此前只有人工审查）；每条规则有无效 fixture 证明会被拒绝。
5. **控制层打磨。** `ClaudeControl` 读 `_auth/status_update`，把认证状态接到就绪状态；`OpenCodeControl` 在 1.18.x 补 `/compact`；`AcpControl` 给子类一个扩展通知钩子，通用层不按 Harness 分支。（2026-10-22 按 [ADR-053](0053-latest-version-baseline.md) 修订：`/compact` 在 OpenCode 的命令目录未列出时对任何版本补入，不再限 1.18.x；回合以 end_turn 结束却没有任何回复、工具或活动时判为原程序没有执行并明确失败；1.18.35 上的真实通过只作证据。）
6. **非焦点的三个即日冻结。** Cursor、Gemini CLI、Pi 不再新增矩阵 ✅、不更新已验证版本、不承接新能力；适配器、测试与历史真实证据保留。是否默认隐藏或删除由用户在 ADR-048 决定。OpenClaw 按用户同日的补充归入焦点，不冻结；它的 Gateway 与 Node 仍只按 ADR-043 经用户确认的升级流程重启，验收不重启它们。

第一批不写用户的任何真实 Harness 配置，不运行任何 Harness 做验收。真实重验收（Claude 2.1.306、dsh 0.2.0-rc.2）是后续批次，需要用户同意后在 4317 进行。

## 否决方案与代价

- **直接把 `VERIFIED_VERSIONS` 改成本机版本。** 否决：那是“已验证”表，没有真实回合就改等于伪造证据（AGENTS.md：不把 Agent 回复或 exit 0 当作达标证据）。代价是界面继续提示“未经验证”，直到重验收。（2026-10-22：ADR-053 删除了这张表，这条取舍不再适用；版本只作证据，界面不再提示。）
- **把读表区间也改成精确版本。** 否决：读表描述的是文件格式随版本的变化，区间才是它的自然表达。保留两种表达，但统一来源与比较规则。
- **先做描述模块重构（每个 Harness 一个描述文件），再修版本与审计。** 否决：重构牵动约 35 个文件和 6 个被多切片共有的大文件，与第一批互斥；版本、审计记录和流式提交是“每家都依赖”的修复，先做。
- **删除非焦点三个。** 不在本记录决定：不可逆，且牵动真实证据（codex↔gemini 的 A→B→A 切换），见 ADR-048。
- **流式合并只降事件数、不合并提交。** 否决：成本在整份快照写回，不在事件行；细节见 ADR-047。

## 影响

- `plan/slices.json` 新增切片 harness-focus；`plan/tasks.json` 的 G063 转 in_progress，新增 G065；`plan/test-cases.json` 为两者各加用例；TASKS.md 与 docs/engineering/test-matrix.md 随之重生成。第一批不新增 src/web 文件，所改的源码文件都已在其他已接受切片的 allowed_files 内，所以本切片的 allowed_files 为空；以后新增的描述模块文件登记在此。
- `docs/decisions/README.md`：为每条 ADR 标状态，并以本文件的处置节取代“七项架构议程仍为 proposed”。
- `docs/decisions/0038-verified-version-hint.md`、`0039-continue-in-the-original-program.md`：由第 1 项的任务同次更新（dsh 继续命令、Hermes 版本、预发布语义）。
- `docs/contracts/provider-web-mvp.md`：由第 2 项同次更新（history 逐条降级与错误消息脱敏）。
- `docs/contracts/storage-events.md`、`docs/decisions/0013-live-chat-experience.md`：由 ADR-047 同次更新。
- `docs/engineering/development.md`、`testing.md`、`readiness.md`：由第 4 项同次更新（边界检查进入 `pnpm check`；G063 从“在公共端口实现前接入”改为已落地）。
- README.md 与 docs/README.md：存储版本（业务库 12、管理库 6、能力库 5）、目录数量（45 个产品/49 个控制入口）与 dsh、Claude 的版本句改为与代码一致。
- `docs/verification/native-capability-matrix.md`：矩阵的 ✅ 与已验证版本保持原状，直到重验收。集成时只改两格，与代码保持一致，见文末集成记录。

## 验证

每项对应的测试层与命令。命令以仓库现有脚本为准：测试经 `pnpm build` 后以 `node --test dist/tests/<层>/<文件>.js` 单跑，全量为 `pnpm test`；设计检查为 `python3 tools/check_design.py`，结构检查为 `pnpm check`。

| 项 | 层 | 文件 | 必须观察到 |
|---|---|---|---|
| 1 版本 | unit、integration | `tests/unit/verified-versions.test.ts`、`tests/unit/capability-readers.test.ts`、`tests/unit/official-channels.test.ts`、`tests/integration/capabilities.test.ts`、`tests/integration/management-system-version.test.ts` | 三处版本来源不一致的无效样例被测试拒绝；`0.2.0-rc.2` 命中 dsh 读表；Hermes 的 dist-info 给出 0.12.0；dsh 只给 headless 命令 |
| 2 审计记录 | integration | `tests/integration/capability-changes.test.ts`、`tests/integration/web-server.test.ts` | 含绝对家目录路径的失败写入之后，history 仍 200，坏记录单条标为无法读取；公开错误消息不含家目录 |
| 3 流式合并 | integration | `tests/integration/session-runtime.test.ts`、`tests/integration/web-session-stream.test.ts`、`tests/integration/parallel-work.test.ts`、`tests/integration/session-cli.test.ts` | 见 ADR-047 |
| 4 边界检查 | integration 加工具自检 | `tests/integration/g063.test.ts`、`tools/fixtures/boundaries/` | 合法依赖通过；领域导入子进程、契约导入 yaml、web 导入 infrastructure、测试未用临时租约目录各被拒绝且非零退出；`pnpm check` 包含它 |
| 5 控制层 | protocol | `tests/protocol/acp.test.ts`（对端 `tests/fixtures/control-peer.mjs`） | `_auth/status_update` 变成就绪状态而不是诊断；OpenCode 1.18.x 的命令目录含 `/compact`；其他 ACP Harness 的通知路径不变 |
| 6 冻结 | 设计检查加人工评审 | `python3 tools/check_design.py`；评审 `plan/native-capabilities.json` 的改动 | 三个非焦点 Harness（Cursor、Gemini CLI、Pi）的矩阵 ✅ 数不增长（`complete_at_freeze`；原来还要看已验证版本表，它 2026-10-22 随 ADR-053 删除） |

真实引擎通过：本批无。Claude 2.1.306、dsh 0.2.0-rc.2 的真实重验收另立验收记录。

## 对 ADR-001～007 的处置

索引里的七项“架构议程”从 2026-10-09 起一直是 proposed，但其中六项已被代码事实决定。按“设计采纳 / 代码完成 / 测试通过 / 真实引擎通过”分别表述：

| ADR | 处置 | 落地位置 |
|---|---|---|
| ADR-001 公共 Session 与原生 BackendBinding 分离 | accepted-by-implementation | `src/contracts/session.ts` 的 `nativeBindings`：Session 保持公共身份，每个 Harness 的原生绑定另记 |
| ADR-002 模块化单体、DDD 上下文与防腐 Adapter | accepted-by-implementation | `src/contexts/` 的五个上下文（catalog、session、management、provider、capabilities）；领域层不导入 SDK、HTTP、数据库或子进程库，G063 落地后由工具保证 |
| ADR-003 ACP v1 优先，原生协议单独适配 | accepted-by-implementation | `src/adapters/control/factory.ts`：通用 ACP 控制加 Codex、Pi 等原生协议子类 |
| ADR-004 规则式路由、硬约束优先 | deferred | 自动择优按用户要求后置（[ADR-011](0011-provider-web-mvp.md)）；没有实现，不声称质量择优 |
| ADR-005 持久意图/outbox、epoch fencing、先提交后发布 | 部分实现 | 先提交后发布与 epoch fencing 已实现（`sqlite-store.ts` 的 `transact`：CAS 与事件同一事务；`src/contexts/session/domain/state.ts` 的 epoch 与 tombstone）；outbox 未实现，由单进程 owner 替代 |
| ADR-006 静止交接、public_context_rehydrate 为明确等级 | accepted-by-implementation | `src/contexts/session/domain/context.ts` 的 `continuity: "public_context_rehydrate"` |
| ADR-007 模型目标独立，最小同协议桥接 | accepted-by-implementation | [ADR-011](0011-provider-web-mvp.md)：本机 Provider 资源、不可变 revision、私有配置 |

“accepted-by-implementation”表示决定已由代码体现并有测试覆盖，但原议程要求的独立 ADR 文件（C003、C004、C006、C007、C008、C010 的交付物）没有写；是否补写由后续的契约 as-built 改写决定。

## 审批代理的裁决（2026-10-21，总指挥兼审批代理 Fable 5.1）

- 方向由用户决定；本记录只划分切片与边界。六项加固全部接受，附条件：
  1. 第 1 项不改 `VERIFIED_VERSIONS` 的数字；一致性检查必须有“三处版本不一致”的无效样例。（已按此完成；2026-10-22 起表与对账随 ADR-053 删除。）
  2. 第 2 项的 history 逐条降级不得吞掉错误：坏记录以明确状态显示，日志记录条目 ID。
  3. 第 3 项另立 ADR-047 送审；合并窗口与上限写进契约，先提交再发布不变。
  4. 第 4 项的每条规则都要有无效 fixture；`pnpm check` 失败返回非零。
  5. 第 5 项不改 Claude、OpenCode 之外的控制路径；扩展钩子是适配层的事，Runtime 不按 Harness 分支。
  6. 第 6 项即日生效；矩阵与已验证版本表不再为非焦点 Harness 更新（裁决时为四个；用户同日把 OpenClaw 加回焦点后为 Cursor、Gemini CLI、Pi 三个）。
- 第一批对用户真实配置零写入，不运行任何 Harness；真实重验收等用户同意。
- 对 ADR-001～007 的处置按上表记录；索引不再写“仍为 proposed”。

## 集成记录（2026-10-21）

六项分别在独立工作区实现，审批代理逐项审查后全部接受（第 1 项退回修改一轮），再按顺序并入集成分支，彼此文件不重叠。集成时补做以下各项，代码与文档保持一致：

- **OpenClaw 归入焦点。** 用户在第一批实现期间补充“openclaw 也保留着吧，也加入接入清单”。本记录、ADR-048、索引、README、`plan/` 的 G065 与切片说明同步改为七个焦点、三个非焦点。OpenClaw 的已验证版本 2026.3.23-2 与矩阵不变。
- **第 5 项的一处偏离（审批代理已接受）。** 原设想是 Claude 报告 none 时记为需要登录。实现记为“未说明”，原因见 [ADR-033 的 2026-10-21 补充](0033-native-catalog-cache-and-readiness.md)：令牌登录同样报 none，记为需要登录会挡住能用的 CLI。
- **矩阵两格。**
  - OpenCode“上下文压缩”改为已接出、协议通过、真实未验证。矩阵中显示为 ◐，✅ 数不变。
  - DeepSeek Harness“原生会话恢复”的说明改为：官网 rc.2 只给 headless 命令，`dsh tui --resume` 属于 0.2.1-alpha.1 的历史。
  - 已验证版本表不变。
- **用例登记。**
  - `plan/test-cases.json` 新增 G032-NC23（Claude 登录状态）与 G032-NC24（OpenCode `/compact`），并修订 G011-NC2：DeepSeek Harness 只给非交互命令。
  - ADR-047 的七个用例以 INV 编号命名，没有另立场景 ID。
  - 第 2 项沿用 G064-W3 场景 ID。
- **相关决定的补充。**
  - [ADR-024](0024-native-session-operations.md)：OpenCode 1.18.x 的 `/compact`。
  - [ADR-033](0033-native-catalog-cache-and-readiness.md)：Claude 登录状态。
  - README 的“现在可运行的检查”与 `docs/engineering/ai-workflow.md` 写明 `pnpm check:boundaries`。
- **留给后续批次。**
  - 详情栏在只有一次性命令时仍只显示原生会话 ID，见 ADR-039 的 2026-10-21 补充。
  - `src/web/shown-paths.ts` 的家目录检测还不认全角标点边界。
  - 版本区间判断在 `verified-versions.ts` 与 `capabilities/scan.ts` 各有一份。（2026-10-22：两份都随 ADR-053 删除。）
  - G063 的公共类型面检查（`check-contract-surface`）未落地。

## 2026-10-22 补记

第 5 项的 OpenCode `/compact` 已在 1.18.35 上真实核对通过：压缩以回复文本交回，压缩后仍记得先前事实，见 [opencode-compact-2026-10-22.md](../verification/opencode-compact-2026-10-22.md)。第 1 项中 Claude 与 dsh 的“真实重验收前不改数字”同日按记录更新，见 ADR-038 的两条 2026-10-22 补充。

同日稍后，用户的原则“接入不限定版本，默认按最新版”写成 [ADR-053](0053-latest-version-baseline.md)：第 1 项的版本表、对账与读表区间删除，第 5 项的 `/compact` 改为目录未列出时对任何版本补入；背景第 13–14 行描述的版本表与两套版本语义不再存在（已就地注明）；否决方案里“直接改 `VERIFIED_VERSIONS`”的取舍、裁决第 1 条与“留给后续批次”里的两份区间判断都已就地注明。真实重验收的记录与 1.18.35 的 `/compact` 记录保留为证据。
