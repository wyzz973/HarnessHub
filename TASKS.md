# 原子任务与唯一交付物

生成自 plan/tasks.json。完整工程地图保留；当前小切片优先级与允许路径见 plan/slices.json 和 docs/engineering/mvp.md。V 为验证/评审，C 为契约，G 为实现。状态不代表真实验证通过，延期不算通过；路径也不表示均已存在。

| ID | 职责 | 前置任务 | 门禁 | 状态 |
|---|---|---|---|---|
| V001 | 验证并锁定工具链与依赖许可 | 无 | G0 | planned |
| V002 | 验证OpenCode ACP的实际能力 | V001 | G0 | planned |
| V003 | 验证Codex App Server的实际能力 | V001 | G0 | planned |
| V004 | 验证双Harness可交接上下文格式 | V002, V003 | G0 | planned |
| V005 | 冻结公共命令与切换默认规则 | V004 | G0 | planned |
| V006 | 验证平台监督边界与首发支持范围 | V001 | G0 | planned |
| V007 | 冻结规则路由的证据与质量声明 | V002, V003 | G0 | planned |
| V008 | 独立复核并冻结G1契约集合 | C001, C002, C003, C004, C005, C006, C007, C008, C009, C010, V006, V007 | G0 | planned |
| C001 | 冻结公共身份与Problem错误契约 | V001 | G0 | planned |
| C002 | 冻结Harness能力与版本描述契约 | C001, V002, V003 | G0 | planned |
| C003 | 冻结Session消息与选择命令契约 | C001, V005 | G0 | planned |
| C004 | 冻结执行授权与结果契约 | C001, V005 | G0 | planned |
| C005 | 冻结持久事件与游标契约 | C001, C004 | G0 | planned |
| C006 | 冻结可交接上下文契约 | C001, V004 | G0 | planned |
| C007 | 冻结路由决策与执行计划契约 | C002, C003, C006, C010, V007 | G0 | planned |
| C008 | 冻结Adapter与存储派发端口语义 | C002, C004, C006, C007 | G0 | planned |
| C009 | 冻结完整OpenAPI与入口操作目录 | C003, C004, C005, C010 | G0 | planned |
| C010 | 冻结Provider模型资源契约 | C001, V002, V003 | G0 | planned |
| G001 | 建立精确可重复的应用工具链 | V001, V008 | G1 | in_progress |
| G002 | 定义公共身份与错误值类型 | G001, C001 | G1 | planned |
| G003 | 从冻结契约生成Harness能力类型 | G002, V002, V003, C002 | G1 | in_progress |
| G004 | 从冻结契约生成Session命令类型 | G002, V005, C003 | G1 | in_progress |
| G005 | 从冻结契约生成执行事件类型 | G002, C004, C005 | G1 | planned |
| G006 | 从冻结契约生成上下文类型 | G002, V004, C006 | G1 | in_progress |
| G007 | 定义防腐Adapter端口与关闭责任 | G003, G005, G006, V002, V003, C008, G063 | G1 | in_progress |
| G008 | 建立事务存储与编号迁移基础 | G004, G005, G006, C008 | G1 | in_progress |
| G009 | 实现本机认证与Session作用域 | G002, G004, G008 | G1 | planned |
| G010 | 实现作用域秘密引用解析 | G008, G009 | G1 | in_progress |
| G011 | 登记Harness不可变revision | G003, G008, G009 | G1 | in_progress |
| G012 | 只读发现已安装Harness | G003, G011 | G1 | in_progress |
| G013 | 收集版本化能力证据 | G007, G011, V002, V003, G033, G034 | G1 | planned |
| G014 | 停用准入并排空Harness | G011, G013 | G1 | planned |
| G015 | 移除Harness并保留历史引用 | G014, G008 | G1 | planned |
| G016 | 登记Provider与模型资源 | G003, G010, C010 | G1 | in_progress |
| G017 | 集中解析运行预算与上限 | G001, G005 | G1 | planned |
| G018 | 创建持久公共Session | G004, G008, G009 | G1 | in_progress |
| G019 | 持久接收消息与执行意图 | G018, G017 | G1 | planned |
| G020 | 实现Session单执行权与有界队列 | G019, G017 | G1 | planned |
| G021 | 过滤Harness候选硬约束 | G013, G016, G017, C007 | G1 | in_progress |
| G022 | 按版本化规则确定性排序 | G021, V007 | G1 | planned |
| G023 | 保存路由决策与准入复核 | G022, G008 | G1 | planned |
| G024 | 构建有界公共ContextManifest | G006, G019, G017 | G1 | planned |
| G025 | 验证交接水位与绑定新鲜度 | G024, G026 | G1 | planned |
| G026 | 授予工作区单写租约 | G008, G017 | G1 | in_progress |
| G027 | 仲裁Attempt状态与唯一终态 | G005, G008, G017 | G1 | planned |
| G028 | 按持久意图幂等派发执行 | G020, G023, G025, G027 | G1 | in_progress |
| G029 | 实现POSIX进程监督与回收 | G007, G017, G027 | G1 | in_progress |
| G030 | 实现Windows Job监督 | G007, G017, G027, V006 | G1 | deferred |
| G031 | 实现ACP v1连接与有界framing | G007, G017, G029 | G1 | in_progress |
| G032 | 实现ACP执行证据映射 | G031, G027, G037, G039 | G1 | in_progress |
| G033 | 配置并验证OpenCode ACP绑定 | G032, G035, V002 | G1 | planned |
| G034 | 实现Codex App Server防腐适配 | G007, G029, G035, G039, V003 | G1 | in_progress |
| G035 | 签发执行作用域模型访问身份 | G009, G010, G016, G027 | G1 | planned |
| G036 | 实现最小兼容Provider转发 | G016, G017 | G1 | planned |
| G037 | 持久模型账本并等待结算屏障 | G035, G036, G008 | G1 | planned |
| G038 | 持久权限请求与决定 | G027, G008 | G1 | planned |
| G039 | 投递权限决定并确认应用 | G007, G038 | G1 | planned |
| G040 | 执行总期限仲裁 | G027, G017 | G1 | planned |
| G041 | 执行幂等取消与升级停止 | G027, G029, G039, G040 | G1 | planned |
| G042 | 采集不可变文件产物 | G026, G017, G008 | G1 | planned |
| G043 | 结算执行并投影公共进展 | G037, G041, G042, G027 | G1 | planned |
| G044 | 提供持久事件游标与有界SSE | G019, G043, G009 | G1 | planned |
| G045 | 提交idle切换并准备目标绑定 | G023, G025, G033, G034, G043 | G1 | planned |
| G046 | 协调busy切换的静止交接 | G045, G041, G026 | G1 | planned |
| G047 | 切换Provider模型并记录接续等级 | G045, G035 | G1 | in_progress |
| G048 | 重启核对执行与绑定归属 | G028, G043, G046, G008, G029 | G1 | planned |
| G049 | 关闭公共Session并收敛资源 | G041, G046, G020 | G1 | planned |
| G050 | 接通Session类HTTP应用入口 | G019, G045, G046, G047, G049, G009, C009 | G1 | in_progress |
| G051 | 接通执行控制与权限HTTP入口 | G043, G044, G039, G041, G009, C009 | G1 | planned |
| G052 | 发布契约生成客户端与流重连 | G050, G051, G061, G062, C009 | G1 | planned |
| G053 | 建立CLI对话命令入口 | G052, G059 | G1 | planned |
| G054 | 建立薄Chat交互视图 | G052, G059 | G1 | in_progress |
| G055 | 建立路由质量基线与保留集 | G059, V007 | G1 | planned |
| G056 | 执行完整切换故障与容量矩阵 | G059, G055 | G1 | planned |
| G057 | 提供有界脱敏诊断与证据导出 | G043, G046, G048 | G1 | planned |
| G058 | 接入不可跳过的CI与发行门禁 | G056, G060, V008, G063 | G1 | planned |
| G059 | 组合单体与正式运行入口 | G001, G014, G015, G028, G030, G033, G034, G043, G044, G046, G047, G048, G049, G050, G051, G052, G057, G061, G062 | G1 | in_progress |
| G060 | 运行真实协议与平台兼容验收 | G059 | G1 | in_progress |
| G061 | 接通Harness管理HTTP入口 | G009, G011, G012, G013, G014, G015, C009 | G1 | in_progress |
| G062 | 接通Provider管理HTTP入口 | G009, G010, G016, C009 | G1 | planned |
| G063 | 建立依赖与公共类型边界检查 | G001, C008 | G1 | planned |

