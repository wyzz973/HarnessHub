# 快速上手：本机模型网关

从源码启动守护进程，用预设添加一个 provider，签发一把 Gateway Key，再让任意 OpenAI 或 Anthropic 客户端经 `http://127.0.0.1:3180` 调用模型。下面以 DeepSeek 为例；其他厂商用 `hh provider presets` 列出的预设 ID 替换 `deepseek` 即可。命令在仓库根目录执行，`pnpm exec hh` 是 `hh` 命令（[apps/hh](../apps/hh/README.md)）。

## 1. 构建并启动守护进程

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec hh serve
```

`hh serve` 默认监听 `127.0.0.1:3180`（`--port` 修改），数据目录为当前目录下的 `./data`（`--data-dir` 修改），首次启动时在其中生成本机管理令牌 `admin.token`。API Key 默认存入系统密钥库（macOS 钥匙串、Windows DPAPI，其他平台为加密文件）；加 `--secrets-backend file` 改用加密文件，主密钥在 `--config-dir`（默认是平台的 HarnessHub 配置目录）下的 `secrets.key`。

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

Anthropic 客户端使用不带 `/v1` 的基址：`ANTHROPIC_BASE_URL=http://127.0.0.1:3180`，`ANTHROPIC_API_KEY` 设为 Gateway Key；Gemini 客户端同样使用 `http://127.0.0.1:3180` 为基址。`hh status` 打印这些地址。网关只接受本机回环连接，浏览器页面（带 `Origin`）的请求被拒绝。

## 4. 查看用量

```sh
pnpm exec hh usage --by model --since 1d
```

每次进入网关的调用，包括被拒绝的，都记在 `model.call` 账本中：`GET /api/v1/model-calls` 列出明细，`GET /api/v1/usage` 按模型、provider、日期、Key 或 Agent 汇总；价格未知的调用单独计数，不按 0 计算。控制台的“用量”页面显示同样的数据（[控制台](../packages/console/README.md)）。

## 5. 接入本机的编码 Agent

把已安装的 Codex、Claude Code、Gemini CLI、Qwen Code、OpenCode 等改为经网关调用模型：

```sh
pnpm exec hh agents
pnpm exec hh wire codex deepseek/deepseek-chat
```

`hh wire` 先显示对 Agent 配置文件（这里是 `~/.codex/config.toml`）的改动，确认后写入，并给该 Agent 签发一把只属于它的 Key；原文件先备份，`hh unwire codex` 恢复原样并吊销 Key。重启正在运行的 Agent 后生效，它的调用按 Agent 汇总在 `hh usage --by adapter` 中。支持的 Agent、写入的键与安全规则见 [全局接线](global-wiring.md)。

更多说明：命令与 API 见 [模型平面 API 与 CLI](model-plane-api.md)，网关的路由、重试与限制见 [统一模型网关](model-gateway.md#共享网关)，预设的格式与核对见 [presets](../packages/gateway/presets/README.md)。
