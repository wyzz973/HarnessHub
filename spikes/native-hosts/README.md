# 原生宿主实测（spikes/native-hosts）

> **只用于测量，不是实现。** 本目录的脚本只为“Harness 宿主与会话管理”设计（ADR-056）提供实测依据，不进入构建、测试或发布：`tsconfig.json` 的 `include` 只有 `src/**/*.ts` 与 `tests/**/*.ts`，`src/` 不得引用本目录。测量期间没有调用任何模型，没有发任何提示或斜杠命令。

标注：【实测】本目录脚本在本机跑出；【文档】原程序文档或本仓库代码；【推断】由实测推出的判断；【建议】给设计的提议。

## 1. 目的

逐家测量本机已装的 Harness 作为“宿主进程”的行为，回答五个问题：

1. 启动开销：进程启动到 initialize 完成、再到第一个会话建好的耗时；
2. 常驻内存：整个进程树（含子进程）的 RSS，initialize 后、一个会话、两个会话三档，以及子进程的程序名；
3. 一个进程能否带多个会话：另一个 cwd 的第二个会话能否共存、cwd 是否生效、能否在同一进程里切回第一个会话；
4. 空闲时是否写工作区；
5. 关闭的耗时与关闭后有没有残留进程。

对象：Claude Code、Codex、OpenCode、DeepSeek Harness（dsh）、Hermes、OpenClaw、Pi。Pi 在官网安装策略下起不来（第 7 节），实测六家。

## 2. 运行方法

前提照 [真实验收操作手册](../../docs/engineering/real-acceptance.md) 第 1、2 节：`pnpm build`；`env -i` 加交互式登录 shell 的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`；不设 `HH_REAL_MANIFEST`（安装策略 `official`）。启动真实 Harness 的命令要在 Claude Code 的沙箱外运行。

```sh
pnpm build
# LOGIN_PATH 与 RUN 的定义按手册第 1 节写进 0600 的 env.sh（本次放在 $HOME/.cache/harnesshub-acceptance/hosts-2026-11-03/）
. "$HOME/.cache/harnesshub-acceptance/hosts-2026-11-03/env.sh"
EVIDENCE="$HOME/.cache/harnesshub-acceptance/evidence/2026-11-03"
RUN node dist/tests/real/guard.js snapshot claude,codex,opencode,openclaw,hermes,dsh,pi "$EVIDENCE/hosts-guard-before.json"
RUN node spikes/native-hosts/measure.mjs --harnesses=codex                    # 每家一次调用，第一次新建 results.json
for h in opencode dsh claude pi openclaw hermes; do RUN node spikes/native-hosts/measure.mjs --harnesses=$h --merge; done
# 变体（第 6 节）：只 initialize，4 次共用一个持久 TMPDIR
for h in openclaw opencode dsh; do RUN node spikes/native-hosts/measure.mjs --harnesses=$h --merge --init-runs=4 --session-runs=0 \
  --tmpdir="$HOME/.cache/harnesshub-acceptance/hosts-2026-11-03/variant-tmp-$h"; done
