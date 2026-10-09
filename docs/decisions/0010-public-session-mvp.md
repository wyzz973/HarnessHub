# ADR-010：公共会话、持久日志与静止切换

日期：2026-10-09。状态：accepted，依据用户继续实施S03/S04的授权。

网关持有独立公共Session/Run/消息/切换身份与SQLite历史。每turn新连接、新原生会话，使用完整有界公共已终结历史，明确为public_context_rehydrate，不声称native_resume。后端结果先记录，关闭确认后再终结Run、释放writer并启动下一轮。

业务SQLite短同步事务保存聚合与append-only事件，提交后才发布；稳定commandId先去重，同key异payload冲突。另用owner.sqlite长期BEGIN EXCLUSIVE实现数据根OS排他，主进程直接持锁，不用TTL。所有操作/派发检查事务、路径身份及ownerGeneration。跨数据根的相同canonical工作区使用每用户应用自有锁根中独立SQLite锁+状态，避免两个入口并发写同工作区；崩溃遗留held状态不自动接管。

queued输入可有界接收；取消先落库；busy切换默认wait_current，持久requested与effective分开，已有pending拒绝不同请求。切换交接仅用已终结Turn与其消息ID、水位，不包含排队输入。确认旧writer静止并完成目标准备后才CAS更新selection/epoch。准备失败保留旧selection；未知/清理不确认/存储失败不激活目标，不重跑旧输入。

重启将未结算的preparing/running/settling变unknown并block对应Session；未派发queued取消，保留历史而不自动运行。未知进程不按PID杀；workspace隔离锁的残留held状态需要以后带证据恢复，本次不加绕过/清库命令。

CLI提供chat持续输入、:harness/:cancel/:history/:quit，以及sessions list/show/events/close。:quit仅结束本次运行所有者，Session可续接；显式close才停止公共Session准入。默认私有配置，Provider注册/选择与自动路由仍后续实现。

本次接受路径与测试见plan/slices.json。详见[公共会话切片契约](../contracts/public-session-mvp.md)。
