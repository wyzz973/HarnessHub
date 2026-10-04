// SPDX-License-Identifier: MIT
/**
 * The daemon the benchmark measures, in a process of its own so that its CPU
 * time and memory are only the daemon's (bench.ts starts it).
 * Usage: node dist/tests/perf/hub.js <data directory> <gateway limits JSON>
 *
 * It prints `{"event":"ready","url"}` on stdout once listening, answers each
 * IPC message `"usage"` with `{cpu: process.cpuUsage(), rss, heap}`
 * (microseconds; resident memory and used V8 heap in bytes) and closes its
 * server on SIGTERM. The catalog never refreshes and
 * the agent wiring sees only the data directory as its home.
 */
import path from "node:path";
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
process.on("message", (message) => {
  if (message === "usage")
    process.send?.({
      cpu: process.cpuUsage(),
      rss: process.memoryUsage().rss,
      heap: process.memoryUsage().heapUsed,
    });
});
process.once("SIGTERM", () => {
  void hub.server.close().finally(() => process.exit(0));
});
console.log(JSON.stringify({ event: "ready", url: hub.url }));