RUN node dist/tests/real/guard.js snapshot claude,codex,opencode,openclaw,hermes,dsh,pi "$EVIDENCE/hosts-guard-after.json"
RUN node dist/tests/real/guard.js compare "$EVIDENCE/hosts-guard-before.json" "$EVIDENCE/hosts-guard-after.json"
```

其他选项：`--init-runs`、`--session-runs`（默认各 3）、`--settle-ms`（默认 5000）、`--idle-ms`（默认 60000）、`--idle-sample-ms`（默认 15000）、`--root`（默认 `$HH_REAL_TMP/hosts-<日期>`，必须在家目录下）、`--out`（默认本目录 `results.json`）、`--keep`（保留工作区）。每家结束后脚本自己拍一次该家的守护清单比较，有改动立即停止。

## 3. 环境与版本

| 项 | 值 |
|---|---|
| 代码 | 分支 `cc/relay-design`，`e02fa52`；`dist` 在开始时从干净的工作树构建。证据头写 `uncommittedChanges: true`：测量期间其他成员在同一工作区改了 `TASKS.md`、`docs/` 与 `plan/` 的文件，`src/`、`tests/` 没有改动 |
| 机器 | Apple M5 Pro，64 GiB；macOS 27.0.1（26A434），arm64 |
| Node | v26.13.0（登录 shell PATH 上的第一个） |
| 安装策略 | `official`；平台 macOS |

`which -a`（登录 shell 的 PATH）：

| 程序 | 路径 |
|---|---|
| claude | `~/.nvm/versions/node/v26.13.0/bin/claude`、`/opt/homebrew/bin/claude` |
| claude-agent-acp | `/opt/homebrew/bin/claude-agent-acp` |
| codex | `/opt/homebrew/bin/codex` |
| opencode | `/opt/homebrew/bin/opencode` |
| dsh | `~/.nvm/versions/node/v26.13.0/bin/dsh` |
| hermes | `~/.local/bin/hermes` |
| openclaw | `/opt/homebrew/bin/openclaw` |
| pi | `/opt/homebrew/bin/pi` |

版本以证据头为准（`results.json` 的 `header`，由 `tests/real/guard.ts` 的 `evidenceHeader()` 读出，不运行 `--version`）：

| Harness | 运行的入口 | 证据头的版本 | initialize 自报 |
|---|---|---|---|
| Claude Code | `claude-acp-npm`：`/opt/homebrew/bin/claude-agent-acp`，原生程序 `~/.nvm/…/@anthropic-ai/claude-code/bin/claude.exe` | 产品 2.1.316（npm 全局，nvm v26.13.0，来自安装记录）；适配器 0.99.1（npm 全局，Homebrew 的 Node） | claude-agent-acp 0.99.1 |
| Codex | `codex-native`：`codex app-server --listen stdio://` | 0.166.0（Homebrew Cask） | userAgent 0.166.0 |
| OpenCode | `opencode-binary`：`opencode acp` | 2.2.5（Homebrew） | OpenCode 2.2.5 |
| dsh | `dsh-native`：`dsh --profile acp` | 0.2.1-rc.5（npm 全局，nvm v26.13.0，来自管理视图） | 恒为 0.0.1（手册 3.1） |
| Hermes | `hermes-native`：`hermes acp` | 0.22.5（官方安装脚本） | hermes-agent 0.22.5 |
| OpenClaw | `openclaw-native`：`openclaw acp` | 证据头没有版本（npm 全局，Homebrew 的 Node，安装记录无版本） | openclaw-acp 2026.10.9 |
| Pi | 无 | `source: missing`，没有安装与控制入口 | — |

## 4. 方法

