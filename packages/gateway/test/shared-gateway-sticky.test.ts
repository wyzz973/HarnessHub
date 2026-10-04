// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import type {
  GatewayKeyQuota,
  ModelCallEntry,
  ModelCallId,
  Stickiness,
} from "@harnesshub/core/model-plane";
import { modelCandidates, type Candidate } from "../src/routing.js";
import {
  CACHE_COLD_MS,
  conversationOf,
  STICKY_ENTRIES,
  STICKY_TTL_MS,
  StickyRoutes,
  type Conversation,
} from "../src/sticky.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Reply,
} from "./shared-support.js";

const KEY = "aaaaaaaaaaaa";

void test("conversation keys: header first, then the client's id, then the opening; scoped per Gateway Key", () => {
  const chat = (system: string, user: string, extra = {}) => ({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
      { role: "assistant", content: "later turns do not matter" },
    ],
    ...extra,
  });
  const key = (
    protocol: Parameters<typeof conversationOf>[0],
    raw: Record<string, unknown>,
    headers = {},
    keyId = KEY,
  ) => conversationOf(protocol, raw, headers, keyId);
  const base = key("chat", chat("s", "u"));
  assert.equal(base.source, "hash");
  assert.equal(
    key("chat", {
      ...chat("s", "u"),
      messages: [...chat("s", "u").messages, { role: "user", content: "more" }],
    }).key,
    base.key,
  );
  assert.notEqual(key("chat", chat("other system", "u")).key, base.key);
  assert.notEqual(key("chat", chat("s", "other first message")).key, base.key);
  assert.notEqual(
    key("chat", chat("s", "u"), {}, "bbbbbbbbbbbb").key,
    base.key,
    "scoped per key",
  );
  const header = key("chat", chat("s", "u"), { "x-hh-conversation": "conv-1" });
  assert.equal(header.source, "header");
  assert.equal(
    key("anthropic", { messages: [] }, { "x-hh-conversation": "conv-1" }).key,
    header.key,
  );
  assert.equal(
    key("chat", chat("s", "u", { prompt_cache_key: "pc-1" })).source,
    "client",
  );
  assert.equal(
    key("responses", { input: "a", prompt_cache_key: "pc-1" }).key,
    key("chat", chat("x", "y", { prompt_cache_key: "pc-1" })).key,
  );
  const claude = (session: string) => ({
    system: "s",
    metadata: { user_id: `user_ab12_account_5f0e_session_${session}` },
    messages: [{ role: "user", content: "u" }],
  });
  assert.equal(key("anthropic", claude("9c1d-77")).source, "client");
  assert.equal(
    key("anthropic", claude("9c1d-77")).key,
    key("anthropic", { ...claude("9c1d-77"), system: "changed" }).key,
  );
  assert.notEqual(
    key("anthropic", claude("9c1d-77")).key,
    key("anthropic", claude("0000-11")).key,
  );
  assert.equal(
    key("anthropic", {
      system: "s",
      metadata: { user_id: "plain" },
      messages: [{ role: "user", content: "u" }],
    }).source,
    "hash",
  );
  const gemini = key("gemini", {
    systemInstruction: { parts: [{ text: "s" }] },
    contents: [{ parts: [{ text: "u" }] }],
  });
  assert.equal(gemini.source, "hash");
  assert.equal(
    key("responses", {
      instructions: "s",
      input: [
        { role: "user", content: "u" },
        { type: "function_call_output", call_id: "c", output: "o" },
      ],
    }).key,
    key("responses", {
      instructions: "s",
      input: [{ type: "message", role: "user", content: "u" }],
    }).key,
  );
});

