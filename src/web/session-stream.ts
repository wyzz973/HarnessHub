import type { ConversationCommit } from "../contracts/conversation.js";
import { SessionError, type SessionEvent, type SessionId } from "../contracts/session.js";
import { RELAY_STREAM_EVENTS, type AttentionFrame, type RelayStreamEvent, type RelayStreamEventType, type RelayStreamFrame, type SessionCommitFrame, type SessionStreamFrameV14, type SessionViewV14 } from "../contracts/web.js";

/*
 * The stream of a conversation (ADR-057 3.4): a connection starts with the conversation as a page opens it (a `snapshot`: the head and the newest Turns), and then tells it
 * one thing for each commit — ONE `commit` frame, whatever the commit changed (src/web/commit-frame.ts). A page applies a frame when its version is the one after the version
 * it holds, so a frame is neither split nor repeated; a connection that cannot be told a commit (it fell behind, or it missed one) is told the conversation again instead of
 * the frames it missed. There is no replay of events, and no frame is too large to send: a frame holds a window's worth at most because of what it carries, not because
 * a larger one closes the connection.
 */

export class SessionStreamError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "SessionStreamError"; }
}
/** Socket-facing port. A socket failure never becomes a business publication failure. */
export interface SessionStreamSink {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(text: string): boolean;
  end(): void;
  on(event: "close" | "error" | "drain", listener: () => void): unknown;
  off(event: "close" | "error" | "drain", listener: () => void): unknown;
}
/** What the stream is made of: the conversation as it is now, and the frame of one commit. */
export interface SessionStreamSource {
  /** The head and the newest Turns of a conversation (`ConversationRoutes.session`). */
  readonly snapshot: (id: SessionId) => SessionViewV14;
  /** The one frame of a commit, made from what the commit wrote (`commitFrame`); asked for once for each commit that has a subscriber. */
  readonly frame: (commit: ConversationCommit) => SessionCommitFrame;
  /** Whether a commit is better told as the conversation than as a frame (what it means is not a function of the rows it wrote); asked once for each commit that has a subscriber. */
  readonly stale?: (commit: ConversationCommit) => boolean;
}
/** Production defaults are fixed by ADR-013; smaller test limits exercise the same rejection paths. */
export interface SessionStreamLimits {
  readonly maxConnections?: number;
  readonly heartbeatMs?: number;
  readonly connectionTtlMs?: number;
  readonly drainTimeoutMs?: number;
  readonly now?: () => number;
}
export interface SessionStreamReadFailure { readonly sessionId: SessionId; readonly error: unknown }
function limit(value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) throw new Error("invalid session stream limit"); return chosen;
}

const RELAY_EVENTS: ReadonlySet<string> = new Set(RELAY_STREAM_EVENTS);
const RUN_IDENTITY = /^run-[A-Za-z0-9-]{1,96}$/u, PACKET_IDENTITY = /^relay-[0-9a-hjkmnp-tv-z]{20}$/u;
/**
 * What the stream announces of a relay event (ADR-055 §12.4, §14.2): its kind, the Run and packet it names and when, picked
 * field by field from the event, which also holds a delivery's mark and how it was shown. Nothing else of the event is copied, so
 * no text, native value or digest can leave through a notice (RT4 AP-01–AP-03). Undefined for any other event.
 */
export function relayStreamEvent(event: SessionEvent): RelayStreamEvent | undefined {
  if (!RELAY_EVENTS.has(event.type)) return undefined;
  const data = event.data;
  const runId = typeof data.runId === "string" && RUN_IDENTITY.test(data.runId) ? data.runId : undefined;
  const packetId = typeof data.packetId === "string" && PACKET_IDENTITY.test(data.packetId) ? data.packetId : undefined;
  const at = Date.parse(event.timestamp);
  return { type: event.type as RelayStreamEventType, sessionId: event.sessionId, ...(runId === undefined ? {} : { runId }), ...(packetId === undefined ? {} : { packetId }), at: Number.isFinite(at) ? at : 0 };
}

