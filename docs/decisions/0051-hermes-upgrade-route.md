# ADR-051：Hermes 的升级路线

状态：proposed，2026-10-22（只读研究的草案，供用户在 A/B 之间选择；没有代码改动）。事实见[Hermes v0.22.2 与 main 的升级就绪](../research/hermes-upgrade-readiness-2026-10-22.md)。依据 [ADR-031](0031-hermes-and-deepseek-harness.md)、[ADR-044](0044-macos-official-channels.md)、[ADR-048](0048-harness-scope-and-workbuddy.md) 决定 5。

## 背景

- 本机 Hermes 是 0.12.0（2026-05-06 的 main 检出 a0556b8，官方脚本安装）。HarnessHub 验证过的版本是 0.12.0（`src/infrastructure/management/verified-versions.ts:28`），能力矩阵 Hermes 列 27 格中 16 格有真实证据（`plan/native-capabilities.json` 的 `real`：13 格通过、1 格部分、2 格受阻；其余 6 格原接口不提供、5 格没有真实证据）。
- 0.12.0 的两个已知缺陷：ACP 审批桥永远拒绝（审批格受阻），审批期限硬编码 60 秒。上游在 v2026.5.16（0.14.0）修了前者、v2026.9.21（0.21.4）修了后者。
- 上游从 v0.21.6（2026-10-08）起改为语义版本的稳定发布线；**v0.22.2（10-15）是最后一个 `hermes acp` 仍在自己进程里跑模型的发布**；v0.22.3（10-21）与 main 把 `hermes acp` 改成网关的查看器：没有网关就自己起一个，有网关就附着，同一 home 上的旧版网关会被它停掉换新。
- `hermes update` 的落点：从 0.12.0 运行落到 main 顶端；从 v0.22.x 运行落到 stable 轨道头（今天是 v0.22.3）。两者都是网关投影。精确停在 v0.22.2 只能用 `install.sh --commit d923a5eb…`。
- HarnessHub 读 Hermes 版本的方式（venv 的 dist-info 名）在 v0.21.6 之后会读到 0.0.0。

## 选项

### A1：升级到 v0.22.2（钉住提交 d923a5eb），保持进程内模型

- **怎么升**：HarnessHub 只给终端命令（ADR-044 对 Hermes 的既定做法）：
  `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --commit d923a5eb487a17c0a68801bba9ef0f56c81040a8`，然后 `hermes config migrate`（或先 `hermes update --check` 看计划）。之后**不能**再运行 `hermes update`，否则会被带到 v0.22.3+。HarnessHub 在 Harness 页把这一点写成红字。
- **ADR-031 要修订的条目**：
  1. “已审查的 0.12 版本中审批最多等 60 秒”改为按版本：0.12.x 60 秒；≥0.21.4 取 `approvals.timeout`（默认 300 秒，HarnessHub 不提前关闭）。代码已按 0.12.x 门控（`src/adapters/control/hermes.ts:63`），只改说明。
  2. “0.12.0 审批桥缺陷提示”限定 0.12.x（代码已如此，`hermes.ts:69-70`），ADR 写明 0.14.0 起已修。
  3. 新增：接受 `allow_session`（会话内放行）作为第三种审批选项，`permissionNote` 说明它不写配置。
  4. 新增：`session/set_mode` 的三个编辑审批模式（default / accept_edits / dont_ask）作为 Hermes 的原生选项显示；todo 结果转成的 plan 更新按通用 ACP 计划处理。
  5. 工具失败：结构化失败已由 Hermes 报 `failed`，文本启发式（`TOOL_FAILURE`）保留为后备。
  6. 发现方式：版本改从检出的 git 标签或 `install-stamp.json` 读取（`packages.ts` 的 dist-info 方式对 0.0.0 失效），仍然只读文件；卸载白名单加 `~/.local/bin/hermes-acp`（启动器由谁写入待核实）。
  7. 能力读表（`src/adapters/capability-reads.ts:281`）：`verified` 区间改为 `>=0.22.2 <0.22.3`；MCP 接受 `url` 类条目；hooks 加 `~/.hermes/hooks/<名>/HOOK.yaml` 来源；技能加项目级目录与 `skills.create_dir` 的说明。
  8. 新增：检测到 ≥0.22.3 的 `hermes acp`（`initialize` 回报的版本）时拒绝建会话并说明原因——它会附着甚至替换用户的网关，与本 ADR 的“不触碰网关”相悖。
