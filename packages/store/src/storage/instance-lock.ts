// SPDX-License-Identifier: MIT
import { DatabaseSync } from "node:sqlite";
import { HubError } from "@harnesshub/core/errors";

/** An exclusive lock held for as long as the owning process keeps it open. */
export interface InstanceLock {
  /** Release the lock. Idempotent; the operating system also releases it when the process exits. */
  release(): void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
/**
 * How long a contender keeps retrying. Simultaneous starters resolve within a
 * few milliseconds: the losers back off and the winner's lock request then
 * succeeds. Against a running Gateway the wait expires and the start fails
 * with RUNTIME_ALREADY_RUNNING.
 */
const LOCK_WAIT_MS = 1_000;

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    (error.errcode === SQLITE_BUSY || error.errcode === SQLITE_LOCKED)
  );
}

/**
 * Take the exclusive lock on `file`, creating it if needed.
 *
 * The lock is SQLite's own file lock (POSIX advisory locks, `LockFileEx` on
 * Windows), held by a dedicated connection that keeps a `BEGIN EXCLUSIVE`
 * transaction open and writes nothing. It is tied to the open connection,
 * not to a process ID: the operating system drops it when the process dies,
 * and a reused PID can never keep it. Connections in the same process,
 * including other worker threads, contend for it too. (`locking_mode =
 * EXCLUSIVE` is deliberately not used: it keeps the SHARED lock of a failed
 * attempt, and simultaneous contenders then wait on each other until all of
 * them time out.)
 *
 * @throws HubError `RUNTIME_ALREADY_RUNNING` (409) when another connection
 *   holds the lock; other SQLite or file system errors propagate unchanged.
 */
export function acquireInstanceLock(file: string): InstanceLock {
  const db = new DatabaseSync(file, { timeout: LOCK_WAIT_MS });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (isBusy(error))
      throw new HubError(
        "RUNTIME_ALREADY_RUNNING",
        "Another live Gateway owns this database",
        409,
      );
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    },
  };
}
