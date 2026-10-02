// SPDX-License-Identifier: MIT
/**
 * Child entry for the Linux process-table scan; see `proc-scan.ts`.
 *
 * Usage: `node proc-scan-main.js [--token=NAME=value]`. Prints one JSON object
 * `{ rows: [[pid, ppid, pgid, uid, ruid, zombie, started], ...], marked,
 * hidden }` and exits 0, or prints `{ failure: "<errno code>" }` and exits 2.
 * The parent owns the deadline and kills this process when it expires.
 */
import { readdirSync, readFileSync } from "node:fs";
import { scanFailureCode, scanProc } from "./proc-scan.js";

const tokenArgument = process.argv.find((argument) =>
  argument.startsWith("--token="),
);
try {
  const scan = scanProc(
    { list: () => readdirSync("/proc"), read: (path) => readFileSync(path) },
    tokenArgument?.slice("--token=".length),
  );
  process.stdout.write(
    JSON.stringify({
      rows: scan.rows.map((row) => [
        row.pid,
        row.ppid,
        row.pgid,
        row.uid,
        row.ruid,
        row.zombie ? 1 : 0,
        row.started,
      ]),
      marked: scan.marked,
      hidden: scan.hidden,
    }),
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ failure: scanFailureCode(error) }));
  process.exitCode = 2;
}
