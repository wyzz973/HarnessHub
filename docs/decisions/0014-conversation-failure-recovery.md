# ADR-014：故障不销毁对话，恢复按执行证据处理

状态：accepted。2026-10-10，用户要求全面审查现有交互逻辑，Harness不可用时仍能在原对话继续操作。基线11c151e。

## 问题与依据

OpenClaw目标初始化因缺Gateway Token退出，close仍确认进程关闭，但Runtime把protocolFailure当清理未知，设置Session blocked并把整个Runtime设fatal。UI同时禁用输入、选择器与恢复，形成无出口。切换失败只藏在折叠历史；切换对话会清空未发送草稿。普通错误、结果未知、资源未知和所有权故障的责任没有分开。

对照2026-10-10阅读的[Vercel AI SDK Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)（Status/Error State/Cancellation）与[assistant-ui AI SDK](https://www.assistant-ui.com/docs/api-reference/integrations/ai-sdk)（status/error/transport ownership），采用消息级失败、保留历史、用户显式重试和有恢复动作的模式。来源示例不能证明所有产品同一行为；编码Agent的工作区副作用仍须按本项目证据判断。

## 决定

1. 初始化/open/目标切换失败且close确认，记本轮或切换failed，保留Session与原有效选择；不自动把等待失败切换的输入发给旧目标。已结算后协议异常保留backend/cleanup并记failed，不把已停止资源说成未知。
2. prompt已派发且无后端结算仍是unknown；cleanup未确认、工作区租约未知仍阻止该Session写入。会话级故障不毒化其他会话；真正Store/owner/公共发布故障仍停止整个Runtime。
3. blocked会话保留草稿、选择器、历史和关闭动作。显式resume用新的switch意图检查持久故障/清理证据、重新获取工作区租约、初始化/open/close目标，成功后同Session新epoch继续。unknown原始Run不可改写、不可自动重跑；若资源已关闭，用户需显式承认结果未知。清理未确认、所有权/存储/发布故障、证据缺失仍拒绝恢复，并解释下一步。
4. 恢复使用现有switch命令和只增事件（switch.requested带recovery/acknowledgeUnknown），快照字段保持，存储语义升级为v3。保留既有v1→v2迁移，追加事务内v2→v3格式迁移；身份、历史、命令指纹、业务版本和事件不改写，损坏整笔回滚，blocked不自动变open。旧版本明确拒绝v3，回退程序前需停止服务并恢复升级前的备份。blocked→open只允许新的有效切换，unknown历史必须有closed清理与有效切换来源证据；closed不可重开。旧误阻塞会话必须经显式检查，不直接改库/清租约。
5. 切换失败立即显示可读原因、旧有效选择和“继续使用当前选择”/重新选择；正常切换显示准备或等待当前回复结束。重试由用户点击创建新Run，原Run与部分内容保留，未知结果不提供一键重跑。
6. 草稿按工作区/对话保留，包括未确认命令身份；当前标签页sessionStorage允许刷新恢复，不保存Provider编辑表单或密钥。存储输入有类型/字段/字节校验，保存的接收标记不当作事实，必须由canonical消息确认；存储不可用时保留内存并明确提示。导航不取消运行、不丢未发送内容。改变Harness/Provider不得静默改模型/凭据，固定revision仍显式应用。不兼容、未安装、目录可达与执行可用分别说明。永久结束会话需要明确确认，取消确认不调用close。
7. 稳定错误分类从受控stderr白名单提取（Gateway认证缺失等），不把原始stderr/路径/凭据反射到UI。详细错误码在披露中，正文提供可执行的恢复动作。

## 范围与验证

审查现有会话创建/发送/排队/切换/停止/关闭/重连、Provider版本/失效、Harness发现/安装/升级和草稿导航。新切片所有权沿用G004/G028/G031/G032/G034/G050/G054/G059/G061，逐文件串行实施。完整自动路由、OpenClaw凭据接入和跨平台能力不在本次变更中。

必须覆盖真实SQLite/HTTP/Driver/进程的启动失败→选择恢复→同会话继续、失败目标不接收prompt、旧目标不自动接收等待输入、一个会话故障不影响另一工作区、未知不重跑/清理不明拒绝恢复、legacy blocked恢复幂等/终态不可改写；浏览器覆盖清晰失败动作、草稿往返、取消部分内容、连接重建、Provider变更、小屏/键盘。检查自身与无效输入保持拒绝。最终审查和实测记录由对应verification文档维护。
