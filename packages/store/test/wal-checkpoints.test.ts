// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import {
  WalCheckpoints,
  WORKER_FAILURES,
} from "../src/storage/wal-checkpoints.js";

void test("workers that cannot start are logged, retried, then given up for the writer's own checkpoints", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-checkpoints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records: { event: string; fields: LogFields }[] = [];
  const log: LogSink = {
    level: "info",
    info: (event, fields = {}) => void records.push({ event, fields }),
    debug: () => undefined,
  };
  let changes = 0;
  let fallbacks = 0;
  // No database can be opened there: every worker fails at once.
  const checkpoints = new WalCheckpoints(
    join(dir, "missing", "harnesshub.sqlite"),
    () => ++changes,
    () => fallbacks++,
    log,
    10,
  );
  const deadline = Date.now() + 10_000;
  while (fallbacks === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fallbacks, 1);
  assert.deepEqual(
    records.map((record) => record.event),
    [
      ...Array.from(
        { length: WORKER_FAILURES },
        () => "store.checkpoint_failed",
      ),
      "store.checkpoint_fallback",
    ],
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(records.length, WORKER_FAILURES + 1, "nothing tried after it");
  await checkpoints.close();
});
