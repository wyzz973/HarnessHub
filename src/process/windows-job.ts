import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CleanupStatus } from "../domain/types.js";

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL("../../native/harnesshub-job.exe", import.meta.url),
);
const cleanupTimeoutMs = 5_000;

/** The Job owns descendants before any Run is sent; helper death closes its sole kill-on-close handle. */
export interface WindowsJob {
  ready: Promise<void>;
  exited: Promise<boolean>;
  close(): Promise<CleanupStatus>;
}

/** Attach only to a newly forked idle Worker; callers must await ready before sending executable work. */
export function superviseWindowsWorker(
  worker: ChildProcess,
  token: string,
): WindowsJob {
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => undefined);
  const exited = Promise.withResolvers<boolean>();
  const child = spawn(
    helper,
    ["attach", String(process.pid), String(worker.pid), token],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let empty = false;
  let assigned = false;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "ready") {
        assigned = true;
        ready.resolve();
      }
      if (line === "empty") empty = true;
    }
  });
  child.once("error", (error) => {
    ready.reject(error);
    if (child.pid === undefined) exited.resolve(false);
  });
  child.once("close", (code) => {
    ready.reject(new Error("Windows Job supervisor exited before assignment"));
    exited.resolve(code === 0 && empty);
  });
  return {
    ready: ready.promise,
    exited: exited.promise,
    close: async () => {
      // A timeout never authorizes proceeding without a Job. CloseHandle on helper
      // termination kills any processes already assigned, including on handshake failure.
      const cleanup = await closeWindowsJob(token);
      if (
        !assigned &&
        worker.pid !== undefined &&
        worker.exitCode === null &&
        worker.signalCode === null
      )
        worker.kill("SIGKILL");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const confirmed = await Promise.race([
          // The named Job query and closed kill-on-close handle establish
          // descendant absence even when an idle Worker exits before attachment.
          exited.promise.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => {
              child.kill("SIGKILL");
              resolve(false);
            }, cleanupTimeoutMs + 1_000);
          }),
        ]);
        return cleanup === "confirmed" && confirmed
          ? "confirmed"
          : "unconfirmed";
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Named Job identity, never a recovered PID, authorizes Windows descendant termination. */
export async function closeWindowsJob(token: string): Promise<CleanupStatus> {
  try {
    const result = await execute(
      helper,
      ["close", token, String(cleanupTimeoutMs)],
      {
        timeout: cleanupTimeoutMs + 1_000,
        maxBuffer: 16_384,
        windowsHide: true,
      },
    );
    return result.stderr.length === 0 ? "confirmed" : "failed";
  } catch {
    return "failed";
  }
}
