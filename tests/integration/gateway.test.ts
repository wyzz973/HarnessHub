import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startHub } from "../../src/main.js";
import type {
  AgentEvent,
  ArtifactRecord,
  PermissionRecord,
  RunRecord,
  SessionRecord,
} from "../../src/domain/types.js";

type View = RunRecord & {
  permissions: PermissionRecord[];
  artifacts: ArtifactRecord[];
};
async function json<T>(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<{ status: number; value: T }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, value: (await response.json()) as T };
}
async function waitRun(
  base: string,
  id: string,
  predicate: (run: View) => boolean,
): Promise<View> {
  const until = Date.now() + 8000;
  for (;;) {
    const { value } = await json<View>(base, `/v1/runs/${id}`);
    if (predicate(value)) return value;
    if (Date.now() > until)
      throw new Error(`Run wait expired: ${JSON.stringify(value)}`);
    await delay(10);
  }
}

void test(
  "real Gateway/SQLite/Worker: execution, idempotency, events, artifact and restart",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harnesshub-http-"));
    let hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const { value: session } = await json<SessionRecord>(
      hub.url,
      "/v1/sessions",
      "POST",
      {},
    );
    assert.equal(
      (await json<SessionRecord>(hub.url, `/v1/sessions/${session.id}`)).value
        .id,
      session.id,
    );
    assert.equal(
      (await json<{ engines: { id: string }[] }>(hub.url, "/v1/engines")).value
        .engines[0]?.id,
      "fake",
    );
    const input = {
      text: "artifact body 中文",
      fixture: { scenario: "artifact" },
      timeoutMs: 5000,
    };
    const submitted = await json<RunRecord>(
      hub.url,
      `/v1/sessions/${session.id}/runs`,
      "POST",
      input,
      "same",
    );
    assert.equal(submitted.status, 202);
    const id = submitted.value.id;
    const run = await waitRun(hub.url, id, (r) => r.status === "completed");
    assert.equal(
      (
        await json<RunRecord>(
          hub.url,
          `/v1/sessions/${session.id}/runs`,
          "POST",
          input,
          "same",
        )
      ).value.id,
      id,
    );
    assert.equal(
      (
        await json(
          hub.url,
          `/v1/sessions/${session.id}/runs`,
          "POST",
          { text: "different" },
          "same",
        )
      ).status,
      409,
    );
    const sse = await (await fetch(`${hub.url}/v1/runs/${id}/events`)).text();
    const events = sse
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as AgentEvent);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, i) => i + 1),
    );
    assert.equal(
      events.filter((event) => event.type === "RUN_COMPLETED").length,
      1,
    );
    assert.equal(events.at(-1)?.seq, run.lastSeq);
    const resumed = await (
      await fetch(`${hub.url}/v1/runs/${id}/events`, {
        headers: { "last-event-id": String(events.length - 1) },
      })
    ).text();
    assert.equal(
      resumed.split("\n").filter((line) => line.startsWith("data: ")).length,
      1,
    );
    assert.equal(
      (await fetch(`${hub.url}/v1/runs/${id}/events?afterSeq=999999`)).status,
      400,
    );
    const rollout = await (
      await fetch(`${hub.url}/v1/runs/${id}/rollout`)
    ).text();
    assert.deepEqual(
      rollout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as AgentEvent),
      events,
    );
    assert.equal(run.artifacts.length, 1);
    const artifact = await fetch(
      `${hub.url}/v1/artifacts/${run.artifacts[0]?.id}`,
    );
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), input.text);
    const openapi = await json<{ paths: Record<string, unknown> }>(
      hub.url,
      "/openapi.json",
    );
    assert.ok(openapi.value.paths["/v1/runs/{id}/cancel"]);
    await hub.server.close();
    hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    assert.equal(
      (await json<View>(hub.url, `/v1/runs/${id}`)).value.status,
      "completed",
    );
    assert.equal(
      await (await fetch(`${hub.url}/v1/runs/${id}/rollout`)).text(),
      rollout,
    );
  },
);

