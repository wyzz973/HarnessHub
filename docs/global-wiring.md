# 全局接线

全局接线把本机已安装的 Agent 改为经 HarnessHub 网关调用模型：直接改写 Agent 自己的用户配置，并提供预览、备份、原子写、回读校验、逐字节还原与漂移检测。目标设计见 [04 Agent 平面第 4、5 节](proposals/oss/04-agent-plane.md#4-全局接线)；隔离接线（只为 Session 生成私有配置）仍由 [引擎独立配置](engine-configuration.md) 与 [统一模型下的引擎接线](model-gateway-engines.md) 描述，两者互不调用。

现状：库（`packages/agents/src/wiring/`）、守护进程的 `/api/v1/agents` 与 `/api/v1/profiles`、`hh agents|wire|use|unwire|profile`、终端界面 `hh tui` 与控制台的 Agent 页面已实现，并经正式守护进程入口与假上游端到端验证（写入的 Key 能调用网关，轮换与还原后旧 Key 被拒绝，隐藏的模型从该 Key 的 `/v1/models` 与 Agent 文件中消失）。各 Agent 的接线语义（Claude Code 的档位与 `[1m]`、Codex 的模型目录与 ChatGPT 模式、各 Agent 的模型元数据）按 Magpie（`yetone/magpie` `2e340f7`，`internal/agent/`）的写法实现；没有用真实 Agent 读取接线后的配置，也没有在 Windows 上运行过。控制台的 Agent 首页与详情提供模型、档位、effort、选项、隐藏模型、换 Key 与还原，Profile 页面提供保存、预览应用与删除（[控制台](../packages/console/README.md)）。

## 使用

```sh
pnpm exec hh agents                                   # 已安装、已接线、模型、漂移
pnpm exec hh wire codex deepseek/deepseek-chat        # 显示改动，确认后写入
pnpm exec hh use claude deepseek/deepseek-chat --yes  # 同 wire，不询问
pnpm exec hh wire claude anthropic/claude-opus-5-5 --tier haiku=deepseek/deepseek-chat --effort high
pnpm exec hh wire codex --option codexAuth=chatgpt    # 保留 ChatGPT 登录与默认模型，另列出网关的模型
pnpm exec hh wire codex --models deepseek/*,group/fast --yes
pnpm exec hh agents models opencode --hide openai/gpt-5   # 隐藏或 --show 显示模型
pnpm exec hh wire codex --rotate                      # 换一把新 Key，旧 Key 立即失效
pnpm exec hh unwire codex                             # 还原配置并吊销 Key
pnpm exec hh profile save work                        # 保存所有已接线 Agent 的模型选择
pnpm exec hh profile apply work                       # 显示改动，确认后一次切换
pnpm exec hh tui                                      # 终端界面：以上操作的交互版
```

`hh wire <agent> [model]` 先打印各文件的统一 diff（Key 显示为 `hhk_a_xxxx…`；HarnessHub 生成的整个文件只显示大小），确认后按这份预览写入：预览之后文件又被改动则以 5 退出、什么都不写；`--yes` 跳过确认，非交互且没有 `--yes` 时以 4 退出。省略的选择沿用当前接线：模型、`--tier NAME=REF`（Claude Code 的 `opus`、`sonnet`、`haiku`、`fable`、`subagent`）、`--effort LEVEL`（`--no-effort` 清除）、`--option NAME=VALUE` 与 `--models`。`--models` 给出 Agent 可列出的模型（`provider/model`、`provider/*`、`group/<id>` 或 `*`），缺省沿用当前列表，首次接线为 `*`：网关的全部模型，包括之后新增的。模型必须是网关提供的 Model Ref（provider 的公开模型）或 `group/<id>`。Agent 只在启动时读取配置，写入后需要重启正在运行的实例。控制台的 Agent 首页提供选择模型、预览改动、确认写入与还原，详情中另有档位、effort、选项、显示的模型与换 Key，并显示漂移与需要处理的标记。

### 终端界面

`hh tui` 是 Magpie 主界面的终端版（[ADR 0028](decisions/0028-terminal-ui.md)）：

```
  ◉ HarnessHub › agents

  ▸ Claude Code  ✓ wired     fake/sim-large  haiku fake/sim-small  effort high  ~/.claude/settings.json
    Codex CLI    not wired   —               effort —  codexAuth —

    21 not installed: Gemini CLI, Qwen Code, OpenCode, Pi, Crush, Kimi Code, MiMo Code, OmO, Hermes…

  ↑↓ agent  ·  ←→ field  ·  ↵ change  ·  s save profile  ·  p profiles  ·  r refresh  ·  u unwire
  f all agents  ·  q quit
```

每个已安装、只有配置目录或已接线的 Agent 一行：接线状态（`✓ wired`；`! files changed`、`! key revoked`、`! drift …` 等需要处理的标记，光标所在行的原因显示在状态行）、模型、Claude Code 的档位（未设置的档位只在光标停留时显示）、effort 与 Adapter 选项，光标所在行的右侧是它的配置文件。没有找到、也未接线的 Agent 折叠为一行，`f` 展开。`↑↓`（`j`/`k`）选 Agent，`←→`（`h`/`l`、Tab）选字段，`↵` 打开选择器：输入文字过滤（每个词须出现在 Model Ref、provider 名称或说明中，或按顺序出现在 Ref 中），模型按 provider 分组并显示上下文窗口与每百万 token 的输入/输出价格，路由组在最后，当前值与对该 Agent 隐藏的模型有标注。选定后取守护进程的接线预览，显示各文件的 diff（Key 已遮蔽），`y` 写入、`n` 或 Esc 放弃；选择当前已有的值且 Agent 状态正常时什么都不写（重新接线只会换一把 Key），有漂移或需要处理时照常预览，以修复它。`s` 输入名称保存 Profile，`p` 列出 Profile，回车预览各 Agent 的 diff 后确认应用；`u` 确认后还原 Agent 的文件并吊销 Key；`r` 重新读取；`q`、Esc 退出，Ctrl+C 任何时候都退出。

它只经 SDK 调用运行中的守护进程（与 `hh agents`、`hh wire`、`hh profile` 相同的接口），守护进程拒绝的操作显示在状态行；调用进行中按下的键（Ctrl+C 除外）被丢弃，提前键入的 `y` 不会确认尚未显示的预览。没有终端时以 2 退出并提示改用 `hh agents`，守护进程未运行时提示 `hh serve` 并以 3 退出；`q` 为 0，Ctrl+C 与 SIGINT 为 130，SIGTERM 为 143。界面使用备用屏幕与原始模式，窗口改变尺寸（SIGWINCH）时重绘，窄窗口截断行并把按键提示折成多行，小于 30×8 时只显示尺寸提示；`NO_COLOR` 非空时不输出颜色与样式，光标所在字段以方括号标出。退出、Ctrl+C、SIGINT、SIGTERM 与崩溃时都先恢复终端。不依赖第三方库；尚未在 Windows 终端中验证。

## 守护进程与 Key

`hh serve` 以当前用户的主目录与环境作为接线目录（`--wiring-home DIR` 改用另一个目录，此时忽略 shell 中的 `CODEX_HOME` 等目录变量）；以 `startHub` 启动而未给 `wiringHome` 的守护进程（测试与嵌入）拒绝全部接线操作（503 `AGENT_WIRING_UNAVAILABLE`），从不回落到账户的主目录。接口见 [API 实现参考](api/reference.md) 的 `agents` 各节：

| 接口 | 行为 |
|---|---|
| `GET /api/v1/agents`、`GET /api/v1/agents/{id}` | 每个 Adapter 的安装状态（PATH 上有其命令为 `installed`，只有配置目录为 `configured-only`；不执行 Agent）、可设置的 `capabilities`（档位、effort、选项）、接线的选择（模型、档位、effort、选项）、显示与隐藏的模型、Key 状态与漂移 |
| `POST /api/v1/agents/{id}/wiring/plan` | `{model?, models?, tiers?, effort?, options?}`；用一把不保存的临时 Key 计算预览，不写文件、不签发 Key |
| `POST /api/v1/agents/{id}/wiring` | 同上加 `expect`，`expect` 为确认过的预览 |
| `POST /api/v1/agents/{id}/wiring/rotate` | 以当前选择与模型列表重新接线；没有 Key 的旧记录（ADR 0030 之前的 ChatGPT 模式）得到第一把 Key |
| `DELETE /api/v1/agents/{id}/wiring` | 还原文件、吊销 Key、删除记录 |
| `PUT /api/v1/agents/{id}/models` | `{hidden}`：设置隐藏的模型，见下文 |
| `GET /api/v1/profiles`、`GET`/`PUT`/`DELETE /api/v1/profiles/{name}`、`POST .../{name}/plan`、`POST .../{name}/apply` | Profile，见下文 |

每次接线签发一把新的 `agent:<id>` Key，不过期：`modelAllow` 为模型列表（未含 `*` 时加上所选模型与各档模型），`modelDeny` 沿用当前的隐藏列表。Key 文本只经库写入 Agent 的配置文件，守护进程不保存（存储中只有哈希）。文件写入并回读校验、`WiringRecord`（含档位、effort 与选项）提交之后才吊销上一把 Key；任何一步失败都吊销新 Key，写入失败时已写文件恢复为写前字节。还原先恢复文件，再吊销 Key、删除记录；还原失败时记录与 Key 保留，可以重试。接线、换 Key、隐藏模型、Profile 与还原在守护进程内串行执行，库的跨进程锁另外阻止两个进程同时改写同一 Agent。

### 每个 Agent 的模型列表

Agent 的 Key 是它的模型列表（Magpie 的 `visible` 与 `hiddenModels`）：`modelAllow` 是白名单，默认 `*`；`modelDeny` 是黑名单，名单之外的模型（包括之后新增的）都显示。网关的 `/v1/models` 与调用、写进 Agent 文件的模型清单（OpenCode、Pi、Crush、Kimi 的模型条目，Codex 的模型目录，Claude 的 `CLAUDE_CODE_MODEL_CAPABILITIES`）都按同一组 `modelAllowed(allow, ref, deny)` 过滤网关的模型，所以两边一致。

`PUT /api/v1/agents/{id}/models {hidden}`（`hh agents models <id> --hide REF --show REF`）把 `modelDeny` 改为 `hidden`，不换 Key：守护进程从 Agent 的文件中读回它的 Key（`wiredKeyText`），以过滤后的列表经 `applyWiring` 重写这些文件，失败时把 `modelDeny` 改回原值。隐藏 Agent 正在用的模型或档位模型为 409 `AGENT_MODEL_IN_USE`；Agent 文件中已没有它的 Key（用户换掉了）为 409 `AGENT_KEY_NOT_IN_FILES`，需要 `--rotate`。网关新增模型后，网关立即对 Key 列出它，Agent 文件中的清单由目录同步更新（见下文）。

### 目录同步

按 Magpie 的 `SyncCatalog`：provider 保存或删除（包括模型列表刷新与元数据补齐）、路由组改动之后，以及网关从没有搜索后端变为有、或反过来之后（Codex 的 `web_search`，见下文），守护进程等改动停下 500 ms，再把每个已接线、有 Key 的 Agent 文件中的模型清单改写为该 Key 现在可见的模型。每个 Agent 走正常的计划与写入路径（备份、原子写、回读校验），沿用它文件里的 Key 与隐藏列表，与其他接线操作串行；清单没有变化时什么都不写。以下情况不改写该 Agent，并在 `GET /api/v1/agents` 的 `wiring.attention`（`hh agents` 的 DRIFT 列）标出原因，直到一次同步或接线操作成功：自 HarnessHub 上次写入后文件被改动（漂移，`AGENT_FILES_CHANGED`）、Key 已吊销或丢失（`AGENT_KEY_INACTIVE`）、文件中已没有它的 Key（`AGENT_KEY_NOT_IN_FILES`）、所选模型或档位模型已不在网关上（`AGENT_MODEL_UNAVAILABLE`）。`startHub` 的选项 `wiring: {autoSync: false}` 关闭同步（默认开启，由 `resolveWiringSettings` 解析，其他取值启动失败）；标记只在内存中，守护进程重启后由下一次同步重新得出。

### Profile

Profile 保存每个已接线 Agent 的模型选择（模型、档位、effort、选项），存于模型平面存储的 `wiring_profiles` 表（迁移 4）；隐藏的模型与 Key 不属于 Profile。`PUT /profiles/{name}` 以当前接线保存（同名替换）。`POST /profiles/{name}/plan` 对选择与当前接线不同的 Agent 计算接线预览；`POST /profiles/{name}/apply {expect}` 先确认每个不同的 Agent 都有确认过的预览（否则 409 `PROFILE_PLAN_STALE`，什么都不写），再逐个经接线的同一路径切换（新 Key、备份、原子写、回读校验），遇到第一个失败即停止，错误信息列出已切换的 Agent。不在 Profile 中的 Agent 不受影响；Profile 中未接线的 Agent 会被接线。`hh profile apply <name>` 显示各 Agent 的 diff，确认后应用。

## 库接口

入口是 `@harnesshub/agents/wiring/index`，调用方（守护进程）负责签发与吊销 Key、持久化 `WiringRecord`（[model-plane.ts](../packages/core/src/model-plane.ts)）：

| 函数 | 行为 |
|---|---|
| `planWiring(adapterId, target, ctx, {previous?})` | 只读。返回每个文件的键级变更与统一 diff；Key 显示为 `hhk_a_xxxx…`，被替换的旧 Key 值显示为 `<redacted>`，dotenv 文件不带上下文行。已按同样方式接线时 `changed: false` |
| `applyWiring(adapterId, target, ctx, {previous?, expect?})` | 在该 Adapter 的跨进程锁内重新计划；`expect` 为用户确认过的计划，文件哈希不一致即 `WIRING_CONCURRENT_MODIFICATION`。先保存原始字节，再逐个文件原子写并回读校验；任一步失败，已写文件恢复为写前字节，错误的 `rollback` 逐个报告。返回待持久化的记录 |
| `unwire(record, ctx)` | 文件哈希等于 `afterHash` 时写回原始字节（接线时新建的文件则删除，连同为它新建且仍为空的目录）；用户之后改过文件时，只把 HarnessHub 写过的键恢复为原值或删除，其余修改保留。可重复执行 |
| `detectAgent(adapterId, ctx)` | 只看 `ctx.env` 的 PATH 与 Adapter 的配置目录，判断 `installed`、`configured-only` 或 `not-found`；不执行任何程序 |
| `detectDrift(record, ctx, {baseUrl?})` | 只读。基址字段缺失、Key 字段缺失或换成别的 Key 为 `unwired`；基址指向别处为 `foreign-gateway`；其他写过的字段被改为 `replaced`，接线删除的条目又出现也是 `replaced`。基址按所选模型定位（Grok 每个模型一张表，只有所选模型那张的基址算基址字段）；列表按项、项内按键比较，Key 与基址同在一个列表中时（T3 Code 的 `environment`）换成别的 Key 记为 `unwired`。`bypassed` 与 `stale-key` 需要网关账本，不在本库 |
| `wiredKeyText(record, ctx)` | 只读。Agent 文件中当前的、属于 `record.keyId` 的 Key 文本（也在列表项与对象内查找）；用户换掉或删掉后为 undefined。用于不换 Key 地重写接线 |
| `resolveOptions(adapter, options)`、`isModelOptional(adapter, options)` | 补齐 Adapter 选项的默认值（未声明的选项或取值为 `WIRING_TARGET_INVALID`）；这组选项下 Agent 是否可以不指定模型、保留自己的模型 |

### 数组元素

有的 Agent 把 provider 或模型存为用户自己也会写入的数组的元素。键路径的最后一段可以是元素选择器：对象 `{match: {字段: 值}}`（所有字段相等的那个元素）或标量 `{equals: 值}`。设置时选中的元素原地替换，没有则追加在数组末尾（数组不存在时创建）；删除时只删这个元素（连同它自己的行与分隔逗号），其他元素的字节与顺序不变；选择器在中间时进入一个已存在的元素设置其中的字段。选择器选中多个元素为 `WIRING_UNSUPPORTED_STRUCTURE`。JSON 与 YAML 支持，TOML 与 dotenv 拒绝。Adapter 声明 `arrayRoot` 的 JSON 文件根也可以是列表，路径以选择器开头（WorkBuddy 的裸列表 `models.json`）；文件不存在时仍新建为对象。HarnessHub 拥有的是这些元素：重新接线时原地更新、新的追加在后、不再写的删除；还原时删除它们，或把它替换掉的用户元素按原值写回；元素被删或被改为漂移。备份清单的格式版本因此为 2（版本 1 仍可读取）。Adapter 可以经 `files.current(id)` 读取文件当前的内容、经 `files.exists(id)` 得知文件是否存在，用于依赖用户已有内容的设置（如只在用户保留了 `availableModels` 时把模型加入其中）；`target.now` 是上下文时钟给出的接线时间，供给条目盖时间戳的 Agent 使用。Adapter 不改动且不存在的文件不进入计划。

`target` 为 `{baseUrl, keyText, keyId, model?, models[], tiers?, effort?, options?}`：`baseUrl` 是网关根地址（如 `http://127.0.0.1:3180`），各 Adapter 按协议自行追加 `/v1`；`keyText` 必须是 `agent` 作用域且与 `keyId` 一致的 Gateway Key；`models` 带 `/v1/models` 的窗口、输出上限、推理档位（`efforts`）、图像输入（`images`）与网关可直通的原生协议（`nativeProtocols`），各档模型的元数据也从这里取。`tiers`、`effort` 与 `options` 必须是 Adapter 声明的（`WiringAdapter.tiers`、`efforts`、`options`），否则为 `WIRING_TARGET_INVALID`。Adapter 在这组选项下保留 Agent 自己的模型（`modelOptional`，如 Codex 的 `codexAuth: chatgpt`）时，`model` 可以不给，这时也不接受档位与 effort，记录中没有 `model`，Adapter 收到 `ownModel: true`；为防 Adapter 误用，库检查它的设置没有引用模型。`ctx` 为 `{home, dataDir, env?, clock?}`：`home` 必填，库从不读取 `os.homedir()` 或 `process.env`，Agent 的目录变量只来自显式的 `env`。

Adapter 的设置可以是 `{value}`，也可以是 `{remove: true}`：删除用户的条目，以免它覆盖接线（Claude 档位不同时的 `CLAUDE_CODE_SUBAGENT_MODEL`、设置 effort 时的 `CLAUDE_CODE_EFFORT_LEVEL`）；还原时同样恢复原值。`generated: true` 的文件（Codex 的模型目录）整个由 HarnessHub 生成，预览只显示大小；计划中超过 2000 字符的值被截断，diff 仍完整。

重新接线（例如轮换 Key）时传入 `previous`：沿用首次接线前的备份，因此之后还原仍回到 HarnessHub 接线之前的状态；新目标不再设置的旧键按原值恢复。若两次接线之间用户改过文件，新记录不再允许逐字节还原，改用键级还原，以免丢失这些修改。

## 备份与安全

- 备份在 `<dataDir>/backups/wiring/<adapterId>/`：`objects/<sha256>` 是原始字节，`manifests/<id>.json` 的 id 是清单内容的 SHA-256，记录原始文件是否存在、哈希、权限、为它新建的目录、HarnessHub 拥有的键，以及写入值的模板（Key 与基址以占位符表示，清单中没有 Key）。均为 0600，读取时校验哈希。首次版本永久保留，尚未实现“其余保留 20 份”的清理。
- 原子写：同目录临时文件、fsync、保留原权限、rename 前再核对哈希、目录 fsync；新文件为 0600，新目录为 0700。符号链接写其目标并保留链接；有多个硬链接时原地写。中断留下的临时文件在下次写入前清理。Windows 上 rename 遇共享冲突重试 5 次、间隔 100 ms（未在 Windows 上验证）。
- 拒绝写入：文件无法解析或不是 UTF-8、配置路径经符号链接离开 `home`（或该 Agent 的目录变量所指目录）、悬空或循环链接、目标键的上级是非对象值、Agent 尚未把旧文件迁入要新建的文件（omp 的 `models.json`），以及下文格式规则中的结构。错误信息只含文件路径、键路径与行列号，不含文件内容。
- 同一 Adapter 的接线与还原由 `.lock` 目录串行化；持有者崩溃留下的锁需在确认 `owner.json` 中的进程已退出后手工删除。

## 格式保真编辑

| 格式 | 做法 | 拒绝 |
|---|---|---|
| JSON/JSONC | `jsonc-parser` 解析取得节点偏移，按偏移拼接；新属性放在所在对象最后一个属性之后，沿用该行缩进、对象的尾逗号风格，内联对象保持单行，上一行末尾的注释留在原行；数组元素同样追加在最后一个元素之后，删除最后一个元素后容器收回为 `[]`/`{}` | 解析错误、根不是对象（声明 `arrayRoot` 的文件也可以是列表）、路径上的重复键、选中多个元素的选择器 |
| TOML | `smol-toml` 校验与回读，自带的行扫描器定位表头与赋值；只替换值、插入一行或删除条目的行。新键加在所在表（或点号键组）的最后一个赋值之后，缺失的表追加到文件末尾并以一个空行分隔，删除该表时一并删除这个空行 | 内联表与数组表中的键、数组中的表、非有限数、数组元素选择器 |
| YAML | `yaml` 的 Document API，保留注释、空行、键顺序与标量样式；序列化可能规范化流式集合内的空白，因此按值校验 | 多文档、根不是映射、路径上的锚点或别名、选中多个项的选择器 |
| dotenv | 按行编辑，保留 `export` 前缀与行尾注释；值为纯字符时不加引号，否则加单引号 | 未闭合的引号、重复赋值的目标变量、需要转义才能表达的值 |

BOM 与换行风格（LF/CRLF）保持原样。回读校验用真实解析器确认每个目标键的值，并确认去掉这些键后文档与写前相同。

## 支持的 Agent

“核实”表示配置位置或键名来自 HarnessHub 隔离接线或 04 的记录，尚未以固定版本的真实 Agent 验证全局接线。第二张表的 Adapter 依照 Magpie @2e340f7（MIT，[yetone/magpie](https://github.com/yetone/magpie)）的 `internal/agent/<agent>.go` 记录的配置位置与键名，同样未以真实 Agent 验证。

| Adapter | 文件（目录变量） | 写入的键 | 协议 | Key 落点 |
|---|---|---|---|---|
| `claude` Claude Code | `settings.json`（`${CLAUDE_CONFIG_DIR:-~/.claude}`） | `env.ANTHROPIC_BASE_URL`（网关根）、`env.ANTHROPIC_AUTH_TOKEN`、`env.ANTHROPIC_MODEL` 与顶层 `model`、`env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`env.ANTHROPIC_SMALL_FAST_MODEL`、`env.CLAUDE_CODE_SUBAGENT_MODEL`；已知时 `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`env.CLAUDE_CODE_MAX_OUTPUT_TOKENS`（至多 128000）、`env.CLAUDE_CODE_MODEL_CAPABILITIES`；effort 见下文 | Anthropic | 配置文件 |
| `codex` Codex CLI | `config.toml` 与 `harnesshub-models.json`（`${CODEX_HOME:-~/.codex}`） | `codexAuth: gateway-key`（默认）：`model_provider = "harnesshub"`、`model`、`model_catalog_json`、设置时 `model_reasoning_effort`；`[model_providers.harnesshub]` 的 `name`、`base_url`（`/v1`）、`wire_api = "responses"`、`experimental_bearer_token`；生成的模型目录。`codexAuth: chatgpt`：`openai_base_url = "<网关>/backend-api/codex/<Key>"`，指定模型时另有 `model` 与设置时的 `model_reasoning_effort` | Responses | 配置文件；ChatGPT 模式在基址路径中 |
| `gemini` Gemini CLI | `settings.json` 与 `.env`（`${GEMINI_CLI_HOME:-~}/.gemini`） | `security.auth.selectedType = "gemini-api-key"`、`model.name`、窗口已知且小于 1,048,576 时 `model.compressionThreshold`；`.env` 中 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`（网关根） | Gemini | Agent 自己加载的 dotenv |
| `qwen` Qwen Code | `settings.json` 与 `.env`（`${QWEN_HOME:-~/.qwen}`，核实） | `security.auth.selectedType = "openai"`、`model.name`、已知时 `model.generationConfig.contextWindowSize` 与 `samplingParams.max_tokens`；`.env` 中 `OPENAI_BASE_URL`（`/v1`）、`OPENAI_API_KEY`、`OPENAI_MODEL` | Chat | Agent 自己加载的 dotenv |
| `opencode` OpenCode | 已有的 `opencode.jsonc`，否则 `opencode.json`（`${OPENCODE_CONFIG_DIR}`，否则 `${XDG_CONFIG_HOME:-~/.config}/opencode`） | `provider.harnesshub`（`npm: @ai-sdk/openai-compatible`、`options.baseURL`、`options.apiKey`；每个模型的 `name`、窗口已知时的 `limit`（输出未知为 0，即 OpenCode 的默认）、图像输入时的 `attachment` 与 `modalities`、按推理档位的 `variants`）、`model` 与 `small_model` 为 `harnesshub/<ref>` | Chat | 配置文件 |
| `pi` Pi | `settings.json` 与 `models.json`（`${PI_CODING_AGENT_DIR:-~/.pi/agent}`） | `defaultProvider`、`defaultModel`、设置时 `defaultThinkingLevel`；`providers.harnesshub`（`baseUrl`、`api: openai-completions`、`apiKey`、`models[]` 含 `reasoning`、`input`、`thinkingLevelMap`、`contextWindow`、`maxTokens`，以及按原生协议的 `api`/`baseUrl`） | 逐模型 Chat、Responses 或 Anthropic | 配置文件（字面 `apiKey` 的解析方式核实） |
| `crush` Crush | `crush.json`（`${XDG_CONFIG_HOME:-~/.config}/crush`，Windows 为 `%LOCALAPPDATA%\crush`） | `providers.harnesshub`（`type: openai-compat`、`base_url`、`api_key`、`models[]` 含 `context_window`、`default_max_tokens`、`can_reason`、`reasoning_levels`、`default_reasoning_effort`、`supports_attachments`）、`models.large`（设置时含 `reasoning_effort`）、`models.small` | Chat | 配置文件 |
| `kimi` Kimi Code | `config.toml`（`${KIMI_SHARE_DIR:-~/.kimi}`，核实） | `default_model`；`[providers.harnesshub]`（`type = "openai_legacy"`、`base_url`、`api_key`）；窗口已知的每个模型一个 `[models."<ref>"]`（`provider`、`model`、`max_context_size`）。所选模型必须有窗口 | Chat | 配置文件 |

以下 Adapter 依照 Magpie @2e340f7，未以真实 Agent 验证；Key 写入配置文件（dsh 写入它自己加载的 `.env`）。Magpie 的网关不校验 Key（`magpie` 或 `magpie-<agent>`），HarnessHub 的网关要求 Agent 作用域的 Key，因此只收录能把 Key 写进配置的 Agent，且不写 Magpie 仅用于识别调用方的 `User-Agent` 头（Key 已标明 Agent）。推理档位、图片输入与 effort 按 Magpie 各自的写法写入（下表），输出上限不超过窗口；Agent 没有对应字段的不写（T3 Code 只列出 Claude Code 的模型）。除 omp 外，所有模型走表中的协议。

| Adapter | 文件（目录变量） | 写入的键 | 协议 | 说明 |
|---|---|---|---|---|
| `mimocode` MiMo Code | 已有的 `mimocode.jsonc`、`mimocode.json` 或 `config.json`，否则新建 `mimocode.json`（`$MIMOCODE_HOME/config`，否则 `${XDG_CONFIG_HOME:-~/.config}/mimocode`） | 与 `opencode` 相同 | Chat | OpenCode 的 fork，复用 `opencode` 的写入 |
| `omo` OmO | `settings.json` 与 `models.json`（`${OMO_CODING_AGENT_DIR:-${SENPI_CODING_AGENT_DIR:-~/.omo/agent}}`） | 与 `pi` 相同 | 逐模型 Chat、Responses 或 Anthropic | Pi 的 fork，复用 `pi` 的写入；与 Pi 共用 `PI_CODING_AGENT_DIR` 的目录由 `pi` 接线 |
| `omp` oh-my-pi | 已有的 `config.yml`/`config.yaml` 与 `models.yml`/`models.yaml`，否则新建 `.yml`；目录按 omp 的规则：`~/.omp`（`PI_CONFIG_DIR` 为相对主目录的替代）下 `profiles/<OMP_PROFILE 或 PI_PROFILE>/agent`，否则 `$PI_CODING_AGENT_DIR`，否则 `agent` | `models.yml` 的 `providers.harnesshub`（`baseUrl`、`api: openai-completions`、`apiKey`、`models[]` 含 `contextWindow`、`maxTokens`、`reasoning`、图片输入时的 `input`、有档位时的 `thinking`（`mode` 与 `efforts`），原生协议为 Responses 或 Anthropic 的模型带自己的 `api`/`baseUrl`）；`config.yml` 的 `modelRoles.default = "harnesshub/<ref>"`、设置时 `defaultThinkingLevel`（`none` 为 `off`） | 逐模型 Chat、Responses 或 Anthropic | Magpie 写 `auth: none`，这里按用户自有 provider 的写法写 `apiKey`；omp 尚未把旧 `models.json` 迁入 `models.yml` 时拒绝新建（`WIRING_UNSUPPORTED_STRUCTURE`）；16.4.0 之前的 omp 因 `max` 档位拒绝整个文件，所以最高档为 `max` 的模型列为 `xhigh` |
| `hermes` Hermes Agent | `config.yaml`（`${HERMES_HOME:-~/.hermes}`） | `providers.harnesshub`（`base_url`、`api_key`、`api_mode: chat_completions`、`models` 为 Ref 列表）、`model.provider`、`model.default`、设置时 `agent.reasoning_effort` | Chat | |
| `minimax-code` MiniMax Code | `config.yaml`（`${MINIMAX_DATA_DIR:-~/.minimax}`） | `custom_provider.harnesshub`（`kind: custom`、`enabled`、`api: anthropic-messages`、`options.apiKey`、`options.baseURL`（网关根）、`options.authMode: api-key`、每个模型的 `name`、已知的 `limit`、`reasoning`、有档位时的 `thinking.effortOptions`（有 `high` 时以它为默认）、图片输入时的 `capabilities.support_image`）、`defaultModel = "custom_provider:harnesshub/<ref>"` | Anthropic | 原有的 `defaultModelVariant` 不清除 |
| `grok` Grok Build | `config.toml`（`${GROK_HOME:-~/.grok}`） | 每个模型一张 `[model."harnesshub/<ref>"]`（`model`、`name`、`base_url`、`api_key`、`api_backend = "chat_completions"`、已知的 `context_window`、有档位时的 `reasoning_efforts`）；`[models] default`、设置时 `[models] default_reasoning_effort`；`[features] campaigns = false`，防止 xAI 的远程 campaign 改掉默认模型 | Chat | 漂移按所选模型那张表的 `base_url` 判断 `foreign-gateway` |
| `qoder` Qoder、`qoder-cn` Qoder CN | `settings.json`（`${QODER_CONFIG_DIR:-~/.qoder}`；`${QODERCN_CONFIG_DIR:-~/.qoder-cn}`） | `providers.harnesshub`（`protocol: openai`、`baseUrl`、`apiKey`、`model`、`models[]` 含 `capabilities`（`vision`、有档位时的 `thinking`）、`contextWindow`、`maxOutputTokens`）、`model.name = "harnesshub/<ref>"`；设置时所选模型的 `model.preferences."harnesshub/<ref>".reasoning.effort` 与旧版读取的 `model.reasoningEffort` | Chat | Qoder 只对已登录且套餐含 BYOK 的账号启用自定义 provider，否则接线不生效 |
| `cline` Cline CLI | `settings/providers.json` 与 `settings/models.json`（`$CLINE_DATA_DIR`，否则 `${CLINE_DIR:-~/.cline}/data`） | 接管内置的 `providers.openai-compatible`（Cline 拒绝自定义 provider，cline/cline#14180）：`settings` 的 `provider`、`apiKey`、`model`、`baseUrl`、设置时的 `reasoning`（`none` 为 `{enabled: false}`），`tokenSource: manual`；`lastUsedProvider`；`models.json` 同名条目的 `provider` 与 `models`（`capabilities` 含图片输入的 `images` 与有档位的 `reasoning`） | Chat | 新建的文件从 `{"version": 1}` 开始；原槽位在还原时按值写回；Magpie 写的 `updatedAt` 与 VS Code 扩展状态（`globalState.json`、`secrets.json`）不写 |
| `pencil` Pencil | `~/.pencil/models.json` | `providers.harnesshub`（Pi 格式，`api: openai-completions`、`apiKey`、每个模型带 Pencil 写的字段与 Pi 的 `reasoning`、`input`、`thinkingLevelMap`，窗口与输出未知时取 Pi 的默认值 128000 与 16384） | Chat | 只让模型出现在 Pencil 的选择器中，不写所选模型；没有命令，按 `~/.pencil` 判断安装 |
| `droid` Droid | `settings.json`（`${FACTORY_HOME_OVERRIDE:-~}/.factory`） | `customModels` 中每个模型一个元素，`id = "custom:harnesshub/<ref>"`（`model`、`displayName`、`baseUrl`、`apiKey`、`provider` 按原生协议为 `generic-chat-completion-api`、`openai` 或 `anthropic`（网关根）、已知的 `maxContextLimit`、`maxOutputTokens`、`noImageSupport`）；`sessionDefaultSettings.model` | 逐模型 Chat、Responses 或 Anthropic | 用户自己的 `customModels` 保持原位与顺序 |
| `workbuddy` WorkBuddy | `models.json`（`${WORKBUDDY_CONFIG_DIR:-~/.workbuddy}`） | `models`（文件为裸列表时即该列表）中每个模型一个元素，`{id: <ref>, vendor: "harnesshub"}`（`name`、`apiKey`、`url`（`/v1/chat/completions`）、已知的 `maxInputTokens`、`maxOutputTokens`（至多 128000）、`supportsToolCall`、`supportsImages`、`supportsReasoning`、有档位时的 `reasoning`）；用户保留了非空 `availableModels` 时，把模型 Ref 加入其中 | Chat | 只让模型出现在选择器中，不写所选模型；保持文件原有的形式（对象或裸列表，新建为对象），裸列表没有 `availableModels`；WorkBuddy 热加载，无需重启；没有命令，按目录判断安装 |
| `zcode` ZCode | `~/.zcode/v2/config.json` 与 `provider_config.json`（新建时 `{"schemaVersion": 1}`） | `config.json` 的 `provider.harnesshub`（`kind: anthropic`、`enabled`、`source: custom`、`options.apiKey`、`options.baseURL`（网关根）、每个模型的 `limit`、`modalities`、`reasoning`）；`provider_config.json` 中 `config.providerConfigRules.providerRules` 的 `{providerId: harnesshub}` 元素（`access`、`api: anthropic-messages`、`personalModelIds`、`modelOrder`）与 `config.modelConfigRules.providerModelRules` 中每个模型一个 `{providerId, modelId}` 元素（窗口、图片输入、输出上限、推理档位） | Anthropic | 用户手动设置过规则的模型（`manualProviderModelRules`）不写规则；在 ZCode 中关闭的 provider 保持关闭；只让模型出现在选择器中 |
| `claude-desktop` Claude Desktop | macOS `~/Library/Application Support`、Windows `%LOCALAPPDATA%`、其他 `${XDG_CONFIG_HOME:-~/.config}` 下的 `Claude-3p/configLibrary/<id>.json`、`Claude-3p/configLibrary/_meta.json`、`Claude-3p/claude_desktop_config.json`、`Claude/claude_desktop_config.json` | 配置文件 `inferenceProvider: gateway`、`inferenceGatewayBaseUrl`（网关根）、`inferenceGatewayApiKey`、`inferenceGatewayAuthScheme: bearer`，以及该文件尚未设置时的 `disableDeploymentModeChooser: true`、`coworkEgressAllowedHosts: ["*"]`；`_meta.json` 的 `entries` 元素与 `appliedId`；两个 `claude_desktop_config.json` 的 `deploymentMode: "3p"`（最后写） | Anthropic | Key 的 `modelIdStyle` 为 `claude-alias`：网关对它以 `claude-hh-<10 位数字>` 列出模型、显示名为 Model Ref，并接受这个别名（Desktop 只保留看起来属于 Anthropic 的 id）；还原时写回原 `deploymentMode` 与原 `appliedId`，其他配置项保留；Desktop 只在启动时读取 |
| `t3code` T3 Code | `userdata/settings.json`（`${T3CODE_HOME:-~/.t3}`） | `providerInstances.harnesshub`（`driver: claudeAgent`、`environment` 列表中的 `ANTHROPIC_BASE_URL`（网关根）与 `ANTHROPIC_AUTH_TOKEN`，均 `sensitive: false`；`config.customModels[]`） | Anthropic（经 Claude Code） | 只让模型出现在 T3 的选择器中；Claude Code 自己 `settings.json` 的 `env` 若指向别处仍然优先；没有命令，按 `~/.t3/userdata` 判断安装 |
| `openchamber` OpenChamber | `preferences.json` 与 `settings.json`（`${OPENCHAMBER_DATA_DIR:-~/.config/openchamber}`，不随 `XDG_CONFIG_HOME`），以及 OpenCode 的配置文件（与 `opencode` 相同） | OpenCode 配置中的 `provider.harnesshub-openchamber`（写法与 `opencode` 的 provider 相同，Key 是 OpenChamber 的）；`preferences.json` 存在时其 `fields.defaultModel = {value: "harnesshub-openchamber/<ref>", updatedAt}`，设置 effort 时 `fields.defaultVariant`（即模型按档位的 variant），否则删除 `defaultVariant`；`settings.json` 存在或没有 `preferences.json` 时，其顶层 `defaultModel` 与 `defaultVariant` 同样写入 | Chat | `updatedAt` 只在值改变时取接线时间；版本不是 1 的 `preferences.json` 被拒绝（`WIRING_UNSUPPORTED_STRUCTURE`）；与 `opencode` 的 `harnesshub` provider 在同一文件中各自接线与还原；项目自己的 `defaultModel` 仍优先 |
| `dsh` DeepSeek Harness | `settings.yaml` 与 `.env`（`${DSH_HOME:-~/.dsh}`） | `settings.yaml` 的 `llm-pi-ai.providers.harnesshub`（`displayName`、`apiKeyEnv: HARNESSHUB_GATEWAY_KEY`、`api: openai-completions`、`baseURL`（`/v1`）、`models[]` 含已知的 `contextWindow`、`maxTokens`、图片输入已知时的 `input`、`reasoningEfforts`（dsh 档位到 effort 的映射，只有 `off` 或没有档位时为 `false`））与 `agent-default-model`（`provider: harnesshub`、`model`、设置时 `reasoningEffort`，`none` 为 `off`）；`.env` 的 `HARNESSHUB_GATEWAY_KEY` | Chat | Agent 自己加载的 dotenv（dsh 先取进程环境与自己的 `.credentials.yaml`）。dsh 0.1.5 的 `settings.yaml` 叠加在各 profile 的补丁列表之上、实时读取，模型页面也写这里（逐叶修改，旁边的条目保持不变）。与 Magpie 的差异：Magpie 改写每个 profile 的 `cordis.patch.yml`，并每 30 秒重写一次；在 dsh 中另选模型会改写 `agent-default-model`，这里按漂移处理（`AGENT_FILES_CHANGED`，目录同步跳过它），重新接线或取消接线。HarnessHub 的执行平面以 dsh 自己的登录、引用 `~/.dsh` 启动 dsh 引擎时读同一个 `settings.yaml`，全局接线因此也改变这些 Run 的默认模型（Profile 指定了模型时 ACP 会话的选择优先）；使用托管 provider 或统一模型的 Run 用 Session 私有的 `DSH_HOME`，不受影响 |

未收录的 Magpie Agent：

| Agent | 原因 |
|---|---|
| `goose`、`cursor`、`copilot`、`devin` | Magpie 也不接网关，只切换它们自己的模型 |
| `alma`、`hanako` | 经运行中应用的本地 API 配置，不是文件接线。Hanako 未运行时可以写文件，但它启动时把 provider 定义从 `provider-catalog.json` 移到 `provider-plugins/` 下的另一文件（只留 Key），所写的条目每次启动后都像被改动；要改的模型在 `primaryAgent` 指向的 `agents/<id>/config.yaml` 中，文件位置取决于另一文件的内容 |
| `cindy` | 只生成导入链接，由用户在应用中确认 |
| `agy` | 只从环境变量读取端点与 Key，需要启动命令而非配置文件 |
| `commandcode`、`fx`、`muse` | 配置里无法写入 Key：Command Code 拒绝写入的 Key（Magpie 写 `apiKey: false`），fx 只见过 `auth: {type: "none"}`，Muse 的 `auth` 只能是 Meta 登录令牌或 `none`；Muse 还要求网关提供 `/muse-code/models` |

Shell 环境中已有的同名变量优先于 dotenv 文件（Gemini、Qwen），OpenCode 的 `OPENCODE_CONFIG_DIR` 与 Kimi 的 `OPENAI_*` 变量也会覆盖全局文件；这类绕过由漂移检测的网关证据（`bypassed`，尚未实现）发现。

**Gemini CLI 与代理**：设置了 `HTTPS_PROXY`（或 `https_proxy`、`HTTP_PROXY`、`http_proxy`）时，Gemini CLI 0.38.2 把全部请求交给这个代理，包括发往本机网关的请求，不理会 `NO_PROXY`（它以 undici 的 `ProxyAgent` 作为全局分发器，代理只取自这四个环境变量）。接线无法改变这一点：`settings.json` 没有代理设置，`~/.gemini/.env` 中的变量不覆盖已有的环境变量（[兼容性](compatibility.md)中的一致性套件实测：代理端口拒绝连接时，没有任何请求到达网关）。代理能够把 `127.0.0.1` 的请求转回本机时（多数本地代理会这样做）Gemini 仍可用；否则只对 Gemini 去掉代理变量启动，例如 `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy gemini`，或在 shell 中为它定义同样的别名。

所有 Adapter 交给 Agent 的输出上限都不超过模型窗口（有的目录把输出写得比窗口大）。推理档位来自模型平面：它只记录模型是否推理（`reasoning`），推理模型按 `low`、`medium`、`high` 写出；provider 与 models.dev 尚未提供逐模型的档位。

### Claude Code

按 Magpie 的 `claude.go`：

- 主模型写入 `ANTHROPIC_MODEL` 与顶层 `model`；四个档位 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` 未单独选择时跟随主模型，`ANTHROPIC_SMALL_FAST_MODEL` 跟随 haiku。`CLAUDE_CODE_SUBAGENT_MODEL` 为选择的 `subagent` 模型；没有选择时，各档都是主模型则写主模型，否则删除，以免一个模型覆盖子 Agent 要的档位。
- 窗口至少 1,000,000 的模型写成 `<ref>[1m]`（Claude Code 发请求前去掉标记；不加时它按 200K 处理并反复压缩）。
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是主模型的窗口；主模型带 `[1m]` 时取未标记档位中最小的已知窗口。未知时不写，用户原值保留。
- `CLAUDE_CODE_MODEL_CAPABILITIES` 为列表中有档位的模型写 `<ref>=effort[,xhigh_effort][,max_effort]`（小写，`;` 分隔，所选模型在前，至多 8000 字符）；Claude Code 已知的 Claude 模型只写它会发送的档位。
- effort：`max` 写 `CLAUDE_CODE_EFFORT_LEVEL`；其他档位删除该变量（它优先于设置），Claude 模型写 `modelSettings.<claude-name>.effortLevel`，Opus 5.5 之前的 Claude 模型与其他厂商的模型写顶层 `effortLevel`。Claude Code 接受 `low`、`medium`、`high`、`xhigh`、`max`。

### Codex 的两种模式

- `codexAuth: gateway-key`（默认）：HarnessHub 作为 `harnesshub` provider，Key 在 `experimental_bearer_token`。`model_catalog_json` 指向同目录的 `harnesshub-models.json`，由 HarnessHub 生成：每个列出的模型一项，按隔离接线已用固定版本 Codex 读取过的格式（`codex-models.ts`），带窗口、推理档位（默认 medium，其次 high，再其次第一个）、图像输入与 Codex 的默认指令。不再写 `model_context_window`（它对所有模型生效，切换模型后不再正确）。所选模型的 provider 不原生接收 Responses、且网关没有登记[搜索后端](gateway-features.md#联网搜索模拟)时另写 `web_search = "disabled"`：Codex 每轮都附带它的托管 `web_search` 工具，没有搜索后端的网关只能在原样转发到有该工具的 Responses provider 时服务它，转换到其他协议时整轮失败（用真实的 Codex 0.144.5 对 Chat Completions 上游实测发现，见 [兼容性](compatibility.md)）。登记了搜索后端时网关自己回答这个工具，`web_search` 不写（用户原有的值写回）；后端的有无变化后，目录同步随之改写 Codex 的文件。
- `codexAuth: chatgpt`（[ADR 0030](decisions/0030-codex-chatgpt-mode-models.md)）：用户的 ChatGPT 登录不动，写 `openai_base_url = "<网关>/backend-api/codex/<Key>"`。Codex 内置的 OpenAI provider 不能加请求头，所以签发的 agent Key 是基址路径的一段；网关在回环监听器上先去掉它，再处理请求。Codex 自己模型的请求带着它自己的登录原样转发到 `https://chatgpt.com/backend-api/codex`，按 provider `chatgpt-subscription` 记入账本；模型带 `/` 的请求（HarnessHub 的 Model Ref 或 `group/<id>`）由网关按 `/v1/responses` 服务，ChatGPT 的令牌被删掉，不会发往任何上游；`models` 返回 ChatGPT 的列表，后面接着该 Key 可用的模型（与 API 模式目录相同的条目）。没有指定模型时不写 `model`，Codex 用它自己的默认模型，也不接受档位与 effort；指定 HarnessHub 的模型时写 `model` 与设置时的 `model_reasoning_effort`，`hh wire codex --no-model`（请求的 `model: null`）回到 Codex 自己的模型。用户另设了非 OpenAI 的 `model_provider` 时这条路径不生效。两种模式互相切换时不沿用模型，HarnessHub 之前写的 provider、`model` 与目录条目恢复原值，旧 Key 被吊销。此前以 ChatGPT 模式接线、没有 Key 的记录照旧只转发，`hh wire codex --rotate` 给它签发 Key（预览显示基址加上掩码后的 Key）。
- Key 在 URL 路径中，而不是信任回环连接或按 User-Agent 识别 Codex：网关从不保存或输出它（账本、日志、错误、OTLP），只在回环上接受，无效时一律 401，还原时吊销；已知风险是 Codex 自己的调试日志可能记下这个 URL（[ADR 0030](decisions/0030-codex-chatgpt-mode-models.md)）。

两种模式都不读取 `~/.codex/auth.json`。

## 与 04 的差异与待做

- Crush 使用 `type: openai-compat`（Crush 对 OpenAI 兼容 Chat 端点的类型；04 写作 `openai`，Crush 以它表示 OpenAI 本身）。
- 与 Magpie 的差异：Pi 的 `thinkingLevelMap` 不能写 `null` 隐藏模型没有的档位（HarnessHub 的编辑器不写 `null`），改为映射到不高于它的最近档位；Codex 读 `CODEX_HOME`（Magpie 固定 `~/.codex`），且不读 `auth.json` 判断登录状态，模式由用户选择；Claude 的档位不支持 `<model>:<effort>` 固定档位 effort（网关不支持按成员固定 effort）；Pi 不把新模型加入用户的 `enabledModels`；Crush 未知窗口时不写默认值（Magpie 写 200000 与 16384）；Codex 的 ChatGPT 模式不写 `model`，只转发 Codex 自己的模型（Magpie 的 `codex_backend` 也在这条路径上提供它自己的模型）。
- Claude Desktop 与 Magpie 的差异：所有模型都以 `claude-hh-` 别名列出（Magpie 对已像 Claude 的 id 原样列出，并对有推理档位的模型用 `mythos-magpie-…` 或 `….anthropic.claude-…` 别名，让 Desktop 显示 effort 选择器，HarnessHub 尚未实现）；没有实现 Magpie 把 Desktop 的标题等小请求转回会话所选模型的 `desktopTurn`，也没有把这些别名的能力写进 Claude Code 的 `CLAUDE_CODE_MODEL_CAPABILITIES`；Windows 上不按 `Claude…` 前缀查找目录。
- OpenCode 在设置了 `OPENCODE_CONFIG_DIR` 时写入该目录，因为其中的文件覆盖全局配置。
- 漂移检测没有区分“另一个 HarnessHub 实例”与其他网关：基址不同一律为 `foreign-gateway`。
- 每次接线都签发新 Key，所以对已接线的 Agent 预览时，即使模型不变，Key 一项也显示为改动（04 第 4 节的“无变化时计划为空”只在不换 Key 时成立）。
- 未实现：OpenClaw（JSON5）、Copilot（env-launch）Adapter 与上文未收录的 Magpie Agent；备份保留数清理；接线前检查 Agent 是否在运行；`bypassed` 与 `stale-key` 漂移（需要网关账本）；“rename 前被并发修改”之外的写后篡改注入测试（04 第 9 节第 6 项）；Windows 验证；真实 Agent 的接线生效测试（第 5 项）。

## 验证

[tui.test.ts](../tests/integration/tui.test.ts) 经注入的终端（[tests/support/terminal.ts](../tests/support/terminal.ts)：记录原始模式的输入、可改变尺寸并发出 `resize` 的输出、按写入的转义序列重建的屏幕，未知序列使测试失败）对 `startHub`（临时 `wiringHome`、严格假上游、文件秘密后端）运行 `hh tui`：在字段间移动、选择器的分组、窗口与价格、过滤，预览期间文件不变，`y` 后 Codex 已接线且写入的 Key 从未出现在输出中；`n`、关闭选择器与预览生成期间提前键入的 `y` 都不写入：`home` 下的文件逐字节不变、不签发 Key，未接线时 `u` 被拒绝；Profile 保存、在界面中切走、再次选择当前值不写入也不签发 Key、预览并应用后模型与档位恢复，再次应用提示无需改动；`f` 展开未安装的 Agent、列表随光标滚动、折叠后光标回到第一行；改变尺寸后重绘、窄窗口不越界且提示折行、过小窗口的提示与恢复；`NO_COLOR` 下没有 SGR；`q`、Ctrl+C、SIGINT、SIGTERM、`exit` 与崩溃后终端恢复（原始模式关闭、离开备用屏幕、光标可见、监听器移除）；真实 `hh tui` 入口在没有终端时以 2 退出；守护进程未监听时 `runTui` 以 3 退出且不打开界面。`packages/cli/test/tui-terminal.test.ts` 覆盖按键解码、列宽、截断与样式。另在 macOS 的真实伪终端中运行过 `hh tui`（选择、预览、写入、SIGWINCH、退出码 0、退出前后 `stty -a` 相同），未写成自动测试。

[agents-wiring-sync.test.ts](../tests/integration/agents-wiring-sync.test.ts) 经 `startHub`（临时 `wiringHome`）与严格假上游：provider 增删模型与改窗口后，OpenCode 与 Droid 文件中的清单随之改写（Droid 用户自己的 `customModels` 保持在前），Key 不变且 `/v1/models` 一致；用户改过的 Pi 文件不被改写并标出 `AGENT_FILES_CHANGED`，所选模型离开网关的 Crush 标出 `AGENT_MODEL_UNAVAILABLE`，重新接线后清除；`wiring.autoSync: false` 时不改写；无效设置启动失败；Claude Desktop 的 Key 以别名列出模型、显示名为 Ref，别名（含 `[1m]`）与 Ref 都能调用。`packages/agents/test/wiring-arrays.test.ts` 用种子随机序列覆盖数组元素：JSON（多行、内联、CRLF 与尾逗号、空数组）与 YAML 中设置、替换、删除元素，与用户在任意位置增删自己的元素交错，每步核对整个数组与其他内容；只增删 HarnessHub 的元素后 JSON 字节与原文相同；以及 Droid 的接线、多轮重新接线（模型集合与 Key 变化）、用户在其间的增删与还原，核对用户元素与顺序、HarnessHub 元素的位置与漂移。Droid、WorkBuddy、ZCode、Claude Desktop 各有 `wiring-agent-<id>.test.ts`。

[codex-chatgpt-key.test.ts](../tests/integration/codex-chatgpt-key.test.ts) 经 `startHub`（临时 `wiringHome`、OTLP 收集器、debug 日志）与拒绝 Codex 登录请求头的假 provider：ChatGPT 模式写入的 Key 能调用网关的模型，错误的或没有 Key 时 401，轮换后旧 Key 与还原后的 Key 被拒绝，上游只收到 provider 的凭据，数据目录、配置目录、Agent 的 home 与 OTLP 导出中没有任何 Key、ChatGPT 令牌或账号 ID。`packages/agents/test/wiring-codex-legacy.test.ts` 覆盖没有 Key 的旧记录重新接线时的预览。

[agents-wiring-semantics.test.ts](../tests/integration/agents-wiring-semantics.test.ts) 经 `startHub`（临时 `wiringHome`）与严格假上游：Claude Code 的档位、1M 模型的 `[1m]`、未标记档位的窗口、能力与 effort，Key 能调用各档模型，档位清除后子 Agent 跟随主模型；Codex 的 ChatGPT 模式把 Key 写在 `openai_base_url` 的路径中，写入的 Key 能经 Codex 路径调用网关的模型、没有 Key 时 401，指定模型与 effort 后写入、`model: null` 还原用户原来的模型，API 模式生成模型目录，两种模式互相切换后旧 Key 失效、还原回原文件；隐藏与显示模型同时改变 Agent 文件中的清单和该 Key 的 `/v1/models` 与调用（403），Key 不变，网关新增的模型默认显示，真实 `hh agents models` 入口；Profile 保存、切走、应用后文件与保存时相同（Key 除外），过期的预览被拒绝，真实 `hh profile list|apply|rm` 入口。`packages/agents/test/wiring-semantics.test.ts` 在库层覆盖同样的语义与 Pi、OpenCode、Crush、Gemini 的元数据和 `wiredKeyText`。

[agents-wiring.test.ts](../tests/integration/agents-wiring.test.ts) 经 `startHub`（临时 `wiringHome`）与严格假上游：接线后从 Codex 配置文件读回基址与 Key 并成功调用网关；换 Key 后旧 Key 得到 401、新 Key 200；还原后文件逐字节一致且 Key 失效；手工修改后报告漂移并只撤销 HarnessHub 的项；预览后文件被改动时新 Key 被吊销；未接线、未知 Agent 与网关不提供的模型被拒绝；未设 `wiringHome` 的守护进程拒绝全部操作；真实 `hh` 入口的 `agents`、`wire`、`use`、`unwire` 只打印掩码后的 Key。`packages/agents/test/` 下：`wiring-formats.test.ts`（各编辑器的保留、拒绝与还原，以及每种格式 40 个种子的随机 set/remove 序列：每步按值核对目标键、其余内容与注释不变，JSON、TOML、dotenv 删除新增条目后字节与原文相同）；`wiring-adapters.test.ts`（每个 Adapter：空目录与已有配置的金样、逐字节还原、用户改动后的键级还原、解析失败拒绝、符号链接逃逸拒绝、漂移、Key 轮换后还原，金样在 `wiring-golden.ts`）；依照 Magpie 的 Adapter 各有 `wiring-agent-<id>.test.ts`，经 `wiring-suite.ts` 运行同样的用例，另核对声明的协议、命令、文件与目录变量，金样与已有配置写在各自文件中（接管用户对象的 Cline 在键级还原后按值比较），并有各自的特例：MiMo 的候选文件顺序、Cline 新建文件的版本号、Grok 按所选模型判断基址、omp 的目录规则与未迁移拒绝、T3 Code 列表内的 Key 与基址漂移、Pencil 与 T3 Code 按目录判断安装；`wiring-safety.test.ts`（目录内符号链接、硬链接、只读文件与权限、BOM 与 CRLF、非 UTF-8、预览后被修改、写入失败回滚、锁、残留临时文件、目录变量、目标与上下文校验、预览掩码、损坏的备份）。测试只使用临时目录作为 `home`，Key 为合成值，不访问网络。
