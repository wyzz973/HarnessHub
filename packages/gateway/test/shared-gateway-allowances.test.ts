// SPDX-License-Identifier: MIT
/** Allowance readings and the `smart` and `pace` strategies (Magpie's routings of those names). */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  AllowanceReading,
  CredentialId,
  ProviderConfig,
  RouteGroup,
} from "@harnesshub/core/model-plane";
import { SUBSCRIPTION_NOTICES } from "@harnesshub/core/subscriptions";
import {
  modelCandidates,
  Router,
  type Candidate,
  type StoredReading,
} from "../src/routing.js";
import {
  addKey,
  CHAT_REPLY,
  group,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A ChatGPT-plan-like subscription provider with one account, or an API-key provider. */
function candidate(id: string, subscription = true): Candidate {
  const config: ProviderConfig = {
    ...provider(id, { responses: "https://example.invalid/v1" }),
    ...(subscription
      ? {
          subscription: { backend: "siwc" as const },
          credentials: [
            {
              id: "account-1" as CredentialId,
              name: id,
              ref: {
                kind: "store",
                value: "00000000-0000-4000-8000-000000000001",
              },
              enabled: true,
              account: {
                backend: "siwc" as const,
                subject: id,
                clientId: "oaiapp",
                consent: {
                  notice: SUBSCRIPTION_NOTICES.siwc.version,
                  acceptedAt: iso(NOW),
                },
              },
            },
          ],
        }
      : {}),
  };
  return modelCandidates(config, "model-a", "responses").candidates[0]!;
}

function reading(
  usedPercent: number,
  resetsInHours?: number,
  spanHours?: number,
  window = "window",
): AllowanceReading {
  return {
    window,
    usedPercent,
    ...(resetsInHours !== undefined
      ? { resetsAt: iso(NOW + resetsInHours * HOUR) }
      : {}),
    ...(spanHours !== undefined ? { spanSeconds: spanHours * 3600 } : {}),
    observedAt: iso(NOW),
  };
}

const strategy = (name: RouteGroup["strategy"]) =>
  group("g", ["a/model-a"], { strategy: name });
const ids = (list: Candidate[]) => list.map((item) => item.provider.id);

void test("smart: fine before low before spent; among the fine the soonest renewal, longest window first", () => {
  const router = new Router(() => NOW);
  const week = { a: candidate("a"), b: candidate("b"), c: candidate("c") };
  router.report(week.a, [reading(10, 100, 168), reading(5, 3, 5, "five")]);
  router.report(week.b, [reading(50, 20, 168), reading(80, 4, 5, "five")]);
  router.report(week.c, [reading(20, 20, 168), reading(10, 1, 5, "five")]);
  const low = candidate("low");
  router.report(low, [reading(93, 2, 168)]);
  const spent = candidate("spent");
  router.report(spent, [reading(99, 1, 168)]);
  const unknown = candidate("unknown");
  router.report(unknown, [reading(10)]);
  const learning = candidate("learning");
  const key = candidate("key", false);
  const order = router.weigh(strategy("smart"), [
    spent,
    low,
    week.a,
    unknown,
    week.b,
    key,
    week.c,
    learning,
  ]);
  // learning first; b and c renew their week in the same hour, so the five
  // hours decide (c first); a later; unknown renewals after the known.
  assert.deepEqual(ids(order), [
    "learning",
    "c",
    "b",
    "a",
    "unknown",
    "key",
    "low",
    "spent",
  ]);
  // A window whose renewal passed counts as unused.
  const later = new Router(() => NOW + 2 * HOUR);
  later.report(spent, [reading(99, 1, 168)]);
  assert.equal(later.share(spent), 0);
});

void test("pace: most allowance left per hour first, in bands; keys after accounts", () => {
  const router = new Router(() => NOW);
  // (100 - used) / hours to the weekly renewal.
  const fast = candidate("fast"); // 80 left over 10 h: 8 per hour
  router.report(fast, [reading(20, 10, 168)]);
  const near = candidate("near"); // 75 left over 10 h: 7.5, within 90% of 8
  router.report(near, [reading(25, 10, 168)]);
  const slow = candidate("slow"); // 90 left over 100 h: 0.9
  router.report(slow, [reading(10, 100, 168)]);
  const noBudget = candidate("short"); // no window of a day: 50 left over a week
  router.report(noBudget, [reading(50, 2, 5)]);
  const key = candidate("key", false);
  const spent = candidate("spent");
  router.report(spent, [reading(99, 100, 168)]);
  // Tokens decide within a band: `fast` served more than `near`.
  router.record(fast, 5_000, undefined);
  router.record(near, 10, undefined);
  const order = router.weigh(strategy("pace"), [
    key,
    slow,
    spent,
    noBudget,
    fast,
    near,
  ]);
  assert.deepEqual(ids(order), [
    "near",
    "fast",
    "slow",
    "short",
    "key",
    "spent",
  ]);
  // Without readings both strategies keep the configured order.
  const plain = new Router(() => NOW);
  const listed = [candidate("x", false), candidate("y", false)];
  assert.deepEqual(ids(plain.weigh(strategy("pace"), listed)), ["x", "y"]);
  assert.deepEqual(ids(plain.weigh(strategy("smart"), listed)), ["x", "y"]);
});

void test("readings come from rate-limit headers, persist through the handler and come back at start", async (t) => {
  const limited = (
    response: Parameters<typeof CHAT_REPLY>[0],
    seen: Parameters<typeof CHAT_REPLY>[1],
  ) => {
    response.setHeader("x-ratelimit-limit-requests", "100");
    response.setHeader("x-ratelimit-remaining-requests", "40");
    response.setHeader("x-ratelimit-reset-requests", "30s");
    return CHAT_REPLY(response, seen, undefined as never);
  };
  const a = await upstream(t, limited);
  const b = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-b"] }),
  );
  await store.putRouteGroup(
    group("g", ["a/model-a", "b/model-a"], { strategy: "smart" }),
  );
  const key = await addKey(store, ["group/g"]);
  const saved: StoredReading[][] = [];
  const restored: StoredReading = {
    provider: "b",
    credential: "cred-0",
    reading: {
      window: "requests",
      usedPercent: 95,
      resetsAt: iso(NOW + HOUR),
      observedAt: iso(NOW - 60_000),
    },
  };
  const gw = await mount(
    t,
    store,
    {},
    {
      allowances: {
        load: async () => [restored],
        save: async (readings) => void saved.push(readings),
      },
    },
  );
  const call = () =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/g", messages: [{ role: "user", content: "hi" }] },
    });
  // b's restored reading (95% used) puts it behind a.
  assert.equal((await call()).status, 200);
  assert.equal(store.entries[0]!.provider, "a");
  assert.equal(a.seen.length, 1);
  await gw.handler.close();
  const last = saved.at(-1)!;
  assert.deepEqual(
    last.map((item) => [
      item.provider,
      item.reading.window,
      Math.round(item.reading.usedPercent),
    ]),
    [
      ["b", "requests", 95],
      ["a", "requests", 60],
    ],
  );
});
