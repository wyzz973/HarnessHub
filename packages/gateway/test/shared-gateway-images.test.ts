// SPDX-License-Identifier: MIT
/** Image generation: `/v1/images/generations` passed through to a provider's images endpoint. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  addKey,
  at,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  until,
  type Reply,
} from "./shared-support.js";

const ADMIN = "synthetic-admin-token-for-images-01";
const IMAGE = {
  created: 1,
  data: [{ b64_json: "iVBORw0KGgo=" }],
  usage: {
    input_tokens: 50,
    output_tokens: 4160,
    total_tokens: 4210,
    input_tokens_details: { text_tokens: 50, image_tokens: 0 },
  },
};

async function setup(t: test.TestContext, ...replies: Reply[]) {
  const up = await upstream(t, ...replies);
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "img",
      { chat: `${up.base}/v1` },
      {
        secrets: ["key-a", "key-b"],
        imageEndpoint: `${up.base}/v1`,
        models: {
          source: "manual",
          list: [{ id: "gpt-image-1", price: { input: 5, output: 40 } }],
          expose: "all",
        },
      },
    ),
  );
  await store.putProvider(provider("plain", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["img/*", "plain/*"]);
  const gw = await mount(t, store, {}, { secrets: [ADMIN] });
  const call = (body: Record<string, unknown>, text = key.text) =>
    send(gw.port, "/v1/images/generations", {
      headers: { authorization: `Bearer ${text}` },
      body,
    });
  return { up, store, call };
}

void test("an image request passes through with the wire model, its usage and cost in the ledger", async (t) => {
  const { up, store, call } = await setup(t, json(200, IMAGE));
  const answer = await call({
    model: "img/gpt-image-1",
    prompt: `A cat holding a sign that says ${ADMIN}`,
    size: "1024x1024",
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json(), IMAGE);
  const seen = up.seen[0]!;
  assert.equal(seen.url, "/v1/images/generations");
  assert.equal(seen.headers.authorization, "Bearer sk-upstream-a-0001");
  const sent = seen.json();
  assert.equal(sent.model, "gpt-image-1");
  assert.equal(sent.size, "1024x1024");
  assert.ok(!String(sent.prompt).includes(ADMIN), "the prompt is redacted");
  await until(() => store.entries.length === 1);
  const entry = store.entries[0]!;
  assert.equal(entry.inbound.path, "/v1/images/generations");
  assert.equal(entry.status, 200);
  assert.equal(entry.modelRef, "img/gpt-image-1");
  assert.deepEqual([entry.usage?.input, entry.usage?.output], [50, 4160]);
  assert.ok(
    Math.abs(entry.cost!.amountUsd - (50 * 5 + 4160 * 40) / 1e6) < 1e-12,
  );
  assert.ok(entry.patches.includes("redact:1"));
});

void test("a failing credential fails over; models without an images endpoint or not allowed are refused", async (t) => {
  const { up, store, call } = await setup(
    t,
    json(500, { error: { message: "busy" } }),
    json(200, IMAGE),
  );
  const answer = await call({ model: "img/gpt-image-1", prompt: "a dog" });
  assert.equal(answer.status, 200);
  assert.equal(up.seen.length, 2);
  assert.equal(up.seen[1]!.headers.authorization, "Bearer sk-upstream-b-0002");
  await until(() => store.entries.length === 1);
  assert.deepEqual(
    store.entries[0]!.attempts.map((attempt) => [
      attempt.credentialId,
      attempt.decision,
    ]),
    [
      ["cred-0", "failover"],
      ["cred-1", "success"],
    ],
  );
  const none = await call({ model: "plain/model-a", prompt: "x" });
  assert.equal(none.status, 404);
  assert.equal(at(none.json(), "error", "code"), "images_unavailable");
  const denied = await call({ model: "other/x", prompt: "x" });
  assert.equal(denied.status, 403);
  const invalid = await call({ model: "no-ref", prompt: "x" });
  assert.equal(invalid.status, 400);
});

void test("streamed partial images are forwarded, with the completed event's usage", async (t) => {
  const events =
    `event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: "AA==", partial_image_index: 0 })}\n\n` +
    `event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: "BB==", usage: { input_tokens: 10, output_tokens: 20 } })}\n\n`;
  const { store, call } = await setup(t, (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events);
  });
  const answer = await call({
    model: "img/gpt-image-1",
    prompt: "a fox",
    stream: true,
    partial_images: 1,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.text, events);
  await until(() => store.entries.length === 1);
  assert.deepEqual(
    [store.entries[0]!.usage?.input, store.entries[0]!.usage?.output],
    [10, 20],
  );
  assert.equal(store.entries[0]!.inbound.stream, true);
});
