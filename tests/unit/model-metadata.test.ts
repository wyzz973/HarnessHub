// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  applyModelMetadata,
  resolveModelMetadata,
  type MetadataSources,
  type ModelOverride,
} from "@harnesshub/core/model-metadata";
import type {
  ProviderConfig,
  ProviderId,
  ProviderModel,
} from "@harnesshub/core/model-plane";
import type { ProviderPreset } from "@harnesshub/core/provider-presets";
import {
  modelCatalog,
  parseCatalog,
  snapshotText,
  trimModel,
} from "@harnesshub/gateway/catalog";
import { listPresets } from "@harnesshub/gateway/presets";

const AT = "2026-10-02T08:00:00.000Z";
const LATER = "2026-10-03T08:00:00.000Z";

const meta = {
  schemaVersion: 1,
  source: "https://models.dev/api.json",
  repository: "https://github.com/anomalyco/models.dev",
  license: "MIT (models.dev.LICENSE)",
  retrievedAt: "2026-10-01T00:00:00.000Z",
  etag: null,
  commit: "0".repeat(40),
  sha256: "a".repeat(64),
  bytes: 1000,
};

/** A synthetic snapshot: the preset's catalog provider and two authors. */
const catalog = parseCatalog(
  JSON.stringify({
    meta: { ...meta, providers: 3, models: 4 },
    providers: {
      "vendor-cn": {
        name: "Vendor CN",
        models: {
          "chat-1": {
            context: 200_000,
            output: 16_000,
            reasoning: true,
            input: ["text", "image"],
            toolCall: true,
            price: { input: 0.4, output: 1.6, cacheRead: 0.1 },
          },
          "chat-2": { context: 64_000 },
        },
      },
      deepseek: {
        name: "DeepSeek",
        models: {
          "deepseek-chat": { context: 128_000, price: { input: 0.27 } },
        },
      },
      moonshotai: {
        name: "Moonshot",
        models: { "kimi-k2": { output: 32_000 } },
      },
    },
  }),
);

