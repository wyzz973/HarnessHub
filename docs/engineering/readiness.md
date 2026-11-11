# 设计就绪与开始开发的门禁

> 2026-11-11 起不再适用：项目改为快速迭代（见 [AGENTS.md](../../AGENTS.md)），本文与 `plan/` 下的登记只作历史参考，不再更新，也不卡检查。

更新：2026-10-22。两个常为 false 的门禁标志（`plan/tasks.json` 的 `application_implementation_allowed`、`plan/slices.json` 的 `gateway_execution_implementation_allowed`）已删除（[ADR-048](../decisions/0048-harness-scope-and-workbuddy.md) 第 6 项，审批代理裁决）：源码范围只由各已接受切片的 `allowed_files` 放开，`src/`、`web/` 下不在其中的文件被设计检查拒绝，没有任何已接受切片时这两个目录下的每个文件都被拒绝；原“后续实现门禁”一节同日改写为下文“完成定义的门禁（G0～G5）”——它们是宣称一项功能完成时分别出示的五层证据，不阻塞已接受的切片。此前（2026-10-09）当前按本机MVP推进。ADR-008/009及[ADR-010](../decisions/0010-public-session-mvp.md)认可S01–S04限定范围，目录/控制/公共Session/手动切换已实现。另[ADR-011](../decisions/0011-provider-web-mvp.md)认可Provider/本机HTTP工作台，自动择优明确后置。

当前范围见 plan/slices.json 与 [MVP](mvp.md)。切片认可只允许所列 owner 路径，不能自动解锁 Session/执行/切换；设计检查有合法范围与越界源码拒绝样例。

## 已具备的材料

产品范围和统一入口；主来源协议与固定仓库快照；DDD 语言/上下文/聚合责任；主要运行与交接契约；路由证据和安全边界；原子任务 DAG/所有权；需求-测试追溯；AI 工程工作流与实际设计检查。

这些材料可以评审，不等于已经“准备好开始全部业务编码”。结构检查通过只说明资料结构一致。

## 开始应用实现前必须关闭的设计问题

| ID | 问题 | 关闭证据 | 当前 |
|---|---|---|---|
| D-01 | OpenCode ACP 与 Codex App Server 的实际接入版本、模型配置、权限与停止能力 | 固定 schema；受控 probe 报告与实际记录 | Codex/Gemini握手、Codex+本地模拟Provider通过；OpenCode本机SIGKILL未通过，真实模型/完整权限仍未验证 |
| D-02 | 公共Session/Run/命令/日志与执行控制 | 本机切片单一schema、反例、事务/CAS/幂等与Owner验证 | 本机S03已实现；完整跨上下文outbox/模型账本仍未来 |
| D-03 | busy switch模式与失败/并发 | FIFO wait_current、source IDs、目标失败不回退、barrier竞态 | ADR010本机已采纳实现，其他模式后续 |
| D-04 | 公共上下文/大小/水位 | 完整有界已终结历史、未来输入拒绝、重开真实Codex验证 | public_context_rehydrate已实现，不是native_resume |
| D-05 | 当前宿主监督、owner排他/fencing | 进程组/SQLite长期OS锁/代次/跨根workspace lease | 本机已验证；未知writer quarantine不自动修复；其他平台后置 |
| D-06 | 当前宿主工具链及实际接入依赖 | 记录实际版本与锁文件，按使用到的依赖验证；不建立多发行版矩阵 | S01 工具链已建立；执行依赖后续逐项引入 |
| D-07 | 自动路由的质量声明与基线 | G1 前冻结规则、评测方案与无质量证据时的文案限制；宣称质量择优前取得真实保留集结果与不确定性 | 方案待冻结，质量未实测 |

设计评审通过后先进行独立、受控的协议/工具链验证，再冻结相关决定；不能用一个大“框架搭建”任务把这些未决问题藏进代码。受控验证是否执行与应用实现分开记录。

实施顺序明确为：V001–V007 受控验证与语义评审 → C001–C010 精确 schema/端口/OpenAPI 及有效无效样例冻结 → V008 独立就绪评审 → G001 起的应用实现。C 任务是设计交付，不依赖 G1 以后的实现代码；G 类型任务只消费/生成这些契约，不重新定义它们，避免“先实现再冻结”的门禁循环。

任务 ID 不是执行顺序，实际按依赖拓扑推进。静态边界检查 G063 在公共端口实现前接入，依赖边界与测试隔离规则已落地（2026-10-21，`pnpm check:boundaries` 并入 `pnpm check`，规则见[开发与工程规则](development.md#模块边界检查g063)），公开类型面检查 `tools/check-contract-surface.mjs` 尚未实现；实际能力 probe G013 在具体 Adapter 可用后验收；Adapter 自身先做协议级验证，正式 G059 入口的双 Harness 验收集中在 G060；CLI/UI 的完整入口测试也依赖 G059。

相关 ADR 的独立文件由所属 C 任务交付，V008 独占索引维护和就绪核对；核心 ADR 的接受状态、验证引用或独立记录缺失时 G1 继续关闭。此项不是当前结构检查能够替代的语义评审。

## 完成定义的门禁（G0～G5）

按 [ADR-048](../decisions/0048-harness-scope-and-workbuddy.md) 的五层完成定义改写（2026-10-22，审批代理裁决）。`plan/tasks.json` 的 `gate` 字段只区分设计交付（验证与契约任务为 G0）与实现（G 类任务为 G1），由设计检查校验，字段值不随本节改变；下面各层是对一项功能宣称完成时要分别出示的证据，不是任务字段，也不能互相替代。

- G0 资料可追溯：plan（需求、任务、场景）、docs 与 `docs/research/source-lock.json` 互相引用一致，设计检查通过。
- G1 设计采纳：切片的 ADR 为 accepted 并登记在 `plan/slices.json`；源码在该切片的 `allowed_files` 内。
- G2 测试通过：对应层（unit、integration、protocol、browser）的测试与 tools 自检（`pnpm check:tools`）通过；新增的检查规则有无效样例证明会拒绝错误。
- G3 正式入口链路通过：经 Gateway/CLI 正式入口的集成通过；SQLite、IPC 与进程保持真实，只替代外部 Harness 与模型。
- G4 真实引擎通过：在本机官网安装的、验收当日各家最新正式版上经正式入口真实通过，`docs/verification/` 有写明命令、版本、渠道与局限的记录；版本只作证据，代码不读它（[ADR-053](../decisions/0053-latest-version-baseline.md)，2026-10-22；原为“`VERIFIED_VERSIONS` 所记的版本”）。
- G5 平台：并入“只面向 macOS”（[ADR-044](../decisions/0044-macos-official-channels.md)），不再单列发行平台、容量与恢复门禁；性能与安全按各自任务的证据表述。

没有测试代码或没有宿主时写 planned/未验证，不写 passed。各本机切片先完成必要设计和测试再实现；一项功能走到哪一层就如实报告到哪一层，不把低层的证据写成高层通过。
