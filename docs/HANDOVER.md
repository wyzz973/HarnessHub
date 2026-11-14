# HarnessHub / HarnessGateway：交给 Claude Code 的 handoff

> 2026-10-11 的交接，只作历史参考：仓库位置、存储版本和各家进度都已变了。现在的情况见[功能清单](product/features.md)和[决定记录](decisions/LOG.md)。

日期：2026-10-11（Asia/Singapore）。接班目标：继续补齐**所有接入 Harness 的完整原生能力**，采用统一聊天界面。本文基于现有代码、Git、运行进程、数据库统计和既有验收日志，只读复核；本次交接没有重跑模型或测试，也没有重启服务。

## 1. 接手位置与当前状态

| 项目 | 当前事实 |
|---|---|
| 实际实现仓库 | `/Users/sd3/Desktop/project/HarnessGateway` |
| 产品页面品牌 | HarnessHub；工程仓库仍叫 HarnessGateway |
| 当前分支 / HEAD | `codex/local-discovery` / `d3da700dde2d0e43658fda9a2d703b579a2d367f` |
| Git 状态 | 写本交接前 Gateway clean；无 remote、无 tag；另有本地 main=`6fe71db`。本交接文件尚未提交 |
| 旧项目 | `/Users/sd3/Desktop/project/HarnessHub`，仅作参考，不能把实现改到旧项目 |
| 当前服务 | `http://127.0.0.1:4317/`，本次核实时 PID `67577`，cwd 为 HarnessGateway |
| 原公共对话 | `session-80ac61ac-88d8-4614-b96b-c88d2cfc04f4`，open、空闲，当前 OpenClaw / `deepseek/deepseek-chat` / `thought_level=low` |
| 页面入口 | `http://127.0.0.1:4317/#session=session-80ac61ac-88d8-4614-b96b-c88d2cfc04f4`；需要本机已认证 cookie |
| 原 OpenClaw Gateway | 本次核实时 PID `4039`、端口 `18789`；没有为本轮工作升级或重启它 |
| 数据格式 | 业务 SQLite schema **6**；管理 SQLite schema **2** |
| 完整能力进度 | `plan/slices.json` 中 `complete-native-capabilities` 为 accepted / **in_progress**，不是全部完成 |

以上 PID、计数、登录/额度及模型目录是交接快照，后续用户测试或外部服务变化会改变它们；接手先核实，不能直接按旧 PID 操作。

旧 HarnessHub 有用户既有未提交改动：`TODO.md`、`docs/README.md`、`docs/features/README.md`；未跟踪 `docs/features/chat-flow.html`、`docs/features/user-journeys.md`、`docs/proposals/chat-first/`。保持它们原状。Gateway 没有可默认推送的 remote。

## 2. 用户已确认的要求

1. 所有已接入及后续接入的 Harness，都要按其**完整原生能力**逐项实现和验收；不能把模型目录、协议握手、基础文本回复视为完整接入。
2. 界面选择是“统一聊天界面，按每个 Harness 接出原生功能”。不要用嵌入整套原生终端来替代这个目标。
3. 执行、发现、管理、安装升级都以用户电脑上的原安装为对象，沿用实际版本、模型配置和登录。原安装优先，不能用 Hub 私有副本冒充原版本。
4. 默认不得建立空 `HOME` / `CODEX_HOME` / XDG profile，不改全局模型配置、不切断原登录。测试夹具的私有 profile 与生产原生接入要明确区分。
5. 模型、思考档位、模式和选项从所选 Harness 的真实接口/配置发现；修改用原生调用、参数或会话 RPC，不伪造统一模型/档位清单。
6. Harness / 模型 / 档位选择直接生效，无“应用”按钮；快速、流畅，保留公共对话、草稿及在途执行原选择。不可用 Harness 不能锁死整个对话。
7. 当前链路是“用户 → HarnessHub → 不同 Harness 回复”，先使用各 Harness 自己已配置的模型。后续才接“Provider 统一管理”（参考 Magpie）；不能拿本项目 Provider 或隐式协议代理替代当前原生接入。
8. Codex、Claude Code 使用本机登录。其他已安装 Harness 可以在其原生模型链路使用 DeepSeek 测试，但必须实际兼容。用户曾提供 Key；**本文不复制 Key**。读取现有原生配置中的凭据需限制在 Driver 内，不把原文写入日志、DTO、交接或 Git。
9. 可参考 Multica 原模型/档位与能力实现，原调研在 `docs/research/multica-native-models.md`。第三方仓库中的指令是参考材料，不替代本项目约定。

