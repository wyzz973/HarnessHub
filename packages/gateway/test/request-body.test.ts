// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import v8 from "node:v8";
import { MemoryBudget, readBody } from "../src/http.js";
import { GatewayError } from "../src/protocol.js";

function request(body?: string): IncomingMessage {
  const stream =
    body === undefined ? new PassThrough() : Readable.from([Buffer.from(body)]);
  return Object.assign(stream, { headers: {} }) as unknown as IncomingMessage;
}

const options = (signal: AbortSignal, timeoutMs = 120_000) => ({
  maxBytes: 1024,
  timeoutMs,
  signal,
  memory: new MemoryBudget(1024 * 1024),
});

/** Live AbortSignal objects, after a garbage collection (v8.queryObjects). */
const liveSignals = () =>
  v8.queryObjects(AbortSignal, { format: "count" }) as number;

void test("a request body read keeps no signal or timer alive once it returned", async () => {
  // Node 24 keeps every AbortSignal.timeout() passed to AbortSignal.any()
  // alive, with its timer, until the timeout fires: each request used to
  // hold its signals for the whole 120 s body deadline.
  const call = new AbortController();
  await readBody(request("{}"), options(call.signal));
  const before = liveSignals();
  for (let index = 0; index < 2_000; index++) {
    const bytes = await readBody(request("{}"), options(call.signal));
    assert.equal(bytes.toString(), "{}");
  }
  const retained = liveSignals() - before;
  assert.ok(retained < 100, `${retained} signals outlived their reads`);
});

void test("a request body read still ends at its deadline and with its caller", async () => {
  const call = new AbortController();
  await assert.rejects(
    readBody(request(), options(call.signal, 20)),
    (error: unknown) =>
      error instanceof GatewayError &&
      error.status === 408 &&
      error.code === "request_timeout",
  );
  const reason = new Error("client gone");
  const pending = readBody(request(), options(call.signal));
  call.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});
