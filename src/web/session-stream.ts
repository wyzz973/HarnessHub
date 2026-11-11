import { SessionError, type SessionEvent, type SessionId } from "../contracts/session.js";
import { RELAY_STREAM_EVENTS, type AttentionFrame, type RelayStreamEvent, type RelayStreamEventType, type RelayStreamFrame, type SessionStreamFrame, type SessionView } from "../contracts/web.js";

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
/** Production defaults are fixed by ADR-013; smaller test limits exercise the same rejection paths. */
export interface SessionStreamLimits {
  readonly maxConnections?: number;
  readonly maxFrameBytes?: number;
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
function water(frame: SessionStreamFrame): number { return frame.type === "snapshot" ? frame.session.lastSeq : frame.lastSeq; }

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
  readonly maxFrameBytes: number;
  readonly heartbeatMs: number;
  readonly connectionTtlMs: number;
  readonly drainTimeoutMs: number;
  readonly now: () => number;
  /**
   * `attention`, when given, is the current list of waiting approvals and questions (ADR-035): every subscription carries it
   * as `event: attention` frames without an event id, so a page with a conversation open needs no second long-lived connection.
   */
  constructor(private readonly read: (id: SessionId) => SessionView, options: SessionStreamLimits = {}, private readonly reportReadFailure?: (failure: SessionStreamReadFailure) => void,
    private readonly attention?: () => AttentionFrame) {
    this.maxConnections = limit(options.maxConnections, 8); this.maxFrameBytes = limit(options.maxFrameBytes, 8 * 1024 * 1024);
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
      if (cursor > snapshot.lastSeq) throw new SessionStreamError(409, "CURSOR_CONFLICT", "Session stream cursor is ahead of committed facts");
      const ttl = Math.min(openedAt + this.connectionTtlMs, loginExpires) - this.now();
      if (ttl <= 0) throw new SessionStreamError(401, "AUTH_REQUIRED", "Session subscription login expired before its initial facts were ready");
      ready(); started = true; client.start(ttl); client.send({ type: "snapshot", session: snapshot });
      if (this.attention) client.attention(this.attention());
    } catch (error) { client.close(started); throw error; }
  }
  snapshot(id: SessionId): SessionView {
    const snapshot = this.read(id);
    if (snapshot.id !== id || !Number.isSafeInteger(snapshot.lastSeq) || snapshot.lastSeq < 0) throw new SessionError("INVALID_DATA", "session stream read has inconsistent identity or watermark");
    return snapshot;
  }
  /** Authoritative reads may fail closed; every transport write/error is isolated within its subscription. */
  publish(event: SessionEvent): void {
    // A relay event is also announced to a subscription that already holds its facts: several events of one commit are
    // published one by one, and the first one's snapshot already carried the commit's latest facts.
    const announced = relayStreamEvent(event);
    const clients = [...this.clients].filter(client => client.id === event.sessionId && (client.lastSeq < event.seq || announced !== undefined));
    if (!clients.length) return;
    const session = this.snapshot(event.sessionId);
    if (session.lastSeq < event.seq) throw new SessionError("INVALID_DATA", "publication is ahead of committed session facts");
    const output = event.type === "run.output" && event.data.event !== null && typeof event.data.event === "object" &&
      "type" in event.data.event && event.data.event.type === "text" && typeof event.data.runId === "string";
    const message = output && session.lastSeq === event.seq ? session.messages.find(item => item.role === "assistant" && item.runId === event.data.runId) : undefined;
    // Non-text activity of the active Run replaces that Run only; everything else stays a canonical snapshot.
    const activity = !output && (event.type === "run.output" || event.type === "run.tool_detail") && typeof event.data.runId === "string" && session.lastSeq === event.seq && session.activeRunId === event.data.runId
      ? session.runs.find(item => item.id === event.data.runId) : undefined;
    const frame: SessionStreamFrame = message !== undefined ? { type: "message", sessionId: session.id, version: session.version, lastSeq: session.lastSeq, message }
      : activity !== undefined ? { type: "run", sessionId: session.id, version: session.version, lastSeq: session.lastSeq, run: activity } : { type: "snapshot", session };
    const notice: RelayStreamFrame | undefined = announced === undefined ? undefined : { type: "relay", sessionId: session.id, version: session.version, lastSeq: session.lastSeq, event: announced };
    for (const client of clients) { client.send(frame); if (notice !== undefined) client.notice(notice); }
  }
  /** A newer list of waiting approvals and questions for every subscription; never throws. */
  attentionChanged(frame: AttentionFrame): void { for (const client of [...this.clients]) client.attention(frame); }
  close(): void { if (this.closed) return; this.closed = true; for (const client of [...this.clients]) client.close(); }
}

class StreamClient {
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
  send(frame: SessionStreamFrame): void {
    if (this.closed || water(frame) <= this.lastSeq) return;
    if (this.paused) { this.dirty = true; return; }
    const text = "id: " + water(frame) + "\nevent: session\ndata: " + JSON.stringify(frame) + "\n\n";
    if (Buffer.byteLength(text, "utf8") > this.hub.maxFrameBytes) { this.close(); return; }
    // write(false) still accepted this frame; subsequent output is replaced by one dirty snapshot marker.
    this.lastSeq = water(frame); this.write(text);
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