void test(
  "serial queue, queued timeout, exact cancellation and permission round trip",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-controls-"),
    );
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const { value: session } = await json<SessionRecord>(
      hub.url,
      "/v1/sessions",
      "POST",
      {},
    );
    const route = `/v1/sessions/${session.id}/runs`;
    const first = (
      await json<RunRecord>(hub.url, route, "POST", {
        text: "hold",
        fixture: { scenario: "wait" },
        timeoutMs: 8000,
      })
    ).value;
    await waitRun(hub.url, first.id, (r) => r.status === "running");
    const disconnect = new AbortController();
    const stream = await fetch(`${hub.url}/v1/runs/${first.id}/events`, {
      signal: disconnect.signal,
    });
    await stream.body?.getReader().read();
    disconnect.abort();
    assert.equal(
      (await json<View>(hub.url, `/v1/runs/${first.id}`)).value.status,
      "running",
    );
    const queued = (
      await json<RunRecord>(hub.url, route, "POST", {
        text: "must not start",
        timeoutMs: 50,
      })
    ).value;
    const expired = await waitRun(
      hub.url,
      queued.id,
      (r) => r.status === "timed_out",
    );
    assert.equal(expired.startedAt, undefined);
    await json(hub.url, `/v1/runs/${first.id}/cancel`, "POST");
    const cancelled = await waitRun(
      hub.url,
      first.id,
      (r) => r.status === "cancelled",
    );
    assert.equal(cancelled.cleanupStatus, "confirmed");
    await json(hub.url, `/v1/runs/${first.id}/cancel`, "POST");
    const permissionRun = (
      await json<RunRecord>(hub.url, route, "POST", {
        text: "approved task",
        fixture: { scenario: "permission" },
        timeoutMs: 5000,
      })
    ).value;
    const pending = await waitRun(
      hub.url,
      permissionRun.id,
      (r) => r.status === "waiting_permission",
    );
    const permission = pending.permissions[0];
    assert.ok(permission);
    const option = permission.options.find((o) => o.kind === "allow_once");
    assert.ok(option);
    assert.equal(
      (
        await json(
          hub.url,
          `/v1/permissions/${permission.id}/decision`,
          "POST",
          { optionId: "invented" },
        )
      ).status,
      400,
    );
    await json(hub.url, `/v1/permissions/${permission.id}/decision`, "POST", {
      optionId: option.id,
    });
    const completed = await waitRun(
      hub.url,
      permissionRun.id,
      (r) => r.status === "completed",
    );
    assert.equal(completed.permissions[0]?.status, "applied");
    assert.equal(
      (
        await json(
          hub.url,
          `/v1/permissions/${permission.id}/decision`,
          "POST",
          { optionId: option.id },
        )
      ).status,
      200,
    );
    const activeDeadline = (
      await json<RunRecord>(hub.url, route, "POST", {
        text: "deadline",
        fixture: { scenario: "wait" },
        timeoutMs: 150,
      })
    ).value;
    const timedOut = await waitRun(
      hub.url,
      activeDeadline.id,
      (r) => r.status === "timed_out",
    );
    assert.ok(timedOut.startedAt);
    assert.equal(timedOut.cleanupStatus, "confirmed");
  },
);

void test(
  "a full queue still accepts an idempotent retry without scheduling twice",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-queue-"),
    );
    const config = path.join(directory, "config.json");
    await writeFile(config, JSON.stringify({ maxQueuedRuns: 1 }));
    const hub = await startHub({
      dataDir: path.join(directory, "data"),
      configFile: config,
      demo: true,
      cwd: directory,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const { value: session } = await json<SessionRecord>(
      hub.url,
      "/v1/sessions",
      "POST",
      {},
    );
    const route = `/v1/sessions/${session.id}/runs`;
    const first = (
      await json<RunRecord>(hub.url, route, "POST", {
        text: "hold",
        fixture: { scenario: "wait" },
        timeoutMs: 8000,
      })
    ).value;
    await waitRun(hub.url, first.id, (r) => r.status === "running");
    const input = { text: "queued", timeoutMs: 8000 };
    const queued = await json<RunRecord>(
      hub.url,
      route,
      "POST",
      input,
      "queue-key",
    );
    const replay = await json<RunRecord>(
      hub.url,
      route,
      "POST",
      input,
      "queue-key",
    );
    assert.equal(replay.status, 202);
    assert.equal(replay.value.id, queued.value.id);
    assert.equal(
      (await json(hub.url, route, "POST", { text: "too many" })).status,
      429,
    );
  },
);

