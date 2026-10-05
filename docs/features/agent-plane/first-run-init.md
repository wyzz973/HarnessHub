# 首次使用

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 集成：[init.test.ts](../../../tests/integration/init.test.ts) 经 `startHub`、严格假上游与文件秘密后端运行 6 个用例（无终端时经真实 `hh` 入口，有终端时注入问答），macOS arm64 本机通过；控制台：`tools/check-console-contracts.test.mjs` 检查 `lib/first-run.ts` 的模型列表与“已相同接线”判断，其余靠 Chromium 中的手工走查（[TODO.md](../../../TODO.md) W5）；没有见到以真实 provider 或真实 Agent 运行 `hh init` 的记录；Windows 未验证 |
| 对照 Magpie | 对照表没有对应的行，未评估；`init.ts` 的说明称它对应 Magpie 的“添加 provider、为 Agent 选模型” |
| 权威文档 | [快速上手：向导 `hh init`](../../quickstart.md#向导hh-init)、[控制台：页面与状态](../../../packages/console/README.md#页面与状态) |

## 用途

第一次使用时，把“添加 provider 与 Key → 读取模型 → 选 Agent → 选默认模型 → 一份合并的预览后接线”串成一个流程，不必分别记住 `hh provider add` 与 `hh wire`。终端中是 `hh init`，浏览器中是控制台首页的“开始使用 HarnessHub”。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 还没有 provider 时 Agent 首页（`/`）显示五步流程：Provider 与 Key、模型列表、Agent、默认模型、确认改动；可以跳过，之后从页首“没有 provider”的提示重新打开 |
| 命令行 | 交互：`hh init`；非交互：`hh init --preset ID --credential-from-env VAR --agents A,B --model PROVIDER/MODEL [--tier TIER=REF]... --yes`，另有 `--region`、`--plan`、`--base`、`--credential-from-file`、`--credential-from-stdin` |
| HTTP | 没有专用接口，每一步调用现有接口：`GET /api/v1/presets`、`GET`/`POST /api/v1/providers`、`PATCH /api/v1/providers/{id}`、`POST /api/v1/providers/{id}/credentials`、`POST /api/v1/providers/{id}/models/refresh`、`GET /api/v1/agents`、`POST /api/v1/agents/{id}/wiring/plan`、`POST /api/v1/agents/{id}/wiring` |

## 已实现的能力

- `hh init` 先确认守护进程在运行，没有时提示 `hh serve` 并以 3 退出。
- 预设按厂商、中转与本地分组，输入文字即搜索；再选区域与套餐（`--region`、`--plan` 缺省取第一个）。
- 本地预设（vLLM、LM Studio、Ollama）询问服务基址，回车沿用预设的地址；“+base URL” 预设必须给出基址。
- API Key 以隐藏输入或 `--credential-from-*` 读取，从不出现在命令行参数中；本地预设不需要 Key。
- 同 id 的 provider 已存在时直接使用，不再询问区域、套餐与基址；预设、区域、套餐或基址与它不同时列出差异，终端中可以更新地址（只有地址不同时）、按原样使用或停止，没有终端时以 2 退出且不做改动；它已有 Key 时不用给出的 Key，`--json` 的 `keyUnused` 标出。
- 添加后刷新模型列表，失败时用预设的列表并说明原因。
- 列出本机已安装的 Agent 供多选（回车为全部，`none` 跳过）；`--agents` 也接受 `all` 与 `none`。
- 选择默认模型；有档位的 Agent 用一次回答分配档位，各 Agent 只取自己有的档位（Codex 只取 `subagent`），没有 Agent 有的档位被拒绝（以 2 退出）。
- 所有 Agent 的改动合在一份预览中，确认后逐个经接线的同一路径写入；已按相同模型与档位接线、Key 有效且没有漂移的 Agent 不重新接线（重新接线只会换一把 Key）。
- 某个 Agent 接线失败时其余照常，命令以 1 退出；不加 `--yes` 的非交互运行只显示改动并以 4 退出，provider 已添加、Agent 不变。
- 无终端时缺少的答案在添加任何东西之前检查，以 2 退出。
- `--json` 输出 `{provider: {id, created, updated, keyUnused, models}, agents: [{agent, model, tiers, outcome, notice}]}`，接线结果带各 Agent 的重启提示。
- 控制台流程使用同样的接口与同样的“已相同接线则不动”规则，默认勾选全部已安装的 Agent，接线逐个进行、一个失败不影响其他，结果中列出每个 Agent 的提示。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码（命令行） | [cli/init.ts](../../../packages/cli/src/init.ts) |
| 源码（控制台） | [first-run.tsx](../../../packages/console/components/first-run.tsx)、[lib/first-run.ts](../../../packages/console/lib/first-run.ts)、[agents-page.tsx](../../../packages/console/components/agents-page.tsx)（何时显示） |
| 测试 | [init.test.ts](../../../tests/integration/init.test.ts)、[check-console-contracts.test.mjs](../../../tools/check-console-contracts.test.mjs) |
| 决策 | 无专门的 ADR；向导的设计来自 [06 接口](../../proposals/oss/06-interfaces.md)中的 `hh init` 一行 |

## 已知限制与未验证

- 控制台流程不问档位，Claude Code 的各档跟随默认模型，之后在 Agent 详情中分别设置；两种入口都不设置 effort、Codex 的 `codexAuth` 与 `--models` 列表，也不涉及 Library。
- 一次只添加一个 provider；区域、套餐与预设在添加时确定，要改须先 `hh provider remove` 再重新运行。
- 控制台流程每次访问只在没有 provider 时自动出现一次；关闭后添加的 provider 与已完成的接线保留。
- 没有以真实 provider 与真实 Agent 运行 `hh init` 的记录（真实 provider 的复跑脚本用的是 `hh provider add` 与 `hh wire`）；Windows 未验证。

## 优化候选

- **现状**：命令行的 `exposed` 与 `sameWiring` 和控制台 `lib/first-run.ts` 的 `exposedModels`、`sameWiring` 是两份相同的逻辑，只有控制台的那份有契约测试。**方向**：移到 SDK 共用一份，避免两个入口对“已相同接线”的判断分叉。**依据**：阅读 [cli/init.ts](../../../packages/cli/src/init.ts) 与 [lib/first-run.ts](../../../packages/console/lib/first-run.ts) 的观察。
- **现状**：控制台首次使用不问档位，两个入口都不问 Codex 用 Gateway Key 还是 ChatGPT 登录。**方向**：在“默认模型”一步为 Claude Code 档位与 Codex 的 `codexAuth` 提供可选项，缺省行为不变。**依据**：[快速上手](../../quickstart.md#向导hh-init)末尾对控制台流程的说明；阅读 [first-run.tsx](../../../packages/console/components/first-run.tsx) 的观察（计划只带 `model`）。
- **现状**：`pnpm test:real` 覆盖 provider 与 `hh wire`，不覆盖向导本身。**方向**：在真实 provider 复跑中增加一次非交互 `hh init`，核对它与分步命令得到相同的接线。**依据**：[兼容性：怎样重复](../../compatibility.md#怎样重复)。
