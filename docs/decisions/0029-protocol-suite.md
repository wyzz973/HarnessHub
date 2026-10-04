# ADR 0029：以官方 SDK 为客户端的协议一致性套件

Status: proposed

日期：2026-10-04
关联：[03 第 6、11 节](../proposals/oss/03-model-plane.md#11-验证要求)、[10 第 1、3.3 节](../proposals/oss/10-engineering.md#33-三类一致性套件)、[一致性套件](../../conformance/README.md)、[模型网关](../model-gateway.md)

## 问题

M1 的验收要求协议套件用固定版本的官方 SDK 作为客户端，经网关访问严格模拟上游，覆盖 4 种入站 × 4 种上游的 16 个方向。`conformance/` 是黑盒，边界检查原本只允许它导入 `core`、`sdk`、HTTP 与 `hh` 命令，不能导入第三方 SDK。套件首次运行还暴露了几处网关与设计不一致的地方，其中保活与直通的关系需要取舍。

## 决定

- **黑盒例外只给协议客户端**：`conformance/` 可以导入 `openai`、`@anthropic-ai/sdk` 与 `@google/genai`（`PROTOCOL_CLIENTS`），且只能是根 `package.json` 中按精确版本固定的开发依赖；其他第三方导入、其他黑盒目录中的这些导入、范围版本均被 `tools/check-boundaries.mjs` 拒绝。套件仍只经 `hh serve` 与 `@harnesshub/sdk` 操作 HarnessHub。
- **套件属于 `pnpm test`**：`pnpm test:protocol` 运行 `conformance/protocols/`，本机约 30 秒（保活用例需要等待超过 10 秒的保活间隔），因此随 `pnpm check` 在每个 PR 运行，与 10 第 3.1 节的离线一致性层一致。
- **上游代表厂商官方 API**：假上游以白名单模式运行，另声明 Chat 的 `stream_options` 与 `reasoning_effort`；这两个是 OpenAI 官方字段，网关与 Chat 客户端会发送，拒绝它们的上游由 provider 的 `drop-fields` 补丁处理。
- **保活可以提交尚未开始的流**：上游已回 2xx、但只发注释时，到期的保活在没有扣留输出（无替代路径）时先提交响应（翻译路径启动 sink，直通路径提交响应头），再写协议自己的保活。直通流也写网关合成的保活（Chat 空 delta、Responses `response.in_progress`、Anthropic `ping`、Gemini 空 candidate），Responses 在上游与之前的保活都未发 `response.created` 时先补一个；Gemini 客户端收不到 SSE 注释。
- **Gemini 的流内错误是裸 JSON 对象**：网关写给 Gemini 客户端的流内失败、以及从 Gemini 上游读取的流内失败，都是事件之间的 `{"error":…}` 对象，而不是 `data:` 事件；这是 `@google/genai` 唯一识别为 `ApiError` 的形式（F10）。

## 考虑过的替代方案

- **协议套件只用 HTTP 与自写解析器**：无法证明官方 SDK 能解析，也测不到 SDK 的错误类型与 `Retry-After` 处理。
- **套件放在 `tests/` 而不是 `conformance/`**：`tests/` 可以导入守护进程内部，失去“只经公开接口、可对其他网关运行”的性质（10 第 3.3 节）。
- **直通只转发上游原样的注释**：Codex 只按事件计空闲，openai-node 丢弃注释，没有替代路径时注释还被缓冲到首个数据事件；直通流因此改写入合成的保活，代价是直通不再逐字节，且 Responses 的 `sequence_number` 可能与上游的重复（Codex 与 openai-node 不校验它）。
- **只有替代路径耗尽后才允许保活提交响应**：与 03 第 6 节“上游只发注释时也可以触发保活”冲突。有替代路径时仍按设计在扣留窗口内不发保活。

## 后果

- 根 `package.json` 新增三个只供套件使用的开发依赖及其传递依赖（许可证为 MIT、Apache-2.0、BSD-3-Clause；`fast-sha256` 为 Unlicense，属于需审阅的许可证，经 `@anthropic-ai/sdk` → `standardwebhooks` 引入，只在开发中使用）。
- 许可证审查（维护者，2026-10-04）：按 [07 第 9 节](../proposals/oss/07-data-security.md#9-许可证合规与第三方声明)，Unlicense 需审查后登记。`fast-sha256` 1.3.0 接受：Unlicense 是 OSI 批准的公有领域贡献声明，没有署名或回馈义务；它只是开发依赖，不进入构建产物与单可执行文件。07 所说的许可证扫描与例外清单尚未实现，在它们落地前，这条记录就是登记；扫描落地时把它迁入例外清单。
- 直通流在上游只发注释时可能先收到网关合成的事件；有替代路径时扣留窗口（默认 15 秒）内仍收不到任何字节。
- Anthropic 客户端收到并行工具调用时，第二个及之后的调用在其参数可能与前一个交错时整块发送，不再逐片流式。
- Gemini 客户端的流内错误只有作为单独的网络块到达时才被 `@google/genai` 识别为 `ApiError`；与前一个事件合并读取时 SDK 报“Incomplete JSON segment at the end”，仍是失败而不是成功。

## 验证要求

- `tools/check-boundaries.test.mjs`：协议客户端在 `conformance/` 中按精确版本可用；范围版本、未声明、其他黑盒目录与其他第三方包被拒绝。
- `pnpm test:protocol`：16 个方向的文本、多轮、推理、图片、带缓存的 usage、各停止原因、单个与并行（含交错）工具调用、签名回传、custom 工具、上游 400/401/429（带与不带 `Retry-After`）/500/上下文超长、流中断开与流内错误、保活；严格上游零违规。
- 网关单元测试分别证明：Anthropic 汇集交错的并行参数、上下文超长数字的读取、Gemini 裸 JSON 错误的写出与读取、只发注释的上游在翻译与直通中都得到保活；每条在修复前失败。
- 未验证：Windows 上的套件运行；Vercel AI SDK、openai-python 与 Anthropic Python SDK；真实 provider 上的在线抽样；直通用例的逐字节黄金语料比较（语料尚未建立）。
