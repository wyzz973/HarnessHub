import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import type {
  RunRecord,
  PermissionRecord,
  SessionRecord,
} from "../../src/domain/types.js";

void test(
  "paused SSE does not stop execution; an expired permission cannot be approved",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-pressure-"),
    );
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    const request = async <T>(route: string, body?: unknown): Promise<T> =>
      (await (
        await fetch(hub.url + route, {
          ...(body !== undefined
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        })
      ).json()) as T;
    const first = await request<SessionRecord>("/v1/sessions", {});
    const second = await request<SessionRecord>("/v1/sessions", {});
    const run = await request<RunRecord>(`/v1/sessions/${first.id}/runs`, {
      text: "x".repeat(100_000),
      timeoutMs: 8000,
      fixture: { scenario: "echo", chunks: 128 },
    });
    const paused = get(`${hub.url}/v1/runs/${run.id}/events`, (response) =>
      response.pause(),
    );
    paused.on("error", () => {
      /* Test teardown deliberately closes the paused subscriber. */
    });
    t.after(async () => {
      paused.destroy();
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const permissionRun = await request<RunRecord>(
      `/v1/sessions/${second.id}/runs`,
      {
        text: "approval timeout",
        timeoutMs: 1000,
        fixture: { scenario: "permission" },
      },
    );
    const deadline = Date.now() + 10_000;
    let completed: RunRecord;
    let expired: RunRecord & { permissions: PermissionRecord[] };
    for (;;) {
      completed = await request<RunRecord>(`/v1/runs/${run.id}`);
      expired = await request<RunRecord & { permissions: PermissionRecord[] }>(
        `/v1/runs/${permissionRun.id}`,
      );
      if (completed.finishedAt && expired.finishedAt) break;
      assert.ok(
        Date.now() < deadline,
        "paused subscriber must not block either run",
      );
      await delay(10);
    }
    assert.equal(completed.status, "completed");
    assert.equal(completed.output?.length, 100_000);
    assert.equal(expired.status, "timed_out");
    const permission = expired.permissions[0];
    assert.ok(
      permission,
      "the permission fixture must reach the protocol before deadline",
    );
    assert.equal(permission.status, "expired");
    const response = await fetch(
      `${hub.url}/v1/permissions/${permission.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId: permission.options[0]?.id }),
      },
    );
    assert.equal(response.status, 409);
  },
);