void test("a request returning tool results is inside a turn, in every protocol", () => {
  const inside = (
    protocol: Parameters<typeof conversationOf>[0],
    raw: Record<string, unknown>,
  ) => conversationOf(protocol, raw, {}, KEY).withinTurn;
  assert.equal(
    inside("chat", {
      messages: [
        { role: "user", content: "u" },
        { role: "tool", tool_call_id: "c", content: "r" },
      ],
    }),
    true,
  );
  assert.equal(
    inside("chat", {
      messages: [
        { role: "tool", tool_call_id: "c", content: "r" },
        { role: "user", content: "next" },
      ],
    }),
    false,
  );
  assert.equal(
    inside("responses", {
      input: [{ type: "function_call_output", call_id: "c", output: "r" }],
    }),
    true,
  );
  assert.equal(inside("responses", { input: "u" }), false);
  assert.equal(
    inside("anthropic", {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "r" }],
        },
      ],
    }),
    true,
  );
  assert.equal(
    inside("anthropic", { messages: [{ role: "user", content: "u" }] }),
    false,
  );
  assert.equal(
    inside("gemini", {
      contents: [
        {
          role: "user",
          parts: [{ functionResponse: { name: "f", response: {} } }],
        },
      ],
    }),
    true,
  );
  assert.equal(
    inside("gemini", { contents: [{ role: "user", parts: [{ text: "u" }] }] }),
    false,
  );
});

function candidates(): Candidate[] {
  const one = provider("a", { chat: "http://127.0.0.1:9/v1" });
  const two = provider("b", { chat: "http://127.0.0.1:9/v1" });
  return [
    ...modelCandidates(one, "model-a", "chat").candidates,
    ...modelCandidates(two, "model-a", "chat").candidates,
  ];
}
const conversation = (withinTurn: boolean): Conversation => ({
  key: "conv",
  source: "hash",
  withinTurn,
});

void test("each stickiness mode, the cache-worth rule and broken stickiness", () => {
  const clock = { now: 1_000_000 };
  const routes = new StickyRoutes(() => clock.now);
  const [a, b] = candidates();
  const never = (_candidate: Candidate) => false;
  const decide = (mode: Stickiness, withinTurn: boolean, blocked = never) => {
    const result = routes.apply(
      conversation(withinTurn),
      "group/g",
      mode,
      [a!, b!],
      blocked,
    );
    return [result.candidates[0]!.provider.id, result.patch];
  };
  assert.deepEqual(decide("auto", false), ["a", "sticky:miss:new"]);
  routes.remember(conversation(false), "group/g", b!, 0);
  // auto: inside a turn always; across turns only on a warm cache.
  assert.deepEqual(decide("auto", true), ["b", "sticky:hit"]);
  assert.deepEqual(decide("auto", false), ["a", "sticky:miss:cache_cold"]);
  routes.remember(conversation(false), "group/g", b!, 1023);
  assert.deepEqual(decide("auto", false), ["a", "sticky:miss:cache_cold"]);
  routes.remember(conversation(false), "group/g", b!, 1024);
  assert.deepEqual(decide("auto", false), ["b", "sticky:hit"]);
  clock.now += CACHE_COLD_MS - 1;
  assert.deepEqual(decide("auto", false), ["b", "sticky:hit"]);
  clock.now += 1;
  assert.deepEqual(decide("auto", false), ["a", "sticky:miss:cache_cold"]);
  // session: always; turn: inside a turn only; off: never, and no record.
  assert.deepEqual(decide("session", false), ["b", "sticky:hit"]);
  assert.deepEqual(decide("turn", true), ["b", "sticky:hit"]);
  assert.deepEqual(decide("turn", false), ["a", "sticky:miss:new_turn"]);
  assert.deepEqual(decide("off", true), ["a", undefined]);
  // Broken: the remembered credential's breaker is open, or it is gone.
  assert.deepEqual(
    decide("session", true, (candidate) => candidate === b),
    ["a", "sticky:broken:breaker"],
  );
  assert.deepEqual(
    routes.apply(
      conversation(true),
      "group/g",
      "session",
      [a!, candidates()[0]!],
      never,
    ).patch,
    "sticky:broken:unavailable",
  );
  assert.equal(
    routes.apply(conversation(true), "group/other", "session", [a!, b!], never)
      .patch,
    "sticky:miss:model_changed",
  );
  assert.equal(
    routes.apply(conversation(true), "group/g", "session", [b!], never).patch,
    undefined,
    "no choice, no record",
  );
  clock.now += STICKY_TTL_MS + 1;
  assert.deepEqual(decide("session", true), ["a", "sticky:miss:new"]);
  // At most STICKY_ENTRIES conversations: the oldest is forgotten.
  for (let index = 0; index <= STICKY_ENTRIES; index++)
    routes.remember(
      { key: `c${index}`, source: "hash", withinTurn: false },
      "group/g",
      b!,
      0,
    );
  assert.equal(
    routes.apply(
      { key: "c0", source: "hash", withinTurn: true },
      "group/g",
      "auto",
      [a!, b!],
      never,
    ).patch,
    "sticky:miss:new",
  );
  assert.equal(
    routes.apply(
      { key: "c1", source: "hash", withinTurn: true },
      "group/g",
      "auto",
      [a!, b!],
      never,
    ).patch,
    "sticky:hit",
  );
});