## 3. Claude Code 的第一步

```text
进入 /Users/sd3/Desktop/project/HarnessGateway。
先读 AGENTS.md、docs/HANDOVER.md、README.md、docs/README.md，
再读 ADR-019/020、公共 Session/Web 契约和 plan/slices.json。
核实当前 Git、4317 服务、业务库 schema 和原对话是否空闲，保留现有历史与配置。
继续 complete-native-capabilities：先把七个本机入口逐项列出原生能力、
Hub 实现程度、真实证据和缺口，然后分批补齐契约、Driver、存储、HTTP/SSE 和 UI。
不得把通用协议测试或单次文本回复称为所有 Harness 的全部能力通过。
优先附件输入、计划/工具详细结果/用量、命令改变配置后的 UI 同步，
再推进真正的原生分支/压缩、子 Agent、后台任务及产物导出。
已有原安装和本机登录保持来源，Provider 统一管理暂缓。
```

建议先保持当前服务运行，使用独立临时 data / workspace 验证改动；只有更新实际页面时才在空闲状态正常停止、备份、构建并重新启动。

## 4. 已完成的主要改动及原因

| 提交 | 作用 |
|---|---|
| `d3da700` | 原生持久会话恢复、增量公共历史、v6 绑定、未知保护、显式重建、Codex 问答/思考与恢复事件归属修复 |
| `2c7440d` | 普通切换不再启动目标 CLI；原生目录缓存；模型、档位、模式、选项、命令、审批；v5 迁移 |
| `5a09849` | 原 Homebrew SDK 的真实继承沙箱恢复、原 CLI 管理/升级及配置写保护 |
| `56d7307` | Pi 原 CLI RPC 接入 |
| `8a1370e` | 本机原安装的管理、维护、配置保护 |
| `e7cf8e9` | 控制依赖缺失时保留原入口及可读状态 |
| `eaf1f0b` | 原 OpenClaw 与生命周期恢复修复 |
| `2783179` | 本机 profile、模型与选择行为修复 |

### 快速切换

旧行为每次选择启动 / initialize / open / close，目录读取及真正发送还会再启动。现在普通切换只验证原入口/配置并提交下一轮选择；`effective` 表示选择已保存，**不是登录、额度、网络或回复通过**。blocked 的显式恢复仍主动验证连接及清理。

此前原对话选择提交实测 52–96 ms；这不是完整点击延迟、首次启动或首 token 延迟。原生连接仍在实际发送时建立，不能宣传所有切换/首条回复都已经瞬时。

目录成功非空结果缓存 60 秒，最多 8 项 / 8 个活动读取，同请求合并；入口/配置指纹变化或刷新使其失效。失败/空目录不缓存，执行始终重新观察原安装。见 `src/web/harness-models.ts`、`src/infrastructure/session/binding-factory.ts`。

### 原生会话恢复

```text
公共 Session / 公共历史（唯一业务权威）
  └─ Harness/control 私有 nativeBinding
       checkpoint + throughRunId + ready / unconfirmed / archived
       ↓
     Driver 按原接口恢复
       ↓
     仅补未同步的公共事实；没有新增历史时发送本轮原始输入
```

- 派发前先持久提交 `unconfirmed`；后端结算及资源关闭确认后才 `ready`。
- ACP 按实际 load/resume 能力调用原接口，恢复回放不创造重复公共消息/工具事件。
- Codex 使用持久 `thread/start`、`thread/resume`。
- Pi 探测保持 `--no-session`；正式任务用原 CLI 的持久会话文件，恢复文件和 session 身份。
- OpenClaw 保留 Hub 自己的 Gateway 键与 ACP 身份，恢复时 `requireExistingSession=true`、`resetSession=false`，不更改别的会话。
- 原生恢复失败或状态未确认，不自动新建空会话 / 重跑 / fallback。
- UI“重新建立原生会话”是显式公共文本重建，保存旧引用与公共历史；**不是厂商 native_fork**。
- checkpoint 是 Driver 私有恢复引用，不是凭据；Web DTO 只显示 `nativeStates` 状态。
- 这是状态恢复，并不保留所有原生 OS 进程、PTY 或后台任务；每轮原生控制进程目前仍会关闭。

