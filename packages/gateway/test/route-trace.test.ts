// SPDX-License-Identifier: MIT
/** The route decision trace: a bounded ring, seqs, filters and waits. */
import test from "node:test";
import assert from "node:assert/strict";
import { DecisionTrace, DECISIONS_KEPT } from "../src/trace.js";

const decision = (conversation: string, callId: string) => ({
  callId,
  conversation,
  requested: "group/g",
  rules: [],
  candidates: [],
});

void test("the trace keeps the latest decisions, reads them after a seq, and waits for one", async () => {
  const trace = new DecisionTrace(() => Date.parse("2026-10-05T00:00:00.000Z"));
  const signal = new AbortController().signal;
  for (let index = 0; index < DECISIONS_KEPT + 10; index++)
    trace.publish(decision(index % 2 ? "odd" : "even", `call${index}`));
  const all = await trace.read({ limit: 1_000 }, signal);
  assert.equal(all.seq, DECISIONS_KEPT + 10);
  assert.equal(all.items.length, DECISIONS_KEPT);
  assert.equal(all.items[0]!.callId, "call10", "the oldest went first");
  assert.equal(
    (await trace.read({}, signal)).items.length,
    50,
    "50 by default",
  );
  const odd = await trace.read({ session: "odd", after: all.seq - 4 }, signal);
  assert.deepEqual(
    odd.items.map((item) => item.callId),
    [`call${DECISIONS_KEPT + 7}`, `call${DECISIONS_KEPT + 9}`],
  );
  // A finished decision is read again, after the seq it was published at.
  const record = trace.publish(decision("even", "late"));
  const published = record.seq;
  trace.finish(record, 200, undefined);
  const after = await trace.read({ after: published }, signal);
  assert.deepEqual(
    after.items.map((item) => [item.callId, item.done, item.status]),
    [["late", true, 200]],
  );
  assert.equal(after.seq, published + 1);
  // Readers get copies: they cannot change the trace.
  after.items[0]!.status = 500;
  assert.equal(
    (await trace.read({ after: published }, signal)).items[0]!.status,
    200,
  );
  // A wait for one session is not ended by another's decision.
  const latest = after.seq;
  const started = performance.now();
  const waiting = trace.read(
    { session: "odd", after: latest, wait: 0.15 },
    signal,
  );
  trace.publish(decision("even", "noise"));
  assert.deepEqual((await waiting).items, []);
  assert.ok(performance.now() - started >= 140);
  // It is ended by one of its own.
  const own = trace.read({ session: "odd", after: latest, wait: 30 }, signal);
  trace.publish(decision("odd", "mine"));
  assert.deepEqual(
    (await own).items.map((item) => item.callId),
    ["mine"],
  );
  // An aborted read returns at once, and so does every read once the trace closes.
  const abort = new AbortController();
  const aborted = trace.read({ after: latest + 2, wait: 30 }, abort.signal);
  abort.abort();
  assert.deepEqual((await aborted).items, []);
  const parked = trace.read({ after: latest + 2, wait: 30 }, signal);
  trace.close();
  assert.deepEqual((await parked).items, []);
  // An after past the latest seq (the gateway started over) reads from the start.
  assert.equal(
    (await trace.read({ after: 1_000_000, limit: 256 }, signal)).items.length,
    DECISIONS_KEPT,
  );
});
