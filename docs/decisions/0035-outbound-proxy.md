# ADR 0035：守护进程的出站代理

Status: proposed

日期：2026-10-05
关联决定：[配置参考的出站代理](../configuration.md#出站代理)、[ADR 0025](0025-magpie-routing-parity.md)（失败类别与休息）、[ADR 0019](0019-session-runs-on-the-shared-gateway.md)（Session Run 使用共享网关）；参照 Magpie（yetone/magpie@2e340f7，MIT）的 `internal/netproxy`

## 问题

很多用户只能经 HTTP(S) 或 SOCKS5 代理访问 OpenAI、Anthropic、Google 与 models.dev。守护进程用 Node 的 `fetch` 发出请求，而 Node 不读 `HTTPS_PROXY`（除非整个进程设置 `NODE_USE_ENV_PROXY`），所以模型调用、模型列表、目录刷新、ChatGPT 登录、同步与 OTLP 导出都直接连接上游，在这些网络中会失败或挂起到超时。

Magpie 的做法：自己的设置（或 `direct`）优先，其次是 `*_PROXY` 环境变量，再次是系统代理设置；每个 provider（以及每个订阅账号）可以有自己的代理或 `direct`；回环地址从不经过代理；代理连不上时失败类别为 `proxy`，不让凭据休息。

## 决定

1. **一个出站策略**：守护进程的组合根（`startHub`）创建一个 `Outbound`（[outbound.ts](../../packages/daemon/src/outbound.ts)），把它的 `fetch`（`@harnesshub/core/outbound` 的 `OutboundFetch`）交给共享网关、模型列表、`hh provider test` 与体检、目录刷新、Sign in with ChatGPT（令牌、撤销与 JWKS）、Codex 透传、联网搜索、WebDAV 与 S3 同步和 OTLP 导出；为某个 provider 发出的请求带上它自己的代理。`Outbound` 在所有使用者停止后最后关闭。npm 与 Copilot CLI 自己联网，它们的 `*_PROXY` 与 `NO_PROXY` 按守护进程的代理设置（含凭据）。
2. **自己建立隧道，不用 undici 的 `ProxyAgent`**：`fetch` 的 `dispatcher` 是一个 undici `Agent`，它的连接函数按目标决定直连还是经代理；经代理时由我们打开隧道：HTTP 代理用 `CONNECT`（经 TCP，或 `https://` 代理时经 TLS），SOCKS5 按 RFC 1928 与 RFC 1929，主机名交给代理解析。到上游的 TLS 仍由 undici 的 `buildConnector` 以原主机名在隧道内协商，证书校验与直连时相同。`https://` 代理按主机名校验证书并发送 SNI（地址不发，RFC 6066）。隧道 10 秒内没有建立、代理连不上、拒绝隧道（含 407）、在应答前关闭连接、应答隧道已打开后立即重置连接、应答之后又发来数据，或应答无法读取时，请求以 `TypeError` 失败，其 `cause.code` 为 `PROXY_FAILED`。应答严格读取：状态行须为 `HTTP/1.x` 加正好三位的状态码，各行以 CRLF 结束（只有 LF 时立即失败，不等到期限）；SOCKS5 检查方法选择、认证状态（版本 1）与回复（版本 5）的版本字节；目标主机名超过 255 字节时不发出请求（长度只有一个字节）。应答之后的数据不交给 undici：HTTP 与 TLS 都不允许服务端先发数据，这些字节会被当成上游的答复，而 undici 在请求写出前收到答复时会无上限地重连（第二轮安全审查实测 1.4 秒 16,096 个连接）。重置连接的情况下 undici 写请求时对套接字设置服务类型会同步抛出（macOS 上为 EINVAL），而且发生在 undici 自己的 catch 之外；交给 undici 之前先以同样的值设置一次，失败即算代理的失败，交接中仍抛出的异常被捕获并销毁套接字，不会成为结束守护进程的未处理 rejection。失败有两种说法：完整的一种指出代理（不含凭据）、隧道目标与原因，写进网关日志的 `network.proxy_failed`，`hh provider test` 与体检也给出它；简短的一种（`proxyFailure` 的 `brief`，例如 `The outbound proxy refused the tunnel: 407`）不含代理地址与目标，交给 Gateway Key 的调用方、Codex 透传与搜索结果中的模型。两种都不转述代理应答中的文字（原因短语可能是任意文本，进入模型上下文就是提示注入）。
3. **取值顺序与 HarnessHub 的其他设置相同**：`hh serve --proxy`（地址或 `direct`）优先，其次是 `https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`，再次是 `config.jsonc` 的 `network.proxy`；`network.noProxy` 同样由 `no_proxy`/`NO_PROXY` 优先。这与 Magpie（设置优先于环境变量）不同；需要在环境中有代理时关闭它，用 `--proxy direct`。系统代理设置不读。代理的密码只来自环境变量中的地址，或 `network.proxyPassword` 的秘密引用；文件与 `--proxy` 中带密码的地址是 `CONFIG_SECRET`，`hh config show` 显示为 `***`。
4. **私有网络直连**：回环地址从不经过代理（与 Magpie 相同）；另外默认直连私有与链路本地地址（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`100.64.0.0/10`、`fc00::/7`、`fe80::/10`）、不带点的主机名与 `.local`、`.home.arpa`、`.internal` 下的名称，以及 `network.noProxy` 中的条目。本机地址包括 `0.0.0.0` 与 `::`；地址用 `BlockList` 比较，IPv6 的任何写法与 IPv4 映射形式（`::ffff:127.0.0.1`、`::ffff:7f00:1`）都按地址识别。是否私有只按地址字面量与名称判断，不查询 DNS。provider 自己的代理（`direct` 或不含凭据的地址）同样直连本机与私有地址：私有地址允许 `http://`（[provider 记录](../../packages/core/src/model-plane-records.ts)），经代理就会把明文请求（含 API key）送出本地网络；`network.noProxy` 只作用于守护进程的代理。`noProxy` 接受的写法就是能匹配的写法：IPv6 地址可带或不带方括号（带端口时必须带），主机名末尾的点可有可无。环境变量 `NO_PROXY` 也被其他程序读取，其中 HarnessHub 不识别的条目（`192.168.*`、`<local>`）警告后忽略，不拒绝启动；配置文件中的仍拒绝。npm 与 Copilot CLI 的 `NO_PROXY` 列出回环、上述私有范围与名称后缀和 `noProxy`。
5. **代理失败不算凭据的失败**：网关把 `PROXY_FAILED` 记为 `proxy_failed`（类别 `proxy`，来源 `gateway`），答复 502 `proxy_failed`；它立即转移到下一个候选，不在最后一个候选上重试，也不计入凭据的熔断（Magpie 的 `proxy` 同样不休息）。`count_tokens` 转发失败时改用本地估算，搜索后端的失败原因写进工具结果。
6. **不经过出站策略的请求**：
   - **Worker 内的 Session 网关**（[gateway.ts](../../packages/gateway/src/gateway.ts)，声明了自己 openai-completions provider 的引擎与配置检查）：它在 Worker 进程中运行，得不到守护进程的设置；把代理（可能含密码）经 IPC 交给每个 Worker，只为一条要移除的遗留路径，不值得。
   - **引擎自己的请求**：Session Run 启动的 Claude Code、Codex 等用它们自己的 HTTP 客户端与环境（例如用自己的登录直连厂商）；走共享网关的调用只到回环上的守护进程。
   - 网关对自己的内部调用（视觉兜底、分类器）只走回环；`hh` 命令只连接本机守护进程。
7. **undici 成为守护进程的依赖**：`undici` 7.29.1（MIT，已经因 `openai` 在锁文件中）列入 `@harnesshub/daemon` 的依赖，只用它的 `Agent` 与 `buildConnector`。Node 24.20.0 自带的 undici 是 7.29.0，`fetch` 接受同一主版本的 dispatcher；两者的类型不同，传入处有一次类型转换。单可执行文件把它打包进去。

## 考虑过的替代方案

- **undici 的 `ProxyAgent` 或 `EnvHttpProxyAgent`**：代理收到 `CONNECT` 后不应答就关闭连接时，`ProxyAgent` 不停重连，直到调用方的期限：undici 7.29.1、Node 24.20.0、macOS arm64 上 3 秒内本地测试代理收到 34,437 次连接；它的失败也不说明是代理的问题（拒绝隧道时是 `UND_ERR_ABORTED`，连不上时只是一个 `ECONNREFUSED`，要比对地址才知道是代理），网关难以分出 `proxy` 类别。它的 SOCKS5 支持还是实验性的（每个进程打印一次 `ExperimentalWarning`）。
- **`NODE_USE_ENV_PROXY` 或 `setGlobalDispatcher`**：作用于整个进程，不能按 provider 选择代理，也读不到配置文件；测试在同一进程中启动多个守护进程，全局分发器会让它们互相影响。
- **Magpie 的取值顺序（设置优先于环境变量）**：Magpie 的应用常从 Dock 或开始菜单启动，没有 shell 的环境变量；`hh serve` 从终端启动，HarnessHub 的所有设置都是参数、环境变量、文件的顺序，代理不另立规则。
- **交接时只捕获异常**：只在把套接字交给 undici 时 try/catch，进程不再退出，请求也会失败，但失败是 undici 的 `EINVAL`，网关会把它当成上游不可达而重试并计入凭据的熔断；先以 undici 要设的值试设一次，失败才能归为代理的失败。
- **截短后转述代理的原因短语**：截短不能去掉注入的文字，而原因短语对用户没有状态码之外的价值；完整原因写进日志即可。
- **查询 DNS 判断目标是否私有**：解析发生在代理之外，会泄露要访问的主机，在只能经代理解析的企业网络中还会失败或变慢。
- **provider 自己的代理带凭据**：provider 记录不是秘密，会进入备份与同步；需要密码的代理只能是守护进程的 `network.proxy`。

## 后果

- 收益：守护进程的全部出站请求在代理后可用，失败时立即给出指向代理的错误，不会挂起或反复重连；账本能区分代理故障与上游故障，代理故障不让凭据休息。
- 代价：我们维护自己的 `CONNECT` 与 SOCKS5 客户端（约 300 行）；`undici` 的版本要与 Node 自带的保持同一主版本；`OutboundFetch` 在各包之间多一个注入参数。
- 限制：系统代理设置、按订阅账号的代理、Worker 内的 Session 网关与引擎自身的请求不在范围内；公网名称解析到私有地址时需要用户写进 `network.noProxy`；HTTP 目标同样经 `CONNECT` 隧道，只允许 443 端口隧道的代理不能转发明文 HTTP 上游。
- 重新评估条件：
  - undici 修复了上述重连：用单元测试“a dead or misbehaving proxy fails fast …”（要求关闭型代理只收到 1 次连接）对新版本 `ProxyAgent` 复测，通过后可以换回它；
  - 出现不经 shell 启动的形态（菜单栏或桌面应用、登录时启动）：再考虑读取系统代理设置；
  - Worker 内的 Session 网关移除后，第 6 项的第一条随之消失；
  - 用户需要按订阅账号区分出口。

## 验证要求

- 单元测试（[outbound.test.ts](../../tests/unit/outbound.test.ts)，本地 `CONNECT` 与 SOCKS5 代理和按脚本应答的原始代理，证书在运行时生成）：应答后多发数据时只有 1 次连接；拒绝时完整与简短两种说法、不转述原因短语、日志记录；严格读取（状态码、CRLF、SOCKS 版本字节）；超过 255 字节的主机名；`https://` 代理的 SNI；provider 自己的代理直连私有地址与映射形式的回环地址；`noProxy` 的各种写法；HTTP 与 HTTPS 上游经隧道，TLS 在隧道内以上游的名称完成；回环、私有地址与 `noProxy` 直连；用户名与秘密中的密码、407；连不上、关闭与不应答的代理快速失败且只有 1 次连接；应答后立即重置连接的 CONNECT 与 SOCKS5 代理以 `PROXY_FAILED` 失败，测试进程不崩溃；`https://` 代理；provider 自己的代理；子进程的环境变量。
- 网关测试（[shared-gateway-proxy.test.ts](../../packages/gateway/test/shared-gateway-proxy.test.ts)）：代理失败为 `proxy_failed`、转移、不重试、不休息（去掉这条分类时测试失败），provider 的代理随请求传入，Codex 透传与搜索经注入的 `fetch`。
- 正式守护进程入口（[outbound-proxy.test.ts](../../tests/integration/outbound-proxy.test.ts)）：只能经代理到达的 HTTPS provider 的调用、模型列表与测试，目录刷新与 OTLP 导出经代理，回环 provider 直连，provider 自己的 SOCKS5 代理，失效代理的 502 `proxy_failed`（调用方只得到简短原因，网关日志记 `network.proxy_failed`），文件秘密中的密码不出现在数据目录中，`hh config show` 的掩码与对 `NO_PROXY` 中无法识别条目的警告，`hh provider proxy`。
- 单可执行文件（[commands.mjs](../../tools/sea/commands.mjs)，`pnpm test:sea`）：`hh serve --proxy` 经本地 CONNECT 代理调用只能经代理到达的 HTTPS provider，上游证书经 `NODE_EXTRA_CA_CERTS` 信任；去掉 `--proxy` 时这一步失败。只在 macOS arm64 上运行过。
- 未验证：真实代理（Clash、Squid、替换证书的企业代理）；Windows 与其他平台上的可执行文件；npm 与 Copilot CLI 是否按设置的变量联网。