## V001 验证并锁定工具链与依赖许可

范围：验证并锁定工具链与依赖许可；仅交付所列文件与对应行为。

依赖：无。需求：R19, R23, R24。

唯一交付物：
- spikes/v001/version-lock.json
- docs/verification/V001.md
- spikes/v001/verification.json

验收：
- 记录精确版本、来源、许可证和兼容性，未知许可不默认放行
- 不支持版本明确失败，结果可重复
- 不依赖开发者HOME/全局包或临时latest

场景：V001-C01, V001-C02, V001-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V002 验证OpenCode ACP的实际能力

范围：验证OpenCode ACP的实际能力；仅交付所列文件与对应行为。

依赖：V001。需求：R04, R10, R11, R12, R25。

唯一交付物：
- spikes/v002/probe.mjs
- docs/verification/V002.md
- spikes/v002/verification.json

验收：
- 保存wire/SDK/模型/权限和取消的实际支持范围
- 消息/工具/结束来源和拒绝真实可核对
- 区分通知发送、prompt结束和资源清理，缺证据明确列出

场景：V002-C01, V002-C02, V002-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V003 验证Codex App Server的实际能力

范围：验证Codex App Server的实际能力；仅交付所列文件与对应行为。

依赖：V001。需求：R04, R10, R11, R12, R25。

唯一交付物：
- spikes/v003/probe.mjs
- docs/verification/V003.md
- spikes/v003/verification.json

验收：
- 不把原生Thread当公共Session，记录实验能力
- 识别最终turn状态及审批选项，不以ACK判成功
- 明确重建或拒绝条件，不宣称热切换

场景：V003-C01, V003-C02, V003-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V004 验证双Harness可交接上下文格式

范围：验证双Harness可交接上下文格式；仅交付所列文件与对应行为。

依赖：V002, V003。需求：R08, R09。

唯一交付物：
- spikes/v004/context-fixtures.json
- docs/verification/V004.md
- spikes/v004/verification.json

验收：
- 确认材料格式、角色、工具引用与能力边界
- 明确拒绝或隔离，不静默截断或提权
- 确定水位更新或重建要求，原生复用不能遗漏B的工作

场景：V004-C01, V004-C02, V004-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V005 冻结公共命令与切换默认规则

范围：冻结公共命令与切换默认规则；仅交付所列文件与对应行为。

依赖：V004。需求：R02, R07, R09, R19。

唯一交付物：
- docs/verification/V005.md
- spikes/v005/contract-examples.json
- spikes/v005/verification.json

验收：
- 身份、状态、错误、并发和幂等范围得到一致定义
- 冻结默认策略与生效边界，不保留含混兼容路径
- 定义唯一待决意图或显式替换命令及顺序

场景：V005-C01, V005-C02, V005-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V006 验证平台监督边界与首发支持范围

范围：仅核对当前宿主的进程归属、停止与owner排他边界；其他平台和发行后置。

依赖：V001。需求：R20, R13。

唯一交付物：
- spikes/v006/platform-matrix.json
- docs/verification/V006.md
- spikes/v006/verification.json

验收：
- 明确可确认与未知归属的边界
- 在真实宿主记录结果，没有宿主标未验证
- 不以macOS结果替代Windows，不支持的隔离明确拒绝

场景：V006-C01, V006-C02, V006-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V007 冻结规则路由的证据与质量声明

范围：冻结规则路由的证据与质量声明；仅交付所列文件与对应行为。

依赖：V002, V003。需求：R05, R21。

唯一交付物：
- spikes/v007/policy-baseline.json
- docs/verification/V007.md
- spikes/v007/verification.json

验收：
- 冻结可解释规则与unknown处理，不编造最优分数
- 拒绝原因清楚，指定目标不自动替换
- 冻结可重复测量方案，实测前只声称策略适配

场景：V007-C01, V007-C02, V007-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## V008 独立复核并冻结G1契约集合

范围：独立复核并冻结G1契约集合；只冻结所属契约或实现所属入口。

依赖：C001, C002, C003, C004, C005, C006, C007, C008, C009, C010, V006, V007。需求：R19, R23, R24。

唯一交付物：
- docs/verification/V008.md
- spikes/v008/freeze-record.json
- spikes/v008/verification.json
- docs/decisions/README.md

验收：
- G1证据在应用实现之前存在
- 严重矛盾关闭并留评审记录
- 限制支持范围，不能伪造已验证
- accepted有来源与范围、索引与独立文件一致、未决项明确阻塞
- G1保持关闭，不能凭计划结构通过自动采纳设计

场景：V008-C01, V008-C02, V008-C03, V008-C04, V008-C05。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C001 冻结公共身份与Problem错误契约

范围：冻结公共身份与Problem错误契约；只冻结所属契约或实现所属入口。

依赖：V001。需求：R02, R19, R17。

唯一交付物：
- contracts/common.schema.json
- contracts/problem.schema.json
- contracts/examples/c001.json

验收：
- 身份不可互换，错误结构/脱敏/版本规则明确
- 公开字段不泄露，内部归因可保留
- schema拒绝样例与参考值可机器验证

场景：C001-C01, C001-C02, C001-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C002 冻结Harness能力与版本描述契约

范围：冻结Harness能力与版本描述契约；只冻结所属契约或实现所属入口。

依赖：C001, V002, V003。需求：R03, R04, R25。

唯一交付物：
- contracts/harness.schema.json
- contracts/examples/c002.json

验收：
- 声明/观察/验证明确分开
- 无效声明被拒绝
- 新准入和历史引用边界固定

场景：C002-C01, C002-C02, C002-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C003 冻结Session消息与选择命令契约

范围：冻结Session消息与选择命令契约；只冻结所属契约或实现所属入口。

依赖：C001, V005。需求：R01, R02, R06, R07, R09。

唯一交付物：
- contracts/session.schema.json
- contracts/examples/c003.json
- docs/decisions/0001-public-session.md

验收：
- 输入、幂等、版本、控制顺序与错误精确定义
- tombstone和Grant版本校验有字段支持
- 偏好与实际生效选择分开

场景：C003-C01, C003-C02, C003-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C004 冻结执行授权与结果契约

范围：冻结执行授权与结果契约；只冻结所属契约或实现所属入口。

依赖：C001, V005。需求：R11, R13, R14, R16。

唯一交付物：
- contracts/execution.schema.json
- contracts/examples/c004.json
- docs/decisions/0005-dispatch-authority.md

验收：
- 签发、撤销、授权和迟到控制有闭合集合
- 唯一终态与各结算面可完整表达
- 未知派发不重跑，旧授权不可再用

场景：C004-C01, C004-C02, C004-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C005 冻结持久事件与游标契约

范围：冻结持久事件与游标契约；只冻结所属契约或实现所属入口。

依赖：C001, C004。需求：R15, R19, R26。

唯一交付物：
- contracts/event.schema.json
- contracts/examples/c005.json

验收：
- 只有持久事实推进公共seq
- 重放去重、410和未知事件处理明确
- 大小边界、产物引用和脱敏责任明确

场景：C005-C01, C005-C02, C005-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C006 冻结可交接上下文契约

范围：冻结可交接上下文契约；只冻结所属契约或实现所属入口。

依赖：C001, V004。需求：R08, R09。

唯一交付物：
- contracts/context.schema.json
- contracts/examples/c006.json
- docs/decisions/0006-context-handoff.md

验收：
- manifest字段有有效样例与来源约束
- 无效材料不能进入执行
- 旧原生状态不冒充最新公共上下文

场景：C006-C01, C006-C02, C006-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C007 冻结路由决策与执行计划契约

范围：冻结路由决策与执行计划契约；只冻结所属契约或实现所属入口。

依赖：C002, C003, C006, C010, V007。需求：R05, R06, R21。

唯一交付物：
- contracts/routing.schema.json
- contracts/examples/c007.json
- docs/decisions/0004-evidence-routing.md

验收：
- 决策来源与质量不确定性可解释
- 不能静默替换或放宽约束
- 固定计划与准入复核有明确身份

