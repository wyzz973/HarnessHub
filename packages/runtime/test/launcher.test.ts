// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  ProcessOutput,
  ProcessStreamFailure,
} from "@harnesshub/core/process-launcher";
import { createProcessLauncher } from "../src/process/launcher.js";
import { failPipes } from "./pipe-failure.js";

const posix = process.platform !== "win32";
const forever = "setInterval(() => {}, 1000);";
/** Ignores SIGTERM (reporting each on stdout), says it is ready, and waits. */
const stubborn = `process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); ${forever}`;

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

/** Checks a reported stream failure: the injected read failure of `stream`. */
function failedRead(
  failure: ProcessStreamFailure | undefined,
  stream: ProcessStreamFailure["stream"],
): void {
  assert.ok(failure, "a stream failure is reported");
  assert.equal(failure.stream, stream);
  assert.equal(
    (failure.error as NodeJS.ErrnoException).code,
    "ECONNRESET",
    failure.error.message,
  );
}

/** Collects a stream's text; `line(text)` settles once that line was seen. */
function lines(stream: ProcessOutput | null) {
  assert.ok(stream);
  let text = "";
  const waiting = new Map<string, () => void>();
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    for (const [expected, resolve] of waiting)
      if (text.split("\n").includes(expected)) resolve();
  });
  return {
    text: () => text,
    line: (expected: string) =>
      new Promise<void>((resolve) => {
        if (text.split("\n").includes(expected)) resolve();
        else waiting.set(expected, resolve);
      }),
  };
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

void test("an abort terminates the process and is reported", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const controller = new AbortController();
  const started = launcher.launch({
    file: process.execPath,
    args: ["-e", `process.stdout.write("ready\\n"); ${forever}`],
    env: "inherit",
    stdio: ["ignore", "pipe", "ignore"],
    signal: controller.signal,
  });
  await lines(started.stdout).line("ready");
  controller.abort();
  const exit = await started.exit;
  assert.equal(exit.aborted, true);
  assert.equal(exit.timedOut, false);
  assert.notEqual(exit.code, 0);
  if (posix) assert.equal(exit.signal, "SIGTERM");
  // An abort before the start starts nothing.
  const skipped = launcher.launch({
    file: process.execPath,
    args: ["-e", forever],
    env: "inherit",
    signal: controller.signal,
  });
  assert.equal(skipped.pid, undefined);
  assert.equal((await skipped.exit).aborted, true);
});

void test(
  "a timeout ends a process that ignores SIGTERM with SIGKILL after a grace period",
  { timeout: 20_000 },
  async (t) => {
    const launcher = createProcessLauncher();
    t.after(() => launcher.close());
    const started = Date.now();
    const child = launcher.launch({
      file: process.execPath,
      args: ["-e", stubborn],
      env: "inherit",
      stdio: ["ignore", "pipe", "ignore"],
      timeoutMs: 2_500,
    });
    const output = lines(child.stdout);
    await output.line("ready");
    const exit = await child.exit;
    const elapsed = Date.now() - started;
    assert.equal(exit.timedOut, true);
    assert.notEqual(exit.code, 0);
    assert.ok(elapsed < 10_000, `${elapsed} ms`);
    if (posix) {
      // SIGTERM arrived and was ignored; SIGKILL ended it two seconds later.
      await output.line("term");
      assert.equal(exit.signal, "SIGKILL");
      assert.ok(elapsed >= 4_000, `${elapsed} ms`);
    }
  },
);

void test("unquoted Windows arguments are only passed to cmd.exe", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const spec = {
    file: process.execPath,
    args: ["-e", "0"],
    env: "inherit" as const,
    windowsVerbatimArguments: true,
  };
  assert.throws(() => launcher.launch(spec), {
    code: "INVALID_PROCESS_LAUNCH",
  });
  const result = await launcher.run({ ...spec, maxBuffer: 1024 });
  assert.equal(
    (result.error as (Error & { code?: string }) | undefined)?.code,
    "INVALID_PROCESS_LAUNCH",
  );
});

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
  // It ignores SIGTERM, so closing escalates to SIGKILL.
  const started = launcher.launch({
    file: process.execPath,
    args: ["-e", stubborn],
    env: "inherit",
    stdio: ["ignore", "pipe", "ignore"],
  });
  await lines(started.stdout).line("ready");
  assert.ok(started.pid !== undefined && alive(started.pid));
  await launcher.close();
  const exit = await started.exit;
  assert.notEqual(exit.code, 0);
  if (posix) assert.equal(exit.signal, "SIGKILL");
  assert.equal(alive(started.pid), false);
  assert.throws(
    () => launcher.launch({ file: process.execPath, args: [], env: "inherit" }),
    { code: "PROCESS_LAUNCHER_CLOSED" },
  );
});

void test("a run whose output fails terminates the process and fails, never ending this process", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const marker = randomUUID();
  const failed = failPipes(t, marker, ["stdout"]);
  const result = await launcher.run({
    file: process.execPath,
    args: ["-e", `${forever} // ${marker}`],
    env: "inherit",
    maxBuffer: 1024,
  });
  await failed;
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  if (posix) assert.equal(result.signal, "SIGTERM");
  assert.equal(
    (result.error as (Error & { code?: string }) | undefined)?.code,
    "PROCESS_OUTPUT_FAILED",
  );
  failedRead(result.streamFailure, "stdout");
});

void test("a run whose stderr fails after a clean exit still fails: its output is incomplete", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const marker = randomUUID();
  const failed = failPipes(t, marker, ["stderr"], "exit");
  const result = await launcher.run({
    file: process.execPath,
    args: ["-e", `process.stdout.write("done") // ${marker}`],
    env: "inherit",
    maxBuffer: 1024,
  });
  await failed;
  assert.equal(result.code, 0);
  assert.equal(
    (result.error as (Error & { code?: string }) | undefined)?.code,
    "PROCESS_OUTPUT_FAILED",
  );
  failedRead(result.streamFailure, "stderr");
});

void test("a launched process's failed streams are its holder's: reported, never ending this process, and the process goes on", async (t) => {
  const launcher = createProcessLauncher();
  t.after(() => launcher.close());
  const marker = randomUUID();
  const failed = failPipes(t, marker, ["stdin", "stdout", "stderr"]);
  // The holder listens on none of the streams.
  const child = launcher.launch({
    file: process.execPath,
    args: ["-e", `${forever} // ${marker}`],
    env: "inherit",
  });
  await failed;
  assert.ok(
    child.pid !== undefined && alive(child.pid),
    "the launcher left it running",
  );
  child.kill();
  const closed = await child.closed;
  assert.equal(closed.error, undefined);
  failedRead(closed.streamFailure, "stdin");
  failedRead((await child.exit).streamFailure, "stdin");
});
