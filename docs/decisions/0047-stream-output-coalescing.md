# ADR-047：流式输出按窗口合并提交

状态：accepted，2026-10-21。裁决人：总指挥兼审批代理（2026-10-21），裁决条件见文末，与正文冲突时以裁决为准。部分取代 [ADR-013](0013-live-chat-experience.md) 中“Runtime 每块已先提交再发布”的做法；INV-06（先提交再发布）、首块即时可见与 SSE 帧语义不变。

## 背景

- 性能镜头的合成测量（2026-10-21，基线 440ba52）：Runtime 收到原生程序的每一个文本块都做一次整份快照事务并写入一条 `run.output` 事件，每块成本随会话大小增长：0.31 ms@1.3 KB、7.8 ms@1 MB、44.8 ms@4.2 MB。每块一条事件叠加每会话 16,384 条事件的硬上限（`MAX_SESSION_EVENTS`），长回复十几轮即可逼近上限，触顶后终态与关闭事件写不进。
- ADR-013 用“每块先提交再发布”保证首块在后端结束前可见，且 SSE 只发布已提交事实。本决定保留这两点，只改变提交的粒度。
- [存储契约](../contracts/storage-events.md) 已允许“规范化公开消息分块有界保存；临时流块若不持久，必须显式标记且不推进持久游标”。

## 决定

1. **窗口**：回复文本（`text`）与思考（`thinking`）块不再逐块提交。同一种类的连续块在 Runtime 内存（`ActiveExecution.stream`）中合并为一个窗口；窗口在 **≤100 ms**（`STREAM_WINDOW_MS`）到期、累计 **≥16 KiB**（`STREAM_WINDOW_BYTES`，按 `utf8Bytes` 计）时提交，并在本回合提交任何其他事实之前先提交。两个常量定义在 `src/contracts/session.ts`。
2. **一个窗口一条事件**：窗口提交是一次事务、一条 `run.output` 事件，`event` 字段为 `{ type: "text" | "thinking", text: 合并后的文本 }`。公开消息与 `run.thinking` 的最终文本与块串接逐字一致；`logged()`、SSE 帧（message 帧仍取快照里的整条消息）与 CLI 输出语义不变。
3. **顺序不变**：任一非文本事件（tool、plan、usage、notice、activity、output、permission_requested、permission）到达时，先提交已合并的窗口再处理它；文本与思考种类切换时同样先提交前一种类，因此思考与文本从不共用窗口。事件日志保持程序发送的先后顺序，只是同类文本块合并了。
4. **先冲刷再结算/停止**：回合结算（`run.backend_settled` 之前）、取消（`run.cancel_requested` 之前）、停止链（`run.stop_requested` 之前）、期限到期（`run.budget_expired` 之前）、关闭对话（`session.close_requested` 之前）、Runtime 关闭（`runtime.stopping` 之前）、`fail` 路径（经停止链）都先提交窗口；回合结束（finally）再提交一次剩余窗口。程序已被提前结束（stop grace 到期、停止请求失败）的回合，其租约已释放，剩余窗口随回合（状态 unknown）一起丢弃，不另造事实。
5. **首个可见块仍即时记录**：`run.first_output` 与 `firstOutputAt` 在第一个可见块到达时以独立事务立即提交，不并入窗口，`firstOutputAt` 取块到达时刻。
6. **输出上限精确**：逐块计数，窗口字节用现有 `utf8Bytes` 计算，跨块拆开的 UTF-16 代理对只算一次（`joinedBytes`：只重编码前一段的最后一个码元）。会超出 `MAX_OUTPUT_BYTES` 的那个块到达时，先提交它之前已合并的窗口，再抛出 `OUTPUT_LIMIT`；被拒绝的块不打开窗口，不提交空事实。二选一中选择“先提交已合并部分再抛出”：与逐块提交时被拒绝的是同一个块、已提交的字节相同。驱动回调内抛出的 `OUTPUT_LIMIT` 仍由驱动按原语义处理（中止连接，回合 unknown）。
7. **调度器可注入**：`SessionRuntimeOptions.schedule?: (fn, ms) => () => void`，默认 `setTimeout` + `unref`。窗口定时器归属本回合的 `ActiveExecution`，冲刷与回合结束时清除；Runtime `close()` 等待所有回合结束，因此不留下定时器。
8. **所有权**：`owned()`（Store owner、租约、active Run、epoch/selection）在窗口打开与提交时核对，因此至少每个窗口一次；OWNER_LOST 之后提交被拒绝，不再有任何提交。定时器、停止链、关闭等驱动回调之外的冲刷失败记为该回合的失败（`streamFailure`）并停止回合；驱动回调内的冲刷失败仍抛给驱动。
9. **崩溃**：进程崩溃最多丢失一个未提交窗口（≤100 ms 或 ≤16 KiB）；该窗口从未发布（SSE 只发布已提交事实，INV-06 不变），也不推进持久游标。

## 不变与不做

- 非文本事件仍逐条提交；16,384 条事件与 32 MiB 日志等上限不变，本决定只把文本事件数与事务数降一个量级。
- 每次窗口提交仍是一次整份快照事务（O(会话大小)）；快照缓存与列表摘要属 M2。
- 不改 `src/web`、前端与协议驱动；浏览器端仍按刷新周期合并显示。

## 裁决（总指挥兼审批代理，2026-10-21）

允许把 ADR-013 的“每块先提交再发布”改为“文本与思考块按 ≤100 ms 或 ≤16 KiB 窗口合并后先提交再发布”，条件：

1. 最终文本逐字一致；
2. 非文本事件、结算、取消、停止、期限到期、OUTPUT_LIMIT、关闭前都先冲刷，事件顺序不变；
3. 第一个可见块仍立即产生 `run.first_output`（可与第一次冲刷合并为同一事务，但 `firstOutputAt` 取块到达时刻）——实现选择独立事务；
4. 崩溃时最多丢失一个未提交窗口，且该窗口从未发布（SSE 只发布已提交事实，INV-06 不变）；
5. 调度器可注入（`schedule`，默认 setTimeout+unref），测试不用真实睡眠猜时序；
6. 合并窗口的字节上限用现有 `utf8Bytes` 计算，OUTPUT_LIMIT 判定在合并后仍精确——实现选择“超限时先提交已合并部分再抛出”。

## 验证（合成，2026-10-21）

- `tests/integration/session-runtime.test.ts`（标题含 ADR-047）：200 个块、1 ms 间隔 → 2 条 `run.output`（之前 200 条），text 与 thinking 逐字一致，首块即时记录；非文本事件前冲刷与到达顺序、种类切换；结算、取消与停止请求前冲刷；期限到期前冲刷；OUTPUT_LIMIT 逐块精确（含跨块代理对、恰好到上限、被拒绝块不提交空窗口）；定时器提交后才发布、OWNER_LOST 后不再提交也不发布。
- `tests/integration/parallel-work.test.ts`：4 路并行各自独立窗口，各只提交自己的文本。
- 定向变异（人工执行）：去掉 `output()` 中非文本事件前的冲刷，顺序用例失败。
- 现有 `web-session-stream`、`session-cli` 用例在新粒度下通过，message 帧仍在每次提交后携带整条消息。
- 真实引擎上的逐字一致与浏览器观感由主代理在 M3 真实验收覆盖；本 ADR 的证据只是合成测试。
