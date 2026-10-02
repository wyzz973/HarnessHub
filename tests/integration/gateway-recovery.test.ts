import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import { isTerminal, type RunRecord } from "../../src/domain/types.js";

void test(
  "Gateway persists backend identity across suspend/restart, rejects replacement and permits first initialization after queued timeout",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hh-gateway-resume-"),
    );
    const peerState = path.join(directory, "peer");
    await mkdir(peerState);
    const configFile = path.join(directory, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        engines: [
          {
            id: "resume-peer",
            driver: "acp",
            command: [
              process.execPath,
              fileURLToPath(
                new URL("../fixtures/acp-recovery-peer.js", import.meta.url),
              ),
              peerState,
            ],
            acp: { sessionMode: "resume" },
          },
        ],
        maxConcurrency: 1,
      }),
    );
    const options = {
      dataDir: path.join(directory, "data"),
      cwd: directory,
      configFile,
      port: 0,
      demo: true,
    };
    let hub = await startHub(options);
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const wait = async (run: RunRecord) => {
      const until = Date.now() + 8000;
      while (!isTerminal(hub.app.getRun(run.id).status)) {
        assert.ok(Date.now() < until);
        await delay(10);
      }
      return hub.app.getRun(run.id);
    };
    const blocker = hub.app.createSession({ engineId: "fake" });
    const blocked = hub.app.submit(blocker.id, {
      text: "hold",
      timeoutMs: 8000,
      fixture: { scenario: "wait" },
    }).run;
    const session = hub.app.createSession({ engineId: "resume-peer" });
    const neverStarted = await wait(
      hub.app.submit(session.id, { text: "must not initialize", timeoutMs: 20 })
        .run,
    );
    assert.equal(neverStarted.status, "timed_out");
    assert.equal(neverStarted.startedAt, undefined);
    await hub.app.cancel(blocked.id);
    await wait(blocked);
    await hub.app.closeSession(blocker.id);
    const initialized = await wait(
      hub.app.submit(session.id, {
        text: "remember:original-nonce",
        timeoutMs: 5000,
      }).run,
    );
    assert.equal(initialized.generation, 2);
    assert.equal(initialized.output, "stored");
    const backend = hub.app.getSession(session.id).backendSessionId;
    assert.ok(backend);
    const active = hub.app.submit(session.id, {
      text: "recall",
      timeoutMs: 5000,
    }).run;
    await assert.rejects(
      hub.app.suspendSession(session.id),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "SESSION_BUSY",
    );
    assert.equal((await wait(active)).output, "original-nonce");
    const release = await hub.server.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/suspend`,
    });
    assert.equal(release.statusCode, 200, release.body);
    assert.equal(hub.app.getSession(session.id).status, "open");
    const restored = await wait(
      hub.app.submit(session.id, { text: "recall", timeoutMs: 5000 }).run,
    );
    assert.equal(restored.output, "original-nonce");
    assert.ok(
      hub.app
        .events(restored.id)
        .some(
          (e) =>
            e.type === "engine.session" &&
            e.data.resumed === true &&
            e.data.backendSessionId === backend,
        ),
    );
    await hub.server.close();
    hub = await startHub(options);
    assert.equal(hub.app.getSession(session.id).status, "open");
    const afterRestart = await wait(
      hub.app.submit(session.id, { text: "recall", timeoutMs: 5000 }).run,
    );
    assert.equal(afterRestart.output, "original-nonce");
    assert.equal(hub.app.getSession(session.id).backendSessionId, backend);
    await hub.app.suspendSession(session.id);
    await rm(path.join(peerState, `${backend}.txt`));
    const failed = await wait(
      hub.app.submit(session.id, { text: "recall", timeoutMs: 5000 }).run,
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "ACP_SESSION_RECOVERY_FAILED");
    assert.equal((await hub.app.closeSession(session.id)).status, "closed");
    assert.equal((await hub.app.closeSession(session.id)).status, "closed");
    assert.equal(hub.app.getSession(session.id).backendSessionId, backend);
    const operations = (
      await readFile(path.join(peerState, "operations.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(operations.filter((op) => op.type === "new").length, 1);
    assert.ok(
      (await hub.server.inject({ url: "/openapi.json" })).body.includes(
        "/v1/sessions/{id}/suspend",
      ),
    );
  },
);
