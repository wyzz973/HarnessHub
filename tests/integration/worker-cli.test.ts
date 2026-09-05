import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import { startHub } from "../../src/main.js";
import type { ExecutionSpec, WorkerMessage } from "../../src/domain/ports.js";
import type {
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "../../src/domain/types.js";

const peer = fileURLToPath(new URL("../fixtures/cli-peer.js", import.meta.url));

function spec(
  directory: string,
  mode: string,
  text = "中文🙂\nsecond line",
): ExecutionSpec {
  return {
    sessionId: `cli-${mode}` as SessionId,
    runId: `run-${mode}` as RunId,
    generation: 1,
    cwd: directory,
    stateDir: join(directory, mode),
    input: { text, timeoutMs: 5000 },
    profile: {
      id: `cli-${mode}`,
      revision: "1",
      enabled: true,
      driver: "cli",
      command: [
        process.execPath,
        peer,
        mode,
        ...(mode === "argv" ? ["{prompt}"] : []),
      ],
      cli: {
        inputMode: mode === "argv" ? "argv" : "stdin",
        maxOutputBytes: 4 * 1024 * 1024,
      },
      capabilities: { permissions: false, resume: false, images: false },
      maxConcurrency: 1,
    },
  };
}

function messageText(message: WorkerMessage): string {
  return message.type === "event" &&
    message.event.type === "message.delta" &&
    typeof message.event.data.text === "string"
    ? message.event.data.text
    : "";
}

function parsePids(text: string): { parent: number; child: number } {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("parent" in value && typeof value.parent === "number");
  assert.ok("child" in value && typeof value.child === "number");
  return { parent: value.parent, child: value.child };
}

void test(
  "compiled CLI Worker preserves UTF-8 stdin and literal argv without invoking a shell",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-中文 "));
    const host = new ProcessWorkerHost({ shutdownGraceMs: 500 });
    t.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    for (const mode of ["stdin", "argv"]) {
      const input = spec(
        directory,
        mode,
        mode === "argv"
          ? '中文 $(touch must-not-exist) `touch neither` "literal"\n'
          : undefined,
      );
      const messages: WorkerMessage[] = [];
      const handle = await host.start(input, async (message) => {
        messages.push(message);
      });
      assert.deepEqual(await handle.result, {
        status: "completed",
        stopReason: "process_exit",
        output: input.input.text,
      });
      assert.equal(messages.map(messageText).join(""), input.input.text);
      assert.deepEqual(
        messages.map((message) => message.seq),
        messages.map((_, i) => i + 1),
      );
      assert.equal(await host.closeSession(input.sessionId), "confirmed");
    }
    assert.equal((await readdir(directory)).includes("must-not-exist"), false);
    assert.equal((await readdir(directory)).includes("neither"), false);
  },
);

void test(
  "CLI Worker reports spawn, exit and UTF-8 byte overflow failures without publishing stderr",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-errors-"));
    const host = new ProcessWorkerHost({ shutdownGraceMs: 500 });
    t.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    for (const scenario of [
      { mode: "failure", code: "CLI_EXIT_NONZERO" },
      { mode: "overflow", code: "CLI_OUTPUT_LIMIT" },
      { mode: "spawn", code: "CLI_SPAWN_ERROR" },
    ]) {
      const input = spec(directory, scenario.mode, "fixture input");
      if (scenario.mode === "overflow") input.profile.cli!.maxOutputBytes = 5;
      if (scenario.mode === "spawn")
        input.profile.command = [join(directory, "absent-engine")];
      const messages: WorkerMessage[] = [];
      const handle = await host.start(input, async (message) => {
        messages.push(message);
      });
      const result = await handle.result;
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, scenario.code);
      assert.equal(result.output, undefined);
      assert.equal(
        JSON.stringify(messages).includes("fixture-private-value"),
        false,
      );
      assert.equal(await host.closeSession(input.sessionId), "confirmed");
    }
  },
);

void test(
  "CLI cancellation awaits direct child exit and Host close reclaims the owned descendant group",
  {
    timeout: 15_000,
    skip:
      process.platform === "win32"
        ? "Windows process-tree cleanup is not verified"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-cancel-"));
    const host = new ProcessWorkerHost({ shutdownGraceMs: 700 });
    t.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    const started = Promise.withResolvers<string>();
    let text = "";
    const input = spec(directory, "wait", "wait input");
    const handle = await host.start(input, async (message) => {
      text += messageText(message);
      if (text.includes("\n")) started.resolve(text);
    });
    const pids = parsePids(
      await Promise.race([
        started.promise,
        handle.result.then(() => {
          throw new Error("CLI exited before readiness");
        }),
      ]),
    );
    await handle.cancel();
    assert.equal((await handle.result).status, "cancelled");
    assert.throws(() => process.kill(pids.parent, 0), { code: "ESRCH" });
    assert.equal(await host.closeSession(input.sessionId), "confirmed");
    assert.throws(() => process.kill(pids.child, 0), { code: "ESRCH" });
  },
);

