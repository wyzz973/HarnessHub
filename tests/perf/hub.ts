// SPDX-License-Identifier: MIT
/**
 * The daemon the benchmark measures, in a process of its own so that its CPU
 * time and memory are only the daemon's (bench.ts starts it).
 * Usage: node dist/tests/perf/hub.js <data directory> <gateway limits JSON>
 *
 * It prints `{"event":"ready","url"}` on stdout once listening, answers each
 * IPC message `"usage"` with `{cpu: process.cpuUsage(), rss, heap,
 * heapTotal, newSpace}` (microseconds; resident memory, used and committed
 * V8 heap and the young generation's committed size in bytes), runs a full
 * garbage collection for `"gc"` when started with `--expose-gc` and answers
 * `{collected}`, and closes its server on SIGTERM. The catalog never
 * refreshes and the agent wiring sees only the data directory as its home.
 */
import path from "node:path";
import v8 from "node:v8";
import { startHub } from "@harnesshub/daemon/main";

const [dataDir, limits] = process.argv.slice(2);
if (!dataDir || !limits) {
  console.error("usage: hub.js <data directory> <gateway limits JSON>");
  process.exit(2);
}
const hub = await startHub({
  dataDir,
  configDir: path.join(dataDir, "config"),
  secretsBackend: "file",
  demo: false,
  cwd: dataDir,
  port: 0,
  host: "127.0.0.1",
  catalog: { autoRefresh: false },
  gatewayLimits: JSON.parse(limits) as unknown,
  wiringHome: { home: dataDir, env: { PATH: process.env.PATH } },
});
const gc = (globalThis as { gc?: () => void }).gc;
process.on("message", (message) => {
  if (message === "gc") {
    gc?.();
    gc?.();
    process.send?.({ collected: gc !== undefined });
  } else if (message === "usage") {
    const memory = process.memoryUsage();
    process.send?.({
      cpu: process.cpuUsage(),
      rss: memory.rss,
      heap: memory.heapUsed,
      heapTotal: memory.heapTotal,
      newSpace:
        v8
          .getHeapSpaceStatistics()
          .find((space) => space.space_name === "new_space")?.space_size ?? 0,
    });
  }
});
process.once("SIGTERM", () => {
  void hub.server.close().finally(() => process.exit(0));
});
console.log(JSON.stringify({ event: "ready", url: hub.url }));