- **16 格复验**：全部重跑（ADR-031 的验收边界不变：只用文件与终端类工具、隔离工作区、审批不选“始终允许”）。估计 25～35 个回合；按 2026-10-11 的记录（每回合约 16k 输入 token，大部分命中缓存，走用户自己的 DeepSeek），费用 ¥3～5，上限仍是 ADR-031 的每轮 ¥10。审批格这次应该能从“受阻”变为通过。
- **迁移风险**：`config.yaml` 从版本 23 迁到 50（Hermes 自己迁，先备份到 `backups/config/`）；`state.db` 从 schema 11 到 31，**没有找到降级说明**，回退到 0.12.0 后能否读库未核实——所以升级前要用 `hermes backup`（或 `updates.pre_update_backup: full`）留一份；`plugins.enabled` 祖父化；网关会被重启一次（QQ 断开片刻）。
- **代价**：v0.22.2 是一个已被上游超过的点，之后每一次 `hermes update` 都会把用户带到网关投影；这条路线最多撑到用户想要 v0.22.3+ 的功能（提问、更多网关功能）为止，届时仍要做 A2。

### A2：升级到 stable 轨道头（v0.22.3+）或 main，并把 HermesControl 改成“网关视图”

- **怎么升**：`hermes update --yes`（0.12.0 的更新器落到 main；装完后 `hermes update --set-channel stable` 回到发布线，或接受 main）。
- **ADR-031 要修订的条目**：否决“只运行 `hermes acp`，不触碰用户的 Hermes 网关”。新的进程模型：HarnessHub 启动的 `hermes acp` 附着到用户的网关，回合在网关进程里执行；审批、取消、未知结果以网关的执行所有者为准；HarnessHub 要先核对网关在跑且版本与检出一致（否则 `hermes acp` 会替换它），并把“你的网关也在服务 QQ，HarnessHub 的回合会在同一进程里执行”写进确认与 Harness 页。`session/load`、`session/resume`、MCP 服务器（编辑器提供的 `mcpServers` 归网关会话）、`/model` 的语义都要按 `gateway_server.py` 重新验证；协议测试的替身要模拟网关投影。
- **复验**：16 格全部重跑，加上网关相关的新用例（网关不在、版本不一致、网关重启中、QQ 会话与 Hub 会话同在一个进程）；估计 40～60 个回合，¥5～10。真实验收必须在用户同意“HarnessHub 可以连接你的网关”之后进行，并且验收期间网关不能承担别的任务。
- **迁移风险**：同 A1，再加上网关投影的未知面（提问、取消、未知结果的语义只读了文件头）。
- **代价**：这是上游的方向，但工作量最大，而且改变了用户已经接受的边界。

### B：停在 0.12.0

- **怎么做**：什么都不改；Harness 页继续显示 `hermes update --yes` 的说明，但要加一句：运行它会把 Hermes 带到网关投影版本，HarnessHub 当前的接入在那之后不可用（第 8 条的检测无论如何都要做，否则用户一升级 HarnessHub 就会悄悄开始碰网关）。
- **ADR-031**：不改。
- **复验**：不需要。
- **代价**：审批格永远受阻、60 秒期限、没有 HTTP MCP、没有模式；上游不再给 0.12.x 任何修复；本机检出与上游的差距已经 5 个月、两套版本号。

## 推荐

**A1，附两个条件；B 作为过渡。** 理由：A1 能拿到审批修复、300 秒期限、HTTP MCP 与模式，同时不动“不触碰网关”这条用户已接受的边界，复验费用在既定上限内；A2 的前提（HarnessHub 可以进入用户的网关进程）是一个新的产品决定，应该在 A1 之后、用 v0.22.3+ 的一次只读研究加一次受控握手（临时 HERMES_HOME，ADR-041 的隔离规则）单独送审。条件：

1. 先实现第 8 条（≥0.22.3 拒绝建会话）与第 6 条（版本读取），再请用户运行钉住命令；这两条在 B 下也要做。
2. 用户运行钉住命令之前，HarnessHub 的 Harness 页列出：会重启网关、`config.yaml` 与 `state.db` 会被迁移且后者没有降级办法、先 `hermes backup`、之后不要运行 `hermes update`。

用户如果不想现在做 A1，就是 B，但第 8 条与第 6 条仍要进下一批。

## 不做

- 不由 HarnessHub 代为运行安装脚本或 `hermes update`（ADR-044：会交互提问、要装 git 与 Python 的脚本不代跑；`hermes update` 会重启网关）。
- 不为 0.12.0 修补上游缺陷。

## 验证（选定后）

- 协议测试：`hermes acp` 回报 0.22.2 时审批期限不提前关闭、`allow_session` 被接受、三个模式作为选项显示；回报 ≥0.22.3 时拒绝建会话并给出说明（无效样例）。
- 单元：版本从 git 标签或 `install-stamp.json` 读取，dist-info 为 0.0.0 时不采用；卸载白名单含 `hermes-acp`。
- 真实：16 格按 [接入记录](../verification/hermes-dsh-onboarding-2026-10-11.md)的命令表重跑，证据按仓库内格式入库；`VERIFIED_VERSIONS` 与矩阵在同一提交更新。
