# ADR-043：升级时处理正在使用安装的程序

状态：accepted，2026-10-12。方向由用户决定（“由 HarnessHub 升级并重启，其他的 Harness 也是一样”），细节由用户授权的审批代理（Fable 5.1）裁决。取代 ADR-017 中“发现活动本机进程时拒绝原地升级，不杀其他任务”一条，ADR-017 的其余决定不变。

## 背景

- 用户在 4317 上点了 OpenClaw 的“升级 Harness”（npm 全局安装，2026.3.23-2 → 2026.10.2），任务马上显示“安装失败”，原因写的是“本机程序仍有活动进程，请结束对应任务后再升级”。
  - 实际情况：升级前检查发现了用户自己的 OpenClaw Gateway。它是 launchd 用户代理 `ai.openclaw.gateway`，10 月 5 日起常驻，连着微信插件 `openclaw-weixin` 和飞书。按 ADR-017，HarnessHub 拒绝了升级，什么都没改。
  - 这个 Gateway 总在运行，所以 OpenClaw 在 HarnessHub 里永远升级不了：10 月 11 日两次、10 月 12 日一次，都是同样的结果。
  - 界面在用户点完之后才说不行；把没有开始的升级叫作“安装失败”；让用户去结束一个并不存在的“任务”；还显示了“尚未核实”“尚未确认”和空的安装日志。用户的评价是“不符合用户逻辑”。
- 同类问题：本机锁目录里留着 Claude Code 两条、Hermes 一条“正在使用”的记录，写下它们的进程早已结束，但它们同样会让升级被拒，提示是“还有任务在运行”。
- OpenClaw 官方的升级方式（`docs/install/updating.md`、`docs/cli/update.md`）：安装新版本，运行 doctor，然后重启 Gateway 服务。手动 npm 升级也是先装、后 `openclaw gateway restart`，不要求先停服务。npm、Homebrew 的升级同样不因程序在运行而拒绝。

## 决定

1. **升级前先检查，再请用户确认。** 新接口 `GET /api/v1/harnesses/{id}/maintenance` 只读，不改任何东西。它列出使用这个安装的程序，分为四类：
   - **随升级重启的后台服务**：在 macOS 当前用户的 launchd 域中正在运行、程序或前几个参数落在这个安装里（入口、实际入口或包目录），并且配方声明“产品自己的升级会重启它”的任务。
   - **不随升级重启的常驻程序**：配方声明不重启的服务（例如 `ai.openclaw.node`，给出产品自己的重启命令 `openclaw node restart`）、没有声明但同样落在这个安装里的 launchd 任务，以及按配方声明的进程名识别出的、在服务管理器之外运行的常驻程序。这些程序在确认框里单独列出，标明“继续用旧版本，需要你自己重启”。
   - **其他程序**：命令行指向这个安装的进程，例如终端里的会话。HarnessHub 不关闭它们，也不向它们发任何信号，它们重开后才用新版本。这与 `openclaw update`、`npm i -g`、`brew upgrade` 的行为一致。
   - **HarnessHub 自己的使用方**：
     - 空闲地保留着进程的对话（ADR-030）：升级前按正常停止链关闭，记录原因 `harness_upgrade`，下次发消息时重新连接。
     - 正在回复或等用户处理的对话：阻止升级，确认框列出这些对话，可以直接打开。
     - 另一个仍在运行的 HarnessHub 进程持有的使用记录：阻止升级。
     - 写记录的进程已经结束（或 PID 已被复用：启动时间晚于记录）的旧记录：在维护锁内清除，逐条写日志。
2. **确认框写清楚会发生什么。** 内容包括：
   - 目标版本和原渠道；两个日历版本相隔两个月以上时说明跨度。
   - 目标版本没有经过验证时，按 ADR-038 说明 HarnessHub 是在哪个版本上验证的。
   - 会重启的服务，以及将要执行的命令原文（`launchctl kickstart -k gui/<uid>/<label>`）。
   - 会关闭的 HarnessHub 进程，以及仍用旧版本的程序。
   - 已安装插件的目录名，以及配方里的产品说明。OpenClaw 的说明有：重启时渠道会断开片刻，最好选能接受中断的时间；HarnessHub 不运行 `openclaw doctor`，需要迁移时由用户运行 `openclaw doctor` 再 `openclaw gateway restart`；插件可能不兼容。
   - 退回原版本的命令（npm：`npm install --global <包>@<原版本>`；uv：`uv tool install --force <包>==<原版本>`）。
   - 有阻止项时，确认按钮不可用。
