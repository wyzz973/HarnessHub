# ADR-056：原生宿主与会话租借——会话是数据，进程是可以切换会话的宿主

状态：proposed，2026-11-03。方向由用户的问题引出（每条消息都要现场启动原程序进程，切换 Harness 时进程又被关掉，资源开销大，有没有类似线程池的方案；先把 Session 的所有情况想清楚）；设计正文由总架构师（Fable 5.1）起草：[原生宿主与会话租借设计](../proposals/native-hosts/design.md)（下称“设计”）。本记录只写取舍、失败边界与验收方式，接口、判定表、分类表与走查以设计各节为准。**未实现、未真机验证**：没有改任何代码，没有运行任何 Harness，没有碰 4317 服务与 `data/`。实测已完成：[实测记录](../../spikes/native-hosts/README.md)与 `spikes/native-hosts/results.json`（2026-11-03，六家；Pi 在官网策略下起不来，未测）——用正式的 application 与 binding factory、官网安装策略、生产的启动命令、环境与会话参数，不调用模型，配置守护前后无变化；设计第 5 节的归类与数字、第 4.3 节的预算、第 4.7、4.11、4.12 节与第 10 节的剩余项都已按它改写。

标注：【事实】有代码或记录出处（基点 `e02fa52`）；【实测】`spikes/native-hosts/` 在本机（Apple M5 Pro，64 GiB）测得，RSS 为整个进程树之和，Claude 与 Codex 的内存取决于本机用户自己配置的 MCP 服务器；【推断】由事实推出；【建议】本设计的提议。

## 背景

- 【事实】每个回合为自己启动一次原程序、回合结束即关（`src/infrastructure/session/binding-factory.ts:118`、`src/contexts/session/application/runtime.ts:1504–1508`）；只有对话显式开启“保持原生进程”（[ADR-030](0030-retained-native-processes.md)）后进程才归对话持有：最多 4 个、空闲 30 分钟、切换生效时不是新选择就关闭（`runtime.ts:66–68`、`:1626`）。保持与并行（[ADR-036](0036-approval-wait-budget.md)）是两份预算，最坏 8 个进程，没有按内存的上限。
- 【事实】旧实现测得“启动 + 建会话”Claude 约 2.9 秒、Codex 约 4.3 秒、OpenClaw 约 1.3 秒，Hermes 的启动占回合总时的一半；复用保持的进程时 7 毫秒（设计第 2 节 L1）。Hermes 每回合 `session/load` 回放全文（`src/adapters/control/hermes.ts:185`），历史越长固定开销越大。
- 【事实】三个 Driver 都只允许一条连接打开一个原生会话（`acp.ts:504`、`codex.ts:336`、`pi.ts:169`），而 ACP、Codex app-server、Pi RPC 都允许一个进程承载多个会话（设计第 3 节）。
- 【事实】Hub 没有“原生会话是否新鲜”的判定：用户在原程序里继续过（[ADR-039](0039-continue-in-the-original-program.md)）、原生命令改了上下文之后，保持中的进程持有的是过期视图；现状靠每回合重开掩盖。[ADR-055](0055-relay-and-context-scheduling.md) 已要求 `verify=on_next_open` 的 Driver 在 suspect / pending 时不复用保留进程。
- 【事实】崩溃清理只覆盖保持中的进程（`runtime.ts:590–614`）；回合进行中服务退出时进程不在任何记录里（ADR-030 边界；ADR-055 Q23）。
- 【实测】启动到 initialize 中位：Claude 124 ms（只起适配器）、Codex 26、OpenCode 644、dsh 967、Hermes 553、OpenClaw 1259 ms；首个会话 297 / 74 / 1057 / 297 / 1241 / 748 ms；同进程第二个会话 289 / 13 / 76 / 18 / 147 / 364 ms。RSS（initialize / 1 会话 / 2 会话，MiB）：Claude 129 / 1464 / 2386，Codex 98 / 1000 / 1838，OpenCode 332 / 545 / 796，dsh 255 / 260 / 260，Hermes 169 / 190 / 200，OpenClaw 449 / 451 / 454（两家的网关另计）。内存的大头是 Claude 每会话、Codex 每线程各自启动的一整套用户配置的 MCP 服务器；只有 Claude 的 `session/close` 真正释放（2414 → 1074 MiB），Codex 的 `thread/unsubscribe` 不释放，只有退出进程才释放。六家都能在一个进程里带两个会话；Claude、Codex、OpenCode、dsh 的 cwd 各自生效，Hermes、OpenClaw 无法从元数据核实。
- 【实测】六家空闲 60 秒都不写工作区；都在 stdin EOF 后自行退出（Claude 带会话 0.8 s、Codex 0.3–1.1 s，其余 ≤0.4 s），生产 500 ms 的关闭宽限会在它们自然退出前就 SIGTERM；Codex 19 个后代里 18 个、Claude 2 个、OpenCode 与 OpenClaw 各 1 个不在领头进程组里（都在 1.14 s 内自己退出）；每次绑定换新 TMPDIR 让 OpenCode、dsh、OpenClaw 每次启动重写缓存，持久 TMPDIR 把 initialize 从约 590 / 960 / 1250 ms 降到约 160 / 580 / 1100 ms；不发提示也会留下原生记录（Codex、dsh、Claude、OpenCode、Hermes），所以预热不能建会话。

