# 命令行 `hh`

| 项 | 内容 |
|---|---|
| 分类 | 界面与入口 |
| 状态 | 已实现 |
| 验证 | smoke 测试（`hh` 入口的分派、用法、退出码与 EPIPE）、集成测试（真实 `hh` 入口对进程内守护进程运行模型平面、接线、备份、同步等命令）、单元测试（管道处理），在 macOS arm64 本机通过；单可执行文件中每个命令的 `--help` 由构建检查；Windows 未验证 |
| 对照 Magpie | 部分：没有整体对照行，逐命令见 [Command map](../../magpie-parity.md#command-map)，其末行列出未覆盖的命令（`gateway-key rotate`、`sessions`、`update`、`autostart` 等） |
| 权威文档 | [apps/hh](../../../apps/hh/README.md)、[模型平面 API 与 CLI：CLI](../../model-plane-api.md#cli)、[README 的 CLI 概览](../../../README.md#cli-overview) |

## 用途

一个 `hh` 命令完成启动守护进程、配置 provider 与 Key、接线 Agent、查看用量、备份与同步等全部操作，适合脚本与无浏览器的环境。除 `serve` 等少数命令外，它经 SDK 调用运行中的守护进程，不直接读写数据库。

## 入口

| 入口 | 用法 |
|---|---|
| 命令行 | 在仓库中 `pnpm build` 之后运行 `pnpm exec hh <命令>` 或 `node apps/hh/bin/hh.mjs <命令>`；`hh --help` 列出命令，`hh <命令> … --help` 只打印该命令的用法 |

## 已实现的能力

- 29 个命令：`serve`、`version`、`config`、`status`、`console`；`init`；`provider`、`import`、`credential`、`model`、`catalog`；`key`、`group`、`usage`、`gateway`；`subscription`；`agents`、`wire`（`use`）、`unwire`、`profile`、`tui`；`library`；`backup`、`restore`、`sync`；执行平面的 `benchmark`、`tools`、`rollout`。
- 分派只加载所选命令的模块：`serve`、`version`、`config`、`benchmark`、`tools` 交给守护进程包，其余交给 `@harnesshub/cli`（模型平面命令另从守护进程包取得预设列表），因此 `hh rollout` 不加载守护进程。
- 通用选项 `--url`（默认 `http://127.0.0.1:3180`）、`--data-dir`（默认 `./data`，从中读取 `admin.token`）、`--json`、`--yes`、`--non-interactive` 可写在命令之前或之后。
- 输出：默认表格，`--json` 输出与 API 响应相同的 JSON；失败时 `--json` 把 problem 对象写到 stdout，并在 stderr 写一行说明。
- 秘密从不作为参数：终端中隐藏输入，非交互时必须用 `--from-stdin`、`--from-env <变量>` 或 `--from-file <路径>`（`provider add` 为 `--credential-from-stdin` 等），否则以 2 退出；备份与同步的口令从隐藏提示或 stdin 的行读取。
- 确认：删除、吊销、导入、接线、Profile 应用、Library 同步、恢复、关闭同步等先询问 `[y/N]`；`--yes` 跳过；stdin 不是终端、设置了 `CI` 或给出 `--non-interactive` 且没有 `--yes` 时以 4 退出、不做修改，错误为确认问题加 “No terminal to confirm; pass --yes.”。
- 退出码：0 成功；1 内部错误；2 用法错误、输入无效或名称不存在；3 守护进程不可达或数据目录中没有令牌；4 需要确认；5 冲突（409、412、422）；6 认证失败；7 达到上限或未就绪（429、503）；130 中断。接线预览之后文件被改动时以 5 退出。
- 缺少或未知的命令在 stderr 打印用法并以 2 退出；`hh --help` 在 stdout 打印用法。
- 读取方提前关闭管道（`hh usage --format csv | head`）时不以堆栈结束：之后的输出被丢弃，命令照常完成并返回自己的退出码。
- `hh version`、`hh --version` 打印构建身份，`--json` 输出全部字段。
- 命令与输出为英文。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [apps/hh/src/main.ts](../../../apps/hh/src/main.ts)、[packages/cli/src/admin.ts](../../../packages/cli/src/admin.ts)、[packages/cli/src/agents.ts](../../../packages/cli/src/agents.ts)、[packages/cli/src/backup.ts](../../../packages/cli/src/backup.ts)、[packages/cli/src/library.ts](../../../packages/cli/src/library.ts)、[packages/cli/src/init.ts](../../../packages/cli/src/init.ts)、[packages/cli/src/console.ts](../../../packages/cli/src/console.ts)、[packages/cli/src/pipes.ts](../../../packages/cli/src/pipes.ts) |
| 测试 | [tests/smoke/hh.test.ts](../../../tests/smoke/hh.test.ts)、[tests/integration/hh-cli.test.ts](../../../tests/integration/hh-cli.test.ts)、[packages/cli/test/pipes.test.ts](../../../packages/cli/test/pipes.test.ts)；各功能的集成测试另运行真实 `hh` 入口 |
| 决策 | 退出码与确认约定来自 [06 第 5 节](../../proposals/oss/06-interfaces.md#5-cli)；单可执行文件中的命令见 [SEA 第 10 节](../../proposals/oss/sea-spike.md#10-hh-的全部命令2026-10-04) |

## 已知限制与未验证

- 还不能安装：npm 包 `harnesshub`（`apps/hh`）标为 `private`，没有发布；只能在仓库中构建后经 `pnpm exec hh` 运行。单可执行文件只是原型（见 [构建身份与打包](../operations/build-packaging.md)）。
- `--data-dir` 默认是当前目录下的 `./data`，在另一个目录中运行命令会找不到 `admin.token`（以 3 退出）。
- `hh version --help` 打印的是 `hh serve` 的用法（2026-10-05 在本机运行确认）。
- 没有 client Key 的轮换、`hh doctor`、`hh debug bundle`、`hh admin-token rotate` 与 `hh self-update`。
- Windows 上未运行过。

## 优化候选

- **现状**：`hh` 只能从源码仓库运行。**方向**：注册 npm 包名并发布 `harnesshub`，或随首个发布提供单可执行文件。**依据**：[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项)中的 M1 首次发布前一项。
- **现状**：`hh version --help` 显示 `serve` 的用法。**方向**：`version` 打印自己的用法，并在 smoke 测试中覆盖。**依据**：阅读代码与运行 `hh version --help` 的观察（`version` 交给守护进程的 `main.ts`）。
- **现状**：client Key 不能轮换，只能新建再吊销。**方向**：实现 `hh key rotate`，签发同作用域、白名单与额度的新 Key 并在重叠期后吊销旧 Key。**依据**：[对照表](../../magpie-parity.md#lan-sharing-and-gateway-keys) Rename, disable, rotate and remove keys 一行（部分）、[07 第 4.4 节](../../proposals/oss/07-data-security.md#44-轮换)。
- **现状**：数据目录依赖当前目录，CLI 与守护进程在不同目录运行时互相找不到。**方向**：默认使用平台数据根或 `HH_HOME`，与 07 第 1 节一致。**依据**：[07 第 1 节](../../proposals/oss/07-data-security.md#1-数据目录与文件布局)、[config-file.ts](../../../packages/daemon/src/config-file.ts) 中 `./data` 的默认值。
