# harnesshub

`hh` 命令（npm 包名 `harnesshub`）。[main.ts](src/main.ts) 只做分派：`serve`、`benchmark` 与 `tools` 交给 `@harnesshub/daemon` 的 `main.ts`、`benchmark-main.ts` 与 `tool-packages-main.ts`，`rollout` 交给 `@harnesshub/cli` 的 `cli.ts`，各自只在选中时加载，因此 `hh rollout` 不加载守护进程。各命令的参数、输出与退出码与直接运行对应入口相同；缺少或未知的命令在 stderr 打印用法并以退出码 2 结束，`hh --help` 在 stdout 打印用法。按依赖图它只能依赖 cli 与 daemon。

可执行文件是 [bin/hh.mjs](bin/hh.mjs)：它是普通 JavaScript，包管理器在安装时（`pnpm build` 之前）就能为它建立链接，运行时导入编译后的 `dist/src/main.js`，因此先要 `pnpm build`。它不判断自己是否为主模块，因为安装后的命令经符号链接或 shim 调用，路径与模块自身不同。在本仓库中可以用 `pnpm exec hh <命令>` 或 `node apps/hh/bin/hh.mjs <命令>` 运行。Worker 入口在 OSS-008 之前仍由守护进程按自身路径派生。内容在 OSS-004 第 11 步加入。
