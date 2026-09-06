import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeEngine } from "../../src/engine/registry.js";
import { probeConfiguration } from "../../src/drivers/configuration/probe.js";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import { startHub } from "../../src/main.js";
import type { RunId, SessionId } from "../../src/domain/types.js";
import type { ExecutionSpec, WorkerMessage } from "../../src/domain/ports.js";

void test(
  "ACP recovery keeps initialization bounded until reconnect and reclaims the actual hanging peer and descendant",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-acp-hang-reconnect-"));
    const host = new ProcessWorkerHost();
    const realDelay = delay;
    let mocked = false;
    t.after(async () => {
      if (mocked) {
        t.mock.timers.tick(60_000);
        t.mock.timers.reset();
      }
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    const initial: ExecutionSpec = {
      sessionId: "reconnect-session" as SessionId,
      runId: "first-run" as RunId,
      generation: 1,
      cwd: root,
      stateDir: join(root, "backend"),
      input: { text: "remember:original-context", timeoutMs: 10_000 },
      profile: normalizeEngine({
        id: "reconnect-peer",
        driver: "acp",
        command: [
          process.execPath,
          fileURLToPath(
            new URL(
              "../fixtures/acp-hanging-reconnect-peer.js",
              import.meta.url,
            ),
          ),
          root,
        ],
        acp: { sessionMode: "resume", initializeTimeoutMs: 2000 },
      }),
    };
    let backendSessionId: string | undefined;
    // The real test deadline remains active. Freeze only application timers so
    // scheduler contention cannot expire initialization before the peer starts.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mocked = true;
    const first = await host.start(initial, async (message) => {
      if (message.type === "event" && message.event.type === "engine.session") {
        const value = message.event.data.backendSessionId;
        if (typeof value === "string") backendSessionId = value;
      }
    });
    assert.equal((await first.result).output, "stored");
    assert.ok(backendSessionId);
    t.mock.timers.reset();
    mocked = false;
    assert.equal(await host.closeSession(initial.sessionId), "confirmed");
    await writeFile(
      join(root, "hang-initialize"),
      "hang the reconnect handshake",
    );
    const messages: WorkerMessage[] = [];
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mocked = true;
    const reconnect = await host.start(
      {
        ...initial,
        backendSessionId,
        runId: "next-run" as RunId,
        generation: 2,
        input: { text: "recall", timeoutMs: 10_000 },
      },
      async (message) => {
        messages.push(message);
      },
    );
    const rejected = assert.rejects(reconnect.result, {
      code: "ACP_INITIALIZE_TIMEOUT",
    });
    const readyUntil = performance.now() + 8000;
    while (!existsSync(join(root, "hanging-pids.json"))) {
      assert.ok(
        performance.now() < readyUntil,
        "Reconnect peer did not reach its hanging initialize barrier",
      );
      await realDelay(20);
    }
    const pids = JSON.parse(
      await readFile(join(root, "hanging-pids.json"), "utf8"),
    ) as { peer: number; descendant: number };
    for (const pid of [pids.peer, pids.descendant])
      assert.doesNotThrow(() => process.kill(pid, 0));
    t.mock.timers.tick(2000);
    await rejected;
    const cleanup = host.closeSession(initial.sessionId);
    let closed = false;
    void cleanup.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      },
    );
    const cleanupUntil = performance.now() + 8000;
    while (!closed) {
      assert.ok(
        performance.now() < cleanupUntil,
        "Timed-out reconnect did not finish process cleanup",
      );
      await realDelay(20);
      t.mock.timers.tick(20);
    }
    t.mock.timers.reset();
    mocked = false;
    assert.equal(await cleanup, "confirmed");
    for (const pid of [pids.peer, pids.descendant]) {
      assert.ok(Number.isInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    assert.equal(
      messages.some(
        (message) =>
          message.type === "event" &&
          ["engine.capabilities", "engine.session"].includes(
            message.event.type,
          ),
      ),
      false,
    );
    assert.equal(
      await readFile(join(root, `${backendSessionId}.txt`), "utf8"),
      "original-context",
    );
  },
);

void test("HTTP registration, update, listing and restart retain an independent ACP initialization budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hh-acp-http-config-"));
  const options = { dataDir: root, cwd: root, port: 0, demo: false };
  let hub = await startHub(options);
  t.after(async () => {
    await hub.server.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = {
    id: "bounded-acp",
    driver: "acp",
    command: [process.execPath],
  };
  for (const method of ["POST", "PUT"] as const) {
    const timeout = method === "POST" ? 60_000 : 59_999;
    const response = await hub.server.inject({
      method,
      url: method === "POST" ? "/v1/engines" : "/v1/engines/bounded-acp",
      payload: { ...base, acp: { initializeTimeoutMs: timeout } },
    });
    assert.equal(
      response.statusCode,
      method === "POST" ? 201 : 200,
      response.body,
    );
    assert.deepEqual(response.json<{ acp: unknown }>().acp, {
      initializeTimeoutMs: timeout,
    });
  }
  for (const value of [0, 60_001, 1.5, "not-a-number", null]) {
    const invalid = await hub.server.inject({
      method: "PUT",
      url: "/v1/engines/bounded-acp",
      payload: { ...base, acp: { initializeTimeoutMs: value } },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  await hub.server.close();
  hub = await startHub(options);
  const listed = await hub.server.inject({ method: "GET", url: "/v1/engines" });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json<{ engines: { acp: unknown }[] }>().engines[0]!.acp,
    {
      initializeTimeoutMs: 59_999,
    },
  );
});

void test("ACP initialize limit is optional, bounded, and independent of resume capability", () => {
  const base = {
    id: "bounded-acp",
    driver: "acp",
    command: [process.execPath],
  };
  const profile = normalizeEngine({
    ...base,
    acp: { initializeTimeoutMs: 60_000 },
  });
  assert.equal(profile.acp?.initializeTimeoutMs, 60_000);
  assert.equal(profile.capabilities.resume, false);
  assert.equal(normalizeEngine(base).acp, undefined);
  for (const value of [0, -1, 0.1, 60_001, "60000", null])
    assert.throws(() =>
      normalizeEngine({ ...base, acp: { initializeTimeoutMs: value } }),
    );
  assert.throws(() =>
    normalizeEngine({
      ...base,
      driver: "cli",
      acp: { initializeTimeoutMs: 1000 },
    }),
  );
});

void test(
  "ACP initialization budget stops at capabilities and does not limit the prompt",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-acp-init-success-")),
      host = new ProcessWorkerHost(),
      ready = Promise.withResolvers<void>();
    t.after(async () => {
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    const handle = await host.start(
      {
        sessionId: "long-prompt" as SessionId,
        runId: "long-run" as RunId,
        generation: 1,
        cwd: root,
        stateDir: join(root, "backend"),
        input: { text: "wait for release", timeoutMs: 10_000 },
        profile: normalizeEngine({
          id: "bounded-acp",
          driver: "acp",
          command: [
            process.execPath,
            fileURLToPath(
              new URL("../fixtures/acp-initialize-peer.js", import.meta.url),
            ),
          ],
          acp: { initializeTimeoutMs: 1500 },
        }),
      },
      async (message) => {
        if (
          message.type === "event" &&
          message.event.type === "engine.capabilities"
        )
          ready.resolve();
      },
    );
    await Promise.race([
      ready.promise,
      handle.result.then(() => {
        throw new Error("Run settled before capabilities");
      }),
    ]);
    // A deliberate timer-boundary assertion after the actual ready event, not a startup sleep.
    await delay(1550);
    await writeFile(join(root, "release-prompt"), "release");
    assert.equal((await handle.result).status, "completed");
    assert.equal(
      await host.closeSession("long-prompt" as SessionId),
      "confirmed",
    );
  },
);

void test(
  "protocol probe and actual ACP Worker honor the configured initialize limit",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-acp-init-"));
    const host = new ProcessWorkerHost();
    t.after(async () => {
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    const command = [
      process.execPath,
      "-e",
      "process.stdin.resume();setInterval(()=>{},1000)",
    ];
    const probe = await probeConfiguration(
      { command, env: {}, instructionPrefix: "", mcpServers: [] },
      "acp",
      root,
      new AbortController().signal,
      100,
    );
    assert.equal(probe.status, "failed");
    await assert.rejects(
      probeConfiguration(
        { command, env: {}, instructionPrefix: "", mcpServers: [] },
        "acp",
        root,
        new AbortController().signal,
        60_001,
      ),
    );
    const handle = await host.start(
      {
        sessionId: "bounded-session" as SessionId,
        runId: "bounded-run" as RunId,
        generation: 1,
        cwd: root,
        stateDir: join(root, "backend"),
        input: { text: "must never prompt", timeoutMs: 10_000 },
        profile: normalizeEngine({
          id: "bounded-acp",
          driver: "acp",
          command,
          acp: { initializeTimeoutMs: 100 },
        }),
      },
      async () => {},
    );
    await assert.rejects(handle.result, { code: "ACP_INITIALIZE_TIMEOUT" });
    assert.equal(
      await host.closeSession("bounded-session" as SessionId),
      "confirmed",
    );
  },
);
