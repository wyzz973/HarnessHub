import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { startHub } from "../../src/main.js";
import { probeConfiguration } from "../../src/drivers/configuration/probe.js";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import type * as WindowsJobModule from "../../src/process/windows-job.js";
import {
  recoverWorkerLease,
  WorkerLeaseStore,
} from "../../src/process/leases.js";
import type { ExecutionSpec } from "../../src/domain/ports.js";
import type {
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "../../src/domain/types.js";

const native = fileURLToPath(
  new URL("../../native/harnesshub-job.exe", import.meta.url),
);
const cli = fileURLToPath(new URL("../fixtures/cli-peer.js", import.meta.url));
const windows = {
  skip: process.platform !== "win32" ? "Windows native Job Objects" : false,
  timeout: 20_000,
};

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    assert.ok(
      Date.now() < deadline,
      "Expected process/state transition before deadline",
    );
    await delay(10);
  }
}
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return true;
    throw error;
  }
}
function pids(text: string): { parent: number; child: number } {
  const raw: unknown = JSON.parse(text);
  assert.ok(
    raw &&
      typeof raw === "object" &&
      "parent" in raw &&
      typeof raw.parent === "number" &&
      "child" in raw &&
      typeof raw.child === "number",
  );
  return { parent: raw.parent, child: raw.child };
}

void test(
  "Windows missing packaged supervisor rejects readiness and stops its idle Worker without executing work",
  windows,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-missing-job-"));
    const modulePath = join(directory, "src", "process", "windows-job.js");
    await mkdir(join(directory, "src", "process"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await copyFile(
      fileURLToPath(
        new URL("../../src/process/windows-job.js", import.meta.url),
      ),
      modulePath,
    );
    // Load the real compiled adapter from an isolated distribution missing its native artifact.
    const isolated = (await import(
      pathToFileURL(modulePath).href
    )) as typeof WindowsJobModule;
    const worker = spawn(
      process.execPath,
      ["-e", "process.send('idle');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const closed = once(worker, "close");
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
      await closed;
      await rm(directory, { recursive: true });
    });
    await once(worker, "message");
    const owned = isolated.superviseWindowsWorker(worker, randomUUID());
    await assert.rejects(owned.ready, { code: "ENOENT" });
    assert.equal(await owned.close(), "unconfirmed");
    await closed;
    assert.ok(worker.pid);
    assert.equal(gone(worker.pid), true);
  },
);

void test(
  "Windows native launcher preserves literal Unicode argv and kills descendants when the supervisor is killed",
  windows,
  async (t) => {
    const args = [
      "",
      "中文 空格",
      'literal"quote',
      "trailing\\",
      "& echo unsafe",
      "$(command)",
    ];
    const echoed = spawn(
      native,
      [
        "run",
        String(process.pid),
        randomUUID(),
        process.execPath,
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1)))",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const echoClosed = once(echoed, "close");
    t.after(() => {
      if (echoed.exitCode === null && echoed.signalCode === null)
        echoed.kill("SIGKILL");
    });
    let output = "";
    echoed.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    echoed.stderr.resume();
    assert.equal((await echoClosed)[0], 0);
    assert.deepEqual(JSON.parse(output), args);

    const launched = spawn(
      native,
      ["run", String(process.pid), randomUUID(), process.execPath, cli, "wait"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const closed = once(launched, "close");
    t.after(async () => {
      if (launched.exitCode === null && launched.signalCode === null)
        launched.kill("SIGKILL");
      await closed;
    });
    launched.stderr.resume();
    let tree = "";
    launched.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      tree += chunk;
    });
    await until(() => tree.includes("\n"));
    const descendants = pids(tree);
    launched.kill("SIGKILL");
    await closed;
    await until(() => gone(descendants.parent) && gone(descendants.child));
  },
);

void test(
  "Windows ACP probe proves initialize and awaited descendant cleanup, including cancellation",
  windows,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-probe 中文 "));
    t.after(() => rm(directory, { recursive: true }));
    for (const mode of ["respond", "silent"]) {
      const marker = join(directory, `${mode}.json`);
      const abort = new AbortController();
      const probe = probeConfiguration(
        {
          command: [
            process.execPath,
            fileURLToPath(
              new URL("../fixtures/windows-probe-peer.js", import.meta.url),
            ),
            marker,
            mode,
          ],
          env: {},
          instructionPrefix: "",
          mcpServers: [],
        },
        "acp",
        directory,
        abort.signal,
      );
      await until(async () =>
        (await readdir(directory)).includes(`${mode}.json`),
      );
      const tree = pids(await readFile(marker, "utf8"));
      if (mode === "silent") abort.abort();
      const result = await probe;
      assert.equal(result.status, mode === "respond" ? "passed" : "failed");
      assert.equal(gone(tree.parent), true);
      assert.equal(gone(tree.child), true);
    }
  },
);