- **正式组合取启动方式。** 与 `tests/real/native-catalog.real.ts` 同一套路：`application()`（官网策略、私有数据目录与锁目录）、`prepareConfiguration`、`factory.validate`、`runtime.create`、`factory.prepare`。从准备好但**从未启动**的控制对象读出生产的启动参数（可执行文件、参数、环境、cwd 为 ws-a、TMPDIR 为该绑定的临时根目录，Claude 的 `CLAUDE_CODE_EXECUTABLE`），会话参数也用生产代码生成（`control.sessionParameters(cwd)`：Claude 的 `_meta.claudeCode.options.promptSuggestions=false`；OpenClaw 的会话键，其中会经 `openclaw gateway call agents.list` 读网关的默认代理）。每次运行结束 `binding.close()` 删除临时根目录、释放工作区租约与安装读锁。
- **自带最小客户端。** 生产 Driver 一个连接只拥有一个会话，所以多会话用本脚本的客户端直接说各家协议：ACP 的 initialize 与生产相同；Codex 的 initialize（`experimentalApi: false`）加 `initialized`、`thread/start {cwd, ephemeral: false}`；Pi 的 `get_state`、`new_session`、`switch_session`。程序发来的请求按生产在回合外的答法回复（审批 cancelled、表单 decline、其余 -32601）。
- **Hermes 只附着。** 每次启动 `hermes acp` 之前都跑一遍生产的只读预检（`readGatewayFacts` + `judgeGateway`，ADR-051 A2）；只有判 A 才启动。六次都判 A（网关 pid 82006 运行中，code_sha 与安装戳一致）。没有运行任何网关启停命令；OpenClaw 同样只连接已运行的网关。
- **每家的运行。** 3 次“只初始化”：启动 → initialize → 静置 5 s → 采样 → 关闭。3 次“会话”：启动 → initialize → 立即在 ws-a 建会话 1（计时）→ 静置 5 s → 采样；第 1 次另外在 ws-b 建会话 2 → 静置 5 s → 采样 → cwd 核对 → 切回会话 1 → 空闲 60 s（每 15 s 采样）→ 在进程内关掉会话 2（声明了 `session/close` 的用它，Codex 用 `thread/unsubscribe`）→ 3 s 后采样 → 关闭。所以每家 4 个探测会话。
- **RSS。** `ps -axo pid,ppid,pgid,rss,etime,comm`：领头进程、它的全部后代（按父进程追溯）与同进程组成员的 RSS 之和。程序名取 `comm` 的第一个词或路径的基名，不记参数（Node 程序会把标题改成“npm exec 包名”，只留 `npm`）。
- **cwd 核对（不靠模型）。** 协议回执与原程序自己的会话元数据：`session/list {cwd}`、Codex 的 `thread/start` 与 `thread/read` 报告的 cwd、各帧是否提到工作区路径；Claude 与 OpenCode 另在两个工作区各放一个项目命令文件作标记（`.claude/commands/hh-probe-wsa.md`、`.opencode/command/hh-probe-wsb.md` 等，从不调用），看每个会话宣告的命令目录里出现哪一个。
- **工作区快照。** 启动前、建会话前（initialize 后）、建会话后、空闲 60 s 后、关闭后，各对 ws-a、ws-b 拍一次（文件名、大小、mtime、sha256），结果只记路径与大小；绑定的 TMPDIR 也拍，按顶层条目汇总文件数与字节。
- **关闭。** 先关 stdin，最多等 8 s 让领头进程退出且进程组清空（生产只等 500 ms）；之后才会对进程组 SIGTERM、SIGKILL（本次从未用到）。再查采样中见过、已离开进程组的后代：当时还活着的记为“残留”，再等最多 10 s 看它们是否自己退出，仍在的才结束掉（本次没有）。
- **记录什么。** 耗时、大小、程序名、会话 ID、`~` 路径、通知按方法与种类计数；不记 stderr（只记字节数）、通知内容、配置内容或凭据。

## 5. 结果

### 5.1 启动开销【实测】

| Harness | 启动→initialize，中位（6 次） | 首个会话，中位（3 次） | 启动→首个会话，中位 | 同进程第二个会话（1 次） |
|---|---|---|---|---|
| Claude Code | 124 ms（118–167） | 297 ms（276、297、1378） | 445 ms | 289 ms |
| Codex | 26 ms（25–27） | 74 ms（72、74、3791） | 99 ms | 13 ms |
| OpenCode | 644 ms（555–1967） | 1057 ms（1054、1057、1564） | 2256 ms | 76 ms |
| dsh | 967 ms（945–2373） | 297 ms（218、297、324） | 1269 ms | 18 ms |
| Hermes | 553 ms（546–717） | 1241 ms（299、1241、1384） | 1794 ms | 147 ms |
| OpenClaw | 1259 ms（1219–1674） | 748 ms（638–825）＝生产参数 590–659 ms（`openclaw gateway call agents.list`）＋ `session/new` 48–166 ms | 2028 ms | 364 ms（352＋12） |

Claude 的 initialize 只启动适配器；Claude Code 的 CLI（`claude.exe`）在建会话时才按会话启动。OpenCode 有两次 initialize 在 1.9–2.0 s，其余约 0.6 s。

### 5.2 常驻内存与子进程【实测】

