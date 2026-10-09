# HarnessGateway

工作名，2026-10-09 建立。目标是一个统一的 Harness 聚合网关：用户通过一个入口持续对话或发送命令，网关管理不同 Harness 的接入、选择、执行和交接；公共 Session 不绑定某个厂商的原生会话。

当前先做本机核心 MVP。已实现离线目录 v2、只读安装发现、通用 ACP 与 Codex App Server 控制连接，以及 probe/run 命令。默认目录含 43 个产品、47 个控制入口，数量不代表全部已可执行。公共 Session、持久历史、自动路由与切换尚未实现。研究、实现、合成测试与真实 Harness 验收分别记录。

## 第一阶段

统一入口、公共 Session、可扩展的 Harness 注册与适配、可解释的自动选择与用户指定、受控执行、权限与取消、上下文接续、切换、持久事件和程序接入。

自动选择表示在当前能力、策略和已有评测证据下选出合适执行者，不声称存在未经测量的绝对最优 Harness。接续公共上下文不表示可以搬运不同 Harness 的内部状态。

旧 HarnessHub 保留为独立研究材料；新项目不继承它的存储格式、目录结构或 Session 绑定模型。跨平台适配、发布和 Harness 多发行版矩阵延后，先完成当前宿主核心链路。

## 先运行检测

要求 Node.js 24 或以上、pnpm 10.12.3。使用实际安装的 Node，不建立多版本矩阵；依赖保留锁文件。

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm catalog
pnpm discover
pnpm --silent discover --json
pnpm --silent discover --legacy --json
pnpm discover --manifest examples/discovery-manifest.json
pnpm probe --harness codex --json
pnpm probe --harness gemini --json
pnpm test
pnpm test:real:codex
~~~

discover 默认输出 schemaVersion=2，分别展示配置线索、多个安装和控制依赖；它不执行找到的程序或下载包。v1 描述可显式迁移；旧 JSON 使用方可用 --legacy 保留 schemaVersion=1。通过 v2 描述和 --package-root 指定已有包可扩展目录。详见[当前契约](docs/contracts/catalog-control.md)与[旧 v1 契约](docs/contracts/discovery.md)。

probe 主动启动所选控制入口并初始化，输出 NDJSON 协议观察与独立清理证据；它不发送 prompt。run:harness 明确发送一次文本，输出流/后端结果/清理，不创建公共 Session，也不承诺任务正确性。多个可用控制入口必须 --control 指定，不自动替换。默认配置与工作目录临时隔离；实际模型调用需 --config-home 指向已准备的私有配置根，并按需要给 --cwd 绝对路径。

pnpm test 使用真实文件系统与协议子进程夹具；test:real:codex 是独立显式验收，需要本机已安装 Codex，使用真实 Harness 和本地模拟 Responses Provider、临时配置与测试 key，不使用个人登录。当前实际结果见[验证记录](docs/verification/catalog-control-2026-10-09.md)。

## 从这里阅读

- [工程文档入口](docs/README.md)：按产品、研究、DDD、契约、工程、任务和门禁顺序阅读。
- [第一阶段范围](docs/product/phase-1.md)：统一入口、公共 Session、自动分配和安全接续。
- [调研与固定证据](docs/research/README.md)：16 个仓库、68 份固定文件，以及 6 份官方协议网页快照。
- [发现与适配扩展方案](docs/proposals/harness-discovery-adaptation.md)：最新 CC Switch/Magpie 研究；目录与控制切片已实现，后续公共 Session/切换仍按独立切片推进。
- [DDD 上下文](docs/domain/context-map.md)与[运行不变量](docs/domain/invariants.md)。
- [当前 MVP 顺序](docs/engineering/mvp.md)：先检测，再接通控制面和统一对话；切片范围在 plan/slices.json 明确。
- [完整任务地图](TASKS.md)：保留未来工程分解，不让后置平台/发布事项阻塞已冻结的独立本机切片。
- [测试计划](docs/engineering/testing.md)与[场景矩阵](docs/engineering/test-matrix.md)：保留 285 个完整蓝图场景，含后置项目；当前实际测试见[验证记录](docs/verification/catalog-control-2026-10-09.md)。
- [范围与门禁](docs/engineering/readiness.md)：目录与受控控制连接已开放，公共 Session/完整执行/切换仍需各自最小契约。
- [目录与控制验证](docs/verification/catalog-control-2026-10-09.md)：当前实现、测试和未验证范围；[旧检测记录](docs/verification/discovery-2026-10-09.md)与[初始设计记录](docs/verification/design-review-2026-10-09.md)保留基线证据。

## 现在可运行的检查

只需 Python 3 标准库，不安装应用依赖：

~~~sh
python3 tools/check_design.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
~~~

修改 plan 中的结构化来源后运行 python3 tools/check_design.py --write 更新人读清单，再运行默认检查。仅本机已抓取缓存可追加 --verify-cache 核对内容 SHA-256；缓存不入库，其他机器必须重新取得对应来源才能执行该项检查。版本化网页可能重新渲染，哈希变化需要重新审阅，不自动改来源锁。

设计检查实际保证 ID/依赖、唯一路径所有权（含大小写/NFC）、获准切片源码范围、需求/测试关联、生成新鲜度、简单相对文件链接及来源元数据。它不证明任务语义天然原子、DDD 正确、外部 URL 永久有效、Markdown 全语法、运行时行为或平台能力。
