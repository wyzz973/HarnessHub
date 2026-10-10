# Harness 安装、升级、版本与图标调研

日期：2026-10-10。范围：当前宿主的后台安装管理；不建立平台发布矩阵。本文保留调研采集时的来源与目录快照，基线为 HarnessGateway `42e9ddd`，默认目录 43 个产品、47 个控制入口。后续已按 [ADR-012](../decisions/0012-harness-management-workbench.md) 实现管理切片；实际下载、安装、调用与浏览器验收分别见[验证记录](../verification/harness-management-2026-10-10.md)，不由目录数量或本文建议推断。

## 1. 已核对的参考项目

| 项目 | 源码基线 | 发行版观察 | 说明 |
|---|---|---|---|
| Magpie | [yetone/magpie](https://github.com/yetone/magpie/tree/331b692d184df4f651ae15ae2ec4d3690196b50d)，main `331b692d184df4f651ae15ae2ec4d3690196b50d`，提交时间 2026-10-10 11:21:57 UTC | [v0.1.1161](https://github.com/yetone/magpie-releases/releases/tag/v0.1.1161)，2026-10-10 11:30:03 UTC | 正式发布在独立 `yetone/magpie-releases`。源码仓库的 releases/latest 返回 404 不表示产品没有发行版。源码 HEAD 与发行版并非同一身份，不据此声称发行包包含所读 HEAD 的全部行为 |
| CC Switch | [farion1231/cc-switch](https://github.com/farion1231/cc-switch/tree/1f786dadd0f6389acdcf5c66211d0f341f87b3e7)，main `1f786dadd0f6389acdcf5c66211d0f341f87b3e7`，提交时间 2026-10-10 10:44:33 UTC | [v4.0.7](https://github.com/farion1231/cc-switch/releases/tag/v4.0.7)，2026-10-10 09:11:51 UTC | 调研观察与发行包实际验收分开；未运行参考产品 |

版本在采集期间仍会变化。以上固定 tag/commit，不能用带缓存的最新网页覆盖实际 API 观察，也不把 `latest` 留到安装进程启动时才解析。

### Magpie

- [internal/agent/install.go](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/agent/install.go)：Agents 页的 `Installs` 生成安装命令，供用户复制到终端；代码明确不在该页自行执行。Claude、Codex、OpenCode 有官方脚本配方，Gemini 有 brew 配方；其余受覆盖 CLI 从 `cliSpecs` 的 npm 包生成。缺 npm 时会生成先安装 Node 的命令。这与真正的一键后台安装不是同一能力。
- [internal/agent/cliupdate.go](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/agent/cliupdate.go)：`howInstalled/fromNodeModules` 根据 realpath、全局包目录和 shim 判断 self/npm/bun/pnpm/brew 归属；未知归属不提供升级。`UpdateCLI` 真正执行 argv，有单 Agent 排他、10 分钟上限、清理版本缓存及前后版本复查。它通常升级用户已有的系统安装，不是网关私有版本槽。
- [internal/proc/version.go](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/proc/version.go)：npm 内程序优先读所属 package.json 的版本；其余执行有时限的 `--version`。路径、大小和修改时间参与缓存，某些失败不重复启动同一个未变化的程序。包版本证据不能代替“程序可运行”。
- [internal/provider/install.go](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/provider/install.go)：另一条订阅登录链会自动安装 Devin、Cursor、Grok 所需 CLI；Grok 还有不依赖 shell 的下载实现。不可把这条少量订阅依赖安装误读为所有 Agent 都有通用安装器。所读 Agent 升级表没有 uv/pip 通用通道。

### CC Switch

[src-tauri/src/commands/misc.rs](https://github.com/farion1231/cc-switch/blob/1f786dadd0f6389acdcf5c66211d0f341f87b3e7/src-tauri/src/commands/misc.rs) 的 `VALID_TOOLS` 仍是 9 个产品。`run_tool_lifecycle_action` 通过后台 blocking task 真正运行安装/升级并等待退出；同产品先锁定，安装写入全局串行。重新探测默认安装后，用同一规划器选择锚定升级或拒绝未知归属，前端不能传任意命令。

`enumerate_tool_installations` 枚举并按 realpath 去重，分开报告版本、可运行性、来源及 PATH 默认项；版本探测有时限。最新版本可查 npm dist-tags、GitHub release 或 PyPI。首次安装按官方脚本/npm 配方；Hermes 的官方脚本负责 Python/uv 依赖。其 POSIX lifecycle 分支使用 `Command.output()` 收集输出后返回，没有提供我们的持久任务、取消和流式阶段事件；不能整段照搬当作进度系统。

## 2. 当前目录能提供什么

实际解析当前 `src/infrastructure/catalog/acp-registry.json` 与 `loadBuiltinCatalog`：47 个入口中有 **23 个 npm、19 个 binary、2 个 Python、3 个没有 distribution 的 native 入口**。19 个 binary 中 10 个有 SHA-256、9 个没有。44 个已有分发描述足以作为安装计划输入，不证明这些程序已可下载、依赖完整或能对话。

以下类别描述“可从当前元数据构建怎样的管理计划”，不是已实现或已验收数量：

- **N**：精确 npm 包/version 可用于通用私有 npm 安装器；运行前还需核对 engines、bin、生命周期脚本和实际入口。
- **B+ / B**：有固定下载地址及相对入口；B+ 有上游 SHA-256，B 没有。通用解包器能复用，但缺 hash 的条目需明确其来源/完整性证据，不能把下载后自行算出的 hash 冒充上游校验。
- **P**：Python 分发需要 uv/venv 适配器与明确 console_script。原只读发现的 package resolver 仅实现 npm；ADR-012 的管理安装器另行提供私有 uv tool 适配，宿主缺 uv 时明确不可用。
- **R**：native 入口没有分发描述，必须补独立管理配方。
- **H**：已有描述现已过期，应刷新后再给新安装动作。

### 逐产品管理覆盖矩阵（当前 macOS ARM64 配方）

| 产品 ID | 当前固定分发 | 能复用的管理计划 | 必须补充或验证 |
|---|---|---|---|
| agoragentic-acp | `agoragentic-mcp@1.3.0` | N | package.json 单 bin `agoragentic-mcp`；有 postinstall，不能只看包存在 |
| amp-acp | binary `0.10.0` | B+ | 管的是 Amp ACP 包装器；实际原生依赖需探测 |
| antigravity-acp | binary `1.3.0` | B | `.par` 入口的实际运行依赖与来源校验 |
| auggie | `@augmentcode/auggie@0.36.0` | N | 已有明确 `auggie` bin |
| autohand | `@autohandai/autohand-acp@0.2.1` | N | 单 bin `autohand-acp` |
| claude | `@agentclientprotocol/claude-agent-acp@0.88.0` | N | 包装器安装与 Claude 原生 CLI 是独立目标，不能改用原生包冒充 ACP 入口 |
| cline | `cline@3.0.70` | N | 明确 `cline` bin |
| codebuddy-code | `@tencent-ai/codebuddy-code@2.163.0` | N | 包有 5 个 bin，补明确 `codebuddy`，不可猜唯一入口 |
| codex | `@agentclientprotocol/codex-acp@2.1.1`；native 无 distribution | N + R | ACP 包装器可复用 npm；核心 `codex-native` 要独立 `@openai/codex` 配方 |
| cortex-code | binary `1.0.73+180523.e6179a031de9` | B | 深层相对入口；补完整性证据 |
| corust-agent | binary `0.6.0` | B | 补完整性证据 |
| crow-cli | binary `0.1.24` | B | 补完整性证据 |
| cursor | binary `2026.10.01-14929f9` | B | 保留 `dist-package` 内资源，不能只搬入口 |
| deepagents | `deepagents-acp@0.1.7` | N | 单 bin `deepagents-acp` |
| devin | binary `3000.11.3` | B | `bin/devin` 相对入口；补完整性证据 |
| dimcode | `dimcode@0.5.16` | N | 两个等价 bin，补明确 `dimcode` |
| dirac | `dirac-cli@0.5.18` | N | 单 bin `dirac`；Node 要求 `>=22.13.0 <25.0.0`，本机 Node 25.9 不满足 |
| factory-droid | `droid@0.237.0` | N | 已有 `droid` bin；生命周期与依赖需验证 |
| fast-agent | `fast-agent-acp==0.10.1` | P | 明确 console_script `fast-agent-acp` 与 Python 要求 |
| gemini | `@google/gemini-cli@0.63.0` | N | `gemini` bin；目录固定版不等于当前已验收的本机 `0.38.2` |
| github-copilot | `@github/copilot-language-server@1.552.0` | N | 单 bin `copilot-language-server`；与下行 CLI 是不同产品入口 |
| github-copilot-cli | `@github/copilot@1.0.94` | N | 明确 `copilot` bin |
| glm-acp-agent | `glm-acp-agent@1.14.0` | N | 单 bin `glm-acp-agent`；primary engines 已核对 |
| goose | binary `1.54.0` | B+ | 保留全包并验证 `goose acp` |
| grok-build | `@xai-official/grok@1.0.50` | N | npm 方式与官方原生脚本属于不同安装渠道，不隐式降级换渠道 |
| harn | binary `0.10.157` | B+ | 已有 `harn serve acp` |
| junie | binary `3579.5` | B | archive 内 app bundle 入口，保留包内资源；补完整性证据 |
| kilo | binary / `@kilocode/cli@7.8.8` | B+ / N | 两种配方明确选择，不隐式互换 |
| kimchi | binary `1.7.2` | B+ | 已有 `bin/kimchi` |
| kimi | 旧 binary `1.52.0` | H | 官方旧 Python 仓库已归档，须刷新到 Kimi Code；不要自动新装旧条目 |
| minimax-code | `@minimax-ai/code@0.2.7` | N | `mcode` bin；原生脚本/自带 Node 与 npm 是不同管理配方 |
| minion-code | 原字段 `minion-code@0.1.44` | P | 根据 package name/version 规范为 `minion-code==0.1.44`；多 console_script，明确 `minion-code`，避免与 MiniMax `mcode` 碰撞 |
| mistral-vibe | binary `2.26.0` | B+ | `vibe-acp` 入口 |
| nova | `@compass-ai/nova@1.1.51` | N | 多 bin 明确 `nova`；有 postinstall |
| opencode | binary `1.18.35` | B+ | 与本机系统安装分开；此前系统版失败不能算受管安装验收 |
| pi | `pi-acp@0.0.34`；native 无 distribution | N + R | 包装器要求额外 `pi`，补原生包 recipe；Pi RPC Driver 当前未实现 |
| poolside | binary `1.0.16` | B+ | 入口 `pool-darwin-arm64`，不能凭产品名猜 `pool` 文件 |
| qoder | `@qoder-ai/qodercli@0.2.14` | N | 明确 `qodercli` bin |
| qwen | `@qwen-code/qwen-code@0.25.0` | N | 保留已固定 ACP 参数，不把原生入口相同当参数兼容 |
| sigit | binary / `@smbcloud/sigit@1.6.5` | B+ / N | 两种配方明确选择 |
| stakpak | binary `0.3.88` | B | 补完整性证据 |
| vtcode | binary `0.96.14` | B | 补完整性证据 |
| openclaw | native 无 distribution | R | 独立 `openclaw` npm recipe；最新包的运行时范围与本机 Node 不兼容 |

矩阵由当前已提交目录和实际 npm manifest 观察整理，所有产品的外部运行依赖没有逐个审计。安装器的共享代码能处理分发，产品 recipe 仍负责入口、版本来源、必要依赖、脚本策略及验收命令。

### 当前明确需要修正的描述

1. 现有 npm resolver 的“没有 binNames 时只能用唯一 bin”会拒绝 CodeBuddy、DimCode、Nova。primary npm manifest 确认应分别选 `codebuddy`、`dimcode`、`nova`。其他缺 binNames 的六个 npm 配方可从固定版本 manifest 的单一 bin 获取入口。
2. [Kimi CLI 官方归档说明](https://github.com/MoonshotAI/kimi-cli)指向 [Kimi Code](https://github.com/MoonshotAI/kimi-code)，新 npm 身份是 `@moonshot-ai/kimi-code`。它是产品迁移，不能把旧 PyPI 同名包或旧 binary 当作新版本。新 recipe/ACP 参数仍需核对。
3. 本次 npm 元数据观察：`@openai/codex@0.162.1` 的 bin 是 `codex`；`@earendil-works/pi-coding-agent@1.1.0` 的 bin 是 `pi`；`openclaw@2026.9.9` 的 bin 是 `openclaw`。它们不应在执行时用漂移的 `@latest`，解析后固定 exact version 与 dist integrity。
4. Dirac `0.5.18` 的 Node 范围为 `>=22.13.0 <25.0.0`；OpenClaw `2026.9.9` 为 `>=24.16.0 <25 || >=26.1.0`。Node 25.9 能运行网关，不保证能运行这些程序。先明确 `runtime_incompatible`；若实现受管 Node，只验证一个能满足当前目标的版本，不做多平台发布矩阵。

上述 npm 证据来自 `registry.npmjs.org/<package>/<exact-version>`；native latest 观察已转成上述 exact version。存在 package manifest 不证明 lifecycle scripts、optional dependencies 或二进制完整。

## 3. 已接受的本机取舍与后续建议

### 私有版本槽

ADR-012 实现使用 `management/slots/<installationId>/`：先分配最终不可变目录，在未发布状态中安装和验证，最后仅通过数据库事务发布安装事实与默认指针。这个 stage 是逻辑状态，不 rename 安装树，避免破坏 uv console_script 的绝对 shebang 或 npm lifecycle 记录的路径。npm 使用私有 prefix，Python 使用私有 uv tool 目录，binary 解包到本槽；保存来源、精确版本、下载摘要和实际入口。

升级安装一个新版本槽，验证后才切换 active 指针。正在运行的绑定仍引用原槽，不原地覆写它。失败/取消不激活 staging；未知子进程或未确认清理必须隔离，不能把目录删除和任务成功混在一起。用户选择的 managed 安装参与实际执行解析；只把安装文件放在硬盘上、执行仍落到系统 PATH，不算功能完成。

安装器需要的参数来自固定 recipe，HTTP 只传目标 ID、动作和版本意图；不接受任意 shell 字符串。进程以 argv 启动，HOME/cache/npm userconfig/TMPDIR 私有化，不继承 Provider keys 或个人登录配置。下载与包 manager 的脚本权限是所属 recipe 的明确行为，不把所有 npm scripts 一律忽略然后冒充程序完整。

### 系统安装与升级

当前实现系统安装的只读观察与显式版本检查：优先 package 版本证据，必要时在私有配置环境运行受支持的版本探测，再与官方最新元数据比较。重扫保留未变化入口的已测版本。安装/升级动作写入新的私有版本槽，不执行系统 `npm -g`、brew upgrade 或 vendor 自升级；受管默认与系统安装分别显示。Magpie/CC Switch 的渠道归属与锚定升级可供未来系统管理参考，尚未作为本项目全局升级器实现。

### 真正的一键任务

当前链路：请求与幂等 key 持久提交 → 排队 → 解析来源/版本和依赖 → 下载/包安装 → 检查 package/bin/版本证据、路径和资源清理 → 原子激活 → 持久终态。前端拿任务 ID、查询阶段与有界日志；浏览器关闭不改变后端任务所有权。协议初始化、登录、模型调用与任务达标是独立证据，不由安装 completed 状态承诺。

显示真实阶段和可测下载字节，不伪造总体百分比。每安装目标排他，有共享 cache/prefix 写入的地方再设置资源锁；取消有受理与实际停止两种事实。退出 0 后仍检查目标位置、版本和入口。认证/模型错误属于运行准备状态：已安装、可启动、协议就绪和可完成任务各自展示。

调研建议的顺序是 native Codex → npm/ACP → binary → Python/必要 Node 依赖；实现已提供这些共享安装适配。实际组合覆盖及未验证项仍以验证记录为准，产品迁移条目可明确禁用。安装管理不会自动扩大 Provider 适配矩阵或 Pi RPC Driver 支持。

## 4. 图标来源与许可记录

当前 ACP snapshot 42 个上游条目里 **11 个声明 icon**：Amp、Auggie、Cline、Dirac、GLM Agent、Kilo、Mistral Vibe、Nova、OpenCode、Qoder、Stakpak。它们大多是 registry 目录相对 SVG；应解析为固定 commit 内资源，不能相对于前端页面地址。现有 catalog importer 没把 icon 带入领域描述，是当前展示能力缺口。[ACP 格式说明](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/FORMAT.md)

Magpie 的 Agent 自带 icon key，指向 `internal/gui/assets/icons`；模型另由 [internal/agent/icons.go](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/agent/icons.go) 映射品牌。CC Switch 的 [BrandIcons.tsx](https://github.com/farion1231/cc-switch/blob/1f786dadd0f6389acdcf5c66211d0f341f87b3e7/src/components/BrandIcons.tsx) 和 `src/icons/extracted` 也使用实际品牌素材；部分 SVG 含 Lobe Icons 标识。它们的源码 MIT 许可不等于每个品牌资产已经得到独立授权。

建议来源优先级：该 Agent/厂商的上游资源 → 该 Agent 的 ACP registry 资源 → 明确映射的 Lobe Icons。未知产品保留名称，不根据名字猜一个相似品牌 logo。独立记录 `sourceUrl/sourceRevision/sha256/licenseUrl/copyright/brandPolicy`；代码许可字段与素材来源分开。[Lobe Icons LICENSE](https://github.com/lobehub/lobe-icons/blob/c385b2b8d1f9e19aa86e628d4e23c91ee1111a47/LICENSE) 为 MIT；[ACP registry LICENSE](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/LICENSE) 为 Apache-2.0，其商标条款不能被解释为品牌授权。本文记录所读许可，不替 43 个产品宣布统一素材使用权。

实现时使用本地固定素材，保留许可/归属信息；SVG 不内联执行脚本、不接远程资源。图标加载失败显示产品名，不能影响 Harness 管理或用图标推断产品身份。

## 5. 本机核心验收建议

| 范围 | 必须证明 |
|---|---|
| 管理 recipe | 固定 package/version/bin；别名碰撞；多 bin；Python spec；缺 runtime；不可管理的系统入口 |
| 真实后台任务 | 同 key 重试/冲突；同目标竞争；排队后关闭页面；刷新重连；真实阶段；日志/下载上限；取消与 cleanup；进程非零/伪成功 |
| 私有目录 | 拒绝无标记非空目录、链接/归属变化、archive traversal、越界入口；不覆写个人配置和系统安装 |
| 升级与执行 | 安装后正式会话确实使用 managed 入口；运行中升级旧绑定继续旧槽；新槽验证失败不激活；持久指针损坏不回退系统 PATH |
| 外部兼容 | engines 不满足明确失败；缺 optional binary 或必要 scripts 不算完成；版本已变化后重新验收 |
| UI 与图标 | 安装按钮发真实管理请求；任务反馈/失败保留；官方身份与图标来源对应；窄屏/键盘；不可管理项有具体原因 |

## 6. 核心源码复核指纹

以下是调研采集阶段读取的源码文本指纹，与包元数据观察一起说明研究依据，不作为安装运行证据。工程实现、接受决定和真实验收分别由 ADR-012 与验证记录管理；不能把调研阶段未运行安装包的范围声明扩展为整个项目未进行真实安装。共享来源锁的后续纳入由主负责人统一维护。

| 固定来源文件 | SHA-256 |
|---|---|
| Magpie `331b692.../internal/agent/install.go` | `1f74227e0260d8ac594732dc297b3f6b2b005de2c9ac1229eb658b0715056f76` |
| Magpie `331b692.../internal/agent/cliupdate.go` | `7b393e9de4ba9fce4cc3aa77ef8f3590221748a1e9aad699a315e746c26786fd` |
| Magpie `331b692.../internal/proc/version.go` | `505e425263c4faf858c984b672035adf95b8ff1f1d94f34a74ce46d5f3c7b9f0` |
| Magpie `331b692.../internal/agent/icons.go` | `bacbe58621035a8397a77f251ef73bd0a3fcb9cc60503f1598156f535ee87525` |
| CC Switch `1f786da.../src-tauri/src/commands/misc.rs` | `3eeabb31859fd0701ce773aa039325bc9dc3fe40a6ca768b736fc0597297fcd8` |
| CC Switch `1f786da.../src/components/BrandIcons.tsx` | `51865d5f0ee3181869c04aee1301e5ba75963515629be49fe8693174c3e7a72a` |
| Lobe Icons `c385b2b.../LICENSE` | `add9d7531d1b21646317a8958e38fc727506fa39d24bdecb44154d943c82753a` |
