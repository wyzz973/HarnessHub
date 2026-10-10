# 当前 MVP 推进顺序

2026-10-09 用户要求本机核心先做出来。第一阶段以当前宿主为验证基线；平台、发布和多发行版兼容后置。完整任务 DAG 是后续工程地图，不要求先完成所有扩展条目才能得到第一个可用功能。

| 切片 | 交付 | 当前状态 |
|---|---|---|
| S01 检测与控制配方 | 找到本机 Harness、解析控制入口与 Adapter 依赖，支持自定义描述文件 | 已扩展目录v2、43产品/47入口；不把目录当执行支持 |
| S02 控制面接通 | ACP 与 Codex 原生握手、事件、结束、取消、关闭 | 已实现并合成测试；真实Codex/Gemini握手与真实Codex+本地模拟Provider通过；OpenCode本机SIGKILL未通过 |
| S03 统一入口最小闭环 | 公共 Session → 消息 → 一个 Harness → 流式结果与持久历史 | 已实现SQLite/幂等/公共事件/重开；真实Codex3轮跨2入口通过，Provider模拟 |
| S04 同 Session 换 Harness | 公共上下文交接与 A→B→A | 已实现手动切换/FIFO/wait_current/静止生效；真SQLite+真Driver+外部peer的A→B→A通过，真实Codex→Gemini→Codex已通过，本地模拟模型服务 |
| S05 自动分配 | 规则式任务/能力过滤与可解释选择 | 用户明确后置，当前不实现 |
| S06 独立模型选择 | 保持 Harness 改 Provider/模型，实际调用可查 | Provider版本/vault/静止切换已实现，真实Codex双Provider与Gemini本地API通过 |
| S08 图形工作台 | 对话、Provider配置、Harness检测 | 已重做原生布局/品牌图标/搜索选择与细微动效，实际浏览器验收见对应记录 |
| S09 Harness管理 | 安装、升级、版本、进度/日志/取消 | ADR012本机私有版本切片；正式结果见管理验证，不以目录数量代替验收 |
| S07 在途控制与可靠性 | 权限、取消、busy switch、故障和恢复 | 贯穿前面切片，逐步补齐 |

每个切片完成最小设计与验证再推进。当前开放S01/S02及[ADR-010](../decisions/0010-public-session-mvp.md)的S03/S04限定路径；原生会话与公共Session仍分离。[ADR-011](../decisions/0011-provider-web-mvp.md)另开放Provider资源和HTTP/图形界面；[ADR-012](../decisions/0012-harness-management-workbench.md)另开放本机私有安装/升级/版本及UI重做，当前切片验收已完成；自动路由后置，真实模型和全部厂商组合不能从合成测试推断。

S08的[ADR-013](../decisions/0013-live-chat-experience.md)增量已实现：已提交事实的实时SSE、薄客户端投影、重连与紧凑对话组件。首块先于完成、刷新不重派发、部分文本取消与滚动/Markdown通过本机浏览器和真实Codex验证，详见[实时对话验收](../verification/live-chat-2026-10-10.md)。
