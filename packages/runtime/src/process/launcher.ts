// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { HubError } from "@harnesshub/core/errors";
import type {
  LaunchedProcess,
  ProcessExit,
  ProcessInput,
  ProcessLaunch,
  ProcessLauncher,
  ProcessOutput,
  ProcessRun,
  ProcessRunResult,
} from "@harnesshub/core/process-launcher";

/** How long `close` waits after its first signal before it sends SIGKILL. */
const CLOSE_GRACE_MS = 2_000;

/** A launcher together with the entry point of its owner. */
export interface OwnedProcessLauncher extends ProcessLauncher {
  /**
   * Terminates every process this launcher started that has not exited
   * (its group, for `processGroup`): SIGTERM, then SIGKILL after a grace
   * period. Settles once they have all exited; later `launch` calls throw
   * PROCESS_LAUNCHER_CLOSED. Idempotent.
   */
  close(): Promise<void>;
}

function closedError(): HubError {
  return new HubError(
    "PROCESS_LAUNCHER_CLOSED",
    "The process launcher's owner has stopped",
    500,
  );
}

/** A handle for a process that was never started. */
function notStarted(outcome: ProcessExit): LaunchedProcess {
  const settled = Promise.resolve(outcome);
  return {
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    exit: settled,
    closed: settled,
    kill: () => undefined,
  };
}

class NodeProcessLauncher implements OwnedProcessLauncher {
  private readonly live = new Set<{
    exit: Promise<ProcessExit>;
    kill: (signal: NodeJS.Signals) => void;
  }>();
  private closing: Promise<void> | undefined;

  launch(spec: ProcessLaunch): LaunchedProcess {
    if (this.closing) throw closedError();
    if (spec.signal?.aborted)
      return notStarted({
        code: null,
        signal: null,
        timedOut: false,
        aborted: true,
      });
    const group = spec.processGroup === true && process.platform !== "win32";
    const killSignal = spec.killSignal ?? "SIGTERM";
    // Throws synchronously for arguments spawn rejects (for example EINVAL
    // for a Windows batch file without cmd.exe); nothing is registered then.
    const child = spawn(spec.file, [...spec.args], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: spec.env === "inherit" ? process.env : { ...spec.env },
      stdio: [...(spec.stdio ?? ["pipe", "pipe", "pipe"])],
      shell: false,
      windowsHide: true,
      detached: group,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
    });
    let exited = false;
    let timedOut = false;
    let aborted = false;
    let failure: Error | undefined;
    const exit = Promise.withResolvers<ProcessExit>();
    const closed = Promise.withResolvers<ProcessExit>();
    const outcome = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): ProcessExit => ({
      code,
      signal,
      ...(failure ? { error: failure } : {}),
      timedOut,
      aborted,
    });
    const kill = (signal: NodeJS.Signals = "SIGTERM") => {
      if (exited || child.pid === undefined) return;
      if (group) {
        // The leader has not been reaped, so its PID still names this group.
        // A group that is gone (ESRCH) or not entirely signallable (EPERM)
        // falls back to the leader itself; its exit reports the outcome.
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the leader.
        }
      }
      child.kill(signal);
    };
    const timer =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            kill(killSignal);
          }, spec.timeoutMs);
    const abort = () => {
      aborted = true;
      kill(killSignal);
    };
    spec.signal?.addEventListener("abort", abort, { once: true });
    const settle = (result: ProcessExit) => {
      exited = true;
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abort);
      exit.resolve(result);
    };
    // Kept for the process's lifetime: after a successful start, errors (a
    // failed kill) are followed by exit and must not go unhandled.
    child.on("error", (error) => {
      if (child.pid !== undefined || exited) return;
      failure = error;
      settle(outcome(null, null));
      closed.resolve(outcome(null, null));
    });
    child.once("exit", (code, signal) => settle(outcome(code, signal)));
    child.once("close", (code, signal) =>
      closed.resolve(
        failure ? outcome(null, null) : outcome(code ?? null, signal ?? null),
      ),
    );
    const entry = { exit: exit.promise, kill };
    this.live.add(entry);
    void exit.promise.then(() => this.live.delete(entry));
    return {
      pid: child.pid,
      stdin: child.stdin as ProcessInput | null,
      stdout: child.stdout as ProcessOutput | null,
      stderr: child.stderr as ProcessOutput | null,
      exit: exit.promise,
      closed: closed.promise,
      kill,
    };
  }

  async run(spec: ProcessRun): Promise<ProcessRunResult> {
    const { input, maxBuffer, ...launch } = spec;
    const killSignal = spec.killSignal ?? "SIGTERM";
    let started: LaunchedProcess;
    try {
      started = this.launch({
        ...launch,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return {
        code: null,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
        aborted: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    let exceeded: "stdout" | "stderr" | undefined;
    const collect = (
      stream: ProcessOutput | null,
      name: "stdout" | "stderr",
    ) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream?.on("data", (chunk: Buffer) => {
        if (exceeded) return;
        if (size + chunk.length > maxBuffer) {
          chunks.push(chunk.subarray(0, maxBuffer - size));
          size = maxBuffer;
          exceeded = name;
          started.kill(killSignal);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      return chunks;
    };
    const stdout = collect(started.stdout, "stdout");
    const stderr = collect(started.stderr, "stderr");
    if (started.stdin && input !== undefined) {
      // A closed pipe ends the process; its exit decides the outcome.
      started.stdin.on("error", () => started.kill(killSignal));
      started.stdin.end(input);
    }
    const result = await started.closed;
    return {
      ...result,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      ...(exceeded ? { exceeded } : {}),
    };
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const live = [...this.live];
      for (const entry of live) entry.kill("SIGTERM");
      const escalation = setTimeout(() => {
        for (const entry of live) entry.kill("SIGKILL");
      }, CLOSE_GRACE_MS);
      try {
        await Promise.all(live.map((entry) => entry.exit));
      } finally {
        clearTimeout(escalation);
      }
    })();
    return this.closing;
  }
}

/**
 * A new launcher with its own owner: whoever calls `close` (a test, or an
 * entry point that keeps processes apart from the shared launcher).
 */
export function createProcessLauncher(): OwnedProcessLauncher {
  return new NodeProcessLauncher();
}

let shared: OwnedProcessLauncher | undefined;

/**
 * The launcher of this process, created on first use. Each composition root
 * (the daemon's `startHub`, the Worker, the command MCP entry, the Tool Pack
 * command) injects it into the packages it composes; the process entry that
 * stops the process closes it.
 */
export function sharedProcessLauncher(): OwnedProcessLauncher {
  return (shared ??= createProcessLauncher());
}