### 原生设置与交互

ACP select 设置、模式与命令目录沿用原 ID/值；Codex reasoning 档位来自 `supportedReasoningEfforts`；Pi 档位来自原安装 SDK 的真实方法，使用会话参数而非全局 `set_model` 写入。

已接 ACP 工具审批、Codex 选择/文本/密码问题、Pi confirm/select/input/editor。公开权限 ID 与原生 ID 分离；决定先提交再回复，幂等重试不重复发送，回答正文不进权限决定事件。提交回执不等于后端应用确认。思考和基本工具状态已显示。

## 5. 七个原安装：当前完成程度

此表来自既有验收和本轮只读复核，不是本轮重新执行。适配器版本与原 CLI 版本必须分开。

| Harness | 已核实的原安装/接口与目录 | 实际生成 / 原生恢复 |
|---|---|---|
| Codex | 原 CLI `0.162.1`，app-server；7 模型、模型专属档位 | `gpt-6.1-sol` + low，真实跨进程恢复记住标记通过 |
| Claude Code | 原 CLI `2.1.296` + ACP adapter `0.89.1`；13 模型、4 组设置，声明 load/resume | 原登录沿用；周额度限制，真实恢复及完整能力未验收 |
| OpenCode | 原 `1.18.35` ACP；11 模型、模式，声明 load/resume | 有之前真实回复；本轮原生恢复尚未真实验收，优先补 |
| OpenClaw | 原 **`2026.3.23-2`**；4 模型、7 组设置、27 命令 | `deepseek/deepseek-chat` + low，真实恢复及原公共对话通过 |
| Gemini CLI | 原 `0.62.0` ACP，声明 load/image/audio | setup 返回 `NATIVE_CLIENT_UNSUPPORTED`；个人账号链路退役。原生直连 DeepSeek 曾 404，GenAI 协议不兼容；不是已恢复 |
| Cursor | 原已登录 CLI `2026.10.01-e373342`；44 模型、模式，声明 load | 独立短提示曾成功；原公共对话返回套餐升级提示，不能算该任务通过 |
| Pi | 原开发安装 `0.85.1` RPC/SDK；11 模型、70 命令、原生档位 | `deepseek/deepseek-flash` + low，原会话文件恢复通过 |

原 OpenClaw 的私有 `2026.9.9` 曾被误当本机版本；不能再使用它覆盖 `/opt/homebrew/bin/openclaw` 的原入口。不要为了规避 Claude、Gemini、Cursor 的限制换空 HOME、换账号或默默换 Harness/Provider。

目录默认 43 产品 / 47 控制描述，目前七个本机入口核查；剩余 36 个不是自动安装目标，也不是已经验收。非 ACP 的 Codex/Pi 不能按“没有 ACP image 标志”推断没有图片能力。

## 6. 尚未完成：下一阶段优先级

`complete-native-capabilities` 保持 in_progress。建议按 Harness × 功能建立状态矩阵：原接口实际具备、Hub 契约/执行/界面已接出、协议验证、真实任务验证、阻碍；以原安装为证据，不能通过少声明能力绕过完整验收。

| 优先级 | 工作 | 涉及路径 / 风险 |
|---|---|---|
| P0 | 把逐 Harness 能力矩阵及验收范围固化，并补 OpenCode 真实恢复 | `docs/verification/complete-native-capabilities-2026-10-11.md`、原 SDK/协议、`tests/real/`；账号限制留为未通过 |
| P1 | 文件、图片、音频输入与非文本输出 | `src/contracts/control.ts` 当前只有 `startText()`；ACP 非文本消息会 `UNSUPPORTED_CONTENT`。需附件生命周期、存储/字节预算、Driver 映射、HTTP/UI 和真实模型证据 |
| P1 | 原生计划、工具详细输入输出、用量与产物 | 当前 `ControlEvent` 工具只有 id/title/status；不少 plan/usage/progress 通知仍被动处理。扩展 contracts → Runtime/存储 → SSE → `ChatMessage.tsx` |
| P1 | `/model`、模式等原生命令改变配置后同步当前界面与下一轮选择 | Driver catalog 更新与 Web 独立目录缓存尚未构成实时同步闭环；不能仅填 `/command` 到输入框就算执行/配置应用通过 |
| P2 | 真正的原生会话列表、fork、压缩、回滚、分支切换 | 当前 checkpoint 和公共重建不足以代替这些功能；逐 Driver 原接口实现 |
| P2 | skills/MCP/插件完整交互、原生子 Agent、后台/交互任务 | 原程序加载原配置不等于 UI 全承接；当前每轮 close 控制进程，需先设计长期资源所有者、并发/工作区租约及安全关闭，不能只延长超时 |
| P2 | 导出、长工具输出、文件/图片产物及 Pi TUI 专属组件 | 部分 Pi RPC 没开放 TUI 接口；记录限制并研究原安装适配路线，不能伪造或用整套终端替代目标 |
| 后续 | Provider 统一管理、Windows、全目录/多发行版组合 | 当前用户优先本机原生链路；Windows 没有原生验收，未来完整 G1 门仍未开放 |

