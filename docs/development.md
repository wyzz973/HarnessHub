# 开发规范

本页规定实现和协作方式。产品职责与运行语义由 [设计基线](../DESIGN.md)定义，验证方法由 [测试要求](testing.md)定义；规则变更理由记录在 [决策记录](decisions/README.md)。

## 开始一次变更

先确认改动解决的问题、使用方、影响的接口和需要的证据。存在代码时，检查 branch、diff、已运行进程与构建产物，定位行为的所属模块，再修改最小相关范围。不得仅根据旧文档路径、缓存产物或某个测试通过推断当前实现。

实现顺序为：确定可观察行为与不变量 → 更新相关契约 → 实现并处理失败路径 → 验证真实使用方 → 同步文档 → 检查最终差异。纯机械或局部改动无需另写设计提案。

已采纳的架构按用户授权执行。实现细节在现有设计内自行判断；架构、持久化、权限或协议语义发生实质变化时，在变更说明中明确并更新所属 ADR。已有授权不因内部工作流再次确认。

## 模块边界

| 模块 | 可以依赖的内容 | 不能承担的内容 |
|---|---|---|
| `domain` | 自有类型、协议、纯函数及必要基础能力 | Fastify、acpx、SQLite、进程启动、环境读取等具体实现 |
| `application` / `runtime` | 领域类型、注入的 Store/Driver/ProcessHost 等接口 | 从 SDK 结果直接修改业务规则，导入具体实现绕过组合根 |
| `gateway` | Application Service、边界校验和响应序列化 | 选择具体引擎命令、直接操作数据库、直接启动 Worker |
| `engine` | Profile 解析、能力记录与注入的 Worker 控制接口 | 根据临时失败静默切换既有 Session 的 Engine |
| `worker` / `drivers` | IPC 契约、领域协议、所属 SDK 与后端状态 | 写 HarnessHub 公共数据库、分配公共事件序号、决定公共终态 |
| `storage` / `process` | 所属技术实现与领域接口 | 反向依赖 Gateway 或驱动产品决策 |
| `benchmark` / `rollout` | Application Service 或已提交数据的查询接口 | 创建第二套执行循环、独立推断业务终态 |
| `platform` | 具体 Windows 文件系统 ACL 操作、domain 错误类型与 Node 系统库 | 依赖 Runtime、Gateway、Driver 或业务存储；向领域/业务模块泄露平台实现 |
| `tool-packages` | domain 与 platform；本地包校验、私有复制、安装登记和绑定描述 | 启动模型、修改 Gateway 公共状态、读取账号配置 |
| `distribution` | domain 与 tool-packages；发行清单、路径模板和 settings | 创建独立执行循环、引用 Runtime/Driver 实现 |
| `logging` | domain 与 Node 文件/压缩库；诊断日志文件、已提交 Store 变化的记录、日志打包 | 决定运行结果、写业务数据库、被 Gateway/Runtime/Driver 直接引用（它们只依赖 domain 的 `LogSink`） |