/** Owns subscriptions/timers only. Run admission, persistence and cancellation remain in their application owner. */
export class SessionStreamHub {
  private readonly clients = new Set<StreamClient>();
  private closed = false;
  private firstReadFailure: SessionStreamReadFailure | null = null;
  private reporterFailure: unknown = null;
  private readonly maxConnections: number;
  readonly heartbeatMs: number;
  readonly connectionTtlMs: number;
  readonly drainTimeoutMs: number;
  readonly now: () => number;
  /**
   * `attention`, when given, is the current list of waiting approvals and questions (ADR-035): every subscription carries it
   * as `event: attention` frames without an event id, so a page with a conversation open needs no second long-lived connection.
   */
  constructor(private readonly source: SessionStreamSource, options: SessionStreamLimits = {}, private readonly reportReadFailure?: (failure: SessionStreamReadFailure) => void,
    private readonly attention?: () => AttentionFrame) {
    this.maxConnections = limit(options.maxConnections, 256);
    this.heartbeatMs = limit(options.heartbeatMs, 15000); this.connectionTtlMs = limit(options.connectionTtlMs, 60000);
    this.drainTimeoutMs = limit(options.drainTimeoutMs, 10000); this.now = options.now ?? Date.now;
  }
  get size(): number { return this.clients.size; }
  get readFailure(): SessionStreamReadFailure | null { return this.firstReadFailure; }
  get diagnosticFailure(): unknown { return this.reporterFailure; }
  /** Async socket callbacks retain/report authoritative failures without throwing from an EventEmitter callback. */
  recordReadFailure(id: SessionId, error: unknown): void {
    if (this.firstReadFailure !== null) return;
    this.firstReadFailure = { sessionId: id, error };
    try { this.reportReadFailure?.(this.firstReadFailure); } catch (failure) { this.reporterFailure = failure; }
  }
  /** Registers before reading the initial canonical facts; no await window can lose a publication. */
  open(id: SessionId, cursor: number, loginExpires: number, sink: SessionStreamSink, ready: () => void): void {
    if (this.closed) throw new SessionStreamError(503, "STREAM_CLOSED", "Session stream owner is stopping");
    if (this.clients.size >= this.maxConnections) throw new SessionStreamError(429, "STREAM_LIMIT", "Too many session subscriptions");
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new SessionStreamError(400, "INVALID_INPUT", "Invalid session stream cursor");
    const openedAt = this.now(), remaining = loginExpires - openedAt;
    if (!Number.isFinite(remaining) || remaining <= 0) throw new SessionStreamError(401, "AUTH_REQUIRED", "Session subscription login expired");
    const client = new StreamClient(id, sink, this, () => this.clients.delete(client)); this.clients.add(client);
    let started = false;
    try {
      const snapshot = this.snapshot(id);
      // A page that says it has seen more than the Gateway has committed was talking to a Gateway whose data went back: it cannot be followed from there.
      if (cursor > snapshot.head.lastSeq) throw new SessionStreamError(409, "CURSOR_CONFLICT", "Session stream cursor is ahead of committed facts");
      const ttl = Math.min(openedAt + this.connectionTtlMs, loginExpires) - this.now();
      if (ttl <= 0) throw new SessionStreamError(401, "AUTH_REQUIRED", "Session subscription login expired before its initial facts were ready");
      ready(); started = true; client.start(ttl); client.send({ type: "snapshot", session: snapshot });
      if (this.attention) client.attention(this.attention());
    } catch (error) { client.close(started); throw error; }
  }
  snapshot(id: SessionId): SessionViewV14 {
    const snapshot = this.source.snapshot(id);
    if (snapshot.head.id !== id || !Number.isSafeInteger(snapshot.head.lastSeq) || snapshot.head.lastSeq < 0 || !Number.isSafeInteger(snapshot.head.version)) throw new SessionError("INVALID_DATA", "session stream read has inconsistent identity or watermark");
    return snapshot;
  }
  /**
   * One commit, told once to every subscription of its conversation that holds the version before it. A subscription that is behind (backed up, or it missed a commit) is
   * told the conversation again when it can be; the relay's events are announced after the facts they follow. Authoritative reads may fail closed: a frame that cannot be made is
   * the publication that failed, and the application owner stops (a transport failure never is).
   */
  publish(commit: ConversationCommit): void {
    const written = commit.changes.head?.row;
    if (written === undefined) return;
    const id = written.id as SessionId, clients = [...this.clients].filter(client => client.id === id && client.version < written.version);
    if (!clients.length) return;
    let frame: SessionCommitFrame | undefined;
    const asRead = this.source.stale?.(commit) === true;
    const announced = commit.events.flatMap(event => { const notice = relayStreamEvent(event); return notice === undefined ? [] : [notice]; });
    for (const client of clients) {
      // Only the very next commit can be applied; anything else (a commit this connection was not told) is told as the conversation. The relay's events are announced after the facts
      // they follow all the same: a connection that was told the conversation holds those facts, and a notice is only written under the watermark the connection holds.
      if (asRead || client.version + 1 !== written.version) {
        client.stale();
        for (const notice of announced) client.notice({ type: "relay", sessionId: id, version: written.version, lastSeq: written.lastSeq, event: notice });
        continue;
      }
      frame ??= this.source.frame(commit);
      if (!client.send(frame)) continue;
      for (const notice of announced) client.notice({ type: "relay", sessionId: id, version: frame.version, lastSeq: frame.lastSeq, event: notice });
    }
  }
  /** A newer list of waiting approvals and questions for every subscription; never throws. */
  attentionChanged(frame: AttentionFrame): void { for (const client of [...this.clients]) client.attention(frame); }
  close(): void { if (this.closed) return; this.closed = true; for (const client of [...this.clients]) client.close(); }
}

