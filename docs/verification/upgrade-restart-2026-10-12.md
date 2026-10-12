# 升级与重启验收（2026-10-12）

依据 [ADR-043](../decisions/0043-upgrade-with-running-programs.md)。

## 起因

- 用户在 4317 上点了 OpenClaw 的“升级 Harness”，看到的是“安装失败 / 安装失败”，以及“本机程序仍有活动进程，请结束对应任务后再升级”。用户的反馈是“怎么升级失败？这不符合用户逻辑”。
- 只读核实的结果：
  - 任务 `…2d0362ac` 在 13:12:27Z 创建，1.4 秒后以 HARNESS_BUSY 结束，没有派发。本机 OpenClaw 仍是 2026.3.23-2，用户的 Gateway（PID 4039，自 10 月 5 日起运行）和 Node（PID 4736）都没有被碰过。
  - 10 月 11 日的两次升级也是这样结束的。原因是 `native.ts` 的 `assertIdle` 会拦下任何在运行的 `openclaw-gateway`，而它是 launchd 常驻服务。
  - `/tmp/harnesshub-native-501` 下还有 claude 两条、hermes 一条使用记录，写它们的进程（49231、60280、50330）都已结束。按原来的规则，这三条记录同样会让升级报“还有任务在运行”。
- 用户的决定（AskUserQuestion）：“由 HarnessHub 升级并重启（推荐）”，并补充“其他的 harness 也是一样”。
- 审批代理（Fable 5.1）的裁决和附加条件，逐条写在 ADR-043 里，包括：
  - 只重启产品自己的升级会重启的服务。
  - 确认框写清所有风险。
  - 恢复判定看 running 状态、新进程、启动次数和端口。
  - 管理库升版本号，并验证手工降级。
  - 真实的 OpenClaw 升级由用户自己点击。

## 改动

- 后端：
  - 新增 `program-usage.ts`，读取 launchd、ps、lsof 来识别使用这个安装的程序，并负责重启和等待恢复。
  - `native.ts` 拆成 `prepare`（改动前的全部检查，包括 Node.js 要求和隔离的兼容校验）与 `execute`（只负责安装和核实），去掉了 `assertIdle`。
  - `native-lock.ts` 在维护锁内清除旧记录，并区分仍在运行的使用方。
  - `service.ts` 新增升级前检查，改了执行顺序，记录同意内容与重启结果。
  - 会话运行时新增 `programUsers` 和 `releaseForUpgrade`，以及关闭原因 `harness_upgrade`。
  - 新接口 `GET /api/v1/harnesses/{id}/maintenance`；提交升级时可以带上 `restartServices`。
  - 管理库升到 v3。
  - OpenClaw 配方声明了 Gateway（随升级重启，`--port`）和 Node（不重启，`openclaw node restart`）。
- 前端：
  - 新增升级确认框（`UpgradeDialog.tsx`）。
  - 任务状态改用“没有升级”“已升级但服务未恢复”等说法；没有派发的任务不显示核实字段和空日志；旧的拒绝按实际情况重新解释。
  - 详情里的任务挪到版本信息下面。
  - 对话里提示“升级关闭了保留进程”。
  - “本机安装”的原因改成中文。

## 自动检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `tsc -p tsconfig.json`、`tsc -p web/tsconfig.json` | 通过 |
| 单元与集成 | `pnpm test` | 650 通过，0 失败（新增 G011-UP1～UP8、G028-UP1 共 11 项） |
| 浏览器 | `node --test dist/tests/browser/web.browser.js` | 30 个：完整运行 29 通过、1 失败；失败的是下面第三条有意改动，更新断言后单独重跑通过（新增 G054-UP1、UP2） |
| 设计检查 | `pnpm check:design` | 通过；新增切片 `upgrade-with-running-programs`，场景 G011-UP1～UP8、G028-UP1、G054-UP1～UP2 |

