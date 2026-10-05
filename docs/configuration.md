# 配置参考

`hh serve` 的启动设置集中在配置根目录下的 `config.jsonc`（带注释的 JSON），由 [`packages/daemon/src/config-file.ts`](../packages/daemon/src/config-file.ts) 一处解析后交给守护进程。配置根目录见 [07 数据与安全第 1 节](proposals/oss/07-data-security.md#1-数据目录与文件布局)：macOS `~/Library/Application Support/HarnessHub/config`，Windows `%LOCALAPPDATA%\HarnessHub\config`，其他平台 `$XDG_CONFIG_HOME/harnesshub`（绝对路径时）或 `~/.config/harnesshub`；`hh serve --config-dir DIR` 与 `hh config --config-dir DIR` 改用另一个目录。文件不存在等于空配置。

## 启动设置与运行时设置

| | 启动设置 | 运行时设置 |
|---|---|---|
| 位置 | `<配置根>/config.jsonc` | 数据根下各自的文件：局域网共享的 `<dataDir>/gateway-sharing.json`，脱敏、视觉兜底、联网搜索与用量提醒阈值的 `<dataDir>/gateway-features.json` |
| 修改方式 | `hh config set`/`unset` 或直接编辑 | API、控制台或 CLI：`/api/v1/gateway/share` 与 `hh gateway share`（[局域网共享](model-gateway.md#局域网共享)），`/api/v1/gateway/features` 与 `hh gateway features`、`redaction`、`vision`、`search`（[网关功能](gateway-features.md)） |
| 生效 | 下一次 `hh serve` | 立即，由守护进程保存 |

运行时设置不写进 `config.jsonc`，`hh config` 也不修改它们；`hh config show` 只在最后列出它们所在的文件与修改它们的命令。provider、路由组、Key、Profile 与接线记录是存储中的业务记录，也不属于配置文件（[07 数据与安全第 1 节](proposals/oss/07-data-security.md#1-数据目录与文件布局)）。

## 取值顺序

每个设置的值取自第一个给出它的来源：

1. `hh serve` 的命令行参数；
2. 已有文档的环境变量（只有下表列出的几个；一项设置有几个变量时取第一个非空的）；
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
| `network.proxy` | 守护进程自己的出站请求经过的代理（[出站代理](#出站代理)）：`http://`、`https://`、`socks5://` 或 `socks5h://` 地址（只写 `主机:端口` 为 HTTP），或 `direct`（不用代理）；文件与参数中不能含密码 | 无 | `--proxy` | `https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`（可含密码） |
| `network.proxyPassword` | 代理地址写了用户名而没有密码时的密码，秘密引用 `{"kind": "env" \| "file" \| "keychain" \| "store", "value": ...}` | 无 | | |
| `network.noProxy` | 直连、不经守护进程代理的主机：主机名（含子域名，末尾的点可有可无）、`.example.com`、`*.example.com`、`主机:端口`、IPv4 或 IPv6 地址（任意写法，带端口时 IPv6 写在方括号中）、地址范围（`10.0.0.0/8`）或 `*` | 无 | | `no_proxy`、`NO_PROXY`（逗号或空格分隔；其他程序接受而 HarnessHub 不识别的条目，例如 `192.168.*` 与 `<local>`，警告后忽略） |
| `gateway.limits` | 模型网关上限的覆盖，键与范围见 [`limits.ts`](../packages/gateway/src/limits.ts) | 无覆盖 | | |
| `otlp` | 模型调用的 OTLP 导出（[观测](observability.md#otlp-导出)：span，可选 `metrics` 与 `bodies`），缺省关闭 | 无 | `--otlp-config FILE`（文件内容整体代替） | |

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
| `CONFIG_SECRET` | 值看起来是秘密，包括文件或 `--proxy` 中带密码的代理地址 |

配置文件从不保存秘密。以 `sk-`、`hhk_`、`ghp_`、`AIza`、`eyJ` 等开头的值、`Bearer` 令牌、键名像 `token`、`apiKey`、`secret`、`password`、`authorization` 的字符串值，以及 32 字符以上字母与数字混合的串都被拒绝，并提示用 `hh credential` 保存凭据。接受秘密的设置（如 `otlp.headers`）写秘密引用 `{"kind": "env" | "file" | "keychain" | "store", "value": ...}`。

## 出站代理

守护进程自己发出的请求都经过同一个出站策略（[outbound.ts](../packages/daemon/src/outbound.ts)，参照 Magpie `internal/netproxy`，取舍见 [ADR 0035](decisions/0035-outbound-proxy.md)）：provider 的模型调用、`count_tokens`、图像、模型列表刷新、`hh provider test` 与 `doctor`、models.dev 目录刷新、ChatGPT 登录与令牌（Sign in with ChatGPT 与 JWKS）、Codex 透传到 chatgpt.com、联网搜索后端、WebDAV 与 S3 同步、OTLP 导出。安装 Copilot SDK 的 npm 与 Copilot CLI 由守护进程启动、自己联网，它们的 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 被替换为守护进程的代理（含凭据），`NO_PROXY` 列出回环地址、下面的私有地址范围与名称后缀，以及 `network.noProxy`（不带点的主机名无法写进 `NO_PROXY`，它们在这些程序中可能经过代理）；没有代理时这些变量被删除。

- **取值**：`--proxy` 优先，其次是 `https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`（取第一个非空的；一个代理用于所有请求，只设了 HTTP 代理时 HTTPS 也经过它），再次是 `network.proxy`。`--proxy direct` 在环境中有代理时关闭它。`network.noProxy` 同样由 `no_proxy`/`NO_PROXY` 优先。`NO_PROXY` 也被其他程序读取：其中 HarnessHub 不识别的条目（`192.168.*`、`<local>` 等）被忽略，`hh serve` 在标准错误、`hh config show` 在输出末尾（`--json` 时为 `warnings`）各给出一条 WARNING，守护进程照常启动；配置文件中这样的条目仍以 `CONFIG_INVALID` 拒绝。`startHub` 本身不读这些变量，只有 `hh serve` 按上面的顺序传入。
- **不经代理**：本机地址（`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`，以及未指定地址 `0.0.0.0` 与 `::`，任何写法，包括 `::ffff:127.0.0.1` 这样的 IPv4 映射形式）从不经过代理；私有网络也直连，守护进程的代理与 provider 自己的代理都是如此：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、链路本地地址、`100.64.0.0/10`（运营商 NAT 与 Tailscale）、`fc00::/7`、`fe80::/10`，以及不带点的主机名和 `.local`、`.home.arpa`、`.internal` 下的名称。公网名称解析到私有地址的情形无法在不查询 DNS 的情况下判断，需要写进 `network.noProxy`。
- **协议**：HTTP 代理以 `CONNECT` 建立隧道，HTTPS 上游的 TLS 在隧道内与上游直接协商（`https://` 代理另有一层到代理的 TLS）；SOCKS5 由代理解析主机名（`socks5` 与 `socks5h` 相同）。`https://` 代理按它的主机名校验证书并发送 SNI（地址形式的代理不发 SNI）。代理的应答严格读取：状态行须为 `HTTP/1.0` 或 `HTTP/1.1` 加三位状态码，各行以 CRLF 结束；SOCKS5 检查各应答的版本字节，目标主机名超过 255 字节时不发出请求；应答之后、隧道使用之前代理又发来的数据视为代理故障。代理的凭据：用户名写在地址中，密码来自 `network.proxyPassword` 的秘密引用，或写在环境变量的地址中（`http://user:pass@host:port`，特殊字符按 URL 编码）。HTTP 代理以 `Proxy-Authorization: Basic` 发送，SOCKS5 按 RFC 1929。密码不进入配置文件、日志、账本或 `hh config show`（显示为 `***`）；守护进程启动时读取一次 `proxyPassword`，读不到时以 `CONFIG_INVALID` 拒绝启动。
- **provider 自己的代理**：provider 的 `proxy` 为 `direct`（不经代理）或不含凭据的代理地址时，它的模型调用、模型列表、测试与体检改用它（Magpie 的按 provider 代理），仍不代理本机与私有网络的地址（可能以明文发送的请求不离开本地网络），`network.noProxy` 只作用于守护进程的代理；`hh provider add … --proxy URL|direct`，`hh provider proxy <id> [URL|direct|default]`（`default` 删除，回到守护进程的代理），API 为 `POST`/`PATCH /api/v1/providers` 的 `proxy`。需要密码的代理只能是守护进程的 `network.proxy`。Copilot provider 没有 `proxy`：它的请求由 Copilot CLI 发出。
- **失败**：连不上代理、代理拒绝隧道（包括 407 要求凭据）、代理在应答前关闭连接、应答隧道已打开后立即重置连接或在请求发出时重置（隧道里还没有任何字节回来）、应答之后多发数据、应答无法读取，或 10 秒内没有建立隧道时，请求立即失败，不会挂起或反复重连。守护进程的网关日志（`<dataDir>/logs/gateway.log`）记一条 `network.proxy_failed`，含代理地址（不含凭据）、隧道目标与原因；Gateway Key 的调用方与搜索结果中的模型只得到简短的原因（例如 `The outbound proxy refused the tunnel: 407`），不含代理地址与目标；`hh provider test` 与体检给出完整原因。代理应答中的原因短语与其他文字从不转述。模型调用的账本 `errorClass` 为 `proxy_failed`，响应 502 `proxy_failed`；这次失败不让该凭据休息，也不在同一候选上重试，直接转移到下一个候选。`count_tokens` 转发失败时改用本地估算；搜索后端的失败原因写进工具结果。
- **查看**：`GET /api/v1/system/info` 的 `network` 给出启动时生效的代理（密码显示为 `***`，直连为 `null`）、`noProxy` 与 `network.proxy` 的来源（`flag`、`env` 或 `file`，未设置为 `null`）；控制台在“设置 › 通用”中只读显示它，修改需要改设置后重启守护进程。provider 自己的代理也可以在控制台的 provider 表单中设置。
- **TLS 检查型代理**：会替换证书的企业代理，把它的根证书放进 `NODE_EXTRA_CA_CERTS`（Node 的标准变量，启动时读取）。
- **不经过这里的请求**：引擎自己（Session Run 启动的 Claude Code、Codex 等）按各自的环境联网；Worker 内的 Session 网关（声明了自己 openai-completions provider 的引擎与配置检查，[共享网关](model-gateway.md#session-run-与共享网关)）仍直接连接上游，不读这些设置；网关对自己的内部调用（视觉兜底、分类器）只走回环；`hh` 命令只连接本机守护进程。

与 Magpie 的差异：Magpie 的设置优先于环境变量，HarnessHub 按本页的统一顺序（参数、环境变量、文件）；Magpie 还读取系统代理设置（macOS 网络设置、Windows Internet 选项），HarnessHub 不读；Magpie 只直连回环地址，HarnessHub 另外直连私有网络与 `noProxy`；Magpie 的订阅账号可以各有代理，HarnessHub 只有 provider 级别。实现自己建立隧道而不用 undici 的 `ProxyAgent`：代理收到 `CONNECT` 后不应答就关闭连接时，`ProxyAgent`（undici 7.29.1）会在调用方的期限内不停重连（实测 3 秒约 3.4 万次连接），失败也不说明是代理的问题。

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