3. **用户的同意随命令提交。** 命令带上 `restartServices`（服务标签列表），这个列表计入命令指纹。提交时使用的指纹是确认框所描述的那个安装。开始改动之前会再检查一次：
   - 出现了没有同意过的需要重启的服务，就不升级，请用户重新确认。
   - 同意过的服务已经不在运行，就不去启动它。
   - 出现了阻止项，就不升级。
4. **执行顺序。** 改动之前的检查全部放在最前面：解析精确版本；运行产品自己的兼容校验；检查对话、其他 HarnessHub 进程和需要同意的服务。之后依次：
   1. 关闭 HarnessHub 的空闲进程，取得维护锁并清除旧记录。
   2. 原渠道安装，核实版本，比对受保护配置的摘要。2026-10-17 起（ADR-044），摘要有变化只记入任务日志，不再判失败：包管理器在沙箱里写不了这些文件，变化只会来自仍在运行的程序（例如正在运行的 Claude Code 改写 `~/.claude.json`）。
   3. 版本核实后**立即**逐个重启同意过的服务（旧进程和新文件并存的时间越短越好）。
   4. 重启后再比对一次配置摘要。如果有变化，记为“重启后的服务自己写的”，不算 HarnessHub 写入，界面如实写明。
5. **恢复的判定。** 重启一个服务后，在 60 秒内同时满足下面三条，才算恢复：
   - `launchctl print` 的顶层字段显示 `state = running`；
   - 进程号是新的，并且连续 5 秒不变；
   - 自重启起只启动过一次（`runs` 只加 1，排除崩溃重启的循环）。

   配方声明了端口参数的服务（OpenClaw Gateway 的 `--port`），还要在这 60 秒内的任一时刻，由 `/usr/sbin/lsof -p <新进程>` 确认它在监听那个端口。lsof 每次最多 5 秒，HarnessHub 不向这个端口发起连接。参数里没有端口时不算失败，结果写“可用性未验证”。
6. **失败时如实记录，不自动回滚，也不自动重试。**
   - 在改动之前停下：任务记为 failed，`dispatched` 为假。界面写“没有升级，什么都没改”，加上原因和下一步。如果停下之前已经关闭了空闲进程，界面写明关闭了几个，不说“什么都没改”。
   - 新版本已经核实、但服务没有恢复（或没有在端口上监听）：任务记为 failed，同时记下已安装的版本和每个服务的结果。错误信息给出重试命令和退回原版本的命令。安装结果是已知的，所以释放维护锁。
   - 派发之后结果未知：照 ADR-017 记为 unknown，不重跑。
7. **运行环境要求先说清楚。**
   - npm 发布声明了 `engines.node` 时，按运行这个程序的 Node.js 核对：程序 `#!` 行指定的解释器，`/usr/bin/env node` 的按用户 PATH 解析，找不到时用 HarnessHub 自己的 Node.js。
   - 确认框会列出要求的范围、解释器路径和版本；不满足时不能确认。升级执行时会再核对一次，不满足就在改动前停下（`RUNTIME_INCOMPATIBLE`），说明要先升级 Node.js。HarnessHub 不替用户升级 Node.js。
   - 这是 ADR-017 已有的检查（原来只比较 HarnessHub 自己的 Node.js，提示是英文），这次改为核对实际运行程序的解释器，并提前到确认之前。
   - 本机实例：OpenClaw 2026.10.2 要求 `>=24.16.0 <25 || >=26.1.0`，本机运行它的是 Homebrew 的 Node.js 25.9.0，所以现在不能升级到 2026.10.2。在 25.9.0 上可用的最新版本是 2026.9.2，从 2026.9.3 起就排除了 Node 25。
   - **后台服务各自用的 Node.js 也要核对**（同日补充）：
     - launchd 任务会在 plist 里写死自己的 Node.js 路径（OpenClaw 的是 `/opt/homebrew/opt/node/bin/node`），不加载用户的 shell，所以 nvm 之类版本管理器的默认版本对它不起作用。
     - 一个服务的程序是 Node.js 时，确认框和执行时都会核对它的版本。会被重启的服务不满足要求时阻止升级，并给出升级办法：Homebrew 安装的 Node.js 给出 `brew upgrade <formula>`。不重启的服务只提示：在它下次重启之前，需要先升级它用的 Node.js。
     - 依据：OpenClaw 文档 `gateway/doctor.md` 第 17 节，以及 2026.3.23-2 的 `runtime-paths-DOEOEFe-.js`（`VERSION_MANAGER_MARKERS`、`resolvePreferredNodePath`）。OpenClaw 让后台服务使用系统安装的 Node.js（Homebrew 等），并警告版本管理器的路径在升级后会失效，所以 HarnessHub 不建议把服务改到 nvm 的路径上。
