import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";

void test(
  "a workflow persistence failure still releases Runtime sessions and the Gateway database owner",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hub-console-close-"),
    );
    const configFile = path.join(directory, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        engines: [
          {
            id: "planner",
            driver: "cli",
            command: [process.execPath, "-e", "process.stdin.resume()"],
          },
        ],
      }),
    );
    const hub = await startHub({
      dataDir: directory,
      cwd: directory,
      configFile,
      demo: false,
      port: 0,
    });
    const fault = new DatabaseSync(path.join(directory, "harnesshub.sqlite"));
    t.after(async () => {
      await hub.server.close().catch(() => undefined);
      fault.close();
      await rm(directory, { recursive: true, force: true });
    });
    fault.exec(
      "CREATE TRIGGER reject_workflow_update BEFORE UPDATE ON workflows BEGIN SELECT RAISE(FAIL, 'fixture workflow storage error'); END",
    );
    const response = await hub.server.inject({
      method: "POST",
      url: "/v1/workflows",
      payload: {
        goal: "Fixture shutdown",
        engineId: "planner",
        plannerEngineId: "planner",
      },
    });
    assert.equal(response.statusCode, 202);
    const until = Date.now() + 3000;
    while (
      (await hub.server.inject({ url: "/health/ready" })).statusCode !== 503
    ) {
      assert.ok(Date.now() < until);
      await delay(10);
    }
    await hub.server.close().catch(() => undefined);
    assert.equal(
      fault
        .prepare("SELECT value FROM runtime_metadata WHERE key='owner'")
        .get(),
      undefined,
    );
    assert.equal(
      fault
        .prepare(
          "SELECT COUNT(*) AS n FROM sessions WHERE json_extract(record,'$.status')!='closed'",
        )
        .get()?.n,
      0,
    );
  },
);
