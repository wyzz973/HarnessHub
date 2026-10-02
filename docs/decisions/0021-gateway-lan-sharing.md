# ADR 0021：局域网共享与级联

Status: proposed

日期：2026-10-03
关联决定：[03 模型平面](../proposals/oss/03-model-plane.md)（第 1、2 节）、[06 接口与交互面](../proposals/oss/06-interfaces.md)（第 1 节）、[07 数据与安全](../proposals/oss/07-data-security.md)（第 5.3、5.4 节）、开源版 ADR-P03

## 问题

共享网关只接受回环连接。一人多机或小团队想让其他机器使用同一套 provider、额度与账本，或者把另一台 HarnessHub 当作上游（Magpie 的 “Share on local network” 与 “Remote magpie”）。同时，管理接口不能因此对网络开放，同机任意进程或网页也不能借局域网入口消耗额度。

## 决定

- 共享开启时守护进程另开一个局域网监听器，只把模型协议路径交给网关的 `lan` 入口；其他路径（`/api/v1`、旧 `/v1` 管理接口、控制台、健康检查）在它上面不存在。回环监听器照旧，并继续拒绝非回环对端。
- 局域网监听器上的请求一律按局域网来源处理，不看对端地址：只有标记 `allowLan` 的 `client:` Key 被接受，否则 403 `source_not_allowed`。`allowLan` 只能出现在 `client` 作用域上，且这种 Key 必须有过期时间。
- Host 按监听器分别校验：局域网监听器接受声明的地址与名称（带实际端口）和 `publicBaseUrl` 的主机，回环监听器接受回环名称和 `publicBaseUrl` 的主机。两个监听器都拒绝任何带 `Origin` 的请求与 `Sec-Fetch-Site: cross-site`：网关接线的客户端都不是浏览器。
- 设置 `{lan, publicBaseUrl}` 由 `resolveGatewaySharing` 解析，保存在 `<dataDir>/gateway-sharing.json`（带 `schemaVersion`、原子替换），经 `GET`、`PUT /api/v1/gateway/share` 与 `hh gateway share` 修改。`PUT` 先绑定新地址再保存，失败不改变现状。
- 启动时已开启的设置绑定失败不阻止守护进程启动：原因写日志并在状态中显示，用户仍可修改或关闭共享。文件内容无效时启动失败。
- 另一台 HarnessHub 用预设 `harnesshub-remote`（`relay`）接入：四种协议的端点都在对方基址下，所以每种入站协议都直通，整条链路只在对方转换一次；对方的 Model Ref 成为本机 provider 下的模型名，模型列表读对方的 `/v1/models`。
- Anthropic `count_tokens` 在路由有直通 Anthropic 端点时转发上游，否则返回本地估算，并用 `x-hh-token-count` 区分。

## 考虑过的替代方案

- **同一监听器按对端地址区分**（Magpie 的 `lanGuard`）：同机的反向代理转发来的请求在 socket 层是回环地址，可以到达管理接口；两个监听器让管理路由在局域网入口上根本不存在。
- **把设置写进模型平面的 SQLite**：需要新的设置表与迁移，而这份设置只有守护进程读写，也要能在数据库不可用时被人工检查；数据目录中的小文件与 `harness-model.json`、`admin.token` 同类。
- **启动时绑定失败即退出**：笔记本换网络后地址消失，守护进程起不来，而关闭共享又需要守护进程在运行，只能手工编辑文件。
- **监听全部地址时不校验 Host**：DNS rebinding 的 Host 是攻击者的域名；因此要求声明名称或 `publicBaseUrl`。
- **接受局域网监听器自己的源与 `publicBaseUrl` 的源**（07 第 5.3 节允许同源）：没有接线的客户端是浏览器，接受浏览器源只扩大攻击面。

## 后果

- 局域网监听器目前是明文 HTTP，Key 以明文传输。07 第 5.4 节要求 TLS 或“只在回环上监听并位于代理之后”，这两项与 `allowLan` Key 的额度要求、按来源 IP 的失败锁定都尚未实现，文档要求只在可信网络使用或放在 TLS 反向代理之后。
- 级联时两端各记一条账本；本机的用量取自对方的答复，对方转换为 Anthropic 时推理 token 计入输出。
- 浏览器客户端不能使用局域网共享。需要时以默认关闭的单独开关（如 `lan.allowBrowserOrigins`）加入，而不是放宽默认规则。
- 设置文件是存储之外的第二个持久位置；模型平面以后有设置表时，它是迁入的候选。