场景：C007-C01, C007-C02, C007-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C008 冻结Adapter与存储派发端口语义

范围：冻结Adapter与存储派发端口语义；只冻结所属契约或实现所属入口。

依赖：C002, C004, C006, C007。需求：R11, R12, R14, R25。

唯一交付物：
- contracts/adapter-contract.json
- contracts/examples/c008.json
- docs/decisions/0002-ddd-boundaries.md
- docs/decisions/0003-protocol-adapters.md

验收：
- 端口行为、时序、失败和资源责任有实例
- 能力不支持或未知状态可以表达
- 旧意图和旧代次不能获得新的外部作用

场景：C008-C01, C008-C02, C008-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C009 冻结完整OpenAPI与入口操作目录

范围：冻结完整OpenAPI与入口操作目录；只冻结所属契约或实现所属入口。

依赖：C003, C004, C005, C010。需求：R01, R03, R10, R12, R19。

唯一交付物：
- contracts/openapi.json
- contracts/operations.json
- contracts/examples/c009.json

验收：
- 统一operationId、身份、错误、响应和媒体类型
- 静态契约检查能够拒绝
- 生成客户端不会误解受理/完成与流媒体

场景：C009-C01, C009-C02, C009-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## C010 冻结Provider模型资源契约

范围：冻结Provider模型资源契约；只冻结所属契约或实现所属入口。

依赖：C001, V002, V003。需求：R10, R17, R19。

唯一交付物：
- contracts/model.schema.json
- contracts/examples/c010.json
- docs/decisions/0007-model-binding.md

验收：
- 资源与执行选择独立，公开数据没有秘密
- 输入与能力失败精确定义
- 证据字段及null语义明确

场景：C010-C01, C010-C02, C010-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## G001 建立精确可重复的应用工具链

范围：建立精确可重复的应用工具链；仅交付所列文件与对应行为。

依赖：V001, V008。需求：R19, R23, R24。

唯一交付物：
- package.json
- pnpm-lock.yaml
- .node-version
- tsconfig.json
- eslint.config.mjs
- tests/integration/g001.test.ts
- tests/security/g001.test.ts
- tools/check_design.py
- tools/test_check_design.py

验收：
- 固定版本可复现且不修改锁文件
- 必需检查非零拒绝
- 变量和HOME隔离，秘密不被继承

场景：G001-C01, G001-C02, G001-C03, G001-S01。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G002 定义公共身份与错误值类型

范围：从已冻结契约生成或实现类型并做等价检查；不得在应用实现阶段重新定义wire契约。

依赖：G001, C001。需求：R02, R19。

唯一交付物：
- src/contracts/identity.ts
- src/contracts/errors.ts
- tests/unit/g002.test.ts
- tests/property/g002.test.ts

验收：
- 不能互相替代，外部非法值被拒绝
- 公开错误安全且保留内部归因
- 边界与品牌类型不变量成立

场景：G002-C01, G002-C02, G002-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G003 从冻结契约生成Harness能力类型

范围：从已冻结契约生成或实现类型并做等价检查；不得在应用实现阶段重新定义wire契约。

依赖：G002, V002, V003, C002。需求：R03, R04, R25。

唯一交付物：
- src/contracts/harness.ts
- tests/unit/g003.test.ts
- tests/property/g003.test.ts
- src/contexts/catalog/domain/catalog.ts
- src/contexts/catalog/domain/catalog-parser.ts
- tests/unit/catalog-contract.test.ts

验收：
- 证据等级不混淆
- 拒绝无依据支持声明
- 生成类型与wire契约等价

场景：G003-C01, G003-C02, G003-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G004 从冻结契约生成Session命令类型

范围：从已冻结契约生成或实现类型并做等价检查；不得在应用实现阶段重新定义wire契约。

依赖：G002, V005, C003。需求：R01, R02, R06, R07, R09。

唯一交付物：
- src/contracts/session.ts
- tests/unit/g004.test.ts
- tests/property/g004.test.ts
- src/contexts/session/domain/state.ts
- tests/unit/session-state.test.ts
- src/contracts/content.ts

验收：
- 语义区分且输入有界
- 明确字段错误，无静默默认
- 规范化hash和scope规则稳定

场景：G004-C01, G004-C02, G004-C03, G004-NC1, G004-NC2, G004-NC3, G004-NC4。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G005 从冻结契约生成执行事件类型

范围：从已冻结契约生成或实现类型并做等价检查；不得在应用实现阶段重新定义wire契约。

依赖：G002, C004, C005。需求：R11, R15, R16, R19。

唯一交付物：
- src/contracts/execution.ts
- tests/unit/g005.test.ts
- tests/property/g005.test.ts

验收：
- 不同结算面不合并成伪成功
- 拒绝无归属事件
- 新增字段规则明确，未知必需事件不被吞掉

场景：G005-C01, G005-C02, G005-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G006 从冻结契约生成上下文类型

范围：从已冻结契约生成或实现类型并做等价检查；不得在应用实现阶段重新定义wire契约。

依赖：G002, V004, C006。需求：R08, R19。

唯一交付物：
- src/contracts/context.ts
- tests/unit/g006.test.ts
- tests/security/g006.test.ts
- src/contexts/session/domain/context.ts
- tests/unit/session-context.test.ts

验收：
- manifest完整可核对
- 不接受不可追溯材料
- 不能提升权限或泄露秘密

场景：G006-C01, G006-C02, G006-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G007 定义防腐Adapter端口与关闭责任

范围：从已冻结契约生成或实现类型并做等价检查；不得在应用实现阶段重新定义wire契约。

依赖：G003, G005, G006, V002, V003, C008, G063。需求：R11, R12, R25。

唯一交付物：
- src/contracts/adapter.ts
- tests/unit/g007.test.ts
- src/contracts/control.ts

验收：
- 资源所有者与可等待关闭清楚
- 明确能力结果而非空fallback
- 边界检查可拒绝

场景：G007-C01, G007-C02, G007-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G008 建立事务存储与编号迁移基础

范围：建立事务存储与编号迁移基础；仅交付所列文件与对应行为。

依赖：G004, G005, G006, C008。需求：R07, R14, R19。

唯一交付物：
- src/infrastructure/storage/database.ts
- src/infrastructure/storage/unit-of-work.ts
- src/infrastructure/storage/migrations/001-initial.sql
- tests/integration/g008.test.ts
- src/infrastructure/session/sqlite-store.ts
- tests/integration/session-store.test.ts
- tests/fixtures/session-store-peer.mjs
- src/infrastructure/session/content-store.ts
- tests/integration/content-store.test.ts

验收：
- 状态与迁移记录原子一致
- 回滚并明确失败，不清库
- 只有一个取得业务写入权
- 恢复数据与outbox一致

场景：G008-C01, G008-C02, G008-C03, G008-C04, G008-C05, G008-P01, G008-P02, G008-R01, G008-N01, G008-X02, G008-NC1, G008-NC2, G008-NC3, G008-NC4, G008-NC5, G008-NC6, G008-NC7, G008-NC8。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G009 实现本机认证与Session作用域

范围：实现本机认证与Session作用域；仅交付所列文件与对应行为。

依赖：G002, G004, G008。需求：R01, R17。

唯一交付物：
- src/contexts/access-policy/application/authenticate.ts
- src/infrastructure/http/auth.ts
- tests/security/g009.test.ts
- tests/integration/g009.test.ts

验收：
- 拒绝管理与执行越权
- 不能借用本机身份
- 相同权限范围访问相同应用命令
- 在分派前规范化拒绝

场景：G009-C01, G009-C02, G009-C03, G009-C04。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G010 实现作用域秘密引用解析

范围：实现作用域秘密引用解析；仅交付所列文件与对应行为。

依赖：G008, G009。需求：R17, R10。

唯一交付物：
- src/contexts/access-policy/application/resolve-secret.ts
- src/infrastructure/secrets/local-store.ts
- tests/security/g010.test.ts
- tests/platform/g010.test.ts
- src/infrastructure/provider/vault.ts
- src/infrastructure/session/redacted-control.ts
- tests/unit/session-redaction.test.ts

验收：
- 仅授权边界取得所需值
- 明确拒绝且不打印原值
- 分别验证，不宣称同用户OS隔离
- 无原值泄露

场景：G010-C01, G010-C02, G010-C03, G010-C04, G010-NC1, G010-NC2。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G011 登记Harness不可变revision