function provider(models: ProviderModel[]): ProviderConfig {
  return {
    schemaVersion: 1,
    id: "vendor" as ProviderId,
    name: "Vendor",
    kind: "vendor",
    preset: "vendor",
    endpoints: { chat: "https://api.example.test/v1" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: { source: "live", list: models, expose: "all" },
    createdAt: AT,
    updatedAt: AT,
  };
}

const preset = {
  id: "vendor",
  name: "Vendor",
  kind: "vendor",
  catalog: "vendor-cn",
  verified: "2026-09-30",
  auth: { methods: ["api-key"], apiKeyHeader: "authorization-bearer" },
  endpoints: { chat: "https://api.example.test/v1" },
  models: {
    source: "live",
    list: [{ id: "chat-1", maxOutputTokens: 12_000, reasoning: false }],
  },
} as unknown as ProviderPreset;

function override(ref: string, values: ModelOverride["values"]): ModelOverride {
  return { ref, values, updatedAt: LATER };
}

void test("each field takes the first source that knows it, in the 03 section 7 order", () => {
  const config = provider([{ id: "chat-1", price: { output: 9 } }]);
  const sources: MetadataSources = {
    exact: override("vendor/chat-1", { contextWindow: 1000 }),
    wildcard: override("vendor/*", { contextWindow: 2000, toolCall: false }),
    live: {
      model: { id: "chat-1", contextWindow: 3000, inputModalities: ["text"] },
      at: AT,
    },
    preset,
    catalog,
  };
  const resolved = resolveModelMetadata(config, "chat-1", sources);
  assert.equal(resolved.ref, "vendor/chat-1");
  assert.deepEqual(resolved.fields, {
    contextWindow: { value: 1000, source: "override", at: LATER },
    toolCall: { value: false, source: "override-provider", at: LATER },
    "price.output": { value: 9, source: "provider", at: AT },
    inputModalities: { value: ["text"], source: "live", at: AT },
    maxOutputTokens: { value: 12_000, source: "preset", at: "2026-09-30" },
    reasoning: { value: false, source: "preset", at: "2026-09-30" },
    "price.input": {
      value: 0.4,
      source: "catalog",
      at: "2026-10-01T00:00:00.000Z",
    },
    "price.cacheRead": {
      value: 0.1,
      source: "catalog",
      at: "2026-10-01T00:00:00.000Z",
    },
  });
  assert.deepEqual(resolved.unknown, ["price.cacheWrite"]);
  // Without the overrides, the live list wins over the preset and the catalog.
  const { exact: _exact, wildcard: _wildcard, ...plainSources } = sources;
  const plain = resolveModelMetadata(config, "chat-1", plainSources);
  assert.deepEqual(plain.fields.contextWindow, {
    value: 3000,
    source: "live",
    at: AT,
  });
  assert.deepEqual(plain.fields.toolCall?.source, "catalog");
});

void test("a field no source knows stays unknown; no window is assumed", () => {
  const { preset: _preset, ...config } = provider([{ id: "local-model" }]);
  const resolved = resolveModelMetadata(config, "local-model", { catalog });
  assert.deepEqual(resolved.fields, {});
  assert.equal(resolved.unknown.length, 9);
  const applied = applyModelMetadata(
    config,
    { id: "local-model" },
    {
      catalog,
    },
  );
  assert.deepEqual(applied.model, { id: "local-model" });
  assert.deepEqual(applied.provenance, {
    ref: "vendor/local-model",
    fields: {},
  });
});

void test("the catalog is read by the preset's catalog id, then by the model's author", () => {
  assert.equal(catalog.lookup("vendor-cn", "chat-2")?.context, 64_000);
  // A relay names models author/model: the author's entry answers.
  assert.equal(
    catalog.lookup("relay", "deepseek/deepseek-chat")?.context,
    128_000,
  );
  assert.equal(catalog.lookup(undefined, "moonshotai/kimi-k2")?.output, 32_000);
  // No guessing: a bare model name outside the preset's provider is unknown.
  assert.equal(catalog.lookup(undefined, "deepseek-chat"), undefined);
  assert.equal(catalog.lookup("vendor-cn", "unknown/chat-1"), undefined);
  assert.equal(catalog.lookup("__proto__", "constructor"), undefined);
});

void test("derived values follow their sources while values set by hand stay", () => {
  const sources: MetadataSources = { preset, catalog };
  const first = applyModelMetadata(
    provider([{ id: "chat-1" }]),
    { id: "chat-1", wire: "chat-1-upstream" },
    sources,
  );
  assert.deepEqual(first.model, {
    id: "chat-1",
    wire: "chat-1-upstream",
    contextWindow: 200_000,
    maxOutputTokens: 12_000,
    reasoning: false,
    inputModalities: ["text", "image"],
    price: { input: 0.4, output: 1.6, cacheRead: 0.1 },
  });
  assert.equal(first.provenance.fields.contextWindow?.source, "catalog");
  assert.equal(first.provenance.fields.maxOutputTokens?.source, "preset");

  // The user edits the window and the input price on the provider's model.
  const edited = {
    ...first.model,
    contextWindow: 150_000,
    price: { ...first.model.price, input: 0.5 },
  };
  const withProvenance = { ...sources, provenance: first.provenance };
  const second = applyModelMetadata(provider([edited]), edited, withProvenance);
  assert.deepEqual(second.model, edited);
  assert.equal(second.provenance.fields.contextWindow, undefined);
  assert.equal(second.provenance.fields["price.input"], undefined);
  assert.deepEqual(
    resolveModelMetadata(provider([edited]), "chat-1", withProvenance).fields
      .contextWindow,
    { value: 150_000, source: "provider", at: AT },
  );

  // A newer catalog changes the derived values only.
  const newer = parseCatalog(
    JSON.stringify({
      meta: { ...meta, providers: 1, models: 1 },
      providers: {
        "vendor-cn": {
          name: "Vendor CN",
          models: {
            "chat-1": {
              context: 400_000,
              price: { input: 0.3, output: 1.2 },
            },
          },
        },
      },
    }),
  );
  const third = applyModelMetadata(provider([second.model]), second.model, {
    preset,
    catalog: newer,
    provenance: second.provenance,
  });
  assert.equal(third.model.contextWindow, 150_000);
  assert.deepEqual(third.model.price, { input: 0.5, output: 1.2 });
  assert.equal(third.model.inputModalities, undefined);

  // An override replaces a value set by hand; removing it brings it back.
  const exact = override("vendor/chat-1", { contextWindow: 100_000 });
  const overridden = applyModelMetadata(provider([third.model]), third.model, {
    preset,
    catalog: newer,
    provenance: third.provenance,
    exact,
  });
  assert.equal(overridden.model.contextWindow, 100_000);
  assert.deepEqual(overridden.provenance.fields.contextWindow, {
    source: "override",
    at: LATER,
    value: 100_000,
    replaced: 150_000,
  });
  const restored = applyModelMetadata(
    provider([overridden.model]),
    overridden.model,
    { preset, catalog: newer, provenance: overridden.provenance },
  );
  assert.equal(restored.model.contextWindow, 150_000);
  assert.equal(restored.provenance.fields.contextWindow, undefined);
});

void test("a fresh live list replaces the previous list's values; without one they stay", () => {
  const live = { model: { id: "chat-2", contextWindow: 32_000 }, at: AT };
  const first = applyModelMetadata(
    provider([{ id: "chat-2" }]),
    { id: "chat-2" },
    { preset, catalog, live },
  );
  assert.equal(first.model.contextWindow, 32_000);
  assert.deepEqual(first.provenance.fields.contextWindow, {
    source: "live",
    at: AT,
    value: 32_000,
  });
  // A write without a list (an override, a patch) keeps the listed value.
  const kept = applyModelMetadata(provider([first.model]), first.model, {
    preset,
    catalog,
    provenance: first.provenance,
  });
  assert.equal(kept.model.contextWindow, 32_000);
  assert.equal(kept.provenance.fields.contextWindow?.source, "live");
  // A newer list without the field leaves it to the next source.
  const refreshed = applyModelMetadata(provider([kept.model]), kept.model, {
    preset,
    catalog,
    provenance: kept.provenance,
    live: { model: { id: "chat-2" }, at: LATER },
  });
  assert.equal(refreshed.model.contextWindow, 64_000);
  assert.equal(refreshed.provenance.fields.contextWindow?.source, "catalog");
});

void test("an invalid catalog snapshot is refused", () => {
  const valid = {
    meta: { ...meta, providers: 1, models: 1 },
    providers: { a: { name: "A", models: { m: { context: 1 } } } },
  };
  const samples: unknown[] = [
    "not json",
    { ...valid, meta: { ...valid.meta, schemaVersion: 2 } },
    { ...valid, meta: { ...valid.meta, sha256: "x" } },
    { ...valid, meta: { ...valid.meta, models: 2 } },
    { ...valid, providers: { a: { name: "A" } } },
    {
      ...valid,
      providers: { a: { name: "A", models: { m: { context: 0 } } } },
    },
    {
      ...valid,
      providers: { a: { name: "A", models: { m: { window: 1 } } } },
    },
    {
      ...valid,
      providers: { a: { name: "A", models: { m: { input: ["smell"] } } } },
    },
  ];
  for (const sample of samples)
    assert.throws(
      () =>
        parseCatalog(
          typeof sample === "string" ? sample : JSON.stringify(sample),
        ),
      /model catalog snapshot is invalid/,
      JSON.stringify(sample),
    );
});

void test("the bundled snapshot loads offline and carries its origin and license", () => {
  const snapshot = modelCatalog();
  assert.equal(modelCatalog(), snapshot);
  assert.equal(snapshot.meta.source, "https://models.dev/api.json");
  assert.match(snapshot.meta.sha256, /^[0-9a-f]{64}$/);
  assert.match(snapshot.meta.commit ?? "", /^[0-9a-f]{40}$/);
  assert.ok(snapshot.meta.models > 1000, String(snapshot.meta.models));
  // The license ships next to the data.
  const directory = path.join(
    path.dirname(
      createRequire(import.meta.url).resolve("@harnesshub/gateway/catalog"),
    ),
    "..",
    "..",
    "catalog",
  );
  const license = readFileSync(
    path.join(directory, "models-dev.LICENSE"),
    "utf8",
  );
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) \d{4} models\.dev/);
  // The trimmed snapshot keeps only the fields HarnessHub reads.
  const document = JSON.parse(
    readFileSync(path.join(directory, "models-dev.json"), "utf8"),
  ) as { providers: Record<string, { models: Record<string, object> }> };
  const keys = new Set(
    Object.values(document.providers).flatMap((item) =>
      Object.values(item.models).flatMap((model) => Object.keys(model)),
    ),
  );
  assert.deepEqual([...keys].sort(), [
    "context",
    "input",
    "output",
    "price",
    "reasoning",
    "toolCall",
  ]);
});

