# 模型目录快照

`models-dev.json` 是 [models.dev](https://github.com/anomalyco/models.dev) 的 `https://models.dev/api.json` 的裁剪快照，HarnessHub 用它补齐模型的上下文窗口、最大输出、是否推理、输入模态、是否支持工具调用与价格（[03 第 7 节](../../../docs/proposals/oss/03-model-plane.md#7-模型目录与元数据)）。models.dev 以 MIT 许可发布，版权与许可文本随快照放在 [models-dev.LICENSE](models-dev.LICENSE)（Copyright (c) 2025 models.dev），并列入 [第三方声明](../../../THIRD_PARTY_NOTICES.md)。

当前快照：

| 项目 | 值 |
|---|---|
| 取得时间 | 2026-10-02T15:32:39.124Z |
| 上游提交 | `8039cd1a5967b857c1bb10c12a70c9097a440afe`（取得时 models.dev 仓库的 HEAD；API 由它部署，可能稍有滞后） |
| 上游文档 | 5,302,230 字节，SHA-256 `6a08e3521d95956f97ea0733b166d8a95f2088b939e3fe0a17958e80fe1f541b` |
| 快照 | 1,390,979 字节（SHA-256 `ef2a6ffd5cf416e4237affeac2a0f8a7a6bb44f00752a7b2de2f0950f266a017`）；226 个 provider、8,371 个模型 |

除快照自身的 SHA-256 外，这些值都记录在文件的 `meta` 中，`hh catalog status` 与 `GET /api/v1/catalog` 显示它们。

## 格式

```text
{"meta":{"schemaVersion":1,"source":"https://models.dev/api.json","repository":"…","license":"MIT (models.dev.LICENSE)","retrievedAt":"…","etag":"…","commit":"…","sha256":"…","bytes":5302230,"providers":226,"models":8371},
"providers":{
"deepseek":{"name":"DeepSeek","models":{
"deepseek-v4-flash":{"context":1000000,"output":393216,"reasoning":true,"input":["text","image"],"toolCall":true,"price":{"input":0.15,"output":0.6,"cacheRead":0.003}}
}}}}
```

- `sha256` 与 `bytes` 描述上游的完整文档，不是本文件；`commit` 为取得时上游仓库的提交。
- 每个模型只保留 `context`、`output`（`limit` 中的正整数）、`reasoning`、`input`（`modalities.input` 中的 text、image、pdf、audio、video）、`toolCall`（`tool_call`）与 `price`（`cost` 的 input、output、cache_read、cache_write，美元每百万 token）。上游没有或无效的值不写，不补 0。
- provider 与模型按 ID 排序，每个模型一行，更新时的差异按模型显示。

## 使用

[src/catalog.ts](../src/catalog.ts) 在守护进程启动时读取并校验本文件（`parseCatalog`：`meta` 完整、每个模型只有上述字段且取值有效、计数与 `meta` 一致），之后在进程内复用；文件缺失或无效是打包缺陷，读取失败。查找先按预设的 `catalog` id，再按 `author/model` 形式模型名中的作者；都没有时该模型的字段为未知，不按名称猜测。单可执行文件把本目录的 `models-dev.json` 与 `models-dev.LICENSE` 作为资源解出到同一相对路径（`tools/sea/build.mjs` 的 `catalogAssets`）。

## 运行时刷新

守护进程默认在后台刷新目录（03 第 7 节，所有者 2026-10-03 决定，与 Magpie 相同），由 [src/catalog-refresh.ts](../src/catalog-refresh.ts) 的 `CatalogRefresher` 执行，组合根拥有并在关闭时等待它：

- 启动后，若从未刷新或上次尝试已超过 24 小时，立即请求 `catalog.url`（默认 `https://models.dev/api.json`），之后每 24 小时一次；请求带 `If-None-Match`（使用中目录的 ETag），超时 10 秒，响应超过 64 MiB 视为失败。
- 某次服务成功、有用量但模型没有价格的调用（账本中 `cost` 为 null）会提前刷新，距上次尝试至少 6 小时。
- 刷新结果按上面的格式写入 `<dataDir>/catalog/models-dev.json`（`commit` 为 null，`source` 为实际地址），最近一次尝试写入 `<dataDir>/catalog/refresh.json`，都原子替换；本目录的快照不变。刷新副本比内置快照新时才使用，所以升级到带更新快照的版本后以内置快照为准。
- 内容有变化时，守护进程在 provider 写入队列中重新解析全部 provider 的模型元数据，网关随即使用新价格。失败（连接、超时、非 2xx、内容无效）保留正在使用的目录，错误只含主机、HTTP 状态或超时。
- `catalog.autoRefresh: false`（配置文件 `config.jsonc` 或 `startHub` 的 `catalog` 选项）或环境变量 `HH_OFFLINE=1` 关闭后台刷新；`HH_OFFLINE` 只接受 `1`、`0` 或空，其他值使启动失败。关闭后 `hh catalog refresh`（`POST /api/v1/catalog/refresh`）仍可手动刷新。`hh catalog status` 显示使用中的目录、来源地址、上次刷新与是否开启。
- 测试不联网：测试启动器为所有测试设置 `HH_OFFLINE=1`，需要刷新的测试把 `catalog.url` 指向本机回环的假服务；`pnpm docs:api` 生成文档时以 `autoRefresh: false` 启动守护进程，SEA 测量脚本同样设置 `HH_OFFLINE=1`。

## 更新快照

```sh
node tools/catalog-snapshot.mjs --commit "$(git ls-remote https://github.com/anomalyco/models.dev HEAD | cut -f1)"
```

先 `pnpm build`：脚本使用网关的 `snapshotText`，与运行时刷新写出相同的格式。脚本下载 `api.json`（60 秒超时）与上游 `LICENSE`，确认许可仍是 MIT 后写入本目录的两个文件；`--input <api.json>` 改为读取已保存的文档并保留现有 LICENSE。任何失败以 1 退出且不写文件。更新后同步上面的表格，并运行 `pnpm check`：[model-metadata.test.ts](../../../tests/unit/model-metadata.test.ts) 检查快照能加载、只含上述字段、带许可文本、每个预设的 `catalog` id 都在快照中，并离线检查裁剪与格式；[catalog-refresh.test.ts](../../../tests/unit/catalog-refresh.test.ts) 以注入的 fetch 与计时器检查刷新。测试不访问网络。
