import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { sendPieces } from "../../src/web/download.js";

// How a download made of pieces is sent (src/web/download.ts): one piece at a time at the pace of the socket, the first made before anything is sent, a client that went away stops the reading,
// and a piece that cannot be made once the status is sent ends the connection instead of throwing at a caller that has nothing left to answer with. The response is a stand-in that says
// when it is full (a real one needs a slow peer to say it); the pieces are made by a generator that counts what was asked of it.

/** A response that takes `room` writes and then says it is full until `drain()`. */
class Response extends EventEmitter {
  destroyed = false; ended = false; written: string[] = []; free: number;
  constructor(private readonly room: number) { super(); this.free = room; }
  write(chunk: string): boolean { this.written.push(chunk); return --this.free > 0; }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; this.emit("close"); }
  drain(): void { this.free = this.room; this.emit("drain"); }
  /** The peer is gone: the response is destroyed and says it closed. */
  gone(): void { this.destroyed = true; this.emit("close"); }
  asResponse(): ServerResponse { return this as unknown as ServerResponse; }
}
const settle = async (): Promise<void> => { for (let tick = 0; tick < 5; tick++) await new Promise<void>(resolve => setImmediate(resolve)); };
function counted(total: number, options: { readonly failAt?: number } = {}): { readonly pieces: Generator<string>; readonly made: () => number; readonly returned: () => boolean } {
  let made = 0, returned = false;
  function* make(): Generator<string> {
    try { for (let n = 0; n < total; n++) { made++; if (options.failAt === n) throw new Error("a piece could not be made"); yield "piece " + n + "\n"; } } finally { returned = true; }
  }
  return { pieces: make(), made: () => made, returned: () => returned };
}

test("the pieces are made at the pace of the socket: while it is full nothing more is asked for, and the next is asked for when it drains", async () => {
  const response = new Response(2), source = counted(10);
  let began = 0;
  const sending = sendPieces(response.asResponse(), source.pieces, () => { began++; });
  await settle();
  assert.deepEqual([began, response.written.length, source.made()], [1, 2, 2], "two pieces written into the room there was, and no piece made beyond what was written");
  await settle();
  assert.equal(source.made(), 2, "a full socket asks for nothing");
  response.drain(); await settle();
  assert.deepEqual([response.written.length, source.made()], [4, 4]);
  for (let round = 0; round < 10 && !response.ended; round++) { response.drain(); await settle(); }
  await sending;
  assert.deepEqual([response.ended, response.destroyed, response.written.join("")], [true, false, Array.from({ length: 10 }, (_, n) => "piece " + n + "\n").join("")]);
});

test("the first piece is made before anything is sent, so that a failure to make it is the caller's to answer", async () => {
  const response = new Response(5), source = counted(3, { failAt: 0 });
  let began = 0;
  await assert.rejects(sendPieces(response.asResponse(), source.pieces, () => { began++; }), /could not be made/u);
  assert.deepEqual([began, response.written.length, response.destroyed, response.ended], [0, 0, false, false]);
});

test("a piece that cannot be made once the status is sent ends the connection: the client sees a download that broke, and nothing is thrown", async () => {
  const response = new Response(10), source = counted(5, { failAt: 2 });
  let began = 0;
  await sendPieces(response.asResponse(), source.pieces, () => { began++; });
  assert.deepEqual([began, response.written, response.destroyed, response.ended], [1, ["piece 0\n", "piece 1\n"], true, false], "what was made is what was sent; the body is never ended as if it were whole");
  assert.equal(source.returned(), true);
});

test("a client that went away stops the reading at once and lets the source finish", async () => {
  const response = new Response(2), source = counted(1000);
  const sending = sendPieces(response.asResponse(), source.pieces, () => {});
  await settle();
  const before = source.made();
  response.gone(); await sending;
  assert.equal(source.made(), before, "nothing more was asked for");
  assert.equal(source.returned(), true, "the source was told it is not wanted any more");
  assert.equal(response.ended, false);
});

test("a long run of pieces gives the event loop back, so that other requests are answered while it goes on", async () => {
  const response = new Response(1_000_000);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  function* slow(): Generator<string> { for (let n = 0; n < 40; n++) { const until = Date.now() + 5; while (Date.now() < until) { /* a piece that takes time to make */ } yield "x"; } }
  await sendPieces(response.asResponse(), slow(), () => {});
  clearInterval(timer);
  assert.ok(ticks >= 3, "the loop ran " + ticks + " times in the 200 ms of a download that never waited for its socket");
  assert.equal(response.written.length, 40);
});