有意改变、并同步更新了测试的行为：
- 读写锁并发测试原来用正则匹配旧的英文提示，现在改为断言错误代码 `HARNESS_BUSY`，比原来更严格。
- v1→v2 迁移测试原来断言迁移后的版本是 2，现在应为 3。
- 受管安装的浏览器测试里，升级完成后的状态原来显示“安装完成”，现在显示“升级完成”：任务状态按动作区分。

## 真实验证（本机 macOS）

1. **launchd 重启（只用临时代理）**：脚本建了一个只属于测试的代理 `com.harnesshub.test.<uuid>`，程序放在临时“安装”里，监听一个空闲端口。
   - 用正式代码的 `systemProgramHost` 识别：耗时 348 ms，代理被认作这个安装的服务，端口也认对了；用户自己的服务没有一个被误认。
   - `restartProgramService` 得到新进程 5710（旧进程 5061 已退出），就绪为真，`runs = 2`，耗时 15.9 秒。这是 launchd 默认 10 秒的重启间隔造成的，因为代理刚刚启动。
   - 先 bootout 再“重启”，结果为 null，没有被重新启动。
   - 结束后代理已不在加载状态，文件全部删除，`launchctl list` 里没有残留。
2. **只读核对用户的 OpenClaw 安装**：所用的 host 一调用 kickstart 就抛错，从代码上到不了重启；只读 ps、`launchctl list/print` 和 `/usr/sbin/lsof`。耗时 330 ms，结果：
   - `ai.openclaw.gateway`（4039）：随升级重启，端口 18789，正在监听。
   - `ai.openclaw.node`（4736）：不随升级重启，提示 `openclaw node restart`。
   - `ai.hermes.gateway` 不属于这个安装。没有其他常驻程序或进程。
   - 核对前后两个服务的启动时间都还是 10 月 5 日。
3. **兼容校验预演（一次，审批代理同意）**：对 2026.10.2 跑 `prepare()`。它在下载候选版本之前就停下了：`RUNTIME_INCOMPATIBLE`，提示是“新版本 2026.10.2 要求 Node.js >=24.16.0 <25 || >=26.1.0，运行它的 Node.js 是 25.9.0（/opt/homebrew/bin/node）。先升级 Node.js 再升级；HarnessHub 不替你升级 Node.js。没有升级。”
   - 依据：npm 发布元数据里，2026.10.2 的 `engines.node` 是 `>=24.16.0 <25 || >=26.1.0`，2026.3.23-2 是 `>=22.16.0`。在 25.9.0 上可用的最新版本是 2026.9.2，从 2026.9.3 起排除了 Node 25。本机还有 `node@22`，也不满足。
   - 所以这次没有走到 `config validate`，2026.10.2 能否接受用户现有的配置仍然未知。用户真正点击时会再校验一次，以那次为准。临时目录已删除，用户的安装和配置没有变化。
4. **已部署构建与管理库 v3**：用主检出的构建（服务端来自 80a5246，也就是 4317 正在运行的版本）在临时副本上核对：
   - 它拒绝打开 v3 的库，报 `unknown management storage schema`。
   - 执行 `tools/management-v3-to-v2.sql` 之后，它能打开库，完成全库审计，读出的任务只带 v2 的六个字段。
   - 副本已删除。

## 部署到 4317

- 22:16，按空闲流程执行：没有进行中的回合、待生效的切换或保留进程；管理任务没有在运行的。
  - 向 PID 13687 发 SIGTERM。部署脚本只等 10 秒，它在 10 秒内没有退出，脚本就停在了这一步（这是脚本的设计，不是错误）。随后确认进程已经退出、没有子进程、端口已释放，再从“冷备份”这一步接着做。这次停止为什么超过 10 秒，还没有查。
  - 在会话临时目录做了 APFS 克隆：数据目录（业务库 v12、管理库 v2）和工作区租约（8166 个文件），都与在线数据一致。
  - 主检出快进到 ddfc20a，安装依赖并构建。