8. **兼容校验在隔离环境里运行。** OpenClaw 的候选版本仍按原受保护路径装进临时目录（`--ignore-scripts`，拒绝写配置）。`config validate` 在白名单沙箱里运行：先 `(deny file-write*)`，只放开这次任务的临时目录与 `/dev/null`，再 `(deny network*)`，期限 60 秒。真实配置文件不复制（里面有渠道凭据），只读不写，也连不到正在运行的网关。输出不落盘，只记录通过与否和经过脱敏的配置路径名。
9. **配方声明产品事实，Gateway 不按产品分支。** 每个产品的服务标签、是否随升级重启、自己的重启命令、端口参数、常驻进程名、插件目录和升级说明都写在配方里（`src/adapters/management/recipes.ts`）。OpenClaw 只声明 `ai.openclaw.gateway`（随升级重启，端口参数 `--port`）和 `ai.openclaw.node`（不重启，`openclaw node restart`），因为 OpenClaw 自己的升级只重启 Gateway；依据见下文。去掉了 `native.ts` 里写死的 `openclaw-gateway` 判断。
10. **界面。**
   - 任务状态按动作区分：正在升级、升级完成、没有升级、已升级但服务未恢复、升级失败、结果待核实。
   - 没有派发的任务不显示“已核实版本”“原配置”，也不显示空日志。
   - 旧版本记下的那种拒绝（“请结束对应任务”）按实际情况重新解释。
   - 详情里的任务挪到版本信息下面，提交后直接能看到。
   - 被升级关闭了保留进程的对话，在输入框上方和详情栏的“后台”页说明这件事，直到下一轮开始。
   - “本机安装”里的英文原因改成中文，并说明怎样用产品自己的方式更新。

## 依据：通用 kickstart 与 OpenClaw 自己的重启等价

以下文件均来自本机安装的 OpenClaw 2026.3.23-2（`/opt/homebrew/lib/node_modules/openclaw/dist/`）。dist 文件名里带构建哈希，版本变了要重新核对。

- `update-cli-6OGXKQdy.js`（sha256 `17902f3d6c0aa378b651d0ff68b6cafd49cc22e5879cd0b1658c14b04c8bb23c`）第 725–741 行，`prepareRestartScript` 的 darwin 分支：`openclaw update` 装完后只执行 `launchctl kickstart -k 'gui/<uid>/<label>'`；任务没有注册时，先 enable、bootstrap 再 kickstart。label 由 `resolveLaunchdLabel` 决定：取 `OPENCLAW_LAUNCHD_LABEL`，或按 profile 推出，默认 `ai.openclaw.gateway`。
- `constants-BYFJPaZy.js`（sha256 `5f80816470ad919e916d765bbabbd4e55cd68dce232a8e96b11e2a7ebc4313e2`）第 2 行 `GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway"`，第 7 行 `NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node"`。升级流程不引用后者。
- `launchd-yOx8f787.js`（sha256 `14edc49f594468492f1c5df927a552b49a32114fe053b60841ebbd474fd490eb`）第 447–488 行 `restartLaunchAgent`：`openclaw gateway restart` 对已加载的任务同样是 `launchctl kickstart -k`。
- `docs/cli/node.md`：Node 服务由 `openclaw node restart` 管理。

HarnessHub 只对已加载、正在运行的任务执行 kickstart，不替产品 bootstrap 或 enable 已卸载的任务。profile 或改过的标签没有在配方里声明，这类任务归入“不随升级重启的常驻程序”，由用户自己重启。

## 存储与回退