void test(
  "Gateway owns CLI deadline and confirms cleanup of a process that ignores SIGTERM",
  {
    timeout: 15_000,
    skip:
      process.platform === "win32"
        ? "Windows process-tree cleanup is not verified"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-deadline-"));
    const config = join(directory, "engines.json");
    const input = spec(directory, "wait", "wait input");
    await writeFile(
      config,
      JSON.stringify({
        engines: [
          {
            id: "cli-wait",
            driver: "cli",
            command: input.profile.command,
            cli: input.profile.cli,
          },
        ],
        cancelGraceMs: 700,
      }),
    );
    const hub = await startHub({
      configFile: config,
      dataDir: join(directory, "data"),
      cwd: directory,
      demo: false,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true });
    });
    const session = (await (
      await fetch(`${hub.url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as SessionRecord;
    const accepted = await fetch(`${hub.url}/v1/sessions/${session.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deadline", timeoutMs: 1500 }),
    });
    assert.equal(accepted.status, 202);
    let run = (await accepted.json()) as RunRecord;
    const until = Date.now() + 8000;
    while (run.status !== "timed_out") {
      if (Date.now() > until)
        throw new Error(`Deadline did not settle: ${JSON.stringify(run)}`);
      await delay(20);
      run = (await (
        await fetch(`${hub.url}/v1/runs/${run.id}`)
      ).json()) as RunRecord;
    }
    assert.equal(run.cleanupStatus, "confirmed");
    assert.ok(run.startedAt);
    const events = await (
      await fetch(`${hub.url}/v1/runs/${run.id}/events`)
    ).text();
    const text = events
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        const event: unknown = JSON.parse(line.slice(6));
        if (
          typeof event !== "object" ||
          event === null ||
          !("type" in event) ||
          event.type !== "message.delta" ||
          !("data" in event)
        )
          return "";
        const data = event.data;
        return typeof data === "object" &&
          data !== null &&
          "text" in data &&
          typeof data.text === "string"
          ? data.text
          : "";
      })
      .join("");
    const pids = parsePids(text);
    assert.throws(() => process.kill(pids.parent, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(pids.child, 0), { code: "ESRCH" });
  },
);

void test(
  "Gateway reaps CLI background descendants before publishing completed or failed results",
  {
    timeout: 15_000,
    skip:
      process.platform === "win32"
        ? "Windows process-tree cleanup is not verified"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-reap-"));
    const config = join(directory, "engines.json");
    const dataDir = join(directory, "data");
    const modes = ["background-success", "background-failure"] as const;
    await writeFile(
      config,
      JSON.stringify({
        engines: modes.map((mode) => ({
          id: mode,
          driver: "cli",
          command: [process.execPath, peer, mode],
        })),
        cancelGraceMs: 500,
      }),
    );
    const hub = await startHub({
      configFile: config,
      dataDir,
      cwd: directory,
      demo: false,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true });
    });
    for (const mode of modes) {
      const created = await hub.server.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { engineId: mode },
      });
      assert.equal(created.statusCode, 201, created.body);
      const session = created.json<SessionRecord>();
      const accepted = await hub.server.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/runs`,
        payload: { text: "background cleanup", timeoutMs: 5000 },
      });
      assert.equal(accepted.statusCode, 202, accepted.body);
      let run = accepted.json<RunRecord>();
      const until = Date.now() + 8000;
      while (!run.finishedAt) {
        if (Date.now() > until)
          throw new Error(`CLI result did not settle: ${JSON.stringify(run)}`);
        await delay(20);
        run = (
          await hub.server.inject({
            method: "GET",
            url: `/v1/runs/${run.id}`,
          })
        ).json<RunRecord>();
      }
      assert.equal(
        run.status,
        mode === "background-success" ? "completed" : "failed",
      );
      assert.equal(run.cleanupStatus, "confirmed");
      if (mode === "background-failure")
        assert.equal(run.error?.code, "CLI_EXIT_NONZERO");
      const text = hub.app
        .events(run.id)
        .filter((event) => event.type === "message.delta")
        .map((event) => event.data.text)
        .join("");
      const pids = parsePids(text);
      assert.throws(() => process.kill(pids.parent, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(pids.child, 0), { code: "ESRCH" });
      assert.deepEqual(await readdir(join(dataDir, "workers")), []);
    }
  },
);

void test(
  "persistent EPERM stays unconfirmed with its lease retained until absence can be verified",
  {
    timeout: 5000,
    skip:
      process.platform === "win32"
        ? "Windows does not use POSIX group signalling"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-eperm-"));
    const leaseDir = join(directory, "leases");
    const host = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 40 });
    const recovery = new ProcessWorkerHost({ leaseDir, shutdownGraceMs: 40 });
    let quarantined = false;
    t.after(async () => {
      if (quarantined)
        await assert.rejects(host.close(), { code: "WORKER_CLEANUP_FAILED" });
      else await host.close();
      await recovery.recover();
      await recovery.close();
      await rm(directory, { recursive: true });
    });
    const input = spec(directory, "stdin", "x");
    const handle = await host.start(input, async () => {});
    assert.equal((await handle.result).status, "completed");
    const leaseFiles = await readdir(leaseDir);
    assert.equal(leaseFiles.length, 1);
    const lease: unknown = JSON.parse(
      await readFile(join(leaseDir, leaseFiles[0]!), "utf8"),
    );
    assert.ok(typeof lease === "object" && lease !== null);
    assert.ok("pid" in lease && typeof lease.pid === "number");
    const group = -lease.pid;
    const realKill = process.kill;
    const signals = new Set<number | NodeJS.Signals | undefined>();
    // Only this test's owned group is denied; other processes keep real signalling.
    const denial = t.mock.method(
      process,
      "kill",
      (pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === group) {
          signals.add(signal);
          throw Object.assign(new Error("Fixture permission denied"), {
            code: "EPERM",
          });
        }
        return realKill(pid, signal);
      },
    );
    try {
      const cleanup = await host.closeSession(input.sessionId);
      quarantined = cleanup !== "confirmed";
      assert.equal(cleanup, "unconfirmed");
      assert.ok(signals.has("SIGTERM") && signals.has("SIGKILL"));
      assert.deepEqual(await readdir(leaseDir), leaseFiles);
    } finally {
      denial.mock.restore();
    }
    assert.equal((await recovery.recover()).get(input.sessionId), "confirmed");
    assert.deepEqual(await readdir(leaseDir), []);
  },
);
