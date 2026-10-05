# 支持的 Agent

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 每个 Adapter 都有库层用例（`wiring-adapters.test.ts` 的金样与 `wiring-agent-<id>.test.ts`：空目录与已有配置、逐字节还原、键级还原、解析失败、符号链接逃逸、漂移、轮换后还原），macOS arm64 本机通过；真实 Agent 只有一致性套件中的 7 个（假上游、macOS Seatbelt 沙箱）与真实 DeepSeek 下的 5 个，其余 21 个未以真实 Agent 验证；Windows 未验证 |
| 对照 Magpie | 部分：Magpie 35 个 Agent 中接了 27 个，另加 Qwen Code；Claude Code 与 Codex 的两种模式为相同，Codex 其他设置、Claude Desktop 与固定 effort 的档位为部分，dsh、Command Code、fx、Muse 为有意不同，其余 Agent 与 WSL 中的 Agent 未覆盖（[Agents and wiring](../../magpie-parity.md#agents-and-wiring)） |
| 权威文档 | [支持的 Agent](../../global-wiring.md#支持的-agent)、[Claude Code](../../global-wiring.md#claude-code)、[Codex 的两种模式](../../global-wiring.md#codex-的两种模式)、[Codex 的其他设置](../../global-wiring.md#codex-的其他设置)、[兼容性](../../compatibility.md) |

## 用途

列出全局接线能改写哪些 Agent、每个写哪些文件、走什么协议、Key 放在哪里，以及各自特有的选项。用户据此判断自己的 Agent 能否接到网关、接线后要注意什么；逐键的写法以权威文档为准。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Agent 首页（`/`）列出已安装、只有配置目录或已接线的 Agent，未发现的折叠在下面；详情显示该 Adapter 的档位、effort 与选项 |
| 命令行 | `hh agents`（全部 Adapter 的安装与接线状态）；`hh wire <agent>` 的 `<agent>` 是下表的 id；`hh tui` 的 `f` 展开未安装的 Agent |
| HTTP | `GET /api/v1/agents` 的 `protocol`、`keyDelivery`、`capabilities{tiers、efforts、options}`、`notice`、`installation` |

## 已实现的能力

- 28 个 Adapter 登记在 `wiringAdapters`：前 8 行由 HarnessHub 先行实现，其余 20 个依照 Magpie `2e340f7` 的 `internal/agent/<agent>.go` 记录的配置位置与键名。
- 协议：每个 Adapter 声明它对网关说的协议；Pi、OmO、oh-my-pi 与 Droid 按每个模型的原生协议逐模型选择 Chat、Responses 或 Anthropic。
- 模型元数据：窗口、输出上限（不超过窗口）、推理档位（推理模型按 `low`、`medium`、`high`）与图像输入按各 Agent 的字段写入，Agent 没有对应字段的不写。
- 能力声明：档位只有 Claude Code（opus、sonnet、haiku、fable、subagent）与 Codex（subagent）；选项只有 Codex 的 `codexAuth`（`gateway-key`、`chatgpt`，后者可以保留 Codex 自己的模型）；下表“特有之处”中写有 effort 的 Adapter 可以设置起始 effort；给出 Adapter 未声明的档位、effort 或选项为 `WIRING_TARGET_INVALID`。
- Key 的放法有三种：写进配置文件；写进 Agent 自己加载的 `.env`（Gemini、Qwen、dsh）；写在基址路径 `/k/<Key>/v1` 中（Command Code、fx、Muse，以及 ChatGPT 模式的 Codex 的 `/backend-api/codex/<Key>`），这种 Key 只在回环上被接受。
- 没有命令的 Agent（Pencil、WorkBuddy、ZCode、Claude Desktop、T3 Code）按配置目录判断是否安装；OpenChamber 也写入的 OpenCode 配置目录不算 OpenChamber 已安装的证据。

| Adapter | 文件（目录变量） | 协议 | 特有之处 | Key 落点 | 真实 Agent |
|---|---|---|---|---|---|
| `claude` Claude Code | `settings.json`（`${CLAUDE_CONFIG_DIR:-~/.claude}`） | Anthropic | 档位、effort、1M 窗口写成 `<ref>[1m]`、`CLAUDE_CODE_MODEL_CAPABILITIES`、托管配置警告、自己的重启提示 | 配置文件 | 套件 5 项 ✓；DeepSeek ✓ |
| `codex` Codex CLI | `config.toml`、生成的 `harnesshub-models.json`（`${CODEX_HOME:-~/.codex}`） | Responses | 档位 subagent、effort、`codexAuth`；所选模型的 provider 不原生接收 Responses 且网关没有搜索后端时写 `web_search = "disabled"`；`[agents]`、`[desktop]` 与 CC Switch 表；还原后保留不带 Key 的 provider 表 | 配置文件；ChatGPT 模式在基址路径 | 套件 Tools 为 partial，其余 ✓；DeepSeek ✓ |
| `gemini` Gemini CLI | `settings.json`、`.env`（`${GEMINI_CLI_HOME:-~}/.gemini`） | Gemini | 窗口小于 1,048,576 时写压缩阈值 | `.env` | 套件 ✓（不设代理变量）；DeepSeek ✓ |
| `qwen` Qwen Code | `settings.json`、`.env`（`${QWEN_HOME:-~/.qwen}`） | Chat | — | `.env` | 未验证 |
| `opencode` OpenCode | 已有的 `opencode.jsonc`，否则 `opencode.json`（`$OPENCODE_CONFIG_DIR` 或 `${XDG_CONFIG_HOME:-~/.config}/opencode`） | Chat | 模型按推理档位的 `variants` | 配置文件 | 套件 ✓；DeepSeek ✓ |
| `pi` Pi | `settings.json`、`models.json`（`${PI_CODING_AGENT_DIR:-~/.pi/agent}`） | 逐模型 | effort；`thinkingLevelMap` 映射到不高于它的最近档位 | 配置文件 | 套件 ✓；DeepSeek ✓ |
| `crush` Crush | `crush.json`（`${XDG_CONFIG_HOME:-~/.config}/crush`） | Chat | effort（low、medium、high）；未知窗口不写默认值 | 配置文件 | 未验证 |
| `kimi` Kimi Code | `config.toml`（`${KIMI_SHARE_DIR:-~/.kimi}`） | Chat | 所选模型必须有已知窗口 | 配置文件 | 未验证 |
| `mimocode` MiMo Code | `mimocode.jsonc`、`mimocode.json` 或 `config.json`（`$MIMOCODE_HOME/config` 或 `~/.config/mimocode`） | Chat | 复用 OpenCode 的写法 | 配置文件 | 套件 ✓ |
| `omo` OmO | `settings.json`、`models.json`（`${OMO_CODING_AGENT_DIR:-${SENPI_CODING_AGENT_DIR:-~/.omo/agent}}`） | 逐模型 | effort；复用 Pi 的写法 | 配置文件 | 未验证 |
| `omp` oh-my-pi | `config.yml`、`models.yml`（`~/.omp` 下按 omp 的 profile 规则） | 逐模型 | effort；旧 `models.json` 未迁移时拒绝新建 | 配置文件 | 未验证 |
| `hermes` Hermes Agent | `config.yaml`（`${HERMES_HOME:-~/.hermes}`） | Chat | effort | 配置文件 | 套件 ✓ |
| `minimax-code` MiniMax Code | `config.yaml`（`${MINIMAX_DATA_DIR:-~/.minimax}`） | Anthropic | 模型的 `thinking.effortOptions` | 配置文件 | 未验证 |
| `grok` Grok Build | `config.toml`（`${GROK_HOME:-~/.grok}`） | Chat | effort；每个模型一张表；`[features] campaigns = false` | 配置文件 | 套件中未安装 |
| `qoder` Qoder | `settings.json`（`${QODER_CONFIG_DIR:-~/.qoder}`） | Chat | effort；只对已登录且套餐含 BYOK 的账号生效 | 配置文件 | 未验证 |
| `qoder-cn` Qoder CN | `settings.json`（`${QODERCN_CONFIG_DIR:-~/.qoder-cn}`） | Chat | 同 Qoder | 配置文件 | 未验证 |
| `cline` Cline CLI | `settings/providers.json`、`settings/models.json`（`$CLINE_DATA_DIR` 或 `${CLINE_DIR:-~/.cline}/data`） | Chat | effort；接管内置的 `openai-compatible` 槽位，还原时按值写回 | 配置文件 | 未验证 |
| `pencil` Pencil | `~/.pencil/models.json` | Chat | 只让模型出现在选择器中，不写所选模型 | 配置文件 | 未验证 |
| `droid` Droid | `settings.json`（`${FACTORY_HOME_OVERRIDE:-~}/.factory`） | 逐模型 | `customModels` 中只拥有自己的元素 | 配置文件 | 未验证 |
| `workbuddy` WorkBuddy | `models.json`（`${WORKBUDDY_CONFIG_DIR:-~/.workbuddy}`） | Chat | 只列模型；对象或裸列表都保持原形；热加载，无重启提示 | 配置文件 | 未验证 |
| `zcode` ZCode | `~/.zcode/v2/config.json`、`provider_config.json` | Anthropic | 只列模型；用户手设过规则的模型不写规则 | 配置文件 | 未验证 |
| `claude-desktop` Claude Desktop | 应用数据目录下 `Claude-3p/configLibrary/<id>.json`、`_meta.json` 与两个 `claude_desktop_config.json` | Anthropic | Key 的 `modelIdStyle: claude-alias`，模型以 `claude-hh-<10 位数字>` 列出；只在启动时读取 | 配置文件 | 未验证 |
| `t3code` T3 Code | `userdata/settings.json`（`${T3CODE_HOME:-~/.t3}`） | Anthropic（经 Claude Code） | 只列模型；无重启提示 | 配置文件（`environment` 列表） | 未验证 |
| `openchamber` OpenChamber | `preferences.json`、`settings.json`（`${OPENCHAMBER_DATA_DIR:-~/.config/openchamber}`）与 OpenCode 的配置文件 | Chat | effort；在 OpenCode 配置中有自己的 provider `harnesshub-openchamber` 与 Key | 配置文件 | 未验证 |
| `dsh` DeepSeek Harness | `settings.yaml`、`.env`（`${DSH_HOME:-~/.dsh}`） | Chat | effort；在 dsh 中另选模型按漂移处理，不定时重写 | `.env`（`HARNESSHUB_GATEWAY_KEY`） | 未验证 |
| `commandcode` Command Code | `~/.commandcode/providers.json`、`settings.json` | Chat | effort；仍需 `cmd login` | 基址路径 | 未验证 |
| `fx` fx | `~/.fx/settings.json` | Chat | 不发 effort；至多列 256 个模型 | 基址路径 | 未验证 |
| `muse` Muse Code | `${XDG_CONFIG_HOME:-~/.config}/muse/settings.json` | Responses | 从网关的 `/muse-code/models` 读模型列表 | 基址路径 | 未验证 |

未收录的 Agent（原因见[权威文档](../../global-wiring.md#支持的-agent)）：Goose、Cursor、Copilot、Devin（Magpie 也不接网关）；Alma、OpenHanako（经运行中应用的本地 API 配置）；Cindy（只生成导入链接）；Antigravity CLI（`agy`，只从环境变量读取端点与 Key）；WSL 中的 Agent；04 计划的 OpenClaw（JSON5）与 Copilot（env-launch）Adapter。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [adapters/index.ts](../../../packages/agents/src/wiring/adapters/index.ts)（登记与 `restartNotice`）、[adapters/types.ts](../../../packages/agents/src/wiring/adapters/types.ts)（`WiringAdapter`）、[adapters/claude.ts](../../../packages/agents/src/wiring/adapters/claude.ts)、[adapters/codex.ts](../../../packages/agents/src/wiring/adapters/codex.ts)，其余每个 Adapter 一个同名文件 |
| 测试 | [wiring-adapters.test.ts](../../../packages/agents/test/wiring-adapters.test.ts)、[wiring-golden.ts](../../../packages/agents/test/wiring-golden.ts)、[wiring-suite.ts](../../../packages/agents/test/wiring-suite.ts)（各 `wiring-agent-<id>.test.ts` 共用）、[wiring-metadata.test.ts](../../../packages/agents/test/wiring-metadata.test.ts)、[agents-wiring-semantics.test.ts](../../../tests/integration/agents-wiring-semantics.test.ts)、[conformance/agents.test.ts](../../../tests/conformance/agents.test.ts) |
| 决策 | [ADR 0022](../../decisions/0022-agent-wiring-semantics.md)（数组元素归属、Claude 风格别名）、[ADR 0030](../../decisions/0030-codex-chatgpt-mode-models.md)、[ADR 0033](../../decisions/0033-gateway-key-in-path.md) |

## 已知限制与未验证

- 21 个 Adapter 只有库层金样，没有用真实 Agent 确认它读到了写入的配置；第二组 Adapter 的配置位置与键名照 Magpie 的源码记录，推理档位、图片输入与 effort 的写法也未以真实 Agent 核对（[TODO.md](../../../TODO.md)“接线扩展”）。
- 一致性套件只在 macOS 上运行；套件中的 Codex 因命令沙箱不能嵌套，Tools 为 partial；OpenChamber、dsh、Command Code、fx、Muse 本机未安装，套件中还没有它们的用例。
- 推理档位只来自模型平面的 `reasoning` 标记（统一写 `low`、`medium`、`high`），provider 与 models.dev 尚未提供逐模型的档位。
- Claude Desktop：没有 Magpie 让 Desktop 显示 effort 选择器的别名，标题等小请求不转回所选模型（`desktopTurn`），Windows 上不按 `Claude…` 前缀查找目录。
- Codex：子 Agent 的 effort 跟随接线的 effort，不能单独选；ChatGPT 模式不按订阅缩减 ChatGPT 返回的模型列表；Claude Code 的档位不支持 `<model>:<effort>`，要用只有一个 `<ref>:<effort>` 成员的路由组代替。
- Qoder 需要已登录且套餐含 BYOK，否则接线不生效；Command Code 仍要求自己的登录。
- Windows 上的目录（如 Crush 的 `%LOCALAPPDATA%\crush`、Claude Desktop 的 `%LOCALAPPDATA%`）未在 Windows 上验证。

## 优化候选

- **现状**：28 个中只有 7 个跑过一致性套件。**方向**：在套件中加入已能在本机安装的 Agent（先从有非交互模式的 Crush、Kimi、Qwen、OmO 开始），并把 OpenChamber、dsh、Command Code、fx、Muse 的用例写好、未安装时跳过。**依据**：[兼容性](../../compatibility.md#结果)中“此后接线的 … 套件中还没有它们的用例”；对照表 Wiring 35 agents 一行（partial）。
- **现状**：推理档位一律写 `low`、`medium`、`high`。**方向**：从 provider 或 models.dev 取逐模型的档位，Adapter 已按 `efforts` 写出，无需改 Adapter。**依据**：[支持的 Agent](../../global-wiring.md#支持的-agent) 末段。
- **现状**：Codex 子 Agent 的 effort 不能单独选，Claude 档位不能固定 effort。**方向**：为档位增加各自的 effort（Magpie 的 `subagent_effort` 与 `<model>:<effort>`）。**依据**：[对照表](../../magpie-parity.md#agents-and-wiring) 中对应两行（partial）。
- **现状**：Claude Desktop 缺少 effort 别名与 `desktopTurn`。**方向**：按 Magpie 增加带推理档位的别名与小请求回转。**依据**：[与 04 的差异与待做](../../global-wiring.md#与-04-的差异与待做)。
- **现状**：ChatGPT 模式的 Codex 列出 ChatGPT 返回的全部模型。**方向**：按订阅选择的模型缩减。**依据**：对照表 “Codex's ChatGPT models narrowed” 一行（not covered）。