/** A Chat reply that read 2000 cached prompt tokens. */
const WARM: Reply = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      model: "served",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 3000,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 2000 },
      },
    }),
  );
};

async function rotating(
  t: test.TestContext,
  a: Reply[],
  b: Reply[],
  stickiness: Stickiness = "auto",
) {
  const upA = await upstream(t, ...a);
  const upB = await upstream(t, ...b);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${upA.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${upB.base}/v1` }, { secrets: ["key-b"] }),
  );
  await store.putRouteGroup(
    group("g", ["a/model-a", "b/model-a"], {
      strategy: "rotate",
      stickiness,
      retry: { perCandidate: 0, baseBackoffMs: 1 },
    }),
  );
  const key = await addKey(store, ["group/g", "a/*"]);
  const gw = await mount(t, store);
  return { upA, upB, store, gw, key };
}
const START = { role: "user", content: "start" };
const TOOL_TURN = [
  START,
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: "result" },
];
const NEXT_TURN = [
  ...TOOL_TURN,
  { role: "assistant", content: "done" },
  { role: "user", content: "next" },
];

void test("auto stickiness keeps a turn and a warm cache on one credential, despite rotation", async (t) => {
  const { upA, upB, store, gw, key } = await rotating(t, [CHAT_REPLY], [WARM]);
  const chat = (messages: unknown[]) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/g", messages },
    });
  await chat([START]); // rotation [a, b]
  await chat(TOOL_TURN); // rotation [b, a], the turn stays on a
  await chat(NEXT_TURN); // rotation [a, b], a's cache is cold
  await chat(NEXT_TURN); // rotation [b, a], b reads 2000 cached tokens
  await chat(NEXT_TURN); // rotation [a, b], b's cache is warm
  assert.deepEqual(
    store.entries.map((entry) => [entry.provider, entry.patches]),
    [
      ["a", ["sticky:miss:new"]],
      ["a", ["sticky:hit"]],
      ["a", ["sticky:miss:cache_cold"]],
      ["b", ["sticky:miss:cache_cold"]],
      ["b", ["sticky:hit"]],
    ],
  );
  assert.equal(upA.seen.length, 3);
  assert.equal(upB.seen.length, 2);
});

void test("stickiness is broken, and recorded, when the remembered credential's breaker is open", async (t) => {
  const denied = json(401, { error: { message: "bad key" } });
  const { upA, upB, store, gw, key } = await rotating(
    t,
    [CHAT_REPLY, denied],
    [CHAT_REPLY],
  );
  const chat = (model: string, messages: unknown[]) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages },
    });
  await chat("group/g", [START]); // served by a
  assert.equal(
    (await chat("a/model-a", [{ role: "user", content: "other" }])).status,
    401,
  ); // opens a's breaker
  const broken = await chat("group/g", TOOL_TURN);
  assert.equal(broken.status, 200);
  assert.equal(upA.seen.length, 2, "the open breaker is not contacted");
  assert.equal(upB.seen.length, 1);
  assert.deepEqual(store.entries.at(-1)!.patches, ["sticky:broken:breaker"]);
  assert.equal(store.entries.at(-1)!.provider, "b");
});

void test("session stickiness stays across cold turns; off records nothing", async (t) => {
  for (const [mode, providers] of [
    ["session", ["a", "a", "a"]],
    ["off", ["a", "b", "a"]],
  ] as const) {
    const { store, gw, key } = await rotating(
      t,
      [CHAT_REPLY],
      [CHAT_REPLY],
      mode,
    );
    for (const messages of [[START], NEXT_TURN, NEXT_TURN])
      await send(gw.port, "/v1/chat/completions", {
        headers: { authorization: `Bearer ${key.text}` },
        body: { model: "group/g", messages },
      });
    assert.deepEqual(
      store.entries.map((entry) => entry.provider),
      providers,
      mode,
    );
    if (mode === "off")
      assert.ok(store.entries.every((entry) => entry.patches.length === 0));
  }
});

/** Budget windows in New York, four hours behind UTC in October (EDT). */
const ZONE = "America/New_York";

async function quota(t: test.TestContext, limits: GatewayKeyQuota) {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("p", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["p/*"], { quota: limits });
  const gw = await mount(t, store, {}, { timeZone: ZONE });
  const chat = () =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "p/model-a", messages: [{ role: "user", content: "hi" }] },
    });
  return { up, store, gw, key, chat };
}

void test("requestsPerMinute is a hard token bucket with Retry-After to the next free request", async (t) => {
  const { up, store, gw, chat } = await quota(t, { requestsPerMinute: 2 });
  assert.equal((await chat()).status, 200);
  assert.equal((await chat()).status, 200);
  const refused = await chat();
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "30");
  assert.equal(refused.headers["x-hh-error-source"], "gateway");
  assert.equal(at(refused.json(), "error", "code"), "quota_exceeded");
  assert.equal(up.seen.length, 2);
  const row = store.entries.at(-1)!;
  assert.equal(row.rejected, true);
  assert.equal(row.rejectReason, "quota_exceeded");
  assert.equal(row.status, 429);
  gw.clock.now += 30_000;
  assert.equal((await chat()).status, 200);
  assert.equal((await chat()).status, 429);
});

void test("a day budget counts committed usage: the crossing call finishes, the next one is refused until local midnight", async (t) => {
  const { up, store, gw, chat, key } = await quota(t, {
    budgets: [{ period: "day", tokens: 300 }],
  });
  // Now is 08:00 on 2 October in New York. Earlier ledger rows: 100 tokens
  // today, and a large call at 23:59:59 the day before that does not count.
  const earlier = (occurredAt: string, input: number): ModelCallEntry => ({
    callId: `mc_${occurredAt}` as ModelCallId,
    occurredAt,
    keyId: key.keyId,
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: false },
    patches: [],
    unmapped: [],
    status: 200,
    timing: { durationMs: 1 },
    attempts: [],
    cost: null,
    usage: {
      input,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      source: "reported",
    },
  });
  store.entries.push(
    earlier("2026-10-02T03:59:59.000Z", 10_000),
    earlier("2026-10-02T05:00:00.000Z", 100),
  );
  assert.equal((await chat()).status, 200); // 100 used before: 220 after
  assert.equal((await chat()).status, 200); // 220 < 300: crosses to 340
  const refused = await chat();
  assert.equal(refused.status, 429);
  assert.equal(
    refused.headers["retry-after"],
    String(16 * 3600),
    "until 00:00 in New York, 04:00 UTC",
  );
  assert.equal(refused.headers["x-should-retry"], "false");
  assert.equal(refused.headers["x-hh-limit-reset"], "2026-10-03T04:00:00.000Z");
  assert.match(
    String(at(refused.json(), "error", "message")),
    /used 340 of its 300 input, output and cache-write tokens today; it resets at 2026-10-03T04:00:00\.000Z/,
  );
  assert.equal(up.seen.length, 2);
  assert.equal(
    store.aggregations,
    1,
    "one ledger read per window, then committed calls are added",
  );
  gw.clock.now += 16 * 3_600_000;
  assert.equal((await chat()).status, 200, "a new day in New York");
});

void test("a month budget counts committed costs until the next local month", async (t) => {
  // Each call costs 100 × 1 + 20 × 2 USD per million tokens.
  const { up, gw, chat, key } = await quota(t, {
    budgets: [{ period: "month", costUsd: 0.0002 }],
  });
  assert.equal((await chat()).status, 200);
  assert.equal((await chat()).status, 200);
  const refused = await chat();
  assert.equal(refused.status, 429);
  // 1 November 00:00 in New York, still EDT.
  const reset = Date.parse("2026-11-01T04:00:00.000Z") - gw.clock.now;
  assert.equal(refused.headers["retry-after"], String(reset / 1000));
  assert.equal(up.seen.length, 2);
  const gemini = await send(
    gw.port,
    `/v1beta/models/p/model-a:generateContent?key=${key.text}`,
    {
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    },
  );
  assert.equal(gemini.status, 429);
  assert.equal(
    at(gemini.json(), "error", "details", 0, "retryDelay"),
    `${reset / 1000}s`,
  );
});
