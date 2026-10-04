# 快速上手：本机模型网关

从源码启动守护进程，用预设添加一个 provider，签发一把 Gateway Key，再让任意 OpenAI 或 Anthropic 客户端经 `http://127.0.0.1:3180` 调用模型。下面以 DeepSeek 为例；其他厂商用 `hh provider presets` 列出的预设 ID 替换 `deepseek` 即可。命令在仓库根目录执行，`pnpm exec hh` 是 `hh` 命令（[apps/hh](../apps/hh/README.md)）。

## 1. 构建并启动守护进程

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm exec hh serve
```

Node、pnpm 的版本与克隆见 [README](../README.md#install-from-source)。`hh serve` 默认监听 `127.0.0.1:3180`（`--port` 修改），数据目录为当前目录下的 `./data`（`--data-dir` 修改），首次启动时在其中生成本机管理令牌 `admin.token`。它输出 JSON 日志，其中 `Console: http://127.0.0.1:3180/#login=…` 一行是控制台的一次性登录链接（60 秒内可用一次，`pnpm exec hh console` 生成新的）；没有运行 `pnpm build:console` 时控制台页面答复 503。API Key 默认存入系统密钥库（macOS 钥匙串、Windows DPAPI，其他平台为加密文件）；加 `--secrets-backend file` 改用加密文件，主密钥在 `--config-dir`（默认是平台的 HarnessHub 配置目录）下的 `secrets.key`。

## 向导：`hh init`