void test(
  "Windows startup cancellation releases the Job and legacy leases cannot authorize PID-only recovery",
  windows,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-startup-cancel-"));
    const host = new ProcessWorkerHost({
      leaseDir: join(directory, "leases"),
      shutdownGraceMs: 100,
    });
    t.after(async () => {
      await host.close();
      await rm(directory, { recursive: true });
    });
    const spec: ExecutionSpec = {
      sessionId: "starting" as SessionId,
      runId: "starting" as RunId,
      generation: 1,
      cwd: directory,
      stateDir: join(directory, "state"),
      input: { text: "never execute", timeoutMs: 5000 },
      profile: {
        id: "fake",
        revision: "1",
        driver: "fake",
        enabled: true,
        maxConcurrency: 1,
        capabilities: { resume: false, permissions: true, images: false },
      },
    };
    const started = host.start(spec, async () => {
      assert.fail("A cancelled startup must not execute");
    });
    const rejected = assert.rejects(started);
    assert.equal(await host.closeSession(spec.sessionId), "confirmed");
    await rejected;
    assert.deepEqual(await readdir(join(directory, "leases")), []);
    const store = new WorkerLeaseStore(join(directory, "legacy"));
    const record = store.save({
      sessionId: "legacy" as SessionId,
      pid: process.pid,
      ownerToken: randomUUID(),
      workerPath: "untrusted-legacy-path",
    });
    assert.equal(
      await recoverWorkerLease({ ...record, version: 1 }, 100),
      "unconfirmed",
    );
    assert.equal(gone(process.pid), false);
    store.remove(record);
  },
);

void test(
  "Windows compiled Gateway crash kills its CLI tree and restart records one interrupted Run without rerunning",
  windows,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-gateway-crash 中文 "));
    const configFile = join(directory, "engines.json");
    const dataDir = join(directory, "data");
    await writeFile(
      configFile,
      JSON.stringify({
        engines: [
          {
            id: "wait",
            driver: "cli",
            command: [process.execPath, cli, "wait"],
          },
        ],
      }),
    );
    const gateway = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../src/main.js", import.meta.url)),
        "--config",
        configFile,
        "--data-dir",
        dataDir,
        "--port",
        "0",
      ],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const closed = once(gateway, "close");
    t.after(async () => {
      if (gateway.exitCode === null && gateway.signalCode === null)
        gateway.kill("SIGKILL");
      await closed;
      await rm(directory, { recursive: true });
    });
    let output = "";
    gateway.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    gateway.stderr.resume();
    await until(() => output.includes("\n"));
    const ready: unknown = JSON.parse(output.trim());
    assert.ok(
      ready &&
        typeof ready === "object" &&
        "url" in ready &&
        typeof ready.url === "string",
    );
    const url = ready.url;
    const session = (await (
      await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as SessionRecord;
    const run = (await (
      await fetch(`${url}/v1/sessions/${session.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "stay active", timeoutMs: 60_000 }),
      })
    ).json()) as RunRecord;
    let descendants: ReturnType<typeof pids> | undefined;
    const stream = await fetch(`${url}/v1/runs/${run.id}/events`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let events = "";
    try {
      while (!descendants) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        events += decoder.decode(chunk.value, { stream: true });
        for (const line of events.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let event: { type?: string; data?: { text?: string } };
          try {
            event = JSON.parse(line.slice(6)) as typeof event;
          } catch {
            continue;
          }
          if (
            event.type === "message.delta" &&
            event.data?.text?.includes("\n")
          )
            descendants = pids(event.data.text);
        }
      }
    } finally {
      await reader.cancel();
    }
    gateway.kill("SIGKILL");
    await closed;
    await until(() => gone(descendants.parent) && gone(descendants.child));
    const restarted = await startHub({
      configFile,
      dataDir,
      cwd: directory,
      port: 0,
      demo: false,
    });
    try {
      const recovered = restarted.app.getRun(run.id);
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.cleanupStatus, "confirmed");
      assert.equal(
        restarted.app
          .events(run.id)
          .filter((event) => event.type === "RUN_INTERRUPTED").length,
        1,
      );
      assert.deepEqual(await readdir(join(dataDir, "workers")), []);
    } finally {
      await restarted.server.close();
    }
  },
);