## 决定（建议）

1. **会话是数据，进程是宿主。** 原生会话由 (harnessId, controlId, checkpoint) 标识并由原程序保存；宿主（NativeHost）是承载它的进程或到原生服务的连接；回合取得对宿主上某个会话的租借（SessionLease），不再拥有进程。接口草案见设计第 4.2 节；品牌 ID 与 Driver 的静态声明 `HostCapabilities`（只写机制，不出现产品名）与 `RelayCapabilities` 同一做法。
2. **宿主池按“Harness + 入口 + 安装指纹 + 启动环境指纹（含工作区）”分类，预算以内存为主、按类封顶**（取代统一的“最多 8 个宿主”）：全局内存上限按整个进程树的采样 RSS 之和计（初始值物理内存的 1/8），超出即先收回最久未用的空闲会话（可收回的类）、再关最久未用的空闲宿主，重的类先于轻的类；按类上限的初始值——Claude 同时活着的会话 ≤3、会话空闲 10 分钟 `session/close`、适配器没有会话 2 分钟后关闭；Codex 每个对话一个进程、全局 ≤3、空闲 5 分钟关闭；OpenCode、dsh、Hermes、OpenClaw 每进程 ≤8 个会话、保活 10–15 分钟；固定上限 4 与并行 4 不变。这些只是起点，要按目标机器的内存调整；淘汰只碰空闲且未固定者，不能新建时回合等空位（设计第 4.3 节）。
3. **复用必须通过新鲜度判定。** 以下任一命中即重新打开（或按接力规则先核对）：用户在原程序里继续过、结果未知、绑定 unconfirmed / forking、接力 pending / suspect、原生命令效果为 clear / rewind / unknown、配置或安装指纹变化、启动参数变化、工作区身份变化、宿主不健康、Driver 声明外来回合不可检测；判定依据写进事件（设计第 4.4 节）。
4. **写租约跟着写走。** 池内空闲宿主不持有工作区租约（前提：Driver 声明空闲时不写工作区，或本宿主结算后没有未归属的原生事件与运行中的活动）；有后台任务的宿主固定到对话并继续持有租约，另一对话同工作区得到 `WORKSPACE_KEPT`——ADR-030 的方案 C 原样保留为池的子集（设计第 4.5、4.6 节）。
5. **切换后保留来源宿主。** A→B 时 A 的宿主转池内空闲或继续固定，不再因 `selection_changed` 关闭；回到 A 按新鲜度判定续用或重开，欠交由 ADR-055 补发。只换模型或选项时同理，`launchBound` 声明的启动参数除外。
6. **登记先于使用。** 宿主在安装级表 `native_hosts`（进程组号、组长启动时间、分类键、状态、固定的对话）登记后才承载回合；登记不经快照（像 ADR-055 的 `relayWrite`）；新所有者启动时按登记识别并结束 idle / pinned / leased 的遗留宿主，固定宿主沿用 ADR-030 的租约释放规则，`leased` 的只补“进程组已结束”的证据、不改 INV-11 与 INV-12（设计第 4.8 节）。
7. **不提供建会话式预热；预热与保活不得建立原生会话（INV-42）。** 实测证明不发提示也会留下原生记录，所以原生会话只在回合取得工作区租约之后建立；省启动的手段只有宿主层保活——按类时限保住 initialize 之后、没有会话的进程（例如 Claude 适配器在最后一个会话关掉后再活 2 分钟），没有用户可见的预热开关（设计第 4.7 节）。
8. **升级与配置变更按类排空**：不再接新租借，空闲立即关闭，固定者关闭并提示，正在回合的阻止升级（设计第 4.9 节）。
9. **宿主类型与七家归类按实测**（设计第 5 节）：原生服务型——Hermes、OpenClaw（会话在用户网关里，连接不随会话增长）；便宜的多会话型——OpenCode、dsh（会话 ≤10 MiB，冷启动 1–2 秒）；重的多会话型、会话可收回——Claude（适配器常驻、会话按需 `session/close`）；重的、进程内收不回——Codex（每个对话一个进程、冷启动约 0.1 秒、空闲就早关）；Pi 待测。类型由 Driver 声明的 `sessions`、`sessionMemory`、`sessionRelease` 决定，不写产品名；生产只对 `probed=true` 的 Driver 开放多会话复用（ADR-053：按程序实际报告的能力判断）。
10. **三期**（设计第 8 节）：第一期按会话复用的进程池、切换后保留来源宿主、新鲜度表、按类预算、登记与接管、关闭链与 TMPDIR、事件与指标，Driver 只加声明；第二期宿主多会话按收益排序——先 OpenCode、dsh、Hermes，再 Claude 的“适配器常驻加会话收回”，Codex 不做多会话，列会话与读会话借用空闲宿主；第三期记录树（设计第 7 节），只作长期规划。
11. **不变量**：新增 INV-37–41（[不变量](../domain/invariants.md)“宿主与会话租借不变量”一节，proposed）：原生会话同一时刻至多一个租借；复用前必须通过新鲜度判定且依据可追溯；空闲未固定的宿主不持有写租约；登记先于使用、接管有证据；单一预算且只淘汰空闲未固定者。每条都有计划用例（`plan/test-cases.json` G078–G085）。
12. **关闭宽限 ≥1.5 s**（现状 500 ms，`binding-factory.ts:170`）：实测最长自然退出 1124 ms；宽限由同一配置解析器给出（设计第 4.11 节）。
13. **关闭链先关 stdin，再核对离组后代**：关 stdin → 等领头进程退出且进程组清空 → 按 pid 加启动时间核对此前采样到的离组后代（`process-group.ts:42` 的读法）→ 仍活着的再等最多 10 s 并记入证据 → 信号只作兜底；离组后代仍按 ADR-030 补充条只读不发信号，是否结束本宿主自己的 MCP 服务器留设计 Q10（设计第 4.11 节）。
14. **每家一个稳定的私有 TMPDIR**（D7）：按宿主类在 `os.tmpdir()` 下建 0700 目录，与数据根互不包含，升级时清空，7 天未用删除，超 256 MiB 在无活宿主时清空；代价是同类对话共享编译缓存与原生库目录、要有清理所有者（设计第 4.12 节）。
15. **预热不得建会话**：见决定 7；登记为 INV-42，计划用例 G079-C09。