范围：登记Harness不可变revision；仅交付所列文件与对应行为。

依赖：G003, G008, G009。需求：R03, R04。

唯一交付物：
- src/contexts/catalog/domain/register-harness.ts
- src/infrastructure/storage/catalog-repository.ts
- tests/integration/g011.test.ts
- src/adapters/catalog.ts
- src/infrastructure/catalog/registry.ts
- src/infrastructure/catalog/acp-registry.json
- tests/unit/catalog-import.test.ts
- src/contracts/management.ts
- src/contexts/management/domain/input.ts
- src/adapters/management/recipes.ts
- src/infrastructure/management/metadata.ts
- src/infrastructure/management/storage.ts
- src/infrastructure/management/service.ts
- src/contexts/management/domain/state.ts
- tests/unit/management-state.test.ts
- tests/integration/management-service.test.ts
- src/infrastructure/management/system-version.ts
- tests/integration/management-system-version.test.ts
- src/infrastructure/management/native.ts
- src/infrastructure/management/native-lock.ts
- tests/integration/native-management.test.ts
- src/infrastructure/management/homebrew.ts
- src/infrastructure/management/verified-versions.ts
- tests/unit/verified-versions.test.ts
- src/infrastructure/management/program-usage.ts
- tests/unit/program-usage.test.ts
- tools/management-v3-to-v2.sql
- src/infrastructure/management/uninstall.ts
- tools/management-v4-to-v3.sql
- tests/integration/uninstall.test.ts
- src/infrastructure/management/official-install.ts
- tools/management-v5-to-v4.sql
- tests/integration/official-install.test.ts
- tests/unit/official-install.test.ts

验收：
- 发布新revision并保留历史
- 提交前拒绝
- 内存目录不先更新

场景：G011-C01, G011-C02, G011-C03, G011-M01, G011-M02, G011-M03, G011-M04, G011-L01, G011-N01, G011-N02, G011-N03, G011-NC1, G011-NC2, G011-UP1, G011-UP2, G011-UP3, G011-UP4, G011-UP5, G011-UP6, G011-UP7, G011-UP8, G011-UN1, G011-UN2, G011-UN3, G011-UN4, G011-UN5, G011-UN6, G011-UN7, G011-IN1, G011-IN2, G011-IN3, G011-IN4, G011-IN5, G011-IN6, G011-IN7, G011-IN8, G011-UP9。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G012 只读发现已安装Harness

范围：只读发现已安装Harness；仅交付所列文件与对应行为。

依赖：G003, G011。需求：R03, R04。

唯一交付物：
- src/contexts/catalog/application/discover.ts
- src/infrastructure/discovery/local.ts
- tests/integration/g012.test.ts
- tests/security/g012.test.ts
- src/contexts/catalog/domain/discovery.ts
- src/adapters/recipes.ts
- src/cli/discover.ts
- tests/unit/g012.test.ts
- examples/discovery-manifest.json
- src/contexts/catalog/application/inventory.ts
- src/infrastructure/discovery/search.ts
- src/infrastructure/discovery/installation-enumerator.ts
- src/infrastructure/discovery/packages.ts
- src/infrastructure/discovery/configuration.ts
- tests/integration/discovery-v2.test.ts
- tests/unit/inventory.test.ts
- tests/integration/discovery-cli.test.ts
- src/infrastructure/discovery/login-shell.ts
- tests/integration/login-shell.test.ts
- src/contexts/catalog/domain/channels.ts
- src/adapters/catalog-channels.ts
- src/infrastructure/discovery/installation-channels.ts
- tests/unit/official-channels.test.ts
- tests/integration/official-channels.test.ts

验收：
- 返回安装观察，不自动注册
- 拒绝歧义和越界
- 明确原因，不联网下载或调用模型

场景：G012-C01, G012-C02, G012-C03, G012-NC1, G012-NC2, G012-OC1, G012-OC2, G012-OC3, G012-OC4。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G013 收集版本化能力证据

范围：收集版本化能力证据；仅交付所列文件与对应行为。

依赖：G007, G011, V002, V003, G033, G034。需求：R04, R25。

唯一交付物：
- src/contexts/catalog/application/probe.ts
- src/infrastructure/storage/capability-repository.ts
- tests/protocol/g013.test.ts
- tests/integration/g013.test.ts

验收：
- 分别保存declared/observed证据
- 不试探调用未支持能力
- 旧validated不自动迁移

场景：G013-C01, G013-C02, G013-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G014 停用准入并排空Harness

范围：停用准入并排空Harness；仅交付所列文件与对应行为。

依赖：G011, G013。需求：R03, R11。

唯一交付物：
- src/contexts/catalog/domain/drain.ts
- tests/integration/g014.test.ts

验收：
- 新准入停止，旧执行仍归旧revision
- 幂等或显式冲突
- 保留真实状态，不直接移除资源

场景：G014-C01, G014-C02, G014-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G015 移除Harness并保留历史引用

范围：移除Harness并保留历史引用；仅交付所列文件与对应行为。

依赖：G014, G008。需求：R03, R14。

唯一交付物：
- src/contexts/catalog/domain/remove.ts
- tests/integration/g015.test.ts

验收：
- 写移除标记，不删历史revision
- 拒绝或继续排空
- 移除项不被自动复活

场景：G015-C01, G015-C02, G015-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G016 登记Provider与模型资源

范围：登记Provider与模型资源；仅交付所列文件与对应行为。

依赖：G003, G010, C010。需求：R10, R17。

唯一交付物：
- src/contexts/model-access/domain/register-provider.ts
- src/infrastructure/storage/provider-repository.ts
- tests/integration/g016.test.ts
- tests/security/g016.test.ts
- src/contracts/provider.ts
- src/contexts/provider/domain/provider.ts
- src/infrastructure/provider/service.ts
- tests/unit/provider-contract.test.ts
- tests/integration/provider-service.test.ts

验收：
- 可按稳定身份选择
- 拒绝风险输入
- 旧计划不被改写

场景：G016-C01, G016-C02, G016-C03, G016-P01, G016-P02, G016-P03, G016-P04。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G017 集中解析运行预算与上限

范围：集中解析运行预算与上限；仅交付所列文件与对应行为。

依赖：G001, G005。需求：R13, R26。

唯一交付物：
- src/bootstrap/config.ts
- tests/unit/g017.test.ts
- tests/property/g017.test.ts

验收：
- 默认值在一处解析
- 明确拒绝
- 不能用零值或溢出绕过限制

场景：G017-C01, G017-C02, G017-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G018 创建持久公共Session

范围：创建持久公共Session；仅交付所列文件与对应行为。

依赖：G004, G008, G009。需求：R01, R02, R07。

唯一交付物：
- src/contexts/interaction/domain/create-session.ts
- src/infrastructure/storage/session-repository.ts
- tests/integration/g018.test.ts

验收：
- 公共ID独立于任何原生Harness
- 同Session或冲突，无重复创建
- 状态与归属仍在

场景：G018-C01, G018-C02, G018-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G019 持久接收消息与执行意图

范围：持久接收消息与执行意图；仅交付所列文件与对应行为。

依赖：G018, G017。需求：R07, R06。

唯一交付物：
- src/contexts/interaction/domain/accept-message.ts
- src/infrastructure/storage/message-repository.ts
- tests/integration/g019.test.ts
- tests/security/g019.test.ts

验收：
- 消息/意图/期限/outbox同事务
- 稳定顺序和去重，非法不受理
- 重复投递不重复副作用
- 拒绝而不转成执行指令

场景：G019-C01, G019-C02, G019-C03, G019-C04。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G020 实现Session单执行权与有界队列

范围：实现Session单执行权与有界队列；仅交付所列文件与对应行为。

依赖：G019, G017。需求：R07, R11, R26。

唯一交付物：
- src/contexts/interaction/domain/admit-turn.ts
- tests/integration/g020.test.ts
- tests/property/g020.test.ts

验收：
- 同Session串行，跨Session有界并行
- 拒绝或超时，不无界累积
- 最多一个有效执行槽位

场景：G020-C01, G020-C02, G020-C03, G020-C04。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G021 过滤Harness候选硬约束

范围：过滤Harness候选硬约束；仅交付所列文件与对应行为。

依赖：G013, G016, G017, C007。需求：R04, R05, R06。