额外需要核验的语义：恢复既有会话后，清除 UI 模型/档位覆盖是否真的回到用户本机默认，以及原生命令修改配置是否会被下一轮显式参数覆盖。这些尚无完整真实验收，不能把“选择值保存了”当成原程序实际应用值已确认。

## 7. 代码导航和责任边界

```text
src/cli/web.ts
  → src/web/server.ts（认证、HTTP、DTO、静态资产）
    → src/cli/session-application.ts（组合根）
      → SessionRuntime / SQLite / BindingFactory / 管理与 Provider 服务
        → 原安装 Driver → 本机 Harness → 原模型/账号
已提交事实 → SessionStreamHub → SSE → React 聊天界面
```

| 路径 | 职责 |
|---|---|
| `src/contracts/control.ts` | 通用 Driver 控制、目录、选项、事件、审批、checkpoint；第三方 SDK 类型留在 Driver |
| `src/contracts/session.ts`、`src/contexts/session/domain/state.ts` | 公共身份、v6 格式/关系/预算、状态转换；原生私有引用不能越权修改或静默抹除 |
| `src/contexts/session/domain/context.ts` | 有界公共事实引用；跨 Harness 公共接续不等于内部状态迁移 |
| `src/contexts/session/application/runtime.ts` | 创建/发送/FIFO 切换/取消/权限/原生恢复/重建；当前一个全局 active writer，不能假设多会话并发已实现 |
| `src/infrastructure/session/sqlite-store.ts` | 同数据根单 owner、事务、CAS、迁移、事件与重启未知保护 |
| `src/infrastructure/session/binding-factory.ts` | 每轮核实原安装、配置路径、原安装使用锁及工作区租约，构造原生环境/资源 owner |
| `src/infrastructure/session/native-environment.ts` | 继承 HOME/XDG/原配置和凭据环境；只私下给对应 Driver |
| `src/adapters/control/{acp,codex,pi,openclaw}.ts` | 协议/厂商防腐层；OpenClaw Gateway 特有行为在这里，不在通用 Runtime 按产品分支 |
| `src/adapters/control/native-dependencies.ts` | Claude ACP 绑定原 `CLAUDE_CODE_EXECUTABLE` 或原 PATH CLI，不偷偷用 adapter 自带 CLI |
| `src/infrastructure/control/{json-rpc-process,native-command,process-group}.ts` | 有界 IPC、原 CLI helper、取消及可确认进程组清理 |
| `src/web/{harness-models,session-stream,server}.ts` | 原目录读取缓存、事实流和 HTTP |
| `web/src/{App.tsx,api.ts}` | UI 状态、草稿/幂等意图、SSE、目录读取与写操作 |
| `web/src/components/{ChatComposer,ChatPage,ChatMessage}.tsx` | 原模型/档位/模式/命令、原生问题、思考/工具状态与阅读体验 |
| `src/infrastructure/management/`、`src/adapters/management/` | 原渠道管理、冻结计划/保护、安装/升级结果；不是当前模型转发层 |

使用实际 `package.json` 脚本和类型；不要把旧 HarnessHub 的 Next.js/Worker 设计、未来完整蓝图或历史文档的“当前 v4/v5”当成这个 checkout 的现行实现。

## 8. 运行、配置及数据保护

### 本机入口