## 需要用户拍板的取舍

| # | 取舍 | 推荐 | 另一选项与代价 |
|---|---|---|---|
| D1 | 空闲宿主是否持有工作区租约 | (a) 不持有：空闲宿主不占工作区，同工作区的其他对话可以写；有后台活动的宿主只能固定（持租约）或关闭 | (b) 一律持有（ADR-030 现状推广）：同工作区两个对话互相 `WORKSPACE_KEPT`，复用收益被单一写入者抵消 |
| D2 | 宿主登记表的版本 | (a) 独立的 v14（只加一张表、不改快照），在 v13 之后；代价是多一次迁移前备份与停服 | (b) 并入 v13：要修订 ADR-055 与 G066 的范围，耦合两项工作 |
| D3 | 空闲时长怎么定 | (a) 按类设置：Claude 会话 10 分钟收回、适配器无会话 2 分钟关；Codex 进程 5 分钟；OpenCode、dsh、Hermes、OpenClaw 10–15 分钟；固定宿主仍 30 分钟加 4 小时硬上限——按“重建代价 ÷ 占用内存”取 | (b) 一刀切 10 分钟：Codex 多占 5 分钟的 0.9 GB，OpenCode 等则少省几次 1–2 秒的冷启动 |
| D4 | 预热 | (a) 不提供建会话式预热，只做宿主层保活（决定 7）：实测建会话就留原生记录 | (b) 提供“initialize 并建会话”的预热：每次预热都在原程序里多一个空会话，重复 ADR-033 探测会话的问题 |
| D5 | 第二期先做哪几家的多会话 | (a) OpenCode、dsh、Hermes 先行（会话 ≤10 MiB、冷启动 1–2 秒，收益最大）；Claude 用“适配器常驻加会话收回”；Codex 不做多会话（每线程独占 MCP、进程内收不回） | (b) Codex 先行（原推荐）：实测一个进程里两个线程 1.8 GB 且收不回，合并只会让内存更难管 |
| D6 | 记录树的时机 | (a) 只作长期规划，待 G066–G074 稳定后另行送审并先测 1 GiB 合成库的迁移 | (b) 与 v13 同时实施：两次存储大改合一，但接力实施期被拉长 |
| D7 | 每家一个稳定的私有 TMPDIR | (a) 采用：按类在 `os.tmpdir()` 下建 0700 目录，升级清空、7 天未用删除；OpenCode initialize 约 590 → 160 ms、dsh 约 960 → 580 ms、OpenClaw 约 1250 → 1100 ms | (b) 维持每回合新建 TMPDIR：隔离最彻底，但每次启动重写 1.4–13 MB 缓存，冷启动多 0.1–0.4 s |

