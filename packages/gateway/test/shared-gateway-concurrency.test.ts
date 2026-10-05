// SPDX-License-Identifier: MIT
/**
 * A provider's own concurrency limits (Magpie's `maxConcurrency`): requests
 * out at once and waiting on each of its credentials, in place of the
 * gateway's; a full queue is 429 `busy` and fails over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Slots } from "../src/http.js";
import {
  addKey,
  CHAT_REPLY,
  group,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Reply,
} from "./shared-support.js";

void test("slots admit in order, refuse past the queue, and follow new limits", async () => {
  const slots = new Slots(1, 1, "busy");
  const signal = new AbortController().signal;
  await slots.acquire(signal);
  const second = slots.acquire(signal);
  await assert.rejects(slots.acquire(signal), { code: "busy", status: 429 });
  // A higher limit admits the one waiting.
  slots.configure(2, 1);
  await second;
  assert.equal(slots.load, 2);
  // A lower one lets those out finish and admits no more until fewer are out.
  slots.configure(1, 1);
  let admitted = false;
  const third = slots.acquire(signal).then(() => (admitted = true));
  slots.release();
  await delay(0);
  assert.equal(admitted, false, "still one out at the limit of one");
  slots.release();
  await third;
  assert.equal(slots.load, 1);
});

/** An upstream that answers after `ms` and counts the requests it holds at once. */
async function slowUpstream(t: test.TestContext, ms: number) {
  let open = 0;
  let most = 0;
  const reply: Reply = async (response, seen, request) => {
    open++;
    most = Math.max(most, open);
    await delay(ms);
    open--;
    await CHAT_REPLY(response, seen, request);
  };
  const up = await upstream(t, reply);
  return { up, most: () => most };
}

void test("a provider limited to one request at once serializes its calls; another provider is unaffected", async (t) => {
  const slow = await slowUpstream(t, 150);
  const free = await slowUpstream(t, 150);
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "one",
      { chat: `${slow.up.base}/v1` },
      {
        limits: { concurrentPerCredential: 1 },
      },
    ),
  );
  await store.putProvider(provider("many", { chat: `${free.up.base}/v1` }));
  const key = await addKey(store, ["*"]);
  const gw = await mount(t, store);
  const call = (model: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: [{ role: "user", content: "hi" }] },
    });
  const started = performance.now();
  const answers = await Promise.all([
    ...[1, 2, 3].map(() => call("one/model-a")),
    ...[1, 2, 3].map(() => call("many/model-a")),
  ]);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200, 200, 200, 200],
  );
  assert.equal(slow.most(), 1, "one at a time on the limited provider");
  assert.equal(free.most(), 3, "the other provider's calls ran together");
  assert.ok(
    performance.now() - started >= 400,
    "three calls of 150 ms in turn",
  );
});

void test("with no room to wait, a provider's call is 429 busy and fails over to the group's next member", async (t) => {
  const slow = await slowUpstream(t, 200);
  const other = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "one",
      { chat: `${slow.up.base}/v1` },
      {
        limits: { concurrentPerCredential: 1, queuePerCredential: 0 },
      },
    ),
  );
  await store.putProvider(provider("spare", { chat: `${other.base}/v1` }));
  await store.putRouteGroup(group("pair", ["one/model-a", "spare/model-a"]));
  const key = await addKey(store, ["*"]);
  const gw = await mount(t, store);
  const call = () =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: {
        model: "group/pair",
        messages: [{ role: "user", content: "hi" }],
      },
    });
  const answers = await Promise.all([call(), call()]);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200],
  );
  const attempts = store.entries.map((entry) =>
    entry.attempts.map((attempt) => [
      attempt.provider,
      attempt.errorClass ?? null,
      attempt.decision,
    ]),
  );
  assert.ok(
    attempts.some(
      (list) =>
        JSON.stringify(list) ===
        JSON.stringify([
          ["one", "busy", "failover"],
          ["spare", null, "success"],
        ]),
    ),
    JSON.stringify(attempts),
  );
});
