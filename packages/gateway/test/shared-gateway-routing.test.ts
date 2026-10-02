// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import {
  addKey,
  at,
  CHAT_REPLY,
  CHAT_TEXT,
  chatChunks,
  delta,
  events,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  until,
  upstream,
  type Reply,
} from "./shared-support.js";

const FAST = { perCandidate: 1, baseBackoffMs: 1, maxBackoffMs: 2 };
const MESSAGES = [{ role: "user", content: "hi" }];
const unavailable = json(503, { error: { message: "overloaded" } });

/** Two providers on separate upstreams behind one group. */
async function pair(
  t: test.TestContext,
  first: Reply[],
  second: Reply[],
  retry: Record<string, number> = FAST,
  limits: Record<string, number> = {},
) {
  const a = await upstream(t, ...first);
  const b = await upstream(t, ...second);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-b"] }),
  );
  await store.putRouteGroup(group("g", ["a/model-a", "b/model-a"], { retry }));
  const key = await addKey(store, ["group/g", "a/*", "b/*"]);
  const gw = await mount(t, store, limits);
  const chat = (body: Record<string, unknown> = {}, model = "group/g") =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: MESSAGES, ...body },
    });
  return { a, b, store, gw, key, chat };
}

void test("503 is retried on the same candidate, then fails over to the next and succeeds", async (t) => {
  const { a, b, store, chat } = await pair(t, [unavailable], [CHAT_REPLY]);
  const answer = await chat({ stream: true });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /data: \[DONE\]/);
  assert.equal(a.seen.length, 2);
  assert.equal(b.seen.length, 1);
  assert.equal(b.seen[0]!.headers.authorization, "Bearer sk-upstream-b-0002");
  const entry = store.entries[0]!;
  assert.equal(entry.group, "g");
  assert.equal(entry.provider, "b");
  assert.equal(entry.status, 200);
  assert.deepEqual(
    entry.attempts.map((attempt) => [
      attempt.provider,
      attempt.status,
      attempt.decision,
    ]),
    [
      ["a", 503, "retry"],
      ["a", 503, "failover"],
      ["b", 200, "success"],
    ],
  );
  assert.ok(entry.attempts[0]!.backoffMs !== undefined);
  assert.equal(entry.attempts[0]!.errorClass, "upstream_unavailable");
});

void test("a request error (400) is neither retried nor failed over", async (t) => {
  const { a, b, store, chat } = await pair(
    t,
    [
      json(400, {
        error: { message: "bad temperature", code: "invalid_value" },
      }),
    ],
    [CHAT_REPLY],
  );
  const answer = await chat();
  assert.equal(answer.status, 400);
  assert.equal(answer.headers["x-hh-error-source"], "upstream");
  assert.equal(at(answer.json(), "error", "message"), "bad temperature");
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 0);
  assert.deepEqual(
    store.entries[0]!.attempts.map((attempt) => attempt.decision),
    ["stop"],
  );
  assert.equal(store.entries[0]!.errorSource, "upstream");
  assert.equal(store.entries[0]!.errorClass, "upstream_rejected");
});

void test("context overflow is not retried and 429 wording is never taken for overflow", async (t) => {
  const { a, b, chat } = await pair(
    t,
    [
      json(400, {
        error: {
          message: "This model's maximum context length is 10 tokens",
          code: "context_length_exceeded",
        },
      }),
    ],
    [CHAT_REPLY],
  );
  const answer = await chat();
  assert.equal(answer.status, 400);
  assert.equal(at(answer.json(), "error", "code"), "context_length_exceeded");
  assert.equal(a.seen.length + b.seen.length, 1);
});

void test("a Retry-After above the cap is returned to the client, not waited for", async (t) => {
  const { a, store, gw, key } = await pair(
    t,
    [json(429, { error: { message: "slow down" } }, { "retry-after": "30" })],
    [CHAT_REPLY],
  );
  const started = performance.now();
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "a/model-a", messages: MESSAGES },
  });
  assert.ok(performance.now() - started < 2_000);
  assert.equal(answer.status, 429);
  assert.equal(answer.headers["retry-after"], "30");
  assert.equal(a.seen.length, 1);
  assert.equal(store.entries[0]!.attempts[0]!.retryAfterMs, 30_000);
  assert.equal(store.entries[0]!.errorClass, "rate_limited");
  const gemini = await send(
    gw.port,
    `/v1beta/models/a/model-a:generateContent?key=${key.text}`,
    { body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
  );
  // The breaker now holds the credential until the Retry-After passed.
  assert.equal(gemini.status, 429);
  assert.equal(a.seen.length, 1);
  assert.equal(
    at(gemini.json(), "error", "details", 0, "@type"),
    "type.googleapis.com/google.rpc.RetryInfo",
  );
});

