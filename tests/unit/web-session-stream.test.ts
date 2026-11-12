import assert from "node:assert/strict";
import test from "node:test";
import type { ReadItem } from "../../src/contracts/protocol-read.js";
import { applyStreamFrame, consumeSessionEventStream, SessionStreamError } from "../../web/src/session-stream.js";
import { openWindow, type WindowState } from "../../web/src/lib/protocol/window.js";
import { decodeSessionStreamFrameV14, type ClientCommitFrame, type ClientRun, type ClientSessionView, type ClientStreamFrame } from "../../web/src/lib/protocol/wire.js";

// The page's end of the stream: server-sent events read incrementally in any chunking, and the frames of a conversation (a snapshot, a commit for each commit, a relay notice) applied to the
// part of the conversation the page holds (web/src/lib/protocol/window.ts).
const SESSION = "session-stream", selection = { harnessId: "codex", controlId: "codex-native" };
const facts = { unknown: { count: 0, unclosed: false }, settled: false, branchable: null, ran: [], changes: 0 };
const encoder = new TextEncoder();
/** A running Turn that has your words and, when `withReply`, the first of its reply; at version 3 or 2. */
function snapshot(withReply = true): ClientSessionView {
  const run = { id: "run-stream", commandId: "send-stream", userMessageId: "message-user-stream", assistantMessageId: "message-assistant-stream", selection, epoch: 1, status: "running", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [],
    backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, ordinal: 0, userSeq: 2,
    turn: { version: "hh/1", runId: "run-stream", n: 1, status: "running", executor: { harnessId: "codex", harness: "Codex" }, usage: { completeness: "unavailable" } } } as unknown as ClientRun;
  const items = [{ id: "user", seq: 1, status: "completed", type: "user_message", messageId: "message-user-stream", text: "问题" },
    ...(withReply ? [{ id: "text:1", seq: 2, status: "running", type: "assistant_message", messageId: "message-assistant-stream", phase: "commentary", text: "你好" }] : [])] as unknown as ReadItem[];
  return { head: { id: SESSION, version: withReply ? 3 : 2, lastSeq: withReply ? 5 : 4, epoch: 1, status: "open", workspace: "/workspace", selection, activeRunId: "run-stream", pendingSwitchId: null, title: "问题", runCount: 1, facts },
    window: { turns: [{ run, items }], older: null } };
}
/** The reply goes on: `text` is appended at byte `from` of the reply (the bytes of what the snapshot holds when none is given). */
function commitFrame(base = snapshot(), text = "，世界 🌏", from = new TextEncoder().encode("你好").length): ClientCommitFrame {
  return { type: "commit", sessionId: base.head.id, version: base.head.version + 1, lastSeq: base.head.lastSeq + 1, texts: [{ runId: "run-stream", itemSeq: 2, from, text }] };
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture decoder rejected unknown frame");
  return value as Record<string, unknown>;
}
// The page's own decoder is the production one; byte framing and the reducer are the production implementation too.
const decode = (value: unknown): ClientStreamFrame => decodeSessionStreamFrameV14(value);
function sse(frame: ClientStreamFrame, ending = "\n", pretty = false): string {
  const id = frame.type === "snapshot" ? frame.session.head.lastSeq : frame.lastSeq;
  const payload = JSON.stringify(frame, null, pretty ? 2 : undefined).split("\n").map(line => "data: " + line).join(ending);
  return "event: session" + ending + "id: " + id + ending + payload + ending + ending;
}
function bytesStream(chunks: readonly Uint8Array[], cancel?: (reason: unknown) => void | Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); }, ...(cancel === undefined ? {} : { cancel }) });
}
async function read(chunks: readonly Uint8Array[]): Promise<ClientStreamFrame[]> {
  const frames: ClientStreamFrame[] = [], stream = bytesStream(chunks);
  await consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame: frame => { frames.push(frame); } });
  assert.equal(stream.locked, false); return frames;
}
function isCode(code: string): (error: unknown) => boolean { return error => error instanceof SessionStreamError && error.code === code; }
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function abortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }

