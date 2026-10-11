import type { PublicMessage, PublicRun } from "../../src/contracts/session.js";
import type { SessionStreamFrame, SessionView } from "../../src/contracts/web.js";

const DEFAULT_FRAME_BYTES = 8 * 1024 * 1024;
const identities = {
  session: /^session-[a-zA-Z0-9-]{1,96}$/u,
  run: /^run-[a-zA-Z0-9-]{1,96}$/u,
  message: /^message-[a-zA-Z0-9-]{1,96}$/u,
};

/** A malformed stream requires a new facts connection, never a repeated user command. */
export class SessionStreamError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SessionStreamError"; }
}
export interface SessionEventStreamOptions {
  readonly signal: AbortSignal;
  readonly decode: (value: unknown) => SessionStreamFrame;
  readonly onFrame: (frame: SessionStreamFrame) => void | Promise<void>;
  readonly maxFrameBytes?: number;
}
function invalid(message: string): never { throw new SessionStreamError("STREAM_INVALID_FRAME", message); }
function stateError(message: string): never { throw new SessionStreamError("STREAM_STATE", message); }
function identity(value: string, kind: keyof typeof identities): void {
  if (typeof value !== "string" || !identities[kind].test(value)) invalid("Invalid stream " + kind + " identity");
}
function watermark(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid("Invalid stream watermark");
}
function envelope(frame: SessionStreamFrame): { id: string; version: number; lastSeq: number } {
  if (frame === null || typeof frame !== "object") invalid("Invalid stream frame");
  if (frame.type !== "snapshot" && frame.type !== "message" && frame.type !== "run") invalid("Unknown stream frame type");
  const value = frame.type === "snapshot" ? frame.session : frame;
  if (value === null || typeof value !== "object") invalid("Invalid stream frame facts");
  const id = frame.type === "snapshot" ? frame.session.id : frame.sessionId;
  identity(id, "session"); watermark(value.version); watermark(value.lastSeq);
  if (value.version > value.lastSeq) invalid("Stream version is ahead of its watermark");
  return { id, version: value.version, lastSeq: value.lastSeq };
}