不拍板即按推荐项；拍板后在本记录“决定”下补“用户决定”一节并把状态改为 accepted。

## 失败边界

- **新鲜度判定失败即重开**：判不出（Driver 声明 `undetectable`、列表读不到）按不新鲜处理，从不静默续用；重开失败按现有 `NATIVE_RESUME_UNAVAILABLE` 等错误码失败，不新建空会话冒充恢复。
- **租借结束清理未确认**：宿主 `dead`，不进池，工作区租约隔离（`WORKSPACE_QUARANTINED`），对话 blocked；与现状相同。
- **预算满且无可淘汰者**：回合等空位（`waitingForSlot`），可见、可取消；从不结束正在回合或固定的宿主。
- **登记写入失败**：该回合不派发，以 `HOST_REGISTRY_FAILED` 失败，宿主关闭；登记表不可用时服务启动报告并只在内存登记（与 ADR-033 缓存文件不可用时的处理一致），此时崩溃后的清理退回租约隔离。
- **接管**：每行最多约 6 秒；`unconfirmed` 保留并报告；`leased` 行结束后 Run 仍 unknown。
- **升级排空**：固定与空闲宿主关闭都留 `cleanup` 证据；正在回合的阻止升级（ADR-043 不变）。
- **网关型**：查看器或桥退出不是静止证据（INV-12、ADR-055）；ADR-051 的预检在每次新建 Hermes 宿主前照做。
- **关闭链**：宽限 1.5 s 内 EOF 自然退出；之后 SIGTERM、SIGKILL 进程组；离组后代核对不到或 10 s 后仍存活记 `outside.remaining` 并提示一次，不发信号（ADR-030 补充条）。
- **TMPDIR**：目录不可建或不可写时该类回合以 `HOST_TMPDIR_FAILED` 失败并关闭宿主；清理只在该类没有活宿主时进行，删除失败只记诊断。

## 测试与验收

