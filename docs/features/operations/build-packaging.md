# 构建身份与打包

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 部分实现（构建身份已实现；单可执行文件是原型，没有发布） |
| 验证 | 工具组测试覆盖构建身份、清理构建、Node 版本检查与单可执行文件构建检查的拒绝样例；`pnpm test:sea`（不属于 `pnpm check`）在 macOS arm64 本机构建可执行文件并经它运行 `hh` 的命令序列；2026-10-02 的原型（只有 `serve` 与 `version`）在 CI 的五个平台构建并通过端到端检查；包含全部 `hh` 命令的版本只在 macOS arm64 上构建过；Windows 未验证 |
| 对照 Magpie | 部分：One small native binary、Docker image 与 healthcheck、macOS/Windows/Linux 三行部分；Downloads、Self-update、Updating the agents' CLIs、Start at login 四行未覆盖；Telemetry 一行有意不同（不发送遥测）（[Packaging and operations](../../magpie-parity.md#packaging-and-operations)） |
| 权威文档 | [SEA 可行性验证](../../proposals/oss/sea-spike.md#1-结论)、[10 第 5 节 发布工程](../../proposals/oss/10-engineering.md#5-发布工程)、[从新克隆启动](../../getting-started.md#运行模式与端口) |

## 用途

回答“正在运行的是哪个提交、在哪台机器上构建的”，并为把 HarnessHub 分发成一个不需要另装 Node 的可执行文件做准备。目前用户从源码构建运行；单可执行文件验证了可行性，尚未作为产物发布。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 通用显示版本与提交号前 12 位 |
| 命令行 | `pnpm build`、`pnpm build:console`；`hh version [--json]`、`hh --version`、`hh serve --version [--json]`；`pnpm test:sea`，或 `node tools/sea/build.mjs` 加 `tools/sea/commands.mjs`、`measure.mjs` |
| HTTP | `GET /v1/runtime/info` 的 `build`；`GET /api/v1/system/info` 的版本与提交 |

## 已实现的能力

- `pnpm build` 依次清理旧产物、`tsc -b`、写出构建身份，并只为当前平台构建原生辅助程序（macOS 钥匙串；Windows 的 Job 监督、ACL 与 DPAPI）。
- 构建身份 `packages/daemon/dist/build-info.json`：`version`、`channel`（源码构建为 `dev`）、`commit`、`commitDate`、`ref`、`dirty`、`builtAt`、`workflowRun`、`os`、`arch`、`nodeVersion`、`installMethod`（`source`）；CI 取 `GITHUB_SHA` 与 `GITHUB_REF`，本地只在源码目录本身是检出顶层时询问 git，取不到的值写 `unknown`；`builtAt` 遵循 `SOURCE_DATE_EPOCH`。
- 同一身份出现在 `hh version --json`、`GET /v1/runtime/info` 与 `gateway.log` 的 `gateway.start` 记录中；文件缺失或损坏时守护进程拒绝启动。
- `pnpm build:console` 以白名单环境运行 Vite，构建后在产物中搜索随机金丝雀与凭据形态环境变量的值，命中即失败。
- 单可执行文件原型：esbuild 把入口、`hh` 的命令表、Worker、command MCP 与引擎启动器打成一个 CommonJS 脚本，改写各模块的 `import.meta.url`，磁盘资源与控制台产物作为 SEA 资源嵌入；postject 注入 Node 24.20.0 的副本，macOS 做 ad-hoc 签名；运行时按 argv 选择角色，首次运行解包到解包根目录。
- 构建的最后一步对 `hh` 的每个命令运行 `<可执行文件> <命令> --help`，任何一个失败则构建失败；未归类的资源脚本、残留的 `import.meta`、缺少控制台构建也使构建失败。
- `tools/sea/commands.mjs` 在一个临时目录中经可执行文件运行 `version`、`config`、`serve`、模型平面与接线命令、两次网关调用、`tui`（无终端）、`console`、控制台页面、`provider test|doctor`、经本地代理的调用与 WAL 检查点，只连回环上的假 provider。
- 2026-10-05 的 macOS arm64 构建为 132,866,288 字节（126.7 MiB），冷启动 p95 约 325 ms（首次运行）与 316 ms（已解包），低于 ADR-P01 的 150 MB 与 1.5 s 条件。
- Node 版本固定为 24.20.0，`pnpm check` 第二步 `check:runtime` 拒绝其他版本；CI 在 Ubuntu、macOS 与 Windows 上运行 `pnpm check`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [tools/build-info.mjs](../../../tools/build-info.mjs)、[tools/clean-build.mjs](../../../tools/clean-build.mjs)、[tools/console.mjs](../../../tools/console.mjs)、[tools/sea/build.mjs](../../../tools/sea/build.mjs)、[tools/sea/entry.mjs](../../../tools/sea/entry.mjs)、[tools/sea/commands.mjs](../../../tools/sea/commands.mjs)、[tools/sea/measure.mjs](../../../tools/sea/measure.mjs)、[sea-spike.yml](../../../.github/workflows/sea-spike.yml) |
| 测试 | [tools/check-build-info.test.mjs](../../../tools/check-build-info.test.mjs)、[tools/check-clean-build.test.mjs](../../../tools/check-clean-build.test.mjs)、[tools/check-runtime.test.mjs](../../../tools/check-runtime.test.mjs)、[tools/check-sea-build.test.mjs](../../../tools/check-sea-build.test.mjs) |
| 决策 | [SEA 可行性验证](../../proposals/oss/sea-spike.md)（对应 ADR-P01 与 OSS-008）、[10 第 5 节](../../proposals/oss/10-engineering.md#5-发布工程) |

## 已知限制与未验证

- 没有任何发布：没有下载包、npm 包、安装脚本、签名与公证、Docker 镜像、`hh self-update`、开机启动，也没有更新 Agent 自身 CLI 的功能。
- 包含全部 `hh` 命令的可执行文件只在 macOS arm64 上构建与运行过；其他平台、`sea-spike.yml` 的再次运行、真实 Intel Mac、开启 Defender 实时保护的 Windows、签名后的产物、内存占用与重启后的冷页缓存都未验证。
- 经可执行文件运行真实引擎的完整 Run、安装位置的 `hh` 链接与 `node` 垫片、`hh init` 等交互命令（只验证了 `--help`）未验证。
- 构建靠改写 `import.meta.url` 定位自有子进程入口与资源；持久化的引擎命令仍是可执行文件路径，升级或移动可执行文件可能破坏已有登记。
- 控制台只显示版本与提交号，不显示 `dirty`、`builtAt` 等其余字段；计划中带构建身份的诊断包未实现。

## 优化候选

- **现状**：没有可安装的产物。**方向**：按 10 第 4.3、5 节建立发布流水线，先出 macOS arm64 与 Linux x64 的单可执行文件和 npm 包，附 SHA256SUMS 与签名。**依据**：[10 第 5 节](../../proposals/oss/10-engineering.md#5-发布工程)、[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项) 的 M1 发布前一项（npm 包名、代码签名）。
- **现状**：完整版可执行文件只在一个平台构建过。**方向**：在其他平台运行 `pnpm test:sea`（或手动触发 `sea-spike.yml`）并记录体积与冷启动。**依据**：[TODO](../../../TODO.md) 第三轮审查后的“未验证”一项、[SEA 第 10 节](../../proposals/oss/sea-spike.md#10-hh-的全部命令2026-10-04)“未验证”。
- **现状**：入口与资源位置靠构建时改写，引擎命令持久化为路径。**方向**：一个模块统一解析自有子进程入口与磁盘资源，引擎命令改为符号化的启动器引用。**依据**：[SEA 第 7 节](../../proposals/oss/sea-spike.md#7-对照-adr-p01-的建议) 第 1、2 项。
- **现状**：没有容器镜像，也没有供 `HEALTHCHECK` 使用的命令。**方向**：提供镜像与基于 `/health/ready` 的健康检查命令。**依据**：[对照表](../../magpie-parity.md#packaging-and-operations) Docker image 一行（部分）。
