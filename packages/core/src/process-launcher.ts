// SPDX-License-Identifier: MIT
/**
 * Starting child processes (OSS-010 F08; 10-engineering sections 1 and 2).
 * runtime's `process/` is the only implementation; each process's composition
 * root (the daemon, the Worker, the command MCP entry) creates it and injects
 * it into the packages that start programs: drivers (CLI engines), secrets
 * (the Keychain and DPAPI helper), store (the Windows ACL helper) and agents
 * (the command MCP server's CLI tools). No other package imports
 * `node:child_process`.
 *
 * Every launched process has an owner: the caller awaits its `exit` (or the
 * result of `run`), and the launcher registers it with the launcher's own
 * owner, which terminates and awaits every process still running when it
 * closes. Processes never get a shell and never open a console window on
 * Windows. They stay in the launching process's process group (for engines
 * and tools, the Worker's, which its host supervises together with F07's
 * reclaim of escaped descendants) or, on Windows, its Job Object; the
 * launcher signals only the process it started.
 *
 * Not every process goes through this interface: acpx starts ACP engines
 * itself, and the launchers in agents' `assets/` start the engine they wrap
 * with cross-spawn. Both run inside the Worker's process group or Job Object.
 */

/** How one standard stream is connected: a pipe for the caller, or nothing. */
export type ProcessStdio = "pipe" | "ignore";

/**
 * The environment of a launched process: exactly these variables, or the
 * launching process's own environment when the caller asks for it with
 * `"inherit"`. Nothing the caller did not pass is inherited, with one platform
 * exception: on Windows, Node's libuv copies a fixed set of system variables
 * from the launching process when they are missing (HOMEDRIVE, HOMEPATH,
 * LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME,
 * USERPROFILE, WINDIR), because many Windows programs cannot start without
 * them. Do not rely on an explicit environment to hide those.
 */
export type ProcessEnvironment = "inherit" | Readonly<Record<string, string>>;

/** What to start and how its lifetime is bounded. */
export interface ProcessLaunch {
  /**
   * Executable path, or a name the operating system resolves on `PATH`.
   * Arguments are passed as an argv array, never through a shell.
   */
  readonly file: string;
  readonly args: readonly string[];
  readonly env: ProcessEnvironment;
  readonly cwd?: string;
  /** stdin, stdout and stderr; all `"pipe"` by default. */
  readonly stdio?: readonly [ProcessStdio, ProcessStdio, ProcessStdio];
  /** Terminates the process when it aborts; the exit then reports `aborted`. */
  readonly signal?: AbortSignal;
  /** Terminates the process after this many milliseconds; the exit then reports `timedOut`. */
  readonly timeoutMs?: number;
  /**
   * Signal that terminates the process on timeout, abort and an exceeded
   * `maxBuffer`; SIGTERM by default. A process still running two seconds
   * later receives SIGKILL, so one that ignores the signal cannot outlive
   * its deadline.
   */
  readonly killSignal?: NodeJS.Signals;
  /**
   * Windows: pass the arguments without quoting them, for a `cmd.exe /d /s /c`
   * command line whose arguments the caller has already quoted. Only allowed
   * when `file` is `cmd.exe`; `launch` throws otherwise.
   */
  readonly windowsVerbatimArguments?: boolean;
}

/**
 * A standard stream of a launched process that reported an error: EPIPE or
 * ECONNRESET on a stdin whose reading end the process closed, or a failed
 * read of its stdout or stderr.
 */
export interface ProcessStreamFailure {
  readonly stream: "stdin" | "stdout" | "stderr";
  readonly error: Error;
}

