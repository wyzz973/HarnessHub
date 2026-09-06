import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HubError } from "../domain/errors.js";

/** One bounded collection owns this native helper and must await close in finally. */
export class WindowsFileSession {
  private readonly child;
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
    this.child = spawn(
      fileURLToPath(
        new URL("../../native/harnesshub-acl.exe", import.meta.url),
      ),
      ["--session"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    this.child.stdout.on("data", (bytes: Buffer) => {
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
    this.child.stdin.on("error", () => this.child.kill());
    // Only a fixed failure marker is emitted; response and exit own the outcome.
    this.child.stderr.resume();
    this.closed = new Promise((resolve) => {
      const reject = () => {
        this.ended = true;
        const pending = this.pending;
        this.pending = undefined;
        pending?.reject(this.failure(pending.code));
      };
      this.child.once("error", reject);
      this.child.once("close", () => {
        reject();
        resolve();
      });
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
    this.child.stdin.write(JSON.stringify(value) + "\n");
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
    this.child.stdin.end();
    await this.closed;
    this.signal.removeEventListener("abort", this.abort);
  }
}
