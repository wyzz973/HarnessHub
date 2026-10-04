# 性能基准

`pnpm bench`（[bench.ts](bench.ts)）在回环上用严格假上游测量网关，对照 [03 第 11 节](../../docs/proposals/oss/03-model-plane.md#11-验证要求)的目标写出 `dist/bench/bench.json` 与 `bench.md`，只报告，不设门槛。被测的守护进程在自己的进程中运行（[hub.ts](hub.ts)，带 `--expose-gc`），基准经 IPC 读取它的 CPU 时间与内存，并在完整垃圾回收之后记录启动时与延迟测量之后的内存。

## 守护进程的内存

2026-10-04 在 macOS arm64、Node 24.20.0 上，连续发出 6000 次延迟调用后常驻内存约 330 MB，而 V8 堆只有约 81 MB。按 2000 次一批的直通 Chat 调用逐批测量（`process.memoryUsage()`、`v8.getHeapSpaceStatistics()`、两份堆快照之差、`vmmap --summary`），结果是一处泄漏、两项有上限的增长，以及常驻内存本身的口径。

**泄漏（已修复）**：读取入站请求体时用 `AbortSignal.any([信号, AbortSignal.timeout(120 s)])` 设期限。Node 24.20 的 `AbortSignal.any` 把每个传入的超时信号放进内部的常驻集合，直到它触发才移除，因此每个请求在结束后仍保留约 0.7 KB（计时器、两个信号、WeakRef、WeakCell、Set 与闭包）整整 120 秒。两份快照之间的 12000 次调用恰好多出 12000 个 `Timeout`、`AbortSignal`、`WeakRef` 与 `Set`，合计约 8.6 MB；130 秒后全部消失。持续每秒 100 个请求时约占 9 MB，每秒 1000 个时约 90 MB。修复后改用由调用方清除的计时器（`deadline()`），回收后的堆在 16000 次调用中保持在 33–35 MB，快照之差中没有逐请求的对象；`count_tokens` 与搜索调用改用同一方式。[request-body.test.ts](../../packages/gateway/test/request-body.test.ts) 在修复前失败（2000 次读取后留下 2000 个信号）。

**有上限的增长与口径**：

| 来源 | 测量 | 说明 |
|---|---|---|
| V8 新生代 | 已提交的新生代从 64 MB 增到 128 MB | 持续分配时 V8 把半空间扩大到按堆上限决定的最大值（堆上限 4 GB 时每个半空间 64 MB），空闲回收后缩回（20 秒空闲后已提交堆从 169 MB 降到 43 MB）；以 `--max-semi-space-size=16` 运行时新生代保持 32 MB，2000 次调用后常驻内存为 231 MB 而不是 286 MB |
| 分配器页 | 默认 malloc 区常驻从 21 MB 增到 68 MB，其中在用的分配只从 8.6 MB 增到 12.4 MB（碎片 82%） | V8 优化编译热点代码时 malloc 的峰值约 47 MB，释放后页面留在分配器中；macOS 之后回收一部分（再 8000 次调用后脏页 34 MB） |
| 常驻内存的口径 | 常驻内存在 2000 次调用后约 285 MB，10000 次后 274 MB；物理占用（`vmmap`）从启动时的 150 MB 到 254 MB，之后回落到 209 MB | macOS 的常驻内存包含已释放而内核尚未收回的页，物理占用更接近实际占用 |

ArrayBuffer 与 external 内存始终只有 4–5 MB，因此不是 undici 的连接缓冲、fastify 的请求体或 zlib；malloc 区中在用的分配合计约 12 MB，SQLite 的页缓存不显著。常驻内存在首批调用后不再随调用次数增长。

基准的 `bench.md` 给出完整回收后的数值：启动时与 4400 次网关调用之后的常驻内存、在用堆与新生代。修复前同一基准中回收后的在用堆从 32 MB 增到 38 MB，修复后增到 35 MB（其余是编译代码与反馈数据，之后不再增长）。

未验证：Linux（glibc 的 malloc 归还页的方式不同）与 Windows；仍以 `AbortSignal.any` 搭配 `AbortSignal.timeout` 的低频调用（图像生成、provider 体检、目录刷新、OTLP 导出）每次调用会在各自的超时内保留同样的对象。
