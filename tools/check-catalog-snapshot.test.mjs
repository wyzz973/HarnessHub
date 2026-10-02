// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { snapshotText, trimModel } from "./catalog-snapshot.mjs";

test("a models.dev model keeps only limits, reasoning, input modalities, tool calling and prices", () => {
  assert.deepEqual(
    trimModel({
      id: "m",
      name: "Model",
      limit: { context: 128000, output: 8192, input: 120000 },
      reasoning: true,
      tool_call: false,
      structured_output: true,
      modalities: { input: ["text", "image", "hologram"], output: ["text"] },
      cost: {
        input: 0.27,
        output: 1.1,
        cache_read: 0.07,
        reasoning: 2,
        tiers: [],
      },
      release_date: "2026-01-01",
    }),
    {
      context: 128000,
      output: 8192,
      reasoning: true,
      input: ["text", "image"],
      toolCall: false,
      price: { input: 0.27, output: 1.1, cacheRead: 0.07 },
    },
  );
  // Absent or invalid values stay absent: no zero window, no free price.
  assert.deepEqual(
    trimModel({
      limit: { context: 0, output: -1 },
      cost: { input: "1" },
      modalities: { input: [] },
    }),
    {},
  );
  assert.deepEqual(trimModel(null), {});
});

test("the snapshot records the upstream digest and lists one model per line, sorted", () => {
  const bytes = Buffer.from(
    JSON.stringify({
      zeta: {
        id: "zeta",
        name: "Zeta",
        models: { b: { limit: { context: 10 } }, a: {} },
      },
      alpha: { id: "alpha", models: { m: { cost: { input: 0 } } } },
      broken: { id: "broken" },
    }),
  );
  const text = snapshotText(bytes, {
    retrievedAt: "2026-10-02T00:00:00.000Z",
    etag: 'W/"x"',
    commit: "0".repeat(40),
  });
  const document = JSON.parse(text);
  assert.deepEqual(document.meta, {
    schemaVersion: 1,
    source: "https://models.dev/api.json",
    repository: "https://github.com/anomalyco/models.dev",
    license: "MIT (models.dev.LICENSE)",
    retrievedAt: "2026-10-02T00:00:00.000Z",
    etag: 'W/"x"',
    commit: "0".repeat(40),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    providers: 2,
    models: 3,
  });
  assert.deepEqual(document.providers, {
    alpha: { name: "alpha", models: { m: { price: { input: 0 } } } },
    zeta: { name: "Zeta", models: { a: {}, b: { context: 10 } } },
  });
  const lines = text.split("\n");
  assert.ok(lines.includes('"a":{},'));
  assert.ok(lines.includes('"b":{"context":10}'));
  assert.ok(lines.indexOf('"a":{},') < lines.indexOf('"b":{"context":10}'));
  assert.throws(() =>
    snapshotText(Buffer.from("[]"), {
      retrievedAt: "",
      etag: null,
      commit: null,
    }),
  );
});