唯一交付物：
- src/contexts/selection/domain/filter-candidates.ts
- tests/unit/g021.test.ts
- tests/property/g021.test.ts
- src/contexts/catalog/application/select-control.ts

验收：
- 仅满足全部约束者留下
- 排除且有原因
- 不自动换目标或放宽约束

场景：G021-C01, G021-C02, G021-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G022 按版本化规则确定性排序

范围：按版本化规则确定性排序；仅交付所列文件与对应行为。

依赖：G021, V007。需求：R05, R21。

唯一交付物：
- src/contexts/selection/domain/rank-candidates.ts
- tests/unit/g022.test.ts
- tests/property/g022.test.ts

验收：
- 排名可复放且并列稳定
- unknown不补零，不声称最优
- 稳定tie-break与公平策略一致

场景：G022-C01, G022-C02, G022-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G023 保存路由决策与准入复核

范围：保存路由决策与准入复核；仅交付所列文件与对应行为。

依赖：G022, G008。需求：R05, R06, R21。

唯一交付物：
- src/contexts/selection/application/decide.ts
- src/infrastructure/storage/routing-repository.ts
- tests/integration/g023.test.ts

验收：
- 提交后可解释和复放
- 明确失败或新auto决策，不伪造旧选择
- 不启动未经持久记录的执行

场景：G023-C01, G023-C02, G023-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G024 构建有界公共ContextManifest

范围：构建有界公共ContextManifest；仅交付所列文件与对应行为。

依赖：G006, G019, G017。需求：R08。

唯一交付物：
- src/contexts/continuity/domain/build-manifest.ts
- src/infrastructure/storage/context-repository.ts
- tests/unit/g024.test.ts
- tests/security/g024.test.ts

验收：
- 来源、水位、预算与指纹完整
- 明确失败，不静默只取最近历史
- 保持数据等级与秘密边界

场景：G024-C01, G024-C02, G024-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G025 验证交接水位与绑定新鲜度

范围：验证交接水位与绑定新鲜度；仅交付所列文件与对应行为。

依赖：G024, G026。需求：R08, R09。

唯一交付物：
- src/contexts/continuity/domain/verify-handoff.ts
- tests/integration/g025.test.ts
- tests/property/g025.test.ts

验收：
- 复用必须同步，不足时显式重建
- 不偷偷吸收新输入，冲突可见
- 不把空会话当恢复成功

场景：G025-C01, G025-C02, G025-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G026 授予工作区单写租约

范围：授予工作区单写租约；仅交付所列文件与对应行为。

依赖：G008, G017。需求：R18, R20。

唯一交付物：
- src/contexts/execution/domain/workspace-lease.ts
- src/infrastructure/storage/workspace-repository.ts
- tests/integration/g026.test.ts
- tests/platform/g026.test.ts
- src/infrastructure/session/workspace-lease.ts
- tests/integration/workspace-lease.test.ts
- src/infrastructure/session/native-environment.ts

验收：
- 同一时刻只有一个有效写者
- 代次隔离，不能只凭PID夺权
- 明确边界或拒绝强隔离要求

场景：G026-C01, G026-C02, G026-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G027 仲裁Attempt状态与唯一终态

范围：仲裁Attempt状态与唯一终态；仅交付所列文件与对应行为。

依赖：G005, G008, G017。需求：R11, R13, R16。

唯一交付物：
- src/contexts/execution/domain/attempt-state.ts
- src/infrastructure/storage/attempt-repository.ts
- tests/property/g027.test.ts
- tests/unit/g027.test.ts
- tests/integration/g027.test.ts

验收：
- 唯一终态且停止原因不被覆盖
- 拒绝或隔离，不污染新执行
- 原子回滚，不假报完成

场景：G027-C01, G027-C02, G027-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G028 按持久意图幂等派发执行

范围：按持久意图幂等派发执行；仅交付所列文件与对应行为。

依赖：G020, G023, G025, G027。需求：R07, R11, R14。

唯一交付物：
- src/contexts/execution/application/dispatch.ts
- src/infrastructure/storage/outbox.ts
- tests/integration/g028.test.ts
- src/contexts/session/application/runtime.ts
- tests/integration/session-runtime.test.ts
- tests/integration/kept-process.test.ts
- tests/integration/attention.test.ts
- tests/integration/parallel-work.test.ts
- tests/fixtures/kept-owner.mjs

验收：
- 同一意图只取得一次有效执行权
- 未知结果不自动重跑
- 有界排队且期限继续计时

场景：G028-C01, G028-C02, G028-C03, G028-C04, G028-R01, G028-R02, G028-NC2, G028-NC3, G028-NC4, G028-NC5, G028-NC6, G028-NC7, G028-NC8, G028-NC9, G028-NC10, G028-NC11, G028-NC12, G028-NC13, G028-UP1。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G029 实现POSIX进程监督与回收

范围：实现POSIX进程监督与回收；仅交付所列文件与对应行为。

依赖：G007, G017, G027。需求：R11, R13, R20。

唯一交付物：
- src/infrastructure/process/posix-host.ts
- tests/platform/g029.test.ts
- tests/performance/g029.test.ts
- src/infrastructure/management/process.ts
- src/infrastructure/management/download.ts
- src/infrastructure/management/archive.ts
- src/infrastructure/management/installer.ts
- tests/integration/management-archive.test.ts
- tests/integration/management-process.test.ts
- tests/fixtures/management-installer.mjs

验收：
- 错误有归属并等待资源释放
- 按证据回收或unconfirmed，不能误杀他人
- 升级终止和清理状态真实
- 句柄/内存有界

场景：G029-C01, G029-C02, G029-C03, G029-C04, G029-M01, G029-M02。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G030 实现Windows Job监督

范围：实现Windows Job监督；仅交付所列文件与对应行为。

依赖：G007, G017, G027, V006。需求：R11, R13, R20。

唯一交付物：
- src/infrastructure/process/windows-host.ts
- native/windows/job-host.cs
- tests/platform/g030.test.ts

验收：
- 整树归属与关闭可核验
- 显式失败或unconfirmed
- 原生行为正确，无窗口残留

场景：G030-C01, G030-C02, G030-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G031 实现ACP v1连接与有界framing

范围：实现ACP v1连接与有界framing；仅交付所列文件与对应行为。

依赖：G007, G017, G029。需求：R25, R26。

唯一交付物：
- src/adapters/acp/connection.ts
- tests/protocol/g031.test.ts
- src/infrastructure/control/json-rpc-process.ts
- tests/protocol/process.test.ts
- tests/fixtures/control-peer.mjs
- src/infrastructure/control/process-group.ts

验收：
- 按wire v1与能力协商
- 明确协议错误且关闭有界
- 相关请求结算，缓冲不无界

场景：G031-C01, G031-C02, G031-C03, G031-R01, G031-NC1。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G032 实现ACP执行证据映射

范围：实现ACP执行证据映射；仅交付所列文件与对应行为。

依赖：G031, G027, G037, G039。需求：R11, R12, R13, R25。

唯一交付物：
- src/adapters/acp/driver.ts
- tests/protocol/g032.test.ts
- src/adapters/control/acp.ts
- tests/protocol/acp.test.ts
- src/adapters/control/factory.ts
- src/adapters/control/native-dependencies.ts
- src/adapters/control/pi.ts
- tests/protocol/pi.test.ts
- tests/fixtures/pi-rpc-peer.mjs
- src/adapters/control/openclaw.ts
- src/infrastructure/control/native-command.ts
- src/adapters/control/cursor.ts
- src/infrastructure/control/unified-diff.ts
- src/infrastructure/control/attachments.ts
- src/adapters/control/opencode.ts
- src/adapters/control/claude.ts
- src/adapters/control/hermes.ts
- tests/fixtures/hermes-cli.mjs

验收：
- 各事实关联正确Attempt与generation
- 接受相关尾事件但不能影响下一执行
- 明确拒绝，不空会话fallback
- 不把结果称官方认证

场景：G032-C01, G032-C02, G032-C03, G032-C04, G032-L01, G032-N01, G032-N02, G032-X03, G032-NC4, G032-NC5, G032-NC6, G032-NC7, G032-NC8, G032-NC9, G032-NC10, G032-NC11, G032-NC12, G032-NC13, G032-NC14, G032-NC15, G032-NC16, G032-NC17, G032-NC18, G032-NC19, G032-NC20, G032-NC21, G032-NC22。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G033 配置并验证OpenCode ACP绑定

