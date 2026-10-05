# 出站代理与网络

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 单元测试用本地 `CONNECT` 与 SOCKS5 代理和按脚本应答的原始代理（证书在运行时生成）；网关测试检查代理失败的分类、转移、不重试与不休息；经正式守护进程的集成测试覆盖只能经代理到达的 HTTPS provider 的调用、模型列表与测试、目录刷新与 OTLP 导出、provider 自己的 SOCKS5 代理、失效代理；单可执行文件经 `hh serve --proxy` 的检查只在 macOS arm64 上运行过；真实代理（Clash、Squid、替换证书的企业代理）与 Windows 未验证 |
| 对照 Magpie | 部分（[Packaging and operations](../../magpie-parity.md#packaging-and-operations) 的 outbound proxy 行）：有守护进程与按 provider 的代理；不读系统代理设置，环境变量优先于配置文件（Magpie 相反），没有按订阅账号的代理；另外直连私有网络 |
| 权威文档 | [出站代理](../../configuration.md#出站代理)、[配置参考的设置表](../../configuration.md#设置)、[ADR 0035](../../decisions/0035-outbound-proxy.md) |

## 用途

只能经 HTTP(S) 或 SOCKS5 代理访问外网的用户，让守护进程自己发出的所有请求（模型调用、模型列表、目录刷新、ChatGPT 登录、同步、OTLP 等）都经过代理，并在代理出问题时立即得到指向代理的错误。个别 provider 可以直连或使用另一个代理；本机与内网的服务始终直连。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 › 通用 › 出站代理（只读：地址、密码显示为 `***`、来源与不经代理的主机）；Provider 编辑对话框的“代理”：使用守护进程的代理、直连，或这个代理地址 |
| 命令行 | `hh serve --proxy URL`（或 `direct`）；`hh config set network.proxy URL`、`network.noProxy`、`network.proxyPassword`；`hh config show` 显示值、来源与警告；`hh provider add … --proxy URL`（或 `direct`）；`hh provider proxy <id> URL`（或 `direct`、`default`） |
| HTTP | `GET /api/v1/system/info` 的 `network`；`POST`、`PATCH /api/v1/providers` 的 `proxy` |

## 已实现的能力

- 一个出站策略：守护进程把同一个 `fetch` 交给共享网关的模型调用、`count_tokens` 与图像请求，模型列表刷新，`hh provider test` 与体检，models.dev 目录刷新，ChatGPT 登录、令牌与 JWKS，Codex 透传，联网搜索，WebDAV 与 S3 同步，OTLP 导出。
- 取值顺序：`--proxy`，其次 `https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY` 中第一个非空的（一个代理用于所有请求），再次 `config.jsonc` 的 `network.proxy`；`--proxy direct` 在环境中有代理时关闭它；`network.noProxy` 同样由 `no_proxy`、`NO_PROXY` 优先。`NO_PROXY` 中不识别的条目（`192.168.*`、`<local>`）警告后忽略，配置文件中的则拒绝。
- 协议：`http://`、`https://`、`socks5://`、`socks5h://`（只写 `主机:端口` 为 HTTP）。HTTP 代理以 `CONNECT` 建立隧道，到上游的 TLS 在隧道内以上游主机名协商、证书校验与直连相同；`https://` 代理按主机名校验证书并发送 SNI；SOCKS5 由代理解析主机名。隧道由自己的代码建立，不用 undici 的 `ProxyAgent`。
- 代理凭据：用户名写在地址中，密码来自 `network.proxyPassword` 的秘密引用（`env`、`file`、`keychain`、`store`，启动时读取一次，读不到拒绝启动）或环境变量中的地址；配置文件与 `--proxy` 中带密码的地址以 `CONFIG_SECRET` 拒绝；密码不进入配置文件、日志、账本与 `hh config show`。
- 始终直连：回环与未指定地址（任何写法，含 `::ffff:127.0.0.1` 这样的 IPv4 映射形式）；私有网络 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、链路本地、`100.64.0.0/10`、`fc00::/7`、`fe80::/10`；不带点的主机名与 `.local`、`.home.arpa`、`.internal` 下的名称；以及 `network.noProxy` 的条目（主机名含子域、`*.example.com`、`主机:端口`、IP、CIDR 或 `*`）。
- provider 自己的代理：`direct` 或不含凭据的代理地址，作用于它的模型调用、模型列表、测试与体检；仍直连本机与私有地址，`network.noProxy` 只作用于守护进程的代理；`default` 删除它、回到守护进程的代理。Copilot provider 没有这一项。
- 快速失败：连不上代理、拒绝隧道（含 407）、应答前关闭连接、隧道打开后立即重置、应答之后又发数据、应答无法读取（状态行与 CRLF、SOCKS 版本字节严格检查），或 10 秒内没有建立隧道，请求立即失败，不挂起也不反复重连。
- 失败的两种说法：完整原因（不含凭据的代理地址、隧道目标与原因）写进网关日志 `network.proxy_failed`，`hh provider test` 与体检也显示它；Gateway Key 的调用方、Codex 透传与搜索结果只得到简短原因（如 `The outbound proxy refused the tunnel: 407`）；代理应答中的原因短语从不转述。
- 模型调用的代理失败记为 `errorClass: proxy_failed`、答复 502，直接转移到下一个候选，不在同一候选上重试，也不让凭据休息；`count_tokens` 转发失败时改用本地估算。
- 守护进程启动的 npm 与 Copilot CLI 自己联网，它们的 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 被替换为守护进程的设置；没有代理时这些变量被删除。
- 没有代理时也用自己的直连 `Agent` 而不是 Node 的全局分发器（Node 24.20.0 下后者每个请求多约 1.4 ms）；替换证书的企业代理把根证书放进 `NODE_EXTRA_CA_CERTS`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | 隧道与出站策略 [outbound.ts（daemon）](../../../packages/daemon/src/outbound.ts)、`OutboundFetch` 与 `proxyFailure` [outbound.ts（core）](../../../packages/core/src/outbound.ts)、设置解析 [config-file.ts](../../../packages/daemon/src/config-file.ts)、失败类别 [routing.ts](../../../packages/gateway/src/routing.ts)、控制台 [settings-page.tsx](../../../packages/console/components/settings-page.tsx) 与 [providers-page.tsx](../../../packages/console/components/providers-page.tsx) |
| 测试 | [outbound.test.ts](../../../tests/unit/outbound.test.ts)、[shared-gateway-proxy.test.ts](../../../packages/gateway/test/shared-gateway-proxy.test.ts)、[outbound-proxy.test.ts](../../../tests/integration/outbound-proxy.test.ts)、单可执行文件 [commands.mjs](../../../tools/sea/commands.mjs) |
| 决策 | [ADR 0035 守护进程的出站代理](../../decisions/0035-outbound-proxy.md) |

## 已知限制与未验证

- 不读系统代理设置（macOS 网络设置、Windows Internet 选项）；没有按订阅账号的代理；provider 自己的代理不能带密码，需要密码的代理只能是守护进程的 `network.proxy`。
- 不经过出站策略：Worker 内的 Session 网关（声明了自己 openai-completions provider 的引擎与配置检查）、引擎自己的请求（Session Run 启动的 Claude Code、Codex 等）；网关的内部调用（视觉兜底、分类器）只走回环。
- 是否私有只按地址字面量与名称判断，不查询 DNS；公网名称解析到私有地址时需要写进 `network.noProxy`。
- HTTP 目标同样经 `CONNECT` 隧道，只允许 443 端口隧道的代理不能转发明文 HTTP 上游。
- 设置只在启动时读取，修改后要重启守护进程；控制台只读显示守护进程的代理。
- 不带点的主机名写不进 npm 与 Copilot CLI 的 `NO_PROXY`，它们在这些程序中可能经过代理；这两个程序是否按设置的变量联网未验证。
- 真实代理与 Windows 未验证；单可执行文件的代理检查只在 macOS arm64 上运行过。

## 优化候选

- **现状**：不读系统代理设置。**方向**：出现不经 shell 启动的形态（菜单栏应用、登录时启动）时读取 macOS 与 Windows 的系统代理。**依据**：[ADR 0035](../../decisions/0035-outbound-proxy.md) 后果中的重新评估条件；[TODO.md](../../../TODO.md) 出站代理条目的“未做”。
- **现状**：只有 provider 级别的代理。**方向**：允许订阅账号各有出口。**依据**：[对照表](../../magpie-parity.md#packaging-and-operations) 的 outbound proxy 行（partial）、ADR 0035 的重新评估条件。
- **现状**：Worker 内的 Session 网关直接连接上游，在只能经代理上网的环境中这条路径不可用。**方向**：随 Session 网关的移除一并消除。**依据**：ADR 0035 决定第 6 条；[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)。
- **现状**：没有在真实代理上验证。**方向**：用 Clash、Squid 与替换证书的企业代理各跑一次 `outbound-proxy` 场景并记录。**依据**：ADR 0035 的“未验证”、TODO 出站代理条目的“未验证”。
- **现状**：自己维护约 300 行的 `CONNECT` 与 SOCKS5 客户端。**方向**：undici 修复 `ProxyAgent` 的反复重连后，用现有单元测试复测并考虑换回。**依据**：ADR 0035 的代价与重新评估条件。