| Harness | initialize 后 | 1 个会话 | 2 个会话 | 空闲 60 s 后 | 进程内关掉会话 2 后 | 子进程（2 个会话时，程序名×个数） |
|---|---|---|---|---|---|---|
| Claude Code | 129 MiB（只有适配器 node） | 1464 MiB（1453–1473） | 2386 MiB | 2414 MiB | 1074 MiB（`session/close`） | 每个会话一组：`claude.exe`×1（约 310 MiB）、`npm`×3、`chrome-devtools-mcp`×1、`node`×3；17 个进程中 2 个不在领头进程组 |
| Codex | 98 MiB（`codex` 87 MiB＋启动时的 `git`×2、`git-remote-https`） | 1000 MiB（972–1048） | 1838 MiB | 1890 MiB | 1893 MiB（`thread/unsubscribe` 不释放） | 每个线程一组 MCP 服务器：`node_repl`×2、`SkyComputerUseClient`、`chrome-devtools-mcp`、`npm`×2、`node`×3；19 个进程中 18 个不在 codex 的进程组 |
| OpenCode | 332 MiB（领头 150 MiB＋子进程 `opencode` 177 MiB，子进程自成进程组） | 545 MiB（541–785） | 796 MiB | 797 MiB | 797 MiB（`session/close` 不变） | `opencode`×1（工作进程，自成进程组） |
| dsh | 255 MiB（一个 node） | 260 MiB | 260 MiB | 216 MiB | 218 MiB | 无 |
| Hermes | 169 MiB（一个 python3，169–207） | 190 MiB（186–200） | 200 MiB | 174 MiB | 不声明 close | 无；网关（1 个进程）334 → 338 MiB |
| OpenClaw | 449 MiB（node 72 MiB＋子进程 `openclaw` 约 375 MiB，自成进程组） | 451 MiB | 454 MiB | 384 MiB | 384 MiB | `openclaw`×1；网关（5 个进程）857 → 894 MiB |

- Claude 与 Codex 的会话成本几乎全是**每个会话各自启动的 MCP 服务器**（【推断】来自本机用户自己的 MCP 与插件配置，没有读配置核对）和 Claude 的 CLI：Claude 每会话约 0.9–1.3 GB，Codex 每线程约 0.85–0.9 GB；Codex 两个线程的 MCP 进程翻倍，同进程的线程不共享 MCP。
- dsh、OpenClaw 空闲后的下降发生在关会话之前（空闲第 15–30 s），是进程自身的回收，不是 close 释放的。只有 Claude 的 `session/close` 让该会话的 CLI 与 MCP 进程退出。

### 5.3 一个进程带多个会话【实测】

| Harness | 两个会话共存 | cwd 是否生效（依据） | 同进程切回会话 1 |
|---|---|---|---|
| Claude Code | 是 | 是：会话 1 只宣告 ws-a 的标记命令，会话 2 只宣告 ws-b 的；`session/list` 0 行（未发提示没有转录） | `session/load` 成功 14 ms（同一 ID）；`session/resume` 成功 1 ms |
| Codex | 是 | 是：`thread/start` 与 `thread/read` 报告的 cwd 即所请求的；`thread/list` 不列出它们（0 行） | `thread/resume` 失败 1 ms：-32600 “no rollout found”，尽管 rollout 文件已在（22.5 KB）。**需要一次模型调用才能验证**；`thread/read` 正常 |
| OpenCode | 是 | 是：标记命令各自只出现在自己的会话；`session/list {cwd}` 各列出一行，cwd 相符，不含另一个 | `session/load` 成功 4 ms；`session/resume` 成功 1 ms；`session/close` 成功 3 ms |
| dsh | 是 | 是：dsh 按 cwd 存会话（`~/.dsh/sessions/--<cwd>--/<id>`，会话 2 在 ws-b 的目录下）；`session/list` 0 行 | 不声明 `session/load`；`session/resume` 被拒 1 ms：-32602 “session is already active”（会话仍活着，无需切换）；`session/close` 成功 3 ms |
| Hermes | 是 | 无法从元数据核实：`session/list` 0 行，回执与通知不含 cwd | `session/load` 成功 195 ms；`session/resume` 成功 155 ms；不声明 close |
| OpenClaw | 是 | 无法核实：回执与通知不含 cwd，`session/list` 0 行（OpenClaw 在它自己的代理工作区执行工具，【文档】手册 1.7） | `session/load`、`session/resume` 都失败 3 ms：-32603 Internal error（未发提示的会话在网关里没有记录）。**需要一次模型调用才能验证**；`session/close` 成功 1 ms |

