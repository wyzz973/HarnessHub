# 验收：Windows 原生进程监督

日期：2026-09-06
范围：[ADR 0007](../decisions/0007-windows-process-supervision.md) 的 Job helper、Worker、CLI、ACP 初始化探测与崩溃恢复。
结果：下述场景已验证；真实模型和 OS 沙箱不在本记录的通过范围。

## 环境与版本

Windows 11 专业版 10.0.22621 ARM64 原生主机，Node v24.20.0 `win32/arm64`，HarnessHub 0.1.0，基线 commit `162f39d88e35b45a195b479d918caaac6120d3d6` 加 Windows 适配未提交工作区。C# helper 使用本机 .NET Framework `csc.exe` 编译为 AnyCPU，并调用当前 Windows 内核 Job API。本轮使用编译后的 fixture 引擎，不调用真实模型、不消耗模型 API。

## 实际执行

工作目录为仓库根目录，PowerShell 中使用项目本地固定 Node：

```powershell
& '.tools/node-v24.20.0-win-arm64/node.exe' scripts/build-windows-job.mjs
& '.tools/node-v24.20.0-win-arm64/node.exe' node_modules/typescript/bin/tsc -p tsconfig.json
& '.tools/node-v24.20.0-win-arm64/node.exe' --test dist/tests/integration/worker-host.test.js
& '.tools/node-v24.20.0-win-arm64/node.exe' --test dist/tests/integration/worker-cli.test.js dist/tests/integration/windows-process.test.js dist/tests/smoke/cli.test.js
& '.tools/node-v24.20.0-win-arm64/node.exe' node_modules/eslint/bin/eslint.js src/process src/drivers/configuration/probe.ts tests/integration/windows-process.test.ts tests/fixtures/windows-probe-peer.ts tests/integration/worker-host.test.ts tests/integration/worker-cli.test.ts tests/smoke/cli.test.ts --max-warnings=0
```

原生构建、TypeScript 和以上局部 lint 退出码为 0。Worker-host 的 7 项测试通过；进程组合测试 10 项通过、0 失败、1 项跳过。随后增加发行产物缺失测试，并单独重跑 Windows 专用组 5 项全部通过。跳过项为仅针对 POSIX 进程组信号的 EPERM 故障注入，Windows 使用 Job 查询和终止，未将该跳过计为通过。

## 可观察证据

- 原生 launcher 保留空参数、中文空格、引号、尾部反斜杠、shell 元字符；解析后的 argv 与输入数组完全一致。
- 原生 launcher 强制 SIGKILL 后，其根进程与后代 PID 均通过原生进程存在性检查确认消失。
- Windows ACP initialize 正常响应与运行中取消两种场景，在 probe Promise 返回后均确认 Adapter 和后代不存在。
- Worker 启动立即取消，不向 sink 交付执行事件，Job 清理 confirmed，lease 目录清空。
- 将真实编译 supervisor 模块复制到缺少 native helper 的私有发行目录，ready 以 ENOENT 拒绝，空闲 Worker 被停止且不获得执行授权；清理状态保守返回 unconfirmed，不虚报原生监督已建立。
- Worker 事件有序交付、复用、权限等待取消、sink 失败、已验证 lease 回收、伪造 ownerToken 保留隔离且原 Worker 继续运行，均通过原生链路。
- CLI UTF-8 流、字面 argv、缺失可执行文件、非零退出、字节预算超限、执行取消、Gateway deadline，以及成功/失败结果前回收后台后代均通过。
- 真实编译 Gateway 的活动 CLI 产生后代后，强制终止 Gateway；确认 CLI 全树消失，再以相同数据目录启动 Gateway。原 Run 为 interrupted、cleanupStatus confirmed、只有一个 RUN_INTERRUPTED 事件、lease 清空，不重跑。
- plain Node 正式入口 smoke 在 Gateway 崩溃后读回同一持久 Run 并确认清理。

各测试独占随机临时目录、进程和端口；Run/Session ID、PID、事件断言由测试现场获取，结束后清理测试运行数据，不把真实轨迹或凭证保存进仓库。

## 未验证项与限制

Windows 10 和 Windows x64 原生主机尚未运行。真实 Codex/OpenCode/Pi/DSH 模型、特殊 MCP 进程创建路径、提权、WMI/服务 broker、恶意同用户程序、文件/网络/桌面沙箱均不属于这些测试的保证。可恢复 ACP fixture 的组合验收和全仓检查由总体验收另行记录。

Job API 无法建立所有权、helper 不可用或旧 lease 无证据时必须失败或保留 unconfirmed，不能静默退回 taskkill 后声称清理通过。

## 文档与复现

测试源码：[Windows 原生进程](../../tests/integration/windows-process.test.ts)、[Worker Host](../../tests/integration/worker-host.test.ts)、[CLI Worker](../../tests/integration/worker-cli.test.ts)、[正式 Gateway smoke](../../tests/smoke/cli.test.ts)。从上述构建命令得到编译产物后运行同一测试即可复现；依赖真实 Windows Job API，其他平台明确跳过 Windows 专用组。
