# VMware Windows 后续验收

本页保留最初从 macOS 迁移到 Windows Guest 的准备流程。2026-09-06 已直接取得 Windows 11 ARM64 原生和 Codex 执行证据，当前入口见 [Windows 指南](windows.md)；本清单仍可用于其他 Windows 版本/架构的独立验收。不要把 Mac 的 `.tools/node`、`node_modules`、Pi 二进制或已有运行数据库当成 Windows 安装产物直接运行。

## 准备

将项目源码、`pnpm-lock.yaml`、任务集和文档复制到 Windows Guest；安装 Node 24.20.0 与 pnpm 10.12.3，并在 Guest 内准备 Windows 版本的引擎及 Adapter。凭证在 Guest 自己的受控配置中设置，避免把 Mac Keychain 或含登录状态的整个 HOME 复制过去。

在 PowerShell 项目根目录执行：

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm benchmark --demo --dataset examples/benchmark-demo.json --engines fake --data-dir data/windows-demo
```

初始目标是编译入口、SQLite、Worker IPC、文本与登记产物。现有 Windows Host 清理仍会保守返回 `unconfirmed`；评分通过不能替代后代进程退出证据。涉及 POSIX 进程组的用例不能据此勾为 Windows 通过。

## 真引擎任务

参照 [运行 API](runtime-api.md)和 [引擎管理](engine-management.md)准备 Windows Profile；配置中全部 executable、launcher、workspace 和认证路径都需要是 Guest 内的路径。Mac 专用 `/usr/bin/env` 包装不能原样复用；本机新 launcher 的 Windows 兼容也属于待验证项。

```powershell
pnpm benchmark --config engines/windows-local.yaml --dataset examples/benchmark-files.json --engines YOUR_ENGINE_ID --permissions allow-once --data-dir data/windows-files
pnpm benchmark --report --config engines/windows-local.yaml --data-dir data/windows-files
```

`engines/windows-local.yaml` 和 `YOUR_ENGINE_ID` 需要按 Guest 实际安装创建，当前仓库没有替用户虚构这份本机配置。任务会读取两份版本化输入、计算订单汇总并生成两个文件；JSON 结构和保存证据可离线复查，摘要内容也应核对为 `paid_orders=4 units=10 revenue_cents=5750` 后跟 LF。

## 必须补齐的原生证据

| 项目 | 验收结果要求 |
|---|---|
| 中文/空格路径、大小写与盘符 | 输入、输出和 SQLite 路径均正常 |
| junction/symlink/硬链接与 Windows ACL | 越界文件拒绝；当前私有目录检查适配 Windows 的实际语义 |
| 创建中、执行中取消和总 deadline | 唯一 Run 终态，后代进程确实退出 |
| Worker→Agent→工具/MCP 进程树 | 仅终止本任务进程，确认无残留；需要实现/验证 Job Object 等原生方案 |
| 产物与文件句柄 | 写完后可读取/重开，关闭后不遗留文件占用 |
| Gateway 重启和 ACP 恢复 | 历史 Run 可查；开启恢复的引擎保持同一后端 ID，失败不新建空上下文 |
| 离线运行与发行目录 | 任务期间不安装/升级依赖，从 Windows 发行目录启动并通过同一任务集 |

按 [测试要求](testing.md)保存 Guest OS/架构、Node/引擎/Adapter 版本、Run/Artifact/评分和清理证据，再更新 HH-014、HH-018、HH-023。Ubuntu CI 和 Mac 结果不能替代这一步。
