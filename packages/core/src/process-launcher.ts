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
 * Windows.
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
  /**
   * POSIX: start the process as the leader of a new process group, so that
   * termination by timeout, abort, `kill` or the owner's close signals the
   * whole group, descendants included. Without it the process stays in the
   * launching process's group (for engines and tools, the Worker's, which
   * its host supervises) and only the process itself is signalled. Windows
   * has no process groups: the process alone is terminated, and the Worker's
   * Job Object contains its descendants.
   */
  readonly processGroup?: boolean;
  /** Terminates the process when it aborts; the exit then reports `aborted`. */
  readonly signal?: AbortSignal;
  /** Terminates the process after this many milliseconds; the exit then reports `timedOut`. */
  readonly timeoutMs?: number;
  /** Signal used for timeout, abort and an exceeded `maxBuffer`; SIGTERM by default. */
  readonly killSignal?: NodeJS.Signals;
  /**
   * Windows: pass the arguments without quoting them, for a `cmd.exe /d /s /c`
   * command line whose arguments the caller has already quoted.
   */
  readonly windowsVerbatimArguments?: boolean;
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
}

/** The writable end of a piped stdin. */
export interface ProcessInput extends NodeJS.WritableStream {
  destroy(error?: Error): unknown;
}

/** The readable end of a piped stdout or stderr; yields Buffers. */
export interface ProcessOutput extends NodeJS.ReadableStream {
  destroy(error?: Error): unknown;
}

/** A started process. Streams are null when not piped or when it never started. */
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
  /**
   * Sends a signal (SIGTERM by default) to the process, or to its group with
   * `processGroup`; ignored once it has exited.
   */
  kill(signal?: NodeJS.Signals): void;
}

/** A process run to completion with its output collected. */
export interface ProcessRun extends Omit<ProcessLaunch, "stdio"> {
  /** Written to stdin, which is then closed; without it stdin is not connected. */
  readonly input?: string | Uint8Array;
  /**
   * Most bytes kept from stdout and from stderr each. More output terminates
   * the process with `killSignal` and is reported as `exceeded`.
   */
  readonly maxBuffer: number;
}

/** The outcome of `run`. */
export interface ProcessRunResult extends ProcessExit {
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
   * started without `cmd.exe`; reports failures to start asynchronously in
   * `exit`. Throws once the launcher's owner has closed it.
   */
  launch(spec: ProcessLaunch): LaunchedProcess;
  /**
   * Runs a process to completion: writes `input`, collects bounded output and
   * settles after the process has exited and its streams have closed. Never
   * rejects; failures to start are reported in `error`.
   */
  run(spec: ProcessRun): Promise<ProcessRunResult>;
}
