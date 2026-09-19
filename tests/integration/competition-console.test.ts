import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chooseConsolePort,
  consoleEnvironment,
  consoleGatewayUrl,
  jobConsoleLauncher,
  superviseConsole,
  type ConsoleLauncher,
} from "../../src/competition-bundle-main.js";
import { startHub } from "../../src/main.js";

const peer = fileURLToPath(
  new URL("../fixtures/console-peer.js", import.meta.url),
);
const native = fileURLToPath(
  new URL("../../native/harnesshub-job.exe", import.meta.url),
);

/** Runs the console directly; production uses {@link jobConsoleLauncher} on Windows. */
const directLauncher: ConsoleLauncher = (entry, env) => {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    child,
    terminate: async () => {
      child.kill("SIGTERM");
    },
  };
};
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen({ port: 0, host: "127.0.0.1" }, resolve),
  );
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address && typeof address === "object");
  return address.port;
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
async function gateway(t: test.TestContext, consoleUrl?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-console-"));
  const hub = await startHub({
    dataDir: directory,
    cwd: directory,
    demo: true,
    port: 0,
    ...(consoleUrl ? { consoleUrl } : {}),
  });
  t.after(async () => {
    await hub.server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return hub;
}
/** Planted credential that must not reach the console process. */
const source = {
  ...process.env,
  HARNESSHUB_MODEL_API_KEY: "fixture-secret",
  COMPANY_MODEL_KEY: "fixture-secret",
};

void test("console port choice keeps a free port and falls back from busy or Gateway ports", async (t) => {
  const holder = createServer();
  await new Promise<void>((resolve) =>
    holder.listen({ port: 0, host: "127.0.0.1" }, resolve),
  );
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));
  const address = holder.address();
  assert.ok(address && typeof address === "object");
  const busy = address.port;

  const open = await freePort();
  assert.deepEqual(await chooseConsolePort(open, busy), {
    port: open,
    requested: open,
  });
  const moved = await chooseConsolePort(busy, open);
  assert.equal(moved.reason, "in-use");
  assert.equal(moved.requested, busy);
  assert.notEqual(moved.port, busy);
  assert.notEqual(moved.port, open);
  const avoided = await chooseConsolePort(open, open);
  assert.equal(avoided.reason, "gateway-port");
  assert.notEqual(avoided.port, open);
});

void test("console environment keeps system variables and the Gateway upstream only", () => {
  const env = consoleEnvironment(
    {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      PATH: "/usr/bin",
      HOME: "/home/judge",
      HARNESSHUB_MODEL_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
    },
    {
      node: path.join("bundle", "runtime", "node.exe"),
      port: 3330,
      gatewayUrl: "http://127.0.0.1:6217",
    },
  );
  assert.deepEqual(Object.keys(env).sort(), [
    "HARNESSHUB_GATEWAY_URL",
    "HOSTNAME",
    "NEXT_TELEMETRY_DISABLED",
    "PATH",
    "PORT",
    "SystemRoot",
    "TEMP",
  ]);
  assert.equal(env.PORT, "3330");
  assert.equal(env.HOSTNAME, "127.0.0.1");
  assert.equal(
    env.PATH?.split(path.delimiter)[0],
    path.join("bundle", "runtime"),
  );
  assert.equal(consoleGatewayUrl("localhost", 6217), "http://127.0.0.1:6217");
  assert.equal(consoleGatewayUrl("127.0.0.1", 6217), "http://127.0.0.1:6217");
  assert.equal(consoleGatewayUrl("::1", 6217), "http://[::1]:6217");
});

