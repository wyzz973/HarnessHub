// SPDX-License-Identifier: MIT
/**
 * Vision fallback: images for a model without image input are described by
 * the configured vision model through the gateway itself, as the request's
 * Gateway Key and within its limits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GatewayFeatures } from "@harnesshub/core/gateway-features";
import type { GatewayKeyRecord } from "@harnesshub/core/model-plane";
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
  options: {
    allow?: string[];
    key?: Partial<GatewayKeyRecord>;
    limits?: Record<string, number>;
  } = {},
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
  const key = await addKey(
    store,
    options.allow ?? ["text/*", "eyes/*"],
    options.key,
  );
  const gw = await mount(t, store, options.limits ?? {}, {
    features: () => features,
  });
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
  return { text, eyes, store, call, key, gw };
}

/** `n` distinct images. */
const images = (n: number, tag = "i") =>
  Array.from(
    { length: n },
    (_, index) =>
      `data:image/png;base64,${Buffer.from(`${tag}-${index}`).toString("base64")}`,
  );

const ON: GatewayFeatures = {
  schemaVersion: 1,
  redaction: { enabled: true, rules: [] },
  vision: { model: "eyes/see" },
};

void test("images become their description for a model without image input, once per image", async (t) => {
  const { text, eyes, store, call, key } = await setup(t, ON);
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
  // Two ledger entries: the describing call (the key's, for vision) and the call itself.
  await until(() => store.entries.length === 2);
  const describing = store.entries.find(
    (entry) => entry.agent?.id === "harnesshub-vision",
  )!;
  const main = store.entries.find((entry) => entry !== describing)!;
  assert.equal(describing.provider, "eyes");
  assert.equal(describing.keyId, key.keyId);
  assert.deepEqual(describing.scope, { kind: "client", name: "test" });
  assert.equal(describing.purpose, "vision");
  assert.deepEqual(describing.agent, {
    id: "harnesshub-vision",
    source: "route",
  });
  assert.equal(main.keyId, key.keyId);
  assert.equal(main.purpose, undefined);
  assert.ok(main.patches.includes("vision:described:1"));
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
    {},
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

void test("a key that may not use the vision model gets no descriptions; the vision model is not called", async (t) => {
  const { text, eyes, store, call } = await setup(t, ON, {
    allow: ["text/*"],
  });
  const answer = await call([IMAGE]);
  assert.equal(answer.status, 200);
  assert.equal(eyes.seen.length, 0);
  // As without a vision model: the image goes as it is.
  const sent = JSON.stringify(text.seen[0]!.json());
  assert.ok(sent.includes(IMAGE) && !sent.includes("[image: "));
  await until(() => store.entries.length === 1);
  assert.ok(store.entries[0]!.patches.includes("vision:not-allowed"));
});

void test("a request describes at most maxDescribedImages images, newest first, within maxInternalCalls; the patches are counts", async (t) => {
  const { eyes, store, call } = await setup(t, ON, {
    limits: { maxDescribedImages: 2 },
  });
  const five = images(5);
  assert.equal((await call(five)).status, 200);
  assert.equal(eyes.seen.length, 2);
  // The newest two: the last images of the turn.
  assert.deepEqual(
    eyes.seen.map((seen) =>
      at(seen.json(), "messages", 0, "content", 1, "image_url", "url"),
    ),
    [five[4], five[3]],
  );
  await until(() => store.entries.length === 3);
  const main = store.entries.find((entry) => !entry.purpose)!;
  assert.deepEqual(
    main.patches.filter((patch) => patch.startsWith("vision:")),
    ["vision:described:2", "vision:skipped:3"],
  );

  const capped = await setup(t, ON, {
    limits: { maxDescribedImages: 5, maxInternalCalls: 1 },
  });
  assert.equal((await capped.call(images(3, "c"))).status, 200);
  assert.equal(capped.eyes.seen.length, 1);
  await until(() => capped.store.entries.length === 2);
  assert.deepEqual(
    capped.store.entries
      .find((entry) => !entry.purpose)!
      .patches.filter((patch) => patch.startsWith("vision:")),
    ["vision:described:1", "vision:skipped:2"],
  );
});

void test("many images: 16 described, the call recorded and charged, never a ledger entry too large to commit", async (t) => {
  const { eyes, store, call, key, gw } = await setup(t, ON, {
    key: { quota: { budgets: [{ period: "day", tokens: 1_000_000 }] } },
  });
  const answer = await call(images(120, "many"));
  assert.equal(answer.status, 200, answer.text);
  assert.equal(eyes.seen.length, 16);
  await until(() => store.entries.length === 17);
  const main = store.entries.find((entry) => !entry.purpose)!;
  assert.ok(main.patches.includes("vision:skipped:104"));
  assert.ok(main.patches.length < 20);
  // Every call counts against the key: 16 descriptions and the call itself.
  const limit = await gw.handler.keyLimit(key.keyId);
  assert.equal(limit?.budgets[0]?.calls, 17);
  assert.equal(
    limit?.budgets[0]?.tokens,
    store.entries.reduce(
      (sum, entry) =>
        sum +
        (entry.usage
          ? entry.usage.input +
            entry.usage.output +
            entry.usage.reasoning +
            entry.usage.cacheWrite
          : 0),
      0,
    ),
  );
});

void test("descriptions take the key's requests per minute: when they run out, the call is refused with 429", async (t) => {
  const { text, eyes, store, call, key } = await setup(t, ON, {
    key: { quota: { requestsPerMinute: 2 } },
  });
  // The call takes one request, the first description the other.
  const refused = await call(images(3, "rpm"));
  assert.equal(refused.status, 429, refused.text);
  assert.equal(at(refused.json(), "error", "code"), "quota_exceeded");
  assert.equal(eyes.seen.length, 1);
  assert.equal(text.seen.length, 0);
  await until(() => store.entries.length >= 3);
  const own = store.entries.filter((entry) => entry.purpose === "vision");
  assert.ok(own.every((entry) => entry.keyId === key.keyId));
  assert.ok(own.some((entry) => entry.status === 429));
});
