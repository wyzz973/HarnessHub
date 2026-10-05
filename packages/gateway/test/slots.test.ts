// SPDX-License-Identifier: MIT
/** Credential slots: a free slot goes to the key holding the fewest, and a wait has a deadline. */
import test from "node:test";
import assert from "node:assert/strict";
import { Slots } from "../src/http.js";
import { GatewayError } from "../src/protocol.js";

void test("a slot that comes free goes to the waiting key holding the fewest, the earliest of those", async () => {
  const slots = new Slots(2, 10, "busy");
  const signal = new AbortController().signal;
  await slots.acquire(signal, "a");
  await slots.acquire(signal, "a");
  const order: string[] = [];
  const wait = (owner: string, label: string) =>
    slots.acquire(signal, owner).then(() => order.push(label));
  // Key a queued three more before key b asked once.
  const waiting = [
    wait("a", "a3"),
    wait("a", "a4"),
    wait("a", "a5"),
    wait("b", "b1"),
  ];
  slots.release("a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["b1"], "b holds none, a holds one");
  slots.release("a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["b1", "a3"]);
  slots.release("b");
  slots.release("a");
  await Promise.all(waiting);
  assert.deepEqual(order, ["b1", "a3", "a4", "a5"]);
  assert.equal(slots.load, 2);
});

void test("a call waits for a slot no longer than the deadline, and leaves the queue", async () => {
  const slots = new Slots(1, 4, "Too many concurrent requests", 20);
  const signal = new AbortController().signal;
  await slots.acquire(signal, "a");
  const started = Date.now();
  await assert.rejects(slots.acquire(signal, "b"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "busy");
    assert.match(error.message, /no slot came free within 1 s/);
    return true;
  });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(slots.load, 1, "the refused call is no longer waiting");
  // Without a deadline a call waits until it is aborted.
  const open = new Slots(1, 4, "busy");
  await open.acquire(signal, "a");
  const abort = new AbortController();
  const waiting = open.acquire(abort.signal, "b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  abort.abort(new Error("gone"));
  await assert.rejects(waiting, /gone/);
  assert.equal(open.load, 1);
});