/** Incremental UTF-8 SSE reader. Owns its reader until cancellation settles and always releases the lock. */
export async function consumeSessionEventStream(body: ReadableStream<Uint8Array>, options: SessionEventStreamOptions): Promise<void> {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > DEFAULT_FRAME_BYTES) {
    throw new SessionStreamError("STREAM_LIMIT", "Invalid session stream frame budget");
  }
  const reader = body.getReader();
  let consumerAbort: (() => void) | null = null;
  const aborted = (): DOMException => new DOMException("Session stream was aborted", "AbortError");
  const parser = new SessionSseParser(maxFrameBytes, options.decode, async frame => {
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
  private frameBytes = 0;
  private skipLf = false;
  private firstLine = true;
  private event = "";
  private id: string | null = null;
  private data: string[] = [];
  private hasFields = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  constructor(private readonly maxBytes: number, private readonly decode: SessionEventStreamOptions["decode"],
    private readonly consume: SessionEventStreamOptions["onFrame"]) {}
  private budget(bytes: number): void {
    this.frameBytes += bytes;
    if (this.frameBytes > this.maxBytes) throw new SessionStreamError("STREAM_LIMIT", "Session stream frame exceeds its byte budget");
  }
  private append(bytes: Uint8Array): void {
    if (!bytes.length) return;
    const needed = this.lineLength + bytes.length;
    if (needed > this.line.length) {
      const grown = new Uint8Array(Math.min(this.maxBytes, Math.max(needed, this.line.length * 2, 256)));
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
        if (byte === 10) { this.budget(1); start = index + 1; }
        const consumed = this.consumeLine(); if (consumed !== undefined) await consumed;
        if (byte === 10) continue;
      }
      if (byte !== 10 && byte !== 13) continue;
      this.budget(index - start + 1); this.append(bytes.subarray(start, index)); start = index + 1;
      if (byte === 13) this.skipLf = true;
      else { const consumed = this.consumeLine(); if (consumed !== undefined) await consumed; }
    }
    this.budget(bytes.length - start); this.append(bytes.subarray(start));
  }
  private consumeLine(): void | Promise<void> {
    let line: string;
    try { line = this.decoder.decode(this.line.subarray(0, this.lineLength)); }
    catch { invalid("Session stream contains invalid UTF-8"); }
    this.lineLength = 0;
    if (this.firstLine) { this.firstLine = false; if (line.startsWith("\uFEFF")) line = line.slice(1); }
    if (line === "") {
      let frame: SessionStreamFrame | null = null;
      if (this.data.length) {
        if (this.event !== "session" || this.id === null || !/^(0|[1-9][0-9]*)$/u.test(this.id)) invalid("Invalid session SSE event or identity");
        const id = Number(this.id); watermark(id);
        let value: unknown;
        try { value = JSON.parse(this.data.join("\n")); } catch { invalid("Session SSE event contains invalid JSON"); }
        frame = this.decode(value);
        if (envelope(frame).lastSeq !== id) invalid("Session SSE identity disagrees with its facts watermark");
      }
      this.frameBytes = 0; this.event = ""; this.id = null; this.data = []; this.hasFields = false;
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

function validateMessage(message: PublicMessage, throughSeq: number): void {
  identity(message.id, "message"); identity(message.runId, "run"); watermark(message.seq);
  if (message.seq < 1 || message.seq > throughSeq || (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string") {
    invalid("Invalid stream message facts");
  }
}
function validateSnapshot(session: SessionView): void {
  watermark(session.epoch);
  if (session.epoch < 1 || session.messages.length > 1024 || session.runs.length > 256 || session.switches.length > 1024) invalid("Invalid session snapshot bounds");
  const runs = new Map<string, PublicRun>(session.runs.map(run => [run.id, run]));
  const reserved = new Set<string>();
  if (runs.size !== session.runs.length) invalid("Session snapshot repeats a Run identity");
  for (const run of session.runs) {
    identity(run.id, "run"); identity(run.userMessageId, "message"); identity(run.assistantMessageId, "message");
    if (reserved.has(run.userMessageId) || reserved.has(run.assistantMessageId) || run.userMessageId === run.assistantMessageId) invalid("Session snapshot repeats a message identity");
    reserved.add(run.userMessageId); reserved.add(run.assistantMessageId);
    watermark(run.epoch);
    if (run.epoch < 1 || run.epoch > session.epoch) invalid("Session Run epoch disagrees with its snapshot");
  }
  let seq = 0;
  const messageIds = new Set<string>();
  const users = new Map<string, PublicMessage>();
  for (const message of session.messages) {
    validateMessage(message, session.lastSeq);
    const run = runs.get(message.runId);
    if (messageIds.has(message.id) || message.seq <= seq || run === undefined || message.id !== (message.role === "user" ? run.userMessageId : run.assistantMessageId) || message.status !== run.status) {
      invalid("Session snapshot message ownership or order is inconsistent");
    }
    seq = message.seq;
    messageIds.add(message.id);
    if (message.role === "user") users.set(message.runId, message);
  }
  for (const run of session.runs) if (users.get(run.id)?.text !== run.input) invalid("Session snapshot lost a Run input");
  if (session.activeRunId !== null) {
    identity(session.activeRunId, "run");
    const active = runs.get(session.activeRunId);
    if (active === undefined || !["preparing", "running", "settling"].includes(active.status)) invalid("Session snapshot has an inconsistent active Run");
  }
}

/** Applies canonical facts without appending text twice. Sequence gaps in message frames require a snapshot. */
export function applySessionStreamFrame(current: SessionView | null, frame: SessionStreamFrame, expectedSessionId: string): SessionView {
  identity(expectedSessionId, "session");
  const next = envelope(frame);
  if (next.id !== expectedSessionId || (current !== null && current.id !== expectedSessionId)) stateError("Session stream facts belong to another Session");
  if (current !== null) {
    watermark(current.version); watermark(current.lastSeq);
    if (next.lastSeq < current.lastSeq) {
      if (next.version >= current.version) stateError("Older stream facts have an inconsistent version");
      return current;
    }
    if (next.lastSeq === current.lastSeq) {
      if (next.version !== current.version) stateError("Stream watermark has conflicting versions");
      return current;
    }
    if (next.version <= current.version || next.version - current.version > next.lastSeq - current.lastSeq) stateError("New stream facts have an inconsistent version");
  }
  if (frame.type === "snapshot") { validateSnapshot(frame.session); return frame.session; }
  if (current === null) stateError("A message frame requires a canonical Session snapshot");
  if (frame.lastSeq !== current.lastSeq + 1 || frame.version !== current.version + 1) stateError("A message frame crossed missing Session facts");
  if (frame.type === "run") {
    const prior = current.runs.find(run => run.id === frame.run.id);
    // Only the active Run's native activity changes in a run frame; identity, input, selection and epoch are immutable.
    if (prior === undefined || current.activeRunId !== prior.id || !["running", "settling"].includes(frame.run.status) || frame.run.status !== prior.status ||
        frame.run.commandId !== prior.commandId || frame.run.input !== prior.input || frame.run.userMessageId !== prior.userMessageId || frame.run.assistantMessageId !== prior.assistantMessageId ||
        frame.run.epoch !== prior.epoch || JSON.stringify(frame.run.selection) !== JSON.stringify(prior.selection) || JSON.stringify(frame.run.attachments) !== JSON.stringify(prior.attachments)) stateError("Stream run frame does not belong to the active Run");
    return { ...current, version: frame.version, lastSeq: frame.lastSeq, runs: current.runs.map(run => run.id === prior.id ? frame.run : run) };
  }
  validateMessage(frame.message, frame.lastSeq);
  const run = current.runs.find(run => run.id === frame.message.runId);
  if (run === undefined || current.activeRunId !== run.id || run.status !== "running" || frame.message.status !== "running" ||
      frame.message.role !== "assistant" || frame.message.id !== run.assistantMessageId) stateError("Stream message does not belong to the active Run");
  const previous = current.messages.find(message => message.id === frame.message.id);
  if (previous !== undefined && (previous.runId !== frame.message.runId || previous.role !== frame.message.role || previous.seq !== frame.message.seq || !frame.message.text.startsWith(previous.text))) {
    stateError("Stream message changed already committed text or identity");
  }
  if (previous === undefined && (frame.message.seq !== frame.lastSeq || current.messages.some(message => message.seq >= frame.message.seq))) {
    stateError("Stream message creation order is inconsistent");
  }
  const messages = previous === undefined ? [...current.messages, frame.message] : current.messages.map(message => message.id === frame.message.id ? frame.message : message);
  return { ...current, version: frame.version, lastSeq: frame.lastSeq, messages };
}
