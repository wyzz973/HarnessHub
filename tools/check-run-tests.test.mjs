// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCommandLine, runSuite, testEnvironment } from "./run-tests.mjs";
import inventoryReporter from "./test-inventory-reporter.mjs";

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
      HARNESSHUB_TEST_EXAMPLE: "1",
      HARNESSHUB_TEST_INVENTORY_DIR: "/ci/inventory",
      harnesshub_test_inventory_dir: "/ci/inventory",
      HOME: "/Users/dev",
      UserProfile: "C:\\Users\\dev",
      TMPDIR: "/var/tmp",
      HH_OFFLINE: "0",
    },
    sandbox,
    "/Users/dev",
  );
  assert.deepEqual(Object.keys(env).sort(), [
    "APPDATA",
    "HARNESSHUB_TEST_EXAMPLE",
    "HARNESSHUB_TEST_SYSTEM_HOME",
    "HH_OFFLINE",
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
  // Background catalog refresh is off even when the shell turned it on.
  assert.equal(env.HH_OFFLINE, "1");
  // A nested run keeps the outer launcher's real home.
  assert.equal(
    testEnvironment({ HARNESSHUB_TEST_SYSTEM_HOME: "/Users/dev" }, sandbox, env.HOME).HARNESSHUB_TEST_SYSTEM_HOME,
    "/Users/dev",
  );
});

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-run-tests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, source, name = "case.test.mjs") {
  const directory = await temporary(t);
  await writeFile(path.join(directory, name), source);
  return directory;
}

