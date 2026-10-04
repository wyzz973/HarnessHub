# 测试与完成要求

测试证明可观察行为和资源结果。架构不变量由 [DESIGN.md](../DESIGN.md)定义，本页规定哪些证据足以支持改动和完成声明。

## 按变更选择验证

| 变更 | 最少相关证据 |
|---|---|
| 文档、相对链接 | 文档检查；语义、锚点及命令人工复核 |
| 纯函数、schema、错误映射 | 有效和无效输入测试、typecheck；覆盖真实边界，不镜像实现 |
| Run、队列、权限、deadline | 状态转换及竞态测试；真实 SQLite/IPC 组合链路 |
| Store、事件、迁移、重放 | 真数据库的事务回滚、幂等、排序、重启及上一版本升级 |
| Worker、ProcessHost、清理 | 正式构建入口与子进程；等待退出并核实残留，受影响平台原生测试 |
| ACPDriver 或引擎版本 | 公共 Driver 契约 + 对应真实引擎 smoke；记录版本、权限及产物 |
| API/SSE | 正式 Gateway 的 HTTP 行为、重复提交、断线重放及错误响应 |
| 公开模型或用户可见输出 | 对应期望输出或事件 fixture；从实际入口复现，必要时真实模型或浏览器验收 |
| Benchmark | 复用执行服务、环境重置、评判器输入输出和重复 attempt 归属 |
| 构建、入口、发行依赖 | 从编译/打包产物在 plain Node 启动，不能只运行源码开发入口 |

先运行覆盖改动的最小检查，必要时扩大到依赖模块和完整组合。局部修复不默认重复全套测试；全局契约变更、CI 诊断或新失败可以扩大验证。无测试、缺凭证和平台不匹配必须报告 skipped/未验证。

## 第一条执行链路

首个假引擎里程碑从编译后的 Gateway 与 Worker 启动，经 HTTP 提交任务，通过 SSE 获取已提交事件，查询真实 SQLite，并在重启后查询同一个 Run 和导出 JSONL。假引擎仅替代外部 Harness；不能同时 mock 数据库、IPC、状态机或事件传输来声称端到端通过。

必须覆盖的关键路径包括：同 Session 排队与跨 Session 并行；重复提交；开始前取消；启动中取消；执行中取消；权限等待超时；完成与 deadline 竞争；旧 generation 迟到事件；DB 写失败；Worker 异常退出；Gateway 重启；慢 SSE 消费者；正常及失败清理。

采用确定的 barrier/handshake/事件构造竞态，断言唯一终态、事件顺序、产物与进程实际状态。不要凭 Agent 文本中“成功”或某个日志出现就认定任务完成。

## 测试可靠性

每个测试独立拥有临时目录、数据库、端口、进程与环境；随机临时路径和 `listen(0)` 避免并发冲突。资源获取后立即登记 teardown，失败和断言抛错也要释放。临时目录用 [`tests/support/temporary.ts`](../tests/support/temporary.ts) 的 `temporaryDirectory(t, prefix)` 创建：删除在创建时登记，之后启动的 Gateway、Worker 或模型桥用 `defer` 登记关闭，启动失败也不会泄漏目录。

需要模型上游的测试使用 [假 provider](../tools/fake-provider/README.md)（TypeScript 测试经 [`tests/support/fake-provider.ts`](../tests/support/fake-provider.ts) 加载）：它只在回环地址监听，按协议检查字段并记录违规，记录中只有 Key 的标识与指纹；测试中的 Key 一律是合成的金丝雀值，断言零违规与预期的 Key 标识，而不只是回答能解码。

终端界面（`hh tui`）的测试经 [`tests/support/terminal.ts`](../tests/support/terminal.ts) 注入终端：输入记录原始模式，输出可以改变尺寸并发出 `resize`，屏幕按写入的转义序列重建，测试读到的就是用户看到的内容；未知的转义序列使测试失败而不是被忽略。

`pnpm test:*` 与 `test:windows` 都经 [`tools/run-tests.mjs`](../tools/run-tests.mjs) 运行，它负责测试环境的隔离与期限：

