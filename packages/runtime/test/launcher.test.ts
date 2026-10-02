// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ProcessOutput } from "@harnesshub/core/process-launcher";
import { createProcessLauncher } from "../src/process/launcher.js";

const posix = process.platform !== "win32";
const forever = "setInterval(() => {}, 1000);";
/** A parent that starts a grandchild in its own group, prints its PID, and waits. */
const parentOfGrandchild = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(forever)}], { stdio: "ignore" });
process.stdout.write(String(grandchild.pid) + "\\n");
${forever}`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (alive(pid)) {
    assert.ok(Date.now() < deadline, `process ${pid} is still running`);
    await delay(25);
  }
}

async function firstLine(stream: ProcessOutput | null): Promise<string> {
  assert.ok(stream);
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  throw new Error("stream ended without a line");
}

void test("a timeout terminates the process and is reported", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const started = Date.now();
  const result = await launcher.run({
    file: process.execPath,
    args: ["-e", forever],
    env: "inherit",
    timeoutMs: 200,
    maxBuffer: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 10_000);
});

void test(
  "an abort terminates the whole process group on POSIX",
  { skip: posix ? false : "process groups exist on POSIX only" },
  async (t) => {
    const launcher = createProcessLauncher();
    t.after(() => launcher.close());
    const controller = new AbortController();
    const started = launcher.launch({
      file: process.execPath,
      args: ["-e", parentOfGrandchild],
      env: "inherit",
      stdio: ["ignore", "pipe", "ignore"],
      processGroup: true,
      signal: controller.signal,
    });
    const grandchild = Number(await firstLine(started.stdout));
    assert.ok(Number.isInteger(grandchild) && grandchild > 0);
    assert.ok(alive(grandchild));
    controller.abort();
    const exit = await started.exit;
    assert.equal(exit.aborted, true);
    assert.equal(exit.signal, "SIGTERM");
    await gone(grandchild);
  },
);

void test("output beyond maxBuffer terminates the process and keeps maxBuffer bytes", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const result = await launcher.run({
    file: process.execPath,
    args: ["-e", `process.stdout.write("x".repeat(65536)); ${forever}`],
    env: "inherit",
    maxBuffer: 1024,
  });
  assert.equal(result.exceeded, "stdout");
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.stdout.toString(), "x".repeat(1024));
  assert.notEqual(result.code, 0);
});

void test("no variable is inherited unless inheritance is asked for", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const script =
    "process.stdout.write(JSON.stringify(Object.keys(process.env)))";
  const names = async (env: "inherit" | Record<string, string>) => {
    const result = await launcher.run({
      file: process.execPath,
      args: ["-e", script],
      env,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.code, 0, result.stderr.toString());
    return (JSON.parse(result.stdout.toString()) as string[]).map((name) =>
      name.toUpperCase(),
    );
  };
  // A variable only this process has: inherited on request, never otherwise.
  process.env.HH_LAUNCHER_PARENT_CANARY = "parent";
  t.after(() => {
    delete process.env.HH_LAUNCHER_PARENT_CANARY;
  });
  const inherited = await names("inherit");
  const explicit = await names({ HH_LAUNCHER_ONLY: "1" });
  assert.ok(explicit.includes("HH_LAUNCHER_ONLY"));
  assert.equal(inherited.includes("HH_LAUNCHER_ONLY"), false);
  assert.ok(inherited.includes("HH_LAUNCHER_PARENT_CANARY"));
  assert.equal(explicit.includes("HH_LAUNCHER_PARENT_CANARY"), false);
  if (posix) {
    // The operating system may add variables of its own
    // (__CF_USER_TEXT_ENCODING on macOS), but none is passed on implicitly.
    for (const name of ["PATH", "HOME"]) {
      assert.ok(inherited.includes(name), name);
      assert.equal(explicit.includes(name), false, name);
    }
  } else {
    // libuv copies these Windows system variables from the parent when they
    // are missing (documented on ProcessEnvironment); nothing else appears.
    const libuvRequired = new Set([
      "HOMEDRIVE",
      "HOMEPATH",
      "LOGONSERVER",
      "PATH",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "USERDOMAIN",
      "USERNAME",
      "USERPROFILE",
      "WINDIR",
    ]);
    assert.deepEqual(
      explicit.filter(
        (name) => name !== "HH_LAUNCHER_ONLY" && !libuvRequired.has(name),
      ),
      [],
    );
  }
});

void test("a program that cannot start reports why", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const result = await launcher.run({
    file: "harnesshub-launcher-test-missing-program",
    args: [],
    env: "inherit",
    maxBuffer: 1024,
  });
  assert.equal(result.code, null);
  assert.equal(
    (result.error as (Error & { code?: string }) | undefined)?.code,
    "ENOENT",
  );
});

void test("closing the owner leaves no process behind and refuses new ones", async () => {
  const launcher = createProcessLauncher();
  // The leader ignores SIGTERM, so closing escalates to SIGKILL.
  const started = launcher.launch({
    file: process.execPath,
    args: [
      "-e",
      `process.on("SIGTERM", () => {}); ${posix ? parentOfGrandchild : `process.stdout.write("0\\n"); ${forever}`}`,
    ],
    env: "inherit",
    stdio: ["ignore", "pipe", "ignore"],
    processGroup: true,
  });
  const reported = Number(await firstLine(started.stdout));
  assert.ok(started.pid !== undefined && alive(started.pid));
  await launcher.close();
  const exit = await started.exit;
  assert.equal(exit.code === 0, false);
  assert.equal(alive(started.pid), false);
  if (posix) await gone(reported);
  assert.throws(
    () => launcher.launch({ file: process.execPath, args: [], env: "inherit" }),
    { code: "PROCESS_LAUNCHER_CLOSED" },
  );
});
