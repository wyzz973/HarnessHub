// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayKeyQuota } from "@harnesshub/core/model-plane";
import { currentQuota, decodeBundle, encodeBundle } from "../src/backup.js";

const legacy = (quota: Record<string, unknown>) =>
  quota as unknown as GatewayKeyQuota;

void test("a backup's key quota of before becomes the budgets migration 6 gives stored keys", () => {
  assert.deepEqual(
    currentQuota(
      legacy({ requestsPerMinute: 30, tokensPerDay: 500, costPerMonthUsd: 4 }),
    ),
    {
      requestsPerMinute: 30,
      budgets: [
        { period: "day", tokens: 500, cacheReads: true },
        { period: "month", costUsd: 4 },
      ],
    },
  );
  // A cap of 0 refused every call and still does: it is never dropped.
  assert.deepEqual(currentQuota(legacy({ costPerMonthUsd: 0 })), {
    budgets: [{ period: "month", costUsd: 0 }],
  });
  assert.deepEqual(currentQuota(legacy({ tokensPerDay: 0 })), {
    budgets: [{ period: "day", tokens: 0, cacheReads: true }],
  });
  assert.deepEqual(
    currentQuota(legacy({ tokensPerDay: 0, costPerMonthUsd: 0 })),
    {
      budgets: [
        { period: "day", tokens: 0, cacheReads: true },
        { period: "month", costUsd: 0 },
      ],
    },
  );
  const current: GatewayKeyQuota = {
    budgets: [{ period: "week", tokens: 7 }],
  };
  assert.equal(currentQuota(current), current);
});

void test("a backup whose client key quota is not one, before or after conversion, is invalid", () => {
  const bundle = (quota: unknown) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        app: "HarnessHub 0.1.0",
        keys: false,
        providers: [],
        groups: [],
        settings: {},
        agents: [],
        clientKeys: [
          { name: "laptop", modelAllow: ["*"], allowLan: false, quota },
        ],
      }),
    );
  for (const quota of [
    { tokensPerDay: 0, costPerMonthUsd: 0 },
    { requestsPerMinute: 5, tokensPerDay: 1000 },
    { budgets: [{ period: "week", costUsd: 0 }] },
  ]) {
    const decoded = decodeBundle(bundle(quota));
    assert.deepEqual(
      decodeBundle(encodeBundle(decoded)).clientKeys[0]?.quota,
      quota,
    );
  }
  for (const quota of [
    // A cap that is not a number would otherwise vanish and lift the limit.
    { tokensPerDay: "500" },
    { costPerMonthUsd: -1 },
    { tokensPerDay: 1.5 },
    { budgets: [{ period: "day" }] },
    { budgets: [{ period: "day", tokens: 1 }], extra: true },
    "unlimited",
  ])
    assert.throws(
      () => decodeBundle(bundle(quota)),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "BACKUP_INVALID" &&
        /invalid client key/.test(error.message),
      JSON.stringify(quota),
    );
});
