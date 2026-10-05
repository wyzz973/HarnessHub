# 局域网共享与级联

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（共享设置的解析与无效样例、局域网入口只接受 `allowLan` 的 `client:` Key（含模拟的非回环对端）、Host 规则、两个入口都拒绝浏览器 `Origin`、`publicBaseUrl`、`count_tokens` 的转发与回退）；经正式守护进程的集成测试（开启、持久化、重启、端口占用与启动时绑定失败、局域网监听器上没有管理接口，以及两个守护进程的级联 A → B → 白名单假 provider：四种协议直通、B 转换一次、实时模型列表与 `count_tokens`）；路径中的 Key 与 Codex 透传在局域网监听器上 404 另有测试；macOS arm64，两个守护进程在同一台机器上。真实的多机网络与 Windows 未验证 |
| 对照 Magpie | 有意不同：单独的局域网监听器只提供模型路径；相同：远程调用方需要具名 Key、反向代理后的公开地址、另一台实例作上游；未覆盖：跨实例的图像与视频模型、跨实例显示调用的 Agent 与电脑（[对照表](../../magpie-parity.md#lan-sharing-and-gateway-keys)） |
| 权威文档 | [局域网共享](../../model-gateway.md#局域网共享)、[另一台 HarnessHub 作为上游](../../model-gateway.md#另一台-harnesshub-作为上游)、[资源](../../model-plane-api.md#资源)（gateway/share）、[ADR 0021](../../decisions/0021-gateway-lan-sharing.md) |

## 用途

让同一局域网中的其他电脑或同事使用这台 HarnessHub 的 provider、额度与账本，而管理接口与控制台不对网络开放；也可以反过来，把另一台开启了共享的 HarnessHub 当作一个 provider，经它的路由组与凭据调用模型。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 通用 → 局域网共享（开关、监听地址、端口、主机名、公开地址，明文 HTTP 的警告，开启前确认；显示是否在监听、端口、对端地址与错误）；路由与 Key → Gateway Key 创建时勾选“局域网” |
| 命令行 | `hh gateway share status\|off\|on [--host IP] [--port N] [--name HOST]... [--public-base-url URL]`；`hh key create --name N --allow REF... --lan [--expires-at TIME]`；`hh provider add <id> --preset harnesshub-remote --base URL --credential-from-stdin` |
| HTTP | `GET`、`PUT /api/v1/gateway/share`；`POST /api/v1/gateway-keys` 的 `allowLan` |

## 已实现的能力

- 守护进程默认只在回环地址监听；开启共享后另在声明的地址上开一个局域网监听器，只把模型协议路径交给网关；`/api/v1`、`/v1` 下的旧管理接口、健康检查、`/openapi.json`、控制台、Codex 透传、`/k/<Key>` 路径与 `/muse-code/models` 在它上面都答复 404；不规范的路径先以 400 `path_not_canonical` 拒绝。
- 设置 `{lan: {enabled, host, port, names}, publicBaseUrl}`：`host` 必须是本机 IP，`0.0.0.0` 或 `::` 表示全部地址，此时需要 `names` 或 `publicBaseUrl`；`port` 缺省为守护进程端口，0 由系统选择；`names` 至多 20 个；保存在 `<dataDir>/gateway-sharing.json`（原子替换），文件无效时以 `INVALID_CONFIG` 拒绝启动。
- `PUT` 先绑定新地址，再写文件，最后关闭旧监听器；绑定失败 409 `GATEWAY_SHARE_LISTEN_FAILED`、设置无效 400 `GATEWAY_SHARE_INVALID`，都不改变现状；启动时绑定失败不阻止启动，写 `gateway.lan.listen_failed` 日志并在状态的 `error` 中显示。
- 局域网监听器上的每个请求都必须带 `allowLan: true` 的 `client:` Key，不论对端地址；其他 Key 返回 403 `source_not_allowed`；`allowLan` 的 Key 必须有过期时间（缺省 90 天，不能 `--no-expiry`）。
- Host 按监听器分别校验：局域网监听器接受 `host:端口`、每个 `names` 加端口与 `publicBaseUrl` 的主机；两个监听器都拒绝任何带 `Origin` 的请求与 `Sec-Fetch-Site: cross-site`。
- 状态给出 `listening`、实际绑定的 `boundPort`、对端使用的基址 `urls` 与 `error`；守护进程关闭时先关闭网关，再关闭局域网监听器。
- 局域网 Key 看不到、也用不到订阅 provider 的模型；分类器与图片描述等内部调用同样受这把 Key 的局域网规则约束。
- 级联：预设 `harnesshub-remote`（`relay`，Bearer 认证，四种协议的端点在同一基址下）以对方签发的 `--lan` Key 为 Credential；四种入站协议都直通到对方的同名端点，整条链路最多转换一次（在对方）；对方的 `provider/model` 在本机是 `<本 provider id>/provider/model`，路由组是 `<id>/group/<组名>`；模型列表从对方的 `/v1/models` 读取窗口、输出上限、推理与输入模态；`count_tokens` 转发并保留对方的 `x-hh-token-count`。
- 共享设置进入备份；同步有意不带它，以免在另一台电脑上打开共享。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [daemon/lan-share.ts](../../../packages/daemon/src/lan-share.ts)、[gateway/sharing.ts](../../../packages/gateway/src/sharing.ts)、[daemon/model-gateway-mount.ts](../../../packages/daemon/src/http/model-gateway-mount.ts)、[daemon/gateway-share-routes.ts](../../../packages/daemon/src/http/gateway-share-routes.ts)、[gateway/count.ts](../../../packages/gateway/src/count.ts)、[presets/harnesshub-remote.json](../../../packages/gateway/presets/harnesshub-remote.json)、[console/settings-page.tsx](../../../packages/console/components/settings-page.tsx) |
| 测试 | [shared-gateway-lan](../../../packages/gateway/test/shared-gateway-lan.test.ts)；集成 [gateway-lan-share](../../../tests/integration/gateway-lan-share.test.ts)、[agents-keypath](../../../tests/integration/agents-keypath.test.ts)、[key-text-leaks](../../../tests/integration/key-text-leaks.test.ts) |
| 决策 | [ADR 0021 局域网共享与级联](../../decisions/0021-gateway-lan-sharing.md) |

## 已知限制与未验证

- 局域网监听器是明文 HTTP，Key 以明文传输；只应在可信网络使用，或放在 TLS 反向代理之后。
- 局域网 Key 不要求设置预算，也没有按来源 IP 的失败锁定。
- `hh status` 不显示共享状态（要用 `hh gateway share status`）；[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)仍把“控制台中的共享状态”列为未实现，但设置页已显示监听状态、端口、地址与错误。
- 浏览器客户端不能使用局域网共享（任何 `Origin` 都被拒绝）。
- 级联时两端各记一条账本；对方只记录本机的 `--lan` Key，看不到是哪个 Agent 或哪台电脑；跨实例的图像与视频模型不可用。
- 共享设置在数据目录的文件中，不在存储的设置表里。
- 两个守护进程只在同一台机器上测试过，真实多机网络、Windows 未验证。

## 优化候选

- **现状**：局域网流量是明文 HTTP。**方向**：局域网监听器支持 TLS（证书由用户提供），或提供“只在回环上监听、由反向代理对外”的配置说明与检查。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)；[ADR 0021](../../decisions/0021-gateway-lan-sharing.md) 后果。
- **现状**：局域网 Key 可以没有预算，鉴权失败也不会被锁定。**方向**：签发 `--lan` Key 时要求至少一项预算，并按来源 IP 锁定反复失败的请求。**依据**：同上。
- **现状**：`hh status` 不显示局域网共享的状态（控制台设置页已显示）。**方向**：在 `hh status` 中加入监听地址、状态与错误。**依据**：阅读 [admin.ts](../../../packages/cli/src/admin.ts) 的 `statusCommand` 与 [settings-page.tsx](../../../packages/console/components/settings-page.tsx) 的观察。
- **现状**：级联的对方看不到调用的 Agent 与电脑。**方向**：以请求头把调用方的 Agent 与电脑名传给对方，对方记在账本的归属中（只在 `--lan` Key 上接受）。**依据**：对照表 The calling agent and computer shown across instances 行未覆盖。
- **现状**：图像请求不能经级联使用对方的画图模型。**方向**：`harnesshub-remote` 预设同时声明对方的图像端点。**依据**：对照表 Image and video models across instances 行未覆盖。