### 5.4 空闲写入与关闭【实测】

| Harness | 写工作区（建会话前、建会话后、空闲 60 s、关闭） | 写绑定的 TMPDIR（每次启动） | 关闭（stdin EOF 后进程组清空） | 关闭后残留 |
|---|---|---|---|---|
| Claude Code | 无 | Node 编译缓存 535 个文件、1.4 MB（【推断】是 npm 启动的 MCP 服务器写的：与 Codex 的文件数、字节数相同） | 无会话 22 ms；有会话 766–811 ms | 不在进程组的 `node`（MCP 后代）1–2 个，组清空后约 0.57 s 自行退出 |
| Codex | 无 | Node 编译缓存 535 个文件、1.4 MB；2–4 个空的 `.tmp*` 目录 | 304–1124 ms（中位 833；领头 3–368 ms 退出，其余是 `git` 等子进程） | 不在进程组的 `node`（MCP 服务器）1–4 个，组清空后 0.57–1.14 s 自行退出 |
| OpenCode | 无 | Bun 解出的原生库：启动时 `.dylib` 4.1 MiB，首个会话时再 `.dylib` 9.2 MiB、`.node` 335 KiB | 22–23 ms | 无（自成进程组的工作进程随之退出） |
| dsh | 无 | 原生插件加载器 221 KiB，一个空目录 | 20–44 ms | 无 |
| Hermes | 无 | 无 | 110–173 ms | 无；网关 pid 与启动时间前后不变 |
| OpenClaw | 无 | Node 编译缓存约 2400 个文件、约 11 MB | 349–391 ms（Node 退出时写编译缓存） | 无；网关 pid 前后不变 |

- 六家都没有在工作区里写任何东西，空闲 60 s 也没有。它们的写入落在自己的状态目录（第 8 节的探测会话）和 TMPDIR。
- 每次关闭都是 stdin EOF 自行完成，没有用到 SIGTERM 或 SIGKILL；10 s 的等待之后没有任何残留。
- 空闲 60 s 内的通知：只有 Claude 为会话 1 发了 1 条 `available_commands_update`，其余五家一条也没有，stderr 也没有输出。Codex 的 `mcpServer/startupStatus/updated`（每个线程 20–30 条）都在建线程后的 5 s 静置内发完；OpenCode、Hermes 在 `session/load`、`session/resume` 之后重发命令目录（各 2 条）。

## 6. 变体：持久 TMPDIR【实测，不是生产启动】

生产每次绑定都给一个新的 TMPDIR 并在关闭时删除，第 5.4 节里各家每次启动都重写缓存。变体只改 TMPDIR：4 次只初始化共用测量根目录下的一个目录（第 1 次冷，后 3 次热）。

| Harness | 生产（每次新 TMPDIR）initialize | 持久 TMPDIR：冷 → 热 | 关闭（领头退出 / 组清空） |
|---|---|---|---|
| OpenCode | 555–1967 ms（中位约 590） | 1690 → 161、163、160 ms | 不变（约 22 ms） |
| dsh | 945–2373 ms（中位约 960） | 1353 → 590、578、579 ms | 不变（约 20 ms） |
| OpenClaw | 1219–1674 ms（中位约 1250） | 1557 → 1135、1083、1140 ms | 336/346 → 22/44、66/88、35/44 ms |

## 7. 起不来或只测了一部分的 Harness

- **Pi：没有测。** 官网策略下没有可用的控制入口（`factory.validate`：“no available control”；证据头 `source: missing`）。本机的 `/opt/homebrew/bin/pi` 来自 npm 包 `@earendil-works/pi-coding-agent`，而全局 `node_modules` 里的这个包是指向源码检出（`~/Desktop/project/pi/packages/coding-agent`）的链接，发现不把它算作官网安装（ADR-044）。按要求没有为此改任何设置，Pi 没有启动，`--session-dir` 也没有用上。【文档】Pi 的 `docs/rpc.md` 与 `src/core/session-manager.ts`：一个进程同时只有一个活会话，`new_session`、`switch_session` 换掉当前会话；`new_session` 不带 cwd，cwd 属于进程；会话文件在第一条助手消息之后才写，所以切回一个未发提示的会话需要一次模型调用才能验证。
- **只测了一部分：** Codex 的 `thread/resume` 与 OpenClaw 的 `session/load`/`session/resume` 对未发提示的会话失败，需要一次模型调用才能验证；Hermes 与 OpenClaw 的 cwd 是否生效无法从元数据核实；dsh 只证明了“活会话不能 resume”，进程重启后的 resume 不在本次范围。