test("SSE delivers committed content while the source is still open", async () => {
  const arrived = deferred(), frame = commitFrame();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  let finished = false;
  const pending = consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame: value => { assert.deepEqual(value, frame); arrived.resolve(); } }).then(() => { finished = true; });
  source!.enqueue(encoder.encode(sse(frame))); await arrived.promise;
  assert.equal(finished, false); assert.equal(stream.locked, true);
  source!.close(); await pending; assert.equal(stream.locked, false);
});
test("UTF-8 characters and SSE framing survive every two-chunk split", async () => {
  const frame = commitFrame(snapshot(), "，世界 🌏 e\u0301"), bytes = encoder.encode("\uFEFF" + sse(frame, "\r\n"));
  for (let offset = 0; offset <= bytes.length; offset++) assert.deepEqual(await read([bytes.subarray(0, offset), bytes.subarray(offset)]), [frame]);
});
test("LF, CR and CRLF accept one-byte chunks, multiline JSON, comments and unknown SSE fields", async () => {
  const frame: ClientStreamFrame = { type: "snapshot", session: snapshot() };
  for (const ending of ["\n", "\r", "\r\n"]) {
    const body: string = "\uFEFF: heartbeat" + ending + "retry: 1000" + ending + "unknown: ignored" + ending + ending + sse(frame, ending, true);
    assert.deepEqual(await read(Array.from(encoder.encode(body), byte => new Uint8Array([byte]))), [frame]);
  }
});
test("a BOM is accepted only at the beginning and never silently repairs later fields", async () => {
  await assert.rejects(read([encoder.encode(": comment\n\uFEFF" + sse(commitFrame()))]), isCode("STREAM_INVALID_FRAME"));
});
test("no frame is refused for its size: a frame of a megabyte and a line of two are read whole, in any chunking", async () => {
  const big = commitFrame(snapshot(), "字".repeat(350_000)), encoded = encoder.encode(sse(big, "\r\n"));
  assert.ok(encoded.length > 1024 * 1024);
  assert.deepEqual(await read([encoded]), [big]);
  assert.deepEqual(await read([encoded.subarray(0, 700_001), encoded.subarray(700_001)]), [big]);
  const huge = commitFrame(snapshot(), "x".repeat(9 * 1024 * 1024)), many = await read([encoder.encode(sse(huge) + sse(huge))]);
  assert.equal(many.length, 2);
});
test("SSE identity must be explicit, canonical, safe and equal to the decoded facts watermark", async () => {
  const frame = commitFrame(), valid = sse(frame);
  for (const body of [valid.replace("id: 6\n", ""), valid.replace("id: 6", "id: -1"), valid.replace("id: 6", "id: 06"),
    valid.replace("id: 6", "id: 6.0"), valid.replace("id: 6", "id: 9007199254740992"), valid.replace("id: 6", "id: 7"),
    valid.replace("id: 6", "id: 6\u0000"), valid.replace("event: session\n", ""), valid.replace("event: session", "event: foreign")]) {
    await assert.rejects(read([encoder.encode(body)]), isCode("STREAM_INVALID_FRAME"));
  }
});
test("empty data and invalid JSON fail without disclosing the payload", async () => {
  for (const body of ["event: session\nid: 6\ndata:\n\n", "event: session\nid: 6\ndata: secret-not-json\n\n"]) {
    await assert.rejects(read([encoder.encode(body)]), error => isCode("STREAM_INVALID_FRAME")(error) && error instanceof Error && !error.message.includes("secret-not-json"));
  }
});
test("unknown JSON is passed to the supplied decoder and its rejection is preserved", async () => {
  const sentinel = new Error("DTO decoder rejected frame"), stream = bytesStream([encoder.encode("event: session\nid: 0\ndata: {\"external\":true}\n\n")]);
  await assert.rejects(consumeSessionEventStream(stream, { signal: new AbortController().signal, decode(value) { assert.deepEqual(value, { external: true }); throw sentinel; }, onFrame() { assert.fail("invalid frame must not publish"); } }), error => error === sentinel);
  assert.equal(stream.locked, false);
});
test("invalid UTF-8 is rejected even in comments, while an unfinished byte line is truncated", async () => {
  for (const bytes of [new Uint8Array([58, 255, 10]), new Uint8Array([100, 97, 116, 97, 58, 226, 40, 161, 10])]) {
    await assert.rejects(read([bytes]), isCode("STREAM_INVALID_FRAME"));
  }
  await assert.rejects(read([new Uint8Array([100, 97, 116, 97, 58, 228, 184])]), isCode("STREAM_TRUNCATED"));
});
test("EOF never dispatches an unclosed frame or treats partial content as completion", async () => {
  const valid = sse(commitFrame());
  for (const body of [valid.slice(0, -1), valid.slice(0, -2), "id: 6\n", "event: session\n", ": half-comment"]) {
    await assert.rejects(read([encoder.encode(body)]), isCode("STREAM_TRUNCATED"));
  }
  assert.deepEqual(await read([encoder.encode(": heartbeat\n")]), []);
  assert.deepEqual(await read([encoder.encode("id: 6\nevent: session\n\n")]), []);
});
test("the reader awaits each frame consumer and retains no callback queue", async () => {
  const first = commitFrame(), second: ClientCommitFrame = { ...first, version: 5, lastSeq: 7, texts: [{ runId: "run-stream", itemSeq: 2, from: 20, text: "。" }] };
  const blocked = deferred(), entered = deferred(), values: ClientStreamFrame[] = [];
  const stream = bytesStream([encoder.encode(sse(first) + sse(second))]);
  const pending = consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, async onFrame(value) { values.push(value); if (values.length === 1) { entered.resolve(); await blocked.promise; } } });
  await entered.promise; assert.deepEqual(values, [first]); blocked.resolve(); await pending; assert.deepEqual(values, [first, second]); assert.equal(stream.locked, false);
});
test("abort before reading and while waiting for bytes cancels exactly once and releases ownership", async () => {
  for (const preAborted of [false, true]) {
    const control = new AbortController(); let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel(reason: unknown) { cancellations++; assert.ok(abortError(reason)); } });
    if (preAborted) control.abort();
    const pending = consumeSessionEventStream(stream, { signal: control.signal, decode, onFrame() { assert.fail("aborted reader must not deliver"); } });
    if (!preAborted) control.abort();
    await assert.rejects(pending, abortError); assert.equal(cancellations, 1); assert.equal(stream.locked, false);
  }
});
test("abort during a pending consumer stops later frames and awaits source cancellation", async () => {
  const entered = deferred(), consumer = deferred(), cleanup = deferred(), cancelled = deferred(), control = new AbortController(); let deliveries = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(commitFrame()) + sse(commitFrame()))); }, cancel() { cancelled.resolve(); return cleanup.promise; } });
  let settled = false;
  const pending = consumeSessionEventStream(stream, { signal: control.signal, decode, async onFrame() { deliveries++; entered.resolve(); await consumer.promise; } });
  const result = assert.rejects(pending, abortError).then(() => { settled = true; });
  await entered.promise; control.abort(); await cancelled.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(stream.locked, true); assert.equal(deliveries, 1);
  cleanup.resolve(); await result; assert.equal(stream.locked, false); consumer.resolve();
});
test("consumer failures cancel the open source and preserve the error", async () => {
  const sentinel = new Error("consumer failed"); let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(commitFrame()))); }, cancel() { cancellations++; } });
  await assert.rejects(consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame() { throw sentinel; } }), error => error === sentinel);
  assert.equal(cancellations, 1); assert.equal(stream.locked, false);
});
test("cleanup failure is reported alongside the frame failure and never leaves the reader locked", async () => {
  const primary = new Error("consumer failed"), cleanup = new Error("source cleanup failed");
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(commitFrame()))); }, cancel() { throw cleanup; } });
  await assert.rejects(consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame() { throw primary; } }), error => error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(cleanup));
  assert.equal(stream.locked, false);
});
test("an underlying transport failure releases the reader and retains its failure evidence", async () => {
  const transport = new Error("transport closed unexpectedly");
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(transport); } });
  await assert.rejects(consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame() { assert.fail("transport did not deliver a frame"); } }),
    error => error === transport || (error instanceof AggregateError && error.errors.includes(transport)));
  assert.equal(stream.locked, false);
});
test("late rejection of an aborted frame consumer cannot publish another frame or become unhandled", async () => {
  const entered = deferred(), control = new AbortController(); let deliveries = 0, rejectConsumer: (error: unknown) => void = () => {};
  const consumer = new Promise<void>((_, reject) => { rejectConsumer = reject; });
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(commitFrame()) + sse(commitFrame()))); } });
  const pending = consumeSessionEventStream(stream, { signal: control.signal, decode, onFrame() { deliveries++; entered.resolve(); return consumer; } });
  await entered.promise; control.abort(); await assert.rejects(pending, abortError);
  rejectConsumer(new Error("consumer completed after cancellation"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(deliveries, 1); assert.equal(stream.locked, false);
});

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
/** The page's conversation after a snapshot, as `applyStreamFrame` makes it. */
function held(view = snapshot()): WindowState { const step = applyStreamFrame(null, { type: "snapshot", session: view }, SESSION); assert.equal(step.kind, "state"); return (step as { state: WindowState }).state; }
const replyText = (state: WindowState): string => String((state.turns[0]!.items.find(entry => entry.item.type === "assistant_message")!.item as { text?: string }).text);
const next = (state: WindowState | null, frame: ClientStreamFrame) => applyStreamFrame(state, frame, SESSION);
const stateOf = (step: ReturnType<typeof next>): WindowState => { assert.equal(step.kind, "state", step.kind === "resync" ? step.reason : ""); return (step as { state: WindowState }).state; };

