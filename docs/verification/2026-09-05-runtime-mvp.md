# 验收：首条执行链路

日期：2026-09-05。结果：阶段 A 的文本执行服务及本地 ACP 后端已验证；真实模型、Windows和Benchmark尚未完成。按用户限时比赛要求，只对新增或变更范围进行必要检查，未反复执行已通过的全套用例。

## 环境与版本

macOS / Darwin arm64；实际 Node 24.20.0、pnpm 10.12.3、TypeScript 5.9.3。依赖版本以 [锁文件](../../pnpm-lock.yaml)为准；Fastify 5.12.3、acpx 0.13.2、ACP SDK 1.4.0。

已建立 Git 基线 `fd0074a`，实现工作位于 `codex/mvp-runtime`。本记录与对应实现一同提交，验证发生在该实现的工作树中；没有向远端推送或运行远端 CI。

## 实际验证

| 执行范围 | 实际结果 |
|---|---|
| Node版本检查、依赖import | Node24匹配固定版本；Fastify/Swagger/Ajv/YAML/acpx/SDK加载成功 |
| 锁文件干净安装 | 在私有空目录离线 `pnpm install --frozen-lockfile`，177个包均来自缓存，安装/构建成功 |
| `pnpm build` | 严格类型检查和编译通过；ES2024对应Node24能力 |
| 工具检查 | 工程新增12项工具级测试通过；模块边界拒绝样例真实失败 |
| 真SQLite集成 | 7项通过；事务回滚、两个连接竞争终态、幂等、权限状态、重开及版本拒绝 |
| Gateway/Worker/CLI首轮组合 | 10项通过；包括SSE/产物/重启、取消与权限、Worker、ACP SDK对端和正式CLI崩溃恢复 |
| 配置/队列补充 | 5项相关检查通过；满队列幂等重放、配置拒绝、会话关闭不等待其他会话、活动/排队超时 |
| Worker环境隔离 | 原有相关5项通过；新增隔离用例单项通过，证明ambient secret不继承、显式credentialEnv可用、日志引用位于私有HOME |
| SQLite故障注入 | 单项通过；事件持久化失败导致Run失败、readiness返回503并停止新接收 |
| 常驻Worker容量 | 单项通过；超限明确失败，关闭已有Session后容量可用 |
| 文档工具新增排除项 | `.tools`等生成内容排除对应单项通过；相同无效链接放普通目录仍失败 |

上表各执行组存在重复成员，不将其相加冒充互不重复的测试数量。修复和新增检查只重跑受影响范围。实际测试文件见 [Gateway集成](../../tests/integration/gateway.test.ts)、[Store集成](../../tests/integration/store.test.ts)、[Worker集成](../../tests/integration/worker-host.test.ts)、[ACP集成](../../tests/integration/worker-acp.test.ts)、[CLI smoke](../../tests/smoke/cli.test.ts)。

SQLite一次测量：1,001次 WAL/FULL 事件事务总计62.6 ms、最长单次2.0 ms；仅为该宿主的开发测量，不是吞吐承诺。Worker对公共IPC逐消息ACK，SSE读批次有界；不能推导acpx内部所有缓冲均有界。

## 阶段 A 收尾证据

- 新增4项Store验证通过：活owner拒绝、token释放保护、死PID并发接管、安全配置快照与旧记录unknown投影。
- 新增2项旧Worker恢复验证通过：核实旧进程组后回收；伪造或不匹配身份不误杀。
- 新增2项失败收敛/隔离容量验证通过：未确认或失败清理拒绝握手和执行结果，不无限等待；未确认lease占用Worker容量。
- 独立Rollout CLI smoke通过：正式Gateway字节一致性、覆盖拒绝、404清理和缺参非零。
- 响应schema与owner恢复接入后，对受影响Gateway/ACP/CLI组验证9项通过。CLI崩溃恢复在POSIX已核实旧Worker清理时返回confirmed；未知归属仍返回unconfirmed。
- 新增3项控制与压力验证通过：握手中取消、同轮完成/取消竞争、100,000字符/128分块时暂停SSE不阻塞Run完成，另一权限请求可按期超时且拒绝迟到审批。

单元层通过可控Worker端口构造确定性竞争，真实IPC与发布入口由独立集成用例验证；没有用端口替身冒充端到端执行。

## 留存的演示

服务：`http://127.0.0.1:3180`，以 `--demo` 启用假引擎。

- Session：`f9c6424f-8d66-4f6d-90b9-f772d46b2bb8`
- Run：`c503a7b2-916b-4338-9a87-c0670ff81632`
- 结果：`completed`，已提交事件6条。
- 文本产物：`1f8f966f-c664-4a86-9de4-c9aa95722f95`

数据保存在被Git忽略的本地 `data/` 目录，可经API查询产物和Rollout。该演示没有调用真实模型。

## 外部环境与未验证项

Windows 11 ARM VMware虚拟机已运行；vmrun的Guest Tools/IP探测受加密密码限制，未获取Guest连接，也未启动额外VM或读取凭证。此信息不能当作Windows原生功能通过。

宿主已安装OpenCode1.1.21。一次私有HOME/最小环境探针在17秒内未完成initialize，未进入session/new或prompt；总耗时17.227秒，结束后核实进程组消失并清理临时目录。该结果无法判定版本不兼容，未反复重试或升级引擎。Pi/pi-acp/DSH未在PATH发现。

没有真实模型配置或预算证据。真实引擎上下文恢复、进一步平台压力、Benchmark及Windows原生验收仍由 [TODO](../../TODO.md)跟踪。当前配置能力采用保守值，不把本地ACP对端结果或Windows直系子进程退出视为整条真实引擎链路通过。
