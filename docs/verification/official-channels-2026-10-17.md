# 按官网渠道探测验收（2026-10-17）

依据 [ADR-044](../decisions/0044-macos-official-channels.md) 与[渠道调研](../research/official-install-channels-2026-10-17.md)。本记录只覆盖第 1 步（探测与显示）；代为安装、卸载与脚本渠道的升级是后续步骤，尚未实现。

## 起因

- 用户统一方向：“目前我们只专注开发 macos 版本的……寻找用户电脑中的 harness 不通过源码安装的方式，而是通过一般官网介绍的安装方式进行寻找，我们的平台可以探测到，帮他们维护版本，更新，卸载等。”
- 三个问题用户都选了推荐项：只认官网安装；点击后按官网方式安装；卸载只删程序、保留数据。
- 审批代理（Fable 5.1）两轮裁决写在 ADR-044 里。第二轮把“发现清单的显式入口在正式模式下保留”改成了“正式模式一律不读发现清单”，并要求开发模式在界面上标明。

## 改动

- 后端：
  - 渠道判定 `channels.ts`、渠道登记 `catalog-channels.ts`、读文件的分类器 `installation-channels.ts`。
  - `DiscoverInventory` 按策略分出官网安装与 `unofficial`。
  - 组合根默认 `official`；新建对话与 Harness 列表读同一个策略。
  - `web`、`chat`、`discover`、`control` 命令接受 `--allow-unofficial`。
  - 正式模式不读发现清单，并写诊断 `manifest_ignored`。
- 页面：
  - Harness 视图新增 `installations` 与 `unofficial`，都不含路径。
  - `install` 增加核对日期和官网附注；9 个产品都有官网安装命令。
  - `WebState.installationPolicy`；开发模式在“我的 Agent”顶部提示。
  - 详情里新增“本机找到的官网安装”和“非官网安装”两节。
- 测试：
  - 新增 G012-OC1～OC4、G054-OC1。
  - 用测试假程序或发现清单的既有测试，显式改为开发策略：组合时传 `installations: "any"`，命令行加 `--allow-unofficial`。断言没有放宽。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元与集成 | `node --test dist/tests/*/*.test.js` | 659 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 31 通过，0 失败（新增 G054-OC1） |
| 设计检查 | `python3 tools/check_design.py`；`pytest tools/test_check_design.py` | 通过；47 通过 |

## 本机真实探测（只读，官方策略）

命令：在工具 shell 中运行 `node dist/src/cli/discover.js --json`，只汇总各 Harness 的候选。工具 shell 的 PATH 与用户登录 shell 一致，nvm v26.11.1 的 bin 排在最前。

| Harness | 结果 |
|---|---|
| Claude Code | 已安装。三份 npm 安装：nvm v26.11.1 下 2.1.302（PATH 第一，当前使用）、Homebrew 前缀下 2.1.296、nvm v23.10.0 下 1.0.31（版本管理器目录）。适配器 claude-agent-acp 0.89.1 单独一行。 |
| Codex | 已安装，Homebrew Cask 0.162.1 |
| Cursor CLI | 已安装，官方脚本 2026.10.01-e373342 |
| Gemini CLI | 已安装，Homebrew formula keg 0.38.2；程序自报 0.62.0，两个都显示 |
| OpenCode | 已安装，Homebrew formula 1.18.35 |
| OpenClaw | 已安装，npm（Homebrew 前缀）2026.3.23-2 |
| Hermes Agent | 已安装，官方脚本（启动器 `~/.local/bin/hermes`，`~/.hermes/hermes-agent` 里的程序存在）；渠道不记录版本，版本仍由包元数据读出 |
| Pi | 未安装：PATH 上的 `pi` 指向开发目录，列为非官网安装 |
| DeepSeek Harness | 未安装：源码构建原本经发现清单接入，正式模式不再读清单 |

关于“当前使用”的核查（审批代理要求）：用户登录 shell 中 `command -v claude` 是 nvm v26.11.1 下的那份（本窗口早些时候 nvm 默认切到了 26.11.1），与探测结果一致。候选顺序中 PATH 条目排在版本管理器目录之前（nvm v23.10.0 那份来源是 manager-directory，排在最后）。

## 未验证与局限

- 代为安装、卸载、脚本渠道升级尚未实现，没有真实执行证据。
- pnpm、bun 的判定只有单元测试；这台电脑上 `~/Library/pnpm` 只有 store，`~/.bun/install/global` 没有 Harness 包。
- `uv` 渠道没有产品登记（官网都不以 uv 为主要方式）；只有 Hermes 适配器的 Python 包会走 uv 判定，本机没有这样的安装。
- Pi、DeepSeek Harness 在能力矩阵中的真实验收证据来自非官网安装，已注明不再作为验收对象。

## 4317 部署（2026-10-17）

- 部署前 4317 没有运行（电脑 10 月 13 日重启后未再启动）。数据目录先做了 APFS 克隆备份；这次没有存储格式变化，核对后删除了备份。
- 主检出快进到 `4f3ab23`，在登录 shell 环境（Node.js 26.11.1）里构建。启动命令不再带 `--manifest`，`.tmp/discovery-manifest.json` 保留但不再使用。
- 启动后监听 4317（PID 42232），日志里没有 `manifest_ignored` 提示，因为没有给清单。一次性登录链接经本机重定向打开，没有贴出。
- 同一登录环境下 `discover` 的结果与上表一致：Pi 显示“只发现非官网安装，平台不使用”，DeepSeek Harness 显示“仅发现配置线索”。其余 7 个产品的控制入口都已解析。
- Claude Code 的“当前使用”是 nvm v26.11.1 下的 2.1.302，与登录 shell 中 `command -v claude` 的结果相同。
- 页面上的显示（多份安装、非官网说明、DeepSeek Harness 历史对话的状态）请用户在 4317 上确认；本记录没有替用户登录查看。

## 服务进程的 PATH 从哪里来（2026-10-17 补记）

- 4317 用 `env -i HOME USER LOGNAME SHELL TERM LANG /bin/zsh -lic '…'` 启动，是登录加交互的 zsh。它会依次加载 `~/.zprofile` 和 `~/.zshrc`；`~/.zshrc` 里的 nvm 初始化把 nvm v26.11.1 的 bin 放到 PATH 最前面。所以服务里“当前使用”的 Claude Code 是 nvm v26.11.1 下的 2.1.302，与用户交互终端里 `command -v claude` 的结果一致。
- 如果用非交互的登录 shell（`zsh -lc`）来看，只会加载 `~/.zprofile`，不会初始化 nvm，PATH 上排在前面的是 Homebrew 那份。这就是审批代理看到 Homebrew 优先的原因。
- 页面上“当前使用”的悬停说明写着“按 HarnessHub 服务进程的 PATH 顺序；终端里可能不同”，指的就是这种差别。
