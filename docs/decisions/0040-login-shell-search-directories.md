# ADR-040：从登录 shell 补充搜索目录

状态：accepted，2026-10-12。依据用户授权的审批代理（Fable 5.1）为 G(ii) 定下的条件。G(i) 已取消，见文末。对应[第一链路调研](../research/first-chain-products-2026-10-11.md)的 AionUi“补全 PATH”。

## 背景

- HarnessHub 用自己进程的 PATH 和一组常见安装目录发现本机 Harness。这些目录包括 `~/.local/bin`、npm 全局前缀、bun、cargo、deno、volta、asdf、mise、pnpm、Homebrew、nvm 和 fnm。
- 从图形界面或精简环境启动时，进程的 PATH 可能缺少用户在登录配置（例如 `~/.zprofile`）中加入的目录，那里的程序就发现不了。
- AionUi 在启动时自动合并登录 shell 的 PATH（最多等 3 秒）。读取登录 shell 会执行用户的登录配置，所以 HarnessHub 只在用户要求时读取。

## 决定

1. **由用户触发。** Harnesses 页的“从登录 shell 补充搜索目录”面板提供“读取并重新检测”，并写明“会执行你的 shell 登录配置（`<shell> -l`）来读取 PATH”。启动时不自动读取，也不定时重读。
2. **哪个 shell。** `$SHELL` 必须是绝对路径、文件存在，并且列在 `/etc/shells` 中，否则返回 `LOGIN_SHELL_UNAVAILABLE`（409）。设置了 `CI`、在 Windows 上或 `web` 命令带 `--no-login-shell` 时不提供这个功能；测试不指定夹具 shell 时也不提供。是否提供由命令行入口集中决定（见文末补充）。
3. **怎样读取。** 用 `$SHELL -l -c` 的非交互登录形式运行一次，并遵守以下限制：
   - 只传入 HOME、USER、LOGNAME、LANG 和 TMPDIR；
   - 脚本在首尾标记之间打印 PATH，只解析标记之间的这一行，不读取其他变量，登录配置自己打印的内容一律忽略；
   - 期限 3 秒，输出上限 64 KiB；
   - shell 退出时结束整个进程组，包括登录配置留下的、可能占住输出的任务，并等待进程组结束；
   - 超时、超限、没有标记或退出码非零，都返回 `LOGIN_SHELL_FAILED`（502）。
4. **结果。** 只保留存在的绝对目录，去重，最多 64 个，并去掉这个 Gateway 已经搜索的目录（进程 PATH 和配置的搜索目录）。结果保存在数据目录的 `login-shell-path.json`（0600），只记 shell 的名称，不记它的路径。新增目录并入发现的搜索目录和之后新建对话的配置，已有对话的配置不变。面板以“来自登录 shell 的目录”逐项列出，用户可以逐项移除；移除后立即重新检测。不写入 Gateway 自己的环境变量。
5. **接口。**
   - `GET /api/v1/discovery/login-shell` 返回 `{available, shell?, dirs, readAt}`；
   - `POST /api/v1/discovery/login-shell` 运行一次读取并重新检测；
   - `POST /api/v1/discovery/login-shell/remove` 带 `{dir}`，移除一个目录。
   写操作需要登录、同源与 CSRF 令牌。

## 补充：关闭开关与拒绝原因（2026-10-12，审批代理条件）

审批代理审阅实施后提出两点：
- **显式关闭。** `web` 命令增加 `--no-login-shell`，供自动化启动的开发实例使用。它与 `CI`、Windows 一起在入口由 `loginShellSetting` 集中解析，带上后接口返回 `available: false`，页面不显示这个面板。
- **说明拒绝原因。** 面板写明“只运行列在 /etc/shells 中的 shell：用 Homebrew 等方式安装、没有加入这个文件的 shell 会被拒绝”。读取被拒绝或失败时，页面显示中文原因，并说明搜索目录没有变化：
  - `LOGIN_SHELL_UNAVAILABLE`：shell 必须是列在 `/etc/shells` 中的绝对路径；
  - `LOGIN_SHELL_FAILED`：超过 3 秒、输出超过 64 KiB、以错误退出或没有打印 PATH。

HarnessHub 不修改 `/etc/shells`，也不提示用户修改。

## G(i)：DSH Desktop 的命令位置（取消）

审批代理的条件是：只有官方文档或应用本体写明 DSH Desktop 把 `dsh` 注册在哪里，才加入这个位置。网络检索只找到几个同名的社区桌面封装：有的调用全局安装的 `dsh`，有的把官方包装进 `~/.dsh/runtime`。没有官方的 DSH Desktop。官方安装方式是 `npm install -g @deepseek-ai/dsh@latest`，安装位置在 npm 全局前缀，发现流程已经覆盖。没有证据，因此不加。

## 不做

- 不在启动时自动读取登录 shell，也不读取交互配置（不用 `-i`）。
- 不把登录 shell 的其他环境变量带入原程序。