void test(
  "closing one session does not wait for another session active run",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-close-"),
    );
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const sessions = await Promise.all(
      [1, 2].map(
        async () =>
          (await json<SessionRecord>(hub.url, "/v1/sessions", "POST", {}))
            .value,
      ),
    );
    const runs = await Promise.all(
      sessions.map(
        async (s) =>
          (
            await json<RunRecord>(
              hub.url,
              `/v1/sessions/${s.id}/runs`,
              "POST",
              { text: "hold", fixture: { scenario: "wait" }, timeoutMs: 8000 },
            )
          ).value,
      ),
    );
    await Promise.all(
      runs.map(async (r) =>
        waitRun(hub.url, r.id, (v) => v.status === "running"),
      ),
    );
    const closed = await json<SessionRecord>(
      hub.url,
      `/v1/sessions/${sessions[0]?.id}/close`,
      "POST",
    );
    assert.equal(closed.value.status, "closed");
    assert.equal(
      (await json<View>(hub.url, `/v1/runs/${runs[1]?.id}`)).value.status,
      "running",
    );
  },
);

void test(
  "event persistence failure closes execution and makes readiness unavailable",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-db-fault-"),
    );
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    const fault = new DatabaseSync(path.join(directory, "harnesshub.sqlite"));
    t.after(async () => {
      fault.close();
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    fault.exec(
      "CREATE TRIGGER reject_delta BEFORE INSERT ON events WHEN NEW.type = 'message.delta' BEGIN SELECT RAISE(FAIL, 'injected write failure'); END",
    );
    const { value: session } = await json<SessionRecord>(
      hub.url,
      "/v1/sessions",
      "POST",
      {},
    );
    const run = (
      await json<RunRecord>(
        hub.url,
        `/v1/sessions/${session.id}/runs`,
        "POST",
        { text: "must not disappear", timeoutMs: 5000 },
      )
    ).value;
    await waitRun(hub.url, run.id, (r) => r.status === "failed");
    assert.equal((await fetch(`${hub.url}/health/ready`)).status, 503);
    assert.equal((await json(hub.url, "/v1/sessions", "POST", {})).status, 503);
  },
);

void test(
  "resident Worker capacity is bounded and a closed session releases the slot",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-workers-"),
    );
    const config = path.join(directory, "config.json");
    await writeFile(config, JSON.stringify({ maxWorkers: 1 }));
    const hub = await startHub({
      dataDir: path.join(directory, "data"),
      configFile: config,
      demo: true,
      cwd: directory,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const first = (
      await json<SessionRecord>(hub.url, "/v1/sessions", "POST", {})
    ).value;
    const second = (
      await json<SessionRecord>(hub.url, "/v1/sessions", "POST", {})
    ).value;
    const submit = async (id: string) =>
      (
        await json<RunRecord>(hub.url, `/v1/sessions/${id}/runs`, "POST", {
          text: "capacity test",
          timeoutMs: 4000,
        })
      ).value;
    await waitRun(
      hub.url,
      (await submit(first.id)).id,
      (r) => r.status === "completed",
    );
    const blocked = await waitRun(
      hub.url,
      (await submit(second.id)).id,
      (r) => r.status === "failed",
    );
    assert.equal(blocked.error?.code, "WORKER_CAPACITY");
    await json(hub.url, `/v1/sessions/${first.id}/close`, "POST");
    await waitRun(
      hub.url,
      (await submit(second.id)).id,
      (r) => r.status === "completed",
    );
  },
);