范围：配置并验证OpenCode ACP绑定；仅交付所列文件与对应行为。

依赖：G032, G035, V002。需求：R10, R11, R25。

唯一交付物：
- src/adapters/opencode/profile.ts
- src/adapters/opencode/configure.ts
- tests/protocol/g033.test.ts

验收：
- 请求经目标模型且不改用户文件
- 真实映射，不扩展许可
- 验证Adapter协议、事件、权限和绑定清理；完整正式入口验收由G060承担

场景：G033-C01, G033-C02, G033-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G034 实现Codex App Server防腐适配

范围：实现Codex App Server防腐适配；仅交付所列文件与对应行为。

依赖：G007, G029, G035, G039, V003。需求：R10, R11, R12, R25。

唯一交付物：
- src/adapters/codex/client.ts
- src/adapters/codex/driver.ts
- tests/protocol/g034.test.ts
- src/adapters/control/codex.ts
- tests/protocol/codex.test.ts

验收：
- 原生ID与公共ID分离并正确相关
- 不以ACK或流末尾判完成
- 明确失败或能力不支持
- 验证原生Adapter执行/中断/审批/绑定清理；完整正式入口验收由G060承担

场景：G034-C01, G034-C02, G034-C03, G034-C04, G034-NC3, G034-NC4, G034-NC5, G034-NC6, G034-NC7, G034-NC8, G034-NC9, G034-NC10, G034-NC11。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G035 签发执行作用域模型访问身份

范围：签发执行作用域模型访问身份；仅交付所列文件与对应行为。

依赖：G009, G010, G016, G027。需求：R10, R17。

唯一交付物：
- src/contexts/model-access/application/bind-attempt.ts
- tests/security/g035.test.ts
- tests/integration/g035.test.ts

验收：
- 只允许所属epoch/generation与目标
- 拒绝且不泄露秘密
- 吊销或失效，不把Provider原Key交给Harness

场景：G035-C01, G035-C02, G035-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G036 实现最小兼容Provider转发

范围：实现最小兼容Provider转发；仅交付所列文件与对应行为。

依赖：G016, G017。需求：R10, R26。

唯一交付物：
- src/infrastructure/model/transport.ts
- tests/protocol/g036.test.ts
- tests/performance/g036.test.ts

验收：
- 语义保留，真实上游可核对
- 正确归因，不伪装成功
- 明确拒绝，不静默降级
- 背压和缓冲上限成立

场景：G036-C01, G036-C02, G036-C03, G036-C04。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G037 持久模型账本并等待结算屏障

范围：持久模型账本并等待结算屏障；仅交付所列文件与对应行为。

依赖：G035, G036, G008。需求：R10, R16。

唯一交付物：
- src/contexts/model-access/application/settle-call.ts
- src/infrastructure/storage/model-call-repository.ts
- tests/integration/g037.test.ts

验收：
- 实际模型、用量来源与Attempt关联
- 等待取消/提交再结算
- null/缺口或存储失败，不补零

场景：G037-C01, G037-C02, G037-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G038 持久权限请求与决定

范围：持久权限请求与决定；仅交付所列文件与对应行为。

依赖：G027, G008。需求：R12, R17。

唯一交付物：
- src/contexts/execution/domain/permission-decision.ts
- src/infrastructure/storage/permission-repository.ts
- tests/integration/g038.test.ts
- tests/property/g038.test.ts

验收：
- 先提交再可发送，决定与applied分开
- 幂等或拒绝
- 旧决定不能授权新工具

场景：G038-C01, G038-C02, G038-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G039 投递权限决定并确认应用

范围：投递权限决定并确认应用；仅交付所列文件与对应行为。

依赖：G007, G038。需求：R12, R13。

唯一交付物：
- src/contexts/execution/application/deliver-permission.ts
- tests/protocol/g039.test.ts
- tests/integration/g039.test.ts

验收：
- 保存实际receipt，不推断工具成功
- 状态未知，不向新绑定重发
- 按协议取消并收敛

场景：G039-C01, G039-C02, G039-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G040 执行总期限仲裁

范围：执行总期限仲裁；仅交付所列文件与对应行为。

依赖：G027, G017。需求：R13。

唯一交付物：
- src/contexts/execution/domain/deadline.ts
- tests/property/g040.test.ts
- tests/unit/g040.test.ts
- tests/integration/g040.test.ts

验收：
- 全部计入接收时预算
- 不能延长或溢出预算
- 规则唯一，清理grace独立

场景：G040-C01, G040-C02, G040-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G041 执行幂等取消与升级停止

范围：执行幂等取消与升级停止；仅交付所列文件与对应行为。

依赖：G027, G029, G039, G040。需求：R13, R11。

唯一交付物：
- src/contexts/execution/application/cancel-attempt.ts
- tests/integration/g041.test.ts
- tests/property/g041.test.ts

验收：
- 受理、后端结束、清理分别核对
- 升级终止，未确认资源隔离
- 不影响下一Attempt或覆盖停止原因

场景：G041-C01, G041-C02, G041-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G042 采集不可变文件产物

范围：采集不可变文件产物；仅交付所列文件与对应行为。

依赖：G026, G017, G008。需求：R16, R18。

唯一交付物：
- src/contexts/execution/application/collect-artifacts.ts
- src/infrastructure/artifacts/files.ts
- tests/integration/g042.test.ts
- tests/security/g042.test.ts

验收：
- hash/大小一致且源后改不影响
- 拒绝并回收未登记对象
- 产物状态独立，不冒充任务正确

场景：G042-C01, G042-C02, G042-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G043 结算执行并投影公共进展

范围：结算执行并投影公共进展；仅交付所列文件与对应行为。

依赖：G037, G041, G042, G027。需求：R02, R15, R16。

唯一交付物：
- src/contexts/interaction/application/apply-outcome.ts
- tests/integration/g043.test.ts

验收：
- 分别展示，公共Session关联不变
- 公共投影幂等且不提前释放执行权
- 不能仅凭exit0或Agent文本认定完成

场景：G043-C01, G043-C02, G043-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G044 提供持久事件游标与有界SSE

范围：提供持久事件游标与有界SSE；仅交付所列文件与对应行为。

依赖：G019, G043, G009。需求：R15, R26。

唯一交付物：
- src/contexts/interaction/application/read-events.ts
- src/infrastructure/http/event-stream.ts
- tests/integration/g044.test.ts
- tests/performance/g044.test.ts

验收：
- 从持久水位追赶且去重
- 明确错误，不漏事件或从零偷重播
- 执行不阻塞、缓存有界且可关闭

场景：G044-C01, G044-C02, G044-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G045 提交idle切换并准备目标绑定

范围：提交idle切换并准备目标绑定；仅交付所列文件与对应行为。

依赖：G023, G025, G033, G034, G043。需求：R09, R08。

唯一交付物：
- src/contexts/interaction/domain/request-switch.ts
- src/contexts/interaction/application/prepare-switch.ts
- tests/integration/g045.test.ts
- tests/property/g045.test.ts

验收：
- 固定manifest与实际selection，Session身份保持
- 实际选择不提前生效，公共事实保留
- 唯一待决意图，无最后写入偷覆盖

场景：G045-C01, G045-C02, G045-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G046 协调busy切换的静止交接

范围：协调busy切换的静止交接；仅交付所列文件与对应行为。

依赖：G045, G041, G026。需求：R09, R13, R18。

唯一交付物：
- src/contexts/interaction/application/quiesce-switch.ts
- tests/integration/g046.test.ts
- tests/property/g046.test.ts

验收：
- 按冻结策略等待或取消，结算后才交权
- blocked，不启动新写者
- epoch与水位唯一一致
- 按事实恢复，不自动重跑上一输入

场景：G046-C01, G046-C02, G046-C03, G046-C04。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G047 切换Provider模型并记录接续等级

范围：切换Provider模型并记录接续等级；仅交付所列文件与对应行为。

依赖：G045, G035。需求：R09, R10。

唯一交付物：
- src/contexts/interaction/application/change-model.ts
- tests/integration/g047.test.ts
- tests/protocol/g047.test.ts
- src/adapters/provider/materialize.ts
- tests/real/provider-switch.real.ts

