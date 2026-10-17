# 逐份升级验收（2026-10-17）

依据 [ADR-044](../decisions/0044-macos-official-channels.md) 第 4 步（逐份升级），以及审批代理的第五、六轮裁决。

## 起因

用户要求平台帮用户维护每份官网安装的版本。ADR-043 的“升级 Harness”只升级控制入口用的那个程序。Claude Code 的控制入口是适配器 claude-agent-acp，所以 Claude Code 本体、Hermes、DeepSeek Harness，以及不是当前使用的那几份安装，原来都没有升级路径。

## 改动

- 后端：
  - `installation-upgrade.ts` 按渠道升级一份安装：npm 装入精确版本；Homebrew 先预演、核对前缀未变，再按本地记录升级；Claude Code、Cursor 的脚本安装运行产品自己的更新命令；Codex、OpenCode 的脚本安装重新运行官方脚本。
  - 管理服务新增升级检查、提交、执行和结果核实，“检查更新”也逐份查询。冻结的升级请求存进管理库 v6，降级脚本是 `tools/management-v6-to-v5.sql`。
  - 新接口 `GET /api/v1/harnesses/{id}/installations/{ref}/upgrade`；`POST /api/v1/installation-jobs` 接受带 `installation` 的升级。
- Homebrew 的统一做法：检查、预演、升级和卸载都用真实 HOME、用户的 `HOMEBREW_*` 设置和缓存，不自动 update、cleanup、autoremove。ADR-043 原来的 Homebrew 检查和升级实际按网上最新版进行，已一并改正，见 ADR-043 的更正说明。
- 进程识别：读取安装的使用者时，HarnessHub 自己运行这份安装的进程单独列出。有这样的进程时，正在回复的对话阻止升级，空闲保留进程先关闭。
- 页面：每份安装下面写上次检查的结果，并有“升级到 vX”“立即更新”或“更新方式”。确认框显示现版本与目标、实际运行的命令、可写位置、一并升级的包与共享运行时、仍在运行它的程序和阻止原因。Hermes 只显示终端命令和它会做的事。完成的任务写出“a → b”或“已是最新”。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元与集成 | `node --test dist/tests/*/*.test.js` | 685 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 34 通过，0 失败 |
| 真实 Homebrew 沙箱 | `node --test dist/tests/real/homebrew-native.real.js` | 2 通过 |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G011-UG1～UG10、G054-UG1 |

新增测试都不碰本机的真实安装：
- npm 升级经正式入口运行真实的 npm，装进临时前缀，连接本机的假 npm 仓库。
- 自更新和脚本重跑用临时家目录里的替身程序和测试内的假下载，但在真实的 macOS 沙箱里运行。被阻止的 `~/.zshrc` 写入有记录，文件也确实没有写入。
- Homebrew 的流程用替身 brew 测试，其中有预演偷改前缀被拦下的无效样例。真实的 Homebrew 只在 `homebrew-native.real.ts` 里用作沙箱：以测试自己的家目录为 HOME，证明 Homebrew 写的是这个家目录下的缓存，`~/.zshrc` 和 `~/.config` 仍不可写。
- 原来的真实 Homebrew 测试期限是 60 秒。Homebrew 7.0.9 每次启动约 18 秒，三次调用超时，期限改为 180 秒，断言不变。

## 实现前的只读核对（本机，Homebrew 7.0.9）

- `brew info --json=v2`、`brew list --versions`、`brew deps`、`brew outdated --json=v2` 都能在禁写、禁网的沙箱里读本地记录。本机是 API 模式，记录在 `~/Library/Caches/Homebrew/api/internal`，最后更新于 10 月 12 日。
- `brew upgrade --dry-run` 即使只预演也检查整个前缀可写，在禁写的沙箱里直接退出。放进 Homebrew 自己的继承沙箱后可以运行，例如：
  - `gemini-cli 0.38.2 -> 0.46.0`，并列出 Homebrew 把它标为弃用；
  - ffmpeg 一例列出新装的依赖、升级的依赖和升级的依赖者。
- 预演前后 Cellar 和 Caskroom 的目录快照相同。

## 未验证与局限

- 还没有在这台电脑上真实升级过。按裁决，第一个由用户点击的是 Homebrew 前缀下那份 Claude Code 2.1.296。完成后要核对三件事：
  - nvm v26 那份的版本和“当前使用”标记不变；
  - `~/.claude.json` 和 `~/.claude` 没有被任务写入（运行中的 Claude 自己写入的除外）；
  - Homebrew 前缀下的 `claude` 命令指向新版本。
- `claude update`、`agent update` 真实会写哪些位置，只用替身验证过。写到可写范围以外会被阻止并记入任务，更新程序可能因此失败。
- 真实的 `brew upgrade` 没有运行过。预演会把清单下载进 Homebrew 的缓存。
- uv 安装不提供升级，pnpm、bun 的安装不维护。
- “其他 HarnessHub 进程正在使用”这一阻止项，与卸载共用同一段使用记录的读取代码，这次没有为升级单独写测试。