## 8. 守护与探测会话

**守护。** 整轮前后：`hosts-guard-before.json` 与 `hosts-guard-after.json`（`~/.cache/harnesshub-acceptance/evidence/2026-11-03/`，0600，不入库）覆盖 claude、codex、dsh、hermes、openclaw、opencode、pi 与共享清单共 31 处，`compare` 退出码 0，“unchanged”。脚本内每家（含三次变体）前后各比一次，全部 unchanged（`results.json` 的 `guard`）。

**探测会话**（只记 ID 与位置，没有读内容；临时工作区已删，原生侧保留，供以后清理）：

| Harness | 会话 ID（工作区） | 位置 |
|---|---|---|
| Codex | 试跑：`01a1a13e-67c8-7921-ab6d-542f4b2e7db5`（ws-a）、`01a1a13e-7a5a-7680-a9ab-7ab0b85e2f3c`（ws-b）；测量：`01a1a142-9466-7fa2-a238-293029e61d90`（ws-a）、`01a1a142-a86d-73e0-90b1-085a7f8c0230`（ws-b）、`01a1a143-c7bd-7cd2-ba61-34086f240806`（ws-a）、`01a1a143-f11f-7542-8a71-df221c9c4dc0`（ws-a） | `~/.codex/sessions/2026/11/03/rollout-2026-11-03T19-49-46-…`、`T19-49-48-…`、`T19-54-17-…`、`T19-54-22-…`、`T19-55-39-…`、`T19-55-46-…`（文件名以会话 ID 结尾，各约 22.5 KB）；Codex 自己的状态库里可能另有记录（没有打开） |
| Claude Code | `9bbe1020-64ab-44da-9df0-bb3835d2789b`（ws-a）、`8c38652d-7b69-44ae-8c35-58fa127352d3`（ws-b）、`a4d2e666-aa62-49eb-84a5-ed55c4c2f867`（ws-a）、`93e29909-adda-4ce6-962b-ad18162d80e7`（ws-a） | 没有转录 `.jsonl`；留下 `~/.claude/session-env/<ID>/` 4 个目录，`~/.claude/projects/-Users-sd3--cache-harnesshub-acceptance-hosts-2026-11-03-claude-ws-a/memory/` 与 `…-claude-ws-b/memory/`；`~/.claude.json` 的 projects 里可能多了这两个工作区（不在守护的 `mcpServers` 范围内，没有读） |
| OpenCode | `ses_e5ebb33d8ffeHIVHiBd0NvNjv6`（ws-a）、`ses_e5ebb1fbfffei64Ht8pSBBeQaX`（ws-b）、`ses_e5eba07c0ffeXXf54QwLZXlsDB`（ws-a）、`ses_e5eb9ecb2ffewNL3DOZANoGCpB`（ws-a） | `~/.local/share/opencode/opencode.db`（没有打开；按名字找不到文件） |
| dsh | `c76d26a3-f9c0-4957-a82d-c5e85e94a579`（ws-a）、`245c2cdd-0b9e-4b1a-85ee-b36cc1e581b7`（ws-b）、`ca524054-1785-49fd-855e-02e41cd7934a`（ws-a）、`355c0743-c973-4993-8912-4c05b7c6ed4e`（ws-a） | `~/.dsh/sessions/--Users-sd3-.cache-harnesshub-acceptance-hosts-2026-11-03-dsh-ws-a--/<ID>/`（3 个）、`…-dsh-ws-b--/<ID>/`（1 个）；`~/.dsh/storages/session_projcache/sessions/<ID>.json`（4 个，各 3354 B） |
| Hermes | `local-acc362b4a456eda4169f38101e079d92217f4430056b8b933dc7ef45c2c93225`（ws-a）、`local-d12b0fcd180f8a2df7b000372a69753656570bdccd36f7b703c6ed6d21a9d89b`（ws-b）、`local-08ceb3586322193b7596ade6e071e3b529469a1b42560e4488a9f3c10e466b20`（ws-a）、`local-52ccf22f0902ba2a199931b6cf99a3cdd77f915be1108cb554069ad815ba3788`（ws-a） | 用户的 Hermes 网关（`session/load` 能找到，应在它的 `state.db`；没有打开；按名字在 Hermes 家目录找不到文件） |
| OpenClaw | `8479a2f8-2118-4791-bfec-ea6ae5e4e5ed` 键 `agent:main:harnesshub:4df29752-9b6d-4e11-b3c5-3c45685b4b4b`（ws-a）、`e49cdac6-ceb7-4453-b45b-39e4ebb12a45` 键 `…:79bd48f5-b59a-485e-aa3d-e5c1d399f6de`（ws-b）、`d23c5e3b-48f8-4c8f-ac85-ec825deac53c` 键 `…:e9eb6e51-26a3-4ec1-bebf-70e8bff09381`、`f564b3f5-77bc-4598-b8ad-83e9bd9d961d` 键 `…:c06c0111-f0dc-425d-ba18-01f89e8504f3` | 没有落盘：网关里没有记录（load 失败），`~/.openclaw` 下按名字找不到 |
| Pi | 无 | — |