/** How a launched process ended. */
export interface ProcessExit {
  /** Exit code, or null when a signal ended the process or it never started. */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Why the process could not start, when it did not. */
  readonly error?: Error;
  /** The process was terminated because `timeoutMs` elapsed. */
  readonly timedOut: boolean;
  /** The process was terminated, or never started, because `signal` aborted. */
  readonly aborted: boolean;
  /**
   * The first of the process's standard streams to fail before this outcome
   * settled, if one did. `closed` settles after stdout and stderr have
   * closed, so it reports any failure of theirs; `exit` only one that came
   * before the exit. A write to stdin after `closed` fails only that write.
   */
  readonly streamFailure?: ProcessStreamFailure;
}

/** The writable end of a piped stdin. */
export interface ProcessInput extends NodeJS.WritableStream {
  destroy(error?: Error): unknown;
}

/** The readable end of a piped stdout or stderr; yields Buffers. */
export interface ProcessOutput extends NodeJS.ReadableStream {
  destroy(error?: Error): unknown;
}

/**
 * A started process. Streams are null when not piped or when it never started.
 *
 * The launcher listens for `error` on every stream it hands out, so a failed
 * pipe never becomes an unhandled `error` event that would end the launching
 * process; it is reported as `streamFailure`. The launcher does not act on it:
 * the holder owns the streams, may listen for `error` itself to learn of a
 * failure at once, and decides whether the process must stop. A stdin closed
 * by a process that does not read all its input is often harmless.
 */
export interface LaunchedProcess {
  readonly pid: number | undefined;
  readonly stdin: ProcessInput | null;
  readonly stdout: ProcessOutput | null;
  readonly stderr: ProcessOutput | null;
  /**
   * Settles, never rejects, once the process has exited or failed to start.
   * Its standard streams may still be draining.
   */
  readonly exit: Promise<ProcessExit>;
  /** Settles like `exit`, after the process's standard streams have also closed. */
  readonly closed: Promise<ProcessExit>;
  /** Sends a signal (SIGTERM by default) to the process; ignored once it has exited. */
  kill(signal?: NodeJS.Signals): void;
}

/** A process run to completion with its output collected. */
export interface ProcessRun extends Omit<ProcessLaunch, "stdio"> {
  /** Written to stdin, which is then closed; without it stdin is not connected. */
  readonly input?: string | Uint8Array;
  /**
   * Most bytes kept from stdout and from stderr each. More output terminates
   * the process (as `killSignal` describes) and is reported as `exceeded`.
   */
  readonly maxBuffer: number;
}

/** The outcome of `run`. */
export interface ProcessRunResult extends ProcessExit {
  /**
   * Why the process could not start, or why its output could not be
   * collected: `streamFailure` then names the stdout or stderr that failed,
   * the process was terminated and the output is incomplete whatever its
   * exit.
   */
  readonly error?: Error;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** The stream that exceeded `maxBuffer`, if one did. */
  readonly exceeded?: "stdout" | "stderr";
}

/** Starts child processes on behalf of the packages that may not import `node:child_process`. */
export interface ProcessLauncher {
  /**
   * Starts a process; the caller owns it and awaits `exit` or `closed`. A
   * process whose `signal` has already aborted is not started. Throws what
   * spawning throws synchronously, for example for a Windows batch file
   * started without `cmd.exe`, and throws INVALID_PROCESS_LAUNCH for
   * `windowsVerbatimArguments` with another program; reports failures to
   * start asynchronously in `exit`. Throws once the launcher's owner has
   * closed it. Errors of the process's streams are the holder's to act on
   * and never end the launching process (see `LaunchedProcess`).
   */
  launch(spec: ProcessLaunch): LaunchedProcess;
  /**
   * Runs a process to completion: writes `input`, collects bounded output and
   * settles after the process has exited and its streams have closed. Never
   * rejects; failures to start are reported in `error`. A failed stdout or
   * stderr terminates the process and is reported in `error` and
   * `streamFailure`. A failed stdin (the process closed it before reading all
   * of `input`) terminates the process too, but its exit decides the outcome:
   * a process that exited before it failed may not have needed the rest.
   * Stream errors never end the launching process.
   */
  run(spec: ProcessRun): Promise<ProcessRunResult>;
}
