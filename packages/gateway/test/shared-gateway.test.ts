// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { resolveHandlerLimits } from "../src/limits.js";
import {
  ArraySegmenter,
  rewriteModel,
  SseSegmenter,
  upstreamUrl,
} from "../src/passthrough.js";
import { isGatewayPath } from "../src/server.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  events,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

void test("limits resolve to the 03 defaults and reject unknown or out-of-range values", () => {
  const limits = resolveHandlerLimits();
  assert.equal(limits.maxRequestBytes, 64 * 1024 * 1024);
  assert.equal(limits.holdMs, 15_000);
  assert.equal(limits.maxConcurrentPerCredential, 8);
  assert.equal(resolveHandlerLimits({ holdMs: 5 }).holdMs, 5);
  assert.throws(
    () => resolveHandlerLimits({ holdMS: 5 }),
    /Unknown gateway limit holdMS/,
  );
  assert.throws(
    () => resolveHandlerLimits({ maxRequestBytes: 512 * 1024 * 1024 }),
    /maxRequestBytes must be an integer/,
  );
  assert.throws(() => resolveHandlerLimits({ keepaliveGapMs: 10 }), RangeError);
  assert.throws(() => resolveHandlerLimits([]), RangeError);
});

void test("rewriteModel changes only top-level model strings and keeps every other byte", () => {
  const text =
    '{ "messages" : [{"role":"user","model":"inner"}],\n\t"model":"a/b" ,"meta":{"model":"x"},"model" :"dup"}';
  assert.equal(
    rewriteModel(text, "wire-1"),
    '{ "messages" : [{"role":"user","model":"inner"}],\n\t"model":"wire-1" ,"meta":{"model":"x"},"model" :"wire-1"}',
  );
  assert.equal(
    rewriteModel('{"m\\u006fdel":"a/b","x":"\\"model\\""}', "w"),
    '{"m\\u006fdel":"w","x":"\\"model\\""}',
  );
  assert.equal(rewriteModel('{"model":1}', "w"), undefined);
  assert.equal(rewriteModel("[]", "w"), undefined);
});

void test("segmenters split at event boundaries for any chunking without changing bytes", () => {
  const sse = Buffer.from(
    'data: {"a":1}\n\n: comment\r\n\r\nevent: x\rdata: {"b":"é"}\r\r' +
      'data: {"c":2}\r\n\r\ndata: [DONE]\n\n',
  );
  const array = Buffer.from('[{"a":"]}"},\r\n{"b":{"c":[1]}}\n]');
  for (const [make, input] of [
    [() => new SseSegmenter(1 << 20), sse],
    [() => new ArraySegmenter(1 << 20), array],
  ] as const)
    for (let size = 1; size <= input.length; size++) {
      const segmenter = make();
      const segments = [];
      for (let start = 0; start < input.length; start += size)
        segments.push(...segmenter.push(input.subarray(start, start + size)));
      segments.push(...segmenter.end());
      assert.deepEqual(
        Buffer.concat(segments.map((segment) => segment.bytes)),
        input,
      );
      assert.equal(segments.length, input === sse ? 5 : 3, `size ${size}`);
    }
  const elements = new ArraySegmenter(1 << 20).push(array);
  assert.deepEqual(
    elements.map((segment) => segment.text),
    ['{"a":"]}"}', '{"b":{"c":[1]}}', ""],
  );
  assert.throws(
    () => new SseSegmenter(8).push(Buffer.from("data: 0123456789")),
    /larger than the gateway limit/,
  );
});

void test("upstream URLs append the operation path to the SDK base URL, with or without trailing slashes", () => {
  const gemini = {
    version: "v1beta",
    method: "streamGenerateContent" as const,
    sse: true,
  };
  for (const slash of ["", "/", "//"]) {
    assert.equal(
      upstreamUrl("chat", `http://h:1/v1${slash}`, "m", undefined).href,
      "http://h:1/v1/chat/completions",
    );
    assert.equal(
      upstreamUrl("responses", `http://h:1/v1${slash}`, "m", undefined).href,
      "http://h:1/v1/responses",
    );
    assert.equal(
      upstreamUrl("anthropic", `https://h/anthropic${slash}`, "m", undefined)
        .href,
      "https://h/anthropic/v1/messages",
    );
    assert.equal(
      upstreamUrl("gemini", `https://h${slash}`, "gemini-x", gemini).href,
      "https://h/v1beta/models/gemini-x:streamGenerateContent?alt=sse",
    );
  }
});

