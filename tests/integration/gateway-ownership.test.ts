// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startHub } from "../../src/main.js";
import { temporaryDirectory } from "../support/temporary.js";

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, file);
    // SQLite's own files change with the running Gateway's work, not the second start.
    if (/harnesshub\.sqlite(-wal|-shm)?$/.test(relative)) continue;
    const info = await stat(file);
    entries[relative] = `${info.size}:${info.mtimeMs}`;
  }
  return entries;
}

void test(
  "a second Gateway on the same data directory fails before writing to it",
  { timeout: 30_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(t, "hh-ownership-");
    const dataDir = path.join(directory, "data");
    const first = await startHub({
      dataDir,
      demo: true,
      cwd: directory,
      port: 0,
    });
    defer(() => first.server.close());
    const before = await snapshot(dataDir);
    const log = await readFile(first.logFile, "utf8");

    await assert.rejects(
      startHub({ dataDir, demo: true, cwd: directory, port: 0 }),
      { code: "RUNTIME_ALREADY_RUNNING" },
    );
    assert.equal(await readFile(first.logFile, "utf8"), log);
    assert.deepEqual(await snapshot(dataDir), before);

    // The running Gateway is unaffected, and its directory is reusable once it stops.
    const health = await fetch(`${first.url}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(health.status, 201);
    await first.server.close();
    const second = await startHub({
      dataDir,
      demo: true,
      cwd: directory,
      port: 0,
    });
    defer(() => second.server.close());
  },
);
