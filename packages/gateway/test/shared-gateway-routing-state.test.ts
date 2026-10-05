// SPDX-License-Identifier: MIT
/** The handler's read-only routing state: breakers, rests, last failures and readings. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  addKey,
  CHAT_REPLY,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Reply,
} from "./shared-support.js";

const limited: Reply = (response, seen) => {
  response.setHeader("x-ratelimit-limit-requests", "100");
  response.setHeader("x-ratelimit-remaining-requests", "75");
  response.setHeader("x-ratelimit-reset-requests", "60s");
  return CHAT_REPLY(response, seen, undefined as never);
};

void test("routing state shows a resting credential's failure class without its message, and readings", async (t) => {
  const up = await upstream(
    t,
    json(
      429,
      { error: { message: "slow down, secret sk-upstream-a-0001" } },
      { "retry-after": "120" },
    ),
    limited,
  );
  const store = new MemoryStore();
  await store.putProvider(
    provider("p", { chat: `${up.base}/v1` }, { secrets: ["key-a", "key-b"] }),
  );
  const key = await addKey(store, ["p/*"]);
  const gw = await mount(t, store);
  assert.deepEqual(gw.handler.routingState(), []);
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "p/model-a", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(answer.status, 200);
  const states = gw.handler.routingState();
  const first = states.find((state) => state.credential === "cred-0")!;
  assert.equal(first.state, "open");
  // The vendor said two minutes; one key's failure rests it one (H2).
  assert.equal(
    first.restingUntil,
    new Date(gw.clock.now + 60_000).toISOString(),
  );
  assert.deepEqual(first.lastFailure, {
    kind: "rate_limited",
    status: 429,
    at: new Date(gw.clock.now).toISOString(),
  });
  assert.ok(!JSON.stringify(states).includes("slow down"));
  const second = states.find((state) => state.credential === "cred-1")!;
  assert.equal(second.state, "closed");
  assert.deepEqual(
    second.readings.map((reading) => [reading.window, reading.usedPercent]),
    [["requests", 25]],
  );
  // Past its rest, the next request finds it half-open.
  gw.clock.now += 121_000;
  assert.equal(
    gw.handler.routingState().find((state) => state.credential === "cred-0")!
      .state,
    "half-open",
  );
});
