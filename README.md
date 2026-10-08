# HarnessGateway

工作名，2026-10-09 建立。目标是一个统一的 Harness 聚合网关：用户通过一个入口持续对话或发送命令，网关管理不同 Harness 的接入、选择、执行和交接；公共 Session 不绑定某个厂商的原生会话。

当前仅进行研究、领域建模与工程设计，尚无应用实现。研究证据、设计建议、已接受决定、代码实现、测试通过和真实 Harness 验收分别记录。

## 第一阶段

统一入口、公共 Session、可扩展的 Harness 注册与适配、可解释的自动选择与用户指定、受控执行、权限与取消、上下文接续、切换、持久事件和程序接入。

自动选择表示在当前能力、策略和已有评测证据下选出合适执行者，不声称存在未经测量的绝对最优 Harness。接续公共上下文不表示可以搬运不同 Harness 的内部状态。

旧 HarnessHub 保留为独立研究材料；新项目不继承它的存储格式、目录结构或 Session 绑定模型。本仓库没有 src、ui 或 native 应用实现目录。

## 从这里阅读

- [工程文档入口](docs/README.md)：按产品、研究、DDD、契约、工程、任务和门禁顺序阅读。
- [第一阶段范围](docs/product/phase-1.md)：统一入口、公共 Session、自动分配和安全接续。
- [调研与固定证据](docs/research/README.md)：16 个仓库、57 份固定文件，以及 6 份官方协议网页快照。
- [DDD 上下文](docs/domain/context-map.md)与[运行不变量](docs/domain/invariants.md)。
- [原子任务清单](TASKS.md)：8 项受控验证/评审、10 项应用实现前的契约冻结、63 项实现与验收任务。编号不表示实施顺序，按依赖拓扑推进。
- [测试计划](docs/engineering/testing.md)与[场景矩阵](docs/engineering/test-matrix.md)：285 个 planned 场景，尚无业务测试运行。
- [开始开发的门禁](docs/engineering/readiness.md)：当前应用实现门禁保持关闭，具体能力/版本/契约待验证冻结。
- [本轮设计检查记录](docs/verification/design-review-2026-10-09.md)：实际运行结果、评审修订和未验证范围。

## 现在可运行的检查

只需 Python 3 标准库，不安装应用依赖：

~~~sh
python3 tools/check_design.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
~~~

修改 plan 中的结构化来源后运行 python3 tools/check_design.py --write 更新人读清单，再运行默认检查。仅本机已抓取缓存可追加 --verify-cache 核对内容 SHA-256；缓存不入库，其他机器必须重新取得对应来源才能执行该项检查。版本化网页可能重新渲染，哈希变化需要重新审阅，不自动改来源锁。

设计检查实际保证 ID/依赖、唯一路径所有权（含大小写/NFC）、需求/测试关联、生成新鲜度、简单相对文件链接及来源元数据。它不证明任务语义天然原子、DDD 正确、外部 URL 永久有效、Markdown 全语法、运行时行为或平台能力。
