import type { ContentRef } from "../contracts/content.js";
import type { SessionSnapshot } from "../contracts/session.js";
import { TABLE_LIMITS } from "../contracts/table.js";
import type { WebRun } from "../contracts/web.js";
import { detailHead, projectTurns, type ToolDetailInput } from "../contexts/session/domain/protocol/index.js";

/**
 * The protocol (hh/1) view of a conversation for the web API (docs/proposals/protocol/hub-protocol.html §17, step 1): each Run of the
 * view gets its `protocol` Turn, read from the facts the Hub already stores. The shared rule is the domain's (`projectTurn`); this
 * file brings it what the domain may not touch: the heads of the stored tool details (a file read, bounded and kept in memory) and the
 * names the interface shows (Harnesses and models). Nothing here is stored, and nothing here fails a conversation's view: a detail
 * that cannot be read leaves its call told by its title, and the next view tries again.
 */

/** What a head cache reads details with: the content store's synchronous read. */
export interface DetailSource { readTextSync(ref: ContentRef, maxBytes: number): string | null }
export interface DetailHeadsOptions {
  /** How many heads are kept; the longest unused leave first. */
  readonly maxEntries?: number;
  /** How many details one view may read from the store; the rest are told by their titles until a later view. */
  readonly readsPerView?: number;
  /** How long a detail that could not be read is not asked for again. */
  readonly retryMs?: number;
  readonly now?: () => number;
}
export const DETAIL_HEADS_MAX = 4096, DETAIL_READS_PER_VIEW = 400, DETAIL_RETRY_MS = 30_000;

/**
 * The heads of stored tool details, by their content id (a stored detail never changes, so a head never goes stale): the small part
 * of each the protocol reads its objects from (a command, a path, a query, a diff's files). Bounded in entries and, per view, in reads.
 */
export class DetailHeads {
  private readonly heads = new Map<string, ToolDetailInput>();
  private readonly failed = new Map<string, number>();
  private readonly maxEntries: number; private readonly readsPerView: number; private readonly retryMs: number; private readonly now: () => number;
  constructor(private readonly source: DetailSource | undefined, options: DetailHeadsOptions = {}) {
    this.maxEntries = options.maxEntries ?? DETAIL_HEADS_MAX; this.readsPerView = options.readsPerView ?? DETAIL_READS_PER_VIEW; this.retryMs = options.retryMs ?? DETAIL_RETRY_MS; this.now = options.now ?? Date.now;
  }
  get size(): number { return this.heads.size; }
  /** The reader of one view: heads held are returned; a detail not held is read from the store, up to `readsPerView` of them; null for one it cannot give. */
  reader(): { readonly read: (ref: ContentRef) => ToolDetailInput | null } {
    let reads = 0;
    const read = (ref: ContentRef): ToolDetailInput | null => {
      const held = this.heads.get(ref.id);
      if (held !== undefined) { this.heads.delete(ref.id); this.heads.set(ref.id, held); return held; }
      const until = this.failed.get(ref.id);
      if (until !== undefined && until > this.now()) return null;
      if (this.source === undefined || reads >= this.readsPerView) return null;
      reads++;
      let head: ToolDetailInput | null = null;
      try {
        const text = this.source.readTextSync(ref, TABLE_LIMITS.detailBytes);
        head = text === null ? null : detailHead(JSON.parse(text) as unknown);
      } catch { head = null; }
      if (head === null) { this.failed.set(ref.id, this.now() + this.retryMs); if (this.failed.size > this.maxEntries) this.failed.delete(this.failed.keys().next().value!); return null; }
      this.failed.delete(ref.id);
      this.heads.set(ref.id, head);
      if (this.heads.size > this.maxEntries) this.heads.delete(this.heads.keys().next().value!);
      return head;
    };
    return { read };
  }
}

export interface ProtocolViewOptions {
  readonly heads: DetailHeads;
  /** A Harness's display name by its id (the built-in catalog's name); null when it has none. */
  readonly harnessName: (harnessId: string) => string | null;
  /** The display name the Harness's own model catalog gives a native model; null when none has been read. */
  readonly modelName?: (harnessId: string, nativeModel: string) => string | null;
}

/**
 * Gives the Runs of a conversation's view their protocol Turns. Making a Turn costs microseconds (a thousand Turns of a long conversation
 * are made in a few milliseconds), so every view makes them all again: there is no copy of a Turn to go stale when a catalog is read, a
 * binding reports a model or a detail becomes readable.
 */
export class ProtocolView {
  constructor(private readonly options: ProtocolViewOptions) {}

  /**
   * `runs` are the snapshot's Runs as the view shows them (the relay's delivery state read in), in the same order; `waiting` are the Runs that wait
   * for the user's decision. The same Runs are returned, each with its `protocol`. Details are read newest Turn first, so that when a conversation
   * has more of them than one view reads, the latest Turns are the ones told whole.
   */
  attach(snapshot: SessionSnapshot, runs: readonly WebRun[], waiting: ReadonlySet<string>): readonly WebRun[] {
    const reader = this.options.heads.reader();
    const turns = projectTurns({ runs, messages: snapshot.messages, nativeBindings: snapshot.nativeBindings, waiting },
      { harnessName: this.options.harnessName, ...(this.options.modelName === undefined ? {} : { modelName: this.options.modelName }), detail: reader.read });
    return runs.map((run, index) => ({ ...run, protocol: turns[index]! }));
  }
}