- 22:17:50，用原参数经登录 shell 启动，新进程 67939。管理库已迁移到 v3，业务库仍是 v12，会话数 4 个，与停止前相同。
- 用这次启动的一次性链接，在无界面浏览器里打开“我的 Agent”，点 OpenClaw 的“升级”。确认框是真实检查的结果：
  - 顶部写着“现在不能升级”：2026.10.2 要求的 Node.js 范围，以及本机的 25.9.0（/opt/homebrew/bin/node）。
  - 下面依次是：安装新版本（相隔约 7 个月，未经验证）；会重启的 OpenClaw Gateway（进程 4039）和命令原文；不会被关闭的 OpenClaw Node（进程 4736）和 `openclaw node restart`；插件；OpenClaw 的说明；退回命令。
  - 确认按钮不能点。控制台没有错误或警告。只打开、取消，没有提交。
- 发现一处问题：插件列表里出现了 `.openclaw-install-backups`，这是 OpenClaw 自己存放安装备份的隐藏目录，不是插件。已改为不列出以点开头的目录，并补了测试（G011-UP2），随第二次重启部署。

- 22:19:44，第二次按空闲流程重启：再次确认空闲，PID 67939 收到 SIGTERM 后不到 1 秒就退出了（第一次停止慢，很可能是当时用户的页面还连着）；克隆备份与在线数据一致；快进到 62c242c 并构建。22:20:31 用原参数启动，新进程 78660，管理库 v3、业务库 v12，会话 4 个。用户的 OpenClaw Gateway（4039）、Node（4736）和 Hermes 网关（4058）的启动时间仍是 10 月 5 日。新的一次性链接已在用户的浏览器里打开。
- 核对完成后，按用户的规则删除了两组克隆备份；今晚无界面浏览器留下的快照和截图也已删除。`.tmp/` 里仍然只有 `discovery-manifest.json` 和 `service-4317.log`。

## 用户的 Node.js 改由 nvm 管理（同日）

用户要求“帮我升级一下 node，用 nvm 进行管理”。只读核实到的情况：
- 本机已经有 Homebrew 装的 nvm 0.40.3 和用它装的 Node v23.10.0，但只在 `~/.bash_profile` 里加载，zsh 里一直用的是 Homebrew 的 Node 25.9.0。
- `~/.npmrc` 里只有 registry 设置，没有和 nvm 冲突的 prefix。
- `gemini-cli` 依赖 Homebrew 的 Node，所以 Homebrew 的 Node 保留。
- 全局 npm 工具（包括 OpenClaw）装在 Homebrew 的前缀下。其中的原生模块都是 N-API 预编译的，不绑定 Node 大版本。

做了什么：
- 先把 `~/.zshrc` 复制到会话临时目录，然后在文件末尾追加 Homebrew 版 nvm 官方给出的三行加载语句和说明注释，原有内容不变。
- 用 nvm 安装 Node 26.11.1（2026-10-07 发布，npm 11.20.0，校验和一致），并执行 `nvm alias default 26`。
- 新开的 zsh 里，`node` 是 `~/.nvm/versions/node/v26.11.1/bin/node`，`npm prefix -g` 是 nvm 的目录。OpenClaw 2026.3.23-2、Pi 0.85.1、pnpm 10.12.3、Gemini 0.62.0 在 Node 26 下都能启动。Claude Code 是原生可执行文件，不受影响。
- 没有改动的：Homebrew 的 Node 25.9.0、全局 npm 工具的安装位置、OpenClaw 的 launchd 服务。服务仍按 plist 用 `/opt/homebrew/opt/node/bin/node`，也就是 25.9.0。

HarnessHub 在 Node 26 下的检查：
- 单元与集成测试 650 通过。
- 浏览器测试第一次运行 29 通过、1 失败。失败的是实时对话测试里“窄屏下输入框不超过 140 像素”这一条，在 Node 25.9 和 26 下都会偶发：模型列表已经加载、模型名较长时，输入框下面那排选择按钮在 390 像素宽时折行，把输入框撑到 150 像素。这是 ADR-042 的布局问题，不是 Node 的问题。
- 修法：这排选择按钮不再折行，超出部分横向滚动。断言没有放宽，只是在失败信息里加上了高度和文字。修复后连续 6 次通过；全量结果见下一条。

