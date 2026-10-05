// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import { WalCheckpoints } from "../src/storage/wal-checkpoints.js";

void test("a checkpoint that fails is logged and asked for again, and close waits for the worker", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-checkpoints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records: { event: string; fields: LogFields }[] = [];
  const log: LogSink = {
    level: "info",
    info: (event, fields = {}) => void records.push({ event, fields }),
    debug: () => undefined,
  };
  let changes = 0;
  // No database can be opened there: every worker fails at once.
  const checkpoints = new WalCheckpoints(
    join(dir, "missing", "harnesshub.sqlite"),
    () => ++changes,
    log,
    10,
  );
  const deadline = Date.now() + 10_000;
  while (records.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(records.length >= 2, "failed, then failed again when retried");
  assert.ok(
    records.every((record) => record.event === "store.checkpoint_failed"),
  );
  await checkpoints.close();
  const after = records.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(records.length, after, "nothing is asked for after close");
});