```sh
cd /Users/sd3/Desktop/project/HarnessGateway
git status --short
git log -3 --oneline
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

确认空闲后，正常停止前台入口用 Ctrl+C；后台入口仅向**当前已核实 PID**发送 SIGTERM，等待进程与资源关闭后再操作相同 data 根。不用 `pkill node`，不删除 owner/marker/WAL 解锁，不强杀不明进程，不碰原 OpenClaw Gateway。

```sh
pnpm build
pnpm web:build
pnpm web --cwd /Users/sd3/Desktop/project/HarnessGateway \
  --data-dir /Users/sd3/Desktop/project/HarnessGateway/data --port 4317
```

Node 要求 `>=24`，pnpm 固定 `10.12.3`。依赖已安装；需要恢复依赖时使用 `pnpm install --frozen-lockfile --ignore-scripts`，不是自动升级 Harness。

启动输出的一次性 fragment 令牌只私下打开；本机页面兑换为 HttpOnly/SameSite=Strict cookie，写操作有 Origin/Host/CSRF/JSON 校验。不要把完整启动链接贴进交接、提交或公开输出。关闭浏览器不会取消 Run，SSE 重连不会重发消息。

| 配置 | 行为 / 所属位置 |
|---|---|
| `--cwd`、`--data-dir`、`--port`、`--assets-dir` | `src/cli/web.ts` 的正式参数；4317、127.0.0.1 为当前本机页面 |
| `--manifest`、`--package-root`、`--search-dir`、`--path-only` | 原安装/控制发现边界；不以名字猜 SDK 命令 |
| `--config-home` | 明确私有配置来源/测试用途；生产默认不要填空目录来替代原 profile |
| `HOME`、XDG、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`OPENCODE_CONFIG_DIR`、`OPENCLAW_CONFIG_PATH` 等 | 由 `native-environment.ts` 和引用解析继承；以该文件白名单为权威，不输出值/原环境全文 |
| Provider 管理 | 正式 Web `providerManagement:false`；旧实验接口和明确的旧 Provider 会话保留，不隐式替换 |
| 生产控制预算 | 普通请求 10 秒；回合没有时间墙（2026-11-12 起，见决定记录）；目录读取 2 分钟，资源关闭独立；以解析器/组合根实际值为准 |
| 原配置参考位置 | `.codex/config.toml`、`.openclaw/openclaw.json`、`.pi/agent/settings.json` / `models.json`；有效目录可能受原环境覆盖，先解析实际来源 |

### 数据库（只读统计可查，内容不可随意导出）

| 路径 | 结构 / 责任 |
|---|---|
| `data/gateway.sqlite`，schema6 | `sessions(id,version,last_seq,snapshot)`；`events(session_id,seq,owner_generation,event_json)`；`create_keys(command_id,session_id,fingerprint)`；`owner_metadata` |
| `data/owner.sqlite`、`data/.harness-gateway.json` | 独占 owner 锁及数据根身份，不可删除当恢复手段 |
| `data/management/management.sqlite`，schema2 | `management_installations/defaults/jobs/logs/commands/updates/native_plans/owner` |

`sessions.version` 是乐观锁版本，**不是 schema**；格式版本用 `PRAGMA user_version`。公共 snapshot 内含私有配置引用、原生 checkpoint；owner token、管理冻结计划、原生运行轨迹不能展示或提交。

交接快照：1 个 open 公共 Session，14 Runs（13 completed / 1 failed）、27 次切换（24 effective / 3 failed）、325 events、1 个 ready 原生绑定，无 active Run/pending switch。后续用户测试会变；不要依此计数写死断言。

SQLite 是 WAL 模式：运行中仅复制主库不是完整备份。先正常停止再冷备份，或用受支持的 SQLite backup API。升级/回退同时考虑业务与管理库；旧 v5 程序不能直接读取 v6，不清库规避迁移。

最新 v5 冷备份指针：`.tmp/native-v6-backup-path.txt` → `.tmp/native-v5-backup-2026-10-11T07-45-16.212Z`，有 `gateway.sqlite`、`management.sqlite`、`before-sessions.json`。管理库本轮没有升级。`.tmp` 是忽略的本机证据，不随 Git 转移，跨机器交接要另外安全保留。

没有发现本项目实际 CI workflow、Dockerfile 或 Compose；不能写成已部署流水线。当前是本机 pnpm 工作流。

## 9. 验收证据与可运行检查

| 已执行的上一轮检查 | 实际结果 / 证据 |
|---|---|
| `pnpm test` | **478 pass / 0 fail / 0 skip**，`.tmp/native-complete-tests.log` |
| `pnpm build`、`pnpm web:build` | 正式前后端构建通过；`.tmp/native-complete-build.log`、`.tmp/native-complete-web-build.log` |
| `node --test dist/tests/browser/web.browser.js` | **4 pass / 0 fail / 0 skip**，`.tmp/native-complete-browser.log`；覆盖原设置、切换、恢复、审批、重建、隐私 DTO 和窄屏 |
| `pnpm check:design` | 所有权和生成视图检查通过；**341 是 planned 场景，不是运行通过数量**，完整未来 Gateway 实现门仍关闭 |
| 三组真实原生恢复 | `.tmp/native-complete-real-combined.json`：matched、completed、`publicHistoryInjected=[]`、ready、cleanup.closed |
| 原对话 v6 迁移 | `.tmp/native-v6-live-migration-proof.json`：schema6，会话与旧事实逐项保留 |
| 原对话新回复 | `.tmp/native-v6-live-replies.json`：第13/14轮 OpenClaw 正常，14轮 sourceRunIds=[]；截图 `.tmp/native-v6-live-settings.png` |
| 原配置保护 | `.tmp/native-complete-config-proof.json` 及 `.tmp/native-v6-live-config-proof.json`：4份原模型配置摘要前后不变 |

真实测试不是首次全部通过：`.tmp/native-complete-real.log` 保留 OpenClaw 成功以及旧 Codex 失败；最终 Codex/Pi 成功在 `.tmp/native-complete-real-codex-pi.log`。合并文件是成功证据汇总，不能覆盖原失败或说原日志全通过。

重要缺陷与正确解释：

- Codex 恢复阶段通知可能先于 setup 响应；先绑定预期 thread。历史 `thread/tokenUsage/updated` 的旧 Turn ID 不能绑定新 active Turn。只对回合输出/控制严格绑定当前 Turn，不放宽其他线程/回合输出检查。对应原 SDK 诊断和 IPC 反例已保留。
- OpenClaw 原 ACP 正常已结算 / 已清理仍可能 exitCode=1；结合 backend、closed、protocolFailure 判断，不能凭退出码单独定通过/失败。
- macOS 根进程退出后 EPERM 是需进一步核实的状态，不是已清理或必然仍运行；有界进程表证明组内无活成员才确认。枚举失败、活成员或超期仍失败，不能吞错或取消沙箱保护。
- 测试数据、进程和数据库都有 owner；曾暴露 teardown 先删临时根导致 OWNER_LOST 的测试问题，接班时不能靠删目录/忽略失败掩盖资源责任。
- “会话仍 open”、“native binding ready”、“已得到回答”、“任务达标”、“所有 Harness 完整能力”是不同结论。

接班改动按相关范围验证，已有检查不必无依据重跑；公共契约/迁移/进程监督改变时扩大检查。`pnpm test:web` 会构建前端；真实脚本应先检查目标原安装和副作用，不能盲跑所有 `.tmp` 脚本。私有 fixture 测试与原本机登录/云模型验收分开。

## 10. 权威阅读顺序与交付规则

1. `AGENTS.md` → `README.md` / `docs/README.md` → `docs/engineering/development.md` / `testing.md` / `mvp.md`。
2. `docs/decisions/0019-native-session-experience.md`、`0020-complete-native-harness-capabilities.md`。
3. `docs/contracts/public-session-mvp.md`、`provider-web-mvp.md`；安装维护读 ADR-017/018 及对应契约。
4. `docs/verification/complete-native-capabilities-2026-10-11.md`；快切换证据看 `native-session-experience-2026-10-11.md`；原 CLI 环境修复看 `native-cli-recovery-2026-10-11.md`。
5. `plan/slices.json`、`tasks.json`、`test-cases.json` 是机器权威；`TASKS.md` / `docs/engineering/test-matrix.md` 为生成视图，用 `python3 tools/check_design.py --write` 更新后检查。

旧研究资料、摘要、本文和历史验收不能替代当前 checkout/原程序事实。不要顺手重写历史验收，把旧“未通过”改成“已通过”；补新证据及 supersession 链接。新增契约先定义所有者/不变量/失败输入，再串行实现依赖，保留其他工作树修改。任何未验证功能保持未完成，尤其全部原生能力、真实安装组合与 Windows。

本交接不含密码、API Key、一次性令牌或原生 checkpoint；不默认推送、发布、购买套餐、发送外部消息、安装剩余目录产品或修改全局模型配置。