HarnessHub 在 Node 26.11.1 下修复后的全量结果：单元与集成测试 650 通过；浏览器测试 30 通过。

### 后台服务各自用的 Node.js（新增检查）与 Homebrew 的 Node.js

- 发现的问题：原来的检查只看命令行解释器。nvm 只对交互式 shell 生效，OpenClaw 的两个 launchd 服务按 plist 用 `/opt/homebrew/opt/node/bin/node`。如果只换了终端里的 Node，确认框会放行升级，Gateway 重启后却跑在新版本不支持的 25.9.0 上。
- 修复：检查每个以 Node.js 启动的服务。会被重启的服务不满足要求时阻止升级，并给出 `brew upgrade <formula>`；不重启的服务只提示。见 ADR-043 第 7 条、G011-UP8、G054-UP1。
- 用户的选择（AskUserQuestion）：“也升级 Homebrew 的 Node（推荐）”。依据是 OpenClaw 文档建议后台服务使用系统安装的 Node.js，而不是版本管理器的路径。
- 执行的命令是 `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 brew upgrade node`，先预演过：
  - node 从 25.9.0_2 升到 26.11.1。
  - 新装 libffi、openssl@4、highway。
  - 升级 abseil、fmt、simdutf、ada-url（3→4）、c-ares、hdrhistogram_c、libnghttp2、libuv、llhttp、merve、ca-certificates、simdjson（4→5）、readline、sqlite。
  - 不检查依赖 node 的软件，是因为默认会把 `gemini-cli` 一起升到 0.46.0，而用户实际用的 Gemini CLI 是 0.62.0，那样会变成降级。`gemini-cli` 保持 0.38.2 的 keg，`gemini --version` 仍是 0.62.0。
  - 不清理旧版本：旧的 node 25.9.0_2 链接了 `libllhttp.9.3`、`libada.3`、`libsimdjson.33`，这几个库这次都换了大版本。已经在运行的进程不受影响（库已加载）；但再用旧版本程序启动新进程会失败。
- 升级前就在跑、用旧版本程序的进程：
  - OpenClaw 的 Gateway（4039）和 Node（4736），自 10 月 5 日起运行。OpenClaw 只在不受 launchd 管理时，才会用 `process.execPath` 重新拉起自己（`gateway-cli` 第 42570 行附近），平常收发消息不会；下次重启就换到 26.11.1。
  - 用户自己的 `remotion studio`、`pnpm dev`（端口 3123），以及几个经 npx 启动的 MCP 服务。它们方便时重开即可。
  - 4317 已在部署时重启。
  - 这些都换到新版本以后，再执行 `brew cleanup node` 清理旧版本。
- 结果：`/opt/homebrew/bin/node` 与 `/opt/homebrew/opt/node/bin/node` 都是 26.11.1。OpenClaw、Gemini、pnpm、Pi 在系统 Node 26 下都能启动。用户的三个服务没有被重启，启动时间仍是 10 月 5 日。
- 用新代码只读核对 OpenClaw 2026.10.2 的运行环境，host 无法重启任何东西：
  - 命令行解释器 `~/.nvm/versions/node/v26.11.1/bin/node` 是 26.11.1，满足。
  - `ai.openclaw.gateway`（会被重启）和 `ai.openclaw.node`（不重启）都用 `/opt/homebrew/opt/node/bin/node`，是 26.11.1，满足。
  - 现在运行环境已经不再阻止 OpenClaw 升级。配置能否通过，要在用户点击时的校验里确认。

### 4317 改用 Node 26 时没能启动，以及修复

