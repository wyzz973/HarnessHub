// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Command line of a live process, or undefined when it is gone or unreadable. */
async function commandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } =
      process.platform === "win32"
        ? await run(
            path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { windowsHide: true, timeout: 20_000 },
          )
        : await run("ps", ["-o", "command=", "-p", String(pid)]);
    const text = stdout.trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Assert that the process that ran `marker` (for example a fixture file name)
 * under `pid` has exited.
 *
 * `process.kill(pid, 0)` alone cannot tell: Windows reuses PIDs within
 * seconds, so a live process with the PID may be unrelated. When one exists,
 * its command line decides; the assertion fails only if it still runs
 * `marker`, and the message names that command line.
 */
export async function assertExited(pid: number, marker: string): Promise<void> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }
  const line = await commandLine(pid);
  assert.ok(
    line === undefined || !line.includes(marker),
    `process ${pid} still runs ${marker}: ${line ?? ""}`,
  );
}
