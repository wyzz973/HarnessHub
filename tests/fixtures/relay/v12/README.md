# Session v12 迁移夹具（G066）

这里的 7 个 JSON 文件是冻结的 Session v12 业务库，供 G066 的迁移测试（`tests/integration/relay-store.test.ts` 的 G066-C01 等）重建成 v12 数据根，再用当前代码打开、升到 v13。每个文件对应一种绑定来源（[终稿第 14.4 节](../../../../docs/proposals/relay/relay-architecture.md#144-迁移与降级adr-049)）：

| 文件 | 来源 | 内容 |
|---|---|---|
| `d1.json` | D1 形态 | alpha 两轮，切到 bravo 两轮（第一轮带 alpha 的两轮），回到 alpha 的第一条输入是原生命令 `/compact` |
| `dispatch-failed.json` | 派发前失败 | 同上，回到 alpha 的第一条带 bravo 的两轮，但附件被拒，派发前失败 |
| `insert-rejected.json` | 插入前拒绝 | 同上，回到 alpha 的第一条带 bravo 的两轮，alpha 在插入前拒绝（`request_rejected`，`input: not_recorded`） |
| `import.json` | 导入 | 接续 alpha 的一个本机会话（ADR-029），之后两轮 |
| `branch.json` | 分支 | alpha 两轮，在第二轮之后原生分支（ADR-025），分支上一轮；库里有来源与分支两个会话 |
| `clear.json` | 清空 | 只有 alpha：两轮，执行了 `/clear`，再一轮 |
| `reset-d1.json` | reset + D1 | 只有 alpha：三轮，native-reset 换新原生会话，新会话的第一条是 `/compact` |

## 生成方法

由同目录的 `generate.mjs` 生成：它用给定构建的真实 Session v12 运行时与 SQLite 存储，配进程内的假 Harness（alpha、bravo；每个原生会话有自己的身份，`/compact`、`/clear` 是目录里的命令；命令的回复不报告输入证据），在 `os.tmpdir()` 下的临时数据根里跑完上表的场景，把业务库的 `user_version`、owner 代次、`sessions`（快照原样）、`events`（按 seq）与 `create_keys` 写成 JSON，然后删掉临时目录。身份是固定计数，时钟从 2026-11-09T00:00:00Z 起每次加 1 秒，所以同一构建重跑得到同样的文件。

本目录的文件用 `5c5f12f`（v12 的最后一个提交）的构建生成，命令为：

```sh
pnpm build                                   # 在 5c5f12f 上
node tests/fixtures/relay/v12/generate.mjs dist tests/fixtures/relay/v12
```

v13 及之后的构建写出的是 v13 库，生成器会因 `user_version` 不是 12 而失败；要重新生成，必须先检出 `5c5f12f` 并构建，再把 `dist` 目录传给它。测试只读这些 JSON，从不运行生成器。

## 数据

全部合成：没有真实对话、轨迹、凭据或运行数据，没有运行任何 Harness 或模型，也没有读取任何 `data/` 目录。