void test("gateway paths cover /v1, /v1beta, /v1alpha and the prefix-less OpenAI and Anthropic paths", () => {
  for (const path of [
    "/v1/chat/completions",
    "/v1beta/models/x:generateContent",
    "/v1alpha/models",
    "/chat/completions",
    "/responses",
    "/messages",
    "/messages/count_tokens",
    "/models/a/b",
    "/v1",
  ])
    assert.ok(isGatewayPath(path), path);
  for (const path of ["/api/v1/runs", "/", "/console", "/v2/models"])
    assert.ok(!isGatewayPath(path), path);
});

void test("every Gateway Key rejection uses the inbound format, the gateway source header and a ledger row", async (t) => {
  const store = new MemoryStore();
  await store.putProvider(provider("prov", { chat: "http://127.0.0.1:9/v1" }));
  const valid = await addKey(store, ["prov/*"]);
  const revoked = await addKey(store, ["prov/*"], {
    revokedAt: "2026-10-01T00:00:00.000Z",
  });
  const expired = await addKey(store, ["prov/*"], {
    expiresAt: "2026-10-02T11:00:00.000Z",
  });
  const gw = await mount(t, store);
  // A different last character, so the secret never matches by chance.
  const tampered =
    valid.text.slice(0, -1) + (valid.text.endsWith("A") ? "B" : "A");
  const chat = { model: "prov/model-a", messages: [] };
  const cases: {
    path: string;
    headers: Record<string, string>;
    status: number;
    reason: string;
    keyed: boolean;
    shape: "openai" | "anthropic" | "google";
  }[] = [
    {
      path: "/v1/chat/completions",
      headers: {},
      status: 401,
      reason: "invalid_key",
      keyed: false,
      shape: "openai",
    },
    {
      path: "/v1/messages",
      headers: { "x-api-key": "sk-not-a-gateway-key" },
      status: 401,
      reason: "invalid_key",
      keyed: false,
      shape: "anthropic",
    },
    {
      path: "/v1/chat/completions",
      headers: { authorization: `Bearer ${tampered}` },
      status: 401,
      reason: "invalid_key",
      keyed: false,
      shape: "openai",
    },
    {
      path: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${valid.text}`,
        "x-api-key": revoked.text,
      },
      status: 401,
      reason: "invalid_key",
      keyed: false,
      shape: "openai",
    },
    {
      path: "/v1/responses",
      headers: { authorization: `Bearer ${revoked.text}` },
      status: 401,
      reason: "key_revoked",
      keyed: true,
      shape: "openai",
    },
    {
      path: `/v1beta/models/prov/model-a:generateContent?key=${expired.text}`,
      headers: {},
      status: 401,
      reason: "key_expired",
      keyed: true,
      shape: "google",
    },
    {
      path: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${valid.text}`,
        origin: "https://evil.example",
      },
      status: 403,
      reason: "origin_forbidden",
      keyed: true,
      shape: "openai",
    },
    {
      path: "/v1/messages",
      headers: { "x-api-key": valid.text, host: "attacker.example:3180" },
      status: 403,
      reason: "origin_forbidden",
      keyed: true,
      shape: "anthropic",
    },
    {
      path: "/v1/embeddings",
      headers: { authorization: `Bearer ${valid.text}` },
      status: 404,
      reason: "route_not_found",
      keyed: true,
      shape: "openai",
    },
    {
      path: "/v1/models/%E0%A4%A",
      headers: { authorization: `Bearer ${valid.text}` },
      status: 400,
      reason: "route_invalid",
      keyed: true,
      shape: "openai",
    },
  ];
  for (const [index, item] of cases.entries()) {
    const answer = await send(
      gw.port,
      item.path,
      item.path.startsWith("/v1/models")
        ? { headers: item.headers }
        : { headers: item.headers, body: chat },
    );
    assert.equal(answer.status, item.status, item.reason);
    assert.equal(answer.headers["x-hh-error-source"], "gateway");
    const body = answer.json();
    if (item.shape === "anthropic") assert.equal(body.type, "error");
    if (item.shape === "google") assert.equal(at(body, "error", "code"), 401);
    if (item.shape === "openai")
      assert.equal(at(body, "error", "code"), item.reason);
    assert.ok(!answer.text.includes("hhk_"), "keys are never echoed");
    const entry = store.entries[index];
    assert.ok(entry, `ledger row for ${item.reason}`);
    assert.equal(entry.rejected, true);
    assert.equal(entry.rejectReason, item.reason);
    assert.equal(entry.status, item.status);
    assert.equal(entry.errorSource, "gateway");
    assert.equal(entry.keyId !== undefined, item.keyed, item.reason);
    assert.equal(entry.attempts.length, 0);
  }
  assert.deepEqual(store.touches, [valid.keyId]);
});

