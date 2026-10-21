# 开发与工程规则

状态：按已接受的本机切片实施；严格 TypeScript 工具链、目录和受控控制连接已建立，完整 CI 尚未实现。当前实际命令以 README/package.json 和 tools 为准。

## 1. 工作顺序

先读产品、来源、领域、不变量、所属契约与任务。明确可观察行为、失败/并发边界、输入输出和所有权，再冻结契约、写失败用例、实现最小功能、验证正式入口、更新证据。

每项任务只实现其需求和所有权路径。发现需要改另一个 owner 的文件时先调整任务依赖并串行交付，不能私自扩大范围。共享契约先完成，组合根由专属任务集成；各模块通过不能代替整条链路通过。

## 2. DDD 与类型

业务不变量在领域聚合/策略中；应用层协调端口、事务与外部作用。Repository 面向聚合语义，禁止给业务公开万能 SQL 或通用 CRUD 基类。跨上下文只用发布契约和 ID；第三方消息类型不泄露到领域层。

首选 TypeScript 时启用 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、穷尽联合和独立品牌 ID。外部输入先 unknown，经所属边界 schema 校验后进入业务类型。禁止双重断言、无依据默认值、吞异常、静默类型兼容和宽泛 any。

默认值与所有上限在一个配置解析入口收敛；支持范围、错误与迁移文档同步。领域 Clock、ID、Store、ProcessHost、Adapter 等由端口注入，不散落读环境或使用真实时间。

### 模块边界检查（G063）

模块边界由 `tools/check-boundaries.mjs` 自动检查（`pnpm check:boundaries`，已并入 `pnpm check`），规则见 [tools/boundary-rules.json](../../tools/boundary-rules.json)：每条规则登记适用目录、允许或禁止的导入和显式例外；例外按 `file`、`key`（被导入的仓库路径、node 模块或包名；B8 是被调用的函数，B9 是缺少的标志）和 `reason` 登记，import 类的可限定 `typeOnly`，`count` 限定出现次数；它登记的是现状，不是新代码的许可，原因里写明消除办法。不再对应任何代码的例外使检查失败。检查用 TypeScript 解析 `src`、`web/src`、`tests` 里的 import、export from、动态 `import()`、`require` 和 import 类型，违规按 `文件:行 规则ID 说明` 输出并以非零退出；`--root`、`--rules` 可指向其他目录和规则文件，无效样例就这样运行。

| 规则 | 约束 |
|---|---|
| B1 | 领域层 `src/contexts/*/domain` 只依赖契约层和同层领域代码；node 内置模块限 path、crypto、buffer、util、url、string_decoder 等纯计算模块，不碰文件、网络、数据库、子进程，也不用任何第三方包 |
| B2 | 应用层 `src/contexts/*/application` 依赖契约层、领域层和同层代码；node 内置模块同 B1，另允许 events、perf_hooks；I/O 由注入的端口承担 |
| B3 | 契约层 `src/contracts` 只导入契约层：不含 node 内置模块和第三方包，不依赖其他层。现状有三处例外，`control.ts` 两处、`management.ts` 一处，都是对 `contexts/catalog/domain` 的 `import type` |
| B4 | `src/contexts/<a>` 不导入 `src/contexts/<b>`，跨上下文只经 `src/contracts` |
| B5 | `src/adapters` 不导入 `src/web` 和 `src/cli` |
| B6 | 前端 `web/src` 只引用自身和 `src/contracts`，不引用 node 内置模块；前端自己的第三方依赖不受限 |
| B7 | `src` 不导入 `tests` 和前端目录 `web`；`src/web` 是网关的服务端代码，不受此限 |
| B8 | 测试里每次 `application(` 和 `startWebServer(` 必须在调用处给出 `workspaceLockRoot`，`startWebServer` 也可以改传自带租约目录的 `application` 组合器，不得落到各用户共用的租约目录（[ADR-041](../decisions/0041-workspace-lock-root.md)） |
| B9 | 测试启动正式命令 `web`、`chat`、`sessions` 必须带 `--workspace-lock-root`，带 `--help` 或 `-h` 的除外；传 `--manifest` 必须同时传 `--allow-unofficial`，否则清单被忽略（[ADR-041](../decisions/0041-workspace-lock-root.md)、[ADR-044](../decisions/0044-macos-official-channels.md)）。现有一处例外：`login-shell.test.ts` 传了没有任何定义的清单 |
| B10 | 第三方包只允许出现在 `src/infrastructure` 和 `src/adapters`，且限于 semver、yaml、jsonc-parser、tar、smol-toml、json5、yauzl、unbzip2-stream |
| B0 | 检查自身的完整性：文件无法解析、扫描目录缺失或没有源码、无法归类的导入（非字面量的 `import()`、指向仓库外的相对路径）、不再对应代码的例外。B0 不能登记例外 |

检查按文件静态分析，不跨文件追踪值。B8、B9 只认调用处或同一文件内辅助函数里写出的选项和参数：经其他文件传入的会被判为“看不见”而失败，处理办法是在调用处或同文件的辅助函数里写明；同文件的辅助函数只追踪直接调用的实参，作为回调传递的不追踪，靠 `push` 之类的修改补上的参数列表也不追踪（会被判为缺少）。命令路径要以 `…/src/cli/web.js` 这样的整串出现才会被认作正式命令。`.mjs` 夹具、`/// <reference>` 指令和用路径串拼出的依赖不在检查范围内。公开类型面检查（`tools/check-contract-surface.mjs`）尚未实现，G063 的这一半仍是计划。

新增规则必须附无效样例：样例放在 [tools/fixtures/boundaries](../../tools/fixtures/boundaries/README.md)，由 `tests/integration/g063.test.ts` 逐行核对，并要求每条规则至少有一个样例；该测试也核对检查对真实代码、缺失目录、无法解析的文件和过期例外都以非零退出。

## 3. 异步、存储与资源

await 前固定 Attempt/epoch/generation 与配置快照，await 后核对归属。后台任务、定时器、流、信号与进程都有 owner、上限和可等待关闭；取消请求不能等同资源已释放。

状态/事件/outbox 的提交与发布顺序由契约拥有。存储失败不能伪造成功；未知执行不重跑。编号迁移不能覆写历史；持久格式未知版本明确失败。

输入与原始诊断有字节上限，输出可转受控产物。错误分类稳定，公开信息脱敏；日志失败不掩盖业务失败，日志也不能成为业务状态权威。

## 4. 依赖与环境

依赖使用精确版本和锁文件，记录许可证、供给来源、安装步骤、版本兼容与升级影响。正式运行不执行临时 npx/uvx 下载或自动升级 Harness。ADR-012显式用户安装/升级动作通过受管任务按已审核配方下载，使用私有版本与缓存；该授权不变成自动安装、宿主全局修改或未知重跑。SDK 封装仅允许所属 Adapter 依赖。

测试使用私有临时数据、端口和受控变量，不读取用户真实配置/凭据。当前只面向 macOS（ADR-044），原生 Helper 与进程监督在 macOS 上验证；已有的 Windows 分支保留但不扩展。

## 5. Git 与文档

新项目保持独立仓库；旧项目研究只读。任务前核对 diff，不覆盖他人改动。不默认推送、发布、改写历史或修改全局设置。

需求/任务/测试 JSON 是唯一可生成清单来源；设计正文负责业务含义，ADR 负责取舍，验证记录负责实际结果。重要取舍 proposed → accepted 的证据和影响明确；测试状态与设计状态不共用勾选。
