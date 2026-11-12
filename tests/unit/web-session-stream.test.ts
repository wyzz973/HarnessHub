import assert from "node:assert/strict";
import test from "node:test";
import { commandId, messageId, runId } from "../../src/contracts/session.js";
import type { PublicMessage, PublicRun } from "../../src/contracts/session.js";
import type { RelayStreamFrame, SessionStreamFrame, SessionView } from "../../src/contracts/web.js";
import { decodeSession, decodeSessionStreamFrame } from "../../web/src/api.js";
import { applySessionStreamFrame, consumeSessionEventStream, SessionStreamError } from "../../web/src/session-stream.js";

const encoder = new TextEncoder();
function snapshot(withAssistant = true): SessionView {
  const id = runId("run-stream"), user = messageId("message-user-stream"), assistant = messageId("message-assistant-stream");
  const selection = { harnessId: "codex", controlId: "codex-native" };
  return { id: "session-stream", version: withAssistant ? 3 : 2, lastSeq: withAssistant ? 5 : 4, epoch: 1, status: "open", workspace: "/workspace",
    selection, activeRunId: id, pendingSwitchId: null,
    messages: [{ id: user, runId: id, role: "user", text: "问题", seq: 2, status: "running" },
      ...(withAssistant ? [{ id: assistant, runId: id, role: "assistant" as const, text: "你好", seq: 5, status: "running" as const }] : [])],
    runs: [{ id, commandId: commandId("send-stream"), input: "问题", userMessageId: user, assistantMessageId: assistant,
      selection, epoch: 1, status: "running", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: null, cleanup: null, error: null,
      stopRequested: false, awaitingSwitchId: null,
      protocol: { version: "hh/1", runId: id, n: 1, status: "running", executor: { harnessId: "codex", harness: "Codex" }, usage: { completeness: "unavailable" }, items: [] } }], switches: [] };
}
function messageFrame(base = snapshot(), text = "你好，世界 🌏"): Extract<SessionStreamFrame, { type: "message" }> {
  const run = base.runs[0]!;
  return { type: "message", sessionId: base.id, version: base.version + 1, lastSeq: base.lastSeq + 1,
    message: { id: run.assistantMessageId, runId: run.id, role: "assistant", text, seq: base.messages.find(message => message.role === "assistant")?.seq ?? base.lastSeq + 1, status: "running" } };
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture decoder rejected unknown frame");
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("fixture decoder rejected text"); return value; }
function number(value: unknown): number { if (typeof value !== "number") throw new Error("fixture decoder rejected number"); return value; }
// Only the external DTO decoder is supplied here; byte framing and projections use the production implementation.
function decode(value: unknown): SessionStreamFrame {
  const row = object(value);
  if (row.type === "snapshot") return { type: "snapshot", session: decodeSession(row.session) };
  if (row.type !== "message") throw new Error("fixture decoder rejected unknown frame");
  const message = object(row.message);
  if (message.role !== "assistant" || message.status !== "running") throw new Error("fixture decoder rejected message");
  return { type: "message", sessionId: text(row.sessionId), version: number(row.version), lastSeq: number(row.lastSeq),
    message: { id: messageId(message.id), runId: runId(message.runId), role: "assistant", status: "running", text: text(message.text), seq: number(message.seq) } };
}
function sse(frame: SessionStreamFrame, ending = "\n", pretty = false): string {
  const id = frame.type === "snapshot" ? frame.session.lastSeq : frame.lastSeq;
  const payload = JSON.stringify(frame, null, pretty ? 2 : undefined).split("\n").map(line => "data: " + line).join(ending);
  return "event: session" + ending + "id: " + id + ending + payload + ending + ending;
}
function bytesStream(chunks: readonly Uint8Array[], cancel?: (reason: unknown) => void | Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); }, ...(cancel === undefined ? {} : { cancel }) });
}
async function read(chunks: readonly Uint8Array[], maxFrameBytes?: number): Promise<SessionStreamFrame[]> {
  const frames: SessionStreamFrame[] = [], stream = bytesStream(chunks);
  await consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame: frame => { frames.push(frame); },
    ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }) });
  assert.equal(stream.locked, false); return frames;
}
function isCode(code: string): (error: unknown) => boolean { return error => error instanceof SessionStreamError && error.code === code; }
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function abortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }

test("SSE delivers committed content while the source is still open", async () => {
  const arrived = deferred(), frame = messageFrame();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  let finished = false;
  const pending = consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame: value => { assert.deepEqual(value, frame); arrived.resolve(); } }).then(() => { finished = true; });
  source!.enqueue(encoder.encode(sse(frame))); await arrived.promise;
  assert.equal(finished, false); assert.equal(stream.locked, true);
  source!.close(); await pending; assert.equal(stream.locked, false);
});
test("UTF-8 characters and SSE framing survive every two-chunk split", async () => {
  const frame = messageFrame(snapshot(), "你好，世界 🌏 e\u0301"), bytes = encoder.encode("\uFEFF" + sse(frame, "\r\n"));
  for (let offset = 0; offset <= bytes.length; offset++) assert.deepEqual(await read([bytes.subarray(0, offset), bytes.subarray(offset)]), [frame]);
});
test("LF, CR and CRLF accept one-byte chunks, multiline JSON, comments and unknown SSE fields", async () => {
  const frame: SessionStreamFrame = { type: "snapshot", session: snapshot() };
  for (const ending of ["\n", "\r", "\r\n"]) {
    const body: string = "\uFEFF: heartbeat" + ending + "retry: 1000" + ending + "unknown: ignored" + ending + ending + sse(frame, ending, true);
    assert.deepEqual(await read(Array.from(encoder.encode(body), byte => new Uint8Array([byte]))), [frame]);
  }
});
test("a BOM is accepted only at the beginning and never silently repairs later fields", async () => {
  await assert.rejects(read([encoder.encode(": comment\n\uFEFF" + sse(messageFrame()))]), isCode("STREAM_INVALID_FRAME"));
});
test("the frame byte budget counts UTF-8 and CRLF, and resets after each closed frame", async () => {
  const frame = messageFrame(), encoded = encoder.encode(sse(frame, "\r\n"));
  assert.ok(encoded.length > sse(frame, "\r\n").length);
  assert.deepEqual(await read([encoded], encoded.length), [frame]);
  await assert.rejects(read([encoded], encoded.length - 1), isCode("STREAM_LIMIT"));
  assert.deepEqual(await read([encoder.encode(sse(frame, "\r\n") + sse(frame, "\r\n"))], encoded.length), [frame, frame]);
});
test("unbounded lines, open multi-data frames and comments fail the same bounded reader", async () => {
  for (const value of ["data: " + "x".repeat(256), "data: x\n".repeat(64), ":" + "x".repeat(256) + "\n\n"]) {
    await assert.rejects(read([encoder.encode(value)], 128), isCode("STREAM_LIMIT"));
  }
  for (const budget of [0, -1, NaN, 1.5, 8 * 1024 * 1024 + 1]) await assert.rejects(read([], budget), isCode("STREAM_LIMIT"));
});
test("SSE identity must be explicit, canonical, safe and equal to the decoded facts watermark", async () => {
  const frame = messageFrame(), valid = sse(frame);
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
  const valid = sse(messageFrame());
  for (const body of [valid.slice(0, -1), valid.slice(0, -2), "id: 6\n", "event: session\n", ": half-comment"]) {
    await assert.rejects(read([encoder.encode(body)]), isCode("STREAM_TRUNCATED"));
  }
  assert.deepEqual(await read([encoder.encode(": heartbeat\n")]), []);
  assert.deepEqual(await read([encoder.encode("id: 6\nevent: session\n\n")]), []);
});
test("the reader awaits each frame consumer and retains no callback queue", async () => {
  const first = messageFrame(), second = { ...first, version: 5, lastSeq: 7, message: { ...first.message, text: first.message.text + "。" } };
  const blocked = deferred(), entered = deferred(), values: SessionStreamFrame[] = [];
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
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(messageFrame()) + sse(messageFrame()))); }, cancel() { cancelled.resolve(); return cleanup.promise; } });
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
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(messageFrame()))); }, cancel() { cancellations++; } });
  await assert.rejects(consumeSessionEventStream(stream, { signal: new AbortController().signal, decode, onFrame() { throw sentinel; } }), error => error === sentinel);
  assert.equal(cancellations, 1); assert.equal(stream.locked, false);
});
test("cleanup failure is reported alongside the frame failure and never leaves the reader locked", async () => {
  const primary = new Error("consumer failed"), cleanup = new Error("source cleanup failed");
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(messageFrame()))); }, cancel() { throw cleanup; } });
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
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse(messageFrame()) + sse(messageFrame()))); } });
  const pending = consumeSessionEventStream(stream, { signal: control.signal, decode, onFrame() { deliveries++; entered.resolve(); return consumer; } });
  await entered.promise; control.abort(); await assert.rejects(pending, abortError);
  rejectConsumer(new Error("consumer completed after cancellation"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(deliveries, 1); assert.equal(stream.locked, false);
});