test("snapshot establishes the page's facts and a commit extends the reply at its byte, without a duplicate append", () => {
  const base = snapshot(), first = held(base);
  assert.deepEqual(plain(first.head), plain(base.head)); assert.equal(first.turns.length, 1); assert.equal(replyText(first), "你好");
  const frame = commitFrame(base), after = stateOf(next(first, frame));
  assert.equal(replyText(after), "你好，世界 🌏"); assert.equal(after.head.version, 4); assert.equal(after.head.lastSeq, 6); assert.equal(replyText(first), "你好", "the state it was given is whole");
  assert.equal(after.turns[0]!.items[0], first.turns[0]!.items[0], "what the frame did not touch is the same object");
  assert.equal(stateOf(next(after, frame)), after, "a frame the page already has changes nothing");
});
test("the first words of a reply come with the item that holds them, in one frame", () => {
  const base = snapshot(false), first = held(base);
  const frame: ClientCommitFrame = { type: "commit", sessionId: SESSION, version: 3, lastSeq: 5, items: [{ runId: "run-stream", item: { id: "text:1", seq: 2, status: "running", type: "assistant_message", messageId: "message-assistant-stream", phase: "commentary", text: "" } as unknown as ReadItem }],
    texts: [{ runId: "run-stream", itemSeq: 2, from: 0, text: "你好" }] };
  assert.equal(replyText(stateOf(next(first, frame))), "你好");
});
test("a commit that logged no event is the next commit and keeps the watermark", () => {
  const first = held(), frame: ClientCommitFrame = { type: "commit", sessionId: SESSION, version: 4, lastSeq: 5 };
  const after = stateOf(next(first, frame)); assert.equal(after.head.version, 4); assert.equal(after.head.lastSeq, 5);
  assert.equal(stateOf(next(after, { ...frame, version: 4 })), after); assert.equal(next(after, { ...frame, version: 6 }).kind, "resync");
});
test("a reconnect snapshot bridges missing facts, and an old snapshot or old frame cannot take the page back", () => {
  const base = snapshot(), first = held(base), frame = commitFrame(base), after = stateOf(next(first, frame));
  const done = snapshot(); const finished = { ...done, head: { ...done.head, version: 6, lastSeq: 9, activeRunId: null }, window: { ...done.window, turns: done.window.turns.map(turn => ({ ...turn, run: { ...turn.run, status: "completed" as const } })) } };
  const bridged = stateOf(next(after, { type: "snapshot", session: finished }));
  assert.equal(bridged.head.version, 6); assert.equal(bridged.turns[0]!.run.status, "completed");
  assert.equal(stateOf(next(bridged, frame)), bridged, "an old commit is ignored");
  assert.equal(stateOf(next(bridged, { type: "snapshot", session: base })), bridged, "an old snapshot is not used");
});
test("a frame of another Session, or for a page of another Session, fails; so does an identity that is none", () => {
  const base = snapshot(), first = held(base), frame = commitFrame(base);
  for (const value of [{ ...frame, sessionId: "session-other" }, { type: "snapshot" as const, session: { ...base, head: { ...base.head, id: "session-other" } } }]) assert.throws(() => next(first, value), isCode("STREAM_STATE"));
  assert.throws(() => next({ ...first, head: { ...first.head, id: "session-other" } }, frame), isCode("STREAM_STATE"));
  assert.throws(() => applyStreamFrame(first, frame, "invalid"), isCode("STREAM_INVALID_FRAME"));
});
test("a version or a watermark that is no whole number is refused before it moves the page", () => {
  const base = snapshot(), first = held(base), frame = commitFrame(base);
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => next(first, { ...frame, lastSeq: value }), isCode("STREAM_INVALID_FRAME"));
    assert.throws(() => next(first, { ...frame, version: value }), isCode("STREAM_INVALID_FRAME"));
  }
  assert.equal(first.head.version, 3); assert.equal(first.head.lastSeq, 5);
});
test("a commit missing before a frame, a text that does not begin where the held one ends, or a frame before any snapshot is not guessed at", () => {
  const base = snapshot(), first = held(base), frame = commitFrame(base);
  assert.throws(() => next(null, frame), isCode("STREAM_STATE"));
  assert.throws(() => next(null, { type: "relay", sessionId: SESSION, version: 3, lastSeq: 5, event: { type: "relay.input_recorded", sessionId: SESSION, at: 1 } }), isCode("STREAM_STATE"));
  const gap = next(first, { ...frame, version: 5 }); assert.equal(gap.kind, "resync"); assert.match((gap as { reason: string }).reason, /missing/u);
  const crooked = next(first, commitFrame(base, "x", 1)); assert.equal(crooked.kind, "resync"); assert.match((crooked as { reason: string }).reason, /byte 1/u);
  assert.equal(next(first, { ...frame, lastSeq: 2 }).kind, "resync", "a watermark behind the page's is not a commit that follows");
});

