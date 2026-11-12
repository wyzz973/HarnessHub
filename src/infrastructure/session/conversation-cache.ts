import type { Conversation } from "../../contracts/conversation.js";
import { SessionError, type PublicMessage, type PublicRun, type RunId, type SessionId } from "../../contracts/session.js";

/*
 * What the store of conversations keeps in memory (ADR-057 3.3, "the first stage's memory"), and how it lets go of it.
 *
 *   ConversationCache  the conversations the Runtime reduces: the head, a small row per Turn, and the items of the Turns not finished. One object per version, so that the
 *                      comparison of a commit (diff.ts) can pass over every Turn that is the very object it was. Least recently used first out, by two counts: how many
 *                      conversations and how many Turns they hold between them (the Turn's row is what memory grows by; about 1.5 KiB each, so 50,000 Turns are roughly 75 MiB).
 *                      The conversation just used is never let go, however large: a single conversation of a million Turns is held, and the others make room. Letting
 *                      go costs a read of that conversation's rows the next time it is asked for (`get` loads it again), nothing else: what is in memory is only ever
 *                      what the tables hold.
 *   TurnCache          a finished Turn in the shape it had when it was one snapshot (`fromItems`), for the readers that have not moved to items. A finished Turn never
 *                      changes, so an entry never goes stale, and is dropped only to keep within a byte budget (least recently used first); it is made again from its rows.
 */

/** What one conversation costs to hold: its object, and the title the store works out and keeps in the head. */
export interface CacheEntry {
  readonly conversation: Conversation;
  readonly title: string;
  /** The origin in the old shape (the quoted history joined to the origin), made once on demand: a conversation's origin never changes. */
  oldOrigin?: unknown;
}
export interface ConversationCacheStats { readonly conversations: number; readonly runs: number; readonly maxConversations: number; readonly maxRuns: number; readonly hits: number; readonly misses: number; readonly evictions: number }
export const DEFAULT_CACHED_CONVERSATIONS = 256;
export const DEFAULT_CACHED_RUNS = 50_000;

export class ConversationCache {
  /** Least recently used first: a hit moves its entry to the end. */
  private readonly entries = new Map<SessionId, CacheEntry>();
  private runs = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(readonly maxConversations: number = DEFAULT_CACHED_CONVERSATIONS, readonly maxRuns: number = DEFAULT_CACHED_RUNS) {
    for (const [name, value] of [["conversations", maxConversations], ["Turns", maxRuns]] as const)
      if (!Number.isSafeInteger(value) || value < 1) throw new SessionError("INVALID_INPUT", "the number of " + name + " the cache holds must be a positive integer");
  }

  get(id: SessionId): CacheEntry | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) { this.misses += 1; return undefined; }
    this.entries.delete(id); this.entries.set(id, entry); this.hits += 1;
    return entry;
  }
  put(id: SessionId, entry: CacheEntry): void {
    const prior = this.entries.get(id);
    if (prior !== undefined) { this.entries.delete(id); this.runs -= prior.conversation.runs.length; }
    this.entries.set(id, entry); this.runs += entry.conversation.runs.length;
    // The one just put is the last; it stays whatever it costs.
    while (this.entries.size > 1 && (this.entries.size > this.maxConversations || this.runs > this.maxRuns)) {
      const [oldest, held] = this.entries.entries().next().value!;
      this.entries.delete(oldest); this.runs -= held.conversation.runs.length; this.evictions += 1;
    }
  }
  delete(id: SessionId): void {
    const prior = this.entries.get(id);
    if (prior !== undefined) { this.entries.delete(id); this.runs -= prior.conversation.runs.length; }
  }
  clear(): void { this.entries.clear(); this.runs = 0; }
  stats(): ConversationCacheStats {
    return { conversations: this.entries.size, runs: this.runs, maxConversations: this.maxConversations, maxRuns: this.maxRuns, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
}

/** A finished Turn in the old shape: the Run with its messages. Deeply frozen: every reader of it shares it. */
export interface OldTurn { readonly run: PublicRun; readonly messages: readonly PublicMessage[]; readonly bytes: number }
export interface TurnCacheStats { readonly turns: number; readonly bytes: number; readonly maxBytes: number; readonly hits: number; readonly misses: number; readonly evictions: number }
/** The default byte budget of the old-shape Turns: 96 MiB, what the snapshot cache of the first store had. */
export const DEFAULT_TURN_CACHE_BYTES = 96 * 1024 * 1024;

export class TurnCache {
  private readonly entries = new Map<RunId, OldTurn>();
  private used = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(readonly maxBytes: number = DEFAULT_TURN_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new SessionError("INVALID_INPUT", "the byte budget of the old-shape Turns must be a nonnegative integer");
  }
  get(id: RunId): OldTurn | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) { this.misses += 1; return undefined; }
    this.entries.delete(id); this.entries.set(id, entry); this.hits += 1;
    return entry;
  }
  /** Keeps the Turn in place of any earlier entry of the Run, then lets go of the least recently used until the budget holds; one larger than the whole budget is not kept. */
  put(id: RunId, turn: OldTurn): void {
    const prior = this.entries.get(id);
    if (prior !== undefined) { this.entries.delete(id); this.used -= prior.bytes; }
    if (turn.bytes > this.maxBytes) return;
    this.entries.set(id, turn); this.used += turn.bytes;
    while (this.used > this.maxBytes) {
      const [oldest, held] = this.entries.entries().next().value!;
      this.entries.delete(oldest); this.used -= held.bytes; this.evictions += 1;
    }
  }
  clear(): void { this.entries.clear(); this.used = 0; }
  stats(): TurnCacheStats { return { turns: this.entries.size, bytes: this.used, maxBytes: this.maxBytes, hits: this.hits, misses: this.misses, evictions: this.evictions }; }
}

/** Freezes a value and everything under it that is not frozen yet (a frozen object is taken to be frozen all the way down: nothing here freezes it any other way). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
