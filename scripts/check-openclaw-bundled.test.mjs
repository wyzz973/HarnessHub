import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prepareOpenClaw } from "./prepare-openclaw.mjs";
const wrapper = fileURLToPath(
  new URL("./launch-openclaw-bundled.mjs", import.meta.url),
);
const fixture = fileURLToPath(
  new URL("../tests/fixtures/openclaw-bundled.mjs", import.meta.url),
);
const absent = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
};
test("OpenClaw preparation refuses an unpinned package before executing its scripts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hh-openclaw-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "0.0.0" }),
  );
  await assert.rejects(prepareOpenClaw(root), /fixed openclaw@2026.9.2/);
});
async function setup(t, pending = false) {
  const root = await mkdtemp(path.join(tmpdir(), "hh-openclaw 中文 ")),
    state = path.join(root, "state"),
    entry = path.join(root, "openclaw.mjs");
  await mkdir(state);
  await copyFile(fixture, entry);
  if (pending)
    await writeFile(path.join(root, ".openclaw-lifecycle-pending"), "pending");
  await writeFile(
    path.join(state, "openclaw.json"),
    JSON.stringify({
      models: {
        providers: { fixture: { baseUrl: "https://configured.invalid" } },
      },
    }),
  );
  const child = spawn(process.execPath, [wrapper, entry], {
    cwd: root,
    env: {
      SystemRoot: process.env.SystemRoot,
      TEMP: root,
      TMP: root,
      PATH: "C:\\Windows\\System32",
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = once(child, "close");
  let out = "",
    err = "";
  const ready = Promise.withResolvers();
  void ready.promise.catch(() => {});
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    out += chunk;
    if (out.includes('"id":1')) ready.resolve();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    err += chunk;
  });
  child.once("error", ready.reject);
  child.once("close", () => ready.reject(Error("wrapper closed " + err)));
  const timeout = setTimeout(
    () => ready.reject(Error("fixture startup timeout")),
    10000,
  );
  t.after(async () => {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await closed;
    // Windows can release an exited descendant's directory handle after PID absence.
    // This retries only filesystem cleanup; process absence assertions never retry a test.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  return {
    root,
    state,
    child,
    closed,
    ready: ready.promise,
    output: () => out,
    errors: () => err,
  };
}
for (const action of ["eof", "gateway-failure", "wrapper-crash"]) {
  test(
    `OpenClaw bundled ${action} closes Gateway, ACP and both descendants`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const run = await setup(t);
      run.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1 },
        }) + "\n",
      );
      await run.ready;
      const gateway = JSON.parse(
          await readFile(path.join(run.state, "gateway.json"), "utf8"),
        ),
        acp = JSON.parse(
          await readFile(path.join(run.state, "acp.json"), "utf8"),
        );
      assert.equal(gateway.url, acp.url);
      assert.match(gateway.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(gateway.token, acp.token);
      assert.ok(gateway.token.length >= 64);
      assert.equal(gateway.config.gateway.bind, "loopback");
      assert.equal(
        gateway.config.models.providers.fixture.baseUrl,
        "https://configured.invalid",
      );
      assert.equal(gateway.config.cron.enabled, false);
      assert.equal(gateway.config.models.catalogRefresh.enabled, false);
      assert.equal(gateway.config.update.checkOnStart, false);
      assert.equal(gateway.config.update.auto.enabled, false);
      assert.equal(run.output().includes(gateway.token), false);
      assert.equal(run.errors().includes(gateway.token), false);
      assert.equal(
        gateway.args.some((arg) => arg.includes(gateway.token)),
        false,
      );
      if (action === "eof") run.child.stdin.end();
      else if (action === "gateway-failure")
        await writeFile(path.join(run.state, "fail-gateway"), "fail");
      else run.child.kill("SIGKILL");
      const [code] = await run.closed;
      if (action === "eof") assert.equal(code, 0);
      if (action === "gateway-failure") assert.notEqual(code, 0);
      const pids = [
          gateway.pid,
          gateway.descendant,
          gateway.supervisor,
          acp.pid,
          acp.descendant,
          acp.supervisor,
        ],
        deadline = Date.now() + 7000;
      while (pids.some((pid) => !absent(pid)) && Date.now() < deadline)
        await delay(25);
      assert.ok(pids.every(absent));
      if (action !== "wrapper-crash")
        assert.equal(
          (await readdir(run.state)).some((name) =>
            name.startsWith(".harnesshub-gateway-"),
          ),
          false,
        );
    },
  );
}
test(
  "OpenClaw bundled refuses pending package lifecycle without launching installation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const run = await setup(t, true);
    const [code] = await run.closed;
    assert.equal(code, 1);
    assert.match(run.errors(), /lifecycle is incomplete/);
    assert.equal(run.output(), "");
    await assert.rejects(readFile(path.join(run.state, "gateway.json")), {
      code: "ENOENT",
    });
  },
);
