// SPDX-License-Identifier: MIT
/**
 * Vision fallback: images for a model without image input are described by
 * the configured vision model through the gateway itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GatewayFeatures } from "@harnesshub/core/gateway-features";
import {
  addKey,
  at,
  CHAT_REPLY,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  until,
} from "./shared-support.js";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const OTHER = "data:image/png;base64,R0lGODlhAQABAAAAACw=";
const DESCRIPTION = "A red square with the word HELLO";

const described = json(200, {
  id: "v",
  object: "chat.completion",
  model: "eyes",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: DESCRIPTION },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 300, completion_tokens: 12, total_tokens: 312 },
});

async function setup(
  t: test.TestContext,
  features: GatewayFeatures,
  ...visionReplies: Parameters<typeof upstream>[1][]
) {
  const text = await upstream(t, CHAT_REPLY);
  const eyes = await upstream(
    t,
    ...(visionReplies.length ? visionReplies : [described]),
  );
  const store = new MemoryStore();
  // model-a takes text only, by its metadata.
  await store.putProvider(provider("text", { chat: `${text.base}/v1` }));
  await store.putProvider(
    provider(
      "eyes",
      { chat: `${eyes.base}/v1` },
      {
        models: {
          source: "manual",
          list: [{ id: "see", inputModalities: ["text", "image"] }],
          expose: "all",
        },
      },
    ),
  );
  const key = await addKey(store, ["text/*"]);
  const gw = await mount(t, store, {}, { features: () => features });
  const call = (images: string[]) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: {
        model: "text/model-a",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              ...images.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          },
        ],
      },
    });
  return { text, eyes, store, call };
}

const ON: GatewayFeatures = {
  schemaVersion: 1,
  redaction: { enabled: true, rules: [] },
  vision: { model: "eyes/see" },
};

void test("images become their description for a model without image input, once per image", async (t) => {
  const { text, eyes, store, call } = await setup(t, ON);
  const first = await call([IMAGE]);
  assert.equal(first.status, 200);
  // The vision model got the image; the text model got the description only.
  const asked = eyes.seen[0]!.json();
  assert.equal(
    at(asked, "messages", 0, "content", 1, "image_url", "url"),
    IMAGE,
  );
  assert.equal(asked.model, "see");
  const sent = JSON.stringify(text.seen[0]!.json());
  assert.ok(sent.includes(`[image: ${DESCRIPTION}]`));
  assert.ok(!sent.includes("image_url") && !sent.includes(IMAGE));
  // Two ledger entries: the describing call (its own) and the call itself.
  await until(() => store.entries.length === 2);
  const describing = store.entries.find(
    (entry) => entry.agent?.id === "harnesshub-vision",
  )!;
  const main = store.entries.find((entry) => entry !== describing)!;
  assert.equal(describing.provider, "eyes");
  assert.equal(describing.keyId, undefined);
  assert.deepEqual(describing.agent, {
    id: "harnesshub-vision",
    source: "route",
  });
  assert.ok(main.patches.includes(`vision:${describing.callId}`));
  // The same image again: from the cache, no describing call.
  const second = await call([IMAGE]);
  assert.equal(second.status, 200);
  assert.equal(eyes.seen.length, 1);
  await until(() => store.entries.length === 3);
  assert.ok(store.entries[2]!.patches.includes("vision:cached:1"));
});

void test("an image of this turn that cannot be described fails the call; without a vision model nothing changes", async (t) => {
  const failing = await setup(
    t,
    ON,
    json(400, { error: { message: "unsupported image" } }),
  );
  const refused = await failing.call([OTHER]);
  assert.equal(refused.status, 502);
  assert.equal(at(refused.json(), "error", "code"), "vision_failed");
  assert.equal(failing.text.seen.length, 0, "the text model was not called");

  const off = await setup(t, {
    schemaVersion: 1,
    redaction: { enabled: true, rules: [] },
  });
  const placeholder = await off.call([IMAGE]);
  assert.equal(placeholder.status, 200);
  assert.equal(off.eyes.seen.length, 0);
  // Passed through as before: the image goes as it is.
  assert.ok(JSON.stringify(off.text.seen[0]!.json()).includes(IMAGE));
});