void test("every preset's catalog id names a provider of the bundled snapshot", () => {
  const snapshot = modelCatalog();
  const document = JSON.parse(
    readFileSync(
      path.join(
        path.dirname(
          createRequire(import.meta.url).resolve("@harnesshub/gateway/catalog"),
        ),
        "..",
        "..",
        "catalog",
        "models-dev.json",
      ),
      "utf8",
    ),
  ) as { providers: Record<string, { models: Record<string, object> }> };
  // The catalog of the preset itself and of each of its regions and plans.
  for (const preset of listPresets())
    for (const [where, catalog] of [
      [preset.id, preset.catalog],
      ...(preset.regions ?? []).map(
        (region) =>
          [`${preset.id} region ${region.id}`, region.catalog] as const,
      ),
      ...(preset.plans ?? []).map(
        (plan) => [`${preset.id} plan ${plan.id}`, plan.catalog] as const,
      ),
    ] as const)
      if (catalog !== undefined) {
        const models = document.providers[catalog]?.models;
        assert.ok(models, `${where}: ${catalog}`);
        const [first] = Object.keys(models);
        assert.ok(snapshot.lookup(catalog, first!), where);
      }
});

void test("a models.dev model keeps only limits, reasoning, input modalities, tool calling and prices", () => {
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

void test("a snapshot records the upstream digest and lists one model per line, sorted", () => {
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
    source: "https://models.dev/api.json",
    retrievedAt: "2026-10-02T00:00:00.000Z",
    etag: 'W/"x"',
    commit: "0".repeat(40),
  });
  const document = JSON.parse(text) as { meta: unknown; providers: unknown };
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
  assert.ok(lines.indexOf('"a":{},') >= 0);
  assert.ok(lines.indexOf('"a":{},') < lines.indexOf('"b":{"context":10}'));
  assert.equal(parseCatalog(text).lookup("zeta", "b")?.context, 10);
  assert.throws(() =>
    snapshotText(Buffer.from("[]"), {
      source: "https://models.dev/api.json",
      retrievedAt: "2026-10-02T00:00:00.000Z",
      etag: null,
      commit: null,
    }),
  );
});