test("waiting-request lists ride along a session stream without moving its cursor", async () => {
  const first = snapshot(), following = commitFrame(first), lists: unknown[] = [], frames: ClientStreamFrame[] = [];
  const attention = "event: attention\ndata: " + JSON.stringify({ revision: 3, items: [] }) + "\n\n";
  await consumeSessionEventStream(bytesStream([encoder.encode(sse({ type: "snapshot", session: first }) + attention + sse(following))]), { signal: new AbortController().signal, decode,
    onFrame: frame => { frames.push(frame); }, onAttention: value => { lists.push(value); } });
  assert.deepEqual(plain(frames), plain([{ type: "snapshot", session: first }, following])); assert.deepEqual(lists, [{ revision: 3, items: [] }]);
  // Without a consumer for them they are skipped; a broken one fails the stream like any other broken frame.
  assert.deepEqual(plain(await read([encoder.encode(attention + sse(following))])), plain([following]));
  await assert.rejects(read([encoder.encode("event: attention\ndata: {broken\n\n")]), isCode("STREAM_INVALID_FRAME"));
});

// ---------------------------------------------------------------------------------------------------------------------
// The relay's notice is a frame of the stream (ADR-055 §12.4): it follows the facts it names, with their watermark
// ---------------------------------------------------------------------------------------------------------------------