class StreamClient {
  /** The version and the watermark of the conversation this connection has been told. */
  version = -1;
  lastSeq = -1;
  private closed = false;
  private paused = false;
  private dirty = false;
  private attentionRevision = -1;
  private pendingAttention: AttentionFrame | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private ttl: ReturnType<typeof setTimeout> | null = null;
  private stalled: ReturnType<typeof setTimeout> | null = null;
  private readonly gone = (): void => this.close();
  private readonly drain = (): void => {
    if (this.closed) return;
    this.paused = false;
    if (this.stalled !== null) clearTimeout(this.stalled); this.stalled = null;
    if (!this.dirty) { const attention = this.pendingAttention; this.pendingAttention = null; if (attention !== null) this.attention(attention); return; }
    this.dirty = false;
    // The application-owned reader applies its fail-closed storage handling before this transport callback isolates the connection.
    try { this.send({ type: "snapshot", session: this.hub.snapshot(this.id) }); }
    catch (error) { this.hub.recordReadFailure(this.id, error); this.close(); return; }
    const attention = this.pendingAttention; this.pendingAttention = null;
    if (attention !== null) this.attention(attention);
  };
  constructor(readonly id: SessionId, private readonly sink: SessionStreamSink, private readonly hub: SessionStreamHub, private readonly release: () => void) {
    sink.on("close", this.gone); sink.on("error", this.gone); sink.on("drain", this.drain);
  }
  start(ttlMs: number): void {
    this.ttl = setTimeout(this.gone, ttlMs); this.ttl.unref();
    this.heartbeat = setInterval(() => { if (!this.closed && !this.paused) this.write(": heartbeat\n\n"); }, this.hub.heartbeatMs); this.heartbeat.unref();
  }
  /** Whether the frame was written (it is not into a connection that is backed up: that one is told the conversation when it drains). */
  send(frame: Exclude<SessionStreamFrameV14, RelayStreamFrame>): boolean {
    if (this.closed) return false;
    const head = frame.type === "snapshot" ? frame.session.head : frame;
    // What the connection has been told is not told again.
    if (head.version <= this.version) return false;
    if (this.paused) { this.dirty = true; return false; }
    // write(false) still accepted this frame; subsequent output is replaced by one dirty snapshot marker.
    this.version = head.version; this.lastSeq = head.lastSeq;
    this.write("id: " + head.lastSeq + "\nevent: session\ndata: " + JSON.stringify(frame) + "\n\n");
    return true;
  }
  /** This connection is not at the version before a commit: it is told the conversation, now or when it can be written to. */
  stale(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.paused) return;
    this.dirty = false;
    try { this.send({ type: "snapshot", session: this.hub.snapshot(this.id) }); }
    catch (error) { this.hub.recordReadFailure(this.id, error); this.close(); }
  }
  /**
   * The notice of a relay event: only straight after the facts it follows (same watermark) and never into a backed-up
   * connection, whose snapshot comes later and carries the facts anyway. It moves nothing the cursor knows.
   */
  notice(frame: RelayStreamFrame): void {
    if (this.closed || this.paused || frame.lastSeq !== this.lastSeq) return;
    this.write("id: " + frame.lastSeq + "\nevent: session\ndata: " + JSON.stringify(frame) + "\n\n");
  }
  /** The newest list only; a paused subscription keeps the latest until it drains. */
  attention(frame: AttentionFrame): void {
    if (this.closed || frame.revision <= this.attentionRevision) return;
    if (this.paused) { this.pendingAttention = frame; return; }
    this.attentionRevision = frame.revision;
    this.write("event: attention\ndata: " + JSON.stringify(frame) + "\n\n");
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
