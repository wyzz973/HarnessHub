// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSuite, testEnvironment } from "./run-tests.mjs";

test("the test environment keeps system variables and opt-in switches only", () => {
  const sandbox = path.join(os.tmpdir(), "sandbox");
  const env = testEnvironment(
    {
      Path: "/bin",
      SystemRoot: "C:\\Windows",
      LANG: "C.UTF-8",
      HARNESSHUB_MODEL: "developer-model",
      HARNESSHUB_MODEL_API_KEY: "developer-key",
      AGENT_ENGINE: "codex",
      OPENAI_API_KEY: "developer-key",
      GITHUB_PERSONAL_ACCESS_TOKEN: "developer-token",
      NODE_OPTIONS: "--require evil.js",
      npm_config_registry: "https://registry.example",
      HARNESSHUB_TEST_NATIVE_MCP: "1",
      HOME: "/Users/dev",
      UserProfile: "C:\\Users\\dev",
      TMPDIR: "/var/tmp",
    },
    sandbox,
    "/Users/dev",
  );
  assert.deepEqual(Object.keys(env).sort(), [
    "APPDATA",
    "HARNESSHUB_TEST_NATIVE_MCP",
    "HARNESSHUB_TEST_SYSTEM_HOME",
    "HOME",
    "LANG",
    "LOCALAPPDATA",
    "Path",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  assert.equal(env.HOME, path.join(sandbox, "home"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.TMPDIR, path.join(sandbox, "tmp"));
  assert.equal(env.HARNESSHUB_TEST_SYSTEM_HOME, "/Users/dev");
  // A nested run keeps the outer launcher's real home.
  assert.equal(
    testEnvironment({ HARNESSHUB_TEST_SYSTEM_HOME: "/Users/dev" }, sandbox, env.HOME).HARNESSHUB_TEST_SYSTEM_HOME,
    "/Users/dev",
  );
});

async function fixture(t, source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-run-tests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "case.test.mjs"), source);
  return directory;
}

const suite = { files: ["case.test.mjs"], testTimeoutMs: 5_000, deadlineMs: 20_000, stdio: "ignore" };

test("a clean passing file passes and the sandbox is removed", async (t) => {
  const cwd = await fixture(
    t,
    `import test from "node:test";
     import assert from "node:assert/strict";
     import os from "node:os";
     test("isolated", () => {
       assert.equal(process.env.SECRET_FROM_SHELL, undefined);
       assert.ok(os.homedir().includes("hh-test-"));
       assert.ok(os.tmpdir().includes("hh-test-"));
     });`,
  );
  const before = new Set(await readdir(os.tmpdir()));
  const result = await runSuite({ ...suite, cwd, parentEnv: { ...process.env, SECRET_FROM_SHELL: "x" } });
  assert.deepEqual(result, { status: 0, diagnostics: [] });
  const created = (await readdir(os.tmpdir())).filter((name) => name.startsWith("hh-test-") && !before.has(name));
  assert.deepEqual(created, []);
});

test("rejects failing tests, leaked temporary entries, hanging tests and open handles", async (t) => {
  const failing = await fixture(t, `import test from "node:test"; test("fails", () => { throw new Error("x"); });`);
  assert.deepEqual(await runSuite({ ...suite, cwd: failing }), {
    status: 1,
    diagnostics: ["node --test exited with 1"],
  });

  const leaking = await fixture(
    t,
    `import test from "node:test";
     import { mkdtemp } from "node:fs/promises";
     import path from "node:path";
     import os from "node:os";
     test("leaks", async () => { await mkdtemp(path.join(os.tmpdir(), "leaked-")); });`,
  );
  const leak = await runSuite({ ...suite, cwd: leaking });
  assert.equal(leak.status, 1);
  assert.match(leak.diagnostics.join("\n"), /tests left temporary entries behind: leaked-/);

  const hanging = await fixture(
    t,
    `import test from "node:test"; test("hangs", () => new Promise(() => {}));`,
  );
  const timeout = await runSuite({ ...suite, cwd: hanging, testTimeoutMs: 200 });
  assert.equal(timeout.status, 1);
  assert.deepEqual(timeout.diagnostics, ["node --test exited with 1"]);

  const handle = await fixture(
    t,
    `import test from "node:test"; test("passes but keeps a timer", () => { setInterval(() => {}, 1000); });`,
  );
  const started = Date.now();
  const stuck = await runSuite({ ...suite, cwd: handle, deadlineMs: 1_500 });
  assert.equal(stuck.status, 1);
  assert.match(stuck.diagnostics[0], /exceeded its 1500 ms deadline/);
  assert.ok(Date.now() - started < 10_000);
});