**清理。** 启动的全部进程都已结束（每次 EOF 自行退出，残留后代都在 1.2 s 内自行退出，事后按程序名复查没有遗留）；临时工作区、应用数据、试跑目录、变体 TMPDIR 与各绑定的临时根目录都已删除，安装读锁标记为 0。

## 9. 局限

- 没有发提示，所以没有回合期间的内存与 CPU、工具调用后的工作区写入，也没有“发过提示的会话”的 load/resume。
- RSS 是各进程之和，共享页会重复计入（不是 PSS）。Claude 与 Codex 的会话成本取决于本机用户自己配置的 MCP 服务器与插件，换一台机器会很不一样。
- 每家 3 次只初始化、3 次会话；第二个会话、切回、空闲、进程内关会话各只有 1 次样本。机器上同时有其他会话、Codex.app、Chrome 与 4317 在跑，计时含这些噪声。
- 只能看到采样时刻存在的后代进程；在两次采样之间起落、或离开进程组又很快退出的进程看不到。程序名只到第一个词，Node 写的 MCP 服务器多显示为 `node`/`npm`。
- 关闭用的是 8 s 的 EOF 等待；生产只等 500 ms 后对进程组 SIGTERM，那条路径下不在进程组里的后代是否也退出，没有实测。
- Hermes、OpenClaw 的网关 RSS 只是参考：网关同时服务用户的消息平台。
- 第 6 节的变体只改了 TMPDIR，只测 initialize。

## 10. 对设计的含义

### 10.1 宿主类型与建议【推断／建议】