验收：
- 独立选择且实际调用目标正确
- 原地或显式重建，不声称全组合热切换
- 状态真实，公共Session不丢失

场景：G047-C01, G047-C02, G047-C03, G047-P01。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G048 重启核对执行与绑定归属

范围：重启核对执行与绑定归属；仅交付所列文件与对应行为。

依赖：G028, G043, G046, G008, G029。需求：R14, R20。

唯一交付物：
- src/contexts/execution/application/reconcile.ts
- tests/integration/g048.test.ts
- tests/platform/g048.test.ts

验收：
- 核对后interrupted或隔离，不自动重跑
- 明确失败，不新建空会话装恢复
- 幂等补齐已证明事实
- 不误杀，未知清理如实报告

场景：G048-C01, G048-C02, G048-C03, G048-C04, G048-C05, G048-C06。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G049 关闭公共Session并收敛资源

范围：关闭公共Session并收敛资源；仅交付所列文件与对应行为。

依赖：G041, G046, G020。需求：R02, R13, R14。

唯一交付物：
- src/contexts/interaction/application/close-session.ts
- tests/integration/g049.test.ts

验收：
- 拒绝新输入并按归属收敛
- 幂等并保留历史和清理状态
- 恢复已持久意图，不丢未知结果

场景：G049-C01, G049-C02, G049-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G050 接通Session类HTTP应用入口

范围：接通Session类HTTP应用入口；仅交付所列文件与对应行为。

依赖：G019, G045, G046, G047, G049, G009, C009。需求：R01, R07, R09, R19, R22。

唯一交付物：
- src/infrastructure/http/session-routes.ts
- tests/integration/g050.test.ts
- tests/security/g050.test.ts
- src/contracts/web.ts
- src/web/server.ts
- src/cli/web.ts
- tests/integration/web-server.test.ts
- src/web/session-stream.ts
- src/web/attention-stream.ts
- src/web/run-diagnostics.ts
- src/web/harness-models.ts
- src/web/conversation-export.ts
- src/web/harness-entry.ts
- tests/unit/harness-entry.test.ts
- src/web/native-catalog-cache.ts
- tests/integration/native-catalog-cache.test.ts
- src/web/harness-installations.ts
- src/web/shown-paths.ts

验收：
- 复用应用语义，202只表受理
- 统一problem错误且无副作用
- 遗漏/重复/过期内容能被拒绝

场景：G050-C01, G050-C02, G050-C03, G050-P01, G050-P02, G050-R01, G050-NC1, G050-NC2, G050-NC3, G050-NC4, G050-NC5, G050-NC6, G050-NC7, G050-NC8。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G051 接通执行控制与权限HTTP入口

范围：接通执行控制与权限HTTP入口；仅交付所列文件与对应行为。

依赖：G043, G044, G039, G041, G009, C009。需求：R01, R12, R13, R15, R22。

唯一交付物：
- src/infrastructure/http/control-routes.ts
- tests/integration/g051.test.ts
- tests/security/g051.test.ts

验收：
- 状态与后台事实一致
- 拒绝越权和迟到控制
- 不取消执行或重新投递消息

场景：G051-C01, G051-C02, G051-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G052 发布契约生成客户端与流重连

范围：发布契约生成客户端与流重连；仅交付所列文件与对应行为。

依赖：G050, G051, G061, G062, C009。需求：R19, R22, R15。

唯一交付物：
- src/sdk/client.ts
- src/sdk/events.ts
- tools/generate-client.mjs
- tests/integration/g052.test.ts

验收：
- 类型与错误语义一致
- 只重连事件，不重发有副作用请求
- 新鲜度及无效schema检查失败

场景：G052-C01, G052-C02, G052-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G053 建立CLI对话命令入口

范围：建立CLI对话命令入口；仅交付所列文件与对应行为。

依赖：G052, G059。需求：R01, R22。

唯一交付物：
- src/cli/main.ts
- src/cli/commands.ts
- tests/e2e/g053.test.ts
- tests/security/g053.test.ts

验收：
- 调用同一SDK，用户无需厂商配置
- 明确退出码与取消/查询，不私自重跑
- 不把值放进进程列表或日志

场景：G053-C01, G053-C02, G053-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G054 建立薄Chat交互视图

范围：建立薄Chat交互视图；仅交付所列文件与对应行为。

依赖：G052, G059。需求：R01, R02, R09, R22。

唯一交付物：
- ui/chat.tsx
- ui/session-view.tsx
- tests/e2e/g054.test.ts
- web/index.html
- web/tsconfig.json
- web/vite.config.ts
- web/src/main.tsx
- web/src/api.ts
- web/src/App.tsx
- web/src/styles.css
- web/src/components/common.tsx
- web/src/components/Sidebar.tsx
- web/src/components/ChatPage.tsx
- web/src/components/ProvidersPage.tsx
- web/src/components/HarnessesPage.tsx
- tests/browser/web.browser.ts
- web/src/components/BrandIcon.tsx
- web/src/components/SearchPicker.tsx
- web/THIRD_PARTY_ASSETS.md
- web/src/assets/factory.svg
- web/src/assets/auggie.svg
- web/src/assets/dirac.svg
- web/src/assets/nova.svg
- web/src/assets/stakpak.svg
- web/src/session-stream.ts
- web/src/attention.ts
- web/src/components/ChatComposer.tsx
- web/src/components/ChatMessage.tsx
- web/src/components/StreamingMarkdown.tsx
- web/src/assets/agoragentic-acp.svg
- web/src/assets/autohand.svg
- web/src/assets/cortex-code.svg
- web/src/assets/corust-agent.svg
- web/src/assets/crow-cli.svg
- web/src/assets/deepagents.svg
- web/src/assets/dimcode.svg
- web/src/assets/fast-agent.svg
- web/src/assets/harn.svg
- web/src/assets/kimchi.svg
- web/src/assets/minion-code.svg
- web/src/assets/sigit.svg
- web/src/assets/vtcode.svg
- web/src/components/NativeActivity.tsx
- web/src/components/Attachments.tsx
- web/src/components/BranchOrigin.tsx
- web/src/components/NativeExtensions.tsx
- web/src/components/NativeSessions.tsx
- web/src/tool-tree.ts
- web/src/components/NativeResume.tsx
- web/src/components/Activity.tsx
- web/src/components/Approval.tsx
- web/src/components/CodeBlock.tsx
- web/src/components/CommandPalette.tsx
- web/src/components/Composer.tsx
- web/src/components/DetailsPanel.tsx
- web/src/components/PageShell.tsx
- web/src/components/SettingsPage.tsx
- web/src/components/Turn.tsx
- web/src/components/Welcome.tsx
- web/src/lib/cn.ts
- web/src/lib/format.ts
- web/src/lib/prefs.ts
- web/src/lib/turn.ts
- web/src/ui/overlay.tsx
- web/src/ui/primitives.tsx
- tests/unit/web-turn.test.ts
- docs/verification/frontend-redesign-2026-10-12.md
- web/src/components/UpgradeDialog.tsx
- web/src/components/UninstallDialog.tsx
- web/src/components/InstallDialog.tsx

验收：
- 公共Session身份与历史保留
- 不提前展示新Harness已生效
- 可操作且不持有独立业务状态

场景：G054-C01, G054-C02, G054-C03, G054-P01, G054-P02, G054-M01, G054-S01, G054-R01, G054-N01, G054-L01, G054-NC1, G054-NC2, G054-NC3, G054-NC4, G054-NC5, G054-NC6, G054-NC7, G054-NC8, G054-NC9, G054-NC10, G054-NC11, G054-NC12, G054-NC13, G054-NC14, G054-NC15, G054-FR1, G054-FR2, G054-FR3, G054-FR4, G054-FR5, G054-FR6, G054-FR7, G054-FR8, G054-UP1, G054-UP2, G054-OC1, G054-UN1, G054-IN1。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G055 建立路由质量基线与保留集

范围：建立路由质量基线与保留集；仅交付所列文件与对应行为。

依赖：G059, V007。需求：R05, R21, R24。

唯一交付物：
- evaluation/dataset-v1.json
- evaluation/runner.ts
- evaluation/report.ts
- tests/e2e/g055.test.ts
- tests/integration/g055.test.ts