void test(
  "supervised console becomes ready through the Gateway, is reachable from the Gateway root, and stops cleanly",
  { timeout: 30_000 },
  async (t) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const hub = await gateway(t, url);
    const events: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const supervised = superviseConsole({
      url,
      entry: peer,
      env: consoleEnvironment(source, {
        node: process.execPath,
        port,
        gatewayUrl: hub.url,
      }),
      launch: directLauncher,
      emit: (event) => events.push(event),
      output: (line) => lines.push(line),
    });
    t.after(() => supervised.stop());
    assert.equal(await supervised.ready, true);
    assert.deepEqual(events, [{ event: "console.ready", url }]);

    const started = (await (await fetch(`${url}/fixture`)).json()) as {
      pid: number;
      port: string;
      hostname: string;
      gateway: string;
      telemetry: string;
      names: string[];
    };
    assert.equal(started.port, String(port));
    assert.equal(started.hostname, "127.0.0.1");
    assert.equal(started.gateway, hub.url);
    assert.equal(started.telemetry, "1");
    assert.ok(!started.names.includes("HARNESSHUB_MODEL_API_KEY"));
    assert.ok(!started.names.includes("COMPANY_MODEL_KEY"));

    const root = await fetch(`${hub.url}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), url);

    await supervised.stop();
    await supervised.stop();
    assert.ok(gone(started.pid));
    assert.deepEqual(
      events.map((event) => event.event),
      ["console.ready"],
      "an orderly stop is not reported as a console crash",
    );
    assert.ok(lines.some((line) => line.includes("fixture console listening")));
    const reused = createServer();
    await new Promise<void>((resolve) =>
      reused.listen({ port, host: "127.0.0.1" }, resolve),
    );
    await new Promise<void>((resolve) => reused.close(() => resolve()));
  },
);

void test(
  "a crashing or unlaunchable console is reported while the competition Gateway keeps serving",
  { timeout: 30_000 },
  async (t) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const hub = await gateway(t, url);
    const events: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const crashed = superviseConsole({
      url,
      entry: peer,
      env: {
        ...consoleEnvironment(source, {
          node: process.execPath,
          port,
          gatewayUrl: hub.url,
        }),
        FIXTURE_CONSOLE_EXIT: "7",
      },
      launch: directLauncher,
      emit: (event) => events.push(event),
      output: (line) => lines.push(line),
    });
    assert.equal(await crashed.ready, false);
    assert.deepEqual(events, [
      { event: "console.exited", code: 7, signal: null, gateway: "running" },
    ]);
    assert.ok(lines.includes("fixture console failed on purpose"));
    await crashed.stop();

    const directory = await mkdtemp(path.join(os.tmpdir(), "hh-no-helper-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const missing: Record<string, unknown>[] = [];
    const unlaunchable = superviseConsole({
      url,
      entry: peer,
      env: {},
      launch: (entry, env) =>
        jobConsoleLauncher(
          path.join(directory, "missing-helper.exe"),
          process.execPath,
        )(entry, env),
      emit: (event) => missing.push(event),
      output: () => {},
    });
    assert.equal(await unlaunchable.ready, false);
    await unlaunchable.stop();

    // Give any stray asynchronous failure a chance to surface before checking the Gateway.
    await delay(100);
    assert.deepEqual(
      missing.map((event) => event.event),
      ["console.error"],
      "a spawn failure is reported once, not again as a crash",
    );
    const ready = await fetch(`${hub.url}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true });
  },
);

void test(
  "Windows Job launcher owns the bundled console tree and empties it on stop",
  {
    skip: process.platform !== "win32" ? "Windows native Job Objects" : false,
    timeout: 30_000,
  },
  async (t) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const hub = await gateway(t, url);
    const events: Record<string, unknown>[] = [];
    const supervised = superviseConsole({
      url,
      entry: peer,
      env: consoleEnvironment(source, {
        node: process.execPath,
        port,
        gatewayUrl: hub.url,
      }),
      launch: jobConsoleLauncher(native, process.execPath),
      emit: (event) => events.push(event),
      output: () => {},
    });
    t.after(() => supervised.stop());
    assert.equal(await supervised.ready, true);
    const { pid } = (await (await fetch(`${url}/fixture`)).json()) as {
      pid: number;
    };
    assert.equal(gone(pid), false);
    await supervised.stop();
    const deadline = Date.now() + 8_000;
    while (!gone(pid)) {
      assert.ok(Date.now() < deadline, "console process survived Job close");
      await delay(20);
    }
    assert.deepEqual(
      events.map((event) => event.event),
      ["console.ready"],
    );
  },
);