- 22:45 按空闲流程部署 877b58a，经登录 shell 启动后进程退出，日志只有 `WEB_FAILED`。用同样的参数和 Node 26 复现，拿到原始错误：`ManagementError INVALID_DATA managed package entry or runtime identity changed`，出在启动时核对旧的私有安装记录。
- 原因：管理库里有 ADR-017 之前留下的 5 条私有安装记录。其中 codex 两条、gemini 一条记的是当时运行 HarnessHub 的 `/opt/homebrew/Cellar/node/25.9.0_2/bin/node`，而启动核对要求它和当前运行的 Node 完全相同。所以无论用 nvm 还是 Homebrew 升级 Node，HarnessHub 都会起不来。旧的 25.9.0 也已经不能再启动（依赖库换了大版本），不能退回去用。
- 修复（33620db）：Node.js 已经换了、甚至路径已经不存在的这类记录，作为历史保留：不再用于后备入口，也不再算作已安装，启动不因它失败。槽内运行环境不对、启动凭据不一致、入口、参数和环境被改，这些仍按损坏处理。新增测试 `a private npm installation made with HarnessHub's former Node.js…`（`tests/integration/management-service.test.ts`），原有的篡改测试照常通过。这几条记录只在本机找不到系统安装时才会被用作后备，这台机器上用不到。
- 22:50:32，4317 恢复（进程 88834），中间停了约 4 分钟。22:53:11 为了给用户新链接，再按空闲流程重启了一次（进程 1262）。两次都跑在 `~/.nvm/versions/node/v26.11.1/bin/node` 上。管理库 v3、业务库 v12，会话 5 个，多出的一个是下面的冒烟对话。
- 在无界面浏览器里核对真实页面：
  - OpenClaw 的升级确认框不再被 Node 挡住，“升级并重启 OpenClaw Gateway”可以点，我没有点，只点了取消。
  - 插件只列出 `openclaw-weixin`。
  - 新建对话，让 Claude Code 回“收到，Node 26 工作正常”：首字 5.8 秒，用时 7.6 秒。
  - 控制台没有错误或警告。
- 最终检查：
  - 单元与集成测试 651 通过（Node 26.11.1）。
  - 浏览器测试：877b58a 上全量 30 通过；33620db 只改了管理服务，涉及安装和升级的 4 个浏览器测试重跑通过。
  - 设计检查通过。
- 部署用的克隆核对后都已删除。用户的 OpenClaw 两个服务和 Hermes 网关的启动时间仍是 10 月 5 日。

## 回退

现在没有数据备份。要退回 ADR-043 之前的构建：
1. 按空闲流程停掉 4317。
2. 在没有 Gateway 运行时执行 `sqlite3 data/management/management.sqlite < tools/management-v3-to-v2.sql`。这一步保留所有任务行，只去掉 v3 新增的五个字段；已用部署构建验证过，见上文“真实验证”第 4 条。
3. 主检出退回 86c8d90，执行 `pnpm install --frozen-lockfile`，重新构建，再用原参数启动。注意：86c8d90 不能在已经换过的 Node 上启动（见上文“4317 改用 Node 26 时没能启动”）。要退回到那么早，需要先把旧版私有安装记录里的运行环境路径处理掉，或者退回到 33620db 及以后的提交。

业务库仍是 v12，不需要处理。

## 尚未验证

- 用户真实的 OpenClaw 升级：要由用户在 4317 上点击。按现在的本机环境，它会在确认框里因为 Node.js 25.9.0 被挡住。所以 Gateway 的真实重启、恢复判定和配置校验都还没有在用户的服务上发生过；目前只用临时代理验证过 kickstart 和恢复判定。
- Linux（systemd 服务不识别）与 Windows（原生升级不支持）。
- Homebrew 或 uv 渠道的产品如果也有常驻服务，配方里没有声明，会归入“不随升级重启”。这条路径只有单元测试，没有用真实程序验证过。
- 源码安装（Hermes、dsh、Pi 开发目录）仍不在 HarnessHub 里升级。
