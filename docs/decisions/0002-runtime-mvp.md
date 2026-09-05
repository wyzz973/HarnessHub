# ADR 0002：首条执行链路的协议与运行限制

Status: accepted

日期：2026-09-05。具体实现与证据见 [运行API](../runtime-api.md)和 [验收记录](../verification/2026-09-05-runtime-mvp.md)。

## 问题

需要尽快交付真实跨进程执行链路，同时避免后端事件断流、进程退出和权限回调被误读为公共Run完成。acpx管理自己的进程与文件状态，模型配置和Windows自动化条件尚不完整。

## 决定

公共运行记录与IPC类型位于domain，Store和Worker共用同一契约。Gateway Runtime拥有期限与终态；SQLite事务提交后发布事件。IPC使用逐消息ACK，SSE从持久游标有界读取；文本产物写完并校验后登记。

Worker使用明确允许的系统环境及Profile声明的credentialEnv，HOME/XDG/AppData/tmp归每个Session所有。默认限制常驻Worker数量，不能恢复的会话不会静默回收。未验证恢复能力的ACP Session在重启或异常释放Worker后关闭，历史仍可查询。

SQLite owner保证同一数据库只有一个Gateway实例负责状态；旧Worker依持久lease中的token/命令/PGID核实后恢复清理。清理未确认的资源保持隔离并计入容量，握手和Run等待均明确失败，避免无限等待。

ACP使用startTurn的独立result，turn timeout关闭以接受父进程的统一deadline。权限决定必须保留实际optionId；acpx只能按kind返回，多个同kind选项时明确拒绝。applied只表示Worker接受映射，不能表示外部工具成功。

## 考虑过的替代方案

**同步把HTTP连接当执行生命周期。** SSE断开无法说明后端是否停止，不能满足重连与持久查询，因此执行独立于订阅。

**继承整个宿主环境与原HOME。** 可以直接复用已有CLI配置，但会扩大凭证和日志的共享范围。本实现使用私有HOME和显式引用，真实引擎需另行提供配置。

**未经验证自动恢复ACP会话。** acpx或Engine可能退回新会话，无法证明原上下文延续；当前采取明确关闭并保留历史，后续通过恢复验收后再开放。

## 后果

无需真实模型即可验证Gateway、SQLite、Worker和ACP协议组合。真引擎登录配置不能依赖原HOME，动态能力矩阵和Windows监督仍须实际验证；当前不宣称全平台或比赛任务已经完成。

发布入口与实例演示已存在，后续沿同一路径继续接入引擎，不再创建第二套执行服务。配置与传输的现有限额见运行API，不把这些限额冒充模型token预算。
