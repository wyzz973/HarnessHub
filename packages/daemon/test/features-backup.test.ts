// SPDX-License-Identifier: MIT
/** The gateway features as backups carry them: what a bundle may hold, and how sync compares and fills them. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyFeatures,
  featuresView,
  isBackupGatewayFeatures,
  withFeaturesValues,
  type BackupGatewayFeatures,
} from "../src/features-backup.js";

const valid: BackupGatewayFeatures = {
  updatedAt: "2026-10-05T08:00:00.000Z",
  redaction: {
    enabled: false,
    rules: [{ name: "TICKET", pattern: "TCK-[0-9]+" }],
  },
  vision: { model: "seer/eyes" },
  search: [
    { id: "search-1", kind: "tavily", key: { source: "store", value: "k" } },
    { id: "search-2", kind: "searxng", baseUrl: "https://search.example.test" },
    {
      id: "search-3",
      kind: "brave",
      key: { source: "reference", kind: "env", name: "BRAVE_KEY" },
    },
  ],
  alerts: { usagePercent: 80 },
};

void test("a bundle's gateway features are checked as the settings are, keys as provider secrets", () => {
  assert.ok(isBackupGatewayFeatures(valid));
  assert.ok(
    isBackupGatewayFeatures({
      redaction: { enabled: true, rules: [] },
      search: [],
    }),
  );
  const broken = (change: (copy: Record<string, unknown>) => void) => {
    const copy = structuredClone(valid) as unknown as Record<string, unknown>;
    change(copy);
    return copy;
  };
  const search = (copy: Record<string, unknown>) =>
    copy.search as Record<string, unknown>[];
  for (const [why, value] of [
    ["not an object", []],
    ["no redaction", broken((copy) => delete copy.redaction)],
    [
      "a switch that is not a boolean",
      broken(
        (copy) => ((copy.redaction as Record<string, unknown>).enabled = "no"),
      ),
    ],
    [
      "an invalid rule",
      broken(
        (copy) =>
          ((copy.redaction as { rules: unknown[] }).rules = [
            { name: "1x", pattern: "a" },
          ]),
      ),
    ],
    [
      "a rule matching nothing",
      broken(
        (copy) =>
          ((copy.redaction as { rules: unknown[] }).rules = [
            { name: "E", pattern: "a*" },
          ]),
      ),
    ],
    [
      "two rules of one name",
      broken(
        (copy) =>
          ((copy.redaction as { rules: unknown[] }).rules = [
            { name: "A", pattern: "x" },
            { name: "a", pattern: "y" },
          ]),
      ),
    ],
    [
      "a vision model that is no Model Ref",
      broken((copy) => (copy.vision = { model: "eyes" })),
    ],
    [
      "a time that is not one",
      broken((copy) => (copy.updatedAt = "yesterday")),
    ],
    ["an unknown member", broken((copy) => (copy.extra = true))],
    ["no search list", broken((copy) => delete copy.search)],
    [
      "a key-holding kind without a key",
      broken((copy) => delete search(copy)[0]!.key),
    ],
    [
      "SearXNG without its address",
      broken((copy) => delete search(copy)[1]!.baseUrl),
    ],
    ["an unknown kind", broken((copy) => (search(copy)[0]!.kind = "bing"))],
    [
      "a key that is no secret",
      broken((copy) => (search(copy)[0]!.key = "plain")),
    ],
    [
      "a keychain-less kind of reference",
      broken(
        (copy) =>
          (search(copy)[2]!.key = {
            source: "reference",
            kind: "store",
            name: "x",
          }),
      ),
    ],
    [
      "an empty stored value",
      broken((copy) => (search(copy)[0]!.key = { source: "store", value: "" })),
    ],
    ["an id used twice", broken((copy) => (search(copy)[1]!.id = "search-1"))],
    [
      "a usage alert past 100%",
      broken((copy) => (copy.alerts = { usagePercent: 101 })),
    ],
    [
      "a usage alert with another member",
      broken((copy) => (copy.alerts = { usagePercent: 80, balance: 5 })),
    ],
    [
      "a backend member that is not one",
      broken(
        (copy) => (search(copy)[0]!.credential = { kind: "store", value: "x" }),
      ),
    ],
  ] as const)
    assert.equal(isBackupGatewayFeatures(value), false, why);
});

void test("sync compares the features without their time, and a side without key values keeps the other's", () => {
  assert.deepEqual(
    featuresView({ ...valid, updatedAt: "2026-10-06T00:00:00.000Z" }),
    featuresView(valid),
  );
  assert.ok(emptyFeatures(undefined));
  assert.ok(
    emptyFeatures({ redaction: { enabled: true, rules: [] }, search: [] }),
  );
  assert.ok(
    !emptyFeatures({ redaction: { enabled: false, rules: [] }, search: [] }),
  );
  const withoutValues: BackupGatewayFeatures = {
    ...valid,
    search: [
      { id: "search-1", kind: "tavily", key: { source: "store" } },
      { id: "search-9", kind: "brave", key: { source: "store" } },
    ],
  };
  const filled = withFeaturesValues(withoutValues, {
    redaction: { enabled: true, rules: [] },
    search: [
      {
        id: "search-1",
        kind: "tavily",
        key: { source: "store", value: "tavily-value" },
      },
      // Matched by kind and address when the ids differ.
      {
        id: "search-4",
        kind: "brave",
        key: { source: "store", value: "brave-value" },
      },
    ],
  });
  assert.deepEqual(
    filled.search.map((item) => item.key),
    [
      { source: "store", value: "tavily-value" },
      { source: "store", value: "brave-value" },
    ],
  );
  assert.deepEqual(withFeaturesValues(withoutValues, undefined), withoutValues);
});
