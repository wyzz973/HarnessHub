import type { ClientStreamFrame } from "./lib/protocol/wire.js";
import { applyCommit, replaceWithSnapshot, type WindowState } from "./lib/protocol/window.js";

/*
 * The page's end of a conversation's stream (ADR-057 3.4): the server-sent events are read incrementally and each frame is handed on as it is complete. A connection starts with
 * the conversation (a snapshot of its head and newest Turns) and goes on with one commit frame for each commit; `applyStreamFrame` moves the page's window along with them. No frame
 * is refused for its size: a frame is as large as what one commit wrote, which the Gateway has already bounded by what it carries (a text too long for a frame is left out of it and read by range).
 */
const identities = {
  session: /^session-[a-zA-Z0-9-]{1,96}$/u,
};

/** A malformed stream requires a new facts connection, never a repeated user command. */
export class SessionStreamError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SessionStreamError"; }
}
export interface SessionEventStreamOptions {
  readonly signal: AbortSignal;
  readonly decode: (value: unknown) => ClientStreamFrame;
  readonly onFrame: (frame: ClientStreamFrame) => void | Promise<void>;
  /** Waiting approvals and questions the stream carries alongside (`event: attention`, no event id; ADR-035); ignored when absent. */
  readonly onAttention?: (value: unknown) => void;
  /**
   * Relay events a stream carries as `event: relay` (`{ type: "relay", event }`, with or without an id), alongside the session's
   * facts: they say the relay's state changed, never move the conversation's cursor, and are ignored when this is absent. The
   * Gateway sends its notices as session frames (`type: "relay"`, the watermark of the facts they follow), which `decode` reads
   * and `onFrame` takes like any frame.
   */
  readonly onRelay?: (value: unknown) => void;
}
function invalid(message: string): never { throw new SessionStreamError("STREAM_INVALID_FRAME", message); }
function stateError(message: string): never { throw new SessionStreamError("STREAM_STATE", message); }
function identity(value: string, kind: keyof typeof identities): void {
  if (typeof value !== "string" || !identities[kind].test(value)) invalid("Invalid stream " + kind + " identity");
}
function watermark(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid("Invalid stream watermark");
}
/** Whose frame it is and where it stands: the watermark the SSE identity must agree with. */
function envelope(frame: ClientStreamFrame): { id: string; version: number; lastSeq: number } {
  if (frame === null || typeof frame !== "object") invalid("Invalid stream frame");
  if (frame.type !== "snapshot" && frame.type !== "commit" && frame.type !== "relay") invalid("Unknown stream frame type");
  const value = frame.type === "snapshot" ? frame.session.head : frame;
  if (value === null || typeof value !== "object") invalid("Invalid stream frame facts");
  const id = frame.type === "snapshot" ? frame.session.head.id : frame.sessionId;
  identity(id, "session"); watermark(value.version); watermark(value.lastSeq);
  return { id, version: value.version, lastSeq: value.lastSeq };
}

/** Incremental UTF-8 SSE reader. Owns its reader until cancellation settles and always releases the lock. */
export async function consumeSessionEventStream(body: ReadableStream<Uint8Array>, options: SessionEventStreamOptions): Promise<void> {
  const reader = body.getReader();
  let consumerAbort: (() => void) | null = null;
  const aborted = (): DOMException => new DOMException("Session stream was aborted", "AbortError");
  const parser = new SessionSseParser(options.decode, options.onAttention, options.onRelay, async frame => {
    if (options.signal.aborted) throw aborted();
    // One current consumer slot avoids retaining one abort-promise reaction for every emitted frame.
    await new Promise<void>((resolve, reject) => {
      consumerAbort = () => reject(aborted());
      try { Promise.resolve(options.onFrame(frame)).then(resolve, reject); }
      catch (error) { reject(error); }
      if (options.signal.aborted) consumerAbort();
    }).finally(() => { consumerAbort = null; });
    if (options.signal.aborted) throw aborted();
  });
  const cancellation: { pending: Promise<{ ok: true } | { ok: false; error: unknown }> | null } = { pending: null };
  const cancel = (reason: unknown): void => {
    if (cancellation.pending !== null) return;
    try { cancellation.pending = reader.cancel(reason).then(() => ({ ok: true as const }), error => ({ ok: false as const, error })); }
    catch (error) { cancellation.pending = Promise.resolve({ ok: false, error }); }
  };
  const abort = (): void => { cancel(aborted()); consumerAbort?.(); };
  options.signal.addEventListener("abort", abort, { once: true });
  let ended = false;
  let failure: { error: unknown } | null = null;
  const cleanupErrors: unknown[] = [];
  try {
    if (options.signal.aborted) abort();
    while (true) {
      if (options.signal.aborted) throw aborted();
      const part = await reader.read();
      if (options.signal.aborted) throw aborted();
      if (part.done) { await parser.finish(); ended = true; break; }
      if (!(part.value instanceof Uint8Array)) invalid("Session stream did not return bytes");
      await parser.feed(part.value);
    }
  } catch (error) { failure = { error }; }
  finally {
    options.signal.removeEventListener("abort", abort);
    consumerAbort = null;
    if (!ended) cancel(failure?.error);
    const result = await cancellation.pending;
    if (result !== null && !result.ok) cleanupErrors.push(result.error);
    try { reader.releaseLock(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure === null ? [] : [failure.error]), ...cleanupErrors], "Session stream cleanup failed");
  if (failure !== null) throw failure.error;
}

