// SPDX-License-Identifier: MIT
import { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { TestContext } from "node:test";

/** A failed read, as a broken pipe reports it. */
export function readFailure(): NodeJS.ErrnoException {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

/**
 * Fails standard streams of the next child process this process starts with
 * an argument containing `marker`, as a broken pipe would: each reports
 * `error` and closes. Node announces every child it creates on the
 * `child_process` diagnostics channel, so the code under test needs no seam.
 * By default the streams fail on the next tick, after the code that started
 * the child has attached its listeners and before any output is read, and
 * ahead of the child's own `error` when it could not start; with
 * `at: "exit"`, once the child has exited. Settles once they have failed.
 */
export function failPipes(
  t: TestContext,
  marker: string,
  streams: readonly ("stdin" | "stdout" | "stderr")[],
  at: "start" | "exit" = "start",
): Promise<void> {
  const failed = Promise.withResolvers<void>();
  const listener = (message: unknown) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("process" in message) ||
      !(message.process instanceof ChildProcess)
    )
      return;
    const child = message.process;
    // The arguments are set once the creating call has run.
    process.nextTick(() => {
      if (!child.spawnargs.some((argument) => argument.includes(marker)))
        return;
      unsubscribe("child_process", listener);
      const fail = () => {
        for (const name of streams) {
          const stream = child[name];
          if (!stream) throw new Error(`The child has no piped ${name}`);
          // Reported at once rather than on the next tick, as destroy would.
          stream.emit("error", readFailure());
          stream.destroy();
        }
        failed.resolve();
      };
      if (at === "exit") child.once("exit", fail);
      else fail();
    });
  };
  subscribe("child_process", listener);
  t.after(() => unsubscribe("child_process", listener));
  return failed.promise;
}
