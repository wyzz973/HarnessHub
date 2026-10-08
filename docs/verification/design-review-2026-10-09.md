# 研究与设计检查记录

日期：2026-10-09。宿主：macOS。本记录只说明研究资料、计划结构与独立阅读评审；没有应用实现，没有真实 Harness/Provider 或平台执行验收。

## 实际检查

运行 python3 tools/check_design.py --write --verify-cache：通过。26 个需求、81 个任务（8 verification、10 contract、63 implementation）、285 个 planned 场景；应用实现允许标志为 false；业务运行测试数量为 0。

运行 python3 -m unittest discover -s tools -p 'test_*.py' -v：26 项检查器测试通过。包含重复 ID、路径重叠/大小写、依赖环、缺需求场景、错误 owner、虚假 runtime success、过期生成内容、死链接、越界、缺缓存、未覆盖不变量、应用代码提前出现及 CLI 非零退出等接受/拒绝样例。

来源校验：16 个仓库的 57 份固定文件 SHA-256 及 6 份官方网页快照匹配。获取失败的旧 Codex v2.rs 路径已记录并改为实际拆分文件，未掩盖失败。

## 独立评审与修订

协议评审：选读范围中的 ACP、原生 Harness、恢复策略和许可描述没有发现必须修改的事实错误；补明 MCP 旧版可选 HTTP Session 与 initialize 的区别，并把 MCP 两版等官方正文快照纳入离线来源锁。

领域评审指出并在设计层关闭两项 P1：旧 outbox 首次投递可能在取消后启动；旧 owner 暂停后复活可能形成双仲裁。修订为 ExecutionGrant/controlSeq/取消 tombstone 与 OS 排他锁/ownerGeneration/禁止TTL接管；加入 INV-27/28 和对应交错场景。设计关闭不等于实现已验证。

任务评审指出四项：精确 schema 被错误放在 G1 之后、Adapter 正式入口验收的隐形环、管理 API 缺 owner、存储失败活执行收敛漏测。修订为 C001–C010 在 G1 前冻结及 V008 评审；Adapter 先做协议验证、G060 负责正式入口；G061/G062 管理路由；补充活工具/模型期间存储失败与恢复场景。

补充内部复核：边界检查 G063 早于端口实现；G013 实际能力 probe 依赖具体 Adapter；CLI/UI 的完整链路场景依赖正式组合根。所有任务按 DAG，而不是 ID 顺序执行。

二轮计划复核确认四项原问题在计划层关闭，指出 ADR 冻结缺少文件 owner；已分配独立 ADR 到对应 C 任务、索引到 V008，并增加接受状态/证据和缺失时阻塞 G1 的场景。当前 ADR 仍全部 proposed，没有自动提升状态。

末轮限定复核确认 ADR owner 缺口已在计划层关闭，没有新增限定范围内问题；285 个场景仍为 planned，G1 仍未通过。

## 未验证与门禁

尚未完成 V/C 任务的实际能力报告和精确契约冻结；未安装应用依赖，未建立 HTTP 服务/SDK/UI/Runtime。真实模型、真实 Harness 接续、Windows/Linux 原生行为、性能、mutation 和安全运行矩阵均未运行。

检查通过不打开应用实现门禁。下一阶段先完成受控验证、精确契约和独立就绪评审，再按依赖启动应用任务。
