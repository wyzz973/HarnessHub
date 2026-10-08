# Harness 与模型切换状态契约

状态：proposed。切换过程由应用层 process manager 协调，Session 聚合控制意图准入和生效。

## 模式与入口

用户手动指定；auto 策略为下一 Turn 作选择；策略建议交接（有独立建议证据）。第一版不做静默的执行中 Harness 替换。用户在任何阶段都能提出请求，但请求与生效分开。

切换可以只改 Harness、只改 Provider/模型或同时改；所有选择组成不可变 desiredSelection。是否继承默认模型/工具必须显式记录，不能因为换 Agent 就偷偷恢复它自己的账号。

## 过程建议

requested → validated → waiting_boundary/quiescing → preparing_context → preparing_binding → effective；另有 blocked、failed、superseded、cancelled。具体 wire 状态由契约冻结。

1. 以 key、expected epoch/version 持久记录请求；验证目标版本与能力。
2. idle 时可直接准备；busy 时按用户指定的 wait_current 或 cancel_current 处理。默认建议 wait_current，需在产品验收前冻结。
3. 旧 Attempt 结算，取消待决权限，模型调用停止，进程和写租约达到足够的 quiescence evidence。unconfirmed 时 blocked，不给新执行者写权。
4. 固定公共水位并构建 ContextManifest；准备目标绑定，模型变更需要验证原地操作或显式重建。
5. Session 根以 CAS 更新 epoch 和实际 selection，发布 effective 事实；下一 Turn/Attempt 使用新快照。

用户可以先提出切换，再发送下一条消息。第一版建议一次只保留一个待决切换，新的不同请求返回 SWITCH_PENDING；是否允许替换待决请求另做显式命令，不能靠最后一次 UI 状态覆盖。

## 失败与恢复

目标准备失败不改实际 selection，保留公共历史与真实结果；旧后端已经关闭时不能声称它仍活着。后续继续需要验证旧绑定或从公共上下文重建，并报告接续等级。

切换受理后不能自动重新运行上一输入。请求生效但响应丢失时按 SwitchId 查询；崩溃恢复先核对 epoch、执行、outbox、绑定和租约，再继续仅无副作用的准备步骤。

## 竞态

切换与完成/取消/deadline；两个切换请求；切换与新消息；目标 drain；工作区变化；模型目录更新；权限 late reply；旧 Worker 复活/迟到事件；切换提交前后崩溃。

每一种交错必须保留唯一实际 selection 和执行权；只有生效事件能改变用户看到的实际执行者。请求态界面不能提前把新 Harness 显示成已经运行。
