# Windows 安装、启动与能力范围

项目支持 Windows 原生 Node，使用同一 Gateway、SQLite、Worker、ACP/CLI Driver 和 Web 控制台。当前本机验收为 Windows 11 ARM64；Windows 10、Windows x64 和其他引擎的真实模型验收须分别取得证据。

以下安装步骤用于开发机。裁判机免安装运行使用 [Windows 便携发布包](portable-bundle.md)；引擎程序预先随包准备，模型 API 与原生账号要求仍按各引擎能力配置。

## 安装与启动

前置条件为 Git、Node 24.20.0、pnpm 10.12.3，以及 Windows 自带的 .NET Framework C# 编译器。`pnpm build` 编译 Job Object、文件 ACL/锁与 DPAPI helper，不需要 Visual Studio 或修改全局执行策略。缺少 helper 或系统 API 时明确失败。

在 PowerShell 的仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm start:local --demo
```

控制台为 http://127.0.0.1:3330，后端为 http://127.0.0.1:3180。启动器显式连接这两个服务，拒绝占用中的端口；Ctrl+C 停止其拥有的服务。Windows 启动器将 Gateway 和 Console 放入 Job，启动器异常退出时回收其进程后代。Windows 强制退出后，活动 Run 下次启动按 interrupted 恢复，不会自动重跑。

若当前仓库安装了 `.tools/node-v24.20.0-win-arm64/node.exe` 或对应 x64 运行时，启动脚本自动优先使用该本地 Node，不更改系统 PATH。Windows 自带 PowerShell 的默认策略可能禁止脚本，使用仅对本次进程生效的调用，不修改全局执行策略：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\start-windows.ps1 --demo
```

手动启动两个终端时，前端环境变量使用 PowerShell 语法：

```powershell
$env:HARNESSHUB_GATEWAY_URL = 'http://127.0.0.1:3180'
pnpm start:console
```

`--demo` 加入 fake 引擎并使用 `data/demo`，也允许登记和运行真实引擎。本次开发机的 Codex 登记与演示历史保存在该目录，继续查看时保留 `--demo`。省略该参数会改用独立的 `data/local`，不加入 fake，也不会自动迁移原目录的引擎或历史。运行目录和日志不提交 Git，不能同时启动两个 Gateway 写同一数据目录。

## Codex 接入

扫描支持 PATH/PATHEXT 和 Windows 安装位置，包括 Codex 桌面应用提供的 `codex.exe`。发现已有程序不等于注册或模型可用。在引擎管理页看到 Codex 后，安装固定版本 Adapter：

```powershell
New-Item -ItemType Directory -Force .tools/adapters | Out-Null
pnpm --dir .tools/adapters --ignore-workspace add --save-exact '@agentclientprotocol/codex-acp@1.10.0'
```

Adapter 位于独立本地目录，不在任务执行阶段下载。再次扫描、登记，再执行“检查连接”。默认启动配方引用原有 CODEX_HOME 和明确的 Codex executable，初始模式 read-only；沿用本机登录与模型配置，不改写用户配置文件。“测试模型”才实际调用模型。发现、连接及只读任务/取消的实测分别记录。

其他引擎参见 [发现与适配](engine-discovery.md)。`.cmd/.bat` 使用维护中的 cross-spawn 处理参数；批处理 argv 无法可靠承载 CR/LF，显式拒绝此输入，使用 stdin、原生程序或 `.ps1` 可传多行文本。非本项目发行的 Windows 引擎二进制与适配器仍需其自身支持 Windows。

## 能力与边界

| 能力 | Windows 实现 |
|---|---|
| 引擎发现和配置 | PATH/PATHEXT、常见用户目录、JSON manifest；原生/批处理/PowerShell 启动；配置环境传递 |
| 文本、权限、队列、期限、取消 | 同一正式 Gateway/Worker 契约，保留实际事件及终态 |
| 进程清理和崩溃恢复 | 原生 Job Object，执行前归属、后代终止、身份匹配恢复；旧无证据 lease 隔离 |
| 文件产物和评测 | 中文/空格路径、DACL、普通文件与 junction 检查、读取锁、不可变字节和 hash |
| 密钥保存 | 当前用户 DPAPI 密文存储；env/file 引用与 Windows 文件权限校验 |
| ACP/MCP/Skills | ACP 初始化、便携 Skills、stdio 命令适配；真实第三方 MCP 的特殊创建方式另验收 |
| SQLite、SSE、工作流、观测 | 共享业务实现，通过原生组合测试；模型费用仍按观测来源报告 |
| 系统沙箱 | 未实现文件、网络、桌面或提权隔离；Job 仅控制其归属的进程树 |

WMI、系统服务、计划任务或外部 broker 启动的进程不属于普通 Job 后代保证。当前用户下的 Engine 仍能访问该用户允许的资源；DPAPI 也不隔离同一用户的恶意进程。不要把只读引擎模式当作 HarnessHub 已提供通用 OS 沙箱。

## 验证

`pnpm check` 包含固定运行时、lint/格式/边界、工具/单元/集成/smoke、API 文档与前端构建。`pnpm test:windows` 运行编译后的 Windows 专用组，在非 Windows 主机明确失败，不能把跨平台跳过当作 Windows 验收。GitHub CI 配置了 Ubuntu 和 Windows matrix，远端执行结果须另行核实。

创建文件 symlink 需要 Windows 授权或开发者模式；本次标准用户无此权限，相关专用测试会明确跳过。目录 junction、硬链接和其他文件边界仍实际执行。没有修改系统策略来绕过此限制。

实现决定见 [进程监督](decisions/0007-windows-process-supervision.md)与[密钥存储](decisions/0008-windows-secret-storage.md)，进程证据见 [原生进程验收](verification/2026-09-06-windows-process.md)。[总体验收记录](verification/2026-09-06-windows.md)分别列出通过、失败修复与未验证项。
