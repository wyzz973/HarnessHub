// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { Ajv } from "ajv";
import { isProviderConfig } from "@harnesshub/core/model-plane-records";
import {
  isProviderPreset,
  providerFromPreset,
  providerPresetSchema,
} from "@harnesshub/core/provider-presets";
import {
  checkPreset,
  getPreset,
  listPresets,
} from "@harnesshub/gateway/presets";

/** The shipped preset files, read from the gateway package. */
const directory = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("@harnesshub/gateway/presets"),
  ),
  "..",
  "..",
  "presets",
);
const files = readdirSync(directory).filter((name) => name.endsWith(".json"));

void test("every shipped preset matches the JSON Schema and expands to a valid provider", () => {
  // An independent compile of the published schema, strict, as a check of the data.
  const validate = new Ajv({ allErrors: true, strict: true }).compile(
    providerPresetSchema,
  );
  assert.ok(files.length >= 15);
  for (const file of files) {
    const value: unknown = JSON.parse(
      readFileSync(path.join(directory, file), "utf8"),
    );
    assert.equal(
      validate(value),
      true,
      `${file}: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(isProviderPreset(value), true, file);
  }
  const presets = listPresets();
  assert.deepEqual(
    presets.map((preset) => `${preset.id}.json`),
    [...files].sort(),
  );
  for (const preset of presets) {
    const provider = providerFromPreset(preset, {
      now: "2026-10-02T00:00:00.000Z",
    });
    assert.ok(isProviderConfig(provider), preset.id);
    assert.equal(provider.preset, preset.id);
    assert.deepEqual(provider.credentials, []);
  }
  assert.equal(getPreset("openai")?.name, "OpenAI");
  assert.equal(getPreset("nope"), undefined);
  // Overrides replace endpoints by protocol and keep the others.
  const deepseek = getPreset("deepseek")!;
  const custom = providerFromPreset(deepseek, {
    id: "team",
    name: "Team",
    endpoints: { chat: "https://relay.example.test/v1" },
    now: "2026-10-02T00:00:00.000Z",
  });
  assert.equal(custom.id, "team");
  assert.equal(custom.name, "Team");
  assert.equal(custom.endpoints.chat, "https://relay.example.test/v1");
  assert.equal(custom.endpoints.anthropic, deepseek.endpoints.anthropic);
});

void test("invalid preset files are refused with the reason", () => {
  const valid = {
    schemaVersion: 1,
    id: "sample",
    name: "Sample",
    kind: "vendor",
    verified: "2026-10-02",
    auth: { methods: ["api-key"], apiKeyHeader: "authorization-bearer" },
    endpoints: { chat: "https://api.example.test/v1" },
    models: { source: "live" },
  };
  assert.equal(checkPreset("sample.json", JSON.stringify(valid)).id, "sample");
  const cases: Array<[unknown, RegExp]> = [
    [{ ...valid, verified: "yesterday" }, /verified/],
    [{ ...valid, verified: undefined }, /verified/],
    [{ ...valid, kind: "cloud" }, /kind/],
    [{ ...valid, unknown: true }, /additional/],
    [{ ...valid, endpoints: {} }, /endpoints/],
    [
      { ...valid, endpoints: { sse: "https://api.example.test/v1" } },
      /additional/,
    ],
    [
      { ...valid, auth: { methods: [], apiKeyHeader: "authorization-bearer" } },
      /methods/,
    ],
    [{ ...valid, website: "http://example.test" }, /website/],
    [{ ...valid, models: { source: "manual" } }, /source/],
    // Rules beyond the schema: base-URL convention and file name.
    [
      {
        ...valid,
        endpoints: { chat: "https://api.example.test/v1/chat/completions" },
      },
      /endpoints\.chat must be the base URL/,
    ],
    [
      { ...valid, endpoints: { anthropic: "https://api.example.test/v1" } },
      /endpoints\.anthropic must not end with the API version/,
    ],
    [{ ...valid, endpoints: { chat: "http://api.example.test/v1" } }, /HTTPS/],
    [{ ...valid, id: "other" }, /its id is other/],
  ];
  for (const [sample, reason] of cases)
    assert.throws(
      () => checkPreset("sample.json", JSON.stringify(sample)),
      reason,
      JSON.stringify(sample),
    );
  assert.throws(() => checkPreset("sample.json", "{"), /not JSON/);
});