async function readLines(file) {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

const NESTED = `import test, { describe, it } from "node:test";
test("plain", () => {});
test("skipped", { skip: "not here" }, () => {});
test("planned", { todo: true }, () => {});
test("parent", async (t) => {
  await t.test("child", () => {});
  await t.test("skipped child", (c) => c.skip());
  await t.test("middle", async (m) => { await m.test("leaf", () => {}); });
});
describe("group", () => { it("member", () => {}); });`;

test("writes the test inventory with the suite, file basename, name path and status", async (t) => {
  const cwd = await fixture(t, NESTED);
  const file = path.join(await temporary(t), "out", "unit.jsonl");
  const result = await runSuite({ ...suite, cwd, inventory: { suite: "unit", file } });
  assert.deepEqual(result, { status: 0, diagnostics: [] });
  const entry = (test, status) => ({ suite: "unit", file: "case.test.mjs", test, status });
  assert.deepEqual(await readLines(file), [
    entry(["plain"], "pass"),
    entry(["skipped"], "skip"),
    entry(["planned"], "todo"),
    entry(["parent", "child"], "pass"),
    entry(["parent", "skipped child"], "skip"),
    entry(["parent", "middle", "leaf"], "pass"),
    entry(["parent", "middle"], "pass"),
    entry(["parent"], "pass"),
    entry(["group", "member"], "pass"),
    entry(["group"], "pass"),
  ]);
});

test("a failed run still writes its inventory, with failing tests and unloadable files as failures", async (t) => {
  const cwd = await fixture(t, `import test from "node:test"; test("ok", () => {}); test("broken", () => { throw new Error("x"); });`);
  await writeFile(path.join(cwd, "unloadable.test.mjs"), `import "./missing.mjs";`);
  const file = path.join(await temporary(t), "integration.jsonl");
  await writeFile(file, "stale content\n");
  const result = await runSuite({
    ...suite,
    files: ["case.test.mjs", "unloadable.test.mjs"],
    cwd,
    inventory: { suite: "integration", file },
  });
  assert.deepEqual(result, { status: 1, diagnostics: ["node --test exited with 1"] });
  assert.deepEqual(await readLines(file), [
    { suite: "integration", file: "case.test.mjs", test: ["ok"], status: "pass" },
    { suite: "integration", file: "case.test.mjs", test: ["broken"], status: "fail" },
    { suite: "integration", file: "unloadable.test.mjs", test: ["unloadable.test.mjs"], status: "fail" },
  ]);
});

test("the inventory reporter rejects results that do not follow their test:start", async () => {
  async function collect(events) {
    const lines = [];
    for await (const line of inventoryReporter(events)) lines.push(JSON.parse(line));
    return lines;
  }
  const start = (name, nesting) => ({ type: "test:start", data: { name, nesting, file: "/x/a.test.js" } });
  const pass = (name, nesting, extra = {}) => ({ type: "test:pass", data: { name, nesting, file: "/x/a.test.js", ...extra } });
  assert.deepEqual(await collect([start("a", 0), start("b", 1), pass("b", 1, { todo: "later" }), pass("a", 0)]), [
    { file: "a.test.js", test: ["a", "b"], status: "todo" },
    { file: "a.test.js", test: ["a"], status: "pass" },
  ]);
  await assert.rejects(collect([pass("a", 0)]), /result of "a" arrived out of definition order/);
  await assert.rejects(collect([start("a", 0), start("b", 1), pass("c", 1)]), /out of definition order/);
  await assert.rejects(collect([start("b", 1)]), /started at nesting 1 without its parent/);
});

test("the command line takes --inventory, else HARNESSHUB_TEST_INVENTORY_DIR, and rejects bad arguments", () => {
  assert.deepEqual(parseCommandLine(["unit"], {}), { name: "unit", files: [] });
  assert.deepEqual(parseCommandLine(["unit"], { HARNESSHUB_TEST_INVENTORY_DIR: "" }), { name: "unit", files: [] });
  assert.deepEqual(parseCommandLine(["smoke", "a.test.js"], { HARNESSHUB_TEST_INVENTORY_DIR: "ci" }), {
    name: "smoke",
    files: ["a.test.js"],
    inventory: { suite: "smoke", file: path.resolve("ci", "smoke.jsonl") },
  });
  assert.deepEqual(
    parseCommandLine(["unit", "--inventory", "own.jsonl", "a.test.js"], { HARNESSHUB_TEST_INVENTORY_DIR: "ci" }),
    { name: "unit", files: ["a.test.js"], inventory: { suite: "unit", file: path.resolve("own.jsonl") } },
  );
  assert.throws(() => parseCommandLine(["unit", "--inventory"], {}), /argument missing/);
  assert.throws(() => parseCommandLine(["unit", "--inventory="], {}), /--inventory needs a file/);
  assert.throws(() => parseCommandLine(["unit", "--report", "x"], {}), /Unknown option '--report'/);
  assert.throws(() => parseCommandLine(["toString"], {}), /^Error: usage:/);
  assert.throws(() => parseCommandLine([], {}), /^Error: usage:/);
});

test("the launcher writes <dir>/<suite>.jsonl from HARNESSHUB_TEST_INVENTORY_DIR and keeps the spec output", async (t) => {
  const cwd = await fixture(
    t,
    `import test from "node:test";
     import assert from "node:assert/strict";
     test("cannot see the inventory directory", () => {
       assert.equal(process.env.HARNESSHUB_TEST_INVENTORY_DIR, undefined);
     });`,
  );
  const directory = path.join(await temporary(t), "inventory");
  const launcher = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
  const child = spawn(process.execPath, [launcher, "tooling", path.join(cwd, "case.test.mjs")], {
    env: { ...process.env, HARNESSHUB_TEST_INVENTORY_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => child.once("error", reject).once("exit", resolve));
  assert.equal(code, 0);
  assert.match(stdout, /✔ cannot see the inventory directory/);
  assert.deepEqual(await readdir(directory), ["tooling.jsonl"]);
  assert.deepEqual(await readLines(path.join(directory, "tooling.jsonl")), [
    { suite: "tooling", file: "case.test.mjs", test: ["cannot see the inventory directory"], status: "pass" },
  ]);
});
