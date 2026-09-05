# 决策记录

ADR 记录重要且未来可能重新讨论的决定。适用范围见 [文档同步要求](../documentation.md#与代码同步)；原有模块已有决策所有者时优先更新，避免重复。

文件使用 `NNNN-short-topic.md`，采用 [ADR 模板](../templates/adr.md)。状态为 `proposed / accepted / superseded / rejected`。`accepted` 不表示功能已经实现或验证；重要验证另存 [验收记录](../templates/verification.md)。

每份记录至少有问题、决定、真正考虑过的替代方案、后果和验证要求。没有考虑过的方案不编造。改为相反决定时新建 ADR 并双向链接；原决定标 superseded，仍保留有价值的理由。

当前记录：

- [0001：开发与文档治理](0001-development-governance.md)
- [0002：执行链路协议与运行限制](0002-runtime-mvp.md)
- [0003：动态引擎目录与通用 CLI 接入](0003-dynamic-engines.md)

Worker、SQLite 和首批引擎三项已采纳决定及依据直接由 [DESIGN.md](../../DESIGN.md#1-已确认的三个决定)和 [源码调研](<../../HarnessHub 源码阅读与技术选型讨论稿.md>)拥有，暂不重复创建同内容 ADR。以后改变其中决定时在这里记录新的取舍。