test("snapshot establishes canonical facts and a message replaces full text without duplicate append", () => {
  const base = snapshot(), canonical: SessionStreamFrame = { type: "snapshot", session: base };
  assert.equal(applySessionStreamFrame(null, canonical, base.id), base);
  const frame = messageFrame(base), next = applySessionStreamFrame(base, frame, base.id);
  assert.equal(next.messages[1], frame.message); assert.equal(next.messages[1]?.text, "你好，世界 🌏"); assert.equal(next.messages[0], base.messages[0]);
  assert.equal(next.runs, base.runs); assert.equal(next.switches, base.switches); assert.equal(next.selection, base.selection); assert.equal(base.messages[1]?.text, "你好");
  assert.equal(applySessionStreamFrame(next, frame, base.id), next);
});
test("the first assistant message uses its reserved Run identity and committed creation sequence", () => {
  const base = snapshot(false), frame = messageFrame(base), next = applySessionStreamFrame(base, frame, base.id);
  assert.equal(next.messages.length, 2); assert.equal(next.messages[1], frame.message); assert.equal(next.messages[1]?.seq, frame.lastSeq);
});
test("a reconnect snapshot bridges missing facts and terminal content cannot be overwritten by old frames", () => {
  const base = snapshot(), frame = messageFrame(base), next = applySessionStreamFrame(base, frame, base.id);
  const completed: SessionView = { ...next, version: 6, lastSeq: 9, activeRunId: null,
    messages: next.messages.map(message => ({ ...message, status: "completed" })),
    runs: next.runs.map(run => ({ ...run, status: "completed", backend: { status: "completed", reason: "done" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null } })) };
  assert.equal(applySessionStreamFrame(next, { type: "snapshot", session: completed }, base.id), completed);
  assert.equal(applySessionStreamFrame(completed, frame, base.id), completed);
  assert.equal(applySessionStreamFrame(completed, { type: "snapshot", session: base }, base.id), completed);
});
test("foreign frame or current Session identity fails even when the frame is stale", () => {
  const base = snapshot(), frame = messageFrame(base);
  for (const value of [{ ...frame, sessionId: "session-other" }, { type: "snapshot" as const, session: { ...base, id: "session-other" } }]) {
    assert.throws(() => applySessionStreamFrame(base, value, base.id), isCode("STREAM_STATE"));
  }
  assert.throws(() => applySessionStreamFrame({ ...base, id: "session-other" }, frame, base.id), isCode("STREAM_STATE"));
  assert.throws(() => applySessionStreamFrame(base, frame, "invalid"), isCode("STREAM_INVALID_FRAME"));
});
test("invalid or conflicting versions and watermarks never advance local facts", () => {
  const base = snapshot(), frame = messageFrame(base);
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applySessionStreamFrame(base, { ...frame, lastSeq: value }, base.id), isCode("STREAM_INVALID_FRAME"));
    assert.throws(() => applySessionStreamFrame(base, { ...frame, version: value }, base.id), isCode("STREAM_INVALID_FRAME"));
  }
  for (const patch of [{ version: 4, lastSeq: 5 }, { version: 3, lastSeq: 4 }, { version: 3, lastSeq: 6 }, { version: 4, lastSeq: 7 }, { version: 5, lastSeq: 7 }]) {
    assert.throws(() => applySessionStreamFrame(base, { ...frame, ...patch }, base.id), isCode("STREAM_STATE"));
  }
  assert.throws(() => applySessionStreamFrame(base, { ...frame, version: 7 }, base.id), isCode("STREAM_INVALID_FRAME"));
  assert.equal(base.version, 3); assert.equal(base.lastSeq, 5);
});
test("message gaps, missing base, missing Run and inactive Run demand a canonical snapshot", () => {
  const base = snapshot(), frame = messageFrame(base);
  assert.throws(() => applySessionStreamFrame(null, frame, base.id), isCode("STREAM_STATE"));
  assert.throws(() => applySessionStreamFrame({ ...base, runs: [] }, frame, base.id), isCode("STREAM_STATE"));
  assert.throws(() => applySessionStreamFrame({ ...base, activeRunId: null }, frame, base.id), isCode("STREAM_STATE"));
  assert.throws(() => applySessionStreamFrame({ ...base, runs: base.runs.map(run => ({ ...run, status: "settling" })) }, frame, base.id), isCode("STREAM_STATE"));
});
test("message frames cannot rewrite committed text, creation sequence, role or ownership", () => {
  const base = snapshot(), frame = messageFrame(base);
  const patches: Partial<PublicMessage>[] = [{ text: "replacement" }, { seq: 6 }, { role: "user" }, { id: messageId("message-other") }, { runId: runId("run-other") }, { status: "completed" }];
  for (const patch of patches) assert.throws(() => applySessionStreamFrame(base, { ...frame, message: { ...frame.message, ...patch } }, base.id), isCode("STREAM_STATE"));
  const noAssistant = snapshot(false), first = messageFrame(noAssistant);
  assert.throws(() => applySessionStreamFrame(noAssistant, { ...first, message: { ...first.message, seq: 3 } }, noAssistant.id), isCode("STREAM_STATE"));
});
test("snapshot ownership, message order, Run input, active status and epoch are checked", () => {
  const base = snapshot();
  const candidates: SessionView[] = [
    { ...base, messages: [base.messages[1]!, base.messages[0]!] },
    { ...base, messages: [...base.messages, { ...base.messages[1]!, seq: 6 }], lastSeq: 6 },
    { ...base, runs: [...base.runs, base.runs[0]!] },
    { ...base, runs: base.runs.map(run => ({ ...run, input: "different input" })) },
    { ...base, messages: base.messages.map(message => ({ ...message, status: "completed" })) },
    { ...base, activeRunId: runId("run-foreign") },
    { ...base, epoch: 0 },
    { ...base, runs: base.runs.map(run => ({ ...run, epoch: 2 })) },
    { ...base, runs: base.runs.map(run => ({ ...run, assistantMessageId: run.userMessageId })) },
  ];
  for (const session of candidates) assert.throws(() => applySessionStreamFrame(null, { type: "snapshot", session }, base.id), isCode("STREAM_INVALID_FRAME"));
});
test("run frames replace only the active Run's native activity and never cross missing facts", () => {
  const base = snapshot(), run = base.runs[0]!;
  const frame: SessionStreamFrame = { type: "run", sessionId: base.id, version: base.version + 1, lastSeq: base.lastSeq + 1,
    run: { ...run, tools: [{ id: "tool-1", title: "ls", status: "completed", kind: "execute" }], plan: { entries: [{ content: "Read", status: "in_progress" }] }, usage: { turn: { input: 5 } } } };
  const next = applySessionStreamFrame(base, frame, base.id);
  assert.deepEqual(next.runs[0]?.tools, [{ id: "tool-1", title: "ls", status: "completed", kind: "execute" }]);
  assert.equal(next.lastSeq, base.lastSeq + 1); assert.equal(next.messages, base.messages);
  assert.throws(() => applySessionStreamFrame(base, { ...frame, lastSeq: base.lastSeq + 2, version: base.version + 2 }, base.id), isCode("STREAM_STATE"));
  const patches: Partial<PublicRun>[] = [{ input: "rewritten" }, { epoch: 2 }, { status: "completed" }, { selection: { harnessId: "other", controlId: "x" } }, { id: runId("run-other") }];
  for (const patch of patches) assert.throws(() => applySessionStreamFrame(base, { ...frame, run: { ...frame.run, ...patch } }, base.id), isCode("STREAM_STATE"));
  assert.throws(() => applySessionStreamFrame({ ...base, activeRunId: null }, frame, base.id), isCode("STREAM_STATE"));
});

