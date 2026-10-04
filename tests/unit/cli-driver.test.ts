// SPDX-License-Identifier: MIT
/**
 * The CLI driver's input: an engine that closes its stdin before taking the
 * Run's input (it exited, or does not read stdin) only ends the writing; its
 * output is kept and its exit decides the outcome. A write error that is not
 * a closed pipe still fails the Run. Each case is deterministic: the input
 * cannot fit in any pipe buffer, or the stdin is destroyed or broken by a
 * wrapping launcher before the driver writes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { TestContext } from "node:test";
import { CliDriver } from "@harnesshub/drivers/cli/driver";
import type { DriverChannel } from "@harnesshub/drivers/driver";
import type { ExecutionSpec } from "@harnesshub/core/ports";
import type {
  LaunchedProcess,
  ProcessLauncher,
} from "@harnesshub/core/process-launcher";
import type { DriverResult, RunId, SessionId } from "@harnesshub/core/types";
import { createProcessLauncher } from "@harnesshub/runtime/process/launcher";

/** More than any pipe buffer holds: a writer waits for a reader that never comes. */
const LARGE = "x".repeat(4 * 1024 * 1024);

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "harnesshub-cli-driver-"));
  const launcher = createProcessLauncher();
  t.after(async () => {
    await launcher.close();
    await rm(directory, { recursive: true, force: true });
  });
  /** Run `script` as the engine with `text` as the input; its result and stdout. */
  const run = async (
    script: string,
    text: string,
    options: {
      inputMode?: "stdin" | "argv";
      wrap?: (child: LaunchedProcess) => LaunchedProcess;
    } = {},
  ): Promise<{ result: DriverResult; output: string }> => {
    const wrapped: ProcessLauncher = {
      launch: (spec) => {
        const child = launcher.launch(spec);
        return options.wrap ? options.wrap(child) : child;
      },
      run: (spec) => launcher.run(spec),
    };
    const driver = new CliDriver(wrapped);
    let output = "";
    const channel: DriverChannel = {
      emit: async (payload) => {
        if (
          payload.type === "event" &&
          payload.event.type === "message.delta" &&
          typeof payload.event.data.text === "string"
        )
          output += payload.event.data.text;
      },
      permission: () => Promise.reject(new Error("no permissions")),
    };
    const spec: ExecutionSpec = {
      sessionId: "cli-driver" as SessionId,
      runId: "run-cli-driver" as RunId,
      generation: 1,
      cwd: directory,
      stateDir: directory,
      input: { text, timeoutMs: 10_000 },
      profile: {
        id: "cli-driver",
        revision: "1",
        enabled: true,
        driver: "cli",
        command: [process.execPath, "-e", script],
        cli: {
          inputMode: options.inputMode ?? "stdin",
          maxOutputBytes: 1024 * 1024,
        },
        capabilities: { permissions: false, resume: false, images: false },
        maxConcurrency: 1,
      },
    };
    const deadline = AbortSignal.timeout(8_000);
    const result = await Promise.race([
      driver.execute(spec, channel, new AbortController().signal),
      new Promise<never>((_, reject) =>
        deadline.addEventListener("abort", () =>
          reject(new Error("the driver did not settle in 8 s")),
        ),
      ),
    ]);
    await driver.close();
    return { result, output };
  };
  return { run };
}

void test("an engine that never reads its stdin and exits at once keeps its output; its exit decides", async (t) => {
  const { run } = await setup(t);
  const done = await run("process.stdout.write('done')", LARGE);
  assert.deepEqual(done.result, {
    status: "completed",
    stopReason: "process_exit",
    output: "done",
  });
  assert.equal(done.output, "done");
  // The same closed pipe with a non-zero exit is the exit's failure.
  const failing = await run(
    "process.stdout.write('half'); process.exitCode = 3",
    LARGE,
  );
  assert.equal(failing.result.status, "failed");
  assert.equal(failing.result.error?.code, "CLI_EXIT_NONZERO");
  assert.equal(failing.output, "half");
});

void test("a stdin destroyed before the driver writes (the engine gone) settles the input instead of hanging", async (t) => {
  const { run } = await setup(t);
  for (const inputMode of ["stdin", "argv"] as const) {
    const done = await run("process.stdout.write('done')", "hello", {
      inputMode,
      wrap: (child) => {
        child.stdin?.destroy();
        return child;
      },
    });
    assert.equal(done.result.status, "completed", inputMode);
    assert.equal(done.output, "done", inputMode);
  }
});

void test("a real input failure is a failure: an engine that needs its input and gets none, and a write error of a pipe still open", async (t) => {
  const { run } = await setup(t);
  // argv mode sends no input: this engine needs some and says so by its exit.
  const empty = await run(
    "let n = 0; process.stdin.on('data', (c) => (n += c.length)); process.stdin.on('end', () => { process.exitCode = n ? 0 : 4; });",
    "ignored",
    { inputMode: "argv" },
  );
  assert.equal(empty.result.status, "failed");
  assert.equal(empty.result.error?.code, "CLI_EXIT_NONZERO");
  // A write that fails for another reason than a closed pipe.
  const broken = await run(
    "process.stdin.resume(); setTimeout(() => process.stdout.write('late'), 2000);",
    "hello",
    {
      wrap: (child) => {
        child.stdin?.end();
        const io = () => Object.assign(new Error("i/o error"), { code: "EIO" });
        const stdin = new Writable({
          write: (_chunk, _encoding, callback) => callback(io()),
          final: (callback) => callback(io()),
        });
        return { ...child, stdin, kill: (signal) => child.kill(signal) };
      },
    },
  );
  assert.equal(broken.result.status, "failed");
  assert.equal(broken.result.error?.code, "CLI_INPUT_ERROR");
  assert.equal(broken.output, "", "the engine was stopped before it wrote");
});
