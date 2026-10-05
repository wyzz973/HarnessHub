// SPDX-License-Identifier: MIT
/** Images: generations and edits on a provider's images endpoint, or drawn through chat, one way after the other. */
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
  const call = (
    body: Record<string, unknown> | Buffer,
    text = key.text,
    path = "/v1/images/generations",
    type?: string,
  ) =>
    send(gw.port, path, {
      headers: {
        authorization: `Bearer ${text}`,
        ...(type ? { "content-type": type } : {}),
      },
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

void test("a failing credential fails over; a chat model that draws nothing, or one not allowed, is refused", async (t) => {
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
  // plain has no images endpoint: it is asked in chat, and answers with text.
  const none = await call({ model: "plain/model-a", prompt: "x" });
  assert.equal(none.status, 502);
  assert.match(
    String(at(none.json(), "error", "message")),
    /plain\/model-a drew nothing/,
  );
  assert.equal(up.seen.at(-1)!.url, "/v1/chat/completions");
  assert.deepEqual(up.seen.at(-1)!.json().modalities, ["image", "text"]);
  const denied = await call({ model: "other/x", prompt: "x" });
  assert.equal(denied.status, 403);
  // A bare name resolves as for chat: the one model of that ID, or nothing.
  const bare = await call({ model: "gpt-image-1", prompt: "a cat" });
  assert.equal(bare.status, 200);
  assert.equal(up.seen.at(-1)!.json().model, "gpt-image-1");
  const unknown = await call({ model: "no-ref", prompt: "x" });
  assert.equal(unknown.status, 404);
  assert.equal(at(unknown.json(), "error", "code"), "model_not_found");
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

/** A data URL of a tiny PNG, as vendors give images back. */
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const DRAWN = {
  id: "c",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Here it is.",
        images: [{ type: "image_url", image_url: { url: PNG } }],
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 1290 },
};

void test("edits: JSON passes through to /images/edits; a multipart form is sent again as one, model and all", async (t) => {
  const { up, store, call } = await setup(t, json(200, IMAGE));
  const answer = await call(
    {
      model: "img/gpt-image-1",
      prompt: "make it blue",
      images: [{ image_url: PNG }],
    },
    undefined,
    "/v1/images/edits",
  );
  assert.equal(answer.status, 200, answer.text);
  assert.equal(up.seen[0]!.url, "/v1/images/edits");
  assert.equal(up.seen[0]!.json().model, "gpt-image-1");
  assert.deepEqual(up.seen[0]!.json().images, [{ image_url: PNG }]);
  // An edit without an image to edit is refused before any provider.
  const empty = await call(
    { model: "img/gpt-image-1", prompt: "make it blue" },
    undefined,
    "/v1/images/edits",
  );
  assert.equal(empty.status, 400);
  // multipart/form-data, as OpenAI's SDKs send an edit.
  const form = new FormData();
  form.append("model", "img/gpt-image-1");
  form.append("prompt", "make it red");
  form.append("size", "1024x1536");
  form.append(
    "image[]",
    new Blob([Buffer.from("first-image")], { type: "image/png" }),
    "a.png",
  );
  form.append(
    "image[]",
    new Blob([Buffer.from("second-image")], { type: "image/webp" }),
    "b.webp",
  );
  form.append(
    "mask",
    new Blob([Buffer.from("the-mask")], { type: "image/png" }),
    "mask.png",
  );
  const encoded = new Request("http://form.invalid/", {
    method: "POST",
    body: form,
  });
  const multipart = await call(
    Buffer.from(await encoded.arrayBuffer()),
    undefined,
    "/v1/images/edits",
    encoded.headers.get("content-type")!,
  );
  assert.equal(multipart.status, 200, multipart.text);
  const seen = up.seen.at(-1)!;
  assert.equal(seen.url, "/v1/images/edits");
  assert.match(
    String(seen.headers["content-type"]),
    /^multipart\/form-data; boundary=/,
  );
  const received = await new Response(seen.body, {
    headers: { "content-type": String(seen.headers["content-type"]) },
  }).formData();
  assert.equal(received.get("model"), "gpt-image-1");
  assert.equal(received.get("prompt"), "make it red");
  assert.equal(received.get("size"), "1024x1536");
  const images = received.getAll("image[]") as File[];
  assert.deepEqual(
    await Promise.all(
      images.map(async (file) => [
        file.name,
        file.type,
        Buffer.from(await file.arrayBuffer()).toString(),
      ]),
    ),
    [
      ["a.png", "image/png", "first-image"],
      ["b.webp", "image/webp", "second-image"],
    ],
  );
  assert.equal(
    Buffer.from(await (received.get("mask") as File).arrayBuffer()).toString(),
    "the-mask",
  );
  await until(() => store.entries.length === 3);
  assert.deepEqual(
    store.entries.map((entry) => [entry.inbound.path, entry.status]),
    [
      ["/v1/images/edits", 200],
      ["/v1/images/edits", 400],
      ["/v1/images/edits", 200],
    ],
  );
});

void test("an images endpoint that answers 404 is asked again in chat, once; a chat model draws once per image", async (t) => {
  const { up, store, call } = await setup(t, (response, seen) =>
    seen.url === "/v1/images/generations"
      ? json(404, { error: { message: "no such route" } })(
          response,
          seen,
          undefined as never,
        )
      : json(200, DRAWN)(response, seen, undefined as never),
  );
  const answer = await call({
    model: "img/gpt-image-1",
    prompt: "a fox",
    size: "1536x1024",
    n: 2,
  });
  assert.equal(answer.status, 200, answer.text);
  const body = answer.json() as {
    data: { b64_json: string; mime_type: string }[];
    usage: Record<string, number>;
    text: string;
  };
  assert.deepEqual(body.data, [
    { b64_json: "iVBORw0KGgo=", mime_type: "image/png" },
    { b64_json: "iVBORw0KGgo=", mime_type: "image/png" },
  ]);
  assert.deepEqual(body.usage, {
    input_tokens: 24,
    output_tokens: 2580,
    total_tokens: 2604,
  });
  assert.deepEqual(
    up.seen.map((seen) => seen.url),
    ["/v1/images/generations", "/v1/chat/completions", "/v1/chat/completions"],
  );
  const asked = up.seen[1]!.json();
  assert.equal(asked.model, "gpt-image-1");
  assert.equal(asked.stream, false);
  assert.deepEqual(asked.image_config, { aspect_ratio: "3:2" });
  assert.match(
    String(at(asked, "messages", 0, "content", 0, "text")),
    /^a fox\n\nAspect ratio: 3:2\.$/,
  );
  await until(() => store.entries.length === 1);
  const entry = store.entries[0]!;
  assert.deepEqual(
    entry.attempts.map((attempt) => [
      attempt.credentialId,
      attempt.decision,
      attempt.status,
    ]),
    [
      ["cred-0", "retry", 404],
      ["cred-0", "success", 200],
    ],
  );
  assert.ok(entry.patches.includes("images:chat-after-images"));
  assert.ok(entry.patches.includes("images:via-chat"));
  assert.deepEqual([entry.usage?.input, entry.usage?.output], [24, 2580]);
});

void test("a chat model's drawing streams as completed events when the request streams", async (t) => {
  const { up, call } = await setup(t, json(200, DRAWN));
  const answer = await call({
    model: "plain/model-a",
    prompt: "a fox",
    stream: true,
  });
  assert.equal(answer.status, 200);
  assert.match(String(answer.headers["content-type"]), /text\/event-stream/);
  const events = answer.text.trim().split("\n\n");
  assert.equal(events.length, 1);
  assert.match(events[0]!, /^event: image_generation\.completed\ndata: /);
  const data = JSON.parse(events[0]!.split("data: ")[1]!) as Record<
    string,
    unknown
  >;
  assert.equal(data.type, "image_generation.completed");
  assert.equal(data.b64_json, "iVBORw0KGgo=");
  assert.equal(up.seen[0]!.url, "/v1/chat/completions");
});
