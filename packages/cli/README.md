# @harnesshub/cli

`hh` 命令中不属于守护进程的部分。目前只有 [cli.ts](src/cli.ts) 的 `rollout` 子命令：经 Gateway 的轨迹接口把已提交的事件流式导出为文件（[rollout/export.ts](src/rollout/export.ts)），拒绝覆盖已有文件。内容在 OSS-004 第 9 步从 `src/cli.ts` 与 `src/rollout` 迁入。按依赖图它只能依赖 `@harnesshub/core` 与 `@harnesshub/sdk`，通过 HTTP 而不是导入服务端包访问守护进程。编译后的入口是 `dist/src/cli.js`。