- 测试进程只继承白名单中的系统变量与 `HARNESSHUB_TEST_*` 显式开关；开发者 shell 中的 `HARNESSHUB_MODEL*`、`AGENT_ENGINE`、各家 API Key 与令牌一律不可见，测试需要时自行设置。
- `HH_OFFLINE=1`：测试启动的守护进程不在后台刷新模型目录；需要刷新的测试把 `catalog.url` 指向本机回环的假服务（见 [模型目录](../packages/gateway/catalog/README.md#运行时刷新)）。
- HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG 目录与临时目录指向本次运行私有的沙箱。涉及账户级系统服务的测试从 `HARNESSHUB_TEST_SYSTEM_HOME` 取得真实 HOME：macOS 钥匙串测试临时切换 HOME 并在结束时恢复，Windows DPAPI 测试据此定位按令牌用户配置目录保存的密文。
- 每个用例默认有超时，整组有总期限；超过总期限时结束整个进程树并判为失败，这通常说明某个文件留下了未关闭的句柄。
- 运行结束后沙箱临时目录中仍有内容即判为资源泄漏并失败；沙箱在任何情况下都会删除。拒绝样例见 `tools/check-run-tests.test.mjs`。
- `--inventory FILE` 另外写出本组的用例清单：[自定义 reporter](../tools/test-inventory-reporter.mjs) 经 `--test-reporter` 写入沙箱，启动器补上组名后写成 JSON Lines（组名、测试文件名、从最外层到该用例的名称路径、状态 pass/fail/skip/todo），spec 输出照常写到 stdout。未给该参数而 `HARNESSHUB_TEST_INVENTORY_DIR` 非空时写到 `<目录>/<组名>.jsonl`；这个变量只供启动器使用，不传给测试。失败的运行同样写出清单，清单只含 runner 实际报告的用例。
- [`tools/compare-inventory.mjs`](../tools/compare-inventory.mjs) 比较两份清单（文件或目录）：按组名、名称路径和状态计数匹配，忽略测试文件位置，逐条列出缺少与新增的用例；有差异退出 1，输入无效或没有条目退出 2。`--allow FILE` 列出预期新增的条目，未出现的预期新增同样算差异。拒绝样例见 `tools/check-compare-inventory.test.mjs`。多包迁移用它逐平台核对用例清单不变，见 [多包迁移计划](proposals/oss/13-package-migration.md#5-步骤与对账)。

就绪等待使用带期限的握手、查询或状态事件；固定 sleep 不作就绪证据。重试仅用于明确瞬时故障，记录触发原因及次数；不能通过更长 timeout、整套串行或反复重跑掩盖竞态。

修复回归时尽可能先复现旧行为失败，再验证新行为。新增校验脚本至少有一个有效样例与对应无效样例，证明规则执行且失败退出。断言校验结果，不机械复刻实现分支。

快照仅规范化确实不稳定的时间、随机 ID 等字段；不能删掉终态、排序、权限、错误或缺失产物来消除差异。刷新期望值须审阅差异；CI 只读比较，不自动接受新结果。

不采用全仓 100% 覆盖率作为 MVP 的唯一目标。核心状态机、事务、权限和清理的关键分支必须有对应测试；工具链建立覆盖基线后，退步要解释缺失行为并补证据。更高数字不能代替真实组合、发行入口和平台验收。

## Windows 与真实引擎

Windows 用原生环境验证中文/空格路径、env 大小写、cmd/PowerShell、stdio drain、文件句柄、junction、子孙进程清理与 SQLite 重启。Wine、macOS/Linux、构建成功均为补充信号，不能记为 Windows 功能通过。

引擎验收记录 Harness、Adapter、Runtime、Node、OS 的版本，以及模型、权限模式、工作目录来源和预算。OpenCode 与 Pi 运行同一公共契约；可选能力不支持须显式验证其拒绝行为，不能通过静默跳过伪造等价支持。

默认测试不消耗真实 API。真实引擎或模型测试使用明确提供的凭证和任务预算；缺少时记录未运行。不得为了让检查变绿擅自改模型、降低输出上限或替换任务。

涉及 Web UI 时，从项目正式入口进行真实浏览器操作，核对可见状态、持久状态及刷新结果。截图是证据之一，不能单独证明行为或后台清理。

## 检查入口与接入顺序

当前实际可运行入口在 [README](../README.md#当前可运行检查)。文档检查是局部检查，不等于完整构建或质量检查。

下表按所属模块与实施阶段逐步实现。当前类型、lint/格式、边界、SPDX 文件头、标签定义、单元、DB/IPC/HTTP 集成、构建入口 smoke 和文档检查已在 [package.json](../package.json)接入。[CI 配置](../.github/workflows/ci.yml)在 Ubuntu、macOS 与 Windows 上运行完整 `pnpm check`，由 `ci-ok` 汇总为单一必需状态；另有 [DCO 签名](../.github/workflows/dco.yml)（`tools/check-dco.mjs`）、[CodeQL](../.github/workflows/codeql.yml)、[依赖审查](../.github/workflows/dependency-review.yml)、[OpenSSF Scorecard](../.github/workflows/scorecard.yml) 与[标签同步](../.github/workflows/labels.yml)。第三方 Action 按提交 SHA 固定，工作流默认只读权限。CI 运行 `pnpm check` 时设置 `HARNESSHUB_TEST_INVENTORY_DIR`，检查通过后把各组用例清单按平台上传为 `test-inventory-<os>` 构件。Windows 专用 `test:windows` 已接入，要求本机 Windows 并从正式编译产物执行测试；同组测试也包含在 `pnpm check` 的常规单元/集成组。远端 CI 结果与本机证据分别报告。真实引擎 `test:engine` 尚未接入；真实模型必须另有配置、预算和执行证据。

| 目标检查名 | 职责与接入点 |
|---|---|
| `typecheck` | 首个 TS 模块建立时接入严格类型检查 |
| `lint` / `format:check` | 首个工具链固定配置，校验异步处理与格式 |
| `check:boundaries` | 首个模块图建立时检查导入方向和第三方类型泄露，配无效 fixture |
| `test:unit` / `test:integration` | 纯行为与真实 DB/IPC/API 组合，必需组为空时失败 |
| `build` / `test:smoke` | Gateway/Worker 入口建立时验证编译产物启动 |
| `check:docs` | 包装已有文档检查；建立可运行示例后纳入 typecheck，随后补锚点检查 |
| `test:engine` | 首个真实引擎接入时运行；缺凭证明确未验证 |
| `test:conformance` | 已接入，不属于 `pnpm check`：本机安装的真实 Agent 经全局接线、在 macOS 沙箱中离线运行一次并到达假上游，结果写入[兼容性](compatibility.md)；未安装的 Agent 跳过并列为未安装，没有沙箱的平台整组跳过 |
| `test:sea` | 已接入，不属于 `pnpm check`：构建单可执行文件（构建本身要求 `hh` 的每个命令在可执行文件中回答 `--help`），再经它运行 `version`、`serve`、模型平面与接线命令、两次网关调用、`tui`、`console` 与控制台页面，全部在一个临时目录中、只连回环地址的假 provider（[SEA 可行性验证第 10 节](proposals/oss/sea-spike.md#10-hh-的全部命令2026-10-04)） |
| `test:windows` | 首个 ProcessHost 路径建立时接入 Windows 原生执行；发布前必需 |

实际 script 名称、参数与依赖顺序由 [package.json](../package.json)和 [CI 配置](../.github/workflows/ci.yml)拥有，本页只说明职责。启动脚本存在但没有调用真实检查，或 CI 总判定没有依赖必需任务，均视为未接入。

本地提交前做改动范围的格式、类型和行为检查；后续 hook 只运行快速检查。CI 负责完整类型、边界、测试、构建、文档和平台矩阵；必需任务失败、取消、异常跳过均不能汇总为成功。观察性任务可以不阻断，但必须明确标明覆盖范围。

## 完成的定义

完成一个实现阶段需要：约定行为可从正式入口观察；相关失败路径经过验证；文档与实现一致；必要产物可查询；无未报告的残留资源或跳过检查。检查自身通过不代表引擎/平台通过。

交付报告至少说明改动、验证命令及结果、运行版本、实际产物或日志位置、未验证项和原因。跨进程、真实引擎、Windows、迁移、Benchmark 或复杂 UI 变更保存 [验收记录](templates/verification.md)；局部改动在提交/PR或本次任务中记录即可。

统一使用这些状态：`已采纳` 表示设计决定；`已实现` 表示代码存在；`已验证` 必须指定场景、版本和证据；`部分完成` 列出缺口；`未验证`/`跳过` 不能写成通过。分支或文件在记录后发生相关改变，应重新判断证据适用性。
