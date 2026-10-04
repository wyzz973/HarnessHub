// SPDX-License-Identifier: MIT
/** Gateway Key budgets: calendar windows in a local time zone, reservations in flight, refusals and status. */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  GatewayKeyId,
  GatewayKeyQuota,
  ModelCallEntry,
  ModelCallId,
} from "@harnesshub/core/model-plane";
import { budgetWindow } from "../src/quota.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  MemoryStore,
  mount,
  provider,
  send,
  until,
  upstream,
  type Reply,
} from "./shared-support.js";

const iso = (at: number) => new Date(at).toISOString();

void test("budget windows: a day from local midnight, a week from Monday, a month from the 1st, across offset changes", () => {
  const window = (
    period: "day" | "week" | "month",
    at: string,
    zone: string,
  ) => {
    const found = budgetWindow(period, Date.parse(at), zone);
    return [iso(found.start), iso(found.reset)];
  };
  // Friday 2 October 2026, 08:00 in New York (EDT, UTC-4).
  assert.deepEqual(window("day", "2026-10-02T12:00:00Z", "America/New_York"), [
    "2026-10-02T04:00:00.000Z",
    "2026-10-03T04:00:00.000Z",
  ]);
  assert.deepEqual(window("week", "2026-10-02T12:00:00Z", "America/New_York"), [
    "2026-09-28T04:00:00.000Z",
    "2026-10-05T04:00:00.000Z",
  ]);
  // October to November crosses the end of daylight time (1 November).
  assert.deepEqual(
    window("month", "2026-10-02T12:00:00Z", "America/New_York"),
    ["2026-10-01T04:00:00.000Z", "2026-11-01T04:00:00.000Z"],
  );
  assert.deepEqual(window("day", "2026-11-01T12:00:00Z", "America/New_York"), [
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T05:00:00.000Z",
  ]);
  // 8 March 2026: daylight time starts, a day of 23 hours.
  assert.deepEqual(window("day", "2026-03-08T18:00:00Z", "America/New_York"), [
    "2026-03-08T05:00:00.000Z",
    "2026-03-09T04:00:00.000Z",
  ]);
  // In Shanghai (UTC+8) 31 October 17:00 UTC is already 1 November.
  assert.deepEqual(window("month", "2026-10-31T17:00:00Z", "Asia/Shanghai"), [
    "2026-10-31T16:00:00.000Z",
    "2026-11-30T16:00:00.000Z",
  ]);
  // A Sunday's week began the Monday before; a Monday's begins that day.
  assert.deepEqual(window("week", "2026-10-04T12:00:00Z", "UTC"), [
    "2026-09-28T00:00:00.000Z",
    "2026-10-05T00:00:00.000Z",
  ]);
  assert.deepEqual(window("week", "2026-10-05T00:00:00Z", "UTC"), [
    "2026-10-05T00:00:00.000Z",
    "2026-10-12T00:00:00.000Z",
  ]);
});

/** A provider whose first call waits for `release`; the rest answer at once. */
async function held(t: test.TestContext, quota: GatewayKeyQuota) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const reply: Reply = async (response, seen, request) => {
    if (first) {
      first = false;
      await gate;
    }
    await CHAT_REPLY(response, seen, request);
  };
  const up = await upstream(t, reply);
  const store = new MemoryStore();
  await store.putProvider(provider("p", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["p/*"], { quota });
  const gw = await mount(t, store, {}, { timeZone: "UTC" });
  const chat = (content = "hi") =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "p/model-a", messages: [{ role: "user", content }] },
    });
  return { up, store, gw, key, chat, release: () => release() };
}

void test("a request in flight holds its reservation: a second one is refused until it ends", async (t) => {
  const { up, store, gw, key, chat, release } = await held(t, {
    budgets: [{ period: "day", tokens: 150 }],
  });
  // About 660 bytes: a reservation of about 165 tokens.
  const first = chat("x".repeat(600));
  await until(() => up.seen.length === 1);
  const during = await gw.handler.keyLimit(key.keyId);
  assert.equal(during?.timeZone, "UTC");
  const day = during!.budgets[0]!;
  assert.equal(day.inFlight, 1);
  assert.ok(day.reservedTokens >= 150, String(day.reservedTokens));
  assert.equal(day.tokens, 0);
  assert.equal(day.spent, false);
  assert.equal(day.resetsAt, "2026-10-03T00:00:00.000Z");
  const refused = await chat();
  assert.equal(refused.status, 429);
  assert.match(
    String(at(refused.json(), "error", "message")),
    /used 0 of its 150 input, output and cache-write tokens today, with 1 requests in flight holding the rest; it resets at 2026-10-03T00:00:00\.000Z/,
  );
  assert.equal(refused.headers["retry-after"], String(12 * 3600));
  assert.equal(refused.headers["x-should-retry"], "false");
  assert.equal(refused.headers["x-hh-limit-reset"], "2026-10-03T00:00:00.000Z");
  assert.equal(up.seen.length, 1, "the refused request reached no upstream");
  release();
  assert.equal((await first).status, 200);
  await until(
    () => store.entries.filter((entry) => entry.status === 200).length === 1,
  );
  // 100 input and 20 output tokens used, the reservation given back.
  const after = await gw.handler.keyLimit(key.keyId);
  assert.deepEqual(
    [
      after!.budgets[0]!.tokens,
      after!.budgets[0]!.tokensLeft,
      after!.budgets[0]!.inFlight,
      after!.budgets[0]!.reservedTokens,
      after!.budgets[0]!.calls,
    ],
    [120, 30, 0, 0, 1],
  );
  assert.equal((await chat()).status, 200, "120 + the next reservation < 150");
  const rejection = store.entries.find((entry) => entry.status === 429)!;
  assert.equal(rejection.rejected, true);
  assert.equal(rejection.rejectReason, "quota_exceeded");
});

