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

## 回退

现在没有数据备份。要退回 ADR-043 之前的构建：
1. 按空闲流程停掉 4317。
2. 在没有 Gateway 运行时执行 `sqlite3 data/management/management.sqlite < tools/management-v3-to-v2.sql`。这一步保留所有任务行，只去掉 v3 新增的五个字段；已用部署构建验证过，见上文“真实验证”第 4 条。
3. 主检出退回 86c8d90，执行 `pnpm install --frozen-lockfile`，重新构建，再用原参数启动。

业务库仍是 v12，不需要处理。

## 尚未验证

- 用户真实的 OpenClaw 升级：要由用户在 4317 上点击。按现在的本机环境，它会在确认框里因为 Node.js 25.9.0 被挡住。所以 Gateway 的真实重启、恢复判定和配置校验都还没有在用户的服务上发生过；目前只用临时代理验证过 kickstart 和恢复判定。
- Linux（systemd 服务不识别）与 Windows（原生升级不支持）。
- Homebrew 或 uv 渠道的产品如果也有常驻服务，配方里没有声明，会归入“不随升级重启”。这条路径只有单元测试，没有用真实程序验证过。
- 源码安装（Hermes、dsh、Pi 开发目录）仍不在 HarnessHub 里升级。