/** One bounded byte-line buffer; no queue of frames survives the awaited consumer. */
class SessionSseParser {
  private line = new Uint8Array(0);
  private lineLength = 0;
  private skipLf = false;
  private firstLine = true;
  private event = "";
  private id: string | null = null;
  private data: string[] = [];
  private hasFields = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  constructor(private readonly decode: SessionEventStreamOptions["decode"],
    private readonly attention: SessionEventStreamOptions["onAttention"], private readonly relay: SessionEventStreamOptions["onRelay"], private readonly consume: SessionEventStreamOptions["onFrame"]) {}
  private append(bytes: Uint8Array): void {
    if (!bytes.length) return;
    const needed = this.lineLength + bytes.length;
    if (needed > this.line.length) {
      const grown = new Uint8Array(Math.max(needed, this.line.length * 2, 256));
      grown.set(this.line.subarray(0, this.lineLength)); this.line = grown;
    }
    this.line.set(bytes, this.lineLength); this.lineLength = needed;
  }
  async feed(bytes: Uint8Array): Promise<void> {
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (this.skipLf) {
        this.skipLf = false;
        if (byte === 10) start = index + 1;
        const consumed = this.consumeLine(); if (consumed !== undefined) await consumed;
        if (byte === 10) continue;
      }
      if (byte !== 10 && byte !== 13) continue;
      this.append(bytes.subarray(start, index)); start = index + 1;
      if (byte === 13) this.skipLf = true;
      else { const consumed = this.consumeLine(); if (consumed !== undefined) await consumed; }
    }
    this.append(bytes.subarray(start));
  }
  private consumeLine(): void | Promise<void> {
    let line: string;
    try { line = this.decoder.decode(this.line.subarray(0, this.lineLength)); }
    catch { invalid("Session stream contains invalid UTF-8"); }
    this.lineLength = 0;
    if (this.firstLine) { this.firstLine = false; if (line.startsWith("\uFEFF")) line = line.slice(1); }
    if (line === "") {
      let frame: ClientStreamFrame | null = null;
      if (this.data.length && this.event === "attention") {
        // Carried alongside the session's facts; it never moves the session cursor.
        let value: unknown;
        try { value = JSON.parse(this.data.join("\n")); } catch { invalid("Attention SSE event contains invalid JSON"); }
        this.event = ""; this.id = null; this.data = []; this.hasFields = false;
        this.attention?.(value); return;
      }
      if (this.data.length && this.event === "relay") {
        // Relay events are carried the same way: no cursor, and one that is not valid JSON is dropped rather than ending the stream.
        let value: unknown;
        try { value = JSON.parse(this.data.join("\n")); } catch { value = undefined; }
        this.event = ""; this.id = null; this.data = []; this.hasFields = false;
        if (value !== undefined) this.relay?.(value);
        return;
      }
      if (this.data.length) {
        if (this.event !== "session" || this.id === null || !/^(0|[1-9][0-9]*)$/u.test(this.id)) invalid("Invalid session SSE event or identity");
        const id = Number(this.id); watermark(id);
        let value: unknown;
        try { value = JSON.parse(this.data.join("\n")); } catch { invalid("Session SSE event contains invalid JSON"); }
        // A relay notice is a frame like the others: its envelope is the watermark of the facts it follows, which it leaves where they are.
        frame = this.decode(value);
        if (envelope(frame).lastSeq !== id) invalid("Session SSE identity disagrees with its facts watermark");
      }
      this.event = ""; this.id = null; this.data = []; this.hasFields = false;
      return frame === null ? undefined : this.consume(frame);
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data": this.data.push(value); this.hasFields = true; break;
      case "id": this.id = value; this.hasFields = true; break;
      case "event": this.event = value; this.hasFields = true; break;
      // Retry policy belongs to the API owner; SSE unknown fields and comments have no facts effect.
      default: break;
    }
  }
  async finish(): Promise<void> {
    if (this.skipLf) { this.skipLf = false; await this.consumeLine(); }
    if (this.lineLength || this.hasFields) throw new SessionStreamError("STREAM_TRUNCATED", "Session stream ended with an incomplete frame");
  }
}

/**
 * What a frame did to the page's conversation: its state afterwards (the same state when the frame was not about it: a notice of the relay, a frame it already had), or that the page cannot
 * follow it and must take the conversation again (`resync`: a commit is missing, a text does not begin where the held one ends). It never guesses.
 */
export type StreamStep = { readonly kind: "state"; readonly state: WindowState } | { readonly kind: "resync"; readonly reason: string };
export function applyStreamFrame(current: WindowState | null, frame: ClientStreamFrame, expectedSessionId: string): StreamStep {
  identity(expectedSessionId, "session");
  const next = envelope(frame);
  if (next.id !== expectedSessionId || (current !== null && current.head.id !== expectedSessionId)) stateError("Session stream facts belong to another Session");
  if (frame.type === "snapshot") return { kind: "state", state: replaceWithSnapshot(current, frame.session) };
  // A notice that a relay event happened carries no facts of the conversation (the caller reads its event first); a commit needs the conversation it follows.
  if (current === null) stateError("A " + frame.type + " frame requires a canonical Session snapshot");
  if (frame.type === "relay") return { kind: "state", state: current };
  const applied = applyCommit(current, frame);
  return applied.kind === "resync" ? { kind: "resync", reason: applied.reason } : { kind: "state", state: applied.state };
}