void test("a cost cap reserves at the model's input price before any priced call", async (t) => {
  // model-a costs 1 USD per million input tokens: ~150 tokens hold ~0.00015 USD.
  const { up, chat, release } = await held(t, {
    budgets: [{ period: "month", costUsd: 0.0001 }],
  });
  const first = chat("x".repeat(600));
  await until(() => up.seen.length === 1);
  const refused = await chat();
  assert.equal(refused.status, 429);
  assert.match(
    String(at(refused.json(), "error", "message")),
    /used \$0 of its \$0\.0001 estimated cost this month, with 1 requests in flight/,
  );
  release();
  assert.equal((await first).status, 200);
});

void test("cache reads count only for a budget that says so", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(provider("p", { chat: `${up.base}/v1` }));
  const entry = (keyId: string): ModelCallEntry => ({
    callId: `mc_${keyId}` as ModelCallId,
    occurredAt: "2026-10-02T01:00:00.000Z",
    keyId: keyId as GatewayKeyId,
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: false },
    patches: [],
    unmapped: [],
    status: 200,
    timing: { durationMs: 1 },
    attempts: [],
    cost: null,
    usage: {
      input: 10,
      cacheRead: 5_000,
      cacheWrite: 0,
      output: 10,
      reasoning: 0,
      source: "reported",
    },
  });
  const plain = await addKey(store, ["p/*"], {
    quota: { budgets: [{ period: "day", tokens: 1_000 }] },
  });
  const cached = await addKey(store, ["p/*"], {
    quota: { budgets: [{ period: "day", tokens: 1_000, cacheReads: true }] },
  });
  store.entries.push(entry(plain.keyId), entry(cached.keyId));
  const gw = await mount(t, store, {}, { timeZone: "UTC" });
  const chat = (text: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${text}` },
      body: { model: "p/model-a", messages: [{ role: "user", content: "hi" }] },
    });
  assert.equal((await chat(plain.text)).status, 200);
  const refused = await chat(cached.text);
  assert.equal(refused.status, 429);
  assert.match(
    String(at(refused.json(), "error", "message")),
    /used 5020 of its 1000 input, output and cache tokens today/,
  );
  const status = await gw.handler.keyLimit(cached.keyId);
  assert.deepEqual(
    [status!.budgets[0]!.tokens, status!.budgets[0]!.spent],
    [5_020, true],
  );
  assert.equal(await gw.handler.keyLimit("zzzzzzzzzzzz" as never), undefined);
});

void test("a cap of 0 refuses every call of its window, with the window's reset", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(provider("p", { chat: `${up.base}/v1` }));
  const tokens = await addKey(store, ["p/*"], {
    quota: { budgets: [{ period: "day", tokens: 0, cacheReads: true }] },
  });
  const cost = await addKey(store, ["p/*"], {
    quota: { budgets: [{ period: "month", costUsd: 0 }] },
  });
  const both = await addKey(store, ["p/*"], {
    quota: {
      requestsPerMinute: 5,
      budgets: [
        { period: "day", tokens: 0, cacheReads: true },
        { period: "month", costUsd: 0 },
      ],
    },
  });
  const gw = await mount(t, store, {}, { timeZone: "UTC" });
  const chat = (text: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${text}` },
      body: { model: "p/model-a", messages: [{ role: "user", content: "hi" }] },
    });
  for (const [key, reset, message] of [
    [
      tokens,
      "2026-10-03T00:00:00.000Z",
      /has a day budget of 0 tokens, so every call is refused/,
    ],
    [
      cost,
      "2026-11-01T00:00:00.000Z",
      /has a month budget of \$0, so every call is refused/,
    ],
    [
      both,
      "2026-10-03T00:00:00.000Z",
      /has a day budget of 0 tokens, so every call is refused/,
    ],
  ] as const) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await chat(key.text);
      assert.equal(refused.status, 429);
      assert.match(String(at(refused.json(), "error", "message")), message);
      assert.equal(refused.headers["x-should-retry"], "false");
      assert.equal(refused.headers["x-hh-limit-reset"], reset);
      assert.equal(
        refused.headers["retry-after"],
        String(
          (Date.parse(reset) - Date.parse("2026-10-02T12:00:00.000Z")) / 1000,
        ),
      );
    }
    const status = await gw.handler.keyLimit(key.keyId);
    assert.ok(
      status!.budgets.every((budget) => budget.spent),
      JSON.stringify(status),
    );
  }
  assert.equal(up.seen.length, 0, "no refused call reached the upstream");
});
