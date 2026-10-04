# ADR 0033：不能发送请求头的 Agent 把 Gateway Key 放在路径中

Status: proposed

日期：2026-10-05
关联决定：[ADR 0030](0030-codex-chatgpt-mode-models.md)（本记录把其中只用于 Codex 透传的“Key 放在路径中”扩展到模型协议路径）、[ADR 0022](0022-agent-wiring-semantics.md)、[全局接线](../global-wiring.md)、[模型网关](../model-gateway.md#路径中的-key)

## 问题

HarnessHub 的模型调用都要求 Gateway Key，按 Key 做模型白名单、额度与账本归属；全局接线因此只收录能把 Key 写进配置的 Agent。Magpie 的回环网关不鉴权，它接线的 Command Code、fx 与 Muse Code 都不带 Key：Command Code 拒绝 `providers.json` 中写出的 Key（Magpie 写 `apiKey: false`），fx 自定义 provider 的 `auth` 只见过 `{type: "none"}`，Muse 的 `auth` 只有 Meta 登录令牌（`bearer`）或 `none`。三者都只能配置一个基址。Muse 另外在基址所在主机的 `/muse-code/models` 读取模型列表（与基址的路径无关），没有这个列表就不开会话。

## 决定

- **Key 放在基址的路径里**：这些 Agent 的基址写成 `<网关>/k/<agent Key>/v1`。网关在任何其他处理之前去掉 `/k/<段>`，与 [ADR 0030](0030-codex-chatgpt-mode-models.md) 的 `codexRoute` 共用同一个切分（[key-path.ts](../../packages/gateway/src/key-path.ts)），账本的 `inbound.path`、日志、OTLP 导出与转发给上游的请求都不含这一段。其余处理与请求头中的 Key 相同：白名单、额度、账本归属、会话键。
- **只在回环、只收 agent Key**：守护进程只在回环监听器上把 `/k/` 下的路径交给网关，局域网监听器答复 404；网关自己也拒绝局域网监听器与非回环来源（403 `source_not_allowed`）。这一段不是 Key 的格式、Key 未知、已吊销或已过期时本地答复 401；`client:` 与 `session:` Key 放在路径中答复 401（“Only an agent key may go in the path”），它们照旧放在请求头中。请求头中另带一把不同的 Key 时按“不同的凭据”答复 401。错误消息与 404 都不回显路径。`/k/<Key>` 之后不是模型协议路径（包括 Codex 透传）时 404。
- **Muse 的模型列表**：网关在回环上提供 `GET /muse-code/models`，格式按 Magpie 的 `gw/muse.go`（每个模型的 `metadata["muse-code"]`，窗口与输出上限未知时取 128000 与 32000）。这个请求不带基址的路径，也不带凭据，所以列出的是最新一把有效的 `agent:muse` Key 可用的模型；没有这样的 Key 时 404。它只读、不调用模型、不写账本；调用仍要用路径中的 Key。局域网监听器与非回环来源 403，只接受 GET，带 `Origin`、`Sec-Fetch-Site: cross-site` 或非回环 `Host` 时 403。

## 考虑过的替代方案

- **网关按 Agent 查找 Key、调用不要求出示**：任何本机进程都能不带凭据使用 provider 凭据，绕过 `/v1` 上要求的 Key（ADR 0030 已否决）。
- **Key 放在查询串里**：这些 Agent 把路径接在基址字符串后面，查询串会落在路径中间。
- **URL 中的用户信息（`http://<Key>@127.0.0.1/…`）**：多数 HTTP 客户端拒绝或剥掉带凭据的 URL，Muse 读列表时也只取主机。
- **Muse 不接线**：Magpie 明确定义了 `/muse-code/models`，Muse 不读这个列表就不工作；列表只暴露 Muse 自己的 Key 可用的模型名与元数据，不含凭据与价格。

## 后果

- Key 以明文出现在这些 Agent 的配置文件中的基址里（与其他 Agent 的配置文件中的 Key 一样，按 Agent 签发、可轮换、只能在回环上使用），也可能出现在它们自己的调试日志中。
- `/muse-code/models` 是网关唯一不要求凭据的读取：本机任何进程都能看到 Muse 的 Key 可用的模型 Ref 与元数据。
- 接线库增加 `commandcode`、`fx` 与 `muse` 三个 Adapter；漂移检测与 `wiredKeyText` 把基址中的 Key 当作 Key（换成另一把 Key 是漂移，读回的 Key 用于目录同步）。

## 验证

- 网关（合成密钥、回环假上游）：路径中的 agent Key 能调用与列出模型，上游、账本与日志都没有 Key 文本；错误的、格式不对的、`client:` Key 与路径和请求头不一致时 401，`/k/<Key>/backend-api/codex/…` 与 `/k/<Key>` 404，均不回显；局域网监听器与非回环来源 403；Muse 列表取最新的有效 Muse Key，未接线 404，POST、`Origin` 与非回环 `Host` 被拒绝。
- 正式守护进程入口：接线 Command Code、fx 与 Muse 后用文件中的基址调用 Chat Completions 与 Responses，读 Muse 列表；开启局域网共享后两种路径在局域网监听器上 404；取消接线后 Key 失效、Muse 列表 404；关闭后数据目录、配置目录、接线目录与 OTLP 导出中都没有 Key 文本。
- 未以真实的 Command Code、fx 与 Muse 验证它们会把路径原样保留、并在 `apiKey: false` 或 `auth: none` 时不发送别的凭据。

## 修订（2026-10-05，安全审查 B 组）

- Key 放在网关不读取它的位置（`/K/<Key>`、`/%6b/<Key>`、`/x/../k/<Key>`、`/k%2F<Key>`）时，请求绕过了分派，Key 进入访问日志与 Fastify 404 的回显。现在两个监听器在分派前以 400 拒绝不规范的路径（`//` 开头、点段、反斜杠、编码的点，以及 `/api/` 之外编码的斜杠与反斜杠）；其余的落点不回显路径，日志、问题详情与账本中的路径去掉 Key 文本。`/api/` 例外是因为 `GET /api/v1/models/{ref}` 等操作按约定把 Model Ref 的斜杠编码为 `%2F`，那些路径从不交给网关。
- Key 文本按比签发格式宽的规则识别（`hhk_` 不分大小写、下划线可编码、其后的 Key 字符），因为差一个字符的 Key 只剩 64 种可能。
- Codex 透传中 Key 之后只接受 Codex 调用的第一段（`responses`、`models`、`realtime`）；像 Key 却无效的段本地 401，其他段本地 404，都不转发给 ChatGPT。