- 设计验收：读设计第 0、4、5、8、9 节，对 D1–D6 逐条拍板；`python3 -I tools/check_design.py` 核对任务所有权与每条不变量至少一条计划用例。
- 每片的测试一律用真实的 `SqliteSessionStore`、真实工作区租约、走 stdio 的 `tests/fixtures/control-peer.mjs` 子进程；新鲜度表每条一个无效样例；接管测试用另起所有者再 SIGKILL 的做法（`tests/fixtures/kept-owner.mjs` 推广）。
- 真机验收（最新正式版，经 4317 正式入口）：Claude、Codex 各一次“连续三回合”与一次 A→B→A，记录冷启动、复用、重开用时与 RSS；探针 H1–H8（设计第 10 节）写进 `docs/verification/native-hosts-conformance-<日期>.md`，每家 `probed` 只在探针通过后翻转。
- 实测基线：[实测记录](../../spikes/native-hosts/README.md)（2026-11-03）是预算初始值与归类的依据；仍需模型调用才能验证的项（Codex `thread/resume`、OpenClaw `session/load`/`resume`、Pi `switch_session`、Hermes 与 OpenClaw 的 cwd、dsh 重启后 resume、回合期间 RSS）排进 G083；关闭链与 TMPDIR 的集成测试在 G085。
- 报告按设计采纳 / 代码完成 / 测试通过 / 真实引擎通过分栏；只面向 macOS（ADR-044）。

## 迁移与降级

- v14 只加 `native_hosts` 表、不改快照；迁移前按 [ADR-049](0049-business-store-backup-before-migration.md) 备份；v13 构建遇 v14 以未知版本拒绝；降级按 ADR-049 手动恢复备份。
- 快照里的 `retained`（v11/v12）语义不变；登记表是补充，不替代它。
- 没有数据内容的迁移；回退只丢宿主登记（下次启动按租约隔离处理）。

## 与既有 ADR 的关系

proposed 期间不改下列 ADR 正文；接受后随第一期实施补注。

| ADR | 关系 |
|---|---|
| [ADR-030](0030-retained-native-processes.md) | 保留方案 C、显式开启、租约持有、30 分钟、4 个上限、关闭证据、进程组登记与接管、后台任务枚举；取代“切换生效即关闭来源进程”“分支时关闭来源进程”；落实其迟到条件（空闲定义、4 小时硬上限、启动慢的提示）；补充条的离组后代核对扩到所有宿主关闭并先于信号 |
| [ADR-055](0055-relay-and-context-scheduling.md) | 不改 v13 与送达规则；新鲜度表引用 relay 同步状态；登记表为 Q23 与 D6 提供进程组证据；`HostCapabilities` 与 `RelayCapabilities` 并列 |
| [ADR-033](0033-native-catalog-cache-and-readiness.md) | 分类键复用目录指纹；不在后台预热的立场保留并加强为“不建会话式预热”（实测证实建会话即留原生记录，与它的探测会话同一问题）；第二期列会话与读目录借用空闲宿主 |
| [ADR-023](0023-attachment-input.md)、ADR-055 D5 | 附件物化目录在 `os.tmpdir()` 下按会话建；宿主 TMPDIR 同样在 `os.tmpdir()` 下、与数据根互不包含，但按类建、升级清空（D7） |
| [ADR-039](0039-continue-in-the-original-program.md) | 在原程序里继续过的会话判为不新鲜并重开 |
| [ADR-043](0043-upgrade-with-running-programs.md) | “关闭空闲保持进程”改为按类排空；阻止条件不变 |
| [ADR-036](0036-approval-wait-budget.md)、[ADR-014](0014-conversation-failure-recovery.md)、[ADR-029](0029-continue-native-sessions.md)、[ADR-025](0025-conversation-branches.md) | 并行与排队机制、未知不重跑、一个原生会话一个持有者、原生副本只在精确位置建立都不变 |

## 不做

- 不用用户级守护进程承载 Hub 的宿主（`codex app-server daemon` 之类），不启动、停止或替换用户的 Hermes、OpenClaw 网关。
- 不在后台定期探测任何 Harness；不做建会话式预热。
- 不为 Codex 做多会话：每个对话一个 app-server 进程。
- 不按版本号开关多会话能力；只按探针与程序报告的能力。
- 第一期不改 Driver 的一连接一会话限制，不做跨工作区共用宿主。
- 不改 ADR-055 的 v13 表、送达水位与零注入规则。