另开一个终端运行 `pnpm exec hh init`，它把下面第 2 步与第 5 步[接入 Agent](#5-接入本机的编码-agent)合成一个流程：确认守护进程在运行（没有时提示先运行 `hh serve`，以 3 退出）；从按厂商、中转与本地分组的预设中选择（输入文字即搜索），再选区域与套餐，以隐藏输入读取 API Key（本地预设不需要）；刷新模型并显示数量；列出本机已安装的 Agent 供多选；选择默认模型，选了 Claude Code 时可为各档位另选模型；最后把所有 Agent 的改动合在一份预览中，确认后逐个接线，并提示 `hh usage`、`hh console` 等下一步。交互式向导使用预设的地址；本地服务（vLLM、LM Studio、Ollama）在其他地址时，用下面的非交互形式加 `--base`。同 id 的 provider 已存在时直接使用（不改它的地址）；已按相同选择接线、Key 有效且没有漂移的 Agent 不重新接线（重新接线会换一把新 Key）。还没有 provider 时，控制台首页显示同样的流程（Claude Code 的各档位跟随默认模型，之后在 Agent 详情中分别设置）。

没有终端时（stdin 不是 TTY、设置了 `CI` 或加 `--non-interactive`）由选项给出全部答案，缺少的以 2 退出，且在添加任何东西之前检查：

```sh
pnpm exec hh init --preset deepseek --credential-from-env DEEPSEEK_API_KEY \
  --agents claude,codex --model deepseek/deepseek-chat --tier haiku=deepseek/deepseek-chat --yes
```

`--region`、`--plan` 默认取预设的第一个；`--base URL` 把预设的地址移到另一个基址（需要用户自填地址的预设，如另一台 HarnessHub，必须给出）；`--agents` 也接受 `all`（已安装的全部）与 `none`；没有 `--yes` 时只显示改动并以 4 退出，provider 已添加、Agent 不变；某个 Agent 接线失败时其余照常，命令以 1 退出。`--json` 输出 `{provider: {id, created, models}, agents: [{agent, model, tiers, outcome}]}`。每一步都经 SDK 调用 `/api/v1` 的现有接口（预设、provider、模型刷新、Agent 预览与接线），与 `hh provider add` 和 `hh wire` 相同。

## 没有 API Key 时

仓库自带一个严格的模拟上游（[tools/fake-provider](../tools/fake-provider/README.md)）：它不调用任何真实模型，只在回环地址监听，对每个请求回答固定的文字，可以用来试用下面的全部步骤。在另一个终端启动它，Key 是任意的测试值：

```sh
HH_FAKE_KEY=sk-test-only node tools/fake-provider/index.mjs --key-env HH_FAKE_KEY --port 8790
```

再把它当作 vLLM 预设的服务（`--base` 把预设的地址换成它，模型名是 `upstream-sim`）：

```sh
HH_FAKE_KEY=sk-test-only pnpm exec hh init --preset vllm --base http://127.0.0.1:8790 \
  --credential-from-env HH_FAKE_KEY --agents codex --model vllm/upstream-sim --yes
```

之后的命令把 `deepseek` 换成 `vllm`、模型换成 `vllm/upstream-sim` 即可。接线后的 Agent 也会收到这些固定回答，只用来确认链路，不能完成真实任务。

## 2. 添加 provider 与 Key

另开一个终端。`hh` 默认连接 `http://127.0.0.1:3180`，并从 `./data/admin.token` 读取管理令牌；守护进程用了其他端口或数据目录时，给每个命令加上 `--url` 与 `--data-dir`。

```sh
pnpm exec hh status
printf '%s' "$DEEPSEEK_API_KEY" | pnpm exec hh provider add --preset deepseek --credential-from-stdin
pnpm exec hh provider models deepseek --refresh
HH_KEY=$(pnpm exec hh key create --name quickstart --allow 'deepseek/*')
```

- 厂商的 API Key 从标准输入读取，存入秘密存储后只保留引用；在终端里不加 `--credential-from-*` 时，`hh credential add deepseek` 以隐藏输入读取。Key 从不出现在命令行参数中。
- `hh provider models --refresh` 用这把 Key 从厂商列出模型；失败时保留原列表并说明原因。窗口、输出上限与价格从预设和内置的 models.dev 快照补齐，`hh model show deepseek/<模型>` 显示每个值的来源；`hh model set` 可以覆盖（见 [模型元数据](model-plane-api.md#模型元数据)）。价格已知的模型在用量中显示成本。
- `hh key create` 在标准输出打印 `hhk_c_…` 形式的 Gateway Key，只显示这一次；`--allow` 限定它能用的模型（`provider/model`、`provider/*` 或 `group/<id>`），默认 90 天后过期。

## 3. 调用模型

模型名写成 `provider/模型`。OpenAI Chat Completions：

```sh
curl http://127.0.0.1:3180/v1/chat/completions \
  -H "Authorization: Bearer $HH_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

OpenAI SDK（Python）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3180/v1", api_key="hhk_c_…")
reply = client.chat.completions.create(
    model="deepseek/deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
)
print(reply.choices[0].message.content)
```

Anthropic 客户端使用不带 `/v1` 的基址：`ANTHROPIC_BASE_URL=http://127.0.0.1:3180`，`ANTHROPIC_API_KEY` 设为 Gateway Key；Gemini 客户端同样使用 `http://127.0.0.1:3180` 为基址。`hh status` 打印这些地址。网关默认只接受本机回环连接，浏览器页面（带 `Origin`）的请求被拒绝；要让局域网中的其他机器使用，见 [局域网共享](model-gateway.md#局域网共享)（`hh gateway share on` 与 `hh key create --lan`）。

## 4. 查看用量

```sh
pnpm exec hh usage --by model --since 1d
```

每次进入网关的调用，包括被拒绝的，都记在 `model.call` 账本中：`GET /api/v1/model-calls` 列出明细，`GET /api/v1/usage` 按模型、provider、日期、Key、Agent 或凭据汇总，`GET /api/v1/conversations`（`hh usage --by conversation`）按会话汇总；价格未知的调用单独计数，不按 0 计算。控制台的“用量”页面显示同样的数据（[控制台](../packages/console/README.md)）。

## 5. 接入本机的编码 Agent

把已安装的 Codex、Claude Code、Gemini CLI、Qwen Code、OpenCode 等改为经网关调用模型：

```sh
pnpm exec hh agents
pnpm exec hh wire codex deepseek/deepseek-chat
```

`hh wire` 先显示对 Agent 配置文件（这里是 `~/.codex/config.toml`，以及 HarnessHub 为 Codex 生成的模型目录 `~/.codex/harnesshub-models.json`）的改动，确认后写入，并给该 Agent 签发一把只属于它的 Key；Agent 默认列出网关的全部模型，`hh agents models codex --hide <模型>` 可隐藏其中一些。原文件先备份，`hh unwire codex` 恢复原样并吊销 Key。重启正在运行的 Agent 后生效，它的调用按 Agent 汇总在 `hh usage --by adapter` 中。`pnpm exec hh tui` 在终端中打开同样的操作：每个 Agent 一行，方向键选择 Agent 与字段（模型、Claude Code 的档位、effort），回车打开可搜索的模型选择器，确认 diff 后写入，`s`、`p` 保存与应用 Profile（[终端界面](global-wiring.md#终端界面)）。支持的 Agent、写入的键与安全规则见 [全局接线](global-wiring.md)。

更多说明：命令与 API 见 [模型平面 API 与 CLI](model-plane-api.md)，网关的路由、重试与限制见 [统一模型网关](model-gateway.md#共享网关)，预设的格式与核对见 [presets](../packages/gateway/presets/README.md)。
