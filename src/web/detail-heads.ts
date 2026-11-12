import type { ContentRef } from "../contracts/content.js";
import { TABLE_LIMITS } from "../contracts/table.js";
import { detailHead, type ToolDetailInput } from "../contexts/session/domain/protocol/index.js";

/*
 * The head of a stored tool detail (docs/proposals/protocol/hub-protocol.html §17): the small part the protocol reads a call's objects from (a command, a path, a query, a diff's
 * files). Read by the display layer for the calls of a Turn that was converted from before v14 and for the task-list call a Turn's plan is read from; the Turns made since
 * hold what they need in their rows. A stored detail never changes, so a head never goes stale: the heads read are kept (the longest unused leave first), and a detail that could
 * not be read is not asked for again for a while. Nothing here fails a view: a detail that cannot be read leaves its call told by its title, and a later view tries again.
 */

/** What the heads are read with: the content store's synchronous read, which blocks while the file is read and so refuses a detail larger than it is asked for. */
export interface DetailSource { readTextSync(ref: ContentRef, maxBytes: number): string | null }
export interface DetailHeadsOptions {
  /** How many heads are kept. */
  readonly maxEntries?: number;
  /** How long a detail that could not be read is not asked for again. */
  readonly retryMs?: number;
  readonly now?: () => number;
}
const MAX_ENTRIES = 4096, RETRY_MS = 30_000;

export class DetailHeads {
  private readonly heads = new Map<string, ToolDetailInput>();
  private readonly failed = new Map<string, number>();
  private readonly maxEntries: number; private readonly retryMs: number; private readonly now: () => number;
  constructor(private readonly source: DetailSource | undefined, options: DetailHeadsOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES; this.retryMs = options.retryMs ?? RETRY_MS; this.now = options.now ?? Date.now;
  }
  get size(): number { return this.heads.size; }
  /** The head of a detail: the one held, else read from the store; null for one it cannot give. */
  read = (ref: ContentRef): ToolDetailInput | null => {
    const held = this.heads.get(ref.id);
    if (held !== undefined) { this.heads.delete(ref.id); this.heads.set(ref.id, held); return held; }
    const until = this.failed.get(ref.id);
    if (until !== undefined && until > this.now()) return null;
    if (this.source === undefined) return null;
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
}
