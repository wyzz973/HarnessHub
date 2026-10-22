# 测试与验收策略

状态：完整工程测试设计。当前Provider/本机工作台新增验收见[对应记录](../verification/provider-web-2026-10-09.md)；自动择优后置。当前[公共Session验证](../verification/public-session-2026-10-09.md)与[目录/控制基线](../verification/catalog-control-2026-10-09.md)分别记录实际运行。蓝图场景唯一来源为plan/test-cases.json，生成矩阵不作为运行结果；数量不等于覆盖已达成。

## 1. 分层证据

| 层 | 保持真实 | 可以替代 | 证明范围 |
|---|---|---|---|
| Domain unit/property | 聚合状态、策略、不变量、Clock/ID 端口语义 | 时间/ID、纯输入生成 | 状态转换与规则，不证明 IPC/数据库 |
| Storage integration | SQLite 文件、事务、迁移、outbox、CAS 与重启 | 可控 I/O 故障点 | 数据原子性、去重、恢复 |
| Gateway integration | 正式 HTTP、认证、Store、应用服务 | 外部 Harness/模型 | 接收与控制链路，不能同时 mock 自己的存储/Runtime |
| Adapter protocol | 真 Client/SDK、进程/流、协议双方边界 | 固定协议对端或假模型 | 协商、消息、取消、权限、错误/背压 |
| Process/platform | 正式构建入口、真实进程树与文件系统 | 测试工具后代进程 | 启停、残留、租约与平台能力 |
| End-to-end synthetic | 全部自有组件、真实 Store/HTTP/IPC/客户端 | 只有外部 Agent/模型 | 公共 Session 与执行/切换完整闭环 |
| Real harness/provider | 真实二进制（默认对象是该 Harness 官网渠道的最新正式版，[ADR-053](../decisions/0053-latest-version-baseline.md)）、真实模型、权限/文件任务 | 不替代被验收的组件 | 实际组合在记录写明的版本/平台上的证据；版本只作证据，不成为接入条件 |
| Performance/security | 正式入口、负载和攻击场景 | 合成凭据与可控外部服务 | 资源上界和拒绝行为，不能替代业务正确性 |

## 2. 不仅测 happy path

每个公共输入覆盖：空、缺失、类型错误、未知字段、精确上下界、UTF-8、多消息分片、超大一项、重复与冲突身份、未知/过期版本。对外协议覆盖乱序响应、迟到通知、流中错误、stdout 污染、断连和背压。

状态机测试覆盖每条合法迁移与非法迁移；property/model-based 测试产生命令序列并保留 seed。竞态使用 barrier、假 clock、受控 scheduler 与明确握手，禁止靠睡眠猜时序。

交错至少包括：完成/取消/期限/切换/权限/close；两个切换；新消息与交接；目录 drain；目标 Provider 更新；提交/ACK 前后崩溃；模型结算和资源清理之间中断；旧 Worker 迟到事件。

## 3. 故障与恢复

注入写入拒绝、磁盘满、事务提交失败、outbox 重复/丢响应、文件变化、权限失效、进程崩溃、原生 checkpoint 错误、owner lease 丢失和系统时钟跳变。所有测试核对实际资源、持久行与事件，不只断言抛了异常。

没有明确副作用结果的运行在重启后不重放。恢复/交接用例必须验证 workspace 和公共上下文水位，不能只比较对话文本。

## 4. 平台与组合

测试隔离：组合应用、启动 Gateway 或运行 `chat`、`sessions`、`web` 命令的测试，必须使用测试自己的临时工作区租约目录（`workspaceLockRoot` 或 `--workspace-lock-root`），不得写入每个本机用户共用的 `/tmp/harnessgateway-workspaces-<uid>`（[ADR-041](../decisions/0041-workspace-lock-root.md)）。检查方式：`pnpm check:boundaries` 的 B8 拒绝没有给出 `workspaceLockRoot` 的 `application(` 和 `startWebServer(` 调用，B9 拒绝没有带 `--workspace-lock-root` 的 `web`、`chat`、`sessions` 启动（规则与范围限度见[开发与工程规则](development.md#模块边界检查g063)）；经其他文件的辅助函数组合、`.mjs` 夹具和不带参数的 `resolveWorkspaceLockRoot()` 不在静态检查内，仍以完整测试前后对比共享目录的文件数核对。

平台只面向 macOS（[ADR-044](../decisions/0044-macos-official-channels.md)）：进程组、脱离组后代、父进程先退出、中文/空格路径、软链接与权限在 macOS 上验证。Windows、Linux 不再计划和验证，报告里不再列“未验证”，直接写明只面向 macOS；跳过的必需检查仍不能算通过。

安装测试（ADR-044）同样不碰本机真实安装：脚本由测试内的假下载提供，在真实的 macOS 沙箱里运行，装到临时家目录；npm 安装连接本机的假 npm 仓库，装到临时前缀。真实安装只由用户点击。

卸载测试（ADR-044）不碰本机真实安装：脚本渠道用临时家目录，npm 渠道用临时前缀和本地打包的测试包，服务停止用不改动本机的替身；只读的 `ps`、`launchctl list` 可以照常运行。真实卸载只由用户点击。

安装策略：正式入口默认只认官网渠道（ADR-044）。用测试假程序或发现清单的测试必须显式使用开发策略：组合时传 `installations: "any"`，命令行加 `--allow-unofficial`。检查方式：命令行一半由 B9 自动检查（`--manifest` 必须同时传 `--allow-unofficial`，没有登记的例外）；组合一半（`installations: "any"`）尚无自动检查，靠人工审查新增的组合点，漏传时这类测试会因 Harness 未安装而失败。

真实组合按 Harness、Adapter、protocol/SDK、Provider/模型、OS/架构、权限/工具、恢复等级记录。至少验证两个 Harness 与两个兼容模型目标的独立切换，包含 A→B→A。

## 5. 覆盖指标与质量

不能为了达标删除失败测试或降低断言。关键不变量和状态迁移要求 100% 具名场景覆盖；数据驱动矩阵验证必需失败类别。代码覆盖率门槛在 G001 工具链与基线任务实测后冻结，不用随意的百分比冒充充分测试。

对关键仲裁、路由过滤、权限、幂等与 epoch fencing 做定向 mutation 测试，保证错误实现会被拒绝。ACP TCK 仅补充协议覆盖，且官方说明其为实验性、不完整，不把通过称为官方认证。

tools 自检随 `pnpm check` 运行（`check:tools`，即 `python3 -I -B -m unittest discover -s tools -p 'test_*.py'`）：设计检查每条规则的无效样例都在其中，新增规则时同次补样例，并以临时关闭该规则的变异核对证明样例会失败。

首阶段性能目标先测量基线：接收、首事件、路由、持久提交、取消/清理、切换延迟；流式峰值内存、队列与句柄、慢客户端恢复。硬门槛在容量和环境固定后记录，不能临时放宽以通过。

## 6. 验证记录

记录 commit、任务/需求/场景 ID、平台、版本、fixture/seed、精确命令、结果、事件/产物/清理、跳过和局限。真实数据脱敏，不提交凭据。测试检查自身也必须有无效样例与非零退出证明。

真实验收记录的格式（证据头：commit、安装策略、每个 Harness 的渠道/版本/角色，不含路径）与真实套件集合、共享配置守护清单见 [真实验收手册](real-acceptance.md)。能力矩阵里真实验收为通过或部分通过的格至少引用一项仓库内的记录，`.tmp/` 文件只作补充（设计检查规则，ADR-048 裁决 5）。
