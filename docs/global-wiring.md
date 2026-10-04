# 全局接线

全局接线把本机已安装的 Agent 改为经 HarnessHub 网关调用模型：直接改写 Agent 自己的用户配置，并提供预览、备份、原子写、回读校验、逐字节还原与漂移检测。目标设计见 [04 Agent 平面第 4、5 节](proposals/oss/04-agent-plane.md#4-全局接线)；隔离接线（只为 Session 生成私有配置）仍由 [引擎独立配置](engine-configuration.md) 与 [统一模型下的引擎接线](model-gateway-engines.md) 描述，两者互不调用。

现状：库（`packages/agents/src/wiring/`）、守护进程的 `/api/v1/agents` 与 `/api/v1/profiles`、`hh agents|wire|use|unwire|profile` 与控制台的 Agent 页面已实现，并经正式守护进程入口与假上游端到端验证（写入的 Key 能调用网关，轮换与还原后旧 Key 被拒绝，隐藏的模型从该 Key 的 `/v1/models` 与 Agent 文件中消失）。各 Agent 的接线语义（Claude Code 的档位与 `[1m]`、Codex 的模型目录与 ChatGPT 模式、各 Agent 的模型元数据）按 Magpie（`yetone/magpie` `2e340f7`，`internal/agent/`）的写法实现；没有用真实 Agent 读取接线后的配置，也没有在 Windows 上运行过。控制台尚未提供档位、effort、选项、隐藏模型与 Profile 的操作。

## 使用

```sh
pnpm exec hh agents                                   # 已安装、已接线、模型、漂移
pnpm exec hh wire codex deepseek/deepseek-chat        # 显示改动，确认后写入
pnpm exec hh use claude deepseek/deepseek-chat --yes  # 同 wire，不询问
pnpm exec hh wire claude anthropic/claude-opus-5-5 --tier haiku=deepseek/deepseek-chat --effort high
pnpm exec hh wire codex --option codexAuth=chatgpt    # 保留 ChatGPT 登录，只经网关转发
pnpm exec hh wire codex --models deepseek/*,group/fast --yes
pnpm exec hh agents models opencode --hide openai/gpt-5   # 隐藏或 --show 显示模型
pnpm exec hh wire codex --rotate                      # 换一把新 Key，旧 Key 立即失效
pnpm exec hh unwire codex                             # 还原配置并吊销 Key
pnpm exec hh profile save work                        # 保存所有已接线 Agent 的模型选择
pnpm exec hh profile apply work                       # 显示改动，确认后一次切换
```

`hh wire <agent> [model]` 先打印各文件的统一 diff（Key 显示为 `hhk_a_xxxx…`；HarnessHub 生成的整个文件只显示大小），确认后按这份预览写入：预览之后文件又被改动则以 5 退出、什么都不写；`--yes` 跳过确认，非交互且没有 `--yes` 时以 4 退出。省略的选择沿用当前接线：模型、`--tier NAME=REF`（Claude Code 的 `opus`、`sonnet`、`haiku`、`fable`、`subagent`）、`--effort LEVEL`（`--no-effort` 清除）、`--option NAME=VALUE` 与 `--models`。`--models` 给出 Agent 可列出的模型（`provider/model`、`provider/*`、`group/<id>` 或 `*`），缺省沿用当前列表，首次接线为 `*`：网关的全部模型，包括之后新增的。模型必须是网关提供的 Model Ref（provider 的公开模型）或 `group/<id>`。Agent 只在启动时读取配置，写入后需要重启正在运行的实例。控制台的“Agent”页面提供选择模型与显示的模型、预览改动、确认写入、换 Key、还原，并显示漂移标记。

## 守护进程与 Key

`hh serve` 以当前用户的主目录与环境作为接线目录（`--wiring-home DIR` 改用另一个目录，此时忽略 shell 中的 `CODEX_HOME` 等目录变量）；以 `startHub` 启动而未给 `wiringHome` 的守护进程（测试与嵌入）拒绝全部接线操作（503 `AGENT_WIRING_UNAVAILABLE`），从不回落到账户的主目录。接口见 [API 实现参考](api/reference.md) 的 `agents` 各节：

| 接口 | 行为 |
|---|---|
| `GET /api/v1/agents`、`GET /api/v1/agents/{id}` | 每个 Adapter 的安装状态（PATH 上有其命令为 `installed`，只有配置目录为 `configured-only`；不执行 Agent）、可设置的 `capabilities`（档位、effort、选项）、接线的选择（模型、档位、effort、选项）、显示与隐藏的模型、Key 状态与漂移 |
| `POST /api/v1/agents/{id}/wiring/plan` | `{model?, models?, tiers?, effort?, options?}`；用一把不保存的临时 Key 计算预览，不写文件、不签发 Key |
| `POST /api/v1/agents/{id}/wiring` | 同上加 `expect`，`expect` 为确认过的预览 |
| `POST /api/v1/agents/{id}/wiring/rotate` | 以当前选择与模型列表重新接线；自己登录、没有 Key 的 Agent 为 409 `AGENT_KEYLESS` |
| `DELETE /api/v1/agents/{id}/wiring` | 还原文件、吊销 Key、删除记录 |
| `PUT /api/v1/agents/{id}/models` | `{hidden}`：设置隐藏的模型，见下文 |
| `GET /api/v1/profiles`、`GET`/`PUT`/`DELETE /api/v1/profiles/{name}`、`POST .../{name}/plan`、`POST .../{name}/apply` | Profile，见下文 |

每次接线签发一把新的 `agent:<id>` Key，不过期：`modelAllow` 为模型列表（未含 `*` 时加上所选模型与各档模型），`modelDeny` 沿用当前的隐藏列表。Key 文本只经库写入 Agent 的配置文件，守护进程不保存（存储中只有哈希）。文件写入并回读校验、`WiringRecord`（含档位、effort 与选项）提交之后才吊销上一把 Key；任何一步失败都吊销新 Key，写入失败时已写文件恢复为写前字节。还原先恢复文件，再吊销 Key、删除记录；还原失败时记录与 Key 保留，可以重试。接线、换 Key、隐藏模型、Profile 与还原在守护进程内串行执行，库的跨进程锁另外阻止两个进程同时改写同一 Agent。

### 每个 Agent 的模型列表

Agent 的 Key 是它的模型列表（Magpie 的 `visible` 与 `hiddenModels`）：`modelAllow` 是白名单，默认 `*`；`modelDeny` 是黑名单，名单之外的模型（包括之后新增的）都显示。网关的 `/v1/models` 与调用、写进 Agent 文件的模型清单（OpenCode、Pi、Crush、Kimi 的模型条目，Codex 的模型目录，Claude 的 `CLAUDE_CODE_MODEL_CAPABILITIES`）都按同一组 `modelAllowed(allow, ref, deny)` 过滤网关的模型，所以两边一致。

`PUT /api/v1/agents/{id}/models {hidden}`（`hh agents models <id> --hide REF --show REF`）把 `modelDeny` 改为 `hidden`，不换 Key：守护进程从 Agent 的文件中读回它的 Key（`wiredKeyText`），以过滤后的列表经 `applyWiring` 重写这些文件，失败时把 `modelDeny` 改回原值。隐藏 Agent 正在用的模型或档位模型为 409 `AGENT_MODEL_IN_USE`；Agent 文件中已没有它的 Key（用户换掉了）为 409 `AGENT_KEY_NOT_IN_FILES`，需要 `--rotate`。网关新增模型后，网关立即对 Key 列出它；Agent 文件中的清单要到下次接线或隐藏操作时才更新（尚未实现 Magpie 的自动同步）。

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
| `resolveOptions(adapter, options)`、`isKeyless(adapter, options)` | 补齐 Adapter 选项的默认值（未声明的选项或取值为 `WIRING_TARGET_INVALID`）；这组选项下 Agent 是否自己登录、不用 Key |

`target` 为 `{baseUrl, keyText?, keyId?, model?, models[], tiers?, effort?, options?}`：`baseUrl` 是网关根地址（如 `http://127.0.0.1:3180`），各 Adapter 按协议自行追加 `/v1`；`keyText` 必须是 `agent` 作用域且与 `keyId` 一致的 Gateway Key；`models` 带 `/v1/models` 的窗口、输出上限、推理档位（`efforts`）、图像输入（`images`）与网关可直通的原生协议（`nativeProtocols`），各档模型的元数据也从这里取。`tiers`、`effort` 与 `options` 必须是 Adapter 声明的（`WiringAdapter.tiers`、`efforts`、`options`），否则为 `WIRING_TARGET_INVALID`。Adapter 在这组选项下自己登录（`keyless`，如 Codex 的 `codexAuth: chatgpt`）时不接受 Key、模型、档位与 effort，记录中也没有 `keyId` 与 `model`；为防 Adapter 误用，库检查它的设置没有引用 Key 或模型。`ctx` 为 `{home, dataDir, env?, clock?}`：`home` 必填，库从不读取 `os.homedir()` 或 `process.env`，Agent 的目录变量只来自显式的 `env`。

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
| JSON/JSONC | `jsonc-parser` 解析取得节点偏移，按偏移拼接；新属性放在所在对象最后一个属性之后，沿用该行缩进、对象的尾逗号风格，内联对象保持单行，上一行末尾的注释留在原行 | 解析错误、根不是对象、路径上的重复键 |
| TOML | `smol-toml` 校验与回读，自带的行扫描器定位表头与赋值；只替换值、插入一行或删除条目的行。新键加在所在表（或点号键组）的最后一个赋值之后，缺失的表追加到文件末尾并以一个空行分隔，删除该表时一并删除这个空行 | 内联表与数组表中的键、数组中的表、非有限数 |
| YAML | `yaml` 的 Document API，保留注释、空行、键顺序与标量样式；序列化可能规范化流式集合内的空白，因此按值校验 | 多文档、根不是映射、路径上的锚点或别名 |
| dotenv | 按行编辑，保留 `export` 前缀与行尾注释；值为纯字符时不加引号，否则加单引号 | 未闭合的引号、重复赋值的目标变量、需要转义才能表达的值 |

BOM 与换行风格（LF/CRLF）保持原样。回读校验用真实解析器确认每个目标键的值，并确认去掉这些键后文档与写前相同。

## 支持的 Agent

“核实”表示配置位置或键名来自 HarnessHub 隔离接线或 04 的记录，尚未以固定版本的真实 Agent 验证全局接线。第二张表的 Adapter 依照 Magpie @2e340f7（MIT，[yetone/magpie](https://github.com/yetone/magpie)）的 `internal/agent/<agent>.go` 记录的配置位置与键名，同样未以真实 Agent 验证。

| Adapter | 文件（目录变量） | 写入的键 | 协议 | Key 落点 |
|---|---|---|---|---|
| `claude` Claude Code | `settings.json`（`${CLAUDE_CONFIG_DIR:-~/.claude}`） | `env.ANTHROPIC_BASE_URL`（网关根）、`env.ANTHROPIC_AUTH_TOKEN`、`env.ANTHROPIC_MODEL` 与顶层 `model`、`env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`env.ANTHROPIC_SMALL_FAST_MODEL`、`env.CLAUDE_CODE_SUBAGENT_MODEL`；已知时 `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`env.CLAUDE_CODE_MAX_OUTPUT_TOKENS`（至多 128000）、`env.CLAUDE_CODE_MODEL_CAPABILITIES`；effort 见下文 | Anthropic | 配置文件 |
| `codex` Codex CLI | `config.toml` 与 `harnesshub-models.json`（`${CODEX_HOME:-~/.codex}`） | `codexAuth: gateway-key`（默认）：`model_provider = "harnesshub"`、`model`、`model_catalog_json`、设置时 `model_reasoning_effort`；`[model_providers.harnesshub]` 的 `name`、`base_url`（`/v1`）、`wire_api = "responses"`、`experimental_bearer_token`；生成的模型目录。`codexAuth: chatgpt`：只有 `openai_base_url = "<网关>/backend-api/codex"` | Responses | 配置文件；ChatGPT 模式无 Key |
| `gemini` Gemini CLI | `settings.json` 与 `.env`（`${GEMINI_CLI_HOME:-~}/.gemini`） | `security.auth.selectedType = "gemini-api-key"`、`model.name`、窗口已知且小于 1,048,576 时 `model.compressionThreshold`；`.env` 中 `GEMINI_API_KEY`、`GOOGLE_GEMINI_BASE_URL`（网关根） | Gemini | Agent 自己加载的 dotenv |
| `qwen` Qwen Code | `settings.json` 与 `.env`（`${QWEN_HOME:-~/.qwen}`，核实） | `security.auth.selectedType = "openai"`、`model.name`、已知时 `model.generationConfig.contextWindowSize` 与 `samplingParams.max_tokens`；`.env` 中 `OPENAI_BASE_URL`（`/v1`）、`OPENAI_API_KEY`、`OPENAI_MODEL` | Chat | Agent 自己加载的 dotenv |
| `opencode` OpenCode | 已有的 `opencode.jsonc`，否则 `opencode.json`（`${OPENCODE_CONFIG_DIR}`，否则 `${XDG_CONFIG_HOME:-~/.config}/opencode`） | `provider.harnesshub`（`npm: @ai-sdk/openai-compatible`、`options.baseURL`、`options.apiKey`；每个模型的 `name`、窗口已知时的 `limit`（输出未知为 0，即 OpenCode 的默认）、图像输入时的 `attachment` 与 `modalities`、按推理档位的 `variants`）、`model` 与 `small_model` 为 `harnesshub/<ref>` | Chat | 配置文件 |
| `pi` Pi | `settings.json` 与 `models.json`（`${PI_CODING_AGENT_DIR:-~/.pi/agent}`） | `defaultProvider`、`defaultModel`、设置时 `defaultThinkingLevel`；`providers.harnesshub`（`baseUrl`、`api: openai-completions`、`apiKey`、`models[]` 含 `reasoning`、`input`、`thinkingLevelMap`、`contextWindow`、`maxTokens`，以及按原生协议的 `api`/`baseUrl`） | 逐模型 Chat、Responses 或 Anthropic | 配置文件（字面 `apiKey` 的解析方式核实） |
| `crush` Crush | `crush.json`（`${XDG_CONFIG_HOME:-~/.config}/crush`，Windows 为 `%LOCALAPPDATA%\crush`） | `providers.harnesshub`（`type: openai-compat`、`base_url`、`api_key`、`models[]` 含 `context_window`、`default_max_tokens`、`can_reason`、`reasoning_levels`、`default_reasoning_effort`、`supports_attachments`）、`models.large`（设置时含 `reasoning_effort`）、`models.small` | Chat | 配置文件 |
| `kimi` Kimi Code | `config.toml`（`${KIMI_SHARE_DIR:-~/.kimi}`，核实） | `default_model`；`[providers.harnesshub]`（`type = "openai_legacy"`、`base_url`、`api_key`）；窗口已知的每个模型一个 `[models."<ref>"]`（`provider`、`model`、`max_context_size`）。所选模型必须有窗口 | Chat | 配置文件 |

以下 Adapter 依照 Magpie @2e340f7，未以真实 Agent 验证；Key 一律写入配置文件。Magpie 的网关不校验 Key（`magpie` 或 `magpie-<agent>`），HarnessHub 的网关要求 Agent 作用域的 Key，因此只收录能把 Key 写进配置的 Agent，且不写 Magpie 仅用于识别调用方的 `User-Agent` 头（Key 已标明 Agent）。`WiringModel` 只有窗口与输出上限，Magpie 按模型写入的推理档位、图片输入与按原生 API 逐模型选择协议（Pi、omp 的 `openai-responses`/`anthropic-messages`）一律不写，所有模型走表中的协议。

| Adapter | 文件（目录变量） | 写入的键 | 协议 | 说明 |
|---|---|---|---|---|
| `mimocode` MiMo Code | 已有的 `mimocode.jsonc`、`mimocode.json` 或 `config.json`，否则新建 `mimocode.json`（`$MIMOCODE_HOME/config`，否则 `${XDG_CONFIG_HOME:-~/.config}/mimocode`） | 与 `opencode` 相同 | Chat | OpenCode 的 fork，复用 `opencode` 的写入 |
| `omo` OmO | `settings.json` 与 `models.json`（`${OMO_CODING_AGENT_DIR:-${SENPI_CODING_AGENT_DIR:-~/.omo/agent}}`） | 与 `pi` 相同 | 逐模型 Chat、Responses 或 Anthropic | Pi 的 fork，复用 `pi` 的写入；与 Pi 共用 `PI_CODING_AGENT_DIR` 的目录由 `pi` 接线 |
| `omp` oh-my-pi | 已有的 `config.yml`/`config.yaml` 与 `models.yml`/`models.yaml`，否则新建 `.yml`；目录按 omp 的规则：`~/.omp`（`PI_CONFIG_DIR` 为相对主目录的替代）下 `profiles/<OMP_PROFILE 或 PI_PROFILE>/agent`，否则 `$PI_CODING_AGENT_DIR`，否则 `agent` | `models.yml` 的 `providers.harnesshub`（`baseUrl`、`api: openai-completions`、`apiKey`、`models[]` 含 `contextWindow`、`maxTokens`）；`config.yml` 的 `modelRoles.default = "harnesshub/<ref>"` | Chat | Magpie 写 `auth: none`，这里按用户自有 provider 的写法写 `apiKey`；omp 尚未把旧 `models.json` 迁入 `models.yml` 时拒绝新建（`WIRING_UNSUPPORTED_STRUCTURE`） |
| `hermes` Hermes Agent | `config.yaml`（`${HERMES_HOME:-~/.hermes}`） | `providers.harnesshub`（`base_url`、`api_key`、`api_mode: chat_completions`、`models` 为 Ref 列表）、`model.provider`、`model.default` | Chat | |
| `minimax-code` MiniMax Code | `config.yaml`（`${MINIMAX_DATA_DIR:-~/.minimax}`） | `custom_provider.harnesshub`（`kind: custom`、`enabled`、`api: anthropic-messages`、`options.apiKey`、`options.baseURL`（网关根）、`options.authMode: api-key`、每个模型的 `name`、已知的 `limit`、`reasoning: false`）、`defaultModel = "custom_provider:harnesshub/<ref>"` | Anthropic | 原有的 `defaultModelVariant` 不清除 |
| `grok` Grok Build | `config.toml`（`${GROK_HOME:-~/.grok}`） | 每个模型一张 `[model."harnesshub/<ref>"]`（`model`、`name`、`base_url`、`api_key`、`api_backend = "chat_completions"`、已知的 `context_window`）；`[models] default`；`[features] campaigns = false`，防止 xAI 的远程 campaign 改掉默认模型 | Chat | 漂移按所选模型那张表的 `base_url` 判断 `foreign-gateway` |
| `qoder` Qoder、`qoder-cn` Qoder CN | `settings.json`（`${QODER_CONFIG_DIR:-~/.qoder}`；`${QODERCN_CONFIG_DIR:-~/.qoder-cn}`） | `providers.harnesshub`（`protocol: openai`、`baseUrl`、`apiKey`、`model`、`models[]` 含 `capabilities`、`contextWindow`、`maxOutputTokens`）、`model.name = "harnesshub/<ref>"` | Chat | Qoder 只对已登录且套餐含 BYOK 的账号启用自定义 provider，否则接线不生效 |
| `cline` Cline CLI | `settings/providers.json` 与 `settings/models.json`（`$CLINE_DATA_DIR`，否则 `${CLINE_DIR:-~/.cline}/data`） | 接管内置的 `providers.openai-compatible`（Cline 拒绝自定义 provider，cline/cline#14180）：`settings` 的 `provider`、`apiKey`、`model`、`baseUrl`，`tokenSource: manual`；`lastUsedProvider`；`models.json` 同名条目的 `provider` 与 `models` | Chat | 新建的文件从 `{"version": 1}` 开始；原槽位在还原时按值写回；Magpie 写的 `updatedAt` 与 VS Code 扩展状态（`globalState.json`、`secrets.json`）不写 |
| `pencil` Pencil | `~/.pencil/models.json` | `providers.harnesshub`（Pi 格式，`api: openai-completions`、`apiKey`、每个模型带 Pencil 写的字段，窗口与输出未知时取 Pi 的默认值 128000 与 16384） | Chat | 只让模型出现在 Pencil 的选择器中，不写所选模型；没有命令，按 `~/.pencil` 判断安装 |
| `t3code` T3 Code | `userdata/settings.json`（`${T3CODE_HOME:-~/.t3}`） | `providerInstances.harnesshub`（`driver: claudeAgent`、`environment` 列表中的 `ANTHROPIC_BASE_URL`（网关根）与 `ANTHROPIC_AUTH_TOKEN`，均 `sensitive: false`；`config.customModels[]`） | Anthropic（经 Claude Code） | 只让模型出现在 T3 的选择器中；Claude Code 自己 `settings.json` 的 `env` 若指向别处仍然优先；没有命令，按 `~/.t3/userdata` 判断安装 |

未收录的 Magpie Agent：

| Agent | 原因 |
|---|---|
| `goose`、`cursor`、`copilot`、`devin` | Magpie 也不接网关，只切换它们自己的模型 |
| `alma`、`hanako` | 经运行中应用的本地 API 配置（Hanako 未运行时才写文件），不是文件接线 |
| `cindy` | 只生成导入链接，由用户在应用中确认 |
| `agy` | 只从环境变量读取端点与 Key，需要启动命令而非配置文件 |
| `commandcode`、`fx`、`muse` | 配置里无法写入 Key：Command Code 拒绝写入的 Key（Magpie 写 `apiKey: false`），fx 只见过 `auth: {type: "none"}`，Muse 的 `auth` 只能是 Meta 登录令牌或 `none`；Muse 还要求网关提供 `/muse-code/models` |
| `droid`、`workbuddy`、`zcode`、`claude-desktop` | 要在用户自己的数组中追加或删除 HarnessHub 的元素（Droid 的 `customModels`、WorkBuddy 的模型列表、ZCode 3.14 起的 `provider_config.json` 规则、Claude Desktop 的 `configLibrary/_meta.json` 的 `entries`）；格式编辑器只按对象键寻址，整体替换数组会在还原时丢掉用户之后加入的元素。Claude Desktop 另需网关为它改写模型 id（Magpie 的 `gw/desktop.go`） |
| `dsh` | 补丁文件的根是 YAML 列表、各 profile 一份（文件集合随 profile 变化），且 dsh 会改写条目，Magpie 每 30 秒重写一次 |
| `openchamber` | provider 写在 OpenCode 的配置文件里，与 `opencode` Adapter 共用同一文件与键；`preferences.json` 还要写当前时间。用 `opencode` 接线即可，OpenChamber 没有自己的默认模型时沿用 OpenCode 的 |

Shell 环境中已有的同名变量优先于 dotenv 文件（Gemini、Qwen），OpenCode 的 `OPENCODE_CONFIG_DIR` 与 Kimi 的 `OPENAI_*` 变量也会覆盖全局文件；这类绕过由漂移检测的网关证据（`bypassed`，尚未实现）发现。

所有 Adapter 交给 Agent 的输出上限都不超过模型窗口（有的目录把输出写得比窗口大）。推理档位来自模型平面：它只记录模型是否推理（`reasoning`），推理模型按 `low`、`medium`、`high` 写出；provider 与 models.dev 尚未提供逐模型的档位。

### Claude Code

按 Magpie 的 `claude.go`：

- 主模型写入 `ANTHROPIC_MODEL` 与顶层 `model`；四个档位 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` 未单独选择时跟随主模型，`ANTHROPIC_SMALL_FAST_MODEL` 跟随 haiku。`CLAUDE_CODE_SUBAGENT_MODEL` 为选择的 `subagent` 模型；没有选择时，各档都是主模型则写主模型，否则删除，以免一个模型覆盖子 Agent 要的档位。
- 窗口至少 1,000,000 的模型写成 `<ref>[1m]`（Claude Code 发请求前去掉标记；不加时它按 200K 处理并反复压缩）。
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是主模型的窗口；主模型带 `[1m]` 时取未标记档位中最小的已知窗口。未知时不写，用户原值保留。
- `CLAUDE_CODE_MODEL_CAPABILITIES` 为列表中有档位的模型写 `<ref>=effort[,xhigh_effort][,max_effort]`（小写，`;` 分隔，所选模型在前，至多 8000 字符）；Claude Code 已知的 Claude 模型只写它会发送的档位。
- effort：`max` 写 `CLAUDE_CODE_EFFORT_LEVEL`；其他档位删除该变量（它优先于设置），Claude 模型写 `modelSettings.<claude-name>.effortLevel`，Opus 5.5 之前的 Claude 模型与其他厂商的模型写顶层 `effortLevel`。Claude Code 接受 `low`、`medium`、`high`、`xhigh`、`max`。

### Codex 的两种模式

- `codexAuth: gateway-key`（默认）：HarnessHub 作为 `harnesshub` provider，Key 在 `experimental_bearer_token`。`model_catalog_json` 指向同目录的 `harnesshub-models.json`，由 HarnessHub 生成：每个列出的模型一项，按隔离接线已用固定版本 Codex 读取过的格式（`codex-models.ts`），带窗口、推理档位（默认 medium，其次 high，再其次第一个）、图像输入与 Codex 的默认指令。不再写 `model_context_window`（它对所有模型生效，切换模型后不再正确）。
- `codexAuth: chatgpt`：用户的 ChatGPT 登录不动，只写 `openai_base_url = "<网关>/backend-api/codex"`，Codex 内置的 OpenAI provider 带着它自己的登录经网关转发到 ChatGPT（网关路由由路由模块提供）。不签发、不写 Key，Codex 用它自己的模型；用户另设了非 OpenAI 的 `model_provider` 时这条路径不生效。从 API 模式切换过来时，HarnessHub 之前写的 provider、`model` 与目录条目恢复原值，旧 Key 被吊销。

两种模式都不读取 `~/.codex/auth.json`。

## 与 04 的差异与待做

- Crush 使用 `type: openai-compat`（Crush 对 OpenAI 兼容 Chat 端点的类型；04 写作 `openai`，Crush 以它表示 OpenAI 本身）。
- 与 Magpie 的差异：Pi 的 `thinkingLevelMap` 不能写 `null` 隐藏模型没有的档位（HarnessHub 的编辑器不写 `null`），改为映射到不高于它的最近档位；Codex 读 `CODEX_HOME`（Magpie 固定 `~/.codex`），且不读 `auth.json` 判断登录状态，模式由用户选择；Claude 的档位不支持 `<model>:<effort>` 固定档位 effort（网关不支持按成员固定 effort）；Pi 不把新模型加入用户的 `enabledModels`；Crush 未知窗口时不写默认值（Magpie 写 200000 与 16384）；Codex 的 ChatGPT 模式不写 `model`，只转发 Codex 自己的模型（Magpie 的 `codex_backend` 也在这条路径上提供它自己的模型）。
- 网关新增或删除模型后，Agent 文件中的模型清单不会自动重写（Magpie 的 `SyncCatalog`）；下次接线或隐藏操作时更新。网关的 `/v1/models` 立即生效。
- OpenCode 在设置了 `OPENCODE_CONFIG_DIR` 时写入该目录，因为其中的文件覆盖全局配置。
- 漂移检测没有区分“另一个 HarnessHub 实例”与其他网关：基址不同一律为 `foreign-gateway`。
- 每次接线都签发新 Key，所以对已接线的 Agent 预览时，即使模型不变，Key 一项也显示为改动（04 第 4 节的“无变化时计划为空”只在不换 Key 时成立）。
- 未实现：OpenClaw（JSON5）、Copilot（env-launch）Adapter 与上文未收录的 Magpie Agent；备份保留数清理；接线前检查 Agent 是否在运行；`bypassed` 与 `stale-key` 漂移（需要网关账本）；“rename 前被并发修改”之外的写后篡改注入测试（04 第 9 节第 6 项）；Windows 验证；真实 Agent 的接线生效测试（第 5 项）。

## 验证

[agents-wiring-semantics.test.ts](../tests/integration/agents-wiring-semantics.test.ts) 经 `startHub`（临时 `wiringHome`）与严格假上游：Claude Code 的档位、1M 模型的 `[1m]`、未标记档位的窗口、能力与 effort，Key 能调用各档模型，档位清除后子 Agent 跟随主模型；Codex 的 ChatGPT 模式只写 `openai_base_url` 且不签发 Key，API 模式生成模型目录，两种模式互相切换后旧 Key 失效、还原回原文件；隐藏与显示模型同时改变 Agent 文件中的清单和该 Key 的 `/v1/models` 与调用（403），Key 不变，网关新增的模型默认显示，真实 `hh agents models` 入口；Profile 保存、切走、应用后文件与保存时相同（Key 除外），过期的预览被拒绝，真实 `hh profile list|apply|rm` 入口。`packages/agents/test/wiring-semantics.test.ts` 在库层覆盖同样的语义与 Pi、OpenCode、Crush、Gemini 的元数据和 `wiredKeyText`。

[agents-wiring.test.ts](../tests/integration/agents-wiring.test.ts) 经 `startHub`（临时 `wiringHome`）与严格假上游：接线后从 Codex 配置文件读回基址与 Key 并成功调用网关；换 Key 后旧 Key 得到 401、新 Key 200；还原后文件逐字节一致且 Key 失效；手工修改后报告漂移并只撤销 HarnessHub 的项；预览后文件被改动时新 Key 被吊销；未接线、未知 Agent 与网关不提供的模型被拒绝；未设 `wiringHome` 的守护进程拒绝全部操作；真实 `hh` 入口的 `agents`、`wire`、`use`、`unwire` 只打印掩码后的 Key。`packages/agents/test/` 下：`wiring-formats.test.ts`（各编辑器的保留、拒绝与还原，以及每种格式 40 个种子的随机 set/remove 序列：每步按值核对目标键、其余内容与注释不变，JSON、TOML、dotenv 删除新增条目后字节与原文相同）；`wiring-adapters.test.ts`（每个 Adapter：空目录与已有配置的金样、逐字节还原、用户改动后的键级还原、解析失败拒绝、符号链接逃逸拒绝、漂移、Key 轮换后还原，金样在 `wiring-golden.ts`）；依照 Magpie 的 Adapter 各有 `wiring-agent-<id>.test.ts`，经 `wiring-suite.ts` 运行同样的用例，另核对声明的协议、命令、文件与目录变量，金样与已有配置写在各自文件中（接管用户对象的 Cline 在键级还原后按值比较），并有各自的特例：MiMo 的候选文件顺序、Cline 新建文件的版本号、Grok 按所选模型判断基址、omp 的目录规则与未迁移拒绝、T3 Code 列表内的 Key 与基址漂移、Pencil 与 T3 Code 按目录判断安装；`wiring-safety.test.ts`（目录内符号链接、硬链接、只读文件与权限、BOM 与 CRLF、非 UTF-8、预览后被修改、写入失败回滚、锁、残留临时文件、目录变量、目标与上下文校验、预览掩码、损坏的备份）。测试只使用临时目录作为 `home`，Key 为合成值，不访问网络。