void test("rejections beyond 20 per key, reason and minute are aggregated into one count", async (t) => {
  const store = new MemoryStore();
  const gw = await mount(t, store);
  for (let index = 0; index < 23; index++) {
    const answer = await send(gw.port, "/v1/chat/completions", {
      body: { model: "x/y" },
    });
    assert.equal(answer.status, 401);
  }
  assert.equal(store.entries.length, 20);
  gw.clock.now += 60_000;
  await send(gw.port, "/v1/chat/completions", { body: { model: "x/y" } });
  assert.equal(store.entries.length, 22);
  assert.match(store.entries[20]!.error ?? "", /^3 further rejections/);
  assert.equal(store.entries[20]!.rejectReason, "invalid_key");
});

void test("the model allowlist admits exact refs, provider/* and groups and records model_not_allowed", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  await store.putProvider(provider("other", { chat: `${up.base}/v1` }));
  await store.putRouteGroup(group("fast", ["other/model-a"]));
  const key = await addKey(store, ["prov/model-a", "group/fast"]);
  const gw = await mount(t, store);
  const call = (model: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: [{ role: "user", content: "hi" }] },
    });
  assert.equal((await call("prov/model-a")).status, 200);
  assert.equal((await call("group/fast")).status, 200);
  const denied = await call("other/model-a");
  assert.equal(denied.status, 403);
  assert.equal(at(denied.json(), "error", "code"), "model_not_allowed");
  assert.equal(up.seen.length, 2);
  const row = store.entries.at(-1)!;
  assert.equal(row.rejectReason, "model_not_allowed");
  assert.equal(row.requestedModel, "other/model-a");
  const bad = await call("no-slash-model");
  assert.equal(bad.status, 400);
  assert.equal(at(bad.json(), "error", "code"), "model_invalid");
  const missing = await send(gw.port, "/v1/chat/completions", {
    headers: {
      authorization: `Bearer ${(await addKey(store, ["ghost/*"])).text}`,
    },
    body: { model: "ghost/m", messages: [] },
  });
  assert.equal(missing.status, 404);
  assert.equal(store.entries.at(-1)!.status, 404);
  assert.equal(store.entries.at(-1)!.rejected, undefined);
});

