import type { AttentionItem } from "../contracts/session.js";
import type { AttentionFrame } from "../contracts/web.js";
import { SessionStreamError, type SessionStreamSink } from "./session-stream.js";

/** Production defaults match the Session stream (ADR-013); smaller test limits exercise the same paths. */
export interface AttentionStreamLimits {
  readonly maxConnections?: number;
  readonly heartbeatMs?: number;
  readonly connectionTtlMs?: number;
  readonly drainTimeoutMs?: number;
  readonly now?: () => number;
}
function limit(value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) throw new Error("invalid attention stream limit"); return chosen;
}

/**
 * Live frames of every approval or question waiting for the user across conversations (ADR-035). It owns subscriptions
 * and timers only: the list is read from the Runtime after each committed and published Session event, and a frame goes
 * out only when the list changed. Each frame carries the whole bounded list with an increasing revision, so a client
 * that missed frames, reconnected or read the list by request keeps the newest one.
 */
export class AttentionStreamHub {
  private readonly clients = new Set<AttentionClient>();
  private closed = false;
  private revision = 0;
  private current = "[]";
  private broadcast = "[]";
  private readonly maxConnections: number;
  readonly heartbeatMs: number;
  readonly connectionTtlMs: number;
  readonly drainTimeoutMs: number;
  readonly now: () => number;
  /** `listener` receives every newer list too: the Session streams carry it for pages with a conversation open. */
  constructor(private readonly read: () => readonly AttentionItem[], options: AttentionStreamLimits = {}, private readonly listener?: (frame: AttentionFrame) => void) {
    this.maxConnections = limit(options.maxConnections, 8); this.heartbeatMs = limit(options.heartbeatMs, 15000);
    this.connectionTtlMs = limit(options.connectionTtlMs, 60000); this.drainTimeoutMs = limit(options.drainTimeoutMs, 10000); this.now = options.now ?? Date.now;
  }
  get size(): number { return this.clients.size; }
  /** The current list; the revision advances whenever it differs from the last frame given out. */
  frame(): AttentionFrame {
    const items = this.read(), text = JSON.stringify(items);
    if (text !== this.current) { this.current = text; this.revision++; }
    return { revision: this.revision, items };
  }
  /** Registers, then sends the current frame; the subscription ends at its TTL or the login's expiry, whichever is first. */
  open(loginExpires: number, sink: SessionStreamSink, ready: () => void): void {
    if (this.closed) throw new SessionStreamError(503, "STREAM_CLOSED", "Attention stream owner is stopping");
    if (this.clients.size >= this.maxConnections) throw new SessionStreamError(429, "STREAM_LIMIT", "Too many attention subscriptions");
    const ttl = Math.min(this.now() + this.connectionTtlMs, loginExpires) - this.now();
    if (!Number.isFinite(ttl) || ttl <= 0) throw new SessionStreamError(401, "AUTH_REQUIRED", "Attention subscription login expired");
    const client = new AttentionClient(sink, this, () => this.clients.delete(client)); this.clients.add(client);
    try { ready(); client.start(ttl); client.send(this.frame()); }
    catch (error) { client.close(false); throw error; }
  }
  /**
   * After each published Session event: sends the list to every subscriber, and to the listener, when it differs from the
   * list last sent (a frame given out on request in between does not hide the change).
   */
  changed(): void {
    if (this.closed) return;
    const frame = this.frame(), text = JSON.stringify(frame.items);
    if (text === this.broadcast) return;
    this.broadcast = text;
    for (const client of [...this.clients]) client.send(frame);
    this.listener?.(frame);
  }
  close(): void { if (this.closed) return; this.closed = true; for (const client of [...this.clients]) client.close(); }
}

class AttentionClient {
  private revision = -1;
  private closed = false;
  private paused = false;
  private pending: AttentionFrame | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private ttl: ReturnType<typeof setTimeout> | null = null;
  private stalled: ReturnType<typeof setTimeout> | null = null;
  private readonly gone = (): void => this.close();
  // A slow subscriber gets only the newest frame once it drains.
  private readonly drain = (): void => {
    if (this.closed) return;
    this.paused = false;
    if (this.stalled !== null) clearTimeout(this.stalled); this.stalled = null;
    const frame = this.pending; this.pending = null;
    if (frame !== null) this.send(frame);
  };
  constructor(private readonly sink: SessionStreamSink, private readonly hub: AttentionStreamHub, private readonly release: () => void) {
    sink.on("close", this.gone); sink.on("error", this.gone); sink.on("drain", this.drain);
  }
  start(ttlMs: number): void {
    this.ttl = setTimeout(this.gone, ttlMs); this.ttl.unref();
    this.heartbeat = setInterval(() => { if (!this.closed && !this.paused) this.write(": heartbeat\n\n"); }, this.hub.heartbeatMs); this.heartbeat.unref();
  }
  send(frame: AttentionFrame): void {
    if (this.closed || frame.revision <= this.revision) return;
    if (this.paused) { this.pending = frame; return; }
    this.revision = frame.revision;
    this.write("id: " + frame.revision + "\nevent: attention\ndata: " + JSON.stringify(frame) + "\n\n");
  }
  private write(text: string): void {
    if (this.closed || this.sink.destroyed || this.sink.writableEnded) { this.close(); return; }
    try {
      if (!this.sink.write(text)) {
        this.paused = true;
        this.stalled ??= setTimeout(this.gone, this.hub.drainTimeoutMs); this.stalled.unref();
      }
    } catch { this.close(); }
  }
  close(end = true): void {
    if (this.closed) return; this.closed = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat); if (this.ttl !== null) clearTimeout(this.ttl); if (this.stalled !== null) clearTimeout(this.stalled);
    this.heartbeat = null; this.ttl = null; this.stalled = null;
    try { this.sink.off("close", this.gone); this.sink.off("error", this.gone); this.sink.off("drain", this.drain); } catch { /* Transport cleanup cannot invalidate committed facts. */ }
    this.release();
    try { if (end && !this.sink.writableEnded && !this.sink.destroyed) this.sink.end(); } catch { /* A closed socket has no business-side resource responsibility. */ }
  }
}