void test("a Retry-After within the cap is waited for when no other candidate exists", async (t) => {
  const { a, store, gw, key } = await pair(
    t,
    [
      json(429, { error: { message: "slow" } }, { "retry-after-ms": "40" }),
      CHAT_REPLY,
    ],
    [CHAT_REPLY],
  );
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "a/model-a", messages: MESSAGES },
  });
  assert.equal(answer.status, 200);
  assert.equal(a.seen.length, 2);
  assert.deepEqual(
    store.entries[0]!.attempts.map((attempt) => [
      attempt.decision,
      attempt.backoffMs,
    ]),
    [
      ["retry", 40],
      ["success", undefined],
    ],
  );
});

void test("nothing is retried after the first byte reached the client", async (t) => {
  const broken: Reply = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chatChunks([delta({ content: "partial" })], false));
    setTimeout(() => response.destroy(), 20);
  };
  const { a, b, store, chat } = await pair(t, [broken], [CHAT_REPLY]);
  const answer = await chat({ stream: true });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /partial/);
  assert.match(answer.text, /"error"/);
  assert.doesNotMatch(answer.text, /\[DONE\]/);
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 0);
  const entry = store.entries[0]!;
  assert.equal(entry.status, 502);
  assert.deepEqual(
    entry.attempts.map((attempt) => attempt.decision),
    ["stop"],
  );
});

void test("output is held before the first content event, so an early in-stream error still fails over", async (t) => {
  const early: Reply = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chatChunks(
        [
          delta({ role: "assistant" }),
          { error: { message: "overloaded", code: 503 } },
        ],
        false,
      ),
    );
  };
  for (const passthrough of [true, false]) {
    const { a, b, store, gw, key } = await pair(t, [early], [CHAT_REPLY]);
    // A translated path: Anthropic inbound on Chat upstreams.
    const answer = passthrough
      ? await send(gw.port, "/v1/chat/completions", {
          headers: { authorization: `Bearer ${key.text}` },
          body: { model: "group/g", messages: MESSAGES, stream: true },
        })
      : await send(gw.port, "/v1/messages", {
          headers: { "x-api-key": key.text },
          body: {
            model: "group/g",
            max_tokens: 9,
            messages: MESSAGES,
            stream: true,
          },
        });
    assert.equal(answer.status, 200);
    assert.doesNotMatch(answer.text, /overloaded/);
    assert.match(answer.text, passthrough ? /\[DONE\]/ : /message_stop/);
    assert.equal(a.seen.length, 2, "retried once on the same candidate");
    assert.equal(b.seen.length, 1);
    assert.deepEqual(
      store.entries[0]!.attempts.map((attempt) => attempt.decision),
      ["retry", "failover", "success"],
    );
  }
});

void test("a hold that sees no content within its window releases the output", async (t) => {
  const slow: Reply = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": thinking\n\n");
    setTimeout(() => response.end(CHAT_TEXT), 400);
  };
  const { a, gw, key } = await pair(t, [slow], [CHAT_REPLY], FAST, {
    holdMs: 50,
  });
  const started = performance.now();
  const response = await fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key.text}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "group/g",
      messages: MESSAGES,
      stream: true,
    }),
  });
  assert.ok(
    performance.now() - started < 350,
    "headers before the first content",
  );
  const text = await response.text();
  assert.ok(text.startsWith(": thinking\n\n"));
  assert.match(text, /Hello/);
  assert.equal(a.seen.length, 1);
});