验收：
- 正确性独立评分并记录不确定性
- 不以completed计质量，不混用保留集
- 有来源的分任务报告，不能宣称绝对最佳

场景：G055-C01, G055-C02, G055-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G056 执行完整切换故障与容量矩阵

范围：执行完整切换故障与容量矩阵；仅交付所列文件与对应行为。

依赖：G059, G055。需求：R09, R14, R18, R24, R26, R07, R13, R17。

唯一交付物：
- tests/e2e/session-switch.test.ts
- tests/performance/bounds.test.ts
- tests/e2e/g056.test.ts
- tests/performance/g056.test.ts
- tests/security/g056.test.ts
- tests/integration/g056.test.ts

验收：
- 公共上下文/实际调用/成果连续可查
- 无重复副作用或并发写，未知结果不重跑
- 内存句柄有界，取消与切换延迟可测
- 不能改路由策略或提升权限
- 新输入明确失败；无新Grant/模型/工具/权限派发；旧资源取消或隔离；未落库终态不被假报
- 只应用可证明事实，不自动重跑；清理未确认继续阻塞写权

场景：G056-C01, G056-C02, G056-C03, G056-C04, G056-C05, G056-C06, G056-C07, G056-C08, G056-C09, G056-C10, G056-C11, G056-C12, G056-C13, G056-C14, G056-C15, G056-C16, G056-C17, G056-C18, G056-C19, G056-C20, G056-C21, G056-C22, G056-C23, G056-C24, G056-C25, G056-C26。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G057 提供有界脱敏诊断与证据导出

范围：提供有界脱敏诊断与证据导出；仅交付所列文件与对应行为。

依赖：G043, G046, G048。需求：R16, R17, R26。

唯一交付物：
- src/infrastructure/observability/diagnostics.ts
- src/contexts/interaction/application/export-evidence.ts
- tests/integration/g057.test.ts
- tests/security/g057.test.ts
- tests/performance/g057.test.ts

验收：
- 同一事实源含版本、水位和缺口
- 默认诊断无秘密和原始正文泄露
- 有界且不伪造业务成功

场景：G057-C01, G057-C02, G057-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G058 接入不可跳过的CI与发行门禁

范围：接入不可跳过的CI与发行门禁；仅交付所列文件与对应行为。

依赖：G056, G060, V008, G063。需求：R19, R23, R24。

唯一交付物：
- .github/workflows/check.yml
- .github/workflows/conformance.yml
- tests/integration/g058.test.ts
- tests/platform/g058.test.ts

验收：
- 失败或必需跳过返回非零
- 检查自身拒绝错误
- 不发布未验证平台，设计通过不冒充发行通过

场景：G058-C01, G058-C02, G058-C03。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G059 组合单体与正式运行入口

范围：组合单体与正式运行入口；仅交付所列文件与对应行为。

依赖：G001, G014, G015, G028, G030, G033, G034, G043, G044, G046, G047, G048, G049, G050, G051, G052, G057, G061, G062。需求：R01, R11, R22, R25。

唯一交付物：
- src/bootstrap/main.ts
- tests/integration/g059.test.ts
- src/cli/control.ts
- src/cli/catalog.ts
- tests/integration/control-cli.test.ts
- src/infrastructure/session/binding-factory.ts
- src/cli/chat.ts
- src/cli/sessions.ts
- tests/integration/session-cli.test.ts
- tests/fixtures/session-peer.mjs
- src/cli/session-application.ts
- src/infrastructure/catalog/inventory-composition.ts
- src/infrastructure/catalog/platform.ts
- src/cli/bounded-streams.ts
- tests/integration/session-io.test.ts

验收：
- 端口注入、owner lease和资源等待完整
- 服务状态明确，不演示fallback
- 核心业务入口不按厂商名称分支

场景：G059-C01, G059-C02, G059-C03, G059-NC1。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G060 运行真实协议与平台兼容验收

范围：运行真实协议与平台兼容验收；仅交付所列文件与对应行为。

依赖：G059。需求：R04, R20, R24, R25, R12, R16。

唯一交付物：
- tests/conformance/harness-matrix.test.ts
- docs/verification/compatibility.md
- tests/protocol/g060.test.ts
- tests/platform/g060.test.ts
- tests/e2e/g060.test.ts
- tests/real/codex-local-provider.real.ts
- tests/real/codex-session.real.ts
- tests/fixtures/web-harness-peer.mjs
- tests/real/gemini-provider.real.ts
- tests/real/harness-provider-switch.real.ts
- tests/fixtures/managed-inventory-peer.mjs
- tests/real/managed-install.real.ts
- tests/real/live-web-stream.real.ts
- tests/real/homebrew-native.real.ts
- tests/real/native-resume.real.ts
- tests/real/native-catalog.real.ts
- tests/real/native-activity.real.ts
- tests/real/native-attachments.real.ts
- tests/real/native-commands.real.ts
- tests/real/native-branch.real.ts
- tests/real/native-extensions.real.ts
- tests/real/native-config.real.ts
- tests/real/native-import.real.ts
- tests/real/native-subagent.real.ts
- tests/real/native-question.real.ts
- tests/real/native-thinking.real.ts
- tests/real/native-options.real.ts

验收：
- 记录通过/失败/未覆盖，不能称全协议认证
- 平台证据独立，缺宿主不能算通过
- 指定版本组合验收，真实凭据不入仓库
- 真实HTTP/Store/IPC/原生进程与产物/清理完整可核对
- 真实HTTP/Store/IPC/原生进程与产物/清理完整可核对

场景：G060-C01, G060-C02, G060-C03, G060-C04, G060-C05, G060-P01, G060-P02, G060-M01, G060-S01, G060-N04, G060-NC1, G060-NC2, G060-NC3, G060-NC4, G060-NC5, G060-NC6, G060-NC7, G060-NC8, G060-NC9, G060-NC10, G060-NC11, G060-NC12, G060-NC13。

禁止范围：不修改其他任务所有权文件；不把局部通过提升为完整链路或真实Harness通过。

## G061 接通Harness管理HTTP入口

范围：接通Harness管理HTTP入口；只冻结所属契约或实现所属入口。

依赖：G009, G011, G012, G013, G014, G015, C009。需求：R03, R04, R17, R22。

唯一交付物：
- src/infrastructure/http/harness-routes.ts
- tests/integration/g061.test.ts
- tests/integration/web-management.test.ts
- tests/integration/managed-discovery.test.ts
- tests/integration/web-session-stream.test.ts
- tests/unit/web-session-stream.test.ts
- tests/unit/web-api.test.ts
- tests/integration/native-models.test.ts
- tests/integration/native-experience.test.ts

验收：
- 操作复用Catalog服务且管理身份正确
- 明确拒绝或幂等，不绕过排空规则
- 旧执行保留版本，新准入遵循新状态

场景：G061-C01, G061-C02, G061-C03, G061-M01, G061-M02, G061-M03, G061-S01, G061-S02, G061-S03, G061-L01, G061-N01, G061-N02, G061-X01, G061-NC1, G061-NC2, G061-NC3, G061-NC4, G061-NC5, G061-NC6。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## G062 接通Provider管理HTTP入口

范围：接通Provider管理HTTP入口；只冻结所属契约或实现所属入口。

依赖：G009, G010, G016, C009。需求：R10, R17, R22。

唯一交付物：
- src/infrastructure/http/provider-routes.ts
- tests/integration/g062.test.ts

验收：
- 复用模型资源服务且不泄露凭据
- 提交前拒绝且错误脱敏
- 不悄悄改写已接收选择或历史计划

场景：G062-C01, G062-C02, G062-C03。

禁止范围：不修改其他任务所有权文件；契约冻结不表示应用实现或真实链路验收。

## G063 建立依赖与公共类型边界检查

范围：在端口实现前建立可执行边界和公开类型检查。

依赖：G001, C008。需求：R19, R23, R24, R25。

唯一交付物：
- tools/check-boundaries.mjs
- tools/check-contract-surface.mjs
- tools/boundary-rules.json
- tests/integration/g063.test.ts

验收：
- 合法依赖与发布类型通过
- 领域导入SDK/HTTP/SQLite/子进程及私有类型泄露被拒绝
- 检查自身无效fixture非零退出

场景：G063-C01, G063-C02, G063-C03。

禁止范围：不实现业务执行或适配器；不把静态边界检查当行为验收。
