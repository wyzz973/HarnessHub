# @harnesshub/runtime

执行平面：Session 队列、Run 状态机与期限（[runtime/](src/runtime/runtime.ts)）、HTTP 与 Benchmark 共用的应用服务、工作流与观测（[application/](src/application/service.ts)）、Worker 进程的启动、归属、租约与清理（[process/](src/process/worker-host.ts)，含配置探测 [probe.ts](src/process/probe.ts)、POSIX 进程树与 Linux `/proc` 扫描、Windows Job Object），以及 Benchmark（[benchmark/](src/benchmark/runner.ts)）与文件产物（[artifacts/](src/artifacts/collector.ts)）。内容在 OSS-004 第 8 步从 `src/runtime`、`src/process`、`src/benchmark`、`src/artifacts`、`src/application` 的三个服务与 `src/drivers/configuration/probe.ts` 迁入；各目录保留原模块的规则，`process/probe.ts` 按其原来的 `drivers` 模块检查。依赖 `@harnesshub/core`、`@harnesshub/store`（产物使用其 Windows 文件原语）与 `@harnesshub/agents`（探测读取准备好的配置），第三方依赖为 `ajv`。

Worker 宿主不知道 Worker 入口在哪里：`ProcessWorkerHost` 的 `workerEntry` 选项必填，由拥有 Worker 的组合根传入（V5）；租约记录各自的 Worker 路径，恢复时按记录校验，与当前入口无关。

`process/` 是子进程启动的长期归属：按 [02 第 8 节](../../docs/proposals/oss/02-architecture.md#8-模块与依赖规则) 与 [10 第 2 节](../../docs/proposals/oss/10-engineering.md#2-代码规范)，`ProcessLauncher` 的实现在这里，因此 [边界检查](../../tools/check-boundaries.mjs) 永久允许它使用 `node:child_process`，不作为带期限的例外；OSS-010 F08 再把允许范围收窄到启动器实现本身。

Windows Job Object 辅助程序的源码是 [native/windows-job.cs](native/windows-job.cs)，`pnpm build` 在 Windows 上经 [native/build-windows-job.mjs](native/build-windows-job.mjs) 构建到本包的 `dist/native/harnesshub-job.exe`；路径由 [windows-job.ts](src/process/windows-job.ts) 的 `jobHelperPath()` 给出，[test/native-helper.test.ts](test/native-helper.test.ts) 检查它。
