// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { drained, outliveClosedPipes, readerGone } from "../src/pipes.js";

/** A write failure as Node reports it. */
function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

void test("a closed pipe is outlived once per stream; other stream errors are still thrown", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  outliveClosedPipes([stdout, stderr]);
  outliveClosedPipes([stdout]);
  assert.equal(stdout.listenerCount("error"), 1);
  assert.equal(stderr.listenerCount("error"), 1);
  // Every later write to a closed pipe fails again; none ends the process.
  stdout.emit("error", failure("EPIPE"));
  stdout.emit("error", failure("EPIPE"));
  stderr.emit("error", failure("EPIPE"));
  assert.throws(() => stdout.emit("error", failure("EIO")), /write EIO/);
  // Without the listener, Node throws the EPIPE itself.
  assert.throws(
    () => new EventEmitter().emit("error", failure("EPIPE")),
    /write EPIPE/,
  );
  assert.equal(readerGone(failure("EPIPE")), true);
  assert.equal(readerGone(failure("ECONNRESET")), false);
  assert.equal(readerGone("EPIPE"), false);
});

void test("drained waits for a drain, says false when the reader has gone and rethrows the rest", async () => {
  const stream = new EventEmitter();
  const more = drained(stream);
  stream.emit("drain");
  assert.equal(await more, true);
  const gone = drained(stream);
  stream.emit("error", failure("EPIPE"));
  assert.equal(await gone, false);
  const broken = drained(stream);
  stream.emit("error", failure("EIO"));
  await assert.rejects(broken, /write EIO/);
  // Each wait takes its listeners away.
  assert.equal(stream.listenerCount("drain"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});