void test("the breaker opens after three failures, skips the upstream, then lets one probe through", async (t) => {
  let healthy = false;
  const flaky: Reply = (response, seen) =>
    (healthy ? CHAT_REPLY : unavailable)(response, seen, undefined as never);
  const up = await upstream(t, flaky);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${up.base}/v1` }));
  await store.putRouteGroup(
    group("solo", ["a/model-a"], {
      retry: { perCandidate: 0, baseBackoffMs: 1 },
    }),
  );
  const key = await addKey(store, ["group/solo"]);
  const gw = await mount(t, store);
  const chat = () =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/solo", messages: MESSAGES },
    });
  for (let index = 0; index < 3; index++)
    assert.equal((await chat()).status, 503);
  assert.equal(up.seen.length, 3);
  const open = await chat();
  assert.equal(open.status, 503);
  assert.match(String(at(open.json(), "error", "message")), /cooling down/);
  assert.equal(
    up.seen.length,
    3,
    "an open breaker does not contact the upstream",
  );
  assert.equal(store.entries.at(-1)!.attempts.length, 0);
  gw.clock.now += 61_000;
  healthy = true;
  assert.equal((await chat()).status, 200, "the half-open probe succeeds");
  assert.equal((await chat()).status, 200, "and closes the breaker");
  assert.equal(up.seen.length, 5);
  healthy = false;
  for (let index = 0; index < 3; index++) await chat();
  gw.clock.now += 61_000;
  assert.equal((await chat()).status, 503, "a failed probe reopens");
  assert.equal(up.seen.length, 9);
  assert.equal((await chat()).status, 503);
  assert.equal(up.seen.length, 9, "reopened for longer than 60 s");
});

void test("an auth failure opens the credential at once and another credential takes over", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, (response, seen) =>
    seen.headers.authorization === "Bearer sk-upstream-a-0001"
      ? json(401, { error: { message: "invalid api key sk-upstream-a-0001" } })(
          response,
          seen,
          undefined as never,
        )
      : CHAT_REPLY(response, seen, undefined as never),
  );
  await store.putProvider(
    provider("a", { chat: `${up.base}/v1` }, { secrets: ["key-a", "key-c"] }),
  );
  const key = await addKey(store, ["a/*"]);
  const gw = await mount(t, store);
  const chat = () =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "a/model-a", messages: MESSAGES },
    });
  assert.equal((await chat()).status, 200);
  assert.equal((await chat()).status, 200);
  assert.deepEqual(
    up.seen.map((seen) => seen.headers.authorization),
    [
      "Bearer sk-upstream-a-0001",
      "Bearer sk-upstream-c-0003",
      "Bearer sk-upstream-c-0003",
    ],
  );
  const first = store.entries[0]!;
  assert.deepEqual(
    first.attempts.map((attempt) => [
      attempt.credentialId,
      attempt.decision,
      attempt.errorClass,
    ]),
    [
      ["cred-0", "failover", "auth_failed"],
      ["cred-1", "success", undefined],
    ],
  );
  assert.ok(
    !JSON.stringify(store.entries).includes("sk-upstream"),
    "secrets never reach the ledger",
  );
});

void test("cancellation stops further attempts and records the disconnect", async (t) => {
  const { a, b, store, gw, key } = await pair(t, [unavailable], [CHAT_REPLY], {
    perCandidate: 2,
    baseBackoffMs: 2_000,
    maxBackoffMs: 2_000,
  });
  const controller = new AbortController();
  const pending = fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key.text}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "group/g", messages: MESSAGES }),
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await until(() => a.seen.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await pending;
  await until(() => store.entries.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 0);
  const entry = store.entries[0]!;
  assert.equal(entry.status, 499);
  assert.equal(entry.errorClass, "engine_disconnected");
  assert.deepEqual(
    entry.attempts.map((attempt) => attempt.decision),
    ["retry"],
  );
});

void test("closing the handler aborts in-flight calls and waits for their ledger entries", async (t) => {
  const hanging: Reply = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chatChunks([delta({ content: "start" })], false));
  };
  const { a, store, gw, key } = await pair(t, [hanging], [hanging]);
  const response = await fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key.text}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "a/model-a",
      messages: MESSAGES,
      stream: true,
    }),
  });
  const pending = response.text().catch(() => "aborted");
  assert.equal(a.seen.length, 1);
  await gw.handler.close();
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0]!.errorClass, "client_cancelled");
  await pending;
  const late = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "a/model-a", messages: MESSAGES },
  });
  assert.equal(late.status, 503);
  assert.equal(at(late.json(), "error", "code"), "gateway_closing");
});

void test("the terminal event is written only after the ledger entry is committed", async (t) => {
  for (const passthrough of [true, false]) {
    const up = await upstream(t, CHAT_REPLY);
    const store = new MemoryStore();
    await store.putProvider(
      provider("a", { chat: `${up.base}/v1` }, { translateOnly: !passthrough }),
    );
    const key = await addKey(store, ["a/*"]);
    const gw = await mount(t, store);
    let release!: () => void;
    store.appendGate = new Promise<void>((resolve) => (release = resolve));
    const response = await fetch(`${gw.base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.text}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "a/model-a",
        messages: MESSAGES,
        stream: true,
      }),
    });
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("world")) {
      const { value, done } = await reader.read();
      assert.ok(!done, "the content arrives before the commit");
      text += new TextDecoder().decode(value);
    }
    await until(() => store.appendStarted === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.doesNotMatch(
      text,
      /\[DONE\]/,
      "no terminal event before the commit",
    );
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /data: \[DONE\]\n\n$/);
    assert.equal(store.entries.length, 1);
  }
});

