import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Ajv } from "ajv";
import { HubError } from "../domain/errors.js";
import type { CleanupStatus, SessionId } from "../domain/types.js";
import { closeWindowsJob } from "./windows-job.js";

export interface WorkerLease {
  version: 1 | 2;
  id: string;
  sessionId: SessionId;
  pid: number;
  ownerToken: string;
  workerPath: string;
  executable: string;
  startedAt: number;
  platform: string;
}
const validate = new Ajv({ strict: true }).compile<WorkerLease>({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "id",
    "sessionId",
    "pid",
    "ownerToken",
    "workerPath",
    "executable",
    "startedAt",
    "platform",
  ],
  properties: {
    version: { enum: [1, 2] },
    id: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    pid: { type: "integer", minimum: 1 },
    ownerToken: { type: "string", pattern: "^[a-f0-9-]{36}$" },
    workerPath: { type: "string", minLength: 1 },
    executable: { type: "string", minLength: 1 },
    startedAt: { type: "integer", minimum: 1 },
    platform: { type: "string", minLength: 1 },
  },
});

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Private crash-recovery records. Existing leases are never overwritten by new Workers. */
export class WorkerLeaseStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new HubError(
        "WORKER_LEASE_DIRECTORY_INVALID",
        "Worker lease directory must be an ordinary private directory",
        503,
      );
    if (process.platform !== "win32") chmodSync(this.directory, 0o700);
  }

  save(
    input: Omit<
      WorkerLease,
      "version" | "id" | "startedAt" | "platform" | "executable"
    >,
  ): WorkerLease {
    const lease: WorkerLease = {
      ...input,
      version: process.platform === "win32" ? 2 : 1,
      id: randomUUID(),
      startedAt: Date.now(),
      platform: process.platform,
      executable: process.execPath,
    };
    const path = this.path(lease.sessionId);
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(path, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, JSON.stringify(lease));
      fsyncSync(descriptor);
    } catch (error) {
      if (created) unlinkSync(path);
      const failure = new HubError(
        "WORKER_LEASE_WRITE_FAILED",
        "Worker ownership could not be persisted; execution was not started",
        503,
      );
      failure.cause = error;
      throw failure;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return lease;
  }

  readAll(): Array<{ sessionId: SessionId; lease?: WorkerLease }> {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        let sessionId: SessionId;
        try {
          sessionId = decodeURIComponent(name.slice(0, -5)) as SessionId;
        } catch {
          throw new HubError(
            "WORKER_LEASE_INVALID",
            "Worker lease filename cannot be attributed to a session",
            503,
          );
        }
        const lease = this.read(sessionId);
        return lease ? { sessionId, lease } : { sessionId };
      });
  }

  /** Missing records are already released. A replaced record is retained and reported as failure. */
  remove(lease: WorkerLease): void {
    try {
      lstatSync(this.path(lease.sessionId));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const current = this.read(lease.sessionId);
    if (
      !current ||
      current.id !== lease.id ||
      current.ownerToken !== lease.ownerToken ||
      current.pid !== lease.pid
    ) {
      throw new HubError(
        "WORKER_LEASE_CHANGED",
        "Worker lease identity changed during cleanup",
        503,
      );
    }
    unlinkSync(this.path(lease.sessionId));
  }

  private path(sessionId: SessionId): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.json`);
  }
  private read(sessionId: SessionId): WorkerLease | undefined {
    try {
      const path = this.path(sessionId);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384)
        return undefined;
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!validate(value) || value.sessionId !== sessionId) return undefined;
      return value;
    } catch {
      return undefined; /* An unreadable or malformed lease never authorizes a kill. */
    }
  }
}

const exec = promisify(execFile);
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    return true; // Permission errors cannot establish absence.
  }
}
async function identity(
  lease: WorkerLease,
): Promise<"owned" | "gone" | "unknown"> {
  if (!exists(lease.pid) && !exists(-lease.pid)) return "gone";
  try {
    const { stdout } = await exec(
      "/bin/ps",
      ["-ww", "-p", String(lease.pid), "-o", "pid=,pgid=,command="],
      {
        timeout: 2_000,
        maxBuffer: 16_384,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
    );
    const match = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/.exec(stdout);
    const expected = `${lease.executable} ${lease.workerPath} --harnesshub-owner=${lease.ownerToken}`;
    if (
      match &&
      Number(match[1]) === lease.pid &&
      Number(match[2]) === lease.pid &&
      match[3]?.trimEnd() === expected
    )
      return "owned";
  } catch {
    /* A disappearing process is checked below; failed inspection never permits termination. */
  }
  return !exists(lease.pid) && !exists(-lease.pid) ? "gone" : "unknown";
}

/** Composition calls this only after acquiring the exclusive Gateway owner lock. */
export async function recoverWorkerLease(
  lease: WorkerLease,
  graceMs: number,
): Promise<CleanupStatus> {
  if (process.platform === "win32" && lease.platform === "win32") {
    // Version 1 never established native descendant ownership. Preserve it for manual reconciliation.
    if (lease.version !== 2) return "unconfirmed";
    const cleanup = await closeWindowsJob(lease.ownerToken);
    // A missing Job plus a live root may mean assignment never happened or PID reuse.
    // Neither case authorizes PID-only termination during recovery.
    return cleanup === "confirmed" && !exists(lease.pid)
      ? "confirmed"
      : "unconfirmed";
  }
  if (
    !["darwin", "linux"].includes(process.platform) ||
    lease.platform !== process.platform
  )
    return "unconfirmed";
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const current = await identity(lease);
    if (current === "gone") return "confirmed";
    if (current !== "owned") return "unconfirmed";
    try {
      process.kill(-lease.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        return "failed";
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!exists(lease.pid) && !exists(-lease.pid)) return "confirmed";
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))),
      );
    }
    // The next escalation rechecks the root identity. Orphan groups with a lost root stay unconfirmed.
  }
  return !exists(lease.pid) && !exists(-lease.pid)
    ? "confirmed"
    : "unconfirmed";
}
