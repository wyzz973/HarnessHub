import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import {
  isTerminal,
  type EngineProfile,
  type RunRecord,
  type SessionRecord,
} from "../../src/domain/types.js";

async function json<T>(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, value: (await response.json()) as T };
}
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const end = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end)
      throw new Error(`Wait expired: ${JSON.stringify(value)}`);
    await delay(20);
  }
}
const registration = (version: string) => ({
  id: "custom",
  driver: "cli",
  command: [
    process.execPath,
    "-e",
    `setTimeout(() => process.stdout.write(${JSON.stringify(version)} + process.argv[1]), 150)`,
    "{prompt}",
  ],
  cli: { inputMode: "argv" },
});

void test(
  "live registration pins active/queued/old sessions and survives update, disable, removal and restart",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hh-engines-"));
    const options = {
      dataDir: directory,
      cwd: directory,
      demo: false,
      port: 0,
    };
    let hub = await startHub(options);
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    assert.equal((await json(hub.url, "/v1/sessions", "POST", {})).status, 404);
    const one = await json<EngineProfile>(
      hub.url,
      "/v1/engines",
      "POST",
      registration("v1:"),
    );
    assert.equal(one.status, 201);
    const session = (
      await json<SessionRecord>(hub.url, "/v1/sessions", "POST", {})
    ).value;
    const submit = async (id = session.id) => {
      const result = await json<RunRecord>(
        hub.url,
        `/v1/sessions/${id}/runs`,
        "POST",
        { text: "中文", timeoutMs: 5000 },
      );
      assert.equal(result.status, 202);
      return result.value;
    };
    const wait = async (run: RunRecord) =>
      until(
        async () =>
          (await json<RunRecord>(hub.url, `/v1/runs/${run.id}`)).value,
        (r) => isTerminal(r.status),
      );
    const first = await submit();
    await until(
      async () =>
        (await json<RunRecord>(hub.url, `/v1/runs/${first.id}`)).value,
      (r) => r.status === "running",
    );
    const queued = await submit();
    assert.equal(queued.status, "queued");
    const two = await json<EngineProfile>(
      hub.url,
      "/v1/engines/custom",
      "PUT",
      registration("v2:"),
    );
    assert.notEqual(one.value.revision, two.value.revision);
    await json(hub.url, "/v1/engines/custom", "DELETE");
    assert.equal(
      (await json(hub.url, "/v1/sessions", "POST", { engineId: "custom" }))
        .status,
      404,
    );
    for (const r of await Promise.all([wait(first), wait(queued)])) {
      assert.equal(r.status, "completed");
      assert.equal(r.output, "v1:中文");
      assert.equal(r.configSnapshot?.profileRevision, one.value.revision);
    }
    assert.equal((await wait(await submit())).output, "v1:中文");
    await json(hub.url, "/v1/engines/custom", "PUT", {
      ...registration("v2:"),
      enabled: false,
    });
    assert.equal(
      (await json(hub.url, "/v1/sessions", "POST", { engineId: "custom" }))
        .status,
      404,
    );
    await json(hub.url, "/v1/engines/custom", "PUT", registration("v2:"));
    assert.equal(
      (
        await json(hub.url, "/v1/engines/default", "PUT", {
          engineId: "custom",
        })
      ).status,
      200,
    );
    const newer = (
      await json<SessionRecord>(hub.url, "/v1/sessions", "POST", {})
    ).value;
    assert.equal((await wait(await submit(newer.id))).output, "v2:中文");
    await hub.server.close();
    hub = await startHub({ ...options, defaultEngine: "custom" });
    assert.equal(
      (await json<RunRecord>(hub.url, `/v1/runs/${first.id}`)).value.output,
      "v1:中文",
    );
    assert.equal(
      (await json<{ engines: EngineProfile[] }>(hub.url, "/v1/engines")).value
        .engines[0]?.revision,
      two.value.revision,
    );
    const fresh = (
      await json<SessionRecord>(hub.url, "/v1/sessions", "POST", {})
    ).value;
    assert.equal((await wait(await submit(fresh.id))).output, "v2:中文");
    const hostile = await fetch(`${hub.url}/v1/engines`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: JSON.stringify(registration("hostile")),
    });
    assert.equal(hostile.status, 403);
    const openapi = (
      await json<{ paths: Record<string, unknown> }>(hub.url, "/openapi.json")
    ).value;
    assert.ok(openapi.paths["/v1/engines/{id}"]);
    assert.ok(openapi.paths["/v1/engines/discover"]);
  },
);

void test(
  "file watcher reloads atomic replacement; invalid engine/deployment edits preserve last valid catalog",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hh-reload-"));
    const file = path.join(directory, "engines.json");
    await writeFile(file, JSON.stringify({ engines: [registration("old:")] }));
    const hub = await startHub({
      dataDir: path.join(directory, "data"),
      cwd: directory,
      configFile: file,
      demo: false,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const list = async () =>
      (await json<{ engines: EngineProfile[] }>(hub.url, "/v1/engines")).value
        .engines;
    const old = (await list())[0]!;
    const session = hub.app.createSession({});
    await writeFile(
      `${file}.new`,
      JSON.stringify({ engines: [registration("new:")] }),
    );
    await rename(`${file}.new`, file);
    const changed = await until(list, (e) => e[0]?.revision !== old.revision);
    assert.notEqual(changed[0]?.revision, old.revision);
    const run = hub.app.submit(session.id, {
      text: "pinned",
      timeoutMs: 5000,
    }).run;
    assert.equal(
      (
        await until(
          async () => hub.app.getRun(run.id),
          (r) => isTerminal(r.status),
        )
      ).output,
      "old:pinned",
    );
    await writeFile(file, "engines: [broken");
    const failed = await json(hub.url, "/v1/engines/reload", "POST");
    assert.equal(failed.status, 500);
    assert.equal((await list())[0]?.revision, changed[0]?.revision);
    assert.equal(
      hub.app.engineRegistryStatus().lastError,
      "CONFIG_READ_FAILED",
    );
    await writeFile(
      file,
      JSON.stringify({
        engines: [registration("must-not-apply:")],
        maxWorkers: 1,
      }),
    );
    assert.equal(
      (await json(hub.url, "/v1/engines/reload", "POST")).status,
      409,
    );
    assert.equal((await list())[0]?.revision, changed[0]?.revision);
    await writeFile(
      file,
      JSON.stringify({ engines: [registration("valid:")] }),
    );
    assert.equal(
      (await json(hub.url, "/v1/engines/reload", "POST")).status,
      200,
    );
    assert.equal(hub.app.engineRegistryStatus().lastError, null);
  },
);
