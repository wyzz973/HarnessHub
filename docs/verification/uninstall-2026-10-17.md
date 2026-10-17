# 按渠道卸载验收（2026-10-17）

依据 [ADR-044](../decisions/0044-macos-official-channels.md) 第 2 步（卸载）与审批代理的第三轮裁决。按官网方式代为安装、脚本渠道的升级是后续步骤，尚未实现。

## 起因

- 用户统一的方向是：平台探测到官网安装后，帮用户维护版本、升级、卸载；卸载只删程序，数据保留。
- 第 1 步已经能列出每份官网安装；这一步让每份可维护的安装可以单独卸载。
- 终端里按名字启动的原生程序（例如 `claude`），命令行里没有路径。所以除了命令行匹配，还用 `lsof -Fp -- <程序文件>` 查找打开了这份安装程序文件的进程，确认框的“仍在运行”因此更完整。这一点也改进了 ADR-043 升级确认里的同一项。

## 改动

- 后端：
  - `uninstall.ts`：按渠道卸载（npm、Homebrew、uv、官方脚本的白名单）、停止并注销产品服务、核实删除。
  - 管理服务新增卸载检查、提交与执行，结果未知时可以核实，冻结的卸载目标存进管理库 v4。
  - 新接口 `GET /api/v1/harnesses/{id}/installations/{ref}/uninstall`；`POST /api/v1/installation-jobs` 接受 `action: "uninstall"`。
  - 返回卸载检查前做隐私检查，出现家目录的绝对路径就拒绝。
- 产品数据：各产品的服务（OpenClaw gateway 与 node、Hermes gateway）、常驻程序的命令行特征、保留的数据目录，以及官方脚本的删除白名单。来源见[渠道调研](../research/official-install-channels-2026-10-17.md)。
- 页面：“本机找到的官网安装”每行一个“卸载”；卸载确认框；任务显示“等待卸载”“卸载完成”“没有卸载”。

## 检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查与构建 | `pnpm build`、`pnpm web:build` | 通过 |
| 单元与集成 | `node --test dist/tests/*/*.test.js` | 666 通过，0 失败 |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 32 通过，0 失败（在最后一处只涉及后端的改动之前运行：按打开的程序文件查找进程，浏览器测试的私有夹具不走这条路径） |
| 设计检查 | `python3 tools/check_design.py` | 通过；新增场景 G011-UN1～UN7、G054-UN1 |

新增测试都不碰本机的真实安装：
- 脚本渠道在临时家目录里删除，npm 渠道用临时前缀和本地打包的测试包，经正式 Gateway 入口和真实的 npm 卸载。
- 服务停止的先后顺序和同意规则用替身端口验证，不停止本机任何服务。

## 未验证与局限

- 还没有在用户的真实安装上卸载过。按审批代理的安排，第一次由用户点击卸载 nvm v23.10.0 下的 Claude Code 1.0.31。之后核对三件事：
  - “当前使用”的那份不变；
  - `~/.nvm/versions/node/v23.10.0/lib/node_modules/@anthropic-ai` 已空；
  - `~/.claude` 与 `~/.claude.json` 没有变化。
- Homebrew 渠道的真实卸载还没有执行。按裁决放在第 3 步，用 `hello` 先装再卸，前后比对 `brew list --versions`。
- OpenClaw、Hermes 的服务停止与注销只在替身上验证过。它们的真实执行只能由用户点击，因为会断开微信、飞书、QQ 等消息渠道。
- uv 渠道只有代码路径，没有真实验证；本机没有 uv 安装的官方产品。

## 4317 部署（2026-10-17）

- 部署前 4317（PID 42232）没有子进程，即没有在途回复或保留进程。正常停止后，数据目录做了 APFS 克隆备份。
- 主检出快进到 `3c498fd`，在登录 shell 环境里构建并启动（PID 34678，不带 `--manifest`）。管理库启动时迁移到 v4，用 `PRAGMA user_version` 只读核对。服务启动正常后删除了备份。
- 用只读脚本在同一登录环境里预演了第一个待点击的卸载（不经过 4317，不写数据目录）：
  - nvm v23.10.0 下的 Claude Code 1.0.31 不是“当前使用”（当前使用的是 nvm v26.11.1 下的 2.1.302）。
  - 会运行 `~/.nvm/versions/node/v23.10.0/bin/npm uninstall --global --prefix ~/.nvm/versions/node/v23.10.0 @anthropic-ai/claude-code`。
  - 删除 `~/.nvm/versions/node/v23.10.0/lib/node_modules/@anthropic-ai/claude-code` 和 `~/.nvm/versions/node/v23.10.0/bin/claude`。
  - 没有服务、常驻程序或其他进程在使用它。
- 一次性登录链接经本机重定向打开，没有贴出。

## 部署后修正（2026-10-17）

- 部署后发现：卸载完成后会比对受保护配置的摘要，有变化就判失败。但这台电脑上正在运行的 Claude Code 会话会不断改写 `~/.claude.json`，正常的卸载可能被误判为“结果未知”。ADR-043 的升级也有同样的问题。
- 修正：包管理器在沙箱里写不了这些文件，脚本删除也只删白名单里的文件，所以摘要变化只记入任务日志，不再判失败。G011-UN3 增加了“卸载期间别的程序改写配置”的样例。
- 升级路径的同一修正目前只有代码审查，没有单独的自动化测试；现有升级测试（native-management、management-service）32 项通过。
- 用户点击卸载之前，修正已重新部署到 4317。