| Harness | 宿主类型 | 主要依据 | 建议上限 | 建议空闲保活 |
|---|---|---|---|---|
| Claude Code | 可多会话：一个适配器进程带多个会话，每个会话一个 CLI 子进程及其 MCP | 同进程两会话、cwd 各自生效；`session/close` 释放该会话的进程；重建一个会话约 0.3 s | 按内存而不是按个数：每会话约 1–1.3 GB（本机配置），默认同时 ≤3 个活会话；一个 Hub 一个适配器进程即可 | 会话空闲 10 min 用 `session/close` 收回；进程没有会话后 2 min 关闭 |
| Codex | 可多会话，但每个线程独占一套 MCP 服务器 | `thread/unsubscribe` 不释放 MCP，只有退出进程才释放；进程起 26 ms、线程 74 ms，重建很便宜 | 每个对话一个 app-server 进程；全局默认 ≤3 个（每个约 0.9–1 GB） | 5 min，到时关进程 |
| OpenCode | 可多会话（共享进程，每加一个会话约 10 MiB） | load/resume/close 都可用；冷启动最贵（到首个会话 2.3 s，冷时 3 s） | 一个 Hub 一个进程，≤8 个会话（只实测到 2 个） | 15 min |
| dsh | 可多会话（会话在进程内，几乎不占内存） | 两会话 260 MiB；活会话不能 resume，按会话 ID 直接用 | 一个进程，≤8 个会话 | 15 min |
| Hermes | 原生服务型：会话在用户的网关里，`hermes acp` 只是查看器 | 网关 RSS 几乎不变；load/resume 对未发提示的会话也可用；只在预检 A 时才能启动 | 一个查看器进程，≤8 个会话；上限实际由用户网关决定 | 10 min（重新附着约 1.8 s，且每次要重新预检） |
| OpenClaw | 原生服务型：会话在 OpenClaw Gateway 里，桥接进程不随会话增长 | 两会话 454 MiB；未发提示的会话网关无记录 | 一个桥接进程，≤8 个会话 | 15 min（冷启动到首个会话约 2 s） |
| Pi | 只能一个会话一个进程（同进程只有一个活会话，cwd 属进程） | 【文档】未实测 | 每个对话一个进程 | 5 min |

保活时长按“重建代价 ÷ 占用内存”取：Codex 与 Claude 重建便宜而每会话占用大，宜短；OpenCode、OpenClaw、Hermes 冷启动 1.8–2.3 s 而会话几乎不占内存，宜长。这些上限是起点，不是实测出的容量。

### 10.2 横向结论

1. **只靠进程组清理不够。**【实测】Codex 的 MCP 服务器、Claude 的部分 MCP 后代、OpenCode 的工作进程、OpenClaw 的子进程都不在领头进程的进程组里，组信号到不了它们。本次它们在 EOF 后都自己退出了（最多晚 1.14 s）。【建议】宿主关闭先关 stdin，再按 pid 加启动时间核对离组后代（`process-group.ts` 的 `outsidersOf` 已有这种读法），信号只作兜底。
2. **500 ms 的关闭宽限偏短。**【实测】Claude 带会话时约 0.8 s、Codex 0.3–1.1 s 才自然退出，生产会在 500 ms 时 SIGTERM 它们。【建议】宽限放到 1.5 s 以上（本次最长 1124 ms）。
3. **每次绑定换新 TMPDIR 代价明显。**【实测】持久 TMPDIR 让 OpenCode 的 initialize 从约 590 ms 降到约 160 ms、dsh 从约 960 ms 降到约 580 ms、OpenClaw 从约 1250 ms 降到约 1100 ms（关闭从约 350 ms 降到约 45 ms）。【建议】由 Hub 给每家一个稳定、私有、升级时清空的 TMPDIR，与会话隔离的取舍写进 ADR。
4. **空闲不写工作区。**【实测】未发提示时六家都不写工作区，保活进程不会在空闲时改动用户文件；写入只在各自的状态目录与 TMPDIR。
5. **建会话就会留下原生记录。**【实测】Codex（rollout 文件）、dsh（会话目录与缓存）、Claude（`session-env` 与项目 `memory` 目录）、OpenCode（数据库）、Hermes（网关）在没有任何提示时就留下会话；OpenClaw 不留。【建议】不要为“预热”提前建会话：到第一条消息才建，或只预热进程。
6. **“切回”要区分活会话与恢复。**【实测】同进程里的会话一直活着：Claude、OpenCode、Hermes 接受对活会话的 load/resume，dsh 拒绝（already active），Codex 与 OpenClaw 对没有回合的会话拒绝。【建议】宿主维护“进程里有哪些活会话”的表，活会话直接按 ID 用，只在进程重启后才 load/resume。
7. **进程内关会话只有 Claude 真正释放资源。**【实测】Claude 的 `session/close` 让该会话的 CLI 与 MCP 退出（2414 → 1074 MiB）；OpenCode、dsh、OpenClaw 的 close 成功但内存不变；Codex 的 `thread/unsubscribe` 不释放 MCP；Hermes 不声明 close。【建议】对 Codex 与不释放的几家，收回内存的手段是关进程，上限按进程算。
