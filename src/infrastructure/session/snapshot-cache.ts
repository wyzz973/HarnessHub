import { SessionError, type SessionId, type SessionSnapshot } from "../../contracts/session.js";

/** The largest byte budget a snapshot cache may have (ADR-055 §11.1, §11.2): twelve snapshots at the 8 MiB Session limit. */
export const MAX_SNAPSHOT_CACHE_BYTES = 96 * 1024 * 1024;

/** What a snapshot cache holds and how it was used since it was made; for diagnostics and tests. */
export interface SnapshotCacheStats {
  readonly entries: number;
  /** Persisted UTF-8 bytes of the cached snapshots; their parsed form takes about 1.5 times that on the heap (R6 §2.6.2). */
  readonly bytes: number;
  readonly maxBytes: number;
  readonly hits: number;
  /** Lookups that found no snapshot for the version asked for, so the caller read and validated it again. */
  readonly misses: number;
  /** Snapshots dropped to stay within the byte budget. */
  readonly evictions: number;
}
interface Entry {
  readonly snapshot: SessionSnapshot;
  readonly bytes: number;
  /** The byte size of the Session's event log through `snapshot.lastSeq`, when the store knows it. */
  readonly logBytes: number | undefined;
}

/**
 * The validated Session snapshots of one SqliteSessionStore, by version, and the byte size of each one's event log
 * (ADR-055 §11.2). The store that makes it owns it and closes it when it closes; nothing else holds one.
 *
 * It holds committed state only: the store puts a snapshot after its transaction committed (or after reading it outside
 * any write), never one a transaction is still writing, so a rolled-back transaction leaves the cache as it was. A lookup
 * names the version and event cursor the store just read from SQLite in the same operation; any other version, older or
 * newer, drops the entry and misses, so the next reader validates the stored snapshot again instead of seeing an old one.
 * The store clears the cache when another connection committed to its database (PRAGMA data_version) or when its storage
 * failed. Snapshots are deeply frozen, since every reader shares them.
 *
 * The budget counts the persisted UTF-8 bytes of each snapshot, at most MAX_SNAPSHOT_CACHE_BYTES; the least recently used
 * snapshots are dropped first, and one larger than the whole budget is not kept. A budget of 0 keeps nothing. After
 * close() it holds nothing and keeps nothing.
 */
export class SnapshotCache {
  readonly maxBytes: number;
  /** Least recently used first: a hit moves its entry to the end. */
  private readonly entries = new Map<SessionId, Entry>();
  private used = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private closed = false;

  constructor(maxBytes: number = MAX_SNAPSHOT_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_SNAPSHOT_CACHE_BYTES) throw new SessionError("INVALID_INPUT", "snapshot cache budget must be between 0 and " + MAX_SNAPSHOT_CACHE_BYTES + " bytes");
    this.maxBytes = maxBytes;
  }

  /** The snapshot of `id` at exactly `version` and event cursor `lastSeq`, or undefined; an entry for anything else is dropped. */
  get(id: SessionId, version: number, lastSeq: number): SessionSnapshot | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.snapshot.version !== version || entry.snapshot.lastSeq !== lastSeq) {
      if (entry !== undefined) this.drop(id, entry);
      if (!this.closed) this.misses += 1;
      return undefined;
    }
    this.entries.delete(id); this.entries.set(id, entry); this.hits += 1;
    return entry.snapshot;
  }
  /** The byte size of the event log of `id` through `lastSeq`, when the cached snapshot is at that cursor and the store knew it. */
  logBytes(id: SessionId, lastSeq: number): number | undefined {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.snapshot.lastSeq === lastSeq ? entry.logBytes : undefined;
  }
  /**
   * Keeps a committed, validated and deeply frozen snapshot of `bytes` persisted bytes in place of any earlier one of its
   * Session, with the byte size of its event log through its cursor when known; then drops the least recently used until
   * the budget holds. Throws INVALID_INPUT for a snapshot that is not frozen or a size that is not a positive integer.
   */
  put(snapshot: SessionSnapshot, bytes: number, logBytes?: number): void {
    if (!Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.runs)) throw new SessionError("INVALID_INPUT", "only a frozen snapshot can be shared from the cache");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || (logBytes !== undefined && (!Number.isSafeInteger(logBytes) || logBytes < 0))) throw new SessionError("INVALID_INPUT", "snapshot and event log sizes must be byte counts");
    const prior = this.entries.get(snapshot.id);
    if (prior !== undefined) this.drop(snapshot.id, prior);
    if (this.closed || bytes > this.maxBytes) return;
    this.entries.set(snapshot.id, { snapshot, bytes, logBytes }); this.used += bytes;
    for (const [id, entry] of this.entries) {
      if (this.used <= this.maxBytes) break;
      this.drop(id, entry); this.evictions += 1;
    }
  }
  /** Drops every snapshot and log size: another connection committed to the database, or its storage failed. */
  clear(): void { this.entries.clear(); this.used = 0; }
  stats(): SnapshotCacheStats {
    return { entries: this.entries.size, bytes: this.used, maxBytes: this.maxBytes, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
  /** Releases every snapshot; afterwards lookups miss without counting and puts keep nothing. Idempotent. */
  close(): void { this.closed = true; this.clear(); }

  private drop(id: SessionId, entry: Entry): void { this.entries.delete(id); this.used -= entry.bytes; }
}
