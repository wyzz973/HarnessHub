# 决策记录

下表七项完整架构议程仍为 proposed，记录建议、替代与代价；没有因生成文档而自动变为 accepted。

已接受：[ADR-008](0008-local-first-mvp.md)开放本机只读检测；[ADR-009](0009-catalog-control-slice.md)依据用户开始实现的授权，开放目录扩展与受控原生控制连接。范围不等于全部未来架构已冻结。

[ADR-010](0010-public-session-mvp.md)采纳本机公共Session、SQLite事实日志与每轮public_context_rehydrate、静止Harness切换；不自动采纳整套未来HTTP/模型转发/路由方案。

[ADR-011](0011-provider-web-mvp.md)采纳本机Provider资源、不可变revision、私有配置与同源图形工作台；自动择优由用户明确后置。

[ADR-012](0012-harness-management-workbench.md)按用户授权采纳本机Harness安装/升级与品牌化原生工作台，默认私有受管目录，自动择优不变。

[ADR-013](0013-live-chat-experience.md)按实际对话反馈采纳实时会话SSE及紧凑聊天组件；不改变Run/选择/重试语义。

[ADR-014](0014-conversation-failure-recovery.md)按用户审查要求区分连接失败/执行未知/清理未知，保留对话与草稿，加入显式恢复和结束确认；存储v3保留历史与未知事实，未知任务不自动重跑。

[ADR-015](0015-native-harness-models-and-switching.md)按用户明确要求沿用所有本机Harness既有配置/登录，读取原生模型，并直接切换选择；覆盖先前native空HOME默认，追加v4格式。

| ADR | 建议 | 替代/代价 | 关闭条件 |
|---|---|---|---|
| ADR-001 | 公共 Session 与原生 BackendBinding 分离 | 直接暴露原生 ID 简单，但锁定 Harness，无法承载公共连续性 | D-02 与 D-04 冻结 |
| ADR-002 | 模块化单体、DDD 上下文与防腐 Adapter | 微服务有部署/一致性成本；巨型统一模型会污染领域 | 边界与应用契约评审 |
| ADR-003 | ACP v1 优先，原生协议单独适配 | 全部套 ACP 会丢失真实能力；只用 native 会重复生命周期逻辑 | D-01 能力报告 |
| ADR-004 | 规则式路由、硬约束优先、质量未知如实表达 | LLM/学习排名可扩展，但缺校准证据、成本与可复现性 | D-07 基线与策略版本 |
| ADR-005 | 持久意图/outbox、epoch fencing、先提交后发布 | 直接调用简单，但响应丢失/重启会重复副作用；全量 Event Sourcing 复杂度高 | D-02 与故障模型评审 |
| ADR-006 | 静止交接、public_context_rehydrate 为明确等级 | 把原生内部状态强行互换无法泛化；只允许换新公共 Session 不符合需求 | D-03/D-04 冻结 |
| ADR-007 | 模型目标独立，最小同协议桥接并记录调用 | 首版完整 N×M 转换扩大范围；直接传 Provider 秘密给 Harness 削弱归属 | D-01/D-06 与模型路径验证 |

每条被采纳时拆成独立 ADR 文件，写清上下文、证据、决定、否决方案、失败边界、测试、迁移与日期。当前表是决策议程，不能在开发中以“表里写了”绕过未决条件。

## 冻结交付所有权

ADR-001 由 C003，ADR-002/003 由 C008，ADR-004 由 C007，ADR-005 由 C004，ADR-006 由 C006，ADR-007 由 C010 交付独立记录；具体路径在任务唯一所有权中。索引由 V008 维护。

V008 必须核对每条核心 ADR 的 accepted/proposed 状态、契约/版本/验证证据、独立文件与索引一致性以及阻塞项。核心记录仍 proposed、缺证据或未交付时 G1 不通过；不能因为依赖图与格式检查通过就自动接受决定。

- [0016：本机原安装优先与OpenClaw原生接入](0016-local-installation-and-openclaw.md)（accepted）。
- [0017：原渠道安装管理与原生接入](0017-native-installation-management.md)（accepted）：覆盖生产私有安装默认；真实本机管理、配置保护和明确能力边界，统一Provider管理后置。

- [0018：原生CLI认证与Homebrew单沙箱恢复](0018-native-cli-recovery.md)（accepted）：原Homebrew SDK配置保护恢复、Cursor原生更新/登录和Gemini直连协议边界。

- [0019：快速选择与原生会话能力](0019-native-session-experience.md)（accepted）：选择与连接分离；本机配置/思考/命令/审批及v5迁移。统一聊天界面承载各Harness原生功能。

- [ADR-020：全部接入的Harness按原生能力接出](0020-complete-native-harness-capabilities.md)：所有Harness的完整接入标准、原生绑定与恢复、能力缺口及逐项验收。

- [ADR-021：原生配置来源透传、原生协议偏差容忍与能力矩阵](0021-native-profile-and-deviation-tolerance.md)（accepted）：只透传用户真实设置的配置位置变量；正常协议偏差归一而不归属；不代为执行原生全局写；逐Harness能力矩阵由设计检查校验。