`artifacts`、`drivers` 与 `tool-packages` 可使用 `platform` 的具体文件访问实现；其他模块不直接引用。`logging` 只由组合根和 Worker 使用，其余模块接收注入的 `LogSink`；详见 [诊断日志](observability.md#诊断日志)。Windows 进程树监督仍由 ProcessHost 与所属 Driver 负责。边界检查为该限制提供接受及拒绝样例。

OSS-004 期间代码按 [多包迁移计划](proposals/oss/13-package-migration.md) 从 `src/` 逐步移入 pnpm workspace 包，上表规则在包内按原模块继续适用。各包的 `new URL(..., import.meta.url)` 按编译后文件（`dist/src/...`）所在位置检查。`domain` 已移为 `packages/core`，其他代码以 `@harnesshub/core/<文件>` 导入（不带扩展名）；`storage` 与 `platform` 已移入 `packages/store` 的同名子目录，以 `@harnesshub/store/storage/<文件>`、`@harnesshub/store/platform/<文件>` 导入；原 `drivers/configuration/secrets.ts` 已移为 `packages/secrets`，以 `@harnesshub/secrets/secrets` 导入，迁移期间 `src/` 按原 `drivers` 模块的规则检查；原 `drivers/chat-completions` 已移为 `packages/gateway`（`@harnesshub/gateway/<文件>`），它与配置准备之间的类型在 `@harnesshub/core/model-bridge`，配置准备不导入网关，由 Worker 与组合根经 `PreparationHooks.startModelGateway` 注入；`drivers` 的接口、ACP、CLI 与假驱动已移为 `packages/drivers`（`@harnesshub/drivers/<子目录>/<文件>`），`RuntimeMcpServer` 移到 `@harnesshub/core/runtime-mcp`，`src/` 中将迁入守护进程的文件只有 `worker/` 可以导入驱动；engine、tool-packages、tool-command、配置准备的五个文件与 application 的两个服务已移为 `packages/agents`（`@harnesshub/agents/<目录>/<文件>`），其中 `configuration/` 与 `tool-command/` 仍按原 `drivers` 模块的规则检查。包内不属于任何原模块的文件（如 agents 的 `repository.ts`）是包级代码，本包各模块都可以使用；`runtime`、`process`、`benchmark`、`artifacts` 与 application 的三个服务已移为 `packages/runtime`（`@harnesshub/runtime/<目录>/<文件>`），配置探测移为其中的 `process/probe.ts`，仍按原 `drivers` 模块的规则检查。`ProcessWorkerHost` 的 Worker 入口由组合根以必填的 `workerEntry` 传入。组合根、HTTP 层（原 `gateway` 模块，现为 daemon 的 `http/`）、诊断日志与 Worker 入口已移为 `packages/daemon`，`rollout` 命令移为 `packages/cli`，Next.js 控制台移为 `packages/console`（按依赖图只能导入 `@harnesshub/sdk`，边界检查扫描其 `app/`、`components/` 与 `lib/`）；`src/` 已删除，测试由 `tests/tsconfig.json` 编译到 `dist/tests`，并经 `tests/support/entries.ts` 取得各编译入口的路径；只测试单个包的单元测试位于该包的 `test/`，以相对路径导入本包源码（`../src/<文件>.js`），其他包仍经 `@harnesshub/<包>/<文件>` 导入，跨包或依赖 `tests/support` 的单元测试留在 `tests/unit`。`hh` 命令是 `apps/hh`（npm 包名 `harnesshub`），把 `serve`、`benchmark` 与 `tools` 分派给守护进程、`rollout` 分派给 cli 各自导出的 `main(argv)`。`node:sqlite` 只能在 store 的 `storage` 中使用；`node:child_process` 只能在 runtime 的 `process/` 中使用，其他包经注入的 `ProcessLauncher` 启动子进程，没有例外（见[并发错误与资源](#并发错误与资源)）；Worker 入口可以导入 runtime 的 `process/` 以创建本进程的启动器；越出包的 `new URL` 没有例外；agents 的运行时资源在包内 `assets/`，迁移前保存的旧路径只按本包所在的检出目录识别。包之间只能按 [02 第 8 节](proposals/oss/02-architecture.md#8-模块与依赖规则) 的依赖图导入；包内的相对导入与 `new URL(..., import.meta.url)` 不得离开所在包。

包级边界（OSS-005，[10 第 1 节](proposals/oss/10-engineering.md#1-仓库结构)）由 [边界检查](../tools/check-boundaries.mjs) 分两层执行，每条规则有拒绝样例，任何违反都使命令以非零状态退出：

- 清单：`packages/` 与 `apps/` 下每个 `package.json` 在任一依赖字段中声明的 `@harnesshub/*` 内部依赖，必须是它在依赖图中那一项的子集；包名必须与目录对应（`@harnesshub/<目录>`，应用 `hh` 为 `harnesshub`）。缺少 `package.json` 的包或应用是错误。
- 源码：静态导入、动态导入、类型导入、`import()` 类型与 re-export 只能指向所在包声明的依赖，内部包与第三方包相同，因此 workspace 的提升（根 `node_modules` 中的包）不会掩盖缺失的声明；Node 内置模块不需要声明。`src/`、控制台的源码目录、agents 的 `assets/` 与应用的 `bin/` 可以使用 `dependencies`、`peerDependencies` 与 `optionalDependencies`，`test/` 还可以使用 `devDependencies`。根目录的 `tests/` 按根 `package.json` 的声明检查（测试依赖是它的 `devDependencies`），相对导入不得离开 `tests/`，测试可以按计算出的路径动态加载夹具。第三方包因此只能出现在声明它的包中。
- 黑盒：`conformance/`、`tests/e2e/`、`tests/browser/` 与 `examples/`（存在者）只能使用 `@harnesshub/core`、`@harnesshub/sdk`、Node 内置模块（HTTP 与启动 `hh` 命令）及本目录内的文件，`new URL(..., import.meta.url)` 也不得离开本目录。唯一的例外：`conformance/` 可以导入官方协议客户端 `openai`、`@anthropic-ai/sdk` 与 `@google/genai`，且必须是根 `package.json` 中按精确版本固定的开发依赖（[ADR 0029](decisions/0029-protocol-suite.md)）。目前有 `conformance/` 与 `examples/`。
- 程序目录：agents 的 `assets/` 与应用的 `bin/` 随包发布、按路径运行，执行上述声明依赖规则，相对导入不得离开所在包（`bin/hh.mjs` 导入 `../dist/src/main.js` 可以）；不执行模块归属规则，因为 assets 中的启动器自己启动所包装的引擎，[ADR 0017 F08 补充](decisions/0017-package-layout-migration.md#补充子进程创建收口f082026-10-02)（范围）已说明它们不经 `ProcessLauncher`。计算出的动态导入在这里会失败，只有 `assets/native-mcp/pi-extension.mjs` 是登记的例外：它从引擎自己的安装中加载 MCP SDK。
- 尚未执行：公开类型不得暴露第三方类型，留给 API Extractor 报告（[10 第 2 节](proposals/oss/10-engineering.md#2-代码规范)）。

原 `src/` 的迁移期规则（`src/` 只能经别名表导入已迁出的包、按迁入目标包检查依赖图）随 `src/` 删除而退役；原模块规则仍经 `PACKAGE_ORIGINS` 适用于包内文件。

具体实现由启动组合根注入。公共端口由其调用方所需语义定义，不能为了方便第三方 SDK 直接透出原始类型。类型导入、动态 import 和 re-export 也受模块边界约束。

新增模块必须有当前使用方、单一职责和明确失败语义。避免通用 `utils` 聚集业务规则、重复状态缓存、跨模块读私有字段、为未来可能性预建平行实现。确需新增能力时优先复用维护良好且能减少自有代码的依赖。

## 类型与公共接口

业务代码使用 TypeScript strict/ESM。首个工具链启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride` 和 `noFallthroughCasesInSwitch`。启动脚本与零依赖仓库工具可使用有文档的 `.mjs`；这不扩大业务代码的语言范围。

SessionId、RunId、WorkerId、PermissionId 等跨接口 opaque ID 使用不同品牌类型。封闭状态联合按判别字段穷尽处理；扩展事件的未知类型行为明确说明，不用无条件 default 吞掉必需事件。

HTTP、配置文件、Worker IPC、引擎输出和持久记录入口使用 `unknown` 并验证 schema；随后传递经过校验的类型。同进程已受类型保证的内部值不重复加入兜底逻辑。`any`、双重断言和禁用类型检查仅允许最小外部适配范围，并说明原因、验证方式与去除条件。

公共函数、类和类型的说明写在声明处，包含非显然的参数限制、返回结果、错误、幂等性、取消、顺序和资源所有权。由接口继承的同一说明不在每个实现重复。详细标准见 [JSDoc 与示例](documentation.md#jsdoc-与示例)。

## 并发错误与资源

一个异步操作有一个生命周期控制器。需要另外的取消、就绪、终态或清理状态时，必须说明其独立事实或确认点，避免多处布尔标记各自决定同一结果。

跨 await 的操作先捕获所属 runId/generation 与配置快照，完成时重新核对归属。对外暴露前完成校验和必要的持久提交；中途失败释放已获取资源。所有后台 Promise 必须有观察者、错误归属及停止方式。

清理顺序为停止接收新工作 → 解除或隔离回调 → 请求取消 → 等待退出 → 必要时升级终止 → 核实残留 → 释放资源。清理必须幂等且可等待；发出 abort/kill 不等于完成。清理失败单独报告，不覆盖原始执行错误。

子进程只经 `@harnesshub/core/process-launcher` 的 `ProcessLauncher` 启动（OSS-010 F08）。实现在 runtime 的 `process/`，那里也是 Worker 宿主、Job 辅助程序、配置探测与进程表扫描的位置，是唯一可以导入 `node:child_process` 的包内位置；`tools/` 与 agents 的 `assets/`（引擎按路径运行的启动器）不在边界检查的扫描范围内。每个进程入口（`startHub`、Worker、command MCP 入口、工具包命令）创建并注入本进程的启动器：drivers 与 secrets 由调用方传入，agents 的 command MCP 服务器由其入口传入，store 的 Windows 文件原语由组合根启动时设置一次。启动器不经 shell、不在 Windows 上打开控制台窗口；环境必须显式给出，只有写明 `"inherit"` 才继承当前进程环境；超时、`AbortSignal` 与 `maxBuffer` 由启动器执行，终止信号发出 2 秒后进程仍在运行则发 SIGKILL；Windows 上 libuv 会为显式环境补上一组必需的系统变量（见 `ProcessEnvironment`），不能依靠显式环境隐藏它们。启动器只向它启动的进程发信号，进程留在 Worker 的进程组或 Job Object 中，后代由它们与 F07 的回收负责；acpx 启动的 ACP 引擎与 agents `assets/` 中的启动器也在其中运行，但不经启动器。每个启动的进程有所有者：调用方等待 `exit`（或 `run` 的结果），启动器的所有者在关闭时终止并等待仍在运行的进程。

子进程的管道出错（读取失败，或写入进程已关闭的 stdin 得到 `EPIPE`）时，所在的流报告 `error` 事件，没有监听者就会结束整个守护进程。启动器因此给它交出的每个管道都挂上监听：`launch` 不替持有者处理，第一次失败记入 `exit`/`closed` 的 `streamFailure`，持有者需要立即知道时自己监听，并决定是否结束进程（不读完输入的进程关闭 stdin 往往无害）；`run` 的 stdout 或 stderr 出错时终止进程并以 `error`（`PROCESS_OUTPUT_FAILED`）报告，无论退出码如何，因为收集到的输出不完整；stdin 出错时同样终止进程，结果由退出决定。runtime `process/` 中不经启动器、直接用 `spawn` 或 `execFile` 的代码（配置探测、Windows Job 辅助程序、进程表扫描、lease 身份检查）自己给每个管道挂监听，`execFile` 也不监听它子进程的管道；没有读完的输出不能当作完整结果。这条规则靠人工审查，由 [启动器测试](../packages/runtime/test/launcher.test.ts) 与 [管道故障测试](../packages/runtime/test/pipe-errors.test.ts) 覆盖现有位置，没有自动检查。

状态变更的校验、提交和事件发布各有明确顺序。不能用“先通知再补写 DB”的方式改善响应速度。跨数据库和文件的操作定义发布、重试和孤儿清理策略，不假定跨介质事务存在。

错误在所属层规范化，保留内部 cause，公开输出去除凭证及敏感路径。best-effort catch 只能包住预期可失败的一项操作，并说明丢弃的错误类别及不影响主结果的原因。观察者异常需要隔离；状态提交、权限或进程归属错误不能按普通观察者错误吞掉。

时间、字节、输出数量和并发限制在所属配置解析器集中解析，在最终执行或保留数据处落实。测试空输入、精确上限、单个超大块和 UTF-8 多字节；不得为绕过缺陷擅自降低用户预算或静默截断。

## 依赖配置与数据迁移

工具链和依赖使用一个包管理器与锁文件。新增依赖说明它替代的自有代码、运行时要求和平台发行成本；更新影响引擎行为的依赖要重跑 Driver 契约和对应真实链路。任务执行阶段不联网安装或使用未固定的 `latest`。

配置依次经历 parse → validate → resolve → immutable spec；默认值、env 优先级和能力不足的行为写在所属配置说明。禁止散落读取 `process.env`、每次 run 暗中补默认或忽略无效配置。

数据库 schemaVersion 单调递增，已进入使用的迁移不原地重写；升级测试从上一受支持版本的真实文件开始。破坏性迁移须有备份、恢复和数据丢失说明，不用删库代替迁移。尚未接触用户数据的开发初始化与已发布数据升级分别处理。

IPC/API、导出事件和配置格式分别版本化。必需字段、未知事件、旧版本读取及不支持版本的响应明确规定；不要因为“pre-1.0”就静默破坏持久数据。兼容路径只为实际受支持版本保留，并写清移除条件。

## 环境文件与运行数据

Worker 启动传入按 Profile 解析的环境快照，不在并行任务中修改父进程的全局环境。模型凭证仅传给明确需要的 Engine；不能宣称凭证已经与其工具后代隔离，除非有对应机制和证据。

仓库仅保存无真实值的 `.env.example`。数据库、真实轨迹、截图、日志和产物放入明确的运行数据目录；共享前脱敏。公开错误和日志不打印整份环境、认证头或原始配置对象。

测试和运行临时目录使用随机私有路径，文件独占创建，权限按平台设置。每个端口、文件、进程与监听器都有所有者。删除前辨别普通目录、符号链接与 Windows junction；只移除自己拥有的资源，不以递归删除扩大清理范围。

## Git 与多 Agent 协作

业务实现前建立 Git 基线并核实工作区；不对已有未提交内容执行 reset、覆盖、清理或无依据还原。按当前分支/团队约定选择独立分支或 worktree；同目录并行时先分配不重叠文件。

跨模块契约由一个负责人先定，子任务围绕固定版本并行。主负责人集成后检查整体依赖与真实入口；各子任务单独通过不能代替组合验收。

提交按行为或可独立审查的阶段划分，代码、测试、迁移与所属文档放在同一变更。提交说明写问题、最终行为、验证和限制；不要把规划标记为实现结果。未获授权不默认推送、发布或改写共享历史；已有授权按其范围继续执行。

初期本地 hooks 保持快速，CI 负责完整检查。不得以 `--no-verify`、全局关闭规则或删除检查绕开失败；发现检查误报时修正判定并加入反例。当前 [CI 配置](../.github/workflows/ci.yml)在 Ubuntu、macOS 与 Windows 上运行 `pnpm check`，PR 另需通过 DCO 签名检查；本地 hooks 尚未安装。检查接入情况见 [检查入口](testing.md#检查入口与接入顺序)。
