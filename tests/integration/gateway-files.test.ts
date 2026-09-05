import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import {
  isTerminal,
  type RunRecord,
  type SessionRecord,
} from "../../src/domain/types.js";

void test(
  "Gateway captures declared JSON/binary outputs before terminal, preserves replay identity and restart reads",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hh-gateway-files-"),
    );
    const file = path.join(directory, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        engines: [
          {
            id: "file-peer",
            driver: "cli",
            command: [
              process.execPath,
              fileURLToPath(
                new URL("../fixtures/gateway-file-peer.js", import.meta.url),
              ),
            ],
          },
        ],
      }),
    );
    await writeFile(
      path.join(directory, "input.json"),
      JSON.stringify({ values: [3, 5, 7] }),
    );
    const options = {
      dataDir: path.join(directory, "data"),
      cwd: directory,
      configFile: file,
      port: 0,
      demo: false,
    };
    let hub = await startHub(options);
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const session = (
      await hub.server.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: {},
      })
    ).json<SessionRecord>();
    const route = `/v1/sessions/${session.id}/runs`;
    for (const outputs of [
      [{ path: "../secret", name: "bad" }],
      [
        { path: "results/a", name: "same" },
        { path: "results/b", name: "same" },
      ],
      [{ path: "C:\\secret", name: "bad" }],
    ]) {
      assert.equal(
        (
          await hub.server.inject({
            method: "POST",
            url: route,
            payload: { text: "work", outputs },
          })
        ).statusCode,
        400,
      );
    }
    const input = {
      text: "work",
      timeoutMs: 5000,
      outputs: [
        {
          path: "results/summary.json",
          name: "summary.json",
          mediaType: "application/json",
        },
        { path: "results/raw.bin", name: "raw.bin" },
      ],
    };
    const submit = await hub.server.inject({
      method: "POST",
      url: route,
      headers: { "idempotency-key": "files-v1" },
      payload: input,
    });
    assert.equal(submit.statusCode, 202);
    const accepted = submit.json<RunRecord>();
    const until = Date.now() + 8000;
    while (!isTerminal(hub.app.getRun(accepted.id).status)) {
      assert.ok(Date.now() < until);
      await delay(15);
    }
    const run = hub.app.getRun(accepted.id);
    assert.equal(run.status, "completed");
    assert.equal(run.cleanupStatus, "confirmed");
    assert.equal(run.artifacts.length, 2);
    const jsonArtifact = run.artifacts.find((a) => a.name === "summary.json")!;
    const binary = run.artifacts.find((a) => a.name === "raw.bin")!;
    assert.deepEqual(
      JSON.parse((await hub.app.artifact(jsonArtifact.id)).bytes.toString()),
      { sum: 15, count: 3 },
    );
    const downloaded = await fetch(`${hub.url}/v1/artifacts/${binary.id}`);
    assert.equal(
      downloaded.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(
      downloaded.headers.get("content-disposition") ?? "",
      /^attachment;/,
    );
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(
      Buffer.from(await downloaded.arrayBuffer()),
      Buffer.from([0, 255, 128, 10]),
    );
    const events = hub.app.events(run.id);
    assert.equal(events.at(-1)?.type, "RUN_COMPLETED");
    assert.equal(events.filter((e) => e.type === "ARTIFACT_CREATED").length, 2);
    const replay = await hub.server.inject({
      method: "POST",
      url: route,
      headers: { "idempotency-key": "files-v1" },
      payload: input,
    });
    assert.equal(replay.json<RunRecord>().id, run.id);
    assert.equal(
      (
        await hub.server.inject({
          method: "POST",
          url: route,
          headers: { "idempotency-key": "files-v1" },
          payload: {
            ...input,
            outputs: [{ path: "results/raw.bin", name: "raw.bin" }],
          },
        })
      ).statusCode,
      409,
    );
    await writeFile(path.join(directory, "results/raw.bin"), "changed source");
    await hub.server.close();
    hub = await startHub(options);
    assert.deepEqual(
      (await hub.app.artifact(binary.id)).bytes,
      Buffer.from([0, 255, 128, 10]),
    );
    const second = hub.app.createSession({});
    const missing = hub.app.submit(second.id, {
      text: "missing",
      timeoutMs: 5000,
      outputs: [{ path: "not-created.txt", name: "missing.txt" }],
    }).run;
    while (!isTerminal(hub.app.getRun(missing.id).status)) {
      assert.ok(Date.now() < until);
      await delay(15);
    }
    assert.equal(hub.app.getRun(missing.id).status, "completed");
    assert.equal(
      hub.app.events(missing.id).filter((e) => e.type === "ARTIFACT_MISSING")
        .length,
      1,
    );
    assert.equal(hub.app.getRun(missing.id).artifacts.length, 0);
    assert.deepEqual(await readdir(path.join(directory, "data/workers")), []);
    assert.equal(
      await readFile(path.join(directory, "input.json"), "utf8"),
      JSON.stringify({ values: [3, 5, 7] }),
    );
  },
);
