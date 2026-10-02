// SPDX-License-Identifier: MIT
import { DatabaseSync } from "node:sqlite";
import { HubError } from "../domain/errors.js";

/** An exclusive lock held for as long as the owning process keeps it open. */
export interface InstanceLock {
  /** Release the lock. Idempotent; the operating system also releases it when the process exits. */
  release(): void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

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
 * Windows) held in `locking_mode=EXCLUSIVE` by a dedicated connection. It is
 * tied to the open connection, not to a process ID: the operating system drops
 * it when the process dies, and a reused PID can never keep it. Connections in
 * the same process, including other worker threads, contend for it too.
 *
 * @throws HubError `RUNTIME_ALREADY_RUNNING` (409) when another connection
 *   holds the lock; other SQLite or file system errors propagate unchanged.
 */
export function acquireInstanceLock(file: string): InstanceLock {
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec(
      "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL); DELETE FROM holder;",
    );
    db.prepare("INSERT INTO holder (pid) VALUES (?)").run(process.pid);
    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } finally {
      db.close();
    }
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
      db.close();
    },
  };
}