test("waiting-request lists ride along a session stream without moving its cursor", async () => {
  const first = snapshot(), next = messageFrame(first), lists: unknown[] = [], frames: SessionStreamFrame[] = [];
  const attention = "event: attention\ndata: " + JSON.stringify({ revision: 3, items: [] }) + "\n\n";
  await consumeSessionEventStream(bytesStream([encoder.encode(sse({ type: "snapshot", session: first }) + attention + sse(next))]), { signal: new AbortController().signal, decode,
    onFrame: frame => { frames.push(frame); }, onAttention: value => { lists.push(value); } });
  assert.deepEqual(frames, [{ type: "snapshot", session: first }, next]); assert.deepEqual(lists, [{ revision: 3, items: [] }]);
  // Without a consumer for them they are skipped; a broken one fails the stream like any other broken frame.
  assert.deepEqual(await read([encoder.encode(attention + sse(next))]), [next]);
  await assert.rejects(read([encoder.encode("event: attention\ndata: {broken\n\n")]), isCode("STREAM_INVALID_FRAME"));
});

// ---------------------------------------------------------------------------------------------------------------------
// The relay's notice is a frame of the stream (ADR-055 §12.4): it follows the facts it names, with their watermark
// ---------------------------------------------------------------------------------------------------------------------

function relayFrame(base = snapshot(), type: RelayStreamFrame["event"]["type"] = "relay.input_recorded"): RelayStreamFrame {
  return { type: "relay", sessionId: base.id, version: base.version, lastSeq: base.lastSeq, event: { type, sessionId: base.id, runId: base.runs[0]!.id, packetId: "relay-0123456789abcdefghjk", at: 1_794_305_941_906 } };
}
test("a relay notice is read by the page's decoder for its event, and takes nothing but the event", () => {
  const base = snapshot(), frame = relayFrame(base);
  assert.deepEqual(decodeSessionStreamFrame(JSON.parse(JSON.stringify(frame))), frame);
  // Without a Run or a packet it still is a notice that the relay changed.
  const bare = { type: "relay", sessionId: base.id, version: base.version, lastSeq: base.lastSeq, event: { type: "relay.input_recorded", sessionId: base.id, at: 5 } };
  assert.deepEqual(decodeSessionStreamFrame(bare), bare);
  // A kind this page does not know is still a notice, and one that is no notice is refused whole.
  assert.equal(decodeSessionStreamFrame({ ...bare, event: { ...bare.event, type: "relay.something_new" } }).type, "relay");
  for (const broken of [{ ...bare, event: null }, { ...bare, event: { sessionId: base.id, at: 5 } }, { ...bare, event: { type: "relay.input_recorded", sessionId: base.id } }, { ...bare, version: 0 }, { ...bare, lastSeq: -1 },
    { ...bare, extra: 1 }, { type: "relay", sessionId: base.id, version: 1, lastSeq: 1 }]) {
    assert.throws(() => decodeSessionStreamFrame(broken), (error: unknown) => (error as { code?: string }).code === "INVALID_RESPONSE", JSON.stringify(broken).slice(0, 60));
  }
});
test("a relay notice rides in the stream after the facts it follows and leaves the Session as it is", async () => {
  const first = snapshot(), next = messageFrame(first), notice = relayFrame({ ...first, version: next.version, lastSeq: next.lastSeq } as SessionView);
  const frames = await (async () => {
    const seen: SessionStreamFrame[] = [];
    await consumeSessionEventStream(bytesStream([encoder.encode(sse({ type: "snapshot", session: first }) + sse(next) + sse(notice))]), { signal: new AbortController().signal, decode: decodeSessionStreamFrame, onFrame: frame => { seen.push(frame); } });
    return seen;
  })();
  assert.deepEqual(frames.map(frame => frame.type), ["snapshot", "message", "relay"]);
  let session: SessionView | null = null;
  for (const frame of frames) session = applySessionStreamFrame(session, frame, first.id);
  assert.equal(session!.lastSeq, next.lastSeq); assert.equal(session!.messages.find(message => message.role === "assistant")?.text, next.message.text);
  const before = session; assert.equal(applySessionStreamFrame(session, notice, first.id), before, "the notice is a no-op under the watermark it names");
  // The identity on the wire is the facts' watermark, as for any frame.
  const crooked = encoder.encode("event: session\nid: " + (notice.lastSeq + 1) + "\ndata: " + JSON.stringify(notice) + "\n\n");
  await assert.rejects(consumeSessionEventStream(bytesStream([crooked]), { signal: new AbortController().signal, decode: decodeSessionStreamFrame, onFrame: () => {} }), isCode("STREAM_INVALID_FRAME"));
});
test("a relay notice needs the snapshot it follows, names its own Session, and cannot disagree with the facts it follows", () => {
  const base = snapshot(), notice = relayFrame(base);
  assert.throws(() => applySessionStreamFrame(null, notice, base.id), isCode("STREAM_STATE"), "no notice before a snapshot");
  assert.throws(() => applySessionStreamFrame(base, { ...notice, sessionId: "session-other", event: { ...notice.event, sessionId: "session-other" } }, base.id), isCode("STREAM_STATE"), "another Session's notice");
  assert.throws(() => applySessionStreamFrame(base, { ...notice, version: base.version - 1 }, base.id), isCode("STREAM_STATE"), "the same watermark under another version");
  assert.equal(applySessionStreamFrame(base, notice, base.id), base);
  // A notice that is ahead of the facts the page holds (they come with the snapshot that follows) changes nothing either: it carries none.
  assert.equal(applySessionStreamFrame(base, { ...notice, version: base.version + 1, lastSeq: base.lastSeq + 3 }, base.id), base);
  // And one that is behind them is stale, like any older frame.
  assert.equal(applySessionStreamFrame({ ...base, version: base.version + 1, lastSeq: base.lastSeq + 1 }, notice, base.id).lastSeq, base.lastSeq + 1);
});
test("relay events named relay in the stream are handed on as they are, and never move the cursor", async () => {
  const first = snapshot(), seen: unknown[] = [], frames: SessionStreamFrame[] = [];
  const event = "event: relay\ndata: " + JSON.stringify({ type: "relay", event: { type: "relay.verified", sessionId: first.id } }) + "\n\n";
  await consumeSessionEventStream(bytesStream([encoder.encode(sse({ type: "snapshot", session: first }) + event + "event: relay\ndata: {broken\n\n")]), { signal: new AbortController().signal, decode,
    onFrame: frame => { frames.push(frame); }, onRelay: value => { seen.push(value); } });
  assert.deepEqual(frames, [{ type: "snapshot", session: first }]); assert.equal(seen.length, 1, "the event that is not JSON is dropped, and does not end the stream");
});
