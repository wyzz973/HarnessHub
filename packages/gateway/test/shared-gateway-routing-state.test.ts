// SPDX-License-Identifier: MIT
/** The handler's routing state (breakers, rests, last failures and readings), and lifting rests. */
import test from "node:test";
import assert from "node:assert/strict";
import type { CredentialId, ProviderId } from "@harnesshub/core/model-plane";
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

void test("liftRest forgets one credential's rest and model marks, or all of a provider's, and keeps readings", async (t) => {
  let failing = true;
  const asked: string[] = [];
  const up = await upstream(t, (response, seen, request) => {
    // The env references key-a and key-b hold sk-upstream-a-… and -b-….
    const key = String(seen.headers.authorization).includes("-a-")
      ? "key-a"
      : "key-b";
    asked.push(key);
    if (failing && key === "key-a")
      return json(
        429,
        { error: { message: "slow down" } },
        { "retry-after": "120" },
      )(response, seen, request);
    if (failing && key === "key-b" && seen.json().model === "model-b")
      return json(400, {
        error: {
          message: "The model `model-b` does not exist",
          type: "invalid_request_error",
        },
      })(response, seen, request);
    return limited(response, seen, request);
  });
  const store = new MemoryStore();
  await store.putProvider(
    provider("p", { chat: `${up.base}/v1` }, { secrets: ["key-a", "key-b"] }),
  );
  const key = await addKey(store, ["p/*"]);
  const gw = await mount(t, store);
  const chat = async (model: string) => {
    const from = asked.length;
    const answer = await send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: {
        model: `p/${model}`,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    return { status: answer.status, asked: asked.slice(from) };
  };
  // key-a rests after its 429; key-b is marked for model-b.
  assert.deepEqual((await chat("model-b")).asked, ["key-a", "key-b"]);
  assert.deepEqual(await chat("model-a"), { status: 200, asked: ["key-b"] });
  const marked = await chat("model-b");
  assert.notEqual(marked.status, 200);
  assert.deepEqual(marked.asked, [], "both rest for model-b");
  failing = false;

  gw.handler.liftRest("p" as ProviderId, "cred-1" as CredentialId);
  assert.deepEqual(
    await chat("model-b"),
    { status: 200, asked: ["key-b"] },
    "key-b's mark is gone; key-a still rests",
  );
  const resting = gw.handler.routingState();
  assert.equal(
    resting.find((state) => state.credential === "cred-0")?.state,
    "open",
  );

  gw.handler.liftRest("p" as ProviderId);
  const lifted = gw.handler.routingState();
  assert.equal(
    lifted.find((state) => state.credential === "cred-0"),
    undefined,
    "nothing known of key-a any more",
  );
  assert.deepEqual(
    lifted
      .find((state) => state.credential === "cred-1")
      ?.readings.map((reading) => [reading.window, reading.usedPercent]),
    [["requests", 25]],
    "the vendor's readings stay",
  );
  assert.deepEqual(await chat("model-a"), { status: 200, asked: ["key-a"] });
});
