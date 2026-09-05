import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import {
  isTerminal,
  type EngineProfile,
  type RunRecord,
  type SessionRecord,
} from "../../src/domain/types.js";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
void test(
  "configured engines keep independent credentials, models, MCP and skills through real HTTP/SQLite/Workers and restart",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hh-configured-engines-"),
    );
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const options = {
      cwd: directory,
      dataDir: path.join(directory, "data"),
      demo: false,
      port: 0,
    };
    hub = await startHub(options);
    async function json<T>(route: string, body?: unknown): Promise<T> {
      const response = await fetch(
        hub!.url + route,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      assert.ok(response.ok, `${route}: ${response.status}`);
      return (await response.json()) as T;
    }
    const peer = fileURLToPath(
      new URL("../fixtures/configuration-peer.js", import.meta.url),
    );
    const skill = path.join(directory, "SKILL.md");
    await writeFile(skill, "fixture skill instruction");
    const keys = {
      a: "configuration-fixture-key-A",
      b: "configuration-fixture-key-B",
    };
    const registrations = [];
    for (const id of ["a", "b"] as const) {
      const file = path.join(directory, `${id}.key`);
      await writeFile(file, keys[id], { mode: 0o600 });
      const registration = {
        id,
        driver: "acp",
        command: [process.execPath, peer],
        model: id === "a" ? "alpha" : "beta",
        configuration: {
          adapter: "generic",
          env: { HH_TARGET_URL: `https://${id}.example` },
          secretEnv: { OPENAI_API_KEY: { kind: "file", value: file } },
          skills: [{ path: skill, enabled: id === "a" }],
          mcpServers: [
            {
              name: "remote",
              type: "http",
              enabled: true,
              url: `https://${id}.example/mcp`,
              secretHeaders: { Authorization: { kind: "file", value: file } },
            },
            {
              name: "off",
              type: "stdio",
              enabled: false,
              command: process.execPath,
            },
          ],
        },
      };
      registrations.push(registration);
      const profile = await json<EngineProfile>("/v1/engines", registration);
      assert.ok(profile.configuration);
    }
    async function run(id: string) {
      const session = await json<SessionRecord>("/v1/sessions", {
        engineId: id,
      });
      const run = await json<RunRecord>(`/v1/sessions/${session.id}/runs`, {
        text: "inspect owned settings",
        timeoutMs: 8000,
      });
      let result = run;
      const deadline = Date.now() + 10000;
      while (!isTerminal(result.status)) {
        assert.ok(Date.now() < deadline);
        await delay(20);
        result = await json<RunRecord>(`/v1/runs/${run.id}`);
      }
      assert.equal(result.status, "completed", JSON.stringify(result.error));
      await json(`/v1/sessions/${session.id}/close`, {});
      return JSON.parse(result.output ?? "{}") as {
        model: string;
        keyHash: string;
        url: string;
        skill: boolean;
        mcpCount: number;
        mcpHash: string;
      };
    }
    const [a, b] = await Promise.all([run("a"), run("b")]);
    assert.equal(a.keyHash, digest(keys.a));
    assert.equal(b.keyHash, digest(keys.b));
    assert.equal(a.model, "alpha");
    assert.equal(b.model, "beta");
    assert.equal(a.skill, true);
    assert.equal(b.skill, false);
    assert.equal(a.url, "https://a.example");
    assert.equal(b.url, "https://b.example");
    assert.equal(a.mcpCount, 1);
    assert.equal(b.mcpCount, 1);
    assert.notEqual(a.mcpHash, b.mcpHash);
    const check = await json<{
      checks: { status: string }[];
      modelCalled: boolean;
    }>("/v1/engines/a/test", {});
    assert.equal(check.modelCalled, false);
    assert.ok(check.checks.every((c) => c.status === "passed"));
    const before = await json<{ engines: EngineProfile[] }>("/v1/engines");
    await hub.server.close();
    hub = undefined;
    const db = await readFile(path.join(options.dataDir, "harnesshub.sqlite"));
    assert.equal(db.includes(Buffer.from(keys.a)), false);
    assert.equal(db.includes(Buffer.from(keys.b)), false);
    hub = await startHub(options);
    const after = await json<{ engines: EngineProfile[] }>("/v1/engines");
    assert.deepEqual(
      after.engines.map((e) => e.revision),
      before.engines.map((e) => e.revision),
    );
    assert.equal((await run("a")).keyHash, digest(keys.a));
    await writeFile(skill, "mutated");
    const changed = await json<{ checks: { status: string }[] }>(
      "/v1/engines/a/test",
      {},
    );
    assert.ok(changed.checks.some((c) => c.status === "failed"));
    assert.deepEqual(await readdir(path.join(options.dataDir, "workers")), []);
  },
);

void test("version 1 catalog files upgrade to version 2 without changing legacy revisions", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hh-config-migration-"),
  );
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  t.after(async () => {
    await hub?.server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = { cwd: directory, dataDir: directory, demo: false, port: 0 };
  hub = await startHub(options);
  await hub.app.registerEngine({
    id: "legacy",
    driver: "cli",
    command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
  });
  const revision = hub.app.engines()[0]!.revision;
  await hub.server.close();
  hub = undefined;
  const db = new DatabaseSync(path.join(directory, "harnesshub.sqlite"));
  const row = db
    .prepare("SELECT value FROM runtime_metadata WHERE key='engine_catalog'")
    .get() as { value: string };
  const catalog = JSON.parse(row.value) as { version: number };
  catalog.version = 1;
  db.prepare(
    "UPDATE runtime_metadata SET value=? WHERE key='engine_catalog'",
  ).run(JSON.stringify(catalog));
  db.close();
  hub = await startHub(options);
  assert.equal(hub.app.engines()[0]!.revision, revision);
  await hub.server.close();
  hub = undefined;
  const migrated = new DatabaseSync(path.join(directory, "harnesshub.sqlite"), {
    readOnly: true,
  });
  const result = migrated
    .prepare("SELECT value FROM runtime_metadata WHERE key='engine_catalog'")
    .get() as { value: string };
  assert.equal((JSON.parse(result.value) as { version: number }).version, 2);
  migrated.close();
});
