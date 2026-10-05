// SPDX-License-Identifier: MIT
import { HubError } from "@harnesshub/core/errors";
import type {
  LaunchedProcess,
  ProcessInput,
} from "@harnesshub/core/process-launcher";
import { aclHelperPath } from "./native-helper.js";
import { platformLauncher } from "./process-launcher.js";

/** One bounded collection owns this native helper and must await close in finally. */
export class WindowsFileSession {
  private readonly child: LaunchedProcess;
  private readonly stdin: ProcessInput;
  private readonly closed: Promise<void>;
  private ended = false;
  private pending:
    | {
        expected: string;
        code: string;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private readonly abort = () => {
    this.child.kill();
  };

  private constructor(private readonly signal: AbortSignal) {
    this.child = platformLauncher().launch({
      file: aclHelperPath(),
      args: ["--session"],
      env: "inherit",
    });
    const { stdin, stdout, stderr } = this.child;
    if (!stdin || !stdout || !stderr)
      throw new Error("The ACL helper session needs piped standard streams");
    this.stdin = stdin;
    let output = "";
    stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString("ascii");
      if (output.length > 1024) this.child.kill();
      for (let newline; (newline = output.indexOf("\n")) >= 0;) {
        const line = output.slice(0, newline).replace(/\r$/, "");
        output = output.slice(newline + 1);
        const pending = this.pending;
        this.pending = undefined;
        if (pending?.expected === line) pending.resolve();
        else {
          pending?.reject(this.failure(pending.code));
          this.child.kill();
        }
      }
    });
    // A failed pipe ends the session: its exit then fails the pending request.
    stdin.on("error", () => this.child.kill());
    stdout.on("error", () => this.child.kill());
    // Only a fixed failure marker is emitted; response and exit own the outcome.
    stderr.resume();
    // Settles after the helper exited and its streams closed, or failed to start.
    this.closed = this.child.closed.then(() => {
      this.ended = true;
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(this.failure(pending.code));
    });
    signal.addEventListener("abort", this.abort, { once: true });
  }

  /** Starts one native helper; failures and cancellation wait for process cleanup. */
  static async create(signal: AbortSignal): Promise<WindowsFileSession> {
    signal.throwIfAborted();
    const session = new WindowsFileSession(signal);
    const startup = setTimeout(session.abort, 10_000);
    try {
      await session.response("ready", "INVALID_PRIVATE_PATH");
      signal.throwIfAborted();
      return session;
    } catch (error) {
      await session.close();
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(startup);
    }
  }

  private failure(code: string): HubError {
    return new HubError(
      code,
      code === "ARTIFACT_CHANGED"
        ? "Output could not be held stable against Windows writers"
        : "Windows private filesystem access could not be verified",
      code === "ARTIFACT_CHANGED" ? 409 : 403,
    );
  }

  private response(expected: string, code: string): Promise<void> {
    if (this.ended) return Promise.reject(this.failure(code));
    if (this.pending)
      throw new Error("Windows filesystem requests must be serial");
    return new Promise((resolve, reject) => {
      this.pending = { expected, code, resolve, reject };
    });
  }

  private async request(
    value: { kind: string; paths?: string[]; protect?: boolean },
    expected: string,
    code: string,
  ): Promise<void> {
    this.signal.throwIfAborted();
    const response = this.response(expected, code);
    this.stdin.write(JSON.stringify(value) + "\n");
    await response;
    this.signal.throwIfAborted();
  }

  /** Applies and verifies private DACLs without restarting the native helper. */
  ensurePrivateDirectories(paths: string[]): Promise<void> {
    return this.request(
      { kind: "directory", paths, protect: true },
      "private",
      "INVALID_PRIVATE_PATH",
    );
  }

  /** Denies write/delete sharing throughout the callback, releasing before return. */
  async withReadLock<T>(file: string, read: () => Promise<T>): Promise<T> {
    await this.request(
      { kind: "read-lock", paths: [file] },
      "locked",
      "ARTIFACT_CHANGED",
    );
    try {
      const value = await read();
      this.signal.throwIfAborted();
      if (this.ended) throw this.failure("ARTIFACT_CHANGED");
      return value;
    } finally {
      if (!this.signal.aborted && !this.ended)
        await this.request({ kind: "release" }, "released", "ARTIFACT_CHANGED");
    }
  }

  /** EOF releases every native file handle; waits for actual exit on every path. */
  async close(): Promise<void> {
    this.stdin.end();
    await this.closed;
    this.signal.removeEventListener("abort", this.abort);
  }
}