function relayFrame(base = snapshot(), type = "relay.input_recorded"): ClientStreamFrame {
  return { type: "relay", sessionId: base.head.id, version: base.head.version, lastSeq: base.head.lastSeq, event: { type, sessionId: base.head.id, runId: "run-stream", packetId: "relay-0123456789abcdefghjk", at: 1_794_305_941_906 } } as ClientStreamFrame;
}
const wireFails = (error: unknown): boolean => error instanceof Error && error.name === "WireError";
test("a relay notice is read by the page's decoder for its event, and takes nothing but the event", () => {
  const base = snapshot(), frame = relayFrame(base);
  assert.deepEqual(decodeSessionStreamFrameV14(JSON.parse(JSON.stringify(frame))), frame);
  // Without a Run or a packet it still is a notice that the relay changed.
  const bare = { type: "relay", sessionId: SESSION, version: 3, lastSeq: 5, event: { type: "relay.input_recorded", sessionId: SESSION, at: 5 } };
  assert.deepEqual(decodeSessionStreamFrameV14(bare), bare);
  // A kind this page does not know is still a notice, and one that is no notice is refused whole.
  assert.equal(decodeSessionStreamFrameV14({ ...bare, event: { ...bare.event, type: "relay.something_new" } }).type, "relay");
  for (const broken of [{ ...bare, event: null }, { ...bare, event: { sessionId: SESSION, at: 5 } }, { ...bare, event: { type: "relay.input_recorded", sessionId: SESSION } }, { ...bare, version: -1 }, { ...bare, lastSeq: -1 },
    { type: "relay", sessionId: SESSION, version: 1, lastSeq: 1 }]) {
    assert.throws(() => decodeSessionStreamFrameV14(broken), wireFails, JSON.stringify(broken).slice(0, 60));
  }
});
test("a relay notice rides in the stream after the facts it follows and leaves the page's conversation as it is", async () => {
  const first = snapshot(), following = commitFrame(first), notice = relayFrame({ head: { ...first.head, version: following.version, lastSeq: following.lastSeq }, window: first.window });
  const frames: ClientStreamFrame[] = [];
  await consumeSessionEventStream(bytesStream([encoder.encode(sse({ type: "snapshot", session: first }) + sse(following) + sse(notice))]), { signal: new AbortController().signal, decode, onFrame: frame => { frames.push(frame); } });
  assert.deepEqual(frames.map(frame => frame.type), ["snapshot", "commit", "relay"]);
  let state: WindowState | null = null;
  for (const frame of frames) state = stateOf(next(state, frame));
  assert.equal(state!.head.lastSeq, following.lastSeq); assert.equal(replyText(state!), "你好，世界 🌏");
  assert.equal(stateOf(next(state, notice)), state, "the notice is a no-op under the watermark it names");
  // The identity on the wire is the facts' watermark, as for any frame.
  const crooked = encoder.encode("event: session\nid: " + ((notice as { lastSeq: number }).lastSeq + 1) + "\ndata: " + JSON.stringify(notice) + "\n\n");
  await assert.rejects(consumeSessionEventStream(bytesStream([crooked]), { signal: new AbortController().signal, decode, onFrame: () => {} }), isCode("STREAM_INVALID_FRAME"));
});
test("relay events named relay in the stream are handed on as they are, and never move the cursor", async () => {
  const first = snapshot(), seen: unknown[] = [], frames: ClientStreamFrame[] = [];
  const event = "event: relay\ndata: " + JSON.stringify({ type: "relay", event: { type: "relay.verified", sessionId: first.head.id } }) + "\n\n";
  await consumeSessionEventStream(bytesStream([encoder.encode(sse({ type: "snapshot", session: first }) + event + "event: relay\ndata: {broken\n\n")]), { signal: new AbortController().signal, decode,
    onFrame: frame => { frames.push(frame); }, onRelay: value => { seen.push(value); } });
  assert.deepEqual(plain(frames), plain([{ type: "snapshot", session: first }])); assert.equal(seen.length, 1, "the event that is not JSON is dropped, and does not end the stream");
});