void test("/v1/models and /v1beta/models list only allowed, exposed models and groups with metadata", async (t) => {
  const store = new MemoryStore();
  await store.putProvider(
    provider("prov", {
      chat: "http://127.0.0.1:9/v1",
      anthropic: "http://127.0.0.1:9",
    }),
  );
  await store.putProvider(
    provider(
      "hidden",
      { chat: "http://127.0.0.1:9/v1" },
      {
        models: {
          source: "manual",
          list: [{ id: "m" }, { id: "n" }],
          expose: ["n"],
        },
        translateOnly: true,
      },
    ),
  );
  await store.putRouteGroup(group("fast", ["prov/model-a"]));
  await store.putRouteGroup(group("slow", ["prov/model-b"]));
  const key = await addKey(store, ["prov/*", "hidden/*", "group/fast"]);
  const gw = await mount(t, store);
  const auth = { authorization: `Bearer ${key.text}` };
  const list = (await send(gw.port, "/v1/models", { headers: auth })).json();
  const data = list.data as Record<string, unknown>[];
  assert.deepEqual(
    data.map((model) => model.id),
    ["prov/model-a", "prov/model-b", "hidden/n", "group/fast"],
  );
  assert.equal(data[0]!.context_window, 128_000);
  assert.equal(data[0]!.max_output_tokens, 8_192);
  assert.equal(data[0]!.reasoning, true);
  assert.deepEqual(data[0]!.input_modalities, ["text"]);
  assert.deepEqual(data[0]!.native_endpoints, ["chat", "anthropic"]);
  assert.equal(data[0]!.owned_by, "prov");
  assert.deepEqual(data[2]!.native_endpoints, []);
  assert.equal(data[3]!.context_window, 128_000);
  assert.equal(data[3]!.native_endpoints, undefined);
  const one = await send(gw.port, "/models/prov/model-a", {
    headers: { "x-api-key": key.text },
  });
  assert.equal(one.json().id, "prov/model-a");
  assert.equal(
    (await send(gw.port, "/v1/models/group/slow", { headers: auth })).status,
    404,
  );
  const gemini = (await send(gw.port, `/v1beta/models?key=${key.text}`)).json();
  const models = gemini.models as Record<string, unknown>[];
  assert.equal(models[0]!.name, "models/prov/model-a");
  assert.equal(models[0]!.inputTokenLimit, 128_000);
  assert.equal(store.entries.length, 0, "listing is not a model call");
});