- **业务库仍是 v12，不升版本。** 关闭原因新增了 `harness_upgrade`，但 `sqlite-store.ts` 从已部署构建 80a5246 起没有改动；它的 `parseStoredEvent` 只校验事件类型名、对象结构和大小，不校验 data 里的枚举值，所以已部署构建也能读回这个原因。`tests/integration/kept-process.test.ts` 经存储的解析器读回该原因来证明。
- **管理库从 v2 升到 v3，只改版本号。** 新的任务事实（`restartServices`、`closedConversations`、`clearedRecords`、`services`、`configurationChangedByService`）会被 v2 的严格解析器拒绝，所以升版本号，让旧构建明确拒绝打开，而不是读错。v2 的旧任务行在 v3 下照常读取。
- **旧的私有安装记录与 Node.js 升级：** ADR-017 之前的私有 npm 安装，记的是当时运行 HarnessHub 的 Node.js 路径。启动核对原来要求它与当前的完全相同，所以用户一升级 Node.js（nvm 或 Homebrew），HarnessHub 就起不来（2026-10-12 实际发生）。现在这类记录作为历史保留：不再用作后备入口，不再算作已安装，启动也不因它失败。其余损坏照旧报错。
- **手工降级到 v2：** 在没有 Gateway 持有数据目录时，执行 `sqlite3 <data>/management/management.sqlite < tools/management-v3-to-v2.sql`。
  - 它保留所有任务行，只去掉上面五个字段，再把 `user_version` 改回 2。
  - 丢失的只有这些结构化事实：同意重启的服务、每个服务的重启结果、关闭了几个空闲进程、清除了几条旧记录、重启后的服务是否改写了配置。任务日志里仍有对应的文字记录。
  - 测试 `the documented v3 to v2 downgrade keeps every job…`（`tests/integration/native-management.test.ts`）在副本上走完“v2→v3、写入带新字段的任务、执行降级、回到 v2 字段集合”，再由本构建重新打开为 v3。
  - 已部署构建的解析器能否打开降级后的副本，另做一次真实核对，结果见验收记录。

## Homebrew 升级读用户的本地记录（2026-10-17 更正）

- **原来的事实。** 这里的 Homebrew 检查（`brew info`）和升级都把 HOME 指到任务目录，升级还把 Homebrew 缓存放进任务目录。Homebrew 在那里找不到它的 API 数据，就重新下载，所以实际是按网上最新版检查和升级的，不是用户电脑上 Homebrew 的本地记录。
- **现在。** 按 [ADR-044](0044-macos-official-channels.md) 第六轮裁决，检查与升级都用用户真实的 HOME、`HOMEBREW_*` 设置和缓存，带 `HOMEBREW_NO_AUTO_UPDATE=1`、`HOMEBREW_NO_INSTALL_CLEANUP=1`、`HOMEBREW_NO_AUTOREMOVE=1`。检查在禁写、禁网的沙箱里读本地记录，升级仍在 Homebrew 自己的继承沙箱里运行，用户配置照旧不可写。
- **证据。** `tests/real/homebrew-native.real.ts` 在真实 Homebrew 下证明：以测试自己的家目录为 HOME 时，Homebrew 写的是那个家目录下的缓存，而 `~/.zshrc` 和 `~/.config` 仍然写不进去。

## 不做与未验证

- Linux：不读 systemd，常驻进程只归入“不随升级重启”，提示自行重启，没有真实验证。Windows：原生升级仍不支持。
- 产品自定义的就绪检查（例如 `openclaw health`）：只检查端口监听，不连接、不调用产品命令。
- 不替产品 bootstrap 或 enable 已卸载的服务，不运行 doctor，不迁移配置。
- 源码安装（Hermes、dsh、Pi 开发目录）仍不在 HarnessHub 里升级，“本机安装”里会说明请用它自己的更新方式。

## 验证

- 单元：解析 launchd、ps、lsof 输出，分类安装的使用方，重启判定（新进程、稳定 5 秒、崩溃循环、端口、已停止的服务、被拒绝的重启、取消）。
- 集成：同意后重启并记录；没有同意时在改动前停下；正在回复的对话、其他 HarnessHub 进程会阻止升级；清除旧记录；服务没有恢复；白名单沙箱拒绝写真实配置路径、拒绝连接本机监听端口；v3→v2 降级；保留进程因升级关闭。
- 集成（续）：运行环境要求不满足时，确认前给出要求与本机版本，执行时在改动前停下。
- 浏览器：确认框的内容、阻止项（包括 Node.js 不满足）、提交的同意与指纹；“没有升级”的显示和旧拒绝的解释；对话里的关闭说明。
- 真机：用临时 launchd 代理（`com.harnesshub.test.<uuid>`，用完卸载并删除）验证 kickstart、恢复判定和端口；对用户真实的 OpenClaw 安装只做只读检查和一次兼容校验预演。真实的 OpenClaw 升级由用户在 4317 自己点击；代理不重启用户的服务。
