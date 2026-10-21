# 真实验收操作手册

状态：2026-10-22 起使用。这是给主代理照着执行的手册，覆盖真实 Harness 验收（[测试与验收策略](testing.md#1-分层证据)第 1 节中“Real harness/provider”这一层）的前提、配置守护、证据头与记录格式、费用上限、每个焦点 Harness 的完整套件与冒烟套件，以及重验后的“配方提交”。守护与证据头的实现在 [tests/real/guard.ts](../../tests/real/guard.ts)，单元测试在 [tests/unit/real-guard.test.ts](../../tests/unit/real-guard.test.ts)（场景 G060-NC14、G060-NC15）。实际运行的结果写在 `docs/verification/` 的验收记录里，本手册不替代记录。平台只有 macOS（[ADR-044](../decisions/0044-macos-official-channels.md)）。

编写本手册的任务（第二批 C2）没有运行任何真实套件，也没有运行任何 Harness：套件改动只经过编译、边界检查与守护单元测试，第一次真实运行由主代理按本手册执行。

## 1. 前提

每一轮开始前逐条确认：

1. **代码与构建。** 在集成后的树上 `pnpm build`，之后都从仓库根目录运行 `node --test dist/tests/real/<套件>.real.js`（`pnpm test:real:*` 脚本同样可用，但它们会先再构建一次）。证据头记录 `git rev-parse HEAD`；工作树里有未提交的改动时，证据头写 `uncommittedChanges: true`，应先提交再跑。
2. **不碰正在运行的服务。** 不停止、不重启 4317；不运行 OpenClaw 网关或 Hermes 网关的任何命令；不读 4317 的 `data/`。
3. **干净环境与登录 shell 的 PATH。** 与 4317 用同样的 PATH，且不带沙箱或终端注入的代理变量。PATH 用登录 shell 读一次（会执行你的登录配置，与 [ADR-040](../decisions/0040-login-shell-search-directories.md) 的读法相同，只取标记之间的一行）：

   ```sh
   LOGIN_PATH="$(env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" LANG="$LANG" TMPDIR="$TMPDIR" "$SHELL" -l -c 'printf "\n__HH_PATH__%s__END__\n" "$PATH"' | sed -n 's/^__HH_PATH__\(.*\)__END__$/\1/p')"
   RUN() { env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" TERM=dumb LANG="$LANG" TMPDIR="$TMPDIR" PATH="$LOGIN_PATH" \
     HH_REAL_TMP="$HOME/.cache/harnesshub-acceptance" "$@"; }
   mkdir -p -m 700 "$HOME/.cache/harnesshub-acceptance"
   ```

   - 工具的每次调用都是新的 shell：把算好的值写进 `$HOME/.cache/harnesshub-acceptance/env.sh`（`LOGIN_PATH='…'` 与 `RUN` 的定义，0600），之后每条命令先 `. "$HOME/.cache/harnesshub-acceptance/env.sh"`，不必每次重新执行登录配置。
   - `HH_REAL_TMP` 必须指向家目录下的普通目录：Hermes 拒绝写 `/private/var`，macOS 的临时目录正在那里（见 [Hermes 与 dsh 接入记录](../verification/hermes-dsh-onboarding-2026-10-11.md)）。
   - 主代理在 Claude Code 里执行时，这些命令要在沙箱外运行：真实 Harness 要联网，也要写它自己的会话与日志目录。`env -i` 同时去掉沙箱注入的代理变量。
   - 只读核对当前会运行哪一份程序：`which -a claude`（以及 dsh、codex 等）。不用 `--version`：版本以证据头为准。
4. **安装策略只认官网渠道。** 不设 `HH_REAL_MANIFEST`（它会把策略变成 any，只用于开发与测试）。证据头的 `policy` 必须是 `official`，每个 Harness 的 `controls[].entry` 都不能是 `custom-entry`。
5. **审批只“允许一次”。** 套件只选一次性的允许选项，例如 `native-activity` 选第一个 id 以 allow、accept、approve、once、yes 或 proceed 开头、且 id 与名称都不含 always、session、forever、remember 的选项；找不到就判失败，不会退而选“始终允许”。手工操作时同样不选“始终允许”（Claude 的 allow_always 会由原程序写进项目设置）。
6. **dsh：** 不注入 `DSH_PERMISSION_MODE`；不读 dsh 的会话日志，不用 `--dump-config`（需要时另行裁决）。
7. **OpenClaw：** 工具在用户真实的 OpenClaw 工作区里执行，`native-activity` 一律加 `HH_REAL_READONLY=1`，只运行一次 echo。
8. **失败不重跑。** 每个套件的结果按记录如实写，不为凑通过而换设置重跑；单回合超过 150k token 或 5 分钟即停止并报告（[ADR-031](../decisions/0031-hermes-and-deepseek-harness.md)）。
9. **凭据。** 不读、不打印任何凭据文件。守护拒绝读取它们（见 2.4），证据里也不会出现。

## 2. 配置守护

守护证明真实运行前后用户自己的 Harness 配置一字未改。快照只记录摘要、目录条目名与链接目标，路径以 `~` 书写（家目录以外的位置照原样），从不记录文件内容。

### 2.1 整轮前后

整轮开始前拍一次快照，全部套件结束后再拍一次并比较：

```sh
EVIDENCE="$HOME/.cache/harnesshub-acceptance/evidence/$(date +%F)"; mkdir -p -m 700 "$EVIDENCE"
RUN node dist/tests/real/guard.js snapshot claude,codex,opencode,openclaw,hermes,dsh "$EVIDENCE/guard-before.json"
# …本轮的套件…
RUN node dist/tests/real/guard.js snapshot claude,codex,opencode,openclaw,hermes,dsh "$EVIDENCE/guard-after.json"
RUN node dist/tests/real/guard.js compare "$EVIDENCE/guard-before.json" "$EVIDENCE/guard-after.json"
```

只验一家时可以只列那一家（例如 `snapshot dsh`），共享清单总会包含在内。前后两次必须列同样的 Harness，否则比较按参数错误处理。

| 退出码 | 含义 | 处理 |
|---|---|---|
| 0 | 快照已写出；比较时完全相同 | 继续 |
| 1 | 比较发现改动，逐行列出 `~` 路径 | 立即停止，报告路径；不要自行恢复或“修好”，交给用户决定 |
| 64 | 参数错误：未知命令、未知 Harness、参数个数不对、两份快照列的 Harness 不同 | 改命令后重来 |
| 65 | 快照文件读不了或格式不对（只说明哪个字段，不回显内容） | 检查文件 |
| 70 | 快照失败：凭据位置（`CREDENTIAL_PATH`，例如某个配置文件是指向凭据的链接）、读不了（`UNREADABLE`）、`~/.claude.json` 不是合法 JSON（`UNPARSABLE`）等 | 停止并报告 |
| 73 | 输出文件已存在：快照从不覆盖已有文件 | 换文件名；不要删掉轮前快照 |

快照文件是 0600，只含摘要，放在证据目录里，不入库。

### 2.2 套件内

每个真实套件都 import `tests/real/guard.ts` 并各自核对：

- 13 个 `native-*` 套件：对每个 Harness，在组合应用之前拍它的清单（加共享清单），回合结束、应用关闭之后再拍一次比较；证据的每条结果带 `guard: { unchanged, changed, failure? }`，有改动时该 Harness 判失败，错误信息只含 `~` 路径。`HH_REAL_HARNESSES` 里每个 Harness 都必须有守护清单，否则套件在运行任何东西之前失败。`native-catalog` 对全部 Harness 拍一次，证据顶层多一个 `guard`。
- 其余 10 个套件（`claude-mcp`、`openclaw-skill-switch`、Provider、切换、安装、流、会话与 Homebrew 套件）在私有家目录或临时数据里运行；它们在测试开始时拍下用户真实配置的快照，在测试自己的清理之后核对，配置被改即测试失败。它们组合的 Harness：`claude-mcp` 为 claude，`openclaw-skill-switch` 为 openclaw，`provider-switch`、`codex-local-provider`、`codex-session`、`live-web-stream`、`managed-install` 为 codex，`gemini-provider` 为 gemini，`harness-provider-switch` 为 codex 与 gemini，`homebrew-native` 只有共享清单。设了 `HH_REAL_EVIDENCE` 时它们写出 `{ header, results: [{ test, harnesses, outcome, guard }] }`，不设时照旧可运行。

### 2.3 守护清单

由 `guardedFiles()` 按与能力读表相同的环境变量解析；表中路径是变量都未设置时的默认位置。

| 清单 | 文件 | 目录快照 | 变量 |
|---|---|---|---|
| claude | `~/.claude/settings.json`、`~/.claude/settings.local.json`、`~/.claude.json`（只比较 `mcpServers`，见下）、`~/.claude/CLAUDE.md` | — | `CLAUDE_CONFIG_DIR`（设置后 `.claude.json` 在它下面，`~/.claude.json` 仍然守护） |
| codex | `~/.codex/config.toml`、`~/.codex/AGENTS.md`、`~/.codex/AGENTS.override.md` | — | `CODEX_HOME` |
| opencode | `~/.config/opencode/opencode.json`、`opencode.jsonc`、`AGENTS.md` | — | `OPENCODE_CONFIG_DIR`，否则 `XDG_CONFIG_HOME` |
| openclaw | `~/.openclaw/openclaw.json`、`~/.openclaw/workspace/AGENTS.md` | `~/.openclaw/skills` | `OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`、`OPENCLAW_PROFILE`；工作区按能力页的读法从 openclaw.json 解析 |
| hermes | `~/.hermes/config.yaml`、`~/.hermes/SOUL.md` | `~/.hermes/skills`、`~/.agents/skills` | `HERMES_HOME`，否则 `~/.hermes/active_profile` 指定的 profile |
| dsh | `~/.dsh/settings.yaml`、`settings.yaml.imported`、`cordis.patch.yml`、`profiles/acp/cordis.patch.yml`、`profiles/acp/package.json`、`AGENTS.md` | — | `DSH_HOME` |
| cursor | `~/.cursor/cli-config.json` | — | — |
| gemini | `~/.gemini/settings.json` | — | `GEMINI_CLI_HOME` |
| pi | `~/.pi/agent/settings.json`、`models.json` | — | `PI_CODING_AGENT_DIR` |
| 共享（每次都包含） | `~/.zshrc`、`~/.zprofile`、`~/.bashrc`、`~/.bash_profile`、`~/.profile`、`~/.npmrc` | `~/.agents/skills` | — |

- **`~/.claude.json` 只比较 `mcpServers`。** 每个运行中的 Claude Code 会话都会按内存副本整份改写这个文件（计数、projects、缓存），主代理自己也是 Claude Code。按整份摘要比较，任何一轮都会判为已改动。因此只比较用户级 `mcpServers` 子树的规范化摘要，与 [ADR-045](../decisions/0045-unified-capability-management.md)“只比对目标子树”的理由相同。其余键（例如 `projects` 里多出的验收工作区条目）不在守护范围内。
- **目录快照**只记顶层条目的名称、类型（文件、目录、链接、其他）与链接目标，以及链接数；不进入子目录，不读内容。Finder 的 `.DS_Store` 不计。
- **不在守护范围内的：** 会话、转录、日志、缓存、遥测、备份目录（运行 Harness 时它们本来就会写这些）；技能目录里的内容；Hermes 的 `active_profile` 本身（只用来定位 Hermes 的家目录）。
- 配置文件本身是符号链接时，快照记链接目标，并比较它指向的内容；文件被替换成指向同样内容的链接，或链接改指别处，都算改动。

### 2.4 凭据拒绝

以下位置不进入任何清单，也不会被读取：

- 文件：`~/.hermes/.env`、`~/.hermes/auth.json`、`~/.dsh/.credentials.yaml`、`~/.codex/auth.json`、`~/.claude/.credentials.json`、`~/.local/share/opencode/auth.json`、`~/.gemini/oauth_creds.json`、`~/.pi/agent/auth.json`、`~/.netrc`。按变量移动的同名位置（`$HERMES_HOME/.env`、`$DSH_HOME/.credentials.yaml`、`$CODEX_HOME/auth.json` 等）同样拒绝，默认位置在变量设置后也仍然拒绝。
- 整个目录：钥匙串（`~/Library/Keychains`、`/Library/Keychains`）、`~/.ssh`、`~/.gnupg`、`~/.cc-switch`、OpenClaw 的 `credentials` 目录。
- 任何位置上名为 `auth.json`、`.env`（及 `.env.*`）、`.credentials.json`、`.credentials.yaml`、`credentials`、`credentials.json`、`oauth_creds.json`、`.netrc`、`.git-credentials`、`device-id` 的文件。比较不区分大小写，与 macOS 文件系统一致。

执行方式：清单只能经 `guardedPath()` 生成，它对凭据位置抛出 `CREDENTIAL_PATH`；拍快照时打开任何文件之前再核对一次，手工拼出的条目也挡得住；指向凭据的链接按凭据拒绝；目录快照里凭据名的条目不列出。单元测试证明：凭据文件存在时既不出现在快照里，也不被读取；把它们塞进清单会抛出明确错误；去掉拒绝逻辑的变异会使测试失败。

### 2.5 与产品“用户配置”定义的关系

[`protectedConfigurationPaths`](../../src/infrastructure/management/native.ts) 是产品侧对用户配置的定义，ADR-043/044 的包管理器沙箱在升级、安装时禁止写入这些位置：

- 目录：`~/.codex`、`~/.claude`、`~/.openclaw`、`~/.gemini`、`~/.pi`、`~/.cursor`、`~/.config`、`~/.local/share/opencode`，以及 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`OPENCLAW_STATE_DIR`、`PI_CODING_AGENT_DIR` 指向的目录；
- 文件：`~/.claude.json`、`~/.zshrc`、`~/.zprofile`、`~/.bashrc`、`~/.bash_profile`、`~/.profile`、`~/.npmrc`，以及 `OPENCLAW_CONFIG_PATH`。

两者分工不同：沙箱在包管理器运行期间预防写入，守护在真实回合之后检查有没有写入。守护覆盖保护表列出的全部文件，单元测试在默认环境和设置了变量的环境下都核对这一点，保护表增加文件时测试失败。保护表的目录守护只覆盖其中的配置文件，因为真实回合本来就会在这些目录里写会话、日志和缓存，整目录比较必然判为改动。守护还覆盖保护表没有的 Hermes、dsh 与 `~/.agents/skills`；第一轮评估指出升级沙箱的保护表缺这几处，那是另一项任务（T-AUD-06）。

## 3. 证据

### 3.1 证据头

每份证据的顶层有 `header`，由 `evidenceHeader()` 从组合应用的发现结果读出，与 Harness 页的读法相同（`inventory`、`installationViews`、`management.views`），不启动任何程序：

| 字段 | 内容 |
|---|---|
| `recordedAt` | 记录时间 |
| `commit`、`commitNote`、`uncommittedChanges` | `git rev-parse HEAD`；读不到时为 `unknown`，`commitNote` 说明原因；工作树有未提交改动时也写在 `commitNote` 里 |
| `policy` | `official` 或 `any`（ADR-044） |
| `platform` | `macOS`；在别的平台上拒绝写证据头 |
| `harnesses[].installations` | 每份安装：`ref`（摘要，不是路径）、`channel`、`label`（例如“npm 全局（nvm v26.11.1）”）、`command`、`version`、`role`（product 或 adapter）、`active`（每种角色中 HarnessHub 会运行的那一份） |
| `harnesses[].controls` | 能运行的控制入口及来源：`path`、`standard-directory`、`custom-entry`（发现清单）、`package-root`、`managed` |
| `harnesses[].source`、`entryVersion` | `system`、`managed` 或 `missing`；入口自己的版本（Claude 是适配器 claude-agent-acp 的版本） |
| `harnesses[].programVersion`、`programVersionFrom` | 产品版本。管理视图能直接给出时为 `management`；经适配器接入的产品（Claude）只有运行 `--version` 才能读到，证据头不运行它，改取当前使用的产品安装的渠道记录，写 `installation` |
| `harnesses[].verification` | ADR-038 对这组版本的判定：`verified` 或 `unverified`，附已验证的版本 |

dsh 的 ACP 自报版本恒为 0.0.1，所以版本一律以证据头的 `installations` 与 `programVersion` 为准，不看 `native-catalog` 证据里的 `agent.version`。

### 3.2 落点

- 套件的 JSON 证据写到 `$HOME/.cache/harnesshub-acceptance/evidence/<日期>/<harness>-<套件>.json`（`HH_REAL_EVIDENCE`，0600），轮前、轮后快照也放在这里。它们不入库，也不复制进仓库。
- 仓库内写一份验收记录 `docs/verification/<主题>-<日期>.md`（例如 dsh 重验写成 `dsh-rc2-reverification-<日期>.md`），按 3.3 的模板写，并脱敏：只写形状、计数、判据与 `~` 路径，不贴转录、工具输出或配置内容。
- 能力矩阵（`plan/native-capabilities.json` 的 `evidence`）至少引用这份仓库内记录；`.tmp/` 的文件只作补充，不能单独作为证据（第一轮评估发现 72 个 `.tmp` 证据全部丢失）。

### 3.3 记录模板

模板只用代码跨度写路径；在记录里改成实际文件的链接。

```markdown
# <Harness> <版本> 真实重验（<日期>）

逐项状态以能力矩阵（`docs/verification/native-capability-matrix.md`）为准；按真实验收操作手册（`docs/engineering/real-acceptance.md`）运行。

## 环境与证据头
- commit：<header.commit>（uncommittedChanges：<false>）
- 安装策略：<official>；平台：macOS <系统版本>
- 安装（照抄证据头 installations）：<command> <version>，<label>，<role>，<active>
- 入口：<controls[].id>（<entry>）
- 版本：产品 <programVersion>（来自 <programVersionFrom>）；入口 <entryVersion>；ADR-038 判定 <verification.state>（已验证 <program>/<adapter>）
- 环境：env -i，登录 shell 的 PATH，HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance，未设 HH_REAL_MANIFEST

## 守护
- 整轮：guard-before.json 与 guard-after.json 比较，退出码 <0>；改动的路径：<无>
- 套件内：<每个套件的 guard.unchanged；改动时列出 ~ 路径>

## 命令与结果
| 套件 | 变量 | 判据逐项 | 证据文件 |
|---|---|---|---|
| native-resume | HH_REAL_HARNESSES=<id> | completed；sourceRunIds 为空；答对标记；回放未混入；cleanup closed | `~/.cache/harnesshub-acceptance/evidence/<日期>/<id>-native-resume.json` |

## 续接命令（人工）
- 形式：<一次性命令，ID 用 <id> 代替>；退出码 <0>；输出形状：<只有答案一行 / 另有横幅 / JSON>；答对标记：<是>

## 费用
- 提示 <n> 次；token（证据 usage）<…>；估计 <金额>；本轮上限 <…>

## 局限与未验证
- <受阻的格与原因；没有运行的套件与原因>

## 配方提交
- <commit>：VERIFIED_VERSIONS、矩阵安装说明、目录包版本；versionConsistency 为空
```

## 4. 费用上限

| Harness | 本轮上限 | 依据 |
|---|---|---|
| 任一 Harness | 每轮完整验收 ≤ ¥10（硬上限）；单回合 > 150k token 或 > 5 分钟即停 | [ADR-031](../decisions/0031-hermes-and-deepseek-harness.md) |
| DeepSeek Harness | ≤ ¥3 | 审批（决定 4） |
| Claude Code | ≤ 25 次提示，以 Haiku 为主，1 次压缩；周额度不足即停止并记录，不换账号 | 审批（决定 3） |
| Hermes Agent | ≤ ¥3 | 审批 |
| OpenClaw | ≤ ¥3 | 审批 |
| Codex | 用户点击升级之后复验 ≤ 20 次提示 | 审批 |
| OpenCode | 可选的 `/compact` 核对 ≤ 5 次提示 | 审批 |

“提示”按套件发出的消息计：原生命令（`/compact`、`/model …`）各算一次，回答原生提问不另算；`claude-mcp`、`openclaw-skill-switch` 与 Provider、切换、流、会话、安装套件不调用真实模型（本地确定性 Provider 或原程序自己的配置命令），不计费。

## 5. 套件一览

命令都在 `pnpm build` 之后从仓库根目录、用 1 节的 `RUN` 运行，例如 `RUN HH_REAL_HARNESSES=dsh HH_REAL_EVIDENCE="$EVIDENCE/dsh-native-resume.json" node --test dist/tests/real/native-resume.real.js`。`native-*` 套件都要求 `HH_REAL_HARNESSES` 与 `HH_REAL_EVIDENCE`；除 `native-catalog` 与 `native-import` 外都接受 `HH_REAL_MODEL_<ID>`（大写 Harness id）选会话模型。格用 `plan/native-capabilities.json` 的能力 id。

| 套件 | 其他变量 | 每个 Harness 的提示 | 主要对应的格 |
|---|---|---|---|
| `native-catalog` | — | 0 | models、commands、modes-settings 的目录部分（只是发现证据，不算能力通过）；证据带模型 id 与设置取值 id，供下面的配方选值 |
| `native-resume` | — | 2 | resume，models |
| `native-thinking` | `HH_REAL_OPTIONS_<ID>`（可选） | 1 | thinking |
| `native-activity` | `HH_REAL_APPROVAL=1`、`HH_REAL_OPTIONS_<ID>`、`HH_REAL_PLAN=1`、`HH_REAL_READONLY=1`（都可选） | 1 | tool-status、tool-detail、usage；approvals（APPROVAL）；plan（PLAN）；modes-settings（OPTIONS） |
| `native-attachments` | — | 2（未声明图片的 Harness 在派发前拒绝图片，记 1） | input-file、input-image |
| `native-commands` | `HH_REAL_FILL=n`（可选） | 3–4（首轮、`/compact`、压缩后、`/export`），目录里没有的命令不发 | compaction、export、commands |
| `native-config` | `HH_REAL_CONFIG_OPTION`、`_FROM`、`_TO`、`_COMMAND` | 4 | config-sync；model 时也是 models |
| `native-options` | `HH_REAL_OPTIONS_<ID>`、`HH_REAL_EXPECT_UNCHANGED=1`、`HH_REAL_COMMAND`、`HH_REAL_COMMAND_FILE` | 1–2 | modes-settings、thought-level、commands |
| `native-question` | — | 1 | questions |
| `native-subagent` | — | 1 | subagents |
| `native-extensions` | — | 0–1（工作区技能能经命令调用时 1） | skills、plugins、mcp 的列表 |
| `native-import` | — | 2（原程序自己建会话 1，接续后 1） | session-list |
| `native-branch` | — | 4 | fork |
| `claude-mcp` | `HH_REAL_EVIDENCE`（可选） | 0 | Claude 的 mcp 能力写入：私有家目录、禁网沙箱里 `claude mcp add-json/remove` 往返 |
| `openclaw-skill-switch` | `HH_REAL_EVIDENCE`（可选） | 0 | OpenClaw 的 skills 开关：私有家目录、禁网沙箱里 `openclaw config set/unset` 往返 |
| `provider-switch`、`codex-local-provider`、`codex-session`、`live-web-stream`、`managed-install`、`gemini-provider`、`harness-provider-switch` | `HH_REAL_EVIDENCE`（可选） | 0（本地确定性 Provider） | Provider、切换、流与私有安装（G060-P*、G060-M01、G060-S01） |
| `homebrew-native` | `HH_REAL_EVIDENCE`（可选） | 0 | 原 Homebrew 的沙箱保护（G060-N04） |

## 6. 各焦点 Harness 的完整套件与冒烟套件

### 6.1 冒烟套件（决定 3）

决定 3：检测到新版本后做一次约 10 次提示的冒烟，通过即扩展已验证区间。五项：

1. **目录**：`native-catalog`。
2. **原生恢复**：`native-resume`。
3. **审批**：`native-activity` 加 `HH_REAL_APPROVAL=1`（各家的写法见下）。
4. **续接命令**：人工在终端运行详情栏给出的一次性命令并答出标记，记录输出形状（第 7 节）。
5. **一项能力生效核对**：有套件的用私有家目录往返（Claude 用 `claude-mcp`，OpenClaw 用 `openclaw-skill-switch`）。其余几家目前没有这类套件，写“暂无套件”，或者按 [ADR-045](../decisions/0045-unified-capability-management.md) 在页面上做一次往返（主代理代为确认，逐字节恢复），作为人工项记录。

| 项 | Claude Code | DeepSeek Harness | Codex | OpenCode | Hermes Agent | OpenClaw |
|---|---|---|---|---|---|---|
| 审批 | `HH_REAL_APPROVAL=1 HH_REAL_OPTIONS_CLAUDE='{"mode":"default"}'` | 不设 APPROVAL，看证据 `permissions`（见 6.3） | `HH_REAL_APPROVAL=1 HH_REAL_OPTIONS_CODEX='{"approval_policy":"on-request","sandbox":"read-only"}'` | `HH_REAL_APPROVAL=1`（套件在工作区写 opencode.json 要求编辑与命令询问） | 0.12.0 受阻于上游缺陷，跑 `native-activity` 记录 Hub 的提示 | 不适用（Hub 未接出 OpenClaw 审批）；`native-activity` 只用 `HH_REAL_READONLY=1` |
| 续接命令 | `claude -p --resume <id> "…"` | `dsh headless --session-id <id> "…"` | `codex exec --skip-git-repo-check resume <id> "…"` | `opencode run -s <id> "…"` | `hermes chat --resume <id> -q "…"` | 不显示（会话在 OpenClaw Gateway 里，ADR-039） |
| 能力核对 | `claude-mcp` | 暂无套件 | 暂无套件 | 暂无套件 | 暂无套件 | `openclaw-skill-switch` |
| 提示 | 约 5 | 约 5 | 约 5 | 约 5 | 约 5 | 约 3 |

### 6.2 Claude Code（配方：2.1.306 重验，扩区间到 [2.1.296, 2.1.306]）

前置：`which -a claude` 第一个是 nvm 的 2.1.306；`native-catalog` 证据头里产品 `claude` 2.1.306（`active`）、适配器 `claude-agent-acp` 的版本（先核实是 0.89.1，再决定适配器区间）。所有套件都加 `HH_REAL_HARNESSES=claude`；除另行说明外加 `HH_REAL_MODEL_CLAUDE=<haiku id>`，取自 `native-catalog` 证据的 `catalog.modelIds`（2.1.296 时是 `haiku`；不在目录里时 `native-resume` 会在发送前失败，不花提示）。

| # | 套件 | 变量 | 提示 | 格 |
|---|---|---|---|---|
| 1 | `native-catalog` | 不设 MODEL | 0 | models、commands、modes-settings（目录） |
| 2 | `native-resume` | — | 2 | resume、models |
| 3 | `native-activity` | `HH_REAL_APPROVAL=1`、`HH_REAL_OPTIONS_CLAUDE='{"mode":"default"}'`（mode 的 id 与取值以目录证据为准） | 1 | tool-status、tool-detail、usage、approvals、modes-settings |
| 4 | `native-commands` | — | 4（含 1 次压缩；`/export` 由 Hub 复制转录） | compaction、export、commands |
| 5 | `native-config` | `HH_REAL_CONFIG_OPTION=model`、`HH_REAL_CONFIG_FROM=<haiku id>`、`HH_REAL_CONFIG_TO=<sonnet id>`、`HH_REAL_CONFIG_COMMAND="/model <sonnet id>"` | 4 | config-sync、models |
| 6 | `native-attachments` | — | 2 | input-file、input-image |
| 7 | `native-import` | 不接受 MODEL：原程序自己用 `claude -p` 建会话，接续后的回合也用 Claude 的默认模型 | 2 | session-list |
| 8 | `native-branch` | — | 4 | fork |
| 9 | `native-question` | — | 1 | questions |
| 10 | `native-subagent` | — | 1 | subagents |
| 11 | `native-extensions` | — | 1 | skills、plugins、mcp（列表） |
| 12 | `claude-mcp` | — | 0 | mcp（写入往返，需在 2.1.306 上复验） |

合计约 22 次提示。可选：`native-options` 加 `HH_REAL_OPTIONS_CLAUDE='{"effort":"low"}'`，所选模型的目录要有 effort（1 次，复验 thought-level）。

不跑：`native-thinking`（新模型默认 `thinking.display=omitted`，只发送没有文本的签名块，矩阵记为受阻）；`HH_REAL_PLAN`（会话里没有 TodoWrite 类计划工具，受阻）。不适用：音频输入、回滚（原接口不提供）。另记录 Claude 登录状态在页面上的显示（已登录或未说明，B6 的后续）。冒烟只跑 1、2、3、续接命令与 12。

### 6.3 DeepSeek Harness（配方：0.2.0-rc.2 精确基线，≤ ¥3）

前置：证据头里 dsh 为 npm 官网渠道 0.2.0-rc.2（`active`），`programVersion` 来自 management；入口 `dsh-native` 的来源是 `path` 或 `standard-directory`，不是 `custom-entry`。所有套件加 `HH_REAL_HARNESSES=dsh`。

| # | 套件 | 变量 | 提示 | 格 |
|---|---|---|---|---|
| 1 | `native-catalog` | — | 0 | models、thought-level（目录）；证据的 `modelIds` 供第 7 步选模型 |
| 2 | `native-resume` | 不设 MODEL，用 dsh 自己的默认模型 | 2 | resume、models、usage |
| 3 | `native-thinking` | 不设 OPTIONS（2026-10-11 的通过记录同样没有设置） | 1 | thinking |
| 4 | `native-activity` | 不设 `HH_REAL_APPROVAL` | 1 | tool-status、tool-detail、usage；approvals 看证据的 `permissions` |
| 5 | `native-attachments` | — | 1（dsh 没有声明图片，图片应在派发前被拒绝） | input-file、input-image |
| 6 | `native-import` | 由 dsh 自己的 ACP 入口建会话 | 2 | session-list（只能恢复：如实报告没有历史，答案须来自原生会话） |
| 7 | `native-options` | `HH_REAL_OPTIONS_DSH='{"reasoning_effort":"low"}'`；可选 `HH_REAL_MODEL_DSH=<catalog.modelIds 里的 id>`，不要沿用 alpha 时期的 id 形状 | 1 | thought-level、models |
| 8 | `native-branch` | — | 4 | fork（dsh 不能原生分支，回退到公共历史并检查隔离） |

合计约 12 次提示。不适用：commands、config-sync（dsh 不提供原生命令）、questions、modes-settings。没有列入：`native-subagent`、`native-extensions`（子 Agent 与技能尚未接出）。

审批：dsh 0.2.0-rc.2 按 profile 分开保存设置，dsh-base 默认 workspace-write 加询问，2026-10-11“预设为 danger-full-access 受阻”的结论很可能已经失效。套件不为 dsh 写工作区审批文件（它没有这样的文件），dsh 也没有会话级审批选项，所以不设 `HH_REAL_APPROVAL`：设了会在发送前失败。`native-activity` 照常对 dsh 发出的每个审批“允许一次”并记在 `permissions` 里。矩阵的 approvals 格按观察更新说明；T-HB-06 未做时仍记为受阻，并写明观察到了什么。

冒烟：1、2、4，续接命令 `dsh headless --session-id <id> "…"`（dsh 没有交互形式），能力核对写“暂无套件”。

### 6.4 Codex（用户点击升级后复验，≤ 20 次提示）

`HH_REAL_HARNESSES=codex`。完整套件：`native-catalog`；`native-resume`；`native-activity` 加 `HH_REAL_APPROVAL=1 HH_REAL_OPTIONS_CODEX='{"approval_policy":"on-request","sandbox":"read-only"}'`（本机原配置 `approval_policy=never`，不覆盖就不会请求审批）；计划另跑一次 `native-activity` 加 `HH_REAL_PLAN=1`（矩阵受阻，按观察记录）；`native-attachments`；`native-commands`（`/compact`、`/export`）；`native-import`；`native-branch`；`native-subagent`；`native-extensions`；`native-options`（审批策略与沙箱的回报）。思考输出（每轮的 summary 未下发）与原生提问（requestUserInput）没有真实证据，`native-thinking`、`native-question` 作为可选项，结果如实记录。不调用模型的套件：`codex-local-provider`、`codex-session`、`provider-switch`、`live-web-stream`、`managed-install`（从 npm 下载私有版本）。冒烟见 6.1。

### 6.5 OpenCode

`HH_REAL_HARNESSES=opencode`。完整套件：`native-catalog`；`native-resume`；`native-thinking`；`native-activity` 加 `HH_REAL_APPROVAL=1`；`native-attachments` 加 `HH_REAL_MODEL_OPENCODE=<有视觉能力的模型 id>`；`native-commands`（1.18.35 隐藏的 `/compact`，可选核对 ≤ 5 次提示）；`native-options` 分两次：`HH_REAL_OPTIONS_OPENCODE='{"mode":"plan"}' HH_REAL_EXPECT_UNCHANGED=1`，以及 `HH_REAL_COMMAND=/init HH_REAL_COMMAND_FILE=AGENTS.md`（默认模式，单独一次）；`native-import`；`native-branch`；`native-extensions`。不适用或未接出：questions（`OPENCODE_CLIENT=acp` 下提问工具不启用）、config-sync、subagents。冒烟见 6.1。

### 6.6 Hermes Agent（停在 0.12.0，≤ ¥3）

`HH_REAL_HARNESSES=hermes`。边界（[ADR-031](../decisions/0031-hermes-and-deepseek-harness.md)）：只用文件与终端类工具做无害任务，不触发浏览器、`process`、记忆、`skill_manage` 与网页搜索；`delegate_task` 只在子 Agent 验收中用一次；只运行 `hermes acp`，不碰 Hermes 网关。完整套件：`native-catalog`；`native-resume`；`native-thinking`；`native-activity`（审批是 0.12.0 的上游缺陷，Hub 会提示“没有向 HarnessHub 请求审批”，记录为受阻）；`native-attachments`（本机模型看不到图片，图片一项按受阻记录）；`native-commands`（`/compact`）；`native-config` 加 `HH_REAL_CONFIG_OPTION=model HH_REAL_CONFIG_FROM=<目录里的模型 id> HH_REAL_CONFIG_TO=<另一个模型 id> HH_REAL_CONFIG_COMMAND="/model <TO 的模型名>"`（2026-10-11 用的是 deepseek-v4-pro 与 deepseek-v4-flash）；`native-import`；`native-branch`；`native-subagent`。升级路线由 ADR-0051（第二批 C6）交给用户决定，在此之前不重验。冒烟见 6.1。

### 6.7 OpenClaw（停在 2026.3.23-2，≤ ¥3）

`HH_REAL_HARNESSES=openclaw`，回合经用户自己的 OpenClaw Gateway 执行：不重启、不改它的配置。完整套件：`native-catalog`；`native-resume`；`native-activity` 加 `HH_REAL_READONLY=1`（必须）；`native-attachments`；`native-commands`（`/compact`；目录里没有导出命令）；`native-config` 加 `HH_REAL_CONFIG_OPTION=thought_level HH_REAL_CONFIG_FROM=low HH_REAL_CONFIG_TO=high HH_REAL_CONFIG_COMMAND="/think high"`；`native-extensions`；`native-thinking`（部分）；`openclaw-skill-switch`。不适用：fork、questions；未接出：session-list、subagents、approvals。升级前后的复验按 ADR-0052（第二批 C6）与 T-OC-08/12。冒烟见 6.1。

### 6.8 WorkBuddy 与冻结的三个

- **WorkBuddy** 尚未接入（[ADR-048](../decisions/0048-harness-scope-and-workbuddy.md) 决定 2：路线 B，M4 先只读研究与一次受控的 ACP 握手），没有套件，守护也没有它的清单：任何套件对 workbuddy 都会在运行前失败。接入时先补守护清单（`~/.workbuddy` 下的配置文件；device-id 等身份与凭据文件按 2.4 拒绝）。
- **Cursor、Gemini CLI、Pi** 已冻结（决定 1）：不再重验，也不更新已验证版本。守护清单与套件保留，Provider 与切换套件仍然用到 Gemini。

## 7. 续接命令（人工）

[ADR-039](../decisions/0039-continue-in-the-original-program.md) 的命令只在版本已验证时出现在详情栏里。重验期间版本还没扩展，详情栏只给原生会话 ID，命令按 6.1 表里的一次性形式手工拼。

1. 启动一个私有实例（官网策略、临时数据、自己的租约目录），打开它打印的一次性链接，链接不外传：

   ```sh
   WEB="$HOME/.cache/harnesshub-acceptance/web-$(date +%s)"; mkdir -p -m 700 "$WEB/workspace"
   RUN node dist/src/cli/web.js --cwd "$WEB/workspace" --data-dir "$WEB/data" --workspace-lock-root "$WEB/locks" --port 0 --no-login-shell
   ```

2. 新建与该 Harness 的对话，发送“请记住标记 R-<随机数>。只回复“好的”，不要调用任何工具。”（1 次提示）。
3. 打开对话的详情栏取原生会话 ID 或命令。
4. 在 `$WEB/workspace` 里用同样的干净环境运行一次性形式，问题写“我让你记住的标记是什么？只回复标记本身。”（1 次提示）。不要用交互形式：它会询问是否信任目录，接受后会写入 `~/.claude.json`、`~/.codex/config.toml` 等全局配置，守护会判为改动。
5. 记录退出码、标准输出的形状（只有答案一行、另有横幅或提示、JSON），以及是否答对标记；不贴回复全文。
6. 按 Ctrl+C 停止实例（它等在途执行清理完），然后删除 `$WEB`。

## 8. 重验后的“配方提交”

真实记录写好之后，按 B2 定下的做法把版本真相放在**一次提交**里，不分开改（[ADR-038](../decisions/0038-verified-version-hint.md)“维护”与“区间语义”两节）：

1. [`VERIFIED_VERSIONS`](../../src/infrastructure/management/verified-versions.ts)：已验证区间扩到新版本，两端都要有真实记录，例如 Claude `program: ["2.1.296", "2.1.306"]`、适配器按证据头核实后的版本（0.89.1 时仍为 `["0.89.1", "0.89.1"]`）；dsh `program: ["0.2.0-rc.2", "0.2.0-rc.2"]` 并删除 `unofficial`。没有真实记录之前一个数字都不改。
2. `plan/native-capabilities.json`：该 Harness 的 `installation` 文本按完整版本号写出新的上界（有适配器时也写出适配器版本），例如“DeepSeek Harness 0.2.0-rc.2（npm 官网 @deepseek-ai/dsh）”，删去“非官网、保留为历史”的说法；各格的 `real`、`note` 按记录更新，`evidence` 指向新的 `docs/verification/` 记录；受阻的格写明观察结果（例如 dsh 的 approvals）。
3. 目录包：Harness 自己在 `src/adapters/catalog.ts` 里的包版本等于已验证上界（dsh 已是 0.2.0-rc.2；Claude 的入口来自 ACP 注册表，不受这条约束）。能力读表 `src/adapters/capability-reads.ts` 的 `verified` 区间要覆盖已验证区间的两端（Claude `>=2.1.277 <2.2.0`、dsh `>=0.2.0-rc.2 <0.3.0` 已覆盖）。
4. 依赖旧数字的测试作为合法的行为变化一并改，并在提交说明里写原因。例如 `tests/unit/verified-versions.test.ts` 断言 Claude 2.1.300 与 dsh 0.2.0-rc.2 为未验证、dsh 0.2.1-alpha.1 为已验证，改数字后这些断言要相应更新；其余因此失败的断言逐条核对后再改，不放宽。
5. ADR-038 补记哪个版本由哪份记录验证；ADR-039 的表补上新版本的续接命令（只写经第 7 节真实核对过的形式）。
6. 运行 `python3 -I tools/check_design.py --write` 重新生成矩阵视图；`versionConsistency` 必须为空，由 `tests/unit/verified-versions.test.ts` 核对；`pnpm check` 与 `pnpm test` 全部通过后才提交。

## 9. 局限

- 守护只比较清单里的位置。技能目录只看顶层，`~/.claude.json` 只看 `mcpServers`，不比较权限位与硬链接数；守护发现的是改动，不能证明改动由谁造成（用户自己或其他程序同时改了同一个文件，也会判为改动）。
- 证据头不运行 `--version`：经适配器接入的产品版本取自渠道记录（`programVersionFrom: installation`），版本探测与它不一致时以探测为准，这一点只有在页面上点“检查更新”才能看到。
- `HH_REAL_HARNESSES` 里没有守护清单的 Harness 会让套件在运行前失败，这是有意的：没有清单就无法证明配置未改。
- 平台只有 macOS（[ADR-044](../decisions/0044-macos-official-channels.md)）；隔离、费用与记录的其余要求见[测试与验收策略](testing.md#4-平台与组合)第 4–6 节。
