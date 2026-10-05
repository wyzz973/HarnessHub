// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import path from "node:path";
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
  ProcessStreamFailure,
} from "@harnesshub/core/process-launcher";

/**
 * How long a process may take to exit after its first termination signal
 * (timeout, abort, exceeded `maxBuffer`, or the owner's close) before it
 * receives SIGKILL.
 */
const KILL_GRACE_MS = 2_000;

/** A launcher together with the entry point of its owner. */
export interface OwnedProcessLauncher extends ProcessLauncher {
  /**
   * Terminates every process this launcher started that has not exited:
   * SIGTERM, then SIGKILL after a grace period. Settles once they have all
   * exited; later `launch` calls throw PROCESS_LAUNCHER_CLOSED. Idempotent.
   */
  close(): Promise<void>;
}

/** The `error` of a run whose stdout or stderr failed. */
function outputFailed(failure: ProcessStreamFailure): HubError {
  const error = new HubError(
    "PROCESS_OUTPUT_FAILED",
    `The process's ${failure.stream} could not be read to its end`,
    500,
  );
  error.cause = failure.error;
  return error;
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

/** A started process and its termination: the kill signal, then SIGKILL. */
interface Started {
  readonly handle: LaunchedProcess;
  readonly terminate: () => void;
}

class NodeProcessLauncher implements OwnedProcessLauncher {
  private readonly live = new Set<{
    exit: Promise<ProcessExit>;
    kill: (signal: NodeJS.Signals) => void;
  }>();
  private closing: Promise<void> | undefined;

  launch(spec: ProcessLaunch): LaunchedProcess {
    return this.start(spec).handle;
  }

  private start(spec: ProcessLaunch): Started {
    if (this.closing) throw closedError();
    if (
      spec.windowsVerbatimArguments === true &&
      path.win32.basename(spec.file).toLowerCase() !== "cmd.exe"
    )
      throw new HubError(
        "INVALID_PROCESS_LAUNCH",
        "Unquoted arguments are only passed to cmd.exe",
        500,
      );
    if (spec.signal?.aborted)
      return {
        handle: notStarted({
          code: null,
          signal: null,
          timedOut: false,
          aborted: true,
        }),
        terminate: () => undefined,
      };
    const killSignal = spec.killSignal ?? "SIGTERM";
    // Throws synchronously for arguments spawn rejects (for example EINVAL
    // for a Windows batch file without cmd.exe); nothing is registered then.
    const child = spawn(spec.file, [...spec.args], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: spec.env === "inherit" ? process.env : { ...spec.env },
      stdio: [...(spec.stdio ?? ["pipe", "pipe", "pipe"])],
      shell: false,
      windowsHide: true,
      detached: false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
    });
    let exited = false;
    let timedOut = false;
    let aborted = false;
    let failure: Error | undefined;
    let streamFailure: ProcessStreamFailure | undefined;
    let escalation: NodeJS.Timeout | undefined;
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
      ...(streamFailure ? { streamFailure } : {}),
    });
    const kill = (signal: NodeJS.Signals = "SIGTERM") => {
      if (exited || child.pid === undefined) return;
      child.kill(signal);
    };
    // A process that ignores the kill signal must not outlive its deadline.
    const terminate = () => {
      kill(killSignal);
      if (killSignal !== "SIGKILL" && !exited && escalation === undefined)
        escalation = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, spec.timeoutMs);
    const abort = () => {
      aborted = true;
      terminate();
    };
    spec.signal?.addEventListener("abort", abort, { once: true });
    const settle = (result: ProcessExit) => {
      exited = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
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
    // A failed pipe reports 'error' on its stream (EPIPE on a stdin the
    // process closed, a failed read), which unheard would end this process.
    // The holder decides what it means; the outcome reports the first.
    for (const [stream, name] of [
      [child.stdin, "stdin"],
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const)
      stream?.on("error", (error) => {
        streamFailure ??= { stream: name, error };
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
      handle: {
        pid: child.pid,
        stdin: child.stdin as ProcessInput | null,
        stdout: child.stdout as ProcessOutput | null,
        stderr: child.stderr as ProcessOutput | null,
        exit: exit.promise,
        closed: closed.promise,
        kill,
      },
      terminate,
    };
  }

  async run(spec: ProcessRun): Promise<ProcessRunResult> {
    const { input, maxBuffer, ...launch } = spec;
    let started: Started;
    try {
      started = this.start({
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
    const { handle, terminate } = started;
    let exceeded: "stdout" | "stderr" | undefined;
    let unread: ProcessStreamFailure | undefined;
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
          terminate();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      // The output is incomplete: the run fails whatever the exit.
      stream?.on("error", (error) => {
        unread ??= { stream: name, error };
        terminate();
      });
      return chunks;
    };
    const stdout = collect(handle.stdout, "stdout");
    const stderr = collect(handle.stderr, "stderr");
    if (handle.stdin && input !== undefined) {
      // A closed pipe ends the process; its exit decides the outcome.
      handle.stdin.on("error", terminate);
      handle.stdin.end(input);
    }
    const result = await handle.closed;
    return {
      ...result,
      // A failed output decides the run, even after a failed stdin.
      ...(unread && !result.error
        ? { error: outputFailed(unread), streamFailure: unread }
        : {}),
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
      }, KILL_GRACE_MS);
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
