import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionError, sessionId, type HarnessSelection, type SessionEvent, type SessionId, type SessionSnapshot } from "../../contracts/session.js";
import { migrationState, type MigrationState } from "./migrate-v14.js";
import { parseSession } from "./legacy/state.js";
import { snapshotFromRows } from "./snapshot-adapter.js";
import { all, one } from "./statements.js";
import { pageLimit, readEvents } from "./store-events.js";
import { inspectRoot, pathIdentity, sameFile, sqliteError, storageFailure, type FileIdentity } from "./store-root.js";

/*
 * Read-only access to a data root for the command-line tools (`sessions list/show/events`): it never claims an owner, never recovers and never writes. It reads a database of
 * any version the Hub has made: one of store v1 to v13 keeps each conversation as one snapshot JSON (read with the frozen parser of that shape, `legacy/state.ts`), one of
 * v14 keeps them as rows (read back into the snapshot's shape, the same adapter the readers that have not moved to items use), and a v14 database whose upgrade has not
 * finished (review I12) has conversations of both kinds: each is read in the kind it is, and `upgrade()` says that the rest are not converted yet.
 */

/** One line of `list`: what the tools print of a conversation. */
export interface SessionLine {
  readonly id: SessionId;
  readonly status: SessionSnapshot["status"];
  readonly epoch: number;
  readonly selection: HarnessSelection;
  readonly runs: number;
  readonly lastSeq: number;
}

export class SqliteSessionReader {
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly markerPath: string;
  private readonly markerIdentity: FileIdentity;
  private readonly databasePath: string;
  private readonly databaseIdentity: FileIdentity;
  private readonly database: DatabaseSync;
  private closed = false;
  private failed: SessionError | null = null;

  constructor(root: string) {
    const initialized = inspectRoot(root);
    this.root = initialized.root; this.rootIdentity = pathIdentity(this.root, true);
    this.markerPath = initialized.markerPath; this.markerIdentity = initialized.markerIdentity;
    this.databasePath = join(this.root, "gateway.sqlite"); this.databaseIdentity = pathIdentity(this.databasePath);
    this.database = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
    try { this.version(); this.assertReadable(); }
    catch (error) { this.database.close(); throw error instanceof SessionError ? error : storageFailure(error); }
  }

  private version(): number {
    const row = this.database.prepare("PRAGMA user_version").get();
    if (!row || typeof row.user_version !== "number" || !Number.isSafeInteger(row.user_version) || row.user_version < 1 || row.user_version > 14) throw new SessionError("INVALID_DATA", "unknown business database schema version");
    return row.user_version;
  }
  /** Where the upgrade to the tables is: not started (a database before v14), under way or stopped (some conversations are still snapshots), or done. */
  upgrade(): MigrationState { return this.read(() => migrationState(this.database)); }

  /** The conversation in the shape of a snapshot, whichever kind it is stored as. */
  get(id: SessionId): SessionSnapshot { sessionId(id); return this.read(() => this.snapshotOf(id)); }
  /** The newest conversations (at most `limit`), as the tools list them. A deleted one is not listed. */
  list(limit: number): readonly SessionLine[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new SessionError("INVALID_INPUT", "read limit must be a positive integer");
    return this.read(() => {
      const version = this.version(), ordered = this.deletable() ? "WHERE deleted_at IS NULL " : "";
      const ids = all(this.database, "SELECT id FROM sessions " + ordered + "ORDER BY " + (version >= 14 ? "updated_at DESC, " : "") + "rowid DESC LIMIT ?", limit).map(row => String(row.id) as SessionId);
      return ids.map((id): SessionLine => {
        if (this.formatOf(id) === 14) {
          const row = one(this.database, "SELECT status, epoch, run_count, last_seq, head FROM sessions WHERE id=?", id)!;
          const head = JSON.parse(String(row.head)) as { readonly selection: HarnessSelection };
          return { id, status: row.status as SessionLine["status"], epoch: Number(row.epoch), selection: head.selection, runs: Number(row.run_count), lastSeq: Number(row.last_seq) };
        }
        const snapshot = this.snapshotOf(id);
        return { id, status: snapshot.status, epoch: snapshot.epoch, selection: snapshot.selection, runs: snapshot.runs.length, lastSeq: snapshot.lastSeq };
      });
    });
  }
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    sessionId(id); const count = pageLimit(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    return this.read(() => {
      if (one(this.database, "SELECT 1 AS found FROM sessions WHERE id=?", id) === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
      return readEvents(this.database, id, afterSeq, count);
    });
  }
  close(): void { if (this.closed) return; this.closed = true; this.database.close(); }

  /** Whether `sessions` has the columns of v14 (a v13 table has only the snapshot). */
  private deletable(): boolean { return all(this.database, "PRAGMA table_info(sessions)").some(column => column.name === "deleted_at"); }
  private formatOf(id: SessionId): 13 | 14 {
    if (this.version() < 14) return 13;
    const row = one(this.database, "SELECT format FROM sessions WHERE id=?", id);
    if (row === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    return row.format === 14 ? 14 : 13;
  }
  private snapshotOf(id: SessionId): SessionSnapshot {
    if (this.formatOf(id) === 14) return snapshotFromRows(this.database, id);
    const row = one(this.database, "SELECT " + (this.version() < 14 ? "snapshot" : "head") + " AS body FROM sessions WHERE id=?", id);
    if (row === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    let value: unknown;
    try { value = JSON.parse(String(row.body)); } catch { throw new SessionError("INVALID_DATA", "persisted Session is not valid JSON"); }
    return parseSession(value);
  }
  private assertReadable(): void {
    if (this.closed) throw new SessionError("STORE_CLOSED", "Session reader is closed");
    if (this.failed) throw this.failed;
    try {
      if (!this.database.isOpen || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath)) || !sameFile(this.databaseIdentity, pathIdentity(this.databasePath))) throw new SessionError("STORAGE_CHANGED", "read-only storage path identity changed");
      this.version();
    } catch (error) { this.failed = error instanceof SessionError ? error : storageFailure(error); throw this.failed; }
  }
  private read<T>(read: () => T): T {
    this.assertReadable();
    try {
      this.database.exec("BEGIN DEFERRED"); const result = read(); this.assertReadable(); this.database.exec("COMMIT"); return result;
    } catch (error) {
      try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); } catch (rollbackError) { this.failed = storageFailure(rollbackError); }
      if (sqliteError(error)) this.failed = storageFailure(error);
      throw this.failed ?? error;
    }
  }
}
