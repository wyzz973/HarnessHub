# 配置参考

`hh serve` 的启动设置集中在配置根目录下的 `config.jsonc`（带注释的 JSON），由 [`packages/daemon/src/config-file.ts`](../packages/daemon/src/config-file.ts) 一处解析后交给守护进程。配置根目录见 [07 数据与安全第 1 节](proposals/oss/07-data-security.md#1-数据目录与文件布局)：macOS `~/Library/Application Support/HarnessHub/config`，Windows `%LOCALAPPDATA%\HarnessHub\config`，其他平台 `$XDG_CONFIG_HOME/harnesshub`（绝对路径时）或 `~/.config/harnesshub`；`hh serve --config-dir DIR` 与 `hh config --config-dir DIR` 改用另一个目录。文件不存在等于空配置。

## 启动设置与运行时设置

| | 启动设置 | 运行时设置 |
|---|---|---|
| 位置 | `<配置根>/config.jsonc` | 数据根下各自的文件：局域网共享的 `<dataDir>/gateway-sharing.json`，脱敏、视觉兜底与联网搜索的 `<dataDir>/gateway-features.json` |
| 修改方式 | `hh config set`/`unset` 或直接编辑 | API、控制台或 CLI：`/api/v1/gateway/share` 与 `hh gateway share`（[局域网共享](model-gateway.md#局域网共享)），`/api/v1/gateway/features` 与 `hh gateway features`、`redaction`、`vision`、`search`（[网关功能](gateway-features.md)） |
| 生效 | 下一次 `hh serve` | 立即，由守护进程保存 |

运行时设置不写进 `config.jsonc`，`hh config` 也不修改它们；`hh config show` 只在最后列出它们所在的文件与修改它们的命令。provider、路由组、Key、Profile 与接线记录是存储中的业务记录，也不属于配置文件（[07 数据与安全第 1 节](proposals/oss/07-data-security.md#1-数据目录与文件布局)）。

## 取值顺序

每个设置的值取自第一个给出它的来源：

1. `hh serve` 的命令行参数；
2. 已有文档的环境变量（只有下表列出的几个）；
3. `config.jsonc`；
4. 默认值。

`hh serve` 启动时在标准错误输出一行 `Config: <文件> (…)`，列出不是默认值的设置及其来源。`hh config show` 不带参数地按 2–4 解析，显示每个值与来源（`default`、`file`、`env <变量>`）；参数只在 `hh serve` 中生效。

## 设置

| 键 | 值 | 默认 | 参数 | 环境变量 |
|---|---|---|---|---|
| `server.host` | 监听地址（主机名或 IP） | `127.0.0.1` | `--host` | |
| `server.port` | 0–65535，0 为任选空闲端口 | `3180` | `--port` | |
| `dataDir` | 数据根，绝对路径 | `./data`（相对当前目录） | `--data-dir`（相对路径按当前目录） | |
| `engines.configFile` | 引擎登记文件（YAML），绝对路径 | 无 | `--config` | |
| `engines.default` | 新 Session 未指定时用的引擎 id | 引擎登记文件的默认 | `--engine` | `AGENT_ENGINE` |
| `secrets.backend` | `auto`、`keychain`、`dpapi`、`file` | `auto` | `--secrets-backend` | |
| `toolPackages.root` | 已安装工具包的目录，绝对路径 | `<dataDir>/tool-packages` | `--tool-package-root` | |
| `harnessModel.file` | 统一模型文件，绝对路径 | `<dataDir>/harness-model.json` | `--harness-model-file` | |
| `catalog.autoRefresh` | 后台刷新 models.dev 目录 | `true` | | `HH_OFFLINE=1` 时为 `false` |
| `catalog.url` | 目录地址，HTTPS（回环地址可用 HTTP），不含凭据 | models.dev | | |
| `wiring.autoSync` | 网关模型变化时改写已接线 Agent 的模型清单（[全局接线](global-wiring.md#目录同步)） | `true` | | |
| `wiring.home` | 全局接线改写其 Agent 配置的主目录，绝对路径；设置后忽略 shell 中的 `CODEX_HOME` 等目录变量 | 当前用户主目录 | `--wiring-home` | |
| `gateway.limits` | 模型网关上限的覆盖，键与范围见 [`limits.ts`](../packages/gateway/src/limits.ts) | 无覆盖 | | |
| `otlp` | 模型调用的 OTLP 导出（[观测](observability.md)），缺省关闭 | 无 | `--otlp-config FILE`（文件内容整体代替） | |

示例：

```jsonc
// 本机配置
{
  "server": { "port": 3190 },
  "secrets": { "backend": "keychain" },
  "catalog": { "autoRefresh": false },
  "gateway": { "limits": { "idleTimeoutMs": 600000 } },
  "otlp": {
    "endpoint": "https://otel.example.com/v1/traces",
    "headers": { "authorization": { "kind": "env", "value": "OTEL_TOKEN" } }
  }
}
```

## 校验

文件在 `hh serve` 启动与每次 `hh config set`/`unset` 时整体校验，出错时启动以退出码 2 失败、`set` 不写文件，错误信息指出文件与键路径：

| 错误码 | 情形 |
|---|---|
| `CONFIG_UNPARSEABLE` | 不是带注释的 JSON，或根不是对象 |
| `CONFIG_UNKNOWN_KEY` | 不是上表的键（`gateway.limits` 与 `otlp` 内部由各自的解析器检查） |
| `CONFIG_INVALID` | 值不合法，包括参数与环境变量给出的值 |
| `CONFIG_SECRET` | 值看起来是秘密 |

配置文件从不保存秘密。以 `sk-`、`hhk_`、`ghp_`、`AIza`、`eyJ` 等开头的值、`Bearer` 令牌、键名像 `token`、`apiKey`、`secret`、`password`、`authorization` 的字符串值，以及 32 字符以上字母与数字混合的串都被拒绝，并提示用 `hh credential` 保存凭据。接受秘密的设置（如 `otlp.headers`）写秘密引用 `{"kind": "env" | "file" | "keychain" | "store", "value": ...}`。

## `hh config`

```sh
hh config show [--json]          # 每个设置、它的值与来源，以及运行时设置所在的文件
hh config get server.port        # 一个设置、其中的键或一组（server）
hh config set server.port 3190   # 值按 JSON 解析，不是 JSON 时作为文本
hh config set gateway.limits.idleTimeoutMs 600000
hh config unset server.port      # 删除；留下的空对象一并删除
```

`set` 与 `unset` 用保留格式的 JSONC 编辑器原地修改，注释、顺序与缩进保持不变；新文件以 0600 创建，目录为 0700。修改在下一次 `hh serve` 时生效，守护进程不热加载任何设置。

## 不在配置文件中的设置

| 设置 | 位置 | 原因 |
|---|---|---|
| `HARNESSHUB_LOG_LEVEL` | 环境变量 | Worker 从守护进程继承这个变量；配置文件尚未接管 |
| `HARNESSHUB_RUN_TIMEOUT_MS` | 环境变量 | 由引擎登记解析，影响每个 Run |
| `HARNESSHUB_MODEL*` | 环境变量 | 旧的统一模型入口（ADR 0013） |
| `--demo`、`--config-dir` | `hh serve` 参数 | 演示模式与配置根本身 |
| `workspaces`、`consoleDir`、`logEcho`、`cwd` | `startHub` 选项 | 测试与嵌入用的覆盖，以及入口程序的行为 |
| `siwc`、`copilot` | `startHub` 选项 | 只供测试把 ChatGPT 登录与 Copilot CLI 指向本机替身，没有用户设置 |
