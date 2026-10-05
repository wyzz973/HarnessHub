# 本机访问控制与控制台会话

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 集成测试（回环与非回环绑定下的 Host 与跨源拒绝、`/api/v1` 的凭据与 `Sec-Fetch-Site`、控制台登录码与会话两部分、另一个回环端口重放 Cookie 对每个 `/api/v1` 操作都得到 401、局域网监听器只提供模型路径）与单元测试（会话期限与数量上限），在 macOS arm64 本机通过；ADR 0024 补充记录了一次无头 Chromium 走查；Windows 未验证 |
| 对照 Magpie | 有意不同：Browser version 一行（管理 API 只接受回环，没有远程控制台）、LAN sharing 一行（单独的局域网监听器只提供模型路径）、Loopback callers may use any token 一行（每次调用都要 Gateway Key）；见 [Terminal UI and console](../../magpie-parity.md#terminal-ui-and-console) 与 [LAN sharing and Gateway Keys](../../magpie-parity.md#lan-sharing-and-gateway-keys) |
| 权威文档 | [07 第 5.2 节](../../proposals/oss/07-data-security.md#52-本机管理令牌与控制台会话)、[07 第 5.3 节](../../proposals/oss/07-data-security.md#53-hostorigin-与-sec-fetch-校验)、[ADR 0024 及补充](../../decisions/0024-embedded-console.md#补充会话分为浏览器-cookie-与标签页令牌2026-10-05安全审查-m3)、[模型平面 API：认证与错误](../../model-plane-api.md#认证与错误)、[局域网共享](../../model-gateway.md#局域网共享) |

## 用途

守护进程默认只服务本机：同一台电脑上的 CLI 用令牌文件、浏览器用一次性链接换来的会话访问管理面，其他网页、本机其他端口的服务与局域网上的机器都不能借用这些凭据。开启局域网共享时，局域网只能调用模型，不能管理守护进程。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 打开 `hh console` 打印的链接登录；左下角按钮退出本标签页 |
| 命令行 | `hh console`；其他 `hh` 命令从 `--data-dir` 读取 `admin.token`；`hh gateway share on\|off\|status` |
| HTTP | `POST /api/v1/auth/console-links`（需管理令牌）、`POST /api/v1/auth/console-sessions`、`GET`/`DELETE /api/v1/auth/console-sessions/current` |

## 已实现的能力

- 默认绑定 `127.0.0.1:3180`。所有路由之前的检查：绑定回环地址时 Host 必须是 `localhost`、`127.0.0.1` 或 `[::1]`（可带端口），带 `Origin` 时必须等于 `http://<Host>`，`Sec-Fetch-Site: cross-site` 一律拒绝，均为 403 `LOCAL_ACCESS_REQUIRED`。
- `/api/v1` 另外检查对端 socket 地址是回环（不依赖 Host 头），`Sec-Fetch-Site` 存在时必须是 `same-origin`，并要求管理令牌或控制台会话。
- 不支持 CORS：代码中没有 `OPTIONS` 路由，也不发送任何 `Access-Control-Allow-*` 头；改变状态的 `/api/v1` 请求必须是 JSON，跨源页面无法不经预检发出。
- 管理令牌：首次启动在数据目录生成 `admin.token`（256 位，base64url，0600），已存在则校验后沿用；内存中只保留 SHA-256；文件可被他人读取、是链接或内容无效时以 `ADMIN_TOKEN_INSECURE` 拒绝启动；删除后重启生成新令牌；不经命令行参数或环境变量传递。
- 控制台登录码：128 位、60 秒、只能用一次，放在 URL 片段中，不进入服务器与访问日志；`hh serve` 启动时在 stderr 打印一个（不写日志文件）。
- 控制台会话分两部分：浏览器的 `hh_console` Cookie（`HttpOnly; SameSite=Strict; Path=/`，经 TLS 时加 `Secure`）与标签页的 256 位令牌（只在换取时返回一次，以 `X-HH-CSRF` 随每个请求发送）；只有其中一个或两者不属于同一会话都是 401 `CONSOLE_SESSION_INVALID`，所以收到 Cookie 的本机其他端口在浏览器之外也用不了它。
- 会话创建 7 天或空闲 12 小时后失效；登录码与会话只在内存中以 SHA-256 保存，最多 32 个登录码、64 个会话，守护进程重启即全部失效；同一浏览器的多个标签页各自登录、互不影响。
- 局域网共享开启时另开一个监听器，只把模型协议路径交给网关；`/api/v1`、旧 `/v1` 管理接口、健康检查、`/openapi.json` 与控制台在它上面返回 404，路径中的 Key（`/k/…`）也只在回环监听器上接受。
- 局域网上的每个请求都必须带 `allowLan: true` 且有过期时间的 `client:` Key，否则 403 `source_not_allowed`；Host 只接受声明的地址、名称与 `publicBaseUrl` 的主机；带任何 `Origin` 的请求被拒绝。
- 回环监听器上的模型网关拒绝非回环来源（403 `source_not_allowed`）与任何带 `Origin` 的请求（403 `origin_forbidden`）。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/daemon/src/http/server.ts](../../../packages/daemon/src/http/server.ts)、[packages/daemon/src/http/api-v1.ts](../../../packages/daemon/src/http/api-v1.ts)、[packages/daemon/src/http/console-session.ts](../../../packages/daemon/src/http/console-session.ts)、[packages/daemon/src/admin-token.ts](../../../packages/daemon/src/admin-token.ts)、[packages/daemon/src/lan-share.ts](../../../packages/daemon/src/lan-share.ts)、[packages/cli/src/console.ts](../../../packages/cli/src/console.ts) |
| 测试 | [tests/integration/console.test.ts](../../../tests/integration/console.test.ts)、[tests/integration/gateway-host.test.ts](../../../tests/integration/gateway-host.test.ts)、[tests/integration/gateway-lan-share.test.ts](../../../tests/integration/gateway-lan-share.test.ts)、[tests/integration/api-v1.test.ts](../../../tests/integration/api-v1.test.ts)、[packages/daemon/test/console-session.test.ts](../../../packages/daemon/test/console-session.test.ts) |
| 决策 | [ADR 0024 控制台内嵌守护进程与控制台会话](../../decisions/0024-embedded-console.md)、[ADR 0021 局域网共享](../../decisions/0021-gateway-lan-sharing.md)、[ADR 0013 统一模型网关](../../decisions/0013-unified-model-gateway.md)（非回环绑定） |

## 已知限制与未验证

- 浏览器从其他网站的链接整页打开控制台也得到 403，是否放宽待所有者决定（[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项)）。
- `hh serve --host` 为非回环地址时，服务器级的 Host 检查关闭；旧 `/v1/*` 管理接口没有凭据要求，因而对该网络开放（ADR 0013 说明这种绑定只应在隔离网络中使用）；`/api/v1` 与模型网关仍只接受回环连接。
- 没有 `hh admin-token rotate`：更换令牌只能删除 `admin.token` 后重启守护进程（重启同时结束全部控制台会话）。
- 局域网监听器只有明文 HTTP，Key 以明文传输；没有 07 第 5.4 节的 TLS 要求（`LAN_TLS_REQUIRED`）与按来源 IP 的认证失败封禁。
- 没有针对 CORS 预检的专门测试；07 第 5.3 节写的是 `OPTIONS` 返回 403。
- Windows 上未验证；`admin.token` 的所有者与 0600 检查只在 POSIX 上执行。

## 优化候选

- **现状**：跨站链接打开控制台得到 403。**方向**：只放行 GET 或 HEAD、`Sec-Fetch-Mode: navigate`、`Sec-Fetch-Dest: document` 且指向页面路径的整页导航。**依据**：[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项)。
- **现状**：没有令牌轮换命令。**方向**：实现 `hh admin-token rotate`，旧令牌立即失效并吊销全部控制台会话。**依据**：[07 第 4.4 节](../../proposals/oss/07-data-security.md#44-轮换)、[模型平面 API](../../model-plane-api.md#认证与错误)“尚未实现”、ADR 0024“后果”。
- **现状**：非回环绑定时 Host 检查整体关闭，旧 `/v1` 管理接口暴露。**方向**：每个监听器按允许名单校验 Host，并把执行接口迁到需要凭据的 `/api/v1`。**依据**：[07 第 5.3 节](../../proposals/oss/07-data-security.md#53-hostorigin-与-sec-fetch-校验)（核验 remote-binding-exposure）、[server.ts](../../../packages/daemon/src/http/server.ts) 的 `remoteHosts`。
- **现状**：局域网监听器明文、没有失败封禁。**方向**：支持证书或明确的反向代理模式，并对同一来源的连续认证失败限流。**依据**：[07 第 5.4 节](../../proposals/oss/07-data-security.md#54-局域网共享10)、阅读 [lan-share.ts](../../../packages/daemon/src/lan-share.ts) 的观察。
- **现状**：预检行为与设计文档不一致且无测试。**方向**：明确 `OPTIONS` 的答复并加一条集成测试，或修订 07。**依据**：阅读代码的观察。