void test("a failing ledger write withholds the terminal event and reports evidence_unavailable", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("pass", { chat: `${up.base}/v1` }));
  await store.putProvider(
    provider("tran", { chat: `${up.base}/v1` }, { translateOnly: true }),
  );
  const key = await addKey(store, ["pass/*", "tran/*"]);
  const gw = await mount(t, store);
  store.failAppend = true;
  for (const model of ["pass/model-a", "tran/model-a"]) {
    const streamed = await send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: MESSAGES, stream: true },
    });
    assert.equal(streamed.status, 200, model);
    assert.doesNotMatch(streamed.text, /\[DONE\]/, model);
    assert.match(streamed.text, /evidence_unavailable/, model);
    const whole = await send(gw.port, "/v1/messages", {
      headers: { "x-api-key": key.text },
      body: { model, max_tokens: 5, messages: MESSAGES },
    });
    assert.equal(whole.status, 503, model);
    assert.equal(whole.headers["x-hh-error-source"], "gateway");
    assert.doesNotMatch(whole.text, /Hello/);
  }
  assert.equal(store.entries.length, 0);
});

void test("upstream header and idle timeouts are retried and end in 504", async (t) => {
  const silent: Reply = () => undefined;
  const stalled: Reply = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": still here\n\n");
  };
  const headers = await pair(t, [silent], [silent], FAST, {
    upstreamHeaderTimeoutMs: 60,
  });
  const late = await headers.chat({ stream: true }, "a/model-a");
  assert.equal(late.status, 504);
  assert.deepEqual(
    headers.store.entries[0]!.attempts.map((attempt) => [
      attempt.decision,
      attempt.errorClass,
    ]),
    [
      ["retry", "upstream_timeout"],
      ["stop", "upstream_timeout"],
    ],
    "a header timeout is retried at most once",
  );
  const idle = await pair(t, [stalled], [stalled], FAST, { idleTimeoutMs: 60 });
  const answer = await idle.chat({ stream: true });
  assert.equal(answer.status, 504);
  assert.equal(at(answer.json(), "error", "code"), "upstream_timeout");
  assert.equal(idle.a.seen.length, 2);
  assert.equal(idle.b.seen.length, 2);
});

void test("translated streams get protocol keepalives and Gemini answers commit their headers early", async (t) => {
  const thinking: Reply = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chatChunks([delta({ content: "a" })], false));
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks < 8) {
        response.write(chatChunks([delta({ content: "" })], false));
        return;
      }
      clearInterval(timer);
      response.end(chatChunks([delta({ content: "b" }, "stop")]));
    }, 200);
    response.on("close", () => clearInterval(timer));
  };
  const up = await upstream(t, thinking);
  const store = new MemoryStore();
  await store.putProvider(
    provider("a", { chat: `${up.base}/v1` }, { translateOnly: true }),
  );
  const key = await addKey(store, ["a/*"]);
  const gw = await mount(t, store, {
    keepaliveGapMs: 1_000,
    headerCommitMs: 100,
  });
  const anthropic = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text },
    body: {
      model: "a/model-a",
      max_tokens: 9,
      messages: MESSAGES,
      stream: true,
    },
  });
  assert.equal(anthropic.status, 200);
  const pings = anthropic.text.match(/event: ping/g) ?? [];
  assert.ok(
    pings.length >= 2,
    "message_start ping plus at least one keepalive",
  );
  assert.match(anthropic.text, /message_stop/);
  const started = performance.now();
  const gemini = await fetch(
    `${gw.base}/v1beta/models/a/model-a:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key.text,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    },
  );
  assert.ok(
    performance.now() - started < 1_000,
    "headers at the commit deadline",
  );
  assert.equal(gemini.status, 200);
  const body = (await gemini.json()) as Record<string, unknown>;
  assert.equal(at(body, "candidates", 0, "content", "parts", 0, "text"), "ab");
});
