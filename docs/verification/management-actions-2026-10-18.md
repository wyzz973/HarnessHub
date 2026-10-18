# 管理操作验收：升级、卸载与安装（2026-10-18）

用户要求（2026-10-18）：“Claude Code 升级到 2.1.302、卸载 nvm v23 里的旧 Claude、安装 DeepSeek Harness。你帮我做”。三项都经 4317 自己的接口执行，流程与页面相同：检查 → 提交检查的指纹 → 跟踪任务。依据 [ADR-044](../decisions/0044-macos-official-channels.md)。

## 执行方式

- 4317 空闲（没有子进程、没有进行中的管理任务）时重启，脚本读取新的一次性口令登录，口令和会话都没有打印。会话只存在临时目录里一个 0600 的文件中，用完删除。
- 只打印任务状态、日志、检查字段和权限，不打印配置内容。
- 本会话运行的是 nvm v26.11.1 那份 Claude Code，三项操作都不碰它。

## 卸载：npm 全局（nvm v23.10.0）的 Claude Code 1.0.31

- **检查**：
  - 运行命令：`~/.nvm/versions/node/v23.10.0/bin/npm uninstall --global --prefix ~/.nvm/versions/node/v23.10.0 @anthropic-ai/claude-code`
  - 删除：包目录和 `bin/claude`
  - 保留：`~/.claude`、`~/.claude.json`
  - 没有服务，也没有进程在用它；HarnessHub 当前使用的那份不变。
- **结果**：2 秒完成，npm 输出 “removed 3 packages in 182ms”，HarnessHub 核实程序已删除、配置与登录数据保留。在磁盘上核对，两个路径都已不存在，`~/.claude` 和 `~/.claude.json` 仍在。

## 升级：npm 全局（Homebrew 的 Node.js）的 Claude Code 2.1.296 → 2.1.302

- **检查**：
  - 运行命令：`/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.302`，只可写 `/opt/homebrew`。
  - Node.js 要求 >=22.0.0，前缀里是 26.11.1，满足。
  - 终端里一个跑了近两天的 claude 会话（进程 58943）在用这份：不关闭它，它重开后才用新版本。
  - 不是 HarnessHub 当前使用的那份，升级后“当前使用”不变。
- **结果**：
  - 4 分钟完成，npm 输出 “changed 2 packages”，HarnessHub 核实版本为 2.1.302。
  - `/opt/homebrew/bin/claude --version` 输出 `2.1.302 (Claude Code)`。`bin/claude.exe` 与平台包里的原生程序逐字节相同，说明安装后脚本执行了。
  - 日志提示这个版本还不是 HarnessHub 用真实程序验证过的版本（验证过的是 2.1.296）。
- **npm 的提示**：npm 11.20.0 警告 `@anthropic-ai/claude-code` 的 postinstall “not yet covered by allowScripts”。这一次脚本照常执行了。

## 发现的问题：装出来的权限

- **现象**：升级后的包里 9 个普通文件是 0600、5 个目录是 0700。用户在终端装的同一版本（nvm v26.11.1）是 0644/0755，用户登录 shell 的 umask 是 022。
- **原因**：4317 以 umask 077 启动，npm 继承了它。
- **历史任务核对**：
  - 10-11、10-12 两次 Cursor 自更新留下的版本目录是 0755，没有受影响。
  - 其余经 4317 的 npm 升级都失败了，没有落盘。
- **修正**：管理用的子进程改为经 `/bin/sh -c 'umask 022 && exec "$@"'` 启动，见 ADR-044“修正：安装程序的 umask”。
  - 新测试 G029-M03：Gateway 在 umask 077 下，子进程看到 022，新建文件 0644、目录 0755；找不到或不可执行的程序仍报 PROCESS_START_FAILED。
  - 原有的取消测试在新路径上照常结束整个进程组。
- **一次性修补**（审批代理同意，以证据为准）：
  1. 先比对两份 2.1.302：Homebrew 前缀那份与 nvm v26.11.1 那份都是 15 项，清单相同，每个文件的 SHA-256 相同，只有权限不同。
  2. 再把 Homebrew 前缀那份的每一项权限设成 nvm 那份的值，没有重新下载。两个可执行文件已是 0755，没有改动。
  3. 改后核对，没有不一致的项；`claude --version` 仍输出 2.1.302。

  | 路径（相对 `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code`） | 修补前 | 修补后 |
  |---|---|---|
  | `.`、`bin`、`node_modules`、`node_modules/@anthropic-ai`、`node_modules/@anthropic-ai/claude-code-darwin-arm64` | 0700 | 0755 |
  | `LICENSE.md`、`README.md`、`cli-wrapper.cjs`、`install.cjs`、`package.json`、`sdk-tools.d.ts` | 0600 | 0644 |
  | `node_modules/@anthropic-ai/claude-code-darwin-arm64/` 下的 `LICENSE.md`、`README.md`、`package.json` | 0600 | 0644 |

  要恢复修补前的权限，对这 14 项按上表执行 chmod 即可，内容没有变化。

## 安装：DeepSeek Harness

- **修正前的检查**（未执行）：
  - 运行命令：`~/.nvm/versions/node/v26.11.1/bin/npm install --global --prefix ~/.nvm/versions/node/v26.11.1 @deepseek-ai/dsh@0.2.0-rc.2`
  - 版本取 npm 的 latest 标签，HarnessHub 验证过的是 0.2.1-alpha.1。
  - 装入 Gateway PATH 上第一个 Node.js（nvm v26.11.1）的前缀。
  - 提示：它会读取 `~/.dsh` 下已有的配置和 acp profile（包括源码版留下的），兼容性未验证。
- 按审批，修正部署到 4317（`46163d2`）之后重新检查、重新确认再安装；装完先由 HarnessHub 的探测确认 `dsh --profile acp` 能完成初始化。
  - 部署前后，三个存储的版本与计数相同：业务库 v12（会话 5、事件 1493），管理库 v6（任务 14、日志 31），能力库 v1（修改 5、备份 5、台账 1）。服务环境里没有代理变量。部署前的数据克隆核对后已删除。
- **安装结果**：
  - 重新检查的内容与修正前相同，确认框里有三点：装入 nvm v26.11.1 前缀；0.2.0-rc.2 是预发布版，HarnessHub 尚未验证；会读取 `~/.dsh` 下已有的配置。
  - 4 分钟完成，npm 输出 “added 538 packages”。HarnessHub 核实 `dsh` 0.2.0-rc.2 装在官网渠道里；重新扫描后 DeepSeek Harness 显示为已安装、当前使用。
  - npm 同样提示 5 个包的安装脚本“not yet covered by allowScripts”（`@deepseek-ai/dsh-subprocess-local`、koffi、node-pty、`@google/genai`、protobufjs）。node-pty 自带 darwin-arm64 的预编译程序，`spawn-helper` 是 0755。
- **权限**（修正后）：包里 26657 个文件没有 0600 的，目录全是 0755，`package.json` 是 0644。
- **目录探测**：经 4317 的 `GET /api/v1/harnesses/dsh/models?refresh=1` 启动 `dsh --profile acp`，3.7 秒内完成初始化并返回 3 个模型，默认模型 `deepseek-official / deepseek-v4-flash`，可以选择。它用的是 `~/.dsh` 下原有的配置；凭据文件没有读取或打印。

## 未验证与后续

- 进程 58943 仍在运行 2.1.296，重开后才是新版本。
- 升级后的核实读的是包的 package.json。如果以后的 npm 默认拦截未列入 allowScripts 的 postinstall，`claude.exe` 会停在占位程序，而版本核实发现不了。到那时要在核实里加上运行检查。