void test("chat passthrough rewrites only the model, swaps the credential and forwards the stream bytes", async (t) => {
  const store = new MemoryStore();
  const stream =
    'data:{"id":"c1","model":"served-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\r\n\r\n' +
    ": upstream comment\r\n\r\n" +
    'data: {"id":"c1","model":"served-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":6}}}\r\n\r\n' +
    "data: [DONE]\r\n\r\n";
  const up = await upstream(t, events(stream));
  await store.putProvider(
    provider("prov", { chat: `${up.base}/v1` }, { wire: { "*": "vendor-*" } }),
  );
  const key = await addKey(store, ["prov/*"]);
  const gw = await mount(t, store);
  const body =
    '{"model" : "prov/model-a","stream":true,  "messages":[{"role":"user","content":"hi","model":"keep"}],"store":true,"x_custom":{"a":[1,2]}}';
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}`, "user-agent": "client/1" },
    body,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.text, stream);
  const seen = up.seen[0]!;
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(
    seen.body.toString(),
    body.replace('"prov/model-a"', '"vendor-model-a"'),
  );
  assert.equal(seen.headers.authorization, "Bearer sk-upstream-a-0001");
  assert.equal(seen.headers["user-agent"], "client/1");
  assert.ok(!JSON.stringify(seen.headers).includes("hhk_"));
  const entry = store.entries[0]!;
  assert.equal(entry.mode, "passthrough");
  assert.equal(entry.status, 200);
  assert.equal(entry.modelRef, "prov/model-a");
  assert.equal(entry.wireModel, "vendor-model-a");
  assert.equal(entry.servedModel, "served-1");
  assert.equal(entry.completion, "explicit");
  assert.equal(entry.finishReason, "stop");
  assert.deepEqual(entry.usage, {
    input: 4,
    cacheRead: 6,
    cacheWrite: 0,
    output: 4,
    reasoning: 0,
    source: "reported",
  });
  assert.equal(entry.cost?.priceSource, "provider");
  assert.ok(
    Math.abs(entry.cost.amountUsd - (4 + 6 * 0.5 + 4 * 2) / 1e6) < 1e-12,
  );
  assert.equal(entry.attempts.length, 1);
  assert.equal(entry.attempts[0]!.decision, "success");
  assert.equal(entry.inbound.stream, true);
});

void test("Responses, Anthropic and Gemini passthrough keep the body and response bytes and use the provider's header", async (t) => {
  const store = new MemoryStore();
  const responsesStream =
    'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"model":"gpt-x"}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"ok"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"model":"gpt-x","status":"completed","usage":{"input_tokens":9,"output_tokens":3,"output_tokens_details":{"reasoning_tokens":1}}}}\n\n';
  const anthropicStream =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":7,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}\n\n' +
    'event: ping\ndata: {"type": "ping"}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"yo"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const geminiBody = {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "g" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 3,
      cachedContentTokenCount: 4,
    },
    modelVersion: "gemini-x",
  };
  const up = await upstream(
    t,
    events(responsesStream),
    events(anthropicStream),
    json(200, geminiBody),
  );
  await store.putProvider(
    provider(
      "oai",
      { responses: `${up.base}/v1` },
      { auth: { apiKeyHeader: "custom:x-vendor-key" } },
    ),
  );
  await store.putProvider(
    provider(
      "ant",
      { anthropic: `${up.base}/` },
      { auth: { apiKeyHeader: "x-api-key" }, headers: { "x-tenant": "t1" } },
    ),
  );
  await store.putProvider(
    provider(
      "gem",
      { gemini: `${up.base}/` },
      { auth: { apiKeyHeader: "x-goog-api-key" } },
    ),
  );
  const key = await addKey(store, ["oai/*", "ant/*", "gem/*"]);
  const gw = await mount(t, store);

  const responsesBody =
    '{"model":"oai/model-a","input":"hi","stream":true,"store":false,"include":["reasoning.encrypted_content"]}';
  const responses = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: responsesBody,
  });
  assert.equal(responses.text, responsesStream);
  assert.equal(up.seen[0]!.url, "/v1/responses");
  assert.equal(
    up.seen[0]!.body.toString(),
    responsesBody.replace("oai/model-a", "model-a"),
  );
  assert.equal(up.seen[0]!.headers["x-vendor-key"], "sk-upstream-a-0001");
  assert.equal(up.seen[0]!.headers.authorization, undefined);

  const anthropicBody =
    '{"model":"ant/model-a","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}],"metadata":{"user_id":"u"}}';
  const anthropic = await send(gw.port, "/v1/messages?beta=true", {
    headers: {
      "x-api-key": key.text,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "a-1,b-2",
    },
    body: anthropicBody,
  });
  assert.equal(anthropic.text, anthropicStream);
  assert.equal(up.seen[1]!.url, "/v1/messages");
  assert.equal(
    up.seen[1]!.body.toString(),
    anthropicBody.replace("ant/model-a", "model-a"),
  );
  assert.equal(up.seen[1]!.headers["x-api-key"], "sk-upstream-a-0001");
  assert.equal(up.seen[1]!.headers["anthropic-version"], "2023-06-01");
  assert.equal(up.seen[1]!.headers["anthropic-beta"], "a-1,b-2");
  assert.equal(up.seen[1]!.headers["x-tenant"], "t1");

  const geminiRequest =
    '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}';
  const gemini = await send(
    gw.port,
    `/v1beta/models/gem/model-a:generateContent?key=${key.text}`,
    { body: geminiRequest },
  );
  assert.equal(gemini.status, 200);
  assert.deepEqual(gemini.json(), geminiBody);
  assert.equal(up.seen[2]!.url, "/v1beta/models/model-a:generateContent");
  assert.equal(up.seen[2]!.body.toString(), geminiRequest);
  assert.equal(up.seen[2]!.headers["x-goog-api-key"], "sk-upstream-a-0001");

  const [rEntry, aEntry, gEntry] = store.entries;
  assert.deepEqual(
    [rEntry!.mode, aEntry!.mode, gEntry!.mode],
    ["passthrough", "passthrough", "passthrough"],
  );
  assert.deepEqual(rEntry!.usage, {
    input: 9,
    cacheRead: 0,
    cacheWrite: 0,
    output: 2,
    reasoning: 1,
    source: "reported",
  });
  assert.equal(rEntry!.servedModel, "gpt-x");
  assert.deepEqual(aEntry!.usage, {
    input: 7,
    cacheRead: 2,
    cacheWrite: 1,
    output: 5,
    reasoning: 0,
    source: "reported",
  });
  assert.equal(aEntry!.finishReason, "end_turn");
  assert.deepEqual(gEntry!.usage, {
    input: 7,
    cacheRead: 4,
    cacheWrite: 0,
    output: 2,
    reasoning: 3,
    source: "reported",
  });
  assert.equal(gEntry!.servedModel, "gemini-x");
  assert.equal(gEntry!.inbound.stream, false);
});

void test("Gemini streamed JSON-array passthrough forwards the array and puts the model in the path", async (t) => {
  const store = new MemoryStore();
  const array =
    '[{"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]}}]},\r\n{"candidates":[{"content":{"role":"model","parts":[{"text":"b"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}]';
  const up = await upstream(t, (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(array);
  });
  await store.putProvider(
    provider(
      "gem",
      { gemini: up.base },
      {
        auth: { apiKeyHeader: "query-key" },
        wire: { "model-a": "gemini-2.5-pro" },
      },
    ),
  );
  const key = await addKey(store, ["gem/*"]);
  const gw = await mount(t, store);
  const answer = await send(
    gw.port,
    "/v1alpha/models/gem/model-a:streamGenerateContent",
    { headers: { "x-goog-api-key": key.text }, body: { contents: [] } },
  );
  assert.equal(answer.text, array);
  assert.equal(
    up.seen[0]!.url,
    "/v1alpha/models/gemini-2.5-pro:streamGenerateContent?key=sk-upstream-a-0001",
  );
  assert.deepEqual(store.entries[0]!.usage?.output, 2);
  assert.equal(store.entries[0]!.completion, "explicit");
});

void test("every inbound protocol is translated to a Chat upstream with the wire model", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(
    provider(
      "chat",
      { chat: `${up.base}/v1` },
      { wire: { "model-a": "wire-a" }, translateOnly: true },
    ),
  );
  const key = await addKey(store, ["chat/*"]);
  const gw = await mount(t, store);
  const auth = { authorization: `Bearer ${key.text}` };

  const anthropic = await send(gw.port, "/v1/messages", {
    headers: auth,
    body: {
      model: "chat/model-a",
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(anthropic.status, 200);
  assert.equal(anthropic.json().type, "message");
  assert.equal(anthropic.json().model, "chat/model-a");
  assert.equal(at(anthropic.json(), "content", 0, "text"), "Hello world");

  const responses = await send(gw.port, "/v1/responses", {
    headers: auth,
    body: { model: "chat/model-a", input: "hi", stream: true },
  });
  assert.match(responses.text, /event: response\.completed/);
  assert.match(responses.text, /"delta":"Hello"/);

  const gemini = await send(
    gw.port,
    "/v1beta/models/chat/model-a:streamGenerateContent?alt=sse",
    {
      headers: { "x-goog-api-key": key.text },
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    },
  );
  assert.match(gemini.text, /^data: /);
  assert.match(gemini.text, /"finishReason":"STOP"/);

  const chat = await send(gw.port, "/chat/completions", {
    headers: auth,
    body: {
      model: "chat/model-a",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "x", schema: {} },
      },
      store: true,
    },
  });
  assert.equal(
    at(chat.json(), "choices", 0, "message", "content"),
    "Hello world",
  );

  for (const seen of up.seen) {
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.json().model, "wire-a");
    assert.equal(seen.json().stream, true);
    assert.deepEqual(seen.json().stream_options, { include_usage: true });
    assert.equal(seen.headers.authorization, "Bearer sk-upstream-a-0001");
  }
  // The shared gateway does not downgrade JSON Schema or drop fields without a patch.
  assert.equal(
    at(up.seen[3]!.json(), "response_format", "type"),
    "json_schema",
  );
  assert.equal(up.seen[3]!.json().store, true);
  assert.deepEqual(
    store.entries.map((entry) => [
      entry.inbound.protocol,
      entry.mode,
      entry.status,
    ]),
    [
      ["anthropic", "translated", 200],
      ["responses", "translated", 200],
      ["gemini", "translated", 200],
      ["chat", "translated", 200],
    ],
  );
  assert.deepEqual(store.entries[0]!.usage, {
    input: 60,
    cacheRead: 40,
    cacheWrite: 0,
    output: 15,
    reasoning: 5,
    source: "reported",
  });
  assert.equal(store.entries[0]!.servedModel, "served-model");
  assert.equal(store.entries[0]!.completion, "explicit");
});

void test("translation falls back to the Chat endpoint and unsupported routes fail with 400", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(
    provider(
      "both",
      { chat: `${up.base}/v1`, anthropic: up.base },
      { translateOnly: true },
    ),
  );
  await store.putProvider(provider("ant", { anthropic: up.base }));
  await store.putProvider(
    provider(
      "patched",
      { chat: `${up.base}/v1` },
      { patches: { chat: { patches: ["thinking-off-unless-asked"] } } },
    ),
  );
  const key = await addKey(store, ["both/*", "ant/*", "patched/*"]);
  const gw = await mount(t, store);
  const translated = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text },
    body: {
      model: "both/model-a",
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(translated.status, 200);
  assert.equal(up.seen[0]!.url, "/v1/chat/completions");
  assert.equal(store.entries[0]!.mode, "translated");
  const unsupported = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "ant/model-a", messages: [] },
  });
  assert.equal(unsupported.status, 400);
  assert.equal(at(unsupported.json(), "error", "code"), "unsupported_route");
  assert.match(
    String(at(unsupported.json(), "error", "message")),
    /not implemented yet/,
  );
  const patched = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "patched/model-a", messages: [] },
  });
  assert.equal(patched.status, 500);
  assert.equal(at(patched.json(), "error", "code"), "patch_unsupported");
  assert.equal(up.seen.length, 1);
});

void test("declared chat patches apply on passthrough and are recorded", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(
    provider(
      "prov",
      { chat: `${up.base}/v1` },
      {
        patches: {
          chat: {
            patches: [
              "developer-to-system",
              "max-tokens-field",
              "drop-fields",
              "include-usage",
            ],
            dropFields: ["store", "parallel_tool_calls"],
          },
        },
      },
    ),
  );
  const key = await addKey(store, ["prov/*"]);
  const gw = await mount(t, store);
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "prov/model-a",
      stream: true,
      store: true,
      max_tokens: 9,
      messages: [{ role: "developer", content: "be brief" }],
    },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(up.seen[0]!.json(), {
    model: "model-a",
    stream: true,
    max_completion_tokens: 9,
    messages: [{ role: "system", content: "be brief" }],
    stream_options: { include_usage: true },
  });
  assert.deepEqual(store.entries[0]!.patches, [
    "drop-fields:store",
    "developer-to-system",
    "max-tokens-field",
    "include-usage",
  ]);
});

void test("compressed requests are accepted and count_tokens is a local estimate", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["prov/*"]);
  const gw = await mount(t, store, { maxRequestBytes: 4096 });
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: {
      authorization: `Bearer ${key.text}`,
      "content-encoding": "gzip",
    },
    body: gzipSync(
      JSON.stringify({
        model: "prov/model-a",
        messages: [{ role: "user", content: "hi" }],
      }),
    ),
  });
  assert.equal(answer.status, 200);
  const bomb = await send(gw.port, "/v1/chat/completions", {
    headers: {
      authorization: `Bearer ${key.text}`,
      "content-encoding": "gzip",
    },
    body: gzipSync(
      JSON.stringify({ model: "prov/model-a", pad: "x".repeat(10_000) }),
    ),
  });
  assert.equal(bomb.status, 413);
  assert.equal(store.entries.at(-1)!.status, 413);
  const count = await send(gw.port, "/v1/messages/count_tokens", {
    headers: { "x-api-key": key.text },
    body: {
      model: "prov/model-a",
      messages: [{ role: "user", content: "hello there" }],
    },
  });
  assert.equal(count.status, 200);
  assert.equal(count.headers["x-hh-token-count"], "estimated");
  assert.ok(Number(count.json().input_tokens) > 0);
  assert.equal(up.seen.length, 1);
});
