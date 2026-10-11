# ADR-019：快速选择与原生会话能力

状态：accepted，2026-10-11。用户要求快速无缝切换、OpenClaw模型选择、原生思考档位，以及各Harness的原生功能体验。

普通选择只校验本机安装/配置并提交下一轮选择，不为选择创建并销毁原生会话。原生连接在实际发送时启动；effective只表示配置选择生效，不能作为登录、额度或网络成功的证据。blocked会话的显式恢复仍验证连接和清理；在途任务沿用旧选择，未知任务不自动重跑。

模型及选项由本机原接口发现。模型目录成功结果有界缓存，显式刷新旁路缓存；失败/空结果不缓存。前端按Harness/入口/工作区复用目录，切换不等待目录或网络。执行仍重新核实原安装及选择，缓存不作为认证或派发权威。

ACP保留全部select配置、模式、原生命令和思考输出；Codex模型的supportedReasoningEfforts及Pi原生thinking等级分别保留原值。公开选择追加nativeOptions，业务库v4→v5只进事务迁移，旧历史/命令/未知状态保留。覆盖通过原会话RPC或进程参数，不能写全局配置。

OpenClaw的原版ACP未暴露模型字段，但原Gateway提供models.list和sessions.patch。原CLI读取目录；模型覆盖只patch本轮由Hub创建的agent:*:harnesshub:*键，不改config或其他会话。ACP原生thought_level等配置直接沿用。

原生工具审批需要用户可见的往返；不继续强制拒绝或强制只读。权限请求和用户决定先提交事实，原实际选项ID与当前Run归属核对。取消/关闭清理待决请求；未知决定不自动重发。未获得后端确认不得宣称应用成功。原安装的skills/MCP/插件继续由Harness加载。

原生能力按当前版本/协议逐项实测；模型目录、文本回复或统一协议连通不代表全部厂商功能等价。界面不得伪造工具没有暴露的配置或思考档位。统一Provider转发仍后置；用户本机登录/原配置保持来源。

验证包括快速选择无多余子进程、在途/恢复/故障、原生选项及拒绝样例、v4→v5与回滚、审批往返/取消/刷新、原OpenClaw选择与实际回复，以及浏览器可见反馈和持久事实。

macOS退出后进程组信号EPERM不是独立的存活证据。XNU的killpg1会过滤僵尸并在未找到可发信号成员时返回EPERM；仅在已观察本轮根进程退出且得到EPERM时，增加有界系统进程表核实。任何活成员、格式错误、枚举失败仍不宣称清理成功。不能把所有EPERM当ESRCH。来源：[Apple XNU kern_sig.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)，killpg1/killpg1_callback。
