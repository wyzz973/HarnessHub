# 0014：Gateway 与引擎之间的诊断日志

- 状态：accepted
- 日期：2026-09-19
- 范围：Gateway 日志、Session 引擎日志、ACP 流量观察、日志级别、离线日志收集
- 关联：[ACP 客户端能力](0010-acpx-client-capabilities.md)、[统一模型网关](0013-unified-model-gateway.md)、[运行观测](../observability.md#诊断日志)

## 问题

比赛机离线，不能挂调试器。Windows x64 真实模型验收中，一次完整比赛运行的 Gateway 输出只有约 600 字节的启动行：没有访问记录、Session/Run 生命周期、Worker 与引擎进程的启动退出、ACP 请求与响应，也没有模型调用行。引擎自带日志埋在各 Session 私有目录深处，出错时只有 `worker-errors.log` 的异常栈。Worker 的 stdio 被忽略，acpx 默认丢弃引擎 stderr，CLI Driver 也不读取 stderr。失败因此很难定位是引擎启动、ACP 协议、权限、模型网关还是上游模型的问题。

## 决定

两类 JSON Lines 文件，统一格式 `{"time","level","event",...}`：

- **Gateway 日志** `<dataDir>/logs/gateway.log`：由组合根打开。访问日志来自 Fastify `onResponse`（方法、路由、不含查询的路径、状态、耗时、路由中的 Session/Run/权限 ID，不含请求体与头）；生命周期来自 Store 装饰器，只在委托方法成功返回后记录已提交的变化（Session 创建含引擎日志路径、状态、后端绑定；Run 接收、状态、结束含耗时与公开错误；权限请求、决定、应用；每个 `model.call` 摘要及引擎错误、安装、清理事件）；Worker 启动、就绪、退出、失败由 ProcessWorkerHost 记录。入口进程把 info 级生命周期行同时打印到 stderr（stdout 仍只有入口自己的 ready 事件，按首行解析的调用方不受影响），访问与模型调用行只写文件。
- **Session 引擎日志** `<dataDir>/backends/<sessionId>/diagnostics/engine.log`：由该 Session 的 Worker 写。内容为 Run 开始、准备结果（实际命令、MCP 服务名、模型网关地址）与结束；ACP Driver 通过 [acpx 补丁](../../patches/acpx@0.13.2.patch)新增的只读回调记录每个 JSON-RPC 请求/响应/通知（方向、方法、ID、耗时、错误；initialize 的引擎名称版本与能力；session/new 的模型），`session/update` 按轮汇总块数与字节，工具调用只在状态变化时记一行，权限记自动批准或转交结果；引擎进程启动、退出与 stderr 逐行（每进程 256 KiB，超出计数）；CLI Driver 同样记录进程、stderr 与输出大小；每次模型网关调用一行，复用 `ModelCallRecord` 并补充入站路径、首字节时间、推理回填（恢复数与仍缺失数）和规范化增删的参数，不另建第二份记录来源。

`HARNESSHUB_LOG_LEVEL=info|debug`（默认 info）在 `startHub` 启动时解析，非法值拒绝启动；Worker 通过显式环境继承同一值。debug 另外写入 2 KiB 的 ACP 参数/结果、非文本会话更新、Run 输入和模型请求/回答摘录（含提示词与回答正文，只进私有日志，模型网关以独立的 `onPayload` 观察者提供，`ModelCallRecord` 仍不含正文）。

写入规则：每条记录同步追加（不长期占用文件句柄，进程崩溃前的记录已落盘），字符串字段截断到 8 KiB；序列化后整行经脱敏（Session 已解析的密钥与网关 token、统一模型密钥、Bearer/sk-/key=value 形式），脱敏后必须仍是合法 JSON；文件 0600、目录 0700，超过 16 MiB 轮转，保留 3 代。日志失败不改变运行结果：首次失败报告一次（Gateway 写 stderr，Worker 发 `diagnostics.log_failed` 事件），之后放弃该文件；轮转失败只报告并继续追加。

发行布局提供 `Collect-Logs.cmd`（仓库为 `pnpm logs:collect`）：完整收集 HarnessHub 日志及其轮转文件、每个其他 `*.log` 的末尾 2 MiB（最多 300 个），逐文件再次脱敏后打成带 `manifest.json` 的 ZIP，不跟随符号链接。

模块上新增 `logging`（只依赖 domain 与 Node 文件库），组合根和 Worker 可使用；Gateway、Runtime、Driver 只依赖 domain 中的 `LogSink` 接口，由组合根或 Worker 注入。

## 考虑过的替代方案

- 直接在 Runtime 各状态转换处调用日志：侵入执行核心、容易漏记或在提交前记录。Store 装饰器只看成功提交的结果，与“先提交再发布”一致。
- 打开 acpx 的 `verbose`：只把引擎 stderr 原样写到 Worker 被忽略的 stderr，没有结构、不按 Session 区分，也看不到 JSON-RPC 流量。
- 用包装进程转发并解析引擎 stdio：与引擎无关，但会改变 acpx 按命令识别 Gemini/Claude 等引擎的启动逻辑，并增加 Windows 进程树与引号风险。acpx 内部已在唯一位置观察每条消息（`createTappedStream`），但管理器的 `setEventHandlers` 会清掉构造时的观察者，公开 runtime 也没有入口，因此沿用 ADR 0010 的补丁方式公开两个只读回调。
- 使用 pino 等日志库：需要新增依赖并进入离线 pnpm store，轮转和脱敏仍需自写；当前记录量下同步追加足够。

## 后果与验证要求

日志增加磁盘写入：info 级每轮 ACP 约数十行，访问行随评测方轮询增长；轮转限制为每个文件 64 MiB 上限。debug 会写入提示词和回答摘录，只用于排查，不应在需要保密任务内容时开启。升级 acpx 时必须确认上游提供等价观察接口，或重新验证补丁中的四处改动（消息观察者保留、spawn、stderr、首次退出）。

验证：单元测试覆盖级别解析、摘录、脱敏与合法 JSON、保留字段、轮转代数与顺序、失败只报告一次、ACP 流量各类记录与 stderr 预算、Store 装饰器只记成功提交、ZIP 与收集器；集成测试经正式 Gateway/Worker、ACP fixture 与本地上游模型分别以 info、debug 运行，检查两份日志的必备记录、推理回填计数、stderr 脱敏以及公司密钥与 Session token 均未出现。真实引擎与 Windows 上的日志内容需在对应验收中另行确认。
