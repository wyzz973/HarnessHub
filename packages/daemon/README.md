# @harnesshub/daemon

唯一的组合根：守护进程入口 [main.ts](src/main.ts)（`startHub`，命令行 `serve`）、Benchmark 入口 [benchmark-main.ts](src/benchmark-main.ts)、工具包命令 [tool-packages-main.ts](src/tool-packages-main.ts)、HTTP 层 [http/](src/http/server.ts)（原 `src/gateway`，路由、校验、OpenAPI 与 [api-catalog.ts](src/http/api-catalog.ts)）、诊断日志 [logging/](src/logging/json-log-file.ts)，以及 Session Worker 进程入口 [worker/main.ts](src/worker/main.ts)。内容在 OSS-004 第 9 步从 `src/` 迁入，`src/` 随之删除；各目录保留原模块的规则（`http/` 按原 `gateway` 模块检查）。按依赖图它可以依赖除 cli、sdk、console 外的全部包；只有 `worker/` 可以导入 `@harnesshub/drivers`。第三方依赖为 `fastify` 与 `@fastify/swagger`。

编译后的入口是 `dist/src/main.js`（`pnpm start`）、`dist/src/benchmark-main.js`（`pnpm benchmark`）与 `dist/src/tool-packages-main.js`（`pnpm tools`）。`main.ts` 把自己的 `worker/main.js` 作为必填的 `workerEntry` 交给 Worker 宿主；`pnpm build` 把构建身份写到本包的 `dist/build-info.json`，与 `main.js` 读取的位置一致。Benchmark 报告的 Hub 版本取自本包的 `package.json`，各包版本保持一致。
